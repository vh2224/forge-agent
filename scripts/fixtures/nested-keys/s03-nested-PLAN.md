---
must_haves:
  truths:
    - "api/src/shared.js exports SHARED_VALUE with the literal value 'shared'."
    - "web/src/shared.js exports SHARED_VALUE with the literal value 'shared'."
    - "The API test imports both repository modules and proves their exported SHARED_VALUE values are equal."
    - "Running node --test from api/ passes without adding dependencies."
  artifacts:
    - path: "api/src/shared.js"
      provides: "CommonJS shared-constant module for the API repository."
      min_lines: 4
      stub_patterns:
        - "TODO|FIXME"
    - path: "web/src/shared.js"
      provides: "CommonJS shared-constant module for the web repository."
      min_lines: 4
      stub_patterns:
        - "TODO|FIXME"
    - path: "api/src/shared.test.js"
      provides: "Node built-in test that compares the API and web shared-constant exports."
      min_lines: 9
      stub_patterns:
        - "TODO|FIXME"
  key_links:
    - from: "api/src/shared.test.js"
      to: "api/src/shared.js"
      via: "CommonJS require('./shared') reads the API export."
    - from: "api/src/shared.test.js"
      to: "web/src/shared.js"
      via: "CommonJS require('../../web/src/shared') reads the sibling repository export."
  expected_output:
    - "api/src/shared.js"
    - "web/src/shared.js"
    - "api/src/shared.test.js"
  depends: []
  writes:
    - "api/src/shared.js"
    - "web/src/shared.js"
    - "api/src/shared.test.js"
---

# T01 — Declarar e verificar a constante compartilhada

## Objetivo

Criar os dois módulos solicitados pelo roadmap em uma única task e garantir, por teste, que seus exports são iguais.

## Implementação

1. Criar `api/src/shared.js` no estilo CommonJS já usado no repositório:
   - incluir `'use strict';`;
   - declarar `const SHARED_VALUE = 'shared';`;
   - exportar a constante como `module.exports = { SHARED_VALUE };`.
2. Criar `web/src/shared.js` com conteúdo funcionalmente idêntico: mesma diretiva strict, mesmo identificador, mesmo literal e mesmo export CommonJS.
3. Criar `api/src/shared.test.js` usando `node:test` e `node:assert/strict`:
   - carregar `SHARED_VALUE` de `./shared`;
   - carregar `SHARED_VALUE` de `../../web/src/shared`;
   - afirmar que o valor da API é `'shared'`;
   - afirmar que o valor do web é `'shared'`;
   - afirmar que ambos são estritamente iguais.

## Verificação

Executar `node --test` dentro de `api/`. O teste novo e os testes existentes devem passar, sem instalar dependências e sem modificar `package.json`.
