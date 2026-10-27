# Matriz final-candidate de contratos de release

Esta matriz aplica [o contrato de impacto](../../../shared/forge-release-impact.md)
aos consumidores observáveis de S02–S08 e às manutenções integradas. A classificação
é proposta para revisão documental independente, ainda pendente. Labels de issues
não definem kind/bump. Consumidores externos continuam `unknown`.

## Proveniência e baselines

CODE_DIR: `C:/dev/.forge-worktrees/M-20261020200139-memoria-explicavel/forge-agent`.
Branch: `forge/M-20261020200139-memoria-explicavel`.
A revisão inspecionada antes de T01 é `fd19ffd765252ce33fe66a7b8fc5a0c31c29e3e8`;
não é o commit desta task. `git-observations.json` captura HEAD, tree, branch,
argumentos, códigos reais de saída e ancestralidade por entrada.

`last-tag` é v4.45.1, peel `233b8e2fdd8fe6992a3499d40eef98b26ff1abb7`.
A tag histórica v4.45.0 tem peel `5a44919b9631545965e93d004cd7e17b3c6f616c`.
Ambas são objetos commit, obtidos por `rev-parse <tag>^{commit}`, ancestrais de HEAD.
O helper escolhe a maior tag semver aplicável. `slice-start` preserva a baseline
específica do contrato anterior; não promove esse major local a major público atual.
`released:true` exige todos os commits de evidência observados com exit 0 em
`merge-base --is-ancestor <commit> <tag>`. Exit 1 é false; outros resultados são unknown.
Para last-tag usa-se v4.45.1; para a comparação histórica slice-start, v4.45.0.
Ancestralidade não prova aceite humano nem origem de consumidores externos.

Em #221, observed_sha aponta a revisão corrente fd19ffd765252ce33fe66a7b8fc5a0c31c29e3e8.
O registro original 3cb9924cd8dcbf97233f199e45f5f0ef465698ad permanece em history,
sem alegação de ancestralidade ao HEAD: foi substituído por fd19ffd, com árvore
98d33fb9f28a22d8c339075b40ddb6f0cfb06604 idêntica. A ponte também preserva
0f758eba34f2dbc2948aca02f0ad3c7fecda1fed → 256840d451441d4a034b06353b30478578a8f9f9,
árvore f04f0de66e20eb6dc069f1bf38bd3714729942d8 idêntica. impact/provenance-bridge.json
copia a ponte autorizada de correção de mensagens; seu sha256 e as observações Git
ficam em git-observations.json. observed_on_branch indica leitura física do arquivo
no CODE_DIR atual; ancestralidade é outra observação, com argv e exit próprios.

## Histórico preservado

As duas cópias em `history/s08-intermediate/` vieram de `git cat-file blob` sobre
fd19ffd, em Buffer, sem conversão de texto ou cópia do working tree. Os OIDs
recalculados e sha256 fixados na suíte são:

| Arquivo | Blob Git | SHA256 |
| --- | --- | --- |
| milestone-contracts.json | 2dbba05709d51b2d24e5666bcf36504ef1394192 | a18fbbd860b8e7ee0cb21ed2b608670ac5bc55d3657903f5a72b4a68516fb437 |
| README.md | 3a0a3a5a903433ffb25ecce59a93642e01a03155 | 3be8a96d6b4088198482af8244c5cf085d278f00aba9396a8c24d1098b3b0041 |

Os links relativos do README histórico quebram na nova profundidade. Seus bytes
permanecem intactos; a referência válida ao contrato está no início deste README.
CHECK-EXAMPLES-INTERMEDIATE-SCHEMA mantém as asserções fechadas antigas somente
nessa cópia. CHECK-EXAMPLES-SCHEMA valida separadamente a matriz final-candidate.
HELPER-AGREES, CHANGELOG, CLASS-COVERAGE e S08-JUSTIFIED usam a matriz corrente.

## Leitura dos contratos atuais

S02 descreve publicação já disponível na tag histórica. S03 adiciona evidência v2;
S04 adiciona shards de CI, S05 diagnóstico e S06 shadow. S07 adiciona evidência/report;
#232/#233 mudam resultados e exigências contra S07 entregue, com major slice-start.
Contra last-tag, os módulos novos constituem adição compatível. S08 adiciona impact
e notes, mantendo partial para mensagens antigas sem declaração opt-in.

#208/#209 tratam paths/checagem de artefatos; #210 preserva identidade de memória,
#211 conserva perguntas e #212 supervisiona o stream. #214 delimita inteiros; #215
recusa YAML fora do subconjunto suportado. #222 propaga verificação e #223 valida
aliases. #226 adiciona policy opt-in; #228 corrige seed; #229 preserva unknown e
#230 acrescenta diagnóstico limitado. As âncoras de cada entrada identificam código,
símbolo, commit e consumidores efetivos, sujeitos à revisão independente.
#231 shape aponta forge-native-recovery-delivery.js; o controle atual exige string
não vazia. O diagnóstico intermediário de array truthy fica somente no histórico.
#234 preserva c912c8d8 e regressão d98f9384, com S08-REVIEW/S08-SUMMARY como evidência.
#235 amplia títulos aceitos para nível dois em forge-review-fix.js.

#221 requer atenção: em v4.45.1 o primitivo exportado invokeNative chamava invoke
sem exigir terminalResult. No código inspecionado, supervise recusa ausência de
terminal como função antes do callback. task-preparation, unit-sidecar e recovery
são consumidores reais e passam terminalResult; os onze arquivos integrados estão
nas evidências. A proposta new-requirement/major depende desse contrato observável,
e não da mera existência do símbolo ou do módulo novo de supervisão. A abrangência
pública dessa superfície e a semântica da baseline aguardam revisão independente;
não se demonstrou quebra de um consumidor externo. A suíte valida coerência da
proposta, não substitui essa revisão. Nenhum major é atribuído pelo rótulo fix.

## Resolução real de versão e achado

A execução real de resolveVersion, preservada em `impact/version-resolution.json`,
retornou range `v4.45.1..HEAD`, bump dos rótulos `minor`, new_tag `v4.46.0`,
impact.status `partial`, required `none`, declared_commits 0, undeclared_commits 82,
invalid_count 0 e conflict_count 0. Partial mantém impacto desconhecido; não prova
compatibilidade nem equivalência. `summary.required_bump_last_tag` é o máximo de
KIND_BUMP das entradas last-tag: major pela proposta #221. A diferença major/minor
é achado para o owner revisar; não é um conflito declarado pelo helper, que observou
zero declarações. T01 não corrige commits, trailers, tags ou release do projeto.

## Findings, exemplos e entrega

As onze linhas literais de S03/S04 vêm de literal-findings.json, sha256
`aba5bfedeef1a5971e50ebc99947d3381e849833988b12ee3b8c64586829d64c`.
S03 R1–R5: `All five S03 findings remain pending.`
S04 R1–R5: `Concedidas — correção pendente`; R6: `Abertas — triagem final`.
Nenhuma dessas linhas é encerrada pela fixture; a referência literal é preservada.

Exemplos real reproduzem mensagens observadas; illustrative são hipóteses. Versões
v1.2.3 são calibração sintética, sem retroagir trailers. A gramática Forge-Impact,
SURFACES, KINDS, KIND_BUMP e helpers ficam intactos. O checker compara hashes físicos
e observações Git; âncoras lexicais e schema são estruturais, não prova semântica.
`impact/handoff.json` fixa os hashes deste README e da fixture para a revisão
independente após retorno terminal. Revisão documental permanece pendente.
Implementação, checks locais, revisão, CI, merge, instalação, release e UAT são fatos
separados; estes artefatos não afirmam CI hospedado, publicação ou aceite humano.
