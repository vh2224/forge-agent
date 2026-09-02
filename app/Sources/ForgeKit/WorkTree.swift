// WorkTree — the work sidebar draws: registered projects with every run
// hanging under whichever project owns its `cwd`.
//
// This is composition, not a new tree. `ProjectTree.build` already derives
// the project hierarchy (nearest-project-wins ownership, `folder` nodes
// synthesised only between a node and a project descendant); `WorkTree` maps
// that same shape into `WorkNode`, adding runs at the node whose `path`
// exactly matches — or, when no project's `cwd` matches exactly, at the
// nearest containing project via `ProjectOrganiser.container(of:in:)`. A
// second tree living beside `ProjectTree` would be the fourth copy of one
// rule (`ProjectTree.swift`'s own words) — this file adds none.
//
// A run whose `cwd` matches no project — not even the nearest containing
// one — is not dropped. It comes back in `WorkForest.unowned`, named. Silent
// loss is indistinguishable from a broken detector.
//
// Purity is deliberate, same discipline as `ProjectTree.swift`: `home`,
// `projects` and `roots` are parameters, nothing here touches the
// filesystem.

import Foundation

/// One node of the derived work tree: a registered project (or synthesised
/// `folder`) together with the runs it directly owns.
public struct WorkNode: Identifiable, Hashable, Sendable {
    /// Absolute path. Also the identity, mirroring `ProjectTreeNode`.
    public let path: String
    public let title: String
    public let role: ProjectRole
    /// Runs whose owner is EXACTLY this node — never a folder, which owns
    /// nothing (it is a synthesised display node, not a project).
    public let runs: [Run]
    public let children: [WorkNode]
    /// Runs below, transitively — the node's own `runs` are not counted
    /// twice, same shape as `ProjectTreeNode.projectCount`.
    public let runCount: Int

    public var id: String { path }

    public init(path: String,
                title: String,
                role: ProjectRole,
                runs: [Run],
                children: [WorkNode],
                runCount: Int) {
        self.path = path
        self.title = title
        self.role = role
        self.runs = runs
        self.children = children
        self.runCount = runCount
    }
}

/// The forest `WorkTree.build` returns: the project hierarchy with runs
/// attached, plus every run that named no owner.
public struct WorkForest: Sendable {
    public let roots: [WorkNode]
    /// Runs whose `cwd` matched no registered project. Named, never dropped.
    public let unowned: [Run]

    public init(roots: [WorkNode], unowned: [Run]) {
        self.roots = roots
        self.unowned = unowned
    }
}

public enum WorkTree {

    /// Build the work forest.
    ///
    /// - Parameters:
    ///   - projects: absolute paths already classified as projects.
    ///   - runs: the runs to place. Order is irrelevant to the result.
    ///   - roots: declared scan roots, forwarded to `ProjectTree.build`
    ///     unchanged.
    ///   - home: for display abbreviation, forwarded unchanged. Never read
    ///     from the environment.
    public static func build(projects: [String],
                             runs: [Run],
                             roots: [String] = [],
                             home: String) -> WorkForest {
        let tree = ProjectTree.build(projects: projects, roots: roots, home: home)

        var runsByOwner: [String: [Run]] = [:]
        var unowned: [Run] = []
        for run in runs {
            if let owner = owner(of: run.cwd, in: projects) {
                runsByOwner[owner, default: []].append(run)
            } else {
                unowned.append(run)
            }
        }

        let roots = tree.map { mapNode($0, runsByOwner: runsByOwner) }
        return WorkForest(roots: roots, unowned: ordered(unowned))
    }

    // MARK: - Ownership

    /// The project that owns `cwd`: itself if `cwd` matches a registered
    /// project exactly, otherwise the nearest containing project
    /// (`ProjectOrganiser.container` already excludes an exact match, since
    /// it filters `$0 != path` — the equality case has to be checked here).
    /// `nil` when no project qualifies.
    private static func owner(of cwd: String, in projects: [String]) -> String? {
        if projects.contains(cwd) { return cwd }
        return ProjectOrganiser.container(of: cwd, in: projects)
    }

    // MARK: - Mapping

    private static func mapNode(_ node: ProjectTreeNode,
                                runsByOwner: [String: [Run]]) -> WorkNode {
        let children = node.children.map { mapNode($0, runsByOwner: runsByOwner) }
        // A synthesised `folder` is not a project and cannot own a run: the
        // run of a `cwd` under a folder with no project below it is `unowned`,
        // never silently attached to the folder standing in the way.
        let mine = node.role == .folder ? [] : ordered(runsByOwner[node.path] ?? [])
        let count = children.reduce(0) { $0 + $1.runs.count + $1.runCount }
        return WorkNode(path: node.path,
                        title: node.title,
                        role: node.role,
                        runs: mine,
                        children: children,
                        runCount: count)
    }

    // MARK: - Ordering

    /// `active` first, then most recent `started_at`, then `id` as a total
    /// tiebreak — deterministic, a function of the set, never of arrival
    /// order. Shared by every node's `runs` and by `unowned`.
    private static func ordered(_ runs: [Run]) -> [Run] {
        runs.sorted { a, b in
            if a.active != b.active { return a.active }
            if a.started_at != b.started_at { return a.started_at > b.started_at }
            return a.id < b.id
        }
    }
}
