# S02 — Verification gate executable

**Milestone:** M002
**Risk:** high
**Depends:** [S01]
**Planned:** 2026-04-16

---

## Goal

Port GSD-2's verification gate into Forge as a deterministic Node CLI + module at
`scripts/forge-verify.js` that runs typecheck/lint/test commands before a task or
slice can be marked "done". The gate must (a) discover commands via a 3-step chain
(explicit `verify:` in T##-PLAN frontmatter → `prefs.verification.preference_commands` →
auto-detected `package.json` scripts with an allow-list), (b) skip gracefully in
docs-only repos with `skipped:"no-stack"`, (c) truncate stderr to 10 KB using a
head+tail strategy so the failure context injected back into the retry prompt
preserves both the error line and the stack tail, and (d) enforce a 120 s timeout
per command so an infinite `npm test` cannot hang the whole milestone. Wiring this
into `agents/forge-executor.md` (task-level gate) and `agents/forge-completer.md`
(slice-level gate) closes the "all steps done ≠ verified" gap in the orchestrator.

---

## Acceptance criteria

1. **Discovery chain is exhaustive and well-ordered.** `forge-verify.js` tries sources
   in the order: (1) `--plan` T##-PLAN frontmatter `verify:` field, (2)
   `PREFS.verification.preference_commands`, (3) auto-detect `package.json` scripts
   filtered to allow-list `[typecheck, lint, test]` only. First non-empty wins.
   If none match AND `package.json`/`pyproject.toml`/`go.mod` are all absent AND
   `preference_commands` is empty AND `plan.verify` is absent → return
   `{skipped: "no-stack", passed: true, exit: 0}`. Any other code path MUST error
   explicitly with a human-readable reason.

2. **Allow-list is frozen.** The package.json auto-detect runs ONLY these script
   keys (in this order, skipping absent ones): `typecheck`, `lint`, `test`. It
   never runs `start`, `dev`, `build`, `prepare`, `postinstall`, `watch`, `serve`,
   or any custom script.

3. **Cross-platform spawn works.** On Windows (`process.platform === 'win32'`),
   the script spawns `cmd /c <cmd>`; on POSIX it spawns `sh -c <cmd>`. Tested on
   the current win32 environment. Each command gets `timeout: 120_000`; on
   timeout the exit code is synthetic `124` and the event is logged as
   `{skipped: "timeout", cmd, exit: 124}` (not as a permanent failure).

4. **Stderr truncation preserves head + tail.** When combined stderr exceeds 10 KB
   per command, the script emits the first 3 KB + a `\n[...N bytes elided...]\n`
   marker + the last 7 KB. Per-check stderr also wrapped to 10 KB. Total failure
   context injected into the next prompt capped at 10 KB overall.

5. **Events.jsonl telemetry.** Every gate run (pass, fail, or skip) appends one
   JSON line to `.gsd/forge/events.jsonl` shaped
   `{ts, event:"verify", unit, slice, task, discovery_source, commands:[...],
     passed, skipped?, duration_ms}`. On skip, `skipped: "no-stack" | "timeout"`.
   I/O errors on the write MUST throw (not swallow) — telemetry is a hard
   contract per S02-RISK executor notes.

6. **Task-level gate blocks `done`.** `agents/forge-executor.md` invokes
   `node scripts/forge-verify.js --plan {T##-PLAN} --cwd {WORKING_DIR} --unit execute-task/{T##}`
   before writing T##-SUMMARY. On non-zero exit, returns `partial` with the
   failure context (from `formatFailureContext`) injected into the next retry
   prompt under `## Verification Failures`. On skip, continues normally.

7. **Slice-level gate runs before squash-merge.** `agents/forge-completer.md`
   invokes the same script at slice level (step 3, before the existing security
   scan and lint gate) and writes a `## Verification Gate` section into
   `S##-SUMMARY.md` with discovery source, commands run, per-command exit codes,
   and total duration. Slice-level gate is documented as potentially using a
   different command set (prefs override) than task-level in `S02-CONTEXT.md`.

8. **Transient-error retry integration.** If `spawnSync` returns an error whose
   message matches S01's classifier as retryable (e.g. npm registry 503, DNS
   flake), the script surfaces the error text — it does NOT invoke the retry
   handler itself (that's an orchestrator concern). BUT the script passes a
   `--from-verify` sentinel flag on its re-invocation path and documents that
   the orchestrator's Retry Handler MUST NOT re-invoke verify inside a verify
   failure (anti-recursion guard).

9. **Prefs block exists.** `forge-agent-prefs.md` gains a `verification:` block
   with `preference_commands: []` default and inline documentation of the
   discovery chain, allow-list, timeout, and skip semantics.

10. **Dispatch template updates.** `shared/forge-dispatch.md` `execute-task` and
    `complete-slice` templates gain a `## Verification Gate` instruction block
    that tells the worker to invoke the gate at the right step, injects the
    failure context into the retry prompt, and records the gate result in the
    summary.

11. **Smoke-test evidence.** `S02-SUMMARY.md` includes five manual transcripts:
    (a) Node repo with `package.json {scripts:{test:"echo ok"}}` → passes with
    `discovery_source:"package.json"`; (b) Task with explicit
    `verify: echo custom` in frontmatter → runs only that command, ignores
    auto-detect; (c) Docs-only repo (temp dir with only `.md` files) →
    `skipped:"no-stack"`, exit 0; (d) Mock command with 20 KB stderr → verifies
    head+tail truncation; (e) Mock command that sleeps 130 s → verifies 120 s
    timeout + synthetic exit 124.

12. **Dogfood.** Running `node scripts/forge-verify.js --cwd .` on the forge-agent
    repo itself (no package.json) returns `{skipped:"no-stack"}`, exit 0. If
    forge-agent later adds a `package.json`, the gate must still pass.

Each criterion is observable via `events.jsonl`, CLI invocation, or reading the
updated artefacts.

---

## Tasks (6)

- [ ] **T01 — Port `runVerificationGate` + discovery chain to `scripts/forge-verify.js`**
  Port the `spawnSync` runner, command sanitizer, head+tail stderr truncation,
  timeout handling, and discovery chain from GSD-2's `verification-gate.js`
  (lines 31–252, strip `captureRuntimeErrors` and `runDependencyAudit` — out of
  scope). CommonJS dual-mode (module + CLI). Freeze package.json allow-list to
  `[typecheck, lint, test]`. Ship smoke test inline (`echo ok` passes, missing
  stack returns `no-stack`, 20 KB stderr truncates head+tail, sleep 130 →
  timeout).

- [ ] **T02 — Add `## Verification Gate` section to `shared/forge-dispatch.md`**
  New section describing: (a) when executor invokes the gate (before T##-SUMMARY),
  (b) when completer invokes it (step 3, before lint gate), (c) the exact CLI
  shape, (d) how to inject `formatFailureContext()` output into the next retry
  prompt as `## Verification Failures`, (e) events.jsonl schema for
  `event:"verify"`, (f) anti-recursion rule: verify failures MUST NOT trigger
  Retry Handler re-dispatch of verify itself (only the worker). Respect existing
  file's token pressure — extract to sub-file if combined with Retry Handler
  section (S01) pushes past limits.

- [ ] **T03 — Wire task-level gate into `agents/forge-executor.md`**
  Add a new step between current step 9 (verify every must-have) and step 11
  (write T##-SUMMARY): invoke `node scripts/forge-verify.js --plan {T##-PLAN}
  --cwd {WORKING_DIR} --unit execute-task/{T##}`. On non-zero exit (and not
  `skipped`), refuse to return `done` — return `partial` with the failure
  context injected. On skip, continue. Update the task plan's `## Verification
  Gate` injection to surface the gate result in T##-SUMMARY.

- [ ] **T04 — Wire slice-level gate into `agents/forge-completer.md`**
  Add a new step 3 (before existing security scan and lint gate) that invokes
  the same script at slice level. Record commands, exit codes, discovery source,
  and total duration as a `## Verification Gate` section in `S##-SUMMARY.md`.
  Document in `S02-CONTEXT.md` that task-level runs per-T## frontmatter and
  slice-level reads from prefs.

- [ ] **T05 — Add `verification:` block to `forge-agent-prefs.md`**
  New `## Verification Settings` section with `preference_commands: []` default,
  inline documentation of: the 3-step discovery chain, the frozen allow-list
  (`typecheck/lint/test`), the 120 s per-command timeout, the skip semantics
  for docs-only repos, and the security note ("preference_commands run in the
  repo's shell — do NOT add unreviewed commands"). Cross-reference
  `scripts/forge-verify.js` and `shared/forge-dispatch.md ## Verification Gate`.

- [ ] **T06 — Run five smoke tests + dogfood + write summary**
  Run the five scenarios from acceptance criterion 11 (Node repo, explicit
  verify, docs-only, 20 KB stderr, sleep 130 s) + dogfood on the forge-agent
  repo itself. Capture stdout + events.jsonl excerpts. Write `S02-SUMMARY.md`
  with transcripts, total duration, and a one-line verdict. The completer will
  finalize this file; T06 produces the evidence section.

---

## Task ordering / dependencies

```
T01 (forge-verify.js + CLI + module + all truncation/timeout logic)
  └── T02 (dispatch.md section documenting how workers invoke T01)
        ├── T03 (executor agent wired to T01 + T02)
        └── T04 (completer agent wired to T01 + T02 at slice level)
              └── T05 (prefs block — configuration surface for T03/T04)
                    └── T06 (five smokes + dogfood + summary evidence)
```

T01 is the foundation — no other task can run without a working verify.js. T02
documents the contract BEFORE T03/T04 modify agents, so executor + completer
agree on invocation shape. T03 and T04 can run in parallel but safer serialized.
T05 adds the pref contract. T06 verifies everything end-to-end.

---

## Risk mitigations (mapped to S02-RISK.md)

| Risk | Mitigation | Task |
|------|-----------|------|
| **B1** — docs-only repo could block legit work | 4-condition AND-gate in T01 (`no package.json` AND `no pyproject.toml` AND `no go.mod` AND `preference_commands empty` AND `plan.verify absent` → `skipped:"no-stack"`). Smoke test (e) in T06. | T01, T06 |
| **B2** — auto-detect invokes wrong script | Frozen allow-list `[typecheck, lint, test]` hardcoded in T01. No custom scripts. Unit test inline. | T01 |
| **B3** — Windows cmd vs sh dispatch | `process.platform === 'win32'` branch — ported verbatim from GSD-2 lines 217–218. Tested on current win32 env in T06. | T01, T06 |
| **W1** — command timeout missing | `timeout: 120_000` per command; synthetic exit 124 on timeout; events.jsonl logs `skipped:"timeout"`. Smoke (e) in T06. | T01, T06 |
| **W2** — stderr truncation loses root cause | Head (3 KB) + tail (7 KB) strategy with `[...N bytes elided...]` marker. Smoke (d) in T06. | T01, T06 |
| **W3** — retry handler + verify loop | Anti-recursion rule in T02 dispatch doc: Retry Handler classifies Agent() throws only; verify failures (non-zero exit) go straight to `partial` — do NOT route through classifier. `--from-verify` sentinel documented but unused within the script (marker for orchestrator). | T02 |
| **W4** — executor + completer gate divergence | Task-level reads T##-PLAN frontmatter `verify:` first; slice-level reads prefs `preference_commands`. Documented in `S02-CONTEXT.md` written by T04. | T03, T04 |
| **W5** — `verify:` YAML frontmatter parsing | T01 accepts both string (`verify: "npm run typecheck && npm test"`) and array (`verify: [npm run typecheck, npm test]`); string is split on `&&`. Documented in T05 prefs block. | T01, T05 |
| **W6** — dispatch.md token pressure | T02 measures file size before/after; if combined with S01 Retry Handler section (already 161 lines added) + expected S03/S04 blocks would blow a hypothetical 1000-line limit, extract to `shared/forge-verify-gate.md` and cross-link. Current file is ~660 lines after S01; verify gate section budgeted at ~150 lines. | T02 |

---

## Out of scope (defer to later milestones)

- Runtime error capture (bg-shell + browser console) — GSD-2 has `captureRuntimeErrors`; Forge does not (per SCOPE.md).
- Dependency audit (`npm audit` on package.json changes) — GSD-2 has `runDependencyAudit`; deferred.
- Python / Go / Rust auto-detect beyond file presence check — M003+ if needed.
- Retry backoff for verify failures themselves — classifier is for Agent() exceptions only; verify exit codes go straight to `partial`.
- `/forge-status` integration (verify pass rate per milestone) — deferred to S03 telemetry work.
- Test runner parallelization — commands run sequentially per GSD-2 port.

---

## Files produced

- `scripts/forge-verify.js` (new)
- `shared/forge-dispatch.md` (modified — new `## Verification Gate` section + template injections in `execute-task` and `complete-slice`)
- `agents/forge-executor.md` (modified — new verify step between "verify must-haves" and "write summary")
- `agents/forge-completer.md` (modified — new step 3 verify gate, reshuffles existing 3 → 4, 4 → 5, etc.)
- `forge-agent-prefs.md` (modified — new `## Verification Settings` section)
- `.gsd/milestones/M002/slices/S02/S02-CONTEXT.md` (new — written by T04, documents task-level vs slice-level gate split)
- `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md` (new — T06 demo transcripts, completer finalizes)

## Files consumed

- `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/verification-gate.js` (reference — GSD-2 source of truth, lines 31–252 only)
- `scripts/forge-classify-error.js` (S01 — consumed by documentation only; verify does not shell out to classifier)
- `shared/forge-dispatch.md ### Retry Handler` (S01 — referenced for anti-recursion rule)
- Existing `agents/forge-executor.md`, `agents/forge-completer.md`, `forge-agent-prefs.md` (edit targets)

---

## Pattern

This slice instantiates the **Node CLI + module dual-mode** pattern for the
deterministic runner (T01), the **Dispatch template (shared)** pattern for T02,
and the **Risk/Security gate skill** pattern adapted for agent-side invocation
(T03, T04). See `CODING-STANDARDS.md ## Pattern Catalog`.
