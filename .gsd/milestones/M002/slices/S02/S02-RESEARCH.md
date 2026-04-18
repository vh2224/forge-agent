# S02: Verification gate executable — Research

**Researched:** 2026-04-16
**Domain:** deterministic Node CLI — child_process execution, YAML frontmatter parsing, stderr truncation, events.jsonl telemetry
**Confidence:** HIGH

## Summary

S02 ports GSD-2's `verification-gate.js` (252 lines of ESM, 6 exports) into a Forge-flavoured `scripts/forge-verify.js` (CommonJS, zero deps, dual-mode module+CLI). The reference file at `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/verification-gate.js` maps 1:1 to our target for lines 1–252 (we drop 253–520: `captureRuntimeErrors` + `runDependencyAudit`, both explicitly out of scope per M002-SCOPE). Three things are **new** in Forge versus GSD-2: (a) the 4-condition AND-gate for `skipped:"no-stack"` on docs-only repos (GSD-2 returns plain `source:"none"` without a skip field); (b) head+tail truncation for stderr (GSD-2 uses plain tail-truncate via `truncate(value, maxBytes)` at line 13–21); (c) per-command `timeout: 120_000` with synthetic exit 124 (GSD-2 relies on `DEFAULT_COMMAND_TIMEOUT_MS` from a `constants.js` module that's out of scope).

The primary recommendation is to **port verbatim from GSD-2 where behaviour is identical** (the `discoverCommands` skeleton, `isLikelyCommand` heuristic with its 53-element `KNOWN_COMMAND_PREFIXES`, `sanitizeCommand` regex, spawnSync shell branch) and **diverge only where Forge explicitly requires it** (the 3 deltas above + CommonJS conversion + events.jsonl append + --from-verify sentinel). This keeps the port auditable: a reviewer can diff our file against GSD-2 lines 1–252 and see exactly what changed and why.

The security surface of this slice is narrow but real: `runVerificationGate` shells out to commands drawn from `T##-PLAN` frontmatter (trusted, authored by another Opus agent) and `preference_commands` (trusted, user-authored). Defense-in-depth via `SHELL_INJECTION_PATTERN` + `isLikelyCommand` already exists in the reference — port it. The one genuine new risk is resource exhaustion (runaway `npm test`) — mitigated by the 120 s timeout. Log-injection via unsanitized stderr is mitigated by writing stderr into a fenced markdown block (not raw).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-platform shell dispatch | Custom OS detection + quoting logic | Port GSD-2 lines 217–218 verbatim: `process.platform === 'win32' ? ["cmd", "/c", cmd] : ["sh", "-c", cmd]` | GSD-2's approach is battle-tested in prod; avoids Node DEP0190 (spawnSync + `shell:true` + no args warning) |
| Command classification (prose vs shell) | Regex heuristics from scratch | Port `isLikelyCommand` (GSD-2 lines 151–176) + `KNOWN_COMMAND_PREFIXES` Set (lines 119–132) verbatim | 53 curated prefixes + 6 prose-detection rules. Rewriting = regression risk. |
| YAML frontmatter parsing for `verify:` field | Adding `gray-matter` / `js-yaml` / `front-matter` dependency | Pure-regex extract: `/^---\n([\s\S]*?)\n---/` → line-by-line scan for `verify:` key | Zero-dep rule (M002-CONTEXT). Forge only needs one key (`verify:`); full YAML parser is overkill. T01-PLAN step 4 already specifies this. |
| events.jsonl append | Custom JSON serializer | `JSON.stringify({...}) + '\n'` + `fs.appendFileSync` (mkdirSync first) | Pattern already exists — `skills/forge-auto/SKILL.md` Step 6a documents it, `scripts/forge-classify-error.js` retry handler uses it |
| argv flag parsing | `minimist` / `yargs` / `commander` | Inline `process.argv.includes('--flag')` + `process.argv[indexOf('--flag')+1]` — see `scripts/merge-settings.js` lines 15–17, `scripts/forge-classify-error.js` lines 115–125 | Forge contract: zero npm deps. Every existing script does it inline; this one will too. |
| stdin reader for pipe mode | External library | `process.stdin.setEncoding('utf8')` + `on('data')` + `on('end')` — pattern in `scripts/forge-hook.js` lines 20–24 and `scripts/forge-statusline.js` lines 9–12 | Three-liner idiom; every Forge CLI uses it. |
| Error classifier (for retry of transient) | Integrate with S01 classifier inside verify | Leave orthogonal — the verify gate returns non-zero exits; the orchestrator's Retry Handler classifies Agent() throws (not verify exit codes) | Documented in S02-RISK W3 + T02 anti-recursion rule. Conflating the two creates an infinite retry loop. |

## Common Pitfalls

### Pitfall 1: `shell: true` with string concatenation is a CVE waiting to happen
**What goes wrong:** Someone writes `spawnSync(cmd, { shell: true })` where `cmd` includes user-controlled substrings. On Node 20+ this triggers DEP0190; on Windows pre-patch it enables CVE-2024-27980 (command injection via .bat/.cmd argument parsing).
**Why it happens:** Natural instinct is to set `shell: true` and concat. GSD-2 deliberately avoids this by spawning the shell binary explicitly with `/c` or `-c`.
**How to avoid:** Port GSD-2 lines 217–219 exactly. Shell is `"cmd"` or `"sh"` (array form) with the full command string as the second argv element. Never set `shell: true`. Document the decision in the file header.

### Pitfall 2: `result.signal` is NOT reliable for timeout detection on Windows
**What goes wrong:** Node docs promise `result.signal === 'SIGTERM'` when timeout fires, but on Windows the kill mechanism is different — `result.signal` may be `null` with `result.status === null` and `result.error?.code === 'ETIMEDOUT'`. Our planned timeout detection via `signal === "SIGTERM"` (T01-PLAN step 4) will miss on Windows.
**Why it happens:** Windows lacks POSIX signals; Node synthesizes them but the mapping isn't 1:1 for timeouts.
**How to avoid:** Check THREE things: (a) `result.error?.code === 'ETIMEDOUT'`, (b) `result.signal === 'SIGTERM'`, (c) `result.status === null` with elapsed ≥ timeout. Any of these → synthetic exit 124 + `check.skipped: "timeout"`. This is a deviation from GSD-2 (which uses `constants.js` defaults only) — document in header.

### Pitfall 3: Windows `cmd /c` and forward slashes
**What goes wrong:** Paths with `/` work in `sh -c` (POSIX) but may fail or be reinterpreted by `cmd /c`. The npm-test smoke in T01 step 5 uses `node -e "process.exit(0)"` — if anyone parameterizes via CWD with forward slashes, cmd may misquote. Existing `scripts/forge-statusline.js` lines 160–164 use `shell: true` + pipes; that works only because the commands are static.
**Why it happens:** cmd.exe's `/c` parses the remaining argv as a single command line and applies its own quoting rules, which differ from POSIX `sh -c`.
**How to avoid:** Do NOT build commands with embedded paths. Let the command itself (`npm run test`, `echo ok`) resolve its own paths via CWD. Pass `cwd` option to `spawnSync` — don't prefix commands with `cd x && ...`. For the smoke tests in T01 step 5, keep commands CWD-relative.

### Pitfall 4: package.json `scripts` detection must guard against non-object `scripts`
**What goes wrong:** If someone writes `{"scripts": "npm run all"}` (string, not object) or `{"scripts": null}`, `Object.keys(pkg.scripts)` throws. GSD-2 already guards this at line 58: `pkg.scripts && typeof pkg.scripts === "object"`. Forgetting to port the guard = one malformed `package.json` crashes the gate on every invocation.
**Why it happens:** Corner-case input; not present in any normal project; easy to skip when focused on the happy path.
**How to avoid:** Port the GSD-2 guard verbatim. Wrap the `JSON.parse` in try/catch (GSD-2 line 70 does this — fall through silently to `source:"none"`). Don't over-validate — just don't crash.

### Pitfall 5: Head+tail truncation that loses the error LINE
**What goes wrong:** Given a 20 KB stderr where the single diagnostic line is in the middle (say byte 8000), head(3 KB)+tail(7 KB) = bytes 0–3072 + bytes 13312–20480. The actual error is dropped. Users see "npm verbose" prologue + "npm verbose" epilogue + no error.
**Why it happens:** Most test runners write their most-important line LAST (the failure summary), but some runners (jest, vitest) write the diagnostic INLINE where the failure occurs and then append a summary. A 20 KB stderr likely has the summary in the tail (good) BUT also has the stack mid-buffer (lost).
**How to avoid:** T01-PLAN already plans this correctly (3 KB head + 7 KB tail + marker). The tail weight (7 KB > head 3 KB) is right because most error messages lead with a stack AND end with a summary line. Do NOT change to symmetric 5+5 KB. Consider adding a grep pre-pass: if the raw stderr contains `/(error|failed|✗|FAIL):/i`, take 500 bytes around that match INTO the head portion. But this is scope creep — leave for a later milestone.

### Pitfall 6: events.jsonl silent-fail masks telemetry bugs
**What goes wrong:** Natural instinct: wrap `fs.appendFileSync` in try/catch so the gate "doesn't crash on permissions error". Result: a misconfigured `.gsd/forge/` directory silently drops every verify event. Debugging later is impossible — no trace that the gate even ran.
**Why it happens:** S02-RISK executor notes explicitly call this out (line 30). The `scripts/forge-hook.js` pattern (top-level try/catch) is wrong for this script. Hook = "must never crash Claude Code"; verify telemetry = "must never silently lose data".
**How to avoid:** Port T01-PLAN step 4 instruction verbatim: "Do NOT try/catch the append." Top-level try/catch wraps ONLY argv parsing (exit 2 on parse error). The events.jsonl append runs outside any try/catch — if it throws, the gate crashes loudly and the orchestrator's Retry Handler surfaces the error.

### Pitfall 7: `verify:` YAML frontmatter as array — regex fragility
**What goes wrong:** T01-PLAN step 4 line 85 says to match `/^---\n([\s\S]*?)\n---/` then find `verify:`. If someone writes multi-line YAML like:
```
verify:
  - npm run typecheck
  - npm test
```
our simple line-scan needs to detect indented dash items, not just the `verify:` line. Plain regex `verify:\s*(.+)` returns empty string.
**Why it happens:** YAML is indentation-sensitive; simple regex treats each line independently.
**How to avoid:** Implement a tiny state machine: (a) find `verify:` line; (b) if the rest of that line is non-empty → string form, done; (c) else scan subsequent lines that start with `  - ` or `\t- `, collect until we hit a non-indented line; (d) join on ` && `. Max ~10 lines of code. Reject anything that doesn't match these two shapes — don't try to parse general YAML. Document the two accepted shapes in the file header.

### Pitfall 8: forge-agent dogfood gotcha — no package.json means `source:"none"`
**What goes wrong:** T06 acceptance criterion 12 runs `node scripts/forge-verify.js --cwd .` on forge-agent itself. Result must be `{skipped:"no-stack", passed:true, exit:0}`. If someone later adds a stray `package.json` for tooling (e.g., adding prettier), the gate flips to running npm scripts — which probably fail because forge-agent is pure-node + Markdown.
**Why it happens:** The 4-condition AND-gate checks for ANY of `package.json`/`pyproject.toml`/`go.mod`. A single-file `package.json` that only contains `{}` or dev-dep config still triggers auto-detect.
**How to avoid:** Document in the file header: "If package.json exists but has NO `scripts` object with `typecheck`/`lint`/`test` keys, we still return `source:"package-json"` with empty `commands` → runs nothing → `passed: true`." Verify this is the GSD-2 behaviour (lines 60–68 iterate keys in order, so empty allow-list match → empty commands → passes). Add smoke test for this case.

### Pitfall 9: `shared/forge-dispatch.md` token budget
**What goes wrong:** S02-RISK W6 and T02 both flag this. The file was ~500 lines pre-S01; after S01's Retry Handler (+161 lines) it's ~660 lines. Adding a full Verification Gate section (T02 plans ~150 lines) pushes toward ~810 lines. Every worker prompt loads this via path-reference, so growth affects dispatch-time.
**Why it happens:** Documentation naturally accretes. One person adds a section without checking cumulative size.
**How to avoid:** T02 should measure file size before AND after. Target: verify section ≤ 150 lines. If the combined file would blow 1000 lines, extract to `shared/forge-verify-gate.md` and keep a 10-line cross-reference stub in forge-dispatch.md. CODING-STANDARDS Asset Map entry for forge-dispatch.md should note this threshold.

## Relevant Code

### Reference implementation (to be ported, verbatim where possible)

- **`C:/Users/VINICIUS/.gsd/agent/extensions/gsd/verification-gate.js` lines 1–252** — primary source. Maps 1:1 to target Forge file. Break-out by region:
  - **Lines 10–21** — `MAX_OUTPUT_BYTES` constant + `truncate(value, maxBytes)` utility. Port verbatim. Add new `truncateHeadTail` sibling per T01-PLAN step 4.
  - **Lines 22–23** — `PACKAGE_SCRIPT_KEYS = ["typecheck", "lint", "test"]`. Port as `Object.freeze(["typecheck","lint","test"])` per T01-PLAN.
  - **Lines 31–76** — `discoverCommands` — port with three deltas: drop `rewriteCommandWithRtk`, add pyproject.toml + go.mod existence check at end (source stays `"none"` either way, per T01-PLAN step 4), return `{commands: [], source: "none"}` unchanged.
  - **Lines 77–111** — `MAX_STDERR_PER_CHECK` + `MAX_FAILURE_CONTEXT_CHARS` + `formatFailureContext`. Port with delta: `stderr.slice(0, MAX_STDERR_PER_CHECK)` → `truncateHeadTail(stderr, 600, 1400)`. Keep 10 000 total cap.
  - **Lines 113–132** — `SHELL_INJECTION_PATTERN` + `KNOWN_COMMAND_PREFIXES` Set. Port verbatim. The Set has 53 entries spanning npm/test/build/git/docker/lang tools — exhaustive.
  - **Lines 133–176** — `isLikelyCommand` heuristic. Port verbatim (6 rules documented in JSDoc).
  - **Lines 181–187** — `sanitizeCommand`. Port verbatim.
  - **Lines 196–252** — `runVerificationGate` core. Port with deltas: drop RTK rewrite, add top-level `skipped:"no-stack"` when `source === "none"`, add per-check timeout handling (synthetic exit 124 when SIGTERM/ETIMEDOUT/status===null+elapsed≥timeout), apply `truncateHeadTail` when stderr > 10 KB.
  - **Lines 217–218** — platform dispatch (the canonical cross-platform pattern). Port verbatim, document as security primitive in header.

### Existing Forge CommonJS style references

- **`scripts/forge-classify-error.js` lines 114–143** — CLI entrypoint pattern. `require.main === module` guard, argv scan with `--flag value` idiom, stdin fallback, `JSON.stringify(result)` to stdout. Our verify.js CLI section should mirror this structure beat-for-beat (except we also write events.jsonl and use process.exit with status).
- **`scripts/forge-classify-error.js` lines 16–27** — regex constants + `use strict` + `// ── Section ──` comment dividers. Same style for verify.js.
- **`scripts/forge-classify-error.js` lines 110–111** — `module.exports = { ... }` block. Same pattern for verify.js's 4 exports.
- **`scripts/forge-hook.js` lines 14–24** — imports (`fs`, `path`, `os`) + stdin reader idiom. verify.js doesn't read stdin, but the imports/top style is the reference.
- **`scripts/merge-settings.js` lines 12–17** — argv parsing for repeatable flags (`--mcp-add <name> <config>`). Shape template for our `--preference <cmd>` (repeatable) handling.
- **`scripts/forge-statusline.js` lines 159–171** — `execSync` with `{cwd, encoding, timeout, shell}` options. Reference for `spawnSync` option shape (we use spawnSync not execSync, but the option set is near-identical).

### events.jsonl telemetry contract

- **`.gsd/forge/events.jsonl`** — current contents include `unit: "execute-task/T##"`, `agent: "forge-executor"`, `status: "done"`, `summary`, `key_decisions`, `files_changed`. Our new `event: "verify"` shape extends this with: `discovery_source`, `commands`, `passed`, `skipped?`, `duration_ms`. Do NOT include: raw stderr (PII risk), full stdout.
- **`shared/forge-dispatch.md` lines 326–342** — existing schema for `event:"retry"` entries. New `event:"verify"` mirrors the style (ISO8601 ts, unit string, kind-specific fields). T02 documents this in the new Verification Gate section.

### Agent wiring targets (to be modified, not read-verbatim)

- **`agents/forge-executor.md` lines 9–12 (Process step numbers)** — T03 inserts a new step 10.5 "Run verify gate" between step 9 (verify must-haves) and step 11 (write T##-SUMMARY.md). Current step 10 is git commit, so the actual insert point is between 9 and 10 with renumbering.
- **`agents/forge-completer.md` lines 36–41 (steps 3 and 4 of complete-slice)** — T04 inserts a new step 3 "Run verify gate" that runs BEFORE step 3 (security scan) and step 4 (lint gate), renumbering downstream.

## Asset Map — Reusable Code

| Asset | Path | Exports | Use When |
|-------|------|---------|----------|
| Error classifier module | `scripts/forge-classify-error.js` | `classifyError(msg, retryAfterMs?)`, `isTransient(result)` + CLI `--msg "..."` | Classifying Agent() exceptions (S01 scope); NOT used by verify.js (anti-recursion rule — different concern) |
| CommonJS dual-mode template | `scripts/forge-classify-error.js` lines 1–143 | Whole-file pattern: shebang, `use strict`, regex constants, exports, `require.main` CLI guard | Blueprint for any new deterministic Forge CLI — verify.js follows this exact skeleton |
| execSync/spawnSync option shape | `scripts/forge-statusline.js` lines 160–164 | `{cwd, encoding:'utf8', timeout:N, shell:true}` — but note shell:true is LEGACY for static cmds only | Only safe for statically-authored commands; verify.js should NOT use shell:true, use explicit shell binary instead |
| argv flag scanner idiom | `scripts/merge-settings.js` lines 12–17, `scripts/forge-classify-error.js` lines 115–125 | `process.argv.includes('--flag')` + `indexOf('--flag')+1` lookup | Zero-dep CLI arg parsing — apply to `--plan`, `--cwd`, `--unit`, `--preference`, `--timeout`, `--from-verify` in verify.js |
| Stdin reader for pipe mode | `scripts/forge-hook.js` lines 20–24, `scripts/forge-classify-error.js` lines 132–141 | `process.stdin.setEncoding('utf8')` + data/end handlers + `isTTY` fallback | Not needed for verify.js (plan path comes via `--plan`), but documented pattern |
| Hook safety-fail pattern | `scripts/forge-hook.js` lines 204–207 | Top-level try/catch that silently swallows | ANTI-pattern for verify.js — S02-RISK W3 requires loud failure on telemetry I/O errors |
| Settings merger idempotent writer | `scripts/merge-settings.js` lines 81–82, 213–214 | `mkdirSync(dirname, {recursive: true}) + writeFileSync(file, JSON.stringify + '\n')` | events.jsonl append pattern (variant: appendFileSync instead of writeFileSync) |
| Dispatch template (shared) | `shared/forge-dispatch.md` 7 templates | Data-flow descriptors for worker prompts | T02 adds `## Verification Gate` section here + inlines into `execute-task` + `complete-slice` templates |
| Retry Handler control-flow | `shared/forge-dispatch.md` lines 283–441 | Try/catch around Agent() + classifier shell-out + backoff + events log | Reference for T02 — verify gate is INVOKED differently (worker shells out to node script synchronously; no retry wrapper around verify itself) |
| package.json script detection | GSD-2 `verification-gate.js` lines 53–68 | `pkg.scripts[key]` probe against frozen allow-list | Port directly to verify.js — do not rewrite |
| Cross-platform shell dispatch | GSD-2 `verification-gate.js` lines 217–218 | `process.platform === 'win32'` → cmd /c vs sh -c | Port verbatim — canonical pattern for all future Forge scripts that shell out |
| YAML frontmatter regex | Implied by `/^---\n([\s\S]*?)\n---/` in T01-PLAN step 4 | Extract frontmatter block, then line-scan for specific key | New pattern for S02 — will be reused by any future tool reading T##-PLAN metadata |

## Coding Conventions Detected

Building on `.gsd/CODING-STANDARDS.md`:

- **File naming:** `forge-<verb>.js` — confirmed. `forge-verify.js` matches.
- **Function naming:** camelCase exports (`classifyError`, `isTransient`, `mergeToolHook`). verify.js: `discoverCommands`, `runVerificationGate`, `formatFailureContext`, `isLikelyCommand`.
- **Constants:** UPPER_SNAKE in regex/numeric constants (`PERMANENT_RE`, `MAX_OUTPUT_BYTES`, `FORGE_HOOK_MARKER`). Freeze arrays used as allow-lists (`Object.freeze(["typecheck","lint","test"])`).
- **Module system:** CommonJS ONLY. GSD-2 uses ESM (`import`/`export`); mechanical conversion required.
- **Header comment:** file-level block comment citing source (if ported), invariants, and security notes. See `forge-classify-error.js` lines 2–14.
- **`'use strict';`** at line 2 of every script — confirmed across forge-classify-error.js, forge-hook.js, merge-settings.js.
- **Section dividers:** `// ── Section Name ──────────` comments. Confirmed in classify-error.js lines 18, 29, 91, 110, 113.
- **CLI guard:** `if (require.main === module)` — confirmed.
- **JSON output to stdout:** single-line `console.log(JSON.stringify(result))`. Pretty-print is forbidden.
- **Exit codes:** 0 = success, 1 = logical failure (test failed / verify failed), 2 = CLI parse error / usage. Consistent with S01 classifier.
- **Error patterns:** "Errors are data" (MEM036) applies to classification + verification **results**. It does NOT apply to **telemetry I/O** — events.jsonl append MUST throw on failure (S02-RISK executor note).
- **Zero npm deps:** confirmed — no `package.json` in repo root, no dep references anywhere.
- **Path handling:** `path.join(...)` for cross-platform; Bash snippets use POSIX-y slashes (Git Bash on Windows tolerates both).
- **Node built-ins only:** `fs`, `path`, `os`, `child_process`. verify.js adds `child_process.spawnSync` (first use in Forge — others use execSync).
- **Frontmatter parsing:** new pattern for S02 — simple regex extract + line-scan, not a full YAML parser. Document the two accepted shapes (string, array-of-strings).

## Pattern Catalog — Recurring Structures

No new patterns discovered — verify.js instantiates the existing **Node CLI + module dual-mode** pattern from CODING-STANDARDS.md. The pattern cap (10) is safe.

Note: the **sub-pattern** "explicit shell binary dispatch for cross-platform spawn" (used only in verify.js currently) is narrow; if a future script shells out the same way, promote to a standalone pattern entry. Until then, leave it as a deep-link note on the dual-mode pattern.

## Security Considerations

This slice directly executes shell commands drawn from project files. The attack surface is narrow (trusted sources) but material.

| Concern | Risk Level | Recommended Mitigation |
|---------|------------|------------------------|
| Command injection via `verify:` frontmatter | MEDIUM | `SHELL_INJECTION_PATTERN = /[;|`]|\$\(/` rejects obvious injection; `isLikelyCommand` heuristic rejects prose-as-command. Both already in GSD-2 — port verbatim. Defense-in-depth; trust boundary is "file is in the repo under version control". |
| Command injection via `preference_commands` prefs | LOW | Prefs files (`.gsd/claude-agent-prefs.md`, `prefs.local.md`) are user-authored and gitignored (local) or committed (shared). Trust boundary same as repo. T05 prefs block MUST include security note: "preference_commands run in the repo's shell — do NOT paste unreviewed commands". |
| Arbitrary script execution via malicious `package.json` | LOW | Frozen allow-list `["typecheck", "lint", "test"]` hard-stops anything outside these three keys. `start`, `dev`, `build`, `prepare`, `postinstall` (the dangerous ones) CANNOT be invoked. Smoke test in T01 step 5 verifies `build` is not run even when present. |
| Resource exhaustion (runaway `npm test`) | MEDIUM | Per-command `timeout: 120_000` + synthetic exit 124. An infinite test loop wastes 2 min, then fails cleanly. For a 5-task milestone that's max 10 min of dead time — tolerable. Without this: forge-auto could hang indefinitely. |
| stderr log-injection via fake ANSI / newlines | LOW | stderr is written into a fenced markdown block (```stderr ... ```) inside formatFailureContext — terminal escapes are rendered harmless. Head+tail truncation + 10 KB cap prevents log bloat. Format is for prompt injection to the next worker, which treats it as prose. |
| Windows `.bat`/`.cmd` argument injection (CVE-2024-27980) | LOW | We never pass a `.bat` or `.cmd` file path directly to spawnSync — we pass `"cmd"` + `["/c", userCommand]`. The `userCommand` string is parsed by cmd.exe (not directly), so CVE-2024-27980's .bat-extension-confusion path does not apply. BUT: if a `verify:` command is literally `foo.bat` and Node runs on unpatched <18.20.2, there's theoretical exposure. Mitigation: require Node ≥ 20 in Forge (already the case). |
| Silent telemetry drop | MEDIUM | events.jsonl append MUST throw on I/O error (S02-RISK executor note). NO try/catch wrapping the append. Silent fail masks bugs and blinds future debugging. T01-PLAN step 4 line 92 enforces this. |
| Information leak via stderr in failure context | LOW | Stderr can contain file paths, env vars, secrets (if badly configured test runner echoes them). Our 10 KB cap + head/tail truncation doesn't sanitize content. Mitigation: document in T05 prefs that users who run with `auto_commit: false` can inspect stderr before it's injected into a retry prompt. This is a residual risk; accept it. Do NOT regex-scan stderr for secrets — that's a separate scope (forge-security skill owns this). |
| Anti-recursion: verify failure triggering verify re-invocation | HIGH (if missed) | `--from-verify` sentinel flag documented in T01 + T02. Orchestrator's Retry Handler MUST NOT re-dispatch the verify script when a dispatch failure came from a verify invocation. The sentinel is reserved (script accepts but ignores it) — the ENFORCEMENT lives in `shared/forge-dispatch.md ### Retry Handler` anti-recursion rule added by T02. |

## Sources

### File reads
- `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/verification-gate.js` (1–252) — primary port source; maps 1:1 to target except 3 planned deltas.
- `C:/DEV/forge-agent/scripts/forge-classify-error.js` — CommonJS dual-mode template + S01 classifier (not consumed by verify, but style reference).
- `C:/DEV/forge-agent/scripts/forge-hook.js` — stdin reader + top-level try/catch pattern (anti-pattern for verify's events.jsonl write).
- `C:/DEV/forge-agent/scripts/forge-statusline.js` — execSync option shape + cmd.exe quoting lessons (two-call pattern at lines 178–205).
- `C:/DEV/forge-agent/scripts/merge-settings.js` — argv flag scanner idiom + idempotent writer.
- `C:/DEV/forge-agent/shared/forge-dispatch.md` — 7 templates + Retry Handler section (reference for T02 additions + anti-recursion rule).
- `C:/DEV/forge-agent/agents/forge-executor.md` — wiring target for T03.
- `C:/DEV/forge-agent/agents/forge-completer.md` — wiring target for T04.
- `C:/DEV/forge-agent/forge-agent-prefs.md` — structure model for T05's `verification:` block.
- `C:/DEV/forge-agent/.gsd/CODING-STANDARDS.md` — all conventions already documented; adding 1 Asset Map entry.
- `C:/DEV/forge-agent/.gsd/milestones/M002/M002-CONTEXT.md` — locks zero-deps rule + discovery chain + skip semantics.
- `C:/DEV/forge-agent/.gsd/milestones/M002/slices/S02/S02-PLAN.md` — 6 tasks + 12 acceptance criteria.
- `C:/DEV/forge-agent/.gsd/milestones/M002/slices/S02/S02-RISK.md` — B1/B2/B3 blockers + W1–W6 warnings, executor notes.
- `C:/DEV/forge-agent/.gsd/milestones/M002/slices/S02/tasks/T01/T01-PLAN.md` — detailed port steps + smoke tests.
- `C:/DEV/forge-agent/.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` — isTransient contract + classifier output shape (for documentation cross-reference).
- `C:/DEV/forge-agent/.gsd/forge/events.jsonl` (last 6 entries) — existing telemetry line shapes; new `event:"verify"` follows same compact single-line JSON style.

### Web searches
- `Node.js spawnSync shell: true vs cmd /c sh -c cross-platform best practice 2026 security` → Confirms: `shell: true` triggers DEP0190 on Node 24+ and is deprecated as unsafe with concatenation; explicit `["cmd","/c",cmd]` / `["sh","-c",cmd]` (GSD-2's approach) is the recommended pattern. `cross-spawn` npm package exists but violates zero-deps rule. Sources: [Node.js April 2024 Security Release](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2), [cross-spawn](https://www.npmjs.com/package/cross-spawn). Confidence: HIGH.
- `Node.js spawnSync timeout SIGTERM detection result.signal null behavior` → Confirms pitfall: `result.signal === 'SIGTERM'` fires only when process actually gets the signal; on Windows or when child intercepts, `result.signal` may be null and `result.status` null with `result.error.code === 'ETIMEDOUT'`. Must check all three. Source: [Node.js child_process docs](https://nodejs.org/api/child_process.html). Confidence: HIGH.
- `YAML frontmatter parser Node.js zero dependencies pure regex simple markdown` → Confirms: every mainstream parser (`gray-matter`, `front-matter`, `yaml-front-matter`, `js-yaml`) is an npm dep we cannot use. Gray-matter's docs explicitly warn "don't use regex" for general YAML, but for a single-key extraction (our case — `verify:` only) regex is acceptable. Sources: [gray-matter](https://github.com/jonschlinkert/gray-matter), [front-matter](https://www.npmjs.com/package/front-matter). Confidence: HIGH.
- `stderr log truncation head tail strategy byte limit preserve error stack trace pattern` → Findings thin; no canonical pattern found. Head+tail with asymmetric weights (3 KB + 7 KB) is defensible — most test runners emit summary lines at the tail, but critical stack frames can be mid-stream. Accepted risk documented in Pitfall 5. Confidence: MEDIUM.
- `Node.js spawnSync Windows cmd.exe argument injection BatBadBut CVE-2024-27980 mitigation` → Confirms: CVE-2024-27980 affects `.bat`/`.cmd` files passed directly to spawn; our usage (`cmd /c <user-string>`) routes through cmd.exe's own parser and is not the vulnerable path. Node ≥ 18.20.2 / 20.12.2 / 21.7.3 patches. Forge requires Node ≥ 20, so we're patched. Sources: [CVE-2024-27980 Vulert](https://vulert.com/vuln-db/CVE-2024-27980), [oss-sec](https://seclists.org/oss-sec/2024/q2/79). Confidence: HIGH.
