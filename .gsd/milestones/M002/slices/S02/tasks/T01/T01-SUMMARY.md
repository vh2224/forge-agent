---
id: T01
parent: S02
milestone: M002
provides:
  - scripts/forge-verify.js — CJS verification gate module + CLI
  - discoverCommands — 3-step discovery chain (task-plan → preference → package-json → none)
  - runVerificationGate — spawnSync dispatcher with timeout + head+tail truncation
  - formatFailureContext — 10 KB-capped failure markdown block
  - isLikelyCommand — prose vs command heuristic
requires: []
affects: [S02]
key_files: [scripts/forge-verify.js]
key_decisions:
  - "Discovery order is task-plan FIRST (not last like GSD-2) — matches Forge D003"
  - "rewriteCommandWithRtk dropped — commands pass through verbatim"
  - "events.jsonl I/O errors throw (not swallowed) per S02-RISK W3"
  - "Re-throw detection via err.code /^E[A-Z]+$/ to distinguish I/O errors from parse errors in CLI catch"
new_helpers:
  - "discoverCommands — scripts/forge-verify.js — 3-step first-non-empty-wins command discovery"
  - "runVerificationGate — scripts/forge-verify.js — spawnSync gate with timeout + truncation"
  - "formatFailureContext — scripts/forge-verify.js — markdown failure block (10 KB cap)"
  - "isLikelyCommand — scripts/forge-verify.js — prose vs command heuristic"
  - "truncateHeadTail — scripts/forge-verify.js — head+tail stderr truncation (3 KB + 7 KB)"
duration: 25min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Port of GSD-2 verification-gate.js (lines 31–252) to CommonJS with ESM removed, rtk.js dep dropped, Forge D003 discovery order, frozen allow-list, shell injection guard, and events.jsonl telemetry.

## What Happened

1. Read reference source (verification-gate.js lines 1–252) and style refs (forge-classify-error.js, forge-hook.js).
2. Created `scripts/forge-verify.js` (507 lines) with:
   - Shebang + 'use strict' + header comment documenting trust boundaries, anti-recursion sentinel, and security warning about stderr in events.jsonl
   - `truncate` ported verbatim; new `truncateHeadTail` for head+tail strategy
   - `KNOWN_COMMAND_PREFIXES` + `isLikelyCommand` + `sanitizeCommand` ported verbatim
   - `discoverCommands`: reordered (task-plan first per Forge D003), sanitize applied ONLY to task-plan path
   - `runVerificationGate`: removed rewriteCommandWithRtk, added no-stack skip, timeout detection (SIGTERM + ETIMEDOUT), head+tail stderr truncation
   - `formatFailureContext`: truncateHeadTail for per-check stderr
   - CLI: --plan, --cwd, --unit, --preference (repeatable), --timeout, --from-verify (sentinel)
   - Frontmatter size cap (1 MB) before regex
   - verify: field validates string/array only
   - events.jsonl append without try/catch; outer CLI catch re-throws I/O errors via err.code detection
3. Ran `node -c` — syntax clean.
4. Ran 5 smoke tests — all pass.

## Smoke Test Outputs

```
Smoke 1 (no package.json):
{"passed":true,"checks":[],"discoverySource":"none","skipped":"no-stack","timestamp":...}

Smoke 2 (package.json with test+build, only test runs):
{"passed":true,"checks":[{"command":"npm run test","exitCode":0,...}],"discoverySource":"package-json",...}

Smoke 3 (--plan with verify: "echo custom"):
{"passed":true,"checks":[{"command":"echo custom","exitCode":0,...}],"discoverySource":"task-plan",...}

Smoke 4 (docs-only dir):
{"passed":true,"checks":[],"discoverySource":"none","skipped":"no-stack",...}

Smoke 5 (Windows cmd /c via npm run test with node -e):
{"passed":true,"checks":[{"command":"npm run test","exitCode":0,...}],"discoverySource":"package-json",...}
```

File size: 507 lines.

## Security Flags

No violations found. All 11 blockers satisfied:
1. `PACKAGE_SCRIPT_KEYS = Object.freeze(["typecheck","lint","test"])` — line 66
2. `SHELL_INJECTION_PATTERN` applied only via `sanitizeCommand` in taskPlanVerify path — preferenceCommands bypass
3. `isLikelyCommand` called inside `sanitizeCommand`, which filters task-plan segments
4. `spawnSync(shellBin, shellArgs, {...})` — no `shell:true`
5. `process.platform === 'win32'` hardcoded branch — no user input
6. `verify:` type validation: rejects non-string shapes with parse error + exit(2)
7. 1 MB size cap before frontmatter regex — line in CLI block
8. `cwd: options.cwd` as spawnSync option only — never shell-interpolated
9. `appendFileSync` outside try/catch; CLI catch re-throws I/O errors (err.code detection)
10. No `process.env.*` echoed by the script itself
11. Header comment documents secret-leakage warning for events.jsonl

## Deviations

- Discovery order changed from GSD-2 (preference first) to Forge D003 (task-plan first). Documented in header.
- `truncateHeadTail` is a new function not present in GSD-2 — required by plan must-have for head+tail strategy.
- File is 507 lines (plan estimated 200–280) due to thorough CLI argument parsing, frontmatter array handling, and security commentary.

## Files Created/Modified

- `scripts/forge-verify.js` — created (507 lines)
- `.gsd/milestones/M002/slices/S02/tasks/T01/T01-PLAN.md` — status: DONE
