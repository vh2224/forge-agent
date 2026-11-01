# Opções de prazo e orçamento de tempo para milestones

Registro da discussão de 30 de outubro de 2026 no projeto Forge Agent. A ideia está preservada para retomada futura. O usuário confirmou a direção conceitual e pediu guardar o enriquecimento da conversa; a implementação está adiada, sem criação de task, milestone, despacho ou alteração do trabalho paralelo.

## Problema e prioridade

O usuário relatou uma milestone em outra sessão com mais de 52 horas de duração. Essa milestone é importante e acrescenta funcionalidades relacionadas às capacidades das versões recentes das LLMs. Há também várias issues já identificadas e criadas para implementação. Esse contexto explica a prioridade de continuar o trabalho atual; o relato de duração não estabelece sozinho um defeito ou sua causa.

Segundo o usuário, tasks melhoraram muito na versão atual do Forge e não apresentam o mesmo problema. A proposta deve começar pelas milestones, preservando o funcionamento das tasks. Não transformar esta discussão em manutenção imediata nem interromper a sessão paralela para implementar a ideia.

## Ideia confirmada pelo usuário

Nas fases iniciais de uma milestone, depois de compreender o escopo e investigar as principais incertezas, o Forge apresenta três opções de prazo total: curta, média e longa. A apresentação ocorre durante a definição das slices, antes de consolidar o roadmap e comprometer a execução.

Os prazos são derivados do trabalho daquela milestone. Não são faixas fixas globais nem apenas três números para a mesma execução. Cada alternativa deve explicar as escolhas concretas que tornam seu objetivo plausível, suas dependências, riscos, entregas e verificações.

Uma divisão preliminar pode alimentar a estimativa; a escolha do usuário orienta a divisão definitiva. A análise deve considerar o trabalho completo necessário à entrega, inclusive preparação restante, execução, integração, testes, revisão e correções. O marco final considerado precisa estar explícito.

O usuário respondeu à proposta detalhada do assistente: “capturou bem a minha ideia é exatamente isso”. Esse aceite confirma a direção conceitual abaixo, sem autorizar iniciar a implementação agora.

## Alternativas de execução

| Alternativa | Explicação exigida |
| --- | --- |
| Curta | Menor prazo viável, com solução simples que satisfaça os requisitos, reaproveitamento e paralelismo apenas onde houver independência real e autorização. |
| Média | Estratégia e margem de integração e correções que justifiquem a diferença em relação à curta. |
| Longa | Abordagem ou margem adicional com benefício e necessidade explícitos, sem inventar trabalho para preencher um prazo maior. |

Cada alternativa apresenta faixa estimada, teto proposto, entregas, escolhas técnicas, dependências e incertezas. A quantidade de slices é consequência do plano, não um multiplicador arbitrário da duração. A estimativa precisa considerar dependências e caminho crítico; paralelismo não torna toda duração aditiva nem elimina integração e revisão.

O escopo solicitado é preservado por padrão. Qualquer mudança de escopo ou adiamento deve aparecer para escolha explícita. Segurança, critérios de aceite, isolamento, routing e verificações e revisão necessárias continuam obrigatórios nas três opções. Uma opção curta inviável deve ser declarada inviável, em vez de receber um número artificial.

## Enriquecimento proposto pelo usuário

A diferença entre uma opção curta e uma média pode ser a separação da parte final da milestone em uma task ligada. Essa task pode ser criada junto com a milestone e ficar encadeada para começar imediatamente após sua conclusão.

Essa é uma alternativa a preservar e avaliar no desenho futuro, não uma regra para dividir toda milestone. A tarefa ligada deve aproveitar o fluxo de tasks que o usuário considera melhorado, sem exigir uma reformulação geral desse fluxo.

Condições propostas pelo assistente para avaliar essa alternativa:

- A milestone termina em uma entrega útil, verificável e com seus próprios critérios cumpridos.
- A task ligada representa um resultado separável; não recebe verificações, correções ou integração indispensáveis para tornar verdadeira a conclusão da milestone.
- A comparação mostra o que pertence à milestone e o que passa para a task ligada. O adiamento é uma escolha visível do usuário.
- Devem aparecer o prazo da milestone, o prazo da task ligada e a previsão da entrega completa. Mover trabalho para a task pode antecipar a primeira entrega; não prova redução do tempo total.
- O vínculo preserva origem, escopo, dependência e critérios de aceite. A conclusão da milestone e a conclusão do objetivo completo permanecem distinguíveis.
- O início encadeado respeita as autorizações, perguntas pendentes, claims, isolamento e gates aplicáveis. A escolha da alternativa deve esclarecer o que autoriza criar e executar, sem depender de um novo pedido redundante quando isso já tiver sido autorizado.

Os detalhes de criação antecipada, início automático e transferência de contexto ainda precisam de desenho técnico. Nenhuma task ligada foi criada nesta conversa.

## Acompanhamento durante a execução

A escolha inicial precisa governar a execução. Exibir uma estimativa sem acompanhar o desvio não atende à intenção confirmada.

- Persistir a alternativa escolhida, o marco inicial, o teto e o tempo acumulado entre sessões e retomadas.
- Separar estimativa de duração e limite autorizado de execução. A estimativa é incerta; o limite exige um comportamento definido.
- Incluir o custo de planejamento restante, implementação, testes, revisão, correções e integração. Explicitar o tratamento de CI, espera humana e indisponibilidade externa.
- Comparar o tempo gasto com entregas comprovadas e atualizar a previsão ao concluir slices ou encontrar bloqueios relevantes.
- Avisar quando houver evidência de que o restante não cabe no orçamento, explicando causa, avanço, saldo e alternativas enquanto ainda há possibilidade de decisão.
- Não ampliar silenciosamente escopo ou prazo. Redução de escopo ou extensão fora da autorização existente exige decisão explícita.
- Ao atingir o teto, preservar o trabalho e produzir um checkpoint seguro. Não continuar indefinidamente, declarar sucesso incompleto ou matar um worker ativo sem considerar processos, receipts e possíveis escritas.

A forma técnica de contabilizar o tempo, prever desvios e interromper com segurança ainda será definida. Esta proposta não afirma que esses controles já existem ou que uma instrução de prompt garante seu cumprimento.

## Fontes técnicas consultadas

Na discussão inicial foram lidos os seguintes arquivos locais:

- `agents/forge-planner.md`, seção `For milestone planning (plan-milestone)`: orienta a usar o menor conjunto de slices que cubra o escopo com dependências seguras, sem mínimo numérico e sem omitir requisitos.
- `shared/templates/dispatch/plan-milestone.md`: distribui essa orientação ao planejamento da milestone e pede roadmap e mapa de dependências.
- `shared/forge-intent-entry.md` e `shared/forge-direct-actions.md`: distinguem consulta, registro e início de implementação, preservando autorizações e gates.

Essas leituras identificam um ponto possível de integração, não uma investigação completa da viabilidade. Revalidar os arquivos na versão atual ao retomar: a milestone paralela e as issues em andamento podem mudar o fluxo. Não implementar a partir de premissas antigas sem essa revisão.

## Pontos para resolver na preparação futura

1. Definir o marco de término estimado: implementação verificada, integração, release ou instalação; como tratar UAT e esperas humanas.
2. Definir o relógio do orçamento: tempo corrido, tempo de execução, pausas e esperas externas, sempre mostrando o tempo total transcorrido.
3. Definir a evidência usada nas estimativas, a margem de incerteza e a resposta quando não houver histórico suficiente. Não prometer precisão sem dados.
4. Definir como o orçamento é distribuído entre preparação, slices, integração e correções e como a previsão é atualizada.
5. Definir o contrato da task ligada: criação junto da milestone, dependência, contexto, gates, autorização de início imediato e tratamento se a milestone exceder o teto ou ficar incompleta.
6. Definir se o teto escolhido limita apenas a milestone ou toda a cadeia, incluindo a task, e mostrar os dois horizontes ao usuário.
7. Definir avisos, checkpoints e parada segura, inclusive com worker ativo, retomada e sessões paralelas.
8. Definir os cenários em que não há três estratégias viáveis e como apresentar essa limitação honestamente.

Esses pontos estão abertos para a preparação futura; não são perguntas bloqueando o registro da ideia agora. Não interpretar sugestões ou este documento como autorização de implementação ou alteração das preferências globais.

## Critérios candidatos para verificar a feature

Quando a implementação for autorizada, o plano deve demonstrar pelo menos:

- Opções derivadas de escopos e dependências diferentes, com razões rastreáveis para a diferença de prazo e sem faixas globais inventadas.
- Preservação dos requisitos e dos gates em todas as opções, com adiamentos visíveis e consentidos.
- Alternativa curta com task ligada criada e encadeada, quando escolhida e autorizada, distinguindo primeira entrega de objetivo completo.
- Continuidade da escolha e da contabilização após compactação, reinício e retomada, sem zerar o histórico ou contar workers paralelos como horas corridas adicionais.
- Aviso de desvio antes do teto quando a evidência permitir e comportamento seguro ao esgotá-lo.
- Ausência de execução automática de trabalho adiado que não tenha sido autorizada.
- Preservação do comportamento atual das tasks sem vínculo.

São critérios candidatos, não plano aprovado ou afirmação de cobertura existente.

## Como retomar

Pedido sugerido para uma sessão futura:

> Retome a ideia registrada em docs/milestone-time-options.md. Preserve os conceitos já confirmados e a proposta de task ligada. Primeiro confira o que a milestone e as issues posteriores já entregaram, revalide os pontos de integração e apresente as decisões ainda necessárias. Não presuma autorização de implementar a partir do registro; siga o alcance do meu pedido atual.

Na retomada, ler este documento completo, preservar a distinção entre conceitos confirmados, propostas e pontos abertos e consultar as fontes atuais. Não selecionar ou retomar a milestone paralela por causa desta referência. O próximo passo acordado nesta conversa é somente preservar a ideia para o momento oportuno.

## Registro da conversa

**Usuário, proposta inicial:** relatou uma milestone em andamento havia mais de 52 horas e propôs apresentar três opções de prazo total durante a definição das slices. Ressaltou que os prazos e o que muda entre eles devem decorrer da análise do trabalho real, sem valores fixos previamente estipulados.

**Assistente, resposta inicial:** considerou a ideia viável, sugeriu começar pelas milestones e descreveu três estratégias com escopo e compromissos explícitos. Acrescentou persistência do orçamento, acompanhamento de avanço, revisão de previsão, aviso de desvio e checkpoint no teto. Diferenciou estimativa e limite autorizado. Não diagnosticou a duração da sessão paralela.

**Usuário, confirmação e acréscimo:** confirmou que a resposta capturou exatamente a ideia; explicou que tasks melhoraram muito na versão atual; propôs que uma alternativa curta possa separar a parte final numa task ligada, criada junto e encadeada imediatamente depois da milestone. Pediu preservar toda a discussão para retomar depois, pois a milestone importante e as issues existentes têm prioridade e a feature não pode ser implementada agora.

**Assistente, registro:** preservou a discussão e a extensão da task ligada neste arquivo, com um apontador em `.gsd/sessions/ask-2026-10-30-prazos-milestone.md`. Acrescentou como recomendação a distinção entre prazo da milestone e prazo da cadeia completa. Salvou documentação local, sem commit, publicação remota ou início de implementação.
