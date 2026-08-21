'use strict';

// forge-index-green.js — Gate "índice verde" (D-2), re-medível por S04 no apply.
//
// Compõe três medições já testadas (measureF2, buildUnitAxis, buildSubjectAxis)
// e avalia os três critérios de D-2 JUNTOS, sem inventar nenhum número novo:
//   1. lista enumerada de misses permitidos (allowed-misses.json), comparada
//      nos DOIS sentidos contra os misses medidos por measureF2 — ver abaixo
//   2. eixo unidade: 100% dos fatos LIDOS carregam unidade (facts_not_read enumerado)
//   3. relatório do eixo assunto presente — NENHUM threshold aqui (D-2 proíbe régua
//      no assunto; a presença do relatório é o único requisito)
//
// O critério 1 substitui o antigo `f2_recall >= 0.99` (decisão do operador,
// issue #107 — D-2 destravada para isto). O percentual era zero-defeito
// disfarçado: com denominador ~105, UM miss residual conhecido já reprovava
// (0,9885 < 0,99), e a primeira memória nova com prosa de forma inédita
// re-avermelhava o gate sem que nada tivesse piorado. O critério agora é o
// mesmo idioma que a #103 instalou em run-tests.js --baseline: uma lista
// HUMANA, enumerada e versionada dos misses permitidos, comparada nos dois
// sentidos — um miss fora da lista reprova nomeando cada um, E uma entrada
// cuja menção deixou de falhar também reprova ("remova da lista"), porque
// allow-list que só cresce vira gate inerte (precedente deste repo: doctor
// Layer 3, TASK-021). `f2_recall` continua REPORTADO — é informação útil e
// comparável no tempo — mas não gateia mais nada.
//
// Pisos anti-silêncio do critério 1, cada um com razão nomeada:
//   - zero fatos avaliados nunca é passe limpo (`no-facts-evaluated`);
//   - entrada apontando para um mem_id que não existe mais no store é
//     fantasma e reprova (`ghost-allowed-entry:<key>`);
//   - lista ilegível ou inválida RECUSA (`allowed-misses-file-unreadable` /
//     `allowed-misses-invalid`) — lixo legível é sempre recusa, tenha vindo
//     de onde tiver vindo.
//
// Ausência do arquivo tem DUAS semânticas, distinguidas por quem pediu:
//   - caminho DEFAULT ausente → lista vazia com `source: "default-absent"`
//     ("este workspace nunca aceitou nenhum miss") — que já é fail-closed,
//     porque qualquer miss cai em `unlisted-miss` e o gate fica vermelho.
//     Recusar aqui não protegeria nada e quebraria todo workspace que não
//     tenha o arquivo (medido: forge-sweep-delete.test.js, repos sintéticos).
//   - caminho EXPLÍCITO (--allowed / opts.allowedPath) ausente → RECUSA
//     (`allowed-misses-file-missing`): quem pediu um arquivo específico é
//     má-configuração se ele não existe — o mesmo contrato do --baseline de
//     run-tests.js, onde o arquivo sempre chega por flag.
// A origem da lista nunca é silenciosa: o relatório carrega
// `allowed_misses.source` (`file` | `default-absent`), então quem lê o JSON
// distingue "lista vazia declarada em arquivo" de "não havia arquivo nenhum".
//
// Contrato para S04 (o consumidor deste gate): este gate NUNCA bloqueia por exit
// code — exit é sempre 0 (convenção deste repo: gate advisory falha loud dentro
// do JSON, nunca pelo processo). Quem bloqueia é o CONSUMIDOR. S04 deve tratar
// `green !== true`, stdout não-JSON, e falha de spawn como RECUSA da deleção.
// A convenção advisory default deste repo faria S04 seguir em frente por
// omissão — essa linha existe exatamente para impedir essa armadilha.
//
// O gate é READ-ONLY: nenhuma chamada aqui escreve índice, journal ou store.
// Zero-dep, CommonJS.

const fs = require('fs');
const path = require('path');
const { measureF2 } = require('./forge-index-f2');
const { buildFileIndex } = require('./forge-memory-index');
const { buildUnitAxis, buildSubjectAxis } = require('./forge-memory-axes');

// Where the allow-list lives, relative to the measured workspace root, in
// search order. Overridable via opts.allowedPath / CLI --allowed.
//
// The list is PER-WORKSPACE data: its keys are `<mem_id>::<mention>` from THAT
// workspace's store, so a list written here means nothing in another project.
// `.gsd/` is therefore the canonical home — consumer projects commit `.gsd/`,
// so the list is versioned exactly where the misses live. This repo is the
// exception that keeps the fallback alive: its own `.gsd/` is gitignored
// dogfood, so its list stays under `scripts/fixtures/`, versioned and testable.
//
// Only ENOENT advances the search. A candidate that exists but is unreadable,
// is a directory, or holds invalid JSON REFUSES naming that path — falling
// through to the next candidate on garbage would silently weaken the very
// posture this gate installs.
const ALLOWED_SEARCH_RELPATHS = [
  path.join('.gsd', 'index-green-allowed-misses.json'),
  path.join('scripts', 'fixtures', 'index-green', 'allowed-misses.json'),
];
// Kept as the documented default for callers that ask for "the" path; the
// search above is what the gate actually walks.
const DEFAULT_ALLOWED_RELPATH = ALLOWED_SEARCH_RELPATHS[1];

// ---------------------------------------------------------------------------
// Miss enumeration and the stable key
//
// A miss is a (fact, missing mention) pair taken STRAIGHT from what measureF2
// already produces (facts_missed_total / facts_missed_partial) — the gate
// derives, never re-measures. The key is `<storage_key>::<mem_id>::<normalized
// mention>`:
//   - storage_key names the exact fragment that produced the fact — the same
//     mem_id can legitimately appear in many fragments (a memory promoted
//     across units keeps its mem_id), so mem_id alone is not a stable unit;
//   - mem_id is assigned once when the fact is written and never re-numbered
//     by neighboring writes;
//   - the normalized mention (basename, lowercased) is a pure function of the
//     fact's own text, computed by the instrument itself (detectMentions),
//     independent of line numbers, read order, or sibling fragments.
// storage_key is already computed by classifyFact (fragment.storageKey) inside
// the existing listFragments/readFragmentText pass in measureF2 — it is
// carried through the projection, never re-read from the store here. An
// allowed entry with no storage_key can no longer grant a mem_id::mention pair
// permission across every fragment that happens to reuse that mem_id — the
// exact leak this qualification exists to close.
// ---------------------------------------------------------------------------

function missKey(storageKey, memId, mention) {
  // `::` is the display-friendly delimiter; a mention containing `::` is
  // theoretical (normalized basenames of file-shaped tokens) and would only
  // ever collide with itself.
  return `${storageKey || '(sem-storage_key)'}::${memId || '(sem-mem_id)'}::${mention}`;
}

// Enumerate every (fact, missing mention) pair from a measureF2 report,
// deduplicated by key. Both missed and partial facts count — both depress the
// recall the old criterion gated on, and both are real extractor blind spots.
function enumerateMisses(f2) {
  const out = new Map();
  const buckets = [
    Array.isArray(f2 && f2.facts_missed_total) ? f2.facts_missed_total : [],
    Array.isArray(f2 && f2.facts_missed_partial) ? f2.facts_missed_partial : [],
  ];
  for (const bucket of buckets) {
    for (const fact of bucket) {
      const missing = Array.isArray(fact.missing_mentions) ? fact.missing_mentions : [];
      for (const mention of missing) {
        const key = missKey(fact.storage_key, fact.mem_id, mention.normalized);
        if (!out.has(key)) out.set(key, { storage_key: fact.storage_key || null, mem_id: fact.mem_id || null, mention: mention.normalized, key });
      }
    }
  }
  return [...out.values()];
}

// Every qualified (storage_key, mem_id) pair the measurement actually read,
// across all four buckets — the existence check for ghost entries derives
// from the same report, never from a second store read. Qualified by
// storage_key so a reused mem_id in a DIFFERENT fragment can never mask a
// nonexistent identity (a global mem_id-only set would).
function collectLiveQualifiedIds(f2) {
  const ids = new Set();
  const buckets = ['facts_covered', 'facts_missed_total', 'facts_missed_partial', 'facts_no_mention'];
  for (const name of buckets) {
    for (const fact of Array.isArray(f2 && f2[name]) ? f2[name] : []) {
      if (fact && fact.mem_id) ids.add(`${fact.storage_key || ''}::${fact.mem_id}`);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Allow-list resolution (pure — mirrors resolveBaseline in run-tests.js)
//
// The list is a HUMAN, versioned document: adding an entry is a decision made
// by whoever opens the PR, never automatic. Every entry MUST name an owner
// (`item`, the issue/backlog id tracking it) — an ownerless entry is how red
// becomes scenery. Validation errors are named sentences; nothing is skipped
// silently.
// ---------------------------------------------------------------------------

function resolveAllowedMisses(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`allowed-misses não é JSON válido: ${error.message}`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['allowed-misses deve ser um objeto JSON com a chave "allowed"'] };
  }
  const errors = [];
  for (const key of Object.keys(doc)) {
    if (key.startsWith('_')) continue; // annotation keys ("_comment", ...) are allowed
    if (key !== 'allowed') errors.push(`allowed-misses tem chave desconhecida "${key}" (esperado: "allowed")`);
  }
  if (!Array.isArray(doc.allowed)) {
    errors.push('allowed-misses deve ter "allowed" como array de {storage_key, mem_id, mention, item, reason}');
    return { ok: false, errors };
  }
  const seen = new Set();
  for (let index = 0; index < doc.allowed.length; index += 1) {
    const entry = doc.allowed[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`allowed[${index}] deve ser um objeto com mem_id/mention/item/reason`);
      continue;
    }
    const { storage_key, mem_id, mention, item, reason } = entry;
    if (typeof mem_id !== 'string' || mem_id.trim() === '') {
      errors.push(`allowed[${index}] está sem "mem_id" (o fato dono do miss)`);
      continue;
    }
    if (typeof mention !== 'string' || mention.trim() === '') {
      errors.push(`allowed[${index}] (${mem_id}) está sem "mention" (a menção normalizada que falha)`);
      continue;
    }
    if (typeof storage_key !== 'string' || storage_key.trim() === '') {
      errors.push(`allowed[${index}] (${mem_id}::${mention}) está sem "storage_key" (o fragmento medido que produziu o miss)`);
      continue;
    }
    const key = missKey(storage_key, mem_id, mention);
    // `item` is the owner — mandatory. An entry without an owner is how red
    // becomes scenery: nobody is on the hook to ever remove it.
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(`entrada ${key} está sem "item" (o dono — issue/backlog id que a rastreia)`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      errors.push(`entrada ${key} está sem "reason"`);
    }
    if (seen.has(key)) errors.push(`allowed-misses lista ${key} duas vezes`);
    seen.add(key);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    entries: doc.allowed.map((entry) => ({
      storage_key: entry.storage_key,
      mem_id: entry.mem_id,
      mention: entry.mention,
      item: entry.item,
      reason: entry.reason,
      key: missKey(entry.storage_key, entry.mem_id, entry.mention),
    })),
  };
}

// ---------------------------------------------------------------------------
// Two-way comparison (pure — mirrors compareFailures in run-tests.js)
//
// Codes: match | new-misses | stale-entries | ghost-entries (combinable via
// the arrays) | no-facts-evaluated. The anti-silence floor comes first: a
// measurement that evaluated zero facts is a named failure, never a clean
// pass — even when both sets are empty, because "não medi nada" byte-for-byte
// resembling "medi e está limpo" is the exact pathology this gate exists to
// prevent.
// ---------------------------------------------------------------------------

function compareMisses({ factsEvaluated, misses, allowedEntries, liveQualifiedIds }) {
  if (!Number.isInteger(factsEvaluated) || factsEvaluated <= 0) {
    return { ok: false, code: 'no-facts-evaluated', newMisses: [], staleEntries: [], ghostEntries: [], knownMisses: [] };
  }
  const missSet = new Set((Array.isArray(misses) ? misses : []).map((m) => m.key));
  const live = liveQualifiedIds instanceof Set ? liveQualifiedIds : new Set(liveQualifiedIds || []);
  const allowed = Array.isArray(allowedEntries) ? allowedEntries : [];
  const allowedKeys = allowed.map((e) => e.key || missKey(e.storage_key, e.mem_id, e.mention));
  const allowedByKey = new Map(allowed.map((e) => [e.key || missKey(e.storage_key, e.mem_id, e.mention), e]));

  const newMisses = [...missSet].filter((key) => !allowedByKey.has(key)).sort();
  // Ghost: the entry's (storage_key, mem_id) pair no longer exists anywhere in
  // the store — the fragment/fact it pointed at is gone. Qualified by
  // storage_key so a mem_id reused in a DIFFERENT fragment can never mask a
  // nonexistent identity. Distinct from stale (fact alive, mention no longer
  // failing): a ghost can never be observed to fail again, so leaving it
  // listed is pure scenery.
  const ghostEntries = allowedKeys.filter((key) => {
    const e = allowedByKey.get(key);
    return !live.has(`${e.storage_key || ''}::${e.mem_id}`);
  }).sort();
  const ghostSet = new Set(ghostEntries);
  const staleEntries = allowedKeys.filter((key) => !ghostSet.has(key) && !missSet.has(key)).sort();
  const knownMisses = [...missSet].filter((key) => allowedByKey.has(key)).sort();

  const ok = newMisses.length === 0 && staleEntries.length === 0 && ghostEntries.length === 0;
  let code = 'match';
  if (!ok) {
    const parts = [];
    if (newMisses.length) parts.push('new-misses');
    if (staleEntries.length) parts.push('stale-entries');
    if (ghostEntries.length) parts.push('ghost-entries');
    code = parts.join('+');
  }
  return { ok, code, newMisses, staleEntries, ghostEntries, knownMisses };
}

// Reads and resolves the allow-list file. Unreadable / invalid each yields
// its own named refusal in BOTH modes — readable garbage is always a refusal.
// Absence splits by who asked (see the header): the DEFAULT path absent means
// "this workspace never accepted any miss" → empty list, source named
// `default-absent`, never silent; an EXPLICIT path absent is a
// misconfiguration → refusal.
function loadAllowedMisses(allowedPath, explicit) {
  let stat;
  try {
    stat = fs.statSync(allowedPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (!explicit) return { ok: true, entries: [], source: 'default-absent' };
      return { ok: false, reason: 'allowed-misses-file-missing', errors: [`lista de misses permitidos ausente no caminho pedido explicitamente: ${allowedPath}`] };
    }
    return { ok: false, reason: 'allowed-misses-file-unreadable', errors: [`lista de misses permitidos ilegível (${(error && error.code) || 'erro'}): ${allowedPath}`] };
  }
  let text;
  try {
    if (stat.isDirectory()) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    text = fs.readFileSync(allowedPath, 'utf8');
  } catch (error) {
    return { ok: false, reason: 'allowed-misses-file-unreadable', errors: [`lista de misses permitidos ilegível (${(error && error.code) || 'erro'}): ${allowedPath}`] };
  }
  const resolved = resolveAllowedMisses(text);
  if (!resolved.ok) return { ok: false, reason: 'allowed-misses-invalid', errors: resolved.errors };
  return { ok: true, entries: resolved.entries, source: 'file', path: allowedPath };
}

// Walks ALLOWED_SEARCH_RELPATHS in order for the default case. Only ENOENT
// advances: a candidate that exists and is broken refuses right there, naming
// itself — the search must never turn garbage into "the next one, then".
// `path` travels with the answer so "which file spoke" is never implicit.
function loadAllowedMissesDefault(root) {
  for (const rel of ALLOWED_SEARCH_RELPATHS) {
    const candidate = path.join(root, rel);
    const loaded = loadAllowedMisses(candidate, false);
    if (loaded.source === 'default-absent') continue;
    return loaded;
  }
  return { ok: true, entries: [], source: 'default-absent', searched: ALLOWED_SEARCH_RELPATHS.slice() };
}

function computeUnitAxisCriterion(axis) {
  const coverage = (axis && axis.coverage) || {};
  const factsWithUnit = Number(coverage.facts_with_unit || 0);
  const factsTotal = Number(coverage.facts_total || 0);
  const notRead = coverage.facts_not_read || {};
  const unreadableCount = Number(notRead.unreadable_fragments || 0);
  const skippedCount = Number(notRead.fragments_skipped_by_store || 0);
  const readFailed = !!(axis && axis.fragment_listing_failed);
  const indexPartial = !!(axis && axis.partial);
  const countsMatch = factsWithUnit === factsTotal;
  // A gate that only checks "100% of what I saw" while silently dropping
  // fragments the store could not read/kept, would technically satisfy the
  // narrow "facts lidos" wording while making a claim no operator can trust —
  // any fragment lost before or during the read (unreadable OR skipped by the
  // store) is enumerated in facts_not_read AND fails this criterion, because
  // an index that lost data is not evidence of structural completeness.
  const noLostFragments = unreadableCount === 0 && skippedCount === 0;
  const ok = countsMatch && !readFailed && !indexPartial && noLostFragments;
  return {
    ok,
    readFailed,
    indexPartial,
    countsMatch,
    noLostFragments,
    measured: `${factsWithUnit}/${factsTotal}`,
    facts_not_read: coverage.facts_not_read || null,
  };
}

function computeSubjectReportCriterion(axis) {
  const ok = !!(axis && axis.coverage && typeof axis.coverage.facts_total === 'number');
  return { ok };
}

function errorReport(error) {
  return {
    green: false,
    detector_version: null,
    criteria: [],
    f2_recall: null,
    resolution_rate: null,
    unit_axis: { facts_with_unit: 0, facts_total: 0, facts_not_read: null },
    subject_report_present: false,
    allowed_misses: null,
    reasons: [`gate-error:${(error && error.message) || String(error)}`],
    measured_at: new Date().toISOString(),
  };
}

// measureGreen is the library entry point AND is what the CLI calls — it must
// never throw on its own (a fragment that fails mid-read, e.g., throws inside
// measureF2/buildFileIndex, not just inside the CLI process boundary). The CLI
// wraps this call again as defense-in-depth, but the "exceção interna → JSON
// green:false + gate-error, exit 0" contract (T05-PLAN.md Steps 3/4) belongs
// to this function, not only to its caller.
function measureGreen(cwd, opts) {
  try {
    return measureGreenUnsafe(cwd, opts);
  } catch (error) {
    return errorReport(error);
  }
}

function measureGreenUnsafe(cwd, opts) {
  const root = path.resolve(cwd || process.cwd());
  const options = opts || {};
  const reasons = [];

  // Monta o resultado do índice uma vez; buildUnitAxis e buildSubjectAxis
  // consomem o MESMO objeto — nenhum dos dois eixos relê o store por conta
  // própria. measureF2 tem assinatura própria (cwd, opts) e faz sua própria
  // leitura internamente — é uma medição já testada e composta aqui, não
  // recalculada; a leitura duplicada é do módulo F2, não deste gate.
  const result = buildFileIndex(root, options.index || {});
  const unitAxis = buildUnitAxis(result, options.unitAxis || {});
  const subjectAxis = buildSubjectAxis(result, options.subjectAxis || {});
  const f2 = measureF2(root, options.f2 || {});

  // Critério 1: lista enumerada, duas direções. Tudo aqui deriva do relatório
  // que measureF2 já produziu — o gate nunca relê o store por conta própria.
  const explicitAllowed = !!options.allowedPath;
  const loaded = explicitAllowed
    ? loadAllowedMisses(options.allowedPath, true)
    : loadAllowedMissesDefault(root);
  const misses = enumerateMisses(f2);
  const counts = f2.fact_counts || {};
  const factsEvaluated = Number(counts.covered || 0) + Number(counts.partial || 0)
    + Number(counts.missed || 0) + Number(counts.no_mention || 0);

  let allowedCriterion;
  if (!loaded.ok) {
    reasons.push(loaded.reason);
    allowedCriterion = {
      ok: false,
      code: loaded.reason,
      path: loaded.path || (explicitAllowed ? options.allowedPath : null),
      // Which mode asked for the file that failed — an explicit path refusing
      // and a default path refusing (unreadable/invalid) are both refusals,
      // but the reader should see who asked.
      source: explicitAllowed ? 'explicit' : 'default',
      errors: loaded.errors,
      facts_evaluated: factsEvaluated,
      misses: misses.map((m) => m.key),
      known: [], new: [], stale: [], ghost: [],
    };
  } else {
    const verdict = compareMisses({
      factsEvaluated,
      misses,
      allowedEntries: loaded.entries,
      liveQualifiedIds: collectLiveQualifiedIds(f2),
    });
    if (verdict.code === 'no-facts-evaluated') reasons.push('no-facts-evaluated');
    for (const key of verdict.newMisses) reasons.push(`unlisted-miss:${key}`);
    for (const key of verdict.staleEntries) reasons.push(`stale-allowed-entry:${key}`);
    for (const key of verdict.ghostEntries) reasons.push(`ghost-allowed-entry:${key}`);
    allowedCriterion = {
      ok: verdict.ok,
      code: verdict.code,
      // The file that ANSWERED, not the one we hoped for: null under
      // `default-absent`, and `searched` below says where we looked.
      path: loaded.path || null,
      searched: loaded.searched || undefined,
      // `file` = the list came from a real file (even an empty one);
      // `default-absent` = no file at the default path, empty list assumed.
      // Both are an empty-or-populated list; the ORIGIN differs and it shows.
      source: loaded.source,
      errors: [],
      facts_evaluated: factsEvaluated,
      misses: misses.map((m) => m.key),
      known: verdict.knownMisses,
      new: verdict.newMisses,
      stale: verdict.staleEntries,
      ghost: verdict.ghostEntries,
      // The removal instruction travels with the data, not only the docs — a
      // cured entry left listed is an inert gate (doctor Layer 3, TASK-021).
      stale_action: verdict.staleEntries.length ? 'remova da lista — entrada curada deixada na lista vira gate inerte' : null,
    };
  }

  const unitCriterion = computeUnitAxisCriterion(unitAxis);
  const subjectCriterion = computeSubjectReportCriterion(subjectAxis);

  if (unitCriterion.readFailed) reasons.push('fragment-listing-failed');
  else if (unitCriterion.indexPartial) reasons.push('index-partial');
  else if (!unitCriterion.countsMatch || !unitCriterion.noLostFragments) reasons.push('unit-axis-incomplete');
  if (!subjectCriterion.ok) reasons.push('subject-report-missing');

  const green = allowedCriterion.ok && unitCriterion.ok && subjectCriterion.ok;

  const criteria = [
    {
      // O critério é a LISTA, não o percentual: f2_recall segue reportado no
      // topo do relatório como informação comparável no tempo, mas quem
      // decide verde/vermelho aqui é a comparação de conjuntos nas duas
      // direções contra allowed-misses.json.
      name: 'allowed_misses',
      ok: allowedCriterion.ok,
      measured: `${allowedCriterion.new.length} fora da lista, ${allowedCriterion.stale.length} curada(s), ${allowedCriterion.ghost.length} fantasma(s), ${allowedCriterion.known.length} permitida(s)`,
      required: 'conjunto de misses == lista permitida, nas duas direções (default ausente = lista vazia com origem nomeada; caminho explícito ausente, lista ilegível ou inválida recusa; zero fatos avaliados recusa)',
    },
    {
      name: 'unit_axis',
      ok: unitCriterion.ok,
      measured: unitCriterion.measured,
      required: 'facts_with_unit === facts_total (dos fatos lidos)',
    },
    {
      // D-2: nenhum threshold pertence a este critério — required documenta
      // isso explicitamente em vez de carregar um número que não existe.
      name: 'subject_report_present',
      ok: subjectCriterion.ok,
      measured: subjectCriterion.ok,
      required: 'relatório presente com coverage.facts_total numérico — sem régua de cobertura',
    },
  ];

  return {
    green,
    detector_version: f2.detector_version,
    criteria,
    // Informativo, não mais critério — mantido no topo porque é a série
    // temporal que o operador compara entre medições.
    f2_recall: f2.f2_recall,
    resolution_rate: f2.resolution_rate,
    unit_axis: {
      facts_with_unit: (unitAxis && unitAxis.coverage && unitAxis.coverage.facts_with_unit) || 0,
      facts_total: (unitAxis && unitAxis.coverage && unitAxis.coverage.facts_total) || 0,
      facts_not_read: (unitAxis && unitAxis.coverage && unitAxis.coverage.facts_not_read) || null,
    },
    subject_report_present: subjectCriterion.ok,
    allowed_misses: allowedCriterion,
    reasons,
    measured_at: new Date().toISOString(),
  };
}

function parseCliArgs(argv) {
  const result = { cwd: process.cwd(), json: false, allowed: null, valid: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--cwd' && argv[i + 1] && !argv[i + 1].startsWith('--')) result.cwd = argv[++i];
    else if (argv[i] === '--allowed' && argv[i + 1] && !argv[i + 1].startsWith('--')) result.allowed = argv[++i];
    else { result.valid = false; break; }
  }
  return result;
}

function renderMarkdown(report) {
  const allowed = report.allowed_misses;
  const lines = [
    '# Gate: índice verde',
    '',
    `- green: ${report.green}`,
    '- critério: lista enumerada de misses permitidos, duas direções (f2_recall é informativo, não gateia)',
    `- f2_recall (informativo): ${report.f2_recall}`,
    `- detector_version: ${report.detector_version}`,
    `- resolution_rate: ${report.resolution_rate}`,
    `- unit_axis: ${report.unit_axis.facts_with_unit}/${report.unit_axis.facts_total}`,
    `- subject_report_present: ${report.subject_report_present}`,
    `- allowed_misses: ${allowed ? `${allowed.known.length} permitida(s), ${allowed.new.length} fora da lista, ${allowed.stale.length} curada(s), ${allowed.ghost.length} fantasma(s) (origem: ${allowed.source})` : '(não medido — gate-error)'}`,
  ];
  if (allowed && allowed.stale.length) lines.push(`- entradas curadas (remova da lista): ${allowed.stale.join(', ')}`);
  if (allowed && allowed.ghost.length) lines.push(`- entradas fantasmas (mem_id não existe mais): ${allowed.ghost.join(', ')}`);
  if (allowed && allowed.new.length) lines.push(`- misses fora da lista: ${allowed.new.join(', ')}`);
  lines.push(`- reasons: ${report.reasons.length ? report.reasons.join(', ') : '(nenhum)'}`);
  lines.push(`- measured_at: ${report.measured_at}`);
  lines.push('');
  return lines.join('\n');
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  if (!args.valid) {
    process.stderr.write(JSON.stringify({ error: 'Uso: forge-index-green.js --cwd <dir> [--allowed <file>] [--json]' }) + '\n');
    return 2;
  }
  // Convenção deste repo: gate advisory falha loud DENTRO do JSON, nunca pelo
  // exit code — exceção interna vira green:false + reasons:['gate-error:<msg>']
  // e o processo sai 0 mesmo assim (Steps 3/4 do T05-PLAN.md).
  let report;
  try {
    report = measureGreen(args.cwd, args.allowed ? { allowedPath: path.resolve(args.allowed) } : undefined);
  } catch (error) {
    report = errorReport(error);
  }
  if (args.json) process.stdout.write(JSON.stringify(report) + '\n');
  else process.stdout.write(renderMarkdown(report));
  return 0;
}

module.exports = {
  measureGreen,
  runCli,
  DEFAULT_ALLOWED_RELPATH,
  // Exported for isolated tests: the pure halves of criterion 1 (mirroring
  // resolveBaseline/compareFailures in run-tests.js), the key derivation, and
  // the two per-report extractors — so the suite bites the set arithmetic and
  // validation with synthetic shapes without spawning real stores; plus the
  // two pre-existing criteria (subject_report_present has no reachable
  // "missing" state through the real store — the axis builder always returns
  // a coverage object — so the suite exercises it directly against a
  // malformed axis shape instead of faking the store).
  missKey,
  enumerateMisses,
  collectLiveQualifiedIds,
  resolveAllowedMisses,
  compareMisses,
  computeUnitAxisCriterion,
  computeSubjectReportCriterion,
};
if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
