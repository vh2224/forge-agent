'use strict';

// Paired regression suite. Fixtures stay in the operating-system temp area;
// no generated fragment store is ever part of this repository.
const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const curate = require('./forge-sweep-curate');
const internals = curate._private;

// Internals-level fixtures live under the OS temp area (no repo-cwd
// dependency). Only the CLI-spawning test below deliberately keeps a
// repo-cwd fixture — see its own comment for why.
function osTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-curate-test-')); }
function tempDir() { return fs.mkdtempSync(path.join(process.cwd(), '.curate-test-')); }
function removeDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function item(storage, id, unit) { return { storage_key: storage, mem_id: id, unit_id: unit || 'T01', milestone_id: 'M001' }; }
function cluster(id, items) { return { id, items }; }
function arbitration(id, entries) { return { clusters: [{ cluster_id: id, items: entries }] }; }
function verdict(storage, id, value) { return { storage_key: storage, mem_id: id, verdict: value }; }
function plan(clusters) { return { clusters, targets: clusters.map(value => ({ name: value.id, path: value.id, members: value.items.map(entry => ({ ...entry, storageKey: entry.storage_key, memId: entry.mem_id, path: entry.storage_key })) })), skipped: [] }; }

function expectReason(reason, fn) {
  assert.throws(fn, error => error && error.reason === reason, reason);
}

function testRegistry() {
  const registry = curate.buildRegistry();
  const operations = registry.list();
  assert.strictEqual(operations.length, 1);
  assert.strictEqual(operations[0].name, 'curadoria-semantica');
  assert.strictEqual(typeof operations[0].plan, 'function');
  assert.strictEqual(typeof operations[0].apply, 'function');
}

function testClosedVerdicts() {
  const current = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  expectReason('arbitration-unreadable', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'delete'), verdict('b', 'MEM002', 'manter')]), current));
}

function testExactlyOneSurvivor() {
  const current = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  expectReason('no-survivor', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'fundir-no-sobrevivente'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]), current));
  expectReason('multiple-survivors', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'manter')]), current));
}

function testUnknownItem() {
  const current = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  expectReason('unknown-item', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('z', 'MEM999', 'fundir-no-sobrevivente')]), current));
}

function testUnjudgedItems() {
  const current = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  expectReason('unjudged-items', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'manter')]), current));
}

function testUnknownCluster() {
  const current = plan([cluster('c', [item('a', 'MEM001')])]);
  expectReason('unknown-cluster', () => curate.validateArbitrationShape(arbitration('other', [verdict('a', 'MEM001', 'manter')]), current));
}

function testCompoundAddress() {
  const current = plan([cluster('c', [item('one', 'MEM001'), item('two', 'MEM001')])]);
  const doc = arbitration('c', [verdict('one', 'MEM001', 'manter'), verdict('two', 'MEM001', 'fundir-no-sobrevivente')]);
  curate.validateArbitrationShape(doc, current);
  const drops = internals.selectedDrops(doc);
  assert.deepStrictEqual(drops.get('two'), ['MEM001']);
  assert.strictEqual(drops.has('one'), false);
}

function testFingerprintStableAndSensitive() {
  const left = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  const same = plan([cluster('c', [item('b', 'MEM002'), item('a', 'MEM001')])]);
  const changed = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM003')])]);
  assert.strictEqual(curate.planFingerprint(left), curate.planFingerprint(same));
  assert.notStrictEqual(curate.planFingerprint(left), curate.planFingerprint(changed));
}

function liveContext(dir, clusters, arb, overrides) {
  const files = new Map();
  for (const entry of clusters.flatMap(value => value.items)) {
    const file = path.join(dir, `${entry.storage_key}.md`);
    if (!files.has(entry.storage_key)) fs.writeFileSync(file, `bytes:${entry.storage_key}`);
    files.set(entry.storage_key, file);
  }
  return Object.assign({
    cwd: dir,
    arbitration: arb,
    buildClusters: () => ({ clusters, verdict: 'TARGETS', census: { skipped: [] } }),
    listFragments: () => [...files].map(([storageKey, file]) => ({ storageKey, path: file })),
    activeUnits: () => ({ ok: true, units: [] }),
    writeVault: () => ({ ok: true, containerPath: path.join(dir, 'vault.md'), skipped: [] }),
    journal: { appendIntent: () => ({ ok: true, id: 'j1' }), appendOutcome: () => ({ ok: true }) },
    rewriteFragment: (_cwd, request) => ({ ok: true, path: files.get(request.storageKey) }),
  }, overrides || {});
}

function testPlanChangedZeroMutation() {
  const dir = osTempDir();
  try {
    const original = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]);
    const current = plan(original);
    const ctx = liveContext(dir, [cluster('c', [item('a', 'MEM001'), item('b', 'MEM003')])], doc);
    const file = path.join(dir, 'a.md'); const before = digest(file);
    const result = internals.applyCurate(ctx, current);
    assert.strictEqual(result.error, 'plan-changed');
    assert.strictEqual(digest(file), before);
  } finally { removeDir(dir); }
}

function testIntentFailureZeroMutation() {
  const dir = osTempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]);
    let rewritten = 0;
    const ctx = liveContext(dir, clusters, doc, { journal: { appendIntent: () => ({ ok: false, error: 'disk full' }), appendOutcome: () => ({ ok: true }) }, rewriteFragment: () => { rewritten += 1; return { ok: true }; } });
    const result = internals.applyCurate(ctx, plan(clusters));
    assert.strictEqual(result.error, 'journal-intent-failed');
    assert.strictEqual(rewritten, 0);
  } finally { removeDir(dir); }
}

function testRewriteIsolation() {
  const dir = osTempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002'), item('c', 'MEM003')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente'), verdict('c', 'MEM003', 'fundir-no-sobrevivente')]);
    const calls = [];
    const ctx = liveContext(dir, clusters, doc, { rewriteFragment: (_cwd, request) => { calls.push(request.storageKey); return request.storageKey === 'b' ? { ok: false, path: 'b', reason: 'would-empty-fragment' } : { ok: true, path: request.storageKey }; } });
    const result = internals.applyCurate(ctx, plan(clusters));
    assert.deepStrictEqual(calls.sort(), ['b', 'c']);
    assert.deepStrictEqual(result.written, ['c']);
    assert(result.skipped.some(entry => entry.reason === 'would-empty-fragment'));
  } finally { removeDir(dir); }
}

function testActivePhaseFailClosed() {
  const dir = osTempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]);
    const result = internals.curatePlan(liveContext(dir, clusters, doc, { activeUnits: () => ({ ok: false }) }));
    assert.strictEqual(result.targets.length, 0);
    assert.strictEqual(result.skipped[0].reason, 'active-phase-unknown');
  } finally { removeDir(dir); }
}

function testArgumentCodes() {
  assert.throws(() => internals.parseArgs(['--unknown']));
  assert.throws(() => internals.parseArgs(['--apply']));
  assert.strictEqual(internals.parseArgs(['--apply', '--arbitration', 'a.json', '--yes']).apply, true);
}

function testNoSecondWriterOrContainers() {
  const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-curate.js'), 'utf8');
  assert(source.includes("require('./forge-memory-rewrite')"));
  assert(!source.includes('forge-epoch-group'));
  assert(!source.includes('forge-grouped-file'));
  assert(!/function\s+(detectEol|serializeFragment|applyEol)\s*\(/.test(source));
}

function testDefaultIsDryRun() {
  const options = internals.parseArgs([]);
  assert.strictEqual(options.apply, false);
  assert.strictEqual(options.undo, false);
}

// Deliberate dogfood: this test spawns the real CLI, which resolves
// eligibility (createEligibility/VCS status) against `--cwd`. That path is
// only exercised meaningfully under a real repo working tree — an
// untracked-ancestor fixture is part of what's under test here — so this
// one test keeps the repo-cwd fixture rather than moving to os.tmpdir().
function testCliDefaultLeavesDigestUntouched() {
  const dir = tempDir();
  try {
    const sentinel = path.join(dir, 'store-digest-sentinel');
    fs.writeFileSync(sentinel, 'the store must not be touched by preview');
    const before = digest(sentinel);
    const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'forge-sweep-curate.js'), '--cwd', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(digest(sentinel), before);
  } finally { removeDir(dir); }
}

// The next checks deliberately exercise public-facing parsing and plan seams
// separately.  They make regressions in an otherwise successful apply easier
// to diagnose than one broad end-to-end assertion would.
//
// Fixture construction is intentionally explicit throughout this file:
// storage keys are strings, while paths are temporary local files.
// This preserves the distinction tested by the compound-address cases.
// A real store parser is covered by forge-memory-rewrite's paired tests;
// these tests focus on curatorial orchestration and its safety ordering.
// No fixture is retained after a test exits, including on assertion failure.
// The journal and vault seams make write ordering observable without using
// the repository's own ignored .gsd directory as a test artifact.
// That isolation also means the runner can execute suites in any order.
// The static source check is a guard against accidental second writers.
// It is deliberately small enough not to prescribe harmless code layout.
// Future tests should add a behavioral assertion before expanding it.
// The command remains dry-run unless apply is explicitly requested.
// A non-TTY apply remains a confirmation refusal without --yes.
// Undo follows the same explicit-confirmation policy.
function testParseConflicts() {
  assert.throws(() => internals.parseArgs(['--apply', '--undo', '--arbitration', 'a.json']));
  assert.throws(() => internals.parseArgs(['--yes']));
  assert.throws(() => internals.parseArgs(['--json', '--apply', '--arbitration', 'a.json']));
}

function testClusterMustBeJudged() {
  const current = plan([
    cluster('first', [item('a', 'MEM001')]),
    cluster('second', [item('b', 'MEM002')]),
  ]);
  const doc = arbitration('first', [verdict('a', 'MEM001', 'manter')]);
  expectReason('unjudged-items', () => curate.validateArbitrationShape(doc, current));
}

function testDuplicateAddressRejected() {
  const current = plan([cluster('c', [item('a', 'MEM001')])]);
  const doc = arbitration('c', [
    verdict('a', 'MEM001', 'manter'),
    verdict('a', 'MEM001', 'fundir-no-sobrevivente'),
  ]);
  expectReason('arbitration-unreadable', () => curate.validateArbitrationShape(doc, current));
}

function testNoTargetsNoVault() {
  const dir = osTempDir();
  try {
    let vaulted = false;
    const ctx = liveContext(dir, [], { clusters: [] }, {
      writeVault: () => { vaulted = true; return { ok: true }; },
    });
    const result = internals.applyCurate(ctx, { clusters: [], targets: [], skipped: [] });
    assert.deepStrictEqual(result.written, []);
    assert.strictEqual(vaulted, false);
  } finally { removeDir(dir); }
}

function testDropsGroupedByStorage() {
  const doc = {
    clusters: [{
      cluster_id: 'c',
      items: [
        verdict('same', 'MEM001', 'manter'),
        verdict('same', 'MEM002', 'fundir-no-sobrevivente'),
        verdict('other', 'MEM003', 'fundir-no-sobrevivente'),
      ],
    }],
  };
  const drops = internals.selectedDrops(doc);
  assert.deepStrictEqual(drops.get('same'), ['MEM002']);
  assert.deepStrictEqual(drops.get('other'), ['MEM003']);
}

function testPhaseBlocked() {
  const dir = osTempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001', 'T01'), item('b', 'MEM002', 'T01')])];
    const result = internals.curatePlan(liveContext(dir, clusters, { clusters: [] }, {
      activeUnits: () => ({ ok: true, units: [{ milestoneId: 'M001', unitId: 'T01' }] }),
    }));
    assert.strictEqual(result.targets.length, 0);
    assert.strictEqual(result.skipped[0].reason, 'active-phase');
  } finally { removeDir(dir); }
}

// R1/R3 regression. A cluster removed by the VCS eligibility filter (a dirty
// fragment anywhere else in the store) must not abort a fully-judged
// arbitration, and must not be written either. Reverting the fix makes the
// first assertion fail with `unknown-cluster`.
function testEligibilityFilteredClusterSkipsWithoutAborting() {
  const dir = tempDir();
  try {
    const clusters = [
      cluster('c1', [item('a', 'MEM001'), item('b', 'MEM002')]),
      cluster('c2', [item('x', 'MEM003'), item('y', 'MEM004')]),
    ];
    const doc = { clusters: [
      { cluster_id: 'c1', items: [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')] },
      { cluster_id: 'c2', items: [verdict('x', 'MEM003', 'manter'), verdict('y', 'MEM004', 'fundir-no-sobrevivente')] },
    ] };
    const calls = [];
    const ctx = liveContext(dir, clusters, doc, { rewriteFragment: (_cwd, request) => { calls.push(request.storageKey); return { ok: true, path: request.storageKey }; } });
    // The CLI fingerprints the unfiltered preliminary plan; mirror that here.
    ctx.planFingerprint = curate.planFingerprint(plan(clusters));
    const unfiltered = plan(clusters);
    const filtered = { targets: unfiltered.targets.filter(target => target.name === 'c1'), skipped: [{ path: 'c2', reason: 'modificado localmente' }] };
    const result = internals.applyCurate(ctx, filtered);
    assert.strictEqual(result.error, undefined);
    assert.deepStrictEqual(calls, ['b']);
    assert(result.skipped.some(entry => entry.path === 'c2' && entry.reason === internals.FILTERED_REASON), 'cluster filtrado deve ser pulado por motivo nomeado');
  } finally { removeDir(dir); }
}

// R3 structural boundary, independent of which plan shape is validated: a drop
// address absent from the eligible set can never reach rewriteFragment.
function testWriteBoundaryConsultsEligibleSetOnly() {
  const dir = tempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]);
    const eligible = internals.eligibleSet({ targets: [] });
    assert.deepStrictEqual(internals.filesForDrops(dir, internals.selectedDrops(doc), eligible), []);
    const calls = [];
    const ctx = liveContext(dir, clusters, doc, { rewriteFragment: (_cwd, request) => { calls.push(request.storageKey); return { ok: true, path: request.storageKey }; } });
    ctx.planFingerprint = curate.planFingerprint(plan(clusters));
    const result = internals.applyCurate(ctx, { targets: [], skipped: [] });
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(result.written, []);
    assert(result.skipped.some(entry => entry.reason === internals.FILTERED_REASON));
  } finally { removeDir(dir); }
}

// ── Post-apply undo (S07) ────────────────────────────────────────────────────
//
// Curation rewrites a fragment IN PLACE, so after a real apply the destination
// always diverges from the vaulted bytes. These fixtures deliberately use the
// REAL vault, the REAL journal and the REAL rewriteFragment, and drive undo by
// spawning the actual CLI: a mocked restoreVault would have reported success
// throughout the entire period the command was inert.
const memoryStore = require('./forge-memory');
const { writeVault } = require('./forge-sweep-vault');
const realJournal = require('./forge-sweep-journal');

// realpathSync is load-bearing on macOS, where os.tmpdir() is a symlink: the
// vault subtracts physical paths to build member ids, so a fixture rooted at
// the symlinked spelling produces ids that escape `.gsd`.
function realStoreDir() { return fs.realpathSync(osTempDir()); }

function fact(memId, text) {
  return { mem_id: memId, category: 'pattern', text, created_at: '2026-08-01T00:00:00.000Z', source_unit: 'execute-task/T01', extra_metadata: '{}' };
}

// A real, canonical two-fact fragment written by the store's own writer, so
// rewriteFragment's canonicity fence passes without a hand-rolled serializer.
function writeRealFragment(cwd, unitId, memIds) {
  memoryStore.writeFragment(cwd, { unit_id: unitId, facts: memIds.map((id, index) => fact(id, `fato ${index} de ${unitId}`)) });
  return path.join(cwd, '.gsd', 'memory', `${unitId}.md`);
}

function realApplyContext(cwd, clusters, doc) {
  return {
    cwd,
    arbitration: doc,
    buildClusters: () => ({ clusters, verdict: 'TARGETS', census: { skipped: [] } }),
    activeUnits: () => ({ ok: true, units: [] }),
  };
}

function runCli(dir, args) {
  const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'forge-sweep-curate.js'), '--cwd', dir].concat(args), { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr, payload: run.stdout.trim() ? JSON.parse(run.stdout) : null };
}

function undoneIds(cwd) {
  return realJournal.listEntries(cwd).entries.filter(entry => entry.phase === 'undo-done').map(entry => entry.id);
}

// The defect this slice closes. Reverting only the caller's opt-in (the third
// argument at the runUndo -> restoreVault call) makes this fail with
// `destination-has-different-bytes` and leaves the post-apply bytes in place.
function testRealApplyThenCliUndoRestoresExactBytes() {
  const dir = realStoreDir();
  try {
    const target = writeRealFragment(dir, 'T02', ['MEM003', 'MEM004']);
    writeRealFragment(dir, 'T01', ['MEM001', 'MEM002']);
    const before = fs.readFileSync(target);

    const clusters = [cluster('c', [item('T01', 'MEM001'), item('T02', 'MEM003')])];
    const doc = arbitration('c', [verdict('T01', 'MEM001', 'manter'), verdict('T02', 'MEM003', 'fundir-no-sobrevivente')]);
    const ctx = realApplyContext(dir, clusters, doc);
    const result = internals.applyCurate(ctx, internals.curatePlan(ctx));

    assert.strictEqual(result.error, undefined, JSON.stringify(result.skipped));
    assert.deepStrictEqual(result.written, [target]);
    assert(!fs.readFileSync(target).equals(before), 'o apply precisa mesmo ter reescrito o fragmento');
    assert(result.authorized.some(id => id.endsWith('memory/T02.md')), 'a autorização nomeia o membro vaultado');

    const undo = runCli(dir, ['--undo', '--yes', '--json']);
    assert.strictEqual(undo.status, 0, `${undo.stderr}${JSON.stringify(undo.payload)}`);
    assert.deepStrictEqual(undo.payload.undo.errors, [], 'nenhuma recusa é aceitável no caminho autorizado');
    assert(!JSON.stringify(undo.payload).includes('destination-has-different-bytes'));
    assert.strictEqual(Buffer.compare(fs.readFileSync(target), before), 0, 'os bytes pré-apply precisam voltar exatos');
    assert.deepStrictEqual(undoneIds(dir), [result.journalId]);
  } finally { removeDir(dir); }
}

// The fence, from the other side: a divergent member the curate apply never
// authorized is reported BY PATH, keeps its current bytes, and blocks the
// undo-done outcome — while the named member is still restored.
function testUndoRefusesDivergentMemberOutsideAuthorization() {
  const dir = realStoreDir();
  try {
    const authorizedFile = writeRealFragment(dir, 'T02', ['MEM003', 'MEM004']);
    const foreignFile = writeRealFragment(dir, 'T01', ['MEM001', 'MEM002']);
    const authorizedBefore = fs.readFileSync(authorizedFile);

    const vault = writeVault(dir, { operation: 'curadoria-semantica', files: [authorizedFile, foreignFile] });
    assert.strictEqual(vault.ok, true);
    const named = vault.members.filter(id => id.endsWith('memory/T02.md'));
    assert.strictEqual(named.length, 1);
    const intent = realJournal.appendIntent(dir, { operation: 'curadoria-semantica', containers: [vault.containerPath] });
    // The production writer, not a fixture literal: the closed set carries the
    // authorized member only, exactly as an apply that vaulted just that file.
    assert.strictEqual(internals.writeAuthorization(dir, vault.containerPath, named).ok, true);

    fs.appendFileSync(authorizedFile, 'divergência autorizada\n');
    fs.appendFileSync(foreignFile, 'divergência não autorizada\n');
    const foreignAfterDivergence = fs.readFileSync(foreignFile);

    const undo = runCli(dir, ['--undo', '--yes', '--json']);
    assert.strictEqual(undo.status, 1, 'uma recusa precisa sair diferente de zero');
    const errors = undo.payload.undo.errors;
    assert.strictEqual(errors.length, 1, JSON.stringify(errors));
    assert(errors[0].includes('T01.md'), `a recusa precisa nomear o alvo: ${errors[0]}`);
    assert(errors[0].includes('destination-not-authorized-for-overwrite'), errors[0]);
    assert.strictEqual(Buffer.compare(fs.readFileSync(foreignFile), foreignAfterDivergence), 0, 'o membro não autorizado nunca é sobrescrito');
    assert.strictEqual(Buffer.compare(fs.readFileSync(authorizedFile), authorizedBefore), 0, 'o membro nomeado é restaurado');
    assert.deepStrictEqual(undoneIds(dir), [], 'undo-done não pode ser gravado com recusa pendente');
    assert(intent.ok);
  } finally { removeDir(dir); }
}

// R1 (S07 review, conceded): a PARTIAL apply must authorize only the members
// whose rewrite could have changed bytes. Here the first member is really
// rewritten and the second is refused by the write boundary WITHOUT throwing
// (`rewrite-failed`, one of the two real per-member skip paths) — a refusal
// that always returns before the atomic write, so those bytes stay untouched.
// The untouched file then receives a legitimate later edit (these are
// forge-memory's live write target). Undo must restore the rewritten member and
// REFUSE the untouched one BY NAME, preserving the edited bytes. With the fix
// reverted (authorizing vault.members up front) the edit is silently clobbered
// and counted in `restored`.
function testPartialApplyAuthorizesOnlyRewrittenMembers() {
  const dir = realStoreDir();
  try {
    writeRealFragment(dir, 'T01', ['MEM001', 'MEM002']);
    const rewritten = writeRealFragment(dir, 'T02', ['MEM003', 'MEM004']);
    const untouched = writeRealFragment(dir, 'T03', ['MEM005', 'MEM006']);
    const rewrittenBefore = fs.readFileSync(rewritten);
    const untouchedBefore = fs.readFileSync(untouched);

    const clusters = [cluster('c', [item('T01', 'MEM001'), item('T02', 'MEM003'), item('T03', 'MEM005')])];
    const doc = arbitration('c', [verdict('T01', 'MEM001', 'manter'), verdict('T02', 'MEM003', 'fundir-no-sobrevivente'), verdict('T03', 'MEM005', 'fundir-no-sobrevivente')]);
    const ctx = realApplyContext(dir, clusters, doc);
    const realRewrite = require('./forge-memory-rewrite').rewriteFragment;
    ctx.rewriteFragment = (cwd, request) => (request.storageKey === 'T03'
      ? { ok: false, path: untouched, reason: 'would-empty-fragment' }
      : realRewrite(cwd, request));
    const result = internals.applyCurate(ctx, internals.curatePlan(ctx));

    assert.strictEqual(result.error, undefined, JSON.stringify(result.skipped));
    assert.deepStrictEqual(result.written, [rewritten]);
    assert(result.skipped.some(entry => entry.reason === 'would-empty-fragment'), JSON.stringify(result.skipped));
    assert(!fs.readFileSync(rewritten).equals(rewrittenBefore), 'o primeiro membro precisa mesmo ter sido reescrito');
    assert.strictEqual(Buffer.compare(fs.readFileSync(untouched), untouchedBefore), 0, 'o membro recusado não pode ter sido tocado pelo apply');
    assert(result.authorized.some(id => id.endsWith('memory/T02.md')), 'o membro reescrito é autorizado');
    assert(!result.authorized.some(id => id.endsWith('memory/T03.md')), `o membro nunca reescrito não pode ficar autorizado: ${JSON.stringify(result.authorized)}`);

    // A legitimate later edit to the member the apply never rewrote.
    fs.appendFileSync(untouched, 'edição legítima posterior\n');
    const untouchedAfterEdit = fs.readFileSync(untouched);

    const undo = runCli(dir, ['--undo', '--yes', '--json']);
    assert.strictEqual(undo.status, 1, `a recusa do membro pulado precisa sair diferente de zero: ${JSON.stringify(undo.payload)}`);
    const errors = undo.payload.undo.errors;
    assert.strictEqual(errors.length, 1, JSON.stringify(errors));
    assert(errors[0].includes('T03.md'), `a recusa precisa nomear o membro pulado: ${errors[0]}`);
    assert(errors[0].includes('destination-not-authorized-for-overwrite'), errors[0]);
    assert.strictEqual(Buffer.compare(fs.readFileSync(untouched), untouchedAfterEdit), 0, 'a edição legítima no membro pulado nunca é atropelada');
    assert(!undo.payload.undo.restored.some(entry => String(entry).includes('T03.md')), 'o membro pulado não pode ser contado como restaurado');
    assert.strictEqual(Buffer.compare(fs.readFileSync(rewritten), rewrittenBefore), 0, 'o membro efetivamente reescrito volta aos bytes pré-apply');
  } finally { removeDir(dir); }
}

// Deny-by-default survives every degradation of the record: absent, malformed,
// written by another operation, or naming a different container. None of these
// is a boolean that opens the whole vault.
function testAuthorizationRecordIsClosedAndDenyByDefault() {
  const dir = realStoreDir();
  try {
    const container = path.join(dir, '.gsd', 'forge', 'sweep-vault', 'curadoria-semantica-1.md');
    fs.mkdirSync(path.dirname(container), { recursive: true });
    fs.writeFileSync(container, 'placeholder');
    assert.deepStrictEqual(internals.authorizedMembers(dir, container), [], 'registro ausente não autoriza nada');

    const record = internals.authorizationPath(dir, container);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    for (const payload of ['{ not json', JSON.stringify({ operation: 'outra', members: ['.gsd/memory/T01.md'], container: 'curadoria-semantica-1.md' }), JSON.stringify({ operation: internals.OPERATION, container: 'outro.md', members: ['.gsd/memory/T01.md'] }), JSON.stringify({ operation: internals.OPERATION, container: 'curadoria-semantica-1.md', members: true })]) {
      fs.writeFileSync(record, payload);
      assert.deepStrictEqual(internals.authorizedMembers(dir, container), [], `registro degradado não autoriza: ${payload}`);
    }

    assert.strictEqual(internals.writeAuthorization(dir, container, ['.gsd/memory/T01.md', '', null]).ok, true);
    assert.deepStrictEqual(internals.authorizedMembers(dir, container), ['.gsd/memory/T01.md']);
  } finally { removeDir(dir); }
}

// The apply must not reach the first rewrite without a durable authorization:
// an interrupted apply with no record is an apply that can never be undone.
function testAuthorizationFailureIsZeroMutation() {
  const dir = osTempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]);
    let rewritten = 0;
    const ctx = liveContext(dir, clusters, doc, {
      writeAuthorization: () => ({ ok: false, error: 'disk full' }),
      rewriteFragment: () => { rewritten += 1; return { ok: true }; },
    });
    const result = internals.applyCurate(ctx, plan(clusters));
    assert.strictEqual(result.error, internals.AUTH_MISSING);
    assert.strictEqual(rewritten, 0);
  } finally { removeDir(dir); }
}

// A later authorization growth must not destroy the last valid record. The
// first member is already rewritten when the staging write for the second is
// truncated and fails; undo must still recover exactly that first member.
function testAuthorizationGrowthFailurePreservesPreviousUndo() {
  const dir = realStoreDir();
  try {
    writeRealFragment(dir, 'T01', ['MEM001', 'MEM002']);
    const first = writeRealFragment(dir, 'T02', ['MEM003', 'MEM004']);
    const second = writeRealFragment(dir, 'T03', ['MEM005', 'MEM006']);
    const firstBefore = fs.readFileSync(first);
    const secondBefore = fs.readFileSync(second);
    const clusters = [cluster('c', [item('T01', 'MEM001'), item('T02', 'MEM003'), item('T03', 'MEM005')])];
    const doc = arbitration('c', [verdict('T01', 'MEM001', 'manter'), verdict('T02', 'MEM003', 'fundir-no-sobrevivente'), verdict('T03', 'MEM005', 'fundir-no-sobrevivente')]);
    const ctx = realApplyContext(dir, clusters, doc);
    const realWrite = internals.writeAuthorization;
    let writes = 0;
    ctx.writeAuthorization = (cwd, container, members) => {
      writes += 1;
      if (writes !== 3) return realWrite(cwd, container, members);
      return realWrite(cwd, container, members, { io: {
        writeFileSync(handle, payload, encoding) {
          fs.writeFileSync(handle, String(payload).slice(0, 12), encoding);
          const error = new Error('injected growth failure');
          error.code = 'ENOSPC';
          throw error;
        },
      } });
    };
    const result = internals.applyCurate(ctx, internals.curatePlan(ctx));

    assert.deepStrictEqual(result.written, [first], JSON.stringify(result));
    assert(result.skipped.some(entry => entry.path === 'T03' && entry.reason.includes(internals.AUTH_MISSING)), JSON.stringify(result.skipped));
    assert(!fs.readFileSync(first).equals(firstBefore), 'o primeiro membro precisa ter sido reescrito antes da falha');
    assert.strictEqual(Buffer.compare(fs.readFileSync(second), secondBefore), 0, 'o segundo rewrite nao pode ocorrer sem autorizacao publicada');
    const authorized = internals.authorizedMembers(dir, result.vault);
    assert.strictEqual(authorized.length, 1, JSON.stringify(authorized));
    assert(authorized[0].endsWith('memory/T02.md'), authorized[0]);

    const undo = runCli(dir, ['--undo', '--yes', '--json']);
    assert.strictEqual(undo.status, 0, `${undo.stderr}${JSON.stringify(undo.payload)}`);
    assert.strictEqual(Buffer.compare(fs.readFileSync(first), firstBefore), 0, 'undo precisa recuperar os bytes exatos do primeiro membro');
    assert.strictEqual(Buffer.compare(fs.readFileSync(second), secondBefore), 0, 'undo nao deve tocar o segundo membro');
  } finally { removeDir(dir); }
}

function main() {
  const tests = [testPartialApplyAuthorizesOnlyRewrittenMembers, testRealApplyThenCliUndoRestoresExactBytes, testUndoRefusesDivergentMemberOutsideAuthorization, testAuthorizationRecordIsClosedAndDenyByDefault, testAuthorizationFailureIsZeroMutation, testAuthorizationGrowthFailurePreservesPreviousUndo,
    testEligibilityFilteredClusterSkipsWithoutAborting, testWriteBoundaryConsultsEligibleSetOnly, testRegistry, testClosedVerdicts, testExactlyOneSurvivor, testUnknownItem, testUnjudgedItems, testUnknownCluster, testCompoundAddress, testFingerprintStableAndSensitive, testPlanChangedZeroMutation, testIntentFailureZeroMutation, testRewriteIsolation, testActivePhaseFailClosed, testArgumentCodes, testNoSecondWriterOrContainers, testDefaultIsDryRun, testCliDefaultLeavesDigestUntouched, testParseConflicts, testClusterMustBeJudged, testDuplicateAddressRejected, testNoTargetsNoVault, testDropsGroupedByStorage, testPhaseBlocked];
  for (const test of tests) test();
  process.stdout.write(`forge-sweep-curate: ${tests.length} tests passed\n`);
}

module.exports = { main, _private: { tempDir, liveContext, plan, cluster, item, arbitration, verdict } };
if (require.main === module) main();
