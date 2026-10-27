# Contrato v1 de impacto de release

Este contrato define evidência revisável de impacto sobre contratos públicos do Forge.
`IMPACT_VERSION = 1` identifica o formato da avaliação, não uma segunda versão do produto.
T02 implementa a avaliação pura; T03 integra o helper existente; T04 alinha as notas; T05 classifica exemplos.
O documento especifica comportamento a implementar em S08; sua presença não prova implementação nem aceite.
A única aritmética de versão continua em `scripts/forge-release-version.js`.
`bumpFor`, `nextTag`, `resolveFromFacts` e `resolveVersion` preservam a resolução pelos rótulos.
`checkDeclaredVersion` verifica a versão declarada e a coerência do impacto, sem calcular um bump alternativo.
Os novos `classifyCommit`, `readCommits`, `collectNotesCommits` e `renderChangelog` pertencem ao mesmo helper.
O módulo puro `scripts/forge-release-impact.js`, previsto para T02, interpreta declarações e não importa esse helper.

## Superfícies e consumidores

Uma superfície é pública quando há produtor e consumidor que dependem do seu contrato observável.
O inventário abaixo nomeia caminhos existentes no CODE_DIR; os caminhos são âncoras, não prova de compatibilidade.
Consumidores externos não demonstráveis são **desconhecidos**, nunca presumidos ausentes.

| Surface | Contrato e produtores | Consumidores locais existentes |
| --- | --- | --- |
| `cli` | Flags, argv, saídas e exit codes de `scripts/forge-release-version.js` e demais forge-*.js; comandos em `commands/forge.md` | `.github/workflows/ci.yml`, `.github/workflows/release.yml` e `scripts/forge-release-workflow.test.js` dependem dessas interfaces |
| `schema` | Shapes e campos aceitos em `shared/schemas/unit-artifacts.schema.json`, `shared/schemas/memory-extraction.schema.json` e `shared/schemas/memory-extraction-v2.schema.json` | `scripts/forge-worker-result-contract.js`, `scripts/forge-unit-sidecar.js` e `scripts/forge-memory-evidence.js` |
| `prefs` | Resolução e validação de preferências em `scripts/forge-prefs.js` e `forge-prefs.schema.json` | `scripts/forge-dispatch-resolve.js` e `scripts/forge-prompt.js` |
| `worker` | Formato validado por `scripts/forge-worker-result-contract.js`, incluindo o marcador `GSD-WORKER-RESULT` | `scripts/forge-unit-sidecar.js` publica os resultados e aplica o contrato |
| `receipt` | Recibos de publicação em `scripts/forge-release-publish.js` e recibos de unidade em `scripts/forge-unit-sidecar.js` | O próprio `scripts/forge-release-publish.js` relê o receipt em loadState/apply; `scripts/forge-unit-sidecar.js` consome recibos na continuidade |
| `migration` | Estado e checkpoints em `scripts/forge-state.js` e `scripts/forge-context-boundary.js` | Os leitores de estado em `scripts/forge-state.js` e de continuidade em `scripts/forge-context-boundary.js` precisam retomar dados antigos |
| `procedure` | Instruções em `shared/templates/dispatch/execute-task.md`, módulos em `shared/forge-procedures.json` e composição por `scripts/forge-prompt.js` | `scripts/forge-procedure-context.js` carrega módulos; `scripts/forge-prompt.js` compõe o pedido distribuído |

Uma mudança pode atingir várias superfícies e precisa de uma declaração por impacto relevante.
A flag nova `--notes` é `cli`: acrescenta uma saída em arquivo ao helper já invocado pelo workflow.
O formato das notas de release também é `cli`, como saída observável consumida por publicação e pessoas.
Seu vínculo persistente `notes_sha256` pertence à superfície `receipt` de `scripts/forge-release-publish.js`.
Não se deduz mudança de receipt apenas porque o texto das notas mudou: o shape e a validação são examinados separadamente.
Leitores externos de notas, automações instaladas e hosts fora deste checkout permanecem desconhecidos.

## Tipos e baseline

Os conjuntos fechados são SURFACES = `cli`, `schema`, `prefs`, `worker`, `receipt`, `migration`, `procedure`.
KINDS contém exatamente os seis tipos da tabela; KIND_BUMP fixa sua correspondência.

| Kind | Bump exigido | Exemplo concreto |
| --- | --- | --- |
| `removal` | `major` | Remover uma flag CLI aceita, sem substituição compatível, impede o consumidor antigo de executar seu argv |
| `new-requirement` | `major` | Tornar obrigatório um campo antes opcional de worker ou fechar um schema que passa a recusar um shape antes aceito |
| `meaning-change` | `major` | Reinterpretar o mesmo campo de receipt com outro significado faz uma retomada antiga tomar uma decisão diferente |
| `compatible-addition` | `minor` | Acrescentar um campo opcional que leitores antigos comprovadamente ignoram, ou uma flag opt-in que preserva o argv anterior |
| `compatible-correction` | `patch` | Corrigir uma migração para que a segunda execução seja idempotente, preservando o shape e a retomada de estado antigo já prometidos |
| `internal` | `none` | Reorganizar implementação sem alterar entrada, saída, obrigações ou estado observável por consumidores |

Campo opcional novo só é adição compatível se o leitor antigo o aceitar: um schema fechado pode recusá-lo.
Campo opcional que vira obrigatório é nova exigência mesmo que o nome e a assinatura externa não mudem.
Alterar o formato de worker/receipt sem leitor de transição que retome o shape antigo pode ser remoção ou mudança de significado.
Uma migração que reescreve dados em toda retomada, ou perde um checkpoint antigo, não é compatível por ser chamada migração.
Instrução distribuída que exige um novo gate ou campo do executor é `procedure/new-requirement`, com nível major.
Uma correção dessa instrução que restaura uma obrigação já contratada pode ser patch; é necessário declarar a baseline.
Extensão de arquivo, quantidade de linhas e tamanho do diff não classificam impacto.
Uma única linha de Markdown pode impor obrigação pública; um refactor grande pode ser interno.
A baseline pública é a última tag (`last-tag`); a comparação com uma slice entregue usa `slice-start`.
Cada classificação concreta registra baseline e estado released `true`, `false` ou `unknown`.
Mudança em código ainda não lançado não implica major público apenas por divergir da slice intermediária.
T05 registra essa distinção; S09 refaz a classificação depois da entrega final reparada.

## Gramática do trailer

O formato é `Forge-Impact: <surface>/<kind>; <ref>` em uma linha do corpo completo.
O prefixo é exato, sensível a caixa e começa na coluna 0: `Forge-Impact: `, com um espaço após os dois-pontos.
O assunto, linha de índice 0, é ignorado mesmo que contenha esse formato.
As linhas são separadas por LF ou CRLF (`/\r?\n/`); CR isolado não é outro separador aceito.
O padrão de uma declaração é `/^Forge-Impact: ([a-z]+)\/([a-z-]+); (.+)$/`.
Surface e kind devem pertencer aos conjuntos fechados acima; tokens desconhecidos nunca são descartados silenciosamente.
A ref é obrigatória e tem de 1 a 160 pontos de código, contados por `[...ref].length`.
O comprimento `.length` UTF-16 não substitui essa contagem; 160 caracteres de quatro bytes continuam aceitos.
A ref não pode conter controles U+0000–U+001F nem U+007F (`/[\u0000-\u001f\u007f]/`).
`max_ref_code_points = 160` e `max_declarations_per_commit = 16` são limites fixos.
Há no máximo 16 declarações por commit; a 17ª e seguintes produzem um inválido agregado com a contagem excedente.
Uma linha na coluna 0 que case `/^forge-impact\s*:/i`, sem o prefixo exato, é declaração inválida.
Assim, `forge-impact: cli/removal; x` e `Forge-Impact:cli/removal; x` geram `impact-trailer-malformed`.
Linha indentada por espaço ou tabulação não é declaração; exemplos citados assim podem ficar no corpo sem efeito.
Exemplos listados na coluna 0 de uma mensagem real de commit são declarações reais, inclusive dentro de cercas Markdown.
Mensagem não string produz `impact-message-invalid` sem lançar em `parseImpact`.
Os demais reasons são `impact-surface-unknown`, `impact-kind-unknown`, `impact-ref-missing`, `impact-ref-too-long`, `impact-ref-control`, `impact-trailer-malformed` e `impact-declarations-exceeded`.
Inválidos registram reason e line_index, sem copiar texto bruto; mensagem não string usa line_index null.
Qualquer declaração inválida bloqueia `--check`; ausência de declaração é unknown, nunca prova de compatibilidade.
O trailer é revisável no PR, não é autenticado nem prova semântica automática.
Squash pode reescrever ou perder trailers; a ausência resultante continua unknown.

## Avaliação, status e conflito

O intervalo de impacto é `latest_tag..HEAD`, ou `HEAD` quando não há tag.
required é o máximo das declarações válidas segundo `none < patch < minor < major`.
label_bump aceita exatamente `none`, `patch`, `minor`, `major`.
`tagged` não é label_bump válido: HEAD com tag curto-circuita antes do avaliador normal.
O envelope avaliado contém version, status, required, label_bump, declared_commits, undeclared_commits, invalid_count, conflict_count, diagnostics, diagnostics_omitted e reason.
version corresponde a IMPACT_VERSION; reason é null quando não há motivo especial, ou o code da recusa convertida.
declared_commits conta commits com declarações válidas; undeclared_commits conta commits sem declaração válida.
invalid_count conta declarações inválidas; conflict_count conta declarações válidas acima do nível dos rótulos.
Um commit pode contribuir declaração válida e inválido; os fatos não se anulam.
Sem commits, o resultado é consistent, required none, contagens zero e diagnostics vazio.
Commits sem declaração produzem partial, ainda que required seja none; esse caso nunca é consistent.
A precedência é `invalid > conflict > partial > consistent`.
Quando invalid vence, os conflitos válidos continuam nos diagnósticos e em conflict_count.
A mensagem `impact-invalid` cita a contagem de conflitos, inclusive quando positiva, sem esconder o conflito por causa do status principal.
Com HEAD com tag, o envelope é not-evaluated com reason head-tagged, version 1, required none, label_bump none, contagens zero, diagnostics vazio e diagnostics_omitted zero.
Esse ramo não valida label_bump nem calcula impacto; preserva a precedência da tag existente.
Há conflito exatamente quando rank(required) > rank(label_bump).
O bump dos rótulos não é escalonado; `--check` bloqueia com `impact-label-conflict`.
A ordem dos diagnósticos é impact-invalid, impact-label-conflict, commit-understated, label-exceeds-impact.
`commit-understated` compara o rótulo do commit com sua declaração e é advisory quando o intervalo já cobre o nível.
`label-exceeds-impact` é advisory único quando há declarações e o rótulo do intervalo supera required.
Uma declaração unknown não autoriza reduzir o bump, e rótulo acima do impacto não é erro.
A resolução é lexical por nível: um commit posterior com `BREAKING CHANGE:` cobre major mesmo sem tratar da superfície afetada.
Isso prova coerência de nível, não correção semântica, reparo do contrato ou aceitação humana.
Consequência D2: um `docs:` com compatible-correction exige patch e conflita com label_bump none.
Um `fix:`, `feat:` ou breaking posterior no intervalo cobre esse nível sem alterar o commit anterior.
Um `chore:` com compatible-addition exige minor; um fix posterior ainda é insuficiente, enquanto feat ou breaking cobre.

## Garantias de integração e limites

`resolveVersion` e `resolveFromFacts` nunca lançam por impacto.
Exceções de evaluateImpact viram impact invalid limitado, com reason igual ao code da exceção.
Na fronteira pura, commits não array, classify ausente e label_bump inválido geram `impact-input-invalid`.
O ramo head_tagged é anterior a essa validação; o helper captura as exceções da avaliação normal.
Erros legados `invalid-release-tag`, `version-not-git`, `version-history-incomplete` continuam lançando.
Falhas de leitura de histórico também continuam lançando; não são convertidas em avaliação compatível.
`scripts/forge-version.js` relança tudo exceto version-not-git ao carregar a versão em clone-fonte.
Por isso a garantia de não-lançar por impacto é requisito de runtime, não apenas conveniência do CLI.
`checkDeclaredVersion` avalia primeiro o mismatch e só depois o impacto.
A mensagem legada permanece byte-idêntica: `product VERSION ${declared} does not match ${resolution.skip ? 'latest' : 'next'} release ${expected}; bump scripts/forge-version.js and regenerate its golden/literal consumers`.
Esse erro recebe code `declared-version-mismatch`; a mensagem não ganha prefixo novo.
Erros novos começam pelo code: `impact-label-conflict: …` ou `impact-invalid: …`, com mensagens limitadas.
O stderr continua `forge-release-version: ${error.message}`; erros antigos conservam o formato.
O retorno de sucesso continua exatamente `{ok, declared, expected, skip, bump}`, sem impact.
O impact existe na resolução; o intent sem impact relido por loadState mantém o comportamento anterior.
`max_diagnostics = 64`; diagnostics_omitted registra exatamente quantos diagnósticos foram removidos.
`max_result_bytes = 131072` bytes UTF-8 limita o JSON serializado de impact, não seu comprimento UTF-16.
Diagnósticos são removidos do fim antes de qualquer campo obrigatório; o envelope é medido novamente a cada remoção.
Campo obrigatório e ref nunca são truncados para caber; contagens e reason permanecem explícitos.
Se o envelope obrigatório não couber, `impact-result-too-large` é capturado como impact invalid limitado.
O segundo parâmetro options.limits é seam somente de teste; T03 nunca o passa em produção.
Cada diagnóstico preserva SHA completo válido, com 40 ou 64 dígitos hexadecimais minúsculos; sha7 é só apresentação em mensagens.
SHA ausente ou inválido vira null; não se inventa identidade de commit.

## Leitor limitado de commits

`readCommits` valida range antes de qualquer spawn por `/^(?:v\d+\.\d+\.\d+\^?\.\.HEAD|HEAD)$/` com correspondência integral.
Aceita somente `vX.Y.Z..HEAD`, `vX.Y.Z^..HEAD` ou `HEAD`; inclusive HEAD seguido de LF é recusado, sem trim.
Essa gramática não prova existência da ref; falha de Git permanece falha de leitura.
`git rev-list` lista SHAs com teto max_commits, detectando excesso sem traversal ilimitado.
`git cat-file --batch` lê objetos por enquadramento `<sha> commit <size>`, conteúdo de size bytes e LF separador.
O SHA completo deve ser idêntico ao solicitado, o tipo deve ser commit e o tamanho deve corresponder aos bytes físicos.
Cabeçalho, tamanho, LF, EOF ou registros divergentes são malformados mesmo se o processo termina com exit 0.
NUL e UTF-8 inválido são rejeitados explicitamente; uma mensagem vazia é preservada como registro sem declaração.
Uma string de range vazia, objeto de tipo incorreto e soma acima de max_bytes são recusados.
Um range válido resolvido sem commits retorna []; sua avaliação é consistent, com required none e contagens zero.
maxBuffer é explícito e inclui overhead de todos os registros até max_commits, além do conteúdo permitido.
Spawn usa shell:false e argv fixo, sem argumentos derivados de mensagem; result.error e status são verificados.
A observação independente preservada na pesquisa é que `git log %B` pode sair com 0 e truncar em NUL, enquanto fsck rejeita o objeto.
Logo um log delimitado por NUL não prova que a mensagem completa foi lida; enquadramento por tamanho resolve essa fronteira.
Isso é requisito novo de robustez de uma API exportada, não defeito demonstrado dos rótulos de release atuais.
Não há fsck global nem leitura irrestrita do histórico como substituto dos limites.

## Paridade de versão, notas e barreira

No helper anterior a S08, resolveVersion já lê `%B` completo (linhas 86–88); `subjects` (linha 14) é apenas nome de variável.
A divergência real é o changelog inline dos dois jobs em `.github/workflows/release.yml`, que lê `%H %s`.
Um feat com breaking no corpo já pode gerar major, mas as notas antigas o colocam em Features.
`classifyCommit` passa a ser compartilhado por bumpFor e renderChangelog sobre a mensagem completa.
Preserva a precedência breaking > feat > fix; o regex breaking tem flag i, feat e fix não.
As seções ficam na ordem Breaking Changes, Features, Bug Fixes e Other Changes, omitindo as vazias.
Cada entrada tem formato `- <assunto> (<sha7>)`; assunto é o primeiro parágrafo dobrado em espaços, como `%s` do Git.
As declarações válidas recebem anotação nas notas, sem avaliar texto de commit como shell.
`collectNotesCommits` usa o range da resolução; HEAD com tag pode exigir leitura separada para `<tag>^..HEAD`.
D6 permite fallback somente quando `rev-list --parents` prova que o commit da tag no HEAD é raiz, sem pai.
Outra falha de range gera `changelog-range-unavailable`; nunca se engole qualquer erro para ler todo o histórico.
`--notes` produz o arquivo que prepare lê e vincula por notes_sha256; ausência de valor da flag é erro.
O step Resolve version mantém --check e --github-output, e T04 substitui Generate changelog pela saída do helper.
A barreira exact-SHA continua definida em [forge-release-checks.md](forge-release-checks.md).
Origem master autenticada, candidate SHA, gates locais/remotos, prepare fresco e receipt de apply não são dispensados por notas válidas.
Workflow e helper vêm do mesmo SHA candidato; a lógica de notas deixa o pin de bytes do YAML e passa ao script desse SHA.
T04 atualiza pins e mapeamentos juntos e preserva os bytes históricos pela transformação reversa exata.
`scripts/forge-release-publish.js` consome a resolução completa no prepare e o intent sem impact na retomada.
`ci.yml` roda --check; a Seção 113 de `scripts/forge-smoke.js` usa o histórico real e preserva o controle positivo 9.99.0.
Assinaturas preservadas não provam que esse histórico passa: um conflito real deve bloquear esses consumidores.

## Limitações, cadência e entrega seguinte

O regex conservador de breaking casa prosa como “não há breaking change” em qualquer ponto; agora esse sinal também afeta as notas.
Commits antigos sem declaração permanecem unknown; nem diff nem modelo inferem compatibilidade infalivelmente.
O repositório é seu próprio sujeito: trailers na coluna 0 e texto breaking change em mensagens desta branch alteram o --check real.
Antes da entrega final, o owner deve conferir mensagens do intervalo real; este documento não afirma que essa conferência ocorreu.
SHAs de branch são localizadores históricos observados, sem garantia de alcançabilidade depois de squash.
O objeto pode continuar disponível; isso não transforma o SHA em âncora estável de teste nem prova origem histórica sozinho.
Arquivo e símbolo são âncoras estáveis para triagem, sem demonstrar semântica histórica por presença lexical.
A cadência permite correções pequenas com patch quando compatíveis; não exige acumular mudanças artificialmente.
Não prescreve topologia externa de branches nem cria tag, release ou publicação para validar a lógica.
T05 entrega classificação intermediária de S02–S07 com baseline e released explícitos, incluindo #231/#232/#233.
S09 reclassifica o candidato final depois dos reparos S03/S04 e demais followups pendentes do S08-PLAN.
Esses reparos, o UAT e a eficácia histórica não são declarados concluídos pela matriz intermediária.
Implementação, testes locais, revisão independente, CI hospedado, merge, instalação, publicação e aceite humano são fatos separados.

## Evidência documental exigida

O comando estrutural de T01 valida apenas UTF-8, conteúdo não vazio, pelo menos 120 linhas não vazias e imprime sha256.
Ele não prova consumidores, gramática, compatibilidade, garantias, paridade ou correção semântica.
A revisão manual independente deve ler os bytes exatos e vincular cada critério ao sha256 impresso.
CHECK-DOC-SURFACES cobre inventário; CHECK-DOC-KINDS cobre tipos, exemplos e baseline.
CHECK-DOC-GRAMMAR cobre parsing; CHECK-DOC-STATUS-CONFLICT cobre precedência e resolução lexical.
CHECK-DOC-GUARANTEES cobre não-lançar, mismatch, shape e limites; CHECK-DOC-READER cobre leitura limitada.
CHECK-DOC-PARITY-HANDOFF cobre notas, D6, limitações, cadência e S09; os dois key_links também exigem revisão documental.
A captura documentary inicial/mista de `shared/forge-delivery.md` exige policy selada antes de prepare e revisão independente após o retorno real.
O autor não fabrica identidade, resultado ou evidência do revisor; a revisão permanece pendente até essa captura.
Sincronia lexical de SURFACES, KINDS e LIMITS em T02 é auditoria estrutural, sem substituir essa revisão.
