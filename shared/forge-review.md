# Forge Review — Dialectic Confrontation

Authoritative spec for the **review gate**: a two-agent confrontation on a completed diff, run from the orchestrator context. Two consumers bind it at their own boundary:

| Consumer | Boundary | DIFF_CMD | Artifact | MODE |
|----------|----------|----------|----------|------|
| `forge-auto` / `forge-next` (before `complete-slice`) | per-slice — branch `gsd/{M###}/{S##}` still **unmerged** | git: `git diff {merge-base}...HEAD` · svn: `forge-review-diff.js` (Step 1, VCS-aware) | `{S##}-REVIEW.md` | `auto` / `interactive` |
| `forge-task` (Step 5.5) | standalone task | git: `git diff {START_SHA}..HEAD` (worktree fallback) · svn: `forge-review-diff.js` | `{TASK_ID}-REVIEW.md` | `interactive` |

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
- `FORGE_SCRIPTS_DIR` / `FORGE_SHARED_DIR` — resolved by the calling skill's bootstrap. Every
  `scripts/<x>.js` and `shared/<x>.md` named below is opened through them; the installer flattens
  `shared/*.md` into `~/.claude/`, so the bare relative path only exists inside the forge-agent
  repo. If the calling skill did not export them, resolve them the same way before Step 0.

> **This spec is executed, not consulted.** Every step below is a procedure with a fixed output
> contract, not guidance to be paraphrased. Two failure modes have been observed in production and
> are explicitly out of bounds: (a) skipping a dispatch and substituting the orchestrator's own
> reading of the diff — the advocate exists precisely because self-review is not review; (b)
> hand-writing the Step 8 telemetry instead of calling the emitter, which produced 151 distinct
> event shapes across 265 reviews and zero conformant rows in the workspace that surfaced this
> note. When a step cannot run, use its named degradation path (`§ Agent unavailability`,
> `review-*-fallback`) and record it — improvising the step is never one of the options.

## Step 0 — Read review prefs (via the canonical prefs CLI)

Resolve prefs once through the S01 engine CLI (`scripts/forge-prefs.js --resolved`, the canonical per-unit helper defined in `shared/forge-dispatch.md § Per-unit prefs resolution`) — it reads the JSONC catalog per layer, and legacy Markdown without JSONC hard-stops with the canonical repair message in `shared/forge-prefs-cutover.md`, so no `files=[…]` 3-file cascade merge is re-implemented here. Read every `review.*` knob off `.prefs`, applying the SAME whitelist/clamp + default each had inline. The single `REVIEW_CFG` JSON below preserves the exact shape downstream steps consume:

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs.js ] && echo scripts || echo "$HOME/.claude/scripts")
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR")
if [ $? -ne 0 ]; then
  # M008-CONTEXT decision #2 — loud stop, never a silent default. errors[] (file+line)
  # on stdout ($PREFS_JSON); human message + fix hint on stderr. Halt the review gate.
  echo "✗ prefs parse error — review gate halted (see stderr for arquivo:linha)" >&2
  # ...deactivate run + STOP...
fi

REVIEW_CFG=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{
const rv=(JSON.parse(d).prefs.review)||{};
const low=v=>(typeof v==='string')?v.toLowerCase():undefined;
let mode=low(rv.mode); if(!['enabled','disabled'].includes(mode))mode='enabled';
let style=low(rv.style); if(!['dialectic','flags'].includes(style))style='dialectic';
let trigger=low(rv.trigger); if(!['adaptive','always'].includes(trigger))trigger='adaptive';
let adaptiveFlagsLines=Number.isInteger(rv.adaptive_flags_lines)&&rv.adaptive_flags_lines>0?rv.adaptive_flags_lines:40;
let adaptiveDialecticLines=Number.isInteger(rv.adaptive_dialectic_lines)&&rv.adaptive_dialectic_lines>0?rv.adaptive_dialectic_lines:400;
let rounds=rv.rounds; if(!Number.isInteger(rounds)||rounds<0||rounds>3)rounds=1;
let askAuto=low(rv.ask_in_auto); if(!['defer','pause','gate'].includes(askAuto))askAuto='defer';
let gateTimeoutMs=Number.isInteger(rv.gate_timeout_ms)&&rv.gate_timeout_ms>0?rv.gate_timeout_ms:1800000;
let fixConceded=(low(rv.fix_conceded)==='false')?false:(rv.fix_conceded===false?false:true);
let engine=low(rv.engine); if(!['agents','workflow'].includes(engine))engine='agents';
let challenger=low(rv.challenger); if(!['claude','codex','gemini','auto'].includes(challenger))challenger='claude';
let advocate=low(rv.advocate); if(!['claude','codex','gemini','auto'].includes(advocate))advocate='claude';
let challengerModel=(typeof rv.challenger_model==='string'&&rv.challenger_model.trim())?rv.challenger_model.trim():null;
let advocateModel=(typeof rv.advocate_model==='string'&&rv.advocate_model)?rv.advocate_model:'claude-fable-5';
process.stdout.write(JSON.stringify({mode,style,trigger,adaptiveFlagsLines,adaptiveDialecticLines,rounds,askAuto,gateTimeoutMs,fixConceded,engine,challenger,advocate,challengerModel,advocateModel}));
}catch(e){process.stdout.write('{\"mode\":\"enabled\",\"style\":\"dialectic\",\"trigger\":\"adaptive\",\"adaptiveFlagsLines\":40,\"adaptiveDialecticLines\":400,\"rounds\":1,\"askAuto\":\"defer\",\"gateTimeoutMs\":1800000,\"fixConceded\":true,\"engine\":\"agents\",\"challenger\":\"claude\",\"advocate\":\"claude\",\"challengerModel\":null,\"advocateModel\":\"claude-fable-5\"}')}})")

CHALLENGER=$(printf '%s' "$REVIEW_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const c=JSON.parse(d);process.stdout.write(c.challenger||'claude')}catch(e){process.stdout.write('claude')}})")
CHALLENGER_MODEL=$(printf '%s' "$REVIEW_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const c=JSON.parse(d);process.stdout.write(c.challengerModel||'')}catch(e){process.stdout.write('')}})")
ADVOCATE_MODEL=$(printf '%s' "$REVIEW_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const c=JSON.parse(d);process.stdout.write(c.advocateModel||'')}catch(e){process.stdout.write('')}})")
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-model-alias.js ] && echo scripts || echo "$HOME/.claude/scripts")
ADVOCATE_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --id "$ADVOCATE_MODEL")
# Adapter engine for the external challenger: codex → `codex app-server` (protocolo JSONL), gemini → `agy --print` (Antigravity CLI)
XLLM_ENGINE=$([ "$CHALLENGER" = "gemini" ] && echo agy || echo codex)
```

`$CHALLENGER`, `$CHALLENGER_MODEL`, `$ADVOCATE_MODEL` and `$XLLM_ENGINE` are derived immediately after `$REVIEW_CFG` (same JSON-aware pattern as the `engine==workflow` precedence check below) so Steps 2/3/4's `[ -n "$CHALLENGER_MODEL" ]` / `[ -n "$ADVOCATE_ALIAS" ]` guards have a value to test — never left unassigned.

**Prefs read here:**
- `challenger` — whitelist `claude|codex|gemini`, default `claude`. `claude` (or any invalid value → whitelist fallback) runs the in-context `forge-reviewer`/`forge-advocate` agents unchanged. `codex` and `gemini` route the challenge (Step 2) and rebuttal (Step 4) through the `scripts/forge-xllm.js` adapter — `codex` = GPT via the `codex app-server` protocol (`--engine codex` — the adapter opens one app-server turn per invocation; the argv-based transport it used before was retired in M018 S05), `gemini` = Gemini via the Antigravity CLI `agy --print` (`--engine agy`).
- `challengerModel` — default `null` (unset). When set, it is forwarded to the adapter as `--model {challenger_model}`; when `null`, `--model` is omitted and the CLI's default model is used. Only meaningful when `challenger != claude`. Codex takes model ids (e.g. `gpt-5.2-codex`); agy takes model **labels which may contain spaces** (e.g. `Gemini 3.1 Pro (High)` — see `agy models`), so the value is read to end-of-line (`#` starts a comment; surrounding quotes are stripped) and must always be expanded quoted (`--model "$CHALLENGER_MODEL"`).
- `advocateModel` — default `'claude-fable-5'` (literal — not null; the advocate always runs on a resolved model). Overridden by `advocate_model: <x>` in the cascade. Resolved to a dispatch alias via `ADVOCATE_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --id "$ADVOCATE_MODEL")` — the single mapping source (`scripts/forge-model-alias.js`, never duplicated here). An id with no known alias resolves to an empty string; Step 3 then omits `model:` entirely (frontmatter governs) and echoes a warning — degradation is documented, not silent.
- Prefs parsing (block capture, `[ \t]` class, EOF-safe boundaries) now lives entirely in `scripts/forge-prefs.js` (S01); Step 0 only extracts resolved knobs off `.prefs` and applies the whitelist/clamp fallbacks above. The CLI resolves values without defaulting them — the defaults here are the review gate's own concern.

### Resolução de pairing (`auto`) — uma vez, antes de tudo

`challenger`/`advocate` aceitam `claude | codex | gemini | auto` — **ambos os eixos, mesmo whitelist**. O advocate GPT/Gemini deixou de ser fase 2: `scripts/forge-xllm.js --mode defend` existe, então `advocate: auto` resolve para a família **do autor** em vez de degradar para Claude. A degradação antiga (`defend-mode-unavailable`) continua alcançável via `--defend-unavailable`, para adapters instalados sem o modo. Quando **qualquer** eixo é `auto`, o pairing é resolvido **por autoria do diff** via `scripts/forge-review-pairing.js` — **uma única vez**, e essa resolução acontece **ANTES** da regra `engine: workflow força agents` (precedência abaixo) e **ANTES** do branch `style: flags`. `auto` cru nunca é testado por nenhuma regra a jusante; só o valor **resolvido** (`RESOLVED_CHALLENGER`/`RESOLVED_ADVOCATE`) é consumido dali em diante.

**Fonte de autoria = stream GLOBAL canônico** `$WORKING_DIR/.gsd/forge/events.jsonl` (declarado em `shared/forge-dispatch.md`; nunca arquivado — os dispatch events `execute-task/*` com `engine`/`slice`/`milestone` vivem lá; o per-milestone `{M###}-events.jsonl` guarda `repair`/`plan_check` e é movido no `milestone_cleanup`, portanto **não** é fonte). Se **nenhum** eixo é `auto` (ambos explícitos) → o CLI **não é chamado** (explícito vence; o CLI respeita o valor explícito, não deriva por autoria).

```bash
# Challenger/advocate resolvidos da cascade (padrão JSON-aware acima).
CHALLENGER=$(printf '%s' "$REVIEW_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).challenger||'claude')}catch(e){process.stdout.write('claude')}})")
ADVOCATE=$(printf '%s' "$REVIEW_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).advocate||'claude')}catch(e){process.stdout.write('claude')}})")

# Defaults para o caminho explícito (nenhum eixo auto): o valor resolvido é o próprio pref.
RESOLVED_CHALLENGER="$CHALLENGER"
RESOLVED_ADVOCATE="$ADVOCATE"
AUTHOR_ENGINE=claude
PAIR_MODE=explícito
PAIR_POLICY=explicit

if [ "$CHALLENGER" = auto ] || [ "$ADVOCATE" = auto ]; then
  PAIR_MODE=auto
  # Pré-escopo (boundary-aware) — preparação de input (mesma classe que computar DIFF_CMD no Step 1),
  # NÃO agregação: a contagem/majority/pairing permanecem 100% no CLI. Filtro-linha ESTRITO por
  # igualdade de campos (nunca substring): só sobrevivem eventos dispatch execute-task/* cujo
  # slice+milestone casam — eventos legados sem o discriminador são EXCLUÍDOS por construção.
  # (Slice binding mostrada; para a task binding ver a nota logo abaixo.)
  SCOPED=$(mktemp)
  node -e '
    const fs=require("fs");
    const [src,slice,ms]=[process.argv[1],process.argv[2],process.argv[3]];
    const out=[];
    let raw="";try{raw=fs.readFileSync(src,"utf8")}catch(_){raw=""}
    for(const ln of raw.split("\n")){
      if(!ln.trim())continue;
      let e;try{e=JSON.parse(ln)}catch(_){continue}
      if(e.event!=="dispatch")continue;
      if(typeof e.unit!=="string"||!e.unit.startsWith("execute-task/"))continue;
      if(e.slice!==slice||e.milestone!==ms)continue;   // estrito: campo ausente/divergente → excluído
      out.push(ln);
    }
    process.stdout.write(out.length?out.join("\n")+"\n":"");
  ' "$WORKING_DIR/.gsd/forge/events.jsonl" "{S##}" "{M###}" > "$SCOPED"

  # 1 call — CLI congelado (S01). --cwd $WORKING_DIR explícito (nunca CODE_DIR — worktree gotcha, MEM018).
  PAIR_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-review-pairing.js" --events "$SCOPED" --slice "{S##}" --milestone "{M###}" --cwd "$WORKING_DIR" --challenger "$CHALLENGER" --advocate "$ADVOCATE")
  PAIR_EXIT=$?
  rm -f "$SCOPED"

  # Validação one-shot (exit status + JSON parseável + campo author) ANTES dos parsers por-campo abaixo.
  # Um crash do CLI (script ausente/instalação dessincronizada, exceção) não deve produzir pairing inventado
  # em silêncio — degrada para estático + evento diagnóstico, igual ao padrão codex-unavailable.
  PAIR_VALID=$(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);process.stdout.write(o&&typeof o.author!=='undefined'?'1':'0')}catch(e){process.stdout.write('0')}})")
  if [ "$PAIR_EXIT" -ne 0 ] || [ "$PAIR_VALID" != "1" ]; then
    echo "⚠ forge-review-pairing.js falhou (exit=$PAIR_EXIT) — pairing estático claude"
    RESOLVED_CHALLENGER=claude
    RESOLVED_ADVOCATE=claude
    AUTHOR_ENGINE=claude
    PAIR_REASON=""
    PAIR_POLICY=""
    PAIR_COUNTS_CLAUDE=0
    PAIR_COUNTS_CODEX=0
    PAIR_MODE=fallback
    printf '{"ts":"%s","event":"review-pairing-fallback","milestone":"%s","slice":"%s","reason":"%s","author_engine":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{M###}" "{S##}" "pairing-resolution-failed" "$AUTHOR_ENGINE" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  else

  RESOLVED_CHALLENGER=$(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).challenger||'claude')}catch(e){process.stdout.write('claude')}})")
  RESOLVED_ADVOCATE=$(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).advocate||'claude')}catch(e){process.stdout.write('claude')}})")
  AUTHOR_ENGINE=$(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).author_engine||'claude')}catch(e){process.stdout.write('claude')}})")
  PAIR_REASON=$(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).reason||'')}catch(e){process.stdout.write('')}})")
  PAIR_POLICY=$(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).policy||'')}catch(e){process.stdout.write('')}})")
  PAIR_COUNTS_CLAUDE=$(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(String((JSON.parse(d).counts||{}).claude??0))}catch(e){process.stdout.write('0')}})")
  PAIR_COUNTS_CODEX=$(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(String((JSON.parse(d).counts||{}).codex??0))}catch(e){process.stdout.write('0')}})")

  # Emit review-pairing-fallback para cada reason em fallbacks[] (no-authorship-data, defend-mode-unavailable,
  # scope-empty-global-fallback — o CLI só recontabiliza o subconjunto true-legacy, nunca eventos
  # escopados para outra slice/milestone; sem eventos true-legacy → degrada para no-authorship-data).
  # Molde: clone de review-challenger-fallback (abaixo); <ISO> do bash, nunca de dentro de script. NUNCA bloqueia.
  for reason in $(printf '%s' "$PAIR_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write((JSON.parse(d).fallbacks||[]).join(' '))}catch(e){process.stdout.write('')}})"); do
    printf '{"ts":"%s","event":"review-pairing-fallback","milestone":"%s","slice":"%s","reason":"%s","author_engine":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{M###}" "{S##}" "$reason" "$AUTHOR_ENGINE" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
    PAIR_MODE=fallback
  done
  fi
fi

# codex-unavailable — challenger RESOLVIDO codex mas binário fora do PATH (distinto do codex-exit-nonzero
# do Step 2, que é review-challenger-fallback). Degrada para challenger estático claude, grava fallback, segue.
if [ "$RESOLVED_CHALLENGER" = codex ] && ! command -v codex >/dev/null 2>&1; then
  echo "⚠ codex fora do PATH — challenger estático claude"
  RESOLVED_CHALLENGER=claude
  PAIR_MODE=fallback
  printf '{"ts":"%s","event":"review-pairing-fallback","milestone":"%s","slice":"%s","reason":"codex-unavailable","author_engine":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{M###}" "{S##}" "$AUTHOR_ENGINE" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
fi

# Compat: os guards [ -n ... ] dos Steps 2/3/4/6 continuam consumindo $CHALLENGER e $ADVOCATE_RESOLVED.
CHALLENGER="$RESOLVED_CHALLENGER"
ADVOCATE_RESOLVED="$RESOLVED_ADVOCATE"

# A configured external model is inert whenever the resolved challenger is claude.
if [ -n "$CHALLENGER_MODEL" ] && [ "$RESOLVED_CHALLENGER" = claude ]; then
  echo "⚠ review-config-inert: challenger_model ignored for resolved claude"
  printf '{"ts":"%s","event":"review-config-inert","milestone":"%s","slice":"%s","reason":"challenger-resolved-claude"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{M###}" "{S##}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
fi

# Linha **Pairing:** do header (Step 6) — montada uma vez aqui, consumida boundary-agnóstica.
CHALLENGER_FAMILY=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --family "$RESOLVED_CHALLENGER")
[ -z "$CHALLENGER_FAMILY" ] && CHALLENGER_FAMILY="$RESOLVED_CHALLENGER"
PAIR_SUFFIX=""
if [ "$PAIR_POLICY" = majority ] || [ "$PAIR_POLICY" = tie-last ] || [ "$PAIR_POLICY" = last-dispatch ]; then
  PAIR_SUFFIX=" (${PAIR_POLICY}: ${PAIR_COUNTS_CLAUDE} claude / ${PAIR_COUNTS_CODEX} codex → autor ${AUTHOR_ENGINE})"
fi
PAIRING_LINE="**Pairing:** ${PAIR_MODE} — autor ${AUTHOR_ENGINE} → challenger ${CHALLENGER_FAMILY}${PAIR_SUFFIX}"
ADVOCATE_FAMILY=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --family "$RESOLVED_ADVOCATE")
# Both sides above are FAMILIES ('claude'|'gpt'|'gemini'), never engines: an
# engine compared against a family ('gpt' vs 'codex') is unequal for the SAME
# family and silently inverts this flag the moment a gpt advocate exists.
#
# The author is deliberately NOT part of this test. Requiring the debaters'
# family to also differ from the author's excuses the shipped default (claude
# author, claude challenger, claude advocate) as "not a collapse", which pins
# the flag at false on every default-configured review. This rule MUST stay
# byte-for-byte equivalent to the emitter's (forge-review-emit.js), or the
# artifact the human reads and the row a script aggregates disagree — the log
# announcing a collapse the page denies.
INTRA_FAMILY=false
if [ "$ADVOCATE_FAMILY" = "$CHALLENGER_FAMILY" ]; then INTRA_FAMILY=true; fi
```

A partir daqui, **todo o gate consome os resolvidos**: Steps 2/4 e a regra workflow abaixo usam `$RESOLVED_CHALLENGER`; Steps 3/6 usam `$RESOLVED_ADVOCATE`. `AUTHOR_ENGINE`/`PAIR_MODE`/`PAIR_POLICY`/`PAIR_REASON` alimentam a linha `**Pairing:**` do header (Step 6), já pré-montada em `$PAIRING_LINE`. A resolução ocorre **uma vez por review**; `style: flags` (abaixo) usa o pairing já resolvido (decisão #31 preservada).

**Regra de render da linha `**Pairing:**`:**
- `<modo>` = `$PAIR_MODE` — `auto` quando a resolução via CLI foi aplicada; `explícito` quando ambos os eixos eram explícitos (CLI não chamado); `fallback` quando houve `review-pairing-fallback` (`codex-unavailable` / `no-authorship-data` / `defend-mode-unavailable` / `scope-empty-global-fallback`). `scope-empty-global-fallback` só dispara sobre o subconjunto true-legacy (eventos sem campos `slice`/`milestone`); um stream só com eventos escopados para outra slice/milestone nunca aciona esse fallback — degrada para `no-authorship-data`.
- `<engine>` = `$AUTHOR_ENGINE` (`claude`|`codex`), resolvido pelo CLI (ou `claude` no caminho explícito).
- `<família>` = `$CHALLENGER_FAMILY` — família do challenger resolvido (`claude`|`gpt`), via `forge-model-alias.js --family`.
- **Slice/task mistos:** quando `$PAIR_POLICY` é `majority`, `tie-last` ou `last-dispatch`, anexa ` (<policy>: <counts.claude> claude / <counts.codex> codex → autor <engine>)` a partir do JSON do CLI. Omitida quando `PAIR_POLICY` é `explicit` ou `no-authorship-data` (sem contagem relevante).
- Boundary-agnóstica: a mesma linha (`$PAIRING_LINE`) vale para `S##-REVIEW.md` e `{TASK_ID}-REVIEW.md` — só o binding de `{S##}`/`{TASK_ID}` no restante do artefato muda.

**Boundary-aware — task binding (forge-task Step 5.5):** substituir o pré-escopo por unit único e omitir `--slice`/`--milestone`. O filtro-linha mantém `e.unit === "execute-task/{TASK_ID}"` (unit já único da task solta, mas resumes cross-engine da mesma task avulsa podem produzir mais de um dispatch); a chamada vira `... --events "$SCOPED" --cwd "$WORKING_DIR" --challenger "$CHALLENGER" --advocate "$ADVOCATE" --policy last`. O boundary de task avulsa usa **last-dispatch-wins** (não majority): com 3+ dispatches cross-engine, uma maioria de um engine mais antigo poderia vencer a última execução — que é a que de fato domina o diff final `START_SHA..HEAD`. O boundary por slice (multi-task) mantém `majority`/`tie-last` — ali maioria é o critério correto. Todo o resto (captura, fallbacks, codex-unavailable, substituição) é idêntico. `review-fix/*` nunca entra na autoria — o filtro `execute-task/` já o exclui por construção.

### Precedence — external challenger (`codex`/`gemini`) × `engine: workflow`

The `engine: workflow` script hardcodes `agentType: 'forge-reviewer'` and cannot route an external CLI. So a **resolved** challenger of `codex` OR `gemini` **forces `engine = 'agents'`** — never a silent state. **Ordem fixada (BLOCKER 1, R2):** este check roda **APÓS** a resolução de pairing acima — ele testa `$RESOLVED_CHALLENGER` (o valor resolvido), **nunca** o `auto` cru nem `c.challenger` do JSON. Assim, `challenger: auto` + autor claude → resolvido = codex → o force dispara; `auto` cru jamais dispara o force (só um challenger externo resolvido). No orquestrador:

```bash
ENGINE=$(printf '%s' "$REVIEW_CFG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).engine||"agents")}catch(e){process.stdout.write("agents")}})')
if [ "$RESOLVED_CHALLENGER" != "claude" ] && [ "$ENGINE" = "workflow" ]; then
  echo "⚠ challenger: $RESOLVED_CHALLENGER força engine agents (workflow não roteia challenger externo)"
  printf '{"ts":"%s","event":"review-challenger-fallback","milestone":"%s","slice":"%s","reason":"engine-workflow-forced-agents"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{M###}" "{S##}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  # treat engine as 'agents' for the rest of the gate
fi
```

The external challenger still runs — only the `workflow` transport is overridden to `agents` (which is where the adapter branch of Steps 2/4 lives). `<ISO>` comes from bash, never from inside a script. See **Fallback challenger (review-challenger-fallback)** below.

- `mode == disabled` → **skip the entire gate.** Proceed straight to `complete-slice`.
- `style == flags` → run the **legacy single-pass** (challenge only; write a `## ⚠ Review Flags`-style section into `{S##}-REVIEW.md`; no defense, no rebuttal, no Ask). Back-compat for users who don't want the debate. **`flags` respects the resolved pairing:** o branch `flags` roda **depois** da resolução de pairing (decisão #31), então consome `$RESOLVED_CHALLENGER` — nunca o `auto` cru. The single-pass runs Step 2 (challenge) only, so when the resolved challenger is `codex`/`gemini` the challenge is routed to the adapter (`--mode challenge --engine $XLLM_ENGINE`) exactly as in the dialectic path; resolved `claude` runs `forge-reviewer`. A `flags` run has no rebuttal, so the adapter rebuttal branch never applies.
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

Modeled on **Fallback agents** above. One event type, two triggers discriminated by `reason`. Same discipline as `shared/forge-dispatch.md § Engine Fallback Discipline` — per-dispatch, evidence-based, closed reason enum documented there (this section's two reasons are members of that same canonical enum; no separate list is maintained here):

**(a) `engine-workflow-forced-agents`** (precedence, resolved at Step 0 — see the precedence sub-section above): `challenger != 'claude'` AND `engine == 'workflow'` → force `engine = 'agents'`, echo `⚠ challenger: $CHALLENGER força engine agents (workflow não roteia challenger externo)`, append to `{WORKING_DIR}/.gsd/forge/events.jsonl`:
```json
{"ts":"<ISO>","event":"review-challenger-fallback","milestone":"{M###}","slice":"{S##}","reason":"engine-workflow-forced-agents"}
```

**(b) `{challenger}-exit-nonzero`** (adapter unavailable/failed at the challenge stage — Step 2): the `scripts/forge-xllm.js` challenge invocation exits `!= 0` (binary absent, auth, quota, timeout, parse, empty stdout — the adapter does not distinguish; cause on its stderr) → **single fallback** to `Agent("forge-reviewer")` (no retry), echo `⚠ challenger: $CHALLENGER indisponível (exit ≠ 0) — usando forge-reviewer`, append with the literal reason `codex-exit-nonzero` (challenger `codex`) or `gemini-exit-nonzero` (challenger `gemini`):
```json
{"ts":"<ISO>","event":"review-challenger-fallback","milestone":"{M###}","slice":"{S##}","reason":"codex-exit-nonzero"}
{"ts":"<ISO>","event":"review-challenger-fallback","milestone":"{M###}","slice":"{S##}","reason":"gemini-exit-nonzero"}
```

> `<ISO>` for both comes from bash (`date -u +%Y-%m-%dT%H:%M:%SZ`) — never from inside a script. **Rebuttal has no fallback of its own:** an adapter rebuttal failure degrades non-conceded objections to `maintained` (conservative), it does NOT emit this event nor dispatch an agent (see Step 4).

### Agent unavailability (review-agent-unavailable)

**Escopo.** Cobre o `Agent()` in-context da review **morrer** (429, erro de API, timeout, throw de qualquer natureza) nos Steps 2 (challenge), 3 (defense) e 4 (rebuttal). É distinto de `{challenger}-exit-nonzero` acima, que cobre o **CLI externo** e continua exatamente onde está — sem alterações.

**1. Retry primeiro (binding, formula-once).** Os `Agent()` dos Steps 2/3/4 **não são exceção** ao `shared/forge-dispatch.md § Retry Handler`. On throw → aplicar o handler como está: classificar via `scripts/forge-classify-error.js`, e para `retry: true` (transientes — `rate-limit`, `server`, `network`, `stream`, `connection`) aplicar backoff e **re-despachar o MESMO agente**, limitado por `PREFS.retry.max_transient_retries` (default `3`) e `retry.base_backoff_ms`. O contador `attempt` é **em memória, por dispatch** — a review é uma sequência lógica única no contexto do orquestrador, sem arquivo de estado. A escada é citada, nunca reimplementada aqui.

**2. Override do terminal action (delta central).** O handler roteia `retry: false` e exaustão para o bloco CRITICAL do `skills/forge-auto/SKILL.md` Step 5 (desativa auto-mode, para o loop). Para a review isso é **proibido** — o gate nunca bloqueia. Nesses dois casos: emitir `review-agent-unavailable` (enum de reasons em `shared/forge-dispatch.md § Engine Fallback Discipline`, home canônico — não replicado aqui) e aplicar a política por modo abaixo. **Jamais** o caminho CRITICAL.

**3. Regra de conduta do orquestrador.**

> **REGRA CRÍTICA:** o orquestrador NUNCA produz veredito de review no lugar de um agente indisponível — nem defesa, nem réplica, nem julgamento de objeção alheia. A única ação permitida é registrar a indisponibilidade e escalar ao humano (interativo) ou deferir à triagem final (auto).

Rationale: o orquestrador é o **autor** do dispatch (e, no loop, do próprio código sob review). Arbitrar no lugar do agente ausente destrói exatamente a independência que a review dialética existe para garantir — mesma família de "executar inline nunca é fallback aceitável".

**4. Política por modo.**

- **`review-advocate-unavailable`** (Step 3 não pôde ser ouvido — e **só depois** de a salvage do `DEFENSE_FILE` do Step 3 não render nenhum veredito; uma defesa truncada é recuperável, e recuperá-la não é fabricar) — todas as objeções ficam `open` **cruas**, sem veredito fabricado, e o **Step 4 (rebuttal) é PULADO**: sem defesa não há contraditório, e forçar a réplica seria o challenger julgando a própria objeção. `MODE == interactive` → as objeções sobem ao humano pelo `AskUserQuestion` do Step 7b já existente, com a ressalva de adversarialidade reduzida escrita no artefato. `MODE == auto` → `ask_in_auto: defer` marca cada uma `**Decisão:** deferido → triagem no fim da milestone` (Step 9), sem pausar o loop.
- **`review-challenger-unavailable`** (Step 2 in-context não pôde rodar) — não há objeções para debater. Escrever um `{S##}-REVIEW.md` / `{TASK_ID}-REVIEW.md` **mínimo que registra a indisponibilidade** e seguir; o gate prossegue para `complete-slice` normalmente. **PROIBIDO** renderizar esse caminho como limpo — nada de `NO_FLAGS`, "Reviewer found nothing to challenge.", "no flags" ou artefato sem bloco de indisponibilidade: **ausência de review não é aprovação**.
- **`review-rebuttal-unavailable`** (Step 4 in-context não pôde rodar, defesa já ouvida no Step 3) — a réplica nunca aconteceu, então nenhum veredito de challenger (`maintained`/`withdrawn`) pode ser fabricado pelo orquestrador. Os vereditos do advocate (`refuted`/`open`/`conceded`) são carregados adiante **exatamente como o advocate os deixou**, sem synthesis. `MODE == interactive` → sobem ao humano no `AskUserQuestion` do Step 7b, com a ressalva de que a rodada de réplica não ocorreu escrita no artefato. `MODE == auto` → `ask_in_auto: defer` marca cada item não-`conceded` `**Decisão:** deferido → triagem no fim da milestone` (Step 9), sem pausar o loop.

**5. Limite conhecido (honesto, não promessa de robustez).** A classificação é feita sobre o **texto** da exceção — o tool `Agent()` não expõe código HTTP estruturado. Se o provedor mudar o texto, a classificação degrada para `unknown → retry: false` → indisponibilidade declarada + o caminho sancionado acima. A direção da degradação é **fail-safe**: menos retry, nunca improviso, nunca loop.

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
  # svn — scoped to this slice's paths, new files included (M017 Phase 2).
  DIFF_CMD="node \"$FORGE_SCRIPTS_DIR/forge-review-diff.js\" --cwd \"${CODE_DIR:-$WORKING_DIR}\" --unit-dir \"$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}\""
  # Only this branch answers --scope-report; asking git would rely on where it
  # happens to print its usage text.
  SCOPE_REPORT=$(eval "$DIFF_CMD" --scope-report 2>/dev/null || echo "")
else
  # unknown VCS (or CLI absent) — degrade to the no-diff path below, never error.
  DIFF_CMD="git diff HEAD"
fi
```

**Why the SVN branch is a program and not `svn diff`.** Three properties the bare command
cannot deliver, each observed in the field:

- **Scope.** `svn diff` with no paths is the ENTIRE working copy. With no per-slice branch and
  a working copy shared by several developers at once, it carries their uncommitted work —
  measured: 49 files, 8 of them the unit's. The challenger then spends its budget objecting to
  code this slice does not own. `--unit-dir` mines the slice's `T##-PLAN.md`/`*-SUMMARY.md` for
  declared outputs and intersects them with what actually changed.
- **New files.** `svn diff` cannot render an unversioned (`?`) file at all. On a slice whose
  whole change was two new files, the review would have read nothing and rendered CLEAN — the
  worst outcome a gate has. They are reconstructed as added-file hunks.
- **Appended arguments.** `$DIFF_CMD --name-only` (Step 1.5/pattern scan) and `{DIFF_CMD} -- <files>`
  (Step 2.0 sharding) are appended by consumers below. `svn diff --name-only` does not exist, so
  the previous `DIFF_CMD="svn diff"` broke both of them silently. The program accepts both.

`.gsd/**` is excluded up front (canonical `isGsdPath` predicate) and reported as `gsd_excluded`:
in an SVN working copy Forge's own plans, summaries and evidence logs sit in the tree as unversioned
files, so the unscoped diff was handing the challenger its own artifacts to review.

The SVN baseline marker stays intentionally inert: `svnversion` yields `44531:44534M` in a mixed-revision
working copy, which `svn diff -r` does not accept, and diffing against a recorded revision in a shared
working copy would import other developers' landed commits. The diff is against BASE.

Scoping never produces an empty diff — an absent or non-matching manifest falls back to the whole
working copy (previous behavior) and says so in `--scope-report`, captured as `$SCOPE_REPORT` above.
Disclose it in the artifact, including `excluded`: a review that skipped files must never read as one
that found nothing. A `reason` of `unscoped:*` means the manifest did not apply and the whole working
copy was read — the operator has to be able to see that.

If `$DIFF_CMD` still produces no changes → write a minimal `{S##}-REVIEW.md` stating "no diff to review" and proceed. Do not dispatch agents.

## Step 1.5 — Deterministic cost policy

Before dispatching a reviewer, run the zero-model policy engine. The engine reads
the resolved `review.trigger`/threshold prefs itself, computes Git/SVN diff stats
without `eval`, and returns `skip | flags | dialectic`. This gate is deterministic:
never spend an LLM call deciding whether to spend an LLM call.

```bash
REVIEW_CODE_DIR="${CODE_DIR:-$WORKING_DIR}"
POLICY_ARGS=(review --cwd "$REVIEW_CODE_DIR" --risk "${SLICE_RISK:-normal}")
[ -n "${BASE:-}" ] && POLICY_ARGS+=(--base "$BASE")
# SVN only: the policy must count the SCOPED diff. Left unscoped it reads the whole
# shared working copy, so a colleague's uncommitted files decide this slice's review
# budget — promoting to dialectic and sharding challengers across code the unit does
# not own. Fails open: the flag is added only when the scope list was produced.
if [ -n "${SCOPE_REPORT:-}" ]; then
  mkdir -p "$WORKING_DIR/.gsd/forge"
  REVIEW_SCOPE_FILE="$WORKING_DIR/.gsd/forge/review-scope-{S##}.txt"
  eval "$DIFF_CMD" --name-only > "$REVIEW_SCOPE_FILE" 2>/dev/null \
    && POLICY_ARGS+=(--scope-file "$REVIEW_SCOPE_FILE")
fi
compgen -G "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks/*/*-SECURITY.md" >/dev/null && POLICY_ARGS+=(--security-present)
grep -Eq 'substantive:[[:space:]]*(false|✗)|wired:[[:space:]]*(false|✗)' \
  "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/{S##}-VERIFICATION.md" 2>/dev/null \
  && POLICY_ARGS+=(--verification-drift)

REVIEW_POLICY=$(node "$FORGE_SCRIPTS_DIR/forge-cost-policy.js" "${POLICY_ARGS[@]}")
POLICY_EXIT=$?
if [ "$POLICY_EXIT" -ne 0 ] || ! node -e 'JSON.parse(process.argv[1])' "$REVIEW_POLICY" 2>/dev/null; then
  # Never turn a policy implementation failure into a skipped review.
  REVIEW_POLICY='{"decision":"flags","reason":"policy-error-fail-open","changed_files":0,"changed_lines":0,"estimated_calls":1,"saved_calls_vs_dialectic":0}'
fi
REVIEW_DECISION=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).decision)" "$REVIEW_POLICY")
REVIEW_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).reason)" "$REVIEW_POLICY")

mkdir -p "$WORKING_DIR/.gsd/forge"
printf '%s' "$REVIEW_POLICY" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d);process.stdout.write(JSON.stringify({...p,ts:process.argv[1],event:"review-policy",milestone:process.argv[2],slice:process.argv[3]})+"\n")})' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{M###}" "{S##}" \
  >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```

The emitted `review-policy` event carries the full policy object, making cost
savings auditable rather than theoretical. Policy failure is visible as
`policy-error-fail-open` and conservatively spends one flags pass.

- `skip` → write the minimal `{S##}-REVIEW.md` with `**Policy:** skipped —
  {REVIEW_REASON}` and proceed without any review agent.
- `flags` → set the effective `style = flags` for this gate and run Step 2 only.
- `dialectic` → retain the configured dialectic and continue through Steps 2–5.

`review.trigger: always` preserves the legacy behavior. An explicit configured
`review.style: flags` is a ceiling: adaptive risk never upgrades an operator's
one-pass choice into a dialectic.

## Step 2 — Challenge

Routed by `challenger` (from Step 0). `challenger == 'claude'` (default) runs the in-context agent unchanged; `challenger == 'codex' | 'gemini'` runs the S01 adapter with `--engine $XLLM_ENGINE`.

### Step 2.0 — Shard the diff by file (context guard)

A challenger handed a whole large diff runs out of context and returns **nothing** —
and a challenger that returns nothing is indistinguishable, downstream, from one that
found nothing. That failure mode is silent and lands on exactly the changes most
likely to hide a defect. The policy object from Step 1.5 already carries the split:

```bash
REVIEW_SHARDS=$(node -e "process.stdout.write(String((JSON.parse(process.argv[1]).shards||[]).length))" "$REVIEW_POLICY")
shard_files() { node -e "process.stdout.write(((JSON.parse(process.argv[1]).shards||[])[Number(process.argv[2])]||{files:[]}).files.join(' '))" "$REVIEW_POLICY" "$1"; }
```

`REVIEW_SHARDS <= 1` → **dispatch exactly as before**, one challenger, unscoped
`$DIFF_CMD`. Nothing below applies. This is the common case and stays byte-identical.

`REVIEW_SHARDS > 1` → dispatch one challenger **per shard**, each with the diff
scoped to its own files (`DIFF_CMD -- <files>`), and merge. Shards are files, never
hunks: an agent must never see half a function. Splitting is deterministic
(`planReviewShards`, files sorted by size into the lightest shard), so a resumed
review re-derives the identical split. Cap: 6 challengers.

**Merging.** Renumber the surviving objections sequentially in shard order (`R1`,
`R2`, …) so Steps 3–5 keep one flat, stably-identified list — they are unchanged and
never learn that sharding happened. Every objection already carries its own
`path:line`, so provenance survives renumbering.

**Keep each objection's author.** Step 4 sends the defense back to *the* challenger
that wrote the objection (LOCKED) — with N shards there are N challengers, so record
the originating `agent_id` per objection as `REVIEWER_AGENT_ID[R#]` instead of one
scalar. A sharded rebuttal groups objections by author and sends each group to its
own agent; an unsharded review keeps exactly one group and one id, which is today's
behavior. Any shard whose id is missing takes the existing per-agent compatibility
fallback on its own, without dragging the others into a fresh dispatch.

**A shard that fails is not a shard that passed.** Apply § Agent unavailability
per shard. If some shards return and others stay unavailable, keep the objections
you have AND record the unavailable shards (with their files) in the artifact under
`## Cobertura incompleta` — a review missing a third of the diff must never render
as clean. Only when **every** shard returns `NO_FLAGS` is the clean artifact correct.

### `challenger == 'claude'` (default agent)

```
Agent({ subagent_type: 'forge-reviewer',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}" })
```

When `REVIEW_SHARDS > 1`, the prompt's `DIFF_CMD` is the shard-scoped form
`{DIFF_CMD} -- $(shard_files $i)`, one `Agent()` per shard `i`. Everything else about
the agent contract is unchanged.

Capture the completed subagent's `agent_id` as `REVIEWER_AGENT_ID`. Claude Code
returns this id with a custom subagent result. It is used in Step 4 to resume the
same reviewer through the native `SendMessage` tool, preserving the reviewer's
diff reads and original reasoning instead of paying for a fresh reviewer context
on every rebuttal round. If no id is returned, leave `REVIEWER_AGENT_ID` empty and
use the compatibility fallback documented in Step 4.

Parse the result:
- `NO_FLAGS` → no objections. Write a clean `{S##}-REVIEW.md` ("Reviewer found nothing to challenge."), proceed. Done.
- otherwise → capture the severity buckets as `OBJECTIONS` (each line carries a stable id `R#`, a `path:line`, the claim, and a `challenge:` question — see `agents/forge-reviewer.md § Output format`).

If the `Agent()` call **throws** → apply **§ Agent unavailability (review-agent-unavailable)** above: retry first (Retry Handler), and only if the agent stays unavailable emit `review-challenger-unavailable` and write a `{S##}-REVIEW.md` **mínimo que registra a indisponibilidade** — never the `NO_FLAGS` clean-artifact branch above (ausência de review não é aprovação). **Review failures never abort `complete-slice`.**

### `challenger == 'codex' | 'gemini'` (S01 adapter)

Invoke the adapter (parsing is **not** reimplemented — the adapter of S01 already validates and normalizes; see `scripts/forge-xllm.js`). Pass `--model "$CHALLENGER_MODEL"` **only when non-empty, always quoted** (agy labels contain spaces); `--timeout` is optional:

```bash
if [ -n "$CHALLENGER_MODEL" ]; then
  node scripts/forge-xllm.js --mode challenge --engine "$XLLM_ENGINE" --diff-cmd "{DIFF_CMD}" --cwd {WORKING_DIR} --model "$CHALLENGER_MODEL"
else
  node scripts/forge-xllm.js --mode challenge --engine "$XLLM_ENGINE" --diff-cmd "{DIFF_CMD}" --cwd {WORKING_DIR}
fi
XLLM_EXIT=$?
```

- **exit 0** → stdout is JSON `{objections:[{id,severity,file,line,issue,fix,challenge}]}` (already normalized by the adapter). Map each objection into the same `OBJECTIONS` contract the Claude branch produces — id (`R#`), `path:line` (`file:line`), severity, claim (`issue`), suggested fix (`fix`), and the `challenge` question — so Steps 3/5/6 consume it identically. Empty `objections` array → treat as `NO_FLAGS` (write a clean `{S##}-REVIEW.md`, proceed).
- **exit != 0** → **single fallback** (no retry) to `Agent("forge-reviewer")` (the `challenger == 'claude'` invocation above), echo `⚠ challenger: $CHALLENGER indisponível (exit ≠ 0) — usando forge-reviewer`, and append a `review-challenger-fallback` event with `reason: "{challenger}-exit-nonzero"` (`codex-exit-nonzero` or `gemini-exit-nonzero`; cause is on the adapter's stderr). See **Fallback challenger (review-challenger-fallback)** (trigger b). The gate then continues with the agent's objections.

## Step 3 — Defense

Routed by `$RESOLVED_ADVOCATE` (from Step 0), symmetrically with Step 2: `claude` runs the in-context `forge-advocate`; `codex` / `gemini` run the adapter with `--mode defend --engine $XLLM_ENGINE_ADVOCATE`.

### `advocate == 'codex' | 'gemini'` (S01 adapter)

This is the branch that makes `advocate: auto` mean something for a GPT/Gemini author — before `--mode defend` existed, the defense of non-Claude code was always argued by a family that did not write it.

Render the objections into a temp file (the same `OBJECTIONS` contract Step 2 produced), then invoke the adapter. `--diff-cmd` is passed so the defender verifies claims against the real code instead of arguing from the objection text alone:

```bash
XLLM_ENGINE_ADVOCATE=$([ "$RESOLVED_ADVOCATE" = "gemini" ] && echo agy || echo codex)
if [ -n "$ADVOCATE_MODEL_EXTERNAL" ]; then
  node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode defend --engine "$XLLM_ENGINE_ADVOCATE" --input "$DEFENSE_INPUT" --diff-cmd "{DIFF_CMD}" --cwd {WORKING_DIR} --model "$ADVOCATE_MODEL_EXTERNAL"
else
  node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode defend --engine "$XLLM_ENGINE_ADVOCATE" --input "$DEFENSE_INPUT" --diff-cmd "{DIFF_CMD}" --cwd {WORKING_DIR}
fi
XLLM_DEFEND_EXIT=$?
```

- **exit 0** → stdout is JSON `{verdicts:[{id,verdict,rationale}]}` with `verdict ∈ refuted|conceded|open` — the exact contract the Claude branch produces, so Steps 4/5/6/7a consume it identically and never learn which family defended.
- **exit != 0** → **single fallback** (no retry) to `Agent("forge-advocate")` (the `claude` branch below), echo `⚠ advocate: $RESOLVED_ADVOCATE indisponível (exit ≠ 0) — usando forge-advocate`, and append a `review-pairing-fallback` event with `reason: "{advocate}-defend-exit-nonzero"`. **The debate then IS intra-family** — recompute `INTRA_FAMILY` against the advocate that actually ran, so the Step 6 header and the emitted event both say so. A fallback that silently keeps the pre-fallback pairing in the artifact is the exact drift this gate exists to surface.

`$ADVOCATE_MODEL_EXTERNAL` is `advocate_model` when its family matches the resolved external advocate, else empty (CLI default). A `claude-*` id must never be forwarded to `codex`/`agy` as `--model`.

### `advocate == 'claude'` (forge-advocate)

**`DEFENSE_FILE` — crash rail for the defense (M018).** The advocate's whole deliverable is prose in
its final message and it owns no artifact, so any truncation of that message loses **every** verdict
at once — including the ones already formed. Measured six times in M018 (S05, S06, S07×3): the
investigation happened, nothing arrived, and the orchestrator is forbidden from inventing verdicts in
its place, so six objections went to triage raw. Before dispatching, define

```bash
DEFENSE_FILE="{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-DEFENSE.md"   # task boundary: .gsd/tasks/{TASK_ID}/{TASK_ID}-DEFENSE.md
rm -f "$DEFENSE_FILE"   # a stale file from a previous attempt must never be read as this attempt's defense
```

and pass it in the prompt (`agents/forge-advocate.md § Persist as you go`): the advocate appends each
verdict line as it settles it, so a cut costs at most one verdict instead of all of them. It is the
advocate's **only** permitted write target.

`ADVOCATE_ALIAS` was resolved in Step 0 from `advocate_model` (default `claude-fable-5`) via `scripts/forge-model-alias.js`. **The `model:` of `forge-advocate`/`forge-reviewer` comes exclusively from resolved `$ADVOCATE_ALIAS`/`$CHALLENGER_MODEL`; literal sonnet/fable/opus/haiku is a violation detected post-hoc by `forge-review-audit.js`.** Pass `model:` only when the alias is non-empty:

```
if [ -n "$ADVOCATE_ALIAS" ]; then
```
```
Agent({ subagent_type: 'forge-advocate', model: '{ADVOCATE_ALIAS}',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nDEFENSE_FILE: {DEFENSE_FILE}\nOBJECTIONS:\n{OBJECTIONS}" })
```
```
else
  echo "⚠ advocate_model '$ADVOCATE_MODEL' sem alias — usando frontmatter"
```
```
Agent({ subagent_type: 'forge-advocate',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nDEFENSE_FILE: {DEFENSE_FILE}\nOBJECTIONS:\n{OBJECTIONS}" })
```
```
fi
```

**Guard Fable 400 (documented):** when the resolved model is `claude-fable-5*`, `thinking` MUST be `adaptive` (never `disabled`) — Fable 5 returns HTTP 400 on an explicit `thinking: {type: 'disabled'}`. The `Agent()` call above never injects `thinking` itself, so this is guaranteed by `agents/forge-advocate.md`'s own frontmatter (`model: claude-fable-5` + `thinking: adaptive`, changed together in the same commit).

**Scope of the override:** this `model:` override only applies to the `engine: agents` dispatch path above (Step 3). Under `engine: workflow`, the advocate runs as `agentType: 'forge-advocate'` inside the workflow script (see `## Engine workflow` below) — the script does not accept a per-call `model:` override, so the agent's own frontmatter (now Fable 5 by default) governs there instead.

Capture per-objection verdicts: `R# → {refuted | conceded | open} + rationale`.

**Salvage before declaring unavailability (LOCKED).** The advocate is `review-advocate-unavailable`
only when **neither** channel carries a verdict. Order of consultation:

1. **Inline `### Defense` block** in the returned message — authoritative when present.
2. **`DEFENSE_FILE`** — read it whenever the inline block is missing, or carries fewer lines than the
   number of objections, or the agent returned **only** the result block (the counts with no
   attribution — the exact M018 signature). Verdicts present in the file are used as the advocate's
   own; the file is the agent's own writing, so using it is **not** fabrication.
3. Ids missing from both stay `open` **cru**, with the caveat rendered in the artifact. Only when
   **zero** verdicts survive both channels do you emit `review-advocate-unavailable` and skip Step 4.

A partial defense is still a defense: Step 4 runs on the ids that have one. Never reconcile the file
against the result-block counts by guessing which objection a missing verdict belonged to — a
scoreboard without attribution stays a scoreboard.

A throw here → apply **§ Agent unavailability (review-agent-unavailable)** above: retry first (Retry Handler); if the advocate stays unavailable, emit `review-advocate-unavailable`, leave every objection `open` **cru** (no fabricated verdict), **skip Step 4 entirely**, and continue via the per-mode policy (interactive → human at Step 7b; auto → `defer` → Step 9).

## Step 4 — Rebuttal (rebuttal mode) × `rounds`

Skip if `rounds == 0`. Otherwise, for `i` in `1..rounds` (default 1), feed the defense back to the **same challenger** that ran Step 2 (LOCKED — a rebuttal is only meaningful from the agent that wrote the original objections). Routed by `challenger`. When Step 2.0 sharded, "the same challenger" is per objection: group the objections by their recorded `REVIEWER_AGENT_ID[R#]` and run the round once per author, sending each only the defense of its own objections. One shard → one group → identical to the unsharded flow.

### `challenger == 'claude'` (default agent)

**Preferred native continuation (Claude Code with `SendMessage`):** when
`REVIEWER_AGENT_ID` is non-empty and `SendMessage` is present in the
orchestrator's own tool list, resume the completed reviewer:

```
SendMessage({ to: REVIEWER_AGENT_ID,
  message: "REBUTTAL ROUND {i}/{rounds}. Review the DEFENSE below against the objections you already authored. Return only the maintained/withdrawn verdict contract from your agent instructions.\n\nDEFENSE:\n{DEFENSE}" })
```

Wait for that resumed subagent's completion notification before resolving the
round. A completed custom subagent auto-resumes in the background and retains its
full history. Claude Code currently exposes `SendMessage` only when
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; Forge never enables that experimental
flag itself. Reuse the same id for every round when the tool is present. This path
avoids re-sending `DIFF_CMD` and `OBJECTIONS` and avoids re-reading the diff.

**Compatibility fallback:** if `SendMessage` is absent, the send fails, or
`REVIEWER_AGENT_ID` is empty (older Claude Code / malformed tool result), emit a
`review-resume-fallback` event and use the legacy fresh dispatch below. Review
remains never-blocking.

```
Agent({ subagent_type: 'forge-reviewer',
  prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: complete-slice/{S##}\nDIFF_CMD: {DIFF_CMD}\nOBJECTIONS:\n{OBJECTIONS}\nDEFENSE:\n{DEFENSE}" })
```

Fallback event:

```json
{"ts":"<ISO-8601>","event":"review-resume-fallback","milestone":"{M###}","slice":"{S##}","round":N,"reason":"sendmessage-unavailable|missing-agent-id|sendmessage-failed"}
```

When `DEFENSE` is present the reviewer runs in **rebuttal mode** (`agents/forge-reviewer.md § Rebuttal mode`): it only re-litigates objections the advocate `refuted` or marked `open`, returning `maintained` or `withdrawn` + a reason. Objections the advocate `conceded` are carried through as `conceded` (settled — nothing to rebut). A throw here → apply **§ Agent unavailability (review-agent-unavailable)** above: retry first (Retry Handler); if the challenger stays unavailable at this stage, emit `review-rebuttal-unavailable` and carry every non-conceded objection through with the advocate's own verdict (`refuted`/`open`) **unchanged** — `maintained` is never stamped by the orchestrator, since that label means the challenger heard the defense and held its ground, which did not happen here. If Step 3 ended in `review-advocate-unavailable`, Step 4 **does not run at all** (see **§ Agent unavailability (review-agent-unavailable)**): the objections stay `open` cruas. Only the last round's verdicts count.

### `challenger == 'codex' | 'gemini'` (S01 adapter)

Write the OBJECTIONS + DEFENSE dialogue to a temp file (the adapter reads the rebuttal input from disk), then invoke the adapter (`--model "$CHALLENGER_MODEL"` only when non-empty, always quoted):

```bash
if [ -n "$CHALLENGER_MODEL" ]; then
  node scripts/forge-xllm.js --mode rebuttal --engine "$XLLM_ENGINE" --input "$REBUTTAL_INPUT" --cwd {WORKING_DIR} --model "$CHALLENGER_MODEL"
else
  node scripts/forge-xllm.js --mode rebuttal --engine "$XLLM_ENGINE" --input "$REBUTTAL_INPUT" --cwd {WORKING_DIR}
fi
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
           args: { wd: "{WORKING_DIR}", unit: "complete-slice/{S##}", diffCmd: "{DIFF_CMD}", defenseFile: "{DEFENSE_FILE}", rounds: {rounds} } })
```

**Script constraints:**
- Plain JS (no TypeScript annotations — TS breaks the runtime parser).
- **Body at top level** — após o `export const meta`, o corpo roda direto em contexto async. NUNCA embrulhar em `export default function`: o runtime lança `SyntaxError: Unexpected keyword export` (verificado empiricamente em 2026-06-10).
- `export const meta` must be a **literal** at the top (no variables, no interpolation).
- **PROHIBITED:** `Date.now()`, `new Date()`, `Math.random()` — the runtime throws on these; they also break resume.
- `rounds` always comes from `args` (never hardcoded).
- Truth table is deterministic code **inside the script** (not prose).
- Only the last rebuttal round's verdicts count.
- `defenseFile` is forwarded to the advocate as the same crash rail Step 3 defines. The sandbox has no `fs`, so the script itself cannot read it back — when the Defense phase yields `null` (throw/truncation) and the script falls through to `defesa indisponivel … tratada como open`, the **orchestrator** applies **§ Step 3 → Salvage before declaring unavailability** to `DEFENSE_FILE` after the Workflow returns, and replaces the placeholder `open` verdicts with the advocate's own recovered lines. Ids absent from the file keep the placeholder.

**The script:**

```js
export const meta = {
name: 'forge-review-dialectic',
description: 'Review dialetico: challenge (forge-reviewer) -> defense (forge-advocate) -> rebuttal x rounds -> resolucao deterministica',
phases: [{ title: 'Challenge' }, { title: 'Defense' }, { title: 'Rebuttal' }]
}

const { wd, unit, diffCmd, defenseFile, rounds } = args

// inline por necessidade — o sandbox do Workflow não tem require/fs; Section 52 guarda o sync com shared/schemas/*.json
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

// inline por necessidade — o sandbox do Workflow não tem require/fs; Section 52 guarda o sync com shared/schemas/*.json
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
    'WORKING_DIR: ' + wd + '\nUNIT: ' + unit + '\nDIFF_CMD: ' + diffCmd +
      (defenseFile ? '\nDEFENSE_FILE: ' + defenseFile : '') +
      '\nExecute DIFF_CMD from INSIDE WORKING_DIR (cd to it first) — the diff target lives there, not in your default cwd.\nOBJECTIONS:\n' + objText,
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
**Challenger:** {claude|codex|gemini} (<model|default>)
**Defender:** {advocate_model|alias}
{$PAIRING_LINE}
{$INTRA_FAMILY == true ? '**⚠ Adversarialidade reduzida:** refutação e juízo de tradeoff vêm da mesma família. Se o autor também é dessa família (o caso do default shipado), a objeção carrega o viés de auto-preferência que o pairing cross-family existe para evitar; se não é, o autor não está representado na própria defesa. Com `--mode defend` disponível isto indica pairing explícito ou degradação registrada — cheque `fallbacks` no evento.' : ''}

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

## Adversarialidade reduzida
- Quando `INTRA_FAMILY`, liste aqui itens `refuted+withdrawn`; são fechamentos sob viés intra-família.

## Pattern hits (scan determinístico)
- `path:line` — pattern `{p}` — <context>   ← optional; deterministic grep, same patterns as forge-completer step 4a

## Escopo do diff (SVN)                      ← only when `$SCOPE_REPORT` is non-empty (SVN boundary)
- **Baseline:** BASE (marker inerte — ver Step 1)
- **Critério:** {reason}
- **Revisados:** {scoped, one per line}
- **Fora do escopo:** {excluded, one per line — "(nenhum)" when empty}
- **Artefatos `.gsd/` omitidos:** {gsd_excluded}
```

Omit any section with zero items — **exceto** o bloco de indisponibilidade do caminho `review-agent-unavailable`, que é obrigatório sempre que um agente não pôde ser ouvido e nunca pode ser lido como aprovação (ver **§ Agent unavailability (review-agent-unavailable)**).

**`Challenger` line:** `claude` → `**Challenger:** claude`. External challenger with `challengerModel` set → `**Challenger:** codex (gpt-5-x)` / `**Challenger:** gemini (Gemini 3.1 Pro (High))`; model unset → `**Challenger:** codex (default do CLI)` / `**Challenger:** gemini (default do CLI)`. When a challenge fell back from the external CLI to the agent (`review-challenger-fallback` / `{challenger}-exit-nonzero`), stamp `**Challenger:** claude (fallback de codex)` / `**Challenger:** claude (fallback de gemini)` to keep the artifact honest about what actually ran. When the in-context challenger itself could not run (`review-challenger-unavailable`), stamp `**Challenger:** claude — indisponível (review-challenger-unavailable)`; the artifact then carries the mandatory unavailability block and states no review was performed.

**`Defender` line:** `ADVOCATE_ALIAS` non-empty → `**Defender:** {advocate_model} ({ADVOCATE_ALIAS})` (e.g. `**Defender:** claude-fable-5 (fable)`); `ADVOCATE_ALIAS` empty (id with no known alias) → `**Defender:** {advocate_model} (frontmatter — sem alias)`, matching the Step 3 warning. Advocate unavailable → `**Defender:** {advocate_model} — indisponível (review-advocate-unavailable)`, with the objections listed as `open` cruas and the reduced-adversariality caveat spelled out.

**`Pairing` line:** written verbatim as `$PAIRING_LINE` (assembled once in Step 0 — see "Regra de render da linha `**Pairing:**`" above). Format: `**Pairing:** <modo> — autor <engine> → challenger <família>`, with the ` (<policy>: <counts.claude> claude / <counts.codex> codex → autor <engine>)` suffix appended only when the resolution was mixed (`PAIR_POLICY` = `majority`|`tie-last`). Boundary-agnostic: identical for `S##-REVIEW.md` and `{TASK_ID}-REVIEW.md` — no per-boundary variant exists.

## Step 7a — Conceded fix dispatch (both modes)

A CONCEDED objection is a problem **both agents agree is real** — the confrontation already settled it. Recording it for a human to maybe-read later defeats the purpose of the debate. Fix it now, while the boundary diff is still intact (slice branch unmerged / task uncommitted scope).

Skip if `fixConceded == false` (pref opt-out → conceded items fall through to Step 7b posture as before) or there are zero CONCEDED items.

Before dispatching `review-fix`, compute `RF_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type review-fix --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).alias||'')}catch(e){}})")`; pass `model: '{RF_ALIAS}'` only when it is non-empty.

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
  - `Criar follow-up` — create an item per **§ Item capture** (source `review/{S##}/{R#}` or `review/{TASK_ID}/{R#}`, status `inbox`, `file`/`sha` from the finding, `body` = objeção + defesa one-liners) and append the pointer line to `.gsd/KNOWLEDGE.md § Review follow-ups` (create the section if missing)
  Write the chosen decision into the `**Decisão:**` line of that R# in `{S##}-REVIEW.md`; when the choice was `Criar follow-up`, the line records the item ID: `**Decisão:** follow-up → {I-id} — {title}`.
- **CONCEDED** items with `fixConceded == false`: list them and ask once whether to address now (follow-up task) or record-and-continue. Default record-and-continue.

**`MODE == auto` (forge-auto):**
- `askAuto == defer` (default) — **do NOT pause mid-loop.** Mark each OPEN item in `{S##}-REVIEW.md` with `**Decisão:** deferido → triagem no fim da milestone`. Echo one line to the user: `⚖ Review S##: {Y} concedida(s) corrigidas · {Z} aberta(s) → triagem final`. Continue the loop. Deferred items are **guaranteed to surface**: the milestone-final triage (Step 9) puts every one of them to the operator before `complete-milestone` runs. Defer means *postponed to end-of-milestone*, never *swallowed*.
- `askAuto == pause` (opt-in) — run the same `AskUserQuestion` flow as interactive mode, accepting the pause.
- `askAuto == gate` (opt-in) — **ask without pausing.** `AskUserQuestion` does not exist in a headless session (verified: absent from the `system/init` tool list), which is why `defer` exists at all. The gate mailbox (`scripts/forge-gate.js`) works around that: the question goes to a file, any responder answers it, and — decisively — **it always resolves**, taking the declared default when nobody replies in time. So the loop keeps its autonomy while the human gets a real chance to steer.

  For each OPEN item, run one gate and act on the resolution:

  ```bash
  RES=$(node "${FORGE_SCRIPTS}/forge-gate.js" --open --wait --json \
    --cwd "$WORKING_DIR" --run "${RUN_ID:-{M###}}" --unit "{S##}" --origin review-open \
    --question "$OBJECTION_SUMMARY" \
    --context "$OBJECTION_DETAIL" \
    --option "keep:Manter abordagem atual:Objeção registrada, sem ação" \
    --option "fix:Refatorar agora:Despacha um review-fix para este item" \
    --option "followup:Criar follow-up:Cria item no backlog (.gsd/items/) e segue" \
    --default followup \
    --timeout "${GATE_TIMEOUT_MS:-1800000}")
  CHOICE=$(printf '%s' "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).choice||'')}catch{console.log('')}})")
  SOURCE=$(printf '%s' "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).source||'')}catch{console.log('')}})")
  ```

  - `fix` → dispatch a `review-fix` unit for that item (same shape as Step 7a).
  - `keep` → write the decision into the `**Decisão:**` line, no item created.
  - `followup` (chosen OR `source == timeout-default`) → create an item per **§ Item capture** (source `review/{S##}/{R#}` or `review/{TASK_ID}/{R#}`, status `inbox`); when `source == timeout-default`, the item `body` notes `via gate — expirou`. **Nobody answering must never silently close an item — the timeout path still captures.**

  Record the provenance on the `**Decisão:**` line (`via gate — humano` vs `via gate — expirou`), so the artefact never claims a human made a call the clock made.

  `GATE_TIMEOUT_MS` defaults to 30min and is read from `review.gate_timeout_ms` when set. A run left alone overnight therefore behaves exactly like `defer` — the safe default is the one that happens when nobody is watching.

The gate **never** returns a blocker regardless of posture.

## Item capture (deferral → .gsd/items/)

Any junction that used to write a deferral note into a durable-but-easy-to-miss location (`KNOWLEDGE.md`, a review artifact that gets `milestone_cleanup`'d, a plan-gate marker) now creates a **work-item fragment** in `.gsd/items/` instead. This section defines the procedure exactly once — every consumer below (Step 7b, Step 9, and `shared/forge-plan-gate.md`) cross-references it rather than restating it.

**Invocation (canonical).** `scripts/forge-items.js --add` is the only write path. Build the payload as argv passed to a `node -e` one-liner that emits JSON on stdout, then pipe that into `--add` — never interpolate content directly into a JSON string literal (shell-quoting risk: a title or body containing a quote, backtick or `$()` would corrupt or inject into the JSON):

```bash
PAYLOAD=$(node -e "process.stdout.write(JSON.stringify({title: process.argv[1], origin: 'auto', status: process.argv[2], source: process.argv[3], file: process.argv[4] || undefined, sha: process.argv[5] || undefined, milestone: process.argv[6] || undefined, body: process.argv[7] || undefined}))" \
  "$TITLE" "$STATUS" "$SOURCE" "$FILE" "$SHA" "$MILESTONE" "$BODY")
RESULT=$(printf '%s' "$PAYLOAD" | node "$FORGE_SCRIPTS_DIR/forge-items.js" --add --cwd "$WORKING_DIR")
ITEM_ID=$(printf '%s' "$RESULT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id||'')}catch{console.log('')}})")
```

`ITEM_ID` (the `id` field of the `{id, path, created}` stdout) is what the pointer line records.

**Payload fields.** `title` and `origin: "auto"` are always present. `status` is `inbox` for every review/plan-gate junction and `triaged` for the blocked-unit junction (see `shared/forge-dispatch.md § Blocked capture` — out of scope for this file, referenced for completeness). `source` is always present (required by `validateItem` for `origin: auto`). `file` (`path:line`), `sha` (HEAD), `milestone` and `body` are included **only when actually known** — omit absent fields entirely, never write a placeholder value (empty string, `"unknown"`, `"n/a"`). A plan-gate deferral, for example, has no `file`/`sha` — the payload simply excludes those keys.

**Source formats (closed list — every junction in this spec and in `shared/forge-plan-gate.md` uses one of these; do not invent new shapes downstream):**
- `review/{S##}/{R#}` — review follow-up at a slice boundary.
- `review/{TASK_ID}/{R#}` — review follow-up at a standalone-task boundary (`forge-task`).
- `plan-gate/{S##}` — plan-gate deferral for `forge-next`.
- `plan-gate/{TASK_ID}` — plan-gate deferral for `forge-task`.
- `blocked/{unit_type}/{unit_id}` — a terminal blocked stop (a bare `unit_id`, e.g. `T01`, is ambiguous across slices — the type qualifies it). The failure class goes in the title, not the source: `[{classe}] {unit_type}/{unit_id} bloqueado — {resumo}`.

**Pointer-line format.** `- {I-id} — {title}` — exactly one line: the item ID and its title, never the full body/content. This is the only thing written into `KNOWLEDGE.md § Review follow-ups`, a `**Decisão:**` line, or a plan-gate approval marker.

**Dedup guard (blocked-unit reuse only).** Before `--add` on a `blocked/{unit_type}/{unit_id}` source, run `--list --json` and check for an existing item with the same `source` and a status that is not `done`/`dropped`; skip creation if one is found (a resumed unit that blocks again must not spawn a duplicate item).

**Advisory failure rule.** If `--add` exits non-zero, log a warning and fall back to a **universal durable note**: append the one-line note (no item ID) to `.gsd/KNOWLEDGE.md § Review follow-ups` (create the section if missing) — for **every** junction, regardless of which destination the junction normally writes its pointer line to. `KNOWLEDGE.md` survives `milestone_cleanup`; a junction's own marker (e.g. a plan-gate approval marker) does not, so the `KNOWLEDGE.md` note is what actually keeps the deferral from being lost. **Additionally** (not instead), still record the same one-line note in the junction's own destination (`**Decisão:**` line, plan-gate marker, etc.) for in-context visibility — but that copy is best-effort, not the durable one. Then continue. Item capture never blocks a gate, a review, or the loop — same posture as every other advisory mechanism in this spec.

**Headless rule.** Capture fires when the deferral is *recorded*, not when a human answers. A timeout-default resolution (Step 7b `followup` via the gate mailbox) and a headless Step 9 triage (no `AskUserQuestion` available) both still create the item — the absence of a human in the loop is not a reason to lose the deferral.

## Step 8 — Event log

**Never hand-write this row.** Call the emitter — it is the only sanctioned writer of the `review` event:

```bash
node "$FORGE_SCRIPTS_DIR/forge-review-emit.js" --cwd "$WORKING_DIR" \
  --milestone "${RUN_ID:-{M###}}" --slice "{S##}" \
  --style "$STYLE" --rounds N --engine "$ENGINE" \
  --author-engine "$AUTHOR_ENGINE" --challenger "$RESOLVED_CHALLENGER" \
  --advocate "$ADVOCATE_ALIAS" \
  --resolved N --conceded N --open N --conceded-fixed N \
  --intra-family-withdrawn N
```

Exit 2 means the invocation was malformed and **nothing was written** — fix the arguments and re-run; do not fall back to appending a hand-built line. I/O errors propagate (no silent-fail), same posture as before.

Shape written (documented for **readers of the log**, not for retyping — the emitter is the only writer):

```json
{"ts":"<ISO-8601>","event":"review","milestone":"${RUN_ID:-{M###}}","slice":"{S##}","style":"dialectic","rounds":N,"counts":{"resolved":N,"conceded":N,"open":N},"conceded_fixed":N,"engine":"agents","author_engine":"claude","challenger":"claude","advocate":"fable","intra_family_debate":true,"intra_family_withdrawn":0}
```

**Why a script and not a template.** The template that used to sit here was retyped per slice, and the retyping drifted: one measured workspace holds **265 `review` events in 151 distinct key shapes, none conformant**, with `advocate` values ranging from a clean alias (`fable`) to a full id (`claude-opus-5`) to a sentence (`not-invoked-orchestrator-verified-by-direct-reading`). Aggregating that history is impossible, which is why the intra-family collapse in M134/S02 was found by a human reading prose rather than by the field built to announce it. The emitter constructs the row from resolved values, so the shape cannot vary.

**`intra_family_debate` is derived by the emitter, not passed in.** It takes `--author-engine`, `--challenger` and `--advocate` and compares *family to family*. The `INTRA_FAMILY` bash in Step 0 compares `$ADVOCATE_FAMILY` (a family) against `$AUTHOR_ENGINE` (an engine); that is correct only while every advocate is Claude, and inverts the moment a gpt advocate exists (`'gpt' != 'codex'` is true for the same family). `$INTRA_FAMILY` still renders the Step 6 header and gates **§ Adversarialidade reduzida**, and the event's copy comes from the emitter — so the Step 0 bash and the emitter MUST encode the same rule. They are two evaluations of one predicate, not two predicates: when they drift, the log announces a collapse that the page a human reads denies, which is a more expensive way to be right than being wrong in one place. `intra_family_withdrawn` is clamped to `0` whenever the flag is false, so the two can never contradict each other.

**The flag means what its name says: both debaters came from one family.** It does *not* additionally require that family to differ from the author's. That extra clause reads like a refinement and is a blind spot: on the explicit path this spec sets `AUTHOR_ENGINE=claude` and the shipped prefs default `challenger`/`advocate` to `claude`, so author and both debaters land in one family and the clause would hold the flag at `false` on **every review of every default-configured project** — a debate with zero cross-family adversarialidade filed as "no collapse", which is the silence the emitter exists to end. A Claude challenging Claude-authored code defended by Claude *is* the collapse, author in the room or not. Expect the flag to read `true` under defaults; that is the honest reading, and it is the signal that argues for flipping `challenger: auto`.

**`--author-engine` is required.** The emitter refuses (exit 2, nothing written) when it is absent or resolves to no known family, because the alternative is deriving `false` — "measured, no collapse" — from an author it could not identify. `author_engine` is also **recorded** in the row, not merely consumed: a reader that cannot see the author cannot recompute the flag, and cannot separate "the debaters agreed on a family that is not the author's" (the M134/S02 shape) from "everyone, including the author, is in one family" (the default shape). Both are `true`; the field is what tells them apart. On the explicit path the recorded value is the `claude` this spec assumes, not a measurement — the `auto` path is where it is derived from dispatch authorship.

`conceded_fixed`, `engine`, `challenger` and `advocate` are additive fields (readers that ignore unknown fields stay compatible — same convention as `tier`/`reason` from M002). `engine` is either `"agents"` or `"workflow"` and is emitted by **both** engine paths. `conceded_fixed`: number of conceded items whose Step 7a fix landed. `challenger` is `"claude"`, `"codex"` or `"gemini"` — the challenger that actually ran the challenge (so an external→agent fallback records `"claude"`). `advocate` is the resolved `ADVOCATE_ALIAS` (e.g. `"fable"`) or JSON `null` when the id had no known alias (frontmatter governed instead) — same optional-field glue pattern as the rest of this event. `intra_family_withdrawn` is the count of items listed under **§ Adversarialidade reduzida** (`refuted+withdrawn` resolutions from the Step 5 truth table, **excluding** `open+withdrawn`) — always `0` when `intra_family_debate` is `false`.

**Agent unavailability (additive).** When a review `Agent()` stayed unavailable after the Retry Handler (see **§ Agent unavailability (review-agent-unavailable)**), append one extra line — it does **not** replace the `review` line above; both are emitted, and the Step 6 header is stamped honestly with what actually ran:

Emit it in the SAME emitter call that writes the `review` row — both lines are appended together, so a review can never land without its companion:

```bash
node "$FORGE_SCRIPTS_DIR/forge-review-emit.js" --cwd "$WORKING_DIR" \
  --milestone "${RUN_ID:-{M###}}" --slice "{S##}" ... \
  --unavailable-reason review-advocate-unavailable --attempts N
```

Shape written (for readers, not for retyping):

```json
{"ts":"<ISO-8601>","event":"review-agent-unavailable","milestone":"${RUN_ID:-{M###}}","slice":"{S##}","reason":"review-advocate-unavailable","attempts":N}
```

`reason` is a member of the closed enum (`review-advocate-unavailable` | `review-challenger-unavailable` | `review-rebuttal-unavailable`); `attempts` is the in-memory retry count when the agent was declared unavailable. `<ISO>` comes from bash (`date -u +%Y-%m-%dT%H:%M:%SZ`) — never from inside a script. Additive convention as above: readers that ignore unknown events/fields stay compatible.

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
6. **Write back.** Update the `**Decisão:**` line of every triaged R# in its `{S##}-REVIEW.md`. `Criar follow-up` items create an item per **§ Item capture** (source `review/{S##}/{R#}`) and append ONLY the pointer line — `- {I-id} — {title}` — to `.gsd/KNOWLEDGE.md § Review follow-ups` (create the section if missing; never the full content) so they survive `milestone_cleanup`.
7. **Headless fallback.** When `AskUserQuestion` is unavailable at this boundary (headless session, no gate mailbox configured for this junction), Step 4's per-item ask cannot run: instead, create one item per still-pending deferred objection (source `review/{S##}/{R#}`, status `inbox`, `body` noting `triagem não realizada — headless`) so the deferrals survive `milestone_cleanup` rather than dying silently in a `REVIEW.md` that will be cleaned up. Skip Steps 3–6's human-facing digest/triage in this branch; proceed straight to Step 8.
8. **Event.** Append to `events.jsonl`: `{"ts":"<ISO>","event":"review-triage","milestone":"{M###}","pending":N,"kept":N,"fixed":N,"follow_up":N}`. `follow_up` counts items created in either Step 6 or Step 7 — schema unchanged from before this cutover.
9. Proceed to dispatch `complete-milestone`. The triage **never blocks** the milestone — any failure is recorded and the close-out continues.

## Legacy `style: flags` single-pass

When `style == flags`: run Step 2 only — routed by `challenger` (so `codex`/`gemini` use the adapter's `--mode challenge --engine $XLLM_ENGINE`, `claude` uses `forge-reviewer`). Write the findings (+ optional pattern hits) into `{S##}-REVIEW.md` under a single `## ⚠ Review Flags` heading. No advocate, no rebuttal, no Ask. This reproduces the pre-dialectic advisory behavior for users who opt out of the debate.

## Cross-references
- `shared/forge-dispatch.md § Retry Handler` — retry/backoff ladder reused verbatim by **§ Agent unavailability (review-agent-unavailable)** (with the CRITICAL terminal action overridden there)
- `scripts/forge-classify-error.js` — deterministic classifier behind that retry decision (`unknown → retry:false`, fail-safe)
- `agents/forge-reviewer.md` — challenger + rebuttal mode
- `agents/forge-advocate.md` — defender
- `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` — gate invocation (before `complete-slice`) + milestone-final triage (Step 9, before `complete-milestone`)
- `scripts/forge-xllm.js` — S01 adapter for the external challengers (`--mode challenge|rebuttal`, `--engine codex|agy` — GPT via Codex CLI, Gemini via Antigravity CLI); parsing/validation lives there, not here
- `forge-agent-prefs.jsonc § Review Settings` — `review.{mode,style,rounds,ask_in_auto,fix_conceded,engine,challenger,challenger_model,advocate_model}`
- `scripts/forge-items.js` — the work-item fragment store consumed by **§ Item capture** (`--add`/`--list` CLI; single write path for `Criar follow-up` and every other deferral junction below)
- `shared/forge-plan-gate.md § Deferir resolution` — the sibling consumer of **§ Item capture** for plan-gate deferrals (does not restate the invocation)
- Artifact: `.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` (durable with the milestone; cleaned by `milestone_cleanup`)
- Artifact: `.gsd/items/*.md` (work items created by this spec; durable — never cleaned by `milestone_cleanup`)
