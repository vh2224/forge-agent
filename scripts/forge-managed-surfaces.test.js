'use strict';
// Temporary-root contract suite for managed-surfaces-v1 (issue 440, S01/T01).
// Every owner, store and journal lives under a fresh os.tmpdir() root that is
// removed in finally. Fixtures are synthetic (label mock); no real data is read.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const surfaces = require('./forge-managed-surfaces');

const CODE_DIR = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'issue-440');
const MODULE = path.join(__dirname, 'forge-managed-surfaces.js');
// sha256 of the canonical declaration text (managed-surfaces-v1). A change here
// is a reviewed declaration change, never a silent update.
const DECLARATION_PIN = '0f78362e0f22b2a4d700865d31a790d688816f5a14a2c6faf6e1130fa7a8eb8f';
const DECLARED_IDS = ['owner-events', 'unit-lease', 'hook-evidence'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const readFixture = name => fs.readFileSync(path.join(FIXTURES, name));
const census = JSON.parse(readFixture('surface-census.json').toString('utf8'));
const deltas = JSON.parse(readFixture('delta-cases.json').toString('utf8'));
const BINDING = Object.freeze({ unit: 'execute-task/T01', run: 'M001', milestone: 'M001', slice: 'S01' });
const ATTEMPT = Object.freeze({ dispatch_id: 'fixture-dispatch-1', ...BINDING, fingerprint: 'a1'.repeat(32),
  recovery_identity_sha256: 'b2'.repeat(32), claim_generation: 3, lease_generation: 'lease-7' });
const writerOf = id => surfaces.getDeclaration().surfaces.find(s => s.id === id).writers[0];
const DIFF_KEYS = new Set(['surface_id', 'operation', 'validator', 'before', 'after', 'kind', 'lines_appended', 'bytes_appended',
  'fields_changed', 'fields_added', 'fields_removed', 'unknown_fields', 'created']);

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-managed-surfaces-'));
  try { return fn(fs.realpathSync.native(dir)); }
  finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
}
// Same file identity, new bytes: open the existing file in place (no recreate).
function overwrite(file, bytes) {
  const fd = fs.openSync(file, 'r+');
  try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, bytes, 0, bytes.length, 0); }
  finally { fs.closeSync(fd); }
}
function removeLink(link) {
  try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
}
function code(fn, expected, label) {
  assert.throws(fn, error => {
    assert.equal(error && error.code, expected, label || expected);
    return true;
  }, label || expected);
}
function sourceOf(relative) { return fs.readFileSync(path.join(CODE_DIR, relative), 'utf8'); }
function definesSymbol(source, symbol) {
  const name = symbol.replace(/\$/g, '\\$');
  return new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(|^\\s*(?:const|let|var)\\s+${name}\\s*=`, 'm').test(source);
}
function deepFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}
function noRealData(text, label) {
  assert(!/[A-Za-z]:\\\\(?:Users|home)\\\\/i.test(text), `${label}: windows profile path`);
  assert(!/\/(?:home|Users)\/[A-Za-z]/.test(text), `${label}: posix profile path`);
  assert(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), `${label}: e-mail`);
}
function leaseBytes(record, compact = false) {
  return Buffer.from(compact ? `${JSON.stringify(record)}\n` : `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
function linesOf(rows) { return Buffer.from(rows.map(row => `${JSON.stringify(row)}\n`).join(''), 'utf8'); }
function bytesOf(repr) {
  if (repr === null) return null;
  if (typeof repr.text === 'string') return Buffer.from(repr.text, 'utf8');
  if (Array.isArray(repr.lines)) return linesOf(repr.lines);
  if (typeof repr.base64 === 'string') return Buffer.from(repr.base64, 'base64');
  if (Array.isArray(repr.concat)) return Buffer.concat(repr.concat.map(bytesOf));
  if (repr.repeat) return Buffer.concat(Array.from({ length: repr.repeat.times }, () => bytesOf(repr.repeat.of)));
  if (repr.lease) {
    const record = { ...deltas.lease_base, ...(repr.lease.set || {}) };
    for (const key of repr.lease.remove || []) delete record[key];
    return leaseBytes(record, repr.lease.compact === true);
  }
  throw new Error('unknown fixture representation');
}

// ── Census against the real call sites of this CODE_DIR ─────────────────────
function censusCallSites() {
  assert.equal(census.label, 'mock');
  assert.equal(census.origin, 'synthetic');
  assert.equal(census.declaration_version, surfaces.VERSION);
  assert.deepEqual(census.routes, [...surfaces.ROUTES]);
  assert.deepEqual(census.process_classes, [...surfaces.PROCESS_CLASSES]);
  const declaration = surfaces.getDeclaration();
  const writersBySurface = new Map(declaration.surfaces.map(s => [s.id, new Set(s.writers)]));
  const declaredWriters = new Set(declaration.surfaces.flatMap(s => s.writers));
  const ids = new Set();
  for (const entry of census.entries) {
    assert(!ids.has(entry.id), `duplicate census entry ${entry.id}`); ids.add(entry.id);
    assert(census.candidates.includes(entry.candidate), entry.id);
    const match = /^(scripts\/[a-z0-9][a-z0-9-]*\.js)#([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(entry.call_site);
    assert(match, `${entry.id}: call site format`);
    assert(fs.existsSync(path.join(CODE_DIR, match[1])), `${entry.call_site}: file`);
    const source = sourceOf(match[1]);
    assert(definesSymbol(source, match[2]), `${entry.call_site}: symbol`);
    assert(typeof entry.path_reference === 'string' && entry.path_reference.length >= 6 && source.includes(entry.path_reference),
      `${entry.call_site}: path or path constructor reference`);
    assert(surfaces.PROCESS_CLASSES.includes(entry.class), `${entry.id}: class`);
    assert.deepEqual(Object.keys(entry.routes).sort(), [...surfaces.ROUTES].sort(), `${entry.id}: routes`);
    for (const value of Object.values(entry.routes)) assert(census.route_observations.includes(value), `${entry.id}: ${value}`);
    assert(typeof entry.surface === 'string' && entry.surface.startsWith('.gsd/'), `${entry.id}: surface`);
    assert(typeof entry.reason === 'string' && entry.reason.length > 20, `${entry.id}: reason`);
    assert(['declared', 'not-declared'].includes(entry.decision), `${entry.id}: decision`);
    if (entry.decision === 'declared') {
      assert(writersBySurface.get(entry.surface_id)?.has(entry.call_site), `${entry.id}: declared writer`);
      assert(['in-scope', 'cross-process'].includes(entry.class), `${entry.id}: declared class`);
      assert(!Object.values(entry.routes).includes('direct-in-window'), `${entry.id}: unfenced cross-process writer`);
    } else {
      assert.equal(entry.surface_id, null, entry.id);
      assert(!declaredWriters.has(entry.call_site), `${entry.call_site} must not be a declared writer`);
    }
    if (entry.observed_by !== 'static') {
      const suite = /^static\+suite:(scripts\/[a-z0-9.-]+\.js)#([a-z0-9-]+)$/.exec(entry.observed_by);
      assert(suite, `${entry.id}: observed_by`);
      assert(sourceOf(suite[1]).includes(`'${suite[2]}'`), `${entry.observed_by}: named suite case`);
    }
  }
  for (const surface of declaration.surfaces) {
    for (const writer of surface.writers) {
      assert(census.entries.some(e => e.decision === 'declared' && e.surface_id === surface.id && e.call_site === writer), `${writer}: census decision`);
    }
    if (surface.attestation) {
      const [file, symbol] = surface.attestation.split('#');
      assert(definesSymbol(sourceOf(file), symbol), `${surface.attestation}: attestation symbol`);
    }
  }
  for (const entry of census.entries.filter(e => e.decision === 'declared')) assert(DECLARED_IDS.includes(entry.surface_id));
  for (const candidate of ['state-heartbeat', 'owner-events', 'evidence', 'unit-lease', 'controller-records', 'runs-auto-mode',
    'locks', 'time-journal', 'questions', 'prefs-error']) {
    assert(census.entries.some(e => e.candidate === candidate), `candidate ${candidate}`);
  }
  // STATE enters only with a proven in-scope writer (DS5): none is declared.
  assert(census.entries.filter(e => e.candidate === 'state-heartbeat').every(e => e.decision === 'not-declared'));
  const findingSites = census.findings.map(f => f.call_site);
  for (const site of ['scripts/forge-hook.js#appendRewriteEvent', 'scripts/forge-hook.js#appendPrefsBlockedEvent', 'scripts/forge-state.js#cliMain']) {
    assert(findingSites.includes(site), `finding ${site}`);
    assert(!declaredWriters.has(site), `${site} declared`);
  }
  for (const finding of census.findings) {
    assert.equal(finding.code, 'census-cross-process-writer-unattributable');
    assert.equal(finding.class, 'cross-process');
    const entry = census.entries.find(e => e.call_site === finding.call_site);
    assert(entry && entry.decision === 'not-declared' && entry.class === 'cross-process', finding.call_site);
    assert(Object.values(entry.routes).includes('direct-in-window'), finding.call_site);
  }
  for (const entry of census.entries) {
    if (Object.values(entry.routes).includes('direct-in-window')) assert(findingSites.includes(entry.call_site), `${entry.id}: finding missing`);
  }
  for (const row of census.sources) {
    assert(/^[a-f0-9]{64}$/.test(row.sha256), row.file);
    assert(fs.existsSync(path.join(CODE_DIR, row.file)), row.file);
  }
  noRealData(JSON.stringify(census), 'surface-census.json');
  noRealData(JSON.stringify(deltas), 'delta-cases.json');
}

function fixtureReadme() {
  const readme = readFixture('README.md').toString('utf8');
  assert(/\bmock\b/.test(readme) && /\bsynthetic\b/.test(readme), 'README label/origin');
  for (const name of ['surface-census.json', 'delta-cases.json']) {
    assert(readme.includes(sha(readFixture(name))), `README sha256 of ${name}`);
  }
}

// ── protectedSnapshot pin consumed by T02 ────────────────────────────────────
function snapshotPin() {
  const execution = require('./forge-task-execution');
  const source = execution.protectedSnapshot.toString();
  assert.equal(sha(source), census.protected_snapshot_pin.sha256, 'protectedSnapshot source changed');
  assert.equal(census.protected_snapshot_pin.entry_limit, 20000);
  assert(source.includes('++entries > 20000'), 'entry limit');
  assert.equal(census.protected_snapshot_pin.symbol, 'scripts/forge-task-execution.js#protectedSnapshot');
}

// ── Declaration, digest pin and version refusal ─────────────────────────────
function declarationPin() {
  const declaration = surfaces.getDeclaration();
  assert.equal(surfaces.declarationDigest(), DECLARATION_PIN);
  assert.equal(surfaces.getDeclaration(surfaces.VERSION), declaration);
  assert(deepFrozen(declaration), 'deep freeze');
  assert.throws(() => { declaration.surfaces[0].writers.push('scripts/forge-hook.js#appendRewriteEvent'); }, TypeError);
  assert.throws(() => { declaration.surfaces.push({}); }, TypeError);
  assert.deepEqual(declaration.surfaces.map(s => s.id), DECLARED_IDS);
  for (const version of ['managed-surfaces-v2', 'managed-surfaces-v0', '', null, 1]) {
    code(() => surfaces.getDeclaration(version), 'managed-surface-version-unknown', `getDeclaration ${version}`);
    code(() => surfaces.declarationDigest(version), 'managed-surface-version-unknown', `declarationDigest ${version}`);
  }
  // Schema compliance grants nothing: only the frozen module instance is accepted.
  const copy = JSON.parse(JSON.stringify(declaration));
  code(() => surfaces.assertDeclaration(copy), 'managed-surface-attribution-forged');
  code(() => surfaces.assertDeclaration({ ...copy, extra: true }), 'managed-surface-undeclared');
  code(() => surfaces.assertDeclaration({ ...copy, version: 'managed-surfaces-v2' }), 'managed-surface-version-unknown');
  const withField = JSON.parse(JSON.stringify(declaration)); withField.surfaces[0].authority = 'granted';
  code(() => surfaces.assertDeclaration(withField), 'managed-surface-undeclared');
  const withWriter = JSON.parse(JSON.stringify(declaration)); withWriter.surfaces[0].writers.push('scripts/forge-hook.js#appendRewriteEvent');
  code(() => surfaces.assertDeclaration(withWriter), 'managed-surface-attribution-forged');
  assert.equal(surfaces.assertDeclaration(declaration), declaration);
  for (const s of declaration.surfaces) {
    assert(typeof s.id === 'string' && s.version === 1, s.id);
    assert((s.path === null) !== (s.pattern === null), `${s.id}: path xor pattern`);
    if (s.path) assert(s.path.startsWith('.gsd/'), s.id);
    else assert(s.pattern.startsWith('^\\.gsd/') && s.pattern.endsWith('$'), `${s.id}: anchored pattern`);
    assert(surfaces.OPERATIONS.includes(s.operation), s.id);
    assert(surfaces.CAPABILITIES.includes(s.capability), s.id);
    assert(/^[a-z-]+-v1$/.test(s.validator), s.id);
    assert(Array.isArray(s.mutable_fields) && Array.isArray(s.writers) && s.writers.length, s.id);
  }
  assert.deepEqual([...surfaces.getDeclaration().surfaces.find(s => s.id === 'unit-lease').mutable_fields], ['heartbeat_at', 'expires_at']);
  assert.equal(surfaces.surfacePath('owner-events', BINDING), '.gsd/forge/events.jsonl');
  const leaseApi = require('./forge-unit-lease');
  assert.equal(surfaces.surfacePath('unit-lease', BINDING), `.gsd/forge/leases/${path.basename(leaseApi.leaseFile(CODE_DIR, 'execute-task/T01'))}`);
  assert.equal(surfaces.surfacePath('hook-evidence', BINDING), '.gsd/forge/evidence~M001~S01~T01.jsonl');
  code(() => surfaces.surfacePath('state-heartbeat', BINDING), 'managed-surface-undeclared');
  code(() => surfaces.surfacePath('owner-events', { ...BINDING, unit: '../T01' }), 'managed-surface-baseline-unbound');
  code(() => surfaces.surfacePath('owner-events', { ...BINDING, extra: 1 }), 'managed-surface-baseline-unbound');
  code(() => surfaces.surfacePath('owner-events', { ...BINDING, milestone: 'M001/..' }), 'managed-surface-baseline-unbound');
  // Standalone task: canonical global task id with explicit null milestone/slice.
  const TASK = 'T-20261008120000-fixture', STANDALONE = Object.freeze({ unit: `execute-task/${TASK}`, run: 'native-run', milestone: null, slice: null });
  assert.equal(surfaces.surfacePath('owner-events', STANDALONE), '.gsd/forge/events.jsonl');
  assert.equal(surfaces.surfacePath('hook-evidence', STANDALONE),
    `.gsd/forge/${require('./forge-evidence-path').buildEvidenceFileName({ milestone: null, slice: null, unit: TASK })}`);
  assert(surfaces.surfacePath('hook-evidence', STANDALONE).includes('~_no-milestone_~_no-slice_~'), 'canonical sentinels');
  const standaloneAttempt = { dispatch_id: 'fixture-dispatch-1', ...STANDALONE };
  for (const bad of [
    { milestone: 'M001' }, { slice: 'S01' },                       // mixed scope
    { milestone: undefined }, { slice: undefined },                 // absent is never null
    { unit: 'execute-task/T01' },                                   // milestone-style task id with null scope
    { unit: 'execute-task/T-bad' }, { unit: `execute-task/${TASK}/x` }, { unit: 'plan-slice/T-20261008120000-fixture' }, { unit: '../x' },
    { run: '' }, { run: '../x' },
  ]) {
    const binding = { ...STANDALONE, ...bad };
    for (const key of Object.keys(bad)) if (bad[key] === undefined) delete binding[key];
    code(() => surfaces.surfacePath('owner-events', binding), 'managed-surface-baseline-unbound', JSON.stringify(bad));
  }
  // A global task id never binds a milestone attempt; a milestone unit never binds the null form.
  code(() => surfaces.surfacePath('owner-events', { ...BINDING, unit: `execute-task/${TASK}` }), 'managed-surface-baseline-unbound');
  // Full-row negatives: partial/forged scope and a cross-attempt row never verify.
  const row = surfaces.createAttributionRow({ attempt: { ...standaloneAttempt, fingerprint: 'a1'.repeat(32), recovery_identity_sha256: 'b2'.repeat(32),
    claim_generation: 1, lease_generation: null }, sequence: 1, previous_row_sha256: null, surface_id: 'owner-events',
  writer: writerOf('owner-events'), before: null, after: Buffer.from('{"a":1}\n'), baseline_sha256: sha('baseline') });
  assert.equal(row.attempt.milestone, null); assert.equal(row.attempt.slice, null); assert.equal(row.attempt.lease_generation, null);
  const expected = { ...row.attempt };
  assert.equal(surfaces.validateAttributionRow(row, { attempt: expected }).ok, true);
  for (const changed of [{ milestone: 'M001' }, { slice: 'S01' }, { unit: 'execute-task/T-20261008120001-other' }, { run: 'other-run' },
    { dispatch_id: 'other-dispatch' }, { lease_generation: 'lease-1' }]) {
    const verdict = surfaces.validateAttributionRow({ ...row, attempt: { ...row.attempt, ...changed } }, { attempt: expected });
    assert.equal(verdict.ok, false, JSON.stringify(changed));
    // A mixed scope is an invalid row; every other change is a foreign attempt.
    assert.equal(verdict.reason_code, 'milestone' in changed || 'slice' in changed ? 'managed-surface-attribution-forged'
      : 'managed-surface-attribution-foreign', JSON.stringify(changed));
  }
  for (const missing of ['milestone', 'slice', 'lease_generation', 'claim_generation']) {
    const attempt = { ...expected }; delete attempt[missing];
    code(() => surfaces.createAttributionRow({ attempt, sequence: 1, previous_row_sha256: null, surface_id: 'owner-events',
      writer: writerOf('owner-events'), before: null, after: Buffer.from('{"a":1}\n'), baseline_sha256: sha('baseline') }), 'managed-surface-baseline-unbound', missing);
  }
}

function cliList() {
  const run = args => spawnSync(process.execPath, [MODULE, ...args], { cwd: CODE_DIR, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const lastJson = text => JSON.parse(text.trim().split('\n').pop());
  for (const args of [['--list'], ['--list', '--version', 'managed-surfaces-v1']]) {
    const ok = run(args);
    assert.equal(ok.status, 0, ok.stderr);
    const listed = JSON.parse(ok.stdout);
    assert.equal(listed.version, surfaces.VERSION);
    assert.equal(listed.declaration_digest, DECLARATION_PIN);
    assert.deepEqual(listed.surfaces.map(s => s.id), DECLARED_IDS);
    assert(listed.never_declared.includes('questions') && listed.never_declared.includes('transactions'));
  }
  const unknown = run(['--list', '--version', 'managed-surfaces-v2']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, '');
  assert.equal(lastJson(unknown.stderr).reason_code, 'managed-surface-version-unknown');
  for (const args of [[], ['--list', '--bogus'], ['--write']]) {
    const usage = run(args);
    assert.equal(usage.status, 2, args.join(' '));
    assert.equal(lastJson(usage.stderr).reason_code, 'managed-surface-store-invalid');
  }
}

// ── Named transition cases ───────────────────────────────────────────────────
function deltaCases() {
  assert.equal(deltas.label, 'mock');
  assert.equal(deltas.origin, 'synthetic');
  const names = new Set(), codes = new Set(), okSurfaces = new Set(), refusedSurfaces = new Set();
  for (const row of deltas.cases) {
    assert(/^[a-z0-9-]+$/.test(row.name) && !names.has(row.name), `case name ${row.name}`); names.add(row.name);
    const result = surfaces.validateTransition(row.ref, bytesOf(row.before), bytesOf(row.after), { binding: deltas.binding });
    assert.equal(result.ok, row.expect.ok, `${row.name}: ok (${result.reason_code})`);
    assert.equal(result.reason_code, row.expect.reason_code, `${row.name}: reason_code`);
    if (row.expect.diagnostic) assert.equal(result.diagnostic, row.expect.diagnostic, `${row.name}: specific diagnostic`);
    for (const [key, value] of Object.entries(row.expect.diff || {})) assert.deepEqual(result.diff[key], value, `${row.name}: diff.${key}`);
    if (result.diff) {
      assert(deepFrozen(result.diff), `${row.name}: frozen diff`);
      for (const key of Object.keys(result.diff)) assert(DIFF_KEYS.has(key), `${row.name}: diff key ${key}`);
    }
    if (row.expect.reason_code) codes.add(row.expect.reason_code);
    if (typeof row.ref === 'string') (row.expect.ok ? okSurfaces : refusedSurfaces).add(row.ref);
  }
  for (const reason of ['managed-surface-append-rewrite', 'managed-surface-append-invalid', 'managed-surface-read-limit',
    'managed-surface-field-unknown', 'managed-surface-field-immutable', 'managed-surface-field-immutable',
    'managed-surface-create-conflict', 'managed-surface-field-unknown', 'managed-surface-read-limit', 'managed-surface-undeclared']) {
    assert(codes.has(reason), `delta-cases cover ${reason}`);
  }
  for (const id of DECLARED_IDS) assert(okSurfaces.has(id) && refusedSurfaces.has(id), `delta-cases cover ${id}`);
  for (const reason of codes) assert(surfaces.REASON_CODES.includes(reason), reason);
  const bad = surfaces.validateTransition('owner-events', 'not-a-buffer', null);
  assert.equal(bad.reason_code, 'managed-surface-store-invalid');
  code(() => surfaces.sanitizedDiff('state-heartbeat', null, null), 'managed-surface-undeclared');
}

// ── Diffs never carry values or content ──────────────────────────────────────
function sanitizedDiffPrivate() {
  const secret = 'sk-live-FIXTURESECRET-0123456789';
  const personal = 'C:\\Users\\fixture-person\\private\\notes.txt';
  const posix = '/home/fixture-person/private/notes.txt';
  const markers = ['FIXTURESECRET', 'fixture-person', 'private', 'notes.txt', 'Users', 'home', 'sk-live'];
  const clean = (diff, label) => {
    const text = JSON.stringify(diff);
    for (const marker of markers) assert(!text.includes(marker), `${label}: ${marker} leaked`);
    for (const key of Object.keys(diff)) assert(DIFF_KEYS.has(key), `${label}: key ${key}`);
  };
  const events = linesOf([{ event: 'a' }]);
  const appended = Buffer.concat([events, linesOf([{ token: secret, file: personal, other: posix }])]);
  const ok = surfaces.validateTransition('owner-events', events, appended);
  assert.equal(ok.ok, true);
  clean(ok.diff, 'owner-events append');
  clean(surfaces.sanitizedDiff('owner-events', events, Buffer.from(`${secret}${personal}\n`)), 'owner-events rewrite');
  clean(surfaces.sanitizedDiff('hook-evidence', null, linesOf([{ cmd: `cat ${personal}`, file: posix, key: secret }])), 'hook-evidence');
  clean(surfaces.sanitizedDiff('owner-events', events, Buffer.concat([events, Buffer.from(`${secret} ${posix}\n`)])), 'invalid line');
  const base = deltas.lease_base;
  const unknown = surfaces.validateTransition('unit-lease', leaseBytes(base), leaseBytes({ ...base, [secret]: personal }), { binding: BINDING });
  assert.equal(unknown.reason_code, 'managed-surface-field-unknown');
  assert.equal(unknown.diff.unknown_fields.count, 1);
  assert.deepEqual(unknown.diff.unknown_fields.sha256_12, [sha(secret).slice(0, 12)]);
  clean(unknown.diff, 'lease unknown field');
  const immutable = surfaces.validateTransition('unit-lease', leaseBytes(base), leaseBytes({ ...base, owner_token: secret, session: personal }), { binding: BINDING });
  assert.equal(immutable.reason_code, 'managed-surface-field-immutable');
  assert.deepEqual(immutable.diff.fields_changed, ['owner_token', 'session']);
  clean(immutable.diff, 'lease immutable');
  clean(surfaces.sanitizedDiff({ validator: 'exclusive-create-v1', limits: { max_bytes: 1024 } }, null, Buffer.from(secret + posix)), 'create');
}

// ── Windows path normalization and attempt binding ──────────────────────────
function windowsPaths() {
  const leaseApi = require('./forge-unit-lease');
  const leaseName = path.basename(leaseApi.leaseFile(CODE_DIR, 'execute-task/T01'));
  const otherLease = path.basename(leaseApi.leaseFile(CODE_DIR, 'execute-task/T02'));
  const refusals = {
    'backslash': '.gsd\\forge\\events.jsonl',
    'dot-dot': '.gsd/forge/../forge/events.jsonl',
    'dot-segment': '.gsd/./forge/events.jsonl',
    'absolute-posix': '/.gsd/forge/events.jsonl',
    'absolute-unc': '//server/share/.gsd/forge/events.jsonl',
    'absolute-drive': 'C:/owner/.gsd/forge/events.jsonl',
    'drive-relative': 'C:.gsd/forge/events.jsonl',
    'nul': '.gsd/forge/events.jsonl\u0000',
    'control-bell': '.gsd/forge/ev\u0007ents.jsonl',
    'newline': '.gsd/forge/events.jsonl\n',
    'delete-char': '.gsd/forge/events\u007f.jsonl',
    'ads-stream': '.gsd/forge/events.jsonl:secret',
    'ads-data': '.gsd/forge/events.jsonl::$DATA',
    'trailing-dot': '.gsd/forge/events.jsonl.',
    'trailing-space': '.gsd/forge/events.jsonl ',
    'trailing-dot-directory': '.gsd/forge./events.jsonl',
    'reserved-con': '.gsd/forge/CON',
    'reserved-nul-extension': '.gsd/forge/nul.jsonl',
    'reserved-aux': '.gsd/AUX.md',
    'reserved-com1': '.gsd/forge/COM1.json',
    'reserved-lpt1': '.gsd/forge/lpt1',
    'reserved-conin': '.gsd/forge/CONIN$',
    'short-name-alias': '.gsd/forge/EVENTS~1.JSO',
    'empty': '',
    'double-slash': '.gsd//forge/events.jsonl',
    'trailing-slash': '.gsd/forge/',
    'wildcard': '.gsd/forge/*.jsonl',
    'nfd-unicode': '.gsd/forge/cafe\u0301.md',
    'not-string': 42,
  };
  for (const [name, value] of Object.entries(refusals)) {
    code(() => surfaces.normalizeRelative(value), 'managed-surface-path-invalid', `normalizeRelative ${name}`);
    code(() => surfaces.resolveSurface(value, BINDING), 'managed-surface-path-invalid', `resolveSurface ${name}`);
  }
  const aliases = {
    'gsd-root-case': '.GSD/forge/events.jsonl',
    'events-case': '.gsd/forge/EVENTS.jsonl',
    'directory-case': '.gsd/Forge/events.jsonl',
    'lease-hex-case': `.gsd/forge/leases/${leaseName.replace('.json', '').toUpperCase()}.json`,
    'evidence-case': '.gsd/forge/Evidence~M001~S01~T01.jsonl',
  };
  for (const [name, value] of Object.entries(aliases)) code(() => surfaces.resolveSurface(value, BINDING), 'managed-surface-path-invalid', `alias ${name}`);
  for (const id of DECLARED_IDS) {
    const exact = surfaces.surfacePath(id, BINDING), resolved = surfaces.resolveSurface(exact, BINDING);
    assert.equal(resolved.surface_id, id);
    assert.equal(resolved.path, exact);
  }
  const neverDeclared = ['.gsd/continue.md', '.gsd/milestones/M001/continue.md', '.gsd/milestones/M001/M001-CONTEXT.md',
    '.gsd/milestones/M001/slices/S01/S01-CONTEXT.md', '.gsd/tasks/T01/T01-BRIEF.md', '.gsd/HANDOFF.md', '.gsd/HANDOFF-fixture.md',
    '.gsd/sessions/fixture-session.md', '.gsd/forge/questions/fixture.json', '.gsd/forge/questions/fixture.origin.json',
    '.gsd/forge/time/M001/contract.json', '.gsd/forge/time/M001/options/curta.json', '.gsd/forge/time/M001/selection.json',
    '.gsd/forge/time/M001/enrollment.json', '.gsd/forge/transactions/transaction-v1-fixture.json', '.gsd/forge/results/result-v1-fixture.json',
    '.gsd/forge/boundaries/boundary-v1-fixture.json', '.gsd/milestones/M001/slices/S01/S01-PLAN.md',
    '.gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md', '.gsd/milestones/M001/slices/S01/tasks/T01/T01-SUMMARY.md',
    '.gsd/tasks/T01/T01-PLAN.md', '.gsd/CODING-STANDARDS.md'];
  const patterns = surfaces.getDeclaration().surfaces.filter(s => s.pattern).map(s => new RegExp(s.pattern));
  for (const file of neverDeclared) {
    assert.equal(surfaces.resolveSurface(file, BINDING), null, file);
    assert(surfaces.NEVER_DECLARED.some(row => row.regex.test(file)), `${file}: NEVER_DECLARED`);
    assert(!patterns.some(regex => regex.test(file)), `${file}: matched a declared pattern`);
  }
  const arbitrary = ['src/index.js', 'README.md', '.gsd/STATE.md', '.gsd/milestones/M001/M001-STATE.md', '.gsd/forge/runs/M001.json',
    '.gsd/forge/auto-mode.json', '.gsd/forge/prefs-error.json', '.gsd/forge/time/M001/journal.jsonl', '.gsd/.locks/state-M001/metadata.json',
    '.gsd/milestones/M001/M001-events.jsonl', '.gsd/worker-untrusted.md'];
  for (const file of arbitrary) assert.equal(surfaces.resolveSurface(file, BINDING), null, file);
  const siblings = ['.gsd/forge/events.jsonl.bak', '.gsd/forge/events.jsonl.tmp', '.gsd/forge/events.json', '.gsd/forge/events.jsonl.1',
    '.gsd/forge/old/events.jsonl', '.gsd/events.jsonl', `.gsd/forge/leases/${leaseName}.released-fixture`, `.gsd/forge/leases/.${leaseName}.123.fixture.tmp`,
    `.gsd/forge/leases/sub/${leaseName}`, '.gsd/forge/evidence~M001~S01~T01.jsonl.bak', '.gsd/forge/evidence-M001-T01.jsonl',
    '.gsd/forge/evidence~M001~S01~T01~extra.jsonl', '.gsd/forge/sub/evidence~M001~S01~T01.jsonl'];
  for (const file of siblings) {
    assert.equal(surfaces.resolveSurface(file, BINDING), null, file);
    assert(!patterns.some(regex => regex.test(file)), `${file}: sibling matched a declared pattern`);
  }
  // Another attempt's files match the pattern but are not this attempt's surface.
  for (const file of [`.gsd/forge/leases/${otherLease}`, '.gsd/forge/evidence~M001~S01~T02.jsonl', '.gsd/forge/evidence~M002~S01~T01.jsonl']) {
    assert.equal(surfaces.resolveSurface(file, BINDING), null, file);
  }
  code(() => surfaces.resolveSurface('.gsd/forge/events.jsonl', { ...BINDING, slice: 'S1/..' }), 'managed-surface-baseline-unbound');
  code(() => surfaces.resolveSurface('.gsd/forge/events.jsonl', null), 'managed-surface-baseline-unbound');
}

// ── Physical owner targets: links, junctions, hardlinks, case and limits ────
function physicalLinks() {
  withTemp(dir => {
    const owner = path.join(dir, 'owner');
    fs.mkdirSync(path.join(owner, '.gsd', 'forge'), { recursive: true });
    const events = path.join(owner, '.gsd', 'forge', 'events.jsonl');
    fs.writeFileSync(events, '{"event":"a"}\n');
    assert(surfaces.readSurface(owner, 'owner-events', BINDING).equals(Buffer.from('{"event":"a"}\n')));
    assert.equal(surfaces.readSurface(owner, 'hook-evidence', BINDING), null);
    assert.equal(surfaces.readSurface(owner, 'unit-lease', BINDING), null);
    // fixture hardlinked-leaf
    const twin = path.join(dir, 'twin.jsonl');
    fs.linkSync(events, twin);
    code(() => surfaces.readSurface(owner, 'owner-events', BINDING), 'managed-surface-path-invalid', 'hardlinked-leaf');
    fs.unlinkSync(twin);
    assert(surfaces.readSurface(owner, 'owner-events', BINDING));
    // fixture junction-component
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(path.join(outside, 'forge'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'forge', 'events.jsonl'), '{"event":"x"}\n');
    const aliased = path.join(dir, 'aliased-owner');
    fs.mkdirSync(aliased);
    fs.symlinkSync(outside, path.join(aliased, '.gsd'), 'junction');
    try { code(() => surfaces.readSurface(aliased, 'owner-events', BINDING), 'managed-surface-path-invalid', 'junction-component'); }
    finally { removeLink(path.join(aliased, '.gsd')); }
    // fixture file-symlink-leaf (creating it may need a Windows privilege)
    const leafOwner = path.join(dir, 'leaf-owner');
    fs.mkdirSync(path.join(leafOwner, '.gsd', 'forge'), { recursive: true });
    let linked = false;
    try { fs.symlinkSync(path.join(outside, 'forge', 'events.jsonl'), path.join(leafOwner, '.gsd', 'forge', 'events.jsonl'), 'file'); linked = true; }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; console.log(`SKIP physical-links file-symlink-leaf: ${error.code} creating the fixture link`); }
    if (linked) code(() => surfaces.readSurface(leafOwner, 'owner-events', BINDING), 'managed-surface-path-invalid', 'file-symlink-leaf');
    // fixture escape and relative owner
    code(() => surfaces.physicalTarget(owner, '../escape.jsonl'), 'managed-surface-path-invalid', 'escape');
    code(() => surfaces.physicalTarget('relative-owner', '.gsd/forge/events.jsonl'), 'managed-surface-path-invalid', 'relative-owner');
    code(() => surfaces.physicalTarget(owner, '.gsd/forge/events.jsonl/child'), 'managed-surface-path-invalid', 'file-as-directory');
    // fixture on-disk-case-alias (Windows semantics; case-sensitive volumes simply miss the file)
    const caseOwner = path.join(dir, 'case-owner');
    fs.mkdirSync(path.join(caseOwner, '.gsd', 'forge'), { recursive: true });
    fs.writeFileSync(path.join(caseOwner, '.gsd', 'forge', 'Events.jsonl'), '{"event":"a"}\n');
    if (process.platform === 'win32') code(() => surfaces.readSurface(caseOwner, 'owner-events', BINDING), 'managed-surface-path-invalid', 'on-disk-case-alias');
    else if (process.platform === 'linux') assert.equal(surfaces.readSurface(caseOwner, 'owner-events', BINDING), null);
    // fixture surface-size-limit (named per surface: hook-evidence max_bytes)
    const evidence = path.join(owner, '.gsd', 'forge', 'evidence~M001~S01~T01.jsonl');
    const limit = surfaces.getDeclaration().surfaces.find(s => s.id === 'hook-evidence').limits.max_bytes;
    fs.writeFileSync(evidence, Buffer.alloc(limit + 1, 0x61));
    code(() => surfaces.readSurface(owner, 'hook-evidence', BINDING), 'managed-surface-read-limit', 'surface-size-limit');
  });
}

// ── Exclusive preimage store ─────────────────────────────────────────────────
function preimageStore() {
  withTemp(dir => {
    const store = path.join(dir, 'store'), a = Buffer.from('{"event":"a"}\n');
    const first = surfaces.retainPreimage(store, a);
    assert.equal(first.created, true);
    assert.equal(first.sha256, sha(a));
    const again = surfaces.retainPreimage(store, a);
    assert.equal(again.created, false);
    assert.equal(again.sha256, first.sha256);
    assert(surfaces.readPreimage(store, sha(a)).equals(a));
    const empty = surfaces.retainPreimage(store, Buffer.alloc(0));
    assert(surfaces.readPreimage(store, empty.sha256).equals(Buffer.alloc(0)));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(store, 'preimages', sha(a))).mode & 0o777, 0o600);
    // fixture tampered-preimage
    const b = Buffer.from('{"event":"b"}\n');
    fs.writeFileSync(path.join(store, 'preimages', sha(b)), 'tampered\n');
    code(() => surfaces.retainPreimage(store, b), 'managed-surface-preimage-conflict', 'tampered-preimage retain');
    code(() => surfaces.readPreimage(store, sha(b)), 'managed-surface-preimage-conflict', 'tampered-preimage read');
    code(() => surfaces.readPreimage(store, sha('never-retained')), 'managed-surface-preimage-missing');
    code(() => surfaces.readPreimage(path.join(dir, 'absent-store'), sha(a)), 'managed-surface-preimage-missing');
    code(() => surfaces.readPreimage(store, 'not-a-digest'), 'managed-surface-store-invalid');
    // fixture hardlinked-preimage
    const outsideLink = path.join(dir, 'preimage-twin');
    fs.linkSync(path.join(store, 'preimages', sha(a)), outsideLink);
    code(() => surfaces.retainPreimage(store, a), 'managed-surface-store-invalid', 'hardlinked-preimage retain');
    code(() => surfaces.readPreimage(store, sha(a)), 'managed-surface-store-invalid', 'hardlinked-preimage read');
    fs.unlinkSync(outsideLink);
    assert(surfaces.readPreimage(store, sha(a)).equals(a));
    // fixture junction-store-root
    const realStore = path.join(dir, 'real-store'), aliasStore = path.join(dir, 'alias-store');
    fs.mkdirSync(realStore);
    fs.symlinkSync(realStore, aliasStore, 'junction');
    try { code(() => surfaces.retainPreimage(aliasStore, a), 'managed-surface-store-invalid', 'junction-store-root'); }
    finally { removeLink(aliasStore); }
    // fixture junction-preimages-directory
    const store2 = path.join(dir, 'store2'), elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(store2); fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(store2, 'preimages'), 'junction');
    try { code(() => surfaces.retainPreimage(store2, a), 'managed-surface-store-invalid', 'junction-preimages-directory'); }
    finally { removeLink(path.join(store2, 'preimages')); }
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    code(() => surfaces.retainPreimage('relative-store', a), 'managed-surface-store-invalid');
    code(() => surfaces.retainPreimage(store, 'text'), 'managed-surface-store-invalid');
  });
}

// ── Attribution rows, journal prefix and chain verification ─────────────────
function chainFixture(store) {
  const e0 = linesOf([{ event: 'a' }]), e1 = Buffer.concat([e0, linesOf([{ event: 'b' }])]), e2 = Buffer.concat([e1, linesOf([{ event: 'c' }])]);
  const l0 = leaseBytes(deltas.lease_base), l1 = leaseBytes({ ...deltas.lease_base, heartbeat_at: 2000, expires_at: 32000 });
  const h1 = linesOf([{ ts: 1, tool: 'Write', ok: true }]);
  const paths = { events: surfaces.surfacePath('owner-events', BINDING), lease: surfaces.surfacePath('unit-lease', BINDING), hook: surfaces.surfacePath('hook-evidence', BINDING) };
  const S0 = { '.gsd/': 'directory', '.gsd/forge/': 'directory', [paths.events]: sha(e0), [paths.lease]: sha(l0) };
  const baseline = surfaces.snapshotDigest(S0);
  if (store) for (const bytes of [e0, e1, l0]) surfaces.retainPreimage(store, bytes);
  const rows = [];
  const add = (surfaceId, before, after) => {
    const row = surfaces.createAttributionRow({ attempt: ATTEMPT, sequence: rows.length + 1,
      previous_row_sha256: rows.length ? surfaces.attributionRowDigest(rows[rows.length - 1]) : null,
      surface_id: surfaceId, writer: writerOf(surfaceId), before, after, baseline_sha256: baseline });
    rows.push(row);
    return row;
  };
  add('owner-events', e0, e1); add('unit-lease', l0, l1); add('owner-events', e1, e2); add('hook-evidence', null, h1);
  const current = { ...S0, [paths.events]: sha(e2), [paths.lease]: sha(l1), [paths.hook]: sha(h1) };
  return { e0, e1, e2, l0, l1, h1, paths, S0, baseline, rows, current };
}
function auditJournal() {
  withTemp(dir => {
    const store = path.join(dir, 'store'), f = chainFixture(store);
    const empty = surfaces.readJournal(path.join(dir, 'absent'));
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.anchor, null);
    code(() => surfaces.appendJournalRow(store, f.rows[0], { sha256: sha(''), size: 0, identity: { dev: '0', ino: '0', birthtime_ns: '0' } }),
      'managed-surface-audit-prefix-changed', 'anchor for a journal that does not exist');
    const a1 = surfaces.appendJournalRow(store, f.rows[0], null);
    assert.equal(a1.rows, 1);
    assert.equal(a1.size, Buffer.byteLength(`${JSON.stringify(f.rows[0])}\n`));
    const a2 = surfaces.appendJournalRow(store, f.rows[1], a1);
    assert.equal(a2.rows, 2);
    const read = surfaces.readJournal(store);
    assert.equal(read.rows.length, 2);
    assert.deepEqual(read.anchor, a2);
    assert.deepEqual(read.rows.map(surfaces.attributionRowDigest), f.rows.slice(0, 2).map(surfaces.attributionRowDigest));
    code(() => surfaces.appendJournalRow(store, f.rows[2], a1), 'managed-surface-audit-prefix-changed', 'stale anchor');
    code(() => surfaces.appendJournalRow(store, f.rows[2], null), 'managed-surface-audit-prefix-changed', 'missing anchor');
    const file = path.join(store, 'journal.jsonl'), original = fs.readFileSync(file);
    // fixture rewritten-prefix (same size, same identity)
    const rewritten = Buffer.from(original); rewritten[rewritten.length - 3] = rewritten[rewritten.length - 3] === 0x61 ? 0x62 : 0x61;
    overwrite(file, rewritten);
    code(() => surfaces.appendJournalRow(store, f.rows[2], a2), 'managed-surface-audit-prefix-changed', 'rewritten-prefix');
    overwrite(file, original);
    // fixture truncated-prefix
    fs.truncateSync(file, a1.size);
    code(() => surfaces.appendJournalRow(store, f.rows[2], a2), 'managed-surface-audit-prefix-changed', 'truncated-prefix');
    overwrite(file, original);
    // fixture inserted-line
    const lines = original.toString('utf8').split('\n');
    overwrite(file, Buffer.from(`${lines[0]}\n${lines[0]}\n${lines[1]}\n`, 'utf8'));
    code(() => surfaces.appendJournalRow(store, f.rows[2], a2), 'managed-surface-audit-prefix-changed', 'inserted-line');
    overwrite(file, original);
    const a3 = surfaces.appendJournalRow(store, f.rows[2], a2);
    assert.equal(a3.rows, 3);
    // fixture replaced-file (identical bytes, new identity)
    const current = fs.readFileSync(file), temporary = path.join(store, 'journal.replacement');
    fs.writeFileSync(temporary, current);
    fs.renameSync(temporary, file);
    code(() => surfaces.appendJournalRow(store, f.rows[3], a3), 'managed-surface-audit-prefix-changed', 'replaced-file');
    const fresh = surfaces.readJournal(store).anchor;
    assert.equal(fresh.sha256, a3.sha256);
    const a4 = surfaces.appendJournalRow(store, f.rows[3], fresh);
    assert.equal(a4.rows, 4);
    // fixture hardlinked-journal
    const twin = path.join(dir, 'journal-twin');
    fs.linkSync(file, twin);
    code(() => surfaces.readJournal(store), 'managed-surface-store-invalid', 'hardlinked-journal read');
    code(() => surfaces.appendJournalRow(store, f.rows[3], a4), 'managed-surface-store-invalid', 'hardlinked-journal append');
    fs.unlinkSync(twin);
    // fixture corrupt-row
    fs.appendFileSync(file, 'not json\n');
    code(() => surfaces.readJournal(store), 'managed-surface-audit-prefix-changed', 'corrupt-row');
    code(() => surfaces.appendJournalRow(store, { ...f.rows[0], extra: true }, a4), 'managed-surface-attribution-forged', 'invalid row shape');
  });
}
// Full S01 audit-row contract: every field present, derived from real bytes, and each
// attempt component independently load-bearing.
function fullRowContract(f) {
  const [events, lease, , hook] = f.rows;
  const invalid = (row, expected = 'managed-surface-attribution-forged', options) => assert.equal(surfaces.validateAttributionRow(row, options).reason_code, expected, JSON.stringify(Object.keys(row)));
  for (const key of surfaces.ROW_FIELDS) {
    assert(Object.prototype.hasOwnProperty.call(events, key), `row has ${key}`);
    const { [key]: omitted, ...rest } = events;
    void omitted;
    invalid(rest);
  }
  assert.deepEqual(Object.keys(events).sort(), [...surfaces.ROW_FIELDS].sort());
  assert.deepEqual(Object.keys(events.attempt).sort(), [...surfaces.FULL_ATTEMPT_FIELDS].sort());
  assert.deepEqual({ ...events.attempt }, { ...ATTEMPT });
  invalid({ ...events, extra: 1 });
  // Derived metadata.
  assert.equal(events.schema_version, 1);
  assert.equal(events.declaration, surfaces.VERSION);
  assert.equal(events.declaration_sha256, surfaces.declarationDigest());
  assert.equal(events.declaration_digest, events.declaration_sha256);
  assert.equal(events.surface_version, 1);
  assert.equal(events.writer, writerOf('owner-events'));
  assert.equal(events.attestation_reference, null);
  assert.equal(events.before_length, f.e0.length);
  assert.equal(events.after_length, f.e1.length);
  assert.equal(events.appended, f.e1.length - f.e0.length);
  assert.deepEqual(events.fields_changed, []);
  assert.deepEqual(events.created_dirs, []);
  assert.deepEqual(lease.fields_changed, ['expires_at', 'heartbeat_at']);
  assert.equal(lease.appended, 0);
  assert.equal(hook.before_sha256, null);
  assert.equal(hook.before_length, 0);
  assert.equal(hook.after_length, f.h1.length);
  assert.equal(hook.attestation_reference, 'scripts/forge-protected-owner-activity.js#hookAppendProof');
  assert.equal(hook.writer, writerOf('hook-evidence'));
  // Mutated or inconsistent metadata is refused.
  for (const patch of [{ schema_version: 2 }, { surface_version: 2 }, { before_length: events.before_length + 1 }, { after_length: events.after_length + 1 },
    { appended: events.appended + 1 }, { fields_changed: ['heartbeat_at'] }, { created_dirs: ['.gsd/'] }, { attestation_reference: 'scripts/x.js#y' }]) {
    invalid({ ...events, ...patch });
  }
  invalid({ ...lease, fields_changed: [] });
  invalid({ ...lease, fields_changed: ['owner_token'] });
  invalid({ ...lease, fields_changed: ['heartbeat_at', 'expires_at'] }, 'managed-surface-attribution-forged');
  invalid({ ...hook, attestation_reference: null }, 'managed-surface-attestation-required');
  invalid({ ...hook, created_dirs: ['.gsd/forge/'] , before_sha256: sha('x'), preimage_sha256: sha('x') });
  invalid({ ...events, writer: 'scripts/other.js#appendProtectedOwnerEvents' }, 'managed-surface-attribution-forged');
  invalid({ ...events, writer: writerOf('unit-lease') }, 'managed-surface-attribution-forged');
  invalid({ ...events, declaration: 'managed-surfaces-v2' }, 'managed-surface-attribution-foreign');
  invalid({ ...events, declaration_sha256: sha('another declaration') }, 'managed-surface-attribution-foreign');
  // created_dirs: only real parent directories of the row path are carried.
  const created = surfaces.createAttributionRow({ attempt: ATTEMPT, sequence: 1, previous_row_sha256: null, surface_id: 'owner-events',
    writer: writerOf('owner-events'), before: null, after: f.e0, baseline_sha256: f.baseline, created_dirs: ['.gsd/', '.gsd/forge/'] });
  assert.deepEqual(created.created_dirs, ['.gsd/', '.gsd/forge/']);
  for (const dirs of [['.gsd/forge/', '.gsd/'], ['.gsd/', '.gsd/'], ['.gsd/forge/leases/'], ['.gsd/forge/events.jsonl/'], ['other/'], ['.gsd/..']]) {
    code(() => surfaces.createAttributionRow({ attempt: ATTEMPT, sequence: 1, previous_row_sha256: null, surface_id: 'owner-events',
      writer: writerOf('owner-events'), before: null, after: f.e0, baseline_sha256: f.baseline, created_dirs: dirs }), 'managed-surface-attribution-forged');
  }
  // Attempt components: omitted or changed, each independently.
  for (const key of ['fingerprint', 'recovery_identity_sha256', 'claim_generation', 'lease_generation']) {
    const { [key]: omitted, ...partial } = events.attempt;
    void omitted;
    invalid({ ...events, attempt: partial });
    const changed = { ...events.attempt, [key]: key.endsWith('generation') ? (typeof ATTEMPT[key] === 'number' ? ATTEMPT[key] + 1 : 'lease-8') : 'c3'.repeat(32) };
    assert.equal(surfaces.validateAttributionRow({ ...events, attempt: changed }, { attempt: ATTEMPT }).reason_code, 'managed-surface-attribution-foreign', `changed ${key}`);
    const forged = surfaces.verifyAttributionChain({ attempt: ATTEMPT, baseline: f.S0, current: f.current, rows: [{ ...events, attempt: changed }, ...f.rows.slice(1)] });
    assert.equal(forged.ok, false, `chain rejects changed ${key}`);
    assert.equal(forged.paths.find(row => row.path === f.paths.events).reason_code, 'managed-surface-attribution-foreign');
    // A lightweight or partial expected attempt can never verify or accept a row.
    code(() => surfaces.verifyAttributionChain({ attempt: partial, baseline: f.S0, current: f.current, rows: f.rows }), 'managed-surface-baseline-unbound');
    assert.equal(surfaces.validateAttributionRow(events, { attempt: partial }).reason_code, 'managed-surface-store-invalid');
    code(() => surfaces.createAttributionRow({ attempt: partial, sequence: 1, previous_row_sha256: null, surface_id: 'owner-events',
      writer: writerOf('owner-events'), before: f.e0, after: f.e1, baseline_sha256: f.baseline }), 'managed-surface-baseline-unbound');
  }
  for (const bad of [{ fingerprint: 'short' }, { recovery_identity_sha256: 'Z'.repeat(64) }, { claim_generation: 1.5 }, { lease_generation: {} }, { claim_generation: undefined }]) {
    code(() => surfaces.createAttributionRow({ attempt: { ...ATTEMPT, ...bad }, sequence: 1, previous_row_sha256: null, surface_id: 'owner-events',
      writer: writerOf('owner-events'), before: f.e0, after: f.e1, baseline_sha256: f.baseline }), 'managed-surface-baseline-unbound');
  }
  // Lightweight path binding stays available but yields no row.
  assert.equal(surfaces.surfacePath('owner-events', BINDING), events.path);
  code(() => surfaces.createAttributionRow({ attempt: { dispatch_id: 'fixture-dispatch-1', ...BINDING }, sequence: 1, previous_row_sha256: null,
    surface_id: 'owner-events', writer: writerOf('owner-events'), before: f.e0, after: f.e1, baseline_sha256: f.baseline }), 'managed-surface-baseline-unbound');
  // Canonical reason-code membership.
  for (const reason of ['managed-surface-undeclared', 'managed-surface-unattributed', 'managed-surface-capability-required',
    'managed-surface-attestation-required', 'managed-surface-attribution-forged', 'managed-surface-attribution-forged',
    'managed-surface-attribution-foreign', 'managed-surface-attribution-reused', 'managed-surface-baseline-unbound']) {
    assert(surfaces.REASON_CODES.includes(reason), reason);
  }
  assert.equal(new Set(surfaces.REASON_CODES).size, surfaces.REASON_CODES.length, 'reason codes are unique');
}
function attributionChain() {
  withTemp(dir => {
    const store = path.join(dir, 'store'), f = chainFixture(store);
    const verify = (overrides = {}) => surfaces.verifyAttributionChain({ attempt: ATTEMPT, baseline: f.S0, current: f.current, rows: f.rows, store, ...overrides });
    const status = (verdict, file) => verdict.paths.find(row => row.path === file);
    const ok = verify();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.paths.map(row => row.path), [f.paths.events, f.paths.hook, f.paths.lease].sort());
    assert(ok.paths.every(row => row.status === 'attributed' && row.reason_code === null));
    assert.equal(status(ok, f.paths.events).rows, 2);
    assert.equal(ok.baseline_sha256, f.baseline);
    assert.equal(JSON.stringify(verify()), JSON.stringify(ok), 'deterministic');
    for (const [index, row] of f.rows.entries()) assert.equal(row.sequence, index + 1);
    // Rows read back from the journal verify identically.
    let anchor = null;
    for (const row of f.rows) anchor = surfaces.appendJournalRow(store, row, anchor);
    assert.equal(JSON.stringify(verify({ rows: surfaces.readJournal(store).rows })), JSON.stringify(ok));
    // Foreign attempt binding.
    const foreign = surfaces.createAttributionRow({ attempt: { ...ATTEMPT, dispatch_id: 'fixture-dispatch-2' }, sequence: 1, previous_row_sha256: null,
      surface_id: 'owner-events', writer: writerOf('owner-events'), before: f.e0, after: f.e1, baseline_sha256: f.baseline });
    const foreignVerdict = verify({ rows: [foreign], current: { ...f.S0, [f.paths.events]: sha(f.e1) } });
    assert.equal(status(foreignVerdict, f.paths.events).reason_code, 'managed-surface-attribution-foreign');
    assert.equal(foreignVerdict.ok, false);
    const otherUnit = surfaces.createAttributionRow({ attempt: { ...ATTEMPT, unit: 'execute-task/T02' }, sequence: 1, previous_row_sha256: null,
      surface_id: 'owner-events', writer: writerOf('owner-events'), before: f.e0, after: f.e1, baseline_sha256: f.baseline });
    assert.equal(status(verify({ rows: [otherUnit], current: { ...f.S0, [f.paths.events]: sha(f.e1) } }), f.paths.events).reason_code, 'managed-surface-attribution-foreign');
    // Repeated row and broken sequence.
    const once = { ...f.S0, [f.paths.events]: sha(f.e1) };
    assert.equal(status(verify({ rows: [f.rows[0], f.rows[0]], current: once }), f.paths.events).reason_code, 'managed-surface-attribution-reused');
    assert.equal(status(verify({ rows: [f.rows[0], f.rows[2]], current: { ...f.S0, [f.paths.events]: sha(f.e2) } }), f.paths.events).reason_code, 'managed-surface-attribution-reused');
    const skipped = verify({ rows: [f.rows[1]], current: { ...f.S0, [f.paths.lease]: sha(f.l1) } });
    assert.equal(status(skipped, f.paths.lease).reason_code, 'managed-surface-attribution-reused');
    const firstWithParent = { ...f.rows[0], previous_row_sha256: sha('fixture-parent') };
    assert.equal(surfaces.validateAttributionRow(firstWithParent).reason_code, 'managed-surface-attribution-forged');
    // Chain that does not start at S0.
    const unbound = surfaces.createAttributionRow({ attempt: ATTEMPT, sequence: 1, previous_row_sha256: null, surface_id: 'owner-events',
      writer: writerOf('owner-events'), before: f.e1, after: f.e2, baseline_sha256: f.baseline });
    assert.equal(status(verify({ rows: [unbound], current: { ...f.S0, [f.paths.events]: sha(f.e2) } }), f.paths.events).reason_code, 'managed-surface-baseline-unbound');
    const otherBaseline = { ...f.S0, '.gsd/forge/other.json': sha('fixture') };
    assert.equal(status(verify({ baseline: otherBaseline, current: { ...otherBaseline, [f.paths.events]: sha(f.e1) }, rows: [f.rows[0]] }), f.paths.events).reason_code,
      'managed-surface-baseline-unbound');
    // Missing preimage.
    const emptyStore = path.join(dir, 'empty-store');
    assert.equal(status(verify({ store: emptyStore }), f.paths.events).reason_code, 'managed-surface-preimage-missing');
    assert.equal(status(verify({ store: undefined }), f.paths.lease).reason_code, 'managed-surface-preimage-missing');
    assert.equal(status(verify({ store: emptyStore }), f.paths.hook).status, 'attributed');
    // Deltas without rows, or rows that do not reach the current bytes.
    const drift = verify({ current: { ...f.current, '.gsd/worker-untrusted.md': sha('drift') } });
    assert.equal(drift.ok, false);
    assert.equal(status(drift, '.gsd/worker-untrusted.md').reason_code, 'managed-surface-unattributed');
    assert.equal(status(verify({ current: { ...f.current, [f.paths.events]: sha(f.e1) } }), f.paths.events).reason_code, 'managed-surface-unattributed');
    // Row validation.
    assert.equal(surfaces.validateAttributionRow({ ...f.rows[0], path: '.gsd/forge/events.jsonl.bak' }).reason_code, 'managed-surface-attribution-forged');
    assert.equal(surfaces.validateAttributionRow({ ...f.rows[0], declaration_digest: sha('another declaration') }).reason_code, 'managed-surface-attribution-foreign');
    assert.equal(surfaces.validateAttributionRow({ ...f.rows[0], surface_id: 'state-heartbeat' }).reason_code, 'managed-surface-attribution-forged');
    assert.equal(surfaces.validateAttributionRow(f.rows[0], { attempt: ATTEMPT }).ok, true);
    code(() => surfaces.createAttributionRow({ attempt: ATTEMPT, sequence: 1, previous_row_sha256: null, surface_id: 'owner-events',
      writer: writerOf('owner-events'), before: f.e1, after: f.e0, baseline_sha256: f.baseline }), 'managed-surface-append-rewrite');
    fullRowContract(f);
    code(() => surfaces.verifyAttributionChain({ attempt: ATTEMPT, baseline: f.S0, current: f.current, rows: 'rows' }), 'managed-surface-store-invalid');
    code(() => surfaces.verifyAttributionChain({ attempt: { ...ATTEMPT, dispatch_id: undefined }, baseline: f.S0, current: f.current, rows: [] }), 'managed-surface-baseline-unbound');
  });
}

function approvedReasonContract() {
  // Independent copy of S01-PLAN's approved public contract, not derived from exports.
  const approved = ['version-unknown', 'path-invalid', 'undeclared', 'unattributed', 'field-unknown',
    'field-immutable', 'append-rewrite', 'append-invalid', 'create-conflict', 'baseline-unbound',
    'attribution-foreign', 'attribution-reused', 'attribution-forged', 'capability-required',
    'attestation-required', 'preimage-conflict', 'preimage-missing', 'audit-prefix-changed',
    'read-limit', 'unstable', 'store-invalid'].map(name => 'managed-surface-' + name).sort();
  assert.deepEqual([...surfaces.REASON_CODES].sort(), approved);
  assert.deepEqual([...require('./forge-managed-attribution').REASON_CODES].sort(), approved);
  const doc = fs.readFileSync(path.join(CODE_DIR, 'docs/issue-440/managed-surfaces.md'), 'utf8');
  const section = doc.split('## Códigos fechados\n')[1].split('\n\nTodos usam')[0];
  const documented = [...section.matchAll(/`(managed-surface-[a-z-]+|-[a-z-]+)`/g)]
    .map(match => match[1].startsWith('-') ? 'managed-surface' + match[1] : match[1]);
  assert.deepEqual(documented.sort(), approved, 'documentation declares exactly the approved codes');
  assert.equal(surfaces.validateTransition('missing-surface', null, Buffer.from('x')).reason_code, 'managed-surface-undeclared');
  const limit = surfaces.validateTransition({ validator: 'exclusive-create-v1', limits: { max_bytes: 1 } }, null, Buffer.from('xx'));
  assert.equal(limit.reason_code, 'managed-surface-read-limit');
  assert.equal(surfaces.validateAttributionRow({}).reason_code, 'managed-surface-attribution-forged');
  withTemp(dir => {
    const owner = path.join(dir, 'owner'), file = path.join(owner, '.gsd/forge/events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}\n');
    const sources = require('./forge-autonomy-sources'), original = sources.readBoundedStableFile;
    try {
      for (const [low, expected] of [['source_too_large', 'managed-surface-read-limit'], ['source_unstable', 'managed-surface-unstable']]) {
        sources.readBoundedStableFile = (target, ...args) => path.resolve(target) === path.resolve(file) ? { error: low } : original(target, ...args);
        code(() => surfaces.readSurface(owner, 'owner-events', BINDING), expected);
      }
    } finally { sources.readBoundedStableFile = original; }
  });
}

const cases = [
  ['approved-reason-contract', approvedReasonContract],
  ['census-call-sites', censusCallSites],
  ['fixture-readme', fixtureReadme],
  ['snapshot-pin', snapshotPin],
  ['declaration-pin', declarationPin],
  ['cli-list', cliList],
  ['delta-cases', deltaCases],
  ['sanitized-diff-private', sanitizedDiffPrivate],
  ['windows-paths', windowsPaths],
  ['physical-links', physicalLinks],
  ['preimage-store', preimageStore],
  ['audit-journal', auditJournal],
  ['attribution-chain', attributionChain],
];
function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { fn(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error && error.stack ? error.stack : error}`); }
  }
  console.log(`${cases.length - failed}/${cases.length} cases passed`);
  if (failed) process.exitCode = 1;
}
module.exports = { cases };
if (require.main === module) main();
