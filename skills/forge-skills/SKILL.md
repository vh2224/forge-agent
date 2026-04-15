---
name: forge-skills
description: "Lista skills disponiveis e detalhes de uso."
disable-model-invocation: true
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

**Skills GSD instaladas** (prefixo `forge-`):

Para cada skill com nome começando em `forge-`:

```
📦 forge-brainstorm
   Brainstorming estruturado antes do planejamento de milestone.
   → Usado em: /forge-new-milestone (automático)
   → Manual:   /forge-new-milestone -brainstorm <desc>
   → Pular:    /forge-new-milestone -fast <desc>

📦 forge-risk-radar
   Análise de risco por slice antes da execução.
   → Usado em: /forge-auto (automático em slices risk:high)
   → Manual:   orquestrador roda antes de executar slices high-risk

📦 forge-scope-clarity
   Contrato de escopo com critérios observáveis.
   → Usado em: /forge-new-milestone (automático)
   → Manual:   /forge-discuss -scope M###
```

---

**Outras skills instaladas** (não-Forge, disponíveis para uso manual):

Para cada skill sem prefixo `forge-`, listar nome + description em uma linha:
```
• review          — Review code changes for security, performance, bugs
• lint            — ...
• debug-like-expert — ...
```

Ao final, mostrar:
```
Total: N skills Forge + M outras skills instaladas

Como usar skills com GSD:
  /forge-skills <nome>    ver detalhes e exemplos de uma skill específica
  /forge-skills --all     listar todas as skills com integrações GSD
  /forge-skills install   ver como instalar novas skills
```

---

## Com nome de skill — detalhes e exemplos

Se o argumento for um nome de skill (ex: `brainstorm`, `forge-brainstorm`, `review`):

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
    /forge-new-milestone <desc>           ← skill roda automaticamente
    /forge-new-milestone -fast <desc>     ← pular esta skill

  Para rodar manualmente:
    Me peça: "rode a skill forge-brainstorm para o milestone X"

FLAGS DISPONÍVEIS NESTA SKILL:
  -fast       Pular esta skill completamente
  (outras flags se existirem no SKILL.md)
```

---

## "--all" — mapa completo de integrações

Mostrar tabela:

```
SKILL               FASE GSD              COMANDO               FLAG SKIP
──────────────────────────────────────────────────────────────────────────
forge-brainstorm    nova milestone        /forge-new-milestone  -fast
forge-scope-clarity nova milestone        /forge-new-milestone  -fast
forge-risk-radar    plan → execute        /forge-auto           —
forge-brainstorm    discuss               /forge-discuss        -fast

Outras skills (invocar manualmente pedindo ao agente):
review              qualquer fase         —                     —
lint                execute / complete    —                     —
debug-like-expert   execute (blocker)     —                     —
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
    # Veja ~/.agents/skills/forge-brainstorm/SKILL.md como exemplo

ADICIONAR AO FORGE-AGENT (para que todos recebam ao instalar):
  Coloque a skill em forge-agent/skills/<nome>/
  Abra um PR no repositório
```
