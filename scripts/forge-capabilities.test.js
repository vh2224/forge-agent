#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const api = require('./forge-capabilities.js');
const codexRenderer = require('./forge-codex-renderer.js');

const REPO = path.resolve(__dirname, '..');
let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capabilities-'));
  fs.mkdirSync(path.join(root, 'schemas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'forge-sample'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'forge-sample', 'SKILL.md'), '---\nname: sample\n---\n');
  fs.writeFileSync(path.join(root, 'agents', 'forge-sample.md'), '---\nname: sample\n---\n');
  fs.writeFileSync(path.join(root, 'commands', 'forge-sample.md'), 'sample\n');
  const schema = {
    $defs: { host: { enum: ['claude', 'codex'] } },
  };
  const capability = (id, kind, probe) => ({
    capability_id: id, kind, owner: 'test-owner', required: true, classification: 'conditional',
    hosts: { claude: 'implemented', codex: 'planned' }, probe: { kind: 'filesystem', path: probe },
  });
  const catalog = {
    $schema: 'schemas/forge-capabilities.schema.json', schema_version: '1.0.0',
    release: { product_version_source: 'git-tag-release-workflow', adapters: { claude: { optional: true, host: 'claude' }, codex: { optional: true, host: 'codex' } } },
    capabilities: [
      capability('skill-forge-sample', 'skill', 'skills/forge-sample/SKILL.md'),
      capability('agent-forge-sample', 'agent', 'agents/forge-sample.md'),
      capability('command-forge-sample', 'command', 'commands/forge-sample.md'),
    ],
  };
  fs.writeFileSync(path.join(root, 'forge-capabilities.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, 'schemas', 'forge-capabilities.schema.json'), JSON.stringify(schema));
  return { root, catalog, schema, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function has(issues, text) { assert(issues.some((item) => item.includes(text)), `expected issue containing ${text}; got ${issues.join('; ')}`); }

test('loads the repository catalog and runtime-backed schema', () => {
  const loaded = api.loadCatalog(path.resolve(__dirname, '..'));
  assert.strictEqual(loaded.catalog.schema_version, '1.1.0');
  assert.deepStrictEqual(loaded.schema.$defs.host.enum, ['claude', 'codex']);
});
test('AVAILABILITY and reason codes mirror the schema 1.1.0 enums', () => {
  const loaded = api.loadCatalog(REPO);
  assert.deepStrictEqual([...api.AVAILABILITY], loaded.schema.$defs.availability.enum);
  assert.deepStrictEqual([...api.AVAILABILITY], ['implemented', 'planned', 'conditional', 'unavailable', 'common', 'distributed', 'demonstrated', 'unknown']);
  assert.deepStrictEqual([...api.REASON_CODES], loaded.schema.$defs.reason_code.enum);
  assert.deepStrictEqual(loaded.catalog.reason_codes, [...api.REASON_CODES]);
  for (const code of ['capability-observed', 'capability-absent']) assert(api.REASON_CODES.includes(code), code);
});
test('no repository entry is demonstrated and no evidence is declared in this release', () => {
  const { catalog } = api.loadCatalog(REPO);
  for (const entry of catalog.capabilities) {
    assert.strictEqual(entry.evidence, undefined, entry.capability_id);
    for (const host of ['claude', 'codex']) assert.notStrictEqual(entry.hosts[host], 'demonstrated', `${entry.capability_id}/${host}`);
  }
});
test('host CLIs have no generic floor while Node keeps 18.0.0', () => {
  const { catalog } = api.loadCatalog(REPO);
  assert.strictEqual(catalog.runtimes.node.minimum_version, '18.0.0');
  assert.strictEqual(catalog.runtimes.claude.minimum_version, undefined);
  assert.strictEqual(catalog.runtimes.codex.minimum_version, undefined);
  assert.deepStrictEqual(catalog.runtimes.claude.capability_probes.map((probe) => probe.id), ['claude-stream-json']);
  assert.deepStrictEqual(catalog.runtimes.codex.capability_probes.map((probe) => probe.id), ['codex-app-server', 'codex-exec-json']);
  const rows = api.matrix(catalog);
  assert.strictEqual(rows.find((row) => row.capability_id === 'runtime-claude').minimum_version, null);
  assert.strictEqual(rows.find((row) => row.capability_id === 'runtime-codex').minimum_version, null);
  assert.deepStrictEqual(rows.find((row) => row.capability_id === 'runtime-codex').capability_probes, ['codex-app-server', 'codex-exec-json']);
});
test('repository audit has complete discovered coverage', () => {
  const result = api.audit(path.resolve(__dirname, '..'));
  assert.deepStrictEqual(result.issues, []);
  assert(result.discovered.length >= 42);
});
test('all published skills have catalog entries', () => {
  const result = api.audit(path.resolve(__dirname, '..'));
  for (const surface of result.discovered.filter((entry) => entry.kind === 'skill')) assert(result.catalog.capabilities.some((entry) => entry.probe.path === surface.path));
});
test('all published agents have catalog entries', () => {
  const result = api.audit(path.resolve(__dirname, '..'));
  for (const surface of result.discovered.filter((entry) => entry.kind === 'agent')) assert(result.catalog.capabilities.some((entry) => entry.probe.path === surface.path));
});
test('all published commands have catalog entries', () => {
  const result = api.audit(path.resolve(__dirname, '..'));
  for (const surface of result.discovered.filter((entry) => entry.kind === 'command')) assert(result.catalog.capabilities.some((entry) => entry.probe.path === surface.path));
});
test('fixture audit accepts a classified filesystem inventory', () => {
  const data = fixture();
  try { assert.deepStrictEqual(api.audit(data.root).issues, []); } finally { data.cleanup(); }
});
test('audit rejects an omitted discovered surface', () => {
  const data = fixture();
  try { data.catalog.capabilities.pop(); fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); has(api.audit(data.root).issues, 'published command missing'); } finally { data.cleanup(); }
});
test('audit rejects duplicate capability ids', () => {
  const data = fixture();
  try { data.catalog.capabilities.push(clone(data.catalog.capabilities[0])); has(api.validateCatalog(data.catalog, data.schema), 'duplicate capability_id'); } finally { data.cleanup(); }
});
test('audit rejects duplicate probe paths', () => {
  const data = fixture();
  try { data.catalog.capabilities[1].probe.path = data.catalog.capabilities[0].probe.path; fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); has(api.audit(data.root).issues, 'duplicate probe path'); } finally { data.cleanup(); }
});
test('audit rejects an invalid host classification', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].hosts.codex = 'green'; has(api.validateCatalog(data.catalog, data.schema), 'invalid codex classification'); } finally { data.cleanup(); }
});
test('schema definitions do not contain duplicate keys', () => {
  const schemaText = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'schemas', 'forge-capabilities.schema.json'), 'utf8');
  assert.strictEqual((schemaText.match(/"reason_code"\s*:/g) || []).length, 1);
});
test('audit rejects a missing or invalid explicit classification', () => {
  const data = fixture();
  try {
    delete data.catalog.capabilities[0].classification;
    has(api.validateCatalog(data.catalog, data.schema), 'classification must be one of');
  } finally { data.cleanup(); }
});
test('audit rejects unknown host keys', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].hosts.agy = 'planned'; has(api.validateCatalog(data.catalog, data.schema), 'hosts: unknown key agy'); } finally { data.cleanup(); }
});
test('audit rejects an invalid host enum in the schema', () => {
  const data = fixture();
  try { data.schema.$defs.host.enum = ['claude']; has(api.validateCatalog(data.catalog, data.schema), 'host enum drifted'); } finally { data.cleanup(); }
});
test('audit rejects a missing owner', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].owner = ''; has(api.validateCatalog(data.catalog, data.schema), 'owner is required'); } finally { data.cleanup(); }
});
test('audit rejects an invalid capability id', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].capability_id = 'Bad_ID'; has(api.validateCatalog(data.catalog, data.schema), 'invalid capability_id'); } finally { data.cleanup(); }
});
test('audit rejects an invalid capability kind', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].kind = 'widget'; has(api.validateCatalog(data.catalog, data.schema), 'invalid kind'); } finally { data.cleanup(); }
});
test('audit rejects an invalid required marker', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].required = 'true'; has(api.validateCatalog(data.catalog, data.schema), 'required must be boolean'); } finally { data.cleanup(); }
});
test('audit rejects an unnormalized probe path', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].probe.path = 'skills\\forge-sample\\SKILL.md'; has(api.validateCatalog(data.catalog, data.schema), 'normalized filesystem path'); } finally { data.cleanup(); }
});
test('audit rejects dot and dot-dot probe path segments', () => {
  const data = fixture();
  try {
    const schemaPattern = new RegExp(api.loadCatalog(path.resolve(__dirname, '..')).schema.$defs.probe.properties.path.pattern);
    for (const probe of ['skills/./forge-sample/SKILL.md', 'skills/../outside']) {
      data.catalog.capabilities[0].probe.path = probe;
      has(api.validateCatalog(data.catalog, data.schema), 'normalized filesystem path');
      assert.strictEqual(schemaPattern.test(probe), false, `schema accepted traversal probe ${probe}`);
    }
  } finally { data.cleanup(); }
});
test('audit rejects a required capability with no probe', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].probe = {}; has(api.validateCatalog(data.catalog, data.schema), 'required capability has no planned probe'); } finally { data.cleanup(); }
});
test('audit rejects a required missing filesystem probe', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].probe.path = 'missing/file'; fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); has(api.audit(data.root).issues, 'required probe does not exist'); } finally { data.cleanup(); }
});
test('audit rejects product versions outside the release workflow', () => {
  const data = fixture();
  try { data.catalog.release.product_version_source = 'catalog'; has(api.validateCatalog(data.catalog, data.schema), 'product version must derive'); } finally { data.cleanup(); }
});
test('audit rejects an adapter that is not optional', () => {
  const data = fixture();
  try { data.catalog.release.adapters.codex.optional = false; has(api.validateCatalog(data.catalog, data.schema), 'adapter codex'); } finally { data.cleanup(); }
});
function writeCatalog(data) { fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); }
test('demonstrated with same-host evidence inside the checkout passes validation and audit', () => {
  const data = fixture();
  try {
    fs.mkdirSync(path.join(data.root, 'docs', 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(data.root, 'docs', 'evidence', 'codex-skill.json'), '{}\n');
    data.catalog.capabilities[0].hosts.codex = 'demonstrated';
    data.catalog.capabilities[0].evidence = { codex: 'docs/evidence/codex-skill.json' };
    writeCatalog(data);
    assert.deepStrictEqual(api.validateCatalog(data.catalog, data.schema), []);
    assert.deepStrictEqual(api.audit(data.root).issues, []);
  } finally { data.cleanup(); }
});
test('validation rejects demonstrated without evidence for the same host', () => {
  const data = fixture();
  try {
    data.catalog.capabilities[0].hosts.codex = 'demonstrated';
    has(api.validateCatalog(data.catalog, data.schema), 'demonstrated codex requires evidence for the same host');
    // Evidence for the other host does not satisfy the demonstrated host.
    data.catalog.capabilities[0].evidence = { claude: 'docs/evidence.json' };
    const issues = api.validateCatalog(data.catalog, data.schema);
    has(issues, 'demonstrated codex requires evidence for the same host');
    has(issues, 'evidence for claude requires demonstrated status');
  } finally { data.cleanup(); }
});
test('validation rejects evidence for a host that is not demonstrated and unknown evidence keys', () => {
  const data = fixture();
  try {
    data.catalog.capabilities[0].hosts.codex = 'distributed';
    data.catalog.capabilities[0].evidence = { codex: 'docs/evidence.json' };
    has(api.validateCatalog(data.catalog, data.schema), 'evidence for codex requires demonstrated status');
    data.catalog.capabilities[0].hosts.codex = 'demonstrated';
    data.catalog.capabilities[0].evidence = { codex: 'docs/evidence.json', agy: 'docs/evidence.json' };
    has(api.validateCatalog(data.catalog, data.schema), 'evidence: unknown key agy');
    data.catalog.capabilities[0].evidence = ['docs/evidence.json'];
    has(api.validateCatalog(data.catalog, data.schema), 'evidence must be an object');
    delete data.catalog.capabilities[0].evidence;
    data.catalog.capabilities[0].proof = 'docs/evidence.json';
    has(api.validateCatalog(data.catalog, data.schema), 'unknown key proof');
  } finally { data.cleanup(); }
});
test('validation rejects absolute, traversing and unnormalized evidence paths', () => {
  const data = fixture();
  const schemaPattern = new RegExp(api.loadCatalog(REPO).schema.$defs.relative_path.pattern);
  try {
    data.catalog.capabilities[0].hosts.codex = 'demonstrated';
    for (const bad of ['/etc/passwd', 'C:/evidence.json', 'c:evidence.json', '../outside.json', 'docs/../outside.json', './docs/e.json', 'docs\\e.json', 'docs//e.json', 'docs/', '']) {
      data.catalog.capabilities[0].evidence = { codex: bad };
      has(api.validateCatalog(data.catalog, data.schema), 'evidence for codex must be a normalized relative path');
      if (bad) assert.strictEqual(schemaPattern.test(bad), false, `schema accepted evidence path ${bad}`);
    }
    assert.strictEqual(schemaPattern.test('docs/evidence/codex.json'), true);
  } finally { data.cleanup(); }
});
test('audit rejects evidence that does not exist or is not a file in the checkout', () => {
  const data = fixture();
  try {
    data.catalog.capabilities[0].hosts.codex = 'demonstrated';
    data.catalog.capabilities[0].evidence = { codex: 'docs/missing.json' };
    writeCatalog(data);
    has(api.audit(data.root).issues, 'evidence for codex does not exist: docs/missing.json');
    fs.mkdirSync(path.join(data.root, 'docs', 'folder'), { recursive: true });
    data.catalog.capabilities[0].evidence = { codex: 'docs/folder' };
    writeCatalog(data);
    has(api.audit(data.root).issues, 'evidence for codex is not a file: docs/folder');
  } finally { data.cleanup(); }
});
test('audit rejects evidence that escapes the checkout through a link', () => {
  const data = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capabilities-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'proof.json'), '{}\n');
    // A directory junction needs no privilege on Windows; POSIX uses a symlink.
    fs.symlinkSync(outside, path.join(data.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    data.catalog.capabilities[0].hosts.codex = 'demonstrated';
    data.catalog.capabilities[0].evidence = { codex: 'linked/proof.json' };
    writeCatalog(data);
    assert.deepStrictEqual(api.validateCatalog(data.catalog, data.schema), [], 'the lexical path is valid; only the physical target escapes');
    has(api.audit(data.root).issues, 'evidence for codex escapes the checkout: linked/proof.json');
  } finally { data.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});
test('validation rejects malformed capability probes and unknown runtime keys', () => {
  const data = fixture();
  try {
    const cli = { required: false, probe: { kind: 'cli', command: 'codex' } };
    const cases = [
      [{ ...cli, capability_probes: {} }, 'capability_probes must be an array'],
      [{ ...cli, capability_probes: [{ id: 'Bad_Id', args: ['--help'] }] }, 'invalid capability probe id'],
      [{ ...cli, capability_probes: [{ id: 'dup', args: ['--help'] }, { id: 'dup', args: ['exec'] }] }, 'duplicate capability probe id dup'],
      [{ ...cli, capability_probes: [{ id: 'empty-args', args: [] }] }, 'args must be a non-empty argv array'],
      [{ ...cli, capability_probes: [{ id: 'shell-string', args: 'exec --help' }] }, 'args must be a non-empty argv array'],
      [{ ...cli, capability_probes: [{ id: 'tokens', args: ['--help'], expect_output: '--json' }] }, 'expect_output must be an array'],
      [{ ...cli, capability_probes: [{ id: 'extra', args: ['--help'], shell: true }] }, 'capability probe: unknown key shell'],
      [{ ...cli, floor: '1.0.0' }, 'runtime: unknown key floor'],
    ];
    for (const [runtime, expected] of cases) {
      data.catalog.runtimes = { codex: runtime };
      has(api.validateCatalog(data.catalog, data.schema), expected);
    }
    data.catalog.runtimes = { node: { required: true, probe: { kind: 'node' }, capability_probes: [{ id: 'node-help', args: ['--help'] }] } };
    has(api.validateCatalog(data.catalog, data.schema), 'capability_probes require a cli runtime probe');
  } finally { data.cleanup(); }
});
test('matrix ordering is deterministic', () => {
  const data = fixture();
  try { const once = JSON.stringify(api.matrix(data.catalog)); data.catalog.capabilities.reverse(); const twice = JSON.stringify(api.matrix(data.catalog)); assert.strictEqual(once, twice); } finally { data.cleanup(); }
});
test('text rendering is deterministic and readable', () => {
  const data = fixture();
  try { const rendered = api.renderText(api.matrix(data.catalog)); assert.match(rendered, /Capability/); assert.match(rendered, /skill-forge-sample/); } finally { data.cleanup(); }
});
test('matrix preserves platform-specific availability for Forge.app', () => {
  const matrix = api.matrix(api.loadCatalog(path.resolve(__dirname, '..')).catalog);
  const app = matrix.find((entry) => entry.capability_id === 'operational-app');
  assert.deepStrictEqual(app.platforms, { macos: 'conditional', windows: 'unavailable', linux: 'unavailable' });
  assert.match(api.renderText([app]), /windows:unavailable/);
  assert.match(api.renderText([app]), /linux:unavailable/);
});
test('JSON output is stable across repeated invocations', () => {
  let left = ''; let right = '';
  assert.strictEqual(api.run(['--matrix', '--json', '--cwd', path.resolve(__dirname, '..')], (value) => { left += value; }), 0);
  assert.strictEqual(api.run(['--matrix', '--json', '--cwd', path.resolve(__dirname, '..')], (value) => { right += value; }), 0);
  assert.strictEqual(left, right);
  assert.deepStrictEqual(JSON.parse(left).capabilities, api.matrix(api.loadCatalog(path.resolve(__dirname, '..')).catalog));
});
test('check output reports successful audit', () => {
  let output = ''; assert.strictEqual(api.run(['--check', '--cwd', path.resolve(__dirname, '..')], (value) => { output += value; }), 0); assert.match(output, /Capability audit passed/);
});
test('check output fails with actionable fixture errors', () => {
  const data = fixture();
  try { data.catalog.capabilities.pop(); fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); let output = ''; assert.strictEqual(api.run(['--check', '--cwd', data.root], (value) => { output += value; }), 1); assert.match(output, /Capability audit failed/); } finally { data.cleanup(); }
});
test('discovery serializes Windows-safe catalog paths with slashes', () => {
  const data = fixture();
  try { assert(api.discover(data.root).every((entry) => !entry.path.includes('\\'))); assert.strictEqual(api.posixPath('.\\skills\\x'), 'skills/x'); } finally { data.cleanup(); }
});
test('help returns without reading a catalog', () => { let output = ''; assert.strictEqual(api.run(['--help'], (value) => { output += value; }), 0); assert.match(output, /Usage:/); });

test('detects a fake CLI with argv and never spawns the non-selected host', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-probe space-Ω-'));
  const fake = path.join(root, 'fake cli Ω.js');
  const marker = path.join(root, 'invocations.log');
  fs.writeFileSync(fake, [
    "const fs = require('fs');",
    "if (process.env.FORGE_FAKE_MARKER) fs.appendFileSync(process.env.FORGE_FAKE_MARKER, `${process.argv[2] || ''}\\n`);",
    "if (process.argv.includes('--version')) process.stdout.write('3.2.0\\n');",
    "else if (process.argv.includes('--help')) process.stdout.write('fake help\\n');",
    "else process.exitCode = 2;",
  ].join('\n'));
  try {
    const report = api.detect(path.resolve(__dirname, '..'), {
      runtime: 'claude',
      binaries: { claude: { command: process.execPath, args: [fake] }, codex: { command: process.execPath, args: [fake] } },
      env: { ...process.env, FORGE_FAKE_MARKER: marker },
    });
    assert.strictEqual(report.probes.claude.status, 'available');
    assert.strictEqual(report.probes.claude.reason_code, 'available');
    assert.strictEqual(report.probes.codex.reason_code, 'not-selected');
    // The claude-stream-json capability probe reuses the identical `--help`
    // behavior run, so the selected host still costs exactly two spawns.
    assert.strictEqual(fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).length, 2);
    assert.strictEqual(report.probes.claude.capabilities['claude-stream-json'].status, 'absent');
    assert.strictEqual(report.probes.claude.capabilities['claude-stream-json'].reason_code, 'capability-absent');
    assert.deepStrictEqual(report.probes.codex.capabilities, {
      'codex-app-server': { id: 'codex-app-server', args: ['app-server', '--help'], status: 'inconclusive', reason_code: 'not-selected' },
      'codex-exec-json': { id: 'codex-exec-json', args: ['exec', '--help'], status: 'inconclusive', reason_code: 'not-selected' },
    });
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.required_failures, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fakeHost(root, name, lines) {
  const file = path.join(root, `${name}.js`);
  const marker = path.join(root, `${name}.log`);
  fs.writeFileSync(file, [
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n');`,
    'const argv = process.argv.slice(2).join(" ");',
    ...lines,
  ].join('\n'));
  return { file, count: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean) : []) };
}

test('capability probes report observed, absent and inconclusive without changing ok', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-capability-probes-'));
  try {
    const codex = fakeHost(root, 'codex fake Ω', [
      "if (argv === '--version') process.stdout.write('codex-cli 0.165.0\\n');",
      "else if (argv === '--help') process.stdout.write('Commands: exec app-server\\n');",
      "else if (argv === 'app-server --help') process.stdout.write('Run the app server\\n');",
      "else if (argv === 'exec --help') process.stdout.write('Options:\\n  --json-schema <FILE>\\n  --color <COLOR>\\n');",
      'else process.exitCode = 2;',
    ]);
    const report = api.detect(REPO, { runtime: 'codex', binaries: { codex: { command: process.execPath, args: [codex.file] } } });
    assert.strictEqual(report.probes.codex.status, 'available');
    assert.strictEqual(report.probes.codex.version, '0.165.0');
    assert.strictEqual(report.probes.codex.minimum_version, null);
    const caps = report.probes.codex.capabilities;
    assert.deepStrictEqual([caps['codex-app-server'].status, caps['codex-app-server'].reason_code, caps['codex-app-server'].version], ['observed', 'capability-observed', '0.165.0']);
    // `--json-schema` is not the `--json` token; a prefix never counts as support.
    assert.deepStrictEqual([caps['codex-exec-json'].status, caps['codex-exec-json'].reason_code], ['absent', 'capability-absent']);
    assert.deepStrictEqual(caps['codex-exec-json'].missing_tokens, ['--json']);
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.required_failures, []);
    assert.deepStrictEqual(codex.count(), ['--version', '--help', 'app-server --help', 'exec --help']);
    assert(!JSON.stringify(caps).includes('Run the app server'), 'raw help output is not retained');

    const failing = fakeHost(root, 'codex failing', [
      "if (argv === '--version') process.stdout.write('0.165.0\\n');",
      "else if (argv === '--help') process.stdout.write('help\\n');",
      "else if (argv === 'exec --help') process.stdout.write('  --json  Print events\\n');",
      'else process.exitCode = 2;',
    ]);
    const mixed = api.detect(REPO, { runtime: 'codex', binaries: { codex: { command: process.execPath, args: [failing.file] } } });
    assert.deepStrictEqual([mixed.probes.codex.capabilities['codex-app-server'].status, mixed.probes.codex.capabilities['codex-app-server'].reason_code, mixed.probes.codex.capabilities['codex-app-server'].exit_code], ['inconclusive', 'exit-nonzero', 2]);
    assert.strictEqual(mixed.probes.codex.capabilities['codex-exec-json'].status, 'observed');
    assert.strictEqual(mixed.ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('capability probes stay inconclusive without running when the runtime is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-capability-unavailable-'));
  try {
    const broken = fakeHost(root, 'codex broken', ["if (argv === '--version') process.stdout.write('0.165.0\\n'); else process.exitCode = 3;"]);
    const report = api.detect(REPO, { runtime: 'codex', binaries: { codex: { command: process.execPath, args: [broken.file] } } });
    assert.strictEqual(report.probes.codex.reason_code, 'exit-nonzero');
    assert.deepStrictEqual(Object.values(report.probes.codex.capabilities).map((item) => [item.status, item.reason_code]), [['inconclusive', 'inconclusive'], ['inconclusive', 'inconclusive']]);
    assert.deepStrictEqual(broken.count(), ['--version', '--help']);
    assert.deepStrictEqual(report.required_failures, ['codex']);
    const missing = api.detect(REPO, { runtime: 'codex', binaries: { codex: path.join(root, 'absent') } });
    assert.strictEqual(missing.probes.codex.status, 'missing');
    assert(Object.values(missing.probes.codex.capabilities).every((item) => item.status === 'inconclusive'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('capability probe reuse never mixes executable identities across runtimes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-capability-identity-'));
  try {
    const help = "if (argv === '--version') process.stdout.write('1.2.3\\n'); else process.stdout.write('--output-format --input-format --json\\n');";
    const claude = fakeHost(root, 'claude fake', [help]);
    const codex = fakeHost(root, 'codex fake', [help]);
    const report = api.detect(REPO, { runtime: 'both', binaries: { claude: { command: process.execPath, args: [claude.file] }, codex: { command: process.execPath, args: [codex.file] } } });
    assert.deepStrictEqual(claude.count(), ['--version', '--help']);
    assert.deepStrictEqual(codex.count(), ['--version', '--help', 'app-server --help', 'exec --help']);
    assert.strictEqual(report.probes.claude.capabilities['claude-stream-json'].status, 'observed');
    assert.strictEqual(report.probes.codex.capabilities['codex-exec-json'].status, 'observed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('accepts the current Claude Code CLI namespace independently of the Forge release', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-probe-claude-namespace-'));
  const fake = path.join(root, 'claude.js');
  fs.writeFileSync(fake, "if (process.argv.includes('--version')) process.stdout.write('2.1.221\\n'); else process.stdout.write('help\\n');");
  try {
    const report = api.detect(path.resolve(__dirname, '..'), { runtime: 'claude', binaries: { claude: { command: process.execPath, args: [fake] } } });
    assert.strictEqual(report.probes.claude.status, 'available');
    assert.strictEqual(report.probes.claude.version, '2.1.221');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('classifies missing, unsupported, and invalid CLI probes with stable codes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-probe-negative-'));
  const low = path.join(root, 'low.js');
  const invalid = path.join(root, 'invalid.js');
  fs.writeFileSync(low, "if (process.argv.includes('--version')) process.stdout.write('0.0.1\\n'); else process.stdout.write('help\\n');");
  fs.writeFileSync(invalid, "if (process.argv.includes('--version')) process.stdout.write('not-a-version\\n'); else process.stdout.write('help\\n');");
  try {
    const base = path.resolve(__dirname, '..');
    // Without a generic host floor, an old version is recorded, not rejected.
    const lowReport = api.detect(base, { runtime: 'claude', binaries: { claude: { command: process.execPath, args: [low] } } });
    assert.strictEqual(lowReport.probes.claude.status, 'available');
    assert.strictEqual(lowReport.probes.claude.version, '0.0.1');
    assert.strictEqual(lowReport.probes.claude.minimum_version, null);
    assert.notStrictEqual(lowReport.probes.claude.reason_code, 'minimum-version');
    // An explicitly declared floor is still enforced.
    const floored = clone(api.loadCatalog(base).catalog);
    floored.runtimes.claude.minimum_version = '2.0.0';
    const flooredReport = api.detect(base, { runtime: 'claude', catalog: floored, binaries: { claude: { command: process.execPath, args: [low] } } });
    assert.strictEqual(flooredReport.probes.claude.status, 'unsupported');
    assert.strictEqual(flooredReport.probes.claude.reason_code, 'minimum-version');
    assert.strictEqual(flooredReport.probes.claude.minimum_version, '2.0.0');
    assert.deepStrictEqual(flooredReport.required_failures, ['claude']);
    const codexLow = api.detect(base, { runtime: 'codex', binaries: { codex: { command: process.execPath, args: [low] } } });
    assert.strictEqual(codexLow.probes.codex.status, 'available');
    assert.strictEqual(codexLow.probes.codex.minimum_version, null);
    const invalidReport = api.detect(base, { runtime: 'claude', binaries: { claude: { command: process.execPath, args: [invalid] } } });
    assert.strictEqual(invalidReport.probes.claude.status, 'inconclusive');
    assert.strictEqual(invalidReport.probes.claude.reason_code, 'invalid-output');
    const missingReport = api.detect(base, { runtime: 'claude', binaries: { claude: path.join(root, 'absent') } });
    assert.strictEqual(missingReport.probes.claude.status, 'missing');
    assert.strictEqual(missingReport.probes.claude.reason_code, 'missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows .cmd shims keep argv and Unicode paths without shell fallback', () => {
  if (process.platform !== 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-cmd-Ω-'));
  const shim = path.join(root, 'fake cli Ω.cmd');
  fs.writeFileSync(shim, '@echo off\r\nif "%1"=="--version" (echo 3.2.0) else (echo help)\r\n', 'utf8');
  try {
    const report = api.detect(path.resolve(__dirname, '..'), { runtime: 'claude', binaries: { claude: shim } });
    assert.strictEqual(report.probes.claude.status, 'available');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows bare commands prefer native npm shims over extensionless POSIX wrappers', () => {
  if (process.platform !== 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-bare-command-Ω-'));
  fs.writeFileSync(path.join(root, 'fake'), '#!/bin/sh\necho 0.0.1\n', 'utf8');
  fs.writeFileSync(path.join(root, 'fake.cmd'), '@echo off\r\nif "%1"=="--version" (echo 2.1.221) else (echo help)\r\n', 'utf8');
  try {
    const report = api.detect(path.resolve(__dirname, '..'), { runtime: 'claude', binaries: { claude: 'fake' }, env: { ...process.env, PATH: `${root};${process.env.PATH || ''}` } });
    assert.strictEqual(report.probes.claude.status, 'available');
    assert.match(report.probes.claude.executable, /fake\.cmd$/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSIX non-executable probe reports permission-denied', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-noexec-'));
  const file = path.join(root, 'fake-cli');
  fs.writeFileSync(file, '#!/bin/sh\necho 3.2.0\n', 'utf8');
  fs.chmodSync(file, 0o644);
  try {
    const report = api.detect(path.resolve(__dirname, '..'), { runtime: 'claude', binaries: { claude: file } });
    assert.strictEqual(report.probes.claude.reason_code, 'permission-denied');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex classification is distributed exactly where the renderer projects the probe source', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-codex-render-Ω-'));
  try {
    const report = codexRenderer.render({
      repo: REPO, projectRoot: path.join(temp, 'project'), codexHome: path.join(temp, 'codex'), forgeHome: path.join(temp, 'forge'),
      ...codexRenderer.PRODUCTION_DISPATCH_DIALECT,
    });
    const sources = new Set(report.artifacts.map((artifact) => artifact.source));
    const sourceIds = new Set(report.artifacts.map((artifact) => artifact.source_id));
    const { catalog } = api.loadCatalog(REPO);
    const projected = catalog.capabilities.filter((entry) => ['skill', 'agent', 'command'].includes(entry.kind));
    assert.strictEqual(projected.length, 43);
    for (const entry of projected) {
      assert.strictEqual(entry.hosts.codex === 'distributed', sources.has(entry.probe.path), `${entry.capability_id}: codex ${entry.hosts.codex} vs rendered ${sources.has(entry.probe.path)}`);
      assert.strictEqual(entry.hosts.codex, 'distributed', entry.capability_id);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'forge-source-manifest.json'), 'utf8'));
    const byId = new Map(catalog.capabilities.map((entry) => [entry.capability_id, entry]));
    const manifestSource = (id) => manifest.sources.find((source) => source.source_id === id);
    // Headless: the dispatch templates carry operational-headless with no
    // Codex restriction and are projected into CODEX_HOME/templates/dispatch.
    assert.strictEqual(manifestSource('dispatch-templates').capability, 'operational-headless');
    assert.strictEqual((manifestSource('dispatch-templates').conditional || {}).codex, undefined);
    assert(sourceIds.has('dispatch-templates'));
    assert.strictEqual(byId.get('operational-headless').hosts.codex, 'distributed');
    // Hooks and MCP are not projected for Codex and stay planned.
    for (const [sourceId, capabilityId] of [['hooks', 'operational-hooks'], ['mcp', 'operational-mcp']]) {
      assert.strictEqual(manifestSource(sourceId).conditional.codex.status, 'planned');
      assert(!sourceIds.has(sourceId), `${sourceId} must not be rendered for Codex`);
      assert.strictEqual(byId.get(capabilityId).hosts.codex, 'planned');
    }
    assert.strictEqual(byId.get('operational-statusline').hosts.codex, 'conditional');
    assert.strictEqual(byId.get('operational-accounts').hosts.codex, 'planned');
    assert.strictEqual(byId.get('operational-app').hosts.codex, 'unavailable');
    assert.strictEqual(byId.get('integration-claude-instructions').hosts.codex, 'unavailable');
    assert.strictEqual(byId.get('integration-claude-settings').hosts.codex, 'unavailable');
    assert.strictEqual(byId.get('configuration-forge').hosts.codex, 'common');
    for (const entry of catalog.capabilities) assert.notStrictEqual(entry.hosts.claude, 'distributed', entry.capability_id);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('runtime-compatibility documents exactly the AVAILABILITY vocabulary and the current posture', () => {
  const text = fs.readFileSync(path.join(REPO, 'docs', 'runtime-compatibility.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = (heading) => {
    const start = text.indexOf(`\n## ${heading}\n`);
    assert(start >= 0, `missing section ${heading}`);
    const end = text.indexOf('\n## ', start + 4);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const documented = [...section('Availability vocabulary').matchAll(/^`([a-z-]+)` means /gm)].map((match) => match[1]);
  assert.deepStrictEqual(documented.slice().sort(), [...api.AVAILABILITY].sort());
  assert.strictEqual(new Set(documented).size, documented.length);
  assert(!text.includes('Their Codex CLI counterparts are `planned` until a future adapter ships.'));
  assert(!/Their Codex CLI counterparts are .?planned.? until a future adapter ships/.test(text));
  const posture = section('Current release posture');
  assert.match(posture, /`distributed`/);
  assert.match(posture, /not demonstrated/);
  assert.match(posture, /Hooks are implemented for Claude and `planned` for Codex/);
  assert.match(posture, /MCP management is implemented for Claude and `planned` for Codex/);
  assert.match(section('Question capability'), /does not prove/);
  assert.match(section('Canonical matrix'), /\(host-compatibility-baseline\.json\)/);
  const shared = fs.readFileSync(path.join(REPO, 'shared', 'forge-capabilities.md'), 'utf8');
  for (const state of api.AVAILABILITY) assert(shared.includes(`\`${state}\``), `shared contract misses ${state}`);
  for (const code of api.REASON_CODES) assert(shared.includes(`\`${code}\``), `shared contract misses ${code}`);
  assert(!/current Claude Code floor/.test(shared), 'shared contract must not describe a generic Claude floor');
});

test('real CLI --check --cwd . exits 0', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'forge-capabilities.js'), '--check', '--cwd', '.'], { cwd: REPO, encoding: 'utf8', shell: false, timeout: 60_000 });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Capability audit passed/);
});

test('real CLI --matrix --json --cwd . is byte-identical across two invocations', () => {
  const invoke = () => spawnSync(process.execPath, [path.join(__dirname, 'forge-capabilities.js'), '--matrix', '--json', '--cwd', '.'], { cwd: REPO, encoding: 'utf8', shell: false, timeout: 60_000 });
  const first = invoke(); const second = invoke();
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(first.stdout, second.stdout);
  const parsed = JSON.parse(first.stdout);
  assert.strictEqual(parsed.schema_version, '1.1.0');
  assert.deepStrictEqual(parsed.capabilities, api.matrix(api.loadCatalog(REPO).catalog));
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
