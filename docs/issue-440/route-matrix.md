# Matriz de rotas — issue #440, S03

Esta matriz liga contratos e suítes existentes às quatro rotas da milestone.
A prioridade é Windows host Claude Code → worker Codex pelo app-server.
A gravação sanitizada da T02 é evidência capturada reproduzida como recorded.
O harness da T03 não chama provedor e não transforma replay em execução live.

## Rotas

| Rota | Host | Worker | Transporte | Suítes ligadas | Limites | Execução final |
|---|---|---|---|---|---|---|
| host Claude → worker Codex app-server (prioritária) | Claude Code | Codex | JSON-RPC app-server; recorded-replay no harness | forge-xllm-appserver.test.js, forge-bidirectional-sidecar.test.js, forge-issue-440-e2e.test.js, forge-issue-440-recovery.test.js, forge-issue-440-result.test.js, forge-process-tree.test.js, forge-claude-renderer.test.js | Captura Windows histórica; estímulos de falha e efeitos do harness são separados dos bytes capturados. Custódia positiva remota ainda pendente. | PENDENTE |
| host Codex → worker Claude CLI | Codex | Claude | CLI stream-json | forge-xllm-claude.test.js, forge-claude-sidecar.test.js, forge-claude-stream.test.js, forge-bidirectional-sidecar.test.js, forge-codex-renderer.test.js | Fixtures e seams simulados não comprovam nova chamada real nesta rota. | PENDENTE |
| host Codex → nativo | Codex | nativo | adaptador e ferramenta nativa exposta | forge-native-invocation.test.js, forge-native-execution.test.js, forge-native-recovery-delivery.test.js, forge-codex-renderer.test.js | Invocação, entrega e renderer têm contratos próprios; resultado de fixture não comprova disponibilidade universal do host. | PENDENTE |
| host Claude → nativo | Claude Code | nativo | adaptador e ferramenta nativa exposta | forge-native-invocation.test.js, forge-native-execution.test.js, forge-bidirectional-sidecar.test.js, forge-claude-renderer.test.js | Casos por host e provider substituído; não há nova captura live desta rota. | PENDENTE |

## Inventário medido

Comando executado para descobrir os nomes:

`node scripts/run-tests.js --list --match xllm --match native --match codex --match claude --match sidecar`

SHA-256 dos bytes UTF-8 de stdout, incluindo LF final: `959e1be9d5e371a4f65b9b5f69396e46fc0ed0be76dbd2229930fbf7fd96b828`.
Foram listadas 51 suítes; a listagem é inventário, não resultado de execução.
Os filtros são uma união de nomes, não uma classificação automática de cobertura.
As cinco suítes transversais #440/process-tree são acrescentadas por inspeção de imports.

## Ligação por fonte

- forge-xllm-appserver.test.js e forge-xllm-claude.test.js cobrem os transportes de forge-xllm.
- forge-bidirectional-sidecar.test.js importa forge-unit-sidecar, forge-xllm e forge-claude-sidecar; substitui contas e provedores.
- forge-native-invocation.test.js e forge-native-execution.test.js exercitam os adaptadores nativos e suas recusas.
- forge-native-recovery-delivery.test.js cobre o contrato de entrega nativa.
- forge-issue-440-result.test.js cobre resultado canônico e seam app-server.
- forge-issue-440-e2e.test.js usa a gravação pelo parser real e separa captured_bytes, synthetic_stimuli e harness_effects.
- forge-issue-440-recovery.test.js cobre replay, abandono e sucessor canônico.
- forge-process-tree.test.js usa auxiliares reais sob custódia Windows; indisponibilidade falha, não vira skip.
- forge-claude-renderer.test.js e forge-codex-renderer.test.js importam os renderers de cada host.

## Host Codex sem mudança de contrato

Nenhum arquivo do host Codex mudou na S03; os renderers servem como regressão.
Isso não afirma que toda fonte da milestone permaneceu inalterada na S01/S02.
Nenhum contrato é relaxado para acomodar a rota prioritária.
As quatro linhas não comprovam quatro capturas reais nem disponibilidade de conta.
Versão observada do worker capturado: 0.170.0; âncora de schema: 0.166.0.
Essas versões têm papéis distintos e não são apresentadas como iguais.

## Estados independentes e gates finais

A coluna Execução final permanece PENDENTE até o CI da revisão final.
GF1: seis suítes adiadas da T05 com logs integrais — PENDENTE.
GF2: custódia nativa Windows no runner remoto — PENDENTE.
GF3: 198 observações nativas extraídas dos worker-N.log — PENDENTE.
GF4: A7 contra o master qualificado — PENDENTE.
GF5: run-tests completo nos três sistemas — PENDENTE.
GF6: revisão independente e correções da S03 — PENDENTE.
GF7: complete-milestone, merge, release e atualização dos hosts — PENDENTE.
Instalação e aceite humano possuem evidências próprias; UAT manual segue pendente.
Nenhum gate remoto é substituído por esta documentação ou pela listagem local.
