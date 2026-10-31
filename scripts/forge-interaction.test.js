'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const api = require('./forge-interaction');

if (process.argv[2] === '--resume') {
  process.stdout.write(JSON.stringify(api.persistQuestionState(process.argv[3], { unit: 'T01', receipt: 'fixture' }, [])));
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-interaction-'));
  try {
    const file = path.join(root, 'questions.json'), identity = { unit: 'T01', receipt: 'fixture' };
    const questions = [{ id: 'root', question: 'Choose root' }, { id: 'scope', question: 'Choose scope' }];
    const initial = api.persistQuestionState(file, identity, questions);
    assert(initial.every(row => row.status === 'pending'));
    const partial = api.persistQuestionState(file, identity, [], [{ id: 'root', answer: 'one' }]);
    assert.strictEqual(partial[0].status, 'resolved');
    assert.strictEqual(partial[1].status, 'pending');
    for (const answer of [{ accepted: true }, { id: 'scope', accepted: true }, { id: 'scope', timeout: true },
      { id: 'foreign', answer: 'yes' }, { id: 'scope', answer: '' }, { id: 'scope', final: true }]) {
      assert.throws(() => api.resolvePendingQuestions(partial, [answer]), /answer-id-required/);
    }
    assert.throws(() => api.resolvePendingQuestions(partial, []), /explicit-answers-required/);
    assert.throws(() => api.resolvePendingQuestions(partial, [{ id: 'scope', answer: 'one' }, { id: 'scope', answer: 'two' }]), /answer-id-required/);
    assert.throws(() => api.resolvePendingQuestions(partial, [{ id: 'root', answer: 'two' }]), /answer-conflict/);
    assert.throws(() => api.persistQuestionState(file, { unit: 'other', receipt: 'fixture' }, []), /scope-mismatch/);
    const child = spawnSync(process.execPath, [__filename, '--resume', file], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.deepStrictEqual(JSON.parse(child.stdout), partial);
    const completed = api.persistQuestionState(file, identity, [], [{ id: 'scope', answer: 'chosen behavior' }]);
    assert(completed.every(row => row.status === 'resolved'));
    assert.strictEqual(completed[0].answer, 'one');
    assert.deepStrictEqual(api.persistQuestionState(file, identity, questions), completed);
    assert.throws(() => api.createRecoveryAuthorizationAdapter({ approved: true }), /attestation-required/);
    assert.deepStrictEqual(api.mergePendingQuestions(partial, [{ id: 'scope', question: 'Choose scope', status: 'resolved', answer: 'authorized' }]), partial);
    console.log('PASS partial answers, foreign/duplicate/conflicting IDs, silence/timeout/final/accepted:true and child-process pending state');
    const beforeRounds = JSON.parse(fs.readFileSync(file));
    assert.deepStrictEqual(api.QUESTION_ROUND_OUTCOMES, ['presented', 'handle-accepted', 'closed-unanswered', 'cancelled', 'empty', 'timeout', 'answered']);
    for (let i = 0; i < 67; i++) api.recordQuestionRound(file, identity, { ids: ['root'], channel: 'text-fallback', outcome: 'presented' });
    const afterRounds = JSON.parse(fs.readFileSync(file));
    assert.strictEqual(afterRounds.rounds.length, 64); assert.strictEqual(afterRounds.rounds_dropped, 3);
    assert.deepStrictEqual(afterRounds.questions, beforeRounds.questions);
    assert.deepStrictEqual(api.persistQuestionState(file, identity, []), completed);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file)).rounds, afterRounds.rounds);
    const bytes = fs.readFileSync(file);
    assert.throws(() => api.recordQuestionRound(file, { unit: 'other' }, { ids: ['root'], channel: 'text-fallback', outcome: 'presented' }), /scope-mismatch/);
    assert.throws(() => api.recordQuestionRound(file, identity, { ids: ['foreign'], channel: 'text-fallback', outcome: 'presented' }), /round-id-invalid/);
    assert.throws(() => api.recordQuestionRound(file, identity, { ids: ['root'], channel: 'text-fallback', outcome: 'invented' }), /round-invalid/);
    assert.deepStrictEqual(fs.readFileSync(file), bytes);
    const pendingFile = path.join(root, 'pending.json'); api.persistQuestionState(pendingFile, identity, questions);
    assert.throws(() => api.recordQuestionRound(pendingFile, identity, { ids: ['root'], channel: 'text-fallback', outcome: 'answered' }), /round-id-invalid/);
    assert.throws(() => api.recordQuestionRound(path.join(root, 'missing.json'), identity, { ids: ['root'], channel: 'text-fallback', outcome: 'presented' }), /state-required/);
    const link = path.join(root, 'link.json');
    try { fs.symlinkSync(file, link); assert.throws(() => api.recordQuestionRound(link, identity, { ids: ['root'], channel: 'text-fallback', outcome: 'presented' }), /path-link/); }
    catch (error) { if (error.code !== 'EPERM') throw error; console.log('SKIP round link negative: Windows EPERM'); }
    console.log('PASS additive question rounds preserve answers, bound history to64 and reject foreign scope, pending answered, missing state and links');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
