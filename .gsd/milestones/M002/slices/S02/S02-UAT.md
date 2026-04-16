# S02: Verification gate executable — UAT Script

**Slice:** S02  **Milestone:** M002  **Written:** 2026-04-16

---

## Prerequisites

- Node.js available on PATH (`node --version` returns v14+).
- Working directory: `C:/DEV/forge-agent` (the forge-agent repo root).
- No `package.json` exists at the repo root (docs-only stack → `no-stack` expected).

---

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | `node scripts/forge-verify.js --cwd . --unit complete-slice/S02` | JSON stdout contains `"skipped":"no-stack"`, `"passed":true`, `"discoverySource":"none"`. Exit code 0. | |
| 2 | Inspect `shared/forge-dispatch.md` for `## Verification Gate` section | Section exists and contains at least the subsections: Purpose, Invocation points, CLI shape, Discovery chain, Failure handling, Skip handling, Events.jsonl schema, Anti-recursion rule. | |
| 3 | Inspect `agents/forge-executor.md` for step 10 | Step 10 invokes `node scripts/forge-verify.js --plan {T##-PLAN} --cwd {WORKING_DIR} --unit execute-task/{T##}`. Step 11 is "Write T##-SUMMARY.md" (or equivalent commit step). Step 10 documents three branches: passed, failed (partial), skipped. | |
| 4 | Inspect `agents/forge-completer.md` for step 3 | Step 3 invokes the verification gate with `--cwd {WORKING_DIR} --unit complete-slice/{S##}` (no `--plan`). Documents three branches. Step 4 is the security scan. | |
| 5 | Inspect `forge-agent-prefs.md` for `## Verification Settings` | Section exists between `## Retry Settings` and `## Update Settings`. Contains `preference_commands: []` default. Documents discovery chain, frozen allow-list (`typecheck/lint/test`), 120 s timeout, `no-stack` skip semantics, and security note. | |
| 6 | `node --check scripts/forge-verify.js` | Exits 0 with no output (syntax OK). | |
| 7 | Create temp dir with `package.json` `{"scripts":{"typecheck":"echo ok","test":"echo ok","build":"echo FAIL"}}` and run: `node scripts/forge-verify.js --cwd <tempdir> --unit execute-task/uat01` | `passed:true`, `discoverySource:"package-json"`, only `typecheck` and `test` ran (`build` NOT in output). | |
| 8 | Create temp dir with only a `README.md` and run: `node scripts/forge-verify.js --cwd <tempdir> --unit execute-task/uat02` | `passed:true`, `skipped:"no-stack"`, `checks:[]`, exit code 0. | |
| 9 | Inspect `.gsd/forge/events.jsonl` — last few lines | Contains one or more `"event":"verify"` lines with `discovery_source`, `commands`, `passed`, `duration_ms` fields. | |
| 10 | `node scripts/forge-verify.js --help` or `node scripts/forge-verify.js --unknown-flag` | Exits with non-zero code and a usage message (does not crash silently). | |

---

## Notes

- Tests 7 and 8 require creating temporary directories. On Windows use `C:/temp/` (not `/tmp/`).
- Test 10 behavior depends on implementation; a usage-error exit code (1 or 2) is acceptable.
- The gate is intentionally non-blocking on `skipped:"no-stack"` — forge-agent itself is a docs-only repo and must always return `passed:true` from the gate.
- All smoke-test transcripts (5 scenarios + dogfood) are preserved in `S02-SUMMARY.md` as permanent evidence.
