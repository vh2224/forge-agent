#!/usr/bin/env node
// forge-secrets — credential vault for external CLIs (railway, vercel, fly, ...).
//
// WHY THIS EXISTS
// ---------------
// Forge already stores Claude account tokens in the Keychain (forge-accounts),
// but every other credential had no home. MCPs with secrets fall back to a
// `.env` file, which is plaintext on disk, easy to commit by accident, and
// readable by anything the user runs. A token pasted into a shell command also
// lands in shell history.
//
// This generalises the forge-accounts pattern:
//   - the non-secret registry (service, name, env var, notes) is a JSON file
//   - the secret itself lives in the macOS Keychain, never in the registry
//   - commands run through `--exec`, which puts the secret in the CHILD's
//     environment and nowhere else
//
// DELIBERATELY NO `--print`
// -------------------------
// forge-accounts has `--token` because a shell needs `$( )` substitution for
// relaunch. Here there is no such need, and an agent that can print a secret
// will eventually print it into a transcript. `--exec` covers the real use and
// keeps the value out of stdout entirely.
//
// KNOWN LIMITATION (verified, not assumed)
// ----------------------------------------
// `security add-generic-password` requires the secret in argv: passing it on
// stdin with a bare `-w` stores an EMPTY value (tested). So during the write
// the secret is briefly visible to `ps` on this machine. It never touches the
// shell history or a file, and the window is one exec. On a shared machine,
// prefer `--exec` with a credential added from a trusted session.
//
// Library exports:
//   registryPath(), load(), save(list)
//   add({service,name,secret,envVar,note}) / remove(service,name)
//   get(service, name)            → secret | null   (for --exec only)
//   probeSecret(service, name)    → {state, value}  present | absent | unknown
//   secretState(service, name)    → 'present' | 'absent' | 'unknown'
//   list()                        → entries without secrets
//   envVarFor(service)            → conventional variable name
//
// CLI:
//   node forge-secrets.js --add <service> <name> [--env VAR] [--note "..."]   (secret on stdin)
//   node forge-secrets.js --list [--json]
//   node forge-secrets.js --exec <service> <name> -- <command> [args...]
//   node forge-secrets.js --remove <service> <name>
//   node forge-secrets.js --services

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mutex = require('./forge-lock');
const { execFileSync, spawnSync } = require('child_process');
const keychainDiag = require('./forge-keychain-diagnostics');
// Every Keychain branch below asks this first. See forge-keychain-switch.js for
// why: with an isolated HOME `security` raises a modal dialog and blocks, so the
// test suite must be unable to reach the real binary. Unset variable ⇒ the
// predicate is exactly the old `process.platform === 'darwin'` test.
const { keychainEnabled } = require('./forge-keychain-switch');

// Every `security` call is bounded. A locked keychain makes the tool prompt for
// a password, and with no TTY — a CI runner, a hook, a headless agent — it waits
// forever instead of failing. Discovered when the macOS CI job went from 70s to
// hanging past ten minutes on this exact call.
const KEYCHAIN_TIMEOUT_MS = Number(process.env.FORGE_KEYCHAIN_TIMEOUT_MS || 5000);
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const REGISTRY_FILE = process.env.FORGE_SECRETS_REGISTRY
  || path.join(CLAUDE_DIR, 'forge-secrets.json');
const FALLBACK_FILE = process.env.FORGE_SECRETS_REGISTRY
  ? `${process.env.FORGE_SECRETS_REGISTRY}.secrets`
  : path.join(CLAUDE_DIR, 'forge-secrets-store.json');
const KEYCHAIN_ACCT = os.userInfo().username;
const JOURNAL_FILE = `${REGISTRY_FILE}.pending`;
const GUARD_ROOT = `${REGISTRY_FILE}.guard`;

// ── Known services ───────────────────────────────────────────────────────────
// The environment variable each CLI reads. Getting this wrong means the command
// runs unauthenticated and fails in a way that looks like a bad token, so the
// mapping is explicit rather than guessed from the service name.
const SERVICES = {
  railway:    { env: 'RAILWAY_TOKEN',        cli: 'railway',  label: 'Railway' },
  vercel:     { env: 'VERCEL_TOKEN',         cli: 'vercel',   label: 'Vercel' },
  fly:        { env: 'FLY_API_TOKEN',        cli: 'flyctl',   label: 'Fly.io' },
  github:     { env: 'GITHUB_TOKEN',         cli: 'gh',       label: 'GitHub' },
  supabase:   { env: 'SUPABASE_ACCESS_TOKEN',cli: 'supabase', label: 'Supabase' },
  cloudflare: { env: 'CLOUDFLARE_API_TOKEN', cli: 'wrangler', label: 'Cloudflare' },
  netlify:    { env: 'NETLIFY_AUTH_TOKEN',   cli: 'netlify',  label: 'Netlify' },
  openai:     { env: 'OPENAI_API_KEY',       cli: null,       label: 'OpenAI' },
  figma:      { env: 'FIGMA_API_KEY',        cli: null,       label: 'Figma' },
  brave:      { env: 'BRAVE_API_KEY',        cli: null,       label: 'Brave Search' },
};

function envVarFor(service) {
  const known = SERVICES[String(service).toLowerCase()];
  if (known) return known.env;
  // Unknown service: SERVICE_TOKEN is the common convention, and the caller can
  // always override with --env.
  return `${String(service).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
}

// ── Registry (non-secret) ────────────────────────────────────────────────────
function vaultError(code, message) {
  const error = new Error(`forge-secrets: ${message}`);
  error.code = code;
  return error;
}

function validCredentials(value) {
  return Array.isArray(value) && value.every(c => c && typeof c === 'object'
    && typeof c.service === 'string' && typeof c.name === 'string');
}

function validStore(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(v => typeof v === 'string');
}

// Only absence authorizes an empty store. Do not include parser errors: they
// may quote the secret-bearing input in their message.
function readVaultJson(file, empty, valid) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return empty;
    throw vaultError('VAULT_UNREADABLE', `cannot read vault file (${error.code || 'IO_ERROR'})`);
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw vaultError('VAULT_INVALID', 'invalid vault JSON; original file preserved'); }
  if (!valid(value)) throw vaultError('VAULT_INVALID', 'invalid vault schema; original file preserved');
  return value;
}

function readRegistry() {
  return readVaultJson(REGISTRY_FILE, { version: 1, credentials: [] },
    j => j && j.version === 1 && validCredentials(j.credentials)).credentials;
}

function readStore() { return readVaultJson(FALLBACK_FILE, {}, validStore); }

function readJournal() {
  return readVaultJson(JOURNAL_FILE, null, j => j && j.version === 1
    && ['add', 'remove'].includes(j.operation) && typeof j.service === 'string'
    && typeof j.name === 'string' && validCredentials(j.credentials)
    && (j.operation === 'remove' || /^[a-f0-9]{64}$/.test(j.digest)));
}

function pendingError() {
  return vaultError('VAULT_RECOVERY_REQUIRED', 'interrupted operation; run --recover or repeat the original add/remove');
}

function load() {
  if (readJournal()) throw pendingError();
  return readRegistry();
}

// Vault-specific publisher: exclusive 0600 temporary, complete write + fsync,
// then same-directory rename. A failed write never truncates the old version.
function publishVaultJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function withVaultLock(fn) {
  fs.mkdirSync(path.join(GUARD_ROOT, '.gsd'), { recursive: true, mode: 0o700 });
  // Reclaim only a provably dead local process, never an expired lease. A slow
  // Keychain call or debugger must not admit a second writer.
  const dir = mutex.lockPath(GUARD_ROOT, 'vault');
  const meta = readVaultJson(mutex.metaPath(dir), null,
    m => m && Number.isSafeInteger(m.holder_pid) && m.holder_pid > 0
      && typeof m.owner_token === 'string' && typeof m.generation === 'string');
  if (!meta && fs.existsSync(dir)) {
    throw vaultError('VAULT_GUARD_INCOMPLETE', 'vault guard has no owner metadata; stop all vault writers, then run --recover --confirm-stopped (original guard will be archived)');
  }
  if (meta) {
    let dead = false;
    try { process.kill(meta.holder_pid, 0); }
    catch (error) { dead = error.code === 'ESRCH'; }
    if (dead) mutex.releaseHandle({ lockDir: dir, ownerToken: meta.owner_token, generation: meta.generation });
  }
  const lock = mutex.acquireSync(GUARD_ROOT, 'vault', {
    retries: 100, backoffMin: 20, backoffMax: 40, allowStaleRecovery: false,
  });
  let operationError;
  try { return fn(); }
  catch (error) { operationError = error; throw error; }
  finally {
    let released;
    try { released = lock.release(); } catch { released = { ok: false }; }
    if (!released.ok) {
      const failure = vaultError('VAULT_GUARD_RELEASE_FAILED', 'vault mutation may have completed but guard release failed; stop all vault writers, then run --recover --confirm-stopped');
      if (!operationError) throw failure;
      operationError.guard_release_failure = { code: failure.code, message: failure.message };
    }
  }
}

function save(credentials) {
  return withVaultLock(() => {
    load(); // Refuse to overwrite unreadable or interrupted metadata.
    if (!validCredentials(credentials)) throw vaultError('VAULT_INVALID', 'invalid credentials');
    publishVaultJson(REGISTRY_FILE, { version: 1, credentials });
  });
}

function keychainService(service, name) {
  return `forge-secret-${service}-${name}`;
}

// ── Secret storage ───────────────────────────────────────────────────────────
function storeSecret(service, name, secret, store) {
  if (keychainEnabled()) {
    try {
      // See the header note: the secret must go in argv because `security`
      // stores an empty value when given one on stdin.
      execFileSync('security', [
        'add-generic-password', '-U',
        '-a', KEYCHAIN_ACCT,
        '-s', keychainService(service, name),
        '-w', secret,
      ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS });
      return 'keychain';
    } catch (err) {
      // The Keychain can be unreachable: it is resolved through HOME, so a
      // sandboxed or altered environment has none, and a locked keychain also
      // refuses writes. Falling through to the 0600 file keeps the credential
      // usable instead of silently vanishing — `store` records which was used
      // so `--list` can say so. Record the failure BEFORE falling back, so
      // the next occurrence leaves evidence instead of only a `store: file`.
      keychainDiag.recordFailure({
        engine: 'forge-secrets.storeSecret',
        service: keychainService(service, name),
        account: KEYCHAIN_ACCT,
        err,
        fallback: true,
      });
    }
  }
  // No Keychain: a 0600 file, created before anything is written to it.
  store[keychainService(service, name)] = secret;
  publishVaultJson(FALLBACK_FILE, store);
  return 'file';
}

// ── Reading: three states, never two ─────────────────────────────────────────
// "I could not read the vault" and "there is nothing in the vault" are
// different answers, and collapsing them into a boolean is how `--list
// --verify` came to report a healthy secret as missing and send the user to
// re-add it. Every read below returns one of:
//
//   present  — we read a value
//   absent   — we read successfully and there is nothing there
//   unknown  — we could not tell; the value may well be present
//
// The rule for turning an error into a state is an ALLOWLIST, deliberately:
// only errors we have positively identified as "no such item" may produce
// `absent`. A blocklist ("known failures are errors, everything else is
// absent") re-creates the same defect for every failure mode nobody thought
// of yet — and hides it better, because it looks handled.

// `security` exits 44 for an item that is not in the keychain. A timeout, by
// contrast, arrives as {status: null, signal: 'SIGTERM', code: 'ETIMEDOUT'} —
// which says nothing about whether the item exists.
const KEYCHAIN_NOT_FOUND = 44;

function keychainProbe(service, name) {
  // Guarded here as well as at the `probeSecret` call site: this function is the
  // one that actually spawns `security`, so a future caller that forgets the
  // outer check still cannot reach the binary. `unknown` (not `absent`) is the
  // honest answer — we did not look, so we cannot claim there is nothing there.
  if (!keychainEnabled()) return { state: 'unknown', value: null };
  try {
    const v = execFileSync('security', [
      'find-generic-password',
      '-a', KEYCHAIN_ACCT,
      '-s', keychainService(service, name),
      '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
         timeout: KEYCHAIN_TIMEOUT_MS }).replace(/\n$/, '');
    // An empty stored value counts as absent, so it still falls through to the
    // file store — the behaviour the old `if (v) return v` had.
    return v ? { state: 'present', value: v } : { state: 'absent', value: null };
  } catch (e) {
    if (e && e.status === KEYCHAIN_NOT_FOUND) return { state: 'absent', value: null };
    return { state: 'unknown', value: null };
  }
}

function fileProbe(service, name) {
  let raw;
  try {
    raw = fs.readFileSync(FALLBACK_FILE, 'utf8');
  } catch (e) {
    // No file at all is a real answer: nothing was ever written here.
    if (e && e.code === 'ENOENT') return { state: 'absent', value: null };
    // EACCES and friends are not — the file may be full of secrets.
    return { state: 'unknown', value: null };
  }
  let store;
  try { store = JSON.parse(raw); }
  catch { return { state: 'unknown', value: null }; }
  // storeSecret always serializes a plain object (see below) — a parsed root
  // that is not one is positive evidence of corruption, not of an empty
  // vault, and must not be reported as `absent`.
  if (store === null || typeof store !== 'object' || Array.isArray(store)) {
    return { state: 'unknown', value: null };
  }
  const v = store[keychainService(service, name)];
  return v ? { state: 'present', value: v } : { state: 'absent', value: null };
}

/// Compose the layers: a value found anywhere wins; otherwise any layer that
/// could not answer makes the whole answer `unknown`. `absent` requires every
/// layer to have said so.
function probeSecret(service, name) {
  try { if (readJournal()) return { state: 'unknown', value: null }; }
  catch { return { state: 'unknown', value: null }; }
  let sawUnknown = false;
  if (keychainEnabled()) {
    const k = keychainProbe(service, name);
    if (k.state === 'present') return k;
    if (k.state === 'unknown') sawUnknown = true;
  }
  // Checked on every platform, not just non-darwin: a credential written while
  // the Keychain was unavailable lives here and must still be readable.
  const f = fileProbe(service, name);
  if (f.state === 'present') return f;
  if (f.state === 'unknown') sawUnknown = true;

  return { state: sawUnknown ? 'unknown' : 'absent', value: null };
}

function secretState(service, name) {
  return probeSecret(service, name).state;
}

function get(service, name) {
  const p = probeSecret(service, name);
  return p.state === 'present' ? p.value : null;
}

function deleteSecret(service, name, store) {
  if (keychainEnabled()) {
    try {
      execFileSync('security', [
        'delete-generic-password',
        '-a', KEYCHAIN_ACCT,
        '-s', keychainService(service, name),
      ], { stdio: 'ignore', timeout: KEYCHAIN_TIMEOUT_MS });
    } catch (error) {
      if (error.status !== KEYCHAIN_NOT_FOUND) {
        throw vaultError('VAULT_UNREADABLE', 'Keychain deletion failed; operation remains pending');
      }
    }
    // No early return: a copy may also exist in the file store from a moment
    // when the Keychain was unavailable, and leaving it behind would mean
    // "removed" was a lie.
  }
  delete store[keychainService(service, name)];
  publishVaultJson(FALLBACK_FILE, store);
}

// ── Operations ───────────────────────────────────────────────────────────────
function add({ service, name, secret, envVar, note }) {
  service = String(service || '').toLowerCase().trim();
  name = String(name || '').trim();
  if (!service || !name) throw new Error('service e name são obrigatórios');
  if (typeof secret !== 'string' || !secret) throw new Error('segredo vazio');

  return withVaultLock(() => {
    const digest = crypto.createHash('sha256').update(secret).digest('hex');
    const pending = readJournal();
    if (pending && (pending.operation !== 'add' || pending.service !== service
      || pending.name !== name || pending.digest !== digest)) throw pendingError();
    const before = readRegistry();
    const fallback = readStore(); // Preflight BOTH files before any backend mutation.
    const credentials = pending ? pending.credentials
      : before.filter(c => !(c.service === service && c.name === name));
    if (!pending) credentials.push({
      service, name, env_var: envVar || envVarFor(service), note: note || '',
      store: 'file', added_at: new Date().toISOString(),
    });
    const intent = pending || { version: 1, operation: 'add', service, name, digest, credentials };
    publishVaultJson(JOURNAL_FILE, intent);
    const store = storeSecret(service, name, secret, fallback);
    credentials.find(c => c.service === service && c.name === name).store = store;
    publishVaultJson(REGISTRY_FILE, { version: 1, credentials });
    fs.unlinkSync(JOURNAL_FILE);
    return { service, name, store };
  });
}

function remove(service, name) {
  service = String(service || '').toLowerCase();
  return withVaultLock(() => {
    const pending = readJournal();
    if (pending && (pending.operation !== 'remove' || pending.service !== service
      || pending.name !== name)) throw pendingError();
    const before = readRegistry();
    const fallback = readStore();
    const credentials = pending ? pending.credentials
      : before.filter(c => !(c.service === service && c.name === name));
    if (!pending && credentials.length === before.length) return false;
    const intent = pending || { version: 1, operation: 'remove', service, name, credentials,
      needsKeychain: keychainEnabled() || before.some(c => c.service === service
        && c.name === name && c.store === 'keychain') };
    if (intent.needsKeychain && !keychainEnabled()) {
      if (pending) throw pendingError();
      throw vaultError('VAULT_KEYCHAIN_UNAVAILABLE', 'Keychain unavailable; enable Keychain access and retry removal; no operation was started');
    }
    publishVaultJson(JOURNAL_FILE, intent);
    deleteSecret(service, name, fallback);
    publishVaultJson(REGISTRY_FILE, { version: 1, credentials });
    fs.unlinkSync(JOURNAL_FILE);
    return true;
  });
}

// A journal contains intent + metadata, never secret bytes (including Keychain
// secrets). Recovery commits only after verifying the intended backend result.
// If the backend write did not finish, repeating the original operation resumes
// it under the same lock. An unrelated write cannot hide the inconsistency.
function recover(opts) {
  let guard;
  if (opts && opts.confirmStopped === true) {
    guard = recoverGuard(opts);
    if (!guard.ok && !['guard_not_held', 'guard_metadata_present'].includes(guard.reason)) {
      throw vaultError('VAULT_GUARD_RECOVERY_FAILED', guard.reason);
    }
  }
  const recovered = withVaultLock(() => {
    const pending = readJournal();
    if (!pending) return false;
    readRegistry();
    const fallback = readStore();
    const key = keychainEnabled() ? keychainProbe(pending.service, pending.name)
      : { state: pending.needsKeychain ? 'unknown' : 'absent', value: null };
    const value = fallback[keychainService(pending.service, pending.name)];
    if (pending.operation === 'add') {
      const actual = key.state === 'present' ? key.value : value;
      if (typeof actual !== 'string'
        || crypto.createHash('sha256').update(actual).digest('hex') !== pending.digest) throw pendingError();
      const entry = pending.credentials.find(c => c.service === pending.service && c.name === pending.name);
      if (!entry) throw vaultError('VAULT_INVALID', 'pending credential metadata missing');
      entry.store = key.state === 'present' ? 'keychain' : 'file';
    } else if (key.state !== 'absent' || value !== undefined) throw pendingError();
    publishVaultJson(REGISTRY_FILE, { version: 1, credentials: pending.credentials });
    fs.unlinkSync(JOURNAL_FILE);
    return true;
  });
  return opts && opts.confirmStopped === true ? { recovered, guard_evidence: guard.evidence || null } : recovered;
}

function recoverGuard(opts) { return mutex.recoverIncompleteLock(GUARD_ROOT, 'vault', opts); }

/// Registry entries, never the secrets.
///
/// `verify` is OFF by default, and that is the whole point: checking whether a
/// value is present means reading it, and every read is a Keychain access. On a
/// bundle without a stable signature — an ad-hoc signed app, which is any build
/// without a Developer ID — macOS re-prompts for authorisation on each one, so
/// simply listing five secrets produced five dialogs.
///
/// Verification is still available for a health check, where one round of
/// prompts is a reasonable price for the answer.
///
/// With `verify`, `has_secret` is true / false / null, and null keeps its
/// meaning of "no claim": either nobody looked, or looking failed. A failed
/// read must never surface as `false` — that is a statement about the vault's
/// contents that we are in no position to make.
function list(opts) {
  const verify = !!(opts && opts.verify);
  return load().map(c => {
    if (!verify) return { ...c, has_secret: null };
    const state = secretState(c.service, c.name);
    return {
      ...c,
      has_secret: state === 'present' ? true : (state === 'absent' ? false : null),
      // Additive: only present when we tried and could not tell.
      ...(state === 'unknown' ? { verify_failed: true } : {}),
    };
  });
}

function find(service, name) {
  service = String(service || '').toLowerCase();
  return load().find(c => c.service === service && c.name === name) || null;
}

function forService(service) {
  service = String(service || '').toLowerCase();
  return load().filter(c => c.service === service);
}

/// Mark one entry as the service default, so `exec railway -- ...` works
/// without naming it. Exactly one default per service.
function setDefault(service, name) {
  service = String(service || '').toLowerCase();
  return withVaultLock(() => {
    const all = load();
    if (!all.some(c => c.service === service && c.name === name)) return false;
    publishVaultJson(REGISTRY_FILE, { version: 1,
      credentials: all.map(c => c.service === service ? { ...c, is_default: c.name === name } : c) });
    return true;
  });
}

/// Resolve which entry a command means.
///
/// Ambiguity is an ERROR, never a guess: picking the first of three Railway
/// projects would deploy to the wrong one and look like it worked. The caller
/// gets the candidates so it can say what to choose between.
function resolve(service, name) {
  service = String(service || '').toLowerCase();
  const candidates = forService(service);
  if (!candidates.length) return { error: 'none', candidates: [] };

  if (name) {
    const exact = candidates.find(c => c.name === name);
    return exact ? { entry: exact } : { error: 'not-found', candidates };
  }
  if (candidates.length === 1) return { entry: candidates[0] };

  const marked = candidates.find(c => c.is_default);
  if (marked) return { entry: marked };
  return { error: 'ambiguous', candidates };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function readStdin() {
  try { return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, ''); }
  catch { return ''; }
}

function usage() {
  return [
    'forge-secrets — cofre de segredos do Forge',
    '',
    'Uso:',
    '  --add <serviço> <nome> [--env VAR] [--note "..."]   segredo vem do stdin',
    '  --list [serviço] [--verify] [--json]   --verify lê o cofre (abre o Keychain)',
    '  --exec <serviço> [nome] -- <comando> [args...]',
    '  --default <serviço> <nome>                          padrão do serviço',
    '  --remove <serviço> <nome>',
    '  --recover [--confirm-stopped]                       recover interrupted write; flag archives an incomplete guard after all writers stop',
    '  --services                                          serviços conhecidos',
    '  --diagnostics [--json]   falhas de escrita no Keychain (sem segredos)',
    '',
    'Vários do mesmo serviço convivem — o nome é seu:',
    '  printf %s "$TOKEN" | forge-secrets add railway lookchina',
    '  printf %s "$TOKEN" | forge-secrets add railway feirao',
    '  forge-secrets exec railway lookchina -- railway up',
    '  forge-secrets default railway lookchina    # aí "exec railway --" já resolve',
    '',
    'O segredo nunca é impresso: use --exec para rodar comandos com ele.',
  ].join('\n');
}

function main(argv) {
  const flag = (n) => argv.indexOf(n);
  const json = argv.includes('--json');

  if (argv.length === 0 || argv.includes('--help')) { console.log(usage()); return 0; }

  if (argv.includes('--recover')) {
    const result = recover(argv.includes('--confirm-stopped') ? { confirmStopped: true } : undefined);
    if (result && result.guard_evidence) console.log(`Guard evidence preserved: ${result.guard_evidence}`);
    console.log((typeof result === 'object' ? result.recovered : result) ? 'Recovered interrupted operation.' : 'No pending operation.');
    return 0;
  }

  if (argv.includes('--services')) {
    const rows = Object.entries(SERVICES).map(([k, v]) => ({ service: k, ...v }));
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) {
      console.log(`  ${r.service.padEnd(12)} ${r.env.padEnd(24)} ${r.cli || ''}`);
    }
    return 0;
  }

  if (argv.includes('--diagnostics')) {
    const entries = keychainDiag.readEntries();
    if (json) { console.log(JSON.stringify(entries, null, 2)); return 0; }
    console.log(keychainDiag.formatEntries(entries));
    return 0;
  }

  const iAdd = flag('--add');
  if (iAdd >= 0) {
    const service = argv[iAdd + 1];
    const name = argv[iAdd + 2];
    if (!service || !name) { console.error('forge-secrets: --add requer <serviço> <nome>'); return 2; }
    const iEnv = flag('--env');
    const iNote = flag('--note');
    const secret = readStdin();
    if (!secret) {
      console.error('forge-secrets: nenhum segredo no stdin.');
      console.error('  ex: printf %s "$TOKEN" | forge-secrets add railway producao');
      return 2;
    }
    try {
      const r = add({
        service, name, secret,
        envVar: iEnv >= 0 ? argv[iEnv + 1] : null,
        note: iNote >= 0 ? argv[iNote + 1] : '',
      });
      const entry = find(r.service, r.name);
      console.log(`✓ ${r.service}/${r.name} guardado (${r.store}) → ${entry.env_var}`);
      return 0;
    } catch (e) { console.error(`forge-secrets: ${e.message}`); return 1; }
  }

  const iList = flag('--list');
  if (iList >= 0) {
    const filter = argv[iList + 1] && !argv[iList + 1].startsWith('--')
      ? argv[iList + 1].toLowerCase() : null;
    let rows = list({ verify: argv.includes('--verify') });
    if (filter) rows = rows.filter(c => c.service === filter);
    if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    if (!rows.length) {
      console.log(filter ? `Nenhum segredo de ${filter}.` : 'Nenhum segredo guardado.');
      return 0;
    }
    // Grouped by service: with several entries per service a flat list stops
    // answering "which ones do I have for railway".
    const services = [...new Set(rows.map(c => c.service))].sort();
    for (const svc of services) {
      const group = rows.filter(c => c.service === svc);
      const known = SERVICES[svc];
      console.log(`\n  ${svc}${known ? `  (${known.env})` : ''}`);
      for (const c of group) {
        // Four marks for four claims. "We did not look", "we looked and could
        // not tell" and "it is missing" are three different things, and only
        // the last one justifies telling the user to re-add anything.
        const mark = c.verify_failed ? '⚠'
          : (c.has_secret === null ? '·' : (c.has_secret ? '●' : '○'));
        const def = c.is_default ? ' ★' : '  ';
        console.log(`    ${mark}${def} ${c.name.padEnd(18)} ${c.note || ''}`);
      }
    }
    console.log('');
    if (rows.some(c => c.is_default)) console.log('  ★ = padrão do serviço');
    if (rows.some(c => c.has_secret === false)) {
      console.log('  ○ = registrado sem valor no cofre — readicione.');
    }
    // Only offer --verify to someone who has not used it. Telling a user who
    // just ran --verify to run --verify is how the old footer read.
    if (rows.some(c => c.has_secret === null && !c.verify_failed)) {
      console.log('  · = valor não verificado (use --verify; abre o Keychain)');
    }
    if (rows.some(c => c.verify_failed)) {
      console.log('  ⚠ = não foi possível ler o cofre — o valor pode estar lá (não readicione às cegas)');
    }
    return 0;
  }

  const iDefault = flag('--default');
  if (iDefault >= 0) {
    const svc = argv[iDefault + 1];
    const nm = argv[iDefault + 2];
    if (!svc || !nm) { console.error('forge-secrets: --default requer <serviço> <nome>'); return 2; }
    if (!setDefault(svc, nm)) { console.error(`forge-secrets: ${svc}/${nm} não existe`); return 1; }
    console.log(`✓ ${svc}/${nm} agora é o padrão de ${svc}`);
    return 0;
  }

  const iRemove = flag('--remove');
  if (iRemove >= 0) {
    const ok = remove(argv[iRemove + 1], argv[iRemove + 2]);
    console.log(ok ? '✓ removida' : 'não encontrada');
    return ok ? 0 : 1;
  }

  const iExec = flag('--exec');
  if (iExec >= 0) {
    const service = argv[iExec + 1];
    const sep = argv.indexOf('--', iExec + 1);
    if (!service || sep < 0 || !argv[sep + 1]) {
      console.error('forge-secrets: --exec <serviço> [nome] -- <comando> [args...]');
      return 2;
    }
    // The name is optional: everything between the service and `--` that is not
    // the separator itself.
    const name = sep > iExec + 2 ? argv[iExec + 2] : null;

    const target = resolve(service, name);
    if (target.error === 'none') {
      console.error(`forge-secrets: nenhum segredo de ${service} guardado`);
      console.error(`  ex: printf %s "$TOKEN" | forge-secrets add ${service} <nome>`);
      return 1;
    }
    if (target.error === 'not-found') {
      console.error(`forge-secrets: ${service}/${name} não existe. Disponíveis:`);
      for (const c of target.candidates) console.error(`  ${service}/${c.name}`);
      return 1;
    }
    if (target.error === 'ambiguous') {
      // Guessing here would deploy to the wrong project and look like success.
      console.error(`forge-secrets: ${service} tem ${target.candidates.length} segredos — diga qual:`);
      for (const c of target.candidates) {
        console.error(`  forge-secrets exec ${service} ${c.name} -- ...` +
          (c.note ? `   (${c.note})` : ''));
      }
      console.error(`\n  ou defina um padrão: forge-secrets default ${service} <nome>`);
      return 2;
    }
    const entry = target.entry;
    // One probe, not get() plus a second look: each read of the Keychain can
    // cost the user an authorisation dialog.
    const probe = probeSecret(entry.service, entry.name);
    if (probe.state !== 'present') {
      // Both states are fatal — running the command without the credential
      // would fail somewhere far from the cause. Only the reason differs.
      if (probe.state === 'unknown') {
        console.error(`forge-secrets: não foi possível ler o segredo de ${entry.service}/${entry.name} no cofre.`);
        console.error('  O comando não roda sem a credencial. O valor pode estar guardado — não readicione às cegas.');
      } else {
        console.error(`forge-secrets: segredo de ${entry.service}/${entry.name} não encontrado — readicione`);
      }
      return 1;
    }
    const secret = probe.value;
    const cmd = argv[sep + 1];
    const args = argv.slice(sep + 2);
    // The secret enters the child's environment and nothing else: not argv, not
    // stdout, not the parent shell.
    const r = spawnSync(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, [entry.env_var]: secret },
    });
    if (r.error) { console.error(`forge-secrets: ${r.error.message}`); return 127; }
    return r.status === null ? 1 : r.status;
  }

  console.log(usage());
  return 0;
}

module.exports = {
  REGISTRY_FILE, SERVICES,
  load, save, add, remove, recover, recoverGuard, get, list, find, forService, setDefault, resolve,
  envVarFor, keychainService, probeSecret, secretState,
};

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) {
    console.error(`forge-secrets: ${e.message}`);
    if (e.guard_release_failure) console.error(`${e.guard_release_failure.code}: ${e.guard_release_failure.message}`);
    process.exit(1);
  }
}
