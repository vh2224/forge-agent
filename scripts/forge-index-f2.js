'use strict';

// Instrumento F2: estimativa independente do recall do extrator de citações.
// Este módulo só lê o store e o índice; a escrita permanece deliberadamente fora
// desta superfície, para que a medição possa ser executada em produção.
const path = require('path');
const crypto = require('crypto');
const { buildFileIndex, extractCitations } = require('./forge-memory-index');
const { listFragments, parseFragment, readFragmentText } = require('./forge-memory');

// Vocabulário próprio. Não usar CODE_EXT/CITATION_REGEXES aqui: o detector deve
// ser uma segunda observação, mais larga, do mesmo texto.
const TRAILING_PUNCTUATION = '.,;:!?)]}>';
const LEADING_PUNCTUATION = '(\'"[';
const VERSION_RE = /^\d+(?:\.\d+)+$/;
const PLAIN_NOISE = new Set(['e/ou', 'n/a', 'na', 'ou']);
const METALINGUISTIC_EXTENSION_REASON = 'menção metalinguística de extensão, não arquivo concreto';
const DETECTOR_TAXONOMY = Object.freeze({
  schema: 2,
  extension_governors: Object.freeze(['extensão', 'extensões']),
  list_conjunctions: Object.freeze(['e', 'ou']),
  structural_separator_pattern: '[\\s\\u00a0,:;/()\\[\\]\\-\\u2013\\u2014]',
  bare_extension_pattern: '\\.[A-Za-z0-9]{1,6}',
  metalinguistic_reason: METALINGUISTIC_EXTENSION_REASON,
});

let DETECTOR_VERSION;
const STRUCTURAL_SEPARATOR_RE = new RegExp(DETECTOR_TAXONOMY.structural_separator_pattern, 'u');
const BARE_EXTENSION_AT_RE = new RegExp(`^${DETECTOR_TAXONOMY.bare_extension_pattern}`);
const LIST_CONJUNCTION_AT_RE = new RegExp(`^(?:${DETECTOR_TAXONOMY.list_conjunctions.join('|')})\\b`, 'iu');
// Latin prose abbreviations that survive punctuation stripping as `x.y` tokens.
const LATIN_ABBREVIATION_RE = /^(?:e\.g|i\.e|p\.ex)$/;
// Template markers (`T##-PLAN.md`), interpolations (`{id}`, `${N}`), angle
// placeholders (`<abs>`) and globs (`*`) name a FAMILY of files, never one file.
const PLACEHOLDER_RE = /##|[{}<>*]/;
// Real file extensions the detector accepts as "file-shaped" (<= 6 chars, the
// same bound mentionKind imposes). Deliberately much broader than the
// extractor's CODE_EXT — the detector stays an independent, wider observation —
// but bounded to extensions that exist in the world, so `JSON.parse`, `turn.id`
// or `v2.0` stop counting as files the extractor "missed". Binaries (exe, dll,
// so) are excluded on purpose: prose naming `cmd.exe` names a program, not a
// citable source artifact.
const REAL_FILE_EXT = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'pl', 'lua', 'r', 'scala', 'exs', 'erl', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'psm1',
  'bat', 'cmd', 'dart', 'zig', 'nim', 'hs', 'clj', 'cljs', 'proto', 'gql',
  'json', 'jsonl', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'csv', 'tsv', 'lock', 'plist', 'pem',
  'md', 'mdx', 'txt', 'rst', 'adoc', 'tex', 'log',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'svg', 'aspx', 'ejs', 'hbs', 'pug',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'tar', 'gz', 'tgz',
  'woff', 'woff2', 'ttf', 'otf', 'map', 'wasm', 'ipynb',
]);

function cleanToken(raw) {
  let value = String(raw || '');
  // Strip wrapping punctuation on BOTH sides: `(forge-smoke.js` and
  // `'forge-runs.js` are the same mention as their unwrapped forms — leaving
  // the `(` in place made the normalized basename diverge from the citation
  // the extractor correctly produced (measured: 8 phantom misses).
  while (value.length > 1 && LEADING_PUNCTUATION.includes(value[0])) value = value.slice(1);
  while (value.length > 1 && TRAILING_PUNCTUATION.includes(value[value.length - 1])) value = value.slice(0, -1);
  return value;
}

function dotSuffix(value) {
  const match = /\.([A-Za-z0-9]{1,6})$/.exec(String(value || ''));
  return match ? match[1].toLowerCase() : null;
}

function basename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function mentionKind(value) {
  const core = cleanToken(value);
  const wrapped = core.length >= 2 && core[0] === '`' && core[core.length - 1] === '`';
  const inner = wrapped ? core.slice(1, -1) : core;
  const segments = inner.split('/');
  if (wrapped) return 'backticks';
  if (/\.[A-Za-z0-9]{1,6}$/.test(inner)) return 'suffix';
  if (segments.length >= 2 && segments.every(Boolean)) return 'slash';
  return null;
}

function isStructuralSeparator(char) {
  return STRUCTURAL_SEPARATOR_RE.test(char);
}

function skipStructural(text, start) {
  let cursor = start;
  while (cursor < text.length && isStructuralSeparator(text[cursor])) cursor += 1;
  return cursor;
}

function readBareExtension(text, start) {
  let cursor = start;
  const wrapped = text[cursor] === '`';
  if (wrapped) cursor += 1;
  const match = BARE_EXTENSION_AT_RE.exec(text.slice(cursor));
  if (!match) return null;
  cursor += match[0].length;
  if (wrapped) {
    if (text[cursor] !== '`') return null;
    cursor += 1;
  } else if (cursor < text.length && !isStructuralSeparator(text[cursor])) {
    const terminalPunctuation = /[.!?]/.test(text[cursor]) && (cursor + 1 === text.length || /[\s\u00a0]/u.test(text[cursor + 1]));
    if (!terminalPunctuation) return null;
  }
  return { start, end: cursor, raw: text.slice(start, cursor) };
}

function metalinguisticExtensionRanges(text) {
  const ranges = [];
  const governors = new RegExp(`\\b(?:${DETECTOR_TAXONOMY.extension_governors.join('|')})\\b`, 'giu');
  let governor;
  while ((governor = governors.exec(text)) !== null) {
    let cursor = skipStructural(text, governor.index + governor[0].length);
    let candidate = readBareExtension(text, cursor);
    if (!candidate) continue;
    while (candidate) {
      if (text[candidate.end] === '/' && !readBareExtension(text, candidate.end + 1)) break;
      ranges.push(candidate);
      cursor = skipStructural(text, candidate.end);
      const conjunction = LIST_CONJUNCTION_AT_RE.exec(text.slice(cursor));
      if (conjunction) cursor = skipStructural(text, cursor + conjunction[0].length);
      candidate = readBareExtension(text, cursor);
    }
  }
  return ranges;
}

function detectMentions(text) {
  if (typeof text !== 'string' || !text) return [];
  const mentions = [];
  const contextual = metalinguisticExtensionRanges(text);
  const tokenRe = /\S+/g;
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    const tokenStart = match.index;
    const tokenEnd = tokenStart + match[0].length;
    const overlaps = contextual.filter((range) => range.start < tokenEnd && range.end > tokenStart);
    const uncovered = [];
    if (overlaps.length === 0) {
      uncovered.push({ start: tokenStart, end: tokenEnd });
    } else {
      let cursor = tokenStart;
      for (const range of overlaps) {
        if (cursor < range.start) uncovered.push({ start: cursor, end: range.start });
        cursor = Math.max(cursor, range.end);
      }
      if (cursor < tokenEnd) uncovered.push({ start: cursor, end: tokenEnd });
    }
    for (const span of uncovered) {
      let start = span.start;
      let end = span.end;
      if (overlaps.length > 0) {
        while (start < end && /[,:;()\[\]\-\u2013\u2014]/u.test(text[start])) start += 1;
        while (end > start && /[,:;()\[\]\-\u2013\u2014]/u.test(text[end - 1])) end -= 1;
      }
      if (start >= end) continue;
      const raw = text.slice(start, end);
      const core = cleanToken(raw);
      const why = mentionKind(core);
      if (why) {
        const inner = core.length >= 2 && core[0] === '`' && core[core.length - 1] === '`' ? core.slice(1, -1) : core;
        mentions.push({ start, mention: { raw, normalized: basename(inner), why } });
      }
    }
  }
  for (const range of contextual) {
    const raw = range.raw;
    const inner = raw[0] === '`' ? raw.slice(1, -1) : raw;
    mentions.push({
      start: range.start,
      mention: {
        raw,
        normalized: basename(inner),
        why: 'suffix',
        detector_context: {
          classification: 'metalinguistic-extension',
          taxonomy: DETECTOR_VERSION,
          span: { start: range.start, end: range.end },
        },
      },
    });
  }
  return mentions.sort((left, right) => left.start - right.start).map((entry) => entry.mention);
}

function detectorFalsePositive(mention) {
  const normalized = mention.normalized;
  const raw = String(mention.raw || '').toLowerCase();
  if (mention.detector_context && mention.detector_context.classification === 'metalinguistic-extension') return DETECTOR_TAXONOMY.metalinguistic_reason;
  if (PLAIN_NOISE.has(raw)) return 'segmentos de prosa, não caminho de arquivo';
  if (VERSION_RE.test(normalized)) return 'número decimal ou versão nua';
  if (/^[a-z]\/([a-z]|\d)$/i.test(raw)) return 'abreviação com barra';
  if (mention.why === 'slash' && !/[.][A-Za-z0-9]{1,6}$/.test(normalized)) return 'token com barra sem aparência de arquivo';
  // Each rule below is enumerated in detector_false_positives with its own
  // named reason — a discarded class is COUNTED, never silently dropped.
  if (LATIN_ABBREVIATION_RE.test(normalized)) return 'abreviação latina (e.g/i.e), não arquivo';
  if (PLACEHOLDER_RE.test(raw) || PLACEHOLDER_RE.test(normalized)) return 'placeholder/template/glob (##, {x}, <x>, *), não um arquivo concreto';
  const core = cleanToken(mention.raw);
  const wrapped = core.length >= 2 && core[0] === '`' && core[core.length - 1] === '`';
  const inner = wrapped ? core.slice(1, -1) : core;
  const suffix = dotSuffix(normalized);
  const bareDotfile = /(?:^|\/)\.[A-Za-z0-9]{1,6}$/.test(inner);
  // A trailing slash names a DIRECTORY (`.gsd/`): its basename is empty, so it
  // could never match a file citation — enumerate instead of leaving a
  // permanently unmatchable mention in the denominator.
  if (inner.endsWith('/')) return 'referência a diretório (termina em /), não arquivo';
  // Backticks alone are not evidence of a file: `--cwd`, `default`, `domain:`
  // are keywords/flags. A backticked token only stays signal with a slash or a
  // real file extension.
  if (wrapped && !inner.includes('/') && !bareDotfile && (!suffix || !REAL_FILE_EXT.has(suffix))) return 'keyword/flag entre crases, sem extensão de arquivo nem barra';
  // #107: a slash does not make a path. Two shapes reached here as signal and
  // depressed recall against an extractor that was RIGHT to ignore them.
  //
  // (a) A list of backticked tokens joined by `/` — ``writes:`/`expected_output:`` — is
  //     schema keys, not a path. The tell is exact and cannot occur in a real
  //     path: after the OUTER backticks come off, a backtick is still inside.
  //     A genuine backticked path (`scripts/foo.js`) unwraps to none.
  if (wrapped && inner.includes('`')) return 'lista de tokens entre crases unida por /, não um caminho';
  // (b) A pair of bare extensions — `(.cmd/.bat)` — names two suffixes, not a
  //     file. Every segment being a bare `.ext` is what separates it from a
  //     real path: `src/.env` has a segment that is not an extension, and a
  //     lone `.env` has no slash at all, so neither is touched. This is the
  //     narrow half of the ambiguity #107 describes — the lone `.md` case
  //     stays deliberately unfixed, because no lexical tell separates it from
  //     a real dotfile.
  // `parts`, não `segments`: `mentionKind` acima tem uma linha quase idêntica
  // (`segments.length >= 2 && segments.every(...)`) e os dois nomes iguais em
  // funções vizinhas já confundiram uma edição desta própria PR.
  const parts = inner.split('/');
  if (parts.length >= 2 && parts.every((part) => /^\.[A-Za-z0-9]{1,6}$/.test(part))) {
    return 'par/lista de extensões nuas unidas por /, não um arquivo concreto';
  }
  // Dotted identifiers (`JSON.parse`, `turn.id`, `v2.0`, `cmd.exe`) end in a
  // "suffix" that is not a real file extension — prose, not a citation target.
  if (suffix && !bareDotfile && !REAL_FILE_EXT.has(suffix)) return 'sufixo não é extensão de arquivo real (identificador com ponto)';
  return null;
}

// S02 R1 (review-fix): o ruído conhecido do próprio detector é SUBTRAÍDO do
// denominador antes de names/missing/bucket/f2_recall. Antes desta correção o
// filtro era só diagnóstico: uma versão nua (`3.1.2`) ou `e/ou` contava como
// menção não capturada e deprimia o recall gateado em F2_THRESHOLD. A lista
// diagnóstica (`detector_false_positives`) continua sendo emitida a partir da
// lista CHEIA — descarte enumerado, nunca silencioso.
function signalMentions(mentions) {
  return (Array.isArray(mentions) ? mentions : []).filter((item) => !detectorFalsePositive(item));
}

const DETECTOR_FINGERPRINT_TABLES = Object.freeze({
  trailing_punctuation: TRAILING_PUNCTUATION,
  leading_punctuation: LEADING_PUNCTUATION,
  version_pattern: VERSION_RE.source,
  plain_noise: Object.freeze([...PLAIN_NOISE].sort()),
  latin_abbreviation_pattern: LATIN_ABBREVIATION_RE.source,
  placeholder_pattern: PLACEHOLDER_RE.source,
  real_file_ext: Object.freeze([...REAL_FILE_EXT].sort()),
  compiled_regexes: Object.freeze({
    structural_separator: Object.freeze({ source: STRUCTURAL_SEPARATOR_RE.source, flags: STRUCTURAL_SEPARATOR_RE.flags }),
    bare_extension_at: Object.freeze({ source: BARE_EXTENSION_AT_RE.source, flags: BARE_EXTENSION_AT_RE.flags }),
    list_conjunction_at: Object.freeze({ source: LIST_CONJUNCTION_AT_RE.source, flags: LIST_CONJUNCTION_AT_RE.flags }),
  }),
});
const DETECTOR_FINGERPRINT_FUNCTIONS = Object.freeze([
  cleanToken,
  dotSuffix,
  basename,
  mentionKind,
  isStructuralSeparator,
  skipStructural,
  readBareExtension,
  metalinguisticExtensionRanges,
  detectMentions,
  detectorFalsePositive,
  signalMentions,
]);

function computeDetectorVersion(overrides) {
  const options = overrides || {};
  const functions = options.functions || DETECTOR_FINGERPRINT_FUNCTIONS;
  const payload = {
    taxonomy: options.taxonomy || DETECTOR_TAXONOMY,
    tables: options.tables || DETECTOR_FINGERPRINT_TABLES,
    function_sources: functions.map((fn) => Function.prototype.toString.call(fn)),
  };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

DETECTOR_VERSION = computeDetectorVersion();

// Menções já filtradas de ruído, para consumidores fora deste módulo (o índice
// usa isto no bucket (b)) — assim os dois lados classificam pelo mesmo critério.
function detectSignalMentions(text) {
  return signalMentions(detectMentions(text));
}

function classifyCitationPrecision(citations, mentions, memId) {
  const mentionNames = new Set(mentions.map((item) => item.normalized));
  return citations
    .filter((citation) => !mentionNames.has(basename(citation.path || citation.raw)))
    .map((citation) => ({ mem_id: memId || null, raw: citation.raw, motivo: 'citação extraída sem menção independente correspondente' }));
}

function classifyFact(fact, fragment) {
  const text = fact && fact.text ? String(fact.text).replace(/\r\n?/g, '\n') : '';
  const observed = detectMentions(text);
  const mentions = signalMentions(observed);
  const citations = extractCitations(text);
  const names = new Set(mentions.map((item) => item.normalized));
  const cited = new Set(citations.map((item) => basename(item.path || item.raw)));
  const missing = mentions.filter((item) => !cited.has(item.normalized));
  let bucket = 'no-mention';
  if (mentions.length && !missing.length) bucket = 'covered';
  else if (missing.length && missing.length < mentions.length) bucket = 'partial';
  else if (mentions.length) bucket = 'missed';
  return {
    mem_id: fact && fact.mem_id ? fact.mem_id : null,
    storage_key: fragment && fragment.storageKey ? fragment.storageKey : null,
    text,
    mentions,
    citations,
    missing_mentions: missing,
    bucket,
    precision_candidates: classifyCitationPrecision(citations, mentions, fact && fact.mem_id),
    detector_false_positives: observed.filter((item) => detectorFalsePositive(item)).map((item) => ({ ...item, motivo: detectorFalsePositive(item) })),
  };
}

function sumUnresolved(unresolved) {
  return (Array.isArray(unresolved) ? unresolved : []).reduce((total, item) => total + Number(item.count || 0), 0);
}

function assertCoverageIdentity(report) {
  const byReason = Object.values(report.unresolved_by_reason || {});
  const unresolved = byReason.reduce((total, count) => total + count, 0);
  return unresolved === report.citations_total - report.citations_resolved;
}

function reportFactCounts(facts) {
  return {
    covered: facts.filter((fact) => fact.bucket === 'covered').length,
    partial: facts.filter((fact) => fact.bucket === 'partial').length,
    missed: facts.filter((fact) => fact.bucket === 'missed').length,
    no_mention: facts.filter((fact) => fact.bucket === 'no-mention').length,
  };
}

function measureF2(cwd, opts) {
  const root = path.resolve(cwd || process.cwd());
  const options = opts || {};
  const facts = [];
  const fragments = listFragments(root, options.listFragments || {});
  for (const fragment of fragments) {
    const parsed = parseFragment(readFragmentText(root, fragment));
    for (const fact of Array.isArray(parsed.facts) ? parsed.facts : []) facts.push(classifyFact(fact, fragment));
  }
  const mentioned = facts.filter((fact) => fact.mentions.length > 0);
  const missed = facts.filter((fact) => fact.bucket === 'missed');
  const partial = facts.filter((fact) => fact.bucket === 'partial');
  const covered = facts.filter((fact) => fact.bucket === 'covered');
  const index = buildFileIndex(root, options.index || {});
  const coverage = index.coverage || {};
  const unresolvedByReason = {};
  for (const item of Array.isArray(coverage.unresolved) ? coverage.unresolved : []) unresolvedByReason[item.reason] = (unresolvedByReason[item.reason] || 0) + Number(item.count || 0);
  const citationsTotal = Number(coverage.citations_total || 0);
  const citationsResolved = Number(coverage.citations_resolved || 0);
  const unresolvedTotal = Object.values(unresolvedByReason).reduce((a, b) => a + b, 0);
  if (unresolvedTotal !== citationsTotal - citationsResolved) throw new Error('unresolved_by_reason não fecha a identidade de citações');
  const detectorFalsePositives = facts.flatMap((fact) => fact.detector_false_positives.map((item) => ({ mem_id: fact.mem_id, raw: item.raw, motivo: item.motivo })));
  const falsePositiveCandidates = facts.flatMap((fact) => fact.precision_candidates);
  const denominator = mentioned.length;
  return {
    detector_version: DETECTOR_VERSION,
    verdict: denominator === 0 ? 'EMPTY-DENOMINATOR' : 'MEASURED',
    facts_that_mention_file: denominator,
    facts_covered: covered,
    facts_missed_total: missed,
    facts_missed_partial: partial.map((fact) => ({ mem_id: fact.mem_id, missing_mentions: fact.missing_mentions })),
    f2_recall: denominator === 0 ? null : 1 - (missed.length + partial.length) / denominator,
    citations_total: citationsTotal,
    citations_resolved: citationsResolved,
    resolution_rate: citationsTotal === 0 ? null : citationsResolved / citationsTotal,
    unresolved_by_reason: unresolvedByReason,
    false_positive_candidates: falsePositiveCandidates,
    detector_false_positives: detectorFalsePositives,
    facts_no_mention: facts.filter((fact) => fact.bucket === 'no-mention').map((fact) => ({ mem_id: fact.mem_id })),
    fact_counts: reportFactCounts(facts),
    coverage_identity: assertCoverageIdentity({ unresolved_by_reason: unresolvedByReason, citations_total: citationsTotal, citations_resolved: citationsResolved }),
    partial: !!index.partial,
  };
}

function parseCliArgs(argv) {
  const result = { cwd: process.cwd(), json: false, valid: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--cwd' && argv[i + 1] && !argv[i + 1].startsWith('--')) result.cwd = argv[++i];
    else { result.valid = false; break; }
  }
  return result;
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  if (!args.valid) { process.stderr.write(JSON.stringify({ error: 'Uso: forge-index-f2.js --cwd <dir> [--json]' }) + '\n'); return 2; }
  try {
    const report = measureF2(args.cwd);
    if (args.json) process.stdout.write(JSON.stringify(report) + '\n');
    else process.stdout.write(`# Medição F2\n\n- veredito: ${report.verdict}\n- recall: ${report.f2_recall}\n- fatos com menção: ${report.facts_that_mention_file}\n- resolução: ${report.resolution_rate}\n`);
    return 0;
  } catch (error) { process.stderr.write(JSON.stringify({ error: error.message || String(error) }) + '\n'); return 1; }
}

module.exports = { DETECTOR_TAXONOMY, DETECTOR_FINGERPRINT_TABLES, DETECTOR_FINGERPRINT_FUNCTIONS, DETECTOR_VERSION, METALINGUISTIC_EXTENSION_REASON, computeDetectorVersion, metalinguisticExtensionRanges, detectMentions, detectSignalMentions, detectorFalsePositive, classifyCitationPrecision, measureF2, runCli };
if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
