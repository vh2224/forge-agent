# Risk Radar: S02 — Verification gate executable

**Assessed:** 2026-04-16
**Overall risk:** HIGH

## Blockers (fix before executing)

- **B1 — Discovery chain default em repo docs-only pode bloquear trabalho legítimo** → Planner deve especificar explicitamente no T##-PLAN do auto-detect: se `package.json`/`pyproject.toml`/`go.mod` ausente E `prefs.verification.preference_commands` vazio E `plan.verify` ausente → retornar `{skipped: "no-stack", exit: 0}`. Qualquer outro caminho deve ser erro explícito. Documentar as 4 condições como AND-gate no script, com teste de smoke no próprio slice (repo docs-only temporário — pode ser `/tmp/docs-test/`).
- **B2 — Auto-detect de `package.json` scripts pode invocar coisa errada** → Script NÃO pode rodar todos os scripts; deve filtrar por allow-list: `typecheck`, `lint`, `test` (nessa ordem, skippando os ausentes). Nunca rodar `start`, `dev`, `build`, `prepare`, nem scripts custom. Planner deve congelar essa allow-list no T##-PLAN antes do executor começar.
- **B3 — Platform dispatch (`cmd` vs `sh`) em Windows** → `spawnSync` com comandos npm em Git Bash pode falhar silenciosamente. Executor deve testar em Windows nativo (o ambiente atual é `win32`), não só Git Bash, e usar `shell: true` com PATH resolvido. GSD-2 reference em `verification-gate.js` linhas 31–252 trata isso — portar o branch exato de `process.platform === 'win32'`.

## Warnings (monitor during execution)

- **W1 — Timeout de comando ausente no reference port** → `spawnSync` sem `timeout` pode travar forge-auto inteiro em `npm test` infinito. Adicionar `timeout: 120_000` (2 min) por comando, com exit code sintético `124` na timeout. Logar como `{skipped: "timeout", cmd}` em events.jsonl, não como falha permanente.
- **W2 — Truncamento de stderr a 10KB pode perder root cause** → Se stack trace tem 15KB, cortar no final perde a primeira linha do erro. Estratégia: manter primeiras 3KB + últimas 7KB (head + tail), com marker `[...N bytes elided...]` no meio. Padrão do GSD-2 faz isso; verificar e portar.
- **W3 — Integração com retry handler S01 pode causar loop** → Se verify falha por erro transitório (npm registry 503), retry handler do S01 re-executa. Se retry esgota, verify deve retornar falha permanente (não retryable) mesmo que classifier diga "retry". Adicionar flag `--from-verify` que desabilita retry recursivo.
- **W4 — `agents/forge-executor.md` e `agents/forge-completer.md` divergem no uso do gate** → Executor roda gate por task (bloqueia T## `done`). Completer roda gate no slice inteiro antes do squash-merge. Dois pontos de entrada ≠ duplicação: executor usa task-level verify, completer usa slice-level verify (potencialmente comando diferente). Documentar no `S##-CONTEXT.md` qual é qual.
- **W5 — `verify:` frontmatter em T##-PLAN pode colidir com outras keys YAML** → Garantir que frontmatter parser aceita multi-line strings ou comandos com `&&`. Recomendado: aceitar string OR array. Documentar no prefs template.
- **W6 — `shared/forge-dispatch.md` já é dense** → Adicionar "Verification Gate" instruction block pode empurrar arquivo acima de limite se combinado com S01 (Retry Handler) + S03 (Token Telemetry) + S04 (Tier Resolution). Planner deve checar token count cumulativo antes de cada append e extrair blocos para sub-arquivos se necessário.

## Executor notes

- Ler linhas 31–252 de `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/verification-gate.js` ANTES de escrever código — é o reference canônico. Strippar `captureRuntimeErrors` e `runDependencyAudit` (fora de escopo por SCOPE.md).
- Ordem de testes manuais obrigatórios (inline no S02-SUMMARY.md):
  1. Repo Node com `package.json` contendo `{scripts: {test: "echo ok"}}` → deve passar, logar discovery source `package.json`.
  2. Task com `verify: echo custom` explícito no frontmatter → deve rodar só esse comando, ignorar auto-detect.
  3. Repo docs-only (cria `/tmp/docs-test/` com só um `.md`) → deve retornar `{skipped: "no-stack"}`, exit 0.
  4. Mock `npm test` que falha com stderr de 20KB → verificar truncamento head+tail.
  5. Mock `npm test` que trava em loop → verificar timeout 120s + exit 124.
- Nunca silenciar erro de I/O na escrita de events.jsonl — isso é telemetria de segurança e falha silenciosa mascararia bugs reais. Prefira throw e pare o gate.
- NÃO usar `shell: true` sem sanitizar comando — mas comandos de `plan.verify` ou `prefs.preference_commands` vêm de arquivos do projeto, que são trusted. Documentar na prefs template: "comandos de verify rodam no shell do sistema com o CWD do repo — não aceite comandos não-revisados".
- Ao terminar o slice, rodar o próprio `forge-verify.js` no forge-agent repo como dogfood — se não passar no próprio projeto, algo está errado.
