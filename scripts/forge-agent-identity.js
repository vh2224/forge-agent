#!/usr/bin/env node
'use strict';

// Native agent identity as canonical data. The identifier is the opaque value a
// host tool actually returned; it is never derived from task_name, never used
// as a path or command, and is appended only after publication through a proven
// owner channel. Caller-attested provenance is a label, not authorization.

const fs = require('fs');
const path = require('path');
const { plainText } = require('./forge-sidecar-identity');
const { code } = require('./forge-attempt-telemetry');

const EVENT_KEYS = Object.freeze(['ts', 'event', 'unit', 'dispatch_id', 'host_runtime', 'worker_mode', 'agent_type',
  'task_name', 'agent_id', 'agent_id_source', 'evidence', 'lifecycle_identity_sha256', 'description']);
const AGENT_ID = /^[A-Za-z0-9/][A-Za-z0-9/_.:-]{0,255}$/;
const AGENT_TYPE = /^forge-[a-z][a-z-]{0,40}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HOSTS = new Set(['codex', 'claude']);
const EVIDENCE = new Set(['native-lifecycle', 'caller-attested']);
const AGENT_ID_SOURCE = 'host-tool-return';
const DESCRIPTION_MAX = 160;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const MAX_PLAN_BYTES = 1024 * 1024;
const EVENTS_RELATIVE = ['.gsd', 'forge', 'events.jsonl'];
const CONFLICT_CODES = new Set(['agent-identity-conflict', 'agent-identity-unit-open', 'agent-identity-events-too-large']);

function fail(reason) { throw Object.assign(new Error(reason), { code: reason }); }

function validateAgentId(value) {
  if (typeof value !== 'string' || value === '') return { ok: false, reason_code: 'agent-id-empty' };
  if (value.length > 256) return { ok: false, reason_code: 'agent-id-too-long' };
  if (AGENT_ID.test(value)) return { ok: true, value };
  // ESC covers ANSI/OSC; any other non-ASCII covers bidi marks and separators.
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return { ok: false, reason_code: 'agent-id-control' };
  if (/[^\x20-\x7e]/.test(value)) return { ok: false, reason_code: 'agent-id-non-ascii' };
  return { ok: false, reason_code: 'agent-id-invalid' };
}

// Exact host_identity record kept by forge-native-supervision; anything else is null.
function normalizeHostIdentity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (Object.keys(record).sort().join(',') !== 'conflict,dispatch_id,observed_ms,source,value') return null;
  const { value, source, observed_ms: observedMs, dispatch_id: dispatchId, conflict } = record;
  if (!validateAgentId(value).ok || source !== AGENT_ID_SOURCE || !Number.isSafeInteger(observedMs) || observedMs < 0
      || typeof conflict !== 'boolean' || !(dispatchId === null || code(dispatchId) === dispatchId)) return null;
  return { value, source, observed_ms: observedMs, dispatch_id: dispatchId, conflict };
}

function sanitizeDescription(value) {
  return plainText(value, { missing: null, limit: DESCRIPTION_MAX });
}

function safeCode(value, reason) {
  if (typeof value !== 'string' || code(value) !== value) fail(reason);
  return value;
}

function buildAgentIdentityEvent(fields = {}, now = Date.now) {
  const optional = name => fields[name] === undefined ? null : fields[name];
  const agentId = optional('agent_id'), source = optional('agent_id_source');
  if (agentId !== null) {
    const checked = validateAgentId(agentId);
    if (!checked.ok) fail(checked.reason_code);
    if (source !== AGENT_ID_SOURCE) fail('agent-identity-source-required');
  } else if (source !== null) fail('agent-identity-source-without-id');
  const evidence = fields.evidence;
  if (!EVIDENCE.has(evidence)) fail('agent-identity-evidence-invalid');
  const lifecycle = optional('lifecycle_identity_sha256');
  if (evidence === 'native-lifecycle' ? agentId === null || !/^[a-f0-9]{64}$/.test(lifecycle || '') : lifecycle !== null) {
    fail('agent-identity-evidence-invalid');
  }
  if (!HOSTS.has(fields.host_runtime)) fail('agent-identity-host-invalid');
  if (typeof fields.agent_type !== 'string' || !AGENT_TYPE.test(fields.agent_type)) fail('agent-identity-agent-type-invalid');
  const taskName = optional('task_name');
  if (taskName !== null) safeCode(taskName, 'agent-identity-task-name-invalid');
  let ts = optional('ts');
  if (ts === null) ts = new Date(typeof now === 'function' ? now() : now).toISOString();
  else if (typeof ts !== 'string' || !ISO_WITH_ZONE.test(ts) || Number.isNaN(Date.parse(ts))) fail('agent-identity-ts-invalid');
  return {
    ts, event: 'agent-identity',
    unit: safeCode(fields.unit, 'agent-identity-unit-invalid'),
    dispatch_id: safeCode(fields.dispatch_id, 'agent-identity-dispatch-invalid'),
    host_runtime: fields.host_runtime, worker_mode: 'native', agent_type: fields.agent_type,
    task_name: taskName, agent_id: agentId, agent_id_source: source, evidence,
    lifecycle_identity_sha256: lifecycle, description: sanitizeDescription(optional('description')),
  };
}

// One JSON line with its terminating newline; only a closed, revalidated event renders.
function renderAgentIdentityEvent(event) {
  if (!event || typeof event !== 'object' || Object.keys(event).join(',') !== EVENT_KEYS.join(',')
      || event.event !== 'agent-identity' || event.worker_mode !== 'native') fail('agent-identity-event-invalid');
  const line = JSON.stringify(event);
  if (line !== JSON.stringify(buildAgentIdentityEvent(event)) || /[\n\r\u{2028}\u{2029}]/u.test(line)) fail('agent-identity-event-invalid');
  return `${line}\n`;
}

// Exact binding of a native lifecycle to the invocation and trusted request it
// supervised (same digest as invokeNative). Returns event fields; never appends.
function identityFromLifecycle({ lifecycle, request, invocation } = {}) {
  const refuse = reason => ({ ok: false, reason_code: reason });
  if (!lifecycle || typeof lifecycle !== 'object' || !request || typeof request !== 'object'
      || !invocation || typeof invocation !== 'object') return refuse('agent-identity-binding');
  const { digest } = require('./forge-native-supervision');
  if (lifecycle.identity !== digest(JSON.stringify({ invocation, identity: request }))) return refuse('agent-identity-binding');
  if (lifecycle.host_identity === undefined || lifecycle.host_identity === null) return refuse('agent-identity-unobserved');
  const host = normalizeHostIdentity(lifecycle.host_identity);
  if (!host) return refuse('agent-identity-binding');
  if (host.conflict) return refuse('agent-identity-conflict');
  if (typeof request.dispatchId !== 'string' || code(request.dispatchId) !== request.dispatchId
      || host.dispatch_id !== request.dispatchId) return refuse('agent-identity-binding');
  const args = invocation.args || {};
  return { ok: true, fields: { dispatch_id: request.dispatchId, host_runtime: invocation.host_runtime,
    agent_type: args.agent_type || args.subagent_type || null, task_name: args.task_name ?? null,
    agent_id: host.value, agent_id_source: AGENT_ID_SOURCE, evidence: 'native-lifecycle',
    lifecycle_identity_sha256: lifecycle.identity } };
}

function boundedRead(file, maxBytes) {
  let real;
  try { real = fs.realpathSync.native(file); } catch { return { error: 'source_unreadable' }; }
  return require('./forge-autonomy-sources').readBoundedStableFile(real, maxBytes, { expectedReal: real });
}

// Same dispatch with the same agent_id is already recorded; any other agent_id
// for that dispatch is a conflict. Nothing is written in either case.
function alreadyRecorded(file, event) {
  if (!fs.existsSync(file)) return false;
  const read = boundedRead(file, MAX_EVENTS_BYTES);
  if (read.error === 'source_too_large') fail('agent-identity-events-too-large');
  if (read.error) fail('agent-identity-events-unreadable');
  let same = false;
  for (const row of read.buffer.toString('utf8').split('\n')) {
    let parsed;
    try { parsed = JSON.parse(row); } catch { continue; }
    if (parsed?.event !== 'agent-identity' || parsed.dispatch_id !== event.dispatch_id) continue;
    if (parsed.agent_id !== event.agent_id) fail('agent-identity-conflict');
    same = true;
  }
  return same;
}

function assertClosedReceipt(file, dispatchId) {
  if (typeof file !== 'string' || !file) fail('agent-identity-receipt-required');
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail('agent-identity-receipt-invalid'); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('agent-identity-receipt-invalid');
  const read = boundedRead(file, MAX_RECEIPT_BYTES);
  if (read.error) fail('agent-identity-receipt-invalid');
  let receipt;
  try { receipt = JSON.parse(read.buffer.toString('utf8')); } catch { fail('agent-identity-receipt-invalid'); }
  if (!receipt || typeof receipt !== 'object' || !['ready', 'failed'].includes(receipt.phase)
      || receipt.dispatch_id !== dispatchId) fail('agent-identity-unit-open');
}

// The owner's existing .gsd/forge directory; this module never creates .gsd.
function existingEventsDirectory(owner) {
  if (typeof owner !== 'string' || !owner || owner.includes('\0')) fail('agent-identity-owner-invalid');
  let real;
  try { real = fs.realpathSync.native(path.resolve(owner)); } catch { fail('agent-identity-events-dir-missing'); }
  for (const part of [EVENTS_RELATIVE.slice(0, 1), EVENTS_RELATIVE.slice(0, 2)]) {
    let stat;
    try { stat = fs.lstatSync(path.join(real, ...part)); } catch { fail('agent-identity-events-dir-missing'); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('agent-identity-events-path');
  }
  return real;
}

function appendUnderOwnerLock(owner, event, receiptFile) {
  const line = renderAgentIdentityEvent(event);
  const real = existingEventsDirectory(owner);
  return require('./forge-artifact-reconciliation').withOwnerLock(real, () => {
    existingEventsDirectory(real);
    if (receiptFile !== null) assertClosedReceipt(receiptFile, event.dispatch_id);
    const file = path.join(real, ...EVENTS_RELATIVE);
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) fail('agent-identity-events-path');
    if (alreadyRecorded(file, event)) return { status: 'already-recorded', line };
    fs.appendFileSync(file, line, { mode: 0o600 });
    return { status: 'appended', line };
  });
}

// Channels: a live broker, the owner's appendOwnerEvent capability, or, after
// publication, the owner lock with a matching closed receipt.
async function appendAgentIdentityEvent(channel, fields, options = {}) {
  const kinds = ['broker', 'appendOwnerEvent', 'owner'].filter(name => channel && channel[name] !== undefined);
  if (kinds.length !== 1) fail('agent-identity-channel-required');
  const event = buildAgentIdentityEvent(fields, options.now);
  const line = renderAgentIdentityEvent(event);
  if (kinds[0] === 'broker') {
    const broker = require('./forge-artifact-reconciliation').assertBroker(channel.broker);
    if (alreadyRecorded(path.join(broker.manifest.owner, ...EVENTS_RELATIVE), event)) return { status: 'already-recorded', line };
    await broker.append(EVENTS_RELATIVE.join('/'), line);
    return { status: 'appended', line };
  }
  if (kinds[0] === 'appendOwnerEvent') {
    if (typeof channel.appendOwnerEvent !== 'function') fail('agent-identity-channel-required');
    await channel.appendOwnerEvent(line);
    return { status: 'appended', line };
  }
  if (typeof channel.closedReceiptFile !== 'string' || !channel.closedReceiptFile) fail('agent-identity-receipt-required');
  return appendUnderOwnerLock(channel.owner, event, channel.closedReceiptFile);
}

function planTitle(file) {
  const read = boundedRead(file, MAX_PLAN_BYTES);
  if (read.error) fail('agent-identity-plan-unreadable');
  const text = read.buffer.toString('utf8');
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const scalar = frontmatter && frontmatter[1].match(/^title\s*:\s*(.+?)\s*$/m);
  if (scalar) {
    const value = scalar[1];
    if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }
  const heading = text.match(/^#{1,6}[ \t]+(.+?)[ \t#]*$/m);
  if (!heading) fail('agent-identity-plan-title-missing');
  return heading[1];
}

const USAGE = 'uso: forge-agent-identity.js --record --unit <unidade> --dispatch-id <dispatch> --host codex|claude'
  + ' --agent-type forge-<tipo> [--task-name <nome>] [--agent-id <id> --agent-id-source host-tool-return]'
  + ' [--description <texto>] [--ts <iso>] [--events <owner>/.gsd/forge/events.jsonl [--receipt <receipt.json>]]'
  + ' | --task-name --unit <unidade> (--title <título> | --plan <arquivo>) --attempt <tentativa>';
const MESSAGES = {
  'agent-identity-usage': USAGE,
  'agent-identity-conflict': 'outro agent_id já está registrado para este dispatch; nada foi escrito',
  'agent-identity-unit-open': 'o receipt não está fechado (ready ou failed) para este dispatch; registre só depois da aceitação ou da publicação',
  'agent-identity-events-too-large': 'o arquivo de eventos passa de 16 MiB; nada foi escrito',
  'agent-identity-events-dir-missing': 'o diretório .gsd/forge do owner não existe; nada foi criado nem escrito',
};

function parseFlags(argv, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!allowed.includes(flag) || typeof value !== 'string' || Object.hasOwn(values, flag)) fail('agent-identity-usage');
    values[flag] = value;
  }
  return values;
}

function eventsOwner(events) {
  const resolved = path.resolve(events);
  if (resolved.split(/[\\/]/).slice(-3).join('/') !== EVENTS_RELATIVE.join('/')) fail('agent-identity-events-path');
  return path.dirname(path.dirname(path.dirname(resolved)));
}

function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const [mode, ...rest] = argv;
    if (mode === '--task-name') {
      const flags = parseFlags(rest, ['--unit', '--title', '--plan', '--attempt']);
      if (!flags['--unit'] || !flags['--attempt'] || ('--title' in flags) === ('--plan' in flags)) fail('agent-identity-usage');
      const title = '--plan' in flags ? planTitle(flags['--plan']) : flags['--title'];
      const name = require('./forge-native-invocation').humanTaskName({ unitId: flags['--unit'], title, attempt: flags['--attempt'] });
      if (!name) fail('agent-identity-task-name-empty');
      io.stdout.write(`${name}\n`);
      return 0;
    }
    if (mode !== '--record') fail('agent-identity-usage');
    const flags = parseFlags(rest, ['--unit', '--dispatch-id', '--host', '--agent-type', '--task-name', '--agent-id',
      '--agent-id-source', '--description', '--ts', '--events', '--receipt']);
    if (['--unit', '--dispatch-id', '--host', '--agent-type'].some(flag => !(flag in flags))
        || ('--receipt' in flags && !('--events' in flags))) fail('agent-identity-usage');
    // Caller-attested: the parent records the value its host tool returned. The
    // agent_id stays null without --agent-id, even when a task name is present.
    const event = buildAgentIdentityEvent({ unit: flags['--unit'], dispatch_id: flags['--dispatch-id'],
      host_runtime: flags['--host'], agent_type: flags['--agent-type'], task_name: flags['--task-name'],
      agent_id: flags['--agent-id'], agent_id_source: flags['--agent-id-source'], evidence: 'caller-attested',
      description: flags['--description'], ts: flags['--ts'] });
    if (!('--events' in flags)) {
      io.stdout.write(renderAgentIdentityEvent(event));
      return 0;
    }
    // Without --receipt this is the skill flow right after the tool returned, when
    // no protected owner window is open; inside one, record only after acceptance
    // or publication and pass the closed receipt.
    const result = appendUnderOwnerLock(eventsOwner(flags['--events']), event, flags['--receipt'] ?? null);
    io.stdout.write(result.line);
    io.stderr.write(result.status === 'appended' ? 'identidade do agente registrada\n'
      : 'identidade já registrada para este dispatch; nada foi escrito\n');
    return 0;
  } catch (error) {
    const reason = code(error?.code, 'agent-identity-failed');
    io.stderr.write(`forge-agent-identity: ${reason} — ${MESSAGES[reason] || 'valor inválido ou indisponível; nada foi escrito'}\n`);
    if (CONFLICT_CODES.has(reason)) return 3;
    return /^agent-id(?:entity)?-/.test(reason) && reason !== 'agent-identity-failed' ? 2 : 3;
  }
}

module.exports = {
  EVENT_KEYS, validateAgentId, normalizeHostIdentity, sanitizeDescription, buildAgentIdentityEvent,
  renderAgentIdentityEvent, identityFromLifecycle, appendAgentIdentityEvent, main,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
