# S01 — Error classifier + retry integration

**Milestone:** M002
**Risk:** medium
**Depends:** []
**Planned:** 2026-04-16

---

## Goal

Give the Forge orchestrator automatic recovery from transient provider errors (rate limits, network drops, 5xx, stream truncations, connection resets) so `/forge-auto` and `/forge-next` survive flaky API conditions instead of aborting a milestone mid-run. Port the classification regex logic from GSD-2's `error-classifier.js` into a small, deterministic Node CLI + module at `scripts/forge-classify-error.js`, and wire a retry handler into the shared dispatch layer so both commands and the `forge-auto` skill behave identically.

---

## Acceptance criteria

1. **Smoke test on day 1.** Before writing classifier code, T01 forces a mock `Agent()` exception (503 / 429 / ECONNRESET) inside the forge-auto loop and confirms the exception text reaches the orchestrator's catch path readable enough for regex to match. If opaque → abort slice, escalate; do not proceed.
2. **Node classifier exists and is pure.** `scripts/forge-classify-error.js` exports `classifyError(errorMsg, retryAfterMs?)` returning `{kind, retry, backoffMs}` and provides a CLI mode (stdin or `--msg`) that prints the JSON result to stdout. No network, no I/O, no npm deps.
3. **Retry handler lives in `shared/forge-dispatch.md`.** New section `### Retry Handler` documents: catch Agent() throw → shell out to classifier → apply per-class policy (backoff 2s/4s/8s for retryable kinds; immediate stop for permanent/refusal) → append `{event:"retry", ...}` line to `events.jsonl` → on success resume, on exhaustion surface clean error.
4. **Both commands and the skill consume the handler.** `commands/forge-next.md`, `commands/forge-auto.md` (if/when present — currently the auto command lives as a skill), and `skills/forge-auto/SKILL.md` wrap their `Agent()` dispatch site with the Retry Handler flow. MEM015 respected — `forge-next` structural divergence preserved; no mechanical merge.
5. **Prefs contract.** `forge-agent-prefs.md` gains a `retry:` block with `max_transient_retries: 3` default plus per-class notes. Dispatch handler reads `PREFS.retry.max_transient_retries` when deciding when to stop.
6. **Demo transcript.** `S01-SUMMARY.md` includes a transcript of three forced errors (503 server, 429 rate-limit, ECONNRESET network) going through the full loop: classifier output, events.jsonl lines, final outcome.

Each criterion must be observable — either by running the classifier CLI directly, tailing `events.jsonl`, or reading the updated artefacts.

---

## Tasks (5)

- [x] **T01 — Smoke test: verify Agent() exception is classifier-legible**
  Force a mock transient error from within the orchestrator, inspect the raw exception text that reaches the catch path, confirm at least one of `PERMANENT_RE`/`RATE_LIMIT_RE`/`NETWORK_RE`/`SERVER_RE`/`CONNECTION_RE`/`STREAM_RE` would match. Write findings to `.gsd/milestones/M002/slices/S01/S01-SMOKE.md`. Gate for the rest of the slice.

- [x] **T02 — Port classifier to `scripts/forge-classify-error.js`**
  Create the Node CLI + module. 1:1 port of the six regex groups from GSD-2. Dual-mode: `require()` in Node OR `node scripts/forge-classify-error.js --msg "..."` from Bash. Exit code 0 always (errors are data, not failures).

- [x] **T03 — Add Retry Handler section to `shared/forge-dispatch.md`**
  New `### Retry Handler` section with a markdown-prose algorithm that the orchestrator follows when `Agent()` throws. Uses T02's CLI. Writes `events.jsonl` entries with `{ts, event:"retry", unit, class, attempt, backoff_ms}`. Honors `PREFS.retry.max_transient_retries`.

- [x] **T04 — Wire handler into forge-auto skill + forge-next command**
  Patch `skills/forge-auto/SKILL.md` Step 4 Dispatch and the equivalent section in `commands/forge-next.md` (when it exists — confirm path; if the command is also a skill, patch the skill file). Keep each file's structural quirks (MEM015: forge-next has a memory injection block forge-auto does not — do NOT merge templates).

- [x] **T05 — Prefs + demo + summary**
  Add `retry:` block to `forge-agent-prefs.md` with `max_transient_retries: 3` default + per-class notes. Run demo: force 503, 429, ECONNRESET via the smoke harness from T01; collect transcripts; write `S01-SUMMARY.md` with all three demos + events.jsonl excerpts.

---

## Task ordering / dependencies

```
T01 (smoke test — gate)
  └── T02 (classifier script)
        └── T03 (dispatch retry handler)
              └── T04 (wire into commands/skills)
                    └── T05 (prefs + demo + summary)
```

T01 is a hard gate: if the exception text is opaque to the orchestrator's catch path, abort S01 before writing classifier code (per M002-ROADMAP.md Risk Notes). All other tasks are sequential — each reuses artefacts from the previous.

---

## Out of scope (defer to later slices or milestones)

- Token counting in retry events (S03)
- Tier-based model downgrade on retry (S04)
- Capability scoring / cross-provider retry (deferred to M003+)
- Verification-gate retry wiring (S02 consumes the classifier; wiring lives there)

---

## Files produced

- `scripts/forge-classify-error.js` (new)
- `shared/forge-dispatch.md` (modified — new `### Retry Handler` section)
- `skills/forge-auto/SKILL.md` (modified — Dispatch step wraps Agent() in handler)
- `commands/forge-next.md` (modified if exists; verify in T04)
- `forge-agent-prefs.md` (modified — new `retry:` block)
- `.gsd/milestones/M002/slices/S01/S01-SMOKE.md` (new — T01 evidence)
- `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` (new — T05 demo transcript, completer writes final version)

## Files consumed

- `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js` (reference — regex source of truth)
- Existing `shared/forge-dispatch.md`, `skills/forge-auto/SKILL.md`, `commands/forge-next.md` (edit targets)
