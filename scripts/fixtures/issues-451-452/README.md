# Distribuicao medida — issues #451 e #452

Camada aditiva sobre a issue440 publicada. Base0fa00e3; doze fontes do lote,24 migrações somente de require e um adapter explícito para o teste histórico440. Três leitores de changelog históricos usam a preimagem exata; nenhuma assertion histórica foi removida.

A vista440 preserva os95rows, seus consumidores e os próprios alvos negativos. A nova validação faz uma delegação completa e um censo atual independente. Todos os215fixtures publicados permanecem byte a byte iguais; código desconhecido não é projetado para um baseline válido.

CJS/delta/teste próprio ficam fora da própria medição para evitar circularidade; este README é medido como arquivo novo. A suite focada e a CI constituem execuções separadas e seus resultados não estão antecipados aqui.

O allowlist de preferências inclui somente o novo arquivo de proveniência histórica. A projeção do smoke reconhece apenas os bytes atuais medidos e preserva a recusa de código desconhecido.
