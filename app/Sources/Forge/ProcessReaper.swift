// The effect half of descendant reaping: reading the real process table and
// actually sending the signals. Every DECISION about which pids are allowed to
// be signalled lives in `ForgeKit.ProcessReaping`, where a literal table proves
// it without a syscall; this file only carries out what that policy returned.
//
// Why the split is not ceremony: choosing a target wrong here does not corrupt
// data, it kills a stranger's process. `kill(0, …)` signals the app's OWN
// process group, `kill(1, …)` aims at launchd, and a `-` in front of a pid turns
// one target into a whole group. Those are exactly the mistakes that a test can
// catch and a code review cannot — so they are decided in ForgeKit and only
// executed here.

import Foundation
import ForgeKit

/// The one place in the app that touches libproc.
enum ProcessTable {

    /// Every process this uid can describe, as `(pid, ppid, startedAt)`.
    ///
    /// INCOMPLETE BY DESIGN, and that is not an error path: measured on this
    /// machine, `proc_pidinfo` refused 217 of 758 pids — all of them owned by
    /// another uid (sample: pid 16607, UID 0). Those rows are skipped in
    /// SILENCE. Treating them as failures would turn a normal state into noise,
    /// and — more importantly — a pid this snapshot cannot describe must never
    /// become a target, which is exactly what leaving it out of the table
    /// guarantees (`ProcessReaping.targets` drops anything absent from it).
    static func snapshot() -> [ProcEntry] {
        // The sizing call returns BYTES, not a count, and it undersizes: the
        // table changes between the two calls. Measured 3112 bytes (778 slots)
        // for a real listing of 758. Asking for the exact size is a race, so
        // the buffer carries slack.
        let sizingBytes = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
        guard sizingBytes > 0 else { return [] }

        let slotSize = MemoryLayout<pid_t>.size
        let capacity = Int(sizingBytes) / slotSize + 64
        var pids = [pid_t](repeating: 0, count: capacity)
        let writtenBytes = proc_listpids(UInt32(PROC_ALL_PIDS), 0, &pids, Int32(capacity * slotSize))
        guard writtenBytes > 0 else { return [] }

        let count = min(Int(writtenBytes) / slotSize, capacity)
        let infoSize = Int32(MemoryLayout<proc_bsdinfo>.size)
        var table: [ProcEntry] = []
        table.reserveCapacity(count)

        for index in 0..<count {
            let pid = pids[index]
            // `proc_listpids` pads the tail with zeroes when the table shrank
            // between the two calls.
            guard pid > 0 else { continue }
            var info = proc_bsdinfo()
            let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, infoSize)
            guard size == infoSize else { continue }
            table.append(ProcEntry(
                pid: pid,
                ppid: pid_t(bitPattern: info.pbi_ppid),
                // Start time is the identity check that makes escalating to
                // SIGKILL safe after a wait: a recycled pid answers with a
                // different one. Both fields combined (tvsec, tvusec) — see
                // `ProcEntry.startedAt` for why sub-second precision matters
                // even though a same-second collision is not realistic.
                startedAt: UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)))
        }
        return table
    }
}

/// Signals the descendant tree of a closing session, politely first.
///
/// Deliberately split into `plan` (synchronous, on the main actor, BEFORE the
/// PTY is torn down) and `execute` (async, off the main thread) because the
/// order is load-bearing — see `plan`.
enum ProcessReaper {

    /// The targets for `roots`, resolved against a snapshot taken RIGHT NOW.
    ///
    /// This exists as a separate, synchronous step for one measured reason: once
    /// `SwiftTerm.terminate()` has closed the master fd and signalled the shell,
    /// the shell becomes `ZN <defunct>` and `proc_pidinfo` on it returns nil. A
    /// snapshot taken after teardown therefore sees an EMPTY tree (measured:
    /// `total descendants=0`) and the whole reap silently becomes a no-op — the
    /// original bug wearing a different hat. So callers must plan first and tear
    /// down second.
    ///
    /// Cheap enough to run on the main actor (one `proc_listpids` plus one
    /// `proc_pidinfo` per pid), and it has to be: the registry it reads from is
    /// `@MainActor`.
    static func plan(roots: [pid_t]) -> [ProcEntry] {
        guard !roots.isEmpty else { return [] }
        return ProcessReaping.targets(roots: roots, table: ProcessTable.snapshot(), selfPid: getpid())
    }

    /// Ask, wait, insist.
    ///
    /// 1. Polite phase — `SIGHUP` then `SIGTERM`, per target, in the order given
    ///    (leaf-first): a supervisor signalled before its child would restart
    ///    the child before dying.
    /// 2. Grace — polls every `reapPollInterval` until the tree is empty or
    ///    `reapGracePeriod` runs out. It is a CEILING, not a wait: the
    ///    cooperative case was measured at 12.8 ms.
    /// 3. Force — `SIGKILL`, but only to what a FRESH snapshot still shows with
    ///    the same start time. A pid that died during the grace window can have
    ///    been recycled by the kernel, and escalating on the number alone would
    ///    kill an unrelated process.
    ///
    /// Never matches by process name, command line or port: the only thing that
    /// makes a pid a legitimate target is that the tree proved it descends from
    /// this session's shell.
    static func execute(targets: [ProcEntry]) async {
        guard !targets.isEmpty else { return }

        let polite = ProcessReaping.signals(for: .polite)
        for target in targets {
            for signal in polite { send(signal, to: target.pid) }
        }

        var remaining = targets
        let deadline = ContinuousClock.now.advanced(by: ProcessReaping.reapGracePeriod)
        while ContinuousClock.now < deadline {
            try? await Task.sleep(for: ProcessReaping.reapPollInterval)
            // Not just a re-validation of `remaining`: a supervisor that
            // respawns a worker during this window forks a child that was
            // never in `targets` to begin with, and `survivors` alone can
            // never see it. `rediscover` re-walks the tree from whichever
            // roots are still alive and politely signals only what is new —
            // see its doc-comment for the limit this does not close.
            let (all, newcomers) = ProcessReaping.rediscover(
                remaining: remaining, table: ProcessTable.snapshot(), selfPid: getpid())
            if !newcomers.isEmpty {
                for target in newcomers { for signal in polite { send(signal, to: target.pid) } }
            }
            remaining = all
            if remaining.isEmpty { return }
        }

        // One last identity check on the doorstep of SIGKILL.
        let stubborn = ProcessReaping.survivors(previous: remaining, table: ProcessTable.snapshot())
        guard !stubborn.isEmpty else { return }
        let force = ProcessReaping.signals(for: .force)
        for target in stubborn {
            for signal in force { send(signal, to: target.pid) }
        }
    }

    /// The single call site of `kill` in the app.
    ///
    /// The pid is ALWAYS positive and always an individual process. A negative
    /// argument would turn the target into a process group — a `-` typed by
    /// accident is the difference between ending one `node` and ending every
    /// process the app ever spawned, including the app.
    ///
    /// A failure is not reported: `ESRCH` (the process already exited) is the
    /// outcome this code is trying to produce, and `EPERM` (another uid) is
    /// already excluded by the policy's table filter.
    private static func send(_ signal: Int32, to pid: pid_t) {
        guard pid > 1 else { return }
        _ = kill(pid, signal)
    }
}
