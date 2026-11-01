#!/usr/bin/env node
'use strict';

// Opt-in installation of the read-only VS Code panel into the default profile
// of the stable VS Code CLI. The panel outcome is always reported beside the
// core and never throws: a panel failure cannot turn an applied core into a
// failed install, and nothing short of a verified listing counts as success.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vsix = require('./forge-vscode-package.js');
const { resolveExecutable } = require('./forge-capabilities.js');
const { plainText } = require('./forge-sidecar-identity.js');

const STATE_FILE = 'components.json';
const STATE_SCHEMA = 1;
const STATE_LIMIT = 4096;
const TARGET = 'vscode-stable-default-profile';
const REQUESTS = Object.freeze(['opt-in', 'opt-out']);
const REASONS = Object.freeze({
  'not-requested': [null],
  'opted-out': ['flag', 'state'],
  deferred: ['already-installed'],
  planned: ['dry-run'],
  installed: [null, 'state-write-failed'],
  unchanged: [null],
  'cli-missing': ['not-on-path'],
  incompatible: ['variant-not-stable', 'remote-cli', 'portable-mode', 'version-unparsable', 'engine-minimum'],
  'cli-failed': ['exit-nonzero', 'timeout', 'spawn-error', 'output-limit', 'unsafe-argument', 'cleanup-unverified', 'autorun-unverified'],
  'verify-failed': ['not-listed', 'version-mismatch', 'list-failed', 'internal-error'],
  'package-invalid': [...new Set([...vsix.BUILD_REASONS, ...vsix.VERIFY_REASONS, 'staged-mismatch'])],
  'state-invalid': ['unreadable', 'malformed', 'link', 'backup-failed'],
  'source-unsupported': ['compat-bootstrap', 'remote-without-panel'],
});
const STATUSES = Object.freeze(Object.keys(REASONS));
const VERIFIED = Object.freeze(['installed', 'unchanged']);
const NOTICES = Object.freeze(['not-requested', 'opted-out', 'deferred', 'planned', 'installed', 'unchanged']);
const REPORT_KEYS = Object.freeze(['status', 'reason', 'verified', 'requested', 'opted_in', 'target', 'extension', 'version',
  'vsix_sha256', 'cli_version', 'dry_run', 'detail']);
const TIMEOUTS = Object.freeze({ version: 30000, list: 30000, install: 180000 });
const MAX_BUFFER = 1024 * 1024;
const DETAIL_LIMIT = 240;
// Redirection variables are removed from the child only: an integrated
// terminal's IPC hook or an extensions override would retarget the install.
const CHILD_ENV_REMOVED = Object.freeze(['VSCODE_IPC_HOOK_CLI', 'VSCODE_EXTENSIONS', 'VSCODE_PORTABLE', 'VSCODE_APPDATA', 'VSCODE_DEV']);
const VERSION_ARGS = Object.freeze(['--version']);
const LIST_ARGS = Object.freeze(['--list-extensions', '--show-versions']);
const UNINSTALL_HINT = `code --uninstall-extension ${vsix.EXTENSION_ID}`;
const SEMVER = /^\d+\.\d+\.\d+$/;
const DIGEST = /^[a-f0-9]{64}$/;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function compareSemver(left, right) {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function panelReport(status, reason = null, fields = {}) {
  if (!STATUSES.includes(status) || !REASONS[status].includes(reason)) throw new Error(`vscode-panel: status inválido ${status}/${reason}`);
  return {
    status, reason, verified: VERIFIED.includes(status),
    requested: REQUESTS.includes(fields.requested) ? fields.requested : null,
    opted_in: typeof fields.opted_in === 'boolean' ? fields.opted_in : null,
    target: TARGET, extension: vsix.EXTENSION_ID,
    version: fields.version || null, vsix_sha256: fields.vsix_sha256 || null, cli_version: fields.cli_version || null,
    dry_run: Boolean(fields.dry_run),
    detail: fields.detail ? plainText(fields.detail, { missing: null, limit: DETAIL_LIMIT }) : null,
  };
}

// ── State ──────────────────────────────────────────────────────────────────
function statePath(forgeHome) { return path.join(forgeHome, STATE_FILE); }

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validState(value) {
  if (!exactKeys(value, ['schema_version', 'vscode_panel']) || value.schema_version !== STATE_SCHEMA) return false;
  const panel = value.vscode_panel;
  if (!exactKeys(panel, ['opted_in', 'target', 'since_version', 'installed'])) return false;
  if (typeof panel.opted_in !== 'boolean' || panel.target !== TARGET || typeof panel.since_version !== 'string' || !SEMVER.test(panel.since_version)) return false;
  if (panel.installed === null) return true;
  return exactKeys(panel.installed, ['version', 'vsix_sha256']) && typeof panel.installed.version === 'string'
    && SEMVER.test(panel.installed.version) && typeof panel.installed.vsix_sha256 === 'string' && DIGEST.test(panel.installed.vsix_sha256);
}

function readState(forgeHome) {
  const file = statePath(forgeHome);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { ok: true, state: null, reason: null };
    return { ok: false, state: null, reason: 'unreadable' };
  }
  if (stat.isSymbolicLink()) return { ok: false, state: null, reason: 'link' };
  if (!stat.isFile() || stat.size > STATE_LIMIT) return { ok: false, state: null, reason: 'unreadable' };
  let text;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(STATE_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length > STATE_LIMIT) return { ok: false, state: null, reason: 'unreadable' };
    text = buffer.subarray(0, length).toString('utf8');
  } catch (_) { return { ok: false, state: null, reason: 'unreadable' }; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* already closed */ } }
  let value;
  try { value = JSON.parse(text); } catch (_) { return { ok: false, state: null, reason: 'malformed' }; }
  if (!validState(value)) return { ok: false, state: null, reason: 'malformed' };
  return { ok: true, state: value, reason: null };
}

function stateValue(optedIn, sinceVersion, installed) {
  return { schema_version: STATE_SCHEMA, vscode_panel: { opted_in: optedIn, target: TARGET, since_version: sinceVersion, installed: installed || null } };
}

// Same temp+rename discipline as normalizeCompatManifest; the rename replaces
// a planted link entry instead of writing through it.
function writeState(forgeHome, value, plan, options = {}) {
  if (!validState(value)) throw new Error('vscode-panel: estado inválido para gravação');
  const file = statePath(forgeHome);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  plan.push({ op: 'write', destination: file, bytes: Buffer.byteLength(text) });
  if (options.dryRun) return;
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) { /* best effort */ }
    throw error;
  }
}

// A regular state file is the only thing the update backup copies.
function backupCandidate(forgeHome) {
  const file = statePath(forgeHome);
  try { return fs.lstatSync(file).isFile() ? file : null; } catch (_) { return null; }
}

// ── Detection ──────────────────────────────────────────────────────────────
function defaultIsFile(file) { try { return fs.statSync(file).isFile(); } catch (_) { return false; } }
function defaultIsDirectory(file) { try { return fs.statSync(file).isDirectory(); } catch (_) { return false; } }

function refused(status, reason, extra = {}) { return { ok: false, status, reason, layout: null, ...extra }; }

// Pure layout rule over an already resolved real path. Only the stable
// product layouts are accepted; everything else is an explicit diagnosis.
function classifyCli(file, options = {}) {
  const platform = options.platform || process.platform;
  const isFile = options.isFile || defaultIsFile;
  const isDirectory = options.isDirectory || defaultIsDirectory;
  const env = options.env || {};
  const p = platform === 'win32' ? path.win32 : path.posix;
  const normalized = p.normalize(String(file || ''));
  const segments = normalized.split(p.sep).filter(Boolean).map(part => part.toLowerCase());
  if (segments.some(part => part === '.vscode-server' || part === '.vscode-server-insiders' || part === 'remote-cli')
    || (platform === 'win32' && /^\\\\wsl(?:\$|\.localhost)\\/i.test(normalized))
    || (platform !== 'win32' && normalized.startsWith('/mnt/'))) return refused('incompatible', 'remote-cli');
  let layout = null;
  let portableData = null;
  if (platform === 'win32') {
    const bin = p.dirname(normalized);
    const product = p.dirname(bin);
    if (p.basename(normalized).toLowerCase() === 'code.cmd' && p.basename(bin).toLowerCase() === 'bin' && isFile(p.join(product, 'Code.exe'))) {
      layout = 'win32-stable';
      portableData = p.join(product, 'data');
    }
  } else if (platform === 'darwin') {
    const suffix = '/Visual Studio Code.app/Contents/Resources/app/bin/code';
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      const app = normalized.slice(0, normalized.length - '/Contents/Resources/app/bin/code'.length);
      layout = 'darwin-stable';
      portableData = p.join(p.dirname(app), 'code-portable-data');
    }
  } else if (!normalized.startsWith('/snap/')) {
    const bin = p.dirname(normalized);
    const product = p.dirname(bin);
    if (p.basename(normalized) === 'code' && p.basename(bin) === 'bin' && isFile(p.join(product, 'code'))) {
      layout = 'linux-stable';
      portableData = p.join(product, 'data');
    }
  }
  if (!layout) return refused('incompatible', 'variant-not-stable');
  // Portable data overrides the default profile storage, so it is never the
  // default-profile target even when the layout is the stable product.
  if (typeof env.VSCODE_PORTABLE === 'string' && env.VSCODE_PORTABLE.trim() !== '') return refused('incompatible', 'portable-mode', { layout });
  if (isDirectory(portableData)) return refused('incompatible', 'portable-mode', { layout });
  return { ok: true, status: null, reason: null, layout, file: normalized };
}

// ── Bounded invocation ─────────────────────────────────────────────────────
function safeArgument(value, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return typeof value === 'string' && value !== '' && p.isAbsolute(value) && !/["%!^&|<>\x00-\x1f\x7f]/.test(value);
}

function frozenArgs(args) {
  if (!Array.isArray(args)) return false;
  if (args.length === 1) return args[0] === VERSION_ARGS[0];
  if (args.length === 2) return args[0] === LIST_ARGS[0] && args[1] === LIST_ARGS[1];
  return args.length === 3 && args[0] === '--install-extension' && args[2] === '--force' && typeof args[1] === 'string';
}

function childEnv(env) {
  const copy = { ...(env || {}) };
  for (const key of Object.keys(copy)) if (CHILD_ENV_REMOVED.includes(key.toUpperCase())) delete copy[key];
  return copy;
}

function windowsCommand(cli, args) {
  return [`"${cli}"`, ...args.map(arg => (arg.startsWith('--') ? arg : `"${arg}"`))].join(' ');
}

function outcome(result, windows) {
  const stdout = result && result.stdout !== undefined && result.stdout !== null ? String(result.stdout) : '';
  const stderr = result && result.stderr !== undefined && result.stderr !== null ? String(result.stderr) : '';
  const detail = (stderr.trim() || stdout.trim() || (result && result.error && result.error.message) || '').slice(0, 4096);
  const fail = reason => ({ ok: false, reason, stdout, stderr, detail });
  // Without a joined owned job the next CLI step must not start.
  if (windows && (!result || !result.cleanup || result.cleanup.status !== 'joined' || result.cleanup.active_processes !== 0)) return fail('cleanup-unverified');
  if (windows && result.cleanup.autorun_disabled !== true) return fail('autorun-unverified');
  if (result && result.error) {
    const code = result.error.code;
    return fail(code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOBUFS' ? 'output-limit' : 'spawn-error');
  }
  if (!result || result.status !== 0) return fail('exit-nonzero');
  return { ok: true, reason: null, stdout, stderr, detail };
}

function runCli(cli, args, options = {}) {
  const platform = options.platform || process.platform;
  if (!frozenArgs(args) || !safeArgument(cli, platform) || args.some(arg => !arg.startsWith('--') && !safeArgument(arg, platform))) {
    return { ok: false, reason: 'unsafe-argument', stdout: '', stderr: '', detail: '' };
  }
  const env = childEnv(options.env || process.env);
  const timeout = options.timeout || TIMEOUTS.version;
  if (platform === 'win32') {
    // code.cmd needs cmd.exe; the owned Job runner proves the whole tree ended.
    const runner = options.windowsRunner || require('./forge-verification-process.js').runWindowsCommand;
    let result;
    try { result = runner(windowsCommand(cli, args), { cwd: path.win32.dirname(cli), env, timeoutMs: timeout, disableAutoRun: true }); }
    catch (error) { result = { error, cleanup: null }; }
    return outcome(result, true);
  }
  let result;
  try {
    result = (options.spawnSync || spawnSync)(cli, [...args], {
      cwd: path.posix.dirname(cli), env, timeout, maxBuffer: MAX_BUFFER, stdio: 'pipe', windowsHide: true, shell: false, encoding: 'utf8',
    });
  } catch (error) { result = { error }; }
  return outcome(result, false);
}

function detectCli(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const resolve = options.resolve || ((value, target) => resolveExecutable('code', { env: value, platform: target }));
  const realpath = options.realpath || (file => fs.realpathSync.native(file));
  let found = null;
  try { found = resolve(env, platform); } catch (_) { found = null; }
  if (!found) return refused('cli-missing', 'not-on-path');
  let real;
  try { real = realpath(found); } catch (_) { return refused('cli-missing', 'not-on-path'); }
  const classified = classifyCli(real, { platform, env, isFile: options.isFile, isDirectory: options.isDirectory });
  if (!classified.ok) return classified;
  if (!safeArgument(classified.file, platform)) return refused('cli-failed', 'unsafe-argument', { layout: classified.layout });
  const run = runCli(classified.file, [...VERSION_ARGS], { ...options, platform, env, timeout: TIMEOUTS.version });
  if (!run.ok) return refused('cli-failed', run.reason, { layout: classified.layout, detail: run.detail });
  const first = run.stdout.split(/\r?\n/)[0].trim();
  if (!SEMVER.test(first)) return refused('incompatible', 'version-unparsable', { layout: classified.layout, detail: first });
  return { ok: true, status: null, reason: null, layout: classified.layout, cli: classified.file, cli_version: first };
}

function parseExtensions(stdout) {
  const list = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^([a-z0-9-]+\.[a-z0-9-]+)@(\d+\.\d+\.\d+)$/i.exec(line.trim());
    if (match) list.push({ id: match[1].toLowerCase(), version: match[2] });
  }
  return list;
}

function listedVersion(stdout) {
  const entry = parseExtensions(stdout).find(item => item.id === vsix.EXTENSION_ID);
  return entry ? entry.version : null;
}

// ── Apply ──────────────────────────────────────────────────────────────────
function applySteps(input, context) {
  const { forgeHome, version, repo } = input;
  const plan = input.plan || [];
  const dryRun = Boolean(input.dryRun);
  const request = input.request || null;
  const platform = input.platform || process.platform;
  const env = input.env || process.env;
  const fields = extra => ({ requested: request, dry_run: dryRun, ...extra });
  if (request !== null && !REQUESTS.includes(request)) throw new Error(`vscode-panel: pedido inválido ${JSON.stringify(request)}`);
  const read = readState(forgeHome);
  // An unreadable opt-in is never guessed; only an explicit flag replaces it.
  if (!read.ok && !request) return panelReport('state-invalid', read.reason, fields({}));
  const current = read.ok ? read.state : null;
  const previous = current ? current.vscode_panel.installed : null;
  if (request === 'opt-out') {
    if (!current || current.vscode_panel.opted_in !== false) writeState(forgeHome, stateValue(false, version, previous), plan, { dryRun });
    return panelReport('opted-out', 'flag', fields({ opted_in: false, detail: `remoção manual: ${UNINSTALL_HINT}` }));
  }
  if (!request && !current) return panelReport('not-requested', null, fields({ opted_in: false }));
  if (!request && !current.vscode_panel.opted_in) return panelReport('opted-out', 'state', fields({ opted_in: false, detail: `remoção manual: ${UNINSTALL_HINT}` }));
  context.optedIn = true;
  let built;
  try { built = vsix.buildVsix({ repo, version }); }
  catch (error) {
    if (error && error.code === 'package-invalid') return panelReport('package-invalid', error.reason, fields({ opted_in: true, detail: error.message }));
    throw error;
  }
  context.version = built.version;
  context.sha = built.sha256;
  const known = extra => fields({ opted_in: true, version: built.version, vsix_sha256: built.sha256, ...extra });
  const fresh = !current || !current.vscode_panel.opted_in;
  const install = { op: 'vscode-panel-install', command: 'code', args: ['--install-extension', built.file_name, '--force'], destination: `vscode:${vsix.EXTENSION_ID}@${built.version}` };
  let state = fresh ? stateValue(true, version, previous) : current;
  if (dryRun) {
    if (fresh) writeState(forgeHome, state, plan, { dryRun: true });
    plan.push({ ...install, dry_run: true });
    return panelReport('planned', 'dry-run', known({}));
  }
  if (fresh) writeState(forgeHome, state, plan);
  // Refuse a hostile staging root before any CLI process is started.
  const stagingRoot = path.resolve(input.stagingRoot || os.tmpdir());
  if (!safeArgument(path.join(stagingRoot, 'forge-vscode-panel-XXXXXX', built.file_name), platform)) {
    return panelReport('cli-failed', 'unsafe-argument', known({ detail: 'diretório temporário com caractere recusado' }));
  }
  const cliOptions = { platform, env, spawnSync: input.spawnSync, windowsRunner: input.windowsRunner, resolve: input.resolve,
    realpath: input.realpath, isFile: input.isFile, isDirectory: input.isDirectory };
  const detected = detectCli(cliOptions);
  if (!detected.ok) return panelReport(detected.status, detected.reason, known({ cli_version: detected.cli_version, detail: detected.detail }));
  context.cliVersion = detected.cli_version;
  const cli = extra => known({ cli_version: detected.cli_version, ...extra });
  if (compareSemver(detected.cli_version, built.engine_minimum) < 0) {
    return panelReport('incompatible', 'engine-minimum', cli({ detail: `VS Code ${detected.cli_version} < ${built.engine_minimum}` }));
  }
  const before = runCli(detected.cli, [...LIST_ARGS], { ...cliOptions, timeout: TIMEOUTS.list });
  if (!before.ok) return panelReport('cli-failed', before.reason, cli({ detail: before.detail }));
  const record = state.vscode_panel.installed;
  if (listedVersion(before.stdout) === built.version && record && record.version === built.version && record.vsix_sha256 === built.sha256) {
    return panelReport('unchanged', null, cli({}));
  }
  context.staging = fs.mkdtempSync(path.join(stagingRoot, 'forge-vscode-panel-'));
  const file = path.join(context.staging, vsix.fileName(built.version));
  if (!safeArgument(file, platform)) return panelReport('cli-failed', 'unsafe-argument', cli({ detail: 'diretório temporário com caractere recusado' }));
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, built.bytes, 0, built.bytes.length, 0); } finally { fs.closeSync(fd); }
  if (typeof input.onStaged === 'function') input.onStaged(file);
  // Install exactly the verified bytes: re-read right before the CLI sees them.
  const staged = fs.readFileSync(file);
  if (sha256(staged) !== built.sha256 || !vsix.verifyVsix(staged, { sha256: built.sha256, version: built.version }).ok) {
    return panelReport('package-invalid', 'staged-mismatch', cli({}));
  }
  plan.push(install);
  const installed = runCli(detected.cli, ['--install-extension', file, '--force'], { ...cliOptions, timeout: TIMEOUTS.install });
  if (!installed.ok) return panelReport('cli-failed', installed.reason, cli({ detail: installed.detail }));
  // Exit 0 alone proves nothing; the listing must show the exact version.
  const after = runCli(detected.cli, [...LIST_ARGS], { ...cliOptions, timeout: TIMEOUTS.list });
  if (!after.ok) {
    return after.reason === 'cleanup-unverified' || after.reason === 'unsafe-argument'
      ? panelReport('cli-failed', after.reason, cli({ detail: after.detail }))
      : panelReport('verify-failed', 'list-failed', cli({ detail: after.detail }));
  }
  const now = listedVersion(after.stdout);
  if (now === null) return panelReport('verify-failed', 'not-listed', cli({}));
  if (now !== built.version) return panelReport('verify-failed', 'version-mismatch', cli({ detail: `listado ${now}` }));
  state = { ...state, vscode_panel: { ...state.vscode_panel, installed: { version: built.version, vsix_sha256: built.sha256 } } };
  try { writeState(forgeHome, state, plan); }
  catch (error) { return panelReport('installed', 'state-write-failed', cli({ detail: error.message })); }
  return panelReport('installed', null, cli({}));
}

function applyPanel(input = {}) {
  const context = { optedIn: null, version: null, sha: null, cliVersion: null, staging: null };
  try { return applySteps(input, context); }
  catch (error) {
    return panelReport('verify-failed', 'internal-error', {
      requested: input.request, dry_run: input.dryRun, opted_in: context.optedIn === true ? true : undefined,
      version: context.version, vsix_sha256: context.sha, cli_version: context.cliVersion, detail: error && error.message,
    });
  } finally {
    if (context.staging) try { fs.rmSync(context.staging, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* best effort */ }
  }
}

// The already_installed shortcut reports the recorded choice without the CLI.
function panelSummary(forgeHome) {
  const read = readState(forgeHome);
  if (!read.ok) return panelReport('state-invalid', read.reason, {});
  if (!read.state) return panelReport('not-requested', null, { opted_in: false });
  const panel = read.state.vscode_panel;
  if (!panel.opted_in) return panelReport('opted-out', 'state', { opted_in: false, detail: `remoção manual: ${UNINSTALL_HINT}` });
  return panelReport('deferred', 'already-installed', { opted_in: true, version: panel.installed && panel.installed.version,
    vsix_sha256: panel.installed && panel.installed.vsix_sha256 });
}

function sourceUnsupported(reason, options = {}) {
  return panelReport('source-unsupported', reason, { requested: options.requested, opted_in: options.opted_in });
}

function renderPanelLines(panel) {
  if (!panel || !STATUSES.includes(panel.status)) return [];
  const id = `${vsix.EXTENSION_ID}@${panel.version || '?'}`;
  switch (panel.status) {
    case 'installed': return [`Painel VS Code: installed — ${id} no perfil padrão do VS Code estável (recarregue a janela)`]
      .concat(panel.reason ? [`  aviso: estado de adesão não gravado (${panel.reason}); a próxima execução reinstala`] : []);
    case 'unchanged': return [`Painel VS Code: unchanged — ${id} já verificado`];
    case 'planned': return [`Painel VS Code: planned — instalaria ${id} (sha256 ${String(panel.vsix_sha256 || '').slice(0, 12)}); nada executado`];
    case 'not-requested': return ['Painel VS Code: not-requested (use --with-vscode-panel para aderir)'];
    case 'opted-out': return [`Painel VS Code: opted-out — atualizações do painel desativadas; remoção manual: ${UNINSTALL_HINT}`];
    case 'deferred': return ['Painel VS Code: deferred (already-installed) — use --update ou --with-vscode-panel'];
    default: return [`⚠ Painel VS Code NÃO verificado: ${panel.status} (${panel.reason}) — ${panel.dry_run ? 'núcleo apenas planejado (dry-run)' : 'núcleo aplicado'}; detalhe: ${panel.detail || '-'}`];
  }
}

// Read-only probe: no staging, no install, no path in the output.
function detect(options = {}) {
  const detected = detectCli(options);
  const report = { status: detected.ok ? 'detected' : detected.status, reason: detected.ok ? null : detected.reason,
    layout: detected.layout || null, cli_version: detected.cli_version || null, installed_version: null };
  if (!detected.ok) return report;
  const listed = runCli(detected.cli, [...LIST_ARGS], { ...options, platform: options.platform || process.platform, timeout: TIMEOUTS.list });
  if (!listed.ok) return { ...report, status: 'cli-failed', reason: listed.reason };
  return { ...report, installed_version: listedVersion(listed.stdout) };
}

function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  let json = false; let probe = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--detect') probe = true;
    else if (arg === '--help' || arg === '-h') { output('Usage: forge-vscode-install.js --detect [--json]\n'); return 0; }
    else { errorOutput(`forge-vscode-install: opção desconhecida: ${arg}\n`); return 2; }
  }
  if (!probe) { errorOutput('forge-vscode-install: use --detect (somente leitura); a instalação acontece pelo forge-update\n'); return 2; }
  const report = detect();
  output(json ? `${JSON.stringify(report)}\n`
    : `VS Code: ${report.status}${report.reason ? ` (${report.reason})` : ''}; layout ${report.layout || '-'}; versão ${report.cli_version || '-'}; painel ${report.installed_version || 'ausente'}\n`);
  return 0;
}

module.exports = {
  STATE_FILE, STATE_SCHEMA, STATE_LIMIT, TARGET, STATUSES, REASONS, REPORT_KEYS, NOTICES, TIMEOUTS, MAX_BUFFER, CHILD_ENV_REMOVED, UNINSTALL_HINT,
  panelReport, statePath, readState, writeState, backupCandidate, classifyCli, safeArgument, childEnv, windowsCommand, runCli, detectCli,
  parseExtensions, applyPanel, panelSummary, sourceUnsupported, renderPanelLines, detect, main,
};
if (require.main === module) process.exitCode = main();
