#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const capabilities = require('./forge-capabilities');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const { sha256 } = require('./forge-delivery');

const ROOT = path.resolve(__dirname, '..');
const MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
const REEXECUTE = 'node scripts/forge-panel-probe.js --mount --json';
const MOUNT_KEYS = ['schema_version', 'version', 'app_name', 'app_host', 'ui_kind', 'extension_found',
  'extension_active', 'container_revealed', 'view_visible', 'synthetic_nodes', 'reason'];
const MECHANISM = Object.freeze({ view: 'TreeView', container: 'View Container', location: 'activity bar',
  process: 'local extension host', webview: false, server_required: false, listener: 'none', hosting: 'none', network: false });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : 'unknown';
const allowedId = value => typeof value === 'string' && /^(?:openai|anthropic)\.[a-z0-9][a-z0-9-]*$/i.test(value);

function readJson(file) {
  const real = fs.realpathSync.native(file);
  if (fs.lstatSync(file).isSymbolicLink() || path.resolve(file) !== real) throw new Error('input-link');
  const read = readBoundedStableFile(real, MAX_BYTES, { expectedReal: real });
  if (read.error) throw new Error(read.error);
  return { value: JSON.parse(read.buffer.toString('utf8').replace(/^\uFEFF/, '')), buffer: read.buffer };
}

function executable(kind, options = {}) {
  const override = options[kind];
  let command = override?.command || override || kind;
  // Account-switching PowerShell wrappers are not the native Claude build.
  if (!override && kind === 'claude' && process.platform === 'win32') {
    const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fs.existsSync(native)) command = native;
  }
  return { file: capabilities.resolveExecutable(command, { env: options.env || process.env }),
    prefix: Array.isArray(override?.args) ? override.args : [] };
}

function observeCommand(target, args, options = {}) {
  const started = Date.now();
  if (!target.file) return { status: null, error_code: 'executable-unavailable', stdout: '', stderr: '', duration_ms: 0 };
  const result = capabilities.invoke(target.file, [...target.prefix, ...args], {
    cwd: options.cwd || ROOT, env: options.env || process.env, timeout: options.timeoutMs || 15000,
  });
  return { status: result.status, error_code: result.error?.code || null,
    stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - started };
}

function commandEvidence(command, result) {
  return { command, exit_code: result.status, duration_ms: result.duration_ms,
    output_sha256: sha256(result.stdout || ''), stderr_sha256: sha256(result.stderr || ''), error_code: result.error_code || null };
}

function nativeMountTarget(target, platform = process.platform) {
  if (!target.file || target.prefix.length || platform !== 'win32' || path.basename(target.file).toLowerCase() !== 'code.cmd') {
    return { ...target, launcher: target.prefix.length ? 'injected-test-executable' : 'code-cli' };
  }
  const launcher = readBoundedStableFile(target.file, 16384, { expectedReal: fs.realpathSync.native(target.file) });
  const text = launcher.buffer?.toString('utf8') || '';
  // Recognize the installed distribution's fixed layout; never execute parsed script text.
  if (!/set ELECTRON_RUN_AS_NODE=1/i.test(text) || !text.includes('"%~dp0..\\Code.exe"')) return { ...target, launcher: 'code-cli' };
  const gui = capabilities.resolveExecutable(path.resolve(path.dirname(target.file), '..', 'Code.exe'));
  return gui ? { file: gui, prefix: [], launcher: 'installed-gui-executable' } : { ...target, launcher: 'code-cli' };
}

function extensionRows(values) {
  const rows = [];
  for (const value of values) {
    const id = value.id || value.identifier?.id;
    if (!allowedId(id) || version(value.version) === 'unknown') continue;
    if (!rows.some(row => row.id === id.toLowerCase() && row.version === value.version)) rows.push({ id: id.toLowerCase(), version: value.version });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
}

function identify(options = {}) {
  const target = executable('code', options);
  const result = observeCommand(target, ['--version'], options);
  const lines = result.stdout.trim().split(/\r?\n/);
  const build = lines.findIndex(line => version(line.trim()) !== 'unknown');
  const valid = result.status === 0 && build >= 0;
  const listing = observeCommand(target, ['--list-extensions', '--show-versions'], options);
  const rows = extensionRows(listing.status === 0 ? listing.stdout.split(/\r?\n/).map(line => {
    const [id, value] = line.trim().split('@'); return { id, version: value };
  }) : []);
  const sources = [{ source: 'code --list-extensions --show-versions', status: listing.status === 0 ? 'inspected' : 'unknown' }];
  const metadata = options.extensionsMetadata === false ? null : options.extensionsMetadata || path.join(os.homedir(), '.vscode', 'extensions', 'extensions.json');
  if (metadata) {
    try {
      const data = readJson(metadata).value;
      if (!Array.isArray(data)) throw new Error('metadata-shape');
      rows.push(...extensionRows(data));
      sources.push({ source: 'default extensions metadata', status: 'inspected' });
    } catch (_) { sources.push({ source: 'default extensions metadata', status: 'unknown' }); }
  }
  const extensions = extensionRows(rows);
  const codex = extensions.find(row => row.id.startsWith('openai.')) || null;
  const env = options.env || process.env;
  const term = typeof env.TERM_PROGRAM === 'string' && /^[\w.-]{1,60}$/.test(env.TERM_PROGRAM) ? env.TERM_PROGRAM : 'unknown';
  const termVersion = typeof env.TERM_PROGRAM_VERSION === 'string' ? version(env.TERM_PROGRAM_VERSION) : 'unknown';
  return { client: { product: 'Visual Studio Code', version: valid ? version(lines[build].trim()) : 'unknown',
    commit: valid && /^[a-f0-9]{40}$/i.test(lines[build + 1]?.trim()) ? lines[build + 1].trim() : 'unknown',
    architecture: valid && /^(x64|arm64|ia32)$/.test(lines[build + 2]?.trim()) ? lines[build + 2].trim() : 'unknown',
    source: 'code --version', terminal: { program: term, version: termVersion }, mounted_instance: null,
    consistency: 'unknown', evidence: commandEvidence('code --version', result) },
  codex_surface: { status: codex ? 'found' : sources.some(row => row.status === 'inspected') ? 'not-found-in-inspected-profiles' : 'unknown',
    extension: codex, extensions, sources, operator_declaration: 'Codex no VS Code primeiro',
    limit: 'A enumeração não cobre outros perfis nem componentes internos.' },
  extension_evidence: commandEvidence('code --list-extensions --show-versions', listing) };
}

function mountShape(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === MOUNT_KEYS.length && MOUNT_KEYS.every(key => Object.hasOwn(value, key))
    && value.schema_version === 1 && version(value.version) !== 'unknown'
    && typeof value.app_name === 'string' && /^[\p{L}\d .()+-]{1,80}$/u.test(value.app_name)
    && ['desktop', 'web'].includes(value.app_host) && [1, 2].includes(value.ui_kind)
    && ['extension_found', 'extension_active', 'container_revealed', 'view_visible'].every(key => typeof value[key] === 'boolean')
    && Number.isSafeInteger(value.synthetic_nodes) && value.synthetic_nodes >= 0 && value.synthetic_nodes <= 10000
    && ['observed', 'extension-missing', 'extension-observation-failed'].includes(value.reason);
}

function mounted(value) {
  return value.extension_found && value.extension_active && value.container_revealed && value.view_visible && value.synthetic_nodes > 0;
}

// Only process identities/relationships carrying this invocation's unique root are retained.
// No process table or raw command line is returned or published.
function processCensus() {
  const powershell = capabilities.resolveExecutable('powershell');
  if (process.platform !== 'win32' || !powershell) return null;
  const result = capabilities.invoke(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress'], { timeout: 10000 });
  if (result.error || result.status !== 0) return null;
  try { const value = JSON.parse(result.stdout); return Array.isArray(value) ? value : [value]; } catch (_) { return null; }
}

function ownsRootArgument(commandLine, root) {
  const normalize = value => value.replace(/\\/g, '/').toLowerCase();
  const allowed = [root, ...['user-data', 'extensions', 'workspace'].map(name => path.join(root, name))].map(normalize);
  const args = String(commandLine || '').match(/(?:[^\s"]|"[^"]*")+/g) || [];
  return args.some(arg => allowed.includes(normalize(arg.replace(/"/g, '')
    .replace(/^--(?:user-data-dir|extensions-dir)=/, ''))));
}

function trackProcesses(rows, root, tracked) {
  if (!Array.isArray(rows)) return false;
  const valid = [];
  for (const row of rows) {
    const identity = Number.isSafeInteger(row?.ProcessId) && row.ProcessId > 0
      && Number.isSafeInteger(row.ParentProcessId) && row.ParentProcessId >= 0 && typeof row.CreationDate === 'string' && row.CreationDate;
    if (identity) valid.push(row);
    else if (ownsRootArgument(row?.CommandLine, root) || tracked.has(row?.ProcessId)) return false;
  }
  rows = valid;
  const owned = new Set();
  for (const row of rows) {
    if (ownsRootArgument(row.CommandLine, root)) owned.add(row.ProcessId);
    if (tracked.get(row.ProcessId) === row.CreationDate) owned.add(row.ProcessId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (owned.has(row.ParentProcessId) && !owned.has(row.ProcessId)) { owned.add(row.ProcessId); changed = true; }
  }
  for (const row of rows) if (owned.has(row.ProcessId)) tracked.set(row.ProcessId, row.CreationDate);
  return rows.filter(row => owned.has(row.ProcessId));
}

function safeOwnedTree(root) {
  const temp = fs.realpathSync.native(os.tmpdir());
  if (path.dirname(root) !== temp || !/^forge-vscode-probe-[A-Za-z0-9]+$/.test(path.basename(root))) return false;
  function inspect(current) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || fs.realpathSync.native(current) !== path.resolve(current)) return false;
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) if (!inspect(path.join(current, name))) return false;
    return true;
  }
  try { return inspect(root); } catch (_) { return false; }
}

async function cleanup(root, exited, options = {}) {
  const marker = path.basename(root);
  if (!exited) return { status: 'pending', reason: 'process-exit-unconfirmed', marker };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!safeOwnedTree(root)) return { status: 'pending', reason: 'ownership-or-link-check-failed', marker };
    try {
      (options.remove || fs.rmSync)(root, { recursive: true, force: false });
      return { status: 'removed', reason: 'owned-tree-exited', marker };
    } catch (_) { if (attempt < 3) await delay(100); }
  }
  return { status: 'pending', reason: 'remove-failed', marker };
}

function mountDiagnostics(root, result, resultIssue) {
  const buffers = [Buffer.from(result.stdout || ''), Buffer.from(result.stderr || '')];
  let files = 0, omitted = 0;
  if (safeOwnedTree(root)) {
    const logs = path.join(root, 'user-data', 'logs');
    function collect(directory, depth) {
      if (depth > 6 || !fs.existsSync(directory)) return;
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name);
        if (fs.lstatSync(file).isDirectory()) collect(file, depth + 1);
        else if (name.endsWith('.log')) {
          if (files >= 24) { omitted++; continue; }
          const read = readBoundedStableFile(file, 128 * 1024, { expectedReal: file });
          if (read.error) { omitted++; continue; }
          buffers.push(read.buffer); files++;
        }
      }
    }
    collect(logs, 0);
  }
  const text = Buffer.concat(buffers).toString('utf8');
  const patterns = { 'extension-disabled': /extension[^\n]{0,100}disabled/gi,
    'runner-failed': /(?:extension tests runner|extensionTestsPath|mount-result-[a-z-]+|mount-probe\.js)/g,
    'extension-activation-failed': /(?:activat[^\n]{0,80}(?:fail|error)|cannot find module)/gi,
    'unknown-argument': /(?:unknown|unrecognized)[^\n]{0,30}(?:argument|option)/gi,
    'launch-error': /(?:Error:|\bENOENT\b|\bEACCES\b|\bEPERM\b)/g,
    'vscode-update-in-progress': /vscode-updating|checkInnoSetupMutex|Code is being updated/gi };
  const counts = Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, [...text.matchAll(pattern)].length]));
  return { result_channel: resultIssue, log_files: files, omitted_files: omitted,
    combined_sha256: sha256(Buffer.concat(buffers)), counts,
    classification: counts['vscode-update-in-progress'] > 0 ? 'host-environment' : 'unknown' };
}

async function mount(options = {}) {
  const target = nativeMountTarget(executable('code', options));
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-vscode-probe-'));
  const resultFile = path.join(root, 'mount-result.json');
  const profile = path.join(root, 'user-data');
  const extensions = path.join(root, 'extensions');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.mkdirSync(extensions); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false, 'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none', 'workbench.enableExperiments': false,
  }));
  const args = ['--user-data-dir', profile, '--extensions-dir', extensions, '--disable-extensions',
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', '--wait',
    `--extensionDevelopmentPath=${path.join(ROOT, 'extensions', 'forge-vscode')}`,
    `--extensionTestsPath=${path.join(ROOT, 'extensions', 'forge-vscode', 'test', 'mount-probe.js')}`, workspace];
  const command = `${target.launcher === 'installed-gui-executable' ? 'Code.exe' : 'code'} --user-data-dir <owned-temp>/user-data --extensions-dir <owned-temp>/extensions --disable-extensions --disable-workspace-trust --skip-welcome --skip-release-notes --new-window --wait --extensionDevelopmentPath=extensions/forge-vscode --extensionTestsPath=extensions/forge-vscode/test/mount-probe.js <owned-temp>/workspace`;
  const env = { ...(options.env || process.env), FORGE_VSCODE_MOUNT_RESULT: resultFile };
  // Do not inherit an IDE IPC hook: the development profile must start a separate instance.
  delete env.VSCODE_IPC_HOOK_CLI;
  delete env.VSCODE_INJECTION;
  delete env.VSCODE_CLI;
  if (target.launcher === 'installed-gui-executable') delete env.ELECTRON_RUN_AS_NODE;
  const census = options.processCensus || processCensus;
  const tracked = new Map();
  let observable = true;
  let sawProcess = false;
  const sample = () => {
    const live = trackProcesses(census(), root, tracked);
    if (live === false) observable = false;
    else if (live.length) sawProcess = true;
    return live;
  };
  let result;
  const started = Date.now();
  if (!target.file) result = { status: null, error_code: 'executable-unavailable', stdout: '', stderr: '', duration_ms: 0 };
  else {
    let finished = false;
    const worker = new Worker(__filename, { workerData: { target, args, options: { cwd: options.cwd || ROOT, env, timeoutMs } } });
    const workerExit = new Promise(resolve => worker.once('exit', resolve));
    const invocation = new Promise(resolve => {
      worker.once('message', value => { finished = true; resolve(value); });
      worker.once('error', () => { finished = true; resolve({ status: null, error_code: 'invoker-failed', stdout: '', duration_ms: Date.now() - started }); });
    });
    while (!finished) { sample(); await Promise.race([invocation, delay(options.pollMs || 500)]); }
    result = await invocation;
    await workerExit;
  }
  let observed = null;
  let resultHash = null;
  let resultIssue = 'missing';
  try {
    if (fs.realpathSync.native(path.dirname(resultFile)) !== root) throw new Error('result-root-changed');
    const read = readJson(resultFile);
    resultIssue = 'shape-invalid';
    if (!mountShape(read.value)) throw new Error('result-shape');
    observed = read.value; resultHash = sha256(read.buffer);
    resultIssue = 'valid';
  } catch (_) { /* No valid result channel means unknown, never absence of support. */ }
  let live = sample();
  // Never kill the operator instance. Only this root's observed process identities qualify.
  if (Array.isArray(live) && live.length && result.error_code === 'ETIMEDOUT') {
    for (const row of live.filter(row => ownsRootArgument(row.CommandLine, root))) {
      const fresh = sample();
      if (Array.isArray(fresh) && fresh.some(item => item.ProcessId === row.ProcessId && item.CreationDate === row.CreationDate)) {
        capabilities.invoke('taskkill.exe', ['/PID', String(row.ProcessId), '/T', '/F'], { timeout: 5000 });
      }
    }
  }
  for (let attempt = 0; Array.isArray(live) && live.length && attempt < 10; attempt++) { await delay(250); live = sample(); }
  // A successful CLI alone does not prove descendant exit. Missing/unavailable census retains the root.
  const exited = !target.file || (observable && sawProcess && Array.isArray(live) && live.length === 0);
  const diagnostics = mountDiagnostics(root, result, resultIssue);
  diagnostics.private_capture = options.onObservation ? 'failed' : 'not-requested';
  if (options.onObservation) {
    try {
      await options.onObservation({ root, result, resultFile, diagnostics });
      diagnostics.private_capture = 'saved';
    } catch (_) { /* Cleanup still runs after an operational evidence-write failure. */ }
  }
  const clean = await cleanup(root, exited, options);
  const outcome = result.error_code || !observed ? 'unknown' : mounted(observed) && result.status === 0 ? 'mounted' : 'not-mounted';
  return { result: outcome, reason: result.error_code ? (result.error_code === 'ETIMEDOUT' ? 'timeout' : 'launch-failed')
    : diagnostics.counts['vscode-update-in-progress'] > 0 && result.status !== 0 ? 'vscode-update-in-progress'
      : !observed ? 'result-channel-unavailable' : outcome === 'mounted' ? 'all-mount-conditions-observed' : 'mount-condition-failed',
    evidence: { ...commandEvidence(command, result), result_sha256: resultHash, timeout_ms: timeoutMs, observed,
      process_exit: exited ? 'confirmed' : 'unknown', shell: false, launcher: target.launcher }, diagnostics, cleanup: clean, reexecute: REEXECUTE };
}

function scanLiteral(file) {
  let descriptor;
  try {
    const real = fs.realpathSync.native(file);
    descriptor = fs.openSync(real, 'r');
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > 512 * MAX_BYTES) return 'unknown';
    const buffer = Buffer.alloc(64 * 1024);
    let tail = Buffer.alloc(0), read, found = false;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      const block = Buffer.concat([tail, buffer.subarray(0, read)]);
      if (block.includes(Buffer.from('subagentStatusLine'))) found = true;
      tail = block.subarray(Math.max(0, block.length - 32));
    }
    const after = fs.fstatSync(descriptor);
    return before.size === after.size && before.mtimeMs === after.mtimeMs ? found ? 'found' : 'not-found' : 'unknown';
  } catch (_) { return 'unknown'; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function claude(options = {}) {
  const target = executable('claude', options);
  const result = observeCommand(target, ['--version'], options);
  const match = result.status === 0 ? result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/) : null;
  const doc = readJson(path.join(ROOT, 'docs', 'host-compatibility-2026-10-28.evidence.json')).value.sources.find(row => row.id === 'claude-statusline');
  const entrypoint = options.claudeEntrypoint || (target.file && /\.(?:exe|js)$/i.test(target.file) ? target.file : null);
  return { version: match ? version(match[0]) : 'unknown', evidence: commandEvidence('claude --version', result),
    subagent_statusline: { documented: true, documentation: doc.url, documentation_sha256: doc.sha256,
      static_reference: entrypoint ? scanLiteral(entrypoint) : 'unknown', method: 'bounded-local-stream-512MiB',
      runtime_display: 'unknown', runtime_phase: 'S03' }, panel_required: false };
}

function gate(mechanism, observation) {
  const required = observation.result === 'not-mounted' || mechanism.server_required !== false || mechanism.listener !== 'none' || mechanism.hosting !== 'none';
  return { required, question_id: required ? 'g1_panel_surface' : null,
    reason: required ? 'functional-surface-decision' : observation.result === 'unknown' ? 'C05-pending-observation' : 'local-mechanism-mounted',
    question: required ? { id: 'g1_panel_surface', text: 'Qual alternativa de superfície deve orientar o painel após o diagnóstico da montagem?',
      options: [{ id: 'repair-local-tree', label: 'Manter TreeView local (recomendado)', consequence: 'Investigar a incompatibilidade e preservar o alvo VS Code.' },
        { id: 'replan-surface', label: 'Replanejar a superfície', consequence: 'Requer decisão explícita de escopo antes da S05; nenhum hosting é autorizado.' }] } : null };
}

function record(observations) {
  const { identification, mounting, claudeTerminal } = observations;
  const client = { ...identification.client, mounted_instance: mounting.evidence.observed ? {
    version: mounting.evidence.observed.version, app_name: mounting.evidence.observed.app_name,
    app_host: mounting.evidence.observed.app_host, ui_kind: mounting.evidence.observed.ui_kind } : null };
  client.consistency = client.version === 'unknown' || !client.mounted_instance ? 'unknown'
    : client.version === client.mounted_instance.version ? 'same-version' : 'different-version';
  return { schema_version: 1, captured_at: new Date().toISOString(), client, codex_surface: identification.codex_surface,
    extension_evidence: identification.extension_evidence, mechanism: { ...MECHANISM }, mount: mounting, claude_terminal: claudeTerminal,
    subagent_surfaces: [
      { host: 'codex-cli', documented: '/subagents e navegação entre threads', observed: 'unknown' },
      { host: 'codex-vscode', documented: 'sidebar da extensão IDE; agentes em background condicionais ao cliente', observed: 'unknown' },
      { host: 'claude-terminal', documented: 'subagentes e subagentStatusLine', observed: 'static-only' },
    ], g1: gate(MECHANISM, mounting), acceptance: { visual_uat: 'pending-final-round' },
    observation_origin: 'direct-local-probes', criterion_c05: mounting.result === 'mounted' ? 'runtime-mounted-visual-pending' : 'pending' };
}

function validateRecord(value, options = {}) {
  const problems = [];
  const check = (condition, reason) => { if (!condition) problems.push(reason); };
  check(value && typeof value === 'object' && value.schema_version === 1, 'schema-invalid');
  if (!value || typeof value !== 'object') return { valid: false, problems };
  const shapes = [
    [value, ['schema_version', 'captured_at', 'client', 'codex_surface', 'extension_evidence', 'mechanism', 'mount', 'claude_terminal', 'subagent_surfaces', 'g1', 'acceptance', 'observation_origin', 'criterion_c05'], ['previous_mount_attempts']],
    [value.client, ['product', 'version', 'commit', 'architecture', 'source', 'terminal', 'mounted_instance', 'consistency', 'evidence']],
    [value.client?.terminal, ['program', 'version']],
    [value.codex_surface, ['status', 'extension', 'extensions', 'sources', 'operator_declaration', 'limit']],
    [value.mechanism, Object.keys(MECHANISM)],
    [value.mount, ['result', 'reason', 'evidence', 'diagnostics', 'cleanup', 'reexecute']],
    [value.mount?.cleanup, ['status', 'reason', 'marker']],
    [value.claude_terminal, ['version', 'evidence', 'subagent_statusline', 'panel_required']],
    [value.claude_terminal?.subagent_statusline, ['documented', 'documentation', 'documentation_sha256', 'static_reference', 'method', 'runtime_display', 'runtime_phase']],
    [value.acceptance, ['visual_uat']],
  ];
  for (const [row, required, optional = []] of shapes) {
    check(row && typeof row === 'object' && !Array.isArray(row) && required.every(key => Object.hasOwn(row, key))
      && Object.keys(row).every(key => required.includes(key) || optional.includes(key)), 'record-shape-invalid');
  }
  check(typeof value.captured_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.captured_at)
    && Number.isFinite(Date.parse(value.captured_at)) && value.observation_origin === 'direct-local-probes', 'capture-invalid');
  const text = JSON.stringify(value);
  check(!/\b[A-Za-z]:[\\/]|\\\\[^\\]|(?:^|["\s])\/(?!\/|subagents(?:\s|"))|\b(?:Users|home)[\\/]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(text), 'personal-or-absolute-path');
  const workspace = path.basename(options.cwd || ROOT);
  check(!text.toLowerCase().includes(workspace.toLowerCase()), 'workspace-name');
  check(value.client?.product === 'Visual Studio Code' && (value.client.version === 'unknown' || version(value.client.version) !== 'unknown')
    && /^(unknown|[a-f0-9]{40})$/i.test(value.client.commit) && ['unknown', 'x64', 'arm64', 'ia32'].includes(value.client.architecture), 'client-invalid');
  check(value.client?.source === 'code --version' && ['unknown', 'same-version', 'different-version'].includes(value.client.consistency), 'client-source-invalid');
  check(typeof value.client?.terminal?.program === 'string' && /^[\w.-]{1,60}$/.test(value.client.terminal.program)
    && (value.client.terminal.version === 'unknown' || version(value.client.terminal.version) !== 'unknown'), 'terminal-invalid');
  check(['found', 'not-found-in-inspected-profiles', 'unknown'].includes(value.codex_surface?.status), 'surface-invalid');
  check(Array.isArray(value.codex_surface?.extensions) && value.codex_surface.extensions.length <= 100
    && value.codex_surface.extensions.every(row => row && Object.keys(row).length === 2 && allowedId(row.id) && version(row.version) !== 'unknown'), 'extension-invalid');
  check(value.codex_surface?.extension === null || (allowedId(value.codex_surface?.extension?.id)
    && value.codex_surface.extension.id.startsWith('openai.') && version(value.codex_surface.extension.version) !== 'unknown'), 'codex-extension-invalid');
  check((value.codex_surface?.status === 'found') === Boolean(value.codex_surface?.extension), 'surface-incoherent');
  check(value.mechanism && Object.keys(MECHANISM).every(key => value.mechanism[key] === MECHANISM[key]), 'mechanism-invalid');
  const mount = value.mount;
  check(['mounted', 'not-mounted', 'unknown'].includes(mount?.result), 'mount-invalid');
  const evidence = mount?.evidence;
  const commandRows = [[value.client?.evidence, 'code --version'], [value.extension_evidence, 'code --list-extensions --show-versions'],
    [value.claude_terminal?.evidence, 'claude --version'], [evidence, evidence?.command]];
  for (const [row, command] of commandRows) {
    check(row && row.command === command && (row.exit_code === null || Number.isInteger(row.exit_code))
      && Number.isSafeInteger(row.duration_ms) && row.duration_ms >= 0 && /^[a-f0-9]{64}$/.test(row.output_sha256)
      && /^[a-f0-9]{64}$/.test(row.stderr_sha256) && (row.error_code === null || /^[A-Z_]{2,40}$|^(?:executable-unavailable|invoker-failed)$/.test(row.error_code)), 'command-evidence-invalid');
  }
  check(evidence && typeof evidence.command === 'string' && /^(?:code|Code\.exe) --user-data-dir <owned-temp>/.test(evidence.command)
    && (evidence.exit_code === null || Number.isInteger(evidence.exit_code)) && Number.isFinite(evidence.duration_ms) && evidence.duration_ms >= 0
    && /^[a-f0-9]{64}$/.test(evidence.output_sha256) && evidence.shell === false && Number.isSafeInteger(evidence.timeout_ms)
    && evidence.timeout_ms > 0 && evidence.timeout_ms <= 300000
    && ['code-cli', 'installed-gui-executable', 'injected-test-executable'].includes(evidence.launcher), 'mount-evidence-invalid');
  check(evidence?.observed === null || mountShape(evidence?.observed), 'mount-observation-invalid');
  const instance = value.client?.mounted_instance;
  check(evidence?.observed ? instance && Object.keys(instance).length === 4
    && instance.version === evidence.observed.version && instance.app_name === evidence.observed.app_name
    && instance.app_host === evidence.observed.app_host && instance.ui_kind === evidence.observed.ui_kind : instance === null, 'mounted-client-incoherent');
  const consistency = value.client?.version === 'unknown' || !instance ? 'unknown'
    : value.client.version === instance.version ? 'same-version' : 'different-version';
  check(value.client?.consistency === consistency, 'client-consistency-invalid');
  if (mount?.result !== 'unknown') {
    check(mountShape(evidence?.observed) && /^[a-f0-9]{64}$/.test(evidence?.result_sha256), 'mount-proof-missing');
    check(!evidence?.error_code, 'mount-proof-error');
    if (mount.result === 'mounted') check(evidence?.exit_code === 0 && mounted(evidence?.observed || {}), 'mounted-without-proof');
    if (mount.result === 'not-mounted') check(!mounted(evidence?.observed || {}) || evidence?.exit_code !== 0, 'not-mounted-incoherent');
  }
  check(mount?.reexecute === REEXECUTE && ['removed', 'pending'].includes(mount?.cleanup?.status)
    && (mount.cleanup.status !== 'removed' || evidence?.process_exit === 'confirmed' || evidence?.error_code === 'executable-unavailable'), 'cleanup-invalid');
  check(['confirmed', 'unknown'].includes(evidence?.process_exit) && /^forge-vscode-probe-[A-Za-z0-9]+$/.test(mount?.cleanup?.marker), 'cleanup-identity-invalid');
  const diag = mount?.diagnostics;
  check(diag && ['valid', 'shape-invalid', 'missing'].includes(diag.result_channel)
    && Number.isSafeInteger(diag.log_files) && diag.log_files >= 0 && diag.log_files <= 24
    && Number.isSafeInteger(diag.omitted_files) && diag.omitted_files >= 0 && /^[a-f0-9]{64}$/.test(diag.combined_sha256)
    && ['not-requested', 'saved', 'failed'].includes(diag.private_capture) && diag.counts
    && Object.keys(diag.counts).sort().join(',') === 'extension-activation-failed,extension-disabled,launch-error,runner-failed,unknown-argument,vscode-update-in-progress'
    && Object.values(diag.counts).every(count => Number.isSafeInteger(count) && count >= 0)
    && diag.classification === (diag.counts['vscode-update-in-progress'] > 0 ? 'host-environment' : 'unknown'), 'diagnostics-invalid');
  const statusline = value.claude_terminal?.subagent_statusline;
  check(value.claude_terminal && (value.claude_terminal.version === 'unknown' || version(value.claude_terminal.version) !== 'unknown')
    && statusline?.documented === true && /^[a-f0-9]{64}$/.test(statusline?.documentation_sha256)
    && ['found', 'not-found', 'unknown'].includes(statusline?.static_reference)
    && statusline?.runtime_display === 'unknown' && statusline?.runtime_phase === 'S03', 'claude-invalid');
  check(value.claude_terminal?.panel_required === false && statusline?.documentation === 'https://code.claude.com/docs/en/statusline.md'
    && statusline?.documentation_sha256 === 'a2391a0f4b8892bd32c0ea95d3d3d25f319c6891c963895ea0f2dd4c74150aa4'
    && statusline?.method === 'bounded-local-stream-512MiB', 'claude-source-invalid');
  check(Array.isArray(value.subagent_surfaces) && value.subagent_surfaces.length === 3 && value.subagent_surfaces.every(row => typeof row.documented === 'string' && ['unknown', 'static-only'].includes(row.observed)), 'subagents-invalid');
  check(value.acceptance?.visual_uat === 'pending-final-round', 'acceptance-invalid');
  check(JSON.stringify(value.g1) === JSON.stringify(gate(value.mechanism || {}, mount || {})), 'g1-incoherent');
  check(value.criterion_c05 === (mount?.result === 'mounted' ? 'runtime-mounted-visual-pending' : 'pending'), 'criterion-incoherent');
  if (value.previous_mount_attempts !== undefined) {
    check(Array.isArray(value.previous_mount_attempts) && value.previous_mount_attempts.length <= 2
      && value.previous_mount_attempts.every(row => row && Object.keys(row).length === 2 && typeof row.captured_at === 'string'
        && Number.isFinite(Date.parse(row.captured_at)) && ['mounted', 'not-mounted', 'unknown'].includes(row.mount?.result)
        && row.mount?.evidence && Number.isInteger(row.mount.evidence.exit_code) && /^[a-f0-9]{64}$/.test(row.mount.evidence.output_sha256)
        && typeof row.mount.evidence.command === 'string' && /^(?:code|Code\.exe) --user-data-dir <owned-temp>/.test(row.mount.evidence.command)
        && row.mount.reexecute === REEXECUTE), 'historical-attempt-invalid');
  }
  return { valid: problems.length === 0, problems };
}

function outputTarget(relative, cwd = ROOT) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /[\\:]|(?:^|\/)\.\.(?:\/|$)/.test(relative)) throw new Error('output-relative-required');
  const root = fs.realpathSync.native(cwd);
  const target = path.resolve(root, relative);
  const parent = fs.realpathSync.native(path.dirname(target));
  if (parent !== path.dirname(target) || !target.startsWith(root + path.sep) || (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())) throw new Error('output-outside-root');
  return target;
}

async function main(args, suppliedOptions = {}) {
  const modes = ['--identify', '--mount', '--claude', '--record', '--validate-record'];
  const selected = args.filter(arg => modes.includes(arg));
  if (selected.length !== 1 || args.some(arg => arg.startsWith('--') && ![...modes, '--json', '--out', '--timeout-ms'].includes(arg))) return 2;
  const mode = selected[0];
  const values = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (values.has(arg)) return 2;
    values.add(arg);
    if (['--out', '--timeout-ms', '--validate-record'].includes(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) return 2;
      index++;
    } else if (arg !== '--json' && !modes.includes(arg)) return 2;
  }
  if ((mode === '--record') !== args.includes('--out')) return 2;
  const options = { ...suppliedOptions };
  if (args.includes('--timeout-ms')) {
    const raw = args[args.indexOf('--timeout-ms') + 1];
    if (!/^\d+$/.test(raw || '') || Number(raw) < 100 || Number(raw) > 300000 || !['--mount', '--record'].includes(mode)) return 2;
    options.timeoutMs = Number(raw);
  }
  let result;
  if (mode === '--identify') result = identify(options);
  else if (mode === '--mount') result = await mount(options);
  else if (mode === '--claude') result = claude(options);
  else if (mode === '--validate-record') {
    try { result = validateRecord(readJson(outputTarget(args[args.indexOf(mode) + 1], options.cwd)).value, options); }
    catch (_) { result = { valid: false, problems: ['record-unreadable'] }; }
    console.log(JSON.stringify(result));
    if (result.valid) console.log('PASS C05 record: sanitized client mechanism mount Claude G1 and deferred visual acceptance are coherent');
    return result.valid ? 0 : 1;
  } else {
    let target;
    try { target = outputTarget(args[args.indexOf('--out') + 1], options.cwd); } catch (_) { return 2; }
    result = record({ identification: identify(options), mounting: await mount(options), claudeTerminal: claude(options) });
    const validation = validateRecord(result, options);
    if (!validation.valid) { console.log(JSON.stringify(validation)); return 1; }
    fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

module.exports = { identify, mount, claude, record, validateRecord, outputTarget, mountShape,
  mounted, gate, cleanup, safeOwnedTree, ownsRootArgument, trackProcesses, scanLiteral, extensionRows, nativeMountTarget, MECHANISM, main };
if (!isMainThread) {
  const { target, args, options } = workerData;
  parentPort.postMessage(observeCommand(target, args, options));
} else if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { console.error('panel-probe-failed'); process.exitCode = 1; });
}
