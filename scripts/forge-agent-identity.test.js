#!/usr/bin/env node
'use strict';

// Temporary roots and fake invocation fixtures only. No provider is called and
// nothing here claims that a real host adapter reports its tool return.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const api = require('./forge-agent-identity');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-identity-')));
const HOST_VALUE = '/root/experience_s02_t07_334497b58af1';
const base = { unit: 'S03/T02', dispatch_id: 'dispatch-s03-t02', host_runtime: 'codex', agent_type: 'forge-executor',
  evidence: 'caller-attested' };
const attested = { ...base, agent_id: HOST_VALUE, agent_id_source: 'host-tool-return' };
const fixedNow = () => Date.parse('2026-10-29T12:00:00.000Z');
const hex8 = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
let sequence = 0;
function owner(withForge = true) {
  const dir = path.join(root, `owner-${++sequence}`);
  fs.mkdirSync(dir);
  if (withForge) fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  return dir;
}
const eventsOf = dir => path.join(dir, '.gsd', 'forge', 'events.jsonl');
const bytesOf = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
function receipt(phase, dispatchId = base.dispatch_id) {
  const file = path.join(root, `receipt-${++sequence}.json`);
  fs.writeFileSync(file, JSON.stringify({ phase, fingerprint: 'f'.repeat(64), dispatch_id: dispatchId }));
  return file;
}
function cli(args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'forge-agent-identity.js'), ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
}
const recordArgs = (extra = []) => ['--record', '--unit', 'S03/T02', '--dispatch-id', 'dispatch-cli', '--host', 'codex',
  '--agent-type', 'forge-executor', ...extra];

async function main() {
  const event = api.buildAgentIdentityEvent({ ...attested, task_name: 's03_t02_nome_abcd1234', description: 'Executor da T02' }, fixedNow);
  assert.deepEqual(Object.keys(event), ['ts', 'event', 'unit', 'dispatch_id', 'host_runtime', 'worker_mode', 'agent_type',
    'task_name', 'agent_id', 'agent_id_source', 'evidence', 'lifecycle_identity_sha256', 'description']);
  assert.deepEqual(event, { ts: '2026-10-29T12:00:00.000Z', event: 'agent-identity', unit: 'S03/T02',
    dispatch_id: 'dispatch-s03-t02', host_runtime: 'codex', worker_mode: 'native', agent_type: 'forge-executor',
    task_name: 's03_t02_nome_abcd1234', agent_id: HOST_VALUE, agent_id_source: 'host-tool-return',
    evidence: 'caller-attested', lifecycle_identity_sha256: null, description: 'Executor da T02' });
  const minimal = api.buildAgentIdentityEvent(base, fixedNow);
  for (const key of ['task_name', 'agent_id', 'agent_id_source', 'lifecycle_identity_sha256', 'description']) assert.equal(minimal[key], null, key);
  const line = api.renderAgentIdentityEvent(event);
  assert(line.endsWith('\n') && line.split('\n').length === 2);
  assert.deepEqual(JSON.parse(line), event);
  for (const forged of [{ ...event, extra: 1 }, { ...event, worker_mode: 'sidecar' }, { ...event, description: 'a\nb' },
    { ...event, agent_id: 'bad value' }, { ...event, event: 'dispatch' }]) {
    assert.throws(() => api.renderAgentIdentityEvent(forged), /agent-identity-event-invalid|agent-id-/);
  }
  console.log('PASS S03/T02 agent-identity event: closed key order, optional fields null, one JSON line, forged or extra keys refused');

  assert.deepEqual(api.validateAgentId(HOST_VALUE), { ok: true, value: HOST_VALUE });
  for (const value of ['agent-1', 'A/b_c.d:e-f', '/', 'x'.repeat(256)]) assert.equal(api.validateAgentId(value).ok, true, value);
  const refusedIds = [['', 'agent-id-empty'], [null, 'agent-id-empty'], [42, 'agent-id-empty'], ['x'.repeat(257), 'agent-id-too-long'],
    ['/root/a b', 'agent-id-invalid'], ['/root/"a"', 'agent-id-invalid'], ["/root/'a'", 'agent-id-invalid'],
    ['C:\\root\\a', 'agent-id-invalid'], ['-leading', 'agent-id-invalid'], ['.hidden', 'agent-id-invalid'],
    ['a\tb', 'agent-id-control'], ['\x1b[31ma', 'agent-id-control'], ['\x1b]8;;https://example.invalid\x07a', 'agent-id-control'],
    ['\x9b31ma', 'agent-id-control'], ['a\x7f', 'agent-id-control'], ['a\u{202e}b', 'agent-id-non-ascii'],
    ['a\u{2066}b', 'agent-id-non-ascii'], ['a\u{2028}b', 'agent-id-non-ascii'], ['a\u{2029}b', 'agent-id-non-ascii']];
  for (const [value, reason] of refusedIds) {
    assert.deepEqual(api.validateAgentId(value), { ok: false, reason_code: reason }, JSON.stringify(value));
    if (typeof value === 'string' && value) {
      assert.throws(() => api.buildAgentIdentityEvent({ ...base, agent_id: value, agent_id_source: 'host-tool-return' }), new RegExp(reason));
    }
  }
  assert.throws(() => api.buildAgentIdentityEvent({ ...base, agent_id: HOST_VALUE }), /agent-identity-source-required/);
  assert.throws(() => api.buildAgentIdentityEvent({ ...base, agent_id: HOST_VALUE, agent_id_source: 'caller' }), /agent-identity-source-required/);
  assert.throws(() => api.buildAgentIdentityEvent({ ...base, agent_id_source: 'host-tool-return' }), /agent-identity-source-without-id/);
  const named = api.buildAgentIdentityEvent({ ...base, task_name: 'experience_s02_t07_334497b58af1' }, fixedNow);
  assert.equal(named.agent_id, null, 'agent_id is never derived from task_name');
  const moduleSource = fs.readFileSync(path.join(__dirname, 'forge-agent-identity.js'), 'utf8');
  assert(!/\/root\/['"`]\s*\+|\/root\/\$\{/.test(moduleSource), 'no code composes /root/ plus a name');
  assert(!/agent_id\s*:\s*[^,}\n]*task_?name/i.test(moduleSource), 'no code assigns task_name to agent_id');
  console.log('PASS S03/T02 agent id: opaque /root/ value accepted with host-tool-return source, never derived from task_name, hostile values refused with named codes');

  const refusedFields = [
    [{ host_runtime: 'gemini' }, 'agent-identity-host-invalid'], [{ agent_type: 'executor' }, 'agent-identity-agent-type-invalid'],
    [{ agent_type: 'forge-Executor' }, 'agent-identity-agent-type-invalid'], [{ unit: 5 }, 'agent-identity-unit-invalid'],
    [{ unit: 'S03 T02' }, 'agent-identity-unit-invalid'], [{ unit: undefined }, 'agent-identity-unit-invalid'],
    [{ dispatch_id: 'd\n1' }, 'agent-identity-dispatch-invalid'], [{ dispatch_id: 17 }, 'agent-identity-dispatch-invalid'],
    [{ task_name: 'a b' }, 'agent-identity-task-name-invalid'], [{ evidence: 'host' }, 'agent-identity-evidence-invalid'],
    [{ evidence: 'native-lifecycle' }, 'agent-identity-evidence-invalid'],
    [{ lifecycle_identity_sha256: 'a'.repeat(64) }, 'agent-identity-evidence-invalid'], [{ ts: 'yesterday' }, 'agent-identity-ts-invalid'],
  ];
  for (const [patch, reason] of refusedFields) {
    assert.throws(() => api.buildAgentIdentityEvent({ ...attested, ...patch }, fixedNow), new RegExp(reason), JSON.stringify(patch));
  }
  const hostileDescription = '\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\ \u{202e}texto\nlongo ' + 'x'.repeat(300);
  const description = api.sanitizeDescription(hostileDescription);
  assert.match(description, /^link texto longo x+~$/);
  assert.equal(Array.from(description).length, 160);
  assert.equal(api.sanitizeDescription('\x1b]8;;https://example.invalid t'), null);
  assert.equal(api.buildAgentIdentityEvent({ ...base, description: hostileDescription }, fixedNow).description, description);
  console.log('PASS S03/T02 agent-identity validation: host, agent type, unit and dispatch through the safe vocabulary without coercion, evidence and ts closed, description one plainText line of up to 160');

  const { invokeNative, buildNativeInvocation, humanTaskName } = require('./forge-native-invocation');
  const { digest } = require('./forge-native-supervision');
  const route = { model: 'gpt-6-luna', model_requested: 'gpt-6-luna', model_resolved: 'gpt-6-luna', alias: null, effort: 'medium',
    dispatch_engine: 'codex', host_runtime: 'codex', resolved_worker_engine: 'codex', worker_mode: 'native',
    dispatch_allowed: true, config_ok: true };
  const request = { dispatchId: 'dispatch-s03-t02', unitType: 'execute-task', phase: 'execute' };
  const options = { hostRuntime: 'codex', resolvedDispatch: route, agentType: 'forge-executor', prompt: 'Fixture only.', forkTurns: 'none',
    activeCapabilities: { available: true, tool: 'spawn_agent', source: 'test-active-tool', models: ['gpt-6-luna'],
      reasoning_efforts: ['medium'], fork_turns: ['none'] },
    taskName: humanTaskName({ unitId: 'S03/T02', title: 'Identidade nativa', attempt: request.dispatchId }),
    telemetryIdentity: request, terminalResult: value => value?.status === 'done' };
  const run = await invokeNative(options, async (args, invocation, observer) => { observer.hostIdentity(HOST_VALUE); return { status: 'done' }; });
  assert.equal(run.ok, true, JSON.stringify(run));
  const invocation = buildNativeInvocation(options);
  const bound = api.identityFromLifecycle({ lifecycle: run.lifecycle, request, invocation });
  assert.deepEqual(bound, { ok: true, fields: { dispatch_id: 'dispatch-s03-t02', host_runtime: 'codex', agent_type: 'forge-executor',
    task_name: options.taskName, agent_id: HOST_VALUE, agent_id_source: 'host-tool-return', evidence: 'native-lifecycle',
    lifecycle_identity_sha256: digest(JSON.stringify({ invocation, identity: request })) } });
  assert.equal(bound.fields.lifecycle_identity_sha256, run.lifecycle.identity);
  const nativeEvent = api.buildAgentIdentityEvent({ unit: 'S03/T02', ...bound.fields }, fixedNow);
  assert.equal(nativeEvent.evidence, 'native-lifecycle');
  const host = run.lifecycle.host_identity;
  const quiet = await invokeNative(options, async () => ({ status: 'done' }));
  const noDispatchRequest = { unitType: 'execute-task' };
  const noDispatch = await invokeNative({ ...options, telemetryIdentity: noDispatchRequest },
    async (args, inv, observer) => { observer.hostIdentity(HOST_VALUE); return { status: 'done' }; });
  const forgedCases = [
    ['foreign request', { lifecycle: run.lifecycle, request: { ...request, dispatchId: 'dispatch-other' }, invocation }, 'agent-identity-binding'],
    ['forged lifecycle identity', { lifecycle: { ...run.lifecycle, identity: 'f'.repeat(64) }, request, invocation }, 'agent-identity-binding'],
    ['other invocation', { lifecycle: run.lifecycle, request, invocation: buildNativeInvocation({ ...options, taskName: 'other_name' }) }, 'agent-identity-binding'],
    ['host record for another dispatch', { lifecycle: { ...run.lifecycle, host_identity: { ...host, dispatch_id: 'dispatch-other' } }, request, invocation }, 'agent-identity-binding'],
    ['host record with another source', { lifecycle: { ...run.lifecycle, host_identity: { ...host, source: 'task-name' } }, request, invocation }, 'agent-identity-binding'],
    ['host record with extra key', { lifecycle: { ...run.lifecycle, host_identity: { ...host, extra: 1 } }, request, invocation }, 'agent-identity-binding'],
    ['conflicting host identity', { lifecycle: { ...run.lifecycle, host_identity: { ...host, conflict: true } }, request, invocation }, 'agent-identity-conflict'],
    ['host reported nothing', { lifecycle: quiet.lifecycle, request, invocation }, 'agent-identity-unobserved'],
    ['request without dispatch', { lifecycle: noDispatch.lifecycle, request: noDispatchRequest, invocation }, 'agent-identity-binding'],
    ['missing lifecycle', { request, invocation }, 'agent-identity-binding'],
  ];
  for (const [label, input, reason] of forgedCases) assert.deepEqual(api.identityFromLifecycle(input), { ok: false, reason_code: reason }, label);
  console.log('PASS S03/T02 identityFromLifecycle: exact invocation/request digest and dispatch binding from a real invokeNative lifecycle; forged, foreign, conflicting and unobserved refused without append');
  // Handoff examples generated in this temporary fixture (fixed clock, fake host return).
  console.log(`EXAMPLE S03/T02 human task name: ${options.taskName}`);
  console.log(`EXAMPLE S03/T02 caller-attested event: ${api.renderAgentIdentityEvent(event).trim()}`);
  console.log(`EXAMPLE S03/T02 native-lifecycle event: ${api.renderAgentIdentityEvent(nativeEvent).trim()}`);

  const capabilityLines = [];
  const viaCapability = await api.appendAgentIdentityEvent({ appendOwnerEvent: value => { capabilityLines.push(value); } },
    { unit: 'S03/T02', ...bound.fields }, { now: fixedNow });
  assert.deepEqual(viaCapability, { status: 'appended', line: api.renderAgentIdentityEvent(nativeEvent) });
  assert.deepEqual(capabilityLines, [viaCapability.line]);

  const reconciliation = require('./forge-artifact-reconciliation');
  const brokerOwner = owner(false);
  const broker = await reconciliation.startBroker({ owner: brokerOwner, manifestFile: path.join(root, `manifest-${++sequence}.json`),
    dispatchId: 'dispatch-s03-t02', request_sha256: 'request' });
  try {
    const appended = await api.appendAgentIdentityEvent({ broker }, attested, { now: fixedNow });
    assert.equal(appended.status, 'appended');
    assert.equal(fs.readFileSync(eventsOf(brokerOwner), 'utf8'), appended.line);
    assert(broker.verify().passed); assert.equal(broker.proofs().length, 1);
    assert.equal((await api.appendAgentIdentityEvent({ broker }, attested, { now: fixedNow })).status, 'already-recorded');
    await assert.rejects(api.appendAgentIdentityEvent({ broker }, { ...attested, agent_id: '/root/other' }), /agent-identity-conflict/);
    await assert.rejects(api.appendAgentIdentityEvent({ broker: JSON.parse(JSON.stringify(broker)) }, attested), /broker-caller-handle-required/);
    assert.equal(broker.proofs().length, 1); assert.equal(fs.readFileSync(eventsOf(brokerOwner), 'utf8'), appended.line);
  } finally { await broker.close(); }

  const lockedOwner = owner();
  const closed = receipt('ready');
  const locked = await api.appendAgentIdentityEvent({ owner: lockedOwner, closedReceiptFile: closed }, attested, { now: fixedNow });
  assert.equal(locked.status, 'appended');
  assert.equal(fs.readFileSync(eventsOf(lockedOwner), 'utf8'), locked.line);
  const lockedBytes = bytesOf(eventsOf(lockedOwner));
  assert.deepEqual(await api.appendAgentIdentityEvent({ owner: lockedOwner, closedReceiptFile: closed }, attested, { now: fixedNow }),
    { status: 'already-recorded', line: locked.line });
  await assert.rejects(api.appendAgentIdentityEvent({ owner: lockedOwner, closedReceiptFile: closed }, { ...attested, agent_id: '/root/other' }),
    /agent-identity-conflict/);
  assert(bytesOf(eventsOf(lockedOwner)).equals(lockedBytes), 'duplicate and conflict write nothing');
  const failedOwner = owner();
  assert.equal((await api.appendAgentIdentityEvent({ owner: failedOwner, closedReceiptFile: receipt('failed') }, attested)).status, 'appended');
  const refusedChannels = [
    ['open receipt', { owner: owner(), closedReceiptFile: receipt('started') }, /agent-identity-unit-open/],
    ['divergent receipt', { owner: owner(), closedReceiptFile: receipt('ready', 'dispatch-other') }, /agent-identity-unit-open/],
    ['missing receipt file', { owner: owner(), closedReceiptFile: path.join(root, 'absent-receipt.json') }, /agent-identity-receipt-invalid/],
    ['owner without receipt', { owner: owner() }, /agent-identity-receipt-required/],
    ['ambiguous channel', { owner: owner(), closedReceiptFile: closed, appendOwnerEvent: () => {} }, /agent-identity-channel-required/],
    ['no channel', {}, /agent-identity-channel-required/],
  ];
  for (const [label, channel, pattern] of refusedChannels) {
    await assert.rejects(api.appendAgentIdentityEvent(channel, attested), pattern, label);
    if (channel.owner) assert.equal(bytesOf(eventsOf(channel.owner)), null, `${label}: nothing written`);
  }
  const bareOwner = owner(false);
  await assert.rejects(api.appendAgentIdentityEvent({ owner: bareOwner, closedReceiptFile: closed }, attested), /agent-identity-events-dir-missing/);
  assert(!fs.existsSync(path.join(bareOwner, '.gsd')), '.gsd is never created');
  const largeOwner = owner();
  fs.writeFileSync(eventsOf(largeOwner), '');
  fs.truncateSync(eventsOf(largeOwner), 16 * 1024 * 1024 + 1);
  await assert.rejects(api.appendAgentIdentityEvent({ owner: largeOwner, closedReceiptFile: closed }, attested), /agent-identity-events-too-large/);
  assert.equal(fs.statSync(eventsOf(largeOwner)).size, 16 * 1024 * 1024 + 1);
  console.log('PASS S03/T02 append channels: live broker with signed proof, owner appendOwnerEvent capability, owner lock with closed receipt; open or divergent receipt, forged handle, missing .gsd/forge and oversized events refused without writing');
  console.log('PASS S03/T02 duplicate and conflict: same dispatch and agent_id is already-recorded, another agent_id is agent-identity-conflict, no bytes written');

  const byTitle = cli(['--task-name', '--unit', 'S03/T02', '--title', 'Identidade nativa', '--attempt', 'dispatch-1']);
  assert.equal(byTitle.status, 0, byTitle.stderr);
  assert.equal(byTitle.stdout, `s03_t02_identidade_nativa_${hex8('dispatch-1')}\n`);
  const frontmatterPlan = path.join(root, 'T02-PLAN.md');
  fs.writeFileSync(frontmatterPlan, "---\nid: T02\ntitle: 'Identidade nativa: o ''nome'' humano'\n---\n\n# Outro título\n");
  const byPlan = cli(['--task-name', '--unit', 'S03/T02', '--plan', frontmatterPlan, '--attempt', 'dispatch-1']);
  assert.equal(byPlan.status, 0, byPlan.stderr);
  assert.equal(byPlan.stdout, `s03_t02_identidade_nativa_o_nome_humano_${hex8('dispatch-1')}\n`);
  const headingPlan = path.join(root, 'heading-PLAN.md');
  fs.writeFileSync(headingPlan, '# T02: Plano de teste\n\nCorpo.\n');
  assert.equal(cli(['--task-name', '--unit', 'S03/T02', '--plan', headingPlan, '--attempt', 'a']).stdout,
    `s03_t02_t02_plano_de_teste_${hex8('a')}\n`);
  for (const args of [['--task-name', '--unit', 'S03/T02', '--title', 'X', '--plan', headingPlan, '--attempt', 'a'],
    ['--task-name', '--unit', 'S03/T02', '--title', 'X'], ['--task-name', '--unit', 'S03/T02', '--plan', path.join(root, 'absent.md'), '--attempt', 'a'],
    ['--task-name', '--unit', '', '--title', '😀', '--attempt', 'a'], ['--task-name']]) {
    const refusedName = cli(args);
    assert.equal(refusedName.status, 2, `${args.join(' ')}: ${refusedName.stderr}`);
    assert.equal(refusedName.stdout, '');
  }
  console.log('PASS S03/T02 CLI --task-name: human name from --title or plan frontmatter/heading by bounded read; usage errors exit 2');

  const printed = cli(recordArgs(['--task-name', 'experience_s02_t07_334497b58af1', '--description', 'Executor\n\x1b[31mda T02']));
  assert.equal(printed.status, 0, printed.stderr);
  const printedEvent = JSON.parse(printed.stdout);
  assert.equal(printedEvent.evidence, 'caller-attested'); assert.equal(printedEvent.agent_id, null);
  assert.equal(printedEvent.agent_id_source, null); assert.equal(printedEvent.description, 'Executor da T02');
  assert.equal(printed.stdout.split('\n').length, 2);
  const cliOwner = owner();
  const cliEvents = eventsOf(cliOwner);
  const withId = ['--agent-id', HOST_VALUE, '--agent-id-source', 'host-tool-return', '--ts', '2026-10-29T12:00:00.000Z'];
  const recorded = cli(recordArgs([...withId, '--events', cliEvents]));
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(fs.readFileSync(cliEvents, 'utf8'), recorded.stdout);
  assert.equal(JSON.parse(recorded.stdout).agent_id, HOST_VALUE);
  const recordedBytes = bytesOf(cliEvents);
  const again = cli(recordArgs([...withId, '--events', cliEvents]));
  assert.equal(again.status, 0); assert.match(again.stderr, /já registrada/);
  const conflict = cli(recordArgs(['--agent-id', '/root/other', '--agent-id-source', 'host-tool-return', '--events', cliEvents]));
  assert.equal(conflict.status, 3); assert.match(conflict.stderr, /agent-identity-conflict/);
  assert(bytesOf(cliEvents).equals(recordedBytes), 'duplicate and conflict write nothing');
  const openOwner = owner();
  const open = cli(recordArgs([...withId, '--events', eventsOf(openOwner), '--receipt', receipt('started', 'dispatch-cli')]));
  assert.equal(open.status, 3); assert.match(open.stderr, /agent-identity-unit-open/); assert.equal(bytesOf(eventsOf(openOwner)), null);
  const closedOwner = owner();
  const afterPublication = cli(recordArgs([...withId, '--events', eventsOf(closedOwner), '--receipt', receipt('ready', 'dispatch-cli')]));
  assert.equal(afterPublication.status, 0, afterPublication.stderr); assert.equal(fs.readFileSync(eventsOf(closedOwner), 'utf8'), afterPublication.stdout);
  const largeCli = owner();
  fs.writeFileSync(eventsOf(largeCli), ''); fs.truncateSync(eventsOf(largeCli), 16 * 1024 * 1024 + 1);
  const oversized = cli(recordArgs([...withId, '--events', eventsOf(largeCli)]));
  assert.equal(oversized.status, 3); assert.match(oversized.stderr, /agent-identity-events-too-large/);
  assert.equal(fs.statSync(eventsOf(largeCli)).size, 16 * 1024 * 1024 + 1);
  const bareCli = owner(false);
  const missingDir = cli(recordArgs([...withId, '--events', eventsOf(bareCli)]));
  assert.equal(missingDir.status, 2); assert(!fs.existsSync(path.join(bareCli, '.gsd')), 'the CLI never creates .gsd');
  const events = ['--events', cliEvents];
  const invalidRuns = [
    recordArgs(['--events', path.join(cliOwner, 'events.jsonl')]),
    recordArgs(['--agent-id', '/root/a b', '--agent-id-source', 'host-tool-return', ...events]),
    recordArgs(['--agent-id', HOST_VALUE, ...events]), recordArgs(['--agent-id', HOST_VALUE, '--agent-id-source', 'caller', ...events]),
    recordArgs(['--receipt', receipt('ready', 'dispatch-cli')]), recordArgs(['--unknown', 'x', ...events]),
    recordArgs(['--unit', 'again', ...events]), recordArgs([...events, '--description']),
    ['--record', '--unit', 'S03/T02', '--dispatch-id', 'dispatch-cli', '--host', 'codex', ...events],
    ['--record', '--unit', 'S03/T02', '--dispatch-id', 'dispatch-cli', '--host', 'gemini', '--agent-type', 'forge-executor', ...events],
    ['--record', '--unit', 'S03 T02', '--dispatch-id', 'dispatch-cli', '--host', 'codex', '--agent-type', 'forge-executor', ...events],
    ['--record', '--unit', 'S03/T02', '--dispatch-id', 'dispatch-cli', '--host', 'codex', '--agent-type', 'executor', ...events], [],
  ];
  for (const args of invalidRuns) {
    const invalid = cli(args);
    assert.equal(invalid.status, 2, `${args.join(' ')}: ${invalid.stderr}`);
    assert.equal(invalid.stdout, '');
  }
  assert(bytesOf(cliEvents).equals(recordedBytes), 'invalid usage or value writes nothing');
  console.log('PASS S03/T02 CLI --record: caller-attested line, append under the derived owner lock only in an existing .gsd/forge, already-recorded exit 0, conflict/open receipt/oversize exit 3, invalid usage or value exit 2, never creates .gsd');

  // Issue 297: canonical recovery dispatches exceed the generic 120 code limit.
  const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');
  const parent124 = 'M-20261028132636-fixture-S03-T02-native-dispatch-'.padEnd(78, 'x');
  const real124 = recoveryDispatchId(parent124, '0f8e2d9c-1b7a-4c3e-9d5f-6a2b1c0e7f48');
  const real128 = recoveryDispatchId('p'.repeat(128), '0f8e2d9c-1b7a-4c3e-9d5f-6a2b1c0e7f48');
  assert.equal(real124.length, 124); assert.equal(real128.length, 128);
  const sized = length => 'd'.repeat(length - 2) + '-1';
  for (const dispatchId of [sized(120), sized(121), real124, sized(124), real128, sized(128)]) {
    assert.equal(api.buildAgentIdentityEvent({ ...attested, dispatch_id: dispatchId }, fixedNow).dispatch_id, dispatchId);
    const record = { value: HOST_VALUE, source: 'host-tool-return', observed_ms: 1, dispatch_id: dispatchId, conflict: false };
    assert.deepEqual(api.normalizeHostIdentity(record), record);
  }
  for (const dispatchId of [sized(129), 'dispatch with space', `${real124}\n`, 'acentuação', 'bidi‮']) {
    assert.throws(() => api.buildAgentIdentityEvent({ ...attested, dispatch_id: dispatchId }, fixedNow), /agent-identity-dispatch-invalid/);
    assert.equal(api.normalizeHostIdentity({ value: HOST_VALUE, source: 'host-tool-return', observed_ms: 1, dispatch_id: dispatchId, conflict: false }), null);
  }
  assert.throws(() => api.buildAgentIdentityEvent({ ...attested, unit: sized(121) }, fixedNow), /agent-identity-unit-invalid/,
    'other fields keep the generic 120 limit');
  console.log('PASS issue297 identity: event dispatch_id and host_identity keep 120/121/124/128 exactly and refuse 129 or invalid characters; other fields stay at 120');
  const longRuns = {};
  for (const dispatchId of [real124, real128]) {
    const longRequest = { ...request, dispatchId };
    const longOptions = { ...options, telemetryIdentity: longRequest };
    const longRun = await invokeNative(longOptions, async (args, inv, observer) => { observer.hostIdentity(HOST_VALUE); return { status: 'done' }; });
    assert.equal(longRun.ok, true);
    assert.equal(longRun.lifecycle.host_identity.dispatch_id, dispatchId, 'journal binding is the exact dispatch');
    assert.equal(longRun.final_evidence.dispatch_id, dispatchId, 'final evidence keeps the exact dispatch');
    const longInvocation = buildNativeInvocation(longOptions);
    const longBound = api.identityFromLifecycle({ lifecycle: longRun.lifecycle, request: longRequest, invocation: longInvocation });
    assert.equal(longBound.ok, true, JSON.stringify(longBound));
    assert.equal(longBound.fields.dispatch_id, dispatchId);
    for (const [label, input] of [
      ['foreign dispatch', { lifecycle: longRun.lifecycle, request: { ...longRequest, dispatchId: real124 === dispatchId ? real128 : real124 }, invocation: longInvocation }],
      ['host record for a truncated dispatch', { lifecycle: { ...longRun.lifecycle, host_identity: { ...longRun.lifecycle.host_identity, dispatch_id: dispatchId.slice(0, 120) } }, request: longRequest, invocation: longInvocation }],
      ['forged digest', { lifecycle: { ...longRun.lifecycle, identity: 'e'.repeat(64) }, request: longRequest, invocation: longInvocation }],
    ]) assert.equal(api.identityFromLifecycle(input).ok, false, label);
    longRuns[dispatchId] = longBound;
  }
  const oversizedRequest = { ...request, dispatchId: sized(129) };
  const oversizedRun = await invokeNative({ ...options, telemetryIdentity: oversizedRequest },
    async (args, inv, observer) => { observer.hostIdentity(HOST_VALUE); return { status: 'done' }; });
  assert.equal(oversizedRun.lifecycle.host_identity.dispatch_id, null, 'an oversized dispatch binds nothing');
  assert.deepEqual(api.identityFromLifecycle({ lifecycle: oversizedRun.lifecycle, request: oversizedRequest,
    invocation: buildNativeInvocation({ ...options, telemetryIdentity: oversizedRequest }) }), { ok: false, reason_code: 'agent-identity-binding' });
  console.log('PASS issue297 identity: identityFromLifecycle binds 124/128 canonical recovery dispatches exactly through a real invokeNative lifecycle; foreign, truncated, forged and 129 refused');
  const longOwner = owner();
  const longReceipt = receipt('ready', real124);
  const longAppend = await api.appendAgentIdentityEvent({ owner: longOwner, closedReceiptFile: longReceipt },
    { unit: 'S03/T02', ...longRuns[real124].fields }, { now: fixedNow });
  assert.equal(longAppend.status, 'appended');
  assert.equal(JSON.parse(fs.readFileSync(eventsOf(longOwner), 'utf8')).dispatch_id, real124);
  const longBytes = bytesOf(eventsOf(longOwner));
  await assert.rejects(api.appendAgentIdentityEvent({ owner: longOwner, closedReceiptFile: receipt('ready', real128) },
    { unit: 'S03/T02', ...longRuns[real124].fields }), /agent-identity-unit-open/);
  await assert.rejects(api.appendAgentIdentityEvent({ owner: longOwner, closedReceiptFile: longReceipt },
    { unit: 'S03/T02', ...longRuns[real124].fields, agent_id: '/root/other' }), /agent-identity-conflict/);
  await assert.rejects(api.appendAgentIdentityEvent({ owner: longOwner, closedReceiptFile: receipt('started', real124) },
    { unit: 'S03/T02', ...longRuns[real124].fields }), /agent-identity-unit-open/);
  assert(bytesOf(eventsOf(longOwner)).equals(longBytes), 'incompatible receipt or conflict writes nothing');
  console.log('PASS issue297 identity: post-publication append with the exact closed 124 receipt records the full dispatch; foreign receipt, open receipt and conflicting agent refused without writing');

  const probe = spawnSync(process.execPath, ['-e', [
    "require('./forge-agent-identity');",
    "const loaded = Object.keys(require.cache).map(file => require('path').basename(file));",
    "const early = ['forge-native-supervision.js', 'forge-artifact-reconciliation.js', 'forge-native-invocation.js', 'forge-autonomy-sources.js'].filter(name => loaded.includes(name));",
    'process.stdout.write(JSON.stringify(early));',
  ].join('\n')], { cwd: __dirname, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), []);
  const supervisionOnly = spawnSync(process.execPath, ['-e',
    "require('./forge-native-supervision'); process.stdout.write(String(Object.keys(require.cache).some(f => f.endsWith('forge-agent-identity.js'))));"],
  { cwd: __dirname, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(supervisionOnly.stdout, 'false', 'supervision loads the identity module only inside the observer');
  console.log('PASS S03/T02 lazy requires: loading forge-agent-identity does not load supervision, reconciliation, invocation or bounded readers; supervision loads identity only when used');
}

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
  console.log('forge-agent-identity tests passed');
}, error => {
  console.error(error);
  process.exitCode = 1;
});
