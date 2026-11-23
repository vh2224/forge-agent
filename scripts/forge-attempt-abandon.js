'use strict';

// Safe abandonment of one milestone execute-task attempt (issue 440, S02/T04).
//
// abandonAttempt never grants itself authority. It only ends an attempt after a
// canonical replay was refused for an OPERATIONAL reason (replay-refusal-v1,
// reclassified live here) and after live proofs: the receipt process stopped,
// the process family stopped under the T02 custody of THIS process, a live
// writer attestation bound to that custody, a live attestation for the owner and
// every execution_contract root, no pending question, the standing recovery
// authority revalidated by its permanent adapter, the S0 baseline intact and
// every delta explained (owner by the S01 chain, owner events by this record,
// code roots only inside concrete claims). Then it takes the T03 verified backup,
// revalidates everything again and runs the T03 claimed reset.
//
// The external record <resultFile>.abandon.jsonl is append-only, created by wx,
// link-free, prefix-checked (sha256, size, identity) before every append and
// hash-chained. It binds the original receipt, the request identity, the backup
// manifest, the reset proof and the writer/descendants/root references. The
// receipt, the reset-state (S0) and the recovery state are never written.
//
// Origin rule (D6/R4/G1/G2): a record line, a JSON copy, a PID or a hash is
// history, never current authority. After a restart without the live custody
// origin the descendants proof is `unknown` and abandonment, reset resumption
// and successor admission refuse by name, preserving backup and history. This is
// not an operating-system sandbox. Diagnostics carry only codes, counts, hashes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const roots = require('./forge-code-roots');
const refusalSet = require('./forge-replay-refusal');
const processTree = require('./forge-process-tree');
const transition = require('./forge-recovery-transition');
const surgical = require('./forge-surgical-reset');
const managed = require('./forge-managed-attribution');

const ABANDON_VERSION = 'attempt-abandon-v1';
const REASON_CODES = Object.freeze([
  'abandon-adapter-required', 'abandon-unit-unsupported', 'abandon-identity-conflict',
  'abandon-refusal-not-operational', 'abandon-writer-live', 'abandon-writer-unknown',
  'abandon-descendants-unproved', 'abandon-descendants-alive', 'abandon-root-unproved',
  'abandon-questions-pending', 'abandon-authority-missing', 'abandon-authority-invalid',
  'abandon-baseline-missing', 'abandon-baseline-invalid', 'abandon-delta-legacy',
  'abandon-delta-unexplained', 'abandon-backup-unverified', 'abandon-changed-after-proof',
  'abandon-reset-partial', 'abandon-reset-unproved', 'abandon-record-conflict',
  // Internal integrity only: malformed calls of the exported helpers.
  'abandon-input-invalid',
]);
const EVENT_NAMES = Object.freeze(['attempt-replay-refused', 'attempt-abandon-refused', 'attempt-abandoned',
  'attempt-successor-admitted', 'attempt-successor-refused']);
const LINE_KINDS = Object.freeze(['refusal', 'owner-event', 'proofs', 'backup', 'reset-started', 'reset-root',
  'reset-verified', 'reset-partial', 'abandoned', 'successor-admitted', 'refused']);
const LIMITS = Object.freeze({ record_bytes: 1024 * 1024, line_bytes: 64 * 1024, receipt_bytes: 8 * 1024 * 1024 });
const ZERO = '0'.repeat(64);
const HEX64 = /^[a-f0-9]{64}$/;
const EVENTS = '.gsd/forge/events.jsonl';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const { digest } = roots;
const adapters = new WeakMap();

class AbandonError extends Error {
  constructor(code, detail) {
    super(REASON_CODES.includes(code) ? code : 'abandon-input-invalid');
    this.name = 'AbandonError';
    this.code = this.message;
    this.provider_called = false;
    if (detail !== undefined) this.detail = detail;
  }
}
function refuse(code, detail) { throw new AbandonError(code, detail); }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function safeCode(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) ? value : null; }
function tri(value) { return value === true || value === false ? value : 'unknown'; }
// Late requires keep the recovery/sidecar/execution seams acyclic.
const recovery = () => require('./forge-attempt-recovery');
const sidecar = () => require('./forge-unit-sidecar');
const execution = () => require('./forge-task-execution');
const xllm = () => require('./forge-xllm');
function attempt(ctx, label, code, action) {
  try { return action(); } catch (error) { if (error instanceof AbandonError) throw error; refuse(code, safeCode(error?.code) || label); }
}
function failpoint(ctx, name) {
  if (typeof ctx.options.failpoint === 'function' && ctx.options.failpoint(name) === true) {
    throw Object.assign(new Error(`forge-attempt-abandon: failpoint ${name}`), { code: 'ABANDON_FAILPOINT' });
  }
}

// ── Adapter: one opaque facade over the existing live capabilities ───────────
function createAbandonmentAdapter(callbacks) {
  const { attestWriter, attestRoot, revalidateAttribution } = callbacks || {};
  if (typeof attestWriter !== 'function' || typeof attestRoot !== 'function' || typeof revalidateAttribution !== 'function') {
    refuse('abandon-adapter-required');
  }
  const handle = Object.freeze({ kind: 'attempt-abandon-adapter' });
  adapters.set(handle, Object.freeze({ writer: transition.createWriterObservationAdapter(attestWriter),
    revalidation: managed.createAttributionRevalidationAdapter(revalidateAttribution), attestRoot }));
  return handle;
}

// ── Bounded link-free reads ─────────────────────────────────────────────────
function identityOf(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
function readRegular(file, limit, code) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit)) refuse(code, 'file-invalid');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (identityOf(opened) !== identityOf(stat) || opened.size !== stat.size) refuse(code, 'file-replaced');
    const bytes = fs.readFileSync(fd);
    if (BigInt(bytes.length) !== stat.size) refuse(code, 'file-unstable');
    return { bytes, identity: identityOf(stat) };
  } finally { fs.closeSync(fd); }
}
function fileSha(file, code = 'abandon-changed-after-proof') { const read = readRegular(file, LIMITS.receipt_bytes, code); return read ? sha(read.bytes) : null; }

// ── Step 1: scope and identity ──────────────────────────────────────────────
function scopeAndIdentity(raw, options) {
  const ctx = { options, rows: [], anchor: null, events: [] };
  if (!raw || typeof raw !== 'object') refuse('abandon-unit-unsupported', 'request-required');
  const request = recovery().canonicalRequest(raw);
  if (request.scope !== 'milestone' || request.unitType !== 'execute-task' || request.phase !== 'execute'
      || typeof request.milestoneId !== 'string' || typeof request.taskId !== 'string' || request.reviewFix
      || request.ownerBroker || request.memberHandle !== undefined || request.route?.worker_mode === 'native'
      || request.route?.worker_mode !== 'sidecar' || request.execution_contract?.schema_version !== 2) refuse('abandon-unit-unsupported');
  const files = attempt(ctx, 'result-file', 'abandon-unit-unsupported', () => sidecar().artifactAttemptFiles(request));
  const contract = attempt(ctx, 'contract', 'abandon-unit-unsupported',
    () => roots.validateContract(request.execution_contract, { owner: request.contextRoot, revalidate: true }));
  const read = readRegular(files.receiptFile, LIMITS.receipt_bytes, 'abandon-identity-conflict');
  if (!read) refuse('abandon-baseline-missing', 'receipt-absent');
  let receipt;
  try { receipt = JSON.parse(read.bytes.toString('utf8')); } catch { refuse('abandon-identity-conflict', 'receipt-invalid'); }
  if (!receipt || typeof receipt !== 'object' || receipt.kind === 'review-fix' || receipt.native || receipt.execution?.native) refuse('abandon-unit-unsupported');
  if (!receipt.recovery_baseline) refuse('abandon-baseline-missing');
  if (receipt.recovery_baseline.schema_version !== 1) refuse('abandon-unit-unsupported', 'baseline-schema');
  const fingerprint = sidecar().artifactFingerprint(raw);
  const identity = digest(recovery().requestIdentity(request));
  if (receipt.fingerprint !== fingerprint || receipt.dispatch_id !== request.dispatchId
      || receipt.recovery_identity_sha256 !== identity) refuse('abandon-identity-conflict');
  // A held-claim refusal of the canonical validator is claim divergence, which
  // the live reclassification (T01) blocks by name; anything else is identity.
  try { sidecar().validateRecoveryRequest(raw); } catch (error) {
    if (!/claim/.test(String(error?.code || ''))) refuse('abandon-identity-conflict', safeCode(error?.code) || 'request');
    ctx.claimRefused = safeCode(error.code);
  }
  const resultFile = files.resultFile;
  const recordFile = `${resultFile}.abandon.jsonl`, backupDir = path.join(`${resultFile}.abandon`, 'backup');
  const stateFile = request.recoveryStateFile || `${resultFile}.recovery.json`;
  attempt(ctx, 'record-target', 'abandon-record-conflict', () => {
    for (const root of [contract.owner, ...contract.code_roots.map(row => row.path)]) {
      for (const file of [recordFile, stateFile, `${resultFile}.process-tree.jsonl`]) xllm().validateResultFileTarget(file, root);
    }
  });
  const unit = `execute-task/${request.taskId}`;
  const binding = { version: ABANDON_VERSION, unit, milestone: request.milestoneId, dispatch_id: request.dispatchId,
    fingerprint, recovery_identity_sha256: identity, receipt_sha256: sha(read.bytes),
    baseline_state_sha256: receipt.recovery_baseline.state_sha256 || null, contract_sha256: digest(contract) };
  Object.assign(ctx, { raw, request, contract, owner: contract.owner, files, receipt, receiptBytes: read.bytes, unit, binding,
    bindingSha: digest(binding), recordFile, backupDir, stateFile, treeRecord: `${resultFile}.process-tree.jsonl` });
  loadRecord(ctx);
  return ctx;
}

// ── Record: exclusive, prefix-checked, hash-chained ─────────────────────────
function parseLines(ctx, bytes) {
  if (!bytes.length) refuse('abandon-record-conflict', 'record-empty');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\n')) refuse('abandon-record-conflict', 'record-torn');
  const rows = [];
  let prev = ZERO, offset = 0;
  for (const line of text.slice(0, -1).split('\n')) {
    const lineBytes = Buffer.from(`${line}\n`, 'utf8');
    let row = null;
    try { row = JSON.parse(line); } catch { row = null; }
    if (!row || JSON.stringify(row) !== line || row.v !== ABANDON_VERSION || row.seq !== rows.length || row.prev !== prev
        || !LINE_KINDS.includes(row.kind) || row.binding_sha256 !== ctx.bindingSha) refuse('abandon-record-conflict', 'record-line');
    if (rows.length === 0 && (row.kind !== 'refusal' || digest(row.binding) !== ctx.bindingSha)) refuse('abandon-record-conflict', 'record-binding');
    rows.push(deepFreeze({ ...row, line_sha256: sha(lineBytes), end: offset + lineBytes.length }));
    prev = sha(lineBytes); offset += lineBytes.length;
  }
  // Closed ordering: proofs → backup → reset-* → abandoned → successor.
  const index = kind => rows.findIndex(row => row.kind === kind);
  const count = kind => rows.filter(row => row.kind === kind).length;
  const before = (a, b) => index(a) < 0 || (index(b) >= 0 && index(b) < index(a));
  if (['proofs', 'backup', 'reset-started', 'reset-verified', 'abandoned', 'successor-admitted'].some(kind => count(kind) > 1)
      || !before('backup', 'proofs') || !before('reset-started', 'backup') || !before('reset-root', 'reset-started')
      || !before('reset-verified', 'reset-started') || !before('abandoned', 'reset-verified') || !before('successor-admitted', 'abandoned')
      || new Set(rows.filter(row => row.kind === 'reset-root').map(row => row.root_id)).size !== count('reset-root')) refuse('abandon-record-conflict', 'record-order');
  return rows;
}
function loadRecord(ctx) {
  const read = readRegular(ctx.recordFile, LIMITS.record_bytes, 'abandon-record-conflict');
  ctx.rows = read ? parseLines(ctx, read.bytes) : [];
  ctx.anchor = read ? { sha256: sha(read.bytes), size: read.bytes.length, identity: read.identity, bytes: read.bytes } : null;
}
function latest(ctx, kind) { return [...ctx.rows].reverse().find(row => row.kind === kind) || null; }
function recordSha(ctx) { return ctx.anchor ? ctx.anchor.sha256 : null; }
function appendLine(ctx, kind, payload) {
  const row = { v: ABANDON_VERSION, seq: ctx.rows.length, prev: ctx.rows.length ? ctx.rows.at(-1).line_sha256 : ZERO,
    kind, binding_sha256: ctx.bindingSha, ...(ctx.rows.length ? {} : { binding: ctx.binding }), ...payload };
  const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  if (line.length > LIMITS.line_bytes) refuse('abandon-record-conflict', 'line-too-large');
  let after;
  if (!ctx.anchor) {
    let fd;
    try { fd = fs.openSync(ctx.recordFile, 'wx', 0o600); } catch { refuse('abandon-record-conflict', 'record-exists'); }
    try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    after = readRegular(ctx.recordFile, LIMITS.record_bytes, 'abandon-record-conflict');
    if (!after || !after.bytes.equals(line)) refuse('abandon-record-conflict', 'record-reread');
  } else {
    const current = readRegular(ctx.recordFile, LIMITS.record_bytes, 'abandon-record-conflict');
    if (!current || sha(current.bytes) !== ctx.anchor.sha256 || current.bytes.length !== ctx.anchor.size
        || current.identity !== ctx.anchor.identity) refuse('abandon-record-conflict', 'record-prefix-changed');
    if (current.bytes.length + line.length > LIMITS.record_bytes) refuse('abandon-record-conflict', 'record-too-large');
    const fd = fs.openSync(ctx.recordFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (identityOf(opened) !== ctx.anchor.identity || opened.size !== BigInt(ctx.anchor.size) || opened.nlink !== 1n) refuse('abandon-record-conflict', 'record-prefix-changed');
      fs.writeSync(fd, line); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    after = readRegular(ctx.recordFile, LIMITS.record_bytes, 'abandon-record-conflict');
    if (!after || after.identity !== ctx.anchor.identity || !after.bytes.equals(Buffer.concat([current.bytes, line]))) refuse('abandon-record-conflict', 'record-reread');
  }
  ctx.rows.push(deepFreeze({ ...row, line_sha256: sha(line), end: after.bytes.length }));
  ctx.anchor = { sha256: sha(after.bytes), size: after.bytes.length, identity: after.identity, bytes: after.bytes };
  failpoint(ctx, `after-${kind}`);
  return ctx.rows.at(-1);
}
function assertRecordUnchanged(ctx) {
  const current = readRegular(ctx.recordFile, LIMITS.record_bytes, 'abandon-record-conflict');
  if (!ctx.anchor ? current !== null : !current || sha(current.bytes) !== ctx.anchor.sha256 || current.identity !== ctx.anchor.identity) {
    refuse('abandon-record-conflict', 'record-changed');
  }
}

// ── Owner events: exact guarded append under the owner fence and lock ───────
// A refused successor admission keeps the exact observed stop: the closed
// controller codes, transaction-pending and the canonical time refusal codes.
function successorRefusalCodes() {
  return [...require('./forge-unit-controller').ATTEMPT_SUCCESSOR_CODES, 'transaction-pending',
    ...require('./forge-milestone-time-admission').TRANSPORT_REFUSAL_CODES];
}
function validEventLine(ctx, event, reasonCode) {
  if (!EVENT_NAMES.includes(event)) refuse('abandon-input-invalid', 'event-unknown');
  if (!(reasonCode === null || REASON_CODES.includes(reasonCode) || refusalSet.REASON_CODES.includes(reasonCode)
      || (event === 'attempt-successor-refused' && successorRefusalCodes().includes(reasonCode)))) refuse('abandon-input-invalid', 'event-code');
  const line = Buffer.from(`${JSON.stringify({ event, unit: ctx.unit, dispatch_id: ctx.request.dispatchId,
    reason_code: reasonCode, record_sha256: recordSha(ctx) })}\n`, 'utf8');
  if (line.length > 2048) refuse('abandon-input-invalid', 'event-too-large');
  return line;
}
function ownerAppend(ctx, line) {
  const windows = require('./forge-owner-transport-window');
  const file = path.join(ctx.owner, '.gsd', 'forge', 'events.jsonl');
  let written = false;
  try {
    return windows.withMutation(ctx.owner, () => {
      const dir = fs.lstatSync(path.dirname(file));
      if (dir.isSymbolicLink() || !dir.isDirectory()) refuse('abandon-delta-unexplained', 'events-dir-invalid');
      const before = readRegular(file, 64 * 1024 * 1024, 'abandon-delta-unexplained');
      const prior = before ? before.bytes : Buffer.alloc(0);
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (opened.size !== BigInt(prior.length) || opened.nlink !== 1n) refuse('abandon-delta-unexplained', 'events-raced');
        written = true;
        fs.writeSync(fd, line); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const after = readRegular(file, 64 * 1024 * 1024, 'abandon-delta-unexplained');
      // Adopt only the exact caller append, never a fresh owner snapshot.
      if (!after || !after.bytes.equals(Buffer.concat([prior, line]))) refuse('abandon-delta-unexplained', 'events-raced');
      return { status: 'appended', before_sha256: sha(prior), before_size: prior.length, after_sha256: sha(after.bytes) };
    });
  } catch (error) {
    // A busy owner fence (or an unavailable lock) leaves the owner untouched.
    if (!written && !(error instanceof AbandonError)) return { status: 'pending-window', cause_code: safeCode(error?.code) };
    throw error;
  }
}
function emitEvent(ctx, event, reasonCode) {
  const line = validEventLine(ctx, event, reasonCode);
  if (!ctx.anchor) refuse('abandon-input-invalid', 'record-required');
  assertRecordUnchanged(ctx);
  // One admission (or one classification's refusal), one event. Only a truly appended
  // event completes it; a pending-window row is retried through the guarded append.
  let prior = [];
  if (event === 'attempt-successor-admitted') prior = ctx.rows.filter(row => row.kind === 'owner-event' && row.event === event);
  else if (event === 'attempt-replay-refused') {
    const at = ctx.rows.map(row => row.kind).lastIndexOf('refusal');
    prior = ctx.rows.slice(at + 1).filter(row => row.kind === 'owner-event' && row.event === event && row.reason_code === reasonCode);
  }
  const duplicate = prior.find(row => row.status === 'appended') || prior.at(-1) || null;
  if (duplicate && duplicate.status === 'appended') {
    return deepFreeze({ ok: true, event, status: duplicate.status, event_line_sha256: duplicate.event_sha256,
      owner_event: 'appended', record_sha256: recordSha(ctx), deduplicated: true });
  }
  if (duplicate) {
    const retried = ownerAppend(ctx, line);
    if (retried.status !== 'appended') {
      return deepFreeze({ ok: true, event, status: duplicate.status, event_line_sha256: duplicate.event_sha256,
        owner_event: 'pending-window', record_sha256: recordSha(ctx), deduplicated: true });
    }
    appendLine(ctx, 'owner-event', { event, reason_code: reasonCode, event_sha256: sha(line), event_size: line.length,
      status: 'appended', before_sha256: retried.before_sha256, before_size: retried.before_size, after_sha256: retried.after_sha256 });
    return deepFreeze({ ok: true, event, status: 'appended', event_line_sha256: sha(line), owner_event: 'appended', record_sha256: recordSha(ctx) });
  }
  if (event === 'attempt-successor-refused') {
    // An identical retry (same exact code, no progress line since) adds no second event.
    const index = ctx.rows.map(row => row.kind).lastIndexOf('owner-event');
    const last = index >= 0 ? ctx.rows[index] : null;
    if (last && last.event === event && last.reason_code === reasonCode && ctx.rows.slice(index + 1).every(row => row.kind === 'refused')) {
      return deepFreeze({ ok: true, event, status: last.status, event_line_sha256: last.event_sha256,
        owner_event: last.status === 'appended' ? 'appended' : 'pending-window', record_sha256: recordSha(ctx), deduplicated: true });
    }
  }
  const outcome = ownerAppend(ctx, line);
  appendLine(ctx, 'owner-event', { event, reason_code: reasonCode, event_sha256: sha(line), event_size: line.length,
    status: outcome.status, ...(outcome.status === 'appended' ? { before_sha256: outcome.before_sha256, before_size: outcome.before_size,
      after_sha256: outcome.after_sha256 } : { owner_event: 'pending-window', cause_code: outcome.cause_code }) });
  return deepFreeze({ ok: true, event, status: outcome.status, event_line_sha256: sha(line),
    owner_event: outcome.status === 'appended' ? 'appended' : 'pending-window', record_sha256: recordSha(ctx) });
}
// The events.jsonl delta is explained only as the attributed prefix followed by
// exactly the lines this record appended, in order, at their recorded offsets.
function eventsPrefix(ctx, current) {
  const appended = ctx.rows.filter(row => row.kind === 'owner-event' && row.status === 'appended');
  if (!appended.length) return current;
  const read = readRegular(path.join(ctx.owner, EVENTS), 64 * 1024 * 1024, 'abandon-delta-unexplained');
  if (!read) refuse('abandon-delta-unexplained', 'events-missing');
  let end = read.bytes.length;
  for (const row of [...appended].reverse()) {
    const start = end - row.event_size;
    if (start < 0 || start !== row.before_size || sha(read.bytes.subarray(start, end)) !== row.event_sha256
        || sha(read.bytes.subarray(0, start)) !== row.before_sha256) refuse('abandon-delta-unexplained', 'events-not-own-suffix');
    end = start;
  }
  const projected = { ...current };
  if (end === 0 && !Object.prototype.hasOwnProperty.call(ctx.receipt.recovery_baseline.protected_owner || {}, EVENTS)) delete projected[EVENTS];
  else projected[EVENTS] = sha(read.bytes.subarray(0, end));
  return projected;
}

// ── Step 2: replay refusal reclassified live (T01) ──────────────────────────
function liveQuestions(ctx) {
  let state = null;
  const read = readRegular(ctx.stateFile, LIMITS.receipt_bytes, 'abandon-questions-pending');
  if (read) {
    try { state = recovery().validateState(JSON.parse(read.bytes.toString('utf8'))); } catch { refuse('abandon-questions-pending', 'recovery-state-invalid'); }
  }
  ctx.state = state; ctx.stateSha = read ? sha(read.bytes) : null;
  let merged;
  try {
    merged = require('./forge-interaction').mergePendingQuestions(state?.pending_questions || [],
      [...(ctx.receipt.pending_questions || []), ...(ctx.receipt.input_pending_questions || [])]);
  } catch { refuse('abandon-questions-pending', 'questions-unreadable'); }
  return merged.filter(row => row.status !== 'resolved').map(row => row.id);
}
function liveClaim(ctx) {
  const run = require('./forge-runs').get(ctx.owner, ctx.request.runId || ctx.request.milestoneId);
  const claim = ctx.request.claim;
  return !ctx.claimRefused && !!claim && !claim.released && claim.generation !== undefined && !!run?.active && !run.write_claim?.released
    && digest(run.write_claim) === digest(claim);
}
function authorityShape(binding) {
  return !!binding && typeof binding.adapter?.readStandingAuthorization === 'function'
    && typeof binding.adapter?.issueRecoveryException === 'function' && typeof binding.reference === 'string' && !!binding.reference;
}
async function canonicalReplay(ctx, inspection) {
  const receipt = ctx.receipt;
  if (!['failed', 'started'].includes(receipt.phase) || receipt.saved_candidate || receipt.returned_response
      || receipt.failure?.returned_response || inspection.valid_saved_response !== false) return { attempted: false, refused: false, reason_code: null, provider_called: false };
  // The canonical publisher with zero transport calls: a failed/started receipt
  // is only read and refused; nothing is written.
  try {
    const replayed = await sidecar().replayArtifactAttempt(ctx.raw);
    return { attempted: true, refused: replayed?.replayed !== true, reason_code: null, provider_called: false };
  } catch (error) {
    return { attempted: true, refused: true, reason_code: safeCode(error?.code), provider_called: false };
  }
}
async function classify(ctx) {
  if (typeof ctx.options.processProbe !== 'function') refuse('abandon-writer-unknown', 'process-probe-required');
  const inspection = recovery().inspectReceipt(ctx.files.receiptFile, { request: ctx.raw, processProbe: ctx.options.processProbe });
  if (inspection.receipt_sha256 !== ctx.binding.receipt_sha256) refuse('abandon-changed-after-proof', 'receipt-changed');
  if (inspection.process_stopped !== true) refuse('abandon-writer-live');
  const pending = liveQuestions(ctx);
  const replay = await canonicalReplay(ctx, inspection);
  const last = ctx.state?.attempts?.at(-1);
  const failureClass = last?.failure_class === 'interrupted' ? 'unknown' : last?.failure_class || 'unknown';
  const facts = { identity_matches: true, claim_matches: liveClaim(ctx), pending_questions: pending,
    authority_present: authorityShape(ctx.options.recoveryAuthorization), failure_class: failureClass };
  const value = refusalSet.classifyReplayRefusal({ version: refusalSet.REFUSAL_SET_VERSION, inspection,
    receipt: ctx.receipt, replay, facts });
  ctx.classification = value;
  const recorded = latest(ctx, 'refusal');
  const summary = { code: value.code, eligible: refusalSet.isEligible(value), class: value.class,
    source_reason_code: value.source_reason_code, receipt_sha256: value.receipt_sha256,
    original_provider_called: tri(value.provider_called), timeout_cause: value.timeout_cause || null, classification_sha256: digest(value) };
  const changed = !recorded || recorded.classification_sha256 !== summary.classification_sha256;
  // Once proofs exist the registered refusal is fixed: a new blocking observation
  // refuses by its own name, a different operational one is a change after proof.
  const locked = ctx.rows.some(row => ['proofs', 'backup', 'reset-started'].includes(row.kind));
  if (changed && !locked) {
    appendLine(ctx, 'refusal', summary);
    if (ctx.options.emitEvents === true) emitEvent(ctx, 'attempt-replay-refused', value.code);
  }
  if (!summary.eligible) {
    const map = { 'replay-refusal-identity-conflict': 'abandon-identity-conflict', 'replay-refusal-question-pending': 'abandon-questions-pending',
      'replay-refusal-authority-missing': 'abandon-authority-missing' };
    refuse(map[value.code] || 'abandon-refusal-not-operational', value.code);
  }
  if (changed && locked) refuse('abandon-changed-after-proof', 'refusal-changed');
}

// ── Step 3: writer, descendants and every root ──────────────────────────────
function treeBinding(ctx) {
  const lease = require('./forge-unit-lease');
  const held = lease.readLease(lease.leaseFile(ctx.owner, ctx.unit)).record;
  const claimGeneration = ctx.request.claim?.generation;
  return { dispatch_id: ctx.request.dispatchId, fingerprint: ctx.binding.fingerprint,
    recovery_identity_sha256: ctx.binding.recovery_identity_sha256, unit: ctx.unit,
    claim_generation: claimGeneration === undefined ? null : claimGeneration,
    lease_generation: lease.validRecord(held, ctx.unit) ? held.generation : null };
}
function rootObservation(ctx, root) {
  const exec = execution();
  if (root.id === 'owner') return digest({ protected: exec.protectedSnapshot(ctx.owner) });
  return digest({ protected: exec.protectedSnapshot(root.path),
    snapshot: surgical.captureAttemptSnapshot(root.path, { vcsName: root.vcs }) });
}
async function proveWriter(ctx) {
  const live = adapters.get(ctx.options.adapter);
  if (!live) refuse('abandon-adapter-required');
  const proof = attempt(ctx, 'descendants', 'abandon-descendants-unproved',
    () => processTree.proveDescendantsStopped({ recordFile: ctx.treeRecord, binding: treeBinding(ctx) }));
  if (proof.status === 'alive') refuse('abandon-descendants-alive', proof.reason_code);
  if (proof.status !== 'stopped' || proof.method !== processTree.CUSTODY_METHOD) refuse('abandon-descendants-unproved', proof.reason_code);
  ctx.descendants = proof;
  ctx.descendantsSha = digest({ method: proof.method, status: proof.status, record_sha256: proof.evidence.record_sha256,
    journal_sha256: proof.evidence.journal_sha256, binding_sha256: proof.evidence.binding_sha256 });
  try {
    ctx.writer = await transition.observeStoppedWriter(live.writer, { receiptFile: ctx.files.receiptFile, request: ctx.raw,
      contract: ctx.contract, processProbe: ctx.options.processProbe, descendants: proof.handle,
      assertUnchanged: () => { if (fileSha(ctx.files.receiptFile) !== ctx.binding.receipt_sha256) refuse('abandon-changed-after-proof'); } });
  } catch (error) {
    if (['writer-observation-descendants-unproved', 'writer-observation-descendants-changed'].includes(error?.code)) refuse('abandon-descendants-unproved', error.code);
    if (error?.code === 'writer-observation-not-stopped') refuse('abandon-writer-live', error.code);
    refuse('abandon-writer-unknown', safeCode(error?.code));
  }
  ctx.writerIdentity = attempt(ctx, 'writer', 'abandon-writer-unknown', () => transition.assertWriterObservation(ctx.writer).writerIdentity());
  ctx.roots = [];
  for (const root of [{ id: 'owner', path: ctx.owner, vcs: null }, ...ctx.contract.code_roots]) {
    const challenge = deepFreeze({ schema: ABANDON_VERSION, operation: 'attest-root-writer-stopped', nonce: crypto.randomUUID(),
      root_id: root.id, root_sha256: digest(roots.key(root.path)), binding_sha256: ctx.bindingSha,
      receipt_sha256: ctx.binding.receipt_sha256, descendants_sha256: ctx.descendantsSha,
      observation_sha256: attempt(ctx, 'root-observation', 'abandon-root-unproved', () => rootObservation(ctx, root)) });
    let answer = null;
    try { answer = await live.attestRoot(clone(challenge)); } catch { answer = null; }
    if (!answer || answer.binding_sha256 !== digest(challenge) || answer.status !== 'stopped' || answer.root_id !== root.id
        || typeof answer.evidence_reference !== 'string' || !answer.evidence_reference.trim() || answer.evidence_reference.length > 512
        || /[\r\n]/.test(answer.evidence_reference)) refuse('abandon-root-unproved', root.id === 'owner' ? 'owner' : 'code-root');
    ctx.roots.push({ root_id: root.id, evidence_reference: answer.evidence_reference });
  }
}

// ── Steps 4-7: questions, authority, baseline, delta ────────────────────────
function proveQuestions(ctx) { if (liveQuestions(ctx).length) refuse('abandon-questions-pending'); }
function proveAuthority(ctx) {
  const binding = ctx.options.recoveryAuthorization;
  if (!authorityShape(binding)) refuse('abandon-authority-missing');
  try { recovery().bindRecoveryAuthorization(binding); binding.adapter.readStandingAuthorization(binding.reference); }
  catch (error) { refuse(error?.code === 'recovery-trusted-authority-required' ? 'abandon-authority-missing' : 'abandon-authority-invalid', safeCode(error?.code)); }
  ctx.authorityReference = binding.reference;
}
// Baseline digest: the formula of forge-unit-sidecar baselineDigest (state without
// reconciliation), pinned by the suite against captureMilestoneBaseline.
function baselineDigest(state) { const { reconciliation, ...baseline } = state; return digest(baseline); }
function proveBaseline(ctx) {
  const baseline = ctx.receipt.recovery_baseline;
  attempt(ctx, 'baseline', 'abandon-baseline-invalid', () => {
    const contract = roots.validateContract(baseline.execution_contract, { owner: ctx.owner, revalidate: true });
    if (digest(contract) !== digest(ctx.contract)) refuse('abandon-baseline-invalid', 'contract');
    recovery().validateStateTarget(baseline.state_file, ctx.request, contract);
    const read = readRegular(baseline.state_file, LIMITS.receipt_bytes, 'abandon-baseline-invalid');
    if (!read) refuse('abandon-baseline-invalid', 'state-missing');
    const state = JSON.parse(read.bytes.toString('utf8'));
    if (baseline.dispatch_id !== ctx.request.dispatchId || baseline.fingerprint !== ctx.receipt.fingerprint
        || baseline.state_sha256 !== baselineDigest(state) || state.attempt !== ctx.request.dispatchId || state.schema_version !== 2
        || digest(state.execution_contract) !== digest(contract)) refuse('abandon-baseline-invalid', 'binding');
    if (!baseline.input || roots.key(path.resolve(baseline.input.path)) !== roots.key(path.resolve(ctx.request.planFile))
        || baseline.input.sha256 !== digest(fs.readFileSync(baseline.input.path))) refuse('abandon-baseline-invalid', 'input');
    if (!baseline.protected_owner || !Array.isArray(baseline.protected_roots) || baseline.protected_roots.length !== contract.code_roots.length
        || contract.code_roots.some(root => !baseline.protected_roots.some(row => row.root_id === root.id && row.path === root.path))) refuse('abandon-baseline-invalid', 'roots');
    ctx.resetStateFile = baseline.state_file; ctx.resetStateSha = sha(read.bytes);
  });
}
function proveDelta(ctx) {
  const exec = execution(), live = adapters.get(ctx.options.adapter);
  const baseline = ctx.receipt.recovery_baseline;
  const current = eventsPrefix(ctx, exec.protectedSnapshot(ctx.owner));
  const verdict = managed.classifyOwnerDelta({ request: ctx.raw, receiptFile: ctx.files.receiptFile,
    before: baseline.protected_owner, current, revalidation: live.revalidation });
  const rows = verdict.paths.map(row => ({ ...(row.path ? { path: row.path } : { path_sha256: row.path_sha256, class: row.class }),
    status: row.status, reason_code: row.reason_code }));
  if (verdict.status === 'legacy') refuse('abandon-delta-legacy', { paths: rows.length });
  if (verdict.status !== 'attributed') refuse('abandon-delta-unexplained', { owner: rows.filter(row => row.status !== 'attributed') });
  for (const root of ctx.contract.code_roots) {
    if (roots.key(root.path) === roots.key(ctx.owner)) continue;
    const saved = baseline.protected_roots.find(row => row.root_id === root.id);
    if (digest(exec.protectedSnapshot(root.path)) !== digest(saved.snapshot)) refuse('abandon-delta-unexplained', { root_id: root.id, surface: 'protected' });
  }
  ctx.ownerDelta = { paths: rows.length, attributed: rows.length };
}

// ── Revalidation between the proof and every mutation ───────────────────────
function snapshotInputs(ctx) {
  ctx.observed = { receipt: fileSha(ctx.files.receiptFile), state: ctx.stateSha, reset_state: ctx.resetStateSha,
    tree: fileSha(ctx.treeRecord), owner: digest(execution().protectedSnapshot(ctx.owner)),
    roots: Object.fromEntries(ctx.contract.code_roots.map(root => [root.id, rootObservation(ctx, root)])) };
}
function revalidate(ctx, done = []) {
  const changed = detail => refuse('abandon-changed-after-proof', detail);
  try {
    assertRecordUnchanged(ctx);
    if (fileSha(ctx.files.receiptFile) !== ctx.observed.receipt) changed('receipt');
    const state = readRegular(ctx.stateFile, LIMITS.receipt_bytes, 'abandon-changed-after-proof');
    if ((state ? sha(state.bytes) : null) !== ctx.observed.state) changed('recovery-state');
    if (fileSha(ctx.resetStateFile) !== ctx.observed.reset_state) changed('reset-state');
    if (fileSha(ctx.treeRecord) !== ctx.observed.tree) changed('process-tree');
    try { processTree.assertDescendants(ctx.descendants.handle); transition.assertWriterObservation(ctx.writer); } catch { changed('writer'); }
    try { ctx.options.recoveryAuthorization.adapter.readStandingAuthorization(ctx.authorityReference); } catch { changed('authority'); }
    if (liveQuestions(ctx).length) changed('questions');
    if (digest(execution().protectedSnapshot(ctx.owner)) !== ctx.observed.owner) changed('owner');
    if (ctx.backup && fileSha(ctx.backup.manifest_file) !== ctx.backup.manifest_sha256) changed('backup');
    for (const root of ctx.contract.code_roots) {
      if (!done.includes(root.id) && rootObservation(ctx, root) !== ctx.observed.roots[root.id]) changed(root.id);
    }
  } catch (error) { if (error instanceof AbandonError) throw error; changed(safeCode(error?.code) || 'observation'); }
}

// ── Steps 8-11: backup, revalidation, reset and the abandoned line ──────────
const BACKUP_MAP = Object.freeze({ 'reset-unclaimed-change': 'abandon-delta-unexplained', 'reset-concrete-claims-required': 'abandon-delta-unexplained',
  'reset-overlap': 'abandon-delta-unexplained', 'reset-pre-dirty-changed': 'abandon-delta-unexplained',
  'baseline-moved': 'abandon-baseline-invalid', 'reset-input-invalid': 'abandon-baseline-invalid', 'reset-target-changed': 'abandon-changed-after-proof' });
function claims(ctx) { return Array.isArray(ctx.request.claim?.paths) ? ctx.request.claim.paths : []; }
function takeBackup(ctx) {
  const recorded = latest(ctx, 'backup');
  if (recorded) {
    ctx.backup = { manifest_file: path.join(ctx.backupDir, 'manifest.json'), manifest_sha256: recorded.manifest_sha256 };
    if (fileSha(ctx.backup.manifest_file, 'abandon-backup-unverified') !== recorded.manifest_sha256) refuse('abandon-backup-unverified', 'manifest-changed');
    return;
  }
  const result = surgical.backupResetTargets(ctx.resetStateFile, { backupDir: ctx.backupDir, claims: claims(ctx) });
  if (!result.ok) {
    refuse(BACKUP_MAP[result.reason_code] || 'abandon-backup-unverified', { reset_code: safeCode(result.reason_code),
      ...(safeCode(result.root_id) ? { root_id: result.root_id } : {}), ...(Array.isArray(result.paths) ? { paths: result.paths.slice(0, 64) } : {}) });
  }
  ctx.backup = { manifest_file: result.manifest_file, manifest_sha256: result.manifest_sha256 };
  appendLine(ctx, 'backup', { manifest_sha256: result.manifest_sha256, entries: result.entries, state_file_sha256: ctx.resetStateSha });
}
function runReset(ctx) {
  if (!latest(ctx, 'reset-started')) appendLine(ctx, 'reset-started', { manifest_sha256: ctx.backup.manifest_sha256 });
  let own = null, crash = null;
  const done = [];
  const result = surgical.resetClaimedAttempt(ctx.resetStateFile, { backup: ctx.backup, claims: claims(ctx),
    assertUnchanged: observation => {
      try { revalidate(ctx, done); } catch (error) { own = error; throw error; }
    },
    onProgress: progress => {
      done.splice(0, done.length, ...progress.roots_done);
      try {
        for (const id of progress.roots_done) {
          if (!ctx.rows.some(row => row.kind === 'reset-root' && row.root_id === id)) appendLine(ctx, 'reset-root', { root_id: id, roots_done: progress.roots_done });
        }
        failpoint(ctx, 'between-roots');
      } catch (error) { crash = error; throw error; }
    } });
  // A simulated crash between roots is a crash, not a recorded outcome.
  if (crash) throw crash;
  if (result.ok) {
    if (!latest(ctx, 'reset-verified')) appendLine(ctx, 'reset-verified', { manifest_sha256: ctx.backup.manifest_sha256,
      roots_done: result.roots_done, altered: result.altered, already_reset: result.already_reset });
    return result;
  }
  if (!result.roots_done.length && !(result.altered || []).some(row => row.paths.length)) {
    if (own) throw own;
    refuse(result.reason_code === 'backup-unverified' ? 'abandon-backup-unverified' : BACKUP_MAP[result.reason_code] || 'abandon-reset-unproved', safeCode(result.reason_code));
  }
  const code = result.reason_code === 'reset-partial' ? 'abandon-reset-partial' : 'abandon-reset-unproved';
  const effects = { roots_done: result.roots_done, pending_roots: result.pending_roots, altered: result.altered,
    already_reset: result.already_reset, cause_code: safeCode(result.cause_code), manifest_sha256: ctx.backup.manifest_sha256 };
  appendLine(ctx, 'reset-partial', { reason_code: code, ...effects });
  const error = new AbandonError(code);
  error.blocked = true; error.effects = effects;
  throw error;
}
function historical(ctx) {
  const row = latest(ctx, 'abandoned');
  return deepFreeze({ ok: true, status: 'abandoned', reason_code: null, provider_called: false,
    record_sha256: sha(ctx.anchor.bytes.subarray(0, row.end)), ...row.result });
}
async function observeLive(ctx) {
  await classify(ctx);
  await proveWriter(ctx);
  proveQuestions(ctx);
  proveAuthority(ctx);
  proveBaseline(ctx);
  proveDelta(ctx);
  snapshotInputs(ctx);
  ctx.proofs = { receipt_sha256: ctx.binding.receipt_sha256, descendants_sha256: ctx.descendantsSha,
    descendants_method: ctx.descendants.method, writer_identity_sha256: sha(String(ctx.writerIdentity)),
    authorization_reference_sha256: sha(ctx.authorityReference), reset_state_sha256: ctx.resetStateSha,
    classification_code: ctx.classification.code };
}
function result(ctx, fields) {
  return deepFreeze({ ok: false, provider_called: false, record_sha256: recordSha(ctx), ...fields });
}
async function refusalOutcome(ctx, error, emit, event) {
  const code = error.code;
  const effects = error.effects || null;
  // A refusal before the record exists (scope, identity, live process) creates
  // nothing; afterwards it is appended as history. Neither path touches a root.
  if (ctx?.anchor) {
    try {
      if (code !== 'abandon-record-conflict') {
        assertRecordUnchanged(ctx);
        if (!error.blocked) appendLine(ctx, 'refused', { reason_code: code, ...(safeCode(error.detail) ? { detail: error.detail } : {}) });
        if (emit) emitEvent(ctx, event, code);
      }
    } catch (secondary) { if (secondary?.code === 'ABANDON_FAILPOINT') throw secondary; }
  }
  return result(ctx || {}, { status: error.blocked ? 'blocked' : 'refused', reason_code: code,
    ...(error.detail && typeof error.detail === 'object' ? { diagnostic: clone(error.detail) } : safeCode(error.detail) ? { detail: error.detail } : {}),
    ...(effects ? { effects: clone(effects), successor: false } : {}) });
}

async function abandonAttempt(input = {}) {
  const options = input || {};
  let ctx = null;
  try {
    if (!adapters.has(options.adapter)) refuse('abandon-adapter-required');
    ctx = scopeAndIdentity(options.request, options);
    if (latest(ctx, 'abandoned')) return historical(ctx);
    await observeLive(ctx);
    const recorded = latest(ctx, 'proofs');
    if (recorded && recorded.proofs_sha256 !== digest(ctx.proofs)) refuse('abandon-changed-after-proof', 'proofs-changed');
    if (!recorded) appendLine(ctx, 'proofs', { proofs_sha256: digest(ctx.proofs), ...ctx.proofs,
      writer: { evidence: 'live-writer-observation', identity_sha256: ctx.proofs.writer_identity_sha256 },
      roots: ctx.roots.map(row => ({ root_id: row.root_id, evidence_reference_sha256: sha(row.evidence_reference) })),
      owner_delta: ctx.ownerDelta, recovery_state_sha256: ctx.stateSha });
    // Boundaries reached on every run (fresh or resumed), not only on first append.
    failpoint(ctx, 'proofs-observed');
    takeBackup(ctx);
    failpoint(ctx, 'backup-taken');
    revalidate(ctx);
    const reset = runReset(ctx);
    revalidate(ctx, ctx.contract.code_roots.map(root => root.id));
    const summary = { status: 'abandoned', manifest_sha256: ctx.backup.manifest_sha256, receipt_sha256: ctx.binding.receipt_sha256,
      request_identity_sha256: ctx.binding.recovery_identity_sha256, classification_code: ctx.classification.code,
      roots_reset: reset.roots_done, altered: reset.altered, operation_provider_called: false,
      original_provider_called: tri(ctx.classification.provider_called), descendants_sha256: ctx.descendantsSha };
    appendLine(ctx, 'abandoned', { result: summary });
    const value = historical(ctx);
    if (options.emitEvents === true) emitEvent(ctx, 'attempt-abandoned', null);
    return value;
  } catch (error) {
    if (!(error instanceof AbandonError)) throw error;
    return refusalOutcome(ctx, error, options.emitEvents === true, 'attempt-abandon-refused');
  }
}

function readAbandonment(input = {}) {
  try {
    const ctx = scopeAndIdentity(input.request, {});
    const kinds = ctx.rows.map(row => row.kind);
    const abandoned = latest(ctx, 'abandoned'), successor = latest(ctx, 'successor-admitted');
    const status = !ctx.rows.length ? 'none' : successor ? 'successor-admitted' : abandoned ? 'abandoned'
      : kinds.at(-1) === 'reset-partial' || (kinds.includes('reset-started') && !kinds.includes('reset-verified')) ? 'blocked'
        : kinds.at(-1) === 'refused' ? 'refused' : 'in-progress';
    // Historical record: never an authorization for any current effect.
    return deepFreeze({ ok: true, status, authorizes: false, record_sha256: recordSha(ctx), lines: kinds,
      abandoned: abandoned ? historical(ctx) : null,
      successor: successor ? { dispatch_id: successor.successor_dispatch_id, line_sha256: successor.line_sha256 } : null,
      last_refusal: latest(ctx, 'refused')?.reason_code || null });
  } catch (error) {
    if (!(error instanceof AbandonError)) throw error;
    return deepFreeze({ ok: false, status: 'unavailable', authorizes: false, reason_code: error.code });
  }
}

// Successor admission is never read from the record: the abandonment must still be
// provable live by this process (custody origin, writer, roots, questions,
// authority, baseline, delta) and every root must be at its baseline.
async function recordSuccessorAdmission(input = {}) {
  const options = input || {};
  let ctx = null;
  try {
    if (!adapters.has(options.adapter)) refuse('abandon-adapter-required');
    ctx = scopeAndIdentity(options.request, options);
    const successor = options.successor?.dispatch_id;
    const marker = typeof successor === 'string' ? successor.lastIndexOf('-recovery-') : -1;
    let derived = null;
    try { derived = marker > 0 ? require('./forge-recovery-dispatch-id').recoveryDispatchId(ctx.request.dispatchId, successor.slice(marker + 10)) : null; } catch { derived = null; }
    if (derived !== successor) refuse('abandon-input-invalid', 'successor-dispatch');
    const admitted = latest(ctx, 'successor-admitted');
    if (admitted) {
      if (admitted.successor_dispatch_id !== successor) refuse('abandon-record-conflict', 'successor-conflict');
      if (admitted.admission_sha256 !== digest(options.successor)) refuse('abandon-record-conflict', 'admission-conflict');
      // The record is history, never authority: the same live origin and proofs are required again.
      await observeLive(ctx);
      if (latest(ctx, 'proofs').proofs_sha256 !== digest(ctx.proofs)) refuse('abandon-changed-after-proof', 'proofs-changed');
      for (const root of ctx.contract.code_roots) {
        const state = surgical.readState(ctx.resetStateFile), before = state.repos.find(row => row.root_id === root.id);
        if (!before || !surgical.verifyReset(root.path, before.start_sha, before.pre_dirty, root.vcs).verified) refuse('abandon-reset-unproved', root.id);
      }
      revalidate(ctx, ctx.contract.code_roots.map(root => root.id));
      // A pending-window admission event is retried here; an event already appended (or
      // never attempted) is left exactly as it is.
      if (options.emitEvents === true && ctx.rows.some(row => row.kind === 'owner-event' && row.event === 'attempt-successor-admitted')) {
        emitEvent(ctx, 'attempt-successor-admitted', null);
      }
      return deepFreeze({ ok: true, status: 'successor-admitted', provider_called: false, successor_dispatch_id: successor,
        record_sha256: sha(ctx.anchor.bytes.subarray(0, admitted.end)) });
    }
    if (!latest(ctx, 'abandoned')) refuse(ctx.rows.some(row => row.kind === 'reset-partial') ? 'abandon-reset-partial' : 'abandon-input-invalid', 'abandoned-required');
    await observeLive(ctx);
    if (latest(ctx, 'proofs').proofs_sha256 !== digest(ctx.proofs)) refuse('abandon-changed-after-proof', 'proofs-changed');
    for (const root of ctx.contract.code_roots) {
      const state = surgical.readState(ctx.resetStateFile), before = state.repos.find(row => row.root_id === root.id);
      if (!before || !surgical.verifyReset(root.path, before.start_sha, before.pre_dirty, root.vcs).verified) refuse('abandon-reset-unproved', root.id);
    }
    revalidate(ctx, ctx.contract.code_roots.map(root => root.id));
    const row = appendLine(ctx, 'successor-admitted', { successor_dispatch_id: successor, parent_dispatch_id: ctx.request.dispatchId,
      abandoned_line_sha256: latest(ctx, 'abandoned').line_sha256, admission_sha256: digest(options.successor) });
    if (options.emitEvents === true) emitEvent(ctx, 'attempt-successor-admitted', null);
    return deepFreeze({ ok: true, status: 'successor-admitted', provider_called: false, successor_dispatch_id: successor,
      record_sha256: sha(ctx.anchor.bytes.subarray(0, row.end)) });
  } catch (error) {
    if (!(error instanceof AbandonError)) throw error;
    return refusalOutcome(ctx, error, options.emitEvents === true, 'attempt-successor-refused');
  }
}

// Refusal-only seam: validates the live opaque adapter and the classification,
// appends the 'refusal' anchor (and, on request, its guarded event). It never
// observes a writer, takes a backup, resets, admits or reserves a successor.
async function recordRefusal(input = {}) {
  const options = input || {};
  let ctx = null;
  try {
    if (!adapters.has(options.adapter)) refuse('abandon-adapter-required');
    ctx = scopeAndIdentity(options.request, options);
    const value = options.classification;
    try { refusalSet.validateClassification(value); } catch { refuse('abandon-input-invalid', 'classification'); }
    if (refusalSet.isEligible(value)) refuse('abandon-input-invalid', 'classification-eligible');
    if (ctx.rows.some(row => ['proofs', 'backup', 'reset-started', 'abandoned'].includes(row.kind))) refuse('abandon-input-invalid', 'record-locked');
    const summary = { code: value.code, eligible: false, class: value.class, source_reason_code: value.source_reason_code,
      receipt_sha256: value.receipt_sha256, original_provider_called: tri(value.provider_called),
      timeout_cause: value.timeout_cause || null, classification_sha256: digest(value) };
    const recorded = latest(ctx, 'refusal');
    if (!recorded || recorded.classification_sha256 !== summary.classification_sha256) appendLine(ctx, 'refusal', summary);
    const emitted = options.emitEvents === true ? emitEvent(ctx, 'attempt-replay-refused', value.code) : null;
    return deepFreeze({ ok: true, status: 'refusal-recorded', provider_called: false, record_sha256: recordSha(ctx),
      ...(emitted ? { owner_event: emitted.owner_event } : {}) });
  } catch (error) {
    if (!(error instanceof AbandonError)) throw error;
    return deepFreeze({ ok: false, status: 'refused', reason_code: error.code, provider_called: false, record_sha256: ctx ? recordSha(ctx) : null });
  }
}

function appendRecoveryEvent(input = {}) {
  try {
    const ctx = scopeAndIdentity(input.request, {});
    return emitEvent(ctx, input.event, input.reason_code === undefined ? null : input.reason_code);
  } catch (error) {
    if (!(error instanceof AbandonError)) throw error;
    return deepFreeze({ ok: false, status: 'refused', reason_code: error.code, provider_called: false });
  }
}

module.exports = {
  ABANDON_VERSION, REASON_CODES, EVENT_NAMES, LINE_KINDS, LIMITS,
  createAbandonmentAdapter, abandonAttempt, readAbandonment, recordSuccessorAdmission, appendRecoveryEvent, recordRefusal,
  internals: Object.freeze({ baselineDigest }),
};
