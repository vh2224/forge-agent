// HomeView — the screen with nothing open yet.
//
// WHAT WAS WRONG WITH THE FIRST CUT
// ---------------------------------
// It had seven stacked blocks: mark, headline, composer, mode chips, route bar,
// a paragraph explaining the route bar, the live-run list, and a row of hints.
// ChatGPT and Gemini have two — a greeting and an input — and everything else is
// either inside the input or in the sidebar. The difference is not taste: seven
// blocks means the operator reads the screen before using it, every launch,
// forever, to do the one thing they already came here to do.
//
// Three rules, applied without exception:
//
//   1. STATE LIVES ON THE INPUT'S OWN ROW, never under it. Project, account and
//      route are one line inside the box (`SessionComposer.accessory`), not
//      three stacked bars.
//   2. EXPLANATIONS ARE TOOLTIPS. The paragraph about who picks the engine is
//      the route chip's `.help` now. Teaching text belongs on a surface you meet
//      once; this is the surface you meet most.
//   3. WHAT IS RUNNING BELONGS IN THE SIDEBAR. The live-run list left this
//      screen, where it was visible only when nothing was open, for the sidebar,
//      where it is visible from everywhere.
//
// AND THE MODE STOPPED BEING A QUESTION. The `Conversar | Rodar | Shell` picker
// asked the operator to declare something the text already says: `submit()` has
// always branched on whether the line starts with a slash. The screen now reads
// the line as it is typed and adapts — route read-out for a command, engine
// picker for a question. Less to look at, and more honest: it describes what
// will happen to what you actually typed, not to what you promised to type.

import SwiftUI
import ForgeKit

struct HomeView: View {
    @ObservedObject var state: AppState
    @ObservedObject private var resolver: RouteResolver = .shared
    @ObservedObject private var engines: EngineAvailability = .shared

    /// The chat engine. Local to this screen and not on `AppState`: it steers
    /// nothing but which CLI a conversation starts, and putting it in shared
    /// state would invite a dispatch path to read it — which is exactly the
    /// override `RouteResolver` exists to prevent.
    @AppStorage("chatEngine") private var chatEngine = ForgeEngine.claude.rawValue
    /// Model alias for a conversation. Empty = the CLI's default, which is a
    /// real answer and not a missing one — most of the time it is the right
    /// model and pinning it would only pin it stale.
    @AppStorage("chatModel") private var chatModel = ""

    /// A mirror of what is being typed, so the footer can adapt. Written only by
    /// the composer's `onTextChanged`; nothing here writes back.
    @State private var draft = ""

    /// The composer's own picked project, mirrored via `onProjectChanged`. The
    /// composer keeps this in `@State` and only writes it back to `state` at
    /// submit — without this mirror the route chip would show the workspace of
    /// a session that has not started yet, between picking another project and
    /// pressing Enter.
    @State private var composerProject = ""

    /// What the typed line will actually do — the same test `submit()` applies,
    /// so the footer cannot promise something the submission will not honour.
    private var isCommand: Bool {
        draft.trimmingCharacters(in: .whitespaces).hasPrefix("/")
    }

    /// The unit type a typed slash command dispatches, when it dispatches
    /// exactly one. Per CLAUDE.md the only routable units are `execute-task`
    /// and `plan-slice` — `/forge-task` runs a single task with no
    /// milestone/slice, so it is the one command that maps cleanly.
    /// `/forge-auto` and `/forge-next` run a dispatch loop over many units of
    /// varying type, and `/forge-new-milestone`, `/forge-discuss`,
    /// `/forge-status` and the rest dispatch no routable unit at all — none of
    /// those have a single engine badge to show.
    private var commandUnitType: String? {
        guard let cmd = ComposerParser.split(draft).command else { return nil }
        switch cmd {
        case "forge-task": return "execute-task"
        default: return nil
        }
    }

    private var routeCwd: String? {
        if !composerProject.isEmpty { return composerProject }
        return state.preselection.workspace ?? state.workspaces.first
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            mark
            Text("O que vamos forjar?")
                .font(ForgeType.display)
                .padding(.bottom, 20)
            composer
            starters.padding(.top, 16)
            Spacer()
            // A shade above centre. Optically centred content sits high of the
            // geometric middle, and an input parked at exactly 50% reads as
            // having sunk.
            Color.clear.frame(height: 60)
        }
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 24)
        .background(ForgeBackground(intensity: 1.0))
        .onAppear { resolver.resolve(cwd: routeCwd); engines.probe() }
        .onChange(of: routeCwd) { _ in resolver.resolve(cwd: routeCwd) }
    }

    /// The mark, quiet. Not the launch animation again: an app that replays its
    /// logo every time you close the last tab thinks its brand is more
    /// interesting than your work.
    private var mark: some View {
        Path.forgeAnvil(fitting: CGRect(x: 0, y: 0, width: 30, height: 21))
            .fill(Color.tone(.ember).opacity(0.5))
            .frame(width: 30, height: 21)
            .padding(.bottom, 14)
    }

    private var composer: some View {
        SessionComposer(
            state: state,
            allowsEmptyShell: true,
            placeholder: "Pergunte algo, ou /forge-auto para retomar…",
            editorMaxHeight: 96,
            engine: isCommand ? "claude" : chatEngine,
            model: isCommand ? "" : chatModel,
            quietFooter: true,
            showsKeyHints: false,
            accessory: AnyView(footerControl),
            onTextChanged: { draft = $0 },
            onProjectChanged: { composerProject = $0 })
    }

    /// One control, and which one depends on what is typed.
    ///
    /// A command routes per unit and this reports it; anything else is a
    /// conversation and this chooses. Both occupy the same slot at the same
    /// size, so the row does not reflow under the caret as you type the slash.
    @ViewBuilder private var footerControl: some View {
        if isCommand {
            if commandUnitType != nil { routeChip }
        } else {
            engineMenu
        }
    }

    /// The resolved route, as a read-out. Never a picker — see `RouteResolver`
    /// for why a model picker on a run would be a control that controls nothing.
    @ViewBuilder private var routeChip: some View {
        if let unitType = commandUnitType, let r = resolver.route(cwd: routeCwd, unitType: unitType) {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 9))
                Text(r.forgeEngine.tag).font(ForgeType.monoSmall)
                Text(r.summary).font(ForgeType.caption)
            }
            .foregroundStyle(.tertiary)
            .help("Rota resolvida pelo roteador do Forge, por unidade — \(r.why). "
                  + "Esta tela mostra, não escolhe.")
        } else {
            Text("resolvendo rota…")
                .font(ForgeType.caption).foregroundStyle(.quaternary)
        }
    }

    /// Engine and model in one menu, because they are one decision: "what am I
    /// talking to". Two separate controls would double the chrome to express a
    /// pair that is always chosen together.
    ///
    /// Only Claude offers models here. Not an oversight — `--model` is a Claude
    /// flag, the other CLIs spell it differently, and a picker that emitted an
    /// unrecognised argument would produce a session that dies at the prompt.
    /// When the flag for those is known, this list grows; until then it does not
    /// pretend.
    private var engineMenu: some View {
        Menu {
            ForEach([ForgeEngine.claude, .codex, .agy], id: \.self) { e in
                Button {
                    chatEngine = e.rawValue
                    if e != .claude { chatModel = "" }
                } label: {
                    Text(engines.has(e) ? e.label : "\(e.label) — não instalado")
                }
                .disabled(!engines.has(e))
            }

            if ForgeEngine(chatEngine) == .claude {
                Divider()
                Button("padrão do CLI") { chatModel = "" }
                ForEach(HomeView.claudeModels, id: \.alias) { m in
                    Button(m.label) { chatModel = m.alias }
                }
            }
        } label: {
            HStack(spacing: 4) {
                // No pinned model is a legitimate answer, not a missing one, so
                // it gets a neutral glyph. `ModelFamily.unknown` renders a
                // question mark, which on a control that is working correctly
                // reads as an error the operator has to go and fix.
                Image(systemName: chatModel.isEmpty ? "sparkle" : modelFamily.icon)
                    .font(.system(size: 10))
                Text(engineLabel).font(ForgeType.caption)
            }
            .foregroundStyle(.secondary)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("Com qual CLI e modelo a conversa abre")
    }

    /// The aliases `claude --model` accepts. Aliases and not full ids: the ids
    /// change with every release and the aliases do not, which is the same
    /// reason `forge-model-alias.js` exists on the dispatch side.
    private static let claudeModels: [(alias: String, label: String)] = [
        ("opus",   "Opus — o mais capaz"),
        ("sonnet", "Sonnet — equilibrado"),
        ("haiku",  "Haiku — o mais rápido"),
        ("fable",  "Fable"),
    ]

    /// Drives the menu's glyph, so the control shows WHICH model at a glance
    /// rather than only that a model exists. `ModelFamily` already owns that
    /// mapping for the Modelos screen; reusing it is what keeps the two screens
    /// agreeing about what an Opus looks like.
    private var modelFamily: ModelFamily {
        ForgeEngine(chatEngine) == .claude
            ? (ModelFamily(rawValue: chatModel) ?? .unknown)
            : .unknown
    }

    private var engineLabel: String {
        let e = ForgeEngine(chatEngine)
        guard e == .claude, !chatModel.isEmpty else { return e.label }
        return "Claude \(chatModel.capitalized)"
    }

    // MARK: Starters

    /// What ChatGPT and Gemini put under the input — except these are not sample
    /// prompts, they are the four things an operator opens this app to do.
    ///
    /// They also carry the discovery the deleted hints row was carrying: a chip
    /// fills the line rather than submitting it, so `/forge-auto` is learned by
    /// being used, with the caret already after it. Filling and not firing
    /// matters — three of these four take an argument, and a chip that launched
    /// immediately would launch them empty.
    private var starters: some View {
        HStack(spacing: 7) {
            ForEach(Starter.all, id: \.label) { s in
                Button { state.composerSeed = s.line } label: {
                    Text(s.label)
                        .font(ForgeType.label)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 11).padding(.vertical, 6)
                        .background(Color.forgePanel, in: Capsule())
                        .overlay(Capsule().strokeBorder(Color.forgeEdge.opacity(0.18)))
                }
                .buttonStyle(.plain)
                .help(s.help)
            }
        }
    }

    private struct Starter {
        let label: String
        let line: String
        let help: String

        static let all: [Starter] = [
            .init(label: "Continuar milestone", line: "/forge-auto",
                  help: "Retoma a milestone ativa do projeto de onde ela parou"),
            .init(label: "Uma unidade", line: "/forge-next",
                  help: "Roda só a próxima unidade e para"),
            .init(label: "Nova milestone", line: "/forge-new-milestone ",
                  help: "Brainstorm, escopo, discussão e plano"),
            .init(label: "Task avulsa", line: "/forge-task ",
                  help: "Uma task sem milestone"),
        ]
    }
}
