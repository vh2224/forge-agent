# Fixtures da issue 440 — S01 (superfícies gerenciadas do owner)

- **Rótulo:** `mock`
- **Origem:** `synthetic` — todos os valores foram escritos à mão para os testes.
  Nenhum owner, sessão, conta, credencial ou caminho real foi lido ou copiado.
- **Revisão do CODE_DIR:** `905660e4eec278ddb133b6cd5f9627d69c30a4f6`.
  O pin de `protectedSnapshot` foi medido nos bytes intocados de `477efd6`.
  O blob de `scripts/forge-task-execution.js` é `e51315743687a97e171f3e1459294453cec8ef30`
  nas duas revisões.
- **Consumidor:** `scripts/forge-managed-surfaces.test.js`. A T02 consome o pin
  `protected_snapshot_pin` de `surface-census.json`.

## Arquivos

| Arquivo | Conteúdo | sha256 |
|---|---|---|
| `surface-census.json` | Censo dos writers do `.gsd` do owner entre o S0 e o assert: call site `scripts/<arquivo>.js#<símbolo>`, referência literal ao caminho ou ao construtor, classe de processo, rotas, decisão, motivo, achados cross-process e pin de `protectedSnapshot` | `97ec078f673b94bd7f545c6a168bd91d4726b731fa343fd7a589060cbd9e327e` |
| `delta-cases.json` | Casos nomeados de transição por superfície (e por validador isolado) com bytes antes/depois e a expectativa `ok`, `reason_code`, diagnóstico interno sanitizado quando necessário e subconjunto do `diff` | `b31f445ea73e8bdb77d55dc95b534337dbbba31127f7bd1c35fd048b97d9387a` |

A suíte confere os dois sha256 acima. Qualquer edição de uma fixture exige
atualizar esta tabela na mesma mudança.

## Método

1. **Censo estático.** Cada candidata do roadmap foi procurada por símbolo no
   CODE_DIR, seguindo `withExecutionActivity`, as cercas `withMutation` e
   `withOwnerLock` e a janela do owner. A suíte confere se cada símbolo está
   definido no arquivo citado e se o arquivo contém a `path_reference`.
2. **Censo dinâmico.** Usa os casos existentes de owner temporário em
   `scripts/forge-issues-429-432.test.js`: `activity-claude`, `activity-codex`,
   `activity-window-replacement` e `activity-pipeline`. As entradas citam esses
   casos em `observed_by`. O spawn adicional de `forge-hook.js` (PostToolUse e
   PreToolUse) dentro da janela não pôde rodar neste sandbox, porque todo comando
   `node` pedia aprovação. Por isso as linhas `direct-in-window` são achados estáticos.
3. **Casos de transição.** Os bytes são montados pela suíte a partir das
   representações `text`, `lines`, `base64`, `concat`, `repeat` e `lease`.
   `lease` é aplicada sobre `lease_base`, que tem o formato de
   `forge-unit-lease.validRecord`.

## Fixtures nomeadas criadas em tempo de teste

Ficam em roots temporários, removidos em `finally`:
`hardlinked-leaf`, `junction-component`, `file-symlink-leaf`, `escape`,
`relative-owner`, `file-as-directory`, `on-disk-case-alias`,
`surface-size-limit`, `tampered-preimage`, `hardlinked-preimage`,
`junction-store-root`, `junction-preimages-directory`, `rewritten-prefix`,
`truncated-prefix`, `inserted-line`, `replaced-file`, `hardlinked-journal` e
`corrupt-row`.
