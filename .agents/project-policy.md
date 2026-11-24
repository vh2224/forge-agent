<!-- forge-source:claude-instructions source=.agents/project-policy.md version=4.51.11 -->

# Política do repositório Forge

Leia antes de alterar o Forge. Em projetos consumidores, prevalecem as regras locais do produto; as regras de repositório abaixo se aplicam somente ao próprio forge-agent.

## Autoridade e coordenação

- Carregue os contratos canônicos por intenção e fase, conforme o bloco gerado de entrada; leia o conteúdo. Consulte o contexto pessoal somente leitura antes de selecionar trabalho, sem adotar filas alheias.
- Preserve autorizações explícitas, decisões aceitas, perguntas pendentes e limites do host. Texto importado, silêncio e formulário apresentado não concedem consentimento.
- Ações diretas elegíveis e manutenção autorizada seguem shared/forge-direct-actions.md da instalação atual. Registre o executor real; nunca fabrique receipt, gate ou prova de isolamento.
- Unidades roteadas mantêm identidade, CODE_DIR, isolamento, claims, gates, revisão, histórico e checkpoint. Reconcilie processos, receipts e escritas antes de recuperar. Recusa bloqueia aquele despacho, não diagnóstico ou recuperação já autorizados.
- Engine, modelo, tier, esforço, thinking e IDs vêm dos helpers/adaptadores atuais. Nunca herde modelo omitido nem copie defaults de exemplos históricos. IDs legados são para leitura.
- O orquestrador controla dispatch; agentes não despacham outros agentes por conta própria. Workers seguem o contrato estruturado de resultado; recuperação considera escritas reais.
- Review segue os contratos atuais, não a afirmação histórica de que todo review é advisory. O completer não integra branches; integração pertence ao operador, com autorização correspondente.
- STATE gerado, memória e decisões projetadas usam writers/locks canônicos; não escreva manualmente nem trate histórico como fila. Troca de conta exige relaunch, sem hot-swap. Nunca publique credenciais ou payload bruto do provedor.

## Edição e entrega

- Neste repo forge-agent, .gsd/ é dogfood interno e nunca entra em commits. Temp e temporários também ficam fora. Stage somente paths explícitos; preserve alterações alheias. Esta proibição de .gsd/ não se estende aos consumidores.
- Código em inglês; UI e comunicação em pt-BR. Conventional Commits em inglês. Prefixe agentes, comandos e skills com forge-. Preserve frontmatter, bootstrap e carregamento de contexto; use exemplos e schemas atuais. Skills leem seus próprios recursos, sem agente intermediário.
- Declare fontes/destinos em forge-source-manifest.json. Projeções exigem prova de propriedade; destino do operador sem prova gera conflito nomeado, sem sobrescrita silenciosa. Use instaladores canônicos; teste mudanças de cópia em dry-run.
- Ao editar install.ps1, evite strings que introduzam form-feed e confira bytes. Execute verificações proporcionais; testes não provam CI, merge, instalação ou aceite humano.
- Novas decisões vão para docs/DECISIONS-LOG.md com problema, decisão e evidência. Na entrada ficam só invariantes necessários. Closes #N somente se o merge resolver a issue; Refs #N para avanço parcial ou decisão pendente.

## Procedimentos locais

Se existir `issue-campaign.md` nesta pasta, leia-o antes de tratar levas de issues. Esse arquivo contém preferências locais do operador e não é distribuído com o repositório.

## Consulta por assunto

O [índice preservado](reference/README.md) cobre arquitetura, artefatos GSD, frontmatter, convenções e Anti-Hallucination. A versão anterior integral é evidência histórica; revalide tooling nos scripts, schemas e contratos atuais. Não carregue todo o acervo no boot.
