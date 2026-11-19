# Pendente — aplicar a redução do contexto de entrada

Registro solicitado pelo operador em 17/11/2026. **Ainda pendente: integração e aplicação no Forge compartilhado.**

A reorganização está no commit `528b0d3ab766e1bd11749d862c1fd5a260caeaf3`, branch `docs/compact-project-context-20261117`, no worktree `C:/dev/.forge-worktrees/md-context-20261117/forge-agent`. A entrada CLAUDE passou de31.589 para4.267bytes; política + entrada somam7.677bytes, com os bytes anteriores integralmente preservados. Sete suítes locais passaram e a revisão independente terminou sem pendências. Isso não comprova CI, merge ou instalação.

O operador informou duas sessões ainda trabalhando no Forge. A redução não foi aplicada ao checkout compartilhado nem à instalação global para preservar esses trabalhos. O warning pode continuar até a aplicação. Este lembrete não autoriza interromper sessões, sobrescrever alterações ou fazer merge/instalação automaticamente.

## Ordem para concluir quando houver uma janela segura

- [ ] Conciliar alterações das sessões e do checkout compartilhado; conferir a branch e o commit acima sem descartar trabalho alheio.
- [ ] Integrar a mudança pelo fluxo normal da equipe, com revisão e CI correspondentes. Registrar aqui o commit/PR e o resultado real.
- [ ] Após a integração, executar a atualização/instalação canônica do Forge (`forge-update`, conforme o fluxo vigente), com a autoridade correspondente. Atualizar antes da integração não inclui esta mudança.
- [ ] Sincronizar AGENTS.md e CLAUDE.md pelo helper canônico, preservando todos os trechos particulares e os lembretes fora dos blocos gerados. Não copiar o CLAUDE compacto por cima do arquivo local.
- [ ] Conferir tamanhos, links e idempotência; reiniciar/retomar as sessões para que leiam a entrada atualizada. Registrar a evidência antes de marcar a pendência concluída.

Em próximas retomadas ou consultas de status deste repositório, lembrar o operador desta pendência se ela continuar aberta. Não transformar isso em nova tarefa de produto nem adotar filas alheias.

Relatório e evidências: `docs/instructions-context/README.md` e `docs/instructions-context/evidence/local-checks.json` na branch/worktree acima. Não há push, merge ou instalação comprovados por este registro.
