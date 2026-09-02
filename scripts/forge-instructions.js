#!/usr/bin/env node
// forge-instructions — projects the multi-LLM routing contract into the host
// instruction file of a project (CLAUDE.md / AGENTS.md).
//
// Why this exists
// ---------------
// Routing is resolved by `forge-dispatch-resolve.js`, but the agent that reads
// the decision is the session-owner model itself — and a decision a model can
// read is a decision a model can talk itself out of. Measured failure mode
// (lookchina M127/S03, recorded in this repo's CLAUDE.md as TASK-021): four
// tasks routed to a non-Claude engine ran 4/4 in Claude, and the only trace was
// one log line the session narrated away as "fleet tooling bug".
//
// The lever here is the one surface the session ALWAYS reads and never
// summarizes: the project's own instruction file. The rules below are standing
// instructions, not advice, and they live in a delimited managed block so
// re-running is idempotent and the operator's own bytes are never touched.
//
// Ownership: the start/end markers ARE the proof of ownership, the same rule
// the installer's projection uses (`shared/forge-ownership.md`). Text outside
// the markers is spliced back byte-for-byte; a file with no markers is appended
// to, never rewritten; a file whose markers are malformed is REFUSED, never
// repaired by guess.
//
// Library exports:
//   MARKER_START / MARKER_END   // stable managed-block markers
//   TARGETS                     // Object.freeze([{ file, host }])
//   renderBlock(opts)           // ({eol}) → block text
//   findBlock(text)             // → {start, end} | null | {malformed: reason}
//   syncFile(file, opts)        // one file → {file, host, outcome, reason}
//   syncInstructions(cwd, opts) // → {cwd, files: [...], changed: n}
//
// CLI:
//   node forge-instructions.js --sync  [--cwd <dir>] [--host claude|codex|both] [--no-create] [--json] [--quiet]
//   node forge-instructions.js --check [--cwd <dir>] [--json]
//   node forge-instructions.js --print [--eol lf|crlf]
//   node forge-instructions.js --help
//
// Exit codes: 0 ok, 1 --check found drift, 2 bad args or refused write.

'use strict';

const fs = require('fs');
const path = require('path');

let VERSION = '0.0.0';
try { VERSION = require('./forge-version').VERSION; } catch (_) { /* standalone copy */ }

const MARKER_START = '<!-- forge:routing-contract:start -->';
const MARKER_END = '<!-- forge:routing-contract:end -->';
const MARKER_START_PREFIX = '<!-- forge:routing-contract:start';
const MARKER_END_PREFIX = '<!-- forge:routing-contract:end';

// Candidate instruction files, keyed by the runtime that reads them. Both are
// project-root files by contract (`shared/forge-install.md § Interface`).
const TARGETS = Object.freeze([
  Object.freeze({ file: 'CLAUDE.md', host: 'claude' }),
  Object.freeze({ file: 'AGENTS.md', host: 'codex' }),
]);

const OUTCOMES = Object.freeze(['created', 'updated', 'unchanged', 'skipped']);

// ── Contract text ─────────────────────────────────────────────────────────────
// Kept as a constant here rather than read from `shared/`: this script is copied
// into FORGE_HOME by the installer and must render the same bytes from either
// the dogfood checkout or the installed copy, with no path resolution that can
// silently resolve to nothing.
//
// Deliberately free of any claim about what THIS project's routing config is
// (whether a `routing:` block exists, which engines are declared). Such a claim
// would be measured once at sync time and be wrong from then on. The block
// states the invariant and names the command that reports the live decision.
const CONTRACT_LINES = [
  '## Forge — contrato de roteamento multi-LLM (obrigatório)',
  '',
  'Quem decide qual engine executa uma unidade é o resolvedor do Forge, não o Claude',
  'desta sessão. Estas regras valem para toda sessão neste repositório — inclusive',
  'fora dos comandos `/forge-*`, e inclusive quando você é o orquestrador.',
  '',
  '1. **Não decida o engine.** Toda unidade roteável (`execute-task`, `plan-slice`)',
  '   resolve `{engine, model, tier, effort}` em UMA chamada a',
  '   `forge-dispatch-resolve.js --json`. Ler prefs à mão, inferir por "essa task é',
  '   simples", ou herdar o engine da unidade anterior não é decisão — é override.',
  '2. **`dispatch_engine != claude` vai para o sidecar.** `codex`/`agy` são despachados',
  '   por `forge-xllm.js` (Branch C `--mode execute`, Branch D `--mode plan`). Nunca',
  '   troque isso por `Agent("forge-executor")` / `Agent("forge-planner")` porque seria',
  '   mais rápido, porque a task parece pequena, ou porque o sidecar falhou antes.',
  '3. **Voltar para Claude só pelo caminho nomeado.** A única degradação legítima é o',
  '   `worker-engine-fallback`, com `reason` do conjunto fechado, gravado em',
  '   `.gsd/forge/events.jsonl`. Fallback sem evento é bypass silencioso, não fallback.',
  '4. **Nunca execute a unidade inline no contexto principal.** Se o dispatch falhar,',
  '   pare e surface o erro ao operador. Fazer o trabalho você mesmo quebra o context',
  '   isolation e apaga a rota que o operador configurou.',
  '5. **Rota inerte é defeito de configuração, não desculpa.** Quando o dispatch cai para',
  '   Claude por `sidecar-code-dir-undeclared`, `sidecar-multirepo-unsupported` e afins,',
  '   leia o `hint` do evento e corrija a causa declarada. Não narre como "bug de',
  '   tooling" e siga — foi exatamente assim que uma slice inteira rodou 4/4 no engine',
  '   errado sem ninguém perceber.',
  '6. **A prova é o log, não a narração.** A seção `## Route` do `S##-SUMMARY.md` é',
  '   derivada de `events.jsonl` por `forge-route-audit.js`, não redigida por um modelo.',
  '   Se ela acusar drift, o drift aconteceu.',
  '',
  'Ver a rota real de uma unidade antes de despachar:',
  '',
  '```bash',
  'node "${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-dispatch-resolve.js" \\',
  '  --unit-type execute-task --plan <T##-PLAN.md> --cwd . --json',
  '```',
  '',
  'Especificação canônica: `shared/forge-dispatch.md § Worker Engine Routing`.',
];

function renderBlock(options = {}) {
  const eol = options.eol === 'crlf' ? '\r\n' : '\n';
  const lines = [
    MARKER_START,
    '<!-- Gerado por forge-instructions.js. Edite o script, não este bloco: um sync o reescreve. -->',
    ...CONTRACT_LINES,
    MARKER_END,
  ];
  return lines.join(eol);
}

// ── Block location ────────────────────────────────────────────────────────────
// Two precision requirements, both learned from the origin marker
// (`hasOriginMarker`, `scripts/forge-claude-renderer.js`):
//
//   1. Anchored at column 0 — an indented mention is prose, not a block.
//   2. Fence-aware — this repo documents its own markers, and a marker quoted
//      inside a ``` fence must not be mistaken for the real block. Without this,
//      a sync would splice the contract INTO a documentation example and delete
//      whatever sat between the quoted pair.
//
// Anything ambiguous (two starts, two ends, an end before a start, a lone
// marker) is REFUSED by name. Repairing a malformed block by guess means
// choosing which of the operator's bytes to delete.
const START_LINE_RE = /^<!-- forge:routing-contract:start -->$/;
const LEGACY_START_LINE_RE = /^<!-- forge:routing-contract:start version=\d+\.\d+\.\d+ -->$/;
const END_LINE_RE = /^<!-- forge:routing-contract:end -->[ \t]*$/;
const FENCE_RE = /^(?:`{3,}|~{3,})/;

function scanMarkers(text) {
  const rawLines = String(text).split('\n');
  const starts = [];
  const ends = [];
  const invalid = [];
  let inFence = false;
  let fenceChar = null;
  let offset = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\r$/, '');
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = line[0]; }
      else if (line[0] === fenceChar) { inFence = false; fenceChar = null; }
    } else if (!inFence) {
      // `end` deliberately excludes a trailing \r: the splice must hand the CR
      // back to the untouched remainder, or a CRLF file grows one lone LF line.
      if (START_LINE_RE.test(line) || LEGACY_START_LINE_RE.test(line)) starts.push({ start: offset, end: offset + line.length });
      else if (END_LINE_RE.test(line)) ends.push({ start: offset, end: offset + line.length });
      else if (line.startsWith(MARKER_START_PREFIX) || line.startsWith(MARKER_END_PREFIX)) invalid.push({ start: offset, end: offset + line.length });
    }
    offset += rawLine.length + 1;
  }
  return { starts, ends, invalid };
}

function findBlock(text) {
  const { starts, ends, invalid } = scanMarkers(text);
  if (invalid.length > 0) return { malformed: 'invalid-marker' };
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length === 0) return { malformed: 'end-marker-without-start' };
  if (ends.length === 0) return { malformed: 'start-marker-without-end' };
  if (starts.length > 1) return { malformed: 'duplicate-start-marker' };
  if (ends.length > 1) return { malformed: 'duplicate-end-marker' };
  if (ends[0].start < starts[0].start) return { malformed: 'end-marker-before-start' };
  return { start: starts[0].start, end: ends[0].end };
}

// The file's own line ending wins. A CRLF checkout rewritten with LF reports the
// whole file as changed in VCS — noise that reads as "Forge touched everything".
function detectEol(text) {
  return /\r\n/.test(String(text)) ? 'crlf' : 'lf';
}

function readFileSafe(file) {
  try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; }
  catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, absent: true };
    return { ok: false, absent: false, errno: (error && error.code) || 'EUNKNOWN' };
  }
}

/**
 * Sync one instruction file.
 * @returns {{file:string, host:string, outcome:string, reason:string}}
 *          outcome ∈ OUTCOMES; reason is always named, never empty.
 */
function syncFile(file, options = {}) {
  const host = options.host || 'claude';
  const dryRun = Boolean(options.dryRun);
  const create = options.create !== false;
  const result = (outcome, reason) => ({ file, host, outcome, reason });

  const read = readFileSafe(file);

  if (!read.ok && read.absent) {
    if (!create) return result('skipped', 'absent-and-not-requested');
    const block = `${renderBlock({ eol: 'lf' })}\n`;
    if (dryRun) return result('created', 'absent-would-create');
    try { fs.writeFileSync(file, block, 'utf8'); }
    catch (error) { return result('skipped', `write-failed:${(error && error.code) || 'EUNKNOWN'}`); }
    return result('created', 'file-absent');
  }
  if (!read.ok) return result('skipped', `unreadable:${read.errno}`);

  const text = read.text;
  const eol = detectEol(text);
  const block = renderBlock({ eol });
  const found = findBlock(text);

  if (found && found.malformed) return result('skipped', `malformed-block:${found.malformed}`);

  let next;
  let reason;
  if (found) {
    // Splice: every byte outside the markers is carried over untouched.
    next = text.slice(0, found.start) + block + text.slice(found.end);
    reason = 'block-present';
  } else {
    // Append. The existing bytes are a strict PREFIX of the result — the tail is
    // padded up to one blank line of separation, never trimmed down to it. A
    // sync that normalizes the operator's trailing whitespace is still a sync
    // that edited bytes outside its own block.
    const nl = eol === 'crlf' ? '\r\n' : '\n';
    const trailing = /(?:\r?\n)+$/.exec(text);
    const newlines = trailing ? trailing[0].split(/\r?\n/).length - 1 : 0;
    const pad = text.length === 0 ? '' : (newlines === 0 ? nl + nl : (newlines === 1 ? nl : ''));
    next = `${text}${pad}${block}${nl}`;
    reason = 'block-absent';
  }

  if (next === text) return result('unchanged', reason);
  if (dryRun) return result('updated', `${reason}-would-write`);
  try { fs.writeFileSync(file, next, 'utf8'); }
  catch (error) { return result('skipped', `write-failed:${(error && error.code) || 'EUNKNOWN'}`); }
  return result('updated', reason);
}

/**
 * Sync every instruction file of a project.
 *
 * Selection rule: a target that EXISTS is always synced. A target that does not
 * exist is created only when its host was explicitly requested, or — when no
 * instruction file exists at all — for the default Claude host, so a bare repo
 * still ends up carrying the contract.
 */
function syncInstructions(cwd, options = {}) {
  const root = path.resolve(cwd || process.cwd());
  const host = options.host || null; // null = auto
  const files = [];
  const present = TARGETS.filter((t) => fs.existsSync(path.join(root, t.file)));

  for (const target of TARGETS) {
    const full = path.join(root, target.file);
    const exists = present.some((t) => t.file === target.file);
    // `create: false` is for the loop entry points: refresh what a project
    // already has, never seed a file. Creating CLAUDE.md just because someone
    // typed `/forge` in an uninitialized directory would make the next run's
    // "not initialized" guard read as initialized — a guard defeated by the
    // very tool that ran before it.
    const canCreate = options.create !== false;
    const requested = canCreate && (host === 'both' || host === target.host);
    const defaultSeed = canCreate && !host && present.length === 0 && target.host === 'claude';
    if (!exists && !requested && !defaultSeed) {
      files.push({ file: full, host: target.host, outcome: 'skipped', reason: 'absent-and-not-requested' });
      continue;
    }
    files.push(syncFile(full, { host: target.host, dryRun: options.dryRun, create: canCreate }));
  }

  const changed = files.filter((f) => f.outcome === 'created' || f.outcome === 'updated').length;
  return { cwd: root, files, changed };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage() {
  return [
    'Usage:',
    '  node forge-instructions.js --sync  [--cwd <dir>] [--host claude|codex|both] [--json] [--quiet]',
    '  node forge-instructions.js --check [--cwd <dir>] [--json]',
    '  node forge-instructions.js --print [--eol lf|crlf]',
    '',
    'Injects the multi-LLM routing contract as a managed block into the project',
    'instruction file (CLAUDE.md / AGENTS.md). Idempotent; bytes outside the',
    'markers are never touched.',
    '',
    'Exit codes: 0 ok | 1 --check found drift | 2 bad args',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { mode: null, cwd: process.cwd(), host: null, json: false, quiet: false, eol: 'lf', create: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sync' || arg === '--check' || arg === '--print') out.mode = arg.slice(2);
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--host') out.host = argv[++i];
    else if (arg === '--eol') out.eol = argv[++i];
    else if (arg === '--no-create') out.create = false;
    else if (arg === '--json') out.json = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--help' || arg === '-h') out.mode = 'help';
    else return { error: `unknown argument: ${arg}` };
  }
  if (!out.mode) out.mode = 'help';
  if (out.host && !['claude', 'codex', 'both'].includes(out.host)) return { error: `invalid --host: ${out.host}` };
  if (!['lf', 'crlf'].includes(out.eol)) return { error: `invalid --eol: ${out.eol}` };
  return out;
}

function line(entry, root) {
  const mark = { created: '+', updated: '~', unchanged: '=', skipped: '·' }[entry.outcome] || '?';
  return `  ${mark} ${path.relative(root, entry.file) || entry.file} — ${entry.outcome} (${entry.reason})`;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) { process.stderr.write(`forge-instructions: ${args.error}\n${usage()}\n`); return 2; }
  if (args.mode === 'help') { process.stdout.write(`${usage()}\n`); return 0; }
  if (args.mode === 'print') { process.stdout.write(`${renderBlock({ eol: args.eol })}\n`); return 0; }

  const dryRun = args.mode === 'check';
  const report = syncInstructions(args.cwd, { host: args.host, dryRun, create: args.create });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (!args.quiet) {
    // Anti-silence floor: every candidate target is reported with its outcome,
    // including the ones nothing happened to. A report that only lists changes
    // is indistinguishable from a sync that never ran.
    process.stdout.write(`forge routing contract (v${VERSION}) — ${report.cwd}\n`);
    for (const entry of report.files) process.stdout.write(`${line(entry, report.cwd)}\n`);
  } else {
    // --quiet drops only the genuinely uneventful lines: an unchanged file and a
    // target that is absent because nobody asked for it. A REFUSAL (malformed
    // block, unreadable/unwritable file) is still printed — a refusal nobody
    // sees is the same silence this whole tool exists to remove.
    for (const entry of report.files) {
      const uneventful = entry.outcome === 'unchanged'
        || (entry.outcome === 'skipped' && entry.reason === 'absent-and-not-requested');
      if (!uneventful) process.stdout.write(`${line(entry, report.cwd)}\n`);
    }
  }

  if (dryRun) return report.changed > 0 ? 1 : 0;
  return 0;
}

module.exports = {
  MARKER_START,
  MARKER_END,
  TARGETS,
  OUTCOMES,
  CONTRACT_LINES,
  renderBlock,
  scanMarkers,
  findBlock,
  detectEol,
  syncFile,
  syncInstructions,
  parseArgs,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
