# Distribuição medida — issue #440

Camada aditiva sobre `issue-448/distribution.cjs`; todas as camadas, goldens e perfis publicados permanecem imutáveis.
O runtime não é alterado por esta camada de projeção para os testes de distribuição.

## Proveniência e método

- Base aprovada: `4606de1ecac3ddee7bc957d9a8dea3207023d5b5`, materializada por `git archive` em diretório descartável próprio.
- Gerador transitório `generate.cjs`, SHA-256: `f2535f7c74399645bb07846db0299a54e178c340b6edcdbc70fd4b12bfae3598`.
- Predecessor: `issue-448/distribution.cjs`; o digest do objeto `issue448Layer` é conferido pela camada.
- Antes: bytes exatos da base; depois: bytes atuais das fontes S01–S03. As preimagens são gzip/base64 com limite de 4 MiB.
- `attributed_*` remove apenas os blocos forge:linked-task, pela mesma expressão dos validadores predecessores.
- Renderer Claude real em ambas as árvores; versão no marcador normalizada somente na medição atual e nas superfícies agregadas.
- Superfícies: SHA-256 de source + NUL + conteúdo normalizado, ordenado por source e unido por NUL.
- `files` exclui somente o cjs, o delta e o teste desta camada; este documento participa da medição.
- O PIN final fica no cjs excluído e no handoff do owner, evitando um ciclo de hash neste documento.

## Censo histórico

Lista: `git ls-tree -r --name-only fa33d14ead04ce8829a855a771713cac71e58b34 -- scripts/fixtures`.
São 205 arquivos históricos: 199 anteriores mais 3 de issue-448 e 3 de issues-442-446, conferidos pelos bytes atuais.
Digest SHA-256 da listagem com LF final: `85f10f324e422c9663810e98c3427291c5912ae55dc2179d3fded4ef7bbe12b7`.
Digest SHA-256 do objeto ordenado historical_fixtures: `b9a789c5f0a69679b084b8622132b3a12f05f668c6dffc447a7b9c85ed22d04d`.
Os três arquivos S01 de issue-440 já pertencem a esse censo; são adições em relação à base4606, com before null.
Sete arquivos novos T01/T02 ficam separados: e2e-mock/{README.md,manifest.json,recording.jsonl}, e2e/{README.md,manifest.json,recording.jsonl} e workflow-layer.json.
Toda linha `files` sob scripts/fixtures tem before null. O censo lê os bytes projetados e recusa adulteração histórica.

## Superfícies medidas

| Superfície | Antes | Depois | Atribuído antes | Atribuído depois |
|---|---|---|---|---|
| `skills` | `7e77fb515fe74fa58e167274142f3a9f768a5c75c92bc9b1acb4306e73d3b426` | `d8284653f0518be4b714960167fe8fbef19aebffcd9fe7be0a335bb9ecacd230` | `dc669e8ad433719beb202e96f2387fc8eab32ca22abb517c4e57bd40283c9db3` | `d40164b6e32270e02a2a34ec5cd50c0d0c57c9d0dfdb355cf0812b15746f41d0` |

## Old18: falhas históricas, evolução qualificada e after

Fonte preservada: `t04-baseline-code-before.json`, SHA-256 `473427efcfe5ae33577680629df1ce53016a523b522c3e245ff389bb62990a3b`, revisão histórica `905660e4eec278ddb133b6cd5f9627d69c30a4f6`, Windows; todas as 18 execuções encerradas com joined/active_processes 0.
Digest por linha: SHA-256 dos bytes UTF-8 de stdout + NUL + stderr. Não são novos before nem falhas atuais presumidas.
Primeira asserção histórica: `campaign measured rendered source skills/forge-task/SKILL.md`.
Esperado histórico `5f01959c4599f48597551162ae2dd3391159fd14e132b156d428a2b112294637`; observado histórico `cab6654fddd9af22c400c0c6d146481ebb55f9a5ebc4bbbe66e6c7bf6be1f43b`.
Atribuição histórica qualificada: a primeira falha veio da evolução de skills/forge-task/SKILL.md por #446, já registrada no contexto da S02 e absorvida por issues-442-446 antes da base4606. Não foi causada por S03. A row publicada issues442446Layer.rendered[skills::skills/forge-task/SKILL.md] projeta after b79906fb446afbf08c3e6fe42802060025d75e9b6a7ddac8ab505bfa3d8937c5 para before 5f01959c4599f48597551162ae2dd3391159fd14e132b156d428a2b112294637; o after coincide com a medição atual. O renderer copia a fonte, sem incorporar módulos shared nessa skill. Por isso forge-task não tem nova row no delta440.
Atribuição das diferenças atuais da milestone: S01/T02–T03 altera as costuras protegidas; S01/T04 e S02/T07 alteram o contrato bidirecional; S02/T01–T06 altera recuperação, custódia e resultado; S02/T07 altera as duas skills forge-auto/forge-next (as únicas duas rows rendered novas) e os procedimentos; S03/T01 altera CI/verificador; S03/T02–T03 adiciona gravação/docs/harness; S03/T04 altera somente os requires e os cinco arquivos já preservados. A tabela por fonte abaixo aponta os writes reais de cada task.
As primeiras asserções podem mascarar falhas posteriores: nenhuma equivalência de execução atual é inferida. O after completo fica a cargo do adaptador do owner após o join.

| Suíte | Antes observado | Primeira asserção / superfície | Atribuição estática | Digest histórico | Depois atual |
|---|---|---|---|---|---|
| `forge-ci-latency-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-claude-renderer.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `474e816338254dbf2e416c3615fca770d7cf9d02e19acc4e0801cb47709e3fac` | PENDENTE: verify do owner |
| `forge-communication-surfaces.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `316cfaa37548aa6e53ddb11efa4ee309a25507b1f8b3c9fb976018d60efe80c1` | PENDENTE: verify do owner |
| `forge-incomplete-resume-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issue-399-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issue-401-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issue-407-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issue-414-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issue-416-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issue-418-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issue-439-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issue-campaign-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issues-403-404-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issues-405-406-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issues-410-413-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issues-420-424-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issues-429-432-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |
| `forge-issues-434-436-distribution.test.js` | histórica exit 1 | campaign measured rendered source skills/forge-task/SKILL.md | #446 upstream absorvido; deltas S01–S03 por fonte abaixo | `b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1` | PENDENTE: verify do owner |

## Qualificação upstream e 24 migrações

As 24 fontes before foram medidas contra os hashes do pacote e os bytes exatos da base4606. Cada after difere somente no require de issue-448 para issue-440; nenhuma asserção é removida.
Os 24 consumidores têm evidência local upstream `SUCCESSOR-CHECKS.json`, exit 0, joined/active_processes 0. As seis adições upstream não são contadas como old18.
CI upstream histórico: run44971929305, HEAD `fa75d68293654843629facedfb113e79de56d13d`, e run44972867644, master `4606de1ecac3ddee7bc957d9a8dea3207023d5b5`, ambos success49/49; isso não é o CI atual da milestone.
A cadeia atual preserva a exportação de todos os predecessores, inclusive os validadores da primeira asserção. Antes/depois de cada require está em files; projeção de todo input alterado é medida e o teste exerce validate e validate414Snapshot.

| Consumidor | SHA-256 before | SHA-256 after |
|---|---|---|
| `scripts/forge-ci-latency-distribution.test.js` | `e3592d3137e83189dfa4c4e63d4915f7cfb5862915e86f840303e4dc31721ad1` | `78e50809ae79e78a4038bf8f4463dbc4f788f51f97c3086e0af1015ca14b4003` |
| `scripts/forge-claude-renderer.test.js` | `043bbe8a3d0fe3c60c23bf2b45576fbf2998087362a17ad0dbbc13c75beac3d4` | `5a3ed5cc5068ddd243430695eeb95de90ef295a10f6126be919ef07e19a9b13e` |
| `scripts/forge-communication-surfaces.test.js` | `fcfddae2bd0ccf71fd77db5d90593092dd3a947878eb935a8f3ad221a314650c` | `0c45ca12d192cae5796af0ebb5df4eebabb948843d1d9cb1c0c364588acb155f` |
| `scripts/forge-dispatch-source-guard.test.js` | `284d306527682c9a3c371729e88d4a276458d1d4eab53579ea381141aafbcd9c` | `4a2529ff3297b70a858307c0d90c599a162d01d907994d3d2b289cd7a6de8c5c` |
| `scripts/forge-incomplete-resume-distribution.test.js` | `c572dfd271c89e8617bd4089481cec08d2f521e7679c2fa4978d2dbe2600c91b` | `9f09343e43b8ed5dcc3abe4f3ef57dae90337c65e6d8f9525e9b619208db84b5` |
| `scripts/forge-issue-399-distribution.test.js` | `7a393e0957773bb7b6637d69c24e339dd6db7b518924fb24c0574e869000805d` | `822f32210bde63e2efe6e52508442e641204155c5c4b0dd7f1681178a7b32625` |
| `scripts/forge-issue-401-distribution.test.js` | `21181ddbd04f1502f85a1110c48a08f4f77b771107042a068c6960bc1515531b` | `74334d05abff5ad0e1fb28f6dbeaed35ad70b5b2489b5994086a97a945cfcb54` |
| `scripts/forge-issue-407-distribution.test.js` | `3809dbe67146517bc004252237e9b97e2e71ce9d1001ca5c3c62062a5f80f7e5` | `144b8dfc42eb4ef7287afa97dbfd85cb73a51726f74dba9ac1ea6ea0310ec453` |
| `scripts/forge-issue-414-distribution.test.js` | `b5ee40f63053a7f9a19b8977396b0ff16aadbf39a1368af8a093069159bdb31a` | `f2d118db6a2ca6e84b396ac0647d79ea74695e4b149d4f8d5fe8dfb500996a83` |
| `scripts/forge-issue-416-distribution.test.js` | `bf670c351ff140858851f0948c8a7917e488655fbcae38a1d0e10a97a11914e2` | `8ed88d82c94ee2b1f3c9cdf190787f1e41cf8ca2c3e49d48a8e70595a55597a8` |
| `scripts/forge-issue-418-distribution.test.js` | `82b1bd245605cee525fe88fc03d0386457e1b41c6ff74cdc8b842da5bb36fa31` | `0ebcdf34f3c8a32d04dffd2fc12dbd78efc9a5e1a477463a5cf25a18f68ca933` |
| `scripts/forge-issue-439-distribution.test.js` | `686898678a5daddea1ec347039e73273beb90bd61bd6640e7af1ad2683a5d959` | `7169feea2dbd14d86a5ee88b238c150486e771280fcbba7827c7eb0453baa8ab` |
| `scripts/forge-issue-448-distribution.test.js` | `653ddbeea6024bb7ed3465e1f369f3853ef8b427c9fa4522a4483a8e6b35fe52` | `90068c74d129d1ae8b5afd3086694f1e0e39e7c31b002cf813b320eb529dba44` |
| `scripts/forge-issue-campaign-distribution.test.js` | `983c7aa1d50d967e03de9be0544992c6edf13312de4816082a2db72c1c6de894` | `040f39f39a2eb8991374226aff35aa9f98fa90b855b5109fc5450789ae2c11b0` |
| `scripts/forge-issues-403-404-distribution.test.js` | `0977cfd388c02e5248d2a0fece4e04838c91c19ef5143f4faafae59143b13505` | `8b273725632041aae782d4167f76efc39ff64feff9d0cd4dc6328dffc7085de8` |
| `scripts/forge-issues-403-407-integration.test.js` | `cd55dffb7eaeaae17e035117e6972445bba5fe93fbfd9a5095d98d713c5e2b22` | `50dd5ade269d0519bdecb11cf9649c78f2843a8a8da1a2ef016a381e2d8f1f9c` |
| `scripts/forge-issues-405-406-distribution.test.js` | `6a9f7f0661a77b252f66d47a72e2349b4112868cad7a980c4647779e30fb715f` | `549c5d463580ae15856fa76cdde6086ffbec7616b17e065d23eaddbd1e3dd07d` |
| `scripts/forge-issues-410-413-distribution.test.js` | `26e3a4e656882b6bcfee66093e35d822c62dcda9d67566bc4a2e5339f33de492` | `e17a52fbf1b3589695bcc027381bf5c642323a78537d04febf1d67e271a443c5` |
| `scripts/forge-issues-414-418-integration.test.js` | `37f0a229a1b4c7ae7f9459a5c8d12bed90f875583099d0966b6b7f28896fda2c` | `2144fd285fdb71ac7f602338d7b07460bdf2750ecad32cc46b14813fee7bfa26` |
| `scripts/forge-issues-420-424-distribution.test.js` | `6af9b1120cc7ea60189e6082bd81c466ad62e25fd4d7b1b77541d34c2702e358` | `fb516311f71ee129ba6d198cb3f9dbb9464cb98399c7020ebc41702a8f443687` |
| `scripts/forge-issues-429-432-distribution.test.js` | `ad83fdb510447f8732f6b3ea6736a6e3584159d7ed0dde1f0fe777d3c66ab93a` | `12e1b531ab8feb9892dae638d07bc80f742af0a4ad8d7b46de4be11b6d1d2091` |
| `scripts/forge-issues-434-436-distribution.test.js` | `e6db25506ce658198466c5e5a42f2c2b75d4b3e95fced3b2fdb198c3f4cd86e6` | `7e94ccbc011bf543c44d05d3896d0c9172e1715f469c57c5d1c4531314ddf6d9` |
| `scripts/forge-issues-442-446-distribution.test.js` | `902276afee321088d13dcc7e7883f0948a70df1a62248f01a6bfc3704600428f` | `3abd7662e4dcd99688e3dcbf1d09339f6f1aa55ff67be59286cf5f5633826847` |
| `scripts/forge-project-context.test.js` | `91cca3366ee880fcbf849e9d4aa074c9cdbc78a0694e2fb0b95884c3744b7959` | `27e246d21cd3d7922b99dddaa580594687f16736588214e89bd6f2efa77fddad` |

## Atribuição das fontes por task

Esta lista vem dos writes dos planos; indica responsabilidade estática, sem converter plano em evidência de execução. As linhas fix-s02 são qualificadas por S02-REVIEW.md, pelo cabeçalho do teste review-fix e pelo inventário preservado s02-grouped-fix-directed-before.json. R3 permaneceu adiado; não é incorporado por esta camada.

| Fonte alterada | Task(s) declaradas |
|---|---|
| `.github/workflows/ci.yml` | S03/T01 |
| `CHANGELOG.md` | S01/T04, S02/T07, S03/T04 |
| `docs/issue-440/canonical-result-consumers.md` | S02/T05 |
| `docs/issue-440/e2e-harness.md` | S03/T03 |
| `docs/issue-440/managed-surfaces.md` | S01/T01 |
| `docs/issue-440/recovery-abandon.md` | S02/T07 |
| `docs/issue-440/route-matrix.md` | S03/T04 |
| `docs/issue-440/windows-evidence.md` | S03/T02 |
| `scripts/fixtures/issue-440/delta-cases.json` | S01/T01 |
| `scripts/fixtures/issue-440/distribution-delta.json` | S03/T04 |
| `scripts/fixtures/issue-440/distribution.cjs` | S03/T04 |
| `scripts/fixtures/issue-440/DISTRIBUTION.md` | S03/T04 |
| `scripts/fixtures/issue-440/e2e-mock/manifest.json` | S03/T01 |
| `scripts/fixtures/issue-440/e2e-mock/README.md` | S03/T01 |
| `scripts/fixtures/issue-440/e2e-mock/recording.jsonl` | S03/T01 |
| `scripts/fixtures/issue-440/e2e/manifest.json` | S03/T02 |
| `scripts/fixtures/issue-440/e2e/README.md` | S03/T02 |
| `scripts/fixtures/issue-440/e2e/recording.jsonl` | S03/T02 |
| `scripts/fixtures/issue-440/README.md` | S01/T01 |
| `scripts/fixtures/issue-440/surface-census.json` | S01/T01 |
| `scripts/fixtures/issue-440/workflow-layer.json` | S03/T01 |
| `scripts/forge-attempt-abandon.js` | S02/T04 |
| `scripts/forge-attempt-abandon.test.js` | S02/T04 |
| `scripts/forge-attempt-recovery.js` | S02/T06 |
| `scripts/forge-ci-latency-distribution.test.js` | S03/T04 |
| `scripts/forge-ci-parallel.js` | S03/T01 |
| `scripts/forge-ci-parallel.test.js` | S03/T01 |
| `scripts/forge-ci-workflow.test.js` | S03/T01 |
| `scripts/forge-claude-renderer.test.js` | S03/T04 |
| `scripts/forge-claude-sidecar.js` | S02/fix-s02 (R1/R2/R4/R5) |
| `scripts/forge-communication-surfaces.test.js` | S03/T04 |
| `scripts/forge-dispatch-source-guard.js` | S03/T04 |
| `scripts/forge-dispatch-source-guard.test.js` | S03/T04 |
| `scripts/forge-e2e-evidence.js` | S03/T01 |
| `scripts/forge-e2e-evidence.test.js` | S03/T01 |
| `scripts/forge-incomplete-resume-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-399-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-401-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-407-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-414-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-416-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-418-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-439-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-440-attribution.test.js` | S01/T02 |
| `scripts/forge-issue-440-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-440-docs.test.js` | S02/T07, S03/T04 |
| `scripts/forge-issue-440-e2e.test.js` | S03/T03 |
| `scripts/forge-issue-440-recovery.test.js` | S02/T06 |
| `scripts/forge-issue-440-result.test.js` | S02/T05 |
| `scripts/forge-issue-440-review-fix.test.js` | S02/fix-s02 (R1/R2/R4/R5) |
| `scripts/forge-issue-440-surfaces.test.js` | S01/T03 |
| `scripts/forge-issue-448-distribution.test.js` | S03/T04 |
| `scripts/forge-issue-campaign-distribution.test.js` | S03/T04 |
| `scripts/forge-issues-403-404-distribution.test.js` | S03/T04 |
| `scripts/forge-issues-403-407-integration.test.js` | S03/T04 |
| `scripts/forge-issues-405-406-distribution.test.js` | S03/T04 |
| `scripts/forge-issues-410-413-distribution.test.js` | S03/T04 |
| `scripts/forge-issues-414-418-integration.test.js` | S03/T04 |
| `scripts/forge-issues-420-424-distribution.test.js` | S03/T04 |
| `scripts/forge-issues-429-432-distribution.test.js` | S03/T04 |
| `scripts/forge-issues-434-436-distribution.test.js` | S03/T04 |
| `scripts/forge-issues-442-446-distribution.test.js` | S03/T04 |
| `scripts/forge-managed-attribution.js` | S01/T02 |
| `scripts/forge-managed-surfaces.js` | S01/T01 |
| `scripts/forge-managed-surfaces.test.js` | S01/T01 |
| `scripts/forge-milestone-time-chain.test.js` | S01/T04, S02/T07, S03/T04 |
| `scripts/forge-native-invocation.test.js` | S02/T05 |
| `scripts/forge-process-tree.js` | S02/T02, S02/fix-s02 (R1/R2/R4/R5) |
| `scripts/forge-process-tree.test.js` | S02/T02 |
| `scripts/forge-project-context.test.js` | S03/T04 |
| `scripts/forge-protected-owner-activity.js` | S01/T02, S02/T02 |
| `scripts/forge-recovery-transition.js` | S02/T02 |
| `scripts/forge-release-policy.js` | S03/T01 |
| `scripts/forge-replay-refusal.js` | S02/T01 |
| `scripts/forge-replay-refusal.test.js` | S02/T01 |
| `scripts/forge-review-policy-distribution.test.js` | S01/T04, S02/T07, S03/T04 |
| `scripts/forge-surgical-reset-backup.test.js` | S02/T03 |
| `scripts/forge-surgical-reset.js` | S02/T03 |
| `scripts/forge-task-execution.js` | S01/T02 |
| `scripts/forge-unit-controller.js` | S02/T06 |
| `scripts/forge-unit-sidecar.js` | S01/T03, S02/T05 |
| `shared/forge-bidirectional-sidecar.md` | S01/T04, S02/T07 |
| `shared/forge-dispatch.md` | S02/T07 |
| `shared/forge-procedure-recovery.md` | S02/T07 |
| `shared/forge-procedures.json` | S02/T07 |
| `skills/forge-auto/SKILL.md` | S02/T07 |
| `skills/forge-next/SKILL.md` | S02/T07 |

## Verificação e estados independentes

O novo teste cobre fontes de S01/S02/S03, workflow/verificador/abandono, provenance, preimagens, fixture histórica, requires exatos, matriz e uma travessia do predecessor.
Os seis comandos after do plano serão executados uma vez pelo owner após o writer encerrar. Até essa observação, a tabela after fica PENDENTE e não alega testes aprovados.
Nenhuma execução local completa, native198, A7 ou smoke adicional é feita por esta task.
GF1: seis suítes adiadas e logs integrais — PENDENTE no CI final.
GF2: custódia Windows remota — PENDENTE no CI final.
GF3: 198 observações nativas integrais — PENDENTE no CI final.
GF4: A7 contra baseline master — PENDENTE no CI final.
GF5: run-tests completo nos três SOs — PENDENTE no CI final.
GF6: revisão independente e correções — PENDENTE.
GF7: complete-milestone, merge, release e atualização — PENDENTE.
Instalação e aceite humano exigem provas próprias; UAT manual permanece pendente.

## Delta técnico medido após a primeira verificação

As 24 migrações mantêm todas as asserções; três consumidores têm adaptadores explícitos para projeções de samples e parity. O registro corrente corrige exatamente duas fingerprints agent de prosa alterada por S01. O registro historico fica intacto; identity aceita somente duas tuplas exatas path/kind/fingerprint medidas e preserva os fingerprints reais de descoberta. Nenhuma dependencia historica e virtualizada.
São duas citações prospectivas forge-next, duas rows de registry e 39 folhas de trace: 23 manifest_sha256 e16 fingerprints derivadas. Nenhum fixture histórico foi regravado.
- /entries/2/supporting/partial/after: fe72edc9eedccfac3faa77dc9a619d0a0b98ee6fed052265dfd2700740a7d9e1 → b0eabff8a200b0cef4a52ccfea74e693bf5c2a4dd3b885863cd6597f207f0a59
- /entries/6/supporting/partial/after: fe72edc9eedccfac3faa77dc9a619d0a0b98ee6fed052265dfd2700740a7d9e1 → b0eabff8a200b0cef4a52ccfea74e693bf5c2a4dd3b885863cd6597f207f0a59
- Registry shared-forge-dispatch-md-agent-aa1cbc5a83f5: sha256:aa1cbc5a83f5f4a6fec660ffad22bdf6956e736a5cd9d35abb653c161284d9ff → sha256:41aa3f74b409e3327fdbfcd920185fcc778a6d096103aada444752b2953de7bf
- Registry shared-forge-dispatch-md-agent-f456f34eae4e: sha256:f456f34eae4e490c102be26ea31dfdd76a35b85a13b43e8d08d25393ec90222e → sha256:923d551152cc1c4ed10f7cd1d61cb5d0978eac644183a53003aef105c80b59dd

forge-next sample attribution: owner baseline 22bddaebd4367ce2cc8729cfdc7f14131de2c155be62226c3d24c45f626ed2c5; measured raw before fe72edc9eedccfac3faa77dc9a619d0a0b98ee6fed052265dfd2700740a7d9e1; raw after b0eabff8a200b0cef4a52ccfea74e693bf5c2a4dd3b885863cd6597f207f0a59; attributed before 47c80adfef2ce723846c2ea58150a14c874e20a1cfcf3107ad480450938f4791; attributed after 32f8ea9b706854f886f1f16a7dcbc434515e982385175626b0e5a2f46450c364. Both current raw and attributed positive sample states remain documented.

Technical amendment:24 consumers comprise21 exact require-only migrations and3 explicitly pinned projection adapters. The source-guard sample reader now uses currentSamples at its direct citation check; every original assertion and historical sample byte remains intact.
