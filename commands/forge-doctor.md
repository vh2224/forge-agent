---
description: "Diagnóstico Forge versionado por runtime e capability. --fix limita-se a reparos reversíveis declarados."
allowed-tools: Read, Bash
---

# Forge Doctor

Este comando é um adaptador fino para o diagnóstico neutro em `scripts/forge-doctor.js`.

1. Determine o runtime do host que invocou o comando (`claude` ou `codex`). Só use `both` quando o operador o pedir explicitamente.
2. Execute, sem login, keychain, rede ou fallback para o outro host:

```bash
node scripts/forge-doctor.js --check all --runtime "{runtime}" --json
```

3. Exiba `reason_code`, `runtime`, `status` e `severity` de cada diagnóstico. Somente `severity: fatal` falha o comando. `conditional-capability-unavailable` é aviso.
4. Não leia nem crie o home do runtime não selecionado. Nunca tente reparar confiança de hooks, login, credenciais, keychain ou capabilities condicionais.

Com `--fix`, execute `node scripts/forge-doctor.js --fix --runtime "{runtime}"` apenas para os reparos reversíveis que o script declara. `--dry-run` não escreve.

Com `--regen-projection`, encaminhe a flag diretamente ao script e encerre sem executar o diagnóstico normal:

```bash
node scripts/forge-doctor.js --regen-projection
```

## Recuperação de claim travado

Primeiro faça somente o preview:

```bash
node scripts/forge-doctor.js --recover-claim "<run-id>" --cwd "<workspace>"
```

Somente depois de confirmar externamente que o proprietário parou, aplique com as duas flags:

```bash
node scripts/forge-doctor.js --recover-claim "<run-id>" --apply --confirm-owner-stopped --confirm-workspace-quiescent --cwd "<workspace>"
```

O comando só aceita uma run presente no censo `claim-stuck`. Ele não infere morte por PID, sessão ou idade. A ordem é explícita: registra a intenção antes de qualquer mutação, cria e reabre o bundle byte-preserving, registra `bundle-verified`, mede novamente todo o dirty scope e só então tenta a transição CAS para `released/manual` e `active:false`.

As duas atestações são obrigatórias: `owner-stopped` confirma o fim do proprietário e `workspace-quiescent` é o fence contra troca externa concorrente dos paths. Node não oferece `openat`/`O_NOFOLLOW` handle-relative portável; `lstat`, identidade de ancestry e revalidações cobrem o estado preexistente, não prometem atomicidade contra um processo hostil ativo. Para concorrência cooperativa, a segunda medição roda como precondition dentro do mesmo lock da transição; o CAS também exige que o RunRecord inteiro permaneça idêntico. Journal, payload, manifest e sidecar são sincronizados antes do CAS.

Restauração também começa por preview. O apply nunca sobrescreve bytes divergentes; esses payloads são extraídos na área `conflicts` do bundle:

```bash
node scripts/forge-doctor.js --restore-claim "<run-id>" --cwd "<workspace>"
node scripts/forge-doctor.js --restore-claim "<run-id>" --apply --confirm-workspace-quiescent --cwd "<workspace>"
```

Se a regeneração for recusada porque o fragment store está vazio e o monolito ainda contém dados, recomende primeiro `node scripts/forge-migrate.js`. Só mencione `--force` com um aviso explícito de possível perda de dados.
