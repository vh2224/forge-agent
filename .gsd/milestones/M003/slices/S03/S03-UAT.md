# S03: Goal-backward verifier (3-level) — UAT Script

**Slice:** S03  **Milestone:** M003  **Written:** 2026-04-18

## Prerequisites

- Node.js available on PATH.
- Run from repo root: `C:/DEV/forge-agent` (or adjust `--cwd` accordingly).
- `scripts/forge-verifier.js` exists and `node --check scripts/forge-verifier.js` exits 0.
- `scripts/forge-must-haves.js` exists (S01 dependency).

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | `node scripts/forge-verifier.js --slice S03 --milestone M003 --cwd .` | Exits 0; writes `.gsd/milestones/M003/slices/S03/S03-VERIFICATION.md`; stdout JSON contains `artifacts` array | |
| 2 | Open `S03-VERIFICATION.md` | Contains `## Artifact Audit` table with columns `artifact | exists | substantive | wired | flags`; `scripts/forge-must-haves.js` row shows `✓ ✓ ✓` (wired pass — imported by forge-verifier.js) | |
| 3 | `node scripts/forge-verifier.js` (no args) | Exits 2; usage message on stderr; no crash | |
| 4 | Run verifier against legit smoke fixture: `node -e "const {verifyArtifact,parseMustHavesFromFile}=require('./scripts/forge-verifier'); ..."` — or invoke CLI against legit-plan.md | Artifact shows `exists: true, substantive: true`; no stub flags | |
| 5 | Inspect `smoke/RESULTS.md` stub fixture result | `stub-source.js` shows `substantive: false`; flag entry has `regex_name: return_null_function`; `line_number` and `matched_text` present | |
| 6 | `node -e "const {hasStructuredMustHaves}=require('./scripts/forge-must-haves'); const fs=require('fs'); console.log(hasStructuredMustHaves(fs.readFileSync('.gsd/milestones/M003/slices/S03/smoke/legacy-plan.md','utf8')))"` | Prints `false` | |
| 7 | Run verifier CLI against legacy-plan.md path manually (set up a temp slice pointing at it) | All artifact rows show `skipped: legacy_schema`; exit 0; no crash | |
| 8 | Check smoke non-js fixture documentation in `smoke/RESULTS.md` | Documents that non-existent `.py`/`.go` files fail at `exists: false` before Wired level; no crash | |
| 9 | `node .gsd/milestones/M003/slices/S03/perf/run-perf.js` | Exits 0; appends timestamped run block to `PERF-RESULTS.md`; prints hot-cache time ≤ 2000ms | |
| 10 | `node --check scripts/forge-verifier.js` | Exits 0 (syntax valid) | |

## Notes

- Test 7 requires constructing a minimal slice directory with a `tasks/T01/` subdirectory containing the legacy-plan.md. The smoke `legacy-plan.md` can be copied there for the test.
- Test 5 relies on the pre-run RESULTS.md created by T05. If re-validating from scratch, copy `stub-source.js` to a location reachable by a structured plan and invoke the CLI.
- The `forge-completer` sub-step 1.8 only activates after running `install.sh` / `install.ps1` to copy the updated `agents/forge-completer.md` to `~/.claude/agents/`. To test sub-step 1.8, run `complete-slice` on any slice after reinstalling.
