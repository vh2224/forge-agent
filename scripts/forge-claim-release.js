#!/usr/bin/env node
// forge-claim-release — decide, com evidência LIDA do VCS, se um claim ainda vale.
//
// ── Release é MEDIDO, nunca presumido ───────────────────────────────────────
//
// A S04 gravou o claim e nunca o liberou: o único contorno era
// `forge-write-claim.js --clear` na mão. Este módulo dá ao claim um fim de vida
// com prova. Um orquestrador que chama `--release` faz um PEDIDO; quando o
// commit não é observável o pedido é RECUSADO, a recusa é nomeada
// (`not-observable`) e NADA é gravado. Vale igual em git e em svn — a simetria
// é deliberada, não uma concessão ao SVN (resposta (d) do ROADMAP).
//
// ── Por que DUAS sondas, e por que a conjunção é o desenho ──────────────────
//
//   A — PRECISA (D16): existe, desde o baseline gravado, mudança commitada que
//       TOCA ≥ 1 dos paths reivindicados. Não basta a baseline da árvore ter
//       andado: `baseline_moved` é o fato cru (auditável), e
//       `baseline_advanced` é a sonda que governa.
//   B — os paths reivindicados saíram de voo: nenhum path do claim aparece em
//       `workingStatus(code_dir, {vcs})` com `kind ∈ IN_FLIGHT_KINDS`.
//
// Cada sonda SOZINHA libera errado, e em direções OPOSTAS:
//
//   * Só A libera um claim cujo worker NEM COMEÇOU a escrever quando outro
//     commit já tocou aqueles paths antes.
//   * Só B libera um claim cujo worker NEM COMEÇOU a escrever. Zero paths sujos
//     é indistinguível de "commitou tudo" quando ninguém olha o commit.
//
// ── Por que a sonda A precisa, e o que ela revoga (D16) ────────────────────
//
// A sonda A original era "a baseline da ÁRVORE andou" — propriedade da árvore,
// não do trabalho deste claim. Num claim-união (T01+T02) QUALQUER commit a
// satisfazia, inclusive um commit da T01 que não tocava os paths que a T02
// ainda ia escrever. A precisa faz a distinção certa: **o dono que commitou os
// paths que claimou libera; o que commitou outra coisa não.**
//
// D16 REVOGA a terceira condição `owner_active === false` que PR #110 tinha
// posto no degrau `released-committed`. Ela tornava o degrau INALCANÇÁVEL pelo
// gate real, por tesoura de duas lâminas MEDIDA nos dois sítios:
//   1. `collectRunClaims` (forge-claim-overlap.js) pula toda run com
//      `active !== true` como `run-inactive` ANTES de qualquer sonda;
//   2. `probeClaim` deriva `owner_active` de `isHolderRunActive`, que exige
//      `run.active === true`.
// Contraparte ativa ⇒ `owner_active === true` ⇒ nunca dispara; inativa ⇒ nunca
// sondada. Não existia estado que emitisse `claim-released:committed` — e o
// step `e-release` do `forge-auto` pede o release COM a run ainda ativa, então
// o claim só sairia por TTL depois da run morrer. Isso é over-block, a classe
// que esta milestone existe para fechar, reintroduzida um nível acima.
//
// O que D16 NÃO revoga: a não-persistência do veredito no RunRecord alheio
// enquanto o dono está ativo, que vive em `forge-claim-gate.js` e segue de pé.
//
// A precisão é MONOTÔNICA sobre a sonda antiga: todo estado que a precisa
// libera, a antiga também liberava. Nenhum caminho novo de liberação é criado.
//
// Afrouxar para uma sonda só é REGRESSÃO, não simplificação. A razão fica aqui,
// no cabeçalho, porque a suíte prova o par (cada sonda isolada NÃO libera) e um
// leitor futuro precisa saber que o par é o contrato, não redundância.
//
// ── Pergunta que não pôde ser feita MANTÉM o claim ──────────────────────────
//
// Sonda com `{ok:false}` (binário ausente, diretório sumido), `code_dir: null`,
// `vcs_baseline: null` ou vcs desconhecido → `held-probe-unavailable`, com o
// erro nomeado. NUNCA `released-*`. Mesma polaridade de D1/B2: um `null` honesto
// sobre-bloqueia, um palpite sub-bloqueia, e esta milestone escolhe o primeiro
// por decisão. Um release concedido sem prova é pior que um bloqueio a mais —
// ele devolve ao gate exatamente o buraco que o gate existe para fechar.
//
// ── TTL é REDE, nunca critério de posse (D2) ────────────────────────────────
//
// Um claim só expira quando AMBOS: (a) `now > at + ttl + grace`, com
// `DEFAULT_TTL_MS`/`DEFAULT_GRACE_MS` IMPORTADOS de `forge-unit-lease.js`; e
// (b) a run dona está INATIVA, pelo predicado `isHolderRunActive` REUSADO de
// `forge-filelock.js`. Uma run viva NUNCA perde o claim para o relógio. A idade
// sozinha não é evidência de nada: um worker legítimo de 40 minutos é
// byte-a-byte indistinguível de um worker morto, se só o relógio for olhado.
//
// `ttlMs`/`graceMs` são parâmetros de INJEÇÃO PARA TESTE (relógio determinístico),
// não knob de operador. S05 não introduz pref nova — knob inerte é proibido.
//
// ── Composição, nunca reimplementação ──────────────────────────────────────
//
//   VCS (git e svn)     forge-vcs.js  → baselineId / workingStatus / detectVcs
//   TTL/grace           forge-unit-lease.js → DEFAULT_TTL_MS / DEFAULT_GRACE_MS
//   run inativa         forge-filelock.js → isHolderRunActive (export aditivo)
//   persistência        forge-write-claim.js → readClaim / releaseClaim / isHeld
//   normalização        forge-parallelism.js → normalizePath
//
// NENHUM `execFileSync`/`spawnSync` de `git` ou `svn` neste módulo — toda
// interação com VCS passa pelo seam público, e a suíte prova a ausência por
// varredura do próprio fonte, com controle positivo.
//
// ── Fronteira de pureza ────────────────────────────────────────────────────
//
// `classifyRelease` é PURA (sem disco, sem git, sem relógio): recebe FATOS e
// devolve DECISÃO. `probeClaim` é a única função com I/O. A separação existe
// para que a precedência possa ser provada fronteira a fronteira com fatos
// sintéticos, sem fixture — e é asserida por teste.
//
// CLI:
//   node forge-claim-release.js --status  <run-id> [--code-dir <p>] [--vcs <v>] [--cwd <d>] [--json]
//   node forge-claim-release.js --release <run-id> [--code-dir <p>] [--vcs <v>] [--cwd <d>] [--json]
//
// Exit: 0 = AVALIADO (e "não liberado" é resultado de SUCESSO — o mecanismo é
// enforcing, silêncio nunca é consentimento), 1 = erro interno, 2 = invocação
// malformada. Mesma gramática de `forge-claim-gate.js`.

'use strict';

const fs = require('fs');
const path = require('path');

const vcsDefault = require('./forge-vcs.js');
const { DEFAULT_TTL_MS, DEFAULT_GRACE_MS } = require('./forge-unit-lease.js');
const { isHolderRunActive } = require('./forge-filelock.js');
const { readClaim, releaseClaim, isHeld } = require('./forge-write-claim.js');
const { normalizePath, claimPathMatches } = require('./forge-parallelism.js');
const runs = require('./forge-runs.js');

/**
 * Conjunto FECHADO de razões, com comentário por entrada. Cruzado nos DOIS
 * sentidos pela suíte (toda razão emitida está aqui; toda entrada é emitida por
 * ≥ 1 teste) — molde `CLAIM_SKIP_REASONS`/`GATE_CAUSES`.
 */
const CLAIM_RELEASE_REASONS = Object.freeze([
  // O claim JÁ carrega o envelope `released` (T01). Nada a medir e nada a
  // gravar: a decisão já foi tomada e persistida por alguém antes.
  'released-explicit',
  // As DUAS sondas satisfeitas: baseline avançou E nenhum path do claim está
  // em voo. Esta é a única razão que representa prova positiva de commit.
  'released-committed',
  // A rede do TTL (D2): janela `ttl + grace` vencida E run dona INATIVA. Nunca
  // por idade sozinha.
  'released-ttl-expired',
  // Alguma pergunta não pôde ser FEITA (code_dir ausente, vcs_baseline ausente,
  // vcs desconhecido, seam `{ok:false}`). Mantém o claim, com o erro nomeado.
  'held-probe-unavailable',
  // Perguntas feitas, respostas obtidas, prova AUSENTE: o trabalho não foi
  // commitado (ou só uma das duas sondas passou). O claim continua valendo.
  'held-uncommitted',
]);

/** Mecanismos aceitos por `releaseClaim` (T01), por razão liberadora. */
const MECHANISM_BY_REASON = Object.freeze({
  'released-explicit': 'explicit',
  'released-committed': 'committed',
  'released-ttl-expired': 'ttl-expired',
});

// ── Produção de fato ───────────────────────────────────────────────────────

/**
 * `{ ok, vcs, id, error }` — NUNCA lança. `code_dir` ausente, vcs desconhecido
 * ou seam em falha viram `{ ok: false }` com o erro NOMEADO, jamais um `id`
 * inventado nem um `false` silencioso.
 */
function measureBaseline(codeDir, opts = {}) {
  const seam = opts.vcsSeam || vcsDefault;
  if (typeof codeDir !== 'string' || codeDir === '') {
    return { ok: false, vcs: null, id: null, error: 'code-dir-absent' };
  }
  let vcs = opts.vcs;
  try {
    if (!vcs) vcs = seam.detectVcs(codeDir);
  } catch (e) {
    return { ok: false, vcs: null, id: null, error: `vcs-detect-failed:${e.message}` };
  }
  if (vcs !== 'git' && vcs !== 'svn') {
    return { ok: false, vcs: vcs || null, id: null, error: `vcs-unknown:${vcs === undefined ? 'undefined' : vcs}` };
  }
  try {
    const result = seam.baselineId(codeDir, { vcs });
    if (!result || !result.ok || typeof result.id !== 'string' || result.id === '') {
      return { ok: false, vcs, id: null, error: `baseline-failed:${(result && result.error) || 'sem id'}` };
    }
    return { ok: true, vcs, id: result.id, error: null };
  } catch (e) {
    return { ok: false, vcs, id: null, error: `baseline-threw:${e.message}` };
  }
}

/**
 * Um path do claim "cobre" um path do status quando são o mesmo path
 * normalizado, ou quando o path do claim é um diretório ancestral dele. As duas
 * pontas passam pelo `normalizePath` IMPORTADO — nunca uma segunda
 * normalização local (a terceira cópia é o defeito que os Standards proíbem).
 */
const covers = claimPathMatches;

/**
 * Sonda B: quais paths DO CLAIM ainda estão em voo. `kind ∈ {modified, added,
 * deleted, untracked}` é o conjunto que significa "escrito e não commitado".
 *
 * `untracked` entrou na revisão de S05 (R2). Ficava de fora, e a justificativa
 * antiga ("incluir faria todo `.gsd/` ignorado segurar claim para sempre")
 * media outra coisa: quem segura `.gsd/` é `ignored`, que continua FORA — e,
 * mais decisivo, as entradas já são filtradas por cobertura de path do claim
 * (`claimed.some(covers)`, abaixo), então só path REIVINDICADO pode segurar.
 * `forge-vcs.js:751,780` mostra que arquivo NOVO sai como `untracked` (git
 * `??`, svn `unversioned`) — ou seja, o output mais comum de um executor. Cego
 * para ele, a sonda B respondia `false` para trabalho não commitado e, com um
 * commit do VIZINHO avançando o baseline da árvore compartilhada (o cenário
 * originante desta milestone), a conjunção liberava um claim vivo. Incluí-lo
 * erra na direção SEGURA: `held`.
 */
const IN_FLIGHT_KINDS = Object.freeze(['modified', 'added', 'deleted', 'untracked']);

/**
 * Sonda A PRECISA (D16): os paths que mudaram DESDE o baseline gravado, lidos
 * pelo seam público — nunca por `git`/`svn` próprio.
 *
 * Duas funções do seam porque as duas perguntas são genuinamente diferentes no
 * VCS, e a escolha é MEDIDA, não estética:
 *
 *   git → `postChanges(dir, baselineId, {vcs:'git'})`, que é `diff
 *         --name-status <baseline>` (mais untracked). Ele inclui o working
 *         tree, mas isso não contamina a decisão: o degrau só dispara com
 *         `paths_in_flight === false`, ou seja, com os paths reivindicados
 *         comprovadamente limpos — nesse estado a interseção com os paths do
 *         claim é puramente COMMITADA.
 *   svn → `svnLogChangedPaths(dir, {fromRev, toRev})`. `postChanges` NÃO serve
 *         em svn: a implementação é derivada de `svn status`, cega ao
 *         baseline, então depois de um commit ela devolve vazio e o degrau
 *         ficaria estruturalmente inalcançável em svn — exatamente o
 *         over-block que D16 veio fechar.
 *
 * O log do svn devolve paths REPO-ABSOLUTOS (`/trunk/src/a.ts`) e a working
 * copy é um checkout de algum sub-caminho que este módulo não conhece (não há
 * `svn info` no seam). Por isso o casamento em svn aceita o sufixo com
 * fronteira de segmento, e a limitação fica NOMEADA aqui: ela pode casar um
 * homônimo em outro diretório do repositório. Isso continua estritamente mais
 * estreito que a sonda antiga (que casava QUALQUER commit em QUALQUER path),
 * então nunca é regressão — só precisão parcial.
 *
 * NUNCA lança: toda pergunta que não pôde ser feita volta `{ok:false}` com o
 * erro nomeado, e vira `held-probe-unavailable` lá em cima.
 */
function measureTouched(codeDir, vcs, baselineBefore, opts = {}) {
  const seam = opts.vcsSeam || vcsDefault;
  if (vcs === 'git') {
    let res;
    try { res = seam.postChanges(codeDir, baselineBefore, { vcs: 'git' }); }
    catch (e) { return { ok: false, paths: null, error: `post-changes-threw:${e.message}` }; }
    if (!res || !res.ok) {
      return { ok: false, paths: null, error: `post-changes-failed:${(res && res.error) || 'sem entries'}` };
    }
    const out = [];
    for (const entry of res.entries || []) {
      const p = normalizePath(entry.path);
      if (p !== '' && !out.includes(p)) out.push(p);
    }
    return { ok: true, paths: out, error: null };
  }
  if (vcs === 'svn') {
    // `svnversion` pode devolver `42`, `42M` ou `40:42` — o baseline é o MAIOR
    // número presente, isto é, o último. Um id que não carrega número nenhum é
    // pergunta impossível, nunca um `1` inventado.
    const m = /(\d+)\D*$/.exec(String(baselineBefore));
    if (!m) return { ok: false, paths: null, error: `svn-baseline-unparsable:${baselineBefore}` };
    const from = Number.parseInt(m[1], 10) + 1;
    let log;
    try { log = seam.svnLogChangedPaths(codeDir, { fromRev: from, toRev: 'HEAD' }); }
    catch (e) { return { ok: false, paths: null, error: `svn-log-threw:${e.message}` }; }
    if (!log || !log.ok) {
      return { ok: false, paths: null, error: `svn-log-failed:${(log && log.error) || 'sem revisions'}` };
    }
    const out = [];
    for (const r of log.revisions || []) {
      for (const p of r.paths || []) {
        const n = normalizePath(String(p.path).replace(/^\/+/, ''));
        if (n !== '' && !out.includes(n)) out.push(n);
      }
    }
    return { ok: true, paths: out, error: null };
  }
  return { ok: false, paths: null, error: `vcs-unknown:${vcs === undefined ? 'undefined' : vcs}` };
}

/**
 * O path reivindicado ALCANÇA o path tocado? `covers` é a relação canônica
 * (mesmo path, ou o claim é diretório ancestral). Em svn, e SÓ em svn, o
 * sufixo com fronteira de segmento também vale — ver `measureTouched`.
 */
function reaches(claimPath, touchedPath, allowSuffix) {
  if (covers(claimPath, touchedPath)) return true;
  if (!allowSuffix) return false;
  if (touchedPath.endsWith(`/${claimPath}`)) return true;
  return touchedPath.includes(`/${claimPath}/`);
}

/**
 * Coleta os FATOS. Toda pergunta que não pôde ser feita vira campo com o erro
 * nomeado — nunca um `false` silencioso, que é indistinguível de uma resposta
 * negativa medida. Não decide nada: a decisão é de `classifyRelease`.
 */
function probeClaim(claim, opts = {}) {
  const seam = opts.vcsSeam || vcsDefault;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
  const graceMs = typeof opts.graceMs === 'number' ? opts.graceMs : DEFAULT_GRACE_MS;

  const facts = {
    claim_present: !!claim,
    explicit_release: !!(claim && claim.released),
    // Override do operador (`--code-dir`) só quando DADO; caso contrário o
    // valor gravado no claim, que por sua vez é GIVEN e nunca derivado (B2).
    code_dir: typeof opts.codeDir === 'string' && opts.codeDir !== ''
      ? opts.codeDir
      : (claim ? claim.code_dir : null),
    vcs: null,
    baseline_before: null,
    baseline_now: null,
    // Fato CRU: a baseline da árvore andou. Preservado para auditoria porque é
    // o que a sonda A media antes de D16 — e um leitor futuro precisa poder ver
    // os dois lados do estreitamento sem reconstruir nada.
    baseline_moved: null,
    // Sonda A PRECISA: há mudança commitada desde a baseline que TOCA ≥ 1 path
    // reivindicado. É esta que governa o degrau `released-committed`.
    baseline_advanced: null,
    touched_paths: null,
    dirty_paths: null,
    paths_in_flight: null,
    age_ms: null,
    ttl_ms: ttlMs,
    grace_ms: graceMs,
    ttl_expired: null,
    owner_active: null,
    probe_error: null,
  };

  if (!claim) {
    facts.probe_error = 'claim-absent';
    return facts;
  }

  // Idade e run dona: perguntas que NÃO dependem do VCS, então são respondidas
  // mesmo quando a árvore sumiu — é exatamente esse o caso que a rede do TTL
  // existe para resolver (run morta com árvore inacessível ainda sai do caminho).
  facts.age_ms = now - (typeof claim.at === 'number' ? claim.at : now);
  facts.ttl_expired = facts.age_ms > ttlMs + graceMs;
  if (typeof opts.runActive === 'boolean') {
    facts.owner_active = opts.runActive;
  } else if (typeof opts.cwd === 'string' && typeof opts.runId === 'string') {
    // Reuso do predicado de `forge-filelock.js` — nenhuma terceira cópia.
    try { facts.owner_active = isHolderRunActive(opts.cwd, opts.runId); } catch { facts.owner_active = null; }
  }

  if (facts.explicit_release) return facts;

  const before = claim.vcs_baseline;
  if (!before || typeof before.id !== 'string' || before.id === '') {
    facts.probe_error = 'vcs-baseline-absent';
    return facts;
  }
  facts.baseline_before = before.id;
  const vcs = opts.vcs || before.vcs;

  const measured = measureBaseline(facts.code_dir, { vcs, vcsSeam: seam });
  facts.vcs = measured.vcs;
  if (!measured.ok) {
    facts.probe_error = measured.error;
    return facts;
  }
  facts.baseline_now = measured.id;
  facts.baseline_moved = measured.id !== before.id;

  let status;
  try {
    status = seam.workingStatus(facts.code_dir, { vcs: measured.vcs });
  } catch (e) {
    facts.probe_error = `working-status-threw:${e.message}`;
    return facts;
  }
  if (!status || !status.ok) {
    facts.probe_error = `working-status-failed:${(status && status.error) || 'sem entries'}`;
    return facts;
  }

  const claimed = (Array.isArray(claim.paths) ? claim.paths : []).map(normalizePath).filter((p) => p !== '');
  const dirty = [];
  for (const entry of status.entries || []) {
    if (!IN_FLIGHT_KINDS.includes(entry.kind)) continue;
    const statusPath = normalizePath(entry.path);
    if (claimed.some((c) => covers(c, statusPath)) && !dirty.includes(statusPath)) dirty.push(statusPath);
  }
  facts.dirty_paths = dirty;
  facts.paths_in_flight = dirty.length > 0;

  // Sonda A precisa. Baseline parada é resposta MEDIDA ("nada foi commitado,
  // logo nada tocou os paths"), não pergunta impossível: nenhuma consulta é
  // feita e o veredito é `false`, jamais `null`.
  if (facts.baseline_moved === false) {
    facts.touched_paths = [];
    facts.baseline_advanced = false;
    return facts;
  }
  const touched = measureTouched(facts.code_dir, measured.vcs, before.id, { vcsSeam: seam });
  if (!touched.ok) {
    facts.probe_error = touched.error;
    return facts;
  }
  const allowSuffix = measured.vcs === 'svn';
  const hits = touched.paths.filter((t) => claimed.some((c) => reaches(c, t, allowSuffix)));
  facts.touched_paths = hits;
  facts.baseline_advanced = hits.length > 0;
  return facts;
}

// ── Decisão pura ───────────────────────────────────────────────────────────

/**
 * PURA — sem disco, sem git, sem relógio. Aplica a precedência do contrato #5
 * da S05-PLAN, na ordem LITERAL, com um comentário por degrau:
 *
 *   released-explicit > released-committed > released-ttl-expired
 *   > held-probe-unavailable > held-uncommitted
 */
function classifyRelease(facts) {
  const f = facts || {};

  // 1. Já liberado: o envelope está lá, não há o que medir nem o que gravar.
  if (f.explicit_release === true) {
    return { held: false, reason: 'released-explicit', mechanism: MECHANISM_BY_REASON['released-explicit'] };
  }

  // 2. As DUAS sondas, em conjunção. `=== true` / `=== false` são literais de
  //    propósito: `null` é "não perguntei" e NUNCA pode satisfazer uma sonda.
  //
  //    D16 REMOVEU daqui a terceira condição `owner_active === false` que PR #110
  //    havia acrescentado. Ela não fechava o buraco que dizia fechar — ela tornava
  //    o degrau INALCANÇÁVEL pelo gate real (a tesoura medida está no cabeçalho).
  //    O buraco real era outro, e é a sonda A PRECISA que o fecha: o instante em
  //    que o commit do VIZINHO avançava a baseline enquanto as edições deste claim
  //    estavam momentaneamente limpas agora não satisfaz a sonda A, porque o commit
  //    do vizinho não TOCA os paths reivindicados. A prova de commit voltou a ser
  //    sobre o trabalho DESTE claim, que é o que ela sempre deveria ter medido.
  //
  //    `owner_active` continua MEDIDO e carregado na evidência — só não decide
  //    mais aqui. Onde a liveness do dono ainda governa é a PERSISTÊNCIA do
  //    veredito no RunRecord alheio (`forge-claim-gate.js`), que D16 não revoga.
  if (f.baseline_advanced === true && f.paths_in_flight === false) {
    return { held: false, reason: 'released-committed', mechanism: MECHANISM_BY_REASON['released-committed'] };
  }

  // 3. A rede. VEM ANTES de probe-unavailable de propósito: uma run morta cuja
  //    árvore sumiu ainda tem de sair do caminho — é para isso que a rede existe.
  //    Exige run INATIVA: a idade sozinha nunca libera (D2).
  //    E exige `paths_in_flight !== true` (PR #110, `#2(c)`). `!== true`, NÃO
  //    `=== false`, e a diferença é o desenho: o caso que a rede existe para
  //    resolver — árvore sumida — produz `null` ("não perguntei"), e continua
  //    liberando. O que passa a ser recusado é a REFUTAÇÃO MEDIDA: árvore suja nos
  //    paths reivindicados é a assinatura de *checkpointed, não abandonado* — que é
  //    exatamente o que pause, handoff de conta e a escalação de `block` deste
  //    próprio gate produzem. `last_heartbeat` não discrimina pausado de morto (D4);
  //    a árvore suja discrimina, e é por isso que é ela que governa aqui.
  if (f.ttl_expired === true && f.owner_active === false && f.paths_in_flight !== true) {
    return { held: false, reason: 'released-ttl-expired', mechanism: MECHANISM_BY_REASON['released-ttl-expired'] };
  }

  // 4. Alguma pergunta não pôde ser feita → MANTÉM. Inclui o `null` de qualquer
  //    das duas sondas, não só o `probe_error` explícito.
  if (f.probe_error !== null && f.probe_error !== undefined) {
    return { held: true, reason: 'held-probe-unavailable', mechanism: null };
  }
  if (f.baseline_advanced === null || f.paths_in_flight === null) {
    return { held: true, reason: 'held-probe-unavailable', mechanism: null };
  }

  // 5. Perguntas feitas, prova ausente. O claim continua valendo.
  return { held: true, reason: 'held-uncommitted', mechanism: null };
}

// ── O evento, escrito POR CÓDIGO ───────────────────────────────────────────

/**
 * Uma linha JSON appendada em `.gsd/forge/events.jsonl` do WORKSPACE (`--cwd`,
 * nunca o `CODE_DIR`). Molde de `emitGateEvent`: escrito aqui, em código, e não
 * narrado pelo consumidor — este repo já mediu o que acontece quando o único
 * registro de uma decisão é a linha que se pediu ao modelo escrever (TASK-021).
 * Falha de escrita NUNCA derruba a decisão, e nunca esconde que falhou.
 */
function emitReleaseEvent(cwd, payload) {
  const line = {
    event: 'claim-release',
    ts: new Date().toISOString(),
    run: payload.run === undefined ? null : payload.run,
    unit: payload.unit === undefined ? null : payload.unit,
    held: payload.held,
    reason: payload.reason,
    mechanism: payload.mechanism === undefined ? null : payload.mechanism,
    probes: payload.probes === undefined ? null : payload.probes,
    code_dir: payload.code_dir === undefined ? null : payload.code_dir,
  };
  const file = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return { event_written: true, event_error: null };
  } catch (e) {
    return { event_written: false, event_error: e.message };
  }
}

/** Só os fatos que o evento carrega — nunca o objeto inteiro da sonda. */
function probesOf(facts) {
  return {
    baseline_before: facts.baseline_before,
    baseline_now: facts.baseline_now,
    baseline_moved: facts.baseline_moved,
    baseline_advanced: facts.baseline_advanced,
    touched_paths: facts.touched_paths,
    paths_in_flight: facts.paths_in_flight,
    dirty_paths: facts.dirty_paths,
    age_ms: facts.age_ms,
    ttl_expired: facts.ttl_expired,
    owner_active: facts.owner_active,
    probe_error: facts.probe_error,
  };
}

// ── Pedido de release ──────────────────────────────────────────────────────

/**
 * Sonda, classifica e — SÓ quando a prova existe — grava via `releaseClaim`
 * (T01). Quando o claim é mantido, devolve `{ released: false, reason,
 * refusal: 'not-observable' }` e NADA é gravado.
 *
 * O evento é emitido nos DOIS casos: um pedido recusado é informação, e o
 * silêncio aqui reproduziria exatamente o defeito que esta milestone combate.
 */
function releaseIfObservable(cwd, runId, opts = {}) {
  const rec = opts.runRecord !== undefined ? opts.runRecord : runs.get(cwd, runId);
  const claim = readClaim(rec);
  const facts = probeClaim(claim, Object.assign({ cwd, runId }, opts));
  const verdict = classifyRelease(facts);

  const base = {
    run: runId,
    unit: claim ? claim.unit : null,
    held: verdict.held,
    reason: verdict.reason,
    mechanism: verdict.mechanism,
    code_dir: facts.code_dir,
    facts,
  };

  let released = false;
  let write = null;
  if (!verdict.held && verdict.reason !== 'released-explicit') {
    // A persistência NÃO é reimplementada: `releaseClaim` roda sob o
    // `runs.update` locado (forge-runs.js:243-252), nunca `fs.writeFileSync`
    // direto no registry.
    // `expect` = o claim que ESTA função mediu. Entre a sonda e a escrita o dono
    // pode ter gravado o claim da unidade seguinte; sem a identidade, o objeto
    // velho (já com envelope) sobrescreveria o novo e cobriria escritas VIVAS
    // com um claim liberado (review R1). Com ela, `releaseClaim` recusa por
    // nome (`stale-claim`) sob o lock e nada é gravado.
    write = releaseClaim(cwd, runId, {
      at: typeof opts.now === 'number' ? opts.now : Date.now(),
      mechanism: verdict.mechanism,
      evidence: probesOf(facts),
    }, { expect: claim });
    released = !!(write && write.ok);
  }

  const event = emitReleaseEvent(cwd, Object.assign({}, base, { probes: probesOf(facts) }));

  return Object.assign(base, {
    released,
    already_released: verdict.reason === 'released-explicit',
    // Recusa de sonda (`not-observable`) e recusa de ESCRITA (`stale-claim`,
    // `no-claim`) são fatos diferentes e nomeados separadamente: a primeira diz
    // "não pude provar", a segunda diz "provei, mas o mundo mudou embaixo".
    // Colapsar as duas em `null` esconderia exatamente a corrida que R1 fechou.
    refusal: verdict.held
      ? 'not-observable'
      : (write && write.ok === false ? write.reason : null),
    write,
    event_written: event.event_written,
    event_error: event.event_error,
  });
}

/** Só sonda — nada grava, nada emite. */
function statusOf(cwd, runId, opts = {}) {
  const rec = opts.runRecord !== undefined ? opts.runRecord : runs.get(cwd, runId);
  const claim = readClaim(rec);
  const facts = probeClaim(claim, Object.assign({ cwd, runId }, opts));
  const verdict = classifyRelease(facts);
  return {
    run: runId,
    unit: claim ? claim.unit : null,
    claim_present: !!claim,
    still_held: isHeld(claim),
    held: verdict.held,
    reason: verdict.reason,
    mechanism: verdict.mechanism,
    code_dir: facts.code_dir,
    facts,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `forge-claim-release — decide, com evidência lida do VCS, se um claim ainda vale

Flags:
  --status  <run-id>   sonda e imprime a razão; NADA é gravado
  --release <run-id>   pede o release; recusa (not-observable) se o commit não é observável
  --code-dir <p>       sobrescreve o code_dir gravado no claim
  --vcs <git|svn>      sobrescreve o vcs do baseline gravado
  --cwd <dir>          workspace (onde vivem os runs e o events.jsonl)
  --json               saída em JSON
  --help

Exit: 0 = avaliado (não liberado é sucesso), 1 = erro interno, 2 = invocação malformada.`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function formatRelease(result) {
  const lines = [
    `run=${result.run} unit=${result.unit || '(?)'} code_dir=${result.code_dir || '(nenhum)'}`,
    `razão: ${result.reason}${result.mechanism ? ` (mecanismo ${result.mechanism})` : ''}`,
    result.held ? 'claim MANTIDO — o commit não é observável' : 'claim LIBERADO',
  ];
  const f = result.facts || {};
  lines.push(`sonda A (commit tocou os paths do claim): ${f.baseline_advanced === null ? 'não perguntada' : f.baseline_advanced}`);
  lines.push(`sonda B (paths em voo): ${f.paths_in_flight === null ? 'não perguntada' : f.paths_in_flight}`);
  if (f.probe_error) lines.push(`erro de sonda: ${f.probe_error}`);
  if (result.refusal) lines.push(`pedido recusado: ${result.refusal} — nada foi gravado`);
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(`${USAGE}\n`); return 0; }

  const status = typeof args.status === 'string' ? args.status : null;
  const release = typeof args.release === 'string' ? args.release : null;
  if ((status && release) || (!status && !release)) {
    process.stderr.write('forge-claim-release: exatamente um de --status <run-id> | --release <run-id> é exigido\n');
    return 2;
  }
  if (args.vcs !== undefined && args.vcs !== 'git' && args.vcs !== 'svn') {
    process.stderr.write('forge-claim-release: --vcs deve ser git ou svn\n');
    return 2;
  }

  const cwd = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd();
  const opts = {};
  if (typeof args['code-dir'] === 'string') opts.codeDir = args['code-dir'];
  if (typeof args.vcs === 'string') opts.vcs = args.vcs;

  try {
    const result = status
      ? statusOf(cwd, status, opts)
      : releaseIfObservable(cwd, release, opts);
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatRelease(result));
    return 0;
  } catch (e) {
    process.stderr.write(`forge-claim-release error: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  measureBaseline,
  measureTouched,
  probeClaim,
  classifyRelease,
  releaseIfObservable,
  statusOf,
  emitReleaseEvent,
  CLAIM_RELEASE_REASONS,
  MECHANISM_BY_REASON,
  IN_FLIGHT_KINDS,
  DEFAULT_TTL_MS,
  DEFAULT_GRACE_MS,
  parseArgs,
  main,
  USAGE,
  _private: { covers, reaches, probesOf, formatRelease },
};
