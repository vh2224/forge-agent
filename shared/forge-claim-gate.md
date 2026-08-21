# Forge Claim Gate — Cross-run write lease at the dispatch boundary

Authoritative spec for the **cross-run claim gate**: before an orchestrator dispatches a unit that
will write code, it records what that unit claims to write into its own `RunRecord` and confronts
that claim against the claims of every other active run sharing the same `CODE_DIR`. A measured
collision **stops the dispatch** — it never becomes a merge conflict discovered hours later.

This file is boundary-agnostic and has **three consumers**, exactly like `shared/forge-review.md`:

| Consumer | Boundary | MODE | Unit types gated |
|----------|----------|------|------------------|
| `skills/forge-auto/SKILL.md` | before each `Agent()` dispatch of a task in the ready batch | `auto` | `execute-task`, `review-fix` |
| `skills/forge-next/SKILL.md` | before the single `execute-task` dispatch of the derived unit | `interactive` | `execute-task`, `review-fix` |
| `shared/forge-review.md` (Steps 7a and 9) | before each `review-fix` dispatch | inherits the caller's MODE | `review-fix` |

**Formula-once is the point of this file, not a style preference.** The decision table (§ Step 3),
the canonical invocation (§ Step 2) and the escalation procedure (§ Step 4) live here **once**. A
consumer that restates any of them creates a second source that will drift, and the drift between
two orchestrators is exactly the failure this decomposition exists to prevent (S04-PLAN contract #1,
W5 of the risk radar). Consumers **reference**; they never re-derive, re-tabulate or re-implement.

## Enforcement: advisory na estreia, enforcing por decisão do operador

**Dois eixos, e eles não se fundem.** `parallelism.cross_run_overlap` decide **qual veredito** uma
colisão produz (`defer` × `block`). `parallelism.claim_gate` decide **se esse veredito é executado**
(`advisory` × `enforcing`, default `advisory`). Fundi-los foi explicitamente recusado (D1): a
postura responde "o que a colisão significa", a enforcement responde "quanto poder essa cerca tem
hoje" — e é só a segunda que muda enquanto a cerca ainda está provando que mede bem.

**Advisory computa e emite TUDO; só o ATO é suprimido** (D2). Sob `advisory` o módulo continua
percorrendo counterparts, aplicando o endurecimento D8, consultando a escada de release e chegando ao
mesmo `decision` que produziria sob `enforcing`. Os campos são aditivos:

| campo | significado |
|---|---|
| `decision` | o **veredito real** (`proceed`/`defer`/`block`/`refuse`), sempre. É dele que o critério de flip é medido. |
| `enforcement` / `enforcement_source` | a postura resolvida e de onde veio (`prefs`/`fallback`/`invalid-pref`/`explicit`). |
| `advised_action` | `dispatch` \| `stop`. É **isto** que o consumidor obedece — nunca `decision`. Sob `enforcing`: `dispatch` sse `decision === proceed`. Sob `advisory`: sempre `dispatch`. |
| `suppressed_action` | `null` sob `enforcing`; sob `advisory`, o `stop` que teria acontecido. **A supressão é nomeada, nunca silenciosa.** |

Um advisory que atalhasse a computação tornaria o critério de flip **imedível** — a diferença entre
uma estreia segura e um flag permanentemente cego.

**`--wait` é um ATO.** Sob `advisory` o módulo **não polla**: gastar o teto de `block_wait_ms` para
prosseguir de qualquer jeito queima o orçamento de tool-call do consumidor sem cercar nada. O
`decision` continua sendo o `block` real e viaja no evento; o que **não** é emitido é
`escalation: 'wait-ceiling'`, porque esse valor é a *medição de uma espera que não limpou*, e uma
espera que não aconteceu não pode ser medida. O `defer-cap` não é afetado — ele sai do ledger, não da
espera, e é emitido sob os dois valores.

**Fronteira deliberada: `gate-unavailable` para o dispatch sob os DOIS valores.** Falha de tooling
(`exit != 0`, stdout não-JSON) **não é veredito da cerca** — é a cerca ausente. E o critério de flip
depende de o gate ter de fato rodado: um advisory que tolera gate quebrado deixa de produzir
exatamente o dado que justificaria o flip. A justificativa é o defeito de origem desta milestone: um
gate que emudece é byte a byte indistinguível de um gate que aprovou. **Silêncio nunca pode ser lido
como consentimento.**

Sob `enforcing`, então:

- `block` ou `refuse` **param a unidade**. Não existe ramo "prosseguir mesmo assim".
- Um `defer` sem para onde deferir vira `block` (o piso D3, aplicado dentro do módulo).
- Falha de tooling é tratada como `block`, alto — ver **§ Fail-closed**.

**O critério de flip, e onde ele mora.** O flip para `enforcing` exige **2 milestones consecutivas
com zero falsos positivos** na amostra. Isso não é julgamento de quem estiver de plantão: é medido
por `scripts/forge-claim-flip.js`, que confronta cada `decision != proceed` do evento `claim-gate`
com o overlap **factual** e reporta `flip-ready` / `not-ready` / `inconclusive` — com o piso de que
**zero pares comparados é `inconclusive`, nunca `flip-ready`**. Os limiares vivem exportados no
script (`FLIP_WINDOW_MILESTONES`, `FLIP_MAX_FALSE_POSITIVES`) e são citados pela `description` da
pref no `forge-prefs.schema.json` — os dois concordam **por referência**, nunca por transcrição.
O gatilho do follow-up `#1(b)` é igualmente medido: **taxa de `held-uncommitted` por milestone sob
advisory** (D6).

**A série de cobertura é durável.** No `complete-milestone`, enquanto os refs
`forge/*` ainda existem, `scripts/forge-write-coverage-ledger.js` executa a
medição canônica e anexa um snapshot compacto a
`.gsd/forge/write-coverage.jsonl`. O append usa mutex, retries idênticos são
deduplicados por `measurement_id` e `inconclusive` permanece um resultado
registrado — ausência de amostra nunca vira autorização para o flip. Cada
snapshot filtra corpus, refs, commits e skips pelo milestone rotulado; outro
milestone não pode melhorar nem piorar sua medição. Se uma interrupção deixar
somente o último JSON incompleto, os bytes são preservados em um sidecar
`.incomplete-*` antes da recuperação; corrupção em qualquer linha completa
continua falhando de modo fechado.

## Inputs

- `WORKING_DIR` — absolute workspace root. The run registry (`.gsd/forge/runs/`) and the event log
  (`.gsd/forge/events.jsonl`) live **here**, never in the worktree, so every `--cwd` of the gate
  points at `WORKING_DIR` even when the code lives elsewhere.
- `RUN_ID` — this orchestrator's run id (the own side; excluded from the counterpart universe).
- `UNIT` — the unit string, **verbatim**, in whichever of the three grammatical forms the dispatch
  already uses (`execute-task/T03`, `review-fix/{S##}`, `review-fix/{M###}-triage`). The gate keys
  its defer ledger on this string and never parses it; do not normalise, shorten or invent a form.
- `CODE_DIR` — only when the dispatch **already resolved** it (see **§ B2**).
- `MODE` — `auto` (forge-auto) or `interactive` (forge-next / forge-task-style boundaries).
- The claim source — one of `--plan`, `--conceded`, `--paths` (see **§ Step 1**).

## Step 0 — Prefs are read BY THE MODULE, not by the consumer

`parallelism.cross_run_overlap` (the posture), `parallelism.claim_gate` (the enforcement) and the anti-livelock timings
(`parallelism.block_wait_ms`, `parallelism.block_poll_ms`, `parallelism.defer_cap`) are resolved
**inside `scripts/forge-claim-gate.js`** through the canonical prefs engine.

The consumer therefore does **not** read them, does not extract them with a `node -e` one-liner, and
does not pass them in. A second reader of the same knob is a second default, and a default that
drifts from the schema turns the documented value into a lie for anyone who never wrote a prefs
file. `--posture` exists only as a deliberate **operator override** and is not used by the two
orchestrators in their normal flow.

Consequence for the consumer: a posture of `defer` versus `block` produces different decisions from
an identical collision, and the consumer must handle both — it cannot assume one of them.

## Step 1 — Deriving the claim, per unit type

The claim is the set of **files the unit will write**. How it is derived depends on the unit:

**`execute-task`, single unit (forge-next, and each member of a forge-auto batch).**
Pass `--plan <path to T##-PLAN.md>`. The module derives `writes:` ∪ `expected_output:` through the
shared coverage helper — the consumer never re-computes that union, and never hand-builds a path
list from a plan it read itself.

**A batch of ready tasks (forge-auto parallel dispatch).** The order is fixed and is not an
implementation detail:

1. Record the **union** of the whole ready batch first, as one claim, before evaluating anything
   (`--claim-and-check --paths <union csv> --unit "BATCH:<ids csv>"`). The union itself is derived
   with one `--evaluate --plan <path>` per member, reading `.claim.paths` from each result — a
   derivation that fails is **fail-closed** (`gate-unavailable`), never an empty union.
2. Evaluate **per task** with **`--check-only`**, each against the counterpart universe.
3. Drop every task whose decision is not `proceed` from the batch.
4. Re-record the union of the **survivors**, so the persisted claim describes what will actually
   run. **Zero survivors is a named case:** nothing is dispatched, so the run must hold no fence —
   clear the claim (`forge-write-claim.js --clear`) instead of leaving the original union standing.

**Why `--check-only` and not `--claim-and-check` in the loop.** `recordClaim` is a **single slot**
(`forge-write-claim.js` — `runs.update({ write_claim })` replaces wholesale). A per-task
`--claim-and-check` would therefore destroy the union recorded in item 1 two lines after writing it,
and each task would be confronted while the RunRecord described only that task. `--check-only`
evaluates the derived claim and **emits the event** (so item 1's visibility rule and § Step 5's
"the event is written by code" both hold) while **preserving** the persisted claim.

Why: recording the union first makes the fence visible to a symmetric run during the window in which
this run is still deciding (contract #6 — an invisible fence does not fence). Re-recording after the
drops keeps the claim honest: leaving the original union in place would block counterparts on files
this run has already decided not to touch.

**`review-fix` (both call sites).** Pass `--conceded` with the conceded items as a JSON array of
`{r, path, line}` — the `path:line` of each item, taken from the review artifact. The module strips
the `:line` suffix (a claim is about files) and de-duplicates.

An item that arrives **with no path** is a named branch, never a quiet degradation: the module
returns `refuse` with cause `pathless-conceded-item` and names the offending `R#`s. See D7 handling
in **§ Step 3** and in `shared/forge-review.md § Step 7a`.

**Explicit paths (`--paths a,b,c`).** For operator/manual use and for boundaries that already know
their file list. Not used by the two orchestrators.

## Step 2 — The canonical invocation

One block. Consumers copy this shape; they do not invent flag combinations around it.

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-claim-gate.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")

GATE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-claim-gate.js" --claim-and-check \
  --run "$RUN_ID" \
  --unit "$UNIT" \
  --source plan-writes \
  --plan "$PLAN_PATH" \
  ${CODE_DIR:+--code-dir "$CODE_DIR"} \
  --ready-alternatives "$READY_ALTERNATIVES" \
  --cwd "$WORKING_DIR" \
  --json)
GATE_EXIT=$?
```

- `--claim-and-check` is the operational entry point for a **single** unit: it **records the claim
  before evaluating** and emits the `claim-gate` event. Its batch sibling is `--check-only`, which
  evaluates and emits the event but **preserves** the persisted claim (see § Step 1). `--evaluate`
  neither records nor logs; it is for inspection, tests, and for deriving a claim's paths
  (`.claim`, present on all three modes) when computing a batch union. A decision that gates a
  dispatch is never taken on `--evaluate`.
- `--source` is `plan-writes` for `execute-task` and `review-fix-paths` for `review-fix`; substitute
  `--plan "$PLAN_PATH"` with `--conceded "@$ITEMS_JSON_FILE"` at the review-fix call sites.
- `--cwd "$WORKING_DIR"` — always the workspace, never `CODE_DIR`.
- `--ready-alternatives` is computed **by the consumer** (how many other units it could dispatch
  right now instead). It is what makes the D3 floor meaningful; when the consumer does not know, the
  honest value is `0`, which fails closed.
- `--wait` is added by any consumer willing to spend the wait inside its own tool call (see
  **§ Step 3**, `block` row). `MODE == auto` passes it **unconditionally**: the module polls only
  when the decision is `block`, which is behaviourally identical to "when the effective posture is
  `block`" — and § Step 0 forbids the consumer from pre-reading the posture pref, so a conditional
  flag would be unactionable. The module polls up to
  `parallelism.block_wait_ms`; expiry becomes the `wait-ceiling` escalation and **never** becomes
  `proceed`.
- `--json` always: the consumer parses `.decision`, `.cause`, `.escalation`, `.census`,
  `.not_covered`, `.counterparts`. The human-readable form is for the operator, not for parsing.

### B2 — `--code-dir` is a given fact, and its absence is also a fact

`--code-dir` is passed **only** with the value the dispatch already resolved. When
`scripts/forge-code-dir.js` refused (cross-repo, undeclared) or no `CODE_DIR` exists for this
dispatch, the flag is **omitted**. The recorded claim then carries `code_dir: null`, its scope
against every counterpart is `unknown`, and `unknown` **stays in scope** — the gate fails closed.

**Explicitly prohibited:** passing `$WORKTREE_DIR`, the workspace root, or any value derived from
`root` + `branch` + `isolation_mode` as a fallback. A guessed `CODE_DIR` that happens to differ from
a counterpart's real one takes the pair *out* of scope and silently disarms the fence — the failure
mode is invisible and looks exactly like a clean run. An honest `null` over-blocks; a guess
under-blocks. This gate prefers the former, by decision (contract #7).

## Step 3 — Decision × mode

The module returns exactly one of four decisions. **This table is the single source; consumers act
on it by reference.**

| decision | `MODE == auto` (forge-auto) | `MODE == interactive` (forge-next) |
|---|---|---|
| `proceed` | Dispatch normally. | Dispatch normally. |
| `defer` | Drop this task from the ready batch, echo one line naming the counterpart and the colliding paths, and continue with the rest of the batch. Never dispatch it this pass. | Try another ready unit if one exists; otherwise surface the collision to the operator with the instruction to re-run once the counterpart commits. |
| `block` | `--wait` is always passed, so the module already polled to the ceiling before returning. Stop this unit. If `escalation` is set → **§ Step 4**. | Surface immediately (no wait — a human is present and waiting silently is worse than telling them): name the counterpart run, the paths, and the legitimate exits from **§ Step 4**. |
| `refuse` | Stop this unit, surface the cause, do not retry — waiting cannot fix it. | Same, plus the concrete repair. |

`escalation` is a **field**, never a fifth decision: the decision stays `block`/`defer` and the
consumer acts on `wait-ceiling` / `defer-cap` per **§ Step 4**.

**The three causes carry different messages, and substituting one for another is a defect.**

- `overlap` — both sides declared and the declared paths intersect. A **measured** collision. Name
  the intersecting paths (`.counterparts[].paths`) and the counterpart run id.
- `undeclared-writes` — a side carries no claim or an empty one. Check `.undeclared_side`:
  `own`/`both` arrives as `refuse` (the plan must declare `writes:`; that is the repair to state),
  while `counterpart` arrives as `defer`/`block` (the other run's plan is at fault — this run is not
  asked to fix it, only to wait or step aside).
- `pathless-conceded-item` — D7. A conceded review item had no path, so the claim could not be
  derived. This is `refuse`, and the repair is stated against the review item, not against a plan.

**`proceed` has two reasons and they are not interchangeable.** `no-conflict` means counterparts
were confronted and none collided; `no-active-counterpart` means **nothing was confronted at all**.
When echoing a proceed, echo the reason — a proceed that compared nothing must never be reported in
the language of a clean comparison.

## D8 — Posture hardening where there is no physical isolation

The pref (§ Step 0) resolves a **default** posture, `defer` or `block`. D8 is the one case where the
module overrides that default **regardless of what the pref says**, because `defer` stops meaning
"safe" the moment the two colliding runs share the same physical tree: telling one of them to "go do
another task" does not lower the risk of the collision, it only changes **which** file gets
trampled. `defer` is only ever a safe answer when the counterpart truly writes somewhere else.

**Where the fact comes from.** `resolveEffectiveMode` (`scripts/forge-isolation.js`, S06/T01) derives
`unmet_requirement` when a run's isolation setup **asked** for a worktree (`workers.require_worktree:
'true'` or `'auto'` with a matching write-engine) and did not get one — the SVN short-circuit is the
first case that produces it. This is **measured live**, by calling the resolver against the claim's
`code_dir` at the moment `resolvePosture` runs; it is **not** a field persisted on the `RunRecord`,
and the gate never reads a stale copy of it.

**What does NOT trigger it:**

- `workers.require_worktree: 'false'` (or unset) with no explicit pref asking for one — nothing was
  refused, so there is nothing to harden against.
- `mode: 'branch'` — a branch is not physical isolation from the counterpart's tree either, but D8
  only fires on the SVN short-circuit `resolveEffectiveMode` already names; a plain `branch` mode
  with no `unmet_requirement` field leaves the posture exactly as the pref set it.
- Measurement unavailable — no `code_dir` on either the own or the counterpart claim
  (`isolation-unmeasured`), or the resolver throwing (`isolation-probe-threw`). Same rule as the
  release probes (§ Release lifecycle): **a measurement that could not be taken never hardens and
  never loosens.** The pref's posture stands, and the hole in the evidence is named in
  `isolation_note`, never silently folded into `note`.

**The effect on the consumer: none.** The two orchestrators keep acting on `decision` exactly as
before — `defer`/`block`/`proceed`/`refuse`, per the table in **§ Step 3**. D8 changes only what the
*module* returns as the decision; it does not add a fifth decision, a new flag the consumer must
branch on, or any call the consumer must make differently. The posture is resolved and applied
**inside** `resolvePosture` (§ Step 0's rule extends here without exception), and its outcome is
readable by the consumer only through the fields documented in **§ Step 5**.

The closed sets are exported for callers that need to validate against them (the doc↔code
conformance assert in `scripts/forge-claim-gate.test.js` is one):

- `POSTURE_OVERRIDES` — `['svn-unmet-worktree']`. The only override this gate knows how to justify.
- `OVERRIDE_EFFECTS` — `['hardened', 'already-block']`. Reported **separately** from the override on
  purpose: an operator reading `block` must be able to tell a block the pref already asked for
  (`already-block`) from a block D8 imposed (`hardened`) — collapsing them would make the hardening
  invisible exactly where it changed nothing, and a hardening nobody can see is indistinguishable
  from one that never ran.

## Step 4 — Escalation (the Account Handoff Procedure form)

Triggered when `.escalation` is `wait-ceiling` or `defer-cap`, and used as the surfacing shape for
any `block`/`refuse` that stops a run. Two symmetric runs that record before evaluating see each
other and **both** stop; that livelock is resolved by escalating to the operator, never by a
tie-break, ordering or priority — those are an integration queue, the locked frontier of S07.

**1. Checkpoint.** When inside a slice, write `continue.md` per the Continue-Here Protocol so the
next session resumes exactly here.

**2. The event is already written.** `--claim-and-check` emitted the `claim-gate` line itself, in
code (see **§ Step 5**). Do not hand-write a second line narrating it.

**3. Stop.** `MODE == auto` → deactivate this run (the same deactivation the pause path uses), which
stops the loop while leaving the state recoverable. `MODE == interactive` → surface directly; there
is no run to deactivate.

**4. Emit an actionable message.** It must name the **counterpart run**, the **cause**, the
**paths**, and the legitimate exits:

```
⛔ Claim gate — {decision}/{cause}{escalation ? " (escalação: " + escalation + ")" : ""}
   Unidade: {UNIT}   Run: {RUN_ID}
   Counterpart: {counterpart run id}   Caminhos em disputa: {paths}

   Saídas legítimas:
   1. Aguardar o commit da run counterpart e re-rodar esta unidade.
      (O claim da counterpart é liberado quando o commit dela é OBSERVÁVEL — ver
       § Release lifecycle abaixo. Para inspecionar sem gravar nada:
         node scripts/forge-claim-release.js --status {counterpart run id} --cwd "{WORKING_DIR}" --json)
   2. Escape hatch — liberar o claim manualmente, com consciência do risco (pula a
      exigência de prova; use quando a árvore da counterpart não é mais sondável):
        node scripts/forge-write-claim.js --clear {counterpart run id} --cwd "{WORKING_DIR}"
   3. Ajustar as prefs: parallelism.cross_run_overlap (defer|block),
      parallelism.block_wait_ms, parallelism.block_poll_ms, parallelism.defer_cap.
```

**The gate never proceeds on escalation.** Escalation is the anti-livelock valve, not a timeout that
degrades into approval. If the operator wants the dispatch to happen anyway, they take exit 2 or 3
above — an explicit, recorded human act.

## Release lifecycle — a claim is worth exactly as much as the commit it is waiting for

A claim that is never released is a fence that outlives its reason. This section replaces the S04
disclosure that claims were held forever: **the claim now has a measured end of life**, and the
measurement — never a presumption, never the clock alone — is what ends it.

The core is `scripts/forge-claim-release.js`; this section is its contract for consumers.

### The release mechanisms

`released` is written into the `RunRecord` with the mechanism that produced it. The set is closed
(`CLAIM_RELEASE_REASONS`), and precedence between reasons is fixed in the module:
`released-explicit` > `released-committed` > `released-ttl-expired` > `held-probe-unavailable` >
`held-uncommitted`.

| mechanism | reason | what it means |
|---|---|---|
| `explicit` | `released-explicit` | the claim already carried the `released` envelope — an earlier corroborated release, or the operator's escape hatch (§ Step 4 exit 2). Nothing to measure, nothing to write. |
| `committed` | `released-committed` | **the only positive proof of commit**: both probes below agreed — probe A in its **precise** form (D16), i.e. a commit since the recorded baseline that **touches ≥ 1 claimed path**. `owner_active` is **measured and persisted as evidence**, and **no longer gates this rung** (D16 removed that third condition — see below). |
| `ttl-expired` | `released-ttl-expired` | the net (D2): the `ttl + grace` window elapsed, the owning run was measured **inactive**, **and** the claimed paths are not measurably in flight (`paths_in_flight !== true`). |
| `manual` | *(no reason — `classifyRelease` never emits it)* | the operator released it by hand. It **asserts no measurement**, which is exactly why it exists (S05/review R4): `committed` and `ttl-expired` are names that CLAIM one, and the `forge-write-claim.js --release` CLI writes without probing anything. That CLI therefore accepts **only** `manual` (its default) and **refuses the corroborated names by name**; corroborated releases route exclusively through `forge-claim-release.js`, which measures them. This is auditing integrity, not capability — the registry was always hand-editable JSON; the official tool simply must not offer the lie as a flag. |

### Two probes, and why the conjunction is the design

Proof of commit requires **both**, always:

- **A — the baseline advanced, PRECISELY (D16).** Not "the tree's baseline moved" — that is a
  property of the *tree*, not of this claim's work, and in a union claim (T01+T02) any neighbouring
  commit satisfied it. The governing probe is: since the recorded `vcs_baseline.id`, a commit landed
  that **touches at least one claimed path**. The raw movement is still recorded as `baseline_moved`
  (auditable); `baseline_advanced` is what decides. The precise form is **monotonic** over the old
  one — every state it releases, the old one released too; no new release path was created.
- **B — the claimed paths left flight.** No path of the claim appears in `workingStatus(code_dir)`
  with `kind ∈ {modified, added, deleted, untracked}`. `untracked` is **in** (S05/review R2): a new
  file is the most common output of an executor (`forge-vcs.js` emits git `??` / svn `unversioned`
  as `untracked`), and excluding it made probe B answer `false` for uncommitted work — which, with a
  neighbour's commit advancing the shared tree's baseline, released a **live** claim. `ignored` stays
  **out**; entries are filtered by the claim's own path coverage first, so only *claimed* paths hold.

Each probe **alone releases wrongly, in opposite directions**. A alone releases a claim whose worker
has not started writing yet, when an *earlier* commit already touched those paths. (Before D16 made
A precise, A alone was worse still: any *neighbour's* commit in a shared tree satisfied it —
literally the SVN/WDMA scenario that originated this milestone.) B alone releases a claim whose
worker **has not started writing**: zero dirty paths is indistinguishable from "committed
everything" when nobody looks at the baseline. Relaxing to one probe is a regression, not a
simplification, and both git and svn go through the same public seam of `scripts/forge-vcs.js` —
the symmetry is deliberate, not a concession to SVN.

### Liveness governs the TTL rung — the clock is the named last resort (PR #110 `#1(a)`, amended by D16)

**Only `released-ttl-expired` requires `owner_active === false`.** PR #110 had put that same
condition on `released-committed` as well; **D16 removed it there**, and this section is the
amendment — the two statements must not coexist, because a spec that says both is the very defect
that finding 4b of this branch exists to close.

Why it was removed: the condition did not close the hole it named — it made the rung **unreachable
by the real gate**, by a two-bladed scissor measured at both sites. (1) `collectRunClaims`
(`forge-claim-overlap.js`) skips every run with `active !== true` as `run-inactive` *before* any
probe runs; (2) `probeClaim` derives `owner_active` from `isHolderRunActive`, which requires
`run.active === true`. So an active counterpart yields `owner_active === true` and never fires, and
an inactive one is never probed at all. No state emitted `claim-released:committed` — and since the
`e-release` step of `forge-auto` asks for the release with the run **still active**, the claim could
only ever leave by TTL after the run died. That is over-block, the class this milestone exists to
close, reintroduced one layer up.

The hole PR #110 actually pointed at is closed by **probe A precise** instead: the moment where a
*neighbour's* commit advanced the tree baseline while this claim's edits were momentarily clean no
longer satisfies probe A, because the neighbour's commit does not touch the claimed paths. Proof of
commit is once again about **this claim's own work**, which is what it should always have measured.

**`owner_active` did not disappear — it was demoted from trigger to evidence.** It is still measured
by `probeClaim` and still carried in the persisted evidence and in the census; it simply no longer
decides the `committed` rung. Where the owner's liveness still *governs* is (a) the TTL rung below
and (b) the **persistence** of the verdict into a foreign `RunRecord` (`forge-claim-gate.js`) —
neither of which D16 revokes.

The literals `=== true` / `=== false` are kept on purpose wherever liveness still decides: `null` is
**"I did not ask"** and never satisfies a probe.

This is the same doctrine `forge-filelock.js` now enforces one layer down: **liveness beats the
clock**, the clock is the last resort with a name, and the crashed owner is converted from live to
ended by the reaper (`scripts/forge-run-reaper.js`), not by a fence quietly deciding to steal.

**Custo aceito e nomeado.** Com `#1(a)` + `#2(c)` juntos, um dono **vivo** passa a liberar
praticamente só por `explicit`. É o Risco 1 assumido no brainstorm, e é o motivo *técnico* — não
político — de a postura `advisory` ser a de estreia: sob advisory esse aperto produz um **flag**, não
um halt, e a taxa de `held-uncommitted` que ele gera é exatamente o gatilho medido do follow-up
`#1(b)` (D6).

### A question that could not be asked keeps the claim

A probe returning `{ok:false}` (missing binary, vanished directory), a `code_dir: null`, an absent
`vcs_baseline` or an unrecognised vcs yields `held-probe-unavailable` with the error **named** —
never a `released-*`. Same polarity as D1/B2: an honest `null` over-blocks, a guess under-blocks,
and this gate takes the former by decision. A release granted without proof hands back to the gate
exactly the hole the gate exists to close.

### TTL is a net, never a criterion of ownership (D2)

A claim expires by TTL only when **both** hold: the `ttl + grace` window has elapsed
(`DEFAULT_TTL_MS`/`DEFAULT_GRACE_MS` imported from `forge-unit-lease.js` — no new pref, no knob) and
the owning run is **inactive** (predicate reused from `forge-filelock.js`) **and** the claimed paths
are not measurably in flight (`paths_in_flight !== true`, PR #110 `#2(c)`).

`!== true`, **not** `=== false`, and the difference IS the design: the net exists to take out of the
way a dead run whose **tree is gone** — precisely the case where `paths_in_flight` is `null`
("I could not ask"). What the rung now refuses is the **measured refutation**: a dirty tree on the
claimed paths is the signature of *checkpointed, not abandoned*. That signature is what this repo's
own recoverable deactivations produce — pause, account handoff, and the gate's own `block`
escalation all preserve the dirty tree for a resume. `last_heartbeat` cannot tell paused from dead
(D4), so it is never consulted here; the dirty tree can, and is.

A live run never loses
its claim to the clock: a legitimate 40-minute worker is byte-for-byte indistinguishable from a dead
one if only the clock is consulted. The TTL sits **above** `held-probe-unavailable` in the
precedence on purpose — a dead run whose tree vanished still has to get out of the way; that is what
the net is for.

### Released ≠ absent ≠ empty, at the gate

A released claim **stays** in the `RunRecord`. The gate drops that counterpart from the universe
with a **named** skip (`claim-released:committed` / `:ttl-expired` / `:explicit` / `:manual`), counted in the
census — it never falls through to `claim-absent`, which would turn a release into
`undeclared-writes` and make the release *worsen* the block it came to fix.

The orphan-run reaper follows the same ownership rule through `forge-write-claim.isHeld`: a
persisted release envelope is historical evidence, not effective possession. An active run with a
released claim therefore returns to the ordinary heartbeat classification and may be reversibly
deactivated when stale; the claim object and its release evidence remain intact in the RunRecord.
A live claim remains `holds-claim` regardless of heartbeat age or apparent tree cleanliness. The
reaper repeats this classification under the registry lock, so a new live claim written between
the census and mutation prevents deactivation.

### Where the release is asked for

At the **unit boundary**, by both orchestrators, in Post-unit housekeeping — `skills/forge-auto`
(step 6) and `skills/forge-next` (§ 6) — after the unit's own commit has had its chance to land.

**And by the gate, for the one verdict it corroborates itself (S05/review R3).** When a
counterpart's release is proved `committed` — the two probes agreeing — the gate **persists** that
verdict into the counterpart's `RunRecord`. Without it the release was a live-probe opinion that
evaporated: a counterpart proved `committed` at unit N re-blocked at N+1 as soon as the path went
dirty from unrelated work, which is a **non-monotonic** release contradicting the persisted lifecycle
this section documents. The write is cross-run, into a foreign record, and it is only admissible
because `releaseClaim` compares the claim identity **under the lock** (below): the gate passes the
claim it measured as `expect` and **never** reads-then-writes.

Only `committed` is written from here. `explicit` is already persisted by definition; `ttl-expired`
is the net firing on someone else's dead run and `manual` asserts no measurement at all — carving
either into a foreign record from a counterpart's gate would persist a verdict this gate did not
corroborate.

When the identity compare **loses** the race, nothing is written, nothing is retried, and the
refusal is named — `release-persist-stale-claim` in the census notes, `persist_refusal` on the
`released_counterparts` entry (`release-persist-failed` for any other named refusal or a throwing
seam). The **live verdict still stands for that evaluation**: losing the race means "I could not
persist", which is neither "the release did not happen" nor "it did". A measurement that could not be
made is never evidence — in either direction.

The write itself is **atomic against the claim's identity** (S05/review R1): `releaseClaim` re-reads
the claim **inside** the registry lock (`forge-runs.updateWith`) and compares `{at, unit,
vcs_baseline.id}` with the claim the caller measured. If the owner recorded a newer claim in that
window, the release is **refused by name** (`stale-claim`) and nothing is written — never an
overwrite, which would cover live in-flight writes with a released claim and re-open the fence at
the exact place this milestone exists to close it. `complete-slice` deliberately stays out of it (§ Step 5, `not_covered`).

### The canonical release invocation

One block. Consumers **invoke it by reference**; they do not restate it, do not re-tabulate the
mechanisms, and do not invent flag combinations around it.

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-claim-release.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")

RELEASE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-claim-release.js" --release "$RUN_ID" \
  ${CODE_DIR:+--code-dir "$CODE_DIR"} \
  --cwd "$WORKING_DIR" \
  --json)
RELEASE_EXIT=$?

if [ "$RELEASE_EXIT" -ne 0 ]; then
  echo "ℹ️  Release do claim indisponível (exit $RELEASE_EXIT) — claim MANTIDO. O loop segue." >&2
else
  printf '%s' "$RELEASE_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let r;try{r=JSON.parse(d)}catch(e){console.error("ℹ️  Release do claim: JSON inválido — claim MANTIDO. O loop segue.");process.exit(0)}console.error(r.released?"✓ Claim liberado ("+r.reason+", mecanismo "+r.mechanism+") — run "+r.run+", unidade "+(r.unit||"(?)")+".":"ℹ️  Claim MANTIDO ("+r.reason+") — recusa: "+(r.refusal||"nenhuma")+". O loop segue.")})'
fi
```

- `--release <run-id>` is the **request**. The module refuses it (`refusal: not-observable`, nothing
  written) whenever the commit is not observable; `--status <run-id>` is the side-effect-free probe,
  for the operator and for § Step 4's message.
- `--cwd "$WORKING_DIR"` — always the workspace, where the registry and `events.jsonl` live, never
  `CODE_DIR`.
- `${CODE_DIR:+--code-dir "$CODE_DIR"}` — the **same B2 rule** as § Step 2: passed only with the
  value the dispatch already resolved, omitted otherwise. A guessed `code_dir` here probes the wrong
  tree, and a probe of the wrong tree can *release* — the failure is worse on this side than on the
  gate's.
- `--vcs <git|svn>` exists as an operator override of the recorded baseline's vcs; the orchestrators
  do not pass it. No other flags exist — do not invent one.

### Asking for the release is FAIL-SOFT — and that asymmetry with the gate is deliberate

The pre-dispatch gate (§ Fail-closed) is **enforcing**: a mute gate is an approval nobody
authorised, so `gate-unavailable` blocks, loudly. The release is the mirror image and therefore has
the **opposite** posture:

> **Asking for a release is measuring.** A measurement that cannot be taken leaves the claim
> standing — which is the safe side, because a claim left standing only over-blocks, and the gate
> already fails closed on the side that matters.

So a non-zero exit, invalid JSON or a refused request **echoes one line and the loop continues**.
It never stops the loop, never deactivates the run, and never escalates. Symmetry with the gate
would be aesthetic and wrong: a release that stops the loop when the probe is unavailable would turn
a *tidying* step into an outage.

## Step 5 — The event, and the mandatory enumeration

**The event is written by code**, inside the module, on every `--claim-and-check`. The consumer does
not narrate it. This repo has measured what happens when the only record of a routing decision is a
line the model was asked to write (TASK-021: an entire slice fell through to a different engine and
the session narrated it as a tooling bug).

Shape appended to `.gsd/forge/events.jsonl` of `WORKING_DIR` — documented for **readers**, never for
retyping:

```json
{"event":"claim-gate","ts":"<ISO-8601>","run":"<run id>","unit":"<unit verbatim>","decision":"proceed|defer|block|refuse","cause":"overlap|undeclared-writes|pathless-conceded-item|null","undeclared_side":"own|counterpart|both|null","posture":"defer|block","posture_source":"prefs|fallback|invalid-pref|explicit","posture_effective":"defer|block|null","posture_override":"svn-unmet-worktree|null","posture_override_effect":"hardened|already-block|null","escalation":"wait-ceiling|defer-cap|null","floor":"defer-floor|null","counterparts":[{"id":"<run>","cause":"...","paths":["..."],"path_operands":[{"label":"<label>","operands":[{"value":"<path>","owner":"own|counterpart|both|unknown","run":"<run|null>"}]}],"scope":"same|unknown","note":"<S03 note|null>"}],"released_counterparts":[{"id":"<run>","mechanism":"committed|ttl-expired|explicit|manual","reason":"released-*","persisted_mechanism":"<mechanism|absent>","persisted":true,"persist_refusal":"<named refusal|absent>"}],"census":{"runs_examined":N,"counterparts_considered":N,"counterparts_in_scope":N,"skipped":[{"id":"<run>","reason":"different-code-dir"}],"notes":[{"id":"...","reason":"..."}]},"not_covered":[{"boundary":"...","reason":"..."}]}
```

**Operand ownership on a composite label (S07/review R2c).** `counterparts[].paths` carries the
labels `claimsConflict` rendered, and a collision between two *different* paths is rendered as the
composite `"<a> × <b>"` — a rendering, not a structure. Which operand belonged to whom used to be a
**positional invariant of one emitter in one version**, and a historical line does not certify which
version wrote it. The gate therefore emits, **additively**, `counterparts[].path_operands`:

```json
"path_operands":[{"label":"src/** × src/a.js","operands":[{"value":"src/**","owner":"own","run":"<own run>"},{"value":"src/a.js","owner":"counterpart","run":"<counterpart run>"}]}]
```

`paths` **keeps** its meaning and its bytes — rewriting it would retroactively falsify every
`claim-gate` line already on disk. `owner` comes from a closed set and is **measured** by membership
in the two declared claims, never inferred from position: `own`, `counterpart`, `both` (both sides
declared that exact path — the non-composite case) and `unknown` (found in neither claim, e.g. a path
that itself contains the separator). `run` is filled only for an unambiguous owner; `both` and
`unknown` carry `null`, because naming one of the two runs there would assert a measurement nobody
made. The field is present **only** on a counterpart with a measured `overlap` — never on
`undeclared-writes`, where there is no operand to own.

Additive-field convention, same as `tier`/`reason` from M002: readers that do not recognise a field
ignore it. `scope: unknown` with an S03 `note` is what lets an operator tell a block backed by
**measured** identity from a block backed by unknown identity.

`posture` **keeps** its established meaning — the posture resolved from `parallelism.cross_run_overlap`
by § Step 0, before D8 is consulted. `posture_effective`, `posture_override` and
`posture_override_effect` are the three fields **D8 adds** (§ D8 above): `posture_effective` is what
the module actually decided with after the isolation check; `posture_override` names which override
fired (`svn-unmet-worktree`) or `null` when none did; `posture_override_effect` is `hardened` when
D8 changed the outcome, `already-block` when the pref's own posture was already `block`, or `null`
when D8 did not fire.

**All three are `null` whenever no collision was confronted** — that is, on every `proceed`
(`no-active-counterpart`, `no-conflict`) and on every `refuse`. In those outcomes the posture was
never resolved: `resolvePosture` does not run at all, so there is nothing to report and `null` is the
honest value ("not evaluated"), distinguishable from "evaluated and no override fired"
(`posture_effective: "defer"` with `posture_override: null`). Resolving them outside a collision
would mean running a live tree probe in evaluations that never consume the result, emitting isolation
notes into clean proceeds, and asserting a "decided" posture in a `refuse` where posture plays no
part.

So the three fields come straight from `resolvePosture`'s return **in the collision branch, which is
the only branch that resolves a posture**; in the outcomes above `resolvePosture` never ran and the
`null` is supplied by `emitGateEvent` itself. Either way the event never re-derives a posture — it
reports one or reports its absence.

**Mandatory enumeration.** Every gate execution — including `proceed` — carries `not_covered` with
three boundaries, and the consumer **prints it** every time:

| boundary | why it is not covered |
|---|---|
| `complete-slice` | the claim is released at the **unit boundary** (§ Release lifecycle), not by the completer — the completer never records, evaluates or releases a claim |
| `orchestrator-writes` | the orchestrator's own `.gsd/**` writes do not pass through a claim |
| `forge-task` | this milestone's Boundary Map limits the wiring to `forge-auto`/`forge-next`; `/forge-task` does not invoke the gate |

A gap the operator can read is a decision; a gap nobody prints is an omission wearing the clothes of
coverage. If a consumer finds this list noisy, the fix is to close a boundary — not to stop printing
it.

## Fail-closed — tooling failure is a block, and it is loud

```bash
if [ "$GATE_EXIT" -ne 0 ] || ! printf '%s' "$GATE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{JSON.parse(d);process.exit(0)}catch(e){process.exit(1)}})"; then
  echo "⛔ Claim gate indisponível (exit $GATE_EXIT) — tratando como block/gate-unavailable. Nenhum dispatch." >&2
  # Stop this unit. MODE == auto: deactivate the run per § Step 4 step 3.
fi
```

Exit `0` means **evaluated** — the decision travels in the payload, so a `refuse` is a successful
run of the tool. Exit `1` is an internal error and exit `2` is a malformed invocation; both mean
*no decision was produced*.

**Why this breaks the house convention.** Advisory mechanisms in this repo fail silently on purpose:
a broken advisory check that stops the loop costs more than the signal it provides. That trade
inverts here. This gate exists to refuse dispatches, so a mute gate is not a lost signal — it is an
approval nobody authorised, and it is indistinguishable from a clean `proceed` at every downstream
reader. `gate-unavailable` is therefore surfaced loudly and treated as `block`, never swallowed and
never defaulted to proceed.

## What this gate deliberately does not do

- **No ordering, no tie-break, no priority between runs.** Symmetric collision escalates to the
  operator. Choosing a winner is an integration queue — an entire product, and the locked frontier
  of S07.
- **No granularity heuristics.** A wide glob in a plan produces a wide claim and may over-block. The
  milestone's posture is to *measure first*: the gate counts and names its refusals in the event; no
  heuristic softening enters S04.
- **No worker prompt changes.** The dispatch templates in `shared/templates/dispatch/` are **not**
  touched by this gate. The claim is recorded and evaluated by the orchestrator before the worker
  exists; nothing about the worker's prompt changes (MEM002 — assertions about prompt structure aim
  at the templates, never at prose).
- **No re-implementation of the confrontation algebra.** Path intersection, `code_dir` scope and
  claim collection come from `scripts/forge-claim-overlap.js` (S03). The intra-slice conflict
  predicate of `scripts/forge-parallelism.js` has the **opposite polarity** (an empty list means no
  conflict there) and is correct in its own boundary; it is neither imported nor consulted here, and
  suites guard that absence in both modules.

## Recuperação manual de owner interrompido

Um claim live nunca é liberado por inferência de PID, sessão ou idade. Quando a run aparece no censo
`forge-claim-stuck`, o operador pode usar `forge-doctor --recover-claim <id>` para preview. A mutação
exige simultaneamente `--apply --confirm-owner-stopped`. O fluxo mede apenas paths dirty dentro do
escopo declarado usando `forge-vcs.workingStatus`; para escopo dirty, persiste, reabre e verifica um
bundle byte-preserving antes do evento de intenção. A transição final é CAS, sob o lock da run, para
`released.mechanism: manual` e `active:false`.

O restore do bundle também é preview-first e idempotente. Um destino ausente recebe os bytes
capturados; bytes já idênticos são mantidos; bytes divergentes nunca são sobrescritos e o payload é
extraído sob `conflicts/` na área de recuperação.

## Cross-references

- `scripts/forge-claim-gate.js` — the decision core and the CLI invoked in **§ Step 2**
- `scripts/forge-claim-release.js` — the measured end of life of a claim and the CLI invoked in
  **§ Release lifecycle** (`--release`, `--status`)
- `scripts/forge-claim-overlap.js` — S03 confrontation algebra (`claimsConflict`, `codeDirScope`,
  `collectRunClaims`, `CONFLICT_CAUSES`, `CLAIM_NOTE_REASONS`)
- `scripts/forge-write-claim.js` — claim record/read primitives and `--clear` (manual release,
  **§ Step 4** exit 2)
- `shared/forge-dispatch.md § Cross-run claim gate` — pointer plus the `claim-gate` and
  `claim-release` event fields
- `shared/forge-review.md § Step 7a`, `§ Step 9` — the two `review-fix` call sites
- `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` — the two orchestrator consumers
- `forge-agent-prefs.jsonc § Parallelism Settings` — `parallelism.{cross_run_overlap, block_wait_ms,
  block_poll_ms, defer_cap}`
