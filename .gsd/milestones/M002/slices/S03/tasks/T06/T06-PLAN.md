# T06: Smoke tests + S03-SUMMARY.md (draft)

status: DONE

**Slice:** S03  **Milestone:** M002

## Goal

Execute four mandatory smoke scenarios against the token counter + context
budget pipeline shipped in T01–T05: (1) heuristic correctness on known
strings, (2) boundary-aware truncation on a ~10 000-token synthetic
AUTO-MEMORY.md with marker format verified, (3) mandatory-section
overflow throws with the correct error message, (4) end-to-end dispatch
emission + `/forge-status` Token usage block rendering. Capture all
outputs verbatim and produce a draft `S03-SUMMARY.md` (completer will
finalise). No git operations.

## Must-Haves

### Truths

- **Prereq check at task start (hard blocker):**
  - `scripts/forge-tokens.js` exists.
  - `shared/forge-dispatch.md ### Token Telemetry` exists.
  - `skills/forge-auto/SKILL.md` contains `<!-- token-telemetry-integration -->` marker.
  - `skills/forge-next/SKILL.md` contains `<!-- token-telemetry-integration -->` marker.
  - `skills/forge-status/SKILL.md` contains `### Token usage`.
  - `forge-agent-prefs.md` contains `token_budget:`.
  - If ANY missing → return `blocked` with `blocker_class: external_dependency` and the list of missing prereqs.
- **Scenario 1: Heuristic correctness on known strings.**
  - `printf 'hello world' | node scripts/forge-tokens.js` → `{"tokens":3,"chars":11,"method":"heuristic"}`.
  - `printf '' | node scripts/forge-tokens.js` → `{"tokens":0,"chars":0,"method":"heuristic"}`.
  - `node scripts/forge-tokens.js --file CLAUDE.md` → tokens = `Math.ceil(chars/4)`. Verify: `chars=$(wc -c < CLAUDE.md)` and `expected=$(node -e "console.log(Math.ceil($chars/4))")` matches the JSON output.
  - `node scripts/forge-tokens.js --file scripts/forge-tokens.js` → self-count. Non-zero.
  - ASSERT block from T01 re-exercised: `FORGE_TOKENS_SELFTEST=1 node -e "require('./scripts/forge-tokens.js')"` — exit 0, no output (all ASSERTs pass silently).
- **Scenario 2: Boundary-aware truncation on synthetic AUTO-MEMORY.md.**
  - Generate a synthetic memory file:
    ```bash
    node -e "
      const sections = [];
      for (let i = 1; i <= 50; i++) {
        sections.push('## MEM' + String(i).padStart(3,'0') + '\n' + 'x'.repeat(800) + '\n');
      }
      require('fs').writeFileSync('/tmp/synth-memory.md', sections.join('\n'));
    "
    ```
    (On Windows: `C:/temp/synth-memory.md`.)
  - Confirm file size: `wc -c /tmp/synth-memory.md` → ~40 000+ chars. Confirm tokens: `node scripts/forge-tokens.js --file /tmp/synth-memory.md` → ~10 000+ tokens.
  - Truncate with 2000-token budget (8000 chars): `node scripts/forge-tokens.js --file /tmp/synth-memory.md --truncate 8000 > /tmp/synth-memory-truncated.md`.
  - Parse output: the `truncated_chars` field in the JSON should be <= 8000 + marker length (~40 chars). Confirm.
  - Check marker presence: `grep '\[\.\.\.truncated [0-9]* sections\]' /tmp/synth-memory-truncated.md` → exactly 1 hit.
  - Check H2 boundary: the line BEFORE the marker must END at the end of a section — i.e., the LAST `## MEM` line content. Verify by checking that the second-to-last line matches `/^x+$/` (content of a section) and the immediate preceding section header exists.
  - Extract N from marker and verify: if `50 - N_kept ~= N_dropped` (N_kept ≈ 8000 / 810 per-section ≈ 9–10; N_dropped ≈ 40–41).
- **Scenario 3: Mandatory-section overflow throws correctly.**
  - Negative test: `node scripts/forge-tokens.js --file CLAUDE.md --truncate 500 --mandatory 2>&1` → exit code 1 AND stderr contains `Context budget exceeded for mandatory section`.
  - Positive test (small input, under budget, mandatory=true should still succeed): `printf 'short text' | node scripts/forge-tokens.js --truncate 1000 --mandatory` → exit 0 with valid JSON.
  - Module-level test: `node -e "const {truncateAtSectionBoundary}=require('./scripts/forge-tokens.js'); try { truncateAtSectionBoundary('x'.repeat(1000), 100, {mandatory:true, label:'T99-PLAN'}); console.log('UNEXPECTED_PASS'); } catch(e) { console.log('OK: '+e.message); }"` → prints `OK: Context budget exceeded for mandatory section T99-PLAN: 1000 chars > 100 budget`.
- **Scenario 4: End-to-end dispatch emission + `/forge-status` rendering.**
  - **Option A (preferred): live dispatch.** Run `/forge-next` (or a single-unit forge-auto invocation) on a no-op unit. After the unit completes, tail `.gsd/forge/events.jsonl` — there should be at least one NEW `event:"dispatch"` line with `input_tokens` and `output_tokens` fields present and nonzero. Record the line. Then run `/forge-status` and capture the Token usage block output.
  - **Option B (fallback if no unit available to dispatch):** Hand-craft 3 dispatch events in `.gsd/forge/events.jsonl` (backup original first):
    ```
    {"ts":"2026-04-16T11:00:00Z","event":"dispatch","unit":"plan-slice/S03","model":"claude-opus-4-7","input_tokens":1200,"output_tokens":400}
    {"ts":"2026-04-16T11:05:00Z","event":"dispatch","unit":"execute-task/T01","model":"claude-sonnet-4-6","input_tokens":3200,"output_tokens":800}
    {"ts":"2026-04-16T11:10:00Z","event":"dispatch","unit":"execute-task/T02","model":"claude-sonnet-4-6","input_tokens":2400,"output_tokens":600}
    ```
    Run `/forge-status` and capture output. Confirm block shows: Total input = 6800, Total output = 1800, Dispatches = 3, por fase: plan-slice 1 · execute-task 2. Restore original events.jsonl.
  - Choose Option A if ANY real unit can dispatch during this task (check STATE.md — if the task itself emits a dispatch event that IS Option A). Option B is the documented fallback; always-available.
- **Draft `S03-SUMMARY.md`** written at `.gsd/milestones/M002/slices/S03/S03-SUMMARY.md`:
  - YAML frontmatter: `id: S03`, `milestone: M002`, `status: ready-for-completer`, `draft: true`. Completer finalises.
  - `## Goal` — one paragraph paraphrased from `S03-PLAN.md`.
  - `## Outcome` — one paragraph + bullet list of tasks T01–T06.
  - `## Artefacts produced` — table of files changed per task.
  - `## Smoke tests` — four subsections:
    - **Scenario 1: Heuristic correctness** — commands run, stdout outputs, verdict.
    - **Scenario 2: Boundary-aware truncation** — commands run, marker found, N count, H2 boundary check verdict.
    - **Scenario 3: Mandatory-section overflow** — three test outputs, expected error messages, verdict.
    - **Scenario 4: Dispatch + status rendering** — option chosen (A or B), events.jsonl excerpts, `/forge-status` output captured, verdict.
  - `## Risk mitigations verified` — table mapping each ROADMAP acceptance criterion to which scenario exercised it.
  - `## Known limitations` — brief list (heuristic error margin unmeasured; tiktoken deferred; per-milestone budgets OUT of scope; tier-aware cost math OUT of scope — deferred to S04).
  - One-line verdict: `All 4 scenarios passed; token counter + context budget pipeline is production-ready.` OR specific failure mode.
- **Cleanup and telemetry:**
  - `.gsd/forge/events.jsonl` in the forge-agent repo may have NEW lines from this task's own dispatch activity — that is expected. Do NOT clean them up.
  - Temporary smoke files (`/tmp/synth-memory.md`, `/tmp/synth-memory-truncated.md`, etc.) may be cleaned up after summary is written, or left — document location.
  - If Option B was used for scenario 4, the original `events.jsonl` MUST be restored before writing the summary.
- **NO commit is made by this task.** The completer's `complete-slice` step handles squash-merge. `auto_commit: true` or `false` — either way, T06 does not commit.

### Artifacts

- `.gsd/milestones/M002/slices/S03/S03-SUMMARY.md` — new file, ~120–200 lines (heavy with fenced blocks for stdout captures).
- `.gsd/forge/events.jsonl` — possibly appended via the task's own dispatch (orchestrator-level event). Do NOT delete.
- `.gsd/milestones/M002/slices/S03/tasks/T06/T06-SUMMARY.md` — new file with pointer to S03-SUMMARY.md and one-line verdict.
- Temporary files: `/tmp/synth-memory.md`, `/tmp/synth-memory-truncated.md` (or `C:/temp/` variants). Document location in summary.

### Key Links

- `.gsd/milestones/M002/slices/S03/S03-SUMMARY.md` → references `scripts/forge-tokens.js` (T01), `shared/forge-dispatch.md ### Token Telemetry` (T02), `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md` (T03), `skills/forge-status/SKILL.md` (T04), `forge-agent-prefs.md ## Token Budget Settings` (T05).

## Steps

1. Prereq check (hard gate). Run all six `grep`/`test -f` commands from the Prereq Truths above. If any fails → block.
2. Run Scenario 1 commands in sequence. Capture stdout verbatim. Compute expected `tokens` for `CLAUDE.md` independently (`node -e "const fs=require('fs'); console.log(Math.ceil(fs.readFileSync('CLAUDE.md').length/4))"`) and compare with CLI output. Record in summary.
3. Run Scenario 2:
   - Generate synthetic file at `/tmp/synth-memory.md` (or `C:/temp/synth-memory.md` on Windows). On win32, use `C:/temp/` throughout.
   - Confirm tokens: `node scripts/forge-tokens.js --file /tmp/synth-memory.md` → record.
   - Truncate with 2000-token budget: `node scripts/forge-tokens.js --file /tmp/synth-memory.md --truncate 8000 > /tmp/synth-memory-truncated.md`. Parse output JSON's `truncated_chars` field. Record.
   - Extract last lines of truncated file: `tail -3 /tmp/synth-memory-truncated.md`. Confirm marker pattern `[...truncated N sections]` and the section before it ends cleanly.
   - Verify N: count original sections (50), count surviving sections (grep -c '^## MEM' on truncated output), confirm `N_marker == 50 - surviving`.
4. Run Scenario 3:
   - Negative test: `node scripts/forge-tokens.js --file CLAUDE.md --truncate 500 --mandatory 2>&1` — capture both stdout and stderr. Confirm exit code 1 (`echo $?` or PowerShell equivalent) and stderr error message.
   - Positive test: `printf 'short text' | node scripts/forge-tokens.js --truncate 1000 --mandatory` — exit 0, valid JSON.
   - Module-level throw test via `node -e` one-liner. Capture output.
5. Run Scenario 4:
   - Check if any real dispatch event lands in `.gsd/forge/events.jsonl` during this task (the task itself is an `execute-task` — its own completion should emit a dispatch event via the Token Telemetry integration from T03). If YES → Option A.
   - If NO (e.g., running this task via manual simulation) → Option B. Back up events.jsonl (`cp .gsd/forge/events.jsonl /tmp/events.jsonl.bak 2>/dev/null`), append the 3 fabricated lines, run `/forge-status` or simulate the skill's aggregation block, capture output, restore backup.
   - Record both option decision and all captured outputs.
6. Draft `S03-SUMMARY.md` per the structure above. Fenced blocks for every stdout capture. Tables for artefacts and risk mitigations.
7. Append the T06 events.jsonl entry (this task's own dispatch event, produced by the executor's normal flow) — NOT a manual addition; it happens automatically via T03's integration. Just confirm it exists in the tail.
8. Write `T06-SUMMARY.md` with:
   - Pointer to `.gsd/milestones/M002/slices/S03/S03-SUMMARY.md`.
   - One-line overall verdict.
   - List of temp files created (for completer's optional cleanup).

## Standards

- **Target directory:** summary at `.gsd/milestones/M002/slices/S03/S03-SUMMARY.md`; smoke temp dirs at `/tmp/` (POSIX) or `C:/temp/` (Windows).
- **Reuse:**
  - `scripts/forge-tokens.js` CLI (T01) — all four scenarios invoke it.
  - `shared/forge-dispatch.md ### Token Telemetry` (T02) — event schema reference for Scenario 4.
  - `skills/forge-status/SKILL.md` (T04) — invoked for Scenario 4 rendering.
  - No new code in this task.
- **Naming:**
  - Smoke temp files: `synth-memory.md`, `synth-memory-truncated.md`, `events.jsonl.bak` — kebab-case.
  - Summary section headings match S01-SUMMARY / S02-SUMMARY style. Reference:
    - `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` — template.
    - `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md` — template.
- **Language:** Summary in English (matches S01-SUMMARY and S02-SUMMARY and M002-CONTEXT).
- **Lint command:**
  - `node -e "require('fs').readFileSync('.gsd/milestones/M002/slices/S03/S03-SUMMARY.md','utf8')"` — confirms readable.
  - `node -e "JSON.parse(require('fs').readFileSync('.gsd/forge/events.jsonl','utf8').trim().split('\n').pop())"` — confirms last events.jsonl line is valid JSON.
  - `node -c scripts/forge-tokens.js` — sanity check (should still pass from T01).
- **Pattern:** `follows: events.jsonl append` from `.gsd/CODING-STANDARDS.md § Pattern Catalog` — one-line JSON per event, never rewrite existing lines. Summary format follows `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` AND `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md` as templates.

## Context

- **No commit in this task:** `auto_commit: true` or `false` — either way, T06 does not commit. Completer handles squash-merge in `complete-slice`.
- **Scenario 4 Option A vs B:** Option A is preferred (real dispatch); Option B is the documented fallback when no real unit is in flight. Document the chosen path explicitly.
- **W-reminder: ROADMAP demo clauses cross-checked:**
  - ROADMAP demo → "every dispatched unit writes `{event:"dispatch", ...}`" → verified in Scenario 4.
  - ROADMAP demo → "/forge-status renders a Token usage block" → verified in Scenario 4.
  - ROADMAP demo → "10k-token AUTO-MEMORY dump with budget 2k produces truncated output ending at H2 boundary with `[...truncated N sections]` marker" → verified in Scenario 2.
  - ROADMAP demo → "mandatory sections (T##-PLAN, S##-CONTEXT) error explicitly if exceed budget" → verified in Scenario 3.
- **Completer finalises the summary:** T06 produces a `draft: true` version. `complete-slice` dispatch removes the draft flag and adds the final `## Verification Gate` result from the slice-level gate running on the forge-agent repo (which will be `no-stack` skip since there's no package.json).
- **Cleanup discipline:** do NOT leave fabricated events in `.gsd/forge/events.jsonl`. If Option B was used, restore the backup before writing the summary. If Option A was used, the real event IS production telemetry — do not remove.
- **Key files to read first:**
  - `scripts/forge-tokens.js` (T01 — all scenarios invoke it)
  - `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` (summary style template)
  - `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md` (summary style template — smoke test structure with 6 scenarios)
  - `.gsd/milestones/M002/slices/S03/S03-PLAN.md` criteria 1–8 (source of truth for what "passed" means)
  - `shared/forge-dispatch.md ### Token Telemetry` (Scenario 4 expected event shape)
