#!/usr/bin/env node
'use strict';

// Delivery only: consumes a resolved route and the controller-selected unit.
// It never selects a unit, acquires a lease, changes host, commits or falls back.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xllm = require('./forge-xllm');
const { createStderrAnnouncer } = require('./forge-sidecar-identity');
const { evaluateDispatchGuard } = require('./forge-dispatch-guard');
const { DEFAULT_WORKER_TIMEOUT_SECS } = require('./forge-worker-timeout');
const { capability } = require('./forge-transport-capabilities');
const { renderPrompt } = require('./forge-prompt');
const { diagnostic } = require('./forge-sidecar-diagnostic');
const memory = require('./forge-memory');
const forgeIds = require('./forge-ids');
const { MAX_FILE_BYTES: MAX_DELIVERY_BYTES } = require('./forge-delivery');

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
  return require('./forge-task-execution').protectedSnapshot(fs.realpathSync(request.contextRoot || request.cwd));
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
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(rule.kind === 'input' ? [1, 2] : [1]).includes(value.schema_version)
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
  if (request.scope && !['standalone-task', 'milestone'].includes(request.scope)) fail('unsupported-sidecar-scope');
  if (request.scope === 'standalone-task' && request.unitType === 'execute-task') {
    return require('./forge-task-execution').locations(request);
  }
  if (!request.scope && request.phase !== undefined) fail('sidecar-phase-without-scope');
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
    'execute-task': [`${slice}/tasks/${t}/${t}-SUMMARY.md`],
  }[unit];
  if (!baseRequired) fail('unsupported-sidecar-unit');
  const deliveryPrefix = unit === 'execute-task' ? `${slice}/tasks/${t}/${t}`
    : unit === 'complete-slice' ? `${slice}/${s}`
      : unit === 'complete-milestone' ? `${milestone}/${m}` : null;
  const deliveryUnit = unit === 'execute-task' ? { type: 'task', id: t, milestone: m, slice: s }
    : unit === 'complete-slice' ? { type: 'slice', id: s, milestone: m }
      : unit === 'complete-milestone' ? { type: 'milestone', id: m } : null;
  const delivery = deliveryPrefix ? {
    input: `${deliveryPrefix}-DELIVERY-INPUT.json`, output: `${deliveryPrefix}-DELIVERY.json`,
    verification: `${deliveryPrefix}-VERIFY-ENVELOPE.json`, artifact: `${deliveryPrefix}-ARTIFACT-ENVELOPE.json`,
  } : null;
  const rootSources = unit === 'execute-task' ? (request.execution_contract?.code_roots || []).flatMap(root => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(root.id)) fail('root-id-invalid');
    return ['verification', 'artifact'].map(kind => ({ path: `${deliveryPrefix}-${kind.toUpperCase()}-${root.id}-ENVELOPE.json`, kind, root_id: root.id }));
  }) : [];
  if (delivery) delivery.rootSources = rootSources;
  const required = delivery ? [...baseRequired, delivery.input, delivery.output] : baseRequired;
  const optional = unit.startsWith('research-') ? ['.gsd/CODING-STANDARDS.md'] : [];
  const deliveryOptional = delivery ? [delivery.verification, delivery.artifact, ...rootSources.map(row => row.path)] : [];
  const rules = delivery ? {
    [delivery.input]: { kind: 'input', unit: deliveryUnit },
    [delivery.output]: { kind: 'delivery', unit: deliveryUnit },
    [delivery.verification]: { kind: 'verification', unit: deliveryUnit },
    [delivery.artifact]: { kind: 'artifact', unit: deliveryUnit },
    ...Object.fromEntries(rootSources.map(row => [row.path, { kind: row.kind, unit: deliveryUnit }])),
  } : {};
  return { required, allowed: [...required, ...deliveryOptional, ...optional], rules, delivery, milestone, slice };
}
function milestonePlanFile(request) {
  const loc = locations(request), root = request.contextRoot || request.cwd;
  const canonical = target(root, `${loc.slice}/tasks/${request.taskId}/${request.taskId}-PLAN.md`);
  const legacy = target(root, `${loc.slice}/tasks/${request.taskId}-PLAN.md`);
  if (fs.existsSync(canonical) && fs.existsSync(legacy)) fail('legacy-task-plan-conflict');
  const selected = fs.existsSync(canonical) ? canonical : legacy;
  if (!fs.existsSync(selected)) fail('execution-plan-required');
  if (request.planFile && path.resolve(request.planFile) !== path.resolve(selected)) fail('execution-plan-path-mismatch');
  return selected;
}
function validateRecoveryRequest(raw, options = {}) {
  const request = require('./forge-attempt-recovery').canonicalRequest(raw);
  const loc = locations(request);
  const transport = capability(request.route?.resolved_worker_engine, request.unitType,
    request.scope === 'milestone' ? {} : request);
  if (!transport.supported) fail(transport.reason_code, transport.hint);
  if (loc.preparation) require('./forge-task-preparation').validateRequest(request);
  if (transport.mode === 'execute') {
    if (loc.execution) {
      const prepared = require('./forge-task-execution').prepare({ ...request, nativeInvocation: options.nativeInvocation }, request.contextRoot, request.cwd);
      return { ...transport, contract: prepared.execution_contract, planFile: request.planFile };
    } else {
      const roots = require('./forge-code-roots');
      const contract = request.execution_contract ? roots.validateContract(request.execution_contract, { owner: request.contextRoot, revalidate: true })
        : roots.singleContract(request.contextRoot, request.cwd);
      const planFile = milestonePlanFile(request);
      const plan = fs.readFileSync(planFile, 'utf8');
      const checked = roots.validatePlan(plan, contract);
      if (request.execution_contract) {
        const claim = request.claim;
        if (!claim || claim.schema_version !== 2 || claim.released || !claim.generation) fail('execution-held-claim-required');
        const held = request.runId && require('./forge-runs').get(request.contextRoot, request.runId);
        if (!held || held.active !== true || held.write_claim?.released
            || held.write_claim?.generation !== claim.generation
            || roots.digest(held.write_claim) !== roots.digest(claim)) fail('execution-claim-generation-stale');
        roots.claimGroups(claim);
        if (roots.digest(claim.execution_contract) !== roots.digest(contract)
            || checked.writes.some(p => !claim.paths.some(c => roots.covers(c, p)))) fail('execution-held-claim-mismatch');
        const gateFile = planFile.replace(/-PLAN\.md$/, '-PLAN-GATE.md');
        const gate = fs.existsSync(gateFile) ? fs.readFileSync(gateFile, 'utf8') : '';
        if (!/^status:\s*approved\s*$/m.test(gate)
            && !(request.gates?.plan === 'skipped' && request.gates?.planSkipReason === 'interactive-off')) fail('execution-plan-gate-required');
        const approvedHash = gate.match(/^plan_sha256:\s*([a-f0-9]{64})\s*$/m)?.[1];
        if (approvedHash && approvedHash !== hash(plan)) fail('execution-plan-gate-stale');
        if (request.gates?.claim !== 'proceed' || !['passed', 'not-applicable'].includes(request.gates?.security)) fail('execution-gates-required');
        if (request.gates.security === 'passed'
            && (!request.securityFile || !fs.readFileSync(request.securityFile, 'utf8').trim())) fail('execution-security-required');
      }
      const effective = require('./forge-transport-capabilities').executionCapability(request.route, contract, options);
      if (!effective.supported) fail(effective.reason_code);
      return { ...transport, contract, planFile };
    }
  }
  if (request.cwd && request.resultFile) artifactAttemptFiles(request);
  return transport;
}
function baselineDigest(state) {
  const { reconciliation, ...baseline } = state;
  return require('./forge-code-roots').digest(baseline);
}
function recoveryIdentity(request) {
  try { return require('./forge-code-roots').digest(require('./forge-attempt-recovery').requestIdentity(require('./forge-attempt-recovery').canonicalRequest(request))); }
  catch { return null; }
}
function captureMilestoneBaseline(request, receipt, options = {}) {
  const roots = require('./forge-code-roots'), execution = require('./forge-task-execution');
  const checked = validateRecoveryRequest(request, options), contract = checked.contract;
  if (!contract || receipt.fingerprint !== artifactFingerprint(request) || receipt.dispatch_id !== request.dispatchId) fail('recovery-baseline-binding');
  const stateFile = `${request.resultFile}.reset-state.json`;
  require('./forge-attempt-recovery').validateStateTarget(stateFile, request, contract);
  if (fs.existsSync(stateFile)) fail('recovery-baseline-already-exists');
  const state = require('./forge-surgical-reset').initState(stateFile, { cwd: request.cwd,
    attempt: request.dispatchId, executionContract: contract });
  const input = { path: checked.planFile, sha256: roots.digest(fs.readFileSync(checked.planFile)) };
  return { schema_version: 1, state_file: stateFile, state_sha256: baselineDigest(state),
    execution_contract: contract, fingerprint: receipt.fingerprint, dispatch_id: receipt.dispatch_id, input,
    protected_owner: execution.protectedSnapshot(contract.owner),
    protected_roots: contract.code_roots.map(root => ({ root_id: root.id, path: root.path, snapshot: execution.protectedSnapshot(root.path) })) };
}
function reconcileMilestoneAttempt(request, receipt, runtime = {}) {
  const baseline = receipt.recovery_baseline, roots = require('./forge-code-roots');
  if (!baseline || baseline.schema_version !== 1) fail('recovery-baseline-required');
  const contract = roots.validateContract(baseline.execution_contract, { owner: request.contextRoot || request.cwd, revalidate: true });
  if (request.execution_contract && roots.digest(contract) !== roots.digest(roots.validateContract(request.execution_contract, { revalidate: true }))) fail('recovery-baseline-contract-mismatch');
  require('./forge-attempt-recovery').validateStateTarget(baseline.state_file, request, contract);
  const state = require('./forge-surgical-reset').readState(baseline.state_file);
  if (baseline.dispatch_id !== request.dispatchId || receipt.dispatch_id !== request.dispatchId
      || baseline.fingerprint !== receipt.fingerprint || recoveryIdentity(request) !== receipt.recovery_identity_sha256
      || baseline.state_sha256 !== baselineDigest(state) || state.attempt !== request.dispatchId
      || roots.digest(state.execution_contract) !== roots.digest(contract)) fail('recovery-baseline-binding');
  if (baseline.input.sha256 !== roots.digest(fs.readFileSync(baseline.input.path))) fail('recovery-baseline-input-changed');
  const execution = require('./forge-task-execution');
  const protectedOwner = receipt.execution?.protected_owner || baseline.protected_owner;
  // Only the core-owned event hash may advance from the original baseline.
  const withoutEvent = snapshot => Object.entries(snapshot).filter(([key]) => key !== '.gsd/forge/events.jsonl').sort();
  if (roots.digest(withoutEvent(protectedOwner)) !== roots.digest(withoutEvent(baseline.protected_owner))) fail('recovery-owner-snapshot-mismatch');
  execution.assertProtected(contract.owner, protectedOwner);
  if (baseline.protected_roots.length !== contract.code_roots.length) fail('recovery-baseline-roots-missing');
  for (const root of contract.code_roots) {
    const saved = baseline.protected_roots.find(row => row.root_id === root.id && row.path === root.path);
    if (!saved) fail('recovery-baseline-roots-missing');
    execution.assertProtected(root.path, path.resolve(root.path) === path.resolve(contract.owner) ? protectedOwner : saved.snapshot);
  }
  return require('./forge-surgical-reset').reconcileFailedAttempt(baseline.state_file,
    { failed: true, processStopped: true, verifyOwnership: runtime.verifyOwnership });
}
function assertMilestoneDeliveryReplay(request, record) {
  if (!record.milestone_delivery) return;
  const saved = record.milestone_delivery, api = require('./forge-task-execution');
  require('./forge-code-roots').validateContract(request.execution_contract, { revalidate: true });
  if (hash(fs.readFileSync(request.planFile)) !== saved.plan_sha256) fail('execution-input-changed');
  for (const entry of saved.protected_roots) api.assertProtected(entry.path, entry.snapshot);
  if (JSON.stringify(api.replayState(request.cwd, request.execution_contract)) !== JSON.stringify(saved.code_state)) fail('execution-replay-baseline-changed');
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
    || !Array.isArray(value.questions) || !value.questions.every(q => typeof q === 'string' ? q.trim() : q && typeof q === 'object' && !Array.isArray(q)
      && typeof q.id === 'string' && q.id.trim() && typeof q.question === 'string' && q.question.trim()
      && Object.keys(q).every(key => ['id', 'question'].includes(key)))
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
    const contentLimit = rules[artifact.path]?.kind === 'delivery' ? MAX_DELIVERY_BYTES : MAX_ARTIFACT_BYTES;
    if (Buffer.byteLength(artifact.content) > contentLimit) return bad('artifact-limit');
    seen.add(artifact.path);
  }
  if (value.status === 'done' && value.questions.length) return bad('questions-on-done');
  if (options.forbidArtifactsOnNonDone && value.status !== 'done' && value.artifacts.length) return bad('artifacts-on-non-done');
  if (options.forbidArtifactsOnNonDone && (Buffer.byteLength(value.summary, 'utf8') > MAX_PREPARATION_SUMMARY_BYTES
      || value.questions.length > MAX_PREPARATION_QUESTIONS
      || value.questions.some(question => Buffer.byteLength(typeof question === 'string' ? question : JSON.stringify(question), 'utf8') > MAX_PREPARATION_QUESTION_BYTES))) {
    return bad('payload-limit');
  }
  if (value.status === 'done' && !required.every(p => seen.has(p))) return bad('artifact-missing');
  if (Buffer.byteLength(JSON.stringify(value)) > maxPayloadBytes) return bad('payload-limit');
  return { ok: true };
}
function validateArtifacts(value, allowed, required, maxPayloadBytes, rules, options) {
  return inspectArtifacts(value, allowed, required, maxPayloadBytes, rules, options).ok;
}
function executeDeliveryArtifacts(request, loc, result, root, cwd, captured) {
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
  const sources = {}, sourceArtifacts = [];
  if (request.execution_contract) {
    if (!captured) fail('execution-delivery-capture-required');
    if (!captured.passed) fail('execution-verification-failed');
    input.schema_version = 2;
    input.execution_contract = request.execution_contract;
    for (const envelope of [...captured.gate.roots, ...captured.artifacts]) {
      const source = loc.delivery.rootSources.find(row => row.kind === envelope.kind
        && row.root_id === envelope.root_id);
      if (!source) fail('execution-delivery-source-unknown');
      sources[source.path] = envelope;
      sourceArtifacts.push({ path: source.path, content: `${JSON.stringify(envelope, null, 2)}\n` });
    }
    // Bindings are caller declarations, never inferred from a passing command.
    input.bindings = (request.verification?.bindings || []).map(binding => {
      const source = loc.delivery.rootSources.find(row => row.kind === binding.source?.kind
        && row.root_id === binding.root_id);
      if (!source) fail('execution-binding-root-unknown');
      const { root_id, ...rest } = binding;
      return { ...rest, source: { ...binding.source, path: source.path } };
    });
  }
  const delivery = require('./forge-delivery');
  const output = delivery.buildDelivery(input, { ownerRoot: root, codeDir: cwd, sourceEnvelopes: sources });
  const deliveryReference = `./${path.posix.basename(loc.delivery.output)}`;
  const deliverySection = delivery.renderDeliveryMarkdown(output, { detailReference: deliveryReference });
  const artifacts = [
    ...sourceArtifacts,
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
function materialize(request, record, publicationGuard, publicationLock) {
  if (record.kind === 'memory-extraction') fail('memory-publication-required', 'Use publishReadyRecord for memory extraction receipts.');
  if (record.result.status !== 'done') return record.result;
  const root = fs.realpathSync(request.contextRoot || request.cwd);
  return require('./forge-artifact-reconciliation').withOwnerLock(root, () => {
  publicationGuard?.();
  assertMilestoneDeliveryReplay(request, record);
  if (record.execution || record.milestone_delivery) {
    if (record.execution) require('./forge-task-execution').assertReplay(request, record);
    if (request.ownerBroker) require('./forge-artifact-reconciliation').assertBroker(request.ownerBroker)
      .verify({ canonicalArtifacts: record.artifacts });
    else {
      const protectedOwner = (record.execution || record.milestone_delivery).protected_owner;
      if (!protectedOwner) fail('execution-owner-baseline-required');
      const expected = { ...protectedOwner };
      const current = require('./forge-task-execution').protectedSnapshot(root);
      for (const item of record.artifacts) if (current[item.path] === hash(item.content)) {
        expected[item.path] = current[item.path];
        let dir = path.posix.dirname(item.path);
        while (dir !== '.') { if (current[dir + '/'] === 'directory') expected[dir + '/'] = 'directory'; dir = path.posix.dirname(dir); }
      }
      require('./forge-task-execution').assertProtected(root, expected);
    }
  }
  // Validate every target and conflict before publishing any file. Replay after
  // a crash accepts our exact content, never an unrelated edit since dispatch.
  for (const item of record.artifacts) {
    const file = target(root, item.path), current = fileHash(file);
    if (current !== item.before && current !== hash(item.content)) fail('artifact-conflict', `Artifact changed during dispatch: ${item.path}`);
  }
  for (const item of record.artifacts) {
    const file = target(root, item.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fileHash(file);
    if (current !== item.before && current !== hash(item.content)) fail('artifact-conflict', item.path);
    if (current !== hash(item.content)) atomic(file, item.content);
  }
  return record.result;
  }, publicationLock);
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
    'signal', 'publicationSafe', 'publicationBoundary', 'waitForPublicationBoundary', 'ownerBroker']) delete copy[key];
  return hash(JSON.stringify(copy));
}

function artifactAttemptFiles(request) {
  const cwd = fs.realpathSync.native(request.cwd);
  const root = fs.realpathSync.native(request.contextRoot || cwd);
  const resultFile = xllm.validateResultFileTarget(request.resultFile, cwd);
  xllm.validateResultFileTarget(resultFile, root);
  const receiptFile = `${resultFile}.receipt.json`;
  xllm.validateResultFileTarget(receiptFile, cwd);
  xllm.validateResultFileTarget(receiptFile, root);
  for (const code of request.execution_contract?.code_roots || []) {
    xllm.validateResultFileTarget(resultFile, code.path);
    xllm.validateResultFileTarget(receiptFile, code.path);
  }
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
  if (request.ownerBroker) {
    const broker = require('./forge-artifact-reconciliation').assertBroker(request.ownerBroker);
    if (broker.manifest.request_sha256 !== fingerprint || broker.manifest.dispatch_id !== request.dispatchId
        || broker.manifest.owner !== files.root
        || hash(JSON.stringify(broker.manifest.execution_contract)) !== hash(JSON.stringify(request.execution_contract || null))) fail('broker-attempt-binding');
    broker.verify();
  }
  const record = { phase: 'started', fingerprint, dispatch_id: request.dispatchId, before,
    recovery_identity_sha256: recoveryIdentity(request),
    ...(request.ownerBroker ? { broker_manifest_sha256: require('./forge-artifact-reconciliation').assertBroker(request.ownerBroker).manifest_sha256,
      broker_plan_sha256: request.ownerBroker.manifest.plan_sha256 } : {}),
    before_state: beforeState,
    preparation_surface: request.scope === 'standalone-task' && request.route?.worker_mode === 'native'
      ? preparationSurfaceSnapshot(request) : null,
    input_pending_questions: request.pending_questions || [],
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

function failArtifactAttempt(request, reasonCode, detail, providerCalled = 'unknown', finalEvidence) {
  const files = artifactAttemptFiles(request);
  const fingerprint = artifactFingerprint(request);
  const current = fs.existsSync(files.receiptFile)
    ? JSON.parse(fs.readFileSync(files.receiptFile, 'utf8')) : null;
  if (current && current.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
  const failure = { status: 'failure', reason_code: reasonCode,
    provider_called: typeof providerCalled === 'boolean' ? providerCalled : 'unknown', diagnostic: diagnostic(typeof detail === 'string' ? detail : detail?.reason || 'adapter-failed', detail && typeof detail === 'object' ? detail : {}),
    recovery: 'operator-required' };
  const evidence = require('./forge-attempt-telemetry').sanitizeFinal(finalEvidence || current?.final_evidence);
  failure.final_evidence = evidence;
  if (current && ['ready','executed'].includes(current.phase)) return fs.existsSync(files.resultFile) ? JSON.parse(fs.readFileSync(files.resultFile,'utf8')) : current.result;
  if (!current || !['ready','executed'].includes(current.phase)) {
    json(files.receiptFile, { ...(current || {}), phase: 'failed', fingerprint,
      dispatch_id: request.dispatchId, route: request.route,
      request_fingerprint: request.preparationRequestFingerprint || current?.request_fingerprint || null,
      preparation_identity: request.preparationIdentity || current?.preparation_identity || null,
      route_identity: routeIdentity(request.route, request.unitType), final_evidence: evidence, failure });
  }
  json(files.resultFile, failure);
  require('./forge-attempt-recovery').captureFailure({ stateFile: request.recoveryStateFile || `${files.resultFile}.recovery.json`,
    unit: `${request.unitType}/${request.taskId || request.sliceId || request.milestoneId}`, contract: request.execution_contract,
    request, finalEvidence: evidence, route: request.route, receiptFile: files.receiptFile,
    durationMs: current?.started_at ? Date.now() - Date.parse(current.started_at) : evidence?.duration_ms,
    error: { code: reasonCode, provider_called: providerCalled, diagnostic: failure.diagnostic }, layer: failure.diagnostic.stage });
  return failure;
}

async function acceptArtifactResult(request, rawResult, metadata = {}) {
  if (!request.ownerBroker) return acceptArtifactResultCore(request, rawResult, metadata);
  const api = require('./forge-artifact-reconciliation'), broker = api.assertBroker(request.ownerBroker);
  const guard = api.lock(broker.manifest);
  try {
    const accepted = await acceptArtifactResultCore(request, rawResult, metadata, guard);
    broker.verify({ canonicalArtifacts: accepted.record.artifacts || [] });
    return accepted;
  } finally { guard.release(); }
}
async function acceptArtifactResultCore(request, rawResult, metadata = {}, publicationLock) {
  const loc = locations(request);
  const files = artifactAttemptFiles(request);
  const fingerprint = artifactFingerprint(request);
  if (!fs.existsSync(files.receiptFile)) fail('artifact-attempt-not-started');
  const existing = JSON.parse(fs.readFileSync(files.receiptFile, 'utf8'));
  if (existing.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
  if (existing.phase === 'ready') {
    if (request.ownerBroker) request.ownerBroker.verify({ canonicalArtifacts: existing.artifacts || [] });
    const result = await publishReadyRecord(request, existing, undefined, publicationLock);
    json(files.resultFile, result);
    return { result, record: existing, replayed: true, provider_called: false };
  }
  if (existing.phase === 'failed') fail(existing.failure?.reason_code || 'artifact-attempt-failed');
  if (existing.phase !== 'started') fail('sidecar-attempt-interrupted');
  if (metadata.providerCalled !== true) fail('artifact-provider-call-unconfirmed');
  xllm.assertUntrustedOutputBarrier(rawResult);
  if (/(?:token|secret|password|credential)\s*[:=]\s*[^\s"}]+/i.test(JSON.stringify(rawResult))) fail('secret-output');
  const checked = inspectArtifacts(rawResult, loc.allowed, loc.required,
    metadata.maxPayloadBytes === undefined ? Infinity : metadata.maxPayloadBytes, loc.rules,
    { forbidArtifactsOnNonDone: loc.preparation === true });
  if (!checked.ok) fail('invalid-artifact-result', checked.reason);
  // Save validated bytes before checking owner drift. Failure keeps this exact
  // response, allowing proved owner appends to be reconciled without inference.
  const responseAnchor = request.ownerBroker
    ? await require('./forge-artifact-reconciliation').assertBroker(request.ownerBroker).bindResponse(rawResult)
    : metadata.responseAnchor;
  if (responseAnchor) {
    const anchorFile = `${files.receiptFile}.response-anchor.json`;
    if (fs.existsSync(anchorFile)) {
      if (hash(fs.readFileSync(anchorFile)) !== hash(JSON.stringify(responseAnchor) + '\n')) fail('broker-response-anchor-conflict');
    } else fs.writeFileSync(anchorFile, JSON.stringify(responseAnchor) + '\n', { flag: 'wx', mode: 0o600 });
  }
  existing.saved_candidate = { sha256: hash(JSON.stringify(rawResult)), result: rawResult,
    plan_sha256: existing.broker_plan_sha256 || null };
  if (metadata.finalEvidence) existing.final_evidence = require('./forge-attempt-telemetry').sanitizeFinal(metadata.finalEvidence);
  json(files.receiptFile, existing);
  // A native preparation worker has only a prompt-level read-only contract.
  // Detect any canonical write before acceptance, even if its bytes happen to
  // equal the returned artifact. Ready replay after owner publication remains
  // valid because it takes the separate branch above.
  for (const relative of loc.allowed) {
    if (JSON.stringify(fileState(target(files.root, relative))) !== JSON.stringify(existing.before_state?.[relative] ?? null)) {
      fail('artifact-direct-write-detected');
    }
  }
  if (metadata.enforceReadOnlySurface === true) {
    if (request.ownerBroker) {
      const broker = require('./forge-artifact-reconciliation').assertBroker(request.ownerBroker);
      if (broker.manifest_sha256 !== existing.broker_manifest_sha256) fail('broker-manifest-changed');
      broker.verify();
    } else if (JSON.stringify(preparationSurfaceSnapshot(request)) !== JSON.stringify(existing.preparation_surface)) fail('artifact-direct-write-detected');
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
  const planContract = request.phase === 'plan' && rawResult.status === 'done'
    ? require('./forge-task-preparation').preflightPlan(request, artifacts[0].content) : null;
  const pendingQuestions = require('./forge-interaction').mergePendingQuestions(request.pending_questions || [], rawResult.questions || []);
  const record = { phase: 'ready', fingerprint, dispatch_id: request.dispatchId,
    ...(planContract ? { plan_contract: planContract } : {}), pending_questions: pendingQuestions,
    input_pending_questions: request.pending_questions || [],
    request_fingerprint: request.preparationRequestFingerprint || null,
    preparation_identity: request.preparationIdentity || existing.preparation_identity || null,
    route: request.route, route_identity: routeIdentity(request.route, request.unitType),
    provider_called: true, telemetry: metadata.telemetry || null, result: rawResult,
    artifacts: artifacts.map(artifact => ({ ...artifact, before: existing.before[artifact.path] ?? null })) };
  if (metadata.telemetry?.calibration_proposal) record.calibration_proposal = metadata.telemetry.calibration_proposal;
  json(files.receiptFile, record);
  const result = await publishReadyRecord(request, record, undefined, publicationLock);
  json(files.resultFile, result);
  return { result, record, replayed: false, provider_called: true };
}
async function reconcileArtifactAttempt(request, options) {
  const files = artifactAttemptFiles(request), loc = locations(request);
  return require('./forge-artifact-reconciliation').reconcile({ ...options, receiptFile: files.receiptFile,
    async publish(child, publicationGuard) {
      if (child.request_sha256 !== artifactFingerprint(request)) fail('dispatch-identity-conflict');
      const result = child.candidate;
      xllm.assertUntrustedOutputBarrier(result);
      const checked = inspectArtifacts(result, loc.allowed, loc.required, Infinity, loc.rules, { forbidArtifactsOnNonDone: loc.preparation === true });
      if (!checked.ok) fail('invalid-artifact-result');
      if (request.phase === 'plan' && result.status === 'done') require('./forge-task-preparation').preflightPlan(request, result.artifacts[0].content);
      const record = { result, artifacts: result.artifacts.map(a => ({ ...a, before: child.before[a.path] ?? null })) };
      await publishReadyRecord(request, record, undefined, publicationGuard);
      json(files.resultFile, result);
    } });
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
  const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd || process.cwd(),
    phase: 'memory-extract', forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
  return procedure.content + '\n\nRead-only memory extraction. Return exactly one JSON object matching the supplied schema. '
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
    ...(raw.observation ? { observation: require('./forge-sidecar-diagnostic').observation(raw.observation) } : {}),
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

async function publishReadyRecord(request, record, publicationGuard, publicationLock) {
  let result = await publishReadyRecordCore(request, record, publicationGuard, publicationLock);
  if (record.telemetry?.observation) result = { ...result, transport_telemetry: {
    ...result.transport_telemetry,
    observation: require('./forge-sidecar-calibration').observation(record.telemetry.observation),
  } };
  if (record.calibration_proposal && result.status === 'done'
      && !['deferred', 'quarantined', 'conflict'].includes(result.publication?.status)) {
    const outcome = await require('./forge-sidecar-calibration').commitAccepted(record.calibration_proposal, {
      fingerprint: record.fingerprint, receipt: artifactAttemptFiles(request).receiptFile,
    });
    result = { ...result, transport_telemetry: { ...result.transport_telemetry, calibration_commit: outcome } };
  }
  return result;
}
async function publishReadyRecordCore(request, record, publicationGuard, publicationLock) {
  if (record.execution) require('./forge-task-execution').assertReplay(request, record);
  if (record.kind === 'review-fix') return publishReviewFixRecord(request, record);
  if (record.kind !== 'memory-extraction') return materialize(request, record, publicationGuard, publicationLock);
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
function validNativeExecutionResult(candidate) {
  return xllm.validateExecuteResult(candidate)
    && Object.keys(candidate).every(key => ['status', 'summary', 'must_haves_status', 'files_changed'].includes(key))
    && candidate.must_haves_status.every(row => !Array.isArray(row)
      && Object.keys(row).every(key => ['item', 'status', 'note', 'scope', 'reason'].includes(key)));
}
function physicalFileIdentity(file) {
  const absolute = path.resolve(file), chain = [];
  let cursor = absolute;
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('native-prompt-file-link');
    chain.push({ path: cursor, dev: stat.dev, ino: stat.ino });
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!fs.statSync(absolute).isFile() || path.resolve(fs.realpathSync.native(absolute)) !== absolute) fail('native-prompt-file-target');
  return chain;
}
function nativeExecutionOptions(r, runtime, prompt) {
  return { hostRuntime: r.route.host_runtime, resolvedDispatch: r.route,
    activeCapabilities: runtime.activeCapabilities, agentType: 'forge-executor',
    taskName: r.nativeInvocation?.args?.task_name || r.taskName || r.dispatchId,
    forkTurns: 'none', effortBinding: r.effortBinding, prompt,
    readback: runtime.readback, telemetryIdentity: r, telemetryRoute: r.route };
}
function validateNativeExecutionBinding(r, runtime) {
  if (!r.execution_contract || !r.nativeInvocation?.ok) fail('native-execution-binding-required');
  const api = require('./forge-native-invocation');
  const supplied = r.nativeInvocation;
  const prompt = supplied.args?.message || supplied.args?.prompt;
  const fresh = api.buildNativeInvocation(nativeExecutionOptions(r, runtime, prompt));
  if (!fresh.ok) fail(fresh.reason_code);
  if (fresh.tool !== supplied.tool || fresh.host_runtime !== supplied.host_runtime
      || JSON.stringify(fresh.args) !== JSON.stringify(supplied.args)) fail('native-execution-binding-mismatch');
  // Replay needs no new callback; a new attempt does.
  if (!fs.existsSync(r.resultFile + '.receipt.json') && typeof runtime.invokeNative !== 'function') fail('native-tool-callback-missing');
  return fresh;
}
async function runNativeExecutionTransport(r, runtime, execution, options, procedure) {
  const planText = fs.readFileSync(r.planFile, 'utf8');
  let prompt = xllm.buildExecutePrompt(planText, {
    capability: require('./forge-must-haves').resolveCapability(planText).capability,
    constraints: r.constraints, securityText: execution.securityText,
    contextText: execution.contextText, procedure, outputChannel: 'json-only' });
  if (r.recoveryStateFile) {
    const recovery = require('./forge-procedure-context').loadProcedureContext({ cwd: r.cwd, phase: 'recovery',
      forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
    const present = new Set([...prompt.matchAll(/<!-- forge-procedure:([^>]+) -->/g)].map(match => match[1]));
    prompt += '\n\n' + recovery.content.split(/(?=<!-- forge-procedure:)/)
      .filter(segment => segment.trim() && !present.has(/^<!-- forge-procedure:([^>]+) -->/.exec(segment)?.[1])).join('');
  }
  let transportPrompt = prompt;
  if (r.nativePromptFile) {
    const file = xllm.validateResultFileTarget(r.nativePromptFile, r.cwd);
    xllm.validateResultFileTarget(file, r.contextRoot);
    for (const root of execution.execution_contract.code_roots) xllm.validateResultFileTarget(file, root.path);
    if (fs.existsSync(file)) {
      if (fs.readFileSync(file, 'utf8') !== prompt) fail('native-prompt-file-conflict');
    } else fs.writeFileSync(file, prompt, { flag: 'wx', mode: 0o600 });
    physicalFileIdentity(file);
    transportPrompt = 'Read the complete authorized execution prompt from file: ' + JSON.stringify(file)
      + '. Verify SHA-256 ' + hash(prompt) + ', then follow its full contents. Do not omit any section. Return the required execution JSON.';
  }
  const receiptFileBefore = r.resultFile + '.receipt.json';
  const initialRecord = JSON.parse(fs.readFileSync(receiptFileBefore));
  const expected = hash(JSON.stringify({ request: r, capabilities: runtime.activeCapabilities, verification: runtime.verification,
    baseline: initialRecord.recovery_baseline, seal: initialRecord.verification_seal, inputs: initialRecord.execution.inputs }));
  const initialState = hash(fs.readFileSync(initialRecord.recovery_baseline.state_file));
  const originalInvoke = runtime.invokeNative, originalReadback = runtime.readback;
  const beforeCode = execution && require('./forge-task-execution').replayState(r.cwd, execution.execution_contract);
  const promptIdentity = r.nativePromptFile ? physicalFileIdentity(r.nativePromptFile) : null;
  const assertInvocation = stage => {
    runtime.assertRecoveryAuthority?.();
    if (runtime.invokeNative !== originalInvoke || runtime.readback !== originalReadback) fail('native-execution-callback-changed');
    const record = JSON.parse(fs.readFileSync(receiptFileBefore));
    if (expected !== hash(JSON.stringify({ request: r, capabilities: runtime.activeCapabilities, verification: runtime.verification,
      baseline: record.recovery_baseline, seal: record.verification_seal, inputs: record.execution.inputs }))) fail('native-execution-authority-changed');
    const binding = validateNativeExecutionBinding(r, runtime);
    validateRecoveryRequest(r, { nativeInvocation: binding });
    if (hash(fs.readFileSync(initialRecord.recovery_baseline.state_file)) !== initialState) fail('recovery-baseline-binding');
    for (const [input, expectedHash] of Object.entries(initialRecord.execution.inputs)) {
      if (hash(fs.readFileSync(input)) !== expectedHash) fail('execution-input-changed');
    }
    const api = require('./forge-task-execution');
    if (stage !== 'publication') {
      api.assertProtected(r.contextRoot, initialRecord.recovery_baseline.protected_owner);
      for (const row of initialRecord.recovery_baseline.protected_roots) api.assertProtected(row.path, row.snapshot);
    }
    if (['packaged', 'before-invoke'].includes(stage)
      && JSON.stringify(api.replayState(r.cwd, execution.execution_contract)) !== JSON.stringify(beforeCode)) fail('execution-baseline-changed');
    if (r.nativePromptFile && (JSON.stringify(physicalFileIdentity(r.nativePromptFile)) !== JSON.stringify(promptIdentity)
      || !fs.readFileSync(r.nativePromptFile).equals(Buffer.from(prompt)))) fail('native-prompt-file-changed');
  };
  options.assertNativePublication = () => assertInvocation('publication');
  const nativeOptions = { ...nativeExecutionOptions(r, runtime, transportPrompt), assertInvocation,
    beforeInvoke: async () => { await options.announce('solicitado', { model_sent: r.route.model_resolved || r.route.model, provider_called: false }); },
    budgets: execution.budgets, onPackagedContext: packaged => options.onPackagedContext({ ...packaged,
      bytes: Buffer.byteLength(prompt), sha256: hash(prompt), transport_sha256: hash(transportPrompt),
      input_tokens: Math.ceil(prompt.length / 4), token_method: 'heuristic-chars-4' }) };
  const outcome = await require('./forge-native-invocation').invokeNative(nativeOptions, (args, binding) => {
    options.enterTransport();
    assertInvocation('before-invoke');
    return runtime.invokeNative(args, binding);
  });
  const receiptFile = r.resultFile + '.receipt.json';
  const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (outcome.final_evidence) json(receiptFile, { ...saved, final_evidence: outcome.final_evidence });
  if (!outcome.ok) throw Object.assign(new Error(outcome.reason_code), {
    code: outcome.reason_code, provider_called: outcome.provider_called });
  if (r.nativePromptFile && fs.readFileSync(r.nativePromptFile, 'utf8') !== prompt) throw Object.assign(new Error('native-prompt-file-changed'), { code: 'native-prompt-file-changed', provider_called: true });
  const raw = outcome.result;
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw : xllm.extractLastJsonBlock(raw);
  if (!validNativeExecutionResult(candidate)) throw Object.assign(new Error('native-execution-result-invalid'), { code: 'native-execution-result-invalid', provider_called: true });
  try { xllm.assertUntrustedOutputBarrier(candidate); }
  catch (error) { error.provider_called = true; throw error; }
  return { ...candidate, native: { telemetry: outcome.telemetry,
    packaged_context: { bytes: Buffer.byteLength(prompt), sha256: hash(prompt), transport_sha256: hash(transportPrompt),
      input_tokens: Math.ceil(prompt.length / 4), token_method: 'heuristic-chars-4', budgets: execution.budgets } } };
}

async function inspectSavedNativeExecution(r, runtime) {
  const resultFile = r.resultFile, receiptFile = resultFile + '.receipt.json';
  const existing = JSON.parse(fs.readFileSync(receiptFile));
  const receiptHash = hash(fs.readFileSync(receiptFile));
  const savedTargetIdentity = physicalFileIdentity(runtime.savedNativeResult.resultFile);
  const savedPromptIdentity = r.nativePromptFile ? physicalFileIdentity(r.nativePromptFile) : null;
  const baselineBytesHash = existing.recovery_baseline?.state_file ? hash(fs.readFileSync(existing.recovery_baseline.state_file)) : null;
  const requestHash = hash(JSON.stringify({ r, saved: runtime.savedNativeResult, caps: runtime.activeCapabilities, verification: runtime.verification }));
  const dispatchId = r.dispatchId, fingerprint = artifactFingerprint(r), route = r.route;
  const cwd = fs.realpathSync(r.cwd), root = fs.realpathSync(r.contextRoot || r.cwd);
  const inspect = () => {
    if (hash(fs.readFileSync(receiptFile)) !== receiptHash
      || requestHash !== hash(JSON.stringify({ r, saved: runtime.savedNativeResult, caps: runtime.activeCapabilities, verification: runtime.verification }))) fail('saved-native-authority-changed');
    if (!['failed', 'started'].includes(existing.phase) || existing.fingerprint !== fingerprint) fail('saved-native-result-binding');
    if (r.nativePromptFile && (JSON.stringify(physicalFileIdentity(r.nativePromptFile)) !== JSON.stringify(savedPromptIdentity)
        || hash(fs.readFileSync(r.nativePromptFile)) !== existing.execution?.packaged_context?.sha256)) fail('native-prompt-file-changed');
      const saved = runtime.savedNativeResult;
      const api = require('./forge-task-execution'), roots = require('./forge-code-roots');
      if (saved.dispatchId !== dispatchId
          || saved.fingerprint !== fingerprint || existing.dispatch_id !== dispatchId) fail('saved-native-result-binding');
      const file = xllm.validateResultFileTarget(saved.resultFile, cwd);
      xllm.validateResultFileTarget(file, root);
      for (const code of r.execution_contract.code_roots) xllm.validateResultFileTarget(file, code.path);
      if ([resultFile, receiptFile].some(p => path.resolve(p) === path.resolve(file))) fail('saved-native-result-target');
      if (JSON.stringify(physicalFileIdentity(file)) !== JSON.stringify(savedTargetIdentity)) fail('saved-native-result-target-changed');
      const bytes = fs.readFileSync(file);
      if (!/^[a-f0-9]{64}$/.test(saved.sha256 || '') || hash(bytes) !== saved.sha256) fail('saved-native-result-hash');
      let candidate;
      try { candidate = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
      catch { fail('native-execution-result-invalid'); }
      if (!validNativeExecutionResult(candidate)) fail('native-execution-result-invalid');
      xllm.assertUntrustedOutputBarrier(candidate);
      const baseline = existing.recovery_baseline;
      if (!baseline || baseline.schema_version !== 1) fail('recovery-baseline-required');
      const checked = validateRecoveryRequest(r, { nativeInvocation: validateNativeExecutionBinding(r, runtime) });
      const contract = roots.validateContract(baseline.execution_contract, { owner: root, revalidate: true });
      if (roots.digest(contract) !== roots.digest(checked.contract)) fail('recovery-baseline-contract-mismatch');
      require('./forge-attempt-recovery').validateStateTarget(baseline.state_file, r, contract);
      const state = require('./forge-surgical-reset').readState(baseline.state_file);
      if (hash(fs.readFileSync(baseline.state_file)) !== baselineBytesHash) fail('recovery-baseline-bytes-changed');
      if (baseline.dispatch_id !== dispatchId || baseline.fingerprint !== fingerprint
          || recoveryIdentity(r) !== existing.recovery_identity_sha256
          || baseline.state_sha256 !== baselineDigest(state) || state.attempt !== dispatchId
          || state.reconciliation || roots.digest(state.execution_contract) !== roots.digest(contract)) fail('recovery-baseline-binding');
      if (baseline.input.path !== checked.planFile
          || baseline.input.sha256 !== roots.digest(fs.readFileSync(baseline.input.path))) fail('recovery-baseline-input-changed');
      if (!existing.execution?.inputs || !Object.keys(existing.execution.inputs).length) fail('saved-native-inputs-required');
      for (const [input, expected] of Object.entries(existing.execution.inputs)) {
        if (hash(fs.readFileSync(input)) !== expected) fail('execution-input-changed');
      }
      // appendOwnedEvent advances only authenticated caller event bytes here.
      const protectedOwner = existing.execution.protected_owner || baseline.protected_owner;
      api.assertProtected(root, protectedOwner);
      if (baseline.protected_roots.length !== contract.code_roots.length) fail('recovery-baseline-roots-missing');
      for (const code of contract.code_roots) {
        const row = baseline.protected_roots.find(p => p.root_id === code.id && p.path === code.path);
        if (!row) fail('recovery-baseline-roots-missing');
        api.assertProtected(code.path, path.resolve(code.path) === path.resolve(root) ? protectedOwner : row.snapshot);
      }
      const plan = roots.validatePlan(fs.readFileSync(r.planFile, 'utf8'), contract);
      const verifiedFiles = api.verifyResult(cwd, { execution_contract: contract,
        claims: plan.writes, snapshots: state.repos }, candidate);
      const executed = { ...existing, phase: 'executed',
        saved_native_result: { path: file, sha256: saved.sha256, accepted_at: new Date().toISOString(),
          original_phase: existing.phase, provider_called: existing.final_evidence?.provider_called ?? 'unknown' },
        execution: { ...existing.execution, verified_files: verifiedFiles, protected_owner: protectedOwner,
          execution_contract: contract, code_state: api.replayState(cwd, contract) },
        result: { ...candidate, dispatch_id: dispatchId, workflow_id: r.workflowId,
          host_runtime: route.host_runtime, worker_engine: route.resolved_worker_engine } };

    const verificationApi = require('./forge-verify');
    const identity = { dispatch_id: dispatchId, fingerprint, recovery_identity_sha256: recoveryIdentity(r) };
    verificationApi.assertExecutionVerification(existing.verification_seal, r.execution_contract, fs.readFileSync(r.planFile, 'utf8'), identity);
    if (runtime.verification !== undefined && verificationApi.normalizeExecutionVerification(r.execution_contract,
      fs.readFileSync(r.planFile, 'utf8'), r.verification, runtime.verification, identity).sha256 !== existing.verification_seal.sha256) fail('verification-policy-changed');
    return executed;
  };
  inspect();
  const writer = await require('./forge-recovery-transition').observeStoppedWriter(runtime.writerObservationAdapter, {
    receiptFile, request: r, contract: r.execution_contract, processProbe: runtime.processProbe, assertUnchanged: inspect });
  await require('./forge-recovery-transition').assertWriterObservation(writer).refresh();
  return { writer, executed: inspect() };
}

async function runUnitSidecarCore(request, runtime, identity) {
  let transportReturned = false;
  let recoveryReady = runtime.assertRecoveryReady;
  const enterTransport = () => {
    recoveryReady?.();
    recoveryReady = null;
  };
  const r = request || {}, route = r.route || {};
  if (!fs.existsSync(`${r.resultFile}.receipt.json`)) require('./forge-dispatch-resolve').assertMilestoneContext(r);
  const transport = capability(route.resolved_worker_engine, r.unitType, r.scope === 'milestone' ? {} : r);
  if (!transport.supported) fail(transport.reason_code, transport.hint);
  const guard = evaluateDispatchGuard({ ...route, unit_type: r.unitType,
    ...(r.scope === 'milestone' ? { scope: undefined, phase: undefined } : { scope: r.scope, phase: r.phase }) });
  const nativeExecution = route.worker_mode === 'native' && r.scope === 'standalone-task' && r.phase === 'execute' && transport.mode === 'execute';
  const nativeBinding = nativeExecution ? validateNativeExecutionBinding(r, runtime) : null;
  const nativeAuthority = () => hash(JSON.stringify({ request: r, capabilities: runtime.activeCapabilities, verification: runtime.verification }));
  const nativeAuthorityHash = nativeExecution ? nativeAuthority() : null;
  const nativePromptIdentity = nativeExecution && r.nativePromptFile && fs.existsSync(r.nativePromptFile) ? physicalFileIdentity(r.nativePromptFile) : null;
  if (route.dispatch_allowed !== true || (!nativeExecution && (route.worker_mode !== 'sidecar' || !route.sidecar_declared))
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
  artifactAttemptFiles(r); // Validate all attempt channels against every declared root before writes.
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
  async function appendOwnedEvent(line, record) {
    if (recoveryReady?.appendOwnerEvent) return recoveryReady.appendOwnerEvent(line);
    if (r.ownerBroker) return require('./forge-artifact-reconciliation').assertBroker(r.ownerBroker)
      .append('.gsd/forge/events.jsonl', line);
    const protectedOwner = record?.execution?.protected_owner || record?.recovery_baseline?.protected_owner;
    if (!protectedOwner) { fs.appendFileSync(eventsFile, line); return; }
    const executionApi = require('./forge-task-execution');
    return require('./forge-artifact-reconciliation').withOwnerLock(root, () => {
      const expected = { ...protectedOwner };
      const current = executionApi.protectedSnapshot(root);
      for (const item of record.artifacts || []) if (current[item.path] === hash(item.content)) {
        expected[item.path] = current[item.path];
        let dir = path.posix.dirname(item.path);
        while (dir !== '.') { if (current[dir + '/'] === 'directory') expected[dir + '/'] = 'directory'; dir = path.posix.dirname(dir); }
      }
      executionApi.assertProtected(root, expected);
      const previous = fs.readFileSync(eventsFile);
      if (hash(previous) !== expected['.gsd/forge/events.jsonl']) fail('execution-owner-event-raced');
      fs.appendFileSync(eventsFile, line);
      const appended = Buffer.concat([previous, Buffer.from(line)]);
      if (!fs.readFileSync(eventsFile).equals(appended)) fail('execution-owner-event-raced');
      executionApi.assertProtected(root, { ...expected, '.gsd/forge/events.jsonl': hash(appended) });
      // Advance only these exact caller bytes, never adopt a fresh owner snapshot.
      const advanced = { ...protectedOwner, '.gsd/forge/events.jsonl': hash(appended) };
      if (record.execution) record.execution.protected_owner = advanced;
      else {
        record.recovery_baseline.protected_owner = advanced;
        for (const row of record.recovery_baseline.protected_roots) if (path.resolve(row.path) === path.resolve(root)) row.snapshot = advanced;
      }
      if (record.milestone_delivery) record.milestone_delivery.protected_owner = advanced;
      json(receiptFile, record);
    });
  }
  async function event(status, reasonCode, detail, providerCalled = false, extra = null) {
    if (!recoveryReady?.appendOwnerEvent) fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event: 'sidecar-unit',
      workflow_id: r.workflowId, dispatch_id: dispatchId,
      unit: label,
      host_runtime: route.host_runtime, worker_engine: route.resolved_worker_engine,
      worker_mode: nativeExecution ? 'native' : 'sidecar', model, tier: route.tier, effort: route.effort,
      model_requested: route.model_requested ?? null,
      model_resolved: route.model_resolved || route.model || null,
      effort_reason: route.effort_reason || null,
      status, provider_called: [true, false].includes(providerCalled) ? providerCalled : 'unknown', ...(reasonCode ? { reason_code: reasonCode } : {}),
      ...(detail ? { diagnostic: diagnostic(detail.reason, detail) } : {}),
      ...effortTelemetry(route), ...(extra || {}) }) + '\n';
    const record = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
    await appendOwnedEvent(line, record);
  }
  async function recordFailure(error, extra = null) {
    const code = error.code || 'sidecar-unit-failed';
    const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const detail = diagnostic(error.diagnostic?.reason || (code === 'untrusted-output-barrier'
      ? 'control-data-output' : code === 'artifact-direct-write-detected' ? 'validator-failed'
        : ['ready', 'executed'].includes(record.phase) ? 'publication-failed' : 'adapter-failed'), error.diagnostic);
    const replayable = ['ready', 'executed'].includes(record.phase);
    if (replayable) error.stage = 'publication';
    error.diagnostic = detail;
    if (record.final_evidence) record.final_evidence = { ...record.final_evidence,
      stage: error.provider_called === false ? 'prepared' : transportReturned ? 'returned' : 'invoked',
      duration_ms: record.started_at ? Date.now() - Date.parse(record.started_at) : null,
      provider_called: typeof error.provider_called === 'boolean' ? error.provider_called : 'unknown' };
    const failure = { status: 'adapter-failed', dispatch_id: dispatchId, reason_code: code,
      provider_called: typeof error.provider_called === 'boolean' ? error.provider_called : record.provider_called === true ? true : 'unknown',
      error_class: xllm.classifyErrorClass(error.message), diagnostic: detail,
      final_evidence: record.final_evidence || null,
      layer: replayable ? 'publication' : 'transport-adapter',
      duration_ms: record.started_at ? Date.now() - Date.parse(record.started_at) : null,
      ...(record.execution ? { request_sha256: fingerprint, packaged_context: record.execution.packaged_context || null,
        budgets: record.execution.budgets, layer: replayable ? 'publication' : 'writing-adapter',
        model_sent: error.provider_called === true || record.provider_called === true ? model : null,
        duration_ms: record.started_at ? Date.now() - Date.parse(record.started_at) : null } : {}),
      recovery: replayable ? 'replay-publication' : 'operator-required',
      failed_at: new Date().toISOString(), ...(replayable ? {} : (extra || {})) };
    // Never overwrite the validated response if publication was interrupted.
    if (!replayable) json(receiptFile, { ...record, phase: 'failed', failure });
    json(resultFile, failure);
    try {
      require('./forge-attempt-recovery').captureFailure({ stateFile: r.recoveryStateFile || `${resultFile}.recovery.json`,
        unit: `${r.unitType}/${r.taskId || r.sliceId || r.milestoneId}`, contract: r.execution_contract,
        request: r, finalEvidence: record.final_evidence, route, receiptFile, error: { ...error, provider_called: failure.provider_called },
        layer: failure.layer || detail.reason, packagedContext: record.execution?.packaged_context,
        budgets: record.execution?.budgets, durationMs: record.started_at ? Date.now() - Date.parse(record.started_at) : 0 });
    } catch (captureError) {
      // Strict recovery validation can refuse contracts such as memory-extract.
      // Preserve the original adapter error and expose the secondary refusal;
      // no recovery state or authorization is fabricated for an invalid identity.
      failure.recovery = 'unavailable';
      failure.recovery_reason_code = require('./forge-attempt-telemetry').code(captureError.code, 'recovery-capture-failed');
      if (!replayable) json(receiptFile, { ...record, phase: 'failed', failure });
      json(resultFile, failure);
    }
    try { await event('failed', code, detail, failure.provider_called,
      loc.reviewFix ? { boundary: loc.reviewFix.boundary, items_total: reviewFixItemsTotal(r) } : null); }
    catch { /* Unproved owner drift cannot be adopted just to log a failure. */ }
  }
  const existing = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  const verificationIdentity = { dispatch_id: dispatchId, fingerprint, recovery_identity_sha256: recoveryIdentity(r) };
  const verificationApi = require('./forge-verify');
  const verifySeal = record => {
    if (transport.mode !== 'execute' || !r.execution_contract) return;
    if (!record.verification_seal) {
      if (!nativeExecution && runtime.verification === undefined) return;
      if (!record.delivery_capture || runtime.verification !== undefined) fail('verification-provenance-insufficient');
      return;
    }
    verificationApi.assertExecutionVerification(record.verification_seal, r.execution_contract, fs.readFileSync(r.planFile, 'utf8'), verificationIdentity);
    if (runtime.verification !== undefined) {
      const supplied = verificationApi.normalizeExecutionVerification(r.execution_contract, fs.readFileSync(r.planFile, 'utf8'), r.verification, runtime.verification, verificationIdentity);
      if (supplied.sha256 !== record.verification_seal.sha256) fail('verification-policy-changed');
    }
    if (record.delivery_capture && record.delivery_capture.verification_policy_sha256 !== record.verification_seal.sha256) fail('verification-capture-binding');
  };
  const assertNativePublication = record => {
    if (!nativeExecution) return;
    runtime.assertRecoveryAuthority?.();
    if (nativeAuthority() !== nativeAuthorityHash) fail('native-execution-authority-changed');
    validateRecoveryRequest(r, { nativeInvocation: validateNativeExecutionBinding(r, runtime) });
    verifySeal(record);
    const baseline = record.recovery_baseline;
    if (!baseline || baseline.fingerprint !== record.fingerprint || baseline.dispatch_id !== r.dispatchId) fail('recovery-baseline-binding');
    const state = require('./forge-surgical-reset').readState(baseline.state_file);
    if (state.attempt !== r.dispatchId || state.reconciliation || baselineDigest(state) !== baseline.state_sha256
        || require('./forge-code-roots').digest(state.execution_contract) !== require('./forge-code-roots').digest(r.execution_contract)) fail('recovery-baseline-binding');
    for (const row of baseline.protected_roots) {
      if (path.resolve(row.path) !== path.resolve(root)) require('./forge-task-execution').assertProtected(row.path, row.snapshot);
    }
    if (r.nativePromptFile) {
      const physical = physicalFileIdentity(r.nativePromptFile);
      if ((nativePromptIdentity && JSON.stringify(physical) !== JSON.stringify(nativePromptIdentity))
          || hash(fs.readFileSync(r.nativePromptFile)) !== record.execution.packaged_context.sha256) fail('native-prompt-file-changed');
    }
  };
  async function completeExecution(record, deferredEvents = null) {
    verifySeal(record);
    if (record.execution) require('./forge-task-execution').assertReplay(r, record);
    else if (record.milestone_delivery) {
      const api = require('./forge-task-execution');
      const saved = record.milestone_delivery;
      assertMilestoneDeliveryReplay(r, record);
      api.assertProtected(root, saved.protected_owner);
    }
    if (r.execution_contract && !record.delivery_capture) {
      const resourceEvents = [];
      const deliveryCapture = require('./forge-verify').captureRootDelivery(r.execution_contract,
        fs.readFileSync(r.planFile, 'utf8'), { ...r.verification, verificationSeal: record.verification_seal, verificationIdentity, unit: loc.rules[loc.delivery.input].unit,
          resourceEventSink: line => resourceEvents.push(line) });
      if (deferredEvents) deferredEvents.push(...resourceEvents);
      else for (const line of resourceEvents) await appendOwnedEvent(line, record);
      if (!deliveryCapture.passed) fail('execution-verification-failed');
      record = { ...record, delivery_capture: deliveryCapture };
      if (record.execution) require('./forge-task-execution').assertReplay(r, record);
      if (!deferredEvents) json(receiptFile, record);
    }
    const artifacts = executeDeliveryArtifacts(r, loc, record.result, root, cwd, record.delivery_capture);
    const ready = { ...record, phase: 'ready', artifacts: artifacts.map(a => ({ ...a, before: record.before[a.path] ?? null })) };
    if (!deferredEvents) json(receiptFile, ready);
    return ready;
  }
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
    if (existing.phase === 'ready' || existing.phase === 'executed') {
      if (nativeExecution) {
        const { native: ignoredNative, dispatch_id: ignoredDispatch, workflow_id: ignoredWorkflow,
          host_runtime: ignoredHost, worker_engine: ignoredEngine, ...candidate } = existing.result || {};
        if (!validNativeExecutionResult(candidate)) fail('native-execution-result-invalid');
        xllm.assertUntrustedOutputBarrier(candidate);
      }
      verifySeal(existing);
      const replayHash = hash(fs.readFileSync(receiptFile));
      const replayBaselineHash = nativeExecution && existing.recovery_baseline?.state_file
        ? hash(fs.readFileSync(existing.recovery_baseline.state_file)) : null;
      await runtime.announce?.('reaproveitado', { ...identity, provider_called: false });
      if (nativeExecution && hash(fs.readFileSync(receiptFile)) !== replayHash) fail('native-replay-receipt-changed');
      if (replayBaselineHash && hash(fs.readFileSync(existing.recovery_baseline.state_file)) !== replayBaselineHash) fail('recovery-baseline-bytes-changed');
      if (nativeExecution) validateRecoveryRequest(r, { nativeInvocation: validateNativeExecutionBinding(r, runtime) });
      verifySeal(existing);
      assertNativePublication(existing);
      try {
        const ready = existing.phase === 'executed' ? await completeExecution(existing) : existing;
        const result = await publishReadyRecord(r, ready, () => assertNativePublication(ready));
        json(resultFile, result);
        return result;
      } catch (error) { await recordFailure(error); throw error; }
    }
    if (nativeExecution && runtime.savedNativeResult && ['failed', 'started'].includes(existing.phase)) {
      const inspected = await inspectSavedNativeExecution(r, runtime);
      require('./forge-recovery-transition').assertWriterObservation(inspected.writer);
      const executed = inspected.executed;
      // Keep the original failed/started receipt durable until the final live
      // writer attestation and publication acceptance have both succeeded.
      const deferredEvents = [];
      const ready = await completeExecution(executed, deferredEvents);
      if (require('./forge-attempt-recovery').inspectReceipt(receiptFile, { request: r, processProbe: runtime.processProbe }).process_stopped !== true) fail('writer-observation-not-stopped');
      validateRecoveryRequest(r, { nativeInvocation: validateNativeExecutionBinding(r, runtime) });
      verifySeal(ready);
      const savedFile = runtime.savedNativeResult.resultFile;
      const savedIdentity = physicalFileIdentity(savedFile);
      const assertAccepted = () => {
        assertNativePublication(ready);
        require('./forge-task-execution').assertReplay(r, ready);
        if (hash(fs.readFileSync(savedFile)) !== runtime.savedNativeResult.sha256
            || JSON.stringify(physicalFileIdentity(savedFile)) !== JSON.stringify(savedIdentity)) fail('saved-native-result-changed');
      };
      const publicationWriter = await require('./forge-recovery-transition').observeStoppedWriter(runtime.writerObservationAdapter,
        { previous: inspected.writer, receiptFile, request: r, contract: r.execution_contract,
          processProbe: runtime.processProbe, assertUnchanged: assertAccepted });
      const result = await publishReadyRecord(r, ready, () => {
        require('./forge-recovery-transition').assertWriterObservation(publicationWriter);
        assertAccepted();
      });
      for (const line of deferredEvents) await appendOwnedEvent(line, ready);
      json(receiptFile, ready);
      json(resultFile, result);
      await event(result.status, 'saved-native-result-accepted', null, existing.final_evidence?.provider_called ?? 'unknown');
      return result;
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
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^T\d+(?:\.\d+)?$/.test(name)) : []) {
      const p = `${loc.slice}/tasks/${name}/${name}-PLAN.md`;
      before[p] = fileHash(target(root, p));
    }
  }
  const bookkeeping = r.unitType === 'complete-slice' ? `${loc.milestone}/${r.milestoneId}-ROADMAP.md`
    : r.unitType === 'execute-task' && !loc.execution ? `${loc.slice}/${r.sliceId}-PLAN.md` : null;
  const bookkeepingText = bookkeeping && fs.readFileSync(target(root, bookkeeping), 'utf8');
  if (bookkeeping) before[bookkeeping] = hash(bookkeepingText);
  // Review-fix: boundary and claim are validated, then the surgical-reset state
  // is captured, all BEFORE the started receipt. A refusal here leaves no
  // receipt and never reaches a provider.
  const fix = transport.mode === 'fix' ? prepareReviewFix(r, loc, { cwd, root, resultFile, route, dispatchId }) : null;
  const executionApi = loc.execution ? require('./forge-task-execution') : null;
  const execution = executionApi ? executionApi.prepare({ ...r, ...(nativeBinding ? { nativeInvocation: nativeBinding } : {}) }, root, cwd) : null;
  let executeProcedure;
  if (transport.mode === 'execute') {
    executeProcedure = require('./forge-procedure-context').loadProcedureContext({ cwd,
      phase: r.scope === 'standalone-task' ? 'execute-loose-task' : 'execute-task',
      forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
    if (r.prompt || r.promptFile) require('./forge-prompt').composeProcedurePrompt(r.prompt
      || fs.readFileSync(r.promptFile, 'utf8'), executeProcedure, r.procedure_context);
    if (r.contextFile) require('./forge-prompt').separateProcedurePrompt(fs.readFileSync(r.contextFile, 'utf8'),
      executeProcedure, r.procedure_context);
  }
  // Compose at the delivery boundary, using the physical code checkout.
  // Explicit/file prompts carry no exemption from fresh corpus validation.
  let deliveryPrompt;
  if (['artifacts', 'plan'].includes(transport.mode)) {
    const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd, phase: r.scope === 'standalone-task' ? `task-${r.phase}` : r.unitType,
      forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
    if (transport.mode === 'plan' && !r.promptFile) fail('prompt-file-required');
    const rendered = !(typeof r.prompt === 'string' && r.prompt.trim()) && !r.promptFile ? renderPrompt({
      unitType: r.unitType, cwd: root, codeDir: cwd, milestoneId: r.milestoneId, sliceId: r.sliceId,
      description: r.description, unitEffort: route.effort, autoCommit: false,
    }) : null;
    const base = transport.mode === 'plan' ? fs.readFileSync(r.promptFile, 'utf8')
      : typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt
        : r.promptFile ? fs.readFileSync(r.promptFile, 'utf8') : rendered.prompt;
    deliveryPrompt = require('./forge-prompt').composeProcedurePrompt(base, procedure,
      rendered ? rendered.procedure_context : r.procedure_context);
  }
  const executionStateFile = execution ? xllm.validateResultFileTarget(`${resultFile}.reset-state.json`, cwd) : null;
  if (execution) {
    xllm.validateResultFileTarget(executionStateFile, root);
  }
  const verificationSeal = transport.mode === 'execute' && r.execution_contract && (nativeExecution || r.verification || runtime.verification) ? verificationApi.normalizeExecutionVerification(r.execution_contract, fs.readFileSync(r.planFile, 'utf8'), r.verification, runtime.verification, verificationIdentity) : null;
  const startedAt = new Date().toISOString();
  // Exclusive creation arbitrates concurrent invocations of the same attempt.
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'started', fingerprint, dispatch_id: dispatchId, before, started_at: startedAt,
    recovery_identity_sha256: recoveryIdentity(r), route, ...(verificationSeal ? { verification_seal: verificationSeal } : {}),
    ...(execution ? { execution: { inputs: execution.inputs, budgets: execution.budgets }, reset_state_file: executionStateFile } : {}),
    input_pending_questions: r.pending_questions || [],
    request_fingerprint: r.preparationRequestFingerprint || null,
    preparation_identity: r.preparationIdentity || null,
    ...(fix ? { kind: 'review-fix', review_fix_identity: fix.brief.identity, reset_state_file: fix.stateFile,
      route_identity: routeIdentity(route, r.unitType), review_snapshot: fix.reviewSnapshot } : {}) }),
  { flag: 'wx', mode: 0o600 });
  await event('started', null, null, false, fix ? { boundary: loc.reviewFix.boundary, items_total: fix.items.length } : null);
  const dispatchEvent = require('./forge-dispatch-event').buildDispatchEvent({
    unit: label,
    milestone: r.milestoneId,
    slice: r.sliceId, dispatchId, model, engine: route.resolved_worker_engine,
    transport: route.resolved_worker_engine === 'claude' ? 'claude-cli' : 'app-server',
  }, route, startedAt);
  if (r.ownerBroker) await require('./forge-artifact-reconciliation').assertBroker(r.ownerBroker).append('.gsd/forge/events.jsonl', JSON.stringify(dispatchEvent) + '\n');
  else if (recoveryReady?.appendOwnerEvent) recoveryReady.appendOwnerEvent(JSON.stringify(dispatchEvent) + '\n');
  else fs.appendFileSync(eventsFile, JSON.stringify(dispatchEvent) + '\n');
  if (loc.preparation) {
    const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    saved.preparation_surface = preparationSurfaceSnapshot(r);
    saved.before_state = Object.fromEntries(loc.allowed.map(p => [p, fileState(target(root, p))]));
    json(receiptFile, saved);
  }
  let providerCalled = false;
  let transportEntered = false;
  const announce = (stage, fields) => {
    return runtime.announce?.(stage, fields);
  };
  const options = { enterTransport: () => { enterTransport(); transportEntered = true; }, cwd, contextRoot: root, engine: route.resolved_worker_engine,
    unitType: r.unitType,
    calibrationOptions: runtime.calibrationOptions,
    onProgress: snapshot => {
      const safe = require('./forge-sidecar-calibration').observation(snapshot);
      const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (saved.phase === 'started') json(receiptFile, { ...saved,
        telemetry: { ...saved.telemetry, observation: safe } });
      if (runtime.onProgress) return runtime.onProgress(safe);
      if (require.main === module) process.stderr.write(require('./forge-sidecar-calibration').progressLine(safe));
    },
    telemetryIdentity: r, telemetryRoute: route, budgets: execution?.budgets || r.budgets || {},
    onPackagedContext: packaged => {
      const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      json(receiptFile, { ...saved, final_evidence: packaged.final_evidence,
        ...(saved.execution ? { execution: { ...saved.execution, packaged_context: packaged } } : {}) });
      return runtime.onPackagedContext?.(packaged);
    },
    hostRuntime: route.host_runtime, sidecarDeclared: true, model,
    effort: route.effort, timeoutSecs: route.workers_timeout || DEFAULT_WORKER_TIMEOUT_SECS, resultFile, dispatchId,
    constraints: r.constraints || { auto_commit: false, deploy: false },
    signal: r.signal, announce, identity: { phase: identity.phase, unit: identity.unit, dispatch_id: dispatchId,
      model_resolved: identity.model_resolved },
    // Defense in depth behind the resolver refusal: the Claude CLI adapter
    // refuses a thinking mode it has no documented argument for.
    ...(route.thinking_requested ? { thinkingRequested: route.thinking_requested } : {}),
  };
  const heartbeat = pid => {
    if (Number.isInteger(pid) && pid > 0) {
      announce('iniciado', { ...identity, pid, provider_called: 'unknown' });
    }
    json(resultFile, { status: 'running', pid, adapter_pid: process.pid,
      heartbeat_interval_ms: 15000, started_at: startedAt, updated_at: new Date().toISOString(), dispatch_id: dispatchId });
  };
  try {
    // Only the process that acquired the exclusive receipt may capture/reset
    // this attempt's durable baseline. A concurrent caller cannot overwrite it.
    // Milestone execution uses the execute adapter too. Its internal audit
    // snapshot is not the caller's durable recovery authority.
    if (transport.mode === 'execute') {
      const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      const baseline = captureMilestoneBaseline(r, saved, { nativeInvocation: nativeBinding });
      json(receiptFile, { ...saved, recovery_baseline: baseline });
    }
    const authorizationReference = require('./forge-attempt-recovery').bindRecoveryAuthorization(runtime.recoveryAuthorization);
    if (authorizationReference) {
      const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      json(receiptFile, { ...saved, authorization_reference: authorizationReference });
    }
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
        enterTransport();
        transportEntered = true;
        const output = await xllm.invokeClaudeTransport({ ...options, prompt, resultProfile:'memory', resultSchema:memorySchema, calibrationPhase:'memory',
          readOnly: true, validateCandidate: validateMemory, onHeartbeat: heartbeat,
          heartbeatIntervalMs: 15000, terminateChild: xllm.terminateOwnedProcessTree });
        transportReturned = true;
        result = output.candidate;
        transportTelemetry = output.telemetry || null;
      } else {
        enterTransport();
        transportEntered = true;
        const output = await xllm.invokeCodexAppServer({ ...options, prompt, schema: memorySchema,
          sandbox: 'read-only', onHeartbeat: heartbeat });
        transportReturned = true;
        result = xllm.extractLastJsonBlock(output.finalText || output.agentTexts);
      }
      result = require('./forge-memory-extraction').validateExtractionResult(result, { sourceUnit: loc.sourceUnit });
      xllm.assertUntrustedOutputBarrier(result);
      artifacts = [];
    } else if (transport.mode === 'execute') {
      const procedure = executeProcedure;
      const { content: procedureText, ...procedure_context } = procedure;
      if (r.prompt) require('./forge-prompt').composeProcedurePrompt(r.prompt, procedure, r.procedure_context);
      const protectedBefore = execution ? executionApi.protectedSnapshot(root) : null;
      const codeProtectedBefore = execution ? execution.execution_contract.code_roots.map(code => ({ root: code.path,
        before: executionApi.protectedSnapshot(code.path) })) : [];
      if (!nativeExecution) { enterTransport(); transportEntered = true; }
      result = nativeExecution ? await runNativeExecutionTransport(r, runtime, execution, options, procedure) : await xllm.runExecute({ ...options, scope: r.scope, planFile: r.planFile, securityFile: r.securityFile,
        contextFile: r.contextFile, writableRoots: execution ? execution.writableRoots
          : r.execution_contract ? r.execution_contract.code_roots.filter(code =>
            require('./forge-code-roots').key(fs.realpathSync.native(code.path)) !==
            require('./forge-code-roots').key(fs.realpathSync.native(cwd))).map(code => code.path) : r.writableRoots,
        executionContext: execution || (r.execution_contract
          ? { execution_contract: r.execution_contract, budgets: r.budgets || {} } : undefined),
        procedureContext: { procedureText, procedure_context } });
      transportReturned = true;
      transportTelemetry = result.transport_telemetry || null;
      const trustedTransportRecord = transportTelemetry ? {
        telemetry: { ...observedModelTelemetry(transportTelemetry),
          observation: require('./forge-sidecar-diagnostic').observation(transportTelemetry.observation) },
        ...(transportTelemetry.calibration_proposal ? { calibration_proposal: transportTelemetry.calibration_proposal } : {}),
      } : {};
      if (execution) {
        if (r.ownerBroker) require('./forge-artifact-reconciliation').assertBroker(r.ownerBroker).verify();
        else executionApi.assertProtected(root, protectedBefore);
        for (const code of codeProtectedBefore) executionApi.assertProtected(code.root, code.before);
        const verifiedFiles = executionApi.verifyResult(cwd, execution, result);
        // Persist the validated writing response before delivery rendering, which
        // can itself fail. Replay never starts a second writer.
        const executed = { ...JSON.parse(fs.readFileSync(receiptFile, 'utf8')), phase: 'executed', fingerprint, dispatch_id: dispatchId, before, started_at: startedAt,
          final_evidence: (() => {
            const evidence = JSON.parse(fs.readFileSync(receiptFile, 'utf8')).final_evidence;
            return evidence ? { ...evidence, stage: 'returned', provider_called: true,
              duration_ms: Date.now() - Date.parse(startedAt) } : null;
          })(),
          route, route_identity: routeIdentity(route, r.unitType), provider_called: true,
          reset_state_file: executionStateFile,
          ...trustedTransportRecord,
          execution: { inputs: execution.inputs, budgets: execution.budgets, verified_files: verifiedFiles,
            protected_owner: executionApi.protectedSnapshot(root),
            execution_contract: execution.execution_contract,
            code_state: executionApi.replayState(cwd, execution.execution_contract), packaged_context: result.native?.packaged_context || result.appserver?.packaged_context },
          result: { ...result, dispatch_id: dispatchId, workflow_id: r.workflowId,
            host_runtime: route.host_runtime, worker_engine: options.engine } };
        json(receiptFile, executed);
        const ready = await completeExecution(executed);
        result = await publishReadyRecord(r, ready, () => { assertNativePublication(ready); options.assertNativePublication?.(); });
        json(resultFile, result);
        await event(result.status, null, null, true);
        return result;
      }
      if (r.execution_contract && result.status === 'done') {
        const api = require('./forge-task-execution');
        const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        api.assertProtected(root, saved.recovery_baseline.protected_owner);
        for (const entry of saved.recovery_baseline.protected_roots) api.assertProtected(entry.path, entry.snapshot);
        const roots = require('./forge-code-roots');
        const baseline = saved.recovery_baseline;
        const state = require('./forge-surgical-reset').readState(baseline.state_file);
        if (baseline.state_sha256 !== baselineDigest(state)) fail('recovery-baseline-binding');
        if (baseline.input.sha256 !== roots.digest(fs.readFileSync(baseline.input.path))) fail('execution-input-changed');
        const checked = roots.validatePlan(fs.readFileSync(r.planFile, 'utf8'), r.execution_contract);
        const verifiedFiles = api.verifyResult(cwd, { execution_contract: r.execution_contract,
          claims: checked.writes, snapshots: state.repos }, result);
        // Save the validated response before checks/publication. A failing gate
        // must replay delivery, never infer again or capture a new writer baseline.
        const executed = { ...saved, phase: 'executed', provider_called: true, ...trustedTransportRecord,
          final_evidence: saved.final_evidence ? { ...saved.final_evidence, stage: 'returned', provider_called: true,
            duration_ms: Date.now() - Date.parse(startedAt),
            model_observed: result.transport_telemetry?.model_observed || result.appserver?.transport_telemetry?.model_observed || null } : null,
          milestone_delivery: { plan_sha256: hash(fs.readFileSync(r.planFile)),
            verified_files: verifiedFiles,
            protected_owner: api.protectedSnapshot(root),
            protected_roots: saved.recovery_baseline.protected_roots,
            code_state: api.replayState(cwd, r.execution_contract) },
          result: { ...result, dispatch_id: dispatchId, workflow_id: r.workflowId,
            host_runtime: route.host_runtime, worker_engine: options.engine } };
        json(receiptFile, executed);
        const ready = await completeExecution(executed);
        result = await publishReadyRecord(r, ready, () => { assertNativePublication(ready); options.assertNativePublication?.(); });
        json(resultFile, result);
        await event(result.status, null, null, true);
        return result;
      }
      artifacts = executeDeliveryArtifacts(r, loc, result, root, cwd);
    } else if (transport.mode === 'plan') {
      if (!r.promptFile) fail('prompt-file-required');
      // runPlan consumes a file: pass only the validated composed snapshot,
      // never reread the caller's mutable original after preflight.
      const promptDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-plan-procedure-'));
      try {
        const planContextFile = path.join(promptDir, 'context.md');
        fs.writeFileSync(planContextFile, deliveryPrompt, { mode: 0o600 });
        enterTransport();
        transportEntered = true;
        result = await xllm.runPlan({ ...options, planContextFile });
        transportReturned = true;
      } finally { fs.rmSync(promptDir, { recursive: true, force: true }); }
      const ids = result.task_plans.map(p => p.id);
      if (new Set(ids).size !== ids.length) fail('plan-task-ids-invalid');
      const listed = require('./forge-status').parsePlanTasks(result.slice_plan.content).map(t => t.id);
      if (JSON.stringify([...listed].sort()) !== JSON.stringify([...ids].sort())) fail('plan-task-list-mismatch');
      artifacts = [{ path: loc.required[0], content: result.slice_plan.content },
        ...result.task_plans.map(p => {
          if (!/^T\d+(?:\.\d+)?$/.test(p.id)) fail('plan-task-ids-invalid');
          const legacy = target(root, `${loc.slice}/tasks/${p.id}-PLAN.md`);
          if (fs.existsSync(legacy)) fail('legacy-task-plan-conflict', 'Migrate the explicitly selected legacy plan before publishing a second source.');
          return { path: `${loc.slice}/tasks/${p.id}/${p.id}-PLAN.md`, content: p.content };
        })];
    } else if (transport.mode === 'artifacts') {
      const payloadLimit = options.engine === 'claude' || loc.preparation ? MAX_ARTIFACT_PAYLOAD_BYTES : Infinity;
      const prompt = deliveryPrompt + '\n\n## Sidecar delivery contract (overrides direct-write instructions above)\n'
        + 'Read-only worker. Return artifact CONTENT, never write files, run commands, commit, tag, push, deploy, clean up, update STATE or acquire leases. The orchestrator owns these actions. '
        + 'Do not assume answers to human decisions. Return partial and questions when a decision is required. '
        + 'Operator constraints: ' + JSON.stringify(r.constraints || { auto_commit: false, deploy: false })
        + '\nRequired paths on done: ' + JSON.stringify(loc.required) + '\nOnly allowed artifact paths: ' + JSON.stringify(loc.allowed)
        + `\nLimits: at most 32 artifacts; each content at most ${MAX_ARTIFACT_BYTES} UTF-8 bytes.`
        + (loc.delivery ? ` Contract-typed DELIVERY output at ${JSON.stringify(loc.delivery.output)} may instead contain at most ${MAX_DELIVERY_BYTES} UTF-8 bytes; all other artifact limits remain as stated.` : '')
        + (Number.isFinite(payloadLimit) ? ` The entire serialized result JSON must fit in ${payloadLimit} UTF-8 bytes.` : '')
        + ' Return partial with questions if complete delivery cannot fit; never truncate an artifact.'
        + '\nReturn JSON matching: ' + JSON.stringify(schema);
      announce('solicitado', { ...identity, provider_called: false });
      xllm.authorizeSidecar('artifacts', options);
      heartbeat(null);
      if (options.engine === 'claude') {
        enterTransport();
        transportEntered = true;
        const output = await xllm.invokeClaudeTransport({ ...options, prompt, resultProfile:loc.preparation?'preparation':'artifacts', resultSchema:schema, calibrationPhase:r.phase || 'artifacts',
          readOnly: true, validateCandidate: value => inspectArtifacts(value, loc.allowed, loc.required, payloadLimit, loc.rules,
            { forbidArtifactsOnNonDone: loc.preparation === true }), onHeartbeat: heartbeat,
          heartbeatIntervalMs: 15000, terminateChild: xllm.terminateOwnedProcessTree });
        transportReturned = true;
        result = output.candidate;
        transportTelemetry = output.telemetry || null;
      } else {
        enterTransport();
        transportEntered = true;
        const output = await xllm.invokeCodexAppServer({ ...options, prompt, schema, sandbox: 'read-only', onHeartbeat: heartbeat });
        transportReturned = true;
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
      if (loc.preparation) {
        const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        if (r.ownerBroker) {
          const responseAnchor = await require('./forge-artifact-reconciliation').assertBroker(r.ownerBroker).bindResponse(result);
          fs.writeFileSync(`${receiptFile}.response-anchor.json`, JSON.stringify(responseAnchor) + '\n', { flag: 'wx', mode: 0o600 });
        }
        saved.saved_candidate = { sha256: hash(JSON.stringify(result)), result,
          plan_sha256: r.ownerBroker?.manifest?.plan_sha256 || null };
        json(receiptFile, saved);
        if (r.ownerBroker) require('./forge-artifact-reconciliation').assertBroker(r.ownerBroker).verify();
        else if (JSON.stringify(preparationSurfaceSnapshot(r)) !== JSON.stringify(saved.preparation_surface)) fail('artifact-direct-write-detected');
        if (r.phase === 'plan' && result.status === 'done') saved.plan_contract = require('./forge-task-preparation').preflightPlan(r, result.artifacts[0].content);
        saved.pending_questions = require('./forge-interaction').mergePendingQuestions(r.pending_questions || [], result.questions || []);
        json(receiptFile, saved);
      }
      artifacts = result.status === 'done' ? result.artifacts : [];
    } else if (transport.mode === 'fix') {
      // Scoped writing turn through the shared execute safety core. The worker
      // never commits; outside-claim, .gsd and a moved baseline are named failures.
      enterTransport();
      transportEntered = true;
      result = await xllm.runFix({ ...options, brief: fix.brief, writableRoots: r.writableRoots });
      transportReturned = true;
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
      : { ...JSON.parse(fs.readFileSync(receiptFile, 'utf8')), phase: 'ready', fingerprint, dispatch_id: dispatchId, result: { ...result, dispatch_id: dispatchId,
        workflow_id: r.workflowId, host_runtime: route.host_runtime, worker_engine: options.engine },
        input_pending_questions: r.pending_questions || [],
        request_fingerprint: r.preparationRequestFingerprint || null,
        preparation_identity: r.preparationIdentity || null,
        route, route_identity: routeIdentity(route, r.unitType), provider_called: true,
        telemetry: { model_requested: route.model_requested ?? null,
          model_resolved: route.model_resolved || route.model || null,
          ...observedModel,
          effort_resolved: route.effort || null, effort_reason: route.effort_reason || null },
        artifacts: artifacts.map(a => ({ ...a, before: before[a.path] ?? null })) };
    if (transportTelemetry) record.telemetry = {...record.telemetry, observation: transportTelemetry.observation ? require('./forge-sidecar-calibration').observation(transportTelemetry.observation) : null};
    if (transportTelemetry?.calibration_proposal) record.calibration_proposal = transportTelemetry.calibration_proposal;
    const finalEvidence = JSON.parse(fs.readFileSync(receiptFile, 'utf8')).final_evidence;
    if (finalEvidence) record.final_evidence = { ...finalEvidence, stage: 'returned', provider_called: true,
      duration_ms: Date.now() - Date.parse(startedAt), model_observed: observedModel.model_observed || null };
    // Durable validated response BEFORE artifact publication: a crash anywhere
    // after here replays publication, without spending another provider turn.
    json(receiptFile, record);
    result = await publishReadyRecord(r, record);
    json(resultFile, result);
    if (transport.mode !== 'memory') {
      await event(result.status, null, null, true, fix ? { boundary: loc.reviewFix.boundary, items_total: result.items.length,
        items_fixed: result.items.filter(item => item.verified).length, commit_sha: result.commit_sha,
        effort_sent: result.telemetry ? result.telemetry.effort_sent : null } : null);
    }
    return result;
  } catch (error) {
    // A heartbeat proves a local process, not provider acceptance. A timeout
    // without adapter evidence stays unknown; an explicit pre-spawn refusal is false.
    providerCalled = typeof error.provider_called === 'boolean' ? error.provider_called
      : transportReturned ? true : transportEntered ? 'unknown' : false;
    error.provider_called = providerCalled;
    announce(providerCalled ? 'falhou' : 'recusado', { ...identity,
      ...(providerCalled ? {} : { model_sent: '-', model_route: model }),
      reason_code: error.code || xllm.classifyErrorClass(error.message), provider_called: providerCalled });
    let extra = execution ? { reset_state_file: executionStateFile,
      possible_writes: providerCalled ? 'unknown' : false,
      reconciliation_required: providerCalled !== false } : null;
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
    await recordFailure(error, extra);
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
  reviewFix.assertClaimTargetsPhysical(context.cwd, supplied);
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
  let terminal = false, transportRequested = false;
  const scopedRuntime = { ...runtime, announce: (stage, fields) => {
    if (stage === 'solicitado' || stage === 'iniciado') transportRequested = true;
    if (terminal) return;
    if (['recusado', 'falhou', 'reaproveitado'].includes(stage)) terminal = true;
    runtime.announce?.(stage, fields);
  } };
  try { return await runUnitSidecarCore(r, scopedRuntime, identity); }
  catch (error) {
    if (typeof error.provider_called !== 'boolean') error.provider_called = transportRequested ? 'unknown' : false;
    scopedRuntime.announce('recusado', { ...identity, model_sent: '-', reason_code: error.code || 'sidecar-unit-failed',
      provider_called: error.provider_called });
    throw error;
  }
}
async function recoverUnitSidecar(request, recovery, runtime = {}) {
  // Mandatory obligations fail closed before process/receipt inspection.
  const recoveryProcedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd, phase: 'recovery',
    forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
  // Current authority can enrich a legacy original request without changing its
  // historical caller hash. It still passes the normal held-claim/gate checks.
  const authority = runtime.executionAuthority || {};
  const executionRequest = { ...request, ...authority };
  if (Object.keys(authority).some(key => !['execution_contract', 'claim', 'runId', 'gates'].includes(key))) fail('recovery-execution-authority-invalid');
  const canonical = require('./forge-attempt-recovery').canonicalRequest(request);
  if (canonical.scope === 'standalone-task' && canonical.phase !== 'execute') {
    return require('./forge-task-preparation').recoverStandaloneTask(request, recovery, runtime);
  }
  const resolverOptions = { cwd: canonical.contextRoot, unitType: canonical.unitType, scope: canonical.scope, phase: canonical.phase,
    hostRuntime: canonical.route.host_runtime, milestoneId: canonical.milestoneId,
    unitId: canonical.taskId || canonical.sliceId || canonical.milestoneId,
    planPath: canonical.planFile, roadmapPath: canonical.roadmapFile };
  const nativeTaskName = `recovery_${request.dispatchId}_${crypto.randomUUID()}`;
  const nativeOptions = route => {
    // Binding preflight uses the real task plan; the transport composes the
    // complete execution/security/context prompt after prepare.
    const executionPlan = canonical.scope === 'standalone-task' && canonical.phase === 'execute'
      ? fs.readFileSync(canonical.planFile, 'utf8') : null;
    const rendered = !executionPlan && !request.prompt && !request.promptFile ? renderPrompt({
      unitType: canonical.scope === 'standalone-task' && canonical.phase === 'execute' ? 'execute-loose-task' : request.unitType,
      cwd: canonical.contextRoot, codeDir: canonical.cwd, milestoneId: request.milestoneId, sliceId: request.sliceId,
      taskId: request.taskId, unitEffort: route.effort, autoCommit: false }) : null;
    let prompt = executionPlan || request.prompt || (request.promptFile ? fs.readFileSync(request.promptFile, 'utf8') : rendered.prompt);
    const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: canonical.cwd,
      phase: canonical.scope === 'standalone-task' && canonical.phase === 'execute' ? 'execute-loose-task' : request.unitType,
      forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
    prompt = require('./forge-prompt').composeProcedurePrompt(prompt, procedure,
      rendered ? rendered.procedure_context : request.procedure_context);
    // The recovered worker receives recovery obligations too. Fresh loader
    // segments are instructions; shared dependencies already present stay once.
    const present = new Set(procedure.modules.map(module => module.id));
    const additional = recoveryProcedure.content.split(/(?=<!-- forge-procedure:)/)
      .filter(segment => segment.trim() && !present.has(/^<!-- forge-procedure:([^>]+) -->/.exec(segment)?.[1]));
    prompt += '\n\n' + additional.join('');
    return { hostRuntime: route.host_runtime, resolvedDispatch: route,
    activeCapabilities: runtime.activeCapabilities, effortBinding: runtime.effortBinding,
    prompt, forkTurns: 'none',
    taskName: nativeTaskName,
    agentType: ({ execute: 'forge-executor', plan: 'forge-planner', research: 'forge-researcher', discuss: 'forge-discusser' })[canonical.phase] || 'forge-worker' };
  };
  // A stale writer cannot reconcile or reserve another attempt under a new claim.
  if (canonical.scope === 'milestone' && canonical.phase === 'execute') {
    if (!executionRequest.execution_contract) fail('execution-held-claim-required');
    validateRecoveryRequest(executionRequest, { nativeInvocation: request.route.worker_mode === 'native'
      ? require('./forge-native-invocation').buildNativeInvocation(nativeOptions(request.route)) : undefined });
  }
  return require('./forge-attempt-recovery').recoverAttempt({ ...recovery, request,
    inspectSavedResult: runtime.savedNativeResult ? async () => (await inspectSavedNativeExecution(executionRequest, runtime)).writer : undefined,
    recoveryAuthorization: runtime.recoveryAuthorization, processProbe: runtime.processProbe,
    transitionAdapter: runtime.transitionAdapter,
    executionContract: executionRequest.execution_contract, executionAuthority: authority,
    externalNativeHandoff: !runtime.invokeNative,
    inspectPreSpawn: runtime.inspectPreSpawn, inspectPreSpawnDelta: runtime.inspectPreSpawnDelta,
    validateEnvironmentalCorrection: runtime.validateEnvironmentalCorrection,
    validateExecutionAuthority: () => validateRecoveryRequest(executionRequest, { nativeInvocation: request.route.worker_mode === 'native'
      ? require('./forge-native-invocation').buildNativeInvocation(nativeOptions(request.route)) : undefined }),
    reconcile: receipt => {
      if (canonical.scope === 'milestone' || receipt.recovery_baseline) return reconcileMilestoneAttempt(request, receipt, runtime);
      if (!receipt.reset_state_file || !receipt.execution?.execution_contract) fail('recovery-baseline-required');
      require('./forge-task-execution').assertReplay(request, receipt);
      return require('./forge-surgical-reset').reconcileFailedAttempt(receipt.reset_state_file,
        { failed: true, processStopped: true, verifyOwnership: runtime.verifyOwnership });
    },
    validateCorrection: async () => {
      if (request.route.worker_mode === 'native') {
        const invocation = require('./forge-native-invocation').buildNativeInvocation(nativeOptions(request.route));
        if (!invocation.ok) return invocation;
        validateRecoveryRequest(executionRequest, { nativeInvocation: invocation });
        return { ok: true, evidence_reference: 'unit-preflight:native-arguments',
          final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: invocation.args,
            context: invocation.args.prompt || invocation.args.message, identity: request, route: request.route,
            model: request.route.model, effort: request.route.effort, transport: 'native-tool' }) };
      }
      validateRecoveryRequest(executionRequest);
      if (typeof runtime.validateCorrection !== 'function') return { ok: false, reason_code: 'recovery-final-packaging-required' };
      return runtime.validateCorrection(request);
    },
    resolverOptions,
    resolveDispatch: runtime.resolveDispatch,
    validateInvocation: async route => {
      const invocation = route.worker_mode === 'native'
        ? require('./forge-native-invocation').buildNativeInvocation(nativeOptions(route)) : { ok: true };
      if (!invocation.ok) return invocation;
      try { validateRecoveryRequest({ ...executionRequest, route }, { nativeInvocation: invocation }); }
      catch (error) { return { ok: false, reason_code: error.code || 'unit-contract-refused', provider_called: false }; }
      return invocation;
    },
    replay: receipt => {
      if (receipt.phase === 'failed' && receipt.saved_candidate) {
        if (!recovery.reconciliation) fail('recovery-artifact-reconciliation-required');
        return reconcileArtifactAttempt(request, recovery.reconciliation);
      }
      return runUnitSidecar(request, runtime);
    },
    invoke: async (route, invocation, remainingMs, assertReady, reservationHash) => {
      validateRecoveryRequest({ ...executionRequest, route }, { nativeInvocation: invocation });
      const next = { ...executionRequest, recoveryStateFile: recovery.stateFile, route: route.worker_mode === 'sidecar'
        ? { ...route, workers_timeout: Math.max(0.001, remainingMs / 1000) } : route,
        dispatchId: `${request.dispatchId}-recovery-${crypto.randomUUID()}`, resultFile: `${request.resultFile}.recovery-${crypto.randomUUID()}.json` };
      if (route.worker_mode === 'native') {
        if (!runtime.invokeNative) {
          assertReady?.();
          if ((recovery.environmentalCorrection || recovery.transitions) && !recovery.resumeReservation) return {
            action: 'reattest-native-handoff', reservation_sha256: reservationHash, provider_called: false };
          return { action: 'invoke-native', request: next, invocation, ...(assertReady ? { assertReady } : {}) };
        }
        // Only standalone execution has the native execution lifecycle. Other
        // phase adapters retain their existing public native outcome contract.
        if (next.scope !== 'standalone-task' || next.phase !== 'execute') {
          return require('./forge-native-invocation').invokeNative(nativeOptions(route), (args, binding) => {
            assertReady?.();
            validateRecoveryRequest({ ...executionRequest, route }, { nativeInvocation: binding });
            return runtime.invokeNative(next, { ...binding, args });
          });
        }
        next.nativeInvocation = invocation;
        if (next.nativePromptFile) next.nativePromptFile = `${next.resultFile}.prompt.txt`;
        return runUnitSidecar(next, { ...runtime, assertRecoveryReady: assertReady, assertRecoveryAuthority: assertReady?.assertAuthority,
          invokeNative: (args, binding) => runtime.invokeNative(next, { ...binding, args }) });
      }
      return runUnitSidecar(next, { ...runtime, ...(assertReady?.appendOwnerEvent ? { assertRecoveryReady: assertReady } : {}) });
    },
  });
}
module.exports = { schema, memorySchema, MEMORY_QUALITY_CONTRACT, locations, milestonePlanFile, validateRecoveryRequest, captureMilestoneBaseline, reconcileMilestoneAttempt, validateArtifacts, inspectArtifacts, inspectDeliveryContent, executeDeliveryArtifacts, MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_PAYLOAD_BYTES, target, markChecked, materialize, memoryPrompt, memorySourceContext,
  publishReadyRecord, nativeMemoryFingerprint, acceptNativeMemoryResult, candidateFromNativeResult, runNativeMemory,
  routeIdentity, artifactFingerprint, artifactAttemptFiles, beginArtifactAttempt, replayArtifactAttempt,
  failArtifactAttempt, acceptArtifactResult, reconcileArtifactAttempt, runUnitSidecar, recoverUnitSidecar, reviewFixUnitLabel, effortTelemetry };
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
