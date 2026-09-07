// TerminalReaper — the syscall half of closing a tab.
//
// The selection rule and the escalation live in ForgeKit/TerminalReaping.swift,
// where they can be tested. What is here is what cannot be: reading the process
// table, reading another process's environment, signalling, and the `waitpid`
// that SwiftTerm never performs.
//
// Why the reap has to be ours: `LocalProcess.terminate()` sends the signal and
// then calls `childStopped()` in the same synchronous breath — and
// `childStopped()` cancels the DispatchSource whose handler holds the ONLY
// `waitpid` in SwiftTerm. The exit event therefore arrives with nobody
// listening, and the login shell stays a zombie for the life of the app. 40 of
// them were counted on 2026-09-02. Patching SwiftTerm is not the fix: it is an
// SPM checkout under .build, and any edit there is discarded on the next
// resolve.

import Foundation
import Darwin
import AppKit
import ForgeKit

enum TerminalReaper {

    // MARK: - Reading the machine

    /// The pty behind a session, from its master descriptor.
    ///
    /// Must be read BEFORE `LocalProcessTerminalView.terminate()`: closing the
    /// DispatchIO and setting `childfd = -1` are its first acts, and after that
    /// there is nothing left to identify the session's processes by.
    static func ttyDevice(of fd: Int32) -> dev_t? {
        guard fd >= 0 else { return nil }
        var st = stat()
        guard fstat(fd, &st) == 0 else { return nil }
        return st.st_rdev
    }

    /// The whole process table, reduced to `TerminalProcess`.
    ///
    /// `KERN_PROC_ALL` and not `KERN_PROC_TTY`: one call serves both the close
    /// path and the boot sweep, and doing the filtering in ForgeKit is what
    /// makes the selection testable.
    static func processTable() -> [TerminalProcess] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size = 0
        guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return [] }

        // The table can grow between sizing and reading. Ask for slack, then
        // trust the byte count that comes back rather than the one we asked
        // for — reading past what was written is how this turns into garbage
        // pids, and garbage pids here get signalled.
        size += size / 8
        var buf = [UInt8](repeating: 0, count: size)
        var got = size
        let ok = buf.withUnsafeMutableBytes { raw in
            sysctl(&mib, 4, raw.baseAddress, &got, nil, 0) == 0
        }
        guard ok, got > 0 else { return [] }

        let stride = MemoryLayout<kinfo_proc>.stride
        let count = got / stride
        guard count > 0 else { return [] }
        return buf.withUnsafeBytes { raw -> [TerminalProcess] in
            let base = raw.baseAddress!.assumingMemoryBound(to: kinfo_proc.self)
            return (0..<count).map { i in
                let p = base[i]
                return TerminalProcess(pid: p.kp_proc.p_pid,
                                       ppid: p.kp_eproc.e_ppid,
                                       tty: p.kp_eproc.e_tdev)
            }
        }
    }

    /// True when `pid` carries the `FORGE_APP=1` marker the app stamps on every
    /// shell it starts (see `TerminalViewStore.make`).
    ///
    /// `KERN_PROCARGS2` is the only way to read another process's environment.
    /// Its payload is argc, the exec path, padding, the argv strings and then
    /// the environment, all NUL-separated — so splitting the blob on NUL and
    /// looking for the exact token is enough, and cannot collide with a path.
    /// Returns false for anything unreadable, which is the safe direction: an
    /// unreadable process is simply not swept.
    static func carriesForgeMarker(_ pid: pid_t) -> Bool {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return false }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 0 else { return false }
        let marker = Array("FORGE_APP=1".utf8)
        return buf[..<size].split(separator: 0).contains { $0.elementsEqual(marker) }
    }

    // MARK: - Ending a session

    /// Ends every process on `tty`, then reaps `shellPid`.
    ///
    /// Blocking: it sleeps between escalation rungs. Call it off the main
    /// thread — `TerminalViewStore.closeSession` does.
    ///
    /// `shellPid` may be 0 for a leftover from a previous run: those were
    /// adopted by init when their app died, so init reaps them and a `waitpid`
    /// here would only fail.
    static func sweep(tty: dev_t, shellPid: pid_t) {
        let protected: Set<pid_t> = [getpid()]
        for step in TerminalReaping.escalation {
            let victims = TerminalReaping.victims(onTTY: tty,
                                                  among: processTable(),
                                                  protecting: protected)
            // Nothing left: the earlier rung was enough, and there is no reason
            // to spend the grace period.
            if victims.isEmpty { break }
            for pid in victims { kill(pid, step.signal) }
            if step.graceSeconds > 0 { Thread.sleep(forTimeInterval: step.graceSeconds) }
        }
        reap(shellPid)
    }

    /// The `waitpid` SwiftTerm cancels itself out of. Safe from any thread: a
    /// child belongs to the PROCESS, not to the thread that forked it.
    static func reap(_ pid: pid_t) {
        guard pid > 0 else { return }
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 && errno == EINTR { continue }
    }

    // MARK: - The net under the net

    /// Sessions left behind by a previous run: a crash, a force quit, or — for
    /// every build before this file existed — an ordinary tab close.
    ///
    /// This exists because nothing on the close path can cover those cases. A
    /// correct `closeSession` still leaks everything when the app dies without
    /// running it, and that is precisely how 8 days produced 69 sessions.
    ///
    /// Skipped outright when a second Forge is running: its live sessions carry
    /// the same marker and are not ours to end.
    static func sweepLeftovers() {
        let bundleID = Bundle.main.bundleIdentifier ?? "dev.forge.menubar"
        guard NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).count <= 1
        else { return }

        let table = processTable()
        // At launch this app owns no pty yet, so every marked one is a
        // leftover. Passing the empty set keeps the rule honest rather than
        // implicit, and lets the same call be reused later if it ever runs
        // outside launch.
        let ttys = TerminalReaping.leftoverTTYs(among: table,
                                                owned: [],
                                                marked: carriesForgeMarker)
        guard !ttys.isEmpty else { return }
        for tty in ttys { sweep(tty: tty, shellPid: 0) }
        NSLog("[Forge] sweep de boot: \(ttys.count) sessão(ões) órfã(s) de execução anterior encerrada(s)")
        // Told, not just logged. A leak nobody is shown grows for eight days.
        let count = ttys.count
        DispatchQueue.main.async { Notifier.shared.announceSweep(sessions: count) }
    }
}
