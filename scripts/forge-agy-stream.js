'use strict';

const { TextDecoder } = require('util');
const crypto = require('crypto');

// Same style as the Claude reducer limits; openTools bounds in-flight tool windows.
const LIMITS = Object.freeze({ line: 1048576, stdout: 16777216, stderr: 1048576, events: 100000,
  reconstruction: 1048576, openTools: 32, idBytes: 256 });
const TOOL_STEP_TYPES = Object.freeze(['tool']);
const CLOSING_STATES = Object.freeze(['DONE']);
const RESPONSE_STEP_TYPES = Object.freeze(['agent_response']);
const STEP_TYPES = Object.freeze(['user_input', 'agent_response', 'tool', 'checkpoint']);
const STEP_STATES = Object.freeze(['ACTIVE', 'DONE']);
const SUCCESS_STATUS = 'SUCCESS';
const SHORT_FIELD_CHARS = 32;

function failure(reason) {
  throw Object.assign(new Error('agy stream refused.'), { reason });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= LIMITS.idBytes
    ? value : null;
}

function shortField(value, upper) {
  if (typeof value !== 'string' || !value.trim() || value.length > SHORT_FIELD_CHARS) return null;
  return upper ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

/**
 * Documented assumption, not a live capture: the event names (init, step_update,
 * result), the field names (conversation_id, step_index, state, step_type, the
 * chunk `text`, tool_info.error, status, response) and the step type vocabulary
 * (user_input, agent_response, tool, checkpoint) follow the Streaming JSON section
 * of https://antigravity.google/docs/cli/headless. Anything else normalizes to
 * null, which callers treat as non-progress and never as a crash.
 */
function normalizeEvent(value) {
  if (!plainObject(value) || typeof value.event !== 'string') return null;
  if (value.event === 'init') {
    const conversation = boundedId(value.conversation_id);
    return conversation ? { kind: 'init', conversation } : null;
  }
  if (value.event === 'step_update') {
    const update = value.step_update;
    if (!plainObject(update)) return null;
    const step = update.step_index;
    const state = shortField(update.state, true);
    if (!Number.isSafeInteger(step) || step < 0 || !STEP_STATES.includes(state)) return null;
    const conversation = update.conversation_id === undefined ? null : boundedId(update.conversation_id);
    if (update.conversation_id !== undefined && !conversation) return null;
    const type = shortField(update.step_type, false);
    if (!STEP_TYPES.includes(type)) return null;
    return { kind: 'step', conversation, step, state, type,
      chunk: typeof update.text === 'string' ? update.text : null,
      toolError: plainObject(update.tool_info) && update.tool_info.error != null };
  }
  if (value.event === 'result') {
    const status = shortField(value.status, true);
    if (!status) return null;
    const conversation = value.conversation_id === undefined ? null : boundedId(value.conversation_id);
    if (value.conversation_id !== undefined && !conversation) return null;
    return { kind: 'result', conversation, status,
      response: typeof value.response === 'string' ? value.response : null };
  }
  return null;
}

function createReducer(options = {}) {
  const clock = options.clock || (() => performance.now());
  options = null;
  const started = clock();
  let highWater = started;
  const elapsed = () => {
    highWater = Math.max(highWater, clock());
    return Math.max(0, Math.floor(highWater - started));
  };
  let pending = Buffer.alloc(0), terminal = null, conversation = null;
  const seen = new Set(), open = new Map();
  let chunks = [], reconstruction = 0, reconstructionOverflow = false;
  // Suspended-window counter, not a timestamp (same meaning as the Claude reducer).
  let epoch = 0, suspended = false;
  let first = null, last = null, remote = 0, events = 0, stdout = 0, stderr = 0;
  let disposed = false, finalSnapshot = null;

  function eligible() {
    const time = elapsed();
    if (first === null) first = time;
    last = time;
    remote++;
  }

  function openTool(key) {
    if (open.size >= LIMITS.openTools) open.delete(open.keys().next().value);
    open.set(key, true);
    // Parallel tools share the window: only the zero-to-one transition opens it.
    if (!suspended) { last = elapsed(); epoch++; }
    suspended = true;
  }

  function closeTool(key) {
    if (!open.delete(key)) return;
    if (open.size === 0 && suspended) {
      suspended = false;
      last = elapsed();
    }
  }

  function keepChunk(event) {
    if (event.chunk === null || !RESPONSE_STEP_TYPES.includes(event.type) || reconstructionOverflow) return;
    const bytes = Buffer.byteLength(event.chunk);
    if (reconstruction + bytes > LIMITS.reconstruction) {
      reconstructionOverflow = true;
      chunks = [];
      return;
    }
    reconstruction += bytes;
    chunks.push(event.chunk);
  }

  function step(event) {
    if (conversation !== null && event.conversation !== conversation) return;
    // Repeated fragments stay in the response, even when they cannot renew liveness.
    keepChunk(event);
    const key = (event.conversation ?? conversation ?? '') + '\0' + event.step;
    const tool = TOOL_STEP_TYPES.includes(event.type);
    // A repeated ACTIVE for an open tool never reopens the window nor moves its anchor.
    if (tool && event.state === 'ACTIVE' && open.has(key)) return;
    const fingerprint = sha256(['step', event.conversation ?? conversation ?? '', event.step, event.state,
      event.type, event.chunk === null ? '' : sha256(event.chunk)].join('\0'));
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    eligible();
    if (tool && event.state === 'ACTIVE') openTool(key);
    // DONE without a known ACTIVE is progress but closes nothing.
    else if (tool && CLOSING_STATES.includes(event.state)) closeTool(key);
  }

  function result(event) {
    if (terminal) failure('duplicate-terminal');
    // A result from another conversation can never become this review's answer.
    if (conversation !== null && event.conversation !== conversation) {
      failure('result-envelope-invalid');
    }
    if (event.status !== SUCCESS_STATUS) failure('result-error');
    eligible();
    terminal = { status: SUCCESS_STATUS, response: event.response };
  }

  function line(buffer) {
    if (buffer.length && buffer.at(-1) === 13) buffer = buffer.subarray(0, -1);
    if (!buffer.length) return;
    if (++events > LIMITS.events) failure('output-limit');
    let value;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (!text.trim()) return;
      value = JSON.parse(text);
    } catch { return; }
    if (plainObject(value) && value.event === 'result' && terminal) failure('duplicate-terminal');
    const event = normalizeEvent(value);
    if (plainObject(value) && value.event === 'result' && !event) failure('result-envelope-invalid');
    if (!event) return;
    if (event.kind === 'result') return result(event);
    // Nothing after the terminal result is progress.
    if (terminal) return;
    if (event.kind === 'init') {
      if (conversation !== null) return;
      conversation = event.conversation;
      seen.add(sha256('init\0' + conversation));
      eligible();
      return;
    }
    step(event);
  }

  function responseText() {
    if (typeof terminal.response === 'string' && terminal.response.length > 0) {
      return { text: terminal.response, source: 'response' };
    }
    if (reconstructionOverflow) failure('output-limit');
    const text = chunks.join('');
    if (!text.trim()) failure('output-empty');
    return { text, source: 'chunks' };
  }

  return {
    push(chunk) {
      if (disposed) failure('result-envelope-invalid');
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout + buffer.length > LIMITS.stdout) failure('output-limit');
      stdout += buffer.length;
      let offset = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== 10) continue;
        const count = pending.length + i - offset;
        if (count > LIMITS.line) failure('output-limit');
        line(Buffer.concat([pending, buffer.subarray(offset, i)], count));
        pending = Buffer.alloc(0);
        offset = i + 1;
      }
      if (pending.length + buffer.length - offset > LIMITS.line) failure('output-limit');
      if (offset < buffer.length) pending = Buffer.concat([pending, buffer.subarray(offset)]);
    },
    stderr(chunk) {
      if (disposed) failure('result-envelope-invalid');
      const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (stderr + length > LIMITS.stderr) failure('output-limit');
      stderr += length;
    },
    end() {
      if (disposed) failure('result-envelope-invalid');
      if (pending.length) {
        const rest = pending;
        pending = Buffer.alloc(0);
        line(rest);
      }
      if (!terminal) failure(stdout === 0 ? 'output-empty' : 'result-envelope-invalid');
      return { status: terminal.status, ...responseText() };
    },
    dispose() {
      if (disposed) return;
      finalSnapshot = this.snapshot();
      disposed = true;
      pending = Buffer.alloc(0);
      chunks = [];
      seen.clear();
      open.clear();
      terminal = null;
    },
    snapshot() {
      if (disposed) return { ...finalSnapshot };
      const time = elapsed();
      return { version: 1, phase: terminal ? 'terminal' : remote ? 'remote-activity' : 'local-start',
        elapsed_ms: time, stdout_bytes: stdout, stderr_bytes: stderr, event_count: events,
        remote_event_count: remote, first_remote_ms: first, last_remote_ms: last,
        remote_silence_ms: last === null ? null : time - last, gap_suspended: suspended,
        tools_in_flight: open.size, suspension_epoch: epoch };
    },
  };
}

module.exports = { createReducer, normalizeEvent, LIMITS, TOOL_STEP_TYPES, CLOSING_STATES };
