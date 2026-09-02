## v4.11.0 — Controle de recursos com o eixo de heap declarado, e asserts que param de medir o vizinho

Esta entrada cobre **v4.9.0, v4.10.0 e v4.11.0**. As duas primeiras foram tagueadas sem entrada de
CHANGELOG e sem bump de `VERSION` — a constante ficou em `4.8.0` por três releases, então o
instalador carimbava `4.8.0` num checkout tagueado `v4.10.0`. Corrigido aqui: `VERSION` volta a
acompanhar a tag, e o golden do renderer foi regenerado **pelo próprio render path** (o marcador de
origem embute `version=`, então bumpar move legitimamente os 7 hashes das superfícies marcadas).

### Controle de recursos de máquina (v4.10.0, milestone `M-20260813221024`)

Admissão e dimensionamento de recursos na execução de testes: `scripts/forge-resources.js` como dono
único, pool machine-wide por lease compartilhado (soma-para-teto), tokenizer real que reconhece as
formas provadas de runner e recusa com razão enumerada, três consumidores finos (`forge-verify`,
`forge-reverify`, `forge-hook` PreToolUse) com release de lease em toda saída, censo
(`forge-doctor --check resources`) com piso anti-silêncio, e indicador na statusline.

**O ganho de performance NÃO foi reproduzido, e isso é parte da entrega.** A primeira medição foi
invalidada pela própria review (o instrumento gravava o intento do processo pai, não a ação do
filho). A re-medição, com 12/12 corridas carregando dump escrito pelo **próprio filho**, provou o
enforcement ativo e não achou ganho: baseline não reproduziu (batch 312 s contra 301 s esperados;
solo 179 s contra 88 s), e as diferenças ficaram dentro da dispersão interna das células
(−0,9 s solo contra dispersão de 64 s; −16,1 s batch contra 174–202 s).

**O eixo de heap não restringe — ele concede.** Medido dentro do processo filho: o teto real é
**4288 MB** com `enforcement=off` (o default do Node nesta máquina) contra **8384 MB** sob pressão
`warn` e **12480 MB** sob pressão normal — ou seja, ligar o controle eleva o teto por processo em
**2 a 2,9×**. O agregado `workers × heapMb` fica em 2,5× a RAM sob `warn` e 7,5× no estado normal
(máquina de 16 GB). Os eixos que **de fato** restringem são a **contagem de workers** (10 → 5) e o
**cap do Playwright** (1).

A calibração fica **inalterada de propósito**: teto não é alocação, e ninguém mediu consumo
**residente** (RSS), então não há evidência de que o teto elevado vire consumo real. Recalibrar sem
esse dado repetiria exatamente o erro que a milestone existiu para não cometer. A medição de RSS é
pré-requisito declarado de qualquer recalibragem (itens `I-20260814021202`, `I-20260815042402`).

### Added

- **`forge-gate --resolve-lapsed`** — resolve para o default declarado todo gate que expirou sem
  ninguém para persistir o lapso. Sweep idempotente, com censo (`examined`/`resolved`/
  `skipped[{id,reason}]`) e razão nomeada em cada skip. Nunca sobrescreve resposta humana.
- **`forge-gate --max-wait <ms>`** — limita o bloqueio ao orçamento de quem chama, devolvendo
  `source: wait-timeout` com o gate **ainda aberto**. `wait-timeout` nunca é decisão.
- **`writableRoots` do sidecar** (v4.9.0, PR #86) — medido, com semântica de soma.

### Fixed

- **Routing-contract markers no longer create artificial version diffs.** New projections use a stable
  ownership marker; the first sync automatically migrates existing strict semver markers and later
  syncs are byte-identical.

- **Um gate lapso deixa de depender de um waiter sobrevivente.** O único código que persistia o
  `timeout-default` vivia dentro de `waitForAnswerSync`, então a resolução era efeito colateral de um
  processo seguir vivo até o instante da expiração. Ele não segue: o call site real
  (`--open --wait --timeout 1800000`) roda numa tool call cujo orçamento é de minutos, não os 30 do
  gate. O waiter morria no meio do bloqueio e o gate ficava `pending` para sempre — um leitor
  posterior via `expired` com `answer: null`, byte a byte igual a um gate que nunca teve janela.
  A resolução passa a ser função do **arquivo**, alcançável por qualquer processo depois.
  *(O item original dizia que os gates "nasciam expirados"; o artefato sobrevivente refuta —
  `expires_at - created_at` era exatamente o timeout pedido.)*
- **`complete-slice` perde o caminho para mergear** (v4.11.0, PR #96). A instrução negativa competia
  com um passo canônico escrito nas três superfícies que o completer lê, e perdia. O passo — que já
  estava **morto**, nomeando um branch fora do esquema atual — saiu; a proibição passa a ser
  declarada **por classe** (integrar), não por verbo. Guard fiado em `forge-auto`/`forge-next`, com o
  incidente reproduzido literalmente.
- **Dois reason codes emitidos e não registrados** (PR #96): `intact:enforcement-off` e
  `intact:admission-refused-advisory` degradavam para `reason-unregistered:*` no censo.
- **Asserts que mediam superfície viva compartilhada** — família de testes que só ficava verde com a
  máquina ociosa (`I-20260814142227`). `census R13` e `forge-touch R5` passam a medir **cópias
  isoladas**; o `forge-touch` ganhou o `HOME` sintético que o cabeçalho já **afirmava** ter sem que
  nada no arquivo o setasse.
- **O escritor concorrente era um teste.** `forge-touch` R7 escrevia o fonte mutado por cima do
  `scripts/forge-touch.js` **real** e restaurava no `finally`; a janela é observável, e
  `forge-release-gate` chama `packaging.build({repo})` duas vezes afirmando que os hashes são iguais.
  R7 passa a compilar o mutante **em memória**. Medido amostrando o fonte 400× durante a suíte:
  antes 10 amostras divergentes, agora 0.
- **Um assert sobre o hábito de quem roda a suíte** — o teste Swift de divergência terminava em
  `if !onDefault { assertTrue(ahead > 0) }`, quebrando 100% deterministicamente em qualquer branch
  recém-criado. Trocado por repo sintético com divergência **conhecida** (`ahead` exato 2).
- **Windows: `forge-code-dir-repo` R4/R5** comparavam o hint contra o caminho **cru** enquanto o hint
  embute a forma **normalizada** (`\` → `/`); no POSIX coincidiam por acidente.

### Known

- **Windows continua vermelho em 12 suítes** (`I-20260815014759`), majoritariamente domínio
  git/worktree/caminho. O item registrava 2; a medição na master mostra 12. Não são residuais.
- `forge-lock`, `forge-release-gate`, `forge-package` e `forge-app-workspace-marker` **não foram
  reproduzidos** isoladamente. Nos dois do meio a correção é por remoção da causa (o R7 acima),
  declarada como hipótese medida na causa e não verificada no efeito.

## v4.8.0 — One core, two hosts, and a sidecar that gets nothing it doesn't need

### Added

- **Forge Agent multi-runtime:** um único core em `FORGE_HOME` com projeções selecionáveis
  para Claude Code e Codex CLI, instaladores compartilhados para Windows, macOS e Linux,
  diagnóstico/capabilities offline por host e handoff auditável sem copiar login, keychain
  ou credenciais entre runtimes. Integra a PR #71, reautorada sobre o transporte
  `codex app-server` que a v4.6.0 introduziu depois que aquela branch partiu do `master`.
- **Barreira de saída não-confiável no sidecar** (`assertUntrustedOutputBarrier`): dispatch
  control data aparecendo no JSON devolvido pelo modelo de terceiro passa a **recusar o
  resultado inteiro**, em vez de deixar qualquer campo dele chegar ao orquestrador. Aplicada
  nos cinco modos (`challenge`, `defend`, `rebuttal`, `execute`, `plan`) — inclusive no
  caminho do app-server, onde vale para o candidato aceito, venha ele do `outputSchema` ou
  do bloco de fallback.
- **`authorizeSidecar`**: todo spawn de sidecar passa antes pela política de dispatch e
  exige a concessão vazia (zero grants, `credential_env: false`), lançando com
  `reason_code` nomeado em vez de degradar.

### Fixed

- **A política de env `inherit` deixa de contrabandear segredo.** Era um `{...sourceEnv}`
  cru, sem denylist nenhuma: quem escolhesse `inherit` entregava ao processo de terceiro
  todo segredo do ambiente. Agora as duas políticas passam pelo mesmo filtro, e o filtro
  deixou de nomear fornecedores (`AWS_`/`ANTHROPIC_`/…) — um `MY_SERVICE_TOKEN` ou
  `DB_PASSWORD` atravessava intacto. A regra é **allowlist vence**: entrada explícita
  passa, tudo que chega por caminho curinga é filtrado.
- **Nenhuma chave de API é repassada ao sidecar.** A auth aqui é por **assinatura**, não
  por chave (sonda macOS de 2026-07-19: o keychain do ChatGPT autentica o codex com a base
  mínima). Repassar uma `OPENAI_API_KEY` que esteja setada no ambiente por causa de outra
  ferramenta é pior que inútil: faz o sidecar cobrar da API medida em vez da assinatura.
  `*_API_KEY` cai pelo padrão genérico, sem nomear fornecedor. `CODEX_HOME` continua
  passando e não é exceção à regra — é caminho de configuração, não credencial, e o
  `forge-codex-renderer` materializa skills/commands sob `$CODEX_HOME`.
- **`START_SHA` e `pre_dirty` viram um registro só** (`captureAttemptSnapshot`), que relê a
  baseline depois da captura e lança `snapshot-baseline-moved` se ela mudou no meio — o par
  não pode mais descrever duas árvores diferentes.
- **`invokeAgy` passa a spawnar com `shell: false`**, alinhando-o aos demais spawns.
- O cabeçalho do `forge-xllm.js` dizia que tocar `.gsd/` emite "a stderr WARNING
  (advisory)". O código lança desde o M018 (`assertNoProtectedSidecarChanges`); só o
  comentário ficou para trás.

## v4.6.1 — Three copies of one rule stop disagreeing

Follow-up batch to M018. Every item here has the same shape: a rule written in more than
one place, where only one copy was ever measured.

### Fixed

- **`GitActivity.Glob` matched `X/**` anchored at the root — and, worse, by substring**, so
  `dist/**` matched `distal/a.js`, and the `assertFalse` that should have caught it passed
  by lexical accident. Two of the three implementations of this rule
  (`agents/forge-completer.md`, `isInstallArtifactPath`) already spoke segment depth per the
  S03 review R24 decision; the Swift matcher was the copy that never got the memo. The
  consumer chain is single — `Glob` → `isIgnored` → `linesTouched` → the metrics panel — so
  a vendored `packages/app/node_modules/` inflated a line count. The matcher moved, with
  both directions proven by mutation: 3 failures reverting to anchored, 4 widening to
  substring.
- **`domain:` had no inline-comment strip in `scripts/forge-must-haves.js`.** Its sibling
  reader in `scripts/forge-dispatch-resolve.js` had none either, so the two agreed by
  accident — fixing one side alone would have manufactured the divergence the capability fix
  exists to prevent. Both now import one `stripInlineComment`: a single copy of the rule,
  not two that match.
- **`/forge-init` never emitted `- **Test:**`**, so `resolveVerifyCommand`'s zero-dep
  fallback had nothing to read and an unproven `environment` claim was accepted by default —
  the gap TASK-020 recorded rather than closed. The guard measures whether the consumer can
  read the line, not whether a literal is present: `- **Tests:**` fails it too.
- The test comment claiming `/**` matches at any depth now describes what the test does —
  the non-root directory case it always claimed to exercise.
- `CLAUDE.md` carried two contradicting `## Estado atual` sections after the M018 merge; the
  stray heading also orphaned two architecture-decision entries under it.

### Notes

- **Not fixed, with the measurement that decided it:** gating the single-entry case in
  `hasDivergentCommandNotes` does not leave the claim pending — it drops to the textual
  corroborator, which accepts it for two of four reasons, trading a real exit code for
  acceptance by prose. Recorded as `I-20260808023107-s06-r7-atalho`.
- Baselines: 111 JS suites, 2502 smoke passed / 0 failed / 1 skipped, 515 Swift asserts.

## v4.6.0 — The sidecar stops shelling out

M018, seven slices. The sidecar no longer spawns a process per invocation: it speaks
JSON-RPC over stdio to a long-lived `codex app-server`, which is what makes per-turn
capability, real interruption and first-class evidence reachable at all.

### Breaking

- **`codex exec` is no longer the sidecar transport, and its absence is proven rather than
  asserted.** S05 migrated the remaining review modes and deleted the old path;
  `scripts/forge-exec-callsites.js` is an in-process scanner reporting `outcome: clean` over
  312 files with 0 call sites — a removal claim a grep in a session transcript cannot make,
  because the scanner enumerates what it scanned and treats a zero-file scan as a failure.

### Added

- **A JSON-RPC/stdio protocol floor (S01)** — a client for `codex app-server` with a pinned
  schema and a drift guard that names the divergent field instead of failing generically.
  Premises A1/A2/A4 measured against `0.144.4` rather than assumed.
- **`runExecute` completes over the app-server (S02).** Premise B3 was measured as
  `indistinguishable`: the protocol never exposes which model ran the turn, so nothing
  downstream is allowed to claim it did.
- **Per-turn capability (S03)**, with the pre-existing sandbox guards extended to the new
  transport rather than re-implemented beside it.
- **Evidence as a first-class artifact (S04)**, plus the floor that refuses to report an
  unexamined scan as clean.
- **Environment coverage by reason (S06)** — two reasons promoted to observed exit codes,
  three kept textual with a named reason each, so "not covered" never renders identically to
  "covered and passed".
- **`turn/interrupt` before `SIGKILL` (S07)**, with the terminality latch.

### Fixed

- **Codex ran without a console on Windows, and every command it shelled out to stole the
  user's focus.** `invokeCodexDetached()` passed `detached: true` on every platform; on
  Windows that leaves the process with no console, so each shell command codex runs hands
  off to the default terminal app — one real window per command, raised to the foreground
  while the user is typing into something else. Measured with a real run: `detached: true` →
  3 windows / 3 focus steals; `detached: true` + `windowsHide` → 4 windows / 8 focus steals;
  no `detached` → 0 / 0. `windowsHide` does **not** fix this — it applies to the codex
  process itself, not to the console handoff its grandchildren trigger. POSIX keeps
  `detached`, because its timeout path kills the whole process group via
  `process.kill(-pid)`; Windows never needed it, since that path kills the tree by pid with
  `/T /F`. Anyone re-measuring this should count `GetWindowRect` and `GetForegroundWindow`,
  not raw window creations: the 0×0 px PseudoConsoleWindow handles make both cases tie at 10
  and make the fix look useless.
- **The `worker:` family token leaked into the model slot** — a bare `claude` resolved to
  alias `null`, silently dropping the task to the agent's frontmatter default instead of the
  tier's model.
- **The plan-checker gained a `.gsd/**` × `dispatch_engine` check inside dimension 9.** The
  sidecar cannot write `.gsd/**`, so such a plan is a dispatch defect detectable *before*
  dispatch rather than after it fails.
- **Branch C marks `status: DONE` on the plan it completed**; without it `forge-parallelism`
  kept reporting finished tasks as ready.
- **The `SubagentStop` repair message asked for the result block *alone***, which an obedient
  agent obeys literally: six advocate defenses were lost this way, three of them coming back
  as a bare scoreboard. It now asks for the complete answer while still forbidding tool
  re-runs, and `forge-advocate` gets `maxTurns: 48` plus a defense file, so a truncation
  costs one verdict instead of all of them.
- **Ten top-level keys nested under `must_haves:` now fail validation with a named error**
  (`expected_output`, `writes` and `depends` among them). Measured in a two-repo dogfood: two
  of three GPT-authored plans nested them, the validator called all three valid, and the
  `CODE_DIR` resolver then saw zero paths and refused the sidecar. The block boundary is now
  a single function shared by parser and guard, so they cannot disagree, and the sidecar
  planning prompt is anchored at column 0 — where the ambiguity actually originated.

## v4.5.0 — Sweeps are triggered, not scheduled

PR 2 of two (`M-20260804003633`) — the mutating half. The fragment store gains a grouped
container, all four readers learn the format in the same slice, and `CURRENT_SCHEMA` is
bumped in the same commit that makes the format writable, so the directional guard PR 1
shipped fires instead of standing decorative. The calendar axis introduced mid-milestone
was then removed entirely: a sweep happens because an operator judged that enough has
accumulated, not because a quarter ended.

### Breaking

- **`CURRENT_SCHEMA` moves from `fragment-store@1.0.0` to `fragment-store@2.0.0`**
  (`scripts/forge-doctor.js`), in the same commit (`0e62d47`) that first makes the grouped
  container format writable — deliberately, so that the directional guard PR 1 shipped
  actually fires instead of standing decorative. The operational consequence is the point:
  a `.gsd/` store is pushed by the VCS on its own, while the tooling only arrives when
  someone runs `/forge-update`. A developer who receives data written by the new code
  without having updated the tooling now gets the **write refused** by
  `scripts/forge-schema-guard.js` (non-zero exit, data major ahead of understood major),
  instead of readers silently skipping the fragments they cannot parse. Reads stay
  fail-open with a loud warning. `scripts/forge-migrate.js` widens its already-migrated
  shortcut to tolerate exactly one major behind, so the bump cannot resurrect the
  documented `.bak` destructive-backup bug.
- **`CURRENT_SCHEMA` moves from `fragment-store@2.0.0` to `fragment-store@3.0.0`**
  (`scripts/forge-doctor.js`), landed in the same commit as the container format change
  (`116007a`), never as a follow-up — a bump that arrives separately from the format it
  guards is a guard that fires on the wrong thing. This bump is effectively irreversible in
  practice: once a store writes `sweep-project-NN` containers, reverting the tooling means
  a developer's writes get refused until they update, and no S10 exists to soften a second
  bump — this is the last slice before the PR. Legacy `YYYY-QN` containers (from the
  epoch-grouping code S03 shipped) are still **read** by `isGroupedFile`/`parseGroup`
  (`EPOCH_LABEL_RE`, preserved read-only in `scripts/forge-epoch.js`) but are **never
  written or migrated** by any code on this branch — a store that already has a `2026-Q1.md`
  container keeps it exactly as-is; only new sweeps use the new name.

### Added

- **Epoch grouping: one byte-exact container per sealed quarter.** `scripts/forge-epoch.js`
  derives `YYYY-QN` labels, sealed epochs and wrapper dirs from the store contents at
  runtime — no cutoff date, no threshold constant. `scripts/forge-grouped-file.js` is the
  container itself (`serializeGroup`/`parseGroup`, `grouped_format: forge-group@1`):
  payloads travel as `Buffer` and are never decoded, so CRLF, BOM and a missing final
  newline survive the round trip, and a member whose payload contains the delimiter is
  refused and named rather than escaped or truncated. Member ids round-trip as UTF-8 in
  all three marker positions — the first implementation encoded ASCII on write and decoded
  ASCII on read, which made a container with a non-ASCII id permanently unparseable *after*
  the originals were deleted. **All four fragment-store readers learned the format in this
  same slice** (`forge-ledger.js`, `forge-decisions.js`, `forge-memory.js`, and
  `forge-projection.js`/`forge-memory-index.js` via the per-store `readFragmentText(cwd,
  entry)` accessor, replacing direct `fs.readFileSync(entry.path)`), because a format whose
  readers ship later is a format that loses data in between. Loose beats grouped everywhere:
  loose ids are collected before any container scan, and `writeFragment()` never edits a
  container. `scripts/forge-epoch-group.js` is the `plan`/`apply`/`ungroup` engine, and
  `forge-ids.listExistingIds` reads containers so sequential-id minting cannot reuse a
  number that is now inside one.
- **`scripts/forge-sweep-project.js`, a registry of operations rather than a script that
  sweeps.** `scripts/forge-sweep-registry.js` (`createRegistry`) is generic over any
  `{name, description, plan, apply}`: dry-run is the default, `run()` only asks for
  confirmation after the preview has been computed, one failing operation does not abort
  the others, and the skipped-items report is produced by the registry rather than by each
  operation — proved by a fake operation that gets a full preview and skip report without
  touching preview code. The CLI ships with exactly one operation registered
  (`agrupar-epocas-seladas`) and a 0/1/2 exit contract.
- **A VCS eligibility gate in front of anything destructive.**
  `scripts/forge-sweep-eligibility.js` (`createEligibility`) is fail-closed: no VCS means
  zero eligible targets, and exclusion is by **target**, not by member, naming the offending
  file and its class instead of writing a silent partial. It rests on one additive export,
  `workingStatus(cwd, opts)` in `scripts/forge-vcs.js` — a single status query
  (`-uall -z --ignored` on git, `--no-ignore` on svn) classifying
  untracked/ignored/added/modified, so callers never issue a second query to disambiguate a
  path. Ignored or untracked *ancestor directories* fail closed too.
- **`scripts/forge-wrapper-readers.js`, a frozen inventory of every enumerator of
  `.gsd/milestones` and `.gsd/tasks`**, verdict-classified (`learned` / `breaks` /
  `safe-by-construction`) and backed by a test that scans `scripts/` for real and fails by
  set equality in both directions — a new reader with no entry, or an entry with no reader.
  It exists because wrapper-dir grouping reaches a class of target whose readers never
  learned the container format, which is why grouping those targets is gated:
  `plan(cwd)` omits them, and `plan(cwd, { includeWrapperDirs: true })` is the sole named
  opt-in, never exposed by the CLI (a test fails if the CLI ever grows one).
- **`scripts/forge-legacy-residue.js`, a read-only detector** for the legacy multi-source
  residue signature (a comma inside the *value* of `facts[].source_unit`, not in the raw
  line) — `scanStore`/`classifyFact` plus a `--cwd --json` CLI, with no write path on disk.
  A scanner failure now reports `store_error` and returns a distinct non-verdict, so an
  unreadable store can never be rendered byte-identically to a clean one. See
  **Not shipped** below for why it is the only thing S04 delivered.
- **`forge-sweep-project` can undo its own grouping — a journal, not a copy of the
  bytes.** `ungroup()` (`scripts/forge-epoch-group.js`) already reconstitutes every
  member byte-for-byte from `unit.id`/`unit.content`; the container was always the
  content journal. What was missing was recoverability after a partial failure and a
  record of which containers exist to undo. `ungroup` is now idempotent: a destination
  that already exists with **identical** bytes (`Buffer.compare === 0`) is treated as
  restored (`alreadyPresent: true`) instead of throwing, so re-running `ungroup` after a
  half-finished restore is the retry path; a destination with **different** bytes still
  throws — loose-beats-grouped stays intact. Both `ungroup` branches (store containers
  and wrapper-dir containers) got the fix, because `ungroup` is callable as a library
  over either. `scripts/forge-sweep-journal.js` is a new append-only, pointer-only JSONL
  log (`.gsd/forge/sweep-journal.jsonl`, same idiom as `events.jsonl`): container paths
  (relative POSIX), timestamps, operation, phase and an advisory sha256 of the
  container — **never** member bytes, so the journal cannot diverge from the container
  it points at. `agrupar-epocas-seladas` now carries a named eligibility basis surfaced
  in the CLI preview: `tool-undo` (untracked/ignored targets, direct or via an ignored
  ancestor — exactly the `.gsd/`-in-`.gitignore` case) alongside the existing `vcs`
  basis; `modified`/`added`/`deleted` targets are still refused outright, unchanged,
  because dirty tracked state signals an in-flight edit that undo does not address. The
  apply path appends a pre-mutation *intent* record before touching disk; if that append
  fails and any accepted target carries a `tool-undo` basis, the **entire apply is
  refused** (exit 1, zero mutation) rather than silently proceeding without a recovery
  record — the same fail-closed posture as the eligibility gate itself. If the append
  fails and every accepted target is `basis: 'vcs'`, the apply proceeds with a stderr
  warning (that class's guarantee is the VCS, not the journal). The CLI gained `--undo
  <container>`, restoring a container's members via `ungroup`, resolved strictly from
  journal-recorded containers.
- **On-demand sweeps replace the calendar axis.** The quarter/calendar label (`YYYY-QN`)
  that `scripts/forge-epoch.js` derived from wall-clock time is gone; grouping now fires
  because an operator judged that enough has accumulated, not because a quarter boundary
  passed. Containers are named sequentially, `sweep-project-NN`
  (`scripts/forge-sweep-sealed.js`'s `nextSweepNumber`/`containerName`, `SWEEP_CONTAINER_RE
  = /^sweep-project-\d{2,}$/` in `scripts/forge-grouped-file.js`), numbered by scanning
  every store directory and taking `max + 1` across all of them (one number shared per
  sweep, not one counter per store) — legacy `YYYY-QN` containers never count toward the
  max. `scripts/forge-epoch.js` keeps only what the new axis still needs:
  `dateOfUnit(unit)` (id → hint → mtime fallback chain) and the wrapper-dir helpers
  (`isWrapperDir`/`listWrapperDirs`), both untouched; the calendar-labelling functions are
  deleted, not deprecated.
- **`scripts/forge-sweep-sealed.js` — three closure proofs, and nothing groups without
  one.** `sealedBy(unit, ctx)` answers, for a single fragment id, whether it is *provably*
  closed for future writes: **(a) ledger** — an entry exists in `.gsd/ledger` for the id's
  owning milestone/task; **(b) id-date** — a valid date is embedded in the id itself
  (canonical `M-<14>`/`T-<14>`/dashed timestamps via `forge-ids.timestampOf`, or
  `ask-<YYYY-MM-DD>`/`ask-<YYYYMMDD>`); **(c) extinct-id** — the id has a shape
  `parseStorageKey` in `scripts/forge-memory.js` refuses outright (e.g. `S03-T02`), so no
  code path in this tooling can ever produce a write to it. Proof (c) was **narrowed**
  during T02 by a finding that refuted its own original premise (see `CLAUDE.md` below): a
  bare local key like `S02` is *not* extinct — `skills/forge-sweep/SKILL.md:262` writes
  memory without `--milestone`, and such a write is live today — so a bare local key falls
  through to "no proof" and is **skipped with a reason**, never grouped on the strength of
  a refuted premise. `legacy-orphan` is refused unconditionally, before any of the three
  proofs, identically regardless of which of the three stores calls it (DS9-6). Every
  failure to prove closure returns a legible pt-BR reason string; the function never throws
  and never returns `undefined`.
- **Date range travels with the container, and with `--list`.**
  `scripts/forge-grouped-file.js`'s `serializeGroup`/`parseGroup` now carry `dateRange`
  (`from`/`to`) alongside `label` (the field `epoch` is renamed but still accepted as a
  legacy input alias, and still written on disk under the `grouped_epoch` frontmatter key —
  a deliberate, documented misnomer to avoid a second frontmatter-key migration). An
  unknown range serializes to explicit empty strings, never an omitted field.
  `scripts/forge-sweep-project.js --list` surfaces the same range per container alongside
  the sweep vocabulary (operation renamed from `agrupar-epocas-seladas`-era naming to match
  `sweep-project-NN`), so an operator can see what a container spans without opening it.
- **`scripts/forge-epoch-group.js` selects and names by the new proofs.** `plan()`/`apply()`
  now select members by `sealedBy()` instead of a calendar cutoff, and name the resulting
  container by `containerName(nextSweepNumber(dirs))`. The `store.name === 'memory'` guard
  that special-cased the memory store (needed only because the legacy-orphan check used to
  live inline) is removed now that `forge-sweep-sealed.js` owns that guard uniformly for
  all three stores.

### Changed

- **The citation extractor in `scripts/forge-memory-index.js` recognises the file forms it
  was missing**: a wider extension vocabulary (`tsx`, `jsx`, `vue`, `html`, `css`, `scss`,
  `aspx`, `svg`), `@` accepted inside a path segment (so a versioned directory such as
  `SERVICES/services@1.2.0/...` stops being truncated), dotted basenames aligned between the
  backticked and bare variants, and two new patterns (`package-ref` for `name@version` with
  a digit-led version, `bare-path-traversal` which reports a containment rejection and never
  probes the disk). Measured against the real reference store, same store state on both sides:
  `facts_with_resolved` 117→177, `citations_resolved` 144→227, `files_indexed` 72→126.
- **Coverage reports three labelled buckets instead of one.** `facts_no_file_mention` (a),
  `facts_missed_by_extractor` (b, enumerated with `mem_id`/`storage_key`/`sample_token`) and
  `facts_unresolved_only` (c) are all derived by `filter()` from a single classification
  list, never by parallel counters, and the sum identity is locked **per fact** and tested:
  `facts_total = facts_with_resolved + (a) + (b) + (c)` (`177+416+5+109=707` on the real
  store). Per-fact is a conscious trade-off with a known cost, recorded in the open review
  items below.

### Fixed

- **`docs/memory-index-citation-coverage.md`** names the cause of the unresolved citations
  instead of inheriting a hypothesis. The 261 unresolvable citations decompose by reason
  with the sum closing (`94+94+53+16+4=261`), and the tie is the finding: `not-found` and
  `ambiguous-basename` land on **94 each**, which **refutes** the D5-inherited hypothesis
  that file renaming dominated. The clearer structural cause is basename ambiguity in a
  directory-versioned monorepo. Two backlogs are named rather than fixed here
  (`BACKLOG-MEMORY-STORE-SKIP-28` — 28 of 145 fragments outside the index;
  `BACKLOG-UNRESOLVED-CITATION-POLICY`), because correcting the cause would reopen the very
  numbers this table measures.
- `scripts/forge-migrate.js`'s header comment described a rule the code does not implement
  (the already-migrated shortcut accepts any stamp not newer than `CURRENT_SCHEMA`, not
  "exactly one major behind"). Comment-only diff.
- `ungroup()` (`scripts/forge-epoch-group.js`) and the S08 undo journal are unaffected by
  the axis swap by construction, not by assumption: the journal records container paths,
  timestamps and an advisory sha256 of the container — **never** the label — so a journal
  line written against an old `YYYY-QN` container still undoes correctly after this slice.
  Exercised directly rather than left as an inherited claim (`S09-RISK.md` W5).
- **`sealedBy: PRECISION` disagreement resolved by narrowing proof (b), not by picking a
  side.** The precision test the slice wrote about itself (`sealedBy: PRECISION — a live
  unit is refused with a reason, surrounded by eligible ones`) showed that a milestone id's
  embedded timestamp records **creation**, not closure — a still-open milestone with no
  ledger entry was passing proof (b) on the strength of its id alone. Proof (b) now trusts
  a bare embedded timestamp directly only for `ask-*` session ids; a milestone/task id
  additionally requires the ledger check that proof (a) already performs. The test that
  exposed the disagreement now passes without being weakened.
- **Proof (c) narrowed a third time by an independent cross-family challenger** (the S09
  review ran with a Codex challenger against Claude-authored code): the objection was that
  a shape `parseStorageKey` rejects is evidence the parser won't write it *today*, not proof
  that no future code path ever will — parser rejection is not the same claim as permanent
  unwritability. Resolved **not by narrowing eligibility again** but by persisting the
  admitting proof per member (which of (a)/(b)/(c) qualified it, recorded alongside the
  member) and pinning the rejection grammar itself with a test that names the consequence
  of a future parser change, so a later widening of `parseStorageKey` fails loudly instead
  of silently re-admitting members proof (c) already sealed.

### Notes

- **S04 (legacy-residue cleanup) was cut by its own gate, with verdict `NO-TARGET`.** The
  slice opened with a precision gate that had to produce a verdict before a line of cleanup
  was written, and the verdict was measured against the real reference store: the D9 signature
  matched **0 facts out of 707 evaluated across 117 fragments, with 0 false positives**
  (negative control: a naive line grep "matches" 64, all of them the JSON end-of-line comma,
  i.e. the record delimiter rather than the data). The cut is informative rather than empty,
  because the residue *does* exist — roughly 25 multi-source entries, the largest `MEM077`
  with 11 sources — but it lives in the **markdown body** of `.gsd/memory/legacy-orphan.md`
  in the legacy `- source: a, b, c` form, outside `facts[].source_unit`, which is the only
  surface the D9 signature inspects. Widening the signature is a re-scope of D9 and an
  operator decision, so it was not taken here; the count is recorded as named backlog. The
  cleanup engine (T02) and its registration as operation #2 (T03) were therefore never
  dispatched. What stays on the branch is the read-only detector and its 19 tests.

**Review triage — six objections arbitrated, all closed.** S05 R3 closed with **no code
change**: both proposed remediations (widening `--force`, adding a dedicated
`--force-untracked`) were rejected as weakening the eligibility gate that was just built;
**S08's undo journal resolves the substance instead** — `tool-undo` makes
`untracked`/`ignored` targets eligible without `--force` at all. S05 R9 closed: the
fail-closed test no longer passes green without git — the suite now exits non-zero unless
`FORGE_ALLOW_NO_GIT=1` is set, removing the silent-skip-behind-`if (gitAvailable())` path.
S05 R13 closed: the `shell:false` hardening in `optionsFor()` is **kept** — reverting
correct hardening to satisfy scope discipline would make the module worse — and the scope
deviation is recorded rather than undone. S05 R16 closed: the D11 gate stays closed, but
the count of protected wrapper dirs is now always reported, so a wrapper target vanishing
from `skipped` is no longer indistinguishable from a broken detector. S06 R3/R4 closed:
the coverage labels are corrected to state exactly what they measure — no new bucket was
added and the four-way sum identity is untouched, only the wording changed to stop
`facts_missed_by_extractor` reading as a defect count it never was, and to stop
`package-ref`/`dynamic` rendering as "could not be located" when they are, by design, not
files at all.

**Dogfood — one bug live proof-of-narrowing missed, found by running the tool for real.**

- **Preview run against the real reference store** (dry-run only, nothing applied) turned
  up a `high` bug that no earlier mechanism — not the three narrowings above, not the 21
  review objections across the milestone — caught: proof (b)'s regexes anchored on
  `^ask-<digits>`, but every real session id on disk carries a **doubled** `ask-` prefix
  (`ask-ask-<date>`), so the anchor matched **zero** real fragments and every `ask-*`
  fragment fell through to "no proof" regardless of how old it was. Fixed by matching the
  doubled prefix. Under the calendar axis the same store measured 222 eligible members;
  under the corrected sweep rule it measures **508 of 529 members eligible, 21 skipped with
  a reason, and the totals reconcile** (`508 + 21 = 529`).

**Review across the milestone: 21 objections raised, 21 closed, zero open.**

## v4.4.0 — Truncation that talks, and a guard that can refuse

PR 1 of the two deliberately separated halves of the `.gsd/` stratification
(`M-20260803205433`). Everything here is additive: no data format changes,
`SCHEMA-VERSION` is not bumped, and anyone who installs it and does nothing else sees
nothing break. Shipping it first is the point — the guard has to be installed *before*
the format that needs it, because a `.gsd/` store travels with the VCS on its own while
the tooling only arrives when someone runs `/forge-update`.

### Added

- **Truncation that talks.** Both dispatch truncators — `truncateChars`/`boundStandards`/
  `truncateContext` in `scripts/forge-prompt.js` (the Claude worker render) and
  `truncateAtSectionBoundary` in `scripts/forge-tokens.js` (the sidecar/CLI path) — now
  emit a marker naming what was cut and where to read the rest (`.gsd/CODING-STANDARDS.md
  § <section>`, `.gsd/memory/`), instead of a mute `…`. The marker is charged against the
  same budget it protects: the reserve is derived from the worst-case digit count, not a
  fixed constant, so it can never itself overflow `maxChars`/`budgetChars`. Additive —
  byte-identical when no `source` is passed.
- **`scripts/forge-schema-guard.js`**, a directional schema guard: compares only the
  major of `.gsd/SCHEMA-VERSION` against the schema the tooling understands. Fail-open on
  read (absence, unreadable stamp, or major ≤ understood all pass clean, with a loud
  warning plus a `partial` result when the data is ahead). The write side refuses outright
  (non-zero exit) in **two** cases: when the data's major is ahead of the tooling's, and
  when the stamp exists but could not be read at all (a directory in its place,
  `EACCES`/`EPERM`, …) — the refusal names the errno and claims nothing about direction,
  because a guard that could not read the stamp measured nothing. Absence and readable
  garbage still write, unchanged: only the read failure closes. Wired into the four
  fragment-store readers — `forge-projection.js`, `forge-ledger.js`, `forge-decisions.js`,
  `forge-memory.js` — at every read and write entry point, so stale tooling can no longer
  silently clobber a store written by newer code.
- **`scripts/forge-memory-index.js`**, a source-file → facts index derived from
  `.gsd/memory/*.md`. Generated on demand (`--write`), never injected into any
  prompt/template/budget. Every render carries an unconditional "Cobertura e descarte"
  section enumerating which file citations resolved, which didn't and why
  (`not-found`/`ambiguous-basename`/`outside-root`/`dynamic`), and which facts carried no
  citation at all — a coverage gate that can't silently under-report.

### Fixed

- `shared/forge-dispatch.md § Budgeted Section Injection` previously described only one
  of the two real truncators; now documents both, each with its own explicit degradation
  ladder (the two builders intentionally degrade differently — the shared prose that used
  to cover both was actually wrong for one of them).
- **The schema write guard could be disabled by a directory** (found by dogfood review on
  PR #70). `readSchemaVersion` collapsed every read error into `null`, and
  `checkSchemaDirection` then read that `null` as "not ahead" — so a `.gsd/SCHEMA-VERSION`
  that existed as a *directory* (`EISDIR`) made every fragment-store write sail through
  with exit 0 and a file on disk. The `catch` inside `assertWrite` was never the fix: it
  was unreachable, because nothing on that path ever threw. The information now originates
  where the errno is visible — `readSchemaVersionDetailed` in `scripts/forge-migrate.js`
  reports `{ value, unreadable, errno }` — and survives to the write side as a first-class
  `unreadable` field. Read behaviour is untouched in all three stamp states.
- **Raw NUL bytes in three source files made git and grep treat them as binary.**
  `scripts/forge-memory-index.js` (two, a `Map` key separator) and
  `scripts/forge-review-diff.test.js` (one, in the assertion string that checks NULs never
  reach the reviewer) carried literal `0x00`s where the two-character escape `\0` was
  meant. The cost was review visibility, not behaviour: `grep` answered "Binary file …
  matches" and diffs refused to display. Escaped, byte-behaviour-identical, and now locked
  by a new `forge-smoke.js` section that scans `scripts/*.js` for `0x00`/`0x0b`/`0x0c` with
  an anti-silence floor (0 files scanned is a failure, not a clean pass).

## v4.3.0 — A review that reads only what the unit owns

`skills/forge-task/SKILL.md` declared the gap this closes: SVN review scoping was Phase 2
and outside M017, so in an SVN working copy every loose task shipped with **no dialectic
review at all** — the primary way of working in at least one real project.

### Added

- **Scoped SVN review diff (`scripts/forge-review-diff.js`), and `/forge-task` Phase 2.**
  Porting the slice boundary's branch would have closed the "no diff" symptom and inherited
  three defects, each measured against the real client rather than assumed: (1) **scope** —
  `svn diff` with no paths is the *whole* working copy, which in a copy routinely shared by
  several developers carries their uncommitted work, measured at 49 files with 8 of them the
  unit's, so the challenger spends its budget objecting to code the unit does not own;
  (2) **untracked** — `svn diff` cannot render an unversioned file at all, so a slice whose
  entire change was two new files would have read nothing and rendered CLEAN, the worst
  outcome a gate has; (3) **appended arguments** — three consumers append to `DIFF_CMD`
  (`--name-only` in the pattern scan and the empty-diff probe, `-- <files>` in Step 2.0
  sharding) and `svn diff --name-only` does not exist, so `DIFF_CMD="svn diff"` broke all
  three silently. That third one is why this is a program and not a longer shell string: a
  composed command satisfies none of the three consumers. One command is now the SVN
  `DIFF_CMD` for **both** boundaries, because the slice gate had the same three defects and
  fixing only the task boundary would have left two divergent copies of the wrong thing.
- **Peg revisions, where the obvious fix is backwards.** A path containing `@`
  (`SERVICES/services@1.2.0`) is read by most subcommands as `path@rev`, and the documented
  escape is a trailing `@` — applied to `svn diff` it breaks *every* path. Measured on svn
  1.14.2 against working-copy targets: `svn diff -- src/services@1.2.0.ts` works, the same
  path with a trailing `@` gives `E155010`, and `svn info` is the exact inverse. `svn diff`
  does not peg-parse working-copy targets; `svn info`/`add`/`delete` do. Diff targets are
  therefore passed literally, and both halves of the asymmetry are pinned by a test that
  runs the real client, because getting this backwards drops files from a review with no
  error and no exit code. (`--targets <file>` would sidestep it; `svn diff` rejects that
  option — hence argv batching under the Windows 32K command-line cap.)

### Fixed

- **`--check projection-versioned` accused every projection monolith it was supposed to
  clear**, and exited 1, in a correctly configured SVN working copy. None of them were
  versioned: `svn status` only omits an ignored path while *scanning* a directory; name the
  path explicitly and it prints `I <path>` — non-empty and not `?`-prefixed, so the prefix
  test read *ignored* as *tracked*. The same oracle was wrong in the other direction, which
  the report did not cover: `svn status` is silent for a versioned file with no local
  modification, so a projection that was committed — the worst case this layer exists to
  catch — read as clean and passed. `svn status` cannot answer "is this path under version
  control?" at all; `svn info` answers it by exit code, one call per path, no parsing. The
  membership question moved behind the `forge-vcs.js` seam as `isTracked(cwd, relPath,
  {vcs})` (git via `ls-files --error-unmatch`, SVN via `svn info`), because re-implementing
  VCS access beside the seam that exists to normalise it is what produced the bug.
- **The manifest reader could not read the shape every `T##-PLAN.md` in this repo writes.**
  `artifacts` was listed among `PLAN_LIST_KEYS`, but a mapping entry (`- path: "x"`) carrying
  its own nested keys made the first entry a quote-mangled string, and `min_lines:` — neither
  a list item nor blank — ended the loop, dropping every entry after it in silence. That is
  under-inclusion, the direction the manifest comment calls out by name, masked only because
  `expected_output` is mandatory and validated. A non-item line indented deeper than the
  items is now a nested key of the current entry rather than the end of the list; a list
  nested under such a key is skipped instead of mistaken for paths; and a mapping led by
  anything other than `path:`/`file:` contributes nothing instead of a garbage entry.
  Measured over the 125 plans and summaries on disk: 50 garbage entries before, 0 after, no
  declared path lost in either direction.

### Documentation

- **`docs/forge-v2.md`, `docs/forge-v2-build-spec.md` and `docs/forge-v2-research.md`** —
  the argument (why-first, for a human deciding), the same content as constraints (20
  numbered MUST/MUST NOT invariants, decisions split into closed `D-01..D-07` and open
  `Q-01..Q-09` with what closes each, falsifiable phase-0 acceptance criteria, machine
  -readable constants, and a "do not build" list), and the source survey kept as the
  evidence archive. All three carry the same 64 references and the same measured numbers,
  and the verification marks survive in each — without them the eleven-failure catalogue
  reads as a design constraint sourced from an unconfirmed third party.
- **The peg-escape comment in `forge-vcs.js` described coverage the code does not have.**
  The header claimed every path handed to `svn` goes through `svnPegSafe`; only
  `svnIsTracked` does, while `svnRevertBatch` and both argv-routed reverts pass raw targets
  — in a file marked SAFETY-CRITICAL, the kind of note that makes the next reader assume an
  invariant that does not hold. Narrowed to what is true, with the consequence measured (svn
  1.14.2): a raw target containing `@` gets `E200009` from `svn revert` in both the argv and
  the `--targets` form, and the batch form aborts the whole set, leaving a second innocent
  path in the same batch unreverted. The failure is closed and loud, so nothing is applied by
  halves.

## v4.2.0 — The terminal gains zoom, images and a screen of its own

Three movements, one screen. The terminal was a real emulator with none of the affordances
that make one usable, sitting behind a modal that asked what you wanted before letting you
do anything. SwiftTerm ships `zoomIn`/`zoomOut`/`zoomReset` as **empty stubs**, never calls
`registerForDraggedTypes`, and its `paste(_:)` reads only `.string` — so there was no zoom, a
dropped file did nothing, and a pasted screenshot was discarded in silence. All three are
additions in `ForgeTerminalView`, so the vendored dependency stays upgradable.

### Added

- **Zoom by pinch and ⌘= / ⌘− / ⌘0**, one size for every tab, persisted, with a floating HUD
  instead of a control pinned to the toolbar.
- **Drop and ⌘V resolve to a path typed at the prompt** — the third method the Claude Code
  docs list — plus a floating thumbnail, because the terminal grid cannot hold the image
  (Claude Code repaints over anything drawn into it) and a path is not something you can see.
- **⌘F, ⌘T, ⌘W, ⌘1…⌘9 and ⌘⇧[ / ⌘⇧]**, scrollback from 500 to 10.000, and `currentDirectory:`
  at spawn instead of swapping the whole process's cwd. SwiftTerm's find bar existed all
  along and was simply never exposed.

### Changed

- **"Início" is removed, not renamed.** It had no content of its own left: the composer moved
  into Terminal, the run strips were a thinner `RunsView`, and the gate banner — the one
  thing that *was* unique — moved to Terminal too. `rawValue` is the persistence key, so the
  fallback moves to `.terminal` and anyone with "Início" saved lands on the screen that
  absorbed it. The orange badge followed its meaning (something is asking you) rather than
  its position.
- **A run is not a terminal session, and the app now says so.** Runs are records on disk read
  by `forge-runs.js`; sessions are child processes that die with the app. `RunsView` and the
  terminal screen distinguish "Ir para o terminal" from "Abrir aqui", and label a run with no
  session here.
- **The composer states where it will run instead of demanding a project.** With no project,
  a shell or a plain conversation opens in the configured session root, and only a
  `/forge-*` command still requires one — because a wrong-repo dispatch is indistinguishable
  from a correct one. It also names the account it will actually use, with the source
  recorded: `env_active` (a token inherited by this app process outranks the registry) reads
  identically to the registry default on screen and means something different.
- **`TerminalView.swift` (571 lines, four responsibilities) is split by responsibility**, and
  the composer is lifted out of `NowView` so there is one input rather than two that drift.

### Fixed

- **`resume()` built `claude "/forge-auto <id>"` with no `--account` while labelling the tab
  with the run's account** — the tab named one account and the shell ran on another.
- **`applyFontSize` is idempotent by contract.** SwiftTerm's font setter calls
  `selectNone()`, so the old `applyTheme` was clearing the operator's text selection on every
  unrelated SwiftUI rebuild.
- **One guard suite had gone vacuously green.** It forbade `LocalProcessTerminalView(frame`
  in `makeNSView`, a name the subclass rename made unreachable, so the original bug could
  have walked back in under a passing test. Four suites that pinned the old shape were
  updated with the reason rather than the number, and new guards pin that "Início" cannot
  return unannounced, that the `lastSection` fallback names a section that exists, that
  `draggingEntered` never writes to disk, and that a slash command still cannot launch into
  the session root.

## v4.1.0 — What a project is, and what the screen may claim about it

Two things landed here and they are the same thing seen from two ends. The milestone
`M-20260802185210-workspace-root-forge` gave Forge a real notion of *where it lives* —
roots, workspaces, ownership, addressable runs. The Projects screen was then looked at,
and the look found that almost everything it said about a project was either nothing or
false. The rule that came out of both, and that governs every change below: **a screen may
only claim what was measured, and an absence that was measured must never render like an
absence that was not.**

That rule is not decoration. It was earned: two real repositories were reported as "sem
git" on a screen with 465 green tests, because nothing distinguished *git was asked and
said no* from *git was never asked*.

### Breaking

- **`.gsd/` no longer means "a Forge project lives here".** Detection is by *substance* —
  `scripts/forge-workspace.js` and `app/Sources/ForgeKit/ProjectMarker.swift` classify a
  directory as `project | touched | none` by what is inside `.gsd/`, not by its existence.
  A directory a run merely walked through is `touched`, and the Projects screen lists those
  separately instead of promoting them. Anyone whose registry was full of incidental
  entries will see the list shrink; nothing is deleted from disk.
- **Four scripts stopped manufacturing `.gsd/`.** `forge-verify.js`, `forge-lock.js`,
  `forge-dashboard.js` and `forge-runs.js` each created the directory as a side effect of
  running, which is what made the marker meaningless in the first place. They now resolve
  the owning project and refuse — `ENOGSD`, `ENOTPROJECT` — rather than inventing one.
- **`.gsd/STATE.md` at the root is a generated projection**, not a source of truth, and is
  no longer documented as one anywhere. It is written by `scripts/forge-dashboard.js` under
  a lock and carries an `AUTO-GENERATED` marker. A run's durable state lives in
  `M###-STATE.md`. This is a documentation revocation with a scanner behind it
  (`scripts/forge-doc-claims.js`), because the previous acceptance criterion for it was
  vacuously green — `grep` in the maintainer's shell honours `.gitignore`, and
  `.gitignore` lists the file that carried the claim.

### Added

- **Workspaces, and ownership.** A workspace is a project that contains other registered
  projects; the hierarchy is derived rather than declared, and ownership resolves by
  *nearest project wins*. The registry became versioned (`{version, roots[], entries[],
  quarantine[]}`) instead of a flat list of strings, and the live migration ran with a
  reviewed dry-run and a preserved `.bak`.
- **A run has an address.** `scripts/forge-run-address.js` resolves `run → root → project →
  repo`, byte-identically from any cwd, with every hop carrying `{path, name, source,
  reason}` — `source` separates a recorded fact from a derived one, and each of the nine
  degradations has a name instead of a silent `null`.
- **An overlap signal between concurrent runs.** `forge-touch.js` records which files a run
  touched (derived from git, not from the evidence log — git answers the question the merge
  will actually ask), and `forge-overlap.js` compares snapshots with a full census. It is
  advisory and deliberately *not* an integration queue: no ordering, no merge blocking, no
  recommendation about who merges first. A test asserts that absence.
- **The Projects card says what the project is.** Identity from `PROJECT.md`, last delivery
  from the ledger, git state, detected stack. It previously showed counters that were
  always zero.
- **Real brand marks, vendored, with no new dependency.** Ten SVGs from Simple Icons (CC0)
  and Octicons (MIT), checked in with provenance and licence — stacks, git hosts, and the
  branch glyph. Measured on fourteen real projects, the previous SF Symbol shapes put nine
  cards on one triangle and three on one hexagon; the slot carried about one bit. Every
  mark still carries its SF Symbol, so an unresolvable asset degrades to last week's icon
  rather than to a blank square.
- **The git row is paired icon+text segments** — repository name beside the host mark,
  branch beside the branch mark, changes and divergence each with their own colour. The
  repository name comes from the same `.git/config` read as the host, so it costs no new
  spawn, and it is never substituted with the folder name when there is no remote.

### Changed

- **`GitStatus` separates measured from unmeasured** — `.state` / `.notARepository` /
  `.unavailable(reason)`, and they cannot collapse. The underlying cause of the "sem git"
  bug was cooperative-pool starvation: forty concurrent probes returned thirty-two nils in
  twenty seconds. `Git.invoke` no longer parks a cooperative thread on a semaphore; the
  fixed path returns zero nils in 0.29 s.
- **The default branch is resolved, not guessed.** `GitDefaultBranch` reads `origin/HEAD`
  and then the first of `main`/`master` that exists — from refs on disk, 0.9 ms/card
  against ~40 ms for a spawn, agreeing with `git symbolic-ref` on 14/14. It deliberately
  differs from `gitDefaultBranch()` in `forge-isolation.js`, which ends in `return 'main'`:
  a script that must check something out needs a name, a card must not invent one.
- **Host marks are drawn only for a measured host.** `GitRemote` has four non-collapsing
  cases, and real disk supplied the two that theory missed — an SSH host alias
  (`git@github-personal:`) which keeps its repository name but is not github.com, and a
  genuinely remoteless repository.
- **"Tocados por outro projeto" carries its evidence.** Each row shows the folder name,
  what was found inside the `.gsd/`, when it was last touched, and whether there is a git
  repository — so the decision the row asks for has something to stand on. The remove
  action gets the destructive icon and colour, and the word "Remover da lista", because it
  drops a registry entry and deletes nothing from disk.
- **Worktree cleanup is git-primary.** The registry knew about two of eleven real
  worktrees; asking git is the only way to find the rest.

### Fixed

- **`tier_models` actually routes.** The tier resolution produced a full model ID while
  `Agent()` accepts only the four short aliases, and the dispatch omitted the parameter
  entirely — so editing `tier_models.<tier>` had changed nothing, silently, since it
  shipped. `scripts/forge-model-alias.js` is the single canonical map; an unmapped ID omits
  the parameter and warns rather than passing an ID that would break the call.
- **A hazard notice told the operator to delete a legitimate workspace.** It keyed on
  containment count with no reference to the role at all. Found by looking at the screen
  with seventy-six suites green.
- **Registry round-trip defects** — `missing: true` dropped on load, an absolute path
  leaking into the file — plus a containment guard that now throws when row counts differ
  across a rewrite.

### Notes

- The version stamp reads from `git describe`, which was finding a milestone tag with no
  version shape; this release restores it.
- Baselines at the cut: **498** Swift tests, **79** JS suites, **2042** smoke assertions,
  zero failures.

## v4.0.0 — The board you can read

The kanban shipped in `M-20260730101543` and then got looked at for the first time. Every
change here came from that look, and none of it was reachable by the suites: no agent on
this machine sees a screen, which is exactly why a board with three different badge
heights, an invisible accent bar and a filter that could only ever return nothing passed
sixty green suites and six dialectic reviews.

### Breaking

- **macOS 13–25 are no longer supported.** `app/Package.swift` moves from `.macOS(.v13)`
  to `.macOS("26.0")`, which is what the container drag APIs require — dragging a card
  between columns was deferred in the roadmap for precisely this reason and is now
  delivered. This is the whole reason the release is major: the app simply will not run
  below 26. (`.v26` does not exist in this toolchain's `PackageDescription`; the string
  form does.)

### Added

- **Drag a card between columns.** `BoardGesture` gains `.drag`, and the D9/F7
  counter-criterion — five organising gestures must produce zero terminal sessions — is
  proved for it by **both** sides of the shared fixture rather than inherited from
  `.move`. Organising a board still cannot originate work.
- **`blocked_by` on an item**, encoded exactly like `labels`: a comma-separated scalar on
  disk, an array only at the `--list --json` edge. The encoding is not a preference — S01
  proved that a YAML list here is silent data loss, since the continuation lines fail
  `parseItem`'s `^key: value` regex and the key vanishes on the next write with no error
  and no exit code, across every item fragment in the repo.
- **The body renders as markdown** in the detail sheet — headings, lists, quotes, rules,
  and fenced code kept verbatim, so a diff pasted into an item is not chewed into headings
  and bullets. It was showing raw source before.
- **Signals the board never had**: task age on a thermal ramp (grey → blue → yellow →
  orange → red, and always quiet on a closed item), checklist progress counted off parsed
  blocks so a `- [ ]` inside a fence is not mistaken for a checkbox, a blocked badge, and
  a project badge when more than one project is on screen.
- **Every project at once.** No project selected now means *all of them*, not *nothing*.
  Each item carries which project it came from, so a status change on that board reaches
  the right `--cwd` instead of whichever project happened to be selected.
- **Developer-mode badge** in the sidebar footer, gated by `#if DEBUG` — not by a
  describe heuristic, which answers a different question ("has commits beyond the tag" is
  true for a release cut mid-cycle and false for a debug build of a clean tag).

### Changed

- **The card shows three elements at rest, not seven.** This reverses criterion #4, the
  spine of S04: at 268pt the seven were a paragraph and roughly three cards fit on a
  screen. Body, id, source and closing date **moved** rather than vanished — the detail
  sheet, a hover expansion after a one-second dwell, and a copy button — and the guards
  assert the destination, not merely the absence.
- **Search and label filter are separate controls.** Search matches title and id by
  substring, which is what a board whose items carry no labels actually needs; the label
  filter stays exact, because criterion #5's parity against `jq '.labels|index(…)'`
  depends on it. One box would have to pick one semantics and quietly break the other —
  with substring, `ui` matches `ui-bug`, the one-card divergence the criterion calls a
  failure.
- **The sidebar footer is the version, and only the version.** "Adicionar projeto" left
  it: the action already lives in the app menu, the Projects toolbar and the Projects
  empty state, and at the 180pt minimum width it was crowding the one thing a footer is
  for.

### Fixed

- **Colour that meant nothing.** Label chips derived their tone from a sum of unicode
  scalars, which put `bug`, `ui`, `progresso` and `d8` — four of the repo's five real
  labels — on the same slot. FNV-1a spreads them, and a test now fails if the five real
  labels collapse into fewer than four tones.
- **Two `Toast` types one word apart** in the same module, one global and one nested in
  `AppState`. The board's is now `ItemToast`.

---

## v3.5.0 — The route that ran, on the record

A unit that fell back from the sidecar to Claude left one line in `events.jsonl` and
nothing else, so an entire slice could run on the wrong engine and read as perfectly
normal. The record now names the engine that actually ran, every time, including when
nothing went wrong.

### Added

- **A slice can no longer lose its configured route in silence** (`TASK-021`). When a unit routed to the sidecar falls back to Claude, the only trace used to be one line in `events.jsonl` — so a whole slice could run on the wrong engine and read as normal. `scripts/forge-route-audit.js` derives the record from the event log and writes the `## Route` section into `S##-SUMMARY.md` itself; `forge-completer` only invokes it (sub-step 1.85) and never authors the prose, which is the entire point — the failure this closes was a narration that contradicted a warning the harness had already printed. Drift is decided by **two** signals, not one: a `worker-engine-fallback` event, **or** `engine_final != engine_attempted[0]` — the cross-engine chain walk changes engine without announcing it, so anchoring on the fallback event alone would have missed that class entirely. The section is emitted **always**, including when clean (`rota configurada rodou em N/N tasks`): silence is indistinguishable from a detector that never ran. Advisory — exit 0 in every circumstance, never blocks a complete.
- **`worker-engine-fallback` carries the resolver `hint`.** The value was already computed and echoed to the terminal; it was never recorded, so the exact fix for a refusal ("declare `repo: <name>` in the plan frontmatter") lived only in a scrollback nobody re-read. It now reaches the audited artifact. The hint is taken **from the event or not at all** — a static `reason → hint` table is forbidden, since `hintFor` depends on `declared_repo`/`repos_touched` and a table would be model-authored truth recompiled.

### Fixed

- **The `hint` field would have shipped permanently empty.** `$CODE_DIR_HINT` is assigned in the `CODE_DIR`-resolution fence and read in the fallback fence — a **different Bash invocation**, where shell state no longer exists — and the plan-slice branch never assigned it at all. Caught by the dialectic review before the first commit and fixed by persisting the value across the fence boundary, then proven in two separate shell invocations rather than by reading. Without that catch this would have shipped the exact pathology it exists to detect: a gate that reads green and emits nothing.
- **A codex `plan-slice` dispatch was invisible to the audit.** The two plan-slice emitters wrote neither `slice` nor `milestone`, so a successful codex plan-slice went unrecorded and a fallback rendered `attempted=[claude]` — erasing the codex attempt from its own record. Both fields added additively.
- **RUN_ID is accepted as an alias of the milestone id.** Events record `milestone` as `${RUN_ID:-{M###}}` while the completer queries `--milestone {M###}`, so a codex dispatch and its Claude fallback could land under two spellings and count as two units. The audit folds them, reading the runs registry through `forge-runs.listAll`. The slice-only degradation path it replaces is deleted: a milestone with no evidence now reports `0 tasks` instead of borrowing another slice's dispatches under this heading.

---

## v3.4.0 — The version you are running

The app announced a version number that was the repository's tag rather than the binary
you had open — so on a machine where you pull without rebuilding, which is every machine
this is developed on, the number was confidently wrong. The sidebar now reports what is
actually running, says so from every screen, and shows both numbers when they disagree.

### Added

- **The installed version is readable from every screen** (`T-20260730020639-sidebar-secao`). The sidebar footer carries it, and it is the version of the **running binary**, not the repository's tag: `app/build.sh` stamps the `git describe` into the bundle's `Info.plist` (`ForgeGitDescribe`, plus `CFBundleShortVersionString` and `CFBundleVersion` for the Finder) between the plist copy and `codesign` — before it, and every build would dirty the versioned file; after it, and the signature would be invalid. When the repository has moved on since that build, the footer shows both numbers with the second one labelled `repo`, which is the "I committed and forgot to rebuild" case the old display could not represent at all. The number is clickable and lands on Atualizações from anywhere in one click. A build that was never stamped says so — the sentinel is the **absence** of the custom key, never a comparison against the `0.1.0` placeholder, which is also a perfectly legitimate version to ship.
- **One update signal instead of two, and a rule where the list changes register.** The numeral beside "Atualizações" in the sidebar is gone: it was always `1`, so it counted nothing — a dot wearing a number. The signal now lives in one place, on the footer where the version already is, orange with a dot. A single `Divider()` after "Runs" separates the sections where work happens from the ones that hold configuration; the release list keeps five entries at rest, with the rest one click away and the cut taken strictly off the historical tail — the entry for the version you are running, the one you could move to, and anything unreleased are pinned into the visible window whenever they exist at all; and the update card lost the decorative disc that repeated what its own headline and orange border already said.

### Fixed

- **Two `## Unreleased` headings in this file, both of them stale.** `Release.id` is the version string, so the app was handing `ForEach` two rows with the same id — undefined behaviour in SwiftUI, and about to become visible now that the list is short enough for both to fall inside it. Each has been renamed to the version it actually shipped in, determined by ancestry rather than by guess (`git describe --contains` on the commit that introduced the block): the top one is **v3.2.0**, the one below `v3.0.0-beta` is **v2.5.0**. The rename alone would let this come back, so a test now fails if any two releases parsed from `CHANGELOG.md` share an id, or if `## Unreleased` appears more than once.
- **The sidebar never re-rendered when the update check finished.** `RootView` read `UpdateStore.shared` but did not observe it, so anything in that column that depended on an update being found was born empty and stayed empty until something else forced a redraw. Pre-existing, and load-bearing for everything above: it is why the footer populates on its own when the launch check returns.

---

## v3.3.0 — An installer you can watch

Two tasks about the same complaint: the app would not tell you where it stood while it
updated itself. It ran behind a spinner with nothing beside it, and it could only be made
to run the installer when a release happened to be pending.

### Added

- **The in-app installer shows what it is doing while it does it** (`T-20260729191241-atualizacao-barra`). "Atualizar" used to hand off to `install.sh` and then say nothing for minutes, so a slow update and a hung one looked identical and the only way to tell them apart was to give up. The installer now runs headless with its output streamed into the card: a phase label that is the answer on its own, a spinner that stops when the run does, and a log folded away because it is the appeal, not the answer — it is where a failed step explains itself. There is deliberately **no percentage**: the `swift build` alone dominates the wall clock, so any number would be invented, and a bar that stops moving is the complaint rather than the fix. The precheck that refuses to update a dirty or diverged checkout now says that the refusal is **protection** and names the command that clears it, instead of reporting a failure the operator has to interpret. Relaunch is offered only on exit 0, and the relaunch sequence was reordered so that cancelling the live-session alert no longer leaves two copies of the app running.
- **"Reinstalar"** (`T-20260730004115-afordance-reinstalar`) — reapplies agents, skills, scripts and the app from the checkout you already have, with **no git at all**: no fetch, no pull, no tag comparison. Two things follow. The progress UI above becomes reachable on demand rather than only in the minutes after a release appears; and the one state the precheck refuses — local commits, or a dirty tree — gains an action that works anyway. It renders next to "Atualizar" rather than instead of it, because an available-but-blocked update is exactly the state it exists to unblock.

---

## v3.2.0 — SVN in the sidecar, and the end of `environment` as a free pass

### Added

- **The multi-LLM sidecar runs against a Subversion working copy** (M017, phase 1). `scripts/forge-vcs.js` is the single owner of every VCS primitive the sidecar needs — detection, baseline id, post-run change set — with a closed sentinel per primitive so an unsupported VCS refuses by name instead of silently returning something plausible. `--mode execute` and `--mode plan` go end to end on an SVN checkout **without issuing a single git command**, and the surgical reset keeps its central safety property there: an operator's pre-existing dirty file survives a sidecar failure **byte-identical**, proven against a real `svn` fixture rather than a mock. `require_worktree` no longer strands an SVN checkout — activation resolves to `shared` with a reason that names SVN, instead of failing every repo and stopping the run. Isolation and worktree equivalence for SVN are explicitly **not** in this phase.

### Fixed

- **`scope: environment` stopped being a free pass** (TASK-020). The sidecar could mark a must-have `status: unknown, scope: environment` with an allowlist `reason`, and the pipeline accepted the work with the verification never having run. Measured **13 times across three sessions** — every one false; in one case 6 of 9 must-haves, the entire behavioural proof of a task, went unverified. Three holes that compounded:
  - The `git-commit-required` corroborator was tautological: `/\bgit\b|commit|push/i` over `item + note` meant any note that *mentioned* git corroborated itself — including one whose text was *"the task prohibits running any git command"*. It now reads `entry.note` only (never `item`, which is plan boilerplate echoed back) and requires a git **write** operation. This is the rigour `sandbox-exec-blocked` already had ten lines below, and which was never carried across to its neighbour.
  - The re-verification net was hung off a single reason. `needsReverification` and `affectedEntries` both filtered on `sandbox-exec-blocked`, so four of the five reasons never reached it. Both now share one predicate covering the four *execution-blocked* reasons. `gsd-write-refused` is deliberately excluded: a green test suite never touches `.gsd/**`, so its exit code cannot be evidence for a write-refusal claim — promoting it would have replaced silent acceptance with an attestation backed by irrelevant evidence, which the review caught and reproduced. **The trigger and the entry selector always move together**; narrowing one alone yields a gate that fires, spends a full suite run, and selects nothing.
  - Even when it fired, it had nothing to run here. Stack detection covered `package.json`/`go.mod`/`Cargo.toml`/pytest/`Makefile` and returned `null` in a zero-dep repo — so the net was blind to the very project that ships it. It now falls back to `CODING-STANDARDS.md § Lint & Format Commands → **Test:**`, discarding any candidate that needs shell parsing (globs, metacharacters, quotes, backslashes) because the spawn is `shell:false`. `--gsd-dir` is threaded to the CLI and the four mirrors, since `.gsd/` is not under `CODE_DIR` in worktree mode and walk-up would fail exactly where this runs.

  Proven on live data rather than a fixture: the sidecar produced a 13th false `git-commit-required` claim *during this very task*. The old code promoted it; the new code rejects it.

- **A smoke label that promised more than it measured.** Section 80 asserted "execute on SVN never invokes the PATH git shim" and passed — but a dogfood run against a real `svn` working copy with the real codex CLI showed the CLI probing `git … remote -v` on its own, a pattern absent from the forge codebase and non-fatal. The assertion is unchanged (the git log must still be empty); the label now says what it proves: forge's own code issues no git command. The mocked codex doesn't sniff for git, which is why it passed.

- **A guard that fired on prose, not on behaviour.** `forge-auto/SKILL.md exit '## Deactivate auto-mode indicator'` had been red on `master` since v3.1.0 — including at the v3.1.1 release. The assert anchors on the first match of the section title, but that title also appears earlier as an inline cross-reference inside the `status: partial` bullet; the 1000-char window from there covers the `status: blocked` bullet, and v3.1.0's item-capture block pushed the deactivation command out of it. Nothing had regressed — someone wrote prose nearby. It now anchors on the newline-delimited header, so it reads the section it claims to check. Verified by counterfactual: deleting the deactivation command from that section turns it red again.

### Known, not fixed

- The ambiguity gate (`hasDivergentCommandNotes`) only refuses when entries' notes name *different* runner tokens; a note naming none passes ungated. Tracked as an item.
- `/forge-init` writes `- **Lint:**`, `- **Format:**` and `- **Type check:**` but never `- **Test:**`, so the fallback above finds nothing in a freshly initialised project — the zero-dep projects that need it most. Tracked as an item.

---

## v3.1.1 — The vault stops crying wolf, and starts keeping receipts

### Fixed

- **The app was the reason the Keychain kept asking.** `SecretsView.add()` wrote the secret itself with `SecItemAdd` before calling the engine, on the theory that this kept the value out of argv. It did not: the engine's `security add-generic-password` needs the value in `-w` and ran immediately afterwards regardless. So the framework write avoided *zero* exposure while creating an item whose ACL trusts the ad-hoc bundle's cdhash — which changes on every rebuild, so every later read by `security(1)` came from an "unknown" binary and prompted. `VaultKeychain`, the call, the guard and `import Security` are gone; the engine is the only writer. **Existing secrets keep the old ACL** — purging it needs `forge-secrets remove <svc> <name>` *then* `add`, because `--add` alone uses `-U`, which updates the item and preserves the ACL.
- **"Registrado sem valor no cofre — readicione", for a secret that was fine.** `list()` computed `has_secret` as `!!get(...)`, and `get()` returned `null` for *every* failure — a denied prompt, a locked keychain, the 5-second timeout. A healthy credential listed as missing and the UI told the operator to redo work. `get()` now sits on a three-state probe (`present|absent|unknown`) with an **allowlist**: only exit 44 (Keychain) and `ENOENT`/missing key (file) mean absent; everything else is unknown. A blocklist would have re-introduced the same defect through any error nobody thought to enumerate. `get()` keeps its `string|null` signature, so the seven existing assertions were untouched.
- Two texts that were also false: the claim that a secret added in the app "não passa por linha de comando", and the `·` footnote telling an operator who had just run `--verify` to run `--verify`.

### Added

- **Keychain write-failure diagnostics** (`scripts/forge-keychain-diagnostics.js`). `storeSecret` used to swallow a `security` failure and fall back to the 0600 file silently, so a failed write left no trace beyond a `store` field. Both write paths now record the exit code, signal, trimmed stderr, whether the fallback was used, and enough process context to settle whether a sandbox is involved — to `~/.claude/forge-keychain-diagnostics.jsonl`, capped at 256 KB, readable via `forge-secrets --diagnostics`. The secret value is never recorded, and a test asserts a sentinel value never reaches the file.

### Known, not fixed

- A separate macOS dialog — **"Chaves Não Encontradas: não foi possível encontrar as chaves para armazenar «\<user\>»"** — is a *store* failure, not the authorization prompt above, and its cause is still open. Two hypotheses were investigated and both failed verification, so nothing was changed on a guess. The diagnostics added in this release exist precisely so the next occurrence produces evidence.

---

## v3.1.0 — A backlog for the work Forge already defers

Forge has always produced work items it then had nowhere to put. A conceded review
objection became a line of prose in `KNOWLEDGE.md`; a deferred plan-gate finding became a
note in a marker the milestone cleanup later deleted; a blocked unit became an event nobody
read. This release gives those deferrals a destination, and gives the app a default project
so it stops asking where you are before every line.

### Added

- **Item store** (`scripts/forge-items.js`, `.gsd/items/`). One markdown fragment per item, per project, in the same merge-safe shape as `.gsd/decisions/` and `.gsd/ledger/` — two branches can each create items and merge without conflict. Closed status set (`inbox → triaged → doing → done|dropped`); anything else is an error, not a warning. IDs are `I-<timestamp>-<slug>` and resolve by any unique prefix, git short-sha style — an ambiguous prefix names its candidates instead of guessing. Durable across `milestone_cleanup`, like the ledger.
- **Auto-capture at the junctions that already existed** — a review follow-up, a plan-gate `Deferir`, a blocked unit, and the standalone-task review boundary all now create an item carrying its own provenance (`source`, `file:line`, sha, milestone). No new decision points were invented. Cutover, not dual-write: the item is the single destination and the old file keeps a one-line pointer, so `KNOWLEDGE.md` still shows the trail without holding a second copy of the truth.
- **Read-back into the loop** (`shared/forge-items-readback.md`). `/forge-task <item-id>` resolves an item, carries its provenance into the brief, marks it `doing` and records `promoted_to`; `/forge-new-milestone` lists open items as input before the brainstorm. Without this the store would be the write-only graveyard it was built to replace.
- **Items board in the macOS app** — a sidebar screen with columns by status and an open-item count on each project card. Every read and write shells out to `forge-items.js`; Swift never reimplements store semantics, so a status transition means the same thing in both front-ends.
- **`app.default_workspace` and `app.session_root_dir`** — the composer preselects a configured project (falling back to last-used) and always renders the destination before send. `shell` and `chat`, which need no project, open in the configured root directory.

### Fixed

- **The app no longer has any implicit workspace fallback.** `b992edf` removed `workspaces.first` from the composer because it dispatched into whichever repo sorted first — a wrong-repo `/forge-auto` that looks exactly like a correct one. Two more copies survived in `LauncherSheet` and one in `launch(account:)`. All three are gone, and `scripts/forge-app-workspace.test.js` is a standing, platform-independent guard that fails if any of them returns.
- **The app could not update itself.** `UpdateStore.runUpdate()` shelled out to `install.sh --update`, but the Swift build is gated behind `--with-app` — so the button refreshed every agent, skill, script and hook, reported success, and left the one binary the operator was looking at on the old version. It now passes `--with-app`, and because replacing a bundle does not replace the running process, the card offers "Reabrir na nova versão" instead of letting a stale window look current. `scripts/forge-app-update.test.js` guards both, and asserts the `--with-app` gate in `install.sh` still exists so the first assertion cannot quietly become vacuous.
- **`install.sh` was not executable in the repository** (mode `100644`), so `./install.sh` — the command the README gives — failed on a fresh clone.

### Notes

Every slice went through the dialectic review with an external challenger (Codex, deliberately the opposite model family from the author). Thirteen objections: ten conceded and fixed, three withdrawn after the author's defense, none left open. The ones worth knowing about were an undefined `$PICKED_IDS` that would have made item absorption silently inert, `app.*` preferences resolving from the project layer despite the schema promising global-only, and an unguarded async load that could show one project's items under another's name.

---

## v3.0.0-beta — Gate protocol and the macOS app

Two things that only make sense together: a way for an autonomous run to ask a
question, and somewhere to answer it.

### Added

- **Gate protocol** (`scripts/forge-gate.js`). `AskUserQuestion` is not served to headless sessions — verified: the tool is absent from the `system/init` list — so `/forge-auto` could have autonomy or interactive gates, never both. Gates travel as files under `.gsd/forge/gates/`, the same shape Forge already uses for `pause` and `handoff-request`. Every gate carries a timeout and a declared default, so nobody answering resolves to the safe option instead of blocking forever.
- **`review.ask_in_auto: gate`** — a third posture beside `defer` and `pause`. Asks without pausing: a timeout resolves as deferred so the milestone-final triage still surfaces it, and the artefact records whether a human or the clock decided. Opt-in; `defer` remains the default.
- **macOS app** (`app/`, built by `./install.sh --with-app`). A second front-end over the same `.gsd/` files — the terminal stays first-class. Answer gates, watch runs with progress and next action, manage accounts by real headroom, edit preferences generated from the schema, read release notes, and see what the runs cost. Includes a real embedded terminal (SwiftTerm), so work starts in the app rather than being delegated to Terminal.app.
- **Secrets vault** (`scripts/forge-secrets.js`). Tokens for external CLIs in the Keychain, injected into the child process by `forge-secrets exec` and nowhere else. Several entries per service (`railway/producao`, `railway/staging`), with ambiguity treated as an error rather than a guess. There is deliberately no command that prints a secret.
- **Metrics** from `.gsd/forge/events.jsonl`, which the orchestrator has been writing since M002 and nothing was reading: spend and tokens by model, engine, phase and domain.
- **Swift test suite** (`swift run ForgeKitTests`, wired into `node scripts/run-tests.js`).

### Changed

- MCP credentials move to the vault. The Figma key was plaintext in `~/.claude.json` and passed as a command-line flag; it is now in the Keychain and injected at launch. `shared/forge-mcps.md` documents the pattern and the checks that decide whether a server can be converted at all.
- `forge-accounts --list --json` also emits `email`, `account_uuid` and `email_source` (additive; the token is still only available via `--token`).

### Fixed

- **Every `bin/` wrapper read the retired markdown preferences file.** After the move to JSONC, `forge-run`, `forge-accounts` and `forge-status` could no longer resolve `repo_path`, so the repo fallback was dead in all of them.
- Preference editing could corrupt list-shaped values: nine knobs are arrays or objects and fell through to a text field that wrote them back as a single string.

### Beta caveats

- The app is ad-hoc signed. macOS therefore refuses it as a notification source — gate alerts fall back to a plain banner without action buttons — and re-asks for Keychain authorisation on every add or verify. A Developer ID resolves both; nothing else in the app depends on it.
- Windows and Linux are unaffected: the app is macOS-only and `install.sh` builds it only with `--with-app`.

---

## v2.5.0 — Cost-aware dispatch and native Claude Code runtime controls

### Added

- Deterministic, bounded Claude prompts materialized from versioned dispatch templates, with selective memory and coding-standard budgets.
- Adaptive policy for durable-memory extraction and review depth (`skip`, `flags`, `dialectic`), with conservative high-risk defaults.
- Per-call telemetry (`dispatch_id`, `prompt_id`, attempt, status and token estimates) and a cross-platform standalone test runner.
- Bounded Claude subagents, `SubagentStop` result-contract enforcement and optional experimental agent-team resumption.

### Changed

- Sidecar file changes are Git-derived and authoritative; model-declared paths are advisory only.
- Installers deploy and back up dispatch templates. The preference schema adds cost-policy controls.

### Fixed

- **The smoke suite spent real money on Windows.** The mock `codex` was a `#!/bin/sh`
  file, which `CreateProcess` cannot execute, so `resolveCodexCommand()` fell through
  to whatever `codex` was on `PATH` — a real, billable one. `forge-xllm.js` now honors
  `FORGE_XLLM_CODEX_BIN` (mirroring `FORGE_XLLM_AGY_BIN`), and the suite injects a Node
  shim that runs the same POSIX fixture through Git's own `sh.exe`, resolved from
  `git --exec-path` with its `usr/bin` prepended to the child's `PATH` so `cat`,
  `printf` and `sleep` resolve outside Git Bash. Bare `sh` was not enough: PowerShell
  has none on `PATH`, and bare `bash` there is WSL's — a different filesystem view.
- **Phantom drift reported against correct documents.** Repo docs are matched with
  LF-anchored regexes and `indexOf` anchors, but `core.autocrlf=true` with no
  `.gitattributes` delivers CRLF on a Windows checkout, so every anchor missed and the
  assert blamed the document. Repo text is now normalized on read.
- **Silent data loss in per-milestone STATE files.** `forge-state.js` parsed a `##` section
  down to its first line only, so every write path (`--update`, `--push-recent`) reserialized
  the file with the rest of `## Recent units (last 10)` and `## Notes` erased — exit 0, no
  warning. Installed copies have been dropping unit history since the per-milestone STATE
  format shipped; the loss is only visible by re-reading the `.md`. The truncated history
  cannot be recovered, but no further lines are lost after this fix.

### Documentation

- Added `docs/cost-optimization.md`, including Claude Code commands that complement the Forge workflow.

---

## v2.0.0 (2026-07-20) — Corte do md-legacy de prefs: JSONC-only

### BREAKING

Preferências em Markdown não são mais lidas. O engine (`forge-prefs.js`) dá
hard-stop estruturado `legacy-md-without-jsonc` quando uma camada contém
Markdown sem o catálogo JSONC correspondente; o template
`forge-agent-prefs.md` também foi removido do repositório.

O comando de migração é o da mensagem canônica em
`shared/forge-prefs-cutover.md § Canonical message` — use exatamente a
fórmula `node "{command}" --cwd "{cwd}"` (com `{command}` substituído pelo
caminho de `forge-prefs-migrate.js` e `{cwd}` pelo workspace). O migrator
converte as camadas global e local e sempre preserva o original em `.bak`.

O caminho de upgrade comum, sem susto, é rodar `install.sh --update` ou
`/forge-update`, que auto-migra a camada global, e `forge-doctor --fix`, que
migra a camada local. O hard-stop é um backstop e o usuário típico não o vê.
Em workspace já-jsonc não há mudança observável: os bytes permanecem
idênticos.

### Changed

- Chokepoints de instalação e `/forge-update` agora auto-migram antes de
  entregar o controle aos consumidores.
- `forge-doctor --fix` migra a camada local e reporta a mesma mensagem
  canônica quando a correção não pode ser aplicada.
- O reader legado real foi realocado para o migrator; engine e skills não
  emitem mais warnings de depreciação mortos.
- A documentação foi varrida para manter grep-zero de fontes Markdown
  legadas e para remover descrições de dual-read.

### Removed

- Template `forge-agent-prefs.md` do repositório.
- Warnings de depreciação sem efeito no engine e nas skills.
- Leitura Markdown no engine; a compatibilidade fica restrita à migração.

### Notes

- A entrada canônica e o contrato de erro permanecem em
  `shared/forge-prefs-cutover.md`; consumidores não devem improvisar outra
  mensagem ou outro código.
- A migração é segura para reexecução: o JSONC validado fica ativo e o
  backup `.bak` conserva o Markdown de origem.

## v1.35.0 (2026-06-15) — Multi-conta redesenhado: default vs launch, display por identidade, resume run-aware, cross-platform

Revisão estrutural do multi-conta. Tudo backward-compatible (single-account e fluxos `use`/`forge-run` existentes seguem iguais).

### Added

- **`claude` puro entra na conta default automaticamente** via `forge-accounts shell-init` (zsh/bash) e `--shell-init-pwsh` (PowerShell `$PROFILE`). Instaladores adicionam o hook ao rc/`$PROFILE` de forma idempotente (`install.sh` já; `install.ps1` agora).
- **Modelo default vs launch:** `forge-accounts default <nome>` (seta default sem lançar), `launch <nome>` (lança sem mudar o default) e **`claude --account <nome>`** (fixa um terminal) — habilita **N terminais em N contas ao mesmo tempo**.
- **Display por identidade real:** sem `FORGE_ACCOUNT`, a statusline lê `~/.claude.json` e casa uuid/email contra o registro → `👤 <nome>` mesmo em login manual do Keychain (cache por mtime; render normal = 2 `stat()`). Identidade gravada via `forge-accounts set-email <nome>` (sem `--email` captura a sessão atual).
- **`forge-accounts launch-prep`** (resolve conta+token numa chamada) e **normalizador de subcomando** no engine (permite `forge-accounts <sub>` sem tradução em batch — base do wrapper Windows `bin/forge-accounts.cmd`).
- **New-window cross-platform:** macOS (osascript), Linux (gnome-terminal/x-terminal-emulator/konsole/xterm), Windows (`.cmd` + `wt.exe`).

### Changed

- **Resume run-aware:** trocar de conta / abrir nova janela só retoma `/forge-auto <RUN_ID>` quando existe **exatamente um** run ativo no projeto (0 ou 2+ → sessão `claude` normal). Antes forçava `/forge-auto` sempre que havia `.gsd/`.
- **Run record** ganha campo `account` (additivo), gravado pelo orquestrador (`--account "${FORGE_ACCOUNT:-}"`).

### Notes

- Captura automática de identidade por-render foi deliberadamente **removida** (uma sessão lançada por token nem sempre reescreve `~/.claude.json` → risco de gravar a conta errada). Captura é sempre explícita via `set-email`.
- Regression guards na Section 16 do `forge-smoke.js` (164/164). Windows é best-effort (validado por revisão; sem `pwsh` no ambiente de dev).

---

## v1.36.0 (2026-06-15) — forge-sweep model-invocable at end of cycle

### Changed

- **`forge-sweep` is now model-invocable (`skills/forge-sweep/SKILL.md`):** removed `disable-model-invocation: true`. The orchestrator can now run the sweep directly via the `Skill` tool at the **end of a milestone/task, once the human has validated the delivered work** — no need for the user to type `/forge-sweep` and no magic confirmation phrase (the positive validation feedback in the conversation is the go-ahead). A new **`## Invocation policy`** section codifies exactly when auto-invocation is allowed and forbidden.
- **Single confirmation gate — the "re-type with `--apply`" step is eliminated for the end-of-cycle flow:** the recommended path invokes the skill with `--apply` from the start. Step 3 still prints the full preview before any write, and the Step 5 `AskUserQuestion` popup fires as the single final reminder (one yes/no, so a distracted dev isn't surprised). Bare `/forge-sweep` (no args) remains a safe preview-on-demand for anyone.
- **Risk-aware fallback:** the orchestrator must NOT auto-apply — it falls back to a dry-run + explicit user authorization — when the preview surfaces a specific risk: an AUTO-MEMORY entry flagged `review`, a milestone/task dir skipped for a missing `LEDGER.md` entry, an active milestone phase in `STATE.md`, or a dirty working tree that makes the trim hard to review.

### Why

The previous `disable-model-invocation: true` flag (added in v1.16.0 because the sweep is destructive) forced the user to type `/forge-sweep --apply` explicitly even after work was already validated and the orchestrator had announced the sweep as the next step. The destructiveness is now guarded by the conversational human-validation gate + the in-skill confirmation popup + risk-aware fallback, rather than by blocking model invocation entirely.

---

## v1.16.0 (2026-05-22) — forge-sweep skill

New maintenance skill, promoted from a project-local draft used in production (a reference deployment / custody-transfer).

### Added

- **`forge-sweep` skill (`skills/forge-sweep/SKILL.md`):** prunes ephemeral GSD know-how files per a single-source-of-truth team policy — drops low-value `AUTO-MEMORY` entries (keeps `confidence >= 0.90 AND hits >= 2 AND` cross-cutting), drops `DECISIONS` rows that aren't architectural invariants, trims completed milestone/task directories **in place** (keeps only `*-SUMMARY.md`, requires a matching `LEDGER.md` entry as a safety gate), and removes closed `ask-*` sessions. Default run is a **dry-run preview**; `--apply` executes after an `AskUserQuestion` confirmation (`--force` skips it). `--scope task|milestone` narrows the sweep. `disable-model-invocation: true` — destructive, so never auto-invoked. Picked up automatically by both installers (skill-directory auto-discovery — no `install.sh`/`install.ps1` change needed). Goal: keep shared `.gsd/` files lean and merge-conflict-free for teams on SVN/Git.

### Docs

- `forge-help` and `README.md` skill tables now list `forge-sweep` under maintenance skills.

---

## v1.14.0 (2026-05-21) — M005 Multi-Run Cleanup

Polish + correctness fixes for issues discovered during the first real multi-run in production (M067 + M068 simultaneous in WHATSAPP OMNICHANNEL WORKSPACE). All changes are 100% additive — no breaking changes for single-run workspaces.

### Fixes

- **Heartbeat decoupling (S01):** orchestrator no longer writes `.gsd/forge/auto-mode.json` directly. All 9 heartbeat/deactivate sites in `skills/forge-auto/SKILL.md` now branch on `$RUN_ID`: multi-run uses `forge-runs.js --update` (which auto-refreshes the legacy alias via `refreshLegacyAlias`), legacy preserves direct `auto-mode.json` write. Eliminates race condition between concurrent tabs that caused worker/started_at fields to flip-flop.
- **`auto-mode-started.txt` per-run (S01):** removed shared `.gsd/forge/auto-mode-started.txt` write from the multi-run path. Each run's `started_at` lives in `runs/{id}.json` (set by `forge-runs.add` at activation). Legacy single-run still writes the shared file for backward compat. Fixes "AUTO 9m51s" showing M068's age when tab A was running M067 for 5h.
- **Stale auto-resume cleanup (S01):** `stale` branch of activation now loops `runs/*.json` and marks each `active:false` before fallback `auto-mode.json` cleanup. Prevents orphan runs in registry after Ctrl+C / OOM.
- **`{M###}` → `${RUN_ID:-{M###}}` sweep (S02):** 7 event-write sites in plan-check / checkpoint / housekeeping bash blocks now use `${RUN_ID:-{M###}}` for the milestone field. Resolves to `$RUN_ID` in multi-run, falls through to Claude's template substitution in legacy. Eliminates milestone field drift in `events.jsonl`.
- **Dashboard phase cross-reference (S03):** `scripts/forge-dashboard.js` reads `M###-STATE.md` via `forge-state.read` to show real phase + active_slice + active_task. Before always rendered `phase: —` (runs/{id}.json schema has no phase field). New output: `phase: execute-task · slice: S07 · task: T01 · worker: T01`.
- **Smart stale heuristic (S03):** `scripts/forge-statusline.js` and dashboard now compute effective heartbeat as `min(runs.last_heartbeat, mtime(M###-events.jsonl), mtime(M###-STATE.md))`. Runs with stale `runs/{id}.json` but fresh per-milestone artifacts (e.g. session_id mismatch pre-v1.13.3) are NOT filtered out of `isMultiRunMode`. Cobre cosmetic falla onde 2 runs ativas mas só uma aparecia na statusline.
- **complete-milestone deactivates run (S04):** `agents/forge-completer.md` step 7 (new) calls `forge-runs.js --update --json '{"active":false,"deactivated_reason":"complete-milestone"}'` after cleanup, then regenerates dashboard. Without this, completed milestones stayed `active:true` in registry indefinitely — dashboard kept listing them, counting toward `multi_run.refused_when_active_count` threshold.

### Added

- **`scripts/forge-smoke.js`:** end-to-end smoke test suite covering 8 sections (runs CRUD, lock, state migration, dashboard cross-ref, merger, file-lock cross-run, repos auto-detect, cli-helpers refuse). 47 assertions, runs in ~3.5s. `node scripts/forge-smoke.js` exits 0/1 — use as pre-release sanity check.

### Architecture (M005 decisions D-M005-1..12 — see .gsd/milestones/M005/M005-CONTEXT.md)

- D-M005-1 — Heartbeat orchestrator writes runs/{id}.json via forge-runs.bumpHeartbeat
- D-M005-2 — auto-mode-started.txt removed from multi-run path; runs/{id}.json.started_at is truth
- D-M005-3 — Dashboard cross-references M###-STATE.md for phase + slice + task
- D-M005-4 — Statusline stale threshold considers multiple heartbeat sources
- D-M005-5 — `{M###}` → `${RUN_ID:-{M###}}` sweep in remaining bash blocks
- D-M005-6 — complete-milestone deactivates runs/{id}.json + regens dashboard
- D-M005-7 — Smoke test automated in scripts/forge-smoke.js
- D-M005-8 — Soft pre-claim cross-run [DEFERRED to M006]
- D-M005-9 — auto-mode.json mantido como alias-only (no direct writes)
- D-M005-10 — compact-signal cleanup [DEFERRED — low priority]
- D-M005-11 — Smart stale heuristic in statusline (combinado com D-M005-4)
- D-M005-12 — No M005-SHADOW-STATE; standard worktree workflow

## v1.13.3 (2026-05-20) — M004 hotfix bootstrap M###-STATE.md

- fix: bootstrap M###-STATE.md on activate-new + re-load STATE post-activation (a04ed8a)

## v1.13.2 (2026-05-20) — M004 hotfix resume + statusline

- fix: resume updates session_id + statusline parses dashboard format (69f7d47)

## v1.13.1 (2026-05-20) — M004 hotfix migrate-legacy

- fix: migrate legacy STATE.md BEFORE dashboard regen in activation (caf94f2)

## v1.1.0 (2026-05-20) — M004 Multi-Run Workspace

### Breaking Changes

- `.gsd/STATE.md` raiz vira **dashboard read-only auto-gerado** (Multi-run mode). Single-run workspaces continuam funcionando via migração lazy ao primeiro boot multi-run — sem ação manual necessária.
- Workers (forge-executor, forge-discusser, forge-completer, forge-memory) escrevem decisões/memórias/eventos em arquivos **per-milestone** (`M###-DECISIONS.md`, `M###-AUTO-MEMORY.md`, `M###-events.jsonl`, `M###-CHECKER-MEMORY.md`) durante a run. Globais são merged em `complete-milestone` via `forge-merger.js` sob lockfile.

### Features

- feat: **Per-milestone state + runs registry** (S01) — `M###-STATE.md` substitui STATE.md raiz como source-of-truth de cada run. `.gsd/forge/runs/{id}.json` registra todas as runs ativas (kind: milestone | task).
- feat: **Hooks session-aware** (S02) — `forge-hook.js` resolve a run dona via `data.session_id` em todos os 6 phases. Evidence path scoped por run_id.
- feat: **Pause + compact-signal per-run** (S03) — `.gsd/forge/pause-{run_id}` e `compact-signal-{sessionId}.json` substituem globais. `/forge-pause M065` toggla scoped.
- feat: **Global merge sob lockfile** (S05) — `scripts/forge-merger.js` promove per-milestone files pros globais (DECISIONS, AUTO-MEMORY com cap-50 decay, LEDGER, CHECKER-MEMORY, events.jsonl) sob `mkdir`-mutex via `scripts/forge-lock.js`. Validado com 2 mergers concorrentes em NTFS sem corruption.
- feat: **CLI multi-run** (S06) — `/forge-auto <ID>`, `/forge-next <ID>`, `/forge-task <descrição>` aceitam ID args. Sem arg + 0 ativas = legacy fallback; 1 ativa = assume retomar; 2+ ativas = refuse + lista IDs.
- feat: **File-locks modo shared** (S07) — `scripts/forge-filelock.js` + `forge-hook.js` PreToolUse bloqueia Write/Edit cross-run quando outra run ativa segura o arquivo. Steal-on-inactive + steal-on-expired (TTL 60s). Orquestrador retenta 3× com backoff 5-30s jitter via `forge-classify-error.js` novo class `cross_run_file_lock`.
- feat: **Isolation modes** (S08) — `forge_isolation.mode: shared | branch | worktree` configurável em prefs. `scripts/forge-repos.js` auto-detect multi-repo via walk de subdirs `.git/`. `scripts/forge-isolation.js` setup/cleanup pra branch (`forge/{M###}`) e worktree (`.forge-worktrees/{M###}/{repo}/`).
- feat: **Statusline multi-run** (S09) — `forge-statusline.js` scaneia `runs/*.json`. 1 run = visual rico legado. 2-3 runs = compacto `● AUTO ×2 │ M065 ⚡T03 +12s │ M066 🔥S04 +1m`. 4+ trunca com `+N mais`.
- feat: **Docs** (S10) — `docs/multi-run.md` cobre 3 modes, locks, registry, CLI, troubleshooting. `forge-agent-prefs.md` ganha bloco `forge_isolation:` + `multi_run:` + `parallelism.cross_run_overlap:` scaffolded.

### Architecture (M004 decisions D-M004-1..12 — see .gsd/milestones/M004/M004-CONTEXT.md)

- STATE.md raiz dashboard regenerável; per-milestone state em M###-STATE.md
- Runs registry indexado por ID, kind=milestone | task
- Per-milestone artifacts → globals via merger sob lockfile no complete-milestone
- File-locks only em shared mode; defesa-em-profundidade em branch; auto-disabled em worktree
- Conflict de lock → retry 3× com jitter 5-30s
- forge_isolation.mode default = shared (zero quebra retroativa)
- Multi-repo auto-detect via walk de .git
- CLI exige ID quando 2+ ativas
- Hooks resolvem run via session_id
- Statusline linha compacta multi-run; trunca em 4+
- forge-memory promove per-milestone → global no merger
- auto-mode.json mantido como alias do oldest active (compat)

### Scripts added

- `scripts/forge-runs.js` — registry CRUD
- `scripts/forge-state.js` — per-milestone STATE read/write + legacy compat
- `scripts/forge-lock.js` — mkdir-mutex helper
- `scripts/forge-dashboard.js` — regen STATE.md raiz
- `scripts/forge-merger.js` — per-milestone → global promotion
- `scripts/forge-cli-helpers.js` — resolveRunFromArgs, refuse logic, newTaskId
- `scripts/forge-filelock.js` — cross-run file ownership tracking
- `scripts/forge-repos.js` — auto-detect git repos via walk
- `scripts/forge-isolation.js` — setup/cleanup branch + worktree modes

All 9 scripts auto-installed via existing `install.sh` / `install.ps1` globs — no installer changes needed.

## v1.0.0 (2026-04-15)

### Breaking Changes

- `/forge` replaces `/forge-auto` as the primary entry point; existing `/forge-auto` invocations continue to work via a thin shim
- `forge-auto`, `forge-task`, and `forge-new-milestone` commands migrated to skills (`skills/forge-auto/`, `skills/forge-task/`, `skills/forge-new-milestone/`); the original command files are now 6–7-line shims that delegate to `Skill()`

### Features

- feat: PostCompact hook recovery — `forge-hook.js` writes `.gsd/forge/compact-signal.json` when Claude Code fires the PostCompact lifecycle event while forge-auto is active; orchestrator detects the signal on the next loop iteration, re-initializes all in-memory state from disk, deletes the signal, and continues transparently
- feat: lean orchestrator — all 24 `{content of …}` artifact-inlining placeholders in `shared/forge-dispatch.md` replaced with `Read:` / `Read if exists:` path directives; workers resolve their own context in their isolated context window, cutting per-unit token growth from ~10–50K down to ~500 tokens
- feat: `/forge` REPL shell — new `commands/forge.md` (126 lines, < 5K tokens) is a compact-safe router with bootstrap guard, auto-resume detection, and an `AskUserQuestion` dispatch loop covering forge-auto, forge-task, forge-new-milestone, forge-status, and forge-help
- feat: skill migration with `disable-model-invocation: true` — three heavyweight commands converted to skills, shrinking command footprint from ~950 lines to ~20 lines of shims while preserving all logic in isolated skill contexts

### Architecture

- compact-signal.json recovery flow: PostCompact hook (forge-hook.js) → disk signal (`.gsd/forge/compact-signal.json`) → orchestrator reads/deletes on next iteration → transparent resume; existing COMPACTION RESILIENCE behavioral rule kept as fallback for Claude Code versions without PostCompact support
- workers read own artifacts: orchestrator passes paths, not content; workers call `Read` tool inside their isolated context — eliminates token accumulation across dispatch loop iterations
- `/forge` compact-safe token budget: REPL shell stays well within < 5K token re-attachment budget; compact recovery check runs at the top of every loop iteration

## v0.7.3 (2026-04-10)

### Features

- feat: add /forge-task command — autonomous task without milestone/slice hierarchy. Flow: brainstorm → discuss → research → plan → execute. Supports --skip-brainstorm, --skip-research, --resume TASK-###. Tasks live in .gsd/tasks/TASK-###/. forge-status and forge-explain updated.

## v0.7.2 (2026-04-10)

### Features

- feat: distribute decisions by phase — workers inject CONTEXT.md decisions instead of global DECISIONS.md; DECISIONS.md becomes audit overview for /forge-explain decisions

## v0.7.1 (2026-04-10)

### Performance

- perf: reduce context injection in worker prompts — DECISIONS.md capped at last 20 rows in plan-slice/plan-milestone/discuss (was full file), AUTO-MEMORY capped at 40 lines (was 80), T##/S##-SUMMARY injection capped at 35 lines each

## v0.7.0 (2026-04-09)

### Features

- feat: integrate skills via Skill tool — brainstorm/scope/risk-radar composable in workflow (837d746)
- feat: effort/thinking per phase, WebSearch in researcher, SubagentStart/Stop + PreCompact hooks (2b9d3b0)
- feat: AskUserQuestion + PlanMode in discusser, TaskList/TaskStop in orchestrators (9d0a79f)

### Other Changes

- Merge branch 'master' of https://github.com/vh2224/forge-agent (9c1fb90)


## v0.6.1 (2026-04-09)

### Bug Fixes

- fix: add UTF-8 BOM to install.ps1 to fix PowerShell 5.x parse errors (9402028)


## v0.6.0 (2026-04-09)

### Features

- feat: auto-mode indicator with blink, timer and stale detection (3c584e9)
- feat: show auto-mode indicator with elapsed time in status line (c28ce56)


## v0.5.0 (2026-04-09)

### Features

- feat: add auto_commit preference — let users opt out of git management (c773c4c)
- feat: add visual timeline to forge-auto and forge-next via TaskCreate (0b907c2)


## v0.4.0 (2026-04-09)

### Features

- feat: filter internal commits from /forge-update release notes (4920422)
- feat: show release notes on /forge-update and rename GSD Agent → Forge Agent (38746a1)

### Bug Fixes

- fix: emit next action hint after forge-next completes a unit (ba43da0)
- fix: add explicit autonomy rule to forge-auto to prevent pausing between units (18f1a5e)
- fix: repair install.ps1 form feed chars and clean up legacy gsd-* agents (da6453d)

### Other Changes

- refactor: unify forge-doctor + forge-fix into single command with --fix flag (5fe50d3)


## v0.3.0 (2026-04-09)

### Features

- feat: add /forge-fix — auto-correction for GSD project structure (90c6600)


# Changelog

## v0.2.0 (2026-04-09)

### Features

- feat: add CHANGELOG.md generation to release workflow (bfbba43)
