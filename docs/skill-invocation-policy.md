# Política de invocação das skills

Auditoria #368 sobre a base52a69e79e92c58914da7fcb69f112219a4fd508b (v4.49.9): havia16skills com `disable-model-invocation: true`. A proposta abaixo remove a restrição de9 e mantém7 por efeitos concretos. A flag controla a possibilidade de invocação pelo modelo; não é autorização para alterar arquivos, preferências, hosts ou executar unidades.

Uma skill liberada pode ser chamada para o escopo explicitamente solicitado na conversa. Argumentos, modos mutantes e decisões necessárias continuam sujeitos à autorização existente e aos gates próprios; pedido de leitura não autoriza `--fix`, instalação ou nova execução. Não escolha trabalho de terceiros nem amplie o pedido por a skill estar disponível.

| Skill auditada | Flag após a revisão | Motivo e limite |
| --- | --- | --- |
| forge-add-slice | removida | Preparação solicitada de slice; altera apenas os artefatos do escopo escolhido, sem autorizar execução. |
| forge-add-task | removida | Preparação solicitada de task; adicionar ao plano não aprova executar. |
| forge-ask | removida | Conversa e registro da sessão; a proibição de editar código de produção e os pedidos específicos para probes/decisões permanecem. |
| forge-codebase | removida | Diagnóstico por padrão; correções mecânicas exigem `--fix` explicitamente autorizado, com paths e regras de segurança próprios. |
| forge-config | mantida | Configuração do host/status line/hooks e MCPs, com efeitos em homes e configurações pessoais. A escolha de alterar continua do operador. |
| forge-curate | mantida | Curadoria semântica destrutiva; exige arbitragem humana por lote e preserva a política de invocação humana já existente. |
| forge-discuss | removida | Preparação de arquitetura; perguntas obrigatórias continuam pendentes até resposta explícita, sem consentimento por invocação. |
| forge-doctor | mantida | Combina diagnóstico com reparo de instalação/estado e recovery/restore de claims; exige alvo e atestações reais de owner/quiescência nos modos mutantes. |
| forge-explain | removida | Leitura e explicação dos artefatos solicitados, sem execução ou alteração. |
| forge-mcps | mantida | Adiciona/remove servidores no registry do host e pode instalar componentes ou envolver credenciais; preserva a escolha de escopo/configuração do operador. |
| forge-memories | removida | Consulta, exportação e regeneração da projeção; preserva fragmentos e histórico. Curadoria/fusão continua no fluxo humano de forge-curate. |
| forge-next | removida | Um único passo/unidade solicitado, seguido de parada e checkpoint. Sem encadear invocações nem substituir por forge-auto; todos os gates e routing permanecem. |
| forge-pause | mantida | Toggle do controle de uma execução: uma chamada pode pausar ou cancelar a pausa conforme o estado atual. Mantém o controle deliberado do operador sobre runs ativas. |
| forge-prefs | mantida | Escrita de preferências locais/globais, incluindo modelos, esforço e políticas de execução; nenhuma necessidade de diagnóstico autoriza alterar esses valores. |
| forge-probe | mantida | Experimento manual: cria e executa código descartável, pode instalar dependências locais, acessar serviços e fazer commit conforme prefs. Não é mera leitura/preparação documental. |
| forge-skills | removida | Catálogo e instruções de uso; o modo install mostra instruções, sem instalar automaticamente. |

A retenção em uma skill com modos mistos também restringe sua entrada de leitura; é uma escolha explícita para conservar o ponto de entrada operacional de maior efeito, não uma alegação de que a leitura seja perigosa. Gates de curadoria, reparo, preferências e host continuam independentes da flag. Alterar essa escolha exige atualizar inventário e teste de distribuição.

## Histórico e limite da evidência

`ba6fdac` e `dac59f3` registram a adoção em lote. `c5fb570` removeu a flag de auto/task/new-milestone/status/help para permitir chamadas por `Skill()`. `b24bedb`/PR#30 liberou sweep com sua política própria de fim de ciclo; sua prosa posterior ainda listava auto/task/new-milestone como restritos e foi corrigida no DECISIONS-LOG. A antiga atribuição de prevenção ao #26251 não foi demonstrada; não deve ser usada como justificativa técnica da flag.

O teste `scripts/forge-skill-invocation.test.js` confere o inventário exato em toda a fonte e a preservação do frontmatter pelo renderizador Claude real, além da política de passo único distribuída. É prova de fonte/distribuição, sem spawn de modelo: não prova descoberta, chamada pela ferramenta Skill, renderização da UI atual, comportamento do Codex, execução dos gates ou aceite humano. Os hashes históricos de distribuição não devem ser regenerados; qualquer novo delta deve ser medido e encadeado sobre a composição final.
