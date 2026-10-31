#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { detect: detectCapabilities } = require('./forge-capabilities.js');
const { resolveForgeHome, resolveRuntimeHome } = require('./forge-home.js');
const { LEGACY_VERSION } = require('./forge-version.js');

const PROTOCOL_VERSION = '1.0.0';
const RUNTIMES = ['claude', 'codex', 'both'];
const OPERATIONAL_KINDS = new Set(['statusline', 'accounts', 'app', 'hook', 'headless', 'mcp']);
// Catalog schema 1.1.0: `demonstrated` counts as implemented. `distributed` and
// `unknown` are handled explicitly in diagnose and are never available here.
const AVAILABLE_STATES = new Set(['implemented', 'common', 'demonstrated']);

function selectedRuntimes(runtime) {
  if (!RUNTIMES.includes(runtime)) throw new Error(`runtime inválido: ${JSON.stringify(runtime)} (use claude, codex ou both)`);
  return runtime === 'both' ? ['claude', 'codex'] : [runtime];
}

function readJson(file, io = fs) {
  try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`JSON inválido em ${path.basename(file)}: ${error.message}`);
  }
}

function exists(file, io = fs) {
  try { return io.existsSync(file); } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) return false;
    throw error;
  }
}

function runtimeFromHosts(hosts) {
  const unique = [...new Set(hosts)].filter((host) => host === 'claude' || host === 'codex').sort();
  if (unique.length === 2) return 'both';
  return unique[0] || null;
}

// Installation discovery is deliberately Forge-home first. A runtime home is
// consulted only for an explicitly selected legacy migration source.
function detectInstallation(options = {}) {
  const io = options.fs || fs;
  const forgeHome = resolveForgeHome(options);
  const manifestFile = path.join(forgeHome, 'manifest.json');
  const manifest = readJson(manifestFile, io);
  if (manifest) {
    const hosts = Object.keys(manifest.adapters || {}).filter((host) => host === 'claude' || host === 'codex').sort();
    return { source: 'forge-manifest', forge_home: forgeHome, manifest, installed: hosts, runtime: runtimeFromHosts(hosts), legacy: null };
  }

  if (!options.runtime) return { source: 'none', forge_home: forgeHome, manifest: null, installed: [], runtime: null, legacy: null };
  const selected = selectedRuntimes(options.runtime);
  const installed = [];
  let legacy = null;
  for (const host of selected) {
    const home = resolveRuntimeHome(host, options);
    const markers = host === 'claude'
      ? ['forge-agent-prefs.jsonc', 'forge-agent-prefs.md', path.join('agents', 'forge-executor.md')]
      : [path.join('agents', 'forge-executor.toml'), path.join('skills', 'forge-doctor', 'SKILL.md')];
    if (markers.some((marker) => exists(path.join(home, marker), io))) {
      installed.push(host);
      if (host === 'claude') legacy = { runtime: 'claude', release: `${LEGACY_VERSION}-compatible`, preserve: markers };
    }
  }
  return { source: installed.length ? 'selected-legacy-home' : 'none', forge_home: forgeHome, manifest: null, installed, runtime: runtimeFromHosts(installed), legacy };
}

function platformName(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
}

function finding(capability, host, status, reasonCode, fatal, details = {}) {
  return {
    capability,
    runtime: host || 'core',
    status,
    reason_code: reasonCode,
    severity: fatal ? 'fatal' : (status === 'available' ? 'info' : 'warning'),
    required: Boolean(details.required),
    repair: details.repair || 'diagnostic-only',
  };
}

function diagnose(options = {}) {
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const runtime = options.runtime || detectInstallation(options).runtime;
  if (!runtime) throw new Error('runtime não detectado; informe --runtime claude|codex|both');
  const selected = selectedRuntimes(runtime);
  const detector = options.detectCapabilities || detectCapabilities;
  const probes = detector(repo, { ...options, runtime });
  const installation = detectInstallation({ ...options, runtime });
  const diagnostics = [];

  const node = probes.probes && probes.probes.node;
  if (node && node.status !== 'available') diagnostics.push(finding('core-runtime', null, node.status, 'core-incompatible', true, { required: true }));
  for (const host of selected) {
    const probe = probes.probes && probes.probes[host];
    if (!probe || probe.status !== 'available') diagnostics.push(finding('runtime-adapter', host, probe ? probe.status : 'missing', 'adapter-missing', true, { required: true }));
    else diagnostics.push(finding('runtime-adapter', host, 'available', 'available', false, { required: true }));
    if (installation.manifest && !installation.installed.includes(host)) diagnostics.push(finding('installed-adapter', host, 'missing', 'adapter-missing', true, { required: true }));
  }

  const catalog = options.catalog || readJson(path.join(repo, 'forge-capabilities.json'), options.fs || fs) || { capabilities: [] };
  const osName = platformName(options.platform);
  for (const entry of catalog.capabilities || []) {
    if (!OPERATIONAL_KINDS.has(entry.kind)) continue;
    for (const host of selected) {
      const hostState = (entry.hosts || {})[host] || 'unavailable';
      const platformState = (entry.platforms || {})[osName];
      const effective = platformState === 'unavailable' ? 'unavailable' : hostState;
      const probePath = entry.probe && entry.probe.kind === 'filesystem' ? path.join(repo, entry.probe.path) : null;
      const present = !probePath || exists(probePath, options.fs || fs);
      const trusted = entry.kind !== 'hook' || !options.hookTrust || options.hookTrust[host] !== false;
      if (AVAILABLE_STATES.has(effective) && present && trusted) {
        diagnostics.push(finding(entry.capability_id, host, 'available', 'available', false, { required: entry.required }));
      } else if (effective === 'distributed' && present && trusted) {
        // Projected by the release but not demonstrated: visible, never fatal.
        diagnostics.push(finding(entry.capability_id, host, 'distributed', 'capability-not-demonstrated', false, { required: entry.required }));
      } else if (effective === 'unknown' && entry.required) {
        diagnostics.push(finding(entry.capability_id, host, 'unknown', 'required-capability-unknown', true, { required: true }));
      } else if (effective === 'conditional' || !trusted || !entry.required) {
        diagnostics.push(finding(entry.capability_id, host, present && !trusted ? 'untrusted' : effective, 'conditional-capability-unavailable', false, { required: entry.required }));
      } else {
        diagnostics.push(finding(entry.capability_id, host, present ? effective : 'missing', 'required-capability-missing', true, { required: true }));
      }
    }
  }

  const fatal = diagnostics.filter((item) => item.severity === 'fatal');
  return {
    protocol_version: PROTOCOL_VERSION,
    ok: fatal.length === 0,
    runtime,
    selected,
    installation: { source: installation.source, installed: installation.installed, runtime: installation.runtime },
    probes: probes.probes || {},
    required_failures: probes.required_failures || [],
    diagnostics,
    fatal_count: fatal.length,
  };
}

function planUpdate(options = {}) {
  const installation = detectInstallation(options);
  const runtime = options.runtime || installation.runtime;
  if (!runtime) throw new Error('instalação não detectada; informe --runtime para uma migração legada explícita');
  const selected = selectedRuntimes(runtime);
  if (installation.manifest) {
    const missing = selected.filter((host) => !installation.installed.includes(host));
    if (missing.length) throw new Error(`adapter não instalado: ${missing.join(', ')}`);
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    ok: true,
    runtime,
    selected,
    installation_source: installation.source,
    legacy_migration: installation.legacy,
    migrate_legacy: Boolean(options.migrateLegacy),
    preserve: ['forge-agent-prefs.jsonc', 'operator-managed-runtime-config', 'project-.gsd'],
    backup_required: true,
    installer_args: ['--runtime', runtime, '--update'],
  };
}

module.exports = { PROTOCOL_VERSION, RUNTIMES, OPERATIONAL_KINDS, selectedRuntimes, detectInstallation, diagnose, planUpdate, platformName };
