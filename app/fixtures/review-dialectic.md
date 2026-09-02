# S01: Higiene do repositório e chão de testes do app — Review (Dialectic)
**Slice:** S01  **Milestone:** M-20260902054027-app-macos-ui-recovery  **Reviewed:** 2026-09-02  **Rounds:** 1
**Outcome:** 3 resolved · 11 conceded · 1 open
**Challenger:** codex (default do CLI)
**Defender:** claude-fable-5 (fable)
**Pairing:** explícito — autor claude → challenger codex (cross-family)
**Escopo do diff:** `git diff 240ff67..HEAD` — base declarada pelo `S01-PLAN.md § Acceptance`, não o `merge-base` com `master` (que arrasta 39 arquivos de `scripts/`/`shared/`/`skills/` do PR #165, alheios a esta slice). 33 arquivos, 5.367 linhas, 6 shards de challenger.

## Abertas — requerem decisão humana
> O reviewer e o autor não chegaram a acordo. Você decide.

### R8 — `app/Sources/Forge/RouteResolver.swift:96`
- **Objeção:** O preview sempre resolve um `execute-task` nu usando só o cwd. Nunca recebe o unit type real do comando, o plano, a milestone, o roadmap ou o unit id — então a rota mostrada pode divergir da rota que o dispatch de fato toma (overrides de tier/worker no frontmatter são invisíveis para ele). — _Para uma task cujo `T##-PLAN.md` carrega override de tier no frontmatter, a rota do preview bate com a que o dispatch resolve?_
- **Defesa:** O reviewer tem razão que overrides de `--plan` são invisíveis a um resolve cwd-only, e o texto de ajuda ("por unidade") promete mais do que o chip mostra. Contraponto: o read-out fica embaixo de `/forge-auto`/`/forge-next`, que despacham várias unidades cujos planos ainda nem existem — não há um plano único para passar adiante; um preview por-plano só é bem-definido para um `execute-task` isolado. A saída é rotular como default do cwd ou aceitar o chip como aproximação intencional — decisão de produto.
- **Réplica:** maintained — a defesa admite que o preview omite o frontmatter por-plano e pode divergir do dispatch real; o rótulo atual segue prometendo mais do que entrega.
- **Decisão:** deferido → triagem no fim da milestone (gate `G-20260902161342-1606` aberto, ninguém respondeu na janela desta chamada — `wait-timeout`, não é decisão)

## Concedidas — problema real, corrigido

### R2 — `app/Sources/Forge/LaunchCurtain.swift:621`
- **Objeção:** `finish(animated:)` seta `finished` antes de começar a animação de saída; a linha 115 (`.opacity(finished ? 0 : 1)`) apaga a cortina no mesmo frame, então o scale/fade de `exiting` nunca é visto e a janela fica em branco ~300ms em toda conclusão e todo skip.
- **Defesa:** conceded — `finished = true` está fora de qualquer `withAnimation`; RootView (Views.swift:205-215) mantém o shell em `.opacity(entered ? 1 : 0)` até `onFinished` disparar 300ms depois. Tirar o `.opacity(finished)` externo (ou setar `finished` dentro do completion do `asyncAfter`) faz `exiting` carregar a saída.
- **Correção:** aplicada — commit c3a7344

### R3 — `app/Sources/Forge/PromptEditor.swift:75`
- **Objeção:** O report de altura só roda em criação, update de estado SwiftUI e mudança de texto. Redimensionar a janela muda a largura de wrap sem mexer no texto, e o layout do AppKit sozinho não chama `textDidChange` — `editorHeight` fica medido para a largura antiga.
- **Defesa:** conceded — `reportHeight` só sai de `makeNSView`, `updateNSView` e `textDidChange`; o report de altura é novo neste diff, então o caso nasce aqui. Observar `NSView.frameDidChangeNotification` (ou sobrescrever `layout`) e chamar `reportHeight`; o guard de 0.5pt já evita loop.
- **Correção:** aplicada — commit c3a7344

### R5 — `app/Sources/Forge/BoardView.swift:321`
- **Objeção:** Locais de drag de fio são lidos no espaço de coordenadas externo `boardCanvas`, mas nós e fios são desenhados em coordenadas de canvas depois de `scaleEffect` e `offset`. Com pan/zoom, o endpoint do drag e o hit-test do drop caem no nó errado ou em nada.
- **Defesa:** conceded — e pior que "depois de dar pan": `sync` chama `board.fit(in:)` no primeiro appear, então `pan` já nasce diferente de zero e o hit-test está errado quase sempre. Fix: `(loc - pan) / scale` antes de guardar `wireTip` e antes de `node(at:)`.
- **Correção:** aplicada — commit c3a7344

### R6 — `app/Sources/Forge/BoardView.swift:225`
- **Objeção:** A seleção de fase do nó ignora `session.runId` e pega o primeiro run vivo que compartilhe o cwd. Com duas milestones ativas no mesmo workspace, todo nó daquele workspace mostra a mesma fase.
- **Defesa:** conceded — o modelo já carrega `runId` exatamente para isso (`Stores.swift:617-621`, e `Stores.swift:821` já casa `runId == run.id && cwd == run.cwd`). Casar por `run.id == session.runId` primeiro, cair para cwd só quando `runId` for nil. Mesmo padrão em `Cockpit.swift:149`.
- **Correção:** aplicada — commit c3a7344

### R7 — `app/Sources/Forge/BoardView.swift:91`
- **Objeção:** Refresh de rota só em `onAppear` e mudança de contagem de sessões. Um dispatch feito por sessão já aberta não muda a contagem e `RouteStore` não tem timer nem notificação — o badge de engine/tier envelhece até fechar e reabrir o board.
- **Defesa:** conceded — `routes.refresh` só é chamado em BoardView.swift:90-91 (e Cockpit.swift:135-136, 358-359). Fix mais barato coerente com o throttle do store: refresh também no sinal que o run store já publica (mudança de run/fase).
- **Correção:** aplicada — commit c3a7344

### R9 — `app/Sources/Forge/RouteResolver.swift:110`
- **Objeção:** `invalidate()` nunca é ligado ao save de preferências, embora o cache seja documentado como invalidado quando as prefs mudam. Depois de salvar prefs de routing, a rota cacheada antiga continua sendo servida.
- **Defesa:** conceded — `invalidate()` tem zero call sites; `PrefsView.save()` (Prefs.swift:155-176) escreve o arquivo e chama `load()` sem tocar em `RouteResolver`. O doc-comment do resolver (87-90) justifica o cache por-lançamento com a premissa de que a tela de prefs invalida — premissa não cumprida. Fix: `RouteResolver.shared.invalidate()` depois da escrita bem-sucedida em `save()`.
- **Correção:** aplicada — commit c3a7344

### R11 — `app/Sources/Forge/SettingsScene.swift:86`
- **Objeção:** Escolher um destino de Settings pelo command palette pode abrir a aba padrão em vez da pedida. `open(_:)` posta `selectTab` e só então abre a janela; se a janela ainda não existe, a notificação não tem observer e é descartada.
- **Defesa:** conceded — o único observer é o `.onReceive` dentro de `SettingsScene.body` (linha 40), que não existe antes da janela. Fix de uma linha: como a aba é `@AppStorage`, escrever `UserDefaults.standard.set(tab.rawValue, forKey: "settingsTab")` antes de abrir (mantendo o post para o caso já-aberto).
- **Correção:** aplicada — commit c3a7344

### R12 — `app/Sources/Forge/Stores.swift:690`
- **Objeção:** Conversas não-Claude são registradas como usando a conta Claude selecionada, mesmo com a construção do comando omitindo `--account` de propósito quando o engine não é Claude. O metadado persistido atribui trabalho de Codex/Gemini a uma conta Claude.
- **Defesa:** conceded — `newSessionRaw` segura `--account` corretamente (676-677), mas o `TerminalSession` em 688-690 é construído com `account: account.isEmpty ? nil : account` independentemente do engine. Esse campo é renderizado no header do painel (Cockpit.swift:234, TerminalsView.swift:516/558) e contado por conta (Views.swift:1183). Fix: `account: effective == "claude" && !account.isEmpty ? account : nil`.
- **Correção:** aplicada — commit c3a7344

### R13 — `app/Sources/Forge/TerminalSession.swift:240`
- **Objeção:** `submit: false` só segura a newline final adicional; newlines já contidas em `text` são repassadas. Uma seleção multi-linha normal do terminal executa todas as linhas menos a última — exatamente a execução acidental que a flag existe para evitar.
- **Defesa:** conceded — o único caller é `WirePanel.send` (BoardView.swift:436-438), que só faz trim nas pontas. Uma seleção de duas linhas executa a primeira no alvo — precisamente o "um encaminhamento ruim vira dois agentes na coisa errada" que o doc-comment em 230-233 diz que o default previne. Fix: envolver em bracketed paste (`\u{1b}[200~ … \u{1b}[201~`) quando `submit` é false.
- **Correção:** aplicada — commit c3a7344

### R14 — `app/Sources/Forge/HomeView.swift:72`
- **Objeção:** O read-out de rota é resolvido para `preselection.workspace` (ou o primeiro workspace), mas `SessionComposer` guarda o projeto escolhido privadamente e pode apontar para outro cwd. O usuário vê a rota de um workspace diferente daquele onde a sessão vai de fato começar.
- **Defesa:** conceded — `SessionComposer` mantém o projeto em `@State private var project` (SessionComposer.swift:63) e só devolve via `state.rememberWorkspace` no submit (linha 498). Entre escolher `@outro-projeto` e apertar Enter, o chip mostra a rota do workspace pré-selecionado. Fix: expor o `resolvedProject` do composer (um `onProjectChanged` ao lado do `onTextChanged` existente) e alimentar o `resolver.resolve`.
- **Correção:** aplicada — commit c3a7344

### R15 — `app/Sources/Forge/HomeView.swift:126`
- **Objeção:** Todo slash command é exibido com `RouteResolver.route(cwd:)`, cujo unit type default é `execute-task`, embora rotas sejam intencionalmente dependentes do unit type. `/forge-new-milestone` aparece com o engine de execute-task.
- **Defesa:** conceded — `RouteResolver.key` existe justamente porque unit types resolvem para tiers diferentes (RouteResolver.swift:72-74). Pelo CLAUDE.md as unidades roteáveis são `execute-task` e `plan-slice`; `/forge-new-milestone`, `/forge-discuss`, `/forge-status` não despacham nenhuma das duas. Fix: mapear slash command → unit type e esconder o chip para comandos sem unit type único.
- **Correção:** aplicada — commit c3a7344

## Resolvidas no debate — sem ação
- R1 `app/Sources/Forge/LaunchCurtain.swift:111` — o autor recompilou o arquivo à força (`touch` + `swift build --target Forge`) e o build fecha limpo: em Darwin 64-bit `CGFloat` é typealias de `Double`, então não há conversão faltando. Reviewer retirou.
- R4 `app/Sources/Forge/Cockpit.swift:91` — o corte de 12 sessões vive no dono, onde o doc-comment diz que vive: `TerminalsView.swift:50-52` (`wallApplies = … count <= 12`) e `terminalsPane` (280-290) só constrói `SessionWall` quando `wallApplies`. O `default: 4` de `columns(for:)` nunca é alcançado com n > 12. Reviewer retirou.
- R10 `app/Sources/Forge/RouteResolver.swift:171` — metade da objeção era factualmente errada (nada é persistido: `installed`/`probed` são in-memory num singleton de vida-de-processo); a outra metade é default deliberado num cockpit cujo bootstrap sempre começa por `claude`. Reviewer retirou.
