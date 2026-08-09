# PR brief — Review cross-model (Codex/xLLM) não funciona em working copy SVN

> **📜 DOCUMENTO HISTÓRICO (nota acrescentada em 2026-08-06, M018/S05).** O corpo abaixo é a medição
> original e **não foi reescrito** — vale como registro do que foi observado em 2026-07-15. O que mudou
> desde então: o **transporte** que ele descreve (`codex exec`, invocado por argv) foi **aposentado** em
> M018/S05, e o engine `codex` do adapter passou a falar o protocolo `codex app-server` por JSONL.
> Consequência direta para a **Issue 2** deste brief: `--skip-git-repo-check` era um **argumento de
> `codex exec`**, e o app-server não tem argv que o carregue — a S01 mediu o app-server **completando um
> turn num cwd não-git sem nenhum opt-out**, então o problema descrito na Issue 2 deixou de existir
> junto com o transporte, e não por alguma correção nova. A **Issue 1** (aquisição do diff em SVN) é
> ortogonal ao transporte e permanece resolvida como o corpo descreve.

> **Status:** 🟢 **resolvido** (2026-07-15). Descoberto ao ativar o challenger Codex no store de referência
> (working copy **SVN**, sem `.git`). **Issue 2 (adaptador `--skip-git-repo-check`) foi mergeado na PR #42.**
> **Issue 1 (diff SVN) foi corrigido** (`feat/review-svn-diff`): `Step 1` do
> `shared/forge-review.md` detecta o VCS em working copies SVN. A **Fase 2**
> (`feat/review-svn-diff-scoped`) substituiu o `svn diff` cru por `scripts/forge-review-diff.js` —
> escopo por unidade, arquivos novos incluídos, `--name-only`/`-- <files>` funcionando — e estendeu o
> ramo SVN ao boundary de **task solta** (`/forge-task` Step 5.5), que era git-only. Ver a seção
> *Ressalva resolvida* abaixo.
> **Origem:** sessão `/forge-prefs` — reconfiguração de modelos + tentativa de ligar `review.challenger: codex`.

## TL;DR

O review dialético (`shared/forge-review.md`) assume git em dois pontos, e **os dois quebram em SVN**:

1. **Aquisição do diff é git-only.** `DIFF_CMD="git diff ${BASE}...HEAD"` (com fallback `git diff HEAD`)
   e todo o boundary usa branches `gsd/{M###}/{S##}` + merge-base + squash merge. Num working copy SVN
   `git diff` retorna vazio → o gate escreve *"no diff to review"* e pula. Vale para **qualquer**
   challenger (Claude in-context inclusive), não só Codex.

2. **`codex exec` recusa diretório não-git.** O adaptador `scripts/forge-xllm.js` monta os args do
   `codex exec` **sem** `--skip-git-repo-check`. Fora de um repo git o Codex aborta com:
   ```
   Not inside a trusted directory and --skip-git-repo-check was not specified.
   ```
   Confirmado empiricamente que **não há config nem "trusted directory"** que contorne isso num dir
   sem `.git` (testado: `~/.codex/config.toml` com `[projects.'…'] trust_level="trusted"` e
   `-c projects."…".trust_level="trusted"` e `-c skip_git_repo_check=true` — nenhum resolve).
   Só a flag `--skip-git-repo-check` funciona (testado: com a flag, `codex exec` retorna OK / exit 0).

**Efeito combinado:** em repositórios SVN (o store de referência e afins), o review cross-model é inalcançável — e o
review gate em geral é um no-op silencioso.

---

## ✅ Issue 1 — `DIFF_CMD` hardcoded em git; sem caminho SVN (corrigido neste branch)

**Onde:** `shared/forge-review.md` `Step 1 — Compute the slice diff` + tabela de boundaries.

**Correção aplicada:** `Step 1` agora detecta o VCS antes de montar o `DIFF_CMD`:

- **git** → `git diff {merge-base}...HEAD` (com fallback `git diff HEAD`) — inalterado.
- **svn** (`svn info` sucede) → `svn diff` do working copy. Decisão de design: o forge em SVN
  trabalha na trunk **sem branch por slice** (a equipe segura commits e commita "completo"), então
  o diff revisável é o **uncommitted** — não há merge-base/baseline de slice a computar.
- **VCS desconhecido / CLI ausente** → degrada para o caminho "no diff to review", nunca erra.

Serve tanto o review de slice (`forge-auto`/`forge-next`) quanto o de task (`forge-task` Step 5.5),
pois ambos consomem o `Step 1`.

**✅ Ressalva resolvida (Fase 2).** A ressalva registrada aqui — `svn diff` **unscoped** inclui
qualquer arquivo modificado no working copy — era maior do que "ruído": numa working copy
**compartilhada** por mais de um desenvolvedor, o diff carrega o trabalho não-commitado dos colegas
(medido em campo: 49 arquivos, 8 da unidade), então o challenger gasta orçamento objetando código que
a unidade não é dona. Somavam-se dois defeitos não registrados na época:

- **Arquivo novo (`?`) não aparece em `svn diff` de jeito nenhum.** Numa slice cujo change inteiro
  eram dois arquivos novos, o review teria lido quase nada e renderizado **limpo** — o pior resultado
  possível para um gate.
- **`svn diff --name-only` não existe**, e três consumidores *anexam* argumentos ao `DIFF_CMD`
  (`$DIFF_CMD --name-only` no pattern scan e no probe de diff vazio; `{DIFF_CMD} -- <files>` no
  sharding do Step 2.0). O `DIFF_CMD="svn diff"` desta correção quebrava os três silenciosamente.

Os três são resolvidos por `scripts/forge-review-diff.js`, que é o `DIFF_CMD` do ramo SVN nos **dois**
boundaries (slice e task): escopa ao manifesto de paths da unidade, reconstrói arquivos novos como
hunks de adição, e aceita `--name-only` / `-- <files>`. Nunca produz diff vazio por escopo — manifesto
ausente ou que não casa nada cai no comportamento unscoped e declara isso em `--scope-report`. O
`forge-cost-policy.js` ganhou `--scope-file` pelo mesmo motivo: sem ele a policy contava os arquivos
alheios e promovia a review a dialectic/sharding sobre código de outro dono.

**Fora de escopo (follow-up):** o modo **execute** do codex (`--mode execute` em
`scripts/forge-xllm.js`) continua git-only (`git rev-parse`/`git diff --name-status $START_SHA` +
reset via `git checkout`/`clean`) — rodar TASK via codex em SVN é um item maior, separado deste.

## ✅ Issue 2 — `forge-xllm.js` não passa `--skip-git-repo-check` (corrigido nesta PR)

**Onde:** `scripts/forge-xllm.js`, `invokeCodex()` — array `args` de `codex exec`
(logo antes do `if (model) args.push('-m', model)`).

**Correção aplicada:** `--skip-git-repo-check` acrescentado incondicionalmente ao array. O
`--sandbox read-only` já limita o blast radius; a flag apenas remove a exigência de git, sem
afrouxar a sandbox. Trecho:

```js
const args = [
  'exec',
  '--sandbox', 'read-only',
  '--skip-git-repo-check',   // ← permite rodar em working copy não-git (SVN)
  '-C', cwd,
  '-o', lastMsgFile,
  '--output-schema', schemaFile,
];
```

Isolado, o Issue 2 só faz sentido depois (ou junto) do Issue 1 — sem um diff SVN, o Codex rodaria
sobre um diff vazio.

---

## Reprodução

```bash
# Em qualquer working copy SVN (sem .git):
node scripts/forge-xllm.js --mode challenge --diff-cmd "echo sem mudancas" --cwd . --timeout 150
# → forge-xllm: codex exited 1: ... Not inside a trusted directory ... EXIT=2

# Prova de que o login/adaptador funcionam (com a flag ausente no adaptador):
codex exec --skip-git-repo-check --sandbox read-only -o /tmp/t.txt "responda: OK"
# → OK, exit 0
```

## Workaround atual (store de referência)

Nenhum patch aplicado no tooling. `review.challenger: codex` fica **ativado porém dormente** nas prefs
(fallback seguro para `forge-reviewer` se o Codex falhar; e o diff vazio já pula o gate antes disso).
Fica pronto para o dia em que um milestone rodar em contexto git (worktree) ou os issues acima forem
resolvidos.

## Cross-references

- `shared/forge-review.md` — `DIFF_CMD`, boundaries, Steps 2/4 (challenge/rebuttal).
- `scripts/forge-xllm.js` — `invokeCodex()` (args do `codex exec`), `resolveCodexCommand()`.
- `forge-agent-prefs.jsonc § Review Settings` — `review.{challenger,challenger_model,engine,advocate_model}`.
- `docs/fragment-store-migration-bugs.md` — precedente de gap SVN (mesmo store de referência).
