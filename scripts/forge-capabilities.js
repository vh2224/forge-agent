#!/usr/bin/env node
'use strict';

/*
 * Canonical capability catalog reader.  It intentionally has no npm
 * dependency: release gates run from a fresh clone on Windows, macOS and
 * Linux.  Paths shown to people are always POSIX-style catalog paths.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { HOST_RUNTIMES } = require('./forge-runtime.js');

// Schema 1.1.0 vocabulary. `distributed` means the release projects the surface
// into the host without demonstrated behavior; `demonstrated` additionally needs
// versioned evidence; `unknown` is never treated as available by consumers.
const AVAILABILITY = Object.freeze(['implemented', 'planned', 'conditional', 'unavailable', 'common', 'distributed', 'demonstrated', 'unknown']);
const CLASSIFICATIONS = Object.freeze(['common', 'conditional', 'unavailable']);
const KINDS = Object.freeze(['skill', 'agent', 'command', 'hook', 'headless', 'mcp', 'statusline', 'accounts', 'app', 'runtime']);
const PLATFORMS = Object.freeze(['macos', 'windows', 'linux']);
const PROBE_STATUSES = Object.freeze(['available', 'missing', 'unsupported', 'inconclusive']);
const CAPABILITY_PROBE_STATUSES = Object.freeze(['observed', 'absent', 'inconclusive']);
const REASON_CODES = Object.freeze(['available', 'missing', 'unsupported', 'inconclusive', 'permission-denied', 'not-selected', 'invalid-output', 'exit-nonzero', 'minimum-version', 'capability-observed', 'capability-absent']);
const RUNTIME_IDS = Object.freeze(['node', 'claude', 'codex']);
const DEFAULT_RUNTIME_COMMANDS = Object.freeze({ claude: 'claude', codex: 'codex' });
// Host CLIs have no generic floor: a version number does not prove a modern
// feature, so Claude/Codex are checked through cataloged capability_probes.
const DEFAULT_MINIMUMS = Object.freeze({ node: '18.0.0' });
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const CAPABILITY_KEYS = Object.freeze(['capability_id', 'kind', 'owner', 'required', 'classification', 'hosts', 'probe', 'platforms', 'evidence']);
const RUNTIME_KEYS = Object.freeze(['required', 'minimum_version', 'probe', 'platforms', 'capability_probes']);
const CAPABILITY_PROBE_KEYS = Object.freeze(['id', 'args', 'expect_output']);

// Public API notes for adapter authors:
// AVAILABILITY is deliberately closed so a typo cannot claim a green host.
// KINDS is deliberately closed so operational surfaces remain reviewable.
// posixPath is presentation-only; filesystem access always uses Node paths.
// loadCatalog does not infer a release version from this catalog.
// discover covers published Forge paths, rather than every private script.
// validateCatalog validates data without touching an operator checkout.
// audit layers checkout-dependent discovery on top of structural validation.
// matrix converts canonical entries to an intentionally small public shape.
// renderText is a human convenience; JSON is the automation interface.
// parseArgs keeps this command portable without an argument-parser package.
// run returns a numeric exit status so tests and release gates share behavior.

function posixPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${posixPath(file)}: ${error.message}`);
  }
}

function catalogPath(cwd) { return path.join(cwd, 'forge-capabilities.json'); }
function schemaPath(cwd) { return path.join(cwd, 'schemas', 'forge-capabilities.schema.json'); }

function loadCatalog(cwd = path.resolve(__dirname, '..')) {
  const root = path.resolve(cwd);
  return { root, catalog: readJson(catalogPath(root)), schema: readJson(schemaPath(root)) };
}

function discover(root) {
  const entries = [];
  const pushFiles = (directory, expression, kind, prefix) => {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) return;
    for (const name of fs.readdirSync(absolute).sort()) {
      if (!expression.test(name)) continue;
      entries.push({ kind, path: `${prefix}/${name}` });
    }
  };
  const skillRoot = path.join(root, 'skills');
  if (fs.existsSync(skillRoot)) {
    for (const name of fs.readdirSync(skillRoot).sort()) {
      if (fs.existsSync(path.join(skillRoot, name, 'SKILL.md'))) entries.push({ kind: 'skill', path: `skills/${name}/SKILL.md` });
    }
  }
  pushFiles('agents', /^forge-.*\.md$/, 'agent', 'agents');
  pushFiles('commands', /^forge.*\.md$/, 'command', 'commands');
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function issue(issues, message) { issues.push(message); }

function rejectUnknownKeys(issues, value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, `${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issue(issues, `${label}: unknown key ${key}`);
  }
}

// A catalog path is relative, POSIX-separated and free of `.`/`..`/empty
// segments, so it can only name something inside the checkout lexically.
function isNormalizedPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value) && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function validateEvidence(issues, capability, id) {
  const hosts = capability.hosts || {};
  const evidence = capability.evidence;
  if (evidence !== undefined) {
    rejectUnknownKeys(issues, evidence, HOST_RUNTIMES, `${id}: evidence`);
    if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
      for (const host of HOST_RUNTIMES) {
        if (!Object.prototype.hasOwnProperty.call(evidence, host)) continue;
        if (hosts[host] !== 'demonstrated') issue(issues, `${id}: evidence for ${host} requires demonstrated status`);
        if (!isNormalizedPath(evidence[host])) issue(issues, `${id}: evidence for ${host} must be a normalized relative path`);
      }
    }
  }
  for (const host of HOST_RUNTIMES) {
    if (hosts[host] !== 'demonstrated') continue;
    const own = evidence && typeof evidence === 'object' && !Array.isArray(evidence) && Object.prototype.hasOwnProperty.call(evidence, host);
    if (!own) issue(issues, `${id}: demonstrated ${host} requires evidence for the same host`);
  }
}

function validateCapabilityProbes(issues, runtimeId, runtime, seen) {
  if (runtime.capability_probes === undefined) return;
  if (!Array.isArray(runtime.capability_probes)) { issue(issues, `${runtimeId}: capability_probes must be an array`); return; }
  if ((runtime.probe || {}).kind !== 'cli') issue(issues, `${runtimeId}: capability_probes require a cli runtime probe`);
  for (const probe of runtime.capability_probes) {
    rejectUnknownKeys(issues, probe, CAPABILITY_PROBE_KEYS, `${runtimeId}: capability probe`);
    const probeId = probe && probe.id;
    if (!/^[a-z][a-z0-9-]*$/.test(String(probeId || ''))) issue(issues, `${runtimeId}: invalid capability probe id ${JSON.stringify(probeId)}`);
    else if (seen.has(probeId)) issue(issues, `${runtimeId}: duplicate capability probe id ${probeId}`);
    seen.add(probeId);
    if (!probe || !Array.isArray(probe.args) || probe.args.length === 0 || probe.args.some((arg) => typeof arg !== 'string' || !arg)) issue(issues, `${runtimeId}: capability probe ${probeId} args must be a non-empty argv array`);
    if (probe && probe.expect_output !== undefined && (!Array.isArray(probe.expect_output) || probe.expect_output.some((token) => typeof token !== 'string' || !token))) issue(issues, `${runtimeId}: capability probe ${probeId} expect_output must be an array of non-empty strings`);
  }
}

function validateCatalog(catalog, schema) {
  const issues = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return ['catalog must be an object'];
  if (catalog.$schema !== 'schemas/forge-capabilities.schema.json') issue(issues, 'catalog $schema must point to schemas/forge-capabilities.schema.json');
  if (!/^\d+\.\d+\.\d+$/.test(String(catalog.schema_version || ''))) issue(issues, 'catalog schema_version must be semver');
  if (!schema || !schema.$defs || !schema.$defs.host) issue(issues, 'schema must define host enums');
  const schemaHosts = (((schema || {}).$defs || {}).host || {}).enum || [];
  if (JSON.stringify(schemaHosts) !== JSON.stringify(HOST_RUNTIMES)) issue(issues, 'schema host enum drifted from forge-runtime HOST_RUNTIMES');
  const release = catalog.release || {};
  if (release.product_version_source !== 'git-tag-release-workflow') issue(issues, 'product version must derive from git-tag-release-workflow');
  for (const host of HOST_RUNTIMES) {
    const adapter = (release.adapters || {})[host];
    if (!adapter || adapter.optional !== true || adapter.host !== host) issue(issues, `adapter ${host} must be optional and target its own host`);
  }
  if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length === 0) return issues.concat('catalog capabilities must be a non-empty array');
  const ids = new Set();
  for (const capability of catalog.capabilities) {
    const id = capability && capability.capability_id;
    if (!/^[a-z][a-z0-9-]*$/.test(String(id || ''))) issue(issues, `invalid capability_id ${JSON.stringify(id)}`);
    if (ids.has(id)) issue(issues, `duplicate capability_id ${id}`);
    ids.add(id);
    rejectUnknownKeys(issues, capability, CAPABILITY_KEYS, `${id}`);
    if (!KINDS.includes(capability.kind)) issue(issues, `${id}: invalid kind ${capability.kind}`);
    if (!/^[a-z][a-z0-9-]*$/.test(String(capability.owner || ''))) issue(issues, `${id}: owner is required`);
    if (typeof capability.required !== 'boolean') issue(issues, `${id}: required must be boolean`);
    rejectUnknownKeys(issues, capability.hosts || {}, HOST_RUNTIMES, `${id}: hosts`);
    for (const host of HOST_RUNTIMES) {
      const status = (capability.hosts || {})[host];
      if (!AVAILABILITY.includes(status)) issue(issues, `${id}: invalid ${host} classification ${JSON.stringify(status)}`);
    }
    validateEvidence(issues, capability || {}, id);
    const probe = capability.probe || {};
    if (probe.kind !== 'filesystem' || typeof probe.path !== 'string' || !probe.path || probe.path.includes('\\') || probe.path.split('/').some((segment) => segment === '.' || segment === '..')) issue(issues, `${id}: probe must be a normalized filesystem path`);
    if (capability.required && (!probe.path || !probe.kind)) issue(issues, `${id}: required capability has no planned probe`);
    if (capability.platforms !== undefined) {
      rejectUnknownKeys(issues, capability.platforms, PLATFORMS, `${id}: platforms`);
      for (const platform of PLATFORMS) {
        const status = (capability.platforms || {})[platform];
        if (!AVAILABILITY.includes(status)) issue(issues, `${id}: invalid ${platform} classification ${JSON.stringify(status)}`);
      }
    }
    if (!CLASSIFICATIONS.includes(capability.classification)) {
      issue(issues, `${id}: classification must be one of ${CLASSIFICATIONS.join(', ')}`);
    }
  }
  if (catalog.reason_codes !== undefined) {
    if (!Array.isArray(catalog.reason_codes)) issue(issues, 'reason_codes must be an array');
    else for (const code of catalog.reason_codes) if (!REASON_CODES.includes(code)) issue(issues, `unknown reason code ${JSON.stringify(code)}`);
  }
  if (catalog.runtimes !== undefined) {
    if (!catalog.runtimes || typeof catalog.runtimes !== 'object' || Array.isArray(catalog.runtimes)) issue(issues, 'runtimes must be an object');
    else {
      for (const id of Object.keys(catalog.runtimes)) if (!RUNTIME_IDS.includes(id)) issue(issues, `unknown runtime ${id}`);
      const capabilityProbeIds = new Set();
      for (const id of RUNTIME_IDS) {
        const runtime = catalog.runtimes[id];
        if (!runtime) continue;
        rejectUnknownKeys(issues, runtime, RUNTIME_KEYS, `${id}: runtime`);
        if (typeof runtime.required !== 'boolean') issue(issues, `${id}: required must be boolean`);
        validateCapabilityProbes(issues, id, runtime, capabilityProbeIds);
        if (runtime.minimum_version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(runtime.minimum_version))) issue(issues, `${id}: minimum_version must be semver`);
        const probe = runtime.probe || {};
        if (!['node', 'cli'].includes(probe.kind)) issue(issues, `${id}: runtime probe kind must be node or cli`);
        if (probe.kind === 'cli' && (typeof probe.command !== 'string' || !probe.command)) issue(issues, `${id}: CLI probe command is required`);
        if (probe.version_args !== undefined && (!Array.isArray(probe.version_args) || probe.version_args.some((arg) => typeof arg !== 'string'))) issue(issues, `${id}: version_args must be an argv array`);
        if (probe.behavior_args !== undefined && (!Array.isArray(probe.behavior_args) || probe.behavior_args.some((arg) => typeof arg !== 'string'))) issue(issues, `${id}: behavior_args must be an argv array`);
      }
    }
  }
  return issues;
}

// Evidence must be a regular file physically inside the checkout. The lexical
// rule already refuses traversal; realpath also refuses a link that escapes.
function evidenceProblem(root, relative) {
  let realRoot; let realTarget;
  try { realRoot = fs.realpathSync(root); } catch (_) { return 'cannot resolve the checkout'; }
  try { realTarget = fs.realpathSync(path.join(root, relative)); } catch (_) { return 'does not exist'; }
  const inside = path.relative(realRoot, realTarget);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return 'escapes the checkout';
  try { if (!fs.statSync(realTarget).isFile()) return 'is not a file'; } catch (_) { return 'does not exist'; }
  return null;
}

function audit(cwd = path.resolve(__dirname, '..')) {
  const { root, catalog, schema } = loadCatalog(cwd);
  const issues = validateCatalog(catalog, schema);
  const listedByPath = new Map();
  for (const capability of catalog.capabilities || []) {
    const probePath = capability.probe && capability.probe.kind === 'filesystem' && capability.probe.path;
    if (!probePath) continue;
    if (listedByPath.has(probePath)) issue(issues, `duplicate probe path ${probePath}`);
    listedByPath.set(probePath, capability);
    if (capability.required && !fs.existsSync(path.join(root, probePath))) issue(issues, `${capability.capability_id}: required probe does not exist: ${probePath}`);
  }
  for (const capability of catalog.capabilities || []) {
    const evidence = capability && capability.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) continue;
    for (const host of HOST_RUNTIMES) {
      const relative = evidence[host];
      if (!isNormalizedPath(relative)) continue;
      const problem = evidenceProblem(root, relative);
      if (problem) issue(issues, `${capability.capability_id}: evidence for ${host} ${problem}: ${relative}`);
    }
  }
  for (const surface of discover(root)) {
    const capability = listedByPath.get(surface.path);
    if (!capability) issue(issues, `published ${surface.kind} missing from catalog: ${surface.path}`);
    else if (capability.kind !== surface.kind) issue(issues, `${surface.path}: catalog kind ${capability.kind} does not match discovered ${surface.kind}`);
  }
  return { root, catalog, schema, issues: issues.sort(), discovered: discover(root) };
}

function orderedCapabilities(catalog) {
  return [...catalog.capabilities].sort((a, b) => a.capability_id.localeCompare(b.capability_id));
}

function classifySurface(entry) {
  if (entry.classification) return entry.classification;
  const platforms = entry.platforms;
  if (platforms && PLATFORMS.every((platform) => platforms[platform] === 'unavailable')) return 'unavailable';
  const hosts = entry.hosts || {};
  if (hosts.claude === 'unavailable' && hosts.codex === 'unavailable') return 'unavailable';
  if (hosts.claude !== hosts.codex || entry.required === false) return 'conditional';
  return 'common';
}

function matrix(catalog) {
  const surfaces = orderedCapabilities(catalog).map((entry) => ({
    capability_id: entry.capability_id,
    kind: entry.kind,
    owner: entry.owner,
    required: entry.required,
    claude: entry.hosts.claude,
    codex: entry.hosts.codex,
    platforms: entry.platforms || null,
    probe: entry.probe.path,
    classification: classifySurface(entry),
  }));
  const runtimes = Object.keys(catalog.runtimes || {}).sort().map((id) => {
    const entry = catalog.runtimes[id];
    return {
      capability_id: `runtime-${id}`,
      kind: 'runtime', owner: 'runtime', required: Boolean(entry.required),
      claude: id === 'claude' ? 'conditional' : 'common',
      codex: id === 'codex' ? 'conditional' : 'common',
      platforms: entry.platforms || null,
      probe: entry.probe && (entry.probe.command || entry.probe.kind),
      minimum_version: entry.minimum_version || null,
      capability_probes: Array.isArray(entry.capability_probes) ? entry.capability_probes.map((probe) => probe.id) : [],
    };
  });
  return surfaces.concat(runtimes).sort((a, b) => a.capability_id.localeCompare(b.capability_id));
}

function renderText(rows) {
  const header = ['Capability', 'Kind', 'Owner', 'Claude', 'Codex', 'Platforms', 'Probe'];
  const body = rows.map((row) => [
    row.capability_id, row.kind, row.owner, row.claude, row.codex,
    row.platforms ? PLATFORMS.map((platform) => `${platform}:${row.platforms[platform]}`).join('; ') : 'all', row.probe || '',
  ]);
  const widths = header.map((value, index) => Math.max(value.length, ...body.map((row) => row[index].length)));
  const format = (row) => row.map((value, index) => value.padEnd(widths[index])).join('  ');
  return [format(header), format(widths.map((width) => '-'.repeat(width))), ...body.map(format)].join('\n');
}

function semver(value) {
  const match = String(value || '').match(/(?:^|[^0-9])([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left, right) {
  const a = semver(left); const b = semver(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function selectedRuntimes(options = {}) {
  const requested = options.runtime || options.host_runtime || options.hostRuntime || 'claude';
  if (requested === 'both') return ['claude', 'codex'];
  if (requested === 'node') return [];
  if (!HOST_RUNTIMES.includes(String(requested))) throw new RangeError(`runtime must be one of: claude, codex, both`);
  return [String(requested)];
}

function descriptorFor(id, runtime, options = {}) {
  const overrides = options.binaries || options.cliPaths || options.commands || {};
  const override = overrides[id];
  if (override && typeof override === 'object') {
    return { command: override.command || override.path || runtime.probe.command, fixedArgs: Array.isArray(override.args) ? override.args.slice() : [] };
  }
  if (typeof override === 'string') return { command: override, fixedArgs: [] };
  return { command: runtime.probe.command || DEFAULT_RUNTIME_COMMANDS[id], fixedArgs: [] };
}

function isPathCommand(command) {
  return path.isAbsolute(command) || command.includes('/') || command.includes('\\') || command.endsWith('.js') || command.endsWith('.cmd') || command.endsWith('.exe');
}

function candidateCommands(command, platform = process.platform, env = process.env) {
  if (isPathCommand(command)) {
    const candidates = [command];
    if (platform === 'win32' && !/\.(?:cmd|exe|com|bat)$/i.test(command)) candidates.push(`${command}.cmd`, `${command}.exe`);
    return candidates;
  }
  const envPath = String((env && env.PATH) || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean);
  // Windows npm shims are normally `.cmd`; prefer them over an extensionless
  // POSIX shell shim that may be earlier on PATH but cannot be spawned natively.
  const suffixes = platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const candidates = [];
  for (const directory of envPath) for (const suffix of suffixes) candidates.push(path.join(directory, command + suffix));
  return candidates.length ? candidates : [command];
}

function resolveExecutable(command, options = {}) {
  const platform = options.platform || process.platform;
  const candidates = candidateCommands(command, platform, options.env || process.env);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        if (platform === 'win32' || (fs.statSync(candidate).mode & 0o111) !== 0) return path.resolve(candidate);
        // Return an existing non-executable POSIX file so spawnSync can
        // surface EACCES as a stable permission-denied diagnostic.
        if (platform !== 'win32') return path.resolve(candidate);
      }
    } catch (_) { /* continue */ }
  }
  return null;
}

function outputOf(result) {
  return `${result && result.stdout ? result.stdout : ''}\n${result && result.stderr ? result.stderr : ''}`.trim();
}

function invoke(executable, args, options = {}) {
  let result;
  try {
    const windowsShim = (options.platform || process.platform) === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
    const command = windowsShim ? ((options.env || process.env).ComSpec || 'cmd.exe') : executable;
    const commandArgs = windowsShim
      ? ['/d', '/c', executable, ...args]
      : args;
    result = spawnSync(command, commandArgs, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      encoding: 'utf8',
      timeout: Number.isFinite(options.timeout) ? options.timeout : DEFAULT_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    return { error, status: null, stdout: '', stderr: '' };
  }
  return { error: result.error || null, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function makeProbe(id, status, reasonCode, extras = {}) {
  return { id, status, reason_code: reasonCode, ...extras };
}

function probeNode(runtime, options = {}) {
  const version = options.nodeVersion || process.version;
  const minimum = runtime.minimum_version || DEFAULT_MINIMUMS.node;
  const order = compareVersion(version, minimum);
  if (order === null) return makeProbe('node', 'inconclusive', 'invalid-output', { version, minimum_version: minimum, selected: true, executable: process.execPath });
  if (order < 0) return makeProbe('node', 'unsupported', 'minimum-version', { version, minimum_version: minimum, selected: true, executable: process.execPath });
  return makeProbe('node', 'available', 'available', { version, minimum_version: minimum, selected: true, executable: process.execPath });
}

function capabilityProbesOf(runtime) {
  return Array.isArray(runtime && runtime.capability_probes) ? runtime.capability_probes : [];
}

// Capability probes never run when the runtime is unselected or unavailable;
// each one is still listed so absence of evidence is visible, not omitted.
function skippedCapabilities(runtime, reasonCode) {
  const result = {};
  for (const probe of capabilityProbesOf(runtime)) result[probe.id] = { id: probe.id, args: probe.args.slice(), status: 'inconclusive', reason_code: reasonCode };
  return result;
}

function hasToken(output, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(output);
}

// Informational only: results never change status, ok or required_failures.
// The cache key binds the resolved executable and the full argv, so a run is
// reused only for the identical invocation of the same runtime binary.
function runCapabilityProbes(runtime, executable, fixedArgs, version, cache, options) {
  const result = {};
  for (const probe of capabilityProbesOf(runtime)) {
    const argv = fixedArgs.concat(probe.args);
    const key = JSON.stringify([executable, ...argv]);
    if (!cache.has(key)) cache.set(key, invoke(executable, argv, options));
    const run = cache.get(key);
    const base = { id: probe.id, args: probe.args.slice(), version };
    if (run.error) { result[probe.id] = { ...base, status: 'inconclusive', reason_code: run.error.code === 'EACCES' ? 'permission-denied' : 'inconclusive' }; continue; }
    if (run.status !== 0) { result[probe.id] = { ...base, status: 'inconclusive', reason_code: 'exit-nonzero', exit_code: run.status }; continue; }
    const output = outputOf(run);
    const missing = (probe.expect_output || []).filter((token) => !hasToken(output, token));
    result[probe.id] = missing.length
      ? { ...base, status: 'absent', reason_code: 'capability-absent', missing_tokens: missing }
      : { ...base, status: 'observed', reason_code: 'capability-observed' };
  }
  return result;
}

function probeCli(id, runtime, options = {}) {
  const result = probeCliRuntime(id, runtime, options);
  if (capabilityProbesOf(runtime).length && !result.capabilities) {
    result.capabilities = skippedCapabilities(runtime, result.reason_code === 'not-selected' ? 'not-selected' : 'inconclusive');
  }
  return result;
}

function probeCliRuntime(id, runtime, options = {}) {
  const selected = selectedRuntimes(options).includes(id);
  if (!selected) return makeProbe(id, 'inconclusive', 'not-selected', { selected: false, minimum_version: runtime.minimum_version || DEFAULT_MINIMUMS[id] || null });
  const descriptor = descriptorFor(id, runtime, options);
  const executable = resolveExecutable(descriptor.command, options);
  if (!executable && !isPathCommand(descriptor.command)) {
    // A bare command may be available through a non-filesystem resolver. A
    // direct spawn keeps the probe shell-free and lets the OS report ENOENT.
    const fallback = invoke(descriptor.command, descriptor.fixedArgs.concat(runtime.probe.version_args || ['--version']), options);
    if (fallback.error && fallback.error.code !== 'ENOENT') return makeProbe(id, 'inconclusive', fallback.error.code === 'EACCES' ? 'permission-denied' : 'inconclusive', { selected: true, executable: descriptor.command, error: fallback.error.code || fallback.error.message });
    if (!fallback.error) return evaluateCliProbe(id, runtime, descriptor.command, descriptor.fixedArgs, fallback, options);
  }
  if (!executable) return makeProbe(id, 'missing', 'missing', { selected: true, executable: null, command: descriptor.command });
  const versionRun = invoke(executable, descriptor.fixedArgs.concat(runtime.probe.version_args || ['--version']), options);
  if (versionRun.error) return makeProbe(id, 'inconclusive', versionRun.error.code === 'EACCES' ? 'permission-denied' : 'inconclusive', { selected: true, executable, error: versionRun.error.code || versionRun.error.message });
  return evaluateCliProbe(id, runtime, executable, descriptor.fixedArgs, versionRun, options);
}

function evaluateCliProbe(id, runtime, executable, fixedArgs, versionRun, options = {}) {
  if (versionRun.status !== 0) return makeProbe(id, 'inconclusive', 'exit-nonzero', { selected: true, executable, exit_code: versionRun.status, output: outputOf(versionRun) });
  const output = outputOf(versionRun);
  const version = semver(output);
  // Only an explicitly declared floor is enforced; otherwise the observed
  // version is recorded with minimum_version null.
  const minimum = runtime.minimum_version || DEFAULT_MINIMUMS[id] || null;
  if (!version) return makeProbe(id, 'inconclusive', 'invalid-output', { selected: true, executable, output });
  const normalizedVersion = version.join('.');
  if (minimum !== null) {
    const order = compareVersion(normalizedVersion, minimum);
    if (order === null || order < 0) return makeProbe(id, 'unsupported', 'minimum-version', { selected: true, executable, version: normalizedVersion, minimum_version: minimum });
  }
  const versionArgs = fixedArgs.concat(runtime.probe.version_args || ['--version']);
  const behaviorArgs = fixedArgs.concat(runtime.probe.behavior_args || ['--help']);
  const behavior = invoke(executable, behaviorArgs, options);
  if (behavior.error) return makeProbe(id, 'inconclusive', behavior.error.code === 'EACCES' ? 'permission-denied' : 'inconclusive', { selected: true, executable, version: normalizedVersion, error: behavior.error.code || behavior.error.message });
  if (behavior.status !== 0) return makeProbe(id, 'inconclusive', 'exit-nonzero', { selected: true, executable, version: normalizedVersion, behavior_exit_code: behavior.status });
  const extras = { selected: true, executable, version: normalizedVersion, minimum_version: minimum, behavior: 'passed' };
  if (capabilityProbesOf(runtime).length) {
    const cache = new Map([[JSON.stringify([executable, ...versionArgs]), versionRun], [JSON.stringify([executable, ...behaviorArgs]), behavior]]);
    extras.capabilities = runCapabilityProbes(runtime, executable, fixedArgs, normalizedVersion, cache, options);
  }
  return makeProbe(id, 'available', 'available', extras);
}

function detect(cwdOrOptions, maybeOptions) {
  const options = typeof cwdOrOptions === 'string' ? { ...(maybeOptions || {}), cwd: cwdOrOptions } : { ...(cwdOrOptions || {}) };
  const cwd = path.resolve(options.cwd || path.resolve(__dirname, '..'));
  const loaded = options.catalog ? { catalog: options.catalog } : loadCatalog(cwd);
  const runtimes = loaded.catalog.runtimes || {};
  const nodeRuntime = runtimes.node || { minimum_version: DEFAULT_MINIMUMS.node, probe: { kind: 'node' }, required: true };
  const results = { node: probeNode(nodeRuntime, options) };
  for (const id of HOST_RUNTIMES) results[id] = probeCli(id, runtimes[id] || { probe: { kind: 'cli', command: DEFAULT_RUNTIME_COMMANDS[id] }, required: true }, options);
  const selected = selectedRuntimes(options);
  const required = ['node'].concat(selected);
  const requiredFailures = required.filter((id) => results[id].status !== 'available');
  const warnings = HOST_RUNTIMES.filter((id) => !selected.includes(id) && results[id].reason_code === 'not-selected');
  return { cwd, runtime: options.runtime || options.host_runtime || options.hostRuntime || 'claude', selected, ok: requiredFailures.length === 0, required_failures: requiredFailures, warnings, probes: results };
}

function parseArgs(argv) {
  const result = { check: false, audit: false, matrix: false, detect: false, json: false, cwd: path.resolve(__dirname, '..') };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check') result.check = true;
    else if (arg === '--audit') result.audit = true;
    else if (arg === '--matrix') result.matrix = true;
    else if (arg === '--detect') result.detect = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--cwd') result.cwd = path.resolve(argv[++index] || '');
    else if (arg === '--runtime') result.runtime = argv[++index] || '';
    else if (arg === '--help') result.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return result;
}

function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout)) {
  const options = parseArgs(argv);
  if (options.help) { write('Usage: forge-capabilities.js [--audit|--check] [--matrix|--detect] [--runtime claude|codex|both] [--json] [--cwd PATH]\n'); return 0; }
  const result = audit(options.cwd);
  if ((options.check || options.audit) && result.issues.length) {
    write(`Capability audit failed (${result.issues.length}):\n${result.issues.map((entry) => `- ${entry}`).join('\n')}\n`);
    return 1;
  }
  const rows = matrix(result.catalog);
  if (options.detect) {
    const detection = detect(options.cwd, { runtime: options.runtime });
    if (options.json) write(`${JSON.stringify(detection)}\n`);
    else {
      write(`Capability detection (${detection.runtime})\n`);
      for (const id of ['node', 'claude', 'codex']) {
        const probe = detection.probes[id];
        write(`  ${id}: ${probe.status} (${probe.reason_code})${probe.version ? ` ${probe.version}` : ''}\n`);
        for (const capability of Object.values(probe.capabilities || {})) write(`    ${capability.id}: ${capability.status} (${capability.reason_code})\n`);
      }
    }
    return detection.ok ? 0 : 1;
  }
  if (options.json) write(`${JSON.stringify({ schema_version: result.catalog.schema_version, release: result.catalog.release, capabilities: rows })}\n`);
  else if (options.matrix || !options.check) write(`${renderText(rows)}\n`);
  if (options.check || options.audit) write(`Capability audit passed: ${rows.length} catalog entries, ${result.discovered.length} discovered surfaces.\n`);
  return 0;
}

module.exports = {
  AVAILABILITY, CLASSIFICATIONS, KINDS, PLATFORMS, PROBE_STATUSES, CAPABILITY_PROBE_STATUSES, REASON_CODES, DEFAULT_PROBE_TIMEOUT_MS,
  RUNTIME_IDS, posixPath, loadCatalog, discover, validateCatalog, audit, matrix,
  renderText, classifySurface, parseArgs, run, semver, compareVersion, resolveExecutable, invoke,
  probeNode, probeCli, detect, detectCapabilities: detect, probeRuntime: detect,
};

if (require.main === module) {
  try { process.exitCode = run(); } catch (error) { process.stderr.write(`forge-capabilities: ${error.message}\n`); process.exitCode = 1; }
}
