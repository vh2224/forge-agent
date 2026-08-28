#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const child = require('child_process');
const audit = require('./forge-route-audit');

let passed = 0;
let skipped = 0;
const SKIP = Symbol('skip');
const symlinkUnavailable = (error) => ['EPERM', 'EACCES', 'UNKNOWN'].includes(error && error.code);
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
function test(name, fn) {
  if (fn() === SKIP) { skipped++; process.stdout.write(`⊘ ${name} (file symlink unavailable)\n`); }
  else { passed++; process.stdout.write(`✓ ${name}\n`); }
}
function event(eventName, extra) { return { event: eventName, milestone: 'M127', slice: 'S03', unit: 'execute-task/T01', ...extra }; }
function withTempWorld(fn) {
  const dir = fs.mkdtempSync(path.join(WORKSPACE_ROOT, '.route-audit-test-'));
  try { return fn(dir); }
  finally {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), WORKSPACE_ROOT, 'fixture cleanup stays inside workspace');
    assert(path.basename(resolved).startsWith('.route-audit-test-'), 'fixture cleanup has a narrow target');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
function writeEvents(file, events, tail) {
  fs.writeFileSync(file, events.map(item => JSON.stringify(item)).join('\n') + (tail === undefined ? '\n' : tail));
}
function resultFor(units) {
  const classified = units.map(audit.classifyUnit);
  return {
    units: classified,
    task_units: classified.filter(item => item.unit.startsWith('execute-task/')),
    plan_units: classified.filter(item => item.unit.startsWith('plan-slice/')),
    drift_units: classified.filter(item => item.drift),
    configured_route: {},
  };
}

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
test('four host-worker quadrants expose complete snapshots, coverage and stable unit lines', () => {
  const events = [
    event('dispatch', { unit: 'execute-task/T01', engine: 'claude', host_runtime: 'claude', worker_mode: 'native', dispatch_allowed: true }),
    event('dispatch', { unit: 'execute-task/T02', engine: 'codex', host_runtime: 'claude', worker_mode: 'sidecar', dispatch_allowed: true }),
    event('dispatch', { unit: 'execute-task/T03', engine: 'claude', host_runtime: 'codex', worker_mode: 'sidecar', dispatch_allowed: false }),
    event('dispatch', { unit: 'execute-task/T04', engine: 'codex', host_runtime: 'codex', worker_mode: 'native', dispatch_allowed: true }),
  ];
  const units = audit.aggregateUnits(events, { milestone: 'M127', slice: 'S03' });
  assert.deepEqual(units.map(unit => ({
    unit: unit.unit,
    host_runtime: unit.host_runtime,
    worker_engine: unit.worker_engine,
    worker_mode: unit.worker_mode,
    dispatch_allowed: unit.dispatch_allowed,
  })), [
    { unit: 'execute-task/T01', host_runtime: 'claude', worker_engine: 'claude', worker_mode: 'native', dispatch_allowed: true },
    { unit: 'execute-task/T02', host_runtime: 'claude', worker_engine: 'codex', worker_mode: 'sidecar', dispatch_allowed: true },
    { unit: 'execute-task/T03', host_runtime: 'codex', worker_engine: 'claude', worker_mode: 'sidecar', dispatch_allowed: false },
    { unit: 'execute-task/T04', host_runtime: 'codex', worker_engine: 'codex', worker_mode: 'native', dispatch_allowed: true },
  ]);
  assert.deepEqual(audit.runtimeCoverage(units), {
    total: 4, complete: 4, incomplete: 0,
    missing: { host_runtime: 0, worker_engine: 0, worker_mode: 0, dispatch_allowed: 0 },
  });
  const md = audit.formatRouteMd(resultFor(units));
  assert(md.includes('Cobertura runtime: 4/4 completas; 0 unidade(s) incompleta(s)'));
  assert.equal((md.match(/^- Runtime /gm) || []).length, 4);
  assert(md.includes('Runtime execute-task/T01: host=claude; worker=claude; mode=native; allowed=true.'));
  assert(md.includes('Runtime execute-task/T02: host=claude; worker=codex; mode=sidecar; allowed=true.'));
  assert(md.includes('Runtime execute-task/T03: host=codex; worker=claude; mode=sidecar; allowed=false.'));
  assert(md.includes('Runtime execute-task/T04: host=codex; worker=codex; mode=native; allowed=true.'));
});
test('dispatch_allowed false and other explicit falsy values are present evidence', () => {
  const unit = audit.aggregateUnits([
    event('dispatch', { engine: 'codex', host_runtime: '', worker_mode: '-', dispatch_allowed: false }),
  ], { milestone: 'M127', slice: 'S03' })[0];
  const coverage = audit.runtimeCoverage([unit]);
  assert.equal(coverage.complete, 1);
  assert.equal(coverage.missing.dispatch_allowed, 0);
  assert.equal(unit.dispatch_allowed, false);
  const md = audit.formatRouteMd(resultFor([unit]));
  assert(md.includes('host=; worker=codex; mode=-; allowed=false.'), md);
  assert.deepEqual(audit.runtimeCoverage([{ host_runtime: '', worker_engine: '-', worker_mode: '', dispatch_allowed: false }]), {
    total: 1, complete: 1, incomplete: 0,
    missing: { host_runtime: 0, worker_engine: 0, worker_mode: 0, dispatch_allowed: 0 },
  });
});
test('runtime evidence is never inherited between neighbouring units', () => {
  const units = audit.aggregateUnits([
    event('dispatch', { unit: 'execute-task/T01', engine: 'claude', host_runtime: 'claude', worker_mode: 'native', dispatch_allowed: true }),
    event('dispatch', { unit: 'execute-task/T02', engine: 'codex' }),
  ], { milestone: 'M127', slice: 'S03' });
  assert.equal(units[0].host_runtime, 'claude');
  assert.deepEqual({
    host_runtime: units[1].host_runtime,
    worker_engine: units[1].worker_engine,
    worker_mode: units[1].worker_mode,
    dispatch_allowed: units[1].dispatch_allowed,
  }, { host_runtime: undefined, worker_engine: 'codex', worker_mode: undefined, dispatch_allowed: undefined });
  assert.deepEqual(audit.runtimeCoverage(units), {
    total: 2, complete: 1, incomplete: 1,
    missing: { host_runtime: 1, worker_engine: 0, worker_mode: 1, dispatch_allowed: 1 },
  });
});
test('latest dispatch replaces the whole runtime snapshot instead of merging attempts', () => {
  const unit = audit.aggregateUnits([
    event('dispatch', { engine: 'claude', host_runtime: 'claude', worker_mode: 'native', dispatch_allowed: true }),
    event('dispatch', { engine: 'codex' }),
  ], { milestone: 'M127', slice: 'S03' })[0];
  assert.deepEqual(unit.engine_attempted, ['claude', 'codex']);
  assert.deepEqual({
    host_runtime: unit.host_runtime,
    worker_engine: unit.worker_engine,
    worker_mode: unit.worker_mode,
    dispatch_allowed: unit.dispatch_allowed,
  }, { host_runtime: undefined, worker_engine: 'codex', worker_mode: undefined, dispatch_allowed: undefined });
  assert.deepEqual(audit.runtimeCoverage([unit]), {
    total: 1, complete: 0, incomplete: 1,
    missing: { host_runtime: 1, worker_engine: 0, worker_mode: 1, dispatch_allowed: 1 },
  });
});
test('fallback events alter fallback evidence only, never the runtime snapshot', () => {
  const unit = audit.aggregateUnits([
    event('dispatch', { engine: 'claude', host_runtime: 'codex', worker_mode: 'sidecar', dispatch_allowed: false }),
    event('worker-engine-fallback', { engine: 'codex', host_runtime: 'claude', worker_mode: 'native', dispatch_allowed: true, reason: 'timeout' }),
  ], { milestone: 'M127', slice: 'S03' })[0];
  assert.deepEqual({
    host_runtime: unit.host_runtime,
    worker_engine: unit.worker_engine,
    worker_mode: unit.worker_mode,
    dispatch_allowed: unit.dispatch_allowed,
  }, { host_runtime: 'codex', worker_engine: 'claude', worker_mode: 'sidecar', dispatch_allowed: false });
  assert.equal(unit.fallback, true);
});
test('legacy logs render every unit and count each absent runtime axis exactly', () => {
  const units = audit.aggregateUnits([
    event('dispatch', { unit: 'execute-task/T01', engine: 'claude' }),
    event('dispatch', { unit: 'execute-task/T02', engine: 'gpt' }),
    event('dispatch', { unit: 'plan-slice/S03', engine: 'gemini' }),
  ], { milestone: 'M127', slice: 'S03' });
  assert.deepEqual(units.map(unit => unit.worker_engine), ['claude', 'codex', 'gemini']);
  assert.deepEqual(audit.runtimeCoverage(units), {
    total: 3, complete: 0, incomplete: 3,
    missing: { host_runtime: 3, worker_engine: 0, worker_mode: 3, dispatch_allowed: 3 },
  });
  const md = audit.formatRouteMd(resultFor(units));
  assert(md.includes('0/3 completas; 3 unidade(s) incompleta(s)'));
  assert.equal((md.match(/host=ausente; worker=(?:claude|codex|gemini); mode=ausente; allowed=ausente\./g) || []).length, 3, md);
  assert.equal((md.match(/^- Runtime /gm) || []).length, 3, 'clean plan and task units are all visible');
});
test('missing and unknown event engines stay absent without prefs or Claude fallback', () => {
  const units = audit.aggregateUnits([
    event('dispatch', { unit: 'execute-task/T01', host_runtime: 'claude', worker_mode: 'native', dispatch_allowed: true }),
    event('dispatch', { unit: 'execute-task/T02', engine: 'future-engine', host_runtime: 'codex', worker_mode: 'sidecar', dispatch_allowed: true }),
  ], { milestone: 'M127', slice: 'S03' });
  assert.deepEqual(units.map(unit => unit.worker_engine), [undefined, undefined]);
  assert.deepEqual(audit.runtimeCoverage(units), {
    total: 2, complete: 0, incomplete: 2,
    missing: { host_runtime: 0, worker_engine: 2, worker_mode: 0, dispatch_allowed: 0 },
  });
  const md = audit.formatRouteMd(resultFor(units));
  assert.equal((md.match(/worker=ausente/g) || []).length, 2, md);
});
test('upsert is idempotent and exact Route heading does not consume Route Notes', () => {
  withTempWorld(dir => {
    const gsd = path.join(dir, '.gsd'); fs.mkdirSync(gsd);
    const summary = path.join(gsd, 'S03-SUMMARY.md'); fs.writeFileSync(summary, '# x\n\n## Forward Intelligence\nkeep\n');
    const section = '## Route\n\n- ok\n'; audit.upsertRouteSection(summary, section, dir); const once = fs.readFileSync(summary, 'utf8'); audit.upsertRouteSection(summary, section, dir);
    assert.equal(fs.readFileSync(summary, 'utf8'), once); assert.equal((once.match(/^## Route$/gm) || []).length, 1); assert(once.indexOf('## Route') < once.indexOf('## Forward Intelligence'));
  });
});
test('CLI tolerates corrupt JSONL and always returns JSON exit zero', () => {
  withTempWorld(dir => {
    const events = path.join(dir, 'events.jsonl'); fs.writeFileSync(events, '{broken\n' + JSON.stringify(event('dispatch', { engine: 'codex' })) + '\n{"event":"dis');
    const r = child.spawnSync(process.execPath, [path.join(__dirname, 'forge-route-audit.js'), '--slice', 'S03', '--milestone', 'M127', '--cwd', dir, '--events', events, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).units.length, 1);
  });
});
test('CLI writes idempotent four-quadrant and legacy Route demos with parseable JSON', () => {
  withTempWorld(dir => {
    const scenarios = [
      {
        name: 'quadrants',
        events: [
          event('dispatch', { unit: 'execute-task/T01', engine: 'claude', host_runtime: 'claude', worker_mode: 'native', dispatch_allowed: true }),
          event('dispatch', { unit: 'execute-task/T02', engine: 'codex', host_runtime: 'claude', worker_mode: 'sidecar', dispatch_allowed: true }),
          event('dispatch', { unit: 'execute-task/T03', engine: 'claude', host_runtime: 'codex', worker_mode: 'sidecar', dispatch_allowed: false }),
          event('dispatch', { unit: 'execute-task/T04', engine: 'codex', host_runtime: 'codex', worker_mode: 'native', dispatch_allowed: true }),
        ],
        expected: { total: 4, complete: 4, incomplete: 0 },
      },
      {
        name: 'legacy',
        events: [
          event('dispatch', { unit: 'execute-task/T01', engine: 'claude' }),
          event('dispatch', { unit: 'execute-task/T02', engine: 'codex' }),
        ],
        expected: { total: 2, complete: 0, incomplete: 2 },
      },
    ];
    for (const scenario of scenarios) {
      const cwd = path.join(dir, scenario.name);
      const gsd = path.join(cwd, '.gsd');
      fs.mkdirSync(gsd, { recursive: true });
      const eventsFile = path.join(cwd, 'events.jsonl');
      const summary = path.join(gsd, 'S03-SUMMARY.md');
      writeEvents(eventsFile, scenario.events);
      fs.writeFileSync(summary, '# Summary\n\n## Route Notes\nkeep\n\n## Forward Intelligence\nkeep too\n');
      const args = [path.join(__dirname, 'forge-route-audit.js'), '--slice', 'S03', '--milestone', 'M127', '--cwd', cwd, '--events', eventsFile, '--write', summary, '--json'];
      const first = child.spawnSync(process.execPath, args, { cwd: WORKSPACE_ROOT, encoding: 'utf8' });
      assert.equal(first.status, 0, first.stderr);
      const result = JSON.parse(first.stdout);
      assert.equal(result.units.length, scenario.expected.total);
      assert.equal(result.runtime_coverage.total, scenario.expected.total);
      assert.equal(result.runtime_coverage.complete, scenario.expected.complete);
      assert.equal(result.runtime_coverage.incomplete, scenario.expected.incomplete);
      assert.equal(result.write.written, true);
      const once = fs.readFileSync(summary, 'utf8');
      assert.equal((once.match(/^## Route$/gm) || []).length, 1, once);
      assert(once.includes(`Cobertura runtime: ${scenario.expected.complete}/${scenario.expected.total} completas`), once);
      assert(once.includes('## Route Notes\nkeep'), 'similarly named neighbouring section survives');
      if (scenario.name === 'quadrants') assert(once.includes('allowed=false'));
      else {
        assert(once.includes('host=ausente; worker=claude; mode=ausente; allowed=ausente.'));
        assert(once.includes('host=ausente; worker=codex; mode=ausente; allowed=ausente.'));
      }
      const second = child.spawnSync(process.execPath, args, { cwd: WORKSPACE_ROOT, encoding: 'utf8' });
      assert.equal(second.status, 0, second.stderr);
      JSON.parse(second.stdout);
      assert.equal(fs.readFileSync(summary, 'utf8'), once, `${scenario.name} write converges byte for byte`);
    }
  });
});
test('audit of an absent stream reports a stable zero-unit Route section', () => {
  withTempWorld(dir => {
    const result = audit.auditSlice({ cwd: dir, slice: 'S03', milestone: 'M127' });
    assert.equal(result.units.length, 0);
    assert.deepEqual(result.runtime_coverage, { total: 0, complete: 0, incomplete: 0, missing: { host_runtime: 0, worker_engine: 0, worker_mode: 0, dispatch_allowed: 0 } });
    const md = audit.formatRouteMd(result);
    assert(md.includes('0 tasks com dispatch registrado nesta slice'));
    assert(md.includes('Cobertura runtime: 0/0 completas'));
  });
});
test('RUN_ID is an alias of its own milestone and never of another one', () => {
  withTempWorld(dir => {
    fs.mkdirSync(path.join(dir, '.gsd', 'forge', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gsd', 'forge', 'runs', 'M127.json'),
      JSON.stringify({ kind: 'milestone', id: 'M127', session_id: 's', active: true, milestone_dir: '.gsd/milestones/M-2026-pagamentos/' }));
    const eventFile = path.join(dir, 'events.jsonl');
    writeEvents(eventFile, [
      // Same unit under both spellings: emitters write ${RUN_ID:-{M###}}, the completer queries {M###}.
      { event: 'dispatch', milestone: 'M127', slice: 'S03', unit: 'execute-task/T01', engine: 'gpt' },
      { event: 'worker-engine-fallback', milestone: 'M-2026-pagamentos', slice: 'S03', unit: 'execute-task/T01', reason: 'codex-timeout' },
      { event: 'dispatch', milestone: 'M999', slice: 'S03', unit: 'execute-task/T09', engine: 'claude' },
    ]);
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
  });
});
test('write guard refuses a missing summary and a symlink without throwing', () => {
  return withTempWorld(dir => {
    const gsd = path.join(dir, '.gsd');
    fs.mkdirSync(gsd);
    const missing = audit.upsertRouteSection(path.join(gsd, 'missing.md'), '## Route\n', dir);
    assert.equal(missing.written, false);
    const real = path.join(dir, 'real.md');
    const link = path.join(gsd, 'link.md');
    fs.writeFileSync(real, 'x\n');
    const outside = audit.upsertRouteSection(real, '## Route\n\n- forbidden\n', dir);
    assert.deepEqual(outside, { written: false, reason: 'outside-gsd' });
    assert.equal(fs.readFileSync(real, 'utf8'), 'x\n', 'outside target stays byte-identical');
    try { fs.symlinkSync(real, link); }
    catch (error) {
      if (symlinkUnavailable(error)) return SKIP;
      throw error;
    }
    assert.equal(audit.upsertRouteSection(link, '## Route\n', dir).written, false);
  });
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
  withTempWorld(dir => {
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
  });
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
