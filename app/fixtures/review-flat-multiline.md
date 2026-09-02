# S02: Defeitos conhecidos — marca, bandas, pan e Métricas — Review (Dialectic)
**Slice:** S02  **Milestone:** M-20260902054027-app-macos-ui-recovery  **Reviewed:** 2026-09-02  **Rounds:** 1
**Outcome:** 2 resolved · 0 conceded · 0 open
**Challenger:** codex (default do CLI)
**Defender:** claude-fable-5 (fable)
**Pairing:** explícito — autor claude → challenger codex (cross-family)
**Escopo do diff:** `git diff c3a7344..HEAD -- app/` — base = HEAD no fecho de S01. 7 arquivos, 810 inserções, 1 shard.

## Resolvidas no debate — sem ação

- R1 `app/Sources/Forge/LaunchCurtain.swift:373` — **[critical]** alegava que o alvo não compila:
  `.offset(y:)` sobre `Path` apagaria a interface `Shape` e o `.fill(...)` seguinte cairia num
  `some View`. O autor mediu em vez de argumentar — `touch` + `swift build --product Forge` →
  `Build of product 'Forge' complete!`, zero erros — e nomeou a causa do engano: `Shape.offset(x:y:)`
  devolve `OffsetShape<Self>`, que ainda é `Shape`; a erosão para `some View` é de `View.offset`, que
  a resolução de sobrecarga não escolhe com receptor `Path`. Reviewer retirou.

- R2 `app/Sources/Forge/MetricsView.swift:282` — alegava que os dois `BarMark` sem eixo categórico
  compartilhado seriam barras independentes, com o output podendo sobrepor o input. O autor mediu por
  **render offscreen** (`ImageRenderer` sobre o chart exato do diff, amostrando pixels): com o
  `stacking: .standard` default a barra é contígua e a fronteira de cor cai exatamente em
  `input/total` — 50/50 → x97/x103, 20/80 → x37/x43, 80/20 → x157/x163. O controle explícito com
  `.unstacked` reproduziu justamente a sobreposição temida, provando que o default é o caminho
  empilhado. Reviewer retirou.

## Nota sobre o que esta rodada NÃO cobre

As duas objeções eram decidíveis por medição e foram medidas. O que continua **UNVERIFIED** em S02 —
e está declarado nos SUMMARYs das tasks e vai para o `S02-UAT.md` — é o que exige tela: sentido do
scroll no trackpad, rolagem do terminal sob o cursor, clique/drag/pinch no grid com o catcher
instalado, feel do clamp de pan, e a aparência final das bandas e do collar no martelo. Ausência de
objeção sobre esses pontos não é aprovação deles: o reviewer também não tinha tela.
