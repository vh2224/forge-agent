import Foundation
import AppKit
import ForgeKit

// UI adapter. The syscall implementation is shared with real-PTY tests.
enum TerminalReaper {
    static func sweepLeftovers() {
        let bundleID = Bundle.main.bundleIdentifier ?? "dev.forge.menubar"
        guard NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).count <= 1,
              let app = TerminalProcessSystem.process(getpid()) else { return }
        let original = TerminalReaping.bootCandidates(
            among: TerminalProcessSystem.processTable(), appStartedAt: app.startedAt,
            marked: TerminalProcessSystem.carriesForgeMarker)
        guard !original.isEmpty else { return }
        TerminalProcessSystem.sweep(original)
        let survivors = TerminalReaping.survivors(of: original, among: TerminalProcessSystem.processTable())
        let remainingPIDs = Set(survivors.map(\.pid))
        let remainingTTYs = Set(original.filter { remainingPIDs.contains($0.pid) }.map(\.tty))
        let count = Set(original.map(\.tty)).subtracting(remainingTTYs).count
        guard count > 0 else { return }
        NSLog("[Forge] sweep de boot: \(count) sessão(ões) órfã(s) encerrada(s)")
        DispatchQueue.main.async { Notifier.shared.announceSweep(sessions: count) }
    }
}
