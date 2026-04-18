---
status: DONE
---
# T03: Wire Token Telemetry into `forge-auto` + `forge-next` skills

**Slice:** S03  **Milestone:** M002

## Goal

Patch the dispatch loop in `skills/forge-auto/SKILL.md` (Step 4 — Dispatch)
and the equivalent dispatch block in `skills/forge-next/SKILL.md` so both
invoke the Token Telemetry algorithm from `shared/forge-dispatch.md`
(defined in T02) around every `Agent()` call. Each skill must: (a) compute
`input_tokens` after prompt substitution but before dispatch, (b) capture
`output_tokens` from worker result, (c) append the `event:"dispatch"` line
to `.gsd/forge/events.jsonl` per T02's event log format, and (d) also add
the `input_tokens` field to the existing retry event append on retry paths.
MEM015 preserved — patch each skill independently; do NOT merge templates.
MEM018 token-budget discipline — both skill files stay under their
respective budgets post-patch.

## Must-Haves

### Truths

- **Two files patched; NO third location:**
  - `skills/forge-auto/SKILL.md`
  - `skills/forge-next/SKILL.md`
  - `commands/forge-next.md` does NOT exist in the current repo (verified at slice planning time — current codebase has `skills/forge-next/SKILL.md` instead). If `commands/forge-next.md` appears during this task, also patch it with the same block. Document observation in summary.
- **In each file, locate the dispatch block.**
  - `skills/forge-auto/SKILL.md` — Step 4 "Dispatch" (around line 193). The existing `Agent(workerType, prompt)` call is wrapped in the Retry Handler try/catch from S01 T04. The Token Telemetry integration lives INSIDE that try block, immediately before the `Agent()` call (for `input_tokens`) and immediately after successful return / inside the catch retry-event append (for `output_tokens`).
  - `skills/forge-next/SKILL.md` — equivalent dispatch block. **Preserve MEM015**: forge-next has a unique selective-memory-injection block at its Step 3 that forge-auto does not have. Patch only the dispatch wrapper; leave memory injection untouched.
- **New bash helper calls inside each skill:**
  - `input_tokens` computation: `node scripts/forge-tokens.js` reading from stdin (pipe the prompt). The skill shells out via `Bash` with the prompt piped to the CLI. Alternative acceptable: compute inline via a small JS snippet (`node -e "..."`). Pick ONE approach and use it consistently across both files.
  - `output_tokens` computation: same CLI, fed the worker result text via stdin. Skip when the worker result metadata includes usage (document both paths).
- **Events.jsonl append block** — each skill writes one JSON line per dispatch event. Shape matches T02 spec exactly:
  ```json
  {"ts":"<ISO8601>","event":"dispatch","unit":"<unit_type>/<unit_id>","model":"<model_id>","input_tokens":<N>,"output_tokens":<N>}
  ```
  Use `mkdir -p .gsd/forge/` first. Use `>> .gsd/forge/events.jsonl` append (never rewrite).
- **Retry integration:**
  - The existing Retry Handler snippet at the end of `shared/forge-dispatch.md` (current lines 404–443) is referenced from both skills already. In the retry catch block, where the skill calls `appendToEventsLog({event:"retry", ...})`, add the `input_tokens: <N>` field computed from the retry prompt.
  - The retry path does NOT emit a separate `event:"dispatch"` entry — the retry entry captures it. The SUCCESS path of `Agent()` DOES emit an `event:"dispatch"` entry.
- **I/O errors on the events.jsonl append MUST propagate** (no try/catch swallowing). Same contract as verify gate in S02. Document the intentional non-swallow in a comment near the append.
- **MEM018 budget guard:**
  - `skills/forge-auto/SKILL.md` post-patch: `node scripts/forge-tokens.js --file skills/forge-auto/SKILL.md` must print `tokens <= 4500`. Current baseline ~4200 per MEM018; budget of +300 tokens for this edit.
  - `skills/forge-next/SKILL.md` post-patch: `tokens <= 4800`. Current baseline ~4700 per MEM018; budget of +100 tokens for this edit.
  - If either budget is exceeded after drafting, REFACTOR the inserted prose: move lengthy explanations to `shared/forge-dispatch.md ### Token Telemetry` and keep the skill-side edit to a single "call the Token Telemetry algorithm from shared/forge-dispatch.md around this Agent() call" reference line + a bash snippet. Target: < 20 new lines per skill.
- **Reference-only, not duplication:** The actual algorithm prose lives in `shared/forge-dispatch.md ### Token Telemetry` (T02). The skills must REFERENCE it (`Per shared/forge-dispatch.md § Token Telemetry, ...`) and include only the INVOCATION: compute, dispatch, log. No re-explanation of "why" or "when" in the skill file.
- **Idempotent re-run:** After patching, re-running the patch logic (or this task twice) must not double-insert. Use a recognisable marker comment (`<!-- token-telemetry-integration -->`) at the insertion point in each file so future grep-based checks can detect existing wiring.
- **No edits to:**
  - `shared/forge-dispatch.md` — already updated by T02.
  - `skills/forge-next/SKILL.md` step 3 memory-injection block (MEM015 — structural divergence from forge-auto).
  - `forge-agent-prefs.md` — T05's concern.
  - `skills/forge-status/SKILL.md` — T04's concern.
  - Any agent file under `agents/`.

### Artifacts

- `skills/forge-auto/SKILL.md` — modified. Net add ~15–25 lines; at most 1 unchanged anchor line edited.
- `skills/forge-next/SKILL.md` — modified. Net add ~15–25 lines; at most 1 unchanged anchor line edited.
- `.gsd/milestones/M002/slices/S03/tasks/T03/T03-SUMMARY.md` — new file with: (a) diff summary (line counts before/after for both files), (b) grep confirmation of the marker comment in both files, (c) token-budget verification output (`node scripts/forge-tokens.js --file`) for both skill files.

### Key Links

- `shared/forge-dispatch.md ### Token Telemetry` (T02) → REFERENCED (not copied) from both skill edits.
- `scripts/forge-tokens.js` (T01) → invoked via Bash from both skills.
- `skills/forge-auto/SKILL.md` Step 4 — dispatch anchor.
- `skills/forge-next/SKILL.md` dispatch block — dispatch anchor (location to be confirmed at task start).
- MEM015 (forge-next structural divergence) → must be preserved.
- MEM018 (token budgets for forge-auto ~4.2K, forge-next ~4.7K) → must not be busted.

## Steps

1. Prereq check: confirm T01 and T02 are done.
   - `test -f scripts/forge-tokens.js && echo T01-OK || echo T01-MISSING`
   - `grep "### Token Telemetry" shared/forge-dispatch.md && echo T02-OK || echo T02-MISSING`
   - If either is missing → return `blocked` with `blocker_class: external_dependency`.
2. Read `skills/forge-auto/SKILL.md` in full. Identify:
   - Step 4 "Dispatch" block.
   - The existing `Agent(workerType, prompt)` call site.
   - The retry-handler integration from S01 T04 (around `appendToEventsLog({event:"retry", ...})`).
   - Any existing `<!-- token-telemetry-integration -->` marker. If present, T03 has already been run — return `done` with no edits.
3. Read `skills/forge-next/SKILL.md` in full. Identify the same three anchor points. Note the unique selective-memory-injection block (MEM015) and confirm it lives OUTSIDE the dispatch wrapper.
4. Read `shared/forge-dispatch.md ### Token Telemetry` end-to-end. Internalise the algorithm (T02 prose is the source of truth). Capture the exact event-line shape for copy-paste consistency.
5. Draft the patch for `skills/forge-auto/SKILL.md`:
   - Insert marker comment `<!-- token-telemetry-integration -->` immediately above the `Agent(workerType, prompt)` call.
   - Insert an `Input token accounting` mini-step (3–5 lines):
     ```bash
     # Per shared/forge-dispatch.md § Token Telemetry — compute input tokens
     INPUT_TOKENS=$(printf '%s' "$prompt" | node scripts/forge-tokens.js | node -e "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).tokens))")
     ```
     (Adjust to skill's actual variable/prompt naming — the existing skill uses markdown-prose pseudocode; match its style. Keep the block short.)
   - After the `Agent()` returns successfully, insert an `Output token accounting + events.jsonl append`:
     ```bash
     # Capture output tokens; prefer SDK usage metadata, fall back to heuristic
     OUTPUT_TOKENS=$(printf '%s' "$result" | node scripts/forge-tokens.js | ...)
     mkdir -p .gsd/forge/
     echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${modelId}\",\"input_tokens\":${INPUT_TOKENS},\"output_tokens\":${OUTPUT_TOKENS}}" >> .gsd/forge/events.jsonl
     ```
     (Adapt variable names to match the existing skill's conventions. If the skill uses pseudocode, keep pseudocode style.)
   - In the retry catch block: extend the existing retry-event append to also include `"input_tokens": <N>` computed from the retry prompt.
6. Apply the patch to `skills/forge-auto/SKILL.md` using `Edit` tool.
7. Verify budget: `node scripts/forge-tokens.js --file skills/forge-auto/SKILL.md` — must print `tokens <= 4500`. If over, refactor: move explanation to `shared/forge-dispatch.md`, keep skill edit minimal.
8. Repeat steps 5–7 for `skills/forge-next/SKILL.md`:
   - Same marker comment.
   - Same 3 insertion points (input accounting, output + append, retry field).
   - CRITICAL: do NOT merge with forge-auto's dispatch block. Keep whatever structural differences exist (MEM015). The INSERTED content is identical in shape; the ANCHOR locations differ.
   - Budget target: `tokens <= 4800`.
9. Inline verification for both files:
   - `grep "token-telemetry-integration" skills/forge-auto/SKILL.md` → 1 hit.
   - `grep "token-telemetry-integration" skills/forge-next/SKILL.md` → 1 hit.
   - `grep "event\":\"dispatch" skills/forge-auto/SKILL.md` → at least 1 hit (the append line or its reference).
   - `grep "event\":\"dispatch" skills/forge-next/SKILL.md` → at least 1 hit.
   - `grep "input_tokens" skills/forge-auto/SKILL.md` → at least 2 hits (input + retry-event extension).
   - `grep "input_tokens" skills/forge-next/SKILL.md` → at least 2 hits.
   - `node scripts/forge-tokens.js --file skills/forge-auto/SKILL.md` → tokens < 4500.
   - `node scripts/forge-tokens.js --file skills/forge-next/SKILL.md` → tokens < 4800.
   - `node -c scripts/forge-tokens.js` → still passes (unrelated but sanity-check the dependency).
10. **No runtime smoke here.** Actual events.jsonl dispatch lines will be verified in T06's smoke scenario 4. If forge-auto or forge-next happens to dispatch a unit during this task (it shouldn't), capture the events.jsonl tail in the summary as bonus evidence.
11. Write `T03-SUMMARY.md` with diff summary, grep outputs, and token counts per file.

## Standards

- **Target directories:** `skills/forge-auto/` and `skills/forge-next/` — matches skill directory convention (`SKILL.md` per skill per `.gsd/CODING-STANDARDS.md § Directory Conventions`).
- **Reuse:**
  - `shared/forge-dispatch.md ### Token Telemetry` (T02) — the canonical algorithm; skills REFERENCE it, don't duplicate.
  - `scripts/forge-tokens.js` (T01) — shelled out via `Bash` for input/output token computation.
  - Existing Retry Handler integration from S01 T04 — the new input_tokens field extends the existing retry-event append (not a separate line).
  - Existing `events.jsonl append pattern` asset (MEM from asset map: `skills/forge-auto/SKILL.md` Step 6a) — mirror the one-line JSON shape.
- **Naming:**
  - Marker comment: `<!-- token-telemetry-integration -->` (kebab-case, explicit, grep-able).
  - Bash variables: `INPUT_TOKENS`, `OUTPUT_TOKENS` (UPPER_SNAKE per shell convention).
  - JSON field names: `input_tokens`, `output_tokens` (snake_case — matches `backoff_ms` precedent in retry events).
- **Markdown style:** match each skill's existing prose/pseudocode style. Some skills use concrete bash blocks; some use markdown-prose descriptions. Match what's there — do not rewrite the surrounding style.
- **Idempotency:** marker comment makes re-runs a no-op. Grep the marker before inserting; if present, exit 0 with a note.
- **Language:** English for code comments, pt-BR for user-visible strings (there are none in this patch — all added content is internal orchestrator logic).
- **Lint command:**
  - `node -c scripts/forge-tokens.js` (sanity — script still parses).
  - `node scripts/forge-tokens.js --file skills/forge-auto/SKILL.md` (budget check).
  - `node scripts/forge-tokens.js --file skills/forge-next/SKILL.md` (budget check).
  - No markdown lint per CODING-STANDARDS.md.
- **Pattern:** `follows: events.jsonl append` from `.gsd/CODING-STANDARDS.md § Pattern Catalog` — one-line JSON per event, `mkdir -p .gsd/forge/` first, `>>` append, never rewrite.

## Context

- **MEM015 preservation is mandatory:** forge-next has a unique selective-memory-injection block at Step 3 that forge-auto does not. The dispatch wrapper edit for forge-next happens AFTER that block, not inside it. Patch each skill independently.
- **MEM018 budget discipline:** both skill files have hard token budgets. Re-check after patch; refactor if over. Push explanation prose to `shared/forge-dispatch.md` rather than bloat the skills.
- **S01 Retry Handler integration point:** the existing retry-event append in each skill already writes `{event:"retry", unit, class, attempt, backoff_ms, model}`. T03 adds `input_tokens` to that same entry — a single field extension, not a new line.
- **T02 dependency:** `shared/forge-dispatch.md ### Token Telemetry` MUST exist and document the event schema and algorithm. If missing, this task returns `blocked`.
- **T01 dependency:** `scripts/forge-tokens.js` MUST exist and be CLI-callable. Verified via `test -f`.
- **Key files to read first:**
  - `skills/forge-auto/SKILL.md` Step 4 (dispatch block)
  - `skills/forge-next/SKILL.md` dispatch block (location to confirm)
  - `shared/forge-dispatch.md ### Token Telemetry` (T02 output — source of truth)
  - `shared/forge-dispatch.md ### Retry Handler` lines 283–441 (retry-event shape to extend)
  - `.gsd/milestones/M002/slices/S03/tasks/T01/T01-SUMMARY.md` (T01 completion evidence)
