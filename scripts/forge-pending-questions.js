#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { digest } = require('./forge-code-roots');
const { code, dispatchCode } = require('./forge-attempt-telemetry');
const ids = require('./forge-ids');
const { plainText } = require('./forge-sidecar-identity');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const { withOwnerLock } = require('./forge-artifact-reconciliation');
const { mergePendingQuestions, resolvePendingQuestions, persistQuestionState, recordQuestionRound } = require('./forge-interaction');
const { CHANNELS } = require('./forge-question-channel');
const MAX_STATE = 256 * 1024;
function fail(reason) { throw Object.assign(new Error(reason), { code: reason }); }

// Reject redirected components before resolving; absence is permitted only for
// the suffix being created under the already existing owner scope.
function noLinks(file, missing = false) {
  let cursor = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('pending-question-path-link'); }
    catch (error) { if (!(missing && error.code === 'ENOENT')) throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function readJson(file, limit = MAX_STATE, withBytes = false) {
  try {
    noLinks(file);
    const real = fs.realpathSync.native(file);
    const read = readBoundedStableFile(file, limit, { expectedReal: real });
    if (read.error) fail(read.error === 'source_too_large' ? 'pending-question-source-too-large' : 'pending-question-source-unreadable');
    try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)); return withBytes ? { value, buffer: read.buffer } : value; }
    catch { fail('pending-question-json-invalid'); }
  } catch (error) { if (error.code?.startsWith('pending-')) throw error; fail('pending-question-source-unreadable'); }
}
function ownerRoot(options, writing = false) {
  const absolute = path.resolve(options.cwd || '.');
  try {
    noLinks(absolute);
    const owner = fs.realpathSync.native(absolute), forge = path.join(owner, '.gsd/forge');
    noLinks(forge);
    if (!fs.lstatSync(forge).isDirectory()) fail('pending-question-owner-missing');
    noLinks(path.join(forge, 'questions'), true);
    return owner;
  } catch (error) {
    if (error.code?.startsWith('pending-')) throw error;
    if (writing) fail('pending-question-owner-missing');
    return null;
  }
}
function validCode(value) { return typeof value === 'string' && code(value) === value && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..'); }
function shortId(value, prefix) { return typeof value === 'string' && new RegExp(`^${prefix}\\d{2,}$`).test(value) && ids.isValid(`M${value.slice(1)}`); }
function bindingIdentity(options, origin, receipt = {}) {
  const unit = options.unit;
  if (!validCode(unit) || !/^[a-z][a-z0-9-]*\//.test(unit)) fail('pending-question-unit-invalid');
  const milestone = options.milestone ?? null, slice = options.slice ?? null, task = options.task ?? null, workflow = options.workflow_id ?? options.workflow ?? null;
  if (milestone !== null && (!ids.isValid(milestone) || ids.entityKind(milestone) !== 'milestone')
      || slice !== null && !shortId(slice, 'S') || task !== null && !(shortId(task, 'T') || ids.isValid(task) && ids.entityKind(task) === 'task')
      || workflow !== null && !ids.isValid(workflow)) fail('pending-question-scope-invalid');
  if (task && unit.startsWith('execute-task/') && unit.split('/')[1] !== task) fail('pending-question-origin-mismatch');
  if (origin !== 'owner' && (!['ready', 'failed'].includes(receipt.phase) || !dispatchCode(receipt.dispatch_id) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint || ''))) fail('pending-question-origin-invalid');
  const decisionSet = origin === 'owner' ? options.decision_set : null;
  if (origin === 'owner' && !validCode(decisionSet)) fail('pending-question-decision-set-invalid');
  // Order is part of the digest contract. Never hash prose, model or S03 view.
  return { schema_version: 1, origin, unit, milestone, slice, task, workflow_id: workflow,
    dispatch_id: origin === 'owner' ? null : receipt.dispatch_id,
    request_fingerprint: origin === 'owner' ? null : receipt.fingerprint,
    receipt_phase: origin === 'owner' ? null : receipt.phase, decision_set: decisionSet };
}
function statePaths(owner, hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('pending-question-identity-invalid');
  const directory = path.join(owner, '.gsd/forge/questions');
  return { directory, file: path.join(directory, `${hash}.json`), origin: path.join(directory, `${hash}.origin.json`) };
}
function loadState(owner, hash) {
  const files = statePaths(owner, hash), originRead = readJson(files.origin, MAX_STATE, true), origin = originRead.value, state = readJson(files.file);
  if (origin?.schema_version !== 1 || !origin.identity || origin.identity_sha256 !== hash || digest(origin.identity) !== hash
      || state?.schema_version !== 1 || state.identity_sha256 !== hash || !Array.isArray(state.questions)) fail('pending-question-scope-mismatch');
  const identity = origin.identity;
  const rebuilt = bindingIdentity(identity, identity.origin, { dispatch_id: identity.dispatch_id, fingerprint: identity.request_fingerprint, phase: identity.receipt_phase });
  if (JSON.stringify(rebuilt) !== JSON.stringify(identity) || !['owner', 'worker'].includes(identity.origin)) fail('pending-question-origin-invalid');
  const seen = new Set();
  for (const row of state.questions) {
    if (!row || !validCode(row.id) || seen.has(row.id) || typeof row.question !== 'string' || !row.question.trim()
        || !['pending', 'resolved'].includes(row.status) || row.status === 'resolved' && (typeof row.answer !== 'string' || !row.answer.trim())) fail('pending-question-state-invalid');
    seen.add(row.id);
  }
  if (state.rounds !== undefined && (!Array.isArray(state.rounds) || state.rounds.length > 64
      || state.rounds.some(round => !round || !Array.isArray(round.ids) || !round.ids.length || new Set(round.ids).size !== round.ids.length
        || round.ids.some(id => !seen.has(id) || round.outcome === 'answered' && state.questions.find(q => q.id === id).status !== 'resolved') || !CHANNELS.includes(round.channel)
        || !require('./forge-interaction').QUESTION_ROUND_OUTCOMES.includes(round.outcome)))
      || state.rounds_dropped !== undefined && (!Number.isSafeInteger(state.rounds_dropped) || state.rounds_dropped < 0)) fail('pending-question-state-invalid');
  return { ...files, identity, state, origin_bytes: originRead.buffer };
}
function normalizedQuestions(questions) {
  const rows = mergePendingQuestions([], questions);
  if (rows.some(row => !validCode(row.id))) fail('pending-question-identity-invalid');
  return rows;
}
function persist(owner, identity, questions) {
  const hash = digest(identity), files = statePaths(owner, hash);
  return withOwnerLock(owner, () => {
    ownerRoot({ cwd: owner }, true); noLinks(files.directory, true);
    let existing;
    if (fs.existsSync(files.file) || fs.existsSync(files.origin)) existing = loadState(owner, hash);
    const originBytes = JSON.stringify({ schema_version: 1, identity_sha256: hash, identity }) + '\n';
    if (existing && !existing.origin_bytes.equals(Buffer.from(originBytes))) fail('pending-question-origin-mismatch');
    const rows = mergePendingQuestions(existing?.state.questions || [], questions);
    if (Buffer.byteLength(JSON.stringify({ ...(existing?.state || { schema_version: 1, identity_sha256: hash }), questions: rows })) > MAX_STATE - 32768) fail('pending-question-state-too-large');
    if (existing && JSON.stringify(rows) === JSON.stringify(existing.state.questions)) return { identity_sha256: hash, identity, questions: rows, status: rows.some(q => q.status === 'pending') ? 'pending' : 'resolved' };
    if (!fs.existsSync(files.directory)) fs.mkdirSync(files.directory, { recursive: false });
    if (!fs.lstatSync(files.directory).isDirectory()) fail('pending-question-path-invalid');
    if (!existing) {
      noLinks(files.origin, true);
      fs.writeFileSync(files.origin, originBytes, { flag: 'wx', mode: 0o600 });
    }
    persistQuestionState(files.file, identity, questions);
    return { identity_sha256: hash, identity, questions: rows, status: rows.some(q => q.status === 'pending') ? 'pending' : 'resolved' };
  });
}
function openQuestions(options) {
  const owner = ownerRoot(options, true), identity = bindingIdentity(options, 'owner');
  const questions = normalizedQuestions(options.questions);
  if (!questions.length) return { status: 'none', reason: 'no-structured-questions' };
  return persist(owner, identity, questions);
}
function checkScope(source, identity) {
  if (!source || typeof source !== 'object') return;
  for (const key of ['unit', 'milestone', 'slice', 'task', 'workflow_id']) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== identity[key]) fail('pending-question-origin-mismatch');
  }
  // Recovery request identities use the same explicit *_id names in some units.
  for (const key of ['milestone', 'slice', 'task']) if (source[`${key}_id`] !== undefined && source[`${key}_id`] !== identity[key]) fail('pending-question-origin-mismatch');
}
function agentLink(owner, identity) {
  try {
    const { readAgentSources, deriveAgentView } = require('./forge-agent-view');
    const view = deriveAgentView(readAgentSources({ cwd: owner, filter: { type: 'unit', id: identity.unit } }), { now: Date.now() });
    const agent = view.agents.find(row => row.dispatch_id === identity.dispatch_id);
    return agent ? { status: 'linked', kind: agent.kind, host: agent.host_runtime, transport: agent.transport,
      identity: agent.identity, provenance: { dispatch_id: identity.dispatch_id, events: view.sources.events.reference } }
      : { status: 'unlinked', reason: view.empty_reason || 'dispatch-not-found' };
  } catch { return { status: 'unlinked', reason: 'agent-sources-unreadable' }; }
}
function handoff(options) {
  const owner = ownerRoot(options, true), receiptFile = path.resolve(options.receipt || '');
  const receipt = readJson(receiptFile, 8 * 1024 * 1024);
  if (!receipt || !['ready', 'failed'].includes(receipt.phase) || receipt.phase === 'ready' && !['partial', 'blocked'].includes(receipt.result?.status)) fail('pending-question-unit-open');
  const identity = bindingIdentity(options, 'worker', receipt);
  checkScope(receipt, identity); checkScope(receipt.preparation_identity, identity);
  let recovery;
  if (options.recovery_state) {
    recovery = readJson(path.resolve(options.recovery_state), 1024 * 1024);
    require('./forge-attempt-recovery').validateState(recovery);
    if (recovery.unit !== identity.unit || !recovery.attempts.some(row => typeof row.receipt === 'string' && path.resolve(row.receipt) === receiptFile)) fail('pending-question-origin-mismatch');
    checkScope(recovery.request_identity, identity);
  }
  const raw = receipt.phase === 'ready' ? receipt.pending_questions ?? receipt.result.questions ?? [] : recovery?.pending_questions || [];
  const questions = normalizedQuestions(raw);
  if (!questions.length) return { status: 'none', reason: 'no-structured-questions', agent_link: agentLink(owner, identity) };
  return { ...persist(owner, identity, questions), agent_link: agentLink(owner, identity) };
}
function mutate(options, callback) {
  const owner = ownerRoot(options, true);
  return withOwnerLock(owner, () => { ownerRoot({ cwd: owner }, true); return callback(loadState(owner, options.identity)); });
}
function recordRound(options) {
  if (!CHANNELS.includes(options.channel)) fail('pending-question-channel-invalid');
  return mutate(options, loaded => ({ ok: true, rounds: recordQuestionRound(loaded.file, loaded.identity, { ids: options.ids, channel: options.channel, outcome: options.outcome }) }));
}
function answer(options) {
  return mutate(options, loaded => {
    const answers = options.answers;
    if (!Array.isArray(answers) || !answers.length) fail('pending-explicit-answers-required');
    for (const row of answers) {
      if (!row || !['user-text', 'tool-answer'].includes(row.source)) fail('pending-answer-source-invalid');
      if (Object.keys(row).some(key => !['id', 'answer', 'source'].includes(key))) fail('pending-answer-fields-invalid');
    }
    const channel = options.channel || 'text-fallback';
    if (!CHANNELS.includes(channel)) fail('pending-question-channel-invalid');
    // Validate every answer and round before either write: a partial invalid
    // request must leave all state bytes untouched.
    const resolved = resolvePendingQuestions(loaded.state.questions, answers);
    if (Buffer.byteLength(JSON.stringify({ ...loaded.state, questions: resolved })) > MAX_STATE - 32768) fail('pending-question-state-too-large');
    if (loaded.state.rounds_dropped !== undefined && (!Number.isSafeInteger(loaded.state.rounds_dropped) || loaded.state.rounds_dropped < 0)) fail('pending-question-round-invalid');
    const questions = persistQuestionState(loaded.file, loaded.identity, [], answers);
    recordQuestionRound(loaded.file, loaded.identity, { ids: answers.map(row => row.id), channel, outcome: 'answered' });
    return { ok: true, identity_sha256: options.identity, pending_ids: questions.filter(q => q.status === 'pending').map(q => q.id) };
  });
}
function continuation(options) {
  const owner = ownerRoot(options, true), loaded = loadState(owner, options.identity);
  const pending_ids = loaded.state.questions.filter(q => q.status === 'pending').map(q => q.id);
  return pending_ids.length ? { ok: false, reason: 'pending-questions', pending_ids }
    : { ok: true, identity: loaded.identity, questions: loaded.state.questions };
}
function listPendingQuestions(options = {}) {
  const filter = options.filter;
  if (!filter || !['personal', 'milestone', 'workflow', 'unit'].includes(filter.type) || filter.type !== 'personal' && !validCode(filter.id)) fail('pending-question-scope-required');
  let works = [], emptyReason = null;
  if (filter.type === 'personal') {
    const snapshot = require('./forge-personal-context').readPersonalSnapshot(options);
    works = (snapshot.works || []).map(row => row.id).filter(id => ids.isValid(id));
    if (snapshot.status !== 'ok' || !works.length) emptyReason = snapshot.reason || 'no-bindings';
  }
  const census = { total: 0, invalid: 0, foreign: 0, excess: 0 }, questions = [];
  const owner = ownerRoot(options), base = { schema_version: 1, scope: filter, questions, census, empty_reason: emptyReason };
  if (!owner || emptyReason) return { ...base, empty_reason: emptyReason || 'owner-missing' };
  const directory = path.join(owner, '.gsd/forge/questions');
  let entries;
  try { noLinks(directory); entries = fs.readdirSync(directory).sort(); }
  catch (error) { return { ...base, empty_reason: error.code === 'ENOENT' ? 'no-questions' : 'questions-unreadable' }; }
  const states = entries.filter(name => !name.endsWith('.origin.json'));
  // Each entry needs two independent bounded reads (state and immutable origin).
  // Sixty-four pairs stay within the total128-file observation ceiling.
  census.total = states.length; census.excess = Math.max(0, states.length - 64);
  for (const name of states.slice(0, 64)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) { census.invalid++; continue; }
    let loaded;
    try { loaded = loadState(owner, name.slice(0, -5)); } catch { census.invalid++; continue; }
    const identity = loaded.identity;
    const match = filter.type === 'personal' ? works.some(id => identity.workflow_id === id || identity.milestone === id)
      : filter.type === 'milestone' ? identity.milestone === filter.id
        : filter.type === 'workflow' ? identity.workflow_id === filter.id : identity.unit === filter.id;
    if (!match) { census.foreign++; continue; }
    for (const row of loaded.state.questions) {
      const last = (loaded.state.rounds || []).filter(round => Array.isArray(round.ids) && round.ids.includes(row.id)).at(-1);
      questions.push({ id: row.id, question: plainText(row.question, { missing: '', limit: 240 }), status: row.status,
        answered: row.status === 'resolved', origin: identity,
        last_round: last ? { ids: last.ids.filter(id => typeof id === 'string').map(id => plainText(id, { limit: 120 })), channel: CHANNELS.includes(last.channel) ? last.channel : 'unknown',
          outcome: require('./forge-interaction').QUESTION_ROUND_OUTCOMES.includes(last.outcome) ? last.outcome : 'unknown' } : null });
    }
  }
  return { ...base, empty_reason: questions.length ? null : 'no-matching-questions' };
}
function main(argv = process.argv.slice(2), io = process) {
  const options = {}; let action, json = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (['--open', '--handoff', '--round', '--answer', '--continuation', '--list'].includes(flag)) { if (action) fail('pending-question-usage'); action = flag; }
      else if (flag === '--json') json = true;
      else if (flag === '--personal') { if (options.filter) fail('pending-question-usage'); options.filter = { type: 'personal' }; }
      else {
        if (!['--cwd', '--unit', '--set', '--questions', '--receipt', '--recovery-state', '--milestone', '--slice', '--task', '--workflow', '--identity', '--ids', '--channel', '--outcome', '--answers'].includes(flag)
            || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('pending-question-usage');
        const value = argv[++i], key = flag.slice(2).replace(/-/g, '_');
        if (action === '--list' && ['unit', 'milestone', 'workflow'].includes(key)) { if (options.filter) fail('pending-question-usage'); options.filter = { type: key, id: value }; }
        else if (key === 'set') options.decision_set = value;
        else if (key === 'ids') options.ids = value.split(',');
        else options[key] = value;
      }
    }
    if (!action) fail('pending-question-usage');
    if (action === '--open') options.questions = readJson(options.questions);
    if (action === '--answer') options.answers = readJson(options.answers);
    const result = ({ '--open': openQuestions, '--handoff': handoff, '--round': recordRound, '--answer': answer, '--continuation': continuation, '--list': listPendingQuestions })[action](options);
    io.stdout.write(json ? JSON.stringify(result) + '\n' : `Decisões: ${JSON.stringify(result)}\n`);
    return result.ok === false ? 3 : 0;
  } catch (error) {
    const reason = error.code?.startsWith('pending-') ? error.code : error.message?.startsWith('pending-') ? error.message : 'pending-question-input-invalid';
    io.stderr.write(json ? JSON.stringify({ ok: false, reason }) + '\n' : `Decisão pendente ou entrada recusada: ${reason}\n`);
    const refusal = /^pending-(?:explicit-answers-required|answer-(?:id-required|conflict|source-invalid|fields-invalid)|question-(?:unit-open|origin-mismatch|scope-mismatch|round-id-invalid))$/.test(reason);
    return refusal ? 3 : 2;
  }
}
module.exports = { openQuestions, handoff, answer, recordRound, continuation, listPendingQuestions, main };
if (require.main === module) process.exitCode = main();
