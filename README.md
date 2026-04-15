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
| `forge-discuss <M###\|S##>` | Abre fase de discuss para milestone ou slice |
| `forge-add-slice`, `forge-add-task` | Adiciona slice ou task a um milestone existente |

### Skills de visibilidade e manutenção

| Skill | O que faz |
|-------|-----------|
| `forge-status` | Dashboard de progresso — milestone, slices, próxima ação |
| `forge-doctor [--fix]` | Diagnóstico do projeto — valida e corrige STATE, arquivos, prefs |
| `forge-codebase [--fix]` | Qualidade do codebase — lint, nomenclatura, estrutura |
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

---

## Documentação

| Doc | Conteúdo |
|-----|----------|
| [Arquitetura](docs/architecture.md) | Fluxo de execução, agentes, modelos, memória emergente |
| [Comandos](docs/commands.md) | Referência completa de todos os comandos |
| [Skills](docs/skills.md) | Skills incluídas, como instalar e contribuir |
| [Configuração](docs/configuration.md) | Preferências, status line, arquivos do projeto |

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
