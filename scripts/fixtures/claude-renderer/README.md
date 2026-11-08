# Claude renderer golden fixtures

`claude-4.18.1.golden.json` and `claude-4.19.0.golden.json` are historical snapshots. Preserve their bytes; a current-source change does not rewrite history. The 4.19.0 file SHA256 is `f2b3e910445d2557f50aa4ced9e1b31498debc6b1cdd1ed05b452d8141b4307f`, pinned by both current renderer acceptance consumers.

`claude-memory-v2.golden.json` is the active canonical-source baseline after the accepted S03/T04 memory-v2 changes, reviewed instruction reconciliation in #254, and planning correction in #203. It is a separate fixture, not a claim that historical 4.19.0 emitted current source. All nine surface identities/targets and five surface hashes equal 4.19.0. The changed surfaces are `agents`, `skills`, `dispatch-templates`, and `claude-instructions`. Prior audited sources are `agents/forge-memory.md`, `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`, `skills/forge-memories/SKILL.md`, and `CLAUDE.md`; the additional planning sources are listed below.

Expected hashes are fixed reviewed values. The tests render current sources, group artifacts by source_id, sort by source with localeCompare, normalize only `version=MAJOR.MINOR.PATCH` to `version=<dynamic>`, join each source and content with NUL separators, and compare SHA256 against the stored baseline. They do not regenerate expected values from the renderer under test. Origin-marker/newline behavior and all other renderer assertions remain in force.

The scoped #203 planning follow-up updates `agents`, `skills`, and `dispatch-templates`
for `agents/forge-planner.md`, `skills/forge-new-milestone/SKILL.md`, and
`shared/templates/dispatch/plan-milestone.md`: milestone
planning no longer requires 4–10 slices. Historical snapshots and the other six
active surface hashes stay unchanged relative to the #254 baseline. The historical-to-current surface set is
`agents`, `skills`, `dispatch-templates`, and `claude-instructions`.

The source-guard test separately retains the older skills-only repin comparison within historical data, checks that the historical-to-current change is exactly agents, skills, dispatch-templates, and claude-instructions, and compares current rendered output against all nine active hashes. Future intentional source changes need a scoped reviewed baseline update; drift remains a failure.

The #268 fresh-task creation correction updates only the active `skills` hash for
`skills/forge-task/SKILL.md`; the other eight active hashes and all historical
snapshots remain unchanged. It removes unrelated personal selection and legacy
migration from explicit fresh creation, preserving explicit resume and isolation.

The S02 communication update (M-20261028132636-experiencia, S02/T05) changes only
the active `skills` and `claude-instructions` hashes. Its sources are
`skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`,
`skills/forge-task/SKILL.md` and `skills/forge-status/SKILL.md` (pointer to
`shared/forge-communication.md`, human relay line and message templates), plus
`CLAUDE.md`, re-synced by `forge-instructions.js` so its managed block carries the
communication contract. Both hashes were measured through the render path with
the assertion formula above, before and after the edits: the other seven active
hashes and all historical snapshots stay unchanged, and the historical-to-current
surface set asserted by `forge-dispatch-source-guard.test.js` is still `agents`,
`skills`, `dispatch-templates`, `claude-instructions`, and `configuration`.

The S03 agent-identity update (M-20261028132636-experiencia, S03/T07) changes only
the active `skills` hash, from
`62926097a5d24d2d1b637900971324425930bb8d1f437422812ab8cdb8d16e99` to
`de4f137d05d37fbee993ba3adfc4a11372ea1c972f158cceddc5ae7e8ce02981`. Its sources are
`skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` and
`skills/forge-task/SKILL.md` (per-attempt native dispatch id, human task name,
host-returned agent identity ordered by the owner's protected windows, and the
Codex read-only guard around the plan-checker and read-only native units), plus
`skills/forge-status/SKILL.md` (personal agent view) and
`skills/forge-config/SKILL.md` (explicit `subagents on|off`). The value before was
measured at revision `06f7d5a` and the value after on the final skill bytes, both
through the render path with the assertion formula above. The other eight active
hashes and all historical snapshots stay unchanged; the historical-to-current
surface set is still `agents`, `skills`, `dispatch-templates`,
`claude-instructions`, and `configuration`.

The S03 review R1 correction uses the executable flow's `unit_type`/`unit_id`
in forge-auto and forge-next and fails closed on missing Codex identity. A scoped
before/after measurement retained all 248 dispatch registry entries, classifications,
and emitter/builder counts; only the two single-unit emitter windows changed.
Only the active `skills` surface changed from
`de4f137d05d37fbee993ba3adfc4a11372ea1c972f158cceddc5ae7e8ce02981` to
`28410c1f6ac4bf55ec693e379bc76328e77277bbfb9676f2b6f5fe564d7e37b7`.
The other eight active surfaces and historical golden bytes remain unchanged.

## S04/T03 remeasurement (2026-10-30)

Measured before and after with forge-claude-renderer.render, sorting artifacts by source,
joining source + NUL + content (version normalized to <dynamic>) with NUL, then SHA-256,
exactly as forge-claude-renderer.test.js. Sources changed: skills/forge-discuss/SKILL.md
and the managed forge:interaction block of CLAUDE.md (shared/forge-interaction.md).

- skills: `28410c1f6ac4bf55ec693e379bc76328e77277bbfb9676f2b6f5fe564d7e37b7` to `0ba4bf99be2a459df9aee5fa657e35c94d8c05e7c0cb093c37173f24c5b618cd`.
- claude-instructions: `f2c7e2e5c25e0815a41e05c91d840c48c5c00da8903f83bee1db319c5075ec8a` to `7997a0ef19dcd6479b90fc48eaa732cd12a7337d54c6332ac11c6c6ddb257ffb`.

The other seven active surfaces and immutable Claude 4.19.0 golden remain unchanged.
The historical-to-current changed surface set remains agents, skills, dispatch-templates,
claude-instructions and configuration. Distribution does not establish host UI or human acceptance.

The continued #203 proportional-planning correction updates only the active agents
hash from914b8f44b6448ab2f5fb6d15dc4b33ab1582de74105270ffc3bff47207b85dd2
to437d3c709908bb6d3babdfbb237e320847a65737edaaa54ca77ae8ccf7dbe662 for
agents/forge-planner.md. All eight other active surface hashes and every historical
snapshot stay unchanged. Mandatory planning guidance is consolidated within the
existing context ceiling; optional budgets and allocation assertions are unchanged.

## Bounded personal summary (T-20261101004951-comunicacao-pessoal)

Measured before and after through forge-claude-renderer.render with the assertion
formula above. The before values equal the owner's pre-edit measurement at revision
`4cb0e8d`; the after values are the render-path hashes reported by
forge-claude-renderer.test.js on the final source bytes. The drift set reported by
forge-dispatch-source-guard.test.js before the update was exactly `commands`,
`skills` and `claude-instructions`. Sources changed: `commands/forge.md` (boot and
REPL use `forge-personal-context.js --summary`), `commands/forge-init.md` (new
project template), `skills/forge-status/SKILL.md` (one sentence routing simple
questions to the summary) and `CLAUDE.md`, whose managed block carries the updated
`renderPersonalContract()` and the new “Consulta simples” section of
`shared/forge-communication.md`.

- commands: `e6507d881dc3125e96864a293832ca88d7ee65c233b0508efae4e01c68cfcaad` to `76a9f2a7e6fb02bec917bc24c669d02aacc06a92c1470de9245bdb00d4f8d4d3`.
- skills: `75e3baa5d47466212359e6e022ed3a76781256b3b99d75c0eb6d83d9d30a6727` to `86b0ff8995ff391cc26191662a67f1a726b9dcec6b1a4ed7f98a91ad8decf0f9`.
- claude-instructions: `7997a0ef19dcd6479b90fc48eaa732cd12a7337d54c6332ac11c6c6ddb257ffb` to `90e7c3511e37a7ec6cd972c59572b4aeda2294621c0a7bce8d34aa3b935f6dbb`.

The other six active surfaces (`agents`, `dispatch-templates`, `hooks`, `mcp`,
`claude-settings`, `configuration`) are unchanged, and the historical 4.18.1
(`a58a005aea70eaa17c0ecfaf1cdf8965cdf9adb8c2678e756ac83ea74d926d9c`) and 4.19.0
(`f2b3e910445d2557f50aa4ced9e1b31498debc6b1cdd1ed05b452d8141b4307f`) files stay
byte-identical. The historical-to-current changed surface set is now `agents`,
`commands`, `skills`, `dispatch-templates`, `claude-instructions` and
`configuration`. Distribution does not establish host UI, model obedience or human acceptance.

2026-11-01 — integração comunicação/painel: somente a superfície commands mudou nesta composição, para documentar adesão, bootstrap, perfil padrão e resultados separados do forge-update. Hash medido pelo renderer canônico com versão normalizada; golden ativo atualizado. Baselines históricos permanecem intactos.

## Tempo de milestone (M-20261101111759-opcoes-prazo-milestones, S01/T07)

Medido antes e depois por forge-claude-renderer.render com a fórmula acima, como
forge-claude-renderer.test.js. O valor anterior é a medição do owner antes da edição
na revisão `6fc732e` (os nove hashes ativos conferiam); o novo é o hash do caminho de
render reportado por forge-claude-renderer.test.js sobre os bytes finais. O conjunto
de deriva reportado por forge-dispatch-source-guard.test.js antes da atualização foi
exatamente `skills`. Fontes alteradas: `skills/forge-auto/SKILL.md` e
`skills/forge-next/SKILL.md` (seção “Tempo da milestone”: ponteiro para
`shared/forge-milestone-time.md`, presença, admissão nativa, decisões atestadas,
esperas e modelos de aviso, teto, drain e checkpoint, mais ponteiros junto às chamadas
nativas) e `skills/forge-status/SKILL.md` (uma frase de repasse verbatim do bloco de
tempo). O motivo é distribuir o contrato de tempo aos dois hosts.

- skills: `86b0ff8995ff391cc26191662a67f1a726b9dcec6b1a4ed7f98a91ad8decf0f9` to `9c4e882a828d6546e30e51aa3330817bee74391cd5395047eaee56a8b3490b01`.

Os outros oito hashes ativos (`agents`, `commands`, `dispatch-templates`, `hooks`,
`mcp`, `claude-instructions`, `claude-settings`, `configuration`) não mudaram, e os
arquivos históricos 4.18.1 (`a58a005aea70eaa17c0ecfaf1cdf8965cdf9adb8c2678e756ac83ea74d926d9c`)
e 4.19.0 (`f2b3e910445d2557f50aa4ced9e1b31498debc6b1cdd1ed05b452d8141b4307f`) ficam
byte a byte iguais. Distribuição não prova interceptação de chamada bruta do host,
obediência do modelo nem aceite humano.

## Milestone time options (S02/T07, 2026-11-03)

Measured through forge-claude-renderer.render with the exact normalized-dynamic
SHA-256 formula documented above. Immutable owner pre-T07 capture: revision
`0ee8dfdd9ffa0a4ca6dfafe928991a9125f6d573`, `scripts/fixtures/milestone-options/distribution-before.json`
(SHA-256 `93fc65fb11e0b59104721da9281d9ac64ac789a2c8cbf19495fe46a8186cc8ff`).
Sources: agents/forge-planner.md, agents/forge-worker.md, skills/forge-auto/SKILL.md,
skills/forge-next/SKILL.md, skills/forge-new-milestone/SKILL.md, skills/forge-help/SKILL.md
and shared/templates/dispatch/plan-slice.md. T05 already changed dispatch-templates
and T04 changed configuration via effort.estimate-milestone before T07. These are
intentional dependency changes; their old failed pin checks remain historical.

- agents: `437d3c709908bb6d3babdfbb237e320847a65737edaaa54ca77ae8ccf7dbe662` to `64bbdc40320fe629f19c9e0ceb50256f03544d9d9b0385d416f1563b2abbd41a`.
- skills: `9c4e882a828d6546e30e51aa3330817bee74391cd5395047eaee56a8b3490b01` to `3de92437ec378fa298349b408d1d3bf809ed95e35dcdaad0b9e54f24ef3f5000`.
- dispatch-templates: `1d3003f9c370209188049ffa9f5377346990d3070341fe3f81ab26e641a54103` to `a304207c44a93bf68aa9fd220a888533d223c33a2ceea7e283154ef316f2a58e`.
- configuration: `e8aa7391a8a71f70600274de8f7d49e19e1ea2206ee014b6504be4936b655271` to `c76a23d540a2602293ba45f8821419aa00d738eb08c538b85627596bcc560c3d`.

Pre-T07 render (before updating the active pins):
- dispatch-templates: `8fe26ee582718ff739d352cab1ae495f88b3044d167ed67e1666a51d2ef3d4de`.
- configuration: `c76a23d540a2602293ba45f8821419aa00d738eb08c538b85627596bcc560c3d`.

Exactly four active surfaces change. The other five and both historical goldens
remain byte-identical. The dispatch registry has 248 retained classified calls
before and after: zero added, zero removed, zero changed fingerprints. The
removed forge-new-milestone inline planner was outside the registry scope; no
call was fabricated to preserve a count. Smoke source changes only Section61;
its distribution contract is executed separately in the communication suite.
Full smoke remains an independent owner check. Projection does not prove client
rendering, model comprehension, provider execution or human acceptance.

## S02 integrated review R61/R63 correction

Measured with forge-claude-renderer.render after reordering the three modern
bootstrap blocks: enrollment precedes durable STATE. From verified 7e91b8f,
only the active skills pin changes: `3de92437ec378fa298349b408d1d3bf809ed95e35dcdaad0b9e54f24ef3f5000` to `1309f02bb58b79d61ba0bb1e897cdee4d37c232f488e1548106d4a999e57d061`.
The other eight active hashes, immutable distribution-before fixture, historical
goldens and all 248 registry classifications/fingerprints are unchanged. The
pre-T07 comparison remains four of nine surfaces. Runtime restart tests are
separate from distribution and do not establish client understanding or UAT.

## Task ligada (M-20261101111759-opcoes-prazo-milestones, S03/T07)

Medido por forge-claude-renderer.render com a fórmula acima (agrupar por source_id,
ordenar por source com localeCompare, normalizar só `version=MAJOR.MINOR.PATCH`,
unir source e conteúdo com NUL, SHA-256). Captura imutável do owner antes da T06:
revisão `f0b5fb17b4c57348e18fbb96bf38e8fb6ef8ee2b`, copiada sem alteração para
`scripts/fixtures/linked-task/distribution-before.json` (SHA-256
`0464c29011c5b86a438d6e0f93ac07695957c0273e958018835a47c4ea4387d0`). Medição
posterior do owner sobre o commit da T06 `a97856f221f56ab7038222c8fee115039f829f49`
(mapa de fontes SHA-256 `d73ea5be335916e487011fe333847301d485101bd0c9d51158fd5c3911790a37`).

Os nove hashes foram medidos antes e depois; só `skills` mudou:

- skills: `1309f02bb58b79d61ba0bb1e897cdee4d37c232f488e1548106d4a999e57d061` to `4b1a158a3faedb66b0aab2033974917cedb4251d3352e90b5f019970330ae548`.

Fontes do delta, todas declaradas pela T06 (blocos `forge:linked-task`):
`skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`,
`skills/forge-status/SKILL.md` e `skills/forge-task/SKILL.md`. Os demais arquivos
declarados da T06 (`shared/*.md` e a suíte de superfícies) não entram em nenhuma das
nove superfícies medidas. Os outros oito hashes ativos (`agents`, `commands`,
`dispatch-templates`, `hooks`, `mcp`, `claude-instructions`, `claude-settings`,
`configuration`) ficam iguais à captura, e os arquivos históricos 4.18.1
(`a58a005aea70eaa17c0ecfaf1cdf8965cdf9adb8c2678e756ac83ea74d926d9c`) e 4.19.0
(`f2b3e910445d2557f50aa4ced9e1b31498debc6b1cdd1ed05b452d8141b4307f`) ficam byte a
byte iguais. O registro de despacho mantém as 248 linhas, classificações, motivos e
fingerprints da captura: deriva medida zero, nenhuma linha editada. Distribuição não
prova execução nem compreensão do cliente instalado, nem aceite humano.

## Review-fix com limites executáveis (#341, M-20261106040502-review-fix-limites, S01/T05)

Medido por forge-claude-renderer.render com a mesma fórmula acima, sobre os bytes finais da
T05. A base é a revisão `563ac2752722ac7c29848f62520c8446185bc15c` (563ac27). Os valores
anteriores são os pins ativos versionados nessa base, que também conferem com a captura da
task ligada acima e com as constantes T06 das suítes; nenhum foi recalculado do disco. Os
valores novos são o `actual` medido pelas próprias suítes. O delta completo, com os caminhos
declarados e a proveniência, fica em `scripts/fixtures/review-policy/distribution-delta.json`.

- agents: `64bbdc40320fe629f19c9e0ceb50256f03544d9d9b0385d416f1563b2abbd41a` to `30d0fb3fecdb88a4d2ac76dbb5a1ee6669aa3455f1fa41461137f89a164921c0` (T03: `agents/forge-advocate.md`, `agents/forge-reviewer.md`).
- skills: `4b1a158a3faedb66b0aab2033974917cedb4251d3352e90b5f019970330ae548` to `bcb38a84d24878be82872ebfd78f0b6461e1b11bdabcd5829e4181692b15aab4` (T05: `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`, `skills/forge-task/SKILL.md`).
- configuration: `c76a23d540a2602293ba45f8821419aa00d738eb08c538b85627596bcc560c3d` to `e3f1fdcfe1b6404d242fec5e1925a6e424d9f9fc8bcaec23d7f6711ee0d2e280` (T01: `forge-prefs.schema.json`, pref `review.milestone_task_review`).

Medição atribuída (sem os blocos `forge:linked-task` da T06), que as camadas históricas
conferem: skills `1309f02bb58b79d61ba0bb1e897cdee4d37c232f488e1548106d4a999e57d061` to
`78559130c1c543be186ebd14ab2a448c4612e080ff76dbabbe3e915bf10d7819`; `agents` e `configuration` não têm bloco ligado, então o valor
atribuído é o próprio pin.

Os outros seis hashes ativos (`commands`, `dispatch-templates`, `hooks`, `mcp`,
`claude-instructions`, `claude-settings`) ficam byte a byte iguais, assim como os goldens
históricos 4.18.1 (`a58a005aea70eaa17c0ecfaf1cdf8965cdf9adb8c2678e756ac83ea74d926d9c`) e
4.19.0 (`f2b3e910445d2557f50aa4ced9e1b31498debc6b1cdd1ed05b452d8141b4307f`) e as capturas
`distribution-before.json` (milestone-options e linked-task). O registro de despacho
continua com 248 linhas, nenhuma nova ou removida e deriva de fingerprint medida zero:
`scripts/forge-dispatch-source-guard.js` não foi alterado. Distribuição não prova CI,
smoke, merge, release, instalação, execução nem compreensão do cliente, nem aceite humano.

## Entry result contract (#347)

Measured from base `ad62d774fc37ec6fcf5a85347d69eaf5c8a8c675` using the pure Claude renderer, without writing host projections. The nine result-block agents receive the classifier-derived status instruction; the hook uses the same enum and preserves the bounded second-pass escape. Seven other surfaces and all historical captures remain unchanged.

| Surface | Before | After |
| --- | --- | --- |
| agents | `30d0fb3fecdb88a4d2ac76dbb5a1ee6669aa3455f1fa41461137f89a164921c0` | `91dd5d2a3ece86df030fcf5e374041c3bb496da040baf3f3a2830445061c8c5e` |
| hooks | `c149db9dd45bed13f05931987217d224a6f23d805dc6e8900e46b32893a41c48` | `228bceb55413320b8f3b47564711989f454a841d9946ebdfde92f690b733ad1e` |

The exact source and attributed hashes are recorded in `scripts/fixtures/entry-contracts/distribution-delta.json`; #341 remains an immutable earlier layer. Distribution proof does not establish provider/client execution or human acceptance.

## Product artifact path contract (#348)

Measured by the pure Claude renderer over the composed #348/#353 candidate based on
`c91dfc77231a176892df72f56c0eefefbbd430be` (entry contracts plus required-result budget attribution).
The immutable #347 fixture retains SHA-256 `ffb4476cd2ef7b7b8e44676a392e9a11607015fc38d349be9ae2a5fa0a8558a2`.
Only the agents surface changes, through `agents/forge-planner.md`:

- agents: `91dd5d2a3ece86df030fcf5e374041c3bb496da040baf3f3a2830445061c8c5e` to `5a340f4af8ad04071f5d3f39573f72e849c5e97a40e33364da787a14d2ef8de2`.
- planner file: `45ceadf4a8299115a9a492a9beab4e4c83e29748ca68af03763144b5e904e4cb` to `21be82c7121303e915e0e1a4b490f6ced8c72baefeef55d4a231143cda278400`.

The other eight active surface pins, all member identities, #341/#347 deltas and
owner/historical captures remain unchanged. The bounded source/render evidence is
recorded in `scripts/fixtures/artifact-contracts/distribution-delta.json`.
This proves distribution only; it does not establish CI, release, installation,
provider/client behavior or human acceptance.
