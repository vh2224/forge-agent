---
name: forge-prefs
description: "Catálogo de preferências do forge-agent — todos os knobs do schema com estado/valor/camada/descrição, e um caminho de edição via forge-prefs-migrate.js --set."
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash
---

## Input
$ARGUMENTS

---

## O que este skill faz

Superfície completa do motor de preferências JSONC (M008): lista **todos os
knobs do schema** (`forge-prefs.schema.json`), agrupados por seção, cada um com:

- **estado** — ATIVO (usuário setou em alguma camada) ou desligado (default do schema)
- **valor resolvido** — o valor efetivo, ativo ou default
- **camada de origem** — `global` (`~/.claude/`), `local` (`.gsd/`), `mixed`, ou `—` (default)
- **descrição** — a linha do `schema.description` daquele knob (auto-didata, fonte única)

O motor real é `scripts/forge-prefs-view.js` (`renderView(cwd)` / `buildCatalog(cwd)`
/ CLI `--view|--json`). Este skill NUNCA reimplementa a leitura do schema, a
resolução de camadas ou a escrita de catálogos — apenas invoca o helper e, na
edição, delega a `scripts/forge-prefs-migrate.js --set` (primitivo
block-preserving já testado em S05). Resolver o script: preferir
`scripts/forge-prefs-view.js` do repo; se ausente, `${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-prefs-view.js`.

---

## Operações

### Sem argumento, "show" ou "list"

Rode o helper e exiba a saída **verbatim** — não resuma, não reformate:

```bash
SCRIPT=$([ -f scripts/forge-prefs-view.js ] && echo scripts/forge-prefs-view.js || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-prefs-view.js")
node "$SCRIPT" --cwd .
```

A saída já traz, nesta ordem: fonte de cada camada (`jsonc` / `md-legacy` — com
aviso para migrar / `absent`), erros de parse (`✗`) e avisos de valor inválido
(`⚠`) se houver, legenda `● ATIVO / ○ desligado`, e o catálogo completo
agrupado pelas 38 seções na ordem do schema.

Se `layers.global.source == "md-legacy"` ou `layers.local.source == "md-legacy"`
na saída, mencione ao usuário que `node scripts/forge-prefs-migrate.js --cwd .`
migra para JSONC sem risco de perda (gate `resolvedDiff`, round-trip provado).

Para ver qual modelo roda cada fase e onde configurá-lo: `/forge-prefs phases`.

---

### "phases"

Rode o helper e imprima a saída verbatim — não resuma, não reformate:

```bash
SCRIPT=$([ -f scripts/forge-phases.js ] && echo scripts/forge-phases.js || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-phases.js")
node "$SCRIPT" --cwd .
```

---

### "set \<dotted.key\> \<value\> [global|local]"

Exemplos válidos:
- `/forge-prefs set review.rounds 2`
- `/forge-prefs set skip_research true local`
- `/forge-prefs set tier_models.heavy claude-opus-5 global`

Rota **sempre** pelo primitivo `--set` de `forge-prefs-migrate.js` — nunca edite
um `.jsonc` de preferências manualmente com `Edit`/`Write`:

```bash
MIGRATE=$([ -f scripts/forge-prefs-migrate.js ] && echo scripts/forge-prefs-migrate.js || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-prefs-migrate.js")
node "$MIGRATE" --set "<dotted.key>=<value>" --cwd . [--layer global|local] [--create]
```

Regras:
- **`$schema` é recusado.** É metadata de tooling (o hook de referência do
  catálogo), não uma preferência. `set $schema ...` retorna erro
  (`$schema é metadata de tooling, não pode ser setado como preferência`) e
  **não** delega ao `--set`. No `show`, o `$schema` aparece com o marcador `◆`
  e a anotação "metadata de tooling — não é preferência" em vez de
  ATIVO/desligado.
- `<value>` é interpretado como JSON quando possível (`true`, `2`, `"texto"`,
  `["a","b"]`); caso contrário cai para string literal. Passe o argumento do
  usuário sem aspas extras — o parser (`parseSetExpression`) já cobre isso.
- Camada: se o usuário não especificar, o primitivo escolhe `local` quando
  `.gsd/` existe no projeto atual, senão `global`. Se o alvo for `local` e o
  catálogo ainda não existir, adicione `--create` (senão retorna
  `local-create-required`, sem escrever nada).
- `--set` falha com exit≠0 se a chave não existir no schema, se o valor violar
  `type`/`enum`, ou se a pós-verificação (`getDottedValue` no resolved final)
  não bater — nesses casos, mostre o `stderr` ao usuário e não afirme sucesso.

Após um `--set` bem-sucedido, **re-rode o viewer** para confirmar visualmente
o novo estado (mesmo comando de "show" acima) e mostre apenas o knob alterado
mais o header de camadas — não repita o catálogo inteiro na confirmação.

```
✓ review.rounds atualizado

  Antes: desligado (default: 1)
  Agora: ATIVO = 2   (camada: local)
```

---

### "models" (compatibilidade retroativa — roteamento por fase legado)

Mantido do skill anterior a M008: alguns usuários ainda pensam em "modelo por
fase" em vez de `tier_models`/`routing`. Trate como um atalho de leitura sobre
o catálogo atual — não uma rota de escrita separada.

```
MODELOS DISPONÍVEIS NO CLAUDE CODE

  opus    claude-opus-5 (fallback: claude-opus-4-8[1m])
          Modelo mais capaz. Ideal para: discuss, research, plan, tier heavy/max.

  sonnet  claude-sonnet-5
          Modelo balanceado (padrão para execução). Ideal para: execute, complete, tier standard.

  haiku   claude-haiku-4-5-20251001
          Modelo mais rápido e barato. Ideal para: memory extraction, tier light.

Para mudar o modelo de um tier:
  /forge-prefs set tier_models.<tier> <alias ou model ID>

Exemplos:
  /forge-prefs set tier_models.heavy opus
  /forge-prefs set tier_models.standard claude-sonnet-5
```

### "set \<phase\> \<model\>" (alias legado)

Fases válidas: `discuss`, `research`, `plan`, `execute`, `complete`, `memory`
— mapeadas para o tier equivalente (ver `shared/forge-tiers.md`):

Para a resolução ao vivo por unit_type, domínio e chave de configuração, use
`/forge-prefs phases` e consulte `shared/forge-tiers.md`.

Converta o alias de modelo (`opus`/`sonnet`/`haiku`) para o model ID completo
se necessário, e rode:

```bash
node "$MIGRATE" --set "tier_models.<tier>=<model-id>" --cwd . [--layer global|local] [--create]
```

Confirme:
```
✓ Fase 'execute' (tier standard) atualizada

  Antes: claude-sonnet-5
  Agora: claude-opus-5
```

Modelo não reconhecido (nem alias nem ID válido):
```
Modelo desconhecido: '{input}'

Modelos disponíveis:
  opus    → claude-opus-5 (fallback claude-opus-4-8[1m])
  sonnet  → claude-sonnet-5
  haiku   → claude-haiku-4-5-20251001
```

---

### "reset"

Não existe um primitivo `--reset` no motor JSONC (M008): resetar significa
remover as linhas ativas de um knob, voltando-o ao default do schema. Para o
caso geral, oriente o usuário a editar o `.jsonc` da camada e recomentar a
linha (prefixo `// `) ou remover a entrada ativa duplicada. Não implemente um
mutator de reset ad-hoc aqui — está fora do escopo deste skill (S06/T01); é
um candidato de task futura em `forge-prefs-migrate.js` se houver demanda.

---

### Referência completa

Para a lista longa (todos os knobs do schema, com tipo, enum, default e descrição
completa, fora do contexto de uma sessão), aponte o usuário para
`shared/forge-prefs-reference.md` (gerado por `scripts/forge-prefs-reference.js`,
T03 deste slice) — é o documento de referência versionado, complementar ao
`/forge-prefs show` interativo.

---

## Notas de implementação (para quem editar este skill)

- **Fonte única de verdade:** `forge-prefs.schema.json` — nunca hardcode uma
  descrição, default ou lista de knobs aqui. O helper (`forge-prefs-view.js`)
  lê o schema em runtime; qualquer prosa fixa neste arquivo sobre "quais são
  os knobs" ficaria desatualizada na primeira mudança de schema.
- **Nunca escreva `.jsonc` de preferências diretamente.** Toda mutação
  passa por `forge-prefs-migrate.js` (`setPreference`/`--set`), que preserva
  blocos comentados existentes byte-a-byte e verifica o resultado antes de
  reportar sucesso.
- `--resolved --explain` (o CLI de `forge-prefs.js`) só retorna knobs ATIVOS —
  o viewer funde isso com `loadSchema()`/`defaultsFromSchema()` para mostrar o
  universo completo. Ver comentário no topo de `scripts/forge-prefs-view.js`.
