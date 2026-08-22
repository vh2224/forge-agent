// Updates — installed version, what is available, and the release notes.
//
// Everything comes from the repo the app already resolves for its engines: the
// git tag for the version, `git ls-remote` for what upstream has, CHANGELOG.md
// for the notes. No server, no embedded copy that could drift.
//
// Updating shells out to install.sh rather than reimplementing it. That script
// backs up, re-merges hooks, probes models and re-runs shell-init; a second
// implementation here would be wrong within a release.

import SwiftUI
import ForgeKit

@MainActor
final class UpdateStore: ObservableObject {
    static let shared = UpdateStore()
    private static let canonicalRemote = "https://github.com/vh2224/forge-agent.git"

    @Published private(set) var installed: String?
    @Published private(set) var latest: String?

    /// The version of the binary THIS PROCESS is, stamped into the bundle at
    /// build time by `app/build.sh` (D25). Never re-read: it cannot change while
    /// the process lives, which is the whole point of it.
    ///
    /// `nil` means "not stamped", and the sentinel is the ABSENCE of the key —
    /// `VersionFooter.stamped` owns that decision and documents why it is not a
    /// comparison against `0.1.0`. Two ways to legitimately land here: a bundle
    /// built before the stamping existed, and `swift run Forge`, where there is
    /// no bundle at all and `infoDictionary` is an empty dictionary.
    private(set) var running: String? = VersionFooter.stamped(
        Bundle.main.object(forInfoDictionaryKey: "ForgeGitDescribe") as? String)

    /// The repo's describe, FULL — no `--abbrev=0`, unlike `installed`.
    ///
    /// The two are not interchangeable and neither replaces the other:
    /// `installed` is a tag, compared semantically against the remote's tag to
    /// decide whether an update exists; this one carries the commit count and the
    /// sha, which is the only way "you committed but did not rebuild" is
    /// detectable at all (comparing abbreviated tags says "in sync" across six
    /// commits).
    @Published private(set) var repoDescribe: String?
    @Published private(set) var releases: [Release] = []

    #if DEBUG
    /// True only for stores built by `staged(...)` (canvas previews). `load()`
    /// no-ops on them (R7): without this, `UpdatesView.onAppear` would overwrite
    /// the staged `installed`/`repoDescribe`/`releases` with live git/CHANGELOG
    /// data on the one machine that has a canvas AND `ForgeCore.repoPath`
    /// configured — the developer's — silently clobbering fixtures like
    /// `previewLongReleases` that exist specifically to show a state real data
    /// would never produce. Production stores are never staged, so `load()`
    /// behaves exactly as before for them.
    private(set) var isStagedPreview = false
    #endif
    @Published private(set) var checking = false
    @Published private(set) var checkedAt: Date?
    @Published private(set) var lastError: String?
    @Published var updating = false

    /// Versions already announced, so a check that runs again does not
    /// re-notify the same release. Persisted: an update stays available for
    /// days, and being told once a launch is nagging.
    @AppStorage("announcedUpdate") private var announced = ""

    /// True only when upstream is strictly ahead. Comparison is semantic, so
    /// v2.11.0 is correctly newer than v2.9.0.
    var updateAvailable: Bool {
        guard let latest, let installed else { return false }
        return Version.isNewer(latest, than: installed)
    }

    /// The release the user does not have yet, for the "what's new" callout.
    var pendingRelease: Release? {
        guard let installed else { return nil }
        return releases.first { !$0.isUnreleased && Version.isNewer($0.version, than: installed) }
    }

    private var repo: String? { ForgeCore.repoPath }

    func load() {
        #if DEBUG
        guard !isStagedPreview else { return }
        #endif
        guard let repo else {
            lastError = "repo do Forge não encontrado nas preferências"
            return
        }
        installed = git(["describe", "--tags", "--abbrev=0"], at: repo)
        repoDescribe = git(["describe", "--tags"], at: repo)
        if let text = try? String(contentsOfFile: "\(repo)/CHANGELOG.md", encoding: .utf8) {
            releases = ChangelogParser.parse(text)
        }
    }

    /// Ask the remote what the newest tag is. Network-bound, so never automatic
    /// on a timer — the statusline already does its own throttled check.
    func check() {
        guard !checking else { return }
        checking = true
        lastError = nil
        Task.detached(priority: .utility) {
            // Resolve tags from the canonical server without reading or
            // refreshing refs in whatever local clone the app happens to know.
            let refs = Self.git(["ls-remote", "--tags", Self.canonicalRemote])
            let tag = RemoteRelease.latestTag(from: refs)
            await MainActor.run {
                self.latest = tag?.trimmingCharacters(in: .whitespacesAndNewlines)
                self.checking = false
                self.checkedAt = Date()
                self.load()
                if self.latest == nil { self.lastError = "não consegui ler as tags do remoto" }
                self.announceIfNew()
            }
        }
    }

    /// Current installer step, in Portuguese, or nil when nothing is running.
    @Published private(set) var phase: String?

    /// Raw installer output, capped: this is a log to glance at, not a transcript
    /// to keep. The tail is what explains a failure.
    @Published private(set) var log: [String] = []

    /// Legacy diagnostic fields retained for UI/state compatibility. Remote
    /// updates do not inspect or mutate the local repository.
    @Published private(set) var blockedMessage: String?
    @Published private(set) var blockedCommand: String?

    /// Run the installer headless, streaming its output. The ONE execution path
    /// behind both `runUpdate()` and `runReinstall()` — the two differ only in
    /// the source mode `InstallerCommand` composes, so duplicating this body
    /// would let them drift apart in behaviour
    /// nobody is watching.
    ///
    /// No Terminal window: under `--update` the installer cannot ask anything.
    /// Its four interactive reads are all behind `if ! $UPDATE && [ -t 0 ]` — a
    /// double guard — and neither install.sh nor app/build.sh calls `sudo`, so a
    /// headless run has nothing to block on. What the Terminal really provided
    /// was visible progress, and that is now this app's own job.
    ///
    /// The command itself — and why `--with-app` is mandatory here, and why the
    /// reinstall mode never pulls — lives in `InstallerCommand` in ForgeKit,
    /// where it is unit-tested. This function does not compose shell strings.
    private func runInstaller(mode: InstallerCommand.Mode) {
        guard let repo else {
            // Reachable since v3.2.0: "Reinstalar" renders even with no version
            // resolved, so a click with no stored repo used to do nothing at all
            // — no bar, no error.
            lastError = "não encontrei o repo do Forge nas preferências"
            return
        }
        blockedMessage = nil
        blockedCommand = nil

        updating = true
        phase = "preparando"
        log = []
        lastError = nil
        needsRelaunch = false

        let cmd = InstallerCommand.build(repo: repo, mode: mode, nodePath: ForgeCore.nodePath)
        var tracker = InstallerPhaseTracker()

        let process = ForgeCore.stream(cwd: repo, command: cmd, onLine: { line in
            MainActor.assumeIsolated {
                let store = UpdateStore.shared
                switch tracker.consume(line) {
                case .phase(let p):    store.phase = InstallerLabels.label(for: p)
                case .finished(let l): store.phase = l
                case .detail:          break
                }
                store.appendLog(line)
            }
        }, onExit: { code in
            MainActor.assumeIsolated { UpdateStore.shared.finishUpdate(exitCode: code) }
        })

        // `Process.run()` can throw before `onExit` ever fires — e.g. the
        // stored repo directory has vanished, so `currentDirectoryURL` is
        // invalid. Without this, `updating` stays true forever: a permanent
        // spinner and a disabled "Atualizar" button with no way out.
        guard process != nil else {
            updating = false
            phase = nil
            lastError = "não consegui iniciar o instalador (o diretório do repo existe?)"
            return
        }
    }

    /// Pull the newest release and install it, app included.
    func runUpdate() { runInstaller(mode: .update) }

    /// Reinstall from the repo exactly as it is on disk — no git, no network.
    func runReinstall() { runInstaller(mode: .reinstall) }

    /// The installer is gone; the exit code decides everything.
    ///
    /// Separate from `runUpdate()` on purpose. `needsRelaunch` is set HERE and
    /// nowhere else: the old code set it as soon as a Terminal had been opened,
    /// so the button showed up while the build was still running and clicking it
    /// killed the installer. Replacing the bundle does not replace the running
    /// process, so the affordance is real — just not before this point.
    private func finishUpdate(exitCode: Int32) {
        updating = false
        if UpdateOutcome.canRelaunch(exitCode: exitCode) {
            // `repoDescribe` (and `installed`) are still whatever `load()` last
            // saw, so without this refresh the still-running old process would
            // keep comparing its `running` stamp against a stale `repoDescribe`
            // and read "in sync" at the exact moment the running-vs-repo
            // divergence becomes real (R6) — the reason the footer exists (D25).
            //
            // KNOWN GAP, named rather than implied: since `.update` stopped
            // pulling, a remote update does not move this clone at all, so
            // `installed` (a `git describe` of the clone) no longer describes
            // what was installed — it describes the clone. After a successful
            // server update `updateAvailable` therefore stays true until the
            // operator pulls by hand. The honest source is the Forge home's
            // `manifest.json § version`, which the app does not read today.
            load()
            needsRelaunch = true
        } else {
            lastError = UpdateOutcome.failureMessage(exitCode: exitCode, lastLines: log)
        }
    }

    private func appendLog(_ line: String) {
        log.append(line)
        if log.count > 500 { log.removeFirst(log.count - 500) }
    }

    /// Set once an update has FINISHED successfully — the new bundle is on disk
    /// but this process is still the old one.
    @Published var needsRelaunch = false

    /// True between asking to relaunch and actually terminating, so the quit
    /// handler knows to start the new copy.
    @Published private(set) var relaunchPending = false

    /// Ask to relaunch. The new copy is NOT started here: `terminate(nil)` runs
    /// `applicationShouldTerminate`, which may still be cancelled — starting it
    /// first would leave two instances behind a cancelled alert.
    func relaunch() {
        relaunchPending = true
        NSApplication.shared.terminate(nil)
    }

    /// Called when the live-session alert is cancelled: the user explicitly
    /// declined to quit, so a later ordinary Quit must not relaunch on their
    /// behalf. Without this, `relaunchPending` stayed true forever after a
    /// single cancel.
    func cancelRelaunch() {
        relaunchPending = false
    }

    /// Start the replacement instance. Called by `applicationShouldTerminate`
    /// once the quit is certain. `open -n` starts the new copy before this one
    /// exits, so the user never faces an empty screen.
    func launchNewInstance() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-n", Bundle.main.bundlePath]
        try? p.run()
    }

    /// Announce a newly available version once. Uses the same notifier as
    /// gates, so it follows whatever path actually works on this machine.
    private func announceIfNew() {
        guard updateAvailable, let latest, latest != announced else { return }
        announced = latest
        let headline = pendingRelease?.headline
        Notifier.shared.announceUpdate(version: latest, headline: headline)
    }

    /// Check once per launch, in the background. Never on a timer: it hits the
    /// network, and a release does not appear twice in an afternoon.
    func checkOnLaunch() {
        guard checkedAt == nil else { return }
        load()
        check()
    }

    private func git(_ args: [String], at path: String) -> String? { Self.git(args, at: path) }

    nonisolated private static func git(_ args: [String], at path: String? = nil) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = path.map { ["-C", $0] + args } ?? args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do {
            try p.run()
            let d = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            guard p.terminationStatus == 0 else { return nil }
            let s = String(data: d, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (s?.isEmpty ?? true) ? nil : s
        } catch { return nil }
    }
}

// MARK: - View

struct UpdatesView: View {
    @StateObject private var store: UpdateStore
    @ObservedObject var state: AppState

    /// Folded by default: the phase label is the answer, the log is the appeal.
    @State private var logExpanded = false

    /// The release list is short at rest (D30) and expands in place. The cut is
    /// the historical tail only — `ReleaseWindow` pins the installed version, the
    /// available one and anything unreleased, so nothing the operator needs can
    /// fall behind the control.
    @State private var showAllReleases = false

    /// The store is injectable so a canvas preview can stage the states this
    /// screen has — up to date, update available, installing, relaunch pending,
    /// blocked. None of them is reachable through the singleton: every field
    /// that selects a state is `@Published private(set)`, and the real ones are
    /// only set by git and by the installer.
    ///
    /// Production passes nothing and gets `.shared`, so the running app still
    /// has exactly one store, held for the view's lifetime exactly as before.
    ///
    /// `nil` rather than `store: UpdateStore = .shared`: a default argument
    /// expression is evaluated in a nonisolated context, and `shared` is
    /// main-actor-isolated, which costs a concurrency warning. Resolving it
    /// inside `StateObject`'s main-actor autoclosure puts the reference back
    /// exactly where the property initializer had it — hence no new warning.
    init(state: AppState, store: UpdateStore? = nil) {
        self.state = state
        _store = StateObject(wrappedValue: store ?? UpdateStore.shared)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                versionCard
                if let msg = store.blockedMessage { blockedCard(msg) }
                if store.updating || !store.log.isEmpty { progressCard }
                if let err = store.lastError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
                ForEach(releaseWindow.visible) { r in
                    ReleaseCard(release: r, installed: store.installed)
                }
                showMoreControl
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Atualizações")
        .onAppear { store.load() }
        .toolbar {
            ToolbarItem {
                Button { store.check() } label: {
                    if store.checking { ProgressView().controlSize(.small) }
                    else { Label("Verificar", systemImage: "arrow.clockwise") }
                }
                .disabled(store.checking)
                .help("Consulta as tags do repositório remoto")
            }
        }
    }

    /// Which release notes are on screen (D30).
    ///
    /// Every rule lives in `ReleaseWindow` in ForgeKit, which is testable; this
    /// property is only the wiring. It replaced a twelve-item prefix that cut the list
    /// by position with no notion of which cards must not be cut — with a short
    /// list that becomes visible, which is why the limit is a NAMED constant and
    /// not a literal here: the number `5` was never validated against a live
    /// list, so it has to be changeable in one place.
    private var releaseWindow: ReleaseWindow.Window {
        ReleaseWindow.visible(releases: store.releases,
                              installed: store.installed,
                              latest: store.latest,
                              limit: showAllReleases ? .max : ReleaseWindow.restingLimit)
    }

    /// Reveals the tail in place. Absent when there is no tail — a control that
    /// says "show more 0" is worse than no control.
    @ViewBuilder private var showMoreControl: some View {
        let hidden = releaseWindow.hiddenCount
        if hidden > 0 || showAllReleases {
            Button(hidden > 0 ? ReleaseWindow.moreLabel(hiddenCount: hidden)
                              : ReleaseWindow.lessLabel) {
                withAnimation(.easeInOut(duration: 0.15)) { showAllReleases.toggle() }
            }
            .buttonStyle(.plain)
            .controlSize(.small)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    /// The icon column this card used to open with — a filled disc with a glyph
    /// centred in it — is gone (D28). It was the single largest piece of
    /// decoration on the screen and it carried no information the card did not
    /// already state twice: the headline says "Atualização disponível: vX" in
    /// words, and the orange `strokeBorder` below already exercises the file's
    /// visual rule 1 (orange = needs you) at the card's own boundary.
    ///
    /// The action slot is untouched, deliberately: its three states and the
    /// "Atualizar" + "Reinstalar" coexistence were bought with a review
    /// objection in a sibling task and are not this subtraction's business.
    private var versionCard: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                if store.updateAvailable, let latest = store.latest {
                    Text("Atualização disponível: \(latest)").font(.headline)
                    Text("Instalada: \(store.installed ?? "—")")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(store.installed ?? "versão desconhecida").font(.headline)
                    Text(store.checkedAt == nil
                         ? "Verifique para saber se há algo novo."
                         : "Você está na versão mais recente.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            // Relaunch wins the slot: once the installer has run, the useful
            // action is no longer "update" — it is picking up what was installed.
            if store.needsRelaunch {
                VStack(alignment: .trailing, spacing: 3) {
                    Button("Reabrir na nova versão") { store.relaunch() }
                        .controlSize(.large)
                    // Text, not a confirmation: terminate(nil) already raises the
                    // live-session alert in applicationShouldTerminate, and asking
                    // twice for the same thing is worse than asking once.
                    Text(relaunchCaption)
                        .font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                // Both can render together on purpose: Atualizar installs the
                // pinned server release, while Reinstalar reapplies this local
                // checkout for dogfood. needsRelaunch still wins the whole slot.
                VStack(alignment: .trailing, spacing: 6) {
                    if store.updateAvailable {
                        Button("Atualizar") { store.runUpdate() }
                            .controlSize(.large)
                            .disabled(store.updating)
                            .help("Baixa a release estável do servidor e atualiza o Forge e o app")
                    }
                    Button("Reinstalar") { store.runReinstall() }
                        .controlSize(.small)
                        .disabled(store.updating)
                        .help("Reaplica explicitamente esta cópia local, sem git pull, "
                              + "e recompila o app")
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(store.updateAvailable ? Color.accentOrange.opacity(0.4) : .clear))
    }

    /// What the relaunch actually costs, said before it happens: the live
    /// sessions it ends, and — when this bundle is not the one that was just
    /// installed — which copy will reopen.
    private var relaunchCaption: String {
        var parts = ["esta janela ainda roda o binário antigo"]
        let live = state.sessions.filter(\.isRunning).count
        if live > 0 {
            parts.append(live == 1 ? "1 sessão em execução será encerrada"
                                   : "\(live) sessões em execução serão encerradas")
        }
        if let note = RelaunchTarget.divergenceNote(for: Bundle.main.bundlePath) {
            parts.append(note)
        }
        return parts.joined(separator: " · ")
    }

    /// Progress while the installer runs — and after, since the log is the only
    /// place a failure explains itself.
    ///
    /// Deliberately built from views this file already renders (ProgressView,
    /// Text, the ReleaseCard chevrons): app/build.sh does `rm -rf
    /// /Applications/Forge.app` mid-update, so anything loaded lazily during that
    /// window can fail to load at all.
    private var progressCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if store.updating { ProgressView().controlSize(.small) }
                else {
                    Image(systemName: store.lastError == nil
                          ? "checkmark.circle" : "exclamationmark.triangle")
                        .foregroundStyle(store.lastError == nil ? .secondary : Color.accentOrange)
                }
                // No percentage: the swift build alone dominates wall clock, so
                // any number here would be invented.
                Text(store.phase ?? "preparando").font(.callout)
                Spacer()
            }

            Button {
                withAnimation(.easeInOut(duration: 0.15)) { logExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: logExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9)).foregroundStyle(.tertiary)
                    Text("Saída do instalador (\(store.log.count) linhas)")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if logExpanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(store.log.suffix(200).enumerated()), id: \.offset) { _, l in
                            Text(l)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .frame(height: 220)
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    /// The refusal to start, and why it is protection rather than a limitation.
    private func blockedCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(Color.accentOrange)
                Text("A atualização não começou").font(.headline)
                Spacer()
            }
            Text(message).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let cmd = store.blockedCommand {
                Text(cmd).font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                Button("Copiar comando") { state.copyToPasteboard(cmd, label: "comando") }
                    .controlSize(.small)
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct ReleaseCard: View {
    let release: Release
    let installed: String?
    @State private var expanded: Bool

    init(release: Release, installed: String?) {
        self.release = release
        self.installed = installed
        // Open the newest entry and anything the user does not have yet; older
        // releases start folded so the page is scannable.
        let isNew = installed.map { Version.isNewer(release.version, than: $0) } ?? false
        _expanded = State(initialValue: release.isUnreleased || isNew)
    }

    private var isInstalled: Bool { release.version == installed }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9)).foregroundStyle(.tertiary)
                    Text(release.version).font(.headline)
                    if isInstalled {
                        Text("instalada").font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                    if release.isUnreleased {
                        Text("não lançada").font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Color.accentOrange.opacity(0.18), in: Capsule())
                            .foregroundStyle(Color.accentOrange)
                    }
                    Spacer()
                    Text("\(release.entryCount)")
                        .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let h = release.headline, !h.isEmpty {
                Text(h).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if expanded {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(release.sections) { section in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                Image(systemName: section.kind.icon)
                                    .font(.caption2)
                                    .foregroundStyle(section.kind.tint)
                                Text(section.kind.label.uppercased())
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(section.kind.tint)
                                Text("\(section.entries.count)")
                                    .font(.system(size: 9)).monospacedDigit()
                                    .foregroundStyle(.tertiary)
                                Spacer()
                            }
                            ForEach(Array(section.entries.enumerated()), id: \.offset) { _, entry in
                                ChangelogEntryView(entry: entry, tint: section.kind.tint)
                            }
                        }
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

extension ReleaseSection.Kind {
    /// Only corrections and security get colour. A changelog where every
    /// section is tinted is a changelog where nothing stands out — and a fix is
    /// the entry most likely to explain something you already hit.
    var tint: Color {
        switch self {
        case .fixed:    return .orange
        case .security: return .red
        default:        return .secondary
        }
    }
}

/// One bullet, rendered as markdown.
///
/// These notes are written as "**Lead sentence.** the detail", so the lead is
/// pulled out and given weight — in a list of thirty entries that is the
/// difference between scanning and reading everything.
struct ChangelogEntryView: View {
    let entry: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(tint.opacity(0.5))
                .frame(width: 4, height: 4).padding(.top, 6)

            VStack(alignment: .leading, spacing: 2) {
                if let split = entry.changelogLead {
                    Text(split.lead)
                        .font(.caption).bold()
                        .fixedSize(horizontal: false, vertical: true)
                    if !split.rest.isEmpty {
                        Text(markdown(split.rest))
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text(markdown(entry))
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
    }

    /// Inline markdown only — `code` and **bold**. Failing over to the raw
    /// string keeps a malformed entry readable instead of blank.
    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}

// MARK: - Preview staging

#if DEBUG
extension UpdateStore {
    /// A detached store with its fields set, for canvas previews only.
    ///
    /// It lives in THIS file on purpose: the fields that select a state are
    /// `@Published private(set)`, and `private` in Swift reaches the enclosing
    /// declaration and its extensions *in the same file*. A factory anywhere
    /// else would have forced those setters open for production callers too —
    /// a permanent cost paid for a preview-only need.
    ///
    /// `UpdateStore()` does no work (no git, no network, no timer), so a second
    /// instance is inert; `shared` stays the only store the app itself uses.
    static func staged(installed: String? = "v3.3.0",
                       latest: String? = nil,
                       releases: [Release] = [],
                       checkedAt: Date? = Date(),
                       updating: Bool = false,
                       phase: String? = nil,
                       log: [String] = [],
                       blockedMessage: String? = nil,
                       blockedCommand: String? = nil,
                       lastError: String? = nil,
                       needsRelaunch: Bool = false,
                       running: String? = nil,
                       repoDescribe: String? = nil) -> UpdateStore {
        let s = UpdateStore()
        s.isStagedPreview = true
        s.installed = installed
        s.running = running
        s.repoDescribe = repoDescribe
        s.latest = latest
        s.releases = releases
        s.checkedAt = checkedAt
        s.updating = updating
        s.phase = phase
        s.log = log
        s.blockedMessage = blockedMessage
        s.blockedCommand = blockedCommand
        s.lastError = lastError
        s.needsRelaunch = needsRelaunch
        return s
    }
}
#endif
