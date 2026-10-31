#!/usr/bin/env node
'use strict';

// Standalone, zero-dependency adversarial runner for the JSONC state machine.
const { parseJsonc, stripJsonc, readPrefs, readPrefsCached, validatePrefs, buildProvenance, loadSchema } = require('./forge-prefs.js');
const { legacyReadFile, legacyReadLayer } = require('./forge-prefs-legacy.js');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let passes = 0;
let failures = 0;

function pass(name) {
  passes++;
  process.stdout.write(`  ✓ ${name}\n`);
}

function fail(name, detail) {
  failures++;
  process.stderr.write(`  ✗ ${name}: ${detail}\n`);
}

function assert(condition, name, detail) {
  if (condition) pass(name);
  else fail(name, detail || 'assertion failed');
}

function deepEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertEquivalent(name, fixture, handCleaned) {
  const parsed = parseJsonc(fixture);
  let expected;
  try {
    expected = JSON.parse(handCleaned);
  } catch (error) {
    fail(name, `bad hand-cleaned fixture: ${error.message}`);
    return;
  }
  assert(parsed.ok, `${name} parses`, parsed.error && parsed.error.message);
  if (parsed.ok) assert(deepEqual(parsed.value, expected), `${name} equals hand-cleaned JSON`);
}

process.stdout.write('\nJSONC tokenizer adversarial suite\n');

const validFixtures = [
  {
    name: 'URL with double slash inside a string',
    text: '{"url": "https://x//y"}',
    clean: '{"url": "https://x//y"}',
  },
  {
    name: 'Windows path with escaped backslash before closing quote',
    text: '{"p": "C:\\\\path\\\\"}',
    clean: '{"p": "C:\\\\path\\\\"}',
  },
  {
    name: 'comment markers inside quoted strings',
    text: '{"s": "tem // dentro", "t": "e /* isto */ tb"}',
    clean: '{"s": "tem // dentro", "t": "e /* isto */ tb"}',
  },
  {
    name: 'BOM at byte zero',
    text: '\uFEFF{\n  // ignored\n  "ok": true\n}',
    clean: '{\n  \n  "ok": true\n}',
  },
  {
    name: 'CRLF comments retain valid structure',
    text: '{\r\n  // line comment\r\n  "a": 1, /* inline */\r\n  "b": 2\r\n}',
    clean: '{\r\n  \r\n  "a": 1, \r\n  "b": 2\r\n}',
  },
  {
    name: 'emoji keys and values',
    text: '{\n  "😀": "café 🚀", // unicode follows a comment\n  "ok": true\n}',
    clean: '{\n  "😀": "café 🚀", \n  "ok": true\n}',
  },
  {
    name: 'object and array trailing commas',
    text: '{ "object": { "x": 1, }, "array": [1, 2,], }',
    clean: '{ "object": { "x": 1  }, "array": [1, 2 ]  }',
  },
  {
    name: 'last-line comment without final newline',
    text: '{ "ok": true } // final comment',
    clean: '{ "ok": true }                 ',
  },
  {
    name: 'block comment spanning lines',
    text: '{\n/* one\n   two */\n"x": 1\n}',
    clean: '{\n      \n         \n"x": 1\n}',
  },
  {
    name: 'block comment opener inside a string',
    text: '{"literal": "/* not a comment */", "n": 3}',
    clean: '{"literal": "/* not a comment */", "n": 3}',
  },
  {
    name: 'escaped quote and backslash before quote survive',
    text: '{"quote": "say \\\"hi\\\"", "slashes": "\\\\\\\\\\\""}',
    clean: '{"quote": "say \\\"hi\\\"", "slashes": "\\\\\\\\\\\""}',
  },
];

for (const fixture of validFixtures) assertEquivalent(fixture.name, fixture.text, fixture.clean);

const empty = parseJsonc('');
assert(empty.ok && deepEqual(empty.value, {}), 'empty file becomes empty object');

const commentsOnly = parseJsonc(' \n // only a line\n /* only a block */ \n');
assert(commentsOnly.ok && deepEqual(commentsOnly.value, {}), 'comments-only file becomes empty object');

const sourceForShape = '{\n  "first": 1, // retain offset\n  "second":,\n}';
const strippedForShape = stripJsonc(sourceForShape);
assert(strippedForShape.length === sourceForShape.length, 'strip is byte-length preserving');
assert(
  [...strippedForShape].filter((character) => character === '\n').length ===
    [...sourceForShape].filter((character) => character === '\n').length,
  'strip keeps every newline',
);
const malformed = parseJsonc(sourceForShape);
assert(!malformed.ok && (malformed.error.line === 3 || malformed.error.line === null),
  'JSON parse error uses the original offset when V8 exposes one', JSON.stringify(malformed.error));

const missingBrace = parseJsonc('{\n  "nested": {\n    "x": true\n  }\n');
assert(!missingBrace.ok && typeof missingBrace.error.line === 'number' && missingBrace.error.line >= 1,
  'missing closing brace reports a numeric original line', JSON.stringify(missingBrace.error));

const unterminatedString = parseJsonc('{\n  "x": "unfinished\n}');
assert(!unterminatedString.ok && typeof unterminatedString.error.line === 'number',
  'unterminated string is rejected', JSON.stringify(unterminatedString.error));

const unterminatedBlock = parseJsonc('{\n  /* unfinished\n  "x": 1\n}');
assert(!unterminatedBlock.ok && typeof unterminatedBlock.error.line === 'number',
  'unterminated block comment is rejected', JSON.stringify(unterminatedBlock.error));

const LF = '{\n  // alpha\n  "items": [1, 2,],\n}';
const CRLF = LF.replace(/\n/g, '\r\n');
const bomCrLf = '\uFEFF' + CRLF;
const lfResult = parseJsonc(LF);
const crlfResult = parseJsonc(CRLF);
const bomCrLfResult = parseJsonc(bomCrLf);
assert(lfResult.ok && crlfResult.ok && bomCrLfResult.ok, 'LF, CRLF, and BOM+CRLF variants parse');
assert(deepEqual(lfResult.value, crlfResult.value) && deepEqual(lfResult.value, bomCrLfResult.value),
  'LF, CRLF, and BOM twins produce identical values');

// ── legacyRead() consolidated markdown reader ─────────────────────────────
process.stdout.write('\nlegacyRead markdown suite\n');
const fixtureDir = fs.mkdtempSync(path.join(__dirname, '.forge-prefs-test-'));
const fixturePath = path.join(fixtureDir, 'prefs.md');
const fixture = [
  'review:',
  '  rounds: 2',
  '  style: dialectic',
  'tier_models:',
  '  standard: claude-sonnet-5 # scalar comment',
  '  heavy: [claude-opus-4-8, "claude-sonnet-5"] # list comment',
  'routing:',
  '  backend:',
  '    executor:',
  '      standard: [claude-sonnet-5, gpt-5]',
  '      fallback: claude-sonnet-5',
  '    planner:',
  '      heavy: [claude-opus-4-8]',
  '  default:',
  '    executor:',
  '      standard: [claude-haiku-4-5-20251001]',
].join('\n') + '\n';
fs.writeFileSync(fixturePath, fixture);
const parsedFixture = legacyReadFile(fixturePath);
assert(parsedFixture.ok && parsedFixture.prefs.review.rounds === 2 &&
  parsedFixture.prefs.review.style === 'dialectic', 'legacy generic block extracts typed values');
assert(parsedFixture.prefs.tier_models.standard === 'claude-sonnet-5',
  'legacy tier_models scalar extracts as a string');
assert(deepEqual(parsedFixture.prefs.tier_models.heavy,
  ['claude-opus-4-8', 'claude-sonnet-5']),
  'legacy tier_models inline list matches parseTierValue behavior');
assert(deepEqual(parsedFixture.prefs.routing.backend.executor.standard,
  ['claude-sonnet-5', 'gpt-5']) &&
  parsedFixture.prefs.routing.backend.executor.fallback === 'claude-sonnet-5',
  'legacy routing block extracts domain, phase, tiers, and fallback');

const routingDir = path.join(fixtureDir, '.gsd');
fs.mkdirSync(routingDir);
fs.writeFileSync(path.join(routingDir, 'claude-agent-prefs.md'), fixture);
const originalHome = process.env.HOME;
const isolatedHome = path.join(fixtureDir, 'empty-home');
fs.mkdirSync(isolatedHome);
process.env.HOME = isolatedHome;
const routingIdentity = legacyReadLayer([path.join(routingDir, 'claude-agent-prefs.md')]);
process.env.HOME = originalHome;
assert(routingIdentity.ok && deepEqual(parsedFixture.prefs.routing, routingIdentity.prefs.routing),
  'legacy routing output is identical to the standalone legacy layer reader');

// ── R2 fix locks — bare scalar wraps, fallback:[a,b] takes list[0] ─────────
const bareScalarDir = fs.mkdtempSync(path.join(__dirname, '.forge-prefs-test-'));
fs.mkdirSync(path.join(bareScalarDir, '.gsd'), { recursive: true });
const bareScalarPath = path.join(bareScalarDir, '.gsd', 'claude-agent-prefs.md');
fs.writeFileSync(bareScalarPath,
  'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n');
const bareScalarResult = legacyReadFile(bareScalarPath);
assert(deepEqual(bareScalarResult.prefs.routing, { backend: { executor: { standard: ['claude-sonnet-5'] } } }),
  'R2: bare-scalar tier value wraps into a single-element array (parseValue identity)');
{
  const previousHome = process.env.HOME;
  process.env.HOME = isolatedHome;
  const expectedBareScalar = legacyReadLayer([bareScalarPath]);
  process.env.HOME = previousHome;
  assert(expectedBareScalar.ok && deepEqual(expectedBareScalar.prefs.routing, bareScalarResult.prefs.routing),
    'R2: bare-scalar identity matches legacyReadLayer');
}
fs.rmSync(bareScalarDir, { recursive: true, force: true });

const fallbackListPath = path.join(fixtureDir, 'fallback-list.md');
fs.writeFileSync(fallbackListPath,
  'routing:\n  backend:\n    executor:\n      standard: [a]\n      fallback: [alpha, beta]\n');
const fallbackListResult = legacyReadFile(fallbackListPath);
assert(fallbackListResult.prefs.routing.backend.executor.fallback === 'alpha',
  'R2: fallback: [a, b] takes list[0], matching parseValue + readRoutingConfig');

const eofPath = path.join(fixtureDir, 'eof.md');
fs.writeFileSync(eofPath, 'review:\n  rounds: 7');
const eofResult = legacyReadFile(eofPath);
assert(eofResult.prefs.review && eofResult.prefs.review.rounds === 7,
  'legacy section at EOF without trailing newline is captured');

const homePrefs = path.join(fixtureDir, 'claude-agent-prefs.md');
const localPrefs = path.join(fixtureDir, 'prefs.local.md');
fs.writeFileSync(homePrefs, 'review:\n  rounds: 1\n  style: formal\n');
fs.writeFileSync(localPrefs, 'review:\n  rounds: 3\n');
const layerResult = legacyReadLayer([homePrefs, localPrefs]);
assert(layerResult.ok && layerResult.prefs.review.rounds === 3 &&
  layerResult.prefs.review.style === 'formal',
  'legacy layer merge is in-order last-wins by key');
fs.writeFileSync(localPrefs, 'routing:\n  backend:\n    executor:\n      standard: [gpt-5]\n');
const routingLayer = legacyReadLayer([homePrefs, localPrefs]);
assert(deepEqual(routingLayer.prefs.routing.backend,
  { executor: { standard: ['gpt-5'] } }),
  'legacy routing layer merge replaces a domain as a whole');

const missingResult = legacyReadFile(path.join(fixtureDir, 'missing.md'));
assert(missingResult.ok && deepEqual(missingResult.prefs, {}),
  'legacy missing files silently produce an empty preference object');

// ── R1 fix lock — malformed routing block is cascade-wide and surfaced ────
const malformedPath = path.join(fixtureDir, 'malformed.md');
fs.writeFileSync(malformedPath, 'routing:\n  backend:\n      executor:\n    standard: [x]\n');
const malformedFileResult = legacyReadFile(malformedPath);
assert(malformedFileResult.routingMalformed === true && !malformedFileResult.prefs.routing,
  'R1: a single malformed file reports routingMalformed and drops its own routing');
const okRoutingPath = path.join(fixtureDir, 'ok-routing.md');
fs.writeFileSync(okRoutingPath, 'routing:\n  default:\n    executor:\n      standard: [y]\n');
const malformedLayer = legacyReadLayer([okRoutingPath, malformedPath]);
assert(malformedLayer.routingMalformed === true && malformedLayer.malformedFile === malformedPath,
  'R1: legacyReadLayer signals malformed cascade-wide with the offending file');

// ── readPrefs two-layer resolver ──────────────────────────────────────────
process.stdout.write('\nreadPrefs resolver suite\n');

let scenarioNumber = 0;
function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withPrefsScenario(name, build, verify) {
  scenarioNumber++;
  const root = path.join(fixtureDir, `scenario-${scenarioNumber}`);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const claude = path.join(home, '.claude');
  const gsd = path.join(project, '.gsd');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(gsd, { recursive: true });
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    build({ home, project, claude, gsd });
    verify(readPrefs(project), { home, project, claude, gsd });
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  } finally {
    restoreEnv('HOME', previousHome);
    restoreEnv('USERPROFILE', previousUserProfile);
  }
}

function write(file, text) {
  fs.writeFileSync(file, text);
}

const layerStates = [
  ['jsonc-only', 'jsonc', false],
  ['md-only', 'md-blocked', true],
  ['md+jsonc', 'jsonc', false],
  ['absent', 'absent', false],
];

for (const [state, source, blocked] of layerStates) {
  withPrefsScenario(`hard-stop layer matrix: ${state}`, ({ claude, gsd }) => {
    if (state === 'jsonc-only' || state === 'md+jsonc') {
      write(path.join(claude, 'forge-agent-prefs.jsonc'), '{"review":{"source":"global-jsonc"}}');
      write(path.join(gsd, 'forge-prefs.jsonc'), '{"review":{"source":"local-jsonc"}}');
    }
    if (state === 'md-only' || state === 'md+jsonc') {
      write(path.join(claude, 'forge-agent-prefs.md'), 'review:\n  source: global-md\n');
      write(path.join(gsd, 'claude-agent-prefs.md'), 'review:\n  source: local-md\n');
      write(path.join(gsd, 'prefs.local.md'), 'review:\n  source: local-personal-md\n');
    }
  }, (result, { claude, gsd }) => {
    assert(result.ok === !blocked, `${state}: resolver ok state follows hard-stop contract`);
    assert(result.layers.global.source === source && result.layers.local.source === source,
      `${state}: both layers expose canonical source`);
    if (blocked) {
      const names = [path.join(claude, 'forge-agent-prefs.md'), path.join(gsd, 'claude-agent-prefs.md'), path.join(gsd, 'prefs.local.md')];
      assert(result.errors.length === 2 && result.errors.every((error) => error.code === 'legacy-md-without-jsonc') &&
        names.every((name) => result.errors.some((error) => error.message.includes(name))) &&
        result.errors.every((error) => error.message.includes('forge-prefs-migrate.js" --cwd "')),
      'md-only: errors name every legacy file and migration command');
    } else if (state === 'md+jsonc') {
      assert(result.errors.length === 0 && result.prefs.review.source === 'local-jsonc',
        'md+jsonc: JSONC shadows Markdown silently');
    }
  });
}

withPrefsScenario('local values deep-merge over global values', ({ claude, gsd }) => {
  write(path.join(claude, 'forge-agent-prefs.jsonc'),
    '{"review":{"rounds":1,"style":"global"},"tier_models":{"standard":"a"}}');
  write(path.join(gsd, 'forge-prefs.jsonc'),
    '{"review":{"rounds":2},"tier_models":{"heavy":"b"}}');
}, (result) => {
  assert(result.prefs.review.rounds === 2 && result.prefs.review.style === 'global',
    'deep merge gives local scalar precedence and retains unrelated global keys');
  assert(result.prefs.tier_models.standard === 'a' && result.prefs.tier_models.heavy === 'b',
    'deep merge combines independent nested keys');
});

withPrefsScenario('arrays replace rather than concatenate', ({ claude, gsd }) => {
  write(path.join(claude, 'forge-agent-prefs.jsonc'),
    '{"file_audit":{"ignore_list":["one","two"]}}');
  write(path.join(gsd, 'forge-prefs.jsonc'),
    '{"file_audit":{"ignore_list":["local"]}}');
}, (result) => {
  assert(deepEqual(result.prefs.file_audit.ignore_list, ['local']),
    'local array replaces the global array verbatim');
});

withPrefsScenario('explicit local null overrides global value', ({ claude, gsd }) => {
  write(path.join(claude, 'forge-agent-prefs.jsonc'), '{"review":{"rounds":4}}');
  write(path.join(gsd, 'forge-prefs.jsonc'), '{"review":{"rounds":null}}');
}, (result) => {
  assert(result.prefs.review.rounds === null, 'null is a value and does not delete or inherit');
});

withPrefsScenario('routing domains replace atomically', ({ claude, gsd }) => {
  write(path.join(claude, 'forge-agent-prefs.jsonc'),
    '{"routing":{"backend":{"plan":{"standard":["a"]},"execute":{"standard":["b"]}},"default":{"plan":{"standard":["c"]}}}}');
  write(path.join(gsd, 'forge-prefs.jsonc'),
    '{"routing":{"backend":{"plan":{"standard":["local"]}}}}');
}, (result) => {
  assert(deepEqual(result.prefs.routing.backend, { plan: { standard: ['local'] } }),
    'new routing domain replaces all old phases in that domain');
  assert(deepEqual(result.prefs.routing.default, { plan: { standard: ['c'] } }),
    'routing domains not locally supplied remain global');
});

withPrefsScenario('broken JSONC reports an error and does not fall back to Markdown', ({ claude, gsd }) => {
  write(path.join(claude, 'forge-agent-prefs.jsonc'), '{"review":{"rounds":5}}');
  write(path.join(gsd, 'forge-prefs.jsonc'), '{\n  "review": {"rounds": 9}\n');
  write(path.join(gsd, 'claude-agent-prefs.md'), 'review:\n  rounds: 99\n');
}, (result) => {
  assert(!result.ok && result.errors.length === 1, 'broken JSONC makes resolution not ok');
  assert(result.errors[0].file.endsWith('forge-prefs.jsonc') &&
    typeof result.errors[0].line === 'number', 'parse error carries file and numeric source line');
  assert(result.prefs.review.rounds === 5, 'global data survives while broken local layer contributes nothing');
  assert(result.layers.local.source === 'jsonc', 'broken JSONC still shadows local Markdown');
});

withPrefsScenario('JSONC routing identity matches forge-routing', ({ claude, gsd }) => {
  write(path.join(claude, 'forge-agent-prefs.jsonc'),
    '{"routing":{"backend":{"executor":{"standard":["global"]}}}}');
  write(path.join(gsd, 'forge-prefs.jsonc'),
    '{"routing":{"backend":{"executor":{"standard":["local"]}}}}');
}, (actual, { project }) => {
  const expected = require('./forge-routing.js').readRoutingConfig(project);
  assert(expected.ok && deepEqual(actual.prefs.routing, expected.routing),
    'JSONC routing is identical to readRoutingConfig');
  assert(actual.layers.global.source === 'jsonc' && actual.layers.local.source === 'jsonc',
    'routing identity scenario reads JSONC from both layers');
});

withPrefsScenario('R3: provenance never reports a leaf absent from the atomically-merged routing domain', ({ claude, gsd }) => {
  write(path.join(claude, 'forge-agent-prefs.jsonc'),
    '{"routing":{"backend":{"executor":{"standard":["global-exec"]},"planner":{"heavy":["global-plan"]}}}}');
  write(path.join(gsd, 'forge-prefs.jsonc'),
    '{"routing":{"backend":{"executor":{"standard":["local-exec"]}}}}');
}, (result, { project, claude: claudeDir, gsd: gsdDir }) => {
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-prefs.js'), '--resolved', '--explain', '--cwd', project], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { HOME: path.dirname(claudeDir), USERPROFILE: path.dirname(claudeDir) }),
    encoding: 'utf8',
  });
  const cliJson = JSON.parse(cli.stdout);
  assert(deepEqual(result.prefs.routing.backend, { executor: { standard: ['local-exec'] } }),
    'R3 setup: local routing.backend atomically replaces the whole domain');
  assert(!Object.prototype.hasOwnProperty.call(cliJson.provenance, 'routing.backend.planner.heavy'),
    'R3: no provenance entry for a leaf absent from the merged result (phantom global-only planner leaf)');
  assert(cliJson.provenance['routing.backend.executor.standard'] === 'local',
    'R3: the surviving merged leaf is correctly attributed to local');
});

// ── T04 advisory validator suite ──────────────────────────────────────────
process.stdout.write('\nadvisory schema validator suite\n');
const syntheticSchema = {
  properties: {
    review: {
      properties: {
        rounds: { type: 'number' },
        style: { enum: ['dialectic', 'flags'] },
      },
    },
  },
};
const invalidPrefs = { review: { rounds: 'many', style: 'formal', typo: true } };
const validatorWarnings = validatePrefs(invalidPrefs, syntheticSchema);
assert(validatorWarnings.some((warning) => warning.key === 'review.rounds' && /expected number/.test(warning.message)),
  'validator warns on schema type mismatch');
assert(validatorWarnings.some((warning) => warning.key === 'review.style' && /dialectic/.test(warning.message)),
  'validator warns on enum mismatch');
assert(validatorWarnings.some((warning) => warning.key === 'review.typo' && /unknown/.test(warning.message)),
  'validator warns on unknown nested key');
assert(deepEqual(validatePrefs({ review: { rounds: 2, style: 'flags' } }, syntheticSchema), []),
  'validator clean schema-shaped values produce no warnings');
assert(deepEqual(validatePrefs({ review: { rounds: 2 } }, null), []),
  'validator absent schema produces no warnings');
assert(deepEqual(invalidPrefs, { review: { rounds: 'many', style: 'formal', typo: true } }),
  'validator never mutates the resolved object');
assert(deepEqual(buildProvenance({ review: { rounds: 1, style: 'flags' } }, { review: { rounds: 2 } }),
  { 'review.rounds': 'local', 'review.style': 'global' }),
  'provenance is leaf-level and local wins');

// ── T04 CLI contract suite ────────────────────────────────────────────────
process.stdout.write('\nresolved CLI suite\n');
const cliRoot = path.join(fixtureDir, 'cli-contract');
const cliHome = path.join(cliRoot, 'home');
const cliRepo = path.join(cliRoot, 'repo');
fs.mkdirSync(path.join(cliHome, '.claude'), { recursive: true });
fs.mkdirSync(path.join(cliRepo, '.gsd'), { recursive: true });
function runPrefsCli(args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'forge-prefs.js'), ...args], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { HOME: cliHome, USERPROFILE: cliHome }),
    encoding: 'utf8',
  });
}
write(path.join(cliHome, '.claude', 'forge-agent-prefs.jsonc'), '{"review":{"rounds":2,"style":"flags"},"tier_models":{"standard":"global-model"}}');
write(path.join(cliRepo, '.gsd', 'forge-prefs.jsonc'), '{\n  "review": {"rounds": 5},\n  "unknown": true\n}');
let cli = runPrefsCli(['--resolved', '--cwd', cliRepo]);
let cliJson;
try { cliJson = JSON.parse(cli.stdout); } catch (error) { cliJson = null; }
assert(cli.status === 0 && cliJson && cliJson.ok === true && cliJson.prefs &&
  Array.isArray(cliJson.errors) && Array.isArray(cliJson.warnings) && cliJson.layers,
  'CLI emits fixed resolved JSON shape with advisory warning');
cli = runPrefsCli(['--resolved', '--key', 'review.rounds', '--cwd', cliRepo]);
cliJson = JSON.parse(cli.stdout);
assert(cli.status === 0 && cliJson.value === 5 && !Object.prototype.hasOwnProperty.call(cliJson, 'prefs'),
  'CLI --key returns the local-overridden ROADMAP value');
cli = runPrefsCli(['--resolved', '--explain', '--cwd', cliRepo]);
cliJson = JSON.parse(cli.stdout);
assert(cli.status === 0 && cliJson.provenance['review.rounds'] === 'local' &&
  cliJson.provenance['review.style'] === 'global',
  'CLI --explain reports local and global leaf provenance');
write(path.join(cliRepo, '.gsd', 'forge-prefs.jsonc'), '{\n  "review": {"rounds": 5,\n}');
cli = runPrefsCli(['--resolved', '--cwd', cliRepo]);
cliJson = JSON.parse(cli.stdout);
assert(cli.status === 1 && cliJson.errors.length > 0 && cliJson.errors[0].file.endsWith('forge-prefs.jsonc') && cli.stderr.length > 0,
  'broken JSONC exits 1 while retaining errors JSON and human stderr');
write(path.join(cliRepo, '.gsd', 'forge-prefs.jsonc'), '{"review":{"rounds": "not-a-number"}}');
cli = runPrefsCli(['--resolved', '--cwd', cliRepo]);
cliJson = JSON.parse(cli.stdout);
// S02/T01: forge-prefs.schema.json now ships at the repo root, so loadSchema()
// returns non-null and the CLI validates. The contract under test is unchanged:
// validation stays ADVISORY — warnings surface, exit code stays 0.
assert(cli.status === 0 && cliJson.warnings.some((warning) => warning.key === 'review.rounds'),
  'schema-present CLI remains advisory: warns on bad type, still exits 0');
cli = runPrefsCli(['--resolved', '--key', 'review.does_not_exist', '--cwd', cliRepo]);
cliJson = JSON.parse(cli.stdout);
assert(cli.status === 0 && cliJson.value === null && cliJson.warnings.some((warning) => warning.key === 'review.does_not_exist'),
  'CLI missing dotted key returns null with an advisory note');
cli = runPrefsCli(['--cwd', cliRepo]);
cliJson = JSON.parse(cli.stdout);
assert(cli.status === 1 && cliJson.ok === false && cliJson.errors[0].message === '--resolved is required',
  'CLI requires the --resolved action');
assert(Array.isArray(validatePrefs({ review: { rounds: 2 } }, {
  properties: { review: { properties: {}, additionalProperties: true } },
})), 'validator honors additionalProperties true');
assert(deepEqual(validatePrefs({ review: { rounds: 2 } }, {
  properties: { review: { properties: { rounds: { type: 'integer' } } } },
}), []), 'validator supports integer schema types');
assert(validatePrefs({ review: { rounds: 2.5 } }, {
  properties: { review: { properties: { rounds: { type: 'integer' } } } },
}).length === 1, 'validator rejects non-integer values for integer schema types');
assert(validatePrefs({ extra: true }, { properties: {} }).some((warning) => warning.key === 'extra'),
  'validator checks unknown keys at every properties-defined level');
assert(deepEqual(validatePrefs({ mode: 'safe' }, { properties: { mode: { enum: ['safe'] } } }), []),
  'validator accepts an enum member without coercion');
assert(validatePrefs({ mode: 1 }, { properties: { mode: { enum: ['safe'] } } }).length === 1,
  'validator compares enum values by JSON value and warns on wrong type');
assert(deepEqual(validatePrefs({ open: true }, { properties: { open: { type: 'boolean' } } }), []),
  'validator supports boolean schema values');
assert(validatePrefs({ open: 'yes' }, { properties: { open: { type: 'boolean' } } }).length === 1,
  'validator warns when a boolean receives a string');
assert(deepEqual(buildProvenance({}, {}), {}),
  'provenance stays empty for empty layers');

// ── readPrefsCached memo contract ─────────────────────────────────────────
const cacheRoot = path.join(fixtureDir, 'cached');
const cacheHome = path.join(cacheRoot, 'home');
const cacheRepoA = path.join(cacheRoot, 'repo-a');
const cacheRepoB = path.join(cacheRoot, 'repo-b');
fs.mkdirSync(path.join(cacheHome, '.claude'), { recursive: true });
fs.mkdirSync(path.join(cacheRepoA, '.gsd'), { recursive: true });
fs.mkdirSync(path.join(cacheRepoB, '.gsd'), { recursive: true });
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;
process.env.HOME = cacheHome;
process.env.USERPROFILE = cacheHome;
try {
  write(path.join(cacheRepoA, '.gsd', 'forge-prefs.jsonc'), '{"review":{"source":"first"}}');
  const first = readPrefsCached(cacheRepoA);
  const second = readPrefsCached(cacheRepoA);
  assert(first === second && second.prefs.review.source === 'first', 'readPrefsCached hit reuses the in-memory result');
  write(path.join(cacheRepoA, '.gsd', 'forge-prefs.jsonc'), '{"review":{"source":"touched"}}');
  assert(readPrefsCached(cacheRepoA).prefs.review.source === 'touched', 'readPrefsCached invalidates when a layer changes');
  write(path.join(cacheRepoB, '.gsd', 'forge-prefs.jsonc'), '{"review":{"source":"other-cwd"}}');
  assert(readPrefsCached(cacheRepoB).prefs.review.source === 'other-cwd', 'readPrefsCached keys entries by cwd');
  const before = fs.readdirSync(path.join(cacheRepoA, '.gsd')).sort();
  readPrefsCached(cacheRepoA);
  assert(deepEqual(fs.readdirSync(path.join(cacheRepoA, '.gsd')).sort(), before), 'readPrefsCached writes no cache file (MEM001)');
} finally {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
}

for (const routing of [
  { tier_models: { light: ['claude-haiku-5-5'] } },
  { custom: { executor: { light: 'gpt-6-luna' } } },
  { custom: { executor: { light: [''] } } },
  { custom: { executor: { light: [17] } } },
  { custom: { planner: { standard: [], fallback: [] } } },
  { custom: null },
  { custom: { executor: [] } },
  { custom: { planner: { tier_models: ['gpt-6-luna'] } } },
]) assert(validatePrefs({ routing }, loadSchema()).some(w => w.key.startsWith('routing.')),
  'issue277 malformed domain phase tier or fallback produces a routing diagnostic');
assert(deepEqual(validatePrefs({ routing: {
  tier_models: { executor: { light: ['gpt-6-luna'], fallback: null } },
  arbitrary_domain: { planner: { heavy: [], fallback: 'claude-opus-5-5' } },
  empty_domain: {},
} }, loadSchema()), []), 'issue277 arbitrary domain names and valid phase tier fallback shapes remain accepted');

fs.rmSync(fixtureDir, { recursive: true, force: true });
process.stdout.write(`\n${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
