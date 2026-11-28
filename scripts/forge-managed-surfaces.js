#!/usr/bin/env node
'use strict';

// managed-surfaces-v1: the versioned declaration of owner `.gsd` surfaces that a
// canonical writer may change inside one unit-execution window (S0 → assert).
// This module is declaration, validation and evidence only. It grants no
// authority, reads no process or clock, and never edits an existing owner file.
// A declared surface names WHO may write and HOW the bytes may evolve; a live
// adapter (T02) is still required before any change can be attributed.
// Not an operating-system sandbox: it validates observed deltas after the fact.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const roots = require('./forge-code-roots');
const sources = require('./forge-autonomy-sources');
const lease = require('./forge-unit-lease');
const evidencePath = require('./forge-evidence-path');
const forgeIds = require('./forge-ids');

const VERSION = 'managed-surfaces-v1';
const OPERATIONS = Object.freeze(['append-only', 'field-update', 'exclusive-create']);
const CAPABILITIES = Object.freeze(['in-scope', 'host-attested-append']);
const PROCESS_CLASSES = Object.freeze(['in-scope', 'cross-process', 'boundary-only', 'immutable']);
const ROUTES = Object.freeze(['claude-host-codex-worker', 'codex-host', 'native']);
const BINDINGS = Object.freeze(['owner', 'unit-lease-file', 'evidence-file-name']);
const VALIDATOR_OPERATION = Object.freeze({ 'append-jsonl-v1': 'append-only', 'lease-clock-v1': 'field-update', 'exclusive-create-v1': 'exclusive-create' });
const VALIDATOR_LIMITS = Object.freeze({
  'append-jsonl-v1': Object.freeze(['max_append_bytes', 'max_append_lines', 'max_bytes', 'max_line_bytes']),
  'lease-clock-v1': Object.freeze(['max_bytes']),
  'exclusive-create-v1': Object.freeze(['max_bytes']),
});
// Validators that need no declared schema may be exercised alone. They return a
// verdict only: no path, writer or capability is attached to such a result.
const VALIDATOR_ONLY = Object.freeze(['append-jsonl-v1', 'exclusive-create-v1']);
const REASON_CODES = Object.freeze([
  'managed-surface-version-unknown', 'managed-surface-path-invalid', 'managed-surface-undeclared',
  'managed-surface-unattributed', 'managed-surface-field-unknown', 'managed-surface-field-immutable',
  'managed-surface-append-rewrite', 'managed-surface-append-invalid', 'managed-surface-create-conflict',
  'managed-surface-baseline-unbound', 'managed-surface-attribution-foreign', 'managed-surface-attribution-reused',
  'managed-surface-attribution-forged', 'managed-surface-capability-required', 'managed-surface-attestation-required',
  'managed-surface-preimage-conflict', 'managed-surface-preimage-missing', 'managed-surface-audit-prefix-changed',
  'managed-surface-read-limit', 'managed-surface-unstable', 'managed-surface-store-invalid',
]);
// Internal diagnostic names retain the exact refused branch without extending
// the approved public reason-code contract. They never change acceptance rules.
const INTERNAL_REASONS = Object.freeze({
  'managed-surface-declaration-invalid': 'managed-surface-undeclared',
  'managed-surface-declaration-unattested': 'managed-surface-attribution-forged',
  'managed-surface-surface-unknown': 'managed-surface-undeclared',
  'managed-surface-binding-invalid': 'managed-surface-baseline-unbound',
  'managed-surface-input-invalid': 'managed-surface-store-invalid',
  'managed-surface-size-limit': 'managed-surface-read-limit',
  'managed-surface-source-unstable': 'managed-surface-unstable',
  'managed-surface-append-limit': 'managed-surface-read-limit',
  'managed-surface-record-invalid': 'managed-surface-field-unknown',
  'managed-surface-lease-clock-regressed': 'managed-surface-field-immutable',
  'managed-surface-audit-invalid': 'managed-surface-audit-prefix-changed',
  'managed-surface-attribution-invalid': 'managed-surface-attribution-forged',
  'managed-surface-delta-unattributed': 'managed-surface-unattributed',
  'managed-surface-usage': 'managed-surface-store-invalid',
});
const LIMITS = Object.freeze({
  relative_bytes: 1024,
  preimage_bytes: 16 * 1024 * 1024,
  journal_bytes: 8 * 1024 * 1024,
  row_bytes: 8192,
  chain_rows: 4096,
});
const ROW_SCHEMA = 'managed-surface-attribution-v1';
const ROW_SCHEMA_VERSION = 1;
// Closed audit row: every field is required. `declaration_digest` is the original
// hash-chain pin and must equal `declaration_sha256`.
const ROW_FIELDS = Object.freeze(['schema', 'schema_version', 'declaration', 'declaration_sha256', 'declaration_digest', 'surface_version',
  'attempt', 'sequence', 'surface_id', 'path', 'operation', 'validator', 'writer', 'attestation_reference',
  'before_sha256', 'after_sha256', 'before_length', 'after_length', 'preimage_sha256', 'diff_sha256',
  'fields_changed', 'appended', 'created_dirs', 'previous_row_sha256', 'baseline_sha256']);
// Lightweight path binding (no attribution authority) versus the full attempt of a row.
const ATTEMPT_FIELDS = Object.freeze(['dispatch_id', 'unit', 'run', 'milestone', 'slice']);
const FULL_ATTEMPT_FIELDS = Object.freeze([...ATTEMPT_FIELDS, 'fingerprint', 'recovery_identity_sha256', 'claim_generation', 'lease_generation']);
const JOURNAL_FILE = 'journal.jsonl';
const PREIMAGE_DIR = 'preimages';
// Windows device names (with any extension) and 8.3 short-name aliases.
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;
const SHORT_NAME = /^[^.~]{1,6}~[0-9]+(?:\.[^.]{0,3})?$/;

// The declaration is canonical text: its sha256 is the declaration digest and
// the suite pins it. Editing any byte here is a new declaration version.
// The canonical text is every line between the template delimiters, each LF-terminated.
// DECLARATION-START
const DECLARATION_TEXT = String.raw`
{
  "schema": "forge-managed-surfaces",
  "version": "managed-surfaces-v1",
  "scope": "owner .gsd during one unit-execution window, from the S0 snapshot to assertProtected",
  "surfaces": [
    {
      "id": "owner-events",
      "version": 1,
      "path": ".gsd/forge/events.jsonl",
      "pattern": null,
      "binding": "owner",
      "operation": "append-only",
      "mutable_fields": [],
      "schema_fields": [],
      "validator": "append-jsonl-v1",
      "limits": { "max_bytes": 8388608, "max_append_bytes": 65536, "max_append_lines": 128, "max_line_bytes": 32768 },
      "writers": ["scripts/forge-unit-sidecar.js#appendProtectedOwnerEvents"],
      "capability": "in-scope",
      "attestation": null
    },
    {
      "id": "unit-lease",
      "version": 1,
      "path": null,
      "pattern": "^\\.gsd/forge/leases/[a-f0-9]{64}\\.json$",
      "binding": "unit-lease-file",
      "operation": "field-update",
      "mutable_fields": ["heartbeat_at", "expires_at"],
      "schema_fields": ["protocol_version", "unit", "owner_token", "host_runtime", "session", "request_id", "generation", "acquired_at", "heartbeat_at", "expires_at", "grace_ms"],
      "validator": "lease-clock-v1",
      "limits": { "max_bytes": 16384 },
      "writers": ["scripts/forge-unit-lease.js#openProtectedWindow"],
      "capability": "in-scope",
      "attestation": null
    },
    {
      "id": "hook-evidence",
      "version": 1,
      "path": null,
      "pattern": "^\\.gsd/forge/evidence~[A-Za-z0-9_.+-]{1,60}~[A-Za-z0-9_.+-]{1,60}~[A-Za-z0-9_.+-]{1,60}\\.jsonl$",
      "binding": "evidence-file-name",
      "operation": "append-only",
      "mutable_fields": [],
      "schema_fields": [],
      "validator": "append-jsonl-v1",
      "limits": { "max_bytes": 2097152, "max_append_bytes": 1048576, "max_append_lines": 4096, "max_line_bytes": 2048 },
      "writers": ["scripts/forge-owner-transport-window.js#appendHookEvidence"],
      "capability": "host-attested-append",
      "attestation": "scripts/forge-protected-owner-activity.js#hookAppendProof"
    }
  ],
  "never_declared": [
    { "id": "continue", "pattern": "^\\.gsd/(?:[^/]+/)*continue\\.md$" },
    { "id": "context", "pattern": "^\\.gsd/(?:[^/]+/)*[^/]*-CONTEXT\\.md$" },
    { "id": "brief", "pattern": "^\\.gsd/(?:[^/]+/)*[^/]*-BRIEF\\.md$" },
    { "id": "handoff", "pattern": "^\\.gsd/(?:[^/]+/)*HANDOFF[^/]*\\.md$" },
    { "id": "sessions", "pattern": "^\\.gsd/sessions/(?:[^/]+/)*[^/]+\\.md$" },
    { "id": "questions", "pattern": "^\\.gsd/forge/questions(?:/.*)?$" },
    { "id": "time-contract", "pattern": "^\\.gsd/forge/time/[^/]+/contract\\.json$" },
    { "id": "time-options", "pattern": "^\\.gsd/forge/time/[^/]+/options(?:/.*)?$" },
    { "id": "time-selection", "pattern": "^\\.gsd/forge/time/[^/]+/selection\\.json$" },
    { "id": "time-enrollment", "pattern": "^\\.gsd/forge/time/[^/]+/enrollment\\.json$" },
    { "id": "transactions", "pattern": "^\\.gsd/forge/transactions(?:/.*)?$" },
    { "id": "results", "pattern": "^\\.gsd/forge/results(?:/.*)?$" },
    { "id": "boundaries", "pattern": "^\\.gsd/forge/boundaries(?:/.*)?$" },
    { "id": "plan", "pattern": "^\\.gsd/(?:[^/]+/)*[^/]*-PLAN(?:-GATE)?\\.md$" },
    { "id": "summary", "pattern": "^\\.gsd/(?:[^/]+/)*[^/]*-SUMMARY\\.md$" },
    { "id": "coding-standards", "pattern": "^\\.gsd/CODING-STANDARDS\\.md$" }
  ]
}
`.slice(1);
// DECLARATION-END

class ManagedSurfaceError extends Error {
  constructor(code) {
    const mapped = REASON_CODES.includes(code) ? code
      : typeof code === 'string' && Object.hasOwn(INTERNAL_REASONS, code) ? INTERNAL_REASONS[code] : 'managed-surface-store-invalid';
    super(mapped); this.name = 'ManagedSurfaceError'; this.code = mapped;
    if (mapped !== code) this.diagnostic = Object.hasOwn(INTERNAL_REASONS, code) ? code : 'invalid-reason-code';
  }
}
function fail(code) {
  throw new ManagedSurfaceError(code);
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const HEX64 = /^[a-f0-9]{64}$/;
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function sameKeys(value, keys) {
  const actual = Object.keys(value).sort(), expected = keys.slice().sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
function hexOrNull(value) { return value === null || (typeof value === 'string' && HEX64.test(value)); }

// ── Declaration ──────────────────────────────────────────────────────────────
const SURFACE_FIELDS = Object.freeze(['id', 'version', 'path', 'pattern', 'binding', 'operation', 'mutable_fields', 'schema_fields',
  'validator', 'limits', 'writers', 'capability', 'attestation']);
const CALL_SITE = /^scripts\/[a-z0-9][a-z0-9-]*\.js#[A-Za-z_$][A-Za-z0-9_$]*$/;
function assertShape(candidate) {
  if (!plain(candidate)) fail('managed-surface-declaration-invalid');
  if (candidate.version !== VERSION) fail('managed-surface-version-unknown');
  if (!sameKeys(candidate, ['schema', 'version', 'scope', 'surfaces', 'never_declared'])
      || candidate.schema !== 'forge-managed-surfaces' || typeof candidate.scope !== 'string'
      || !Array.isArray(candidate.surfaces) || !candidate.surfaces.length || candidate.surfaces.length > 64
      || !Array.isArray(candidate.never_declared)) fail('managed-surface-declaration-invalid');
  const ids = new Set();
  for (const s of candidate.surfaces) {
    if (!plain(s) || !sameKeys(s, SURFACE_FIELDS) || typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(s.id) || ids.has(s.id)
        || s.version !== 1 || !BINDINGS.includes(s.binding) || !OPERATIONS.includes(s.operation)
        || VALIDATOR_OPERATION[s.validator] !== s.operation || !CAPABILITIES.includes(s.capability)
        || !Array.isArray(s.writers) || !s.writers.length || s.writers.some(w => typeof w !== 'string' || !CALL_SITE.test(w))
        || !(s.attestation === null || (typeof s.attestation === 'string' && CALL_SITE.test(s.attestation)))
        || (s.capability === 'host-attested-append') !== (s.attestation !== null)
        || (s.capability === 'host-attested-append' && s.operation !== 'append-only')
        || !Array.isArray(s.mutable_fields) || !Array.isArray(s.schema_fields)
        || s.mutable_fields.some(f => typeof f !== 'string' || !s.schema_fields.includes(f))
        || (s.operation === 'field-update') !== (s.mutable_fields.length > 0)
        || !plain(s.limits) || !sameKeys(s.limits, VALIDATOR_LIMITS[s.validator])
        || Object.values(s.limits).some(n => !Number.isSafeInteger(n) || n <= 0)) fail('managed-surface-declaration-invalid');
    const exact = typeof s.path === 'string', patterned = typeof s.pattern === 'string';
    if (exact === patterned || (exact && s.binding !== 'owner') || (patterned && s.binding === 'owner')) fail('managed-surface-declaration-invalid');
    if (exact && (normalizeRelative(s.path) !== s.path || !s.path.startsWith('.gsd/'))) fail('managed-surface-declaration-invalid');
    if (patterned && (!s.pattern.startsWith('^\\.gsd/') || !s.pattern.endsWith('$'))) fail('managed-surface-declaration-invalid');
    ids.add(s.id);
  }
  for (const row of candidate.never_declared) {
    if (!plain(row) || !sameKeys(row, ['id', 'pattern']) || typeof row.id !== 'string' || typeof row.pattern !== 'string'
        || !row.pattern.startsWith('^\\.gsd/') || !row.pattern.endsWith('$')) fail('managed-surface-declaration-invalid');
  }
  return candidate;
}
const DECLARATION = deepFreeze(assertShape(JSON.parse(DECLARATION_TEXT)));
const DECLARATION_DIGEST = roots.digest(DECLARATION_TEXT);
const SURFACES = new Map(DECLARATION.surfaces.map(s => [s.id, s]));
const PATTERNS = new Map(DECLARATION.surfaces.filter(s => s.pattern).map(s => [s.id, new RegExp(s.pattern)]));
// Windows semantics are applied on every platform: refusal lists are case-folded.
const NEVER_DECLARED = Object.freeze(DECLARATION.never_declared.map(row => Object.freeze({ id: row.id, regex: new RegExp(row.pattern, 'i') })));
for (const surface of DECLARATION.surfaces) {
  if (surface.path && NEVER_DECLARED.some(row => row.regex.test(surface.path))) fail('managed-surface-declaration-invalid');
}

function getDeclaration(version = VERSION) {
  if (version !== VERSION) fail('managed-surface-version-unknown');
  return DECLARATION;
}
function declarationDigest(version = VERSION) {
  if (version !== VERSION) fail('managed-surface-version-unknown');
  return DECLARATION_DIGEST;
}
// Only the frozen in-module instance is the declaration. A same-schema object
// rebuilt from JSON, a file or a prompt is refused even when byte-identical.
function assertDeclaration(candidate) {
  assertShape(candidate);
  if (candidate !== DECLARATION) fail('managed-surface-declaration-unattested');
  return DECLARATION;
}

// ── Paths ────────────────────────────────────────────────────────────────────
// One portable spelling per file: forward slashes, NFC, no traversal, no ADS
// (`:`), no device names, no trailing dot/space and no 8.3 short-name alias.
function normalizeRelative(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > LIMITS.relative_bytes) fail('managed-surface-path-invalid');
  if (value.normalize('NFC') !== value) fail('managed-surface-path-invalid');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:<>"|?*]/.test(value) || value.startsWith('/')) fail('managed-surface-path-invalid');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part)) fail('managed-surface-path-invalid');
    if (RESERVED.test(part.split('.')[0].trimEnd()) || SHORT_NAME.test(part)) fail('managed-surface-path-invalid');
  }
  return value;
}
const UNIT_RE = /^execute-task\/T\d+(?:\.\d+)?$/;
const MILESTONE_RE = /^(?:M\d+|M-\d{14}-[a-z0-9-]+)$/;
const SLICE_RE = /^S\d+$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DISPATCH_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Two honest scopes: a milestone attempt (M/S/T identifiers) or a standalone task
// (canonical global task id; milestone and slice are explicit null, never fabricated).
// A mixed form (one null, one string) or an absent key is never valid.
function standaloneTask(unit) {
  if (typeof unit !== 'string' || !unit.startsWith('execute-task/') || UNIT_RE.test(unit)) return false;
  const id = unit.slice('execute-task/'.length);
  return forgeIds.isValid(id) && forgeIds.entityKind(id) === 'task';
}
function assertBinding(binding) {
  if (!plain(binding) || Object.keys(binding).some(key => !ATTEMPT_FIELDS.includes(key))
      || typeof binding.unit !== 'string' || typeof binding.run !== 'string' || !RUN_RE.test(binding.run)
      || !own(binding, 'milestone') || !own(binding, 'slice')
      || (own(binding, 'dispatch_id') && (typeof binding.dispatch_id !== 'string' || !DISPATCH_RE.test(binding.dispatch_id)))) fail('managed-surface-binding-invalid');
  const standalone = binding.milestone === null && binding.slice === null;
  if (standalone ? !standaloneTask(binding.unit)
    : !(UNIT_RE.test(binding.unit) && typeof binding.milestone === 'string' && MILESTONE_RE.test(binding.milestone)
      && typeof binding.slice === 'string' && SLICE_RE.test(binding.slice))) fail('managed-surface-binding-invalid');
  return Object.freeze({ unit: binding.unit, run: binding.run, milestone: binding.milestone, slice: binding.slice,
    ...(own(binding, 'dispatch_id') ? { dispatch_id: binding.dispatch_id } : {}) });
}
function assertAttempt(attempt) {
  if (!plain(attempt) || !sameKeys(attempt, ATTEMPT_FIELDS)) fail('managed-surface-binding-invalid');
  const b = assertBinding(attempt);
  return Object.freeze({ dispatch_id: b.dispatch_id, unit: b.unit, run: b.run, milestone: b.milestone, slice: b.slice });
}
function generationOk(value) {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256) || (Number.isSafeInteger(value) && value >= 0);
}
// Full attempt of an attribution row. Fingerprint, recovery identity and both
// generations are required keys; a lightweight binding is never a row attempt.
function assertFullAttempt(attempt) {
  if (!plain(attempt) || !sameKeys(attempt, FULL_ATTEMPT_FIELDS)) fail('managed-surface-binding-invalid');
  const light = assertAttempt(Object.fromEntries(ATTEMPT_FIELDS.map(key => [key, attempt[key]])));
  if (typeof attempt.fingerprint !== 'string' || !HEX64.test(attempt.fingerprint)
      || typeof attempt.recovery_identity_sha256 !== 'string' || !HEX64.test(attempt.recovery_identity_sha256)
      || !generationOk(attempt.claim_generation) || !generationOk(attempt.lease_generation)) fail('managed-surface-binding-invalid');
  return Object.freeze({ ...light, fingerprint: attempt.fingerprint, recovery_identity_sha256: attempt.recovery_identity_sha256,
    claim_generation: attempt.claim_generation, lease_generation: attempt.lease_generation });
}
function lightAttempt(full) { return Object.fromEntries(ATTEMPT_FIELDS.map(key => [key, full[key]])); }
// Exact attempt-bound path. Canonical constructors are reused, never re-derived:
// lease file names come from forge-unit-lease, evidence names from forge-evidence-path.
function boundPath(surface, binding) {
  let exact;
  if (surface.binding === 'owner') exact = surface.path;
  else if (surface.binding === 'unit-lease-file') exact = `.gsd/forge/leases/${path.basename(lease.leaseFile(path.sep, binding.unit))}`;
  else exact = `.gsd/forge/${evidencePath.buildEvidenceFileName({ milestone: binding.milestone, slice: binding.slice, unit: binding.unit.split('/')[1] })}`;
  if (surface.pattern && !PATTERNS.get(surface.id).test(exact)) fail('managed-surface-binding-invalid');
  return normalizeRelative(exact);
}
function surfacePath(surfaceId, binding) {
  const surface = SURFACES.get(surfaceId);
  if (!surface) fail('managed-surface-surface-unknown');
  return boundPath(surface, assertBinding(binding));
}
function folded(value) { return roots.key(value).toLowerCase(); }
// Returns the declared surface for this exact attempt path, or null. Siblings,
// other units' files and every NEVER_DECLARED path resolve null; a case alias
// of a declared path is refused rather than treated as a different file.
function resolveSurface(relative, binding) {
  const rel = normalizeRelative(relative), b = assertBinding(binding);
  const head = rel.split('/')[0];
  if (head !== '.gsd') {
    if (head.toLowerCase() === '.gsd') fail('managed-surface-path-invalid');
    return null;
  }
  if (NEVER_DECLARED.some(row => row.regex.test(rel))) return null;
  for (const surface of DECLARATION.surfaces) {
    const exact = boundPath(surface, b);
    if (rel === exact) return Object.freeze({ surface_id: surface.id, path: exact, surface });
    if (folded(rel) === folded(exact)) fail('managed-surface-path-invalid');
  }
  return null;
}
// Physical target under the real owner: no symlink/junction component, no
// hardlinked leaf, no case or short-name alias between request and disk.
function physicalTarget(owner, relative) {
  if (typeof owner !== 'string' || !path.isAbsolute(owner) || owner.includes('\0')) fail('managed-surface-path-invalid');
  const rel = normalizeRelative(relative), parts = rel.split('/');
  let real;
  try { real = fs.realpathSync.native(owner); } catch { fail('managed-surface-path-invalid'); }
  let current = real;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') return Object.freeze({ absolute: path.join(real, ...parts), exists: false, real: null });
      fail('managed-surface-path-invalid');
    }
    if (stat.isSymbolicLink()) fail('managed-surface-path-invalid');
    if (i < parts.length - 1 ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1)) fail('managed-surface-path-invalid');
  }
  const resolved = fs.realpathSync.native(current);
  if (path.relative(real, resolved).split(path.sep).join('/') !== rel) fail('managed-surface-path-invalid');
  return Object.freeze({ absolute: current, exists: true, real: resolved });
}
// Bounded, stable read of one declared surface (limit named per surface).
function readSurface(owner, surfaceId, binding) {
  const surface = SURFACES.get(surfaceId);
  if (!surface) fail('managed-surface-surface-unknown');
  const target = physicalTarget(owner, boundPath(surface, assertBinding(binding)));
  if (!target.exists) return null;
  return boundedRead(target.absolute, target.real, surface.limits.max_bytes);
}
function boundedRead(file, real, limit) {
  const read = sources.readBoundedStableFile(file, limit, { expectedReal: real });
  if (read.error === 'source_too_large') fail('managed-surface-size-limit');
  if (read.error) fail('managed-surface-source-unstable');
  return read.buffer;
}

// ── Transition validators ────────────────────────────────────────────────────
const EMPTY = Buffer.alloc(0);
function facts(bytes) { return bytes === null ? { present: false, size: 0, sha256: null } : { present: true, size: bytes.length, sha256: sha(bytes) }; }
function verdict(reason, diff) {
  const error = reason === null ? null : new ManagedSurfaceError(reason);
  return { reason: error ? error.code : null, diff, ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}) };
}
function appendJsonl(spec, before, after) {
  const limits = spec.limits, diff = { kind: 'append', lines_appended: 0, bytes_appended: 0 };
  const prior = before || EMPTY;
  if (after === null) return verdict(before === null ? null : 'managed-surface-append-rewrite', diff);
  if (after.length > limits.max_bytes || prior.length > limits.max_bytes) return verdict('managed-surface-size-limit', diff);
  if (after.length < prior.length || !after.subarray(0, prior.length).equals(prior)) return verdict('managed-surface-append-rewrite', diff);
  if (prior.length && prior[prior.length - 1] !== 0x0a) return verdict('managed-surface-append-invalid', diff);
  const suffix = after.subarray(prior.length);
  diff.bytes_appended = suffix.length;
  if (!suffix.length) return verdict(null, diff);
  if (suffix.length > limits.max_append_bytes) return verdict('managed-surface-append-limit', diff);
  if (suffix[suffix.length - 1] !== 0x0a) return verdict('managed-surface-append-invalid', diff);
  const body = suffix.subarray(0, suffix.length - 1), text = body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(body)) return verdict('managed-surface-append-invalid', diff);
  const lines = text.split('\n');
  diff.lines_appended = lines.length;
  if (lines.length > limits.max_append_lines) return verdict('managed-surface-append-limit', diff);
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > limits.max_line_bytes) return verdict('managed-surface-append-limit', diff);
    if (!line || line.includes('\r')) return verdict('managed-surface-append-invalid', diff);
    let value;
    try { value = JSON.parse(line); } catch { return verdict('managed-surface-append-invalid', diff); }
    if (!plain(value)) return verdict('managed-surface-append-invalid', diff);
  }
  return verdict(null, diff);
}
// The lease writer publishes JSON.stringify(record, null, 2) + LF. Any other
// spelling (duplicate keys, comments, CRLF) is a different writer.
function parseRecord(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!plain(value) || `${JSON.stringify(value, null, 2)}\n` !== text) return null;
  return value;
}
function leaseClock(spec, before, after, options) {
  const surface = spec.surface;
  const diff = { kind: 'fields', fields_changed: [], fields_added: [], fields_removed: [], unknown_fields: { count: 0, sha256_12: [] } };
  if (before === null || after === null) return verdict('managed-surface-record-invalid', diff);
  if (before.length > spec.limits.max_bytes || after.length > spec.limits.max_bytes) return verdict('managed-surface-size-limit', diff);
  const old = parseRecord(before), next = parseRecord(after);
  if (!old || !next) return verdict('managed-surface-record-invalid', diff);
  const schema = new Set(surface.schema_fields), mutable = new Set(surface.mutable_fields);
  const oldKeys = Object.keys(old), nextKeys = Object.keys(next);
  const unknown = [...new Set([...oldKeys, ...nextKeys].filter(key => !schema.has(key)))];
  diff.unknown_fields = { count: unknown.length, sha256_12: unknown.map(key => sha(key).slice(0, 12)).sort() };
  diff.fields_added = nextKeys.filter(key => schema.has(key) && !own(old, key)).sort();
  diff.fields_removed = oldKeys.filter(key => schema.has(key) && !own(next, key)).sort();
  diff.fields_changed = oldKeys.filter(key => schema.has(key) && own(next, key) && JSON.stringify(old[key]) !== JSON.stringify(next[key])).sort();
  if (unknown.length || diff.fields_added.length || diff.fields_removed.length) return verdict('managed-surface-field-unknown', diff);
  const unit = typeof options.binding?.unit === 'string' ? options.binding.unit : old.unit;
  if (!lease.validRecord(old, unit) || !lease.validRecord(next, unit)) return verdict('managed-surface-record-invalid', diff);
  if (diff.fields_changed.some(key => !mutable.has(key))) return verdict('managed-surface-field-immutable', diff);
  if (next.heartbeat_at < old.heartbeat_at || next.expires_at < old.expires_at) return verdict('managed-surface-lease-clock-regressed', diff);
  return verdict(null, diff);
}
function exclusiveCreate(spec, before, after) {
  const diff = { kind: 'create', created: false };
  if (before !== null) return verdict('managed-surface-create-conflict', diff);
  if (after === null) return verdict(null, diff);
  if (after.length > spec.limits.max_bytes) return verdict('managed-surface-size-limit', diff);
  diff.created = true;
  return verdict(null, diff);
}
const VALIDATORS = Object.freeze({ 'append-jsonl-v1': appendJsonl, 'lease-clock-v1': leaseClock, 'exclusive-create-v1': exclusiveCreate });
function transitionSpec(ref) {
  if (typeof ref === 'string') {
    const surface = SURFACES.get(ref);
    if (!surface) fail('managed-surface-surface-unknown');
    return { surface, validator: surface.validator, limits: surface.limits, declared: true };
  }
  if (plain(ref) && sameKeys(ref, ['validator', 'limits']) && VALIDATOR_ONLY.includes(ref.validator) && plain(ref.limits)
      && sameKeys(ref.limits, VALIDATOR_LIMITS[ref.validator]) && Object.values(ref.limits).every(n => Number.isSafeInteger(n) && n > 0)) {
    return { surface: null, validator: ref.validator, limits: Object.freeze({ ...ref.limits }), declared: false };
  }
  // A surface-shaped object (id/path/writers...) is never accepted as a surface.
  fail('managed-surface-surface-unknown');
}
// Pure verdict over two byte images. Never throws for a refused transition and
// never returns content: the diff carries names, counts, sizes and hashes only.
function validateTransition(ref, before, after, options = {}) {
  try {
    const spec = transitionSpec(ref);
    if (!(before === null || Buffer.isBuffer(before)) || !(after === null || Buffer.isBuffer(after)) || !plain(options)) fail('managed-surface-input-invalid');
    if (options.binding !== undefined) assertBinding(options.binding);
    const result = VALIDATORS[spec.validator](spec, before, after, options);
    const diff = deepFreeze({ surface_id: spec.surface ? spec.surface.id : null, operation: VALIDATOR_OPERATION[spec.validator],
      validator: spec.validator, before: facts(before), after: facts(after), ...result.diff });
    return Object.freeze({ ok: result.reason === null, reason_code: result.reason, declared: spec.declared,
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      surface_id: diff.surface_id, operation: diff.operation, validator: diff.validator, diff });
  } catch (error) {
    if (!(error instanceof ManagedSurfaceError)) throw error;
    return Object.freeze({ ok: false, reason_code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      declared: false, surface_id: null, operation: null, validator: null, diff: null });
  }
}
function sanitizedDiff(ref, before, after, options = {}) {
  const result = validateTransition(ref, before, after, options);
  if (!result.diff) fail(result.reason_code);
  return result.diff;
}
// Digest-only observers (preparation surface, SVN strict snapshot) keep no
// preimage of the hook-evidence journal. Recover it from the current bytes: the
// prior sha256 (null = absent) must be a line-boundary prefix, every later
// observed sha256 a boundary at or after it, and the suffix complete JSON-object
// lines within the hook writer's own line cap. Any rewrite, truncation, foreign
// name, link or hardlink answers false. A verdict only; callers keep authority.
const HOOK_APPEND_LIMITS = Object.freeze({ max_bytes: 16 * 1024 * 1024, max_append_bytes: 16 * 1024 * 1024,
  max_append_lines: 65536, max_line_bytes: SURFACES.get('hook-evidence').limits.max_line_bytes });
function hookEvidenceAppendOnly(owner, relative, prior, observed = []) {
  try {
    if (!PATTERNS.get('hook-evidence').test(normalizeRelative(relative)) || !hexOrNull(prior)
        || !Array.isArray(observed) || observed.some(value => !HEX64.test(value))) return false;
    const target = physicalTarget(owner, relative);
    if (!target.exists) return false;
    const bytes = fs.readFileSync(target.absolute), digest = crypto.createHash('sha256'), offsets = new Map([[sha(EMPTY), 0]]);
    for (let start = 0, end; start < bytes.length; start = end) {
      end = bytes.indexOf(0x0a, start); end = end < 0 ? bytes.length : end + 1;
      digest.update(bytes.subarray(start, end));
      if (bytes[end - 1] === 0x0a) offsets.set(digest.copy().digest('hex'), end);
    }
    const from = prior === null ? 0 : offsets.get(prior);
    if (from === undefined || observed.some(value => !(offsets.get(value) >= from))) return false;
    return validateTransition({ validator: 'append-jsonl-v1', limits: { ...HOOK_APPEND_LIMITS } }, null, bytes.subarray(from)).ok;
  } catch { return false; }
}

// ── External store: exclusive preimages and the attribution journal ─────────
// The store lives outside the owner; only components INSIDE it are checked.
// Its parent directory belongs to the caller (it may legitimately be aliased).
function storeRoot(store, create) {
  if (typeof store !== 'string' || !path.isAbsolute(store) || store.includes('\0')) fail('managed-surface-store-invalid');
  let stat;
  try { stat = fs.lstatSync(store); }
  catch (error) {
    if (error.code !== 'ENOENT') fail('managed-surface-store-invalid');
    if (!create) return null;
    try { fs.mkdirSync(store, { mode: 0o700 }); stat = fs.lstatSync(store); } catch { fail('managed-surface-store-invalid'); }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('managed-surface-store-invalid');
  return fs.realpathSync.native(store);
}
function storeDir(real, name, create) {
  const dir = path.join(real, name);
  let stat;
  try { stat = fs.lstatSync(dir); }
  catch (error) {
    if (error.code !== 'ENOENT') fail('managed-surface-store-invalid');
    if (!create) return null;
    try { fs.mkdirSync(dir, { mode: 0o700 }); stat = fs.lstatSync(dir); } catch { fail('managed-surface-store-invalid'); }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('managed-surface-store-invalid');
  if (folded(fs.realpathSync.native(dir)) !== folded(path.join(real, name))) fail('managed-surface-store-invalid');
  return dir;
}
function storeFile(file) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('managed-surface-store-invalid'); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) fail('managed-surface-store-invalid');
  return stat;
}
function readStoreFile(file, limit) {
  if (!storeFile(file)) return null;
  const bytes = boundedRead(file, fs.realpathSync.native(file), limit);
  const after = storeFile(file);
  if (!after) fail('managed-surface-source-unstable');
  return { bytes, stat: after };
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}
function retainPreimage(store, bytes) {
  if (!Buffer.isBuffer(bytes)) fail('managed-surface-input-invalid');
  if (bytes.length > LIMITS.preimage_bytes) fail('managed-surface-size-limit');
  const dir = storeDir(storeRoot(store, true), PREIMAGE_DIR, true), name = sha(bytes), file = path.join(dir, name);
  let created = false;
  if (!storeFile(file)) {
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') fail('managed-surface-store-invalid'); }
    if (fd !== undefined) {
      try { writeAll(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      created = true;
    }
  }
  const stored = readStoreFile(file, LIMITS.preimage_bytes);
  if (!stored) fail('managed-surface-source-unstable');
  if (!stored.bytes.equals(bytes)) fail('managed-surface-preimage-conflict');
  return Object.freeze({ sha256: name, size: bytes.length, created });
}
function readPreimage(store, digestValue) {
  if (typeof digestValue !== 'string' || !HEX64.test(digestValue)) fail('managed-surface-input-invalid');
  const real = storeRoot(store, false), dir = real && storeDir(real, PREIMAGE_DIR, false);
  const stored = dir ? readStoreFile(path.join(dir, digestValue), LIMITS.preimage_bytes) : null;
  if (!stored) fail('managed-surface-preimage-missing');
  if (sha(stored.bytes) !== digestValue) fail('managed-surface-preimage-conflict');
  return stored.bytes;
}
function identityOf(stat) { return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), birthtime_ns: String(stat.birthtimeNs) }); }
function sameIdentity(left, right) {
  return plain(left) && plain(right) && left.dev === right.dev && left.ino === right.ino && left.birthtime_ns === right.birthtime_ns;
}
function anchorOf(bytes, stat, rows) {
  return Object.freeze({ sha256: sha(bytes), size: bytes.length, identity: identityOf(stat), rows });
}
function journalRows(bytes) {
  if (!bytes.length) return [];
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\n')) fail('managed-surface-audit-invalid');
  return text.slice(0, -1).split('\n').map(line => {
    if (!line || line.includes('\r') || Buffer.byteLength(line, 'utf8') > LIMITS.row_bytes) fail('managed-surface-audit-invalid');
    let row;
    try { row = JSON.parse(line); } catch { fail('managed-surface-audit-invalid'); }
    if (!validateAttributionRow(row).ok || JSON.stringify(row) !== line) fail('managed-surface-audit-invalid');
    return deepFreeze(row);
  });
}
function readJournal(store) {
  const real = storeRoot(store, false);
  const stored = real ? readStoreFile(path.join(real, JOURNAL_FILE), LIMITS.journal_bytes) : null;
  if (!stored) return Object.freeze({ rows: Object.freeze([]), anchor: null });
  const rows = Object.freeze(journalRows(stored.bytes));
  return Object.freeze({ rows, anchor: anchorOf(stored.bytes, stored.stat, rows.length) });
}
// Append one attribution row after proving the prefix is exactly the anchor the
// caller last observed (sha256, size, dev/ino/birthtime), and prove it again
// after the write. Rewrite, truncation, insertion or replacement is refused.
function appendJournalRow(store, row, expected) {
  const check = validateAttributionRow(row);
  if (!check.ok) fail(check.reason_code);
  const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  if (line.length > LIMITS.row_bytes) fail('managed-surface-size-limit');
  const file = path.join(storeRoot(store, true), JOURNAL_FILE);
  const present = storeFile(file);
  if (!present) {
    if (expected !== null && expected !== undefined) fail('managed-surface-audit-prefix-changed');
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); } catch { fail('managed-surface-audit-prefix-changed'); }
    try { writeAll(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const written = readStoreFile(file, LIMITS.journal_bytes);
    if (!written || !written.bytes.equals(line)) fail('managed-surface-audit-prefix-changed');
    return anchorOf(written.bytes, written.stat, 1);
  }
  if (!plain(expected) || typeof expected.sha256 !== 'string' || !Number.isSafeInteger(expected.size) || !sameIdentity(expected.identity, expected.identity)) fail('managed-surface-audit-prefix-changed');
  const prefix = readStoreFile(file, LIMITS.journal_bytes);
  if (!prefix || sha(prefix.bytes) !== expected.sha256 || prefix.bytes.length !== expected.size
      || !sameIdentity(identityOf(prefix.stat), expected.identity)) fail('managed-surface-audit-prefix-changed');
  const rows = journalRows(prefix.bytes).length + 1;
  if (prefix.bytes.length + line.length > LIMITS.journal_bytes) fail('managed-surface-size-limit');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(identityOf(opened), expected.identity) || opened.size !== BigInt(expected.size) || opened.nlink !== 1n) fail('managed-surface-audit-prefix-changed');
    writeAll(fd, line); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const after = readStoreFile(file, LIMITS.journal_bytes);
  if (!after || !sameIdentity(identityOf(after.stat), expected.identity) || !after.bytes.equals(Buffer.concat([prefix.bytes, line]))) fail('managed-surface-audit-prefix-changed');
  return anchorOf(after.bytes, after.stat, rows);
}

// ── Attribution rows and chain ───────────────────────────────────────────────
function snapshotDigest(snapshot) {
  if (!plain(snapshot)) fail('managed-surface-input-invalid');
  return roots.digest(Object.entries(snapshot).sort());
}
function attributionRowDigest(row) { return sha(JSON.stringify(row)); }
function lengthOf(bytes) { return bytes === null ? 0 : bytes.length; }
function createdDirsOk(row) {
  const dirs = row.created_dirs;
  if (!Array.isArray(dirs) || dirs.length > 16 || (dirs.length && row.before_sha256 !== null)) return false;
  let last = '';
  for (const dir of dirs) {
    if (typeof dir !== 'string' || !dir.endsWith('/') || dir.length <= last.length || !dir.startsWith(last)
        || !row.path.startsWith(dir) || row.path === dir) return false;
    try { if (normalizeRelative(dir.slice(0, -1)) !== dir.slice(0, -1)) return false; } catch { return false; }
    last = dir;
  }
  return true;
}
function validateAttributionRow(row, expected = {}) {
  const refuse = code => {
    const error = new ManagedSurfaceError(code);
    return Object.freeze({ ok: false, reason_code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) });
  };
  if (!plain(row) || !sameKeys(row, ROW_FIELDS) || row.schema !== ROW_SCHEMA || row.schema_version !== ROW_SCHEMA_VERSION) return refuse('managed-surface-attribution-invalid');
  let attempt;
  try { attempt = assertFullAttempt(row.attempt); } catch { return refuse('managed-surface-attribution-invalid'); }
  if (row.declaration_digest !== DECLARATION_DIGEST || row.declaration_sha256 !== DECLARATION_DIGEST || row.declaration !== VERSION) return refuse('managed-surface-attribution-foreign');
  if (expected.attempt !== undefined) {
    let wanted;
    try { wanted = assertFullAttempt(expected.attempt); } catch { return refuse('managed-surface-input-invalid'); }
    if (roots.digest(wanted) !== roots.digest(attempt)) return refuse('managed-surface-attribution-foreign');
  }
  const surface = SURFACES.get(row.surface_id);
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !surface || row.operation !== surface.operation
      || row.validator !== surface.validator || row.surface_version !== surface.version
      || ![row.before_sha256, row.after_sha256, row.preimage_sha256, row.previous_row_sha256].every(hexOrNull)
      || typeof row.diff_sha256 !== 'string' || !HEX64.test(row.diff_sha256) || typeof row.baseline_sha256 !== 'string' || !HEX64.test(row.baseline_sha256)
      || row.before_sha256 === row.after_sha256 || (row.sequence === 1) !== (row.previous_row_sha256 === null)) return refuse('managed-surface-attribution-invalid');
  if (typeof row.writer !== 'string' || !surface.writers.includes(row.writer)) return refuse('managed-surface-attribution-forged');
  if (row.attestation_reference !== surface.attestation) {
    return refuse(surface.attestation !== null && row.attestation_reference === null ? 'managed-surface-attestation-required' : 'managed-surface-attribution-invalid');
  }
  if (![row.before_length, row.after_length, row.appended].every(n => Number.isSafeInteger(n) && n >= 0)
      || (row.before_sha256 === null && row.before_length !== 0) || (row.after_sha256 === null && row.after_length !== 0)
      || (surface.operation === 'append-only' ? row.after_length - row.before_length !== row.appended : row.appended !== 0)) return refuse('managed-surface-attribution-invalid');
  const fields = row.fields_changed;
  if (!Array.isArray(fields) || fields.some((f, i) => typeof f !== 'string' || !surface.mutable_fields.includes(f) || (i > 0 && f <= fields[i - 1]))
      || (surface.operation === 'field-update') !== (fields.length > 0) || !createdDirsOk(row)) return refuse('managed-surface-attribution-invalid');
  let exact;
  try { exact = boundPath(surface, lightAttempt(attempt)); } catch { return refuse('managed-surface-attribution-invalid'); }
  if (row.path !== exact) return refuse('managed-surface-attribution-invalid');
  if (expected.baseline_sha256 !== undefined && row.baseline_sha256 !== expected.baseline_sha256) return refuse('managed-surface-baseline-unbound');
  return Object.freeze({ ok: true, reason_code: null });
}
// Builds (never publishes) a row for a transition the named validator accepts.
function createAttributionRow(input) {
  if (!plain(input)) fail('managed-surface-input-invalid');
  // Lengths and change metadata are derived from the validated bytes, never supplied.
  const attempt = assertFullAttempt(input.attempt), surface = SURFACES.get(input.surface_id);
  if (!surface) fail('managed-surface-surface-unknown');
  const before = input.before === undefined ? null : input.before, after = input.after === undefined ? null : input.after;
  const result = validateTransition(surface.id, before, after, { binding: lightAttempt(attempt) });
  if (!result.ok) fail(result.reason_code);
  const row = {
    schema: ROW_SCHEMA, schema_version: ROW_SCHEMA_VERSION, declaration: VERSION, declaration_sha256: DECLARATION_DIGEST,
    declaration_digest: DECLARATION_DIGEST, surface_version: surface.version, attempt: { ...attempt }, sequence: input.sequence,
    surface_id: surface.id, path: boundPath(surface, lightAttempt(attempt)), operation: surface.operation, validator: surface.validator,
    writer: input.writer, attestation_reference: surface.attestation,
    before_sha256: before ? sha(before) : null, after_sha256: after ? sha(after) : null,
    before_length: lengthOf(before), after_length: lengthOf(after), preimage_sha256: before ? sha(before) : null,
    diff_sha256: roots.digest(result.diff), fields_changed: [...(result.diff.fields_changed || [])],
    appended: result.diff.bytes_appended || 0, created_dirs: input.created_dirs === undefined ? [] : input.created_dirs,
    previous_row_sha256: input.previous_row_sha256 === undefined ? null : input.previous_row_sha256,
    baseline_sha256: input.baseline_sha256,
  };
  const check = validateAttributionRow(row);
  if (!check.ok) fail(check.reason_code);
  return deepFreeze(row);
}
function preimageCode(store, digestValue) {
  if (store === undefined || store === null) return 'managed-surface-preimage-missing';
  try { readPreimage(store, digestValue); return null; }
  catch (error) {
    if (!(error instanceof ManagedSurfaceError)) throw error;
    return error.code === 'managed-surface-preimage-conflict' ? error.code : 'managed-surface-preimage-missing';
  }
}
// Deterministic per-path verdict over S0, the current snapshot and the rows.
// Snapshot values follow protectedSnapshot: sha256 for files, 'directory' for dirs.
function verifyAttributionChain(input) {
  if (!plain(input) || !plain(input.baseline) || !plain(input.current) || !Array.isArray(input.rows)
      || input.rows.length > LIMITS.chain_rows) fail('managed-surface-input-invalid');
  const attempt = assertFullAttempt(input.attempt), baselineSha = snapshotDigest(input.baseline);
  const reasons = new Map(), counts = new Map(), state = new Map(), seen = new Set();
  let previous = null, broken = false, invalid = 0;
  const mark = (file, code) => { if (!reasons.has(file)) reasons.set(file, code); };
  input.rows.forEach((row, index) => {
    const usable = plain(row) && typeof row.path === 'string' && row.path.length > 0 && row.path.length <= LIMITS.relative_bytes;
    if (!usable) { invalid++; broken = true; previous = null; return; }
    const file = row.path, line = attributionRowDigest(row);
    counts.set(file, (counts.get(file) || 0) + 1);
    const check = validateAttributionRow(row, { attempt, baseline_sha256: baselineSha });
    const repeated = seen.has(line);
    seen.add(line);
    if (!check.ok) { mark(file, check.reason_code); previous = line; return; }
    if (broken || repeated || row.sequence !== index + 1 || row.previous_row_sha256 !== previous) {
      mark(file, 'managed-surface-attribution-reused'); broken = true; previous = line; return;
    }
    previous = line;
    const prior = state.has(file) ? state.get(file) : (own(input.baseline, file) ? input.baseline[file] : null);
    state.set(file, row.after_sha256);
    if (row.before_sha256 !== prior) { mark(file, 'managed-surface-baseline-unbound'); return; }
    if (row.before_sha256 !== null) {
      const code = row.preimage_sha256 !== row.before_sha256 ? 'managed-surface-preimage-missing' : preimageCode(input.store, row.before_sha256);
      if (code) mark(file, code);
    } else if (row.preimage_sha256 !== null) mark(file, 'managed-surface-attribution-invalid');
  });
  const changed = [...new Set([...Object.keys(input.baseline), ...Object.keys(input.current)])]
    .filter(file => (own(input.baseline, file) ? input.baseline[file] : null) !== (own(input.current, file) ? input.current[file] : null));
  const paths = [...new Set([...changed, ...counts.keys()])].sort().map(file => {
    const rows = counts.get(file) || 0, now = own(input.current, file) ? input.current[file] : null;
    const reason = reasons.get(file) || (!rows || state.get(file) !== now ? 'managed-surface-delta-unattributed' : null);
    const error = reason ? new ManagedSurfaceError(reason) : null;
    return { path: file, status: reason ? 'unexplained' : 'attributed', reason_code: error ? error.code : null,
      ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}), rows };
  });
  return deepFreeze({ ok: invalid === 0 && paths.every(row => row.status === 'attributed'), baseline_sha256: baselineSha,
    rows: input.rows.length, rows_invalid: invalid, paths });
}

function listing(version) {
  const declaration = getDeclaration(version);
  return {
    version: declaration.version, declaration_digest: declarationDigest(version),
    surfaces: declaration.surfaces.map(s => ({ id: s.id, version: s.version, path: s.path, pattern: s.pattern, operation: s.operation,
      validator: s.validator, capability: s.capability, writers: s.writers, mutable_fields: s.mutable_fields, limits: s.limits })),
    never_declared: declaration.never_declared.map(row => row.id),
    reason_codes: REASON_CODES,
  };
}
function cli(argv, io = process) {
  try {
    if (argv[0] !== '--list' || !(argv.length === 1 || (argv.length === 3 && argv[1] === '--version'))) fail('managed-surface-usage');
    io.stdout.write(`${JSON.stringify(listing(argv.length === 3 ? argv[2] : VERSION))}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof ManagedSurfaceError)) throw error;
    io.stderr.write(`${JSON.stringify({ ok: false, reason_code: error.code })}\n`);
    return 2;
  }
}

module.exports = {
  VERSION, OPERATIONS, CAPABILITIES, PROCESS_CLASSES, ROUTES, REASON_CODES, LIMITS, ROW_SCHEMA, ROW_SCHEMA_VERSION, ROW_FIELDS, ATTEMPT_FIELDS, FULL_ATTEMPT_FIELDS, NEVER_DECLARED,
  VALIDATOR_ONLY, ManagedSurfaceError,
  getDeclaration, declarationDigest, assertDeclaration,
  normalizeRelative, resolveSurface, surfacePath, physicalTarget, readSurface,
  validateTransition, sanitizedDiff, hookEvidenceAppendOnly,
  retainPreimage, readPreimage, appendJournalRow, readJournal,
  snapshotDigest, attributionRowDigest, validateAttributionRow, createAttributionRow, verifyAttributionChain,
  cli,
};
if (require.main === module) process.exitCode = cli(process.argv.slice(2));
