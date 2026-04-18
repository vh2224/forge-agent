# Risk Radar: S03 — Goal-backward verifier (3-level)

**Assessed:** 2026-04-16
**Overall risk:** HIGH

Regex-heavy control path (precedente MEM038 já provou que ordem importa), 3-level correctness compõe falsos-positivos, orçamento de 2s em Windows com Defender é apertado, e o Wired walker em import chains JS/TS é inerentemente aproximativo. Todos os fatores isolados são tratáveis — combinados exigem research-slice antes de planejar e calibração contra baseline real do próprio forge-agent.

---

## Blockers (fix before executing)

- **Schema de `must_haves` não congelado até S01 fechar** → S03 plan-slice NÃO deve começar enquanto S01 não estiver `[x]` no ROADMAP. O verifier lê `must_haves.artifacts[].path`, `min_lines`, `stub_patterns?`, `key_links[]` — qualquer mudança de shape força retrabalho no verifier. Mitigação: orquestrador respeita `depends:[S01, S02]` no ROADMAP (já está lá); não pular ordem com `/forge-next` manual.

- **`evidence-{unitId}.jsonl` format dependency** → se o Wired level consultar o evidence log como sinal corroborativo (ROADMAP linha 94 marca isso como "optional; primary signal is static import-chain scan"), mudanças no schema JSONL do S02 propagam pro S03. Mitigação: decidir **na research-slice de S03** se Wired level usa evidence log OU apenas scan estático. Se usar, congelar keys JSONL antes do plan-slice. Se não usar, documentar e remover a dependência ótica.

## Warnings (monitor during execution)

- **Stub-detection false positives em código legítimo** — `return null` aparece em functional setters/guards válidos; `onClick={() => {}}` pode ser no-op intencional (placeholder de feature flag, render opcional). Mitigação: cada match emite `{regex_name, line_number, matched_text}` no S##-VERIFICATION.md — humano consegue triar. Prover override via `must_haves.artifacts[].stub_patterns: []` (lista vazia desliga detecção para aquele artefato).

- **Export detection em TS/ESM é não-trivial** — `export { x } from './y'` (re-export), `export * from './index'` (barrel), `export default` + named mix, `module.exports = require('./z')` (CJS chain). Regex ingênuo erra em todos esses. Mitigação: research-slice deve medir padrão real em `scripts/` e `skills/` do forge-agent (baseline known-good). Documentar padrões cobertos vs not-supported no S03-SUMMARY. NÃO prometer 100% cobertura.

- **Performance budget ≤2s em Windows é apertado** — Windows Defender scanning + NTFS stat costs + antivírus corporativo podem adicionar 50-200ms por file read. 10 artefatos × depth-2 walker = 20-50 files lidos = 1-10s no pior caso. Mitigação: (a) medir antes em Windows real, não Mac/Linux; (b) single-file read cache dentro da invocação do verifier; (c) short-circuit — se Exists falha, não rodar Substantive; se Substantive falha, não rodar Wired; (d) Wired em batch (todos os artifacts consomem um único pass sobre os imports).

- **Regex precedence order (MEM038 precedent)** — ordem de avaliação dos stub patterns altera veredito quando vocabulários overlap (`return <div/>` e `return null` ambos matcham uma função que retorna `return null; // <div/> TODO`). Mitigação: documentar ordem canônica explicitamente no topo do `scripts/forge-verifier.js`; incluir teste que flipa se ordem for alterada (análogo ao que T02 de M002/S01 fez pro error classifier).

- **Repositórios não-JS/TS** — Wired level depende de static import parsing JS/TS. Em repos Python/Go/Rust, walker não tem nada a escanear. Mitigação: detectar extensão dos arquivos em `must_haves.artifacts[].path`; se nenhum `.js|.ts|.tsx|.jsx|.mjs|.cjs`, emitir `wired: skipped` com reason `non_js_ts_repo` — não falhar, não fingir passar.

- **Barrel file depth limit** — depth-2 walker perde conexões legítimas através de barrels encadeados (`a.ts → index.ts → b.ts → c.ts` = depth 3 na cadeia real). Mitigação: aceitar como limitação conhecida documentada. Emitir `wired: approximate` com `reason: depth_limit` quando walker atinge cap sem resolver. Não é falha — é sinal de que humano deve olhar.

- **Legacy plan detection predicate** — C13 (backward-compat) exige que verifier detecte plano legacy e emita `skipped: legacy_schema` sem crashar. S01 introduz o predicate; S03 reusa. Mitigação: garantir que o helper de detecção seja importável do S01 (shared utility), não duplicado no verifier.

- **Performance measurement viés** — "≤2s" medido em cache quente mente; medir em cold cache (primeira rodada após boot) é mais próximo do uso real (complete-slice roda uma vez por slice, não é loop quente). Mitigação: research-slice deve rodar 3 medições: cold, warm, hot — reportar todos os três no SUMMARY; orçamento C8 assumido como "hot" salvo nota contrária.

## Executor notes

- **research-slice OBRIGATÓRIA antes de plan-slice de S03.** O ROADMAP linha 128 sugere e isto confirma. Research-slice deve:
  - Auditar padrões reais de export/import em `scripts/*.js` e `skills/*/SKILL.md` (baseline known-good)
  - Propor stub regex list calibrada com contraexemplos reais do repo
  - Decidir formalmente se Wired usa evidence log (S02) ou apenas scan estático
  - Medir tempo de read em Windows real (3 files × 3 runs × cold/warm/hot)

- **Use Asset Map do CODING-STANDARDS** — "YAML frontmatter key-extract" (forge-verify.js linhas 420-466) reusar pra ler `must_haves` do PLAN. Não reimplementar YAML parsing.

- **CommonJS obrigatório** para `scripts/forge-verifier.js` — MEM017, consistente com todos os outros scripts. Sem `package.json` mudanças, sem ESM.

- **Path cross-platform** — `path.join`, `path.resolve`, `path.sep`. Nunca hardcode `/` ou `\`. Testar com `path.win32` se possível.

- **Short-circuit explícito** no código — não é "otimização prematura"; é orçamento de 2s. Document ordem: Exists → Substantive → Wired, e cada falha aborta níveis subsequentes pra o mesmo artifact.

- **Regex order deve ser explícita** — copiar o padrão do T02 de M002/S01 (error classifier): comentário no topo do módulo listando ordem canônica, teste que cobre cada precedência.

- **Não prometa 100%.** No S03-SUMMARY, documente explicitamente: stub-detection é heurística (não análise semântica), Wired é import-chain-scan aproximado (não call-graph real), perf budget assume hot cache. Isto é anti-alucinação aplicada ao próprio verifier — se ele mente sobre sua cobertura, estamos de volta à estaca zero.
