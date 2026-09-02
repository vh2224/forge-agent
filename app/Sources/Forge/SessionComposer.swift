// SessionComposer — the one line that starts work.
//
// Lifted out of the old Início screen when the terminal screen took over
// starting sessions; Início was then deleted, since the composer was the only
// part of it that was not a thinner copy of another screen. The parameters
// that made it host-agnostic are kept deliberately: `allowsEmptyShell` and
// `editorMaxHeight` are what let it be dropped into the floating ⌘T panel and
// the empty pane with different manners, and both call sites are live.

import SwiftUI
import ForgeKit

struct SessionComposer: View {
    @ObservedObject var state: AppState

    /// Enter on an empty line opens a plain shell instead of doing nothing.
    /// The terminal screen wants that; Início does not.
    var allowsEmptyShell: Bool = false
    var placeholder: String = "Pergunte algo, ou digite / para um comando e @ para um projeto"
    /// How tall the input may grow. Início gives it room to draft a paragraph;
    /// the terminal screen is a command line and a tall empty box there reads
    /// as a form to fill in rather than as somewhere to type one word.
    var editorMaxHeight: CGFloat = 150
    /// Called after a session was created, so a host can dismiss itself.
    var onSubmitted: () -> Void = {}
    /// Which CLI a plain question opens. Only the home sets it; every other
    /// call site keeps Claude, which is what they meant before this existed.
    var engine: String = "claude"
    /// Model alias for a conversation. Empty = the CLI's own default.
    var model: String = ""
    /// Hides the context row until the operator asks for it — by focusing the
    /// field, hovering the box, or having something worth saying (a project the
    /// line requires and does not have).
    ///
    /// Claude's and ChatGPT's inputs are one line and a caret. The controls are
    /// still there, they just do not spend attention until you look for them,
    /// and everything they set is also settable by typing (`@project`, `/`).
    /// A row of chips that is right 100% of the time and read 1% of the time is
    /// the definition of chrome.
    var quietFooter: Bool = false
    /// The ↩/⇧↩ legend. On by default; the home turns it off.
    ///
    /// It is teaching text, and teaching text earns its place exactly once — on
    /// a surface the operator meets before they know the app. The home is where
    /// they are AFTER learning it, every single launch, forever.
    var showsKeyHints: Bool = true
    /// An extra control for the footer row, supplied by the host.
    ///
    /// The alternative was a second row under the composer, which is what the
    /// home had: three stacked rows of chrome around one input. A host that
    /// needs one more control should get to put it on the row that already
    /// exists.
    var accessory: AnyView? = nil
    /// Lets a host react to what is being typed — the home uses it to show the
    /// route for a `/command` and the engine picker for a plain question,
    /// instead of asking the operator to pick a mode first.
    var onTextChanged: (String) -> Void = { _ in }

    @State private var text = "" {
        didSet { onTextChanged(text) }
    }
    @State private var commands: [SlashCommand] = []
    @State private var project = ""
    @State private var account = ""
    @State private var highlighted = 0
    /// Laid-out height of the typed text, reported by `PromptEditor`.
    @State private var editorHeight: CGFloat = 20
    @State private var hovering = false

    /// The context row is shown when it can act, or when it must warn.
    ///
    /// `projectMissing` is the "must": a slash command with no project cannot
    /// be sent, and hiding the control that fixes that would turn a disabled
    /// send button into a mystery.
    private var footerShown: Bool {
        guard quietFooter else { return true }
        return focused || hovering || projectMissing || !text.isEmpty
    }
    @FocusState private var focused: Bool

    /// Rows currently offered, as a flat list — the menu shows either commands
    /// or projects, never both, so one index addresses whichever is up.
    private var menuCount: Int { max(matchingCommands.count, matchingProjects.count) }

    private var completion: CompletionContext {
        ComposerParser.context(in: text, caret: text.endIndex)
    }

    private var matchingCommands: [SlashCommand] {
        guard case .command(let q, _) = completion else { return [] }
        return Array(ComposerParser.filter(commands, query: q).prefix(8))
    }

    private var matchingProjects: [String] {
        guard case .project(let q, _) = completion else { return [] }
        return Array(ComposerParser.filterProjects(state.workspaces, query: q).prefix(8))
    }

    private var showingMenu: Bool { !matchingCommands.isEmpty || !matchingProjects.isEmpty }

    /// No implicit fallback. Defaulting to the first workspace meant a line
    /// typed without a project silently ran in whichever one sorted first —
    /// a wrong-repo dispatch that looks exactly like a right one.
    ///
    /// `project` itself may start out preselected via `state.preselection`
    /// (a configured default, or the last-used project) on `.onAppear` — that
    /// is a choice the operator made or a place they already were, never a
    /// guess. `state.workspaces.first` is still never consulted here.
    private var resolvedProject: String { project }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // PromptEditor zeroes the text container insets, so the first
            // glyph sits at the view origin and a plain Text beside it lands on
            // the same line — no baseline guessing, and it holds at any font
            // size. See PromptEditor.swift for why TextEditor could not.
            HStack(alignment: .top, spacing: 9) {
                Text(">")
                    .font(.system(size: 15, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.accentOrange)

                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(placeholder)
                            .font(.system(size: 15))
                            .foregroundStyle(.tertiary)
                            .allowsHitTesting(false)
                    }
                    PromptEditor(
                        text: $text,
                        onKey: { handleKey($0) },
                        onSubmit: { submit() },
                        onHeightChange: { editorHeight = $0 })
                    // One line until there is a second one. `maxHeight` alone
                    // gave the editor no intrinsic size, so SwiftUI handed it
                    // the full allowance and the box opened as a tall empty
                    // rectangle — the single most un-minimal thing on the home.
                    .frame(height: min(max(editorHeight, 20), editorMaxHeight))
                    .onChange(of: text) { _ in highlighted = 0 }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)

                Button { submit() } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 22))
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSubmit ? Color.accentOrange : Color.secondary.opacity(0.35))
                .disabled(!canSubmit)
                .keyboardShortcut(.return, modifiers: .command)
                .help(canSubmit ? "↩ para enviar · ⇧↩ para nova linha"
                                : "Escolha um projeto antes de enviar")
                // Nudge the icon onto the text line: a symbol is taller than
                // the glyphs it sits beside.
                .offset(y: -3)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)

            if showingMenu {
                Divider()
                completionMenu
            }

            if footerShown {
                Divider()
                footerBar
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.14), value: footerShown)
        .background(Color.forgeRaised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(focused ? Color.tone(.ember).opacity(0.45)
                                  : Color.forgeEdge.opacity(0.22), lineWidth: 1))
        .shadow(color: .black.opacity(0.28), radius: 14, y: 5)
        .onAppear {
            if commands.isEmpty { commands = CommandCatalog.load() }
            // Guarded on `project.isEmpty` so a re-appear (e.g. returning from
            // another tab) never overwrites a project the user already chose.
            if project.isEmpty, let w = state.preselection.workspace { project = w }
            // The account row names a real account, so it needs the registry
            // read before it can say anything — the terminal screen is now the
            // landing screen and nothing else was fetching it.
            if state.accounts.isEmpty || state.activeAccount == nil { state.loadAccounts() }
            focused = true
            adoptSeed()
        }
        .onChange(of: state.composerSeed) { _ in adoptSeed() }
    }

    // MARK: Account

    /// The account this session will actually run on.
    ///
    /// "conta padrão" was a label for the ABSENCE of an override, not for an
    /// account — so the one thing the row never told you was which account you
    /// were about to spend. The name comes from `forge-accounts --list --json`
    /// (`env_active ?? active`), which is the same resolution the shell-init
    /// hook performs for a bare `claude`: `env_active` first because a token
    /// already in this process's environment is inherited by the shell it
    /// spawns and outranks the registry default.
    private var accountLabel: String {
        if !account.isEmpty { return account }
        return state.activeAccount ?? "conta padrão"
    }

    /// True when no override is set and the registry could not name a default.
    /// Said in orange rather than shown as a confident "conta padrão": not
    /// knowing which account will be charged is worth one glance.
    private var usingUnknownAccount: Bool {
        account.isEmpty && state.activeAccount == nil
    }

    private var accountHelp: String {
        if !account.isEmpty { return "Escolhida para esta sessão — vai como --account \(account)" }
        guard let a = state.activeAccount else {
            return "Nenhuma conta ativa registrada — o `claude` vai cair no login do Keychain"
        }
        switch state.activeAccountSource {
        case .environment:
            return "\(a) — herdada do ambiente deste app (FORGE_ACCOUNT + token). "
                 + "Vale mesmo que o padrão do forge-accounts seja outro."
        case .registry:
            return "\(a) — conta padrão do forge-accounts"
        case .unknown:
            return a
        }
    }

    // MARK: Where it runs

    /// A `/forge-*` command is meaningless outside a project — that is the
    /// whole of `b992edf`: dispatching one into the wrong directory looks
    /// exactly like dispatching it into the right one. A shell and a plain
    /// conversation carry no project semantics, so they are allowed to open
    /// somewhere that is not a project.
    private var needsProject: Bool {
        ComposerParser.split(text).command != nil
    }

    /// The cwd this submission will use.
    ///
    /// Still no `workspaces.first` guess (b992edf): with no project picked the
    /// only sanctioned non-project directory is the configured session root,
    /// which is what `AppState.resolvedSessionRoot` resolves — never a member
    /// of the registered project list chosen by sort order.
    private var launchDirectory: String {
        resolvedProject.isEmpty ? state.resolvedSessionRoot : resolvedProject
    }

    /// The send button. An empty line is a legal submission where
    /// `allowsEmptyShell` is set — it opens a shell — and only a slash command
    /// makes the project mandatory.
    private var canSubmit: Bool {
        if needsProject && resolvedProject.isEmpty { return false }
        return allowsEmptyShell || !text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Suggestions, styled like the Claude Code menu: name, then what it does.
    private var completionMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(matchingCommands.enumerated()), id: \.element.id) { idx, cmd in
                completionRow(icon: cmd.source == .skill ? "sparkle" : "terminal",
                              title: cmd.slash,
                              subtitle: cmd.description,
                              selected: idx == highlighted) {
                    accept(cmd.slash)
                }
            }
            ForEach(Array(matchingProjects.enumerated()), id: \.element) { idx, path in
                completionRow(icon: "folder",
                              title: "@" + ProjectOrganiser.name(path),
                              subtitle: ProjectOrganiser.abbreviate(
                                path, home: FileManager.default.homeDirectoryForCurrentUser.path),
                              selected: idx == highlighted) {
                    project = path
                    acceptProject(path)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func completionRow(icon: String, title: String, subtitle: String,
                               selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 12))
                    .foregroundStyle(selected ? Color.accentOrange : .secondary)
                    .frame(width: 18, alignment: .center)
                    // An SF Symbol has no text baseline of its own; nudge it
                    // onto the one the labels share.
                    .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
                Text(title)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                if selected {
                    Text("⇥").font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 9)
            .background(selected ? AnyShapeStyle(Color.accentOrange.opacity(0.13))
                                 : AnyShapeStyle(.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Context bar: where this will run, and on which account.
    ///
    /// The project is a real menu as well as an `@` mention. Typing `@` is
    /// faster once you know it exists; a visible list is the only version that
    /// can be found without being told — and this bar is now the first thing
    /// the terminal screen shows.
    private var footerBar: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Menu {
                ForEach(state.workspaces, id: \.self) { ws in
                    Button(ProjectOrganiser.name(ws)) { project = ws }
                }
                if !resolvedProject.isEmpty {
                    Divider()
                    Button("Limpar") { project = "" }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: projectMissing ? "folder.badge.questionmark" : "folder")
                        .font(.system(size: 11))
                    Text(destinationLabel).font(.caption)
                }
                .foregroundStyle(projectMissing ? AnyShapeStyle(Color.accentOrange)
                                                : AnyShapeStyle(.secondary))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help(destinationHelp)

            if let c = ComposerParser.split(text).command {
                Text("· /\(c)").font(.caption).foregroundStyle(Color.accentOrange)
            }

            Spacer()

            Menu {
                Button(state.activeAccount.map { "usar a atual (\($0))" } ?? "conta padrão") {
                    account = ""
                }
                ForEach(state.accounts.filter(\.has_token)) { a in
                    Button(a.name) { account = a.name }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "person.crop.circle").font(.system(size: 11))
                    Text(accountLabel).font(.caption)
                }
                .foregroundStyle(usingUnknownAccount ? AnyShapeStyle(Color.accentOrange)
                                                     : AnyShapeStyle(.secondary))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help(accountHelp)

            if let accessory { accessory }

            if showsKeyHints {
                HStack(spacing: 3) {
                    Text("↩").font(ForgeType.mono)
                    Text(allowsEmptyShell && text.trimmingCharacters(in: .whitespaces).isEmpty
                         ? "abre o shell" : "enviar")
                        .font(ForgeType.caption)
                    Text("·").foregroundStyle(.quaternary)
                    Text("⇧↩").font(ForgeType.mono)
                    Text("nova linha").font(ForgeType.caption)
                }
                .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    /// Orange only when the project is genuinely required and absent. With no
    /// project and no slash command there is nothing missing — the session root
    /// is a real destination, not a gap.
    private var projectMissing: Bool { needsProject && resolvedProject.isEmpty }

    private var destinationLabel: String {
        if !resolvedProject.isEmpty { return ProjectOrganiser.name(resolvedProject) }
        if needsProject { return "escolha um projeto" }
        return ProjectOrganiser.name(state.resolvedSessionRoot)
    }

    private var destinationHelp: String {
        if !resolvedProject.isEmpty { return resolvedProject }
        if needsProject {
            return "Um /comando do Forge precisa de um projeto — escolha aqui ou digite @"
        }
        return "Sem projeto: abre no diretório root configurado — \(state.resolvedSessionRoot)"
    }

    // MARK: Keyboard

    /// Called by the editor before it treats a key as editing. Returning true
    /// consumes it. Scoped to the menu being open, so ordinary typing, caret
    /// movement and newlines behave normally the rest of the time — which a
    /// global event monitor could not promise.
    private func handleKey(_ action: PromptEditor.KeyAction) -> Bool {
        // With the menu open, the keys drive the menu.
        if showingMenu {
            switch action {
            case .up:
                highlighted = max(0, highlighted - 1)
            case .down:
                highlighted = min(menuCount - 1, highlighted + 1)
            case .tab, .enter:
                acceptHighlighted()
            case .shiftEnter:
                return false        // still a newline
            case .escape:
                // End the token rather than clearing the line: what was typed
                // so far is still what the user meant.
                text += " "
            }
            return true
        }

        // Menu closed: Enter sends, Shift+Enter breaks the line. That is the
        // convention in Claude Code and every chat input, and it is why ⌘↩ read
        // as an odd requirement rather than a shortcut.
        if action == .enter {
            submit()
            return true
        }
        return false
    }

    private func acceptHighlighted() {
        if !matchingCommands.isEmpty, highlighted < matchingCommands.count {
            accept(matchingCommands[highlighted].slash)
        } else if !matchingProjects.isEmpty, highlighted < matchingProjects.count {
            let path = matchingProjects[highlighted]
            project = path
            acceptProject(path)
        }
    }

    // MARK: Actions

    private func accept(_ replacement: String) {
        guard case .command(_, let range) = completion else { return }
        let (newText, _) = ComposerParser.complete(text, range: range, with: replacement)
        text = newText
    }

    /// A project mention selects the target and leaves the text clean — it is
    /// context for the session, not part of the prompt.
    private func acceptProject(_ path: String) {
        guard case .project(_, let range) = completion else { return }
        var out = text
        out.replaceSubrange(range, with: "")
        text = out.trimmingCharacters(in: .whitespaces)
    }

    /// Turn the line into a session. A leading slash command is passed through
    /// as-is, so anything Forge gains tomorrow works here without a code change;
    /// plain text opens a conversation; an empty line opens a bare shell where
    /// that is allowed.
    /// Adopts a line handed in from outside and hands the caret back to the
    /// operator. Cleared immediately: a seed left standing would re-apply on the
    /// next redraw and overwrite whatever they typed after it.
    private func adoptSeed() {
        guard let seed = state.composerSeed else { return }
        text = seed
        state.composerSeed = nil
        focused = true
    }

    private func submit() {
        guard canSubmit else { return }
        let line = text.trimmingCharacters(in: .whitespaces)
        let cwd = launchDirectory

        if line.isEmpty {
            guard allowsEmptyShell else { return }
            state.newSession(cwd: cwd, mode: .shell, text: "", account: account)
        } else {
            state.newSessionRaw(cwd: cwd, prompt: line, account: account,
                                engine: engine, model: model)
        }

        // Record where work actually happened, so the next launch preselects
        // it as the last-used default — the second-choice tier in `preselection`.
        // Only a real project: writing the session root here would make the
        // fallback directory look like a project the operator had chosen, and
        // it would then be preselected forever after.
        if !resolvedProject.isEmpty { state.rememberWorkspace(resolvedProject) }
        text = ""
        // newSession* already focused the new session; nothing further to do
        // here. Creating a terminal and leaving the operator on this screen —
        // with only a toast to explain it — was the original complaint.
        onSubmitted()
    }
}
