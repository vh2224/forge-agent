# T01: Port token counter to `scripts/forge-tokens.js`

status: DONE

**Slice:** S03  **Milestone:** M002

## Goal

Create a deterministic, dependency-free Node CommonJS module + CLI at
`scripts/forge-tokens.js` that implements two functions: `countTokens(text)`
using the `Math.ceil(text.length / 4)` heuristic, and
`truncateAtSectionBoundary(content, budgetChars, opts)` that splits content
at top-level Markdown boundaries (`## `, `### `, or horizontal rules), drops
the smallest suffix needed to fit the budget, and appends a
`[...truncated N sections]` marker. In `opts.mandatory === true`, the
function throws an explicit Error instead of truncating. CLI mode accepts
`--file <path>`, falls back to stdin, and prints single-line JSON. Pure
Node built-ins, zero deps, shebang, `'use strict'`.

## Must-Haves

### Truths

- **Module exports:**
  - `countTokens(text: string) → number` — returns `Math.ceil(String(text).length / 4)`. Non-string input coerced via `String(x)`. `null`/`undefined` → 0 tokens (coerced to empty string before length).
  - `truncateAtSectionBoundary(content: string, budgetChars: number, opts?: {mandatory?: boolean, label?: string}) → string` — behaviour documented below.
  - No other exports. CLI helpers stay file-local.
- **`countTokens` heuristic is the ONLY counting method.** No SDK imports, no tiktoken, no Anthropic token helpers. The formula is literally `Math.ceil(text.length / 4)`. Document in header comment: per M002-CONTEXT D1 — revisit if error > 20%.
- **Boundary regex must be multiline-aware.** Split on lines matching `^## `, `^### `, `^---$`, or `^\*\*\*$`. Use a regex like `/^(?=(?:## |### |---$|\*\*\*$))/gm` or manual split on lines into sections. Whichever approach — sections are atomic: we never split MID-section. Document the chosen approach in a `// Boundary detection:` comment.
- **`truncateAtSectionBoundary` algorithm:**
  1. If `content.length <= budgetChars` → return `content` verbatim (no marker, no modification).
  2. If `opts.mandatory === true` → throw `new Error(\`Context budget exceeded for mandatory section ${opts.label ?? '(unknown)'}: ${content.length} chars > ${budgetChars} budget\`)`. Do NOT truncate mandatory sections.
  3. Split `content` into section parts using the boundary regex. Each part retains its leading boundary line (so rejoining is straightforward via `parts.join('')`).
  4. Compute a running total from the START; keep parts while `running + parts[i].length + MARKER_LENGTH <= budgetChars`. MARKER_LENGTH = length of `\n\n[...truncated N sections]` with a generous pad (reserve ~40 chars — computed once as constant).
  5. `droppedCount = totalParts - keptParts.length`. If `droppedCount === 0` but we already failed the length check (edge: budget smaller than first part + marker) → fall through to boundary-less fallback (step 7).
  6. Join kept parts → string → append `\n\n[...truncated ${droppedCount} sections]`. Return.
  7. **Fallback branch (zero boundaries OR first section alone > budget):** slice `content.substring(0, budgetChars - MARKER_LENGTH)` and append the marker with `N=1` (semantic: we dropped "the rest"). Document this branch in a comment — it is the only case where we truncate MID-content.
- **Marker format is EXACTLY** `[...truncated N sections]` (brackets, three dots, space, literal word "truncated", space, integer N, space, literal word "sections", closing bracket). Preceded by `\n\n` (blank line before). Match ROADMAP demo wording verbatim.
- **CLI mode (when `require.main === module`):**
  - Parse `process.argv`:
    - `--file <path>` — read `fs.readFileSync(path, 'utf8')`. If missing, fall through to stdin.
    - No `--file` → read stdin (`process.stdin.setEncoding('utf8')`; accumulate chunks).
    - `--truncate <budgetChars>` — optional; when present, apply `truncateAtSectionBoundary` and print `{tokens, chars, truncated_chars, truncated_tokens, method:"heuristic"}` instead of plain count.
    - `--mandatory` — only meaningful with `--truncate`; pass `{mandatory: true, label: '<cli>'}`. Throws propagate as exit code 1.
  - Default output: `{"tokens": N, "chars": N, "method": "heuristic"}` single-line JSON to stdout.
  - Exit codes: `0` success (including mandatory throw caught and printed as `{error: msg}` then exit 1 — NO, mandatory throw → exit 1 with `{error: msg}` to stderr); `2` on CLI argv parse error; `1` on mandatory-section overflow thrown from `truncateAtSectionBoundary`.
- **`--help` flag** prints a short usage block with the three accepted invocation forms and exits 0. Keep < 15 lines.
- **Shebang:** `#!/usr/bin/env node` on line 1.
- **`'use strict';`** on line 2 (after shebang). Convention: matches `forge-classify-error.js`.
- **No npm dependencies.** Only `fs` and `path` (if needed for file-read). CommonJS (`require`/`module.exports`). Never ESM.
- **Top-level try/catch** wraps the CLI block ONLY — not the module function bodies. Module functions throw on invalid input; CLI catches and prints `{error: msg}` to stderr.
- **Events.jsonl telemetry:** NO, this script does NOT write to `events.jsonl`. That happens in T02 (dispatch-level). Keep the script stateless and single-purpose.
- **Inline `// ASSERT:` smoke comments** at the bottom (after `module.exports`) inside a `if (process.env.FORGE_TOKENS_SELFTEST) { ... }` block so `node -e "process.env.FORGE_TOKENS_SELFTEST=1; require('./scripts/forge-tokens.js')"` re-exercises:
  - `countTokens('hello world') === 3` (11 chars / 4 = 2.75 → ceil = 3)
  - `countTokens('') === 0`
  - `countTokens('a'.repeat(40000))` returns exactly `10000`
  - `truncateAtSectionBoundary('## A\ncontent\n## B\nmore', 10)` returns string ending with `[...truncated N sections]`
  - `truncateAtSectionBoundary('short', 100)` returns `'short'` (no marker)
  - `truncateAtSectionBoundary('x'.repeat(1000), 100, {mandatory: true, label: 'test'})` throws with message matching `/Context budget exceeded for mandatory section test/`

### Artifacts

- `scripts/forge-tokens.js` — new file, approximately 150–230 lines.
  - Exports: `countTokens`, `truncateAtSectionBoundary`.
  - Shebang, `'use strict'`, CommonJS.
  - CLI block gated on `require.main === module`.
  - Self-test block gated on `process.env.FORGE_TOKENS_SELFTEST`.

### Key Links

- `scripts/forge-tokens.js` → consumed by `shared/forge-dispatch.md ### Token Telemetry` (T02) and `skills/forge-status/SKILL.md` (T04).
- Reference style: `scripts/forge-classify-error.js` (CommonJS, shebang, CLI guard, stdin fallback). Do NOT copy error-classifier logic — just mirror the file structure.
- Reference CLI arg parsing pattern: `scripts/merge-settings.js` lines 15–17 (`process.argv.includes('--flag')` + indexOf+1 for value).

## Steps

1. Read `scripts/forge-classify-error.js` end-to-end (~200 lines) to internalise the dual-mode module/CLI layout, the stdin reader idiom, the `require.main === module` guard, and the top-level try/catch scope. Do NOT copy its regex logic.
2. Read `.gsd/CODING-STANDARDS.md` sections: **Directory Conventions**, **Naming Conventions**, **Error Patterns**, **Pattern Catalog → Node CLI + module dual-mode**. Cross-check every must-have above.
3. Check for an existing reference in GSD-2:
   - `ls C:/Users/VINICIUS/.gsd/agent/extensions/gsd/ 2>/dev/null | grep -i token` — if a token-counter file exists, use it as a reference; otherwise the formula is simple enough to port directly from M002-CONTEXT D1.
4. Create `scripts/forge-tokens.js`:
   - Line 1: `#!/usr/bin/env node`
   - Line 2: `/** @fileoverview forge-tokens.js — Math.ceil(chars/4) token counter + boundary-aware truncator for Forge context budgets. */`
   - Line 3: `'use strict';`
   - Line 4–12: Header block comment citing: source heuristic (M002-CONTEXT D1), zero deps, CommonJS, dual-mode, marker format `[...truncated N sections]`, mandatory-mode throw semantics.
   - Constants block: `const MARKER_LENGTH = 40;` (reserve for `\n\n[...truncated 999 sections]` worst case), `const BOUNDARY_RE = /^(?=## |### |---$|\*\*\*$)/m;` or equivalent.
   - `function countTokens(text) { ... }` — 2 lines.
   - `function truncateAtSectionBoundary(content, budgetChars, opts = {}) { ... }` — ~40 lines with the algorithm above, including the fallback branch.
   - `module.exports = { countTokens, truncateAtSectionBoundary };`
   - CLI block: parse argv, read stdin or file, run the right function, print JSON, exit with correct code.
   - Self-test block gated on `process.env.FORGE_TOKENS_SELFTEST`.
5. **Inline smoke tests from Bash (before writing SUMMARY):**
   - `echo "hello world" | node scripts/forge-tokens.js` — expect `{"tokens":4,"chars":12,"method":"heuristic"}` (Note: `echo` appends `\n`, so 12 chars → 3 tokens; check ceil exactly).
     (Correction during implementation: `echo "hello world"` produces 12 chars including the newline; `Math.ceil(12/4) = 3`. Expected tokens = 3, chars = 12. Confirm in implementation.)
   - `node scripts/forge-tokens.js --file CLAUDE.md` — expect large tokens number; verify it equals `wc -c CLAUDE.md / 4` rounded up.
   - `node scripts/forge-tokens.js --help` — exits 0 with usage block.
   - `node -e "process.env.FORGE_TOKENS_SELFTEST=1; require('./scripts/forge-tokens.js')"` — all ASSERT lines pass silently.
   - `node scripts/forge-tokens.js --file CLAUDE.md --truncate 2000` — expect `truncated_chars < 8000` and output (piped to `wc -c`) under ~8100 chars.
   - Mandatory-mode negative test: `node scripts/forge-tokens.js --file CLAUDE.md --truncate 500 --mandatory` — expect exit code 1 and stderr containing `Context budget exceeded for mandatory section`.
6. Node syntax check: `node -c scripts/forge-tokens.js` must succeed (project convention per CODING-STANDARDS.md § Lint).
7. Write `T01-SUMMARY.md` with: file size (`wc -l`, `wc -c`), 6 smoke outputs verbatim, and a one-line verdict (`ready for T02`).

## Standards

- **Target directory:** `scripts/` — matches convention (MEM042: Node CLIs live here; no `package.json`; deterministic JSON output). Siblings: `forge-hook.js`, `forge-statusline.js`, `forge-classify-error.js`, `forge-verify.js`, `merge-settings.js`.
- **Reuse:** No helpers imported from other forge-*.js files. This module is standalone. Style reference only: `forge-classify-error.js` for shebang + CommonJS + CLI guard pattern. `merge-settings.js` lines 15–17 for argv-flag idiom.
- **Naming:** kebab-case filename `forge-tokens.js` per `forge-` prefix rule. Exported functions camelCase: `countTokens`, `truncateAtSectionBoundary`. Constants UPPER_SNAKE: `MARKER_LENGTH`, `BOUNDARY_RE` (this is a regex, acceptable per `PERMANENT_RE` precedent in classifier).
- **Module system:** CommonJS only (`require`, `module.exports`). Never ESM per `.gsd/CODING-STANDARDS.md § Import Organization`. No `package.json` in repo — no dependencies permitted.
- **Error style:** Module functions THROW on invalid input (mandatory-mode overflow, invalid budget values). CLI wraps top-level in try/catch, prints `{error: msg}` to stderr, exits 1 (mandatory-throw) or 2 (argv parse error). This differs from error-classifier.js's "errors are data" principle (MEM036): classification outcomes = data; mandatory-budget violations = exceptions. Document in the header.
- **Lint command:** `node -c scripts/forge-tokens.js` (syntax check only — repo has no lint tooling per `.gsd/CODING-STANDARDS.md § Lint & Format Commands`).
- **Pattern:** `follows: Node CLI + module dual-mode` from `.gsd/CODING-STANDARDS.md § Pattern Catalog` — CommonJS header + shebang, `module.exports` block, `require.main === module` CLI guard, top-level try/catch only in the CLI entrypoint.

## Context

- **M002-CONTEXT decisions respected:** Math.ceil(chars/4) is the only method (D1); zero new deps (D6 Hybrid C); boundary-aware truncation on optional sections, explicit throw on mandatory (D5).
- **S01 artefact referenced (not consumed):** `scripts/forge-classify-error.js` is a style template. This task does NOT invoke the classifier.
- **MEM002 respected:** this script writes to stdout, not to workers. No orchestrator-context coupling.
- **MEM011 respected:** this task ships the control-flow utility; templates stay data-flow. T02 wires it in.
- **MEM036 nuance:** classification = data; mandatory-budget violations = exceptions. Document the divergence so future maintainers don't "fix" the throw by swallowing it.
- **Key files to read first:**
  - `scripts/forge-classify-error.js` (style + CLI guard pattern)
  - `scripts/forge-hook.js` lines 19–24 (stdin reader idiom)
  - `scripts/merge-settings.js` lines 15–17 (argv flag parser idiom)
  - `.gsd/CODING-STANDARDS.md § Pattern Catalog → Node CLI + module dual-mode`
  - `.gsd/milestones/M002/M002-CONTEXT.md` (D1, D5, D6)
