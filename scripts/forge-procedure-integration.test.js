#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256 } = require('./forge-delivery');
const { loadProcedureContext } = require('./forge-procedure-context');
const { renderPrompt } = require('./forge-prompt');
const native = require('./forge-native-invocation');
const boundary = require('./forge-context-boundary');
const sidecar = require('./forge-unit-sidecar');
const { measure } = require('./forge-attempt-telemetry');

// Existing vertical caller fixtures remain separate from the new composed
// research delivery below. Each is an offline subprocess, never a provider.
const VERTICALS = [
  ['forge-procedure-callers.test.js', 'real caller/procedure tests passed', 'auto/next argv, R5 memory query, pause/handoff'],
  ['forge-task-preparation-installed.test.js', '0 failed', 'temporary installation, both hosts, standalone preparation'],
  ['forge-task-execution.test.js', 'guards, delivery and replay passed', 'standalone execution, fake sidecar CLI, external CODE_DIR'],
  ['forge-native-invocation.test.js', 'forge-native-invocation: ok', 'both native host schemas and exact model/effort'],
  ['forge-attempt-recovery.test.js', 'PASS', 'durable recovery identity, questions, process/writer reconciliation'],
  ['forge-slice-git-guard.test.js', '0 failed', 'owner closure guard snapshot/verify regressions'],
];

async function composedCycle(root, source, host) {
  const owner = path.join(root, host); fs.mkdirSync(path.join(owner, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ token_budget: { auto_memory: 0, coding_standards: 0, ledger: 0 } }));
  const identity = boundary.unitIdentity(null, 'research-milestone/M001', null, { milestone: 'M001' });
  const options = { run: 'M001' };
  boundary.persistQuestions(owner, identity, options, [{ id: 'fixture-choice', question: 'Synthetic retained choice?' }]);
  let pending = boundary.peek(owner, identity, options);
  const record = JSON.parse(fs.readFileSync(pending.pending_file));
  record.additional_context = 'SYNTHETIC restart handoff sentinel; choice remains pending.';
  fs.writeFileSync(pending.pending_file, JSON.stringify(record));
  // Serialize/reload the same durable record as a restarted caller would.
  assert.equal(JSON.parse(fs.readFileSync(pending.pending_file)).pending_questions[0].status, 'pending');
  boundary.persistQuestions(owner, identity, options, []);
  assert.equal(JSON.parse(fs.readFileSync(pending.pending_file)).pending_questions[0].status, 'pending');
  assert.throws(() => boundary.persistQuestions(owner, identity, options, [], [{ id: 'foreign', answer: 'yes' }]), /pending-answer-id/);
  let calls = 0;
  const model = host === 'codex' ? 'gpt-6-sol' : 'claude-sonnet-5';
  const route = { config_ok: true, dispatch_allowed: true, model, model_requested: model, model_resolved: model,
    effort: 'medium', host_runtime: host, resolved_worker_engine: host, worker_mode: 'native' };
  const caps = host === 'codex'
    ? { available: true, tool: 'spawn_agent', models: [model], reasoning_efforts: ['medium'], fork_turns: ['none'] }
    : { available: true, tool: 'Agent', model_aliases: ['sonnet'], effort_transports: ['agent-frontmatter'] };
  const agentPath = path.join(owner, 'forge-researcher.md');
  fs.writeFileSync(agentPath, '---\nname: forge-researcher\nmodel: claude-sonnet-5\neffort: medium\n---\nSynthetic agent fixture\n');
  const effortBinding = { transport: 'agent-frontmatter', agentPath, sourceFingerprint: `sha256:${sha256(fs.readFileSync(agentPath))}` };
  const request = { cwd: owner, contextRoot: owner, scope: 'milestone', unitType: 'research-milestone',
    phase: 'research', milestoneId: 'M001', workflowId: 'fixture-workflow', dispatchId: `fixture-${host}`,
    resultFile: path.join(root, `${host}-result.json`), route };
  const file = '.gsd/milestones/M001/M001-RESEARCH.md';
  const candidate = { status: 'done', summary: 'Synthetic composed research', questions: [],
    artifacts: [{ path: file, content: '# Research\n\nSYNTHETIC public findings.\n' }] };
  async function dispatchAfterExplicitAnswer() {
    const questions = JSON.parse(fs.readFileSync(pending.pending_file)).pending_questions;
    if (questions.some(row => row.status === 'pending')) return { blocked: true };
    const rendered = renderPrompt({ cwd: owner, codeDir: source, templateDir: path.join(source, 'shared/templates/dispatch'),
      unitType: request.unitType, milestoneId: 'M001', description: 'Synthetic public procedure cycle', unitEffort: 'medium', autoCommit: false,
      memoryMaxTokens: 0, standardsMaxTokens: 0, ledgerMaxTokens: 0, memoryQuery: '', memories: '', ledger: '',
      pendingContextFile: pending.pending_file });
    const procedure = loadProcedureContext({ cwd: source, phase: request.unitType });
    assert.equal(rendered.procedure_context.composition_sha256, procedure.composition_sha256);
    for (const module of procedure.modules) assert.equal(rendered.prompt.split(`<!-- forge-procedure:${module.id} -->`).length - 1, 1);
    assert(rendered.prompt.includes('SYNTHETIC restart handoff sentinel'));
    assert.equal(rendered.final_prompt_sha256, sha256(rendered.prompt));
    assert.equal(sidecar.beginArtifactAttempt(request).state, 'started');
    const result = await native.invokeNative({ cwd: owner, hostRuntime: host, resolvedDispatch: route, activeCapabilities: caps,
      agentType: 'forge-researcher', taskName: `composed_${host}`, prompt: rendered.prompt,
      ...(host === 'claude' ? { effortBinding } : {}) }, async args => {
      calls++;
      assert.equal(host === 'codex' ? args.message : args.prompt, rendered.prompt);
      return candidate;
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    // Independent emitter measurement agrees with the final native boundary.
    assert.equal(result.final_evidence.context.sha256, measure(rendered.prompt, 'emitter').sha256);
    const accepted = await sidecar.acceptArtifactResult(request, candidate, { providerCalled: true, finalEvidence: result.final_evidence });
    assert.equal(accepted.result.status, 'done');
    return { blocked: false };
  }
  assert.deepEqual(await dispatchAfterExplicitAnswer(), { blocked: true });
  assert.equal(calls, 0, 'fixture caller cannot dispatch a dependent phase before explicit answer');
  boundary.persistQuestions(owner, identity, options, [], [{ id: 'fixture-choice', answer: 'synthetic-answer' }]);
  assert.equal(JSON.parse(fs.readFileSync(pending.pending_file)).pending_questions[0].status, 'resolved');
  assert.deepEqual(await dispatchAfterExplicitAnswer(), { blocked: false });
  const bytes = fs.readFileSync(path.join(owner, file));
  const receipt = fs.readFileSync(request.resultFile + '.receipt.json');
  for (let repeat = 0; repeat < 2; repeat++) {
    const replay = await sidecar.replayArtifactAttempt(JSON.parse(JSON.stringify(request)));
    assert.equal(replay.replayed, true); assert.equal(replay.provider_called, false);
    assert.deepEqual(fs.readFileSync(path.join(owner, file)), bytes);
    assert.deepEqual(fs.readFileSync(request.resultFile + '.receipt.json'), receipt);
  }
  assert.equal(calls, 1, 'restart/replay must not invoke even the synthetic adapter twice');
  assert.equal(boundary.acknowledge(owner, identity, options, 'foreign').acknowledged, false);
  assert.equal(boundary.acknowledge(owner, identity, options, pending.pending_id).acknowledged, true);
  assert.equal(boundary.peek(owner, identity, options).pending, false);
  console.log(`PASS composed/${host}: mandatory package + durable question/handoff + final capture + receipt + two idempotent replays; synthetic callback only`);
}

async function main() {
  const source = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-procedure-cycle-'));
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME'].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(previous)) process.env[key] = root;
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'shared/forge-procedures.json')));
    const exercised = new Set();
    for (const phase of manifest.phases) {
      const loaded = loadProcedureContext({ cwd: source, phase: phase.id });
      assert.equal(loaded.modules[0].id, 'core');
      assert.equal(new Set(loaded.modules.map(row => row.id)).size, loaded.modules.length);
      assert.equal(loaded.composition_sha256, sha256(loaded.content));
      loaded.modules.forEach(row => exercised.add(row.id));
    }
    assert.deepEqual([...exercised].sort(), manifest.modules.map(row => row.id).sort());
    assert(manifest.modules.every(row => row.status === 'ready'));
    console.log(`PASS manifest: ${manifest.phases.length} real phases, every mandatory module included without optional budgets`);
    for (const host of ['codex', 'claude']) await composedCycle(root, source, host);
    for (const [file, marker, coverage] of VERTICALS) {
      const result = spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: source,
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(result.status, 0, `${file}: ${result.stdout}\n${result.stderr}`);
      assert(result.stdout.includes(marker), `${file}: missing completion marker ${marker}\n${result.stdout}`);
      console.log(`PASS reused vertical/${file}: ${coverage}; source sha256 ${sha256(fs.readFileSync(path.join(__dirname, file)))}`);
    }
    console.log('PASS procedure integration: composed research cycles plus separately identified real caller verticals; no provider, product project or UAT');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
