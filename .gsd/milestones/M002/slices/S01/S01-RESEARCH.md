# S01: Error classifier + retry integration — Research

**Researched:** 2026-04-16
**Domain:** Orchestrator resilience — transient provider error classification + exponential backoff
**Confidence:** HIGH

## Summary

The reference implementation at `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js` is a clean 108-line ES module with six regex groups (`PERMANENT_RE`, `RATE_LIMIT_RE`, `NETWORK_RE`, `SERVER_RE`, `CONNECTION_RE`, `STREAM_RE`) evaluated in a fixed precedence order. **Port it 1:1** — the regexes already encode battle-tested pattern signatures from Node.js, Anthropic SDK errors (429, 529, overloaded), and V8 JSON parse failures. The only adjustments needed for a Node CLI: convert `export`/`import` to CommonJS `module.exports` (Forge's three scripts — `forge-hook.js`, `forge-statusline.js`, `merge-settings.js` — are all CommonJS with shebangs and no `package.json`), strip TypeScript type annotations (already done — this is a `.js` file), and add a small CLI wrapper that reads `--msg` or stdin and `console.log(JSON.stringify(result))`.

The retry handler lives in **Markdown prose** inside `shared/forge-dispatch.md` (per MEM032 and M002-CONTEXT "Hybrid C"). This is deliberate — the orchestrator runs as Claude-in-the-loop, not as a Node process, so the handler cannot be a JS function. It's an instruction block the orchestrator follows: `try { Agent() } catch (e) { shell out to forge-classify-error.js --msg "${e}"; parse JSON; apply per-class backoff; append events.jsonl line; retry or surface }`. The forge-auto skill's "CRITICAL — Agent() dispatch failure" block (lines 251-258) currently **hard-stops** on any Agent() throw — S01 replaces that behavior for transient classes while preserving the hard-stop for `permanent`/`unknown`.

Structural gotchas to respect: **MEM015** (forge-next and forge-auto diverge at Step 3 — must patch both independently), **MEM017** ($ARGUMENTS is command-only; skills receive args via `Skill({args})`), and the existing `auto-mode.json` / `events.jsonl` contracts (single-line JSON, `ts` in ISO8601, `unit`/`agent`/`milestone`/`status`/`summary` fields — add `class`/`attempt`/`backoff_ms` for retry events without breaking the parser).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Regex taxonomy for provider errors | New patterns from scratch | Port 6 regexes verbatim from `error-classifier.js` (PERMANENT_RE, RATE_LIMIT_RE, NETWORK_RE, SERVER_RE, CONNECTION_RE, STREAM_RE) | Already covers 429/529, ECONNRESET/ETIMEDOUT, Anthropic overloaded_error, V8 JSON parse truncation — debugged through 2577 + 3588 + 2922 upstream issues |
| Rate-limit delay parsing | Parse `retry-after` headers yourself | `RESET_DELAY_RE = /reset in (\d+)s/i` from reference, fallback 60s | GSD-2 already handles the textual "reset in Ns" variant Anthropic emits |
| Retry state tracking | New class/singleton | `createRetryState()` pattern from reference (plain object: `{networkRetryCount, consecutiveTransientCount, currentRetryModelId}`) | Simple; function-local state; resets on success |
| Exponential backoff math | npm `exponential-backoff`, `p-retry`, `async-retry` | Inline `baseMs * 2 ** (attempt - 1)` with Math.min cap | M002-CONTEXT mandates zero new npm deps; base/cap are the only 2 numbers needed |
| Shell-out JSON output | Custom protocol | `console.log(JSON.stringify(result))` + exit 0 always | MEM036 already locked — "errors are data, not process failures" |
| Per-event log format | New format | `events.jsonl` contract (`.gsd/forge/events.jsonl`, one JSON per line, existing fields `ts/unit/agent/milestone/status/summary`) | All orchestrator consumers already parse it; just add optional fields |
| Hook/signal plumbing for recovery | Second signal file | Existing `compact-signal.json` mechanism in `forge-hook.js post-compact` | Retry is in-memory, doesn't cross compaction; only transient-exhaustion needs a durable signal (and it should just stop the loop like existing blockers) |

## Common Pitfalls

### Pitfall 1: Agent() exception text may be opaque
**What goes wrong:** The orchestrator's catch path receives only what the Agent tool raises. If the Claude Code runtime wraps provider errors in a generic "subagent failed" string without the underlying 429/503/ECONNRESET text, the regex classifier can't distinguish transient from permanent.
**Why it happens:** Agent() is a tool, not a raw SDK call. The exception surface is controlled by Claude Code's subagent dispatcher, not by Anthropic's SDK directly.
**How to avoid:** This is exactly why T01 is a hard gate (MEM033). Force a mock transient (e.g., invoke Agent with an unreachable endpoint or a guaranteed-throw input) inside the auto-mode loop and capture the exact string the catch path sees. If the string only says "subagent failed" with no keywords matching any of the 6 regex groups, **abort S01 and escalate** — classifier cannot function without substrate visibility. Do not paper over with heuristics.

### Pitfall 2: "CRITICAL — Agent() dispatch failure" block hard-stops auto-mode
**What goes wrong:** Current `skills/forge-auto/SKILL.md` lines 251-258 writes `{"active":false}` to `auto-mode.json` on any Agent() throw. Unmodified, the retry handler would never get to run — auto-mode deactivates before classification.
**Why it happens:** The rule was added after a bug where Claude improvised inline execution when Agent() failed, violating context isolation. It over-corrected by stopping on all throws.
**How to avoid:** T04 must **replace** that block with the retry handler flow: on throw → classify → if transient and under retry cap, `Sleep`/wait + re-dispatch; if permanent/unknown/exhausted, THEN hard-stop with the existing message. Do not delete the inline-execution prohibition — keep it as a separate post-classification guard.

### Pitfall 3: Sleep/wait mechanics in Claude Code
**What goes wrong:** The orchestrator is a Claude model-in-the-loop, not a Node process. There is no `setTimeout` available. A naive "wait 4 seconds" between retries has no primitive.
**Why it happens:** Auto-mode runs in a conversational context; Bash is available but `sleep 4` blocks the tool call.
**How to avoid:** Use `Bash("sleep Ns")` (or `ping -n N localhost` on Windows) with a short timeout. Keep backoff values modest (2s/4s/8s per M002-CONTEXT, max 3 attempts per MEM035) — longer waits risk hitting Claude Code's internal tool-call timeout. Alternative: omit explicit sleep, rely on re-dispatch latency (provider will either be ready or 429 again); this is what GSD-2 does via `setTimeout + sendMessage`.

### Pitfall 4: Multi-locale error strings
**What goes wrong:** `cmd.exe`, PowerShell, and bash emit `ECONNRESET`/`connection reset` in different languages when the OS locale is non-English (e.g., German Windows: "Die vorhandene Verbindung wurde vom Remotehost geschlossen").
**Why it happens:** OS-level network errors localize via MUI packs on Windows; libc strerror() also localizes.
**How to avoid:** GSD-2 regexes already match on both the **code strings** (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EPIPE`) and the **English phrases** (`socket hang up`, `connection refused`). The code strings are locale-invariant and node emits them even in localized environments. Accept that localized phrase variants will fall through to `unknown` — that's a safe default (stop loop, tell user). Do NOT try to enumerate every locale.

### Pitfall 5: `retry-after` field vs `retry-after` header
**What goes wrong:** Anthropic emits 429s with both a numeric header and a textual "reset in Ns" body field. The SDK bubbles these up inconsistently. If the classifier reads only the string, it misses header values; if it reads only the header, it misses the text-body variant.
**Why it happens:** Dual encoding in the API response.
**How to avoid:** Reference already handles both — `classifyError(msg, retryAfterMs?)` takes an optional override from the caller. CLI should expose `--retry-after-ms N` and the retry handler can peek at the Agent() exception for a structured retry-after field before shelling out.

### Pitfall 6: Heartbeat and auto-mode.json during retries
**What goes wrong:** Retries are long-running (2s + 4s + 8s = up to 14s + worker time), and the statusline stale check uses `last_heartbeat > 5 min` to auto-deactivate. If you don't update heartbeat between retry attempts, short-session statuslines might flicker, but no correctness bug.
**Why it happens:** Only heartbeats before and after Agent() call, not during wait.
**How to avoid:** 14s of backoff is well under the 5min stale threshold — no mitigation needed. Just don't introduce a retry cap > 5 min total wait.

### Pitfall 7: events.jsonl schema evolution
**What goes wrong:** Existing events have `ts/unit/agent/milestone/status/summary`. Retry events need `class/attempt/backoff_ms`. If a parser expects only the original fields, new lines crash it.
**Why it happens:** JSONL files are append-only but downstream consumers may be strict.
**How to avoid:** Use a distinct `event: "retry"` marker (already in S01-PLAN). Parsers already tolerate unknown fields (grep-based workflow); `/forge-status` reads only the common fields. Safe to extend.

### Pitfall 8: Regex precedence order matters
**What goes wrong:** PERMANENT_RE contains "quota exceeded" which could match rate-limit-adjacent text; NETWORK_RE contains "connection.*reset" which also matches CONNECTION_RE's "connection.?refused".
**Why it happens:** Overlapping vocabularies.
**How to avoid:** Reference already fixes this: evaluate in the documented order (permanent-except-rate-limit → rate-limit → network → stream → server → connection → unknown). Do NOT reorder. Reference has explicit comment "// ECONNRESET/ECONNREFUSED are in NETWORK_RE (same-model retry first)" — preserve that allocation.

## Relevant Code

### Reference implementation (source of truth for port)
- **`C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js`** (108 lines) — six regex groups, `classifyError()`, `isTransient()`, `createRetryState()`, `resetRetryState()`
- **`C:/Users/VINICIUS/.gsd/agent/extensions/gsd/bootstrap/agent-end-recovery.js`** (208 lines) — full retry loop integration: same-model retry for network (MAX_NETWORK_RETRIES=2), model fallback chain, `pauseAutoForProviderError` with `MAX_TRANSIENT_AUTO_RESUMES=3`, exponential backoff `baseRetryAfterMs * 2 ** (count-1)`
- **`C:/Users/VINICIUS/.gsd/agent/extensions/gsd/provider-error-pause.js`** (32 lines) — `setTimeout` + `options.resume()` pattern (Forge replaces with Bash sleep + re-dispatch)

### Forge integration targets (edit in S01)
- **`C:/DEV/forge-agent/skills/forge-auto/SKILL.md`**
  - lines 192-258: Step 4 Dispatch — `Agent()` call and CRITICAL failure block (wrap this)
  - line 84-94: COMPACTION RESILIENCE block (retry loop must not trigger compact signal)
  - line 294-337: Step 6 Post-unit housekeeping — where `events.jsonl` is appended (reuse format)
- **`C:/DEV/forge-agent/skills/forge-next/SKILL.md`**
  - lines 147-172: Step 4 Dispatch (no CRITICAL block — forge-next doesn't hard-stop; its blocker table at lines 183-192 surfaces class messages but doesn't retry)
  - lines 123-130: selective memory injection (MEM015 — unique to forge-next; preserve)
- **`C:/DEV/forge-agent/shared/forge-dispatch.md`** (280 lines, 7 templates) — add new **`### Retry Handler`** section after line 279 (after `research-*` template), referenced from the two dispatch sites above
- **`C:/DEV/forge-agent/forge-agent-prefs.md`** lines 110-117 (Auto-mode Settings block) — add new `retry:` block nearby (e.g., after `compact_after:`)

### Scripts directory conventions (anchor for new file)
- **`C:/DEV/forge-agent/scripts/forge-hook.js`** (208 lines) — CommonJS (`const fs = require('fs')`), shebang `#!/usr/bin/env node`, single-file, try/catch swallows all errors (MEM008), reads stdin via `process.stdin.on('data'/'end')`, writes to tmpdir or `.gsd/forge/`
- **`C:/DEV/forge-agent/scripts/forge-statusline.js`** (289 lines) — same conventions; uses `execSync` with `shell: true, timeout: N`
- **`C:/DEV/forge-agent/scripts/merge-settings.js`** (216 lines) — arg parsing via `process.argv.includes('--flag')` and `process.argv.indexOf('--flag')`, clean `Usage:` help on stderr, `process.exit(N)` for distinct failure modes

### Event log format (existing contract)
From `events.jsonl` (read `tail -30` in bash):
```json
{"ts":"2026-04-16T18:38:09Z","unit":"plan-slice/S01","agent":"forge-planner","milestone":"M002","status":"done","summary":"..."}
```
Per S01-PLAN, retry entries extend this to:
```json
{"ts":"...","event":"retry","unit":"execute-task/T03","class":"rate_limit","attempt":2,"backoff_ms":4000}
```

## Asset Map — Reusable Code

| Asset | Path | Exports | Use When |
|-------|------|---------|----------|
| classifyError (reference) | `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js` | `classifyError`, `isTransient`, `createRetryState`, `resetRetryState`, `isTransientNetworkError` | Port 1:1 to `scripts/forge-classify-error.js` — regexes are source of truth |
| stdin reader pattern | `scripts/forge-hook.js` lines 19-24 | idiom: `process.stdin.setEncoding('utf8'); let raw=''; on('data' append) on('end' parse)` | Classifier CLI stdin mode |
| safe try/catch-everything wrapper | `scripts/forge-hook.js` line 24-206 | entire handler wrapped; `catch {}` swallows | Hook/CLI must never crash |
| argv flag parser | `scripts/merge-settings.js` lines 15-17 | `process.argv.includes('--flag')` + `indexOf` for value lookup | Classifier CLI `--msg`/`--retry-after-ms` parsing |
| execSync with timeout | `scripts/forge-statusline.js` line 161-164 | `execSync(cmd, {cwd, encoding:'utf8', timeout:2000, shell:true})` | Not needed by classifier (pure); reference only |
| events.jsonl append pattern | `skills/forge-auto/SKILL.md` lines 295-299 | one-line JSON; `ts` ISO8601; fields `unit/agent/milestone/status/summary` | Retry handler append |
| auto-mode.json contract | `skills/forge-auto/SKILL.md` lines 78-82, 233-236 | `{active, started_at, last_heartbeat, worker, worker_started}` | Heartbeat during retries (if >5s wait) |
| Skill invocation pattern | `skills/forge-auto/SKILL.md` lines 156-159, 166-168 | `Skill({ skill: "forge-X", args: "..." })` | If classifier is ever re-exposed as a skill (not needed for S01) |
| CommonJS module pattern | `scripts/*.js` all | `const x = require('y'); module.exports = {...}` | Classifier module form for require() |
| Dual-mode CLI (module + CLI) | `scripts/merge-settings.js` lines 13-24 | if top-level args → run CLI; else expose functions | Classifier dual-mode |
| Risk card output format | `skills/forge-risk-radar/SKILL.md` | markdown `# Risk Radar: S##` | Reference for artifact style (not reused directly) |
| Retry state reset on success | `bootstrap/agent-end-recovery.js` line 194 `resetRetryState(retryState)` | Reset counters when Agent() returns clean | Retry handler success branch |
| Per-class backoff override for CLI providers | `bootstrap/agent-end-recovery.js` lines 102-107 | cap rate-limit to 30s for codex/gemini-cli | Reference only — Forge is Claude-only; skip |

## Coding Conventions Detected

- **File naming:** `forge-<verb>.js` for scripts (`forge-hook`, `forge-statusline`, `forge-classify-error`); `forge-<topic>.md` for shared docs (`forge-dispatch.md`, `forge-mcps.md`); `forge-<name>/SKILL.md` for skills; `forge-<name>.md` for commands/agents
- **Script format:** Node.js CommonJS. Shebang `#!/usr/bin/env node`. Single-file with no `package.json`. `require()`-based, `module.exports = {...}` at bottom. Never ES modules in `scripts/` (ESM is used in the GSD-2 reference but Forge deliberately uses CommonJS for maximum Node version compat).
- **Function naming:** camelCase (`classifyError`, `mergeToolHook`, `getAutoDashboardData`). Constants UPPER_SNAKE (`PERMANENT_RE`, `MAX_NETWORK_RETRIES`, `FORGE_HOOK_MARKER`).
- **Directory structure:**
  - `scripts/` — executable Node helpers (CLI + module dual-mode where applicable)
  - `shared/` — `.md` reference docs consumed by multiple skills/commands
  - `skills/<name>/SKILL.md` — skill body with YAML frontmatter
  - `commands/<name>.md` — slash commands, often 6-7 line shims to skills
  - `agents/forge-*.md` — subagent definitions (used by Agent tool)
  - `.gsd/` — runtime state (STATE.md, DECISIONS.md, AUTO-MEMORY.md, LEDGER.md, forge/events.jsonl, milestones/, forge/auto-mode.json)
- **Import style:** CommonJS (`const fs = require('fs')`, `const path = require('path')`, `const os = require('os')`) — top-level requires, no lazy imports except `execSync` pulled in conditionally at line 160 of forge-statusline.js
- **Error patterns:**
  - Scripts wrap the entire handler in try/catch and swallow errors silently (MEM008). Hooks MUST NOT crash Claude Code.
  - Classifier: "errors are data, not process failures" (MEM036) — exit 0 always, emit `{kind:"unknown"}` on parse failure.
  - Skills emit structured `---GSD-WORKER-RESULT---` blocks with `status: done|partial|blocked`.
  - Orchestrator distinguishes 6 blocker classes (`context_overflow`, `scope_exceeded`, `model_refusal`, `tooling_failure`, `external_dependency`, `unknown`). S01 introduces 5 retry classes orthogonal to this — retry classes trigger BEFORE blocker classification.
- **Test patterns:** None in the Forge codebase. Reference has `tests/*.test.mjs` but Forge is a shell + prompt project with UAT scripts (`S##-UAT.md`) instead. S01 validates via demo transcripts in S01-SUMMARY.md (per AC 6).
- **Frontmatter conventions:**
  - Agents: `name, description, model, effort, tools` (e.g., `model: claude-sonnet-4-6`, `effort: low`, `tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch`)
  - Commands: `description`, `allowed-tools` (comma-separated)
  - Skills: `name, description, disable-model-invocation: true, allowed-tools`
- **Message language:** pt-BR for user-facing strings (`"Falha ao despachar subagente..."`, `"Retomando forge-auto após interrupção..."`); English for code, comments, agent frontmatter, commit messages (Conventional Commits — `feat:`, `fix:`, `refactor:`)
- **Path handling:** Use forward slashes in markdown (`{WORKING_DIR}/.gsd/...`). Node scripts use `path.join` for cross-platform. Bash snippets use Unix syntax (`/dev/null` not `NUL`, forward slashes) per environment notes.

## Pattern Catalog — Recurring Structures

| Pattern | When to Use | Files to Create | Key Steps |
|---------|-------------|-----------------|-----------|
| Node CLI + module dual-mode | Deterministic logic the orchestrator needs to invoke from Markdown | `scripts/forge-<topic>.js` | 1. CommonJS header + shebang. 2. Export functions via `module.exports`. 3. At bottom, detect `require.main === module`; if CLI, parse `process.argv` for flags or read stdin, `console.log(JSON.stringify(result))`. 4. Wrap top-level in try/catch — exit 0 on logical errors, emit data. |
| Skill frontmatter + body | New reusable capability invoked via `Skill()` | `skills/forge-<name>/SKILL.md` | 1. YAML frontmatter with `name`, `description`, `disable-model-invocation: true` (MEM004), `allowed-tools`. 2. `<objective>`, `<essential_principles>`, `<process>` XML-ish sections (see forge-risk-radar for template). 3. Auto-sufficient — read args and disk state; don't rely on injected context. |
| Command shim to skill | Thin entry-point wrapper preserving `$ARGUMENTS` | `commands/forge-<name>.md` | 1. 6-7 lines. 2. Frontmatter with `description`, `allowed-tools`. 3. Body: `Skill({skill:"forge-<name>", args:"$ARGUMENTS"})`. 4. Body must forward args via `args` key (MEM017) — skills never see `$ARGUMENTS` directly. |
| Dispatch template (shared) | New worker prompt shape used by both forge-auto and forge-next | Section in `shared/forge-dispatch.md` | 1. Fenced code block with placeholder substitution directives (MEM011). 2. `Read and follow:` for mandatory artifacts (MEM009), `Read if exists:` for optional. 3. Absolute paths via `{WORKING_DIR}/.gsd/...` (MEM010). 4. End with `Return ---GSD-WORKER-RESULT---.`. |
| events.jsonl append | Emit orchestrator telemetry after significant action | N/A — append to `.gsd/forge/events.jsonl` | 1. `mkdir -p .gsd/forge/` first. 2. One-line JSON with `ts` (ISO8601), `unit`, `agent`, `milestone`, `status`, `summary`. 3. Extend with optional fields for new event types (`event:"retry"` adds `class/attempt/backoff_ms`). 4. Never rewrite existing lines. |
| auto-mode.json heartbeat | Long-running orchestrator loops must update liveness | N/A — overwrite `.gsd/forge/auto-mode.json` | 1. Read `auto-mode-started.txt` for persistent `started_at`. 2. On each dispatch: write `{active, started_at, last_heartbeat, worker, worker_started}`. 3. Clear `worker: null` after Agent() returns. 4. Statusline uses `last_heartbeat` (not `started_at`) for stale detection. |
| Hook script lifecycle | Intercept PreToolUse/PostToolUse/SubagentStart/SubagentStop/PreCompact/PostCompact | `scripts/forge-hook.js` (extend) | 1. Read `process.argv[2]` for phase. 2. Read stdin as JSON. 3. Dispatch by phase. 4. Wrap everything in try/catch; silent fail (MEM008). 5. Register in `merge-settings.js` LIFECYCLE_HOOKS or TOOL_HOOKS table. |

## Security Considerations

S01 is pure infrastructure (regex classification + orchestrator dispatch) — no auth, no crypto, no user input beyond developer-provided error strings, no secrets handled. **One low-risk note:** the classifier's CLI reads `--msg "..."` or stdin containing error text that may include API URLs or auth headers in the error body. Do not log that text to durable logs (`events.jsonl` entries for retries should include only `class`, not the raw error body). The forge-hook.js secret-blocking pattern at lines 137-157 is instructive — similar care applies here: if the retry handler ever emits the raw error to events.jsonl for debug, scan for `API_KEY=|SECRET_KEY=|PRIVATE_KEY=|PASSWORD=` and redact.

| Concern | Risk Level | Recommended Mitigation |
|---------|------------|------------------------|
| Raw error text in events.jsonl could leak tokens | LOW | Log only `class`/`attempt`/`backoff_ms` in retry events; never echo the full exception body. If needed for debugging, truncate to first 80 chars and strip obvious secret prefixes. |

## Sources

- File read: `C:/DEV/forge-agent/.gsd/milestones/M002/slices/S01/S01-PLAN.md` — 5 tasks, hard gate on T01, AC includes demo transcripts
- File read: `C:/DEV/forge-agent/.gsd/milestones/M002/M002-CONTEXT.md` — Hybrid C decision, max 3 retries, backoff 2s/4s/8s, per-class policy
- File read: `C:/DEV/forge-agent/.gsd/milestones/M002/M002-ROADMAP.md` — S01 boundary map confirms `scripts/forge-classify-error.js` is the target name
- File read: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js` — 108-line reference, source of truth for regexes
- File read: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/bootstrap/agent-end-recovery.js` — 208-line integration showing retry state, same-model retry caps, model fallback chain, pauseTransientWithBackoff
- File read: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/provider-error-pause.js` — 32-line pause+auto-resume helper; Forge replaces with Bash sleep
- File read: `C:/DEV/forge-agent/skills/forge-auto/SKILL.md` — full 423 lines; lines 251-258 are the CRITICAL block to be replaced by retry handler
- File read: `C:/DEV/forge-agent/skills/forge-next/SKILL.md` — full 281 lines; MEM015 divergence confirmed at lines 123-130 (selective memory injection) and lines 147-172 (no CRITICAL block; different blocker table at 183-192)
- File read: `C:/DEV/forge-agent/shared/forge-dispatch.md` — 7 templates, 280 lines; Retry Handler section appends cleanly after research-* at line 279
- File read: `C:/DEV/forge-agent/scripts/forge-hook.js` — CommonJS conventions, stdin reading, try/catch wrap, secret-blocking pattern at 137-157
- File read: `C:/DEV/forge-agent/scripts/forge-statusline.js` — CommonJS, execSync with timeout, cache file pattern
- File read: `C:/DEV/forge-agent/scripts/merge-settings.js` — argv flag parsing, usage-line convention, idempotent writes
- File read: `C:/DEV/forge-agent/forge-agent-prefs.md` — prefs block structure; `retry:` block will slot near Auto-mode Settings (line 110)
- File read: `C:/DEV/forge-agent/.gsd/forge/events.jsonl` — confirmed field contract (`ts/unit/agent/milestone/status/summary`); additional fields (`key_decisions`, `files_changed`) already in use without breaking parsers
- File read: `C:/DEV/forge-agent/.gsd/AUTO-MEMORY.md` — MEM031, MEM032, MEM033 lock S01 patterns; MEM034, MEM035, MEM036 confirm taxonomy/prefs/CLI contract
- Web search: `Node.js zero-dependency exponential backoff retry pattern 2025 best practices` → zero-dep inline `baseMs * 2 ** (n-1)` + jitter + cap is standard; avoid npm deps per M002 decision (confidence: HIGH)
- Web search: `Anthropic SDK API error codes 429 529 overloaded rate limit retry-after header signatures` → 429 = rate_limit_error (always emits `retry-after` header), 529 = overloaded_error (use simple 2-5s retry); reference `SERVER_RE` already matches `overloaded|503|500|502|service.?unavailable` (confidence: HIGH)
- Web search: `Node.js ECONNRESET ETIMEDOUT socket hang up error classification regex robustness` → code strings (ECONNRESET/ETIMEDOUT/ECONNREFUSED/EPIPE) are locale-invariant; English phrases (`socket hang up`, `connection refused`) cover default Node emissions; localized OS messages fall through to `unknown` safely (confidence: HIGH)
