# Forge Review — Dialectic Confrontation

Authoritative spec for the **review gate**: a two-agent confrontation on a completed diff, run from the orchestrator context. Two consumers bind it at their own boundary:

| Consumer | Boundary | DIFF_CMD | Artifact | MODE |
|----------|----------|----------|----------|------|
| `forge-auto` / `forge-next` (before `complete-slice`) | per-slice — branch `gsd/{M###}/{S##}` still **unmerged** | git: `git diff {merge-base}...HEAD` · svn: `svn diff` (Step 1, VCS-aware) | `{S##}-REVIEW.md` | `auto` / `interactive` |
| `forge-task` (Step 5.5) | standalone task | `git diff {START_SHA}..HEAD` (worktree fallback) | `{TASK_ID}-REVIEW.md` | `interactive` |

Steps 2–8 below are boundary-agnostic — only the four bindings above differ. Step 9 (milestone-final triage) applies only to the per-slice boundary. The rest of this doc is written in slice terms (`{S##}-REVIEW.md`); substitute the task bindings when invoked from `forge-task`.

The gate stages two independent agents against the slice diff:

- **Challenger** — `forge-reviewer` (adversarial): finds bugs/brechas, frames each as an objection + a question.
- **Defender** — `forge-advocate` (author): refutes, concedes, or marks each objection `open`.
- One bounded **rebuttal** round (`review.rounds`, default 1): the reviewer sees the defense and either maintains or withdraws each objection.

The human only adjudicates what the two AIs genuinely disagree on. Everything else resolves between them — and what they **agree** is broken gets fixed on the spot (Step 7a), not archived. The gate **never blocks** `complete-slice` and never returns a blocker; what remains open is guaranteed to reach the operator at the milestone-final triage (Step 9) before `complete-milestone` runs.

> Why the orchestrator and not `forge-completer`: agents cannot call `Agent` or `AskUserQuestion`. The completer (`tools: Read, Write, Edit, Bash`) physically cannot dispatch the reviewer or ask the user. The skills run in the main context and own both tools.

## Inputs
- `WORKING_DIR` — absolute project root (bash-captured `pwd`, Windows-safe)
- `{M###}` — active milestone id
- `{S##}` — slice being completed
- `MODE` — `interactive` (forge-next) or `auto` (forge-auto)

## Step 0 — Read review prefs (3-file cascade)

```bash
REVIEW_CFG=$(node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const wd=process.env.WORKING_DIR||process.cwd();
const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
             path.join(wd,'.gsd','claude-agent-prefs.md'),
             path.join(wd,'.gsd','prefs.local.md')];
let mode='enabled',style='dialectic',rounds=1,askAuto='defer',fixConceded=true,engine='agents',challenger='claude',challengerModel=null,advocateModel='claude-fable-5';
for(const f of files){try{
  const r=fs.readFileSync(f,'utf8');
  const blk=(r.match(/^review:[ \t]*\n((?:[ \t]+.*\n?)*)/m)||[])[1]||'';
  let m;
  if(m=blk.match(/^[ \t]+mode:[ \t]*(\w+)/m))mode=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+style:[ \t]*(\w+)/m))style=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+rounds:[ \t]*(\d+)/m))rounds=parseInt(m[1],10);
  if(m=blk.match(/^[ \t]+ask_in_auto:[ \t]*(\w+)/m))askAuto=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+fix_conceded:[ \t]*(\w+)/m))fixConceded=m[1].toLowerCase()!=='false';
  if(m=blk.match(/^[ \t]+engine:[ \t]*(\w+)/m))engine=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+challenger:[ \t]*(\w+)/m))challenger=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+challenger_model:[ \t]*(\S+)/m))challengerModel=m[1];
  if(m=blk.match(/^[ \t]+advocate_model:[ \t]*(\S+)/m))advocateModel=m[1];
}catch(e){}}
if(!['enabled','disabled'].includes(mode))mode='enabled';
if(!['dialectic','flags'].includes(style))style='dialectic';
if(!Number.isInteger(rounds)||rounds<0||rounds>3)rounds=1;
if(!['defer','pause'].includes(askAuto))askAuto='defer';
if(!['agents','workflow'].includes(engine))engine='agents';
if(!['claude','codex'].includes(challenger))challenger='claude';
process.stdout.write(JSON.stringify({mode,style,rounds,askAuto,fixConceded,engine,challenger,challengerModel,advocateModel}));
" WORKING_DIR=\"$WORKING_DIR\")

CHALLENGER_MODEL=$(printf '%s' "$REVIEW_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const c=JSON.parse(d);process.stdout.write(c.challengerModel||'')}catch(e){process.stdout.write('')}})")
ADVOCATE_MODEL=$(printf '%s' "$REVIEW_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const c=JSON.parse(d);process.stdout.write(c.advocateModel||'')}catch(e){process.stdout.write('')}})")
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-model-alias.js ] && echo scripts || echo "$HOME/.claude/scripts")
ADVOCATE_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --id "$ADVOCATE_MODEL")
```

`$CHALLENGER_MODEL` and `$ADVOCATE_MODEL` are derived immediately after `$REVIEW_CFG` (same JSON-aware pattern as the `engine==workflow && challenger==codex` precedence check below) so Steps 2/3/4's `[ -n "$CHALLENGER_MODEL" ]` / `[ -n "$ADVOCATE_ALIAS" ]` guards have a value to test — never left unassigned.

**Prefs read here:**
- `challenger` — whitelist `claude|codex`, default `claude`. `claude` (or any invalid value → whitelist fallback) runs the in-context `forge-reviewer`/`forge-advocate` agents unchanged. `codex` routes the challenge (Step 2) and rebuttal (Step 4) through the `scripts/forge-xllm.js` adapter (GPT via `codex exec`).
- `challengerModel` — default `null` (unset). When set (e.g. `gpt-5-x`), it is forwarded to the adapter as `--model {challenger_model}`; when `null`, `-m`/`--model` is omitted and the adapter uses the Codex CLI default model. Only meaningful when `challenger == codex`.
- `advocateModel` — default `'claude-fable-5'` (literal — not null; the advocate always runs on a resolved model). Overridden by `advocate_model: <x>` in the cascade. Resolved to a dispatch alias via `ADVOCATE_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --id "$ADVOCATE_MODEL")` — the single mapping source (`scripts/forge-model-alias.js`, never duplicated here). An id with no known alias resolves to an empty string; Step 3 then omits `model:` entirely (frontmatter governs) and echoes a warning — degradation is documented, not silent.
- The regexes use `[ \t]` (never `\s`, which would match `\n` and leak into the next line — MEM), following the `readEvidenceMode` reader model.

### Precedence — `challenger: codex` × `engine: workflow`

The `engine: workflow` script hardcodes `agentType: 'forge-reviewer'` and cannot route Codex. So `challenger == 'codex'` **forces `engine = 'agents'`** — never a silent state. Immediately after the cascade resolves, in the orchestrator:

```bash
if [ "$(printf '%s' "$REVIEW_CFG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);process.stdout.write(c.challenger==="codex"&&c.engine==="workflow"?"1":"")})')" = "1" ]; then
  echo "⚠ challenger: codex força engine agents (workflow não roteia codex)"
  printf '{"ts":"%s","event":"review-challenger-fallback","milestone":"%s","slice":"%s","reason":"engine-workflow-forced-agents"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{M###}" "{S##}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  # treat engine as 'agents' for the rest of the gate
fi
```

The Codex challenger still runs — only the `workflow` transport is overridden to `agents` (which is where the Codex branch of Steps 2/4 lives). `<ISO>` comes from bash, never from inside a script. See **Fallback challenger (review-challenger-fallback)** below.

- `mode == disabled` → **skip the entire gate.** Proceed straight to `complete-slice`.
- `style == flags` → run the **legacy single-pass** (challenge only; write a `## ⚠ Review Flags`-style section into `{S##}-REVIEW.md`; no defense, no rebuttal, no Ask). Back-compat for users who don't want the debate. **`flags` respects `challenger`:** the single-pass runs Step 2 (challenge) only, so when `challenger == 'codex'` the challenge is routed to the adapter (`--mode challenge`) exactly as in the dialectic path; `challenger == 'claude'` runs `forge-reviewer`. A `flags` run has no rebuttal, so the Codex rebuttal branch never applies.
- `style == dialectic` (default) → run Steps 1–7 below. Engine routing applies within this path:
  - `engine == agents` (default) → Steps 1–9 as-is (zero change).
  - `engine == workflow` AND `style == dialectic` → **detect by introspection:** check whether the tool `Workflow` is present in **your own tool list** (when available, `Workflow` is a top-level tool — **do NOT use ToolSearch**, which only finds deferred tools and would return empty even when `Workflow` is available). Tool present → run Step 1 then execute **`## Engine workflow`** in place of Steps 2–5; Steps 6, 7a, 7b, 8, 9 are unchanged. Tool absent → **fallback agents** (see sub-section below).
  - `engine == workflow` AND `style == flags` → engine is ignored; run the legacy single-pass via agents (a 3-phase debate has no "flags" form).

### Fallback agents (engine: workflow)

Two triggers, same treatment:

**(a) Tool absent (Step 0):** echo `⚠ review.engine: workflow mas a tool Workflow não está disponível neste harness — usando engine agents`, then append to `{WORKING_DIR}/.gsd/forge/events.jsonl`:
```json
{"ts":"<ISO>","event":"review-engine-fallback","milestone":"{M###}","slice":"{S##}","reason":"tool-absent"}
```
Proceed via Steps 2–5 (agents).

**(b) Workflow invocation throws OR returns `{outcome:'error'}` (challenge stage):** echo `⚠ review.engine: workflow — invocação Workflow falhou (<stage>) — usando engine agents`, then append:
```json
{"ts":"<ISO>","event":"review-engine-fallback","milestone":"{M###}","slice":"{S##}","reason":"workflow-error:<stage>"}
```
Proceed via Steps 2–5 (agents). Defense/rebuttal `null` **never** reach this point — they are absorbed inside the script (`open`/`maintained` fallback).

> The `<ISO>` timestamp for both events comes from bash (`date -u +%Y-%m-%dT%H:%M:%SZ`) in the orchestrator — never from inside the script.

### Fallback challenger (review-challenger-fallback)

Modeled on **Fallback agents** above. One event type, two triggers discriminated by `reason`:

**(a) `engine-workflow-forced-agents`** (precedence, resolved at Step 0 — see the precedence sub-section above): `challenger == 'codex'` AND `engine == 'workflow'` → force `engine = 'agents'`, echo `⚠ challenger: codex força engine agents (workflow não roteia codex)`, append to `{WORKING_DIR}/.gsd/forge/events.jsonl`:
```json
{"ts":"<ISO>","event":"review-challenger-fallback","milestone":"{M###}","slice":"{S##}","reason":"engine-workflow-forced-agents"}
```

**(b) `codex-exit-nonzero`** (adapter unavailable/failed at the challenge stage — Step 2): the `scripts/forge-xllm.js` challenge invocation exits `!= 0` (binary absent, auth, quota, timeout, parse — the adapter does not distinguish; cause on its stderr) → **single fallback** to `Agent("forge-reviewer")` (no retry), echo `⚠ challenger: codex indisponível (exit ≠ 0) — usando forge-reviewer`, append:
```json
{"ts":"<ISO>","event":"review-challenger-fallback","milestone":"{M###}","slice":"{S##}","reason":"codex-exit-nonzero"}
```

> `<ISO>` for both comes from bash (`date -u +%Y-%m-%dT%H:%M:%SZ`) — never from inside a script. **Rebuttal has no fallback of its own:** a Codex rebuttal failure degrades non-conceded objections to `maintained` (conservative), it does NOT emit this event nor dispatch an agent (see Step 4).

## Step 0a — Idempotency

If `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` already exists → **skip the gate** (a prior run, or a resume after compaction, already produced it). Proceed to `complete-slice`.

## Step 1 — Compute the slice diff

Detect the VCS of `WORKING_DIR` first, then compute `DIFF_CMD` accordingly. Git is the default
(slice-branch range, `auto_commit: true`, branch still unmerged). SVN working copies have no
per-slice branch and no merge-base — the team works on trunk and holds commits — so the reviewable
change is the uncommitted working copy. Run this from INSIDE `WORKING_DIR` (the diff target lives there).

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # git — default to the slice-branch range (auto_commit: true — common case, branch still unmerged)
  BASE=$(git merge-base HEAD master 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo HEAD~10)
  DIFF_CMD="git diff ${BASE}...HEAD"
  # Fallback for auto_commit: false (work uncommitted in the worktree) or an empty branch range:
  if [ -z "$(eval "$DIFF_CMD" --name-only 2>/dev/null)" ]; then
    DIFF_CMD="git diff HEAD"
  fi
elif svn info >/dev/null 2>&1; then
  # svn — no per-slice branch/merge-base; the reviewable change is the uncommitted working copy.
  DIFF_CMD="svn diff"
else
  # unknown VCS (or CLI absent) — degrade to the no-diff path below, never error.
  DIFF_CMD="git diff HEAD"
fi
```

If `$DIFF_CMD` still produces no changes → write a minimal `{S##}-REVIEW.md` stating "no diff to review" and proceed. Do not dispatch agents.

## Step 2 — Challenge

Routed by `challenger` (from Step 0). `challenger == 'claude'` (default) runs the in-context agent unchanged; `challenger == 'codex'` runs the S01 adapter.

### `challenger == 'claude'` (default agent)

```
Agent({ subagent_type: 'forge-reviewer',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}" })
```

Parse the result:
- `NO_FLAGS` → no objections. Write a clean `{S##}-REVIEW.md` ("Reviewer found nothing to challenge."), proceed. Done.
- otherwise → capture the severity buckets as `OBJECTIONS` (each line carries a stable id `R#`, a `path:line`, the claim, and a `challenge:` question — see `agents/forge-reviewer.md § Output format`).

If the `Agent()` call **throws** → record a one-line note, write a `{S##}-REVIEW.md` stub noting the review could not run, and proceed. **Review failures never abort `complete-slice`.**

### `challenger == 'codex'` (S01 adapter)

Invoke the adapter (parsing is **not** reimplemented — the adapter of S01 already validates and normalizes; see `scripts/forge-xllm.js`). Append `--model {challenger_model}` **only when `challengerModel != null`**; `--timeout` is optional:

```bash
node scripts/forge-xllm.js --mode challenge --diff-cmd "{DIFF_CMD}" --cwd {WORKING_DIR} \
  $([ -n "$CHALLENGER_MODEL" ] && printf -- '--model %s' "$CHALLENGER_MODEL")
XLLM_EXIT=$?
```

- **exit 0** → stdout is JSON `{objections:[{id,severity,file,line,issue,fix,challenge}]}` (already normalized by the adapter). Map each objection into the same `OBJECTIONS` contract the Claude branch produces — id (`R#`), `path:line` (`file:line`), severity, claim (`issue`), suggested fix (`fix`), and the `challenge` question — so Steps 3/5/6 consume it identically. Empty `objections` array → treat as `NO_FLAGS` (write a clean `{S##}-REVIEW.md`, proceed).
- **exit != 0** → **single fallback** (no retry) to `Agent("forge-reviewer")` (the `challenger == 'claude'` invocation above), echo `⚠ challenger: codex indisponível (exit ≠ 0) — usando forge-reviewer`, and append a `review-challenger-fallback` event with `reason: "codex-exit-nonzero"` (cause is on the adapter's stderr). See **Fallback challenger (review-challenger-fallback)** (trigger b). The gate then continues with the agent's objections.

## Step 3 — Defense (forge-advocate)

`ADVOCATE_ALIAS` was resolved in Step 0 from `advocate_model` (default `claude-fable-5`) via `scripts/forge-model-alias.js`. Pass `model:` to the dispatch **only when the alias is non-empty** (same override-at-dispatch pattern as the S02 challenger model, mirrored for the defender):

```
if [ -n "$ADVOCATE_ALIAS" ]; then
```
```
Agent({ subagent_type: 'forge-advocate', model: '{ADVOCATE_ALIAS}',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}" })
```
```
else
  echo "⚠ advocate_model '$ADVOCATE_MODEL' sem alias — usando frontmatter"
```
```
Agent({ subagent_type: 'forge-advocate',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}" })
```
```
fi
```

**Guard Fable 400 (documented):** when the resolved model is `claude-fable-5*`, `thinking` MUST be `adaptive` (never `disabled`) — Fable 5 returns HTTP 400 on an explicit `thinking: {type: 'disabled'}`. The `Agent()` call above never injects `thinking` itself, so this is guaranteed by `agents/forge-advocate.md`'s own frontmatter (`model: claude-fable-5` + `thinking: adaptive`, changed together in the same commit).

**Scope of the override:** this `model:` override only applies to the `engine: agents` dispatch path above (Step 3). Under `engine: workflow`, the advocate runs as `agentType: 'forge-advocate'` inside the workflow script (see `## Engine workflow` below) — the script does not accept a per-call `model:` override, so the agent's own frontmatter (now Fable 5 by default) governs there instead.

Capture per-objection verdicts: `R# → {refuted | conceded | open} + rationale`. A throw here → treat every objection as `open` (the defense couldn't be heard) and continue.

## Step 4 — Rebuttal (rebuttal mode) × `rounds`

Skip if `rounds == 0`. Otherwise, for `i` in `1..rounds` (default 1), feed the defense back to the **same challenger** that ran Step 2 (LOCKED — a rebuttal is only meaningful from the agent that wrote the original objections). Routed by `challenger`.

### `challenger == 'claude'` (default agent)

```
Agent({ subagent_type: 'forge-reviewer',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}\nDEFENSE:\n{DEFENSE}" })
```

When `DEFENSE` is present the reviewer runs in **rebuttal mode** (`agents/forge-reviewer.md § Rebuttal mode`): it only re-litigates objections the advocate `refuted` or marked `open`, returning `maintained` or `withdrawn` + a reason. Objections the advocate `conceded` are carried through as `conceded` (settled — nothing to rebut). A throw → treat all non-conceded objections as `maintained` (conservative). Only the last round's verdicts count.

### `challenger == 'codex'` (S01 adapter)

Write the OBJECTIONS + DEFENSE dialogue to a temp file (the adapter reads the rebuttal input from disk), then invoke the adapter (`--model` only when `challengerModel != null`):

```bash
node scripts/forge-xllm.js --mode rebuttal --input "$REBUTTAL_INPUT" --cwd {WORKING_DIR} \
  $([ -n "$CHALLENGER_MODEL" ] && printf -- '--model %s' "$CHALLENGER_MODEL")
XLLM_EXIT=$?
```

- **exit 0** → stdout is JSON `{verdicts:[{id,verdict,rationale}]}` (`verdict ∈ maintained|withdrawn`, already normalized). Apply exactly as the agent's rebuttal verdicts; only the last round's verdicts count.
- **exit != 0** → **no fallback of any kind.** Degrade every non-conceded objection to `maintained` (conservative) — reusing the same throw-handling rule the Claude branch already documents ("A throw → treat all non-conceded objections as `maintained`"). **NO** `Agent("forge-reviewer")` dispatch and **NO** `review-challenger-fallback` event.

> **The asymmetry with Step 2 challenge is deliberate (LOCKED, M004-CONTEXT).** A challenge failure falls back to a Claude agent because any competent reviewer can produce fresh objections from the diff. A rebuttal failure does **not**: a Claude agent would be re-judging objections it never wrote — so we degrade conservatively (`maintained` keeps them open for the human) rather than hand them to a different mind.

## Step 5 — Resolve each objection

Truth table (advocate verdict × reviewer rebuttal):

| advocate | reviewer rebuttal | resolution |
|----------|-------------------|------------|
| conceded | (any) | **CONCEDED** — both see a real problem → action item |
| refuted | withdrawn | **RESOLVED** — advocate convinced the reviewer → no action |
| refuted | maintained | **OPEN** — genuine disagreement → human decides |
| open | withdrawn | **RESOLVED** — reviewer dropped it → no action |
| open | maintained | **OPEN** — true tradeoff → human decides |

With `rounds == 0` (no rebuttal), treat every objection's rebuttal as `maintained`.

## Engine workflow

Replaces Steps 2–5 when `engine: workflow` and the `Workflow` tool is present in the orchestrator's tool list. The entire challenge → defense → rebuttal × rounds dialogue runs outside the orchestrator's context; only the structured JSON result is returned. The opt-in requirement is satisfied in two layers: this spec (read by the skill) instructs calling `Workflow`, and the operator's explicit `review.engine: workflow` pref.

**Invocation** (`DIFF_CMD` comes from Step 1; the date is NOT passed in args — it is stamped by the orchestrator at render time):

```
Workflow({ script: <contents of the fenced block below>,
           args: { wd: "{WORKING_DIR}", unit: "complete-slice/{S##}", diffCmd: "{DIFF_CMD}", rounds: {rounds} } })
```

**Script constraints:**
- Plain JS (no TypeScript annotations — TS breaks the runtime parser).
- **Body at top level** — após o `export const meta`, o corpo roda direto em contexto async. NUNCA embrulhar em `export default function`: o runtime lança `SyntaxError: Unexpected keyword export` (verificado empiricamente em 2026-06-10).
- `export const meta` must be a **literal** at the top (no variables, no interpolation).
- **PROHIBITED:** `Date.now()`, `new Date()`, `Math.random()` — the runtime throws on these; they also break resume.
- `rounds` always comes from `args` (never hardcoded).
- Truth table is deterministic code **inside the script** (not prose).
- Only the last rebuttal round's verdicts count.

**The script:**

```js
export const meta = {
name: 'forge-review-dialectic',
description: 'Review dialetico: challenge (forge-reviewer) -> defense (forge-advocate) -> rebuttal x rounds -> resolucao deterministica',
phases: [{ title: 'Challenge' }, { title: 'Defense' }, { title: 'Rebuttal' }]
}

const { wd, unit, diffCmd, rounds } = args

// keep in sync with scripts/forge-xllm.js
const challengeSchema = {
  type: 'object', required: ['objections'], additionalProperties: false,
  properties: { objections: { type: 'array', items: {
    type: 'object',
    required: ['id', 'path_line', 'claim', 'suggested_fix', 'challenge', 'severity'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Stable id R1, R2, ... severity-then-order' },
      path_line: { type: 'string' },
      claim: { type: 'string', description: 'Full text of the issue' },
      suggested_fix: { type: 'string' },
      challenge: { type: 'string', description: 'The one question that decides whether this is real' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }
    } } } }
}

let challenge = null
try {
  challenge = await agent(
    'WORKING_DIR: ' + wd + '\nUNIT: ' + unit + '\nDIFF_CMD: ' + diffCmd +
    '\nExecute DIFF_CMD from INSIDE WORKING_DIR (cd to it first) — the diff target lives there, not in your default cwd.\nReturn ALL findings as structured objections; empty array if NO_FLAGS.',
    { label: 'Challenge', phase: 'Challenge', agentType: 'forge-reviewer', schema: challengeSchema })
} catch (e) { challenge = null }
if (!challenge || !Array.isArray(challenge.objections)) {
  return { outcome: 'error', stage: 'challenge', items: [] }
}
if (challenge.objections.length === 0) return { outcome: 'ok', no_flags: true, items: [] }

const objText = challenge.objections.map(function (o) {
  return o.id + ' `' + o.path_line + '` [' + o.severity + '] — ' + o.claim +
    ' — suggested fix: ' + o.suggested_fix + ' — challenge: ' + o.challenge
}).join('\n')

// keep in sync with scripts/forge-xllm.js
const verdictSchema = function (allowed) {
  return {
    type: 'object', required: ['verdicts'], additionalProperties: false,
    properties: { verdicts: { type: 'array', items: {
      type: 'object', required: ['id', 'verdict', 'rationale'], additionalProperties: false,
      properties: {
        id: { type: 'string' },
        verdict: { type: 'string', enum: allowed },
        rationale: { type: 'string' }
      } } } }
  }
}

let defense = null
try {
  defense = await agent(
    'WORKING_DIR: ' + wd + '\nUNIT: ' + unit + '\nDIFF_CMD: ' + diffCmd + '\nExecute DIFF_CMD from INSIDE WORKING_DIR (cd to it first) — the diff target lives there, not in your default cwd.\nOBJECTIONS:\n' + objText,
    { label: 'Defense', phase: 'Defense', agentType: 'forge-advocate',
      schema: verdictSchema(['refuted', 'conceded', 'open']) })
} catch (e) { defense = null }

const defById = {}
const defWarnings = []
if (defense && Array.isArray(defense.verdicts)) {
  for (const v of defense.verdicts) {
    if (defById[v.id]) { defWarnings.push('duplicate advocate verdict for ' + v.id + ' — first occurrence kept') }
    else { defById[v.id] = v }
  }
}
for (const o of challenge.objections) {
  if (!defById[o.id]) defById[o.id] = { id: o.id, verdict: 'open',
    rationale: 'defesa indisponivel (agent null/throw) — tratada como open' }
}

const rebById = {}
for (const o of challenge.objections) {
  rebById[o.id] = { id: o.id, verdict: 'maintained',
    rationale: 'sem replica (rounds=0 ou agent null/throw) — mantida (conservador)' }
}
const n = Number.isInteger(rounds) ? Math.min(Math.max(rounds, 0), 3) : 1
for (let i = 0; i < n; i++) {
  const defText = challenge.objections.map(function (o) {
    const d = defById[o.id]
    const r = rebById[o.id]
    const rebLine = (i > 0)
      ? ' | rebuttal round ' + i + ': ' + r.verdict + ' — ' + r.rationale
      : ''
    return o.id + ': advocate: ' + d.verdict + ' — ' + d.rationale + rebLine
  }).join('\n')
  let reb = null
  try {
    reb = await agent(
      'WORKING_DIR: ' + wd + '\nUNIT: ' + unit + '\nDIFF_CMD: ' + diffCmd +
      '\nExecute DIFF_CMD from INSIDE WORKING_DIR (cd to it first) — the diff target lives there, not in your default cwd.\nOBJECTIONS:\n' + objText + '\nDEFENSE:\n' + defText,
      { label: 'Rebuttal ' + (i + 1), phase: 'Rebuttal', agentType: 'forge-reviewer',
        schema: verdictSchema(['maintained', 'withdrawn', 'conceded']) })
  } catch (e) { reb = null }
  if (reb && Array.isArray(reb.verdicts)) {
    for (const v of reb.verdicts) { if (rebById[v.id]) rebById[v.id] = v }  // last round wins
  }
}

// Step 5 truth table — deterministic, in-script
const items = challenge.objections.map(function (o) {
  const d = defById[o.id], r = rebById[o.id]
  let resolution
  if (d.verdict === 'conceded') resolution = 'conceded'
  else if (r.verdict === 'withdrawn') resolution = 'resolved'
  else resolution = 'open'   // OPEN: rebuttal maintained (advocate refuted/open) — ver truth table Step 5
  return { id: o.id, path_line: o.path_line, severity: o.severity, claim: o.claim,
    suggested_fix: o.suggested_fix, challenge: o.challenge,
    defense: { verdict: d.verdict, rationale: d.rationale },
    rebuttal: { verdict: r.verdict, rationale: r.rationale }, resolution }
})
return { outcome: 'ok', no_flags: false, items, warnings: defWarnings.length ? defWarnings : undefined }
```

**Return schema:**
```
{
  outcome: 'ok' | 'error',
  stage?: string,           // present on error: 'challenge'
  no_flags?: boolean,       // true when objections array was empty
  items: [{
    id, path_line, severity, claim, suggested_fix, challenge,
    defense:  { verdict: 'refuted'|'conceded'|'open',     rationale },
    rebuttal: { verdict: 'maintained'|'withdrawn'|'conceded', rationale },
    resolution: 'conceded' | 'resolved' | 'open'
  }]
}
```

**Render by the orchestrator** (same Step 6 template):
- `no_flags: true` → write a clean `{S##}-REVIEW.md` ("Reviewer found nothing to challenge.").
- Otherwise: group `items` by `resolution` into the Abertas / Concedidas / Resolvidas sections of Step 6, filling Objeção/Defesa/Réplica from the full-text fields.
- `**Reviewed:**` stamped with `date +%Y-%m-%d` (bash in the orchestrator — **never inside the script**).
- `Outcome` in the header calculated from item counts.
- `conceded` items (where `resolution == 'conceded'`) feed Step 7a: **ação = `suggested_fix`** (from the objection); **contexto = `defense.rationale`** (advocate's concession); `open` items feed Step 7b — both steps unchanged.

**Fallback:** if the invocation throws OR returns `{outcome:'error'}` → trigger Fallback agents (b) as described in Step 0, then proceed via Steps 2–5.

## Step 6 — Write `{S##}-REVIEW.md`

The artifact is the **dialogue**, not a flag dump. Auditable, durable with the milestone.

```markdown
# S##: <slice title> — Review (Dialectic)
**Slice:** S##  **Milestone:** M###  **Reviewed:** YYYY-MM-DD  **Rounds:** {rounds}
**Outcome:** {X resolved · Y conceded · Z open}
**Challenger:** {claude|codex} (<model|default>)
**Defender:** {advocate_model|alias}

## Abertas — requerem decisão humana
> O reviewer e o autor não chegaram a acordo. Você decide.
### R{n} — `path:line`
- **Objeção:** <claim> — _<challenge question>_
- **Defesa:** <advocate rationale>
- **Réplica:** <reviewer maintained reason>
- **Decisão:** _pendente_   ← preenchido no Step 7 (interactive) ou deferido (auto)

## Concedidas — problema real, corrigido
### R{n} — `path:line`
- **Objeção:** <claim>
- **Defesa:** conceded — <what should happen>
- **Correção:** _pendente_   ← preenchido no Step 7a: `aplicada — commit <sha>` ou `falhou — deferida para triagem final`

## Resolvidas no debate — sem ação
- R{n} `path:line` — <one-liner: por que caiu>

## Pattern hits (scan determinístico)
- `path:line` — pattern `{p}` — <context>   ← optional; deterministic grep, same patterns as forge-completer step 4a
```

Omit any section with zero items.

**`Challenger` line:** `claude` → `**Challenger:** claude`. `codex` with `challengerModel` set → `**Challenger:** codex (gpt-5-x)`; `codex` with model unset → `**Challenger:** codex (default do CLI)`. When a challenge fell back from codex to the agent (`review-challenger-fallback` / `codex-exit-nonzero`), stamp `**Challenger:** claude (fallback de codex)` to keep the artifact honest about what actually ran.

**`Defender` line:** `ADVOCATE_ALIAS` non-empty → `**Defender:** {advocate_model} ({ADVOCATE_ALIAS})` (e.g. `**Defender:** claude-fable-5 (fable)`); `ADVOCATE_ALIAS` empty (id with no known alias) → `**Defender:** {advocate_model} (frontmatter — sem alias)`, matching the Step 3 warning.

## Step 7a — Conceded fix dispatch (both modes)

A CONCEDED objection is a problem **both agents agree is real** — the confrontation already settled it. Recording it for a human to maybe-read later defeats the purpose of the debate. Fix it now, while the boundary diff is still intact (slice branch unmerged / task uncommitted scope).

Skip if `fixConceded == false` (pref opt-out → conceded items fall through to Step 7b posture as before) or there are zero CONCEDED items.

```
Agent({ subagent_type: 'forge-executor',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: review-fix/{S##}\n{isolation header lines when ISOLATION_MODE != shared}\nFix ONLY the conceded review items listed below. Minimal diffs — no refactors, no scope creep beyond the listed items. Run the lint/format commands if configured. Commit with message: fix(review): {S##} conceded items\n\n## Conceded items\n{for each CONCEDED R#: R# — path:line — objeção: <claim> — ação: <suggested_fix (use advocate concession rationale when suggested_fix is absent, e.g. in agents engine)> — contexto: <defense.rationale>}\n\nReturn ---GSD-WORKER-RESULT--- with status and the commit SHA." })
```

- On success → update each conceded R# in `{S##}-REVIEW.md`: `**Correção:** aplicada — commit {sha}`.
- On `Agent()` throw or `status != done` → update each: `**Correção:** falhou — deferida para triagem final`. These items join the OPEN items in the milestone-final triage (Step 9). **Never blocks** — the gate proceeds to `complete-slice` regardless.
- **No re-review.** The fix commit is NOT re-run through the reviewer (deliberate — prevents review ping-pong). The fix lands on the slice branch and flows through the normal `complete-slice` merge.

## Step 7b — Posture (handle OPEN items)

**`MODE == interactive` (forge-next / forge-task):**
- For each **OPEN** item, ask the human via `AskUserQuestion` — one question per item (or batched up to 4), header `Review`, options:
  - `Manter abordagem atual` — accept as-is (reviewer's concern noted, not acted on)
  - `Refatorar agora` — dispatch a `review-fix` unit (same shape as Step 7a) for the accepted items
  - `Criar follow-up` — log it as a known issue to address later
  Write the chosen decision into the `**Decisão:**` line of that R# in `{S##}-REVIEW.md`.
- **CONCEDED** items with `fixConceded == false`: list them and ask once whether to address now (follow-up task) or record-and-continue. Default record-and-continue.

**`MODE == auto` (forge-auto):**
- `askAuto == defer` (default) — **do NOT pause mid-loop.** Mark each OPEN item in `{S##}-REVIEW.md` with `**Decisão:** deferido → triagem no fim da milestone`. Echo one line to the user: `⚖ Review S##: {Y} concedida(s) corrigidas · {Z} aberta(s) → triagem final`. Continue the loop. Deferred items are **guaranteed to surface**: the milestone-final triage (Step 9) puts every one of them to the operator before `complete-milestone` runs. Defer means *postponed to end-of-milestone*, never *swallowed*.
- `askAuto == pause` (opt-in) — run the same `AskUserQuestion` flow as interactive mode, accepting the pause.

The gate **never** returns a blocker regardless of posture.

## Step 8 — Event log

Append one line per agent dispatch to `{WORKING_DIR}/.gsd/forge/events.jsonl` (I/O errors propagate — no silent-fail):

```json
{"ts":"<ISO-8601>","event":"review","milestone":"${RUN_ID:-{M###}}","slice":"{S##}","style":"dialectic","rounds":N,"counts":{"resolved":N,"conceded":N,"open":N},"conceded_fixed":N,"engine":"agents","challenger":"claude","advocate":$([ -n "$ADVOCATE_ALIAS" ] && printf '"%s"' "$ADVOCATE_ALIAS" || printf 'null')}
```

`conceded_fixed`, `engine`, `challenger` and `advocate` are additive fields (readers that ignore unknown fields stay compatible — same convention as `tier`/`reason` from M002). `engine` is either `"agents"` or `"workflow"` and is emitted by **both** engine paths. `conceded_fixed`: number of conceded items whose Step 7a fix landed. `challenger` is `"claude"` or `"codex"` — the challenger that actually ran the challenge (so a codex→agent fallback records `"claude"`). `advocate` is the resolved `ADVOCATE_ALIAS` (e.g. `"fable"`) or JSON `null` when the id had no known alias (frontmatter governed instead) — same optional-field glue pattern as the rest of this event.

## Step 9 — Milestone-final triage (before `complete-milestone`)

Consumer: `forge-auto` / `forge-next`, when the derived unit is `complete-milestone` — **before dispatching `forge-completer`**. This is the operator's arbitration moment: all slice work is done, but the milestone has not yet been finalized (no final merge close-out, no LEDGER entry, no cleanup). Deferred review items get decided HERE, while acting on them is still cheap.

> **AUTONOMY RULE exception (explicit):** asking the user at this gate does NOT violate the forge-auto AUTONOMY RULE. The rule protects the *middle* of the loop; at this point every slice is complete and the only remaining unit is the milestone close-out. This gate is the designed human-arbitration point that `defer` postponed to.

1. **Collect.** Scan every `{S##}-REVIEW.md` in `.gsd/milestones/{M###}/slices/*/` for items still pending:
   - `**Decisão:** deferido → triagem no fim da milestone` (OPEN, deferred by Step 7b)
   - `**Correção:** falhou — deferida para triagem final` (CONCEDED whose fix failed)
   - Legacy `**Decisão:** deferido (auto-mode)` (pre-triage artifacts — still honored)
2. **If zero pending items** → skip silently, dispatch `complete-milestone` normally.
3. **Digest.** Print a digest table to the user — one row per item: `slice · R# · path:line · objeção (one-liner) · status (aberta | concedida-sem-fix)`.
4. **Triage.** For each item (batched up to 4 per `AskUserQuestion`, header `Review M###`): `Manter abordagem atual` / `Refatorar agora` / `Criar follow-up`.
5. **Act.** All `Refatorar agora` items → ONE `review-fix` dispatch (Step 7a shape, `UNIT: review-fix/{M###}-triage`, items grouped in a single prompt; slices are merged by now so fixes are normal commits on the current branch). On throw → mark those items `**Decisão:** refatorar — dispatch falhou, virou follow-up` and continue.
6. **Write back.** Update the `**Decisão:**` line of every triaged R# in its `{S##}-REVIEW.md`. `Criar follow-up` items also get one line appended to `.gsd/KNOWLEDGE.md § Review follow-ups` (create the section if missing) so they survive `milestone_cleanup`.
7. **Event.** Append to `events.jsonl`: `{"ts":"<ISO>","event":"review-triage","milestone":"{M###}","pending":N,"kept":N,"fixed":N,"follow_up":N}`.
8. Proceed to dispatch `complete-milestone`. The triage **never blocks** the milestone — any failure is recorded and the close-out continues.

## Legacy `style: flags` single-pass

When `style == flags`: run Step 2 only — routed by `challenger` (so `codex` uses the adapter's `--mode challenge`, `claude` uses `forge-reviewer`). Write the findings (+ optional pattern hits) into `{S##}-REVIEW.md` under a single `## ⚠ Review Flags` heading. No advocate, no rebuttal, no Ask. This reproduces the pre-dialectic advisory behavior for users who opt out of the debate.

## Cross-references
- `agents/forge-reviewer.md` — challenger + rebuttal mode
- `agents/forge-advocate.md` — defender
- `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` — gate invocation (before `complete-slice`) + milestone-final triage (Step 9, before `complete-milestone`)
- `scripts/forge-xllm.js` — S01 adapter for the Codex challenger (`--mode challenge|rebuttal`); parsing/validation lives there, not here
- `forge-agent-prefs.md § Review Settings` — `review.{mode,style,rounds,ask_in_auto,fix_conceded,engine,challenger,challenger_model,advocate_model}`
- Artifact: `.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` (durable with the milestone; cleaned by `milestone_cleanup`)
