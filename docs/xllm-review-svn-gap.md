# PR brief — Review cross-model (Codex/xLLM) não funciona em working copy SVN

> **Status:** 🟢 **resolvido** (2026-07-15). Descoberto ao ativar o challenger Codex no repo **WDMA**
> (working copy **SVN**, sem `.git`). **Issue 2 (adaptador `--skip-git-repo-check`) foi mergeado na PR #42.**
> **Issue 1 (diff SVN) é corrigido NESTE branch** (`feat/review-svn-diff`): `Step 1` do
> `shared/forge-review.md` agora detecta o VCS e usa `svn diff` em working copies SVN.
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

**Efeito combinado:** em repositórios SVN (WDMA e afins), o review cross-model é inalcançável — e o
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

**Ressalva conhecida (polish futuro):** `svn diff` é **unscoped** — inclui qualquer arquivo versionado
modificado no working copy, inclusive artefatos de build versionados (ex.: `obj/*.json`, `*.nuget.*`).
Em git o `.gitignore` os exclui; em SVN eles entram no diff. O adaptador trunca em 4000 linhas, então
não quebra, mas gera ruído. Refino possível: scoping por path ou respeitar um ignore-list no `Step 1`. **Fora de escopo (follow-up):** o modo **execute** do codex
(`--mode execute` em `scripts/forge-xllm.js`) e o diff `START_SHA`-based do `forge-task` continuam
git-only (`git rev-parse`/`git diff --name-status $START_SHA` + reset via `git checkout`/`clean`) —
rodar TASK via codex em SVN é um item maior, separado deste.

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

## Workaround atual (WDMA)

Nenhum patch aplicado no tooling. `review.challenger: codex` fica **ativado porém dormente** nas prefs
(fallback seguro para `forge-reviewer` se o Codex falhar; e o diff vazio já pula o gate antes disso).
Fica pronto para o dia em que um milestone rodar em contexto git (worktree) ou os issues acima forem
resolvidos.

## Cross-references

- `shared/forge-review.md` — `DIFF_CMD`, boundaries, Steps 2/4 (challenge/rebuttal).
- `scripts/forge-xllm.js` — `invokeCodex()` (args do `codex exec`), `resolveCodexCommand()`.
- `forge-agent-prefs.md § Review Settings` — `review.{challenger,challenger_model,engine,advocate_model}`.
- `docs/fragment-store-migration-bugs.md` — precedente de gap SVN (mesmo repo WDMA).
