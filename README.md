<p align="center">
  <img src="assets/forge-logo.svg" alt="Forge Agent" width="120" height="120" />
</p>

<h1 align="center">Forge Agent for Claude Code</h1>

<p align="center">
  Workflow de desenvolvimento autônomo — planejamento, execução, verificação e git<br>
  gerenciado por agentes especializados com memória emergente.
</p>

<p align="center">
  Baseado na metodologia <a href="https://github.com/gsd-build/gsd-2">GSD-2</a> (MIT) — reimplementado para o sistema nativo de agentes do Claude Code.
</p>

---

## O que você ganha

- Hierarquia **Milestone → Slice → Task** com contexto fresco por unidade
- Agentes especializados por fase (Opus para pensar, Sonnet para executar)
- Memória emergente — o sistema aprende padrões e gotchas do seu projeto
- Git automático — branch por slice, squash merge, commits semânticos
- Tudo em arquivos `.md` — recuperável após crash, auditável, versionável

---

## Quick start

```bash
git clone https://github.com/<seu-usuario>/forge-agent
cd forge-agent
bash install.sh            # macOS/Linux
# .\install.ps1            # Windows
```

```bash
cd /seu/projeto
claude
```

```
/forge-init minha plataforma de e-commerce com Next.js
/forge-new-milestone autenticação de usuários com NextAuth
/forge
```

O `/forge` é o shell interativo principal — navega entre milestones, executa unidades e responde perguntas sem sair do REPL.

Verificar instalação: `/forge-help`

---

## Arquitetura v1.0 — 3 comandos + skills

A partir da v1.0, o Forge Agent usa **3 comandos slash** e **skills** para tudo o mais:

| Tipo | Exemplos | Como invocar |
|------|---------|--------------|
| Comando slash | `/forge`, `/forge-init`, `/forge-update` | Digitar `/` no Claude Code |
| Skill | `forge-auto`, `forge-status`, `forge-new-milestone`... | Via `/forge` REPL ou digitando o nome |

### Comandos slash

| Comando | O que faz |
|---------|-----------|
| `/forge` | **Entry point principal** — REPL interativo com menu: auto, task, new-milestone, status, help |
| `/forge-init [descrição]` | Inicializa o projeto GSD — cria `CLAUDE.md` + `.gsd/` + prefs |
| `/forge-update [caminho]` | Atualiza Forge Agent (git pull + reinstala). Preserva preferências. |

### Skills de execução e planejamento

| Skill | O que faz |
|-------|-----------|
| `forge-auto` | Executa o milestone inteiro de forma autônoma até concluir |
| `forge-next` | Executa exatamente uma unidade e para (step mode) |
| `forge-task <descrição>` | Task autônoma sem milestone — brainstorm → discuss → plan → execute |
| `forge-new-milestone <descrição>` | Cria milestone completo — brainstorm → scope → discuss → ROADMAP |
| `forge-discuss <milestone\|S##>` | Abre fase de discuss para milestone ou slice |
| `forge-add-slice`, `forge-add-task` | Adiciona slice ou task a um milestone existente |

### Skills de visibilidade e manutenção

| Skill | O que faz |
|-------|-----------|
| `forge-status` | Dashboard de progresso — milestone, slices, próxima ação |
| `forge-doctor [--fix]` | Diagnóstico do projeto — valida e corrige STATE, arquivos, prefs |
| `forge-codebase [--fix]` | Qualidade do codebase — lint, nomenclatura, estrutura |
| `forge-sweep [--apply]` | Limpa know-how (AUTO-MEMORY, DECISIONS, milestones, sessões) — dry-run por padrão |
| `forge-explain <alvo>` | Explica qualquer artefato GSD sem modificar nada |
| `forge-memories` | Gerencia memórias auto-aprendidas do projeto |
| `forge-ask` | Modo conversa — discute ideias, captura decisões |
| `forge-prefs` | Configuração de modelos por fase e git settings |
| `forge-config`, `forge-mcps` | Status line, hooks e MCPs |
| `forge-help` | Ajuda completa |

### Skills de qualidade (invocadas automaticamente ou manualmente)

| Skill | O que faz |
|-------|-----------|
| `forge-brainstorm` | Explora alternativas e riscos antes de planejar |
| `forge-scope-clarity` | Contrato de escopo com critérios testáveis |
| `forge-risk-radar` | Análise de riscos por slice (auto-invocada em slices `risk:high`) |
| `forge-security` | Checklist de segurança por task (auto-invocada por keywords) |
| `forge-responsive` | Audit responsivo — Core Web Vitals, WCAG 2.2 |
| `forge-ui-review` | Review UI — acessibilidade, performance, React 19 |

> **Compatibilidade retroativa:** IDs legados no formato `M###` (ex.: `M006`) e `TASK-###` continuam sendo lidos e resolvidos normalmente — `--resume`, `/forge-explain` e `/forge-discuss` aceitam ambos os formatos. Novos milestones e tasks soltas criados pelo forge geram IDs no formato timestamp `M-<ts>-<slug>` / `T-<ts>-<slug>` (ex.: `M-20260522101500-pagamentos`).

---

## Fragment store + projection

Forge Agent stores `.gsd/` knowledge (ledger, decisions, auto-memory) as **per-unit fragments**
instead of mutable monolith files — one small file per milestone, session, or task.

Three stores live under `.gsd/`:

| Store | Path | Contents |
|-------|------|----------|
| Ledger | `.gsd/ledger/<id>.md` | Compact record of each completed milestone |
| Decisions | `.gsd/decisions/<id>.md` | Architecture decisions scoped to a unit |
| Memory | `.gsd/memory/<id>.md` | Auto-learned patterns from completed work |

The familiar monolith files (`LEDGER.md`, `DECISIONS.md`, `AUTO-MEMORY.md`) are **projection
cache** — rebuilt on-read by [`scripts/forge-projection.js`](scripts/forge-projection.js) and
excluded from version control (`.gitignore`/`svn:ignore`). This makes the stores
conflict-free by construction: each fragment has exactly one owner (one unit of work, one
developer, one branch).

Migration from the pre-M001 monolith layout runs automatically during `/forge-update` and
keeps a `.bak` copy of every monolith until you verify the projection matches.

For full details — layout, fragment schema, projection engine, migration, and doctor checks —
see [docs/fragment-store.md](docs/fragment-store.md).

---

## Documentação

| Doc | Conteúdo |
|-----|----------|
| [Arquitetura](docs/architecture.md) | Fluxo de execução, agentes, modelos, memória emergente |
| [Comandos](docs/commands.md) | Referência completa de todos os comandos |
| [Skills](docs/skills.md) | Skills incluídas, como instalar e contribuir |
| [Configuração](docs/configuration.md) | Preferências, status line, arquivos do projeto |

> **Nota — `review.engine: workflow` e approval prompt:** quando `review.engine: workflow` está configurado, cada debate de review usa a tool `Workflow` do Claude Code (requer ≥ v2.1.154). Em `permissions.defaultMode` padrão, **cada invocação Workflow pede aprovação do operador** — o que pausa o `forge-auto` silenciosamente. Para uso autônomo, configure `permissions.defaultMode: bypassPermissions` (usuários com a statusline ativa já têm — ativado pelo `merge-settings.js`). Se a tool `Workflow` não estiver disponível ou a invocação falhar, o gate faz **fallback automático para `engine: agents`** com um warning e regista o evento `review-engine-fallback` — nunca bloqueia.

> **Pré-requisito — `review.challenger: codex`:** o challenger Codex requer o [Codex CLI](https://github.com/openai/codex) (`codex`) instalado e autenticado, por um destes dois caminhos:
>
> - **Login por assinatura ChatGPT** (recomendado): `codex login` — abre um fluxo de browser, credencial gerenciada pelo próprio CLI.
> - **`OPENAI_API_KEY`** no ambiente: exporte a variável de uma fonte segura (`.env` gitignored ou secret manager) — **nunca** hardcoded em prefs commitáveis (`.gsd/claude-agent-prefs.md` é versionado; uma chave ali seria vazamento).
>
> O forge **não instala nem autentica** tooling de terceiros — apenas invoca o `codex` já configurado pelo usuário via `scripts/forge-xllm.js`, que nunca recebe a credencial por argumento (a auth é gerenciada inteiramente pelo próprio CLI). Sem `codex` disponível, o gate faz **fallback automático para `forge-reviewer` (Claude)** com o evento `review-challenger-fallback` — nunca bloqueia. Implicação de privacidade: com `challenger: codex`, o diff do slice sai da máquina local para a API da OpenAI.

---

## Multi-LLM fase 2 — workers GPT via sidecar

Além do challenger de review Codex (acima), o forge permite rotear as próprias fases de trabalho —
`execute-task` e `plan-slice` — para GPT via o mesmo sidecar `codex exec`, através das prefs
`workers.execute-task: codex` / `workers.plan-slice: codex` (ver
[`forge-agent-prefs.md` § Workers Settings](forge-agent-prefs.md)). O default continua `claude`
— é **opt-in**, não uma migração de engine.

Mecanicamente, `scripts/forge-xllm.js --mode execute|plan` invoca `codex exec` como sidecar,
lê um plano (`T##-PLAN.md`) e retorna um result-file estruturado (`status`, `summary`,
`must_haves_status`, `files_changed`, `start_sha`) — mesma interface de contrato que um worker
Claude nativo devolveria. Isso significa que **todos os gates de verificação Claude rodam
intactos sobre código produzido por GPT**: o schema `must_haves` continua enforcing, o
goal-backward verifier continua auditando os artefatos declarados, o file-audit continua
comparando o diff contra `expected_output`, e o review dialético continua rodando — com o
challenger Claude revisando o código GPT. É a **inversão simétrica** do challenger Codex do M004
(lá, GPT revisa código Claude; aqui, Claude revisa código GPT).

### Limitações

Três limitações são aceitas e documentadas explicitamente — não são bugs, são o contrato atual:

1. **Blast radius `workspace-write`:** o sidecar de execução roda `codex exec --sandbox
   workspace-write` — um raio de ação mais amplo que o `--sandbox read-only` do challenger de
   review (M004). O invariante "`.gsd/` intocado, nenhum `git commit` feito pelo sidecar" é
   **contrato + detecção pós-hoc** (o orquestrador confere o diff depois), **não é
   sandbox-enforced** pelo próprio `codex`. Na prática, isso significa que o raio de ação de um
   eventual prompt-injection no conteúdo processado é igual ao workspace inteiro, não limitado
   a leitura. Aceite essa superfície antes de ativar `workers.execute-task: codex` em repositórios
   sensíveis.
2. **Evidence sintetizado, não capturado ao vivo:** para um worker Claude nativo, cada chamada
   Bash/Write/Edit grava uma linha no evidence log em tempo real (hook `PostToolUse`). Para o
   sidecar codex, o evidence é **sintetizado pós-hoc** a partir de `git diff --name-status
   {START_SHA}` ao final da execução (`source: codex-sidecar`) — é **advisory**, útil para
   auditoria, mas não tem a granularidade por-chamada do caminho nativo. Como o invariante
   no-commit mantém `HEAD == {START_SHA}`, esse `git diff --name-status` **não inclui arquivos
   novos não-rastreados (untracked)** — para tasks que criam arquivos, o evidence log fica quase
   vazio. A lista de arquivos autoritativa não é esse evidence: é o result JSON do sidecar
   (`files_changed_declared`, declarado pela task, mais `files_changed`, derivado de `git status
   --porcelain`, que captura untracked) — é essa fonte que o file-audit usa, não o
   `--name-status`. Blind spot residual aceito: arquivos **gitignored** criados pelo sidecar não
   aparecem nem no `--name-status` nem no `git status --porcelain`, e não são removidos pelo
   reset `git clean -fd` (sem `-x`) — fora do escopo de detecção atual.
3. **Sem retry do trabalho codex (fail-once):** se o sidecar falhar por qualquer motivo (exit
   code ≠ 0, timeout, JSON de result-file inválido), o orquestrador reseta o repositório para
   `START_SHA` e faz **um único** fallback ao worker Claude equivalente — não há retry do
   trabalho GPT. Uma falha do sidecar custa, no máximo, uma tentativa perdida.

---

## Multi-LLM fase 3 — pairing de review por autoria

A partir da M006, cada review dialético resolve seu challenger e advocate **pela autoria do código**, não por explícito. Via prefs `review.challenger: auto` e `review.advocate: auto` — que permanecem desativadas por padrão (`claude` / `claude`), decisão pós-dogfood:

- **`challenger: auto`** → resolve para a família **OPOSTA** ao autor (Claude code → GPT challenger; GPT code → Claude challenger). Reduz viés de auto-preferência: um desafiante de fora encontra classes de bug que dois Claudes não acham.
- **`advocate: auto`** → resolve para a **MESMA família** do autor (autor Claude → advocate Claude; autor GPT → advocate Claude, enquanto `--mode defend` não existe em fase 2). Mantém a defesa competente.

Autoria é derivada do campo `engine` dos dispatch events (`.gsd/forge/events.jsonl`), agregada por majority determinística — o orquestrador chama `scripts/forge-review-pairing.js` uma única vez por review antes da challenge. Degradações (autor sem evento de autoria, ou GPT sem `--mode defend` disponível) emitem `review-pairing-fallback` e retornam ao padrão Claude — nunca bloqueiam. Matriz canônica de resolver sem redefini-la: `shared/forge-review.md § Step 0`.

**Ativar:** edite `forge-agent-prefs.md` (ou `.gsd/prefs.local.md`):
```yaml
review:
  challenger: auto    # resolve de verdade na próxima review dialética
  advocate: auto      # resolve junto
```

---

## Atualizar

```bash
cd forge-agent
git pull
bash install.sh --update
```

Preferências e arquivos de projeto nunca são sobrescritos.

---

## Créditos

Reimplementação dos conceitos do **[GSD-2 (gsd-pi)](https://github.com/gsd-build/gsd-2)** para o sistema nativo de agentes do Claude Code. Hierarquia Milestone → Slice → Task, contexto fresco por unidade, memória emergente, workflow de fases e git branch-per-slice são designs originários do gsd-2.

Este repositório não distribui nem modifica código do gsd-2 — apenas reimplementa os conceitos usando arquivos `.md`.

## Licença

MIT — veja [LICENSE](LICENSE)
