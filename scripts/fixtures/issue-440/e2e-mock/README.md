# Fixture E2E sintética — issue #440 (S03/T01)

**Rótulo:** `mock` · **origin:** `synthetic` · **execution_mode:** `synthetic` · **contrato:** `e2e-evidence-v1` · **allowlist:** `e2e-allowlist-v1` · **sanitizer:** `e2e-sanitizer-v1`

Esta pasta é uma fixture **sintética escrita à mão**. Nenhum dado real, nenhuma
captura, nenhum provedor, conta, host ou worker participou da sua criação. Ela
existe só para provar o formato e as recusas do verificador
`scripts/forge-e2e-evidence.js`. Não é uma gravação e nunca pode ser promovida a
`recorded` ou `real`.

## Arquivos

| Arquivo | sha256 | Conteúdo |
|---|---|---|
| `manifest.json` | `5e64d5a95607ef8a2f3fa0943e7774705e19af639b200b03d157c3e472dab99f` | manifesto `mock`/`synthetic`/`synthetic` com proveniência sintética |
| `recording.jsonl` | `de287d41b5c6590d4ff92200383fbc08194c89329e63fb3518d9dddc1c416e7c` | 19 registros canônicos (4 host, 9 worker, 6 attempt), 4579 bytes, LF |

Este README não é listado no manifesto e não é lido pelo verificador.

## Método

- Registros escritos à mão em JSON canônico (chaves ordenadas), um por linha, com `channel`, `seq`, `origin`, `kind` e só campos da allowlist do canal.
- Todos os registros têm `origin: synthetic`. Versões, modelos e IDs são explicitamente sintéticos (`mock-*`).
- Os hashes de IDs e de tentativa são sha256 dos rótulos literais `mock-tool-use-1`, `mock-thread-1`, `mock-turn-1`, `mock-item-1`, `mock-input`, `mock-output-schema`, `mock-dispatch`, `mock-fingerprint`, `mock-recovery-identity`, `mock-claim`, `mock-request`, `mock-context`, `mock-tool-result-content` e `mock-cli-line`. `raw_capture_sha256` é o sha256 de `mock-raw-capture`, pois não há captura bruta.
- Canais no formato da gravação real: host (init, tool_use do comando canônico com placeholders `<FORGE_SOURCE>`/`<LAB>`, tool_result, result), worker (initialize, thread/start, turn/start, item/started, item/completed final_answer, turn/completed) e attempt (identity, receipt started e ready, custódia, evento, gate).
- O pin do app-server referido é o atual `shared/schemas/codex-appserver-pin.json` (schema codex `0.166.0`). A versão do worker (`mock-codex-0.0.0`) é um fato distinto da versão do schema e nunca é relabelada como ela.

## Regras de rótulo

- `mock` exige origin `synthetic` e execution_mode `synthetic`.
- `recorded` exige origin `captured` e execution_mode `replay`.
- `real` exige origin `captured`, execution_mode `live` e um handle vivo opaco de `createLiveObservation` criado no mesmo processo a partir da mesma captura. O CLI e toda verificação offline recusam `real`.
- JSON importado, hashes iguais ou PID nunca concedem rótulo nem autoridade. Nenhum rótulo é promovido a partir do manifesto.

## REASON_CODES (conjunto fechado)

`e2e-arguments-invalid`, `e2e-version-unknown`, `e2e-manifest-invalid`, `e2e-label-invalid`,
`e2e-label-origin-mismatch`, `e2e-real-requires-live`, `e2e-synthetic-promotion`,
`e2e-provenance-missing`, `e2e-provenance-unbound`, `e2e-file-missing`, `e2e-file-unsafe`,
`e2e-file-too-large`, `e2e-file-hash-mismatch`, `e2e-record-invalid`, `e2e-sanitization-field`,
`e2e-sanitization-secret`, `e2e-sanitization-path`, `e2e-sanitization-email`,
`e2e-sanitization-identity`, `e2e-expect-mismatch`.

## Verificação

`node scripts/forge-e2e-evidence.js --verify scripts/fixtures/issue-440/e2e-mock --expect mock`
imprime uma linha JSON (`ok`, `label`, `origin`, `execution_mode`, `files`, `reason_code`) e sai 0.
A suíte `node scripts/forge-e2e-evidence.test.js` executa esse positivo e, em cópias temporárias,
as recusas de relabel (`e2e-label-origin-mismatch`, `e2e-synthetic-promotion`), de bytes alterados
(`e2e-file-hash-mismatch`) e um caso nomeado para cada código.

## Limites

- Prova apenas formato e recusas; não prova host Claude Code real, worker Codex real, transporte, provedor, custódia Windows nem execução de API.
- O handle vivo prova apenas que a gravação verificada foi derivada, neste processo, da captura entregue a `createLiveObservation`; sozinho não prova chamada de provedor.
- A captura genuína é da T02, o harness da T03 e a distribuição da T04. CI final, revisão, merge, release, instalação e UAT seguem pendentes.
