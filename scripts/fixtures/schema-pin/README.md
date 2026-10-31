# Pin histórico do Codex app-server

`codex-appserver-pin-0.163.0.json` preserva os bytes originais de
`shared/schemas/codex-appserver-pin.json`, antes do repin da S01/T03 da milestone
`M-20261028132636-experiencia`, em 2026-10-28.

- Gerador de origem: `codex-cli 0.163.0`.
- `projected_at` original: `2026-10-20T04:24:12.966Z`.
- SHA-256 físico: `1060034061a031cc64af06ed68666b9945af8e26c72c330fec77202728f4813f`.
- Cópia byte a byte, sem parse/regravação ou normalização de EOL.
- Cinco roots, 19 variantes, 53 tipos referenciados, nenhuma ref não resolvida.

A fixture é imutável. `forge-schema-pin.test.js` confere o hash e usa
`FORGE_SCHEMA_PIN_FILE` para confrontá-la com um schema montado a partir do pin
0.165.0. Esse negativo precisa continuar acusando drift, inclusive na inserção
de `modelNotFound` e no tipo `ImageGenerationInputImage`.

Não regenerar esta fixture para fazer um teste passar. Uma revisão futura deve
adicionar outro arquivo com versão e proveniência próprias, preservando este.
