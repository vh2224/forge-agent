// Darwin adapter shared by the app and the real-PTY regression tests.
import Foundation
import Darwin

public enum TerminalProcessSystem {
    /// childfd is the master; e_tdev names the slave. Use caller-owned storage
    /// rather than ptsname's shared static buffer.
    public static func ttyDevice(of fd: Int32) -> dev_t? {
        guard fd >= 0 else { return nil }
        var name = [CChar](repeating: 0, count: 128)
        guard ioctl(fd, TIOCPTYGNAME, &name) == 0 else { return nil }
        var info = stat()
        guard stat(name, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFCHR,
              info.st_rdev != TerminalReaping.noTTY else { return nil }
        return info.st_rdev
    }

    private static func row(_ p: kinfo_proc) -> TerminalProcess {
        let start = p.kp_proc.p_un.__p_starttime
        let stamp = start.tv_sec > 0
            ? UInt64(start.tv_sec) * 1_000_000 + UInt64(start.tv_usec) : 0
        return TerminalProcess(pid: p.kp_proc.p_pid, ppid: p.kp_eproc.e_ppid,
                               tty: p.kp_eproc.e_tdev, startedAt: stamp)
    }

    public static func process(_ pid: pid_t) -> TerminalProcess? {
        guard pid > 1 else { return nil }
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0,
              size == MemoryLayout<kinfo_proc>.stride else { return nil }
        return row(info)
    }

    public static func processTable() -> [TerminalProcess] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        for _ in 0..<3 {
            var size = 0
            guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return [] }
            let stride = MemoryLayout<kinfo_proc>.stride
            var rows = [kinfo_proc](repeating: kinfo_proc(), count: size / stride + 32)
            size = rows.count * stride
            let ok = rows.withUnsafeMutableBytes {
                sysctl(&mib, 4, $0.baseAddress, &size, nil, 0) == 0
            }
            if !ok {
                if errno == ENOMEM { continue }
                return []
            }
            guard size <= rows.count * stride, size % stride == 0 else { return [] }
            return rows.prefix(size / stride).map(row)
        }
        return []
    }

    public static func carriesForgeMarker(_ pid: pid_t) -> Bool {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return false }
        var bytes = [UInt8](repeating: 0, count: size)
        let ok = bytes.withUnsafeMutableBytes {
            sysctl(&mib, 3, $0.baseAddress, &size, nil, 0) == 0
        }
        guard ok, size > 0, size <= bytes.count else { return false }
        return TerminalReaping.environment(in: Array(bytes.prefix(size))).contains("FORGE_APP=1")
    }

    /// Capture while the master is still open, before SwiftTerm releases it.
    public static func capture(fd: Int32) -> [TerminalProcess] {
        guard let tty = ttyDevice(of: fd) else { return [] }
        return processTable().filter { $0.tty == tty && $0.pid > 1 && $0.pid != getpid() }
    }

    /// Revalidate immediately before each signal, including TERM.
    @discardableResult
    public static func signal(_ original: [TerminalProcess], with signal: Int32) -> Int {
        var sent = 0
        for old in original where old.pid > 1 && old.pid != getpid() {
            guard let current = process(old.pid),
                  !TerminalReaping.survivors(of: [old], among: [current]).isEmpty else { continue }
            if kill(old.pid, signal) == 0 { sent += 1 }
        }
        return sent
    }

    public static func sweep(_ original: [TerminalProcess]) {
        for step in TerminalReaping.escalation {
            if signal(original, with: step.signal) == 0 { break }
            if step.graceSeconds > 0 { Thread.sleep(forTimeInterval: step.graceSeconds) }
        }
    }

    /// Bounded retries: failed signals must not park a dispatch worker forever.
    /// SwiftTerm may already have reaped the child.
    public static func reap(_ pid: pid_t) {
        guard pid > 1 else { return }
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        var status: Int32 = 0
        repeat {
            let result = waitpid(pid, &status, WNOHANG)
            if result == pid || (result < 0 && errno != EINTR) { return }
            Thread.sleep(forTimeInterval: 0.01)
        } while ProcessInfo.processInfo.systemUptime < deadline
    }
}
