# Histórico preservado — parte 3

Evidência da entrada anterior, não é política vigente nem fila atual. Consulte ../project-policy.md e contratos atuais antes de agir. Leia somente quando necessário.

---

`````text
thinking: adaptive        # adaptive | disabled — extended thinking (opus only)
effort: medium            # low | medium | high | max — intensidade de processamento
tools: Read, Write, ...   # tools disponíveis
```

`thinking` e `effort` são forward-compatible: Claude Code os lê do frontmatter quando suportados. O orquestrador também injeta `effort:` e `thinking:` no header do prompt do worker como fallback.

## Decisões de arquitetura

O registro completo (histórico, append-only) vive em `docs/DECISIONS-LOG.md` — cada entrada
narra o problema, a decisão e a prova. Este arquivo carrega apenas os **invariantes vigentes**
que uma sessão precisa para não quebrar o sistema. Ao fechar trabalho que cria um invariante
novo: entrada completa no log; uma linha aqui só se virar regra operacional viva.

- **Orquestrador no contexto principal** — o dispatch loop roda via commands/skills no
  contexto principal (só ele tem a tool `Agent`); agentes nunca despacham agentes.
- **Isolamento e recuperação** — unidades roteadas preservam contexto, claims e
  identidade. Recusa bloqueia o despacho, não investigação ou recuperação válida.
  Ações diretas elegíveis e manutenção do Forge expressamente autorizada seguem
  shared/forge-direct-actions.md; não falsificar receipt nem substituir rota silenciosamente.
- **Roteamento por tier; model vai como alias** — `{engine, model, tier, effort}` saem de
  `scripts/forge-dispatch-resolve.js`; `Agent(model:)` recebe o alias curto de
  o adaptador efetivo quando aplicável. Modelo não mapeado exige diagnóstico/rota
  compatível; nunca omitir `model` para herdar um default.
- **Guard de thinking** — `claude-fable-5` rejeita `thinking: disabled` explícito (HTTP 400);
  `claude-opus-5` rejeita `disabled` com effort `xhigh|max`. Fonte única:
  `forge-dispatch-resolve.js → thinking_header`.
- **Review dialético per-slice** — challenger × advocate no orquestrador, antes de
  `complete-slice`; advisory, nunca bloqueia. O `forge-completer` nunca integra branch —
  a integração é do operador. Spec: `shared/forge-review.md`.
- **`.gsd/STATE.md` da raiz é projeção gerada** (`scripts/forge-dashboard.js`, sob lock);
  o estado por-run vive em `M###-STATE.md` via `scripts/forge-state.js`.
- **IDs timestamp** — `M-<ts>-<slug>` / `T-<ts>-<slug>`; toda lógica de ID centralizada em
  `scripts/forge-ids.js`. IDs legados `M###`/`TASK-###` valem só para leitura.
- **Multi-conta = relaunch, nunca hot-swap** — token injetado via `ANTHROPIC_AUTH_TOKEN`
  (constante `TOKEN_ENV` em `scripts/forge-accounts.js`); uma sessão não troca a própria conta.
- **Prova de propriedade nas projeções** — marcador `forge-source` (Markdown/JS) ou digest no
  manifesto (JSON); destino sem prova é do operador e vira conflito **nomeado**, nunca
  sobrescrita silenciosa.
- **Worker truncado tem ramo próprio (Layer 0)** — bloco `---GSD-WORKER-RESULT---` ausente é
  classificado por `scripts/forge-worker-result.js`; recuperação lê o que o worker escreveu,
  nunca inventa.
- **Contrato de roteamento projetado** — `scripts/forge-instructions.js` mantém o bloco
  `forge:routing-contract` no fim deste arquivo; nunca editar dentro dos marcadores à mão.


## Convenções de código

- **Linguagem dos artefatos:** Markdown com frontmatter YAML
- **Linguagem da UI/mensagens:** Português (pt-BR)
- **Linguagem do código/scripts:** Inglês
- **Commits:** Conventional commits em inglês (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
- **Vínculo PR → issue:** `Closes #N` **só** quando o merge da PR de fato resolve a issue — aí ela
  fecha sozinha e ninguém precisa lembrar. `Refs #N` quando a PR **avança** a issue sem resolvê-la:
  entregou o instrumento mas não a medição, entregou o código mas a decisão de política segue
  aberta, fechou 4 de 6 gaps. A escolha errada custa nos dois sentidos e os dois já aconteceram
  aqui: `Refs` numa PR que resolvia deixou a #104 aberta sobre trabalho entregue (fechada à mão
  depois, por lembrança e não por desenho); `Closes` numa PR que só avança descartaria a issue que
  é **dona da decisão pendente** — a #120 (política do reaper) e a #82 (veredito do
  `writableRoots`) existem hoje só para isso. Na dúvida, `Refs` e fechar à mão: perder a issue é
  irreversível, fechar depois não.
- **Naming:** Prefixo `forge-` em todos os agentes, comandos e skills
- **Instalação:** Destino `~/.claude/{agents,commands,skills}/` — sempre via `install.sh` ou `install.ps1`
- **Agentes:** Frontmatter com `name`, `description`, `model`, `tools`
- **Commands:** Frontmatter com `description`, `allowed-tools`
- **Skills:** Diretório com `SKILL.md` contendo instruções

## Ao editar este projeto

- **`.gsd/` NUNCA é commitado neste repo** — este projeto É o próprio agente Forge, então `.gsd/` aqui é dogfood interno (STATE, milestones, AUTO-MEMORY, events, etc. do agente rodando sobre si mesmo), não entrega. Executores, completer e qualquer outro worker que rodar `git add` / `git commit` aqui devem **explicitamente excluir `.gsd/`** do stage (ex.: `git add <arquivo-específico>` em vez de `git add -A`). A regra vale para o repo `forge-agent/` apenas — em projetos-usuário que **consomem** o agente, `.gsd/` pode ser commitado normalmente conforme as prefs do projeto.
- **Nunca edite install.ps1 com strings contendo `\f`** — usar hex escape ou verificar bytes após edição
- **Agentes não acessam tool Agent** — apenas o orquestrador (commands) despacha agentes
- **Workers retornam `---GSD-WORKER-RESULT---`** — formato estruturado que o orquestrador parseia
- **`.gsd/STATE.md` da raiz é projeção gerada** por `scripts/forge-dashboard.js` sob lock (marcada com `<!-- AUTO-GENERATED -->`) — ninguém escreve nele à mão. O estado durável de uma run vive em `.gsd/milestones/<id>/<id>-STATE.md`, escrito só pelo orquestrador daquela run e pelo `forge-completer`, via `scripts/forge-state.js`. Schema canônico: `shared/forge-state.md`.
- **DECISIONS.md é overview global** — append-only, nunca editar ou remover linhas existentes. Não é mais injetado em workers (exceto discuss-milestone como referência de milestones anteriores). Decisões por fase vivem na seção `## Decisions` do CONTEXT.md de cada fase.
- **Testes de instalador:** Rodar com `--dry-run` antes de mudar lógica de cópia
- **Novos comandos:** Seguir padrão dos existentes com bootstrap guard + load context
- **Novos agentes:** Adicionar ao install.sh/install.ps1 glob pattern (já coberto por `forge*.md`)

`````
