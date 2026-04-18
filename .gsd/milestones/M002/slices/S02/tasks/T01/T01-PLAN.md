# T01: Port verification gate to `scripts/forge-verify.js`

status: DONE

**Slice:** S02  **Milestone:** M002

## Goal

Create a deterministic, dependency-free Node CommonJS module + CLI at
`scripts/forge-verify.js` that ports GSD-2's `verification-gate.js` lines 31–252
(strip runtime-error and dependency-audit code — out of scope). Must implement
the 3-step discovery chain, a frozen `[typecheck, lint, test]` package.json
allow-list, cross-platform `spawnSync` dispatch, 120 s per-command timeout with
synthetic exit 124, head+tail stderr truncation (3 KB + 7 KB per command, 10 KB
per check, 10 KB total failure-context), and a `skipped:"no-stack"` graceful-skip
for docs-only repos (4-condition AND-gate).

## Must-Haves

### Truths

- Module exports:
  - `discoverCommands({preferenceCommands, taskPlanVerify, cwd}) → {commands: string[], source: "task-plan"|"preference"|"package-json"|"none"}`
  - `runVerificationGate({cwd, preferenceCommands, taskPlanVerify, commandTimeoutMs}) → {passed: boolean, checks: Check[], discoverySource: string, skipped?: "no-stack"|"timeout", timestamp: number}`
  - `formatFailureContext(result) → string` — empty string if all passed; otherwise the `## Verification Failures` markdown block with per-check headings + truncated stderr, total cap 10 000 chars.
  - `isLikelyCommand(cmd) → boolean` — ported from GSD-2 lines 151–176 (prose vs command heuristic).
- **Discovery chain ordering (first non-empty wins):**
  1. `taskPlanVerify` (string — split on `&&`; each part trimmed and sanitized via `isLikelyCommand` + shell-injection regex). Returns `source: "task-plan"`.
  2. `preferenceCommands` (array of strings). Returns `source: "preference"`.
  3. `package.json` present at `cwd` → iterate frozen allow-list `["typecheck", "lint", "test"]`; for each key that exists in `pkg.scripts`, push `npm run <key>`. Returns `source: "package-json"`.
  4. None of the above AND `package.json` absent AND `pyproject.toml` absent AND `go.mod` absent → returns `{commands: [], source: "none"}`.
- **Skip semantics:** When `discoverCommands` returns `commands.length === 0` AND `source === "none"`, `runVerificationGate` returns `{passed: true, checks: [], discoverySource: "none", skipped: "no-stack", timestamp}`. This is the docs-only repo graceful-skip.
- **Allow-list is frozen and hardcoded** as `const PACKAGE_SCRIPT_KEYS = ["typecheck", "lint", "test"];`. NEVER reads arbitrary script keys. Never runs `start`, `dev`, `build`, `prepare`, `postinstall`, `watch`, `serve`, or custom keys.
- **Cross-platform spawn:** `process.platform === 'win32'` → `spawnSync("cmd", ["/c", cmd], {...})`; else → `spawnSync("sh", ["-c", cmd], {...})`. Ported verbatim from GSD-2 lines 217–218. Use `shell: false` (explicit shell binary + args avoids Node DEP0190 warning).
- **Timeout:** Each `spawnSync` call passes `timeout: 120_000` (2 min). On timeout (`result.signal === "SIGTERM"` or `result.status === null` with elapsed ≥ 120 s), push a check with `exitCode: 124`, `stderr: "[timeout after 120s]"`, and mark the overall result with `skipped: "timeout"` for that check (do NOT mark whole gate as skipped — individual timeout is a soft skip that still fails `passed`).
- **Head+tail stderr truncation:** `truncate(value, maxBytes)` ported from GSD-2 lines 13–21. Extension for failure context: if combined stderr > 10 KB, output first 3 KB + `\n[...N bytes elided...]\n` + last 7 KB. Applied per check AND for total failure-context (overall 10 000 char cap).
- **CLI mode:** when `require.main === module`, parse `process.argv`:
  - `--plan <path>` — read YAML frontmatter, extract `verify:` field (accept string OR array; array joined on ` && ` before passing).
  - `--cwd <dir>` — defaults to `process.cwd()`.
  - `--unit <name>` — e.g. `execute-task/T01` — used only for events.jsonl logging.
  - `--preference <cmd>` (repeatable) — override prefs inline (used mainly for testing).
  - `--timeout <ms>` — override default 120 000.
  - Prints single-line JSON `{passed, checks, discoverySource, skipped?, timestamp}` to stdout.
  - Exit code: `0` if `passed === true` (including skips); `1` if any check failed; `2` on CLI-parse error only.
- **Events.jsonl append:** in CLI mode only, after running the gate, append one JSON line to `{cwd}/.gsd/forge/events.jsonl` with shape
  `{ts, event:"verify", unit, discovery_source, commands:[...], passed, skipped?, duration_ms}`. `mkdir -p .gsd/forge/` first.
  **Critical:** I/O errors writing this line MUST `throw` (per S02-RISK.md executor note — telemetry is not silent-fail). Do not wrap in try/catch.
- **Sanitize commands from untrusted sources** (`taskPlanVerify`): reject commands matching `/[;|`]|\$\(/` (shell-injection) AND failing `isLikelyCommand`. `preferenceCommands` are trusted (user-authored prefs) — no sanitization.
- **`--from-verify` sentinel:** accept but do nothing with it (reserved for orchestrator anti-recursion per S02-RISK W3). Document in header comment.
- **No npm dependencies.** Pure Node built-ins (`fs`, `path`, `child_process`). CommonJS (`require`, `module.exports`).
- **Shebang:** `#!/usr/bin/env node` on line 1.

### Artifacts

- `scripts/forge-verify.js` — new file, ~200–280 lines. Exports `discoverCommands`, `runVerificationGate`, `formatFailureContext`, `isLikelyCommand`. Shebang + CommonJS.

### Key Links

- `scripts/forge-verify.js` is consumed by `shared/forge-dispatch.md` (T02) and invoked by `agents/forge-executor.md` (T03) and `agents/forge-completer.md` (T04).
- Reference port source: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/verification-gate.js` lines 1–252 (strip 253+).
- CommonJS style reference: `scripts/forge-hook.js`, `scripts/forge-classify-error.js`.

## Steps

1. Read `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/verification-gate.js` lines 1–252. Note: the GSD-2 source uses ESM (`import`/`export`) and an `rtk.js` dependency (`rewriteCommandWithRtk`) — BOTH must be dropped for Forge. Commands pass through unchanged.
2. Read `scripts/forge-hook.js` and `scripts/forge-classify-error.js` to confirm CommonJS conventions (shebang, `'use strict'`, top-level try/catch in CLI mode, `require.main === module` guard).
3. Read `.gsd/milestones/M002/slices/S02/S02-RISK.md` — every Blocker and Warning in that file maps to a must-have above. Cross-check.
4. Create `scripts/forge-verify.js`:
   - Shebang + `'use strict'` + header comment stating: source (GSD-2 verification-gate.js lines 31–252), pure CommonJS, zero deps, frozen allow-list, 4-condition AND-gate for skip, anti-recursion sentinel `--from-verify`.
   - Constants: `MAX_OUTPUT_BYTES = 10 * 1024`, `MAX_STDERR_PER_CHECK = 2000` (GSD-2 default; keep) but ALSO new `HEAD_BYTES = 3 * 1024`, `TAIL_BYTES = 7 * 1024` for the head+tail strategy, `MAX_FAILURE_CONTEXT_CHARS = 10000`, `DEFAULT_COMMAND_TIMEOUT_MS = 120_000`, `PACKAGE_SCRIPT_KEYS = Object.freeze(["typecheck","lint","test"])`, `SHELL_INJECTION_PATTERN = /[;|`]|\$\(/`.
   - Port `truncate(value, maxBytes)` verbatim. ADD a new `truncateHeadTail(value, headBytes, tailBytes)` for the head+tail strategy — used in `formatFailureContext` per-check stderr AND in the check.stderr field when > 10 KB.
   - Port `KNOWN_COMMAND_PREFIXES` and `isLikelyCommand` verbatim from lines 119–176.
   - Port `sanitizeCommand` verbatim from lines 181–187.
   - Port `discoverCommands` from lines 31–76 with these **changes**:
     - Step 4 (nothing found): before returning `{commands: [], source: "none"}`, check `existsSync(join(cwd, "pyproject.toml"))` and `existsSync(join(cwd, "go.mod"))`. If EITHER exists (but package.json was absent or had no matching scripts), still return `source: "none"` for now (Python/Go support is out of scope per S02-PLAN) BUT the orchestrator can distinguish via `discoverySource` — document in header comment.
     - Confirm the 4-condition AND-gate with the calling layer: docs-only repos have NO package.json, NO pyproject.toml, NO go.mod AND empty `preferenceCommands` AND absent `taskPlanVerify`. The `source === "none"` result is the docs-only signal.
   - Port `runVerificationGate` from lines 196–252 with these **changes**:
     - Drop `rewriteCommandWithRtk(command)` — pass command verbatim.
     - After the `if (commands.length === 0)` block, add `return {..., skipped: "no-stack"}` to match the M002-CONTEXT locked decision.
     - On per-command timeout (check `result.signal === "SIGTERM"` — Node sends SIGTERM when timeout fires), synthesize `exitCode = 124`, `stderr = "[timeout after " + timeoutMs + "ms]"`, mark `check.skipped = "timeout"`. The overall `passed` computes as `checks.every(c => c.exitCode === 0 || c.skipped === "timeout")` — **NO**, actually timeout is a failure (timeout means command did not complete successfully). Compute `passed = checks.every(c => c.exitCode === 0)`. The `skipped: "timeout"` is informational only on the individual check.
     - Add `overallSkipped` detection: if `source === "none"`, return `{passed: true, skipped: "no-stack", ...}` at the top-level. Otherwise omit top-level `skipped`.
     - Apply `truncateHeadTail` to `check.stderr` when length > 10 KB (instead of plain `truncate`). Short stderrs pass through untouched.
   - Port `formatFailureContext` from lines 91–111. Replace the `stderr.slice(0, MAX_STDERR_PER_CHECK)` with `truncateHeadTail(stderr, 600, 1400)` (scale to 2 000 char cap for failure-context blocks). Keep the 10 000 total cap.
   - Add CLI block under `if (require.main === module)`:
     ```
     - parse argv for --plan, --cwd, --unit, --preference (repeatable), --timeout, --from-verify
     - if --plan: readFileSync, extract YAML frontmatter (match /^---\n([\s\S]*?)\n---/), then find `verify:` line. If string, use as-is. If array (starts with `[` or subsequent indented `-`), parse simply and join on ` && `.
     - call runVerificationGate
     - startTime = Date.now(); duration = Date.now() - startTime after gate
     - append events.jsonl line (mkdir first). Do NOT try/catch the append.
     - console.log(JSON.stringify(result))
     - process.exit(result.passed ? 0 : 1)
     ```
   - Top-level try/catch AROUND THE CLI INVOCATION ONLY (not the module exports). On parse error → print `{error: msg}` to stderr, `process.exit(2)`. On I/O error from events.jsonl append → RE-THROW (per W3 — silent fail is forbidden here).
   - `module.exports = { discoverCommands, runVerificationGate, formatFailureContext, isLikelyCommand };`

5. **Inline smoke tests from Bash** (record outputs to paste into T06 later):
   - `node scripts/forge-verify.js --cwd .` — forge-agent has no package.json → expect `{"passed":true,"checks":[],"discoverySource":"none","skipped":"no-stack", ...}`.
   - Create `C:/temp/forge-verify-smoke/` with a `package.json` containing `{"scripts":{"test":"echo ok","build":"echo should-not-run"}}`. Run `node scripts/forge-verify.js --cwd C:/temp/forge-verify-smoke` → expect `discoverySource:"package-json"`, commands `["npm run test"]` (build NOT invoked), `passed:true`.
   - Create a fake T##-PLAN.md with frontmatter `verify: "echo custom"`. Run with `--plan` → expect `discoverySource:"task-plan"`, `passed:true`.
   - Create `C:/temp/forge-verify-docs/` with only `README.md`. Run with `--cwd C:/temp/forge-verify-docs` → expect `{"passed":true,"discoverySource":"none","skipped":"no-stack"}`.
   - Windows command sanity: create `C:/temp/forge-verify-win/package.json` with `{"scripts":{"test":"node -e \"process.exit(0)\""}}`. Run → expect exit 0. Confirm `cmd /c` was used (verbose by temporarily logging `shellBin`).
   - Leave the 20 KB stderr test + 130 s timeout test for T06 (too slow for inline dev loop).

6. Node syntax check: `node -c scripts/forge-verify.js` must succeed (project convention — no lint configured).

7. Write `T01-SUMMARY.md` with smoke outputs, file size, and a one-line verdict.

## Standards

- **Target directory:** `scripts/` — matches convention (`forge-hook.js`, `forge-statusline.js`, `forge-classify-error.js`, `merge-settings.js`).
- **Reuse:** import no helpers from other scripts — this file is standalone. Reference `scripts/forge-classify-error.js` only for style (CommonJS, shebang, CLI guard pattern).
- **Naming:** kebab-case filename `forge-verify.js` per `forge-` prefix rule. Exported functions use camelCase (`discoverCommands`, `runVerificationGate`, `formatFailureContext`, `isLikelyCommand`). Constants UPPER_SNAKE (`MAX_OUTPUT_BYTES`, `PACKAGE_SCRIPT_KEYS`, `DEFAULT_COMMAND_TIMEOUT_MS`).
- **Module system:** CommonJS only (`require` / `module.exports`). Reference uses ESM — convert: `import` → `require`, `export function` → `function` + bottom `module.exports = {...}`.
- **No new dependencies:** zero `package.json` changes. Node built-ins only (`fs`, `path`, `child_process`).
- **Error style:** "Errors are data" principle (MEM036) applies to classification outcomes but NOT to telemetry I/O. Classification outcomes = data on stdout. Telemetry I/O errors = throw.
- **Lint command:** `node -c scripts/forge-verify.js` (syntax check only per `CODING-STANDARDS.md` — repo has no lint tooling).
- **Pattern:** `follows: Node CLI + module dual-mode` from `CODING-STANDARDS.md ## Pattern Catalog` — CommonJS header + shebang, `module.exports` block, `require.main === module` CLI guard, top-level try/catch on CLI entrypoint.

## Context

- **M002-CONTEXT decisions respected:** zero new npm deps; discovery chain is `plan.verify → prefs.preference_commands → auto-detect → skipped:no-stack`; Hybrid C approach (Node for determinism, Markdown for prose logic).
- **S01 artefact referenced (not consumed):** `scripts/forge-classify-error.js` exists but this task does NOT shell out to it. Verify failures are orchestrator-level; classifier is for `Agent()` exceptions only.
- **Risk mitigations:** see S02-RISK.md. Every Blocker (B1/B2/B3) and Warning (W1/W2/W3/W4/W5/W6) maps to a must-have above. B1 → 4-condition AND-gate. B2 → frozen allow-list. B3 → `process.platform` branch. W1 → 120 s timeout + exit 124. W2 → head+tail truncation. W3 → `--from-verify` sentinel (reserved for orchestrator). W5 → accept string OR array for `verify:`.
- **MEM011 respected:** orchestrator passes paths, worker (this script in CLI mode) reads `--plan` from disk. Script does NOT expect inlined content.
- **Security note from S02-RISK executor notes:** commands from `plan.verify` and `prefs.preference_commands` come from trusted files. `SHELL_INJECTION_PATTERN` check is defense-in-depth, not primary trust boundary. Document in prefs (T05).
- **Key files to read first:**
  - `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/verification-gate.js` (lines 1–252 — primary reference)
  - `scripts/forge-classify-error.js` (CommonJS style + CLI guard pattern)
  - `scripts/forge-hook.js` (stdin reader, top-level error handling)
  - `.gsd/milestones/M002/slices/S02/S02-RISK.md` (all mitigations)
  - `.gsd/CODING-STANDARDS.md` (allow-list of known command prefixes, naming, error patterns)
