// BoardLayout — where the terminals sit on the canvas, and what is wired to what.
//
// Geometry and graph only. No SwiftUI, no AppKit, no PTY: the questions this
// answers ("where does a new node go so it does not land on another one", "is
// this connection legal", "which node is under this point") are the ones worth
// pinning down without a screen, and they are the ones a canvas gets subtly
// wrong for weeks before anybody notices.
//
// WHY NONE OF THIS IS PERSISTED
// -----------------------------
// A session is a CHILD PROCESS. Quitting Forge kills every PTY with it, and
// nothing restores them on the next launch — `TerminalSession.id` is a fresh
// UUID every time. So an arrangement written to disk would be a map of a room
// whose furniture has been thrown away: every id in it dangles, and restoring it
// would place nothing, or worse, place ghosts. The board is a workspace for the
// sessions that are alive right now, and it is honest about living exactly as
// long as they do.

import Foundation

// MARK: - Pieces

public struct BoardNode: Codable, Hashable, Identifiable {
    /// The owning `TerminalSession.id`, as a string.
    public let id: String
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(id: String, x: Double, y: Double, w: Double, h: Double) {
        self.id = id; self.x = x; self.y = y; self.w = w; self.h = h
    }

    public var midY: Double { y + h / 2 }
    public var right: Double { x + w }
    public var bottom: Double { y + h }

    public func contains(x px: Double, y py: Double) -> Bool {
        px >= x && px <= right && py >= y && py <= bottom
    }
}

/// A wire. Directed, because the whole point is that output flows one way.
public struct BoardEdge: Codable, Hashable, Identifiable {
    public let from: String
    public let to: String
    public var id: String { "\(from)→\(to)" }

    public init(from: String, to: String) { self.from = from; self.to = to }
}

// MARK: - The board

public struct BoardLayout: Codable, Hashable {

    /// Defaults sized so a node shows a usable terminal: 80 columns is what
    /// Claude Code's own wrapping assumes, and a node narrower than that turns
    /// every tool call into ragged noise.
    public static let defaultSize = (w: 520.0, h: 360.0)
    public static let minSize = (w: 260.0, h: 160.0)
    public static let gap = 28.0

    public private(set) var nodes: [String: BoardNode] = [:]
    public private(set) var edges: [BoardEdge] = []

    public init() {}

    // MARK: Placement

    /// Ensures every id has a node and drops nodes (and their wires) whose
    /// session is gone.
    ///
    /// Called with the live session list rather than on open/close events: an
    /// event-driven board is one missed event away from a wire pointing at a
    /// dead PTY, and reconciling against the truth costs a dictionary walk.
    public mutating func reconcile(with ids: [String]) {
        let live = Set(ids)
        for id in nodes.keys where !live.contains(id) { nodes.removeValue(forKey: id) }
        edges.removeAll { !live.contains($0.from) || !live.contains($0.to) }
        for id in ids where nodes[id] == nil { place(id) }
    }

    /// Puts a new node in the first free slot of a coarse grid, scanning left to
    /// right then down.
    ///
    /// Not `(0,0) + random jitter`, which is what most canvases do: jitter makes
    /// two nodes *usually* not overlap, and "usually" on the one screen the
    /// operator is watching six agents on is not good enough. A slot scan is
    /// deterministic and always finds a gap, because the grid is unbounded
    /// downward.
    public mutating func place(_ id: String) {
        let stepX = BoardLayout.defaultSize.w + BoardLayout.gap
        let stepY = BoardLayout.defaultSize.h + BoardLayout.gap
        var row = 0
        while true {
            for col in 0..<3 {
                let x = Double(col) * stepX
                let y = Double(row) * stepY
                let candidate = BoardNode(id: id, x: x, y: y,
                                          w: BoardLayout.defaultSize.w,
                                          h: BoardLayout.defaultSize.h)
                if !nodes.values.contains(where: { overlaps($0, candidate) }) {
                    nodes[id] = candidate
                    return
                }
            }
            row += 1
        }
    }

    private func overlaps(_ a: BoardNode, _ b: BoardNode) -> Bool {
        a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom
    }

    public mutating func move(_ id: String, dx: Double, dy: Double) {
        guard var n = nodes[id] else { return }
        n.x += dx; n.y += dy
        nodes[id] = n
    }

    public mutating func resize(_ id: String, dw: Double, dh: Double) {
        guard var n = nodes[id] else { return }
        n.w = max(BoardLayout.minSize.w, n.w + dw)
        n.h = max(BoardLayout.minSize.h, n.h + dh)
        nodes[id] = n
    }

    /// Brings a node to the front by rewriting nothing: draw order is decided by
    /// `orderedNodes`, which puts `focused` last. Z-order held as a stored field
    /// would be a second source of truth next to focus, and the two would
    /// disagree the first time focus changed from the keyboard.
    public func orderedNodes(focused: String?) -> [BoardNode] {
        let all = nodes.values.sorted { $0.id < $1.id }
        guard let focused else { return all }
        return all.filter { $0.id != focused } + all.filter { $0.id == focused }
    }

    // MARK: Wiring

    /// Connects two nodes. Returns false when the connection is not legal.
    ///
    /// Self-loops are rejected (a terminal typing into itself is an echo bomb,
    /// not a workflow) and so are duplicates. CYCLES ARE ALLOWED: A→B→A is a
    /// reviewer and an author passing work back and forth, which is a real
    /// pattern here and the whole reason the dialectic review exists. A graph
    /// library would forbid it; this domain wants it.
    @discardableResult
    public mutating func connect(from: String, to: String) -> Bool {
        guard from != to else { return false }
        guard nodes[from] != nil, nodes[to] != nil else { return false }
        guard !edges.contains(where: { $0.from == from && $0.to == to }) else { return false }
        edges.append(BoardEdge(from: from, to: to))
        return true
    }

    public mutating func disconnect(_ edge: BoardEdge) {
        edges.removeAll { $0 == edge }
    }

    /// Everything `id` feeds.
    public func targets(of id: String) -> [String] {
        edges.filter { $0.from == id }.map(\.to)
    }

    /// Everything that feeds `id`.
    public func sources(of id: String) -> [String] {
        edges.filter { $0.to == id }.map(\.from)
    }

    // MARK: Hit testing

    /// The topmost node under a canvas point, matching `orderedNodes` draw order
    /// so the node you see on top is the node you hit.
    public func node(at x: Double, y: Double, focused: String? = nil) -> BoardNode? {
        orderedNodes(focused: focused).last { $0.contains(x: x, y: y) }
    }

    /// The rectangle that contains everything, plus a margin. Used by "fit to
    /// content" — the escape hatch for a canvas someone has panned into the void.
    public func contentBounds(margin: Double = 60) -> (x: Double, y: Double, w: Double, h: Double)? {
        guard !nodes.isEmpty else { return nil }
        let minX = nodes.values.map(\.x).min()!
        let minY = nodes.values.map(\.y).min()!
        let maxX = nodes.values.map(\.right).max()!
        let maxY = nodes.values.map(\.bottom).max()!
        return (minX - margin, minY - margin,
                (maxX - minX) + margin * 2, (maxY - minY) + margin * 2)
    }
}
