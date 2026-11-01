'use strict';
// Behavioral suite for the bounded personal summary. Offline: no network,
// provider or git; every fixture lives in its own temp root and is removed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// A validated worktree alias normally needs a real git worktree. The seam is
// installed before the personal module captures the validator, and only the
// fixture alias directories registered here are accepted.
const isolation = require('./forge-isolation');
const validateWorktreeIdentity = isolation.validateWorktreeIdentity;
const fixtureAliases = new Set();
isolation.validateWorktreeIdentity = function (repo, wtPath) {
  if (fixtureAliases.has(wtPath)) return { ok: true };
  return validateWorktreeIdentity.apply(this, arguments);
};

const { fixture } = require('./forge-personal-context.test');
const personal = require('./forge-personal-context');
const summaryModule = require('./forge-personal-summary');
const { SUMMARY_LIMITS, buildPersonalSummary, renderPersonalSummary } = summaryModule;

const ROOT = path.resolve(__dirname, '..');
const CONTEXT_CLI = path.join(__dirname, 'forge-personal-context.js');
const SUMMARY_CLI = path.join(__dirname, 'forge-personal-summary.js');
const WIDE = '\u{1D538}'; // 4 UTF-8 bytes, a surrogate pair in UTF-16
const EMOJI = '\u{1F600}';
const TOP_KEYS = ['status', 'reason', 'scope', 'limits', 'totals', 'works', 'omitted', 'attention'];
const WORK_KEYS = ['id', 'kind', 'workStatus', 'reliability', 'activity', 'nextAction', 'lastResult', 'pending', 'acceptances'];
const ITEM_KEYS = ['text', 'source', 'validity', 'truncated', 'sourceOutside', 'reason'];
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

let failed = 0;
function test(name, fn) {
  const f = fixture();
  try {
    fn(f);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`      ${error.stack}`);
  } finally { f.cleanup(); }
}

const summarize = (f, extra = {}) => buildPersonalSummary({ cwd: f.project, userHome: f.home, ...extra });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const storeFile = f => path.join(f.home, '.forge-personal', 'context.json');
function save(f, id, checkpoint) {
  const result = personal.saveCheckpoint({ ...f.options, id, intent: 'checkpoint', checkpoint });
  assert.strictEqual(result.status, 'ok', JSON.stringify(result));
}
function bash() {
  return process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
}
function cli(f, script, args, userHome = f.home) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, cwd: f.project, env: f.env(userHome) });
}

function assertItem(item) {
  assert(Object.keys(item).every(key => ITEM_KEYS.includes(key)), `item keys: ${Object.keys(item)}`);
  assert.strictEqual(typeof item.text, 'string');
  assert(Array.from(item.text).length <= SUMMARY_LIMITS.text, 'text over the code point limit');
  assert(['current', 'historical', 'missing', 'uncertain'].includes(item.validity), item.validity);
  if (item.source !== null) {
    assert(!/\\/.test(item.source) && !/^[\\/]/.test(item.source) && !/^[a-z]:/i.test(item.source), `source not relative POSIX: ${item.source}`);
    assert(!item.source.split('/').includes('..'), `source traverses: ${item.source}`);
    assert(Array.from(item.source).length <= SUMMARY_LIMITS.text);
  }
}
// Allowlist, limits and conservation of mandatory counts in one place.
function assertShape(summary) {
  assert.deepStrictEqual(Object.keys(summary), TOP_KEYS);
  assert.strictEqual(summary.scope, 'summary');
  assert.deepStrictEqual(summary.limits, { works: 5, items: 3, text: 240, bytes: 4096 });
  assert(bytes(summary) + 1 <= SUMMARY_LIMITS.bytes, `summary ${bytes(summary)} bytes + newline over the limit`);
  assert(summary.works.length <= SUMMARY_LIMITS.works);
  if (summary.attention) {
    assert.deepStrictEqual(Object.keys(summary.attention), ['reason', 'works', 'pending', 'acceptances', 'truncated', 'diagnostic']);
    assert.strictEqual(summary.attention.reason, 'attention-required');
    assert.strictEqual(summary.attention.diagnostic, 'forge-personal-context.js --snapshot');
  }
  if (summary.status !== 'ok') {
    assert.deepStrictEqual(summary.works, []);
    assert.strictEqual(summary.totals, null);
    assert(summary.attention, 'an error always carries the diagnostic reference');
    return;
  }
  assert.deepStrictEqual(Object.keys(summary.totals), ['works', 'pending', 'acceptances']);
  assert.deepStrictEqual(Object.keys(summary.omitted), ['works', 'nextAction', 'lastResult']);
  assert.strictEqual(summary.omitted.works, summary.totals.works - summary.works.length);
  for (const work of summary.works) {
    const keys = Object.keys(work);
    assert.deepStrictEqual(keys.filter(key => key !== 'diagnostic'), WORK_KEYS);
    for (const field of ['nextAction', 'lastResult']) if (work[field]) assertItem(work[field]);
    for (const field of ['pending', 'acceptances']) {
      assert.deepStrictEqual(Object.keys(work[field]), ['total', 'items']);
      assert(work[field].items.length <= SUMMARY_LIMITS.items && work[field].items.length <= work[field].total);
      work[field].items.forEach(assertItem);
    }
    if (work.diagnostic) assert.strictEqual(work.diagnostic, `forge-personal-context.js --snapshot --id ${work.id}`);
  }
  for (const field of ['pending', 'acceptances']) {
    const shown = summary.works.reduce((sum, work) => sum + work[field].items.length, 0);
    const hidden = summary.attention ? summary.attention[field] : 0;
    assert.strictEqual(shown + hidden, summary.totals[field], `${field}: listed plus attention must equal the total`);
  }
}
function assertPrivate(f, text) {
  const lower = text.toLowerCase();
  const roots = [f.root, f.home, f.otherHome, f.project, path.join(f.home, '.forge-personal'), ROOT];
  if (os.homedir().length > 3) roots.push(os.homedir());
  for (const root of roots) {
    for (const candidate of [root, fs.existsSync(root) ? fs.realpathSync(root) : root]) {
      const form = candidate.toLowerCase();
      for (const variant of [form, form.replace(/\\/g, '/'), JSON.stringify(form).slice(1, -1)]) {
        assert(!lower.includes(variant), `absolute path leaked: ${variant}`);
      }
    }
  }
  assert(!/[a-f0-9]{64}/i.test(text), 'hash leaked');
  for (const key of ['capturedAt', '"checkpoint"', 'terminalEvidence', '"state"', 'runDiagnostic', '"project"', '"message"', '"file"', '"hash"', 'ENOENT']) {
    assert(!text.includes(key), `private field leaked: ${key}`);
  }
}

test('R1 private absolute locations in every text field are masked before truncation', f => {
  const id = 'TASK-001', work = f.work(id); f.bind(id);
  const absolute = [f.root, f.home, path.join(f.home, '.forge-personal', 'context.json'), f.otherHome,
    f.options.env.FORGE_HOME, ROOT, 'C:/synthetic-profile/private/file.md',
    'c:\\Synthetic Profile\\Private Folder\\file.md', '/synthetic-home/private/file.md',
    '\\\\synthetic-server\\private-share\\file.md'];
  let previous = null;
  for (const location of absolute) {
    for (const spelling of [location, location.toUpperCase(), location.replace(/\\/g, '/'), JSON.stringify(location).slice(1, -1)]) {
      const capture = { text: `Consultar "${spelling}"; manter docs/guide.md e /forge-update.`, source: work.source };
      if (previous) save(f, id, { acceptances: [{ ...previous, resolved: true }] });
      save(f, id, { nextAction: [capture], lastResult: [capture], pending: [capture], acceptances: [{ ...capture, resolved: false }] });
      previous = capture;
      const view = summarize(f), json = JSON.stringify(view);
      assertShape(view); assertPrivate(f, json);
      const shown = view.works[0];
      for (const item of [shown.nextAction, shown.lastResult, ...shown.pending.items, ...shown.acceptances.items]) {
        assert(!item.text.toLowerCase().includes(spelling.toLowerCase()), 'absolute prose path survived');
        assert(item.text.includes('docs/guide.md') && item.text.includes('/forge-update'), 'relative reference or Forge command lost');
        const expectedSource = path.relative(f.project, work.source).replace(/\\/g, '/');
        assert.strictEqual(item.source, process.platform === 'win32' ? expectedSource.toLowerCase() : expectedSource);
      }
      assert.deepStrictEqual(view.totals, { works: 1, pending: 1, acceptances: 1 });
      const actualCli = cli(f, CONTEXT_CLI, ['--summary', '--cwd', f.project]);
      assert.strictEqual(actualCli.status, 0, actualCli.stderr);
      assertPrivate(f, actualCli.stdout);
      assert.deepStrictEqual(JSON.parse(actualCli.stdout), view, 'real CLI differs from bounded library projection');
    }
  }
});

test('R1 unquoted absolute paths are masked while URLs and relative prose survive', f => {
  const id = 'TASK-001', work = f.work(id); f.bind(id);
  for (const spelling of [f.home, 'C:/synthetic-profile/private/file.md', '/synthetic-home/private/file.md',
    '\\\\synthetic-server\\private-share\\file.md']) {
    save(f, id, { pending: [{ text: `Abrir ${spelling}; consultar docs/guide.md e https://example.invalid/help e /forge-status.`, source: work.source }] });
    const view = summarize(f), item = view.works[0].pending.items[0];
    assertShape(view); assertPrivate(f, JSON.stringify(view));
    assert(!item.text.toLowerCase().includes(spelling.toLowerCase()));
    for (const kept of ['docs/guide.md', 'https://example.invalid/help', '/forge-status']) assert(item.text.includes(kept), `lost ${kept}`);
  }
});

test('R1 known private roots embedded in URLs are masked without discarding the URL', f => {
  const id = 'TASK-001', work = f.work(id); f.bind(id);
  for (const location of [f.root, f.home, f.otherHome, f.options.env.FORGE_HOME, ROOT]) {
    const forward = location.replace(/\\/g, '/');
    save(f, id, { pending: [{ text: `Fonte https://example.invalid/trace/${forward.toUpperCase()}; manter docs/guide.md.`, source: work.source }] });
    const view = summarize(f), text = view.works[0].pending.items[0].text;
    assertShape(view); assertPrivate(f, JSON.stringify(view));
    assert(!text.toLowerCase().includes(forward.toLowerCase()));
    assert(text.includes('https://example.invalid/trace/'));
    assert(text.includes('docs/guide.md'));
  }
});

test('R1/R2 quoted and unquoted Forge commands keep arguments while private path arguments stay masked', f => {
  const id = 'TASK-001', work = f.work(id); f.bind(id);
  const commands = ['/forge --help', '/forge-task --resume TASK-001', '/forge-update --apply --runtime both', '/forge-status --json'];
  for (const command of commands) {
    for (const quote of ['"', "'", '`', '']) {
      save(f, id, { pending: [{ text: `Executar ${quote}${command}${quote}; manter docs/guide.md.`, source: work.source }] });
      const view = summarize(f), text = view.works[0].pending.items[0].text;
      assertShape(view); assertPrivate(f, JSON.stringify(view));
      assert(text.includes(command), 'quoted command arguments lost');
      assert(text.includes('docs/guide.md'));
      const actualCli = cli(f, CONTEXT_CLI, ['--summary', '--cwd', f.project]);
      assert.strictEqual(actualCli.status, 0, actualCli.stderr);
      assert.deepStrictEqual(JSON.parse(actualCli.stdout), view);
    }
  }
  const privatePath = 'C:/synthetic-profile/private/file.md';
  save(f, id, { pending: [{ text: `Executar "/forge-update --source local --repo ${privatePath}"; manter docs/guide.md.`, source: work.source }] });
  const view = summarize(f), text = view.works[0].pending.items[0].text;
  assertShape(view);
  assert(text.includes('/forge-update --source local --repo'));
  assert(!text.includes(privatePath));
  assert(text.includes('docs/guide.md'));
});

test('R3 angle, colon and smart-quote path delimiters are private while scheme links survive', f => {
  const id = 'TASK-001', work = f.work(id); f.bind(id);
  const absolute = '/synthetic-home/private/file.md';
  for (const text of [`Consultar <${absolute}>`, `origem:${absolute}`, `Consultar \u201c${absolute}\u201d`, `origem:(${absolute})`]) {
    const capture = { text: `${text}; manter https://example.invalid/help e ftp://example.invalid/a e docs/guide.md.`, source: work.source };
    save(f, id, { pending: [capture], nextAction: [capture], lastResult: [capture] });
    const view = summarize(f); assertShape(view); assertPrivate(f, JSON.stringify(view));
    for (const item of [view.works[0].pending.items[0], view.works[0].nextAction, view.works[0].lastResult]) {
      assert(!item.text.includes(absolute));
      for (const kept of ['https://example.invalid/help', 'ftp://example.invalid/a', 'docs/guide.md']) assert(item.text.includes(kept), `lost ${kept}`);
    }
    const actualCli = cli(f, CONTEXT_CLI, ['--summary', '--cwd', f.project]);
    assert.strictEqual(actualCli.status, 0, actualCli.stderr);
    assert.deepStrictEqual(JSON.parse(actualCli.stdout), view);
  }
});

test('MH-01 module: MEM003 shape, frozen limits and no file access of its own', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-personal-summary.js'), 'utf8');
  assert(source.startsWith('#!/usr/bin/env node\n'));
  assert(source.indexOf('module.exports') < source.indexOf('require.main === module'));
  assert(Object.isFrozen(SUMMARY_LIMITS));
  assert.deepStrictEqual({ ...SUMMARY_LIMITS }, { works: 5, items: 3, text: 240, bytes: 4096 });
  assert(!/require\('fs'\)|writeFile|mkdir|readFile|appendFile|unlink|rename/.test(source), 'summary must not touch files itself');
  assert.deepStrictEqual(Object.keys(summaryModule).sort(), ['SUMMARY_LIMITS', 'buildPersonalSummary', 'renderPersonalSummary', 'renderSummaryCommand']);
  const failure = buildPersonalSummary({ get cwd() { throw new Error('C:/private/boom'); } });
  assert.strictEqual(failure.reason, 'summary-failed');
  assert(!JSON.stringify(failure).includes('boom'));
});

test('MH-09 no-bindings: absent store, foreign project and unbound --id stay read-only', f => {
  f.work('TASK-001');
  for (const summary of [summarize(f), summarize(f, { id: 'TASK-001' })]) {
    assertShape(summary);
    assert.deepStrictEqual([summary.status, summary.reason, summary.works, summary.attention], ['ok', 'no-bindings', [], null]);
  }
  assert.strictEqual(renderPersonalSummary({ cwd: f.project, userHome: f.home }).exitCode, 0);
  assert(!fs.existsSync(path.join(f.home, '.forge-personal')), 'summary created the personal profile');
  f.bind('TASK-001');
  const second = path.join(f.root, 'wc2');
  fs.mkdirSync(path.join(second, '.gsd', 'tasks'), { recursive: true });
  const before = fs.readFileSync(storeFile(f));
  assert.strictEqual(summarize(f, { cwd: second }).reason, 'no-bindings');
  assert.strictEqual(summarize(f, { id: 'TASK-999' }).reason, 'no-bindings');
  for (let i = 0; i < 3; i++) summarize(f);
  assert.deepStrictEqual(fs.readFileSync(storeFile(f)), before, 'summary mutated the store');
});

test('MH-06/07 many works: rank then id, five works, stable bytes across calls and binding orders', f => {
  const ids = Array.from({ length: 12 }, (_, i) => `TASK-${String(i + 1).padStart(3, '0')}`);
  for (const id of ids) f.work(id);
  for (const id of [...ids].reverse()) f.bind(id);
  const plan = id => path.join(f.project, '.gsd', 'tasks', id, `${id}-PLAN.md`);
  save(f, 'TASK-009', { pending: [{ text: 'Decisão pendente nove', source: plan('TASK-009') }] });
  save(f, 'TASK-004', { pending: [{ text: 'Decisão pendente quatro', source: plan('TASK-004') }] });
  fs.writeFileSync(plan('TASK-002'), '---\nstatus: DONE\n---\n');
  save(f, 'TASK-002', { lastResult: [{ text: 'Concluída', source: plan('TASK-002'), resolved: true }] });
  fs.unlinkSync(plan('TASK-011'));
  const summary = summarize(f);
  assertShape(summary);
  assert.strictEqual(summary.totals.works, 12);
  assert.deepStrictEqual(summary.works.map(w => w.id), ['TASK-004', 'TASK-009', 'TASK-001', 'TASK-003', 'TASK-005']);
  assert.strictEqual(summary.omitted.works, 7);
  // TASK-011 (unknown, missing plan) is protected and not listed: attention counts it.
  assert.strictEqual(summary.attention.works, 1);
  const first = JSON.stringify(summary);
  assert.strictEqual(JSON.stringify(summarize(f)), first, 'two calls differ');
  const store = JSON.parse(fs.readFileSync(storeFile(f), 'utf8'));
  for (const project of Object.values(store.projects)) {
    project.bindings = Object.fromEntries(Object.entries(project.bindings).reverse());
  }
  fs.writeFileSync(storeFile(f), JSON.stringify(store, null, 2) + '\n');
  assert.strictEqual(JSON.stringify(summarize(f)), first, 'binding order changed the bytes');
  assertPrivate(f, first);
});

test('MH-05/07/08 long Unicode pending: 12 works x 10 pending of 240 four-byte code points stay bounded and counted', f => {
  const ids = Array.from({ length: 12 }, (_, i) => `TASK-${String(i + 1).padStart(3, '0')}`);
  for (const id of ids) {
    const { source } = f.work(id); f.bind(id);
    save(f, id, {
      pending: Array.from({ length: 10 }, (_, n) => ({ text: `${n}${WIDE.repeat(239)}`, source })),
      nextAction: [{ text: EMOJI.repeat(400), source }],
      lastResult: [{ text: WIDE.repeat(300), source }],
    });
  }
  const summary = summarize(f);
  assertShape(summary);
  assert.strictEqual(summary.totals.pending, 120);
  assert(summary.attention && summary.attention.pending > 0 && summary.attention.truncated > 0);
  for (const work of summary.works) {
    assert.strictEqual(work.pending.total, 10);
    assert(work.pending.items.length >= 1, 'a listed work keeps at least one mandatory item');
    assert.strictEqual(work.diagnostic, `forge-personal-context.js --snapshot --id ${work.id}`);
  }
  const json = JSON.stringify(summary);
  assert(!LONE.test(json), 'lone surrogate in output');
  assert.strictEqual(Buffer.from(json, 'utf8').toString('utf8'), json, 'UTF-8 round trip');
  assert(Buffer.byteLength(json, 'utf8') + 1 <= 4096);
  assertPrivate(f, json);
});

test('MH-05 boundary: a four-byte character at 239/240 is never split and the marker stays inside 240', f => {
  const { source } = f.work('TASK-001'); f.bind('TASK-001');
  const exact = 'a'.repeat(239) + EMOJI;
  const over = 'b'.repeat(239) + EMOJI + 'tail';
  save(f, 'TASK-001', { pending: [{ text: exact, source }, { text: over, source }] });
  const [kept, cut] = summarize(f).works[0].pending.items;
  assert.strictEqual(kept.text, exact);
  assert.strictEqual(kept.truncated, undefined);
  assert.strictEqual(Array.from(cut.text).length, 240);
  assert.strictEqual(cut.text, 'b'.repeat(239) + '\u2026');
  assert.strictEqual(cut.truncated, true);
  const summary = summarize(f);
  assert.strictEqual(summary.attention.truncated, 1, 'a truncated mandatory text requests attention');
  assert.strictEqual(summary.attention.pending, 0);
});

test('MH-05 hostile text: ANSI, C1, separators, bidi and lone surrogates are neutralized', f => {
  const { source } = f.work('TASK-001'); f.bind('TASK-001');
  const hostile = '\u001b[31mvermelho\u001b[0m\r\nlinha\u0085c1\u2028sep\u2029par\u202Eexe.txt\u2066iso\u2069\u200Emark \uD800 fim\uDC00';
  save(f, 'TASK-001', { pending: [{ text: hostile, source }], nextAction: [{ text: '\u0007\u0000', source }] });
  const result = renderPersonalSummary({ cwd: f.project, userHome: f.home });
  const work = JSON.parse(result.json).works[0];
  const text = work.pending.items[0].text;
  assert(!/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(text), JSON.stringify(text));
  assert(!LONE.test(result.json));
  assert(text.includes('\uFFFD') && !/\s{2,}/.test(text));
  assert.strictEqual(work.nextAction.text, '(vazio)');
  assert(Buffer.byteLength(result.json + '\n', 'utf8') <= 4096);
  assert(!result.json.includes('\\u001b') && !result.json.includes('\\r'));
});

test('MH-07 ladder: when non-mandatory reduction is enough, every pending keeps its full text', f => {
  const ids = ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004', 'TASK-005'];
  const sources = Object.fromEntries(ids.map(id => [id, f.work(id).source]));
  for (const id of ids) f.bind(id);
  save(f, 'TASK-001', { pending: [{ text: 'Aguardando decisão sobre o formato', source: sources['TASK-001'] },
    { text: 'Aceite do UAT pendente', source: sources['TASK-001'] }] });
  for (const id of ids.slice(1)) {
    save(f, id, { nextAction: [{ text: WIDE.repeat(240), source: sources[id] }], lastResult: [{ text: WIDE.repeat(240), source: sources[id] }] });
  }
  const summary = summarize(f);
  assertShape(summary);
  assert.deepStrictEqual(summary.works[0].pending.items.map(i => i.text), ['Aguardando decisão sobre o formato', 'Aceite do UAT pendente']);
  assert(summary.works[0].pending.items.every(i => !i.truncated));
  assert.strictEqual(summary.attention, null, 'only non-mandatory content was reduced');
  const optional = summary.works.slice(1).flatMap(w => [w.nextAction, w.lastResult]).filter(Boolean);
  assert(optional.every(item => Array.from(item.text).length <= 80), 'non-mandatory text reduced to 80 first');
  assert(summary.omitted.works + summary.omitted.nextAction + summary.omitted.lastResult >= 0);
});

test('MH-04 acceptances: superseded resolved capture stays closed; an unresolved recapture reopens it', f => {
  const { source } = f.work('TASK-001'); f.bind('TASK-001');
  const accept = resolved => save(f, 'TASK-001', { acceptances: [{ text: 'Aceite do plano', source, resolved }] });
  accept(true);
  assert.strictEqual(summarize(f).totals.acceptances, 0);
  accept(false);
  let summary = summarize(f);
  assert.strictEqual(summary.totals.acceptances, 1);
  assert.strictEqual(summary.works[0].acceptances.items[0].text, 'Aceite do plano');
  assert.strictEqual(summary.works[0].workStatus, 'pending');
  accept(true);
  summary = summarize(f);
  assert.strictEqual(summary.totals.acceptances, 0);
  assert.deepStrictEqual(summary.works[0].acceptances, { total: 0, items: [] });
  assert.strictEqual(personal.effectiveAcceptances(personal.readPersonalSnapshot(f.options).works[0].checkpoint.acceptances).length, 1);
});

test('MH-04 completed milestone: historical next_action never becomes actionable', f => {
  const milestone = f.work('M005', 'milestone'); f.bind('M005');
  fs.writeFileSync(milestone.source, '---\nmilestone: M005\nkind: milestone\nstatus: done\n---\n**Phase:** idle\n**Next Action:** Plan slice historical\n');
  const snapshot = personal.readPersonalSnapshot(f.options).works[0];
  assert.strictEqual(snapshot.workStatus, 'completed');
  assert.strictEqual(snapshot.nextAction.text, 'Plan slice historical', 'fixture keeps historical prose in the snapshot');
  const summary = summarize(f);
  assert.strictEqual(summary.works[0].workStatus, 'completed');
  assert.strictEqual(summary.works[0].nextAction, null);
  assert(!JSON.stringify(summary).includes('Plan slice historical'));
});

test('MH-04 validity: stale becomes historical, missing stays missing, EISDIR and reconciliation become uncertain', f => {
  const { dir } = f.work('TASK-001'); f.bind('TASK-001');
  const evidence = path.join(dir, 'continue.md');
  fs.writeFileSync(evidence, 'Handoff original');
  save(f, 'TASK-001', { pending: [{ text: 'UAT aguardando ambiente', source: evidence }],
    nextAction: [{ text: 'Validar UAT', source: evidence }], lastResult: [{ text: 'Implementação verificada', source: evidence }] });
  let work = summarize(f).works[0];
  assert.strictEqual(work.pending.items[0].validity, 'current');
  assert.strictEqual(work.pending.items[0].source.toLowerCase(), '.gsd/tasks/task-001/continue.md');
  assert.strictEqual(work.lastResult.text, 'Implementação verificada');
  fs.appendFileSync(evidence, 'changed');
  work = summarize(f).works[0];
  assert.strictEqual(work.pending.items[0].validity, 'historical');
  assert.strictEqual(work.reliability, 'needs-reconciliation');
  assert.deepStrictEqual({ ...work.nextAction }, { text: 'Reconcile changed or missing sources; preserve recorded acceptances.',
    source: null, validity: 'uncertain', reason: 'reconciliation-required' });
  assert.strictEqual(work.lastResult, null, 'lastResult is the snapshot\'s current result');
  assert.strictEqual(work.diagnostic, 'forge-personal-context.js --snapshot --id TASK-001');
  fs.unlinkSync(evidence);
  const missing = summarize(f);
  assert.strictEqual(missing.works[0].pending.items[0].validity, 'missing');
  assertPrivate(f, JSON.stringify(missing));
  fs.mkdirSync(evidence);
  const directory = summarize(f);
  assert.strictEqual(directory.works[0].pending.items[0].validity, 'uncertain');
  assertShape(directory);
  assertPrivate(f, JSON.stringify(directory));
});

test('MH-03 sources: worktree alias and foreign sources leave as null with sourceOutside', f => {
  const { source } = f.work('TASK-001'); f.bind('TASK-001');
  const alias = path.join(f.root, 'alias-worktree');
  fs.mkdirSync(alias);
  const aliasPath = process.platform === 'win32' ? fs.realpathSync(alias).toLowerCase() : fs.realpathSync(alias);
  fixtureAliases.add(aliasPath);
  const store = JSON.parse(fs.readFileSync(storeFile(f), 'utf8'));
  const project = Object.values(store.projects)[0];
  project.aliases.push({ repo: project.path, path: aliasPath, branch: 'fixture-alias' });
  fs.writeFileSync(storeFile(f), JSON.stringify(store, null, 2) + '\n');
  const aliasFile = path.join(alias, 'handoff.md');
  fs.writeFileSync(aliasFile, 'alias evidence');
  save(f, 'TASK-001', { pending: [{ text: 'Pendente no worktree', source: aliasFile }, { text: 'Pendente no projeto', source }] });
  // A foreign absolute source can only reach the store by editing it; it must
  // still never print the path or the raw safeSource diagnostic.
  const edited = JSON.parse(fs.readFileSync(storeFile(f), 'utf8'));
  const binding = Object.values(edited.projects)[0].bindings['TASK-001'];
  const foreign = { ...binding.checkpoint.pending[1], text: 'Fonte estrangeira', source: path.join(f.otherHome, 'secret.md') };
  binding.checkpoint.pending.push(foreign);
  fs.writeFileSync(storeFile(f), JSON.stringify(edited, null, 2) + '\n');
  const summary = summarize(f);
  assertShape(summary);
  const [inAlias, inProject, outside] = summary.works[0].pending.items;
  assert.deepStrictEqual({ ...inAlias }, { text: 'Pendente no worktree', source: null, validity: 'current', sourceOutside: true });
  assert.strictEqual(inProject.source.toLowerCase(), '.gsd/tasks/task-001/task-001-plan.md');
  assert.deepStrictEqual({ ...outside }, { text: 'Fonte estrangeira', source: null, validity: 'uncertain', sourceOutside: true });
  assertPrivate(f, JSON.stringify(summary));
});

test('MH-02 sentinels: handoff, resolved pending, resolved acceptance, hashes and raw errors stay private', f => {
  const { dir, source } = f.work('TASK-001'); f.bind('TASK-001');
  const secret = path.join(dir, 'continue.md');
  fs.writeFileSync(secret, 'token=SENTINEL-CREDENTIAL');
  save(f, 'TASK-001', {
    handoff: [{ text: 'SENTINEL-HANDOFF token=abc', source: secret }],
    pending: [{ text: 'SENTINEL-RESOLVED-PENDING', source, resolved: true }, { text: 'Pendente real', source }],
    acceptances: [{ text: 'SENTINEL-ACCEPTED', source, resolved: true }],
  });
  const json = renderPersonalSummary({ cwd: f.project, userHome: f.home }).json;
  for (const sentinel of ['SENTINEL-HANDOFF', 'SENTINEL-RESOLVED-PENDING', 'SENTINEL-ACCEPTED', 'SENTINEL-CREDENTIAL', 'token=']) {
    assert(!json.includes(sentinel), `sentinel leaked: ${sentinel}`);
  }
  assert(json.includes('Pendente real'));
  fs.unlinkSync(source);
  const missing = renderPersonalSummary({ cwd: f.project, userHome: f.home }).json;
  assertPrivate(f, missing);
  assert(!missing.includes('no such file'));
});

test('MH-09 errors: closed reasons, no message/file/path, diagnostic and exit 1, never no-bindings', f => {
  f.work('TASK-001'); f.bind('TASK-001');
  const before = fs.readFileSync(storeFile(f));
  const cases = [
    ['{broken', 'corrupt'],
    ['{"schemaVersion":99,"projects":{}}', 'schema-unsupported'],
    ['{"schemaVersion":1,"projects":{"invalid":{}}}', 'schema-invalid'],
  ];
  for (const [content, reason] of cases) {
    fs.writeFileSync(storeFile(f), content);
    const summary = summarize(f);
    assertShape(summary);
    assert.deepStrictEqual([summary.status, summary.reason], ['error', reason]);
    assert.strictEqual(renderPersonalSummary({ cwd: f.project, userHome: f.home }).exitCode, 1);
    assertPrivate(f, JSON.stringify(summary));
  }
  fs.writeFileSync(storeFile(f), before);
  const read = fs.readFileSync;
  fs.readFileSync = function (file) {
    if (String(file) === storeFile(f)) throw Object.assign(new Error(`denied ${file}`), { code: 'EACCES' });
    return read.apply(this, arguments);
  };
  let unreadable;
  try { unreadable = summarize(f); } finally { fs.readFileSync = read; }
  assert.strictEqual(unreadable.reason, 'unreadable');
  assertPrivate(f, JSON.stringify(unreadable));
  const unresolved = summarize(f, { cwd: f.root });
  assert.deepStrictEqual([unresolved.status, unresolved.reason], ['error', 'project-unresolved']);
  assert.strictEqual(summarize(f, { project: 'wc' }).reason, 'project-unanchored');
  for (const id of ['../../escape', true, '']) {
    const invalid = summarize(f, { id });
    assertShape(invalid);
    assert.strictEqual(invalid.reason, 'invalid-id');
  }
  const redirected = path.join(f.root, 'redirected-home'); fs.mkdirSync(redirected);
  fs.symlinkSync(path.join(f.otherHome), path.join(redirected, '.forge-personal'), process.platform === 'win32' ? 'junction' : 'dir');
  const namespace = summarize(f, { userHome: redirected });
  assert.deepStrictEqual([namespace.status, namespace.reason], ['error', 'namespace-invalid']);
  assertPrivate(f, JSON.stringify(namespace));
  assert.deepStrictEqual(fs.readFileSync(storeFile(f)), before);
});

test('MH-09 isolation: no STATE, colleague run or other profile is read; sentinel never printed', f => {
  f.work('TASK-001'); f.work('TASK-002');
  fs.writeFileSync(path.join(f.project, '.gsd', 'STATE.md'), 'SENTINEL-TEAM-STATE: TASK-002');
  f.bind('TASK-001'); f.bind('TASK-002', { userHome: f.otherHome });
  const original = fs.readFileSync;
  const forbidden = [];
  fs.readFileSync = function (file) {
    const value = String(file);
    if (value.includes('TASK-002') || value.endsWith(`${path.sep}STATE.md`) || value.startsWith(f.otherHome)) forbidden.push(value);
    return original.apply(this, arguments);
  };
  let summary;
  try { summary = summarize(f); } finally { fs.readFileSync = original; }
  assert.deepStrictEqual(forbidden, []);
  assert.deepStrictEqual(summary.works.map(w => w.id), ['TASK-001']);
  assert(!JSON.stringify(summary).includes('SENTINEL-TEAM-STATE'));
});

test('MH-10/16 CLI: both entry points print the same single compact line; --json is inert; snapshot unchanged', f => {
  const { source } = f.work('TASK-001'); f.bind('TASK-001');
  save(f, 'TASK-001', { pending: [{ text: 'Pendente', source }] });
  const expected = renderPersonalSummary({ cwd: f.project, userHome: f.home }).json + '\n';
  for (const [script, args] of [
    [CONTEXT_CLI, ['--summary', '--cwd', f.project]],
    [CONTEXT_CLI, ['--json', '--summary', '--cwd', f.project]],
    [CONTEXT_CLI, ['--summary', '--json', '--cwd', f.project]],
    [CONTEXT_CLI, ['--summary', '--cwd', f.project, '--json']],
    [SUMMARY_CLI, ['--cwd', f.project]],
    [SUMMARY_CLI, ['--json', '--cwd', f.project]],
  ]) {
    const result = cli(f, script, args);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, expected, `${path.basename(script)} ${args.join(' ')}`);
    assert.strictEqual(result.stdout.split('\n').length, 2, 'one JSON line');
    assert(Buffer.byteLength(result.stdout, 'utf8') <= 4096);
  }
  const invalid = cli(f, CONTEXT_CLI, ['--summary', '--id', '../x', '--cwd', f.project]);
  assert.strictEqual(invalid.status, 1);
  assert.strictEqual(JSON.parse(invalid.stdout).reason, 'invalid-id');
  const snapshot = JSON.stringify(personal.readPersonalSnapshot({ cwd: f.project, userHome: f.home }), null, 2) + '\n';
  for (const args of [['--snapshot', '--cwd', f.project], ['--snapshot', '--cwd', f.project, '--json'], ['--json', '--snapshot', '--cwd', f.project]]) {
    const result = cli(f, CONTEXT_CLI, args);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, snapshot, `snapshot changed: ${args.join(' ')}`);
  }
});

test('MH-16 conflicts: --summary with a producer, selector or snapshot fails closed before touching stores', f => {
  const { dir, source } = f.work('TASK-001'); f.work('TASK-002'); f.bind('TASK-001');
  const payload = path.join(dir, 'checkpoint.json');
  fs.writeFileSync(payload, JSON.stringify({ pending: [{ text: 'não gravar', source }] }));
  const before = fs.readFileSync(storeFile(f));
  const freshHome = path.join(f.root, 'fresh');
  for (const args of [
    ['--summary', '--bind', '--id', 'TASK-002', '--intent', 'create', '--project', f.project],
    ['--bind', '--summary', '--id', 'TASK-002', '--intent', 'create', '--project', f.project],
    ['--summary', '--checkpoint', '--id', 'TASK-001', '--intent', 'checkpoint', '--file', payload, '--project', f.project],
    ['--summary', '--select', '--cwd', f.project],
    ['--snapshot', '--summary', '--cwd', f.project],
  ]) {
    for (const home of [f.home, freshHome]) {
      const result = cli(f, CONTEXT_CLI, args, home);
      assert.strictEqual(result.status, 1, args.join(' '));
      assert.strictEqual(result.stdout.split('\n').length, 2);
      const parsed = JSON.parse(result.stdout);
      assert.deepStrictEqual([parsed.status, parsed.reason, parsed.scope], ['error', 'summary-command-conflict', 'summary']);
    }
  }
  const own = cli(f, SUMMARY_CLI, ['--bind', '--id', 'TASK-002', '--intent', 'create', '--project', f.project]);
  assert.strictEqual(JSON.parse(own.stdout).reason, 'summary-command-conflict');
  assert.deepStrictEqual(fs.readFileSync(storeFile(f)), before, 'a conflicting call changed the store');
  assert(!fs.existsSync(freshHome), 'a conflicting call created a profile');
  const legacy = cli(f, CONTEXT_CLI, ['--bind', '--id', 'TASK-002', '--intent', 'create', '--project', f.project]);
  assert.strictEqual(legacy.status, 0, legacy.stdout);
  assert.strictEqual(JSON.parse(legacy.stdout).reason, 'bound', 'calls without --summary keep their semantics');
});

test('MH-11 boot block: the real bash block of commands/forge.md prints a bounded summary, never the snapshot', f => {
  const { source } = f.work('TASK-001'); f.bind('TASK-001');
  save(f, 'TASK-001', { pending: [{ text: 'Pendente do boot', source }] });
  const boot = fs.readFileSync(path.join(ROOT, 'commands', 'forge.md'), 'utf8').replace(/\r\n/g, '\n');
  const block = boot.match(/```bash\n([\s\S]*?)```/)[1];
  assert(block.includes('--summary --cwd "$WORKING_DIR"'));
  assert(!block.includes('--snapshot'), 'boot block must not print the full snapshot');
  const shell = bash();
  assert(process.platform !== 'win32' || fs.existsSync(shell), `bash required for this check: ${shell}`);
  const result = spawnSync(shell, ['-c', block], { encoding: 'utf8', windowsHide: true, cwd: ROOT,
    env: { ...f.env(), WORKING_DIR: f.project.replace(/\\/g, '/') } });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert(Buffer.byteLength(result.stdout, 'utf8') <= 4096);
  const parsed = JSON.parse(result.stdout);
  assert.strictEqual(parsed.scope, 'summary');
  assert.strictEqual(parsed.works[0].pending.items[0].text, 'Pendente do boot');
  assertPrivate(f, result.stdout);
});

isolation.validateWorktreeIdentity = validateWorktreeIdentity;
if (failed) {
  console.log(`FAIL personal summary: ${failed} failing test(s)`);
  process.exitCode = 1;
} else console.log('PASS personal summary: allowlist, sources, Unicode, order, byte ladder, attention, errors, CLI and boot block');
