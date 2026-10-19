'use strict';

const fs = require('fs');
const { digest } = require('./forge-code-roots');
const { isSafeModelId } = require('./forge-sidecar-diagnostic');
const PATH_KEYS = ['cwd', 'contextRoot', 'planFile', 'promptFile', 'securityFile', 'contextFile', 'resultFile'];
const safeModel = value => isSafeModelId(value) ? value : null;

// No prompt, argv, arbitrary error text or provider output crosses this boundary.
// Hash the original bytes first; sanitization applies only to retained metadata.
function code(value, fallback = null) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : fallback;
}
function measure(value, source, structured = false) {
  if (value === undefined || value === null) return { status: 'unknown', bytes: null, sha256: null,
    method: 'unavailable', source, diagnostic: 'measurement-not-observed' };
  try {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(structured ? JSON.stringify(value) : value, 'utf8');
    return { status: 'observed', bytes: bytes.length, sha256: digest(bytes),
      method: structured ? 'json-utf8-sha256' : 'utf8-sha256', source, diagnostic: null };
  } catch { return { status: 'unknown', bytes: null, sha256: null, method: 'unavailable', source,
    diagnostic: 'measurement-failed' }; }
}
function numericBudgets(value) {
  const budgets = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (!/^[a-z_]{1,60}$/.test(key)) continue;
    if (Number.isFinite(item) && item >= 0) budgets[key] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) budgets[key] = numericBudgets(item);
  }
  return budgets;
}
function captureFinal(options = {}) {
  const identity = options.identity || {}, route = options.route || {};
  let context = measure(options.context, code(options.source, 'adapter-final'));
  if (options.context === undefined && options.promptFile) {
    try { context = measure(fs.readFileSync(options.promptFile), 'prompt-file'); }
    catch { context = { ...context, source: 'prompt-file', diagnostic: 'prompt-file-unreadable' }; }
  }
  return { schema_version: 1, captured_at: new Date().toISOString(), stage: code(options.stage, 'prepared'),
    context, request: measure(options.request, 'adapter-arguments', true),
    unit_type: code(identity.unitType), scope: code(identity.scope), phase: code(identity.phase),
    dispatch_id: code(identity.dispatchId),
    paths: Object.fromEntries(PATH_KEYS
      .filter(key => typeof identity[key] === 'string').map(key => [key, identity[key]])),
    model_requested: safeModel(route.model_requested), model_sent: safeModel(options.model), model_observed: null,
    effort: code(options.effort || route.effort), host: code(route.host_runtime),
    worker: code(route.resolved_worker_engine), transport: code(options.transport || route.worker_mode),
    budgets: numericBudgets(options.budgets), provider_called: 'unknown' };
}
function sanitizeFinal(value) {
  if (!value || value.schema_version !== 1) return null;
  const measurement = item => item && /^[a-f0-9]{64}$/.test(item.sha256)
    && Number.isInteger(item.bytes) && item.bytes >= 0
    ? { status: 'observed', bytes: item.bytes, sha256: item.sha256, method: code(item.method),
      source: code(item.source), diagnostic: code(item.diagnostic) }
    : { ...measure(undefined, code(item?.source, 'adapter-final')), diagnostic: code(item?.diagnostic, 'measurement-not-observed') };
  const safe = captureFinal({ identity: { unitType: value.unit_type, scope: value.scope, phase: value.phase,
    dispatchId: value.dispatch_id, ...Object.fromEntries(PATH_KEYS.filter(key => typeof value.paths?.[key] === 'string')
      .map(key => [key, value.paths[key]])) }, route: { model_requested: value.model_requested,
    host_runtime: value.host, resolved_worker_engine: value.worker }, model: value.model_sent,
    effort: value.effort, transport: value.transport, budgets: value.budgets, stage: value.stage });
  return { ...safe, captured_at: typeof value.captured_at === 'string' && !Number.isNaN(Date.parse(value.captured_at))
    ? new Date(value.captured_at).toISOString() : safe.captured_at,
    context: measurement(value.context), request: measurement(value.request), model_observed: safeModel(value.model_observed),
    provider_called: typeof value.provider_called === 'boolean' ? value.provider_called : 'unknown',
    duration_ms: Number.isFinite(value.duration_ms) && value.duration_ms >= 0 ? value.duration_ms : null };
}
function observeFinal(options, request, context, transport) {
  const identity = options.telemetryIdentity || options;
  const root = identity.contextRoot || identity.cwd;
  // The resolver owns preferences. Read only the resolved numeric budget here;
  // telemetry neither changes routing nor truncates mandatory prompt sections.
  const defaults = root ? require('./forge-prefs').readPrefsCached(root).prefs?.token_budget : {};
  const evidence = captureFinal({ request, context, transport, model: options.model, effort: options.effort,
    source: 'transport-boundary', identity,
    route: options.telemetryRoute || options.resolvedDispatch || {},
    budgets: { ...numericBudgets(defaults), ...numericBudgets(options.budgets || options.executionContext?.budgets) } });
  if (typeof options.onPackagedContext === 'function') options.onPackagedContext({
    ...evidence.context, input_tokens: typeof context === 'string' ? Math.ceil(context.length / 4) : null,
    token_method: 'heuristic-chars-4', budgets: evidence.budgets, final_evidence: evidence });
  return evidence;
}
module.exports = { measure, captureFinal, observeFinal, sanitizeFinal, numericBudgets, code };
