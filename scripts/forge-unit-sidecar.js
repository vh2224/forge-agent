#!/usr/bin/env node
'use strict';

// Delivery only: consumes a resolved route and the controller-selected unit.
// It never selects a unit, acquires a lease, changes host, commits or falls back.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xllm = require('./forge-xllm');
const { createStderrAnnouncer } = require('./forge-sidecar-identity');
const { invokeClaudeSidecar } = require('./forge-claude-sidecar');
const { evaluateDispatchGuard } = require('./forge-dispatch-guard');
const { capability } = require('./forge-transport-capabilities');
const { renderPrompt } = require('./forge-prompt');
const { diagnostic } = require('./forge-sidecar-diagnostic');
const memory = require('./forge-memory');
const forgeIds = require('./forge-ids');

const schema = xllm.loadSchemaFile('unit-artifacts.schema.json');
const memorySchema = xllm.loadSchemaFile('memory-extraction.schema.json');
const MAX_ARTIFACT_BYTES = 512 * 1024;
// Leave room for the envelope and provider prose within the 1 MiB stream cap.
const MAX_ARTIFACT_PAYLOAD_BYTES = 900 * 1024;
const MAX_PREPARATION_SUMMARY_BYTES = 64 * 1024;
const MAX_PREPARATION_QUESTIONS = 32;
const MAX_PREPARATION_QUESTION_BYTES = 16 * 1024;
const PREPARATION_SURFACE_MAX_ENTRIES = 2048;
const PREPARATION_SURFACE_MAX_BYTES = 16 * 1024 * 1024;
const MEMORY_QUALITY_CONTRACT = [
  'Keep only project-specific, non-obvious, durable facts that became true; reject pending work, secrets, generic advice and temporary state.',
  'Use candidate-local IDs only. Never allocate MEM IDs or return paths, owner identity, timestamps, commands or publication metadata.',
  'Preserve W1-W4 semantics: new facts, near-duplicate hit/confirm, supersede with a replacement candidate, and cap-50 prune.',
  'Emit promote only when owner-provided state proves confidence >= 0.85, hits >= 3, an eligible category, and durable non-fix text.',
  'Empty evidence returns done with empty facts/events. Partial, blocked or error returns no publishable facts/events.',
].join('\n');

function fail(code, hint) { const error = new Error(hint || code); error.code = code; throw error; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch { /* preserve the publication error */ } }
}
function json(file, value) { atomic(file, JSON.stringify(value, null, 2) + '\n'); }
function fileHash(file) { return fs.existsSync(file) ? hash(fs.readFileSync(file)) : null; }
function fileState(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  return { hash: stat.isFile() ? fileHash(file) : null, size: stat.size,
    mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, type: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'link' : 'other' };
}
function preparationSurfaceSnapshot(request) {
  const root = fs.realpathSync(request.contextRoot || request.cwd);
  const gsd = path.join(root, '.gsd');
  const taskBase = `.gsd/tasks/${request.taskId}/${request.taskId}`;
  const fixed = ['.gsd/STATE.md', '.gsd/DECISIONS.md', '.gsd/AUTO-MEMORY.md',
    '.gsd/PROJECT.md', '.gsd/CODING-STANDARDS.md', '.gsd/forge/events.jsonl',
    ...['BRAINSTORM', 'CONTEXT', 'RESEARCH', 'PLAN'].map(suffix => `${taskBase}-${suffix}.md`)];
  const selected = new Set(fixed);
  let visited = 0;
  // Preparation workers have no native sandbox. This bounded snapshot protects
  // canonical Forge control files and preparation outputs; it does not claim to
  // observe arbitrary source writes outside .gsd.
  function discover(current, relative = '.gsd') {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current).sort()) {
      if (++visited > PREPARATION_SURFACE_MAX_ENTRIES) fail('preparation-surface-limit');
      const absolute = path.join(current, name);
      const rel = `${relative}/${name}`.replace(/\\/g, '/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (relative === '.gsd' && !['milestones', 'tasks', 'forge'].includes(name)) continue;
        if (relative === '.gsd/tasks' && name !== request.taskId) continue;
        discover(absolute, rel);
      } else if ((['.gsd/milestones', '.gsd/tasks'].includes(relative) && /\.md$/i.test(name))
          || /-(?:ROADMAP|DECISIONS|BRAINSTORM|CONTEXT|RESEARCH|PLAN)\.md$/i.test(name)
          || /(?:^|\/)events\.jsonl$/i.test(rel)) selected.add(rel);
    }
  }
  discover(gsd);
  let bytes = 0;
  const files = {};
  for (const relative of [...selected].sort()) {
    const state = fileState(target(root, relative));
    if (state?.type === 'file') {
      bytes += state.size;
      if (bytes > PREPARATION_SURFACE_MAX_BYTES) fail('preparation-surface-limit');
    }
    files[relative] = state;
  }
  return { version: 1, scope: 'forge-control-files', bytes, files };
}
function sameUnit(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.type === expected.type && value.id === expected.id
    && (value.milestone || null) === (expected.milestone || null)
    && (value.slice || null) === (expected.slice || null);
}
function inspectDeliveryContent(content, rule) {
  if (rule.kind === 'standalone-preparation') {
    return require('./forge-task-preparation').validatePhaseContent(rule.phase, rule.taskId, content);
  }
  let value;
  try { value = JSON.parse(content); } catch (_) { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1
    || !sameUnit(value.unit, rule.unit)) return false;
  if (rule.kind === 'input') return typeof value.plan === 'string' && typeof value.plan_fingerprint === 'string'
    && Array.isArray(value.bindings) && Array.isArray(value.expected_children);
  if (rule.kind === 'delivery') return value.generated_by === 'forge-delivery'
    && typeof value.delivery_fingerprint === 'string' && Array.isArray(value.criteria) && Array.isArray(value.facts);
  return value.kind === rule.kind && typeof value.plan_fingerprint === 'string'
    && typeof value.code_dir === 'string' && typeof value.revision === 'string'
    && typeof value.environment === 'string' && typeof value.captured_at === 'string'
    && value.result && typeof value.result === 'object' && !Array.isArray(value.result);
}
const MILESTONE_ID_RE = /^(?:M\d+|M-\d{14}-[a-z0-9-]+)$/i;
// Review-fix has three boundaries and publishes only outcome lines into the
// REVIEW.md files the parent derives here; the worker never selects a path.
function reviewFixLocations(request) {
  const m = request.milestoneId, s = request.sliceId, t = request.taskId;
  const boundary = request.reviewFix && typeof request.reviewFix === 'object' ? request.reviewFix.boundary : undefined;
  const invalid = () => fail('review-fix-boundary-invalid',
    'review-fix requires boundary slice (milestone + slice), task (standalone task id) or milestone-triage (milestone + per-item review_file).');
  if (boundary === 'slice') {
    if (!MILESTONE_ID_RE.test(m || '') || !/^S\d+$/.test(s || '') || t !== undefined) invalid();
    const milestone = `.gsd/milestones/${m}`, slice = `${milestone}/slices/${s}`;
    return { milestone, slice, reviewFix: { boundary, unitLabel: `review-fix/${s}`, reviewFiles: [`${slice}/${s}-REVIEW.md`] } };
  }
  if (boundary === 'task') {
    if (m !== undefined || s !== undefined || !forgeIds.isValid(t) || forgeIds.entityKind(t) !== 'task') invalid();
    return { milestone: null, slice: null, task: `.gsd/tasks/${t}`,
      reviewFix: { boundary, unitLabel: `review-fix/${t}`, reviewFiles: [`.gsd/tasks/${t}/${t}-REVIEW.md`] } };
  }
  if (boundary === 'milestone-triage') {
    if (!MILESTONE_ID_RE.test(m || '') || s !== undefined || t !== undefined) invalid();
    const items = Array.isArray(request.reviewFix.items) ? request.reviewFix.items : [];
    const owned = new RegExp(`^\\.gsd/milestones/${m}/slices/(S\\d+)/\\1-REVIEW\\.md$`);
    const files = items.map(item => (item && typeof item.review_file === 'string' ? item.review_file.trim().replace(/\\/g, '/') : ''));
    if (!files.length || files.some(file => !owned.test(file))) invalid();
    return { milestone: `.gsd/milestones/${m}`, slice: null,
      reviewFix: { boundary, unitLabel: `review-fix/${m}-triage`, reviewFiles: [...new Set(files)].sort() } };
  }
  return invalid();
}
function locations(request) {
  const m = request.milestoneId, s = request.sliceId, t = request.taskId;
  if (request.unitType === 'review-fix') {
    return { required: [], allowed: [], rules: {}, delivery: null, ...reviewFixLocations(request) };
  }
  if (request.scope === 'standalone-task') {
    if (m !== undefined || s !== undefined) fail('standalone-task-scope-invalid');
    if (!forgeIds.isValid(t) || forgeIds.entityKind(t) !== 'task') fail('invalid-task');
    const contract = require('./forge-task-preparation').phaseContract(request.phase);
    if (!contract || request.unitType !== contract.unitType) fail('preparation-phase-unit-mismatch');
    const task = `.gsd/tasks/${t}`;
    const artifact = `${task}/${t}-${contract.suffix}.md`;
    return { required: [artifact], allowed: [artifact],
      rules: { [artifact]: { kind: 'standalone-preparation', phase: request.phase, taskId: t } }, delivery: null,
      milestone: null, slice: null, task, preparation: true };
  }
  if (request.unitType === 'memory-extract') {
    const sourceUnit = request.sourceUnitId || request.unitId || t || s || m;
    if (!memory.validateUnitId(sourceUnit)) fail('invalid-memory-unit');
    if (/^[ST]\d/i.test(sourceUnit) && !m) fail('memory-milestone-required');
    if (m !== undefined && !memory.validateMilestoneId(m)) fail('invalid-milestone');
    return { required: [], allowed: [], rules: {}, delivery: null, milestone: m ? `.gsd/milestones/${m}` : null,
      slice: m && s ? `.gsd/milestones/${m}/slices/${s}` : null, sourceUnit };
  }
  if (!/^(?:M\d+|M-\d{14}-[a-z0-9-]+)$/i.test(m || '')) fail('invalid-milestone');
  if (s !== undefined && !/^S\d+$/.test(s)) fail('invalid-slice');
  if (t !== undefined && !/^T\d+(?:\.\d+)?$/.test(t)) fail('invalid-task');
  const milestone = `.gsd/milestones/${m}`;
  const slice = `${milestone}/slices/${s}`;
  const unit = request.unitType;
  if ((/slice|plan-check|execute-task/.test(unit)) && !s) fail('invalid-slice');
  if (unit === 'execute-task' && !t) fail('invalid-task');
  const baseRequired = {
    'research-milestone': [`${milestone}/${m}-RESEARCH.md`],
    'research-slice': [`${slice}/${s}-RESEARCH.md`],
    'discuss-milestone': [`${milestone}/${m}-CONTEXT.md`],
    'discuss-slice': [`${slice}/${s}-CONTEXT.md`],
    'plan-milestone': [`${milestone}/${m}-ROADMAP.md`],
    'plan-check': [`${slice}/${s}-PLAN-CHECK.md`],
    'complete-slice': [`${slice}/${s}-SUMMARY.md`, `${slice}/${s}-UAT.md`],
    'complete-milestone': [`${milestone}/${m}-SUMMARY.md`],
    'plan-slice': [`${slice}/${s}-PLAN.md`],
    'execute-task': [`${slice}/tasks/${t}-SUMMARY.md`],
  }[unit];
  if (!baseRequired) fail('unsupported-sidecar-unit');
  const deliveryPrefix = unit === 'execute-task' ? `${slice}/tasks/${t}`
    : unit === 'complete-slice' ? `${slice}/${s}`
      : unit === 'complete-milestone' ? `${milestone}/${m}` : null;
  const deliveryUnit = unit === 'execute-task' ? { type: 'task', id: t, milestone: m, slice: s }
    : unit === 'complete-slice' ? { type: 'slice', id: s, milestone: m }
      : unit === 'complete-milestone' ? { type: 'milestone', id: m } : null;
  const delivery = deliveryPrefix ? {
    input: `${deliveryPrefix}-DELIVERY-INPUT.json`, output: `${deliveryPrefix}-DELIVERY.json`,
    verification: `${deliveryPrefix}-VERIFY-ENVELOPE.json`, artifact: `${deliveryPrefix}-ARTIFACT-ENVELOPE.json`,
  } : null;
  const required = delivery ? [...baseRequired, delivery.input, delivery.output] : baseRequired;
  const optional = unit.startsWith('research-') ? ['.gsd/CODING-STANDARDS.md'] : [];
  const deliveryOptional = delivery ? [delivery.verification, delivery.artifact] : [];
  const rules = delivery ? {
    [delivery.input]: { kind: 'input', unit: deliveryUnit },
    [delivery.output]: { kind: 'delivery', unit: deliveryUnit },
    [delivery.verification]: { kind: 'verification', unit: deliveryUnit },
    [delivery.artifact]: { kind: 'artifact', unit: deliveryUnit },
  } : {};
  return { required, allowed: [...required, ...deliveryOptional, ...optional], rules, delivery, milestone, slice };
}
// Reject links even when they point back into the workspace: replacing a link is
// not the same operation as publishing an artifact. Validate before mkdir/write.
function target(root, relative) {
  if (typeof relative !== 'string' || !relative.startsWith('.gsd/') || relative.includes('\\')
    || relative.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) fail('artifact-path-invalid');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('artifact-link-refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
function inspectArtifacts(value, allowed, required, maxPayloadBytes = Infinity, rules = {}, options = {}) {
  const bad = reason => ({ ok: false, reason });
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['done', 'partial', 'blocked'].includes(value.status)
    || typeof value.summary !== 'string' || !value.summary.trim()
    || !Array.isArray(value.questions) || !value.questions.every(q => typeof q === 'string' && q.trim())
    || !Array.isArray(value.artifacts)
    || Object.keys(value).some(k => !['status', 'summary', 'questions', 'artifacts'].includes(k))) return bad('schema-invalid');
  if (value.artifacts.length > 32) return bad('artifact-limit');
  const seen = new Set();
  for (const artifact of value.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || typeof artifact.path !== 'string' || typeof artifact.content !== 'string' || !artifact.content.trim()
      || Object.keys(artifact).some(k => !['path', 'content'].includes(k))) return bad('schema-invalid');
    if (!allowed.includes(artifact.path)) return bad('artifact-path-invalid');
    if (rules[artifact.path] && !inspectDeliveryContent(artifact.content, rules[artifact.path])) return bad('delivery-artifact-invalid');
    if (seen.has(artifact.path)) return bad('artifact-duplicate');
    if (Buffer.byteLength(artifact.content) > MAX_ARTIFACT_BYTES) return bad('artifact-limit');
    seen.add(artifact.path);
  }
  if (value.status === 'done' && value.questions.length) return bad('questions-on-done');
  if (options.forbidArtifactsOnNonDone && value.status !== 'done' && value.artifacts.length) return bad('artifacts-on-non-done');
  if (options.forbidArtifactsOnNonDone && (Buffer.byteLength(value.summary, 'utf8') > MAX_PREPARATION_SUMMARY_BYTES
      || value.questions.length > MAX_PREPARATION_QUESTIONS
      || value.questions.some(question => Buffer.byteLength(question, 'utf8') > MAX_PREPARATION_QUESTION_BYTES))) {
    return bad('payload-limit');
  }
  if (value.status === 'done' && !required.every(p => seen.has(p))) return bad('artifact-missing');
  if (Buffer.byteLength(JSON.stringify(value)) > maxPayloadBytes) return bad('payload-limit');
  return { ok: true };
}
function validateArtifacts(value, allowed, required, maxPayloadBytes, rules, options) {
  return inspectArtifacts(value, allowed, required, maxPayloadBytes, rules, options).ok;
}
function executeDeliveryArtifacts(request, loc, result, root, cwd) {
  if (result.status !== 'done') return [];
  if (!loc.delivery || !request.planFile) fail('delivery-plan-required');
  const planFile = fs.realpathSync(request.planFile);
  const planReference = path.relative(root, planFile).replace(/\\/g, '/');
  if (!planReference || path.isAbsolute(planReference) || planReference === '..' || planReference.startsWith('../')) {
    fail('delivery-plan-outside-context');
  }
  const planText = fs.readFileSync(planFile, 'utf8');
  const input = {
    schema_version: 1,
    unit: loc.rules[loc.delivery.input].unit,
    plan: planReference,
    plan_fingerprint: hash(planText),
    bindings: [],
    expected_children: [],
  };
  const delivery = require('./forge-delivery');
  const output = delivery.buildDelivery(input, { ownerRoot: root, codeDir: cwd });
  const deliveryReference = `./${path.posix.basename(loc.delivery.output)}`;
  const deliverySection = delivery.renderDeliveryMarkdown(output, { detailReference: deliveryReference });
  const artifacts = [
    { path: loc.required[0], content: `---\nstatus: done\n---\n\n# ${request.taskId} Summary\n\n${result.summary}\n\n## Must haves\n\n${JSON.stringify(result.must_haves_status, null, 2)}\n\n${deliverySection}` },
    { path: loc.delivery.input, content: `${JSON.stringify(input, null, 2)}\n` },
    { path: loc.delivery.output, content: `${JSON.stringify(output, null, 2)}\n` },
  ];
  const verdict = inspectArtifacts({ status: 'done', summary: result.summary, questions: [], artifacts },
    loc.allowed, loc.required, Infinity, loc.rules);
  if (!verdict.ok) fail('invalid-artifact-result', verdict.reason);
  return artifacts;
}
function markChecked(content, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`^(\\s*[-*] \\[) ([\\]]\\s+(?:\\*\\*)?${escaped}(?=[:\\s*]))`, 'm'), '$1x$2');
}
function materialize(request, record) {
  if (record.kind === 'memory-extraction') fail('memory-publication-required', 'Use publishReadyRecord for memory extraction receipts.');
  if (record.result.status !== 'done') return record.result;
  const root = fs.realpathSync(request.contextRoot || request.cwd);
  // Validate every target and conflict before publishing any file. Replay after
  // a crash accepts our exact content, never an unrelated edit since dispatch.
  for (const item of record.artifacts) {
    const file = target(root, item.path), current = fileHash(file);
    if (current !== item.before && current !== hash(item.content)) fail('artifact-conflict', `Artifact changed during dispatch: ${item.path}`);
  }
  for (const item of record.artifacts) {
    const file = target(root, item.path);
    if (fileHash(file) !== hash(item.content)) atomic(file, item.content);
  }
  return record.result;
}

function routeIdentity(route, unitType) {
  const value = route || {};
  return {
    unit_type: value.unit_type || unitType || null,
    model_requested: value.model_requested ?? null,
    model_resolved: value.model_resolved || value.model || null,
    resolved_worker_engine: value.resolved_worker_engine || null,
    worker_mode: value.worker_mode || null,
    effort: value.effort || null,
    effort_reason: value.effort_reason || null,
    dispatch_allowed: value.dispatch_allowed === true,
    ...effortTelemetry(value),
  };
}

// Additive effort/policy telemetry shared by receipts and sidecar-unit events.
// Requested and resolved come from the route. `effort_sent` is filled only
// with the argument an adapter actually passed to a launched transport (null
// before the spawn and after a pre-spawn refusal): a planned value is never
// reported as sent. Applied stays null because nothing reads it back.
function effortTelemetry(route, sent = null) {
  const value = route || {};
  return {
    effort_requested: value.effort_requested ?? value.effort ?? null,
    effort_resolved: value.effort || null,
    effort_sent: sent || null,
    effort_applied: null,
    policy_version: value.policy_version || null,
    policy_diagnostics: Array.isArray(value.policy_diagnostics) ? value.policy_diagnostics : [],
  };
}

function reviewFixUnitLabel(request) {
  const r = request || {}, boundary = r.reviewFix && r.reviewFix.boundary;
  if (boundary === 'milestone-triage') return `review-fix/${r.milestoneId || '-'}-triage`;
  return `review-fix/${(boundary === 'task' ? r.taskId : r.sliceId) || r.taskId || r.sliceId || '-'}`;
}

function unitLabel(request, loc) {
  if (loc && loc.reviewFix) return loc.reviewFix.unitLabel;
  return `${request.unitType}/${request.unitType === 'memory-extract' ? loc.sourceUnit : request.taskId || request.sliceId || request.milestoneId}`;
}

function artifactFingerprint(request) {
  const copy = { ...request };
  for (const key of ['rawResult', 'invocationTelemetry', 'providerCalled', 'resultFile',
    'signal', 'publicationSafe', 'publicationBoundary', 'waitForPublicationBoundary']) delete copy[key];
  return hash(JSON.stringify(copy));
}

function artifactAttemptFiles(request) {
  const cwd = fs.realpathSync(request.cwd);
  const root = fs.realpathSync(request.contextRoot || cwd);
  const resultFile = xllm.validateResultFileTarget(request.resultFile, cwd);
  xllm.validateResultFileTarget(resultFile, root);
  const receiptFile = `${resultFile}.receipt.json`;
  xllm.validateResultFileTarget(receiptFile, cwd);
  xllm.validateResultFileTarget(receiptFile, root);
  return { cwd, root, resultFile, receiptFile };
}

function beginArtifactAttempt(request) {
  const loc = locations(request);
  const files = artifactAttemptFiles(request);
  const fingerprint = artifactFingerprint(request);
  if (!request.dispatchId || !request.workflowId) fail('dispatch-identity-required');
  if (fs.existsSync(files.receiptFile)) {
    const record = JSON.parse(fs.readFileSync(files.receiptFile, 'utf8'));
    if (record.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
    if (record.phase === 'ready') return { state: 'ready', record, loc, files, fingerprint };
    if (record.phase === 'failed') fail(record.failure?.reason_code || 'artifact-attempt-failed');
    fail('sidecar-attempt-interrupted', 'The attempt is started without a durable result; inspect it before a new dispatch.');
  }
  const before = Object.fromEntries(loc.allowed.map(relative => [relative, fileHash(target(files.root, relative))]));
  const beforeState = Object.fromEntries(loc.allowed.map(relative => [relative, fileState(target(files.root, relative))]));
  const record = { phase: 'started', fingerprint, dispatch_id: request.dispatchId, before,
    before_state: beforeState,
    preparation_surface: request.scope === 'standalone-task' && request.route?.worker_mode === 'native'
      ? preparationSurfaceSnapshot(request) : null,
    request_fingerprint: request.preparationRequestFingerprint || null,
    preparation_identity: request.preparationIdentity || null,
    route: request.route, route_identity: routeIdentity(request.route, request.unitType), provider_called: false };
  fs.writeFileSync(files.receiptFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { state: 'started', record, loc, files, fingerprint };
}

async function replayArtifactAttempt(request) {
  const attempt = beginArtifactAttempt(request);
  if (attempt.state !== 'ready') return { replayed: false, attempt };
  const result = await publishReadyRecord(request, attempt.record);
  json(attempt.files.resultFile, result);
  return { replayed: true, provider_called: false, result, record: attempt.record };
}

function failArtifactAttempt(request, reasonCode, detail, providerCalled = false) {
  const files = artifactAttemptFiles(request);
  const fingerprint = artifactFingerprint(request);
  const current = fs.existsSync(files.receiptFile)
    ? JSON.parse(fs.readFileSync(files.receiptFile, 'utf8')) : null;
  if (current && current.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
  const failure = { status: 'failure', reason_code: reasonCode,
    provider_called: providerCalled === true, diagnostic: diagnostic(detail || 'adapter-failed'),
    recovery: 'operator-required' };
  if (!current || current.phase !== 'ready') {
    json(files.receiptFile, { ...(current || {}), phase: 'failed', fingerprint,
      dispatch_id: request.dispatchId, route: request.route,
      request_fingerprint: request.preparationRequestFingerprint || current?.request_fingerprint || null,
      preparation_identity: request.preparationIdentity || current?.preparation_identity || null,
      route_identity: routeIdentity(request.route, request.unitType), failure });
  }
  json(files.resultFile, failure);
  return failure;
}

async function acceptArtifactResult(request, rawResult, metadata = {}) {
  const loc = locations(request);
  const files = artifactAttemptFiles(request);
  const fingerprint = artifactFingerprint(request);
  if (!fs.existsSync(files.receiptFile)) fail('artifact-attempt-not-started');
  const existing = JSON.parse(fs.readFileSync(files.receiptFile, 'utf8'));
  if (existing.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
  if (existing.phase === 'ready') {
    const result = await publishReadyRecord(request, existing);
    json(files.resultFile, result);
    return { result, record: existing, replayed: true, provider_called: false };
  }
  if (existing.phase === 'failed') fail(existing.failure?.reason_code || 'artifact-attempt-failed');
  if (existing.phase !== 'started') fail('sidecar-attempt-interrupted');
  if (metadata.providerCalled !== true) fail('artifact-provider-call-unconfirmed');
  // A native preparation worker has only a prompt-level read-only contract.
  // Detect any canonical write before acceptance, even if its bytes happen to
  // equal the returned artifact. Ready replay after owner publication remains
  // valid because it takes the separate branch above.
  for (const relative of loc.allowed) {
    if (JSON.stringify(fileState(target(files.root, relative))) !== JSON.stringify(existing.before_state?.[relative] ?? null)) {
      fail('artifact-direct-write-detected');
    }
  }
  if (metadata.enforceReadOnlySurface === true
      && JSON.stringify(preparationSurfaceSnapshot(request)) !== JSON.stringify(existing.preparation_surface)) {
    fail('artifact-direct-write-detected');
  }
  if (/(?:token|secret|password|credential)\s*[:=]\s*[^\s"}]+/i.test(JSON.stringify(rawResult))) {
    const error = new Error('Secret-like provider output refused.');
    error.code = 'secret-output';
    error.diagnostic = diagnostic('secret-output');
    throw error;
  }
  const verdict = inspectArtifacts(rawResult, loc.allowed, loc.required,
    metadata.maxPayloadBytes === undefined ? Infinity : metadata.maxPayloadBytes, loc.rules,
    { forbidArtifactsOnNonDone: loc.preparation === true });
  if (!verdict.ok) {
    const error = new Error('Invalid artifact result.');
    error.code = 'invalid-artifact-result';
    error.diagnostic = diagnostic(verdict.reason);
    throw error;
  }
  xllm.assertUntrustedOutputBarrier(rawResult);
  const artifacts = rawResult.status === 'done' ? rawResult.artifacts : [];
  const record = { phase: 'ready', fingerprint, dispatch_id: request.dispatchId,
    request_fingerprint: request.preparationRequestFingerprint || null,
    preparation_identity: request.preparationIdentity || existing.preparation_identity || null,
    route: request.route, route_identity: routeIdentity(request.route, request.unitType),
    provider_called: true, telemetry: metadata.telemetry || null, result: rawResult,
    artifacts: artifacts.map(artifact => ({ ...artifact, before: existing.before[artifact.path] ?? null })) };
  json(files.receiptFile, record);
  const result = await publishReadyRecord(request, record);
  json(files.resultFile, result);
  return { result, record, replayed: false, provider_called: true };
}
function memorySourceContext(request, record) {
  const sourcePayload = {
    summaryContent: request.summaryContent || '', sourceResult: request.sourceResult || '',
    keyDecisions: request.keyDecisions || [], existingMemory: request.existingMemory || { facts: [], stats: [] },
  };
  return {
    unitId: record.source_unit,
    ...(request.milestoneId ? { milestoneId: request.milestoneId } : {}),
    extractionId: record.extraction_id,
    extractedAt: record.extracted_at,
    source: {
      sourceUnit: `${request.sourceUnitType || 'unit'}/${record.source_unit}`,
      sourceFingerprint: request.sourceFingerprint || hash(JSON.stringify(sourcePayload)),
      dispatchId: record.dispatch_id,
      model: record.model,
      effort: record.effort,
    },
  };
}
function memoryPrompt(request, sourceUnit) {
  const input = {
    unit_type: request.sourceUnitType || 'unit', unit_id: sourceUnit,
    milestone_id: request.milestoneId || null, summary_content: request.summaryContent || '',
    result_block: request.sourceResult || '', key_decisions: request.keyDecisions || [],
    existing_memory: request.existingMemory || { facts: [], stats: [] },
  };
  return 'Read-only memory extraction. Return exactly one JSON object matching the supplied schema. '
    + 'Do not write files, run commands, choose paths, or return owner identity/publication metadata.\n'
    + `CONTRACT:\n${MEMORY_QUALITY_CONTRACT}\nINPUT:\n${JSON.stringify(input)}\nSCHEMA:\n${JSON.stringify(memorySchema)}`;
}
function memoryBoundarySafe(request) {
  const boundary = request.publicationBoundary;
  const snapshots = boundary && Array.isArray(boundary.protectedSnapshots) ? boundary.protectedSnapshots : null;
  return request.publicationSafe === true && boundary && boundary.ownerJoined === true
    && typeof boundary.checkedAt === 'string' && Number.isFinite(Date.parse(boundary.checkedAt)) && snapshots
    && snapshots.every(snapshot => snapshot && snapshot.state === 'ended' && typeof snapshot.id === 'string');
}
function telemetryScalar(value) {
  if (value === null || value === undefined) return null;
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  const normalized = String(value).replace(/[\r\n\u0000]/g, ' ').trim();
  return normalized ? normalized.slice(0, 256) : null;
}
// Copy a transport observation into a receipt only as a sanitized pair; an
// unpaired or absent value stays unknown (null/null), never a guess.
function observedModelTelemetry(telemetry) {
  const raw = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry) ? telemetry : {};
  const observed = telemetryScalar(raw.model_observed);
  const source = telemetryScalar(raw.model_observed_source);
  return { model_observed: observed && source ? observed : null,
    model_observed_source: observed && source ? source : null };
}
function memoryTelemetry(record) {
  const raw = record && record.telemetry && typeof record.telemetry === 'object' && !Array.isArray(record.telemetry)
    ? record.telemetry : {};
  const observed = telemetryScalar(raw.model_observed);
  const observedSource = telemetryScalar(raw.model_observed_source);
  const effortApplied = telemetryScalar(raw.effort_applied);
  const effortAppliedSource = telemetryScalar(raw.effort_applied_source);
  return {
    model_requested: telemetryScalar(raw.model_requested),
    model_resolved: telemetryScalar(raw.model_resolved || record.model),
    model_argument: telemetryScalar(raw.model_argument),
    model_observed: observed && observedSource ? observed : null,
    model_observed_source: observed && observedSource ? observedSource : null,
    effort_requested: telemetryScalar(raw.effort_requested),
    effort_resolved: telemetryScalar(raw.effort_resolved || record.effort),
    effort_argument: telemetryScalar(raw.effort_argument),
    effort_binding_observed: telemetryScalar(raw.effort_binding_observed),
    effort_binding_observed_source: telemetryScalar(raw.effort_binding_observed_source),
    effort_applied: effortApplied && effortAppliedSource ? effortApplied : null,
    effort_applied_source: effortApplied && effortAppliedSource ? effortAppliedSource : null,
  };
}
function memoryPublicationReason(publication) {
  const status = publication && publication.status;
  const reason = telemetryScalar(publication && publication.reason);
  if (!reason) return null;
  if (status === 'conflict') return 'memory-publication-conflict';
  if (status === 'quarantined') return reason === 'grouped-member' ? reason : 'memory-publication-quarantined';
  if (status === 'noop' && /^(?:replay|empty|empty-extraction|result-(?:partial|blocked|error)|worker-(?:partial|blocked|error))$/.test(reason)) {
    return reason;
  }
  return 'memory-publication-detail-redacted';
}
function appendMemoryPublicationEvent(request, record, result) {
  if (!memoryBoundarySafe(request) || result.publication?.status === 'deferred') return null;
  const root = fs.realpathSync(request.contextRoot || request.cwd);
  const eventsFile = target(root, '.gsd/forge/events.jsonl');
  const publicationStatus = telemetryScalar(result.publication?.status);
  const publicationReason = memoryPublicationReason(result.publication);
  const eventBase = `memory-publication:${hash(`${record.dispatch_id}\0${record.extraction_id}`).slice(0, 24)}`;
  const eventId = `${eventBase}:${hash(`${publicationStatus}\0${publicationReason || ''}`).slice(0, 12)}`;
  if (fs.existsSync(eventsFile)) {
    const prior = fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).flatMap(line => {
      if (!line.includes(eventBase)) return [];
      try { const parsed = JSON.parse(line); return parsed.event === 'memory-publication' ? [parsed] : []; } catch { return []; }
    });
    if (prior.some(event => event.event_id === eventId)
        || (publicationStatus === 'noop' && publicationReason === 'replay' && prior.length > 0)) return null;
  }
  const route = request.route || {};
  const telemetry = memoryTelemetry(record);
  const event = {
    ts: request.publicationBoundary.checkedAt,
    event: 'memory-publication', event_id: eventId,
    workflow_id: telemetryScalar(request.workflowId), dispatch_id: telemetryScalar(record.dispatch_id),
    extraction_id: telemetryScalar(record.extraction_id), unit: `memory-extract/${record.source_unit}`,
    host_runtime: telemetryScalar(route.host_runtime || request.hostRuntime),
    worker_engine: telemetryScalar(route.resolved_worker_engine),
    worker_mode: telemetryScalar(route.worker_mode), status: telemetryScalar(result.status),
    publication_status: publicationStatus,
    publication_reason: publicationReason,
    ...telemetry,
  };
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
  return event;
}
// Review-fix publication, parent-owned and replayable from a ready receipt:
//   1. commit (only git + auto_commit) with a durable intent persisted first and
//      trailer reconciliation, so a crash between commit and receipt never
//      produces a second commit;
//   2. per-R# outcome lines in the parent-derived REVIEW.md files (idempotent);
//   3. the result-file payload. No provider is involved at any step.
function publishReviewFixRecord(request, record) {
  const reviewFix = require('./forge-review-fix');
  const loc = locations(request);
  const files = artifactAttemptFiles(request);
  const result = record.result;
  let commit = record.publication && record.publication.commit;
  if (!commit || commit.state !== 'done') {
    // The verified files must still hold the bytes the worker left at ready
    // time. Any concurrent edit (between the response and this publication or
    // a replay) is refused before any commit: other work is never committed.
    // Reconciliation uses the independently captured normalized Git blobs.
    const expected = record.verified_hashes || {};
    const current = verifiedHashes(files.cwd, result.verified_paths);
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      fail('review-fix-concurrent-change', 'Verified files changed after the worker result; nothing was committed or published.');
    }
    // REVIEW.md lines are written only after the commit is durable, so until
    // then every REVIEW.md must still be byte-identical to the pre-turn
    // snapshot. A review edited meanwhile refuses BEFORE any commit.
    reviewFix.assertReviewSnapshot({ root: files.root, resolveTarget: target, expectedHashes: record.review_snapshot });
    if (request.constraints?.auto_commit === true && result.vcs !== 'svn' && !Array.isArray(result.repo_baselines)
      && !record.verified_git_blobs) {
      fail('review-fix-git-identity-missing', 'Legacy receipt has no pre-commit Git identity; nothing was committed or published.');
    }
    if (!commit) {
      record.publication = { ...(record.publication || {}), commit: { state: 'intent', dispatch_id: record.dispatch_id } };
      json(files.receiptFile, record);
    }
    const outcome = Array.isArray(result.repo_baselines)
      ? { sha: null, reason: 'multi-repo-commit-not-owned' }
      : reviewFix.commitVerified({ cwd: files.cwd, vcs: result.vcs === 'svn' ? 'svn' : 'git',
        autoCommit: Boolean(request.constraints && request.constraints.auto_commit === true),
        paths: result.verified_paths, preDirty: result.pre_dirty, startSha: result.start_sha,
        dispatchId: record.dispatch_id, unitId: reviewFix.unitIdFor(loc.reviewFix), expectedBlobs: record.verified_git_blobs });
    if (outcome.reason === 'reconciled-commit-mismatch') {
      fail('review-fix-concurrent-change', 'The commit carrying this dispatch id does not match the verified files; nothing was published.');
    }
    commit = { state: 'done', sha: outcome.sha, reason: outcome.reason, ...(outcome.reconciled ? { reconciled: true } : {}) };
    record.publication = { ...(record.publication || {}), commit };
    json(files.receiptFile, record);
  }
  const requested = reviewFix.normalizeItems(request.reviewFix.items);
  const items = result.items.map(item => ({ r: item.r, ...(item.review_file ? { review_file: item.review_file } : {}), outcome: item.outcome, verified: item.verified === true,
    commit_sha: item.verified === true ? commit.sha : null }));
  reviewFix.applyReviewOutcomes({ root: files.root, resolveTarget: target, expectedHashes: record.review_snapshot,
    outcomes: items.map(item => ({
    r: item.r,
    reviewFile: reviewFix.reviewFileFor(loc.reviewFix, reviewFix.correlateReviewItem(item, requested)),
    line: reviewFix.outcomeLine(loc.reviewFix.boundary, { verified: item.verified, commitSha: commit.sha, commitReason: commit.reason }),
  })) });
  return { status: result.status, contract: 'review-fix', boundary: loc.reviewFix.boundary, unit: loc.reviewFix.unitLabel,
    items, files_changed: result.files_changed, commit_sha: commit.sha, commit_reason: commit.reason,
    provider_called: true, dispatch_id: record.dispatch_id, telemetry: record.telemetry || null };
}

// sha256 per verified path (null when the fix deleted the file), sorted keys.
function verifiedHashes(cwd, paths) {
  const out = {};
  for (const relative of [...new Set(paths || [])].sort()) {
    try { out[relative] = hash(fs.readFileSync(path.join(cwd, relative))); }
    catch { out[relative] = null; }
  }
  return out;
}

// Failed attempts: surgical reset of what the worker touched (never pre-existing
// work), then every item is published as failed/deferred. Overlap with a
// pre-dirty file resets nothing and requires the operator.
function resetReviewFixAttempt(request, state) {
  let reset;
  try {
    reset = require('./forge-surgical-reset').resetFailedAttempt(state.stateFile, {
      mode: 'execute', failed: true, repoRoots: state.repoRoots, codeDir: state.cwd,
    });
  } catch (error) {
    reset = { ok: false, reason_code: error.code || 'reset-failed' };
  }
  const detail = reset.reset || {};
  return {
    verified: reset.ok === true,
    reason_code: reset.reason_code,
    restored: Array.isArray(detail.restored) ? detail.restored.length : 0,
    removed: Array.isArray(detail.removed) ? detail.removed.length : 0,
    overlap: Array.isArray(detail.overlap) ? detail.overlap.map(entry => (typeof entry === 'string' ? entry : entry.path)) : [],
  };
}

function publishReviewFixFailure(request, loc, items, snapshot) {
  const reviewFix = require('./forge-review-fix');
  const root = fs.realpathSync(request.contextRoot || request.cwd);
  try {
    reviewFix.applyReviewOutcomes({ root, resolveTarget: target, expectedHashes: snapshot, outcomes: items.map(item => ({
      r: item.r, reviewFile: reviewFix.reviewFileFor(loc.reviewFix, item),
      line: reviewFix.outcomeLine(loc.reviewFix.boundary, { verified: false }),
    })) });
    return null;
  } catch (error) {
    return error.code || 'review-fix-publication-failed';
  }
}

async function publishReadyRecord(request, record) {
  if (record.kind === 'review-fix') return publishReviewFixRecord(request, record);
  if (record.kind !== 'memory-extraction') return materialize(request, record);
  const extraction = record.extraction;
  if (extraction.status !== 'done') {
    const result = { status: extraction.status, extraction,
      ...(record.telemetry ? { telemetry: record.telemetry } : {}),
      publication: { status: 'noop', reason: `worker-${extraction.status}` } };
    appendMemoryPublicationEvent(request, record, result);
    return result;
  }
  if (!extraction.facts.length && !extraction.events.length) {
    const result = { status: 'done', extraction, ...(record.telemetry ? { telemetry: record.telemetry } : {}),
      publication: { status: 'noop', reason: 'empty-extraction' } };
    appendMemoryPublicationEvent(request, record, result);
    return result;
  }
  // Auto may finish inference while another worker snapshot is protected. Keep
  // the durable ready receipt and replay publication after the owner joins it.
  if (!memoryBoundarySafe(request)) {
    return { status: 'done', extraction, ...(record.telemetry ? { telemetry: record.telemetry } : {}),
      publication: { status: 'deferred', reason: 'protected-boundary-not-confirmed' } };
  }
  if (typeof request.waitForPublicationBoundary === 'function') await request.waitForPublicationBoundary();
  const { publishExtraction } = require('./forge-memory-extraction');
  const publication = await publishExtraction({ cwd: request.contextRoot || request.cwd, extraction,
    sourceContext: memorySourceContext(request, record) });
  const result = { status: 'done', extraction, ...(record.telemetry ? { telemetry: record.telemetry } : {}), publication };
  appendMemoryPublicationEvent(request, record, result);
  return result;
}
function appendNativeMemoryFailureEvent(request, loc, failure) {
  const route = request.route || {};
  const record = {
    dispatch_id: request.dispatchId,
    extraction_id: request.extractionId || request.dispatchId,
    source_unit: loc.sourceUnit,
    model: route.model_resolved || route.model || null,
    effort: route.effort || null,
    telemetry: failure.telemetry || request.invocationTelemetry || null,
  };
  appendMemoryPublicationEvent(request, record, {
    status: failure.status,
    publication: { status: 'noop', reason: 'worker-error' },
  });
}
function nativeReceiptFiles(request) {
  const cwd = fs.realpathSync(request.cwd), root = fs.realpathSync(request.contextRoot || cwd);
  const resultFile = xllm.validateResultFileTarget(request.resultFile, cwd);
  xllm.validateResultFileTarget(resultFile, root);
  const receiptFile = `${resultFile}.receipt.json`;
  xllm.validateResultFileTarget(receiptFile, cwd);
  xllm.validateResultFileTarget(receiptFile, root);
  return { cwd, root, resultFile, receiptFile };
}
function nativeMemoryFingerprint(request) {
  return hash(JSON.stringify({ ...request, unitType: 'memory-extract', rawResult: undefined, invocationTelemetry: undefined,
    resultFile: undefined, publicationSafe: undefined, publicationBoundary: undefined,
    waitForPublicationBoundary: undefined }));
}
function nativeMemoryRouteIdentity(request) {
  const r = request || {}, route = r.route || {};
  const routeModel = route.model_resolved || route.model || null;
  const routeEffort = route.effort || null;
  if (!routeModel || !routeEffort
      || (r.model !== undefined && r.model !== routeModel)
      || (r.effort !== undefined && r.effort !== routeEffort)) {
    fail('native-memory-route-mismatch', 'Native memory identity must match the authoritative resolved route and invocation telemetry.');
  }
  return { model: routeModel, effort: routeEffort };
}
function nativeMemoryIdentity(request, durableTelemetry) {
  const r = request || {}, route = r.route || {};
  const identity = nativeMemoryRouteIdentity(r);
  const telemetry = durableTelemetry === undefined ? r.invocationTelemetry : durableTelemetry;
  const required = ['model_requested', 'model_resolved', 'model_argument', 'model_observed',
    'model_observed_source', 'effort_requested', 'effort_resolved', 'effort_argument',
    'effort_transport', 'effort_transport_value', 'effort_transport_source',
    'effort_binding_observed', 'effort_binding_observed_source', 'effort_binding_observed_fingerprint',
    'effort_applied', 'effort_applied_source', 'capabilities_source'];
  // Model-policy marks emitted by the native adapter only for entries that
  // declare them (Sonnet 5.5 alias-only); closed values, never observations.
  const optional = ['model_version_proof', 'policy_diagnostics'];
  if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)
      || required.some(key => !Object.prototype.hasOwnProperty.call(telemetry, key))
      || Object.keys(telemetry).some(key => !required.includes(key) && !optional.includes(key))
      || (Object.prototype.hasOwnProperty.call(telemetry, 'model_version_proof') && telemetry.model_version_proof !== 'alias-only')
      || (Object.prototype.hasOwnProperty.call(telemetry, 'policy_diagnostics') && !Array.isArray(telemetry.policy_diagnostics))) {
    fail('native-memory-telemetry-invalid', 'Native memory publication requires the complete adapter telemetry envelope.');
  }
  const host = route.host_runtime || r.hostRuntime;
  const paired = (value, source) => (value === null && source === null)
    || (typeof value === 'string' && value && typeof source === 'string' && source);
  const commonMismatch = telemetry.model_requested !== (route.model_requested ?? null)
    || telemetry.model_resolved !== identity.model
    || telemetry.effort_resolved !== identity.effort
    // The adapter reports the resolver's pre-clamp value when the route has it.
    || telemetry.effort_requested !== (route.effort_requested || identity.effort)
    || typeof telemetry.model_argument !== 'string' || !telemetry.model_argument
    || typeof telemetry.capabilities_source !== 'string' || !telemetry.capabilities_source
    || !paired(telemetry.model_observed, telemetry.model_observed_source)
    || !paired(telemetry.effort_applied, telemetry.effort_applied_source)
    || (telemetry.effort_applied !== null && telemetry.effort_applied !== identity.effort);
  const codexMismatch = host === 'codex' && (telemetry.model_argument !== identity.model
    || telemetry.effort_argument !== identity.effort
    || telemetry.effort_transport !== 'native-argument'
    || telemetry.effort_transport_value !== identity.effort
    || typeof telemetry.effort_transport_source !== 'string' || !telemetry.effort_transport_source
    || telemetry.effort_binding_observed !== null
    || telemetry.effort_binding_observed_source !== null
    || telemetry.effort_binding_observed_fingerprint !== null);
  // Claude: the alias, or the exact resolved id when the active tool listed it.
  const claudeMismatch = host === 'claude' && ((telemetry.model_argument !== route.alias
      && telemetry.model_argument !== identity.model)
    || (telemetry.model_argument === identity.model && Object.prototype.hasOwnProperty.call(telemetry, 'model_version_proof'))
    || telemetry.effort_argument !== null
    || telemetry.effort_transport !== 'agent-frontmatter'
    || telemetry.effort_transport_value !== identity.effort
    || telemetry.effort_binding_observed !== identity.effort
    || typeof telemetry.effort_transport_source !== 'string' || !telemetry.effort_transport_source
    || typeof telemetry.effort_binding_observed_source !== 'string' || !telemetry.effort_binding_observed_source
    || telemetry.effort_binding_observed_source !== telemetry.effort_transport_source
    || typeof telemetry.effort_binding_observed_fingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(telemetry.effort_binding_observed_fingerprint));
  if (!['codex', 'claude'].includes(host) || commonMismatch || codexMismatch || claudeMismatch) {
    fail('native-memory-telemetry-mismatch', 'Native memory telemetry must describe the exact resolved route and adapter transport.');
  }
  return identity;
}
function normalizedNativeFailure(request) {
  const raw = request && request.nativeFailure;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof raw.reason_code !== 'string' || !/^[a-z0-9-]{1,80}$/.test(raw.reason_code)) {
    fail('native-memory-failure-invalid', 'Native memory failure requires a bounded machine-readable reason_code.');
  }
  if (raw.provider_called === true) nativeMemoryIdentity(request, raw.telemetry);
  const telemetry = memoryTelemetry({ telemetry: raw.telemetry || null });
  return {
    status: 'failure', reason_code: raw.reason_code,
    provider_called: raw.provider_called === true,
    telemetry,
    publication: { status: 'noop', reason: 'worker-error' },
  };
}
function acceptNativeMemoryFailure(request, loc) {
  const r = request || {};
  nativeMemoryRouteIdentity(r);
  const files = nativeReceiptFiles(r);
  const fingerprint = nativeMemoryFingerprint(r);
  const proposed = normalizedNativeFailure(r);
  let failure = proposed;
  if (fs.existsSync(files.receiptFile)) {
    const existing = JSON.parse(fs.readFileSync(files.receiptFile, 'utf8'));
    if (existing.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
    if (existing.phase !== 'failed' || !existing.failure) fail('dispatch-identity-conflict');
    failure = existing.failure;
  } else {
    json(files.receiptFile, { phase: 'failed', fingerprint, dispatch_id: r.dispatchId, failure: proposed });
  }
  json(files.resultFile, failure);
  appendNativeMemoryFailureEvent(r, loc, failure);
  return failure;
}
async function acceptNativeMemoryResult(request) {
  const r = request || {}, loc = locations({ ...r, unitType: 'memory-extract' });
  if (!r.dispatchId || !r.workflowId) fail('dispatch-identity-required');
  if (r.nativeFailure !== undefined && r.rawResult !== undefined) {
    fail('native-memory-failure-invalid', 'Native memory acceptance cannot contain both a result and a failure.');
  }
  if (r.nativeFailure !== undefined) return acceptNativeMemoryFailure(r, loc);
  const files = nativeReceiptFiles(r);
  const fingerprint = nativeMemoryFingerprint(r);
  const existing = fs.existsSync(files.receiptFile) ? JSON.parse(fs.readFileSync(files.receiptFile, 'utf8')) : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
    if (existing.phase === 'ready') {
      const replayIdentity = nativeMemoryIdentity(r, existing.telemetry);
      if (existing.model !== replayIdentity.model || existing.effort !== replayIdentity.effort) {
        fail('native-memory-telemetry-mismatch', 'The durable receipt identity does not match its adapter telemetry.');
      }
      const replayed = await publishReadyRecord(r, existing);
      json(files.resultFile, replayed);
      return replayed;
    }
    if (existing.phase === 'failed') fail(existing.failure?.reason_code || 'native-memory-attempt-failed');
    if (existing.phase !== 'started' || r.rawResult === undefined) fail('native-memory-attempt-interrupted');
  } else {
    fs.writeFileSync(files.receiptFile, JSON.stringify({ phase: 'started', fingerprint,
      dispatch_id: r.dispatchId }), { flag: 'wx', mode: 0o600 });
  }
  try {
    const identity = nativeMemoryIdentity(r);
    const extraction = require('./forge-memory-extraction').validateExtractionResult(r.rawResult,
      { sourceUnit: loc.sourceUnit });
    const record = { phase: 'ready', kind: 'memory-extraction', fingerprint,
      dispatch_id: r.dispatchId, extraction_id: r.extractionId || r.dispatchId,
      extracted_at: r.extractedAt || new Date().toISOString(), source_unit: loc.sourceUnit,
      model: identity.model, effort: identity.effort,
      telemetry: r.invocationTelemetry || null, extraction, artifacts: [] };
    json(files.receiptFile, record);
    const delivered = await publishReadyRecord(r, record);
    json(files.resultFile, delivered);
    return delivered;
  } catch (error) {
    const failure = { status: 'failure', reason_code: error.code || 'memory-extraction-invalid' };
    const current = JSON.parse(fs.readFileSync(files.receiptFile, 'utf8'));
    if (current.phase !== 'ready') json(files.receiptFile, { phase: 'failed', fingerprint,
      dispatch_id: r.dispatchId, failure });
    json(files.resultFile, failure);
    throw error;
  }
}
function candidateFromNativeResult(result) {
  const value = result && result.result !== undefined ? result.result : result;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.schema_version !== undefined) return value;
    if (value.result_json && typeof value.result_json === 'object') return value.result_json;
  }
  const text = value && typeof value === 'object' ? (value.finalText || value.output || value.text) : value;
  return typeof text === 'string' ? xllm.extractLastJsonBlock(text) : null;
}
async function runNativeMemory(request, invoke) {
  const r = request || {};
  if (r.policy && r.policy.decision !== 'extract') {
    return { status: 'skipped', reason: r.policy.reason || 'memory-policy-skip', provider_called: false };
  }
  const loc = locations({ ...r, unitType: 'memory-extract' });
  nativeMemoryRouteIdentity(r);
  const receiptFiles = nativeReceiptFiles(r);
  if (fs.existsSync(receiptFiles.receiptFile)) {
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptFiles.receiptFile, 'utf8'));
      if (receipt.phase !== 'ready') return { status: 'failure',
        reason_code: receipt.failure?.reason_code || 'native-memory-attempt-interrupted',
        provider_called: false, replayed: false };
      const delivered = await acceptNativeMemoryResult({ ...r, unitType: 'memory-extract', rawResult: undefined });
      return { status: 'done', ...delivered, provider_called: false, replayed: true };
    } catch (error) {
      return { status: 'failure', reason_code: error.code || 'native-memory-replay-failed', provider_called: false };
    }
  }
  const nativeOptions = {
    hostRuntime: r.hostRuntime || r.route?.host_runtime, resolvedDispatch: r.route,
    activeCapabilities: r.activeCapabilities,
    taskName: r.taskName || `memory_${loc.sourceUnit}_${r.dispatchId}`,
    prompt: memoryPrompt(r, loc.sourceUnit), agentType: 'forge-memory', forkTurns: r.forkTurns || 'none',
    effortBinding: r.effortBinding,
    readback: r.readback,
  };
  const invocationApi = require('./forge-native-invocation');
  const prepared = invocationApi.buildNativeInvocation(nativeOptions);
  if (!prepared.ok) {
    const failure = { status: 'failure', reason_code: prepared.reason_code,
      hint: prepared.hint, provider_called: false, telemetry: prepared.telemetry };
    appendNativeMemoryFailureEvent(r, loc, failure);
    return failure;
  }
  const fingerprint = nativeMemoryFingerprint(r);
  fs.writeFileSync(receiptFiles.receiptFile, JSON.stringify({ phase: 'started', fingerprint,
    dispatch_id: r.dispatchId }), { flag: 'wx', mode: 0o600 });
  let providerCalled = false;
  const native = await invocationApi.invokeNative(nativeOptions, async (...args) => {
    providerCalled = true;
    return invoke(...args);
  });
  if (!native.ok) {
    const failure = { status: 'failure', reason_code: native.reason_code,
      hint: native.hint, provider_called: providerCalled, telemetry: native.telemetry };
    json(receiptFiles.receiptFile, { phase: 'failed', fingerprint, dispatch_id: r.dispatchId, failure });
    json(receiptFiles.resultFile, failure);
    appendNativeMemoryFailureEvent(r, loc, failure);
    return failure;
  }
  try {
    const delivered = await acceptNativeMemoryResult({ ...r, unitType: 'memory-extract',
      rawResult: candidateFromNativeResult(native), invocationTelemetry: native.telemetry });
    return { status: 'done', ...delivered, telemetry: native.telemetry, provider_called: true };
  } catch (error) {
    return { status: 'failure', reason_code: error.code || 'memory-extraction-invalid',
      provider_called: true, telemetry: native.telemetry };
  }
}
async function runUnitSidecarCore(request, runtime, identity) {
  const r = request || {}, route = r.route || {};
  const transport = capability(route.resolved_worker_engine, r.unitType, r);
  if (!transport.supported) fail(transport.reason_code, transport.hint);
  const guard = evaluateDispatchGuard({ ...route, unit_type: r.unitType });
  if (route.dispatch_allowed !== true || route.worker_mode !== 'sidecar' || !route.sidecar_declared
    || !guard.dispatch_allowed) fail(guard.reason_code || 'route-refused', guard.hint);
  const authoritativeModel = route.model_resolved || route.model;
  if (!authoritativeModel
      || (route.model_resolved && route.model && route.model_resolved !== route.model)
      || (route.resolved_worker_engine === 'codex' && route.sidecar_model
        && route.sidecar_model !== authoritativeModel)) {
    fail('route-model-identity-mismatch', 'The sidecar model must equal the authoritative resolved model.');
  }
  const model = route.resolved_worker_engine === 'codex'
    ? (route.sidecar_model || authoritativeModel) : authoritativeModel;
  if (!model || !route.effort) fail('resolved-route-required');
  const family = require('./forge-model-alias').modelFamily(model);
  if ((family === 'gpt' ? 'codex' : family) !== route.resolved_worker_engine) {
    fail('route-model-engine-mismatch', 'The resolved model does not belong to the worker engine. Correct the route/model preference before retrying.');
  }
  const cwd = fs.realpathSync(r.cwd), root = fs.realpathSync(r.contextRoot || cwd);
  const resultFile = xllm.validateResultFileTarget(r.resultFile, cwd);
  // Both code and context roots are worker-readable; neither owns the result.
  xllm.validateResultFileTarget(resultFile, root);
  const loc = locations(r);
  const dispatchId = xllm.normalizeDispatchId(r.dispatchId, 'unit');
  identity.dispatch_id = dispatchId;
  identity.model_sent = model;
  if (!r.dispatchId || !r.workflowId) fail('dispatch-identity-required');
  const fingerprint = artifactFingerprint(r);
  const receiptFile = `${resultFile}.receipt.json`;
  xllm.validateResultFileTarget(receiptFile, cwd);
  xllm.validateResultFileTarget(receiptFile, root);
  const eventsFile = target(root, '.gsd/forge/events.jsonl');
  const label = unitLabel(r, loc);
  function event(status, reasonCode, detail, providerCalled = false, extra = null) {
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), event: 'sidecar-unit',
      workflow_id: r.workflowId, dispatch_id: dispatchId,
      unit: label,
      host_runtime: route.host_runtime, worker_engine: route.resolved_worker_engine,
      worker_mode: 'sidecar', model, tier: route.tier, effort: route.effort,
      model_requested: route.model_requested ?? null,
      model_resolved: route.model_resolved || route.model || null,
      effort_reason: route.effort_reason || null,
      status, provider_called: providerCalled === true, ...(reasonCode ? { reason_code: reasonCode } : {}),
      ...(detail ? { diagnostic: diagnostic(detail.reason, detail) } : {}),
      ...effortTelemetry(route), ...(extra || {}) }) + '\n');
  }
  function recordFailure(error, extra = null) {
    const code = error.code || 'sidecar-unit-failed';
    const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const detail = diagnostic(error.diagnostic?.reason || (code === 'untrusted-output-barrier'
      ? 'control-data-output' : record.phase === 'ready' ? 'publication-failed' : 'adapter-failed'), error.diagnostic);
    if (record.phase === 'ready') error.stage = 'publication';
    error.diagnostic = detail;
    const failure = { status: 'adapter-failed', dispatch_id: dispatchId, reason_code: code,
      provider_called: error.provider_called === true,
      error_class: xllm.classifyErrorClass(error.message), diagnostic: detail,
      recovery: record.phase === 'ready' ? 'replay-publication' : 'operator-required',
      failed_at: new Date().toISOString(), ...(record.phase === 'ready' ? {} : (extra || {})) };
    // Never overwrite the validated response if publication was interrupted.
    if (record.phase !== 'ready') json(receiptFile, { ...record, phase: 'failed', failure });
    json(resultFile, failure);
    event('failed', code, detail, failure.provider_called,
      loc.reviewFix ? { boundary: loc.reviewFix.boundary, items_total: reviewFixItemsTotal(r) } : null);
  }
  const existing = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
    if (existing.phase === 'ready') {
      runtime.announce?.('reaproveitado', { ...identity, provider_called: false });
      try {
        const result = await publishReadyRecord(r, existing);
        json(resultFile, result);
        return result;
      } catch (error) { recordFailure(error); throw error; }
    }
    if (existing.phase === 'failed') {
      runtime.announce?.('reaproveitado', { ...identity, reason_code: existing.failure?.reason_code, provider_called: false });
      const error = new Error('Recorded sidecar attempt failed; no provider was relaunched.');
      error.code = existing.failure.reason_code;
      error.diagnostic = diagnostic(existing.failure.diagnostic?.reason, existing.failure.diagnostic);
      json(resultFile, existing.failure);
      throw error;
    }
    fail('sidecar-attempt-interrupted', 'Inspect the recorded heartbeat/process and recover this attempt before retrying with a new dispatch id. No worker was relaunched.');
  }
  const before = Object.fromEntries(loc.allowed.map(p => [p, fileHash(target(root, p))]));
  // Pre-capture every existing task target. New targets have a null baseline;
  // a concurrently created plan is a conflict, not permission to overwrite it.
  if (transport.mode === 'plan') {
    const dir = target(root, `${loc.slice}/tasks`);
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^T\d+-PLAN\.md$/.test(name)) : []) {
      const p = `${loc.slice}/tasks/${name}`;
      before[p] = fileHash(target(root, p));
    }
  }
  const bookkeeping = r.unitType === 'complete-slice' ? `${loc.milestone}/${r.milestoneId}-ROADMAP.md`
    : r.unitType === 'execute-task' ? `${loc.slice}/${r.sliceId}-PLAN.md` : null;
  const bookkeepingText = bookkeeping && fs.readFileSync(target(root, bookkeeping), 'utf8');
  if (bookkeeping) before[bookkeeping] = hash(bookkeepingText);
  // Review-fix: boundary and claim are validated, then the surgical-reset state
  // is captured, all BEFORE the started receipt. A refusal here leaves no
  // receipt and never reaches a provider.
  const fix = transport.mode === 'fix' ? prepareReviewFix(r, loc, { cwd, root, resultFile, route, dispatchId }) : null;
  const startedAt = new Date().toISOString();
  // Exclusive creation arbitrates concurrent invocations of the same attempt.
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'started', fingerprint, dispatch_id: dispatchId, before,
    request_fingerprint: r.preparationRequestFingerprint || null,
    preparation_identity: r.preparationIdentity || null,
    ...(fix ? { kind: 'review-fix', review_fix_identity: fix.brief.identity, reset_state_file: fix.stateFile,
      route_identity: routeIdentity(route, r.unitType), review_snapshot: fix.reviewSnapshot } : {}) }),
  { flag: 'wx', mode: 0o600 });
  event('started', null, null, false, fix ? { boundary: loc.reviewFix.boundary, items_total: fix.items.length } : null);
  const dispatchEvent = require('./forge-dispatch-event').buildDispatchEvent({
    unit: label,
    milestone: r.milestoneId,
    slice: r.sliceId, dispatchId, model, engine: route.resolved_worker_engine,
    transport: route.resolved_worker_engine === 'claude' ? 'claude-cli' : 'app-server',
  }, route, startedAt);
  fs.appendFileSync(eventsFile, JSON.stringify(dispatchEvent) + '\n');
  let providerCalled = false;
  const announce = (stage, fields) => {
    if (stage === 'iniciado') providerCalled = true;
    runtime.announce?.(stage, fields);
  };
  const options = { cwd, contextRoot: root, engine: route.resolved_worker_engine,
    unitType: r.unitType,
    hostRuntime: route.host_runtime, sidecarDeclared: true, model,
    effort: route.effort, timeoutSecs: route.workers_timeout || 1800, resultFile, dispatchId,
    constraints: r.constraints || { auto_commit: false, deploy: false },
    signal: r.signal, announce, identity: { phase: identity.phase, unit: identity.unit, dispatch_id: dispatchId,
      model_resolved: identity.model_resolved },
    // Defense in depth behind the resolver refusal: the Claude CLI adapter
    // refuses a thinking mode it has no documented argument for.
    ...(route.thinking_requested ? { thinkingRequested: route.thinking_requested } : {}),
  };
  const heartbeat = pid => {
    if (Number.isInteger(pid) && pid > 0) {
      providerCalled = true;
      announce('iniciado', { ...identity, pid, provider_called: true });
    }
    json(resultFile, { status: 'running', pid, adapter_pid: process.pid,
      heartbeat_interval_ms: 15000, started_at: startedAt, updated_at: new Date().toISOString(), dispatch_id: dispatchId });
  };
  try {
    let result, artifacts;
    // The adapter telemetry of a Claude turn: its model_observed is the id the
    // result's modelUsage proved. Codex turns report none.
    let transportTelemetry = null;
    if (transport.mode === 'memory') {
      const prompt = memoryPrompt(r, loc.sourceUnit);
      const validateMemory = value => {
        try { require('./forge-memory-extraction').validateExtractionResult(value, { sourceUnit: loc.sourceUnit }); return true; }
        catch { return false; }
      };
      announce('solicitado', { ...identity, provider_called: false });
      xllm.authorizeSidecar('memory', options);
      heartbeat(null);
      if (options.engine === 'claude') {
        const output = await invokeClaudeSidecar({ ...options, prompt: prompt
          + '\nFinish with ---GSD-WORKER-RESULT---, status, result_json containing the complete JSON, and ---END-RESULT--- on separate lines.',
          readOnly: true, validateCandidate: validateMemory, onHeartbeat: heartbeat,
          heartbeatIntervalMs: 15000, terminateChild: xllm.terminateOwnedProcessTree });
        result = output.candidate;
        transportTelemetry = output.telemetry || null;
      } else {
        const output = await xllm.invokeCodexAppServer({ ...options, prompt, schema: memorySchema,
          sandbox: 'read-only', onHeartbeat: heartbeat });
        result = xllm.extractLastJsonBlock(output.finalText || output.agentTexts);
      }
      result = require('./forge-memory-extraction').validateExtractionResult(result, { sourceUnit: loc.sourceUnit });
      xllm.assertUntrustedOutputBarrier(result);
      artifacts = [];
    } else if (transport.mode === 'execute') {
      result = await xllm.runExecute({ ...options, planFile: r.planFile, securityFile: r.securityFile,
        contextFile: r.contextFile, writableRoots: r.writableRoots });
      artifacts = executeDeliveryArtifacts(r, loc, result, root, cwd);
    } else if (transport.mode === 'plan') {
      if (!r.promptFile) fail('prompt-file-required');
      result = await xllm.runPlan({ ...options, planContextFile: r.promptFile });
      const ids = result.task_plans.map(p => p.id);
      if (new Set(ids).size !== ids.length) fail('plan-task-ids-invalid');
      const listed = require('./forge-status').parsePlanTasks(result.slice_plan.content).map(t => t.id);
      if (JSON.stringify([...listed].sort()) !== JSON.stringify([...ids].sort())) fail('plan-task-list-mismatch');
      artifacts = [{ path: loc.required[0], content: result.slice_plan.content },
        ...result.task_plans.map(p => ({ path: `${loc.slice}/tasks/${p.id}-PLAN.md`, content: p.content }))];
    } else if (transport.mode === 'artifacts') {
      const payloadLimit = options.engine === 'claude' || loc.preparation ? MAX_ARTIFACT_PAYLOAD_BYTES : Infinity;
      const base = typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt
        : r.promptFile ? fs.readFileSync(r.promptFile, 'utf8') : renderPrompt({
        unitType: r.unitType, cwd: root, milestoneId: r.milestoneId, sliceId: r.sliceId,
        description: r.description, unitEffort: route.effort, autoCommit: false,
      }).prompt;
      const prompt = base + '\n\n## Sidecar delivery contract (overrides direct-write instructions above)\n'
        + 'Read-only worker. Return artifact CONTENT, never write files, run commands, commit, tag, push, deploy, clean up, update STATE or acquire leases. The orchestrator owns these actions. '
        + 'Do not assume answers to human decisions. Return partial and questions when a decision is required. '
        + 'Operator constraints: ' + JSON.stringify(r.constraints || { auto_commit: false, deploy: false })
        + '\nRequired paths on done: ' + JSON.stringify(loc.required) + '\nOnly allowed artifact paths: ' + JSON.stringify(loc.allowed)
        + `\nLimits: at most 32 artifacts; each content at most ${MAX_ARTIFACT_BYTES} UTF-8 bytes.`
        + (Number.isFinite(payloadLimit) ? ` The entire serialized result JSON must fit in ${payloadLimit} UTF-8 bytes.` : '')
        + ' Return partial with questions if complete delivery cannot fit; never truncate an artifact.'
        + '\nReturn JSON matching: ' + JSON.stringify(schema);
      announce('solicitado', { ...identity, provider_called: false });
      xllm.authorizeSidecar('artifacts', options);
      heartbeat(null);
      if (options.engine === 'claude') {
        const output = await invokeClaudeSidecar({ ...options, prompt: prompt
          + '\nFinish with the following envelope. Markers must be on their own lines. result_json must contain one complete JSON object (compact or multiline); escape newlines inside JSON strings. Do not wrap the JSON in Markdown fences.\n---GSD-WORKER-RESULT---\nstatus: <done|partial|blocked>\nresult_json: <complete JSON>\n---END-RESULT---',
          readOnly: true, validateCandidate: value => inspectArtifacts(value, loc.allowed, loc.required, payloadLimit, loc.rules,
            { forbidArtifactsOnNonDone: loc.preparation === true }), onHeartbeat: heartbeat,
          heartbeatIntervalMs: 15000, terminateChild: xllm.terminateOwnedProcessTree });
        result = output.candidate;
        transportTelemetry = output.telemetry || null;
      } else {
        const output = await xllm.invokeCodexAppServer({ ...options, prompt, schema, sandbox: 'read-only', onHeartbeat: heartbeat });
        result = xllm.extractLastJsonBlock(output.finalText || output.agentTexts);
      }
      const verdict = inspectArtifacts(result, loc.allowed, loc.required, payloadLimit, loc.rules,
        { forbidArtifactsOnNonDone: loc.preparation === true });
      if (!verdict.ok) {
        const error = new Error('Invalid artifact result.');
        error.code = 'invalid-artifact-result';
        error.diagnostic = diagnostic(verdict.reason);
        throw error;
      }
      if (!loc.preparation && r.unitType === 'plan-milestone' && result.status === 'done') {
        const roadmap = result.artifacts.find(a => a.path === loc.required[0]);
        const slices = require('./forge-status').parseRoadmap(roadmap.content).slices;
        if (!slices.length || new Set(slices.map(s => s.id)).size !== slices.length) fail('invalid-roadmap-result');
      }
      xllm.assertUntrustedOutputBarrier(result);
      artifacts = result.status === 'done' ? result.artifacts : [];
    } else if (transport.mode === 'fix') {
      // Scoped writing turn through the shared execute safety core. The worker
      // never commits; outside-claim, .gsd and a moved baseline are named failures.
      result = await xllm.runFix({ ...options, brief: fix.brief, writableRoots: r.writableRoots });
      // A partial/blocked turn never publishes a success line or a commit.
      if (result.status !== 'done') fail(`review-fix-worker-${result.status}`, 'The review-fix worker did not finish; items are deferred.');
      artifacts = [];
    } else fail('unsupported-sidecar-unit', 'Use forge-xllm review modes for this review contract.');
    // execute, plan and fix carry it inside their adapter-assembled result-file;
    // a worker-shaped artifact or memory result never supplies it.
    if (['execute', 'plan', 'fix'].includes(transport.mode)) transportTelemetry = result.transport_telemetry || null;
    const observedModel = observedModelTelemetry(transportTelemetry);
    if (result.status === 'done' && bookkeeping) {
      artifacts.push({ path: bookkeeping, content: markChecked(bookkeepingText, r.unitType === 'complete-slice' ? r.sliceId : r.taskId) });
    }
    const record = transport.mode === 'fix'
      ? { phase: 'ready', kind: 'review-fix', fingerprint, dispatch_id: dispatchId,
        review_fix_identity: fix.brief.identity, reset_state_file: fix.stateFile,
        boundary: loc.reviewFix.boundary, unit: label, route, route_identity: routeIdentity(route, r.unitType),
        provider_called: true,
        telemetry: { model_requested: route.model_requested ?? null,
          model_resolved: route.model_resolved || route.model || null, model_argument: model,
          ...observedModel, effort_reason: route.effort_reason || null,
          // Claude CLI: the argv value the adapter reported; app-server: the
          // `effort` turn param runFix passed. Both are adapter arguments.
          ...effortTelemetry(route, result.transport_telemetry ? result.transport_telemetry.effort_sent : options.effort),
          transport: options.engine === 'claude' ? 'claude-cli' : 'app-server',
          cli_version: result.transport_telemetry ? result.transport_telemetry.cli_version : null,
          transport_diagnostics: result.transport_telemetry ? result.transport_telemetry.policy_diagnostics : [] },
        review_snapshot: fix.reviewSnapshot, verified_hashes: verifiedHashes(cwd, result.verified_paths),
        ...(r.constraints?.auto_commit === true && result.vcs !== 'svn' && !Array.isArray(result.repo_baselines)
          ? { verified_git_blobs: require('./forge-review-fix').verifiedGitBlobs(cwd, result.verified_paths) } : {}),
        result, artifacts: [], publication: { commit: null } }
      : transport.mode === 'memory'
      ? { phase: 'ready', kind: 'memory-extraction', fingerprint, dispatch_id: dispatchId,
        extraction_id: r.extractionId || dispatchId, extracted_at: startedAt, source_unit: loc.sourceUnit,
        model: route.model_resolved || route.model, effort: route.effort, extraction: result, artifacts: [],
        telemetry: { model_requested: route.model_requested || route.model || null,
          model_resolved: route.model_resolved || route.model || null, model_argument: model,
          ...observedModel,
          effort_requested: route.effort || null, effort_resolved: route.effort || null,
          effort_argument: route.effort || null, capabilities_source: 'sidecar-transport' } }
      : { phase: 'ready', fingerprint, dispatch_id: dispatchId, result: { ...result, dispatch_id: dispatchId,
        workflow_id: r.workflowId, host_runtime: route.host_runtime, worker_engine: options.engine },
        request_fingerprint: r.preparationRequestFingerprint || null,
        preparation_identity: r.preparationIdentity || null,
        route, route_identity: routeIdentity(route, r.unitType), provider_called: true,
        telemetry: { model_requested: route.model_requested ?? null,
          model_resolved: route.model_resolved || route.model || null,
          ...observedModel,
          effort_resolved: route.effort || null, effort_reason: route.effort_reason || null },
        artifacts: artifacts.map(a => ({ ...a, before: before[a.path] ?? null })) };
    // Durable validated response BEFORE artifact publication: a crash anywhere
    // after here replays publication, without spending another provider turn.
    json(receiptFile, record);
    result = await publishReadyRecord(r, record);
    json(resultFile, result);
    if (transport.mode !== 'memory') {
      event(result.status, null, null, true, fix ? { boundary: loc.reviewFix.boundary, items_total: result.items.length,
        items_fixed: result.items.filter(item => item.verified).length, commit_sha: result.commit_sha,
        effort_sent: result.telemetry ? result.telemetry.effort_sent : null } : null);
    }
    return result;
  } catch (error) {
    error.provider_called = providerCalled;
    announce(providerCalled ? 'falhou' : 'recusado', { ...identity,
      ...(providerCalled ? {} : { model_sent: '-', model_route: model }),
      reason_code: error.code || xllm.classifyErrorClass(error.message), provider_called: providerCalled });
    let extra = null;
    const phase = fix ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')).phase : null;
    if (fix && phase !== 'ready') {
      // Only an attempt that never reached a durable validated result is reset;
      // a ready receipt keeps the worker's verified changes for replay. A refused
      // Claude model identity is the exception: the tree (new files included) is
      // left exactly as the worker left it for the operator, never reset.
      const identityRefused = typeof error.code === 'string' && error.code.startsWith('claude-model-');
      const reset = identityRefused
        ? { verified: false, reason_code: 'identity-refused-preserved', restored: 0, removed: 0, overlap: [] }
        : resetReviewFixAttempt(r, fix);
      const terminalSafetyFailure = identityRefused
        || ['review-fix-protected-metadata', 'review-fix-baseline-moved'].includes(error.code);
      const publicationError = publishReviewFixFailure(r, loc, fix.items, fix.reviewSnapshot);
      extra = { reset, items: fix.items.map(item => ({ r: item.r, ...(item.review_file ? { review_file: item.review_file } : {}), outcome: 'failed', verified: false, commit_sha: null })),
        ...(publicationError ? { publication_error: publicationError } : {}),
        ...(error.outside ? { outside_claim: { count: error.outside.length, paths: error.outside } } : {}),
        recovery: reset.overlap.length || !reset.verified || terminalSafetyFailure ? 'operator-required' : 'items-deferred' };
    }
    recordFailure(error, extra);
    throw error;
  }
}

// Validate the review-fix request against the claim the parent can re-derive,
// then capture the surgical-reset state beside the result channel.
function prepareReviewFix(request, loc, context) {
  const reviewFix = require('./forge-review-fix');
  const spec = request.reviewFix;
  const items = reviewFix.normalizeItems(spec.items);
  const claim = reviewFix.deriveClaim(items);
  const supplied = Array.isArray(spec.claimPaths) ? [...new Set(spec.claimPaths.map(String))].sort() : null;
  // A pathless item keeps its canonical claim-gate refusal name.
  if (!claim.eligible) fail(claim.cause || 'review-fix-claim-mismatch', `The accepted items cannot form a claim (${claim.detail}); no worker was launched.`);
  if (!supplied || JSON.stringify([...new Set(claim.paths)].sort()) !== JSON.stringify(supplied)) {
    fail('review-fix-claim-mismatch', 'The supplied claim differs from the claim derived from the accepted items; run the claim gate again.');
  }
  // The claim gate is mandatory for this contract: no legacy request exists
  // without it, so an absent decision is refused exactly like a non-proceed one.
  if (spec.decision !== 'proceed') {
    fail('review-fix-claim-mismatch', 'The cross-run claim gate decision must be proceed before a review-fix worker starts.');
  }
  assertClaimTargetsPhysical(context.cwd, supplied);
  const stateFile = xllm.validateResultFileTarget(`${context.resultFile}.reset-state.json`, context.cwd);
  xllm.validateResultFileTarget(stateFile, context.root);
  const writable = Array.isArray(request.writableRoots) ? request.writableRoots.map(root => fs.realpathSync(root)) : [];
  const repoRoots = [context.cwd, ...writable];
  require('./forge-surgical-reset').initState(stateFile, { cwd: context.cwd, attempt: context.dispatchId, repoRoots });
  const brief = reviewFix.buildBrief({ boundary: loc.reviewFix.boundary, unitLabel: loc.reviewFix.unitLabel,
    items, claimPaths: supplied, route: context.route });
  // REVIEW.md bytes before the provider turn: publication (and any replay)
  // refuses to overwrite a review that changed meanwhile.
  const reviewSnapshot = {};
  for (const reviewFile of loc.reviewFix.reviewFiles) {
    try { reviewSnapshot[reviewFile] = hash(fs.readFileSync(target(context.root, reviewFile))); }
    catch { fail('review-fix-review-item-missing', `${reviewFile} is not readable; no worker was launched.`); }
  }
  return { items, brief, stateFile, repoRoots, cwd: context.cwd, reviewSnapshot };
}

// A lexically relative claim path can still resolve through a symlink or
// junction outside CODE_DIR. Every existing component of each claimed file
// (and the file itself) must resolve physically inside the root and must not
// be a link. Missing trailing components are allowed (the fix may create a
// file), but their nearest existing parent is checked. This is a pre-spawn
// check only: transient writes during the turn are detected afterwards.
function assertClaimTargetsPhysical(cwd, claimPaths) {
  const root = fs.realpathSync(cwd);
  const key = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const inside = value => key(value) === key(root) || key(value).startsWith(key(root.endsWith(path.sep) ? root : root + path.sep));
  for (const relative of claimPaths) {
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch { break; }
      if (stat.isSymbolicLink() || !inside(fs.realpathSync(current))) {
        fail('review-fix-claim-mismatch', `Claim path ${relative} resolves through a link or outside CODE_DIR; no worker was launched.`);
      }
    }
  }
}

function reviewFixItemsTotal(request) {
  return request.reviewFix && Array.isArray(request.reviewFix.items) ? request.reviewFix.items.length : 0;
}
async function runUnitSidecar(request, runtime = {}) {
  const r = request || {}, route = r.route || {};
  const identity = { phase: r.preparationIdentity?.phase, unit: r.unitType === 'review-fix' ? reviewFixUnitLabel(r)
    : `${r.unitType || '-'}/${r.taskId || r.sliceId || r.milestoneId || r.sourceUnit || '-'}`,
    engine: route.resolved_worker_engine, transport: route.resolved_worker_engine === 'claude' ? 'claude-cli' : 'app-server',
    model_sent: '-', model_route: route.sidecar_model || route.model_resolved || route.model,
    model_resolved: route.model_resolved || route.model, effort: route.effort,
    host: route.host_runtime, dispatch_id: r.dispatchId };
  let terminal = false;
  const scopedRuntime = { ...runtime, announce: (stage, fields) => {
    if (terminal) return;
    if (['recusado', 'falhou', 'reaproveitado'].includes(stage)) terminal = true;
    runtime.announce?.(stage, fields);
  } };
  try { return await runUnitSidecarCore(r, scopedRuntime, identity); }
  catch (error) {
    scopedRuntime.announce('recusado', { ...identity, model_sent: '-', reason_code: error.code || 'sidecar-unit-failed',
      provider_called: false });
    throw error;
  }
}
module.exports = { schema, memorySchema, MEMORY_QUALITY_CONTRACT, locations, validateArtifacts, inspectArtifacts, inspectDeliveryContent, executeDeliveryArtifacts, MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_PAYLOAD_BYTES, target, markChecked, materialize, memoryPrompt, memorySourceContext,
  publishReadyRecord, nativeMemoryFingerprint, acceptNativeMemoryResult, candidateFromNativeResult, runNativeMemory,
  routeIdentity, artifactFingerprint, artifactAttemptFiles, beginArtifactAttempt, replayArtifactAttempt,
  failArtifactAttempt, acceptArtifactResult, runUnitSidecar, reviewFixUnitLabel, effortTelemetry };
if (require.main === module) {
  const announce = createStderrAnnouncer();
  Promise.resolve().then(() => {
    if (!['--request', '--accept-native-memory'].includes(process.argv[2]) || !process.argv[3]) fail('request-file-required');
    const request = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    return process.argv[2] === '--accept-native-memory' ? acceptNativeMemoryResult(request) : runUnitSidecar(request, { announce });
  }).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => { process.stderr.write(`forge-unit-sidecar: ${error.code || 'sidecar-unit-failed'}\n`); process.exitCode = 1; });
}
