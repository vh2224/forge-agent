#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const { sha256 } = require('./forge-delivery.js');
const { validateSourceManifest } = require('./forge-empirical-sources.js');
const { canonicalUrl, buildReadRequest, readHistoricalSource } = require('./forge-empirical-svn.js');
const cases = require('./fixtures/empirical-corpus/sources/cases.json');
const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'empirical-svn-'));
const owner = path.join(temp, 'owner'); const origin = path.join(temp, 'wc');
const milestone = 'M-20260101120000-svn-fixture';
const evidence = path.join(owner, '.gsd', 'milestones', milestone, 'evidence');
fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(origin);
const manifest = { schema_version: 1, sources: [
  { id: 'file', root: 'fixture', path: 'history/removed.txt', type: 'svn', format: 'raw' },
  { id: 'parent', root: 'fixture', path: 'history', type: 'svn', format: 'raw' },
  ...cases.literal_paths.map((literal, index) => ({ id: `literal${index}`, root: 'fixture', path: literal, type: 'svn', format: 'raw' }))
] };
let assertions = 0; let calls = 0; let serial = 0;
function equal(actual, expected) { assertions++; assert.deepStrictEqual(actual, expected); }
function reject(fn) { assertions++; assert.throws(fn); }
function mockRunner(executable, argv, options) {
  calls++; equal(executable, 'svn'); equal(options.shell, false); equal(options.windowsHide, true);
  equal(options.encoding, null); assertions++; assert(options.timeout <= 15000 && options.maxBuffer <= 2 * 1024 * 1024);
  assertions++; assert(argv.includes('--non-interactive') && argv.includes('--no-auth-cache'));
  return { status: 0, stdout: Buffer.from(cases[argv[0]] || cases.content), stderr: Buffer.alloc(0) };
}
function session(options = {}, root = {}) {
  const validated = validateSourceManifest(manifest, { owner, milestone, roots: [{ id: 'fixture', path: origin,
    repository: cases.repository, subtree: cases.subtree, ...root }], capability: 'networked', runner: mockRunner, ...options });
  equal(validated.valid, true); return validated.session;
}
function read(handle, request, id = 'file') { return readHistoricalSource(handle, id, request, `svn-${serial++}.bin`); }
function identified(options = {}, root = {}) {
  const handle = session(options, root); equal(read(handle, { operation: 'info' }).status, 'observed'); return handle;
}
const cat = { operation: 'cat', revision: '1', peg: '1' };
try {
  for (const url of cases.bad_urls) reject(() => canonicalUrl(url));
  equal(canonicalUrl(cases.repository), cases.repository);
  equal(canonicalUrl(`${cases.subtree}/history%40v1/notes%40owner%40%40.txt`),
    `${cases.subtree}/history%40v1/notes%40owner%40%40.txt`);
  const handle = identified(); const before = calls;
  for (const operation of cases.mutations) {
    reject(() => buildReadRequest(handle, 'file', { operation, revision: '1', peg: '1' }));
    equal(read(handle, { operation, revision: '1', peg: '1' }).complete, false);
  }
  for (const revision of cases.bad_revisions) {
    reject(() => buildReadRequest(handle, 'file', { ...cat, revision }));
    reject(() => buildReadRequest(handle, 'file', { ...cat, peg: revision }));
  }
  for (const extra of [{ argv: ['--trust-server-cert'] }, { capability: 'networked' }, { cwd: origin },
    { command: 'update' }, { config: 'external' }, { endRevision: '2' }]) reject(() => buildReadRequest(handle, 'file', { ...cat, ...extra }));
  equal(calls, before);
  const anonymous = session(); equal(read(anonymous, cat).reason, 'svn_identity_required'); equal(calls, before);
  const noNetwork = identified({ capability: 'workspace' }); const noNetworkCalls = calls;
  equal(read(noNetwork, cat).reason, 'network_capability_required'); equal(calls, noNetworkCalls);
  equal(read(session({}, { subtree: `${cases.repository}-foreign/project` }), { operation: 'info' }).reason, 'svn_subtree_foreign');
  equal(read(session({}, { subtree: `${cases.repository}/wrong` }), { operation: 'info' }).reason, 'svn_identity_mismatch');
  const built = buildReadRequest(handle, 'file', cat);
  equal(built.argv.at(-1), `${cases.subtree}/history/removed.txt@1`); equal(built.argv.slice(3, 5), ['-r', '1']);
  for (const [index, literal] of cases.literal_paths.entries()) {
    const literalRequest = buildReadRequest(handle, `literal${index}`, { ...cat, peg: '2' });
    equal(literalRequest.argv.at(-1), `${cases.subtree}/${literal.split('/').map(encodeURIComponent).join('/')}@2`);
    equal(literalRequest.argv.at(-1).split('@').length, 2);
    equal(literalRequest.argv.slice(3, 5), ['-r', '1']);
    equal(read(handle, cat, `literal${index}`).status, 'observed');
    reject(() => buildReadRequest(handle, `literal${index}`, { ...cat, peg: 'HEAD' }));
    reject(() => buildReadRequest(handle, `literal${index}`, { ...cat, peg: '1@2' }));
  }
  const captured = read(handle, cat); equal(captured.status, 'observed'); equal(captured.metadata.peg, '1');
  equal(captured.metadata.revision, '1'); equal(captured.metadata.sha256, sha256(Buffer.from(cases.content)));
  equal(captured.metadata.argv.at(-1), '<SOURCE>'); equal(captured.metadata.result.exit, 0);
  equal(fs.readFileSync(captured.metadata.snapshot, 'utf8'), cases.content);
  equal(read(handle, { operation: 'log', revision: '2', peg: '2' }, 'parent').metadata.removal_cause, 'unknown');
  equal(read(handle, { operation: 'list', revision: '2', peg: '2' }, 'parent').metadata.entries, 1);
  for (const foreign of ['/foreign/private.txt', '/project-sibling/private.txt']) {
    const mixedLog = cases.log.replace('</paths>', `<path action="M">${foreign}</path></paths>`);
    const scoped = identified({ runner: (bin, args, opts) => args[0] === 'info' ? mockRunner(bin, args, opts) : { status: 0, stdout: Buffer.from(mixedLog), stderr: Buffer.alloc(0) } });
    const rejected = readHistoricalSource(scoped, 'parent', { operation: 'log', revision: '2', peg: '2' }, `foreign-${serial++}.xml`);
    equal(rejected.reason, 'svn_log_path_foreign'); equal(rejected.metadata, undefined);
  }
  const copyLog = cases.log.replace('action="D"', 'action="A" copyfrom-path="/foreign/private.txt" copyfrom-rev="1"');
  const copyScoped = identified({ runner: (bin, args, opts) => args[0] === 'info' ? mockRunner(bin, args, opts) : { status: 0, stdout: Buffer.from(copyLog), stderr: Buffer.alloc(0) } });
  equal(read(copyScoped, { operation: 'log', revision: '2', peg: '2' }, 'parent').reason, 'svn_log_path_foreign');
  let response = { status: 0, stdout: Buffer.from(cases.info), stderr: Buffer.alloc(0) };
  const custom = identified({ runner: () => { calls++; return response; } });
  response = { status: 1, stdout: Buffer.from('partial'), stderr: Buffer.from('password=SECRET private/path') };
  const failed = read(custom, cat); equal(failed.reason, 'svn_command_failed'); equal(JSON.stringify(failed).includes('SECRET'), false);
  equal(failed.result.stdout_bytes, 7); equal(failed.complete, false);
  response = { status: 0, stdout: Buffer.from('password=SECRET'), stderr: Buffer.alloc(0) };
  equal(read(custom, cat).reason, 'sensitive_source_omitted');
  response = { status: null, error: { code: 'ETIMEDOUT', message: 'SECRET' }, stdout: Buffer.from('partial'), stderr: Buffer.alloc(0), signal: 'SIGTERM' };
  const timeout = read(custom, cat); equal(timeout.reason, 'svn_timeout'); equal(timeout.result.signal, 'SIGTERM');
  equal(JSON.stringify(timeout).includes('SECRET'), false);
  response = { status: 0, stdout: Buffer.alloc(2 * 1024 * 1024 + 1), stderr: Buffer.alloc(0) };
  equal(read(custom, cat).reason, 'svn_output_truncated');
  response = { status: 0, stdout: Buffer.from('partial'), stderr: Buffer.alloc(0), error: { code: 'ENOBUFS' } };
  equal(read(custom, cat).reason, 'svn_output_truncated');
  response = { status: 0, stdout: Buffer.from('<log>'), stderr: Buffer.alloc(0) };
  equal(read(custom, { operation: 'log', revision: '2', peg: '2' }, 'parent').reason, 'svn_output_invalid');
  const saturated = identified({ limits: { entries: 1 } });
  equal(read(saturated, { operation: 'log', revision: '2', peg: '2' }, 'parent').reason, 'svn_log_possibly_truncated');
  const once = identified({ limits: { commands: 1 } }); const onceCalls = calls;
  equal(read(once, cat).reason, 'budget_exhausted'); equal(calls, onceCalls);
  let clock = 0;
  const deadline = identified({ clock: () => clock, limits: { totalMs: 100, commandMs: 50 }, runner: (...args) => {
    const result = mockRunner(...args); if (args[1][0] === 'cat') clock += 101; return result;
  } });
  equal(read(deadline, cat).reason, 'duration_exceeded'); const expiredCalls = calls;
  equal(read(deadline, cat).reason, 'budget_exhausted'); equal(calls, expiredCalls);
  // Actual SVN semantics: every mutating setup operation is restricted to this owned temporary root.
  const binaries = ['svn', 'svnadmin'].map((bin) => spawnSync(bin, ['--version', '--quiet'],
    { cwd: temp, shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096 }));
  let integration = 'skipped:svn-or-svnadmin-unavailable';
  if (binaries.every((probe) => probe.status === 0)) {
    const repo = path.join(temp, 'repository'); const seed = path.join(temp, 'seed'); const wc = path.join(temp, 'actual-wc');
    fs.mkdirSync(path.join(seed, 'history'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'history', 'removed.txt'), cases.content);
    fs.writeFileSync(path.join(seed, 'history', 'retained.txt'), 'retained fixture');
    for (const literal of cases.literal_paths) {
      fs.mkdirSync(path.dirname(path.join(seed, literal)), { recursive: true });
      fs.writeFileSync(path.join(seed, literal), `literal r1: ${literal}\n`);
    }
    const repoUrl = pathToFileURL(repo).href;
    function setup(bin, args) {
      const result = spawnSync(bin, args, { cwd: temp, shell: false, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
      equal(result.status, 0);
    }
    setup('svnadmin', ['create', repo]);
    setup('svn', ['import', seed, repoUrl, '-m', 'synthetic r1', '--non-interactive', '--no-auth-cache']);
    setup('svn', ['checkout', repoUrl, wc, '--non-interactive', '--no-auth-cache']);
    setup('svn', ['delete', path.join(wc, 'history', 'removed.txt')]);
    fs.writeFileSync(path.join(wc, cases.literal_paths[0]), 'changed in r2\n');
    setup('svn', ['commit', wc, '-m', 'synthetic r2', '--non-interactive', '--no-auth-cache']);
    const real = identified({ capability: 'workspace', runner: (bin, args, options) => {
      assertions++; assert(args.at(-1) === '.' || args.at(-1).startsWith(`${repoUrl}/`));
      return spawnSync(bin, args, options);
    } }, { path: wc, repository: repoUrl, subtree: repoUrl });
    const previous = read(real, cat); equal(previous.status, 'observed');
    equal(fs.readFileSync(previous.metadata.snapshot, 'utf8'), cases.content);
    const deletion = read(real, { operation: 'log', revision: '2', peg: '2' }, 'parent');
    equal(deletion.status, 'observed'); assertions++; assert(fs.readFileSync(deletion.metadata.snapshot, 'utf8').includes('action="D"'));
    equal(deletion.metadata.removal_cause, 'unknown');
    equal(read(real, { operation: 'cat', revision: '2', peg: '2' }).reason, 'svn_command_failed');
    equal(read(real, { operation: 'list', revision: '2', peg: '2' }, 'parent').status, 'observed');
    for (const [index, literal] of cases.literal_paths.entries()) {
      const captured = read(real, { operation: 'cat', revision: '1', peg: '2' }, `literal${index}`);
      equal(captured.status, 'observed'); equal(captured.metadata.revision, '1'); equal(captured.metadata.peg, '2');
      const expected = Buffer.from(`literal r1: ${literal}\n`);
      equal(fs.readFileSync(captured.metadata.snapshot), expected); equal(captured.metadata.sha256, sha256(expected));
    }
    const latest = read(real, { operation: 'cat', revision: '2', peg: '2' }, 'literal0');
    equal(latest.status, 'observed'); equal(fs.readFileSync(latest.metadata.snapshot, 'utf8'), 'changed in r2\n');
    // SVN returns whole-commit changed paths even for a narrow URL log target.
    fs.writeFileSync(path.join(wc, 'history', 'retained.txt'), 'scoped r3');
    fs.writeFileSync(path.join(wc, cases.literal_paths[0]), 'foreign r3');
    setup('svn', ['commit', wc, '-m', 'mixed scope r3', '--non-interactive', '--no-auth-cache']);
    const narrowManifest = { schema_version: 1, sources: [
      { id: 'scoped', root: 'fixture', path: 'retained.txt', type: 'svn', format: 'raw' },
      { id: 'copied', root: 'fixture', path: 'copied.txt', type: 'svn', format: 'raw' }] };
    const narrow = validateSourceManifest(narrowManifest, { owner, milestone, capability: 'offline', roots: [
      { id: 'fixture', path: path.join(wc, 'history'), repository: repoUrl, subtree: `${repoUrl}/history` }] });
    equal(narrow.valid, true);
    equal(readHistoricalSource(narrow.session, 'scoped', { operation: 'info' }, 'narrow-info.xml').status, 'observed');
    const mixedReal = readHistoricalSource(narrow.session, 'scoped', { operation: 'log', revision: '3', peg: '3' }, 'narrow-mixed.xml');
    equal(mixedReal.reason, 'svn_log_path_foreign'); equal(fs.existsSync(path.join(evidence, 'narrow-mixed.xml')), false);
    fs.writeFileSync(path.join(wc, 'history', 'retained.txt'), 'scoped r4');
    setup('svn', ['commit', wc, '-m', 'pure scope r4', '--non-interactive', '--no-auth-cache']);
    equal(readHistoricalSource(narrow.session, 'scoped', { operation: 'log', revision: '4', peg: '4' }, 'narrow-pure.xml').status, 'observed');
    setup('svn', ['copy', `${repoUrl}/${cases.literal_paths[0].split('/').map(encodeURIComponent).join('/')}@4`, path.join(wc, 'history', 'copied.txt')]);
    setup('svn', ['commit', wc, '-m', 'foreign copy provenance r5', '--non-interactive', '--no-auth-cache']);
    const copiedReal = readHistoricalSource(narrow.session, 'copied', { operation: 'log', revision: '5', peg: '5' }, 'narrow-copy.xml');
    equal(copiedReal.reason, 'svn_log_path_foreign'); equal(fs.existsSync(path.join(evidence, 'narrow-copy.xml')), false);
    const status = spawnSync('svn', ['status', wc], { cwd: temp, shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    equal(status.status, 0); equal(status.stdout.length, 0);
    equal(fs.existsSync(path.join(wc, 'history', 'removed.txt')), false);
    integration = 'passed:file-repository-r1-r5; literal-at operative/peg bytes; mixed-scope and foreign-copy log rejected before capture';
  }
  console.log(`empirical-svn: ${assertions} assertions passed; mock calls ${calls}; integration ${integration}; no network`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
