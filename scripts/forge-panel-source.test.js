#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const personal = require('./forge-personal-context');
const agents = require('./forge-agent-view');
const pending = require('./forge-pending-questions');
const { sha256, canonical } = require('./forge-delivery');
const fixture = require('./fixtures/agent-view/records.json');
const panel = require('./forge-panel-source');
const cli = path.join(__dirname, 'forge-panel-source.js');
const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-panel-source-'));
const now = fixture.now;
const check = (name, fn) => { fn(); console.log(`PASS S05/T01 ${name}`); };
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
}
function root(name) {
  const cwd = path.join(temp, name), userHome = path.join(temp, `${name}-home`);
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true }); fs.mkdirSync(userHome);
  return { cwd, project: cwd, userHome, env: { ...process.env, HOME: userHome, USERPROFILE: userHome, FORGE_HOME: path.join(userHome, '.forge-agent') } };
}
function bind(options, id = 'M001', phase = 'execute-task') {
  const state = write(path.join(options.cwd, `.gsd/milestones/${id}/${id}-STATE.md`),
    `---\nmilestone: ${id}\nkind: milestone\n---\n**Phase:** ${phase}\n**Active Slice:** S05\n**Active Task:** T01\n**Next Action:** Conferir fontes\n`);
  assert.strictEqual(personal.bindWork({ ...options, id, intent: 'create' }).status, 'ok');
  return state;
}
function events(options, names = ['recent', 'native-with-id', 'heartbeat-only', 'other-workflow']) {
  const rows = names.flatMap(name => fixture.cases.find(row => row.name === name).records.map(row => ({ ...row, dispatch_id: `dispatch-${name}` })));
  return write(path.join(options.cwd, '.gsd/forge/events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function read(options, extra = {}) { return panel.readPanelSource({ ...options, now, ...extra }); }
function safe(dto) {
  function visit(value) {
    if (typeof value === 'string') {
      const closedNavigation = agents.NAVIGATION.some(row => row.label === value);
      assert(closedNavigation || !/[a-z]:[\\/]|\\\\|(?:^|\s)\/[a-z]/i.test(value), `absolute path: ${value}`);
      assert(!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value), `control: ${value}`);
      assert(!value.includes(temp) && !value.includes('SECRET-ANSWER'));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(dto); assert(Buffer.byteLength(JSON.stringify(dto)) <= panel.LIMITS.dto);
  return dto;
}
function tree(dir) {
  const result = {};
  function walk(file) {
    const stat = fs.lstatSync(file), key = path.relative(dir, file);
    result[key] = [stat.mtimeMs, stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? fs.readdirSync(file).sort() : sha256(fs.readFileSync(file))];
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name));
  }
  walk(dir); return result;
}
function run(options, args) {
  return spawnSync(process.execPath, [cli, '--cwd', options.cwd, '--now', String(now), ...args], { env: options.env, encoding: 'utf8', timeout: 15000 });
}
try {
  check('lazy import exports frozen vocabulary without data reads', () => {
    const script = `const fs=require('fs'); const r=fs.readFileSync; fs.readFileSync=function(f,...a){if(!String(f).endsWith('.js')&&!String(f).endsWith('.json'))throw Error('data-read'); if(String(f).endsWith('context.json'))throw Error('data-read');return r.call(this,f,...a)}; require(${JSON.stringify(cli)}); for(const n of ['forge-personal-context','forge-agent-view','forge-pending-questions'])if(require.cache[require.resolve(${JSON.stringify(path.join(__dirname, '/'))}+n)])throw Error('eager-reader'); console.log('lazy');`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.strictEqual(child.status, 0, child.stderr);
    for (const key of ['readPanelSource', 'stableProjection', 'main']) assert.strictEqual(typeof panel[key], 'function');
    assert(Object.isFrozen(panel.STATE_REASONS) && Object.isFrozen(panel.LIMITS));
    for (const key of ['ACTIVITY_LABELS', 'KIND_LABELS', 'EMPTY_LABELS']) assert(Object.isFrozen(agents[key]));
  });
  const own = root('owner'); const state = bind(own); events(own);
  const proof = write(path.join(own.cwd, 'evidence/proof.md'), 'Original proof');
  assert.strictEqual(personal.saveCheckpoint({ ...own, id: 'M001', intent: 'checkpoint', checkpoint: {
    nextAction: [{ source: proof, text: 'Conferir resultado' }], lastResult: [{ source: proof, text: 'Resultado parcial' }],
  } }).status, 'ok');
  const questions = pending.openQuestions({ cwd: own.cwd, unit: 'execute-task/T03', milestone: 'M001', decision_set: 'panel-fixture',
    questions: [{ id: 'choice', question: 'Qual alternativa?' }] });
  pending.answer({ cwd: own.cwd, identity: questions.identity_sha256, answers: [{ id: 'choice', answer: 'SECRET-ANSWER', source: 'user-text' }] });
  pending.openQuestions({ cwd: own.cwd, unit: 'execute-task/T03', milestone: 'M001', decision_set: 'pending-fixture',
    questions: [{ id: 'next-choice', question: 'Próxima decisão?' }] });
  check('canonical work agent pending evidence projection matches direct readers', () => {
    const snapshot = personal.readPersonalSnapshot(own), view = agents.deriveAgentView(agents.readAgentSources({ ...own, filter: { type: 'personal' } }), { now });
    const questions = pending.listPendingQuestions({ ...own, filter: { type: 'personal' } });
    const dto = safe(read(own));
    assert.strictEqual(dto.schema_version, 1); assert.deepStrictEqual(dto.state, { status: 'ok', reason: 'snapshot', label: panel.STATE_REASONS.snapshot.label });
    assert.strictEqual(dto.works.length, snapshot.works.length); assert.strictEqual(dto.works[0].id, snapshot.works[0].id);
    assert.strictEqual(dto.works[0].status, snapshot.works[0].workStatus); assert.strictEqual(dto.works[0].phase.value, 'executing');
    assert.strictEqual(dto.works[0].phase.raw, snapshot.works[0].state.phase);
    assert.strictEqual(dto.works[0].next_action.text, snapshot.works[0].nextAction.text);
    assert.strictEqual(dto.agents.length, view.agents.length);
    for (const [i, row] of view.agents.entries()) {
      const shown = dto.agents[i];
      for (const key of ['dispatch_id', 'kind', 'unit', 'milestone', 'slice', 'workflow_id', 'task', 'engine', 'transport', 'outcome', 'freshness', 'questions']) assert.deepStrictEqual(shown[key], row[key]);
      assert.strictEqual(shown.host, row.host_runtime); assert.strictEqual(shown.phase.value, row.phase);
      assert.strictEqual(shown.kind_label, agents.KIND_LABELS[row.kind]);
      assert.strictEqual(shown.activity.remote, row.activity.remote); assert.deepStrictEqual(shown.activity.local, row.activity.local);
      assert.strictEqual(shown.activity.label, agents.ACTIVITY_LABELS[row.activity.remote]);
      assert.deepStrictEqual(shown.navigation, row.navigation.map(n => n.label));
      for (const key of ['requested', 'resolved', 'observed', 'divergent']) assert.strictEqual(shown.model[key], row.model[key]);
      for (const key of ['requested', 'resolved']) assert.strictEqual(shown.effort[key], row.effort[key]);
    }
    assert.strictEqual(dto.pending.length, questions.questions.length);
    for (const [i, row] of questions.questions.entries()) {
      const shown = dto.pending[i];
      for (const key of ['id', 'question', 'status', 'answered']) assert.strictEqual(shown[key], row[key]);
      assert.strictEqual(shown.last_round_outcome, row.last_round?.outcome || null); assert.strictEqual(shown.dispatch_id, null);
      assert(!Object.hasOwn(shown, 'answer'));
    }
    assert(dto.evidence.some(row => row.path === 'evidence/proof.md' && row.location === 'project' && row.validity === 'current'));
    assert.deepStrictEqual(dto.census.events, view.sources.events.census);
    for (const key of ['invalid', 'foreign', 'excess']) assert.strictEqual(dto.census.pending[key], questions.census[key]);
  });
  check('same clock deterministic within-state hash stable canonical stale transition changes hash', () => {
    const a = safe(read(own)), b = safe(read(own)), c = safe(read(own, { now: now + 86400000 }));
    assert.deepStrictEqual(a, b); assert.notStrictEqual(a.generated_at, c.generated_at);
    assert.strictEqual(a.stable_sha256, sha256(JSON.stringify(canonical(panel.stableProjection(a)))));
    // Clock-only activity age is excluded; a clock-driven freshness change is a real state change.
    const d = safe(read(own, { now: now + 1 })); assert.strictEqual(a.stable_sha256, d.stable_sha256);
    assert(a.agents.some(row => row.freshness === 'current')); assert(c.agents.some(row => row.freshness === 'stale'));
    assert.notStrictEqual(a.stable_sha256, c.stable_sha256);
  });
  check('empty missing no bindings ambiguous and unresolved workspace states', () => {
    assert.strictEqual(safe(read(own, { folders: [] })).state.reason, 'no-workspace');
    const empty = root('empty'); assert.strictEqual(safe(read(empty)).state.reason, 'no-bindings');
    const other = root('other'); bind(other, 'M002');
    assert.strictEqual(safe(read(own, { folders: [own.cwd, other.cwd], userHome: other.userHome })).works.length, 1);
    bind({ ...own, cwd: other.cwd, project: other.cwd }, 'M002');
    const ambiguous = safe(read(own, { folders: [own.cwd, other.cwd] }));
    assert.strictEqual(ambiguous.state.reason, 'workspace-ambiguous'); assert.deepStrictEqual(ambiguous.works, []);
    const noProject = path.join(temp, 'not-project'); fs.mkdirSync(noProject);
    assert.strictEqual(safe(read(own, { folders: [noProject] })).state.reason, 'project-unresolved');
    assert.strictEqual(safe(read(own, { folders: [noProject, own.cwd] })).works.length, 1);
  });
  check('profile isolation foreign records invalid questions and malformed events census', () => {
    const second = { ...own, userHome: path.join(temp, 'second-home') }; fs.mkdirSync(second.userHome);
    bind(second, 'M003');
    const foreign = fixture.cases.find(row => row.name === 'recent').records.map(row => ({ ...row, milestone: 'M003', workflow_id: 'M003', dispatch_id: 'foreign-dispatch' }));
    fs.appendFileSync(path.join(own.cwd, '.gsd/forge/events.jsonl'), foreign.map(row => JSON.stringify(row)).join('\n') + '\n{broken}\n');
    pending.openQuestions({ cwd: own.cwd, unit: 'execute-task/T03', milestone: 'M003', decision_set: 'foreign', questions: [{ id: 'foreign', question: 'Private foreign question' }] });
    write(path.join(own.cwd, '.gsd/forge/questions/invalid.json'), '{}');
    const a = safe(read(own)), b = safe(read(second));
    assert(a.works.every(row => row.id !== 'M003')); assert(b.works.every(row => row.id === 'M003'));
    assert(a.agents.every(row => row.dispatch_id !== 'foreign-dispatch')); assert.strictEqual(b.agents.length, 1);
    assert(a.pending.every(row => row.id !== 'foreign')); assert(a.census.pending.foreign > 0 && a.census.pending.invalid > 0);
    assert(a.census.events.skipped_malformed > 0);
    assert(!JSON.stringify(a).includes('Private foreign'));
  });
  check('stale missing invalid and closed phase vocabulary', () => {
    const local = root('freshness'), file = bind(local), capture = write(path.join(local.cwd, 'proof.md'), 'proof');
    assert.strictEqual(personal.saveCheckpoint({ ...local, id: 'M001', intent: 'checkpoint', checkpoint: { nextAction: [{ text: 'Next', source: capture }] } }).status, 'ok');
    assert.strictEqual(safe(read(local)).works[0].freshness, 'current'); fs.appendFileSync(capture, 'changed');
    assert.strictEqual(safe(read(local)).works[0].freshness, 'stale'); fs.unlinkSync(capture);
    assert.notStrictEqual(safe(read(local)).works[0].freshness, 'current');
    const missing = root('missing'); const absent = bind(missing); fs.unlinkSync(absent);
    assert.strictEqual(safe(read(missing)).works[0].freshness, 'missing');
    assert.strictEqual(safe(read(missing)).sections.agents.reason, 'source_unreadable');
    assert.strictEqual(safe(read(missing)).sections.pending.reason, 'owner-missing');
    for (const [phase, expected] of Object.entries({ 'plan-milestone': 'planning', 'discuss-milestone': 'planning', 'plan-slice': 'planning', 'research-milestone': 'preparing', 'research-slice': 'preparing', 'execute-task': 'executing', 'complete-slice': 'verifying', 'complete-milestone': 'verifying', unexpected: 'unknown', constructor: 'unknown' })) {
      const original = fs.readFileSync(state, 'utf8'); fs.writeFileSync(state, original.replace('execute-task', phase));
      assert.strictEqual(safe(read(own)).works[0].phase.value, expected); fs.writeFileSync(state, original);
    }
    assert(fs.existsSync(file));
    const completed = root('completed'), completedState = bind(completed);
    fs.writeFileSync(completedState, fs.readFileSync(completedState, 'utf8').replace('kind: milestone', 'kind: milestone\nstatus: DONE'));
    assert.strictEqual(safe(read(completed)).works[0].status, 'completed'); assert.strictEqual(safe(read(completed)).works[0].phase.value, 'completed');
    personal.saveCheckpoint({ ...completed, id: 'M001', intent: 'checkpoint', checkpoint: { pending: [{ source: completedState, text: 'Human decision' }] } });
    assert.strictEqual(safe(read(completed)).works[0].status, 'pending'); assert.strictEqual(safe(read(completed)).works[0].phase.value, 'waiting');
  });
  check('invalid store reasons and bounded preflight refuses readers', () => {
    const local = root('invalid'); const file = path.join(local.userHome, '.forge-personal/context.json');
    for (const [bytes, reason] of [['{', 'store-corrupt'], [JSON.stringify({ schemaVersion: 99 }), 'schema-unsupported'], [JSON.stringify({ schemaVersion: 1 }), 'schema-invalid']]) {
      write(file, bytes); assert.strictEqual(safe(read(local)).state.reason, reason);
    }
    fs.writeFileSync(file, ' '.repeat(panel.LIMITS.store + 1));
    const original = personal.readPersonalSnapshot;
    personal.readPersonalSnapshot = () => { throw Error('reader must not run'); };
    try { assert.strictEqual(safe(read(local)).state.reason, 'personal-store-too-large'); }
    finally { personal.readPersonalSnapshot = original; }
    fs.unlinkSync(file); fs.mkdirSync(file); assert.strictEqual(safe(read(local)).state.reason, 'personal-store-invalid'); fs.rmdirSync(file);
    // Directory junctions exercise the no-link rule on Windows without symlink privileges.
    const target = path.join(temp, 'link-target'); fs.mkdirSync(target);
    fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(safe(read(local)).state.reason, 'personal-store-invalid'); fs.unlinkSync(file);
  });
  check('hostile text paths controls responses never enter DTO', () => {
    const local = root('hostile'); bind(local); events(local, []);
    const text = 'Antes \u001b[31mRED\u001b[0m \u202e C:\\Users\\secret\\file \\\\server\\share /home/secret/file path:/home/secret/file depois ' + 'x'.repeat(400);
    const source = write(path.join(local.cwd, 'proof.md'), 'proof');
    personal.saveCheckpoint({ ...local, id: 'M001', intent: 'checkpoint', checkpoint: { nextAction: [{ source, text }] } });
    pending.openQuestions({ cwd: local.cwd, unit: 'execute-task/T01', milestone: 'M001', decision_set: 'hostile', questions: [{ id: 'hostile', question: text }] });
    const dto = safe(read(local)); assert(Array.from(dto.works[0].next_action.text).length <= 240);
    assert(!JSON.stringify(dto).includes('secret')); assert(Array.from(dto.pending[0].question).length <= 240);
  });
  check('canonical empty linked oversized and unreadable section states', () => {
    const local = root('sections'); bind(local); const file = events(local, []);
    let dto = safe(read(local)); assert.strictEqual(dto.sections.agents.reason, 'no-agents');
    assert.strictEqual(dto.sections.agents.label, agents.EMPTY_LABELS['no-agents']);
    assert.strictEqual(dto.sections.pending.reason, 'no-questions');
    // Existing readers keep their own limits and link rejection.
    fs.writeFileSync(file, ' '.repeat(16 * 1024 * 1024 + 1));
    dto = safe(read(local)); assert.strictEqual(dto.sections.agents.reason, 'events-too-large');
    assert.strictEqual(dto.sections.agents.label, agents.EMPTY_LABELS['events-too-large']);
    fs.unlinkSync(file); const target = path.join(temp, 'event-link-target'); fs.mkdirSync(target);
    fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir');
    dto = safe(read(local)); assert.strictEqual(dto.sections.agents.reason, 'source_link');
    fs.unlinkSync(file); fs.writeFileSync(file, '');
    const questionDir = path.join(local.cwd, '.gsd/forge/questions');
    fs.symlinkSync(target, questionDir, process.platform === 'win32' ? 'junction' : 'dir');
    dto = safe(read(local)); assert.strictEqual(dto.sections.pending.reason, 'questions-unreadable'); fs.unlinkSync(questionDir);
    const namespace = path.join(local.userHome, '.forge-personal/.gsd');
    fs.rmSync(namespace, { recursive: true, force: true });
    fs.symlinkSync(target, namespace, process.platform === 'win32' ? 'junction' : 'dir');
    dto = safe(read(local)); assert.strictEqual(dto.state.reason, 'namespace-invalid'); fs.unlinkSync(namespace);
  });
  check('snapshot evidence is projected without additional reads including worktree and external', () => {
    const original = personal.readPersonalSnapshot;
    const canonicalSnapshot = original(own), alias = path.join(temp, 'validated-worktree'); fs.mkdirSync(alias);
    const captures = ['current', 'stale', 'missing', 'unreadable'].map((validity, i) => ({ text: `Proof ${i}`, source: path.join(alias, `proof${i}.md`), validity }));
    const syntheticSnapshot = { ...canonicalSnapshot, works: [{ ...canonicalSnapshot.works[0], checkpoint: { handoff: [...captures,
      { text: 'External', source: path.join(temp, 'outside.md'), validity: 'unreadable' }] }, lastResult: null, terminalEvidence: { reason: 'state-missing' } }] };
    personal.readPersonalSnapshot = () => syntheticSnapshot;
    const oldRead = fs.readFileSync; fs.readFileSync = (file, ...args) => { assert(!String(file).includes('proof0.md') && !String(file).includes('outside.md'), 'extra evidence read'); return oldRead(file, ...args); };
    try {
      const dto = safe(read(own, { folders: [alias] }));
      for (let i = 0; i < 3; i++) assert.deepStrictEqual({ path: dto.evidence[i].path, location: dto.evidence[i].location, validity: dto.evidence[i].validity },
        { path: `proof${i}.md`, location: 'worktree', validity: captures[i].validity });
      assert.strictEqual(dto.evidence[3].path, null); assert.strictEqual(dto.evidence[3].location, 'external');
      assert.strictEqual(dto.evidence[4].path, null); assert.strictEqual(dto.evidence[4].location, 'external');
    } finally { personal.readPersonalSnapshot = original; fs.readFileSync = oldRead; }
  });
  check('pending joins by exact dispatch and never infers remote progress from heartbeat', () => {
    const original = pending.listPendingQuestions, direct = agents.deriveAgentView(agents.readAgentSources({ ...own, filter: { type: 'personal' } }), { now });
    const agent = direct.agents.find(row => row.kind === 'sidecar');
    pending.listPendingQuestions = () => ({ census: { total: 1, foreign: 0, invalid: 0, excess: 0 }, empty_reason: null, questions: [
      { id: 'dispatch-question', question: 'Continue?', answered: false, status: 'pending', origin: { unit: agent.unit, milestone: 'M001', workflow_id: 'M001', dispatch_id: agent.dispatch_id }, last_round: { outcome: 'closed' } },
    ] });
    try {
      const dto = safe(read(own)); assert(dto.pending.length, JSON.stringify({ state: dto.state, pending: dto.sections.pending, agent })); assert.strictEqual(dto.pending[0].agent_kind, agent.kind);
      assert.strictEqual(dto.pending[0].dispatch_id, agent.dispatch_id); assert.strictEqual(dto.pending[0].last_round_outcome, 'closed');
      assert(dto.agents.filter(row => row.activity.local.includes('heartbeat')).every(row => row.activity.remote === 'unknown'));
    } finally { pending.listPendingQuestions = original; }
  });
  check('section limits and excess work agent pending evidence counts', () => {
    const local = root('limits');
    for (let i = 1; i <= 35; i++) bind(local, `M${String(i).padStart(3, '0')}`);
    const rows = Array.from({ length: 70 }, (_, i) => ({ ...fixture.cases.find(row => row.name === 'recent').records[0], dispatch_id: `dispatch-${i}` }));
    write(path.join(local.cwd, '.gsd/forge/events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    pending.openQuestions({ cwd: local.cwd, unit: 'execute-task/T01', milestone: 'M001', decision_set: 'limits', questions: rows.map((_, i) => ({ id: `q${i}`, question: `Question ${i}` })) });
    const proof = path.join(local.cwd, '.gsd/milestones/M001/M001-STATE.md');
    personal.saveCheckpoint({ ...local, id: 'M001', intent: 'checkpoint', checkpoint: { handoff: Array.from({ length: 80 }, (_, i) => ({ source: proof, text: `Capture ${i}` })) } });
    const dto = safe(read(local)); assert.strictEqual(dto.works.length, 32); assert.strictEqual(dto.census.works.excess, 3);
    assert.strictEqual(dto.agents.length, 64); assert.strictEqual(dto.census.agents.excess, 6);
    assert.strictEqual(dto.pending.length, 64); assert.strictEqual(dto.census.pending.row_excess, 6);
    assert.strictEqual(dto.evidence.length, 64); assert(dto.census.evidence.excess > 0);
  });
  check('read-only filesystem and canonical mutation traps plus unchanged bytes mtime listings', () => {
    const before = tree(temp), restore = [];
    function trap(object, key) { if (typeof object[key] !== 'function') return; const old = object[key]; object[key] = () => { throw Error(`mutated ${key}`); }; restore.push(() => { object[key] = old; }); }
    for (const key of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'link', 'symlink', 'truncate', 'utimes', 'chmod']) for (const suffix of ['', 'Sync']) trap(fs, key + suffix);
    for (const [object, keys] of [[personal, ['bindWork', 'saveCheckpoint']], [pending, ['openQuestions', 'handoff', 'answer', 'recordRound', 'continuation']], [require('./forge-lock'), ['acquireSync', 'acquire', 'releaseHandle']]]) for (const key of keys) trap(object, key);
    for (const key of ['openSync', 'open']) { const old = fs[key]; fs[key] = (file, flags, ...args) => { assert(flags === 'r' || flags === 0, 'write-open'); return old(file, flags, ...args); }; restore.push(() => { fs[key] = old; }); }
    try { safe(read(own)); safe(read(own, { folders: [] })); assert.strictEqual(run(own, ['--json']).status, 0); }
    finally { restore.reverse().forEach(fn => fn()); }
    assert.deepStrictEqual(tree(temp), before);
  });
  check('CLI JSON summary state exit codes rejects mutations before source read', () => {
    const a = run(own, ['--json']); assert.strictEqual(a.status, 0, a.stderr); safe(JSON.parse(a.stdout));
    assert.strictEqual(a.stdout, run(own, ['--json']).stdout);
    const human = run(own, []); assert.strictEqual(human.status, 0); assert(human.stdout.includes('Forge')); assert(!human.stdout.includes(own.cwd));
    for (const flag of ['--answer', '--bind', '--open', '--handoff', '--round', '--continuation', '--checkpoint', '--select', '--write', '--out', '--unknown']) {
      let output = ''; const old = personal.readPersonalSnapshot; personal.readPersonalSnapshot = () => { throw Error('source-read'); };
      try { assert.strictEqual(panel.main([flag], { stdout: { write: text => { output += text; } }, stderr: { write: text => { output += text; } } }), 2); }
      finally { personal.readPersonalSnapshot = old; } assert(!output.includes('source-read'));
    }
    for (const args of [['--cwd'], ['--now', 'invalid'], ['--folder'], ['--cwd', '--json']]) assert.strictEqual(run(own, args).status, 2);
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
