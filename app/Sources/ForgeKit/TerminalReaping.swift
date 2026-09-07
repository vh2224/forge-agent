// TerminalReaping — which processes a closed tab has to take with it.
//
// Measured on 2026-09-02, after 69 sessions piled up over 8 days and put a
// 16 GB machine into swap thrashing (27,3 GB of 28 GB swap in use, 56 MB of RAM
// free, load average 127, ~14 MB/s read back from swap without pause):
// SwiftTerm's `LocalProcess.terminate()` does `kill(shellPid, SIGTERM)` — one
// pid. A Claude Code tab is three process groups, not one:
//
//   -zsh -l   ppid=468 (Forge)  pgid=87979   ← the only thing kill() reaches
//   claude    ppid=87979        pgid=90892   ← + its MCP servers, + caffeinate
//   -zsh -l   ppid=1            pgid=88020   ← gitstatusd, adopted by init
//
// So the descendant tree is not the right set (it misses the reparented shell)
// and neither is the process group (it misses claude's). The set that is
// exactly right is "every process whose CONTROLLING TERMINAL is this pty" —
// that is what a tty session means, and the reparented shell is still in it.
//
// Policy lives here, free of syscalls, so the selection is a test rather than a
// hope. The sysctl/kill/waitpid half is Forge/TerminalReaper.swift.

import Foundation

/// One row of the process table, reduced to what the decision needs.
public struct TerminalProcess: Equatable, Sendable {
    public let pid: pid_t
    public let ppid: pid_t
    /// Controlling terminal, as `kinfo_proc.kp_eproc.e_tdev`.
    public let tty: dev_t

    public init(pid: pid_t, ppid: pid_t, tty: dev_t) {
        self.pid = pid
        self.ppid = ppid
        self.tty = tty
    }
}

/// One rung of the escalation.
public struct SignalStep: Equatable, Sendable {
    public let signal: Int32
    /// How long to wait before re-reading the table for the next rung.
    public let graceSeconds: Double

    public init(signal: Int32, graceSeconds: Double) {
        self.signal = signal
        self.graceSeconds = graceSeconds
    }
}

public enum TerminalReaping {
    /// `e_tdev` for "no controlling terminal" (NODEV). Every daemon on the
    /// machine carries it, which is the whole reason it can never be used as a
    /// selector — see the guard in `victims`.
    public static let noTTY: dev_t = -1

    /// pids that are never signalled, whatever the table says. pid 1 for the
    /// obvious reason; pid 0 because it is the kernel.
    public static let neverSignal: Set<pid_t> = [0, 1]

    /// SIGTERM, then SIGKILL. This is not defensive habit: of the 39 orphaned
    /// sessions swept on 2026-09-02, **38 ignored SIGTERM entirely** and only
    /// died to SIGKILL. Claude Code traps the term signal. A single-signal
    /// close would leave almost everything running and look like it worked.
    public static let escalation: [SignalStep] = [
        SignalStep(signal: SIGTERM, graceSeconds: 2),
        SignalStep(signal: SIGKILL, graceSeconds: 0),
    ]

    /// Everything to signal for the session backed by `tty`.
    ///
    /// Sorted so the caller's behaviour is reproducible and the tests can state
    /// an exact list rather than a set.
    public static func victims(onTTY tty: dev_t,
                               among table: [TerminalProcess],
                               protecting protected: Set<pid_t> = []) -> [pid_t] {
        // The guard the whole file turns on. `noTTY` is shared by every daemon
        // on the machine, so a session whose pty could not be read must sweep
        // NOTHING — the failure mode of getting this wrong is killing the
        // system, not leaking a tab.
        guard tty != noTTY else { return [] }
        let spared = protected.union(neverSignal)
        return table
            .filter { $0.tty == tty && !spared.contains($0.pid) }
            .map(\.pid)
            .sorted()
    }

    /// The ptys of sessions left behind by a previous run of the app.
    ///
    /// `marked` is "this process carries FORGE_APP=1", the env marker the app
    /// already stamps on every shell it starts. A marked process on a pty that
    /// no live session owns is a leftover by definition: the app that started
    /// it is gone.
    public static func leftoverTTYs(among table: [TerminalProcess],
                                    owned: Set<dev_t>,
                                    marked: (pid_t) -> Bool) -> [dev_t] {
        var found: Set<dev_t> = []
        for p in table where p.tty != noTTY && !owned.contains(p.tty) {
            guard !neverSignal.contains(p.pid) else { continue }
            if marked(p.pid) { found.insert(p.tty) }
        }
        return found.sorted()
    }
}
