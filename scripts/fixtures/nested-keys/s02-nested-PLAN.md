---
must_haves:
  truths:
    - "O módulo web/src/format.js exporta titleCase juntamente com o export existente trimAll."
    - "titleCase capitaliza a primeira letra de cada palavra e converte as letras restantes da palavra para minúsculas."
    - "Os testes co-localizados de format passam com node --test no repositório web."
  artifacts:
    - path: "web/src/format.js"
      provides: "Implementação CommonJS e export de titleCase, preservando trimAll."
      min_lines: 7
      stub_patterns:
        - "titleCase\\s*=\\s*\\(\\)\\s*=>\\s*\\{?\\s*\\}?"
    - path: "web/src/format.test.js"
      provides: "Testes node:test para titleCase, incluindo normalização de caixa em múltiplas palavras."
      min_lines: 15
      stub_patterns:
        - "test\\([^)]*\\)\\s*=>\\s*\\{\\s*\\}"
  key_links:
    - from: "web/src/format.test.js"
      to: "web/src/format.js"
      via: "require('./format') obtém titleCase para as asserções."
  expected_output:
    - "web/src/format.js"
    - "web/src/format.test.js"
  depends: []
  writes:
    - "web/src/format.js"
    - "web/src/format.test.js"
---

# T01 — Implementar e testar `titleCase`

## Objetivo

Entregar `titleCase(s)` no módulo de formatação do repositório `web`, conforme a decisão do milestone: a primeira letra de cada palavra fica maiúscula e o restante fica minúsculo.

## Arquivos sob propriedade

- `web/src/format.js`
- `web/src/format.test.js`

## Implementação

1. Em `web/src/format.js`, adicionar uma função `titleCase` compatível com CommonJS e incluí-la no objeto de `module.exports`, sem remover ou mudar `trimAll`.
2. Usar somente APIs nativas do Node/JavaScript; não adicionar dependências.
3. Definir o tratamento de palavras de modo que entradas com caixa mista sejam normalizadas: por exemplo, `hELLo wORLD` produz `Hello World`.

## Testes

1. Criar `web/src/format.test.js` ao lado do fonte, usando `node:test` e `node:assert/strict`.
2. Importar `titleCase` de `./format`.
3. Cobrir uma frase com múltiplas palavras e caixa mista, verificando que cada palavra recebe inicial maiúscula e restante minúsculo.
4. Incluir um caso simples de uma palavra para confirmar o mesmo contrato.

## Verificação

A partir de `web/`, executar:

```sh
node --test
```

O comando deve terminar sem falhas.
