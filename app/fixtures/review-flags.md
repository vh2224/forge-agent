# S03: Sistema visual nas cinco telas restantes — Review (Flags)
**Slice:** S03  **Milestone:** M-20260902054027-app-macos-ui-recovery  **Reviewed:** 2026-09-02  **Rounds:** 0
**Outcome:** 0 resolved · 0 conceded · 1 open
**Challenger:** codex (default do CLI)
**Defender:** — (não despachado)
**Style:** `flags` — resolvido pela política determinística de custo (`adaptive-normal-diff`, 7 arquivos / 270 linhas, `risk:medium`), não por configuração. Uma passada de challenger, **sem defesa e sem réplica**.
**Escopo do diff:** `git diff 25bf293..HEAD -- app/` — base = HEAD no fecho de S02. 6 arquivos, 161 inserções, 1 shard.

## Abertas — requerem decisão humana

### R1 — `app/Sources/Forge/Views.swift:1202` — **[low]**
- **Objeção:** `forgeSurface(.raised)` passou a desenhar preenchimento e hairline com
  `SurfaceLevel.raised.cornerRadius` (**10**), mas os overlays retidos por cima ainda usam raio
  chumbado. Quando a borda aparece (conta recomendada, gate presente), borda e superfície deixam de
  compartilhar perímetro e os cantos ficam visivelmente desencontrados.
- **Ação sugerida:** usar `SurfaceLevel.raised.cornerRadius` em cada overlay retido, ou passar o mesmo
  `RoundedRectangle` explícito para `forgeSurface` onde o componente precisar manter o raio anterior.
- **Medição do orquestrador (fato, não veredito):** confirmado por leitura direta — três sítios, todos
  com o overlay imediatamente após o `.forgeSurface(.raised)`:
  - `Views.swift:598-600` — ProjectCard, `cornerRadius: 12` sobre superfície de 10
  - `Views.swift:723-725` — GateCard, `cornerRadius: 12` sobre superfície de 10
  - `Views.swift:1202-1204` — AccountCard, `cornerRadius: 14` sobre superfície de 10
  (`SurfaceLevel.cornerRadius`: ground 0 · panel 8 · raised 10 · floating 16, `Palette.swift:240-247`.)
- **Decisão:** deferido → triagem no fim da milestone (gate `G-20260902175157-9c1c` aberto, ninguém respondeu na janela desta chamada — `wait-timeout`, não é decisão)

## Nota sobre o que esta rodada NÃO é

Isto é uma passada `flags`, **não** um review dialético: nenhum advogado foi ouvido, então nada aqui
foi refutado nem concedido — a única classificação honesta para a objeção é `open`. A verificação
factual acima é medição do orquestrador sobre o código, não um veredito no lugar de um agente.

O `S03-PLAN.md` já havia declarado "raios de canto" entre os 7 itens UNVERIFIED para o UAT; esta
objeção é mais específica que aquele item e nomeia as três linhas.

Continuam UNVERIFIED (exigem tela, e o challenger também não tinha uma): peso semibold do micro,
glifos absorvidos, stroke/brilho dos cards, cápsulas, opacidade do HUD e legibilidade geral.
