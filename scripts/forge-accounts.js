#!/usr/bin/env node
// forge-accounts — Multi-account registry & switcher for Forge Agent
//
// WHY THIS EXISTS
// A running Claude Code session cannot switch its own account mid-session
// (`/login` mid-session is broken — stuck 401). The reliable, macOS-safe way to
// run multiple Claude accounts is `claude setup-token` (long-lived OAuth token,
// ~1yr) selected at launch via the CLAUDE_CODE_OAUTH_TOKEN env var, which takes
// precedence over the Keychain subscription login. This module stores one token
// per named account and builds the exact relaunch command to switch.
//
// STORAGE
//   - Registry (NON-secret): ~/.claude/forge-accounts.json
//       { version, active, accounts: { <name>: {added_at,last_used,note,store} } }
//   - Token (secret):
//       darwin  → macOS Keychain, service "forge-account-<name>", acct=<os user>
//       other   → ~/.claude/forge-accounts-tokens.json, chmod 0600 (gitignore!)
//
// The token NEVER lands in the registry JSON. `--token <name>` prints it to
// stdout on purpose — that is how the relaunch command injects it via $( ).
//
// CLI
//   node forge-accounts.js --add <name> [--note "<n>"]   (TTY → runs `claude setup-token`
//                                                          and captures the token automatically;
//                                                          or --token <tok>, or piped stdin)
//   node forge-accounts.js --list [--json]
//   node forge-accounts.js --current [--json]
//   node forge-accounts.js --use <name>            # mark active + print relaunch cmd
//   node forge-accounts.js --launch-cmd <name>     # print relaunch cmd only
//   node forge-accounts.js --token <name>          # print the raw token (for $( ))
//   node forge-accounts.js --remove <name>
//   node forge-accounts.js --help

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLAUDE_DIR     = path.join(os.homedir(), '.claude');
// FORGE_ACCOUNTS_REGISTRY overrides the non-secret registry path (used for tests
// and for isolating a dev registry). Tokens still live in the Keychain by name.
const REGISTRY_FILE  = process.env.FORGE_ACCOUNTS_REGISTRY || path.join(CLAUDE_DIR, 'forge-accounts.json');
const TOKENS_FILE    = path.join(CLAUDE_DIR, 'forge-accounts-tokens.json'); // non-darwin fallback
const IS_DARWIN      = process.platform === 'darwin';
const KEYCHAIN_ACCT  = (() => { try { return os.userInfo().username; } catch { return 'forge'; } })();
const TOKEN_TTL_DAYS = 365; // setup-token validity window

// ── Name validation ──────────────────────────────────────────────────────────
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
function assertName(name) {
  if (!name || name === true) throw new Error('account name required');
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid account name '${name}' (use letters, digits, . _ - ; max 32 chars)`);
  }
  return name;
}

// ── Registry I/O (atomic write via temp+rename) ──────────────────────────────
function loadRegistry() {
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    if (!r.accounts || typeof r.accounts !== 'object') r.accounts = {};
    if (typeof r.version !== 'number') r.version = 1;
    if (!('active' in r)) r.active = null;
    return r;
  } catch {
    return { version: 1, active: null, accounts: {} };
  }
}

function saveRegistry(reg) {
  try { fs.mkdirSync(CLAUDE_DIR, { recursive: true }); } catch {}
  const tmp = path.join(CLAUDE_DIR, `.forge-accounts.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, REGISTRY_FILE);
}

// ── Token storage ────────────────────────────────────────────────────────────
function keychainService(name) { return `forge-account-${name}`; }

function storeToken(name, token) {
  if (IS_DARWIN) {
    // -U updates if the item already exists. Args passed as an array (no shell),
    // so the token is not subject to shell history/quoting. It is briefly visible
    // in `ps` — acceptable for a local single-user macOS Keychain write.
    execFileSync('security', [
      'add-generic-password', '-U',
      '-a', KEYCHAIN_ACCT,
      '-s', keychainService(name),
      '-w', token,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return 'keychain';
  }
  // Fallback: 0600 file. Create with restrictive mode from the start.
  let map = {};
  try { map = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch {}
  map[name] = token;
  const tmp = path.join(CLAUDE_DIR, `.forge-tokens.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, TOKENS_FILE);
  try { fs.chmodSync(TOKENS_FILE, 0o600); } catch {}
  return 'file';
}

function readToken(name) {
  if (IS_DARWIN) {
    try {
      return execFileSync('security', [
        'find-generic-password',
        '-a', KEYCHAIN_ACCT,
        '-s', keychainService(name),
        '-w',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
    } catch {
      return null;
    }
  }
  try {
    const map = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    return map[name] || null;
  } catch {
    return null;
  }
}

function deleteToken(name) {
  if (IS_DARWIN) {
    try {
      execFileSync('security', [
        'delete-generic-password',
        '-a', KEYCHAIN_ACCT,
        '-s', keychainService(name),
      ], { stdio: 'ignore' });
    } catch { /* not present — fine */ }
    return;
  }
  try {
    const map = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    delete map[name];
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(map, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

function daysLeft(addedIso) {
  if (!addedIso) return null;
  const added = new Date(addedIso).getTime();
  if (!Number.isFinite(added)) return null;
  const expires = added + TOKEN_TTL_DAYS * 86400_000;
  return Math.floor((expires - Date.now()) / 86400_000);
}

function scriptPath() {
  // Absolute path to this file as installed (~/.claude/scripts/forge-accounts.js)
  return __filename;
}

// True when the `forge-accounts` wrapper is resolvable on PATH — lets us emit
// short, readable relaunch commands instead of the long node-path form.
function wrapperOnPath() {
  try {
    execFileSync('which', ['forge-accounts'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function launchCommand(name) {
  const tokenCmd = wrapperOnPath()
    ? `forge-accounts token ${name}`
    : `node '${scriptPath()}' --token ${name}`;
  return `FORGE_ACCOUNT=${name} CLAUDE_CODE_OAUTH_TOKEN="$(${tokenCmd})" claude`;
}

// ── Operations ───────────────────────────────────────────────────────────────
function addAccount(name, token, note) {
  assertName(name);
  const tok = String(token || '').trim();
  if (!tok) throw new Error('empty token — paste the sk-ant-oat01-… from `claude setup-token`');
  if (/\s/.test(tok)) throw new Error('token contains whitespace — paste a single line');
  const warn = !/^sk-ant-(oat|api)/.test(tok)
    ? `token does not look like a setup-token (expected sk-ant-oat01-…); stored anyway`
    : null;
  const store = storeToken(name, tok);
  const reg = loadRegistry();
  const existing = reg.accounts[name] || {};
  reg.accounts[name] = {
    added_at: nowIso(),
    last_used: existing.last_used || null,
    note: note && note !== true ? String(note) : (existing.note || ''),
    store,
  };
  if (!reg.active) reg.active = name; // first account becomes active by default
  saveRegistry(reg);
  return { name, store, warn };
}

function removeAccount(name) {
  assertName(name);
  deleteToken(name);
  const reg = loadRegistry();
  delete reg.accounts[name];
  if (reg.active === name) reg.active = Object.keys(reg.accounts)[0] || null;
  saveRegistry(reg);
}

// Rename keeps the same token (no re-`setup-token`): copy the token to the new
// slot, repoint the registry, persist, THEN delete the old token — so a failure
// mid-way never loses the credential. Preserves added_at/last_used/note/active.
function renameAccount(oldName, newName) {
  assertName(oldName);
  assertName(newName);
  if (oldName === newName) throw new Error('o nome novo é igual ao atual');
  const reg = loadRegistry();
  if (!reg.accounts[oldName]) throw new Error(`conta '${oldName}' não registrada`);
  if (reg.accounts[newName]) throw new Error(`já existe uma conta '${newName}' — escolha outro nome ou remova-a antes`);
  const token = readToken(oldName);
  if (!token) throw new Error(`sem token armazenado para '${oldName}' — não dá pra renomear com segurança`);
  const store = storeToken(newName, token);
  reg.accounts[newName] = { ...reg.accounts[oldName], store };
  delete reg.accounts[oldName];
  if (reg.active === oldName) reg.active = newName;
  saveRegistry(reg);
  deleteToken(oldName); // only after the registry points to the new slot
  return { oldName, newName };
}

function useAccount(name) {
  assertName(name);
  const reg = loadRegistry();
  if (!reg.accounts[name]) throw new Error(`account '${name}' not registered (run --add ${name} first)`);
  if (!readToken(name)) throw new Error(`no token stored for '${name}' — re-run --add ${name}`);
  reg.accounts[name].last_used = nowIso();
  reg.active = name;
  saveRegistry(reg);
  return launchCommand(name);
}

function listAccounts() {
  const reg = loadRegistry();
  const envActive = process.env.FORGE_ACCOUNT || null;
  return {
    active: reg.active,
    env_active: envActive,
    accounts: Object.entries(reg.accounts).map(([name, a]) => ({
      name,
      note: a.note || '',
      store: a.store || (IS_DARWIN ? 'keychain' : 'file'),
      added_at: a.added_at || null,
      last_used: a.last_used || null,
      days_left: daysLeft(a.added_at),
      has_token: !!readToken(name),
      is_active: reg.active === name,
      is_env_active: envActive === name,
    })),
  };
}

function currentAccount() {
  const reg = loadRegistry();
  return {
    registry_active: reg.active,
    env_active: process.env.FORGE_ACCOUNT || null,
  };
}

// ── Supervisor support (forge-run): cooldown tracking + account selection ─────
// A cooldown file maps account → { exhausted_at, resets_at } (epoch seconds).
// "Headroom" can't be queried live outside a session (rate_limits only reaches
// the statusline JSON), so we approximate: an account is eligible unless it's in
// cooldown (exhausted and before its resets_at). Among eligible, the most-rested
// (oldest/absent exhaustion) wins.
function readCooldowns(file) {
  if (!file) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function markCooldown(file, account, resetsAt) {
  if (!file) throw new Error('--mark-cooldown requer --cooldowns <file>');
  assertName(account);
  const cds = readCooldowns(file);
  cds[account] = {
    exhausted_at: Math.floor(Date.now() / 1000),
    resets_at: resetsAt != null && resetsAt !== '' ? Number(resetsAt) : null,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cds, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return cds[account];
}

function nextAccount(cooldownsFile) {
  const reg = loadRegistry();
  const cds = readCooldowns(cooldownsFile);
  const nowS = Math.floor(Date.now() / 1000);
  const tokenAccts = Object.keys(reg.accounts).filter((n) => !!readToken(n));
  const inCooldown = (n) => {
    const cd = cds[n];
    return !!(cd && cd.resets_at && cd.resets_at > nowS);
  };
  const eligible = tokenAccts.filter((n) => !inCooldown(n));
  if (eligible.length) {
    // most-rested first: never-exhausted (no record) sorts before older exhaustions
    eligible.sort((a, b) => ((cds[a]?.exhausted_at) || 0) - ((cds[b]?.exhausted_at) || 0));
    return { account: eligible[0], wait_until: null };
  }
  // all token accounts are cooling down → earliest reset time (so the supervisor can wait)
  let earliest = null;
  for (const n of tokenAccts) {
    const r = cds[n]?.resets_at;
    if (r && (earliest === null || r < earliest)) earliest = r;
  }
  return { account: null, wait_until: earliest };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Run `claude setup-token` interactively and capture the token automatically.
// stdin+stderr are inherited so the browser/login flow and its prompts work and
// stay visible; stdout is captured (setup-token emits the token there). The token
// is parsed out and never printed — only run this in YOUR terminal (needs a real
// TTY for the login), never via the in-session skill (no TTY, and it would route
// the secret through the transcript).
function runSetupTokenSync() {
  const { spawnSync } = require('child_process');
  process.stderr.write('\nAbrindo `claude setup-token` — conclua o login no browser…\n');
  const r = spawnSync('claude', ['setup-token'], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new Error("comando 'claude' não encontrado no PATH");
    throw new Error(`falha ao rodar 'claude setup-token': ${r.error.message}`);
  }
  const m = String(r.stdout || '').match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
  return m ? m[0] : '';
}

const HELP = `forge-accounts — multi-account registry & switcher for Forge Agent

Flags:
  --add <name> [--note "<n>"]                   register an account — runs
                                                'claude setup-token' and captures
                                                the token automatically (in a TTY)
  --add <name> --token <tok>                    register with an explicit token
  --add <name> --setup                          force the setup-token flow
  --list [--json]                               list registered accounts
  --current [--json]                            show active account (registry + env)
  --use <name> [--print]                        switch to the account: in a TTY it
                                                launches claude on it; --print (or no
                                                TTY) emits the relaunch command instead
  --launch-cmd <name>                           print relaunch command only
  --token <name>                                print the raw token (for $( ) substitution)
  --rename <old> --to <new>                     rename an account (keeps the token)
  --remove <name>                               delete account + its token
  --next-account [--cooldowns <file>]           print {account,wait_until} for the
                                                supervisor (most-rested eligible)
  --mark-cooldown <name> [--resets-at <epoch>] --cooldowns <file>
                                                record that <name> is exhausted
  --help                                        show this help

Switch accounts (cannot happen mid-session — relaunch claude):
  ${"FORGE_ACCOUNT=<name> CLAUDE_CODE_OAUTH_TOKEN=\"$(node forge-accounts.js --token <name>)\" claude"}

Get a token once per account with:  claude setup-token
`;

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) { process.stdout.write(HELP); return; }

  try {
    if ('add' in args) {
      const name = assertName(args.add);
      let token = (typeof args.token === 'string') ? args.token : '';
      // Token source precedence:
      //   1. --token <tok>            (explicit, scriptable)
      //   2. --setup / --login, OR an interactive TTY with no piped input
      //      → run `claude setup-token` and capture automatically (one command)
      //   3. piped stdin              (paste fallback)
      const wantSetup = 'setup' in args || 'login' in args;
      if (!token && (wantSetup || process.stdin.isTTY)) {
        token = runSetupTokenSync();
        if (!token) {
          throw new Error('token não capturado do `claude setup-token` ' +
            '(login cancelado/incompleto). Tente de novo, ou registre manual: ' +
            `--add ${name} --token <sk-ant-oat01-…>`);
        }
      } else if (!token) {
        token = readStdinSync();
      }
      const res = addAccount(name, token, args.note);
      if (res.warn) process.stderr.write(`forge-accounts: warning — ${res.warn}\n`);
      process.stdout.write(`added '${res.name}' (token in ${res.store})\n`);

    } else if ('list' in args) {
      const data = listAccounts();
      if (args.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }
      if (!data.accounts.length) { process.stdout.write('(no accounts registered)\n'); return; }
      for (const a of data.accounts) {
        const marks = [
          a.is_active ? 'active' : null,
          a.is_env_active ? 'this-session' : null,
          !a.has_token ? 'NO-TOKEN' : null,
          a.days_left != null ? `${a.days_left}d left` : null,
        ].filter(Boolean).join(', ');
        process.stdout.write(`${a.name}${a.note ? ` — ${a.note}` : ''}${marks ? `  [${marks}]` : ''}\n`);
      }

    } else if ('current' in args) {
      const data = currentAccount();
      if (args.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }
      process.stdout.write(`registry: ${data.registry_active || '(none)'}\nsession : ${data.env_active || '(default login)'}\n`);

    } else if ('use' in args) {
      const name = assertName(args.use);
      const cmd = useAccount(name); // marks active + validates token exists
      // In a real terminal: actually switch — launch claude on this account.
      // Without a TTY (in-session/`!`/piped) or with --print: emit the command,
      // since a session can't be started from a non-interactive context.
      if (process.stdout.isTTY && !('print' in args)) {
        const { spawnSync } = require('child_process');
        process.stderr.write(`\nTrocando para a conta '${name}' — iniciando Claude Code…\n`);
        const r = spawnSync('claude', [], {
          stdio: 'inherit',
          env: { ...process.env, FORGE_ACCOUNT: name, CLAUDE_CODE_OAUTH_TOKEN: readToken(name) },
        });
        if (r.error) {
          if (r.error.code === 'ENOENT') throw new Error("comando 'claude' não encontrado no PATH");
          throw new Error(`falha ao lançar claude: ${r.error.message}`);
        }
        process.exit(typeof r.status === 'number' ? r.status : 0);
      }
      process.stdout.write(cmd + '\n');

    } else if ('launch-cmd' in args) {
      assertName(args['launch-cmd']);
      process.stdout.write(launchCommand(args['launch-cmd']) + '\n');

    } else if ('token' in args) {
      const name = assertName(args.token);
      const tok = readToken(name);
      if (!tok) { process.stderr.write(`forge-accounts: no token for '${name}'\n`); process.exit(1); }
      process.stdout.write(tok); // no trailing newline — clean for $( )

    } else if ('rename' in args) {
      const oldName = assertName(args.rename);
      const newName = (typeof args.to === 'string') ? args.to : '';
      if (!newName) throw new Error('--rename requer --to <novo-nome>');
      const r = renameAccount(oldName, newName);
      process.stdout.write(`renamed '${r.oldName}' → '${r.newName}'\n`);

    } else if ('remove' in args) {
      removeAccount(args.remove);
      process.stdout.write(`removed '${args.remove}'\n`);

    } else if ('next-account' in args) {
      const f = typeof args.cooldowns === 'string' ? args.cooldowns : null;
      process.stdout.write(JSON.stringify(nextAccount(f)) + '\n');

    } else if ('mark-cooldown' in args) {
      const acct = assertName(args['mark-cooldown']);
      const f = typeof args.cooldowns === 'string' ? args.cooldowns : null;
      const resetsAt = ('resets-at' in args && args['resets-at'] !== true) ? args['resets-at'] : null;
      markCooldown(f, acct, resetsAt);
      process.stdout.write(`cooldown set for '${acct}'\n`);

    } else {
      process.stderr.write('forge-accounts: no command specified. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-accounts error: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadRegistry, saveRegistry,
  addAccount, removeAccount, renameAccount, useAccount, listAccounts, currentAccount,
  readToken, storeToken, deleteToken,
  launchCommand, daysLeft, assertName,
  nextAccount, markCooldown, readCooldowns,
  REGISTRY_FILE, TOKENS_FILE,
};

if (require.main === module) cliMain();
