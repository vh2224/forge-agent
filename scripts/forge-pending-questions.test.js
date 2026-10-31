'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const api = require('./forge-pending-questions');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pending-questions-'));
const owner = path.join(root, 'owner');
const cli = path.join(__dirname, 'forge-pending-questions.js');
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); }
function snapshot(dir) { return fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'hex'), fs.statSync(path.join(dir, name)).mtimeMs]); }
function run(args) { return spawnSync(process.execPath, [cli, ...args, '--cwd', owner, '--json'], { encoding: 'utf8', windowsHide: true }); }
const questions = [{ id: 'root', question: 'Qual raiz?' }, { id: 'scope', question: 'Qual escopo?' }];
try {
  fs.mkdirSync(owner);
  assert.throws(() => api.openQuestions({ cwd: owner, unit: 'execute-task/T01', decision_set: 'owner-choice', questions }), /owner-missing/);
  assert(!fs.existsSync(path.join(owner, '.gsd')));
  fs.mkdirSync(path.join(owner, '.gsd/forge'), { recursive: true });
  const opened = api.openQuestions({ cwd: owner, unit: 'execute-task/T01', milestone: 'M001', slice: 'S04', task: 'T01', decision_set: 'owner-choice', questions });
  const identity = opened.identity_sha256;
  const dir = path.join(owner, '.gsd/forge/questions'), file = path.join(dir, `${identity}.json`);
  const base = { cwd: owner, identity };
  assert.strictEqual(opened.status, 'pending');
  assert.deepStrictEqual(api.continuation(base).pending_ids, ['root', 'scope']);
  assert.strictEqual(run(['--continuation', '--identity', identity]).status, 3);
  const original = snapshot(dir);
  assert.strictEqual(api.openQuestions({ cwd: owner, unit: 'execute-task/T01', milestone: 'M001', slice: 'S04', task: 'T01', decision_set: 'owner-choice', questions }).identity_sha256, identity);
  assert.deepStrictEqual(snapshot(dir), original);
  for (const answers of [[], [{ id: 'root', answer: ' ' }], [{ id: 'foreign', answer: 'a', source: 'user-text' }],
    [{ id: 'root', answer: 'a', source: 'timeout' }], [{ id: 'root', answer: 'a', source: 'user-text', accepted: true }],
    [{ id: 'root', answer: 'a', source: 'user-text' }, { id: 'root', answer: 'a', source: 'tool-answer' }]]) {
    assert.throws(() => api.answer({ ...base, answers }), /pending-/); assert.deepStrictEqual(snapshot(dir), original);
  }
  for (const source of ['default', 'recommended', 'closed', 'cancelled', 'empty', 'handle', 'imported']) {
    assert.throws(() => api.answer({ ...base, answers: [{ id: 'root', answer: 'a', source }] }), /source/);
    assert.deepStrictEqual(snapshot(dir), original);
  }
  api.recordRound({ ...base, ids: ['root', 'scope'], channel: 'text-fallback', outcome: 'closed-unanswered' });
  api.answer({ ...base, channel: 'text-fallback', answers: [{ id: 'root', answer: 'first', source: 'user-text' }] });
  assert.deepStrictEqual(api.continuation(base).pending_ids, ['scope']);
  const partialBytes = fs.readFileSync(file);
  assert.throws(() => api.answer({ ...base, answers: [{ id: 'root', answer: 'conflict', source: 'user-text' }] }), /conflict/);
  assert.deepStrictEqual(fs.readFileSync(file), partialBytes);
  const restart = run(['--continuation', '--identity', identity]);
  assert.strictEqual(restart.status, 3); assert.deepStrictEqual(JSON.parse(restart.stdout).pending_ids, ['scope']);
  api.answer({ ...base, channel: 'codex-request-user-input', answers: [{ id: 'scope', answer: 'second', source: 'tool-answer' }] });
  assert.strictEqual(api.continuation(base).ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file)).rounds.map(row => row.outcome), ['closed-unanswered', 'answered', 'answered']);
  api.openQuestions({ cwd: owner, unit: 'execute-task/T01', milestone: 'M001', slice: 'S04', task: 'T01', decision_set: 'owner-choice', questions: [{ id: 'extra', question: 'Outra decisão?' }] });
  assert.deepStrictEqual(api.continuation(base).pending_ids, ['extra']);
  console.log('PASS owner lifecycle: immutable origin, idempotence, explicit partial answers, round history and child-process restart');
  { // R1: interrupted first publication (origin written, state missing) recovers exactly.
    const own = path.join(root, 'owner-interrupted'); fs.mkdirSync(path.join(own, '.gsd/forge'), { recursive: true });
    const opts = { cwd: own, unit: 'execute-task/T01', milestone: 'M001', slice: 'S04', task: 'T01', decision_set: 'owner-choice', questions };
    const id = api.openQuestions(opts).identity_sha256, qdir = path.join(own, '.gsd/forge/questions');
    const stateFile = path.join(qdir, `${id}.json`), originFile2 = path.join(qdir, `${id}.origin.json`), originBytes2 = fs.readFileSync(originFile2);
    fs.unlinkSync(stateFile);
    assert.strictEqual(api.openQuestions(opts).status, 'pending');
    assert.deepStrictEqual(api.continuation({ cwd: own, identity: id }).pending_ids, ['root', 'scope']);
    assert.deepStrictEqual(fs.readFileSync(originFile2), originBytes2);
    fs.unlinkSync(stateFile);
    // Simulate the lstat/exists semantics of a dangling link without requiring
    // Windows file-symlink privileges. Recovery must refuse before publication.
    const atomic = require('./forge-surgical-reset'), originalWrite = atomic.writeJsonAtomic, originalStat = fs.lstatSync;
    const stateParent = fs.realpathSync.native(path.dirname(stateFile));
    const sameState = target => path.basename(target) === path.basename(stateFile)
      && fs.realpathSync.native(path.dirname(target)) === stateParent;
    let publications = 0;
    fs.lstatSync = function(target, ...args) {
      if (sameState(target)) return { isSymbolicLink: () => true };
      return originalStat.call(fs, target, ...args);
    };
    atomic.writeJsonAtomic = function(target, value) {
      if (sameState(target)) { publications++; throw new Error('unexpected state publication to dangling link'); }
      return originalWrite(target, value);
    };
    try { assert.throws(() => api.openQuestions(opts), /path-link/); }
    finally { fs.lstatSync = originalStat; atomic.writeJsonAtomic = originalWrite; }
    assert.strictEqual(publications, 0); assert(!fs.existsSync(stateFile));
    assert.deepStrictEqual(fs.readFileSync(originFile2), originBytes2);
    console.log('PASS dangling state link: origin-only recovery refuses before any publication');
    fs.appendFileSync(originFile2, ' ');
    assert.throws(() => api.openQuestions(opts), /origin-mismatch/); assert(!fs.existsSync(stateFile));
    fs.writeFileSync(originFile2, originBytes2); fs.unlinkSync(originFile2);
    fs.writeFileSync(stateFile, JSON.stringify({ schema_version: 1, identity_sha256: id, questions: [] }));
    assert.throws(() => api.openQuestions(opts), /pending-/); assert(!fs.existsSync(originFile2));
  }
  { // R2: variable-length IDs across 64+ rounds never push the state past the read limit.
    const own = path.join(root, 'owner-large'); fs.mkdirSync(path.join(own, '.gsd/forge'), { recursive: true });
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `${'long-id-'.repeat(14)}${i}`, question: `q${i} ${'x'.repeat(36000)}` }));
    const opts = { cwd: own, unit: 'execute-task/T01', milestone: 'M001', slice: 'S04', task: 'T01', decision_set: 'owner-choice', questions: many };
    const id = api.openQuestions(opts).identity_sha256, stateFile = path.join(own, '.gsd/forge/questions', `${id}.json`), ctx = { cwd: own, identity: id };
    for (let i = 0; i < 70; i++) api.recordRound({ ...ctx, ids: many.map(q => q.id), channel: 'text-fallback', outcome: 'presented' });
    assert(fs.statSync(stateFile).size <= 256 * 1024);
    assert.strictEqual(api.continuation(ctx).pending_ids.length, 6);
    const before = fs.readFileSync(stateFile);
    api.answer({ ...ctx, answers: [{ id: many[0].id, answer: 'ok', source: 'user-text' }] });
    assert(fs.statSync(stateFile).size <= 256 * 1024);
    assert.strictEqual(api.continuation(ctx).pending_ids.length, 5);
    assert(JSON.parse(fs.readFileSync(stateFile)).rounds_dropped > 0 && before.length > 0);
    // A large answer must publish its bounded final state exactly once. Failure
    // before that atomic publication preserves the pending answer and origin.
    const atomic = require('./forge-surgical-reset'), writeAtomic = atomic.writeJsonAtomic;
    const answerInput = { ...ctx, answers: [{ id: many[1].id, answer: 'a'.repeat(10000), source: 'user-text' }] };
    const answerBefore = fs.readFileSync(stateFile), originPath = stateFile.replace(/\.json$/, '.origin.json');
    const answerOrigin = fs.readFileSync(originPath), droppedBefore = JSON.parse(answerBefore).rounds_dropped;
    const isStateTarget = target => fs.realpathSync.native(target) === fs.realpathSync.native(stateFile);
    atomic.writeJsonAtomic = function(target, value) {
      if (isStateTarget(target)) throw new Error('injected answer publication failure');
      return writeAtomic(target, value);
    };
    try { assert.throws(() => api.answer(answerInput), /injected answer publication failure/); }
    finally { atomic.writeJsonAtomic = writeAtomic; }
    assert.deepStrictEqual(fs.readFileSync(stateFile), answerBefore);
    assert.deepStrictEqual(fs.readFileSync(originPath), answerOrigin);
    assert(api.continuation(ctx).pending_ids.includes(many[1].id));
    const publications = [];
    atomic.writeJsonAtomic = function(target, value) {
      if (isStateTarget(target)) {
        publications.push(Buffer.byteLength(JSON.stringify(value)));
        assert(publications.at(-1) <= 256 * 1024, 'every answer publication must stay readable');
        assert.strictEqual(publications.length, 1, 'answer must publish one atomic final state');
      }
      return writeAtomic(target, value);
    };
    try { api.answer(answerInput); }
    finally { atomic.writeJsonAtomic = writeAtomic; }
    assert.strictEqual(publications.length, 1);
    assert.strictEqual(api.continuation(ctx).pending_ids.length, 4);
    assert(JSON.parse(fs.readFileSync(stateFile)).rounds_dropped > droppedBefore);
    assert.deepStrictEqual(fs.readFileSync(originPath), answerOrigin);
    console.log('PASS atomic bounded answer: one readable publication, failure preserves pending bytes and origin');
    // A state that cannot fit even one more round is refused without changing bytes.
    const edge = JSON.parse(fs.readFileSync(stateFile)); edge.rounds = [];
    const pad = 256 * 1024 - Buffer.byteLength(JSON.stringify(edge)) - 40; edge.questions[1].question += 'y'.repeat(Math.max(0, pad));
    fs.writeFileSync(stateFile, JSON.stringify(edge)); const edgeBytes = fs.readFileSync(stateFile);
    assert.throws(() => api.recordRound({ ...ctx, ids: many.map(q => q.id), channel: 'text-fallback', outcome: 'presented' }), /state-too-large/);
    assert.deepStrictEqual(fs.readFileSync(stateFile), edgeBytes);
  }
  console.log('PASS interrupted origin recovery and bounded round history');
  const receiptFile = path.join(root, 'receipt.json');
  const receipt = { phase: 'ready', dispatch_id: 'fixture-dispatch', fingerprint: 'a'.repeat(64), result: { status: 'partial', questions }, preparation_identity: { milestone: 'M001', slice: 'S04', task: 'T01' } };
  const handoffOptions = { cwd: owner, receipt: receiptFile, unit: 'execute-task/T01', milestone: 'M001', slice: 'S04', task: 'T01' };
  write(receiptFile, receipt);
  const handed = api.handoff(handoffOptions);
  assert.strictEqual(handed.agent_link.status, 'unlinked');
  assert.strictEqual(handed.identity.dispatch_id, receipt.dispatch_id);
  const handedBefore = snapshot(dir);
  assert.strictEqual(api.handoff(handoffOptions).identity_sha256, handed.identity_sha256); assert.deepStrictEqual(snapshot(dir), handedBefore);
  write(receiptFile, { ...receipt, fingerprint: 'b'.repeat(64) });
  assert.notStrictEqual(api.handoff(handoffOptions).identity_sha256, handed.identity_sha256);
  write(receiptFile, { ...receipt, phase: 'running' }); assert.throws(() => api.handoff(handoffOptions), /unit-open/);
  write(receiptFile, { ...receipt, result: { status: 'done' } }); assert.throws(() => api.handoff(handoffOptions), /unit-open/);
  write(receiptFile, { ...receipt, result: { status: 'partial' } }); assert.strictEqual(api.handoff(handoffOptions).reason, 'no-structured-questions');
  const stateFile = path.join(root, 'recovery.json');
  write(receiptFile, { ...receipt, phase: 'failed' });
  const state = { schema_version: 2, budget: 'tier-ceiling', unit: handoffOptions.unit, started_at: 1, attempts: [{ receipt: receiptFile }], pending_questions: ['Legacy question?'], request_identity: { milestone: 'M001', slice: 'S04', task: 'T01' } };
  write(stateFile, state);
  const failed = api.handoff({ ...handoffOptions, recovery_state: stateFile }); assert.strictEqual(failed.questions.length, 1);
  write(stateFile, { ...state, unit: 'execute-task/T02' }); assert.throws(() => api.handoff({ ...handoffOptions, recovery_state: stateFile }), /origin-mismatch/);
  write(stateFile, { ...state, request_identity: { milestone: 'M002' } }); assert.throws(() => api.handoff({ ...handoffOptions, recovery_state: stateFile }), /origin-mismatch/);
  write(receiptFile, '{invalid'); assert.throws(() => api.handoff(handoffOptions), /json-invalid/);
  write(receiptFile, 'x'.repeat(8 * 1024 * 1024 + 1)); assert.throws(() => api.handoff(handoffOptions), /too-large/);
  write(receiptFile, receipt);
  write(stateFile, { ...state, attempts: [{ receipt: path.join(root, 'foreign.json') }] });
  assert.throws(() => api.handoff({ ...handoffOptions, recovery_state: stateFile }), /origin-mismatch/);
  write(stateFile, 'x'.repeat(1024 * 1024 + 1)); assert.throws(() => api.handoff({ ...handoffOptions, recovery_state: stateFile }), /too-large/);
  assert.throws(() => api.handoff({ ...handoffOptions, milestone: 'M002' }), /origin-mismatch/);
  const eventsFile = path.join(owner, '.gsd/forge/events.jsonl');
  write(eventsFile, JSON.stringify({ event: 'dispatch', unit: 'execute-task/T01', dispatch_id: 'fixture-dispatch', milestone: 'M001', slice: 'S04', host_runtime: 'codex', transport: 'native-tool', engine: 'codex', status: 'started', ts: '2026-10-30T21:00:00Z' }) + '\n');
  const linked = api.handoff(handoffOptions);
  assert.strictEqual(linked.agent_link.status, 'linked'); assert.strictEqual(linked.agent_link.host, 'codex');
  assert.strictEqual(linked.agent_link.transport, 'native-tool');
  assert.strictEqual(linked.identity_sha256, handed.identity_sha256, 'S03 view never changes origin hash');
  const originFile = path.join(dir, `${identity}.origin.json`), originBytes = fs.readFileSync(originFile);
  fs.appendFileSync(originFile, ' ');
  assert.throws(() => api.openQuestions({ cwd: owner, unit: 'execute-task/T01', milestone: 'M001', slice: 'S04', task: 'T01', decision_set: 'owner-choice', questions }), /origin-mismatch/);
  fs.writeFileSync(originFile, originBytes);
  const junction = path.join(root, 'junction');
  try {
    fs.symlinkSync(path.join(owner, '.gsd/forge'), junction, 'junction');
    assert.throws(() => api.handoff({ ...handoffOptions, receipt: path.join(junction, 'events.jsonl') }), /path-link/);
    console.log('PASS ancestor junction refusal without reading redirected receipt');
  } catch (error) { if (error.code !== 'EPERM') throw error; console.log('SKIP receipt junction negative: Windows EPERM'); }
  console.log('PASS receipt closure, fingerprint isolation, failed recovery binding, legacy IDs and bounded malformed inputs');
  api.openQuestions({ cwd: owner, unit: 'execute-task/T02', milestone: 'M002', decision_set: 'foreign', questions });
  const beforeRead = snapshot(dir);
  const list = api.listPendingQuestions({ cwd: owner, filter: { type: 'milestone', id: 'M001' } });
  assert(list.questions.length >= 3); assert(list.census.foreign > 0);
  assert(!JSON.stringify(list).includes('first')); assert(!JSON.stringify(list).includes(root));
  assert.deepStrictEqual(snapshot(dir), beforeRead);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, USERPROFILE: home, HOME: home, FORGE_PERSONAL_HOME: path.join(home, '.forge-personal') };
  const personal = require('./forge-personal-context');
  write(path.join(owner, '.gsd/milestones/M001/M001-STATE.md'), '---\nmilestone: M001\nkind: milestone\n---\n**Phase:** idle\n');
  write(path.join(owner, '.gsd/forge/runs/M001.json'), { id: 'M001', kind: 'milestone', project: owner, cwd: owner, active: false });
  assert.strictEqual(personal.bindWork({ cwd: owner, project: owner, userHome: home, env, id: 'M001', intent: 'create' }).status, 'ok');
  const own = api.listPendingQuestions({ cwd: owner, userHome: home, env, filter: { type: 'personal' } });
  assert(own.questions.length > 0 && own.questions.every(q => q.origin.milestone === 'M001'));
  assert.deepStrictEqual(snapshot(dir), beforeRead);
  const listCli = run(['--list', '--milestone', 'M001']); assert.strictEqual(listCli.status, 0); assert(!listCli.stdout.includes(root));
  const questionsFile = path.join(root, 'cli-questions.json'); write(questionsFile, questions);
  const openCli = run(['--open', '--unit', 'execute-task/T03', '--set', 'cli-choice', '--questions', questionsFile]);
  assert.strictEqual(openCli.status, 0, openCli.stderr);
  const cliIdentity = JSON.parse(openCli.stdout).identity_sha256;
  const roundCli = run(['--round', '--identity', cliIdentity, '--ids', 'root', '--channel', 'text-fallback', '--outcome', 'handle-accepted']);
  assert.strictEqual(roundCli.status, 0, roundCli.stderr);
  const answersFile = path.join(root, 'cli-answers.json'); write(answersFile, [{ id: 'foreign', answer: 'yes', source: 'user-text' }]);
  assert.strictEqual(run(['--answer', '--identity', cliIdentity, '--answers', answersFile]).status, 3);
  write(answersFile, questions.map(q => ({ id: q.id, answer: 'explicit', source: 'tool-answer' })));
  assert.strictEqual(run(['--answer', '--identity', cliIdentity, '--channel', 'codex-request-user-input', '--answers', answersFile]).status, 0);
  assert.strictEqual(run(['--continuation', '--identity', cliIdentity]).status, 0);
  assert.strictEqual(run(['--handoff', '--receipt', receiptFile, '--unit', 'execute-task/T01', '--milestone', 'M001', '--slice', 'S04', '--task', 'T01']).status, 0);
  assert.strictEqual(run(['--unknown']).status, 2);
  console.log('PASS all six CLI actions, explicit tool answers and refusal/usage exit codes');
  const invalidFile = path.join(dir, '0'.repeat(64) + '.json'); write(invalidFile, '{}');
  assert(api.listPendingQuestions({ cwd: owner, filter: { type: 'milestone', id: 'M001' } }).census.invalid > 0);
  fs.unlinkSync(invalidFile);
  const stateBytes = fs.readFileSync(file), stateValue = JSON.parse(stateBytes);
  write(file, { ...stateValue, identity_sha256: '0'.repeat(64) });
  assert(api.listPendingQuestions({ cwd: owner, filter: { type: 'unit', id: 'execute-task/T01' } }).census.invalid > 0);
  fs.writeFileSync(file, stateBytes);
  for (let i = 0; i < 130; i++) write(path.join(dir, `extra-${i}.json`), '{}');
  const bounded = api.listPendingQuestions({ cwd: owner, filter: { type: 'milestone', id: 'M001' } });
  assert(bounded.census.excess > 0 && bounded.census.invalid > 0);
  console.log('PASS immutable origin bytes, explicit S03 join, mismatched scope, invalid-state census and file-count ceiling');
  console.log('PASS personal scope, no answer disclosure, bounded census and read-only bytes/mtime/directory preservation');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
