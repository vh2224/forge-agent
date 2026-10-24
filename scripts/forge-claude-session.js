#!/usr/bin/env node
'use strict';

/**
 * forge-claude-session.js — pure helpers for a persisted Claude CLI session.
 *
 * Measured on 2026-10-23 (Windows host, Claude Code 2.1.310), with a throwaway
 * temp cwd, the cheapest model and a trivial prompt (artifacts removed after):
 *
 *   - `claude -p --session-id <U>` writes `<home>/.claude/projects/<key>/<U>.jsonl`;
 *     `system/init` (and every later stream event) carries `session_id === <U>`.
 *   - <key> is the absolute cwd with every non-alphanumeric character replaced by
 *     '-'. The CLI keys on the long (real) path: a cwd given as an 8.3 short path
 *     (`LUIS~1.FER`) was recorded under the long name, so a computed key may
 *     diverge — removeSession() falls back to a one-level scan of projects/*.
 *   - `claude -p --resume <U>` in the same cwd keeps the same session_id, appends
 *     to the same .jsonl (18 -> 42 lines) and honours --json-schema.
 *   - The resume also created the directory `<home>/.claude/session-env/<U>/`;
 *     long interactive sessions also use `projects/<key>/<U>/` and
 *     `file-history/<U>/`. The global history.jsonl does not receive -p prompts.
 *   - CLAUDE_CONFIG_DIR is outside the sidecar child env allowlist, so the child
 *     always uses `<home of the child env>/.claude` (USERPROFILE on win32, HOME
 *     elsewhere) — exactly what configDir() resolves.
 *
 * The closed cleanup set is therefore: projects/<key>/<U>.jsonl,
 * projects/<key>/<U>/, session-env/<U>/ and file-history/<U>/. Nothing else is
 * ever removed; symlinks/junctions and anything resolving outside the config
 * dir are refused, never followed.
 */

const crypto = require('crypto');
const nodeFs = require('fs');
const path = require('path');
const { resolveUserHome } = require('./forge-home');

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_PHASES = Object.freeze(['plan', 'execute']);
const SESSION_REF_VERSION = 1;
const SESSION_REF_KEYS = Object.freeze(['version', 'id', 'account_name', 'config_dir', 'cwd', 'created_at']);
const INVALID_ID = 'claude-session-invalid';
const INVALID_REF = 'claude-session-ref-invalid';

function codedError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function isSessionId(id) {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

function assertSessionId(id) {
  if (!isSessionId(id)) throw codedError(INVALID_ID);
  return id;
}

function newSessionId() {
  return assertSessionId(crypto.randomUUID());
}

function isEligible(options) {
  const phase = options && options.phase;
  return typeof phase === 'string' && SESSION_PHASES.includes(phase);
}

/** Claude config dir the sidecar child uses: <home of the child env>/.claude. */
function configDir(env, platform) {
  return path.join(resolveUserHome({ env: env || {}, platform: platform || process.platform }), '.claude');
}

function projectKey(cwd) {
  if (typeof cwd !== 'string' || !cwd) throw codedError(INVALID_REF, 'cwd must be a non-empty string');
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function sessionTargets({ configDir: base, cwd, id } = {}) {
  assertSessionId(id);
  if (typeof base !== 'string' || !path.isAbsolute(base)) throw codedError(INVALID_REF, 'configDir must be absolute');
  const project = path.join(base, 'projects', projectKey(cwd));
  return [
    { kind: 'file', path: path.join(project, `${id}.jsonl`) },
    { kind: 'dir', path: path.join(project, id) },
    { kind: 'dir', path: path.join(base, 'session-env', id) },
    { kind: 'dir', path: path.join(base, 'file-history', id) },
  ];
}

function sessionDigest(id) {
  assertSessionId(id);
  return crypto.createHash('sha256').update(id, 'utf8').digest('hex');
}

function createSessionRef({ id, accountName, configDir: base, cwd, now } = {}) {
  const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  const ref = Object.freeze({
    version: SESSION_REF_VERSION,
    id,
    account_name: accountName === undefined ? null : accountName,
    config_dir: base,
    cwd,
    created_at: at.toISOString(),
  });
  const verdict = validateSessionRef(ref);
  if (!verdict.ok) throw codedError(INVALID_REF, verdict.reason);
  return ref;
}

function validateSessionRef(ref) {
  const fail = (reason) => ({ ok: false, reason });
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return fail('not-object');
  const keys = Object.keys(ref).sort();
  const expected = SESSION_REF_KEYS.slice().sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return fail('keys');
  if (ref.version !== SESSION_REF_VERSION) return fail('version');
  if (!isSessionId(ref.id)) return fail('id');
  if (ref.account_name !== null && (typeof ref.account_name !== 'string' || !ref.account_name)) return fail('account_name');
  if (typeof ref.config_dir !== 'string' || !path.isAbsolute(ref.config_dir)) return fail('config_dir');
  if (typeof ref.cwd !== 'string' || !path.isAbsolute(ref.cwd)) return fail('cwd');
  if (typeof ref.created_at !== 'string' || Number.isNaN(Date.parse(ref.created_at))) return fail('created_at');
  return { ok: true };
}

function isInside(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function errorCode(error) {
  return (error && error.code) || 'EUNKNOWN';
}

/**
 * Remove the closed set of session targets. Refuses (never removes) any target
 * that is a symlink/junction or whose parent component below configDir is one,
 * even when the destination stays inside configDir; never leaves
 * realpath(configDir), never reads content. Returned paths are relative to the
 * config dir.
 */
function removeSession(ref, { fs = nodeFs } = {}) {
  const verdict = validateSessionRef(ref);
  if (!verdict.ok) throw codedError(INVALID_REF, verdict.reason);
  const result = { ok: true, removed: [], refused: [], errors: [] };
  let realBase;
  try {
    realBase = fs.realpathSync(ref.config_dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return result;
    result.errors.push({ path: '.', code: errorCode(error) });
    result.ok = false;
    return result;
  }
  const relative = (target) => path.relative(ref.config_dir, target) || '.';

  // Returns 'link' when a parent component below config_dir is a symlink/junction,
  // 'error' when it cannot be inspected, otherwise null (including absent parents).
  function parentProblem(targetPath, rel) {
    const parts = path.relative(ref.config_dir, path.dirname(targetPath)).split(path.sep).filter(Boolean);
    let current = ref.config_dir;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return 'link';
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        result.errors.push({ path: rel, code: errorCode(error) });
        return 'error';
      }
    }
    return null;
  }

  // Returns true when the target existed (whatever the outcome), false on ENOENT.
  function removeTarget(target) {
    const rel = relative(target.path);
    const problem = parentProblem(target.path, rel);
    if (problem === 'link') {
      result.refused.push({ path: rel, reason: 'parent-symlink' });
      return true;
    }
    if (problem === 'error') return true;
    let stat;
    try {
      stat = fs.lstatSync(target.path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      result.errors.push({ path: rel, code: errorCode(error) });
      return true;
    }
    if (stat.isSymbolicLink()) {
      result.refused.push({ path: rel, reason: 'symlink' });
      return true;
    }
    let real;
    try {
      real = fs.realpathSync(target.path);
    } catch (error) {
      result.errors.push({ path: rel, code: errorCode(error) });
      return true;
    }
    if (!isInside(realBase, real) || real === realBase) {
      result.refused.push({ path: rel, reason: 'outside-config-dir' });
      return true;
    }
    const isDir = stat.isDirectory();
    if ((target.kind === 'dir') !== isDir || (target.kind === 'file' && !stat.isFile())) {
      result.refused.push({ path: rel, reason: 'type-mismatch' });
      return true;
    }
    try {
      if (isDir) fs.rmSync(target.path, { recursive: true, force: false });
      else fs.rmSync(target.path, { force: false });
      result.removed.push(rel);
    } catch (error) {
      result.errors.push({ path: rel, code: errorCode(error) });
    }
    return true;
  }

  const targets = sessionTargets({ configDir: ref.config_dir, cwd: ref.cwd, id: ref.id });
  const transcriptFound = removeTarget(targets[0]);
  for (const target of targets.slice(1)) removeTarget(target);

  if (!transcriptFound) {
    // One-level fallback: the CLI may key the cwd differently (e.g. 8.3 short
    // paths on Windows). Only real directories directly under projects/.
    const projects = path.join(ref.config_dir, 'projects');
    const computed = path.dirname(targets[0].path);
    let entries = [];
    try {
      if (parentProblem(path.join(projects, 'x'), relative(projects)) === null) {
        entries = fs.readdirSync(projects, { withFileTypes: true });
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') result.errors.push({ path: relative(projects), code: errorCode(error) });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(projects, entry.name);
      if (dir === computed) continue;
      removeTarget({ kind: 'file', path: path.join(dir, `${ref.id}.jsonl`) });
      removeTarget({ kind: 'dir', path: path.join(dir, ref.id) });
    }
  }

  result.ok = result.refused.length === 0 && result.errors.length === 0;
  return result;
}

module.exports = {
  SESSION_ID_PATTERN,
  SESSION_PHASES,
  SESSION_REF_KEYS,
  newSessionId,
  isSessionId,
  assertSessionId,
  isEligible,
  configDir,
  projectKey,
  sessionTargets,
  createSessionRef,
  validateSessionRef,
  removeSession,
  sessionDigest,
};

if (require.main === module) {
  process.stdout.write(`${newSessionId()}\n`);
}
