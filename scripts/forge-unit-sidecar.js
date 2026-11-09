#!/usr/bin/env node
'use strict';

// Delivery only: consumes a resolved route and the controller-selected unit.
// It never selects a unit, acquires a lease, changes host, commits or falls back.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');
const xllm = require('./forge-xllm');
const { createStderrAnnouncer } = require('./forge-sidecar-identity');
const { evaluateDispatchGuard } = require('./forge-dispatch-guard');
const { ceilingFromRoute } = require('./forge-worker-timeout');
const { capability } = require('./forge-transport-capabilities');
const { renderPrompt } = require('./forge-prompt');
const { diagnostic } = require('./forge-sidecar-diagnostic');
const memory = require('./forge-memory');
const forgeIds = require('./forge-ids');
const { MAX_FILE_BYTES: MAX_DELIVERY_BYTES } = require('./forge-delivery');
// Only a ready object produced by this process's actual successor gate may
// publish. A serialized ready/capture is evidence, never a live capability.
const verificationSuccessorReady = new WeakMap();
function assertVerificationSuccessorPublication(request, record, options) {
  if (!record.verification_successor && record.verification_seal?.timeout_origin !== 'owner-verification-successor') return;
  const cap = options?.verificationSuccessor;
  if (!cap) fail('verification-successor-capability-required');
  const value = require('./forge-sidecar-verification-successor').read(cap, request);
  value.assertRecord(record);
  const proof = verificationSuccessorReady.get(record), digest = require('./forge-code-roots').digest;
  if (!proof || proof.cap !== cap || proof.record !== digest(record) || proof.request !== digest(request)) {
    fail('verification-successor-live-ready-required');
  }
}

const schema = xllm.loadSchemaFile('unit-artifacts.schema.json');
// v1 stays exported unchanged for its consumers; new extractions select v2.
const memorySchema = xllm.loadSchemaFile('memory-extraction.schema.json');
const memorySchemaV2 = xllm.loadSchemaFile('memory-extraction-v2.schema.json');
const MEMORY_SCHEMAS = Object.freeze({ 1: memorySchema, 2: memorySchemaV2 });
const NEW_MEMORY_SCHEMA_VERSION = 2;
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
  'Return schema_version 2. Use candidate-local IDs and one unique local_event_id per event. Never allocate MEM IDs or return paths, owner identity, timestamps, commands or publication metadata.',
  'Emit one seed per new fact, supersede with a replacement candidate, and cap-50 prune with reason "cap".',
  'Evidence events target existing MEM IDs and cite only an INPUT.evidence_refs entry whose observed_kind equals the event kind (utility also cites an INPUT.outcome_refs entry). Without such a reference emit no confirm or utility; there is no hit kind.',
  'Emit promote only when owner-provided state proves confidence >= 0.85, at least three independent confirmations, an eligible category, and durable non-fix text.',
  'Empty evidence returns done with empty facts/events. Partial, blocked or error returns no publishable facts/events.',
].join('\n');

function memoryExtractionSchema(version) {
  if (version !== 1 && version !== 2) fail('memory-schema-version-unsupported', 'Memory extraction schemas are versions 1 and 2.');
  return MEMORY_SCHEMAS[version];
}
// Transport response schema for a contract version. v2 requests v2 and keeps a
// v1 envelope decodable for workers that still emit it; the receipt binds the
// v2 evidence contract (and its promotion rule) whichever envelope arrives.
function memoryResponseSchema(version) {
  const selected = memoryExtractionSchema(version);
  if (version === 1) return selected;
  const strip = ({ $schema, $id, title, description, $defs, ...rest }) => rest;
  const legacy = value => JSON.parse(JSON.stringify(value)
    .replace(/"#\/\$defs\/([A-Za-z]+)"/g, (match, name) => `"#/$defs/v1_${name}"`));
  return {
    $schema: selected.$schema,
    $id: 'https://forge-agent.local/schemas/memory-extraction-response-v2.schema.json',
    title: 'Forge memory extraction response (v2 requested, v1 decodable)',
    type: 'object',
    anyOf: [strip(selected), legacy(strip(memorySchema))],
    $defs: { ...selected.$defs,
      ...Object.fromEntries(Object.entries(memorySchema.$defs).map(([key, value]) => [`v1_${key}`, legacy(value)])) },
  };
}
const memoryTransportSchema = memoryResponseSchema(NEW_MEMORY_SCHEMA_VERSION);
const MEMORY_RESPONSE_VERSIONS = Object.freeze([2, 1]);

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
// Milestone time rules delegate to their single canonical validators (T02/T03);
// both are lazy so unrelated units never load the time modules.
function inspectTimeContent(content, rule) {
  const options = rule.kind === 'milestone-options';
  try {
    return options ? require('./forge-milestone-options').inspectProposalContent(content, rule.milestone)
      : require('./forge-milestone-roadmap-time').validateRoadmapContent(content, rule.expected);
  } catch { return { valid: false, reason: options ? 'options-schema-invalid' : 'roadmap-time-content-invalid' }; }
}
function inspectDeliveryContent(content, rule) {
  if (rule.kind === 'standalone-preparation') {
    return require('./forge-task-preparation').validatePhaseContent(rule.phase, rule.taskId, content);
  }
  if (rule.kind === 'milestone-options' || rule.kind === 'milestone-roadmap-time') return inspectTimeContent(content, rule).valid === true;
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
// Called only after the existing validator rejects; never changes acceptance.
// Closed categories and field names keep provider content out of diagnostics.
function deliveryFailureReason(content, rule) {
  if (rule.kind === 'milestone-options' || rule.kind === 'milestone-roadmap-time') {
    // Only the validator's closed reason code is reported, without its module prefix; never content or paths.
    const code = String(inspectTimeContent(content, rule).reason || '').replace(rule.kind === 'milestone-options' ? /^options-/ : /^roadmap-time-/, '');
    return `typed-${rule.kind}-${/^[a-z][a-z0-9-]{0,63}$/.test(code) ? code : 'content'}`;
  }
  const category = ['input', 'delivery', 'standalone-preparation'].includes(rule.kind)
    ? rule.kind : 'verification';
  const reason = condition => `typed-${category}-${condition}`;
  if (category === 'standalone-preparation') {
    const inspected = require('./forge-task-preparation').inspectPhaseContent(rule.phase, rule.taskId, content);
    return reason(inspected.reason || 'content');
  }
  let value;
  try { value = JSON.parse(content); } catch { return reason('json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reason('object');
  if (!(category === 'input' ? [1, 2] : [1]).includes(value.schema_version)) return reason('schema');
  if (!sameUnit(value.unit, rule.unit)) return reason('unit');
  if (category === 'delivery' && value.generated_by !== 'forge-delivery') return reason('generated-by');
  if (category === 'verification' && value.kind !== rule.kind) return reason('kind');
  const strings = category === 'input' ? ['plan', 'plan_fingerprint']
    : category === 'delivery' ? ['delivery_fingerprint']
      : ['plan_fingerprint', 'code_dir', 'revision', 'environment', 'captured_at'];
  for (const field of strings) if (typeof value[field] !== 'string') return reason(field.replaceAll('_', '-'));
  const arrays = category === 'input' ? ['bindings', 'expected_children']
    : category === 'delivery' ? ['criteria', 'facts'] : [];
  for (const field of arrays) if (!Array.isArray(value[field])) return reason(field.replaceAll('_', '-'));
  if (category === 'verification') return reason('result');
  return 'delivery-artifact-invalid';
}
const MILESTONE_ID_RE = /^(?:M\d+|M-\d{14}-[a-z0-9-]+)$/i;
// Review-fix has three boundaries and publishes only outcome lines into the
// REVIEW.md files the parent derives here; the worker never selects a path.
function reviewFixLocations(request) {
  const m = request.milestoneId, s = request.sliceId, t = request.taskId;
  const boundary = request.reviewFix && typeof request.reviewFix === 'object' ? request.reviewFix.boundary : undefined;
  const invalid = () => fail('review-fix-boundary-invalid',
    'review-fix requires boundary slice (milestone + slice), task (standalone task id) or milestone-triage (milestone + per-item review_file).');
  if(request.scope==='standalone-task'&&boundary!=='task'||request.scope==='milestone'&&boundary==='task')invalid();
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
    'estimate-milestone': [`${milestone}/${m}-OPTIONS.json`],
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
  const timeRule = unit === 'estimate-milestone' ? { kind: 'milestone-options', milestone: m }
    : unit === 'plan-milestone' ? roadmapTimeRule(request) : null;
  if (timeRule) rules[baseRequired[0]] = timeRule;
  return { required, allowed: [...required, ...deliveryOptional, ...optional], rules, delivery, milestone, slice };
}
// The physical owner (contextRoot, else cwd) decides, never a separate CODE_DIR.
// roadmapRule returns null only for an unenrolled/legacy milestone or an attested
// no-contract choice; pending, invalid and unreadable owners yield a refusing rule.
function roadmapTimeRule(request) {
  let owner = request.contextRoot || request.cwd;
  try { owner = fs.realpathSync.native(owner); } catch { /* roadmapRule fails closed on an invalid owner */ }
  return require('./forge-milestone-time-selection').roadmapRule(owner, request.milestoneId);
}
function milestonePlanFile(request) {
  locations(request);
  return require('./forge-task-execution').milestonePlanFile(request);
}

// Pure readiness check over the wire representation, after caller assembly.
// Without an identity this is diagnostic policy, never a reusable dispatch seal.
function preflightExecutionVerification(raw, options = {}) {
  const request = JSON.parse(JSON.stringify(raw));
  if (!request.execution_contract || request.unitType !== 'execute-task') return null;
  const root = request.contextRoot || request.cwd;
  let planFile;
  if (request.scope === 'standalone-task') {
    const loc = require('./forge-task-execution').locations(request);
    planFile = path.join(root, loc.task, `${request.taskId}-PLAN.md`);
    // Preserve owner aliases supported by prepare(); its physical path/gate
    // checks still run independently before execution authority is granted.
    if (!request.planFile || require('./forge-code-roots').key(fs.realpathSync.native(request.planFile))
        !== require('./forge-code-roots').key(fs.realpathSync.native(planFile))) fail('execution-plan-path-mismatch');
  } else planFile = milestonePlanFile(request);
  const runtimeVerification = options.verification === undefined ? undefined : JSON.parse(JSON.stringify(options.verification));
  // Issue 343 U3b: a cohort member's seal also binds the runtime view minted by its live handle.
  return require('./forge-verify').normalizeExecutionVerification(request.execution_contract,
    fs.readFileSync(planFile, 'utf8'), request.verification, runtimeVerification, options.identity || {},
    options.memberView !== undefined ? { memberView: options.memberView } : undefined);
}
// Issue 343 U3b: the milestone execute preflight of a sidecar cohort member. The live member
// operations (forge-execution-batch memberSidecar, never imported data) hold the runtime view its
// handle validated: the canonical plan and gate bytes against the integration origin, mapped to
// this member's own roots, under the held aggregate claim and the member's begin and lease. The
// request must be exactly the bound attempt; the gates and the execution capability are the same
// as on the single path.
function validateMemberRequest(request, transport, options) {
  const roots = require('./forge-code-roots'), member = options.member;
  if (!require('./forge-execution-batch').isMemberSidecar(member) || !member.matches(request)) fail('execution-member-handle-required');
  const view = member.view();
  const contract = roots.validateContract(request.execution_contract, { owner: request.contextRoot, revalidate: true });
  const planFile = milestonePlanFile(request);
  const plan = fs.readFileSync(planFile, 'utf8');
  if (roots.digest(contract) !== roots.digest(member.contract()) || view.runtime_contract_sha256 !== roots.digest(contract)
      || view.canonical_plan_sha256 !== hash(plan)) fail('execution-member-view-stale');
  const gateFile = planFile.replace(/-PLAN\.md$/, '-PLAN-GATE.md');
  const gate = fs.existsSync(gateFile) ? fs.readFileSync(gateFile, 'utf8') : '';
  if (!/^status:\s*approved\s*$/m.test(gate)) fail('execution-plan-gate-required');
  if (gate.match(/^plan_sha256:\s*([a-f0-9]{64})\s*$/m)?.[1] !== hash(plan)) fail('execution-plan-gate-stale');
  if (request.gates?.claim !== 'proceed' || !['passed', 'not-applicable'].includes(request.gates?.security)) fail('execution-gates-required');
  if (request.gates.security === 'passed'
      && (!request.securityFile || !fs.readFileSync(request.securityFile, 'utf8').trim())) fail('execution-security-required');
  const effective = require('./forge-transport-capabilities').executionCapability(request.route, contract, options);
  if (!effective.supported) fail(effective.reason_code);
  return { ...transport, contract, planFile };
}
function validateRecoveryRequest(raw, options = {}) {
  const attempt = require('./forge-attempt-recovery');
  const request = attempt.canonicalRequest(raw.linked_begin_key && !raw.linkedEntryBinding ? attempt.bindLinkedRequest(raw, options.linkedEntryOptions) : raw);
  if (request.linked_begin_key) attempt.requestIdentity(request);
  const loc = locations(request);
  const transport = capability(request.route?.resolved_worker_engine, request.unitType,
    request.scope === 'milestone' ? {} : request);
  if (!transport.supported) fail(transport.reason_code, transport.hint);
  // Existing attempts retain their receipt/seal/replay checks. Readiness must
  // not reinterpret a legacy saved result or grant it new authority.
  if (transport.mode === 'execute' && !fs.existsSync(`${request.resultFile}.receipt.json`)) {
    preflightExecutionVerification(request, options);
  }
  if (request.claudePermissions !== undefined && (request.claudePermissions !== 'verification'
      || request.route?.resolved_worker_engine !== 'claude' || !['execute', 'fix'].includes(transport.mode)
      || !request.execution_contract)) fail('claude-permission-policy-invalid');
  if (loc.preparation) require('./forge-task-preparation').validateRequest(request);
  if (transport.mode === 'fix' && request.execution_contract) {
    const roots = require('./forge-code-roots');
    const contract = roots.validateContract(request.execution_contract, { owner: request.contextRoot, revalidate: true });
    const claim = request.claim;
    const held = request.runId && require('./forge-runs').get(request.contextRoot, request.runId);
    if (!claim || claim.schema_version !== 2 || claim.released || !claim.generation
        || !held?.active || held.write_claim?.released || roots.digest(held.write_claim) !== roots.digest(claim)) fail('execution-held-claim-required');
    roots.claimGroups(claim);
    const fix = require('./forge-review-fix');
    const derived = fix.deriveClaim(fix.normalizeItems(request.reviewFix?.items));
    if (!derived.eligible || request.reviewFix?.decision !== 'proceed'
        || roots.digest(contract) !== roots.digest(claim.execution_contract)
        || contract.code_roots.length !== 1 || roots.key(contract.code_roots[0].path) !== roots.key(fs.realpathSync.native(request.cwd))
        || JSON.stringify([...derived.paths].sort()) !== JSON.stringify([...new Set(request.reviewFix.claimPaths || [])].sort())
        || roots.digest(claim.paths.map(p => roots.resolvePath(contract, p)).map(p => `${p.root_id}::${p.path}`).sort())
          !== roots.digest(derived.paths.map(file => `${contract.primary_root_id}::${file}`).sort())) fail('execution-held-claim-mismatch');
    fix.assertClaimTargetsPhysical(request.cwd, derived.paths);
    if (request.gates?.claim !== 'proceed' || !['passed', 'not-applicable'].includes(request.gates?.security)) fail('execution-gates-required');
    if (request.gates.security === 'passed' && (!request.securityFile || !fs.readFileSync(request.securityFile, 'utf8').trim())) fail('execution-security-required');
  }
  if (transport.mode === 'execute') {
    if (loc.execution) {
      const prepared = require('./forge-task-execution').prepare({ ...request, nativeInvocation: options.nativeInvocation }, request.contextRoot, request.cwd);
      return { ...transport, contract: prepared.execution_contract, planFile: request.planFile };
    } else {
      const roots = require('./forge-code-roots');
      // Issue 343 U3b: a cohort member consumes its live validated runtime view; a request naming
      // a batch, an aggregate claim or a run under a batch never takes the single path without it.
      if (options.member !== undefined) return validateMemberRequest(request, transport, options);
      if (request.batch_id !== undefined || request.claim?.batch_roots) fail('execution-member-handle-required');
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
        if (held.batch_locator) fail('execution-member-handle-required');
        roots.claimGroups(claim);
        if (roots.digest(claim.execution_contract) !== roots.digest(contract)
            || checked.writes.some(p => !claim.paths.some(c => roots.covers(c, p)))) fail('execution-held-claim-mismatch');
        const gateFile = planFile.replace(/-PLAN\.md$/, '-PLAN-GATE.md');
        const gate = fs.existsSync(gateFile) ? fs.readFileSync(gateFile, 'utf8') : '';
        if (!/^status:\s*approved\s*$/m.test(gate)
            && !(request.gates?.plan === 'skipped' && request.gates?.planSkipReason === 'interactive-off')
            && !require('./forge-task-execution').autoGateAllowed(request)) fail('execution-plan-gate-required');
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
// Issue 328: claudePermissions is a Claude-only transport option. A fresh
// recovery destination copy for a non-Claude engine omits it only when the
// original already satisfies the rule above (pure re-evaluation, no authority).
// Every other value, origin or destination is returned unchanged and is still
// decided by validateRecoveryRequest/runUnitSidecarCore. Inputs never mutate.
function projectTransportOptions(value, original) {
  if (value?.claudePermissions !== 'verification') return value;
  const engine = value.route?.resolved_worker_engine;
  if (typeof engine !== 'string' || !engine || engine === 'claude') return value;
  const source = require('./forge-attempt-recovery').canonicalRequest(original);
  const mode = capability(source.route?.resolved_worker_engine, source.unitType,
    source.scope === 'milestone' ? {} : source).mode;
  if (source.claudePermissions !== 'verification' || source.route?.resolved_worker_engine !== 'claude'
      || !['execute', 'fix'].includes(mode) || !source.execution_contract) return value;
  const { claudePermissions: transportOnly, ...projected } = value;
  return projected;
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
  // Issue 343 U3b: a cohort member's owner is protected by the cohort's common signed stream (the
  // broker's S0 and every sibling's signed append), never by a private snapshot of a shared owner.
  return { schema_version: 1, state_file: stateFile, state_sha256: baselineDigest(state),
    execution_contract: contract, fingerprint: receipt.fingerprint, dispatch_id: receipt.dispatch_id, input,
    protected_owner: options.member !== undefined ? null : execution.protectedSnapshot(contract.owner),
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
// Legacy review-fix already performed its reset when it failed. Observe the
// original boundary again; never reset twice or manufacture a v2 baseline now.
function reconcileLegacyReviewFix(request, receipt, executionContract) {
  const roots = require('./forge-code-roots'), reset = require('./forge-surgical-reset');
  const contract = roots.validateContract(executionContract, { owner: request.contextRoot || request.cwd, revalidate: true });
  if (request.unitType !== 'review-fix' || receipt.kind !== 'review-fix' || receipt.phase !== 'failed'
      || receipt.recovery_baseline
      || receipt.dispatch_id !== request.dispatchId || receipt.fingerprint !== artifactFingerprint(request)
      || receipt.recovery_identity_sha256 !== recoveryIdentity(request)) fail('review-fix-recovery-binding');
  if (request.execution_contract && roots.digest(roots.validateContract(request.execution_contract, { revalidate: true })) !== roots.digest(contract))
    fail('review-fix-recovery-roots');
  const failure = receipt.failure;
  if (failure?.recovery !== 'items-deferred' || failure.reset?.verified !== true
      || failure.reset.reason_code !== 'reset-verified' || !Array.isArray(failure.reset.overlap) || failure.reset.overlap.length
      || failure.publication_error || /^claude-model-|protected-metadata|baseline-moved/.test(failure.reason_code || '')) fail('review-fix-recovery-reset-unverified');
  const files = artifactAttemptFiles(request), stateFile = `${files.resultFile}.reset-state.json`;
  require('./forge-attempt-recovery').validateStateTarget(stateFile, request, contract);
  if (receipt.reset_state_file !== stateFile) fail('review-fix-recovery-binding');
  const state = reset.readState(stateFile);
  // A historical single-cwd identity cannot authorize additional writer roots.
  if (contract.code_roots.length !== 1 || request.writableRoots?.length || Object.hasOwn(state, 'repos')
      || state.execution_contract || state.attempt !== request.dispatchId) fail('review-fix-recovery-roots');
  const root = contract.code_roots[0];
  if (roots.key(path.resolve(request.cwd)) !== roots.key(root.path)
      || roots.key(path.resolve(state.code_dir)) !== roots.key(root.path)
      || state.vcs !== root.vcs || root.vcs !== 'git') fail('review-fix-recovery-roots');
  const fix = require('./forge-review-fix'), loc = locations(request);
  const brief = fix.buildBrief({ boundary: loc.reviewFix.boundary, unitLabel: loc.reviewFix.unitLabel,
    items: fix.normalizeItems(request.reviewFix.items), claimPaths: request.reviewFix.claimPaths, route: request.route });
  if (brief.identity !== receipt.review_fix_identity
      || roots.digest(routeIdentity(request.route, request.unitType)) !== roots.digest(receipt.route_identity)) fail('review-fix-recovery-binding');
  const normalize = rows => {
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.path !== 'string'
        || !(row.hash === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.hash)))) fail('review-fix-recovery-snapshot-invalid');
    if (new Set(rows.map(row => row.path)).size !== rows.length) fail('review-fix-recovery-snapshot-invalid');
    return rows.map(row => ({ path: row.path, hash: row.hash })).sort((a, b) => a.path.localeCompare(b.path));
  };
  const observed = reset.captureAttemptSnapshot(root.path);
  if (observed.start_sha !== state.start_sha
      || roots.digest(normalize(observed.pre_dirty)) !== roots.digest(normalize(state.pre_dirty))) fail('review-fix-recovery-baseline-changed');
  return { ok: true, roots: [{ root_id: root.id, reconciled: true }], pending_roots: [] };
}
// Issue 343 U5: executable modes are member execution evidence, captured with the verified
// bytes before the immutable executed anchor. Windows has no executable-mode authority: null.
// Ordinary single-unit receipts keep their historical shape and behavior.
function captureMemberModes(request, verifiedFiles) {
  const roots = require('./forge-code-roots');
  if (!verifiedFiles || typeof verifiedFiles !== 'object' || Array.isArray(verifiedFiles)) fail('batch-member-mode-invalid');
  roots.validateContract(request.execution_contract, { revalidate: true });
  const entries = [];
  for (const qualified of Object.keys(verifiedFiles).sort()) {
    const expected = verifiedFiles[qualified], resolved = roots.resolvePath(request.execution_contract, qualified);
    let before;
    try { before = fs.lstatSync(resolved.absolute); }
    catch (error) { if (error && error.code === 'ENOENT') before = null; else throw error; }
    if (expected === null) {
      if (before) fail('batch-member-mode-changed');
      entries.push([qualified, null]);
      continue;
    }
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || !before || !before.isFile() || before.isSymbolicLink()) fail('batch-member-mode-invalid');
    const bytes = fs.readFileSync(resolved.absolute), after = fs.lstatSync(resolved.absolute);
    if (!after.isFile() || after.isSymbolicLink() || ['dev', 'ino', 'size', 'mtimeMs', 'mode'].some(key => before[key] !== after[key])
        || hash(bytes) !== expected) fail('batch-member-mode-changed');
    entries.push([qualified, process.platform === 'win32' ? null : (Number(after.mode) & 0o100) !== 0]);
  }
  return Object.fromEntries(entries);
}
function assertMemberModes(request, record) {
  const saved = record.milestone_delivery, files = saved && saved.verified_files, modes = saved && saved.verified_modes;
  if (!files || typeof files !== 'object' || Array.isArray(files) || !modes || typeof modes !== 'object' || Array.isArray(modes)
      || Object.keys(files).sort().join('\n') !== Object.keys(modes).sort().join('\n')) fail('batch-member-mode-required');
  for (const qualified of Object.keys(files)) {
    const mode = modes[qualified];
    if (files[qualified] === null || process.platform === 'win32') {
      if (mode !== null) fail('batch-member-mode-invalid');
    } else if (typeof mode !== 'boolean') fail('batch-member-mode-invalid');
  }
  if (canonicalDigest(captureMemberModes(request, files)) !== canonicalDigest(modes)) fail('batch-member-mode-changed');
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
    if (rules[artifact.path] && !inspectDeliveryContent(artifact.content, rules[artifact.path])) {
      return bad(options.detailedDeliveryDiagnostic
        ? deliveryFailureReason(artifact.content, rules[artifact.path]) : 'delivery-artifact-invalid');
    }
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
// options.memberView (issue 343 U3b): a cohort member's delivery consumes its minted runtime view.
function executeDeliveryArtifacts(request, loc, result, root, cwd, captured, options = {}) {
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
  const output = delivery.buildDelivery(input, { ownerRoot: root, codeDir: cwd, sourceEnvelopes: sources,
    ...(options && options.memberView !== undefined ? { memberView: options.memberView } : {}) });
  const deliveryReference = `./${path.posix.basename(loc.delivery.output)}`;
  // Canonical SUMMARY/replay bytes keep the historical table-only rendering.
  const deliverySection = delivery.renderDeliveryMarkdown(output, { detailReference: deliveryReference, summary: false });
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
// Owner-generated slice-plan checkbox for milestone execute-task. The path comes
// only from IDs validated by locations(); workers never supply it, so allowed
// stays without the S##-PLAN. The started receipt preimage is the CAS baseline.
function taskMarkerPath(request) {
  if (request.unitType !== 'execute-task' || request.scope === 'standalone-task') fail('task-marker-scope-invalid');
  const loc = locations(request);
  if (loc.execution || !loc.slice) fail('task-marker-scope-invalid');
  return `${loc.slice}/${request.sliceId}-PLAN.md`;
}
// Issue 343 U5: `chain` (a cohort member only) lists, in manifest order, the sibling markers the
// cohort's own committed member-artifacts operations already published on this slice plan
// ({ before, after } from the broker's signed journal). They are the only admissible changes since
// the member's recorded preimage; the marker is then rebased on the last one. Any other edit stays
// the operator's and refuses exactly as before.
function createTaskMarker(request, root, preimageSha256, chain) {
  const relative = taskMarkerPath(request);
  if (typeof preimageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(preimageSha256)) fail('task-marker-preimage-required');
  let expected = preimageSha256;
  for (const link of chain || []) {
    if (!link || link.before !== expected || typeof link.after !== 'string' || !/^[a-f0-9]{64}$/.test(link.after)) fail('task-marker-chain-invalid');
    expected = link.after;
  }
  const file = target(root, relative);
  const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
  // Never recapture: an edit since the recorded preimage stays the operator's.
  if (!bytes || hash(bytes) !== expected) fail('task-marker-preimage-changed', 'O plano da slice mudou desde a preimagem registrada; a marcação não foi aplicada.');
  const preimage = bytes.toString('utf8');
  if (!Buffer.from(preimage, 'utf8').equals(bytes)) fail('task-marker-preimage-invalid');
  const content = markChecked(preimage, request.taskId);
  return content === preimage ? null : { path: relative, content, before: expected };
}
function verifyTaskMarker(request, artifact, preimageSha256) {
  const invalid = () => fail('task-marker-invalid', 'O marcador não corresponde ao artefato canônico desta task.');
  let relative;
  try { relative = taskMarkerPath(request); } catch { invalid(); }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || Object.keys(artifact).some(key => !['path', 'content', 'before'].includes(key))
      || artifact.path !== relative || typeof artifact.content !== 'string'
      || typeof preimageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(preimageSha256) || artifact.before !== preimageSha256) invalid();
  // Candidate preimages: the content itself (no-op) or one checked line of this
  // task undone. Only markChecked of a preimage with the recorded hash is canonical.
  const escaped = request.taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const checked = new RegExp(`^(\\s*[-*] \\[)x(?=[\\]]\\s+(?:\\*\\*)?${escaped}(?=[:\\s*]))`, 'gm');
  const candidates = [artifact.content];
  for (const match of artifact.content.matchAll(checked)) {
    const at = match.index + match[1].length;
    candidates.push(`${artifact.content.slice(0, at)} ${artifact.content.slice(at + 1)}`);
  }
  if (!candidates.some(preimage => hash(preimage) === preimageSha256 && markChecked(preimage, request.taskId) === artifact.content)) invalid();
  return true;
}
// ── Strict new-plan generation (issue 343 U0c) ────────────────────────────────
// A new milestone plan-slice attempt records the owner's plan_generation requirement
// (the marker) in its started receipt: the current requirement bound to this attempt
// (request fingerprint, dispatch, workflow), its trusted scope (physical owner key,
// milestone, slice) and, when the in-process owner supplies one, the committed
// controller begin enrollment. The returned candidate is admitted again here,
// independently of the transport, and its exact bytes become the receipt's
// plan_validation evidence before the ready record exists. Publication rechecks
// marker, evidence and candidate bytes under the owner lock before any artifact byte;
// replay uses only the saved content. Neither record is ever taken from a worker. A
// ready receipt with neither is pre-requirement only when the controller's canonical
// classification shows no enrolled lineage for the slice (U0d; see
// assertPlanGenerationPublication for the explicit limit): it then replays with its
// historical semantics and is never rewritten. A standalone brainstorm also carries
// unitType plan-slice, but it is an artifacts contract and stays outside this block.
// U0d: the marker's begin is the slice's open enrolled controller lineage whenever one
// exists, and the execute recheck shares the native first execute's classification.
const PLAN_GENERATION_KIND = 'sidecar-plan-generation';
const PLAN_VALIDATION_KIND = 'sidecar-plan-validation';
const PLAN_OWNER_FIELDS = Object.freeze(['plan_generation', 'plan_validation']);
const PLAN_MARKER_KEYS = Object.freeze(['schema_version', 'kind', 'requirement', 'requirement_sha256', 'fingerprint',
  'dispatch_id', 'workflow_id', 'owner', 'milestone', 'slice', 'begin', 'marker_sha256']);
const PLAN_BEGIN_KEYS = Object.freeze(['generation_key', 'begin_key', 'lease_generation']);
const PLAN_EVIDENCE_KEYS = Object.freeze(['schema_version', 'kind', 'requirement', 'requirement_sha256', 'marker_sha256',
  'fingerprint', 'dispatch_id', 'workflow_id', 'owner', 'milestone', 'slice', 'source', 'task_ids', 'graph_sha256',
  'semantic_sha256', 'validation_sha256']);
// Read-only pre-spawn refusals of a milestone execute-task (provider_called false).
const PLAN_GENERATION_STAGE = 'plan-generation-admission';
function planApi() { return require('./forge-plan-validation'); }
function milestonePlanSlice(request) { return request.unitType === 'plan-slice' && request.scope !== 'standalone-task'; }
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
}
function canonicalDigest(value) { return hash(JSON.stringify(canonicalJson(value))); }
function exactFields(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}
// Closed validation diagnostic; the named code and detail never carry provider prose.
function planRefusal(code, detail, extra = {}) {
  throw Object.assign(new Error(`${code}: ${detail}`), { code, detail, diagnostic: { reason: 'validator-failed' } }, extra);
}
function planGenerationRefusal(error) { return error?.stage === PLAN_GENERATION_STAGE && error.provider_called === false; }
function planOwner(root) { return fs.realpathSync.native(root); }
function planScope(request, root) { return { owner: planOwner(root), milestone: request.milestoneId, slice: request.sliceId }; }
// Issue 343 U0d: the slice's canonical controller classification (forge-plan-validation
// classifySliceGeneration, shared with the native first execute). Outside the enrollment
// segment grammar no enrolled begin can exist, so such a scope is unenrolled.
function planSliceClassification(request, root) {
  const api = planApi(), owner = planOwner(root);
  if (!api.isScopeSegment(request.milestoneId) || !api.isScopeSegment(request.sliceId)) return { status: 'unenrolled' };
  return api.classifySliceGeneration(owner, { owner, milestone: request.milestoneId, slice: request.sliceId });
}
// The committed controller begin this plan-slice attempt belongs to: the slice's OPEN
// enrolled lineage (issue 343 U0d), reused whenever it exists, whether or not the
// in-process owner also supplies its plan_generation; a supplied enrollment must be
// exactly what that open begin carries. Without an enrolled lineage the attempt is an
// unlinked producer and its marker says begin:null; that null proves no origin by itself.
function planGenerationBegin(request, runtime, root) {
  const api = planApi(), owner = planOwner(root), invalid = detail => planRefusal('plan-generation-begin-invalid', detail);
  const supplied = runtime.planGeneration !== undefined;
  let classified, enrolled, begin;
  try { classified = planSliceClassification(request, root); }
  catch (error) { invalid(`the slice enrollment is not classifiable (${error?.code || 'error'})`); }
  if (supplied) {
    try { enrolled = api.verifyPlanGeneration(runtime.planGeneration, { owner, milestone: request.milestoneId, slice: request.sliceId }); }
    catch (error) { invalid(`the enrollment does not verify (${error?.code || 'error'})`); }
  } else if (classified.status !== 'open') return null;
  const beginKey = supplied ? enrolled.begin_key : classified.begin_key;
  try { begin = require('./forge-unit-controller').lookupRecord(owner, 'transaction', beginKey); }
  catch (error) { invalid(`the begin transaction is unreadable (${error?.code || 'error'})`); }
  const carried = begin && begin[api.TRANSACTION_FIELDS.generation];
  if (!supplied && carried) {
    try { enrolled = api.verifyPlanGeneration(carried, { owner, milestone: request.milestoneId, slice: request.sliceId }); }
    catch (error) { invalid(`the open enrollment does not verify (${error?.code || 'error'})`); }
  }
  if (!begin || !enrolled || begin.phase !== 'committed' || begin.action !== 'begin' || begin.milestone !== request.milestoneId
      || begin.unit?.key !== `plan-slice/${request.sliceId}` || begin.idempotency_key !== enrolled.begin_key
      || begin.lease_generation !== enrolled.lease_generation || begin.owner_digest !== enrolled.owner_digest
      || !carried || canonicalDigest(carried) !== canonicalDigest(enrolled)) {
    invalid('the enrollment is not the committed plan-slice begin of this slice');
  }
  if (classified.status !== 'open' || classified.begin_key !== enrolled.begin_key) {
    invalid('the enrollment is not the open plan-slice lineage of this slice');
  }
  return { generation_key: enrolled.generation_key, begin_key: enrolled.begin_key, lease_generation: enrolled.lease_generation };
}
// A non-null marker begin must still name the committed enrolled begin of this slice.
function verifyMarkerBegin(marker, request, root) {
  const api = planApi(), owner = planOwner(root), invalid = detail => planRefusal('plan-generation-marker-invalid', detail);
  let begin;
  try { begin = require('./forge-unit-controller').lookupRecord(owner, 'transaction', marker.begin.begin_key); }
  catch (error) { invalid(`the bound begin is unreadable (${error?.code || 'error'})`); }
  const carried = begin && begin[api.TRANSACTION_FIELDS.generation];
  if (!begin || begin.phase !== 'committed' || begin.action !== 'begin' || begin.milestone !== request.milestoneId
      || begin.unit?.key !== `plan-slice/${request.sliceId}` || begin.lease_generation !== marker.begin.lease_generation
      || !carried || carried.generation_key !== marker.begin.generation_key || carried.begin_key !== marker.begin.begin_key) {
    invalid('the marker names no committed enrolled begin of this slice');
  }
}
function buildPlanGenerationMarker(request, { fingerprint, dispatchId, root, begin }) {
  const api = planApi();
  const marker = { schema_version: 1, kind: PLAN_GENERATION_KIND, requirement: api.REQUIREMENT,
    requirement_sha256: api.REQUIREMENT_SHA256, fingerprint, dispatch_id: dispatchId, workflow_id: request.workflowId,
    owner: require('./forge-code-roots').key(planOwner(root)), milestone: request.milestoneId, slice: request.sliceId, begin };
  marker.marker_sha256 = canonicalDigest(marker);
  return marker;
}
// The marker of this exact attempt: its fields, current requirement and own digest,
// the request fingerprint and dispatch the record also names, workflow and scope.
function verifyPlanGenerationMarker(marker, request, record, root) {
  const api = planApi(), invalid = detail => planRefusal('plan-generation-marker-invalid', detail);
  if (!exactFields(marker, PLAN_MARKER_KEYS)) invalid('the marker fields are not the closed set');
  const { marker_sha256: digest, ...body } = marker;
  if (marker.schema_version !== 1 || marker.kind !== PLAN_GENERATION_KIND) invalid('unknown marker schema');
  if (marker.requirement !== api.REQUIREMENT || marker.requirement_sha256 !== api.REQUIREMENT_SHA256) invalid('not the current requirement');
  if (digest !== canonicalDigest(body)) invalid('marker_sha256 does not bind the marker');
  if (marker.begin !== null && (!exactFields(marker.begin, PLAN_BEGIN_KEYS)
      || PLAN_BEGIN_KEYS.some(key => typeof marker.begin[key] !== 'string' || !marker.begin[key]))) invalid('begin is not a committed enrollment');
  if (marker.fingerprint !== artifactFingerprint(request) || marker.fingerprint !== record.fingerprint) invalid('another request');
  if (marker.dispatch_id !== request.dispatchId || marker.dispatch_id !== record.dispatch_id) invalid('another dispatch');
  if (marker.workflow_id !== request.workflowId) invalid('another workflow');
  if (marker.owner !== require('./forge-code-roots').key(planOwner(root)) || marker.milestone !== request.milestoneId
      || marker.slice !== request.sliceId) invalid('another owner or slice');
  return marker;
}
function buildPlanValidationEvidence(marker, admission) {
  const api = planApi();
  const evidence = { schema_version: 1, kind: PLAN_VALIDATION_KIND, requirement: api.REQUIREMENT,
    requirement_sha256: api.REQUIREMENT_SHA256, marker_sha256: marker.marker_sha256, fingerprint: marker.fingerprint,
    dispatch_id: marker.dispatch_id, workflow_id: marker.workflow_id, owner: marker.owner, milestone: marker.milestone,
    slice: marker.slice, source: JSON.parse(JSON.stringify(admission.source)), task_ids: [...admission.task_ids],
    graph_sha256: admission.graph_sha256, semantic_sha256: admission.semantic_sha256 };
  evidence.validation_sha256 = canonicalDigest(evidence);
  return evidence;
}
function verifyPlanValidationEvidence(evidence, marker) {
  const invalid = detail => planRefusal('plan-validation-invalid', detail);
  if (!exactFields(evidence, PLAN_EVIDENCE_KEYS)) invalid('the evidence fields are not the closed set');
  const { validation_sha256: digest, ...body } = evidence;
  if (evidence.schema_version !== 1 || evidence.kind !== PLAN_VALIDATION_KIND) invalid('unknown evidence schema');
  if (digest !== canonicalDigest(body)) invalid('validation_sha256 does not bind the evidence');
  for (const key of ['requirement', 'requirement_sha256', 'marker_sha256', 'fingerprint', 'dispatch_id', 'workflow_id', 'owner', 'milestone', 'slice']) {
    if (evidence[key] !== marker[key]) invalid(`${key} does not follow the marker`);
  }
  const source = evidence.source;
  if (!exactFields(source, ['slice_plan', 'task_plans']) || !source.slice_plan || !Array.isArray(source.task_plans)
      || !Array.isArray(evidence.task_ids) || source.task_plans.length !== evidence.task_ids.length) invalid('source does not follow task_ids');
  return evidence;
}
// The shared strict admission of returned bytes under the trusted scope.
function admitReturnedPlan(request, root, slicePlan, taskPlans, extra = {}) {
  try {
    return planApi().validateNewSlicePlan({ slice_plan: { content: slicePlan },
      task_plans: taskPlans.map(plan => ({ id: plan.id, content: plan.content })) }, planScope(request, root));
  } catch (error) {
    if (error && typeof error === 'object') Object.assign(error, { diagnostic: { reason: 'validator-failed' }, stage: 'plan-admission' }, extra);
    throw error;
  }
}
// Publication check of a ready record, under the owner lock and before any artifact
// byte. null: not a plan-slice generation record, or one with no independent new origin.
//
// Issue 343 U0d — provenance of a ready record WITHOUT either owner record. Its own shape,
// a begin:null, its timestamps or an imported flag prove neither age nor newness; only the
// controller's canonical classification of the slice is independent. With an enrolled
// lineage (open, ended or completed) the slice's plans belong to the new requirement, so
// the record is a known-new receipt with both owner records stripped (or a stale one
// replayed over an enrolled slice) and refuses. EXPLICIT LIMIT: when the slice has no
// enrolled lineage (a genuine pre-requirement slice, or an unlinked producer that ran
// without any controller begin), nothing canonical distinguishes a historical receipt
// from a stripped new one; it replays with its historical semantics, unrewritten. This
// seam does not promise universal detection and never revalidates or backfills history.
function assertPlanGenerationPublication(request, record, root) {
  const present = PLAN_OWNER_FIELDS.filter(key => Object.hasOwn(record, key));
  if (!milestonePlanSlice(request)) {
    if (present.length) planRefusal('plan-generation-marker-invalid', 'only a milestone plan-slice record carries plan generation records');
    return null;
  }
  if (!present.length) {
    let anchor;
    try { anchor = planSliceClassification(request, root).status; }
    catch (error) {
      planRefusal(typeof error?.code === 'string' ? error.code : 'plan-generation-evidence-invalid',
        typeof error?.detail === 'string' ? error.detail : 'the slice enrollment is not classifiable');
    }
    if (anchor !== 'unenrolled') {
      planRefusal('plan-generation-marker-missing', `the slice has an enrolled controller generation (${anchor}); a record without its owner records is not historical`);
    }
    return null;
  }
  if (!Object.hasOwn(record, 'plan_generation')) planRefusal('plan-generation-marker-missing', 'plan_validation without its plan_generation marker');
  if (!Object.hasOwn(record, 'plan_validation')) planRefusal('plan-validation-missing', 'a plan_generation marker without plan_validation evidence');
  const marker = verifyPlanGenerationMarker(record.plan_generation, request, record, root);
  if (marker.begin !== null) verifyMarkerBegin(marker, request, root);
  const evidence = verifyPlanValidationEvidence(record.plan_validation, marker);
  // The candidate is exactly the admitted source set, byte for byte, at its canonical paths.
  const sources = [evidence.source.slice_plan, ...evidence.source.task_plans];
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  const byPath = new Map(artifacts.map(item => [item && item.path, item]));
  if (byPath.size !== artifacts.length || artifacts.length !== sources.length) {
    planRefusal('plan-validation-source-mismatch', 'the artifacts are not exactly the admitted plan set');
  }
  for (const entry of sources) {
    const item = entry && byPath.get(entry.path);
    if (!item || typeof item.content !== 'string' || hash(item.content) !== entry.sha256
        || Buffer.byteLength(item.content, 'utf8') !== entry.bytes) {
      planRefusal('plan-validation-source-mismatch', 'an artifact is not the admitted byte content');
    }
  }
  // Independent re-admission of exactly those bytes: digests alone never authorize.
  const admission = admitReturnedPlan(request, root, byPath.get(evidence.source.slice_plan.path).content,
    evidence.source.task_plans.map(entry => ({ id: entry.id, content: byPath.get(entry.path).content })));
  if (admission.semantic_sha256 !== evidence.semantic_sha256 || admission.graph_sha256 !== evidence.graph_sha256
      || canonicalDigest(admission.source) !== canonicalDigest(evidence.source)
      || canonicalDigest(admission.task_ids) !== canonicalDigest(evidence.task_ids)) {
    planRefusal('plan-validation-invalid', 'the admitted content does not reproduce its evidence');
  }
  return admission;
}
// Read-only recheck of an enrolled plan-slice generation immediately before a milestone
// execute-task spawns, beside the live last-spawn admission, through the SAME canonical
// classification as the native first execute (forge-plan-validation assertSliceGeneration,
// issue 343 U0d): an enrolled lineage whose completion is missing, pending, corrupt,
// foreign or ambiguous refuses, and a completed one must be current. Only a slice with no
// enrolled lineage keeps its historical behavior; nothing returns null as permission.
// Reads only: no record is written inside the protected window.
function assertExecutionPlanGeneration(request, root) {
  if (request.unitType !== 'execute-task' || request.scope === 'standalone-task' || !request.milestoneId) return null;
  const api = planApi(), owner = planOwner(root);
  const refuse = (code, detail, cause) => {
    throw Object.assign(new Error(`${code}: ${detail}`), { code, detail, cause_code: cause || null,
      provider_called: false, stage: PLAN_GENERATION_STAGE, layer: PLAN_GENERATION_STAGE });
  };
  // Outside the enrollment segment grammar no enrolled begin can exist for the milestone.
  if (!api.isScopeSegment(request.milestoneId)) return { status: 'unenrolled', milestone: request.milestoneId, slice: null };
  const slice = api.isScopeSegment(request.sliceId) ? request.sliceId : null;
  try { return api.assertSliceGeneration(owner, { owner, milestone: request.milestoneId, slice }); }
  catch (error) {
    return refuse(typeof error?.code === 'string' ? error.code : 'plan-generation-evidence-invalid',
      typeof error?.detail === 'string' ? error.detail : 'the enrolled generation is not current', error?.cause_code);
  }
}
function materialize(request, record, publicationGuard, publicationLock, options = {}) {
  assertVerificationSuccessorPublication(request, record, options);
  if (record.kind === 'memory-extraction') fail('memory-publication-required', 'Use publishReadyRecord for memory extraction receipts.');
  if (record.result.status !== 'done') return record.result;
  const root = fs.realpathSync(request.contextRoot || request.cwd);
  return require('./forge-artifact-reconciliation').withOwnerLock(root, () => {
  publicationGuard?.();
  // Issue 343 U0c: a new plan-slice generation publishes only its admitted bytes.
  assertPlanGenerationPublication(request, record, root);
  assertMilestoneDeliveryReplay(request, record);
  if (record.execution || record.milestone_delivery) {
    if (record.execution) require('./forge-task-execution').assertReplay(request, record);
    if (request.ownerBroker) require('./forge-artifact-reconciliation').assertBroker(request.ownerBroker)
      .verify({ canonicalArtifacts: record.artifacts });
    // Issue 343 U5: a cohort member publishes inside its typed member-artifacts operation; the owner
    // surface is the post-barrier broker's (S0, signed lines, committed operations, this intent).
    else if (options.memberPublication !== undefined) {
      if (!require('./forge-execution-batch').isMemberSidecar(options.memberPublication)) fail('execution-member-handle-required');
      options.memberPublication.assertOwnerSurface();
      assertMemberModes(request, record);
    } else {
      const protectedOwner = (record.execution || record.milestone_delivery).protected_owner;
      if (!protectedOwner) fail('execution-owner-baseline-required');
      let expected = { ...protectedOwner };
      const current = require('./forge-task-execution').protectedSnapshot(root);
      for (const item of record.artifacts) if (current[item.path] === hash(item.content)) {
        expected[item.path] = current[item.path];
        let dir = path.posix.dirname(item.path);
        while (dir !== '.') { if (current[dir + '/'] === 'directory') expected[dir + '/'] = 'directory'; dir = path.posix.dirname(dir); }
      }
      if(options.leaseRenewal!==undefined)expected=require('./forge-native-recovery-delivery')
        .reconcileLeaseRenewalSurface(options.leaseRenewal,record,expected);
      if (options.verificationSuccessor !== undefined) expected = require('./forge-sidecar-verification-successor')
        .read(options.verificationSuccessor, request).expectedOwner(record, expected);
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
  const linked = request.linked_begin_key
    ? require('./forge-attempt-recovery').requestIdentity(require('./forge-attempt-recovery').canonicalRequest(request)).linked_entry : null;
  return require('./forge-request-fingerprint').projectFingerprint(request, linked);
}

function artifactAttemptFiles(request) {
  const cwd = fs.realpathSync.native(request.cwd);
  const root = fs.realpathSync.native(request.contextRoot || cwd);
  const resultFile = xllm.validateResultFileTarget(request.resultFile, cwd);
  xllm.validateResultFileTarget(resultFile, root);
  const receiptFile = `${resultFile}.receipt.json`;
  const returnedFile = `${resultFile}.returned.json`;
  xllm.validateResultFileTarget(returnedFile, cwd);
  xllm.validateResultFileTarget(returnedFile, root);
  xllm.validateResultFileTarget(receiptFile, cwd);
  xllm.validateResultFileTarget(receiptFile, root);
  for (const code of request.execution_contract?.code_roots || []) {
    xllm.validateResultFileTarget(returnedFile, code.path);
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
  // Issue 343 U0c: a milestone plan-slice record exists only through its plan transport
  // (strict admission, marker and evidence); this artifacts acceptance never creates one.
  if (milestonePlanSlice(request)) fail('plan-generation-transport-required', 'Milestone slice plans publish only through the plan transport.');
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
  // Issue 343 U0c: never a second publisher of milestone slice plans (see acceptArtifactResultCore).
  if (milestonePlanSlice(request)) fail('plan-generation-transport-required', 'Milestone slice plans publish only through the plan transport.');
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
function memorySourceLabel(request, sourceUnit) {
  return `${request.sourceUnitType || 'unit'}/${sourceUnit}`;
}
function memorySourceFingerprint(request, sourceOnly = false) {
  const sourcePayload = {
    summaryContent: request.summaryContent || '', sourceResult: request.sourceResult || '',
    keyDecisions: request.keyDecisions || [],
    ...(sourceOnly ? {} : { existingMemory: request.existingMemory || { facts: [], stats: [] } }),
  };
  return request.sourceFingerprint || hash(JSON.stringify(sourcePayload));
}
// Replays use the digest-bound snapshot persisted in the v2 receipt, never a
// recomputation; legacy receipts have none and keep the historical rules.
function memoryContractEvidence(record) {
  const contract = record.memory_contract;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || contract.schema_version !== NEW_MEMORY_SCHEMA_VERSION
      || (contract.source_binding !== undefined && contract.source_binding !== 'source-only-v1')
      || !contract.evidence || typeof contract.evidence !== 'object' || Array.isArray(contract.evidence)) {
    fail('memory-contract-invalid', 'The memory receipt carries an unsupported evidence contract.');
  }
  return contract.evidence;
}
function memorySourceContext(request, record) {
  return {
    unitId: record.source_unit,
    ...(request.milestoneId ? { milestoneId: request.milestoneId } : {}),
    extractionId: record.extraction_id,
    extractedAt: record.extracted_at,
    source: {
      sourceUnit: memorySourceLabel(request, record.source_unit),
      sourceFingerprint: memorySourceFingerprint(request, record.memory_contract?.source_binding === 'source-only-v1'),
      dispatchId: record.dispatch_id,
      model: record.model,
      effort: record.effort,
    },
    ...(record.memory_contract !== undefined ? { evidence: memoryContractEvidence(record) } : {}),
  };
}
// Owner evidence registry for a new extraction, derived only from the source
// identity and structured owner evidence (request.memoryEvidence), never from
// narrative SUMMARY/result text or worker output. The source observation
// excludes existingMemory, attempt, extraction ID and time, so re-extracting
// the same source cannot manufacture a new observation. Confirm/utility exist
// only when the owner supplies verified independence/outcome records.
function memoryEvidenceContract(request, sourceUnit, historicalContext = false) {
  const extraction = require('./forge-memory-extraction');
  const supplied = request.memoryEvidence === undefined ? { records: [], outcomes: [] } : request.memoryEvidence;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
      || Object.keys(supplied).some(key => !['records', 'outcomes'].includes(key))
      || !Array.isArray(supplied.records || []) || !Array.isArray(supplied.outcomes || [])) {
    fail('memory-evidence-invalid', 'memoryEvidence must be { records, outcomes } owner data.');
  }
  const sourceLabel = memorySourceLabel(request, sourceUnit);
  const sourceFingerprint = memorySourceFingerprint(request, !historicalContext);
  const boundFingerprint = extraction.evidenceSourceFingerprint(sourceFingerprint);
  const observation = hash(JSON.stringify({ unit: sourceLabel, milestone: request.milestoneId || null,
    summary: request.summaryContent || '', result: request.sourceResult || '', key_decisions: request.keyDecisions || [] })).slice(0, 40);
  const bind = record => (record && typeof record === 'object' && !Array.isArray(record)
    ? { source_unit: sourceLabel, source_fingerprint: boundFingerprint, ...record } : record);
  const records = [
    { evidence_ref: 'source_exposure', observation_id: `source-${observation}-exposure`, observed_kind: 'exposure' },
    { evidence_ref: 'source_reobserve', observation_id: `source-${observation}-reobserve`, observed_kind: 'reobserve' },
    ...(supplied.records || []),
  ].map(bind);
  try {
    return extraction.normalizeEvidenceRegistry({ records, outcomes: supplied.outcomes || [] },
      { sourceUnit: sourceLabel, sourceFingerprint });
  } catch (error) {
    // Field locations and a reason only: no supplied value reaches the error.
    fail('memory-evidence-invalid', `Owner memory evidence was refused (${error.reason || 'invalid'}).`);
  }
}
function memoryRequestFingerprint(baseFingerprint, contract) {
  return hash(JSON.stringify({ request: baseFingerprint,
    memory_contract: { schema_version: NEW_MEMORY_SCHEMA_VERSION, evidence_digest: contract.digest } }));
}
// A receipt written before the v2 contract carries no memory_contract and the
// historical fingerprint; only that exact pair keeps replaying (v1 rules).
function legacyMemoryReceipt(existing, legacyFingerprint) {
  return Boolean(existing) && existing.memory_contract === undefined && existing.fingerprint === legacyFingerprint;
}
// Recognize old v2 only by its exact historical request fingerprint. Saved
// evidence and publication context retain their original semantics on replay.
function historicalV2MemoryReceipt(existing, request, sourceUnit, baseFingerprint) {
  if (!existing || existing.memory_contract?.source_binding !== undefined) return false;
  return existing.fingerprint === memoryRequestFingerprint(baseFingerprint,
    memoryEvidenceContract(request, sourceUnit, true));
}
function memoryPrompt(request, sourceUnit) {
  const contract = memoryEvidenceContract(request, sourceUnit);
  const input = {
    unit_type: request.sourceUnitType || 'unit', unit_id: sourceUnit,
    milestone_id: request.milestoneId || null, summary_content: request.summaryContent || '',
    result_block: request.sourceResult || '', key_decisions: request.keyDecisions || [],
    existing_memory: request.existingMemory || { facts: [], stats: [] },
    // References only: observation and binding details stay with the owner.
    evidence_refs: contract.records.map(record => ({ evidence_ref: record.evidence_ref, observed_kind: record.observed_kind })),
    outcome_refs: contract.outcomes.map(outcome => ({ outcome_ref: outcome.outcome_ref })),
  };
  const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd || process.cwd(),
    phase: 'memory-extract', forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
  return procedure.content + '\n\nRead-only memory extraction. Return exactly one JSON object matching SCHEMA (schema_version 2). '
    + 'Do not write files, run commands, choose paths, or return owner identity/publication metadata.\n'
    + `CONTRACT:\n${MEMORY_QUALITY_CONTRACT}\nINPUT:\n${JSON.stringify(input)}\nSCHEMA:\n${JSON.stringify(memorySchemaV2)}\n`
    + 'LEGACY_SCHEMA (schema_version 1, decoded only for compatibility; it cannot cite evidence, confirm independently or satisfy promotion):\n'
    + JSON.stringify(memorySchema);
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
  // Version and a closed reason code only; publication detail stays redacted.
  const reasonCode = result.publication?.status === 'conflict' && typeof result.publication.reason_code === 'string'
    && /^[a-z0-9-]{1,64}$/.test(result.publication.reason_code) ? result.publication.reason_code : null;
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
    publication_reason_code: reasonCode,
    schema_version: [1, 2].includes(record.extraction?.schema_version) ? record.extraction.schema_version : null,
    memory_contract_version: record.memory_contract?.schema_version === NEW_MEMORY_SCHEMA_VERSION ? NEW_MEMORY_SCHEMA_VERSION : null,
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

async function publishReadyRecord(request, record, publicationGuard, publicationLock, options = {}) {
  let result = await publishReadyRecordCore(request, record, publicationGuard, publicationLock, options);
  if (record.telemetry?.observation) result = { ...result, transport_telemetry: {
    ...result.transport_telemetry,
    observation: require('./forge-sidecar-calibration').observation(record.telemetry.observation),
  } };
  // Issue 343 U5: a cohort member's calibration is no effect of its typed member-artifacts
  // operation; it stays in the member's receipt (never an unproved owner write).
  if (record.calibration_proposal && result.status === 'done' && options.memberPublication === undefined
      && !['deferred', 'quarantined', 'conflict'].includes(result.publication?.status)) {
    const outcome = await require('./forge-sidecar-calibration').commitAccepted(record.calibration_proposal, {
      fingerprint: record.fingerprint, receipt: options.receiptFile || artifactAttemptFiles(request).receiptFile,
    });
    result = { ...result, transport_telemetry: { ...result.transport_telemetry, calibration_commit: outcome } };
  }
  return result;
}
async function publishReadyRecordCore(request, record, publicationGuard, publicationLock, options = {}) {
  assertVerificationSuccessorPublication(request, record, options);
  if (record.execution) require('./forge-task-execution').assertReplay(request, record);
  if (record.kind === 'review-fix') return publishReviewFixRecord(request, record);
  if (record.kind !== 'memory-extraction') return materialize(request, record, publicationGuard, publicationLock, options);
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
function legacyNativeMemoryFingerprint(request) {
  return hash(JSON.stringify({ ...request, unitType: 'memory-extract', rawResult: undefined, invocationTelemetry: undefined,
    resultFile: undefined, publicationSafe: undefined, publicationBoundary: undefined,
    waitForPublicationBoundary: undefined }));
}
function nativeMemoryFingerprint(request) {
  const r = request || {};
  const loc = locations({ ...r, unitType: 'memory-extract' });
  return memoryRequestFingerprint(legacyNativeMemoryFingerprint(r), memoryEvidenceContract(r, loc.sourceUnit));
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
    if (existing.fingerprint !== fingerprint && !legacyMemoryReceipt(existing, legacyNativeMemoryFingerprint(r))
        && !historicalV2MemoryReceipt(existing, r, loc.sourceUnit, legacyNativeMemoryFingerprint(r))) {
      fail('dispatch-identity-conflict');
    }
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
  // Refused owner evidence fails here, before any receipt exists.
  let contract = memoryEvidenceContract(r, loc.sourceUnit);
  let fingerprint = memoryRequestFingerprint(legacyNativeMemoryFingerprint(r), contract);
  let sourceBinding = 'source-only-v1';
  const existing = fs.existsSync(files.receiptFile) ? JSON.parse(fs.readFileSync(files.receiptFile, 'utf8')) : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint && !legacyMemoryReceipt(existing, legacyNativeMemoryFingerprint(r))
        && !historicalV2MemoryReceipt(existing, r, loc.sourceUnit, legacyNativeMemoryFingerprint(r))) {
      fail('dispatch-identity-conflict');
    }
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
    if (existing.fingerprint !== fingerprint) {
      contract = memoryEvidenceContract(r, loc.sourceUnit, true);
      fingerprint = existing.fingerprint;
      sourceBinding = undefined;
    }
  } else {
    fs.writeFileSync(files.receiptFile, JSON.stringify({ phase: 'started', fingerprint,
      dispatch_id: r.dispatchId }), { flag: 'wx', mode: 0o600 });
  }
  try {
    const identity = nativeMemoryIdentity(r);
    const extraction = require('./forge-memory-extraction').validateExtractionResult(r.rawResult,
      { sourceUnit: loc.sourceUnit, schemaVersions: MEMORY_RESPONSE_VERSIONS, evidence: contract });
    const record = { phase: 'ready', kind: 'memory-extraction', fingerprint,
      dispatch_id: r.dispatchId, extraction_id: r.extractionId || r.dispatchId,
      extracted_at: r.extractedAt || new Date().toISOString(), source_unit: loc.sourceUnit,
      model: identity.model, effort: identity.effort,
      telemetry: r.invocationTelemetry || null, extraction, artifacts: [],
      memory_contract: { schema_version: NEW_MEMORY_SCHEMA_VERSION, ...(sourceBinding ? { source_binding: sourceBinding } : {}), evidence: contract } };
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
    lifecycle: r.nativeLifecycle,
    terminalResult: value => { const candidate = candidateFromNativeResult(value);
      return !!candidate && MEMORY_RESPONSE_VERSIONS.includes(candidate.schema_version); },
    telemetryIdentity: r,
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
    invalidTerminalReason: 'native-execution-result-invalid',
    lifecycle: runtime.nativeLifecycle,
    terminalResult: raw => validNativeExecutionResult(raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw : xllm.extractLastJsonBlock(raw)),
    activeCapabilities: runtime.activeCapabilities, agentType: 'forge-executor',
    taskName: r.nativeInvocation?.args?.task_name || r.taskName || r.dispatchId,
    forkTurns: 'none', effortBinding: r.effortBinding, prompt,
    readback: runtime.readback, telemetryIdentity: r, telemetryRoute: r.route,
    // The one injected owner clock also governs the common owner guard inside invokeNative.
    ...(runtime.now !== undefined ? { now: runtime.now } : {}) };
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
// Event fields only when the host reported an identity through the observer and
// identityFromLifecycle binds it to this exact invocation and trusted request.
function nativeIdentityFields(outcome, invocation, request) {
  if (!outcome?.lifecycle?.host_identity || !invocation || !request) return null;
  const bound = require('./forge-agent-identity').identityFromLifecycle({ lifecycle: outcome.lifecycle, request, invocation });
  if (!bound.ok) return null;
  // The host-returned agent_id is the identity. A recovery task_name longer than
  // the event vocabulary (recovery_<dispatch>_<sha>) is left unrecorded, never cut.
  const taskName = bound.fields.task_name;
  return taskName === null || require('./forge-attempt-telemetry').code(taskName) === taskName
    ? bound.fields : { ...bound.fields, task_name: null };
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
    validateRecoveryRequest(r, { verification: runtime.verification, nativeInvocation: binding });
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
    lifecycle: { ...runtime.nativeLifecycle, captureLateResult: options.captureLateNativeResult },
    beforeInvoke: async () => { await options.announce('solicitado', { model_sent: r.route.model_resolved || r.route.model, provider_called: false }); },
    budgets: execution.budgets, onPackagedContext: packaged => options.onPackagedContext({ ...packaged,
      bytes: Buffer.byteLength(prompt), sha256: hash(prompt), transport_sha256: hash(transportPrompt),
      input_tokens: Math.ceil(prompt.length / 4), token_method: 'heuristic-chars-4' }) };
  let invoked = null;
  const outcome = await require('./forge-native-invocation').invokeNative(nativeOptions, (args, binding, observer) => {
    invoked = binding;
    options.enterTransport();
    assertInvocation('before-invoke');
    // The Forge identity observer rides after the existing arguments; it is never a tool argument.
    return runtime.invokeNative(args, binding, observer);
  });
  const bound = nativeIdentityFields(outcome, invoked, nativeOptions.telemetryIdentity);
  if (bound) options.recordNativeIdentity?.(bound);
  const receiptFile = r.resultFile + '.receipt.json';
  const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (outcome.final_evidence) json(receiptFile, { ...saved, final_evidence: outcome.final_evidence });
  if (!outcome.ok) {
    // A pre-provider refusal of the common owner guard keeps its typed stage and layer: linked task
    // codes come from the task horizon, the others from the milestone horizon. Only the typed
    // code, stage and layer travel; no raw payload, handle or lifecycle object is copied.
    const admissionApi = require('./forge-milestone-time-admission');
    const refused = outcome.provider_called === false && outcome.diagnostic?.layer === 'milestone-time-admission'
      && admissionApi.TRANSPORT_REFUSAL_CODES.includes(outcome.reason_code);
    const linkedCode = refused && require('./forge-linked-task-horizon').LINKED_TASK_TRANSPORT_CODES.includes(outcome.reason_code);
    throw Object.assign(new Error(outcome.reason_code), {
      code: outcome.reason_code, provider_called: outcome.provider_called,
      ...(refused ? { stage: linkedCode ? 'linked-task-admission' : 'milestone-time-admission', layer: 'milestone-time-admission' } : {}) });
  }
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
      const checked = validateRecoveryRequest(r, { verification: runtime.verification, nativeInvocation: validateNativeExecutionBinding(r, runtime) });
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

// A pre-provider refusal of the common owner guard: the milestone horizon (stage
// milestone-time-admission) or the linked task horizon (stage linked-task-admission, same layer).
function admissionRefusal(error) {
  return error?.stage === 'milestone-time-admission'
    || error?.stage === 'linked-task-admission' && error.layer === 'milestone-time-admission' && error.provider_called === false;
}

// ── Retained cohort member execution (issue 343 U3b, B3 part 2) ──────────────
//
// A sidecar cohort member (its opaque handle travels beside the request, never inside it) runs
// through the same core with an explicit member branch: its owner events are signed lines of the
// cohort stream, its owner surface is the broker's common verification, its plan is the runtime
// view its handle validated, and a finished member stops at the retained executed record plus seal
// (forge-execution-batch memberSidecar retain). It produces no .gsd artifact, task marker,
// controller completion, owner event or done result while its siblings run; the heavy verification
// (verifyRetainedExecution) exists only after the cohort barrier and publication belongs to the
// serial post-barrier publisher. returned.json stays custody, never replay authority.

// The live member operations of a request (forge-execution-batch), resolved from its handle.
function memberExecution(handle, request) {
  return require('./forge-execution-batch').memberSidecar(handle, request);
}
// A member's execution always carries a real seal bound to its runtime view: the historical
// tolerance of an absent seal never applies to it, and a single seal never verifies a member.
function verifyMemberSeal(request, record, identity, runtimeVerification, view) {
  if (!record || !record.verification_seal) fail('verification-provenance-insufficient');
  if (record.verification_successor) fail('verification-successor-capability-required');
  const verificationApi = require('./forge-verify'), plan = fs.readFileSync(request.planFile, 'utf8');
  verificationApi.assertExecutionVerification(record.verification_seal, request.execution_contract, plan, identity, { memberView: view });
  if (runtimeVerification !== undefined) {
    const supplied = verificationApi.normalizeExecutionVerification(request.execution_contract, plan, request.verification,
      runtimeVerification, identity, { memberView: view });
    if (supplied.sha256 !== record.verification_seal.sha256) fail('verification-policy-changed');
  }
  if (record.delivery_capture && record.delivery_capture.verification_policy_sha256 !== record.verification_seal.sha256) fail('verification-capture-binding');
}
// The executed record a later receipt derives from: only the core's own fields (delivery_capture,
// then phase ready and its artifacts) may differ from the anchored executed bytes.
function executedBase(record) {
  const { phase, delivery_capture: capture, artifacts, ...base } = record;
  return base;
}
function sameExecutedBase(candidate, executed) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !executed || executed.phase !== 'executed'
      || !['executed', 'ready'].includes(candidate.phase) || (candidate.phase === 'executed' && candidate.artifacts !== undefined)) return false;
  return canonicalDigest(executedBase(candidate)) === canonicalDigest(executedBase(executed));
}

// The validated core of a writing unit's completion, with an explicit context: the request, its
// locations and physical roots, the receipt channel, the verification identity and seal check
// (with the runtime policy), the delivery renderer, the member's live view (null on the single
// path) and the event emitters. Callers: finishExecute and the executed replay of
// runUnitSidecarCore (the single context, its exact previous behavior) and verifyRetainedExecution
// (a cohort member after the barrier, owner events deferred). It never publishes.
async function completeExecutionCore(context, record, deferredEvents = null) {
  const r = context.request, loc = context.loc, root = context.root, cwd = context.cwd, member = context.member || null;
  const persist = context.persist === undefined ? !deferredEvents : context.persist === true;
  context.verifySeal(record);
  if (record.execution) require('./forge-task-execution').assertReplay(r, record);
  else if (record.milestone_delivery) {
    const api = require('./forge-task-execution');
    const saved = record.milestone_delivery;
    assertMilestoneDeliveryReplay(r, record);
    // A cohort member's owner surface is the cohort's common signed stream, after the barrier.
    if (member) {
      assertMemberModes(r, record);
      await member.verifyOwner('sealed');
    }
    else api.assertProtected(root, context.verificationSuccessor
      ? context.verificationSuccessor.expectedOwner(record, saved.protected_owner) : saved.protected_owner);
  }
  if (r.execution_contract && (!record.delivery_capture || !record.delivery_capture.passed)) {
    const resourceEvents = [];
    context.notifyPhase('verifying');
    const deliveryCapture = require('./forge-verify').captureRootDelivery(r.execution_contract,
      fs.readFileSync(r.planFile, 'utf8'), { ...r.verification, verificationSeal: record.verification_seal,
        verificationIdentity: context.verificationIdentity, unit: loc.rules[loc.delivery.input].unit,
        resourceEventSink: line => resourceEvents.push(line),
        ...(typeof context.onVerificationCheck === 'function' ? { onCheck: context.onVerificationCheck } : {}),
        ...(member ? { memberView: member.view() } : {}) });
    record = { ...record, delivery_capture: deliveryCapture };
    // Retain stdout, cleanup and the actual failing check before throwing.
    // A failed capture never satisfies replay: the gate runs again above.
    if (persist) json(context.receiptFile, record);
    if (deferredEvents) deferredEvents.push(...resourceEvents);
    else await context.appendOwnedEvents(resourceEvents, record);
    if (!deliveryCapture.passed) fail('execution-verification-failed');
    if (record.execution) require('./forge-task-execution').assertReplay(r, record);
    if (persist) json(context.receiptFile, record);
  }
  if (member && record.milestone_delivery) assertMemberModes(r, record);
  const artifacts = executeDeliveryArtifacts(r, loc, record.result, root, cwd, record.delivery_capture,
    member ? { memberView: member.view() } : undefined);
  const ready = { ...record, phase: 'ready', artifacts: artifacts.map(a => ({ ...a, before: record.before[a.path] ?? null })) };
  // Milestone v2 only: the owner marker enters the durable record after the
  // validated delivery artifacts and last, so a checked task implies delivery.
  if (r.execution_contract && record.milestone_delivery && !record.execution && record.result?.status === 'done') {
    const marker = createTaskMarker(r, root, record.before?.[taskMarkerPath(r)], member ? context.markerChain : undefined);
    if (marker) ready.artifacts.push(marker);
  }
  if (persist) json(context.receiptFile, ready);
  if (context.verificationSuccessor) verificationSuccessorReady.set(ready, {
    cap: context.successorCapability, record: require('./forge-code-roots').digest(ready),
    request: require('./forge-code-roots').digest(r),
  });
  return ready;
}

// A ready cache is not authority to cross the cohort barrier. Reproduce it from
// the anchored executed base through the canonical core, without persistence,
// capture or publication; a changed workspace/artifact cache is refused.
async function assertRetainedReady(context, record, retained) {
  if (retained.phase !== 'sealed') fail('batch-member-barrier-open');
  if (record.delivery_capture?.passed !== true || !Array.isArray(record.artifacts)) fail('batch-member-retained-invalid');
  const ready = await completeExecutionCore({ ...context, persist: false }, record, []);
  if (canonicalDigest(ready) !== canonicalDigest(record)) fail('batch-member-retained-changed');
}

/**
 * Issue 343 U3b: the post-barrier verification of one retained sidecar cohort member (the serial
 * coordinator calls it, one member at a time). The request is the member's exact bound attempt
 * with its live `memberHandle` beside the data. It requires the sealed barrier and the anchored
 * retained execution, revalidates the original executed record, seal and preconditions with the
 * member's current runtime view, and then runs the real completion core: the captured delivery,
 * artifacts and task marker of a verified ready record, written only to the attempt's own receipt
 * channel. It publishes nothing, appends no owner event (its resource events are returned), calls
 * no provider, and a failing capture never becomes ready.
 *
 * @returns {Promise<{ status: 'retained', stage: 'ready', ready_sha256, deferred_events, ... }>}
 */
async function verifyRetainedExecution(request, runtime = {}) {
  if (!request || typeof request !== 'object' || !Object.prototype.hasOwnProperty.call(request, 'memberHandle')) fail('execution-member-handle-required');
  const { memberHandle, ...r } = request;
  const member = memberExecution(memberHandle, r);
  const route = r.route || {};
  const transport = capability(route.resolved_worker_engine, r.unitType, r.scope === 'milestone' ? {} : r);
  if (!transport.supported || transport.mode !== 'execute' || r.scope !== 'milestone' || !r.execution_contract
      || runtime.verificationSuccessor !== undefined) fail('batch-member-operation-unsupported');
  if (!r.dispatchId || !r.workflowId) fail('dispatch-identity-required');
  const cwd = fs.realpathSync(r.cwd), root = fs.realpathSync(r.contextRoot || cwd);
  const resultFile = xllm.validateResultFileTarget(r.resultFile, cwd);
  xllm.validateResultFileTarget(resultFile, root);
  artifactAttemptFiles(r);
  member.assertChannels(resultFile);
  const receiptFile = `${resultFile}.receipt.json`;
  const loc = locations(r);
  const dispatchId = xllm.normalizeDispatchId(r.dispatchId, 'unit');
  const fingerprint = artifactFingerprint(r);
  const verificationIdentity = { dispatch_id: dispatchId, fingerprint, recovery_identity_sha256: recoveryIdentity(r) };
  // The heavy capture exists only after the barrier, and only for an anchored retained execution:
  // a saved returned response alone (custody) is never the record verified here.
  if (!member.barrierSealed()) fail('batch-member-barrier-open');
  const retained = await member.retained();
  if (!retained) fail('batch-member-retained-required');
  if (retained.phase !== 'sealed') fail('batch-member-barrier-open');
  const executed = retained.executed_record;
  if (executed.phase !== 'executed' || executed.fingerprint !== fingerprint || executed.dispatch_id !== dispatchId
      || !executed.milestone_delivery || executed.result?.status !== 'done') fail('batch-member-retained-invalid');
  if (!fs.existsSync(receiptFile)) fail('batch-member-retained-invalid');
  const current = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (!sameExecutedBase(current, executed)) fail('batch-member-retained-changed');
  const verifySeal = record => verifyMemberSeal(r, record, verificationIdentity, runtime.verification, member.view());
  const deferredEvents = [];
  // Issue 343 U5: the sibling markers the cohort's committed operations already published (signed journal).
  const markerChain = member.markerChain(taskMarkerPath(r));
  if (current.phase === 'ready') await assertRetainedReady({ request: r, loc, root, cwd, receiptFile, verificationIdentity,
    verificationSuccessor: null, member, markerChain, verifySeal, notifyPhase: () => {}, appendOwnedEvents: () => fail('batch-member-owner-event-deferred') }, current, retained);
  else {
    const notify = phase => {
      if (typeof runtime.onPhase !== 'function') return;
      try {
        runtime.onPhase(Object.freeze({ schema_version: 1, phase, dispatch_id: dispatchId, unit: unitLabel(r, loc), worker_mode: 'sidecar',
          at: new Date().toISOString() }));
      } catch { /* observer errors never affect the unit */ }
    };
    await completeExecutionCore({ request: r, loc, root, cwd, receiptFile, verificationIdentity, verificationSuccessor: null,
      member, markerChain, persist: true, verifySeal, notifyPhase: notify,
      appendOwnedEvents: () => fail('batch-member-owner-event-deferred'), onVerificationCheck: runtime.onVerificationCheck },
    current, deferredEvents);
  }
  // Verification wrote nothing into the owner: the cohort stream still proves its whole surface.
  await member.verifyOwner('sealed');
  const receiptBytes = fs.readFileSync(receiptFile), ready = JSON.parse(receiptBytes.toString('utf8'));
  if (ready.phase !== 'ready' || !sameExecutedBase(ready, executed) || ready.delivery_capture?.passed !== true) fail('batch-member-retained-changed');
  const result = { status: 'retained', stage: 'ready', dispatch_id: dispatchId, batch_id: retained.batch_id, member_ref: retained.member_ref,
    task_id: retained.task_id, retained_ref: { path: retained.ref_path, sha256: retained.ref_sha256 }, anchor_sha256: retained.anchor.sha256,
    ready_sha256: hash(receiptBytes), provider_called: false };
  json(resultFile, result);
  return { ...result, deferred_events: deferredEvents };
}

// ── Serial publication of a verified cohort member (issue 343 U5, B5) ─────────
//
// The post-barrier coordinator (forge-execution-batch consolidateCohort) publishes one member at a
// time through the canonical publisher. retainedPublication validates the verified ready record again
// from the anchored executed record through the real completion core (no capture repeated, nothing
// written) and returns its exact effects (artifact path, preimage, post-image digest; the task marker
// last) for the member's typed member-artifacts intent. publishRetainedMember runs publishReadyRecord /
// materialize only while that signed intent is in flight for exactly this member and ready record;
// the publisher's owner guard is the cohort broker's whole-surface verification. No provider call, no
// owner event, no controller completion here.
function retainedRequest(request, runtime) {
  if (!request || typeof request !== 'object' || !Object.prototype.hasOwnProperty.call(request, 'memberHandle')) fail('execution-member-handle-required');
  const { memberHandle, ...r } = request;
  const member = memberExecution(memberHandle, r);
  const route = r.route || {};
  const transport = capability(route.resolved_worker_engine, r.unitType, r.scope === 'milestone' ? {} : r);
  if (!transport.supported || transport.mode !== 'execute' || r.scope !== 'milestone' || !r.execution_contract
      || runtime.verificationSuccessor !== undefined) fail('batch-member-operation-unsupported');
  if (!r.dispatchId || !r.workflowId) fail('dispatch-identity-required');
  const cwd = fs.realpathSync(r.cwd), root = fs.realpathSync(r.contextRoot || cwd);
  const resultFile = xllm.validateResultFileTarget(r.resultFile, cwd);
  xllm.validateResultFileTarget(resultFile, root);
  artifactAttemptFiles(r);
  member.assertChannels(resultFile);
  const dispatchId = xllm.normalizeDispatchId(r.dispatchId, 'unit');
  const fingerprint = artifactFingerprint(r);
  return { r, member, cwd, root, resultFile, receiptFile: `${resultFile}.receipt.json`, loc: locations(r), dispatchId, fingerprint,
    verificationIdentity: { dispatch_id: dispatchId, fingerprint, recovery_identity_sha256: recoveryIdentity(r) } };
}
async function retainedReady(context, runtime) {
  const { r, member, receiptFile, dispatchId, fingerprint, verificationIdentity } = context;
  if (!member.barrierSealed()) fail('batch-member-barrier-open');
  const retained = await member.retained();
  if (!retained) fail('batch-member-retained-required');
  if (retained.phase !== 'sealed') fail('batch-member-barrier-open');
  const executed = retained.executed_record;
  if (executed.phase !== 'executed' || executed.fingerprint !== fingerprint || executed.dispatch_id !== dispatchId
      || !executed.milestone_delivery || executed.result?.status !== 'done') fail('batch-member-retained-invalid');
  if (!fs.existsSync(receiptFile)) fail('batch-member-ready-required');
  const bytes = fs.readFileSync(receiptFile), ready = JSON.parse(bytes.toString('utf8'));
  if (ready.phase !== 'ready' || !sameExecutedBase(ready, executed) || ready.delivery_capture?.passed !== true
      || !Array.isArray(ready.artifacts) || !ready.artifacts.length) fail('batch-member-ready-required');
  const verifySeal = record => verifyMemberSeal(r, record, verificationIdentity, runtime.verification, member.view());
  verifySeal(ready);
  assertMemberModes(r, ready);
  return { retained, ready, ready_sha256: hash(bytes), verifySeal };
}
function publicationEffects(ready) {
  return ready.artifacts.map(item => ({ path: item.path, before: typeof item.before === 'string' ? item.before : null,
    after: { sha256: hash(item.content) } }));
}
/** Issue 343 U5: the exact typed effects of a verified member's publication (read-only). */
async function retainedPublication(request, runtime = {}) {
  const context = retainedRequest(request, runtime);
  const { r, member, loc, root, cwd, receiptFile, verificationIdentity } = context;
  if (member.pendingOperation()) fail('batch-member-publication-pending');
  const prepared = await retainedReady(context, runtime);
  // The ready record must be exactly what the real completion core derives now from the anchored record.
  await assertRetainedReady({ request: r, loc, root, cwd, receiptFile, verificationIdentity, verificationSuccessor: null, member,
    markerChain: member.markerChain(taskMarkerPath(r)), verifySeal: prepared.verifySeal, notifyPhase: () => {},
    appendOwnedEvents: () => fail('batch-member-owner-event-deferred') }, prepared.ready, prepared.retained);
  return { task_id: r.taskId, dispatch_id: context.dispatchId, member_ref: member.member_ref, ready_sha256: prepared.ready_sha256,
    effects: publicationEffects(prepared.ready) };
}
/** Issue 343 U5: the canonical publication of one member inside its signed, in-flight member-artifacts intent. */
async function publishRetainedMember(request, runtime = {}) {
  const context = retainedRequest(request, runtime);
  const { r, member } = context;
  const prepared = await retainedReady(context, runtime);
  const pending = member.pendingOperation(), intent = pending && pending.payload;
  if (!intent || intent.species !== 'member-artifacts' || intent.member_ref !== member.member_ref || !intent.producer
      || intent.producer.ready_sha256 !== prepared.ready_sha256
      || canonicalDigest(intent.effects) !== canonicalDigest(publicationEffects(prepared.ready))) fail('batch-member-publication-intent-required');
  const result = await publishReadyRecord(r, prepared.ready, () => member.assertOwnerSurface(), undefined, { memberPublication: member });
  return { status: 'published', task_id: r.taskId, dispatch_id: context.dispatchId, member_ref: member.member_ref,
    ready_sha256: prepared.ready_sha256, result_status: result && typeof result.status === 'string' ? result.status : null, provider_called: false };
}

async function runUnitSidecarCore(request, runtime, identity, memberHandle) {
  let verificationSuccessor = null;
  let transportReturned = false;
  let partialFixResult = false;
  let recoveryReady = runtime.assertRecoveryReady;
  // Phase observer (bound below once the unit identity is validated). It only
  // reads: no durable write, no announcer stage, errors never reach the unit.
  let notifyPhase = () => {};
  let executingObserved = false;
  // The common owner guard of a standalone task request (linked task horizon; an unlinked task
  // returns without reading time state). It runs at every actual entry below and again at the
  // adapter's last launch hook (the packaged context, immediately before the child, app-server
  // turn or native callback), so time that elapses while the adapter packages is never admitted.
  const admitTaskLaunch = () => {
    if (r.scope === 'standalone-task') require('./forge-milestone-time-admission').assertOwnerTransportEntry({ request: r, now: runtime.now });
  };
  // The typed pre-provider refusal raised by this attempt's own last launch hook, kept so that an
  // adapter that rewraps foreign exceptions of its packaging step cannot erase it (see the catch).
  let packagingRefusal = null;
  const admitFinalLaunch = () => {
    try {
      if (r.scope !== 'standalone-task' && r.milestoneId) require('./forge-milestone-time-admission').assertTransportEntry({
        cwd: r.contextRoot || r.cwd, milestone: r.milestoneId, unit: unitLabel(r, locations(r)), now: runtime.now });
      else admitTaskLaunch();
      // Issue 343 U0c: beside the live last-spawn admission, the read-only recheck of the
      // enrolled plan-slice generation of a milestone execute-task, immediately before spawn.
      if (transport.mode === 'execute') assertExecutionPlanGeneration(r, root);
    } catch (refusal) {
      if ((admissionRefusal(refusal) || planGenerationRefusal(refusal)) && refusal.provider_called === false) packagingRefusal = refusal;
      throw refusal;
    }
  };
  const enterTransport = () => {
    packagingRefusal = null;
    if (verificationSuccessor) fail('verification-successor-no-inference');
    if (r.scope !== 'standalone-task' && r.milestoneId) require('./forge-milestone-time-admission').assertTransportEntry({
      cwd: r.contextRoot || r.cwd, milestone: r.milestoneId, unit: unitLabel(r, locations(r)), now: runtime.now });
    // The same common owner guard at every actual standalone entry (first launch, retry,
    // native execution callback and recovery): a linked task outside its horizon refuses here,
    // before any spawn.
    else admitTaskLaunch();
    // Issue 343 U0c: the same read-only generation recheck at every actual execute entry.
    if (transport.mode === 'execute') assertExecutionPlanGeneration(r, root);
    // Issue 343 U3b: a cohort member's complete seam again at its launch (claim, begin and lease,
    // physical map and plan view), before any provider: a refusal here called none.
    if (member) {
      try { member.resolve(); }
      catch (refusal) { if (typeof refusal?.provider_called !== 'boolean') refusal.provider_called = false; throw refusal; }
    }
    recoveryReady?.();
    recoveryReady = null;
    if (!executingObserved) { executingObserved = true; notifyPhase('executing'); }
  };
  const r = request || {}, route = r.route || {};
  // Issue 343 U3b: the explicit cohort-member branch exists only with the member's live handle
  // (beside the request, never inside it); a request naming a batch or an aggregate claim never
  // takes the single path without it, and combinations not yet integrated refuse before any write.
  const member = memberHandle === undefined ? null : memberExecution(memberHandle, r);
  if (!member && (r.batch_id !== undefined || r.claim?.batch_roots)) fail('execution-member-handle-required');
  if (member && (r.scope !== 'milestone' || runtime.verificationSuccessor !== undefined || r.ownerBroker
      || runtime.assertRecoveryReady || runtime.savedNativeResult)) fail('batch-member-operation-unsupported');
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
  if (transport.mode === 'execute' && !fs.existsSync(`${r.resultFile}.receipt.json`)) {
    preflightExecutionVerification(r, { verification: runtime.verification, ...(member ? { memberView: member.view() } : {}) });
  }
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
  let resultFile = xllm.validateResultFileTarget(r.resultFile, cwd);
  let publicationRequest = r;
  let provisionalChannelActive = false;
  // Both code and context roots are worker-readable; neither owns the result.
  xllm.validateResultFileTarget(resultFile, root);
  artifactAttemptFiles(r); // Validate all attempt channels against every declared root before writes.
  // Issue 343 U3b: a member's channels also stay outside every sibling, integration and evidence root.
  if (member) member.assertChannels(resultFile);
  const loc = locations(r);
  const dispatchId = xllm.normalizeDispatchId(r.dispatchId, 'unit');
  identity.dispatch_id = dispatchId;
  identity.model_sent = model;
  if (!r.dispatchId || !r.workflowId) fail('dispatch-identity-required');
  // S05: Claude session persistence is opted in per unit, only here, because
  // this owner holds the receipt and the recovery state that can resume and
  // clean a preserved session. Only plan/execute units qualify.
  const claudeSessions = require('./forge-claude-session');
  // Resolved once, with the same inference recovery uses (plan-milestone has no explicit phase).
  const sessionPhase = require('./forge-attempt-recovery').canonicalRequest(r).phase;
  const sessionEligible = route.resolved_worker_engine === 'claude' && route.worker_mode === 'sidecar' && !nativeExecution
    && (transport.mode === 'execute' || transport.mode === 'plan' || (transport.mode === 'artifacts' && sessionPhase === 'plan'));
  let claudeSession = null, resumedFrom = null, resumeSessionSha = null;
  if (r.claudeResume != null || r.resumedFrom != null) {
    if (!sessionEligible) fail('claude-invalid-options', 'Only a Claude sidecar plan/execute unit can resume a session.');
    if (!claudeSessions.validateSessionRef(r.claudeResume).ok) fail('claude-session-invalid');
    const from = r.resumedFrom;
    if (!from || typeof from !== 'object' || typeof from.receipt_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(from.receipt_sha256)
        || typeof from.dispatch_id !== 'string' || !from.dispatch_id) fail('claude-invalid-options', 'A session resume requires resumedFrom {receipt_sha256, dispatch_id}.');
    resumedFrom = { receipt_sha256: from.receipt_sha256, dispatch_id: from.dispatch_id };
    claudeSession = { resume: r.claudeResume };
    resumeSessionSha = claudeSessions.sessionDigest(r.claudeResume.id);
  } else if (sessionEligible) claudeSession = { persist: true };
  // Receipts and events carry only session_sha256, never the raw id.
  const sessionShaOf = (telemetry, error) => {
    const reported = telemetry?.session?.session_sha256;
    if (typeof reported === 'string' && /^[0-9a-f]{64}$/.test(reported)) return reported;
    try { if (error?.session?.id) return claudeSessions.sessionDigest(error.session.id); } catch { /* invalid ref: no digest */ }
    return resumeSessionSha;
  };
  // Memory requests bind the v2 contract and its owner evidence digest; the
  // historical fingerprint is kept only to recognize pre-v2 receipts.
  const memoryContract = transport.mode === 'memory' ? memoryEvidenceContract(r, loc.sourceUnit) : null;
  const legacyFingerprint = artifactFingerprint(r);
  const fingerprint = memoryContract ? memoryRequestFingerprint(legacyFingerprint, memoryContract) : legacyFingerprint;
  let receiptFile = `${resultFile}.receipt.json`;
  if (runtime.verificationSuccessor !== undefined) {
    if (runtime.verification !== undefined) fail('verification-successor-policy-mixing');
    verificationSuccessor = require('./forge-sidecar-verification-successor').read(runtime.verificationSuccessor, r);
    resultFile = verificationSuccessor.resultFile;
    receiptFile = verificationSuccessor.receiptFile;
    verificationSuccessor.initialize();
  }
  xllm.validateResultFileTarget(receiptFile, cwd);
  xllm.validateResultFileTarget(receiptFile, root);
  const eventsFile = target(root, '.gsd/forge/events.jsonl');
  const label = unitLabel(r, loc);
  notifyPhase = (phase, detail = {}) => {
    if (typeof runtime.onPhase !== 'function') return;
    const record = { schema_version: 1, phase, dispatch_id: dispatchId, unit: label,
      worker_mode: nativeExecution ? 'native' : 'sidecar', at: new Date().toISOString() };
    if (['done', 'partial', 'blocked'].includes(detail.outcome)) record.outcome = detail.outcome;
    const reason = require('./forge-attempt-telemetry').code(detail.reason_code);
    if (reason) record.reason_code = reason;
    try { runtime.onPhase(Object.freeze(record)); } catch { /* observer errors never affect the unit */ }
  };
  // Publication seam: one observer call, then the unchanged canonical publication.
  const publish = (record, publicationGuard) => {
    notifyPhase('publishing');
    return publishReadyRecord(publicationRequest, record, publicationGuard, undefined,
      verificationSuccessor ? { verificationSuccessor: runtime.verificationSuccessor, receiptFile } : {});
  };
  const completed = result => notifyPhase(result?.status === 'partial' ? 'waiting'
    : result?.status === 'blocked' ? 'failed' : 'completed',
  { outcome: result?.status, reason_code: result?.diagnostic?.reason || result?.reason_code });
  // Native host identity accepted by identityFromLifecycle; appended once, after
  // the final or failed event, through the same owner channel as those events.
  let nativeIdentity = null, nativeIdentityAppended = false;
  async function appendNativeIdentity() {
    if (!nativeIdentity || nativeIdentityAppended) return;
    nativeIdentityAppended = true;
    try {
      const identityApi = require('./forge-agent-identity');
      const line = identityApi.renderAgentIdentityEvent(identityApi.buildAgentIdentityEvent({ unit: label, ...nativeIdentity }));
      await livenessQueue;
      const record = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
      await appendOwnedEvent(line, record);
    } catch { /* the identity stays unknown; the canonical outcome is unchanged */ }
  }
  async function appendOwnedEvent(line, record) {
    if (verificationSuccessor) {
      verificationSuccessor.assertRecord(record);
      record.verification_successor_events = [...(record.verification_successor_events || []), line];
      json(receiptFile, record);
      return;
    }
    // Issue 343 U3b: every owner event of a cohort member is a signed line of the cohort stream.
    if (member) return member.appendEvent(line);
    if (recoveryReady?.appendOwnerEvent) return recoveryReady.appendOwnerEvent(line);
    if (r.ownerBroker) return require('./forge-artifact-reconciliation').assertBroker(r.ownerBroker)
      .append('.gsd/forge/events.jsonl', line);
    const protectedOwner = record?.execution?.protected_owner || record?.recovery_baseline?.protected_owner;
    if (!protectedOwner) {
      const key = '.gsd/forge/events.jsonl';
      const surface = record?.preparation_surface;
      const previous = surface && typeof surface[key] === 'string' && fs.existsSync(eventsFile)
        ? fs.readFileSync(eventsFile) : null;
      fs.appendFileSync(eventsFile, line);
      // Standalone preparation has no owner broker: advance the surface by exactly
      // these authenticated bytes (same-tick, no await) so unrelated writes stay detectable.
      if (previous && hash(previous) === surface[key]) {
        const appended = Buffer.concat([previous, Buffer.from(line)]);
        if (fs.readFileSync(eventsFile).equals(appended)) {
          record.preparation_surface = { ...surface, [key]: hash(appended) };
          json(receiptFile, record);
        }
      }
      return;
    }
    return appendProtectedOwnerEvents(root, receiptFile, record, [line]);
  }
  async function appendOwnedEvents(lines, record) {
    if (!lines.length) return;
    const batch = lines.slice();
    await livenessQueue;
    const protectedOwner = record?.execution?.protected_owner || record?.recovery_baseline?.protected_owner;
    if (verificationSuccessor || recoveryReady?.appendOwnerEvent || r.ownerBroker || member || !protectedOwner) {
      for (const line of batch) await appendOwnedEvent(line, record);
    } else return appendProtectedOwnerEvents(root, receiptFile, record, batch);
  }
  // Liveness events (sidecar-no-progress) share the owner's single event channel.
  // Appends are serialized and settled before any later owner event or receipt
  // transition, so events.jsonl keeps its order and no receipt write races.
  let livenessQueue = Promise.resolve();
  let noProgressOpen = false;
  // Exact events.jsonl hash advance made by liveness appends through the
  // protected-owner channel: {from: hash before the first, to: hash after the last}.
  let livenessEventAdvance = null;
  const ownedEventsHash = record => (record?.execution?.protected_owner || record?.recovery_baseline?.protected_owner)?.['.gsd/forge/events.jsonl'];
  async function appendNoProgress(transition) {
    const repeats = transition?.progress?.repeats;
    const fingerprintSha = transition?.progress?.fingerprint_sha256;
    // Closed allowlist built field by field: only a count and a 16-hex hash.
    const line = JSON.stringify({ ts: new Date().toISOString(), event: 'sidecar-no-progress',
      workflow_id: r.workflowId, dispatch_id: dispatchId, unit: label,
      worker_engine: route.resolved_worker_engine, model,
      repeats: Number.isSafeInteger(repeats) && repeats > 0 ? repeats : null,
      ...(typeof fingerprintSha === 'string' && /^[0-9a-f]{16}$/.test(fingerprintSha) ? { fingerprint_sha256: fingerprintSha } : {}) }) + '\n';
    if (!recoveryReady?.appendOwnerEvent && !r.ownerBroker) fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    // Reread inside the queue: onProgress/onPackagedContext rewrite the receipt.
    const record = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
    const before = ownedEventsHash(record);
    await appendOwnedEvent(line, record);
    const after = ownedEventsHash(record);
    if (before && after && before !== after) livenessEventAdvance = { from: livenessEventAdvance?.from || before, to: after };
  }
  function onLiveness(transition) {
    if (transition?.to === 'slow-suspect' && transition.reason === 'no-progress') {
      if (!noProgressOpen) {
        noProgressOpen = true;
        livenessQueue = livenessQueue.then(() => appendNoProgress(transition)).catch(() => { /* best-effort */ });
      }
    } else if (noProgressOpen && transition?.from === 'slow-suspect') noProgressOpen = false;
    if (typeof runtime.onLiveness === 'function') {
      try { runtime.onLiveness(transition); } catch { /* observer errors never affect the unit */ }
    }
  }
  // The owner's protected snapshot taken before transport predates liveness
  // appends; advance only the exact bytes this unit appended, never adopt a
  // fresh snapshot.
  const advanceLivenessEvents = snapshot => {
    if (livenessEventAdvance && snapshot?.['.gsd/forge/events.jsonl'] === livenessEventAdvance.from) {
      snapshot['.gsd/forge/events.jsonl'] = livenessEventAdvance.to;
    }
  };
  // A failed Claude session removal is never silent: one closed owner event
  // with counts and the digest only (no raw id, no paths). Best-effort, like
  // the liveness events: it never turns a published result into a failure.
  async function sessionCleanupEvent(cleanup, sessionSha) {
    if (!cleanup || cleanup.ok !== false) return;
    await livenessQueue;
    const count = list => Array.isArray(list) ? list.length : 0;
    const line = JSON.stringify({ ts: new Date().toISOString(), event: 'claude-session-cleanup-failed',
      workflow_id: r.workflowId, dispatch_id: dispatchId, unit: label, session_sha256: sessionSha || null,
      refused: count(cleanup.refused), errors: count(cleanup.errors) }) + '\n';
    try {
      if (!recoveryReady?.appendOwnerEvent && !r.ownerBroker) fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
      const record = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
      await appendOwnedEvent(line, record);
    } catch { /* best-effort: the cleanup report stays in the transport telemetry/result */ }
  }
  async function event(status, reasonCode, detail, providerCalled = false, extra = null, transaction = null) {
    await livenessQueue;
    if (!recoveryReady?.appendOwnerEvent) fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    let line = JSON.stringify({ ts: new Date().toISOString(), event: 'sidecar-unit',
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
    if (transaction) {
      line = transaction.eventLine ||= line;
      const current = fileHash(eventsFile);
      if (transaction.eventStarted) {
        if (current === transaction.eventAfter) {
          const protectedHash = ownedEventsHash(record);
          if (protectedHash && protectedHash !== current) fail('provisional-failure-event-reconciliation-required');
          return;
        }
        if (current !== transaction.eventBefore) fail('provisional-failure-event-reconciliation-required');
      } else {
        const stat = fs.existsSync(eventsFile) ? fs.statSync(eventsFile) : null;
        if (stat && stat.size > 16 * 1024 * 1024) fail('provisional-failure-event-limit');
        const previous = stat ? fs.readFileSync(eventsFile) : Buffer.alloc(0);
        transaction.eventBefore = stat ? hash(previous) : null;
        transaction.eventAfter = hash(Buffer.concat([previous, Buffer.from(line)]));
        transaction.eventStarted = true;
      }
    }
    await appendOwnedEvent(line, record);
  }
  const failureTransactions = new WeakMap();
  function writeSameJson(file, value) {
    const expected = JSON.stringify(value, null, 2) + '\n';
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === expected) return;
    json(file, value);
  }
  async function recordFailure(error, extra = null) {
    const code = error.code || 'sidecar-unit-failed';
    if (verificationSuccessor) {
      error.provider_called = false;
      error.stage = 'publication';
      json(resultFile, { status: 'adapter-failed', reason_code: code, layer: 'publication',
        provider_called: false, dispatch_id: dispatchId, verification_successor: verificationSuccessor.info });
      notifyPhase('failed', { reason_code: code });
      return;
    }
    const retained = require('./forge-claude-provisional').describe(error);
    let transaction = retained?.private_ref ? failureTransactions.get(error) : null;
    if (transaction?.complete) return;
    let record = transaction?.record || JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (retained) record.provisional_terminal = retained;
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
    let failure = { status: 'adapter-failed', dispatch_id: dispatchId, reason_code: code,
      ...(retained ? { provisional_terminal: { present: true, state: retained.state, accepted: false } } : {}),
      ...(record.returned_response ? { returned_response: record.returned_response } : {}),
      ...(record.plan_task_diagnostic ? { plan_task_diagnostic: record.plan_task_diagnostic } : {}),
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
      failed_at: new Date().toISOString(), ...(replayable ? {} : (extra || {})),
      ...(admissionRefusal(error) ? { layer: 'milestone-time-admission' }
        : planGenerationRefusal(error) ? { layer: PLAN_GENERATION_STAGE } : {}) };
    if (retained?.private_ref) {
      if (!transaction) {
        transaction = { record, failure, complete: false };
        failureTransactions.set(error, transaction);
      } else failure = transaction.failure;
    }
    const failedSessionSha = sessionShaOf(null, error);
    if (failedSessionSha) record.session_sha256 = failedSessionSha;
    // Never overwrite the validated response if publication was interrupted.
    if (!replayable && !transaction?.receiptDone) {
      writeSameJson(receiptFile, { ...record, phase: 'failed', failure });
      if (transaction) transaction.receiptDone = true;
    }
    if (!transaction?.resultDone) {
      writeSameJson(resultFile, failure);
      if (transaction) transaction.resultDone = true;
    }
    if (!transaction?.captureOutcome) try {
      require('./forge-attempt-recovery').captureFailure({ stateFile: r.recoveryStateFile || `${resultFile}.recovery.json`,
        unit: `${r.unitType}/${r.taskId || r.sliceId || r.milestoneId}`, contract: r.execution_contract,
        request: r, finalEvidence: record.final_evidence, route, receiptFile, error: { ...error, provider_called: failure.provider_called },
        layer: failure.layer || detail.reason, packagedContext: record.execution?.packaged_context,
        budgets: record.execution?.budgets, durationMs: record.started_at ? Date.now() - Date.parse(record.started_at) : 0 });
      if (transaction) transaction.captureOutcome = { status: 'saved' };
    } catch (captureError) {
      if (transaction) transaction.captureOutcome = { status: 'refused', code: require('./forge-attempt-telemetry').code(captureError.code, 'recovery-capture-failed') };
      else {
        failure.recovery = 'unavailable';
        failure.recovery_reason_code = require('./forge-attempt-telemetry').code(captureError.code, 'recovery-capture-failed');
        if (!replayable) writeSameJson(receiptFile, { ...record, phase: 'failed', failure });
        writeSameJson(resultFile, failure);
      }
    }
    if (transaction?.captureOutcome?.status === 'refused') {
      // Strict recovery validation can refuse contracts such as memory-extract.
      // Preserve the original adapter error and expose the secondary refusal;
      // no recovery state or authorization is fabricated for an invalid identity.
      failure.recovery = 'unavailable';
      failure.recovery_reason_code = transaction.captureOutcome.code;
      if (!replayable) writeSameJson(receiptFile, { ...record, phase: 'failed', failure });
      writeSameJson(resultFile, failure);
    }
    if (!transaction?.cleanupDone) {
      await sessionCleanupEvent(error.session_cleanup, failedSessionSha);
      if (transaction) transaction.cleanupDone = true;
    }
    if (!transaction?.eventDone) try {
      await event('failed', code, detail, failure.provider_called,
        loc.reviewFix ? { boundary: loc.reviewFix.boundary, items_total: reviewFixItemsTotal(r) } : null, transaction);
      if (transaction) transaction.eventDone = true;
    } catch (eventError) {
      if (transaction) throw eventError;
      // Ordinary historical failures retain the existing best-effort event rule.
    }
    await appendNativeIdentity();
    if (transaction) transaction.complete = true;
    notifyPhase('failed', { reason_code: code });
  }
  // Local-only evidence, not a delivery or a replay authorization. Persist before
  // unit validation can reject a transport-normalized response and overwrite its
  // result channel. Exclusive creation prevents a later attempt replacing it.
  async function preserveReturnedResponse(result, { recordTelemetry = true } = {}) {
    const file = `${resultFile}.returned.json`;
    const envelope = { version: 1, dispatch_id: dispatchId, request_fingerprint: fingerprint,
      result, trust: 'transport-normalized; unit-validation-pending' };
    const bytes = Buffer.from(JSON.stringify(envelope, null, 2));
    writeProvisionalAnchor(file, bytes);
    // A queued owner-event append can still hold an older receipt snapshot.
    // Drain it before reading and extending the receipt, without delaying the
    // immutable response capture itself.
    await livenessQueue;
    const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    record.returned_response = { version: 1, sha256: hash(bytes), bytes: bytes.length,
      channel: 'resultFile.returned.json', unit_validation: 'pending' };
    if (recordTelemetry && result.transport_telemetry) record.telemetry = result.transport_telemetry;
    json(receiptFile, record);
  }
  function writeProvisionalAnchor(file, bytes) {
    if (!provisionalChannelActive || !fs.existsSync(file)) {
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      return;
    }
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(bytes.length)) fail('provisional-response-anchor-changed');
    const read = require('./forge-autonomy-sources').readBoundedStableFile(file, bytes.length,
      { expectedReal: fs.realpathSync.native(file) });
    const after = fs.lstatSync(file, { bigint: true });
    if (read.error || !read.buffer.equals(bytes) || ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs']
      .some(key => before[key] !== after[key])) fail('provisional-response-anchor-changed');
  }
  const existing = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  const verificationIdentity = { dispatch_id: dispatchId, fingerprint, recovery_identity_sha256: recoveryIdentity(r) };
  const verificationApi = require('./forge-verify');
  const verifySeal = record => {
    if (transport.mode !== 'execute' || !r.execution_contract) return;
    // Issue 343 U3b: a cohort member always verifies a real seal bound to its current runtime view.
    if (member) return verifyMemberSeal(r, record, verificationIdentity, runtime.verification, member.view());
    if (record.verification_successor || verificationSuccessor) {
      if (!verificationSuccessor) fail('verification-successor-capability-required');
      verificationSuccessor.assertRecord(record);
    }
    if (!record.verification_seal) {
      if (!nativeExecution && runtime.verification === undefined) return;
      // Only a completed successful legacy capture can stand in for its absent seal.
      // Failed captures are retained for diagnosis and still require sealed policy.
      if (record.delivery_capture?.passed !== true || runtime.verification !== undefined) fail('verification-provenance-insufficient');
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
    validateRecoveryRequest(r, { verification: runtime.verification, nativeInvocation: validateNativeExecutionBinding(r, runtime) });
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
  // The extracted completion core with this attempt's single context (its exact previous behavior).
  // A cohort member never completes here: it is retained, and verified only after the barrier.
  async function completeExecution(record, deferredEvents = null) {
    if (member) fail('batch-member-operation-unsupported');
    return completeExecutionCore({ request: r, loc, root, cwd, receiptFile, verificationIdentity, verificationSuccessor,
      successorCapability: runtime.verificationSuccessor, member: null, verifySeal, notifyPhase, appendOwnedEvents,
      onVerificationCheck: runtime.onVerificationCheck }, record, deferredEvents);
  }
  // Issue 343 U3b: the retained result of a cohort member (never a done delivery) on its channel.
  function retainedResult(stage, retained, providerCalled) {
    const result = { status: 'retained', stage, dispatch_id: dispatchId, batch_id: retained.batch_id, member_ref: retained.member_ref,
      task_id: retained.task_id, retained_ref: { path: retained.ref_path, sha256: retained.ref_sha256 },
      anchor_sha256: retained.anchor.sha256, provider_called: providerCalled };
    json(resultFile, result);
    notifyPhase('waiting');
    return result;
  }
  // Issue 343 U3b: a finished cohort member is retained as its executed record plus its real seal:
  // the exact executed bytes (copied immutably) and the RetainedRef in the cohort batch area, bound
  // by the broker's single anchor of the attempt once its attached writer joined. No .gsd artifact,
  // task marker, controller completion, owner event or done result; returned.json stays custody.
  async function retainExecuted(record, telemetry = null, providerCalled = true) {
    verifySeal(record);
    assertMemberModes(r, record);
    const bytes = fs.readFileSync(receiptFile);
    if (!bytes.equals(Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8')) || record.phase !== 'executed'
        || !record.milestone_delivery || !record.recovery_baseline) fail('batch-member-executed-changed');
    const response = record.returned_response, responseFile = `${resultFile}.returned.json`;
    if (!response || !fs.existsSync(responseFile) || hash(fs.readFileSync(responseFile)) !== response.sha256) fail('batch-member-response-changed');
    const digest = require('./forge-code-roots').digest;
    const retained = await member.retain({ executed: bytes, response: { path: responseFile, sha256: response.sha256 },
      seal_sha256: record.verification_seal.sha256, baseline_sha256: digest(record.recovery_baseline),
      delta_sha256: digest({ verified_files: record.milestone_delivery.verified_files,
        verified_modes: record.milestone_delivery.verified_modes, code_state: record.milestone_delivery.code_state }) });
    if (telemetry) await sessionCleanupEvent(telemetry.session?.cleanup, sessionShaOf(telemetry));
    return retainedResult('executed', retained, providerCalled);
  }
  // Issue 343 U3b: the replay of a cohort member respects the barrier. A saved executed record is
  // revalidated and stays (or, saved before its retention completed, becomes) the retained
  // execution; a verified ready record stays unpublished. Zero provider calls, no completion.
  async function replayRetainedMember(saved) {
    verifySeal(saved);
    await runtime.announce?.('reaproveitado', { ...identity, provider_called: false });
    const retained = await member.retained();
    if (retained && !sameExecutedBase(saved, retained.executed_record)) fail('batch-member-retained-changed');
    if (saved.phase === 'ready') {
      if (!retained) fail('batch-member-retained-required');
      await assertRetainedReady({ request: r, loc, root, cwd, receiptFile, verificationIdentity, verificationSuccessor: null,
        member, markerChain: member.markerChain(taskMarkerPath(r)), verifySeal, notifyPhase, appendOwnedEvents }, saved, retained);
      return retainedResult('ready', retained, false);
    }
    assertMilestoneDeliveryReplay(r, saved);
    if (retained) return retainedResult('executed', retained, false);
    if (member.barrierSealed()) fail('batch-member-retained-required');
    await member.verifyOwner('execution');
    return retainExecuted(saved, null, false);
  }
  if (existing) {
    if (existing.fingerprint !== fingerprint && !(memoryContract && (legacyMemoryReceipt(existing, legacyFingerprint)
        || historicalV2MemoryReceipt(existing, r, loc.sourceUnit, legacyFingerprint)))) {
      fail('dispatch-identity-conflict');
    }
    // Issue 343 U3b: a cohort member's saved delivery record replays only as its retention.
    if (member && existing.milestone_delivery && (existing.phase === 'executed' || existing.phase === 'ready')) {
      return await replayRetainedMember(existing);
    }
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
      if (nativeExecution) validateRecoveryRequest(r, { verification: runtime.verification, nativeInvocation: validateNativeExecutionBinding(r, runtime) });
      verifySeal(existing);
      assertNativePublication(existing);
      try {
        const ready = existing.phase === 'executed' ? await completeExecution(existing) : existing;
        const result = await publish(ready, () => assertNativePublication(ready));
        json(resultFile, result);
        completed(result);
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
      validateRecoveryRequest(r, { verification: runtime.verification, nativeInvocation: validateNativeExecutionBinding(r, runtime) });
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
      const result = await publish(ready, () => {
        require('./forge-recovery-transition').assertWriterObservation(publicationWriter);
        assertAccepted();
      });
      await appendOwnedEvents(deferredEvents, ready);
      json(receiptFile, ready);
      json(resultFile, result);
      await event(result.status, 'saved-native-result-accepted', null, existing.final_evidence?.provider_called ?? 'unknown');
      completed(result);
      return result;
    }
    if (existing.phase === 'failed') {
      runtime.announce?.('reaproveitado', { ...identity, reason_code: existing.failure?.reason_code, provider_called: false });
      const error = new Error('Recorded sidecar attempt failed; no provider was relaunched.');
      error.code = existing.failure.reason_code;
      error.diagnostic = diagnostic(existing.failure.diagnostic?.reason, existing.failure.diagnostic);
      json(resultFile, existing.failure);
      // Follows the failure event recorded by the attempt itself; nothing is relaunched.
      notifyPhase('failed', { reason_code: existing.failure.reason_code });
      throw error;
    }
    fail('sidecar-attempt-interrupted', 'Inspect the recorded heartbeat/process and recover this attempt before retrying with a new dispatch id. No worker was relaunched.');
  }
  // #350: after saved-receipt replay, before owner reads, receipt, announce and provider: a Codex
  // read-only artifacts profile that cannot receive its inputs is refused (identity only, no prompt).
  require('./forge-transport-capabilities').assertReadOnlyArtifactContext({ engine: route.resolved_worker_engine, workerMode: route.worker_mode, mode: transport.mode, scope: r.scope, phase: r.phase, unitType: r.unitType });
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
  // Review-fix: boundary and claim are validated here (write-free); the policy
  // admission and then the surgical-reset state follow the permission checks,
  // all BEFORE the started receipt. A refusal leaves no receipt and never
  // reaches a provider.
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
      // Owner-captured estimate source manifest (T06 supplies it); verified by the renderer, never worker data.
      ...(r.unitType === 'estimate-milestone' && r.producerBasis != null ? { producerBasis: r.producerBasis } : {}),
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
  const claudeWriter = route.resolved_worker_engine === 'claude' && ['execute', 'fix'].includes(transport.mode);
  const permissionRequested = r.claudePermissions !== undefined;
  if (claudeWriter && transport.mode === 'fix' && r.verification !== undefined && !permissionRequested) fail('claude-verification-permission-required');
  if (permissionRequested && (r.claudePermissions !== 'verification' || !claudeWriter || !r.execution_contract)) fail('claude-permission-policy-invalid');
  // Issue 343 U3b: a cohort member's seal and permission policy bind the runtime view its handle
  // validated (the original plan hash stays); the multiroot Claude refusal is unchanged.
  const memberViewOption = member ? { memberView: member.view() } : {};
  const verificationSeal = r.execution_contract && transport.mode === 'execute'
    ? preflightExecutionVerification(r, { verification: runtime.verification, identity: verificationIdentity, ...memberViewOption })
    : r.execution_contract && transport.mode === 'fix' && permissionRequested
      ? verificationApi.normalizeExecutionVerification(r.execution_contract, '', r.verification, runtime.verification, verificationIdentity) : null;
  // Resolve permissions before creating a receipt or entering a transport.
  // Legacy requests without a root contract gain no shell permission.
  const permissionPolicy = permissionRequested && verificationSeal
    ? require('./forge-claude-permissions').createPolicy({ seal: verificationSeal, contract: r.execution_contract, identity: verificationIdentity, cwd,
      ...memberViewOption }) : null;
  // Review-fix policy admission (last gate), then the reset state.
  if (fix) {
    admitReviewFix(r, loc, fix, { root, dispatchId });
    createReviewFixResetState(fix, { dispatchId });
  }
  // Issue 343 U0c: a new milestone plan-slice attempt records the owner's requirement
  // marker in its started receipt; an invalid begin enrollment refuses before any receipt.
  const planGeneration = transport.mode === 'plan'
    ? buildPlanGenerationMarker(r, { fingerprint, dispatchId, root, begin: planGenerationBegin(r, runtime, root) }) : null;
  const startedAt = new Date().toISOString();
  // Exclusive creation arbitrates concurrent invocations of the same attempt.
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'started', fingerprint, dispatch_id: dispatchId, before, started_at: startedAt,
    recovery_identity_sha256: recoveryIdentity(r), route, ...(verificationSeal ? { verification_seal: verificationSeal } : {}),
    ...(planGeneration ? { plan_generation: planGeneration } : {}),
    ...(resumedFrom ? { resumed_from: resumedFrom, session_sha256: resumeSessionSha } : {}),
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
    transport: nativeExecution ? 'native-tool' : route.resolved_worker_engine === 'claude' ? 'claude-cli' : 'app-server',
  }, route, startedAt);
  // Issue 343 U3b: a cohort member's dispatch event is the canonical member builder's, signed by
  // the cohort broker (its cohort fields come from the broker registry, its route is its own).
  if (member) await member.appendDispatch({ unit: label, milestone: r.milestoneId, slice: r.sliceId, dispatchId, model,
    engine: route.resolved_worker_engine, transport: route.resolved_worker_engine === 'claude' ? 'claude-cli' : 'app-server' }, route, startedAt);
  else if (r.ownerBroker) await require('./forge-artifact-reconciliation').assertBroker(r.ownerBroker).append('.gsd/forge/events.jsonl', JSON.stringify(dispatchEvent) + '\n');
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
  let finishContinuation = null;
  const options = { enterTransport: () => { enterTransport(); transportEntered = true; }, cwd, contextRoot: root, engine: route.resolved_worker_engine,
    permissionPolicy, permissionIdentity: permissionPolicy ? verificationIdentity : undefined,
    unitType: r.unitType,
    calibrationOptions: runtime.calibrationOptions,
    provisionalStoreRoot: runtime.provisionalStoreRoot,
    onProgress: snapshot => {
      const safe = require('./forge-sidecar-calibration').observation(snapshot);
      const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (saved.phase === 'started') json(receiptFile, { ...saved,
        telemetry: { ...saved.telemetry, observation: safe } });
      if (typeof runtime.onObservation === 'function') {
        try { runtime.onObservation(safe); } catch { /* observer errors never affect the unit */ }
      }
      if (runtime.onProgress) return runtime.onProgress(safe);
      if (require.main === module) process.stderr.write(require('./forge-sidecar-calibration').progressLine(safe));
    },
    // Owner-side liveness: the no-progress event goes through appendOwnedEvent;
    // the unit's own result/receipt channel never counts as local progress
    // (prefix match also covers .reset-state.json and .recovery.json).
    onLiveness, localProofIgnore: [resultFile, receiptFile],
    telemetryIdentity: r, telemetryRoute: route, budgets: execution?.budgets || r.budgets || {},
    onPackagedContext: packaged => {
      const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      json(receiptFile, { ...saved, final_evidence: packaged.final_evidence,
        ...(saved.execution ? { execution: { ...saved.execution, packaged_context: packaged } } : {}) });
      const observed = runtime.onPackagedContext?.(packaged);
      // Packaging admission remains useful, but Claude still prepares provisional
      // retention and calibration afterwards. Its final spawn hook rechecks the same
      // live owner boundary after all of that work, immediately before spawn.
      admitFinalLaunch();
      return observed;
    },
    onBeforeSpawn: admitFinalLaunch,
    hostRuntime: route.host_runtime, sidecarDeclared: true, model,
    effort: route.effort, timeoutSecs: ceilingFromRoute(route).seconds, resultFile, dispatchId,
    constraints: r.constraints || { auto_commit: false, deploy: false },
    signal: r.signal, announce, identity: { phase: identity.phase, unit: identity.unit, dispatch_id: dispatchId,
      model_resolved: identity.model_resolved },
    // Defense in depth behind the resolver refusal: the Claude CLI adapter
    // refuses a thinking mode it has no documented argument for.
    ...(route.thinking_requested ? { thinkingRequested: route.thinking_requested } : {}),
    ...(claudeSession ? { claudeSession } : {}),
  };
  const heartbeat = pid => {
    if (Number.isInteger(pid) && pid > 0) {
      announce('iniciado', { ...identity, pid, provider_called: 'unknown' });
    }
    json(resultFile, { status: 'running', pid, adapter_pid: process.pid,
      heartbeat_interval_ms: 15000, started_at: startedAt, updated_at: new Date().toISOString(), dispatch_id: dispatchId });
  };
  async function finalizeUnitResult(result, artifacts, transportTelemetry = null) {
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
        memory_contract: { schema_version: NEW_MEMORY_SCHEMA_VERSION, source_binding: 'source-only-v1', evidence: memoryContract },
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
    const previous = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    // Issue 343 U0c: the plan marker and evidence come only from this owner's receipt,
    // never from the generic spread of a returned result.
    if (transport.mode === 'plan') for (const key of PLAN_OWNER_FIELDS) {
      if (Object.hasOwn(previous, key)) record[key] = previous[key]; else delete record[key];
    }
    if (previous.provisional_replay) record.provisional_replay = previous.provisional_replay;
    if (transportTelemetry) record.telemetry = {...record.telemetry, observation: transportTelemetry.observation ? require('./forge-sidecar-calibration').observation(transportTelemetry.observation) : null};
    if (transportTelemetry?.calibration_proposal) record.calibration_proposal = transportTelemetry.calibration_proposal;
    if (sessionShaOf(transportTelemetry)) record.session_sha256 = sessionShaOf(transportTelemetry);
    const finalEvidence = JSON.parse(fs.readFileSync(receiptFile, 'utf8')).final_evidence;
    if (finalEvidence) record.final_evidence = { ...finalEvidence, stage: 'returned', provider_called: true,
      duration_ms: Date.now() - Date.parse(startedAt), model_observed: observedModel.model_observed || null };
    // Durable validated response BEFORE artifact publication: a crash anywhere
    // after here replays publication, without spending another provider turn.
    json(receiptFile, record);
    result = await publish(record);
    json(resultFile, result);
    await sessionCleanupEvent(transportTelemetry?.session?.cleanup, sessionShaOf(transportTelemetry));
    if (transport.mode !== 'memory') {
      await event(result.status, null, null, true, fix ? { boundary: loc.reviewFix.boundary, items_total: result.items.length,
        items_fixed: result.items.filter(item => item.verified).length, commit_sha: result.commit_sha,
        effort_sent: result.telemetry ? result.telemetry.effort_sent : null } : null);
    }
    completed(result);
    return result;
  }
  function registerContinuation(error, finish) {
    const api = require('./forge-claude-provisional');
    const parentResult = resultFile, parentReceipt = receiptFile;
    const originEventHash = ownedEventsHash(JSON.parse(fs.readFileSync(parentReceipt, 'utf8')));
    let parent = null, derived = null, initial = null;
    api.setPreparation(error, async metadata => {
      if (!parent) {
        if (resultFile !== parentResult || receiptFile !== parentReceipt) fail('provisional-parent-channel-changed');
        const first = JSON.parse(fs.readFileSync(parentReceipt, 'utf8'));
        const from = originEventHash || ownedEventsHash(first);
        await recordFailure(error);
        const failed = JSON.parse(fs.readFileSync(parentReceipt, 'utf8')), to = ownedEventsHash(failed);
        if (from && to && from !== to) livenessEventAdvance = { from: livenessEventAdvance?.from || from, to };
        parent = { receipt: fileHash(parentReceipt), result: fileHash(parentResult), failed };
      }
      if (fileHash(parentReceipt) !== parent.receipt || fileHash(parentResult) !== parent.result) fail('provisional-original-history-changed');
      const current = transport.mode === 'memory' ? memoryRequestFingerprint(artifactFingerprint(r), memoryEvidenceContract(r, loc.sourceUnit)) : artifactFingerprint(r);
      if (current !== fingerprint) fail('provisional-owner-refused');
      runtime.assertRecoveryAuthority?.();
      validateRecoveryRequest(r, { verification: runtime.verification });
      if ((r.pending_questions || []).some(question => question.status !== 'resolved')) fail('pending-human-decision');
      if (r.linked_begin_key) require('./forge-attempt-recovery').bindLinkedRequest(r, runtime.linkedEntryOptions);
      derived ||= parentResult + '.provisional-' + metadata.id + '.json';
      publicationRequest = { ...r, resultFile: derived };
      const channels = artifactAttemptFiles(publicationRequest);
      if (!initial) {
        const { failure, provisional_terminal, ...kept } = parent.failed;
        initial = JSON.stringify({ ...kept, phase: 'started', provisional_replay: {
          parent_receipt_sha256: parent.receipt, parent_result_sha256: parent.result,
          inference_performed: false, provisional_id: metadata.id } }, null, 2) + '\n';
      }
      if (!fs.existsSync(channels.receiptFile)) fs.writeFileSync(channels.receiptFile, initial, { flag: 'wx', mode: 0o600 });
      const saved = JSON.parse(fs.readFileSync(channels.receiptFile, 'utf8'));
      if (saved.fingerprint !== fingerprint || saved.provisional_replay?.provisional_id !== metadata.id
        || saved.provisional_replay.parent_receipt_sha256 !== parent.receipt) fail('provisional-derived-channel-changed');
      resultFile = channels.resultFile; receiptFile = channels.receiptFile;
      provisionalChannelActive = true;
      return { resultFile, replayReady: ['executed', 'ready'].includes(saved.phase) };
    });
    api.addFinalizer(error, async (value, metadata) => {
      const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (['executed', 'ready'].includes(saved.phase)) return runUnitSidecar(publicationRequest, runtime);
      return finish(value);
    });
  }
  try {
    // Only the process that acquired the exclusive receipt may capture/reset
    // this attempt's durable baseline. A concurrent caller cannot overwrite it.
    // Milestone execution uses the execute adapter too. Its internal audit
    // snapshot is not the caller's durable recovery authority.
    if (transport.mode === 'execute') {
      const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      const baseline = captureMilestoneBaseline(r, saved, { nativeInvocation: nativeBinding, ...(member ? { member } : {}) });
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
      const memoryValidation = { sourceUnit: loc.sourceUnit, schemaVersions: MEMORY_RESPONSE_VERSIONS, evidence: memoryContract };
      const validateMemory = value => {
        try { require('./forge-memory-extraction').validateExtractionResult(value, memoryValidation); return true; }
        catch { return false; }
      };
      async function finishMemory(output) {
        transportReturned = true;
        await livenessQueue;
        const checked = require('./forge-memory-extraction').validateExtractionResult(output.candidate, memoryValidation);
        xllm.assertUntrustedOutputBarrier(checked);
        return finalizeUnitResult(checked, [], output.telemetry || null);
      }
      finishContinuation = finishMemory;
      announce('solicitado', { ...identity, provider_called: false });
      xllm.authorizeSidecar('memory', options);
      heartbeat(null);
      if (options.engine === 'claude') {
        enterTransport();
        transportEntered = true;
        const output = await xllm.invokeClaudeTransport({ ...options, prompt, resultProfile:'memory', resultSchema:memoryTransportSchema, calibrationPhase:'memory',
          readOnly: true, validateCandidate: validateMemory, onHeartbeat: heartbeat,
          heartbeatIntervalMs: 15000, terminateChild: xllm.terminateOwnedProcessTree });
        transportReturned = true;
        await livenessQueue;
        result = output.candidate;
        transportTelemetry = output.telemetry || null;
      } else {
        enterTransport();
        transportEntered = true;
        const output = await xllm.invokeCodexAppServer({ ...options, prompt, schema: memoryTransportSchema,
          sandbox: 'read-only', onHeartbeat: heartbeat });
        transportReturned = true;
        await livenessQueue;
        result = xllm.extractLastJsonBlock(output.finalText || output.agentTexts);
      }
      return await finishMemory({ candidate: result, telemetry: transportTelemetry });
    } else if (transport.mode === 'execute') {
      const procedure = executeProcedure;
      const { content: procedureText, ...procedure_context } = procedure;
      if (r.prompt) require('./forge-prompt').composeProcedurePrompt(r.prompt, procedure, r.procedure_context);
      const protectedBefore = execution ? executionApi.protectedSnapshot(root) : null;
      const codeProtectedBefore = execution ? execution.execution_contract.code_roots.map(code => ({ root: code.path,
        before: executionApi.protectedSnapshot(code.path) })) : [];
      if (!nativeExecution) { enterTransport(); transportEntered = true; }
      // Shared write-contract validation runs inside runExecute, before this unit
      // can advance its snapshots: hand it the exact authenticated owner append.
      const eventsBeforeTransport = fileHash(eventsFile);
      const reconcileProtectedChanges = async changes => {
        await livenessQueue;
        const key = '.gsd/forge/events.jsonl';
        const contract = execution?.execution_contract || r.execution_contract;
        if (!contract || !livenessEventAdvance || eventsBeforeTransport !== livenessEventAdvance.from
            || fileHash(eventsFile) !== livenessEventAdvance.to) return changes;
        const ownerIds = new Set(contract.code_roots
          .filter(code => fs.realpathSync(code.path) === root).map(code => code.id));
        return changes.filter(entry => !(entry.path === key && ownerIds.has(entry.root_id)));
      };
      async function finishExecute(result) {
        let artifacts;
      transportReturned = true;
      await livenessQueue;
      transportTelemetry = result.transport_telemetry || null;
      const trustedTransportRecord = transportTelemetry ? {
        telemetry: { ...observedModelTelemetry(transportTelemetry),
          observation: require('./forge-sidecar-diagnostic').observation(transportTelemetry.observation) },
        ...(transportTelemetry.calibration_proposal ? { calibration_proposal: transportTelemetry.calibration_proposal } : {}),
        ...(sessionShaOf(transportTelemetry) ? { session_sha256: sessionShaOf(transportTelemetry) } : {}),
      } : {};
      if (execution) {
        advanceLivenessEvents(protectedBefore);
        for (const code of codeProtectedBefore) if (fs.realpathSync(code.root) === root) advanceLivenessEvents(code.before);
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
        result = await publish(ready, () => { assertNativePublication(ready); options.assertNativePublication?.(); });
        json(resultFile, result);
        await sessionCleanupEvent(transportTelemetry?.session?.cleanup, sessionShaOf(transportTelemetry));
        await event(result.status, null, null, true);
        await appendNativeIdentity();
        completed(result);
        return result;
      }
      if (r.execution_contract && result.status === 'done') {
        // Retain the returned object privately before integrity checks can refuse it;
        // receipts gain only the hash reference. Not an acceptance or replay source.
        await preserveReturnedResponse(result, { recordTelemetry: false });
        const api = require('./forge-task-execution');
        const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        // Issue 343 U3b: a cohort member's owner surface is the cohort's common signed stream (S0
        // and every sibling's signed append, through the broker), which also revalidates its seam.
        if (member) await member.verifyOwner('execution');
        else api.assertProtected(root, saved.recovery_baseline.protected_owner);
        for (const entry of saved.recovery_baseline.protected_roots) api.assertProtected(entry.path, entry.snapshot);
        const roots = require('./forge-code-roots');
        const baseline = saved.recovery_baseline;
        const state = require('./forge-surgical-reset').readState(baseline.state_file);
        if (baseline.state_sha256 !== baselineDigest(state)) fail('recovery-baseline-binding');
        if (baseline.input.sha256 !== roots.digest(fs.readFileSync(baseline.input.path))) fail('execution-input-changed');
        // A cohort member's claims are its validated runtime view of the canonical plan.
        const checked = member ? member.view().checked_runtime_plan : roots.validatePlan(fs.readFileSync(r.planFile, 'utf8'), r.execution_contract);
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
            ...(member ? { verified_modes: captureMemberModes(r, verifiedFiles) } : {}),
            protected_owner: member ? null : api.protectedSnapshot(root),
            protected_roots: saved.recovery_baseline.protected_roots,
            code_state: api.replayState(cwd, r.execution_contract) },
          result: { ...result, dispatch_id: dispatchId, workflow_id: r.workflowId,
            host_runtime: route.host_runtime, worker_engine: options.engine } };
        json(receiptFile, executed);
        // Issue 343 U3b: a cohort member stops here, retained executed plus seal. Its heavy
        // verification, publication and completion exist only after the cohort barrier.
        if (member) return await retainExecuted(executed, transportTelemetry);
        const ready = await completeExecution(executed);
        result = await publish(ready, () => { assertNativePublication(ready); options.assertNativePublication?.(); });
        json(resultFile, result);
        await sessionCleanupEvent(transportTelemetry?.session?.cleanup, sessionShaOf(transportTelemetry));
        await event(result.status, null, null, true);
        completed(result);
        return result;
      }
      artifacts = executeDeliveryArtifacts(r, loc, result, root, cwd);
        return finalizeUnitResult(result, artifacts, result.transport_telemetry || null);
      }
      finishContinuation = finishExecute;
      result = nativeExecution ? await runNativeExecutionTransport(r, runtime, execution,
        { ...options, captureLateNativeResult: preserveReturnedResponse, recordNativeIdentity: fields => { nativeIdentity = fields; } },
        procedure) : await xllm.runExecute({ ...options, reconcileProtectedChanges, scope: r.scope, planFile: r.planFile, securityFile: r.securityFile,
        contextFile: r.contextFile, writableRoots: execution ? execution.writableRoots
          : r.execution_contract ? r.execution_contract.code_roots.filter(code =>
            require('./forge-code-roots').key(fs.realpathSync.native(code.path)) !==
            require('./forge-code-roots').key(fs.realpathSync.native(cwd))).map(code => code.path) : r.writableRoots,
        executionContext: execution || (r.execution_contract
          ? { execution_contract: r.execution_contract, budgets: r.budgets || {} } : undefined),
        procedureContext: { procedureText, procedure_context } });
      return await finishExecute(result);
    } else if (transport.mode === 'plan') {
      if (!r.promptFile) fail('prompt-file-required');
      // runPlan consumes a file: pass only the validated composed snapshot,
      // never reread the caller's mutable original after preflight.
      async function finishPlan(result) {
        transportReturned = true;
        await preserveReturnedResponse(result);
        await livenessQueue;
        let artifacts;
      const ids = result.task_plans.map(p => p.id);
      if (new Set(ids).size !== ids.length) fail('plan-task-ids-invalid');
      const listed = require('./forge-status').parsePlanTasks(result.slice_plan.content).map(t => t.id);
      if (JSON.stringify([...listed].sort()) !== JSON.stringify([...ids].sort())) {
        const safe = values => values.filter(v => typeof v === 'string' && v.length <= 64 && /^T\d+(?:\.\d+)?$/.test(v)).slice(0, 100);
        const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        record.plan_task_diagnostic = { listed_count: listed.length, returned_count: ids.length,
          listed_ids: safe(listed), returned_ids: safe(ids), truncated: listed.length > 100 || ids.length > 100 };
        json(receiptFile, record);
        fail('plan-task-list-mismatch');
      }
      artifacts = [{ path: loc.required[0], content: result.slice_plan.content },
        ...result.task_plans.map(p => {
          if (!/^T\d+(?:\.\d+)?$/.test(p.id)) fail('plan-task-ids-invalid');
          const legacy = target(root, `${loc.slice}/tasks/${p.id}-PLAN.md`);
          if (fs.existsSync(legacy)) fail('legacy-task-plan-conflict', 'Migrate the explicitly selected legacy plan before publishing a second source.');
          return { path: `${loc.slice}/tasks/${p.id}/${p.id}-PLAN.md`, content: p.content };
        })];
        if (result.status === 'done') recordPlanValidation(result);
        return finalizeUnitResult(result, artifacts, result.transport_telemetry || null);
      }
      // Issue 343 U0c: the returned bytes (already preserved above) are admitted again,
      // independently of the transport, under the trusted scope; the receipt then gains
      // plan_validation from those exact bytes and its own marker, before the ready record.
      // The evidence is deterministic, so a continuation that reenters after it was saved
      // reproduces it exactly; any other prior evidence refuses.
      function recordPlanValidation(result) {
        for (const key of PLAN_OWNER_FIELDS) {
          if (Object.hasOwn(result, key)) planRefusal('plan-generation-marker-untrusted', `the returned result carries ${key}`, { provider_called: true });
        }
        const saved = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        if (!Object.hasOwn(saved, 'plan_generation')) planRefusal('plan-generation-marker-missing', 'the started receipt carries no plan_generation', { provider_called: true });
        const marker = verifyPlanGenerationMarker(saved.plan_generation, r, saved, root);
        const admission = admitReturnedPlan(r, root, result.slice_plan.content, result.task_plans, { provider_called: true });
        const evidence = buildPlanValidationEvidence(marker, admission);
        if (Object.hasOwn(saved, 'plan_validation')) {
          if (canonicalDigest(saved.plan_validation) !== canonicalDigest(evidence)) {
            planRefusal('plan-validation-invalid', 'the receipt already carries other plan_validation evidence', { provider_called: true });
          }
          return;
        }
        saved.plan_validation = evidence;
        json(receiptFile, saved);
      }
      finishContinuation = finishPlan;
      const promptDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-plan-procedure-'));
      try {
        const planContextFile = path.join(promptDir, 'context.md');
        fs.writeFileSync(planContextFile, deliveryPrompt, { mode: 0o600 });
        enterTransport();
        transportEntered = true;
        result = await xllm.runPlan({ ...options, planContextFile });
      } finally { fs.rmSync(promptDir, { recursive: true, force: true }); }
      return await finishPlan(result);
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
      async function finishArtifacts(output) {
        transportReturned = true;
        await livenessQueue;
        let result = output.candidate, artifacts;
      const verdict = inspectArtifacts(result, loc.allowed, loc.required, payloadLimit, loc.rules,
        { forbidArtifactsOnNonDone: loc.preparation === true, detailedDeliveryDiagnostic: true });
      if (!verdict.ok) {
        const error = new Error('Invalid artifact result.');
        error.code = 'invalid-artifact-result';
        // The closed diagnostic vocabulary has no time-rule entries: keep them validation failures, never adapter ones.
        error.diagnostic = diagnostic(/^typed-milestone-/.test(verdict.reason) ? 'delivery-artifact-invalid' : verdict.reason);
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
          writeProvisionalAnchor(`${receiptFile}.response-anchor.json`, Buffer.from(JSON.stringify(responseAnchor) + '\n'));
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
        return finalizeUnitResult(result, artifacts, output.telemetry || null);
      }
      finishContinuation = finishArtifacts;
      announce('solicitado', { ...identity, provider_called: false });
      xllm.authorizeSidecar('artifacts', options);
      heartbeat(null);
      if (options.engine === 'claude') {
        enterTransport();
        transportEntered = true;
        const output = await xllm.invokeClaudeTransport({ ...options, prompt, resultProfile:loc.preparation?'preparation':'artifacts', resultSchema:schema, calibrationPhase:sessionPhase === 'plan' ? 'plan' : r.phase || 'artifacts',
          ...(options.claudeSession ? { session: options.claudeSession } : {}),
          readOnly: true, validateCandidate: value => inspectArtifacts(value, loc.allowed, loc.required, payloadLimit, loc.rules,
            { forbidArtifactsOnNonDone: loc.preparation === true, detailedDeliveryDiagnostic: true }), onHeartbeat: heartbeat,
          heartbeatIntervalMs: 15000, terminateChild: xllm.terminateOwnedProcessTree });
        transportReturned = true;
        await livenessQueue;
        result = output.candidate;
        transportTelemetry = output.telemetry || null;
      } else {
        enterTransport();
        transportEntered = true;
        const output = await xllm.invokeCodexAppServer({ ...options, prompt, schema, sandbox: 'read-only', onHeartbeat: heartbeat });
        transportReturned = true;
        await livenessQueue;
        result = xllm.extractLastJsonBlock(output.finalText || output.agentTexts);
      }
      return await finishArtifacts({ candidate: result, telemetry: transportTelemetry });
    } else if (transport.mode === 'fix') {
      // Scoped writing turn through the shared execute safety core. The worker
      // never commits; outside-claim, .gsd and a moved baseline are named failures.
      enterTransport();
      transportEntered = true;
      result = await xllm.runFix({ ...options, brief: fix.brief, writableRoots: r.writableRoots });
      transportReturned = true;
      partialFixResult = ['partial', 'blocked'].includes(result?.status);
      await preserveReturnedResponse(result);
      await livenessQueue;
      // A partial/blocked turn never publishes a success line or a commit.
      if (result.status !== 'done') fail(`review-fix-worker-${result.status}`, 'The review-fix worker did not finish; items are deferred.');
      artifacts = [];
    } else fail('unsupported-sidecar-unit', 'Use forge-xllm review modes for this review contract.');
    return await finalizeUnitResult(result, artifacts, transportTelemetry);
  } catch (error) {
    // A transport failure can leave a queued liveness append: settle it before
    // the failed receipt and the terminal event are written.
    await livenessQueue;
    // The Claude adapter rewraps any exception of its packaging step (where the last launch hook
    // runs, before its owned child) as its prompt I/O code. When this attempt's own hook refused,
    // that wrap reports no prompt I/O failure: the original typed refusal (code, provider_called
    // false, stage, layer) is restored. A prompt I/O failure without a recorded refusal stays as is.
    if (packagingRefusal && error !== packagingRefusal && error?.provider_called !== true
        && error?.code === require('./forge-claude-sidecar').CLAUDE_SIDECAR_REASON_CODES.PROMPT_IO) error = packagingRefusal;
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
      reconciliation_required: providerCalled !== false }
      : (admissionRefusal(error) || planGenerationRefusal(error)) && transport.mode === 'execute' && providerCalled === false
        ? { possible_writes: false, reconciliation_required: false } : null;
    const phase = fix ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')).phase : null;
    if (fix && phase !== 'ready') {
      // Only an attempt that never reached a durable validated result is reset;
      // a ready receipt keeps the worker's verified changes for replay. A refused
      // Claude model identity is the exception: the tree (new files included) is
      // left exactly as the worker left it for the operator, never reset.
      const identityRefused = typeof error.code === 'string' && error.code.startsWith('claude-model-');
      let partialPatch = null, archiveUnavailable = false;
      if (partialFixResult && !identityRefused) {
        try {
          const preserved = require('./forge-review-fix-archive').preservePartialPatch({
            request: r, state: fix, fingerprint, assertStopped: () => transportReturned === true });
          preserved.assertCurrent();
          partialPatch = preserved.reference;
        } catch {
          archiveUnavailable = true;
          partialPatch = { schema_version: 1, status: 'unavailable-tree-preserved', complete: false };
        }
      }
      const reset = identityRefused
        ? { verified: false, reason_code: 'identity-refused-preserved', restored: 0, removed: 0, overlap: [] }
        : archiveUnavailable
        ? { verified: false, reason_code: 'partial-patch-unavailable-preserved', restored: 0, removed: 0, overlap: [] }
        : resetReviewFixAttempt(r, fix);
      const terminalSafetyFailure = identityRefused
        || ['review-fix-protected-metadata', 'review-fix-baseline-moved'].includes(error.code);
      const publicationError = publishReviewFixFailure(r, loc, fix.items, fix.reviewSnapshot);
      extra = { reset, items: fix.items.map(item => ({ r: item.r, ...(item.review_file ? { review_file: item.review_file } : {}), outcome: 'failed', verified: false, commit_sha: null })),
        ...(partialPatch ? { partial_patch: partialPatch } : {}),
        ...(publicationError ? { publication_error: publicationError } : {}),
        ...(error.outside ? { outside_claim: { count: error.outside.length, paths: error.outside } } : {}),
        recovery: reset.overlap.length || !reset.verified || terminalSafetyFailure ? 'operator-required' : 'items-deferred' };
    }
    const retained = require('./forge-claude-provisional').describe(error)?.private_ref && typeof finishContinuation === 'function' && !fix;
    if (retained) registerContinuation(error, finishContinuation);
    try { await recordFailure(error, extra); }
    catch (secondary) {
      if (!retained) throw secondary;
      error.provisional_handoff = { status: 'pending', reason_code: 'failure-handoff-unavailable',
        secondary_code: require('./forge-attempt-telemetry').code(secondary.code, 'unknown') };
    }
    throw error;
  }
}

// Validate the review-fix request against the claim the parent can re-derive.
// Write-free: the surgical-reset state is created only after the admission.
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

// review-fix-policy-v1 admission: the last gate after validation and the
// permission/seal checks, before the reset state, the started receipt, the
// events and the provider. Replay and recovery return the recorded decision
// without a new cycle. A refusal leaves no receipt: the affected items get the
// deferral line (snapshot guarded) and the error carries the named code.
function admitReviewFix(request, loc, fix, context) {
  const reviewFix = require('./forge-review-fix');
  const decision = require('./forge-review-policy').admitCorrection({ owner: context.root,
    ...reviewFix.admissionScope(request, loc.reviewFix.boundary), dispatch_id: context.dispatchId, brief: fix.brief,
    items: request.reviewFix.items, ...(request.reviewFixRecoveryOf !== undefined ? { recovery_of: request.reviewFixRecoveryOf } : {}) });
  if (decision.allowed) return decision;
  throw reviewFix.correctionAdmissionError({
    request, decision,
    expectedHashes: fix.reviewSnapshot,
  });
}

function createReviewFixResetState(fix, context) {
  require('./forge-surgical-reset').initState(fix.stateFile, { cwd: fix.cwd, attempt: context.dispatchId, repoRoots: fix.repoRoots });
  return fix;
}

function reviewFixItemsTotal(request) {
  return request.reviewFix && Array.isArray(request.reviewFix.items) ? request.reviewFix.items.length : 0;
}
// Only closed buffers of authenticated caller events enter this transaction.
// A crash can leave up to N unanchored events (previously one); replay refuses.
// Pre/post snapshots are not an OS sandbox: restored transient writes are unseen.
function appendProtectedOwnerEvents(root, receiptFile, record, lines) {
  const batch = lines.slice();
  if (!batch.length) return;
  xllm.validateResultFileTarget(receiptFile, root);
  const protectedOwner = record?.execution?.protected_owner || record?.recovery_baseline?.protected_owner;
  if (!protectedOwner) fail('execution-protected-metadata');
  const eventsFile = target(root, '.gsd/forge/events.jsonl');
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
    let appended = fs.readFileSync(eventsFile);
    if (hash(appended) !== expected['.gsd/forge/events.jsonl']) fail('execution-owner-event-raced');
    for (const line of batch) {
      if (!fs.readFileSync(eventsFile).equals(appended)) fail('execution-owner-event-raced');
      fs.appendFileSync(eventsFile, line);
      appended = Buffer.concat([appended, Buffer.from(line)]);
      if (!fs.readFileSync(eventsFile).equals(appended)) fail('execution-owner-event-raced');
    }
    executionApi.assertProtected(root, { ...expected, '.gsd/forge/events.jsonl': hash(appended) });
    // Advance only exact caller bytes, never adopt a fresh owner snapshot.
    const advanced = { ...protectedOwner, '.gsd/forge/events.jsonl': hash(appended) };
    if (record.execution) record.execution.protected_owner = advanced;
    else {
      record.recovery_baseline.protected_owner = advanced;
      for (const row of record.recovery_baseline.protected_roots) if (path.resolve(row.path) === path.resolve(root)) row.snapshot = advanced;
    }
    if (record.milestone_delivery) record.milestone_delivery.protected_owner = advanced;
    // Saved-native failures keep their original failed/started receipt until here.
    json(receiptFile, record);
  });
}

async function runUnitSidecar(request, runtime = {}) {
  const linked = request?.linked_begin_key ? require('./forge-attempt-recovery').bindLinkedRequest(request, runtime.linkedEntryOptions) : request || {};
  // Issue 343 U3b: a cohort member's opaque handle is an in-process capability, never request data:
  // it leaves the request before any fingerprint, receipt or serialization of the attempt.
  const memberHandle = linked && Object.prototype.hasOwnProperty.call(linked, 'memberHandle') ? linked.memberHandle : undefined;
  let r = linked;
  if (memberHandle !== undefined) {
    const { memberHandle: liveHandle, ...data } = linked;
    r = data;
  }
  const route = r.route || {};
  const identity = { phase: r.preparationIdentity?.phase, unit: r.unitType === 'review-fix' ? reviewFixUnitLabel(r)
    : `${r.unitType || '-'}/${r.taskId || r.sliceId || r.milestoneId || r.sourceUnit || '-'}`,
    engine: route.resolved_worker_engine, transport: route.worker_mode === 'native' ? 'native-tool' : route.resolved_worker_engine === 'claude' ? 'claude-cli' : 'app-server',
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
  try { return await runUnitSidecarCore(r, scopedRuntime, identity, memberHandle); }
  catch (error) {
    if (typeof error.provider_called !== 'boolean') error.provider_called = transportRequested ? 'unknown' : false;
    scopedRuntime.announce('recusado', { ...identity, model_sent: '-', reason_code: error.code || 'sidecar-unit-failed',
      provider_called: error.provider_called });
    throw error;
  }
}
async function recoverUnitSidecar(request, recovery, runtime = {}) {
  if (request.linked_begin_key) request = require('./forge-attempt-recovery').bindLinkedRequest(request, runtime.linkedEntryOptions);
  // Mandatory obligations fail closed before process/receipt inspection.
  const recoveryProcedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd, phase: 'recovery',
    forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
  // Current authority can enrich a legacy original request without changing its
  // historical caller hash. It still passes the normal held-claim/gate checks.
  const authority = runtime.executionAuthority || {};
  const executionRequest = { ...request, ...authority };
  if (Object.keys(authority).some(key => !['execution_contract', 'claim', 'runId', 'gates'].includes(key))) fail('recovery-execution-authority-invalid');
  // Issue 288: with a host adapter (runtime.executionPlanGate), each auto-deferred
  // request gets its own fresh exact live gate at its actual seam: original checks
  // synchronously, even inside a successor scope; successor operations separately.
  // Without one, nothing changes and the existing gates decide.
  const planGate = runtime.executionPlanGate;
  const gated = value => planGate !== undefined && value?.gates?.plan === 'skipped' && value.gates.planSkipReason === 'auto-defer';
  const gateSync = (value, action) => gated(value)
    ? require('./forge-task-execution').withAutoPlanGateAdapterSync(planGate, value, action) : action();
  const gateAsync = (value, action) => gated(value)
    ? require('./forge-task-execution').withAutoPlanGateAdapter(planGate, value, action) : action();
  const asOriginal = gateSync, asSuccessorSync = gateSync, asSuccessor = gateAsync;
  const canonical = require('./forge-attempt-recovery').canonicalRequest(request);
  if (recovery.transitions?.some(row => ['uninvoked-native-reservation', 'uninvoked-native-repackage'].includes(row.type))
      && (!['milestone', 'standalone-task'].includes(canonical.scope) || canonical.phase !== 'execute' || canonical.unitType !== 'execute-task')) {
    fail('ordinary-native-delivery-unsupported');
  }
  if (canonical.scope === 'standalone-task'
      && require('./forge-task-preparation').phaseContract(canonical.phase)?.unitType===canonical.unitType) {
    return require('./forge-task-preparation').recoverStandaloneTask(request, recovery, runtime);
  }
  const resolverOptions = { cwd: canonical.contextRoot, unitType: canonical.unitType, scope: canonical.scope, phase: canonical.phase,
    hostRuntime: canonical.route.host_runtime, milestoneId: canonical.milestoneId,
    unitId: canonical.taskId || canonical.sliceId || canonical.milestoneId,
    planPath: canonical.planFile, roadmapPath: canonical.roadmapFile };
  const ordinaryResume = recovery.transitions?.some(row => ['uninvoked-native-reservation', 'uninvoked-native-repackage'].includes(row.type));
  const continuationId = ordinaryResume ? recovery.resumeReservation?.sha256 : crypto.randomUUID();
  if (ordinaryResume && !/^[a-f0-9]{64}$/.test(continuationId || '')) fail('recovery-reservation-required');
  const nativeTaskName = `recovery_${request.dispatchId}_${continuationId}`;
  const deliveryHelper = ordinaryResume && ['milestone', 'standalone-task'].includes(canonical.scope) && canonical.phase === 'execute'
    ? require('./forge-native-recovery-delivery') : null;
  let retainedRequest = null;
  const finalRequest = route => {
    const current = projectTransportOptions({ ...executionRequest, route, recoveryStateFile: recovery.stateFile,
      dispatchId: recoveryDispatchId(request.dispatchId, continuationId), resultFile: `${request.resultFile}.recovery-${continuationId}.json` }, executionRequest);
    return retainedRequest ? require('./forge-native-repackage').preserveRequest(current, retainedRequest) : current;
  };
  // This selects transport only; authority and the exact invocation hash are
  // independently revalidated by recovery before any consumption or dispatch.
  let retainedFileTransport = false;
  if (deliveryHelper && fs.existsSync(recovery.stateFile)) {
    require('./forge-attempt-recovery').validateStateTarget(recovery.stateFile, canonical, executionRequest.execution_contract);
    const retainedState = require('./forge-xllm-state').loadRecovery(recovery.stateFile);
    retainedFileTransport = retainedState?.continuation?.packaging_reason === 'uninvoked-native-file-repackage';
    if (retainedFileTransport || recovery.transitions?.some(row => row.type === 'uninvoked-native-repackage')) {
      const original = retainedFileTransport ? retainedState.continuation_history?.find(row => row.reservation_sha256 === continuationId) : retainedState.continuation;
      if (!original?.delivery) fail('native-repackage-evidence-invalid');
      require('./forge-attempt-recovery').validateStateTarget(original.delivery.manifest_file, canonical, executionRequest.execution_contract);
      const bytes = fs.readFileSync(original.delivery.manifest_file);
      if (hash(bytes) !== original.delivery.manifest_sha256) fail('native-repackage-evidence-invalid');
      retainedRequest = JSON.parse(bytes).request;
    }
  }
  const promptTransports = new Map();
  const nativeOptions = (route, { fileBacked = false } = {}) => {
    // Binding preflight uses the real task plan; the transport composes the
    // complete execution/security/context prompt after prepare.
    const executionPlan = canonical.scope === 'standalone-task' && canonical.phase === 'execute'
      ? fs.readFileSync(canonical.planFile, 'utf8') : null;
    const reviewPrompt = canonical.unitType === 'review-fix' ? (() => {
      const fix = require('./forge-review-fix'), loc = locations(request);
      const brief = fix.buildBrief({ boundary: loc.reviewFix.boundary, unitLabel: loc.reviewFix.unitLabel,
        items: fix.normalizeItems(request.reviewFix.items), claimPaths: request.reviewFix.claimPaths, route });
      return [
        `CODE_DIR (physical working directory): ${JSON.stringify(canonical.cwd)}`,
        `CONTEXT_ROOT (owner artifacts): ${JSON.stringify(canonical.contextRoot)}`,
        'Run every command with CODE_DIR as its working directory; resolve claimed relative paths only inside CODE_DIR.',
        'Do not edit owner artifacts or a separate CONTEXT_ROOT checkout. The orchestrator owns artifact publication.',
        fix.buildReviewFixPrompt(brief, { outputChannel: 'worker-result-block', constraints: request.constraints }),
      ].join('\n\n');
    })() : null;
    const rendered = !reviewPrompt && !executionPlan && !request.prompt && !request.promptFile ? renderPrompt({
      unitType: canonical.scope === 'standalone-task' && canonical.phase === 'execute' ? 'execute-loose-task' : request.unitType,
      cwd: canonical.contextRoot, codeDir: canonical.cwd, milestoneId: request.milestoneId, sliceId: request.sliceId,
      taskId: request.taskId, description: request.description, unitEffort: route.effort, autoCommit: false }) : null;
    let prompt = reviewPrompt || executionPlan || request.prompt || (request.promptFile ? fs.readFileSync(request.promptFile, 'utf8') : rendered.prompt);
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
    if (deliveryHelper) {
      // Capability preflight is not the final invocation; consume only the final packaged binding below.
      const seed = canonical.scope === 'standalone-task' ? require('./forge-native-invocation').buildNativeInvocation({
        hostRuntime: route.host_runtime, resolvedDispatch: route, activeCapabilities: runtime.activeCapabilities,
        effortBinding: runtime.effortBinding, prompt, forkTurns: 'none', taskName: nativeTaskName, agentType: 'forge-executor' }) : null;
      if (seed && !seed.ok) fail(seed.reason_code);
      const successor = finalRequest(route);
      prompt = asSuccessorSync(successor, () => deliveryHelper.packagePrompt(successor, prompt, { nativeInvocation: seed }));
    }
    let transport = null;
    if (deliveryHelper && (fileBacked || retainedFileTransport || request.nativePromptFile || recovery.transitions?.some(row => row.type === 'uninvoked-native-repackage'))) {
      const file = finalRequest(route).resultFile + '.native-prompt.txt';
      const promptHash = hash(prompt);
      if (!promptTransports.has(promptHash)) promptTransports.set(promptHash, require('./forge-native-prompt-file').prepare({
        file, prompt, contract: executionRequest.execution_contract, deferWrite: true }));
      transport = promptTransports.get(promptHash);
    }
    return { hostRuntime: route.host_runtime, resolvedDispatch: route,
    telemetryIdentity: finalRequest(route), lifecycle: runtime.nativeLifecycle, now: runtime.now,
    terminalResult: value => deliveryHelper ? deliveryHelper.resultContract.validate(value).ok
      : canonical.unitType === 'review-fix' && typeof value === 'string'
        // The review-fix prompt requires the textual worker-result block; the value
        // itself stays untouched for downstream result acceptance.
        ? require('./forge-worker-result').parseJsonEnvelope(value).ok === true
        : value && ['done', 'partial', 'blocked'].includes(value.status),
    activeCapabilities: runtime.activeCapabilities, effortBinding: runtime.effortBinding,
    prompt: transport ? transport.message : prompt,
    ...(transport ? { promptContext: prompt, assertReplay: () => transport.assertExisting(), assertInvocation: stage => {
      if (stage === 'packaged') transport.materialize();
      transport.assertUnchanged();
    } } : {}),
    onPackagedContext: runtime.onPackagedContext, forkTurns: 'none',
    taskName: nativeTaskName,
    agentType: ({ execute: 'forge-executor', plan: 'forge-planner', research: 'forge-researcher', discuss: 'forge-discusser' })[canonical.phase] || 'forge-worker' };
  };
  if (canonical.scope === 'milestone' && canonical.phase === 'execute' || canonical.unitType === 'review-fix') {
    if (!executionRequest.execution_contract) fail('execution-held-claim-required');
    asOriginal(executionRequest, () => validateRecoveryRequest(executionRequest, { verification: runtime.verification, nativeInvocation: request.route.worker_mode === 'native'
      ? require('./forge-native-invocation').buildNativeInvocation(nativeOptions(request.route)) : undefined }));
  }
  // Replay retains both authorities: the original must still be authorized
  // before the delivery helper opens its separate fresh successor scope.
  if (deliveryHelper) {
    const replayed = await deliveryHelper.replay({ request: executionRequest, recovery, runtime, nativeOptions });
    if (replayed) return replayed;
  }
  return require('./forge-attempt-recovery').recoverAttempt({ ...recovery, request,
    nativeJournalFile: runtime.nativeLifecycle?.journal?.file,
    ...(recovery.nativeRepackage ? { nativeRepackage: { ...recovery.nativeRepackage,
      nextJournalFile: runtime.nativeLifecycle?.journal?.file } } : {}),
    inspectSavedResult: runtime.savedNativeResult ? async () => (await gateAsync(executionRequest, () => inspectSavedNativeExecution(executionRequest, runtime))).writer : undefined,
    recoveryAuthorization: runtime.recoveryAuthorization, processProbe: runtime.processProbe,
    transitionAdapter: runtime.transitionAdapter,
    executionContract: executionRequest.execution_contract, executionAuthority: authority,
    externalNativeHandoff: !runtime.invokeNative,
    inspectPreSpawn: runtime.inspectPreSpawn, inspectPreSpawnDelta: runtime.inspectPreSpawnDelta,
    validateEnvironmentalCorrection: runtime.validateEnvironmentalCorrection,
    // Reached synchronously through transitionGuard.assertAuthority, also from
    // inside a successor scope: the original keeps its own fresh exact scope.
    validateExecutionAuthority: () => asOriginal(executionRequest, () => validateRecoveryRequest(executionRequest, { verification: runtime.verification, nativeInvocation: request.route.worker_mode === 'native'
      ? require('./forge-native-invocation').buildNativeInvocation(nativeOptions(request.route)) : undefined })),
    reconcile: receipt => {
      if (canonical.unitType === 'review-fix' && !receipt.recovery_baseline)
        return reconcileLegacyReviewFix(request, receipt, executionRequest.execution_contract);
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
        asOriginal(executionRequest, () => validateRecoveryRequest(executionRequest, { verification: runtime.verification, nativeInvocation: invocation }));
        return { ok: true, evidence_reference: 'unit-preflight:native-arguments',
          final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: invocation.args,
            context: invocation.args.prompt || invocation.args.message, identity: request, route: request.route,
            model: request.route.model, effort: request.route.effort, transport: 'native-tool' }) };
      }
      asOriginal(executionRequest, () => validateRecoveryRequest(executionRequest, { verification: runtime.verification }));
      if (typeof runtime.validateCorrection !== 'function') return { ok: false, reason_code: 'recovery-final-packaging-required' };
      return runtime.validateCorrection(request);
    },
    resolverOptions,
    resolveDispatch: runtime.resolveDispatch,
    validateInvocation: async route => {
      const invocation = route.worker_mode === 'native'
        ? require('./forge-native-invocation').buildNativeInvocation(nativeOptions(route)) : { ok: true };
      if (!invocation.ok) return invocation;
      const candidate = projectTransportOptions({ ...executionRequest, route }, executionRequest);
      try { asOriginal(candidate, () => validateRecoveryRequest(candidate, { verification: runtime.verification, nativeInvocation: invocation })); }
      catch (error) { return { ok: false, reason_code: error.code || 'unit-contract-refused', provider_called: false }; }
      return invocation;
    },
    replay: receipt => {
      if (receipt.phase === 'failed' && receipt.saved_candidate) {
        if (!recovery.reconciliation) fail('recovery-artifact-reconciliation-required');
        return reconcileArtifactAttempt(request, recovery.reconciliation);
      }
      return gateAsync(request, () => runUnitSidecar(request, runtime));
    },
    // The third argument is the decision's sidecar_ceiling; the route ceiling is
    // recomputed here from the single source instead of trusting the argument.
    // The sixth argument is the recovery's single same-session resume (S05): only
    // a Claude sidecar route may carry it; runUnitSidecarCore revalidates the ref.
    invoke: async (route, invocation, _ceiling, assertReady, reservationHash, resume) => {
      if (resume != null && (route.worker_mode !== 'sidecar' || route.resolved_worker_engine !== 'claude')) fail('recovery-resume-route-invalid');
      const routed = projectTransportOptions({ ...executionRequest, route }, executionRequest);
      asOriginal(routed, () => validateRecoveryRequest(routed, { verification: runtime.verification, nativeInvocation: invocation }));
      const ceiling = route.worker_mode === 'sidecar' ? ceilingFromRoute(route) : null;
      const next = deliveryHelper ? finalRequest(route) : projectTransportOptions({ ...executionRequest, recoveryStateFile: recovery.stateFile, route: ceiling
        ? { ...route, workers_timeout: ceiling.seconds, workers_timeout_source: ceiling.source } : route,
        dispatchId: recoveryDispatchId(request.dispatchId), resultFile: `${request.resultFile}.recovery-${crypto.randomUUID()}.json`,
        ...(resume != null ? { claudeResume: resume.session, resumedFrom: resume.resumed_from } : {}),
        // The successor carries only its actual parent: the admission returns the
        // parent's recorded decision for the same correction, never a new cycle.
        ...(canonical.unitType === 'review-fix' ? { reviewFixRecoveryOf: request.dispatchId } : {}) }, executionRequest);
      if (route.worker_mode === 'native') {
        if (deliveryHelper) {
          // The successor has a new dispatch: an auto-deferred one needs the
          // host adapter; the original authorization is never reused for it.
          if (planGate === undefined && next.gates?.plan === 'skipped' && next.gates.planSkipReason === 'auto-defer') fail('execution-auto-gate-adapter-required');
          let persistedReceipt = null;
          const session = asSuccessorSync(next, () => deliveryHelper.prepare({ request: next, nativeInvocation: invocation,
            savedManifest: assertReady?.repackageManifest?.(runtime.nativeLifecycle?.journal?.file),
            leaseRenewal: runtime.leaseRenewal,
            assertBoundary: runtime.assertBoundary, assertAuthority: assertReady?.assertAuthority,
            persistDeliveryReceipt: typeof assertReady?.persistDeliveryReceipt === 'function'
              ? receipt => { assertReady.persistDeliveryReceipt(receipt); persistedReceipt = receipt; } : undefined,
            linkedEntryOptions: runtime.linkedEntryOptions, onPhase: runtime.onPhase, onCheck: runtime.onVerificationCheck }));
          const finalRequestHash = require('./forge-attempt-recovery').callerRequestHash(next);
          let invoked = null, identityRequest = null;
          // Each call opens a fresh successor scope and reattests; a captured
          // callback or saved descriptor never revives a closed scope.
          const invoke = callback => asSuccessor(next, async () => {
            const supervisedOptions = nativeOptions(route);
            identityRequest = supervisedOptions.telemetryIdentity;
            supervisedOptions.lifecycle = { ...runtime.nativeLifecycle,
              captureLateResult: result => asSuccessorSync(next, () => session.returned(result)) };
            const outcome = await require('./forge-native-invocation').invokeNative(supervisedOptions, async (args, binding, observer) => {
            if (require('./forge-attempt-recovery').callerRequestHash(next) !== finalRequestHash) fail('recovery-final-request-changed');
            assertReady();
            runtime.assertBoundary();
            validateRecoveryRequest(next, { verification: runtime.verification, nativeInvocation: binding, linkedEntryOptions: runtime.linkedEntryOptions });
            require('./forge-milestone-time-admission').assertOwnerTransportEntry({ request: next, now: runtime.now });
            assertReady.consumeInvocation(binding, { ...session.start(),
              original_receipt_sha256: hash(fs.readFileSync(recovery.receiptFile)) });
            invoked = binding;
            return callback(next, { ...binding, args }, session, observer);
          });
            if (outcome.ok) {
              session.returned(outcome.result);
              assertReady.invocationReturned();
            }
            return outcome;
          });
          if (!runtime.invokeNative) return { action: 'invoke-native', request: next, invocation, delivery: session, invoke };
          const outcome = await invoke(runtime.invokeNative);
          if (!outcome.ok || !deliveryHelper.resultContract.validate(outcome.result).ok) return outcome;
          if (outcome.result.status !== 'done') return outcome;
          const verified = asSuccessorSync(next, () => session.verify(outcome.result));
          const published = asSuccessorSync(next, () => session.publish(outcome.result));
          // Durable identity only after session.publish returned, through a proven channel.
          const fields = nativeIdentityFields(outcome, invoked, identityRequest);
          if (fields) {
            try {
              const event = { unit: unitLabel(next, locations(next)), ...fields };
              // The transition channel still guards the pre-worker roots. After
              // publication use the existing owner lock and the exact saved ready
              // receipt instead; never adopt a new transition baseline here.
              if (!persistedReceipt?.file) fail('agent-identity-receipt-required');
              const receiptBytes = fs.readFileSync(persistedReceipt.file);
              if (hash(receiptBytes) !== persistedReceipt.sha256
                  || require('./forge-code-roots').digest(JSON.parse(receiptBytes)) !== require('./forge-code-roots').digest(published)) {
                fail('agent-identity-receipt-invalid');
              }
              await require('./forge-agent-identity').appendAgentIdentityEvent(
                { owner: next.contextRoot, closedReceiptFile: persistedReceipt.file }, event);
            } catch { /* the identity stays unknown; publication is unchanged */ }
          }
          return { ...outcome, verified, published };
        }
        // Only standalone execution has the native execution lifecycle. Other
        // phase adapters retain their existing public native outcome contract.
        const invokePhase = callback => {
          return require('./forge-native-invocation').invokeNative(nativeOptions(route), (args, binding, observer) => {
            assertReady?.();
            asOriginal(routed, () => validateRecoveryRequest(routed, { verification: runtime.verification, nativeInvocation: binding }));
            require('./forge-milestone-time-admission').assertOwnerTransportEntry({ request: next, now: runtime.now });
            assertReady?.consumeInvocation?.(binding);
            return callback(next, { ...binding, args }, {
              assertAuthority: () => {
                assertReady?.assertAuthority?.();
                asOriginal(routed, () => validateRecoveryRequest(routed, { verification: runtime.verification, nativeInvocation: binding }));
              },
            }, observer);
          });
        };
        const invoke = callback => {
          if (next.scope !== 'standalone-task' || next.phase !== 'execute') return invokePhase(callback);
          next.nativeInvocation = invocation;
          if (next.nativePromptFile) next.nativePromptFile = `${next.resultFile}.prompt.txt`;
          return asSuccessor(next, () => runUnitSidecar(next, { ...runtime, assertRecoveryReady: assertReady, assertRecoveryAuthority: assertReady?.assertAuthority,
            invokeNative: (args, binding, observer) => callback(next, { ...binding, args }, observer) }));
        };
        if (!runtime.invokeNative) {
          assertReady?.();
          if ((recovery.environmentalCorrection || recovery.transitions) && !recovery.resumeReservation) return {
            action: 'reattest-native-handoff', reservation_sha256: reservationHash, provider_called: false };
          return { action: 'invoke-native', request: next, invocation, invoke, ...(assertReady ? { assertReady } : {}) };
        }
        return invoke(runtime.invokeNative);
      }
      return asSuccessor(next, () => runUnitSidecar(next, { ...runtime, ...(assertReady?.appendOwnerEvent ? { assertRecoveryReady: assertReady } : {}) }));
    },
  });
}
module.exports = { appendProtectedOwnerEvents, preflightExecutionVerification, schema, memorySchema, memorySchemaV2, NEW_MEMORY_SCHEMA_VERSION, memoryExtractionSchema, memoryResponseSchema,
  memoryTransportSchema, memoryEvidenceContract, MEMORY_QUALITY_CONTRACT, locations, milestonePlanFile, validateRecoveryRequest, projectTransportOptions, captureMilestoneBaseline, reconcileMilestoneAttempt, validateArtifacts, inspectArtifacts, inspectDeliveryContent, executeDeliveryArtifacts, MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_PAYLOAD_BYTES, target, markChecked, createTaskMarker, verifyTaskMarker, materialize, memoryPrompt, memorySourceContext,
  publishReadyRecord, nativeMemoryFingerprint, acceptNativeMemoryResult, candidateFromNativeResult, runNativeMemory,
  routeIdentity, artifactFingerprint, artifactAttemptFiles, beginArtifactAttempt, replayArtifactAttempt, reconcileLegacyReviewFix,
  failArtifactAttempt, acceptArtifactResult, reconcileArtifactAttempt, runUnitSidecar, recoverUnitSidecar, reviewFixUnitLabel, effortTelemetry,
  cliObservers, verifyRetainedExecution, retainedPublication, publishRetainedMember };
// Default CLI observers: stderr only, never through the announcer. Phase lines and
// activity lines use the sanitized T03 formatters; activity is written only on a
// phase or liveness-state transition, at most 20 lines per unit. Verification
// progress is a technical record: closed JSON, no output, no rewritten command.
const MAX_ACTIVITY_LINES = 20;
function cliObservers(stream = process.stderr) {
  const { formatPhaseLine, formatActivityLine } = require('./forge-agent-view');
  let phase = 'unknown', pendingLiveness = null, lastActivityKey = null, activityLines = 0;
  const write = line => { try { stream.write(`${line}\n`); } catch { /* stderr loss never affects the unit */ } };
  const activity = observation => {
    if (activityLines >= MAX_ACTIVITY_LINES) return;
    activityLines++;
    write(formatActivityLine(observation, { now: Date.now() }));
  };
  return {
    onPhase: record => { phase = record.phase; write(formatPhaseLine(record.phase, { reason_code: record.reason_code })); },
    onVerificationCheck: record => write(`[forge-verify-progress] ${JSON.stringify(record)}`),
    // Only a newly delivered observation may be rendered as live. Phase and
    // transition notifications contain no new snapshot and never refresh one.
    onObservation: value => {
      const state = value?.liveness?.state || null;
      if (pendingLiveness !== null && state !== pendingLiveness) return;
      pendingLiveness = null;
      const key = JSON.stringify([phase, state]);
      if (key === lastActivityKey) return;
      lastActivityKey = key;
      activity(value);
    },
    onLiveness: transition => { if (transition && transition.from !== transition.to) pendingLiveness = transition.to; },
  };
}
if (require.main === module) {
  const announce = createStderrAnnouncer();
  Promise.resolve().then(() => {
    if (!['--request', '--accept-native-memory'].includes(process.argv[2]) || !process.argv[3]) fail('request-file-required');
    const request = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    return process.argv[2] === '--accept-native-memory' ? acceptNativeMemoryResult(request) : runUnitSidecar(request, { announce, ...cliObservers() });
  }).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => { process.stderr.write(`forge-unit-sidecar: ${error.code || 'sidecar-unit-failed'}\n`); process.exitCode = 1; });
}
