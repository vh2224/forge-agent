#!/usr/bin/env node
'use strict';

// forge-plan-validation — strict admission of newly generated slice plans (issue 343 U0b).
//
// One owner gate for every producer of new task plans: the planner transports and
// the sidecar publisher (U0c), the native plan-slice completion and the first
// execute-task (U0d) and the add-task/add-slice/decompose creators (U0e). It never
// authorizes, writes a receipt, acquires a lease or touches a claim; the only bytes it
// publishes are the creators' owner mutation records (U0e), never a plan byte.
//
//   validateNewSlicePlan(candidate, scope)   pure admission of returned content
//   collectOwnerSlicePlan(cwd, scope)        bounded, stable read of the owner plan files
//   readOwnerTaskPlan(cwd, scope)            the same bounded read of one owner T-plan
//   buildPlanGeneration / verifyPlanGeneration   plan_generation enrollment (pure)
//   planGenerationIntegrity(record, binding)  storage-level integrity of a stored enrollment
//   buildPlanValidation / verifyPlanValidation   plan_validation evidence (pure)
//   semanticDigest(evidence)                  digest of what admission decided (pure)
//   assertCurrentGeneration(cwd, scope)       read-only recheck against committed evidence
//   classifySliceGeneration(cwd, scope)       read-only canonical enrollment classification (U0d)
//   assertSliceGeneration(cwd, scope)         the shared execute gate: classification + recheck
//   beginOwnerPlanMutation(cwd, request)      owner intent of add-task/add-slice/decompose (U0e)
//   finishOwnerPlanMutation(cwd, mutationRef) strict admission of that intent's owner bytes (U0e)
//   inspectOwnerPlanMutations(cwd, scope)     read-only summary of one slice's mutation chain (U0e)
//
// Admission order is fixed in code, never selected by a profile, a flag or imported
// JSON: the strict product parser (parseMustHaves) first, so a plan without
// must_haves keeps the `must_haves` message the existing suites match; then the
// canonical equality between the S-plan task list and the returned task plans; then
// forge-must-haves validateTaskDeclarations (explicit depends/writes, protected paths)
// and the pure forge-parallelism validateTaskDag, which must be `valid`. A refusal
// throws a named error ({ code, detail }); success returns deep-frozen evidence.
//
// Local modules load lazily, inside the functions that use them: requiring this file
// loads no Forge module. The pure validators reach only forge-must-haves,
// forge-parallelism and forge-code-roots (the #348 path policy). The S-plan list is
// read by a mirror of forge-status parsePlanTasks (pinned by the suite), because
// forge-status loads forge-ids, which loads forge-prefs at top level. The collector
// adds the bounded reader (forge-autonomy-sources); the read-only generation checks add
// the controller's own record seam (forge-unit-controller transactionDir, readJson and
// lookupRecord, as its discoverRecords walks them, plus readEvents/eventsFile). The
// pure parallelism module never imports the
// controller, so the code-roots -> parallelism dependency gains no cycle through this gate.
//
// Where the evidence lives (U0d): the native controller writes plan_generation at the
// top of a NEW plan-slice begin transaction (bound to that begin by the controller's
// record validation) and plan_validation inside the normalized result of its committed
// successful completion, so boundary.result_checksum covers it. The readers below read
// exclusively completion.result.plan_validation; a top-level alias is refused, never a
// fallback. Historical transactions carry neither field and stay unclassified.
//
// Direct creators (U0e): add-task, add-slice and decompose are owner amendments. Their
// intent is published before the creator writes any plan byte and their admission after
// it, as one immutable chain per slice under .gsd/forge/plan-validations/ (see the owner
// plan mutation section below). The mutation path alone loads the owner safe boundary and
// the owner publication lock, lazily.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function must() { return require('./forge-must-haves'); }
function parallel() { return require('./forge-parallelism'); }
function codeRoots() { return require('./forge-code-roots'); }
function boundedReader() { return require('./forge-autonomy-sources'); }
function controller() { return require('./forge-unit-controller'); }
// U0e owner writers only: the milestone safe boundary and the owner publication lock.
function ownerBoundaryApi() { return require('./forge-milestone-time-selection'); }
function ownerLockApi() { return require('./forge-artifact-reconciliation'); }

// ── Contract constants ────────────────────────────────────────────────────────

const REQUIREMENT = 'explicit-depends-writes-v1';
// The requirement's rules, bound by digest into every enrollment and validation:
// a record admitted under other rules never verifies as current.
const REQUIREMENT_RULES = Object.freeze({
  requirement: REQUIREMENT,
  must_haves: 'forge-must-haves.parseMustHaves',
  membership: 'forge-status.parsePlanTasks list equals the task plan set',
  declarations: 'forge-must-haves.validateTaskDeclarations requireExplicit',
  graph: 'forge-parallelism.validateTaskDag valid',
  source: 'exact utf-8 bytes, at most 1048576 per plan',
});
const MAX_PLAN_BYTES = 1024 * 1024; // forge-unit-controller TASK_PLAN_MAX_BYTES
// Output truncation is diagnostic only. Admission keeps the canonical local ID
// grammar; the normal sidecar's separate 1-7 response bound stays at its producer.
const DIAGNOSTIC_ID_LENGTH = 32;
const MAX_KEY_LENGTH = 2048;
const TASK_ID = /^T\d+(?:\.\d+)?$/;
// One path segment: forge-unit-controller SAFE_SEGMENT without a trailing dot (a
// Windows alias of the same name) and never a Windows device name.
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const OWNER_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ROOT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// forge-status parsePlanTasks line grammar, mirrored exactly (see the header).
const PLAN_TASK_LINE = '^\\s*- \\[( |x)\\]\\s+\\*{0,2}(T\\d+(?:\\.\\d+)?)\\*{0,2}\\s*:?\\s*(.*)$';
// The committed controller transactions that carry the owner evidence (U0d writes
// them at intent time): the plan-slice begin carries the enrollment at its top level,
// its committed successful completion the validation inside its normalized result
// (completion.result[validation], covered by boundary.result_checksum).
const TRANSACTION_FIELDS = Object.freeze({ generation: 'plan_generation', validation: 'plan_validation' });
// Controller actions that end one begin lineage (forge-unit-controller boundaryKind).
const TERMINAL_ACTIONS = Object.freeze(['complete', 'pause', 'fail', 'expired-safe']);
const GENERATION_KEYS = Object.freeze(['schema_version', 'requirement', 'generation_key', 'owner', 'milestone', 'slice',
  'begin_key', 'lease_generation', 'owner_digest', 'requirement_sha256']);
const GENERATION_INPUT_KEYS = Object.freeze(['owner', 'milestone', 'slice', 'begin_key', 'lease_generation', 'owner_digest']);
const VALIDATION_KEYS = Object.freeze(['requirement', 'generation_key', 'requirement_sha256', 'owner', 'milestone', 'slice',
  'begin_key', 'source', 'declarations', 'task_ids', 'edges', 'graph_sha256', 'validation_sha256', 'validated_at']);
const DECLARATION_KEYS = Object.freeze(['task_id', 'depends', 'writes', 'roots_schema', 'primary_root_id', 'declared_roots',
  'declaration_sha256']);
const LEGACY_ABSENCE = Object.freeze(['plan-declaration-depends-missing', 'plan-declaration-writes-missing']);
// Named refusals. Declaration refusals keep their forge-must-haves codes
// (plan-declaration-*), with the task ID added to the detail.
const CODES = Object.freeze([
  'plan-scope-invalid', 'plan-candidate-invalid', 'plan-task-id-invalid', 'plan-task-id-duplicate', 'plan-task-list-empty',
  'plan-task-list-mismatch', 'plan-must-haves-legacy', 'plan-must-haves-invalid', 'plan-dag-invalid',
  'plan-addition-task-removed', 'plan-addition-order-changed', 'plan-addition-unaltered', 'plan-known-invalid',
  'plan-source-owner-unreadable', 'plan-source-owner-mismatch', 'plan-source-missing', 'plan-source-link',
  'plan-source-not-regular', 'plan-source-unreadable', 'plan-source-too-large', 'plan-source-unstable', 'plan-source-encoding',
  'plan-source-inconsistent', 'plan-source-layout-conflict', 'plan-source-legacy-layout',
  'plan-generation-invalid', 'plan-validation-invalid', 'plan-generation-evidence-missing', 'plan-generation-evidence-invalid',
  'plan-generation-lineage-mismatch', 'plan-generation-owner-mismatch', 'plan-generation-drift',
  // U0d: the canonical enrollment classification of one slice.
  'plan-generation-pending', 'plan-generation-completion-missing', 'plan-generation-ambiguous', 'plan-generation-slice-unknown',
  // U0e: owner plan mutations of the direct creators (add-task, add-slice, decompose).
  'plan-mutation-invalid', 'plan-mutation-owner-mismatch', 'plan-mutation-boundary-deferred', 'plan-mutation-pending',
  'plan-mutation-slice-exists', 'plan-mutation-task-exists', 'plan-mutation-parent-invalid', 'plan-mutation-ref-invalid',
  'plan-mutation-ref-stale', 'plan-mutation-base-changed', 'plan-mutation-known-changed', 'plan-mutation-parent-altered',
  'plan-mutation-substitution-invalid', 'plan-mutation-delta-mismatch', 'plan-mutation-evidence-invalid',
]);
const SOURCE_REFUSALS = Object.freeze({ missing: 'plan-source-missing', link: 'plan-source-link', 'not-regular': 'plan-source-not-regular',
  unreadable: 'plan-source-unreadable', 'too-large': 'plan-source-too-large', unstable: 'plan-source-unstable',
  encoding: 'plan-source-encoding' });

// ── Small pure helpers ────────────────────────────────────────────────────────

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = stable(value[key]);
  return output;
}
function digestOf(value) { return sha256(JSON.stringify(stable(value))); }
function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
function refuse(code, detail, extra) {
  throw Object.assign(new Error(`${code}: ${detail}`), { code, detail }, extra || {});
}
function exactKeys(value, keys, code, label) {
  const actual = Object.keys(value).sort(), wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    refuse(code, `${label} fields must be exactly ${keys.join(', ')}`);
  }
}
function safeId(value) { return typeof value === 'string' && SAFE_ID.test(value) && !WINDOWS_DEVICE.test(value); }
function taskId(value) { return typeof value === 'string' && TASK_ID.test(value); }
function shortId(value) { return String(value).slice(0, DIAGNOSTIC_ID_LENGTH + 8); }
function opaqueKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value) && value === value.normalize('NFC').trim();
}
// The owner identity in forge-code-roots key form (forward slashes, case-folded on Windows).
function ownerKey(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return null;
  return codeRoots().key(path.resolve(value));
}
function isoInstant(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}
function requirementSha256() { return digestOf(REQUIREMENT_RULES); }
const REQUIREMENT_SHA256 = requirementSha256();

function slicePlanPath(scope) { return `.gsd/milestones/${scope.milestone}/slices/${scope.slice}/${scope.slice}-PLAN.md`; }
function taskPlanPath(scope, id) { return `.gsd/milestones/${scope.milestone}/slices/${scope.slice}/tasks/${id}/${id}-PLAN.md`; }

// One scope object per entry point: unknown fields refuse (an imported `approved`,
// `legacy` or profile field waives nothing), identity fields are one safe segment.
function scopeOf(scope, allowed, required) {
  if (!isObject(scope)) refuse('plan-scope-invalid', 'scope must be an object');
  for (const key of Object.keys(scope)) if (!allowed.includes(key)) refuse('plan-scope-invalid', `unknown scope field ${key}`);
  for (const key of required) if (scope[key] === undefined || scope[key] === null) refuse('plan-scope-invalid', `scope field ${key} is required`);
  if (!safeId(scope.milestone)) refuse('plan-scope-invalid', 'milestone must be one safe path segment');
  if (!safeId(scope.slice)) refuse('plan-scope-invalid', 'slice must be one safe path segment');
  const output = { milestone: scope.milestone, slice: scope.slice };
  if (scope.owner !== undefined) {
    output.owner = ownerKey(scope.owner);
    if (!output.owner) refuse('plan-scope-invalid', 'owner must be an absolute path');
  }
  if (scope.validation_key !== undefined) {
    if (!opaqueKey(scope.validation_key)) refuse('plan-scope-invalid', 'validation_key must be a transaction key');
    output.validation_key = scope.validation_key;
  }
  if (scope.known !== undefined) {
    if (!isObject(scope.known)) refuse('plan-scope-invalid', 'known must be the collected owner slice plan');
    output.known = scope.known;
  }
  return output;
}

// The task IDs an S-plan lists, in order (forge-status parsePlanTasks, mirrored).
function listedTaskIds(text) {
  const ids = [];
  for (const match of String(text).matchAll(new RegExp(PLAN_TASK_LINE, 'gm'))) ids.push(match[2]);
  return ids;
}
function planList(text, label) {
  const ids = listedTaskIds(text);
  if (!ids.length) refuse('plan-task-list-empty', `${label} lists no task`);
  const seen = new Set();
  for (const id of ids) {
    if (!taskId(id)) refuse('plan-task-id-invalid', `${label} lists an invalid task id ${shortId(id)}`);
    if (seen.has(id)) refuse('plan-task-id-duplicate', `${label} lists ${id} twice`);
    seen.add(id);
  }
  return ids;
}

// One plan text: bounded before any allocation, exactly representable as UTF-8 (so
// the bytes the owner writes are the bytes admitted here).
function planBytes(content, label) {
  if (typeof content !== 'string') refuse('plan-candidate-invalid', `${label} content must be a string`);
  if (content.length > MAX_PLAN_BYTES) refuse('plan-source-too-large', `${label} exceeds ${MAX_PLAN_BYTES} bytes`);
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_PLAN_BYTES) refuse('plan-source-too-large', `${label} exceeds ${MAX_PLAN_BYTES} bytes`);
  if (bytes.toString('utf8') !== content) refuse('plan-source-encoding', `${label} is not well-formed UTF-8 text`);
  return bytes;
}
// A collected snapshot carries its own byte digest and path: both must agree.
function sourceEntry(entry, relative, label) {
  const bytes = planBytes(entry.content, label);
  const digest = sha256(bytes);
  if (entry.sha256 !== undefined && entry.sha256 !== digest) refuse('plan-source-inconsistent', `${label} sha256 does not match its content`);
  if (entry.path !== undefined && entry.path !== relative) refuse('plan-source-inconsistent', `${label} path is not ${relative}`);
  return { content: entry.content, path: relative, sha256: digest, bytes: bytes.length };
}
// The returned content: { slice_plan: { content }, task_plans: [{ id, content }] }.
// Other fields (filename, status, summary, a collected owner) grant nothing and are
// not read; the target paths always derive from the scope and the validated ID.
function readPlanSet(value, scope, label, allowEmpty) {
  if (!isObject(value)) refuse('plan-candidate-invalid', `${label} must be an object`);
  if (!isObject(value.slice_plan)) refuse('plan-candidate-invalid', `${label}.slice_plan must be an object`);
  if (!Array.isArray(value.task_plans) || (!allowEmpty && !value.task_plans.length)) {
    refuse('plan-candidate-invalid', `${label}.task_plans must be a non-empty array`);
  }
  const slicePlan = sourceEntry(value.slice_plan, slicePlanPath(scope), `${label}.slice_plan`);
  const tasks = new Map();
  value.task_plans.forEach((entry, index) => {
    const at = `${label}.task_plans[${index}]`;
    if (!isObject(entry)) refuse('plan-candidate-invalid', `${at} must be an object`);
    if (!taskId(entry.id)) refuse('plan-task-id-invalid', `${at}.id must be a local task id (T##, T##.#)`);
    if (tasks.has(entry.id)) refuse('plan-task-id-duplicate', `${label} returns ${entry.id} twice`);
    tasks.set(entry.id, { id: entry.id, ...sourceEntry(entry, taskPlanPath(scope, entry.id), at) });
  });
  return { slicePlan, tasks };
}

function assertMustHaves(task) {
  const { hasStructuredMustHaves, parseMustHaves } = must();
  if (!hasStructuredMustHaves(task.content)) {
    refuse('plan-must-haves-legacy', `${task.id} is legacy — a new task plan must carry a structured must_haves block`, { task_id: task.id });
  }
  try { parseMustHaves(task.content); }
  catch (error) {
    refuse('plan-must-haves-invalid', `${task.id} must_haves invalid: ${error && error.message}`,
      { task_id: task.id, cause_code: error && error.code ? error.code : null });
  }
}
function strictDeclarations(task) {
  try { return must().validateTaskDeclarations(task.content, { taskId: task.id, requireExplicit: true }); }
  catch (error) {
    if (!error || typeof error.code !== 'string' || !error.code.startsWith('plan-declaration-')) throw error;
    return refuse(error.code, `${task.id}: ${error.detail}`, { task_id: task.id, errors: copy(error.errors || []) });
  }
}
// A known, unaltered task of an addition: explicit declarations, or a genuine
// historical plan whose depends/writes are only absent (legacy, never backfilled).
// Anything malformed in the known set refuses the addition.
function knownDeclarations(task) {
  try { return { declarations: must().validateTaskDeclarations(task.content, { taskId: task.id, requireExplicit: true }), legacy: false }; }
  catch (error) {
    const errors = error && Array.isArray(error.errors) ? error.errors : [];
    if (errors.length && errors.every(entry => entry && LEGACY_ABSENCE.includes(entry.code))) return { declarations: null, legacy: true };
    return refuse('plan-known-invalid', `${task.id}: ${error && error.code ? error.code : 'unreadable declarations'}`, { task_id: task.id });
  }
}

// ── Pure admission ────────────────────────────────────────────────────────────

/**
 * Pure admission of a newly generated slice plan.
 *
 * Complete creation (no `scope.known`): the candidate holds the S-plan and every
 * task plan it lists. Addition (`scope.known`, the collected current owner plan):
 * the candidate holds the new S-plan and exactly the new or altered task plans;
 * every known task stays listed in its order, unaltered tasks are taken from the
 * known set and every reference is checked against the final known set. The known
 * set never loosens the candidate: each returned task is admitted strictly.
 *
 * @param {{ slice_plan: { content: string }, task_plans: Array<{ id: string, content: string }> }} candidate
 * @param {{ owner: string, milestone: string, slice: string, known?: object }} scope
 * @returns {object} deep-frozen evidence; it authorizes nothing and is never saved here
 */
function validateNewSlicePlan(candidate, scope) {
  const input = scopeOf(scope, ['owner', 'milestone', 'slice', 'known'], ['owner', 'milestone', 'slice']);
  const addition = input.known !== undefined;
  const returned = readPlanSet(candidate, input, 'candidate', false);
  const known = addition ? readPlanSet(input.known, input, 'known', true) : null;
  // 1. Strict product admission first, per returned task (the existing must_haves messages).
  for (const task of returned.tasks.values()) assertMustHaves(task);
  // 2. Canonical membership: the S-plan list against the returned (and known) plans.
  const listed = planList(returned.slicePlan.content, 'slice plan');
  const finalTasks = new Map(), added = [], altered = [];
  if (!addition) {
    const missing = listed.filter(id => !returned.tasks.has(id)), extra = [...returned.tasks.keys()].filter(id => !listed.includes(id));
    if (missing.length || extra.length) {
      refuse('plan-task-list-mismatch', `slice plan lists [${listed.join(', ')}] but task plans are [${[...returned.tasks.keys()].join(', ')}]`,
        { missing, extra });
    }
    for (const id of listed) { finalTasks.set(id, returned.tasks.get(id)); added.push(id); }
  } else {
    const knownListed = planList(known.slicePlan.content, 'known slice plan');
    const knownIds = [...known.tasks.keys()];
    if (knownListed.length !== knownIds.length || knownListed.some(id => !known.tasks.has(id))) {
      refuse('plan-known-invalid', 'known slice plan list does not match its task plans');
    }
    const removed = knownListed.filter(id => !listed.includes(id));
    if (removed.length) refuse('plan-addition-task-removed', `an addition keeps every known task listed (removed: ${removed.join(', ')})`, { removed });
    if (listed.filter(id => known.tasks.has(id)).join('\n') !== knownListed.join('\n')) {
      refuse('plan-addition-order-changed', 'an addition keeps the known tasks in their order');
    }
    const unlisted = [...returned.tasks.keys()].filter(id => !listed.includes(id));
    if (unlisted.length) refuse('plan-task-list-mismatch', `returned task plans are not listed: ${unlisted.join(', ')}`, { missing: [], extra: unlisted });
    for (const id of listed) {
      const fresh = returned.tasks.get(id), prior = known.tasks.get(id);
      if (!fresh && !prior) refuse('plan-task-list-mismatch', `listed task ${id} has no plan`, { missing: [id], extra: [] });
      if (fresh && prior && fresh.sha256 === prior.sha256) refuse('plan-addition-unaltered', `${id} is returned unaltered`, { task_id: id });
      if (fresh) (prior ? altered : added).push(id);
      finalTasks.set(id, fresh || prior);
    }
  }
  // 3. Explicit declarations: strict for every returned task; known tasks keep theirs.
  const declarations = new Map(), legacy = [];
  for (const id of listed) {
    const task = finalTasks.get(id);
    if (returned.tasks.has(id)) declarations.set(id, strictDeclarations(task));
    else {
      const read = knownDeclarations(task);
      declarations.set(id, read.declarations);
      if (read.legacy) legacy.push(id);
    }
  }
  // 4. The pure task graph over the canonical S-plan set.
  const rows = listed.map(id => {
    const entry = declarations.get(id);
    return entry ? { id, depends: [...entry.depends], writes: copy(entry.writes) } : { id, depends: null, writes: null };
  });
  const dag = parallel().validateTaskDag(rows, { scopeTaskIds: [...listed], legacyPolicy: addition ? 'sequential' : 'refuse' });
  if (dag.status === 'invalid' || (!addition && dag.status !== 'valid')) {
    refuse('plan-dag-invalid', dag.diagnostics.slice(0, 10).join(', ') || dag.status, { diagnostics: [...dag.diagnostics] });
  }
  const evidence = {
    schema: 'forge-plan-admission-v1',
    kind: addition ? 'addition' : 'complete',
    requirement: REQUIREMENT,
    requirement_sha256: REQUIREMENT_SHA256,
    owner: input.owner,
    milestone: input.milestone,
    slice: input.slice,
    source: {
      slice_plan: { path: returned.slicePlan.path, sha256: returned.slicePlan.sha256, bytes: returned.slicePlan.bytes },
      task_plans: listed.map(id => {
        const task = finalTasks.get(id);
        return { id, path: task.path, sha256: task.sha256, bytes: task.bytes };
      }),
    },
    task_ids: [...dag.task_ids],
    declarations: listed.map(id => copy(declarations.get(id))),
    edges: copy(dag.edges),
    topological_order: dag.topological_order ? [...dag.topological_order] : null,
    graph_status: dag.status,
    graph_sha256: dag.graph_sha256,
    legacy_task_ids: [...dag.legacy_task_ids],
    added_task_ids: added,
    altered_task_ids: altered,
  };
  evidence.semantic_sha256 = semanticDigest(evidence);
  return deepFreeze(evidence);
}

/**
 * The semantic digest of admitted evidence (validateNewSlicePlan output or a
 * plan_validation record): requirement, milestone/slice, the ordered membership and
 * each task's decoded depends, writes and roots. Checkbox state, repair_count,
 * SUMMARY files, prose, comments, quoting, YAML layout and EOL never count.
 */
function semanticDigest(evidence) {
  if (!isObject(evidence) || !Array.isArray(evidence.task_ids) || !Array.isArray(evidence.declarations)
      || evidence.task_ids.length !== evidence.declarations.length
      || typeof evidence.requirement !== 'string' || !safeId(evidence.milestone) || !safeId(evidence.slice)) {
    throw new TypeError('semanticDigest requires admission evidence or a plan_validation record');
  }
  return digestOf({
    schema: 'forge-plan-semantic-v1',
    requirement: evidence.requirement,
    milestone: evidence.milestone,
    slice: evidence.slice,
    task_ids: evidence.task_ids,
    declarations: evidence.declarations.map((entry, index) => (entry === null
      ? { task_id: evidence.task_ids[index], legacy: true }
      : { task_id: entry.task_id, depends: entry.depends, writes: entry.writes, roots_schema: entry.roots_schema,
        primary_root_id: entry.primary_root_id, declared_roots: entry.declared_roots })),
  });
}

// ── Pure builders and verifiers ───────────────────────────────────────────────

function generationFields(input, code) {
  const owner = ownerKey(input.owner);
  if (!owner) refuse(code, 'owner must be an absolute path');
  if (!safeId(input.milestone)) refuse(code, 'milestone must be one safe path segment');
  if (!safeId(input.slice)) refuse(code, 'slice must be one safe path segment');
  if (!opaqueKey(input.begin_key)) refuse(code, 'begin_key must be the plan-slice begin transaction key');
  if (!opaqueKey(input.lease_generation)) refuse(code, 'lease_generation must be the begin lease generation');
  if (typeof input.owner_digest !== 'string' || !OWNER_DIGEST.test(input.owner_digest)) refuse(code, 'owner_digest must be sha256:<hex>');
  return { owner, milestone: input.milestone, slice: input.slice, begin_key: input.begin_key,
    lease_generation: input.lease_generation, owner_digest: input.owner_digest };
}
function generationKeyOf(fields) {
  return digestOf({ schema: 'forge-plan-generation-v1', requirement: REQUIREMENT, requirement_sha256: REQUIREMENT_SHA256, ...fields });
}

/**
 * The durable plan_generation enrollment of one plan-slice begin (pure): the owner
 * physical key, milestone/slice, the begin transaction key, its lease generation and
 * owner digest. generation_key binds them all and the current requirement.
 */
function buildPlanGeneration(input) {
  const code = 'plan-generation-invalid';
  if (!isObject(input)) refuse(code, 'plan_generation input must be an object');
  for (const key of Object.keys(input)) if (!GENERATION_INPUT_KEYS.includes(key)) refuse(code, `unknown plan_generation field ${key}`);
  const fields = generationFields(input, code);
  return deepFreeze({
    schema_version: 1, requirement: REQUIREMENT, generation_key: generationKeyOf(fields),
    owner: fields.owner, milestone: fields.milestone, slice: fields.slice, begin_key: fields.begin_key,
    lease_generation: fields.lease_generation, owner_digest: fields.owner_digest, requirement_sha256: REQUIREMENT_SHA256,
  });
}
function verifyPlanGeneration(record, expected) {
  const code = 'plan-generation-invalid';
  if (!isObject(record)) refuse(code, 'plan_generation must be an object');
  exactKeys(record, GENERATION_KEYS, code, 'plan_generation');
  if (record.schema_version !== 1) refuse(code, 'schema_version must be 1');
  if (record.requirement !== REQUIREMENT) refuse(code, `requirement must be ${REQUIREMENT}`);
  if (record.requirement_sha256 !== REQUIREMENT_SHA256) refuse(code, 'requirement_sha256 is not the current requirement');
  const fields = generationFields(record, code);
  if (fields.owner !== record.owner) refuse(code, 'owner is not in canonical key form');
  if (record.generation_key !== generationKeyOf(fields)) refuse(code, 'generation_key does not bind this enrollment');
  if (expected !== undefined) {
    if (!isObject(expected)) throw new TypeError('verifyPlanGeneration expectation must be an object');
    for (const key of Object.keys(expected)) {
      if (![...GENERATION_INPUT_KEYS, 'generation_key'].includes(key)) throw new TypeError(`unknown plan_generation expectation ${key}`);
      if (record[key] !== (key === 'owner' ? ownerKey(expected.owner) : expected[key])) refuse(code, `${key} does not match the expected enrollment`);
    }
  }
  return deepFreeze(copy(record));
}
// Storage-level integrity of a stored enrollment (forge-unit-controller validateRecord):
// the closed field set, the generation_key recomposed from the record's OWN requirement
// fields, and its binding to the transaction that carries it. Unlike verifyPlanGeneration
// it never asks whether the requirement is the current one: a record admitted under
// earlier rules stays readable history and simply never verifies as current.
const INTEGRITY_BINDING_KEYS = Object.freeze(['begin_key', 'lease_generation', 'owner_digest', 'milestone', 'slice']);
function planGenerationIntegrity(record, binding) {
  if (binding !== undefined && (!isObject(binding) || Object.keys(binding).some(key => !INTEGRITY_BINDING_KEYS.includes(key)))) {
    throw new TypeError(`planGenerationIntegrity binds only ${INTEGRITY_BINDING_KEYS.join(', ')}`);
  }
  if (!isObject(record)) return false;
  const actual = Object.keys(record).sort(), wanted = [...GENERATION_KEYS].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) return false;
  if (record.schema_version !== 1 || typeof record.requirement !== 'string' || !record.requirement
      || typeof record.requirement_sha256 !== 'string' || !SHA256_HEX.test(record.requirement_sha256)) return false;
  let fields;
  try { fields = generationFields(record, 'plan-generation-invalid'); } catch (_) { return false; }
  if (fields.owner !== record.owner) return false;
  const recomposed = digestOf({ schema: 'forge-plan-generation-v1', requirement: record.requirement,
    requirement_sha256: record.requirement_sha256, ...fields });
  if (record.generation_key !== recomposed) return false;
  return Object.entries(binding || {}).every(([key, value]) => record[key] === value);
}

function checkSourceRef(entry, relative, keys, code, label) {
  if (!isObject(entry)) refuse(code, `${label} must be an object`);
  exactKeys(entry, keys, code, label);
  if (entry.path !== relative) refuse(code, `${label}.path must be ${relative}`);
  if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) refuse(code, `${label}.sha256 must be a sha256`);
}
// A write as validateTaskDeclarations admits it: `path`, `root::path` or exactly
// { root_id, path }, with the #348 product-path policy (forge-code-roots assertRelative).
function admittedWrite(item) {
  let relative;
  if (typeof item === 'string') {
    const at = item.indexOf('::');
    if (at >= 0 && !ROOT_ID.test(item.slice(0, at))) return false;
    relative = at >= 0 ? item.slice(at + 2) : item;
  } else if (isObject(item) && Object.keys(item).sort().join(',') === 'path,root_id'
      && typeof item.root_id === 'string' && ROOT_ID.test(item.root_id) && typeof item.path === 'string') {
    relative = item.path;
  } else return false;
  try { codeRoots().assertRelative(relative); return true; } catch (_) { return false; }
}
// forge-must-haves validateTaskDeclarations declaration_sha256 recipe: plain JSON in
// its insertion order, rebuilt here so a stored record's key order cannot matter.
function declarationDigestOf(entry) {
  return sha256(JSON.stringify({
    schema: 'forge-task-declarations-v1',
    depends: entry.depends,
    writes: entry.writes.map(item => (typeof item === 'string' ? item : { root_id: item.root_id, path: item.path })),
    roots_schema: entry.roots_schema,
    primary_root_id: entry.primary_root_id,
    declared_roots: entry.declared_roots === null ? null : entry.declared_roots.map(root => ({ id: root.id, path: root.path, vcs: root.vcs })),
  }));
}
function checkDeclaration(entry, id, code) {
  const label = `declarations[${id}]`;
  if (!isObject(entry)) refuse(code, `${label} must be an explicit declaration`);
  exactKeys(entry, DECLARATION_KEYS, code, label);
  if (entry.task_id !== id) refuse(code, `${label}.task_id must be ${id}`);
  if (!Array.isArray(entry.depends) || entry.depends.some(item => !taskId(item)) || new Set(entry.depends).size !== entry.depends.length) {
    refuse(code, `${label}.depends invalid`);
  }
  if (!Array.isArray(entry.writes) || entry.writes.some(item => !admittedWrite(item))) refuse(code, `${label}.writes invalid`);
  for (const key of ['roots_schema', 'primary_root_id']) {
    if (entry[key] !== null && typeof entry[key] !== 'string') refuse(code, `${label}.${key} invalid`);
  }
  if (entry.declared_roots !== null && (!Array.isArray(entry.declared_roots) || entry.declared_roots.some(root => !isObject(root)
      || Object.keys(root).sort().join(',') !== 'id,path,vcs' || ['id', 'path', 'vcs'].some(key => root[key] !== null && typeof root[key] !== 'string')))) {
    refuse(code, `${label}.declared_roots invalid`);
  }
  if (entry.declaration_sha256 !== declarationDigestOf(entry)) refuse(code, `${label}.declaration_sha256 does not bind the declaration`);
}
function validationDigestOf(record) {
  const content = { schema: 'forge-plan-validation-v1' };
  for (const key of VALIDATION_KEYS) if (key !== 'validation_sha256' && key !== 'validated_at') content[key] = record[key];
  return digestOf(content);
}

/**
 * The plan_validation evidence of one complete plan-slice generation (pure): the
 * admission bound to its plan_generation. validated_at is an observation only and
 * never part of validation_sha256. Additions are owner amendments (U0e), not this record.
 */
function buildPlanValidation(generation, admission, options) {
  const code = 'plan-validation-invalid';
  const enrolled = verifyPlanGeneration(generation);
  if (!isObject(admission) || admission.schema !== 'forge-plan-admission-v1' || !isObject(admission.source)
      || !isObject(admission.source.slice_plan) || !Array.isArray(admission.source.task_plans)
      || !Array.isArray(admission.declarations) || !Array.isArray(admission.task_ids) || !Array.isArray(admission.edges)) {
    refuse(code, 'admission evidence from validateNewSlicePlan is required');
  }
  if (admission.kind !== 'complete' || admission.graph_status !== 'valid') refuse(code, 'plan_validation binds one complete, valid plan-slice generation');
  const validatedAt = isoInstant(options && options.validatedAt);
  if (!validatedAt) refuse(code, 'validatedAt must be a canonical ISO-8601 instant');
  for (const key of ['owner', 'milestone', 'slice', 'requirement', 'requirement_sha256']) {
    if (admission[key] !== enrolled[key]) refuse(code, `${key} of the admission does not match its plan_generation`);
  }
  const record = {
    requirement: REQUIREMENT,
    generation_key: enrolled.generation_key,
    requirement_sha256: REQUIREMENT_SHA256,
    owner: enrolled.owner,
    milestone: enrolled.milestone,
    slice: enrolled.slice,
    begin_key: enrolled.begin_key,
    source: {
      slice_plan: { path: admission.source.slice_plan.path, sha256: admission.source.slice_plan.sha256 },
      task_plans: admission.source.task_plans.map(entry => (isObject(entry) ? { id: entry.id, path: entry.path, sha256: entry.sha256 } : entry)),
    },
    declarations: copy(admission.declarations),
    task_ids: [...admission.task_ids],
    edges: copy(admission.edges),
    graph_sha256: admission.graph_sha256,
  };
  record.validation_sha256 = validationDigestOf(record);
  record.validated_at = validatedAt;
  return verifyPlanValidation(record, enrolled);
}
// Verifies a stored record by recomputation: canonical paths, aligned source and
// declarations, every declaration re-admitted, the graph recomputed from them and
// the record digest. A JSON flag, an extra field or a forged digest never verifies.
function verifyPlanValidation(record, generation) {
  const code = 'plan-validation-invalid';
  if (!isObject(record)) refuse(code, 'plan_validation must be an object');
  exactKeys(record, VALIDATION_KEYS, code, 'plan_validation');
  if (record.requirement !== REQUIREMENT || record.requirement_sha256 !== REQUIREMENT_SHA256) refuse(code, 'requirement is not the current requirement');
  if (typeof record.generation_key !== 'string' || !SHA256_HEX.test(record.generation_key)) refuse(code, 'generation_key must be a sha256');
  const owner = ownerKey(record.owner);
  if (!owner || owner !== record.owner) refuse(code, 'owner must be a canonical owner key');
  if (!safeId(record.milestone) || !safeId(record.slice)) refuse(code, 'milestone/slice must be safe path segments');
  if (!opaqueKey(record.begin_key)) refuse(code, 'begin_key must be a transaction key');
  if (!isoInstant(record.validated_at)) refuse(code, 'validated_at must be a canonical ISO-8601 instant');
  const ids = record.task_ids;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !taskId(id)) || new Set(ids).size !== ids.length) {
    refuse(code, 'task_ids must be the ordered unique slice membership');
  }
  const scope = { milestone: record.milestone, slice: record.slice };
  if (!isObject(record.source)) refuse(code, 'source must be an object');
  exactKeys(record.source, ['slice_plan', 'task_plans'], code, 'source');
  checkSourceRef(record.source.slice_plan, slicePlanPath(scope), ['path', 'sha256'], code, 'source.slice_plan');
  if (!Array.isArray(record.source.task_plans) || record.source.task_plans.length !== ids.length) refuse(code, 'source.task_plans must follow task_ids');
  record.source.task_plans.forEach((entry, index) => {
    if (!isObject(entry) || entry.id !== ids[index]) refuse(code, `source.task_plans[${index}] must follow task_ids`);
    checkSourceRef(entry, taskPlanPath(scope, ids[index]), ['id', 'path', 'sha256'], code, `source.task_plans[${index}]`);
  });
  if (!Array.isArray(record.declarations) || record.declarations.length !== ids.length) refuse(code, 'declarations must follow task_ids');
  record.declarations.forEach((entry, index) => checkDeclaration(entry, ids[index], code));
  const dag = parallel().validateTaskDag(record.declarations.map(entry => ({ id: entry.task_id, depends: [...entry.depends], writes: copy(entry.writes) })),
    { scopeTaskIds: [...ids] });
  if (dag.status !== 'valid') refuse(code, `declarations do not form a valid graph: ${dag.diagnostics.slice(0, 5).join(', ')}`);
  if (!Array.isArray(record.edges) || digestOf(dag.edges) !== digestOf(record.edges)) refuse(code, 'edges do not follow the declarations');
  if (typeof record.graph_sha256 !== 'string' || dag.graph_sha256 !== record.graph_sha256) refuse(code, 'graph_sha256 does not follow the declarations');
  if (record.validation_sha256 !== validationDigestOf(record)) refuse(code, 'validation_sha256 does not bind the record');
  if (generation !== undefined) {
    const enrolled = verifyPlanGeneration(generation);
    for (const key of ['generation_key', 'owner', 'milestone', 'slice', 'begin_key', 'requirement', 'requirement_sha256']) {
      if (record[key] !== enrolled[key]) refuse(code, `${key} does not match its plan_generation`);
    }
  }
  return deepFreeze(copy(record));
}

// ── Owner collector (read-only) ───────────────────────────────────────────────

// The readTaskPlan walk (forge-unit-controller): every component from the owner down
// is a real directory and the plan a regular file; a symlink or junction anywhere
// refuses. `any` probes only existence of the last component (any type).
function walk(base, segments, last) {
  let cursor = base;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { return { status: error && error.code === 'ENOENT' ? 'missing' : 'unreadable', file: cursor }; }
    const final = index === segments.length - 1;
    if (final && last === 'any') return { status: 'present', file: cursor };
    if (stat.isSymbolicLink()) return { status: 'link', file: cursor };
    if (final) return stat.isFile() ? { status: 'ok', file: cursor, stat } : { status: 'not-regular', file: cursor };
    if (!stat.isDirectory()) return { status: 'not-regular', file: cursor };
  }
  return { status: 'missing', file: cursor };
}
function sourceRefusal(reason, relative) {
  return refuse(SOURCE_REFUSALS[reason] || 'plan-source-unreadable', `${relative} (${reason})`, { path: relative });
}
function readOwnerPlan(base, real, segments, relative, io) {
  const found = walk(base, segments, 'file');
  if (found.status !== 'ok') sourceRefusal(found.status, relative);
  const expected = path.join(real, ...segments);
  const read = boundedReader().readBoundedStableFile(found.file, MAX_PLAN_BYTES, io ? { io, expectedReal: expected } : { expectedReal: expected });
  if (read.error) sourceRefusal(read.error === 'source_too_large' ? 'too-large' : 'unstable', relative);
  // The path observation taken before the read must describe the bytes read.
  if (found.stat.size !== read.buffer.length) sourceRefusal('unstable', relative);
  let content;
  // Fatal UTF-8; the BOM stays in the text, so the text re-encodes to the exact bytes.
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.buffer); }
  catch (_) { sourceRefusal('encoding', relative); }
  return { segments, path: relative, content, sha256: sha256(read.buffer), bytes: read.buffer.length, stat: found.stat };
}
// After every read: each collected plan is still the same regular file, unchanged.
// Both observations come from the same path walk (lstat), never fd against path.
function unchanged(base, entry) {
  const found = walk(base, entry.segments, 'file');
  if (found.status !== 'ok') return false;
  const now = found.stat, then = entry.stat;
  return now.dev === then.dev && now.ino === then.ino && now.size === then.size
    && now.mtimeMs === then.mtimeMs && now.ctimeMs === then.ctimeMs;
}

/**
 * Bounded, stable read of the owner's S-plan and of exactly the T-plans it lists
 * (canonical nested layout). Never reads STATE or a ledger as a queue, never lists a
 * directory and never scans other runs. `options.io` is a test seam for the bounded
 * reader's file-system module only; the path walk always uses the real file system.
 *
 * @returns {{ owner, milestone, slice, slice_plan: { path, content, sha256, bytes },
 *   task_plans: Array<{ id, path, content, sha256, bytes }> }} deep-frozen
 */
function collectOwnerSlicePlan(cwd, scope, options) {
  const input = scopeOf(scope, ['owner', 'milestone', 'slice'], ['milestone', 'slice']);
  if (options !== undefined && (!isObject(options) || Object.keys(options).some(key => key !== 'io'))) {
    throw new TypeError('collectOwnerSlicePlan options carry only the { io } test seam');
  }
  const io = options && options.io;
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) refuse('plan-source-owner-unreadable', 'cwd must be the owner directory');
  let real;
  try {
    real = fs.realpathSync.native(cwd);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch (_) { refuse('plan-source-owner-unreadable', 'the owner root is not a readable directory'); }
  const owner = codeRoots().key(real);
  if (input.owner !== undefined && input.owner !== owner) refuse('plan-source-owner-mismatch', 'scope owner is not the physical owner of cwd');
  const base = path.resolve(cwd);
  const sliceSegments = ['.gsd', 'milestones', input.milestone, 'slices', input.slice];
  const slicePlan = readOwnerPlan(base, real, [...sliceSegments, `${input.slice}-PLAN.md`], slicePlanPath(input), io);
  const ids = planList(slicePlan.content, slicePlan.path);
  const tasks = [];
  for (const id of ids) {
    const relative = taskPlanPath(input, id);
    // One source per task: a flat legacy tasks/T##-PLAN.md beside (or instead of) the
    // nested plan is ambiguous and refuses, as the sidecar publisher refuses it.
    const flat = walk(base, [...sliceSegments, 'tasks', `${id}-PLAN.md`], 'any');
    if (flat.status === 'present') {
      const nested = walk(base, [...sliceSegments, 'tasks', id, `${id}-PLAN.md`], 'any');
      if (nested.status === 'present') refuse('plan-source-layout-conflict', `${relative} has a second flat source`, { path: relative });
      refuse('plan-source-legacy-layout', `${id} has only the flat legacy plan`, { path: relative });
    }
    if (flat.status !== 'missing') sourceRefusal(flat.status, relative);
    tasks.push({ id, ...readOwnerPlan(base, real, [...sliceSegments, 'tasks', id, `${id}-PLAN.md`], relative, io) });
  }
  for (const entry of [slicePlan, ...tasks]) if (!unchanged(base, entry)) sourceRefusal('unstable', entry.path);
  return deepFreeze({
    owner,
    milestone: input.milestone,
    slice: input.slice,
    slice_plan: { path: slicePlan.path, content: slicePlan.content, sha256: slicePlan.sha256, bytes: slicePlan.bytes },
    task_plans: tasks.map(task => ({ id: task.id, path: task.path, content: task.content, sha256: task.sha256, bytes: task.bytes })),
  });
}

// The collector's refusals as the reasons of a status-coded single-plan read.
const SOURCE_REASONS = Object.freeze({ 'plan-source-missing': 'missing', 'plan-source-link': 'link',
  'plan-source-not-regular': 'not-regular', 'plan-source-unreadable': 'path-unreadable', 'plan-source-too-large': 'too-large',
  'plan-source-unstable': 'unstable', 'plan-source-encoding': 'encoding', 'plan-source-owner-unreadable': 'owner-unreadable' });
/**
 * The collector's bounded, stable read of ONE owner T-plan at its canonical nested
 * path (the same walk, bound, re-observation and fatal UTF-8 decode), status-coded
 * instead of throwing, for the controller's task DAG (forge-unit-controller
 * readTaskPlan). The text keeps a leading BOM, as the collector does.
 *
 * @returns {{ status: 'ok', path, content, sha256, bytes } | { status: 'missing' } | { status: 'invalid', reason }}
 */
function readOwnerTaskPlan(cwd, scope) {
  if (!isObject(scope) || Object.keys(scope).some(key => !['milestone', 'slice', 'task'].includes(key))) {
    throw new TypeError('readOwnerTaskPlan scope is exactly { milestone, slice, task }');
  }
  if (!safeId(scope.milestone) || !safeId(scope.slice) || !taskId(scope.task)) return { status: 'invalid', reason: 'path-invalid' };
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) return { status: 'invalid', reason: 'owner-unreadable' };
  let real;
  try { real = fs.realpathSync.native(cwd); } catch (_) { return { status: 'invalid', reason: 'owner-unreadable' }; }
  const base = path.resolve(cwd), relative = taskPlanPath(scope, scope.task);
  const segments = ['.gsd', 'milestones', scope.milestone, 'slices', scope.slice, 'tasks', scope.task, `${scope.task}-PLAN.md`];
  try {
    const entry = readOwnerPlan(base, real, segments, relative);
    if (!unchanged(base, entry)) return { status: 'invalid', reason: 'unstable' };
    return { status: 'ok', path: relative, content: entry.content, sha256: entry.sha256, bytes: entry.bytes };
  } catch (error) {
    const reason = error && SOURCE_REASONS[error.code];
    if (!reason) throw error;
    return reason === 'missing' ? { status: 'missing' } : { status: 'invalid', reason };
  }
}

// ── Current generation (read-only) ────────────────────────────────────────────

function codeOf(error) { return error && typeof error.code === 'string' && error.code ? error.code : 'error'; }

/**
 * Read-only recheck of an enrolled plan-slice generation: the committed successful
 * completion named by `validation_key` carries plan_validation inside its normalized
 * result (covered by boundary.result_checksum; a top-level alias is refused, never
 * read as a fallback), the committed begin it names carries plan_generation, both are
 * one lineage of this owner, and the current owner plan, admitted again, keeps the
 * admitted semantic digest: the plan_validation digest, or the digest of the last owner
 * amendment (add-task, decompose: U0e) admitted over exactly this generation. An open
 * amendment of this generation refuses (plan-mutation-pending) until it is admitted.
 * Writes nothing. A storage-level conflict (checksum or identity) is
 * plan-generation-evidence-invalid with cause_code record-conflict; evidence that is
 * consistently stored but invalid reaches the evidence verifiers and their codes.
 */
function assertCurrentGeneration(cwd, scope) {
  // Preserve the explicit key's existing structural/lineage diagnostics, then
  // independently require that it still names the current canonical lineage.
  const verified = verifyCompletedGeneration(cwd, scope);
  const classified = classifySliceGeneration(cwd, { owner: verified.owner,
    milestone: verified.milestone, slice: verified.slice });
  if (classified.status === 'open') refuse('plan-generation-pending', 'a newer enrolled plan-slice generation has not completed');
  if (classified.status !== 'completed') refuse('plan-generation-completion-missing', 'the enrolled plan-slice generation has no successful completion');
  if (classified.validation_key !== verified.validation_key) {
    refuse('plan-generation-lineage-mismatch', 'validation_key does not name the current completed plan-slice lineage');
  }
  return verified;
}
// Private verification of one completed lineage by key. It does not classify or
// promise currentness; the public current-key and shared execute gates do that.
function verifyCompletedGeneration(cwd, scope) {
  const input = scopeOf(scope, ['owner', 'milestone', 'slice', 'validation_key'], ['milestone', 'slice', 'validation_key']);
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) refuse('plan-source-owner-unreadable', 'cwd must be the owner directory');
  const records = controller();
  const unitKey = `plan-slice/${input.slice}`;
  const lookup = key => {
    try { return records.lookupRecord(cwd, 'transaction', key); }
    catch (error) {
      return refuse('plan-generation-evidence-invalid', `transaction record unreadable (${codeOf(error)})`, { cause_code: codeOf(error) });
    }
  };
  const completion = lookup(input.validation_key);
  if (!completion) refuse('plan-generation-evidence-missing', 'no committed plan-slice completion for validation_key');
  if (completion.phase !== 'committed' || completion.action !== 'complete' || completion.milestone !== input.milestone
      || !isObject(completion.unit) || completion.unit.key !== unitKey || !isObject(completion.result) || completion.result.status !== 'succeeded'
      || !isObject(completion.boundary) || completion.boundary.kind !== 'completed' || completion.boundary.handoff_ready !== true) {
    refuse('plan-generation-evidence-invalid', `validation_key is not a committed successful completion of ${unitKey}`);
  }
  if (own(completion, TRANSACTION_FIELDS.validation)) {
    refuse('plan-generation-evidence-invalid', 'a top-level plan_validation alias is never evidence; only completion.result carries it');
  }
  if (!own(completion.result, TRANSACTION_FIELDS.validation)) refuse('plan-generation-evidence-missing', 'the completion result carries no plan_validation');
  // The controller's own result checksum (sha256 of the sorted-key JSON) covers the evidence.
  if (digestOf(completion.result) !== completion.boundary.result_checksum) {
    refuse('plan-generation-evidence-invalid', 'plan_validation is not covered by the completion result checksum', { cause_code: 'record-conflict' });
  }
  const validation = verifyPlanValidation(completion.result[TRANSACTION_FIELDS.validation]);
  const begin = lookup(validation.begin_key);
  if (!begin) refuse('plan-generation-evidence-missing', 'the enrolled plan-slice begin is missing');
  if (begin.phase !== 'committed' || begin.action !== 'begin' || begin.milestone !== input.milestone
      || !isObject(begin.unit) || begin.unit.key !== unitKey) {
    refuse('plan-generation-evidence-invalid', `the enrollment is not a committed begin of ${unitKey}`);
  }
  if (!own(begin, TRANSACTION_FIELDS.generation)) refuse('plan-generation-evidence-missing', 'the begin carries no plan_generation');
  const generation = verifyPlanGeneration(begin[TRANSACTION_FIELDS.generation]);
  verifyPlanValidation(validation, generation);
  if (generation.milestone !== input.milestone || generation.slice !== input.slice) refuse('plan-generation-evidence-invalid', 'the enrollment names another slice');
  if (generation.begin_key !== begin.idempotency_key || generation.owner_digest !== begin.owner_digest
      || generation.lease_generation !== begin.lease_generation || completion.owner_digest !== begin.owner_digest
      || completion.lease_generation !== begin.lease_generation || completion.host_runtime !== begin.host_runtime) {
    refuse('plan-generation-lineage-mismatch', 'the completion, its begin and the enrollment are not one lineage');
  }
  let real;
  try { real = fs.realpathSync.native(cwd); } catch (_) { refuse('plan-source-owner-unreadable', 'the owner root is not readable'); }
  const owner = codeRoots().key(real);
  if (generation.owner !== owner || (input.owner !== undefined && input.owner !== owner)) {
    refuse('plan-generation-owner-mismatch', 'the evidence belongs to another owner');
  }
  // U0e: the owner amendments of exactly this generation, read-only. An open one keeps the
  // plan bytes in flux; the last admitted one is the state the current plan must keep.
  const chain = readMutationChain(physicalMutationOwner(cwd), input.milestone, input.slice);
  const base = { kind: 'completed', generation_key: generation.generation_key, validation_key: input.validation_key };
  const open = openIntent(chain, base);
  if (open) {
    refuse('plan-mutation-pending', `${input.slice} has an open ${open.operation} owner mutation of this generation`,
      { mutation_ref: mutationRefOf(open), slice: input.slice });
  }
  const current = collectOwnerSlicePlan(cwd, { milestone: input.milestone, slice: input.slice });
  let admission;
  try { admission = validateNewSlicePlan(current, { owner, milestone: input.milestone, slice: input.slice }); }
  catch (error) {
    refuse('plan-generation-drift', `the current plan is no longer admissible (${error && error.code ? error.code : 'error'})`,
      { cause_code: error && error.code ? error.code : null });
  }
  const amended = amendedAnchor(chain, base, semanticDigest(validation));
  const admitted = amended.semantic_sha256;
  if (admission.semantic_sha256 !== admitted) {
    refuse('plan-generation-drift', 'depends, writes, roots or membership changed since admission',
      { admitted_semantic_sha256: admitted, current_semantic_sha256: admission.semantic_sha256 });
  }
  return deepFreeze({
    status: 'current',
    generation_key: generation.generation_key,
    begin_key: generation.begin_key,
    validation_key: input.validation_key,
    owner,
    milestone: input.milestone,
    slice: input.slice,
    semantic_sha256: admitted,
    graph_sha256: admission.graph_sha256,
    task_ids: [...admission.task_ids],
    source: copy(admission.source),
    ...(amended.admission ? { amendment: { sequence: amended.admission.sequence, admission_sha256: amended.admission.record_sha256,
      operation: amended.admission.operation } } : {}),
  });
}

// ── Canonical enrollment classification (read-only, U0d) ──────────────────────

// Every controller transaction of one milestone, read exactly as the controller's own
// discoverRecords reads them, through its exported read-only seam (the controller's export
// list is pinned by its suites): each stored file is addressed and identified by readJson,
// then fully validated by lookupRecord (identity, checksums, the stored enrollment
// integrity). Nothing is written, locked or repaired. Any unreadable or divergent record refuses.
function milestoneTransactions(cwd, milestone) {
  try {
    const records = controller(), dir = records.transactionDir(cwd), found = new Map();
    if (!fs.existsSync(dir)) return [];
    for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.json')).sort()) {
      const stored = records.readJson(path.join(dir, name));
      if (!isObject(stored) || typeof stored.idempotency_key !== 'string') refuse('plan-generation-evidence-invalid', `transaction record ${name} has no identity`);
      found.set(stored.idempotency_key, records.lookupRecord(cwd, 'transaction', stored.idempotency_key));
    }
    return [...found.values()].filter(record => isObject(record) && record.milestone === milestone && isObject(record.unit));
  } catch (error) {
    if (error && error.code === 'plan-generation-evidence-invalid') throw error;
    return refuse('plan-generation-evidence-invalid', `controller records unreadable (${codeOf(error)})`, { cause_code: codeOf(error) });
  }
}
// The plan-slice slices of one milestone whose begins carry an enrollment.
function enrolledSliceIds(cwd, milestone) {
  const slices = new Set();
  for (const record of milestoneTransactions(cwd, milestone)) {
    if (record.action === 'begin' && record.unit.type === 'plan-slice' && own(record, TRANSACTION_FIELDS.generation)) slices.add(record.unit.id);
  }
  return [...slices].sort();
}

/**
 * Read-only canonical classification of one slice's plan generation, shared by the
 * native first execute (forge-unit-controller), the direct sidecar pre-spawn recheck,
 * the sidecar plan marker and its publisher (forge-unit-sidecar). The source is the
 * controller's own committed records, never a receipt, a file's presence, its age or an
 * imported field:
 *
 *   unenrolled  no plan-slice begin of this slice carries plan_generation: a genuine
 *               pre-requirement slice (or an unlinked producer) keeps its historical
 *               semantics. This is the explicit limit of the seam: without an enrolled
 *               begin nothing here can tell a historical record from a stripped new one.
 *   open        the latest enrolled lineage has begun and has no terminal transition yet;
 *   ended       it ended without a successful completion (pause, fail, expired-safe or a
 *               non-succeeded complete);
 *   completed   it ended with a committed successful completion (validation_key).
 *
 * Lineages are ordered by their published begin events; the latest begin must carry
 * the enrollment (an obligation is never lost to a later unenrolled begin). A pending
 * phase, a begin without its published event, two terminals or begins of one lease
 * generation, and a lineage transaction of another owner or host refuse by name.
 */
function classifySliceGeneration(cwd, scope) {
  const input = scopeOf(scope, ['owner', 'milestone', 'slice'], ['milestone', 'slice']);
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) refuse('plan-source-owner-unreadable', 'cwd must be the owner directory');
  const unitKey = `plan-slice/${input.slice}`;
  const scoped = milestoneTransactions(cwd, input.milestone).filter(record => record.unit.key === unitKey);
  const begins = scoped.filter(record => record.action === 'begin');
  const identity = { milestone: input.milestone, slice: input.slice };
  if (!begins.some(record => own(record, TRANSACTION_FIELDS.generation))) return deepFreeze({ status: 'unenrolled', ...identity });
  if (begins.some(record => record.phase !== 'committed')) refuse('plan-generation-pending', `a ${unitKey} begin is not committed`);
  let events;
  try { events = controller().readEvents(controller().eventsFile(cwd, input.milestone)); }
  catch (error) { refuse('plan-generation-evidence-invalid', `controller events unreadable (${codeOf(error)})`, { cause_code: codeOf(error) }); }
  const sequenceOf = record => {
    const matches = events.map((event, index) => ({ event, index }))
      .filter(row => isObject(row.event) && row.event.idempotency_key === record.idempotency_key);
    if (matches.length > 1) refuse('plan-generation-ambiguous', `a committed ${unitKey} begin has multiple published events`);
    const found = matches[0], event = found && found.event;
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return null;
    const content = { ...event };
    delete content.sequence;
    return digestOf(content) === digestOf(record.event) ? { sequence: event.sequence, index: found.index } : null;
  };
  const ordered = begins.map(record => ({ record, published: sequenceOf(record) }));
  if (ordered.some(row => row.published === null)) refuse('plan-generation-evidence-invalid', `a committed ${unitKey} begin has no published event`);
  if (new Set(ordered.map(row => row.published.sequence)).size !== ordered.length) {
    refuse('plan-generation-ambiguous', `committed ${unitKey} begins share a published sequence`);
  }
  // Check only these controller begin events. Foreign historical rows keep
  // their schema; publishEvent assigns sequence from their actual stream position.
  if (ordered.some(row => row.published.sequence !== row.published.index + 1)) {
    refuse('plan-generation-evidence-invalid', `a committed ${unitKey} begin has a reordered published sequence`);
  }
  ordered.sort((left, right) => left.published.sequence - right.published.sequence);
  const latest = ordered[ordered.length - 1].record;
  if (!own(latest, TRANSACTION_FIELDS.generation)) {
    refuse('plan-generation-evidence-invalid', `the latest ${unitKey} begin carries no enrollment after an enrolled one`);
  }
  if (begins.filter(record => record.lease_generation === latest.lease_generation).length !== 1) {
    refuse('plan-generation-ambiguous', `two ${unitKey} begins share one lease generation`);
  }
  const generation = verifyPlanGeneration(latest[TRANSACTION_FIELDS.generation], { begin_key: latest.idempotency_key,
    lease_generation: latest.lease_generation, owner_digest: latest.owner_digest, milestone: input.milestone, slice: input.slice });
  if (input.owner !== undefined && generation.owner !== input.owner) refuse('plan-generation-owner-mismatch', 'the enrollment belongs to another owner');
  const lineage = scoped.filter(record => record.action !== 'begin' && record.lease_generation === latest.lease_generation);
  if (lineage.some(record => record.phase !== 'committed')) refuse('plan-generation-pending', `the enrolled ${unitKey} lineage has a pending transition`);
  if (lineage.some(record => record.owner_digest !== latest.owner_digest || record.host_runtime !== latest.host_runtime)) {
    refuse('plan-generation-lineage-mismatch', `a transition of the enrolled ${unitKey} lineage belongs to another owner or host`);
  }
  const terminals = lineage.filter(record => TERMINAL_ACTIONS.includes(record.action));
  if (terminals.length > 1) refuse('plan-generation-ambiguous', `the enrolled ${unitKey} lineage has ${terminals.length} terminal transitions`);
  const enrolled = { ...identity, begin_key: latest.idempotency_key, lease_generation: latest.lease_generation,
    generation_key: generation.generation_key, owner: generation.owner };
  if (!terminals.length) return deepFreeze({ status: 'open', ...enrolled });
  const terminal = terminals[0];
  if (terminal.action !== 'complete' || !isObject(terminal.result) || terminal.result.status !== 'succeeded'
      || !isObject(terminal.boundary) || terminal.boundary.kind !== 'completed' || terminal.boundary.handoff_ready !== true) {
    return deepFreeze({ status: 'ended', ...enrolled, terminal_key: terminal.idempotency_key, terminal_action: terminal.action });
  }
  return deepFreeze({ status: 'completed', ...enrolled, validation_key: terminal.idempotency_key });
}

/**
 * The shared execute gate (first execute-task begin and the direct sidecar pre-spawn
 * recheck): an unenrolled slice keeps its historical behavior; an enrolled one needs
 * its latest lineage committed and successfully completed, and then the full
 * assertCurrentGeneration recheck of that completion. `slice: null` (a task whose slice
 * is unknown) passes only when no slice of the milestone is enrolled. U0e: while an owner
 * mutation of the milestone is open over its slice's current base, no new execute-task
 * begins anywhere in the milestone (plan-mutation-pending), across crash and restart,
 * until its admission exists. Writes nothing.
 */
function assertSliceGeneration(cwd, scope) {
  if (isObject(scope) && own(scope, 'slice') && scope.slice === null) {
    const { slice: _unknown, ...rest } = scope;
    if (Object.keys(rest).some(key => !['owner', 'milestone'].includes(key))) refuse('plan-scope-invalid', 'unknown scope field');
    if (!safeId(rest.milestone)) refuse('plan-scope-invalid', 'milestone must be one safe path segment');
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) refuse('plan-source-owner-unreadable', 'cwd must be the owner directory');
    const enrolled = enrolledSliceIds(cwd, rest.milestone);
    if (enrolled.length) refuse('plan-generation-slice-unknown', `the task names no slice while ${enrolled.join(', ')} carry enrolled generations`);
    assertNoOpenMutation(cwd, rest.milestone, null);
    return deepFreeze({ status: 'unenrolled', milestone: rest.milestone, slice: null });
  }
  const classified = classifySliceGeneration(cwd, scope);
  const unitKey = `plan-slice/${classified.slice}`;
  if (classified.status === 'open') refuse('plan-generation-pending', `the enrolled ${unitKey} generation has not completed`);
  if (classified.status === 'ended') {
    refuse('plan-generation-completion-missing', `the enrolled ${unitKey} lineage ended (${classified.terminal_action}) without a successful completion`);
  }
  assertNoOpenMutation(cwd, classified.milestone, classified);
  if (classified.status === 'unenrolled') return classified;
  return verifyCompletedGeneration(cwd, { ...(scope.owner !== undefined ? { owner: scope.owner } : {}), milestone: classified.milestone,
    slice: classified.slice, validation_key: classified.validation_key });
}

// ── Owner plan mutations: the direct creators (U0e) ───────────────────────────
//
// add-task, add-slice and decompose write owner plan bytes directly, outside any planner
// transport or controller completion. Each one is a closed two-step owner amendment:
//
//   beginOwnerPlanMutation  publishes the intent BEFORE the creator writes a plan byte:
//                           the operation, the declared new task IDs (and the decompose
//                           parent), the owner identity, the admitted base the amendment
//                           starts from and the exact before inventory;
//   finishOwnerPlanMutation re-reads that intent, collects the owner bytes, admits every
//                           new task strictly together with the inventory delta and appends
//                           the admission after its intent, with predecessor and checksum.
//
// Nothing here creates a run, a receipt, a lease, a controller record or a fictitious task,
// and no imported approved/legacy flag, file presence or evidence waives the admission.
// While an intent over its slice's current base is open, assertSliceGeneration refuses every
// new execute-task begin of the milestone (plan-mutation-pending), in any process, until the
// admission exists; a refused finish writes nothing and keeps the intent and the candidate
// bytes for correction. An intent whose base was superseded (the slice was planned again) is
// obsolete: it never blocks, never finishes and a new begin may follow it.
//
// One chain per slice: .gsd/forge/plan-validations/<M>/<S>/<NNNN>.json, published once by an
// exclusive hard link from .gsd/forge/plan-validations/.staging (never renamed over, never
// rewritten), under the owner safe boundary of the milestone (forge-milestone-time-selection
// ownerBoundary: pending transactions, open begins and held leases, never age or STATE) and
// then the owner publication lock (forge-artifact-reconciliation withOwnerLock), the order
// the other owner writers use.

const MUTATION_OPERATIONS = Object.freeze(['add-task', 'add-slice', 'decompose']);
const MUTATION_SCHEMA = 'forge-plan-mutation-v1';
const MUTATION_SEGMENTS = Object.freeze(['.gsd', 'forge', 'plan-validations']);
const MUTATION_STAGING = '.staging';
const MUTATION_STAGING_FILE = /^\d{4}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;
// The four-digit sequence of one slice chain (two records per mutation).
const MAX_MUTATION_RECORDS = 4096;
// An intent keeps the before S-plan text (at most MAX_PLAN_BYTES), JSON-escaped, plus the inventory.
const MAX_MUTATION_RECORD_BYTES = 8 * 1024 * 1024;
const MUTATION_REQUEST_KEYS = Object.freeze(['operation', 'milestone', 'slice', 'changedTaskIds', 'parentTaskId', 'ownerBinding']);
const MUTATION_KEYS = Object.freeze({
  intent: Object.freeze(['schema', 'kind', 'sequence', 'previous_sha256', 'operation', 'requirement', 'requirement_sha256', 'owner',
    'owner_identity_sha256', 'milestone', 'slice', 'changed_task_ids', 'parent_task_id', 'base', 'before', 'begun_at', 'record_sha256']),
  admission: Object.freeze(['schema', 'kind', 'sequence', 'previous_sha256', 'operation', 'requirement', 'requirement_sha256', 'owner',
    'milestone', 'slice', 'base', 'evidence', 'admitted_at', 'record_sha256']),
});
const MUTATION_BASE_KEYS = Object.freeze(['kind', 'generation_key', 'validation_key', 'semantic_sha256']);
const MUTATION_EVIDENCE_KEYS = Object.freeze(['kind', 'source', 'task_ids', 'declarations', 'edges', 'graph_status', 'graph_sha256',
  'legacy_task_ids', 'added_task_ids', 'semantic_sha256']);
const MUTATION_REF = /^([^:]+):([^:]+):(\d{4}):([a-f0-9]{64})$/;
const PLAIN_TASK_ID = /^T\d+$/;
// The forge-planner decompose container line: `- [ ] **T03** *(DECOMPOSED — see sub-tasks below)*`.
const DECOMPOSED_MARKER = /\bDECOMPOSED\b/;

function pad(sequence) { return String(sequence).padStart(4, '0'); }
function sortedIds(ids) { return [...ids].sort().join('\n'); }
function recordDigestOf(record) {
  const { record_sha256: _digest, ...content } = record;
  return digestOf(content);
}
function mutationRefOf(intent) { return `${intent.milestone}:${intent.slice}:${pad(intent.sequence)}:${intent.record_sha256}`; }
function chainTail(chain) { return chain.records.length ? chain.records[chain.records.length - 1] : null; }
function invalidChain(detail, cause) { return refuse('plan-mutation-evidence-invalid', detail, { cause_code: cause || null }); }

// The S-plan task lines with their checkbox and title (the PLAN_TASK_LINE grammar).
function listedTaskLines(text) {
  const lines = [];
  for (const match of String(text).matchAll(new RegExp(PLAN_TASK_LINE, 'gm'))) lines.push({ id: match[2], checked: match[1] === 'x', title: match[3] });
  return lines;
}
// The forge-planner DECOMPOSED mutation (Step 4): `status: DECOMPOSED` as the first line of
// the YAML block, ending like the opening fence. withoutDecomposed returns the parent text
// without exactly that line, or null when the text is not exactly that form.
function openingFence(content) {
  const match = /^(﻿?---)(\r\n|\n)/.exec(content);
  return match ? { prefix: match[0], eol: match[2] } : null;
}
function withoutDecomposed(content) {
  const fence = openingFence(content);
  if (!fence) return null;
  const line = `status: DECOMPOSED${fence.eol}`;
  return content.startsWith(line, fence.prefix.length) ? fence.prefix + content.slice(fence.prefix.length + line.length) : null;
}

// The physical owner of cwd: real path, key form and directory identity. A copied or
// replaced owner tree has another key or identity and never continues a mutation.
function physicalMutationOwner(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) refuse('plan-source-owner-unreadable', 'cwd must be the owner directory');
  let real, stat;
  try {
    real = fs.realpathSync.native(cwd);
    stat = fs.statSync(real, { bigint: true });
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch (_) { refuse('plan-source-owner-unreadable', 'the owner root is not a readable directory'); }
  const key = codeRoots().key(real);
  return { real, key, identity_sha256: digestOf({ owner: key, dev: String(stat.dev), ino: String(stat.ino), birthtime_ns: String(stat.birthtimeNs) }) };
}
// Every component below `base` is a real directory (no link, no junction).
function directoryAt(base, segments) {
  let cursor = base;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { return { status: error && error.code === 'ENOENT' ? 'missing' : 'unreadable', dir: cursor }; }
    if (stat.isSymbolicLink()) return { status: 'link', dir: cursor };
    if (!stat.isDirectory()) return { status: 'not-regular', dir: cursor };
  }
  return { status: 'ok', dir: cursor };
}
function mutationDirectory(owner, segments) {
  const found = directoryAt(owner.real, segments);
  if (found.status !== 'ok' && found.status !== 'missing') invalidChain(`${segments.join('/')} is not a real directory (${found.status})`, found.status);
  return found;
}
function readMutationRecord(owner, segments, name) {
  const file = path.join(owner.real, ...segments, name), relative = [...segments, name].join('/');
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) { invalidChain(`${relative} is unreadable`, 'unreadable'); }
  if (stat.isSymbolicLink() || !stat.isFile()) invalidChain(`${relative} is not a regular record`, 'not-regular');
  if (stat.size > MAX_MUTATION_RECORD_BYTES) invalidChain(`${relative} exceeds ${MAX_MUTATION_RECORD_BYTES} bytes`, 'too-large');
  // Bounded by the observed size: a record growing during the read is unstable, never truncated.
  const read = boundedReader().readBoundedStableFile(file, stat.size, { expectedReal: file });
  if (read.error) invalidChain(`${relative} is unstable or unreadable`, 'unstable');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)); }
  catch (_) { return invalidChain(`${relative} is not a JSON record`, 'encoding'); }
}

// ── Mutation chain: read and verify (read-only) ───────────────────────────────

/**
 * Reads and verifies one slice chain: contiguous NNNN.json names only, each record bounded,
 * closed, checksummed, linked to its predecessor, bound to this owner and slice; an
 * admission directly follows its own intent and is verified by recomputation. Any other
 * entry, link or divergence refuses (plan-mutation-evidence-invalid). Writes nothing.
 */
function readMutationChain(owner, milestone, slice) {
  const segments = [...MUTATION_SEGMENTS, milestone, slice];
  const found = mutationDirectory(owner, segments);
  if (found.status === 'missing') return deepFreeze({ milestone, slice, records: [] });
  let names;
  try { names = fs.readdirSync(found.dir); } catch (_) { invalidChain(`${segments.join('/')} is unreadable`, 'unreadable'); }
  if (names.length > MAX_MUTATION_RECORDS) invalidChain(`${milestone}/${slice} has more than ${MAX_MUTATION_RECORDS} records`, 'limit');
  names.sort();
  names.forEach((name, index) => {
    if (name !== `${pad(index + 1)}.json`) invalidChain(`unexpected entry ${shortId(name)} in the ${milestone}/${slice} chain`, 'sequence');
  });
  const records = [];
  for (const name of names) {
    const record = readMutationRecord(owner, segments, name);
    verifyMutationRecord(record, records, owner, milestone, slice);
    records.push(record);
  }
  return deepFreeze({ milestone, slice, records });
}
function verifyMutationRecord(record, prior, owner, milestone, slice) {
  const index = prior.length, label = `${milestone}/${slice} record ${pad(index + 1)}`;
  if (!isObject(record) || record.schema !== MUTATION_SCHEMA || !own(MUTATION_KEYS, record.kind)) invalidChain(`${label} is not a plan mutation record`);
  exactKeys(record, MUTATION_KEYS[record.kind], 'plan-mutation-evidence-invalid', label);
  if (record.sequence !== index + 1) invalidChain(`${label} carries another sequence`, 'sequence');
  const previous = index ? prior[index - 1] : null;
  if (record.previous_sha256 !== (previous ? previous.record_sha256 : null)) invalidChain(`${label} does not follow its predecessor`, 'sequence');
  if (typeof record.record_sha256 !== 'string' || record.record_sha256 !== recordDigestOf(record)) {
    invalidChain(`${label} checksum does not bind the record`, 'record-conflict');
  }
  if (record.requirement !== REQUIREMENT || record.requirement_sha256 !== REQUIREMENT_SHA256) invalidChain(`${label} is not under the current requirement`);
  if (record.owner !== owner.key) refuse('plan-mutation-owner-mismatch', `${label} belongs to another owner`);
  if (record.milestone !== milestone || record.slice !== slice) invalidChain(`${label} names another slice`);
  if (!MUTATION_OPERATIONS.includes(record.operation)) invalidChain(`${label} has an unknown operation`);
  checkMutationBase(record.base, record.operation, label);
  if (record.kind === 'intent') {
    verifyIntentRecord(record, label);
    // An intent follows nothing, an admission, or an obsolete intent of a superseded base.
    if (previous && previous.kind === 'intent' && sameBase(previous.base, record.base)) invalidChain(`${label} opens a second mutation over an open one`);
    return;
  }
  if (!previous || previous.kind !== 'intent') invalidChain(`${label} admits no open intent`);
  if (previous.operation !== record.operation || digestOf(previous.base) !== digestOf(record.base)) invalidChain(`${label} is not the admission of its intent`);
  verifyAdmissionRecord(record, previous, label);
}
function checkMutationBase(base, operation, label) {
  if (!isObject(base)) invalidChain(`${label} base must be an object`);
  exactKeys(base, MUTATION_BASE_KEYS, 'plan-mutation-evidence-invalid', `${label} base`);
  if (base.kind === 'unenrolled') {
    if (base.generation_key !== null || base.validation_key !== null) invalidChain(`${label} unenrolled base carries a generation`);
  } else if (base.kind === 'completed') {
    if (operation === 'add-slice' || typeof base.generation_key !== 'string' || !SHA256_HEX.test(base.generation_key) || !opaqueKey(base.validation_key)) {
      invalidChain(`${label} completed base is invalid`);
    }
  } else invalidChain(`${label} base kind is unknown`);
  const semantic = base.semantic_sha256;
  if (operation === 'add-slice' ? semantic !== null : typeof semantic !== 'string' || !SHA256_HEX.test(semantic)) {
    invalidChain(`${label} base semantic digest is invalid`);
  }
}
function changedIdsValid(record) {
  const ids = record.changed_task_ids;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !taskId(id)) || new Set(ids).size !== ids.length) return false;
  if (record.operation === 'decompose') {
    return typeof record.parent_task_id === 'string' && PLAIN_TASK_ID.test(record.parent_task_id)
      && ids.every(id => id.startsWith(`${record.parent_task_id}.`));
  }
  return record.parent_task_id === null;
}
function verifyIntentRecord(record, label) {
  if (typeof record.owner_identity_sha256 !== 'string' || !SHA256_HEX.test(record.owner_identity_sha256)) invalidChain(`${label} owner identity is invalid`);
  if (!isoInstant(record.begun_at)) invalidChain(`${label} begun_at must be a canonical ISO-8601 instant`);
  if (!changedIdsValid(record)) invalidChain(`${label} changed task ids are invalid`);
  if (record.operation === 'add-slice') {
    if (record.before !== null) invalidChain(`${label} add-slice has no before inventory`);
    return;
  }
  const before = record.before, scope = { milestone: record.milestone, slice: record.slice };
  if (!isObject(before)) invalidChain(`${label} before inventory must be an object`);
  exactKeys(before, ['slice_plan', 'task_plans'], 'plan-mutation-evidence-invalid', `${label} before`);
  const plan = before.slice_plan;
  if (!isObject(plan)) invalidChain(`${label} before.slice_plan must be an object`);
  exactKeys(plan, ['path', 'sha256', 'bytes', 'content'], 'plan-mutation-evidence-invalid', `${label} before.slice_plan`);
  let bytes = null;
  try { bytes = plan.path === slicePlanPath(scope) ? planBytes(plan.content, `${label} before.slice_plan`) : null; } catch (_) { bytes = null; }
  if (!bytes || sha256(bytes) !== plan.sha256 || bytes.length !== plan.bytes) invalidChain(`${label} before.slice_plan does not bind its content`);
  const listed = listedTaskIds(plan.content);
  if (!listed.length || new Set(listed).size !== listed.length || !Array.isArray(before.task_plans) || before.task_plans.length !== listed.length) {
    invalidChain(`${label} before.task_plans do not follow the before slice plan`);
  }
  before.task_plans.forEach((entry, index) => {
    if (!isObject(entry)) invalidChain(`${label} before.task_plans[${index}] must be an object`);
    exactKeys(entry, ['id', 'path', 'sha256', 'bytes', 'declaration_sha256'], 'plan-mutation-evidence-invalid', `${label} before.task_plans[${index}]`);
    if (entry.id !== listed[index] || !taskId(entry.id) || entry.path !== taskPlanPath(scope, entry.id) || typeof entry.sha256 !== 'string'
        || !SHA256_HEX.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_PLAN_BYTES
        || (entry.declaration_sha256 !== null && (typeof entry.declaration_sha256 !== 'string' || !SHA256_HEX.test(entry.declaration_sha256)))) {
      invalidChain(`${label} before.task_plans[${index}] is invalid`);
    }
  });
  if (record.changed_task_ids.some(id => listed.includes(id))) invalidChain(`${label} declares a known task as new`);
  if (record.operation === 'decompose' && !listed.includes(record.parent_task_id)) invalidChain(`${label} decomposes an unknown parent`);
}
// An admission is verified by recomputation: canonical paths, aligned declarations each
// re-admitted, the graph recomputed under the operation's legacy policy, the declared delta
// and the semantic digest. A JSON flag, an extra field or a forged digest never verifies.
function verifyAdmissionRecord(record, intent, label) {
  if (!isoInstant(record.admitted_at)) invalidChain(`${label} admitted_at must be a canonical ISO-8601 instant`);
  const evidence = record.evidence, code = 'plan-mutation-evidence-invalid';
  if (!isObject(evidence)) invalidChain(`${label} evidence must be an object`);
  exactKeys(evidence, MUTATION_EVIDENCE_KEYS, code, `${label} evidence`);
  const complete = record.operation === 'add-slice';
  if (evidence.kind !== (complete ? 'complete' : 'addition')) invalidChain(`${label} evidence kind does not follow the operation`);
  const ids = evidence.task_ids, scope = { milestone: record.milestone, slice: record.slice };
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !taskId(id)) || new Set(ids).size !== ids.length) invalidChain(`${label} task_ids are invalid`);
  if (!isObject(evidence.source)) invalidChain(`${label} source must be an object`);
  exactKeys(evidence.source, ['slice_plan', 'task_plans'], code, `${label} source`);
  checkSourceRef(evidence.source.slice_plan, slicePlanPath(scope), ['path', 'sha256'], code, `${label} source.slice_plan`);
  if (!Array.isArray(evidence.source.task_plans) || evidence.source.task_plans.length !== ids.length) invalidChain(`${label} source does not follow task_ids`);
  evidence.source.task_plans.forEach((entry, index) => {
    if (!isObject(entry) || entry.id !== ids[index]) invalidChain(`${label} source.task_plans[${index}] does not follow task_ids`);
    checkSourceRef(entry, taskPlanPath(scope, ids[index]), ['id', 'path', 'sha256'], code, `${label} source.task_plans[${index}]`);
  });
  // Only an addition over a genuine historical (unenrolled) slice may keep legacy known tasks.
  const legacyAllowed = !complete && intent.base.kind === 'unenrolled';
  const added = evidence.added_task_ids;
  if (!Array.isArray(added) || new Set(added).size !== added.length || added.some(id => !ids.includes(id))) invalidChain(`${label} added_task_ids are invalid`);
  if (sortedIds(added) !== sortedIds(intent.changed_task_ids)) invalidChain(`${label} admits another task set than its intent`);
  if (!Array.isArray(evidence.declarations) || evidence.declarations.length !== ids.length) invalidChain(`${label} declarations do not follow task_ids`);
  evidence.declarations.forEach((entry, index) => {
    if (entry === null) {
      if (!legacyAllowed || added.includes(ids[index])) invalidChain(`${label} declarations[${ids[index]}] must be explicit`);
    } else checkDeclaration(entry, ids[index], code);
  });
  if (complete) {
    if (ids.length !== added.length) invalidChain(`${label} a new slice is entirely new`);
  } else {
    const known = intent.before.task_plans.map(entry => entry.id);
    if (ids.filter(id => !added.includes(id)).join('\n') !== known.join('\n')) invalidChain(`${label} does not keep the known tasks in order`);
    if (record.operation === 'decompose') {
      const at = ids.indexOf(intent.parent_task_id);
      if (sortedIds(ids.slice(at + 1, at + 1 + added.length)) !== sortedIds(added)) invalidChain(`${label} sub-tasks do not follow their container`);
    }
  }
  const rows = ids.map((id, index) => {
    const entry = evidence.declarations[index];
    return entry ? { id, depends: [...entry.depends], writes: copy(entry.writes) } : { id, depends: null, writes: null };
  });
  const dag = parallel().validateTaskDag(rows, { scopeTaskIds: [...ids], legacyPolicy: legacyAllowed ? 'sequential' : 'refuse' });
  if (dag.status === 'invalid' || dag.status !== evidence.graph_status || digestOf(dag.edges) !== digestOf(evidence.edges)
      || dag.graph_sha256 !== evidence.graph_sha256 || digestOf(dag.legacy_task_ids) !== digestOf(evidence.legacy_task_ids)) {
    invalidChain(`${label} declarations do not form its admitted graph`);
  }
  if (evidence.semantic_sha256 !== semanticDigest({ requirement: record.requirement, milestone: record.milestone, slice: record.slice,
    task_ids: ids, declarations: evidence.declarations })) {
    invalidChain(`${label} semantic digest does not follow its declarations`);
  }
}

// ── Mutation bases and anchors (read-only) ────────────────────────────────────

// The admitted state a mutation starts from: the slice's canonical classification.
// open/ended enrolled lineages have none (the plan-slice must complete first).
function mutationBaseOf(classified) {
  if (classified.status === 'unenrolled') return { kind: 'unenrolled', generation_key: null, validation_key: null };
  if (classified.status === 'completed') {
    return { kind: 'completed', generation_key: classified.generation_key, validation_key: classified.validation_key };
  }
  return null;
}
function sameBase(left, right) {
  return isObject(left) && isObject(right) && left.kind === right.kind && left.generation_key === right.generation_key
    && left.validation_key === right.validation_key;
}
function openIntent(chain, base) {
  const tail = chainTail(chain);
  return tail && tail.kind === 'intent' && sameBase(tail.base, base) ? tail : null;
}
// The admitted semantic state of one completed generation: its plan_validation digest, then
// every admitted amendment of exactly that base in chain order, each starting from the state
// before it. A broken link refuses.
function amendedAnchor(chain, base, admitted) {
  let anchor = admitted, last = null;
  chain.records.forEach((record, index) => {
    if (record.kind !== 'admission' || !sameBase(record.base, base)) return;
    if (chain.records[index - 1].base.semantic_sha256 !== anchor) {
      invalidChain(`amendment ${pad(record.sequence)} does not start from the admitted state of its generation`, 'lineage');
    }
    anchor = record.evidence.semantic_sha256;
    last = record;
  });
  return { semantic_sha256: anchor, admission: last };
}
// The slices of one milestone that carry a mutation chain (safe segment directories only).
function mutationSlices(owner, milestone) {
  const found = mutationDirectory(owner, [...MUTATION_SEGMENTS, milestone]);
  if (found.status === 'missing') return [];
  let names;
  try { names = fs.readdirSync(found.dir); } catch (_) { invalidChain(`the ${milestone} mutation chains are unreadable`, 'unreadable'); }
  if (names.length > MAX_MUTATION_RECORDS) invalidChain(`${milestone} has more than ${MAX_MUTATION_RECORDS} mutation chains`, 'limit');
  for (const name of names) if (!safeId(name)) invalidChain(`unexpected entry ${shortId(name)} in the ${milestone} mutation chains`, 'sequence');
  return names.sort();
}
// The execute gate's mutation check: an open intent over its slice's current base keeps the
// milestone's owner plan bytes in flux, so no new execute-task of the milestone begins.
function assertNoOpenMutation(cwd, milestone, classified) {
  const owner = physicalMutationOwner(cwd);
  for (const slice of mutationSlices(owner, milestone)) {
    const tail = chainTail(readMutationChain(owner, milestone, slice));
    if (!tail || tail.kind !== 'intent') continue;
    const current = classified && classified.slice === slice ? classified : classifySliceGeneration(cwd, { milestone, slice });
    const base = mutationBaseOf(current);
    if (base && sameBase(tail.base, base)) {
      refuse('plan-mutation-pending', `${slice} has an open ${tail.operation} owner mutation; no task of ${milestone} is ready until it is admitted`,
        { mutation_ref: mutationRefOf(tail), slice });
    }
  }
}

// ── Mutation publication ──────────────────────────────────────────────────────

// Inside the owner safe boundary of the milestone, then the owner publication lock.
function withMutationBoundary(owner, milestone, fn) {
  let result;
  try {
    result = ownerBoundaryApi().ownerBoundary(owner.real, milestone, () => ({ inside: true, value: ownerLockApi().withOwnerLock(owner.real, fn) }));
  } catch (error) {
    if (error && error.code === 'LOCK_BUSY') refuse('plan-mutation-boundary-deferred', 'the owner publication lock is busy', { cause_code: 'owner-lock-busy' });
    throw error;
  }
  if (!isObject(result) || result.inside !== true) {
    const reason = isObject(result) && typeof result.reason === 'string' ? result.reason : 'boundary-unknown';
    refuse('plan-mutation-boundary-deferred', `the owner is not at a safe boundary of ${milestone} (${reason})`, { cause_code: reason });
  }
  return result.value;
}
// `.gsd` must already exist: only its descendants are created, one real directory at a time.
function ensureMutationDirectory(owner, segments) {
  let cursor = owner.real;
  segments.forEach((segment, index) => {
    cursor = path.join(cursor, segment);
    let stat = null;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    if (!stat) {
      if (index === 0) refuse('plan-source-owner-unreadable', 'the owner has no .gsd directory');
      fs.mkdirSync(cursor);
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      invalidChain(`${segments.slice(0, index + 1).join('/')} is not a real directory`, stat.isSymbolicLink() ? 'link' : 'not-regular');
    }
  });
  return cursor;
}
// Exclusive installation: the complete record is written and synced in staging, then hard
// linked to its name (refusing a collision; a rename could overwrite history). The caller
// holds the owner lock, so a leftover staging record is an interrupted publication.
function publishMutationRecord(owner, record) {
  const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  if (buffer.length > MAX_MUTATION_RECORD_BYTES) refuse('plan-mutation-invalid', `the mutation record exceeds ${MAX_MUTATION_RECORD_BYTES} bytes`);
  const dir = ensureMutationDirectory(owner, [...MUTATION_SEGMENTS, record.milestone, record.slice]);
  const staging = ensureMutationDirectory(owner, [...MUTATION_SEGMENTS, MUTATION_STAGING]);
  for (const name of fs.readdirSync(staging)) {
    if (!MUTATION_STAGING_FILE.test(name)) continue;
    const leftover = path.join(staging, name);
    if (fs.lstatSync(leftover).isFile()) fs.unlinkSync(leftover);
  }
  const target = path.join(dir, `${pad(record.sequence)}.json`);
  const temporary = path.join(staging, `${pad(record.sequence)}.json.${process.pid}.${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, target); }
    catch (error) {
      if (error && error.code === 'EEXIST') invalidChain(`${record.milestone}/${record.slice} record ${pad(record.sequence)} already exists`, 'record-conflict');
      throw error;
    }
  } finally { if (created) fs.unlinkSync(temporary); }
}

// ── Begin: the owner intent ───────────────────────────────────────────────────

function mutationRequestOf(request) {
  const code = 'plan-mutation-invalid';
  if (!isObject(request)) refuse(code, 'the mutation request must be an object');
  for (const key of Object.keys(request)) if (!MUTATION_REQUEST_KEYS.includes(key)) refuse(code, `unknown mutation field ${shortId(key)}`);
  if (!MUTATION_OPERATIONS.includes(request.operation)) refuse(code, `operation must be one of ${MUTATION_OPERATIONS.join(', ')}`);
  if (!safeId(request.milestone)) refuse('plan-scope-invalid', 'milestone must be one safe path segment');
  if (!safeId(request.slice)) refuse('plan-scope-invalid', 'slice must be one safe path segment');
  const ids = request.changedTaskIds;
  if (!Array.isArray(ids) || !ids.length) refuse(code, 'changedTaskIds must be a non-empty array of new task ids');
  // Every changed task must be listed in one S-plan: that plan's own byte bound bounds the list.
  if (ids.length > MAX_PLAN_BYTES) refuse(code, 'changedTaskIds exceed the slice plan bound');
  const seen = new Set();
  let listedBytes = 0;
  for (const id of ids) {
    if (!taskId(id)) refuse('plan-task-id-invalid', `changed task id ${shortId(id)} is not a local task id (T##, T##.#)`);
    if (seen.has(id)) refuse('plan-task-id-duplicate', `changed task id ${id} is repeated`);
    seen.add(id);
    listedBytes += id.length + 1;
    if (listedBytes > MAX_PLAN_BYTES) refuse(code, 'changedTaskIds exceed the slice plan bound');
  }
  const parent = request.parentTaskId === undefined ? null : request.parentTaskId;
  if (request.operation === 'decompose') {
    if (typeof parent !== 'string' || !PLAIN_TASK_ID.test(parent)) refuse('plan-mutation-parent-invalid', 'decompose names one plain parent task id (T##)');
    for (const id of ids) if (!id.startsWith(`${parent}.`)) refuse(code, `${id} is not a decimal sub-task of ${parent}`);
  } else if (parent !== null) refuse(code, `${request.operation} takes no parentTaskId`);
  const binding = request.ownerBinding;
  if (!isObject(binding) || Object.keys(binding).length !== 1 || !own(binding, 'owner')) refuse(code, 'ownerBinding is exactly { owner }');
  if (!ownerKey(binding.owner)) refuse('plan-mutation-owner-mismatch', 'ownerBinding.owner must be the absolute owner path');
  return { operation: request.operation, milestone: request.milestone, slice: request.slice, changed: [...ids], parent, owner: binding.owner };
}
// The legitimate owner: the binding names exactly the physical owner of cwd.
function assertOwnerBinding(owner, bound) {
  let key = null;
  try { key = codeRoots().key(fs.realpathSync.native(path.resolve(bound))); } catch (_) { key = null; }
  if (key !== owner.key) refuse('plan-mutation-owner-mismatch', 'ownerBinding does not name the physical owner of cwd');
}
function sliceSegmentsOf(scope) { return ['.gsd', 'milestones', scope.milestone, 'slices', scope.slice]; }
// A changed task is new: neither its nested task directory nor a flat legacy plan exists.
function assertTaskAbsent(owner, scope, id) {
  const tasks = [...sliceSegmentsOf(scope), 'tasks'];
  for (const segments of [[...tasks, id], [...tasks, `${id}-PLAN.md`]]) {
    const found = walk(owner.real, segments, 'any');
    if (found.status === 'present') refuse('plan-mutation-task-exists', `${id} already has owner plan files`, { task_id: id });
    if (found.status !== 'missing') sourceRefusal(found.status, segments.join('/'));
  }
}
// The known owner plan of an addition, read as validateNewSlicePlan reads a known set:
// explicit declarations, or a genuine historical absence (legacy: sequential, never
// backfilled). A malformed declaration or an invalid known graph refuses before any intent.
function inspectKnownPlan(collected, scope) {
  const known = readPlanSet(collected, scope, 'known', true);
  const listed = planList(known.slicePlan.content, 'known slice plan');
  if (listed.length !== known.tasks.size || listed.some(id => !known.tasks.has(id))) refuse('plan-known-invalid', 'known slice plan list does not match its task plans');
  const declarations = listed.map(id => knownDeclarations(known.tasks.get(id)).declarations);
  const rows = listed.map((id, index) => (declarations[index]
    ? { id, depends: [...declarations[index].depends], writes: copy(declarations[index].writes) } : { id, depends: null, writes: null }));
  const dag = parallel().validateTaskDag(rows, { scopeTaskIds: [...listed], legacyPolicy: 'sequential' });
  if (dag.status === 'invalid') {
    refuse('plan-known-invalid', `the known graph is invalid: ${dag.diagnostics.slice(0, 5).join(', ')}`, { diagnostics: [...dag.diagnostics] });
  }
  return { listed, declarations, semantic_sha256: semanticDigest({ requirement: REQUIREMENT, milestone: scope.milestone, slice: scope.slice,
    task_ids: listed, declarations }) };
}
// add-task and decompose amend an existing slice: its admitted state, the new IDs absent,
// the decompose parent markable, and the exact before inventory.
function prepareTaskAmendment(owner, input, base) {
  const scope = { owner: owner.real, milestone: input.milestone, slice: input.slice };
  // An enrolled slice is amended only from its current admitted state (no drift).
  const current = base.kind === 'completed' ? verifyCompletedGeneration(owner.real, { ...scope, validation_key: base.validation_key }) : null;
  const collected = collectOwnerSlicePlan(owner.real, { milestone: input.milestone, slice: input.slice });
  const known = inspectKnownPlan(collected, scope);
  const semantic = current ? current.semantic_sha256 : known.semantic_sha256;
  for (const id of input.changed) {
    if (known.listed.includes(id)) refuse('plan-mutation-task-exists', `${id} is already listed in ${input.slice}`, { task_id: id });
    assertTaskAbsent(owner, input, id);
  }
  if (input.operation === 'decompose') {
    const parent = collected.task_plans.find(task => task.id === input.parent);
    if (!parent) refuse('plan-mutation-parent-invalid', `${input.parent} is not listed in ${input.slice}`, { task_id: input.parent });
    const frontmatter = openingFence(parent.content) ? must().extractFrontmatter(parent.content) : null;
    if (frontmatter === null) refuse('plan-mutation-parent-invalid', `${input.parent} has no frontmatter block to mark DECOMPOSED`, { task_id: input.parent });
    if (/^status\s*:/m.test(frontmatter)) refuse('plan-mutation-parent-invalid', `${input.parent} already carries a status`, { task_id: input.parent });
  }
  return { semantic_sha256: semantic, before: {
    slice_plan: { path: collected.slice_plan.path, sha256: collected.slice_plan.sha256, bytes: collected.slice_plan.bytes,
      content: collected.slice_plan.content },
    task_plans: collected.task_plans.map((task, index) => ({ id: task.id, path: task.path, sha256: task.sha256, bytes: task.bytes,
      declaration_sha256: known.declarations[index] ? known.declarations[index].declaration_sha256 : null })),
  } };
}
// add-slice creates a slice: an existing milestone, no slice plan yet, the new IDs absent.
function prepareSliceCreation(owner, input) {
  const milestone = directoryAt(owner.real, ['.gsd', 'milestones', input.milestone]);
  if (milestone.status !== 'ok') sourceRefusal(milestone.status === 'unreadable' ? 'unreadable' : milestone.status, `.gsd/milestones/${input.milestone}`);
  const plan = walk(owner.real, [...sliceSegmentsOf(input), `${input.slice}-PLAN.md`], 'any');
  if (plan.status === 'present') refuse('plan-mutation-slice-exists', `${input.slice} already has a slice plan`);
  if (plan.status !== 'missing') sourceRefusal(plan.status, slicePlanPath(input));
  for (const id of input.changed) assertTaskAbsent(owner, input, id);
  return { semantic_sha256: null, before: null };
}
function sameMutationRequest(intent, input) {
  return intent.operation === input.operation && intent.parent_task_id === input.parent && sortedIds(intent.changed_task_ids) === sortedIds(input.changed);
}
function describeIntent(record, status) {
  const scope = { milestone: record.milestone, slice: record.slice };
  const targets = record.operation === 'decompose' ? [record.parent_task_id, ...record.changed_task_ids] : [...record.changed_task_ids];
  return deepFreeze({
    status, mutation_ref: mutationRefOf(record), operation: record.operation, milestone: record.milestone, slice: record.slice,
    sequence: record.sequence, intent_sha256: record.record_sha256, changed_task_ids: [...record.changed_task_ids],
    parent_task_id: record.parent_task_id, base: copy(record.base),
    targets: { slice_plan: slicePlanPath(scope), task_plans: targets.map(id => ({ id, path: taskPlanPath(scope, id) })) },
  });
}

/**
 * Publishes the owner intent of one direct creator BEFORE it writes any plan byte.
 *
 * request: exactly { operation: 'add-task'|'add-slice'|'decompose', milestone, slice,
 * changedTaskIds: [new task ids], parentTaskId? (decompose only: the plain parent whose
 * decimal sub-tasks are changedTaskIds), ownerBinding: { owner } } — the binding must name
 * the physical owner of cwd. Runs only at the owner safe boundary of the milestone (pending
 * transactions, open begins and held leases defer it: plan-mutation-boundary-deferred).
 * The same request over an open intent replays it; another one refuses while it is open.
 *
 * @returns {object} deep-frozen { status: 'begun'|'replayed', mutation_ref, targets, ... }
 */
function beginOwnerPlanMutation(cwd, request) {
  const input = mutationRequestOf(request);
  const owner = physicalMutationOwner(cwd);
  assertOwnerBinding(owner, input.owner);
  return withMutationBoundary(owner, input.milestone, () => {
    const scope = { owner: owner.real, milestone: input.milestone, slice: input.slice };
    const chain = readMutationChain(owner, input.milestone, input.slice);
    const classified = classifySliceGeneration(owner.real, scope);
    if (input.operation === 'add-slice' && classified.status !== 'unenrolled') {
      refuse('plan-mutation-slice-exists', `${input.slice} already has a controller plan-slice generation`);
    }
    const base = mutationBaseOf(classified);
    if (!base) {
      if (classified.status === 'open') refuse('plan-generation-pending', `the enrolled plan-slice/${input.slice} generation has not completed`);
      refuse('plan-generation-completion-missing', `the enrolled plan-slice/${input.slice} lineage ended without a successful completion`);
    }
    const open = openIntent(chain, base);
    if (open) {
      if (open.owner_identity_sha256 !== owner.identity_sha256) refuse('plan-mutation-owner-mismatch', 'the open intent was begun on another owner directory');
      if (sameMutationRequest(open, input)) return describeIntent(open, 'replayed');
      refuse('plan-mutation-pending', `${input.slice} has an open ${open.operation} owner mutation`, { mutation_ref: mutationRefOf(open), slice: input.slice });
    }
    if (chain.records.length + 2 > MAX_MUTATION_RECORDS) invalidChain(`${input.milestone}/${input.slice} has no room for another mutation`, 'limit');
    const prepared = input.operation === 'add-slice' ? prepareSliceCreation(owner, input) : prepareTaskAmendment(owner, input, base);
    const tail = chainTail(chain);
    const record = {
      schema: MUTATION_SCHEMA, kind: 'intent', sequence: chain.records.length + 1, previous_sha256: tail ? tail.record_sha256 : null,
      operation: input.operation, requirement: REQUIREMENT, requirement_sha256: REQUIREMENT_SHA256, owner: owner.key,
      owner_identity_sha256: owner.identity_sha256, milestone: input.milestone, slice: input.slice, changed_task_ids: [...input.changed],
      parent_task_id: input.parent, base: { ...base, semantic_sha256: prepared.semantic_sha256 }, before: prepared.before,
      begun_at: new Date().toISOString(),
    };
    record.record_sha256 = recordDigestOf(record);
    // The record verifies exactly as every reader will read it, before it exists.
    verifyMutationRecord(JSON.parse(JSON.stringify(record)), chain.records, owner, input.milestone, input.slice);
    publishMutationRecord(owner, record);
    return describeIntent(record, 'begun');
  });
}

// ── Finish: the strict admission of the intent ────────────────────────────────

function parseMutationRef(value) {
  const match = typeof value === 'string' && value.length <= MAX_KEY_LENGTH ? MUTATION_REF.exec(value) : null;
  if (!match || !safeId(match[1]) || !safeId(match[2])) refuse('plan-mutation-ref-invalid', 'mutationRef must be <milestone>:<slice>:<NNNN>:<intent sha256>');
  const sequence = Number(match[3]);
  if (sequence < 1 || sequence > MAX_MUTATION_RECORDS) refuse('plan-mutation-ref-invalid', 'mutationRef names no record of a chain');
  return { milestone: match[1], slice: match[2], sequence, intent_sha256: match[4] };
}
// A known task keeps its declarations. Its bytes may change only as everywhere else
// (checkbox, repair_count, prose); the decompose parent keeps its exact bytes except the
// DECOMPOSED status line, which it must carry.
function knownContent(now, entry, intent) {
  if (intent.operation === 'decompose' && entry.id === intent.parent_task_id) {
    const original = withoutDecomposed(now.content);
    if (original === null || sha256(Buffer.from(original, 'utf8')) !== entry.sha256) {
      refuse('plan-mutation-parent-altered', `${entry.id} must keep its original bytes plus exactly the DECOMPOSED status line`, { task_id: entry.id });
    }
    return now.content;
  }
  if (now.sha256 === entry.sha256) return now.content;
  const read = knownDeclarations(now);
  if ((read.declarations ? read.declarations.declaration_sha256 : null) !== entry.declaration_sha256) {
    refuse('plan-mutation-known-changed', `${entry.id} changed its declarations outside the mutation`, { task_id: entry.id });
  }
  return now.content;
}
// decompose: the parent line of the S-plan is the DECOMPOSED container and its sub-tasks
// follow it directly.
function assertSubstitution(collected, intent) {
  const lines = listedTaskLines(collected.slice_plan.content), ids = lines.map(line => line.id);
  const at = ids.indexOf(intent.parent_task_id);
  if (at < 0 || !DECOMPOSED_MARKER.test(lines[at].title)) {
    refuse('plan-mutation-substitution-invalid', `the ${intent.parent_task_id} line of the slice plan is not its DECOMPOSED container`);
  }
  if (sortedIds(ids.slice(at + 1, at + 1 + intent.changed_task_ids.length)) !== sortedIds(intent.changed_task_ids)) {
    refuse('plan-mutation-substitution-invalid', `the sub-tasks of ${intent.parent_task_id} must directly follow its container line`);
  }
}
function mutationEvidence(evidence) {
  return {
    kind: evidence.kind,
    source: { slice_plan: { path: evidence.source.slice_plan.path, sha256: evidence.source.slice_plan.sha256 },
      task_plans: evidence.source.task_plans.map(entry => ({ id: entry.id, path: entry.path, sha256: entry.sha256 })) },
    task_ids: [...evidence.task_ids],
    declarations: copy(evidence.declarations),
    edges: copy(evidence.edges),
    graph_status: evidence.graph_status,
    graph_sha256: evidence.graph_sha256,
    legacy_task_ids: [...evidence.legacy_task_ids],
    added_task_ids: [...evidence.added_task_ids],
    semantic_sha256: evidence.semantic_sha256,
  };
}
// The strict admission of the owner bytes the intent announced.
function admitOwnerMutation(owner, intent) {
  const scope = { owner: owner.real, milestone: intent.milestone, slice: intent.slice };
  const collected = collectOwnerSlicePlan(owner.real, { milestone: intent.milestone, slice: intent.slice });
  if (intent.operation === 'add-slice') {
    // A new slice is a complete generation: every task strict and the graph fully valid.
    const evidence = validateNewSlicePlan(collected, scope);
    if (sortedIds(evidence.task_ids) !== sortedIds(intent.changed_task_ids)) {
      refuse('plan-mutation-delta-mismatch', `the new slice lists [${evidence.task_ids.join(', ')}], its intent declares [${intent.changed_task_ids.join(', ')}]`);
    }
    return mutationEvidence(evidence);
  }
  const listed = collected.task_plans.map(task => task.id), knownIds = intent.before.task_plans.map(entry => entry.id);
  const removed = knownIds.filter(id => !listed.includes(id));
  if (removed.length) refuse('plan-addition-task-removed', `an addition keeps every known task listed (removed: ${removed.join(', ')})`, { removed });
  const missing = intent.changed_task_ids.filter(id => !listed.includes(id));
  if (missing.length) refuse('plan-mutation-delta-mismatch', `declared tasks are not listed: ${missing.join(', ')}`);
  const undeclared = listed.filter(id => !knownIds.includes(id) && !intent.changed_task_ids.includes(id));
  if (undeclared.length) refuse('plan-mutation-delta-mismatch', `undeclared tasks are listed: ${undeclared.join(', ')}`);
  const current = new Map(collected.task_plans.map(task => [task.id, task]));
  const known = {
    slice_plan: { content: intent.before.slice_plan.content },
    task_plans: intent.before.task_plans.map(entry => ({ id: entry.id, content: knownContent(current.get(entry.id), entry, intent) })),
  };
  const candidate = {
    slice_plan: { content: collected.slice_plan.content },
    task_plans: listed.filter(id => intent.changed_task_ids.includes(id)).map(id => ({ id, content: current.get(id).content })),
  };
  const evidence = validateNewSlicePlan(candidate, { ...scope, known });
  if (evidence.altered_task_ids.length || sortedIds(evidence.added_task_ids) !== sortedIds(intent.changed_task_ids)) {
    refuse('plan-mutation-delta-mismatch', 'the admitted delta is not the declared new task set');
  }
  // An enrolled slice stays a complete, valid generation; only a historical one stays legacy.
  if (intent.base.kind === 'completed' && evidence.graph_status !== 'valid') refuse('plan-dag-invalid', `the amended graph is ${evidence.graph_status}`);
  if (intent.operation === 'decompose') assertSubstitution(collected, intent);
  return mutationEvidence(evidence);
}
function describeAdmission(record, status) {
  return deepFreeze({
    status, mutation_ref: `${record.milestone}:${record.slice}:${pad(record.sequence - 1)}:${record.previous_sha256}`,
    operation: record.operation, milestone: record.milestone, slice: record.slice, sequence: record.sequence,
    admission_sha256: record.record_sha256, base: copy(record.base), graph_status: record.evidence.graph_status,
    task_ids: [...record.evidence.task_ids], added_task_ids: [...record.evidence.added_task_ids],
    legacy_task_ids: [...record.evidence.legacy_task_ids], graph_sha256: record.evidence.graph_sha256,
    semantic_sha256: record.evidence.semantic_sha256, source: copy(record.evidence.source),
  });
}

/**
 * Admits the owner bytes announced by one open intent (mutationRef from its begin), at the
 * owner safe boundary: the base is still the slice's current one, the owner is the same
 * physical directory, every declared task is new, listed and strictly admitted, every known
 * task keeps its order and declarations (the decompose parent its exact bytes plus the
 * DECOMPOSED line, and its sub-tasks follow its container), references and cycles are checked
 * over the final graph and a new slice must be fully valid. The admission is appended after
 * its intent; an admitted intent replays it. A refusal writes nothing and keeps the intent
 * and the candidate bytes for correction.
 *
 * @returns {object} deep-frozen { status: 'admitted'|'replayed', graph_status, task_ids, ... }
 */
function finishOwnerPlanMutation(cwd, mutationRef) {
  const ref = parseMutationRef(mutationRef);
  const owner = physicalMutationOwner(cwd);
  return withMutationBoundary(owner, ref.milestone, () => {
    const chain = readMutationChain(owner, ref.milestone, ref.slice);
    const intent = chain.records[ref.sequence - 1];
    if (!intent || intent.kind !== 'intent' || intent.record_sha256 !== ref.intent_sha256) refuse('plan-mutation-ref-invalid', 'mutationRef names no intent of this chain');
    const next = chain.records[ref.sequence];
    if (next) {
      // The chain verification bound an admission to the intent it directly follows.
      if (next.kind === 'admission') return describeAdmission(next, 'replayed');
      refuse('plan-mutation-ref-stale', `intent ${pad(ref.sequence)} was superseded by a newer mutation`);
    }
    if (intent.owner_identity_sha256 !== owner.identity_sha256) refuse('plan-mutation-owner-mismatch', 'the intent was begun on another owner directory');
    const classified = classifySliceGeneration(owner.real, { owner: owner.real, milestone: ref.milestone, slice: ref.slice });
    const base = mutationBaseOf(classified);
    if (!base || !sameBase(base, intent.base)) {
      refuse('plan-mutation-base-changed', `the slice generation is no longer the one the intent amends (${classified.status})`);
    }
    const evidence = admitOwnerMutation(owner, intent);
    const record = {
      schema: MUTATION_SCHEMA, kind: 'admission', sequence: intent.sequence + 1, previous_sha256: intent.record_sha256,
      operation: intent.operation, requirement: REQUIREMENT, requirement_sha256: REQUIREMENT_SHA256, owner: owner.key,
      milestone: intent.milestone, slice: intent.slice, base: copy(intent.base), evidence, admitted_at: new Date().toISOString(),
    };
    record.record_sha256 = recordDigestOf(record);
    verifyMutationRecord(JSON.parse(JSON.stringify(record)), chain.records, owner, ref.milestone, ref.slice);
    publishMutationRecord(owner, record);
    return describeAdmission(record, 'admitted');
  });
}

/**
 * Read-only summary of one slice's mutation chain (the CLI check): record count, the open
 * intent (its mutation_ref, operation and base) and the last admission. Writes nothing.
 */
function inspectOwnerPlanMutations(cwd, scope) {
  const input = scopeOf(scope, ['owner', 'milestone', 'slice'], ['milestone', 'slice']);
  const owner = physicalMutationOwner(cwd);
  if (input.owner !== undefined && input.owner !== owner.key) refuse('plan-mutation-owner-mismatch', 'scope owner is not the physical owner of cwd');
  const chain = readMutationChain(owner, input.milestone, input.slice);
  const tail = chainTail(chain);
  const admissions = chain.records.filter(record => record.kind === 'admission');
  const last = admissions.length ? admissions[admissions.length - 1] : null;
  return deepFreeze({
    milestone: input.milestone, slice: input.slice, records: chain.records.length,
    open: tail && tail.kind === 'intent' ? { mutation_ref: mutationRefOf(tail), operation: tail.operation, base: copy(tail.base) } : null,
    last_admission: last ? { sequence: last.sequence, admission_sha256: last.record_sha256, operation: last.operation, base: copy(last.base),
      graph_status: last.evidence.graph_status, task_ids: [...last.evidence.task_ids], semantic_sha256: last.evidence.semantic_sha256 } : null,
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  REQUIREMENT, REQUIREMENT_SHA256, MAX_PLAN_BYTES, TRANSACTION_FIELDS, CODES,
  isScopeSegment: safeId, // the one milestone/slice segment grammar an enrollment can carry
  validateNewSlicePlan, collectOwnerSlicePlan, readOwnerTaskPlan, buildPlanGeneration, verifyPlanGeneration,
  planGenerationIntegrity, buildPlanValidation, verifyPlanValidation, semanticDigest, assertCurrentGeneration,
  classifySliceGeneration, assertSliceGeneration,
  MUTATION_OPERATIONS, beginOwnerPlanMutation, finishOwnerPlanMutation, inspectOwnerPlanMutations,
  listedTaskIds, // the parsePlanTasks mirror, exported so the suite pins its parity
};

// ── CLI ───────────────────────────────────────────────────────────────────────

const USAGE = [
  'Usage:',
  '  node scripts/forge-plan-validation.js --check --milestone <M> --slice <S> [--cwd <owner>]',
  '  node scripts/forge-plan-validation.js --current --milestone <M> --slice <S> --validation-key <key> [--cwd <owner>]',
  '  node scripts/forge-plan-validation.js begin-mutation --operation <add-task|add-slice|decompose> --milestone <M> --slice <S>',
  '      --task <T> [--task <T> ...] [--parent <T>] --owner <owner> [--cwd <owner>]',
  '  node scripts/forge-plan-validation.js finish-mutation --ref <mutation_ref> [--cwd <owner>]',
  '  node scripts/forge-plan-validation.js check --milestone <M> --slice <S> [--cwd <owner>]',
  'Read-only: --check admits the owner plan, --current rechecks an enrolled generation and check reports the',
  'execute readiness of a slice with its owner mutation chain. begin-mutation publishes the owner intent before the',
  'creator writes plan bytes; finish-mutation admits them strictly.',
  'Output: one JSON line. Exit codes: 0 ok, 1 named refusal ({ "ok": false, "code", "detail" }), 2 usage.',
].join('\n');
// The owner mutation subcommands (the surface U6 connects to the creator skills): closed
// flags, required arguments, one JSON line and closed exit codes.
const SUBCOMMANDS = Object.freeze({
  'begin-mutation': { flags: { '--operation': 'operation', '--milestone': 'milestone', '--slice': 'slice', '--task': 'tasks',
    '--parent': 'parent', '--owner': 'owner', '--cwd': 'cwd' }, required: ['operation', 'milestone', 'slice', 'tasks', 'owner'] },
  'finish-mutation': { flags: { '--ref': 'ref', '--cwd': 'cwd' }, required: ['ref'] },
  check: { flags: { '--milestone': 'milestone', '--slice': 'slice', '--cwd': 'cwd' }, required: ['milestone', 'slice'] },
});
function parseSubcommand(command, argv) {
  const spec = SUBCOMMANDS[command], args = { command };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], value = argv[index + 1];
    const name = Object.prototype.hasOwnProperty.call(spec.flags, flag) ? spec.flags[flag] : null;
    if (!name || value === undefined || value.startsWith('--')) throw new Error(`unknown or incomplete argument ${flag}`);
    if (name === 'tasks') (args.tasks = args.tasks || []).push(value);
    else if (args[name] !== undefined) throw new Error(`repeated argument ${flag}`);
    else args[name] = value;
    index++;
  }
  for (const name of spec.required) if (args[name] === undefined) throw new Error(`${command} requires --${name === 'tasks' ? 'task' : name}`);
  return args;
}
function runSubcommand(args) {
  const cwd = args.cwd || process.cwd();
  if (args.command === 'begin-mutation') {
    return { mutation: beginOwnerPlanMutation(cwd, { operation: args.operation, milestone: args.milestone, slice: args.slice,
      changedTaskIds: args.tasks, ...(args.parent !== undefined ? { parentTaskId: args.parent } : {}), ownerBinding: { owner: args.owner } }) };
  }
  if (args.command === 'finish-mutation') return { admission: finishOwnerPlanMutation(cwd, args.ref) };
  // check: the shared execute gate of the slice, bound to the physical owner as the controller binds it.
  const owner = physicalMutationOwner(cwd).real;
  const readiness = assertSliceGeneration(owner, { owner, milestone: args.milestone, slice: args.slice });
  return { readiness, mutations: inspectOwnerPlanMutations(owner, { milestone: args.milestone, slice: args.slice }) };
}
function parseCli(argv) {
  if (argv.length && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, argv[0])) return parseSubcommand(argv[0], argv.slice(1));
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--check' || flag === '--current') {
      if (args.mode) throw new Error('choose one of --check or --current');
      args.mode = flag.slice(2);
      continue;
    }
    const name = { '--milestone': 'milestone', '--slice': 'slice', '--cwd': 'cwd', '--validation-key': 'validationKey' }[flag];
    const value = argv[index + 1];
    if (!name || value === undefined || value.startsWith('--')) throw new Error(`unknown or incomplete argument ${flag}`);
    args[name] = value;
    index++;
  }
  if (!args.mode) throw new Error('--check or --current is required');
  return args;
}
function cliMain() {
  let args;
  try { args = parseCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.command) {
    try { process.stdout.write(`${JSON.stringify({ ok: true, command: args.command, ...runSubcommand(args) })}\n`); }
    catch (error) {
      const known = error && typeof error.code === 'string' && /^plan-/.test(error.code);
      process.stdout.write(`${JSON.stringify({ ok: false, command: args.command, code: known ? error.code : 'plan-validation-error',
        detail: known && typeof error.detail === 'string' ? error.detail : String(error && error.message),
        ...(known && typeof error.mutation_ref === 'string' ? { mutation_ref: error.mutation_ref } : {}),
        ...(known && typeof error.cause_code === 'string' ? { cause_code: error.cause_code } : {}) })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  try {
    const cwd = args.cwd || process.cwd(), scope = { milestone: args.milestone, slice: args.slice };
    let output;
    if (args.mode === 'check') {
      const collected = collectOwnerSlicePlan(cwd, scope);
      output = { ok: true, mode: 'check', evidence: validateNewSlicePlan(collected, { ...scope, owner: collected.owner }) };
    } else {
      output = { ok: true, mode: 'current', generation: assertCurrentGeneration(cwd, { ...scope, validation_key: args.validationKey }) };
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error && error.code ? error.code : 'plan-validation-error',
      detail: error && error.detail ? error.detail : String(error && error.message) })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) cliMain();
