# Forge Dispatch — Shared Worker Prompt Templates

Single source of truth for all worker prompt templates used by `/forge-auto` and `/forge-next`.
**Changes here apply to both commands. Do not duplicate these templates in individual commands.**

---

### execute-task

```
Execute GSD task {T##} in slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {PREFS.auto_commit — true or false}
effort: {unit_effort}
thinking: disabled

## Task Plan

Read and follow: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md

## Slice Plan

Read: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md

## Lint & Format Commands
{CS_LINT}

## Prior Context

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md

## Security Checklist

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-SECURITY.md

## Slice Decisions

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md — extract ## Decisions section only

## Project Memory
{TOP_MEMORIES}

## Instructions
Execute all steps. The task plan's ## Standards section has the relevant coding rules — follow them.
If ## Security Checklist is present — treat each item as a must-have. Verify all checklist items before writing T##-SUMMARY.md.
Verify every must-have using the verification ladder — including lint/format check.
Run verification gate: node scripts/forge-verify.js --plan "{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md" --cwd "{WORKING_DIR}" --unit execute-task/{T##}
If exit code != 0 and not skipped → include formatFailureContext output as ## Verification Failures in retry prompt, return partial. Do NOT write T##-SUMMARY.md.
If exit code == 0 or skipped → continue to summary.
Write T##-SUMMARY.md.
If auto_commit is true: Commit with message feat(S##/T##): <one-liner>.
If auto_commit is false: Do NOT run any git commands.
Do NOT modify STATE.md. Return ---GSD-WORKER-RESULT---.
```

### plan-slice

```
Plan GSD slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}
effort: {unit_effort}
thinking: {THINKING_OPUS}

## Risk Assessment

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-RISK.md

## Roadmap Entry + Boundary Map

Read: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md — focus on {S##} entry and Boundary Map

## Milestone Context

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md

## Slice Context

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md

## Milestone Research

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-RESEARCH.md

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Code Rules
{CS_RULES}

## Dependency Slice Summaries

Read if exists (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/{dep}/{dep}-SUMMARY.md — for each slice listed in depends:[] in the Roadmap entry

## Project Memory
{TOP_MEMORIES}

## Instructions
Write S##-PLAN.md and individual T##-PLAN.md files (1-7 tasks).
Each T##-PLAN.md must include a ## Standards section with relevant rules from CODING-STANDARDS.md.
Iron rule: each task must fit in one context window.
Return ---GSD-WORKER-RESULT---.
```

### plan-milestone

```
Plan GSD milestone {M###}: {description}.
WORKING_DIR: {WORKING_DIR}
effort: {unit_effort}
thinking: {THINKING_OPUS}

## Project

Read: {WORKING_DIR}/.gsd/PROJECT.md

## Requirements

Read: {WORKING_DIR}/.gsd/REQUIREMENTS.md

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Context (discuss decisions)

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md

## Brainstorm Output

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-BRAINSTORM.md

## Scope Contract

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SCOPE.md

## Project Memory
{TOP_MEMORIES}

## Instructions
Write M###-ROADMAP.md with 4-10 slices, risk tags, depends, demo sentences, and a Boundary Map section.
Respect directory conventions and reusable assets from Coding Standards when placing new code.
Return ---GSD-WORKER-RESULT---.
```

### complete-slice

```
Complete GSD slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {PREFS.auto_commit — true or false}

## Task Summaries

Read (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/T*/T*-SUMMARY.md

## Slice Plan

Read: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md

## Lint & Format Commands
{CS_LINT}

## Current Milestone Summary

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md

## Instructions
1. Write S##-SUMMARY.md (compress all task summaries)
2. Write S##-UAT.md (non-blocking human test script)
3. Run verification gate: node scripts/forge-verify.js --cwd "{WORKING_DIR}" --unit complete-slice/{S##}
   Record result in S##-SUMMARY.md ## Verification Gate section (commands, exit codes, discovery source, total duration).
   If exit code != 0 and not skipped:"no-stack" → stop, return blocked with blocker_class: tooling_failure.
4. Security scan — search changed files for risky patterns (eval, innerHTML, dangerouslySetInnerHTML, raw SQL concatenation, console.log near secrets, hardcoded credentials). If found, add ## ⚠ Security Flags to S##-SUMMARY.md. Not a blocker — document and continue.
5. Run lint gate — if lint commands exist, run on changed files. Fix violations.
If auto_commit is true:
6. Squash-merge branch gsd/M###/S## to main
If auto_commit is false:
6. Skip — do NOT run any git commands (no merge, no branch operations).
7. Update M###-SUMMARY.md with this slice's contribution
8. Mark slice [x] in M###-ROADMAP.md
Return ---GSD-WORKER-RESULT---.
```

### complete-milestone

```
Complete GSD milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {PREFS.auto_commit — true or false}
milestone_cleanup: {PREFS.milestone_cleanup — keep, archive, or delete}

## Slice Summaries

Read (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/S*/S*-SUMMARY.md

## Milestone Roadmap

Read: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md

## Milestone Summary

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md

## Instructions
1. Write final M###-SUMMARY.md
2. Mark milestone as complete in STATE.md (do modify STATE.md for this)
If auto_commit is true:
3. Write final git tag or note
If auto_commit is false:
3. Skip — do NOT run any git commands.
Return ---GSD-WORKER-RESULT---.
```

### discuss-milestone / discuss-slice

```
Discuss {milestone M### | slice S##} architecture decisions.
WORKING_DIR: {WORKING_DIR}
effort: {unit_effort}
thinking: {THINKING_OPUS}

## Project

Read: {WORKING_DIR}/.gsd/PROJECT.md

## Requirements

Read if exists: {WORKING_DIR}/.gsd/REQUIREMENTS.md

## Brainstorm Output (if available)

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-BRAINSTORM.md

## Prior Decisions (do not re-debate)

For discuss-slice: Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md — extract ## Decisions section (locked milestone decisions, do not re-open)
For discuss-milestone: Read last 30 lines: {WORKING_DIR}/.gsd/DECISIONS.md — decisions from prior milestones only
Either way: these are closed — do not re-open or re-debate.

## Project Memory
{TOP_MEMORIES}

## Instructions
Identify 3-5 gray areas not yet resolved. Ask them ONE AT A TIME using AskUserQuestion — do NOT dump all questions in a single text block.
For each question, provide 2-4 concrete options derived from the project context. AskUserQuestion adds "Other" automatically — do not add it manually.
Wait for each answer before asking the next question.
Record all answers in M###-CONTEXT.md (or S##-CONTEXT.md for slice discuss).
Append significant decisions to .gsd/DECISIONS.md.
Return ---GSD-WORKER-RESULT---.
```

### research-milestone / research-slice

```
Research codebase for GSD {milestone M### | slice S##}: {description}.
WORKING_DIR: {WORKING_DIR}
effort: {unit_effort}
thinking: {THINKING_OPUS}

## What we're building

For research-milestone: Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md
For research-slice: Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md

## Project

Read: {WORKING_DIR}/.gsd/PROJECT.md

## Current Coding Standards

Read if exists: {WORKING_DIR}/.gsd/CODING-STANDARDS.md

## Project Memory (known gotchas)
{TOP_MEMORIES}

## Instructions
Explore the codebase. Produce M###-RESEARCH.md (or S##-RESEARCH.md) with:
- Summary
- Don't Hand-Roll table (what libraries/patterns exist already)
- Common Pitfalls found
- Relevant Code sections
- Asset Map — Reusable Code (functions, hooks, services to reuse)
- Coding Conventions Detected (naming, structure, imports, error patterns)
After writing RESEARCH.md, update .gsd/CODING-STANDARDS.md with new findings (Asset Map, conventions).
Return ---GSD-WORKER-RESULT---.
```

---

### Retry Handler

**Purpose:** Control-flow utility invoked after any `Agent()` call throws. Classifies the exception, decides whether to retry (transient) or bail (permanent/unknown), applies backoff, and appends a structured event to `events.jsonl`. This section is intentionally separate from the data-flow templates above (MEM011 — retries are control flow, not data flow).

> **Cross-reference:** Classifier CLI — `node scripts/forge-classify-error.js --msg "$errorMsg"`.
> Output shape: `{ kind, retry, backoffMs? }`. Transient kinds: `rate-limit`, `network`, `server`, `stream`, `connection`.
> Non-transient kinds (`permanent`, `unknown`, `model_refusal`, `context_overflow`, `tooling_failure`) fall through to the existing **Failure Taxonomy** in `skills/forge-auto/SKILL.md` Step 5 — do NOT handle them here.

#### When to apply

Wrap every `Agent()` dispatch call in a try/catch. On throw, run this handler. On clean return, skip it entirely.

#### Algorithm

1. Catch the thrown exception; capture its `.message` (or string representation) into a local variable `errorMsg`. Do NOT log or store `errorMsg` beyond this scope.
2. Shell out via `Bash`:
   ```
   node scripts/forge-classify-error.js --msg "$errorMsg"
   ```
   > **Security note:** Always double-quote `"$errorMsg"` in the shell invocation to prevent word-splitting and shell injection. If the error string may contain backticks or `$` characters, prefer piping via stdin:
   > `echo "$errorMsg" | node scripts/forge-classify-error.js`
   > Implementors who copy this example verbatim MUST preserve the double-quotes — bare `--msg $errorMsg` is a shell-injection risk.
3. Parse the JSON output into a `result` object: `{ kind, retry, backoffMs? }`.
4. If `result.retry === false` — bail immediately. Route to the CRITICAL failure block in `skills/forge-auto/SKILL.md` Step 5 (deactivate auto-mode, surface the `kind` to the user, stop the loop). Do NOT surface `errorMsg`.
5. If `result.retry === true` — increment the in-memory `attempt` counter (starts at 0 before the first retry; so first retry is `attempt = 1`).
6. If `attempt > PREFS.retry.max_transient_retries` (default `3`) — bail with message `"retries exhausted after {attempt} attempts (kind: {result.kind})"` via the same CRITICAL path. Do NOT surface `errorMsg`.
7. Compute backoff delay:
   - Preferred: use `result.backoffMs` directly when present.
   - Override (exponential): `delay_ms = 2000 * Math.pow(2, attempt - 1)` → 2000 ms / 4000 ms / 8000 ms for attempts 1/2/3.
   - When both are present, use `Math.min(result.backoffMs, delay_ms)` to avoid runaway waits.
8. Sleep for `delay_ms` milliseconds. Use the cross-platform Node one-liner (no `setTimeout` in the Claude-in-the-loop context):
   ```
   Bash("node -e \"const t=Date.now();while(Date.now()-t<{delay_ms}){}\"")
   ```
   Or on Unix with integer seconds:
   ```
   Bash("sleep $((Math.ceil(delay_ms / 1000)))")
   ```
9. Append a retry event to `.gsd/forge/events.jsonl` (single line, valid JSON). See **Event log format** below.
   > **NEVER include `errorMsg` or any exception body in the event log entry.**
10. Re-dispatch the same `Agent()` call with the identical prompt. Go to step 1 of the outer dispatch loop (not this handler).

#### Event log format

Each retry event is a single newline-terminated JSON object appended to `.gsd/forge/events.jsonl`:

```json
{"ts":"{ISO8601}","event":"retry","unit":"{unit_type}/{unit_id}","class":"{kind}","attempt":N,"backoff_ms":N,"model":"{model_id}"}
```

Fields:
- `ts` — ISO 8601 timestamp of the retry decision
- `event` — always `"retry"`
- `unit` — e.g. `"execute-task/T03"`, `"plan-slice/S01"`
- `class` — the `kind` from classifier output (`"rate-limit"`, `"server"`, `"network"`, `"stream"`, `"connection"`)
- `attempt` — retry attempt number (1-based)
- `backoff_ms` — actual sleep duration in milliseconds
- `model` — model ID used for the dispatch (e.g. `"claude-sonnet-4-6"`)

**Do NOT include:** raw exception text, SDK error body, request IDs, or any PII. The `errorMsg` variable must not appear in this entry.

#### Prefs contract

The handler reads `PREFS.retry.max_transient_retries` (integer). Default `3` when `PREFS.retry` is absent or the key is missing. The prefs block ships in T05 — until then the handler falls back to `3` silently.

Per-class behaviour summary:

| kind | retry | default backoffMs | notes |
|------|-------|-------------------|-------|
| `rate-limit` | true | 60 000 (or from `reset in Xs` header) | Respect provider backoff when present |
| `network` | true | 3 000 | ECONNRESET, ETIMEDOUT, socket hang up |
| `server` | true | 30 000 | 500 / 502 / 503, overloaded |
| `stream` | true | 15 000 | Malformed JSON mid-stream |
| `connection` | true | 15 000 | ECONNRESET-style; treated as transient |
| `permanent` | false | — | Auth / billing / quota — bail immediately |
| `unknown` | false | — | Opaque / tooling string — bail immediately |

#### Worked examples

**Example 1 — 429 rate-limit (attempt 1 of 3)**

Exception text (not logged): `"Rate limit exceeded — reset in 30s"`
Classifier output: `{"kind":"rate-limit","retry":true,"backoffMs":30000}`
Action: sleep 30 000 ms, then retry.
Event log entry:
```json
{"ts":"2026-04-16T10:00:05Z","event":"retry","unit":"execute-task/T03","class":"rate-limit","attempt":1,"backoff_ms":30000,"model":"claude-sonnet-4-6"}
```

**Example 2 — 503 server error (attempt 2 of 3)**

Exception text (not logged): `"503 Service Unavailable"`
Classifier output: `{"kind":"server","retry":true,"backoffMs":30000}`
Exponential override for attempt 2: `2000 * 2^1 = 4000 ms`. Use `Math.min(30000, 4000) = 4000 ms`.
Event log entry:
```json
{"ts":"2026-04-16T10:01:12Z","event":"retry","unit":"plan-slice/S02","class":"server","attempt":2,"backoff_ms":4000,"model":"claude-opus-4-7"}
```

**Example 3 — ECONNRESET network error (attempt 3 of 3, exhausted)**

Exception text (not logged): `"ECONNRESET — socket hang up"`
Classifier output: `{"kind":"network","retry":true,"backoffMs":3000}`
Attempt counter is now `3 > max_transient_retries (3)`? No, `3 === 3` — this IS the last allowed retry. Sleep 3 000 ms, retry.
If the re-dispatch also throws: `attempt` becomes `4 > 3` → bail with CRITICAL message `"retries exhausted after 4 attempts (kind: network)"`.
Event log entry for attempt 3:
```json
{"ts":"2026-04-16T10:02:44Z","event":"retry","unit":"research-slice/S01","class":"network","attempt":3,"backoff_ms":3000,"model":"claude-opus-4-7"}
```

#### Wiring into a dispatch template

Place the try/catch immediately around the `Agent()` call. Example snippet (drop into any dispatch template that has a `## Dispatch` step):

```
// ── Retry state (reset per unit) ──────────────────────────────────────────────
let attempt = 0;
const MAX_RETRIES = PREFS?.retry?.max_transient_retries ?? 3;

// ── Dispatch with retry ───────────────────────────────────────────────────────
while (true) {
  try {
    result = Agent(workerType, prompt);
    break; // success — exit retry loop
  } catch (e) {
    const errorMsg = String(e?.message ?? e);
    const classification = JSON.parse(
      Bash(`node scripts/forge-classify-error.js --msg "$errorMsg"`)
    );

    if (!classification.retry) {
      // Permanent / unknown → existing CRITICAL failure block
      deactivateAutoMode();
      throw new Error(`Dispatch failed (kind: ${classification.kind}) — see forge-auto Step 5`);
    }

    attempt++;
    if (attempt > MAX_RETRIES) {
      deactivateAutoMode();
      throw new Error(`Retries exhausted after ${attempt} attempts (kind: ${classification.kind})`);
    }

    const expBackoff = 2000 * Math.pow(2, attempt - 1);
    const delay = classification.backoffMs
      ? Math.min(classification.backoffMs, expBackoff)
      : expBackoff;

    Bash(`node -e "const t=Date.now();while(Date.now()-t<${delay}){}"`);

    appendToEventsLog({ ts: new Date().toISOString(), event: "retry",
      unit: `${unitType}/${unitId}`, class: classification.kind,
      attempt, backoff_ms: delay, model: modelId });
    // Loop continues → re-dispatch
  }
}
```

This snippet is self-contained and drop-in compatible with both `skills/forge-auto/SKILL.md` (T04) and `commands/forge-next.md` (T04 — note: forge-next has a unique selective memory injection block at its Step 3 that does not appear here; the retry wrapper surrounds only the `Agent()` call, not the memory injection logic).

> After appending the retry entry, follow the Token Telemetry section below: the retry entry MUST include an `input_tokens` field (the re-dispatch is new input).

---

### Token Telemetry

**Purpose:** Control-flow section that defines two complementary responsibilities every Forge dispatch loop must fulfil: (a) emit a structured `dispatch` event to `.gsd/forge/events.jsonl` after every worker returns, capturing token counts for observability and future cost tracking; and (b) budget optional-section injections before dispatch so oversize context injections never silently blow up a worker context. Like the Retry Handler, this section is control flow — not data flow — and therefore lives outside the fenced template blocks (MEM011). Token counting uses the zero-dependency `Math.ceil(chars / 4)` heuristic (M002-CONTEXT D1). No SDK imports, no external packages.

> **Cross-reference:** Token counter + truncator — `node scripts/forge-tokens.js --file <path>` (CLI) or `require('./scripts/forge-tokens')` (module). Exported functions: `countTokens(text)` and `truncateAtSectionBoundary(content, budgetChars, opts)`. Workers NEVER call this script directly — only the orchestrator invokes it during prompt assembly and after worker return.

#### When to apply

Compute `input_tokens` after all placeholder substitution in the final worker prompt, but BEFORE `Agent()` is invoked. Compute `output_tokens` from the worker result metadata if the SDK surfaces usage, otherwise use `countTokens(result.text)`. Emit the dispatch event on EVERY dispatch — success path AND retry re-dispatches. Retry re-dispatches additionally require an `input_tokens` field on the existing `retry` event (see Retry Handler above).

#### Algorithm

1. After full placeholder substitution and before `Agent()` dispatch: `input_tokens = countTokens(finalPrompt)`.
2. If `input_tokens > 0.8 * 200000` (160 000 — conservative context-window fraction, hardcoded for all Claude models as of 2026-04): emit a warning entry to the orchestrator log. Do NOT block dispatch — this is informational only.
3. `Agent()` dispatch proceeds as documented in the Retry Handler (success path or exception path).
4. On clean return: if the SDK result includes a usage or metadata field with token counts, use those. Otherwise: `output_tokens = countTokens(result.text ?? String(result))`.
5. Build the dispatch event object:
   ```js
   const dispatchEvent = {
     ts: new Date().toISOString(),
     event: "dispatch",
     unit: `${unitType}/${unitId}`,
     model: modelId,
     input_tokens,
     output_tokens,
   };
   ```
6. Ensure `.gsd/forge/` directory exists (`mkdir -p .gsd/forge/` or equivalent).
7. Append `JSON.stringify(dispatchEvent) + "\n"` to `.gsd/forge/events.jsonl`.
8. **I/O errors from the append MUST throw** — same contract as the Verification Gate (S02 precedent). Telemetry is not silent-fail. Do NOT wrap in a try/catch that swallows the error. The MEM036 "errors are data" principle applies to classification outcomes only — budget violations and I/O errors are exceptions.
9. On the retry path: include `input_tokens: countTokens(retryPrompt)` on the retry event (not a separate dispatch event — the retry entry already represents that re-dispatch).

#### Event log format

Each dispatch event is a single newline-terminated JSON object appended to `.gsd/forge/events.jsonl`:

| Field | Type | Source | Example |
|-------|------|--------|---------|
| `ts` | ISO 8601 string | `new Date().toISOString()` | `"2026-04-16T10:00:00Z"` |
| `event` | literal `"dispatch"` | — | `"dispatch"` |
| `unit` | string | `${unitType}/${unitId}` | `"execute-task/T03"` |
| `model` | string | PREFS routing | `"claude-sonnet-4-6"` |
| `input_tokens` | integer | `countTokens(finalPrompt)` | `12345` |
| `output_tokens` | integer | SDK usage or `countTokens(text)` | `3421` |

**S04 extension note:** S04 will extend this schema with `tier` and `reason` fields — additive only, no field renames. Implementors should treat the schema as open for extension.

Do NOT include: raw prompt text, worker output, file paths, exception messages, or any PII.

#### Prefs contract

The Budgeted Section Injection subsection (below) reads `PREFS.token_budget.<key>` (integer tokens) to determine per-placeholder budgets. The `token_budget` block ships in T05. Until then, the handler falls back silently to these defaults:

| key | Default (tokens) | Placeholder(s) governed |
|-----|-----------------|------------------------|
| `auto_memory` | 2000 | `{TOP_MEMORIES}` |
| `coding_standards` | 3000 | `{CS_STRUCTURE}`, `{CS_RULES}` (shared — count once per dispatch) |
| `ledger_snapshot` | 1500 | `{LEDGER}` (future placeholder) |

Missing `PREFS.token_budget` block → silent fallback to all defaults above. Individual missing keys → their default only.

#### Worked example

Input: a final worker prompt of approximately 8 000 characters. Token estimate: `countTokens(8000-char string) = Math.ceil(8000 / 4) = 2000`.

Worker returns approximately 1 200 characters of output. Token estimate: `countTokens(1200-char string) = Math.ceil(1200 / 4) = 300`.

Event appended to `.gsd/forge/events.jsonl`:

```json
{"ts":"2026-04-16T10:00:05Z","event":"dispatch","unit":"execute-task/T03","model":"claude-sonnet-4-6","input_tokens":2000,"output_tokens":300}
```

#### Budgeted Section Injection

Wrap OPTIONAL placeholders with the boundary-aware truncator so oversize injections never blow up a worker context. Mandatory placeholders throw instead.

```js
// Helper pseudocode — orchestrator-side only
const budgetTokens = PREFS?.token_budget?.auto_memory ?? 2000;
const budgetChars  = budgetTokens * 4;
const MEMORIES_SAFE = truncateAtSectionBoundary(
  ALL_MEMORIES,
  budgetChars,
  { mandatory: false, label: "AUTO-MEMORY" }
);
// MEMORIES_SAFE is substituted for {TOP_MEMORIES} in the template.
// Truncated output ends with: [...truncated N sections]

// For mandatory sections (T##-PLAN, S##-CONTEXT, M###-SCOPE):
const planContent = readFileSync(planPath, 'utf8');
truncateAtSectionBoundary(
  planContent,
  8000 * 4, // Mandatory sections have no prefs key — the throw is unconditional per ## Token Budget Settings
  { mandatory: true, label: `T${taskId}-PLAN` }
); // Throws on overflow → surfaces as blocker(scope_exceeded).
```

When a mandatory-section throw reaches the orchestrator's catch path, surface it as a `scope_exceeded` blocker (existing failure taxonomy). The blocker message must include the label and the actual vs. budget numbers for debugging (e.g. `"T03-PLAN: 42000 chars > 32000 budget"`).

Placeholder classification:

| Placeholder | Category | Budget key | Default (tokens) |
|-------------|----------|-----------|------------------|
| `{TOP_MEMORIES}` | optional | `auto_memory` | 2000 |
| `{CS_STRUCTURE}` | optional | `coding_standards` | 3000 |
| `{CS_RULES}` | optional | `coding_standards` | (shares key with CS_STRUCTURE — count once per dispatch) |
| `{LEDGER}` (future) | optional | `ledger_snapshot` | 1500 |
| T##-PLAN content | mandatory | — | no cap (overflow throws) |
| S##-CONTEXT content | mandatory | — | no cap (overflow throws) |
| M###-SCOPE content | mandatory | — | no cap (overflow throws) |
| `{CS_LINT}` | inlined (small) | — | not wrapped |
| `{auto_commit}`, `{unit_effort}`, `{THINKING_OPUS}` | scalar | — | not wrapped |

---

## Verification Gate

**Purpose:** Quality gate invoked by workers after all implementation steps are complete but before the worker is allowed to write its summary and return `done`. The gate shells out to `scripts/forge-verify.js`, which discovers and runs verification commands appropriate for the current unit. A worker may not return `done` unless `forge-verify.js` exits `0` (or the result is a recognised skip). This section is intentionally separate from the Retry Handler above (MEM011 — the gate is a quality control step, not an error-recovery step).

> **Cross-reference:** Verifier CLI — `node scripts/forge-verify.js --plan "$PLAN_PATH" --cwd "$CWD" --unit $UNIT`.
> Output shape (JSON): `{ passed, skipped?, discovery_source, commands[], checks[], duration_ms }`.
> Discovery chain: `task-plan.verify` → `prefs.preference_commands` → `package.json` allow-list → `skipped:"no-stack"`.

### Invocation points

| Worker | Phase | CLI flag set | When it runs |
|--------|-------|-------------|--------------|
| `execute-task` (`forge-executor`) | Task level | `--plan <path> --cwd <cwd> --unit execute-task/{T##}` | After "Verify every must-have", before writing T##-SUMMARY.md |
| `complete-slice` (`forge-completer`) | Slice level | `--cwd <cwd> --unit complete-slice/{S##}` (no `--plan`) | Step 3 — before the security scan |

### CLI shape

Task-level invocation (inside `execute-task` worker):

```sh
node scripts/forge-verify.js \
  --plan "{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md" \
  --cwd "{WORKING_DIR}" \
  --unit execute-task/{T##}
```

Slice-level invocation (inside `complete-slice` worker):

```sh
node scripts/forge-verify.js \
  --cwd "{WORKING_DIR}" \
  --unit complete-slice/{S##}
```

Note: `--plan` is omitted at slice level. The verifier reads verification commands from `prefs.preference_commands` or falls back through the discovery chain without a task-plan source.

### Discovery chain

When invoked, `forge-verify.js` resolves which commands to run in this order:

1. **`task-plan.verify`** — `verify:` key in the T##-PLAN.md YAML frontmatter (task-level only, requires `--plan`).
2. **`prefs.preference_commands`** — `preference_commands` list from the project's `.gsd/prefs.local.md` or `claude-agent-prefs.md`.
3. **`package.json` allow-list** — scripts matching a frozen set of safe keys (`test`, `typecheck`, `lint`, `check`) probed from `package.json`.
4. **`skipped:"no-stack"`** — no commands found and no recognised stack (pure-docs repo). Gate passes automatically.

This ordering ensures task-specific overrides take precedence, falls back to project-wide preferences, then auto-detects from the package manifest, and avoids false failures on documentation-only repos. Commands from step 1 are treated as untrusted (shell-injection pattern applied); commands from step 2 are user-authored and trusted.

### Failure handling

**Executor (`execute-task`):** If `forge-verify.js` exits non-zero and the result is not a `skipped` state, the worker must:

1. Call `formatFailureContext()` (exported from `forge-verify.js`) to obtain a human-readable summary of failing checks with truncated stderr.
2. Do NOT write T##-SUMMARY.md. The task stays in `RUNNING` state.
3. Return `partial`. Include the `formatFailureContext()` output verbatim in the next retry prompt under the heading `## Verification Failures`.
4. The orchestrator will re-dispatch the executor with the failure context injected — the worker uses it to diagnose and fix the failing checks before re-running the gate.

**Completer (`complete-slice`):** If `forge-verify.js` exits non-zero and the result is not `skipped:"no-stack"`:

1. STOP immediately — do not proceed to the security scan, lint gate, or squash-merge.
2. Write the failure context into `S##-SUMMARY.md` under a `## Verification Gate` section. Include: commands run, exit codes, discovery source, per-command durations, and truncated stderr for each failing check.
3. Return `blocked` with `blocker_class: tooling_failure`.
4. The orchestrator surfaces this to the user with the full verification context so the failure can be diagnosed without re-running the slice.

### Skip handling

Two skip conditions exist and are treated differently:

**`skipped:"no-stack"` (whole-gate skip):** The verifier found no commands via any discovery step — the repo has no recognisable test/lint stack. The gate records a verify event with `skipped:"no-stack"` and exits `0`. Workers treat this as a pass: log the event, continue to summary/merge. Do not surface as a warning to the user.

**Per-check `timeout`:** An individual command exceeded its timeout budget. That check is marked `passed: false` and assigned exit code `124` (POSIX timeout convention). The overall gate fails (exit non-zero) unless all other checks pass. The `timeout` flag is surfaced in the failure context so the user can investigate flaky or slow test suites. This is not a skip — it is a failure.

### Events.jsonl schema

Each gate run appends one event to `.gsd/forge/events.jsonl` (single line, valid JSON, newline-terminated):

```json
{"ts":"<ISO8601>","event":"verify","unit":"execute-task/T##","milestone":"M###","slice":"S##","task":"T##","discovery_source":"task-plan","commands":["npm run typecheck","npm test"],"passed":true,"duration_ms":4123}
```

Fields:
- `ts` — ISO 8601 timestamp of gate completion.
- `event` — always `"verify"`.
- `unit` — e.g. `"execute-task/T03"` or `"complete-slice/S02"`.
- `milestone` — e.g. `"M002"`.
- `slice` — e.g. `"S02"`.
- `task` — e.g. `"T03"`. **Omit this field at slice level.**
- `discovery_source` — one of `"task-plan"`, `"preference"`, `"package-json"`, `"none"`.
- `commands` — array of command strings that were run (or attempted).
- `passed` — `true` if exit code `0`, `false` otherwise.
- `skipped` — `"no-stack"` or `"timeout"` when applicable. **Omit when not applicable.**
- `duration_ms` — total wall-clock time for all checks combined.

Do NOT include: raw stderr, command output, file paths outside the project root, or any PII.

### Anti-recursion rule

The `--from-verify` flag is reserved for orchestrator-side guards against infinite verify↔retry loops. It is **not used** in the current dispatch flow. Workers must follow this rule instead:

Verification failures (non-zero exit from `forge-verify.js`) go **directly** to `partial` (executor) or `blocked` (completer). They must NOT be re-classified by the Retry Handler. The Retry Handler handles `Agent()` exceptions only — it never sees a verification result. These two control-flow paths are mutually exclusive:

- `Agent()` throws → **Retry Handler** (exception classification, backoff, re-dispatch).
- `forge-verify.js` exits non-zero → **Verification Gate failure handling** (partial/blocked, no backoff, no re-dispatch by the handler).

A worker that routes verification failures through the Retry Handler risks infinite loops: the handler may retry the same broken unit indefinitely. Do not do this.
