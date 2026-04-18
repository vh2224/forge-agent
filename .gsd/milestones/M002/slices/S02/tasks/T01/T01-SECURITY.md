# Security Checklist — S02/T01: Port verification gate to scripts/forge-verify.js

**Domains in scope:** Injection (command), Input validation, Secrets management
**Generated:** 2026-04-16
**Risk level:** HIGH

T01 executes arbitrary shell commands via `child_process.spawnSync`, parses YAML frontmatter from untrusted paths, and writes stderr to `events.jsonl`. Command-injection is the primary hazard; log leakage of test output is secondary.

## Blockers — resolve before marking complete

### Injection (command execution)

- [ ] **Frozen allow-list enforced:** `PACKAGE_SCRIPT_KEYS = Object.freeze(["typecheck", "lint", "test"])` — literal constant, never derived from `pkg.scripts` keys, never read from config. Confirmed by grep that no dynamic key list construction exists in the file.
- [ ] **Shell-injection regex applied to `taskPlanVerify` ONLY:** `SHELL_INJECTION_PATTERN = /[;|`]|\$\(/` rejects any command from plan-derived input. `preferenceCommands` bypass (trusted user-authored prefs) — document this trust boundary in the header comment.
- [ ] **`isLikelyCommand(cmd)` is called on each `taskPlanVerify` segment** before dispatch — prose-like strings (matching any of the reject patterns) are dropped, not executed.
- [ ] **No `shell: true` on `spawnSync`:** explicit `spawnSync("cmd", ["/c", cmd], ...)` or `spawnSync("sh", ["-c", cmd], ...)`. The command string is a single argv token, not concatenated. This avoids Node DEP0190 (Node 24+) and the CVE-2024-27980 attack class.
- [ ] **Platform branch hardcoded:** `process.platform === 'win32'` → cmd; else → sh. No user-controlled shell binary selection.

### Input Validation (YAML frontmatter from --plan path)

- [ ] **`verify:` field accepts only string OR array of strings.** Any other YAML shape (object, number, null, boolean) is rejected — log and skip, do NOT attempt to execute.
- [ ] **`--plan` path is read with `readFileSync`** — no `eval`, no `require()` on user paths. Only the YAML frontmatter between `---\n` delimiters is extracted.
- [ ] **Frontmatter size cap:** if file > 1 MB, abort with parse error before attempting regex. (Defense against regex-catastrophic-backtracking — the `/^---\n([\s\S]*?)\n---/` on an unbounded file could hang.)
- [ ] **`--cwd <dir>` is not shell-interpolated.** Node `process.chdir()` or used as `{cwd}` option on `spawnSync` — never echoed into a command string.

### Secrets Management (stderr capture → events.jsonl)

- [ ] **Per-check `stderr` in `events.jsonl` is truncated to head+tail (3 KB + 7 KB)** — but still may contain secrets if a test leaks env vars. Executor MUST add a header comment warning: "stderr captured verbatim in events.jsonl. If your tests log env vars or credentials, redact before running the gate."
- [ ] **Events.jsonl write MUST throw on I/O error** (per S02-RISK W3 executor note). Do NOT wrap the `appendFileSync` in try/catch. Silent telemetry failure is forbidden here; the caller (orchestrator) handles the thrown exception.
- [ ] **No secret values logged directly by `forge-verify.js`:** the script itself never echoes `process.env.*` or command arguments to stdout/stderr. Only the spawned command's own output is captured.

## Also verify

- [ ] **`--from-verify` sentinel accepted but ignored** — reserved for orchestrator anti-recursion per S02-RISK W3. If accidentally triggered via recursive invocation, the orchestrator (T02/T03) handles it; the script itself just logs presence in the header comment.
- [ ] **120-second per-command timeout enforced via `spawnSync({timeout: 120_000})`** — not via wall-clock check. Timeout detection combines `result.signal === 'SIGTERM'` AND `result.error?.code === 'ETIMEDOUT'` (per S02-RESEARCH Pitfall on Windows).
- [ ] **Commands that include relative paths** (e.g., `./scripts/mything.sh`) are dispatched relative to `{cwd}` — not to `process.cwd()` of the orchestrator. Document in header.

## Anti-Patterns to Avoid

- **`execSync(cmd, {shell: true})`** — NEVER. The allow-list loses meaning if shell metacharacters are interpreted. GSD-2 uses `spawnSync(shellBin, [shellFlag, cmd])` with explicit argv; preserve exactly.
- **Dynamic script-key iteration:** `for (const key of Object.keys(pkg.scripts))` — NEVER. Even with a filter, this pattern invites bypass via prototype pollution if `pkg.scripts = Object.create({__proto__: {evil: "rm -rf"}})`. Use `for (const key of PACKAGE_SCRIPT_KEYS)` and probe `pkg.scripts[key]`.
- **Unbounded stderr writes to events.jsonl:** truncate BEFORE append; a 50 MB test failure would fill disk if written raw.

## If You Find a Violation

Record in T01-SUMMARY.md under `## ⚠ Security Flags` with: file, line, pattern, fix applied.
Do NOT mark T01 complete until all 11 Blocker items above are resolved.
