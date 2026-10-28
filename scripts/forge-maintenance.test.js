#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const maintenance = require('./forge-maintenance.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function fixture(runtime = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-maintenance-'));
  const forgeHome = path.join(root, 'forge');
  const claudeHome = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(forgeHome, { recursive: true });
  fs.writeFileSync(path.join(forgeHome, 'manifest.json'), JSON.stringify({ version: '3.1.4', adapters: { [runtime]: {} } }));
  return { root, forgeHome, claudeHome, codexHome, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function detector(runtime, overrides = {}) {
  const available = (id) => ({ id, status: 'available', reason_code: 'available' });
  return () => ({ runtime, ok: true, required_failures: [], probes: { node: available('node'), claude: available('claude'), codex: available('codex'), ...overrides } });
}
function guardedFs(forbidden) {
  const guard = (file) => { if (path.resolve(String(file)).startsWith(path.resolve(forbidden))) throw new Error(`forbidden access: ${file}`); };
  return {
    existsSync(file) { guard(file); return fs.existsSync(file); },
    readFileSync(file, encoding) { guard(file); return fs.readFileSync(file, encoding); },
  };
}

test('codex-only discovery and diagnostics never access Claude home', () => {
  const data = fixture('codex');
  try {
    const report = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome, claudeHome: data.claudeHome, codexHome: data.codexHome, fs: guardedFs(data.claudeHome), detectCapabilities: detector('codex'), catalog: { capabilities: [] } });
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.selected, ['codex']);
  } finally { data.cleanup(); }
});

test('manifest detection keeps codex-only update codex-only', () => {
  const data = fixture('codex');
  try {
    const plan = maintenance.planUpdate({ forgeHome: data.forgeHome, claudeHome: data.claudeHome, fs: guardedFs(data.claudeHome) });
    assert.strictEqual(plan.runtime, 'codex');
    assert.deepStrictEqual(plan.installer_args, ['--runtime', 'codex', '--update']);
  } finally { data.cleanup(); }
});

test('required and conditional capability reasons have different fatality', () => {
  const data = fixture('claude');
  try {
    const catalog = { capabilities: [
      { capability_id: 'required-gap', kind: 'headless', required: true, hosts: { claude: 'planned' }, probe: { kind: 'filesystem', path: 'missing-required' } },
      { capability_id: 'optional-gap', kind: 'app', required: false, hosts: { claude: 'unavailable' }, probe: { kind: 'filesystem', path: 'missing-optional' } },
      { capability_id: 'operational-hooks', kind: 'hook', required: true, hosts: { claude: 'implemented' }, probe: { kind: 'filesystem', path: 'scripts/forge-hook.js' } },
    ] };
    const report = maintenance.diagnose({ runtime: 'claude', forgeHome: data.forgeHome, claudeHome: data.claudeHome, detectCapabilities: detector('claude'), hookTrust: { claude: false }, catalog });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.diagnostics.find((x) => x.capability === 'required-gap').reason_code, 'required-capability-missing');
    assert.strictEqual(report.diagnostics.find((x) => x.capability === 'optional-gap').reason_code, 'conditional-capability-unavailable');
    const hook = report.diagnostics.find((x) => x.capability === 'operational-hooks');
    assert.strictEqual(hook.reason_code, 'conditional-capability-unavailable');
    assert.strictEqual(hook.severity, 'warning');
  } finally { data.cleanup(); }
});

test('schema 1.1.0 states: demonstrated is available, distributed is non-fatal, unknown is fail-closed when required', () => {
  const data = fixture('codex');
  try {
    const row = (id, kind, required, status) => ({ capability_id: id, kind, required, hosts: { codex: status }, probe: { kind: 'filesystem', path: 'scripts/forge-hook.js' } });
    const catalog = { capabilities: [
      row('demonstrated-required', 'headless', true, 'demonstrated'),
      row('distributed-required', 'headless', true, 'distributed'),
      row('distributed-optional', 'mcp', false, 'distributed'),
      row('unknown-optional', 'mcp', false, 'unknown'),
    ] };
    const report = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome, detectCapabilities: detector('codex'), catalog });
    const byId = new Map(report.diagnostics.map((item) => [item.capability, item]));
    assert.deepStrictEqual([byId.get('demonstrated-required').status, byId.get('demonstrated-required').reason_code, byId.get('demonstrated-required').severity], ['available', 'available', 'info']);
    for (const id of ['distributed-required', 'distributed-optional']) {
      assert.strictEqual(byId.get(id).reason_code, 'capability-not-demonstrated', id);
      assert.strictEqual(byId.get(id).status, 'distributed', id);
      assert.strictEqual(byId.get(id).severity, 'warning', id);
    }
    assert.strictEqual(byId.get('unknown-optional').severity, 'warning');
    assert.strictEqual(byId.get('unknown-optional').status, 'unknown');
    assert.strictEqual(report.ok, true, 'distributed and optional unknown never become fatal');

    const required = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome, detectCapabilities: detector('codex'), catalog: { capabilities: [row('unknown-required', 'headless', true, 'unknown')] } });
    const unknown = required.diagnostics.find((item) => item.capability === 'unknown-required');
    assert.strictEqual(required.ok, false);
    assert.deepStrictEqual([unknown.status, unknown.reason_code, unknown.severity], ['unknown', 'required-capability-unknown', 'fatal']);

    // A distributed surface whose projected source is absent is still a required gap.
    const absent = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome, detectCapabilities: detector('codex'), catalog: { capabilities: [{ ...row('distributed-absent', 'headless', true, 'distributed'), probe: { kind: 'filesystem', path: 'definitely-absent' } }] } });
    assert.strictEqual(absent.diagnostics.find((item) => item.capability === 'distributed-absent').reason_code, 'required-capability-missing');
    assert.strictEqual(absent.ok, false);
  } finally { data.cleanup(); }
});

test('required unknown remains fatal when hook trust is disabled', () => {
  const data = fixture('codex');
  try {
    for (const trusted of [true, false]) {
      const catalog = { capabilities: [{ capability_id: 'required-unknown-hook', kind: 'hook', required: true,
        hosts: { codex: 'unknown' }, probe: { kind: 'filesystem', path: 'scripts/forge-hook.js' } }] };
      const report = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome,
        detectCapabilities: detector('codex'), hookTrust: { codex: trusted }, catalog });
      const finding = report.diagnostics.find((item) => item.capability === 'required-unknown-hook');
      assert.strictEqual(report.ok, false, `trust=${trusted}`);
      assert.deepStrictEqual([finding.status, finding.reason_code, finding.severity],
        ['unknown', 'required-capability-unknown', 'fatal'], `trust=${trusted}`);
    }
  } finally { data.cleanup(); }
});

test('schema 1.1.0 keeps planned, conditional, implemented and common semantics', () => {
  const data = fixture('codex');
  try {
    const row = (id, kind, required, status) => ({ capability_id: id, kind, required, hosts: { codex: status }, probe: { kind: 'filesystem', path: 'scripts/forge-hook.js' } });
    const report = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome, detectCapabilities: detector('codex'), catalog: { capabilities: [
      row('planned-required', 'headless', true, 'planned'),
      row('planned-optional', 'mcp', false, 'planned'),
      row('conditional-required', 'statusline', true, 'conditional'),
      row('implemented-required', 'headless', true, 'implemented'),
      row('common-required', 'headless', true, 'common'),
    ] } });
    const byId = new Map(report.diagnostics.map((item) => [item.capability, item]));
    assert.deepStrictEqual([byId.get('planned-required').reason_code, byId.get('planned-required').severity], ['required-capability-missing', 'fatal']);
    assert.deepStrictEqual([byId.get('planned-optional').reason_code, byId.get('planned-optional').severity], ['conditional-capability-unavailable', 'warning']);
    assert.deepStrictEqual([byId.get('conditional-required').reason_code, byId.get('conditional-required').severity], ['conditional-capability-unavailable', 'warning']);
    assert.strictEqual(byId.get('implemented-required').reason_code, 'available');
    assert.strictEqual(byId.get('common-required').reason_code, 'available');
  } finally { data.cleanup(); }
});

test('core and adapter failures have stable explicit reasons', () => {
  const data = fixture('codex');
  try {
    const report = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome, detectCapabilities: detector('codex', {
      node: { id: 'node', status: 'unsupported', reason_code: 'minimum-version' },
      codex: { id: 'codex', status: 'missing', reason_code: 'missing' },
    }), catalog: { capabilities: [] } });
    assert(report.diagnostics.some((x) => x.reason_code === 'core-incompatible'));
    assert(report.diagnostics.some((x) => x.reason_code === 'adapter-missing'));
  } finally { data.cleanup(); }
});

for (const platform of require('./fixtures/runtime-maintenance/platforms.json').platforms) {
  test(`${platform} remains offline and selected-home local`, () => {
    const data = fixture('codex');
    try {
      const report = maintenance.diagnose({ platform, runtime: 'codex', forgeHome: data.forgeHome, claudeHome: data.claudeHome, fs: guardedFs(data.claudeHome), detectCapabilities: detector('codex'), catalog: { capabilities: [] } });
      assert.strictEqual(report.ok, true);
    } finally { data.cleanup(); }
  });
}

process.stdout.write(`\n${passed} passed, 0 failed\n`);
