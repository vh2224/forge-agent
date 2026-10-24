'use strict';

// Integration boundaries only: existing unit suites retain their detailed negatives.
// Every provider is injected. The restart below is an OS process, not a new object.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
function stageProcedures(home) {
  const source = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'shared/forge-procedures.json'), 'utf8'));
  for (const relative of ['shared/forge-procedures.json', ...manifest.modules.map(module => module.path)]) {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
  }
}
function fixtureGitPath() {
  const original = process.env.PATH || '';
  if (process.platform !== 'win32') return original;
  try {
    const git = require('./forge-capabilities').resolveExecutable('git');
    if (!git) return original;
    const probe = (file, args) => {
      const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (result.status !== 0) throw Error('fixture-git-probe-failed');
      return result.stdout.trim();
    };
    const execPath = fs.realpathSync(probe(git, ['--exec-path']));
    const candidate = fs.realpathSync(path.resolve(execPath, '..', '..', 'bin', 'git.exe'));
    const installation = fs.realpathSync(path.resolve(path.dirname(git), '..'));
    const relative = path.relative(installation, candidate);
    if (path.isAbsolute(relative) || relative.startsWith('..')) return original;
    const version = probe(git, ['--version']);
    if (probe(candidate, ['--version']) !== version
      || fs.realpathSync(probe(candidate, ['--exec-path'])) !== execPath) return original;
    console.log(`Fixture Git: ${version}; same installation and exec-path; direct executable ${candidate}`);
    return path.dirname(candidate) + path.delimiter + original;
  } catch { return original; }
}
// Fixtures mutate process.env, so parallel groups use independent OS processes.
async function runGroups(transitionOnly) {
  const started = performance.now(), source = path.resolve(__dirname, '..');
  const gitPath = fixtureGitPath();
  const groups = ['standalone-signed', 'standalone-unsigned', 'milestone-signed', 'milestone-unsigned', 'context']
    .map(name => ({ name, args: [__filename, '--transition-case', name], timeout: 300000 }));
  if (!transitionOnly) groups.push(
    { name: 'integration', args: [__filename, '--integration-only'], timeout: 300000 },
    ...[
      ['forge-task-preparation.test.js'],
      ['forge-unit-sidecar.test.js', '--delivery-publication-limits'],
      ['forge-unit-sidecar.test.js', '--recovery-contracts'],
      ['forge-unit-sidecar.test.js', '--pre-spawn-sidecar'],
      ['forge-unit-sidecar.test.js', '--pre-spawn-native'],
      ['forge-attempt-recovery.test.js'],
      ['forge-unit-controller.test.js'],
    ].map(([suite, ...selectors]) => ({ name: [suite, ...selectors].join(' '),
      args: [path.join(__dirname, suite), ...selectors], timeout: 120000, delegated: true })));
  // Start the slow independent groups first to keep the three-worker tail short.
  const order = ['standalone-unsigned', 'milestone-unsigned', 'context',
    'forge-unit-sidecar.test.js --pre-spawn-sidecar', 'forge-task-preparation.test.js',
    'forge-unit-sidecar.test.js --pre-spawn-native', 'forge-unit-sidecar.test.js --recovery-contracts',
    'integration', 'forge-unit-controller.test.js', 'standalone-signed', 'milestone-signed',
    'forge-attempt-recovery.test.js', 'forge-unit-sidecar.test.js --delivery-publication-limits'];
  groups.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const profiles = [], results = [];
  let next = 0;
  async function worker() {
    while (next < groups.length) {
      const group = groups[next++];
      const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-workflow-home-')));
      profiles.push(profile);
      const forgeHome = path.join(profile, 'forge');
      stageProcedures(forgeHome);
      const env = { ...process.env, HOME: profile, USERPROFILE: profile, CODEX_HOME: path.join(profile, '.codex'),
        CLAUDE_CONFIG_DIR: path.join(profile, '.claude'), FORGE_HOME: group.delegated ? source : forgeHome };
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = gitPath;
      const began = performance.now();
      const result = await new Promise(resolve => {
        const proc = spawn(process.execPath, group.args, { env, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', error = null, cleanup = null;
        const timer = setTimeout(() => {
          error = 'group-timeout';
          cleanup = require('./forge-resources-bench').killTreeAsync(proc);
        }, group.timeout);
        proc.stdout.on('data', bytes => { stdout += bytes.toString(); });
        proc.stderr.on('data', bytes => { stderr += bytes.toString(); });
        proc.on('error', value => { error = value.code || 'spawn-error'; });
        proc.on('close', async (code, signal) => {
          clearTimeout(timer);
          const cleanupResult = cleanup ? await cleanup : null;
          if (cleanupResult && !cleanupResult.ok) group.cleanupUnproved = true;
          resolve({ group: group.name, code, signal, error, duration_ms: Math.round(performance.now() - began), stdout, stderr });
        });
        console.log(`START workflow group ${group.name}; pid=${proc.pid}`);
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (group.cleanupUnproved) profiles.splice(profiles.indexOf(profile), 1);
      const { stdout, stderr, ...summary } = result;
      results.push(summary);
      console.log(`END workflow group ${JSON.stringify(summary)}`);
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: 3 }, () => worker()));
  try {
    for (const worker of workers) if (worker.status === 'rejected') console.error(worker.reason);
    assert.equal(results.length, groups.length, 'every original fixture group must run');
    assert(results.every(result => result.code === 0 && !result.error), 'workflow group failed');
    console.log(`PASS workflow groups ${results.length}/${groups.length}; duration_ms=${Math.round(performance.now() - started)}`);
  } finally {
    // Cleanup follows every child close; no worker can still use these profiles.
    for (const profile of profiles) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}
// Set isolation before loading modules which may cache preference sources.
if (!['--isolated', '--restart-fixture', '--milestone-restart', '--transition-case', '--integration-only', '--transition-restart'].includes(process.argv[2])) {
  runGroups(process.argv[2] === '--transition-only').catch(error => { console.error(error); process.exitCode = 1; });
} else {
const prep = require('./forge-task-preparation');
const interaction = require('./forge-interaction');
const personal = require('./forge-personal-context');
const controller = require('./forge-unit-controller');
const unit = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');

const capabilities = { available: true, tool: 'collaboration.spawn_agent', source: 'fixture',
  models: ['gpt-5.6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] };
const reference = 'conversation:workflow-fixture';
const content = '# Brainstorm\n\n## Recommended Approach\n\nUse canonical callers.\n\n## Alternatives Considered\n\nRepeat transport.\n\n## Top Risks\n\nLost authority.\n\n## Out of Scope\n\nReal providers and UAT.\n';
function envelope(request) {
  return { status: 'done', summary: 'Fixture only', questions: [],
    artifacts: [{ path: prep.requiredArtifact(request), content }] };
}
function authority(profile, now, register) {
  const adapter = interaction.createRecoveryAuthorizationAdapter(observed => ({ ...observed,
    received: true, answer: 'authorize', resolved_at: now }), { resolveProfile: () => profile, clock: () => now });
  return { adapter, reference, ...(register ? { registration: { host: 'codex', section: 'user:forge-routing-continuity' } } : {}) };
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function resolveMilestone(request) {
  request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: request.contextRoot, unitType: request.unitType,
    milestoneId: request.milestoneId, unitId: request.taskId || request.sliceId || request.milestoneId,
    planPath: request.planFile, roadmapPath: request.roadmapFile, hostRuntime: 'codex' });
  return request;
}
function child(args, env) {
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, env });
  assert.equal(run.status, 0, `${args.join(' ')}\n${run.stdout}\n${run.stderr}\n${run.error || ''}`);
  return run.stdout;
}
async function restart(file) {
  const saved = JSON.parse(fs.readFileSync(file));
  const { request, profile } = saved;
  const stateFile = request.resultFile + '.recovery.json', receiptFile = request.resultFile + '.receipt.json';
  const initial = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(initial.schema_version, 2); assert(!Object.hasOwn(initial, 'deadline_at'));
  let now = initial.started_at + 60001; // past the former 60000 ms window; v2 has no deadline_at
  request.activeCapabilities = capabilities;
  let calls = 0;
  const result = await prep.recoverStandaloneTask(request, { stateFile, receiptFile, clock: () => ++now }, {
    processProbe: () => 'stopped', recoveryAuthorization: authority(profile, now),
    invokeNative: async args => {
      calls++;
      assert.equal(args.model, 'gpt-5.6-sol'); assert.equal(args.reasoning_effort, 'medium');
      assert.equal(args.fork_turns, 'none');
      return `---GSD-WORKER-RESULT---\nstatus: done\nresult_json: ${JSON.stringify(envelope(request))}\n---END-RESULT---`;
    },
  });
  assert.equal(result.result.status, 'done'); assert.equal(result.sidecar_ceiling, null); assert(!Object.hasOwn(result, 'sidecar_remaining_ms'));
  assert.equal(calls, 1); assert.equal(result.route.worker_mode, 'native');
  const persisted = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(persisted.started_at, initial.started_at); assert.equal(persisted.budget, 'tier-ceiling'); assert(!Object.hasOwn(persisted, 'deadline_at'));
  const published = path.join(request.contextRoot, prep.requiredArtifact(request));
  const bytes = fs.readFileSync(published), stat = fs.statSync(published);
  const acceptedRequest = { ...request, recoveryStateFile: stateFile };
  // Replay the accepted dispatch through its canonical persisted receipt.
  const files = fs.readdirSync(path.dirname(request.resultFile)).filter(name => name.endsWith('.receipt.json'));
  const accepted = files.map(name => path.join(path.dirname(request.resultFile), name))
    .find(name => JSON.parse(fs.readFileSync(name)).phase === 'ready');
  assert(accepted, JSON.stringify(files));
  const receipt = JSON.parse(fs.readFileSync(accepted));
  acceptedRequest.resultFile = accepted.replace(/\.receipt\.json$/, '');
  acceptedRequest.dispatchId = receipt.dispatch_id;
  const replay = await prep.prepareStandaloneTask(acceptedRequest, {
    resolveDispatch() { throw Error('replay must not resolve'); },
    invokeNative() { throw Error('replay must not invoke'); },
  });
  assert.equal(replay.replayed, true, JSON.stringify(replay)); assert.equal(replay.provider_called, false);
  assert.deepEqual(fs.readFileSync(published), bytes); assert.equal(fs.statSync(published).mtimeMs, stat.mtimeMs);
  fs.writeFileSync(file + '.result.json', JSON.stringify({ pid: process.pid, calls, receipt: accepted, published,
    started_at: initial.started_at, sidecar_ceiling: result.sidecar_ceiling, worker_mode: result.route.worker_mode }));
}
async function transitionRestart(file) {
  const h = require('./forge-recovery-transition.test');
  const f = JSON.parse(fs.readFileSync(file)); f.binding = h.authority(f);
  f.originalReceipt = Buffer.from(f.originalReceipt); if (f.originalEvents) f.originalEvents = Buffer.from(f.originalEvents);
  let calls = 0;
  const runtime = { invokeNative: async (requestOrArgs, invocation) => {
    calls++;
    const args = f.standalone ? requestOrArgs : invocation.args;
    assert.equal(args.model, f.expectedModel); assert.equal(args.reasoning_effort, f.expectedEffort);
    assert.equal(args.fork_turns, 'none');
    return f.standalone ? `---GSD-WORKER-RESULT---\nstatus: partial\nresult_json: ${JSON.stringify({
      status: 'partial', summary: 'Synthetic new attempt, no publication.', questions: [], artifacts: [] })}\n---END-RESULT---` : { fixture: true };
  } };
  if (f.questionEvidence) {
    const evidence = f.questionEvidence; delete f.questionEvidence;
    await assert.rejects(h.recoverPublic(f, { resumeReservation: { sha256: f.reservation } }, runtime), /question-history-unproved/);
    assert.equal(calls, 0); f.questionEvidence = evidence;
  }
  const result = await h.recoverPublic(f, f.reservation ? { resumeReservation: { sha256: f.reservation } } : {}, runtime);
  if (f.signed) {
    assert.equal(result.action, 'replay'); assert.equal(result.result.provider_called, false); assert.equal(calls, 0);
    assert(fs.existsSync(path.join(f.request.contextRoot, unit.locations(f.request).required[0])));
  } else {
    assert.equal(result.action, 'invoke'); assert.equal(calls, 1); assert.equal(result.sidecar_ceiling, null); assert(!Object.hasOwn(result, 'sidecar_remaining_ms'));
    assert(!fs.existsSync(path.join(f.request.contextRoot, unit.locations(f.request).required[0])), 'disposition cannot publish the old candidate');
    const saved = h.assertHistoryPreserved(f);
    assert.equal(saved.reservations.length, 1); assert.equal(saved.transitions.length, 1);
    if (f.questionEvidence) assert.deepEqual(saved.pending_questions, f.questionEvidence);
    // v2 (no cumulative clock): once the native destination is tried, each untried
    // sidecar of the finite chain is still eligible with the tier ceiling; the
    // recovery terminates with recovery-candidates-exhausted, never by a clock.
    const transport = xllm.invokeClaudeTransport, outcomes = [];
    let sidecarCalls = 0;
    const timeout = () => Object.assign(Error('fixture sidecar timeout'), { code: 'claude-timeout', provider_called: 'unknown' });
    xllm.invokeClaudeTransport = async args => { sidecarCalls++; outcomes.push({ transport: true, timeoutSecs: args?.timeoutSecs, model: args?.model }); throw timeout(); };
    try {
      for (let step = 0; step < 4; step++) {
        let next;
        try { next = await h.recoverPublic(f, {}, { ...runtime, invokeSidecar: async () => { sidecarCalls++; throw timeout(); } }); }
        catch (error) { next = { action: 'error', reason_code: error.code || error.message }; }
        outcomes.push({ action: next.action, reason_code: next.reason_code, mode: next.route?.worker_mode, model: next.route?.model,
          ceiling: next.sidecar_ceiling ?? null, sidecarCalls });
        if (next.action === 'stop') break;
      }
    } finally { xllm.invokeClaudeTransport = transport; }
    const ceilings = require('./forge-worker-timeout');
    assert.equal(calls, 1, 'native destination is not retried');
    assert.equal(outcomes.at(-1).action, 'stop'); assert.equal(outcomes.at(-1).reason_code, 'recovery-candidates-exhausted');
    assert(!outcomes.some(row => row.reason_code === 'recovery-deadline-exhausted'), JSON.stringify(outcomes));
    if (f.standalone) {
      const [invoked] = outcomes;
      assert.equal(sidecarCalls, 1, JSON.stringify(outcomes));
      assert.equal(invoked.action, 'invoke'); assert.equal(invoked.mode, 'sidecar'); assert.equal(invoked.model, 'claude-opus-5');
      assert.deepEqual(invoked.ceiling, ceilings.resolveWorkerCeiling({ tier: invoked.ceiling.tier }));
    } else if (f.candidate) {
      // Milestone adapter: the transport itself receives the tier ceiling (standard
      // tier in this fixture), never a remainder of the former 60000 ms window.
      const sent = outcomes.find(row => row.transport);
      assert.equal(sidecarCalls, 1, JSON.stringify(outcomes));
      assert.equal(sent.model, 'claude-opus-5'); assert.equal(sent.timeoutSecs, ceilings.resolveWorkerCeiling({ tier: 'standard' }).seconds);
      assert.equal(outcomes.find(row => row.action).action, 'error');
    } else {
      // Context fixture: the selected untried sidecar is reached (no clock refusal) but
      // the plan-slice request has no prompt file, so the adapter refuses before transport.
      assert.equal(sidecarCalls, 0, JSON.stringify(outcomes));
      assert.equal(outcomes[0].action, 'error'); assert.equal(outcomes[0].reason_code, 'prompt-file-required');
    }
    // A new sidecar attempt may only append owner events; the original history stays intact.
    const heldEvents = f.originalEvents, grownEvents = f.events && fs.existsSync(f.events) ? fs.readFileSync(f.events) : null;
    if (heldEvents) assert(grownEvents.subarray(0, heldEvents.length).equals(heldEvents), 'owner events are append-only');
    if (heldEvents) f.originalEvents = grownEvents;
    h.assertHistoryPreserved(f); f.originalEvents = heldEvents;
  }
  assert.deepEqual(fs.readFileSync(f.receiptFile), f.originalReceipt);
  write(file + '.proof', JSON.stringify({ pid: process.pid, calls, action: result.action }));
}
async function transitionWorkflow(selected) {
  const h = require('./forge-recovery-transition.test'), transition = require('./forge-recovery-transition');
  // Both public APIs distinguish a schema-valid saved response from signed replay.
  for (const standalone of [true, false]) for (const signed of [true, false]) {
    if (selected && selected !== `${standalone ? 'standalone' : 'milestone'}-${signed ? 'signed' : 'unsigned'}`) continue;
    const f = await h.candidateFixture(standalone, signed);
    try {
      f.signed = signed; f.expectedModel = 'gpt-5.6-sol'; f.expectedEffort = standalone ? 'high' : 'medium';
      const inspected = require('./forge-artifact-reconciliation').inspectCandidate({ ...f.reconciliation, receiptFile: f.receiptFile, request: f.request });
      assert.equal(inspected.present, true); assert.equal(inspected.schema_valid, true); assert.equal(inspected.replay_eligible, signed);
      let calls = 0;
      if (signed) {
        const anchorFile = f.receiptFile + '.response-anchor.json', anchor = fs.readFileSync(anchorFile);
        fs.unlinkSync(anchorFile);
        await assert.rejects(h.recoverPublic(f), /historical-binding|original-absence/);
        fs.writeFileSync(anchorFile, anchor);
        const originalManifest = f.reconciliation.manifest;
        f.reconciliation.manifest = { ...originalManifest, dispatch_id: 'forged' };
        await assert.rejects(h.recoverPublic(f), /original-absence/);
        f.reconciliation.manifest = originalManifest;
        const replayed = await h.recoverPublic(f, {}, { transitionAdapter: h.adapter(f, { attestHistory() { throw Error('signed replay cannot request disposition'); } }),
          invokeNative() { calls++; throw Error('replay cannot infer'); } });
        assert.equal(replayed.action, 'replay'); assert.equal(calls, 0);
      } else {
        for (const processState of ['alive', 'unknown']) await assert.rejects(h.recoverPublic(f, {}, { processProbe: () => processState }), /process-receipt-inspection/);
        for (const fake of [{ approved: true }, JSON.parse(JSON.stringify(h.adapter(f)))])
          await assert.rejects(h.recoverPublic(f, {}, { transitionAdapter: fake }), /live-adapter/);
        const heldHistory = f.history;
        f.history = { ...f.history, roots: f.history.roots.slice(1) };
        await assert.rejects(h.recoverPublic(f), /root-coverage/); f.history = heldHistory;
        await assert.rejects(h.recoverPublic(f, {}, { transitionAdapter: h.adapter(f, { attestRoot: challenge => ({
          binding_sha256: require('./forge-code-roots').digest(challenge), evidence_reference: 'unknown-writer', classification: 'unknown' }) }) }), /root-attribution/);
        const changed = JSON.parse(f.originalReceipt); changed.saved_candidate.result.summary = 'Forged candidate';
        changed.saved_candidate.sha256 = require('./forge-code-roots').digest(changed.saved_candidate.result);
        write(f.receiptFile, JSON.stringify(changed));
        await assert.rejects(h.recoverPublic(f), /historical-binding/); fs.writeFileSync(f.receiptFile, f.originalReceipt);
        const malformed = JSON.parse(f.originalReceipt); malformed.saved_candidate.result.status = 'unrecognized';
        malformed.saved_candidate.sha256 = require('./forge-code-roots').digest(malformed.saved_candidate.result);
        write(f.receiptFile, JSON.stringify(malformed));
        assert.equal(require('./forge-artifact-reconciliation').inspectCandidate({ receiptFile: f.receiptFile, request: f.request }).schema_valid, false);
        await assert.rejects(h.recoverPublic(f), /historical-binding/); fs.writeFileSync(f.receiptFile, f.originalReceipt);
        const originalRequest = standalone ? f.raw.inputs.brief : f.request.prompt;
        if (standalone) f.raw.inputs.brief += ' altered'; else f.request.prompt += ' altered';
        await assert.rejects(h.recoverPublic(f), /mismatch|binding/);
        if (standalone) f.raw.inputs.brief = originalRequest; else f.request.prompt = originalRequest;
        const target = path.join(f.b, '.gsd/foreign.json');
        write(target, '{}');
        await assert.rejects(h.recoverPublic(f, {}, { transitionAdapter: h.adapter(f, { attestRoot: challenge => ({
          binding_sha256: require('./forge-code-roots').digest(challenge), evidence_reference: 'no-trusted-attribution', classification: 'unchanged' }) }) }), /root-attribution/);
        fs.unlinkSync(target);
        await assert.rejects(h.recoverPublic(f, {}, { transitionAdapter: h.adapter(f, { attestRoot: challenge => {
          fs.appendFileSync(f.events, '{"concurrent":true}\n');
          return { binding_sha256: require('./forge-code-roots').digest(challenge), evidence_reference: 'raced', classification: 'unchanged' };
        } }) }), /inspection-changed/); fs.writeFileSync(f.events, f.originalEvents);
        // v2 (no cumulative clock): past the former 60000 ms window an untried sidecar
        // is eligible with the tier ceiling while the incompatible native stays refused.
        // Each case consumes a destination, so it runs on its own fresh fixture.
        for (const [capabilityChange, reason] of [[{ models: [] }, 'native-model-unsupported'],
          [{ available: false }, 'native-tool-unavailable'], [{ reasoning_efforts: [] }, 'native-effort-unsupported'],
          [null, 'native-capabilities-missing']]) {
          const g = await h.candidateFixture(standalone, false);
          const transport = xllm.invokeClaudeTransport;
          let sidecarCalls = 0, nativeCalls = 0;
          try {
            assert(g.now > g.initial.started_at + 60000 && !Object.hasOwn(g.initial, 'deadline_at'));
            xllm.invokeClaudeTransport = async () => { sidecarCalls++; return { candidate: g.candidate }; };
            const incompatible = await h.recoverPublic(g, {}, { activeCapabilities: capabilityChange && { ...h.capabilities, ...capabilityChange },
              invokeNative() { nativeCalls++; throw Error('incompatible native must not invoke'); },
              invokeSidecar: async () => { sidecarCalls++; throw Object.assign(Error('fixture sidecar stop'), { code: 'claude-timeout' }); } });
            assert.equal(incompatible.action, 'invoke'); assert.equal(nativeCalls, 0); assert.equal(sidecarCalls, 1);
            assert.equal(incompatible.route.worker_mode, 'sidecar', 'untried sidecar is eligible past the former window');
            assert.deepEqual(incompatible.sidecar_ceiling, require('./forge-worker-timeout').ceilingFromRoute(incompatible.route));
            assert(!Object.hasOwn(incompatible, 'sidecar_remaining_ms'));
            assert(!incompatible.rejected?.some(row => row.reason_code === 'recovery-deadline-exhausted'), 'no cumulative-clock refusal in v2');
            assert(incompatible.rejected?.some(row => row.reason_code === reason), 'current native capability refusal is explicit');
          } finally { xllm.invokeClaudeTransport = transport; g.cleanup(); }
        }
        assert.equal(calls, 0);
        const authorizationSource = path.join(f.profile, '.codex/AGENTS.md'), authorizationBytes = fs.readFileSync(authorizationSource);
        fs.writeFileSync(authorizationSource, authorizationBytes.toString().replace('Fixture authorization.', 'Revoked after original attempt.'));
        await assert.rejects(h.recoverPublic(f), /source-changed/); fs.writeFileSync(authorizationSource, authorizationBytes);
        const first = await h.recoverPublic(f);
        assert.equal(first.action, 'reattest-native-handoff'); assert.equal(first.provider_called, false);
        assert.equal(first.invocation, undefined); f.reservation = first.reservation_sha256;
        const state = h.assertHistoryPreserved(f);
        const record = JSON.parse(fs.readFileSync(state.transitions[0].path));
        assert.equal(record.disposition, 'unreplayable-original-provenance-absent');
        assert.equal(record.original_candidate_sha256, inspected.candidate_sha256);
        assert.deepEqual(record.reconciliation.map(row => row.root_id), ['owner', 'alpha', 'beta']);
        assert.equal(JSON.parse(fs.readFileSync(f.receiptFile)).phase, 'failed');
        assert(!fs.existsSync(f.receiptFile + '.response-anchor.json'));
        const forged = { ...record, request_identity_sha256: 'foreign-unit' };
        const bytes = Buffer.from(JSON.stringify(forged) + '\n'), sha = require('./forge-code-roots').digest(bytes);
        const foreign = `${f.stateFile}.transition-${sha}.json`; write(foreign, bytes);
        const mutated = structuredClone(state); mutated.transitions[0] = { ...state.transitions[0], path: foreign, sha256: sha };
        require('./forge-xllm-state').saveRecovery(f.stateFile, mutated);
        await assert.rejects(h.recoverPublic(f), /record-binding/);
        require('./forge-xllm-state').saveRecovery(f.stateFile, state); fs.unlinkSync(foreign);
      }
      const saved = path.join(f.dir, 'public-transition-restart.json');
      write(saved, JSON.stringify({ ...f, binding: undefined, cleanup: undefined, originalReceipt: [...f.originalReceipt],
        originalEvents: [...f.originalEvents] }));
      child([__filename, '--transition-restart', saved], process.env);
      const proof = JSON.parse(fs.readFileSync(saved + '.proof')); assert.notEqual(proof.pid, process.pid); assert.equal(proof.calls, signed ? 0 : 1);
      console.log(`PASS public ${standalone ? 'standalone' : 'milestone'} ${signed ? 'signed replay, zero inference' : 'disposition, no publication, native handoff'} across OS restart`);
    } finally { f.cleanup(); }
  }
  if (selected && selected !== 'context') return;
  const f = h.setup({ questions: [{ id: 'functional-choice', question: 'Which fixture branch?' }] });
  try {
    f.originalReceipt = fs.readFileSync(f.receiptFile); f.expectedModel = 'gpt-6-astra'; f.expectedEffort = 'max';
    const pending = await h.recoverPublic(f);
    assert.equal(pending.action, 'pending-questions'); assert.equal(pending.questions[0].id, 'functional-choice');
    assert.equal(require('./forge-xllm-state').loadRecovery(f.stateFile).transitions, undefined);
    await assert.rejects(h.recoverPublic(f, { answers: [{ id: 'foreign', answer: 'ignored' }] }), /pending-answer-id/);
    const result = await h.recoverPublic(f, { answers: [{ id: 'functional-choice', answer: 'explicit fixture answer' }] });
    f.questionEvidence = require('./forge-xllm-state').loadRecovery(f.stateFile).pending_questions;
    assert.equal(result.action, 'reattest-native-handoff'); f.reservation = result.reservation_sha256;
    let refusedCalls = 0;
    for (const [transitionAdapter, reason] of [[{ approved: true }, /live-adapter/],
      [h.adapter(f, { attestHistory: () => ({ approved: true }) }), /history-unproved/]]) {
      await assert.rejects(h.recoverPublic(f, { resumeReservation: { sha256: f.reservation } }, {
        transitionAdapter, invokeNative() { refusedCalls++; throw Error('forged context evidence cannot invoke'); },
      }), reason);
    }
    assert.equal(refusedCalls, 0);
    h.assertHistoryPreserved(f);
    const saved = path.join(f.dir, 'context-transition-restart.json');
    write(saved, JSON.stringify({ ...f, binding: undefined, cleanup: undefined, originalReceipt: [...f.originalReceipt] }));
    child([__filename, '--transition-restart', saved], process.env);
    const state = h.assertHistoryPreserved(f), record = JSON.parse(fs.readFileSync(state.transitions[0].path));
    assert.equal(record.resolution.original.tier, 'heavy'); assert.equal(record.resolution.original.effort, 'high');
    assert.equal(record.resolution.effective.tier, 'max'); assert.equal(record.resolution.effective.effort, 'max');
    assert.equal(state.attempts[0].timeout_cause, 'indeterminate');
    assert.notEqual(transition.destinationKey(f.request.route), state.reservations[0].destination_key);
    console.log('PASS public milestone context omission: heavy/high retained, max/max native after expiry, fresh authority at OS restart');
  } finally { f.cleanup(); }
}
async function main() {
  if (process.argv[2] === '--transition-restart') return transitionRestart(process.argv[3]);
  if (process.argv[2] === '--transition-only') return transitionWorkflow();
  if (process.argv[2] === '--restart-fixture') return restart(process.argv[3]);
  if (process.argv[2] === '--milestone-restart') {
    const request = JSON.parse(fs.readFileSync(process.argv[3]));
    const receiptFile = request.resultFile + '.receipt.json';
    const receipt = JSON.parse(fs.readFileSync(receiptFile));
    const legacy = { ...receipt }; delete legacy.execution; delete legacy.reset_state_file;
    write(receiptFile, JSON.stringify(legacy));
    const recovery = require('./forge-attempt-recovery');
    assert.equal(recovery.inspectReceipt(receiptFile, { request }).writer_possible, true);
    let calls = 0;
    xllm.runExecute = async () => { calls++; throw Error('writer must remain blocked'); };
    for (const status of ['alive', 'stopped']) await assert.rejects(unit.recoverUnitSidecar(request,
      { stateFile: request.resultFile + '.recovery.json', receiptFile }, { processProbe: () => status }),
      status === 'alive' ? /process-receipt-inspection/ : /writer-reconciliation/);
    const partial = unit.reconcileMilestoneAttempt(request, legacy, { verifyOwnership: row => row.root_id === 'alpha' });
    assert.equal(partial.ok, false);
    await assert.rejects(unit.recoverUnitSidecar(request,
      { stateFile: request.resultFile + '.recovery.json', receiptFile }, { processProbe: () => 'stopped' }), /writer-reconciliation/);
    assert.equal(calls, 0);
    const tampered = structuredClone(legacy); tampered.recovery_baseline.state_sha256 = 'tampered';
    assert.throws(() => unit.reconcileMilestoneAttempt(request, tampered, { verifyOwnership: () => true }), /baseline-binding/);
    const absent = { ...legacy }; delete absent.recovery_baseline;
    assert.throws(() => unit.reconcileMilestoneAttempt(request, absent, { verifyOwnership: () => true }), /baseline-required/);
    const reset = unit.reconcileMilestoneAttempt(request, legacy, { verifyOwnership: row =>
      row.attempt === request.dispatchId && ['alpha', 'beta'].includes(row.root_id) && row.path === 'same.txt' });
    assert.equal(reset.ok, true);
    write(process.argv[3] + '.proof', JSON.stringify({ pid: process.pid, calls, roots: reset.roots.map(row => row.root_id) }));
    return;
  }
  if (process.argv[2] === '--transition-case') return transitionWorkflow(process.argv[3]);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recovery-workflow-')));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FORGE_HOME: path.join(root, 'forge-home') };
  try {
    stageProcedures(env.FORGE_HOME);
    const loader = require('./forge-procedure-context');
    const loaded = loader.loadProcedureContext({ cwd: root, forgeHome: env.FORGE_HOME, phase: 'recovery' });
    assert.equal(loaded.root, fs.realpathSync(env.FORGE_HOME));
    assert(loaded.content.includes('tier safety ceiling') && !loaded.content.includes('60000ms'));
    const roots = require('./forge-code-roots.test');
    for (const file of ['shared/forge-dispatch.md', 'shared/forge-bidirectional-sidecar.md',
      'skills/forge-task/SKILL.md', 'skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md']) {
      const contract = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      if (file.includes('forge-auto/') || file.includes('forge-next/')) {
        assert.match(contract, /forge-procedure-context\.js[\s\S]{0,150}--phase recovery/);
        assert.match(contract, /shared\/forge-dispatch\.md/);
        continue;
      }
      for (const token of ['createRecoveryAuthorizationAdapter', 'registerStandingAuthorization',
        'createRecoveryAuthority', 'recoverStandaloneTask', 'recoverUnitSidecar', 'captureMilestoneBaseline',
        'reconcileMilestoneAttempt', 'tier safety ceiling', 'ceilingFromRoute', 'shared/forge-interaction.md']) assert(contract.includes(token), `${file}: ${token}`);
      for (const stale of ['60000ms', 'renewed 300s']) assert(!contract.includes(stale), `${file}: stale ${stale}`);
    }
    console.log('PASS canonical caller contracts share authority, phase adapter, caller baseline and historical budget references');
    const cwd = path.join(root, 'code'), owner = path.join(root, 'owner'); fs.mkdirSync(cwd);
    roots.command('git', ['init', '-q'], cwd);
    roots.command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd);
    write(path.join(owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
      ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5', 'gpt-5.6-sol']])), effort: { 'plan-slice': 'medium' } }));
    write(path.join(home, '.codex/AGENTS.md'), '<!-- user:forge-routing-continuity:start -->\nFixture authority.\n<!-- user:forge-routing-continuity:end -->');
    const request = { schema_version: 1, scope: 'standalone-task', phase: 'brainstorm', taskId: 'T-20261019000000-workflow',
      cwd, contextRoot: owner, hostRuntime: 'codex', workflowId: 'workflow', dispatchId: 'timeout',
      resultFile: path.join(root, 'results/result.json'), constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Fixture only' } };
    fs.mkdirSync(path.dirname(request.resultFile));
    const failed = await prep.prepareStandaloneTask(request, { recoveryAuthorization: authority(home, Date.now(), true),
      invokeSidecar: async () => { throw Object.assign(Error('fixture timeout'), { code: 'claude-timeout' }); } });
    assert.equal(failed.ok, false); assert.equal(failed.provider_called, 'unknown');
    const saved = path.join(root, 'restart.json'); write(saved, JSON.stringify({ request, profile: home }));
    child([__filename, '--restart-fixture', saved], env);
    const proof = JSON.parse(fs.readFileSync(saved + '.result.json'));
    assert.notEqual(proof.pid, process.pid); assert.equal(proof.calls, 1); assert.equal(proof.sidecar_ceiling, null); assert.equal(proof.worker_mode, 'native');
    console.log('PASS R1/R2/R4: caller -> attested authority -> unknown timeout -> new process -> native after deadline -> one publication/replay');

    const f = require('./forge-personal-context.test').fixture();
    try {
      const work = f.work('TASK-001'); f.bind('TASK-001');
      const evidence = path.join(work.dir, 'receipt-reference.json'); write(evidence, JSON.stringify(proof));
      const checkpoint = { acceptances: [{ text: 'Plan accepted', source: work.source, resolved: true }],
        pending: [{ text: 'functional-source: Choose deployment environment', source: evidence }],
        lastResult: [{ text: 'Simulated provider contract verified; UAT pending', source: evidence }],
        nextAction: [{ text: 'Await functional-source answer and real UAT', source: evidence }] };
      assert.equal(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint }).status, 'ok');
      assert.equal(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {
        lastResult: checkpoint.lastResult, nextAction: checkpoint.nextAction } }).status, 'ok');
      const current = personal.readPersonalSnapshot(f.options).works[0];
      assert.equal(current.activity, 'inactive'); assert.equal(current.workStatus, 'pending');
      assert.equal(current.checkpoint.acceptances[0].resolved, true);
      assert(current.checkpoint.pending[0].text.includes('functional-source'));
      assert(current.nextAction.text.includes('real UAT'));
    } finally { f.cleanup(); }
    console.log('PASS R8: temporary personal checkpoint preserves acceptance, functional pending and evidenced result/next action; inactive is pending');

    const lab = roots.fixture(), originalPlan = xllm.runPlan;
    try {
      const milestoneId = 'M-20261019000000-workflow';
      const base = path.join(lab.owner, '.gsd/milestones', milestoneId), slice = path.join(base, 'slices/S01');
      const route = { host_runtime: 'codex', resolved_worker_engine: 'claude', worker_engine: 'claude', worker_mode: 'sidecar',
        sidecar_declared: true, dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
        dispatch_reason_code: 'sidecar-declared', dispatch_decision: 'allow', dispatch_posture: 'cross-engine',
        chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
      const planning = { scope: 'milestone', phase: 'plan', unitType: 'plan-slice', milestoneId, sliceId: 'S01',
        cwd: lab.a, contextRoot: lab.owner, route, workflowId: 'workflow', dispatchId: 'plan',
        resultFile: path.join(lab.dir, 'plan.json'), promptFile: path.join(lab.dir, 'prompt.md') };
      write(planning.promptFile, 'Synthetic plan only.');
      xllm.runPlan = async () => ({ status: 'done', slice_plan: { content: '# Slice\n- [ ] **T01** — First\n- [ ] **T02** — Second\n' },
        task_plans: ['T01', 'T02'].map((id, index) => ({ id, content: roots.plan(lab.contract)
          .replace('id: T-roots', `id: ${id}`)
          .replaceAll(`  - '${index ? 'alpha' : 'beta'}::same.txt'\n`, '')
          .replace(`    - path: '${index ? 'alpha' : 'beta'}::same.txt'\n      provides: 'Result'\n      min_lines: 1\n`, '') })) });
      await unit.runUnitSidecar(resolveMilestone(planning));
      const tasks = require('./forge-parallelism').discoverTasks(slice);
      assert.deepEqual(tasks.map(task => task.id), ['T01', 'T02']);
      for (const task of tasks) {
        assert.equal(task.planPath, path.join(slice, `tasks/${task.id}/${task.id}-PLAN.md`));
        assert(!fs.existsSync(path.join(slice, `tasks/${task.id}-PLAN.md`)));
      }
      const batch = JSON.parse(child([path.join(__dirname, 'forge-parallelism.js'), '--slice-plan', path.join(slice, 'S01-PLAN.md')], env));
      assert.equal(batch.mode, 'parallel'); assert.deepEqual(batch.batch.map(task => task.id), ['T01', 'T02']);
      const originalExecute = xllm.runExecute;
      try {
        const claim = { schema_version: 2, generation: require('crypto').randomUUID(), execution_contract: lab.contract,
          paths: [{ root_id: 'alpha', path: 'same.txt' }, { root_id: 'beta', path: 'same.txt' }] };
        const runId = 'workflow-run';
        require('./forge-runs').add(lab.owner, { id: runId, kind: 'milestone', session_id: 'fixture', write_claim: claim });
        const executionAuthority = { claim, runId,
          gates: { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' } };
        const interrupted = { ...planning, phase: 'execute', unitType: 'execute-task', taskId: 'T01',
          ...executionAuthority,
          planFile: tasks[0].planPath, execution_contract: lab.contract, dispatchId: 'milestone-timeout',
          resultFile: path.join(lab.dir, 'interrupted.json'), prompt: 'Synthetic timeout only' };
        xllm.runExecute = async () => {
          const receipt = JSON.parse(fs.readFileSync(interrupted.resultFile + '.receipt.json'));
          assert.equal(receipt.recovery_baseline.protected_roots.length, 2, 'baseline persisted before writer');
          write(path.join(lab.a, 'same.txt'), 'Interrupted alpha\n');
          write(path.join(lab.b, 'same.txt'), 'Interrupted beta\n');
          throw Object.assign(Error('milestone timeout fixture'), { code: 'claude-timeout' });
        };
        await assert.rejects(unit.runUnitSidecar(resolveMilestone(interrupted)), /milestone timeout fixture/);
        const restartFile = path.join(lab.dir, 'milestone-restart.json'); write(restartFile, JSON.stringify(interrupted));
        child([__filename, '--milestone-restart', restartFile], env);
        const resetProof = JSON.parse(fs.readFileSync(restartFile + '.proof'));
        assert.notEqual(resetProof.pid, process.pid); assert.equal(resetProof.calls, 0);
        assert.deepEqual(resetProof.roots, ['alpha', 'beta']);
        for (const codeRoot of [lab.a, lab.b]) assert.equal(fs.readFileSync(path.join(codeRoot, 'same.txt'), 'utf8'), 'before\n');
        console.log('PASS milestone timeout/restart: pre-spawn baseline, legacy conservative receipt, live/pending-root zero writer, missing/tampered baseline refusal and trusted two-root reset');
        let executionCalls = 0;
        xllm.runExecute = async () => {
          executionCalls++;
          write(path.join(lab.a, 'same.txt'), 'Synthetic milestone result\n');
          return { status: 'done', summary: 'Synthetic milestone writer', files_changed: ['alpha::same.txt'], must_haves_status: [] };
        };
        const execution = { ...planning, phase: 'execute', unitType: 'execute-task', taskId: 'T01',
          ...executionAuthority,
          planFile: tasks[0].planPath, execution_contract: lab.contract, dispatchId: 'milestone-success',
          resultFile: path.join(lab.dir, 'execution.json'), prompt: 'Synthetic only',
          verification: { preferenceCommands: ['node -e "require(\'fs\').accessSync(\'same.txt\')"'] } };
        const gateReady = path.join(lab.dir, 'gate-ready');
        execution.verification.preferenceCommands = [`node -e "require('fs').accessSync('${gateReady.replace(/\\/g, '/')}')"`];
        await assert.rejects(unit.runUnitSidecar(resolveMilestone(execution)), /execution-verification-failed/);
        const receiptFile = execution.resultFile + '.receipt.json';
        const savedResponse = JSON.parse(fs.readFileSync(receiptFile));
        assert.equal(savedResponse.phase, 'executed');
        assert.equal(savedResponse.provider_called, true);
        assert.equal(savedResponse.delivery_capture, undefined, 'failed checks must be rerun, not cached as successful capture');
        const planBytes = fs.readFileSync(execution.planFile);
        fs.appendFileSync(execution.planFile, '\nChanged input\n');
        await assert.rejects(unit.runUnitSidecar(execution), error =>
          error.code === 'verification-provenance-insufficient' && error.provider_called === false);
        assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile)), savedResponse, 'changed sealed plan preserves the saved response receipt');
        assert.equal(executionCalls, 1, 'changed sealed plan cannot infer again');
        assert.equal(fs.existsSync(path.join(slice, 'tasks/T01/T01-SUMMARY.md')), false, 'changed sealed plan cannot publish');
        fs.writeFileSync(execution.planFile, planBytes);
        write(path.join(lab.b, 'same.txt'), 'Foreign root drift\n');
        await assert.rejects(unit.runUnitSidecar(execution), /execution-replay-baseline-changed/);
        write(path.join(lab.b, 'same.txt'), 'before\n');
        write(path.join(lab.b, '.gsd/foreign.json'), '{}');
        await assert.rejects(unit.runUnitSidecar(execution), /execution-protected/);
        fs.rmSync(path.join(lab.b, '.gsd'), { recursive: true });
        assert.equal(executionCalls, 1, 'input/code/protected-root refusal cannot infer again');
        write(gateReady, 'Ready for independent verification\n');
        assert.equal((await unit.runUnitSidecar(execution)).status, 'done');
        const published = path.join(slice, 'tasks/T01/T01-DELIVERY.json');
        const publishedBytes = fs.readFileSync(published), publishedTime = fs.statSync(published).mtimeMs;
        const foreignOwner = path.join(lab.owner, '.gsd/foreign-ready.json');
        write(foreignOwner, '{}');
        await assert.rejects(unit.runUnitSidecar(execution), /execution-protected/);
        fs.unlinkSync(foreignOwner);
        assert.equal((await unit.runUnitSidecar(execution)).status, 'done');
        assert.equal(executionCalls, 1);
        assert.deepEqual(fs.readFileSync(published), publishedBytes);
        assert.equal(fs.statSync(published).mtimeMs, publishedTime);
        for (const rootId of ['alpha', 'beta']) for (const kind of ['VERIFICATION', 'ARTIFACT']) {
          const source = JSON.parse(fs.readFileSync(path.join(slice, `tasks/T01/T01-${kind}-${rootId}-ENVELOPE.json`)));
          assert.equal(source.root_id, rootId); assert.equal(source.result.passed, true);
        }
        console.log('PASS milestone execution: gate failure saves response; plan/code/protected-root drift refuses without inference; per-root real checks and single publication/replay');
        // Continue the controller fixture from its uncompleted task state.
        fs.unlinkSync(path.join(slice, 'tasks/T01/T01-SUMMARY.md'));
        write(path.join(slice, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** First\n- [ ] **T02** Second\n');
      } finally { xllm.runExecute = originalExecute; }
      write(path.join(base, `${milestoneId}-ROADMAP.md`), '# Roadmap\n- [ ] **S01: Workflow**\n');
      const state = require('./forge-state');
      state.write(lab.owner, { milestone: milestoneId, kind: 'milestone', phase: 'execute-task', active_slice: 'S01', active_task: 'T01', next_action: 'execute', auto_mode: 'on' });
      const prefsReader = () => ({ ok: true, prefs: { skip_discuss: true, skip_research: true, skip_slice_research: true } });
      const inventory = controller.discoverInventory(lab.owner, milestoneId, state.read(lab.owner, milestoneId));
      assert.deepEqual(inventory.slices[0].tasks.map(task => task.id), ['T01', 'T02']);
      assert.equal(controller.select(lab.owner, { milestone: milestoneId }, { prefsReader }).unit.id, 'T01');
      const requestUnit = { milestone: milestoneId, unit: 'execute-task/T01', host_runtime: 'claude', session: 'synthetic', owner_token: 'fixture-owner' };
      const began = controller.begin(lab.owner, requestUnit, { prefsReader });
      const complete = controller.complete(lab.owner, { ...requestUnit, owner_token: began.owner_token, generation: began.generation,
        idempotency_key: 'workflow-completion-'.repeat(60), result: { status: 'succeeded', summary: 'Synthetic only' } }, { prefsReader });
      const handoff = controller.handoff(lab.owner, { unit: requestUnit.unit, next_host_runtime: 'codex' }, { prefsReader });
      assert.equal(handoff.reason, 'handoff-ready'); assert.equal(handoff.next_host_runtime, 'codex');
      assert.equal(controller.resume(lab.owner, { idempotency_key: complete.transaction.idempotency_key,
        owner_token: began.owner_token, generation: began.generation }, { prefsReader }).results[0].reason, 'already-committed');
      write(path.join(slice, 'tasks/T01/T01-SUMMARY.md'), '# Simulated T01 completed\n');
      assert.equal(require('./forge-parallelism').discoverTasks(slice)[0].done, true);
      // Controller consumes slice checkboxes while parallelism consumes SUMMARY.
      write(path.join(slice, 'S01-PLAN.md'), '# Slice\n- [x] **T01** — First\n- [ ] **T02** — Second\n');
      assert.equal(controller.select(lab.owner, { milestone: milestoneId }, { prefsReader }).unit.id, 'T02');
      const status = require('./forge-status').collect(lab.owner, { scope: 'workspace', milestoneId });
      assert.equal(status.scope, 'workspace');
      console.log('PASS R2/R6/R8: real plan publisher -> nested T01/T02 -> independent DAG batch -> controller begin/long-key complete/handoff/resume -> canonical summary/next T02/status');
    } finally { xllm.runPlan = originalPlan; lab.cleanup(); }

    assert.equal(typeof controller.begin, 'function'); assert.equal(typeof controller.resume, 'function');
    console.log('PASS R3/R5/R6/R7: focused caller/receipt/root/telemetry/controller/lease negatives above; no real provider or UAT');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
}
