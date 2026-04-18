---
id: T01
parent: S03
milestone: M002
provides:
  - countTokens(text) — Math.ceil(chars/4) heuristic, zero deps
  - truncateAtSectionBoundary(content, budgetChars, opts) — section-boundary truncation with mandatory-throw mode
  - CLI: --file, --truncate, --mandatory, --help, stdin fallback
  - Self-test block gated on FORGE_TOKENS_SELFTEST
  - scripts/forge-tokens.js (255 lines, 10157 bytes)
requires: []
affects: [S03]
key_files: [scripts/forge-tokens.js]
key_decisions:
  - "Math.ceil(chars/4) is the sole counting method — no tiktoken, no SDK imports (M002-CONTEXT D1)"
  - "BOUNDARY_RE splits on ## , ### , ---, *** at line start; frontmatter stripped before split (pitfall 2)"
  - "mandatory:true throws Error instead of truncating; CLI exits 1 with {error:msg} to stderr"
patterns_established:
  - "CommonJS dual-mode (module.exports + require.main guard) — scripts/forge-tokens.js"
new_helpers:
  - "countTokens — scripts/forge-tokens.js — Math.ceil(chars/4) token estimator"
  - "truncateAtSectionBoundary — scripts/forge-tokens.js — section-boundary truncation with mandatory-throw mode"
duration: 15min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Port complete — `scripts/forge-tokens.js` exports `countTokens` and `truncateAtSectionBoundary`, passes all self-tests and smoke tests; ready for T02.

## What Happened

Created `scripts/forge-tokens.js` (255 lines) following the CommonJS dual-mode pattern from `forge-classify-error.js`. Key implementation notes:

- `BOUNDARY_RE` uses a lookahead `/^(?=## |### |---$|\*\*\*$)/gm` — sections retain their leading boundary line, so `parts.join('')` is lossless. Must reset `lastIndex` before each `split()` call because the regex has the `g` flag.
- Frontmatter stripping (pitfall 2): regex `^(---\n[\s\S]*?\n---\n?)` extracts the prefix before section splitting; prefix length is counted against the budget.
- Fallback branch (step 7): only path that cuts mid-content. Intentionally documented with a comment citing MEM036.
- Self-test runs silently when `FORGE_TOKENS_SELFTEST` is unset; prints "ALL PASS" to stderr when set.

## Smoke Test Outputs (verbatim)

```
$ echo "hello world" | node scripts/forge-tokens.js
{"tokens":3,"chars":12,"method":"heuristic"}

$ node scripts/forge-tokens.js --help   → exits 0, prints 11-line usage block

$ node scripts/forge-tokens.js --file CLAUDE.md
{"tokens":8323,"chars":33292,"method":"heuristic"}

$ node scripts/forge-tokens.js --file CLAUDE.md --truncate 2000
{"tokens":8323,"chars":33292,"truncated_chars":1245,"truncated_tokens":312,"method":"heuristic"}

$ node scripts/forge-tokens.js --file CLAUDE.md --truncate 500 --mandatory
stderr: {"error":"Context budget exceeded for mandatory section <cli>: 33292 chars > 500 budget"}
exit code: 1

$ node -e "process.env.FORGE_TOKENS_SELFTEST=1; require('./scripts/forge-tokens.js')"
forge-tokens.js self-test: ALL PASS
```

## Deviations

None. All must-haves satisfied. `null`/`undefined` → 0 via `if (text == null) return 0` (avoids `String(null).length = 4`).

## Files Created/Modified

- `scripts/forge-tokens.js` — created (255 lines, 10157 bytes)
- `.gsd/milestones/M002/slices/S03/tasks/T01/T01-PLAN.md` — status: RUNNING → DONE
