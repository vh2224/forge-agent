'use strict';

// Trust boundary: the host callback and the OS-profile store are trusted.
// Requests/workers/imported files are data. This is not an OS sandbox against
// arbitrary code running as the same user. No CLI imports authorization.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveUserHome } = require('./forge-home');
const { digest } = require('./forge-code-roots');
const lock = require('./forge-lock');
const { writeAtomic } = require('./forge-yaml-safe');
const SECTION = 'user:forge-routing-continuity';
const SOURCES = Object.freeze({ codex: ['.codex', 'AGENTS.md'], claude: ['.claude', 'CLAUDE.md'] });
function fail(code) { throw Object.assign(new Error(code), { code }); }
function referenceKey(reference) {
  if (typeof reference !== 'string' || !/^[\w:./@-]{1,200}$/.test(reference)) fail('recovery-authorization-reference-invalid');
  return digest(reference);
}
function noLinks(file) {
  let current = path.resolve(file);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('recovery-authorization-path-link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return file;
}
function canonical(file) {
  noLinks(file);
  const actual = fs.realpathSync(file);
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
}
function sourceObservation(profile, host, section) {
  if (!SOURCES[host] || section !== SECTION) fail('recovery-authorization-source-not-allowed');
  const source = path.join(profile, ...SOURCES[host]);
  let text, actual;
  try { actual = canonical(source); text = fs.readFileSync(source, 'utf8'); }
  catch (error) {
    if (error.code === 'recovery-authorization-path-link') throw error;
    fail(error.code === 'ENOENT' ? 'recovery-authorization-source-missing' : 'recovery-authorization-source-unreadable');
  }
  const start = `<!-- ${section}:start -->`, end = `<!-- ${section}:end -->`;
  if (text.split(start).length !== 2 || text.split(end).length !== 2) fail('recovery-authorization-section-invalid');
  const first = text.indexOf(start), last = text.indexOf(end);
  if (last <= first) fail('recovery-authorization-section-invalid');
  return { source: actual, section, source_sha256: digest(text.slice(first, last + end.length)) };
}

// Dependencies are installed by trusted embedding/test code, never spread from
// a worker request. Production profile resolution ignores FORGE_HOME/accounts.
function createRecoveryAuthority(dependencies = {}) {
  const resolveProfile = dependencies.resolveProfile || resolveUserHome;
  const clock = dependencies.clock || Date.now;
  function location(reference) {
    const profile = canonical(resolveProfile());
    const root = path.join(profile, '.forge-personal', 'recovery-authority');
    const file = path.join(root, `${referenceKey(reference)}.json`);
    const key = path.join(root, 'authentication.key');
    for (const entry of [file, key, path.join(root, '.gsd', '.locks', 'authority')]) noLinks(entry);
    return { profile, root, file, key };
  }
  function signature(record, key) {
    return crypto.createHmac('sha256', key).update(JSON.stringify(record)).digest('hex');
  }
  function read(location, reference) {
    let envelope, key;
    try {
      envelope = JSON.parse(fs.readFileSync(location.file, 'utf8'));
      key = fs.readFileSync(location.key);
    } catch (error) {
      fail(error.code === 'ENOENT' ? 'recovery-authorization-missing' : error instanceof SyntaxError
        ? 'recovery-authorization-store-corrupt' : 'recovery-authorization-store-unreadable');
    }
    const row = envelope?.record;
    if (!row || row.schema_version !== 1 || row.reference !== reference || key.length !== 32
        || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature)
        || signature(row, key) !== envelope.signature) fail('recovery-authorization-store-invalid');
    if (row.profile !== location.profile) fail('recovery-authorization-profile-mismatch');
    return row;
  }
  function revalidate(reference) {
    const at = location(reference), record = read(at, reference);
    if (record.revoked_at !== null) fail('recovery-authorization-revoked');
    if (record.expires_at !== null && (!Number.isFinite(record.expires_at) || record.expires_at <= clock())) fail('recovery-authorization-expired');
    const source = sourceObservation(at.profile, record.source_host, record.section);
    if (source.source !== record.source || source.source_sha256 !== record.source_sha256) fail('recovery-authorization-source-changed');
    return record;
  }
  function mutate(reference, operation) {
    const at = location(reference);
    fs.mkdirSync(path.join(at.root, '.gsd'), { recursive: true, mode: 0o700 });
    const mutex = lock.acquireSync(at.root, 'authority', { allowStaleRecovery: false });
    try {
      location(reference); // Recheck all existing ancestors after acquisition.
      const result = operation(at);
      if (!lock.assertOwned(mutex)) fail('recovery-authorization-lock-lost');
      writeAtomic(at.file, JSON.stringify({ record: result, signature: signature(result, fs.readFileSync(at.key)) }), { cwd: at.root });
      return result;
    } finally {
      if (!lock.releaseHandle(mutex).ok) fail('recovery-authorization-lock-release-failed');
    }
  }
  return Object.freeze({
    registerStandingAuthorization(input) {
      if (typeof dependencies.attestAuthorization !== 'function') fail('recovery-host-attestation-required');
      const at = location(input?.reference);
      // A standing preference is permanent unless its attestation limits it.
      // Only the newly issued per-unit capability always has a bounded TTL.
      const expiresAt = input.expires_at ?? null;
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= clock())) fail('recovery-authorization-expired');
      if (!SOURCES[input.host]) fail('recovery-authorization-host-not-allowed');
      // A host may attest the canonical personal source of another host. The
      // fixed allowlist still supplies the path; requests cannot supply one.
      const sourceHost = input.source_host || input.host;
      const observation = { reference: input.reference, host: input.host, source_host: sourceHost, profile: at.profile,
        ...sourceObservation(at.profile, sourceHost, input.section), expires_at: expiresAt };
      // The callback must corroborate the exact reference/source/profile it
      // received through the host. Returning true/approved is insufficient.
      const answer = dependencies.attestAuthorization(Object.freeze({ ...observation }));
      if (!answer || answer.received !== true || answer.answer !== 'authorize' || !Number.isFinite(answer.resolved_at)
          || answer.resolved_at > clock() || Object.keys(observation).some(key => answer[key] !== observation[key])) {
        fail('recovery-host-attestation-invalid');
      }
      return mutate(input.reference, current => {
        const again = sourceObservation(current.profile, sourceHost, input.section);
        if (again.source_sha256 !== observation.source_sha256) fail('recovery-authorization-source-changed');
        if (fs.existsSync(current.file)) {
          const old = read(current, input.reference);
          if (old.revoked_at !== null) fail('recovery-authorization-revoked');
          if (Object.keys(observation).some(key => old[key] !== observation[key])) fail('recovery-authorization-registration-conflict');
          return old;
        }
        if (!fs.existsSync(current.key)) fs.writeFileSync(current.key, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
        return { schema_version: 1, ...observation, resolved_at: answer.resolved_at, registered_at: clock(), revoked_at: null };
      });
    },
    readStandingAuthorization: revalidate,
    revokeStandingAuthorization(reference) {
      return mutate(reference, at => ({ ...read(at, reference), revoked_at: clock() }));
    },
    issueRecoveryException(reference, scope) {
      const record = revalidate(reference);
      if (!scope || !scope.owner || !Array.isArray(scope.roots) || !scope.roots.length || !scope.request_identity_sha256
          || !scope.chain_sha256 || record.expires_at !== null && scope.expires_at > record.expires_at) fail('recovery-authorization-scope-invalid');
      const owner = canonical(scope.owner), roots = scope.roots.map(canonical);
      const recovery = require('./forge-attempt-recovery');
      const authority = recovery.createAuthority(ref => {
        const current = revalidate(ref);
        return { reference: ref, status: 'resolved', answer: 'authorize', resolved_at: new Date(current.resolved_at).toISOString() };
      });
      return authority.issue(reference, { ...scope, owner, roots, authorization_source_sha256: record.source_sha256,
        authorization_profile: record.profile }, clock);
    },
  });
}
module.exports = { createRecoveryAuthority };
