#!/usr/bin/env node
'use strict';

// Standalone acceptance suite: only Node built-ins and production modules.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const guard = require('./forge-dispatch-source-guard.js');
const codexRenderer = require('./forge-codex-renderer.js');
const claudeRenderer = require('./forge-claude-renderer.js');
const dispatchResolver = require('./forge-dispatch-resolve.js');

const ROOT = path.resolve(__dirname, '..');
const RESOLVER_SCRIPT = path.join(__dirname, 'forge-dispatch-resolve.js');
const MANIFEST_PATH = path.join(ROOT, 'forge-source-manifest.json');
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'claude-renderer', 'claude-4.19.0.golden.json');
const PRE_REPIN_SKILLS_SHA = '1690b19b495bc6ecc2e227acd2b6f5b71a242dbf55d04085560eff987b674a79';

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
  const fixtureParent = path.resolve(ROOT, 'scripts');
  const root = fs.mkdtempSync(path.join(fixtureParent, '.forge-dispatch-source-guard-'));
  assert(root.startsWith(`${fixtureParent}${path.sep}`), `unsafe fixture root: ${root}`);
  for (const relative of guard.SCOPED_FILES) write(relative, read(relative), root);
  return root;
}

function removeFixture(root) {
  const fixtureParent = path.resolve(ROOT, 'scripts');
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

test('registry and every nested entry are deeply frozen with explicit exclusions', () => {
  assert(Object.isFrozen(guard.SOURCE_REGISTRY));
  assert(guard.SOURCE_REGISTRY.length > 0);
  for (const entry of guard.SOURCE_REGISTRY) {
    assert(Object.isFrozen(entry), `${entry.id} is mutable`);
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert(guard.SCOPED_FILES.includes(entry.path), entry.path);
    assert(['resolver', 'agent', 'adapter', 'emitter'].includes(entry.kind), entry.kind);
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
  assert.deepStrictEqual([...discoveredKinds].sort(), ['adapter', 'agent', 'emitter', 'resolver']);
});

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
    candidate.kind === 'emitter' && candidate.evidence.includes('events.jsonl') && !candidate.evidence.includes('worker_mode')
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

test('real runtime refusal, enforcement escape, and codex-native advisory remain distinct', () => withFixture((fixture) => {
  const refused = runPosture('codex', 'claude', fixture);
  assert.strictEqual(refused.dispatch_decision, 'refuse');
  assert.strictEqual(refused.dispatch_allowed, false);
  assert.strictEqual(refused.dispatch_reason_code, 'codex-claude-unroutable');
  assert.match(refused.dispatch_hint, /worker Codex roteável/);
  assert.match(refused.dispatch_hint, /host Claude/);

  const escaped = runPosture('codex', 'claude', fixture, cleanRuntimeEnvironment({ FORGE_RUNTIME_ENFORCE: '0' }));
  assert.strictEqual(escaped.dispatch_decision, 'advisory');
  assert.strictEqual(escaped.dispatch_allowed, true);
  assert.strictEqual(escaped.dispatch_posture, 'enforce');

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
  }, 'codex'), {});
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
  }, 'codex'), {});
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
  for (const entry of emitters) {
    const candidate = realByIdentity.get(guard.identity(entry));
    assert(candidate, entry.id);
    const event = materializeEmitter(candidate);
    assert.strictEqual(event.event, 'dispatch', entry.id);
    assert.strictEqual(typeof event.host_runtime, 'string', entry.id);
    assert.strictEqual(typeof event.worker_mode, 'string', entry.id);
    assert.strictEqual(typeof event.dispatch_allowed, 'boolean', entry.id);
  }
});

test('Claude golden drift before the repin is exactly skills and current report is fully pinned', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
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

  const beforeRepin = new Map(golden.surfaces.map((surface) => [
    surface.source_id,
    surface.source_id === 'skills' ? PRE_REPIN_SKILLS_SHA : surface.sha256,
  ]));
  const measuredDrift = golden.surfaces
    .filter((surface) => measured.get(surface.source_id) !== beforeRepin.get(surface.source_id))
    .map((surface) => surface.source_id);
  assert.deepStrictEqual(measuredDrift, ['skills']);
  assert.notStrictEqual(golden.surfaces.find((surface) => surface.source_id === 'skills').sha256, PRE_REPIN_SKILLS_SHA);
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
