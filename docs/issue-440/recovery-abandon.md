# Recuperação replay-first e abandono seguro — #440 S02

Relatório do produto e das evidências; o procedimento obrigatório é
[forge-procedure-recovery.md](../../shared/forge-procedure-recovery.md).
Os textos de dispatch/sidecar e as fontes forge-auto/forge-next apontam para ele.
Este relatório não concede autoridade nem substitui os gates executáveis.

## Ordem e fronteiras

1. Inspecionar processo e receipt reais; replay primeiro de toda saída retida válida.
2. Registrar a recusa operacional fechada, versionada por replay-refusal-v1.
3. Abandono provado por adaptadores vivos, backup verificado e reset cirúrgico nos claims.
4. Admitir novo begin na mesma geração de lease/claim pelo invoke canônico.

Receipt failed ou started vai para recoverUnitSidecar com o adaptador de abandono.
Nunca há relançamento manual com dispatch id novo; recusas aparecem pelo código.
Replay válido publica sem nova inferência; candidato salvo e resposta returned
custodial não equivalem automaticamente a saída publicável ou autoridade de replay.
Identidade, defeito do caller, claim divergente, pergunta funcional pendente,
autoridade ausente, saída retida, continuidade parcial, admissão de tempo,
entrada pendente e código desconhecido nunca habilitam abandono.
Só interrupted-no-output e transport-no-output são classes operacionais elegíveis;
a classificação é dado, nunca autoridade: abandonAttempt reclassifica ao vivo.
Timeout isolado não prova causa nem indisponibilidade; provider_called desconhecido
continua unknown, inclusive na normalização do #444.

## Provas, custódia e limites do censo

process-tree-custody-v1 estabelece custódia da família antes de executar o transporte.
No Windows, job sem breakaway, criação atômica e KILL_ON_JOB_CLOSE são reobservados
pelo kernel e ligados à origem genuína viva do ChildProcess, nonce e binding.
process-tree-census-v1 é amostragem diagnóstica: alive ou unknown, nunca stopped.
Um intermediário pode sair entre amostras e deixar neto órfão vivo.
PID isolado, nome de job, job vazio/ausente, journal, JSON autoconsistente ou hash
recalculado não provam a origem. Um registro de outro job vazio não a concede.
Prova de writer parado não substitui a de descendentes nem as atestações do owner
e de todas as raízes físicas do execution_contract v2.
Após reinício sem origem viva confiável, a prova é unknown e recusa abandono,
retomada do reset e sucessor por nome, preservando backups e histórico.
Registro abandoned/reset-verified é histórico, nunca autorização atual.
WMI, serviço, agendador e ativação COM podem lançar processos fora da descendência;
a custódia não é sandbox do SO nem proteção contra quem controla o host.

## Backup, reset, autoridade e stores

O fluxo exige perguntas resolvidas explicitamente, autoridade permanente revalidada
pelo adaptador vivo, S0 íntegro, delta explicado, owner atribuído pela cadeia S01
e claims concretos em todas as raízes. Revalida tudo antes de reset e por raiz.
Backup exclusivo imutável relido usa blobs por sha256 e manifesto; overlap, glob,
link e caminho fora do claim são recusados antes da mutação. Reset parcial bloqueia.
Receipt original, reset-state/S0 e histórico não são reescritos pelo abandono.
Stores são externos ao owner, .gsd e todas as raízes, ao lado do resultFile:

| Store | Conteúdo e limite |
|---|---|
| resultFile.process-tree.jsonl | Binding, nonce, modo, amostras e join; diagnóstico auxiliar |
| resultFile.process-tree.custody.jsonl | Journal encadeado do supervisor; não concede origem |
| resultFile.abandon.jsonl | Append exclusivo, sem link, prefixo por hash/tamanho/identidade |
| resultFile.abandon/backup/manifest.json | Manifesto imutável relido e blobs/sha256 |
| recovery state | replay_refusals e abandonments append-only e deduplicados |

Linhas do registro: refusal, owner-event, proofs, backup, reset-started, reset-root,
reset-verified/reset-partial, abandoned, successor-admitted e refused.
Eventos usam append canônico guardado pelo owner; cerca ocupada registra
owner_event: pending-window, sem byte no owner. managed-surfaces-v1 não é ampliado.
Diagnóstico guarda códigos, contagens e hashes, sem credencial ou payload privado.

## Escopo, legado e sucessor

Abandono novo suporta execute-task de milestone, execution_contract v2 e recovery_baseline v1
em sidecar supervisionado. Standalone, review-fix, nativo e receipt legado sem prova
recusam com nome e mantêm seu caminho existente; host Codex mantém seu contrato.
Sem recovery.abandonment opt-in, recuperações seguem o comportamento legado.
No linux/darwin e em formas sem custódia, a prova é unknown, sem reset autorizado.
.cmd/.bat, shell e formas não reproduzíveis seguem spawn simples, sem prova stopped.
A admissão do controller é somente leitura: mesmo begin, owner, lease_generation
e digest do claim, sem terminal ou transação pendente. Não chama reenter.
O sucessor usa recoveryDispatchId(pai), lista/candidatos atuais e destino tentado excluído;
ceilingFromRoute entrega teto integral do tier, sem novo retry ou lista de modelos.
Um só candidato pode terminar em recovery-candidates-exhausted após abandono registrado.
Admissão de tempo prevalece, incluindo transaction-pending e códigos canônicos de tempo;
limites de ciclos/orçamento de review-fix continuam iguais e não habilitam abandono.
Perguntas com IDs estáveis permanecem pendentes até resposta real; autorização de routing
não responde pergunta funcional nem muda isolamento, claims, gates ou revisão.

## Tabelas de códigos

Cada tabela nomeia módulo e export; a suíte exige igualdade integral e literal na fonte.
As duas tabelas de guardas de entrada abaixo são conferidas separadamente: os guards
são literais diretos e também integram os exports finais pós-T06 (não são omitidos).

### replay-refusal-v1

Módulo: scripts/forge-replay-refusal.js; export: REASON_CODES.

| Código | Classe |
|---|---|
| replay-refusal-interrupted-no-output | operacional elegível; exige provas vivas |
| replay-refusal-transport-no-output | operacional elegível; exige provas vivas |
| replay-refusal-inspection-required | bloqueante ou entrada/integridade |
| replay-refusal-not-attempted | bloqueante ou entrada/integridade |
| replay-refusal-identity-conflict | bloqueante ou entrada/integridade |
| replay-refusal-caller-defect | bloqueante ou entrada/integridade |
| replay-refusal-claim-divergent | bloqueante ou entrada/integridade |
| replay-refusal-question-pending | bloqueante ou entrada/integridade |
| replay-refusal-authority-missing | bloqueante ou entrada/integridade |
| replay-refusal-retained-output | bloqueante ou entrada/integridade |
| replay-refusal-partial-continuation | bloqueante ou entrada/integridade |
| replay-refusal-time-admission | bloqueante ou entrada/integridade |
| replay-refusal-input-required | bloqueante ou entrada/integridade |
| replay-refusal-unknown-code | bloqueante ou entrada/integridade |
| replay-refusal-version-unknown | bloqueante ou entrada/integridade |
| replay-refusal-classification-invalid | bloqueante ou entrada/integridade |
| replay-refusal-input-invalid | bloqueante ou entrada/integridade |

### process-tree

Módulo: scripts/forge-process-tree.js; export: REASON_CODES.

| Código | Classe |
|---|---|
| process-tree-unavailable | recusa nomeada |
| process-tree-record-missing | recusa nomeada |
| process-tree-record-invalid | recusa nomeada |
| process-tree-binding-mismatch | recusa nomeada |
| process-tree-root-unbound | recusa nomeada |
| process-tree-survivors | recusa nomeada |
| process-tree-custody-unavailable | recusa nomeada |
| process-tree-custody-failed | recusa nomeada |
| process-tree-custody-unproved | recusa nomeada |
| process-tree-census-only | recusa nomeada |

### abandonment

Módulo: scripts/forge-attempt-abandon.js; export: REASON_CODES.

| Código | Classe |
|---|---|
| abandon-adapter-required | recusa nomeada |
| abandon-unit-unsupported | recusa nomeada |
| abandon-identity-conflict | recusa nomeada |
| abandon-refusal-not-operational | recusa nomeada |
| abandon-writer-live | recusa nomeada |
| abandon-writer-unknown | recusa nomeada |
| abandon-descendants-unproved | recusa nomeada |
| abandon-descendants-alive | recusa nomeada |
| abandon-root-unproved | recusa nomeada |
| abandon-questions-pending | recusa nomeada |
| abandon-authority-missing | recusa nomeada |
| abandon-authority-invalid | recusa nomeada |
| abandon-baseline-missing | recusa nomeada |
| abandon-baseline-invalid | recusa nomeada |
| abandon-delta-legacy | recusa nomeada |
| abandon-delta-unexplained | recusa nomeada |
| abandon-backup-unverified | recusa nomeada |
| abandon-changed-after-proof | recusa nomeada |
| abandon-reset-partial | recusa nomeada |
| abandon-reset-unproved | recusa nomeada |
| abandon-record-conflict | recusa nomeada |
| abandon-input-invalid | recusa nomeada |

### events

Módulo: scripts/forge-attempt-abandon.js; export: EVENT_NAMES.

| Código | Classe |
|---|---|
| attempt-replay-refused | evento canônico |
| attempt-abandon-refused | evento canônico |
| attempt-abandoned | evento canônico |
| attempt-successor-admitted | evento canônico |
| attempt-successor-refused | evento canônico |

### backup-reset

Módulo: scripts/forge-surgical-reset.js; export: BACKUP_RESET_CODES.

| Código | Classe |
|---|---|
| reset-unclaimed-change | recusa nomeada |
| reset-concrete-claims-required | recusa nomeada |
| backup-conflict | recusa nomeada |
| backup-target-invalid | recusa nomeada |
| backup-unverified | recusa nomeada |
| reset-target-changed | recusa nomeada |
| reset-partial | recusa nomeada |
| reset-overlap | recusa nomeada |
| baseline-moved | recusa nomeada |
| reset-pre-dirty-changed | recusa nomeada |
| reset-unverified | recusa nomeada |
| reset-input-invalid | recusa nomeada |

### successor

Módulo: scripts/forge-unit-controller.js; export: ATTEMPT_SUCCESSOR_CODES.

| Código | Classe |
|---|---|
| attempt-successor-begin-changed | recusa nomeada |
| attempt-successor-generation-changed | recusa nomeada |
| attempt-successor-claim-divergent | recusa nomeada |
| attempt-successor-terminal | recusa nomeada |

### reset-input-guard

Módulo: scripts/forge-surgical-reset.js; literal de guarda de entrada (verificação separada).

| Código | Classe |
|---|---|
| reset-input-invalid | entrada inválida; nunca habilita mutação |

### abandon-input-guard

Módulo: scripts/forge-attempt-abandon.js; literal de guarda de entrada (verificação separada).

| Código | Classe |
|---|---|
| abandon-input-invalid | entrada inválida; nunca habilita mutação |

## Qualificação A7 e evidência histórica

Baseline real imutável: master CI44972867644, revisão4606de1ecac3ddee7bc957d9a8dea3207023d5b5/v4.51.14.
Origem: 27 artefatos Windows com digest da API conferido, 40 perfis, partição completa
575 unidades únicas, todas observadas pass. A7 seleciona52 suítes-fonte/54 unidades CI;
não representa198 rótulos internos nem execução local desta task.
Fonte owner: T07-A7-CI-BASELINE.json, sha256 faa89d73782b89acba5aec491a7bd655e81ee71d479518768312339907303273.
Labels/status sha256: 68b804cabc22b476a3b89b1cceadfd8eb6a7d2ea548daed6935b0e365c2447a0.
Ambiente observado: Windows x64 10.0.26100, Node22.23.5, imagewin25-vs2026/20261116.315.1;
CPU varia por runner; fila indisponível e cache unknown permanecem assim nos perfis.
Local Node24 não é ambiente igual. Tempos por partição não são wall clock da suíte inteira.
Os perfis originais preservam timing, ambiente e campos indisponíveis por unidade.

| Suíte-fonte histórica | Status histórico | Comparação final S03 |
|---|---|---|
| forge-attempt-recovery.test.js | pass | PENDENTE |
| forge-bidirectional-sidecar.test.js | pass | PENDENTE |
| forge-claim-recovery.test.js | pass | PENDENTE |
| forge-claude-sidecar.test.js | pass | PENDENTE |
| forge-completion-delivery-recovery.test.js | pass | PENDENTE |
| forge-delivery-owner-resume.test.js | pass | PENDENTE |
| forge-evidence-owner.test.js | pass | PENDENTE |
| forge-hook-ownership.test.js | pass | PENDENTE |
| forge-native-recovery-delivery.test.js | pass | PENDENTE |
| forge-native-recovery-issues.test.js | pass | PENDENTE |
| forge-owner-boundaries.test.js | pass | PENDENTE |
| forge-owner-root-observation.test.js | pass | PENDENTE |
| forge-owner-transport-window.test.js | pass | PENDENTE |
| forge-owner-window-recovery.test.js | pass | PENDENTE |
| forge-owner-worktree-recovery.test.js | pass | PENDENTE |
| forge-ownership.test.js | pass | PENDENTE |
| forge-plan-generation-sidecar.test.js | pass | PENDENTE |
| forge-projection-ownership.test.js | pass | PENDENTE |
| forge-recovery-authority.test.js | pass | PENDENTE |
| forge-recovery-contract-369.test.js | pass | PENDENTE |
| forge-recovery-diagnostic.test.js | pass | PENDENTE |
| forge-recovery-dispatch-id.test.js | pass | PENDENTE |
| forge-recovery-reservation-lineage.test.js | pass | PENDENTE |
| forge-recovery-transition.test.js | pass | PENDENTE |
| forge-recovery-workflow-budget.test.js | pass | PENDENTE |
| forge-recovery-workflow.test.js | pass | PENDENTE |
| forge-retained-owner-retransfer.test.js | pass | PENDENTE |
| forge-sidecar-calibration-v2.test.js | pass | PENDENTE |
| forge-sidecar-calibration.test.js | pass | PENDENTE |
| forge-sidecar-diagnostic.test.js | pass | PENDENTE |
| forge-sidecar-identity.test.js | pass | PENDENTE |
| forge-sidecar-liveness.test.js | pass | PENDENTE |
| forge-sidecar-local-proof.test.js | pass | PENDENTE |
| forge-sidecar-verification-successor-standalone.test.js | pass | PENDENTE |
| forge-sidecar-verification-successor.test.js | pass | PENDENTE |
| forge-standing-silence-recovery.test.js | pass | PENDENTE |
| forge-surgical-reset-guard.test.js | pass | PENDENTE |
| forge-surgical-reset-install.test.js | pass | PENDENTE |
| forge-surgical-reset-telemetry.test.js | pass | PENDENTE |
| forge-surgical-reset.test.js | pass | PENDENTE |
| forge-svn-preparation-recovery.test.js | pass | PENDENTE |
| forge-unit-sidecar.test.js | pass | PENDENTE |
| forge-xllm-appserver.test.js | pass | PENDENTE |
| forge-xllm-capability.test.js | pass | PENDENTE |
| forge-xllm-claude.test.js | pass | PENDENTE |
| forge-xllm-defend.test.js | pass | PENDENTE |
| forge-xllm-evidence.test.js | pass | PENDENTE |
| forge-xllm-review-cli.test.js | pass | PENDENTE |
| forge-xllm-runtime.test.js | pass | PENDENTE |
| forge-xllm-state.test.js | pass | PENDENTE |
| forge-xllm-telemetry.test.js | pass | PENDENTE |
| forge-xllm.test.js | pass | PENDENTE |

### Unidades CI históricas: status, timing e origem

Tempo é elapsed_ms observado por unidade, não wall clock agregado; condition é o
hash do ambiente preservado na fonte. Args, signal e campos ausentes ficam nos perfis.

| Unidade | Status histórico | elapsed_ms | Artefato/perfil | SHA256 perfil | condition SHA256 |
|---|---|---|---|---|---|
| forge-attempt-recovery.test.js | pass | 52178 | 14733948875/worker-0.json | 4ea3ac95e625ce5c1b629cb1f3070de8b93611add9301d6c04dc7f8c5daa5c18 | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-bidirectional-sidecar.test.js | pass | 76432 | 14734627374/worker-1.json | 1abfaf246a77ac5b881964bce1acdcfd19b99ed18d50c891790afbd622d00705 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-claim-recovery.test.js | pass | 4028 | 14734393720/worker-0.json | 5ce1320d8290638ad6f56f091d4ad5f3e29718787ddceda6d133e7acd59492d5 | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-claude-sidecar.test.js | pass | 69085 | 14734413210/worker-0.json | a8691304e1448c4e2646cd39e755d42d679ce89e7ba06ed7ec0a1031db1fed38 | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-completion-delivery-recovery.test.js | pass | 89305 | 14734368414/worker-0.json | 73a8c0edf584740298df1b007e915948f3ca7b05c20719693ca3279beffc22ca | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-delivery-owner-resume.test.js | pass | 76008 | 14734826587/worker-0.json | c600545000e5443934689c06a137395cf0ce7977817dc78b14dda0abf76c6bd9 | 59511913ef32b3665d01a10a28321704d4709d71172d0e46c1cc2d909344cb12 |
| forge-evidence-owner.test.js | pass | 912 | 14734896166/worker-0.json | 576bb946780ace17abcc914a568e96ffaa5923f29d3f030bf20dcca3e0a52258 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-hook-ownership.test.js | pass | 1422 | 14734159266/worker-0.json | f9c7e822d6044a89c3f9ddd24ade16750b89fb8f9025bd21db1140cb04a63191 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-native-recovery-delivery.ci-01-of-3.test.js | pass | 333045 | 14735005686/worker-0.json | 834cc8885a9d36638f2e8c44fc0650c544c1d4d85274ce70151e0ce35e9efc02 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-native-recovery-delivery.ci-02-of-3.test.js | pass | 363382 | 14734732066/worker-0.json | 901394b0da7bc3a6b8c32e7a8e654d3a22b4c024e45e7909907f42cc73cbe964 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-native-recovery-delivery.ci-03-of-3.test.js | pass | 248372 | 14734177674/worker-0.json | 64c6df4b6b2f22acc38aeb34b8b372cea580bd7e25704e96dfb9e257700513bd | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-native-recovery-issues.test.js | pass | 150162 | 14734627374/worker-1.json | 1abfaf246a77ac5b881964bce1acdcfd19b99ed18d50c891790afbd622d00705 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-owner-boundaries.test.js | pass | 29297 | 14734159266/worker-0.json | f9c7e822d6044a89c3f9ddd24ade16750b89fb8f9025bd21db1140cb04a63191 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-owner-root-observation.test.js | pass | 5063 | 14735005936/worker-0.json | 45f5015daebe9bc2f06bcfc375946cefe782478d4ea6e56df22581fe45d03a9e | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-owner-transport-window.test.js | pass | 11125 | 14734147834/worker-0.json | 27522371bbc23b78167c7e5da53db64a6600217d771337fd05c96968bc9df8bb | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-owner-window-recovery.test.js | pass | 27182 | 14734159266/worker-0.json | f9c7e822d6044a89c3f9ddd24ade16750b89fb8f9025bd21db1140cb04a63191 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-owner-worktree-recovery.test.js | pass | 189390 | 14734697262/worker-1.json | 8fde14f8240e1cda9f9cec2fa3290076f5b309a2bf25ef3db77add7213e71097 | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-ownership.test.js | pass | 51 | 14734413210/worker-1.json | d4014232a7d2422d5978133733c419a13207859a7c9a5cd5eb989c964115482b | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-plan-generation-sidecar.test.js | pass | 13914 | 14734836498/worker-0.json | bf8316275853bf384dcf4af46ffe3ae88b2dce3be2fbb816769a30398ce5b654 | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-projection-ownership.test.js | pass | 47 | 14734776681/worker-0.json | 4f806e0766c1e33f8dc19a8bdec76af75a1ce0a78758796640ef29e22415b879 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-recovery-authority.test.js | pass | 258 | 14734826587/worker-1.json | 96fc2ef790f54b5ce5010b703b634796fbbead44455ce47cef895965d1a747ca | 59511913ef32b3665d01a10a28321704d4709d71172d0e46c1cc2d909344cb12 |
| forge-recovery-contract-369.test.js | pass | 43489 | 14734204091/worker-0.json | fbf1b87f0e3b0bf408d7cd78d5dfcac6d6bcc1adbb3998982175c0f7b18eacbd | 59511913ef32b3665d01a10a28321704d4709d71172d0e46c1cc2d909344cb12 |
| forge-recovery-diagnostic.test.js | pass | 22554 | 14734896166/worker-0.json | 576bb946780ace17abcc914a568e96ffaa5923f29d3f030bf20dcca3e0a52258 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-recovery-dispatch-id.test.js | pass | 142 | 14733948875/worker-1.json | a571a8705159d03719c162a1deda89864f310dc152aca4814ba49d223218638c | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-recovery-reservation-lineage.test.js | pass | 78 | 14734159266/worker-1.json | ff565a84520d4c440598c50f9dc970fdc526abb9e9ec8b576fdb2ff04c27c9c4 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-recovery-transition.test.js | pass | 138137 | 14735005936/worker-1.json | 23c7baedf3f4cad617693168dc8f7ba766940c88d20441829bfaac76472c59c9 | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-recovery-workflow-budget.test.js | pass | 9306 | 14735005686/worker-0.json | 834cc8885a9d36638f2e8c44fc0650c544c1d4d85274ce70151e0ce35e9efc02 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-recovery-workflow.test.js | pass | 161664 | 14734896166/worker-0.json | 576bb946780ace17abcc914a568e96ffaa5923f29d3f030bf20dcca3e0a52258 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-retained-owner-retransfer.test.js | pass | 48465 | 14734063600/worker-0.json | 7c062331846f8504a3213f9e4e825350512879e9f3f8707abdb2c4e492711cad | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-sidecar-calibration-v2.test.js | pass | 657 | 14734627374/worker-1.json | 1abfaf246a77ac5b881964bce1acdcfd19b99ed18d50c891790afbd622d00705 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-sidecar-calibration.test.js | pass | 607 | 14734697262/worker-1.json | 8fde14f8240e1cda9f9cec2fa3290076f5b309a2bf25ef3db77add7213e71097 | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-sidecar-diagnostic.test.js | pass | 6997 | 14733993393/worker-1.json | c2470958ad4887b19f3aaeefb42cefbd9c018b1e363c0ec9fb98c20441067fb7 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-sidecar-identity.test.js | pass | 53 | 14734836498/worker-0.json | bf8316275853bf384dcf4af46ffe3ae88b2dce3be2fbb816769a30398ce5b654 | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-sidecar-liveness.test.js | pass | 109 | 14734159266/worker-0.json | f9c7e822d6044a89c3f9ddd24ade16750b89fb8f9025bd21db1140cb04a63191 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-sidecar-local-proof.test.js | pass | 2975 | 14734368414/worker-1.json | 7fecacde1fed8da2dfbb0438660a0af60c5eeb04bacc2a6af3d7d4b105f503a9 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-sidecar-verification-successor-standalone.test.js | pass | 67002 | 14734413210/worker-1.json | d4014232a7d2422d5978133733c419a13207859a7c9a5cd5eb989c964115482b | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-sidecar-verification-successor.test.js | pass | 72145 | 14734697262/worker-0.json | b295dc107ec47bd10190908defc50a4a5e195a1f0e607e08af77c4c74a5a49cd | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-standing-silence-recovery.test.js | pass | 1826 | 14735005936/worker-0.json | 45f5015daebe9bc2f06bcfc375946cefe782478d4ea6e56df22581fe45d03a9e | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-surgical-reset-guard.test.js | pass | 1231 | 14734697262/worker-0.json | b295dc107ec47bd10190908defc50a4a5e195a1f0e607e08af77c4c74a5a49cd | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-surgical-reset-install.test.js | pass | 1079 | 14734413210/worker-1.json | d4014232a7d2422d5978133733c419a13207859a7c9a5cd5eb989c964115482b | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-surgical-reset-telemetry.test.js | pass | 276 | 14734204091/worker-0.json | fbf1b87f0e3b0bf408d7cd78d5dfcac6d6bcc1adbb3998982175c0f7b18eacbd | 59511913ef32b3665d01a10a28321704d4709d71172d0e46c1cc2d909344cb12 |
| forge-surgical-reset.test.js | pass | 20305 | 14734697262/worker-1.json | 8fde14f8240e1cda9f9cec2fa3290076f5b309a2bf25ef3db77add7213e71097 | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-svn-preparation-recovery.test.js | pass | 5606 | 14733784055/worker-0.json | e03c535925c2744a7a445166791d608cb9831ad4ac34b09da304bd6e8dd268d1 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-unit-sidecar.test.js | pass | 398513 | 14734747171/worker-0.json | b7a5280d8a3fb14f0b639d14e12799e727e57cbf459013d30c7e9b35f9df7379 | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-xllm-appserver.test.js | pass | 21980 | 14734368414/worker-1.json | 7fecacde1fed8da2dfbb0438660a0af60c5eeb04bacc2a6af3d7d4b105f503a9 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-xllm-capability.test.js | pass | 98 | 14734413210/worker-1.json | d4014232a7d2422d5978133733c419a13207859a7c9a5cd5eb989c964115482b | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-xllm-claude.test.js | pass | 10780 | 14734159266/worker-1.json | ff565a84520d4c440598c50f9dc970fdc526abb9e9ec8b576fdb2ff04c27c9c4 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-xllm-defend.test.js | pass | 1362 | 14734368414/worker-1.json | 7fecacde1fed8da2dfbb0438660a0af60c5eeb04bacc2a6af3d7d4b105f503a9 | 695d1769359c2bb6ffbe58af55c0db8ae314b892254c9075a012023692bebe50 |
| forge-xllm-evidence.test.js | pass | 2198 | 14734915995/worker-1.json | 35c9cf446014774c06f8ed11e0f3347b5df8e53449941fdc4566bc84b39e8794 | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-xllm-review-cli.test.js | pass | 7571 | 14735045014/worker-0.json | 08c29d56d026264b4926a4fca1898395e23537b4923392e4102cdeaf6def9c71 | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |
| forge-xllm-runtime.test.js | pass | 9890 | 14734393720/worker-0.json | 5ce1320d8290638ad6f56f091d4ad5f3e29718787ddceda6d133e7acd59492d5 | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-xllm-state.test.js | pass | 61 | 14734147834/worker-0.json | 27522371bbc23b78167c7e5da53db64a6600217d771337fd05c96968bc9df8bb | 00046daf20d317ec8cd7d7fafd6283462ceae4e585715d522f628360825acc09 |
| forge-xllm-telemetry.test.js | pass | 137 | 14734204091/worker-0.json | fbf1b87f0e3b0bf408d7cd78d5dfcac6d6bcc1adbb3998982175c0f7b18eacbd | 59511913ef32b3665d01a10a28321704d4709d71172d0e46c1cc2d909344cb12 |
| forge-xllm.test.js | pass | 1931 | 14734836498/worker-1.json | a9fbc7e22812c71182d05f288f977a5bef7fbe6b31c4cf0cf0b683b1604a2e8b | efe985f0f94983735d4a4b42bdcc08dab4ee75b8543bf4f177cb71f5e6c37c55 |

Adições A7 separadas: forge-surgical-reset-backup.test.js (T03) e
forge-issue-440-recovery.test.js (T06); nenhuma remoção observada no inventário atual.
Unidades CI dessas adições só serão conhecidas na descoberta real do CI final.
A comparação de labels comuns, adições/remoções, status e ambiente é gate OBRIGATÓRIO
do CI S03 na revisão final antes de complete-milestone/merge; permanece PENDENTE.
Não foi materializado/rodado master ou A7 completo localmente, nem repetido native198.

### Três observações pós-T06 reutilizáveis

Cada observação real teve exit0, joined e active_processes0; é evidência histórica,
não nova execução T07. Fontes runtime e testes têm de permanecer byte a byte iguais.
As instruções/procedimento T07 mudam intencionalmente fingerprints de contexto;
não alegamos igualdade do contexto completo. Novos checks de texto qualificam essa mudança.

| Suíte | SHA256 do teste | SHA256 do spool completo | Labels retidos |
|---|---|---|---|
| forge-native-recovery-delivery.test.js | 2f7bf283c5833866d7db2ec1c179018763219786e2f899a51686f7303682d483 | 3c5a8b514d1c5e9463642465800694374a5583fa9d8d66677d23a42da2fcba25 | 31 |
| forge-owner-window-recovery.test.js | 8d4cf6381b6a3d0a5c39a0f05d01cfb1271567cedf7370aa65d2fa1f7a5ace57 | 3c49f9ffd65a2e04b48325c6a65aa157fa7af4fd201ad530ffc775614d138c54 | 1 |
| forge-recovery-contract-369.test.js | 00e7883ca5ca6173e19342c50abf01af1685844253ab2c9ea07cb0e59b41bd92 | 8bc385fa304e1be093312e769a3d1c78b4c633b31205bd0d817313385b377a5d | 0 |

## Deriva: inventário e atribuição

O censo histórico distingue87 consumidores diretos e22 indiretos (há interseção).
Mapa histórico SHA256 c74c894c5a7c3e830ea569ff580b77f77a25d37fd6a79b6e4d00af71e1513a77.
Busca inicial adicional por caminhos completos literais encontra59 suítes; não é
substituto do censo87, que inclui outras formas de referência. A busca estática por
basename completo preserva os87 anteriores e encontra88 após incluir a nova suíte docs;
só as fontes dos dois testes de pins mudam no inventário histórico87. Nenhuma baseline87/18
foi repetida: o owner preserva fontes e mede delta estático; CI final executará consumidores.
Só os onze writes T07 podem mudar nesta task; produção T01–T06 permanece intacta.
Quatro textos/skills mais recovery/inventário mudam entradas de prompt/renderers/camadas;
CHANGELOG e os dois filtros medidos mudam só a admissão da nova linha.
Nenhum golden, camada, distribuição histórica ou fixture foi repinado: normalização é S03.
Falhas novas devem ser avaliadas individualmente, nunca aceitas por exit1 genérico.

### Consumidores diretos históricos (origem preservada)

| Fonte | SHA256 anterior | Entradas lidas/fixadas |
|---|---|---|
| scripts/forge-app-sidebar.test.js | 411d4a766ad6016f6c5494c7a6f64993ebb4937f4b3e40cd13aca15a1890d17d | CHANGELOG.md |
| scripts/forge-bidirectional-sidecar.test.js | a9236c38eb51e45691bc454c4a9a31bd8dfa28139cb7732ea3d2696a13c06edb | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-capabilities.test.js | a03caecc0ada363b1f36e617a473de008a4f4d590b0ed27c18e29fb400e31d56 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-capture.test.js | 9f5e4361c64ea4b34a0ebced9fc54626a341433802ef62b6454475eae80b5bf6 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-claim-code-dir.test.js | b31957b6b03ea18f6bb405c1a82ffc1a0d117139f4bbf125ab856a6f4319cec8 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-claim-fence-halt.test.js | 14b09d5ebf96f1c182250e66d96a21a71ef70e724eae3e98d4fefc9aac965baa | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-claim-gate.test.js | 5f0bcbb4c58da1857861e13c45bb3e53b400d10c7849e4cfb495c70ad615477a | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-claude-renderer.test.js | ca5063fd7bb3fa7adf41b83b7c0b96e2d336e314d518df5fb7e5544feffb2c10 | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-codex-renderer.test.js | f12b9f728e64eb402cd744826c50a86778d2334c71fec486d6411cab3aa36579 | shared/forge-procedures.json, shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-communication-evaluation.test.js | 454a8f414f2bbe98e8878b2b08b09c89a3240055af0a02e6051e4a3078eebc4d | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-communication-surfaces.test.js | 58dc074fb1829cb722c770a42549cd3ab2c3669a3e8f39d11b65d453f54ed048 | shared/forge-dispatch.md, shared/forge-bidirectional-sidecar.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-completer-artifacts.test.js | cf592d4a2817686aa2bcead82710506ac68b1fb3d00629826bdab8823884df76 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-context-boundary.test.js | 528b7d138a83892d6568a742e844ae102f3ae3fc666d28effc11d49de500f7ad | shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-context-budget.test.js | 95e5ca191125242fec361b860f2cfae4696e6d4476e7a7a9b2b2a6262db8106b | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-context-delivery.test.js | 65c4fd592bb205c47be2010c1e566ae35d0ff647f5e696351a224491cedfe3d6 | shared/forge-procedures.json |
| scripts/forge-curate-skill.test.js | 84a27bb28ebd52f1fb633e37539e76804df1aff65ca3acb929d5ca5b836e3b9e | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-dispatch-event.test.js | 2395b50bcf790e052e118690b948ea5c145be6508e1e746d079dfdec11b5bf2e | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-dispatch-resolve.test.js | e6c54dccf201c29ccd0b5b41cc7b707d681f7d32ae0ec6fcbd8be3ab06194f01 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-dispatch-source-guard.test.js | 3232c46bdba34bcc3bc11b5f00abf6a86e4960b782e9eb4d73f206ceac4bd1f8 | shared/forge-procedures.json, shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-doc-claims.test.js | 38dd72e893872a5add91c652eeda9fdc49fb550f767646dd5266faace865f8c4 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-doctor-run-overlap.test.js | 7c57ff4602fd8d37ddd25770f51b331cfa05d994294fdcd7e23a9067c3da5723 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-empirical-baseline.test.js | 6f3c22700b86ed887fce9cd5b92d1a06f1b04a5a500b5e5e2df2ac1d2dd5ea2a | shared/forge-procedures.json |
| scripts/forge-estimate-unit-inventory.test.js | 0b4040ce2dd5063ecbe609eb40c0cb88926e884f71a9a373d9e351c91c18f672 | shared/forge-procedures.json |
| scripts/forge-evidence-materialize.test.js | 7ceb82b07266ca173714d294c256ac8382e6defe5a368b9ee16f20fbb6403b60 | shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-evidence-unit-context.test.js | b96ccab0d9d39c92cabec37ab70336dab01b174eaf91acf17afb927ef7d73b94 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-evidence-writers.test.js | e1b47d24e848f951a1e9c7f1dbcb9d54f292da0aabe9321705667dd1952a61fc | shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-generation.test.js | c7b67dafa26838498dfd072eca5e4bd1755529611a8602cca8eb0117eb8fd2d9 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-incomplete-resume-distribution.test.js | 36b3be817ed0b913bc75332582517951dc946012aaa84869979cacd45f5ef0fe | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-install-templates.test.js | c4fcc734575d03a856de6b4445471785a3854e81e796c2c0eb42c279832e2398 | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md, scripts/forge-review-policy-distribution.test.js |
| scripts/forge-installer.test.js | 369e5aa61899912d0e51f15ceabad80370bff206b749de0711f7f355ef1a2786 | shared/forge-procedures.json, shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-intent-entry-integration.test.js | cb26170d2caca68c3090f415d486bab06d7ab7f308600604b33b2df370d4f8d3 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-isolation.test.js | 4eee7cb1c092971c72c55b76d0bbc9fe6f92f8fae1ea351d423f481764ff0d8f | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-issue-399-distribution.test.js | ad6c4a9bd406237403c75590c263220be9da950ea77d461ecdd027a3bfc13cf7 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-issue-401-distribution.test.js | 8356d05420c8a9cd8ff971bf299900d8fa06b2e75e1bd37da0c2e3bce727d1ad | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-issue-416-distribution.test.js | 8293528b9583257b6957ef183e51784f5579b70566bb9ca62da68bdbe18d4152 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-issue-418-distribution.test.js | 382d367547fab736617fd38c8944092bdcadbae3a22bbf963c2bc2a8f291db5d | shared/forge-bidirectional-sidecar.md |
| scripts/forge-issue-campaign-distribution.test.js | 4a238b93d44736a0ad7b530cc1a17538876e68133416a853bb79415bf31403d5 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-issues-403-404-distribution.test.js | a8b566dcdb0932c6c9de1b1b592583efac5b2d767952352cfe688472fbec9da6 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-issues-403-407-integration.test.js | 850d4a1c5d2c05e0214745b1b1ac4aa67e3f1c3bca92b7014c071c825c375f9a | scripts/forge-milestone-time-chain.test.js |
| scripts/forge-issues-410-413-distribution.test.js | dd4544762bead71cf300dadc1d3a4f82f6f654705cfdb0010cd0c7ee171be07d | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-linked-task-parity.test.js | 6d7d138b4c94f9728ec5291b39267f7414e99cbcf9d92b918bcc30b0aff4646b | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-long-workflow-adapter.test.js | ae8ec8248248f67797a3e14a9e76ea421cac6f9aa8eddaf4aa96c7c427b51d2a | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-memory-evidence-distribution.test.js | 90d88bb095509089bb598b4573136e8db2c9865cb7174b878ad5a54a0e8ece22 | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-milestone-options-acceptance.test.js | 1c6ef42f888c8193dfb0874362c2d400fa0b403c5a9d716c24a306ef5729d02a | shared/forge-procedures.json |
| scripts/forge-milestone-options-flow.test.js | c94225e7c381d67b33c686fcbcd04b0669fa2645f498750289680bea8f362126 | shared/forge-procedures.json |
| scripts/forge-milestone-time-chain.test.js | 6b171bd3cb370c51c7d874be2072d7ad8f01581022d8372fee1d097dc59be5f4 | shared/forge-procedures.json, CHANGELOG.md |
| scripts/forge-milestone-time-reentry.test.js | 2955be2c3180d0898027135b01c85547e4c97e11928ad244723fb2a70b59b219 | shared/forge-procedures.json |
| scripts/forge-milestone-time-transport.test.js | 8ec43690af0029eae664dffbf77db632fdfbe2801a3d567c9bd422711c6bfb6b | shared/forge-procedures.json |
| scripts/forge-milestone-time.test.js | c65205befc54ad859059470d2947d861c337f7f57beb6d3c875fd67a5186f33b | CHANGELOG.md |
| scripts/forge-native-runtime.test.js | 07350909caefcf943ca1e7aee4e5f495e6fabd25d102912a4a4fb58d5b7693e5 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-owner-boundaries.test.js | 45d3e6e7f3a8fe501eabc2b578050d21a915b73b05bb388e6b57c4f889bd4d7c | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-personal-context-integration.test.js | ca742edc9bd05ecae6a6b491a8201a929430fb341e992d043f2fe3e1d0049c73 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-plan-gate.test.js | 575c645b878bd61613037671f98cc6c986f502c62ef03611327d22e3fb64058c | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-plan-generation-sidecar.test.js | d1cf54b593bed4192fbee68f3fd06ae73e083f93d0a28e6e161eaa4eeeac43ac | shared/forge-procedures.json |
| scripts/forge-prefs-schema.test.js | 1930e1a126a2238531af411e8bd85d8c9985379be58d316c4ff0b01834ba8121 | shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-procedure-callers.test.js | 720c1673f816e91671a8cf11633e90b2404a03399eed36be927a0d2b2e1f783e | shared/forge-procedure-recovery.md, shared/forge-procedures.json, shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-procedure-integration.test.js | e12afc52d484a6e5dc4de0d0f57298c2ec6f543af3b042deed6449d9cf617d4d | shared/forge-procedures.json |
| scripts/forge-projection-provenance.test.js | ad978723544d8f364baafd9a7eb658c79290c4421eb6e9df5abd7030d48a3dd2 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-projection-self.test.js | 7d5399f29e462f07e4cfb9c3f4be1421a91490d79123e8320a75bb5b6411f473 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-prompt.test.js | aadcc13767f314553e30d2365ccfe81d1c05b646c66f3f0bdf5564d3a333c225 | shared/forge-procedures.json, shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-readback.test.js | a0c105fbade83be74ef76d59d120aa4d2e8aa14fdd624d9d714504c956ce2c0e | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-recovery-transition.test.js | 90368822868a73ffc8905f10cfa1a50cd711e0388d05da5590aa0623c16a9846 | shared/forge-procedures.json |
| scripts/forge-recovery-workflow.test.js | a9595a490c2022d17046da31bc4381bd22cb54d1c2b65ff3140c8d4fe25609a3 | shared/forge-procedures.json, shared/forge-dispatch.md, shared/forge-bidirectional-sidecar.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-review-diff.test.js | b92d5160f7907910e960f157fcad8c89eae6a529be394f599e8cccd03291173d | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-review-effort.test.js | 45bd41a2cdeec4231714743ff28ebcb59c90fb37c40599a29cebe3169ad837bf | shared/forge-procedures.json |
| scripts/forge-review-fix.test.js | 92d04134eff4824990ad8be0d4ef8383bc8b9e7ca3bdda5aeced774acb59ea82 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-review-policy-distribution.test.js | 41cff40a9a63cb8f752cd80068ab69612b3560e6254014b83792faacab1eaf4c | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md, CHANGELOG.md |
| scripts/forge-runs.test.js | 5031d4afb6e3010ba56896c850f2f726dd620a003681b6bec90cfc370049bd98 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-scripts-callsites.test.js | a0af092026d34e78962c8fbe6cb2576a585380226d336b3f5d54287da3b333e4 | shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-sidecar-diagnostic.test.js | 7157755b8387314a260c3d70b2845f04f53758c855787e77cfeb027a809a6fe5 | shared/forge-procedures.json |
| scripts/forge-sidecar-identity.test.js | 56c1cb54a4fe1ac2b1002a52a00202cc7f8548ea6b547229f29ac1132b4c23e6 | shared/forge-bidirectional-sidecar.md |
| scripts/forge-skill-invocation.test.js | 9a53335f6c0d3a90c0255ef91d0da92533d5c713f6e9da9e6ce9b9d653a06347 | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-slice-git-guard.test.js | e376878093098514f3d2867dfff870724ba4d9b32155c1586d1421ebefdb6198 | shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-source-manifest.test.js | 1a07b5516dbc48d6398c624a965e31909271b4cee59be1b160a57583e5ac062b | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-standalone-deferred.test.js | b0c9244e20b92c77e08f897de4f565caa3d5d367e9fba0d8d7d6fa11da92cfbb | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-sweep-memory-contract.test.js | e2fc320c571e2da95c809ab5e5fe096ed91d6eab3649b2649f3974ddb6578e5f | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-task-execution.test.js | ec5a290a525a8ad8fbb478a8f6f5c4eae5b93cc63a924176a4cc12b4e0fb35a7 | shared/forge-procedures.json, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-task-multiroot.test.js | 580fe59be1cb62f6ff8c621b59be3ec9a5638e4cf6c2b40d5a4ab75fb2a7b290 | shared/forge-procedures.json |
| scripts/forge-task-preparation-installed.test.js | 2d05fd3857338719ad1dd5d77166e200d7828260c4b379f7b48db4bb7c07f69b | shared/forge-procedures.json, shared/forge-bidirectional-sidecar.md, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |
| scripts/forge-task-preparation.test.js | 280044bfd3131002a8051bd726d288fd46001106cc673a4329c75f873651466c | shared/forge-procedures.json |
| scripts/forge-tokens.test.js | 5c20bf65ff6ccf7132bf03bf1380b424c3d113dd09bee11cc7fb8d24adc4325a | shared/forge-dispatch.md |
| scripts/forge-unit-sidecar.test.js | 76c06a37e4f920fb65d9e6dc98a6a76b4b63af86159c28e57b9ca3bd71c86919 | shared/forge-procedures.json |
| scripts/forge-verifier.test.js | 06ccd60cd1195dc0f6853dd7b03565b21d03af94abf8d753a07e0f7ae2424764 | shared/forge-procedures.json |
| scripts/forge-verify.test.js | 3c8e8ee578fff901a263f68e9a56d49ba106c34d265a2818c1d61d32672f4e03 | shared/forge-procedures.json |
| scripts/forge-xllm-review-cli.test.js | 954d9c3407888afa80fed73640ed2e5cd5d7ae3cc1ca2151cf566d79a8102e00 | shared/forge-procedures.json |
| scripts/forge-xllm.test.js | c5077673dff51ae50868a610fa8c44e3606d2145424efe70f57693d73e90b15f | shared/forge-procedures.json |
| scripts/run-tests-changed.test.js | e40d2ba38152a7df01904904963d38c14ebe35b8da9811a064e5ef53413524fe | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md |

### Consumidores indiretos

- scripts/forge-ci-latency-distribution.test.js
- scripts/forge-claude-renderer.test.js
- scripts/forge-codex-renderer.test.js
- scripts/forge-incomplete-resume-distribution.test.js
- scripts/forge-issue-399-distribution.test.js
- scripts/forge-issue-401-distribution.test.js
- scripts/forge-issue-407-distribution.test.js
- scripts/forge-issue-414-distribution.test.js
- scripts/forge-issue-416-distribution.test.js
- scripts/forge-issue-418-distribution.test.js
- scripts/forge-issue-439-distribution.test.js
- scripts/forge-issue-campaign-distribution.test.js
- scripts/forge-issues-403-404-distribution.test.js
- scripts/forge-issues-405-406-distribution.test.js
- scripts/forge-issues-410-413-distribution.test.js
- scripts/forge-issues-420-424-distribution.test.js
- scripts/forge-issues-429-432-distribution.test.js
- scripts/forge-issues-434-436-distribution.test.js
- scripts/forge-memory-evidence-distribution.test.js
- scripts/forge-native-prompt-file.test.js
- scripts/forge-prompt.test.js
- scripts/forge-review-policy-distribution.test.js

### Dezoito vermelhos anteriores: evidência individual

Fonte t04-baseline-code-before.json, SHA256473427efcfe5ae33577680629df1ce53016a523b522c3e245ff389bb62990a3b.
Cada linha é uma observação anterior; o mesmo exit1 futuro não basta para equivalência.
O primeiro erro pode mascarar checks mais profundos; S03 deve executar todos após normalizar.

| Suíte | Status anterior | Diagnóstico sanitizado anterior | SHA256 stdout/stderr | SHA256 fonte |
|---|---|---|---|---|
| forge-ci-latency-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 2c0bae495760c36da8e1778f8280b374ebfbd597652b2996699834749e117859 |
| forge-claude-renderer.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | 474e816338254dbf2e416c3615fca770d7cf9d02e19acc4e0801cb47709e3fac | ca5063fd7bb3fa7adf41b83b7c0b96e2d336e314d518df5fb7e5544feffb2c10 |
| forge-communication-surfaces.test.js | 1 | diagnóstico no envelope original | 316cfaa37548aa6e53ddb11efa4ee309a25507b1f8b3c9fb976018d60efe80c1 | 58dc074fb1829cb722c770a42549cd3ab2c3669a3e8f39d11b65d453f54ed048 |
| forge-incomplete-resume-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 36b3be817ed0b913bc75332582517951dc946012aaa84869979cacd45f5ef0fe |
| forge-issue-399-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | ad6c4a9bd406237403c75590c263220be9da950ea77d461ecdd027a3bfc13cf7 |
| forge-issue-401-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 8356d05420c8a9cd8ff971bf299900d8fa06b2e75e1bd37da0c2e3bce727d1ad |
| forge-issue-407-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 72464948fbba6605c08d4e78ff48c6b8df1600e3b99768af88be446f0c27c6ee |
| forge-issue-414-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 4a1f9cfcb65152d4ada3b0e66bbfbdb915fdae4ef320910cbc916ca98cf6db28 |
| forge-issue-416-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 8293528b9583257b6957ef183e51784f5579b70566bb9ca62da68bdbe18d4152 |
| forge-issue-418-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 382d367547fab736617fd38c8944092bdcadbae3a22bbf963c2bc2a8f291db5d |
| forge-issue-439-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 1fc1e56dfa7e8171835ea8911b5688ab9145ee0159b8d70502cc36fcc24c2e6b |
| forge-issue-campaign-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 4a238b93d44736a0ad7b530cc1a17538876e68133416a853bb79415bf31403d5 |
| forge-issues-403-404-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | a8b566dcdb0932c6c9de1b1b592583efac5b2d767952352cfe688472fbec9da6 |
| forge-issues-405-406-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 4a27de6e0d7e95e930d33bff13b5a723c7afb8bedac7c8991292f4f9b63d7536 |
| forge-issues-410-413-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | dd4544762bead71cf300dadc1d3a4f82f6f654705cfdb0010cd0c7ee171be07d |
| forge-issues-420-424-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 499b5620916ae96c1157433d0126f2c1597479d2e63883465bae14c6c3629d6d |
| forge-issues-429-432-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 615a3b3a94c8ec1a6f8719bbfd81495dace78176544dc676c407746e8b92a790 |
| forge-issues-434-436-distribution.test.js | 1 | AssertionError [ERR_ASSERTION]: campaign measured rendered source skills/forge-task/SKILL.md | b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1 | 9fed00e57a998783cfc6c733e0b56567a24ed3260cae26014aa5bb0a593ab140 |

## Limites de entrega e pendências

As fixtures são mock/sintéticas. Recorded exige proveniência real e sanitização;
real exige execução genuína. Nenhum desses rótulos é promovido pelo relatório.
T05: native-execution teve passe agregado real e cleanup comprovado; retenção10KB
perdeu167 de198 labels, com31 retidos. Comparação multiset completa não ocorreu;
a falha histórica do comparador permanece. CI final deve capturar todos198 com
reason_code/tool_calls/phase e comparar a baseline, sem repetir localmente agora.
T03: flags consultivas de artefatos e limite do enquadramento da pesquisa continuam
obrigações explícitas de revisão, sem transformar heurística em prova comportamental.
Prova genuína Windows host Claude/worker Codex e revisão independente integral S02
continuam pendentes. Testes offline em owners temporários não provam E2E genuíno.
CI final, merge, release, instalação e UAT humano permanecem pendentes e independentes.
Não há alegação de sandbox do SO, prevenção contra controle do host ou aceite humano.
