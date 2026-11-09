#!/usr/bin/env node
'use strict';
const unitEntry = require('./fixtures/native-effort/distribution.cjs');

// Standalone acceptance suite: only Node built-ins and production modules.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const guard = require('./forge-dispatch-source-guard.js');
const codexRenderer = require('./forge-codex-renderer.js');
const claudeRenderer = require('./forge-claude-renderer.js');
const dispatchResolver = require('./forge-dispatch-resolve.js');

const ROOT = path.resolve(__dirname, '..');
const RESOLVER_SCRIPT = path.join(__dirname, 'forge-dispatch-resolve.js');
const MANIFEST_PATH = path.join(ROOT, 'forge-source-manifest.json');
const HISTORICAL_GOLDEN_PATH = path.join(__dirname, 'fixtures', 'claude-renderer', 'claude-4.19.0.golden.json');
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'claude-renderer', 'claude-memory-v2.golden.json');
const PRE_REPIN_SKILLS_SHA = '940cc9f4348ffe52fc4b57e8d247431992dc81ab32eee9474d2149922edb1bf2';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error.message}\n`);
  }
}

function read(relative, root = ROOT) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function write(relative, content, root) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function fixtureRoot() {
  const fixtureParent = path.resolve(ROOT, 'Temp/codex/dispatch-source-guard');
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, '.forge-dispatch-source-guard-'));
  assert(root.startsWith(`${fixtureParent}${path.sep}`), `unsafe fixture root: ${root}`);
  for (const relative of guard.SCOPED_FILES) write(relative, read(relative), root);
  return root;
}

function removeFixture(root) {
  const fixtureParent = path.resolve(ROOT, 'Temp/codex/dispatch-source-guard');
  const resolved = path.resolve(root);
  assert(resolved.startsWith(`${fixtureParent}${path.sep}.forge-dispatch-source-guard-`), `unsafe cleanup: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function withFixture(fn) {
  const root = fixtureRoot();
  try {
    return fn(root);
  } finally {
    removeFixture(root);
  }
}

function appendSeparated(root, relative, text) {
  const current = read(relative, root);
  write(relative, `${current.replace(/\s*$/, '')}\n\n\n\n\n${text}\n`, root);
}

function discovered(root, predicate) {
  const item = guard.discover(root).candidates.find(predicate);
  assert(item, 'injected candidate was not discovered');
  return item;
}

function registerCandidate(item, extra = {}) {
  return Object.freeze({
    id: `fixture-${item.kind}-${item.fingerprint.slice(7, 19)}`,
    path: item.path,
    kind: item.kind,
    classification: 'operational',
    fingerprint: item.fingerprint,
    reason: '',
    host_policy: '',
    ...extra,
  });
}

function occurrenceCount(text, expression) {
  return (String(text).match(expression) || []).length;
}

function byIdentity(discovery) {
  return new Map(discovery.candidates.map((item) => [guard.identity(item), item]));
}

function registryEntries(relative, kind, classification = 'operational') {
  return guard.SOURCE_REGISTRY.filter((item) => (
    item.path === relative && item.kind === kind && item.classification === classification
  ));
}

function artifactFor(report, relative) {
  const artifact = report.artifacts.find((item) => item.source === relative);
  assert(artifact, `rendered artifact missing for ${relative}`);
  return artifact;
}

function renderedCandidateLine(rawDocument, rawCandidate, artifact) {
  const renderedText = artifact.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const renderedLines = renderedText.split('\n');
  const renderedMarkers = guard.markerState(renderedText);
  assert(rawDocument.markers.pair, `raw marker pair missing for ${rawCandidate.path}`);
  assert(renderedMarkers.pair, `rendered marker pair missing for ${rawCandidate.path}`);
  const relativeLine = (rawCandidate.line - 1) - rawDocument.markers.pair.start;
  const renderedIndex = renderedMarkers.pair.start + relativeLine;
  assert(renderedIndex > renderedMarkers.pair.start && renderedIndex < renderedMarkers.pair.end,
    `candidate left managed block: ${rawCandidate.path}:${rawCandidate.line}`);
  return { renderedLines, renderedIndex };
}

function renderedCandidateContext(rawDocument, rawCandidate, artifact) {
  const located = renderedCandidateLine(rawDocument, rawCandidate, artifact);
  const lines = [];
  for (let index = located.renderedIndex; index < located.renderedLines.length && lines.length < 16; index += 1) {
    const line = located.renderedLines[index];
    if (index > located.renderedIndex && /^```/.test(line.trim())) break;
    lines.push(line);
    if (/--json\)\s*(?:#.*)?$/.test(line)) break;
  }
  return lines.join('\n');
}

function shellWords(value) {
  const words = [];
  const expression = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (const match of String(value).matchAll(expression)) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

function resolverArgvFromContext(context) {
  const flattened = String(context).replace(/\\\s*\n/g, ' ');
  const invocation = /node\s+(?:"[^"]*forge-dispatch-resolve\.js"|[^\s]*forge-dispatch-resolve\.js)\s+([\s\S]*?--json)\)/.exec(flattened);
  assert(invocation, `resolver argv not parseable from:\n${context}`);
  return shellWords(invocation[1]);
}

function substituteFixtureArgs(argv, fixture, candidate) {
  const result = argv.slice();
  const replacements = {
    '--unit-type': candidate.evidence.startsWith('RF_') ? 'review-fix' : 'execute-task',
    '--plan': path.join(fixture, 'T01-PLAN.md'),
    '--unit-id': 'T01',
    '--milestone': 'M001',
    '--roadmap': path.join(fixture, 'M001-ROADMAP.md'),
    '--domain': 'default',
    '--cwd': fixture,
  };
  for (let index = 0; index < result.length; index += 1) {
    const replacement = replacements[result[index]];
    if (replacement !== undefined) result[index + 1] = replacement;
  }
  return result;
}

function cleanRuntimeEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.FORGE_RUNTIME_ENFORCE;
  return { ...environment, ...overrides };
}

function executeResolverArgv(argv, cwd, environment = cleanRuntimeEnvironment()) {
  const child = spawnSync(process.execPath, [RESOLVER_SCRIPT, ...argv], {
    cwd,
    env: environment,
    encoding: 'utf8',
  });
  assert.strictEqual(child.error, undefined, child.error && child.error.message);
  assert.strictEqual(child.status, 0, child.stderr);
  assert.notStrictEqual(child.stdout.trim(), '', `resolver stdout empty; stderr=${child.stderr}`);
  return JSON.parse(child.stdout.trim().split(/\r?\n/).pop());
}

function runPosture(host, worker, cwd, environment = cleanRuntimeEnvironment()) {
  return executeResolverArgv([
    '--unit-type', 'execute-task',
    '--host-runtime', host,
    '--worker-engine', worker,
    '--cwd', cwd,
    '--json',
  ], cwd, environment);
}

function materializeEmitter(candidate) {
  let template = candidate.evidence.slice(candidate.evidence.indexOf('{'), candidate.evidence.lastIndexOf('}') + 1);
  template = template.replace(/\\"/g, '"');
  template = template.replace(/\$\(date[^)]*\)/g, '2026-08-28T00:00:00Z');
  template = template.replace(/"dispatch_allowed"\s*:\s*(?:\$\{(?:[^{}]|\{[^{}]*\})*\}|%s)/g, '"dispatch_allowed":true');
  template = template.replace(/"(?:chain_len|input_tokens|output_tokens|batch_size)"\s*:\s*\$\{(?:[^{}]|\{[^{}]*\})*\}/g,
    (match) => `${match.slice(0, match.indexOf(':') + 1)}1`);
  template = template.replace(/"model_applied"\s*:\s*\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '"model_applied":null');
  template = template.replace(/"model_applied"\s*:\s*\$[A-Za-z_][A-Za-z0-9_]*/g, '"model_applied":null');
  template = template.replace(/\$\{TRANSPORT_TAIL\}/g, '"transport":"app-server"');
  template = template.replace(/:\s*\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ':1');
  template = template.replace(/:\s*\$[A-Za-z_][A-Za-z0-9_]*/g, ':1');
  template = template.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, 'value');
  template = template.replace(/%s/g, 'value');
  return JSON.parse(template);
}

function surfaceHashes(report, golden) {
  const hashes = new Map();
  for (const surface of golden.surfaces) {
    const matching = report.artifacts.filter((item) => item.source_id === surface.source_id);
    assert(matching.length > 0, `surface absent from renderer report: ${surface.source_id}`);
    const payload = matching.sort((left, right) => left.source.localeCompare(right.source))
      .map((item) => `${item.source}\0${item.content.replace(/version=\d+\.\d+\.\d+/g, 'version=<dynamic>')}`)
      .join('\0');
    hashes.set(surface.source_id, crypto.createHash('sha256').update(payload, 'utf8').digest('hex'));
  }
  return hashes;
}

process.stdout.write('forge-dispatch-source-guard acceptance\n');

test('public resolver CLI drains backpressured stdout/stderr on success and loud failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-resolver-stdout-'));
  try {
    fs.mkdirSync(path.join(root, '.gsd'));
    // Synthetic stream pressure, not a provider or OS pipe observation. Windows
    // pipes can be synchronous, so delay completion explicitly on every platform.
    const preload = path.join(root, 'backpressure.cjs');
    fs.writeFileSync(preload, `(${function installBackpressure() {
      const fs = require('fs');
      const { Writable } = require('stream');
      for (const [name, fd] of [['stdout', 1], ['stderr', 2]]) {
        const output = new Writable({ highWaterMark: 1, write(chunk, encoding, done) {
          fs.appendFileSync(process.env.FORGE_TEST_CAPTURE + '.' + name, chunk);
          const head = Math.min(32, chunk.length);
          fs.writeSync(fd, chunk.subarray(0, head));
          setTimeout(() => {
            fs.writeSync(fd, chunk.subarray(head));
            done();
          }, 10);
        } });
        Object.defineProperty(process, name, { value: output });
      }
    }.toString()})();\n`);
    const route = { model: 'x'.repeat(100000), effort: 'high' };
    const cases = [
      { name: 'success', args: ['--unit-type', 'execute-task', '--json'], status: 0 },
      { name: 'shell', args: ['--shell-exports'], input: JSON.stringify(route), status: 0 },
      { name: 'malformed-shell', args: ['--shell-exports'], input: '{nope', status: 2 },
      // A directory as a plan exercises the real source-integrity error path.
      { name: 'runtime-failure', args: ['--unit-type', 'execute-task', '--plan', root], status: 2 },
      { name: 'prefs-failure', args: ['--unit-type', 'execute-task', '--json'], status: 1 },
    ];
    for (const item of cases) {
      if (item.name === 'prefs-failure') write('.gsd/forge-prefs.jsonc', '{malformed', root);
      const prefix = path.join(root, item.name);
      for (const stream of ['stdout', 'stderr']) fs.writeFileSync(prefix + '.' + stream, '');
      const child = spawnSync(process.execPath, [
        '--require', preload, RESOLVER_SCRIPT, ...item.args, '--cwd', root,
      ], {
        cwd: root,
        env: cleanRuntimeEnvironment({ HOME: root, USERPROFILE: root, FORGE_TEST_CAPTURE: prefix }),
        input: item.input || '',
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.strictEqual(child.error, undefined, child.error && child.error.message);
      assert.strictEqual(child.signal, null, item.name);
      assert.strictEqual(child.status, item.status, `${item.name}: ${child.stderr}`);
      for (const stream of ['stdout', 'stderr']) {
        const expected = fs.readFileSync(prefix + '.' + stream, 'utf8');
        assert.strictEqual(child[stream], expected, `${item.name}: truncated ${stream}`);
      }
      if (item.name === 'shell') {
        // Exact equality also rejects accidental fallthrough into resolution.
        assert.strictEqual(child.stdout, dispatchResolver.shellExports(route) + '\n');
        assert.strictEqual(child.stderr, '');
      } else if (item.name === 'malformed-shell') {
        assert.strictEqual(child.stdout, '');
        assert.match(JSON.parse(child.stderr).error, /--shell-exports: unparseable stdin payload/);
      } else {
        const payload = JSON.parse(child.stdout);
        if (item.name === 'runtime-failure') {
          assert.strictEqual(payload.degraded, true);
          assert.strictEqual(payload.dispatch_allowed, false);
          assert.match(JSON.parse(child.stderr).error, /resolver-source-not-regular/);
        } else {
          assert.strictEqual(payload.prefs_ok, item.status === 0);
          assert.strictEqual(child.stderr, '');
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('registry and every nested entry are deeply frozen with explicit exclusions', () => {
  assert(Object.isFrozen(guard.SOURCE_REGISTRY));
  assert(guard.SOURCE_REGISTRY.length > 0);
  for (const entry of guard.SOURCE_REGISTRY) {
    assert(Object.isFrozen(entry), `${entry.id} is mutable`);
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert(guard.SCOPED_FILES.includes(entry.path), entry.path);
    assert(['resolver', 'agent', 'adapter', 'emitter', 'native', 'preparation', 'unit-sidecar'].includes(entry.kind), entry.kind);
    assert(['operational', 'excluded'].includes(entry.classification), entry.classification);
    assert.match(entry.fingerprint, /^sha256:[a-f0-9]{64}$/);
    if (entry.classification === 'excluded') assert.notStrictEqual(entry.reason.trim(), '', entry.id);
  }
});

test('real disk discovery equals the frozen registry in both directions', () => {
  const report = guard.audit({ root: ROOT });
  assert.strictEqual(report.ok, true, JSON.stringify(report, null, 2));
  assert.deepStrictEqual(report.unexpected, []);
  assert.deepStrictEqual(report.missing, []);
  assert.deepStrictEqual(report.errors, []);
  const discoveredKinds = new Set(guard.discover(ROOT).candidates.map((item) => item.kind));
  assert.deepStrictEqual([...discoveredKinds].sort(), ['adapter', 'agent', 'emitter', 'native', 'preparation', 'resolver', 'unit-sidecar']);
  const nativeBuilders = guard.discover(ROOT).candidates.filter((item) =>
    item.kind === 'native' && /buildNativeInvocation\s*\(/.test(item.evidence));
  assert.strictEqual(nativeBuilders.length, 3, 'all structured native builder sites remain visible');
  for (const item of nativeBuilders) {
    const registered = guard.SOURCE_REGISTRY.find((entry) => guard.identity(entry) === guard.identity(item));
    assert.strictEqual(registered && registered.classification, 'operational', `${item.path}:${item.line}`);
  }
});

test('injecting a native invocation is reported as an unexpected candidate', () => withFixture((root) => {
  const relative = 'shared/forge-review.md';
  appendSeparated(root, relative, 'injected = buildNativeInvocation({ hostRuntime: HOST_RUNTIME })');
  const report = guard.audit({ root });
  assert.strictEqual(report.ok, false);
  assert(report.unexpected.some((item) => item.kind === 'native' && item.evidence.startsWith('injected =')),
    JSON.stringify(report.unexpected, null, 2));
}));

test('an unregistered standalone preparation caller is reported', () => withFixture((root) => {
  const relative = 'skills/forge-task/SKILL.md';
  appendSeparated(root, relative,
    'node "$FORGE_SCRIPTS_DIR/forge-task-preparation.js" --start "$INJECTED_REQUEST"');
  const report = guard.audit({ root });
  assert.strictEqual(report.ok, false);
  assert(report.unexpected.some((item) => item.kind === 'preparation'
    && item.evidence.includes('$INJECTED_REQUEST')), JSON.stringify(report.unexpected, null, 2));
}));

test('a registered preparation caller without canonical argv is structurally rejected', () => withFixture((root) => {
  const relative = 'skills/forge-task/SKILL.md';
  const source = read(relative, root);
  const injected = 'node "$FORGE_SCRIPTS_DIR/forge-task-preparation.js" --unsafe "$VALUE"';
  write(relative, source.replace('<!-- forge:dispatch:end -->', `${injected}\n<!-- forge:dispatch:end -->`), root);
  const item = discovered(root, (candidate) => candidate.kind === 'preparation'
    && candidate.evidence.includes('--unsafe'));
  const report = guard.audit({ root, registry: [...guard.SOURCE_REGISTRY, registerCandidate(item)] });
  assert.strictEqual(report.ok, false);
  assert(report.errors.some((message) => /lacks the canonical start or native-accept argv/.test(message)),
    JSON.stringify(report, null, 2));
}));

test('an operational native builder missing effort binding is structurally rejected', () => withFixture((root) => {
  const relative = 'skills/forge-task/SKILL.md';
  const source = read(relative, root);
  const injected = [
    'broken = buildNativeInvocation({',
    '  hostRuntime: HOST_RUNTIME, resolvedDispatch: ROUTE_JSON, activeCapabilities: ACTIVE_NATIVE_CAPABILITIES,',
    "  agentType: 'forge-executor', prompt: 'fixture', forkTurns: 'none',",
    '})',
  ].join('\n');
  write(relative, source.replace('<!-- forge:dispatch:end -->', `${injected}\n<!-- forge:dispatch:end -->`), root);
  const item = discovered(root, (candidate) => candidate.kind === 'native' && candidate.evidence.startsWith('broken ='));
  const registry = [...guard.SOURCE_REGISTRY, registerCandidate(item)];
  const report = guard.audit({ root, registry });
  assert.strictEqual(report.ok, false);
  assert(report.errors.some((message) => /native builder lacks effortBinding/.test(message)), JSON.stringify(report, null, 2));
}));

test('the review-fix unit-sidecar caller is operational and consumes the saved resolver JSON', () => {
  const entries = guard.SOURCE_REGISTRY.filter((entry) => entry.kind === 'unit-sidecar' && entry.path === 'shared/forge-review.md');
  assert.deepStrictEqual(entries.map((entry) => [entry.path, entry.classification]),
    [['shared/forge-review.md', 'operational']]);
  const candidate = byIdentity(guard.discover(ROOT)).get(guard.identity(entries[0]));
  assert(candidate, entries[0].id);
  assert.match(candidate.evidence, /forge-unit-sidecar\.js" --request "\$RF_REQUEST"$/);
  // The data path, not argv flags: the resolver JSON saved by the runtime gate
  // is piped, parsed and embedded unchanged as the request route.
  assert.match(candidate.context, /printf '%s' "\$RF_ROUTE_JSON_SAVED" \|/);
  assert.match(candidate.context, /route=JSON\.parse\(d\)/);
  assert.match(candidate.context, /,route,/);
  assert.match(candidate.context, /decision:'proceed'/);
  assert.doesNotMatch(candidate.context, /--host-runtime|--sidecar-declared/);
  // The same saved variable is the one the runtime gate assigned from the resolver.
  assert.match(read('shared/forge-review.md'), /RF_ROUTE_JSON_SAVED="\$RF_ROUTE_JSON"/);
});

test('standalone execution caller preserves the resolver, gates and constraints', () => withFixture(root => {
  const relative = 'skills/forge-task/SKILL.md';
  const entry = guard.SOURCE_REGISTRY.find(e => e.path === relative && e.kind === 'unit-sidecar');
  assert.strictEqual(entry.classification, 'operational');
  const candidate = byIdentity(guard.discover(ROOT)).get(guard.identity(entry));
  assert.match(candidate.context, /EXEC_ROUTE_JSON_SAVED="\$ROUTE_JSON"/);
  for (const [from, to, diagnostic] of [
    ['route=JSON.parse(d)', 'route={}', 'route parsed'],
    ['input.gates?.claim!=="proceed"', 'false', 'claim gate check'],
    ['...input,', '', 'actual gates and constraints'],
    ['phase:"execute"', 'phase:"plan"', 'standalone execution contract'],
  ]) {
    write(relative, read(relative).replace(from, to), root);
    const item = discovered(root, c => c.path === relative && c.kind === 'unit-sidecar');
    const registry = guard.SOURCE_REGISTRY.filter(e => e.id !== entry.id).concat(registerCandidate(item));
    const report = guard.audit({ root, registry });
    assert(report.errors.some(message => message.includes(diagnostic)), JSON.stringify(report));
  }
}));

test('a unit-sidecar caller that re-types flags or drops the resolver JSON is structurally rejected', () => withFixture((root) => {
  const relative = 'shared/forge-review.md';
  const source = read(relative, root);
  const mutated = source
    .replace(`printf '%s' "$RF_ROUTE_JSON_SAVED" | RF_REQUEST=`, 'RF_REQUEST=')
    .replace('node "$FORGE_SCRIPTS_DIR/forge-unit-sidecar.js" --request "$RF_REQUEST"',
      'node "$FORGE_SCRIPTS_DIR/forge-unit-sidecar.js" --request "$RF_REQUEST" --host-runtime claude --sidecar-declared');
  assert.notStrictEqual(mutated, source, 'fixture mutation did not apply');
  write(relative, mutated, root);
  const item = discovered(root, (candidate) => candidate.kind === 'unit-sidecar' && candidate.evidence.includes('--sidecar-declared'));
  const report = guard.audit({ root, registry: [...guard.SOURCE_REGISTRY, registerCandidate(item)] });
  assert.strictEqual(report.ok, false);
  assert(report.errors.some((message) => /lacks the saved resolver JSON on its data path/.test(message)), JSON.stringify(report.errors, null, 2));
  assert(report.errors.some((message) => /re-types runtime flags/.test(message)), JSON.stringify(report.errors, null, 2));
}));

test('an unregistered or unfenced unit-sidecar caller is reported', () => withFixture((root) => {
  const relative = 'skills/forge-next/SKILL.md';
  appendSeparated(root, relative, 'Run `node "$FORGE_SCRIPTS_DIR/forge-unit-sidecar.js" --request "$INJECTED_REQUEST"` inline.');
  const report = guard.audit({ root });
  assert.strictEqual(report.ok, false);
  const item = report.unexpected.find((candidate) => candidate.kind === 'unit-sidecar' && candidate.evidence.includes('$INJECTED_REQUEST'));
  assert(item, JSON.stringify(report.unexpected, null, 2));
  const measured = discovered(root, (candidate) => candidate.kind === 'unit-sidecar' && candidate.evidence.includes('$INJECTED_REQUEST'));
  const registered = guard.audit({ root, registry: [...guard.SOURCE_REGISTRY, registerCandidate(measured)] });
  assert(registered.errors.some((message) => /outside a fenced command block/.test(message)), JSON.stringify(registered.errors, null, 2));
}));

test('injecting a resolver call is reported as an unexpected candidate', () => withFixture((root) => {
  const relative = 'shared/forge-review.md';
  appendSeparated(root, relative, [
    'INJECTED_ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" \\',
    '  --unit-type review-fix --host-runtime claude --cwd "$WORKING_DIR" --json)',
  ].join('\n'));
  const report = guard.audit({ root });
  assert.strictEqual(report.ok, false);
  assert(report.unexpected.some((item) => item.kind === 'resolver' && item.evidence.startsWith('INJECTED_ROUTE_JSON=')),
    JSON.stringify(report.unexpected, null, 2));
}));

test('removing a registered resolver call is reported as a missing candidate', () => withFixture((root) => {
  const entry = guard.SOURCE_REGISTRY.find((item) => item.kind === 'resolver' && item.classification === 'operational' && item.path === 'skills/forge-task/SKILL.md');
  assert(entry, 'task resolver registry entry absent');
  const measured = byIdentity(guard.discover(root)).get(guard.identity(entry));
  assert(measured, entry.id);
  const lines = read(entry.path, root).split(/\r?\n/);
  lines[measured.line - 1] = lines[measured.line - 1].replace('forge-dispatch-resolve.js', 'forge-dispatch-resolve-removed.js');
  write(entry.path, lines.join('\n'), root);
  const report = guard.audit({ root });
  assert.strictEqual(report.ok, false);
  assert(report.missing.some((item) => item.id === entry.id), JSON.stringify(report.missing, null, 2));
}));

test('a classified operational Agent outside the real fence is structurally rejected', () => withFixture((root) => {
  const relative = 'skills/forge-task/SKILL.md';
  appendSeparated(root, relative, 'injected_result = Agent({ injected_unfenced: true })');
  const item = discovered(root, (candidate) => candidate.kind === 'agent' && candidate.evidence.includes('injected_unfenced'));
  const registry = [...guard.SOURCE_REGISTRY, registerCandidate(item)];
  const report = guard.audit({ root, registry });
  assert.strictEqual(report.ok, false);
  assert(report.errors.some((message) => /outside the real dispatch markers/.test(message)), JSON.stringify(report, null, 2));
}));

test('a classified dispatch emitter missing worker_mode is structurally rejected', () => withFixture((root) => {
  const relative = 'shared/forge-sidecar-next.md';
  appendSeparated(root, relative,
    'echo "{\\"event\\":\\"dispatch\\",\\"host_runtime\\":\\"${HOST_RUNTIME}\\",\\"dispatch_allowed\\":${DISPATCH_ALLOWED}}" >> events.jsonl');
  const item = discovered(root, (candidate) => (
    candidate.path === relative && candidate.kind === 'emitter' && candidate.evidence.includes('events.jsonl') && !candidate.evidence.includes('worker_mode')
  ));
  const registry = [...guard.SOURCE_REGISTRY, registerCandidate(item)];
  const report = guard.audit({ root, registry });
  assert.strictEqual(report.ok, false);
  assert(report.errors.some((message) => /lacks worker_mode/.test(message)), JSON.stringify(report, null, 2));
}));

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const codexReport = codexRenderer.render({
  repo: ROOT,
  projectRoot: path.join(ROOT, 'scripts', '.guard-render-project'),
  codexHome: path.join(ROOT, 'scripts', '.guard-render-codex'),
  forgeHome: path.join(ROOT, 'scripts', '.guard-render-forge'),
  ...codexRenderer.PRODUCTION_DISPATCH_DIALECT,
});
const claudeReport = claudeRenderer.render({
  repo: ROOT,
  projectRoot: path.join(ROOT, 'scripts', '.guard-render-project'),
  claudeHome: path.join(ROOT, 'scripts', '.guard-render-claude'),
  forgeHome: path.join(ROOT, 'scripts', '.guard-render-forge'),
});
const realDiscovery = guard.discover(ROOT);
const realByIdentity = byIdentity(realDiscovery);

test('the installed standalone preparation caller has both guarded entrypoints', () => {
  const entries = guard.SOURCE_REGISTRY.filter((entry) => (
    entry.path === 'skills/forge-task/SKILL.md'
      && entry.kind === 'preparation'
      && entry.classification === 'operational'
  ));
  assert.strictEqual(entries.length, 2, JSON.stringify(entries, null, 2));
  const contexts = entries.map((entry) => realByIdentity.get(guard.identity(entry)).context);
  assert(contexts.some((context) => /--start\s+"?\$PREPARATION_REQUEST_FILE"?/.test(context)));
  assert(contexts.some((context) => /--accept-native\b/.test(context)
    && context.includes('$PREPARATION_ACCEPTANCE_FILE')));
});

test('shared dispatch is absent from manifest surfaces and both renderer reports', () => {
  for (const source of manifest.sources) {
    assert(!source.inputs.includes('shared/forge-dispatch.md'), `${source.source_id} projects shared dispatch`);
    assert(!source.render_targets.some((target) => target.path === 'shared/forge-dispatch.md'), source.source_id);
  }
  assert(codexReport.artifacts.every((artifact) => artifact.source !== 'shared/forge-dispatch.md'));
  assert(claudeReport.artifacts.every((artifact) => artifact.source !== 'shared/forge-dispatch.md'));
});

test('every shared dispatch Agent occurrence remains outside its managed resolver block', () => {
  const document = realDiscovery.documents.get('shared/forge-dispatch.md');
  assert(document.markers.pair, 'shared dispatch marker pair absent');
  const agents = realDiscovery.candidates.filter((item) => item.path === 'shared/forge-dispatch.md' && item.kind === 'agent');
  assert(agents.length > 0);
  for (const agent of agents) {
    const index = agent.line - 1;
    assert(!(index > document.markers.pair.start && index < document.markers.pair.end),
      `shared Agent entered managed block at line ${agent.line}`);
  }
});

test('production Codex and Claude projections preserve the registered operational dialect', () => {
  for (const relative of guard.PROJECTED_SKILLS) {
    const document = realDiscovery.documents.get(relative);
    const codexArtifact = artifactFor(codexReport, relative);
    const claudeArtifact = artifactFor(claudeReport, relative);
    const agents = registryEntries(relative, 'agent');
    const canonicalResolvers = registryEntries(relative, 'resolver').filter((entry) => entry.host_policy === 'canonical');
    assert(agents.length > 0, `no operational Agent registry for ${relative}`);
    assert(canonicalResolvers.length > 0, `no canonical resolver registry for ${relative}`);

    for (const entry of agents) {
      const candidate = realByIdentity.get(guard.identity(entry));
      assert(candidate, entry.id);
      const claudeLine = renderedCandidateLine(document, candidate, claudeArtifact);
      const codexLine = renderedCandidateLine(document, candidate, codexArtifact);
      assert(claudeLine.renderedLines[claudeLine.renderedIndex].includes('Agent('), entry.id);
      assert(!codexLine.renderedLines[codexLine.renderedIndex].includes('Agent('), entry.id);
      assert(codexLine.renderedLines[codexLine.renderedIndex].includes('spawn_agent('), entry.id);
    }

    for (const entry of canonicalResolvers) {
      const candidate = realByIdentity.get(guard.identity(entry));
      const claudeContext = renderedCandidateContext(document, candidate, claudeArtifact);
      const codexContext = renderedCandidateContext(document, candidate, codexArtifact);
      assert(claudeContext.includes('--host-runtime claude'), `${entry.id}\n${claudeContext}`);
      assert(!codexContext.includes('--host-runtime claude'), `${entry.id}\n${codexContext}`);
      assert(codexContext.includes('--host-runtime codex'), `${entry.id}\n${codexContext}`);
    }
  }
});

test('exact host argv from every canonical rendered resolver block resolves to that renderer host', () => withFixture((fixture) => {
  write('T01-PLAN.md', '---\ntier: light\nworker: codex\n---\n# Fixture plan\n', fixture);
  write('M001-ROADMAP.md', '# Fixture roadmap\n- [ ] S01\n', fixture);
  for (const [runtime, report] of [['claude', claudeReport], ['codex', codexReport]]) {
    for (const relative of guard.PROJECTED_SKILLS) {
      const document = realDiscovery.documents.get(relative);
      const artifact = artifactFor(report, relative);
      const entries = registryEntries(relative, 'resolver').filter((entry) => entry.host_policy === 'canonical');
      for (const entry of entries) {
        const candidate = realByIdentity.get(guard.identity(entry));
        const context = renderedCandidateContext(document, candidate, artifact);
        const parsedArgv = resolverArgvFromContext(context);
        const hostIndex = parsedArgv.indexOf('--host-runtime');
        assert(hostIndex >= 0, `${entry.id} host flag absent`);
        assert.strictEqual(occurrenceCount(parsedArgv.join('\n'), /^--host-runtime$/gm), 1, entry.id);
        assert.strictEqual(parsedArgv[hostIndex + 1], runtime, `${entry.id} reconstructed the host`);
        const argv = substituteFixtureArgs(parsedArgv, fixture, candidate);
        assert.strictEqual(argv[argv.indexOf('--host-runtime') + 1], runtime, 'fixture substitution changed host');
        const payload = executeResolverArgv(argv, fixture);
        assert.strictEqual(payload.host_runtime, runtime, `${entry.id}: ${JSON.stringify(payload)}`);
      }
    }
  }
}));

test('supported cross-host delivery and Codex-native delivery are both advisory', () => withFixture((fixture) => {
  const refused = runPosture('codex', 'claude', fixture);
  assert.strictEqual(refused.dispatch_decision, 'advisory');
  assert.strictEqual(refused.dispatch_allowed, true);
  assert.strictEqual(refused.dispatch_reason_code, 'runtime-posture-observed');
  assert.match(refused.dispatch_hint, /sidecar/);
  assert.match(refused.dispatch_hint, /Claude/);

  // The FORGE_RUNTIME_ENFORCE escape was removed: setting it must change nothing
  // in a real spawned resolver process.
  const escapeAttempt = runPosture('codex', 'claude', fixture, cleanRuntimeEnvironment({ FORGE_RUNTIME_ENFORCE: '0' }));
  assert.deepStrictEqual(escapeAttempt, refused);

  const native = runPosture('codex', 'codex', fixture);
  assert.strictEqual(native.host_runtime, 'codex');
  assert.strictEqual(native.worker_mode, 'native');
  assert.strictEqual(native.dispatch_decision, 'advisory');
  assert.strictEqual(native.dispatch_allowed, true);
}));

test('simulated native not-spawned makes one declared same-family sidecar transition', () => {
  const initial = dispatchResolver.composeRuntimePosture(dispatchResolver.runtimeFields({
    hostRuntime: 'codex',
    workerEngine: 'codex',
  }, 'codex'), 'execute-task');
  assert.strictEqual(initial.worker_mode, 'native');
  assert.strictEqual(initial.dispatch_allowed, true);

  const outcome = 'not-spawned';
  let transitionCount = 0;
  let finalMode = initial.worker_mode;
  let sidecarDeclared = initial.sidecar_declared;
  if (outcome === 'not-spawned' && initial.host_runtime === 'codex' &&
      initial.resolved_worker_engine === 'codex' && initial.dispatch_allowed === true && transitionCount === 0) {
    transitionCount += 1;
    finalMode = 'sidecar';
    sidecarDeclared = true;
  }
  const transitioned = dispatchResolver.composeRuntimePosture(dispatchResolver.runtimeFields({
    hostRuntime: initial.host_runtime,
    workerEngine: initial.resolved_worker_engine,
    workerMode: finalMode,
    sidecarDeclared,
  }, 'codex'), 'execute-task');
  assert.strictEqual(transitionCount, 1);
  assert.strictEqual(transitioned.worker_mode, 'sidecar');
  assert.strictEqual(transitioned.sidecar_declared, true);
  assert.strictEqual(transitioned.dispatch_allowed, true);

  const taskAdapter = guard.SOURCE_REGISTRY.find((entry) => (
    entry.path === 'skills/forge-task/SKILL.md' && entry.kind === 'adapter' && entry.classification === 'operational'
  ));
  const candidate = realByIdentity.get(guard.identity(taskAdapter));
  assert(candidate, taskAdapter && taskAdapter.id);
  assert.strictEqual(occurrenceCount(candidate.context, /--sidecar-declared\b/g), 1, candidate.context);
  assert(candidate.context.includes('--host-runtime "$HOST_RUNTIME"'), candidate.context);
});

test('every operational adapter carries host runtime and one sidecar declaration', () => {
  for (const entry of guard.SOURCE_REGISTRY.filter((item) => item.kind === 'adapter' && item.classification === 'operational')) {
    const candidate = realByIdentity.get(guard.identity(entry));
    assert(candidate, entry.id);
    assert.match(candidate.context, /--host-runtime\s+(?:"?\$HOST_RUNTIME"?|claude|codex)\b/, entry.id);
    assert.strictEqual(occurrenceCount(candidate.context, /--sidecar-declared\b/g), 1, `${entry.id}\n${candidate.context}`);
  }
});

test('every operational emitter materializes string/string/boolean runtime fields', () => {
  const emitters = guard.SOURCE_REGISTRY.filter((entry) => entry.kind === 'emitter' && entry.classification === 'operational');
  assert(emitters.length > 0);
  let canonical = 0;
  for (const entry of emitters) {
    const candidate = realByIdentity.get(guard.identity(entry));
    assert(candidate, entry.id);
    if (guard.isCanonicalEmitter(candidate)) {
      // The canonical emitter renders the JSON in scripts/forge-dispatch-event.js
      // (shape asserted by forge-dispatch-event.test.js). The call site only has
      // to hand it the resolver contract, the unit and the log it appends to.
      canonical += 1;
      for (const flag of ['--route-json', '--unit', '--events']) {
        assert(candidate.context.includes(flag), `${entry.id} lacks ${flag}`);
      }
      continue;
    }
    const event = materializeEmitter(candidate);
    assert.strictEqual(event.event, 'dispatch', entry.id);
    assert.strictEqual(typeof event.host_runtime, 'string', entry.id);
    assert.strictEqual(typeof event.worker_mode, 'string', entry.id);
    assert.strictEqual(typeof event.dispatch_allowed, 'boolean', entry.id);
  }
  // Every dispatch event written by the three skills now comes from the one
  // emitter; if this drops to zero a hand-written line came back.
  assert.strictEqual(canonical, 6, `canonical emitter call sites: ${canonical}`);
});

test('Claude historical repin is preserved and current memory/instruction report pins all nine surfaces', () => {
  const historicalBytes = fs.readFileSync(HISTORICAL_GOLDEN_PATH);
  assert.strictEqual(crypto.createHash('sha256').update(historicalBytes).digest('hex'),
    'f2b3e910445d2557f50aa4ced9e1b31498debc6b1cdd1ed05b452d8141b4307f', 'historical Claude 4.19.0 golden must remain byte-for-byte unchanged');
  const historical = JSON.parse(historicalBytes);
  const golden = unitEntry.projectGolden(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')));
  assert.strictEqual(golden.surfaces.length, 9);
  assert.deepStrictEqual(golden.surfaces.map(({ sha256, ...identity }) => identity),
    historical.surfaces.map(({ sha256, ...identity }) => identity));
  const historicalHashes = new Map(historical.surfaces.map(surface => [surface.source_id, surface.sha256]));
  // #347 adds only the measured hooks surface; the chained proof below binds
  // that delta independently and keeps the original 4.19.0 golden immutable.
  assert.deepStrictEqual(golden.surfaces.filter(surface => historicalHashes.get(surface.source_id) !== surface.sha256)
    .map(surface => surface.source_id), ['agents', 'commands', 'skills', 'dispatch-templates', 'hooks', 'claude-instructions', 'configuration']);
  const report = claudeRenderer.render({
    repo: ROOT,
    projectRoot: path.join(ROOT, 'scripts', '.guard-golden-project'),
    claudeHome: path.join(ROOT, 'scripts', '.guard-golden-claude'),
    forgeHome: path.join(ROOT, 'scripts', '.guard-golden-forge'),
  });
  const measured = surfaceHashes(report, golden);
  const currentDrift = golden.surfaces
    .filter((surface) => measured.get(surface.source_id) !== surface.sha256)
    .map((surface) => surface.source_id);
  assert.deepStrictEqual(currentDrift, []);

  // Preserve the older skills-only repin against its immutable historical snapshot.
  const beforeRepin = new Map(historical.surfaces.map((surface) => [
    surface.source_id,
    surface.source_id === 'skills' ? PRE_REPIN_SKILLS_SHA : surface.sha256,
  ]));
  const measuredDrift = historical.surfaces
    .filter((surface) => surface.sha256 !== beforeRepin.get(surface.source_id))
    .map((surface) => surface.source_id);
  assert.deepStrictEqual(measuredDrift, ['skills']);
  assert.notStrictEqual(historical.surfaces.find((surface) => surface.source_id === 'skills').sha256, PRE_REPIN_SKILLS_SHA);
});

// S03/T07 (M-20261101111759-opcoes-prazo-milestones). Expected values come from the
// owner's evidence, never from the renderer under test: the immutable pre-T06 capture
// (copied byte for byte) and the owner's post-T06 measurement (commit a97856f). The
// current render is only the measured side of the comparison.
const LINKED_BEFORE_PATH = path.join(__dirname, 'fixtures', 'linked-task', 'distribution-before.json');
const LINKED_BEFORE_SHA = '0464c29011c5b86a438d6e0f93ac07695957c0273e958018835a47c4ea4387d0';
const LINKED_BEFORE_REVISION = 'f0b5fb17b4c57348e18fbb96bf38e8fb6ef8ee2b';
const OWNER_POST_T06 = Object.freeze({
  commit: 'a97856f221f56ab7038222c8fee115039f829f49',
  surfaces: Object.freeze({ skills: '4b1a158a3faedb66b0aab2033974917cedb4251d3352e90b5f019970330ae548' }),
  contributors: Object.freeze({
    'skills/forge-auto/SKILL.md': ['e39798174f5cba4ce10dd254385cf6726180b077cbee89e382ae6b9348e1e05a', '5a90d205b3295aa4f3f3d331ae8229432257541142777529d513617a173a5c62'],
    'skills/forge-next/SKILL.md': ['e8d04241493f4fa7c5a1db28e075487759fea1dd87dfafdbb750aa06aa723d0f', 'd824741df528de5b38f35aec9e00e9df80349ae8ed4687e0bf6fdb1cb69dc59a'],
    'skills/forge-status/SKILL.md': ['18aa8948fc904b5f10892587e44cd299150b9488f3e3dcf5ebb4d7d8288fa726', '7e0b214a9ae5fc831179f5347f35288c2fd972d0c6fc9a3b00d6ed315e9b1817'],
    'skills/forge-task/SKILL.md': ['d81556180d9bb16d45a8f81ba6b5faa12ece7f6601a510963f29eb50fe10679b', 'af9cf1d0b0b9f68ba751394f935e2c324050b226409f7bea9095700d13ea62ae'],
  }),
});
const LINKED_BLOCK_RE = /^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm;
// T07 itself re-pins only these two files; every other captured source keeps its bytes.
const T07_PIN_FILES = Object.freeze(['scripts/fixtures/claude-renderer/claude-memory-v2.golden.json', 'docs/communication-evaluation/samples.json']);
// #341 (M-20261106040502-review-fix-limites S01/T05). A measured delta is layered over the
// proof below: the capture, OWNER_POST_T06 and every historical value stay as they are; a
// surface or path declared by the delta must carry a before equal to that historical value and
// an after equal to the current measurement. Everything outside the delta keeps its assertion.
const DELTA_341_PATH = path.join(__dirname, 'fixtures', 'review-policy', 'distribution-delta.json');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// The #341 row of a declared surface, file or sample node, or null outside the delta.
function delta341Row(delta, kind, key) {
  return delta && delta[kind] && Object.prototype.hasOwnProperty.call(delta[kind], key) ? delta[kind][key] : null;
}




function jsonValueSpans(text) {
  const spans = new Map();
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
  const expect = char => { assert.strictEqual(text[i], char, `JSON ${char} at ${i}`); i++; };
  const string = () => {
    const start = i; expect('"');
    while (text[i] !== '"') { assert(i < text.length, 'unterminated JSON string'); i += text[i] === '\\' ? 2 : 1; }
    i++;
    return [start, i];
  };
  const key = raw => JSON.parse(raw).replace(/~/g, '~0').replace(/\//g, '~1');
  const value = pointer => {
    ws();
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i] === '{', close = object ? '}' : ']';
      i++; ws();
      if (text[i] === close) { i++; return; }
      for (let index = 0; ; index++) {
        ws();
        if (object) { const [a, b] = string(); ws(); expect(':'); value(`${pointer}/${key(text.slice(a, b))}`); }
        else value(`${pointer}/${index}`);
        ws();
        if (text[i] === ',') { i++; continue; }
        expect(close); return;
      }
    }
    if (text[i] === '"') { spans.set(pointer, string()); return; }
    const start = i;
    while (i < text.length && !',]} \t\r\n'.includes(text[i])) i++;
    assert(i > start, `JSON value at ${start}`);
    spans.set(pointer, [start, i]);
  };
  value(''); ws();
  assert.strictEqual(i, text.length, 'one JSON document');
  return spans;
}

function withSampleShas(text, replacements) {
  const spans = jsonValueSpans(text);
  const edits = replacements.map(([pointer, sha]) => {
    const span = spans.get(`${pointer}/source/sha256`);
    assert(span, `sample node ${pointer} has a source.sha256`);
    return [span, JSON.stringify(sha)];
  }).sort((a, b) => b[0][0] - a[0][0]);
  return edits.reduce((out, [[start, end], literal]) => out.slice(0, start) + literal + out.slice(end), text);
}

// This terminal layer preserves the three immutable earlier distribution deltas.
const IDENTITY_PATH = 'scripts/fixtures/identity-lifecycle/distribution-delta.json';
const IDENTITY = JSON.parse(fs.readFileSync(path.join(ROOT, IDENTITY_PATH), 'utf8'));
const IDENTITY_BASE = '20ae504cbd4e546aaa49f9643955ded1062e67ce';
const IDENTITY_BEFORE = {
  "surfaces": {
    "hooks": {
      "before": "228bceb55413320b8f3b47564711989f454a841d9946ebdfde92f690b733ad1e",
      "attributed_before": "228bceb55413320b8f3b47564711989f454a841d9946ebdfde92f690b733ad1e"
    },
    "skills": {
      "before": "bcb38a84d24878be82872ebfd78f0b6461e1b11bdabcd5829e4181692b15aab4",
      "attributed_before": "78559130c1c543be186ebd14ab2a448c4612e080ff76dbabbe3e915bf10d7819"
    }
  },
  "files": {
    "scripts/forge-hook.js": {
      "before": "1ab156ae4fd74c01c656ce3b378691a2ab126d39343f38d8a19e43ac1ef0a946",
      "attributed_before": "1ab156ae4fd74c01c656ce3b378691a2ab126d39343f38d8a19e43ac1ef0a946"
    },
    "skills/forge-auto/SKILL.md": {
      "before": "11bb75ddae971bbaa0deb2c5271a08a1df3896a132cb3b69bd5a4f554b108d8f",
      "attributed_before": "e248e1a60e0dfccc43b0d0fd0b2f8df78d8d1443571a730e664d843ad62deaa3"
    },
    "skills/forge-task/SKILL.md": {
      "before": "2f3a10c2e2d906b77778077af83d00bb6578f124d92cee4b40b638e787593754",
      "attributed_before": "f85dce7a8bed7c53fd1253183c520f6017e52902b0e2d083ae0a587224269329"
    }
  }
};
const IDENTITY_MEMBERS = {
  "hooks": [
    "scripts/forge-hook.js",
    "scripts/forge-hook.js"
  ],
  "skills": [
    "skills/forge-accounts/SKILL.md",
    "skills/forge-add-slice/SKILL.md",
    "skills/forge-add-task/SKILL.md",
    "skills/forge-ask/SKILL.md",
    "skills/forge-auto/SKILL.md",
    "skills/forge-brainstorm/SKILL.md",
    "skills/forge-codebase/SKILL.md",
    "skills/forge-config/SKILL.md",
    "skills/forge-curate/SKILL.md",
    "skills/forge-discuss/SKILL.md",
    "skills/forge-doctor/SKILL.md",
    "skills/forge-explain/SKILL.md",
    "skills/forge-help/SKILL.md",
    "skills/forge-mcps/SKILL.md",
    "skills/forge-memories/SKILL.md",
    "skills/forge-new-milestone/SKILL.md",
    "skills/forge-next/SKILL.md",
    "skills/forge-pause/SKILL.md",
    "skills/forge-prefs/SKILL.md",
    "skills/forge-probe/SKILL.md",
    "skills/forge-responsive/SKILL.md",
    "skills/forge-risk-radar/SKILL.md",
    "skills/forge-scope-clarity/SKILL.md",
    "skills/forge-security/SKILL.md",
    "skills/forge-skills/SKILL.md",
    "skills/forge-status/SKILL.md",
    "skills/forge-sweep/SKILL.md",
    "skills/forge-task/SKILL.md",
    "skills/forge-ui-review/SKILL.md"
  ]
};
const IDENTITY_PRIOR_DELTAS = {
  "scripts/fixtures/review-policy/distribution-delta.json": "878d8e22adb78fc610bcbff4c4b5ab18e06598d377b4ff3ed38b2a681b0a8309",
  "scripts/fixtures/entry-contracts/distribution-delta.json": "ffb4476cd2ef7b7b8e44676a392e9a11607015fc38d349be9ae2a5fa0a8558a2",
  "scripts/fixtures/artifact-contracts/distribution-delta.json": "d0d50a7cace922a0a5d4edb8668c64429d32c81c40d20eaf9d175d31ad95993f"
};
const IDENTITY_SAMPLE_BEFORE = 'c0a3cdd57bc64ea98691f216712665013a52ee570fdf233ffe6c8c13b1e449ff';
const IDENTITY_SAMPLE_POINTERS = ["/entries/1/supporting/timeline/after","/entries/5/supporting/timeline/after"];
function identityAfter(kind, key, prior, delta = IDENTITY, attributed = false) {
  const row = delta && delta[kind] && Object.hasOwn(delta[kind], key) ? delta[kind][key] : null;
  if (!row) return unitEntry.after(kind, key, prior, attributed);
  assert.strictEqual(row[attributed ? 'attributed_before' : 'before'], prior, 'identity follows preceding ' + kind + ' ' + key);
  return unitEntry.after(kind, key, row[attributed ? 'attributed_after' : 'after'], attributed);
}
function identitySampleAfter(pointer, prior, delta = IDENTITY) {
  const row = delta.samples.nodes.find(node => node.pointer === pointer);
  if (!row) return unitEntry.sampleAfter(pointer, prior);
  assert.strictEqual(row.before, prior, 'identity sample follows #341 ' + pointer);
  return unitEntry.sampleAfter(pointer, row.after);
}
function identitySpanAfter(key, prior, delta = IDENTITY) {
  const row = delta.retained_spans[key];
  if (!row) return prior;
  assert.deepStrictEqual(row.before, prior, 'identity retains historical span ' + key);
  return row.after;
}
function validateIdentitySamples(delta, { sampleText, sampleReadme, readRaw }) {
  sampleText = unitEntry.previousSamples(sampleText);
  const sample = delta.samples;
  assert.deepStrictEqual(Object.keys(sample).sort(), ['file','before','after','nodes'].sort(), 'identity closed sample shape');
  assert.strictEqual(sample.file, 'docs/communication-evaluation/samples.json');
  assert.strictEqual(sample.before, IDENTITY_SAMPLE_BEFORE, 'identity independent full sample before');
  assert.strictEqual(sample.after, sha256(sampleText), 'identity actual full sample after');
  assert.deepStrictEqual(sample.nodes.map(n => n.pointer), IDENTITY_SAMPLE_POINTERS, 'identity exactly two sample nodes');
  const parsed = JSON.parse(sampleText), replacements = [];
  for (const node of sample.nodes) {
    assert.deepStrictEqual(Object.keys(node).sort(), ['pointer','file','before','after'].sort(), 'identity closed sample node');
    assert.strictEqual(node.file, 'skills/forge-task/SKILL.md');
    assert.strictEqual(node.before, IDENTITY_BEFORE.files[node.file].before);
    assert.strictEqual(node.after, delta.files[node.file].after);
    assert.strictEqual(unitEntry.after('files', node.file, node.after), sha256(readRaw(node.file)), 'identity sample actual source');
    const value = node.pointer.split('/').slice(1).reduce((v,k) => v[k], parsed);
    assert.strictEqual(value.source.file, node.file); assert.strictEqual(value.source.sha256, node.after);
    assert(sampleReadme.includes(node.before) && sampleReadme.includes(node.after), 'identity documented sample before/after');
    replacements.push([node.pointer, node.before]);
  }
  assert.strictEqual(sha256(withSampleShas(sampleText, replacements)), IDENTITY_SAMPLE_BEFORE, 'identity only two literal hash spans change; quotes/metadata/layout are immutable');
  assert(sampleReadme.includes(IDENTITY_BASE) && sampleReadme.includes(sample.before) && sampleReadme.includes(sample.after), 'identity samples README records base and full digests');
}
function validateIdentity(delta, { measure, measureAttributed, readRaw, readme, renderMembers, sampleText, sampleReadme }) {
  assert.deepStrictEqual(Object.keys(delta).sort(), ['schema_version','kind','provenance','surfaces','files','retained_spans','samples','unchanged_surfaces'].sort(), 'identity closed delta shape');
  assert.strictEqual(delta.schema_version, 1); assert.strictEqual(delta.kind, 'identity-lifecycle-measured-distribution-delta');
  assert.strictEqual(delta.provenance.base_revision, IDENTITY_BASE);
  assert.strictEqual(delta.provenance.previous_delta, 'scripts/fixtures/artifact-contracts/distribution-delta.json');
  assert.strictEqual(typeof delta.provenance.method, 'string'); assert(delta.provenance.method.length > 0);
  for (const [file,digest] of Object.entries(IDENTITY_PRIOR_DELTAS)) assert.strictEqual(sha256(readRaw(file)), digest, 'identity earlier fixture immutable ' + file);
  assert.deepStrictEqual(Object.keys(delta.surfaces), ["hooks","skills"], 'identity exact surfaces');
  assert.deepStrictEqual(Object.keys(delta.files), ["scripts/forge-hook.js","skills/forge-auto/SKILL.md","skills/forge-task/SKILL.md"], 'identity exact measured files');
  assert.deepStrictEqual([...delta.unchanged_surfaces].sort(), ["agents","claude-instructions","claude-settings","commands","configuration","dispatch-templates","mcp"], 'identity seven untouched surfaces');
  for (const id of Object.keys(IDENTITY_MEMBERS)) assert.deepStrictEqual([...renderMembers[id]].sort(), IDENTITY_MEMBERS[id], 'identity exact rendered members ' + id);
  for (const kind of ['surfaces','files']) for (const [key,row] of Object.entries(delta[kind])) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['before','after','attributed_before','attributed_after'].sort(), 'identity closed measured row');
    for (const digest of Object.values(row)) assert.match(digest, /^[a-f0-9]{64}$/);
    for (const field of ['before','attributed_before']) assert.strictEqual(row[field], IDENTITY_BEFORE[kind][key][field], 'identity independent before ' + key);
    assert.notStrictEqual(row.before, row.after, 'identity actual changed member');
    const raw = kind === 'surfaces' ? measure(key) : sha256(readRaw(key));
    const attributed = kind === 'surfaces' ? measureAttributed(key) : sha256(Buffer.from(readRaw(key).toString('utf8').replace(LINKED_BLOCK_RE, ''), 'utf8'));
    assert.strictEqual(unitEntry.after(kind, key, row.after), raw, 'identity actual raw ' + key);
    assert.strictEqual(unitEntry.after(kind, key, row.attributed_after, true), attributed, 'identity actual attributed ' + key);
    if (kind === 'surfaces') assert(readme.includes(row.before) && readme.includes(row.after) && readme.includes(row.attributed_before) && readme.includes(row.attributed_after), 'identity documented surface ' + key);
  }
  assert(readme.includes(IDENTITY_BASE), 'identity README real base');
  assert.deepStrictEqual(Object.keys(delta.retained_spans), ['fresh_registration'], 'identity exact changed historical span');
  const spanRow = delta.retained_spans.fresh_registration;
  assert.deepStrictEqual(Object.keys(spanRow).sort(), ['file','before','after'].sort());
  assert.strictEqual(spanRow.file, 'skills/forge-task/SKILL.md');
  assert.deepStrictEqual(spanRow.before, {"bytes":1803,"sha256":"b0d14d5ba51b0096922338482ad357c77a193e5af4097616fbdc469681ee7874"}, 'identity independent historical fresh-registration anchor');
  for (const value of [spanRow.before, spanRow.after]) { assert.deepStrictEqual(Object.keys(value).sort(), ['bytes','sha256']); assert(Number.isInteger(value.bytes) && value.bytes > 0); assert.match(value.sha256, /^[a-f0-9]{64}$/); }
  const taskText = readRaw(spanRow.file).toString('utf8'), start = taskText.indexOf('**Register in multi-run registry**'), end = taskText.indexOf('\nThis makes the task visible', start);
  assert(start >= 0 && end > start);
  const span = Buffer.from(taskText.slice(start, end + 1));
  assert.deepStrictEqual(spanRow.after, { bytes: span.length, sha256: sha256(span) }, 'identity actual fresh-registration postimage');
  assert(readme.includes(spanRow.before.sha256) && readme.includes(spanRow.after.sha256), 'identity documents bounded historical span delta');
  validateIdentitySamples(delta, { sampleText, sampleReadme, readRaw });
}

// #348 follows the immutable #347 layer. Only planner guidance changes this
// rendered surface; #353 and the mandatory budget-attribution repair do not.
const ARTIFACT_348_PATH = path.join(ROOT, 'scripts/fixtures/artifact-contracts/distribution-delta.json');
const ARTIFACT_348 = JSON.parse(fs.readFileSync(ARTIFACT_348_PATH, 'utf8'));
const ARTIFACT_348_BASE = 'c91dfc77231a176892df72f56c0eefefbbd430be';
const ARTIFACT_348_PRIOR_PIN = '91dd5d2a3ece86df030fcf5e374041c3bb496da040baf3f3a2830445061c8c5e';
const ARTIFACT_348_PRIOR_PLANNER = '45ceadf4a8299115a9a492a9beab4e4c83e29748ca68af03763144b5e904e4cb';
const ARTIFACT_348_PREVIOUS_DELTA_SHA = 'ffb4476cd2ef7b7b8e44676a392e9a11607015fc38d349be9ae2a5fa0a8558a2';
function artifact348After(kind, key, prior, delta = ARTIFACT_348, attributed = false) {
  const row = delta && delta[kind] && Object.hasOwn(delta[kind], key) ? delta[kind][key] : null;
  if (!row) return identityAfter(kind, key, prior, IDENTITY, attributed);
  assert.strictEqual(row[attributed ? 'attributed_before' : 'before'], prior, '#348 follows preceding ' + kind + ' ' + key);
  return identityAfter(kind, key, row[attributed ? 'attributed_after' : 'after'], IDENTITY, attributed);
}
function validateArtifact348(delta, previous, { measure, readRaw, readme }) {
  assert.deepStrictEqual(Object.keys(delta).sort(), ['schema_version','issue','provenance','surfaces','files','unchanged_surfaces'].sort(), '#348 closed delta shape');
  assert.strictEqual(delta.schema_version, 1); assert.strictEqual(delta.issue, 348);
  assert.strictEqual(delta.provenance.base_revision, ARTIFACT_348_BASE, '#348 named base');
  assert.strictEqual(delta.provenance.previous_delta, 'scripts/fixtures/entry-contracts/distribution-delta.json');
  assert.strictEqual(typeof delta.provenance.method, 'string'); assert(delta.provenance.method.length > 0);
  assert.strictEqual(sha256(readRaw('scripts/fixtures/entry-contracts/distribution-delta.json')), ARTIFACT_348_PREVIOUS_DELTA_SHA, '#347 fixture remains immutable');
  assert.deepStrictEqual(Object.keys(delta.surfaces), ['agents'], '#348 exactly one affected surface');
  assert.deepStrictEqual(Object.keys(delta.files), ['agents/forge-planner.md'], '#348 exactly one changed rendered member');
  assert.deepStrictEqual([...delta.unchanged_surfaces].sort(), ["claude-instructions","claude-settings","commands","configuration","dispatch-templates","hooks","mcp","skills"], '#348 eight untouched surfaces');
  for (const [kind,key,expectedBefore] of [['surfaces','agents',ARTIFACT_348_PRIOR_PIN],['files','agents/forge-planner.md',ARTIFACT_348_PRIOR_PLANNER]]) {
    const row = delta[kind][key], old = previous[kind][key];
    assert.deepStrictEqual(Object.keys(row).sort(), ['before','after','attributed_before','attributed_after'].sort(), '#348 closed row');
    for (const field of Object.keys(row)) assert.match(row[field], /^[a-f0-9]{64}$/, '#348 valid digest');
    assert.strictEqual(row.before, expectedBefore, '#348 independent before anchor');
    assert.strictEqual(row.before, old.after, '#348 raw chain from347');
    assert.strictEqual(row.attributed_before, old.attributed_after, '#348 attributed chain from347');
    assert.strictEqual(row.before, row.attributed_before); assert.strictEqual(row.after, row.attributed_after);
    assert.notStrictEqual(row.before, row.after, '#348 actual bounded change');
    const actual = kind === 'surfaces' ? measure(key) : sha256(readRaw(key));
    assert.strictEqual(unitEntry.after(kind, key, row.after), actual, '#348 actual measured ' + kind);
  }
  assert(readme.includes(ARTIFACT_348_BASE) && readme.includes(delta.surfaces.agents.before) && readme.includes(delta.surfaces.agents.after), '#348 README records the real base/before/after');
}

// #347 is a subsequent measured layer. These before anchors were read from the
// named base commit, not recomputed from current sources or old owner captures.
const ENTRY_347_PATH = path.join(__dirname, 'fixtures', 'entry-contracts', 'distribution-delta.json');
const ENTRY_347 = JSON.parse(fs.readFileSync(ENTRY_347_PATH, 'utf8'));
const ENTRY_347_MEMBERS = Object.freeze({
  "agents": [
    "agents/forge-advocate.md",
    "agents/forge-completer.md",
    "agents/forge-discusser.md",
    "agents/forge-executor.md",
    "agents/forge-plan-checker.md",
    "agents/forge-planner.md",
    "agents/forge-researcher.md",
    "agents/forge-reviewer.md",
    "agents/forge-worker.md"
  ],
  "hooks": [
    "scripts/forge-hook.js"
  ]
});
const ENTRY_347_RENDER_MEMBERS = Object.freeze({
  "agents": [
    "agents/forge-advocate.md",
    "agents/forge-completer.md",
    "agents/forge-discusser.md",
    "agents/forge-executor.md",
    "agents/forge-memory.md",
    "agents/forge-plan-checker.md",
    "agents/forge-planner.md",
    "agents/forge-researcher.md",
    "agents/forge-reviewer.md",
    "agents/forge-worker.md"
  ],
  "hooks": [
    "scripts/forge-hook.js",
    "scripts/forge-hook.js"
  ]
});
const ENTRY_347_FILES = Object.freeze([
  "agents/forge-advocate.md",
  "agents/forge-completer.md",
  "agents/forge-discusser.md",
  "agents/forge-executor.md",
  "agents/forge-plan-checker.md",
  "agents/forge-planner.md",
  "agents/forge-researcher.md",
  "agents/forge-reviewer.md",
  "agents/forge-worker.md",
  "scripts/forge-hook.js",
  "shared/forge-dispatch.md"
]);
const ENTRY_347_BEFORE_FILES = Object.freeze({
  "agents/forge-advocate.md": {
    "before": "3cb47445f6bc4ddbd8a2ade71ce553f2d1eb5b60e59b3166f7251cc2c989471f",
    "attributed_before": "3cb47445f6bc4ddbd8a2ade71ce553f2d1eb5b60e59b3166f7251cc2c989471f"
  },
  "agents/forge-completer.md": {
    "before": "576c9be21fdab8d128302cd72582dec72f2d3560b142736fcecdfd8710c11a4c",
    "attributed_before": "576c9be21fdab8d128302cd72582dec72f2d3560b142736fcecdfd8710c11a4c"
  },
  "agents/forge-discusser.md": {
    "before": "cf015bf24fb5c3472787d01222f9afa7fb52d166d82a1fd337488a70cebd4979",
    "attributed_before": "cf015bf24fb5c3472787d01222f9afa7fb52d166d82a1fd337488a70cebd4979"
  },
  "agents/forge-executor.md": {
    "before": "40cc7485dc0b67815db6ffdbd3a43b14671d85010c647e795863426cc5aba0dc",
    "attributed_before": "40cc7485dc0b67815db6ffdbd3a43b14671d85010c647e795863426cc5aba0dc"
  },
  "agents/forge-plan-checker.md": {
    "before": "d31f7b7025cdd24a7a42c476204a54b684f083417c57df95244782c05802ffcb",
    "attributed_before": "d31f7b7025cdd24a7a42c476204a54b684f083417c57df95244782c05802ffcb"
  },
  "agents/forge-planner.md": {
    "before": "e97cb09294ef4cea8afc79896a8854836a78122bb5c4451b24fa37daf3fbd02e",
    "attributed_before": "e97cb09294ef4cea8afc79896a8854836a78122bb5c4451b24fa37daf3fbd02e"
  },
  "agents/forge-researcher.md": {
    "before": "40cc2294610659f9de44538e00c9f3cc22a52c27bd7768e68c8a767234db8947",
    "attributed_before": "40cc2294610659f9de44538e00c9f3cc22a52c27bd7768e68c8a767234db8947"
  },
  "agents/forge-reviewer.md": {
    "before": "d2d92895ae7b9a5fb6faa56fa4a3c256d337941bbf1c7386bcab555bd9c5ddf9",
    "attributed_before": "d2d92895ae7b9a5fb6faa56fa4a3c256d337941bbf1c7386bcab555bd9c5ddf9"
  },
  "agents/forge-worker.md": {
    "before": "5924147d58486e2bb16bf16811730a80f20b964c89d553ae39b6ca27cb23e29f",
    "attributed_before": "5924147d58486e2bb16bf16811730a80f20b964c89d553ae39b6ca27cb23e29f"
  },
  "scripts/forge-hook.js": {
    "before": "6d95cf27d00e39d7f20487bd30695436a81cbcc8ef6b5bf9340f2fa5178edfd0",
    "attributed_before": "6d95cf27d00e39d7f20487bd30695436a81cbcc8ef6b5bf9340f2fa5178edfd0"
  },
  "shared/forge-dispatch.md": {
    "before": "04c89ff6107ee798a00c7ab52a1ac644356d0c3269a7965e9b4fe73f6b37cafe",
    "attributed_before": "e53e8989da10f313ba3d8183a43341b814c3b57c4d08b7b5395e9626ab307373"
  }
});
const ENTRY_347_BEFORE_SURFACES = Object.freeze({
  "agents": {
    "before": "30d0fb3fecdb88a4d2ac76dbb5a1ee6669aa3455f1fa41461137f89a164921c0",
    "attributed_before": "30d0fb3fecdb88a4d2ac76dbb5a1ee6669aa3455f1fa41461137f89a164921c0"
  },
  "hooks": {
    "before": "c149db9dd45bed13f05931987217d224a6f23d805dc6e8900e46b32893a41c48",
    "attributed_before": "c149db9dd45bed13f05931987217d224a6f23d805dc6e8900e46b32893a41c48"
  }
});
const ENTRY_347_UNCHANGED = Object.freeze(["claude-instructions","claude-settings","commands","configuration","dispatch-templates","mcp","skills"]);
function entry347Row(delta, kind, key) {
  return delta && delta[kind] && Object.hasOwn(delta[kind], key) ? delta[kind][key] : null;
}
function entry347After(kind, key, prior, delta = ENTRY_347, attributed = false) {
  const row = entry347Row(delta, kind, key);
  if (!row) return artifact348After(kind, key, prior, ARTIFACT_348, attributed);
  const beforeKey = attributed ? 'attributed_before' : 'before';
  const afterKey = attributed ? 'attributed_after' : 'after';
  assert.strictEqual(row[beforeKey], prior, '#347 ' + kind + ' ' + key + ': before follows the preceding layer');
  assert.match(row[afterKey], /^[0-9a-f]{64}$/, '#347 measured after');
  return artifact348After(kind, key, row[afterKey], ARTIFACT_348, attributed);
}
function validateEntry347(delta, earlier, { measure, readRaw, readme, renderMembers, artifactDelta = ARTIFACT_348 }) {
  validateArtifact348(artifactDelta, delta, { measure, readRaw, readme });
  assert.deepStrictEqual(Object.keys(delta).sort(), ['schema_version', 'issue', 'provenance', 'surfaces', 'files', 'unchanged_surfaces'].sort(), '#347 closed delta shape');
  assert.strictEqual(delta.schema_version, 1); assert.strictEqual(delta.issue, 347);
  assert.strictEqual(delta.provenance.base_revision, 'ad62d774fc37ec6fcf5a85347d69eaf5c8a8c675', '#347 named base revision');
  assert.strictEqual(typeof delta.provenance.method, 'string'); assert(delta.provenance.method.length > 0);
  assert.deepStrictEqual(Object.keys(delta.surfaces).sort(), ['agents', 'hooks'], '#347 exact affected surfaces');
  assert.deepStrictEqual(Object.keys(delta.files).sort(), [...ENTRY_347_FILES].sort(), '#347 exact changed files');
  assert.deepStrictEqual([...delta.unchanged_surfaces].sort(), [...ENTRY_347_UNCHANGED], '#347 exact untouched surfaces');
  assert.deepStrictEqual(Object.keys(renderMembers).sort(), ['agents', 'hooks'], '#347 exact rendered member groups');
  for (const [id, expected] of Object.entries(ENTRY_347_RENDER_MEMBERS)) assert.deepStrictEqual([...renderMembers[id]].sort(), [...expected].sort(), '#347 exact rendered members ' + id);
  for (const [kind, anchors] of [['surfaces', ENTRY_347_BEFORE_SURFACES], ['files', ENTRY_347_BEFORE_FILES]]) {
    for (const [key, anchor] of Object.entries(anchors)) {
      const row = delta[kind][key];
      assert.deepStrictEqual(Object.keys(row).sort(), ['before', 'after', 'attributed_before', 'attributed_after'].sort(), '#347 closed row ' + key);
      for (const field of ['before','after','attributed_before','attributed_after']) assert.match(row[field], /^[0-9a-f]{64}$/, '#347 hash ' + key + '/' + field);
      assert.strictEqual(row.before, anchor.before, '#347 immutable base raw ' + key);
      assert.strictEqual(row.attributed_before, anchor.attributed_before, '#347 immutable base attributed ' + key);
      const previous = earlier[kind] && earlier[kind][key];
      if (previous) {
        assert.strictEqual(row.before, previous.after, '#347 raw chain after #341 ' + key);
        assert.strictEqual(row.attributed_before, previous.attributed_after || previous.after, '#347 attributed chain after #341 ' + key);
      }
      assert.notStrictEqual(row.before, row.after, '#347 actual change ' + key);
      if (kind === 'surfaces') {
        assert.strictEqual(row.after, row.attributed_after, '#347 surfaces have no linked blocks ' + key);
        assert.strictEqual(measure(key), artifact348After(kind, key, row.after, artifactDelta), '#347 measured surface followed by348 ' + key);
        assert(readme.includes(row.before) && readme.includes(row.after), '#347 README records ' + key + ' before/after');
      } else {
        const raw = readRaw(key);
        assert.strictEqual(sha256(raw), artifact348After(kind, key, row.after, artifactDelta), '#347 measured file followed by348 ' + key);
        assert.strictEqual(sha256(Buffer.from(raw.toString('utf8').replace(LINKED_BLOCK_RE, ''), 'utf8')), artifact348After(kind, key, row.attributed_after, artifactDelta, true), '#347 measured attributed file followed by348 ' + key);
      }
    }
  }
}

// Pins and captured sources of the linked-task proof. The defaults read the real bytes; the
// #341 negative fixtures only pass in-memory golden, README, delta or file variants.
function assertLinkedPinsAndSources({ before, declared, delta, golden, measured, readme, artifacts, entryDelta = ENTRY_347, artifactDelta = ARTIFACT_348, identityDelta = IDENTITY,
  identitySampleText = fs.readFileSync(path.join(ROOT, 'docs/communication-evaluation/samples.json'), 'utf8'),
  identitySampleReadme = fs.readFileSync(path.join(ROOT, 'docs/communication-evaluation/README.md'), 'utf8'),
  readRaw = (relative) => fs.readFileSync(path.join(ROOT, relative)) }) {
  unitEntry.validate({ artifacts, readRaw });
  validateIdentity(identityDelta, { measure: id => measured.get(id),
    measureAttributed: id => sha256(artifacts.filter(a => a.source_id === id).sort((a,b) => a.source.localeCompare(b.source)).map(a => a.source + '\0' + a.content.replace(LINKED_BLOCK_RE, '').replace(/version=\d+\.\d+\.\d+/g, 'version=<dynamic>')).join('\0')),
    readRaw, readme, renderMembers: Object.fromEntries(['hooks','skills'].map(id => [id, artifacts.filter(a => a.source_id === id).map(a => a.source)])),
    sampleText: identitySampleText, sampleReadme: identitySampleReadme });
  validateEntry347(entryDelta, delta, { measure: id => measured.get(id), readRaw, readme, artifactDelta,
    renderMembers: Object.fromEntries(['agents', 'hooks'].map(id => [id, artifacts.filter(item => item.source_id === id).map(item => item.source)])) });
  // Pins: every new layer starts at the independently retained preceding value.
  for (const surface of golden.surfaces) {
    const prior = before.active_golden_before.surfaces.find((row) => row.source_id === surface.source_id).sha256;
    const ownerAfter = OWNER_POST_T06.surfaces[surface.source_id] || prior;
    const row341 = delta341Row(delta, 'surfaces', surface.source_id);
    if (row341) {
      assert.strictEqual(row341.before, ownerAfter, `${surface.source_id}: #341 before is the owner after pin`);
      assert.strictEqual(row341.attributed_before || row341.before, prior, `${surface.source_id}: #341 attributed before is the capture`);
    }
    const expected = entry347After('surfaces', surface.source_id, row341 ? row341.after : ownerAfter, entryDelta);
    assert.strictEqual(surface.sha256, expected, `active pin ${surface.source_id}`);
    assert.strictEqual(measured.get(surface.source_id), expected, `measured ${surface.source_id}`);
    if (expected !== prior) assert(readme.includes(prior) && readme.includes(expected), `README records ${surface.source_id} before/after`);
    if (row341) assert(readme.includes(row341.before), `README records the #341 before of ${surface.source_id}`);
  }
  assert(readme.includes(LINKED_BEFORE_REVISION) && readme.includes(LINKED_BEFORE_SHA) && readme.includes(OWNER_POST_T06.commit));
  for (const historical of before.historical_goldens) {
    assert.strictEqual(sha256(readRaw(historical.path)), historical.sha256, `${historical.path} frozen`);
  }

  // Every other captured source keeps its exact bytes (#341: a declared path moves from the capture to its measured after).
  for (const source of before.sources) {
    if (declared.has(source.path) || T07_PIN_FILES.includes(source.path)) continue;
    const row341 = delta341Row(delta, 'files', source.path);
    if (row341) assert.strictEqual(row341.before, source.sha256, `${source.path}: #341 before is the capture`);
    assert.strictEqual(sha256(readRaw(source.path)), entry347After('files', source.path, row341 ? row341.after : source.sha256, entryDelta), `unchanged source ${source.path}`);
  }
}

test('linked-task scoped pins follow the owner pre-T06 capture and the measured source map only', () => {
  const beforeBytes = fs.readFileSync(LINKED_BEFORE_PATH);
  assert.strictEqual(sha256(beforeBytes), LINKED_BEFORE_SHA, 'fixture is the exact owner capture');
  const before = JSON.parse(beforeBytes);
  assert.strictEqual(before.kind, 'owner-captured-pre-S03-T06-distribution-baseline');
  assert.strictEqual(before.provenance.source_revision, LINKED_BEFORE_REVISION);
  assert.strictEqual(before.provenance.not_post_change_verification, true);
  assert.strictEqual(before.provenance.pre_T06_writer, true);
  assert.deepStrictEqual(before.preexisting_drift.active_surfaces, []);
  const declared = new Set(before.declared_T06_paths);
  assert.strictEqual(declared.size, 10);
  const delta = JSON.parse(fs.readFileSync(DELTA_341_PATH, 'utf8'));
  assert.strictEqual(delta.kind, 'issue-341-measured-distribution-delta');
  assert.strictEqual(delta.provenance.base_revision, '563ac2752722ac7c29848f62520c8446185bc15c');
  const declared341 = new Set(delta.declared_paths);

  // Nine surfaces measured by the canonical formula; identities equal the capture.
  const golden = unitEntry.projectGolden(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')));
  assert.deepStrictEqual(golden.surfaces.map(({ sha256: _, ...identity }) => identity),
    before.active_golden_before.surfaces.map(({ sha256: _, ...identity }) => identity));
  const report = claudeRenderer.render({
    repo: ROOT,
    projectRoot: path.join(ROOT, 'scripts', '.guard-golden-project'),
    claudeHome: path.join(ROOT, 'scripts', '.guard-golden-claude'),
    forgeHome: path.join(ROOT, 'scripts', '.guard-golden-forge'),
  });
  const measured = surfaceHashes(report, golden);

  // Source map: every member of every surface, captured bytes versus current bytes.
  const renderBefore = new Map(before.render_before.map((row) => [row.source_id, row]));
  const affected = [];
  const contributors = new Set();
  for (const surface of before.active_golden_before.surfaces) {
    const row = renderBefore.get(surface.source_id);
    assert(row, `capture has the members of ${surface.source_id}`);
    assert.strictEqual(row.pinned_before, surface.sha256);
    assert.strictEqual(row.rendered_before, surface.sha256, `capture rendered ${surface.source_id} equal to its pin`);
    const changedMembers = row.source_members
      .filter((member) => sha256(fs.readFileSync(path.join(ROOT, member.source))) !== member.sha256)
      .map((member) => member.source);
    for (const member of changedMembers) {
      assert(declared.has(member) || declared341.has(member) || ENTRY_347_FILES.includes(member) || unitEntry.files.includes(member), `drift of ${surface.source_id} is attributed to a declared T06 path: ${member}`);
      contributors.add(member);
    }
    const drifted = measured.get(surface.source_id) !== surface.sha256;
    assert.strictEqual(drifted, changedMembers.length > 0, `${surface.source_id}: measured drift iff a member source changed`);
    if (drifted) affected.push(surface.source_id);
  }
  // #341: the affected surfaces are the owner after map plus exactly the surfaces the delta declares.
  const captureOrder = before.active_golden_before.surfaces.map((surface) => surface.source_id);
  assert.deepStrictEqual(affected, captureOrder.filter((id) => id in OWNER_POST_T06.surfaces || delta341Row(delta, 'surfaces', id) || entry347Row(ENTRY_347, 'surfaces', id)),
    'measured affected surfaces equal the owner after map plus the declared #341 surfaces');
  assert.deepStrictEqual(affected.filter((id) => !delta341Row(delta, 'surfaces', id) && !entry347Row(ENTRY_347, 'surfaces', id)),
    Object.keys(OWNER_POST_T06.surfaces).filter((id) => !delta341Row(delta, 'surfaces', id) && !entry347Row(ENTRY_347, 'surfaces', id)), 'outside the #341 delta the owner after map is unchanged');
  const members341 = Object.values(delta.surfaces).flatMap((row) => row.members);
  assert.deepStrictEqual([...contributors].sort(), [...new Set([...Object.keys(OWNER_POST_T06.contributors), ...members341, ...Object.values(ENTRY_347_MEMBERS).flat(), ...unitEntry.files])].sort());
  for (const [file, [beforeSha, afterSha]] of Object.entries(OWNER_POST_T06.contributors)) {
    const raw = fs.readFileSync(path.join(ROOT, file));
    assert.strictEqual(before.sources.find((row) => row.path === file).sha256, beforeSha, `${file} before value is the capture`);
    const withoutLinked = sha256(Buffer.from(raw.toString('utf8').replace(LINKED_BLOCK_RE, ''), 'utf8'));
    const row341 = delta341Row(delta, 'files', file);
    if (row341) {
      // #341 starts from the owner after measurement and from the pre-T06 bytes outside the linked blocks.
      assert.strictEqual(row341.before, afterSha, `${file}: #341 before is the owner after measurement`);
      assert.strictEqual(row341.attributed_before, beforeSha, `${file}: #341 attributed before is the capture`);
      assert.strictEqual(sha256(raw), entry347After('files', file, row341.after), `${file}: #341 raw intermediate followed by #347`);
      assert.strictEqual(withoutLinked, entry347After('files', file, row341.attributed_after, ENTRY_347, true), `${file}: #341 attributed intermediate followed by #347`);
      continue;
    }
    assert.strictEqual(sha256(raw), entry347After('files', file, afterSha), `${file}: owner raw measurement followed by #347`);
    // The whole delta is the T06 linked blocks: removing them restores the pre-T06 bytes.
    assert.strictEqual(withoutLinked, entry347After('files', file, beforeSha, ENTRY_347, true), `${file}: owner attributed measurement followed by #347`);
  }
  for (const [file, row341] of Object.entries(delta.files)) {
    if (file in OWNER_POST_T06.contributors) continue;
    assert(!declared.has(file), `${file}: a non-T06 #341 path`);
    assert.strictEqual(sha256(fs.readFileSync(path.join(ROOT, file))), entry347After('files', file, row341.after), `${file} equals the #341 measurement followed by #347`);
  }

  // Pins and every other captured source: shared with the #341 negative fixtures below.
  const readme = unitEntry.readme(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-renderer', 'README.md'), 'utf8'));
  assertLinkedPinsAndSources({ before, declared, delta, golden, measured, readme, artifacts: report.artifacts });

  // Samples: only the four source.sha256 values move to the raw bytes of their source.
  const sampleText = fs.readFileSync(path.join(ROOT, before.samples.file), 'utf8');
  const samples = JSON.parse(sampleText);
  const sampleReadme = fs.readFileSync(path.join(ROOT, 'docs', 'communication-evaluation', 'README.md'), 'utf8');
  const allowed = before.samples.normalization.allowed_json_pointers;
  assert.strictEqual(allowed.length, 4);
  let restored = sampleText;
  const nodes341 = new Map(delta.samples.nodes.map((row) => [row.pointer, row]));
  assert.strictEqual(nodes341.size, 4);
  for (const prior of before.samples.all_task_next_samples) {
    const node = prior.pointer.split('/').slice(1).reduce((value, key) => value[key], samples);
    assert(allowed.includes(`${prior.pointer}/source/sha256`));
    assert.strictEqual(node.text, prior.text, `${prior.pointer} quoted text is literal`);
    assert.strictEqual(node.label, prior.label);
    assert.deepStrictEqual({ ...node.source, sha256: prior.source.sha256 }, prior.source, `${prior.pointer} metadata`);
    const [, afterSha] = OWNER_POST_T06.contributors[prior.source.file];
    // #341: a declared node moves from the owner after measurement to the measured raw bytes of its source.
    const node341 = nodes341.get(prior.pointer) || null;
    if (node341) {
      assert.strictEqual(node341.file, prior.source.file, `${prior.pointer}: #341 node cites the same source`);
      assert.strictEqual(node341.before, afterSha, `${prior.pointer}: #341 before is the owner after measurement`);
      assert.strictEqual(identitySampleAfter(prior.pointer, node341.after), sha256(fs.readFileSync(path.join(ROOT, prior.source.file))), `${prior.pointer}: #341 after is the raw source bytes`);
      assert(sampleReadme.includes(node341.before) && sampleReadme.includes(node341.after), `samples README records the #341 ${prior.pointer}`);
    }
    const cited = identitySampleAfter(prior.pointer, node341 ? node341.after : afterSha);
    assert.strictEqual(node.source.sha256, cited, `${prior.pointer} cites the raw source bytes`);
    assert(fs.readFileSync(path.join(ROOT, prior.source.file), 'utf8').includes(node.text), `${prior.pointer} text present`);
    assert(sampleReadme.includes(prior.source.sha256) && sampleReadme.includes(afterSha), `samples README records ${prior.pointer}`);
    restored = restored.replace(`"sha256": "${cited}"`, `"sha256": "${prior.source.sha256}"`);
  }
  assert.deepStrictEqual([...nodes341.keys()].filter((pointer) => !before.samples.all_task_next_samples.some((prior) => prior.pointer === pointer)), [],
    '#341 declares no other sample node');
  assert.strictEqual(sha256(Buffer.from(restored, 'utf8')), before.samples.sha256, 'only the four source.sha256 values changed');

  // Registry: measured drift zero, so every row/classification/reason/fingerprint is the capture.
  const auditResult = guard.audit({ root: ROOT });
  assert.strictEqual(auditResult.ok, true, JSON.stringify(auditResult));
  assert.strictEqual(unitEntry.previousRegistry(guard.SOURCE_REGISTRY).length, before.dispatch_registry.audit_before.registered_count);
  // #341: the delta declares the measured registry change; drifted rows swap only id and fingerprint.
  assert.strictEqual(delta.registry.count, before.dispatch_registry.audit_before.registered_count, '#341 keeps the registry count');
  assert.deepStrictEqual([delta.registry.added, delta.registry.removed], [[], []], '#341 adds or removes no registered call');
  const drift341 = new Map(delta.registry.drifted_rows.map((row) => [row.before_id, row]));
  const registryExact = before.dispatch_registry.registry_exact.map((row) => {
    const drift = drift341.get(row.id);
    if (!drift) return row;
    assert.strictEqual(drift.before_fingerprint, row.fingerprint, `${row.id}: #341 drift starts from the captured fingerprint`);
    return { ...row, id: drift.after_id, fingerprint: drift.after_fingerprint };
  });
  assert.strictEqual(drift341.size, delta.registry.drifted_rows.length, '#341 drift rows are distinct');
  assert.deepStrictEqual(unitEntry.previousRegistry(guard.SOURCE_REGISTRY).map((row) => ({ ...row })), registryExact);
  process.stdout.write('ok - chain-distribution-pins-follow-owner-pre-t06-baseline-and-measured-source-map-only\n');
});

test('#341 linked-task layer refuses edits outside the delta, wrong pins, bad delta before values and undocumented re-pins', () => {
  const before = JSON.parse(fs.readFileSync(LINKED_BEFORE_PATH));
  const declared = new Set(before.declared_T06_paths);
  const delta = JSON.parse(fs.readFileSync(DELTA_341_PATH, 'utf8'));
  const golden = unitEntry.projectGolden(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')));
  const report = claudeRenderer.render({
    repo: ROOT,
    projectRoot: path.join(ROOT, 'scripts', '.guard-golden-project'),
    claudeHome: path.join(ROOT, 'scripts', '.guard-golden-claude'),
    forgeHome: path.join(ROOT, 'scripts', '.guard-golden-forge'),
  });
  const measured = surfaceHashes(report, golden);
  const readme = unitEntry.readme(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-renderer', 'README.md'), 'utf8'));
  const base = { before, declared, delta, golden, measured, readme, artifacts: report.artifacts };
  assertLinkedPinsAndSources(base);
  // In-memory variants only: no pin, README, capture or source file is written.
  const refused = (label, overrides) => assert.throws(() => assertLinkedPinsAndSources({ ...base, ...overrides }),
    (error) => error instanceof assert.AssertionError, `${label} must be refused`);
  const variant = (mutate) => { const copy = JSON.parse(JSON.stringify(delta)); mutate(copy); return copy; };
  const readRaw = (relative) => fs.readFileSync(path.join(ROOT, relative));
  const edited = (target) => (relative) => (relative === target ? Buffer.concat([readRaw(relative), Buffer.from('\nedit outside the measured delta\n')]) : readRaw(relative));
  const wrong = sha256('not a measured #341 value');
  refused('captured source edit outside the delta', { readRaw: edited('commands/forge.md') });
  refused('declared #341 path edited after its measurement', { readRaw: edited('shared/forge-procedures.json') });
  refused('wrong active pin', { golden: { ...golden, surfaces: golden.surfaces.map((row) => (row.source_id === 'agents' ? { ...row, sha256: wrong } : row)) },
    readme: `${readme}\n${wrong}\n` });
  refused('bad delta surface before', { delta: variant((copy) => { copy.surfaces.skills.before = wrong; }) });
  refused('bad delta file before', { delta: variant((copy) => { copy.files['shared/forge-procedure-review.md'].before = wrong; }) });
  refused('re-pin not declared by the delta', { delta: variant((copy) => { delete copy.surfaces.configuration; }) });
  refused('undocumented re-pin', { readme: readme.split(delta.surfaces.agents.after).join('') });

  // #347 variants are layered after an independently valid #341 state. No old fixture is rewritten.
  const variant347 = mutate => { const copy = JSON.parse(JSON.stringify(ENTRY_347)); mutate(copy); return copy; };
  refused('#347 foreign before', { entryDelta: variant347(d => { d.surfaces.agents.before = wrong; }) });
  refused('#347 coherent invented after', { entryDelta: variant347(d => { d.surfaces.agents.after = wrong; d.surfaces.agents.attributed_after = wrong; }) });
  refused('#347 extra surface', { entryDelta: variant347(d => { d.surfaces.commands = { ...d.surfaces.agents }; }) });
  refused('#347 omitted surface', { entryDelta: variant347(d => { delete d.surfaces.hooks; }) });
  refused('#347 extra file', { entryDelta: variant347(d => { d.files['commands/forge.md'] = { ...d.files[ENTRY_347_FILES[0]] }; }) });
  refused('#347 omitted file', { entryDelta: variant347(d => { delete d.files[ENTRY_347_FILES[0]]; }) });
  refused('#347 extra rendered member', { artifacts: [...report.artifacts, { ...report.artifacts.find(item => item.source_id === 'agents'), source: 'agents/foreign.md' }] });
  refused('#347 omitted rendered member', { artifacts: report.artifacts.filter(item => item.source !== ENTRY_347_MEMBERS.agents[0]) });
  refused('#347 wrong file before', { entryDelta: variant347(d => { d.files[ENTRY_347_FILES[0]].before = wrong; }) });
  refused('#347 invented file after', { entryDelta: variant347(d => { d.files[ENTRY_347_FILES[0]].after = wrong; d.files[ENTRY_347_FILES[0]].attributed_after = wrong; }) });
  refused('#347 declared file edited', { readRaw: edited(ENTRY_347_FILES[0]) });
  refused('#347 undocumented current pin', { readme: readme.split(ENTRY_347.surfaces.agents.after).join('') });
  refused('#347 undocumented intermediate pin', { readme: readme.split(ENTRY_347.surfaces.agents.before).join('') });
  process.stdout.write('ok - issue-341-linked-task-layer-refuses-out-of-delta-edits-wrong-pins-and-undocumented-repins\n');

  // #348 is checked against the retained #347 end state, not a rewritten fixture.
  const variant348 = mutate => { const copy = JSON.parse(JSON.stringify(ARTIFACT_348)); mutate(copy); return copy; };
  const refused348 = (label, overrides) => assert.throws(() => assertLinkedPinsAndSources({ ...base, ...overrides }), error => error instanceof assert.AssertionError, '#348 ' + label + ' must be refused');
  const wrong348 = sha256('not a measured348 value');
  refused348('foreign before', { artifactDelta: variant348(d => { d.surfaces.agents.before = wrong348; d.surfaces.agents.attributed_before = wrong348; }) });
  refused348('invented after', { artifactDelta: variant348(d => { d.surfaces.agents.after = wrong348; d.surfaces.agents.attributed_after = wrong348; }) });
  refused348('extra surface', { artifactDelta: variant348(d => { d.surfaces.hooks = { ...d.surfaces.agents }; }) });
  refused348('omitted surface', { artifactDelta: variant348(d => { delete d.surfaces.agents; }) });
  refused348('extra file', { artifactDelta: variant348(d => { d.files['agents/forge-worker.md'] = { ...d.files['agents/forge-planner.md'] }; }) });
  refused348('omitted file', { artifactDelta: variant348(d => { delete d.files['agents/forge-planner.md']; }) });
  refused348('foreign file before', { artifactDelta: variant348(d => { d.files['agents/forge-planner.md'].before = wrong348; d.files['agents/forge-planner.md'].attributed_before = wrong348; }) });
  refused348('invented file after', { artifactDelta: variant348(d => { d.files['agents/forge-planner.md'].after = wrong348; d.files['agents/forge-planner.md'].attributed_after = wrong348; }) });
  refused348('extra untouched surface', { artifactDelta: variant348(d => { d.unchanged_surfaces.push('imaginary'); }) });
  const read348 = rel => fs.readFileSync(path.join(ROOT, rel));
  const edit348 = target => rel => rel === target ? Buffer.concat([read348(rel), Buffer.from('\nforeign348 edit\n')]) : read348(rel);
  refused348('planner edited after measure', { readRaw: edit348('agents/forge-planner.md') });
  refused348('edit outside measure', { readRaw: edit348('agents/forge-memory.md') });
  refused348('prior fixture rewritten', { readRaw: edit348('scripts/fixtures/entry-contracts/distribution-delta.json') });
  refused348('stale pin', { golden: { ...golden, surfaces: golden.surfaces.map(row => row.source_id === 'agents' ? { ...row, sha256: ARTIFACT_348.surfaces.agents.before } : row) } });
  refused348('stale docs', { readme: readme.split(ARTIFACT_348.surfaces.agents.after).join('') });


  // Strong terminal-layer negatives retain every historical negative above.
  const identityVariant = mutate => { const copy = JSON.parse(JSON.stringify(IDENTITY)); mutate(copy); return copy; };
  const refuseIdentity = (label, overrides) => assert.throws(() => assertLinkedPinsAndSources({ ...base, ...overrides }), e => e instanceof assert.AssertionError, 'identity ' + label + ' must be refused');
  const wrongIdentity = sha256('unmeasured identity value');
  const identityRead = rel => fs.readFileSync(path.join(ROOT, rel));
  const identityEdit = target => rel => rel === target ? Buffer.concat([identityRead(rel), Buffer.from('\nforeign identity edit\n')]) : identityRead(rel);
  for (const field of ['before','attributed_before','after','attributed_after']) {
    refuseIdentity('foreign surface ' + field, { identityDelta: identityVariant(d => { d.surfaces.skills[field] = wrongIdentity; }) });
    refuseIdentity('foreign file ' + field, { identityDelta: identityVariant(d => { d.files['skills/forge-task/SKILL.md'][field] = wrongIdentity; }) });
  }
  refuseIdentity('extra surface', { identityDelta: identityVariant(d => { d.surfaces.commands = { ...d.surfaces.skills }; }) });
  refuseIdentity('omitted surface', { identityDelta: identityVariant(d => { delete d.surfaces.skills; }) });
  refuseIdentity('extra file', { identityDelta: identityVariant(d => { d.files['commands/forge.md'] = { ...d.files['skills/forge-task/SKILL.md'] }; }) });
  refuseIdentity('omitted file', { identityDelta: identityVariant(d => { delete d.files['skills/forge-task/SKILL.md']; }) });
  refuseIdentity('extra retained span', { identityDelta: identityVariant(d => { d.retained_spans.foreign = { ...d.retained_spans.fresh_registration }; }) });
  refuseIdentity('omitted retained span', { identityDelta: identityVariant(d => { delete d.retained_spans.fresh_registration; }) });
  for (const field of ['before','after']) refuseIdentity('foreign retained span ' + field, { identityDelta: identityVariant(d => { d.retained_spans.fresh_registration[field].sha256 = wrongIdentity; }) });
  refuseIdentity('extra untouched surface', { identityDelta: identityVariant(d => { d.unchanged_surfaces.push('imaginary'); }) });
  refuseIdentity('extra rendered member', { artifacts: [...report.artifacts, { ...report.artifacts.find(a => a.source_id === 'skills'), source:'skills/foreign/SKILL.md' }] });
  refuseIdentity('omitted rendered member', { artifacts: report.artifacts.filter(a => a.source !== IDENTITY_MEMBERS.skills[0]) });
  for (const file of Object.keys(IDENTITY.files)) refuseIdentity('postmeasure ' + file, { readRaw: identityEdit(file) });
  refuseIdentity('outside measured sources', { readRaw: identityEdit('commands/forge.md') });
  for (const file of Object.keys(IDENTITY_PRIOR_DELTAS)) refuseIdentity('earlier fixture ' + file, { readRaw: identityEdit(file) });
  refuseIdentity('stale active pin', { golden: { ...golden, surfaces: golden.surfaces.map(row => row.source_id === 'hooks' ? { ...row, sha256: IDENTITY.surfaces.hooks.before } : row) } });
  for (const field of ['before','after']) refuseIdentity('undocumented pin ' + field, { readme: readme.split(IDENTITY.surfaces.hooks[field]).join('') });
  refuseIdentity('extra sample node', { identityDelta: identityVariant(d => { d.samples.nodes.push({ ...d.samples.nodes[0], pointer:'/foreign' }); }) });
  refuseIdentity('omitted sample node', { identityDelta: identityVariant(d => { d.samples.nodes.pop(); }) });
  refuseIdentity('foreign sample pointer', { identityDelta: identityVariant(d => { d.samples.nodes[0].pointer = '/entries/2/supporting/partial/after'; }) });
  refuseIdentity('foreign sample file', { identityDelta: identityVariant(d => { d.samples.nodes[0].file = 'skills/forge-next/SKILL.md'; }) });
  for (const field of ['before','after']) {
    refuseIdentity('wrong sample full ' + field, { identityDelta: identityVariant(d => { d.samples[field] = wrongIdentity; }) });
    refuseIdentity('wrong sample node ' + field, { identityDelta: identityVariant(d => { d.samples.nodes[0][field] = wrongIdentity; }) });
  }
  const identitySampleText = fs.readFileSync(path.join(ROOT, 'docs/communication-evaluation/samples.json'), 'utf8');
  const identitySampleDoc = fs.readFileSync(path.join(ROOT, 'docs/communication-evaluation/README.md'), 'utf8');
  const identityTampered = identitySampleText.replace('"entries"', '"entries" ');
  refuseIdentity('sample bytes coherently repinned', { identitySampleText: identityTampered, identityDelta: identityVariant(d => { d.samples.after = sha256(identityTampered); }) });
  const identityQuoteTampered = identitySampleText.replace('"text": "', '"text": "foreign ');
  refuseIdentity('quoted material coherently repinned', { identitySampleText: identityQuoteTampered, identityDelta: identityVariant(d => { d.samples.after = sha256(identityQuoteTampered); }) });
  refuseIdentity('stale sample citation', { identitySampleText: withSampleShas(identitySampleText, [[IDENTITY_SAMPLE_POINTERS[0], IDENTITY.files['skills/forge-task/SKILL.md'].before]]) });
  refuseIdentity('unrelated sample node edit', { identitySampleText: withSampleShas(identitySampleText, [['/entries/2/supporting/partial/after', wrongIdentity]]) });
  refuseIdentity('undocumented samples', { identitySampleReadme: identitySampleDoc.split(IDENTITY.files['skills/forge-task/SKILL.md'].after).join('') });

  process.stdout.write('ok - issue-347-linked-task-layer-chains-exact-members-and-refuses-tampering\n');
});

test('guard CLI returns parseable JSON and release-gate status', () => {
  const clean = spawnSync(process.execPath, [path.join(__dirname, 'forge-dispatch-source-guard.js'), ROOT], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(clean.status, 0, clean.stderr);
  assert.strictEqual(JSON.parse(clean.stdout).ok, true);

  withFixture((root) => {
    appendSeparated(root, 'shared/forge-review.md',
      'CLI_DRIFT=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type review-fix --host-runtime claude --json)');
    const drift = spawnSync(process.execPath, [path.join(__dirname, 'forge-dispatch-source-guard.js'), root], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.strictEqual(drift.status, 1, drift.stderr);
    const report = JSON.parse(drift.stdout);
    assert.strictEqual(report.ok, false);
    assert(report.unexpected.some((item) => item.kind === 'resolver'));
  });
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.stdout.write('Local source/render acceptance only: no network or real provider process was used.\n');
if (failed > 0) process.exitCode = 1;
