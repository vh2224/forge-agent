# Evidência Windows — host Claude Code → worker Codex (issue #440, S03/T02)

## 1. Escopo e não alegações

Este relatório descreve uma única captura real, controlada e isolada no Windows, em
que o Claude Code CLI foi o host e, pela própria ferramenta Bash, executou o comando
canônico da Forge que iniciou o worker Codex pelo app-server. Descreve também a
projeção sanitizada promovida em `scripts/fixtures/issue-440/e2e/`.

Não alega: CI final, custódia Windows no runner remoto, outras rotas ou outros SOs,
revisão independente, merge, release, instalação, forge-update ou UAT. Não alega causa
universal dos incidentes relatados. Um passe global de suíte não substitui nenhum
critério deste relatório.

Os fatos da captura vêm da observação escalar do operador raiz e do manifesto
verificado. Quando um fato não foi observado, ele aparece como `unknown`.

## 2. Inventário de fontes

- Mapas do owner de 2026-11-22 e busca do planner em `scripts/fixtures/` (fa33d14):
  nenhuma gravação genuína prévia host Claude → worker Codex foi encontrada. Isso não
  prova ausência global fora das fontes lidas.
- Classificação das fixtures existentes (nenhuma foi promovida):

| Fixture | Classificação |
|---|---|
| `scripts/fixtures/vertical-slice/*` (handoffs Claude↔Codex) | sintética |
| `scripts/fixtures/issue-440/e2e-mock/` | sintética (`mock`), da T01 |
| `claude-stream-tool-result.jsonl` | captura de stream do Claude de origem não verificada |
| `scripts/fixtures/schema-pin/*` | pin de schema do app-server, não gravação |

- Gravação nova desta task: `scripts/fixtures/issue-440/e2e/` (`recorded`).

## 3. Autorização

Vale a autorização permanente do operador para prova real controlada e isolada no
Windows, com host Claude e worker Codex, preservando configurações, credenciais e
arquivos de trabalho, mais a autorização técnica de continuidade após correção do
chamador (2026-11-22). A autorização não prova execução nem dispensa gates. Nenhuma
pergunta funcional nova foi aberta.

## 4. Método

- **Executores.** Operador: host raiz que preparou o experimento isolado. Host da prova:
  Claude Code CLI real usando a própria ferramenta Bash. Worker: sidecar Codex canônico
  pelo app-server. Escritor dos produtos da T02: o worker roteado desta task, separado da
  observação do operador. Nenhum recibo de worker foi fabricado para a observação raiz.
- **Laboratório.** Raiz própria e descartável, fora do owner e do CODE_DIR, preparada pelas
  APIs públicas atuais. O caminho fica só no handoff do operador e não é versionado.
- **CLI do host.** Claude Code `2.1.322`, headless stream-json, ferramenta liberada só
  para `Bash` com o comando canônico.
- **Comando canônico (sanitizado):** `"<NODE_BIN>" "<FORGE_CODE>/scripts/forge-unit-sidecar.js" --request "<CAPTURE_LAB>/request.json"`.
- **Tee.** Script transparente no seam `FORGE_XLLM_CODEX_BIN` (`codex-transparent-tee`,
  sha256 `c91a6e24bb4b270bef6e936117dbf4f48e8bd7fb5d9165bc8f8ef3d1c05f7135`).
- **Variáveis (só nomes):** `ANTHROPIC_AUTH_TOKEN`, `FORGE_ACCOUNT`,
  `FORGE_CLAUDE_OWNER_SESSION_ID`, `FORGE_CLAUDE_OWNER_SOURCE`, `FORGE_XLLM_CODEX_BIN`,
  `TEMP`, `TMP`. HOME, USERPROFILE e CODEX_HOME intactos; nenhuma preferência,
  configuração ou credencial copiada, trocada ou editada.
- **Desvio do plano original.** O plano previa `FORGE_HOME` igual ao CODE_DIR. Essa
  sobrescrita mudava as fontes de preferência de roteamento e foi removida; o CLI
  absoluto já encontra os procedimentos da fonte por `__dirname`.
- **Tentativas.**

| Lançamento do host | Resultado | Codex chamado |
|---|---|---|
| 1 | defeito do chamador: ambiente canônico da conta Claude omitido | não |
| 2 | defeito do chamador: `FORGE_HOME` alterou a fonte de roteamento (`milestone-resolver-context-required`) | não |
| 3 | captura bem-sucedida | sim (1 captura de worker) |

Teto de lançamentos do host: 3, com os registros anteriores retidos. Capturas reais do
worker Codex: 1 de no máximo 2. Nenhuma falha viva foi provocada.

## 5. Proveniência

| Campo | Valor (copiado do manifesto verificado) |
|---|---|
| label / origin / execution_mode | `recorded` / `captured` / `replay` |
| evidence_version | `e2e-evidence-v1` |
| captured_at | `2026-11-22T09:12:58.461Z` |
| method | `claude-tool-canonical-codex-capture` |
| rota | host `claude-code`, worker `codex`, transporte `app-server`, worker_mode `sidecar` |
| versão do host | `2.1.322` |
| versão do worker | `0.170.0` |
| Node | `v24.14.1` |
| SO | `win32` `10.0.26300` `x64` |
| Forge | revisão `fa33d14ead04ce8829a855a771713cac71e58b34`, `dirty: true` |
| pin do app-server | `shared/schemas/codex-appserver-pin.json`, sha256 `a49d57fb088d73935c734442a51af70a91e7db89f7e23870ba5e0ab32c387538`, schema `0.166.0` |
| dispatch_sha256 | `38c91d54448c3e457c8c4a669c249792cd0eb73a0d860adcd1f5e4547c36d0e6` |
| fingerprint_sha256 | `1d15ef40d1ef35548b51155016abf5c58a90d3d27f3eeaec152818c29cd0b0e9` |
| recovery_identity_sha256 | `cdfe6e837fb5ef4e676ab0a2c2899923e7a509a5491e99e4d0bd7d12d0523f72` |
| claim_sha256 | `28cd311b700b48003e11cf3ca07e3547e0f74cf0653699693d6d9c4096959fa0` |
| lease_generation | `48e3840124b148d78ff1ad374e18de70` |
| raw_capture_sha256 | `97da6f6ab44b69396ff1f14ecffd7e6cfa821975f8d0f00a7c7ede5394b54186` |
| manifest.json sha256 | `b6843fe5bf1fe1e8fb8cdbf450f51ed299edabb97db8b5fdc38d97cd338953df` |
| recording.jsonl sha256 / bytes / registros | `32f716438697f49ab8a77263b35f954d701ffd5c6a7f5a34231c134bef153ca7` / 59397 / 194 |

Modelo e esforço:

| Camada | Enviado | Observado |
|---|---|---|
| host modelo | `claude-opus-5-5` | `claude-opus-5-5` (init e result do host) |
| host esforço | `high` | `unknown` |
| worker modelo | `gpt-6.1-sol` (thread/start e turn/start) | `unknown` |
| worker esforço | `high` (turn/start) | `unknown` |

A versão do schema `0.166.0` é âncora de fonte; a versão real do worker é `0.170.0`.
Nenhuma compatibilidade além desta captura é inferida.

## 6. Linha do tempo dos handoffs

| Ordem | Canal / seq | Evento |
|---|---|---|
| 1 | host 0 | `init` do Claude Code `2.1.322`, ferramentas `[Bash]` |
| 2 | host 1 | `tool_use` Bash com o comando canônico `--request` |
| 3 | attempt | recibo `started`: não retido como snapshot bruto; a ordem é sustentada só por metadado canônico e pela ordem da fonte |
| 4 | attempt 188 | spawn sob custódia `process-tree-custody-v1` (registro de término; o spawn em si não tem registro próprio) |
| 5 | worker 5–8 | `initialize` (offset 15 ms), resposta, `initialized` |
| 6 | worker 9–12 | `thread/start` com modelo `gpt-6.1-sol`, resposta e `thread/started` |
| 7 | worker 22–25 | `turn/start` com esforço `high`, resposta e `turn/started` |
| 8 | worker 50–53 | execução de comando do worker (`commandExecution`) |
| 9 | worker 56–181 | resposta final (`final_answer`), concluída em 11304 ms |
| 10 | worker 185 | `turn/completed` com status `completed` (11316 ms) |
| 11 | attempt 187 | recibo `ready` |
| 12 | host 2 | `tool_result` (`is_error: false`, `cli_status: done`) |
| 13 | host 3–4 | texto do assistente (só hash) e `result` `success`, 2 turnos, 26260 ms |

## 7. Término e join

- Custódia do worker: método `process-tree-custody-v1`, status `stopped`, `active: 0`,
  `joined: true` (registro attempt 188).
- Saída do host: exit 0, sem sinal, join confirmado.
- Processos do laboratório remanescentes: 0.
- Hashes da custódia: registro `862cbcda80a629e12e66e083a27c0e5fb24dd01b0fce2188ff434ee7ac0c466c`,
  journal `92b5ee4c355b8d3ac39c606009caeee2fc6b14c7c0ec7287f66cae2392e6bd82`,
  vínculo `7d8681a6407525d6e66df0151a41fc401bc248819f6a1125f96c768e86b1c8bd`.
- O join ocorreu antes de qualquer leitura da evidência bruta.

## 8. Owner, claim, geração, autoridade e gates do laboratório

Tudo é declarado como **laboratório**, não como o owner real:

| Item | Valor |
|---|---|
| gate de plano | `root-attested-lab` |
| gate de segurança | `not-applicable` |
| claim gate | `proceed` (claim_sha256 acima) |
| geração | lease hex32 `48e3840124b148d78ff1ad374e18de70` |
| evento de setup | `lab-setup` `declared-synthetic-plan-real-transport` |
| autoridade | autorização explícita do operador; nenhum JSON importado concede autoridade |

A tarefa sintética do laboratório escreve `same.txt` com `after` seguido de LF, a mesma
do harness, para que a T03 reproduza a resposta gravada sem edição.

## 9. provider_called por camada

| Camada | Registro | Valor |
|---|---|---|
| recibo da tentativa | attempt 187 | `true` |
| evento de observação | attempt 193 `provider-observation` | `observed` |
| observação escalar do operador | — | `true` |
| worker app-server | sem campo `provider_called` | `unknown` como campo; há `turn/completed` e `thread/tokenUsage/updated` |
| host Claude Code | sem campo `provider_called` | `unknown` como campo; o `result` traz contagens de uso |

## 10. Sanitização auditada

- allowlist `e2e-allowlist-v1`, sanitizer `e2e-sanitizer-v1`, contrato `e2e-evidence-v1`.
- Entrada: host 45, worker 181, attempt 8. Registros: host 5, worker 181, attempt 8.
- Linhas não interpretadas 0; linhas descartadas 40; campos descartados 710; textos
  reduzidos a hash 4.
- Redações: caminho 3, segredo 0, e-mail 0, identidade 0.
- Placeholders na gravação: `<NODE_BIN>`, `<FORGE_CODE>`, `<CAPTURE_LAB>`.
- `scanRecords` limpo sobre a projeção; só ela foi promovida. Nenhum fluxo bruto, caminho
  pessoal, ID de sessão ou conta, e-mail ou token entrou em arquivo versionado.

## 11. Rótulos

- `real`: só a observação viva no processo da captura, verificada com o handle de
  `createLiveObservation` depois do join; o handle não é serializável nem versionado.
- `recorded`: `scripts/fixtures/issue-440/e2e/`, verificada como `recorded` pelo operador.
- `mock`: `scripts/fixtures/issue-440/e2e-mock/`, sintética, nunca promovida.

## Códigos do verificador

| Código | Significado |
|---|---|
| `e2e-arguments-invalid` | argumentos do CLI ausentes, repetidos ou fora do formato |
| `e2e-version-unknown` | `evidence_version` desconhecida |
| `e2e-manifest-invalid` | manifesto ausente da forma esperada ou JSON inválido |
| `e2e-label-invalid` | rótulo fora de `mock`, `recorded` e `real` |
| `e2e-label-origin-mismatch` | rótulo incompatível com origin ou execution_mode |
| `e2e-real-requires-live` | `real` sem handle vivo do mesmo processo |
| `e2e-synthetic-promotion` | conteúdo sintético apresentado como capturado |
| `e2e-provenance-missing` | campo obrigatório de proveniência ausente |
| `e2e-provenance-unbound` | proveniência do manifesto diverge do conteúdo gravado |
| `e2e-file-missing` | arquivo listado ou diretório inexistente |
| `e2e-file-unsafe` | link, junction, hard link, escape ou colisão por caixa |
| `e2e-file-too-large` | arquivo, linha ou contagem acima dos limites |
| `e2e-file-hash-mismatch` | sha256, bytes ou contagem de registros divergentes |
| `e2e-record-invalid` | registro fora do formato canônico do canal |
| `e2e-sanitization-field` | campo fora da allowlist |
| `e2e-sanitization-secret` | segredo ou token em claro |
| `e2e-sanitization-path` | caminho pessoal em claro |
| `e2e-sanitization-email` | e-mail em claro |
| `e2e-sanitization-identity` | UUID de sessão ou conta em claro |
| `e2e-expect-mismatch` | evidência válida com rótulo diferente de `--expect` |

## 13. Cobertura da matriz Windows por rota

| Host | Worker | Transporte | Estado nesta task |
|---|---|---|---|
| Claude Code | Codex | app-server (sidecar) | genuína: uma captura `recorded` |
| Claude Code | Claude | sidecar | não capturada |
| Codex | Codex | app-server | não capturada; regressão pelas suítes existentes (T04) |
| Codex | Claude | sidecar | não capturada; regressão pelas suítes existentes (T04) |

Outros SOs não foram capturados.

## 14. Limites e pendências

- Pendências desta entrega: execução do CLI `--verify --expect recorded` pelo owner depois
  da promoção, cerca de bytes das fixtures históricas, igualdade de bytes da cópia e
  entrega estrita do owner.
- T03 (harness determinístico) e T04 (matriz, CHANGELOG e distribuição) pendentes.
- GF1: seis suítes adiadas no CI da revisão final — pendente.
- GF2: custódia Windows positiva no CI final — pendente.
- GF3: 198 observações nativas dos `worker-N.log` — pendente.
- GF4: A7 contra o baseline do master — pendente.
- GF5: run-tests completo nos três SOs — pendente.
- GF6: revisão independente da S03 — pendente.
- GF7: complete-milestone, merge, release, forge-update e UAT manual — pendentes.
