// SettingsScene — configuration, behind ⌘, where it belongs.
//
// Six of the twelve sidebar rows were configuration: Contas, Modelos, Segredos,
// Preferências, Atualizações, Exemplos. They sat in the same list as the places
// you go to watch work happen, which is what made the sidebar read as a settings
// drawer rather than as navigation. Every app this one is compared to — ChatGPT,
// Claude, Maestri — keeps that list for the user's own material and puts setup
// behind ⌘,. This is that move, and it is what halves the sidebar.
//
// A real `Settings` scene and not a sheet: macOS gives it ⌘, for free, its own
// window that survives the main window closing, the standard toolbar tab strip,
// and a place in the app menu the operator already knows to look. A sheet would
// have had to reimplement all four and would still block the window behind it —
// which matters here, because "check a preference while a run is going" is the
// whole reason someone opens this.

import SwiftUI
import AppKit
import ForgeKit

struct SettingsScene: View {
    @ObservedObject var state: AppState
    @AppStorage("settingsTab") private var tabRaw = Section.prefs.rawValue

    /// Order is deliberate: what you change often first, what you change once
    /// last. `Exemplos` is documentation and sits at the end for that reason.
    private static let tabs: [Section] = [.prefs, .models, .accounts, .secrets, .updates, .examples]

    /// The launch strike. A sound the app makes on its own has to be reachable
    /// from the app — an operator whose only way to silence it is the system
    /// mixer will silence the whole app, and we lose the notification chime too.
    @AppStorage("launchSound") private var launchSound = true

    var body: some View {
        TabView(selection: $tabRaw) {
            ForEach(SettingsScene.tabs) { s in
                pane(for: s)
                    .tabItem { Label(s.title, systemImage: s.icon) }
                    .tag(s.rawValue)
            }
        }
        .frame(minWidth: 720, minHeight: 520)
        .onReceive(NotificationCenter.default.publisher(for: SettingsWindow.selectTab)) { note in
            if let raw = note.object as? String { tabRaw = raw }
        }
    }

    /// The panes are the screens that already existed, unchanged.
    ///
    /// Not rewritten for the new home on purpose: they are working screens with
    /// their own history, and moving a screen and redesigning it in one step is
    /// how you lose the ability to tell which change broke it.
    @ViewBuilder private func pane(for s: Section) -> some View {
        switch s {
        case .accounts: AccountsView(state: state)
        case .models:   ModelsView(state: state)
        case .secrets:  SecretsView(state: state)
        case .prefs:
            VStack(spacing: 0) {
                PrefsView(state: state)
                Divider()
                HStack {
                    Toggle("Som da forja ao abrir", isOn: $launchSound)
                        .toggleStyle(.switch).controlSize(.small)
                    Spacer()
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
            }
        case .updates:  UpdatesView(state: state)
        case .examples: ExamplesView(state: state)
        default:        EmptyView()
        }
    }
}

/// Opening the settings window from code.
///
/// `NSApp.sendAction` and not `@Environment(\.openSettings)`: the callers that
/// need this are not all in a SwiftUI `View` (the sidebar footer is, the app
/// delegate is not), and the environment value is only readable from one of
/// them. The selector is what the menu item itself sends.
enum SettingsWindow {
    static let selectTab = Notification.Name("forge.settings.selectTab")

    static func open(_ tab: Section? = nil) {
        if let tab {
            // On cold start the window (and its sole `.onReceive` observer)
            // does not exist yet, so this post would be dropped and the
            // TabView would open on the persisted `@AppStorage` value instead
            // of the requested tab. Writing the storage key directly covers
            // that path; the notification still covers the already-open case.
            UserDefaults.standard.set(tab.rawValue, forKey: "settingsTab")
            NotificationCenter.default.post(name: selectTab, object: tab.rawValue)
        }
        NSApp.activate(ignoringOtherApps: true)
        // Renamed in macOS 13 (Ventura): "Preferences" became "Settings" and the
        // selector followed. Both are tried because neither is public API and a
        // missing one is a silent no-op, not a crash — the failure mode being
        // "⌘, works but this button does nothing", which is worse than loud.
        if !NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil) {
            NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
    }
}
