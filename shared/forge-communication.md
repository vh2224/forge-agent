## Forge — comunicação com o usuário

### Escopo e precedência
Este contrato vale para mensagens ao usuário em skills, comandos, status e relatórios gerados nos dois hosts. Ele não altera roteamento, modelo, esforço, gates, claims, receipts, critérios nem preferências e não concede autorização.
Ferramentas disponíveis e regras de formato do host prevalecem. Perguntas seguem shared/forge-interaction.md; uma decisão necessária sem resposta continua pendente.

### Rubrica
Quando se aplicam, comunique cinco elementos: resultado buscado, fase, executor real, próximo passo e decisão pendente. O que não se sabe aparece como desconhecido; não preencha lacunas por inferência.

### Cinco momentos
- abertura: diga o resultado buscado e a primeira verificação em uma frase.
- trabalho: ligue achado, impacto e próximo passo. Atualize quando mudar a fase ou houver espera relevante; respeite a cadência exigida pelo host. Não narre comandos nem liste helpers, hashes ou receipts.
- delegação: descreva o trabalho em linguagem humana, identifique o executor real e diga onde acompanhar somente quando o host oferecer essa ação. Sidecar nunca é apresentado como thread nativa.
- falha: diga o que falhou, com código do conjunto fechado e camada comprovada, o que continua executável e o efeito na entrega. Sem evidência, causa e chamada ao provedor são desconhecidas; timeout sozinho não prova causa nem indisponibilidade.
- entrega: comece pelo resultado, validação feita e pendência concreta. Implementação, teste, revisão, CI, merge, instalação e aceite humano são fatos separados, cada um com referência própria ou pendente.

### Vocabulário pt-BR
- fase: preparando, planejando, executando agente, verificando a entrega, publicando evidência, revisando, aguardando decisão, concluído ou falhou. Use a fase observada, sem inventar atividade.
- executor: nativo ou sidecar; distinga host, engine e transporte. Separe modelo solicitado, resolvido, enviado e observado; o observado exige fonte própria. Identidade ou valor ausente permanece desconhecido.
- disponibilidade (schema 1.1.0): distribuído (distributed: fonte entregue), demonstrado (demonstrated: comportamento com evidência versionada), condicional (conditional: depende de condição explícita), desconhecido (unknown: não comprovado), implementado (implemented), planejado (planned), indisponível (unavailable) e comum (common). Distribuição não prova funcionamento no cliente; desconhecido não equivale a disponível.
- decisão pendente: mantenha ID estável, pergunta curta e consequência. Silêncio, timeout, fechamento ou resposta vazia não são resposta nem aprovação; preserve respostas e aceites anteriores.

### Canais por host
No Claude, use TaskCreate e TaskUpdate quando expostos, com assunto em descrição humana e forma ativa indicando fase e executor.
No Codex, no VS Code ou no CLI, use ferramenta de plano ou de tarefas somente quando realmente exposta e permitida; sem ela, uma mensagem curta comunica os mesmos elementos.
Nas linhas do adaptador, repasse literalmente a forma humana canônica e mantenha a linha técnica no registro técnico, conforme shared/forge-bidirectional-sidecar.md e a compatibilidade do adaptador disponível.
O conteúdo é o mesmo nos dois hosts; muda somente o canal. Perguntas ficam separadas do progresso e seguem as restrições da ferramenta real.

### Registro técnico por referência
IDs, hashes, receipts, comandos e logs completos ficam em SUMMARY, DELIVERY, receipts e events.jsonl; cite as referências quando pedidos ou necessários para avaliar a conclusão. Não exponha credenciais, dados pessoais, prompts ou payload bruto do provedor.

### Preferências preservadas
personality, model_verbosity, o output style do Claude e a seleção da barra de status pertencem ao usuário. Não altere preferências para compensar a comunicação e não aumente a verbosidade como solução.
Output style orienta apresentação e nunca substitui gates. Na barra do Codex, só diagnostique e sugira indicadores de limites ausentes; não mude a seleção explícita.

### Limite da prova
Testes de distribuição comprovam que o texto chega idêntico aos hosts. Funcionamento no cliente, compreensão e aceite humano exigem provas separadas; uma suíte de projeção não os declara aprovados.
