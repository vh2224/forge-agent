# Fixtures do coletor de CI

Todos os arquivos deste diretório são inteiramente sintéticos e públicos.
Não contêm logs copiados de CI, contas, tokens ou dados de usuários.
As datas, IDs, hashes e nomes de máquinas são dados inventados para testes.
Os arquivos de texto usam LF; os testes constroem CRLF em memória.

## windows-shard-1.log

Log inventado no formato bruto do Actions, com BOM e timestamps ISO UTC.
Contém ANSI com ESC e sem ESC, além de grupos de provisionador e imagem.
Só a versão do grupo Runner Image deve ser usada como versão da imagem.
O job pertence à política atual e identifica a plataforma win32.
Três suítes aprovadas somam 3330 ms; as durações individuais são inteiras.
Há Node, toolcache hit, actions/cache hit, checkout e plano de shard válido.
O resumo declara três execuções aprovadas e o baseline corresponde.

## windows-shard-2.log

Outro log inventado: duas suítes executadas, uma PASS e uma FAIL.
A saída capturada contém uma linha-isca PASS com o mesmo nome de suíte.
A duplicata e a divergência de contagens tornam todas as observações ambíguas.
Nenhuma duração deste log ambíguo pode contribuir para pesos.
O detalhe da falha usa exit 1; a variante signal é construída no teste.

## local-run.log

Execução local inventada, sem timestamps, identidade de job ou imagem.
Contém duas suítes aprovadas; fila, plataforma e cache ficam indisponíveis.
Mesmo com --local-log e plataforma explícita, não pode contribuir para pesos.

## jobs-page.json

Página inventada da API: jobs de teste, offline, alias, app e desconhecido.
Inclui steps nomeados, timestamps inválidos, ausentes e fora de ordem.
Sentinelas de actor, título, URLs e corpos nunca são copiadas ao relatório.
O alias não fornece plataforma na célula da política: não inferir Windows.

## suite-profile.json

Gerado por buildSuiteProfile com condição sintética e schema fechado v1.
Exercita conversão de perfil estruturado, PASS, FAIL, metadados e timestamps.
Sua proveniência é sintética; não integra o perfil observado versionado.
