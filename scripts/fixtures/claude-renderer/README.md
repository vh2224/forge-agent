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

## Identity and lifecycle distribution

Measured from artifact base `20ae504cbd4e546aaa49f9643955ded1062e67ce` plus the scoped identity producer diff.
The three earlier delta files remain byte-identical. Only skills/hooks change;
all rendered member identities and the other seven active pins stay unchanged.

- hooks raw: `228bceb55413320b8f3b47564711989f454a841d9946ebdfde92f690b733ad1e` to `b7c42a1e5f13383c13d6099655bbd05481bf584c19d90ecf74a4bdefb99d5c36`; attributed: `228bceb55413320b8f3b47564711989f454a841d9946ebdfde92f690b733ad1e` to `b7c42a1e5f13383c13d6099655bbd05481bf584c19d90ecf74a4bdefb99d5c36`.
- skills raw: `bcb38a84d24878be82872ebfd78f0b6461e1b11bdabcd5829e4181692b15aab4` to `ea8df89a439017a632388a99e813136c5c9277996d530494723ae144cef63f5c`; attributed: `78559130c1c543be186ebd14ab2a448c4612e080ff76dbabbe3e915bf10d7819` to `7f84746e6e9f73905ea343f1eb4c0c750e1af5016424399f14ae40fe02e808a4`.

The historical T06 fresh-registration span retains its before anchor
`b0d14d5ba51b0096922338482ad357c77a193e5af4097616fbdc469681ee7874` (1803 bytes); the attested-owner
registration change measures `2bb749560c1dc907d9f1db882e78033ebe883c9b58a8609b6ea5cb4820ec52c7` (2037 bytes).
The other three historical spans remain unchanged.

The exact three source members and two sample citations are recorded in
`scripts/fixtures/identity-lifecycle/distribution-delta.json`. This establishes
distribution only; CI, review, release, installation and human acceptance remain
separate facts.


## Identity after maintenance correction 090bd42f9eb4

Source/render remeasurement following maintenance corrections. Existing review receipts and historical captures remain separate.

- hooks raw after: `b7c42a1e5f13383c13d6099655bbd05481bf584c19d90ecf74a4bdefb99d5c36`; attributed after: `b7c42a1e5f13383c13d6099655bbd05481bf584c19d90ecf74a4bdefb99d5c36`.
- skills raw after: `f0d6e8f36cadc8c4f4c66d5e9a5b4da486b2843434af49d68d6875109d982f7c`; attributed after: `9655fa67054b852bcd29319efdff465b5a677ebdbf50a26eee9124befaea93d7`.

Fresh-registration after: `2bb749560c1dc907d9f1db882e78033ebe883c9b58a8609b6ea5cb4820ec52c7` (2037 bytes).
Immutable fixture348 SHA256: `d0d50a7cace922a0a5d4edb8668c64429d32c81c40d20eaf9d175d31ad95993f`.
Exactly the same three source files and two surfaces remain in this layer. No CI, release, installation or human acceptance is asserted.


## Measured343 next terminal after375

{
  "base_revision": "bccfb723bee755f830e452d0b3e3dbcc6fb66025",
  "previous_delta": "scripts/fixtures/interrupted-owner/distribution-delta.json",
  "method": "Exact frozen composed source and pure Claude render; preserved prior bytes/validators; generated without provider output.",
  "input_scope_sha256": "80dcc0dcd8329df2a47bc070da8c41c03bd5a23fe936f91147791b57b610b926",
  "prototype_only": false
}

agents
before 5a340f4af8ad04071f5d3f39573f72e849c5e97a40e33364da787a14d2ef8de2
after a4cdcf70a37c309b9a67c818fcc1fdafda24eaf2abbedb775b576530c5d275d1
attributed_before 5a340f4af8ad04071f5d3f39573f72e849c5e97a40e33364da787a14d2ef8de2
attributed_after a4cdcf70a37c309b9a67c818fcc1fdafda24eaf2abbedb775b576530c5d275d1
skills
before 4b1446cf4fcfc99184596bf84aeb936d497f79aab1dcde46c2fb1f72a2a23fd8
after 0425fbed14d928d2a67321d99c139df789d3c5cd1d0a9f48236cc340cdc6a9a5
attributed_before 01041828db52aa6e6c477ad222fa46ab09b8e95b53c51f65f60087ef2dbea6d8
attributed_after 8cfcbc0344a236c47280dc5fc0e6289bd6b5c0a318e16506e1e149a1c2f05ef3

agents/forge-planner.md
before 21be82c7121303e915e0e1a4b490f6ced8c72baefeef55d4a231143cda278400
after b506439105d02f337f37d16e0ed3e3cc449027b7a1a72f6401c03028f524d197
docs/communication-evaluation/README.md
before d0ae3824753619f847538ffceb78d38735c5f4f861775988654cb04facad586c
after 69213127c1af7760fe4177dc5a9cecfe9d4a4bc18f056dfb2f67c8a0bd2aeb9b
docs/communication-evaluation/samples.json
before 38bb2dea9d9c6ea56ff672eae2452a0a6f6a2bfbe5697830724a49a43039e405
after 29f9dcf18ccd04e9759f52a0ec428a576f70ec608697419b1db7edd39cd290bf
scripts/fixtures/parallelism/reader-cases.json
before null
after 8091ba6764ad039d2dbc28aa398cdc394aeefab6e774f8100067d1fa66636ceb
scripts/forge-artifact-reconciliation.js
before 23f5ba2bdcb2634a339044b2e30a1b77185311f460ef0437993437be40c79511
after 048f90bdcd2852b5ae1c564a5dfd980319e4f857b50ae9bb76641876a821cd9e
scripts/forge-claim-gate.js
before 354270510b32dd12f218a6380660b603edd44312d69256ef2fcb95adc73bf37e
after 9b4b458b79889e08f3e3f7c37f46f3cba3fa5c6f932ad9a27ba6ca82d96248c7
scripts/forge-claim-overlap.js
before d355d7369965e4a4c8234401cfe1e1e4c4a7768be4593179ac9b938265618d9e
after 231d260d861c6441a453ec56a9acc6cbdd5fa5c920f158084b455957d66a5064
scripts/forge-claude-permissions.js
before 43eff07befdbddec0f01e679f32a8fda26ea0cd48be199b15624a7740b1616b0
after e789e18cd2d6048f8d14b5042026c57a118076c97c64aa849c32c4fa1d0f9474
scripts/forge-claude-renderer.test.js
before 6b4c2f4b4d1ee6bd710a668a1c092fb85655b6e3c2a11556f972917e1de9d1db
after 301bc15f81d49e72fe780ee4bbf61a6aadd416278a2976e543cba962c5362bb2
scripts/forge-communication-surfaces.test.js
before 8acdda48b061dfc65d06a9bdeb7918e46b0c4931dd4cdc9356d6aaf2b1bd9f49
after b1bd863f44908c3dcb354c0469b2d342204a8639aa358b75c0d9bf85561d4fa0
scripts/forge-delivery.js
before ff8ad7272ad88754ecedf1fc86a7274812b9f261dc25e4e0bfffc8bc69925ce4
after 83cb6f3d0f82de2c63f4b724931e6eada13c8412ac52133071d67f4c79ac2952
scripts/forge-dispatch-event.js
before 9353427d57389c4e78561a084699909a5dab8e0b51737c32cc4a154df7717c4f
after 1353bbba883feb9c47db822343d471cc91ae20050fc4934c0f64c03857a99400
scripts/forge-dispatch-source-guard.test.js
before 9241c279083c24f1e29efce9369eeea305e9b8f10086fce2934978837addb892
after 6539ed37d5ea3d0238bad0188befdab4914dc613e70dd7f65105b0c44ae7027b
scripts/forge-execution-batch-broker.test.js
before null
after 1c79adc1666e2b11b7089c94cef9548f6db0a7d2e840ddec9d37f48686bcf7e2
scripts/forge-execution-batch-isolation.test.js
before null
after f1835a84825de1599c3909b1e0ba6b3908f830bb72ca62f98bc025af3df26366
scripts/forge-execution-batch-process.test.js
before null
after a59136a9b969fffd6539f66852d72f43180bae8699b1e48f976bbc7db3c96bef
scripts/forge-execution-batch.js
before null
after df5b58cb4c98c6b8d09fff75cef2efef97b376cd9ae44c270d1224ab418a65e7
scripts/forge-execution-batch.test.js
before null
after 88195d20f3fc13c9a5b3b43de8fe91ca99d13784c5326565e23db04c328d55e8
scripts/forge-incomplete-resume-distribution.test.js
before 6f9adcd3add89982a1fbb02c19ef320e6da191a8e51319ae88e9548228391195
after eedadc1a142a438bfb47df027ce419b93ca269776e4dc69d0855d0cf2b2c3397
scripts/forge-incomplete-resume.test.js
before 6af83169d7c2870fe259ff601521dd1c0b72ea28076cec831e630fbef0093844
after 4e6317f662de779a9752cedc39caf00f7a605c86658c8ff5a620d6196b5fb1fc
scripts/forge-isolation.js
before 8cca06428eda9ce1724e295e16c3455215fab1ab8b6912b20da46220b872e0b4
after d885febc8b54a1f8719d73aeffa81cac3cb14f74e480264ebc1adbe10de6792f
scripts/forge-long-workflow-adapter.js
before 7be06d04cad73efc5bcf42b4b9006b265f1c5a93b032e31efcd002ae322fa05f
after 4cdc61d495bb62276866f4157e618f91dcde3470341264945f46c1d85d135595
scripts/forge-long-workflow-adapter.test.js
before 621e79120e5f46c5282588ebcecf981284c6e5f45b1e2471531051a210bffd5c
after ae8ec8248248f67797a3e14a9e76ea421cac6f9aa8eddaf4aa96c7c427b51d2a
scripts/forge-loop-controller.js
before 49fe19b2ee919c9ba42bf05a2ffcb9230822a3106987aed26001dc557ac364b3
after 3b80d2e806bf062bfdfb925f4eeccd8024b7776e2cf2d1376db58c0d4e8732b2
scripts/forge-loop-controller.test.js
before b40ac66b4d41b708579d01d29ebc312e88c73b5264037dc95d4dedb8c96ebe3d
after 3e63ecbe5662cc6b027158acf16fa4e554415fa9734564897170b75c9ddcad1f
scripts/forge-loop-failure.test.js
before ee1a1d0753fc9d5c2c5bce02fe8823375cbf77e3300bdcea3a88c62a2047248a
after 0c61513a79164500d1d50089422191537126f828657cb6984cdc1567c1f3e52c
scripts/forge-milestone-endpoint.test.js
before 4206951f30ce7be0ecd1044720d6263bfd8986709795e9cc161a255cbfd6d159
after 30ed83bb4e20fcb4c5726b258a60ceb0b232c94f316043c1eb36f6ca216a0b30
scripts/forge-milestone-options-flow.test.js
before f93c9c20847b564e1d79f7c2e13f041db5868f4f34cd0bfdc896a13759e6424f
after 5e6e93bc12220be244cc4bf9ca2b4cdbd2b22b80fad8819baf942448a696230c
scripts/forge-milestone-time-flow.test.js
before 2ded61ef634b740b5c1def02f20f99c26be3cea4e536027cbae9ffdd3cf1ce75
after 58825ded3a336cb60bf0c5799024038382725adf8083487d3b6952bca27a2573
scripts/forge-milestone-time-transport.test.js
before c68f64af2a1ef4581a888cd223d54bb8dd9cb538f3fc800c8668e05620d29022
after 510bda740ddaab3fbdd834a7aaf853a29150a341668c24560f6b74d756baf30c
scripts/forge-must-haves.js
before db1fead9e66b9d997810b93794180d0371080272b922e204bfee319b9687d37a
after 9e5c4d3f469f9351a5121727b97d3e1e5188d95d5854514602a49c71428bb514
scripts/forge-must-haves.test.js
before d20720f8d9f8faf7c48a4031cb8eb4f2b7892ce50369a630ef4f21e2822ce164
after c688648ea06ba298efca4d61d956e74fc02285cb2e8b6934e6e3e24640fce8b7
scripts/forge-orchestrate.js
before a2ea2311761cb77155e8074949939611eafaa689274b94f9d187e5bca2f259a6
after 0c9dfddea67542c0a91221647aff6db44894f9280d3bb40b4a0bf3400b4a85b1
scripts/forge-parallelism-exports.test.js
before c1389d16ff2f4c37bec87006cee9bf6bff19c561a38b0be2659afaf13d5fd391
after edf7de2ecbaf49800b868fff0b3fd68f441f814cf41a0f330dc8192c52f7d4bf
scripts/forge-parallelism.js
before 6f4280ffbe31aa9cda0b320a6e6f21f98d0ec352ca4771e509b47d232ad476a4
after b96f4e5f1687fd8b56e5283d1b89a03b2b49573fd5225ada5258cfb6e9d268d8
scripts/forge-parallelism.test.js
before ee9a1ac212d90b71adbf331d17067f837ed06f432ac18bf3a38388c473845c33
after 91d94739fae7d02cf770c003ee6ff987222bb617071b7ffb853067157277bff9
scripts/forge-plan-creators.test.js
before null
after 92df3c54f36688361bf937de08797076613f3a0c0b275ddc8c0a74c3fa9eab3b
scripts/forge-plan-generation-native.test.js
before null
after 21d5c2eb524855cfac309c6cfa6e2449729c4111cc038b0102b4fa3c7efd8203
scripts/forge-plan-generation-sidecar.test.js
before null
after 6fe55ce68b52de184407ee0662d7564fc05348f69a277e5b8316b767807d04fd
scripts/forge-plan-validation.js
before null
after 9af0c95ab9f6e2698f6d15eebf260dbaf46b89597ff85bcc3e213cda72c39e79
scripts/forge-plan-validation.test.js
before null
after e1dd65613081e6d11c6af9c0d25b6309f5a36888972ebf88b09750ccad0f6676
scripts/forge-runs.js
before 2f0d77d3ff54b971fec865f5c4f2276fd5ed0c9ccfb59f458b6f61b099b5c28d
after 29e478c4929fe226476701f77a2675d9fd812becebd68eeb10459ce0f63e2cf7
scripts/forge-smoke.js
before ec690d32ce120494db717900ac82b193d552dd6ccb27915bb53bba91dfe0c2f7
after 6291b4cb53b198951f2629aa88d8bc4134a468cadd41314281af39db06eeca7f
scripts/forge-state.js
before c97e89abf8297b491b08b15da7a15761b8bb3678188fe51f3792a6cb9dab34ec
after 0fd096fc635a7b412c78d3b3f2f0c3af2273fb9f15b0acc969ac0af69b556e54
scripts/forge-task-execution.js
before 4b3461c49fad7a467d1cb80e5fb79d4cf50ed7af4ebf6588d27b946bb817187e
after dd7c3ddb5488b124540a4d1f12c8ed2312910277c675784f3bd6917278bbb69c
scripts/forge-unit-controller.js
before 4ee058cfb7447c7ab95cd083bcbc83e65492059ecf1401f449806bb22d38d598
after d66dc2cccb65bf6f4fae29030235fdeacb5d35424c1d42a90432151f5af8243e
scripts/forge-unit-sidecar.js
before 2cd71ca27b4aa66599763c8a5921ab6d5e70129b507d1bfb03789584b22f654c
after 730df5a3d4e09c4186e3eefe9f9c0bbddfe860c5d1f352818f1ada80b2257add
scripts/forge-verify.js
before cce34e3225763336640596c4cc6f8abefa03ee9f4241e44865536dbfb99f9bd4
after d7c372c19f5e1de2bc0e77b02f03fdee7f4c409e3294754ab4745b71647c3c2c
scripts/forge-vertical-adapter.test.js
before c65e7a8adda143518715f5122e6e06f0b4202757460504b614490f6b063b1f32
after e7511f4efa8db79d3b9a7d49d6c263d86b7173909f6a0de47705593ba231cf2f
scripts/forge-write-claim.js
before 78cd96a70ef9692b633f4c0d0cfb24c8953ee8bb472377ce5266f56433766bdf
after 8e7273b5e20eb626d7a54fc0ae2ad3b96059e01e5b8accad2b336d5d65870a05
scripts/forge-xllm-appserver.test.js
before 025542aa7510a8ea4e5eb6233e8e3f30fdd008484a2d0703e4fe4b7ed8b3c774
after 8a741ea5cc2e8f62afb093aa142ff7e637886f8d46fea52b6b43ae8f2970a30c
scripts/forge-xllm.js
before 1cf0959569b0ebebd809a76280c7f6a701ccf4567deffe67f7a122788964d619
after 4ac01da2a2c800d336c57cbfe6314b85d840a759adf395f82ed4b32a2bc217fd
shared/forge-bidirectional-sidecar.md
before 68a1095fbff8afad35e1f9c3ed418f3702232049bf7b6a58fbcc86f57bf98e16
after 2a17afe93794f2901cbb8e41727e0e1eb5d5b519c21eb3d97af68706fd42be72
shared/forge-dispatch.md
before 2bfbff7c78c7e231bf1a5bc99ae558715adc36e25546a505eea808feda874e87
after cdb8f86b55fdd4b855dde2c8ecb8bdba34f56e81c73715876027531107e81039
shared/forge-lifecycle.md
before f2624b3ab51f6ab17b779cd7161a929c361b30a894265be4756e13402b18918e
after 5587a308620f266c7557b8b00bec8198145d2cd8d8f96d511ad836521260c6d5
shared/forge-plan-gate.md
before 468ea849a25b3b30244b49100c1edc7db52cd8c391908a2beac9401f6c1acec9
after 7a9be245c2f31bdc2a4bfa250671090cc26c33737fed72dc311082932228c65e
shared/forge-sidecar-auto.md
before b8c550e07e153ffac2ec5b3c1874d79c81822f7c34ccec3dc7dcb497d2d8926d
after 117f1106115a04e6264ee51eda8442f9506b0743e1b599a641c28922e5472b66
shared/forge-state.md
before c559e0a62b8646ff8e52e31e46a440dd599569334cd4aeaae52a1759f87ca229
after 4d06efa716989560f0cefe461e3384404057c45cbdcfbcef70c1f872c3df95e5
shared/schemas/forge-execution-batch.schema.json
before null
after 1cb3dda9ba9ad682af8a5e377f6fad359cb63b6b25a71310a10de897f1933200
skills/forge-add-slice/SKILL.md
before 38cfbbf349d58dbaa3840581dfa149af51f0daf496fc5e333f2a5013658d64cf
after 59e4d11480b7c2737c18e30cda24e8ee76dd1c748203ad372b6ad29f9b482754
skills/forge-add-task/SKILL.md
before 54e4aa6a3d9220b51ef118309daa48c0b5c6b48d85719c5bd4115cd3b18a9c27
after 24d494a65ddef068bdcb4ff4f9992eda4bf2892d0f2ab0e6f1a5f357fc7253a1
skills/forge-auto/SKILL.md
before 14b15d90a92f8334cb0d85e4f0dadd651bbd02ec9c94dbf87f1c360302133b8b
after 20f4ee2d3a2354bf003c93962aeb74816ad91cff7f588b1cade6e364109850b1
skills/forge-next/SKILL.md
before 26cd95c5cbb829eae5dbefad7e115e77c496d10af41b5a033fd336a6e2d553f1
after ca226959ba87cbe75acffd91e0d9af673677f876aa3f39ec12b238e9b9ded711
