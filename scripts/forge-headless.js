#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const policy = require('./forge-dispatch-policy.js');

const PROTOCOL_VERSION = '1.0.0';
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS = 1000;
const MAX_OUTPUT_CHARS = 256 * 1024;

class HeadlessProtocolError extends Error {
  constructor(reason, message) { super(message); this.name = 'HeadlessProtocolError'; this.reason_code = reason; }
}

function boundedText(value, max = MAX_OUTPUT_CHARS) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= max ? text : text.slice(0, max);
}

function usageOf(value) {
  const input = value && typeof value === 'object' ? value : {};
  const number = (key, alt) => Number.isFinite(Number(input[key] ?? input[alt])) ? Math.max(0, Number(input[key] ?? input[alt])) : 0;
  return { input_tokens: number('input_tokens', 'input'), output_tokens: number('output_tokens', 'output'), cached_tokens: number('cached_tokens', 'cached') };
}

function textFromClaude(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  return content.filter((item) => item && item.type === 'text').map((item) => String(item.text || '')).join('');
}

class JsonlParser {
  constructor(options = {}) {
    if (!['claude', 'codex'].includes(options.runtime)) throw new HeadlessProtocolError('invalid-runtime-contract', 'runtime must be claude or codex');
    if (!options.dispatchId) throw new HeadlessProtocolError('invalid-dispatch', 'dispatchId is required');
    this.runtime = options.runtime;
    this.dispatchId = String(options.dispatchId);
    this.buffer = '';
    this.started = false;
    this.terminal = null;
    this.sequence = 0;
    this.events = [];
    this.output = '';
    this.usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
    this.resume = null;
    this.seen = new Set();
    this.redactions = Array.isArray(options.redactValues) ? options.redactValues.filter((value) => typeof value === 'string' && value.length >= 3) : [];
  }

  push(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES && !this.buffer.includes('\n')) throw new HeadlessProtocolError('output-invalid', 'JSONL line exceeds limit');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.parseLine(line);
    }
  }

  parseLine(line) {
    if (this.events.length >= MAX_EVENTS) throw new HeadlessProtocolError('output-invalid', 'event limit exceeded');
    let raw;
    try { raw = JSON.parse(line); } catch (_) { throw new HeadlessProtocolError('output-invalid', 'malformed JSONL'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HeadlessProtocolError('output-invalid', 'JSONL event must be an object');
    if (raw.protocol_version && raw.protocol_version !== PROTOCOL_VERSION) throw new HeadlessProtocolError('output-invalid', 'protocol version mismatch');
    if (raw.dispatch_id && String(raw.dispatch_id) !== this.dispatchId) throw new HeadlessProtocolError('output-invalid', 'dispatch mismatch');
    const identity = raw.event_id || raw.id;
    if (identity && this.seen.has(String(identity))) return;
    if (identity) this.seen.add(String(identity));
    const event = this.runtime === 'codex' ? this.adaptCodex(raw) : this.adaptClaude(raw);
    if (!event) return;
    if (this.terminal) throw new HeadlessProtocolError('output-invalid', 'event after terminal');
    if (event.kind === 'start') {
      if (this.started) throw new HeadlessProtocolError('output-invalid', 'duplicate start');
      this.started = true;
      if (event.resume) this.resume = boundedText(event.resume, 512);
    } else if (!this.started) {
      throw new HeadlessProtocolError('output-invalid', 'event before start');
    }
    if (event.kind === 'output') {
      let text = event.text;
      for (const secret of this.redactions) text = text.split(secret).join('[REDACTED]');
      this.output = boundedText(this.output + text);
    }
    if (event.usage) {
      const next = usageOf(event.usage);
      if (event.usage_delta) for (const key of Object.keys(this.usage)) this.usage[key] += next[key];
      else for (const key of Object.keys(this.usage)) this.usage[key] = Math.max(this.usage[key], next[key]);
    }
    this.events.push({ sequence: ++this.sequence, type: event.kind, usage: event.usage ? { ...this.usage } : undefined });
    if (event.kind === 'terminal') this.terminal = this.result(event.status, event.reason_code);
  }

  adaptCodex(raw) {
    if (raw.type === 'thread.started' || raw.type === 'turn.started' || raw.type === 'start') return { kind: 'start', resume: raw.thread_id || raw.resume };
    if (raw.type === 'item.completed' && raw.item && raw.item.type === 'agent_message') return { kind: 'output', text: boundedText(raw.item.text), usage: raw.usage, usage_delta: raw.usage_delta === true };
    if (raw.type === 'usage') return { kind: 'usage', usage: raw.usage || raw, usage_delta: raw.delta === true };
    if (raw.type === 'turn.completed' || raw.type === 'result') return { kind: 'terminal', status: 'succeeded', reason_code: '', usage: raw.usage };
    if (raw.type === 'needs_input') return { kind: 'terminal', status: 'failed', reason_code: 'needs-input', usage: raw.usage };
    if (raw.type === 'turn.failed' || raw.type === 'error') return { kind: 'terminal', status: 'failed', reason_code: 'codex-exit-nonzero', usage: raw.usage };
    return null;
  }

  adaptClaude(raw) {
    if ((raw.type === 'system' && raw.subtype === 'init') || raw.type === 'start') return { kind: 'start', resume: raw.session_id || raw.resume };
    if (raw.type === 'assistant') return { kind: 'output', text: textFromClaude(raw.message), usage: raw.message && raw.message.usage, usage_delta: raw.usage_delta === true };
    if (raw.type === 'usage') return { kind: 'usage', usage: raw.usage || raw, usage_delta: raw.delta === true };
    if (raw.type === 'result') return { kind: 'terminal', status: raw.is_error ? 'failed' : 'succeeded', reason_code: raw.is_error ? 'claude-exit-nonzero' : '', usage: raw.usage };
    if (raw.type === 'needs_input') return { kind: 'terminal', status: 'failed', reason_code: 'needs-input', usage: raw.usage };
    if (raw.type === 'error') return { kind: 'terminal', status: 'failed', reason_code: 'claude-exit-nonzero', usage: raw.usage };
    return null;
  }

  result(status, reasonCode) {
    return { protocol_version: PROTOCOL_VERSION, dispatch_id: this.dispatchId, runtime: this.runtime, status, reason_code: reasonCode || '', output: this.output, usage: { ...this.usage }, resume: this.resume, events: this.events.slice() };
  }

  finish(exitCode = 0) {
    if (this.buffer.trim()) throw new HeadlessProtocolError('output-invalid', 'truncated JSONL');
    if (this.terminal) return this.terminal;
    if (exitCode !== 0) return this.result('failed', `${this.runtime}-exit-nonzero`);
    return this.result('failed', `${this.runtime}-orphan`);
  }
}

function safeEnvironment(env = process.env) {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
  return Object.fromEntries(allowed.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]));
}

function authorize(options) {
  return policy.decide({
    role: options.role || 'worker', operation: 'spawn', host_runtime: options.runtime,
    worker_engine: 'native', worker_mode: 'native', required_capabilities: ['process.spawn'],
    available_capabilities: ['process.spawn'], sandbox_mode: options.sandbox,
    workspace_root: options.workspaceRoot, spawn_cwd: options.cwd,
    untrusted_output: null,
  });
}

function buildInvocation(options = {}) {
  if (!['claude', 'codex'].includes(options.runtime)) throw new HeadlessProtocolError('invalid-runtime-contract', 'runtime must be explicit');
  if (!['read-only', 'workspace-write'].includes(options.sandbox)) throw new HeadlessProtocolError('sandbox-escalation-denied', 'sandbox must be explicit');
  if (!['never', 'on-request'].includes(options.approval)) throw new HeadlessProtocolError('role-permission-denied', 'approval must be explicit');
  const binary = typeof options.binary === 'string' ? { command: options.binary, args: [] } : (options.binary || {});
  if (!binary.command || !path.isAbsolute(binary.command)) throw new HeadlessProtocolError('invalid-request', 'resolved executable must be absolute');
  const decision = authorize(options);
  if (decision.decision !== 'allow') throw new HeadlessProtocolError(decision.reason_code, `dispatch denied: ${decision.reason_code}`);
  const prefix = Array.isArray(binary.args) ? binary.args.map(String) : [];
  const args = options.runtime === 'codex'
    ? prefix.concat(['exec', '--json', '--sandbox', options.sandbox, '--ask-for-approval', options.approval, '-'])
    : prefix.concat(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-mode', options.sandbox === 'read-only' ? 'plan' : 'acceptEdits']);
  return { command: binary.command, args, cwd: path.resolve(options.cwd), shell: false, env: safeEnvironment(options.env), policy: decision };
}

function run(options = {}, dependencies = {}) {
  const invocation = buildInvocation(options);
  const parser = new JsonlParser({ runtime: options.runtime, dispatchId: options.dispatchId, redactValues: options.redactValues });
  const spawnFn = dependencies.spawn || spawn;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30 * 60 * 1000;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child;
    let timer = null;
    let stdinError = null, childClose = null;
    const inputCodes = new Set(['EPIPE', 'ECONNRESET', 'EBADF', 'EIO', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
    const inputError = (error) => {
      if (!stdinError) stdinError = { stage: 'stdin-write', code: inputCodes.has(error && error.code) ? error.code : 'other' };
    };
    const complete = (result) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer);
      resolve(stdinError ? { ...result, stdin_error: { ...stdinError, child_close: childClose } } : result);
    };
    try { child = spawnFn(invocation.command, invocation.args, { cwd: invocation.cwd, shell: false, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (_) { complete(parser.result('failed', `${options.runtime}-exit-nonzero`)); return; }
    // This stream is owned by this invocation. Keep its listener after settlement:
    // a late pipe error cannot escape or retroactively mutate the returned result.
    child.stdin.on('error', inputError);
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
      complete(parser.result('failed', `${options.runtime}-timeout`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      try { parser.push(chunk); } catch (_) { try { child.kill(); } catch (_) {}; complete(parser.result('failed', 'output-invalid')); }
    });
    child.on('error', () => complete(parser.result('failed', `${options.runtime}-exit-nonzero`)));
    child.on('close', (code, signal) => {
      childClose = { exit_code: Number.isSafeInteger(code) ? code : null,
        signal: signal == null ? null : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGPIPE', 'SIGHUP', 'SIGBREAK'].includes(signal) ? signal : 'other' };
      if (timedOut || settled) return;
      try { complete(parser.finish(code)); } catch (_) { complete(parser.result('failed', 'output-invalid')); }
    });
    const prompt = String(options.prompt || '');
    try {
    child.stdin.end(options.runtime === 'claude' ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n` : prompt);
    } catch (error) {
      // Preserve rejection for unrelated programmer errors; stream failures wait
      // for the existing close/parser or timeout path, never a retry or new kill.
      if (!inputCodes.has(error && error.code)) throw error;
      inputError(error);
    }
  });
}

module.exports = { PROTOCOL_VERSION, MAX_LINE_BYTES, MAX_EVENTS, MAX_OUTPUT_CHARS, HeadlessProtocolError, JsonlParser, usageOf, safeEnvironment, authorize, buildInvocation, run };
