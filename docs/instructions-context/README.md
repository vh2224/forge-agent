# Contexto de entrada — manutenção de 17/11/2026

Compactação do contexto de entrada do próprio Forge, preservando o conteúdo anterior e os contratos obrigatórios. Execução direta autorizada pelo operador, em worktree isolado; modelo e esforço do host não observáveis. Nenhuma run ou receipt de worker foi simulado.

## Forge

Base oficial local: 63fc4ebcbd0c33e0bc9f91873bfd4d5ab8b56dc8 (4.51.5). Branch: docs/compact-project-context-20261117. O checkout compartilhado e worktrees de outras sessões não foram editados. Quatro arquivos previamente protegidos do checkout compartilhado mantiveram seus hashes na verificação final.

- CLAUDE.md: 31.589 → 4.267 bytes (86,5% menos).
- Política obrigatória: .agents/project-policy.md, 3.410 bytes. Entrada + política: 7.677 bytes.
- Todos os 31.589 bytes anteriores sobrevivem nas cinco partes históricas, reconstruíveis exatamente pelo mapa. SHA-256 original: c29d739155bb8c660e97d6556e08bbe0a2c4024641a41f0b1cd320e6fbf680db.
- Arquitetura, frontmatter, artefatos, convenções e Anti-Hallucination ficam acessíveis por índice. Exemplos antigos, métricas, defaults e regras substituídas estão citados como texto histórico; contratos atuais prevalecem.
- O manifesto distribui a política, índice, mapa e acervo junto da entrada Claude. A entrada gerada dos dois hosts exige a política local quando ela existe. AGENTS.md continua sendo projeção gerada; não foi introduzida uma cópia manual rastreada.
- Fixtures históricas permanecem intactas. Um sucessor medido valida novos bytes/membership antes de entregar a projeção histórica ao validador ancestral; fontes anteriores são comprovadas por hash.

## Verificação e aplicação — registro histórico de17/11

Sete suítes locais concluídas com exit0: forge-project-context, forge-instructions, forge-instructions-context, forge-instructions-install-budget, forge-source-manifest, forge-claude-renderer e forge-codex-renderer. A nova verificação cobre reconstrução exata, corrupção/ausência, orçamento por arquivo, idempotência, links locais e distribuídos, membership e rejeição de tamper em fonte/render. Revisão independente somente leitura retirou dois achados de apresentação após inclusão de wrappers literais e terminou sem pendências; a revisão adicional confirmou bytes Git-base das quatro fontes, uma chamada ancestral e rejeição de tamper ancestral. Isso não atesta CI, instalação global ou comportamento de sessões já abertas.

A entrega do Forge está isolada. Não houve merge, push, instalação global ou atualização das duas sessões ativas. Depois da integração desta branch e da atualização canônica da instalação, sincronizar as entradas do checkout compartilhado quando as sessões puderem relê-las; conferir novamente seus bytes particulares e idempotência. Um forge-update anterior à integração não contém esta mudança. Padrões grandes consultados por assunto em .gsd não foram editados durante trabalho alheio.

Lembrete operacional aberto: [pendência de aplicação](../PENDENCIA-CONTEXTO-DE-ENTRADA.md).

## Retomada autorizada em 18/11/2026

A integração foi conciliada com a base oficial 0d8d21ebbb1a675f15bf43f25214b34d2a47179f (v4.51.10). A camada nova de distribuição compõe sobre issues434-436, preservando todas as190fixtures históricas e os perfis de tempo. O fluxo de aplicação exige nova verificação local, CI, merge e atualização canônica; o estado de cada ambiente é registrado em docs/PENDENCIA-CONTEXTO-DE-ENTRADA.md. A seção anterior registra somente a preparação de17/11. Relatórios de outros projetos não integram esta publicação.
