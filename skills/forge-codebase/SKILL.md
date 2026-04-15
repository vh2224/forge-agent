---
name: forge-codebase
description: "Qualidade do codebase — lint, nomenclatura. Flags: --fix, --paths."
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob
---

## Modos
- (sem flags) -> diagnóstico apenas, sem escrita
- `--fix` -> diagnóstico + correção (somente correções mecânicas seguras)
- `--fix --dry-run` -> prévia do que `--fix` faria, sem escrita
- `--force` -> ignora cache e força re-análise completa

FIX_MODE = `--fix` in $ARGUMENTS. DRY_RUN = `--dry-run` in $ARGUMENTS. FORCE = `--force` in $ARGUMENTS.

## Regras de segurança
- Nunca rodar `git init`.
- Nunca deletar arquivos ou reescrever histórico.
- Nunca mover/renomear código automaticamente (a menos que o usuário peça explicitamente).
- Só executar ferramentas explicitamente configuradas no repo (scripts do package.json, etc).
- Tudo estrutural vira plano em `.gsd/QUALITY-PLAN.md`.

## Convenção
Cada checagem gera achados. Em modo correção, aplique a correção. Em diagnóstico/prévia, apenas reporte.
Emita uma linha por achado: `✓/⚠/✗/🔧/👁/⏭  <message>`.

---

## Princípios de análise

> **Medir o que importa, não o que é fácil de medir.**
>
> - Performance: o gargalo real são roundtrips, não I/O. → Minimizar tool calls.
> - Análise: o sinal real é aderência contextual, não estatística global. → Classificar por papel/contexto.
>
> Toda checagem segue este contrato:
> 1. **Segmentar** por contexto (diretório, papel, linguagem) antes de julgar.
> 2. **Excluir** padrões sabidamente corretos (barrel files, test files, entry points).
> 3. **Graduar** severidade — não tratar 301 linhas igual a 3000.
> 4. **Zero falso positivo** é mais valioso que alta cobertura.

---

## Modelo de execução

> Cada tool call custa ~1-3s de latência de API. Este comando DEVE completar em no máximo **3 roundtrips sequenciais** no caminho frio e **2 roundtrips** no caminho quente (cache hit).
>
> - **NÃO** faça tool calls separadas para cada métrica.
> - **NÃO** faça tool calls para classificação ou análise — processe os dados inline.
> - **SEMPRE** agrupe tool calls independentes em uma única mensagem (paralelo).

```
CACHE HIT:   Round 1 (reads paralelos) → cache match → exibir report → FIM
CACHE MISS:  Round 1 (reads paralelos) → Round 2 (mega-bash) → análise inline → Round 3 (writes) → FIM
FIX_MODE:    Round 1 (reads paralelos) → Round 2 (mega-bash) → análise inline → Round 3 (writes + lint/format) → FIM
```

---

## Round 1 — Bootstrap (tool calls em paralelo)

Disparar TODAS estas tool calls em uma única mensagem:

| # | Tool | Alvo | Extrai |
|---|------|------|--------|
| 1 | Read | `.gsd/STATE.md` | Se falhar → `Projeto não inicializado. Execute /forge-init.` → PARAR |
| 2 | Read | `.gsd/PROJECT.md` | Nome do projeto |
| 3 | Read | `.gsd/CODING-STANDARDS.md` | ROOTS (tabela Directory Conventions), convenções |
| 4 | Read | `package.json` | scripts (lint, format, typecheck), dependências |
| 5 | Read | `.gsd/.codebase-cache-hash` | Hash anterior para cache check |
| 6 | Bash | `ls pnpm-lock.yaml yarn.lock package-lock.json pyproject.toml requirements.txt Pipfile go.mod Cargo.toml 2>/dev/null` | Stack, lockfiles, PM |

> 6 tool calls paralelas = **1 roundtrip** (~2s).

### Após Round 1, processar inline (zero tool calls):

**ROOTS** — resolver na seguinte ordem:
1. `--paths` do $ARGUMENTS (vírgulas → array, validar existência)
2. Tabela "Directory Conventions" de CODING-STANDARDS.md
3. Auto-detect: `src lib app packages services components server client scripts commands agents skills tests __tests__`
4. Fallback: `.` com aviso

**PM** — detectar:
- `pnpm-lock.yaml` → pnpm | `yarn.lock` → yarn | `package-lock.json` → npm | else → npm

**Scripts** — extrair de package.json: `lint`, `lint:fix`, `format`, `format:fix`, `typecheck`/`tsc`

**CODING-STANDARDS** ausente:
- FIX_MODE: criar via auto-detect (adicionar ao Round 3)
- diagnóstico: `⚠ CODING-STANDARDS ausente`

---

## Cache gate (inline, entre Round 1 e 2)

Se **não** FORCE e **não** FIX_MODE e o Read de `.gsd/.codebase-cache-hash` retornou um hash:
- Guardar CACHED_HASH para comparação no Round 2.

Se FORCE ou FIX_MODE:
- Ignorar cache, prosseguir direto ao Round 2.

---

## Round 2 — Mega-collection (1 único Bash)

**UMA ÚNICA tool call Bash** que coleta TODOS os dados. Substituir `ROOTS` pelos valores resolvidos no Round 1.

> **IMPORTANTE**: NÃO reconstruir o script manualmente. Chamar o script pronto:

```bash
bash ~/.claude/scripts/codebase-collect.sh apps packages
```

Substituir `apps packages` pelos ROOTS reais. O script produz todas as seções separadas por `::LABEL::`.

Se o script não existir (`command not found`), copiar de: `$(grep -m1 'repo_path:' ~/.claude/forge-agent-prefs.md | cut -d: -f2 | tr -d ' ')/scripts/codebase-collect.sh`

> 1 tool call = **1 roundtrip**. Produz TUDO: fingerprint, file list, line counts, exports, defs, funções, tamanhos, frontend checks.

---

## Análise inline (zero tool calls)

Processar TODA a saída do mega-bash inline. **Nenhuma tool call adicional.**

### Cache check

Comparar `::FINGERPRINT::` com CACHED_HASH do Round 1:
- Se iguais: emitir `⏭ Cache hit — nenhuma alteração desde a última análise.`, ler `.gsd/.codebase-cache.md` e exibir. **PARAR** (1 Read extra = 2 roundtrips total).

---

### A3: Estrutura do repositório

Fonte: `::FILES::`

Identificar arquivos na raiz (path sem `/`). Classificar cada um:

**Esperados na raiz** (não flagar):
- Entry points: `index.*`, `main.*`, `app.*`, `server.*`, `cli.*`
- Config: `*.config.*`, `*.setup.*`, `tsconfig.*`, `package.*`, `.*rc`, `Makefile`, `Dockerfile`

**Inesperados na raiz** (flagar apenas estes):
- Qualquer outro arquivo de código na raiz quando `src/` ou `lib/` existem nas ROOTS.

Achados:
- Se ROOTS="." → `⚠ Nenhuma raiz de código detectada; revise --paths ou CODING-STANDARDS.`
- Cada arquivo inesperado na raiz → `⚠ Código solto na raiz: <file>. Mover para src/?`
- Correção: nunca mover. FIX_MODE → adicionar ao QUALITY-PLAN.

---

### A4: Convenções de nomenclatura (arquivos) — por contexto

Fonte: `::FILES::` — usar path completo (diretório + basename).

> **Princípio**: convenções de nomenclatura variam por papel. Componentes React são PascalCase, utils são kebab-case, hooks são camelCase. Mistura global não é problema se cada contexto é consistente internamente.

**Passo 1 — Segmentar por papel.** Agrupar arquivos pelo diretório-role (primeiro nível significativo do path):

| Diretório contém | Role | Convenção esperada |
|---|---|---|
| `components`, `pages`, `views`, `layouts`, `screens` | UI component | PascalCase |
| `hooks` | Hook | camelCase (prefixo `use`) |
| `utils`, `helpers`, `lib`, `services`, `api`, `middleware` | Utility | kebab-case ou camelCase |
| `tests`, `__tests__`, `spec` | Test | segue a convenção do source que testa |
| `types`, `interfaces`, `models` | Type/Model | PascalCase |
| `config`, `scripts` | Config/Script | kebab-case |

Se o diretório não estiver na tabela, inferir a convenção dominante DENTRO do diretório.

**Passo 2 — Checar consistência dentro de cada grupo.**
- Para cada grupo com >=3 arquivos: verificar se >=80% dos arquivos seguem a convenção esperada.
- Outliers são arquivos que desviam da convenção do SEU grupo, não da média global.

**Passo 3 — Reportar.**
- Grupo consistente → `✓ <role>: <convenção> (N arquivos)`
- Outliers dentro de grupo → `⚠ <role>: <arquivo> deveria ser <convenção esperada>`
- Grupo com <3 arquivos → não reportar (amostra insuficiente)

Correção: nunca renomear. FIX_MODE → outliers ao QUALITY-PLAN.

---

### A5: Nomenclatura de funções — por tipo semântico

Fonte: `::FUNCS::` — cada linha tem `filepath:line:match`.

> **Princípio**: o tipo da função determina sua convenção correta. Componentes React são PascalCase, hooks camelCase com prefixo `use`, funções Python snake_case (PEP8). Mistura entre tipos é esperada e correta.

**Passo 1 — Classificar cada função por tipo.**

| Sinal (do match + filepath) | Tipo | Convenção correta |
|---|---|---|
| Arquivo `.tsx`/`.jsx` + nome PascalCase + `function` | React Component | PascalCase |
| Nome começa com `use` + camelCase | Hook | camelCase |
| Arquivo `.py` + `def` | Python function | snake_case |
| Nome começa com `__` e termina com `__` | Dunder (Python) | **excluir** da análise |
| Nome é ALL_CAPS | Constante | **excluir** da análise |
| Arquivo `.ts`/`.js` + `function`/`const` | JS/TS utility | camelCase |

**Passo 2 — Checar aderência por tipo.**
- Cada função é avaliada contra a convenção do SEU tipo, não contra a média global.
- Agrupar por tipo. Tipos com <5 funções → não reportar.

**Passo 3 — Reportar.**
- Tipo consistente → `✓ <tipo>: <convenção> (N funções)`
- Outliers → `⚠ <tipo>: <nome> em <arquivo>:<linha> deveria ser <convenção>`

Correção: nunca renomear. FIX_MODE → outliers ao QUALITY-PLAN.

---

### A6: Hotspots de responsabilidade — graduado com exclusões

Fonte: `::LINES::`, `::EXPORTS::`, `::DEFS::`

> **Princípio**: tamanho só é sintoma quando acompanhado de mistura de responsabilidades. Um arquivo de 400 linhas com uma única responsabilidade é saudável. Um barrel file com 20 exports é seu propósito. Um test file com 15 defs é normal.

**Passo 1 — Classificar papel do arquivo.**

De `::FILES::`, identificar:
- **Barrel file**: nome é `index.ts`/`index.js` (qualquer variante)
- **Test file**: path contém `test`, `spec`, `__tests__` OU nome contém `.test.`, `.spec.`, ou prefixo `test_`
- **Config file**: nome contém `.config.`, `.setup.`, ou está na raiz
- **Source file**: todo o resto

**Passo 2 — Aplicar limiares graduados APENAS a source files.**

| Métrica | Normal | `⚠` Atenção | `✗` Crítico |
|---------|--------|-------------|-------------|
| Linhas | ≤500 | 501–800 | >800 |
| Exports (JS/TS) | ≤8 | 9–15 | >15 |
| Top-level defs (Python) | ≤10 | 11–20 | >20 |

Barrel files: **excluir** de export check (re-exportar é sua função).
Test files: **excluir** de def check (muitos test functions é normal).
Config files: **excluir** de todos os checks.

**Passo 3 — Hotspot composto (severidade aumentada).**
- Arquivo que atinge `⚠` em UMA métrica → `⚠ <arquivo>: <métrica> (<valor>)`
- Arquivo que atinge `⚠` em DUAS+ métricas → `✗ Hotspot composto: <arquivo> — <N linhas>, <N exports/defs>`

Correção: nunca dividir. FIX_MODE → hotspots ao QUALITY-PLAN com recomendação de split.

---

### A7: Lint/format

Fonte: scripts extraídos do package.json no Round 1.

Diagnóstico:
- Scripts existem → `✓ Lint: <script>`, `✓ Format: <script>`.
- Ausentes → `⚠ Nenhum comando de lint/format detectado.`

Correção (Round 3):
- `lint:fix` → `RUN run lint:fix`
- `format:fix` → `RUN run format:fix`
- Sem scripts → apenas reportar. Nunca inventar comandos.

---

### A8: Eficiência e orçamento de tokens

Fonte: `::PROMPT_SIZES::`, `::MD_SIZES::`

| Arquivo | Normal | `⚠` Atenção | `✗` Crítico |
|---------|--------|-------------|-------------|
| CLAUDE.md / AUTO-MEMORY / CODING-STANDARDS | ≤15KB | 15–30KB | >30KB |
| Outros .md em commands/ e .gsd/ | ≤40KB | 40–80KB | >80KB |

Correção: nunca reduzir. FIX_MODE → ao QUALITY-PLAN.

---

### A9: Higiene do repositório

Fonte: Bash do Round 1 (lockfiles), `::LARGE_FILES::`

- Mais de 1 lockfile → `⚠ Múltiplos lockfiles; escolher um.`
- Cada arquivo em `::LARGE_FILES::` → `⚠ Arquivo grande no repo: <file>. Considerar .gitignore ou LFS.`
- Correção: nunca deletar. FIX_MODE → ao QUALITY-PLAN.

---

### A10: Frontend quality (auto-detectado)

Fonte: `::FRONTEND::` — ativado SOMENTE se `components > 0`.

> Se `::FRONTEND::` reporta `components=0`, pular esta seção inteiramente.

**Surface checks (dados já coletados, zero I/O):**

| Check | Fonte | Critério | Severity |
|-------|-------|----------|----------|
| `<img>` sem `alt` | `---IMG_TAGS---` — linhas sem `alt=` | WCAG SC 1.1.1 | `✗` |
| `<div>` com handler sem `role`/`tabIndex` | `---DIV_HANDLERS---` — linhas com `<div onClick` etc. | WCAG SC 2.1.1 | `✗` |
| `'use client'` desnecessário | `---USE_CLIENT---` cruzado com `::FUNCS::` — se o arquivo não usa hooks/events | Next.js App Router | `⚠` |
| Componentes god (>300 linhas) | `::LINES::` filtrado por `.tsx/.jsx/.vue` | Arquitetura | `⚠` |
| Componentes com >8 exports | `::EXPORTS::` filtrado por `.tsx/.jsx` | Arquitetura | `⚠` |

**Report inline:**
- `✓ Frontend: N componentes, N arquivos CSS`
- Listar findings críticos e warnings encontrados
- `info Para audit completo de responsividade: /forge-responsive`
- `info Para audit completo de acessibilidade e performance: /forge-ui-review`

Correção: FIX_MODE → issues de a11y e arquitetura ao QUALITY-PLAN.

---

## Round 3 — Output (tool calls em paralelo)

Disparar em uma única mensagem todas as escritas necessárias:

### Diagnóstico (sem flags)

| # | Tool | Ação |
|---|------|------|
| 1 | — | Emitir report como texto |
| 2 | Write | `.gsd/.codebase-cache-hash` ← FINGERPRINT |
| 3 | Write | `.gsd/.codebase-cache.md` ← report completo |

### FIX_MODE — correções mecânicas + plano de refatoração

**Correções mecânicas (aplicar diretamente):**

| # | Condição | Tool | Ação |
|---|----------|------|------|
| 1 | CODING-STANDARDS ausente | Write | `.gsd/CODING-STANDARDS.md` via auto-detect |
| 2 | lint:fix existe | Bash | `RUN run lint:fix` |
| 3 | format:fix existe | Bash | `RUN run format:fix` |
| 4 | Build output no repo (storybook-static, dist, .next) | Edit | Adicionar ao `.gitignore` se não presente |
| 5 | tsconfig existe mas sem script typecheck | Edit | Adicionar `"typecheck": "tsc --noEmit"` ao package.json |
| 6 | prettier/biome detectado mas sem script format | Edit | Adicionar `"format": "prettier --write ."` ou `"format": "biome format --write ."` ao package.json |

**Plano de refatoração (QUALITY-PLAN.md):**

Para issues estruturais que requerem decisão arquitetural, criar `.gsd/QUALITY-PLAN.md` com detalhes suficientes para o planner do GSD transformar diretamente em slices.

Cada item do QUALITY-PLAN deve ter:

```markdown
### [Categoria] Título do item

**Arquivo(s):** `path/to/file.ts`
**Problema:** Descrição concreta do que está errado (N linhas, N exports, responsabilidades misturadas)
**Impacto:** Por que isso importa (manutenibilidade, performance, DX)
**Sugestão de fix:** Passos concretos — quais componentes extrair, para onde mover, quais imports atualizar
**Esforço estimado:** pequeno (1 task) | médio (1 slice) | grande (múltiplos slices)
```

**Rodapé do QUALITY-PLAN:**

```markdown
---

## Próximo passo

Para executar este plano de refatoração:

\`\`\`
/forge-new-milestone refatoração do codebase baseada no QUALITY-PLAN
\`\`\`

O planner lerá este arquivo e criará slices com tasks executáveis.
```

> Máximo ~5 tool calls paralelas = **1 roundtrip** (~2-3s).

---

## Report

Linha de cabeçalho:
- diagnose: `forge-codebase — diagnóstico`
- fix: `forge-codebase --fix — correções aplicadas + plano de refatoração`
- dry-run: `forge-codebase --fix --dry-run — prévia`

Rodapé:
- diagnose: `FAILs: N  WARNs: N  OK: N` + if any issues: `Para corrigir: /forge-codebase --fix`
- fix: `Corrigidos: N  Planejados: N  OK: N` + `Próximo: /forge-new-milestone refatoração baseada no QUALITY-PLAN`
- dry-run: same as fix counts + `Nenhum arquivo alterado. Execute /forge-codebase --fix para aplicar.`

Se `.gsd/QUALITY-PLAN.md` foi criado ou atualizado, mencione explicitamente.
