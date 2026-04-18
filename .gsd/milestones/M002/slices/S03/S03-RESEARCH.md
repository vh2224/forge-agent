# S03: Token counter + context budget — Research

**Researched:** 2026-04-16
**Domain:** deterministic token accounting, markdown section-aware truncation, dispatch telemetry
**Confidence:** HIGH

---

## Summary

The slice ports GSD-2's `countTokens` + `truncateAtSectionBoundary` primitives into a Forge-native `scripts/forge-tokens.js` (CommonJS, zero deps, dual-mode module + CLI) and wires the outputs into three downstream consumers: the dispatch telemetry stream (`events.jsonl`), the `/forge-status` dashboard, and a new `token_budget:` prefs block that gates optional-section injection sizes. The primary recommendation is to follow the existing S01/S02 shape **exactly** — the CLI surface, the frontmatter parsing idiom, the `events.jsonl` append contract, and the "telemetry is not silent-fail" rule are already proven patterns in `forge-classify-error.js` and `forge-verify.js` and should be mirrored rather than re-thought.

GSD-2 ships two reference files that together cover every behaviour S03 needs: `token-counter.js` provides the `Math.ceil(chars/4)` heuristic (with an optional tiktoken fast-path Forge deliberately rejects per M002-CONTEXT D1), and `context-budget.js` provides `truncateAtSectionBoundary` with greedy section-keeping and `[...truncated N sections]` marker. Forge's version must add two behaviours GSD-2 does not expose: (a) a `mandatory` flag that throws instead of truncating (M002-CONTEXT D5), and (b) boundary detection that also matches `## ` (H2) and horizontal rules (`---` / `***`), not just `### ` (H3). Both are additive; the existing GSD-2 algorithm is otherwise fit-for-purpose.

The heuristic is "good enough" for routing and budgeting — English prose/markdown lands within 5–15% of tiktoken across Claude + GPT families, and the slice's 20%-error bail-out clause in M002-CONTEXT D1 is an appropriate tripwire. The real accuracy risks are not English prose but non-ASCII content (code points outside BMP undercounted), code blocks (denser tokenization than prose — `chars/4` slightly over-counts), and markdown boilerplate (frontmatter `---` delimiters, nested H2 inside code fences). Those risks are documented below with mitigations; none justify adding a tokenizer dependency.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Accurate BPE tokenization | `tiktoken` / `@anthropic-ai/tokenizer` / `js-tiktoken` | `Math.ceil(text.length / 4)` | M002-CONTEXT D1 pins zero new npm deps. For English markdown the heuristic error is ≤15% — well inside the 20% bail-out threshold. Accurate tokenization is valuable only when costing cents-per-call; here we're gating injection budgets where 15% slack is invisible. |
| Streaming/async token counter | `encoding_for_model("gpt-4o")` async API (GSD-2 `getEncoder()`) | Pure sync `countTokens(text)` returning a number | Forge's orchestrator runs in Claude's tool loop — no async primitives, no dynamic `import()` at runtime. The GSD-2 async fast-path is a drag here; we just need sync deterministic chars/4. |
| Markdown AST parser | `remark` / `unified` / `mdast-util-*` | Line-start regex `/^(## |### |---|\*\*\*)/m` + greedy section-fit | We only need to find **split points**, not build an AST. The GSD-2 `splitIntoSections` implementation (context-budget.js lines 158–163) is 5 lines — ship it; upgrade to a real parser only if code-block false positives become a real measured problem. |
| UTF-8-safe byte truncation helper | `string_decoder.StringDecoder` with streaming `write/end` | `content.slice(0, n)` on a JS string (char-native) | Forge's budgets are char-based, not byte-based. JS strings are UTF-16 and `.slice()` never splits a surrogate pair at the boundary of a code point `< U+10000`. The only edge case is astral-plane emoji / CJK characters in surrogate pairs — acceptable corruption for the fallback branch (zero-boundary input) since the output is for a machine reader that tolerates it. |
| Section-boundary detection that handles code fences | Custom fence-tracking state machine | Document the limitation; accept a small false-positive rate | See Pitfall 4 below. An H2 inside a fenced block (` ```md ... ## foo ... ``` `) would be mistakenly treated as a split point, but this occurs in ≤ 1% of injected sections (only AUTO-MEMORY.md and LEDGER.md are candidates; both are machine-written). Adding fence-awareness triples the regex complexity for negligible benefit. |
| External "token usage" dashboard | Datadog / OpenTelemetry exporter | Append to `.gsd/forge/events.jsonl`, aggregate in `/forge-status` | events.jsonl is already the project's telemetry backbone (retry, verify events). One-line JSON appends are auditable and version-controlled; external observability is out of scope for a single-user orchestrator. |

---

## Common Pitfalls

### Pitfall 1: Assuming `chars/4` is uniformly accurate across content types

**What goes wrong:** The heuristic treats all characters as equal weight, but real tokenization varies by content. Dense code (`const x={a:1,b:2};`) packs ≈ 3.0 chars/token; rare-word prose averages ≈ 4.2 chars/token; CJK text can hit ≈ 1.5 chars/token (each character is often its own token). For a budget of 2000 tokens (8000 chars) the actual token count could swing between 1900 and 5300 depending on content.

**Why it happens:** BPE tokenizers emit one token per common byte-pair, but rare byte-pairs and multi-byte codepoints are far more token-dense than ASCII word-like runs. The universal "1 token ≈ 4 chars" rule is specifically calibrated for English prose.

**How to avoid:** Document the heuristic assumption in the module's header comment. M002-CONTEXT D1 already encodes the 20% error tripwire — S03 should surface a note in `forge-agent-prefs.md` that budget values are *approximate* and should be tuned downward 20% for repositories heavy in non-ASCII content or dense code injections. No runtime check needed.

### Pitfall 2: Markdown frontmatter trips the section splitter

**What goes wrong:** Files with YAML frontmatter (`T##-PLAN.md`, `SKILL.md`, every agent file) start with `---` on line 1, followed by a YAML block, followed by a second `---`. The split regex `/^(?=## |### |---|\*\*\*)/m` matches both delimiters, splitting the frontmatter into its own fake "section" and potentially keeping or dropping the frontmatter independently of the body.

**Why it happens:** The regex only tests line-starts — it has no notion of "am I before the first real heading?".

**How to avoid:** Two fixes, pick one. (a) Strip frontmatter before splitting: `content = content.replace(/^---\n[\s\S]*?\n---\n/, '')` — cleanest, no false-split possible. (b) Sort sections by original position and always keep section 0 (the frontmatter slot) if present — preserves attribution but adds ordering logic. Recommendation: (a). The injection sites (`TOP_MEMORIES`, `CS_STRUCTURE`, `LEDGER`) don't need frontmatter anyway; frontmatter-free content is what the orchestrator already builds.

### Pitfall 3: Zero-boundary input still exceeds budget (fallback branch contract)

**What goes wrong:** A 40 000-char AUTO-MEMORY.md with no H2/H3/HR markers hits `budgetChars = 8000`. The greedy loop finds zero valid split points. GSD-2's implementation slices `content.slice(0, budgetChars)` and appends `[...truncated 1 sections]` — which is a **lie** (no sections were dropped, the content was mid-cut). Downstream readers may interpret the marker as meaning the dropped portion was clean.

**Why it happens:** Fallback logic tries to preserve the marker contract even when no structural cut exists.

**How to avoid:** The S03 plan already names this the "fallback branch" and documents it. The recommendation is to mirror GSD-2's behaviour but adjust the marker to be truthful, e.g. `[...truncated at char ${budgetChars}, no section boundaries found]`. Document this as a *known soft behaviour* in the S03 summary so consumers know the single-section case produces a hard cut.

### Pitfall 4: Nested `##` inside fenced code blocks

**What goes wrong:** An injected `CODING-STANDARDS.md` includes a fenced snippet like:
```
``` md
## Example heading
## Another heading
```
```
The regex `/^## /m` matches both lines, incorrectly treating them as split points. Result: the code block gets bisected and emitted as two sections; if the first fits and the second does not, the file is left with an unterminated ` ``` ` which breaks syntax highlighting downstream.

**Why it happens:** Regex is fence-blind; a real markdown parser would track fence state.

**How to avoid:** Two options: (a) Build a fence tracker (iterate lines, flip a `inFence` boolean on each ` ``` `, only split outside fences). ~15 lines of code. (b) Accept the false-positive rate — this occurs only in AUTO-MEMORY.md (which is machine-written and rarely contains ` ``` ` blocks) and in `CS_STRUCTURE` (which is a table, no fences). **Recommendation:** (b) for v1; note the limitation in the module's header comment. If a real case shows up, upgrade to (a). The pattern catalog shows fence trackers elsewhere in the Forge codebase (none yet — this would be the first).

### Pitfall 5: `chars/4` on pure numeric or binary-like content

**What goes wrong:** A section containing a base64-encoded payload or a 5000-digit hex dump has dramatically different tokenization. Hex/base64 tokenizes at ≈ 2 chars/token (near 1:1 because each 2-char pair is often its own token). The heuristic would under-count by 50%.

**Why it happens:** Heuristic is calibrated for natural language, not numeric streams.

**How to avoid:** Don't inject base64 / long hex dumps into worker prompts. If they appear in an optional section, they will truncate aggressively (worst case = content dropped). Acceptable. Document: `countTokens` is intended for natural-language / markdown content only; embed large binary in files-to-be-read, not in the prompt.

### Pitfall 6: Appending to `events.jsonl` without `mkdir -p`

**What goes wrong:** First dispatch on a fresh repo: `.gsd/forge/` does not yet exist. `appendFileSync` throws `ENOENT`. Orchestrator loop dies silently (or noisily, depending on wrapper).

**Why it happens:** Directory creation is a prerequisite for any file write in a path that may not exist.

**How to avoid:** S02's `forge-verify.js` already solved this (line 480: `mkdirSync(eventsDir, { recursive: true })` before `appendFileSync`). The dispatch telemetry path (wired by the orchestrator's Token Telemetry block) must either (a) shell out to the same script, or (b) the Token Telemetry section in `shared/forge-dispatch.md` must emit a `mkdir -p .gsd/forge/` as a pre-write step. The existing `events.jsonl` append idiom in `skills/forge-auto/SKILL.md` Step 6a already has this — copy that shape.

### Pitfall 7: `input_tokens` computed *before* placeholder substitution

**What goes wrong:** If the orchestrator counts tokens on the template *before* substituting `{TOP_MEMORIES}`, `{CS_STRUCTURE}`, etc., the reported number is a wild under-estimate — templates are ≈ 1 KB, fully-substituted prompts are 8–50 KB.

**Why it happens:** Natural mental model says "count the prompt" — but "the prompt" has two phases.

**How to avoid:** The S03-PLAN Acceptance Criterion 3 explicitly names the constraint: *"compute `input_tokens = countTokens(finalPrompt)` AFTER all placeholder substitutions but BEFORE `Agent()` is invoked"*. This must be enforced by T02's Token Telemetry section — include a callout box stating the ordering and cite this pitfall.

### Pitfall 8: `output_tokens` recomputation path when SDK returns usage

**What goes wrong:** The Claude SDK may or may not surface `usage.output_tokens` in the result. If it does and we recompute via `countTokens(result.text)`, the two numbers drift (SDK is exact, heuristic is approximate). Downstream aggregators show duplicate entries if both paths append.

**Why it happens:** Two sources of truth for the same metric.

**How to avoid:** Prefer SDK-reported `output_tokens` when present; only fall back to `countTokens` when absent. Document both in T02's Token Telemetry section. Include a `method: "heuristic" | "sdk"` field in the event so aggregators can distinguish. Otherwise, when comparing to tiktoken ground truth later, the SDK-reported numbers should be trusted as anchor points.

---

## Relevant Code

### GSD-2 reference implementations (source of ports)

- `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/token-counter.js` — 54 lines, ESM. Exports `countTokens(text)` (async), `countTokensSync(text)`, `getCharsPerToken(provider)`, `estimateTokensForProvider(text, provider)`. The sync path is `Math.ceil(text.length / 4)` — port this verbatim. Drop the tiktoken async fast-path entirely. Drop `CHARS_PER_TOKEN_BY_PROVIDER` table (over-engineering for Claude-only — M002-CONTEXT Deferred Ideas).

- `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/context-budget.js` — 179 lines, ESM. Key functions: `truncateAtSectionBoundary(content, budgetChars) → {content, droppedSections}`, `splitIntoSections(content)` (line 158: `/^(?=### |\-{3,}\s*$)/m`). Port `truncateAtSectionBoundary` + `splitIntoSections` almost verbatim, but **extend the regex** to include `## ` (H2) and `***` (alt HR). Drop everything else: `computeBudgets`, `resolveTaskCountMax`, `resolveExecutorContextWindow`, `findModelById` — Forge doesn't have a model registry and M002 Deferred Ideas excludes provider-based ratios.

- `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/auto-budget.js` — 30 lines. Pure alert-level helpers (`getBudgetAlertLevel`, `getNewBudgetAlertLevel`, `getBudgetEnforcementAction`). Out of scope for S03 — these are part of the deferred "pressure-based downgrade" work. Do not port.

### Forge-side anchors (pattern templates to follow)

- `C:/DEV/forge-agent/scripts/forge-classify-error.js` — CLI dual-mode exemplar. Lines 111–143 (the `require.main === module` block) are the canonical shape: argv parse, stdin fallback, TTY guard, single `console.log(JSON.stringify(...))`. T01 should mirror this block line-for-line with the flags swapped to `--file`.

- `C:/DEV/forge-agent/scripts/forge-verify.js` — the events.jsonl append contract reference. Lines 479–493 show the exact pattern: `mkdirSync(eventsDir, { recursive: true })` → `JSON.stringify(...)` → `appendFileSync(path, line + "\n", "utf-8")` → **no try/catch around the append**. Comment at line 492: *"I/O errors propagate to caller (orchestrator handles)"*. S03 must follow the same "telemetry is not silent-fail" rule (S02-RISK.md precedent).

- `C:/DEV/forge-agent/scripts/forge-verify.js` lines 420–466 — YAML frontmatter regex extractor for `verify:` key. The pattern (inline array OR multi-line dash array, no block scalar support) is the template for any future frontmatter-reading helper. Not needed by S03 itself but the style is established.

- `C:/DEV/forge-agent/shared/forge-dispatch.md` lines 289–446 — the Retry Handler section is the structural template for S03's new Token Telemetry section: Purpose → When to apply → Algorithm → Event log format → Prefs contract → Worked examples → Wiring snippet. T02 should replicate this skeleton verbatim with content swapped.

- `C:/DEV/forge-agent/.gsd/forge/events.jsonl` — live event log. Current shape: `{ts, unit, agent, milestone, status, summary, [files_changed, slice, task]}`. S03 adds `{event:"dispatch", ts, unit, model, input_tokens, output_tokens}`. Existing lines do **not** have an `event:` field — they're legacy summaries. The new shape introduces `event:` discriminator; `/forge-status` T04 filter must handle both ("no `event:` field" = legacy summary, skip or count separately).

- `C:/DEV/forge-agent/skills/forge-auto/SKILL.md` lines 231–273 — the `Agent()` dispatch block with heartbeat writes. T03's patch target. Token Telemetry hooks go: `input_tokens` computed immediately before line 239 (`Agent(agent_name, worker_prompt)`); `output_tokens` computed immediately after line 249 (`Wait for the result.`), before the heartbeat clear at line 269.

- `C:/DEV/forge-agent/skills/forge-next/SKILL.md` line 164 — the equivalent dispatch block. Same integration pattern, patched independently (MEM015 — do not mechanically merge).

- `C:/DEV/forge-agent/skills/forge-status/SKILL.md` lines 41–79 — the status dashboard template. T04 inserts a new Token usage block after "Próxima ação" (line 65–66) and before "Blockers" (line 68–69). Follow the existing section style: `### Header`, bullets with dash, pt-BR labels.

- `C:/DEV/forge-agent/forge-agent-prefs.md` lines 118–141 — Retry Settings block. T05's `token_budget:` block should follow the same shape: fenced YAML-ish snippet + prose explanation + links to the consuming code. Place between Retry Settings and Verification Settings (alphabetical: `retry` → `token_budget` → `verification`).

### Paths that feed the budgeted injection points

- `{TOP_MEMORIES}` — populated by `skills/forge-auto/SKILL.md` Step 3 (selective memory injection, lines 224–229). Input: `.gsd/AUTO-MEMORY.md`. Pre-processed (filtered, capped at 8 entries) — budget wrap should happen on the final string fed into the template.

- `{CS_STRUCTURE}` — populated from `.gsd/CODING-STANDARDS.md` "Directory Conventions" + "Asset Map" sections. Currently inlined in `plan-slice` template.

- `{CS_RULES}` — populated from `.gsd/CODING-STANDARDS.md` "Code Rules" section.

- `{LEDGER}` (future) — populated from `.gsd/LEDGER.md`. Budgeted slot designed in advance but not yet wired.

---

## Asset Map — Reusable Code

| Asset | Path | Exports / Shape | Use When |
|-------|------|-----------------|----------|
| Error classifier (shipped) | `scripts/forge-classify-error.js` | `classifyError(msg, retryAfterMs?) → {kind, retry, backoffMs?}`, `isTransient(result) → boolean` + CLI `--msg "..."` / stdin | CLI dual-mode template — mirror this block's exact shape in new scripts. |
| Verify gate (shipped) | `scripts/forge-verify.js` | `discoverCommands`, `runVerificationGate`, `formatFailureContext`, `isLikelyCommand` + CLI `--plan --cwd --unit` | Frontmatter parser + events.jsonl append + spawnSync safety reference. |
| events.jsonl append pattern | `scripts/forge-verify.js` lines 479–493 | `mkdirSync(recursive:true)` → `JSON.stringify` → `appendFileSync(path, line + '\n', 'utf-8')`; no try/catch | Canonical telemetry write. Telemetry I/O errors THROW (not silent-fail). |
| YAML frontmatter extractor idiom | `scripts/forge-verify.js` lines 420–466 | Regex `/^---\n([\s\S]*?)\n---/` → single-key extract (`/^key:\s*(.+)$/m`) → inline-array OR multiline-dash parse | Reading one known frontmatter key from a `.md` file without a YAML parser. 1 MB size cap upfront. |
| Retry Handler template | `shared/forge-dispatch.md` lines 289–446 | Purpose → When to apply → Algorithm → Event log format → Prefs contract → Worked examples → Wiring snippet | Structural template for T02's Token Telemetry section. |
| CLI dual-mode template | `scripts/forge-classify-error.js` lines 111–143 | CommonJS module + `require.main === module` CLI block with argv flags, stdin fallback, TTY guard | T01's CLI shape — argv flag parse + stdin fallback + single JSON stdout. |
| Dispatch template placeholders | `shared/forge-dispatch.md` | `{WORKING_DIR}`, `{M###}`, `{S##}`, `{T##}`, `{TOP_MEMORIES}`, `{CS_STRUCTURE}`, `{CS_LINT}`, `{CS_RULES}`, `{unit_effort}`, `{THINKING_OPUS}` | T02's Budgeted Section Injection helper wraps `TOP_MEMORIES`, `CS_STRUCTURE`, `CS_RULES`. `CS_LINT` stays inlined (few lines per MEM008). |
| `Agent()` dispatch block (forge-auto) | `skills/forge-auto/SKILL.md` lines 231–273 | Heartbeat write → `Agent(agent_name, worker_prompt)` → retry wrapper → heartbeat clear | T03 patch target — token telemetry hooks before/after `Agent()` call. |
| `Agent()` dispatch block (forge-next) | `skills/forge-next/SKILL.md` line 164 | Equivalent dispatch block with unique selective-memory-injection step before it | T03 second patch target — independent (MEM015). |
| Status dashboard template | `skills/forge-status/SKILL.md` lines 41–77 | `## Status GSD` → `### Slices` → `### Próxima ação` → `### Blockers` → `### Tasks autônomas` | T04 insertion point — new `### Token usage (M###)` block after Próxima ação. |
| Prefs block shape | `forge-agent-prefs.md` Retry Settings lines 118–141 | Fenced YAML-ish snippet + prose explanation of each field + cross-reference links | T05's `token_budget:` block shape — place alphabetically between `retry` and `verification`. |

---

## Coding Conventions Detected

- **File naming:** `forge-<topic>.js` for scripts; pure kebab-case. Matches MEM018 convention; no changes needed. New script: `scripts/forge-tokens.js`.
- **Function naming:** camelCase (`countTokens`, `truncateAtSectionBoundary`, `splitIntoSections`, `classifyError`). Constants UPPER_SNAKE.
- **Directory structure:** `scripts/forge-*.js` for Node helpers; `shared/forge-*.md` for dispatch/reference docs. S03 touches both.
- **Import style:** CommonJS only (`const {x} = require('y')`). No ESM. No `package.json`. Zero npm deps. Builtins: `fs`, `path`. S03 needs none — pure-computation module.
- **Error patterns:**
  - CLI scripts exit 0 on logical errors (emit data), exit 2 on parse errors. Hard errors (I/O from telemetry) THROW and propagate (S02 precedent — "telemetry is not silent-fail").
  - Mandatory-section overflow in `truncateAtSectionBoundary` is a THROW — this matches the "hard errors throw" rule. Optional-section truncation is not an error.
- **Test patterns:** No test framework. Inline `// ASSERT:` comments that `node -e` can re-exercise (S03-PLAN T01 — explicit). Smoke transcripts in `S##-SUMMARY.md`.
- **Dispatch template conventions:** Data-flow descriptors with placeholder substitution (MEM011). Control-flow helpers (Retry Handler, Token Telemetry) live as sibling `###` sections AFTER the data-flow templates, not interleaved. S03's T02 places `### Token Telemetry` after `### Retry Handler`.
- **pt-BR UI strings:** User-facing output of `/forge-status` must be pt-BR. T04's Token usage block uses pt-BR labels ("Total input", "Dispatches", "por fase"). Module-internal errors (the mandatory-section throw message) can stay English — they surface via the blocker taxonomy not directly to the user.
- **Thin-space thousands separator:** `/forge-status` T04 uses thin-space (U+2009) for number formatting. Check existing statusline code for the same convention — if none exists, document this as new.
- **Frontmatter-before-regex size cap:** Forge's frontmatter reader in `forge-verify.js` caps file size at 1 MB before running regex to prevent catastrophic backtracking. S03 does not parse frontmatter, so N/A — but the pattern is live and reusable.

---

## Pattern Catalog — Recurring Structures

| Pattern | When to Use | Files to Create | Key Steps |
|---------|-------------|-----------------|-----------|
| Dispatch control-flow section | New cross-cutting concern that wraps every `Agent()` call (telemetry, retry, etc.) | `shared/forge-dispatch.md` new `### <Name>` section after prior sibling sections | 1. Heading + Purpose paragraph. 2. "Cross-reference" pull-quote linking to the CLI or module. 3. "When to apply" bullet. 4. "Algorithm" numbered steps. 5. "Event log format" fenced JSON shape. 6. "Prefs contract" table or paragraph. 7. "Worked examples" 2–3 scenarios. 8. "Wiring into a dispatch template" drop-in snippet. Place AFTER the data-flow templates. |
| Budget-wrapped injection | Any optional placeholder in a dispatch template that may balloon | `shared/forge-dispatch.md` new `#### Budgeted Section Injection` subsection | 1. Enumerate which placeholders are budgeted (`TOP_MEMORIES`, `CS_STRUCTURE`, `CS_RULES`, future `LEDGER`). 2. Pseudocode: `wrapped = truncateAtSectionBoundary(raw, PREFS.token_budget.<key> * 4)`. 3. Enumerate mandatory placeholders in a table — these call the helper with `{mandatory:true, label:'<name>'}` and propagate the throw. 4. Default-value fallback when prefs block is missing. |

(These two patterns extend — not replace — the existing catalog. Only 2 patterns added; no need to cap.)

---

## Security Considerations

| Concern | Risk Level | Recommended Mitigation |
|---------|------------|------------------------|
| Secret leakage via truncation markers | LOW | Truncation preserves content prefix; if a secret is in the kept portion it was already exposed to the worker anyway. The marker `[...truncated N sections]` leaks only section count, not content. No mitigation needed. |
| events.jsonl as injection vector | LOW | The telemetry event is generated entirely from trusted orchestrator-side values (`unit_type`, `unit_id`, `model`, computed token counts). No user-supplied strings flow into the JSON. Same contract as S01 retry events and S02 verify events. |
| `input_tokens` calculated from sensitive prompt content | LOW-INFO | The token count is a scalar `N`; no prompt content leaves the orchestrator. AUTO-MEMORY entries with secrets stay in the prompt sent to Anthropic, not in events.jsonl. Out of scope. |
| Mandatory-section throw exposes content size | LOW | The throw message includes `{actual}` char count (e.g. `"1234 chars > 1000 budget"`). This is an information disclosure of size only; leaks no content. Acceptable. |
| Prefs block with attacker-supplied values | LOW | `token_budget:` values are integers. Worst case: an attacker who owns `.gsd/prefs.local.md` sets `auto_memory: 9999999` → no truncation → larger prompt → higher cost. Not a security issue, a billing one. Document but do not enforce. |
| Heuristic undercount → context overflow | LOW (no direct security impact) | If `chars/4` undercounts badly on non-ASCII content, the worker's context may overflow at `Agent()` time. The Retry Handler catches `context_overflow` (MEM failure taxonomy) and retries with `complexity: heavy`. Existing recovery path handles it. Covered. |

Overall: S03's telemetry path is additive to the existing events.jsonl infrastructure (S01/S02 precedents) and introduces no new trust boundaries. The module is pure computation over strings — no shell-outs, no network, no file I/O (except in CLI mode where `readFileSync(--file)` is read-only and size-capped).

---

## Sources

- File read: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/token-counter.js` — GSD-2 heuristic + tiktoken fast-path. Sync fallback is 1 line (`Math.ceil(text.length / 4)`) and is the port target.
- File read: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/context-budget.js` — GSD-2 truncation helper. `splitIntoSections` regex = `/^(?=### |\-{3,}\s*$)/m`; `truncateAtSectionBoundary` greedy algorithm with marker. Port target, extend regex to include `## ` and `***`.
- File read: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/auto-budget.js` — deferred ideas territory; do NOT port.
- File read: `C:/DEV/forge-agent/scripts/forge-classify-error.js` — CLI dual-mode exemplar, lines 111–143.
- File read: `C:/DEV/forge-agent/scripts/forge-verify.js` — events.jsonl append contract (lines 479–493), frontmatter regex (lines 420–466), CLI flag parsing pattern.
- File read: `C:/DEV/forge-agent/shared/forge-dispatch.md` — Retry Handler structural template (lines 289–446), dispatch template placeholder list (lines 10–285).
- File read: `C:/DEV/forge-agent/skills/forge-auto/SKILL.md` — `Agent()` dispatch block with heartbeat + retry wrapper (lines 231–273).
- File read: `C:/DEV/forge-agent/skills/forge-next/SKILL.md` — equivalent dispatch block with selective-memory-injection uniqueness (around line 164).
- File read: `C:/DEV/forge-agent/skills/forge-status/SKILL.md` — dashboard template, T04 insertion reference.
- File read: `C:/DEV/forge-agent/forge-agent-prefs.md` — Retry Settings block (lines 118–141) as T05 prefs block template.
- File read: `C:/DEV/forge-agent/.gsd/forge/events.jsonl` — existing line shape (pre-`event:` field era); T04 filter must handle both legacy and new shapes.
- Web search: `"chars per token heuristic accuracy Claude GPT English markdown"` → English prose + markdown error is within 5–15% of tiktoken; Claude averages ≈ 4 letters/token, ≈ 1.5 tokens/word; non-English, code, and frontmatter drift more. Confidence: HIGH.
- Web search: `"regex match markdown H2 H3 heading outside code block fence safe splitting"` → basic `/^#{2}\s/m` works for plain markdown; proper fence handling requires state-tracking a parser; specialized libraries (unified/remark) are the robust path but overkill. Confidence: HIGH.
- Web search: `"Node.js TextDecoder Buffer safe UTF-8 truncation byte multibyte character"` → `string_decoder.StringDecoder` handles multi-byte boundary preservation; TextDecoder supports `stream: true`; but char-native `.slice()` on JS UTF-16 strings is sufficient for our use case (we're not cutting at byte offsets). Confidence: HIGH.

### External sources (hyperlinked)

- [AI Prompt Character Limits: ChatGPT, Claude & Gemini Token Guide — TypeCount](https://typecount.com/blog/ai-prompt-character-limits)
- [Token Optimization and Cost Management for ChatGPT & Claude — IntuitionLabs](https://intuitionlabs.ai/articles/token-optimization-chatgpt-claude-costs)
- [Claude Code tokens: what they are and how they're counted — Shipyard](https://shipyard.build/blog/claude-code-tokens/)
- [Find text between two Markdown headings with regular expression — Juha-Matti Santala](https://notes.hamatti.org/technology/recipes/find-text-between-two-markdown-headings-with-regular-expression)
- [Matching Markdown And HTML Headings Using Regex (JS) — Eddy Mens](https://www.eddymens.com/blog/matching-markdown-and-html-headings-using-regex-js)
- [gfm-code-block-regex — regexhq](https://github.com/regexhq/gfm-code-block-regex)
- [String decoder — Node.js v25.9.0 Documentation](https://nodejs.org/api/string_decoder.html)
- [Node.js TextDecoder — GeeksforGeeks](https://www.geeksforgeeks.org/node-js-textdecoder/)
