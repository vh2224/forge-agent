---
description: "Lista skills disponíveis e explica como usar com os comandos GSD. Use: /gsd-skills | /gsd-skills brainstorm | /gsd-skills --all"
allowed-tools: Read, Bash, Glob
---

## O que fazer

$ARGUMENTS

---

## Sem argumento ou "list" — mostrar skills GSD disponíveis

Scan these directories for installed skills:
```bash
ls ~/.agents/skills/ 2>/dev/null
ls ~/.claude/skills/ 2>/dev/null
```

For each skill found, read its `SKILL.md` frontmatter (`name:` and `description:` fields).

Then display in this format:

---

**Skills GSD instaladas** (prefixo `gsd-`):

Para cada skill com nome começando em `gsd-`:

```
📦 gsd-brainstorm
   Brainstorming estruturado antes do planejamento de milestone.
   → Usado em: /gsd-new-milestone (automático)
   → Manual:   /gsd-new-milestone -brainstorm <desc>
   → Pular:    /gsd-new-milestone -fast <desc>

📦 gsd-risk-radar
   Análise de risco por slice antes da execução.
   → Usado em: /gsd-new-milestone (automático em slices risk:high)
   → Manual:   /gsd S##  (o orquestrador roda antes de executar slices high-risk)

📦 gsd-scope-clarity
   Contrato de escopo com critérios observáveis.
   → Usado em: /gsd-new-milestone (automático)
   → Manual:   /gsd-discuss -scope M###
```

---

**Outras skills instaladas** (não-GSD, disponíveis para uso manual):

Para cada skill sem prefixo `gsd-`, listar nome + description em uma linha:
```
• review          — Review code changes for security, performance, bugs
• lint            — ...
• debug-like-expert — ...
```

Ao final, mostrar:
```
Total: N skills GSD + M outras skills instaladas

Como usar skills com GSD:
  /gsd-skills <nome>    ver detalhes e exemplos de uma skill específica
  /gsd-skills --all     listar todas as skills com integrações GSD
  /gsd-skills install   ver como instalar novas skills
```

---

## Com nome de skill — detalhes e exemplos

Se o argumento for um nome de skill (ex: `brainstorm`, `gsd-brainstorm`, `review`):

1. Find the skill in `~/.agents/skills/<name>/SKILL.md` or `~/.claude/skills/<name>/SKILL.md`
2. Read the full `SKILL.md`
3. Display:

```
📦 <nome da skill>
<description>

COMO FUNCIONA:
<objective section do SKILL.md em linguagem simples>

INTEGRAÇÃO COM GSD:
<qual comando GSD usa esta skill, quando, e como invocar manualmente>

USAR AGORA:
  Para brainstorming de um milestone:
    /gsd-new-milestone <desc>           ← skill roda automaticamente
    /gsd-new-milestone -fast <desc>     ← pular esta skill

  Para rodar manualmente:
    Me peça: "rode a skill gsd-brainstorm para o milestone X"

FLAGS DISPONÍVEIS NESTA SKILL:
  -fast       Pular esta skill completamente
  (outras flags se existirem no SKILL.md)
```

---

## "--all" — mapa completo de integrações

Mostrar tabela:

```
SKILL               FASE GSD              COMANDO          FLAG SKIP
──────────────────────────────────────────────────────────────────────
gsd-brainstorm      nova milestone        /gsd-new-milestone   -fast
gsd-scope-clarity   nova milestone        /gsd-new-milestone   -fast
gsd-risk-radar      plan → execute        /gsd, /gsd-auto      —
gsd-brainstorm      discuss               /gsd-discuss         -fast

Outras skills (invocar manualmente pedindo ao agente):
review              qualquer fase         —                    —
lint                execute / complete    —                    —
debug-like-expert   execute (blocker)     —                    —
```

---

## "install" — como instalar novas skills

```
INSTALAR SKILLS DO ECOSSISTEMA SKILLS.SH:

  npx skills add <repositório> --skill <nome> -y

Exemplos:
  npx skills add odra/superpowers --skill brainstorm -y
  npx skills add dpearson2699/swift-ios-skills --skill swiftui-layout-components -y

Onde ficam:
  ~/.agents/skills/<nome>/SKILL.md     ← detectado pelo gsd-pi
  (copie também para ~/.claude/skills/ para usar com este agente)

CRIAR SUA PRÓPRIA SKILL:
  Use a skill "create-skill" se estiver instalada:
    Me peça: "crie uma skill para <domínio>"

  Ou crie manualmente:
    mkdir ~/.agents/skills/minha-skill
    # Crie SKILL.md com frontmatter name + description + XML structure
    # Veja ~/.agents/skills/gsd-brainstorm/SKILL.md como exemplo

ADICIONAR AO GSD-AGENT (para que todos recebam ao instalar):
  Coloque a skill em gsd-agent/skills/<nome>/
  Abra um PR no repositório
```
