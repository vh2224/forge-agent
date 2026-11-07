'use strict';

// Delivery contracts, shared by the resolver guard and the transport entrypoint.
// A model alias or an installed executable is not a delivery capability.
const ARTIFACT_UNITS = Object.freeze([
  'research-milestone', 'research-slice', 'discuss-milestone', 'discuss-slice',
  'plan-milestone', 'complete-slice', 'complete-milestone', 'plan-check',
  // Read-only milestone time options proposal (<M>-OPTIONS.json), validated on acceptance.
  'estimate-milestone',
]);
const UNIT_MODES = Object.freeze({
  ...Object.fromEntries(ARTIFACT_UNITS.map(unit => [unit, 'artifacts'])),
  'memory-extract': 'memory',
  'plan-slice': 'plan', 'execute-task': 'execute',
  // Scoped writing contract (forge-xllm runFix + forge-review-fix), delivered and
  // published by forge-unit-sidecar. Never an alias of execute: no plan, SUMMARY
  // or checkbox exists for a review fix.
  'review-fix': 'fix',
  'review-challenger': 'challenge', 'review-advocate': 'defend',
  'review-rebuttal': 'rebuttal',
});
function capability(engine, unitType, delivery = {}) {
  let standalone = false;
  let standaloneExecute = false;
  const standaloneFix=delivery?.scope==='standalone-task'&&unitType==='review-fix'&&delivery.phase==='review-fix';
  if (delivery && delivery.scope === 'standalone-task') {
    if (unitType === 'execute-task' && delivery.phase === 'execute') standaloneExecute = true;
    else try {
      const contract = require('./forge-task-preparation').phaseContract(delivery.phase);
      standalone = !!contract && contract.unitType === unitType;
    } catch { standalone = false; }
  }
  const mode = standalone ? 'artifacts' : UNIT_MODES[unitType];
  const validScope = (!delivery.scope && delivery.phase === undefined)
    || delivery.scope === 'standalone-task' && (standalone || standaloneExecute || standaloneFix);
  const supported = ['claude', 'codex'].includes(engine) && !!mode && validScope;
  return {
    supported, mode: supported ? mode : null,
    reason_code: supported ? 'transport-supported' : 'unsupported-sidecar-unit',
    hint: supported ? `Transport ${engine}/${unitType}: ${mode}.`
      : `No sidecar contract for ${engine}/${unitType || '(missing unit_type)'}. Update Forge or configure an explicitly supported route for this unit; no worker was substituted.`,
  };
}
// Composed delivery proof, independent of the planner's dispatch permission.
// Directory access is not preventive per-file containment; deltas are verified.
function executionCapability(route, contract, options = {}) {
  const engine = route?.resolved_worker_engine || route?.engine;
  const supported = ['claude', 'codex'].includes(engine) && route?.dispatch_allowed === true
    && ['native', 'sidecar'].includes(route.worker_mode) && contract?.schema_version === 2
    && (route.worker_mode !== 'native' || options.nativeInvocation?.ok === true);
  return { supported, reason_code: supported ? 'execution-contract-supported' : 'execution-route-incompatible',
    engine: engine || null, host: route?.host_runtime || null, worker_mode: route?.worker_mode || null,
    transport: route?.worker_mode === 'native' ? 'native' : engine === 'claude' ? 'claude-cli' : 'codex-appserver',
    schema_version: 2, sandbox: 'directory-access-and-post-write-verification',
    additional_roots: true, result: 2, replay: 2, delivery: 2, vcs: ['git', 'svn'] };
}
// #350: Codex read-only artifact admission. The Codex artifacts turn forbids
// running commands and runs with sandbox readOnly/networkAccess:false, so a
// worker there has no tool to read owner files, run commands, investigate code,
// run verification or generate delivery input. Each profile below is classified
// from the dispatch templates and procedures at base 00c904f:
//   research-milestone / research-slice: template lines 1, 8, 12, 16
//   discuss-milestone: lines 12, 16, 20, 25; discuss-slice: lines 8, 12, 16, 20
//   plan-milestone: lines 9, 13, 17, 27, 31, 35; estimate-milestone: lines 9-13, 34
//   plan-check: lines 12, 16, 20-32
//   complete-slice: lines 6, 8, 14, 18-22; complete-milestone: lines 7, 9, 11, 14;
//     both also follow shared/forge-procedure-completion.md lines 5-24
//   standalone brainstorm/discuss/plan: the canonical caller inlines every input
//     (skills/forge-task/SKILL.md lines 706-722, 770-779, 883-909)
//   standalone research: code investigation (forge-task-preparation.js line 31;
//     SKILL.md line 836)
// The classification comes only from validated structural identity (engine,
// worker mode, transport mode, scope, phase, unit type). No prompt text,
// promptFile or request flag can change it, and nothing is packaged here.
const READONLY_CONTEXT_REASON = 'codex-readonly-context-unsupported';
const READONLY_CONTEXT_NEEDS = Object.freeze(['owner-file-read', 'command-output',
  'code-investigation', 'verification-run', 'delivery-generation', 'unclassified']);
const profileRow = (classification, ...needs) => Object.freeze({ classification, needs: Object.freeze(needs) });
const CODEX_READONLY_ARTIFACT_PROFILES = Object.freeze({
  'milestone:research-milestone': profileRow('refused', 'owner-file-read', 'code-investigation'),
  'milestone:research-slice': profileRow('refused', 'owner-file-read', 'code-investigation'),
  'milestone:discuss-milestone': profileRow('refused', 'owner-file-read', 'command-output'),
  'milestone:discuss-slice': profileRow('refused', 'owner-file-read'),
  'milestone:plan-milestone': profileRow('refused', 'owner-file-read', 'command-output'),
  'milestone:estimate-milestone': profileRow('refused', 'owner-file-read', 'command-output', 'code-investigation'),
  'milestone:plan-check': profileRow('refused', 'owner-file-read'),
  'milestone:complete-slice': profileRow('refused', 'owner-file-read', 'verification-run',
    'code-investigation', 'delivery-generation'),
  'milestone:complete-milestone': profileRow('refused', 'owner-file-read', 'verification-run', 'delivery-generation'),
  'standalone-task:brainstorm': profileRow('owner-packaged'),
  'standalone-task:discuss': profileRow('owner-packaged'),
  'standalone-task:research': profileRow('refused', 'code-investigation'),
  'standalone-task:plan': profileRow('owner-packaged'),
});
const NOT_APPLICABLE_ADMISSION = Object.freeze({ admitted: true, classification: 'not-applicable',
  profile: null, reason_code: 'readonly-context-not-applicable', needs: Object.freeze([]), hint: null });
const UNCLASSIFIED_ROW = profileRow('refused', 'unclassified');
// Identity tokens only: anything else is reported as (invalid), never echoed.
const profileToken = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : '(invalid)';
// Pure: reads only these six fields; any other input value is ignored.
function readOnlyArtifactAdmission({ engine, workerMode, mode, scope, phase, unitType } = {}) {
  if (!(engine === 'codex' && workerMode === 'sidecar' && mode === 'artifacts')) return NOT_APPLICABLE_ADMISSION;
  const profile = scope === undefined || scope === null || scope === 'milestone'
    ? `milestone:${profileToken(unitType)}` : `${profileToken(scope)}:${profileToken(phase)}`;
  const row = Object.hasOwn(CODEX_READONLY_ARTIFACT_PROFILES, profile)
    ? CODEX_READONLY_ARTIFACT_PROFILES[profile] : UNCLASSIFIED_ROW;
  const admitted = row.classification === 'owner-packaged';
  return Object.freeze({ admitted, classification: row.classification, profile,
    reason_code: admitted ? 'readonly-context-owner-packaged' : READONLY_CONTEXT_REASON, needs: row.needs,
    hint: admitted ? null : `Codex read-only artifact transport cannot supply ${profile} (needs: ${row.needs.join(', ')}). No worker was launched and no route was changed.` });
}
function assertReadOnlyArtifactContext(input) {
  const admission = readOnlyArtifactAdmission(input);
  if (admission.admitted) return admission;
  throw Object.assign(new Error(admission.hint), { code: READONLY_CONTEXT_REASON, stage: 'capability',
    provider_called: false, profile: admission.profile, needs: admission.needs });
}
module.exports = { ARTIFACT_UNITS, UNIT_MODES, capability, executionCapability, READONLY_CONTEXT_REASON,
  READONLY_CONTEXT_NEEDS, CODEX_READONLY_ARTIFACT_PROFILES, readOnlyArtifactAdmission, assertReadOnlyArtifactContext };
