#!/usr/bin/env node
'use strict';

// Delivery only: consumes a resolved route and the controller-selected unit.
// It never selects a unit, acquires a lease, changes host, commits or falls back.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xllm = require('./forge-xllm');
const { invokeClaudeSidecar } = require('./forge-claude-sidecar');
const { evaluateDispatchGuard } = require('./forge-dispatch-guard');
const { capability } = require('./forge-transport-capabilities');
const { renderPrompt } = require('./forge-prompt');
const { diagnostic } = require('./forge-sidecar-diagnostic');
const memory = require('./forge-memory');

const schema = xllm.loadSchemaFile('unit-artifacts.schema.json');
const memorySchema = xllm.loadSchemaFile('memory-extraction.schema.json');
const MAX_ARTIFACT_BYTES = 512 * 1024;
// Leave room for the envelope and provider prose within the 1 MiB stream cap.
const MAX_ARTIFACT_PAYLOAD_BYTES = 900 * 1024;
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
function sameUnit(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.type === expected.type && value.id === expected.id
    && (value.milestone || null) === (expected.milestone || null)
    && (value.slice || null) === (expected.slice || null);
}
function inspectDeliveryContent(content, rule) {
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
function locations(request) {
  const m = request.milestoneId, s = request.sliceId, t = request.taskId;
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
function inspectArtifacts(value, allowed, required, maxPayloadBytes = Infinity, rules = {}) {
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
  if (value.status === 'done' && !required.every(p => seen.has(p))) return bad('artifact-missing');
  if (Buffer.byteLength(JSON.stringify(value)) > maxPayloadBytes) return bad('payload-limit');
  return { ok: true };
}
function validateArtifacts(value, allowed, required, maxPayloadBytes, rules) {
  return inspectArtifacts(value, allowed, required, maxPayloadBytes, rules).ok;
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
async function publishReadyRecord(request, record) {
  if (record.kind !== 'memory-extraction') return materialize(request, record);
  const extraction = record.extraction;
  if (extraction.status !== 'done') return { status: extraction.status, extraction,
    ...(record.telemetry ? { telemetry: record.telemetry } : {}),
    publication: { status: 'noop', reason: `worker-${extraction.status}` } };
  if (!extraction.facts.length && !extraction.events.length) {
    return { status: 'done', extraction, ...(record.telemetry ? { telemetry: record.telemetry } : {}),
      publication: { status: 'noop', reason: 'empty-extraction' } };
  }
  // Auto may finish inference while another worker snapshot is protected. Keep
  // the durable ready receipt and replay publication after the owner joins it.
  const boundary = request.publicationBoundary;
  const snapshots = boundary && Array.isArray(boundary.protectedSnapshots) ? boundary.protectedSnapshots : null;
  const boundarySafe = request.publicationSafe === true && boundary && boundary.ownerJoined === true
    && typeof boundary.checkedAt === 'string' && Number.isFinite(Date.parse(boundary.checkedAt)) && snapshots
    && snapshots.every(snapshot => snapshot && snapshot.state === 'ended' && typeof snapshot.id === 'string');
  if (!boundarySafe) {
    return { status: 'done', extraction, ...(record.telemetry ? { telemetry: record.telemetry } : {}),
      publication: { status: 'deferred', reason: 'protected-boundary-not-confirmed' } };
  }
  if (typeof request.waitForPublicationBoundary === 'function') await request.waitForPublicationBoundary();
  const { publishExtraction } = require('./forge-memory-extraction');
  const publication = await publishExtraction({ cwd: request.contextRoot || request.cwd, extraction,
    sourceContext: memorySourceContext(request, record) });
  return { status: 'done', extraction, ...(record.telemetry ? { telemetry: record.telemetry } : {}), publication };
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
async function acceptNativeMemoryResult(request) {
  const r = request || {}, loc = locations({ ...r, unitType: 'memory-extract' });
  if (!r.dispatchId || !r.workflowId) fail('dispatch-identity-required');
  const files = nativeReceiptFiles(r);
  const fingerprint = nativeMemoryFingerprint(r);
  const existing = fs.existsSync(files.receiptFile) ? JSON.parse(fs.readFileSync(files.receiptFile, 'utf8')) : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
    if (existing.phase === 'ready') {
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
    const extraction = require('./forge-memory-extraction').validateExtractionResult(r.rawResult,
      { sourceUnit: loc.sourceUnit });
    const record = { phase: 'ready', kind: 'memory-extraction', fingerprint,
      dispatch_id: r.dispatchId, extraction_id: r.extractionId || r.dispatchId,
      extracted_at: r.extractedAt || new Date().toISOString(), source_unit: loc.sourceUnit,
      model: r.model || r.route?.model || null, effort: r.effort || r.route?.effort || null,
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
  if (!prepared.ok) return { status: 'failure', reason_code: prepared.reason_code,
    hint: prepared.hint, provider_called: false, telemetry: prepared.telemetry };
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
async function runUnitSidecar(request) {
  const r = request || {}, route = r.route || {};
  const transport = capability(route.resolved_worker_engine, r.unitType);
  if (!transport.supported) fail(transport.reason_code, transport.hint);
  const guard = evaluateDispatchGuard({ ...route, unit_type: r.unitType });
  if (route.dispatch_allowed !== true || route.worker_mode !== 'sidecar' || !route.sidecar_declared
    || !guard.dispatch_allowed) fail(guard.reason_code || 'route-refused', guard.hint);
  const model = route.resolved_worker_engine === 'codex' ? (route.sidecar_model || route.model) : route.model;
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
  if (!r.dispatchId || !r.workflowId) fail('dispatch-identity-required');
  const fingerprint = hash(JSON.stringify({ ...r, resultFile: undefined, publicationSafe: undefined,
    publicationBoundary: undefined, waitForPublicationBoundary: undefined }));
  const receiptFile = `${resultFile}.receipt.json`;
  xllm.validateResultFileTarget(receiptFile, cwd);
  xllm.validateResultFileTarget(receiptFile, root);
  const eventsFile = target(root, '.gsd/forge/events.jsonl');
  function event(status, reasonCode, detail) {
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), event: 'sidecar-unit',
      workflow_id: r.workflowId, dispatch_id: dispatchId,
      unit: `${r.unitType}/${r.unitType === 'memory-extract' ? loc.sourceUnit : r.taskId || r.sliceId || r.milestoneId}`,
      host_runtime: route.host_runtime, worker_engine: route.resolved_worker_engine,
      worker_mode: 'sidecar', model, tier: route.tier, effort: route.effort,
      status, ...(reasonCode ? { reason_code: reasonCode } : {}),
      ...(detail ? { diagnostic: diagnostic(detail.reason, detail) } : {}) }) + '\n');
  }
  function recordFailure(error) {
    const code = error.code || 'sidecar-unit-failed';
    const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const detail = diagnostic(error.diagnostic?.reason || (code === 'untrusted-output-barrier'
      ? 'control-data-output' : record.phase === 'ready' ? 'publication-failed' : 'adapter-failed'), error.diagnostic);
    const failure = { status: 'adapter-failed', dispatch_id: dispatchId, reason_code: code,
      error_class: xllm.classifyErrorClass(error.message), diagnostic: detail,
      recovery: record.phase === 'ready' ? 'replay-publication' : 'operator-required',
      failed_at: new Date().toISOString() };
    // Never overwrite the validated response if publication was interrupted.
    if (record.phase !== 'ready') json(receiptFile, { ...record, phase: 'failed', failure });
    json(resultFile, failure);
    event('failed', code, detail);
  }
  const existing = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail('dispatch-identity-conflict');
    if (existing.phase === 'ready') {
      try {
        const result = await publishReadyRecord(r, existing);
        json(resultFile, result);
        return result;
      } catch (error) { recordFailure(error); throw error; }
    }
    if (existing.phase === 'failed') {
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
  const startedAt = new Date().toISOString();
  // Exclusive creation arbitrates concurrent invocations of the same attempt.
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'started', fingerprint, dispatch_id: dispatchId, before }), { flag: 'wx', mode: 0o600 });
  event('started');
  const dispatchEvent = require('./forge-dispatch-event').buildDispatchEvent({
    unit: `${r.unitType}/${r.taskId || r.sliceId || r.milestoneId}`, milestone: r.milestoneId,
    slice: r.sliceId, dispatchId, model, engine: route.resolved_worker_engine,
    transport: route.resolved_worker_engine === 'claude' ? 'claude-cli' : 'app-server',
  }, route, startedAt);
  fs.appendFileSync(eventsFile, JSON.stringify(dispatchEvent) + '\n');
  const options = { cwd, contextRoot: root, engine: route.resolved_worker_engine,
    unitType: r.unitType,
    hostRuntime: route.host_runtime, sidecarDeclared: true, model,
    effort: route.effort, timeoutSecs: route.workers_timeout || 1800, resultFile, dispatchId,
    constraints: r.constraints || { auto_commit: false, deploy: false },
    signal: r.signal,
  };
  const heartbeat = pid => json(resultFile, { status: 'running', pid, adapter_pid: process.pid,
    heartbeat_interval_ms: 15000, started_at: startedAt, updated_at: new Date().toISOString(), dispatch_id: dispatchId });
  try {
    let result, artifacts;
    if (transport.mode === 'memory') {
      const prompt = memoryPrompt(r, loc.sourceUnit);
      const validateMemory = value => {
        try { require('./forge-memory-extraction').validateExtractionResult(value, { sourceUnit: loc.sourceUnit }); return true; }
        catch { return false; }
      };
      heartbeat(null);
      if (options.engine === 'claude') {
        const output = await invokeClaudeSidecar({ ...options, prompt: prompt
          + '\nFinish with ---GSD-WORKER-RESULT---, status, result_json containing the complete JSON, and ---END-RESULT--- on separate lines.',
          readOnly: true, validateCandidate: validateMemory, onHeartbeat: heartbeat,
          heartbeatIntervalMs: 15000, terminateChild: xllm.terminateOwnedProcessTree });
        result = output.candidate;
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
      const payloadLimit = options.engine === 'claude' ? MAX_ARTIFACT_PAYLOAD_BYTES : Infinity;
      const base = r.promptFile ? fs.readFileSync(r.promptFile, 'utf8') : renderPrompt({
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
      xllm.authorizeSidecar('artifacts', options);
      heartbeat(null);
      if (options.engine === 'claude') {
        const output = await invokeClaudeSidecar({ ...options, prompt: prompt
          + '\nFinish with the following envelope. Markers must be on their own lines. result_json must contain one complete JSON object (compact or multiline); escape newlines inside JSON strings. Do not wrap the JSON in Markdown fences.\n---GSD-WORKER-RESULT---\nstatus: <done|partial|blocked>\nresult_json: <complete JSON>\n---END-RESULT---',
          readOnly: true, validateCandidate: value => inspectArtifacts(value, loc.allowed, loc.required, payloadLimit, loc.rules), onHeartbeat: heartbeat,
          heartbeatIntervalMs: 15000, terminateChild: xllm.terminateOwnedProcessTree });
        result = output.candidate;
      } else {
        const output = await xllm.invokeCodexAppServer({ ...options, prompt, schema, sandbox: 'read-only', onHeartbeat: heartbeat });
        result = xllm.extractLastJsonBlock(output.finalText || output.agentTexts);
      }
      const verdict = inspectArtifacts(result, loc.allowed, loc.required, payloadLimit, loc.rules);
      if (!verdict.ok) {
        const error = new Error('Invalid artifact result.');
        error.code = 'invalid-artifact-result';
        error.diagnostic = diagnostic(verdict.reason);
        throw error;
      }
      if (r.unitType === 'plan-milestone' && result.status === 'done') {
        const roadmap = result.artifacts.find(a => a.path === loc.required[0]);
        const slices = require('./forge-status').parseRoadmap(roadmap.content).slices;
        if (!slices.length || new Set(slices.map(s => s.id)).size !== slices.length) fail('invalid-roadmap-result');
      }
      xllm.assertUntrustedOutputBarrier(result);
      artifacts = result.status === 'done' ? result.artifacts : [];
    } else fail('unsupported-sidecar-unit', 'Use forge-xllm review modes for this review contract.');
    if (result.status === 'done' && bookkeeping) {
      artifacts.push({ path: bookkeeping, content: markChecked(bookkeepingText, r.unitType === 'complete-slice' ? r.sliceId : r.taskId) });
    }
    const record = transport.mode === 'memory'
      ? { phase: 'ready', kind: 'memory-extraction', fingerprint, dispatch_id: dispatchId,
        extraction_id: r.extractionId || dispatchId, extracted_at: startedAt, source_unit: loc.sourceUnit,
        model: route.model_resolved || route.model, effort: route.effort, extraction: result, artifacts: [],
        telemetry: { model_requested: route.model_requested || route.model || null,
          model_resolved: route.model_resolved || route.model || null, model_argument: model,
          model_observed: null, model_observed_source: null,
          effort_requested: route.effort || null, effort_resolved: route.effort || null,
          effort_argument: route.effort || null, capabilities_source: 'sidecar-transport' } }
      : { phase: 'ready', fingerprint, result: { ...result, dispatch_id: dispatchId,
        workflow_id: r.workflowId, host_runtime: route.host_runtime, worker_engine: options.engine },
        artifacts: artifacts.map(a => ({ ...a, before: before[a.path] ?? null })) };
    // Durable validated response BEFORE artifact publication: a crash anywhere
    // after here replays publication, without spending another provider turn.
    json(receiptFile, record);
    result = await publishReadyRecord(r, record);
    json(resultFile, result);
    event(result.status);
    return result;
  } catch (error) {
    recordFailure(error);
    throw error;
  }
}
module.exports = { schema, memorySchema, MEMORY_QUALITY_CONTRACT, locations, validateArtifacts, inspectArtifacts, inspectDeliveryContent, executeDeliveryArtifacts, MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_PAYLOAD_BYTES, target, markChecked, materialize, memoryPrompt, memorySourceContext,
  publishReadyRecord, nativeMemoryFingerprint, acceptNativeMemoryResult, candidateFromNativeResult, runNativeMemory, runUnitSidecar };
if (require.main === module) {
  Promise.resolve().then(() => {
    if (!['--request', '--accept-native-memory'].includes(process.argv[2]) || !process.argv[3]) fail('request-file-required');
    const request = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    return process.argv[2] === '--accept-native-memory' ? acceptNativeMemoryResult(request) : runUnitSidecar(request);
  }).catch(error => { process.stderr.write(`forge-unit-sidecar: ${error.code || 'sidecar-unit-failed'}\n`); process.exitCode = 1; });
}
