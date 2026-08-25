#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child = require('child_process');
const audit = require('./forge-route-audit');

let passed = 0;
let skipped = 0;
const SKIP = Symbol('skip');
const symlinkUnavailable = (error) => ['EPERM', 'EACCES', 'UNKNOWN'].includes(error && error.code);
function test(name, fn) {
  if (fn() === SKIP) { skipped++; process.stdout.write(`⊘ ${name} (file symlink unavailable)\n`); }
  else { passed++; process.stdout.write(`✓ ${name}\n`); }
}
function event(eventName, extra) { return { event: eventName, milestone: 'M127', slice: 'S03', unit: 'execute-task/T01', ...extra }; }

test('fallback aggregation retains a single composite unit and both engines', () => {
  const units = audit.aggregateUnits([event('dispatch', { engine: 'codex' }), event('worker-engine-fallback', { reason: 'timeout', hint: 'tente Claude' }), event('dispatch', { engine: 'claude' })], { milestone: 'M127', slice: 'S03' });
  assert.equal(units.length, 1); assert.equal(units[0].engine_final, 'claude');
  assert.deepEqual(units[0].engine_attempted, ['codex', 'claude']); assert.equal(units[0].fallback_reason, 'timeout');
});
test('chain walk without fallback is drift signal b', () => {
  const unit = audit.aggregateUnits([event('dispatch', { engine: 'codex' }), event('dispatch', { engine: 'claude' })], { milestone: 'M127', slice: 'S03' })[0];
  assert.equal(audit.classifyUnit(unit).drift, true);
});
test('missing engine remains undefined and aliases normalize', () => {
  assert.equal(audit.normalizeEngine(undefined), undefined); assert.equal(audit.normalizeEngine('gpt'), 'codex'); assert.equal(audit.normalizeEngine('gemini'), 'gemini');
});
test('composite key does not merge matching unit names across milestones', () => {
  const units = audit.aggregateUnits([event('dispatch', { engine: 'codex' }), { ...event('dispatch', { engine: 'claude' }), milestone: 'M128' }], { milestone: 'M127', slice: 'S03' });
  assert.equal(units.length, 1); assert.equal(units[0].engine_final, 'codex');
});
test('strict scope never treats blank or absent fields as wildcards', () => {
  assert.equal(audit.inScope({ slice: 'S03' }, { slice: 'S03', milestone: 'M127' }), false);
  assert.equal(audit.aggregateUnits([event('dispatch', { engine: 'codex' })], { slice: '', milestone: '-' }).length, 0);
});
test('drift comes only from the two signals, so a clean single dispatch never drifts', () => {
  // No dedicated tier_models term exists: absent a fallback and a chain walk, drift is false for ANY
  // route_source, and a fallback under tier_models still drifts (a suppressing term would hide it).
  for (const source of ['tier_models', 'routing', undefined]) {
    const clean = audit.aggregateUnits([event('dispatch', { engine: 'claude', route_source: source })], { milestone: 'M127', slice: 'S03' })[0];
    assert.equal(audit.classifyUnit(clean).drift, false);
  }
  const tierModelsFallback = audit.aggregateUnits([event('dispatch', { engine: 'claude', route_source: 'tier_models' }), event('worker-engine-fallback', { reason: 'codex-timeout' })], { milestone: 'M127', slice: 'S03' })[0];
  assert.equal(audit.classifyUnit(tierModelsFallback).drift, true);
  const other = audit.aggregateUnits([event('dispatch', { engine: 'codex' }), event('dispatch-fallback', { reason: 'nope' })], { milestone: 'M127', slice: 'S03' })[0];
  assert.equal(audit.classifyUnit(other).drift, false);
});
test('route formatting uses event hint only and excludes plans from denominator', () => {
  const units = audit.aggregateUnits([event('dispatch', { engine: 'codex' }), event('worker-engine-fallback', { reason: 'x', hint: 'aspas " seguras' }), event('dispatch', { engine: 'claude' }), { ...event('dispatch', { engine: 'claude' }), unit: 'plan-slice/S03' }], { milestone: 'M127', slice: 'S03' }).map(audit.classifyUnit);
  const md = audit.formatRouteMd({ units, task_units: units.filter(x => x.unit.startsWith('execute-task/')), plan_units: units.filter(x => x.unit.startsWith('plan-slice/')), drift_units: units.filter(x => x.drift), configured_route: {} });
  assert(md.includes('hint: aspas " seguras')); assert(md.includes('0/1 tasks')); assert(md.includes('Planos: 1'));
});
test('upsert is idempotent and exact Route heading does not consume Route Notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-')); const gsd = path.join(dir, '.gsd'); fs.mkdirSync(gsd);
  const summary = path.join(gsd, 'S03-SUMMARY.md'); fs.writeFileSync(summary, '# x\n\n## Forward Intelligence\nkeep\n');
  const section = '## Route\n\n- ok\n'; audit.upsertRouteSection(summary, section, dir); const once = fs.readFileSync(summary, 'utf8'); audit.upsertRouteSection(summary, section, dir);
  assert.equal(fs.readFileSync(summary, 'utf8'), once); assert.equal((once.match(/^## Route$/gm) || []).length, 1); assert(once.indexOf('## Route') < once.indexOf('## Forward Intelligence'));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('CLI tolerates corrupt JSONL and always returns JSON exit zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-')); const events = path.join(dir, 'events.jsonl'); fs.writeFileSync(events, '{broken\n' + JSON.stringify(event('dispatch', { engine: 'codex' })) + '\n');
  const r = child.spawnSync(process.execPath, [path.join(__dirname, 'forge-route-audit.js'), '--slice', 'S03', '--milestone', 'M127', '--cwd', dir, '--events', events, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).units.length, 1); fs.rmSync(dir, { recursive: true, force: true });
});
test('audit of an absent stream reports a stable zero-unit Route section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-'));
  const result = audit.auditSlice({ cwd: dir, slice: 'S03', milestone: 'M127' });
  assert.equal(result.units.length, 0);
  assert(audit.formatRouteMd(result).includes('0 tasks com dispatch registrado nesta slice'));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('RUN_ID is an alias of its own milestone and never of another one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-'));
  fs.mkdirSync(path.join(dir, '.gsd', 'forge', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'forge', 'runs', 'M127.json'),
    JSON.stringify({ kind: 'milestone', id: 'M127', session_id: 's', active: true, milestone_dir: '.gsd/milestones/M-2026-pagamentos/' }));
  const eventFile = path.join(dir, 'events.jsonl');
  fs.writeFileSync(eventFile, [
    // Same unit under both spellings: emitters write ${RUN_ID:-{M###}}, the completer queries {M###}.
    JSON.stringify({ event: 'dispatch', milestone: 'M127', slice: 'S03', unit: 'execute-task/T01', engine: 'gpt' }),
    JSON.stringify({ event: 'worker-engine-fallback', milestone: 'M-2026-pagamentos', slice: 'S03', unit: 'execute-task/T01', reason: 'codex-timeout' }),
    JSON.stringify({ event: 'dispatch', milestone: 'M999', slice: 'S03', unit: 'execute-task/T09', engine: 'claude' }),
  ].join('\n') + '\n');
  const result = audit.auditSlice({ cwd: dir, slice: 'S03', milestone: 'M-2026-pagamentos', eventsFile: eventFile });
  assert.equal(result.units.length, 1);                       // the unrelated M999 is NOT borrowed
  assert.equal(result.units[0].unit, 'execute-task/T01');
  assert.equal(result.units[0].engine_final, 'codex');
  assert.equal(result.units[0].fallback, true);               // both spellings folded into one unit
  assert.equal(audit.milestoneAliases(dir, 'M-2026-pagamentos').has('M127'), true);
  assert.equal(audit.milestoneAliases(dir, 'M999').size, 0);
  const miss = audit.auditSlice({ cwd: dir, slice: 'S03', milestone: 'M404', eventsFile: eventFile });
  assert.equal(miss.units.length, 0);                         // no evidence is the truthful answer
  assert(audit.formatRouteMd(miss).includes('0 tasks com dispatch registrado nesta slice'));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('write guard refuses a missing summary and a symlink without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-'));
  const gsd = path.join(dir, '.gsd');
  fs.mkdirSync(gsd);
  const missing = audit.upsertRouteSection(path.join(gsd, 'missing.md'), '## Route\n', dir);
  assert.equal(missing.written, false);
  const real = path.join(dir, 'real.md');
  const link = path.join(gsd, 'link.md');
  fs.writeFileSync(real, 'x\n');
  try { fs.symlinkSync(real, link); }
  catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (symlinkUnavailable(error)) return SKIP;
    throw error;
  }
  assert.equal(audit.upsertRouteSection(link, '## Route\n', dir).written, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('only recognized lifecycle events create audit units', () => {
  const units = audit.aggregateUnits([
    { milestone: 'M127', slice: 'S03', unit: 'execute-task/T01', event: 'worker-result', engine: 'claude' },
    { milestone: 'M127', slice: 'S03', unit: 'execute-task/T02' },
  ], { milestone: 'M127', slice: 'S03' });
  assert.deepEqual(units, []);
});

test('task sentence and drift count share one denominator', () => {
  const tasks = ['T01', 'T02', 'T03'].map(id => ({ unit: `execute-task/${id}`, engine_attempted: ['claude'], engine_final: 'claude', fallback: false })).map(audit.classifyUnit);
  const plan = audit.classifyUnit({ unit: 'plan-slice/S03', engine_attempted: ['codex', 'claude'], engine_final: 'claude', fallback: false });
  const md = audit.formatRouteMd({ units: [...tasks, plan], task_units: tasks, plan_units: [plan], drift_units: [plan], configured_route: {} });
  assert(md.includes('rota configurada rodou em 3/3 tasks.'), md);   // no "3/3 tasks; 1 drift" contradiction
  assert(md.includes('Planos: 1 unidade(s) plan-slice fora do denominador de tasks; 1 drift(s) observado(s).'), md);
});
test('a CRLF summary keeps its own line endings outside the Route section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-'));
  const gsd = path.join(dir, '.gsd'); fs.mkdirSync(gsd);
  const summary = path.join(gsd, 'S03-SUMMARY.md');
  const original = '# x\r\n\r\n## Forward Intelligence\r\nkeep\r\n';
  fs.writeFileSync(summary, original);
  audit.upsertRouteSection(summary, '## Route\n\n- ok\n', dir);
  const once = fs.readFileSync(summary, 'utf8');
  assert(once.includes('## Forward Intelligence\r\nkeep\r\n'), 'neighbour bytes untouched');
  assert.equal((once.match(/(?<!\r)\n/g) || []).length, 0, 'no bare LF introduced');
  audit.upsertRouteSection(summary, '## Route\n\n- ok\n', dir);
  assert.equal(fs.readFileSync(summary, 'utf8'), once, 'still idempotent on CRLF');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('formatter always begins with the exact Route anchor', () => {
  const result = { units: [], task_units: [], drift_units: [], plan_units: [], configured_route: {} };
  const markdown = audit.formatRouteMd(result);
  assert(markdown.startsWith('## Route\n'));
  assert.equal(markdown.split('## Route').length - 1, 1);
});
test('normalization rejects unknown casing and values', () => {
  const cases = [
    ['Claude', undefined],
    ['gpt-5', undefined],
    ['', undefined],
    [null, undefined],
    ['claude', 'claude'],
  ];
  for (const [input, output] of cases) assert.equal(audit.normalizeEngine(input), output);
});
process.stdout.write(`${passed} route-audit tests passed, ${skipped} skipped\n`);
