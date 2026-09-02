// ForgeApp — desktop app for watching and steering Forge runs.
//
// A second front-end over the same files: the terminal stays first-class and
// nothing here is required for Forge to work. The app reads .gsd/ artefacts and
// delegates every mutation to the engines in scripts/ (see ForgeCore).
//
// WHY A WINDOWED APP AND NOT MENU-BAR-ONLY
// ----------------------------------------
// The first cut was MenuBarExtra + LSUIElement. It was invisible on a notched
// Mac: the NSStatusItem was created correctly — non-nil, isVisible, alpha 1.0 —
// and landed at x=634 on a 1512pt display with safeAreaInsets.top=32, i.e. dead
// behind the notch. macOS stacks status items right-to-left and exposes no API
// to choose a slot, so a menu-bar-only design silently disappears whenever the
// user's bar is full. The Dock icon and its badge cannot be hidden that way.

import SwiftUI
import AppKit

@main
struct ForgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state = AppState.shared

    var body: some Scene {
        WindowGroup("Forge") {
            RootView(state: state)
        }
        .defaultSize(width: 820, height: 620)

        // ⌘, for free, its own window, and a place in the app menu — see
        // `SettingsScene` for why this is a scene and not a sheet.
        Settings {
            SettingsScene(state: state)
        }

        .commands {
            CommandGroup(after: .newItem) {
                Button("Atualizar") { state.reloadCheap(); state.loadAccounts(); state.loadAppDefaults() }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Adicionar projeto…") { pickWorkspace(state) }
                    .keyboardShortcut("o", modifiers: .command)
            }
            // Terminal zoom. SwiftTerm ships zoomIn/zoomOut/zoomReset as empty
            // stubs, so these shortcuts are the feature, not a binding to one.
            // Disabled with no session open on purpose: the setting would
            // still be stored, but pressing ⌘= and seeing nothing change reads
            // as a broken shortcut rather than as a saved preference.
            CommandGroup(after: .toolbar) {
                Button("Aumentar texto do terminal") { TerminalViewStore.shared.zoomIn() }
                    .keyboardShortcut("=", modifiers: .command)
                    .disabled(state.sessions.isEmpty || !TerminalViewStore.shared.canZoomIn)
                Button("Diminuir texto do terminal") { TerminalViewStore.shared.zoomOut() }
                    .keyboardShortcut("-", modifiers: .command)
                    .disabled(state.sessions.isEmpty || !TerminalViewStore.shared.canZoomOut)
                Button("Tamanho padrão do terminal") { TerminalViewStore.shared.zoomReset() }
                    .keyboardShortcut("0", modifiers: .command)
                    .disabled(state.sessions.isEmpty)
                Divider()
            }
            // Session navigation. The tab tooltip promised ⌘T long before any
            // binding existed — a promise the menu bar now keeps.
            CommandMenu("Sessão") {
                Button("Nova sessão") {
                    state.section = .terminal
                    state.showComposer = true
                }
                .keyboardShortcut("t", modifiers: .command)

                Button("Nova sessão avançada…") {
                    state.section = .terminal
                    state.showComposer = false
                    state.showLauncherSheet = true
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])

                // ⌘W closes the SESSION, as in every terminal app. Disabled
                // with none open so the standard Close Window is still
                // reachable — trapping the operator in a window they cannot
                // close would be a worse bug than a missing shortcut.
                Button("Encerrar sessão") { state.closeVisibleSession() }
                    .keyboardShortcut("w", modifiers: .command)
                    .disabled(state.sessions.isEmpty)

                Divider()

                Button("Buscar no terminal") {
                    TerminalViewStore.shared.showFindBar(for: state.visibleSession?.id)
                }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(state.sessions.isEmpty)

                Divider()

                Button("Próxima sessão") { state.cycleSession(by: 1) }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                    .disabled(state.sessions.count < 2)
                Button("Sessão anterior") { state.cycleSession(by: -1) }
                    .keyboardShortcut("[", modifiers: [.command, .shift])
                    .disabled(state.sessions.count < 2)

                // ⌘1…⌘9, built from the live tab list so the menu names the
                // session each digit actually goes to.
                Divider()
                ForEach(Array(state.sessions.prefix(9).enumerated()), id: \.element.id) { idx, s in
                    Button(s.tabLabel) { state.focusSession(at: idx) }
                        .keyboardShortcut(KeyEquivalent(Character("\(idx + 1)")), modifiers: .command)
                }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var observer: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installStatusItem()
        refreshBadge()
        Notifier.shared.start()
        // One network check per launch — a release does not land twice in an
        // afternoon, and a timer here would be pure noise.
        UpdateStore.shared.checkOnLaunch()
        observer = NotificationCenter.default.addObserver(
            forName: AppState.didChange, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshBadge() }
        }
    }

    /// Embedded terminals are child processes of Forge, but NOT in the sense
    /// that word usually carries. This comment used to say "quitting the app
    /// kills every session with it", and that was FALSE: `forkpty(3)` calls
    /// `setsid()` in the child, so each shell is a session leader with its own
    /// controlling terminal and the kernel propagates nothing to it when Forge
    /// dies. Sessions — and every `next dev` started inside them — went on
    /// running after the quit, reparented to launchd with PPID 1, while the
    /// alert below promised the opposite. The comment sustained the bug.
    ///
    /// What makes it true is this method doing it explicitly: before the app
    /// goes away it snapshots the descendant tree of every terminal the
    /// registry owns and signals it. Forge itself is resumable from disk, so no
    /// work is lost — but a unit can be cut off mid-dispatch, so this must never
    /// happen silently.
    ///
    /// EXACTLY ONE `reply`, and only from `finishTerminating()`. Every path that
    /// returns `.terminateLater` converges there:
    /// - no session marked running (no alert shown) — the scan still runs, since
    ///   `isRunning` only means "the shell exited" and says nothing about what
    ///   the shell left behind;
    /// - alert confirmed;
    /// - nothing to signal (empty registry, or a snapshot that came back empty)
    ///   — `execute` returns immediately;
    /// - the grace ceiling was reached and SIGKILL was sent — `execute` returns
    ///   after it; it has no throwing path and no early exit that skips the
    ///   continuation.
    /// The only branch that does not reply is cancelling the alert, which
    /// returns `.terminateCancel` and therefore never promised one. This matters
    /// more than it looks: a `.terminateLater` with no reply leaves the app
    /// impossible to quit — a worse failure than the one being fixed.
    @MainActor
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Governs the ALERT only. It must not gate the reap: see above.
        let live = AppState.shared.sessions.filter(\.isRunning)
        if !live.isEmpty {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = live.count == 1
                ? "1 sessão ainda está rodando"
                : "\(live.count) sessões ainda estão rodando"
            alert.informativeText = """
            Sair encerra \(live.count == 1 ? "essa sessão" : "essas sessões") — \
            \(live.map(\.tabLabel).joined(separator: ", ")) — e também os processos \
            iniciados dentro \(live.count == 1 ? "dela" : "delas"), como servidores \
            de desenvolvimento em segundo plano.

            O trabalho não se perde: o Forge guarda o estado em disco e você retoma \
            com "Continuar milestone". Mas a unidade em andamento é interrompida.
            """
            alert.addButton(withTitle: "Sair mesmo assim")
            alert.addButton(withTitle: "Cancelar")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else {
                UpdateStore.shared.cancelRelaunch()
                return .terminateCancel
            }
        }

        // Planned here, on the main actor, and BEFORE anything is torn down: the
        // registry is main-actor state, and a tree snapshotted after teardown
        // reads as empty.
        let targets = ProcessReaper.plan(roots: TerminalViewStore.shared.shellPidsOfLiveTerminals())
        Task.detached(priority: .utility) {
            await ProcessReaper.execute(targets: targets)
            await MainActor.run { AppDelegate.finishTerminating() }
        }
        return .terminateLater
    }

    /// The last thing that happens before the process goes away, and the only
    /// place the replacement instance is started: doing it in `relaunch()` meant
    /// that cancelling this alert left the new copy already running alongside
    /// the old one.
    ///
    /// The relaunch stays AFTER the reap and immediately before the reply. It
    /// costs the update path whatever the reap cost — milliseconds in the
    /// cooperative case (12.8 ms measured), the 2s ceiling only against a
    /// process that refuses to leave. The alternative, launching first, would
    /// have the new instance running while the old one is still sending SIGKILL
    /// to a tree, which is a worse thing to be true than a slower relaunch.
    @MainActor
    private static func finishTerminating() {
        if UpdateStore.shared.relaunchPending { UpdateStore.shared.launchNewInstance() }
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    /// Clicking the Dock icon after closing the window should bring it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            for w in sender.windows where w.canBecomeMain {
                w.makeKeyAndOrderFront(nil)
                return true
            }
        }
        return true
    }

    /// The notch-proof signal: a count on the Dock icon that says "Forge is
    /// waiting on you" without needing any menu bar real estate.
    @MainActor
    private func refreshBadge() {
        let n = AppState.shared.pending.count
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
        statusItem?.button?.title = n > 0 ? " \(n)" : ""
    }

    /// Best-effort. On a crowded menu bar this may never be drawn — which is
    /// exactly why it is not the primary surface.
    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage.forgeAnvilTemplate(size: 16)
        item.button?.imagePosition = .imageLeading
        item.button?.target = self
        item.button?.action = #selector(openWindow)
        statusItem = item
    }

    @objc private func openWindow() {
        NSApp.activate(ignoringOtherApps: true)
        for w in NSApp.windows where w.canBecomeMain {
            w.makeKeyAndOrderFront(nil)
            return
        }
    }
}
