// Descendant-tree reaping policy: which pids a closing session may signal, in
// what order, and when it is allowed to escalate.
//
// THE BUG THIS PREVENTS. SwiftTerm's `terminate()` closes the master fd and
// sends ONE `kill(shellPid, SIGTERM)` — it reaches the login shell and nothing
// else. `forkpty(3)` gave that shell its own session (`setsid`) and controlling
// terminal, so nothing the kernel does propagates the app's death to it either.
// Everything the user started inside the tab — `next dev`, a `sleep`, a pnpm
// supervisor — therefore survived both closing the tab and quitting the app,
// reparented to launchd with PPID 1. The quit alert promised the opposite.
//
// WHY DESCENDANCY BY PPID AND NOT `kill(-pgid)` (measured, D8). zsh job control
// gives every background job its OWN process group: a `sleep 400 &` under a
// shell with pgid 80273 was measured at `pid=80607, pgid=80607`. Signalling the
// shell's process group would never have reached it. The PPID walk found that
// same process at depth 1. `pgid` is deliberately absent from `ProcEntry`: a
// field that decides nothing invites deciding by it.
//
// WHY THE POLICY IS PURE. Choosing targets from a process table is where this
// gets dangerous — `kill(0, …)` signals the app's own process group, `kill(1, …)`
// aims at launchd, and a corrupted table can walk into the app's own ancestry.
// Those are decisions, not syscalls, so they live here where a literal
// `[ProcEntry]` table can prove them. The only code that touches libproc is
// `ProcessTable.snapshot()` in the app target.
//
// MEASURED LIMIT, RECORDED HONESTLY. A process that orphans ITSELF before the
// snapshot — `(sleep 402 &)`, where the subshell exits immediately and the
// grandchild is born with `ppid=1` — is not reachable by descendancy and is not
// covered here. That is a different failure class (it needs identity by
// environment marker, not by parentage).

import Foundation

/// One row of a process table snapshot: enough to rebuild the tree and to
/// prove, later, that a pid is still the same process it was.
///
/// `startedAt` is `proc_bsdinfo.pbi_start_tvsec` and `pbi_start_tvusec`
/// combined into one value, in MICROSECONDS SINCE THE EPOCH — not seconds, do
/// not compare it against `time()`. It exists for one reason: between the
/// polite phase and `SIGKILL` there is a grace window, and a pid that died
/// inside it can be recycled by the kernel for an unrelated process.
/// Escalating on pid alone would kill a stranger. The microsecond component
/// matters even though PID allocation on macOS is sequential with wraparound
/// at 99999 (measured: 300 forks advanced the counter by 343) — same-second
/// reuse would need ~10^5 forks/s to hit the second-granularity version of
/// this field, but an identity check should not leave a field it already has
/// unused.
public struct ProcEntry: Equatable, Sendable {
    public let pid: pid_t
    public let ppid: pid_t
    public let startedAt: UInt64

    public init(pid: pid_t, ppid: pid_t, startedAt: UInt64) {
        self.pid = pid
        self.ppid = ppid
        self.startedAt = startedAt
    }
}

/// The two rungs of the ladder. Kept as a type rather than as two call sites so
/// the signal set is data the tests can pin down.
public enum ReapPhase: Equatable {
    /// Ask: `SIGHUP` is what zsh translates into hupping its jobs (measured at
    /// 12.8 ms for the cooperative case); `SIGTERM` covers whatever the shell
    /// chose not to hup (`disown`, `NO_HUP`).
    case polite
    /// Insist.
    case force
}

public enum ProcessReaping {

    // MARK: Timing

    /// CEILING, not a fixed wait. The cooperative case was measured at 12.8 ms;
    /// polling means the typical quit costs milliseconds and this number is only
    /// ever paid by a process whose shutdown handler is actually working.
    public static let reapGracePeriod: Swift.Duration = .milliseconds(2000)

    /// How often the tree is re-listed while waiting out `reapGracePeriod`.
    public static let reapPollInterval: Swift.Duration = .milliseconds(50)

    // MARK: Tree

    /// Transitive closure of `root`'s descendants, LEAF-FIRST — deepest
    /// generation first, `root` itself never included.
    ///
    /// Leaf-first is not cosmetic: a supervisor (pnpm, npm exec) that sees its
    /// child disappear before it is signalled itself will simply start another
    /// one. Signalling the deepest generation first closes that window.
    ///
    /// The table is INCOMPLETE BY DESIGN — `proc_pidinfo` refuses roughly 29% of
    /// the machine's pids (other uids), so a referenced `ppid` may be absent —
    /// and it may be CORRUPT: a cycle (`a.ppid == b.pid && b.ppid == a.pid`)
    /// must terminate, not hang. Both are handled by the visited set.
    public static func descendants(of root: pid_t, in table: [ProcEntry]) -> [ProcEntry] {
        let childIndex = children(in: table)
        var visited: Set<pid_t> = [root]
        var out: [(entry: ProcEntry, depth: Int)] = []
        var frontier: [pid_t] = [root]
        var depth = 0

        while !frontier.isEmpty {
            depth += 1
            var next: [pid_t] = []
            for parent in frontier {
                for child in childIndex[parent] ?? [] {
                    // A pid already seen is either a diamond (impossible in a
                    // real tree) or a cycle in a corrupted table. Either way,
                    // walking it again is how a walk never returns.
                    guard !visited.contains(child.pid) else { continue }
                    visited.insert(child.pid)
                    out.append((child, depth))
                    next.append(child.pid)
                }
            }
            frontier = next
        }

        return ordered(out)
    }

    /// Every pid it is legitimate to signal for `roots`, leaf-first, roots last,
    /// deduplicated — with the mandatory safety filters applied.
    ///
    /// The filters are the point of this function, and each one is a measured
    /// hazard rather than defensive habit:
    /// - `pid <= 1` (S1): `kill(1, …)` aims at launchd; `kill(0, …)` is NOT a
    ///   no-op, it signals the CALLER'S whole process group — the app and
    ///   everything it spawned; `kill(-1, …)` signals every process of the uid.
    /// - `selfPid` and any ancestor of it (S2): the app killing itself mid-quit
    ///   is indistinguishable from a crash, and killing its parent is worse.
    ///   The ancestor chain is computed from this same table, so a corrupted
    ///   table cannot smuggle the app's parent in through a cycle.
    /// - a pid absent from the table (S3): if the snapshot could not describe
    ///   it, it belongs to another uid or no longer exists. `kill` would fail
    ///   with `EPERM` anyway, but relying on the kernel to refuse is relying on
    ///   luck instead of on design.
    ///
    /// Taking the WHOLE table (rather than a per-pid callback) makes the
    /// function total, removes TOCTOU skew between N syscalls, and lets the quit
    /// path scan every session against a single snapshot.
    public static func targets(roots: [pid_t], table: [ProcEntry], selfPid: pid_t) -> [ProcEntry] {
        let byPid = Dictionary(table.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        let forbidden = ancestry(of: selfPid, in: byPid)

        // Deepest wins: a pid reachable as a grandchild of one root and as a
        // child of another must still be signalled before either root.
        var depthByPid: [pid_t: Int] = [:]
        var entryByPid: [pid_t: ProcEntry] = [:]

        for root in roots {
            for entry in descendants(of: root, in: table) {
                let depth = 1 + relativeDepth(of: entry.pid, from: root, in: byPid)
                entryByPid[entry.pid] = entry
                depthByPid[entry.pid] = max(depthByPid[entry.pid] ?? 0, depth)
            }
            if let rootEntry = byPid[root] {
                entryByPid[root] = rootEntry
                depthByPid[root] = max(depthByPid[root] ?? 0, 0)
            }
        }

        let candidates = entryByPid.values.map { (entry: $0, depth: depthByPid[$0.pid] ?? 0) }
        return ordered(candidates).filter { entry in
            entry.pid > 1                      // S1
                && entry.pid != selfPid        // S2
                && !forbidden.contains(entry.pid)  // S2
                && byPid[entry.pid] != nil     // S3
        }
    }

    /// The subset of `previous` that is still the SAME process in `table`.
    ///
    /// Same pid with a different `startedAt` means the kernel recycled the
    /// number while we were waiting out the grace period — an unrelated process
    /// now answers to it, and escalating to `SIGKILL` would kill a bystander.
    /// A pid gone from the table is simply dead, which is the outcome we wanted.
    /// Order (leaf-first) is inherited from `previous`.
    public static func survivors(previous: [ProcEntry], table: [ProcEntry]) -> [ProcEntry] {
        let byPid = Dictionary(table.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        return previous.filter { byPid[$0.pid]?.startedAt == $0.startedAt }
    }

    /// Re-derives what the poll should track next: the surviving entries from
    /// `remaining` (by identity, same rule as `survivors`) PLUS any descendant
    /// that forked, under one of those survivors, AFTER the last snapshot.
    ///
    /// WHY THIS EXISTS. `survivors` alone only re-validates pids it already
    /// knew about — it never asks the tree again. A supervisor with a slow
    /// SIGTERM handler that respawns a worker during the grace window, or a
    /// `trap '' TERM` script that keeps forking, produces a child that
    /// `survivors` can never see: it was never in `remaining` to begin with.
    /// When the parent is eventually SIGKILLed, that child reparents to
    /// launchd and survives — the exact failure the quit alert promises not
    /// to have.
    ///
    /// `remaining`'s pids that are STILL ALIVE (per `survivors`) are the roots
    /// of the re-walk, never the original session root: after `terminate()`
    /// the login shell is `ZN <defunct>`, and using a zombie as root would
    /// find an empty tree right as its children are about to reparent.
    ///
    /// `newcomers` is `all` minus every pid already present in `remaining` —
    /// so a target signalled on a previous poll is never re-signalled and
    /// never gets its grace clock restarted.
    ///
    /// MEASURED LIMIT, RECORDED HONESTLY. A fork that happens between the
    /// LAST poll and the SIGKILL deadline is still unreachable: there is no
    /// pause-the-world primitive on macOS to freeze forking while this
    /// decision runs. This narrows that window to one poll interval; it does
    /// not close it.
    public static func rediscover(
        remaining: [ProcEntry], table: [ProcEntry], selfPid: pid_t
    ) -> (all: [ProcEntry], newcomers: [ProcEntry]) {
        let survived = survivors(previous: remaining, table: table)
        guard !survived.isEmpty else { return ([], []) }

        let knownPids = Set(remaining.map(\.pid))
        let all = targets(roots: survived.map(\.pid), table: table, selfPid: selfPid)
        let newcomers = all.filter { !knownPids.contains($0.pid) }
        return (all, newcomers)
    }

    /// The signals of one rung, in send order.
    public static func signals(for phase: ReapPhase) -> [Int32] {
        switch phase {
        case .polite: return [SIGHUP, SIGTERM]
        case .force:  return [SIGKILL]
        }
    }

    // MARK: Private

    private static func children(in table: [ProcEntry]) -> [pid_t: [ProcEntry]] {
        var index: [pid_t: [ProcEntry]] = [:]
        for entry in table {
            // A row claiming to be its own parent is corruption, and following
            // it is an immediate infinite loop rather than a deep one.
            guard entry.ppid != entry.pid else { continue }
            index[entry.ppid, default: []].append(entry)
        }
        return index
    }

    /// Deepest first; pid ascending inside a generation so the order is
    /// deterministic and testable (the registry's own order is undefined).
    private static func ordered(_ rows: [(entry: ProcEntry, depth: Int)]) -> [ProcEntry] {
        rows.sorted {
            $0.depth != $1.depth ? $0.depth > $1.depth : $0.entry.pid < $1.entry.pid
        }.map(\.entry)
    }

    /// `pid` and every ancestor of it reachable through the table, cycle-safe.
    private static func ancestry(of pid: pid_t, in byPid: [pid_t: ProcEntry]) -> Set<pid_t> {
        var chain: Set<pid_t> = [pid]
        var cursor = byPid[pid]?.ppid
        while let current = cursor, current > 0, !chain.contains(current) {
            chain.insert(current)
            cursor = byPid[current]?.ppid
        }
        return chain
    }

    /// Hops from `root` down to `pid`, following parent links upward. Returns 0
    /// when the chain does not reach `root` (an unrelated or unreachable pid),
    /// which only affects ordering — membership is decided by `descendants`.
    private static func relativeDepth(of pid: pid_t, from root: pid_t, in byPid: [pid_t: ProcEntry]) -> Int {
        var hops = 0
        var seen: Set<pid_t> = [pid]
        var cursor = byPid[pid]?.ppid
        while let current = cursor, current > 0, !seen.contains(current) {
            if current == root { return hops }
            seen.insert(current)
            hops += 1
            cursor = byPid[current]?.ppid
        }
        return 0
    }
}
