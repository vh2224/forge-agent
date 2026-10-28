# Forge no VS Code — prova da S01

Este pacote local prova a viabilidade técnica de uma TreeView em um View Container
Forge na barra de atividades do VS Code. A view **Trabalho (sintético)** é somente
leitura. Todos os nós e o snapshot empacotado são **dados sintéticos** inventados.

A extensão não lê arquivos do workspace nem dados pessoais. Não executa comandos,
não escreve, não envia telemetria e funciona sem rede, listener, servidor, hosting
ou webview. Os links relativos das evidências são texto para inspeção, sem ação de
abertura. Agentes nativos e sidecars têm rótulos distintos; nada representa uma
sessão real do Codex ou do Claude.

## Montagem de desenvolvimento isolada

A montagem real pertence à T07. Use somente modo desenvolvimento, apontando
`--extensionDevelopmentPath` para este diretório e `--extensionTestsPath` para a
prova de montagem da T07. Use `--user-data-dir` e `--extensions-dir` temporários e
isolados, exclusivos da prova. Não use o perfil real do operador.

Este pacote é privado e local: nenhuma instalação no perfil real e nenhuma
publicação no marketplace são realizadas na S01. Não há dependências npm, build
ou servidor a iniciar. A ativação acontece ao abrir a view `forge.work`.

## Evidência e limites

`node scripts/forge-vscode-panel.test.js`, a partir da raiz do repositório, prova
a ativação com stub e os contratos de leitura, dados e inventário. Essa prova
offline não demonstra montagem no cliente, aparência ou compreensão humana.
A T07 registra a montagem em extension host com perfil isolado. O aceite visual
e de compreensão permanece pendente para a rodada humana final.

A S05 decide a distribuição, a exclusão de `test/` do pacote e a leitura das
fontes pessoais canônicas. A S01 não consulta nem persiste estado real de trabalho.
