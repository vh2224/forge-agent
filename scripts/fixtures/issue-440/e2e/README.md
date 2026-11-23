# Gravação E2E sanitizada — issue #440 (S03/T02)

**Rótulo:** `recorded` · **origin:** `captured` · **execution_mode:** `replay` · **contrato:** `e2e-evidence-v1` · **allowlist:** `e2e-allowlist-v1` · **sanitizer:** `e2e-sanitizer-v1`

Esta pasta contém a projeção **sanitizada** de uma captura real e controlada no
Windows: o Claude Code CLI foi o host e, pela própria ferramenta Bash, executou o
comando canônico `scripts/forge-unit-sidecar.js --request`, que iniciou o worker
Codex pelo app-server. Os bytes brutos ficaram só no laboratório local isolado e
não foram versionados. Esta pasta nunca vale como `real`: o handle vivo da
observação era local ao processo da captura e não é serializável.

## Arquivos

| Arquivo | sha256 | Conteúdo |
|---|---|---|
| `manifest.json` | `b6843fe5bf1fe1e8fb8cdbf450f51ed299edabb97db8b5fdc38d97cd338953df` | manifesto `recorded`/`captured`/`replay` com proveniência, versões, tentativa, sanitizador, variáveis e limites (2882 bytes, 97 linhas, LF) |
| `recording.jsonl` | `32f716438697f49ab8a77263b35f954d701ffd5c6a7f5a34231c134bef153ca7` | 194 registros canônicos (5 host, 181 worker, 8 attempt), 59397 bytes, LF |

Este README não é listado no manifesto e não é lido pelo verificador. Os dois
arquivos acima foram copiados byte a byte da projeção verificada pelo operador;
não foram reformatados nem regenerados.

## Proveniência

- **Data da captura:** `2026-11-22T09:12:58.461Z` (campo `provenance.captured_at`).
- **Método:** `claude-tool-canonical-codex-capture`.
- **Revisão Forge:** `fa33d14ead04ce8829a855a771713cac71e58b34`, com árvore suja (`dirty: true`) pelas mudanças da T01 ainda não commitadas.
- **Versões:** host Claude Code `2.1.322`; worker Codex `0.170.0`; Node `v24.14.1`; SO `win32` `10.0.26300` `x64`.
- **Pin do app-server:** `shared/schemas/codex-appserver-pin.json`, sha256 `a49d57fb088d73935c734442a51af70a91e7db89f7e23870ba5e0ab32c387538`, schema codex `0.166.0`. A versão do schema é âncora de fonte e é distinta da versão real do worker (`0.170.0`).
- **Captura bruta retida no laboratório:** `raw_capture_sha256` `97da6f6ab44b69396ff1f14ecffd7e6cfa821975f8d0f00a7c7ede5394b54186`.
- **Ferramentas da captura (sha256):** `root-controlled-capture` `24d8329968baf9602352520be7c8651b1680b04b83ab5a4dbcfac26165466a4d`; `codex-transparent-tee` `c91a6e24bb4b270bef6e936117dbf4f48e8bd7fb5d9165bc8f8ef3d1c05f7135`; `capture-binding` `aa47bc9364708da92201c5bb14135e813058775f091ec112b1cc60deb7221f6c`; `T01-evidence-api` `835008e8fdcc79cfdb6bd88fb51ecfef4d375525517c5a419d8f2e1600b44326`.
- **Tentativa (sha256):** dispatch `38c91d54448c3e457c8c4a669c249792cd0eb73a0d860adcd1f5e4547c36d0e6`; fingerprint `1d15ef40d1ef35548b51155016abf5c58a90d3d27f3eeaec152818c29cd0b0e9`; recovery identity `cdfe6e837fb5ef4e676ab0a2c2899923e7a509a5491e99e4d0bd7d12d0523f72`; claim `28cd311b700b48003e11cf3ca07e3547e0f74cf0653699693d6d9c4096959fa0`; geração de lease `48e3840124b148d78ff1ad374e18de70` (hex32).
- **Variáveis de escopo do laboratório (só nomes):** `ANTHROPIC_AUTH_TOKEN`, `FORGE_ACCOUNT`, `FORGE_CLAUDE_OWNER_SESSION_ID`, `FORGE_CLAUDE_OWNER_SOURCE`, `FORGE_XLLM_CODEX_BIN`, `TEMP`, `TMP`. Nenhum valor é versionado. HOME e USERPROFILE não foram trocados e `FORGE_HOME` não foi sobrescrito na captura bem-sucedida.

## Método

- Laboratório próprio e descartável, isolado, preparado pelo operador raiz com as APIs públicas atuais (registro, estado, plano e gate de laboratório, claim gate, controller begin e lease, `resolveDispatch` com `hostRuntime` claude).
- Host: Claude Code CLI real em modo headless stream-json, com a ferramenta Bash liberada só para o comando canônico; modelo enviado explicitamente.
- Worker: rota canônica sidecar Codex pelo app-server, com tee transparente declarado no seam `FORGE_XLLM_CODEX_BIN` (instrumentação observacional, sem alterar, atrasar ou injetar mensagens).
- Join da custódia nativa (`process-tree-custody-v1`, `stopped`, `active: 0`) e do host antes de ler qualquer evidência bruta.
- Sanitização local por `sanitizeCapture` e varredura limpa por `scanRecords`; só a projeção foi promovida. Caminhos viraram os placeholders `<NODE_BIN>`, `<FORGE_CODE>` e `<CAPTURE_LAB>`; IDs viraram sha256; texto livre ficou como sha256 e tamanho, exceto a resposta final do worker, que passou pela varredura.
- Contagens da sanitização: entrada host 45, worker 181, attempt 8; registros host 5, worker 181, attempt 8; linhas não interpretadas 0; linhas descartadas 40; campos descartados 710; textos reduzidos a hash 4; redações de caminho 3, segredo 0, e-mail 0, identidade 0.

## Regras de rótulo

- `recorded` exige origin `captured` e execution_mode `replay`; é o único rótulo válido para esta pasta.
- `real` só valeu para a observação viva no processo da captura, com o handle de `createLiveObservation`; ele não é versionado e o CLI recusa `real` com `e2e-real-requires-live`.
- `mock` fica restrito a `scripts/fixtures/issue-440/e2e-mock/`, que é sintética e nunca foi promovida.
- JSON importado, hashes iguais ou PID nunca concedem rótulo nem autoridade.

## Verificação

`node scripts/forge-e2e-evidence.js --verify scripts/fixtures/issue-440/e2e --expect recorded`
deve imprimir uma linha JSON com `ok: true` e `label: recorded` e sair 0. A execução
desse comando depois da promoção é responsabilidade do owner e não é alegada aqui.

## Limites

- A gravação reproduzida prova apenas o que foi capturado nesta tentativa; replay continua `recorded` e nunca `real`.
- A linha do tempo retém tool_use e tool_result do host e o JSON-RPC do worker; do recibo da tentativa só o estado final `ready` foi retido. Não há snapshot bruto do recibo `started`.
- Modelo observado do worker, esforço observado do host e esforço observado do worker são `unknown`.
- Nada aqui prova CI, custódia remota, outras rotas, outros SOs, revisão, merge, release, instalação ou UAT. O harness é da T03 e a distribuição da T04.
