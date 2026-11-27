#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
function cryptDiagnostic() {
  const vm = require('vm'), crypto = require('crypto');
  const source = fs.readFileSync(path.join(__dirname, 'forge-claude-provisional.js'), 'utf8');
  const sentinel = 'private-payload-sentinel', input = Buffer.from(sentinel);
  const expectedCommands = {"protect":"8b7bebfdd35627e3d29ea7c88c43d53b5d87e2eab9d4953baee5209a43385328","unprotect":"dc2739cec531a4a8c7dfdbd3d464462fd6d59fced9f7ef90adab770471dec3a6"};
  let checked = 0;
  function fixture(response, platform = 'win32') {
    const calls = [], forbidden = () => { throw new Error('unexpected storage access'); };
    const context = { Buffer, process: { platform, env: { SystemRoot: 'C:\\Windows' } }, module: { exports: {} },
      require(name) {
        if (name === 'fs') return new Proxy({}, { get: () => forbidden });
        if (name === 'path') return path;
        if (name === 'crypto') return crypto;
        if (name === 'child_process') return { spawnSync(...args) { calls.push(args); return response; } };
        if (name === './forge-home') return { resolveUserHome: forbidden };
        if (name === './forge-autonomy-sources') return { readBoundedStableFile: forbidden };
        throw new Error('unexpected dependency');
      } };
    vm.runInNewContext(source + '\nglobalThis.testCrypt = crypt;', context, { timeout: 1000 });
    return { crypt: context.testCrypt, calls, exports: context.module.exports };
  }
  function assertSpawn(calls, decrypt) {
    assert.equal(calls.length, 1);
    const [command, args, options] = calls[0];
    assert.equal(command, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(Array.from(args.slice(0, 4)), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(args.length, 5);
    assert.equal(crypto.createHash('sha256').update(args[4]).digest('hex'), expectedCommands[decrypt ? 'unprotect' : 'protect']);
    assert.deepEqual(JSON.parse(JSON.stringify(options)), { input: input.toString('base64'), encoding: 'utf8', timeout: 5000, maxBuffer: 3 * 1048576, windowsHide: true });
  }
  function refused(decrypt, response, expected) {
    const f = fixture({ stdout: sentinel, stderr: sentinel, ...response });
    let error;
    try { f.crypt(input, decrypt); } catch (value) { error = value; }
    assert(error);
    assert.equal(error.code, 'provisional-private-storage-unavailable');
    assert.equal(error.message, error.code);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'private_storage_diagnostic']);
    const d = error.private_storage_diagnostic;
    assert(Object.isFrozen(d));
    assert.deepEqual(JSON.parse(JSON.stringify(d)), { schema_version: 1, operation: decrypt ? 'unprotect' : 'protect', ...expected });
    const serialized = JSON.stringify(error);
    assert(!serialized.includes(sentinel));
    assert(!serialized.includes(input.toString('base64')));
    assert(!serialized.includes('powershell'));
    assert(!serialized.includes('secret-path'));
    assertSpawn(f.calls, decrypt);
    checked++;
  }
  for (const decrypt of [false, true]) {
    const success = fixture({ status: 0, signal: null, stdout: 'AAECA/8=' });
    assert(success.crypt(input, decrypt).equals(Buffer.from([0, 1, 2, 3, 255])));
    assertSpawn(success.calls, decrypt);
    assert(!Object.hasOwn(success.exports, 'crypt'));
    checked++;
    for (const code of ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOBUFS', 'EINVAL', 'EIO', 'ENOEXEC', 'E2BIG', 'EAGAIN', 'ENOMEM']) {
      refused(decrypt, { status: null, signal: null, error: { code, message: sentinel, path: 'secret-path' } }, { reason: 'child-error', status: null, signal: null, error_code: code });
    }
    refused(decrypt, { status: 7, signal: 'SIGTERM', error: { code: 'ETIMEDOUT', message: sentinel } }, { reason: 'child-error', status: 7, signal: 'SIGTERM', error_code: 'ETIMEDOUT' });
    refused(decrypt, { status: null, signal: 'SECRET_SIGNAL', error: { code: sentinel } }, { reason: 'child-error', status: null, signal: 'other', error_code: 'other' });
    refused(decrypt, { status: 7, signal: null }, { reason: 'nonzero-status', status: 7, signal: null, error_code: null });
    refused(decrypt, { status: null, signal: 'SIGKILL' }, { reason: 'nonzero-status', status: null, signal: 'SIGKILL', error_code: null });
    for (const status of [Infinity, 0.5, undefined]) refused(decrypt, { status, signal: null }, { reason: 'nonzero-status', status: null, signal: null, error_code: null });
    for (const stdout of ['', '%%invalid%%', 'AQID\n']) refused(decrypt, { status: 0, signal: null, stdout }, { reason: 'invalid-output', status: 0, signal: null, error_code: null });
  }
  const nonWindows = fixture(null, 'linux');
  assert.equal(nonWindows.crypt(input), input);
  assert.equal(nonWindows.calls.length, 0);
  checked++;
  console.log('PASS provisional crypt diagnostic VM controls=' + checked + '; real child/storage operations=0');
}
if (process.argv.length === 3 && process.argv[2] === '--crypt-diagnostic') {
  cryptDiagnostic();
  process.exit(0);
}
const api = require('./forge-claude-provisional');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-provisional-test-')));
const owner = path.join(root, 'owner'), code = path.join(root, 'code'), store = path.join(root, 'private');
fs.mkdirSync(owner); fs.mkdirSync(code);
const binding = { request_sha256: 'a'.repeat(64), context_sha256: 'b'.repeat(64), phase: 'execute', unit: 'fixture' };
const terminal = { type: 'result', subtype: 'success', is_error: false, structured_output: { status: 'done', summary: 'private-payload-sentinel' } };
function fixture() {
  const error = Object.assign(new Error('fixture failed'), { code: 'claude-anomalous-silence' }), child = { pid: 424242 };
  const control = api.prepare({ binding, roots: [owner, code], storeRoot: store,
    validate: value => { assert.equal(value.structured_output.status, 'done'); return { candidate: value.structured_output }; } });
  control.start(child); assert.equal(control.capture(terminal, error, { observedSessionId: 'fixture-session' }), true);
  return { control, error, child, live: { assertCurrent: () => true,
    proveStopped: original => ({ child: original, process_stopped: true, descendants_stopped: true }),
    reconcileRoot: r => ({ root_id: r.root_id, process_stopped: true, reconciled: true, original_snapshot_preserved: true }) } };
}
async function main() {
  const f = fixture(), reference = api.describe(f.error);
  assert(!JSON.stringify(f.error).includes('private-payload-sentinel')); assert(!JSON.stringify(reference).includes('private-payload-sentinel'));
  assert.equal(api.inspectPrivate(reference.private_ref).promotion, 'unavailable-after-owner-restart');
  assert.equal(api.inspectPrivate(reference.private_ref, { includePrivatePayload: true }).private_payload.terminal.structured_output.summary, 'private-payload-sentinel');
  if (process.platform === 'win32') assert(!fs.readFileSync(reference.private_ref, 'utf8').includes('private-payload-sentinel'));
  await assert.rejects(api.resume(f.error, f.live), { code: 'provisional-transport-ineligible' });
  f.control.closeAudit({ code: 0, signal: null, protocolValid: true });
  await assert.rejects(api.resume(f.error, {}), { code: 'provisional-live-proof-required' });
  await assert.rejects(api.resume(f.error, { ...f.live, assertCurrent: () => false }), { code: 'provisional-owner-refused' });
  await assert.rejects(api.resume(f.error, { ...f.live, proveStopped: child => ({ child, process_stopped: true, descendants_stopped: false }) }), { code: 'provisional-tree-unjoined' });
  await assert.rejects(api.resume(f.error, { ...f.live, reconcileRoot: r => ({ root_id: r.root_id, reconciled: true }) }), { code: 'provisional-roots-unreconciled' });
  let finalized = 0;
  api.addFinalizer(f.error, result => { finalized++; return { ...result, published: true }; });
  const result = await api.resume(f.error, f.live);
  assert.equal(result.published, true); assert.equal(finalized, 1);
  await assert.rejects(api.resume(f.error, f.live), { code: 'provisional-continuation-unavailable' });
  console.log('PASS provisional private storage, every live gate, original finalizer and single use');
  for (const audit of [{ code: 7, signal: null, protocolValid: true }, { code: 0, signal: 'SIGTERM', protocolValid: true }, { code: 0, signal: null, protocolValid: false }]) {
    const n = fixture(); n.control.closeAudit(audit);
    await assert.rejects(api.resume(n.error, n.live), { code: 'provisional-transport-ineligible' });
  }
  const tampered = fixture(); tampered.control.closeAudit({ code: 0, signal: null, protocolValid: true });
  fs.appendFileSync(api.describe(tampered.error).private_ref, 'changed');
  await assert.rejects(api.resume(tampered.error, tampered.live), { code: 'provisional-evidence-changed' });
  assert.throws(() => api.prepare({ binding, roots: [owner], storeRoot: path.join(owner, 'forbidden'), validate() {} }), { code: 'provisional-storage-inside-protected-root' });
  const child = spawnSync(process.execPath, ['-e', `const a=require(process.argv[1]);const r=a.inspectPrivate(process.argv[2]);a.resume(JSON.parse(process.argv[3]),{}).then(()=>process.exit(2),e=>{if(e.code!=='provisional-continuation-unavailable')process.exit(3);console.log(r.promotion);});`,
    require.resolve('./forge-claude-provisional'), reference.private_ref, JSON.stringify(f.error)], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), 'unavailable-after-owner-restart');
  console.log('PASS late failures, tampering, protected-root refusal and fresh-process inspection-only evidence');
  await canonicalContinuation();
}
async function canonicalContinuation() {
  const fixtures = require('./forge-code-roots.test'), accounts = require('./forge-accounts');
  const originalResolver = accounts.resolveLaunch;
  accounts.resolveLaunch = () => ({ name: 'provisional-fixture', token: 'provisional-fixture-account-value' });
  const claude = require('./forge-claude-sidecar');
  accounts.resolveLaunch = originalResolver;
  const originalInvoke = claude.invokeClaudeSidecar;
  let child = null, terminalSeen = false, watchdogWanted = true;
  claude.invokeClaudeSidecar = options => originalInvoke({ ...options, timeoutMs: 20000,
    monotonicClock: () => performance.now() + (terminalSeen ? 4000000 : 0), livenessIntervalMs: 10,
    onProgress: snapshot => { options.onProgress?.(snapshot); if (snapshot.phase === 'terminal' && watchdogWanted) terminalSeen = true; },
    terminateChild: owned => { child = owned; }, terminationWaitMs: 0 });
  const side = require('./forge-unit-sidecar');
  const previousBin = process.env.FORGE_XLLM_CLAUDE_BIN;
  try {
    for (const mode of ['artifacts', 'execute', 'plan', 'memory', 'handoff', 'handoff-result', 'execute-output', 'execute-checkpoint', 'artifact-ready', 'artifact-return', 'artifact-consume', 'plan-anchor-receipt', 'normal-publication']) {
    const isExecute = mode.startsWith('execute'), isPlan = mode.startsWith('plan');
    const isArtifacts = !isExecute && !isPlan && mode !== 'memory';
    const lab = fixtures.fixture(); child = null; terminalSeen = false;
    watchdogWanted = mode !== 'normal-publication';
    try {
    const base = path.join(lab.owner, '.gsd/milestones/M001'); fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
      ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])) }));
    const artifact = '.gsd/milestones/M001/M001-RESEARCH.md', content = '# Research\n\nControlled retained candidate.\n';
    const cli = path.join(root, `canonical-cli-${mode}.js`), count = path.join(root, `canonical-inferences-${mode}.txt`);
    const candidate = mode === 'memory' ? { schema_version: 2, status: 'done', summary: 'Retained extraction', questions: [], facts: [], events: [] }
      : isPlan ? { status: 'done', summary: 'Retained planning', slice_plan: { filename: 'S01-PLAN.md', content: '# Slice\n- [ ] **T01** — fixture\n' },
        task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: fixtures.plan(lab.contract) }] }
      : isExecute ? { status: 'done', summary: 'Retained writing', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] }
      : { status: 'done', summary: 'Retained research', questions: [], artifacts: [{ path: artifact, content }] };
    fs.writeFileSync(cli, `const fs=require('fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('2.1.310 (Claude Code)');process.exit(0);}
      fs.appendFileSync(${JSON.stringify(count)},'1\\n');const model=args[args.indexOf('--model')+1];
      const sid=args[args.indexOf('--session-id')+1];if(args.includes('--session-id'))console.log(JSON.stringify({type:'system',subtype:'init',session_id:sid}));
      ${isExecute ? `fs.writeFileSync(${JSON.stringify(path.join(lab.a, 'same.txt'))},'retained alpha\\n');fs.writeFileSync(${JSON.stringify(path.join(lab.b, 'same.txt'))},'retained beta\\n');` : ''}
      console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'fixture',structured_output:${JSON.stringify(candidate)},modelUsage:{[model]:{inputTokens:1,outputTokens:1}}}));setTimeout(()=>{},1000);`);
    process.env.FORGE_XLLM_CLAUDE_BIN = cli;
    const request = { unitType: 'research-milestone', scope: 'milestone', phase: 'research', milestoneId: 'M001',
      cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract,
      workflowId: 'provisional-fixture', dispatchId: 'provisional-fixture-' + mode, resultFile: path.join(root, `canonical-result-${mode}.json`), prompt: 'Controlled fixture.' };
    if (isExecute) {
      Object.assign(request, { unitType: 'execute-task', phase: 'execute', taskId: 'T01', sliceId: 'S01',
        verification: { preferenceCommands: ['node -e "process.exit(0)"'] } });
      const slice = path.join(base, 'slices/S01'); fs.mkdirSync(path.join(slice, 'tasks/T01'), { recursive: true });
      request.planFile = path.join(slice, 'tasks/T01/T01-PLAN.md'); fs.writeFileSync(request.planFile, fixtures.plan(lab.contract).replace('depends: []', 'worker: claude\ndepends: []'));
      require('./fixtures/issues-434-436/execution-fixtures.cjs').declareBindings(request);
      fs.writeFileSync(path.join(slice, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
      request.runId = 'provisional-writing';
      request.claim = { schema_version: 2, generation: require('crypto').randomUUID(), execution_contract: lab.contract,
        paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
      request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
      require('./forge-runs').add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
    }
    if (isPlan) {
      Object.assign(request, { unitType: 'plan-slice', phase: 'plan', sliceId: 'S01', promptFile: path.join(root, 'plan-context.md') });
      fs.writeFileSync(request.promptFile, 'Controlled planning context.\n');
    }
    if (mode === 'memory') Object.assign(request, { unitType: 'memory-extract', phase: 'memory', sourceUnitType: 'execute-task', sourceUnitId: 'T01',
      extractionId: 'retained-memory', extractedAt: '2026-10-31T12:00:00.000Z', sourceFingerprint: 'sha256:controlled-source',
      summaryContent: 'Controlled completed result', sourceResult: 'status: done', keyDecisions: [], existingMemory: { facts: [], stats: [] },
      publicationSafe: true, publicationBoundary: { ownerJoined: true, checkedAt: '2026-10-31T12:00:00.000Z', protectedSnapshots: [] } });
    request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: lab.owner, unitType: request.unitType,
      milestoneId: 'M001', unitId: request.taskId || request.sliceId || 'M001', planPath: request.planFile, hostRuntime: 'codex' });
    let failure;
    const realRename = fs.renameSync; let handoffFault = false;
    if (mode.startsWith('handoff') || mode === 'normal-publication') fs.renameSync = (from, to) => {
      if (!handoffFault && ((mode === 'handoff' && path.resolve(to).toLowerCase() === path.resolve(request.resultFile + '.receipt.json').toLowerCase()
          && JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'failed')
        || (mode === 'handoff-result' && path.resolve(to).toLowerCase() === path.resolve(request.resultFile).toLowerCase()
          && JSON.parse(fs.readFileSync(from, 'utf8')).status === 'adapter-failed')
        || (mode === 'normal-publication' && path.resolve(to).toLowerCase() === path.resolve(path.join(lab.owner, artifact)).toLowerCase()))) {
        handoffFault = true; throw Object.assign(new Error('controlled failed-receipt persistence'), { code: 'EIO' });
      }
      return realRename(from, to);
    };
    try { await side.runUnitSidecar(request, { provisionalStoreRoot: path.join(root, 'canonical-store'), calibrationOptions: { userHome: path.join(root, 'calibration') } }); }
    catch (error) { failure = error; }
    finally { fs.renameSync = realRename; }
    if (mode === 'normal-publication') {
      assert(handoffFault); assert.equal(failure?.code, 'EIO');
      const failed = JSON.parse(fs.readFileSync(request.resultFile, 'utf8'));
      assert.equal(failed.status, 'adapter-failed'); assert.equal(failed.layer, 'publication');
      assert.equal(JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json', 'utf8')).phase, 'ready');
      assert.equal(fs.readFileSync(count, 'utf8'), '1\n');
      console.log('PASS ordinary async publication rejection reaches recordFailure and preserves replayable ready response');
      continue;
    }
    assert(failure && api.describe(failure), 'real watchdog must retain the terminal; code=' + (failure?.code || 'none'));
    assert(child && terminalSeen);
    const receiptFile = request.resultFile + '.receipt.json';
    let receiptBefore = fs.readFileSync(receiptFile), resultBefore = fs.readFileSync(request.resultFile);
    assert.equal(JSON.parse(receiptBefore).phase, mode === 'handoff' ? 'started' : 'failed');
    if (mode.startsWith('handoff')) {
      assert(handoffFault); assert.notEqual(failure.code, 'EIO');
      assert.equal(failure.provisional_handoff.secondary_code, 'EIO');
    }
    assert.equal(fs.existsSync(path.join(lab.owner, artifact)), false, 'provisional payload is not published');
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', resolve); });
    // This controlled executable never creates descendants. Its entire owned
    // writer inventory is the captured ChildProcess; production callers must
    // supply their own trusted complete process inventory/reconciliation.
    const live = { assertCurrent: () => { side.validateRecoveryRequest(request); return fs.readFileSync(receiptFile).equals(receiptBefore); },
      proveStopped: observed => ({ child: observed, process_stopped: observed === child && child.exitCode === 0,
        descendants_stopped: observed === child && child.exitCode === 0 }),
      reconcileRoot: identity => {
        if (identity.path !== fs.realpathSync.native(lab.owner)) {
          const status = require('child_process').spawnSync('git', ['status', '--porcelain'], { cwd: identity.path, encoding: 'utf8', windowsHide: true });
          assert.equal(status.status, 0);
          assert.equal(status.stdout.trim(), isExecute ? 'M same.txt' : '');
        }
        return { root_id: identity.root_id, process_stopped: true, reconciled: true, original_snapshot_preserved: true };
      } };
    if (mode === 'artifacts') {
      const originalWrite = fs.writeFileSync; let injected = false;
      fs.writeFileSync = (file, ...args) => {
        if (!injected && typeof file === 'string' && /\.provisional-.*\.receipt\.json$/.test(file)) {
          injected = true; throw Object.assign(new Error('controlled receipt storage failure'), { code: 'EIO' });
        }
        return originalWrite(file, ...args);
      };
      try { await assert.rejects(api.resume(failure, live), { code: 'EIO' }); assert(injected); }
      finally { fs.writeFileSync = originalWrite; }
      assert.equal(api.describe(failure).state, 'unvalidated', 'failed handoff does not consume retained candidate');
    }
    const originalWrite = fs.writeFileSync; let handoffRecorded = false;
    if (mode.startsWith('handoff')) fs.writeFileSync = (file, ...args) => {
      if (typeof file === 'string' && /\.provisional-.*\.receipt\.json$/.test(file)) {
        receiptBefore = fs.readFileSync(receiptFile); resultBefore = fs.readFileSync(request.resultFile);
        assert.equal(JSON.parse(receiptBefore).phase, 'failed'); handoffRecorded = true;
      }
      return originalWrite(file, ...args);
    };
    const derivedAnchors = () => fs.readdirSync(path.dirname(request.resultFile)).filter(name =>
      name.startsWith(path.basename(request.resultFile) + '.provisional-') && name.endsWith('.returned.json'));
    let anchorBeforeRetry = null;
    let resumed;
    try {
      if (['execute-output', 'execute-checkpoint', 'artifact-ready', 'artifact-return', 'artifact-consume', 'plan-anchor-receipt'].includes(mode)) {
        const realRename = fs.renameSync, realOpen = fs.openSync; let injected = false;
        fs.renameSync = (from, to) => {
          if (!injected && typeof to === 'string' && to.includes('.provisional-')) {
            const value = JSON.parse(fs.readFileSync(from, 'utf8')), receipt = to.endsWith('.receipt.json');
            if (mode === 'execute-output' && !receipt && value.status === 'running'
              || mode === 'execute-checkpoint' && receipt && value.phase === 'executed'
              || mode === 'artifact-ready' && receipt && value.phase === 'ready'
              || mode === 'artifact-return' && !receipt && value.status === 'done'
              || mode === 'plan-anchor-receipt' && receipt && value.phase === 'started' && value.returned_response) {
              injected = true; throw Object.assign(new Error('controlled post-inference storage failure'), { code: 'EIO' });
            }
          }
          return realRename(from, to);
        };
        fs.openSync = (file, ...args) => {
          if (!injected && mode === 'artifact-consume' && typeof file === 'string' && path.basename(file).startsWith('promotion-')) {
            injected = true; throw Object.assign(new Error('controlled private consumption failure'), { code: 'EIO' });
          }
          return realOpen(file, ...args);
        };
        try { await assert.rejects(api.resume(failure, live), { code: 'EIO' }); assert(injected, mode + ': intended boundary was reached'); }
        finally { fs.renameSync = realRename; fs.openSync = realOpen; }
        assert.equal(api.describe(failure).state, 'unvalidated', 'failed finalization keeps the original candidate');
        if (mode === 'execute-checkpoint') {
          assert.equal(derivedAnchors().length, 1, 'derived anchor precedes the interrupted checkpoint');
          anchorBeforeRetry = fs.readFileSync(path.join(path.dirname(request.resultFile), derivedAnchors()[0]));
        }
      }
      resumed = await api.resume(failure, live);
    }
    finally { fs.writeFileSync = originalWrite; }
    if (mode.startsWith('handoff')) assert(handoffRecorded, 'retry establishes durable original failure before derived continuation');
    assert.equal(resumed.status, 'done');
    if (isExecute) {
      assert.equal(fs.readFileSync(path.join(lab.a, 'same.txt'), 'utf8'), 'retained alpha\n');
      assert.equal(fs.readFileSync(path.join(lab.b, 'same.txt'), 'utf8'), 'retained beta\n');
      assert(fs.readFileSync(path.join(base, 'slices/S01/S01-PLAN.md'), 'utf8').includes('- [x]'));
      // Issue 337: the derived channel anchors the returned object; the failed parent stays anchor-free.
      const anchors = derivedAnchors();
      assert.equal(anchors.length, 1, mode + ': exactly one derived anchor');
      const anchorFile = path.join(path.dirname(request.resultFile), anchors[0]), anchorBytes = fs.readFileSync(anchorFile);
      const derivedReceipt = JSON.parse(fs.readFileSync(anchorFile.slice(0, -'.returned.json'.length) + '.receipt.json', 'utf8'));
      assert.equal(derivedReceipt.returned_response.sha256, require('crypto').createHash('sha256').update(anchorBytes).digest('hex'));
      const anchor = JSON.parse(anchorBytes);
      assert.equal(anchor.dispatch_id, request.dispatchId); assert.equal(anchor.result.status, 'done');
      assert.equal(fs.existsSync(request.resultFile + '.returned.json'), false, 'failed parent channel gains no anchor');
      if (mode === 'execute-checkpoint') assert.deepEqual(anchorBytes, anchorBeforeRetry, 'retry reuses the derived anchor byte for byte');
      console.log(`PASS issue337 provisional ${mode}: derived resultFile.returned.json is bound to the derived receipt and reused byte-identically; the failed parent channel gains no anchor`);
    } else if (isPlan) assert.equal(fs.readFileSync(path.join(base, 'slices/S01/tasks/T01/T01-PLAN.md'), 'utf8'), candidate.task_plans[0].content);
    else if (isArtifacts) assert.equal(fs.readFileSync(path.join(lab.owner, artifact), 'utf8'), content);
    assert.deepEqual(fs.readFileSync(receiptFile), receiptBefore); assert.deepEqual(fs.readFileSync(request.resultFile), resultBefore);
    assert.equal(fs.readFileSync(count, 'utf8'), '1\n', 'canonical reuse performs no new inference');
    const events = fs.readFileSync(path.join(lab.owner, '.gsd/forge/events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.filter(event => event.event === 'sidecar-unit' && event.status === 'failed' && event.dispatch_id === request.dispatchId).length, 1, 'failure transaction emits one terminal event');
    if (mode === 'handoff-result') assert(fs.existsSync(request.resultFile + '.recovery.json'), 'failed result repair also completes recovery capture');
    console.log(`PASS ${mode}: actual CLI watchdog failure, full original unit continuation, canonical publication, immutable failed receipt and one inference`);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      lab.cleanup();
    }
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    claude.invokeClaudeSidecar = originalInvoke;
    if (previousBin === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN; else process.env.FORGE_XLLM_CLAUDE_BIN = previousBin;
  }
}
main().then(() => console.log('forge-claude-provisional checks passed')).catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
