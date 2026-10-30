'use strict';
// Real owner, worker and sidecar APIs; isolated files only, no provider or UI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pending = require('./forge-pending-questions');
const channel = require('./forge-question-channel');
const side = require('./forge-unit-sidecar');
const recovery = require('./forge-attempt-recovery');
const client = require('./forge-appserver-client');
const { digest } = require('./forge-code-roots');
const personal = require('./forge-personal-context');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-question-flow-'));
  const owner = path.join(root, 'owner'), code = path.join(root, 'code'), home = path.join(root, 'home');
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  };
  try {
    for (const dir of [path.join(owner, '.gsd/forge'), code, home]) fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, USERPROFILE: home, HOME: home, FORGE_PERSONAL_HOME: path.join(home, '.forge-personal') };
    write(path.join(owner, '.gsd/milestones/M001/M001-STATE.md'), '---\nmilestone: M001\nkind: milestone\n---\n**Phase:** idle\n');
    write(path.join(owner, '.gsd/forge/runs/M001.json'), { id: 'M001', kind: 'milestone', project: owner, cwd: owner, active: false });
    assert.strictEqual(personal.bindWork({ cwd: owner, project: owner, userHome: home, env, id: 'M001', intent: 'create' }).status, 'ok');
    const scope = { cwd: owner, unit: 'discuss-milestone/M001', milestone: 'M001' };
    const questions = [{ id: 'scope', question: 'Qual escopo?' }, { id: 'root', question: 'Qual raiz?' }];
    const opened = pending.openQuestions({ ...scope, decision_set: 'flow', questions });
    const base = { cwd: owner, identity: opened.identity_sha256 };
    const decision = { ...questions[0], header: 'Escopo', options: [
      { label: 'Local', description: 'Restringe ao projeto.' }, { label: 'Amplo', description: 'Inclui outras raízes.' }], recommended: 'Local' };
    const selected = channel.selectChannel({ host: 'codex', mode: 'default', tools: [] });
    assert.strictEqual(selected.channel, 'text-fallback');
    assert(channel.presentDecision(decision, selected.channel).message.includes('scope'));
    assert.strictEqual(channel.waitPolicy(selected.channel).action, 'close-round');
    pending.recordRound({ ...base, ids: ['scope'], channel: selected.channel, outcome: 'closed-unanswered' });
    const restarted = spawnSync(process.execPath, [path.join(__dirname, 'forge-pending-questions.js'), '--continuation',
      '--cwd', owner, '--identity', opened.identity_sha256, '--json'], { encoding: 'utf8', windowsHide: true, env });
    assert.strictEqual(restarted.status, 3, restarted.stderr);
    assert.deepStrictEqual(JSON.parse(restarted.stdout).pending_ids, ['scope', 'root']);
    pending.answer({ ...base, answers: [{ id: 'scope', answer: 'Local', source: 'user-text' }] });
    assert.deepStrictEqual(pending.continuation(base).pending_ids, ['root']);
    pending.answer({ ...base, answers: [{ id: 'root', answer: 'Atual', source: 'tool-answer' }] });
    assert.strictEqual(pending.continuation(base).ok, true);
    console.log('PASS owner flow: text presentation, closed-unanswered, child restart, partial gate and answered continuation');

    const asyncChannel = channel.selectChannel({ host: 'codex', mode: 'default', tools: ['request_user_input', 'request_user_input_async'] });
    assert.strictEqual(asyncChannel.channel, 'codex-request-user-input-async');
    assert.strictEqual(channel.presentDecision(decision, asyncChannel.channel).handle_is_answer, false);
    const asyncOpen = pending.openQuestions({ ...scope, decision_set: 'async', questions: [questions[0]] });
    const asyncBase = { cwd: owner, identity: asyncOpen.identity_sha256 };
    for (const outcome of ['presented', 'handle-accepted']) {
      pending.recordRound({ ...asyncBase, ids: ['scope'], channel: asyncChannel.channel, outcome });
      assert.deepStrictEqual(pending.continuation(asyncBase).pending_ids, ['scope']);
    }
    console.log('PASS async flow: both exposed tools prefer async; presented and handle-accepted preserve pending');

    const route = { unit_type: 'research-milestone', host_runtime: 'codex', resolved_worker_engine: 'codex',
      worker_mode: 'sidecar', model: 'gpt-fixture', model_resolved: 'gpt-fixture', effort: 'medium', tier: 'standard', dispatch_allowed: true };
    const request = { cwd: code, contextRoot: owner, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
      milestoneId: 'M001', workflowId: 'question-flow', dispatchId: 'flow-worker', route, prompt: 'Fixture only.', resultFile: path.join(root, 'worker.json') };
    side.beginArtifactAttempt(request);
    const accepted = await side.acceptArtifactResult(request, { status: 'partial', summary: 'Decision required', questions: [questions[1]], artifacts: [] }, { providerCalled: true });
    assert.strictEqual(accepted.record.phase, 'ready');
    assert.strictEqual(accepted.record.result.status, 'partial');
    assert.strictEqual(accepted.record.pending_questions[0].id, 'root');
    write(path.join(owner, '.gsd/forge/events.jsonl'), JSON.stringify({ event: 'dispatch', unit: 'research-milestone/M001', dispatch_id: request.dispatchId,
      milestone: 'M001', host_runtime: 'codex', transport: 'sidecar', engine: 'codex', status: 'started', ts: new Date().toISOString() }) + '\n');
    const handoff = pending.handoff({ cwd: owner, receipt: request.resultFile + '.receipt.json', unit: 'research-milestone/M001', milestone: 'M001' });
    assert.strictEqual(handoff.identity.dispatch_id, request.dispatchId);
    assert.strictEqual(handoff.agent_link.status, 'linked');
    const own = pending.listPendingQuestions({ cwd: owner, userHome: home, env, filter: { type: 'personal' } });
    assert(own.questions.some(q => q.id === 'root' && q.origin.dispatch_id === request.dispatchId));
    console.log('PASS worker flow: real artifact attempt ready partial, pending questions, origin-linked handoff and personal read');

    const inboundRequest = { ...request, dispatchId: 'flow-sidecar', resultFile: path.join(root, 'sidecar.json') };
    const receiptFile = inboundRequest.resultFile + '.receipt.json', stateFile = inboundRequest.resultFile + '.recovery.json';
    write(receiptFile, { phase: 'failed', dispatch_id: inboundRequest.dispatchId, fingerprint: side.artifactFingerprint(inboundRequest),
      recovery_identity_sha256: digest(recovery.requestIdentity(inboundRequest)), failure: { provider_called: true } });
    const inbound = { id: 'req-1', method: 'item/tool/requestUserInput', class: 'input', thread_id: 'thread-1', turn_id: 'turn-1' };
    const error = Object.assign(new Error(client.APPSERVER_INPUT_MESSAGES.INPUT_REQUIRED), {
      code: client.APPSERVER_INPUT_CODES.INPUT_REQUIRED, inboundRequests: [inbound], provider_called: true });
    const captured = recovery.captureFailure({ stateFile, receiptFile, request: inboundRequest, unit: 'research-milestone/M001', route, error });
    assert.strictEqual(captured.pending_questions.length, 1);
    assert.match(captured.pending_questions[0].id, /^inbound-[0-9a-f]{24}$/);
    const guarded = { stateFile, receiptFile, request: inboundRequest, processProbe: () => 'stopped',
      resolveDispatch() { throw Error('must not select another model'); }, invoke() { throw Error('must not retry input'); } };
    assert.strictEqual((await recovery.recoverAttempt(guarded)).action, 'pending-questions');
    const inboundHandoff = pending.handoff({ cwd: owner, receipt: receiptFile, recovery_state: stateFile, unit: 'research-milestone/M001', milestone: 'M001' });
    assert.strictEqual(inboundHandoff.identity.dispatch_id, inboundRequest.dispatchId);
    assert.strictEqual(inboundHandoff.questions[0].id, captured.pending_questions[0].id);
    const inboundBase = { cwd: owner, identity: inboundHandoff.identity_sha256 };
    assert.strictEqual(pending.continuation(inboundBase).ok, false);
    const answers = captured.pending_questions.map(q => ({ id: q.id, answer: 'Manter recusa', source: 'user-text' }));
    pending.answer({ ...inboundBase, answers });
    assert.strictEqual(pending.continuation(inboundBase).ok, true);
    assert.deepStrictEqual(await recovery.recoverAttempt({ ...guarded, answers: answers.map(({ id, answer }) => ({ id, answer })) }),
      { action: 'stop', reason_code: 'answered-continuation-required' });
    console.log('PASS sidecar flow: client input-required shape, captureFailure, pending recovery, inbound handoff and answered-continuation-required');
    console.log('PASS flow limits: temporary roots only; no provider, host UI or human acceptance claimed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
