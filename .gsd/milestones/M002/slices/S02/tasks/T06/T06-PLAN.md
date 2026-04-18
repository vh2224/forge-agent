# T06: Run 5 smoke tests + dogfood + write S02-SUMMARY evidence

**Slice:** S02  **Milestone:** M002

## Goal

Execute the five mandatory smoke scenarios from `S02-RISK.md` executor notes
plus a dogfood run on the forge-agent repo itself. Capture stdout, `events.jsonl`
excerpts, and timing data. Produce an evidence-heavy draft of `S02-SUMMARY.md`
that the completer will finalize in `complete-slice`.

## Must-Haves

### Truths

- All five smoke scenarios executed and captured:
  1. **Node repo with `package.json` scripts** — create `/tmp/forge-verify-smoke-01/package.json` containing `{"name":"smoke01","scripts":{"typecheck":"echo typecheck-ok","test":"echo test-ok","build":"echo should-not-run"}}`. Run `node scripts/forge-verify.js --cwd /tmp/forge-verify-smoke-01 --unit execute-task/smoke01`. Expected: `discoverySource:"package-json"`, `commands: ["npm run typecheck", "npm run test"]` (build NOT invoked), `passed: true`. Capture full JSON stdout AND the `events.jsonl` line written.
  2. **Task with explicit `verify:` frontmatter** — create `/tmp/forge-verify-smoke-02/T99-PLAN.md` with frontmatter containing `verify: "echo custom-only"`. Run `node scripts/forge-verify.js --plan /tmp/forge-verify-smoke-02/T99-PLAN.md --cwd /tmp/forge-verify-smoke-02 --unit execute-task/T99`. Expected: `discoverySource: "task-plan"`, `commands: ["echo custom-only"]`, `passed: true`. Confirm auto-detect was skipped (package.json was ALSO present in the temp dir with `{"scripts":{"test":"echo WRONG"}}` — the `--plan` should shadow it).
  3. **Docs-only repo** — create `/tmp/forge-verify-smoke-03/README.md` as the only file. Run `node scripts/forge-verify.js --cwd /tmp/forge-verify-smoke-03 --unit execute-task/smoke03`. Expected: `{passed: true, skipped: "no-stack", discoverySource: "none"}`, exit code 0. Confirm no `checks` entries, no commands invoked.
  4. **20 KB stderr truncation** — use `preference_commands` override to run a command that emits exactly 20 000 bytes of stderr. Example: `node -e "process.stderr.write('x'.repeat(20000)); process.exit(1)"`. Run via `--preference 'node -e "..."'`. Expected: `check.stderr` contains first 3 KB + `[...N bytes elided...]` marker + last 7 KB. Overall failure-context output from `formatFailureContext` stays under 10 000 chars. Verify the marker is present with exact format `[...N bytes elided...]` where N is the elided byte count.
  5. **130 s timeout** — use `preference_commands` override to run `node -e "setTimeout(()=>{}, 130000)"`. Run `node scripts/forge-verify.js --cwd /tmp --preference 'node -e "setTimeout(()=>{}, 130000)"' --unit execute-task/smoke05`. Expected: gate reports the check with `exitCode: 124`, `skipped: "timeout"`, `check.stderr` contains `[timeout after 120000ms]`. Total elapsed ≥ 119 s and ≤ 125 s. `passed: false`. Use `time` (Unix) or PowerShell's `Measure-Command` to capture elapsed time.
- **Dogfood run (scenario 6)** — on the forge-agent repo itself (no `package.json` as of 2026-04-16): `cd C:/DEV/forge-agent && node scripts/forge-verify.js --cwd . --unit execute-task/dogfood`. Expected: `{passed: true, skipped: "no-stack", discoverySource: "none"}`. If this fails, something is wrong with the no-stack skip branch.
- **`events.jsonl` excerpts** — for each of the 6 scenarios, read the last-appended line from the relevant `events.jsonl` and include it in the summary. Each line must be valid JSON parseable by `node -e "JSON.parse(require('fs').readFileSync('.gsd/forge/events.jsonl','utf8').trim().split('\n').pop())"`.
- **Draft `S02-SUMMARY.md`** written at `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md` with:
  - YAML frontmatter: `id: S02`, `milestone: M002`, `status: ready-for-completer`, `draft: true` (completer removes `draft: true` and fills final status on `complete-slice`).
  - `## Goal` (one paragraph copied/paraphrased from S02-PLAN).
  - `## Outcome` (one paragraph: 6 tasks done, gate is operational end-to-end).
  - `## Artefacts produced` (table of files changed, source T##).
  - `## Smoke tests` (section with 6 subsections, one per scenario):
    - **Scenario 1: Node repo with package.json scripts**: command run, stdout JSON (single line, pretty-printed as a fenced ```json block), events.jsonl line, verdict (pass/fail + why).
    - ... (same shape for 2 through 6)
  - `## Risk mitigations verified` (table mapping each S02-RISK blocker/warning to which scenario exercised it).
  - `## Known limitations` (brief — Python/Go/Rust auto-detect deferred, milestone-level verify deferred, runtime error capture deferred).
  - One-line verdict: `All 6 scenarios passed; gate is production-ready.` or specific failure mode if any scenario failed.
- The events.jsonl file itself (`.gsd/forge/events.jsonl`) will have 6 new lines appended during this task. This is expected telemetry — do NOT clean it up.
- NO commit is made by this task. The completer's `complete-slice` handles squash-merge (step 6 after T04's reshuffle).

### Artifacts

- `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md` — new file, ~150–250 lines (heavy with fenced blocks for stdout captures).
- `.gsd/forge/events.jsonl` — 6 new appended lines (side effect of running verify during smoke tests).
- Temporary smoke directories `/tmp/forge-verify-smoke-0{1-3}` — created during this task; may be cleaned up after summary is written or left in place. Document location in summary.

### Key Links

- `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md` → references `scripts/forge-verify.js` (T01), `agents/forge-executor.md` (T03), `agents/forge-completer.md` (T04), `forge-agent-prefs.md ## Verification Settings` (T05).

## Steps

1. Confirm prerequisites: `scripts/forge-verify.js` exists (T01 done), `shared/forge-dispatch.md ## Verification Gate` exists (T02 done), `agents/forge-executor.md` step 10 added (T03 done), `agents/forge-completer.md` step 3 added (T04 done), `forge-agent-prefs.md ## Verification Settings` exists (T05 done). If any missing → return `blocked` with `blocker_class: external_dependency`.
2. Create `/tmp/forge-verify-smoke-01/` with `package.json` as specified. On Windows, use `C:/temp/forge-verify-smoke-01/` (and adjust remaining `/tmp` paths to `C:/temp/` throughout). Record the path convention chosen in the summary.
3. Run scenario 1. Capture stdout via `node scripts/forge-verify.js ... > /tmp/smoke01.out.json 2>&1; cat /tmp/smoke01.out.json`. Parse JSON to confirm shape. Read last line of `.gsd/forge/events.jsonl` (the events.jsonl the verify writes to is in the `--cwd` target's `.gsd/forge/events.jsonl`, so for smoke tests that's `/tmp/forge-verify-smoke-01/.gsd/forge/events.jsonl`). Capture both.
4. Create `/tmp/forge-verify-smoke-02/T99-PLAN.md` + `/tmp/forge-verify-smoke-02/package.json`. Run scenario 2. Confirm `--plan` shadows auto-detect (the `echo WRONG` command must NOT appear in the output). Capture stdout + events.jsonl.
5. Create `/tmp/forge-verify-smoke-03/README.md`. Run scenario 3. Capture stdout + events.jsonl. Confirm `skipped: "no-stack"`.
6. Run scenario 4 (20 KB stderr). Use `--preference 'node -e "process.stderr.write(\"x\".repeat(20000)); process.exit(1)"'`. Capture stdout — inspect `check.stderr` for head+tail marker. Count bytes in the captured stderr; should be ≤ 10 KB. Compute the N in `[...N bytes elided...]`: should equal `20000 - 3072 - 7168 = 9760` (approximately — exact count depends on marker string length accounting).
7. Run scenario 5 (130 s timeout). Use `--preference 'node -e "setTimeout(()=>{}, 130000)"'`. Time the total run — must be between 119 and 125 seconds. Confirm exit code 124 on the check, `skipped: "timeout"` flag on that check, `passed: false` overall.
8. Run scenario 6 (dogfood on forge-agent itself). `cd C:/DEV/forge-agent && node scripts/forge-verify.js --cwd . --unit execute-task/dogfood`. Confirm `no-stack` skip.
9. Write `S02-SUMMARY.md` with all captured data. Structure:
   - Frontmatter (draft: true).
   - `## Goal` (one paragraph).
   - `## Outcome` (one paragraph + bullet list of tasks T01–T06).
   - `## Artefacts produced` table.
   - `## Smoke tests` with six subsections.
   - `## Risk mitigations verified` table.
   - `## Known limitations` bullet list.
   - One-line verdict.
10. Append the T06 events.jsonl entry (forge-executor's own event for this task) to `{WORKING_DIR}/.gsd/forge/events.jsonl` per the standard executor flow. This is the orchestrator-level event, distinct from the 6 verify events written during scenarios.
11. Write `T06-SUMMARY.md` with a pointer to `S02-SUMMARY.md` and a one-line overall verdict.

## Standards

- **Target directory:** summary at `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md`; smoke temp dirs at `/tmp/` (POSIX) or `C:/temp/` (Windows).
- **Reuse:** `scripts/forge-verify.js` CLI from T01; no new code in this task.
- **Naming:** smoke dirs `forge-verify-smoke-0{1..5}`. Summary section headings match S01-SUMMARY style (see `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` for reference).
- **Language:** summary in English (matching `M002-CONTEXT.md` and `S01-SUMMARY.md`).
- **Lint command:** `node -e "require('fs').readFileSync('.gsd/milestones/M002/slices/S02/S02-SUMMARY.md','utf8')"` to confirm readable. For events.jsonl lines, `node -e "JSON.parse(line)"` to confirm each line is valid JSON.
- **Pattern:** `follows: events.jsonl append` from `CODING-STANDARDS.md ## Pattern Catalog` — one-line JSON per event, never rewrite existing lines. Summary format follows `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` as template.

## Context

- **W6 reminder:** scenarios 1–5 run against temp dirs — do NOT use the forge-agent repo's `events.jsonl` for smokes (scenario 6 is the sole exception: it runs with `--cwd .` which means forge-agent's own `events.jsonl` gets a `no-stack` entry, which is correct and expected).
- **W2 mitigation test (scenario 4):** the head+tail marker format matters. If the marker is `[...truncated]` (GSD-2's simple form), the summary should note the divergence. Forge's T01 spec requires `[...N bytes elided...]` — confirm via grep of the captured stderr.
- **B3 test (scenarios 1–6):** all scenarios run on Windows per the project environment (`win32`). The `process.platform === 'win32'` branch in `forge-verify.js` is exercised. If any scenario fails due to `cmd` vs `sh` dispatch, report in Known limitations.
- **Completer will finalize the summary:** T06 produces a `draft: true` version. The `complete-slice` dispatch removes the draft flag, adds the final `## Verification Gate` result (from the slice-level gate running on the forge-agent repo), and any post-T06 info.
- **No commit in this task:** `auto_commit: true` or `false` — either way, T06 does not commit. The completer handles the squash-merge in `complete-slice` (step 6 after T04's reshuffle).
- **Key files to read first:**
  - `scripts/forge-verify.js` (T01 — ensure the flags used in smokes match)
  - `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` (style template for summaries)
  - `.gsd/milestones/M002/slices/S02/S02-PLAN.md` criterion 11 (smoke list)
  - `.gsd/milestones/M002/slices/S02/S02-RISK.md` "Executor notes" (smoke list + nuances)
