// Notifications — answering a gate without opening the app.
//
// This is the capability the whole idea rested on: a headless run parks on a
// question, macOS shows it with the options AS BUTTONS, you click one, the run
// resumes. No window, no terminal.
//
// Why not the osascript notification the engine already sends: that one is
// posted by whatever process ran the AppleScript, so it carries the wrong icon
// and — decisively — cannot have action buttons. Only a real bundled app can
// register actionable categories, which is precisely what this app is for. The
// engine's own notification stays as the fallback for CLI-only setups.
//
// One category is registered per gate, because the buttons ARE that gate's
// options and no fixed category could describe them ahead of time.
//
// AD-HOC SIGNING BLOCKS THE NATIVE PATH. Verified on macOS 26.4 with no signing
// identity available: requestAuthorization fails with "Notifications are not
// allowed for this application", and the bundle never appears among the apps
// registered in com.apple.ncprefs — the system simply refuses an ad-hoc signed
// bundle as a notifier. A Developer ID signature is what unlocks it.
//
// So there is a fallback: `osascript display notification`, which does work
// (verified: banner shown, sound played). It cannot carry action buttons and
// shows a generic icon, so it announces rather than resolves — you still have
// to open the app to answer. Announcing is the part that cannot be missed;
// buttons are the upgrade that arrives with a real signature.

import Foundation
import UserNotifications
import AppKit
import ForgeKit

@MainActor
final class Notifier: NSObject, ObservableObject {
    static let shared = Notifier()

    /// What the system will actually do, which is NOT the same as
    /// authorizationStatus. Verified on this machine: a bundle can report
    /// status .denied while alertSetting/soundSetting are .enabled, and
    /// delivering still works. Gating on authorizationStatus alone silently
    /// disables every notification — that was the original bug.
    @Published private(set) var canAlert = false
    @Published private(set) var statusText = "verificando…"
    @Published private(set) var needsSystemSettings = false
    @Published private(set) var lastError: String?

    /// Gates already announced. Without this the 2s poll would re-notify the
    /// same question every tick.
    private var announced: Set<String> = []

    private let center = UNUserNotificationCenter.current()

    /// Diagnostic trail. Notification failures are invisible by nature — the
    /// banner simply never appears — so the decisions get written down.
    private static let logPath = NSTemporaryDirectory() + "forge-notify.log"

    static func trace(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let entry = "[\(stamp)] \(line)\n"
        if let h = FileHandle(forWritingAtPath: logPath) {
            h.seekToEndOfFile(); h.write(entry.data(using: .utf8)!); try? h.close()
        } else {
            try? entry.data(using: .utf8)!.write(to: URL(fileURLWithPath: logPath))
        }
    }

    func start() {
        center.delegate = self
        refreshSettings()
    }

    /// Re-read the real settings. Called on launch and whenever the user might
    /// have changed something in System Settings.
    func refreshSettings() {
        center.getNotificationSettings { [weak self] settings in
            let status = settings.authorizationStatus
            Task { @MainActor in
                guard let self else { return }

                switch status {
                case .authorized, .provisional:
                    Self.trace("settings: authorized")
                    self.canAlert = true
                    self.needsSystemSettings = false
                    self.statusText = "ativas"
                case .denied:
                    // alertSetting/soundSetting read as .enabled even for a
                    // bundle the system never registered as a notifier, and the
                    // native delivery then fails with no error at all. Only
                    // .authorized/.provisional may take the native path;
                    // everything else uses the fallback, which demonstrably works.
                    Self.trace("settings: denied, alert=\(settings.alertSetting.rawValue) sound=\(settings.soundSetting.rawValue) → fallback")
                    self.canAlert = false
                    self.needsSystemSettings = false
                    self.statusText = "modo alternativo (sem botões — app sem assinatura Developer ID)"
                case .notDetermined:
                    Self.trace("settings: notDetermined — pedindo permissão")
                    self.statusText = "pedindo permissão…"
                    self.request()
                default:
                    Self.trace("settings: status=\(status.rawValue) → fallback")
                    self.canAlert = false
                    self.statusText = "modo alternativo (sem botões — app sem assinatura Developer ID)"
                }
            }
        }
    }

    func request() {
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, err in
            Task { @MainActor in
                guard let self else { return }
                Self.trace("requestAuthorization granted=\(granted) err=\(err?.localizedDescription ?? "nil")")
                if let err, !granted {
                    // Happens once a bundle has been denied: the prompt never
                    // reappears and only System Settings can undo it.
                    self.lastError = err.localizedDescription
                }
                self.refreshSettings()
            }
        }
    }

    /// Deep-link to the notification pane; the prompt does not come back.
    func openSystemSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications")!
        NSWorkspace.shared.open(url)
    }

    /// True when banners come from osascript rather than the app itself, i.e.
    /// without action buttons.
    var usingFallback: Bool { !canAlert }

    /// Announce any gate not yet announced, and withdraw the ones that are gone.
    func sync(pending: [Gate]) {
        let ids = Set(pending.map(\.id))
        let stale = announced.subtracting(ids)
        if !stale.isEmpty {
            // Answered elsewhere (window, CLI, another machine) or expired —
            // a notification for a question that no longer exists is a lie.
            center.removeDeliveredNotifications(withIdentifiers: Array(stale))
            announced.subtract(stale)
        }

        for gate in pending where !announced.contains(gate.id) {
            announced.insert(gate.id)
            Self.trace("anunciando \(gate.id) via \(canAlert ? "nativa" : "osascript")")
            if canAlert { post(gate) } else { postFallback(gate) }
        }
    }

    /// Banner via osascript. Works where the native path is refused, at the
    /// cost of buttons and the app icon.
    private func postFallback(_ gate: Gate) {
        let sub = [gate.projectName, gate.subtitle]
            .filter { !$0.isEmpty }.joined(separator: " · ")
        postBanner(title: "Forge precisa de você", subtitle: sub,
                   body: gate.question.replacingOccurrences(of: "\n", with: " "))
    }

    /// osascript banner. Shared by gates and update announcements.
    private func postBanner(title: String, subtitle: String, body: String) {
        func esc(_ v: String) -> String {
            v.replacingOccurrences(of: "\\", with: "\\\\")
             .replacingOccurrences(of: "\"", with: "\\\"")
        }
        let script = "display notification \"\(esc(body))\" " +
                     "with title \"\(esc(title))\" " +
                     "subtitle \"\(esc(subtitle))\" sound name \"Submarine\""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        let err = Pipe()
        p.standardError = err
        do {
            try p.run()
            p.waitUntilExit()
            let e = String(data: err.fileHandleForReading.readDataToEndOfFile(),
                           encoding: .utf8) ?? ""
            Self.trace("osascript exit=\(p.terminationStatus) err=\(e.trimmingCharacters(in: .whitespacesAndNewlines))")
            if p.terminationStatus != 0 { lastError = e }
        } catch {
            Self.trace("osascript falhou: \(error.localizedDescription)")
            lastError = error.localizedDescription
        }
    }

    /// Fire a banner right now, through whichever path is active. Without this
    /// the only way to test is to wait for a real gate.
    func testNow() {
        Self.trace("teste manual — canAlert=\(canAlert) status=\(statusText)")
        let probe = Gate(
            id: "test-\(Int(Date().timeIntervalSince1970))", run_id: "TESTE",
            unit_id: nil, origin: nil, cwd: nil,
            question: "Notificação de teste do Forge.", context: nil,
            options: [GateOption(key: "ok", label: "OK", description: "")],
            default: "ok", status: "pending", answer: nil,
            created_at: Date.nowMs, expires_at: nil)
        if canAlert { post(probe) } else { postFallback(probe) }
    }

    private func post(_ gate: Gate) {
        // macOS shows the first two actions inline and folds the rest into a
        // menu, so the order matters: keep the gate's own order, which puts the
        // conservative default last by convention.
        let actions = gate.options.prefix(4).map { opt in
            UNNotificationAction(identifier: opt.key, title: opt.label, options: [])
        }
        let categoryID = "gate.\(gate.id)"
        let category = UNNotificationCategory(
            identifier: categoryID,
            actions: Array(actions),
            intentIdentifiers: [],
            options: [])

        // Replace the whole set each time: categories are global, and leaving
        // dead ones registered grows without bound across a long session.
        var categories: Set<UNNotificationCategory> = [category]
        center.getNotificationCategories { existing in
            categories.formUnion(existing.filter { $0.identifier != categoryID })
            self.center.setNotificationCategories(categories)

            let content = UNMutableNotificationContent()
            content.title = "Forge precisa de você"
            content.subtitle = [gate.projectName, gate.subtitle]
                .filter { !$0.isEmpty }.joined(separator: " · ")
            content.body = gate.question
            content.sound = .default
            content.categoryIdentifier = categoryID
            content.userInfo = ["gate": gate.id, "cwd": gate.cwd ?? ""]

            let request = UNNotificationRequest(
                identifier: gate.id, content: content, trigger: nil)
            self.center.add(request) { error in
                guard let error else { return }
                Task { @MainActor in
                    self.lastError = error.localizedDescription
                    // Allow a retry on the next poll rather than pretending it
                    // was announced.
                    self.announced.remove(gate.id)
                }
            }
        }
    }

    /// Announce a Forge release. Not a gate — no options to answer — so it goes
    /// out as a plain banner on whichever path is working.
    func announceUpdate(version: String, headline: String?) {
        let body = headline.map { "\(version) — \($0)" } ?? "Versão \(version) disponível"
        Self.trace("update \(version) via \(canAlert ? "nativa" : "osascript")")
        if canAlert {
            let content = UNMutableNotificationContent()
            content.title = "Forge atualizado disponível"
            content.body = body
            content.sound = .default
            center.add(UNNotificationRequest(identifier: "update-\(version)",
                                             content: content, trigger: nil))
        } else {
            postBanner(title: "Forge — atualização disponível", subtitle: "", body: body)
        }
    }

    /// Says how many sessions a previous run left behind, after the boot sweep
    /// ended them.
    ///
    /// This is the visibility half of the leak fix, and it earns its place by
    /// what it would have done: the count was 1, then 5, then 20, then 69 over
    /// eight days, and nothing ever said so — the first signal the operator got
    /// was a machine with 56 MB of RAM free and 27 GB of swap in use. A number
    /// on the second leaked tab makes that a nuisance instead of an outage.
    /// Silent when the sweep found nothing, which is the normal case.
    func announceSweep(sessions: Int) {
        guard sessions > 0 else { return }
        let body = sessions == 1
            ? "1 sessão ficou rodando depois que o app fechou. Encerrada agora."
            : "\(sessions) sessões ficaram rodando depois que o app fechou. Encerradas agora."
        Self.trace("sweep de boot: \(sessions)")
        if canAlert {
            let content = UNMutableNotificationContent()
            content.title = "Forge — sobras da execução anterior"
            content.body = body
            content.sound = .default
            center.add(UNNotificationRequest(identifier: "boot-sweep",
                                             content: content, trigger: nil))
        } else {
            postBanner(title: "Forge — sobras da execução anterior", subtitle: "", body: body)
        }
    }

    /// Forget a gate so a later one with the same id could be announced again.
    func forget(_ id: String) {
        announced.remove(id)
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }
}

extension Notifier: UNUserNotificationCenterDelegate {
    /// Show the banner even when the app is frontmost. The point is answering
    /// without switching windows, and suppressing it while focused would make
    /// the feature look broken exactly when someone is testing it.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let gateID = info["gate"] as? String ?? ""
        let cwd = info["cwd"] as? String ?? ""
        let action = response.actionIdentifier

        Task { @MainActor in
            defer { completionHandler() }
            guard !gateID.isEmpty else { return }

            switch action {
            case UNNotificationDefaultActionIdentifier:
                // Tapping the body opens the app rather than guessing a choice.
                NSApp.activate(ignoringOtherApps: true)
                for w in NSApp.windows where w.canBecomeMain {
                    w.makeKeyAndOrderFront(nil); break
                }
            case UNNotificationDismissActionIdentifier:
                // Dismissing is not answering — the gate stays pending and will
                // still take its default if nobody acts.
                break
            default:
                guard !cwd.isEmpty else { return }
                AppState.shared.answer(gateID: gateID, cwd: cwd, choice: action)
            }
        }
    }
}
