'use strict';

const fs = require('fs');
const path = require('path');
const START = '<!-- forge:interaction:start -->';
const END = '<!-- forge:interaction:end -->';

// Resolved beside the installed script too: no consumer repository dependency.
function contract() {
  return fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-interaction.md'), 'utf8').trimEnd();
}

function renderBlock(eol = '\n') {
  return [START, contract(), END].join('\n').replace(/\r\n|\n/g, eol);
}

function project(content) {
  // Keep YAML frontmatter on line one. Original workflow bytes remain intact.
  return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${renderBlock()}\n`;
}

function sync(text) {
  const markers = [];
  let offset = 0, fence = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const opening = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
    } else if (opening) fence = opening[2];
    else if (line.startsWith('<!-- forge:interaction:')) {
      if (line !== START && line !== END) return { malformed: 'interaction-invalid-marker' };
      markers.push({ line, start: offset, end: offset + line.length });
    }
    offset += raw.length + 1;
  }
  if (markers.length && (markers.length !== 2 || markers[0].line !== START || markers[1].line !== END)) {
    return { malformed: 'interaction-malformed-markers' };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = renderBlock(eol);
  if (markers.length) return { content: text.slice(0, markers[0].start) + block + text.slice(markers[1].end) };
  const padding = !text || text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
  return { content: text + padding + block + eol };
}

function mergePendingQuestions(previous, questions) {
  if (!Array.isArray(previous) || !Array.isArray(questions)) throw new Error('pending-questions-invalid');
  const rows = new Map(previous.map(q => [q.id, { ...q }]));
  for (const value of questions) {
    const q = typeof value === 'string' ? { id: require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 24), question: value } : value;
    if (!q || typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question.trim()) throw new Error('pending-question-identity-required');
    const old = rows.get(q.id);
    if (old && old.question !== q.question) throw new Error('pending-question-identity-conflict');
    if (!old) rows.set(q.id, { id: q.id, question: q.question, status: 'pending' });
  }
  return [...rows.values()];
}
function resolvePendingQuestions(questions, answers) {
  if (!Array.isArray(answers) || !answers.length) throw new Error('pending-explicit-answers-required');
  const rows = mergePendingQuestions(questions, []), seen = new Set();
  for (const answer of answers) {
    const question = rows.find(q => q.id === answer?.id);
    if (!question || seen.has(answer.id) || typeof answer.answer !== 'string' || !answer.answer.trim()) throw new Error('pending-answer-id-required');
    if (question.status === 'resolved' && question.answer !== answer.answer) throw new Error('pending-answer-conflict');
    seen.add(answer.id); question.status = 'resolved'; question.answer = answer.answer;
  }
  return rows;
}
function persistQuestionState(file, identity, questions, answers = []) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('pending-question-path-link');
  const hash = require('./forge-code-roots').digest(identity);
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema_version: 1, identity_sha256: hash, questions: [] };
  if (old.schema_version !== 1 || old.identity_sha256 !== hash) throw new Error('pending-question-scope-mismatch');
  let rows = mergePendingQuestions(old.questions, questions);
  if (answers.length) rows = resolvePendingQuestions(rows, answers);
  const next = { ...old, questions: rows };
  require('./forge-surgical-reset').writeJsonAtomic(file, next);
  return rows;
}
const QUESTION_ROUND_OUTCOMES = Object.freeze(['presented', 'handle-accepted', 'closed-unanswered', 'cancelled', 'empty', 'timeout', 'answered']);
function recordQuestionRound(file, identity, round, limit) {
  if (!fs.existsSync(file)) throw new Error('pending-question-state-required');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('pending-question-path-link');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (old.schema_version !== 1 || old.identity_sha256 !== require('./forge-code-roots').digest(identity)) throw new Error('pending-question-scope-mismatch');
  if (!round || !QUESTION_ROUND_OUTCOMES.includes(round.outcome) || !Array.isArray(round.ids) || !round.ids.length
      || new Set(round.ids).size !== round.ids.length || !require('./forge-attempt-telemetry').code(round.channel)) throw new Error('pending-question-round-invalid');
  for (const id of round.ids) {
    const q = old.questions.find(row => row.id === id);
    if (!q || round.outcome === 'answered' && q.status !== 'resolved') throw new Error('pending-question-round-id-invalid');
  }
  if (old.rounds !== undefined && (!Array.isArray(old.rounds) || old.rounds.length > 64)
      || old.rounds_dropped !== undefined && (!Number.isSafeInteger(old.rounds_dropped) || old.rounds_dropped < 0)) throw new Error('pending-question-round-invalid');
  const next = boundedRoundState(old, round, limit);
  require('./forge-surgical-reset').writeJsonAtomic(file, next);
  return next.rounds;
}
// Serialized size is part of the contract: every later read enforces the limit,
// so trim the oldest rounds (counted in rounds_dropped) or refuse before writing.
function boundedRoundState(old, round, limit = 256 * 1024) {
  let rounds = [...(old.rounds || []), { ids: [...round.ids], channel: round.channel, outcome: round.outcome }];
  let dropped = Math.max(0, rounds.length - 64);
  rounds = rounds.slice(-64);
  const build = () => ({ ...old, rounds, rounds_dropped: (old.rounds_dropped || 0) + dropped });
  while (Buffer.byteLength(JSON.stringify(build())) > limit) {
    if (rounds.length <= 1) throw new Error('pending-question-state-too-large');
    rounds = rounds.slice(1); dropped++;
  }
  return build();
}

// This factory is an embedding boundary for a live host adapter. Imported
// consent/flags are never callbacks and never resolve functional questions.
function createRecoveryAuthorizationAdapter(attestAuthorization, dependencies = {}) {
  if (typeof attestAuthorization !== 'function') throw new Error('recovery-host-attestation-required');
  return require('./forge-recovery-authority').createRecoveryAuthority({ ...dependencies, attestAuthorization });
}
module.exports = { START, END, contract, renderBlock, project, sync, mergePendingQuestions, resolvePendingQuestions, persistQuestionState, QUESTION_ROUND_OUTCOMES, recordQuestionRound, boundedRoundState, createRecoveryAuthorizationAdapter };
