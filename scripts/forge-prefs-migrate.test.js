#!/usr/bin/env node
'use strict';

// Zero-dependency test suite for the md→jsonc prefs migration engine.
// Real-shaped markdown fixtures live in temp dirs; the engine's dir overrides
// ({globalDir, localDir}) keep every scenario away from the operator's real
// ~/.claude. CLI e2e paths use the matching --global-dir/--local-dir flags.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  resolvedDiff,
  activateValues,
  migrateAll,
  ensureGitignore,
  setPreference,
  setCatalogValue,
  resolveCurrent,
} = require('./forge-prefs-migrate.js');
const { parseJsonc, loadSchema, deepMerge } = require('./forge-prefs.js');
const { legacyReadLayer } = require('./forge-prefs-legacy.js');
const { generateScaffold } = require('./forge-prefs-scaffold.js');

let passes = 0;
let failures = 0;

function assert(condition, name, detail) {
  if (condition) {
    passes++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures++;
    process.stderr.write(`  ✗ ${name}: ${detail || 'assertion failed'}\n`);
  }
}

function deepEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

// Form A-funnel (S03/T05): every assert below that compares a file's text against
// an LF literal declared in this file normalizes at the read that owns the text.
// Without it the comparison is an EOL guard by accident: on a CRLF checkout (or
// under the EOL differential's CRLF arm) `===` against an LF literal fails for a
// file whose CONTENT is correct. The five asserts this closes were confirmed
// flipping by the S01 oracle and are the last EOL residue in this suite.
function readNormalized(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

// ── Fixtures — real-shaped legacy markdown ──────────────────────────────────

const GLOBAL_MD = `# Forge Agent Preferences

Configure how the forge loops behave.

## Tier Settings

tier_models:
  heavy: "claude-opus-4-8"
  max: claude-fable-5

## Effort Settings

effort:
  plan-milestone: max
  execute-task: low

## Git Settings

auto_commit: true
main_branch: main

## Routing

routing:
  backend:
    executor:
      standard: [gpt-6-luna, claude-sonnet-5-5]
      fallback: gpt-6-luna

## Review Settings

review:
  mode: enabled
  rounds: 1
`;

const REPO_MD = `# Repo shared prefs

review:
  rounds: 2

skip_discuss: false
`;

const LOCAL_MD = `# Local personal prefs

review:
  rounds: 3

auto_push: false
`;

const MALFORMED_MD = `# Broken prefs (flattened indentation class, 2026-07-16)

routing:
  backend: oops-value-on-domain-line
`;

function makeFixture(opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prefs-migrate-'));
  const globalDir = path.join(root, 'claude');
  const cwd = path.join(root, 'project');
  const localDir = path.join(cwd, '.gsd');
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(localDir, { recursive: true });
  const options = opts || {};
  if (options.globalMd !== null) fs.writeFileSync(path.join(globalDir, 'forge-agent-prefs.md'), options.globalMd || GLOBAL_MD);
  if (options.repoMd !== undefined) fs.writeFileSync(path.join(localDir, 'claude-agent-prefs.md'), options.repoMd);
  if (options.localMd !== undefined) fs.writeFileSync(path.join(localDir, 'prefs.local.md'), options.localMd);
  return { root, globalDir, cwd, localDir };
}

function listAllFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}

// ── resolvedDiff (the pure gate) ────────────────────────────────────────────

process.stdout.write('\nresolvedDiff — the pure gate\n');
assert(deepEqual(resolvedDiff({}, {}), []), 'empty objects are equal');
assert(deepEqual(resolvedDiff({ a: { b: 1 } }, { a: { b: 1 } }), []), 'identical nested objects are equal');
assert(deepEqual(resolvedDiff({ a: 1 }, { $schema: 'x', a: 1 }), []), 'top-level $schema is ignored (catalog metadata)');

const scalarDiff = resolvedDiff({ a: 1 }, { a: 2 });
assert(scalarDiff.length === 1 && scalarDiff[0].path === 'a' && scalarDiff[0].old === 1 && scalarDiff[0].new === 2,
  'divergent scalar reported as {path, old, new}', JSON.stringify(scalarDiff));

const nestedDiff = resolvedDiff({ review: { rounds: 1 } }, { review: { rounds: 2 } });
assert(nestedDiff.length === 1 && nestedDiff[0].path === 'review.rounds', 'nested divergence uses dotted path');

const missingDiff = resolvedDiff({ a: 1, b: 2 }, { a: 1 });
assert(missingDiff.length === 1 && missingDiff[0].path === 'b' && missingDiff[0].new === undefined,
  'missing key on new side reported');

const addedDiff = resolvedDiff({ a: 1 }, { a: 1, c: 3 });
assert(addedDiff.length === 1 && addedDiff[0].path === 'c' && addedDiff[0].old === undefined,
  'invented key on new side reported');

assert(deepEqual(resolvedDiff({ t: ['a', 'b'] }, { t: ['a', 'b'] }), []), 'equal arrays are equal (whole-value)');
assert(resolvedDiff({ t: ['a', 'b'] }, { t: ['b', 'a'] }).length === 1, 'reordered array is a divergence (replace semantics)');
assert(resolvedDiff({ t: 'x' }, { t: { y: 1 } }).length === 1, 'type change scalar→object is a divergence');
assert(resolvedDiff({ '$schema': 'x' }, {}).length === 0, '$schema-only old side still equal');

// ── activateValues round-trip ───────────────────────────────────────────────

process.stdout.write('\nactivateValues — scaffold + user values round-trip\n');
const schema = loadSchema();
assert(schema && schema.properties, 'schema loads');
const scaffold = generateScaffold(schema);
const userValues = {
  tier_models: { heavy: 'claude-opus-4-8', max: 'claude-fable-5' },
  effort: { 'plan-milestone': 'max', 'execute-task': 'low' },
  auto_commit: true,
  main_branch: 'main',
  routing: { backend: { executor: { standard: ['gpt-6-luna', 'claude-sonnet-5-5'], fallback: 'gpt-6-luna' } } },
};
const activated = activateValues(scaffold, userValues, schema);
const activatedParsed = parseJsonc(activated);
assert(activatedParsed.ok, 'activated catalog parses as JSONC', activatedParsed.error && activatedParsed.error.message);
assert(deepEqual(resolvedDiff(userValues, activatedParsed.value), []),
  'parse(activateValues(scaffold, values)) deep-equals values (gate-empty)');
assert(activated.includes('"$schema"'), 'catalog keeps the $schema metadata key');
const emptyActivated = activateValues(scaffold, {}, schema);
assert(deepEqual(resolvedDiff({}, parseJsonc(emptyActivated).value), []), 'empty values → all-commented catalog (gate-empty)');

// ── Pipeline: happy path (global + repo-shared + local fold) ────────────────

process.stdout.write('\nmigrateAll — happy path round-trip\n');
{
  const fx = makeFixture({ repoMd: REPO_MD, localMd: LOCAL_MD });
  const dirs = { globalDir: fx.globalDir, localDir: fx.localDir };
  const oldGlobal = legacyReadLayer([path.join(fx.globalDir, 'forge-agent-prefs.md')]).prefs;
  const oldLocal = legacyReadLayer([
    path.join(fx.localDir, 'claude-agent-prefs.md'),
    path.join(fx.localDir, 'prefs.local.md'),
  ]).prefs;
  const oldMerged = deepMerge(oldGlobal, oldLocal);

  const result = migrateAll(fx.cwd, dirs);
  assert(result.status === 'migrated', 'status is migrated', JSON.stringify(result));
  const globalJsonc = path.join(fx.globalDir, 'forge-agent-prefs.jsonc');
  const localJsonc = path.join(fx.localDir, 'forge-prefs.jsonc');
  assert(fs.existsSync(globalJsonc), 'global jsonc written');
  assert(fs.existsSync(localJsonc), 'local jsonc written');
  assert(deepEqual(result.diff, []), 'reported merged diff is empty (round-trip proof)');

  const newGlobal = parseJsonc(fs.readFileSync(globalJsonc, 'utf8')).value;
  const newLocal = parseJsonc(fs.readFileSync(localJsonc, 'utf8')).value;
  assert(deepEqual(resolvedDiff(oldMerged, deepMerge(newGlobal, newLocal)), []),
    'post-migration resolved deep-equals pre-migration resolved');
  assert(newLocal.review.rounds === 3, 'fold direction: prefs.local.md wins the conflict (rounds 3)');
  assert(newGlobal.auto_commit === true && newGlobal.main_branch === 'main', 'legacy flat scalars survive');
  assert(deepEqual(newGlobal.routing.backend.executor.standard, ['gpt-6-luna', 'claude-sonnet-5-5']), 'routing tier list survives');
  assert(newGlobal.routing.backend.executor.fallback === 'gpt-6-luna', 'routing fallback survives');

  // .bak present for every legacy md; legacy md removed after re-verify.
  assert(fs.existsSync(path.join(fx.globalDir, 'forge-agent-prefs.md.bak')), 'global .bak exists');
  assert(fs.existsSync(path.join(fx.localDir, 'claude-agent-prefs.md.bak')), 'repo-shared .bak exists');
  assert(fs.existsSync(path.join(fx.localDir, 'prefs.local.md.bak')), 'local .bak exists');
  assert(!fs.existsSync(path.join(fx.globalDir, 'forge-agent-prefs.md')), 'legacy global md retired after re-verify');
  assert(!fs.existsSync(path.join(fx.localDir, 'prefs.local.md')), 'legacy local md retired after re-verify');
  assert(readNormalized(path.join(fx.globalDir, 'forge-agent-prefs.md.bak')) === GLOBAL_MD,
    '.bak is a byte-identical copy of the legacy md');

  // Idempotence: second run is a no-op that never re-reads the .bak.
  const filesBefore = listAllFiles(fx.root).map((f) => `${f}:${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}`).sort();
  const second = migrateAll(fx.cwd, dirs);
  assert(second.status === 'noop', 'second run reports noop', JSON.stringify(second.status));
  assert(second.layers.every((l) => l.action === 'skipped' && l.reason === 'already-migrated'),
    'both layers report already-migrated');
  const filesAfter = listAllFiles(fx.root).map((f) => `${f}:${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}`).sort();
  assert(deepEqual(filesBefore, filesAfter), 'idempotent re-run performs zero writes (mtimes/sizes intact)');
}

// ── Pipeline: Phase-2 commit-loop unwind (S05-R2) ───────────────────────────
process.stdout.write('\nmigrateAll — commit-loop unwind on mid-loop throw\n');
{
  const fx = makeFixture({ repoMd: REPO_MD, localMd: LOCAL_MD });
  const globalJsonc = path.join(fx.globalDir, 'forge-agent-prefs.jsonc');
  const localJsonc = path.join(fx.localDir, 'forge-prefs.jsonc');
  // Force the 2nd successful commit to throw (ENOSPC/EACCES analogue): the 1st
  // layer's jsonc is already on disk when the 2nd blows up.
  let calls = 0;
  const commitLayer = (prep) => {
    calls++;
    if (calls === 1) {
      fs.writeFileSync(prep.jsoncPath, prep.generated, 'utf8');
      return { name: prep.name, action: 'migrated', jsoncPath: prep.jsoncPath, baks: [], mdFiles: prep.mdFiles, diff: [] };
    }
    throw new Error('simulated ENOSPC on layer 2');
  };
  const result = migrateAll(fx.cwd, { globalDir: fx.globalDir, localDir: fx.localDir, commitLayer });
  assert(result.status === 'error', 'mid-loop throw returns status error', JSON.stringify(result.status));
  assert(calls === 2, 'commit was attempted for both layers before unwind', `calls=${calls}`);
  assert(!fs.existsSync(globalJsonc), 'UNWIND: 1st layer jsonc deleted (no half-migrated state)');
  assert(!fs.existsSync(localJsonc), 'UNWIND: 2nd (failed) layer jsonc never left behind');
  // Original mds + any .bak left intact — no source loss.
  assert(fs.existsSync(path.join(fx.globalDir, 'forge-agent-prefs.md')), 'original global md intact after unwind');
  assert(fs.existsSync(path.join(fx.localDir, 'claude-agent-prefs.md')), 'original repo-shared md intact after unwind');
  assert(fs.existsSync(path.join(fx.localDir, 'prefs.local.md')), 'original local md intact after unwind');
}

// ── Pipeline: dry-run performs zero writes ──────────────────────────────────

process.stdout.write('\nmigrateAll — dry-run\n');
{
  const fx = makeFixture({ localMd: LOCAL_MD });
  const before = listAllFiles(fx.root).sort();
  const result = migrateAll(fx.cwd, { globalDir: fx.globalDir, localDir: fx.localDir, dryRun: true });
  assert(result.status === 'dry-run', 'status is dry-run');
  assert(result.layers.some((l) => l.action === 'dry-run' && l.wouldBackup && l.wouldBackup.length > 0),
    'dry-run reports the planned .bak paths');
  const after = listAllFiles(fx.root).sort();
  assert(deepEqual(before, after), 'dry-run writes nothing (file list unchanged)');
  assert(!fs.existsSync(path.join(fx.globalDir, 'forge-agent-prefs.jsonc')), 'dry-run: no jsonc created');
}

// ── Gate STOP: divergent generated catalog → zero writes ────────────────────

process.stdout.write('\nmigrateAll — divergence gate (exit 3, zero writes)\n');
{
  const fx = makeFixture({ localMd: LOCAL_MD });
  const before = listAllFiles(fx.root).sort();
  process.env.FORGE_PREFS_MIGRATE_TEST_MUTATE = '1';
  let result;
  try {
    result = migrateAll(fx.cwd, { globalDir: fx.globalDir, localDir: fx.localDir });
  } finally {
    delete process.env.FORGE_PREFS_MIGRATE_TEST_MUTATE;
  }
  assert(result.status === 'diff', 'status is diff (gate STOP)', JSON.stringify(result.status));
  assert(Array.isArray(result.diff) && result.diff.length > 0, 'diff entries reported');
  assert(result.diff.some((d) => d.path === '__forge_test_mutation'), 'diff pinpoints the invented key');
  const after = listAllFiles(fx.root).sort();
  assert(deepEqual(before, after), 'gate STOP: ZERO filesystem writes (no jsonc, no .bak)');
  assert(!fs.existsSync(path.join(fx.globalDir, 'forge-agent-prefs.jsonc')), 'no global jsonc on STOP');
  assert(!fs.existsSync(path.join(fx.globalDir, 'forge-agent-prefs.md.bak')), 'no .bak on STOP');

  // CLI e2e: same fixture through the real process → exit 3.
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-prefs-migrate.js'),
    '--cwd', fx.cwd, '--global-dir', fx.globalDir, '--local-dir', fx.localDir, '--json',
  ], { env: Object.assign({}, process.env, { FORGE_PREFS_MIGRATE_TEST_MUTATE: '1' }), encoding: 'utf8' });
  assert(cli.status === 3, 'CLI exits 3 on gate divergence', `exit ${cli.status}`);
  const cliJson = JSON.parse(cli.stdout.trim());
  assert(cliJson.status === 'diff', 'CLI --json reports status diff');
  assert(/old=/.test(cli.stderr) && /new=/.test(cli.stderr), 'CLI prints the diff key-by-key on stderr');
  assert(deepEqual(listAllFiles(fx.root).sort(), after), 'CLI gate STOP also writes nothing');
}

// ── Malformed legacy md → exit 4, zero writes ───────────────────────────────

process.stdout.write('\nmigrateAll — malformed legacy md (exit 4, zero writes)\n');
{
  const fx = makeFixture({ globalMd: MALFORMED_MD });
  const before = listAllFiles(fx.root).sort();
  const result = migrateAll(fx.cwd, { globalDir: fx.globalDir, localDir: fx.localDir });
  assert(result.status === 'legacy-parse-error', 'status is legacy-parse-error', JSON.stringify(result.status));
  assert(result.errors.length > 0 && /routing-parse-error/.test(result.errors[0].message),
    'error identifies the routing parse failure');
  assert(deepEqual(listAllFiles(fx.root).sort(), before), 'malformed md: ZERO writes');

  const cli = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-prefs-migrate.js'),
    '--cwd', fx.cwd, '--global-dir', fx.globalDir, '--local-dir', fx.localDir, '--json',
  ], { encoding: 'utf8' });
  assert(cli.status === 4, 'CLI exits 4 on malformed legacy md', `exit ${cli.status}`);
  assert(deepEqual(listAllFiles(fx.root).sort(), before), 'CLI malformed path also writes nothing');
}

// ── .bak non-clobber ────────────────────────────────────────────────────────

process.stdout.write('\nmigrateAll — .bak never overwritten\n');
{
  const fx = makeFixture({});
  const preexisting = path.join(fx.globalDir, 'forge-agent-prefs.md.bak');
  fs.writeFileSync(preexisting, 'PRECIOUS OLD BACKUP\n');
  const result = migrateAll(fx.cwd, { globalDir: fx.globalDir, localDir: fx.localDir });
  assert(result.status === 'migrated', 'migration succeeds with pre-existing .bak');
  assert(readNormalized(preexisting) === 'PRECIOUS OLD BACKUP\n', 'pre-existing .bak untouched');
  const timestamped = fs.readdirSync(fx.globalDir).filter((f) => /^forge-agent-prefs\.md\.bak-\d+$/.test(f));
  assert(timestamped.length === 1, 'new backup written with .bak-<ts> suffix instead');
  assert(readNormalized(path.join(fx.globalDir, timestamped[0])) === GLOBAL_MD,
    'timestamped backup holds the legacy md content');
}

// ── CLI happy path exits 0 and prints the empty-diff proof ──────────────────

process.stdout.write('\nCLI — happy path exit 0\n');
{
  const fx = makeFixture({ localMd: LOCAL_MD });
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-prefs-migrate.js'),
    '--cwd', fx.cwd, '--global-dir', fx.globalDir, '--local-dir', fx.localDir, '--json',
  ], { encoding: 'utf8' });
  assert(cli.status === 0, 'CLI exits 0 on clean migration', `exit ${cli.status}\n${cli.stderr}`);
  const output = JSON.parse(cli.stdout.trim());
  assert(output.status === 'migrated', 'CLI --json reports migrated');
  assert(/round-trip proven/.test(cli.stderr), 'CLI prints the empty-diff proof on stderr');
  assert(cli.status === 0 && fs.existsSync(path.join(fx.localDir, 'forge-prefs.jsonc')), 'local jsonc exists after CLI run');

  const rerun = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-prefs-migrate.js'),
    '--cwd', fx.cwd, '--global-dir', fx.globalDir, '--local-dir', fx.localDir,
  ], { encoding: 'utf8' });
  assert(rerun.status === 0 && /already-migrated/.test(rerun.stderr), 'CLI re-run exits 0 reporting already-migrated');
}

// ── --global-only / --local-only scoping ────────────────────────────────────

process.stdout.write('\nmigrateAll — layer scoping\n');
{
  const fx = makeFixture({ localMd: LOCAL_MD });
  const result = migrateAll(fx.cwd, { globalDir: fx.globalDir, localDir: fx.localDir, globalOnly: true });
  assert(result.status === 'migrated', 'global-only run migrates');
  assert(fs.existsSync(path.join(fx.globalDir, 'forge-agent-prefs.jsonc')), 'global jsonc written');
  assert(!fs.existsSync(path.join(fx.localDir, 'forge-prefs.jsonc')), 'local layer untouched under --global-only');
  assert(fs.existsSync(path.join(fx.localDir, 'prefs.local.md')), 'local legacy md untouched under --global-only');
}

// ── T02: directional fold, gitignore policy, and --set ────────────────────

process.stdout.write('\nT02 — directional fold and local absence\n');
{
  const fx = makeFixture({
    globalMd: GLOBAL_MD,
    repoMd: 'review:\n  rounds: 2\n  mode: enabled\n',
    localMd: LOCAL_MD,
  });
  const result = migrateAll(fx.cwd, { globalDir: fx.globalDir, localDir: fx.localDir });
  const local = parseJsonc(fs.readFileSync(path.join(fx.localDir, 'forge-prefs.jsonc'), 'utf8')).value;
  const global = parseJsonc(fs.readFileSync(path.join(fx.globalDir, 'forge-agent-prefs.jsonc'), 'utf8')).value;
  assert(result.status === 'migrated' && local.review.rounds === 3,
    'conflicting repo-shared/local fold resolves old local last (3)');
  assert(local.review.mode === 'enabled', 'repo-shared-only knob remains in folded local catalogue');
  assert(global.review.rounds === 1 && local.review.rounds === 3,
    'global stays global while local override is not flattened into it');
  assert(result.warnings.some((warning) => /config de time por commit deixa de existir/.test(warning)),
    'folding commit-able claude-agent-prefs.md emits explicit team-config warning');
}
{
  const fx = makeFixture({ globalMd: null, repoMd: undefined, localMd: undefined });
  const result = migrateAll(fx.cwd, { globalDir: fx.globalDir, localDir: fx.localDir });
  assert(result.status === 'noop', 'no local markdown means no migration');
  assert(!fs.existsSync(path.join(fx.localDir, 'forge-prefs.jsonc')),
    'no local markdown never creates local forge-prefs.jsonc');
}

process.stdout.write('\nT02 — ensureGitignore\n');
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prefs-ignore-'));
  const unignoredGit = (bin, args) => {
    if (args[0] === 'rev-parse') return '';
    if (args[0] === 'check-ignore') throw new Error('unignored');
    throw new Error('unexpected command');
  };
  const appended = ensureGitignore(cwd, { execFileSync: unignoredGit });
  assert(appended.action === 'appended' && readNormalized(path.join(cwd, '.gitignore')) === '.gsd/forge-prefs.jsonc\n',
    'git repo with unignored local catalog appends exact .gitignore line');
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.gsd/\n');
  const covered = ensureGitignore(cwd, { execFileSync: (bin, args) => {
    if (args[0] === 'rev-parse' || args[0] === 'check-ignore') return '';
    throw new Error('unexpected command');
  } });
  assert(covered.action === 'skipped' && covered.reason === 'already-ignored' && readNormalized(path.join(cwd, '.gitignore')) === '.gsd/\n',
    'already-covered path skips without touching .gitignore');
  const nonGit = ensureGitignore(cwd, { execFileSync: () => { throw new Error('not git'); } });
  assert(nonGit.action === 'skipped' && nonGit.reason === 'not-git', 'non-git directory skips .gitignore');
}

process.stdout.write('\nT02 — --set preserves catalogue blocks\n');
{
  const fx = makeFixture({ globalMd: null, repoMd: undefined, localMd: undefined });
  const localPath = path.join(fx.localDir, 'forge-prefs.jsonc');
  const created = setPreference(fx.cwd, 'review.rounds=2', {
    globalDir: fx.globalDir, localDir: fx.localDir, layer: 'local', create: true,
  });
  const first = fs.readFileSync(localPath, 'utf8');
  assert(created.status === 'set' && parseJsonc(first).value.review.rounds === 2,
    '--set --create activates an off knob in a new local scaffold');
  const protectedBlock = first.slice(0, first.indexOf('// ── review '));
  const updated = setPreference(fx.cwd, 'review.rounds=3', {
    globalDir: fx.globalDir, localDir: fx.localDir, layer: 'local',
  });
  const second = fs.readFileSync(localPath, 'utf8');
  assert(updated.status === 'set' && parseJsonc(second).value.review.rounds === 3,
    '--set updates an already-active knob and result parses');
  assert(second.includes(protectedBlock), '--set preserves all unrelated catalogue blocks byte-for-byte');
  fs.unlinkSync(localPath);
  const refused = setPreference(fx.cwd, 'review.rounds=1', {
    globalDir: fx.globalDir, localDir: fx.localDir, layer: 'local',
  });
  assert(refused.status === 'local-create-required' && !fs.existsSync(localPath),
    '--set does not create a local catalogue without explicit --create');
}

// Regression: --set used to append a duplicate root key and lean on JSON
// last-wins. Two defects followed. (a) Every repeat stacked another block — a
// real global catalogue reached 29 tier_models blocks, one per /forge-update.
// (b) The appended block SHADOWED the documented block, so a user hand-editing
// the catalogue changed nothing. --set now rewrites in place.
process.stdout.write('\nT02 — --set rewrites in place instead of appending\n');
{
  const fx = makeFixture({ globalMd: null, repoMd: undefined, localMd: undefined });
  const localPath = path.join(fx.localDir, 'forge-prefs.jsonc');
  const opts = { globalDir: fx.globalDir, localDir: fx.localDir, layer: 'local' };
  setPreference(fx.cwd, 'review.rounds=1', { ...opts, create: true });
  const blocks = (text, key) => (text.match(new RegExp(`^ {2}"${key}":`, 'gm')) || []).length;
  for (const rounds of [2, 3, 0, 2]) setPreference(fx.cwd, `review.rounds=${rounds}`, opts);
  for (const value of ['/tmp/a', '/tmp/b', '/tmp/c']) setPreference(fx.cwd, `repo_path=${value}`, opts);
  const repeated = fs.readFileSync(localPath, 'utf8');
  const parsedRepeat = parseJsonc(repeated);
  assert(blocks(repeated, 'review') === 1 && blocks(repeated, 'repo_path') === 1,
    'repeated --set leaves exactly one active block per section',
    `review=${blocks(repeated, 'review')} repo_path=${blocks(repeated, 'repo_path')}`);
  assert(parsedRepeat.ok && parsedRepeat.value.review.rounds === 2 && parsedRepeat.value.repo_path === '/tmp/c',
    'the last --set is what the catalogue resolves to');
  assert(!repeated.includes('set by forge-prefs-migrate --set'),
    'a known section needs no marker comment — it is rewritten where it belongs');
  assert(repeated.includes('// ── review ') && repeated.indexOf('// ── review ') < repeated.indexOf('  "review":'),
    'the documentation banner above a rewritten section survives');
  // The original defect was unbounded growth: another full round must reproduce
  // the same bytes rather than appending more.
  for (const rounds of [3, 0, 2]) setPreference(fx.cwd, `review.rounds=${rounds}`, opts);
  for (const value of ['/tmp/a', '/tmp/c']) setPreference(fx.cwd, `repo_path=${value}`, opts);
  assert(fs.readFileSync(localPath, 'utf8') === repeated,
    'a second round of identical --set calls is byte-for-byte a fixed point');
  // Sibling keys written by separate calls must survive the rewrite.
  setPreference(fx.cwd, 'review.style=flags', opts);
  const sibling = parseJsonc(fs.readFileSync(localPath, 'utf8'));
  assert(sibling.ok && sibling.value.review.style === 'flags' && sibling.value.review.rounds === 2,
    'rewriting a section keeps knobs written by earlier calls');
  // The point of the whole change: a hand edit is authoritative, and a later
  // --set on a sibling knob must not resurrect the value the human replaced.
  const handEdited = fs.readFileSync(localPath, 'utf8').replace('"rounds": 2', '"rounds": 3');
  fs.writeFileSync(localPath, handEdited, 'utf8');
  const afterHand = resolveCurrent(fx.cwd, opts).prefs;
  assert(afterHand.review.rounds === 3, 'a hand edit to the documented block is what resolves — never shadowed');
  setPreference(fx.cwd, 'review.style=dialectic', opts);
  const afterSet = resolveCurrent(fx.cwd, opts).prefs;
  assert(afterSet.review.rounds === 3 && afterSet.review.style === 'dialectic',
    'a later --set reads the hand-edited value forward instead of overwriting it');
}

process.stdout.write('\nIssues277/278 — routing shape and layer-aware set verification\n');
{
  const fx = makeFixture({ globalMd: null });
  const globalPath = path.join(fx.globalDir, 'forge-agent-prefs.jsonc');
  const localPath = path.join(fx.localDir, 'forge-prefs.jsonc');
  const inherited = { routing: { default: { executor: { light: ['gpt-6-luna'] } } }, review: { rounds: 2 } };
  fs.writeFileSync(globalPath, JSON.stringify(inherited, null, 2));
  fs.writeFileSync(localPath, '{}');
  const opts = { globalDir: fx.globalDir, localDir: fx.localDir, layer: 'local' };
  const expression = 'routing=' + JSON.stringify({ visual: { executor: { light: ['gpt-6.1-terra'] } } });
  const originalGlobal = fs.readFileSync(globalPath, 'utf8'), originalLocal = fs.readFileSync(localPath, 'utf8');
  const dry = setPreference(fx.cwd, expression, { ...opts, dryRun: true });
  assert(dry.status === 'dry-run' && fs.readFileSync(globalPath, 'utf8') === originalGlobal && fs.readFileSync(localPath, 'utf8') === originalLocal,
    'issue278 dry-run previews inherited routing without writing either layer');
  const applied = setPreference(fx.cwd, expression, opts);
  const local = parseJsonc(fs.readFileSync(localPath, 'utf8')).value;
  const resolved = resolveCurrent(fx.cwd, opts).prefs;
  assert(applied.status === 'set' && deepEqual(local.routing, JSON.parse(expression.slice('routing='.length)))
    && deepEqual(Object.keys(resolved.routing).sort(), ['default', 'visual']) && resolved.review.rounds === 2
    && fs.readFileSync(globalPath, 'utf8') === originalGlobal,
    'issue278 apply verifies only the requested layer plus canonical merged semantics, preserving inherited domains');
  setPreference(fx.cwd, 'routing.default=' + JSON.stringify({ planner: { heavy: ['claude-opus-5-5'] } }), opts);
  assert(!resolveCurrent(fx.cwd, opts).prefs.routing.default.executor,
    'issue278 setting a domain preserves whole-domain replacement rather than inheriting omitted phases');
  setPreference(fx.cwd, 'review.rounds=3', opts);
  assert(setPreference(fx.cwd, 'review.rounds=1', { ...opts, layer: 'global' }).status === 'set'
    && parseJsonc(fs.readFileSync(globalPath, 'utf8')).value.review.rounds === 1
    && resolveCurrent(fx.cwd, opts).prefs.review.rounds === 3,
    'issue278 global layer updates succeed even when a local value intentionally overrides the result');
  const beforeRefusal = fs.readFileSync(localPath, 'utf8');
  for (const dryRun of [true, false]) {
    let refused = false;
    try { setPreference(fx.cwd, 'routing.tier_models.light=["claude-haiku-5-5"]', { ...opts, dryRun }); }
    catch (error) { refused = /routing phase/.test(error.message); }
    assert(refused && fs.readFileSync(localPath, 'utf8') === beforeRefusal,
      'issue277 malformed routing is rejected before writes in both dry-run and apply');
  }
  assert(setPreference(fx.cwd, 'routing.tier_models=' + JSON.stringify({ executor: { light: ['gpt-6-luna'] } }), opts).status === 'set',
    'issue277 a custom domain named tier_models remains supported with a valid structure');
  const originalWrite = fs.writeFileSync;
  let failure;
  try {
    fs.writeFileSync = function (file, content, ...args) {
      const result = originalWrite.call(fs, file, content, ...args);
      if (path.resolve(file) === path.resolve(localPath)) originalWrite.call(fs, file, JSON.stringify({ review: { rounds: 2 } }, null, 2));
      return result;
    };
    try { setPreference(fx.cwd, 'review.rounds=1', opts); } catch (error) { failure = error; }
  } finally { fs.writeFileSync = originalWrite; }
  assert(failure && failure.write_state === 'written' && /catalog write state: written/.test(failure.message)
    && parseJsonc(fs.readFileSync(localPath, 'utf8')).value.review.rounds === 2,
    'issue278 post-write drift discloses the retained write and never erases intervening bytes');
  let partialFailure;
  try {
    fs.writeFileSync = function (file, content, ...args) {
      if (path.resolve(file) === path.resolve(localPath)) {
        originalWrite.call(fs, file, '{');
        throw Object.assign(new Error('synthetic interrupted write'), { code: 'EIO' });
      }
      return originalWrite.call(fs, file, content, ...args);
    };
    try { setPreference(fx.cwd, 'review.rounds=1', opts); } catch (error) { partialFailure = error; }
  } finally { fs.writeFileSync = originalWrite; }
  assert(partialFailure && partialFailure.code === 'EIO' && partialFailure.write_state === 'unknown'
    && /catalog write state: unknown/.test(partialFailure.message) && fs.readFileSync(localPath, 'utf8') === '{',
    'issue278 partial I/O failure preserves the uncertain write and original error without unsafe rollback');
}

process.stdout.write('\nIssue312 — compact catalog entry boundaries\n');
for (const [input, key, value, retained, label] of [
  ['{"review":{"rounds":1},"auto_commit":false}', 'review.rounds', 2, '"auto_commit":false}', 'first object and same-line neighbor'],
  ['{"auto_commit":false,"review":{"rounds":1}}', 'auto_commit', true, '"review":{"rounds":1}}', 'first primitive and same-line neighbor'],
  ['{"auto_commit":false,"review":{"rounds":1}}', 'review.rounds', 2, '{"auto_commit":false,', 'last object and root close'],
  ['{"review":{"rounds":1},"auto_commit":false}', 'auto_commit', true, '{"review":{"rounds":1},', 'last primitive without comma'],
  ['{"operator":"old\\\"value","auto_commit":false}', 'operator', 'new', '"auto_commit":false}', 'quoted scalar and neighbor'],
  ['{"operator":[1,{"x":"y"}],"auto_commit":false}', 'operator', [2], '"auto_commit":false}', 'array and neighbor'],
  ['{"operator":null,"auto_commit":false}', 'operator', true, '"auto_commit":false}', 'null scalar and neighbor'],
  ['{"operator":-1.25e+3,"review":{"rounds":1}}', 'operator', -2, '"review":{"rounds":1}}', 'numeric scalar and neighbor'],
  ['{"review":{"rounds":1} /* section, } */ , "auto_commit":false /* untouched, } */}', 'review.rounds', 2,
    '"auto_commit":false /* untouched, } */}', 'comment delimiters and unrelated comment'],
  ['{\r  "review": {"rounds":1},\r  "auto_commit":false\r}', 'review.rounds', 2, '  "auto_commit":false\r}', 'CR-only lines'],
  ['{\r\n  "review": {"rounds":1},\r\n  "auto_commit":false\r\n}', 'auto_commit', true, '{\r\n  "review": {"rounds":1},\r\n', 'last scalar and CRLF'],
  ['{"review":{"rounds":0},"auto_commit":false,"review":{"rounds":1},"operator":"tail"}', 'review.rounds', 2, '"auto_commit":false,', 'same-line duplicate sections'],
]) {
  let output;
  try { output = setCatalogValue(input, key, value, schema); }
  catch (error) { assert(false, `issue312 ${label}: ${error.message}`); continue; }
  const result = parseJsonc(output);
  const actual = key.split('.').reduce((object, part) => object[part], result.value);
  assert(result.ok && JSON.stringify(actual) === JSON.stringify(value), `issue312 ${label} applies the requested value`);
  assert(output.includes(retained) && output.trimStart().startsWith('{') && output.trimEnd().endsWith('}'),
    `issue312 ${label} retains unrelated bytes and root braces`);
  assert(setCatalogValue(output, key, value, schema) === output, `issue312 ${label} repeat is a byte-for-byte fixed point`);
}
{
  const fx = makeFixture({ globalMd: null, repoMd: undefined, localMd: undefined });
  const localPath = path.join(fx.localDir, 'forge-prefs.jsonc');
  fs.writeFileSync(localPath, '{"review":{"rounds":1},"auto_commit":false}');
  try {
    const result = setPreference(fx.cwd, 'review.rounds=2', { globalDir: fx.globalDir, localDir: fx.localDir, layer: 'local' });
    const bytes = fs.readFileSync(localPath, 'utf8');
    assert(result.status === 'set' && parseJsonc(bytes).value.review.rounds === 2 && bytes.includes('"auto_commit":false}'),
      'issue312 public setter writes a valid compact catalog without changing its neighbor');
  } catch (error) { assert(false, `issue312 public setter: ${error.message}`); }
}

process.stdout.write(`\n${passes} passed, ${failures} failed\n`);
process.exitCode = failures > 0 ? 1 : 0;
