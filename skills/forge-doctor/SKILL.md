---
name: forge-doctor
description: "Diagnóstico e correção reversível do projeto Forge. Flags: --fix, --dry-run, --runtime."
disable-model-invocation: true
allowed-tools: Read, Bash
---

# Forge Doctor

Use este skill como adaptador fino do contrato JSON versionado.

## Diagnóstico

Determine o runtime do host atual, sem sondar outro home, e execute:

```bash
node scripts/forge-doctor.js --check all --runtime "{claude|codex}" --json
```

Reporte os diagnósticos por `reason_code`:

- `core-incompatible`, `adapter-missing` e `required-capability-missing`: falha fatal;
- `conditional-capability-unavailable`: aviso não fatal;
- `available`: informativo.

Hooks sem confiança explícita são somente diagnóstico. Não altere trust, credenciais, login, keychain, hooks ou capability condicional.

## Correção

### Claim travado

Use `--recover-claim <run-id>` sem `--apply` para preview. Aplique somente com as duas atestações literais: `--apply --confirm-owner-stopped --confirm-workspace-quiescent`. Nunca deduza morte por PID, sessão ou heartbeat.

Para workspace dirty, a ordem obrigatória é `intent → bundle reaberto/verificado → segunda medição do dirty scope → CAS`. `--restore-claim <run-id>` é preview; o `--apply` restaura paths ausentes e extrai conflitos sem sobrescrever bytes divergentes.

A atestação de workspace quiescente é o fence contra troca externa de paths. Node não fornece `openat`/no-follow portável: lstat e revalidação cobrem estado preexistente, não um processo hostil ativo. A segunda medição é precondition dentro do lock, imediatamente antes do CAS do RunRecord, e protege a concorrência que coopera com o Forge. Restore apply também exige `--confirm-workspace-quiescent`.

Sem flags, não escreva. Com `--fix --dry-run`, descreva somente reparos reversíveis. Com `--fix`, encaminhe ao script e aplique apenas reparos que ele declara; backup/migração precedem qualquer escrita. Nunca acesse o home do runtime não selecionado.
