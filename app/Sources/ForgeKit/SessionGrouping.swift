// SessionGrouping — turning the flat list of live terminal sessions into
// something the sidebar can nest under a project, the same way ProjectGrouping
// turns a flat list of registered paths into folders.
//
// A session's identity for this purpose is its `cwd`: two sessions running in
// the same directory belong together, and the sidebar shows one group with
// two rows rather than two groups that happen to share a name. Ordering is
// deterministic for the same reason ProjectTree's is — the sidebar re-renders
// on every AppState change, and a view that reshuffles rows on an unrelated
// update reads as broken even when nothing is actually wrong.

import Foundation

/// A live terminal session, reduced to the fields the sidebar's grouping and
/// ordering logic actually needs.
///
/// This is a view DTO, not the `Codable` descriptor S06 persists under
/// `~/.claude/` — that type additionally carries `engine` and is written to
/// disk; this one is neither. Conflating the two would make S04's grouping
/// logic depend on a persistence shape it has no reason to know about.
public struct SessionSnapshot: Identifiable, Hashable, Sendable {
    public let id: String
    public let cwd: String
    public let title: String
    public let runId: String?
    public let account: String?

    public init(id: String, cwd: String, title: String, runId: String? = nil, account: String? = nil) {
        self.id = id
        self.cwd = cwd
        self.title = title
        self.runId = runId
        self.account = account
    }

    /// Display name of the owning project, e.g. `"forge-app"` for
    /// `/Users/x/Development/forge-app`.
    public var projectName: String { ProjectOrganiser.name(cwd) }
}

/// Every live session sharing one `cwd`, with the display title the sidebar
/// header uses.
public struct SessionGroup: Identifiable, Hashable, Sendable {
    /// Absolute `cwd` — also the group's identity, since two sessions only
    /// ever merge into one group when their `cwd` is exactly equal.
    public let path: String
    /// Home-relative display form (`ProjectOrganiser.abbreviate`), never
    /// hand-rolled here.
    public let title: String
    public let sessions: [SessionSnapshot]

    public var id: String { path }

    /// How many sessions in this group carry a `runId`. Sessions without one
    /// are still real work — a session is not required to be driving a run —
    /// so this counts, it never filters.
    public var runCount: Int { sessions.filter { $0.runId != nil }.count }

    public init(path: String, title: String, sessions: [SessionSnapshot]) {
        self.path = path
        self.title = title
        self.sessions = sessions
    }
}

public enum SessionOrganiser {

    /// Group sessions by exact `cwd` and order both the groups and the
    /// sessions within each deterministically.
    ///
    /// Bucketing is exact-path equality, not prefix matching — a session in
    /// `/repo/sub` never joins the group for `/repo`. Ownership by prefix is
    /// `WorkTree`'s job (T02); mixing the two here would mean two different
    /// pieces of code deciding the same kind of question with different
    /// rules.
    ///
    /// `home` is a required parameter on this variant so the result never
    /// depends on the real `$HOME` of the machine running the test — the same
    /// discipline `ProjectTree` documents at its own top. A convenience
    /// default, if one is ever added, belongs only on the public call site
    /// that isn't under test.
    public static func groups(_ sessions: [SessionSnapshot], home: String) -> [SessionGroup] {
        var buckets: [String: [SessionSnapshot]] = [:]
        for session in sessions {
            buckets[session.cwd, default: []].append(session)
        }
        return buckets
            .map { path, sessionsInGroup in
                SessionGroup(
                    path: path,
                    title: ProjectOrganiser.abbreviate(path, home: home),
                    sessions: ordered(sessionsInGroup)
                )
            }
            // Groups sort by project name with `path` as the tiebreaker —
            // the same discipline as `ProjectTree.sorted`: the output is a
            // function of the set, never of arrival order.
            .sorted { lhs, rhs in
                let lhsName = ProjectOrganiser.name(lhs.path)
                let rhsName = ProjectOrganiser.name(rhs.path)
                return lhsName != rhsName ? lhsName < rhsName : lhs.path < rhs.path
            }
    }

    /// Order sessions so the result is a function of the set, never of the
    /// order they arrived in: sessions with a `runId` sort first (a session
    /// driving a run is more likely to be what the operator is looking for),
    /// ties broken by `runId`, then `title`, then `id` — total and
    /// deterministic, so no pair is ever left to dictionary or array order.
    public static func ordered(_ sessions: [SessionSnapshot]) -> [SessionSnapshot] {
        sessions.sorted { lhs, rhs in
            let lhsHasRun = lhs.runId != nil
            let rhsHasRun = rhs.runId != nil
            if lhsHasRun != rhsHasRun { return lhsHasRun }
            if lhsHasRun, rhsHasRun, lhs.runId != rhs.runId {
                return (lhs.runId ?? "") < (rhs.runId ?? "")
            }
            if lhs.title != rhs.title { return lhs.title < rhs.title }
            return lhs.id < rhs.id
        }
    }
}
