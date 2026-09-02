// BoardView — the terminals as a board you arrange and wire.
//
// WHAT A WIRE ACTUALLY DOES, AND WHAT IT DOES NOT
// ----------------------------------------------
// A wire moves text from one live PTY into another's input line. That is the
// whole mechanism, and it is a real one: `TerminalViewStore.selection(of:)`
// reads what the operator has highlighted in the source, `sendText(_:to:)`
// types it into the target. No API glue, no middleware — the same path a human
// paste takes.
//
// What it does NOT do, deliberately, is forward automatically. "Watch the agent
// until it finishes, then send its answer onward" needs an answer to *when is it
// finished*, and a PTY running Claude Code cannot give one: it lives on the
// alternate screen and repaints continuously, so there is no last line, no
// stable prompt to match, and no region of the buffer that is "the reply".
// Anything auto-forwarding today would be scraping a spinner and passing it on
// with confidence. Forge does have a real completion signal — the
// `---GSD-WORKER-RESULT---` block and `events.jsonl` — but those exist for
// dispatched UNITS, not for an interactive chat, so wiring them to a chat node
// would be a lie in the other direction. Manual, visible, and correct beats
// automatic and wrong; the auto path is named in the summary as open work.
//
// AND NOTHING IS SUBMITTED FOR YOU. Text lands in the target's prompt and stops
// there. Pressing Return on someone else's behalf is how one bad forward turns
// into two agents confidently working on the wrong thing.

import SwiftUI
import AppKit
import ForgeKit

// MARK: - Store

@MainActor
final class BoardStore: ObservableObject {
    static let shared = BoardStore()

    @Published var layout = BoardLayout()

    /// Canvas transform — the ONE copy of it.
    ///
    /// `pan` is in SCREEN points and `scale` multiplies canvas coordinates, so a
    /// drag translation must be divided by `scale` before it becomes a move,
    /// which is the one conversion every canvas gets wrong once. All of that
    /// arithmetic — accumulation, the clamp, `fit`, the screen→canvas undo —
    /// lives in `BoardViewport` (ForgeKit, tested without a window). This store
    /// keeps the STATE and delegates every rule; `pan`/`scale` below stay as
    /// computed properties purely so every existing reader keeps its API.
    @Published var viewport = BoardViewport()

    /// The viewport size at the last sync. The clamp needs it outside `fit(in:)`
    /// — a scroll or a drag has no `GeometryReader` in hand.
    var viewportSize: CGSize = .zero

    /// A wire being drawn: where it started and where the cursor is, in canvas
    /// coordinates.
    @Published var wireFrom: String?
    @Published var wireTip: CGPoint = .zero

    /// The wire whose panel is open.
    @Published var selectedEdge: BoardEdge?

    /// The viewport size as `BoardViewport` wants it. Zero until the first
    /// sync, which is harmless: nothing pans before `onAppear`.
    private var vp: (w: Double, h: Double) { (viewportSize.width, viewportSize.height) }

    /// Screen-space pan. The setter is absolute (a drag's origin + translation)
    /// and clamps through the same rule the scroll uses — one clamp, two
    /// gestures, no chance of them drifting apart.
    var pan: CGSize {
        get { CGSize(width: viewport.panX, height: viewport.panY) }
        set { viewport.setPan(newValue.width, newValue.height,
                              content: layout.contentBounds(), in: vp) }
    }

    /// Canvas scale. The setter clamps, so callers pass raw magnification.
    var scale: Double {
        get { viewport.scale }
        set { viewport.scale(to: newValue) }
    }

    func zoom(by factor: Double) { viewport.zoom(by: factor) }

    func reset() { viewport.reset() }

    /// Frames everything, so a canvas panned into the void has a way home.
    func fit(in size: CGSize) {
        viewportSize = size
        viewport.fit(content: layout.contentBounds(), in: (size.width, size.height))
    }

    /// A trackpad/wheel scroll, in raw event deltas. Relative accumulation, then
    /// the same clamp as the drag — see `BoardViewport`.
    func scroll(dx: Double, dy: Double, precise: Bool) {
        let d = BoardViewport.scrollDelta(dx: dx, dy: dy, precise: precise)
        viewport.pan(by: d.x, d.y, content: layout.contentBounds(), in: vp)
    }
}

// MARK: - The canvas

struct BoardView: View {
    @ObservedObject var state: AppState
    @ObservedObject private var board: BoardStore = .shared
    @ObservedObject private var routes: RouteStore = .shared
    let focused: UUID?

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                grid
                canvas
                edgePanel
            }
            .clipped()
            .onAppear { sync(viewport: geo.size) }
            .onChange(of: state.sessions.count) { _ in sync(viewport: geo.size) }
            // Phase is already live via `liveRuns`; the route badge is not —
            // it only ever refreshes on session-count change, so a dispatch
            // inside an already-open session left it stale until the board
            // was closed and reopened.
            .onChange(of: state.runs) { _ in
                for cwd in Set(state.sessions.map(\.cwd)) { routes.refresh(cwd: cwd) }
            }
            // The clamp lives outside any `GeometryReader` closure, so the size
            // has to be pushed to the store when the window resizes — otherwise
            // a scroll after a resize is bounded against the old frame.
            .onChange(of: geo.size) { board.viewportSize = $0 }
            .overlay(alignment: .bottomTrailing) { controls(viewport: geo.size) }
        }
    }

    private func sync(viewport: CGSize) {
        board.layout.reconcile(with: state.sessions.map { $0.id.uuidString })
        for cwd in Set(state.sessions.map(\.cwd)) { routes.refresh(cwd: cwd) }
        board.viewportSize = viewport
        // `isIdentity` rather than comparing pan and scale by hand: the same
        // question, asked where the transform is defined.
        if board.viewport.isIdentity { board.fit(in: viewport) }
    }

    // MARK: Background

    /// A dot grid, drawn in screen space and offset by the pan.
    ///
    /// It is not decoration: without a textured ground, dragging a node on an
    /// empty dark rectangle gives no sense of movement at all — the node appears
    /// to stay still while the world does nothing. The dots are what make the
    /// canvas read as a place.
    private var grid: some View {
        Canvas { ctx, size in
            let step = 26.0 * board.scale
            guard step > 6 else { return }
            let ox = board.pan.width.truncatingRemainder(dividingBy: step)
            let oy = board.pan.height.truncatingRemainder(dividingBy: step)
            let dot = Color.forgeEdge.opacity(0.16)
            var y = oy - step
            while y < size.height + step {
                var x = ox - step
                while x < size.width + step {
                    ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.4, height: 1.4)),
                             with: .color(dot))
                    x += step
                }
                y += step
            }
        }
        .background(Color.forgeGround)
        // Two-finger scroll. The catcher is `hitTest → nil`, so it takes
        // nothing away from the gestures below — see BoardScroll.swift.
        .background(
            BoardScrollCatcher { dx, dy, precise, p in
                let c = board.viewport.canvasPoint(fromScreen: p.x, p.y)
                // Over a node the event is left alone: that terminal's own
                // buffer is what the operator means to scroll.
                if board.layout.node(at: c.x, y: c.y, focused: focused?.uuidString) != nil {
                    return false
                }
                board.scroll(dx: dx, dy: dy, precise: precise)
                return true
            }
        )
        .contentShape(Rectangle())
        // Pan. On the background only: a drag that panned from anywhere would
        // make it impossible to select text inside a terminal.
        .gesture(
            DragGesture()
                .onChanged { g in
                    // The origin is captured on the FIRST change, not carried
                    // over from the last `onEnded`. Carrying it over is the bug
                    // this replaced: `fit` and the zoom buttons move `pan` and
                    // `scale` without any gesture running, so a stale origin
                    // made the first drag after either of them discard the
                    // framing and snap the canvas to the raw translation.
                    let origin = panOrigin ?? board.pan
                    if panOrigin == nil { panOrigin = origin }
                    board.pan = CGSize(width: origin.width + g.translation.width,
                                       height: origin.height + g.translation.height)
                }
                .onEnded { _ in panOrigin = nil }
        )
        .simultaneousGesture(
            MagnifyGesture()
                .onChanged { g in
                    let origin = magnifyOrigin ?? board.scale
                    if magnifyOrigin == nil { magnifyOrigin = origin }
                    // No clamp spelled out here: `board.scale`'s setter is the
                    // clamp, and it is the same one `zoom(by:)` and `fit` use.
                    board.scale = origin * g.magnification
                }
                .onEnded { _ in magnifyOrigin = nil }
        )
        .onTapGesture { board.selectedEdge = nil }
    }

    /// Nil while no gesture is in flight. Optional rather than "last value"
    /// precisely so a transform changed outside a gesture is picked up.
    @State private var panOrigin: CGSize?
    @State private var magnifyOrigin: Double?

    // MARK: Content

    private var canvas: some View {
        ZStack(alignment: .topLeading) {
            wires
            nodes
        }
        .scaleEffect(board.scale, anchor: .topLeading)
        .offset(board.pan)
        .allowsHitTesting(true)
    }

    private var wires: some View {
        ZStack(alignment: .topLeading) {
            ForEach(board.layout.edges) { edge in
                if let a = board.layout.nodes[edge.from], let b = board.layout.nodes[edge.to] {
                    WireShape(from: CGPoint(x: a.right, y: a.midY),
                              to: CGPoint(x: b.x, y: b.midY))
                        .stroke(Color.tone(.ember).opacity(board.selectedEdge == edge ? 0.95 : 0.5),
                                style: StrokeStyle(lineWidth: board.selectedEdge == edge ? 2.5 : 1.6,
                                                   lineCap: .round))
                        // A fat transparent copy underneath: a 1.6pt curve is
                        // essentially unclickable, and "the wire I cannot select"
                        // is the bug every node editor ships first.
                        .background(
                            WireShape(from: CGPoint(x: a.right, y: a.midY),
                                      to: CGPoint(x: b.x, y: b.midY))
                                .stroke(Color.white.opacity(0.001), lineWidth: 14)
                                .onTapGesture { board.selectedEdge = edge }
                        )
                    ArrowHead(at: CGPoint(x: b.x, y: b.midY))
                        .fill(Color.tone(.ember).opacity(0.75))
                }
            }
            // The wire being drawn right now.
            if let from = board.wireFrom, let a = board.layout.nodes[from] {
                WireShape(from: CGPoint(x: a.right, y: a.midY), to: board.wireTip)
                    .stroke(Color.tone(.ember).opacity(0.8),
                            style: StrokeStyle(lineWidth: 2, dash: [5, 4]))
            }
        }
    }

    private var nodes: some View {
        ForEach(board.layout.orderedNodes(focused: focused?.uuidString), id: \.id) { node in
            if let session = state.sessions.first(where: { $0.id.uuidString == node.id }) {
                BoardNodeView(
                    session: session,
                    node: node,
                    phase: phase(for: session),
                    engine: routes.route(for: session.cwd)?.forgeEngine,
                    isFocused: session.id == focused,
                    scale: board.scale,
                    state: state)
            }
        }
    }

    private func phase(for session: TerminalSession) -> ForgePhase {
        let run = state.liveRuns.first(where: { $0.id == session.runId })
            ?? (session.runId == nil ? state.liveRuns.first(where: { $0.cwd == session.cwd }) : nil)
        if let unit = run?.workerParts?.unit { return ForgePhase(unit: unit) }
        return routes.route(for: session.cwd)?.forgePhase ?? .unknown
    }

    // MARK: Wire panel

    @ViewBuilder private var edgePanel: some View {
        if let edge = board.selectedEdge,
           let src = state.sessions.first(where: { $0.id.uuidString == edge.from }),
           let dst = state.sessions.first(where: { $0.id.uuidString == edge.to }) {
            WirePanel(edge: edge, source: src, target: dst) { board.selectedEdge = nil }
                .padding(16)
        }
    }

    // MARK: Controls

    private func controls(viewport: CGSize) -> some View {
        HStack(spacing: 6) {
            Button { board.zoom(by: 0.85) } label: {
                Image(systemName: "minus.magnifyingglass")
            }
            Text("\(Int(board.scale * 100))%")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 40)
            Button { board.zoom(by: 1.18) } label: {
                Image(systemName: "plus.magnifyingglass")
            }
            Divider().frame(height: 14)
            Button { board.fit(in: viewport) } label: {
                Image(systemName: "arrow.up.left.and.down.right.magnifyingglass")
            }
            .help("Enquadrar tudo")
        }
        .buttonStyle(.plain)
        .font(.system(size: 11))
        .padding(.horizontal, 10).padding(.vertical, 7)
        .forgeSurface(.floating)
        .padding(12)
    }
}

// MARK: - A node

private struct BoardNodeView: View {
    @ObservedObject var session: TerminalSession
    let node: BoardNode
    let phase: ForgePhase
    let engine: ForgeEngine?
    let isFocused: Bool
    let scale: Double
    @ObservedObject var state: AppState
    @ObservedObject private var board: BoardStore = .shared

    @State private var dragAccum: CGSize = .zero
    @State private var resizeAccum: CGSize = .zero
    @State private var hovering = false

    /// The out-port's `DragGesture` reports locations in the untransformed
    /// `"boardCanvas"` space, but everything it feeds — `board.wireTip`,
    /// `board.layout.node(at:)` — lives in layout coordinates, which the
    /// canvas reaches by `.scaleEffect(anchor: .topLeading)` then `.offset`.
    /// Undo both before using a drag point for anything layout-shaped.
    ///
    /// The arithmetic itself lives in `BoardViewport.canvasPoint(fromScreen:)`
    /// (ForgeKit) so the scroll catcher and this drag cannot end up with two
    /// subtly different versions of the same undo.
    private func canvasPoint(from location: CGPoint) -> CGPoint {
        let p = board.viewport.canvasPoint(fromScreen: location.x, location.y)
        return CGPoint(x: p.x, y: p.y)
    }

    var body: some View {
        SessionPane(
            session: session,
            phase: phase,
            engine: engine,
            isFocused: isFocused,
            onFocus: { state.focusedSession = session.id },
            onClose: { state.closeSession(session, confirm: true) },
            onHeaderDrag: { t in
                // Screen translation → canvas delta. Without the divide, a node
                // outruns the cursor at zoom > 1 and lags it at zoom < 1.
                let dx = (t.width - dragAccum.width) / scale
                let dy = (t.height - dragAccum.height) / scale
                dragAccum = t
                board.layout.move(node.id, dx: dx, dy: dy)
            },
            onHeaderDragEnded: { dragAccum = .zero })
        .frame(width: node.w, height: node.h)
        .overlay(alignment: .trailing) { outPort }
        .overlay(alignment: .leading) { inPort }
        .overlay(alignment: .bottomTrailing) { resizeGrip }
        .offset(x: node.x, y: node.y)
        .onHover { hovering = $0 }
    }

    /// The output port. Shown on hover only: six nodes each wearing two visible
    /// sockets is a diagram of an app, not an app.
    private var outPort: some View {
        Circle()
            .fill(board.wireFrom == node.id ? Color.tone(.ember) : Color.forgeEdge)
            .frame(width: 11, height: 11)
            .overlay(Circle().strokeBorder(Color.forgeGround, lineWidth: 2))
            .offset(x: 6)
            .opacity(hovering || board.wireFrom == node.id ? 1 : 0)
            .help("Arraste para conectar a outro terminal")
            .gesture(
                DragGesture(coordinateSpace: .named("boardCanvas"))
                    .onChanged { g in
                        board.wireFrom = node.id
                        board.wireTip = canvasPoint(from: g.location)
                    }
                    .onEnded { g in
                        defer { board.wireFrom = nil }
                        let p = canvasPoint(from: g.location)
                        guard let hit = board.layout.node(at: p.x, y: p.y),
                              hit.id != node.id else { return }
                        board.layout.connect(from: node.id, to: hit.id)
                    }
            )
    }

    private var inPort: some View {
        Circle()
            .fill(Color.forgeEdge.opacity(0.7))
            .frame(width: 9, height: 9)
            .overlay(Circle().strokeBorder(Color.forgeGround, lineWidth: 2))
            .offset(x: -5)
            .opacity(hovering && board.wireFrom != nil ? 1 : 0)
            .allowsHitTesting(false)
    }

    private var resizeGrip: some View {
        Image(systemName: "arrow.down.right")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(Color.forgeEdge)
            .frame(width: 16, height: 16)
            .contentShape(Rectangle())
            .opacity(hovering ? 0.9 : 0)
            .gesture(
                DragGesture()
                    .onChanged { g in
                        let dw = (g.translation.width - resizeAccum.width) / scale
                        let dh = (g.translation.height - resizeAccum.height) / scale
                        resizeAccum = g.translation
                        board.layout.resize(node.id, dw: dw, dh: dh)
                    }
                    .onEnded { _ in resizeAccum = .zero }
            )
    }
}

// MARK: - The wire's panel

private struct WirePanel: View {
    let edge: BoardEdge
    @ObservedObject var source: TerminalSession
    @ObservedObject var target: TerminalSession
    let onClose: () -> Void

    @State private var message = ""
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Text(source.tabLabel).font(.caption).bold()
                Image(systemName: "arrow.right").font(.system(size: 9))
                    .foregroundStyle(Color.tone(.ember))
                Text(target.tabLabel).font(.caption).bold()
                Spacer(minLength: 12)
                Button { BoardStore.shared.layout.disconnect(edge); onClose() } label: {
                    Image(systemName: "scissors").font(.system(size: 10))
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .help("Cortar o fio")
                Button { onClose() } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
            }

            TextField("mensagem para \(target.tabLabel)", text: $message, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .lineLimit(1...4)
                .padding(7)
                .background(Color.forgeGround.opacity(0.6),
                            in: RoundedRectangle(cornerRadius: 7))

            HStack(spacing: 8) {
                Button("Enviar seleção") { sendSelection() }
                    .controlSize(.small)
                    .help("Manda o que está selecionado em \(source.tabLabel)")
                Button("Enviar texto") { send(message) }
                    .controlSize(.small)
                    .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Spacer()
            }

            // Nothing is submitted for the operator — said out loud, because a
            // wire that looked like it "sent" and did not press Return would
            // otherwise read as broken.
            Text(note ?? "O texto chega no prompt do destino. Você aperta Enter lá.")
                .font(.system(size: 10))
                .foregroundStyle(note == nil
                                 ? AnyShapeStyle(.tertiary)
                                 : AnyShapeStyle(Color.tone(.ember)))
        }
        .frame(width: 320)
        .padding(12)
        .forgeSurface(.floating)
    }

    private func sendSelection() {
        guard let text = TerminalViewStore.shared.selection(of: source.id) else {
            note = "Nada selecionado em \(source.tabLabel)."
            return
        }
        send(text)
    }

    private func send(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        TerminalViewStore.shared.sendText(t, to: target.id)
        note = "Enviado — \(t.count) caracteres no prompt de \(target.tabLabel)."
        message = ""
    }
}

// MARK: - Shapes

/// A cubic curve that leaves the source horizontally and arrives horizontally.
///
/// The control offset grows with the gap so short wires stay tight and long ones
/// bow: a fixed offset makes near neighbours loop absurdly and distant ones look
/// like straight lines with a kink.
private struct WireShape: Shape {
    let from: CGPoint
    let to: CGPoint

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let dx = max(60, abs(to.x - from.x) * 0.45)
        p.move(to: from)
        p.addCurve(to: to,
                   control1: CGPoint(x: from.x + dx, y: from.y),
                   control2: CGPoint(x: to.x - dx, y: to.y))
        return p
    }
}

private struct ArrowHead: Shape {
    let at: CGPoint

    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: at.x, y: at.y))
        p.addLine(to: CGPoint(x: at.x - 9, y: at.y - 5))
        p.addLine(to: CGPoint(x: at.x - 9, y: at.y + 5))
        p.closeSubpath()
        return p
    }
}
