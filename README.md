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

## Comandos principais

| Comando | O que faz |
|---------|-----------|
| `/forge` | Shell interativo — entry point principal |
| `/forge-init` | Inicializa o projeto GSD |
| `/forge-new-milestone` | Cria milestone com discuss + plan (alias — delega ao `/forge`) |
| `/forge-auto` | Executa o milestone inteiro (alias — delega ao `/forge`) |
| `/forge-next` | Executa uma unidade e para |
| `/forge-status` | Dashboard de progresso |
| `/forge-codebase` | Qualidade do codebase (`--fix` para correções) |
| `/forge-explain` | Explica qualquer artefato GSD |
| `/forge-discuss` | Abre discussão de arquitetura |
| `/forge-prefs` | Configuração de modelos e git |
| `/forge-help` | Ajuda completa |

[Referência completa de comandos](docs/commands.md)

---

## Skills

| Skill | O que faz |
|-------|-----------|
| `forge-brainstorm` | Explora alternativas e riscos antes de planejar |
| `forge-scope-clarity` | Contrato de escopo com critérios testáveis |
| `forge-risk-radar` | Análise de riscos por slice |
| `forge-security` | Análise de segurança por task/slice |
| `forge-responsive` | Audit responsivo — Core Web Vitals, WCAG 2.2 |
| `forge-ui-review` | Review UI — acessibilidade, performance, React 19 |

[Documentação de skills](docs/skills.md)

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
