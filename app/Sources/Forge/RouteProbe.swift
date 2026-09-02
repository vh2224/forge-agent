// RouteProbe — which engine actually ran the last unit, per project.
//
// The app had no idea. `Run` carries the worker string and the milestone dir
// but not the route, so every session header said "a terminal is open here"
// and nothing about the thing the operator configured most deliberately: which
// engine holds the pen. Meanwhile `.gsd/forge/events.jsonl` has recorded
// `{engine, model, tier, unit}` on every dispatch since the routing contract
// landed, and only the Métricas screen ever read it — as a 30-day aggregate,
// which is the one shape that cannot answer "what is running right now".
//
// So this reads the same file the aggregate does, keeps the LAST dispatch per
// project, and nothing else. `CLAUDE.md` is explicit that the log is the proof
// and the narration is not; a header that reported the engine from anywhere
// but this file would be narration.

import Foundation
import ForgeKit

/// The tail of a project's event log, cached and refreshed on demand.
@MainActor
final class RouteStore: ObservableObject {
    static let shared = RouteStore()

    @Published private(set) var latest: [String: DispatchEvent] = [:]

    private var reading: Set<String> = []
    private var lastRead: [String: Date] = [:]

    /// Re-reading is throttled rather than watched. A dispatch happens once per
    /// UNIT — minutes apart, not milliseconds — so a file watcher here would be
    /// machinery bought to observe something that barely moves.
    private static let minInterval: TimeInterval = 4

    /// Only the tail is read. The log is append-only and grows without bound
    /// (231 KB in this repo after four milestones); the last dispatch is always
    /// within a few KB of the end, and `MetricsEngine.parse` already skips any
    /// line it cannot decode — which is exactly what the partial first line of
    /// a tail read looks like.
    private static let tailBytes = 64 * 1024

    func refresh(cwd: String?) {
        guard let cwd, !reading.contains(cwd) else { return }
        if let last = lastRead[cwd], Date().timeIntervalSince(last) < Self.minInterval { return }
        reading.insert(cwd)
        lastRead[cwd] = Date()

        Task.detached(priority: .utility) {
            let event = RouteStore.readTail(cwd: cwd)
            await MainActor.run {
                self.reading.remove(cwd)
                guard let event else { return }
                self.latest[cwd] = event
            }
        }
    }

    func route(for cwd: String?) -> DispatchEvent? {
        guard let cwd else { return nil }
        return latest[cwd]
    }

    private nonisolated static func readTail(cwd: String) -> DispatchEvent? {
        let path = "\(cwd)/.gsd/forge/events.jsonl"
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }

        guard let end = try? handle.seekToEnd() else { return nil }
        let start = end > UInt64(tailBytes) ? end - UInt64(tailBytes) : 0
        try? handle.seek(toOffset: start)
        guard let data = try? handle.readToEnd(),
              let text = String(data: data, encoding: .utf8)
        else { return nil }

        return MetricsEngine.parse(text).dispatches.last
    }
}

extension DispatchEvent {
    var forgeEngine: ForgeEngine { ForgeEngine(engine) }
    var forgePhase: ForgePhase { ForgePhase(unit: unit) }
}
