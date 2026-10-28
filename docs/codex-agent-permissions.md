# Permissões herdadas dos agentes Codex e dos demais transportes

Auditoria da S01/T05 (milestone M-20261028132636-experiencia, critério C04).
Este documento registra o que cada transporte do Forge realmente envia ao host
sobre sandbox e aprovações. Também separa três coisas: o que o Forge declara, o
que o Forge aplica com código próprio e o que só o sistema operacional ou o host
garantem. **Nenhum escape de sandbox foi demonstrado.** Nada aqui afirma
isolamento mais forte do que o código e as fontes citadas sustentam.

## Fontes

- **Código.** As âncoras abaixo apontam para o código deste repositório na
  revisão da T05. Os números de linha servem de orientação, e o nome da função
  ou constante é a referência estável.
- **Documentação oficial**, revalidada pelo owner em 2026-10-28 no formato
  Markdown:
  - <https://learn.chatgpt.com/docs/agent-configuration/subagents>, sha256
    `e7469d41c5a18a4ee66ee40ca4a9a2617a697e42554a0198ac4481e1e597357f`
    (22907 bytes). Os filhos nativos compartilham o sandbox e a configuração
    de aprovação ativos do turno pai, e um TOML de agente customizado não os
    substitui. Instruções para não escrever não equivalem a um sandbox
    somente leitura independente.
  - <https://learn.chatgpt.com/docs/agent-approvals-security>, sha256
    `595db3a5a3276996071dcc2442e2cfcfef2c11c50cf46fccfd1de4a869a82017`
    (35349 bytes). A política de sandbox e a revisão de aprovação têm
    finalidades distintas, e a auto-revisão não amplia o sandbox.
  - Esses hashes identificam os bytes Markdown baixados. Eles não se comparam
    com fingerprints anteriores de HTML ou de outra projeção, porque o método
    de captura é outro. Este repositório não guarda cópia das páginas.
- **Observação do owner no host.** Os args expostos pela ferramenta nativa
  Codex na sessão são `task_name`, `message`, `agent_type`, `model`,
  `reasoning_effort` e `fork_turns`. Não existe argumento de sandbox por
  agente. O modelo e o esforço efetivamente aplicados pelo provider, assim como
  a navegação de threads na interface, continuam **desconhecidos** até haver
  observação humana ou runtime.

## Contrato por transporte

| Transporte | Sandbox e aprovações | Fonte no código | Garantias do Forge além do host |
|---|---|---|---|
| Agente nativo Codex (`spawn_agent`) | Herdados da sessão pai. O TOML só declara `sandbox_mode = "workspace-write"`, e essa declaração não prova isolamento por agente. | `scripts/forge-native-invocation.js` `buildNativeInvocation` (args nas linhas 216-223, sem campo de sandbox); `scripts/forge-codex-renderer.js` `render` (TOML de agente, constante `AGENT_SANDBOX_COMMENT`) | worktree isolado, claims validadas, reconciliação de writer, `.gsd/` publicado só pelo owner, verificação e revisão independentes |
| Sidecar app-server Codex | `sandboxPolicy` explícita a cada turno (`readOnly`, `workspaceWrite` com `networkAccess` explícito e, quando houver, `writableRoots`). No win32 sem writable roots, a política vira `dangerFullAccess`. A thread usa `approvalPolicy: 'never'` e `ephemeral: true`. | `scripts/forge-xllm.js` `CAPABILITY_SANDBOX_MODE` e `buildAppServerSandboxPolicy` (855-883), `threadParams` e `turnParams` (1213-1235), `authorizeSidecar` (2026-2049) | as mesmas, mais writable roots declaradas, `assertNoProtectedSidecarChanges` para `.gsd/**`, allowlist de ambiente (`buildSidecarEnv`), cwd do turno e reset cirúrgico no fallback |
| `codex exec` headless | `--sandbox` (`read-only` ou `workspace-write`) e `--ask-for-approval` (`never` ou `on-request`) explícitos. Qualquer outro valor é recusado antes do spawn. | `scripts/forge-headless.js` `buildInvocation` (143-156) e `authorize` (133-141) | `forge-dispatch-policy.decide` antes do spawn, cwd dentro do workspace, ambiente filtrado |
| Claude nativo | Allowlist de tools do frontmatter do agente e permission mode da sessão. A política devolve a projeção `tools` mínima por operação. | `scripts/forge-dispatch-policy.js` `base` (projeção nas linhas 88-90) e `claudeTools`; frontmatter `tools:` em `agents/*.md` | as mesmas, mais os hooks Claude (`operational-hooks` implemented) |
| Sidecar Claude | Modo somente leitura com `--tools Read,Glob,Grep` e `--allowedTools Read,Glob,Grep`. O modo escrita usa `--permission-mode acceptEdits`, regras explícitas de `--allowedTools` e `--add-dir` só para as writable roots. | `scripts/forge-claude-sidecar.js` `buildClaudeArgs` (937-951) | as mesmas |
| Claude headless | `--permission-mode plan` para read-only e `acceptEdits` para escrita. | `scripts/forge-headless.js` `buildInvocation` (154) | `forge-dispatch-policy.decide` antes do spawn |

### Modelo e esforço

Os args nativos Codex levam `model` e `reasoning_effort` exatamente como o
resolver os definiu. `buildNativeInvocation` recusa um modelo ou esforço que a
ferramenta ativa não declarou e nunca omite `model`. O sidecar app-server envia
`model` na thread e no turno, e `effort` no turno. Esta auditoria não muda
rota, modelo, esforço nem política global. O teste
`scripts/forge-codex-renderer.test.js` fixa que os args nativos Codex são
exatamente os seis campos acima, com modelo e esforço intactos.

## Garantias e quem as aplica

| Garantia | Componente que aplica | Natureza |
|---|---|---|
| Papel reviewer/observer só lê, sem spawn nem lease | `forge-dispatch-policy.decide` (`ROLE_POLICY`, `max_sandbox: 'read-only'`) | decisão antes do dispatch; app-server Codex e `codex exec` transportam política de sandbox; Claude transporta restrições de tools e permission mode, sem prova de fronteira independente do SO |
| Escalada de sandbox de custom agent é negada | `forge-dispatch-policy.decide` (`sandbox-escalation-denied`) | decisão declarada; vetores `reviewer-sandbox` e `custom-agent-danger` |
| `.gsd/**` pertence ao orquestrador | `forge-dispatch-policy.decide` (`protected-state-path`) e `assertNoProtectedSidecarChanges` | política e verificação do Forge |
| Escrita fica dentro do workspace e fora da home do outro host | `forge-dispatch-policy.decide` (`target-outside-workspace`, `cross-host-home`) | política do Forge |
| Root, claims e reconciliação de writer | contrato de execução, claims e reconciliação do owner | enforcement do Forge, independente do host |
| Sandbox do sistema operacional | host Codex, nos transportes com política de sandbox efetivamente enviada | para agentes nativos Codex, é a da sessão pai; allowlists e permission mode do Claude são controles do host, não prova de sandbox independente do SO |

### Negativos existentes de dispatch-policy

`scripts/fixtures/dispatch-security/negative-vectors.json`, exercitado por
`scripts/forge-dispatch-policy.test.js`, cobre `reviewer-sandbox` (reviewer
com `workspace-write` resulta em `sandbox-escalation-denied`) e
`custom-agent-danger` (worker com `danger-full-access` resulta em
`sandbox-escalation-denied`). A T01 registrou a suíte de dispatch-policy
passando, com a matriz dispatch-security de 108 linhas e 11 classes de falha,
igual à baseline. A T05 não muda esse código nem esses vetores. Esses
negativos provam a **decisão** do Forge e não um sandbox do host.

### Restrições testadas na T05

- Todo TOML de agente tem exatamente uma linha `sandbox_mode`, com valor
  `workspace-write`, e nunca declara `danger-full-access`.
- A linha de comentário imediatamente acima do campo diz que sandbox e
  aprovações efetivos vêm da sessão pai, que o campo não prova isolamento por
  agente e que este documento tem os detalhes. O marker de origem continua na
  linha 1.
- O relatório `adapters/codex/capabilities.json` resume essas permissões em
  `permissions` (veja `shared/forge-codex-renderer.md`).

## Limites conhecidos

- **Hooks Codex estão `planned`.** O inventário `hooks` tem `codex: planned`,
  e `codexSources` não o projeta. Não existe, portanto, guarda PreToolUse no
  Codex. As garantias Codex que dependem de hook no Claude ficam com a
  política e as verificações do Forge.
- **win32 sem writable roots usa `dangerFullAccess` no sidecar app-server.**
  É uma decisão documentada em `forge-xllm.js` (comentário acima de
  `CAPABILITY_SANDBOX_MODE`, issues openai/codex 15850, 5824, 17179 e 14367).
  O modo read-only mantém `readOnly` em todas as plataformas. Nesse caminho, a
  defesa contra escrita indevida vem do Forge, não do SO.
- **O frontmatter `tools:` não vira allowlist no Codex.** O TOML Codex leva o
  Markdown canônico inteiro em `developer_instructions`, mas o Codex não tem
  campo equivalente de tools por agente. Restrições como as de `forge-memory`
  (Read/Glob/Grep) e de `forge-reviewer` (sem Write/Edit) são aplicadas pelo
  Claude e, no Codex nativo, ficam só como instrução.
- **A projeção Codex da dispatch-policy** (`{ host: 'codex', sandbox_mode,
  inheritance: 'explicit' }`) descreve a política que um transporte explícito
  deve carregar. O headless e o sidecar a carregam; o agente nativo
  `spawn_agent` não tem campo para isso.

## Achados G2

**G2-1. Papéis somente leitura no agente nativo Codex.** `forge-reviewer`,
`forge-plan-checker`, `forge-advocate` e `forge-discusser` se declaram
somente leitura em relação ao código nas instruções. Alguns deles gravam um
único artefato próprio, como o relatório de checagem ou o CONTEXT. No
transporte nativo Codex, o TOML declara
`workspace-write`, e a documentação oficial diz que o sandbox efetivo é o da
sessão pai. Assim, nesse transporte nenhuma garantia somente leitura vem do
`sandbox_mode` nem de outro sandbox por agente. Restam as instruções e as
garantias do Forge listadas acima (worktree, claims, reconciliação, `.gsd/` do
owner, revisão independente). Este levantamento não localizou verificação
pós-revisão de árvore inalterada específica do caminho nativo Codex.

- **Disposição:** registrado, **não corrigido** na T05. Trocar o TOML para
  `read-only` não criaria isolamento comprovado, porque o pai governa. Seria uma
  declaração sem efeito provado, contrária a este contrato. As correções reais
  exigem mudar rota ou acrescentar verificação fora dos arquivos da T05.
- **Opções para o owner**, com a recomendação primeiro:
  1. **(recomendada)** acrescentar ao fluxo de revisão uma verificação do Forge
     de que a árvore e o índice ficaram inalterados após uma unidade somente
     leitura nativa (snapshot antes e depois), com falha nomeada. Não muda
     rota nem permissão do host.
  2. Rotear unidades somente leitura Codex para o sidecar app-server, que já
     envia `readOnly` em todas as plataformas. Isso é mudança de rota e exige
     decisão explícita.
  3. Aceitar o limite documentado, mantendo a sessão pai em modo restrito
     quando houver revisão nativa.

**G2-2. Garantia aplicada só pelo `sandbox_mode` do TOML.** Nenhuma foi
encontrada. O valor é uniforme (`workspace-write`) em todos os agentes, nenhum
código do Forge o lê de volta como prova, e nenhuma decisão de política
depende dele. **Disposição:** campo mantido sem enfraquecimento, com o
comentário explícito e este contrato.

**G2-3. `dangerFullAccess` no win32 sem writable roots.** Esse limite é
preexistente e documentado. A garantia depende das verificações do Forge, não
do TOML. **Disposição:** registrado, sem mudança. Qualquer alteração é decisão
de política fora do escopo desta slice.

## Fora deste contrato

Este documento não muda rotas, política de sandbox, `shared/forge-dispatch.md`
nem preferências globais de modelo ou permissão. Também não declara aceite
humano. A aparência e a compreensão na interface ficam para o UAT final.
