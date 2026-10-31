# Forge no VS Code — painel Trabalho

Este pacote local mostra, numa TreeView **Trabalho** do View Container Forge na
barra de atividades, o trabalho pessoal real do operador no projeto aberto. O
painel é **somente leitura**: a única interação é o botão **Atualizar** no título
da view. Não há dados sintéticos; tudo o que aparece vem do núcleo Forge.

## O que o painel mostra e de onde vem cada dado

Os dados vêm de uma única leitura do núcleo canônico `scripts/forge-panel-source.js`
(`readPanelSource`, DTO schema 1). O painel não lê nenhuma outra fonte e não
mantém uma segunda fonte de verdade.

- **Trabalho**: identificador, fase, status e próximo passo de cada trabalho
  vinculado no contexto pessoal canônico (`~/.forge-personal/context.json` e o
  STATE de cada trabalho). Um frescor diferente de atual aparece como texto.
- **Agentes**: tipo (nativo ou sidecar), tarefa, host e transporte, fase,
  modelo resolvido e observado, atividade e navegação condicional, derivados do
  registro de eventos do projeto pela visão pessoal de agentes.
- **Pendências**: ID, status e pergunta das perguntas estruturadas do escopo
  pessoal, com a origem e o tipo do agente quando houver. Respostas nunca são
  exibidas; perguntas de outro escopo aparecem só como contagem.
- **Evidências**: rótulo, caminho relativo, localização e validade das capturas
  já registradas no checkpoint. Caminhos absolutos não aparecem.
- **Rodapé**: a hora local da leitura e a marca somente leitura.

Os rótulos de fase, atividade, tipo de agente e seções vêm do vocabulário do
próprio núcleo. Motivos de seção vazia ou indisponível (por exemplo, nenhum
agente ou eventos acima do limite) e itens acima do limite aparecem como texto.

## Estados explícitos

Antes da primeira leitura a view mostra "Lendo o trabalho...". Depois disso, um
estado diferente de atual vira um único nó explicativo:

- do núcleo: sem vínculo pessoal, pastas de projetos diferentes (ambíguo),
  projeto não resolvido, contexto pessoal inválido, corrompido ou acima do limite;
- locais: `no-workspace` (nenhuma pasta aberta), `workspace-not-local` (pasta
  fora do sistema de arquivos local, sem leitura), `core-unavailable` (núcleo
  Forge indisponível), `core-timeout` (leitura acima de 20 s), `core-failed`
  (leitura falhou, sem expor mensagem, stack ou caminho) e `dto-invalid` (resposta
  fora do DTO schema 1).

## Garantias somente leitura

- Sem rede, listener, servidor, webview, hosting ou marketplace.
- Sem ações: nenhum item tem comando ou menu próprio. Não é possível responder,
  aceitar, vincular, adotar, executar, abrir arquivo ou abrir link pelo painel.
- Sem escrita, terminal, tarefas, entrada de texto, área de transferência,
  observador de arquivos ou polling. A releitura acontece na ativação, quando a
  view fica visível, no foco da janela com a view visível, na mudança de pastas e
  pelo botão Atualizar, com uma leitura por vez e intervalo mínimo de 2 s para os
  gatilhos automáticos.
- A leitura roda num worker com limite de memória e tempo, fora da thread do
  extension host.

## De onde o núcleo é carregado

Nenhuma pasta do workspace, configuração ou dado escolhe o núcleo. Ele só é
carregado de:

1. a árvore-fonte que contém esta extensão (dois níveis acima), quando o
   `forge-source-manifest.json` dela declara a fonte `vscode-panel`; ou
2. a instalação Forge reconhecida (`FORGE_HOME`, senão `~/.forge-agent`), com
   `VERSION`, `manifest.json` e `scripts/forge-panel-source.js`.

Todo componente do caminho precisa ser arquivo ou pasta real, sem link ou
junction. Sem candidato válido, o estado é `core-unavailable`.

## Uso local sem instalar

Use o Extension Development Host com diretórios temporários exclusivos de dados
de usuário e de extensões e com as demais extensões desativadas. Só assim o
perfil do operador fica intocado; `--extensionDevelopmentPath` sozinho não isola
o armazenamento do VS Code nem as extensões instaladas:

```sh
code --user-data-dir=<temp-exclusivo>/user-data --extensions-dir=<temp-exclusivo>/extensions --disable-extensions --extensionDevelopmentPath=<checkout>/extensions/forge-vscode <projeto>
```

O caminho isolado já automatizado é
`node scripts/forge-panel-probe.js --panel-check --workspace <projeto>`.

Não há dependências npm, build ou servidor a iniciar. A ativação acontece ao abrir
a view `forge.work`. Em workspace não confiável o painel só lê dados. Em
workspace remoto a extensão roda do lado remoto e o núcleo precisa existir lá; em
workspace virtual o estado é workspace não local.

## Pendências e limites

- A instalação persistente no perfil do operador é uma etapa pendente, de
  integração autorizada; este pacote é privado e nada é publicado nem instalado.
- A navegação nativa do Codex para agentes continua condicional e aparece como
  texto.
- O aceite visual e de compreensão permanece pendente para a rodada final.

`node scripts/forge-vscode-panel.test.js` é prova offline: contrato do pacote,
localizador, worker, modelo, ativação com stub e negativos de mutação. Prova
offline e prova runtime são distintas; esta suíte não demonstra montagem no
cliente, aparência ou uso.
