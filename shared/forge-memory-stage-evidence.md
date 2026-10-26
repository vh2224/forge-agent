# Contrato de evidência por etapa da memória v1

## Propósito e escopo

Este documento define um suplemento documental para atribuir a disponibilidade
de fatos de memória ao longo de um fluxo observado. Explica onde a evidência
foi observada; não demonstra que recuperação, publicação ou uso da memória é
eficaz. Não acrescenta seletor, regra de ranking, pontuação ou mudança de
política.

O suplemento é um objeto irmão de um relatório de avaliação empírica. Não é
uma nova dimensão em `cases[].dimensions` e não altera as quatorze dimensões
fechadas exportadas por `forge-empirical-evaluation.js`. O objeto identifica
`version: 1` e `kind: memory-stage-evidence`, e vincula `case_id`, `delivery_id`,
`family_id`, versão do relatório, split, tipo de evidência, controles e hashes
SHA-256 do input e do relatório empírico. Esses identificadores devem
corresponder aos documentos de origem protegidos por hash.

## Modelo de etapas e observações

As etapas têm ordem fixa: `origin`, `extraction`, `publication`, `selection`,
`package`. Cada etapa registra separadamente a disponibilidade planejada e a
observada. A disponibilidade observada é `observed` ou `unavailable`; ela
indica se a etapa pôde ser inspecionada, não se o fato esperado estava presente.

Cada observação de fato é `present`, `absent`, `unknown` ou `conflict` e contém
uma referência à observação que a sustenta. `unknown` indica evidência
insuficiente. `conflict` indica que evidências ou identidades incompatíveis
impedem uma junção defensável. Nenhum dos dois valores pode ser convertido em
sucesso ou perda.

A resposta esperada tem referência e adjudicação próprias, independentes da
presença nas etapas. Declarações de planejamento, observações efetivas e
adjudicações da resposta ocupam campos separados. Um registro de expectativas
pré-execução inclui os fatos esperados, o local da verdade de referência, a
versão da rubrica, o hash das expectativas e a disponibilidade planejada. O
hash prova estabilidade dos bytes dentro do registro de execução; não prova
que a declaração ocorreu antes. Para casos históricos sem declaração prévia,
registre a limitação retrospectiva e não fabrique pré-registro.

## Identidade e junções

`fact_id` é estável somente dentro da identidade completa do caso. Junções de
publicação usam `(milestone_id, unit_id, mem_id)`, composto de `sourceContext`
da publicação e dos campos correspondentes `unit_id`, `milestone_id` e
`mem_id` em `selected[]`. `publishExtraction.mappings` devolve identificadores
MEM sem namespace e, por si só, não basta como chave de junção.

A identidade do diagnóstico S05 é `unitId/MEM` e não inclui milestone. Una o
diagnóstico a um fato somente quando a identidade completa for inequívoca. Uma
colisão de unit/MEM entre milestones é `conflict`. Identidade nula, candidato
omitido ou candidato além do limite de 64 linhas do diagnóstico mantém a
atribuição `unknown`. Um identificador MEM vincula identidade de publicação;
não prova equivalência semântica. Texto substituído sob o mesmo ID não
satisfaz um fato esperado. Paráfrase exige anotação semântica revisada, não
igualdade literal nem presença de palavra-chave.

## Origem e extração

A origem é `present` somente quando uma fonte autorizada comprova diretamente
a verdade de referência. Origem ausente não é perda posterior na seleção.
Evidência de origem ausente ou inacessível é indisponível/desconhecida, não
ausência observada.

A extração registra se o material extraído sustenta o fato esperado, com
referência de origem protegida por hash e adjudicação. Extração sintética
fornecida pode exercitar a mecânica, mas não comprova inferência de modelo nem
um evento de extração real. Mantenha distintas mudança de bytes, fonte
inválida, ausência observada e falta de observação.

## Observação da publicação

O retorno de `publishExtraction` tem estados como `written`, `noop`,
`quarantined` e `conflict`; esse retorno, sozinho, não comprova conteúdo
publicado e selecionável. Publicação `present` exige releitura do namespace:
um estado não nulo contendo o identificador MEM, ou `memory.readFragment` para
esse namespace. Estado nulo é indisponível. Fragmento ausente ou estado
reconsultado sem o MEM é ausência observada.

`noop/replay` conta como já publicado somente quando a releitura confirma
namespace e MEM. `noop/empty` e `noop/result-*` não publicam o fato esperado.
`quarantined` e `conflict` não são publicação selecionável. A avaliação nunca
emite resultados de exposição, confirmação ou utilidade.

## Observação da seleção

A presença é observável somente no caminho canônico de seleção
(`source.provider: canonical`), após consulta real com estado `selected`,
`empty` ou `partial` e motivo correspondente `canonical-match`, `no-match` ou
`budget-exhausted-or-no-match`. Omissão em `selected[]` canônico comprova
somente não inclusão; não identifica o motivo da omissão.

A seleção é indisponível, nunca retenção ou perda, em caminhos direct/override
(inclusive `selected: []` mesmo quando há markdown), nos estados `disabled` e
`optional-error`, e em `empty` com motivo `no-query`, `insufficient-budget` ou
`store-missing`. Em observação `partial`, fatos incluídos são observados e os
omitidos continuam desconhecidos. Use os significados de disponibilidade e
limites de motivos de [forge-memory-diagnostic.md](forge-memory-diagnostic.md);
não reinterprete o diagnóstico como adjudicação semântica.

## Pacote entregue e resposta

`captureFinal` e `measure` registram bytes e SHA-256, não presença semântica.
Presença no pacote exige adjudicação do texto final efetivamente entregue após
o enquadramento, vinculada ao SHA-256 desse texto. O hash do texto adjudicado
deve ser igual a `context.sha256` da captura final. Hash de telemetria sozinho,
presença em `selected[]` ou identificador `[MEM]` no texto não comprova
presença semântica. Observação `context-text-truncated` sem adjudicação deixa
o estado do pacote como desconhecido. Um bundle intermediário não é o pacote
entregue.

Avalie a resposta esperada separadamente, usando sua própria referência.
Presença no pacote não implica que a resposta foi lida, entendida ou usada
corretamente. Nem a inclusão da resposta nem qualquer observação de etapa mede
exposição, confirmação ou utilidade.

## Denominadores e primeira perda

Em cada fronteira, o denominador contém somente fatos comprovadamente
presentes na etapa imediatamente anterior. Classifique retenção ou perda
somente se a etapa seguinte tiver observação válida. Informe separadamente
contagens desconhecidas e cobertura. Denominador zero produz taxa nula, nunca
sucesso. Fato ausente na origem não é perda de seleção. Fato não publicado, ou
cuja publicação não foi observada, nunca entra no denominador da seleção.

A primeira perda verificável só pode ser informada quando todas as fronteiras
anteriores tiverem observação suficiente. Lacunas anteriores impedem afirmar
uma primeira perda global, mesmo que uma fronteira posterior seja observável.
Extração e publicação podem receber atribuição conjunta quando a evidência não
as distingue; não escolha uma causa arbitrariamente. Mantenha achados locais
de cada fronteira separados da atribuição causal global.

## Limites, orçamento e reprodutibilidade

`LIMITS` do avaliador empírico é a fonte dos limites de 1 MiB por input/fonte,
8 MiB cumulativos e 100 casos (`file_bytes`, `total_bytes`, `cases`). Os limites
separados do diagnóstico são 32768 bytes, 64 candidatos, quatro motivos e
240 caracteres de identidade. Este suplemento acrescenta o máximo de 64 fatos
por caso e teto de 1 MiB para a saída compacta.

Use um único teto cumulativo de leitura de 8 MiB para o input principal
protegido por hash, as fontes do avaliador contabilizadas previamente e as
fontes do suplemento. O orçamento interno do avaliador é uma guarda de
subconjunto, não uma cota adicional. Exceder qualquer limite falha
explicitamente; não trunque silenciosamente casos ou fatos selecionados. O
conteúdo estável do relatório não contém valor de relógio. Hashes vinculam
bytes, mas não comprovam autenticidade, cronologia, consentimento ou significado.

## Dados reservados, privacidade e política

Input elegível é distinto da verdade e do resultado reservados. Fatos
esperados, rubrica, rótulos do avaliador e adjudicações não podem entrar em
agent view, `manifest.entries`/`nodes`, `trusted.prework`, `memoryQuery`,
seleção, `renderPrompt` ou prompts de preparação, nem podem determinar a
escolha dos inputs elegíveis. Mantenha texto privado em armazenamento
autorizado. A saída publicada contém somente IDs opacos, hashes, contagens,
enums fechados, referências sanitizadas e limitações. Uma sentinela demonstra
somente a ausência específica testada; não garante isolamento do host. Hashes
não autenticam origem, tempo, consentimento ou significado.

Preserve `apply_policy: false`, `comparative_ready: false` e
`functional_gain: null`. Mantenha fechadas as quatorze dimensões empíricas,
uma família real, e relate separadamente os estratos sintético, histórico e
real elegível. Não infira uma segunda família ou potência estatística a partir
de tasks, slices ou versões. Achados pendentes S03/S04 continuam pendentes e
devem ser identificados por artefato e ID do achado; IDs de mesmo nome em
outros relatórios não são intercambiáveis.

## Reuso e limites da evidência

Reutilize o avaliador empírico e o diagnóstico S05 conforme suas interfaces e
limites documentados. Operações de coleta/freeze que escrevem ficam restritas
a temporários de teste ou fluxos controlados pelo owner. `buildAgentView` não
detecta sozinho conteúdo do avaliador. Não lhe passe dados reservados nem
altere o split para fazer um teste passar. O suplemento observa um fluxo; não
ativa nem calibra a sombra S06.

Revisão documental é necessária para estabelecer que os requisitos deste
contrato estão cobertos semanticamente. Correspondências lexicais, contagem
de linhas, verificações de sintaxe e validação estrutural não provam o
significado destas cláusulas. Vincule cada critério revisado ao SHA-256 exato
deste documento e a trechos ou seções concretos. Mantenha implementação local,
CI hospedado, revisão independente, merge, instalação, liberação e aceite
humano como fatos separados, cada qual com referência própria; não infira um
fato a partir de outro.

## Contratos relacionados e ambiguidade histórica

Este suplemento complementa [forge-empirical-evaluation.md](forge-empirical-evaluation.md):
o avaliador define identidades, controles, estratos, dimensões e limites de
leitura das fontes. Os limites de 1 MiB por fonte, 8 MiB cumulativos e 100 casos
citados acima pertencem a `forge-empirical-evaluation.LIMITS`; não são limites
do diagnóstico S05.

Também complementa [forge-memory-evidence.md](forge-memory-evidence.md), que
define identidade de publicação, compatibilidade legada e separação entre
exposição, confirmação independente e utilidade. Registros históricos `hit` e
`confirm`, assim como `seed.hits`, são classificados como
`legacy_ambiguous`. Seus valores podem permanecer nas projeções numéricas
legadas, mas não são evidência de confirmação independente nem de utilidade.
Uma confirmação v2 exige vínculo independente verificado pelo owner; um
identificador de pacote ou a repetição de um hit histórico não satisfaz esse
vínculo. Nunca reclassifique esses registros ao atribuir uma etapa do fluxo.
