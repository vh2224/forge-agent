import Foundation
import Darwin
import ForgeKit

private func procargs(argv: [String], environment: [String]) -> [UInt8] {
    var argc = Int32(argv.count)
    var bytes = withUnsafeBytes(of: &argc) { Array($0) }
    bytes += Array("/fixture\0\0\0".utf8)
    for entry in argv + environment { bytes += Array(entry.utf8) + [0] }
    return bytes + [0]
}

func runTerminalReapingTests() {
    test("procargs: marker in argv is not ownership") {
        let bytes = procargs(argv: ["grep", "FORGE_APP=1", "file"], environment: ["PATH=/bin"])
        assertEqual(TerminalReaping.environment(in: bytes), ["PATH=/bin"])
    }
    test("procargs: empty argv entries and executable padding preserve environment") {
        let bytes = procargs(argv: ["shell", "", "arg"], environment: ["FORGE_APP=1", "X=2"])
        assertEqual(TerminalReaping.environment(in: bytes), ["FORGE_APP=1", "X=2"])
    }
    test("procargs: malformed and truncated buffers fail closed") {
        assertEqual(TerminalReaping.environment(in: [1, 0]), [])
        var bytes = procargs(argv: ["shell"], environment: ["FORGE_APP=1"])
        bytes.removeLast(2)
        assertEqual(TerminalReaping.environment(in: bytes), [])
        assertEqual(TerminalReaping.environment(in: [255, 255, 255, 255, 0]), [])
    }
    test("escalation: reused tty and recycled PID never join the cohort") {
        let old = TerminalProcess(pid: 100, ppid: 1, tty: 42, startedAt: 10)
        let new = TerminalProcess(pid: 200, ppid: 1, tty: 42, startedAt: 20)
        let recycled = TerminalProcess(pid: 100, ppid: 1, tty: 42, startedAt: 30)
        assertEqual(TerminalReaping.survivors(of: [old], among: [new, recycled]), [])
        let detached = TerminalProcess(pid: 100, ppid: 1, tty: -1, startedAt: 10)
        assertEqual(TerminalReaping.survivors(of: [old], among: [detached]), [old])
    }
    test("boot: delayed worker protects current tabs and mixed-age ttys") {
        let old = TerminalProcess(pid: 100, ppid: 1, tty: 42, startedAt: 10)
        let current = TerminalProcess(pid: 200, ppid: 99, tty: 77, startedAt: 30)
        assertEqual(TerminalReaping.bootCandidates(among: [old, current], appStartedAt: 20) { _ in true }, [old])
        let reused = TerminalProcess(pid: 300, ppid: 99, tty: 42, startedAt: 30)
        assertEqual(TerminalReaping.bootCandidates(among: [old, reused], appStartedAt: 20) { _ in true }, [])
        assertEqual(TerminalReaping.bootCandidates(among: [old], appStartedAt: 0) { _ in true }, [])
    }
    test("sysctl: real argv-only marker is rejected; real environment is accepted") {
        for marked in [false, true] {
            let child = Process()
            child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            child.arguments = ["--terminal-environment-fixture", "FORGE_APP=1"]
            child.environment = marked ? ["FORGE_APP": "1"] : [:]
            try child.run()
            defer { child.terminate(); child.waitUntilExit() }
            assertEqual(TerminalProcessSystem.carriesForgeMarker(child.processIdentifier), marked)
        }
    }
    test("real PTY: master resolves to child controlling slave; TERM then KILL and reap") {
        var ready: [Int32] = [0, 0]
        guard pipe(&ready) == 0 else { throw Failure(message: "pipe failed") }
        defer { close(ready[0]); close(ready[1]) }
        var master: Int32 = -1
        let child = forkpty(&master, nil, nil, nil)
        if child == 0 {
            // Only libc calls after fork: no Swift allocation or Foundation.
            signal(SIGTERM, SIG_IGN)
            signal(SIGHUP, SIG_IGN)
            var byte: UInt8 = 1
            _ = write(ready[1], &byte, 1)
            while true { pause() }
        }
        guard child > 1 else { throw Failure(message: "forkpty failed") }
        var reaped = false
        defer {
            close(master)
            if !reaped {
                kill(child, SIGKILL)
                var status: Int32 = 0
                while waitpid(child, &status, 0) < 0 && errno == EINTR {}
            }
        }
        _ = fcntl(ready[0], F_SETFL, O_NONBLOCK)
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        var byte: UInt8 = 0
        while read(ready[0], &byte, 1) != 1 && ProcessInfo.processInfo.systemUptime < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        guard byte == 1, let row = TerminalProcessSystem.process(child),
              let tty = TerminalProcessSystem.ttyDevice(of: master) else {
            throw Failure(message: "PTY child did not become ready")
        }
        assertEqual(tty, row.tty, "master must resolve to slave e_tdev")
        assertGreater(row.startedAt, 0)
        let cohort = TerminalProcessSystem.capture(fd: master)
        assertTrue(cohort.contains(row), "real process table must capture the child")
        assertEqual(TerminalProcessSystem.capture(fd: -1), [])

        // A process with the same PID but different creation time must survive.
        let wrong = TerminalProcess(pid: row.pid, ppid: row.ppid, tty: row.tty,
                                    startedAt: row.startedAt + 1)
        assertEqual(TerminalProcessSystem.signal([wrong], with: SIGKILL), 0)
        assertEqual(kill(child, 0), 0)
        assertEqual(TerminalProcessSystem.signal([row], with: SIGTERM), 1)
        Thread.sleep(forTimeInterval: 0.05)
        assertEqual(kill(child, 0), 0, "fixture ignores TERM")
        TerminalProcessSystem.sweep([row])
        TerminalProcessSystem.reap(child)
        var status: Int32 = 0
        let result = waitpid(child, &status, WNOHANG)
        reaped = result == child || (result == -1 && errno == ECHILD)
        assertEqual(result, -1, "reaper must collect the child")
        assertEqual(errno, ECHILD)
        assertTrue(reaped)
    }
}
