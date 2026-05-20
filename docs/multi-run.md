# Multi-Run Workspace (M004+)

A partir do milestone M004, o Forge Agent suporta **N orquestradores simultâneos** no mesmo workspace. Você pode rodar `/forge-auto M065` em um terminal e `/forge-auto M066` em outro, ambos contra o mesmo `.gsd/`, sem corrupção de estado.

## TL;DR

```bash
# Terminal A
$ /forge-auto M065

# Terminal B (mesmo workspace, mesmo .gsd/)
$ /forge-auto M066

# Ambos rodam até completar. Statusline mostra:
# ● AUTO ×2 │ M065 ⚡T03 +12s │ M066 🔥S04 +1m
```

Sem mudança de fluxo pra workspaces single-run — comportamento legado preservado quando há 0 ou 1 run ativa.

## Arquitetura

### State distribuído

| Antes (single-run) | Depois (multi-run) |
|---|---|
| `.gsd/STATE.md` source-of-truth | `.gsd/STATE.md` = **dashboard read-only** auto-gerado |
| — | `.gsd/milestones/M###/M###-STATE.md` = source-of-truth da run |
| `.gsd/forge/auto-mode.json` único | `.gsd/forge/runs/{id}.json` por run (auto-mode.json vira alias do oldest) |

### Globais agora per-run + merge no fim

Durante uma run, decisões/memórias/eventos vão pra arquivos per-milestone. No `complete-milestone`, o `forge-completer` invoca `scripts/forge-merger.js` que promove tudo pros globais sob `mkdir`-lockfile.

| Per-milestone (durante run) | Global (merged on complete) |
|---|---|
| `M###-DECISIONS.md` | `.gsd/DECISIONS.md` |
| `M###-AUTO-MEMORY.md` | `.gsd/AUTO-MEMORY.md` (cap-50 + decay) |
| `M###-CHECKER-MEMORY.md` | `.gsd/CHECKER-MEMORY.md` |
| `M###-LEDGER-ENTRY.md` | `.gsd/LEDGER.md` (append) |
| `M###-events.jsonl` | `.gsd/forge/events.jsonl` (append) |

Zero contention entre runs — cada um toca apenas seu próprio diretório. Lockfile só na merge phase, que é one-shot e curto.

### Runs registry

`.gsd/forge/runs/{id}.json` — uma por run ativa:

```json
{
  "kind": "milestone",
  "id": "M065",
  "session_id": "claude-session-abc",
  "active": true,
  "started_at": 1779203140063,
  "last_heartbeat": 1779203195000,
  "worker": "execute-task/T03",
  "worker_started": 1779203180000,
  "isolation_mode": "shared",
  "milestone_dir": ".gsd/milestones/M065/",
  "cwd": "C:/DEV/projeto"
}
```

Schema completo em [`shared/forge-state.md`](../shared/forge-state.md) §2.

### Hooks session-aware

`scripts/forge-hook.js` resolve a run dona via `data.session_id` do payload do Claude Code:
- Evidence vira `evidence-{runId}-{unitId}.jsonl` (em vez de `evidence-{unitId}.jsonl`)
- Heartbeat atualiza `runs/{id}.json` correto
- PostCompact escreve `compact-signal-{sessionId}.json` per-session (legacy `compact-signal.json` mantido)

## CLI

### Sem argumento

- **0 runs ativas** → lê `.gsd/STATE.md` legado (single-run compat)
- **1 run ativa** → assume retomar, msg `↺ Retomando única run ativa: M065`
- **2+ runs ativas** → refuse + lista IDs + exemplos

### Com argumento `M###`

- Run não existe → registra fresh
- Run existe + ativa → resume

### Tasks

`/forge-task <descrição>` registra `kind:"task"` em `runs/{id}.json` com ID `task-{slug}-{shortuuid}`. Diretório `.gsd/tasks/{TASK_ID}/` continua sendo o artifact home (compat).

## Isolation modes

Configurável em `forge-agent-prefs.md`:

```yaml
forge_isolation:
  mode: shared          # shared | branch | worktree (default: shared)
```

### `shared` (default)

Single working tree. Concorrência cross-run protegida por **file-locks** no `PreToolUse` hook:
- Lock path: `.gsd/forge/file-locks/{base64url(rel_path)}.json`
- TTL: 60s + steal-on-inactive (lê runs/ pra checar se holder ainda vivo)
- Quando bloqueia: orquestrador detecta exit 2, retry 3× com backoff 5-30s jitter, surface se esgotar

Zero overhead pra workspaces single-run. Recomendado para projetos solo ou início de adoção.

### `branch`

Alinhado com fluxo Git Flow. Cada run cria `forge/{M###}` em cada repo afetado:

```bash
forge_isolation:
  mode: branch
  branch_pattern: "forge/{M###}"
  auto_pull_main: true       # git pull main antes de criar
  pr_on_complete: false      # opt-in
```

Workers commitam em `forge/M###`. Conflitos cross-run viram merge-time, resolvidos pelo operador via PR.

### `worktree`

Isolation física total. Cada run roda numa worktree separada:

```bash
forge_isolation:
  mode: worktree
  worktree_root: ".forge-worktrees"
  worktree_cleanup_on_complete: false   # opt-in — manual review by default
```

Cria `.forge-worktrees/{M###}/{repo}/` per repo. Zero risco de overlap. Custos: disco × N milestones, IDE complexity.

### Multi-repo auto-detect

```yaml
forge_isolation:
  repos:
    auto_detect: true       # walk subdirs com .git/
    exclude:
      - "node_modules/**"
      - "vendor/**"
    include: []             # quando setado, ignora auto_detect
```

Funciona out-of-the-box em workspaces tipo monorepo (Lookchina omnichannel = 10 repos sob a raiz).

## Statusline

- 0-1 runs: visual legado (rico, mostra last_outcome, retry, burn rate)
- 2-3 runs: compacto — `● AUTO ×2 │ M065 ⚡T03 +12s │ M066 🔥S04 +1m`
- 4+ runs: trunca — `● AUTO ×4 │ M065 │ M066 │ M067 · +1 mais`

## Pause + compact recovery

- `/forge-pause` (sem arg, 1 run) → toggla aquela
- `/forge-pause M065` → toggla scoped `.gsd/forge/pause-M065`
- `/forge-pause` (2+ runs, sem arg) → refuse + lista
- Compact recovery escopado: `compact-signal-{sessionId}.json` (per-tab)

## Backward compatibility

**Workspaces existentes (single-run, sem `runs/*.json`) funcionam idêntico.** Primeira run multi:
1. `forge-runs.migrateLegacyState(cwd)` lê `.gsd/STATE.md` legado
2. Extrai Active Milestone → cria `M###-STATE.md` correspondente
3. Regenera `.gsd/STATE.md` como dashboard
4. Backup do legacy = `.gsd/STATE.pre-compact.md` (criado pelo PreCompact hook automaticamente)

Nada é apagado — apenas reformatado.

## Troubleshooting

### `Múltiplas runs ativas` ao rodar /forge-auto sem ID

Esperado. Especifique o ID: `/forge-auto M065`. Lista IDs no error message.

### Run mostrou ⚠ STALE no dashboard

Run sem heartbeat há >5min. Provavelmente Ctrl+C ou kill no terminal. Próximo `/forge-*` boot a remove (>30min) ou você pode forçar:
```bash
node ~/.claude/scripts/forge-runs.js --remove M065
```

### Arquivo em uso por outra run

Hook bloqueia Write/Edit cross-run. Orquestrador retenta com backoff. Se travar:
```bash
# Ver quem segura
node ~/.claude/scripts/forge-filelock.js --check src/conflict.ts

# Liberar (caso seguro)
node ~/.claude/scripts/forge-filelock.js --release src/conflict.ts --run M065
```

### Quero ver o que cada run está fazendo

```bash
# Statusline mostra em tempo real
# Ou:
node ~/.claude/scripts/forge-runs.js --list-active

# Ou regenere o dashboard
node ~/.claude/scripts/forge-dashboard.js
cat .gsd/STATE.md
```

### `mkdir-mutex` não funciona no meu FS

Testado em POSIX (Linux/macOS) e NTFS (Windows). Não testado em NFS / certas SMB configurações. Se observar lock corruption, abra issue + use mode worktree (isolamento físico).

## Reference

| Script | Função |
|---|---|
| `scripts/forge-runs.js` | Registry CRUD |
| `scripts/forge-state.js` | Per-milestone STATE read/write |
| `scripts/forge-lock.js` | mkdir-mutex |
| `scripts/forge-dashboard.js` | Regenera `.gsd/STATE.md` |
| `scripts/forge-merger.js` | Promove per-milestone → globals |
| `scripts/forge-cli-helpers.js` | Resolve args + refuse logic |
| `scripts/forge-filelock.js` | File ownership tracking (shared mode) |
| `scripts/forge-repos.js` | Auto-detect repos via walk |
| `scripts/forge-isolation.js` | Setup/cleanup branch/worktree |

| Doc | O que cobre |
|---|---|
| [`shared/forge-state.md`](../shared/forge-state.md) | Schemas canônicos |
| [`forge-agent-prefs.md`](../forge-agent-prefs.md) `forge_isolation:` | Configuração |
| [`.gsd/milestones/M004/M004-CONTEXT.md`](../.gsd/milestones/M004/M004-CONTEXT.md) | 12 decisões D-M004-1..12 |
