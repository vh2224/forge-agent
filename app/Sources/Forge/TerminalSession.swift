// TerminalSession — what a session IS, and who owns the live process.
//
// Split out of the old single TerminalView.swift, which held the model, the
// process ownership, the SwiftUI bridge, the screen chrome and the launcher in
// one file. The seam is process lifetime: everything here outlives any view,
// and nothing here may import a view's assumptions.
//
// The shell is started as a LOGIN shell so the user's rc runs. That matters
// here specifically: install.sh wires `eval "$(forge-accounts shell-init)"`
// into the rc, and that hook is what attaches the right Claude account to a
// bare `claude`. Skipping the login shell would silently run every session on
// the wrong account.

import SwiftUI
import AppKit
import SwiftTerm
import ForgeKit

// MARK: - Session model

@MainActor
final class TerminalSession: ObservableObject, Identifiable {
    let id = UUID()
    let cwd: String
    let title: String

    /// Command queued to run once the shell is ready. Sent as keystrokes rather
    /// than as argv so it lands in shell history and stays visible/editable.
    let bootstrap: String?

    /// Which run this session drives, when it drives one. With several
    /// milestones in the same project the project name alone cannot tell two
    /// tabs apart — the run id is the only thing that can.
    let runId: String?
    let account: String?

    /// The CLI this session actually opened with (`"claude"`, `"codex"`,
    /// `"agy"`, ...) — not the picker's default. This is what `persistSessions()`
    /// carries into the on-disk descriptor (`SessionDescriptor.engine`, T01/S06).
    let engine: String

    @Published var isRunning = true
    @Published var exitLabel: String?

    /// Images pasted or dropped into this session, newest first.
    ///
    /// The session owns them, not the view: switching tabs must not lose the
    /// thumbnails, and the terminal view is recreated by SwiftUI far more often
    /// than the session is.
    @Published private(set) var images: [SessionImage] = []

    /// Kept short on purpose. This is a "what did I just attach" strip, not a
    /// gallery — an unbounded list would push the terminal off screen after a
    /// long session of screenshots.
    private static let maxImages = 4

    func attach(_ url: URL) {
        images.removeAll { $0.url == url }
        images.insert(SessionImage(url: url), at: 0)
        if images.count > TerminalSession.maxImages { images.removeLast() }
    }

    /// Forgets the thumbnail. Deliberately does NOT delete the file: its path
    /// is already in the conversation, and Claude may read it several turns
    /// later — dismissing a preview must not break that.
    func forget(_ image: SessionImage) {
        images.removeAll { $0.id == image.id }
    }

    var projectName: String { URL(fileURLWithPath: cwd).lastPathComponent }

    /// Short, unambiguous tab label.
    var tabLabel: String {
        if let runId { return runId }
        return title
    }

    init(cwd: String, title: String, bootstrap: String? = nil,
         runId: String? = nil, account: String? = nil, engine: String = "claude") {
        self.cwd = cwd
        self.title = title
        self.bootstrap = bootstrap
        self.runId = runId
        self.account = account
        self.engine = engine
    }
}

/// One image attached to a session.
struct SessionImage: Identifiable, Equatable {
    let id = UUID()
    let url: URL
    var name: String { url.lastPathComponent }
}

// MARK: - Live terminal ownership

/// One live emulator plus the delegate that keeps reporting on it. Boxed
/// together because the delegate is referenced weakly by SwiftTerm: held only
/// by a SwiftUI coordinator it would die with the view, and the session would
/// stop learning that its shell exited.
final class TerminalInstance {
    let view: ForgeTerminalView
    let coordinator: TerminalHost.Coordinator

    init(view: ForgeTerminalView, coordinator: TerminalHost.Coordinator) {
        self.view = view
        self.coordinator = coordinator
    }
}

/// Owns every live terminal, keyed by `TerminalSession.id`, outside the
/// SwiftUI view lifecycle — and holds the one setting that belongs to the app
/// rather than to a session: the type size.
///
/// Before this existed, `makeNSView` built a terminal every time it ran — and
/// it runs again on every navigation back to the screen. That is why sessions
/// died when you left, and why coming back replayed the first message: the
/// "already bootstrapped" flag lived on a coordinator that was itself
/// recreated. The policy half is `ForgeKit.TerminalRegistry`/`TerminalLifecycle`
/// so it can be tested without AppKit; this is the thin AppKit shell.
@MainActor
final class TerminalViewStore: ObservableObject {
    static let shared = TerminalViewStore()

    private let registry = TerminalRegistry<TerminalInstance>()

    /// Scrollback, in lines. SwiftTerm's default is 500, which is a fraction of
    /// one Claude Code unit: a single execute-task can print more than that in
    /// tool output alone, and losing the top of it means losing exactly the
    /// part worth reading — what the worker decided before it acted.
    private static let scrollbackLines = 10_000

    // MARK: Zoom

    /// One size for every terminal, persisted. Per-session zoom was the other
    /// option and is worse here: tabs are the same conversation seen from
    /// different runs, and having them disagree on type size reads as a bug.
    @Published private(set) var fontSize: Double = TerminalZoom.restored(
        fromStored: UserDefaults.standard.double(forKey: TerminalZoom.defaultsKey))

    func setFontSize(_ size: Double) {
        let next = TerminalZoom.clamp(size)
        guard abs(next - fontSize) > 0.01 else { return }
        fontSize = next
        UserDefaults.standard.set(next, forKey: TerminalZoom.defaultsKey)
        // Reaches the off-screen tabs too. SwiftUI only rebuilds the visible
        // one, so relying on `updateNSView` alone would leave the others at the
        // old size until they were next looked at.
        for instance in registry.entries { instance.view.applyFontSize(next) }
    }

    func zoomIn()    { setFontSize(TerminalZoom.stepped(fontSize, by: 1)) }
    func zoomOut()   { setFontSize(TerminalZoom.stepped(fontSize, by: -1)) }
    func zoomReset() { setFontSize(TerminalZoom.standard) }

    var canZoomIn: Bool  { fontSize < TerminalZoom.maximum }
    var canZoomOut: Bool { fontSize > TerminalZoom.minimum }

    // MARK: Ownership

    /// The terminal for this session, created (and its shell started) only on
    /// the first request. Every later call — every rebuild of the view — gets
    /// the same live instance back.
    func instance(for session: TerminalSession) -> TerminalInstance {
        registry.adopt(session.id) { self.make(for: session) }.entry
    }

    /// True at most once per session id, ever. Keyed on the session rather
    /// than on a view coordinator, which is the entire point.
    func claimBootstrap(for id: UUID) -> Bool { registry.claimBootstrap(for: id) }

    /// Genuine session close: terminate the PTY and drop the entry. Nothing
    /// else in the app may call this — view teardown explicitly must not, see
    /// `TerminalLifecycle`.
    func closeSession(_ id: UUID) {
        guard TerminalLifecycle.action(for: .sessionClosed) == .terminateAndDiscard else { return }
        registry.discard(id)?.view.terminate()
    }

    private func make(for session: TerminalSession) -> TerminalInstance {
        let view = ForgeTerminalView(frame: .zero)
        let coordinator = TerminalHost.Coordinator(session: session)
        view.processDelegate = coordinator
        view.onPinchZoom = { [weak self] size in self?.setFontSize(size) }
        view.onImageAttached = { [weak session] url in session?.attach(url) }

        view.getTerminal().setCursorStyle(.blinkBlock)
        view.changeScrollback(TerminalViewStore.scrollbackLines)
        // Once per session, here and nowhere else: `installColors` rebuilds the
        // 256-entry palette and drops every cached attribute run, so it belongs
        // where a terminal is BORN, not where one is redrawn.
        view.installColors(ForgeTerminalPalette.ansi)
        TerminalHost.applyTheme(view)
        view.applyFontSize(fontSize)

        // A login shell so ~/.zshrc runs — see the note at the top of the file.
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        var env = Terminal.getEnvironmentVariables(termName: "xterm-256color")
        env.append("LANG=en_US.UTF-8")
        // Marks the session so Forge tooling (and the user) can tell where it runs.
        env.append("FORGE_APP=1")

        // `currentDirectory:` and not a swap of the process-wide cwd, which is
        // what this did before: changing the app's own working directory to
        // spawn a child reroutes every relative path in the app for as long as
        // it is changed, and a throw in between would have left it that way.
        view.startProcess(
            executable: shell,
            args: ["-l"],
            environment: env,
            execName: "-\(URL(fileURLWithPath: shell).lastPathComponent)",
            currentDirectory: session.cwd)

        return TerminalInstance(view: view, coordinator: coordinator)
    }

    /// ⌘F. SwiftTerm has a working find bar and exposes it only through the
    /// AppKit text-finder protocol, which reads the ACTION OFF THE SENDER'S
    /// TAG — so the sender has to be a real NSMenuItem carrying it. Passing
    /// `nil`, or any other object, is silently ignored rather than rejected,
    /// which is why this looks stranger than it is.
    func showFindBar(for id: UUID?) {
        guard let id, let view = registry.entry(for: id)?.view else { return }
        let item = NSMenuItem()
        item.tag = NSTextFinder.Action.showFindInterface.rawValue
        view.window?.makeFirstResponder(view)
        view.performTextFinderAction(item)
    }

    // MARK: Wires

    /// Types `text` into a session's PTY, as if the operator had typed it.
    ///
    /// Keystrokes and not argv, for the same reason `sendBootstrap` uses them:
    /// what arrives has to land in the target's own input line, visible and
    /// editable, so a wire that sends the wrong thing is something you can see
    /// and fix rather than something that already ran.
    ///
    /// The trailing newline is the caller's decision. A board wire deliberately
    /// does NOT submit by default — dropping text into another agent's prompt
    /// and pressing Return for it is how one bad forward becomes two agents
    /// working on the wrong thing.
    func sendText(_ text: String, to id: UUID, submit: Bool = false) {
        guard let view = registry.entry(for: id)?.view else { return }
        if submit {
            view.send(txt: text + "\n")
            return
        }
        // `submit: false` only omits the trailing newline. Embedded newlines —
        // a multi-line terminal selection forwarded through the composer, say —
        // would otherwise pass straight to the PTY and execute every line but
        // the last, which is exactly the accidental execution this flag exists
        // to prevent. Bracketed paste stops the PTY from treating any of it as
        // Return.
        view.send(txt: "\u{1b}[200~\(text)\u{1b}[201~")
    }

    /// What the operator has selected in a session, if anything.
    ///
    /// Selection and not a buffer scrape. Claude Code runs on the alternate
    /// screen and repaints continuously, so "the last answer" is not a region
    /// this app can identify — anything claiming to grab it would be guessing,
    /// and guessing wrong is a wire that forwards half a spinner.
    func selection(of id: UUID) -> String? {
        guard let text = registry.entry(for: id)?.view.getSelection(),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return text
    }

    /// Send the queued command once the login shell has had a beat to finish
    /// sourcing rc files — typing sooner races the prompt and the keystrokes
    /// get eaten. Sent as keystrokes rather than argv so it lands in shell
    /// history and stays visible/editable.
    func sendBootstrap(_ command: String, to view: ForgeTerminalView) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak view] in
            guard let view else { return }
            view.send(txt: command + "\n")
        }
    }
}
