#!/usr/bin/env node
'use strict';

// E2E evidence labels, provenance and sanitization (issue #440, S03/T01).
// One responsibility: decide whether an evidence directory is honestly `mock`,
// `recorded` or `real`. A label is never promoted from manifest metadata:
// recorded replay never becomes real, synthetic bytes never become captured,
// and `real` requires an opaque live handle created in THIS process from the
// same observed capture. The handle proves only that the verified recording was
// derived here from the capture handed to createLiveObservation; it is never by
// itself proof of a provider call. Diagnostics carry codes, counts and hashes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isSafeModelId } = require('./forge-sidecar-diagnostic');

const EVIDENCE_VERSION = 'e2e-evidence-v1';
const ALLOWLIST_VERSION = 'e2e-allowlist-v1';
const SANITIZER_VERSION = 'e2e-sanitizer-v1';
const LABELS = Object.freeze(['mock', 'recorded', 'real']);
const ORIGINS = Object.freeze(['synthetic', 'captured']);
const EXECUTION_MODES = Object.freeze(['synthetic', 'replay', 'live']);
const CHANNELS = Object.freeze(['host', 'worker', 'attempt']);
const REASON_CODES = Object.freeze([
  'e2e-arguments-invalid', 'e2e-version-unknown', 'e2e-manifest-invalid', 'e2e-label-invalid',
  'e2e-label-origin-mismatch', 'e2e-real-requires-live', 'e2e-synthetic-promotion',
  'e2e-provenance-missing', 'e2e-provenance-unbound', 'e2e-file-missing', 'e2e-file-unsafe',
  'e2e-file-too-large', 'e2e-file-hash-mismatch', 'e2e-record-invalid', 'e2e-sanitization-field',
  'e2e-sanitization-secret', 'e2e-sanitization-path', 'e2e-sanitization-email',
  'e2e-sanitization-identity', 'e2e-expect-mismatch',
]);
const LABEL_RULES = Object.freeze({
  mock: Object.freeze({ origin: 'synthetic', execution_mode: 'synthetic' }),
  recorded: Object.freeze({ origin: 'captured', execution_mode: 'replay' }),
  real: Object.freeze({ origin: 'captured', execution_mode: 'live' }),
});
const LIMITS = Object.freeze({ max_files: 8, max_file_bytes: 4 * 1024 * 1024, max_line_bytes: 64 * 1024,
  max_records: 20000, max_manifest_bytes: 64 * 1024, max_pin_bytes: 4 * 1024 * 1024, max_dir_entries: 256 });
const MANIFEST = 'manifest.json';
const SOURCE_ROOT = path.resolve(__dirname, '..');
const CURRENT_PIN = 'shared/schemas/codex-appserver-pin.json';
const HISTORICAL_PINS = 'scripts/fixtures/schema-pin';

// ── Field types and the versioned allowlist ─────────────────────────────────
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+[\]-]{0,159}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const T = Object.freeze({
  token: v => typeof v === 'string' && TOKEN_RE.test(v),
  model: v => isSafeModelId(v),
  text: v => typeof v === 'string' && v.length <= 8192,
  hash: v => typeof v === 'string' && HEX64.test(v),
  uint: v => Number.isSafeInteger(v) && v >= 0,
  // Keep legacy synthetic counters; preserve the actual lease tokenOf hex32 value.
  generation: v => (Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)),
  int: v => Number.isSafeInteger(v),
  bool: v => v === true || v === false,
  direction: v => v === 'client' || v === 'server',
  rpcId: v => (Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && TOKEN_RE.test(v)),
  tokens: v => Array.isArray(v) && v.length <= 256 && v.every(x => typeof x === 'string' && TOKEN_RE.test(x)),
  counts: v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 32
    && Object.entries(v).every(([k, n]) => /^[a-z][a-z0-9_]{0,63}$/.test(k) && Number.isSafeInteger(n) && n >= 0),
});
const spec = (fields, required = []) => Object.freeze({ fields: Object.freeze(fields), required: Object.freeze(required) });
const WORKER_BASE = { direction: 'direction', offset_ms: 'uint' };
const ALLOWLIST = Object.freeze({
  host: Object.freeze({
    init: spec({ model: 'model', claude_code_version: 'token', permission_mode: 'token', tools: 'tokens' }, ['claude_code_version']),
    tool_use: spec({ name: 'token', command: 'text', id_sha256: 'hash' }, ['name']),
    tool_result: spec({ id_sha256: 'hash', is_error: 'bool', content_sha256: 'hash', content_bytes: 'uint',
      cli_status: 'token', cli_sha256: 'hash' }, ['content_sha256']),
    assistant_text: spec({ text_sha256: 'hash', text_bytes: 'uint' }, ['text_sha256']),
    result: spec({ subtype: 'token', is_error: 'bool', num_turns: 'uint', duration_ms: 'uint', models: 'tokens', usage: 'counts' }, ['subtype']),
  }),
  worker: Object.freeze({
    request: spec({ ...WORKER_BASE, method: 'token', rpc_id: 'rpcId', model: 'model', effort: 'token',
      approval_policy: 'token', ephemeral: 'bool', sandbox_type: 'token', client_name: 'token', client_version: 'token',
      input_sha256: 'hash', input_bytes: 'uint', output_schema_sha256: 'hash', output_schema_bytes: 'uint',
      thread_id_sha256: 'hash' }, ['direction', 'offset_ms', 'method', 'rpc_id']),
    response: spec({ ...WORKER_BASE, rpc_id: 'rpcId', server_name: 'token', server_version: 'token',
      user_agent_product: 'token', user_agent_sha256: 'hash', thread_id_sha256: 'hash', turn_id_sha256: 'hash',
      error_code: 'int' }, ['direction', 'offset_ms', 'rpc_id']),
    notification: spec({ ...WORKER_BASE, method: 'token', item_type: 'token', item_id_sha256: 'hash', phase: 'token',
      status: 'token', text: 'text', text_sha256: 'hash', text_bytes: 'uint', usage: 'counts', error_code: 'token',
      thread_id_sha256: 'hash', turn_id_sha256: 'hash' }, ['direction', 'offset_ms', 'method']),
  }),
  attempt: Object.freeze({
    receipt: spec({ phase: 'token', provider_called: 'bool', reason_code: 'token' }, ['phase']),
    identity: spec({ dispatch_sha256: 'hash', fingerprint_sha256: 'hash', recovery_identity_sha256: 'hash',
      request_bytes: 'uint', request_sha256: 'hash', context_bytes: 'uint', context_sha256: 'hash',
      claim_sha256: 'hash', lease_generation: 'generation' }, ['dispatch_sha256', 'fingerprint_sha256',
      'recovery_identity_sha256', 'claim_sha256', 'lease_generation']),
    custody: spec({ method: 'token', status: 'token', joined: 'bool', active: 'uint' }, ['method', 'status']),
    event: spec({ name: 'token', status: 'token' }, ['name']),
    gate: spec({ name: 'token', status: 'token' }, ['name', 'status']),
  }),
});
const BASE_KEYS = Object.freeze(['channel', 'seq', 'origin', 'kind']);

// ── Closed scan vocabulary (applied to every string, recursively) ───────────
const SCANS = Object.freeze([
  ['e2e-sanitization-secret', /\bsk-[A-Za-z0-9_-]{8,}|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|\b(?:gh[pousr]_[A-Za-z0-9]{16,}|xox[abpr]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|authorization|password|secret)\b["']?\s*[:=]\s*["']?(?!<)[^\s"',;<]{6,}/i],
  ['e2e-sanitization-path', /[A-Za-z]:[\\/]+users[\\/]+(?!<)[^\\/\s"'<>]+|(?:^|[^A-Za-z0-9_.-])\/(?:home|Users)\/(?!<)[^/\s"'<>]+/i],
  ['e2e-sanitization-email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['e2e-sanitization-identity', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
]);
const SECRET_KEY_RE = /^(?:.*_)?(?:token|authorization|api_?key|apikey|secret|password)$/i;

class EvidenceError extends Error {
  constructor(code) { super(REASON_CODES.includes(code) ? code : 'e2e-manifest-invalid'); this.code = this.message; }
}
function refuse(code) { throw new EvidenceError(code); }
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
    || (typeof value === 'number' && !Number.isFinite(value))) refuse('e2e-record-invalid');
  return JSON.stringify(value);
}
function serializeRecords(records) { return records.map(record => canonicalJson(record) + '\n').join(''); }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const k of Object.keys(value)) deepFreeze(value[k]); }
  return value;
}

// ── scanRecords: allowlist, types and secret/path/e-mail/identity scan ──────
function scanStrings(value, field, seq, violations, key = null) {
  if (typeof value === 'string') {
    if (key !== null && SECRET_KEY_RE.test(key)) violations.push({ code: 'e2e-sanitization-secret', seq, field });
    for (const [code, re] of SCANS) if (re.test(value)) violations.push({ code, seq, field });
  } else if (Array.isArray(value)) value.forEach(item => scanStrings(item, field, seq, violations));
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) {
    // Object keys are content too (counts maps); scan them as strings.
    for (const [code, re] of SCANS) if (re.test(k)) violations.push({ code, seq, field });
    scanStrings(v, field, seq, violations, k);
  }
}
function scanRecords(records) {
  const violations = [];
  if (!Array.isArray(records)) return { ok: false, violations: [{ code: 'e2e-record-invalid', seq: null, field: null }], records: 0 };
  records.forEach((record, index) => {
    const seq = index;
    if (!isObject(record) || !CHANNELS.includes(record.channel) || !ORIGINS.includes(record.origin)
        || record.seq !== index || typeof record.kind !== 'string' || !Object.hasOwn(ALLOWLIST[record.channel], record.kind)) {
      violations.push({ code: 'e2e-record-invalid', seq, field: null }); return;
    }
    const rule = ALLOWLIST[record.channel][record.kind];
    for (const [key, value] of Object.entries(record)) {
      if (BASE_KEYS.includes(key)) continue;
      // Unknown names are never echoed: the name itself may be content.
      if (!Object.hasOwn(rule.fields, key)) { violations.push({ code: 'e2e-sanitization-field', seq, field: null }); continue; }
      if (!T[rule.fields[key]](value)) violations.push({ code: 'e2e-record-invalid', seq, field: key });
      scanStrings(value, key, seq, violations, key);
    }
    for (const key of rule.required) if (!Object.hasOwn(record, key)) violations.push({ code: 'e2e-record-invalid', seq, field: key });
    // Only the agent's final answer may carry free text, and only after this scan.
    if (Object.hasOwn(record, 'text') && !(record.item_type === 'agentMessage' && record.phase === 'final_answer')) {
      violations.push({ code: 'e2e-sanitization-field', seq, field: 'text' });
    }
  });
  return { ok: violations.length === 0, violations, records: records.length };
}

// ── sanitizeCapture: documented raw contract → allowlisted records ───────────
function sanitizeCapture(raw, { origin = 'captured' } = {}) {
  if (!isObject(raw) || !ORIGINS.includes(origin) || !CHANNELS.every(ch => Array.isArray(raw[ch]) && raw[ch].length <= LIMITS.max_records)
      || (raw.placeholders !== undefined && !isObject(raw.placeholders))) refuse('e2e-record-invalid');
  const placeholders = Object.entries(raw.placeholders || {});
  for (const [from, to] of placeholders) {
    if (typeof from !== 'string' || from.length < 2 || typeof to !== 'string' || !/^<[A-Z][A-Z0-9_]{0,31}>$/.test(to)) refuse('e2e-record-invalid');
  }
  const counts = { input: { host: raw.host.length, worker: raw.worker.length, attempt: raw.attempt.length },
    records: { host: 0, worker: 0, attempt: 0 }, unparsed_lines: 0, dropped_lines: 0, dropped_fields: 0,
    hashed_texts: 0, redacted: { path: 0, secret: 0, email: 0, identity: 0 } };
  const replacers = placeholders.sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
    .map(([from, to]) => [new RegExp(from.split(/[\\/]+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+'),
      /^[A-Za-z]:/.test(from) ? 'gi' : 'g'), to]);
  const count = (re, text, key) => { const n = (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length; counts.redacted[key] += n; return n; };
  function clean(text) {
    let out = String(text);
    for (const [re, to] of replacers) { count(re, out, 'path'); out = out.replace(re, to); }
    const sub = (re, key, to) => { if (count(re, out, key)) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), to); };
    sub(SCANS[0][1], 'secret', '<REDACTED>');
    sub(/[A-Za-z]:[\\/]+users[\\/]+[^\s"'<>|]*/i, 'path', '<USER_PATH>');
    sub(/(^|[^A-Za-z0-9_.<-])\/(?:home|Users)\/[^\s"'<>|]*/, 'path', '$1<USER_PATH>');
    sub(/\b[A-Za-z]:[\\/][^\s"'<>|]*/, 'path', '<ABS_PATH>');
    sub(SCANS[2][1], 'email', '<EMAIL>');
    out = out.replace(new RegExp(SCANS[3][1].source, 'gi'), id => { counts.redacted.identity++; return `<ID-${sha256('e2e-id-v1\0' + id.toLowerCase()).slice(0, 16)}>`; });
    return out;
  }
  const idHash = value => (typeof value === 'string' || Number.isSafeInteger(value)) ? sha256('e2e-id-v1\0' + String(value)) : undefined;
  const typed = (type, value) => {
    if (value === undefined) return undefined;
    if (T[type](value) && !SCANS.some(([, re]) => typeof value === 'string' && re.test(value))) return value;
    counts.dropped_fields++; return undefined; // unsafe or mistyped value: discarded and counted
  };
  const bytesOf = value => Buffer.byteLength(typeof value === 'string' ? value : canonicalJson(value));
  const hashOf = value => sha256(typeof value === 'string' ? value : canonicalJson(value));
  const drop = (obj, used) => { if (isObject(obj)) counts.dropped_fields += Object.keys(obj).filter(k => !used.includes(k)).length; };
  const usage = value => {
    if (!isObject(value)) return undefined;
    const out = {};
    for (const [k, n] of Object.entries(value)) if (/^[a-z][a-z0-9_]{0,63}$/.test(k) && Number.isSafeInteger(n) && n >= 0) out[k] = n; else counts.dropped_fields++;
    return Object.keys(out).length ? out : undefined;
  };
  const out = { host: [], worker: [], attempt: [] };
  const emit = (channel, kind, fields) => {
    const record = { channel, kind, origin };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) record[k] = v;
    out[channel].push(record);
  };
  const parse = line => {
    if (typeof line !== 'string' || Buffer.byteLength(line) > LIMITS.max_line_bytes) { counts.unparsed_lines++; return null; }
    try { const value = JSON.parse(line); if (isObject(value)) return value; } catch { /* counted below */ }
    counts.unparsed_lines++; return null;
  };
  for (const line of raw.host) {
    const obj = parse(line); if (!obj) continue;
    if (obj.type === 'system' && obj.subtype === 'init') {
      drop(obj, ['type', 'subtype', 'model', 'claude_code_version', 'permissionMode', 'tools']);
      emit('host', 'init', { model: typed('model', obj.model), claude_code_version: typed('token', obj.claude_code_version),
        permission_mode: typed('token', obj.permissionMode),
        tools: Array.isArray(obj.tools) ? obj.tools.map(t => typed('token', typeof t === 'string' ? t : t && t.name)).filter(Boolean).sort() : undefined });
    } else if ((obj.type === 'assistant' || obj.type === 'user') && isObject(obj.message) && Array.isArray(obj.message.content)) {
      drop(obj, ['type', 'message']); drop(obj.message, ['content']);
      for (const block of obj.message.content) {
        if (isObject(block) && block.type === 'tool_use' && obj.type === 'assistant') {
          drop(block, ['type', 'id', 'name', 'input']); drop(block.input, ['command']);
          emit('host', 'tool_use', { name: typed('token', block.name), id_sha256: idHash(block.id),
            command: isObject(block.input) && typeof block.input.command === 'string' ? clean(block.input.command).slice(0, 8192) : undefined });
        } else if (isObject(block) && block.type === 'tool_result' && obj.type === 'user') {
          drop(block, ['type', 'tool_use_id', 'is_error', 'content']);
          const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
            ? block.content.map(part => (isObject(part) && typeof part.text === 'string' ? part.text : '')).join('\n') : '';
          const last = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
          let cli = null; try { cli = last && JSON.parse(last); } catch { cli = null; }
          counts.hashed_texts++;
          emit('host', 'tool_result', { id_sha256: idHash(block.tool_use_id), is_error: typed('bool', block.is_error),
            content_sha256: sha256(text), content_bytes: Buffer.byteLength(text),
            cli_status: isObject(cli) ? typed('token', cli.status) : undefined, cli_sha256: isObject(cli) ? sha256(last) : undefined });
        } else if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
          drop(block, ['type', 'text']); counts.hashed_texts++;
          emit('host', 'assistant_text', { text_sha256: sha256(block.text), text_bytes: Buffer.byteLength(block.text) });
        } else counts.dropped_fields++;
      }
    } else if (obj.type === 'result') {
      drop(obj, ['type', 'subtype', 'is_error', 'num_turns', 'duration_ms', 'modelUsage', 'usage']);
      emit('host', 'result', { subtype: typed('token', obj.subtype), is_error: typed('bool', obj.is_error),
        num_turns: typed('uint', obj.num_turns), duration_ms: typed('uint', obj.duration_ms),
        models: isObject(obj.modelUsage) ? Object.keys(obj.modelUsage).filter(m => typed('model', m)).sort() : undefined,
        usage: usage(obj.usage) });
    } else counts.dropped_lines++;
  }
  for (const entry of raw.worker) {
    if (!isObject(entry) || !T.direction(entry.direction) || !T.uint(entry.offset_ms)) { counts.dropped_lines++; continue; }
    const obj = parse(entry.line); if (!obj) continue;
    const base = { direction: entry.direction, offset_ms: entry.offset_ms };
    const p = isObject(obj.params) ? obj.params : {};
    if (typeof obj.method === 'string' && Object.hasOwn(obj, 'id')) {
      drop(obj, ['jsonrpc', 'id', 'method', 'params']);
      drop(p, ['model', 'effort', 'approvalPolicy', 'ephemeral', 'sandbox', 'sandboxPolicy', 'clientInfo', 'input', 'outputSchema', 'threadId']);
      emit('worker', 'request', { ...base, method: typed('token', obj.method), rpc_id: typed('rpcId', obj.id), model: typed('model', p.model),
        effort: typed('token', p.effort), approval_policy: typed('token', p.approvalPolicy), ephemeral: typed('bool', p.ephemeral),
        sandbox_type: typed('token', typeof p.sandbox === 'string' ? p.sandbox : isObject(p.sandboxPolicy) ? p.sandboxPolicy.type : undefined),
        client_name: isObject(p.clientInfo) ? typed('token', p.clientInfo.name) : undefined,
        client_version: isObject(p.clientInfo) ? typed('token', p.clientInfo.version) : undefined,
        input_sha256: p.input !== undefined ? hashOf(p.input) : undefined, input_bytes: p.input !== undefined ? bytesOf(p.input) : undefined,
        output_schema_sha256: p.outputSchema !== undefined ? hashOf(p.outputSchema) : undefined,
        output_schema_bytes: p.outputSchema !== undefined ? bytesOf(p.outputSchema) : undefined,
        thread_id_sha256: p.threadId !== undefined ? idHash(p.threadId) : undefined });
    } else if (typeof obj.method === 'string') {
      const item = isObject(p.item) ? p.item : null, turn = isObject(p.turn) ? p.turn : null;
      drop(obj, ['jsonrpc', 'method', 'params']); drop(p, ['item', 'turn', 'usage', 'tokenUsage', 'threadId', 'turnId']);
      const finalText = item && item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string';
      if (item) drop(item, ['type', 'id', 'phase', 'status', 'text']);
      if (item && typeof item.text === 'string' && !finalText) counts.hashed_texts++;
      const error = turn && isObject(turn.error) ? turn.error : null;
      emit('worker', 'notification', { ...base, method: typed('token', obj.method), item_type: item ? typed('token', item.type) : undefined,
        item_id_sha256: item && item.id !== undefined ? idHash(item.id) : undefined, phase: item ? typed('token', item.phase) : undefined,
        status: typed('token', item ? item.status : turn ? turn.status : undefined),
        text: finalText ? clean(item.text).slice(0, 8192) : undefined,
        text_sha256: item && typeof item.text === 'string' && !finalText ? sha256(item.text) : undefined,
        text_bytes: item && typeof item.text === 'string' && !finalText ? Buffer.byteLength(item.text) : undefined,
        usage: usage(p.usage || (isObject(p.tokenUsage) ? p.tokenUsage.total || p.tokenUsage : undefined) || (turn ? turn.usage : undefined)),
        error_code: error ? typed('token', typeof error.code === 'number' ? String(error.code) : error.code) : undefined,
        thread_id_sha256: p.threadId !== undefined ? idHash(p.threadId) : undefined,
        turn_id_sha256: p.turnId !== undefined ? idHash(p.turnId) : turn && turn.id !== undefined ? idHash(turn.id) : undefined });
    } else if (Object.hasOwn(obj, 'id') && (Object.hasOwn(obj, 'result') || Object.hasOwn(obj, 'error'))) {
      const r = isObject(obj.result) ? obj.result : {};
      drop(obj, ['jsonrpc', 'id', 'result', 'error']); drop(r, ['serverInfo', 'userAgent', 'thread', 'turn']);
      const agent = typeof r.userAgent === 'string' ? r.userAgent : null;
      emit('worker', 'response', { ...base, rpc_id: typed('rpcId', obj.id),
        server_name: isObject(r.serverInfo) ? typed('token', r.serverInfo.name) : undefined,
        server_version: isObject(r.serverInfo) ? typed('token', r.serverInfo.version) : undefined,
        user_agent_product: agent ? typed('token', agent.split(/\s+/)[0]) : undefined, user_agent_sha256: agent ? sha256(agent) : undefined,
        thread_id_sha256: isObject(r.thread) && r.thread.id !== undefined ? idHash(r.thread.id) : undefined,
        turn_id_sha256: isObject(r.turn) && r.turn.id !== undefined ? idHash(r.turn.id) : undefined,
        error_code: isObject(obj.error) ? typed('int', obj.error.code) : undefined });
    } else counts.dropped_lines++;
  }
  for (const entry of raw.attempt) {
    if (!isObject(entry) || typeof entry.kind !== 'string' || !Object.hasOwn(ALLOWLIST.attempt, entry.kind) || !isObject(entry.value)) { counts.dropped_lines++; continue; }
    const rule = ALLOWLIST.attempt[entry.kind], fields = {};
    for (const [k, v] of Object.entries(entry.value)) {
      const value = Object.hasOwn(rule.fields, k) ? typed(rule.fields[k], v) : undefined;
      if (value === undefined) counts.dropped_fields++; else fields[k] = value;
    }
    emit('attempt', entry.kind, fields);
  }
  const records = [];
  for (const channel of CHANNELS) for (const record of out[channel]) { counts.records[channel]++; records.push({ ...record, seq: records.length }); }
  return { records, counts, transform: { sanitizer_version: SANITIZER_VERSION, allowlist_version: ALLOWLIST_VERSION,
    raw_capture_sha256: sha256(canonicalJson(raw)), placeholder_tokens: [...new Set(placeholders.map(([, to]) => to))].sort() } };
}

// ── Live observation: opaque, frozen, valid only inside this process ────────
const liveObservations = new WeakMap();
function syntheticMarkers(records) {
  return records.some(r => ['claude_code_version', 'server_version', 'user_agent_product', 'client_version', 'model']
    .some(k => typeof r[k] === 'string' && /^mock-/i.test(r[k])));
}
function createLiveObservation(capture) {
  // The handle is bound to the SAME observed capture: its recording is derived
  // here, never accepted from a caller-supplied hash, PID or imported JSON.
  const { records, transform } = sanitizeCapture(capture, { origin: 'captured' });
  if (syntheticMarkers(records)) refuse('e2e-synthetic-promotion');
  const handle = Object.freeze({ kind: 'e2e-live-observation' });
  liveObservations.set(handle, Object.freeze({ raw_capture_sha256: transform.raw_capture_sha256,
    recording_sha256: sha256(serializeRecords(records)), records: records.length, pid: process.pid }));
  return handle;
}

// ── Bounded, link-free, case-exact reads inside one directory ───────────────
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function openDirectory(dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) { refuse(['ENOENT', 'ENOTDIR'].includes(error.code) ? 'e2e-file-missing' : 'e2e-file-unsafe'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse('e2e-file-unsafe');
  const real = fs.realpathSync.native(dir);
  const entries = fs.readdirSync(dir);
  if (entries.length > LIMITS.max_dir_entries) refuse('e2e-file-unsafe');
  const folded = new Set();
  for (const entry of entries) { const key = entry.toLowerCase(); if (folded.has(key)) refuse('e2e-file-unsafe'); folded.add(key); }
  return { dir, real, entries };
}
function readContained(box, name, limit) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name === '.' || name === '..' || name.includes('..')) refuse('e2e-file-unsafe');
  if (!box.entries.includes(name)) refuse(box.entries.some(e => e.toLowerCase() === name.toLowerCase()) ? 'e2e-file-unsafe' : 'e2e-file-missing');
  const file = path.join(box.dir, name);
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); } catch (error) { refuse(['ENOENT', 'ENOTDIR'].includes(error.code) ? 'e2e-file-missing' : 'e2e-file-unsafe'); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) refuse('e2e-file-unsafe');
  if (stat.size > BigInt(limit)) refuse('e2e-file-too-large');
  const real = fs.realpathSync.native(file);
  const expected = path.join(box.real, name);
  if (process.platform === 'win32' ? real.toLowerCase() !== expected.toLowerCase() : real !== expected) refuse('e2e-file-unsafe');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.nlink !== 1n) refuse('e2e-file-unsafe');
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) { const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (n === 0) break; offset += n; }
    if (offset !== buffer.length || fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) refuse('e2e-file-unsafe');
    return buffer;
  } finally { fs.closeSync(fd); }
}
function decodeUtf8(buffer, code) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) refuse(code);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return refuse(code); }
}

// ── Manifest structure and provenance shape ─────────────────────────────────
const MANIFEST_KEYS = Object.freeze(['evidence_version', 'label', 'origin', 'execution_mode', 'route', 'provenance', 'files', 'counts', 'limits']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
function hasShape(value, shape) {
  if (!isObject(value) || Object.keys(value).some(k => !Object.hasOwn(shape, k))) return false;
  return Object.entries(shape).every(([k, check]) => Object.hasOwn(value, k) && (typeof check === 'function' ? check(value[k]) : hasShape(value[k], check)));
}
const PROVENANCE_SHAPE = Object.freeze({
  captured_at: v => v === 'synthetic' || (typeof v === 'string' && ISO.test(v)),
  method: T.token,
  tools: v => Array.isArray(v) && v.length <= 16 && v.every(t => hasShape(t, { name: T.token, sha256: T.hash })),
  versions: { host: T.token, worker: T.token, node: T.token,
    appserver_schema_pin: { path: v => typeof v === 'string' && v.length <= 160, sha256: T.hash, codex_version: T.token },
    forge: { revision: T.token, dirty: T.bool }, os: { platform: T.token, release: T.token, arch: T.token } },
  attempt: { dispatch_sha256: T.hash, fingerprint_sha256: T.hash, recovery_identity_sha256: T.hash, claim_sha256: T.hash, lease_generation: T.generation },
  raw_capture_sha256: T.hash,
  sanitizer: { version: T.token, allowlist_version: T.token },
  environment_overrides: v => Array.isArray(v) && v.length <= 32 && v.every(n => typeof n === 'string' && ENV_NAME.test(n)),
});
const ROUTE_SHAPE = Object.freeze({ host: v => ['claude-code', 'codex'].includes(v), worker: v => ['codex', 'claude'].includes(v),
  transport: v => ['app-server', 'exec', 'stream-json'].includes(v), worker_mode: T.token });
const COUNT_SHAPE = Object.freeze({ records: T.uint, host: T.uint, worker: T.uint, attempt: T.uint });
function schemaPins() {
  const pins = [];
  const add = rel => {
    const box = openDirectory(path.join(SOURCE_ROOT, path.dirname(rel)));
    const bytes = readContained(box, path.basename(rel), LIMITS.max_pin_bytes);
    let version = null;
    try { const meta = JSON.parse(bytes.toString('utf8')).meta; version = isObject(meta) && T.token(meta.codex_version) ? meta.codex_version : null; } catch { version = null; }
    if (version) pins.push({ path: rel, sha256: sha256(bytes), codex_version: version });
  };
  add(CURRENT_PIN);
  try {
    for (const name of fs.readdirSync(path.join(SOURCE_ROOT, HISTORICAL_PINS)).sort()) {
      if (/^codex-appserver-pin-[0-9A-Za-z.-]{1,40}\.json$/.test(name)) add(`${HISTORICAL_PINS}/${name}`);
    }
  } catch (error) { if (!(error instanceof EvidenceError) && error.code !== 'ENOENT') throw error; }
  return pins;
}

// ── verifyEvidence ──────────────────────────────────────────────────────────
function verifyEvidence(dir, { expect = null, live = null, limits = null } = {}) {
  const view = { ok: false, label: null, origin: null, execution_mode: null, files: [], reason_code: null };
  try {
    if (expect !== null && !LABELS.includes(expect)) refuse('e2e-arguments-invalid');
    if (typeof dir !== 'string' || !dir) refuse('e2e-arguments-invalid');
    const lim = { ...LIMITS };
    if (isObject(limits)) for (const k of Object.keys(LIMITS)) if (T.uint(limits[k]) && limits[k] < lim[k]) lim[k] = limits[k];
    const box = openDirectory(path.resolve(dir));
    let manifest;
    try { manifest = JSON.parse(decodeUtf8(readContained(box, MANIFEST, lim.max_manifest_bytes), 'e2e-manifest-invalid')); } catch (error) {
      if (error instanceof EvidenceError) throw error; refuse('e2e-manifest-invalid');
    }
    if (!isObject(manifest) || Object.keys(manifest).some(k => !MANIFEST_KEYS.includes(k))) refuse('e2e-manifest-invalid');
    if (manifest.evidence_version !== EVIDENCE_VERSION) refuse('e2e-version-unknown');
    if (!LABELS.includes(manifest.label) || !ORIGINS.includes(manifest.origin) || !EXECUTION_MODES.includes(manifest.execution_mode)) refuse('e2e-label-invalid');
    Object.assign(view, { label: manifest.label, origin: manifest.origin, execution_mode: manifest.execution_mode });
    const rule = LABEL_RULES[manifest.label];
    if (manifest.origin !== rule.origin || manifest.execution_mode !== rule.execution_mode) refuse('e2e-label-origin-mismatch');
    // Offline verification (CLI, imported JSON, matching hashes) never yields `real`.
    if (manifest.label === 'real' && !liveObservations.has(live)) refuse('e2e-real-requires-live');
    if (!hasShape(manifest.route, ROUTE_SHAPE) || !hasShape(manifest.provenance, PROVENANCE_SHAPE)) refuse('e2e-provenance-missing');
    if (!hasShape(manifest.counts, COUNT_SHAPE) || !isObject(manifest.limits)
        || Object.keys(manifest.limits).length !== Object.keys(LIMITS).length
        || Object.entries(LIMITS).some(([k, v]) => manifest.limits[k] !== v)) refuse('e2e-manifest-invalid');
    const prov = manifest.provenance, versions = prov.versions;
    const syntheticProvenance = prov.captured_at === 'synthetic' || /synthetic|mock/i.test(prov.method)
      || [versions.host, versions.worker, versions.forge.revision].some(v => /^mock-/i.test(v));
    if (manifest.label === 'mock' && !(prov.captured_at === 'synthetic' && /synthetic/.test(prov.method))) refuse('e2e-label-origin-mismatch');
    if (manifest.label !== 'mock' && syntheticProvenance) refuse('e2e-synthetic-promotion');
    if (prov.sanitizer.version !== SANITIZER_VERSION || prov.sanitizer.allowlist_version !== ALLOWLIST_VERSION) refuse('e2e-version-unknown');
    const manifestScan = []; scanStrings(manifest, null, null, manifestScan);
    if (manifestScan.length) refuse(manifestScan[0].code);
    // Files: listed only, contained, bounded, hashed and counted.
    if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > lim.max_files
        || !manifest.files.every(f => hasShape(f, { path: v => typeof v === 'string', sha256: T.hash, bytes: T.uint, records: T.uint }))) refuse('e2e-manifest-invalid');
    const folded = new Set();
    for (const f of manifest.files) {
      if (!SAFE_NAME.test(f.path) || f.path.includes('..') || !f.path.endsWith('.jsonl')) refuse('e2e-file-unsafe');
      if (folded.has(f.path.toLowerCase())) refuse('e2e-file-unsafe');
      folded.add(f.path.toLowerCase());
    }
    const records = [], files = [];
    for (const f of manifest.files) {
      if (f.bytes > lim.max_file_bytes) refuse('e2e-file-too-large');
      const bytes = readContained(box, f.path, lim.max_file_bytes);
      if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) refuse('e2e-file-hash-mismatch');
      const text = decodeUtf8(bytes, 'e2e-record-invalid');
      if (!text.endsWith('\n') || text.includes('\r')) refuse('e2e-record-invalid');
      const lines = text.slice(0, -1).split('\n');
      if (records.length + lines.length > lim.max_records) refuse('e2e-file-too-large');
      for (const line of lines) {
        if (Buffer.byteLength(line) > lim.max_line_bytes) refuse('e2e-file-too-large');
        let record; try { record = JSON.parse(line); } catch { refuse('e2e-record-invalid'); }
        if (canonicalJson(record) !== line) refuse('e2e-record-invalid');
        records.push(record);
      }
      if (lines.length !== f.records) refuse('e2e-provenance-unbound');
      files.push({ path: f.path, sha256: f.sha256, bytes: f.bytes, records: f.records });
    }
    const scan = scanRecords(records);
    if (!scan.ok) refuse(scan.violations[0].code);
    if (records.some(r => r.origin !== manifest.origin)) refuse('e2e-label-origin-mismatch');
    if (manifest.label !== 'mock' && syntheticMarkers(records)) refuse('e2e-synthetic-promotion');
    // Binding: manifest facts must be the content's facts; nothing is created from the manifest.
    const by = ch => records.filter(r => r.channel === ch);
    const actual = { records: records.length, host: by('host').length, worker: by('worker').length, attempt: by('attempt').length };
    if (CHANNELS.concat('records').some(k => manifest.counts[k] !== actual[k])) refuse('e2e-provenance-unbound');
    const init = by('host').find(r => r.kind === 'init');
    if (!init || init.claude_code_version !== versions.host) refuse('e2e-provenance-unbound');
    const initRequest = by('worker').find(r => r.kind === 'request' && r.direction === 'client' && r.method === 'initialize');
    const initResponse = initRequest && by('worker').find(r => r.kind === 'response' && r.direction === 'server' && r.rpc_id === initRequest.rpc_id);
    const workerVersion = initResponse && (initResponse.server_version
      || (initResponse.user_agent_product && initResponse.user_agent_product.includes('/') ? initResponse.user_agent_product.split('/').pop() : null));
    if (!workerVersion || workerVersion !== versions.worker) refuse('e2e-provenance-unbound');
    const pin = versions.appserver_schema_pin;
    if (!schemaPins().some(p => p.path === pin.path && p.sha256 === pin.sha256 && p.codex_version === pin.codex_version)) refuse('e2e-provenance-unbound');
    const identity = by('attempt').find(r => r.kind === 'identity');
    if (!identity || Object.keys(PROVENANCE_SHAPE.attempt).some(k => identity[k] !== prov.attempt[k])) refuse('e2e-provenance-unbound');
    if (manifest.label === 'real') {
      const facts = liveObservations.get(live);
      if (!facts || facts.pid !== process.pid || facts.raw_capture_sha256 !== prov.raw_capture_sha256
          || !files.some(f => f.sha256 === facts.recording_sha256 && f.records === facts.records)) refuse('e2e-real-requires-live');
    }
    if (expect !== null && manifest.label !== expect) refuse('e2e-expect-mismatch');
    return deepFreeze({ ...view, ok: true, files, reason_code: null, counts: actual, live_bound: manifest.label === 'real' });
  } catch (error) {
    if (!(error instanceof EvidenceError)) return deepFreeze({ ...view, ok: false, files: [], reason_code: 'e2e-file-unsafe' });
    return deepFreeze({ ...view, ok: false, files: [], reason_code: error.code });
  }
}

function main(argv = process.argv.slice(2), out = process.stdout) {
  const options = {};
  let valid = argv.length % 2 === 0 && argv.length > 0;
  for (let i = 0; valid && i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--verify', '--expect'].includes(key) || typeof value !== 'string' || !value || Object.hasOwn(options, key)) valid = false;
    else options[key] = value;
  }
  if (!valid || !options['--verify']) {
    out.write(JSON.stringify({ ok: false, label: null, origin: null, execution_mode: null, files: [], reason_code: 'e2e-arguments-invalid' }) + '\n');
    return 2;
  }
  const result = verifyEvidence(options['--verify'], { expect: options['--expect'] ?? null });
  out.write(JSON.stringify({ ok: result.ok, label: result.label, origin: result.origin, execution_mode: result.execution_mode,
    files: result.files, reason_code: result.reason_code }) + '\n');
  return result.ok ? 0 : 1;
}

module.exports = {
  EVIDENCE_VERSION, ALLOWLIST_VERSION, SANITIZER_VERSION, LABELS, ORIGINS, EXECUTION_MODES, CHANNELS, REASON_CODES,
  LABEL_RULES, LIMITS, ALLOWLIST, sanitizeCapture, scanRecords, createLiveObservation, verifyEvidence,
  canonicalJson, serializeRecords, main,
};
if (require.main === module) process.exitCode = main();
