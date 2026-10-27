# Diagnóstico de seleção de memória — contrato v1

## Propósito e separação

O diagnóstico explica a seleção existente como metadado opcional e limitado.
Não cria outro seletor, outra leitura da projeção, score ou ordenação.
Não modifica pesos, limites, orçamento ou eventos de memória.
O módulo puro não usa filesystem, processo, relógio, eval ou regex dinâmica.
Recebe dados e devolve uma nova estrutura fechada, sem modificar a entrada.

## Opt-in e superfícies

As APIs de ranking, contexto e bundle aceitam `diagnostic: true`.
O prompt aceita `memoryDiagnostic: true`.
Ausente ou false desliga o diagnóstico e não adiciona chave ao resultado.
Outro valor lança `Invalid memory diagnostic` fora do `try` opcional.
O bundle CLI aceita `--memory-diagnostic on|off`.
O valor on exige `--selection-report`; validar antes de mkdir ou escrita.
O bundle expõe `selection.diagnostic`; prompt usa `onMemorySelection`.
O callback ocorre uma vez, sem introduzir seleção adicional.
O diagnóstico nunca entra em markdown, prompt, `--out` ou `selected`.
Não conta em `estimated_tokens` nem nos bytes do contexto entregue.
Essas integrações pertencem às tarefas posteriores; este contrato não as prova.

## Medição e limites

O tamanho é `Buffer.byteLength(JSON.stringify(diagnostic), 'utf8')` compacto.
`emitted_bytes` faz parte do próprio objeto e é calculado por ponto fixo.
Recalcular após qualquer remoção até o valor embutido igualar os bytes reais.
Quatro iterações bastam para estabilizar a largura decimal neste limite.
O selection-report é pretty-printed, inclui outros campos de selection e não é
o objeto medido. Não há promessa de 32768 bytes para o arquivo completo.

| Limite | Valor |
|---|---|
| max_bytes | 32768 |
| max_candidates | 64 |
| max_reasons | 4 |
| max_identity_chars | 240 |

O diagnóstico tem `version: 1` e copia esses limites em `limits`.
Lista somente as primeiras 64 posições recebidas, na ordem original.
Remove candidatos do fim até caber no limite compacto de bytes.
`total_candidates` é o máximo entre total válido declarado e quantidade recebida.
`omitted_candidates = total_candidates - candidates.length` conta ambas as perdas.
`truncated` preserva true anterior ou indica omissão efetiva de candidatos.
Deduplicação e descarte de razões são normalização, não truncamento.
Só um corte efetivo pelo teto defensivo de razões também seria truncamento;
esse corte é inalcançável com os enums atuais e não autoriza ampliá-los.
Se o envelope sem candidatos excedesse o teto, usar `diagnostic-failed`.

## Enums fechados

Cada linha corresponde exatamente à constante exportada de mesmo nome.

| Constante | Valores em ordem |
|---|---|
| AVAILABILITY | observed, unavailable |
| STAGE_REASONS | not-reached, override-provider, direct-memories, source-failed, store-missing, disabled, no-query, insufficient-budget, diagnostic-failed, reason-unknown |
| PRIMARY_REASONS | included, rank-limit, ranking-budget, context-no-matched-terms, context-invalid-identity, context-limit, context-budget, reason-unknown |
| MODIFIER_REASONS | ranking-text-truncated, context-text-truncated |
| REASONS | included, rank-limit, ranking-budget, context-no-matched-terms, context-invalid-identity, context-limit, context-budget, reason-unknown, ranking-text-truncated, context-text-truncated |
| CATEGORIES | gotcha, convention, architecture, pattern, other |
| ORIGINS | recorded, legacy_unknown, legacy_orphan |

## Forma fechada e disponibilidade

A raiz contém somente version, status, reason, limits, stages, candidates,
total_candidates, omitted_candidates, truncated e emitted_bytes.
`stages` contém source, projection, ranking e context, nessa ordem.
Cada estágio tem availability e reason; observed implica reason null.
Estágio ausente é unavailable/not-reached, com demais campos null.
Razão de estágio desconhecida vira reason-unknown; demais enums inválidos null.
Source contém provider (canonical/override/direct/null), store
(present/missing/unknown/null) e schema_partial (boolean/null).
Projection contém evidence_model_version, pruned_excluded, superseded_excluded,
orphans_shadowed e skipped_fragments.
Ranking contém profile (execution/planning/neutral/null), minimum_overlap,
query_term_count, examined, eligible, below_minimum_overlap, limit e max_tokens.
Context contém limit, max_tokens, content_tokens, header_chars, received,
filtered_no_terms, limit_cut, invalid_identity, budget_cut, text_truncated,
included, unattributed_positions, markdown_bytes e truncated (boolean/null).
Todos esses campos numéricos são contagens inteiras seguras não negativas ou null.
Status global é observed com quatro estágios observados, unavailable com nenhum,
e partial nos demais casos. Não é o status partial da seleção original.
Reason global é a razão do primeiro estágio indisponível, ou null se observed.
`store-missing` significa somente ENOENT ao observar `.gsd/memory`.
`source-failed` cobre qualquer exceção no caminho opcional, inclusive validação
interna e `.gsd/memory` como arquivo; não afirma que o provedor foi chamado.
`not-reached` declara estágio não executado; `diagnostic-failed` falha explicativa.
Ranking direto não observa existência do store: source.store permanece unknown.

## Candidatos e razões

Cada candidato contém rank, identity, category, decision, reasons, tie_break,
evidence_origin, hits_basis e components; não existe campo superseded.
Rank é contagem segura; tie_break é identity/null; hits_basis legacy_ranking/null.
Category inválida vira other; evidence_origin desconhecido vira null.
Components é null ou objeto com overlap_count, overlap_points, category_weight,
category_points, quality, confidence, base_confidence, hits e score.
Overlap_count e hits são contagens; demais componentes são números finitos
arredondados a 4 casas. NaN, Infinity e strings numéricas viram null.
Campos desconhecidos são descartados em todos os níveis.
Preserva-se a primeira primária válida em primeiro lugar; se não houver, usa-se
reason-unknown. Primárias extras e strings desconhecidas são descartadas.
Modificadores distintos seguem a ordem da primeira ocorrência no raw.
Uma primária + até 2 modificadores distintos significa no máximo 3 razões únicas.
`max_reasons: 4` é teto defensivo, não uma quantidade obrigatória de razões.
Decision é included se e somente se a primária for included.
Para posição maior ou igual ao limit, rank-limit precede ranking-budget.
Ranking-budget explica posição abaixo do limit não emitida por orçamento.
Below-minimum-overlap não é razão de candidato: o fato não chegou ao ranking.

## Contagens e vínculo entre estágios

`examined` conta fatos ativos; `eligible` equivale ao considered do seletor.
`below_minimum_overlap = examined - eligible` é contagem de estágio.
Trace coleta no máximo as primeiras 64 posições; totais permanecem exatos.
Associação ranking/contexto usa rank/posição original antes da sanitização,
nunca identidade, que pode virar null. Não reintroduzir posições omitidas.
`unattributed_positions` conta posições do contexto ausentes no trace limitado.
Superseded é subconjunto de pruned: supersede implica prune no reducer.
`superseded_excluded` só aparece como subconjunto de `pruned_excluded` na
projeção canônica; IDs excluídos nunca retornam como candidatos ativos.
Context-budget, context-limit e context-text-truncated são razões defensivas
no canônico: orçamento igual e prefixo de ranking maior evitam esses cortes.
Fixtures com override provider podem exercitá-las sem alterar o canônico.

## Privacidade, isolamento e relógio

Só IDs válidos, contagens, enums e números atravessam a fronteira.
Identity segue memoryIdentifier: até 240 caracteres, regex ASCII
`^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$`, segmento '..' proibido.
`a..b` é válido; a/../b, espaços, drive Windows e paths absolutos não são.
Não há denylist: PRIVATE_QUERY é identidade válida e permanece válida.
Nunca copiar consulta, termos, matched_terms, texto, warning ou erro bruto.
Sentinelas privadas de testes usam espaços e varredura recursiva de strings.
Provider override recebe argumentos e número de chamadas idênticos on/off.
Somente uma cópia da consulta canônica recebe diagnostic; sem mudar o override.
Falha explicativa usa unavailableDiagnostic e preserva a seleção base inteira.
UnavailableDiagnostic independe do binding exportado de boundDiagnostic.
Determinismo só com nowMs fixo; o prompt não passa nowMs e usa relógio corrente.
Igualdade entre APIs exige congelar nowMs/Date.now; CLI compara IDs/ordem/output.
Componentes arredondados não reconstroem o score exatamente: tolerância 1e-4.
Conservar o score arredondado observado, sem recalcular o ranking.

## Semântica e limites de evidência

Reusar [forge-memory-evidence.md](forge-memory-evidence.md) para origin,
hits_basis e ambiguidade legada S03, sem reinterpretar hits como confirmação.
Matching lexical exclui honestamente paráfrase sem termo comum.
Diagnóstico local/observacional não prova melhoria causal ou eficácia universal.
S03 R1–R5 e os seis itens S04, incluindo #214–#216, permanecem abertos.
Não prova hosted CI, instalação pessoal, entrega ao provedor ou aceite humano.
S06 consome componentes das posições visíveis, sem fatos abaixo do mínimo.
S07 consome disponibilidade, trace e unattributed_positions, sem inventar vínculo.
S09 consome limites e invariância; posições omitidas continuam somente contagens.
