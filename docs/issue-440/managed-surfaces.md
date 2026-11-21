# Superfícies gerenciadas do owner — `managed-surfaces-v1`

Issue 440, S01/T01. Este documento registra o censo de quem escreve no `.gsd` do
owner durante uma tentativa de `execute-task`, entre o snapshot S0 e o
`assertProtected`. Também registra a declaração versionada derivada do censo.

- Módulo: `scripts/forge-managed-surfaces.js` (declaração, validadores, normalização
  de caminho, preimagens, journal de auditoria, verificação de cadeia e CLI `--list`).
- Suíte: `scripts/forge-managed-surfaces.test.js`, só com roots temporários.
- Fixtures: `scripts/fixtures/issue-440/` (rótulo `mock`, origem `synthetic`).

O módulo só declara, valida e produz evidência. Ele **não concede autoridade**,
não observa processos nem relógio e não altera nenhum arquivo existente do owner.
A autoridade viva e as costuras ficam na T02. Os writers e o runner ficam na T03.

## Método do censo

1. **Estático.** Para cada candidata do roadmap, cada writer foi localizado por
   símbolo no CODE_DIR (`905660e`) e classificado pelo processo que o executa
   dentro da janela. O caminho seguido foi `withExecutionActivity`, depois
   `openProtectedWindow` e `windows.open`, e por fim as cercas `withMutation` e
   `withOwnerLock` (`assertMutationAllowed`).
2. **Dinâmico.** Vem dos casos de owner temporário já existentes em
   `scripts/forge-issues-429-432.test.js`:
   - `activity-claude` e `activity-codex`: heartbeat cross-process da lease sem
     mudar bytes, `appendHookEvidence` com `deferred: true` e `assertProtected` contra o S0;
   - `activity-window-replacement`: reabertura da janela da lease;
   - `activity-pipeline`: `runUnitSidecar` com o append protegido de eventos.

   O spawn extra de `forge-hook.js` (PostToolUse e PreToolUse) dentro da janela
   **não rodou** neste sandbox, porque todo comando `node` pedia aprovação. As
   linhas `direct-in-window` abaixo são, portanto, achados estáticos.
3. **Pin.** `sha256(require('./forge-task-execution').protectedSnapshot.toString())`
   é `eed8600f597bd5338219104b5149327dc320da604633007c9577b9430498375d`, com limite
   de 20000 entradas. Foi medido nos bytes intocados de `477efd6` (blob
   `e5131574…`, idêntico no head) e é consumido pela T02.

### Classes de processo

- `in-scope`: mesmo processo do escopo vivo da tentativa.
- `cross-process`: hook ou CLI do host.
- `boundary-only`: begin ou complete do controller, com fence da janela.
- `immutable`: entrada da tentativa conferida por hash.

### Rotas

As rotas são `claude-host-codex-worker` (medida primeiro), `codex-host` e `native`.
Na rota nativa, `withExecutionActivity` não abre a janela (`worker_mode === 'native'`),
então não há janela de execução nem `window-not-opened` a contornar por essa via.
Isso não significa que a rota nativa não suporte a declaração: `withNativeAttribution`
abre, via `withManagedAttribution`, um contexto de atribuição em `worker_mode: 'native'`
quando recebe o adaptador vivo (`runtime.managedAppendAttestation`).
A inspeção deste repositório não demonstrou um fornecedor do adaptador em host de
produção; os testes usam um adaptador sintético. Isso não prova ausência em hosts
externos, e nenhuma evidência E2E genuína em Windows foi observada.

## Tabela do censo

| Candidata | Call site | Classe | Claude→Codex | Codex host | Decisão |
|---|---|---|---|---|---|
| heartbeat do STATE | `scripts/forge-unit-controller.js#publishState` | boundary-only | boundary-only | boundary-only | não declarada |
| heartbeat do STATE | `scripts/forge-state.js#updateFields` | boundary-only | boundary-only | boundary-only | não declarada |
| heartbeat do STATE | `scripts/forge-state.js#cliMain` | cross-process | direct-in-window | direct-in-window | não declarada (achado) |
| `.gsd/forge/events.jsonl` | `scripts/forge-unit-sidecar.js#appendProtectedOwnerEvents` | in-scope | writes-in-window | writes-in-window | **declarada** `owner-events` |
| `.gsd/forge/events.jsonl` | `scripts/forge-unit-sidecar.js#appendOwnedEvent` | in-scope | writes-in-window | writes-in-window | não declarada (despachante) |
| `.gsd/forge/events.jsonl` | `scripts/forge-hook.js#appendRewriteEvent` | cross-process | direct-in-window | direct-in-window | não declarada (achado) |
| `.gsd/forge/events.jsonl` | `scripts/forge-hook.js#appendPrefsBlockedEvent` | cross-process | direct-in-window | direct-in-window | não declarada (achado) |
| `.gsd/forge/evidence~*.jsonl` | `scripts/forge-owner-transport-window.js#appendHookEvidence` | cross-process | fenced-in-window | fenced-in-window | **declarada** `hook-evidence` |
| lease da unidade | `scripts/forge-unit-lease.js#openProtectedWindow` | in-scope | writes-in-window | writes-in-window | **declarada** `unit-lease` |
| lease da unidade | `scripts/forge-unit-lease.js#heartbeat` | in-scope | read-only-in-window | read-only-in-window | não declarada |
| lease da unidade | `scripts/forge-unit-lease.js#acquire` | boundary-only | boundary-only | boundary-only | não declarada |
| registros do controller | `scripts/forge-unit-controller.js#withMutex` | boundary-only | boundary-only | boundary-only | não declarada |
| eventos do controller | `scripts/forge-unit-controller.js#publishEvent` | boundary-only | boundary-only | boundary-only | não declarada |
| runs e auto-mode | `scripts/forge-runs.js#writeAtomic` | boundary-only | fenced-in-window | fenced-in-window | não declarada |
| runs e auto-mode | `scripts/forge-hook.js#bumpHeartbeat` | cross-process | fenced-in-window | fenced-in-window | não declarada |
| `.gsd/.locks` | `scripts/forge-lock.js#ensureLocksDir` | in-scope | writes-in-window | writes-in-window | não declarada (transitório) |
| journal de tempo | `scripts/forge-milestone-time.js#appendJournal` | boundary-only | boundary-only | boundary-only | não declarada |
| journal de tempo | `scripts/forge-orchestrate.js#recordTimePresence` | boundary-only | boundary-only | boundary-only | não declarada |
| journal de tempo | `scripts/forge-milestone-time.js#main` | cross-process | fenced-in-window | fenced-in-window | não declarada |
| questions | `scripts/forge-pending-questions.js#openQuestions` | cross-process | fenced-in-window | fenced-in-window | nunca declarável |
| questions | `scripts/forge-pending-questions.js#answer` | cross-process | fenced-in-window | fenced-in-window | nunca declarável |
| prefs-error | `scripts/forge-hook.js#updatePrefsErrorFlag` | cross-process | direct-in-window | direct-in-window | não declarada (achado) |
| PLAN da tarefa | `scripts/forge-protected-owner-activity.js#withExecutionActivity` | immutable | immutable-checked | immutable-checked | nunca declarável |

O motivo de cada linha está em `surface-census.json`, assim como a
`path_reference` que a suíte confere no código-fonte.

## Declaração `managed-surfaces-v1`

Só entra superfície com writer canônico demonstrado. Isso vale para um writer
`in-scope` com capacidade viva ou para um append cross-process atestável por
adaptador vivo do host. A declaração é texto canônico congelado em profundidade.
`declarationDigest()` é o sha256 desse texto
(`0f78362e0f22b2a4d700865d31a790d688816f5a14a2c6faf6e1130fa7a8eb8f`) e a suíte fixa
esse valor.

| id | Caminho | Operação | Validador | Writers | Capacidade |
|---|---|---|---|---|---|
| `owner-events` | `.gsd/forge/events.jsonl` (exato) | append-only | `append-jsonl-v1` | `forge-unit-sidecar#appendProtectedOwnerEvents` | in-scope |
| `unit-lease` | `^\.gsd/forge/leases/[a-f0-9]{64}\.json$`, ligado a `sha256(unit)` via `forge-unit-lease.leaseFile` | field-update (`heartbeat_at`, `expires_at`) | `lease-clock-v1` | `forge-unit-lease#openProtectedWindow` | in-scope |
| `hook-evidence` | `^\.gsd/forge/evidence~…~…~…\.jsonl$`, ligado a milestone, slice e unit via `forge-evidence-path.buildEvidenceFileName` | append-only | `append-jsonl-v1` | `forge-owner-transport-window#appendHookEvidence` | host-attested-append (`hookAppendProof`) |

Limites por superfície:

- `owner-events`: 8 MiB no total, 64 KiB e 128 linhas por append, 32 KiB por linha.
- `unit-lease`: 16 KiB.
- `hook-evidence`: 1 MiB no total, 64 KiB e 128 linhas por append, 2048 bytes por linha.

Uma versão desconhecida lança `managed-surface-version-unknown` e a CLI
`node scripts/forge-managed-surfaces.js --list --version <v>` sai com 2.
`assertDeclaration` recusa qualquer objeto que não seja a instância congelada do
módulo, mesmo com o mesmo schema e os mesmos bytes (`managed-surface-attribution-forged`).

STATE não entra. Pela DS5, só entraria com um writer `in-scope` provado. Os campos
de heartbeat do STATE não têm writer dentro da janela e o CLI do host escreve
sem cerca.

## NEVER_DECLARED

Os padrões abaixo resolvem `null` em `resolveSurface` e nunca casam com nenhum
padrão declarado. A comparação dobra caixa, como no Windows:

- `continue.md` em qualquer nível;
- `*-CONTEXT.md` e `*-BRIEF.md`;
- `HANDOFF*.md` e `sessions/*.md`;
- `.gsd/forge/questions/**`;
- contrato, opções, seleção e adesão de tempo (`.gsd/forge/time/<M>/contract.json`,
  `options/**`, `selection.json` e `enrollment.json`);
- `transactions/**`, `results/**` e `boundaries/**`;
- `*-PLAN.md`, `*-PLAN-GATE.md`, `*-SUMMARY.md` e `.gsd/CODING-STANDARDS.md`.

Arquivos arbitrários e irmãos também resolvem `null`. Isso inclui `.bak`, `.tmp`,
quarentenas da lease, a evidência legada `evidence-<run>-<unit>.jsonl` e arquivos
de outra unidade ou milestone.

## Achados cross-process (`census-cross-process-writer-unattributable`)

| Call site | Superfície | Efeito |
|---|---|---|
| `scripts/forge-hook.js#appendRewriteEvent` | `.gsd/forge/events.jsonl` | `fs.appendFileSync` direto, sem cerca nem capacidade viva |
| `scripts/forge-hook.js#appendPrefsBlockedEvent` | `.gsd/forge/events.jsonl` | `fs.appendFileSync` direto, sem cerca nem capacidade viva |
| `scripts/forge-hook.js#updatePrefsErrorFlag` | `.gsd/forge/prefs-error.json` | escrita ou unlink direto |
| `scripts/forge-state.js#cliMain` | `.gsd/milestones/<M>/<M>-STATE.md` | atualização via `forge-lock`, fora da janela do owner |

Esses writers nunca aparecem como writer de superfície declarada. A recusa é
preservada: um delta deles dentro da janela continua sendo
`execution-protected-metadata` no `assertProtected` e não é contornado.

## Transição e regra legada

- A evidência legada (`evidence-<run>-<unit>.jsonl`) continua legível pelos
  leitores existentes, mas não é superfície declarada. Só o nome composto
  `evidence~<m>~<s>~<u>.jsonl` construído por `buildEvidenceFileName` entra.
- Uma lease fora do formato canônico `JSON.stringify(record, null, 2) + LF` é
  `managed-surface-field-unknown`. O mesmo vale para uma lease de outra unidade
  ou com chave duplicada. Não existe segundo parser: a validade usa
  `forge-unit-lease.validRecord`.
- `exclusive-create` existe no vocabulário (`OPERATIONS`) para writers futuros.
  Nenhuma superfície v1 o usa. O validador `exclusive-create-v1` só pode ser
  exercitado isoladamente, por `{ validator, limits }`, e devolve veredito sem
  caminho, writer ou capacidade.

## Store externo

O store fica fora do owner. Só os componentes **dentro** dele são conferidos; o
diretório pai pertence ao chamador.

- `retainPreimage(store, bytes)` cria `<store>/preimages/<sha256>` com flag `wx` e
  modo `0o600`. Os mesmos bytes são idempotentes. Bytes diferentes sob o mesmo
  nome dão `managed-surface-preimage-conflict`. Um componente symlink ou junction,
  ou `nlink > 1`, dá `managed-surface-store-invalid`.
- `appendJournalRow(store, row, anchor)` confere sha256, tamanho e identidade
  (`dev`, `ino`, `birthtime`) do prefixo antes do append e verifica de novo depois.
  Reescrita, truncamento, linha inserida ou substituição do arquivo dão
  `managed-surface-audit-prefix-changed`. O primeiro append exige `anchor = null`
  e journal ausente.
- As leituras usam `readBoundedStableFile` com limite nomeado por superfície e,
  no store, 16 MiB por preimagem e 8 MiB no journal.

## Linha de atribuição (`managed-surface-attribution-v1`)

Campos fechados: `schema`, `declaration_digest`,
`attempt {dispatch_id, unit, run, milestone, slice}`, `sequence`, `surface_id`,
`path` (exato da tentativa), `operation`, `validator`, `before_sha256`,
`after_sha256`, `preimage_sha256`, `diff_sha256`, `previous_row_sha256` e
`baseline_sha256` (digest do S0).

`verifyAttributionChain` é determinística e devolve, por caminho, `attributed` ou
`unexplained` com `reason_code`:

- vínculo de outra tentativa ou de outra declaração: `managed-surface-attribution-foreign`;
- linha repetida, sequência quebrada ou `previous_row_sha256` divergente:
  `managed-surface-attribution-reused`;
- cadeia que não começa no S0 ou ligada a outro S0: `managed-surface-baseline-unbound`;
- preimagem ausente: `managed-surface-preimage-missing`;
- delta sem linha, ou linhas que não chegam aos bytes atuais:
  `managed-surface-unattributed`.

## Diff sanitizado

`sanitizedDiff` traz só:

- nomes de campo do schema declarado;
- contagem e sha256 truncado (12 hex) de nomes desconhecidos;
- linhas e bytes acrescentados;
- tamanhos e hashes antes e depois.

Valores e conteúdo nunca entram. A suíte injeta segredo e caminho pessoal
sintéticos e prova que não aparecem.

## Códigos fechados

`managed-surface-version-unknown`, `-path-invalid`, `-undeclared`, `-unattributed`, `-field-unknown`, `-field-immutable`, `-append-rewrite`, `-append-invalid`, `-create-conflict`, `-baseline-unbound`, `-attribution-foreign`, `-attribution-reused`, `-attribution-forged`, `-capability-required`, `-attestation-required`, `-preimage-conflict`, `-preimage-missing`, `-audit-prefix-changed`, `-read-limit`, `-unstable`, `-store-invalid`.

Todos usam o prefixo `managed-surface`. Este conjunto é exatamente o contrato
aprovado na S01. `diagnostic`, quando presente, identifica somente o ramo interno
recusado por um nome fixo e sanitizado; não amplia os códigos públicos nem concede
autoria. Limites de tamanho/linhas usam `managed-surface-read-limit`, regressão de
relógio usa `managed-surface-field-immutable` e lease inválida usa
`managed-surface-field-unknown`, com o diagnóstico específico preservado.

## Caminhos no Windows

`normalizeRelative` e `resolveSurface` recusam com `managed-surface-path-invalid`:

- barra invertida, `..`, `.`, caminho absoluto (POSIX, UNC ou drive) e componente vazio;
- NUL e caracteres de controle;
- `:` (ADS e drive relativo) e curingas;
- ponto ou espaço final;
- nomes reservados (`CON`, `NUL`, `AUX`, `COM1`, `LPT1`, `CONIN$`), com ou sem extensão;
- alias 8.3 (`EVENTS~1.JSO`) e Unicode fora de NFC;
- alias de caixa de um caminho declarado.

No disco, `physicalTarget` recusa symlink ou junction em qualquer componente,
folha com hardlink e divergência de caixa entre o pedido e o `realpath`.

## Limites

- **Não é sandbox do sistema operacional.** A validação acontece depois do fato,
  sobre snapshots e bytes observados. Uma escrita transitória restaurada antes do
  assert não é vista.
- O módulo não prova autoria nem processo. Quem atesta é o adaptador vivo da T02.
- O censo dinâmico com spawn real do hook dentro da janela ficou pendente neste
  sandbox. Ver o método acima.
