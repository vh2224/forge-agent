# Fixtures públicas de evidência por etapa

Todos os casos são sintéticos e públicos.
Nenhum caso representa uma entrega real ou inferência de um modelo.
Nenhuma chamada de rede ou de provider participa da suíte.
As famílias adicionais dos testes de split também são artificiais.
Elas não aumentam o número de famílias reais do estudo.

## Declaração e integridade

`cases.json` contém entradas operacionais e expectativas separadas.
O hash físico é fixado antes da execução do primeiro caso.
O mesmo hash é recalculado depois do scoring.
Isso prova não alteração durante a suíte, não cronologia histórica.
A disponibilidade planejada não substitui a observação efetiva.
Respostas indisponíveis permanecem diferentes de respostas omissas.

## Rubrica semântica fornecida

O fato exige validação do limite antes da gravação.
A paráfrase usa capacidade, escrita e armazenamento temporário.
A contradição permite gravação sem validação do limite.
Esses rótulos são dados de teste, não inferências do algoritmo.
A revisão semântica independente da rubrica e dos bytes permanece pendente.
Um teste verde prova consumo e vínculos, não equivalência linguística validada.
O matcher lexical atual pode excluir a paráfrase por falta de termos comuns.
Essa exclusão é registrada sem alterar pesos, ranking ou matcher.
Com a query `cache limite`, ela ocorre no ranking (`below_minimum_overlap`),
antes do filtro `context-no-matched-terms` mencionado no plano.

## Captura e separação

Fontes elegíveis, grader e agente usam raízes temporárias separadas.
Entradas, dependências e query são definidas sem consultar a rubrica.
A sentinela exclusiva do grader é procurada em todas as saídas do agente.
Essa busca prova uma ausência específica, não isolamento universal do host.
O pacote é o texto final retornado por `renderPrompt`, após o framing.
`captureFinal` é chamado diretamente; não se usa `observeFinal` ou prefs reais.
`measure` e a captura precisam concordar sobre o sha256 dos bytes finais.
A adjudicação do pacote é ligada a esse hash, nunca apenas ao ID selecionado.
O clock fixo controla `Date.now` e ranking; `captured_at` usa `new Date()`.
A projeção estável remove somente `captured_at`; testa-se a lista removida.

## Limites e interpretação

Publicação exige releitura do namespace e do MEM correspondente.
Quarentena usa recusa de membro agrupado, conforme a API pública existente.
O fragmento agrupado é válido para leitura, mas inválido para escrita avulsa.
Não se presume que markdown arbitrariamente malformado provoque quarentena.
Substituição contraditória é injetada apenas nos bytes do store sintético;
o writer público primeiro comprova a recusa `MEMORY_FACT_CONFLICT`.
O mesmo MEM permanece legível, mas não satisfaz o fato e sai da seleção.
No teto diagnóstico, outras identidades podem carregar o mesmo texto;
por isso presença semântica no pacote não prova seleção da identidade alvo.
Direct com markdown não vazio não comprova membership de seleção canônica.
Cortes defensivos são cenários rotulados, não observações de seleção canônica.
Fontes ausentes, alteradas ou acima do limite produzem diagnóstico/unknown.
Invariância compara off/on/off e os bytes persistidos após publicação.
Os builders existentes conservam quatorze dimensões e estratos separados.
Testes locais não estabelecem CI hospedado, merge, instalação ou aceite humano.
Nenhum teste resolve automaticamente findings históricos de S03/S04.
