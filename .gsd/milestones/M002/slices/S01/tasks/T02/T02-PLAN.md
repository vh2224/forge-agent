# T02: Port error classifier to `scripts/forge-classify-error.js`

status: RUNNING

**Slice:** S01  **Milestone:** M002

## Goal
Create a deterministic, dependency-free Node module + CLI at `scripts/forge-classify-error.js` that ports the six classification regexes from GSD-2's `error-classifier.js` into a shape the Forge orchestrator can shell out to via `node scripts/forge-classify-error.js --msg "..."` and consume JSON output.

## Must-Haves

### Truths
- Module exports `classifyError(errorMsg, retryAfterMs?)` returning `{kind, retry, backoffMs}`:
  - `kind` ∈ `"permanent" | "rate-limit" | "network" | "stream" | "server" | "connection" | "unknown"`.
  - `retry` is a boolean — `true` for any transient kind (`rate-limit`, `network`, `stream`, `server`, `connection`), `false` otherwise.
  - `backoffMs` is a number when `retry === true`; omitted (or `undefined`) when `retry === false`.
- Module also exports `isTransient(result)` helper (boolean) for readability at call sites.
- Classification order EXACTLY matches GSD-2: permanent (unless rate-limited) → rate-limit → network → stream → server → connection → unknown.
- CLI mode: reads input from either `--msg "<text>"` flag or stdin (whichever is provided). Accepts optional `--retry-after-ms <n>`. Writes a single-line JSON object to stdout. Never writes to stderr except on actual programming errors (not classification outcomes). Exit code is always 0 when classification succeeded — the kind carries the signal.
- Zero npm dependencies. Pure Node `process`, `fs` (not needed here), built-in `console.log`. Top of file is `#!/usr/bin/env node`.
- Exponential-backoff default table baked in when `retryAfterMs` is not supplied:
  - `rate-limit` → attempt to parse `/reset in (\d+)s/i`, else 60_000 ms.
  - `network` → 3_000 ms.
  - `stream` → 15_000 ms.
  - `server` → 30_000 ms.
  - `connection` → 15_000 ms.
  These mirror GSD-2 defaults. The caller (T03 retry handler) may override with its own exponential schedule (2s/4s/8s per attempt number).

### Artifacts
- `scripts/forge-classify-error.js` — new file, ~90–130 lines, exports `classifyError`, `isTransient`, plus CLI entrypoint. Shebang present.

### Key Links
- `scripts/forge-classify-error.js` is consumed by `shared/forge-dispatch.md` (T03) via `node scripts/forge-classify-error.js --msg "..."`.
- Reference port source: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js` lines 1–108.

## Steps
1. Read the GSD-2 reference at `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js` in full. Note the six regex constants, the order of checks, and the return shape.
2. Verify T01's `S01-SMOKE.md` Verdict is `PROCEED` or `PROCEED WITH CAVEAT`. If `ABORT`, stop immediately and return `blocked` — do not write T02 output.
3. Create `scripts/forge-classify-error.js` with:
   - Shebang + short header comment stating: source of regexes (GSD-2), pure JS, CommonJS (to match existing `scripts/forge-hook.js` and `scripts/forge-statusline.js` which use `require`).
   - Six regex constants copied verbatim from the reference.
   - `function classifyError(errorMsg, retryAfterMs)` implementing the classification order above.
   - `function isTransient(result)` returning `true` for the five transient kinds.
   - `module.exports = { classifyError, isTransient }`.
   - CLI guard: `if (require.main === module) { ... }` that parses `--msg` and `--retry-after-ms` from `process.argv`, falls back to stdin if no `--msg`, and prints `JSON.stringify(classifyError(msg, ms))`.
4. If T01 reported `PROCEED WITH CAVEAT` with specific opaque messages, add a seventh regex `UNKNOWN_BUT_TRANSIENT_RE` covering those patterns and classify matches as `"unknown"` but with `retry: true, backoffMs: 15_000`. Document the source of the pattern in a comment.
5. Manual smoke from Bash (at least):
   - `echo '500 internal server error' | node scripts/forge-classify-error.js` → expect `{"kind":"server","retry":true,"backoffMs":30000}`
   - `node scripts/forge-classify-error.js --msg "429 rate limit reset in 45s"` → expect `{"kind":"rate-limit","retry":true,"backoffMs":45000}`
   - `node scripts/forge-classify-error.js --msg "ECONNRESET"` → expect `{"kind":"network","retry":true,"backoffMs":3000}`
   - `node scripts/forge-classify-error.js --msg "401 unauthorized"` → expect `{"kind":"permanent","retry":false}`
6. Write `T02-SUMMARY.md` with commands run, expected vs actual output, and a one-line verdict.

## Standards
- **Target directory:** `scripts/` — matches existing convention (`forge-hook.js`, `forge-statusline.js`, `merge-settings.js`).
- **Reuse:** regex constants from GSD-2 reference. Do NOT rewrite them by hand — copy-paste verbatim to preserve behaviour.
- **Naming:** kebab-case filename `forge-classify-error.js`, prefix `forge-` per CLAUDE.md convention. Exported functions use `camelCase`.
- **Module system:** CommonJS (`require` / `module.exports`) to match existing scripts — do NOT use ESM. The reference uses `export`; convert on port.
- **Lint command:** `node -c scripts/forge-classify-error.js` (syntax check only — project has no lint configured; confirmed via absence of `.gsd/CODING-STANDARDS.md`).
- **Pattern:** no matching entry in Pattern Catalog (project lacks `.gsd/CODING-STANDARDS.md`).

## Context
- M002-CONTEXT locked: no npm deps, heuristic only where needed. This task aligns (no deps at all for classification).
- M002-CONTEXT locked: retryable classes are `rate_limit`, `network`, `server`, `stream`; non-retryable are `permanent`, `model_refusal`, `context_overflow`, `tooling_failure`. GSD-2's `"connection"` kind is also transient — retain it and treat as transient in `isTransient()`.
- Reference ESM → CJS conversion: replace `export function` with `function` + bottom `module.exports = {...}`. Replace `export function createRetryState/resetRetryState` — skip these, they are not needed in Forge (the retry state lives in the markdown handler per T03, not in Node).
- MEM011 reminder: orchestrator passes paths, workers read their own context. This classifier CLI is consumed by markdown instructions in T03; do not inline its output in the orchestrator.
- Key files to read first:
  - `.gsd/milestones/M002/slices/S01/S01-SMOKE.md` (T01 output — gate check)
  - `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js`
  - `scripts/forge-hook.js` (for CommonJS style reference)
