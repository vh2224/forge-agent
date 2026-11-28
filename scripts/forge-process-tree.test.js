'use strict';
const issue463SourceConsumer = require('./fixtures/issue-463/distribution.cjs');
issue463SourceConsumer.validateSourceConsumer(() => {

// Temporary-root contract suite for the process-family proof (issue 440, S02/T02).
// Every owner, checkout, record, journal and helper lives in a fresh temporary
// laboratory removed in finally. Helper processes are real and report their own
// identity through marker files; every process created here is ended BY IDENTITY
// in finally. Transport is synthetic (label mock): no provider, network, real
// owner metadata or operator account is touched. On win32 the positive custody
// path must really run on this machine: unavailability FAILS the suite (blocker),
// it never becomes a skip. Other platforms prove the fail-closed census path.
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const cp = require('child_process'), crypto = require('crypto');
const tree = require('./forge-process-tree');
const transition = require('./forge-recovery-transition');
const WIN = process.platform === 'win32';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SECRET = 'SECRET-440-PROCESS-TREE', PERSONAL = 'C:\\Users\\someone-private\\notes';
const NATIVE_PIN = 'a5e9c02e8b926992e52fe2e459afba306e63c8d6721eb4502178491b4b3f49c9';
const SOURCE_PINS = {
  'scripts/forge-verification-job.ps1': '46cc4463ec5398689f04474c7f0742768241d5acfe72c9acb7c2c0d36d36b7ff',
  'scripts/forge-verification-process.js': 'ea13826a77554241cee75c15f4617cdb0d2d27753ec1733cc8109bc04179c09f',
  'scripts/forge-xllm.js': '96f11f6a3eb94ad1a6fc69ab22cba49f1646e5017e40acaf09844cf7a982f8f4',
  'scripts/forge-appserver-client.js': '1888564771fcc310cbc1e1fcc084a939a0ff3b189e0c94aa04d3ed19c2040c31',
  'scripts/forge-claude-sidecar.js': '2a6e7042e86b050076a2c68a54e8c5f6593c72be0a6ee44c26219711eef22ae4',
};
const env = [];
const note = (label, value) => { env.push([label, value]); console.log(`ENV ${label} ${JSON.stringify(value)}`); };

// ── Laboratory, helpers and identity-based cleanup ──────────────────────────
const LAB = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-process-tree-')));
const OWNER = path.join(LAB, 'owner'), ROOT = path.join(LAB, 'root');
fs.mkdirSync(OWNER); fs.mkdirSync(ROOT);
const HELPER = path.join(LAB, 'helper.js');
fs.writeFileSync(HELPER, String.raw`'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const [mode, ...rest] = process.argv.slice(2), self = process.argv[1];
const mark = (dir, name) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({ pid: process.pid }));
const waitFor = (file, ms, done) => { const until = Date.now() + ms; const tick = () => { if (fs.existsSync(file) || Date.now() > until) done(); else setTimeout(tick, 20); }; tick(); };
const spawnNode = (args, detached) => { const c = cp.spawn(process.execPath, [self, ...args], { stdio: 'ignore', detached, windowsHide: true }); if (detached) c.unref(); return c; };
if (mode === 'echo-lines') {
  process.stdin.setEncoding('utf8'); let b = '';
  process.stdin.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); process.stdout.write('echo:' + l + '\n'); if (l === 'quit') process.exit(0); } });
  process.stdin.on('end', () => { process.stdout.write('eof\n'); });
} else if (mode === 'cat') { process.stdin.pipe(process.stdout); }
else if (mode === 'hash') { const h = crypto.createHash('sha256'); let n = 0; process.stdin.on('data', d => { n += d.length; h.update(d); }); process.stdin.on('end', () => process.stdout.write(n + ':' + h.digest('hex'))); }
else if (mode === 'report') { process.stdout.write(JSON.stringify({ argv: process.argv.slice(3), cwd: process.cwd(), env: Object.entries(process.env), execPath: process.execPath })); }
else if (mode === 'ignore-stdin') { let n = 0; process.stdin.on('data', d => { n += d.length; }); process.stdin.on('end', () => process.stderr.write('stdin-eof:' + n)); process.stdin.resume(); }
else if (mode === 'exit') { setTimeout(() => process.exit(Number(rest[0])), 20); }
else if (mode === 'sleep') { mark(rest[0], rest[1] || 'sleep'); waitFor(path.join(rest[0], 'release-' + (rest[1] || 'sleep')), 120000, () => process.exit(0)); }
else if (mode === 'orphan') { mark(rest[0], rest[1] || 'orphan'); waitFor(path.join(rest[0], 'release-' + (rest[1] || 'orphan')), 120000, () => process.exit(0)); }
else if (mode === 'spawn-orphan') { spawnNode(['orphan', rest[0], rest[1] || 'orphan'], true); mark(rest[0], 'intermediate'); process.exit(0); }
else if (mode === 'ephemeral-root') {
  mark(rest[0], 'root');
  waitFor(path.join(rest[0], 'go'), 120000, () => {
    const c = spawnNode(['spawn-orphan', rest[0]], false);
    c.on('exit', () => waitFor(path.join(rest[0], 'orphan.json'), 60000, () => { mark(rest[0], 'root-ready'); waitFor(path.join(rest[0], 'release-root'), 120000, () => process.exit(0)); }));
  });
} else if (mode === 'survivor-root') {
  const c = spawnNode(['spawn-orphan', rest[0], 'grandchild'], false);
  c.on('exit', () => waitFor(path.join(rest[0], 'grandchild.json'), 60000, () => { mark(rest[0], 'root'); waitFor(path.join(rest[0], 'release-root'), 120000, () => process.exit(0)); }));
} else if (mode === 'nested') {
  const depth = Number(rest[1]); mark(rest[0], 'nested-' + depth);
  if (depth < 3) spawnNode(['nested', rest[0], String(depth + 1)], false);
  waitFor(path.join(rest[0], 'release-nested'), 120000, () => setTimeout(() => process.exit(0), 50));
}
`);
const children = new Set(), identities = [];
function track(child) { children.add(child); return child; }
function remember(pid) {
  const found = WIN ? tree.identities([{ pid }]) : null;
  const row = found?.[0];
  const identity = { pid, created: row?.state === 'alive' ? row.created : null };
  identities.push(identity); return identity;
}
function identityState(identity) {
  if (!WIN) { try { process.kill(identity.pid, 0); return 'alive'; } catch { return 'absent'; } }
  return tree.identities([{ pid: identity.pid, created: identity.created || '0' }])?.[0]?.state || 'unavailable';
}
function cleanupProcesses() {
  for (const child of children) { try { if (child.exitCode === null && child.signalCode === null) child.kill(); } catch { /* gone */ } }
  for (const identity of identities) {
    // Only a process that still has the SAME pid + creation instant is ended.
    if (identity.created && identityState(identity) === 'alive') { try { process.kill(identity.pid); } catch { /* gone */ } }
  }
}
let counter = 0;
const binding = (overrides = {}) => ({ dispatch_id: 'fixture-tree', fingerprint: 'fixture-fingerprint', recovery_identity_sha256: 'a'.repeat(64),
  unit: 'execute-task/T01', claim_generation: 1, lease_generation: 1, ...overrides });
function attemptDir(label) { const dir = path.join(LAB, `${label}-${++counter}`); fs.mkdirSync(dir); return dir; }
function start(dir, args, options = {}, extra = {}) {
  const resultFile = path.join(dir, 'result.json');
  const started = tree.startAttemptTree({ command: process.execPath, args: [HELPER, ...args], options: { cwd: dir, windowsHide: true, ...options },
    resultFile, binding: binding(), roots: [OWNER, ROOT], ...extra });
  track(started.child);
  return { ...started, resultFile };
}
function plain(dir, args, options = {}) { return track(cp.spawn(process.execPath, [HELPER, ...args], { cwd: dir, windowsHide: true, ...options })); }
function observe(child) {
  return new Promise(resolve => {
    const t = Date.now(), events = [], out = [], err = [];
    child.stdout?.on('data', d => { if (!events.some(e => e[0] === 'first')) events.push(['first', Date.now() - t]); out.push(d); });
    child.stderr?.on('data', d => err.push(d));
    child.stdout?.on('end', () => events.push(['end', Date.now() - t]));
    child.on('error', e => events.push(['error', e.code]));
    child.on('exit', (code, signal) => events.push(['exit', code, signal, Date.now() - t]));
    child.on('close', (code, signal) => { events.push(['close', code, signal]); resolve({ out: Buffer.concat(out), err: Buffer.concat(err), events }); });
  });
}
// Event multiset (end/exit ordering is timing-dependent even for the plain spawn;
// the EOF-before-exit case checks ordering explicitly).
const shape = events => events.filter(e => e[0] !== 'first').map(e => e[0] === 'exit' ? ['exit', e[1], e[2]] : e[0] === 'end' ? ['end'] : e)
  .map(e => JSON.stringify(e)).sort();
// The optional dependencies are private TEST-only seams for deterministic polling checks.
async function waitFile(file, ms = 30000, { read = target => fs.readFileSync(target, 'utf8'), now = Date.now, pause = wait } = {}) {
  const until = now() + ms;
  let lastError;
  for (;;) {
    try { return JSON.parse(read(file)); }
    catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      lastError = error;
    }
    if (now() >= until) throw new Error('marker timeout ' + path.basename(file), { cause: lastError });
    await pause(20);
  }
}
function journal(file) { return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
function expectCode(fn, code) { assert.throws(fn, error => { assert.equal(error?.code, code, `${error?.code} ${error?.message}`); return true; }); }

// ── Cases ───────────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn, { win32 = false } = {}) => cases.push({ name, fn, win32 });

test('T0 contract methods codes and native supervisor pin', () => {
  assert.equal(tree.CUSTODY_METHOD, 'process-tree-custody-v1');
  assert.equal(tree.CENSUS_METHOD, 'process-tree-census-v1');
  assert.deepEqual([...tree.REASON_CODES], ['process-tree-unavailable', 'process-tree-record-missing', 'process-tree-record-invalid',
    'process-tree-binding-mismatch', 'process-tree-root-unbound', 'process-tree-survivors', 'process-tree-custody-unavailable',
    'process-tree-custody-failed', 'process-tree-custody-unproved', 'process-tree-census-only']);
  assert(Object.isFrozen(tree.REASON_CODES) && Object.isFrozen(tree.NATIVE_SOURCE) && Object.isFrozen(tree.internals));
  assert.equal(tree.NATIVE_SHA256, sha(JSON.stringify([tree.NATIVE_SOURCE.csharp, tree.NATIVE_SOURCE.supervisor, tree.NATIVE_SOURCE.compile])));
  const diagnosticLines = ["$probeDiag=[Environment]::GetEnvironmentVariable('FORGE_PROCESS_TREE_PROBE_DIAGNOSTIC') -eq '1';[Environment]::SetEnvironmentVariable('FORGE_PROCESS_TREE_PROBE_DIAGNOSTIC',$null);if($probeDiag){[Console]::Error.WriteLine('forge-probe:bootstrap')}","if($probeDiag){[Console]::Error.WriteLine('forge-probe:parts-read')}","if($probeDiag){[Console]::Error.WriteLine('forge-probe:builder-ready')}","if($probeDiag){[Console]::Error.WriteLine('forge-probe:packet-ready')}","if($probeDiag){[Console]::Error.WriteLine('forge-probe:assembly-load')}","if($probeDiag){[Console]::Error.WriteLine('forge-probe:native-entry')}","if($probeDiag){[Console]::Error.WriteLine('forge-probe:native-return')}"];
  for (const ctor of ['[Text.StringBuilder]::new()', '[Text.UTF8Encoding]::new($false)']) assert.equal(tree.NATIVE_SOURCE.supervisor.split(ctor).length, 2, 'one explicit supervisor constructor '+ctor);
  assert(!tree.NATIVE_SOURCE.supervisor.includes('New-Object'), 'supervisor does not depend on cmdlet autoload');
  const historicalSupervisor = tree.NATIVE_SOURCE.supervisor.split('\n').filter(line => !diagnosticLines.includes(line)).join('\n').replace('[Text.StringBuilder]::new()', 'New-Object Text.StringBuilder').replace('[Text.UTF8Encoding]::new($false)', 'New-Object Text.UTF8Encoding($false)');
  assert.equal(sha(JSON.stringify([tree.NATIVE_SOURCE.csharp, historicalSupervisor, tree.NATIVE_SOURCE.compile])), NATIVE_PIN, 'historical native bytes retained with diagnostic-only probe markers');
  for (const line of diagnosticLines) assert.equal(tree.NATIVE_SOURCE.supervisor.split('\n').filter(value => value === line).length, 1);
  // Fixed supervisor argv: System32 PowerShell, no profile, non-interactive, constant bootstrap.
  assert.equal(path.basename(tree.POWERSHELL).toLowerCase(), 'powershell.exe');
  assert(/System32[\\/]WindowsPowerShell[\\/]v1\.0$/i.test(path.dirname(tree.POWERSHELL)));
  assert.deepEqual(tree.SUPERVISOR_ARGS.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(tree.SUPERVISOR_ARGS[4], 'base64').toString('utf16le'), tree.NATIVE_SOURCE.supervisor);
  // Compile pattern: runtime csc, /noconfig, fixed references, no CodeDom/Add-Type.
  for (const needle of ['GetRuntimeDirectory()', "'csc.exe'", '/noconfig', '/nostdlib+', "'mscorlib.dll'", "'System.dll'"]) assert(tree.NATIVE_SOURCE.compile.includes(needle), needle);
  for (const banned of ['Add-Type', 'CodeDom', 'CSharpCodeProvider']) assert(!JSON.stringify(tree.NATIVE_SOURCE).includes(banned), banned);
  // Job contract: KILL_ON_JOB_CLOSE only (0x2000), atomic job list, handle list, suspended root, collision 183.
  for (const needle of ['limits.basic.flags=0x2000', '(IntPtr)0x2000D', '(IntPtr)0x20002', 'err==183', 'IsProcessInJob(p.process,job', 'ResumeThread(p.thread)', '(hf&1)!=0'])
    assert(tree.NATIVE_SOURCE.csharp.includes(needle), needle);
  const limitFlags = tree.NATIVE_SOURCE.csharp.match(/basic\.flags=0x[0-9a-fA-F]+/g);
  assert(limitFlags.length >= 2 && limitFlags.every(value => value === 'basic.flags=0x2000'), 'only KILL_ON_JOB_CLOSE: no BREAKAWAY_OK or SILENT_BREAKAWAY_OK');
  assert(tree.NATIVE_SOURCE.csharp.includes('back.basic.flags!=0x2000'), 'limits re-read');
  // No code outside the closed export is ever emitted by the module.
  const text = fs.readFileSync(path.join(__dirname, 'forge-process-tree.js'), 'utf8');
  const allowed = new Set([...tree.REASON_CODES, tree.CUSTODY_METHOD, tree.CENSUS_METHOD, tree.RECORD_VERSION, 'process-tree-preparation', 'process-tree-proof']);
  for (const literal of text.match(/'process-tree-[a-z0-9-]+'/g)) assert(allowed.has(literal.slice(1, -1)), literal);
});

test('T1 libuv quoting executable search and effective environment tables', () => {
  const q = tree.internals.quoteArgument;
  for (const [input, expected] of [['', '""'], ['plain', 'plain'], ['a b', '"a b"'], ['hello"world', '"hello\\"world"'], ['hello""world', '"hello\\"\\"world"'],
    ['hello\\world', 'hello\\world'], ['hello\\\\world', 'hello\\\\world'], ['hello\\"world', '"hello\\\\\\"world"'], ['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
    ['hello world\\', '"hello world\\\\"'], ['tab\there', '"tab\there"'], ['\u03a9 \u00fc', '"\u03a9 \u00fc"']]) assert.equal(q(input), expected, JSON.stringify(input));
  assert.equal(tree.internals.commandLine(['C:\\a b\\x.exe', '', 'y']), '"C:\\a b\\x.exe" "" y');
  const files = new Set(['C:\\cwd\\tool.exe', 'C:\\p1\\other.com', 'C:\\p1\\other.exe', 'C:\\p2\\other.exe', 'C:\\p2\\lit.txt', 'C:\\q d\\quoted.exe', 'C:\\cwd\\sub\\rel.exe']);
  const stat = file => { if (files.has(file)) return { isFile: () => true }; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const r = (file, p = 'C:\\p1;C:\\p2;"C:\\q d"', parent = {}) => tree.internals.resolveExecutable(file, 'C:\\cwd', p, { stat, parent });
  assert.equal(r('tool'), 'C:\\cwd\\tool.exe', 'cwd first');
  assert.equal(r('tool', 'C:\\p1', { NoDefaultCurrentDirectoryInExePath: '1' }), null, 'cwd skipped when disabled');
  assert.equal(r('other'), 'C:\\p1\\other.com', '.com before .exe, PATH order');
  assert.equal(r('other.exe'), 'C:\\p1\\other.exe', 'literal first only with an extension');
  assert.equal(r('lit.txt'), 'C:\\p2\\lit.txt', 'literal with extension');
  assert.equal(r('lit'), null, 'no implicit .txt');
  assert.equal(r('quoted'), 'C:\\q d\\quoted.exe', 'quoted PATH entries');
  assert.equal(r('sub\\rel'), 'C:\\cwd\\sub\\rel.exe', 'directory-qualified names never use PATH');
  assert.equal(r('C:rel'), null, 'drive-relative refused');
  assert.equal(r('missing'), null);
  const parent = { SystemRoot: 'C:\\Windows', SYSTEMDRIVE: 'C:', TEMP: 'C:\\t', PATH: 'C:\\bin' };
  const e = tree.internals.effectiveEnvironment({ zeta: '1', Path: 'C:\\mine', path: 'C:\\dup', alpha: 2, unset: undefined }, parent);
  assert.deepEqual(e, ['alpha=2', 'Path=C:\\mine', 'SYSTEMDRIVE=C:', 'SYSTEMROOT=C:\\Windows', 'TEMP=C:\\t', 'zeta=1']);
  assert.equal(tree.internals.effectiveEnvironment({ 'caf\u00e9': 'x' }, parent), null, 'non-ASCII names are not reproduced: plain spawn');
  assert.equal(tree.internals.effectiveEnvironment({ A: 'x\0y' }, parent), null);
  assert.deepEqual(tree.internals.effectiveEnvironment({ A: '1' }, { NODE_V8_COVERAGE: 'cov' }), ['A=1', 'NODE_V8_COVERAGE=cov']);
  const unsupported = [{ shell: true }, { detached: true }, { windowsVerbatimArguments: true }, { argv0: 'x' }, { stdio: 'inherit' },
    { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }, { stdio: ['overlapped', 'pipe', 'pipe'] }, { timeout: 5 }, { cwd: 'relative' }, { env: { 'b\u00e1d': '1' } }];
  for (const options of unsupported) assert.equal(tree.internals.planCustody(process.execPath, [], { cwd: LAB, ...options }).supported, false, JSON.stringify(options));
  assert.equal(tree.internals.planCustody('definitely-missing-command-440', [], { cwd: LAB }).reason, 'unresolved');
  if (WIN) {
    const script = path.join(LAB, 'tool.cmd'); fs.writeFileSync(script, '@echo off\r\n');
    assert.equal(tree.internals.planCustody(script, [], { cwd: LAB }).reason, 'extension', '.cmd/.bat keep the plain spawn');
    const text = path.join(LAB, 'text.exe'); fs.writeFileSync(text, 'not an image');
    assert.equal(tree.internals.planCustody(text, [], { cwd: LAB }).reason, 'image');
    const plan = tree.internals.planCustody(process.execPath, ['a b'], { cwd: LAB, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    assert.equal(plan.supported, true); assert.deepEqual([...plan.modes], ['ignore', 'pipe', 'pipe']); assert.equal(plan.hide, true);
    note('packet-environment', { entries: plan.env_entries, env_chars: plan.env_chars, command_line_chars: plan.commandLine.length });
  }
});

test('T0 adapters verification helpers and xllm bytes unchanged', () => {
  const root = path.resolve(__dirname, '..');
  const delta = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/issue-440/distribution-delta.json'), 'utf8'));
  for (const [file, digestValue] of Object.entries(SOURCE_PINS)) {
    const actual = sha(file === 'scripts/forge-verification-process.js' ? require('./fixtures/issue-463/distribution.cjs').projectRead(p => fs.readFileSync(path.join(root, p)))(file) : fs.readFileSync(path.join(root, file)));
    if (['scripts/forge-appserver-client.js', 'scripts/forge-claude-sidecar.js'].includes(file)) {
      const row = delta.files[file];
      assert.equal(row.before, digestValue, 'exact immutable adapter predecessor pin');
      const preimage = require('zlib').gunzipSync(Buffer.from(row.before_gzip_base64, 'base64'), { maxOutputLength: 4 * 1024 * 1024 });
      assert.equal(sha(preimage), digestValue, 'measured real historical adapter preimage');
      const admittedPredecessor = require('./fixtures/issue-463/distribution.cjs').projectIssue463Read(p => fs.readFileSync(path.join(root, p)))(file);
      assert.equal(sha(admittedPredecessor), row.after, 'exact measured current-layer adapter predecessor');
    } else assert.equal(actual, digestValue, file);
  }
});

test('T2 custody prepared once per process and measured', async () => {
  if (!WIN) {
    const handle = await tree.prepareCustody();
    assert.equal(tree.preparationStatus(handle).available, false);
    assert.equal(tree.preparationStatus(handle).reason_code, 'process-tree-custody-unavailable');
    return;
  }
  const t = Date.now(), handle = await tree.prepareCustody(), status = tree.preparationStatus(handle);
  assert.equal(status.available, true, `custody must be available on this Windows host (blocker): ${JSON.stringify(status)}`);
  assert.equal(status.native_sha256, tree.NATIVE_SHA256);
  const again = Date.now(), cached = await tree.prepareCustody();
  assert.equal(cached, handle, 'compiled and probed once per process, memory only');
  note('custody-prepare', { ...status.timings, cached_ms: Date.now() - again, wall_ms: again - t, assembly_bytes: status.assembly_bytes });
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => /^forge-process-tree-build-[a-f0-9]{32}$/.test(name)).length, 0, 'no build directory left');
});

test('T3 record and journal exclusive outside roots without links', async () => {
  const dir = attemptDir('record');
  // Inside the owner or a code root: refused before any spawn.
  expectCode(() => tree.startAttemptTree({ command: process.execPath, args: [HELPER, 'exit', '0'], options: { cwd: dir }, resultFile: path.join(OWNER, 'r.json'), binding: binding(), roots: [OWNER, ROOT] }), 'process-tree-record-invalid');
  expectCode(() => tree.startAttemptTree({ command: process.execPath, args: [HELPER, 'exit', '0'], options: { cwd: dir }, resultFile: path.join(ROOT, 'r.json'), binding: binding(), roots: [OWNER, ROOT] }), 'process-tree-record-invalid');
  expectCode(() => tree.startAttemptTree({ command: process.execPath, args: [], options: { cwd: dir }, resultFile: path.join(dir, 'r.json'), binding: { ...binding(), extra: 1 }, roots: [OWNER] }), 'process-tree-record-invalid');
  // Junction parent aliasing the owner.
  const junction = path.join(LAB, `junction-${counter}`);
  fs.symlinkSync(OWNER, junction, 'junction');
  expectCode(() => tree.startAttemptTree({ command: process.execPath, args: [HELPER, 'exit', '0'], options: { cwd: dir }, resultFile: path.join(junction, 'r.json'), binding: binding(), roots: [OWNER, ROOT] }), 'process-tree-record-invalid');
  fs.unlinkSync(junction);
  assert.deepEqual(fs.readdirSync(OWNER), [], 'no byte written in the owner');
  // Pre-existing hardlink / symlink at the record path: exclusive creation refuses.
  const target = path.join(dir, 'other.txt'); fs.writeFileSync(target, 'x');
  const hard = path.join(dir, 'hard.json'); fs.linkSync(target, `${hard}.process-tree.jsonl`);
  expectCode(() => tree.startAttemptTree({ command: process.execPath, args: [HELPER, 'exit', '0'], options: { cwd: dir }, resultFile: hard, binding: binding(), roots: [OWNER, ROOT] }), 'process-tree-record-invalid');
  let symlinkLabel = 'exercised';
  try {
    fs.symlinkSync(target, path.join(dir, 'sym.json.process-tree.custody.jsonl'), 'file');
    expectCode(() => tree.startAttemptTree({ command: process.execPath, args: [HELPER, 'exit', '0'], options: { cwd: dir }, resultFile: path.join(dir, 'sym.json'), binding: binding(), roots: [OWNER, ROOT] }), 'process-tree-record-invalid');
  } catch (error) { if (error.code !== 'EPERM') throw error; symlinkLabel = 'SKIP platform: file symlink creation EPERM'; }
  note('record-symlink-leaf', symlinkLabel);
  // A real attempt: exclusive record + journal, nlink 1, hashes/pids/codes only.
  const started = start(dir, ['report', SECRET, PERSONAL], { env: { ...process.env, FORGE_TEST_SECRET: SECRET } });
  const seen = await observe(started.child);
  assert(seen.out.toString().includes(SECRET), 'transport received its own arguments');
  await started.tree.join();
  expectCode(() => start(dir, ['exit', '0']), 'process-tree-record-invalid'); // same result file: exclusive
  for (const file of [started.tree.recordFile, ...(started.tree.mode === 'custody' ? [started.tree.journalFile] : [])]) {
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, file);
    const text = fs.readFileSync(file, 'utf8');
    const user = os.userInfo().username;
    for (const needle of [SECRET, 'someone-private', HELPER.replace(/\\/g, '\\\\'), '"report"', process.execPath.replace(/\\/g, '\\\\'), LAB.replace(/\\/g, '\\\\'), ...(user.length >= 4 ? [user] : [])])
      assert(!text.includes(needle), `${path.basename(file)} leaked ${needle}`);
  }
  const rows = tree.internals.recordLines(fs.readFileSync(started.tree.recordFile));
  assert.equal(rows[0].kind, 'header'); assert.deepEqual(rows[0].binding, binding());
  assert.equal(rows[0].mode, WIN ? 'custody' : 'census-only');
  assert.deepEqual(rows[0].methods, [tree.CUSTODY_METHOD, tree.CENSUS_METHOD]);
  if (WIN) {
    assert.equal(rows[0].job_name, `Local\\ForgeProcessTree-${rows[0].nonce}`);
    const lines = journal(started.tree.journalFile);
    assert.deepEqual(lines.map(row => row.event), ['supervisor-started', 'custody-established', 'root-exited', 'family-empty']);
    let prev = '0'.repeat(64);
    for (const [index, line] of fs.readFileSync(started.tree.journalFile, 'utf8').split(/(?<=\n)/).filter(Boolean).entries()) {
      assert.equal(lines[index].prev, prev); assert.equal(lines[index].seq, index); prev = sha(line);
    }
    assert.equal(lines[0].nonce, rows[0].nonce); assert.equal(lines[0].packet_sha256, rows[0].packet_sha256);
    assert.equal(lines[1].job_flags, 0x2000); assert.equal(lines[1].job_handle_inheritable, 0); assert.equal(lines[1].in_job, 1);
  }
});

test('T3 tampered record journal torn tail and foreign binding never prove', async () => {
  const dir = attemptDir('tamper'), started = start(dir, ['exit', '0']);
  await observe(started.child); const joined = await started.tree.join();
  assert.equal(joined.status, WIN ? 'stopped' : 'unknown');
  const good = started.tree.prove();
  assert.equal(good.status, WIN ? 'stopped' : 'unknown');
  const foreign = tree.proveDescendantsStopped({ recordFile: started.tree.recordFile, binding: binding({ dispatch_id: 'other-attempt' }) });
  assert.deepEqual([foreign.status, foreign.reason_code], ['unknown', 'process-tree-binding-mismatch']);
  const missing = tree.proveDescendantsStopped({ recordFile: path.join(dir, 'absent.json.process-tree.jsonl'), binding: binding() });
  assert.deepEqual([missing.status, missing.reason_code], ['unknown', 'process-tree-record-missing']);
  const bytes = fs.readFileSync(started.tree.recordFile);
  fs.appendFileSync(started.tree.recordFile, '{"seq":99'); // torn tail is never evidence
  assert.deepEqual([started.tree.prove().status, started.tree.prove().reason_code], ['unknown', 'process-tree-record-invalid']);
  fs.writeFileSync(started.tree.recordFile, bytes.toString().replace('"mode"', '"mode" ')); // altered line
  assert.equal(started.tree.prove().reason_code, 'process-tree-record-invalid');
  fs.writeFileSync(started.tree.recordFile, bytes);
  if (WIN) {
    assert.equal(started.tree.prove().status, 'stopped', 'exact bytes restored');
    const journalBytes = fs.readFileSync(started.tree.journalFile);
    // Self-consistent forged journal: recomputed chain pointing to a nonexistent job.
    const forged = journal(started.tree.journalFile); let prev = '0'.repeat(64), text = '';
    forged[1].root_pid = 4; for (const row of forged) { row.prev = prev; const line = JSON.stringify(row) + '\n'; text += line; prev = sha(line); }
    fs.writeFileSync(started.tree.journalFile, text);
    assert.deepEqual([started.tree.prove().status, started.tree.prove().reason_code], ['unknown', 'process-tree-record-invalid']);
    fs.writeFileSync(started.tree.journalFile, journalBytes.subarray(0, journalBytes.length - 5)); // truncated
    assert.equal(started.tree.prove().reason_code, 'process-tree-record-invalid');
    fs.writeFileSync(started.tree.journalFile, journalBytes);
    assert.equal(started.tree.prove().status, 'stopped');
  }
});

test('T4 stdio streaming parity echo early write binary CRLF and large payload', async () => {
  const dir = attemptDir('stdio');
  const transcript = async child => {
    const lines = []; let buffer = '';
    child.stdout.on('data', d => { buffer += d; });
    const seen = observe(child);
    child.stdin.write('early\n'); // right after spawn, before the root runs
    for (const word of ['one', 'two', 'three']) {
      const until = Date.now() + 15000;
      while (!buffer.includes(`echo:${lines.length ? lines.at(-1) : 'early'}`) && Date.now() < until) await wait(10);
      lines.push(word); child.stdin.write(`${word}\n`);
    }
    child.stdin.end('quit\n');
    const result = await seen;
    return { out: result.out.toString(), err: result.err.toString(), events: shape(result.events), first: result.events.find(e => e[0] === 'first')?.[1] };
  };
  const simple = await transcript(plain(dir, ['echo-lines'], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const custody = start(dir, ['echo-lines'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const supervised = await transcript(custody.child);
  assert.equal(custody.tree.mode, WIN ? 'custody' : 'census-only');
  assert.equal(supervised.out, simple.out); assert.equal(supervised.out, 'echo:early\necho:one\necho:two\necho:three\necho:quit\n');
  assert.equal(supervised.err, ''); assert.deepEqual(supervised.events, simple.events);
  note('startup-delay-ms', { plain_first_byte: simple.first, supervised_first_byte: supervised.first });
  await custody.tree.join();
  const binary = Buffer.concat([Buffer.from([...Array(256).keys()]), Buffer.from('line\r\nnext\r\n'), Buffer.from([0, 13, 10, 255])]);
  const pipeRun = async (child, payload) => { const seen = observe(child); child.stdin.end(payload); return (await seen).out; };
  const b1 = await pipeRun(plain(dir, ['cat']), binary), c2 = start(attemptDir('cat'), ['cat']), b2 = await pipeRun(c2.child, binary);
  assert(b1.equals(binary) && b2.equals(binary), 'binary and CRLF bytes identical');
  await c2.tree.join();
  const large = crypto.randomBytes(4 * 1024 * 1024 + 17), expected = `${large.length}:${sha(large)}`;
  const h1 = await pipeRun(plain(dir, ['hash']), large), c3 = start(attemptDir('hash'), ['hash']), h2 = await pipeRun(c3.child, large);
  assert.equal(h1.toString(), expected); assert.equal(h2.toString(), expected, 'payload larger than the pipe buffer');
  await c3.tree.join();
});

test('T4 ignore form EOF ordering diagnostics argv cwd environment and executable parity', async () => {
  const dir = attemptDir('parity');
  const ignoreSimple = await observe(plain(dir, ['ignore-stdin'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const ignored = start(dir, ['ignore-stdin'], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(ignored.child.stdin, null);
  const ignoreCustody = await observe(ignored.child);
  assert.equal(ignoreCustody.err.toString(), 'stdin-eof:0'); assert.equal(ignoreSimple.err.toString(), 'stdin-eof:0');
  await ignored.tree.join();
  if (WIN) {
    // The root cannot succeed until this parent observes EOF and releases it.
    const early = (child, release) => {
      child.stdout.once('end', () => fs.writeFileSync(release, 'eof-observed'));
      return observe(child);
    };
    const closer = closerFixture();
    {
      const release = path.join(dir, 'release-detached');
      const detachedRun = await early(track(cp.spawn(closer, [release], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })), release);
      assert.equal(detachedRun.events.find(e => e[0] === 'exit')[1], 0);
      const gap = detachedRun.events.find(e => e[0] === 'exit')[3] - detachedRun.events.find(e => e[0] === 'end')[1];
      note('eof-diagnostic-plain-detached-no-console', { gap, err: detachedRun.err.toString() });
    }
    for (const hide of [true, false]) {
      const options = { cwd: dir, windowsHide: hide, stdio: ['ignore', 'pipe', 'pipe'] };
      const plainRelease = path.join(dir, `release-plain-${hide}`), custodyRelease = path.join(dir, `release-custody-${hide}`);
      const eofSimple = await early(track(cp.spawn(closer, [plainRelease], options)), plainRelease);
      const eofTree = tree.startAttemptTree({ command: closer, args: [custodyRelease], options, resultFile: path.join(attemptDir('eof'), 'r.json'), binding: binding(), roots: [OWNER] });
      track(eofTree.child); const eofCustody = await early(eofTree.child, custodyRelease);
      assert.equal(eofTree.tree.mode, 'custody');
      const gap = run => run.events.find(e => e[0] === 'exit')[3] - run.events.find(e => e[0] === 'end')[1];
      note(`eof-before-exit-gap-ms-hide-${hide}`, { plain: gap(eofSimple), supervised: gap(eofCustody), plain_err: eofSimple.err.toString(), supervised_err: eofCustody.err.toString() });
      // Exit zero requires the release marker, written only after stdout EOF.
      // No arbitrary elapsed-time threshold is used as a liveness proof.
      for (const run of [eofSimple, eofCustody]) {
        assert.equal(run.out.toString(), 'x');
        assert.equal(run.events.find(e => e[0] === 'exit')[1], 0, run.err.toString());
        assert(run.err.toString().includes('released-after-eof:True'));
        assert(gap(run) >= 0, `stdout EOF never after exit: ${JSON.stringify(run.events)}`);
      }
      await eofTree.tree.join();
    }
  }
  const argv = ['a b', 'quote"inside', 'trailing\\', 'space trailing\\ ', '', '\u03a9\u00fc unicode', 'tab\tsep', 'back\\\\"q'];
  const minimal = { FOO: 'bar', Path: process.env.Path || process.env.PATH, PSModulePath: 'C:\\fixture-modules' };
  for (const [label, options] of [['full', {}], ['minimal', { env: minimal }]]) {
    const cwd = attemptDir(`cwd-${label}`);
    const a = await observe(plain(cwd, ['report', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], ...options }));
    const s = start(cwd, ['report', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], ...options }), b = await observe(s.child);
    const left = JSON.parse(a.out), right = JSON.parse(b.out);
    assert.deepEqual(right.argv, argv); assert.deepEqual(right, left, `${label}: argv, cwd, full effective environment (order included) and executable`);
    if (WIN) assert(right.env.some(([key]) => key.toUpperCase() === 'SYSTEMROOT'), 'libuv required variables');
    if (label === 'full') assert.equal(right.env.find(([key]) => key === 'PSModulePath')?.[1], process.env.PSModulePath, 'PSModulePath untouched by the supervisor');
    await s.tree.join();
  }
  // Bare name through the effective PATH (cwd first, then PATH; literal/.com/.exe).
  if (WIN) {
    const bare = tree.internals.planCustody('node', [], { cwd: dir });
    if (bare.supported) {
      const a = await observe(track(cp.spawn('node', [HELPER, 'report'], { cwd: dir, windowsHide: true })));
      const s = tree.startAttemptTree({ command: 'node', args: [HELPER, 'report'], options: { cwd: dir, windowsHide: true }, resultFile: path.join(attemptDir('bare'), 'r.json'), binding: binding(), roots: [OWNER] });
      track(s.child); const b = await observe(s.child);
      assert.equal(JSON.parse(b.out).execPath, JSON.parse(a.out).execPath); assert.equal(s.tree.mode, 'custody');
      await s.tree.join();
    } else note('bare-node-resolution', bare.reason);
  }
});

test('T4 exit code mirror kill and pid parity', async () => {
  for (const code of [0, 1, 255, -1073741819, tree.RESERVED_EXIT]) {
    const dir = attemptDir('exit');
    const a = await observe(plain(dir, ['exit', String(code)])), s = start(dir, ['exit', String(code)]), b = await observe(s.child);
    assert.deepEqual(shape(b.events), shape(a.events), `exit ${code}`);
    const runs = tree.internals.observerRuns(), joined = await s.tree.join();
    assert.equal(joined.status, WIN ? 'stopped' : 'unknown');
    if (WIN) assert.equal(tree.internals.observerRuns(), runs, 'join after family-empty launches no observer');
    if (WIN) {
      const lines = journal(s.tree.journalFile);
      assert.equal(lines.find(row => row.event === 'root-exited').exit_code, code < 0 ? code + 2 ** 32 : code);
      assert(!lines.some(row => row.event === 'custody-failed'), 'a legitimate reserved exit is a root exit, never custody-failed');
    }
  }
  if (!WIN) return;
  const dir = attemptDir('kill');
  const simple = plain(dir, ['sleep', dir, 'plain']); await waitFile(path.join(dir, 'plain.json'));
  const simpleSeen = observe(simple); simple.kill(); const killedPlain = await simpleSeen;
  const s = start(dir, ['sleep', dir, 'custody']), marker = await waitFile(path.join(dir, 'custody.json'));
  const root = remember(marker.pid);
  const lines = journal(s.tree.journalFile);
  assert.equal(s.child.pid, lines[0].supervisor_pid, 'child.pid is the supervisor');
  assert.equal(lines[1].root_pid, marker.pid); assert.notEqual(s.child.pid, marker.pid);
  const seen = observe(s.child); s.child.kill(); const killed = await seen;
  assert.deepEqual(shape(killed.events), shape(killedPlain.events), 'kill parity');
  assert.notEqual(identityState(root), 'alive', 'the supervisor life contains the root life');
  assert.equal((await s.tree.join()).status, 'stopped');
});

test('T5 grandchild surviving its parent stays a member until the empty job', async () => {
  if (!WIN) return;
  const dir = attemptDir('survivor'), s = start(dir, ['survivor-root', dir], { stdio: 'ignore' });
  const grandchild = remember((await waitFile(path.join(dir, 'grandchild.json'))).pid);
  await waitFile(path.join(dir, 'root.json'));
  assert.equal(identityState(grandchild), 'alive');
  const alive = s.tree.prove();
  assert.deepEqual([alive.status, alive.reason_code, alive.method], ['alive', 'process-tree-survivors', tree.CUSTODY_METHOD]);
  const seen = observe(s.child); fs.writeFileSync(path.join(dir, 'release-root'), '');
  await seen;
  const joined = await s.tree.join();
  assert.equal(joined.status, 'stopped', 'stopped only after the supervisor observed the empty job');
  assert.notEqual(identityState(grandchild), 'alive', 'survivor terminated by the job before the supervisor exit (declared difference)');
  const family = journal(s.tree.journalFile).at(-1);
  assert.equal(family.event, 'family-empty'); assert(family.survivors >= 1, JSON.stringify(family));
});

test('T5 adversarial ephemeral intermediate between census samples with live orphan', async () => {
  // Census only (custody unavailable injected on win32, native elsewhere).
  const degraded = await tree.prepareCustody({ inject: 'probe' });
  assert.equal(tree.preparationStatus(degraded).available, false);
  const dir = attemptDir('ephemeral-census'), s = start(dir, ['ephemeral-root', dir], { stdio: 'ignore' }, { preparation: degraded, sampleIntervalMs: 60000 });
  assert.equal(s.tree.mode, 'census-only'); assert.equal(s.tree.method, tree.CENSUS_METHOD);
  await waitFile(path.join(dir, 'root.json'));
  const until = Date.now() + 30000; // first diagnostic sample taken BEFORE the intermediate exists
  while (!fs.readFileSync(s.tree.recordFile, 'utf8').includes('"kind":"sample"') && Date.now() < until) await wait(50);
  const before = tree.snapshot();
  fs.writeFileSync(path.join(dir, 'go'), '');
  const intermediate = (await waitFile(path.join(dir, 'intermediate.json'))).pid;
  const orphan = remember((await waitFile(path.join(dir, 'orphan.json'))).pid);
  await waitFile(path.join(dir, 'root-ready.json')); await wait(200);
  const after = tree.snapshot();
  if (before.status === 'ok' && after.status === 'ok') {
    assert(!before.rows.some(row => row.pid === intermediate) && !after.rows.some(row => row.pid === intermediate), 'intermediate exists in neither sample');
  }
  assert.equal(identityState(orphan), 'alive');
  for (const proof of [s.tree.prove(), tree.proveDescendantsStopped({ recordFile: s.tree.recordFile, binding: binding() })])
    assert.deepEqual([proof.status, proof.method], ['alive', tree.CENSUS_METHOD], 'a registered identity (the root) still lives');
  const seen = observe(s.child); fs.writeFileSync(path.join(dir, 'release-root'), ''); await seen;
  assert.equal(identityState(orphan), 'alive', 'orphan outlives every registered member');
  const late = s.tree.prove();
  assert.deepEqual([late.status, late.method], ['unknown', tree.CENSUS_METHOD], 'census never yields stopped, even after root and members died');
  assert(['process-tree-census-only', 'process-tree-custody-unavailable', 'process-tree-unavailable'].includes(late.reason_code));
  assert.notEqual((await s.tree.join()).status, 'stopped');
  fs.writeFileSync(path.join(dir, 'release-orphan'), '');
  if (!WIN) return;
  // Same scenario under custody: alive while the orphan lives, stopped only after the empty job.
  const cdir = attemptDir('ephemeral-custody'), c = start(cdir, ['ephemeral-root', cdir], { stdio: 'ignore' });
  assert.equal(c.tree.mode, 'custody');
  await waitFile(path.join(cdir, 'root.json')); fs.writeFileSync(path.join(cdir, 'go'), '');
  const corphan = remember((await waitFile(path.join(cdir, 'orphan.json'))).pid);
  await waitFile(path.join(cdir, 'root-ready.json')); await wait(100);
  const live = c.tree.prove();
  assert.deepEqual([live.status, live.reason_code], ['alive', 'process-tree-survivors']); assert(live.evidence.active >= 2);
  const cseen = observe(c.child); fs.writeFileSync(path.join(cdir, 'release-root'), ''); await cseen;
  assert.equal((await c.tree.join()).status, 'stopped');
  assert.notEqual(identityState(corphan), 'alive', 'orphan confirmed dead by the identity it reported');
});

test('T5 nested libuv members and breakaway request stay inside the job', async () => {
  if (!WIN) return;
  const dir = attemptDir('nested'), s = start(dir, ['nested', dir, '0'], { stdio: 'ignore' });
  const members = [];
  for (let depth = 0; depth <= 3; depth++) members.push(remember((await waitFile(path.join(dir, `nested-${depth}.json`))).pid));
  const header = tree.internals.recordLines(fs.readFileSync(s.tree.recordFile))[0];
  const observed = cp.spawnSync(tree.POWERSHELL, tree.SUPERVISOR_ARGS, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: nativeEnv(['1', 'observe', header.job_name, members.map(m => `${m.pid}:${m.created}`).join(';')]) });
  const view = JSON.parse(observed.stdout);
  assert.equal(view.job, 'open');
  assert.deepEqual(view.ids.map(row => [row.state, row.in_job]), members.map(() => ['alive', 1]), 'children, grandchildren and great-grandchildren of Node members (nested libuv job) are members');
  // Name collision (ERROR_ALREADY_EXISTS 183) is refused by the same native create path.
  const collision = cp.spawnSync(tree.POWERSHELL, tree.SUPERVISOR_ARGS, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: nativeEnv(['1', 'probe', header.job_name]) });
  assert.deepEqual(JSON.parse(collision.stdout), { ok: 0, stage: 'job-collision', native_error: 183 });
  const seen = observe(s.child); fs.writeFileSync(path.join(dir, 'release-nested'), ''); await seen;
  assert.equal((await s.tree.join()).status, 'stopped');
  for (const member of members) assert.notEqual(identityState(member), 'alive');
  // A member asking CREATE_BREAKAWAY_FROM_JOB is refused (ERROR_ACCESS_DENIED).
  const cmd = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
  const breakEnv = { ...process.env, ...nativeEnv(['1', 'breakaway', cmd, `"${cmd}" /d /c exit 0`]) };
  const b = tree.startAttemptTree({ command: tree.POWERSHELL, args: tree.SUPERVISOR_ARGS, options: { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: breakEnv },
    resultFile: path.join(attemptDir('breakaway'), 'r.json'), binding: binding(), roots: [OWNER] });
  track(b.child); const result = await observe(b.child);
  assert.equal(b.tree.mode, 'custody');
  assert.deepEqual(JSON.parse(result.out), { created: 0, native_error: 5 });
  assert.equal((await b.tree.join()).status, 'stopped');
});

// Test-only fixture program, compiled into the temporary laboratory (removed in
// finally) by the runtime csc with /noconfig and fixed references.
let closerPath = null;
function closerFixture() {
  if (closerPath) return closerPath;
  const runtime = path.join(process.env.SystemRoot, 'Microsoft.NET', process.arch === 'x64' || process.arch === 'arm64' ? 'Framework64' : 'Framework', 'v4.0.30319');
  const source = path.join(LAB, 'closer.cs'), out = path.join(LAB, 'closer.exe');
  fs.writeFileSync(source, 'using System;using System.Runtime.InteropServices;public static class Closer{[DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);'
    + '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);[DllImport("kernel32.dll")] static extern bool WriteFile(IntPtr h,byte[] b,uint n,out uint w,IntPtr o);'
    + '[DllImport("kernelbase.dll")] static extern bool CompareObjectHandles(IntPtr a,IntPtr b);'
    + 'public static int Main(string[] args){if(args.Length!=1)return 5;IntPtr h=GetStdHandle(-11);uint w;WriteFile(h,new byte[]{120},1,out w,IntPtr.Zero);'
    + 'for(int i=4;i<65536;i+=4){IntPtr a=new IntPtr(i);if(a!=h&&CompareObjectHandles(h,a))CloseHandle(a);}CloseHandle(h);'
    + 'DateTime until=DateTime.UtcNow.AddSeconds(15);while(!System.IO.File.Exists(args[0])&&DateTime.UtcNow<until)System.Threading.Thread.Sleep(5);bool released=System.IO.File.Exists(args[0]);'
    + 'IntPtr r=GetStdHandle(-12);byte[] m=System.Text.Encoding.ASCII.GetBytes("released-after-eof:"+released);WriteFile(r,m,(uint)m.Length,out w,IntPtr.Zero);return released?0:7;}}');
  const result = cp.spawnSync(path.join(runtime, 'csc.exe'), ['/noconfig', '/nologo', '/target:winexe', '/nostdlib+', `/reference:${path.join(runtime, 'mscorlib.dll')}`, `/out:${out}`, source], { windowsHide: true, encoding: 'utf8', cwd: LAB });
  assert.equal(result.status, 0, result.stdout);
  return (closerPath = out);
}
function nativeEnv(fields) {
  const assembly = tree.nativeAssembly(), text = `${assembly}:${fields.map(f => Buffer.from(f, 'utf8').toString('base64')).join('.')}`, out = {};
  const parts = Math.ceil(text.length / 30000);
  for (let i = 0; i < parts; i++) out[`FORGE_PROCESS_TREE_${i}`] = text.slice(i * 30000, (i + 1) * 30000);
  out.FORGE_PROCESS_TREE_PARTS = String(parts);
  return out;
}
function holder(jobName) {
  const script = [
    "$ErrorActionPreference='Stop';$n=[int]$env:FORGE_PROCESS_TREE_PARTS;$s=New-Object Text.StringBuilder",
    "for($i=0;$i -lt $n;$i++){[void]$s.Append([Environment]::GetEnvironmentVariable('FORGE_PROCESS_TREE_'+$i))}",
    "$t=$s.ToString();[void][Reflection.Assembly]::Load([Convert]::FromBase64String($t.Substring(0,$t.IndexOf(':'))))",
    '$h=[ForgeProcessTree]::OpenQuery($env:FORGE_TREE_HOLD);if($h -eq [IntPtr]::Zero){[Console]::Out.WriteLine(\'none\');exit 2}',
    "[Console]::Out.WriteLine('held');[Console]::Out.Flush();[void][Console]::In.ReadLine();[ForgeProcessTree]::Release($h);exit 0",
  ].join('\n');
  const child = track(cp.spawn(tree.POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...nativeEnv(['1']), FORGE_TREE_HOLD: jobName } }));
  return new Promise((resolve, reject) => {
    let out = ''; child.stdout.on('data', d => { out += d; if (out.includes('held')) resolve(child); if (out.includes('none')) reject(new Error('job not found')); });
    child.on('exit', () => reject(new Error('holder exited')));
  });
}

test('T6 supervisor killed by child.kill and terminateOwnedProcessTree with live orphan', async () => {
  if (!WIN) return;
  const xllm = require('./forge-xllm');
  for (const [label, kill] of [['child.kill', child => child.kill()], ['terminateOwnedProcessTree', child => xllm.terminateOwnedProcessTree(child)]]) {
    const dir = attemptDir('killed'), s = start(dir, ['ephemeral-root', dir], { stdio: 'ignore' });
    await waitFile(path.join(dir, 'root.json')); fs.writeFileSync(path.join(dir, 'go'), '');
    const orphan = remember((await waitFile(path.join(dir, 'orphan.json'))).pid);
    await waitFile(path.join(dir, 'root-ready.json'));
    assert.equal(s.tree.prove().status, 'alive');
    const seen = observe(s.child); kill(s.child); await seen; await wait(200);
    assert.notEqual(identityState(orphan), 'alive', `${label}: KILL_ON_JOB_CLOSE ended the whole family`);
    const proof = s.tree.prove();
    assert.deepEqual([proof.status, proof.reason_code], ['stopped', null], `${label}: job closed and absent`);
    // child.kill ends the supervisor first (no family line); taskkill /T may
    // reach the root first, so the supervisor may still journal its last lines.
    const familyLine = journal(s.tree.journalFile).some(row => row.event.startsWith('family-'));
    if (label === 'child.kill') assert(!familyLine, 'killed supervisor wrote no family line');
    const runs = tree.internals.observerRuns();
    assert.equal((await s.tree.join()).status, 'stopped');
    assert(tree.internals.observerRuns() - runs <= 1, 'without family-empty the join makes at most one bounded observation');
    if (label === 'child.kill') assert.equal(tree.internals.observerRuns(), runs + 1);
  }
});

test('T6 external handle holder restart forged empty job and observer unavailable', async () => {
  if (!WIN) return;
  const dir = attemptDir('holder'), s = start(dir, ['ephemeral-root', dir], { stdio: 'ignore' });
  await waitFile(path.join(dir, 'root.json')); fs.writeFileSync(path.join(dir, 'go'), '');
  const orphan = remember((await waitFile(path.join(dir, 'orphan.json'))).pid);
  await waitFile(path.join(dir, 'root-ready.json'));
  const jobName = tree.internals.recordLines(fs.readFileSync(s.tree.recordFile))[0].job_name;
  const held = await holder(jobName);
  const seen = observe(s.child); s.child.kill(); await seen; await wait(200);
  assert.equal(identityState(orphan), 'alive', 'an external handle keeps the job (and its members) alive');
  assert.deepEqual([s.tree.prove().status, s.tree.prove().reason_code], ['alive', 'process-tree-survivors']);
  const unavailable = s.tree.prove({ timeoutMs: 1 });
  assert.deepEqual([unavailable.status, unavailable.reason_code], ['unknown', 'process-tree-unavailable'], 'observer unavailable');
  const released = new Promise(resolve => held.on('exit', resolve)); held.stdin.end('\n'); await released; await wait(200);
  assert.notEqual(identityState(orphan), 'alive');
  assert.equal(s.tree.prove().status, 'stopped', 'stopped only after the external handle closed');
  // Open but EMPTY job held externally after a normal exit.
  const edir = attemptDir('empty'), e = start(edir, ['sleep', edir, 'root'], { stdio: 'ignore' });
  remember((await waitFile(path.join(edir, 'root.json'))).pid);
  const emptyName = tree.internals.recordLines(fs.readFileSync(e.tree.recordFile))[0].job_name, keep = await holder(emptyName);
  const eseen = observe(e.child); fs.writeFileSync(path.join(edir, 'release-root'), ''); await eseen;
  assert.equal((await e.tree.join()).status, 'stopped');
  const inProcess = e.tree.prove();
  assert.deepEqual([inProcess.status, inProcess.evidence.active], ['stopped', 0], 'job open with zero active processes');
  // Restart: a fresh Node process has no live origin, even with a valid journal and an empty (or absent) job.
  const fresh = record => JSON.parse(cp.execFileSync(process.execPath, ['-e',
    `const t=require(${JSON.stringify(path.join(__dirname, 'forge-process-tree.js'))});const p=t.proveDescendantsStopped(${JSON.stringify({ recordFile: record, binding: binding() })});process.stdout.write(JSON.stringify([p.status,p.reason_code]))`], { encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(fresh(e.tree.recordFile), ['unknown', 'process-tree-custody-unproved'], 'restart with open empty job');
  assert.deepEqual(fresh(s.tree.recordFile), ['unknown', 'process-tree-custody-unproved'], 'restart with absent job');
  // Forged self-consistent record/journal (same binding, recomputed hashes) pointing to the REAL empty job.
  const fdir = attemptDir('forged'), forgedRecord = path.join(fdir, 'r.json.process-tree.jsonl');
  fs.copyFileSync(e.tree.recordFile, forgedRecord); fs.copyFileSync(e.tree.journalFile, path.join(fdir, 'r.json.process-tree.custody.jsonl'));
  const forged = tree.proveDescendantsStopped({ recordFile: forgedRecord, binding: binding() });
  assert.deepEqual([forged.status, forged.reason_code], ['unknown', 'process-tree-custody-unproved'], 'no lookup by a name read from a file creates an origin');
  const kept = new Promise(resolve => keep.on('exit', resolve)); keep.stdin.end('\n'); await kept;
  // Synthetic PID reuse: same pid with another creation instant is not the same identity.
  const self = tree.identities([{ pid: process.pid }])[0];
  assert.equal(tree.identities([{ pid: process.pid, created: String(BigInt(self.created) + 1n) }])[0].state, 'reused');
  assert.equal(tree.identities([{ pid: process.pid, created: self.created }])[0].state, 'alive');
  const facts = { started: true, established: true, failed: false, unproved: false, session: 1, appcontainer: 0, supervisor_pid: 10, root_pid: 11, job_flags: 0x2000, supervisorRunning: false };
  const absent = (sup, root) => ({ session: 1, appcontainer: 0, job: 'absent', ids: [{ pid: 10, state: sup }, { pid: 11, state: root }] });
  assert.equal(tree.internals.evaluateCustody(facts, absent('reused', 'reused')).status, 'stopped');
  assert.equal(tree.internals.evaluateCustody(facts, absent('absent', 'alive')).status, 'alive', 'identity equal to a live process is alive');
  assert.equal(tree.internals.evaluateCustody(facts, absent('alive', 'absent')).status, 'unknown', 'supervisor alive with the job absent');
  assert.equal(tree.internals.evaluateCustody({ ...facts, unproved: true }, absent('absent', 'absent')).status, 'unknown');
  assert.equal(tree.internals.evaluateCustody(facts, { ...absent('absent', 'absent'), session: 2 }).status, 'unknown', 'different namespace');
  assert.equal(tree.internals.evaluateCustody(facts, { ...absent('absent', 'absent'), job: 'denied' }).status, 'unknown', 'access denied');
  assert.equal(tree.internals.evaluateCustody({ ...facts, established: false }, absent('absent', 'absent')).status, 'unknown', 'never established');
  assert.equal(tree.internals.evaluateCustody(facts, null).reason_code, 'process-tree-unavailable');
  assert.equal(tree.internals.evaluateCustody(facts, { session: 1, appcontainer: 0, job: 'absent', ids: [{ pid: 10, state: 'absent' }] }).reason_code, 'process-tree-root-unbound', 'root identity not bound by the observation');
  assert.equal(tree.internals.evaluateCustody(facts, absent('denied', 'absent')).status, 'unknown', 'identity access denied');
  assert.deepEqual(tree.internals.evaluateCustody(facts, { session: 1, appcontainer: 0, job: 'open', active: 0, flags: 0x2000 | 0x800, ids: [{ pid: 10, state: 'absent' }, { pid: 11, state: 'absent' }] }),
    { status: 'unknown', reason_code: 'process-tree-custody-unproved' }, 're-read limits must equal KILL_ON_JOB_CLOSE only');
});

test('T6 census identities pid reuse and unavailable snapshot runner', () => {
  const census = { status: 'ok', rows: [{ pid: 50, ppid: 1, started_ms: 1000 }, { pid: 51, ppid: 50, started_ms: 1001 }] };
  assert.deepEqual(tree.internals.evaluateCensus([[50, 1000]], census).status, 'alive');
  assert.deepEqual(tree.internals.evaluateCensus([[50, 999]], census), { status: 'unknown', reason_code: 'process-tree-census-only', alive: 0 }, 'pid reuse is not identity');
  assert.equal(tree.internals.evaluateCensus([], census).reason_code, 'process-tree-custody-unavailable');
  assert.equal(tree.internals.evaluateCensus([[50, 1000]], { status: 'unavailable' }).reason_code, 'process-tree-unavailable');
  assert.deepEqual(tree.internals.descendantsOf([...census.rows, { pid: 52, ppid: 50, started_ms: 10 }], 50), [[50, 1000], [51, 1001]], 'older pid with a reused parent pid is not a descendant');
  for (const runner of [() => ({ status: 1, stdout: '' }), () => ({ error: new Error('ETIMEDOUT'), status: null }), () => ({ status: 0, stdout: 'garbage line' }), () => { throw new Error('boom'); }])
    assert.deepEqual([tree.snapshot({ runner, platform: 'win32' }).status, tree.snapshot({ runner, platform: 'win32' }).reason_code], ['unavailable', 'process-tree-unavailable']);
  const injected = tree.snapshot({ platform: 'darwin', runner: () => ({ status: 0, stdout: '  10     1 Sat Nov 21 17:39:04 2026\n  11 10 Sat Nov 21 17:39:05 2026\n' }) });
  assert.equal(injected.status, 'ok'); assert.deepEqual(injected.rows.map(row => [row.pid, row.ppid]), [[10, 1], [11, 10]]);
  const t = Date.now(), real = tree.snapshot();
  note('snapshot-real', { status: real.status, rows: real.rows?.length || 0, ms: Date.now() - t, method: real.method });
  assert.equal(real.method, tree.CENSUS_METHOD);
});

test('T6 injected supervision unavailability and unsupported forms use the plain spawn', async () => {
  for (const inject of ['compile', 'powershell', 'probe']) {
    const handle = await tree.prepareCustody({ inject }), status = tree.preparationStatus(handle);
    assert.deepEqual([status.available, status.reason_code], [false, 'process-tree-custody-unavailable'], inject);
    const dir = attemptDir(`inject-${inject}`);
    const a = await observe(plain(dir, ['report', 'x'], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const s = start(dir, ['report', 'x'], { stdio: ['ignore', 'pipe', 'pipe'] }, { preparation: handle }), b = await observe(s.child);
    assert.equal(s.tree.mode, 'census-only'); assert.deepEqual(JSON.parse(b.out), JSON.parse(a.out), `${inject}: identical plain spawn`);
    const header = tree.internals.recordLines(fs.readFileSync(s.tree.recordFile))[0];
    assert.equal(header.reason_code, 'process-tree-custody-unavailable');
    assert.notEqual((await s.tree.join()).status, 'stopped'); assert.notEqual(s.tree.prove().status, 'stopped');
  }
  const dir = attemptDir('unsupported');
  const s = tree.startAttemptTree({ command: `"${process.execPath}" "${HELPER}" exit 0`, args: [], options: { cwd: dir, shell: true, windowsHide: true }, resultFile: path.join(dir, 'r.json'), binding: binding(), roots: [OWNER] });
  track(s.child); await observe(s.child);
  assert.equal(s.tree.mode, 'census-only'); assert.equal(tree.internals.recordLines(fs.readFileSync(s.tree.recordFile))[0].unsupported, WIN ? 'shell' : 'platform');
  assert.notEqual((await s.tree.join()).status, 'stopped');
  // ENOENT / not-an-image / read-denied: same events as the plain spawn.
  const missing = async run => {
    let child;
    try { child = run(); } catch (error) { return ['throw', error.code]; }
    track(child); const seen = await observe(child); return [child.pid, shape(seen.events)];
  };
  const m1 = await missing(() => cp.spawn('definitely-missing-440', [], { windowsHide: true }));
  const m2 = await missing(() => tree.startAttemptTree({ command: 'definitely-missing-440', args: [], options: { windowsHide: true }, resultFile: path.join(attemptDir('enoent'), 'r.json'), binding: binding(), roots: [OWNER] }).child);
  assert.deepEqual(m2, m1); assert(m1[1].includes('["error","ENOENT"]'), JSON.stringify(m1)); assert.equal(m1[0], undefined);
  if (!WIN) return;
  const bad = path.join(attemptDir('image'), 'bad.exe'); fs.writeFileSync(bad, 'not an image');
  let e1, e2;
  try { cp.spawn(bad, [], { windowsHide: true }); } catch (error) { e1 = error; }
  try { tree.startAttemptTree({ command: bad, args: [], options: { windowsHide: true }, resultFile: path.join(attemptDir('image'), 'r.json'), binding: binding(), roots: [OWNER] }); } catch (error) { e2 = error; }
  assert.equal(e2?.code, e1?.code, 'not-an-image keeps the plain spawn error'); assert(tree.isSpawnError(e2));
  const denied = path.join(attemptDir('denied'), 'denied.exe'); fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), denied);
  const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  try {
    assert.equal(cp.spawnSync(icacls, [denied, '/deny', '*S-1-1-0:(R)'], { windowsHide: true }).status, 0);
    const d1 = await missing(() => cp.spawn(denied, [], { windowsHide: true }));
    const d2 = await missing(() => tree.startAttemptTree({ command: denied, args: [], options: { windowsHide: true }, resultFile: path.join(attemptDir('eacces'), 'r.json'), binding: binding(), roots: [OWNER] }).child);
    assert.deepEqual(d2, d1, 'read-denied image keeps the plain spawn access error (same sync throw or async event)');
    note('read-denied-spawn', d1);
    // Residual root CreateProcess failure (execute denied, read allowed): named
    // custody-failed with the native error; the transport never ran uncontained.
    assert.equal(cp.spawnSync(icacls, [denied, '/reset'], { windowsHide: true }).status, 0);
    assert.equal(cp.spawnSync(icacls, [denied, '/deny', '*S-1-1-0:(X)'], { windowsHide: true }).status, 0);
    const x1 = await missing(() => cp.spawn(denied, [], { windowsHide: true }));
    const r = tree.startAttemptTree({ command: denied, args: [], options: { windowsHide: true }, resultFile: path.join(attemptDir('residual'), 'r.json'), binding: binding(), roots: [OWNER] });
    track(r.child); const x2 = await observe(r.child);
    const failed = journal(r.tree.journalFile).at(-1);
    assert.deepEqual([failed.event, failed.stage, failed.native_error, failed.root_started], ['custody-failed', 'root-create', 5, 0]);
    assert.equal(x2.events.find(e => e[0] === 'exit')[1], tree.RESERVED_EXIT);
    assert.equal(x2.out.length, 0, 'the root never executed');
    const proof = r.tree.prove();
    assert.deepEqual([proof.status, proof.reason_code], ['unknown', 'process-tree-custody-failed']);
    assert.notEqual((await r.tree.join()).status, 'stopped');
    note('declared-divergence-residual-root-create', { plain: x1[1], supervised: shape(x2.events), journal: failed });
  } finally { cp.spawnSync(icacls, [denied, '/reset'], { windowsHide: true }); }
});

test('T7 proof handle and writer observation reject live origin record growth', async () => {
  if (!WIN) return;
  const dir = attemptDir('proof-growth'), s = start(dir, ['exit', '0']);
  await observe(s.child);
  const before = s.tree.prove();
  assert.equal(before.status, 'stopped');
  const receiptFile = path.join(dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: 'fixture-tree', fingerprint: 'fixture-fingerprint', recovery_identity_sha256: 'r', route: { host_runtime: 'claude' }, provider_called: false }));
  const adapter = transition.createWriterObservationAdapter(challenge => ({ ...challenge, status: 'stopped',
    binding_sha256: require('./forge-code-roots').digest(challenge), writer_identity: 'fixture-writer', evidence_reference: 'fixture actual join' }));
  const options = descendants => ({ receiptFile, contract: { owner: OWNER }, processProbe: () => 'stopped', assertUnchanged: () => {}, descendants });
  const writer = await transition.observeStoppedWriter(adapter, options(before.handle));
  assert.equal((await s.tree.join()).status, 'stopped');
  const after = s.tree.prove();
  assert.equal(after.status, 'stopped');
  assert.notEqual(after.evidence.record_sha256, before.evidence.record_sha256, 'the live origin appended its join');
  assert.equal(after.evidence.journal_sha256, before.evidence.journal_sha256);
  expectCode(() => tree.assertDescendants(before.handle), 'process-tree-record-invalid');
  expectCode(() => transition.assertWriterObservation(writer), 'writer-observation-descendants-changed');
  assert.equal(tree.assertDescendants(after.handle).status, 'stopped', 'a new proof binds the current bytes');
  transition.assertWriterObservation(await transition.observeStoppedWriter(adapter, options(after.handle)));
});

test('T7 non-ASCII TEMP only in the compiler environment', async () => {
  if (!WIN) return;
  const temp = path.join(LAB, 'temp-\u00e1-\u03a9'); fs.mkdirSync(temp);
  const t = Date.now(), handle = await tree.prepareCustody({ temp }), status = tree.preparationStatus(handle);
  assert(status.available === true || status.reason_code === 'process-tree-custody-unavailable', JSON.stringify(status));
  assert.deepEqual(fs.readdirSync(temp), [], 'private build directory removed after the compiler join');
  note('temp-non-ascii-compile', { available: status.available, stage: status.stage, ms: Date.now() - t, process_temp_ascii: /^[\x20-\x7e]*$/.test(os.tmpdir()) });
  if (status.available) {
    const dir = attemptDir('unicode'), s = start(dir, ['exit', '0'], {}, { preparation: handle });
    await observe(s.child); assert.equal(s.tree.mode, 'custody'); assert.equal((await s.tree.join()).status, 'stopped');
  } else {
    const dir = attemptDir('unicode'), s = start(dir, ['exit', '0'], {}, { preparation: handle });
    await observe(s.child); assert.equal(s.tree.mode, 'census-only'); assert.notEqual((await s.tree.join()).status, 'stopped');
  }
});

test('T7 environment PowerShell TEMP antivirus and costs', () => {
  if (!WIN) { note('platform', { platform: process.platform, custody: 'unavailable (prova unknown, abandono recusa)' }); return; }
  const script = "$ErrorActionPreference='SilentlyContinue';$av=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { $_.displayName });"
    + "[Console]::Out.Write((@{ps=$PSVersionTable.PSVersion.ToString();language=$ExecutionContext.SessionState.LanguageMode.ToString();clr=[Environment]::Version.ToString();av=$av}|ConvertTo-Json -Compress))";
  const r = cp.spawnSync(tree.POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let value = null; try { value = JSON.parse(r.stdout); } catch { value = { raw_status: r.status }; }
  note('powershell-antivirus', value);
  note('temp', { ascii: /^[\x20-\x7e]*$/.test(os.tmpdir()), contains_space: os.tmpdir().includes(' ') });
  const t = Date.now(); const id = tree.identities([{ pid: process.pid }]);
  note('observation-ms', Date.now() - t); assert.equal(id[0].state, 'alive');
  note('default-sample-interval-ms', tree.DEFAULT_SAMPLE_INTERVAL_MS);
});

// ── Seams ───────────────────────────────────────────────────────────────────
async function activityFixture(fn) {
  const lab = require('./forge-code-roots.test'), f = lab.fixture(), saved = { ...process.env };
  try {
    const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
    Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: path.resolve(__dirname, '..') });
    return await fn(f);
  } finally { process.env = saved; f.cleanup(); }
}
for (const host of ['claude', 'codex']) {
  test(`T8 scope.spawn custody seam host ${host}${host === 'claude' ? ' worker codex' : ''}`, () => activityFixture(async f => {
    const { activityRequest } = require('./forge-issues-429-432.test');
    const activity = require('./forge-protected-owner-activity'), execution = require('./forge-task-execution');
    const request = activityRequest(f, host);
    let join = null, pid = null, rootPid = null;
    const ownerBefore = Object.keys(execution.protectedSnapshot(f.owner)).sort(), rootBefore = Object.keys(execution.protectedSnapshot(f.a)).sort();
    await activity.withExecutionActivity(request, {}, async () => {
      const scope = activity.currentScope(); assert(scope);
      const child = scope.spawn(process.execPath, [HELPER, 'echo-lines'], { cwd: f.a, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      track(child); pid = child.pid;
      expectCode(() => scope.spawn(process.execPath, [HELPER, 'exit', '0'], { cwd: f.a }), 'protected-owner-writer-exists');
      const seen = observe(child); child.stdin.end('hello\n'); const result = await seen;
      assert.equal(result.out.toString(), 'echo:hello\neof\n');
      join = await scope.joinWriter();
    });
    assert.equal(join.joined, true); assert.equal(join.possible_writers, 0); assert.equal(join.pid, pid);
    assert(Object.isFrozen(join) && Object.isFrozen(join.descendants));
    assert.deepEqual(Object.keys(join.descendants), ['status', 'method', 'record_sha256']);
    const record = `${request.resultFile}.process-tree.jsonl`;
    assert(fs.existsSync(record), 'record next to resultFile');
    assert.equal(join.descendants.record_sha256, sha(fs.readFileSync(record)));
    const header = tree.internals.recordLines(fs.readFileSync(record))[0];
    const recovery = require('./forge-attempt-recovery'), roots = require('./forge-code-roots');
    assert.deepEqual(header.binding, { dispatch_id: request.dispatchId, fingerprint: require('./forge-unit-sidecar').artifactFingerprint(request),
      recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request))), unit: 'execute-task/T01',
      claim_generation: request.claim.generation, lease_generation: header.binding.lease_generation });
    assert(Number.isSafeInteger(header.binding.lease_generation) || typeof header.binding.lease_generation === 'string');
    if (WIN) {
      assert.deepEqual([join.descendants.status, join.descendants.method], ['stopped', tree.CUSTODY_METHOD]);
      rootPid = journal(`${request.resultFile}.process-tree.custody.jsonl`)[1].root_pid; assert.notEqual(rootPid, pid);
    } else assert.deepEqual([join.descendants.status, join.descendants.method], ['unknown', tree.CENSUS_METHOD]);
    assert.deepEqual(Object.keys(execution.protectedSnapshot(f.owner)).sort(), ownerBefore, 'no new owner entry');
    assert.deepEqual(Object.keys(execution.protectedSnapshot(f.a)).sort(), rootBefore, 'no new root entry');
    for (const dir of [f.owner, f.a, f.b]) assert(!fs.readdirSync(dir, { recursive: true }).some(name => String(name).includes('process-tree')), dir);
  }));
}
test('T8 module error before spawn keeps the plain spawn native and legacy create no record', () => activityFixture(async f => {
  const { activityRequest } = require('./forge-issues-429-432.test');
  const activity = require('./forge-protected-owner-activity');
  const request = activityRequest(f, 'codex'), record = `${request.resultFile}.process-tree.jsonl`;
  fs.writeFileSync(record, 'pre-existing'); // the tree module refuses before any spawn
  let join = null;
  await activity.withExecutionActivity(request, {}, async () => {
    const scope = activity.currentScope();
    const child = scope.spawn(process.execPath, [HELPER, 'report'], { cwd: f.a, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    track(child); await observe(child); join = await scope.joinWriter();
  });
  assert.equal(fs.readFileSync(record, 'utf8'), 'pre-existing');
  assert.deepEqual({ ...join.descendants }, { status: 'unknown', method: tree.CENSUS_METHOD, record_sha256: null });
  assert.equal(join.joined, true); assert.equal(fs.existsSync(`${request.resultFile}.process-tree.custody.jsonl`), false);
  for (const variant of [{ route: { ...request.route, worker_mode: 'native' }, resultFile: path.join(f.dir, 'native.json') }, { scope: 'standalone-task', resultFile: path.join(f.dir, 'legacy.json') }]) {
    await activity.withExecutionActivity({ ...request, ...variant }, {}, async () => { assert.equal(activity.currentScope(), null); });
    assert.equal(fs.existsSync(`${variant.resultFile}.process-tree.jsonl`), false);
  }
  const census = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'issue-440', 'surface-census.json'), 'utf8'));
  const text = require('./forge-task-execution').protectedSnapshot.toString();
  assert.equal(sha(text), census.protected_snapshot_pin.sha256); assert.equal(sha(text), 'eed8600f597bd5338219104b5149327dc320da604633007c9577b9430498375d');
  assert(text.includes('++entries > 20000'));
}));

test('T9 observeStoppedWriter without descendants keeps the historical challenge', async () => {
  const dir = attemptDir('writer'), receiptFile = path.join(dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: 'fixture-tree', fingerprint: 'fixture-fingerprint', recovery_identity_sha256: 'r', route: { host_runtime: 'claude' }, provider_called: false }));
  const keys = [];
  const adapter = transition.createWriterObservationAdapter(challenge => { keys.push(Object.keys(challenge)); return { ...challenge, status: 'stopped',
    binding_sha256: require('./forge-code-roots').digest(challenge), writer_identity: 'fixture-writer', evidence_reference: 'fixture actual join' }; });
  const options = { receiptFile, contract: { owner: OWNER }, processProbe: () => 'stopped', assertUnchanged: () => {} };
  const handle = await transition.observeStoppedWriter(adapter, options);
  transition.assertWriterObservation(handle);
  assert.deepEqual(keys, [['schema_version', 'nonce', 'dispatch_id', 'fingerprint', 'receipt_sha256', 'execution_identity_sha256', 'roots_sha256', 'route']]);
}, { win32: false });

test('T9 observeStoppedWriter with live descendants handle binds revalidates and refuses', async () => {
  const dir = attemptDir('writer-tree'), receiptFile = path.join(dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: 'fixture-tree', fingerprint: 'fixture-fingerprint', recovery_identity_sha256: 'r', route: { host_runtime: 'claude' }, provider_called: false }));
  const digestOf = require('./forge-code-roots').digest;
  const make = (echo = true) => transition.createWriterObservationAdapter(challenge => {
    const { descendants_sha256: omitted, ...rest } = challenge;
    const body = echo ? challenge : rest;
    return { ...body, status: 'stopped', binding_sha256: digestOf(challenge), writer_identity: 'fixture-writer', evidence_reference: 'fixture actual join' };
  });
  const options = descendants => ({ receiptFile, contract: { owner: OWNER }, processProbe: () => 'stopped', assertUnchanged: () => {}, descendants });
  const rejects = async (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.stack); return true; });
  const s = start(dir, ['exit', '0']); await observe(s.child); await s.tree.join();
  const proof = s.tree.prove();
  await rejects(transition.observeStoppedWriter(make(), options(JSON.parse(JSON.stringify(proof.handle)))), 'writer-observation-descendants-unproved');
  await rejects(transition.observeStoppedWriter(make(), options(s.child.pid)), 'writer-observation-descendants-unproved');
  await rejects(transition.observeStoppedWriter(make(), options({ ...proof })), 'writer-observation-descendants-unproved');
  if (!WIN) { await rejects(transition.observeStoppedWriter(make(), options(proof.handle)), 'writer-observation-descendants-unproved'); return; }
  assert.equal(proof.status, 'stopped');
  const seen = [];
  const recording = transition.createWriterObservationAdapter(challenge => { seen.push(challenge); return { ...challenge, status: 'stopped',
    binding_sha256: digestOf(challenge), writer_identity: 'fixture-writer', evidence_reference: 'fixture actual join' }; });
  const handle = await transition.observeStoppedWriter(recording, options(proof.handle));
  assert.match(seen[0].descendants_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(seen[0]).slice(-1), ['descendants_sha256']);
  transition.assertWriterObservation(handle);
  await rejects(transition.observeStoppedWriter(make(false), options(proof.handle)), 'writer-observation-unproved');
  // A live but not stopped proof.
  const adir = attemptDir('writer-alive'), a = start(adir, ['sleep', adir, 'live'], { stdio: 'ignore' });
  remember((await waitFile(path.join(adir, 'live.json'))).pid);
  const alive = a.tree.prove(); assert.equal(alive.status, 'alive');
  await rejects(transition.observeStoppedWriter(make(), options(alive.handle)), 'writer-observation-descendants-unproved');
  const aseen = observe(a.child); fs.writeFileSync(path.join(adir, 'release-live'), ''); await aseen; await a.tree.join();
  // Change detected by assertDescendants inside assertUnchanged.
  const bytes = fs.readFileSync(s.tree.journalFile);
  fs.writeFileSync(s.tree.journalFile, Buffer.concat([bytes, Buffer.from('{"tail":1}\n')]));
  assert.throws(() => transition.assertWriterObservation(handle), error => error.code === 'writer-observation-descendants-changed');
  expectCode(() => tree.assertDescendants(proof.handle), 'process-tree-record-invalid');
  fs.writeFileSync(s.tree.journalFile, bytes);
  transition.assertWriterObservation(handle);
  expectCode(() => tree.assertDescendants({ kind: 'process-tree-proof' }), 'process-tree-record-invalid');
});

test('T0 marker polling retries incomplete JSON with a bounded deterministic clock', async () => {
  const marker = path.join(LAB, 'deterministic-marker.json');
  const absent = Object.assign(new Error('fixture marker absent'), { code: 'ENOENT' });
  const values = [absent, '', '{"pid":', JSON.stringify({ pid: process.pid })];
  let reads = 0, clock = 0; const pauses = [];
  const options = { read() { const value = values[reads++]; if (value instanceof Error) throw value; return value; },
    now: () => clock, pause: async ms => { pauses.push(ms); clock += ms; } };
  assert.deepEqual(await waitFile(marker, 30000, options), { pid: process.pid });
  assert.equal(reads, 4); assert.deepEqual(pauses, [20, 20, 20]);
  clock = 0; reads = 0;
  await assert.rejects(() => waitFile(marker, 40, { read() { reads++; return '{'; }, now: () => clock,
    pause: async ms => { clock += ms; } }), error => {
    assert.equal(error.message, 'marker timeout ' + path.basename(marker));
    assert(error.cause instanceof SyntaxError, 'last parse error is preserved'); return true;
  });
  assert.equal(reads, 3, 'persistent malformed JSON ends at the original polling deadline');
  await assert.rejects(() => waitFile(marker, 0, { read() { throw absent; }, now: () => 0,
    pause: async () => assert.fail('expired marker wait must not pause') }), error => error.cause === absent);
  const denied = Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
  await assert.rejects(() => waitFile(marker, 30000, { read() { throw denied; }, now: () => 0,
    pause: async () => assert.fail('non-transient IO must not retry') }), error => error === denied);
});

// ── Runner ──────────────────────────────────────────────────────────────────
async function main() {
  let failed = 0;
  const started = Date.now();
  try {
    for (const item of cases) {
      const t = Date.now();
      try { await item.fn(); console.log(`PASS ${item.name} (${Date.now() - t} ms)`); }
      catch (error) { failed++; console.log(`FAIL ${item.name}: ${error && error.stack}`); }
    }
  } finally {
    cleanupProcesses(); await wait(300);
    try { fs.rmSync(LAB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { console.log(`WARN cleanup ${error.code}`); }
  }
  console.log(`process-tree: ${cases.length - failed}/${cases.length} named cases passed on ${process.platform} (${Date.now() - started} ms); synthetic (mock) transport, provider invocations: 0`);
  if (failed) process.exitCode = 1;
}
main();
});
