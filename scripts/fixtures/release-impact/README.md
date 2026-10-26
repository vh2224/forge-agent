# Classificação intermediária de contratos de release

Esta matriz aplica [o contrato de impacto](../../../shared/forge-release-impact.md)
às superfícies observáveis de S02–S07, #231/#232/#233 e à própria S08.
O status de todas as entradas é `intermediate`; S09 deve refazer a classificação
contra o candidato final reparado. A presença desta fixture não encerra findings.

## Proveniência

CODE_DIR é o worktree `.forge-worktrees/M-20261020200139-memoria-explicavel/forge-agent`,
na branch `forge/M-20261020200139-memoria-explicavel`, fora do owner de artefatos.
O código foi observado na revisão `4c0a19890dfe8090adba5607cadee533fca095ae`.
A última tag observada é `v4.45.0`, revisão `5a44919b9631545965e93d004cd7e17b3c6f616c`.
`evidence.observed_sha` identifica um commit observado nessa branch ou em sua história;
`observed_on_branch` não afirma que ele estará disponível depois de squash.
Squash pode retirar a alcançabilidade sem apagar imediatamente um objeto local.
Arquivo e símbolo são âncoras estáveis, mas sua existência não prova origem histórica.

## Baselines e disponibilidade pública

`last-tag` compara o contrato com v4.45.0; `slice-start` compara com o estado
intermediário explicitado em `baseline_reference`, inclusive S07 antes de #232/#233.
`released` descreve a disponibilidade da mudança classificada, não o sucesso de UAT.
`true` requer ancestralidade demonstrada em tag; `false` indica adição posterior
ausente na tag observada; `unknown` mantém ausência de prova explícita.
S02 já está na tag por `323ca6b356333edc72012a1d0d8e45ca5127c995`:
`git merge-base --is-ancestor 323ca6b v4.45.0` retornou 0.
A cópia histórica `1ec6fb9` da branch retornou 1, e não é a prova usada.
O diff de `forge-release-publish.js` contra a tag é vazio; a entrada S02 descreve
sua adição contra o começo da slice, sem alegar uma segunda mudança pública atual.

`26627ec1309b0137f71eeb025bc0f1267bbd8209` (#232/#233) retornou 1 no mesmo
teste de ancestralidade. Os módulos stage-evidence/report não existem em v4.45.0.
Contra a tag, integram uma adição compatível ainda não lançada. Contra S07 entregue,
#232 muda o resultado de hashes divergentes, e #233 passa a recusar shapes antes
aceitos. Essas leituras major de `slice-start` não são um major público lançado.
A classificação resulta da leitura das funções e do diff, nunca do rótulo `fix`.

## Exemplos e limites

`examples[].origin = real` reproduz mensagens observadas: S05/T01 em `227c135...`
e S08/T03 em `a832ffa...`, sem acrescentar trailer a esses commits históricos.
Base v1.2.3 e versão declarada são calibragens sintéticas do harness, não versões
históricas dessas mudanças. `contract_id` liga a mensagem ao contrato classificado.
Exemplos `illustrative` são mensagens hipotéticas; não são commits reais do projeto.
Não se demonstrou um major público real de S02–S07. Remoção major, patch declarado,
conflitos, resolução lexical, declaração inválida, mismatch e D2 usam exemplos
illustrative. Os totais real/illustrative são impressos separadamente pela suíte.

O helper calcula pelo rótulo; trailer acima do nível bloqueia sem elevar o bump.
Um commit posterior com sinal breaking resolve o nível, sem provar reparo semântico.
S08 é classificada minor pela adição de `impact` e `--notes`. A nova recusa depende
do trailer opt-in; commits antigos sem declaração permanecem partial sem bloqueio.
Notas por corpo completo, fallback somente para tag raiz comprovada e rejeição de
objetos malformados/ranges inválidos sustentam correções de robustez. O retorno ok
de checkDeclaredVersion e o intent legado sem impact continuam preservados.
Consumidores externos são `unknown`: um leitor externo fechado pode exigir reavaliação.

## Pendências e revisão

Cada entrada preserva S03-REVIEW R1–R5, S04-REVIEW R1–R6, R1#215/R2#216/R3#214/
R4#217/R5#218/R6#219 (incluindo divergência de R6), #208/#209/#212/#221/#222/
#226/#228/#229/#230, #231 e os followups indexados. Nenhum é declarado resolvido.
A lacuna de #231 permanece: reviewDocumentary aceita array truthy em `c.evidence`,
mas o downstream exige string não vazia. Captura documental inicial/mista não
autoriza o autor a fabricar revisão nem a aproveitar esse descompasso.

CHECK-EXAMPLES-EVIDENCE-ANCHORS prova apenas presença lexical e formato de SHA;
a suíte nunca resolve SHAs históricos por Git. A revisão documental independente
precisa conferir classificação, consumidores, baselines e evidências contra o código,
vinculada aos sha256 do JSON e deste README impressos pelo comando estrutural de T05.
Ela permanece pendente até captura pelo owner após o retorno terminal do writer.
Suíte verde sozinha deixa os critérios mistos parciais; revisão sem suíte também.

Repositórios Git temporários exercitam API e CLI --notes das cópias dos módulos reais.
Tags são criadas somente nesses repositórios descartáveis; nenhuma tag ou release
do projeto, publicação remota, merge, instalação, CI hospedado ou aceite humano foi criado.
S09 reclassifica a entrega final após os reparos, sem promover a matriz a definitiva.
`run-tests --match release` inclui esta suíte; `--changed` somente no helper de versão
não a seleciona por seu nome. Nenhuma eficácia histórica é inferida desses testes locais.
