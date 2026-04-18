# Coding Standards — forge-agent

Auto-detected from scripts/, skills/, commands/, agents/, shared/, and GSD artifacts.
Consolidated record — updated by researchers across milestones. Planner + executor read from this file.

---

## Lint & Format Commands

No lint or format tooling is configured in this repo (pure shell-scripts + Markdown + Node CommonJS single-files with no `package.json`). Executors should:
- For `scripts/*.js`: verify files parse with `node --check <file>` (syntax check only).
- For `.md` artifacts: manually verify YAML frontmatter is parseable (check `---` delimiters, key: value syntax).
- No tests exist. Acceptance is via UAT scripts (`S##-UAT.md`) and demo transcripts in `S##-SUMMARY.md`.

If lint tooling is ever added, update this section.

---

## Directory Conventions

| Directory | Purpose | File conventions |
|-----------|---------|------------------|
| `scripts/` | Executable Node helpers | `forge-<verb>.js`; CommonJS; `#!/usr/bin/env node` shebang; single-file (no `package.json`); dual-mode (module + CLI) where applicable |
| `shared/` | Reference docs consumed by multiple skills/commands | `forge-<topic>.md`; plain Markdown with inlined fenced blocks |
| `skills/<name>/` | Skills invoked via `Skill()` tool | `SKILL.md` with YAML frontmatter + `<objective>`, `<essential_principles>`, `<process>` sections |
| `commands/` | Slash commands exposed in Claude Code CLI | `forge-<name>.md`; many are 6-7 line shims forwarding `$ARGUMENTS` to a skill |
| `agents/` | Subagent definitions for the `Agent` tool | `forge-<role>.md` with frontmatter (`name, description, model, effort, tools`) |
| `.gsd/` | Runtime state — never hand-edit during autonomous runs | `STATE.md`, `DECISIONS.md`, `AUTO-MEMORY.md`, `LEDGER.md`, `CODING-STANDARDS.md`, `forge/events.jsonl`, `forge/auto-mode.json`, `milestones/M###/...` |

---

## Naming Conventions

- **Files:** `forge-<name>` prefix everywhere (`forge-hook.js`, `forge-classify-error.js`, `forge-dispatch.md`, `forge-security` skill, `forge-executor` agent).
- **Functions:** camelCase (`classifyError`, `mergeToolHook`, `pauseTransientWithBackoff`, `countTokens`, `truncateAtSectionBoundary`).
- **Constants:** UPPER_SNAKE (`PERMANENT_RE`, `MAX_NETWORK_RETRIES`, `FORGE_HOOK_MARKER`, `LIFECYCLE_HOOKS`).
- **Agents/commands/skills:** kebab-case (`forge-auto`, `forge-risk-radar`).
- **GSD IDs:** `M###` for milestones, `S##` for slices, `T##` for tasks — three-digit milestones, two-digit slices/tasks.

---

## Import Organization

- CommonJS only. `const fs = require('fs')` at top.
- Standard ordering: built-in modules (`fs`, `path`, `os`) → conditional lazy imports inside try blocks (`execSync` in `forge-statusline.js`).
- Never introduce ESM (`import`/`export`) in `scripts/` — CommonJS is the project contract for maximum Node-version compatibility.
- No `package.json` in the repo — no third-party dependencies allowed in `scripts/`. If a capability can't be done with Node built-ins, reconsider the approach (M002 decision — zero new deps).

---

## Error Patterns

- **Scripts:** Top-level try/catch wraps the entire handler; errors are swallowed silently (MEM008). Hooks MUST NOT crash Claude Code.
- **Classifier pattern:** "Errors are data, not process failures" (MEM036). Exit code 0 always; emit `{kind:"unknown"}` on any internal failure.
- **Telemetry pattern (inverse of silent-fail):** Scripts that append to `events.jsonl` (verify gate, future token telemetry) do NOT wrap the append in try/catch — I/O errors propagate to the caller. Silent telemetry loss is unacceptable; the orchestrator handles the exception. See `scripts/forge-verify.js` line 492 comment and S02-RISK.md precedent.
- **Skills/agents:** Emit structured `---GSD-WORKER-RESULT---` blocks with `status: done | partial | blocked` and a `blocker` field with one of 6 classes.
- **Orchestrator blocker taxonomy:** `context_overflow`, `scope_exceeded`, `model_refusal`, `tooling_failure`, `external_dependency`, `unknown` — each has its own recovery policy documented in `skills/forge-auto/SKILL.md`.
- **Transient error retry taxonomy (S01 target):** 5 classes — `rate-limit`, `network`, `server`, `stream`, `connection` — are orthogonal to blocker classes and trigger BEFORE blocker classification. `permanent` and `unknown` from the classifier fall through to the blocker table as before.
- **Mandatory-section overflow pattern:** Helpers that gate content size on a mandatory path throw with a structured message (e.g. `"Context budget exceeded for mandatory section {label}: {actual} chars > {budget} budget"`) and let the orchestrator's blocker taxonomy surface them as `scope_exceeded`. Optional-section overflow is not an error — it truncates with a marker. Pattern originates in M002 S03.
- **Hooks:** Always register in `merge-settings.js` tables (`TOOL_HOOKS` or `LIFECYCLE_HOOKS`) so install/uninstall is idempotent.

---

## Frontmatter Conventions

| Artifact type | Required keys | Optional keys |
|---------------|---------------|---------------|
| Agent (`agents/forge-*.md`) | `name`, `description`, `model`, `tools` | `effort`, `thinking` |
| Command (`commands/forge-*.md`) | `description`, `allowed-tools` | — |
| Skill (`skills/forge-*/SKILL.md`) | `name`, `description` | `disable-model-invocation: true` (MEM004 — always set), `allowed-tools` |
| Task plan (`.gsd/milestones/M###/slices/S##/tasks/T##/T##-PLAN.md`) | `id`, `slice`, `milestone` | `verify:` — string (`npm run typecheck && npm test`) OR indented YAML array; read by `scripts/forge-verify.js --plan` |

Opus agents add `thinking: adaptive` and `effort: medium`. Sonnet agents add `effort: low`.

---

## Language

- **Code + comments:** English.
- **Commit messages:** Conventional Commits in English (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
- **User-facing messages (statusline, skill output, prompts):** pt-BR (e.g., `"Falha ao despachar subagente..."`, `"Retomando forge-auto após interrupção..."`).
- **Artifact documents (RESEARCH/CONTEXT/PLAN/SUMMARY):** English or pt-BR; follow whatever the milestone discussion established.

---

## Path Handling

- Markdown dispatch templates use `{WORKING_DIR}/.gsd/...` absolute paths (MEM010) — substituted by orchestrator at dispatch time.
- Node scripts use `path.join(...)` for cross-platform compatibility.
- Bash snippets use Unix syntax (forward slashes, `/dev/null`, `2>/dev/null`) per environment notes — works in both Git Bash and WSL on Windows.
- `shell: true` for `execSync` on Windows to handle pipes/redirects.
- For NEW scripts that shell out with untrusted-adjacent input: use explicit shell binary (`spawnSync("cmd", ["/c", cmd])` on win32, `spawnSync("sh", ["-c", cmd])` elsewhere) instead of `shell: true`. Avoids Node DEP0190 (Node 24+) and CVE-2024-27980-class injection via .bat/.cmd arg handling. Canonical pattern: GSD-2 `verification-gate.js` lines 217–218; implemented in `scripts/forge-verify.js`.

---

## Asset Map — Reusable Code

| Asset | Path | Exports / Shape | Use When |
|-------|------|-----------------|----------|
| Hook dispatcher | `scripts/forge-hook.js` | 6 phases: `pre`, `post`, `subagent-start`, `subagent-stop`, `pre-compact`, `post-compact` | Add new lifecycle behavior — extend existing file, register phase in `merge-settings.js` tables |
| Status line renderer | `scripts/forge-statusline.js` | stdin JSON → formatted status line on stdout | Reference for execSync pattern with 10-min cache |
| Settings merger (idempotent) | `scripts/merge-settings.js` | CLI: `--remove`, `--mcp-add/remove/list`; merges into `~/.claude/settings.json` | Add new hook phases, MCP management |
| Codebase collector (legacy) | `scripts/codebase-collect.sh` | bash script outputting structured sections with `::LABEL::` markers | Feeding codebase summaries to `/forge-codebase` |
| Stdin reader idiom | `scripts/forge-hook.js` lines 19-24 | `process.stdin.setEncoding('utf8'); chunks; on('end')` | Any CLI that accepts piped input |
| argv flag parser idiom | `scripts/merge-settings.js` lines 15-17 | `process.argv.includes('--flag')` + `indexOf('--flag')+1` for value | CLI arg parsing without dependencies |
| execSync with timeout | `scripts/forge-statusline.js` lines 160-164 | `execSync(cmd, {cwd, encoding:'utf8', timeout:N, shell:true})` | Running external commands safely on Windows+Unix |
| Dispatch template section | `shared/forge-dispatch.md` | 7 templates (execute-task, plan-slice, plan-milestone, complete-slice, complete-milestone, discuss-*, research-*) | Changes to worker prompts — **both** forge-auto and forge-next read from here |
| events.jsonl append (canonical) | `scripts/forge-verify.js` lines 479–493 | `mkdirSync(recursive:true)` → `JSON.stringify(event)` → `appendFileSync(path, line + '\n', 'utf-8')`; NO try/catch (telemetry throws, not silent-fail). Current event shapes: legacy summary (no `event:` field), `event:"retry"` (S01), `event:"verify"` (S02), `event:"dispatch"` (S03 target) | Any orchestrator-side telemetry write. Append-only; never rewrite lines. |
| auto-mode.json heartbeat | `skills/forge-auto/SKILL.md` lines 78-82, 233-236 | `{active, started_at, last_heartbeat, worker, worker_started}` | Long-running operations that need statusline liveness |
| PostCompact recovery signal | `scripts/forge-hook.js` lines 82-97 | writes `.gsd/forge/compact-signal.json` when `auto-mode.json` is active | Recovery after auto-compact; orchestrator reads/deletes signal at top of each loop |
| Agent() CRITICAL failure block | `skills/forge-auto/SKILL.md` lines 251-258 | writes `auto-mode.json {active:false}` then hard-stops | Current behavior — replaced by retry handler in S01 for transient classes |
| Skill invocation pattern | `skills/forge-auto/SKILL.md` lines 156-159, 166-168 | `Skill({ skill: "forge-X", args: "..." })` | Invoking skills from orchestrator with explicit args (MEM017) |
| Command→skill shim idiom | `commands/forge-auto.md`, `commands/forge-task.md`, `commands/forge-new-milestone.md` | 6-7 lines, `Skill({skill:"...", args:"$ARGUMENTS"})` | New commands migrated to skills/ |
| Secret-blocking guard | `scripts/forge-hook.js` lines 137-157 | PreToolUse Write/Edit scanner for `API_KEY=|SECRET_KEY=|PRIVATE_KEY=|PASSWORD=` | Adding similar content-filtering hooks |
| Destructive command guard | `scripts/forge-hook.js` lines 104-134 | blocks `git commit --no-verify`, `git push --force`, `rm -rf .gsd` | Adding Bash guards for dangerous operations |
| Error classifier (shipped) | `scripts/forge-classify-error.js` | `classifyError(msg, retryAfterMs?) → {kind, retry, backoffMs?}`, `isTransient(result) → boolean` + CLI `--msg "..."` / stdin | Classifying Agent() exceptions; CLI dual-mode block (lines 111-143) is the canonical template for new scripts |
| Retry Handler (shipped) | `shared/forge-dispatch.md` lines 289–446 | Try/catch wrapper around `Agent()` + classifier shell-out + exponential backoff (2s/4s/8s) + events.jsonl `event:"retry"` append | S01 wraps every Agent() dispatch; do NOT wrap verify.js CLI invocations. Structural template for future control-flow sections (Token Telemetry, etc). |
| Verify gate (shipped) | `scripts/forge-verify.js` | `discoverCommands`, `runVerificationGate`, `formatFailureContext`, `isLikelyCommand` + CLI `--plan --cwd --unit --preference --timeout --from-verify` | Running per-task/per-slice verification; reference for frontmatter parsing, spawnSync cross-platform dispatch, events.jsonl append contract |
| Cross-platform shell dispatch | `scripts/forge-verify.js` lines 321–330 | `process.platform === "win32" ? spawnSync("cmd", ["/c", cmd], opts) : spawnSync("sh", ["-c", cmd], opts)`; `shell: false` | Any Forge script that shells out commands drawn from config/prefs/frontmatter. Do NOT use `shell: true` for new code. |
| YAML frontmatter key-extract (regex) | `scripts/forge-verify.js` lines 420–466 | `/^---\n([\s\S]*?)\n---/` extract → `/^key:\s*(.+)$/m` single-key match → inline array OR multiline-dash parse; 1 MB file size cap before regex | Reading one known frontmatter key from `.md` files without a YAML parser. Accepts string form, inline array (`[a, b]`), indented dash array. Rejects block scalars (`|` / `>`). |
| Token counter + boundary truncation (S03 target) | `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/token-counter.js` + `context-budget.js` | `countTokens(text) → Math.ceil(text.length/4)`; `truncateAtSectionBoundary(content, budgetChars) → {content, droppedSections}` via `/^(?=### |\-{3,}\s*$)/m` greedy-keep-sections algorithm | S03 ports to `scripts/forge-tokens.js` as CommonJS. Extend regex to include `## ` (H2) and `***` (alt HR). Add `mandatory: true` flag that throws on overflow instead of truncating. |

---

## Pattern Catalog — Recurring Structures

| Pattern | When to Use | Files to Create | Key Steps |
|---------|-------------|-----------------|-----------|
| Node CLI + module dual-mode | Deterministic logic the orchestrator needs to invoke from Markdown | `scripts/forge-<topic>.js` | 1. CommonJS header + shebang. 2. Export functions via `module.exports`. 3. At bottom, detect `require.main === module`; if CLI, parse `process.argv` for flags or read stdin, `console.log(JSON.stringify(result))`. 4. Wrap top-level in try/catch — exit 0 on logical errors, exit 2 on parse errors, throw on I/O errors to propagate. |
| Skill frontmatter + body | New reusable capability invoked via `Skill()` | `skills/forge-<name>/SKILL.md` | 1. YAML frontmatter with `name`, `description`, `disable-model-invocation: true` (MEM004), `allowed-tools`. 2. `<objective>`, `<essential_principles>`, `<process>` XML-ish sections. 3. Auto-sufficient — read args and disk state; don't rely on injected context. |
| Command shim to skill | Thin entry-point wrapper preserving `$ARGUMENTS` | `commands/forge-<name>.md` | 1. 6-7 lines. 2. Frontmatter with `description`, `allowed-tools`. 3. Body: `Skill({skill:"forge-<name>", args:"$ARGUMENTS"})`. 4. Must forward args via `args` key (MEM017) — skills never see `$ARGUMENTS` directly. |
| Dispatch template (shared) | New worker prompt shape used by both forge-auto and forge-next | Section in `shared/forge-dispatch.md` | 1. Fenced code block with placeholder substitution directives (MEM011). 2. `Read and follow:` for mandatory artifacts (MEM009), `Read if exists:` for optional. 3. Absolute paths via `{WORKING_DIR}/.gsd/...` (MEM010). 4. End with `Return ---GSD-WORKER-RESULT---.`. |
| Dispatch control-flow section | New cross-cutting concern that wraps every `Agent()` call (Retry Handler, Token Telemetry, Verification Gate) | `shared/forge-dispatch.md` new `### <Name>` section after prior sibling control-flow sections | 1. Heading + Purpose paragraph. 2. Cross-reference pull-quote linking to the CLI or module. 3. When to apply bullet. 4. Algorithm numbered steps. 5. Event log format fenced JSON. 6. Prefs contract table or paragraph. 7. Worked examples (2–3). 8. Wiring snippet. Place AFTER the data-flow templates, sibling to existing control-flow sections. Template: `### Retry Handler` (lines 289–446). |
| events.jsonl append | Emit orchestrator telemetry after significant action | N/A — append to `.gsd/forge/events.jsonl` | 1. `mkdirSync(recursive:true)` on `.gsd/forge/` first (canonical: `scripts/forge-verify.js` line 480). 2. `JSON.stringify(event) + '\n'` single line. 3. `appendFileSync(path, line, 'utf-8')` — NO try/catch; I/O errors propagate (telemetry is not silent-fail). 4. Discriminate event types via `event:` field: `"retry"` (S01), `"verify"` (S02), `"dispatch"` (S03). Legacy lines have no `event:` field — readers must handle both. |
| auto-mode.json heartbeat | Long-running orchestrator loops must update liveness | N/A — overwrite `.gsd/forge/auto-mode.json` | 1. Read `auto-mode-started.txt` for persistent `started_at`. 2. On each dispatch: write `{active, started_at, last_heartbeat, worker, worker_started}`. 3. Clear `worker: null` after Agent() returns. 4. Statusline uses `last_heartbeat` (not `started_at`) for stale detection. |
| Hook script lifecycle | Intercept PreToolUse/PostToolUse/SubagentStart/SubagentStop/PreCompact/PostCompact | `scripts/forge-hook.js` (extend) | 1. Read `process.argv[2]` for phase. 2. Read stdin as JSON. 3. Dispatch by phase. 4. Wrap everything in try/catch; silent fail (MEM008). 5. Register in `merge-settings.js` LIFECYCLE_HOOKS or TOOL_HOOKS table. |
| Risk/Security gate skill | Checklist generated pre-dispatch for sensitive scopes | `skills/forge-<gate-name>/SKILL.md` | 1. Skill reads plan + roadmap from disk. 2. Produces `<ARTIFACT>.md` with risk card / checklist. 3. Orchestrator invokes via `Skill({skill, args:"{M###} {S##} [{T##}]"})` before dispatching the executor. 4. Checklist injected into executor prompt as `## Security Checklist` / `## Risk Assessment`. |
| Budgeted section injection | Gate the size of an optional placeholder in a dispatch template (prevents ballooning prompts from AUTO-MEMORY / LEDGER / CODING-STANDARDS) | `shared/forge-dispatch.md` new `#### Budgeted Section Injection` subsection within Token Telemetry | 1. Read raw content. 2. Call `truncateAtSectionBoundary(content, PREFS.token_budget.<key> * 4)` (heuristic: 1 token ≈ 4 chars). 3. Inject truncated string into the template placeholder. 4. Mandatory placeholders (T##-PLAN, S##-CONTEXT, M###-SCOPE) call with `{mandatory: true, label}` — the function throws on overflow; the orchestrator surfaces as `scope_exceeded` blocker. 5. Prefs block `token_budget:` ships defaults; handler falls back to defaults when block missing. |

---

## Code Rules

*(User-written rules — preserve across updates.)*

- Never edit `install.ps1` with strings containing `\f` — PowerShell interprets `\f` as form feed (0x0C). Use hex escapes or verify bytes after edit.
- Workers (agents) NEVER access the `Agent` tool — only the orchestrator (commands/skills that run in main context) can dispatch subagents.
- `STATE.md` is the single source of truth — only the orchestrator and `forge-completer` should ever write to it.
- `DECISIONS.md` is append-only — never edit existing lines. Per-phase decisions live in `CONTEXT.md` files.
- Testing the installers: dry-run before changing copy logic.
- Worker return contract: every worker must emit a `---GSD-WORKER-RESULT---` block with `status` + key fields.

---

## Forge Auto-Rules

*(Auto-promoted from AUTO-MEMORY.md when confidence ≥ 0.85 and hits ≥ 3. Mirrored in CLAUDE.md.)*

- [MEM001] PostCompact recovery handler must write `compact-signal.json` AFTER compaction completes, not before.
- [MEM004] All forge-* skills use `disable-model-invocation: true` to prevent skill description injection.
- [MEM005] Gradual skill migration: move commands to `skills/` with thin shims (6–7 lines), not big-bang refactoring. Shims pass `$ARGUMENTS` via `Skill({skill, args:"$ARGUMENTS"})`.
- [MEM011] Dispatch templates use placeholder substitution (Read-path directives) instead of inline artifact-reading logic. Templates are thin data-flow descriptors; workers handle all read I/O.
