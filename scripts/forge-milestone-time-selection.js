#!/usr/bin/env node
'use strict';

// Milestone time selection cycle (S02/T03): the read-only state consumed by the
// controller, the owner's safe boundary (materialization, render and delegated
// allocation), the persisted decision rounds, the attested selection/activation,
// the plan-milestone prompt block, the roadmap acceptance rule and the
// continuation check. Import is inert: only core modules load here and every local
// dependency is required lazily (the controller will require this module).
// Authority comes only from the trusted host's live opaque handles verified by the
// T01 mutators; persisted JSON, flags and prompt text never decide.
const fs = require('fs');
const path = require('path');

const TIME_OPTION_REASON_CODES = Object.freeze(['time-options-invalid', 'time-roadmap-nonconformant', 'time-allocation-pending', 'time-scope-unallocated']);
const TIME_OPTION_RESUME_CODES = Object.freeze(['time-option-ready', 'time-option-resume-invalid']);
const SELECTION_STATUSES = Object.freeze(['estimate-required', 'materialization-required', 'decision-pending', 'options-invalid', 'activation-pending', 'decided', 'roadmap-preexisting']);
const ROADMAP_STATUSES = Object.freeze(['conformant', 'allocation-pending', 'nonconformant', 'scope-unallocated']);
const ESTIMATE_UNIT = 'estimate-milestone', PRODUCER = 'estimate-milestone';
const BASIS_POLICY = 'forge-milestone-estimate-basis-v1', CODE_ROOT_POLICY = 'forge-milestone-code-root-v1';
const SUFFIX_LENGTH = 24, MAX_INPUT_BYTES = 1024 * 1024, MAX_ROADMAP_BYTES = 256 * 1024, MAX_BLOCK_BYTES = 8 * 1024, MAX_CODE_FILES = 256, MAX_ROUNDS = 16;
const DOCUMENTS = Object.freeze(['SCOPE', 'CONTEXT', 'BRAINSTORM']);
const HASH = /^[a-f0-9]{64}$/, SUFFIX = /^[a-f0-9]{24}$/;
// Prompt envelopes and procedure markers never reach a round or the prompt block.
const MARKER = /\[\s*(?:END\s+)?DATA\b|DATA FROM|forge-procedure/gi;
const ACTIVATION_SET = 'milestone-time-activation', LINKED_SET = 'milestone-time-linked-task';
const KIND_LABELS = Object.freeze({ preparation: 'preparação', slice: 'fatia', integration: 'integração', review: 'revisão', corrections: 'correções' });
const ITEM_LABELS = Object.freeze({ publication: 'Publicação', installation: 'Instalação', 'manual-uat': 'UAT manual', 'external-waits': 'Esperas externas' });
const STATE_LABELS = Object.freeze({ included: 'incluído', pending: 'pendente', completed: 'concluído', deferred: 'adiado', 'not-applicable': 'não se aplica' });
const NO_ENROLLMENT_BLOCK = 'Sem seleção de prazo: milestone sem adesão ao fluxo de opções; nenhuma seção ## Alocação de tempo é exigida.';

function fail(code, extra) { throw Object.assign(new Error(code), { code }, extra || {}); }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function hash(v) { return typeof v === 'string' && HASH.test(v); }
function ms(v) { return Number.isSafeInteger(v) && v > 0; }
function iso(v) { return new Date(v).toISOString(); }
function codeOf(e, fallback) { return typeof e?.code === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(e.code) ? e.code : fallback; }
function time() { return require('./forge-milestone-time'); }
function offers() { return require('./forge-milestone-options'); }
function rt() { return require('./forge-milestone-roadmap-time'); }
function questions() { return require('./forge-pending-questions'); }
function controller() { return require('./forge-unit-controller'); }
function digest(v) { return require('./forge-code-roots').digest(v); }
function canonical(v) { return rt().canonical(v); }
function same(a, b) { return digest(canonical(a ?? null)) === digest(canonical(b ?? null)); }
function milestoneId(v) {
  const ids = require('./forge-ids');
  return typeof v === 'string' && !/[\\/\0]/.test(v) && ids.isValid(v) && ids.entityKind(v) === 'milestone';
}
function noLinks(file, missing = false) {
  let cursor = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('time-path-link'); }
    catch (e) { if (!(missing && e.code === 'ENOENT')) throw e; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
// The physical owner is contextRoot (or workingDir) when a request carries it: a
// request whose cwd is CODE_DIR never makes the code checkout the artifact owner.
function ownerRoot(input) {
  const candidate = typeof input === 'string' ? input : object(input) ? input.contextRoot ?? input.workingDir ?? input.cwd : null;
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) fail('time-owner-invalid');
  const resolved = path.resolve(candidate); noLinks(resolved);
  const real = fs.realpathSync.native(resolved);
  if (!fs.statSync(real).isDirectory()) fail('time-owner-invalid');
  return real;
}
// Canonical bounded and stable reader; null only when the file is absent.
function readBounded(file, max) {
  noLinks(file, true);
  let stat; try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!stat.isFile()) fail('time-source-unreadable');
  if (stat.size > max) fail('time-source-too-large');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, max, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail(read.error === 'source_too_large' ? 'time-source-too-large' : 'time-source-unstable');
  return read.buffer;
}
function decode(buffer) { try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { fail('time-source-encoding-invalid'); } }

// ---------------------------------------------------------------------------
// Producer basis: owner-captured inputs frozen before the estimate begin
// ---------------------------------------------------------------------------
function documentPaths(milestone) { return [...DOCUMENTS.map(k => '.gsd/milestones/' + milestone + '/' + milestone + '-' + k + '.md'), '.gsd/REQUIREMENTS.md']; }
function fingerprint(root, relative) {
  const bytes = readBounded(path.join(root, ...relative.split('/')), MAX_INPUT_BYTES);
  return bytes === null ? digest({ policy: BASIS_POLICY, absent: relative }) : digest(bytes);
}
// Investigated code is captured by the owner on the validated physical root, never
// taken from the worker proposal. Only relative paths and digests are persisted.
function codeBasis(owner, code = {}) {
  if (!object(code)) fail('time-inputs-invalid');
  const roots = require('./forge-code-roots');
  let real; try { real = roots.realDirectory(path.resolve(code.root ?? owner)); } catch { fail('time-inputs-invalid'); }
  noLinks(real);
  const stat = fs.statSync(real, { bigint: true });
  const physical = digest({ policy: CODE_ROOT_POLICY, physical_path: roots.key(real), dev: String(stat.dev), ino: String(stat.ino) });
  // A supplied identity is only accepted when it equals a value re-measured NOW on this physical
  // root (the canonical forge-code-roots identity, or the plain physical digest): repeating a
  // serialized hash never proves it, so a redirected or foreign root fails closed.
  let identity = physical;
  if (code.identity_sha256 !== undefined && code.identity_sha256 !== null) {
    let canonicalRoot = null; try { canonicalRoot = roots.measureRoot({ id: 'code', path: real }).identity_sha256; } catch { /* not a measurable checkout */ }
    if (!hash(code.identity_sha256) || code.identity_sha256 !== physical && code.identity_sha256 !== canonicalRoot) fail('time-inputs-invalid');
    identity = code.identity_sha256;
  }
  const revision = code.revision ?? 'unversioned', workspace = code.workspace ?? 'primary', files = code.files ?? [];
  const label = v => typeof v === 'string' && v.trim() && v.length <= 200 && time().isPublicData(v);
  if (!label(revision) || !label(workspace) || !Array.isArray(files) || files.length > MAX_CODE_FILES) fail('time-inputs-invalid');
  let relatives; try { relatives = [...new Set(files.map(f => roots.assertRelative(f)))].sort(); } catch { fail('time-inputs-invalid'); }
  return { real, identity, physical, revision, workspace, relatives };
}
function captureInputs(owner, milestone, basis) {
  return canonical({ documents: documentPaths(milestone).map(p => ({ path: p, sha256: fingerprint(owner, p) })),
    code_root: { identity_sha256: basis.identity, revision: basis.revision, workspace: basis.workspace },
    code_files: basis.relatives.map(p => ({ path: p, sha256: fingerprint(basis.real, p) })) });
}
// The investigated code context is a private owner descriptor written at materialization,
// bound to the exact stored record, its frozen producer basis and the code root identity.
// Readers only recapture CURRENT hashes from the described physical root; they never
// create or repair it, and an unusable one never falls back to the owner root.
function codeContextFile(owner, milestone, optionsSha) { return path.join(owner, '.gsd/forge/time-code-context', milestone + '-' + optionsSha + '.json'); }
function codeContextBytes(milestone, bound, basis) {
  return Buffer.from(JSON.stringify({ schema_version: 1, policy: CODE_ROOT_POLICY, milestone, options_sha256: bound.options_sha256, producer_identity_sha256: bound.producer_identity_sha256,
    root: basis.real, identity_sha256: basis.identity, identity_source: basis.identity === basis.physical ? 'physical' : 'supplied', revision: basis.revision, workspace: basis.workspace }, null, 2) + '\n', 'utf8');
}
function recoverCode(owner, milestone, head) {
  const recorded = head.record.inputs, root = recorded.code_root, producer = head.record.producer_basis.identity_sha256;
  let raw; try { raw = readBounded(codeContextFile(owner, milestone, head.options_sha256), 16 * 1024); } catch { fail('time-code-context-invalid'); }
  if (raw === null) {
    // Without a descriptor only the owner-root basis with no investigated files is recoverable.
    const own = codeBasis(owner, { revision: root.revision, workspace: root.workspace });
    if (recorded.code_files.length || own.identity !== root.identity_sha256) fail('time-code-context-missing');
    return { revision: root.revision, workspace: root.workspace };
  }
  let d; try { d = JSON.parse(decode(raw)); } catch { fail('time-code-context-invalid'); }
  const keys = ['identity_source', 'identity_sha256', 'milestone', 'options_sha256', 'policy', 'producer_identity_sha256', 'revision', 'root', 'schema_version', 'workspace'].sort();
  if (!object(d) || Object.keys(d).sort().join() !== keys.join() || d.schema_version !== 1 || d.policy !== CODE_ROOT_POLICY || d.milestone !== milestone
      || d.options_sha256 !== head.options_sha256 || d.producer_identity_sha256 !== producer || d.identity_sha256 !== root.identity_sha256
      || d.revision !== root.revision || d.workspace !== root.workspace || !['physical', 'supplied'].includes(d.identity_source) || typeof d.root !== 'string') fail('time-code-context-invalid');
  const supplied = d.identity_source === 'supplied' ? d.identity_sha256 : undefined;
  let basis; try { basis = codeBasis(owner, { root: d.root, identity_sha256: supplied, revision: d.revision, workspace: d.workspace }); } catch { fail('time-code-context-invalid'); }
  if (basis.identity !== root.identity_sha256 || !supplied && basis.physical !== root.identity_sha256) fail('time-code-context-invalid');
  // The investigated file set is the recorded one; hashes are always recaptured from the actual files.
  return { root: d.root, identity_sha256: supplied, revision: d.revision, workspace: d.workspace, files: recorded.code_files.map(f => f.path) };
}
function basisIdentity(milestone, inputs, previous) {
  return digest(canonical({ policy: BASIS_POLICY, milestone, inputs: canonical(inputs), previous_options_sha256: previous ?? null }));
}
// Accepts a basis {milestone, inputs, previous_options_sha256} or its identity digest.
function estimateKeySuffix(basis) {
  const identity = typeof basis === 'string' ? basis : object(basis) && milestoneId(basis.milestone) && object(basis.inputs)
    ? basisIdentity(basis.milestone, basis.inputs, basis.previous_options_sha256 ?? null) : null;
  if (!hash(identity)) fail('time-estimate-key-invalid');
  return identity.slice(0, SUFFIX_LENGTH);
}
// Equal to the orchestrate legacy key of estimate-milestone/<M> plus ":" and the suffix.
function estimateBeginKey(milestone, suffix) {
  if (!milestoneId(milestone) || typeof suffix !== 'string' || !SUFFIX.test(suffix)) fail('time-estimate-key-invalid');
  return 'forge-orchestrate-next:' + milestone + ':' + ESTIMATE_UNIT + '/' + milestone + ':' + suffix;
}
// Real committed begin and successful complete of the estimate unit for this key.
function producerProof(owner, milestone, suffix) {
  const c = controller(), key = estimateBeginKey(milestone, suffix), unit = ESTIMATE_UNIT + '/' + milestone;
  const begin = c.lookupRecord(owner, 'transaction', key);
  const committed = (r, action) => !!r && r.action === action && r.phase === 'committed' && r.milestone === milestone && r.unit?.key === unit;
  if (!begin) return { status: 'absent', key };
  if (!committed(begin, 'begin')) return { status: 'open', key };
  const complete = c.lookupRecord(owner, 'transaction', key + ':complete');
  if (!committed(complete, 'complete') || complete.result?.status !== 'succeeded') return { status: 'open', key };
  return { status: 'complete', key, frozen_at: begin.created_at };
}
// Only records whose frozen producer basis matches a real committed estimate are
// proposals; the head is the latest one no other proven record names as predecessor.
function proposalChain(owner, milestone) {
  const listing = time().listOptions({ cwd: owner, milestone });
  if (listing.status !== 'valid') fail(listing.reason);
  const shas = listing.records.map(r => r.options_sha256), proven = [];
  for (const r of listing.records) {
    const basis = r.record.producer_basis;
    if (!object(basis) || basis.producer !== PRODUCER || !hash(basis.identity_sha256) || !object(r.record.inputs)) continue;
    const previous = [null, ...shas.filter(s => s !== r.options_sha256)].find(p => basisIdentity(milestone, r.record.inputs, p) === basis.identity_sha256);
    if (previous === undefined) continue;
    const proof = producerProof(owner, milestone, basis.identity_sha256.slice(0, SUFFIX_LENGTH));
    if (proof.status === 'complete' && proof.frozen_at === basis.frozen_at) proven.push({ ...r, previous });
  }
  const named = new Set(proven.map(r => r.previous));
  const heads = proven.filter(r => !named.has(r.options_sha256))
    .sort((a, b) => String(b.record.materialized_at).localeCompare(String(a.record.materialized_at)) || a.options_sha256.localeCompare(b.options_sha256));
  return { head: heads[0] || null, count: listing.records.length };
}
function readProposal(owner, milestone) {
  const relative = '.gsd/milestones/' + milestone + '/' + milestone + '-OPTIONS.json';
  const bytes = readBounded(path.join(owner, ...relative.split('/')), offers().MAX_PROPOSAL_BYTES);
  if (bytes === null) return { valid: false, reason: 'options-proposal-missing' };
  return offers().inspectProposalContent(decode(bytes), milestone);
}

// ---------------------------------------------------------------------------
// Decision rounds persisted in forge-pending-questions
// ---------------------------------------------------------------------------
function roundUnit(round) { return 'milestone-time/' + round.id; }
// Same field order as forge-pending-questions bindingIdentity for an owner question.
function roundIdentity(milestone, round) {
  return digest({ schema_version: 1, origin: 'owner', unit: roundUnit(round), milestone, slice: null, task: null, workflow_id: null,
    dispatch_id: null, request_fingerprint: null, receipt_phase: null, decision_set: round.decision_set });
}
function roundQuestion(owner, milestone, round) {
  const identity = roundIdentity(milestone, round), file = path.join(owner, '.gsd/forge/questions', identity + '.json');
  noLinks(file, true);
  if (!fs.existsSync(file)) return { identity_sha256: identity, question_id: round.id, opened: false, answered: false, answer: null };
  const state = questions().continuation({ cwd: owner, identity });
  if (!state.ok) return { identity_sha256: identity, question_id: round.id, opened: true, answered: false, answer: null };
  const row = state.questions.find(q => q.id === round.id);
  if (!row || state.identity?.milestone !== milestone || state.identity.decision_set !== round.decision_set) fail('time-option-round-invalid');
  // The bounded listing (first 64 states) only adds the round outcome when present;
  // the explicit answer itself always comes from this question's own state.
  const listed = questions().listPendingQuestions({ cwd: owner, filter: { type: 'unit', id: roundUnit(round) } });
  const last = listed.questions.find(q => q.id === round.id && q.origin?.decision_set === round.decision_set)?.last_round;
  return { identity_sha256: identity, question_id: round.id, opened: true, answered: row.status === 'resolved' && (!last || last.outcome === 'answered'), answer: row.answer ?? null };
}
function confirmRound(head) {
  return { id: 'time-confirm-' + head.options_sha256.slice(0, 12), type: 'confirm', decision_set: ACTIVATION_SET, header: 'Confirmação',
    question: 'Você escolheu seguir sem contrato de tempo depois de recusar a task ligada. Confirma que nenhum contrato será ativado?',
    options: [{ label: 'Confirmar sem contrato', description: 'Segue sem contrato de tempo; nada é ativado e o escopo movido não é reduzido por esta resposta.', answer: 'no-contract' },
      { label: 'Reestimar', description: 'Não confirma a ausência de contrato: pede nova estimativa com o escopo completo; nada é ativado e nenhuma autorização é concedida.', answer: 're-estimate' }] };
}
// Replays persisted explicit answers through the pure T02 rounds until the next
// unanswered round or the outcome. Nothing is inferred from silence.
function roundState(owner, milestone, head) {
  const answered = {}, seen = [];
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const step = offers().selectionRounds(head.record, answered);
    if (step.done) {
      // A scope-round no-contract is only intent: the activation decision needs its own round and live handle.
      if (step.choice === 'no-contract' && !step.decisions.some(d => d.decision_set === ACTIVATION_SET && d.answer === 'no-contract')) {
        const confirm = confirmRound(head), asked = roundQuestion(owner, milestone, confirm);
        const offeredAnswer = asked.answered && confirm.options.some(o => o.answer === asked.answer);
        if (!offeredAnswer) return { round: asked.answered ? { ...confirm, invalid_answer: 'answer-not-offered' } : confirm, question: asked, answered, rounds: seen };
        answered[confirm.id] = asked.answer; seen.push({ round: confirm, question: asked });
        // Declining the confirmation grants nothing: it only asks for a new estimate with the full scope.
        if (asked.answer === 're-estimate') return { outcome: { ...step, choice: 're-estimate', activation_answer: null, reason: 'no-contract-not-confirmed' }, answered, rounds: seen };
      }
      return { outcome: step, answered, rounds: seen };
    }
    const question = roundQuestion(owner, milestone, step);
    if (step.invalid_answer || !question.answered) return { round: step, question, answered, rounds: seen };
    answered[step.id] = question.answer; seen.push({ round: step, question });
  }
  fail('time-option-round-limit');
}
function cleanText(value) { return String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(MARKER, '[marcador removido]'); }
function markerFree(value) { MARKER.lastIndex = 0; const found = MARKER.test(JSON.stringify(value)); MARKER.lastIndex = 0; return !found; }
function decisionOf(round, question) {
  return { id: round.id, header: round.header, question: round.question, options: round.options.map(o => ({ label: o.label, description: o.description })),
    ...(round.recommended ? { recommended: round.recommended } : {}),
    ...(round.free_text ? { free_text: true, answer_format: round.answer_format, position_id: round.position_id, minimum_ms: round.minimum_ms } : {}),
    identity_sha256: question.identity_sha256, question_id: question.question_id };
}

// ---------------------------------------------------------------------------
// Read-only state
// ---------------------------------------------------------------------------
function invalidState(milestone, reason) { return { schema_version: 1, milestone, status: 'options-invalid', code: 'time-options-invalid', reason: codeOf({ code: reason }, 'time-source-unreadable') }; }
// Persisted selection answers must still exist as resolved owner questions; the
// live handle is gone after the fact, but a file alone never looks decided.
function persistedAnswers(owner, milestone, selection) {
  try {
    return selection.decisions.every(({ kind, decision }) => {
      const state = questions().continuation({ cwd: owner, identity: decision.question.identity_sha256 });
      return state.ok && state.identity.origin === 'owner' && state.identity.milestone === milestone && state.identity.decision_set === 'milestone-time-' + kind
        && state.questions.some(q => q.id === decision.question.id && q.status === 'resolved' && q.answer === decision.answer);
    });
  } catch { return false; }
}
function expectedFor(owner, milestone, enrollment, selection, contract, offered) {
  const deferred = contract.chain.filter(r => r.kind === 'scope-reduction' && r.decision).flatMap(r => r.patch.deferred_items);
  return rt().expectedFrom({ enrollment, options: offered.record, options_sha256: offered.options_sha256, selection, contract: contract.contract,
    contract_sha256: contract.chain[0].sha256, ceiling_ms: contract.contract.ceiling_ms, deferred: [...new Set(deferred)] });
}
function allocationItems(section) { return section.allocation.map(r => ({ id: r.id, kind: r.kind, ...(r.slice ? { slice: r.slice } : {}), ms: r.ms, nodes: [...r.nodes] })); }
// Conformance is evaluated separately from the historical selection. After an
// allocation exists, any non-conformance is a later structural change.
function roadmapConformance(roadmapFile, contract, expected) {
  const allocated = contract.chain.some(r => r.kind === 'allocation');
  const refused = result => ({ status: allocated ? 'scope-unallocated' : 'nonconformant', reasons: [result.reason],
    ...(['slice', 'node', 'edge'].some(k => typeof result[k] === 'string') ? { detail: cleanText(result.slice || result.node || result.edge) } : {}) });
  let buffer, content;
  try { buffer = readBounded(roadmapFile, MAX_ROADMAP_BYTES); content = decode(buffer); } catch { return refused({ reason: 'roadmap-time-content-invalid' }); }
  const inspected = rt().inspectRoadmapContent(content), result = rt().validateRoadmap(inspected, expected);
  if (!result.valid || result.status !== 'conformant') return refused(result);
  const identity = time().roadmapIdentity(buffer), active = contract.contract.allocation;
  const current = active && active.structure_sha256 === identity.structure_sha256 && same(active.items, allocationItems(inspected.section));
  return { status: current ? 'conformant' : 'allocation-pending', total_ms: result.total_ms, ceiling_ms: result.ceiling_ms,
    roadmap_sha256: identity.sha256, structure_sha256: identity.structure_sha256 };
}
function selectedState(owner, milestone, base, enrollment, read, roadmapExists, p) {
  const s = read.selection;
  if (!persistedAnswers(owner, milestone, s)) return { state: invalidState(milestone, 'time-selection-unverified') };
  const common = { ...base, choice: s.choice, options_sha256: s.options_sha256, option_id: s.option_id, position_id: s.position_id,
    linked_task_authorization: s.linked_task_authorization, selection_sha256: read.selection_sha256, selected_at: s.selected_at };
  if (s.choice === 'no-contract') return { state: { ...common, status: 'decided', contract: null }, selection: s };
  const contract = time().readContract({ cwd: owner, milestone });
  if (contract.status === 'invalid') return { state: invalidState(milestone, contract.reason) };
  if (contract.status === 'absent') {
    return { state: { ...common, status: 'activation-pending', ...(roadmapExists ? { roadmap: { status: 'nonconformant', reasons: ['roadmap-time-preparation-pending'] } } : {}) }, selection: s, roadmapExists };
  }
  if (contract.contract.option.options_sha256 !== s.options_sha256 || contract.contract.option.id !== s.option_id) return { state: invalidState(milestone, 'time-selection-mismatch') };
  const offered = time().readOptions({ cwd: owner, milestone, options_sha256: s.options_sha256 });
  if (offered.status !== 'valid') return { state: invalidState(milestone, offered.reason || 'time-options-required') };
  const expected = expectedFor(owner, milestone, enrollment, s, contract, offered);
  const state = { ...common, status: 'decided', contract: { sha256: contract.sha256, base_sha256: contract.chain[0].sha256, version: contract.version } };
  if (roadmapExists) state.roadmap = roadmapConformance(p.roadmap, contract, expected);
  return { state, selection: s, contract, offered, expected };
}
function preselectionState(owner, milestone, base, options) {
  if (options.shallow) {
    const listing = time().listOptions({ cwd: owner, milestone });
    if (listing.status !== 'valid') return { state: invalidState(milestone, listing.reason) };
    return { state: { ...base, status: 'preselection', options_recorded: listing.records.length } };
  }
  const chain = proposalChain(owner, milestone);
  const explicit = options.code !== undefined && options.code !== null;
  const basis = codeBasis(owner, explicit ? options.code : chain.head ? recoverCode(owner, milestone, chain.head) : undefined), inputs = captureInputs(owner, milestone, basis);
  let previous = null, reason = 'no-options', changed = [], scopeReduction = null, reEstimate = null;
  if (chain.head) {
    const fresh = offers().inputsFreshness(chain.head.record, inputs);
    if (fresh.status === 'fresh') {
      const rounds = roundState(owner, milestone, chain.head);
      if (!rounds.outcome || rounds.outcome.choice !== 're-estimate') {
        const outcome = rounds.outcome && { choice: rounds.outcome.choice, option_id: rounds.outcome.option_id, position_id: rounds.outcome.position_id,
          ceiling: rounds.outcome.ceiling, activation_answer: rounds.outcome.activation_answer, linked_task_authorization: rounds.outcome.linked_task_authorization };
        return { state: { ...base, status: 'decision-pending', options_sha256: chain.head.options_sha256, round: rounds.round || null,
          question: rounds.question || null, answered_rounds: rounds.rounds.length, outcome: outcome || null }, head: chain.head, rounds };
      }
      reason = 're-estimate-requested'; scopeReduction = rounds.outcome.scope_reduction ?? null;
      const o = rounds.outcome;
      // Bounded public handoff of the T02 outcome: historical references only, never live handles or new authority.
      reEstimate = { options_sha256: chain.head.options_sha256, reason: codeOf({ code: o.reason }, 're-estimate-requested'), position_id: o.position_id ?? null,
        linked_task_authorization: o.linked_task_authorization ?? null, scope_reduction: scopeReduction,
        decisions: rounds.rounds.slice(0, MAX_ROUNDS).map(r => ({ round_id: r.round.id, type: r.round.type, decision_set: r.round.decision_set,
          answer: cleanText(rounds.answered[r.round.id]), identity_sha256: r.question.identity_sha256, question_id: r.question.question_id })) };
    } else { reason = 'inputs-changed'; changed = fresh.changed; }
    previous = chain.head.options_sha256;
  }
  const identity = basisIdentity(milestone, inputs, previous), suffix = identity.slice(0, SUFFIX_LENGTH);
  const estimate = { key_suffix: suffix, previous_options_sha256: previous, reason, changed, ...(scopeReduction ? { scope_reduction: scopeReduction } : {}), ...(reEstimate ? { re_estimate: reEstimate } : {}) };
  const proof = producerProof(owner, milestone, suffix);
  if (proof.status !== 'complete') return { state: { ...base, status: 'estimate-required', ...estimate } };
  const proposal = readProposal(owner, milestone);
  if (!proposal.valid) return { state: invalidState(milestone, proposal.reason) };
  return { state: { ...base, status: 'materialization-required', ...estimate }, materialize: { inputs, identity, frozen_at: proof.frozen_at, proposal: proposal.proposal, code: basis } };
}
function inspect(owner, milestone, options = {}) {
  const t = time(), enrollment = t.readEnrollment({ cwd: owner, milestone }), selection = t.readSelection({ cwd: owner, milestone });
  for (const read of [enrollment, selection]) if (read.status === 'invalid') return { state: invalidState(milestone, read.reason) };
  if (enrollment.status === 'absent' && selection.status === 'absent') return null;
  const p = t.timePaths({ cwd: owner, milestone }); noLinks(p.roadmap, true);
  const roadmapExists = fs.existsSync(p.roadmap), base = { schema_version: 1, milestone, enrolled_at: enrollment.enrollment?.enrolled_at ?? null };
  if (selection.status === 'valid') return selectedState(owner, milestone, base, enrollment.enrollment ?? null, selection, roadmapExists, p);
  if (roadmapExists) {
    const listing = t.listOptions({ cwd: owner, milestone });
    return { state: { ...base, status: 'roadmap-preexisting', options_recorded: listing.status === 'valid' ? listing.records.length : 0 } };
  }
  return preselectionState(owner, milestone, base, options);
}
function readSelectionState(cwd, milestone, options = {}) {
  let owner;
  try { if (!milestoneId(milestone)) return null; owner = ownerRoot(cwd); } catch { return null; }
  try { const read = inspect(owner, milestone, { ...(object(options) ? options : {}), shallow: false }); return read === null ? null : read.state; }
  catch (e) { return invalidState(milestone, codeOf(e, 'time-source-unreadable')); }
}
// A contracted choice needs the slice review gate: a dependent slice starts only after its
// predecessor is canonically completed AND reviewed, which never happens with review.mode
// disabled. The incompatibility is therefore named before any contract is activated (and is
// inspectable before the choice) instead of becoming a latent block. Effective preferences come
// from the canonical reader or the controller's in-process reader seam, never from caller JSON.
// No-contract, unenrolled and S01-only milestones never consult it.
function contractCompatibility(cwd, milestone, options = {}) {
  const answer = (status, reason, mode = null) => ({ status, reason, review_mode: mode });
  try {
    if (!milestoneId(milestone)) return answer('unknown', 'time-work-id-invalid');
    const owner = ownerRoot(cwd);
    const reader = object(options) && typeof options.prefsReader === 'function' ? options.prefsReader : dir => require('./forge-prefs').readPrefs(dir);
    const resolved = reader(owner);
    if (!resolved || resolved.ok !== true || !object(resolved.prefs)) return answer('unknown', 'review-prefs-invalid');
    const raw = object(resolved.prefs.review) ? resolved.prefs.review.mode : undefined;
    // The completer and review gate treat every value except 'disabled' as enabled.
    const mode = raw === undefined ? 'enabled' : String(raw).toLowerCase();
    return mode === 'disabled' ? answer('incompatible', 'review-disabled', mode) : answer('compatible', null, mode);
  } catch { return answer('unknown', 'review-prefs-unreadable'); }
}
function reviewRefusal(owner, milestone, input) {
  const review = contractCompatibility(owner, milestone, { prefsReader: input.prefsReader });
  if (review.status === 'compatible') return null;
  return refused(milestone, review.status === 'incompatible' ? 'time-review-disabled-incompatible' : 'time-review-mode-unknown');
}

// ---------------------------------------------------------------------------
// Owner safe boundary
// ---------------------------------------------------------------------------
// Owner writes for one milestone wait for its pending transactions, open begins
// and held leases. Work attributed to another milestone never defers this one;
// an unattributable lease is possible ownership and defers (fail closed).
function boundaryGuard(owner, milestone) {
  try {
    const c = controller(), lease = c.dependencies.forgeLease, phase = require('./forge-phase-cost');
    if (c.pendingTransactions(owner).some(t => t.milestone === milestone)) return 'transaction-pending';
    const events = readBounded(path.join(owner, '.gsd/milestones', milestone, milestone + '-events.jsonl'), phase.MAX_BYTES);
    if (events) {
      const analysis = phase.analyzeEventIntervals(events);
      if (analysis.milestones.some(m => m !== milestone)) return 'guard-unreadable';
      if (analysis.open.length || analysis.ambiguous.some(r => r.end === null)) return 'begin-open';
    }
    const dir = lease.leasesDir(owner); noLinks(dir, true);
    let names = []; try { names = fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort()) {
      const read = lease.readLease(path.join(dir, name));
      if (read.corrupt || !read.record || !lease.validRecord(read.record, read.record.unit)) return 'lease-unattributed';
      const tx = typeof read.record.request_id === 'string' ? c.lookupRecord(owner, 'transaction', read.record.request_id) : null;
      if (!tx) return 'lease-unattributed';
      if (tx.milestone === milestone) return 'lease-active';
    }
    return null;
  } catch { return 'guard-unreadable'; }
}
function writerContext(input, milestone) {
  if (!milestoneId(milestone)) fail('time-work-id-invalid');
  return { owner: ownerRoot(input) };
}
// The same-milestone guard is evaluated inside the canonical controller transaction
// mutex (begin/transition/resume and lease acquisition run under it), so no begin or
// lease can commit between the check and the publication. The owner publication lock
// is taken afterwards by the T01/pending writers, preserving the controller order.
// Host callbacks must run before entering; nothing in the region calls the host.
function guarded(owner, milestone, fn) {
  let handle;
  try { handle = require('./forge-lock').acquireProcessSync(owner, 'unit-controller-transactions', { retries: 80, ttlMs: 10_000 }); }
  catch { return deferred(milestone, 'guard-unreadable'); }
  try {
    const guard = boundaryGuard(owner, milestone);
    return guard ? deferred(milestone, guard) : fn();
  } finally { handle.release(); }
}
// The same guarded boundary, exported for the S03 owner writers (linked task): a
// result {status:'deferred', reason} is a named refusal, never a write.
const ownerBoundary = guarded;
function refused(milestone, reason) { return { status: 'refused', milestone: typeof milestone === 'string' ? milestone : null, reason }; }
function deferred(milestone, reason) { return { status: 'deferred', milestone, reason }; }
function enroll(cwd, milestone, options = {}) {
  try {
    const { owner } = writerContext(cwd, milestone);
    return guarded(owner, milestone, () => {
      const result = time().recordEnrollment({ cwd: owner, milestone, source: options.source, now: options.now });
      return { status: 'enrolled', milestone, enrolled_at: result.enrollment.enrolled_at, source: result.enrollment.source };
    });
  } catch (e) { return refused(milestone, codeOf(e, 'time-enrollment-invalid')); }
}
// Deterministic, link-free and atomic: identical bytes are never rewritten.
// planRender validates the destination and builds the exact bytes BEFORE any publication.
function planRender(owner, milestone, record) {
  const file = path.join(owner, '.gsd/milestones', milestone, milestone + '-OPTIONS.md'), content = offers().renderOptionsMarkdown(record);
  const current = readBounded(file, MAX_ROADMAP_BYTES);
  noLinks(file, true);
  return { file, content, unchanged: !!current && current.equals(Buffer.from(content, 'utf8')) };
}
function applyRender(owner, plan) {
  if (plan.unchanged) return 'unchanged';
  noLinks(plan.file, true);
  require('./forge-yaml-safe').writeAtomic(plan.file, plan.content, { cwd: owner });
  return 'written';
}
// Canonical recordOptions refuses a new record at capacity only AFTER the descriptor would exist, so the same
// deterministic conditions are checked first. Replaying a stored sha stays idempotent even at full capacity.
// The limit mirrors the private canonical MAX_RECORDS; the test suite checks parity against recordOptions.
const OPTIONS_RECORD_LIMIT = 256;
function preflightOptionsRecord(owner, milestone, sha256) {
  const enrollment = time().readEnrollment({ cwd: owner, milestone });
  if (enrollment.status !== 'valid') fail(enrollment.status === 'absent' ? 'time-enrollment-required' : codeOf({ code: enrollment.reason }, 'time-options-invalid'));
  const listing = time().listOptions({ cwd: owner, milestone });
  if (listing.status !== 'valid') fail(codeOf({ code: listing.reason }, 'time-options-invalid'));
  if (listing.records.some(r => r.options_sha256 === sha256)) return;
  // Canonical refuseActivated precedes capacity for a NEW record: same public checks, before any descriptor.
  const contract = time().readContract({ cwd: owner, milestone });
  if (contract.status === 'invalid') fail(codeOf({ code: contract.reason }, 'time-options-invalid'));
  if (contract.status === 'valid') fail('time-options-contract-exists');
  const roadmap = time().timePaths({ cwd: owner, milestone }).roadmap;
  noLinks(roadmap, true); if (fs.existsSync(roadmap)) fail('time-options-roadmap-exists');
  if (listing.records.length >= OPTIONS_RECORD_LIMIT) fail('time-record-limit');
}
function renderOptions(owner, milestone, record) { return applyRender(owner, planRender(owner, milestone, record)); }
function prepareBoundary(cwd, milestone, options = {}) {
  let owner, p;
  try { owner = ownerRoot(cwd); p = time().timePaths({ cwd: owner, milestone }); } catch { return { status: 'no-op', milestone: typeof milestone === 'string' ? milestone : null }; }
  // Without enrollment or selection only existence is checked: nothing else is read or written.
  if (!fs.existsSync(p.enrollment) && !fs.existsSync(p.selection)) return { status: 'no-op', milestone };
  try {
    return guarded(owner, milestone, () => prepareInside(owner, milestone, options));
  } catch (e) {
    const result = refused(milestone, codeOf(e, 'time-options-invalid'));
    return typeof e.reason === 'string' ? { ...result, detail: codeOf({ code: e.reason }, 'roadmap-time-expected-invalid') } : result;
  }
}
function prepareInside(owner, milestone, options) {
  {
    const read = inspect(owner, milestone, { ...(object(options) ? options : {}), shallow: false }), now = options.now ?? Date.now();
    if (read === null) return { status: 'no-op', milestone };
    const state = read.state;
    if (state.status === 'materialization-required') {
      const m = read.materialize, history = offers().readHistory({ cwd: owner, milestone });
      const made = offers().materialize({ milestone, proposal: m.proposal, inputs: m.inputs, history, now,
        producer_basis: { producer: PRODUCER, identity_sha256: m.identity, frozen_at: m.frozen_at } });
      // Destination and content are validated first: a refusal never leaves a published proposal.
      const plan = planRender(owner, milestone, made.record);
      preflightOptionsRecord(owner, milestone, made.options_sha256);
      // Written before the record and keyed by its hash: a crash never leaves a head without its context.
      // Always persisted: any accepted basis (including a supplied owner-root identity) must recover identically.
      const file = codeContextFile(owner, milestone, made.options_sha256), bytes = codeContextBytes(milestone, { options_sha256: made.options_sha256, producer_identity_sha256: m.identity }, m.code);
      const current = readBounded(file, 16 * 1024);
      if (!current || !current.equals(bytes)) { noLinks(file, true); require('./forge-yaml-safe').writeAtomic(file, bytes.toString('utf8'), { cwd: owner }); }
      const stored = time().recordOptions({ cwd: owner, milestone, record: made.record });
      if (stored.options_sha256 !== made.options_sha256) fail('time-options-invalid');
      return { status: 'materialized', milestone, options_sha256: stored.options_sha256, render: applyRender(owner, plan) };
    }
    if (state.status === 'decision-pending') return { status: 'unchanged', milestone, state: state.status, render: renderOptions(owner, milestone, read.head.record) };
    if (state.status === 'decided' && state.roadmap?.status === 'allocation-pending') {
      // The T01 mutator evaluates conformance again under the owner lock; no caller hash is passed.
      const amended = time().recordDelegatedAllocation({ cwd: owner, milestone, reason: 'Alocação técnica delegada conforme ao roadmap', now });
      return { status: 'allocated', milestone, contract_sha256: amended.sha256, version: amended.version };
    }
    return { status: 'unchanged', milestone, state: state.status, ...(state.roadmap ? { roadmap: state.roadmap.status } : {}) };
  }
}
function nextRound(input = {}) {
  const milestone = input.milestone;
  try {
    const { owner } = writerContext(input, milestone);
    return guarded(owner, milestone, () => nextInside(owner, milestone, input));
  } catch (e) { return refused(milestone, codeOf(e, 'time-option-round-invalid')); }
}
function nextInside(owner, milestone, input) {
  {
    const read = inspect(owner, milestone, { code: input.code });
    if (read === null) return refused(milestone, 'time-enrollment-required');
    if (read.state.status === 'options-invalid') return refused(milestone, read.state.reason);
    if (read.state.status !== 'decision-pending') return { status: 'none', milestone, state: read.state.status };
    if (!read.rounds.round) return { status: 'none', milestone, state: 'decision-ready', options_sha256: read.state.options_sha256 };
    const round = read.rounds.round;
    if (!markerFree(round)) return refused(milestone, 'time-options-invalid');
    const opened = questions().openQuestions({ cwd: owner, milestone, unit: roundUnit(round), decision_set: round.decision_set, questions: [{ id: round.id, question: round.question }] });
    if (opened.identity_sha256 !== roundIdentity(milestone, round)) fail('time-option-round-invalid');
    const question = { identity_sha256: opened.identity_sha256, question_id: round.id };
    return { status: 'open', milestone, options_sha256: read.state.options_sha256, identity_sha256: question.identity_sha256, question_id: round.id,
      decision: decisionOf(round, question), round: structuredClone(round) };
  }
}
function answerRound(input = {}) {
  const milestone = input.milestone;
  try {
    const { owner } = writerContext(input, milestone);
    if (!['user-text', 'tool-answer'].includes(input.source)) return refused(milestone, 'time-option-answer-source-invalid');
    const answered = guarded(owner, milestone, () => answerInside(owner, milestone, input));
    return answered.status === 'answered' ? { ...answered, next: readSelectionState(owner, milestone, { code: input.code }) } : answered;
  } catch (e) { return refused(milestone, /^pending-answer-conflict/.test(e.message || '') ? 'time-option-answer-conflict' : codeOf(e, 'time-option-answer-invalid')); }
}
function answerInside(owner, milestone, input) {
  {
    const read = inspect(owner, milestone, { code: input.code });
    if (read === null) return refused(milestone, 'time-enrollment-required');
    const round = read.state.status === 'decision-pending' ? read.rounds.round : null;
    // Another round, a done decision or another milestone's round never receives the answer.
    if (!round || round.id !== input.round) return refused(milestone, 'time-option-round-mismatch');
    if (!read.rounds.question.opened) return refused(milestone, 'time-option-round-not-open');
    if (round.invalid_answer || read.rounds.question.answer !== null) return refused(milestone, 'time-option-answer-conflict');
    if (typeof input.response !== 'string' || !input.response.trim()) return refused(milestone, 'time-option-answer-empty');
    const answer = offers().canonicalAnswer(round, input.response);
    if (answer === null) return refused(milestone, 'time-option-answer-invalid');
    questions().answer({ cwd: owner, identity: read.rounds.question.identity_sha256, answers: [{ id: round.id, answer, source: input.source }], channel: input.channel });
    return { status: 'answered', milestone, round_id: round.id, answer };
  }
}

// ---------------------------------------------------------------------------
// Attested decision
// ---------------------------------------------------------------------------
function decisionFor(read, predicate, code) {
  const row = [...read.rounds.rounds].reverse().find(r => predicate(read.rounds.answered[r.round.id], r.round));
  if (!row) fail(code || 'time-decision-scope-mismatch');
  return { answer: read.rounds.answered[row.round.id], question: { identity_sha256: row.question.identity_sha256, id: row.question.question_id } };
}
// Deterministic requests derived from the persisted options record and the replayed
// explicit answers; never from caller JSON.
function selectionPlan(read, milestone, now) {
  const outcome = read.rounds.outcome, sha = read.head.options_sha256, rounds = read.rounds.rounds.map(r => ({ round_id: r.round.id, type: r.round.type,
    decision_set: r.round.decision_set, answer: read.rounds.answered[r.round.id], identity_sha256: r.question.identity_sha256 }));
  if (outcome.choice === 'no-contract') {
    // T01 attests no-contract only as an activation answer; a scope-round no-contract stays pending.
    const d = decisionFor(read, (a, round) => a === 'no-contract' && round.decision_set === ACTIVATION_SET);
    return { selection: { choice: 'no-contract', options_sha256: sha, rounds },
      decisions: [{ kind: 'activation', request: { milestone, options_sha256: sha, choice: 'no-contract' }, expected: ['no-contract'], question: d.question }] };
  }
  const view = rt().optionsView(read.head.record);
  if (view.status !== 'valid') fail('time-options-invalid');
  const option = view.options.find(o => o.id === outcome.option_id), position = option?.positions?.find(x => x.id === outcome.position_id);
  if (!object(position) || !ms(outcome.ceiling?.ceiling_ms) || !read.state.enrolled_at) fail('time-options-invalid');
  const linked = position.linked_task ?? null, authorization = outcome.linked_task_authorization ?? null;
  const known = r => object(r) && ms(r.low_ms) && ms(r.high_ms);
  const request = { schema_version: 1, milestone, clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
    option: { id: option.id, options_sha256: sha, label: option.label, ...(linked === null ? { position_id: position.id } : {}) },
    activated_at: iso(now), preselection_started_at: read.state.enrolled_at, ceiling_ms: outcome.ceiling.ceiling_ms,
    endpoint: structuredClone(option.endpoint), allocation: null,
    linked_task: linked === null ? null : { position_id: position.id, authorization, moved_scope: [...linked.moved_scope], criteria: structuredClone(linked.criteria),
      horizon: structuredClone(linked.horizon), options_sha256: sha },
    chain_forecast: linked !== null && known(position.estimate) && known(linked.horizon)
      ? { low_ms: position.estimate.low_ms + linked.horizon.low_ms, high_ms: position.estimate.high_ms + linked.horizon.high_ms, basis: 'milestone-plus-linked-task' } : null };
  const activation = decisionFor(read, (a, round) => a === outcome.activation_answer && round.decision_set === ACTIVATION_SET);
  const decisions = [{ kind: 'activation', request, expected: [outcome.activation_answer], question: activation.question }];
  if (linked !== null) {
    const d = decisionFor(read, (a, round) => a === 'linked-task:' + authorization && round.decision_set === LINKED_SET);
    decisions.push({ kind: 'linked-task', request: { milestone, options_sha256: sha, option_id: option.id, position_id: position.id, authorization },
      expected: ['linked-task:' + authorization], question: d.question });
  }
  return { selection: { choice: 'option', options_sha256: sha, option_id: option.id, position_id: position.id, linked_task_authorization: authorization,
    contract_request: request, rounds }, decisions };
}
// Each handle comes only from the live adapter; it is verified against the
// persisted explicit answer of the exact original question before any write.
function liveHandle(owner, milestone, liveAdapter, row, now) {
  let handle;
  try {
    handle = liveAdapter.getDecisionHandle({ cwd: owner, milestone, kind: row.kind, request: structuredClone(row.request), request_sha256: digest(row.request),
      question: { ...row.question }, expected: [...row.expected] });
  } catch { fail('time-decision-attestation-required'); }
  const decision = time().verifyDecision({ cwd: owner, milestone, now, handle, kind: row.kind, request: row.request, expected: row.expected });
  if (!same(decision.question, row.question)) fail('time-decision-scope-mismatch');
  return { handle, decision };
}
function failpoint(input, name) {
  if (typeof input.failpoint === 'function' && input.failpoint(name)) fail('time-selection-failpoint');
}
function resumeActivation(owner, milestone, read, input, now) {
  if (read.roadmapExists) return refused(milestone, 'time-contract-roadmap-exists');
  const s = read.selection, persisted = s.decisions[0].decision;
  // The same persisted request and question: a new decision is never created here.
  const row = { kind: 'activation', request: s.contract_request, expected: [persisted.answer], question: persisted.question };
  // The recorded choice stays; only its contract activation waits for a compatible review mode.
  const review = reviewRefusal(owner, milestone, input); if (review) return review;
  const live = liveHandle(owner, milestone, input.liveAdapter, row, now);
  if (live.decision.answer !== persisted.answer || live.decision.request_sha256 !== persisted.request_sha256) return refused(milestone, 'time-decision-answer-mismatch');
  return guarded(owner, milestone, () => {
    // The host callback ran outside the boundary: recheck the persisted state before publishing.
    const again = inspect(owner, milestone, { code: input.code });
    if (again === null || again.state.status !== 'activation-pending' || again.roadmapExists || again.state.selection_sha256 !== read.state.selection_sha256) return refused(milestone, 'time-options-stale');
    const reviewAgain = reviewRefusal(owner, milestone, input); if (reviewAgain) return reviewAgain;
    const contract = time().activateContract({ cwd: owner, milestone, contract: s.contract_request, handle: live.handle, now });
    return { status: 'decided', milestone, choice: 'option', resumed: true, selection_sha256: read.state.selection_sha256, contract_sha256: contract.sha256 };
  });
}
function decide(input = {}) {
  const milestone = object(input) ? input.milestone : undefined;
  try {
    if (!object(input) || typeof input.liveAdapter?.getDecisionHandle !== 'function') return refused(milestone, 'time-decision-attestation-required');
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now)) return refused(milestone, 'time-decision-attestation-required');
    const { owner } = writerContext(input, milestone);
    // Cheap early exit before any host callback; the authoritative check repeats inside the boundary.
    const early = boundaryGuard(owner, milestone); if (early) return deferred(milestone, early);
    const read = inspect(owner, milestone, { code: input.code });
    if (read === null) return refused(milestone, 'time-enrollment-required');
    const state = read.state;
    if (state.status === 'options-invalid') return refused(milestone, state.reason);
    if (state.status === 'decided') return { status: 'decided', milestone, choice: state.choice, unchanged: true, selection_sha256: state.selection_sha256, contract_sha256: state.contract?.sha256 ?? null };
    if (state.status === 'activation-pending') return resumeActivation(owner, milestone, read, input, now);
    if (state.status === 'roadmap-preexisting') return refused(milestone, 'time-options-roadmap-exists');
    if (state.status !== 'decision-pending') return refused(milestone, 'time-options-stale');
    if (state.round) return refused(milestone, 'time-option-pending');
    const plan = selectionPlan(read, milestone, now), handles = {};
    // A contracted choice is refused by name before any host callback or write when review is disabled.
    const contracted = plan.selection.choice !== 'no-contract';
    if (contracted) { const review = reviewRefusal(owner, milestone, input); if (review) return review; }
    // Every handle is verified (read-only) before the first write.
    for (const row of plan.decisions) handles[row.kind] = liveHandle(owner, milestone, input.liveAdapter, row, now).handle;
    return guarded(owner, milestone, () => {
      // The handles were collected outside the boundary: a begin, lease or state change meanwhile defers or refuses.
      const again = inspect(owner, milestone, { code: input.code });
      if (again === null || again.state.status !== 'decision-pending' || again.state.round || !same(selectionPlan(again, milestone, now), plan)) return refused(milestone, 'time-options-stale');
      if (contracted) { const review = reviewRefusal(owner, milestone, input); if (review) return review; }
      const recorded = time().recordSelection({ cwd: owner, milestone, selection: plan.selection, handles, now });
      failpoint(input, 'after-selection');
      if (plan.selection.choice === 'no-contract') return { status: 'decided', milestone, choice: 'no-contract', selection_sha256: recorded.selection_sha256, contract_sha256: null };
      const contract = time().activateContract({ cwd: owner, milestone, contract: plan.selection.contract_request, handle: handles.activation, now });
      return { status: 'decided', milestone, choice: 'option', selection_sha256: recorded.selection_sha256, contract_sha256: contract.sha256 };
    });
  } catch (e) { return refused(milestone, codeOf(e, 'time-decision-refused')); }
}

// ---------------------------------------------------------------------------
// Prompt block, roadmap rule and continuation (read-only)
// ---------------------------------------------------------------------------
function byteLength(lines) { return Buffer.byteLength(lines.join('\n')); }
function rangeText(low, high) { const f = offers().formatDuration; return ms(low) && ms(high) ? f(low) + ' a ' + f(high) : 'desconhecida'; }
function fitBlock(head, details, tail) {
  const kept = [...details];
  let omitted = 0;
  const build = () => [...head, ...kept, ...(omitted ? ['- (' + omitted + ' linha(s) omitida(s); detalhes completos no -OPTIONS.md)'] : []), ...tail];
  while (kept.length && byteLength(build()) > MAX_BLOCK_BYTES) { kept.pop(); omitted++; }
  return build();
}
function contractBlock(read) {
  const s = read.selection, contract = read.contract.contract, view = rt().optionsView(read.offered.record);
  const option = view.status === 'valid' ? view.options.find(o => o.id === s.option_id) : null, position = option?.positions?.find(x => x.id === s.position_id);
  if (!position) fail('time-options-invalid');
  const proposed = read.offered.record.proposal?.positions?.find(x => x.id === s.position_id) || {};
  const type = String(contract.decision.answer).startsWith('operator-ceiling:') ? 'teto do operador' : 'posição oferecida';
  const items = contract.endpoint.items, expected = read.expected;
  const head = ['Seleção de prazo ativa (dados do owner; não concedem autorização nova):',
    '- Opção: ' + option.id + ' — ' + option.label + ' (tipo: ' + type + '; posição ' + position.id + (contract.linked_task ? '; com task ligada' : '') + ').',
    '- Contrato base: ' + read.contract.chain[0].sha256 + '; contrato atual: ' + read.contract.sha256 + ' (versão ' + read.contract.version + '); opções ' + s.options_sha256 + '.',
    '- Teto: ' + offers().formatDuration(contract.ceiling_ms) + ' (' + contract.ceiling_ms + ' ms); a alocação pode ficar abaixo da faixa, sem piso, nunca acima do teto.',
    '- Faixa da milestone: ' + rangeText(position.estimate?.low_ms, position.estimate?.high_ms) + (position.estimate?.confidence ? '; confiança ' + (position.estimate.confidence === 'medium' ? 'média' : 'baixa') : '') + '.',
    '- Marco final: ' + Object.keys(ITEM_LABELS).map(k => ITEM_LABELS[k] + ': ' + (STATE_LABELS[items[k]] || items[k])).join('; ') + '.'];
  const details = ['- Divisão preliminar:', ...(Array.isArray(proposed.nodes) ? proposed.nodes : position.nodes || []).map(n => '  - ' + n.id + ' [' + (KIND_LABELS[n.kind] || n.kind) + ']'
    + (n.title ? ' ' + n.title : '') + '; depende de ' + ((n.depends || []).join(', ') || 'nada') + '.')];
  const deferrals = [...(proposed.deferrals || []).map(d => d.scope_item + ' (' + d.reason + ')'),
    ...read.contract.chain.filter(r => r.kind === 'scope-reduction' && r.decision).flatMap(r => r.patch.deferred_items.map(k => k + ' (redução consentida)'))];
  details.push('- Adiamentos consentidos: ' + (deferrals.join('; ') || 'nenhum') + '.');
  if (contract.linked_task) {
    const t = contract.linked_task, nodes = proposed.linked_task?.nodes || [];
    details.push('- Task ligada: autorização ' + t.authorization + '; escopo movido ' + t.moved_scope.join(', ') + (nodes.length ? ' (nós ' + nodes.join(', ') + ')' : '') + '.',
      '  - Critérios da milestone: ' + t.criteria.milestone.join('; ') + '.', '  - Critérios da task: ' + t.criteria.task.join('; ') + '.',
      '  - Horizonte da task: ' + rangeText(t.horizon.low_ms, t.horizon.high_ms) + '; teto ' + offers().formatDuration(t.horizon.ceiling_ms) + '; previsão da cadeia '
        + (contract.chain_forecast ? rangeText(contract.chain_forecast.low_ms, contract.chain_forecast.high_ms) : 'desconhecida') + ' (não reduz o total).');
  }
  const skeleton = { schema_version: rt().SECTION_SCHEMA_VERSION, option_id: s.option_id, position_id: s.position_id, options_sha256: s.options_sha256,
    contract_sha256: read.contract.chain[0].sha256, allocation: [], dependencies: expected?.status === 'ready' ? expected.edges : [],
    deferred: expected?.status === 'ready' ? expected.deferred : [], linked_task: expected?.status === 'ready' ? expected.linked_task : null };
  const tail = indent => ['- Seção obrigatória no ROADMAP: ' + rt().SECTION_HEADING + ' com um único bloco json; preencha allocation (id, kind, slice, ms, nodes) cobrindo os nós, arestas e gates acima, total até o teto:',
    '```json', JSON.stringify(skeleton, null, indent), '```'];
  let lines = fitBlock(head.map(cleanText), details.map(cleanText), tail(2));
  if (byteLength(lines) > MAX_BLOCK_BYTES) lines = fitBlock(head.map(cleanText), [], tail(0));
  if (byteLength(lines) > MAX_BLOCK_BYTES) fail('time-prompt-block-too-large');
  return lines.join('\n');
}
function promptBlock(cwd, milestone) {
  try {
    if (!milestoneId(milestone)) return NO_ENROLLMENT_BLOCK;
    let owner; try { owner = ownerRoot(cwd); } catch { return NO_ENROLLMENT_BLOCK; }
    const read = inspect(owner, milestone, { shallow: true });
    if (read === null) return NO_ENROLLMENT_BLOCK;
    const s = read.state;
    if (s.status === 'decided' && s.choice === 'no-contract') return cleanText('Decisão explícita do operador: seguir sem contrato de tempo (opções ' + s.options_sha256 + ', seleção ' + s.selection_sha256 + '). Não declare ' + rt().SECTION_HEADING + '.');
    if (s.status === 'decided') return contractBlock(read);
    const status = s.status === 'preselection' ? readSelectionState(owner, milestone)?.status ?? 'options-invalid' : s.status;
    return cleanText('Seleção de prazo pendente (' + status + '): plan-milestone não pode produzir ROADMAP antes da escolha explícita atestada do operador.');
  } catch (e) { return cleanText('Seleção de prazo ilegível (' + codeOf(e, 'time-source-unreadable') + '): não produza ROADMAP até a seleção ser válida.'); }
}
function rule(milestone, expected) { return { kind: 'milestone-roadmap-time', milestone, expected }; }
function pendingRule(milestone, precondition) { return rule(milestone, { status: 'pending', precondition }); }
// null only for legacy/unenrolled milestones and an attested no-contract choice;
// every other enrolled state is an unsatisfied precondition. Never throws.
function roadmapRule(cwd, milestone) {
  try {
    if (!milestoneId(milestone)) return null;
    // An unvalidated owner is unknown, never a verified unenrolled milestone: fail closed.
    let owner; try { owner = ownerRoot(cwd); } catch { return rule(milestone, { status: 'invalid', reason: 'roadmap-time-expected-invalid' }); }
    const read = inspect(owner, milestone, { shallow: true });
    if (read === null) return null;
    const s = read.state;
    if (s.status === 'decided' && s.choice === 'no-contract') return null;
    if (s.status === 'decided') return rule(milestone, read.expected);
    if (s.status === 'activation-pending') return pendingRule(milestone, 'activation-required');
    if (s.status === 'options-invalid') return rule(milestone, { status: 'invalid', reason: 'roadmap-time-options-invalid' });
    return pendingRule(milestone, ['preselection', 'roadmap-preexisting'].includes(s.status) && !s.options_recorded ? 'options-required' : 'selection-required');
  } catch { return rule(milestone, { status: 'invalid', reason: 'roadmap-time-expected-invalid' }); }
}
// Read-only projection of the CURRENT delegated allocation of one slice for the task-node
// binding (distinct from the immutable selected graph and from the empty promptBlock
// skeleton). absent: genuine legacy / no-contract / unenrolled; ready: a selected active
// contract with a conformant current roadmap; blocked: the owner state is not (yet) usable;
// invalid: unreadable or malformed owner state. Everything is re-read from the owner here.
function taskBindingContext(cwd, milestone, options = {}) {
  const sliceId = object(options) ? options.sliceId : undefined;
  const answer = (status, reason, extra) => ({ schema_version: 1, status, milestone: typeof milestone === 'string' ? milestone : null,
    slice: typeof sliceId === 'string' ? sliceId : null, ...(reason ? { reason } : {}), ...(extra || {}) });
  let owner;
  try {
    if (!milestoneId(milestone) || typeof sliceId !== 'string' || !/^S\d{2,}$/.test(sliceId)) return answer('invalid', 'time-work-id-invalid');
    owner = ownerRoot(cwd);
  } catch (e) { return answer('invalid', codeOf(e, 'time-source-unreadable')); }
  try {
    const read = inspect(owner, milestone, { shallow: false });
    if (read === null) return answer('absent');
    const state = read.state;
    if (state.status === 'options-invalid') return answer('invalid', state.reason);
    if (state.status !== 'decided') return answer('blocked', state.status);
    if (!state.contract) return answer('absent');
    if (!state.roadmap) return answer('blocked', 'roadmap-absent');
    if (state.roadmap.status !== 'conformant') return answer('blocked', state.roadmap.status);
    const p = time().timePaths({ cwd: owner, milestone }); noLinks(p.roadmap);
    const buffer = readBounded(p.roadmap, MAX_ROADMAP_BYTES), identity = time().roadmapIdentity(buffer);
    // The conformance read and this projection must describe the same roadmap bytes.
    if (identity.sha256 !== state.roadmap.roadmap_sha256) return answer('blocked', 'roadmap-changed');
    const inspected = rt().inspectRoadmapContent(decode(buffer)), section = inspected.section;
    if (inspected.status !== 'valid' || !section) return answer('invalid', 'roadmap-time-section-missing');
    const parts = new Map();
    for (const r of section.refinements || []) for (const part of r.parts) parts.set(part, r.node);
    const allocation = [];
    for (const row of section.allocation) for (const id of row.nodes) {
      allocation.push({ id, parent: parts.get(id) || id, part: parts.has(id), kind: row.kind, slice: row.kind === 'slice' ? row.slice : null, row: row.id });
    }
    const slices = inspected.slices.map(s => ({ id: s.id, dependencies: [...s.dependencies].sort() }));
    const current = slices.find(s => s.id === sliceId);
    if (!current) return answer('blocked', 'slice-unknown');
    const allocated = allocation.filter(a => a.slice === sliceId);
    if (!allocated.length) return answer('blocked', 'slice-unallocated');
    const closure = new Set(), walk = id => { for (const d of slices.find(s => s.id === id)?.dependencies || []) if (!closure.has(d)) { closure.add(d); walk(d); } };
    walk(sliceId);
    const view = a => ({ id: a.id, slice: a.slice });
    const edges = read.expected.edges.map(e => ({ from: e.from, to: e.to, dependent: allocation.filter(a => a.parent === e.from).map(view),
      prerequisite: allocation.filter(a => a.parent === e.to).map(view) })).filter(e => e.dependent.some(a => a.slice === sliceId));
    return answer('ready', null, { option_id: state.option_id, position_id: state.position_id, options_sha256: state.options_sha256,
      sources: { selection_sha256: state.selection_sha256, contract_sha256: state.contract.sha256, contract_base_sha256: state.contract.base_sha256,
        roadmap_sha256: identity.sha256, structure_sha256: identity.structure_sha256 },
      allocated, slice_dependencies: current.dependencies, prerequisite_slices: [...closure].sort(), roadmap_slices: slices, edges });
  } catch (e) { return answer('invalid', codeOf(e, 'time-source-unreadable')); }
}
function resumeCheck(cwd, milestone, block) {
  const answer = (code, state) => ({ ok: code === 'time-option-ready', reason_code: code, milestone: typeof milestone === 'string' ? milestone : null,
    options_sha256: state?.options_sha256 ?? null, status: state?.status ?? null });
  if (!object(block) || Object.keys(block).sort().join(',') !== 'milestone,options_sha256' || block.milestone !== milestone || !milestoneId(milestone)
      || !(block.options_sha256 === null || hash(block.options_sha256))) return answer('time-option-resume-invalid');
  const state = readSelectionState(cwd, milestone);
  if (state === null) return answer('time-option-resume-invalid');
  if (state.status === 'options-invalid') return answer('time-options-invalid', state);
  if (state.status === 'decided' && (block.options_sha256 === null || block.options_sha256 === state.options_sha256) && (state.choice === 'no-contract' || state.contract)) return answer('time-option-ready', state);
  const pending = require('./forge-milestone-time-admission').TIME_REASON_CODES.find(c => c === 'time-option-pending');
  return answer(pending, state);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const STATUS_MESSAGES = Object.freeze({ 'estimate-required': 'estimativa necessária', 'materialization-required': 'materialização pendente no owner',
  'decision-pending': 'decisão do operador pendente', 'options-invalid': 'opções inválidas', 'activation-pending': 'ativação pendente',
  decided: 'decisão registrada', 'roadmap-preexisting': 'roadmap preexistente' });
function cliMessage(action, result) {
  if (result?.status === 'refused' || result?.status === 'deferred') return (result.status === 'deferred' ? 'Escrita adiada: ' : 'Operação recusada: ') + result.reason;
  if (action === '--status') return result.state === null ? 'Milestone sem adesão: o fluxo de opções não se aplica.' : 'Seleção de prazo: ' + (STATUS_MESSAGES[result.state.status] || result.state.status) + '.';
  if (action === '--round') return result.status === 'open' ? ['Decisão ' + result.decision.id + ': ' + result.decision.question,
    ...result.decision.options.map((o, i) => (i + 1) + '. ' + o.label + ': ' + o.description), 'Sem resposta explícita, a decisão continua pendente.'].join('\n') : 'Nenhuma rodada aberta (' + result.state + ').';
  if (action === '--answer') return 'Resposta registrada: ' + result.answer + '.';
  if (action === '--decide') return 'Decisão atestada: ' + result.choice + '.' + (result.linked_task ? ' Task ligada: ' + result.linked_task.status
    + (result.linked_task.task_id ? ' (' + result.linked_task.task_id + ')' : '') + (result.linked_task.reason ? '; motivo ' + result.linked_task.reason : '') + '.' : '');
  if (action === '--enroll') return 'Adesão registrada.';
  if (action === '--conformance') return result.rule === null ? 'Sem regra de tempo para o roadmap.' : 'Conformidade do roadmap: ' + (result.roadmap?.status || result.rule.expected.status) + '.';
  return String(result);
}
// Late-loaded: the linked-task module is only needed after an embedded attested decision.
function linkedCreation(options, liveAdapter) {
  let selected;
  try { selected = time().readSelection({ cwd: ownerRoot(options.cwd), milestone: options.milestone }); } catch { selected = null; }
  const authorization = selected?.status === 'valid' ? selected.selection.linked_task_authorization : null;
  if (!['create-and-start-after-proven-completion', 'create-without-auto-start'].includes(authorization)) return null;
  const created = require('./forge-linked-task').createLinkedTask({ cwd: options.cwd, milestone: options.milestone, liveAdapter });
  return { status: created.status, task_id: created.task_id ?? null, reason: created.reason ?? null };
}
function main(argv = process.argv.slice(2), io = process, liveAdapter) {
  const json = argv.includes('--json'), options = {};
  let action = null;
  try {
    const actions = ['--enroll', '--status', '--round', '--answer', '--decide', '--prompt-block', '--conformance'], values = ['--cwd', '--milestone', '--source', '--response'];
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === '--json') continue;
      if (flag === '--round' && i + 1 < argv.length && !argv[i + 1].startsWith('--')) { options.round = argv[++i]; continue; }
      if (actions.includes(flag)) { if (action) fail('time-usage'); action = flag; continue; }
      if (values.includes(flag) && i + 1 < argv.length && (flag === '--response' || !argv[i + 1].startsWith('--')) && options[flag.slice(2)] === undefined) { options[flag.slice(2)] = argv[++i]; continue; }
      fail('time-usage');
    }
    if (!action || !options.cwd || !options.milestone) fail('time-usage');
    const extra = Object.keys(options).filter(k => !['cwd', 'milestone'].includes(k)).sort().join(',');
    if (extra !== ({ '--enroll': 'source', '--answer': 'response,round,source' }[action] || '')) fail('time-usage');
    let result, status = 0;
    if (action === '--decide') {
      // CLI arguments and persisted files cannot supply live authority: refuse before any read or write.
      if (typeof liveAdapter?.getDecisionHandle !== 'function') result = refused(options.milestone, 'time-decision-attestation-required');
      else {
        result = decide({ cwd: options.cwd, milestone: options.milestone, liveAdapter });
        // Only a decided option with a create-* linked-task authorization creates its task, with the same
        // live adapter; every other outcome keeps today's output without the linked_task key.
        const linked = result.status === 'decided' && result.choice === 'option' ? linkedCreation(options, liveAdapter) : null;
        if (linked) {
          result = { ...result, linked_task: linked, ...(['refused', 'partial'].includes(linked.status) ? { reason: linked.reason } : {}) };
          if (!['created', 'unchanged', 'resumed'].includes(linked.status)) status = 3;
        }
      }
    } else if (action === '--enroll') result = enroll(options.cwd, options.milestone, { source: options.source });
    else if (action === '--status') result = { status: 'ok', state: readSelectionState(options.cwd, options.milestone) };
    else if (action === '--round') result = nextRound({ cwd: options.cwd, milestone: options.milestone });
    else if (action === '--answer') result = answerRound({ cwd: options.cwd, milestone: options.milestone, round: options.round, response: options.response, source: options.source });
    else if (action === '--prompt-block') {
      const block = promptBlock(options.cwd, options.milestone);
      io.stdout.write(json ? JSON.stringify({ status: 'ok', block }) + '\n' : block + '\n'); return 0;
    } else {
      const roadmapState = readSelectionState(options.cwd, options.milestone);
      result = { status: 'ok', rule: roadmapRule(options.cwd, options.milestone), roadmap: roadmapState?.roadmap ?? null };
      if (result.rule !== null && (result.rule.expected?.status !== 'ready' || result.roadmap && result.roadmap.status !== 'conformant')) status = 3;
    }
    if (['refused', 'deferred'].includes(result.status)) status = 3;
    io.stdout.write((json ? JSON.stringify(result) : cliMessage(action, result)) + '\n'); return status;
  } catch (e) {
    const reason = codeOf(e, 'time-selection-refused'), status = reason === 'time-usage' ? 2 : 3;
    io.stdout.write(json ? JSON.stringify({ status: status === 2 ? 'usage' : 'refused', reason }) + '\n'
      : status === 2 ? 'Uso: --enroll --source <origem> | --status | --round | --answer --round <ID> --response <texto> --source user-text|tool-answer | --decide | --prompt-block | --conformance, sempre com --cwd e --milestone [--json]\n'
        : 'Operação recusada: ' + reason + '\n');
    return status;
  }
}

module.exports = { TIME_OPTION_REASON_CODES, TIME_OPTION_RESUME_CODES, SELECTION_STATUSES, ROADMAP_STATUSES, ESTIMATE_UNIT,
  estimateKeySuffix, estimateBeginKey, readSelectionState, enroll, prepareBoundary, nextRound, answerRound, decide, promptBlock,
  roadmapRule, taskBindingContext, contractCompatibility, resumeCheck, ownerRoot, ownerBoundary, main };
if (require.main === module) process.exitCode = main();
