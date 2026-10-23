'use strict';

const { TextDecoder } = require('util');
const crypto = require('crypto');
const LIMITS = Object.freeze({ line: 1048576, stdout: 16777216, stderr: 1048576, events: 100000,
  depth: 128, nodes: 100000, blocks: 32, reconstruction: 1048576 });

function failure(reason) {
  throw Object.assign(new Error('Claude stream refused.'), { reason });
}

// Only traverse JSON values: the public helper first serializes/parses its input.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function toolFingerprint(name, input) {
  if (typeof name !== 'string' || !name.trim() || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    const text = JSON.stringify(input);
    if (!text || Buffer.byteLength(text) > LIMITS.reconstruction) return null;
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    inspect(text, value, '');
    delete value.description;
    return crypto.createHash('sha256').update(name + '\0' + canonical(value)).digest('hex');
  } catch { return null; }
}

// JSON.parse alone silently accepts duplicate (including escaped) property names.
function inspect(text, value, secret) {
  const containers = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      containers.push(c === '{' ? new Set() : null);
      if (containers.length > LIMITS.depth) failure('output-limit');
    } else if (c === '}' || c === ']') containers.pop();
    else if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      let next = end + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':' && containers.at(-1)) {
        const key = JSON.parse(text.slice(i, end + 1));
        if (containers.at(-1).has(key)) failure('json-invalid');
        containers.at(-1).add(key);
      }
      i = end;
    }
  }
  const pending = [[value, 0]];
  let nodes = 0;
  while (pending.length) {
    const [entry, depth] = pending.pop();
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) failure('output-limit');
    if (typeof entry === 'string') {
      if (secret && entry.includes(secret)) failure('secret-output');
    } else if (entry && typeof entry === 'object') {
      const keys = Object.keys(entry);
      if (nodes + pending.length + keys.length > LIMITS.nodes) failure('output-limit');
      for (const key of keys) {
        if (secret && key.includes(secret)) failure('secret-output');
        pending.push([entry[key], depth + 1]);
      }
    }
  }
}

function createReducer(options = {}) {
  const clock = options.clock || (() => performance.now());
  const started = clock();
  let highWater = started;
  const elapsed = () => {
    highWater = Math.max(highWater, clock());
    return Math.max(0, Math.floor(highWater - started));
  };
  let pending = Buffer.alloc(0), terminal = null, message = null;
  const blocks = new Map(), seenMessages = new Set();
  const seenTools = new Set(), reportedTools = new Set(), toolsInFlight = new Set();
  let reconstruction = 0, suspended = false, toolMessage = false;
  let first = null, last = null, maxGap = null, remote = 0, events = 0, stdout = 0, stderr = 0;
  const usage = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null };
  let denials = { read: null, write: null, shell: null, other: null };
  let secret = options.secret || '';
  let onRemote = options.onRemote, onEvent = options.onEvent, onToolCall = options.onToolCall;
  options = null;
  let disposed = false, finalSnapshot = null;
  const secretBytes = Buffer.from(secret), rawTails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };

  function raw(buffer, stream) {
    if (!secretBytes.length) return;
    const text = Buffer.concat([rawTails[stream], buffer]);
    if (text.includes(secretBytes)) failure('secret-output');
    rawTails[stream] = Buffer.from(text.subarray(Math.max(0, text.length - secretBytes.length + 1)));
  }

  function eligible(resume = false) {
    const time = elapsed();
    if (first === null) first = time;
    if (last !== null && !suspended) maxGap = Math.max(maxGap ?? 0, time - last);
    last = time;
    if (resume) suspended = false;
    remote++;
    onRemote?.();
  }

  function consumeUsage(value) {
    if (!value || typeof value !== 'object') return;
    const names = { input_tokens: 'input_tokens', output_tokens: 'output_tokens',
      cache_read_tokens: 'cache_read_input_tokens', cache_write_tokens: 'cache_creation_input_tokens' };
    for (const [out, key] of Object.entries(names)) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) usage[out] = value[key];
    }
  }

  function inspectTool(block, final = false) {
    if (!block.text) return;
    try {
      const nested = JSON.parse(block.text);
      inspect(block.text, nested, secret);
    } catch (error) {
      if (error.reason) throw error;
      // Incomplete/invalid tool JSON is never fingerprinted, even at closure.
      if (final) return;
    }
  }

  function validToolId(id) {
    return typeof id === 'string' && id.trim().length > 0 && Buffer.byteLength(id) <= 256;
  }

  function trackTool(id) {
    if (!validToolId(id)) return false;
    if (!seenTools.has(id)) {
      if (seenTools.size >= LIMITS.events || toolsInFlight.size >= LIMITS.blocks) failure('output-limit');
      seenTools.add(id);
      toolsInFlight.add(id);
    }
    return true;
  }

  function reportTool(id, name, input) {
    if (!trackTool(id) || reportedTools.has(id)) return;
    const fingerprint = toolFingerprint(name, input);
    if (!fingerprint) return;
    reportedTools.add(id);
    try { onToolCall?.({ fingerprint }); } catch { /* Observers cannot fail the stream. */ }
  }

  function closeTool(block) {
    inspectTool(block, true);
    let input;
    try { input = JSON.parse(block.text); } catch { return; }
    reportTool(block.id, block.name, input);
  }

  function startMessage(value) {
    if (value?.role !== 'assistant' || typeof value.id !== 'string' || !value.id) return;
    if (!seenMessages.has(value.id)) {
      seenMessages.add(value.id);
      message = value.id;
      blocks.clear();
      reconstruction = 0;
      toolMessage = false;
      eligible(true);
    }
    if (Array.isArray(value.content) && value.content.some(block => block?.type === 'tool_use')) {
      toolMessage = true;
      suspended = true;
    }
  }

  function event(value, text) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) failure('result-envelope-invalid');
    inspect(text, value, secret);
    if (terminal) failure(value.type === 'result' ? 'duplicate-terminal' : 'event-after-terminal');
    if (++events > LIMITS.events) failure('output-limit');
    if (value.type === 'error' || value.type === 'result'
        && (value.is_error === true || value.subtype && value.subtype !== 'success')) {
      failure([401, 403].includes(value.api_error_status) ? 'authentication-failed' : 'result-error');
    }
    const e = value.type === 'stream_event' ? value.event : value;
    const owned = message && (!e?.message_id || e.message_id === message);
    if (e?.type === 'message_start') startMessage(e.message);
    else if (value.type === 'assistant') {
      startMessage(value.message);
      if (value.message?.role === 'assistant' && Array.isArray(value.message.content)) {
        for (const block of value.message.content) {
          if (block?.type === 'tool_use') reportTool(block.id, block.name, block.input);
        }
      }
    } else if (e?.type === 'content_block_start' && owned && Number.isSafeInteger(e.index) && e.index >= 0) {
      if (blocks.has(e.index) || blocks.size >= LIMITS.blocks) failure('output-limit');
      const tool = e.content_block?.type === 'tool_use';
      blocks.set(e.index, { text: '', tool, id: e.content_block?.id, name: e.content_block?.name });
      if (tool) trackTool(e.content_block.id);
      if (tool) { suspended = true; toolMessage = true; }
    } else if (e?.type === 'content_block_delta' && owned && blocks.has(e.index)) {
      const block = blocks.get(e.index), delta = e.delta;
      const piece = delta?.text ?? delta?.partial_json ?? delta?.thinking ?? delta?.signature;
      if (typeof piece === 'string') {
        const bytes = Buffer.byteLength(piece);
        if (reconstruction + bytes > LIMITS.reconstruction) failure('output-limit');
        reconstruction += bytes;
        block.text += piece;
        if (secret && block.text.includes(secret)) failure('secret-output');
        if (block.tool) inspectTool(block);
        else if (['text_delta', 'thinking_delta', 'signature_delta'].includes(delta.type)) eligible(!toolMessage);
      }
    } else if (e?.type === 'content_block_stop' && owned && blocks.has(e.index)) {
      const block = blocks.get(e.index);
      if (block.tool) closeTool(block);
      reconstruction -= Buffer.byteLength(block.text);
      blocks.delete(e.index);
    } else if (e?.type === 'message_delta' && owned) {
      eligible(!toolMessage);
    } else if (e?.type === 'message_stop' && owned) {
      for (const block of blocks.values()) if (block.tool) closeTool(block);
      message = null;
      blocks.clear();
      reconstruction = 0;
    }
    // Documented assumption, not a CLI capture: Agent SDK streaming output and
    // Python SDK UserMessage/ToolResultBlock (https://platform.claude.com/docs/en/agent-sdk/streaming-output,
    // https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py).
    // Unrecognized shapes retain the S01 fallback at the next eligible remote event.
    if (value.type === 'user' && value.parent_tool_use_id == null && Array.isArray(value.message?.content)) {
      let removed = false;
      for (const block of value.message.content) {
        if (block?.type === 'tool_result' && validToolId(block.tool_use_id)) {
          removed = toolsInFlight.delete(block.tool_use_id) || removed;
        }
      }
      if (removed && toolsInFlight.size === 0 && suspended) {
        suspended = false;
        last = elapsed();
      }
    }
    if (value.type === 'result') {
      if (value.subtype !== 'success' || value.is_error !== false || !Object.hasOwn(value, 'structured_output')) {
        failure('result-envelope-invalid');
      }
      terminal = value;
      consumeUsage(value.usage);
      if (Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0) usage.cost_usd = value.total_cost_usd;
      if (Array.isArray(value.permission_denials)) {
        denials = { read: 0, write: 0, shell: 0, other: 0 };
        for (const denial of value.permission_denials) {
          const name = denial?.tool_name;
          denials[/^(Read|Glob|Grep)$/.test(name) ? 'read' : /^(Edit|Write)$/.test(name) ? 'write' : name === 'Bash' ? 'shell' : 'other']++;
        }
      }
    }
    onEvent?.();
  }

  function line(buffer) {
    if (buffer.length && buffer.at(-1) === 13) buffer = buffer.subarray(0, -1);
    if (!buffer.length) return;
    let text, value;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (!text.trim()) return;
      value = JSON.parse(text);
    } catch { failure('json-invalid'); }
    event(value, text);
  }

  return {
    push(chunk) {
      if (disposed) failure('result-envelope-invalid');
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout + buffer.length > LIMITS.stdout) failure('output-limit');
      stdout += buffer.length;
      raw(buffer, 'stdout');
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
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderr + buffer.length > LIMITS.stderr) failure('output-limit');
      stderr += buffer.length;
      raw(buffer, 'stderr');
    },
    end() {
      if (disposed) failure('result-envelope-invalid');
      if (pending.length) line(pending);
      pending = Buffer.alloc(0);
      if (!terminal) failure(events ? 'result-envelope-invalid' : 'output-empty');
      return terminal;
    },
    dispose() {
      if (disposed) return;
      finalSnapshot = this.snapshot();
      disposed = true;
      pending.fill(0);
      pending = Buffer.alloc(0);
      for (const key of Object.keys(rawTails)) {
        rawTails[key].fill(0);
        rawTails[key] = Buffer.alloc(0);
      }
      secretBytes.fill(0);
      secret = '';
      for (const block of blocks.values()) block.text = '';
      blocks.clear();
      seenMessages.clear();
      seenTools.clear();
      reportedTools.clear();
      toolsInFlight.clear();
      terminal = message = onRemote = onEvent = onToolCall = null;
      reconstruction = 0;
    },
    snapshot() {
      if (disposed) return { ...finalSnapshot, denials: { ...finalSnapshot.denials } };
      const time = elapsed();
      return { version: 1, phase: terminal ? 'terminal' : remote ? 'remote-activity' : 'local-start', elapsed_ms: time,
        transport_ms: time, verification_ms: null, stdout_bytes: stdout, stderr_bytes: stderr,
        event_count: events, remote_event_count: remote, first_remote_ms: first, last_remote_ms: last,
        initial_sample_ms: first, gap_sample_ms: remote >= 2 ? maxGap : null,
        remote_silence_ms: last === null ? null : time - last, gap_suspended: suspended, tools_in_flight: toolsInFlight.size,
        ...usage, denials: { ...denials }, process_exit_observed: false };
    },
  };
}

module.exports = { createReducer, toolFingerprint, LIMITS };
