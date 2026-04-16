---
name: forge-status
description: "Dashboard do projeto — milestone ativo, slices, proxima acao."
allowed-tools: Read, Glob, Bash
---

## Bootstrap guard (sempre executar primeiro)

Before doing anything else, run these in parallel:
```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
```

```bash
REPO=$(grep 'repo_path:' ~/.claude/forge-agent-prefs.md 2>/dev/null | cut -d: -f2 | tr -d ' ')
if [ -n "$REPO" ] && [ -d "$REPO/.git" ]; then
  LOCAL=$(cd "$REPO" && git describe --tags --always 2>/dev/null)
  REMOTE=$(cd "$REPO" && git ls-remote --tags origin 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
  echo "FORGE_VERSION=$LOCAL"
  [ -n "$REMOTE" ] && [ "$REMOTE" != "$(cd "$REPO" && git describe --tags --abbrev=0 2>/dev/null)" ] && echo "FORGE_UPDATE=$REMOTE" || echo "FORGE_UPDATE=none"
else
  echo "FORGE_VERSION=unknown"
  echo "FORGE_UPDATE=none"
fi
```

**Se CLAUDE.md não existe:** Stop and tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop and tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/forge-init` para começar.

**Se `.gsd/AUTO-MEMORY.md` não existe:** Create it silently before proceeding:
```
<!-- gsd-auto-memory | project: <from PROJECT.md or directory name> | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

---


Read these files in order and produce a status dashboard:

1. `.gsd/STATE.md` — current position
2. Active `M###-ROADMAP.md` — slice completion status
3. Active `S##-PLAN.md` — task completion status (if a slice is active)
4. Glob `.gsd/tasks/*/TASK-*-BRIEF.md` — list all forge-tasks

Report in this format:
```
## Status GSD

**Forge Agent:** {FORGE_VERSION}  {if FORGE_UPDATE != none: "⚠ Nova versão disponível: {FORGE_UPDATE} — /forge-update"}
**Milestone ativo:** M### — Title
**Progresso:** X/Y slices concluídos

### Slices
- [x] S01: Title
- [ ] S02: Title  ← ativo
  - [x] T01: done
  - [ ] T02: pending  ← próxima tarefa
  - [ ] T03: pending

### Próxima ação
<exact next action from STATE.md>

### Token usage (M###)
<token usage block — see instructions below>

### Blockers
<list or "Nenhum">

### Tasks autônomas
{If .gsd/tasks/ exists and has entries, list each TASK-### with its status:}
- ✓ TASK-001: <description> (done — SUMMARY.md exists)
- ▶ TASK-002: <description> (em andamento — last phase with existing file)
- · TASK-003: <description> (pendente — só BRIEF.md)
{If no tasks: omit this section entirely}
```

---

## Token usage — geração do bloco

**Só executar se STATE.md tem um milestone ativo.** Se não há milestone, omitir o bloco inteiro.

Run the following to aggregate token telemetry for the active milestone and render the `### Token usage` block:

```bash
ACTIVE_M=$(grep -oE 'M[0-9]{3}' .gsd/STATE.md | head -1)
if [ -z "$ACTIVE_M" ]; then
  # No active milestone — omit Token usage block entirely
  :
elif [ ! -f .gsd/forge/events.jsonl ]; then
  echo "Sem dados de telemetria ainda."
else
  node -e "
// Aggregate dispatch events for the active milestone.
// Matching strategy: all events recorded AFTER the milestone's first dispatch timestamp.
// This is a best-effort heuristic because unit_id for slice/task phases is S## or T##, not M###.
const fs = require('fs');
const activeM = process.env.ACTIVE_M;
const raw = fs.readFileSync('.gsd/forge/events.jsonl', 'utf8').trim();
if (!raw) { console.log('Sem dados de telemetria ainda.'); process.exit(0); }

const lines = raw.split('\n');
const events = lines.flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });

// Find the first dispatch event that directly names the active milestone
const milestoneFirst = events.find(e =>
  e.event === 'dispatch' && e.unit && e.unit.includes(activeM)
);
if (!milestoneFirst) { console.log('Sem dados de telemetria ainda.'); process.exit(0); }

const startTs = milestoneFirst.ts;
const dispatches = events.filter(e =>
  e.event === 'dispatch' &&
  e.ts >= startTs &&
  typeof e.input_tokens === 'number' &&
  typeof e.output_tokens === 'number'
);
if (dispatches.length === 0) { console.log('Sem dados de telemetria ainda.'); process.exit(0); }

const totalIn = dispatches.reduce((s, e) => s + e.input_tokens, 0);
const totalOut = dispatches.reduce((s, e) => s + e.output_tokens, 0);

// Phase order per dispatch table
const phaseOrder = [
  'plan-milestone','discuss-milestone','research-milestone',
  'plan-slice','discuss-slice','research-slice',
  'execute-task','complete-slice','complete-milestone','memory-extract'
];
const byPhase = {};
dispatches.forEach(e => {
  const phase = e.unit ? e.unit.split('/')[0] : 'unknown';
  byPhase[phase] = (byPhase[phase] || 0) + 1;
});
const fmt = n => n.toString().replace(/\B(?=(\d{3})+\$)/g, ' ');
const phaseStr = phaseOrder
  .filter(p => byPhase[p] > 0)
  .map(p => p + ' ' + byPhase[p])
  .join(' · ');
console.log('### Token usage (' + activeM + ')');
console.log('- Total input:  ' + fmt(totalIn) + ' tokens');
console.log('- Total output: ' + fmt(totalOut) + ' tokens');
console.log('- Dispatches:   ' + dispatches.length + ' (por fase: ' + phaseStr + ')');
" ACTIVE_M="$ACTIVE_M"
fi
```

Replace the `### Token usage (M###)` placeholder line in the dashboard template with the output of this block. If the output is `Sem dados de telemetria ainda.`, render it as a single line under the heading.

$ARGUMENTS
