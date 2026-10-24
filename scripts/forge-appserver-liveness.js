'use strict';

// Pure reducer: Codex app-server JSON-RPC notifications -> the liveness snapshot
// that forge-sidecar-liveness.evaluate consumes (same field names as the Claude
// reducer). No I/O, no timers. Provider text never leaves this module; only the
// canonical SHA-256 fingerprint of a closed set of item fields does.

const { toolFingerprint } = require('./forge-claude-stream');

const TOOL_ITEM_TYPES = Object.freeze(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'collabAgentToolCall', 'webSearch', 'imageView', 'sleep', 'imageGeneration']);
const LOCAL_LIFECYCLE_METHODS = Object.freeze(['thread/started', 'turn/started', 'thread/status/changed',
  'mcpServer/startupStatus/updated']);
// Notifications the local app-server emits without the provider having answered.
const LOCAL_LIFECYCLE = Object.freeze({ methods: LOCAL_LIFECYCLE_METHODS, itemTypes: Object.freeze(['userMessage']) });
const DEFAULT_MAX_OPEN_ITEMS = 256;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

function itemFields(item) {
  switch (item.type) {
    case 'commandExecution': return { command: item.command, cwd: item.cwd };
    case 'fileChange': return { changes: (Array.isArray(item.changes) ? item.changes : [])
      .map(change => (isObject(change) ? { path: change.path, kind: change.kind } : null)) };
    case 'mcpToolCall': return { server: item.server, tool: item.tool, arguments: item.arguments };
    case 'dynamicToolCall': return { namespace: item.namespace, tool: item.tool, arguments: item.arguments };
    case 'collabAgentToolCall': return { tool: item.tool, prompt: item.prompt };
    case 'webSearch': return { query: item.query };
    case 'imageView': return { path: item.path };
    case 'sleep': return { durationMs: item.durationMs };
    case 'imageGeneration': return {};
    default: return null;
  }
}

function itemFingerprint(item) {
  try {
    if (!isObject(item) || !TOOL_ITEM_TYPES.includes(item.type)) return null;
    return toolFingerprint('appserver:' + item.type, itemFields(item)) || null;
  } catch { return null; }
}

function createNotificationReducer(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : () => performance.now();
  const onToolCall = typeof options.onToolCall === 'function' ? options.onToolCall : null;
  const limit = Number.isInteger(options.maxOpenItems) && options.maxOpenItems > 0 ? options.maxOpenItems : DEFAULT_MAX_OPEN_ITEMS;
  const started = clock();
  let highWater = started;
  const elapsed = () => {
    highWater = Math.max(highWater, clock());
    return highWater - started;
  };
  const open = new Map();
  const reported = new Set();
  let sent = false;
  let terminal = false;
  let events = 0;
  let remote = 0;
  let first = null;
  let last = null;

  // Bounded insertion: the oldest entry is evicted so the set never grows past `limit`.
  const bound = (collection, add) => {
    if (collection.size >= limit) collection.delete(collection.keys().next().value);
    add();
  };

  function isLocal(method, item) {
    if (LOCAL_LIFECYCLE.methods.includes(method)) return true;
    return (method === 'item/started' || method === 'item/completed')
      && isObject(item) && LOCAL_LIFECYCLE.itemTypes.includes(item.type);
  }

  function track(method, item) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id) return;
    if (method === 'item/completed') { open.delete(item.id); return; }
    if (method !== 'item/started' || !TOOL_ITEM_TYPES.includes(item.type)) return;
    bound(open, () => open.set(item.id, item.type));
    if (reported.has(item.id)) return;
    bound(reported, () => reported.add(item.id));
    if (!onToolCall) return;
    const fingerprint = itemFingerprint(item);
    if (fingerprint) onToolCall({ fingerprint });
  }

  return {
    turnSent() {
      sent = true;
    },
    push(message) {
      try {
        if (!isObject(message) || message.id !== undefined || typeof message.method !== 'string') return;
        const time = elapsed();
        const item = isObject(message.params) ? message.params.item : undefined;
        events++;
        if (message.method === 'turn/completed') terminal = true;
        if (sent && !isLocal(message.method, item)) {
          remote++;
          if (first === null) first = time;
          last = time;
        }
        track(message.method, item);
      } catch { /* a malformed notification must never abort the stream */ }
    },
    snapshot() {
      const time = elapsed();
      return { version: 1, phase: terminal ? 'terminal' : remote ? 'remote-activity' : 'local-start', elapsed_ms: time,
        event_count: events, remote_event_count: remote, first_remote_ms: first, last_remote_ms: last,
        remote_silence_ms: last === null ? null : time - last, gap_suspended: open.size > 0, tools_in_flight: open.size };
    },
  };
}

module.exports = { createNotificationReducer, itemFingerprint, TOOL_ITEM_TYPES, LOCAL_LIFECYCLE, LOCAL_LIFECYCLE_METHODS };
