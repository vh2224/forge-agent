# Relatório de autonomia por entrega

`forge-autonomy.js` produz uma projeção local, determinística e somente leitura da
telemetria explicitamente indicada pelo operador. O relatório mede observações
delimitadas; o manifesto não autentica autoria, não declara que as fontes são um
inventário completo e não transforma ausência de evidência em zero.

## Uso

```bash
node scripts/forge-autonomy.js --input autonomy-input.json
node scripts/forge-autonomy.js --input autonomy-input.json --json
node scripts/forge-autonomy.js --help
```

A saída padrão é Markdown em pt-BR. `--json` emite o schema estruturado. A CLI
retorna `0` quando o relatório é válido, inclusive quando há métricas
desconhecidas. Retorna `2` para manifesto, fonte ou registro inválido e para
conflitos de identidade. O relatório estruturado preserva subtotais válidos e
diagnósticos mesmo nesses casos.

## Manifesto schema 1

```json
{
  "schema_version": 1,
  "owner_root": ".",
  "code_root": "../.forge-worktrees/T-20260924193738-medicao-autonomia/forge-agent",
  "branch": "forge/T-20260924193738-medicao-autonomia",
  "target": {
    "type": "task",
    "id": "T-20260924193738-medicao-autonomia"
  },
  "sources": {
    "gates": [".gsd/forge/gates/G-20260924190000-abcd.json"],
    "events": [".gsd/forge/events.jsonl"],
    "results": [".gsd/tasks/T-20260924193738-medicao-autonomia/result.json"]
  }
}
```

`owner_root` e `code_root` relativos são resolvidos contra a pasta do manifesto
na CLI. Pela API, o mesmo comportamento é obtido com
`buildAutonomyReport(input, { baseDir: pastaDoManifesto })`. Referências de
fontes relativas são sempre resolvidas contra o owner validado.

Cada item de `gates`, `events` e `results` deve ser um arquivo. Diretórios,
globs, caminhos fora das raízes e symlinks que escapam das raízes são recusados.
`code_root` pode ser omitido quando é igual ao owner. Quando é distinto, `branch`
é obrigatório e a raiz precisa ser uma worktree registrada do mesmo repositório
e da branch declarada. O owner precisa ser exatamente o projeto Forge declarado;
um ancestral encontrado durante a resolução não é adotado silenciosamente.

## Alvos

Uma task global usa um ID Forge completo e não recebe contexto de milestone:

```json
{ "type": "task", "id": "TASK-014" }
```

Uma task local exige milestone e slice completos. Eventos precisam carregar os
três eixos exatos; um gate sem slice não é atribuído à task local:

```json
{ "type": "task", "id": "T01", "milestone": "M014", "slice": "S02" }
```

Um slice exige seu milestone:

```json
{ "type": "slice", "id": "S02", "milestone": "M014" }
```

Um milestone usa apenas seu próprio ID e agrega somente descendentes que estejam
explicitamente identificados nos registros fornecidos:

```json
{ "type": "milestone", "id": "M014" }
```

Não há matching por prefixo, proximidade temporal, prosa, atividade recente ou
mera presença de um arquivo no manifesto. Alias opaco de run não é resolvido.

## Fontes admitidas

- `gates`: um gate JSON schema `1`, com `cwd`, `run_id`, `unit_id`, timestamps e
  resposta. Texto da pergunta, opções, notas e resposta não aparecem no relatório.
- `events`: JSONL de eventos `dispatch` e `review`. Cada linha não vazia precisa
  ser um objeto JSON completo. Registros não suportados são diagnosticados e
  ignorados; linhas malformadas ou tipos escalares invalidam a fonte.
- `results`: um resultado xllm JSON por arquivo. Um resultado só ganha atribuição
  por join único do `dispatch_id` com dispatch permitido e atribuível.

Cada arquivo e o manifesto têm limite de 1 MiB. O manifesto aceita no máximo 100
referências e cada JSONL aceita no máximo 10.000 registros. Não existe corte
silencioso. O helper abre um descritor, usa `fstat`, lê no máximo 1 MiB + 1 byte
em buffer fixo e revalida descritor, path e identidade antes do parse. Crescimento
ou troca concorrente é recusado sem uma leitura até EOF. O SHA-256 usa exatamente
os bytes limitados que foram parseados. A mesma fronteira vale para o manifesto.

As referências públicas têm apenas rótulo `owner:` ou `code:`, caminho relativo,
SHA-256 e linha ou pointer. Diagnósticos de entradas exteriores usam código e
índice da referência; caminhos absolutos fornecidos e conteúdo bruto não são
reproduzidos.

## Famílias e estados

As quatro famílias aparecem em todo relatório. Cada medida contém `definition`,
`unit`, `value`, `state`, `coverage`, `references` e `limitations`.

Estados:

- `observed`: há observação válida na população declarada;
- `unknown`: a evidência necessária não existe ou não é atribuível;
- `invalid`: uma fonte ou intervalo necessário é inválido;
- `conflict`: a mesma identidade tem conteúdos divergentes.

Cobertura:

- `provided_sources_only`: cálculo sustentado pelas fontes fornecidas;
- `partial`: subtotal válido com limitação, erro ou conflito visível;
- `none`: nenhuma referência sustenta o valor.

`0` só aparece quando existe uma população atribuída que sustente zero. Sem gate
atribuível, intervenções são `null/unknown`. Um gate cancelado ou respondido por
timeout/default pode sustentar zero respostas humanas na população fornecida,
mas não zero intervenções históricas.

A matriz semântica aceita `pending` sem answer, `answered` com source `human`,
`cancelled` com source `cancelled` e `expired` sem answer ou com source
`timeout-default`. `answerGate` permite ao chamador fornecer outro `opts.source`,
mas esta projeção aceita deliberadamente só o subconjunto acima: combinações
fora dele são fonte inválida e nunca sustentam zero observado.

## Cálculos

Intervenções contam somente gates `status=answered` com
`answer.source=human`. A latência usa `created_at` até `answer.at` apenas para
essa resposta humana. Timestamps de sweep de timeout não entram. Soma de espera
e união temporal são medidas separadas.

Execução usa `started_at` e `finished_at` ISO completos com timezone, ligados a
um dispatch exato e permitido. `duration_secs` precisa ser numérico e concordar
com o intervalo dentro de um segundo. A soma inclui cada invocação; a parede é a
união dos intervalos sobrepostos. Nenhum residual é preenchido e espera humana
não é subtraída.

Retrabalho observado inclui somente unidades `review-fix/<id>` com resultado
ligado. Para task, o ID precisa ser o próprio alvo. Para slice e milestone, a
única forma descendente aceita é a gramática local exata `review-fix/T##` já
atribuída pelos eixos milestone+slice; não existem formas `review-fix/S##` ou
`review-fix/M###`. Uma tentativa adicional comum não prova retrabalho. Esse
tempo já faz parte da execução e não deve ser somado novamente a ela.

Revisões somam somente `conceded_fixed` de declarações atribuíveis. Como o
produtor não possui ID universal de revisão, duplicatas canônicas são unidas com
aviso e declarações distintas são apresentadas como declarações, sem afirmar o
total exato de execuções. Correções aplicadas/verificadas e impacto permanecem
`null/unknown` porque não há elo causal com commit ou check.

Número, sucessos e taxa de retomadas permanecem `null/unknown`. Controller,
checkpoint, bind, token de sessão, idle e `status=done` não formam um evento
universal de retomada nem comprovam resultado posterior da mesma entrega.

## Deduplicação e conflitos

Gates usam projeto + `id`; dispatches e resultados usam projeto +
`dispatch_id`. Cópias semanticamente idênticas agregam referências sem inflar
valores. Conteúdo divergente sob a mesma identidade gera conflito e toda aquela
entidade é excluída do agregado, independentemente da ordem dos arquivos. O
primeiro ou último registro nunca vence.

A igualdade semântica é independente da projeção pública. Dispatch inclui os
eixos allowlisted de tentativa, engine, modelo, rota, transporte e escopo; gate
inclui identidade, origem, status e tempos; resultado inclui intervalo, status,
versão de protocolo e SHAs. Campos privados como pergunta, opções, notas, summary, prompt e
token de sessão ficam fora. Reviews não têm ID universal e usam fingerprint de
todos os campos semânticos do produtor, inclusive style, rounds, engines,
challenger/advocate e indicadores intra-family.

## API

```js
const { buildAutonomyReport, renderAutonomyMarkdown } = require('./scripts/forge-autonomy.js');
const report = buildAutonomyReport(manifest, { baseDir: process.cwd() });
process.stdout.write(renderAutonomyMarkdown(report));
```

A API não escreve arquivos, não executa comandos encontrados nas fontes, não
faz sweep/cleanup, não consulta contexto pessoal e não descobre runs ativos.
