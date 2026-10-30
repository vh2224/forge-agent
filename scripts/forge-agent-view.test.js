#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const view = require('./forge-agent-view');
const fixture = require('./fixtures/agent-view/records.json');
const liveness = require('./forge-sidecar-liveness');
const { buildAgentIdentityEvent } = require('./forge-agent-identity');
const { observation, diagnostic } = require('./forge-sidecar-diagnostic');
const { plainText } = require('./forge-sidecar-identity');
const scope = { type: 'milestone', id: 'M001' };
const check = (name, fn) => { fn(); console.log(`PASS S03/T03 ${name}`); };
const derive = (input, extra = {}) => view.deriveAgentView(input, { now: fixture.now, scope, ...extra });
const first = name => fixture.cases.find(row => row.name === name);
function fromCase(row, extra = {}) {
  return derive({ ...row, empty_reason: row.source_error }, extra);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

// Run first: this is the real 124-character recovery regression against the
// unchanged T03 reader as well as the adjacent canonical dispatch boundaries.
check('dispatch recovery 120 121 124 128 exact event receipt journal joins', () => {
  const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');
  const { code, dispatchCode } = require('./forge-attempt-telemetry');
  for (const length of [124, 120, 121, 128]) {
    const dispatch = recoveryDispatchId('d'.repeat(length - 46), '11111111-1111-4111-8111-111111111111');
    assert.strictEqual(dispatch.length, length);
    assert.strictEqual(dispatchCode(dispatch), dispatch);
    assert.strictEqual(code(dispatch), length <= 120 ? dispatch : null);
    const row = clone(first('native-with-id'));
    row.records.forEach(record => { record.dispatch_id = dispatch; });
    row.records.push({ event: 'sidecar-unit', dispatch_id: dispatch, status: 'started' });
    row.receipts = [{ dispatch_id: dispatch, phase: 'executed' }];
    row.journals = clone(first('native-journal-live').journals);
    row.journals[0].host_identity.dispatch_id = dispatch;
    row.journals[0].host_identity.value = row.records[1].agent_id;
    const before = JSON.stringify(row), result = fromCase(row);
    assert.strictEqual(result.agents.length, 1, 'same dispatch must join without unit inference');
    const agent = result.agents[0];
    assert.strictEqual(agent.dispatch_id, dispatch, `dispatch${length} exact bytes`);
    assert.strictEqual(agent.technical.dispatch_id, dispatch);
    assert.strictEqual(agent.identity.value, row.records[1].agent_id);
    assert.strictEqual(agent.identity.provenance, 'native-lifecycle');
    assert.strictEqual(agent.phase, 'verifying', 'receipt joined');
    row.records.splice(1, 1);
    assert.strictEqual(fromCase(row).agents[0].identity.provenance, 'journal-unpublished', 'journal joined');
    row.records[0].unit = 'u'.repeat(121);
    assert.strictEqual(fromCase(row).agents[0].unit, 'unknown', 'generic code remains bounded');
    row.records[0].unit = 'execute-task/T03';
    row.records.splice(1, 0, JSON.parse(before).records[1]);
    assert.strictEqual(JSON.stringify(row), before, 'derivation has no mutation');
    row.journals[0].host_identity.value = '/root/conflicting-agent';
    assert.strictEqual(fromCase(row).agents[0].identity.reason, 'host-id-conflict');
    row.records[1].dispatch_id = `${dispatch.slice(0, -1)}2`;
    row.journals[0].host_identity.dispatch_id = `${dispatch.slice(0, -1)}3`;
    assert.strictEqual(fromCase(row).agents[0].identity.value, 'unknown', 'foreign exact ID cannot join');
    row.records[1].dispatch_id = dispatch;
    row.records[1].agent_id = 'invalid agent id';
    assert.strictEqual(fromCase(row).agents[0].identity.value, 'unknown');
  }
  for (const dispatch of ['d'.repeat(129), 'dispatch\n', 'dispatch\u202e', 'dispatch with spaces']) {
    const row = clone(first('native-with-id'));
    row.records.forEach(record => { record.dispatch_id = dispatch; });
    const before = JSON.stringify(row), result = fromCase(row);
    assert.strictEqual(result.agents[0].dispatch_id, 'unknown');
    assert.strictEqual(result.agents[0].identity.value, 'unknown');
    assert.strictEqual(JSON.stringify(row), before);
  }
});
function assertExpected(result, expected) {
  if ('count' in expected) assert.strictEqual(result.agents.length, expected.count);
  if ('empty_reason' in expected) assert.strictEqual(result.empty_reason, expected.empty_reason);
  if (!result.agents.length) return;
  const agent = result.agents[0];
  const values = { kind: agent.kind, phase: agent.phase, remote: agent.activity.remote, outcome: agent.outcome,
    identity: agent.identity.value, identity_reason: agent.identity.reason, provenance: agent.identity.provenance,
    observed: agent.model.observed, requested: agent.model.requested, divergent: agent.model.divergent,
    freshness: agent.freshness, terminal: agent.activity.terminal, questions: agent.questions };
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'local') assert(agent.activity.local.includes(value));
    else if (!['count', 'empty_reason'].includes(key)) assert.deepStrictEqual(values[key], value, key);
  }
}

for (const row of fixture.cases) check(`fixture ${row.name}`, () => {
  assert(fixture.synthetic);
  assert(Array.isArray(row.records) && Array.isArray(row.receipts) && Array.isArray(row.journals));
  assert(Object.keys(row.expect).length);
  assertExpected(fromCase(row), row.expect);
});

check('pure schema and metadata', () => {
  const row = clone(first('recent')), before = JSON.stringify(row);
  const a = fromCase(row, { titles: { 'execute-task/T03': 'Título do plano canônico' } });
  const b = fromCase(row, { titles: { 'execute-task/T03': 'Título do plano canônico' } });
  assert.deepStrictEqual(a, b); assert.strictEqual(JSON.stringify(row), before);
  assert.deepStrictEqual(Object.keys(a), ['schema_version', 'scope', 'sources', 'agents', 'empty_reason']);
  assert.strictEqual(a.schema_version, 1); assert.strictEqual(a.empty_reason, null);
  for (const key of ['unit', 'milestone', 'slice', 'workflow_id', 'dispatch_id', 'host_runtime', 'engine', 'transport', 'task']) assert(a.agents[0][key]);
  assert.strictEqual(a.agents[0].task, 'Título do plano canônico');
  assert.strictEqual(fromCase(first('native-with-id')).agents[0].task, 'Implementar a visão de agentes');
  assert.strictEqual(fromCase(first('recent')).agents[0].task, 'execute-task/T03');
  const modulePath = require.resolve('./forge-agent-view');
  const loaded = spawnSync(process.execPath, ['-e', `const fs=require('fs');const read=fs.readFileSync;fs.readFileSync=function(p,...a){if(typeof p!=='string'||!p.endsWith('.js'))throw Error('unexpected input read');return read.call(this,p,...a)};for(const k of ['readdirSync','statSync','lstatSync','openSync','writeFileSync'])fs[k]=()=>{throw Error('unexpected IO')};require(${JSON.stringify(modulePath)})`], { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(loaded.status, 0, loaded.stderr);
  for (const name of ['deriveAgentView', 'readAgentSources', 'renderAgentView', 'formatPhaseLine', 'formatActivityLine']) assert.strictEqual(typeof view[name], 'function');
});

check('kind from transport and mode only; strict dispatch joins', () => {
  const row = clone(first('recent'));
  for (const engine of ['codex', 'claude', 'agy']) {
    row.records[0].engine = engine; row.records[0].host_runtime = 'claude';
    assert.strictEqual(fromCase(row).agents[0].kind, 'sidecar');
  }
  row.records[0].transport = 'native-tool'; assert.strictEqual(fromCase(row).agents[0].kind, 'unknown');
  delete row.records[0].transport; delete row.records[0].worker_mode;
  assert.strictEqual(fromCase(row).agents[0].kind, 'unknown');
  const unjoined = clone(first('native-entry-dispatch'));
  unjoined.records = [unjoined.records[0], { ...unjoined.records[0], dispatch_id: null }, { ...unjoined.records[0], dispatch_id: null }];
  assert.strictEqual(fromCase(unjoined).agents.length, 3);
  const grouped = clone(first('recent'));
  delete grouped.records[0].workflow_id;
  grouped.records.push({ event: 'sidecar-unit', dispatch_id: 'dispatch-1', workflow_id: 'M001', status: 'started' });
  assert.strictEqual(fromCase(grouped, { scope: { type: 'workflow', id: 'M001' } }).agents[0].transport, 'claude-cli');
  grouped.records.push({ ...grouped.records[0], milestone: 'M002', workflow_id: 'M002', transport: 'app-server' });
  assert.strictEqual(fromCase(grouped).agents[0].transport, 'claude-cli');
});

check('models and effort preserve source axes', () => {
  const row = clone(first('recent'));
  row.receipts[0].telemetry.model_observed = 'gpt-6.1-sol';
  assert.strictEqual(fromCase(row).agents[0].model.observed, 'unknown');
  row.receipts[0].telemetry.model_observed_source = 'host-readback';
  let agent = fromCase(row).agents[0];
  assert.strictEqual(agent.model.observed, 'gpt-6.1-sol'); assert(agent.model.divergent);
  assert.strictEqual(agent.model.resolved, 'claude-sonnet-5');
  assert.deepStrictEqual(agent.effort, { requested: 'high', resolved: 'high', sent: 'high', applied: 'unknown' });
  row.receipts[0].telemetry.effort_applied = 'medium'; assert.strictEqual(fromCase(row).agents[0].effort.applied, 'medium');
  row.receipts[0].telemetry.effort_applied = null; assert.strictEqual(fromCase(row).agents[0].effort.applied, 'unknown');
  row.receipts[0].telemetry.model_observed = 'C:\\secret';
  assert.strictEqual(fromCase(row).agents[0].model.observed, 'unknown');
  delete row.receipts[0].telemetry.model_observed; delete row.receipts[0].telemetry.model_observed_source;
  row.receipts[0].telemetry.observation.model_observed = 'claude-opus-5';
  assert.strictEqual(fromCase(row).agents[0].model.observed, 'unknown');
  row.receipts[0].telemetry.observation.model_source = 'claude-json-modelUsage';
  assert.strictEqual(fromCase(row).agents[0].model.observed, 'claude-opus-5');
});

check('native identity provenance conflicts and orphan exclusion', () => {
  const row = clone(first('native-with-id'));
  row.records[1].agent_id_source = 'task-name'; assert.strictEqual(fromCase(row).agents[0].identity.value, 'unknown');
  row.records[1].agent_id_source = 'host-tool-return'; row.records[1].dispatch_id = 'another-dispatch';
  assert.strictEqual(fromCase(row).agents[0].identity.value, 'unknown');
  row.records[1].dispatch_id = 'dispatch-1'; row.journals = clone(first('native-journal-live').journals);
  assert.strictEqual(fromCase(row).agents[0].identity.reason, 'host-id-conflict');
  row.records = [row.records[0]]; row.journals[0].host_identity.conflict = true;
  assert.strictEqual(fromCase(row).agents[0].identity.reason, 'host-id-conflict');
  row.journals[0].host_identity.dispatch_id = 'orphan'; assert.strictEqual(fromCase(row).agents[0].identity.reason, 'host-id-not-recorded');
  const sidecar = clone(first('recent')); sidecar.records.push(clone(first('native-with-id').records[1]));
  sidecar.receipts[0].claude_session_id = '/root/not-native';
  assert.strictEqual(fromCase(sidecar).agents[0].native_thread, false);
  assert.strictEqual(fromCase(sidecar).agents[0].identity.value, 'unknown');
  const native = fromCase(first('native-with-id')).agents[0];
  assert.strictEqual(native.task_name, 'read_agent_view'); assert.notStrictEqual(native.identity.value, native.task_name);
  const invalid = clone(first('native-with-id')); delete invalid.records[1].ts;
  const clock = Date.now;
  Date.now = () => { throw new Error('derivation read the wall clock'); };
  try { assert.strictEqual(fromCase(invalid).agents[0].identity.value, 'unknown'); }
  finally { Date.now = clock; }
  invalid.records[1].ts = '2026-10-29T12:00:00Z'; invalid.records[1].extra = true;
  assert.strictEqual(fromCase(invalid).agents[0].identity.value, 'unknown');
});

check('phase state machine and receipt-backed question IDs', () => {
  for (const [receiptPhase, expected] of [['started', 'executing'], ['executed', 'verifying'], ['ready', 'publishing']]) {
    const row = clone(first('recent')); row.receipts[0].phase = receiptPhase;
    assert.strictEqual(fromCase(row).agents[0].phase, expected);
  }
  for (const status of ['failed', 'blocked']) {
    const row = clone(first('failure')); row.records[1].status = status; row.records[1].diagnostic.reason = 'C:\\private stderr';
    const agent = fromCase(row).agents[0]; assert.strictEqual(agent.phase, 'failed'); assert.strictEqual(agent.reason, diagnostic('C:\\private stderr').reason);
  }
  const phases = ['preparing','planning','executing','verifying','publishing','reviewing','waiting','completed','failed','unknown'];
  assert.deepStrictEqual(Object.keys(view.PHASES), phases);
  const contract = fs.readFileSync(path.join(__dirname, '../shared/forge-communication.md'), 'utf8');
  for (const phase of phases.filter(p => p !== 'unknown')) assert(contract.includes(view.PHASES[phase]));
});

check('remote freshness age clocks and canonical thresholds', () => {
  const row = clone(first('recent'));
  const obs = row.receipts[0].telemetry.observation;
  let agent = fromCase(row).agents[0];
  assert.strictEqual(agent.activity.observed_at, '2026-10-29T12:00:09.000Z');
  assert.strictEqual(agent.activity.observation_age_ms, 1000);
  assert.strictEqual(agent.activity.remote_silence_ms, 1100);
  assert.strictEqual(agent.activity.threshold_ms, liveness.DEFAULTS.suspectMs);
  assert.strictEqual(agent.activity.observed_at_source, 'derived:receipt.started_at+observation.elapsed_ms');
  assert.strictEqual(fromCase(row, { now: fixture.now + liveness.DEFAULTS.suspectMs }).agents[0].activity.remote, 'delayed');
  obs.liveness.reason = 'untrusted'; assert.strictEqual(fromCase(row).agents[0].activity.remote, 'unknown');
  obs.liveness.reason = null; delete obs.gap_suspended;
  assert.strictEqual(fromCase(row).agents[0].activity.remote, 'unknown');
  for (const reason of ['local-proof', 'tool-extended', 'tool-unproven']) {
    obs.gap_suspended = true; obs.liveness.reason = reason;
    assert.strictEqual(fromCase(row).agents[0].activity.remote, 'tool-running');
  }
  obs.gap_suspended = false; obs.liveness = { version: 1, state: 'working', reason: 'local-proof' };
  assert.strictEqual(fromCase(row).agents[0].activity.remote, 'unknown');
  obs.liveness = { version: 1, state: 'slow-suspect', reason: 'silence' };
  assert.strictEqual(fromCase(row).agents[0].activity.remote, 'delayed');
  obs.liveness.state = 'dead'; assert.strictEqual(fromCase(row).agents[0].activity.remote, 'dead');
  obs.liveness.state = 'working'; obs.liveness.reason = null; delete obs.remote_silence_ms;
  assert.strictEqual(fromCase(row).agents[0].activity.remote, 'unknown');
  obs.remote_silence_ms = 0; obs.remote_source = null;
  assert.strictEqual(fromCase(row).agents[0].activity.remote, 'unknown');
  delete obs.remote_source;
  assert.strictEqual(fromCase(row).agents[0].activity.remote, 'unknown');
  for (const started_at of ['bad-date', '2026-10-30T00:00:00Z']) {
    row.receipts[0].started_at = started_at; agent = fromCase(row).agents[0];
    assert.strictEqual(agent.activity.reason, 'clock-inconsistent'); assert.strictEqual(agent.activity.remote, 'unknown');
  }
  row.receipts[0].started_at = '2026-10-29T12:00:00Z'; obs.elapsed_ms = -1;
  assert.strictEqual(fromCase(row).agents[0].activity.reason, 'clock-inconsistent');
  const journalRow = clone(first('native-journal-live')), journal = journalRow.journals[0];
  journal.capabilities.remote_events = 'available'; journal.policy = { ...liveness.DEFAULTS, suspectMs: 10000 };
  journal.activity = 'working'; journal.first_remote_ms = 1000; journal.last_remote_ms = 9000;
  agent = fromCase(journalRow).agents[0];
  assert.strictEqual(agent.activity.remote, 'recent'); assert.strictEqual(agent.activity.threshold_source, 'journal-policy');
  assert.strictEqual(agent.activity.observation_age_ms, 500);
  assert.strictEqual(fromCase(journalRow, { now: fixture.now + 11000 }).agents[0].activity.remote, 'delayed');
  journal.capabilities.open_tools = 'available'; journal.open_tools = true;
  assert.strictEqual(fromCase(journalRow).agents[0].activity.remote, 'tool-running');
  journal.capabilities.remote_events = 'unknown'; assert.strictEqual(fromCase(journalRow).agents[0].activity.remote, 'unknown');
  journal.last_wall_ms = Number.MAX_SAFE_INTEGER;
  assert.strictEqual(fromCase(journalRow).agents[0].activity.reason, 'clock-inconsistent');
});

check('local activity terminal and stale are independent', () => {
  const heartbeat = fromCase(first('heartbeat-only')).agents[0];
  assert(heartbeat.activity.local.includes('heartbeat')); assert.strictEqual(heartbeat.activity.remote, 'absent');
  assert(fromCase(first('native-journal-live')).agents[0].activity.local.includes('journal-tick'));
  const a = view.renderAgentView(fromCase(first('terminal-unvalidated')));
  const b = view.renderAgentView(fromCase(first('terminal-rejected-after-exit')));
  assert(a.includes('processo sem encerramento confirmado e resultado não validado'));
  assert(b.includes('resultado rejeitado ou falha depois do encerramento'));
  const stale = fromCase(first('stale')).agents[0];
  assert.strictEqual(stale.freshness_ceiling_ms, liveness.TIER_CEILING_MS.max);
  assert.strictEqual(stale.freshness_ceiling_source, 'fallback:TIER_CEILING_MS.max');
  for (const tier of Object.keys(liveness.TIER_CEILING_MS)) {
    const row = clone(first('native-entry-dispatch')); row.records[0].tier = tier;
    assert.strictEqual(fromCase(row, { now: fixture.now + liveness.ceilingForTier(tier) + 1 }).agents[0].freshness, 'stale');
  }
  const completed = clone(first('completion'));
  assert.strictEqual(fromCase(completed, { now: fixture.now + 100000000 }).agents[0].phase, 'completed');
});

check('conditional navigation and bounded plain human lines', () => {
  assert(view.NAVIGATION.every(row => row.status === 'conditional'));
  assert.deepStrictEqual(view.NAVIGATION.filter(row => row.command).map(row => row.command), ['/subagents']);
  for (const row of fixture.cases) {
    for (const line of view.renderAgentView(fromCase(row)).split('\n')) {
      assert(line.startsWith('[forge-agente]')); assert(Buffer.byteLength(line) <= 1024);
      assert(!line.includes('SECRET') && !line.includes('C:\\') && !line.includes('http') && !line.includes('a'.repeat(64)));
      assert(!line.includes('unknown'));
      assert.strictEqual(line, plainText(line, { limit: 250 }));
    }
  }
  const live = view.formatActivityLine(observation(first('recent').receipts[0].telemetry.observation));
  assert(live.includes('atividade remota recente')); assert(live.includes('idade da observação 0 ms'));
  const hostile = '\u001b]8;;https://bad\u0007\u202eC:\\secret\u2028arg=SECRET';
  const line = view.formatPhaseLine(hostile, { reason_code: hostile, cwd: hostile });
  assert(!line.includes('SECRET')); assert(line.includes(diagnostic(hostile).reason));
  assert.strictEqual(view.formatPhaseLine('executing'), '[forge-agente] · executando agente');
});

check('role catalog exactly matches agents and has safe TOML descriptions', () => {
  const names = fs.readdirSync(path.join(__dirname, '../agents')).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort();
  assert.deepStrictEqual(Object.keys(view.AGENT_ROLES).sort(), names);
  for (const role of Object.values(view.AGENT_ROLES)) {
    assert(role.label); assert(role.description.length <= 120);
    assert(!/["'\n\r]|gpt|claude|sonnet|opus|effort|somente leitura|isolamento/i.test(role.description));
    assert.strictEqual(role.description, plainText(role.description, { limit: 120 }));
  }
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-view-'));
const owner = path.join(temp, 'owner'), outside = path.join(temp, 'external'), home = path.join(temp, 'alice');
const cli = path.join(__dirname, 'forge-agent-view.js');
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['HOME', 'USERPROFILE', 'FORGE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())));
const env = { ...inheritedEnv, HOME: home, USERPROFILE: home, FORGE_HOME: path.join(temp, 'forge-home'), CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
function write(relative, value) {
  const target = path.join(owner, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value); return target;
}
function json(relative, value) { return write(relative, JSON.stringify(value)); }
function tree(dir) {
  const output = {};
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    output[name] = stat.isSymbolicLink() ? { link: true, mtime: stat.mtimeMs } : stat.isDirectory() ? tree(file)
      : { bytes: fs.readFileSync(file).toString('base64'), mtime: stat.mtimeMs };
  }
  return output;
}
function run(args) {
  const result = spawnSync(process.execPath, [cli, '--cwd', owner, ...args], { env, cwd: owner, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(result.error, undefined, result.error?.message); assert.strictEqual(result.signal, null);
  return result;
}
try {
  fs.mkdirSync(outside, { recursive: true }); fs.mkdirSync(home); fs.mkdirSync(owner); fs.mkdirSync(path.join(owner, '.svn'));
  const recent = clone(first('recent')), native = clone(first('native-with-id'));
  native.records = native.records.map(row => ({ ...row, dispatch_id: 'dispatch-native' }));
  const events = write('.gsd/forge/events.jsonl', [...recent.records, ...native.records,
    { ...recent.records[0], milestone: 'M002', workflow_id: 'M002', dispatch_id: 'foreign' }].map(row => JSON.stringify(row)).join('\n') + '\n');
  const receipt = json('evidence/receipt.json', recent.receipts[0]);
  const journalData = clone(first('native-journal-live').journals[0]); journalData.host_identity.dispatch_id = 'dispatch-native';
  journalData.host_identity.value = '/root/opaque-agent';
  const journal = path.join(outside, 'journal.json'); fs.writeFileSync(journal, JSON.stringify(journalData));
  write('.gsd/milestones/M001/slices/S03/tasks/T03/T03-PLAN.md', '---\ntitle: Título real do plano\n---\n# Outro título\n');
  check('bounded source reader recovery dispatch joins provenance and foreign rejection unchanged', () => {
    const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');
    const saved = fs.readFileSync(events);
    try {
      for (const length of [120, 121, 124, 128]) {
        const dispatch = recoveryDispatchId('d'.repeat(length - 46), '11111111-1111-4111-8111-111111111111');
        const row = clone(first('native-with-id'));
        row.records.forEach(record => { record.dispatch_id = dispatch; });
        row.records.push({ event: 'sidecar-unit', dispatch_id: dispatch, status: 'started' });
        row.records.push({ ...row.records[0], milestone: 'M002', workflow_id: 'M002', model: 'foreign-model' });
        fs.writeFileSync(events, row.records.map(record => JSON.stringify(record)).join('\n') + '\n');
        const exactReceipt = json(`evidence/long-${length}.json`, { dispatch_id: dispatch, phase: 'executed' });
        const live = clone(journalData); live.host_identity.dispatch_id = dispatch; live.host_identity.value = row.records[1].agent_id;
        const exactJournal = path.join(outside, `long-${length}.json`); fs.writeFileSync(exactJournal, JSON.stringify(live));
        const rejected = ['d'.repeat(129), dispatch + '\n', 'invalid dispatch', dispatch.slice(0, -1) + '2'].map((bad, index) =>
          json(`evidence/bad-${length}-${index}.json`, { dispatch_id: bad, phase: 'ready' }));
        const foreignJournal = json(`evidence/foreign-journal-${length}.json`, { ...live,
          host_identity: { ...live.host_identity, dispatch_id: dispatch.slice(0, -1) + '3' } });
        const before = tree(temp);
        const bundle = view.readAgentSources({ cwd: owner, filter: scope, receipts: [exactReceipt, ...rejected], journals: [exactJournal, foreignJournal] });
        assert.strictEqual(bundle.receipts.length, 1); assert.strictEqual(bundle.journals.length, 1);
        assert.strictEqual(bundle.records.length, 3); assert.strictEqual(bundle.sources.events.census.total, 4);
        const agent = view.deriveAgentView(bundle, { now: fixture.now }).agents[0];
        assert.strictEqual(agent.dispatch_id, dispatch); assert.strictEqual(agent.technical.receipt, `evidence/long-${length}.json`);
        assert.strictEqual(agent.identity.provenance, 'native-lifecycle'); assert.strictEqual(agent.phase, 'verifying');
        assert(bundle.sources.journals[0].reference.startsWith('sha256:'));
        assert.deepStrictEqual(tree(temp), before);
      }
    } finally { fs.writeFileSync(events, saved); }
  });
  check('bounded reader sources titles census and byte-for-byte no writes', () => {
    const before = tree(temp);
    const bundle = view.readAgentSources({ cwd: owner, filter: scope, receipts: [receipt], journals: [journal] });
    const result = view.deriveAgentView(bundle, { now: fixture.now });
    assert.strictEqual(result.agents.length, 2); assert.strictEqual(result.agents[0].task, 'Título real do plano');
    assert.strictEqual(bundle.sources.events.reference, '.gsd/forge/events.jsonl'); assert.strictEqual(bundle.sources.events.census.total, 4);
    assert.strictEqual(bundle.sources.receipts[0].reference, 'evidence/receipt.json');
    assert(bundle.sources.journals[0].reference.startsWith('sha256:'));
    assert(!JSON.stringify(bundle.sources).includes(owner) && !JSON.stringify(bundle.sources).includes(outside));
    assert.strictEqual(result.agents[1].identity.provenance, 'native-lifecycle');
    assert.deepStrictEqual(tree(temp), before);
    const limited = view.readAgentSources({ cwd: owner, filter: scope, maxLines: 2 });
    assert.strictEqual(limited.sources.events.census.truncated_tail, true);
    const tooLarge = view.readAgentSources({ cwd: owner, filter: scope, maxEventBytes: 16 });
    assert.strictEqual(tooLarge.sources.events.census.reason, 'events-too-large');
    assert.strictEqual(view.deriveAgentView(tooLarge, { now: fixture.now }).agents.length, 0);
    const read = fs.readSync; let calls = 0;
    fs.readSync = function(fd, ...args) { calls++; return read.call(this, fd, ...args); };
    try { view.readAgentSources({ cwd: owner, filter: scope }); } finally { fs.readSync = read; }
    // Each successful fixed read includes an EOF read, plus the one plan read.
    assert(calls >= 2 && calls <= 4, `unexpected reads: ${calls}`);
  });
  check('reader rejects foreign malformed oversized linked and excessive sources', () => {
    const foreignReceipt = json('evidence/foreign.json', { ...recent.receipts[0], dispatch_id: 'foreign' });
    const badJournal = json('evidence/bad-journal.json', { ...journalData, schema_version: 2 });
    const largeReceipt = write('evidence/large-receipt.json', ' '.repeat(1024 * 1024 + 1));
    const largeJournal = write('evidence/large-journal.json', ' '.repeat(32769));
    const malformed = write('evidence/malformed.json', '{');
    const before = tree(temp);
    const bundle = view.readAgentSources({ cwd: owner, filter: scope,
      receipts: [foreignReceipt, largeReceipt, malformed, path.dirname(receipt)], journals: [badJournal, largeJournal] });
    assert.deepStrictEqual(bundle.receipts, []); assert.deepStrictEqual(bundle.journals, []);
    assert(bundle.sources.receipts.some(row => row.reason === 'source_too_large'));
    assert(bundle.sources.journals.some(row => row.reason === 'source_too_large'));
    assert.deepStrictEqual(tree(temp), before);
    const many = view.readAgentSources({ cwd: owner, filter: scope, receipts: Array(33).fill(receipt), journals: Array(33).fill(journal) });
    assert.strictEqual(many.receipts.length, 32); assert.strictEqual(many.journals.length, 32);
    assert.strictEqual(many.sources.receipts.at(-1).reason, 'source_count_limit');
    // symlinks may require Windows privileges. Junctions work without them.
    const link = path.join(owner, 'linked'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = view.readAgentSources({ cwd: owner, filter: scope, journals: [path.join(link, 'journal.json')] });
    assert.strictEqual(linked.journals.length, 0); assert.strictEqual(linked.sources.journals[0].reason, 'source_link');
    const planDir = path.join(owner, '.gsd/milestones/M001/slices/S03/tasks/T03');
    fs.renameSync(planDir, path.join(outside, 'plan'));
    fs.symlinkSync(path.join(outside, 'plan'), planDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepStrictEqual(view.readAgentSources({ cwd: owner, filter: scope }).titles, {});
    fs.unlinkSync(planDir); fs.renameSync(path.join(outside, 'plan'), planDir);
    // Tampered event IDs cannot turn a plan title into an arbitrary read.
    const saved = fs.readFileSync(events); fs.writeFileSync(events, JSON.stringify({ ...recent.records[0], unit: 'execute-task/../../escape', milestone: '../outside', slice: '../outside' }));
    assert.deepStrictEqual(view.readAgentSources({ cwd: owner, filter: { type: 'workflow', id: 'M001' } }).titles, {});
    fs.writeFileSync(events, saved);
  });
  check('CLI explicit scope repeated references limits and deterministic JSON', () => {
    const before = tree(temp);
    assert.strictEqual(run([]).status, 2);
    const args = ['--milestone', 'M001', '--json', '--receipt', receipt, '--receipt', receipt,
      '--journal', journal, '--journal', journal, '--max-lines', '20000', '--max-event-bytes', String(16 * 1024 * 1024), '--now', '2026-10-29T12:00:10Z'];
    const a = run(args), b = run(args); assert.strictEqual(a.status, 0, a.stderr); assert.strictEqual(a.stdout, b.stdout);
    assert.strictEqual(JSON.parse(a.stdout).agents.length, 2);
    const human = run(['--unit', 'execute-task/T03']); assert.strictEqual(human.status, 0); assert(human.stdout.startsWith('[forge-agente]'));
    assert.strictEqual(run(['--workflow', 'M001', '--json']).status, 0);
    assert.strictEqual(run(['--milestone', 'M001', '--max-lines', 'invalid']).status, 2);
    assert.strictEqual(run(['--milestone', 'M001', '--now', 'invalid']).status, 2);
    assert.strictEqual(run(['--personal', '--unit', 'execute-task/T03']).status, 2);
    assert.deepStrictEqual(tree(temp), before);
  });
  check('personal snapshot excludes other work and orphan identities without mutation', () => {
    const personal = require('./forge-personal-context');
    const opts = { cwd: owner, project: owner, userHome: home, env };
    const homeProbe = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(__dirname, 'forge-home'))}).resolveUserHome())`], { env, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(homeProbe.status, 0); assert.strictEqual(homeProbe.stdout, home);
    let a = run(['--personal', '--json']); assert.strictEqual(a.status, 0, a.stderr);
    assert.deepStrictEqual(JSON.parse(a.stdout).agents, []); assert.strictEqual(JSON.parse(a.stdout).empty_reason, 'no-bindings');
    write('.gsd/milestones/M001/M001-STATE.md', '---\nmilestone: M001\nkind: milestone\n---\n**Phase:** idle\n');
    write('.gsd/forge/runs/M001.json', JSON.stringify({ id: 'M001', kind: 'milestone', project: owner, cwd: owner, active: false }));
    assert.strictEqual(personal.bindWork({ ...opts, id: 'M001', intent: 'create' }).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot({ cwd: owner, userHome: home, env }).works.length, 1, 'ambient owner resolution');
    const snapshotProbe = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, 'forge-personal-context'))}).readPersonalSnapshot({cwd:${JSON.stringify(owner)}})))`], { env, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(snapshotProbe.status, 0); assert.strictEqual(JSON.parse(snapshotProbe.stdout).works.length, 1, snapshotProbe.stdout);
    const viewProbe = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(cli)}).readAgentSources({cwd:${JSON.stringify(owner)},filter:{type:'personal'}})))`], { cwd: owner, env, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(viewProbe.status, 0); assert.strictEqual(JSON.parse(viewProbe.stdout).scope.works.length, 1, viewProbe.stdout);
    const before = tree(temp);
    const bundle = view.readAgentSources({ ...opts, filter: { type: 'personal' }, receipts: [receipt], journals: [journal] });
    assert.deepStrictEqual(bundle.scope, { type: 'personal', works: ['M001'] });
    const result = view.deriveAgentView(bundle, { now: fixture.now });
    assert.strictEqual(result.agents.length, 2); assert(result.agents.every(agent => agent.dispatch_id !== 'foreign'));
    a = run(['--personal', '--json']); assert.strictEqual(a.status, 0, a.stderr); assert.strictEqual(JSON.parse(a.stdout).agents.length, 2, a.stdout);
    assert.deepStrictEqual(tree(temp), before);
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

assert.deepStrictEqual(fixture.cases.map(row => row.name).sort(), ['recent', 'delayed', 'absent', 'heartbeat-only', 'tool-running', 'failure', 'completion', 'observed-absent', 'observed-divergent', 'native-with-id', 'native-journal-live', 'native-caller-attested', 'native-without-id', 'host-id-conflict', 'identity-without-dispatch', 'native-entry-dispatch', 'native-post-return-dispatch', 'stale', 'terminal-unvalidated', 'terminal-rejected-after-exit', 'waiting-decision', 'waiting-without-receipt', 'other-workflow', 'events-too-large', 'hostile-values'].sort());
console.log('PASS S03/T03 fixture inventory: all 25 named states exercised');
