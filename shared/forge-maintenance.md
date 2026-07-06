# Forge Maintenance — Deterministic Consolidation Gate

Authoritative, boundary-agnostic spec for the **maintenance gate**: the human-confirmed handshake that decides whether loose finalized units (`.gsd/ledger/`, `.gsd/decisions/`) get fused into LOCKED rollup buckets. Nothing in this pipeline runs automatically — detection is passive, and every byte-mutating step requires an explicit interactive confirmation. Terminology rule: always **"maintenance"**, never "collapse" (collapse implies data loss; this pipeline is projection-lossless by construction — see Determinism below).

Three consumers bind to this gate at their own boundary:

| Consumer | Boundary | Posture | Artifact/effect |
|----------|----------|---------|-----------------|
| `/forge-sweep` | end-of-cycle / on-demand | announce + (on confirm) run the full apply handshake | consolidated rollups |
| `forge-next` (interactive) | maintenance gate at unit boundary | run the cascade interactively | consolidated rollups |
| `forge-auto` (auto) | maintenance gate at unit boundary | **STOP** loop + surface cascade (never applies inline) | halt + operator handoff |
| `bin/forge-run` (headless) | same gate | **defer** (mark deferred, continue; never block on 429/quota loop) | deferred, surfaced later |

Steps 1–8 below are boundary-agnostic — only the four postures above differ (Step 9, the LOCKED rules, apply on `forge-auto`/headless). The rest of this doc is written in generic terms; substitute the consumer's own bindings (cwd, run id, event stamping) when invoked.

## Determinism guarantee (why the VCS collision-discard is safe)

Every rollup produced by `runBaseline` (S04, `scripts/forge-maintenance-baseline.js`) is the output of `mergeBucket` (S01, `scripts/forge-maintenance.js`) over a normalized, sorted, byte-deterministic merge: identical input fragments always fuse to an identical byte stream, regardless of machine, timezone, or invocation order. This is what makes the VCS collision path in Step 7 safe — when a remote rollup and a locally-computed rollup hash to the same value (`bucketHash(normalizeText(...))`), they are provably the *same consolidation of the same source units*, so discarding the local copy and taking the remote one loses nothing. Any hash mismatch means genuine divergence (different units were fused, or a real conflict exists) and must abort loud, never silently pick a side.

## Inputs

- `WORKING_DIR` — absolute project root
- `CONSUMER` — `sweep` | `forge-next` | `forge-auto` | `forge-run`
- `MODE` — `interactive` (sweep / forge-next) or `auto` (forge-auto / forge-run headless)

## Step 1 — Detect + announce

Invoke the detection/announce layer (`scripts/forge-maintenance-gate.js`):

```bash
node scripts/forge-maintenance-gate.js --detect --cwd "$WORKING_DIR"
```

Parses to `{ mode, triggers, firedAxes, baseline }` (`detectMode` export). `mode` is one of:

- **`normal`** → announce `SWEEP NORMAL`. No fired axes, no baseline available. Proceed with the caller's normal flow — the maintenance gate is a no-op for this run.
- **`maintenance`** → announce `SWEEP PRECISA DE MAINTENANCE`. List each entry of `firedAxes` (`axis`, `count`, `threshold`, `target`); if `baseline.available` is `true`, additionally note this is a **BASELINE** run (first-ever maintenance — no rollup bucket exists yet for any axis, so any loose finalized units become the seed baseline once confirmed).

Emit the `maintenance-detected` event (see Step 8) regardless of which branch fires — it is the audit record that detection ran, not just that it fired.

## Step 2 — RED warning

On `mode == maintenance`, render the prominent warning via `renderRedWarning(detection)` (same module) and print it verbatim **before any confirmation is requested**. The renderer already wraps the banner in ANSI bold-red plus a boxed `⚠` header so it survives both color and no-color terminals — do not summarize or truncate it; the whole point is that it is unmistakable.

## Step 3 — First confirmation

One `AskUserQuestion`: **"Prosseguir com a maintenance?"** — options `Prosseguir` / `Cancelar`.

- `Cancelar` → stop. No writes, no further events beyond the `maintenance-detected` already emitted in Step 1.
- `Prosseguir` → continue to Step 4.

## Step 4 — Double-confirm POR EIXO (per-axis)

For **each** axis present in `firedAxes` (`milestones`, `tasks`, `ledgerDecisions`), ask a **separate** `AskUserQuestion`:

> "Consolidar `<axis>` (`<count>` unidades → `<target>`)?" — options `Confirmar` / `Pular`.

Collect the set of confirmed axes (`confirmedAxes`, e.g. `['milestones', 'ledgerDecisions']`). Declining an axis **excludes only that axis** — this is never all-or-nothing; an operator can consolidate `milestones` while skipping `ledgerDecisions` in the same run. Emit one `maintenance-confirmed` event **per confirmed axis** (Step 8). If the resulting `confirmedAxes` set is empty (every axis declined) → stop, no apply cascade, no further events.

`baseline.available` axes with no fired trigger (loose units exist but below threshold) are **not** offered here — Step 4 only confirms axes that are in `firedAxes`. A baseline-only run (below every threshold but no bucket exists) is out of scope for automatic offering; it is surfaced informationally in the Step 2 warning only.

## Step 5 — Apply cascade (interactive / sweep contexts only — NOT `forge-auto`)

This step runs only under `MODE == interactive` (sweep, forge-next). `forge-auto` and headless `forge-run` never reach here — they STOP/defer at Step 4's outcome (see Rules, below).

1. **VCS precheck (S03).** Call `precheckHistory(cwd)` from `scripts/forge-maintenance-vcs.js`. Read-only — `git fetch` + `git ls-tree`/`git cat-file`, never touches the working tree. If `already: true` (the remote already carries this maintenance — someone else ran it first), **abort the apply**: announce that maintenance already happened upstream, and instruct the operator to `pullScoped(cwd)` (path-scoped `.gsd/` sync, dirty-checked first) to pick it up, then re-run detection from Step 1 — do not attempt to re-consolidate.
2. **Consolidate.** For each axis in `confirmedAxes`, call:
   ```js
   runBaseline(cwd, { axes: confirmedAxes })
   ```
   (`scripts/forge-maintenance-baseline.js`, T01's additive `opts.axes` selector). This single call carries the **full safety net** from S04: `.bak` every source loose fragment before touching it, write buckets atomically, verify the post-consolidation ledger/decisions projection is byte-identical to the pre-consolidation projection, and on ANY mismatch (or thrown error) restore every source from `.bak` and remove/restore the just-written buckets — no data loss ever, on any path. **Do not re-implement any part of consolidation here** — this is the one and only call site for the apply.
3. **Commit guard (S03).** Immediately before committing/pushing the new buckets — no intervening I/O or `await` between this call and the actual commit (TOCTOU window, documented in `forge-maintenance-vcs.js`) — call:
   ```js
   runCommitGuard(cwd, localBuckets)   // localBuckets: [{ path, hash }] from runBaseline's result
   ```
   - `action: 'proceed'` → commit/push normally.
   - `action: 'discard'` → a byte-identical rollup already landed upstream between the precheck and now (race). Discard the local buckets silently (they carry no new information — Determinism guarantee above), pull the remote version via `pullScoped`, and treat the run as already-applied.
   - `action: 'abort'` → genuine divergence (different content at the same rollup path). Abort **loud** — do not commit, do not discard, preserve both the local buckets and the remote state as-is (D3: preserve-both on true conflict). The guard itself emits `maintenance-aborted-collision` (see Step 8) — surface it to the operator; this is not something this gate resolves automatically.
4. **Success** → emit `maintenance-applied` (Step 8) with per-axis counts, then commit + (if the run's isolation mode does auto-push) push.

## Step 6 — Per-consumer posture on OPEN outcomes

Covered fully in Rules below; summarized here for the reading order: `forge-auto` STOPs before Step 5 ever runs (delegates to sweep/forge-next); headless `forge-run` marks deferred and continues its supervisor loop without blocking.

## Step 7 — Collision cross-reference

`maintenance-aborted-collision` (S03, emitted by `runCommitGuard`/`appendEvent` inside `forge-maintenance-vcs.js`) is **not** emitted by this gate directly — it is emitted by the VCS module during Step 5.3. This spec documents it here because any consumer parsing `events.jsonl` for maintenance activity must recognize it as part of the same family of events, even though its writer lives in S03's module rather than the gate/apply glue described above.

## Step 8 — Events schema

Three events, appended as JSONL lines to `.gsd/forge/events.jsonl`. The `<ISO>` timestamp is always stamped by the orchestrator/skill at render time (bash `date -u +%Y-%m-%dT%H:%M:%SZ` or the consumer's own ISO-8601 source) — never generated inside a library function, preserving the determinism invariant that no maintenance library module touches wall-clock time except where explicitly documented (`currentQuarter`).

```json
{"ts":"<ISO>","event":"maintenance-detected","mode":"maintenance","fired":["milestones","tasks"],"baseline":false}
```

```json
{"ts":"<ISO>","event":"maintenance-confirmed","axis":"milestones","count":34,"target":".gsd/archive/milestones-rollup.md"}
```
— one line per confirmed axis (Step 4).

```json
{"ts":"<ISO>","event":"maintenance-applied","axes":{"milestones":34,"tasks":0,"decisions":112}}
```
— counts are per-axis unit counts actually consolidated (0 for axes not confirmed/attempted).

The fourth related event, `maintenance-aborted-collision`, is owned and emitted by S03's `scripts/forge-maintenance-vcs.js` (`runCommitGuard` → `appendEvent`) — not by this gate's own code path. See Step 7.

## Rules (LOCKED)

1. **No non-interactive apply.** `--maintenance` (or any programmatic/CLI/headless call path) must **never** bypass the Step 2 RED warning or the Step 3/Step 4 confirmations. Running maintenance apply without a real interactive human confirm is refused by construction — there is no flag, env var, or config value that skips the handshake. Detection (Step 1, `--detect`) is always safe to run non-interactively; **apply** (Step 5) is not.
2. **`forge-auto` never applies inline.** On `mode == maintenance` at its unit boundary, `forge-auto` renders the Step 1–2 announce/warning, then **STOPs the loop** and delegates the actual confirm+apply cascade to `/forge-sweep` or an interactive `forge-next` session — it never dispatches Step 3–5 itself. This STOP is the **sanctioned AUTONOMY-RULE exception**: the action is destructive-ish (consolidates and deletes loose source fragments, even though it's `.bak`-protected and verified) and inherently needs a human in the loop; the surrounding AUTONOMY RULE that forbids `forge-auto` from pausing mid-loop for confirmation does not apply here.
3. **Headless defer.** `bin/forge-run` (and any other non-interactive supervisor) treats `mode == maintenance` the same way `forge-auto` does at the announce step, but instead of stopping the whole process it marks the maintenance as **deferred** (recorded so a later interactive session picks it up) and **continues** its own loop/rotation — it must never trap or block on the missing human input (the same posture as its 429/quota handling: never get stuck waiting on something that can't answer).
4. **Pref:** `maintenance.in_auto: stop | defer | off` (default `stop`).
   - `stop` — `forge-auto` halts and surfaces per Rule 2 (the default, safest posture).
   - `defer` — `forge-auto` behaves like headless `forge-run` (Rule 3): mark deferred, continue the loop.
   - `off` — do not even run Step 1 detection at the auto/headless boundary; the maintenance gate is entirely skipped for that consumer (detection still runs normally for `/forge-sweep` and `forge-next`).
5. **Schema bump is a byproduct of a real apply, never a separate step.** `.gsd/SCHEMA-VERSION` stays at `fragment-store@1.0.0` until the first successful `runBaseline` apply that actually consolidates something (`writtenTargets.length > 0`) — its success path calls `stampBucketSchema(cwd)`, an upgrade-only write (never clobbers an existing `2.0.0` stamp; a dry-run or a no-op apply never touches the file at all). Nothing in Steps 1–4 (detect/announce/confirm) ever writes the schema stamp — only a completed Step 5 apply can.

## Opt-in + schema

The entire gate described above is **inert by default, per repo.** `detectMode(cwd, opts)` resolves `enabled` from `opts.enabled` (test/programmatic injection) or `readPref(cwd, 'maintenance.enabled', 'false')` — the standard 3-file prefs cascade (`~/.claude/forge-agent-prefs.md` → `.gsd/claude-agent-prefs.md` → `.gsd/prefs.local.md`, last wins), defaulting to `'false'`. When disabled, `detectMode` short-circuits to `{ mode: 'normal', enabled: false, triggers: detectTriggers(cwd, opts), firedAxes: [], baseline: { available: false, plan: null } }` **without** running `runBaseline`'s dry-run trigger plan — the disabled path is deliberately cheap (no extra I/O) so that leaving the feature off costs nothing at every unit boundary. There is no separate "feature flag check" a consumer needs to perform: `mode` is already `normal` when disabled, so every consumer's existing `mode == "normal"` branch is the correct no-op path.

A repo opts in by setting:

```yaml
maintenance:
  enabled: true
```

in `forge-agent-prefs.md § Maintenance Settings` (repo-shared or local prefs layer). Turning it on only changes whether `detectMode` ever reports `mode: "maintenance"` — it does not retroactively touch anything already on disk, and turning it back off at any time returns the gate to its inert, `mode: "normal"`-always state (no partial/half-applied intermediate state is possible: the gate either announces+asks, or does nothing).

The schema stamp (`fragment-store@2.0.0`) is entirely a consequence of this same opt-in: it is written **only** the first time a repo with `maintenance.enabled: true` runs a Step 5 apply that consolidates at least one axis (see Rule 5, above). A repo that never opts in — or opts in but never crosses a trigger threshold — never sees its `.gsd/SCHEMA-VERSION` change from `fragment-store@1.0.0`. Both stamps are members of `VALID_SCHEMAS` in `scripts/forge-doctor.js` and read identically through `listFragments()`'s unit-based enumeration (bucket-wins, loose-otherwise) — a `1.0.0` working copy and a `2.0.0` working copy with buckets project byte-identical `LEDGER.md`/`DECISIONS.md` output. See [`docs/fragment-store.md` § Layer 6](../docs/fragment-store.md) for the store-layer view of this same guarantee.

## Cross-references

- `scripts/forge-maintenance-gate.js` — `detectMode(cwd, opts?)` (opt-in gated via `readPref`/`maintenance.enabled`), `renderRedWarning(detection)`; CLI `--detect [--cwd D]`.
- `scripts/forge-maintenance-baseline.js` — `detectTriggers`, `runBaseline(cwd, { axes?, dryRun? })`, `stampBucketSchema(cwd)` (upgrade-only 2.0.0 stamp), `MILESTONE_THRESHOLD`/`TASK_THRESHOLD`/`DECISIONS_THRESHOLD`.
- `scripts/forge-doctor.js` — `VALID_SCHEMAS` (`{fragment-store@1.0.0, fragment-store@2.0.0}`), `BUCKET_SCHEMA` (`= fragment-store@2.0.0`), `isValidSchema`.
- `scripts/forge-cli-helpers.js` — `readPref(cwd, key, fallback)`, the 3-file prefs cascade reader used by the opt-in gate.
- `scripts/forge-maintenance-vcs.js` — `precheckHistory`, `pullScoped`, `recheckAtCommit`, `resolveCollision`, `runCommitGuard`, `isRollupPath`, `appendEvent` (emits `maintenance-aborted-collision`).
- `scripts/forge-maintenance.js` (S01) — `mergeBucket`, `normalizeText`, `bucketHash` — the deterministic-merge oracle referenced in the Determinism guarantee above.
- `skills/forge-sweep/SKILL.md` — end-of-cycle/on-demand invocation (T03 wiring).
- `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` — unit-boundary gate invocation, STOP/defer posture (T04 wiring).
- `bin/forge-run` — headless supervisor defer posture (T04 wiring).
- `forge-agent-prefs.md § Maintenance Settings` — `maintenance.in_auto: stop|defer|off`.
- `shared/forge-review.md` — the sibling boundary-agnostic gate spec this document mirrors in structure and tone.
