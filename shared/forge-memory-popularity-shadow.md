# Popularidade limitada em sombra — contrato v1

## Status e escopo

Este contrato especifica `bounded-popularity-v1`, candidato exclusivamente observacional.
Versão da sombra: `1`. A política ativa continua `active-v1`.
O documento precede os testes da S06; o owner deve manter seu commit separado e
ancestral do primeiro commit de testes da slice. A existência deste texto não prova implementação.
Não há ativação, calibração, alteração de pesos, defaults ou preferências.
Não há escrita de persistência, aprendizagem nem emissão de `hit`, `confirm` ou `promote`.
O candidato recebe a mesma fonte, consulta, fase, relógio e elegibilidade do ativo.
Os estágios de orçamento não simulados são declarados abaixo.

## Baseline `active-v1`

A referência é `scripts/forge-projection.js::queryMemoryEntries`:

```text
quality = finiteScore(confidence * Math.max(1, hits))
score = finiteScore(((overlap_count * 100) + (category_weight * 10)) + quality)
comparator(a,b) = b.score !== a.score ? b.score - a.score
                                      : a.identity.localeCompare(b.identity)
```

`category_weight` vem do mapa vivo `preferred`; `overlap_count` conta termos coincidentes.
A qualidade ativa não adota o teto experimental de popularidade. A correção #228
normaliza contadores legados não finitos para 0 antes do ranking e usa `finiteScore`
para saturar overflow aritmético em ±Number.MAX_VALUE, preservando valores finitos.
O caso histórico `0 * Infinity` deixou de ser alcançável por esse produtor; isso
não altera a validação direta da sombra, que continua classificando Infinity como invalid.
A sombra conserva o baseline na ordem realmente recebida em `ranked`, sem repará-lo,
sem reconstruir sua ordenação e sem propagar números não finitos para a saída JSON.

## Candidato `bounded-popularity-v1`

| name | value | source |
|---|---|---|
| FLOOR | 1 | `scripts/forge-projection.js::queryMemoryEntries`, `Math.max(1, hits)` |
| CAP | 3 | `scripts/forge-memory-extraction.js::PROMOTION.legacyHits` |
| CATEGORY_STEP | 10 | `scripts/forge-projection.js::queryMemoryEntries`, pontos de categoria |
| OVERLAP_STEP | 100 | `scripts/forge-projection.js::queryMemoryEntries`, pontos de overlap |
| MAX_CATEGORY_WEIGHT | 3 | mapas `preferred` de `queryMemoryEntries` |

Os nomes de saída correspondentes são `floor_hits`, `cap_hits`, `category_step`,
`overlap_step` e `max_category_weight` em `parameters`.
CAP é julgamento de projeto, não teorema: o legado usa três hits como limiar de reforço.
O teste `cap_hits === PROMOTION.legacyHits` é o tripwire intencional; mudança na
constante exige revisar este contrato. Nenhum coeficiente externo foi copiado.

```text
valid(h) = typeof h === 'number' && Number.isInteger(h) && h >= 0
factor(h) = min(max(h, 1), 3), se valid(h); caso contrário, 1
c' = min(1, max(0, c)), se c é number finito; caso contrário, 0
shadow_quality = c' * factor(h)
shadow_score = ((overlap_count * 100) + (category_weight * 10)) + shadow_quality
```

A associação da soma é exatamente a do ativo: `((o*100)+(cw*10))+q`.
O fator é adimensional e usa `hits_basis: legacy_ranking`, não exposure nem utility.
Sua monotonicidade vale sobre hits válidos, com saturação constante a partir de 3.

## Domínio e inválidos

Inteiros representáveis acima de `Number.MAX_SAFE_INTEGER` também são válidos;
não se exige inteiro seguro para calcular o fator. Normalizar `-0` para `0` positivo.
Status de hits: `valid` para 0..3, `saturated` para valores válidos >3, `invalid` no resto.
Inválidos usam factor 1, sem coerção de tipo e sem aritmética que cresça com hits.

| entrada h (JavaScript) | factor | status | reachable |
|---|---|---|---|
| `0` | 1 | valid | projetor |
| `-0` | 1 | valid | projetor, normalizado a 0 |
| `1` | 1 | valid | projetor |
| `2` | 2 | valid | projetor |
| `3` | 3 | valid | projetor |
| `4` | 3 | saturated | projetor |
| `Number.MAX_SAFE_INTEGER` | 3 | saturated | projetor, dígitos decimais |
| `Number.MAX_SAFE_INTEGER + 2` | 3 | saturated | projetor, valor representável via dígitos |
| `1e308` | 3 | saturated | projetor, cadeia decimal de dígitos |
| `Number.MAX_VALUE` | 3 | saturated | projetor, cadeia decimal finita adequada |
| `-1` | 1 | invalid | projetor |
| `1.5` | 1 | invalid | só unidade, parseInt trunca |
| `NaN` | 1 | invalid | só unidade, parseInt inválido vira 0 |
| `Infinity` | 1 | invalid | só unidade; overflow decimal no projetor vira 0 após #228 |
| `-Infinity` | 1 | invalid | só unidade; overflow decimal negativo no projetor vira 0 após #228 |
| `'5'` | 1 | invalid | só unidade, projetor entrega number |
| `5n` | 1 | invalid | só unidade |
| `null` | 1 | invalid | só unidade |
| `undefined` | 1 | invalid | só unidade |
| `true` | 1 | invalid | só unidade |
| `{}` | 1 | invalid | só unidade |

`parseOrphanMemory` e o seed legado preservam a interpretação decimal de hits
com `parseInt(...,10)` e normalizam resultados não finitos para 0 após #228.
Texto `'1e21'` vira 1, não um valor enorme. Fixtures realistas usam cadeias de
dígitos decimais: `'1' + '0'.repeat(21)` tem 22 dígitos e produz 1e21;
`'9'.repeat(400)` transborda no parse e chega à sombra como 0, status valid.
A partir de 309 dígitos, o overflow depende da magnitude. A sombra não recebe
a proveniência do valor normalizado e não deve inventar um status invalid.
Valores hostis devem entrar pelo órfão; entradas só de unidade não provam alcance real.

Confiança `number` finita é limitada a [0,1]; status `clamped` se a limitação muda
o valor, `valid` caso contrário. `-0` vira `0` positivo sem sair do domínio válido.
Confiança não finita (`NaN`, ±Infinity) ou não-number vira 0, status `invalid`.
Não se coagem strings numéricas. Fora de [0,1] é alcançável no caminho legado
sem timestamp de decaimento; um timestamp válido faz `decayConfidence` aplicar o clamp.
Um timestamp ilegível também devolve a base crua no código atual: equivale à ausência
de timestamp utilizável para esta premissa, não a um decaimento observado.
No órfão, `confidence: 0` vira 0.5 por `parseFloat(...) || 0.5`.
Com timestamp válido e relógio extremo, o decaimento pode chegar a 0 por underflow;
isso é distinto da entrada literal zero no órfão. Com hits normalizados para 0,
a qualidade ativa e a sombra são 0, preservando o score finito e o rank observado.

## Invariante e interação

I1: `0 <= shadow_quality <= 3 < 10 = CATEGORY_STEP` e
`3*10 + 3 < 100 = OVERLAP_STEP`.
Premissas explícitas: `cap_hits < category_step`, pesos vivos não negativos e
maior peso vivo de `preferred <= max_category_weight = 3`.
O runtime verifica o maior peso vivo; exceder 3 causa falha fechada `shadow-failed`.
As relações entre constantes são verificadas nos testes; este contrato não as calibra.
Prova: `0 <= c' <= 1` e `1 <= factor <= 3`, logo `0 <= c'*factor <= 3`;
categoria contribui no máximo 30 e popularidade no máximo 3, total 33 <100.

I2: entre baldes distintos `(overlap_count, category_weight)`, ordem descendente
exatamente lexicográfica, com gap mínimo 7 (=10−3) no domínio do projetor.
Dentro do mesmo balde vale a ordem pela soma em ponto flutuante, não uma
comparação separada de tuplas de qualidade. Empates, inclusive sub-ulp, usam
`identity.localeCompare`; não se promete ordem estrita de q abaixo do ulp da soma.
O tamanho permitido de consulta mantém os pontos de overlap muito abaixo da faixa
em que arredondamento apagaria o gap entre baldes.

I3: a elegibilidade é idêntica: a sombra recebe só o `ranked` já elegível.
`projectMemoryState` descarta pruned antes disso; supersede implica prune.
Não se reintroduzem entradas excluídas nem se faz outra consulta/projeção.

I4: para `h` em `{0,1,2,3}` e confiança number em [0,1], factor coincide com
`Math.max(1,h)` e c' coincide com c (zero normalizado); produto e associação
da soma coincidem. O score é bit a bit igual ao ativo nesse domínio.
Isso não estende a igualdade de ordem para entradas fora desse domínio.

## Integração e opt-in

`queryMemoryEntries({ popularityShadow })` aceita somente `undefined`, `false`, `true`.
Outro valor, inclusive `null`, lança `Invalid memory popularity shadow` no topo,
ao lado da validação de `diagnostic`, antes de `guardReadHere` ou leitura do store.
Essa regra difere de `limit`, que admite null no seletor ativo.
Desligado não adiciona chave; ligado adiciona somente `result.popularity_shadow`.
A integração usa a mesma passagem sobre `ranked`, ordena uma cópia com novas linhas,
não modifica ranked, selected, markdown, limites, truncated, considered ou diagnostic.
Não chama `projectMemoryState` novamente. Qualquer exceção opcional vira
`unavailableShadow('shadow-failed')`, sem afetar o resultado ativo.
`scripts/forge-memory.js::queryRelevant` ignora `popularityShadow` em silêncio:
não o valida nem repassa, assimetria intencional com diagnostic. O prompt não o ativa.

## Formato fechado `popularity_shadow` v1

Nenhuma propriedade além das inventariadas nesta seção é permitida.

| campo | conteúdo |
|---|---|
| `version` | 1 |
| `status` | observed ou unavailable |
| `reason` | null, no-candidates ou shadow-failed |
| `limits` | max_bytes=32768, max_candidates=64, max_identity_chars=240 |
| `parameters` | formula, baseline_formula, floor_hits, cap_hits, category_step, overlap_step, max_category_weight |
| `window_basis` | rank-limit-pre-budget |
| `budget_stage` | unavailable |
| `context_stage` | unavailable |
| `baseline` | formula=active-v1, rank_basis=observed-ranked-order, fingerprint, window_fingerprint |
| `candidate` | formula=bounded-popularity-v1, fingerprint, window_fingerprint |
| `comparison` | order_equal, window_equal |
| `measures` | contagens listadas abaixo |
| `candidates` | lista de linhas fechadas abaixo |
| `total_candidates` | total de elegíveis |
| `omitted_candidates` | total_candidates − candidates.length |
| `truncated` | omissão efetiva de candidatos |
| `emitted_bytes` | bytes UTF-8 de JSON compacto incluindo este campo, por ponto fixo |

`parameters.formula` e `baseline_formula` identificam as duas fórmulas acima.
`measures` contém somente `eligible`, `rank_changes`, `max_abs_rank_delta`,
`window_limit`, `window_overlap`, `entered`, `left`, `saturated_hits`, `invalid_hits`,
`clamped_confidence`, `invalid_confidence`, `baseline_quality_over_category_step`,
`baseline_quality_nonfinite`, `rows_outside_equivalence`.
`baseline_quality_over_category_step` conta apenas qualidade baseline finita >=10.
`baseline_quality_nonfinite` conta qualidade baseline não finita, emitida como null.
`rows_outside_equivalence` conta linhas que não satisfazem o domínio de I4.
Ranks e medidas usam todos os elegíveis; baseline_rank é índice na ordem observada.
`rank_changes` conta posições alteradas e `max_abs_rank_delta` sua maior distância.
`window_overlap`, entered e left comparam somente as janelas `slice(0, limit)`.
Nem orçamento de caracteres do ranking nem estágio de contexto são simulados:
janela por contagem não é pacote entregue, nem prova de contexto igual.

Cada linha, por rank baseline, contém somente `identity` (safeIdentity),
`baseline_rank`, `shadow_rank`, `rank_delta`, `hits` (safeCount), `hits_status`,
`confidence_status`, `baseline_quality`, `shadow_quality` (safeNumber).
`rank_delta = shadow_rank - baseline_rank`; ranks são índices iniciados em zero.
A lista tem no máximo 64 linhas; contagens inseguras e números não finitos viram null.
Hits enormes podem ser saturated com hits null; isso não os torna invalid.
`unavailableShadow` é um retorno constante, sanitizado e livre de exceção, com status
unavailable, reason shadow-failed, lista vazia e observações indisponíveis como null;
não inventa igualdade, ordem ou medidas. Ausência de candidatos usa
status unavailable e reason no-candidates.

## Orçamento de bytes (D6b)

`compareShadow(rows, { limit, maxBytes })` aceita limit inteiro >=1
e maxBytes inteiro em [2048, 32768] (padrão e máximo 32768 = LIMITS.max_bytes).
Valores não-number, fracionários, não finitos ou fora dessas faixas são inválidos.
Invalidar limit ou maxBytes lança RangeError com mensagem fixa sanitizada, sem
valores fornecidos, antes de qualquer cálculo ou acesso a rows. Não há clamp.
Medir primeiro o envelope obrigatório sem candidatos, em UTF-8 compacto e com
`emitted_bytes` estabilizado por ponto fixo; se exceder maxBytes, lançar RangeError
sanitizado antes de devolver resultado. Nunca truncar campos obrigatórios.
Somente candidates[] pode ser cortado do fim, recalculando totais, truncated e bytes.
Nunca entrar em laço removendo de lista vazia. O resultado completo deve caber.
T03 usa o padrão 32768 e converte qualquer exceção em shadow-failed.

A sonda offline do plano mediu envelope literal sem candidatos e quatro
fingerprints de 64 hex: 1304 bytes. Portanto o antigo piso 1024 era inviável;
1024 não é aceito. Outra sonda, com contadores em Number.MAX_SAFE_INTEGER,
unavailable/shadow-failed e booleanos false, mediu 1560 bytes e cabe em 2048.
São evidências de sondas limitadas, não prova universal do schema. A guarda de
envelope é defensiva quando nenhuma entrada permitida a alcança; se houver entrada
permitida que a dispare, testá-la sem fabricar opção fora da faixa.

## Fingerprints e igualdade (D6a)

O digest SHA-256 recebe JSON compacto com chaves nesta ordem fixa:

```text
{ domain: 'forge-memory-popularity-shadow/order', shadow_version: 1,
  formula, scope: 'full'|'window', order: [identidades brutas] }
```

`formula` separa active-v1 de bounded-popularity-v1; scope separa ordem completa
de janela. Identidades brutas únicas entram no digest; a saída usa safeIdentity.
Fingerprints baseline e candidato sempre diferem como identificadores de fórmula
(sob a hipótese usual de ausência de colisão SHA-256), mesmo com ordem igual.
Essa diferença não é eficácia. Digest de identidades não é segredo.
`comparison.order_equal` e `window_equal` comparam as ordens explicitamente.
Garantia de order_equal somente quando `rows_outside_equivalence === 0`.
Fora daí igualdade ainda pode ocorrer, mas não é garantida, mesmo sem saturação.
Contraexemplo no mesmo balde: A(c=2,h=1) tem qualidade ativa 2 → sombra 1;
B(c=0.9,h=2) tem 1.8 → 1.8. A ordem inverte com saturated_hits=0.

## Reprodução controlada

CLI previsto: `scripts/forge-memory-popularity-compare.js`, sem escrita de arquivos.
Validar todos os argumentos e faixas antes de qualquer leitura, inclusive do store:
limit 1..50, max-tokens 2..16000, now-ms inteiro seguro obrigatório,
commit hex de 7..64 caracteres ou ausente (unknown), query-file UTF-8 estrito
de até `scripts/forge-memory-query.js::MAX_QUERY_BYTES` (512*1024 bytes).
Recusar valores que seriam clampados pelo seletor ativo, com exit 2 sanitizado.
Usar a mesma raiz, query, unitType/fase, limit, maxTokens e nowMs em off → on → off;
comparar por deep-equal os resultados ativos após retirar só popularity_shadow.

`source_fingerprint` cobre `.gsd/memory/**` e `.gsd/SCHEMA-VERSION` (bytes ou absent),
antes e depois do trio. Percorrer com lstat, sem seguir links/junctions; ordenar
paths por code units, não locale. Links, ilegíveis ou excesso de teto falham fechados
com exit 2 e erro sanitizado, sem impressão de caminhos.
`state_snapshot` cobre o `persisted_scope: .gsd`, antes e depois; persisted_equal
é true/false, ou null com persisted_reason fechado quando não observável.
null nunca significa sucesso ou igualdade. Teto excedido ou leitura indisponível
não permite afirmar persistência inalterada. Registrar separadamente source_equal.

`invariance: held` dá exit 0 somente com active_equal, source_equal e persisted_equal
todos true; diferença observada dá violated/exit 1; ausência de observação conclusiva
dá unknown/exit 3. Entrada inválida e falha de fonte dão exit 2.
Capturar/suprimir process.stderr.write síncrono durante a projeção e restaurar em
finally; expor somente a contagem projection_warnings, nunca o texto dos avisos.
O relatório inclui query_sha256, fase, limit, max_tokens, now_ms, commit ou unknown,
conditions (node, locale), limitations fechadas, apply_policy false,
efficacy not-evaluated, corpus unspecified, family_count 1 e a comparação separada.
Conditions e limitations devem declarar dependência do mesmo Node/ICU/locale;
localeCompare não promete reprodução entre ambientes.

O owner deve copiar o corpus para uma raiz temporária congelada, preservar sua
origem/fingerprint e executar sobre a cópia. Rodar no OWNER mutável com writers
ativos não é comparação empírica controlada. O owner persiste a evidência externa.

## Privacidade

Não copiar consulta, termos, texto de fato, categoria livre, paths de origem,
mensagens de erro nem stderr textual para popularity_shadow ou relatório.
Categoria é representada apenas por peso numérico. Identidades usam safeIdentity;
strings inválidas viram null. Números e contagens usam sanitização existente.
Hashes não são mecanismo de confidencialidade e não autorizam publicar dados brutos.
Falha da sombra não altera persistência nem resultado ativo.

## Reuso e exclusões

Reutilizar LIMITS, safeIdentity, safeNumber e safeCount exportados por
`scripts/forge-memory-diagnostic.js`; seu contrato e estágios estão em
[forge-memory-diagnostic.md](forge-memory-diagnostic.md), sem alterar o v1 S05.
O helper measure é interno, não exportado: permitir só a cópia local mínima do
ponto fixo (até quatro passagens), sem expandir a API do diagnóstico.
A origem, hits_basis legacy_ranking e ambiguidade legada obedecem a
[forge-memory-evidence.md](forge-memory-evidence.md), contrato S03 sem reinterpretação.
Exposure, reobserve e utility não substituem hits nem provam utilidade do ranking.

Não reutilizar `scripts/forge-context-comparison.js::buildContextComparison`:
seu domínio é pacote entregue sob controles de procedimento, não ordem de ranking;
herdaria os achados abertos R1–R3 do comparador público no adendo de pesquisa S05
de CODING-STANDARDS. Não editar esse comparador nesta slice.

## Limites de evidência e pendências

Ranking não prova qualidade; diferença sintética não é ganho, saturação não é utilidade.
Uma família (family_count 1) não representa amostras independentes.
As 14 dimensões do avaliador permanecem fechadas; suplemento versionado por etapa
pertence à S07. Supersede implica prune; estágios não observados ficam unavailable.
Calibração e ativação permanecem fora desta milestone, com apply_policy false.
Reprodutível somente no mesmo Node/ICU/locale, não entre ambientes.

Continuam pendentes, sem correção nem mascaramento aqui:
`slices/S03/S03-REVIEW.md` R1 (ordenação de timestamps), R2 (binding default),
R3 (identidade de entrega), R4 e R5 (controller); `slices/S04/S04-REVIEW.md`
R1, R2, R3, R4, R5 e R6. Paths relativos à raiz do milestone.
Esse namespace difere de R1–R3 do comparador público do adendo S05 acima.
A correção numérica ativa #228 foi integrada separadamente da sombra; a antiga
reprodução de NaN permanece evidência histórica, não comportamento atual esperado.
Limites históricos cumulativos de 300s/60s foram substituídos por vigilância de
partida, silêncio, atividade e teto de segurança por tier; não os reintroduzir.
Verificação local futura não prova CI hospedado, provider real, instalação,
merge, liberação ou aceite humano. Cada fato requer referência própria.
