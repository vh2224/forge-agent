#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('./forge-doctor.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }

function fakeCli() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-cap-Ω-'));
  const file = path.join(root, 'fake cli.js');
  fs.writeFileSync(file, "if (process.argv.includes('--version')) process.stdout.write('3.2.0\\n'); else if (process.argv.includes('--help')) process.stdout.write('help\\n');");
  return { root, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('capability check passes selected Claude with a fake CLI and leaves Codex unselected', () => {
  const fake = fakeCli();
  try {
    const result = doctor.checkCapabilities(path.resolve(__dirname, '..'), {
      runtime: 'claude',
      binaries: { claude: { command: process.execPath, args: [fake.file] }, codex: { command: process.execPath, args: [fake.file] } },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.failures.length, 0);
    assert.strictEqual(result.probes.codex.reason_code, 'not-selected');
  } finally { fake.cleanup(); }
});

test('capability check fails required missing host without attempting optional fallback', () => {
  const fake = fakeCli();
  try {
    const result = doctor.checkCapabilities(path.resolve(__dirname, '..'), {
      runtime: 'codex',
      binaries: { codex: path.join(fake.root, 'not-found'), claude: { command: process.execPath, args: [fake.file] } },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.failures.map((entry) => entry.id), ['codex']);
    assert.strictEqual(result.failures[0].reason_code, 'missing');
    assert.strictEqual(result.probes.claude.reason_code, 'not-selected');
  } finally { fake.cleanup(); }
});

test('capability check result and reason ordering are deterministic', () => {
  const fake = fakeCli();
  try {
    const options = { runtime: 'claude', binaries: { claude: { command: process.execPath, args: [fake.file] } } };
    const left = JSON.stringify(doctor.checkCapabilities(path.resolve(__dirname, '..'), options));
    const right = JSON.stringify(doctor.checkCapabilities(path.resolve(__dirname, '..'), options));
    assert.strictEqual(left, right);
  } finally { fake.cleanup(); }
});

test('help advertises the capabilities check and selected runtime', () => {
  const out = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-doctor.js'), '--help'], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0);
  assert.match(out.stdout, /capabilities/);
  assert.match(out.stdout, /--runtime/);
});

// R1 (review dialetico, conceded): an errored `memory-quarantine` result carries
// `{ pending: 0, skipped: 'error: ...' }` — rendering ✓ there communicates a clean
// quarantine at exactly the moment the state was never measured. Assert the RENDERED
// icon, not the result shape: the bug lived in `formatResults`, not in the check.
test('memory-quarantine that could not be measured renders warn, never check', () => {
  const rendered = doctor.formatResults([{
    check: 'memory-quarantine',
    ok: true,
    pending: 0,
    files: [],
    skipped: 'error: boom',
    message: 'forge-doctor: erro ao ler a quarentena de memoria (boom) — advisory, nao bloqueia.',
  }]);
  assert.ok(rendered.includes('⚠ Advisory — Memory quarantine'), `unmeasured quarantine must render warn, got: ${rendered}`);
  assert.ok(!rendered.includes('✓ Advisory — Memory quarantine'), `unmeasured quarantine must not render check, got: ${rendered}`);
});

test('memory-quarantine measured clean still renders check', () => {
  const rendered = doctor.formatResults([{ check: 'memory-quarantine', ok: true, pending: 0, files: [], message: 'clean' }]);
  assert.ok(rendered.includes('✓ Advisory — Memory quarantine'), `measured-clean quarantine must render check, got: ${rendered}`);
});

test('help advertises explicit claim recovery and restore surfaces', () => {
  const out = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-doctor.js'), '--help'], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0);
  assert.match(out.stdout, /--recover-claim/);
  assert.match(out.stdout, /--confirm-owner-stopped/);
  assert.match(out.stdout, /--confirm-workspace-quiescent/);
  assert.match(out.stdout, /--restore-claim/);
});

function capabilityCase({ probes = {}, requiredFailures = [], catalog = [], adapters = { codex: {} } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-findings-'));
  const forgeHome = path.join(root, 'forge');
  fs.mkdirSync(forgeHome);
  fs.writeFileSync(path.join(forgeHome, 'manifest.json'), JSON.stringify({ adapters }));
  const available = id => ({ id, status: 'available', reason_code: 'available' });
  const options = { runtime: 'codex', forgeHome,
    binaries: { claude: path.join(root, 'missing-claude'), codex: path.join(root, 'missing-codex') },
    detectCapabilities: () => ({ runtime: 'codex', required_failures: requiredFailures,
      probes: { node: available('node'), codex: available('codex'), claude: { id: 'claude', status: 'skipped', reason_code: 'not-selected' }, ...probes } }),
    catalog: { capabilities: catalog } };
  return { root, forgeHome, check: () => doctor.checkCapabilities(root, options), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const fatalCatalog = ['hooks', 'headless', 'mcp'].map((name, index) => ({
  capability_id: `operational-${name}`, kind: ['hook', 'headless', 'mcp'][index], required: true, hosts: { codex: 'planned' },
}));
const expectedFatal = fatalCatalog.map(row => ({ capability_id: row.capability_id, host: 'codex', status: 'planned', reason_code: 'required-capability-missing' }));

test('fatal catalog findings are reported even when every required probe is available', () => {
  const data = capabilityCase({ catalog: fatalCatalog });
  try {
    const result = data.check();
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(result.fatal_count, 3, result.message);
    assert.deepStrictEqual(result.capability_failures, expectedFatal);
    assert.strictEqual(result.diagnostics.filter(row => row.severity === 'fatal').length, 3);
    assert.strictEqual(result.message, 'Capabilities codex: 0 runtime probe failure(s); 3 fatal diagnostic(s), including 3 capability finding(s) not covered by probes; see diagnostics.');
    const text = doctor.formatResults([result]);
    const heading = text.indexOf('Fatal capability findings not covered by probes:');
    assert(heading >= 0);
    let previous = heading;
    for (const row of expectedFatal) {
      const index = text.indexOf(`${row.capability_id} [codex]: planned (required-capability-missing)`);
      assert(index > previous); previous = index;
    }
    const json = JSON.stringify(result);
    assert.strictEqual(json, JSON.stringify(data.check()));
    assert(!json.includes(data.forgeHome) && !json.includes(data.root));
  } finally { data.cleanup(); }
});

test('mixed probe and catalog failures retain distinct overlapping counts', () => {
  const probe = { id: 'codex', status: 'missing', reason_code: 'missing' };
  const data = capabilityCase({ probes: { codex: probe }, requiredFailures: ['codex'], catalog: fatalCatalog });
  try {
    const result = data.check();
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.failures, [probe]);
    assert.strictEqual(result.fatal_count, 4);
    assert.deepStrictEqual(result.capability_failures, expectedFatal);
    assert.match(result.message, /1 runtime probe failure\(s\); 4 fatal diagnostic\(s\), including 3 capability finding\(s\)/);
    const text = doctor.formatResults([result]);
    assert(text.indexOf('codex: missing (missing)') < text.indexOf('Fatal capability findings'));
  } finally { data.cleanup(); }
});

test('installation-only fatal diagnostics cannot disappear from the summary', () => {
  const data = capabilityCase({ adapters: { claude: {} } });
  try {
    const result = data.check();
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(result.fatal_count, 1);
    assert.deepStrictEqual(result.capability_failures, [{ capability_id: 'installed-adapter', host: 'codex', status: 'missing', reason_code: 'adapter-missing' }]);
    assert.match(result.message, /0 runtime probe failure\(s\); 1 fatal diagnostic\(s\), including 1 capability finding\(s\)/);
    assert.match(doctor.formatResults([result]), /installed-adapter \[codex\]: missing \(adapter-missing\)/);
  } finally { data.cleanup(); }
});

test('success and conditional warnings preserve the legacy presentation', () => {
  const optional = { capability_id: 'optional-app', kind: 'app', required: false, hosts: { codex: 'unavailable' } };
  const good = capabilityCase({ catalog: [...fatalCatalog.map(row => ({ ...row, hosts: { codex: 'implemented' } })), optional] });
  const bad = capabilityCase({ catalog: [...fatalCatalog, optional] });
  try {
    const success = good.check(), failure = bad.check();
    assert.strictEqual(success.ok, true);
    assert.strictEqual(success.fatal_count, 0);
    assert.deepStrictEqual(success.capability_failures, []);
    assert.strictEqual(success.message, `Capabilities codex: required capabilities available (${success.warnings.length} conditional warning(s)).`);
    assert.deepStrictEqual(success.warnings, failure.warnings);
    for (const result of [success, failure]) {
      assert(result.diagnostics.some(row => row.capability === 'optional-app' && row.severity === 'warning'));
      assert(!result.capability_failures.some(row => row.capability_id === 'optional-app'));
      assert(!doctor.formatResults([result]).includes('not-selected'));
    }
    assert(!doctor.formatResults([success]).includes('Fatal capability findings'));
  } finally { good.cleanup(); bad.cleanup(); }
});


// #381: actual CLI previews must leave the COMPLETE project tree byte/metadata-identical.
const doctor381Root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-dryrun-')));
const doctor381Script = path.join(__dirname, 'forge-doctor.js');
const doctor381Env = require('./run-tests.js').childEnv(path.join(doctor381Root, 'isolated-home'), 'forge-doctor.test.js');
const doctor381ForgeHome = path.join(doctor381Root, 'forge-home');fs.mkdirSync(doctor381ForgeHome);
fs.cpSync(path.join(__dirname, '..', 'shared'), path.join(doctor381ForgeHome, 'shared'), { recursive: true });
Object.assign(doctor381Env, { FORGE_HOME: doctor381ForgeHome });
function doctor381Snapshot(root) {
 const rows = [];
 function visit(relative) {
  const file = path.join(root, relative), stat = fs.lstatSync(file);assert(!stat.isSymbolicLink());
  rows.push({ path: relative.replace(/\\/g, '/'), type: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode,
    size: stat.isFile() ? stat.size : null, mtime: stat.mtimeMs, bytes: stat.isFile() ? fs.readFileSync(file).toString('base64') : null });
  if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
 }
 visit('');return rows;
}
function doctor381Run(root, args) {
 return require('child_process').spawnSync(process.execPath, [doctor381Script, '--cwd', root, ...args],
  { cwd: root, env: doctor381Env, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
}
function doctor381Fixture(name, setup, action) {
 const root = fs.mkdtempSync(path.join(doctor381Root, name + '-'));setup(root);
 try { action(root); }
 finally { const relative = path.relative(doctor381Root, fs.realpathSync.native(root));assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));fs.rmSync(root, { recursive: true, force: true }); }
}
function doctor381Monoliths(root) {
 fs.mkdirSync(path.join(root, '.gsd'));
 fs.writeFileSync(path.join(root, '.gsd', 'LEDGER.md'), '## M-20260101000000-preview — Preview milestone\n\n**Slices:** S01\n\n**Key files:** scripts/forge-doctor.js\n\n**Key decisions:** D12\n');
 fs.writeFileSync(path.join(root, '.gsd', 'DECISIONS.md'), '# Forge Decisions Log\n\n| # | When | Scope | Decision | Choice | Rationale | Revisable? |\n|---|------|-------|----------|--------|-----------|------------|\n| 1 | 2026-01-01 | M-20260101000000-preview | Keep preview read-only | Yes | Safety | No |\n');
 fs.writeFileSync(path.join(root, '.gsd', 'AUTO-MEMORY.md'), '# Forge Auto-Memory\n\n- [MEM001] (convention) confidence:0.90 hits:3 — Preview entry\n  source: task/T01 | updated: 2026-01-01\n');
}
test('#381 --fix --dry-run does not even create missing .gsd; real --fix still applies', () => {
 doctor381Fixture('missing', () => {}, root => {
  const before = doctor381Snapshot(root), dry = doctor381Run(root, ['--fix', '--dry-run']);assert.strictEqual(dry.status, 0, dry.stderr);
  assert.deepStrictEqual(doctor381Snapshot(root), before);assert.match(dry.stdout, /dry-run; no files written/);assert.match(dry.stdout, /Would create/);assert(!fs.existsSync(path.join(root, '.gsd')));
  const applied = doctor381Run(root, ['--fix']);assert.strictEqual(applied.status, 0, applied.stderr);assert.strictEqual(fs.readFileSync(path.join(root, '.gsd', 'SCHEMA-VERSION'), 'utf8'), doctor.CURRENT_SCHEMA + '\n');
 });
});
test('#381 existing missing, outdated and current schema previews preserve all project bytes and timestamps', () => {
 for (const current of [null, '0.0.1\n', doctor.CURRENT_SCHEMA + '\n']) doctor381Fixture('existing', root => {
  fs.mkdirSync(path.join(root, '.gsd'));if(current !== null)fs.writeFileSync(path.join(root, '.gsd', 'SCHEMA-VERSION'), current);fs.writeFileSync(path.join(root, '.gsd', 'sentinel.json'), '{"retained":true}\n');
 }, root => { const before = doctor381Snapshot(root), dry = doctor381Run(root, ['--fix', '--dry-run']);assert.strictEqual(dry.status, 0, dry.stderr);assert.deepStrictEqual(doctor381Snapshot(root), before);assert.match(dry.stdout, /dry-run; no files written/);assert(current === doctor.CURRENT_SCHEMA + '\n' ? dry.stdout.includes('already at') : dry.stdout.includes(current === null ? 'Would create' : 'Would update')); });
});
test('#381 unmigrated preview without --migrate preserves the refusal and original monoliths', () => {
 doctor381Fixture('refusal', doctor381Monoliths, root => {const before = doctor381Snapshot(root), dry = doctor381Run(root, ['--fix', '--dry-run']);assert.strictEqual(dry.status, 1);assert.match(dry.stdout, /Refusing to stamp/);assert.match(dry.stdout, /dry-run; no files written/);assert.deepStrictEqual(doctor381Snapshot(root), before);});
});
test('#381 --fix --migrate --dry-run forwards true to real migrations; actual apply still migrates', () => {
 doctor381Fixture('migrate', doctor381Monoliths, root => {
  const before = doctor381Snapshot(root), dry = doctor381Run(root, ['--fix', '--migrate', '--dry-run']);assert.strictEqual(dry.status, 0, dry.stderr);assert.deepStrictEqual(doctor381Snapshot(root), before);
  assert.match(dry.stdout, /dry-run; no files written/);for(const store of ['ledger','decisions','memory'])assert.match(dry.stdout, new RegExp(store + ': [1-9][0-9]* fragment\\(s\\) would be written'));
  assert(!dry.stdout.includes('SCHEMA-VERSION stamped:'));assert(!fs.existsSync(path.join(root, '.gsd', 'SCHEMA-VERSION')));
  const applied = doctor381Run(root, ['--fix', '--migrate']);assert.strictEqual(applied.status, 0, applied.stderr);assert.match(applied.stdout, /ledger: [1-9][0-9]* fragment\(s\) written/);assert.strictEqual(fs.readFileSync(path.join(root, '.gsd', 'SCHEMA-VERSION'), 'utf8'), doctor.CURRENT_SCHEMA + '\n');assert(fs.existsSync(path.join(root, '.gsd', 'LEDGER.md.bak')));
 });
});
test('#381 migration preview preserves an existing backup and every other file', () => {
 doctor381Fixture('backup', root => {doctor381Monoliths(root);fs.copyFileSync(path.join(root, '.gsd', 'LEDGER.md'), path.join(root, '.gsd', 'LEDGER.md.bak'));}, root => {const before = doctor381Snapshot(root), dry = doctor381Run(root, ['--fix', '--migrate', '--dry-run']);assert.strictEqual(dry.status, 0, dry.stderr);assert.deepStrictEqual(doctor381Snapshot(root), before);assert.match(dry.stdout, /would be written/);});
});
test('#381 unknown fix modifiers, malformed dry-run values and unsupported action mixes refuse before writes', () => {
 const invalid = [['--fix','--dry-rnu'],['--fix','--dry-run=false'],['--fix','--dry-run','false'],['--fix','--dry-run','--regen-projection'],['--fix','--dry-run','--recover-claim','M001','--apply'],['--regen-projection','--dry-run']];
 for(const args of invalid)doctor381Fixture('invalid', () => {}, root => {const before = doctor381Snapshot(root), result = doctor381Run(root,args);assert.strictEqual(result.status,2,result.stdout+result.stderr);assert.deepStrictEqual(doctor381Snapshot(root),before);});
});
// The suite owns only this fresh disposable root; every child was synchronously joined.
assert(path.basename(doctor381Root).startsWith('forge-doctor-dryrun-'));fs.rmSync(doctor381Root, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, 0 failed\n`);
