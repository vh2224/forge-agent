# Retomada de unidades incompletas

Registrar uma run com `forge-runs.add` cria um registro novo. A operação recusa
`ERUNEXISTS` sob os mesmos locks do registro e da run, inclusive para registros
ilegíveis ou links existentes. Uma run existente inativa com binding
legado desconhecido é recusada já por resolve-args com status refuse e razão
owner-resume-binding-unknown, tanto por ID quanto pela seleção pessoal. A mesma
classificação usa o predicado canônico knownResumeBinding do registry, sem migração
ou escrita. Run ativa mantém a classificação existente; inativa com binding conhecido
segue resume. Isso não atesta o dono: a inspeção posterior ainda exige identidade viva.


Um `begin` committed permanece aberto até a transação terminal da sua geração.
ROADMAP marcada, STATE, SUMMARY, inatividade e TTL não o encerram. O avanço serial via
`orchestrate` usa `beginSerial` e recusa `unit-incomplete` antes de replay ou nova lease, com locators
duráveis em `details.incomplete_units`. O `begin` de baixo nível continua permitindo unidades independentes; disputa real da mesma unidade preserva `lease-active`. O replay de uma transação existente mantém
sua identidade; uma pausa parcial só permite a nova entrada explicitamente
vinculada à sua boundary, preservando o plano e a unidade original.

## Host embedding com evidência real

O host mantém sua observação real de join/terminal e a reconciliação de cada raiz.
Ele chama `forge-long-workflow-adapter.invoke(host, 'auto', command, input,
snapshot, dependencies)`; o adaptador não resolve modelos nem cria processos.
As funções em `dependencies` são implementações executáveis do host. Prosa,
`approved:true`, JSON importado e um identificador de sessão não as substituem.

Para um resultado genuíno `partial` ou `blocked`, chame `complete` com o resultado
e o snapshot da seleção. São necessários os callbacks existentes:

- `inspectAttempt({cwd, begin, references})` retorna o pedido e `receipt_path`
  originais, `begin_key`, `begin_checksum` calculado por
  `forge-orchestrate.checksum(begin)`, todas as `roots:[{root_id,path}]` físicas e
  `pending_questions`. A implementação atesta que aquele pedido/receipt pertence
  realmente ao begin observado, além da comparação estrutural de escopo.
- `processProbe(receipt)` retorna `stopped` somente com observação real do
  transporte/processo. Ausência de PID, TTL ou `active:false` não são essa prova.
- `reconcileRoots({cwd,root,context,inspection,begin})` retorna
  `{root_id,process_stopped:true,reconciled:true}` somente depois da reconciliação
  real de cada raiz, incluindo owner e CODE_DIRs.

O controller relê e vincula fingerprint, receipt ready e status original; conserva
as perguntas e seus IDs, o hash do pedido/receipt, as raízes medidas e o claim.
Execution receipts também passam pelo replay de fonte já existente. A pausa usa
a transação canônica, com publicação de resultado/evento/boundary e release da
lease correta. Ela não converte o resultado do worker em `done` ou em falha e não
reescreve seu receipt. O resultado do loop é `needs_input`/`paused`. Conserve o
snapshot retornado e as referências originais no continuation/checkpoint.

Se o snapshot do loop se perdeu, use o locator durável de `unit-incomplete` em
`pause_current:{unit,transaction}` e o resultado original no comando `pause` de
um loop novo da MESMA milestone, com os mesmos callbacks. O locator apenas
localiza: o controller confere proprietário, host, begin checksum e geração.
Sem resultado parcial e evidência reais essa recuperação recusa; não construa um
snapshot fictício nem uma milestone substituta. O CLI JSON sozinho não consegue
fornecer callbacks vivos e retorna a recusa correspondente.

Para retomar, use `resume` com `resume_intent:'execute'` e a boundary/snapshot
retornados. O controller revalida a pausa e a evidência original antes da nova
lease e grava `resumed_pause:{key,checksum,pending_questions}` na transação nova.
Toda pausa parcial, inclusive de planejamento ou conclusão de milestone, volta a
`dispatch_required` por essa retomada de execução na MESMA unidade,
slice e plano, com nova lease; resposta humana não é resultado de execução.
Perguntas pendentes exigem `questionStateAdapter` vivo com respostas explícitas
por ID antes da nova entrada; elas são reatestadas na validação subsequente.
Completar uma retomada exige a entrega capturada genuína: a prova histórica de
task existente ou, para as demais unidades parciais, o receipt atual e os callbacks vinculados
ao novo begin. O resultado parcial antigo nunca é a prova de sucesso novo.

## Reativação e limites

`inspectOwnerResume` fornece o hash do registro. `resumeOwner` conserva a ordem
controller mutex → registry fence → run lock, observação real da sessão e CAS
existentes. Uma reativação do MESMO proprietário conhecido com claim retida exige
os callbacks acima, uma única pausa parcial aberta, pedido/receipt/raízes e claim
exatamente vinculados, nenhum lease/worker/file-lock ou transação pendente e a
atestação `confirmWorkspaceQuiescent` existente. Os checks se repetem dentro do
CAS. A claim permanece intacta e unreleased; não é uma transferência. Outro
proprietário com claim retida e proprietário legado desconhecido continuam
recusados. Atestação do operador não é prova automática de morte do sistema.

Esses campos são aditivos em transações schema 1. Transações antigas sem
`resumed_pause` mantêm o replay existente; criar um novo begin exige primeiro
fechar o anterior. Operações ordinárias de update e transferência de proprietário
mantêm os guards de autoria e quiescência anteriores.

## Histórico com sucessor comprovadamente não despachado

O caminho ordinário `assertNoSuccessor` continua estrito. Se S02 já recebeu um
begin antes de fechar o partial de S01, a operação específica
`controller.reconcilePartialSuccessors(cwd, input, dependencies)` pode publicar
pausas compensatórias `abandon-before-dispatch`. `input` identifica o begin
original por unidade/milestone/owner/host/checksum e fornece o inventário ordenado
EXATO `successors:[{key,checksum}]` de todos os begins posteriores. Não se trata
de apagar eventos, concluir o sucessor ou fabricar receipt de falha.

Além de reinspecionar o partial original, a operação exige que
`inspectOwnerResume` observe o MESMO proprietário conhecido do registro e a claim
atual permaneça idêntica ao pedido original. Para cada sucessor, chama o mesmo
`inspectAttempt` com `references.purpose:'abandon-before-dispatch'`. O host precisa
atestar positivamente `invocation_status:'not-invoked'`, com
`observation_reference` real, o pedido planejado, `begin_key`, `begin_checksum`,
as mesmas raízes físicas e claim. `receipt_path` precisa estar ausente/nulo;
essa ausência sozinha NÃO prova que não houve despacho. `processProbe` e
`reconcileRoots` precisam atestar, respectivamente, a observação real de ausência
de writer e a reconciliação de todas as raízes. Para Claude, forneça também o
`expectedSession` efetivamente observado, como exige a API existente.

Todos os sucessores são validados antes do primeiro efeito. A publicação ocorre
da última entrada para a primeira, sob o mutex existente, usando a transação de
pause, a lease/generation real de cada sucessor e vínculos/hash dos begins e da
observação. Reexecução retoma fases duráveis da mesma compensação, sem refazer ou
reescrever os begins antigos. Depois chame `complete`/`pause` com o partial
original e os mesmos callbacks: somente essa prova compensatória exata permite
fechar S01 e retomá-la pela boundary, sem novo S02/S03. Os callbacks de S02 ainda
são revalidados nesse fechamento; não promova a compensação a um booleano.

Sucessor invocado, proprietário legado/desconhecido/estrangeiro, processo
desconhecido, raiz/claim/pedido divergente, inventário incompleto, terminal
conflitante ou lease ausente sem reconciliação canônica continuam recusados.
Este caminho não recupera automaticamente qualquer histórico legado nem declara
reconciliado um projeto real externo; cada operação precisa de fatos próprios.

## Conclusão aparente e pausas somente de entrada

Ledger de conclusão, seleção sem próxima unidade e snapshot antes marcado como
concluído não encerram uma linhagem parcial. Antes de retornar terminal, o fluxo
consulta as transações incompletas em leitura e retorna `unit-incomplete`, seus
locators duráveis e perguntas pendentes. Sem incompletas, o terminal é preservado.
Pausas de planejamento apenas para entrada, sem `partial_attempt` durável,
conservam o contrato de resposta humana; essa resposta nunca conclui uma execução
parcial nem substitui receipt, reconciliação das raízes ou respostas por ID.

## Owner encerrado com linhagem nativa sem receipt (#375)

reconcilePartialSuccessors continua exigindo o mesmo owner e o receipt parcial
canônico original. resumeOwner continua recusando leases presentes e história
incompleta. Nenhum desses guards é removido para interpretar um relato nativo
como receipt sidecar.

O host pode encerrar essa linhagem como **interrompida e não verificada**, sem
aceitar seus artefatos, por forge-runs.settleInterruptedOwner(cwd, milestoneId,
options). Essa operação administrativa exige:

- snapshot SHA atual do RunRecord conhecido, host/session efetivamente
  observados e inventário ordenado exato do begin original e de todos os
  sucessores; apenas uma linhagem do mesmo owner/host é admitida;
- inspectInterruption vivo, vinculado ao key/checksum de cada begin: original
  invoked-unverified, sucessores positivamente not-invoked, referência da
  observação, inventário explícito de perguntas, raízes físicas completas,
  receipt_path:null e saved_response:'none-observed';
- processProbe retornando o literal stopped a partir da observação atual de
  todas as identidades de processo/Agent relevantes, e reconcileRoots
  comprovando cada raiz atual (root_id, process_stopped, reconciled);
- callback vivo attestOwnerInterruption(challenge) que devolve o SHA canônico
  do challenge, referência da atestação e os fatos previous_owner_stopped:true
  e workspace_quiescent:true. É atestação confiável do operador/host,
  explicitamente rotulada; não é prova automática do sistema operacional nem
  um JSON approved.

O challenge vincula snapshot, ator observado, begins e raízes. A função de hash
é SHA-256 da string JSON com chaves de objetos recursivamente ordenadas (arrays
preservam a ordem), como o checksum canônico do controller. Callbacks devem
observar fatos reais; idade, lease expirada, owner inativo, ausência de receipt
ou texto “partial” não provam esses fatos.

A operação usa as cercas controller → registry → run e as guardas reais de cada
lease. Um handle opaco, válido somente durante essa chamada, permite retirar
apenas os bytes/generation antigos efetivamente observados. O token antigo não
é adotado ou devolvido. Lease estrangeira, geração diferente, processo incerto,
sucessor invocado, metadata desconhecida, inventário incompleto e prova canônica
salva mantêm a recusa antes da primeira publicação. Transferência entre hosts
diferentes permanece explicitamente owner-interruption-cross-host-unsupported.

São acrescentados terminais administrativos failed, com worker_result:unverified,
artifacts_accepted:false e chamada ao provedor unknown. Não se cria receipt de
worker, resultado parcial canônico, SUMMARY, DELIVERY ou completion. Begins,
receipts e fontes antigos ficam preservados, assim como o claim e perguntas
pendentes do run.

O manifesto durável preserva a base observada; as fases são retomadas pela mesma
operação após uma interrupção, com callbacks vivos novamente. O histórico do run
publica ao final um witness independente com os hashes exatos do manifesto e dos
terminais. Sem esse witness, a forma de um terminal não fecha os begins nem
autoriza reentrada. Uma operação incompleta impede novos begins e o resume
ordinário; não apague os registros para liberar o fluxo.

O retorno interrupted-and-transferred permite ao owner atual usar a reentrada
canônica controller.reenter para a **mesma unidade original**, apontando para
interruption.terminals[0] e seu checksum, com token novo, baseline reconciliada
e autorização viva da nova entrada. A nova lease/generation é emitida pelo
controller. O begin sucessor antigo não vira autorização para pular S01.
Perguntas pendentes continuam exigindo respostas explícitas. A interrupção
administrativa e a entrada nova não são delivery: só a entrega real da unidade
nova permite seu fechamento normal.


### Perguntas, retenção e capacidade da interrupção

A falha original e o run preservam a união das perguntas observadas em todos os
targets, inclusive sucessores não invocados. Uma pergunta vista somente em S02
continua impedindo nova lease na reentrada de S01 até resposta explícita.

remove e cleanupStale preservam witnesses de interrupções completas em
.gsd/forge/owner-interruption-witnesses antes de apagar o RunRecord. O arquivo
retém o mesmo vínculo verificável a manifesto, begins, terminais, resultados e
eventos; não cria autorização nova nem entrega. Falha de arquivamento deixa o
run intacto, e uma interrupção ainda pendente impede sua remoção. Raízes/owner
atuais e autorização viva continuam obrigatórios para qualquer reentrada.

A capacidade final do RunRecord é calculada com as perguntas combinadas e o
formato exato do witness antes do primeiro manifesto ou terminal. O limite
existente de64KiB não muda; falta de espaço recusa sem liberar leases nem
publicar efeitos. O commit mantém uma conferência da mesma estrutura reservada.

### Recibo anterior substituído na cadeia (#378)

Há uma exceção opt-in à exigência de original sem receipt: um recibo canônico
`ready/blocked` de um sidecar anterior pode ser preservado como evidência de
uma tentativa substituída, quando a tentativa final da mesma unidade foi um
worker nativo `partial`, sem receipt. Isso não aceita nenhum dos resultados.
O encerramento continua administrativo `failed/unverified`, com
`artifacts_accepted:false`. Sucessores continuam positivamente não invocados e
sem receipt. Recibos atuais, `done`, `partial`, `executed` ou candidatos salvos
continuam exigindo seu caminho de replay original.

No retorno vivo de `inspectInterruption` para o original, o host fornece o
`request` anterior exato, `receipt_path` real, `saved_response:'ready/blocked'`
e `supersession` com:

- `route_evidence:[{path,line,sha256}]`: referências a linhas existentes nos
  eventos globais ou da própria milestone. `line` começa em1; o SHA-256 mede
  os bytes UTF-8 da linha sem o LF final, preservando um eventual CR;
- `final_native_attempt:{id,host_runtime,worker_mode:'native',status:'partial',
  receipt_path:null,observation_reference}`: a identidade observada da tentativa
  final, distinta do dispatch anterior, no mesmo host.

Também é obrigatório o callback **vivo** `attestSupersededAttempt(challenge)`.
Ele precisa conferir a relação real entre begin, request, recibo, avanço de
rota registrado e tentativa nativa final. Retorna `challenge_sha256` pelo hash
canônico do controller, `superseded:true`, `final_native_receiptless:true`,
`final_native_status:'partial'` e uma `reference` estável e não vazia.
Objetos JSON, texto `approved` e o nome de um evento não são essa atestação.
Não há um schema universal comprovado para os eventos históricos de avanço;
o callback do host é responsável por verificar seu significado e sua ordem.

O core confere o caminho canônico, fingerprint, dispatch e identidade do recibo
contra o request e o begin, observa também o processo do sidecar anterior e
exige reconciliação de todas as raízes das tentativas. `processProbe` atende
tanto a inspeção desse receipt quanto a observação atual do alvo nativo.
Perguntas do receipt, de seu resultado e do contexto atual são combinadas sem
dispensa de respostas. Os hashes do recibo e das linhas referenciadas, a
observação nativa e a referência da atestação ficam na safety do manifesto.
Cada retomada e cada fase terminal reconferem a mesma evidência; outro receipt
ou outra observação não substituem a base persistida. Linhas novas de eventos
podem ser acrescentadas sem alterar as linhas históricas referenciadas.

Esta fronteira depende de observações confiáveis do host; não prova por si só
que um worker histórico executou, que chamou o provedor ou que seu parcial foi
verificado. Não fabrique um receipt nativo, apague o recibo anterior ou omita-o
para passar pelo caminho antigo. A recuperação do consumidor real precisa ser
executada pelo seu owner com os callbacks vivos e continua separada dos testes
descartáveis de regressão do Forge.

## Pedido exato retido da tentativa (#382)

Cada nova tentativa de artefatos (`beginArtifactAttempt`, o modo `artifacts` de
`runUnitSidecar` e os dois transportes de preparação de task) grava o pedido
exato em `<resultFile>.request.json` **antes** do receipt `started` e de qualquer
provider. A escrita é exclusiva (`wx`, modo `0600`) com `fsync` do arquivo, no
mesmo diretório privado do resultado, validado fora de todas as raízes físicas.
Os bytes são determinísticos: um órfão idêntico de uma queda anterior é
reaproveitado; um órfão diferente ou truncado nunca é sobrescrito nem usado, e a
tentativa é recusada (`request-retention-conflict`) sem receipt e sem provider.
Campos de credencial no nível superior (`env`, `token`, `api_key`…) recusam a
captura (`request-retention-secret-field`); ambiente, credenciais e resultado bruto
não são copiados. `fsync` melhora a persistência mas não prova durabilidade em
queda de energia em todas as plataformas; ACL do Windows não é afirmada pelo
bit de modo.

O arquivo guarda dados, nunca capacidade:

- `delivery_json`: o preimage exato do fingerprint de artefato (mesma ordem de
  propriedades e posição de `linked_entry_identity`). `delivery_input_json`: o
  pedido serializável original com `resultFile`, sem `ownerBroker`,
  `linkedEntryBinding`, `signal` e demais canais de runtime.
- `preparation_json`: na preparação de task, o preimage exato de
  `preparationRequestFingerprint` (`preparation_input:'captured'`). Uma entrega
  sem esse preimage registra `not-supplied`; nada é inferido.
- `caller_preimage_json`: bytes canônicos separados que reproduzem o hash original
  inclusive para linked; dados serializados não restauram membership/capabilities.
- `caller_request_sha256` com `caller_request_reproducible`: o hash do pedido do
  chamador só é usado quando os bytes retidos o reproduzem sozinhos.
- `runtime_requirements:{linked_entry, owner_broker}`: **restrições** de uso, nunca
  permissão.

O receipt `started` e o `ready`/`failed` subsequente carregam
`retained_request:{file, sha256, delivery_fingerprint, preparation_fingerprint, …}`.
O locator não escolhe arquivo: o leitor deriva o único irmão permitido do
`resultFile` esperado e das raízes físicas, exige arquivo regular com um único
link, sem symlink/junction no alvo, com o mesmo inode observado antes, durante e
depois da leitura, e confere hash, identidade (unidade, workflow, dispatch, owner,
cwd, code roots) e fingerprints. Cada receipt existente com arquivo retido é
reconferido em replay/aceite; legado sem `retained_request` mantém exatamente a
política anterior (pedido externo exato), sem backfill. Cópia nova ausente ou
adulterada recusa (`request-retention-unavailable`/`-hash-mismatch`).

### Como fornecer `context.request` sem o pedido externo

Depois de um reinício, o host cria de novo
`forge-attempt-recovery.createArchivedRequestInspector({ observeOriginalAttempt })`.
`observeOriginalAttempt({cwd, begin, receiptPath})` é uma função executável do
host que devolve o `expected` que ele conhece independentemente para aquele
begin: `resultFile`, `cwd`, `contextRoot`, `unitType`, IDs de milestone/slice/task,
`workflowId`, `dispatchId` e `execution_contract` quando houver. Objetos com
`approved`, `attested`, `ownerBroker`, `linkedEntryBinding` ou
`archived_inspection` são recusados. `inspector.inspect({cwd, begin})` revalida o
begin atual pelo checksum, lê receipt e arquivo, reconstrói o pedido de dados e
devolve `{request, receipt_path, begin_key, begin_checksum, runtime_requirements,
preparation_input, archived_inspection}`. O host acrescenta suas próprias
observações (`roots`, `pending_questions`, `invocation_status`,
`observation_reference`, supersession) dentro de `inspectAttempt` ou
`inspectInterruption`; o arquivo não as fabrica.

`archived_inspection` é um handle opaco de processo (chave de WeakMap). Não é
`linkedEntryBinding`, owner token, broker, claim, rota ou autorização de recuperação,
e sua forma JSON é recusada. `inspectSupersededInterruption`, `inspectSettledAttempt`
e `inspectFailure` só o aceitam depois de `revalidateArchivedInspection`, que relê
begin, receipt e arquivo a cada uso (também após a atestação de supersession). Todas
as demais verificações permanecem: ready/blocked, prova de supersession, processo,
raízes, perguntas e o terminal guard existente, que continua com prioridade.

### Prova histórica × binding vivo

- Pedido não vinculado: identidade e fingerprint são recalculados pelas funções
  atuais a partir dos dados restaurados.
- Pedido linked: a identidade histórica vem apenas do begin committed real e da
  sua cadeia de falha com checksum (`inspectHistoricalLinkedEntry`), nunca do
  `linked_entry_identity` do JSON. Não chama `bindLinkedRequest`, não valida lease e
  não registra entrada em `linkedEntries`; `requestIdentity`/`artifactFingerprint`
  continuam recusando o pedido restaurado com `linked-entry-binding-required`.
  Sem binding vivo a inspeção do receipt mantém `writer_possible` desconhecido.
- `inspectSettledAttempt` registra `request_sha256`. Pelo arquivo ele só existe se
  os bytes retidos reproduzem o hash original; caso contrário a retomada é recusada
  com `request-retention-caller-hash-unavailable` (um hash guardado nunca substitui
  bytes ausentes).

### Limites de replay

- Artefato comum não linked, sem broker: o pedido restaurado pode chamar
  `replayArtifactAttempt`, que publica a resposta salva sem resolver nem provider.
- Linked ainda aberto: somente o host com capacidades atuais chama
  `bindLinkedRequest`; a prova histórica não a substitui. Linked sem lease/owner
  válidos permite inspeção e settlement administrativo, mas o replay continua
  recusado pela API atual.
- Broker: um receipt ready cujo arquivo registra `owner_broker:true` recusa replay
  sem broker vivo (`request-retention-broker-required`); handle falso ou manifest
  importado falham em `assertBroker`, e um broker vivo precisa corresponder ao
  manifest original. `startBroker` cria nova S0 e não é reconexão. Inspeção e
  settlement histórico não iniciam broker.
- Legado sem arquivo: continua exigindo o pedido externo exato pelo caminho
  original; nada é reconstruído nem preenchido retroativamente.


### Preimage histórico do hash do chamador (#382)

O arquivo privado retém `caller_preimage_json` separado de `delivery_input_json`: são os bytes canônicos exatos (sort recursivo original) usados por `callerRequestHash`. O digest recebe essa string diretamente, sem dupla codificação JSON. O leitor confere o hash, a canonicalização, a projeção dos campos de dados e os metadados de runtime; nunca usa esse preimage em `restore()` ou replay. Um `linkedEntryBinding:{}` retido é só a serialização histórica vazia, sem membership no WeakMap. O inspector opaco continua exigindo begin/receipt/arquivo atuais e atestações reais de processo/raízes para settlement. Broker e binding vivos continuam obrigatórios para execução/publicação; funções e chave privada da closure do broker nunca são restauradas. Canais função/undefined seguem omitidos pelo JSON original. Credenciais em canais de runtime são recusadas, sem reinterpretar campos arbitrários de negócio em inputs. Arquivos anteriores sem o novo preimage mantêm sua regra anterior e não recebem backfill.
