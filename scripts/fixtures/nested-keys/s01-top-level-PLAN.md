---
status: DONE
must_haves:
  truths:
    - "`isEmail` é exportada por `src/validate.js` junto com o validador existente."
    - "Uma string de e-mail de formato simples válido retorna `true`."
    - "Strings sem a estrutura básica local@domínio.extensão retornam `false`."
    - "Entradas que não são strings retornam `false` sem lançar exceção."
    - "`node --test` passa a partir da raiz do repositório api."
  artifacts:
    - path: "src/validate.js"
      provides: "Validador isEmail CommonJS, exportado com isNonEmpty."
      min_lines: 5
      stub_patterns:
        - "isEmail\\s*=\\s*\\(\\)\\s*=>\\s*true"
        - "function isEmail\\s*\\([^)]*\\)\\s*\\{\\s*\\}"
    - path: "src/validate.test.js"
      provides: "Testes node:test adjacentes para isEmail."
      min_lines: 15
      stub_patterns:
        - "test\\([^,]+,\\s*\\(\\)\\s*=>\\s*\\{\\s*\\}\\)"
  key_links:
    - from: "src/validate.test.js"
      to: "src/validate.js"
      via: "require('./validate') obtém isEmail para as asserções."
expected_output:
  - "src/validate.js"
  - "src/validate.test.js"
depends: []
writes:
  - "src/validate.js"
  - "src/validate.test.js"
---

# T01 — Implementar e testar `isEmail`

## Objetivo

Adicionar o validador `isEmail(s)` ao módulo de validação da API e provar o contrato requerido por meio de testes nativos do Node.

## Arquivos sob responsabilidade

- `src/validate.js`
- `src/validate.test.js`

## Implementação

1. Em `src/validate.js`, preservar `'use strict'`, `isNonEmpty` e o padrão CommonJS atual.
2. Declarar `isEmail(s)` para primeiro verificar `typeof s === 'string'`; para qualquer outro tipo, retornar `false` imediatamente.
3. Para strings, aplicar uma regex simples que exija uma parte local não vazia, um único separador `@`, um domínio não vazio e uma extensão após ponto. O resultado deve ser booleano e a função não deve depender de pacotes externos.
4. Incluir `isEmail` no objeto de `module.exports`, sem remover `isNonEmpty`.

## Testes

1. Criar `src/validate.test.js` usando `node:test` e `node:assert/strict`.
2. Importar `isEmail` com `require('./validate')`.
3. Cobrir pelo menos um endereço válido simples, por exemplo `user@example.com`, esperando `true`.
4. Cobrir formatos inválidos representativos, incluindo ausência de `@` e ausência de extensão de domínio, esperando `false`.
5. Cobrir entradas não-string, incluindo `null` e um número, esperando `false` e deixando as asserções falharem caso a função lance.

## Verificação

Executar, da raiz do repositório `api`:

```sh
node --test
```

O comando deve concluir com todos os testes aprovados.
