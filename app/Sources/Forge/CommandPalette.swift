// CommandPalette — ⌘K, and the reason the sidebar could shrink.
//
// Cutting six rows out of the sidebar only works if the things that left are
// still one gesture away. Otherwise it is not a simplification, it is a
// removal, and the operator pays for it every time they want a preference.
//
// So the palette is not a nice-to-have that arrived with the shell — it is the
// half of the shell that makes the other half honest. Everything reachable
// before is reachable here, plus the things that were never reachable from the
// sidebar at all because they are not screens: a project, a live run, a session,
// a layout.
//
// SCORING, NOT FILTERING. A palette that requires a prefix match is a palette
// people stop using on the third miss — "prefs" has to find "Preferências" and
// "quad" has to find "Quadro". Subsequence matching with a position bonus is
// what every editor's fuzzy finder does, and it is thirty lines. The ranking
// itself lives in ForgeKit so it can be asserted without a window.

import SwiftUI
import AppKit
import ForgeKit

// MARK: - Items

struct PaletteItem: Identifiable {
    enum Kind {
        case section, settings, project, run, session, layout, action

        var symbol: String {
            switch self {
            case .section:  return "square.grid.2x2"
            case .settings: return "gearshape"
            case .project:  return "folder"
            case .run:      return "play.circle"
            case .session:  return "terminal"
            case .layout:   return "rectangle.3.group"
            case .action:   return "bolt"
            }
        }

        var label: String {
            switch self {
            case .section:  return "tela"
            case .settings: return "ajustes"
            case .project:  return "projeto"
            case .run:      return "run"
            case .session:  return "sessão"
            case .layout:   return "layout"
            case .action:   return "ação"
            }
        }
    }

    let id: String
    let title: String
    /// Extra words that should match but are not shown as the title — a run's
    /// milestone id, a project's full path. Without them "frontend" would not
    /// find the run whose title is the project name.
    let keywords: String
    let kind: Kind
    let subtitle: String?
    let run: () -> Void

    init(id: String, title: String, kind: Kind, subtitle: String? = nil,
         keywords: String = "", run: @escaping () -> Void) {
        self.id = id; self.title = title; self.kind = kind
        self.subtitle = subtitle; self.keywords = keywords; self.run = run
    }
}

// MARK: - The palette

struct CommandPalette: View {
    @ObservedObject var state: AppState
    @Binding var isPresented: Bool
    @Binding var layoutRaw: String

    @State private var query = ""
    @State private var selected = 0
    @FocusState private var focused: Bool

    private var results: [PaletteItem] {
        let all = items
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else {
            return Array(all.prefix(12))
        }
        return PaletteRanking
            .rank(all.map { ($0.id, "\($0.title) \($0.keywords)") }, query: query)
            .compactMap { id in all.first { $0.id == id } }
    }

    var body: some View {
        VStack(spacing: 0) {
            field
            if !results.isEmpty {
                Divider()
                list
            }
        }
        .frame(width: 560)
        .forgeSurface(.floating)
        .onAppear { focused = true }
        .onChange(of: query) { _ in selected = 0 }
    }

    private var field: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12)).foregroundStyle(.tertiary)
            TextField("Ir para, abrir, rodar…", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .focused($focused)
                .onSubmit { fire() }
            Text("esc")
                .font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        // Arrow keys move the selection. `onMoveCommand` and not a key handler
        // on the field: the field owns the text, and hijacking ↑/↓ there also
        // steals them from the text cursor on a multi-line paste.
        .onMoveCommand { direction in
            guard !results.isEmpty else { return }
            switch direction {
            case .up:   selected = max(0, selected - 1)
            case .down: selected = min(results.count - 1, selected + 1)
            default:    break
            }
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(results.prefix(40).enumerated()), id: \.element.id) { idx, item in
                        row(item, active: idx == selected)
                            .id(item.id)
                            .onTapGesture { selected = idx; fire() }
                    }
                }
            }
            .frame(maxHeight: 340)
            .onChange(of: selected) { _ in
                guard results.indices.contains(selected) else { return }
                proxy.scrollTo(results[selected].id)
            }
        }
    }

    private func row(_ item: PaletteItem, active: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: item.kind.symbol)
                .font(.system(size: 11))
                .foregroundStyle(active ? Color.tone(.ember) : Color.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).font(.system(size: 13))
                if let s = item.subtitle {
                    Text(s).font(.system(size: 10)).foregroundStyle(.tertiary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer()
            Text(item.kind.label)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 5).padding(.vertical, 1.5)
                .background(Color.forgeEdge.opacity(0.14), in: Capsule())
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
        .background(active ? Color.tone(.ember).opacity(0.14) : Color.clear)
        .contentShape(Rectangle())
    }

    private func fire() {
        guard results.indices.contains(selected) else { return }
        let item = results[selected]
        isPresented = false
        query = ""
        item.run()
    }

    // MARK: What is in it

    private var items: [PaletteItem] {
        var out: [PaletteItem] = []

        for s in Section.workCases {
            out.append(PaletteItem(id: "sec:\(s.rawValue)", title: s.title, kind: .section) {
                state.section = s
            })
        }
        for s in Section.allCases where s.isSettings {
            out.append(PaletteItem(id: "set:\(s.rawValue)", title: s.title,
                                   kind: .settings, subtitle: "Ajustes",
                                   keywords: "ajustes settings configuração") {
                SettingsWindow.open(s)
            })
        }
        for l in TerminalLayout.allCases {
            out.append(PaletteItem(id: "lay:\(l.rawValue)", title: "Terminal: \(l.title)",
                                   kind: .layout, subtitle: l.help,
                                   keywords: "layout \(l.rawValue)") {
                state.section = .terminal
                layoutRaw = l.rawValue
            })
        }
        for w in state.workspaces {
            let name = URL(fileURLWithPath: w).lastPathComponent
            out.append(PaletteItem(id: "proj:\(w)", title: name, kind: .project,
                                   subtitle: w, keywords: w) {
                state.section = .projects
                state.rememberWorkspace(w)
            })
        }
        for r in state.liveRuns {
            out.append(PaletteItem(id: "run:\(r.id)", title: r.projectName, kind: .run,
                                   subtitle: r.worker ?? r.id,
                                   keywords: "\(r.id) \(r.worker ?? "")") {
                state.section = .terminal
                state.resume(r)
            })
        }
        for s in state.sessions {
            out.append(PaletteItem(id: "sess:\(s.id.uuidString)", title: s.tabLabel,
                                   kind: .session, subtitle: s.cwd, keywords: s.cwd) {
                state.section = .terminal
                state.focusedSession = s.id
            })
        }
        out.append(PaletteItem(id: "act:new", title: "Nova sessão", kind: .action,
                               keywords: "terminal abrir shell") {
            state.section = .terminal
            state.showComposer = true
        })
        out.append(PaletteItem(id: "act:add", title: "Adicionar projeto…", kind: .action,
                               keywords: "workspace pasta repo") {
            pickWorkspace(state)
        })
        return out
    }
}
