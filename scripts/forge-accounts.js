#!/usr/bin/env node
// forge-accounts — Multi-account registry & switcher for Forge Agent
//
// WHY THIS EXISTS
// A running Claude Code session cannot switch its own account mid-session
// (`/login` mid-session is broken — stuck 401). The reliable, macOS-safe way to
// run multiple Claude accounts is `claude setup-token` (long-lived OAuth token,
// ~1yr) selected at launch via the ANTHROPIC_AUTH_TOKEN env var (see TOKEN_ENV).
// This module stores one token per named account and builds the exact relaunch
// command to switch.
//
// WHY ANTHROPIC_AUTH_TOKEN AND NOT CLAUDE_CODE_OAUTH_TOKEN
// Despite the docs, Claude Code ≥2.1.x gives the Keychain subscription login
// PRECEDENCE OVER `CLAUDE_CODE_OAUTH_TOKEN` (verified empirically: an invalid
// CLAUDE_CODE_OAUTH_TOKEN + a valid Keychain login still authenticates via the
// Keychain). The shared macOS Keychain item ("Claude Code-credentials") is the
// same for every account, so the per-account token was being silently ignored —
// every session ran on whatever `/login` last wrote, and a stale Keychain login
// surfaced as `401 → Please run /login`. `ANTHROPIC_AUTH_TOKEN` sits ABOVE the
// Keychain in the auth-precedence order, so it actually overrides the login
// WITHOUT requiring `/login`/logout, and launches that bypass us fall back to the
// Keychain gracefully (still authenticated) instead of hard-failing. The setup-
// token (`sk-ant-oat01-…`) is a Bearer token, accepted as ANTHROPIC_AUTH_TOKEN.
// NOTE: usage still draws on the token's subscription (it is a subscription OAuth
// token, not an API key) — validate billing in a real session if in doubt.
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
// Env var used to inject a per-account token at launch. ANTHROPIC_AUTH_TOKEN
// (auth-precedence item 2) overrides the Keychain subscription login (item 6);
// CLAUDE_CODE_OAUTH_TOKEN (item 5) does NOT on Claude Code ≥2.1.x. See the header
// note. Single source of truth — change here to re-route every launch path.
const TOKEN_ENV = 'ANTHROPIC_AUTH_TOKEN';

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

function tokenSubcommand(name) {
  return wrapperOnPath() ? `forge-accounts token ${name}` : `node '${scriptPath()}' --token ${name}`;
}

// First candidate command resolvable on PATH, else null (cross-platform which).
function firstOnPath(cands) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  for (const c of cands) {
    try { execFileSync(probe, [c], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}

function launchCommand(name) {
  return `FORGE_ACCOUNT=${name} ${TOKEN_ENV}="$(${tokenSubcommand(name)})" claude`;
}

// Single-quote for safe interpolation into a /bin/sh script.
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Open a NEW terminal window already on <name>, resuming /forge-auto when the cwd
// is a forge project (else a bare claude). macOS-only (uses osascript). The token
// is fetched live inside the launcher (never written to disk or the AppleScript).
// Lets you switch without exiting the current session — a fresh window appears.
// Set FORGE_NEW_WINDOW_DRYRUN=1 to print what would run instead of opening it.
function openNewTerminal(name) {
  assertName(name);
  if (!readToken(name)) throw new Error(`sem token para '${name}' — rode 'add ${name}'`);
  const projectDir = process.cwd();
  // Run-aware: resume the active run only when there is exactly one (see
  // forgeAutoArgsFor). Otherwise a normal session — no forced /forge-auto.
  const autoArgs = forgeAutoArgsFor(projectDir);
  const resume   = autoArgs.length > 0;
  const runId    = resume ? autoArgs[0].split(' ')[1] : null;
  const plat     = process.platform;
  const dryrun   = !!process.env.FORGE_NEW_WINDOW_DRYRUN;

  if (plat === 'darwin' || plat === 'linux') {
    const claudeCmd = resume ? `claude ${shq(autoArgs[0])}` : 'claude';
    const launcher  = path.join(os.tmpdir(), `forge-switch-${name}-${process.pid}.sh`);
    const body = [
      '#!/usr/bin/env bash',
      `cd ${shq(projectDir)} || exit 1`,
      `export FORGE_ACCOUNT=${shq(name)}`,
      `export ${TOKEN_ENV}="$(${tokenSubcommand(name)})"`,
      `rm -f -- ${shq(launcher)}`,
      `exec ${claudeCmd}`,
      '',
    ].join('\n');

    if (plat === 'darwin') {
      const term = process.env.TERM_PROGRAM || '';
      const osa = term === 'iTerm.app'
        ? [['-e', `tell application "iTerm" to create window with default profile command "bash ${launcher}"`]]
        : [['-e', `tell application "Terminal" to do script "bash ${launcher}"`],
           ['-e', 'tell application "Terminal" to activate']];
      if (dryrun) return { dryrun: true, projectDir, resume, runId, launcherBody: body, opener: ['osascript', ...osa.flat()] };
      fs.writeFileSync(launcher, body, { mode: 0o700 });
      execFileSync('osascript', osa.flat());
      return { dryrun: false, projectDir, resume, runId };
    }

    // linux: first available terminal emulator
    const emu = firstOnPath(['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']);
    if (!emu) throw new Error('nenhum terminal gráfico encontrado — use o comando do --print');
    const opener = emu === 'gnome-terminal' ? [emu, '--', 'bash', launcher] : [emu, '-e', `bash ${launcher}`];
    if (dryrun) return { dryrun: true, projectDir, resume, runId, launcherBody: body, opener };
    fs.writeFileSync(launcher, body, { mode: 0o700 });
    execFileSync(opener[0], opener.slice(1));
    return { dryrun: false, projectDir, resume, runId };
  }

  if (plat === 'win32') {
    const winq       = (s) => `"${String(s)}"`;
    const claudeArgs = resume ? winq(autoArgs[0]) : '';
    const launcher   = path.join(os.tmpdir(), `forge-switch-${name}-${process.pid}.cmd`);
    const body = [
      '@echo off',
      `cd /d ${winq(projectDir)}`,
      `for /f "usebackq delims=" %%t in (\`node ${winq(scriptPath())} --token ${name}\`) do set "${TOKEN_ENV}=%%t"`,
      `set "FORGE_ACCOUNT=${name}"`,
      `claude ${claudeArgs}`.trim(),
      'del "%~f0"',
      '',
    ].join('\r\n');
    const wt = firstOnPath(['wt.exe', 'wt']);
    const opener = wt ? [wt, 'new-tab', 'cmd', '/c', launcher] : ['cmd', '/c', 'start', '', 'cmd', '/c', launcher];
    if (dryrun) return { dryrun: true, projectDir, resume, runId, launcherBody: body, opener };
    fs.writeFileSync(launcher, body);
    execFileSync(opener[0], opener.slice(1));
    return { dryrun: false, projectDir, resume, runId };
  }

  throw new Error(`--new-window não suportado em ${plat} — use o comando do --print`);
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

// ── Shell integration ─────────────────────────────────────────────────────────
// Emits a `claude` shell function (zsh/bash) that auto-attaches the registry-active
// account's token at launch. Account selection only happens at process-launch time
// (a running session can't swap its own account — see CLAUDE.md), so a plain
// `claude` would otherwise fall back to the default Keychain login. Wired into the
// rc by the installer:  eval "$(forge-accounts shell-init)"
// Guards keep it inert when it shouldn't act:
//   • ANTHROPIC_AUTH_TOKEN already set   → respect `forge-accounts use`/`forge-run`
//                                          (or a user's own gateway token)
//   • FORGE_NO_AUTO_ACCOUNT=1            → escape hatch (use the default login once)
//   • forge-accounts not on PATH         → plain `claude`, no error
// Calls the `forge-accounts` wrapper (on PATH) — no hardcoded node paths — so it
// stays portable across machines and survives `/forge-update`.
function shellInit() {
  return [
    '# >>> forge-accounts shell-init >>>',
    '# Auto-attaches a Claude account to `claude` (the default, or `--account <name>`',
    '# for a one-off / parallel terminal). Managed by Forge. Opt out per launch:',
    '#   FORGE_NO_AUTO_ACCOUNT=1 claude',
    'claude() {',
    '  if [ -n "${FORGE_NO_AUTO_ACCOUNT:-}" ] || ! command -v forge-accounts >/dev/null 2>&1; then',
    '    command claude "$@"; return $?',
    '  fi',
    '  local _fa_acct="" _fa_a',
    '  local _fa_args; _fa_args=()',
    '  while [ "$#" -gt 0 ]; do',
    '    _fa_a="$1"',
    '    case "$_fa_a" in',
    '      --account) _fa_acct="${2:-}"; shift 2 2>/dev/null || shift ;;',
    '      --account=*) _fa_acct="${_fa_a#--account=}"; shift ;;',
    '      *) _fa_args+=("$_fa_a"); shift ;;',
    '    esac',
    '  done',
    `  if [ -n "\${${TOKEN_ENV}:-}" ] && [ -z "$_fa_acct" ]; then`,
    '    command claude "${_fa_args[@]}"; return $?',
    '  fi',
    '  local _fa_prep _fa_name _fa_tok',
    '  _fa_prep="$(forge-accounts launch-prep $_fa_acct 2>/dev/null)"',
    '  _fa_name="${_fa_prep%% *}"',
    '  _fa_tok="${_fa_prep#* }"',
    '  if [ -n "$_fa_name" ] && [ -n "$_fa_tok" ] && [ "$_fa_name" != "$_fa_tok" ]; then',
    `    FORGE_ACCOUNT="$_fa_name" ${TOKEN_ENV}="$_fa_tok" command claude "\${_fa_args[@]}"`,
    '    return $?',
    '  fi',
    '  command claude "${_fa_args[@]}"',
    '}',
    '# <<< forge-accounts shell-init <<<',
  ].join('\n') + '\n';
}

// PowerShell equivalent of shellInit() for the Windows $PROFILE. Same guards and
// the same --account override; injects the token into the session env and removes
// it in a finally block so it never persists. Wired by install.ps1 via:
//   Invoke-Expression (& forge-accounts shell-init-pwsh | Out-String)
function shellInitPwsh() {
  return [
    '# >>> forge-accounts shell-init >>>',
    '# Auto-attaches the active Claude account to `claude`. Managed by Forge.',
    '# Opt out per launch:  $env:FORGE_NO_AUTO_ACCOUNT=1; claude',
    'function claude {',
    '  $real = (Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source',
    '  if (-not $real) { $real = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }',
    '  if (-not $real) { Write-Error "claude not found on PATH"; return }',
    '  if ($env:FORGE_NO_AUTO_ACCOUNT -or -not (Get-Command forge-accounts -ErrorAction SilentlyContinue)) { & $real @args; return }',
    '  $acct = $null; $passthru = @()',
    '  for ($i = 0; $i -lt $args.Count; $i++) {',
    "    if ($args[$i] -eq '--account') { $acct = $args[$i+1]; $i++ }",
    "    elseif ($args[$i] -like '--account=*') { $acct = $args[$i].Substring(10) }",
    '    else { $passthru += $args[$i] }',
    '  }',
    `  if ($env:${TOKEN_ENV} -and -not $acct) { & $real @passthru; return }`,
    "  $prepArgs = @('launch-prep'); if ($acct) { $prepArgs += $acct }",
    '  $prep = (& forge-accounts @prepArgs 2>$null)',
    '  if ($prep) {',
    "    $parts = $prep.Trim() -split ' ', 2",
    '    if ($parts.Count -eq 2 -and $parts[0] -and $parts[1]) {',
    `      $env:FORGE_ACCOUNT = $parts[0]; $env:${TOKEN_ENV} = $parts[1]`,
    '      try { & $real @passthru }',
    `      finally { Remove-Item Env:${TOKEN_ENV} -ErrorAction SilentlyContinue; Remove-Item Env:FORGE_ACCOUNT -ErrorAction SilentlyContinue }`,
    '      return',
    '    }',
    '  }',
    '  & $real @passthru',
    '}',
    '# <<< forge-accounts shell-init <<<',
  ].join('\n') + '\n';
}

// ── Logged-in identity (~/.claude.json) ──────────────────────────────────────
// Claude Code stores the active subscription login here (oauthAccount). Its
// statusline JSON does NOT include the account, so for sessions launched WITHOUT
// FORGE_ACCOUNT (plain Keychain login) we read this file and match it to a
// registered account for the 👤 badge. Tolerant — missing/garbage → all null.
function readClaudeIdentity() {
  try {
    const j  = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const oa = j.oauthAccount || {};
    return { uuid: oa.accountUuid || null, email: oa.emailAddress || null, display: oa.displayName || null };
  } catch { return { uuid: null, email: null, display: null }; }
}

// Find the registered account name whose stored identity matches uuid (preferred)
// or email. Returns null when nothing matches.
function matchAccount(reg, ident) {
  if (!ident) return null;
  const accts = Object.entries(reg.accounts || {});
  if (ident.uuid) {
    const m = accts.find(([, a]) => a.account_uuid && a.account_uuid === ident.uuid);
    if (m) return m[0];
  }
  if (ident.email) {
    const e = String(ident.email).toLowerCase();
    const m = accts.find(([, a]) => a.email && String(a.email).toLowerCase() === e);
    if (m) return m[0];
  }
  return null;
}

// Best-effort: stamp uuid/email onto <name>. Anti-clobber: when not forced, refuse
// if that uuid already belongs to a DIFFERENT account — this guards the case where
// a token-launch did NOT rewrite ~/.claude.json (so it still shows the Keychain
// identity, which must not be recorded under the launched account). A `manual`
// value is never overwritten by a probe.
function recordIdentity(name, ident, opts) {
  const force = !!(opts && opts.force);
  if (!name || !ident || (!ident.uuid && !ident.email)) return false;
  const reg = loadRegistry();
  const a = reg.accounts[name];
  if (!a) return false;
  if (!force && ident.uuid) {
    const owner = matchAccount(reg, { uuid: ident.uuid });
    if (owner && owner !== name) return false;
  }
  if (a.email_source === 'manual' && !force) return false;
  let changed = false;
  if (ident.uuid  && a.account_uuid !== ident.uuid)  { a.account_uuid = ident.uuid;  changed = true; }
  if (ident.email && a.email        !== ident.email) { a.email        = ident.email; changed = true; }
  if (changed) { a.email_source = force ? 'manual' : 'probed'; saveRegistry(reg); }
  return changed;
}

function setEmail(name, email, uuid) {
  assertName(name);
  const reg = loadRegistry();
  if (!reg.accounts[name]) throw new Error(`account '${name}' not registered (run --add ${name} first)`);
  const a = reg.accounts[name];
  if (email && email !== true) a.email = String(email);
  if (uuid  && uuid  !== true) a.account_uuid = String(uuid);
  a.email_source = 'manual';
  saveRegistry(reg);
  return { name, email: a.email || null, uuid: a.account_uuid || null };
}

// Set the persistent default account WITHOUT launching anything (the `default`
// subcommand). `use` keeps doing default+launch; `launch` does launch only.
function setDefault(name) {
  assertName(name);
  const reg = loadRegistry();
  if (!reg.accounts[name]) throw new Error(`account '${name}' not registered (run --add ${name} first)`);
  if (!readToken(name)) throw new Error(`no token stored for '${name}' — re-run --add ${name}`);
  reg.active = name;
  reg.accounts[name].last_used = nowIso();
  saveRegistry(reg);
  return name;
}

// Resolve which account to launch on: explicit name, else the registry default.
// Returns { name, token } or null when there is nothing usable.
function resolveLaunch(name) {
  const reg = loadRegistry();
  const target = (name && name !== true) ? assertName(name) : reg.active;
  if (!target) return null;
  const token = readToken(target);
  if (!token) return null;
  return { name: target, token };
}

// Run-aware: resume the auto ONLY when exactly one run is active in this project.
// 0 active → normal session; 2+ active → ambiguous, normal session (user picks).
// Returns [] (bare claude) or ['/forge-auto <RUN_ID>'].
function forgeAutoArgsFor(cwd) {
  try {
    const runs = require('./forge-runs.js');
    const active = runs.listActive(cwd);
    if (active.length === 1 && active[0] && active[0].id) return [`/forge-auto ${active[0].id}`];
  } catch { /* no runs registry / not a forge project → bare */ }
  return [];
}

// Switch in place: launch claude in the current terminal on <name>, resuming the
// active run when there is exactly one. FORGE_ACCOUNT tags the session; the token
// goes via env only (never argv). Exits the process with claude's status.
function spawnClaudeOnAccount(name) {
  const { spawnSync } = require('child_process');
  const tok = readToken(name);
  if (!tok) throw new Error(`no token stored for '${name}' — re-run --add ${name}`);
  const args = forgeAutoArgsFor(process.cwd());
  process.stderr.write(`\nIniciando Claude Code na conta '${name}'…\n`);
  const r = spawnSync('claude', args, {
    stdio: 'inherit',
    env: { ...process.env, FORGE_ACCOUNT: name, [TOKEN_ENV]: tok },
  });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new Error("comando 'claude' não encontrado no PATH");
    throw new Error(`falha ao lançar claude: ${r.error.message}`);
  }
  process.exit(typeof r.status === 'number' ? r.status : 0);
}

// Shared launch decision for both `use` (after setDefault) and `launch` (no default
// change). forcePrint → emit the relaunch command; forceWindow OR non-TTY → open a
// new terminal window (falls back to printing the command if no windowing method);
// TTY → switch in place.
function launchOrEmit(name, opts) {
  const forceWindow = !!(opts && opts.forceWindow);
  const forcePrint  = !!(opts && opts.forcePrint);
  assertName(name);
  if (!readToken(name)) throw new Error(`no token stored for '${name}' — re-run --add ${name}`);
  if (forcePrint) { process.stdout.write(launchCommand(name) + '\n'); return; }
  if (forceWindow || !process.stdout.isTTY) {
    try {
      const r = openNewTerminal(name);
      if (r.dryrun) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return; }
      process.stdout.write(
        `nova janela de Terminal aberta na conta '${name}'` +
        (r.resume ? ` — retomando /forge-auto ${r.runId}.` : '.') + '\n');
    } catch {
      process.stdout.write(launchCommand(name) + '\n');
    }
    return;
  }
  spawnClaudeOnAccount(name);
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

// Headroom-aware variant (opt-in via --by-usage). Among cooldown-eligible
// accounts, pick the one with the LOWEST 7-day utilization, read live from each
// account's token via forge-usage-poll.fetchUsage (the unified-* headers). This
// is the real "use all accounts" selector — it drains the freshest account
// first instead of the cooldown approximation noted above. Falls back to the
// cooldown-based nextAccount() on any failure (poll module absent, all polls
// fail, ≤1 eligible), so it never regresses. Costs ~9 tokens per polled account,
// only at a rotation boundary.
async function nextAccountByUsage(cooldownsFile) {
  let fetchUsage;
  try { ({ fetchUsage } = require(path.join(__dirname, 'forge-usage-poll.js'))); }
  catch { return nextAccount(cooldownsFile); }

  const reg = loadRegistry();
  const cds = readCooldowns(cooldownsFile);
  const nowS = Math.floor(Date.now() / 1000);
  const tokenAccts = Object.keys(reg.accounts).filter((n) => !!readToken(n));
  const eligible = tokenAccts.filter((n) => {
    const cd = cds[n];
    return !(cd && cd.resets_at && cd.resets_at > nowS);
  });
  if (eligible.length <= 1) return nextAccount(cooldownsFile);

  const scored = await Promise.all(eligible.map(async (n) => {
    const usage = await fetchUsage(readToken(n));
    const u7 = (usage && usage.seven_day && typeof usage.seven_day.used_percentage === 'number')
      ? usage.seven_day.used_percentage : null;
    return { name: n, u7 };
  }));
  const reachable = scored.filter((s) => s.u7 !== null);
  if (!reachable.length) return nextAccount(cooldownsFile);
  reachable.sort((a, b) => a.u7 - b.u7);
  return { account: reachable[0].name, wait_until: null, by: 'usage', util_7d: Math.round(reachable[0].u7) };
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

// Subcommand → flag normalizer. The bash wrapper (bin/forge-accounts) already emits
// flag form, so on Unix argv[0] starts with '--' and this is a no-op. It exists so a
// trivial pass-through wrapper (Windows forge-accounts.cmd → `node engine %*`) accepts
// the same `forge-accounts <sub> <name> ...` ergonomics without batch translation.
const SUBCOMMANDS = new Set([
  'add', 'list', 'current', 'use', 'default', 'launch', 'launch-prep', 'launch-cmd',
  'token', 'rename', 'remove', 'set-email', 'shell-init', 'shell-init-pwsh',
  'next-account', 'mark-cooldown',
]);
const NAME_SUBS = new Set(['add', 'use', 'default', 'launch', 'launch-prep', 'launch-cmd', 'token', 'remove', 'set-email', 'mark-cooldown']);
function normalizeSubcommandArgv(argv) {
  if (!argv.length || argv[0].startsWith('--')) return argv; // already flag form
  const sub = argv[0];
  if (!SUBCOMMANDS.has(sub)) return argv;                     // unknown → let dispatch error
  const rest = argv.slice(1);
  const out = [`--${sub}`];
  let i = 0;
  if (sub === 'rename') {
    if (rest[0]) out.push(rest[0]);
    if (rest[1]) { out.push('--to', rest[1]); i = 2; } else i = rest[0] ? 1 : 0;
  } else {
    if (NAME_SUBS.has(sub) && rest[0] !== undefined && !rest[0].startsWith('--')) { out.push(rest[0]); i = 1; }
    if (sub === 'set-email' && rest[i] !== undefined && !rest[i].startsWith('--')) { out.push('--email', rest[i]); i++; }
  }
  for (; i < rest.length; i++) out.push(rest[i]);
  return out;
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
  --current [--json] [--name]                   show active account (registry + env);
                                                --name prints just the active name
  --shell-init                                  emit a claude() shell function (zsh/bash)
                                                that auto-attaches the default account
                                                (or "claude --account <name>") at launch.
                                                rc: eval "$(forge-accounts shell-init)"
  --shell-init-pwsh                             same, as a PowerShell function for $PROFILE
  --launch-prep [name]                          print "<name> <token>" for the resolved
                                                account (default if none) — used by shell-init
  --default <name>                              set the persistent default WITHOUT launching
  --use <name> [--new-window] [--print]         set default AND switch to it. TTY → launch
                                                claude here; --new-window (or no TTY) → open
                                                a NEW terminal window (macOS/Windows/Linux),
                                                resuming the active run if exactly one;
                                                --print → just emit the relaunch command
  --launch <name> [--new-window] [--print]      launch/open on an account WITHOUT changing
                                                the default — parallel terminals, N accounts
  --set-email <name> [--email <addr>] [--uuid <u>]  record the account's identity (for the
                                                statusline 👤 on plain Keychain logins);
                                                no --email → captures THIS session's login
  --launch-cmd <name>                           print relaunch command only
  --token <name>                                print the raw token (for $( ) substitution)
  --rename <old> --to <new>                     rename an account (keeps the token)
  --remove <name>                               delete account + its token
  --next-account [--cooldowns <file>] [--by-usage]  print {account,wait_until} for
                                                the supervisor. Default: most-rested
                                                eligible. --by-usage: lowest 7d
                                                utilization (polls each, ~9 tok/acct)
  --mark-cooldown <name> [--resets-at <epoch>] --cooldowns <file>
                                                record that <name> is exhausted
  --help                                        show this help

Switch accounts (cannot happen mid-session — relaunch claude):
  ${`FORGE_ACCOUNT=<name> ${TOKEN_ENV}="$(node forge-accounts.js --token <name>)" claude`}

Get a token once per account with:  claude setup-token
`;

function cliMain() {
  const args = parseArgs(normalizeSubcommandArgv(process.argv.slice(2)));
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

    } else if ('shell-init' in args) {
      process.stdout.write(shellInit());

    } else if ('current' in args) {
      const data = currentAccount();
      // --name → just the registry-active account, bare (for the shell-init function)
      if (args.name) { if (data.registry_active) process.stdout.write(data.registry_active + '\n'); return; }
      if (args.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return; }
      process.stdout.write(`registry: ${data.registry_active || '(none)'}\nsession : ${data.env_active || '(default login)'}\n`);

    } else if ('use' in args) {
      // use = set the persistent default AND launch on it (run-aware via launchOrEmit)
      const name = assertName(args.use);
      setDefault(name);
      launchOrEmit(name, { forceWindow: 'new-window' in args, forcePrint: 'print' in args });

    } else if ('default' in args) {
      // set the persistent default only — does NOT launch anything
      const name = setDefault(args.default);
      process.stdout.write(`default account → '${name}'\n`);

    } else if ('launch' in args) {
      // launch/open on an account WITHOUT changing the default — enables parallel
      // terminals on different accounts (the multi-terminal model)
      const name = assertName(args.launch);
      launchOrEmit(name, { forceWindow: 'new-window' in args, forcePrint: 'print' in args });

    } else if ('launch-prep' in args) {
      // single-call resolver for the shell-init function: prints "<name> <token>"
      // (default account when no name given), or nothing when unusable.
      const name = (typeof args['launch-prep'] === 'string') ? args['launch-prep'] : null;
      const r = resolveLaunch(name);
      if (r) process.stdout.write(`${r.name} ${r.token}\n`);

    } else if ('set-email' in args) {
      const name = assertName(args['set-email']);
      let email = (typeof args.email === 'string') ? args.email : null;
      let uuid  = (typeof args.uuid  === 'string') ? args.uuid  : null;
      if (!email && !uuid) {
        // No explicit value → capture the CURRENT session's logged-in identity.
        // Safe because the user is asserting "I'm on <name> right now".
        const ident = readClaudeIdentity();
        email = ident.email; uuid = ident.uuid;
        if (!email && !uuid) {
          throw new Error('não consegui ler a identidade logada (~/.claude.json) — passe --email <addr> explicitamente');
        }
      }
      const r = setEmail(name, email, uuid);
      process.stdout.write(`identity for '${r.name}': ${r.email || '(no email)'}${r.uuid ? ` [${r.uuid}]` : ''}\n`);

    } else if ('shell-init-pwsh' in args) {
      process.stdout.write(shellInitPwsh());

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
      if ('by-usage' in args) {
        // Async headroom-aware pick; the pending network I/O keeps the event
        // loop alive until stdout is written. Any failure → cooldown-based pick.
        nextAccountByUsage(f)
          .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
          .catch(() => process.stdout.write(JSON.stringify(nextAccount(f)) + '\n'));
      } else {
        process.stdout.write(JSON.stringify(nextAccount(f)) + '\n');
      }

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
  launchCommand, daysLeft, assertName, shellInit, shellInitPwsh,
  setDefault, resolveLaunch, launchOrEmit, spawnClaudeOnAccount, forgeAutoArgsFor,
  setEmail, recordIdentity, matchAccount, readClaudeIdentity, openNewTerminal,
  nextAccount, nextAccountByUsage, markCooldown, readCooldowns,
  REGISTRY_FILE, TOKENS_FILE,
};

if (require.main === module) cliMain();
