---
name: forge-doctor
description: "Diagnóstico e correção reversível do projeto Forge. Flags: --fix, --dry-run, --runtime."
disable-model-invocation: true
allowed-tools: Read, Bash
---

# Forge Doctor

Use este skill como adaptador fino do contrato JSON versionado.

## Diagnóstico

### Recuperação guiada por ID

Para interrupção, resultado parcial ou continuidade não comprovada, use o ID
explicitamente escolhido, sem executar o censo geral abaixo:

```bash
node scripts/forge-doctor.js --diagnose-recovery TASK-001 --cwd "<projeto>"
node scripts/forge-doctor.js --diagnose-recovery M005 --controller-key "<chave>" --cwd "<projeto>" --json
```

Texto pt-BR e JSON apresentam as mesmas observações: fontes e estado de evidência,
resultado comprovado, incertezas, artefatos preservados, continuidade, aceites,
decisões pendentes e próximo passo seguro. Exit 0 significa observação válida sem
bloqueio, nunca conclusão do trabalho; 1 significa parcial/incerto; 2, argumentos
inválidos. O modo é exclusivo: aceita apenas ID, `--controller-key`, `--cwd` e
`--json`; outras operações, flags mutantes e atestações são recusadas antecipadamente.

Não seleciona trabalho sem ID, não vincula e não modifica journals, claims, leases
ou checkpoint. Preserva aceites registrados e mantém decisões não respondidas.
Release durável continua comprovado mesmo sem evento final; bundle órfão não prova
release. Existência de artefato não significa integridade verificada; SUMMARY
isolado ou atividade inativa não comprovam conclusão. Missing, corrupt, unreadable
e stale exigem encaminhamento explícito, sem converter falha em ausência limpa.

Controller só é observado por chave explícita de milestone; tasks standalone,
sweep, reset sidecar e outros journals permanecem não cobertos/unknown. Publicação
pode preceder a fase; committed não prova conclusão global. Inspeção não concede
autorização nem atestações. Qualquer ação posterior permanece na autoridade
original, que revalida precondições; não recomende replay pela ausência de evento.

### Diagnóstico geral

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

Use `--recover-claim <run-id>` sem `--apply` para preview. Aplique somente com as três flags obrigatórias: `--apply --confirm-owner-stopped --confirm-workspace-quiescent`. Nunca deduza morte por PID, sessão ou heartbeat.

Para workspace dirty, a ordem obrigatória é `intent → bundle reaberto/verificado → segunda medição do dirty scope → CAS`. `--restore-claim <run-id>` é preview; o `--apply` restaura paths ausentes e extrai conflitos sem sobrescrever bytes divergentes.

A atestação de workspace quiescente é o fence contra troca externa de paths. Node não fornece `openat`/no-follow portável: lstat e revalidação cobrem estado preexistente, não um processo hostil ativo. A segunda medição é precondition dentro do lock, imediatamente antes do CAS do RunRecord, e protege a concorrência que coopera com o Forge. Restore apply também exige `--confirm-workspace-quiescent`. Durabilidade: arquivos do bundle usam staging + file fsync + publicação atômica; journal append-only usa file fsync. POSIX também exige directory fsync bottom-up. Windows registra explicitamente que não há directory fsync portável nem garantia da entrada de diretório após queda abrupta.

Sem flags, não escreva. Com `--fix --dry-run`, descreva somente reparos reversíveis. Com `--fix`, encaminhe ao script e aplique apenas reparos que ele declara; backup/migração precedem qualquer escrita. Nunca acesse o home do runtime não selecionado.
