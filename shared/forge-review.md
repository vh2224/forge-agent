# Forge Review — Dialectic Confrontation

Authoritative spec for the **review gate**: a two-agent confrontation on a completed diff, run from the orchestrator context. Two consumers bind it at their own boundary:

| Consumer | Boundary | DIFF_CMD | Artifact | MODE |
|----------|----------|----------|----------|------|
| `forge-auto` / `forge-next` (before `complete-slice`) | per-slice — branch `gsd/{M###}/{S##}` still **unmerged** | `git diff {merge-base}...HEAD` (Step 1) | `{S##}-REVIEW.md` | `auto` / `interactive` |
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
let mode='enabled',style='dialectic',rounds=1,askAuto='defer',fixConceded=true;
for(const f of files){try{
  const r=fs.readFileSync(f,'utf8');
  const blk=(r.match(/^review:[ \t]*\n((?:[ \t]+.*\n?)*)/m)||[])[1]||'';
  let m;
  if(m=blk.match(/^[ \t]+mode:[ \t]*(\w+)/m))mode=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+style:[ \t]*(\w+)/m))style=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+rounds:[ \t]*(\d+)/m))rounds=parseInt(m[1],10);
  if(m=blk.match(/^[ \t]+ask_in_auto:[ \t]*(\w+)/m))askAuto=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+fix_conceded:[ \t]*(\w+)/m))fixConceded=m[1].toLowerCase()!=='false';
}catch(e){}}
if(!['enabled','disabled'].includes(mode))mode='enabled';
if(!['dialectic','flags'].includes(style))style='dialectic';
if(!Number.isInteger(rounds)||rounds<0||rounds>3)rounds=1;
if(!['defer','pause'].includes(askAuto))askAuto='defer';
process.stdout.write(JSON.stringify({mode,style,rounds,askAuto,fixConceded}));
" WORKING_DIR=\"$WORKING_DIR\")
```

- `mode == disabled` → **skip the entire gate.** Proceed straight to `complete-slice`.
- `style == flags` → run the **legacy single-pass** (challenge only; write a `## ⚠ Review Flags`-style section into `{S##}-REVIEW.md`; no defense, no rebuttal, no Ask). Back-compat for users who don't want the debate.
- `style == dialectic` (default) → run Steps 1–7 below.

## Step 0a — Idempotency

If `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` already exists → **skip the gate** (a prior run, or a resume after compaction, already produced it). Proceed to `complete-slice`.

## Step 1 — Compute the slice diff

Default to the slice-branch range (`auto_commit: true` — the common case, branch still unmerged):

```bash
BASE=$(git merge-base HEAD master 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo HEAD~10)
DIFF_CMD="git diff ${BASE}...HEAD"
# Fallback for auto_commit: false (work uncommitted in the worktree) or an empty branch range:
if [ -z "$(eval "$DIFF_CMD" --name-only 2>/dev/null)" ]; then
  DIFF_CMD="git diff HEAD"
fi
```

If `$DIFF_CMD` still produces no changes → write a minimal `{S##}-REVIEW.md` stating "no diff to review" and proceed. Do not dispatch agents.

## Step 2 — Challenge (forge-reviewer)

```
Agent({ subagent_type: 'forge-reviewer',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}" })
```

Parse the result:
- `NO_FLAGS` → no objections. Write a clean `{S##}-REVIEW.md` ("Reviewer found nothing to challenge."), proceed. Done.
- otherwise → capture the severity buckets as `OBJECTIONS` (each line carries a stable id `R#`, a `path:line`, the claim, and a `challenge:` question — see `agents/forge-reviewer.md § Output format`).

If the `Agent()` call **throws** → record a one-line note, write a `{S##}-REVIEW.md` stub noting the review could not run, and proceed. **Review failures never abort `complete-slice`.**

## Step 3 — Defense (forge-advocate)

```
Agent({ subagent_type: 'forge-advocate',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}" })
```

Capture per-objection verdicts: `R# → {refuted | conceded | open} + rationale`. A throw here → treat every objection as `open` (the defense couldn't be heard) and continue.

## Step 4 — Rebuttal (forge-reviewer, rebuttal mode) × `rounds`

Skip if `rounds == 0`. Otherwise, for `i` in `1..rounds` (default 1), feed the defense back to the reviewer:

```
Agent({ subagent_type: 'forge-reviewer',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}\nDEFENSE:\n{DEFENSE}" })
```

When `DEFENSE` is present the reviewer runs in **rebuttal mode** (`agents/forge-reviewer.md § Rebuttal mode`): it only re-litigates objections the advocate `refuted` or marked `open`, returning `maintained` or `withdrawn` + a reason. Objections the advocate `conceded` are carried through as `conceded` (settled — nothing to rebut). A throw → treat all non-conceded objections as `maintained` (conservative). Only the last round's verdicts count.

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

## Step 6 — Write `{S##}-REVIEW.md`

The artifact is the **dialogue**, not a flag dump. Auditable, durable with the milestone.

```markdown
# S##: <slice title> — Review (Dialectic)
**Slice:** S##  **Milestone:** M###  **Reviewed:** YYYY-MM-DD  **Rounds:** {rounds}
**Outcome:** {X resolved · Y conceded · Z open}

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

## Step 7a — Conceded fix dispatch (both modes)

A CONCEDED objection is a problem **both agents agree is real** — the confrontation already settled it. Recording it for a human to maybe-read later defeats the purpose of the debate. Fix it now, while the boundary diff is still intact (slice branch unmerged / task uncommitted scope).

Skip if `fixConceded == false` (pref opt-out → conceded items fall through to Step 7b posture as before) or there are zero CONCEDED items.

```
Agent({ subagent_type: 'forge-executor',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: review-fix/{S##}\n{isolation header lines when ISOLATION_MODE != shared}\nFix ONLY the conceded review items listed below. Minimal diffs — no refactors, no scope creep beyond the listed items. Run the lint/format commands if configured. Commit with message: fix(review): {S##} conceded items\n\n## Conceded items\n{for each CONCEDED R#: R# — path:line — objeção: <claim> — ação: <what should happen (advocate's concession)>}\n\nReturn ---GSD-WORKER-RESULT--- with status and the commit SHA." })
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
{"ts":"<ISO-8601>","event":"review","milestone":"${RUN_ID:-{M###}}","slice":"{S##}","style":"dialectic","rounds":N,"counts":{"resolved":N,"conceded":N,"open":N},"conceded_fixed":N}
```

`conceded_fixed` is additive (S03-style readers that ignore unknown fields stay compatible): number of conceded items whose Step 7a fix landed.

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

When `style == flags`: run Step 2 only. Write the reviewer's findings (+ optional pattern hits) into `{S##}-REVIEW.md` under a single `## ⚠ Review Flags` heading. No advocate, no rebuttal, no Ask. This reproduces the pre-dialectic advisory behavior for users who opt out of the debate.

## Cross-references
- `agents/forge-reviewer.md` — challenger + rebuttal mode
- `agents/forge-advocate.md` — defender
- `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` — gate invocation (before `complete-slice`) + milestone-final triage (Step 9, before `complete-milestone`)
- `forge-agent-prefs.md § Review Settings` — `review.{mode,style,rounds,ask_in_auto,fix_conceded}`
- Artifact: `.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` (durable with the milestone; cleaned by `milestone_cleanup`)
