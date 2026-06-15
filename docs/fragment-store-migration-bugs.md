# PR brief — Fragment-store: guardas de segurança na migração + bug do forge-ignore (SVN)

> **Status:** ✅ **implementado** na branch `fix/fragment-store-migration-guards` (2026-06-01). Os 3 issues abaixo foram corrigidos e cobertos por testes de regressão em `scripts/fragment-store-guards.test.js` (9 casos). Descoberto em 2026-06-01 ao usar o Forge no repo **WDMA** (working copy **SVN**, equipe, trabalho na `master`/trunk).
> **Origem:** sessão de diagnóstico via `/forge-doctor`. Nenhum dado foi perdido (arquivos versionados → `svn revert` restaurou), mas o caminho de "fix + regen" zerou os monólitos em um WC ainda não-migrado.
>
> **Resolução (resumo):**
> - Novo helper `scripts/forge-store-state.js` — detecta estado por store (`migrated`/`unmigrated`/`empty`), fonte única usada pelas guardas.
> - Issue 1 → `forge-projection.js` `writeAll()` recusa sobrescrever monólito populado a partir de store vazio (CLI `--write-all --force` como escape; `forge-doctor --regen-projection --force` repassa).
> - Issue 2 → `forge-doctor --fix` recusa carimbar store não-migrado; `--fix --migrate` roda `forge-migrate` antes de carimbar.
> - Issue 3 → `forge-ignore.js` (SVN) pula dir não-versionado coberto por wholesale (sem `E155010`); `--validate` deixa de reportar filhos cobertos como `missing`.

## TL;DR do que aconteveu

O `.gsd` do WDMA está num estado **híbrido / não-migrado**: os monólitos (`LEDGER.md` 311 linhas, `DECISIONS.md` 56, `AUTO-MEMORY.md` 189) ainda são a **única fonte de verdade** e o fragment store **nunca foi populado** (não existe `.gsd/ledger/`; `.gsd/decisions/` tem ~1 fragmento). Rodar `forge-doctor.js --fix` + `--regen-projection` nesse estado:

1. carimba `SCHEMA-VERSION` e marca o store como "migrado" (mentira — está vazio);
2. regenera os monólitos a partir do store vazio → escreve esqueletos de poucas linhas **por cima** do conteúdo real (LEDGER 311→5, DECISIONS 56→9, AUTO-MEMORY 189→6);
3. adiciona os monólitos ao `svn:ignore` (errado enquanto eles são a fonte de verdade).

Só não houve perda porque no WDMA esses arquivos estão versionados no SVN. Em um WC onde estivessem ignorados/não-versionados, seria **perda silenciosa de histórico**.

---

## ✅ Issue 1 — `--regen-projection` sobrescreve monólitos sem guarda contra store vazio (CRÍTICO)

**Onde:** `scripts/forge-projection.js`, `renderLedger()` (linhas ~53-62) e equivalentes de decisions/memory; chamado por `forge-doctor.js --regen-projection` (`writeAll`).

```js
// renderLedger(cwd)
const fragments = ledgerMod.listFragments(cwd);
const lines = ['# Forge Project Ledger', '', '> Compact record...', ''];
if (fragments.length === 0) {
  lines.push('_No completed milestones yet._');
  return lines.join('\n') + '\n';   // ← 5 linhas, gravadas POR CIMA do monólito real
}
```

O `writeAll` grava esse retorno por cima do arquivo existente **sem verificar** se o monólito atual já tem conteúdo que não está representado em fragmentos.

**Repro:** num `.gsd` com `LEDGER.md` populado mas sem `.gsd/ledger/*.md` → `node forge-doctor.js --regen-projection` → `LEDGER.md` vira esqueleto de 5 linhas.

**Fix proposto:**
- `--regen-projection` deve **abortar (exit 1) ou exigir `--force`** quando o fragment store estiver vazio mas o monólito de destino tiver conteúdo real (> esqueleto). Mensagem clara: "fragment store vazio mas LEDGER.md tem conteúdo — rode a migração (`forge-ledger-migrate.js`) antes, ou use --force para sobrescrever".
- Idealmente, escrever em arquivo temporário e só substituir se o resultado não regredir drasticamente em tamanho/contagem de entradas (heurística de não-regressão).

## ✅ Issue 2 — `forge-doctor --fix` carimba SCHEMA-VERSION sem popular fragmentos

**Onde:** `forge-doctor.js --fix` (Layer 2) cria `.gsd/SCHEMA-VERSION = fragment-store@1.0.0`.

O carimbo marca o store como migrado, mas **não roda** os migrators existentes (`scripts/forge-{ledger,decisions,memory}-migrate.js`). Resultado: estado "stamped-but-empty" que torna o `--regen-projection` destrutivo (Issue 1) e faz o `--check schema` passar enganosamente.

**Fix proposto:**
- `--fix` deve, **antes** de carimbar, detectar monólito-com-conteúdo + store-vazio e **rodar os migrators** (decompor monólito → fragmentos) como parte do fix; só carimbar `SCHEMA-VERSION` após a migração popular o store.
- Ou, no mínimo, recusar o carimbo e instruir a rodar `forge-migrate.js` primeiro.

## ✅ Issue 3 — `forge-ignore.js --apply` (SVN) estoura em dir ignorado-em-bloco

**Onde:** `scripts/forge-ignore.js`, `applyIgnore()` branch SVN (linhas ~155-191).

```js
const absDir = path.join(dir, parentDir);     // ex.: .gsd/forge
if (!fs.existsSync(absDir)) { /* skip */ }     // ← .gsd/forge EXISTE em disco, então NÃO pula
const existing = svnPropget(absDir);           // E155010 swallowed → []
...
svnPropset(absDir, merged);                    // ← THROW E155010 não tratado → aborta tudo
```

`LOCAL_IGNORE_PATHS` lista filhos de `.gsd/forge` (`auto-mode.json`, `runs/`, `events.jsonl`, ...). Mas `.gsd/forge` costuma estar ignorado **em bloco** pelo `svn:ignore` do `.gsd` (entry `forge`) e, por isso, **não está sob versionamento**. O `fs.existsSync` passa (o dir existe em disco), mas `svn propset` falha em nó não-versionado (`E155010`), e a exceção não é capturada → o `--apply` inteiro aborta (nenhuma das regras restantes é aplicada).

**Fix proposto:**
- Antes do `svnPropset`, verificar se `absDir` está **versionado** (ex.: `svn info <dir>` sucede). Se não estiver, **pular** com aviso ("já coberto por ignore wholesale do pai") em vez de estourar.
- Reconciliar o design: ou `.gsd/forge` é ignorado em bloco no `.gsd` (e aí não se setam ignores per-child dentro dele), ou não é ignorado em bloco e cada filho é versionado/ignorado individualmente. Hoje há contradição entre `svn:ignore` do `.gsd` (`forge`) e `LOCAL_IGNORE_PATHS` (filhos de `.gsd/forge`).
- O `--validate` correspondente deve reconhecer cobertura por ignore-wholesale do pai (hoje reporta filhos de `forge/` como "missing" mesmo estando cobertos → falso-positivo).

---

## Escopo sugerido da PR

1. Guarda de não-regressão no `forge-projection.js` / `--regen-projection` (Issue 1) — prioridade máxima (previne perda de dado).
2. `--fix` roda migrators antes de carimbar, ou recusa em store não-migrado (Issue 2).
3. Correção do branch SVN do `forge-ignore.js` (Issue 3) + ajuste do `--validate` para wholesale-ignore.
4. Testes: caso "monólito populado + store vazio" para regen e para --fix; caso SVN "dir filho ignorado-em-bloco" para apply/validate.

## Nota operacional (separado da PR de código)

O WDMA (e possivelmente outros WCs da equipe) está **não-migrado**. Depois que a PR estiver pronta, rodar a migração de forma **coordenada** num único WC e commitar o resultado (fragmentos) — porque o `.gsd` é compartilhado via SVN. Até lá, **não rodar `forge-doctor --fix`/`--regen-projection` em WCs do WDMA**.

---

## ✅ Follow-up — `forge-migrate` aposentava caches regenerados de repo já migrado

> **Status:** ✅ corrigido na branch `fix/migrate-already-migrated-guard`. Coberto por `scripts/forge-migrate.test.js` (4 casos).

**Sintoma:** num repo **já migrado** (`SCHEMA-VERSION == fragment-store@1.0.0`, fragment store populado) com os monólitos presentes em disco como **caches regenerados**, rodar `/forge-update` (que chama `forge-migrate.js`) renomeava `LEDGER.md`/`DECISIONS.md`/`AUTO-MEMORY.md` para `.bak` e **não os regenerava** — sumiam do disco. Em seguida `forge-sweep` abortava no bootstrap (`ls .gsd/LEDGER.md` → "Project not initialized").

**Causa-raiz:** `backupMonolith` decidia aposentar o monólito **só pela presença do arquivo** — não consultava `SCHEMA-VERSION` nem se os fragmentos já estavam populados. Um cache regenerado era tratado como monólito legado pré-migração.

**Correção (ponta a ponta):**
- `forge-migrate.js` ganhou um atalho "Step 0 already-migrated" em `migrateStore`: quando `SCHEMA-VERSION` está current **e** o store está `migrated` (via `forge-store-state.js`), pula backup/migrate, **não** renomeia, reporta `skipped_reason: 'already-migrated'`. Estado `schema-current + store-vazio` (stamped-but-empty) emite **warning** em vez de aposentar o monólito.
- `forge-sweep` passou a gatear o bootstrap em `.gsd/ledger/`/`SCHEMA-VERSION` (monólito como fallback) e a obter o LEDGER via `forge-projection --render ledger`.
- `/forge-update` roda `forge-projection --write-all` **depois** do migrate, reconciliando os caches (a guarda anti-clobber já protege WC não-migrado).
