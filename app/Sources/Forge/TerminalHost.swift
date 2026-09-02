// TerminalHost — the SwiftUI ↔ AppKit bridge, and nothing else.
//
// Backed by SwiftTerm's LocalProcessTerminalView (subclassed as
// ForgeTerminalView), which owns the PTY and the VT emulation. Claude Code
// repaints continuously (alternate screen, cursor addressing, 256 colours), so
// nothing less than a real emulator renders it correctly — a partial ANSI
// parser yields a garbled screen, not a plain one.

import SwiftUI
import AppKit
import SwiftTerm
import ForgeKit

struct TerminalHost: NSViewRepresentable {
    @ObservedObject var session: TerminalSession
    /// Observed so a zoom change re-runs `updateNSView` for the visible tab.
    /// The off-screen ones are reached by the store directly.
    @ObservedObject var terminals: TerminalViewStore = .shared

    func makeCoordinator() -> Coordinator {
        TerminalViewStore.shared.instance(for: session).coordinator
    }

    func makeNSView(context: Context) -> ForgeTerminalView {
        let store = TerminalViewStore.shared
        // Never build a terminal here: the session may already own a live one,
        // and rebuilding it is what killed sessions on navigation. The registry
        // decides; this only displays.
        let instance = store.instance(for: session)
        let view = instance.view

        // The same NSView can be handed to a second host (navigating back
        // builds a new one before the old is gone). AppKit would otherwise
        // move it while it is still installed in the previous hierarchy.
        view.removeFromSuperview()

        TerminalHost.applyTheme(view)
        view.applyFontSize(store.fontSize)

        if let boot = session.bootstrap, store.claimBootstrap(for: session.id) {
            store.sendBootstrap(boot, to: view)
        }
        return view
    }

    func updateNSView(_ nsView: ForgeTerminalView, context: Context) {
        TerminalHost.applyTheme(nsView)
        // Idempotent inside `applyFontSize`. It has to be: SwiftTerm's font
        // setter calls `selectNone()`, so re-assigning the same font on every
        // rebuild would clear the operator's selection mid-copy.
        nsView.applyFontSize(terminals.fontSize)
    }

    /// Deliberately empty. Losing the view is not losing the session — only
    /// `AppState.closeSession` ends a process. Terminating here is exactly the
    /// bug this file was rewritten to remove.
    static func dismantleNSView(_ nsView: ForgeTerminalView, coordinator: Coordinator) {
        _ = TerminalLifecycle.action(for: .viewDismantled)   // .keepAlive
    }

    /// Ground and text only. The 16 ANSI colours are installed once per session
    /// in `TerminalViewStore.make(for:)` — `installColors` rebuilds the whole
    /// 256-entry palette and invalidates every cached run, so calling it from
    /// here (which runs on every SwiftUI rebuild) would repaint the screen for
    /// nothing. Both halves come from `ForgeTerminalPalette` so they cannot
    /// drift apart.
    ///
    /// The font is NOT set here — it is a setting, owned by
    /// `TerminalViewStore`, and applying it from two places is how the two
    /// would disagree.
    static func applyTheme(_ view: ForgeTerminalView) {
        view.nativeBackgroundColor = ForgeTerminalPalette.background
        view.nativeForegroundColor = ForgeTerminalPalette.foreground
    }

    @MainActor
    final class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
        let session: TerminalSession

        init(session: TerminalSession) { self.session = session }

        // The bootstrap guard used to live here, as a per-instance flag. That
        // was the replay bug: coordinators are per-view, so a fresh one on
        // navigation re-armed it. It now lives in TerminalViewStore, keyed by
        // session id — do not bring it back here.

        func processTerminated(source: TerminalView, exitCode: Int32?) {
            session.isRunning = false
            session.exitLabel = exitCode.map { $0 == 0 ? "encerrado" : "saiu com código \($0)" }
                ?? "encerrado"
        }

        func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    }
}
