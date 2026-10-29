#!/usr/bin/env node
'use strict';

// Codex-native projection. It consumes the same source manifest as Claude but
// never resolves, reads, or writes a Claude home.
const fs = require('fs');
const interaction = require('./forge-interaction');
const questions = require('./forge-codex-questions');
const path = require('path');
const { resolveForgePaths } = require('./forge-home');
const sourceManifest = require('./forge-source-manifest');
const { loadAllProcedureContexts } = require('./forge-procedure-context');
const ownership = require('./forge-projection-ownership');
const PROVENANCE = require('./forge-projection-provenance');
const selfProjection = require('./forge-projection-self');
const { detectEol } = require('./forge-instructions');
const { VERSION } = require('./forge-version');
const { DEFAULT_STATUS_LINE, addDefaultStatusLine } = require('./forge-codex-statusline');
const { isDeepStrictEqual } = require('util');
const { HOST_RUNTIMES } = require('./forge-runtime');

const RUNTIME = 'codex';
// Production callers pass this dialect explicitly. Keeping it as data preserves
// the renderer seam: the marker scanner identifies the managed span, while the
// caller decides which native worker syntax and host name belong in that span.
const PRODUCTION_DISPATCH_DIALECT = Object.freeze({
  agentInvocation: 'spawn_agent(',
  hostRuntime: RUNTIME,
});
const ORIGIN = '<!-- forge-source:codex -->';
const TOML_ORIGIN = '# forge-source:codex';
const REASON = Object.freeze({ unavailable: 'unavailable', user_owned: 'user_owned', invalid_options: 'invalid_options', missing_source: 'missing_source', missing_manifest: 'missing_manifest' });
const DISPATCH_MARKER_START = '<!-- forge:dispatch:start -->';
const DISPATCH_MARKER_END = '<!-- forge:dispatch:end -->';
const DISPATCH_REASON = Object.freeze({
  START_WITHOUT_END: 'dispatch-start-without-end',
  END_WITHOUT_START: 'dispatch-end-without-start',
  DUPLICATE_START: 'dispatch-duplicate-start',
  DUPLICATE_END: 'dispatch-duplicate-end',
  END_BEFORE_START: 'dispatch-end-before-start',
  AGENT_FORM_REQUIRED: 'dispatch-agent-form-required',
  HOST_RUNTIME_INVALID: 'dispatch-host-runtime-invalid',
});

// Dispatch markers deliberately have their own scanner. The routing-contract
// scanner in forge-instructions.js has fixed marker regexes because accepting a
// second managed-block dialect there would widen the ownership boundary of
// CLAUDE.md/AGENTS.md. Only detectEol is shared between the two mechanisms.
const DISPATCH_FENCE_RE = /^(`{3,}|~{3,})/;

function isDispatchMarkerLine(line, marker) {
  return line.startsWith(marker) && /^[ \t]*$/.test(line.slice(marker.length));
}

function isDispatchFenceClose(line, fenceChar, fenceLength) {
  if (!line.startsWith(fenceChar.repeat(fenceLength))) return false;
  let runLength = 0;
  while (line[runLength] === fenceChar) runLength++;
  return runLength >= fenceLength && /^[ \t]*$/.test(line.slice(runLength));
}

function scanDispatchMarkers(text) {
  const rawLines = String(text).split('\n');
  const starts = [];
  const ends = [];
  let fenceChar = null;
  let fenceLength = 0;
  let offset = 0;

  for (let index = 0; index < rawLines.length; index++) {
    const rawLine = rawLines[index];
    const line = rawLine.replace(/\r$/, '');
    if (fenceChar !== null) {
      if (isDispatchFenceClose(line, fenceChar, fenceLength)) {
        fenceChar = null;
        fenceLength = 0;
      }
    } else {
      const fence = DISPATCH_FENCE_RE.exec(line);
      if (fence) {
        fenceChar = fence[1][0];
        fenceLength = fence[1].length;
      } else {
        const marker = {
          start: offset,
          end: offset + line.length,
          after: offset + rawLine.length + (index < rawLines.length - 1 ? 1 : 0),
        };
        if (isDispatchMarkerLine(line, DISPATCH_MARKER_START)) starts.push(marker);
        else if (isDispatchMarkerLine(line, DISPATCH_MARKER_END)) ends.push(marker);
      }
    }
    offset += rawLine.length + (index < rawLines.length - 1 ? 1 : 0);
  }
  return { starts, ends };
}

function failDispatch(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function locateDispatchBlock(text) {
  const { starts, ends } = scanDispatchMarkers(text);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length === 0) failDispatch(DISPATCH_REASON.END_WITHOUT_START, 'marker forge:dispatch:end sem start');
  if (ends.length === 0) failDispatch(DISPATCH_REASON.START_WITHOUT_END, 'marker forge:dispatch:start sem end');
  if (starts.length > 1) failDispatch(DISPATCH_REASON.DUPLICATE_START, 'marker forge:dispatch:start duplicado');
  if (ends.length > 1) failDispatch(DISPATCH_REASON.DUPLICATE_END, 'marker forge:dispatch:end duplicado');
  if (ends[0].start < starts[0].start) failDispatch(DISPATCH_REASON.END_BEFORE_START, 'marker forge:dispatch:end anterior ao start');
  return {
    start: starts[0].after,
    end: ends[0].start,
    startMarker: starts[0],
    endMarker: ends[0],
  };
}

function normalizeDispatchInsertion(value, eol) {
  const separator = eol === 'crlf' ? '\r\n' : '\n';
  return String(value).replace(/\r\n|\r|\n/g, separator);
}

function rewriteDispatchDialect(text, options) {
  const block = locateDispatchBlock(text);
  // This fast path is the compatibility contract for all canonical sources in
  // this slice: no option is inspected and not even line endings are normalized.
  if (block === null) return text;

  const settings = options || {};
  const original = String(text);
  const interior = original.slice(block.start, block.end);
  const eol = detectEol(original);
  let agentInvocation = null;
  if (interior.includes('Agent(')) {
    if (typeof settings.agentInvocation !== 'string' || settings.agentInvocation.length === 0) {
      failDispatch(DISPATCH_REASON.AGENT_FORM_REQUIRED, 'agentInvocation não vazio é obrigatório para Agent( cercado');
    }
    agentInvocation = normalizeDispatchInsertion(settings.agentInvocation, eol);
  }
  const hostRuntime = settings.hostRuntime === undefined ? RUNTIME : settings.hostRuntime;
  // Symmetric with the Agent form above: an unusable value is refused by a named
  // code instead of reaching String() and being spliced as `--host-runtime null`
  // or `--host-runtime [object Object]` into the projected document.
  if (typeof hostRuntime !== 'string' || hostRuntime.length === 0) {
    failDispatch(DISPATCH_REASON.HOST_RUNTIME_INVALID, 'hostRuntime, quando informado, precisa ser string não vazia');
  }
  const runtimeInvocation = normalizeDispatchInsertion(hostRuntime, eol);
  // Match operational forms only inside the owned block. The standalone task
  // preparation caller carries its host as structured request data, while the
  // older callers carry the CLI flag. Both are projected from the same Claude
  // canonical source. Replacements never rescan agentInvocation bytes.
  const rewritten = interior.replace(
    /Agent\(|--host-runtime claude|\bhostRuntime:\s*(["'])claude\1/g,
    (match, quote) => {
      if (match === 'Agent(') return agentInvocation;
      if (match === '--host-runtime claude') return `--host-runtime ${runtimeInvocation}`;
      return `hostRuntime: ${quote}${runtimeInvocation}${quote}`;
    },
  );
  return `${original.slice(0, block.start)}${rewritten}${original.slice(block.end)}`;
}

function norm(value) { return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }
function tomlOrigin(kind) { return `${TOML_ORIGIN}-${kind} version=${VERSION}`; }
// YAML frontmatter must remain on line 1, so the marker sits below the closing
// fence when there is one. Ownership therefore probes the accepted positions
// rather than requiring the marker to be the very first byte.
const FRONTMATTER = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;
// The three positions a managed projection can carry its marker in — markdown at
// the top (no frontmatter), markdown right below the closing fence, and TOML on
// line 1. Anchored on purpose: a USER file that merely quotes the marker in a
// fenced block is not a projection, and classifying it as one overwrites it.
const MD_MARKER_AT_TOP = /^<!-- forge-source:[^\n]* -->[ \t]*\n\n?/;
const MD_MARKER_AFTER_FRONTMATTER = /^(---[ \t]*\n[\s\S]*?\n---[ \t]*\n)\n?<!-- forge-source:[^\n]* -->[ \t]*\n/;
const TOML_MARKER_AT_TOP = /^# forge-source:[^\n]*\n/;
function withOrigin(value) {
  const body = norm(value);
  const fence = FRONTMATTER.exec(body);
  if (fence) return `${body.slice(0, fence[0].length)}\n${ORIGIN}\n${body.slice(fence[0].length)}`;
  return `${ORIGIN}\n\n${body}`;
}
function hasOrigin(value) {
  const text = norm(String(value));
  return MD_MARKER_AT_TOP.test(text) || MD_MARKER_AFTER_FRONTMATTER.test(text) || TOML_MARKER_AT_TOP.test(text);
}
function exists(file) { try { return fs.existsSync(file); } catch (_) { return false; } }
function walk(root) {
  if (!exists(root)) return [];
  if (fs.statSync(root).isFile()) return [root];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(full)); else if (entry.isFile()) result.push(full);
  }
  return result;
}
function safe(root, relative) {
  const clean = String(relative).split(/[\\/]/).filter(Boolean).join(path.sep);
  const resolvedRoot = path.resolve(root); const target = path.resolve(resolvedRoot, clean);
  if (!clean || clean.split(path.sep).includes('..') || (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`))) throw Object.assign(new Error(`unsafe destination ${relative}`), { code: REASON.invalid_options });
  return target;
}
function roots(options) {
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const paths = resolveForgePaths({ cwd: repo, forgeHome: options.forgeHome, codexHome: options.codexHome, env: options.env, userHome: options.userHome, platform: options.platform });
  const projectRoot = path.resolve(options.projectRoot || repo);
  const codexHome = paths.runtimeHomes.codex;
  if (/(?:^|[\\/])\.claude(?:[\\/]|$)/i.test(codexHome)) throw Object.assign(new Error('Codex home não pode apontar para o host Claude'), { code: REASON.invalid_options });
  return { repo, forgeHome: paths.forgeHome, codexHome, projectRoot };
}
// Same rule as the Claude side: a missing source manifest means the repo root is
// not a clone, so the error names `--repo` instead of surfacing a raw ENOENT for
// a file that was never supposed to be at that path.
function manifestFor(root, options) {
  if (!options.manifest) {
    const file = path.resolve(options.manifestFile || path.join(root.repo, 'forge-source-manifest.json'));
    if (!exists(file)) throw Object.assign(new Error(`manifesto de origem ausente: ${file} — ${root.repo} não é um clone do forge-agent; informe \`--repo <dir>\``), { code: REASON.missing_manifest });
  }
  const manifest = options.manifest || JSON.parse(fs.readFileSync(options.manifestFile || path.join(root.repo, 'forge-source-manifest.json'), 'utf8'));
  sourceManifest.audit(manifest); return manifest;
}
function codexSources(manifest) {
  return manifest.sources.filter((source) => {
    const state = source.conditional && source.conditional.codex;
    return !state || !['unavailable', 'planned'].includes(state.status);
  });
}
function tomlMultiline(value) {
  return norm(value).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}

// Capabilities report (schema 2). JSON cannot carry an origin marker, so the
// report identifies itself by content: who generated it, from which core and
// which catalog. It is deterministic on purpose — no timestamp and no absolute
// path — so two writes are byte-identical and freshness is a pure comparison.
const REPORT_SCHEMA_VERSION = 2;
const REPORT_SOURCE = 'codex-capabilities';
const REPORT_GENERATOR = 'forge-codex-renderer';
const REPORT_RELATIVE = 'adapters/codex/capabilities.json';
const REPORT_MAX_BYTES = 1024 * 1024;
// Every renderer from 3.1.4 through 4.46.x wrote exactly these four keys.
const LEGACY_REPORT_KEYS = Object.freeze(['generated', 'runtime', 'surfaces', 'version']);
const CURRENT_REPORT_KEYS = Object.freeze(['capabilities', 'core_version', 'forge_source', 'generated', 'generator', 'permissions', 'report_schema_version', 'runtime', 'source', 'surfaces', 'version']);
const PERMISSIONS_CONTRACT = 'docs/codex-agent-permissions.md';
const AGENT_SANDBOX_COMMENT = `# sandbox_mode é declaração: sandbox e aprovações efetivos vêm da sessão pai; o campo não prova isolamento por agente (contrato: ${PERMISSIONS_CONTRACT}).`;
const REPORT_PERMISSIONS = Object.freeze({
  native_custom_agents: Object.freeze({ sandbox: 'inherited-from-parent-session', toml_sandbox_mode: 'declared-not-isolation-proof' }),
  app_server_sidecar: Object.freeze({ sandbox: 'per-turn-sandbox-policy' }),
  headless_exec: Object.freeze({ sandbox: 'explicit-cli-flags' }),
  contract: PERMISSIONS_CONTRACT,
});
const FRESHNESS = Object.freeze({ current: 'current', stale: 'stale', absent: 'absent', invalid: 'invalid' });
const FRESHNESS_REASON = Object.freeze({
  REPORT_ABSENT: 'report-absent',
  OVERSIZE: 'oversize',
  UNREADABLE_JSON: 'unreadable-json',
  WRONG_RUNTIME: 'wrong-runtime',
  NOT_GENERATED: 'not-generated',
  UNRECOGNIZED_SHAPE: 'unrecognized-shape',
  LEGACY_SHAPE: 'legacy-shape',
  CORE_VERSION_MISMATCH: 'core-version-mismatch',
  CATALOG_DIGEST_MISMATCH: 'catalog-digest-mismatch',
  CATALOG_UNAVAILABLE: 'catalog-unavailable',
  INSTALLED_CATALOG_UNAVAILABLE: 'installed-catalog-unavailable',
});

// Size is checked on the open descriptor before any byte is decoded, so an
// oversized file is a named state and never a parser input.
function readBounded(file, maxBytes = REPORT_MAX_BYTES) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { state: 'unreadable' };
    if (stat.size > maxBytes) return { state: 'oversize' };
    const buffer = Buffer.alloc(stat.size);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    return { state: 'read', text: buffer.subarray(0, total).toString('utf8') };
  } catch (error) {
    return { state: error && error.code === 'ENOENT' ? 'absent' : 'unreadable' };
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (_) { /* read already settled */ } }
  }
}
function parseObject(text) {
  try {
    const value = JSON.parse(String(text).replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) { return null; }
}
function catalogEligible(catalog) {
  // The canonical semantic validator only consumes the schema's host enum.
  // Use the canonical runtime registry, without requiring schemas/ in a
  // configuration-only projection or duplicating capability validation here.
  try { return require('./forge-capabilities').validateCatalog(catalog, { $defs: { host: { enum: HOST_RUNTIMES } } }).length === 0; }
  catch (_) { return false; }
}
// Catalog identity read tolerantly from the repository's forge-capabilities.json.
// loadCatalog is not used: it also requires schemas/, which configuration-only
// sources do not carry. An absent, oversized or malformed catalog is its own
// explicit state, never an empty classification that could look current.
function catalogSource(repo) {
  const read = readBounded(path.join(repo, 'forge-capabilities.json'));
  const catalog = read.state === 'read' ? parseObject(read.text) : null;
  let rows = null;
  if (catalogEligible(catalog)) {
    try { rows = require('./forge-capabilities').matrix(catalog); } catch (_) { rows = null; }
  }
  if (!rows) return { source: { catalog: 'unavailable', catalog_sha256: null, catalog_schema_version: null }, capabilities: null };
  return {
    source: {
      catalog: 'available',
      catalog_sha256: ownership.digest(read.text),
      catalog_schema_version: typeof catalog.schema_version === 'string' ? catalog.schema_version : null,
    },
    capabilities: rows.map((row) => ({ capability_id: row.capability_id, kind: row.kind, required: row.required, codex: row.codex })),
  };
}
function buildCapabilitiesReport(repo, manifest) {
  const catalog = catalogSource(repo);
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    forge_source: REPORT_SOURCE,
    generated: true,
    runtime: RUNTIME,
    core_version: VERSION,
    // Legacy mirror: readers that predate schema 2 only know `version`.
    version: VERSION,
    generator: REPORT_GENERATOR,
    source: { ...catalog.source, source_manifest_sha256: ownership.digest(sourceManifest.normalize(manifest)) },
    capabilities: catalog.capabilities,
    surfaces: manifest.sources.map((source) => ({ source_id: source.source_id, status: source.conditional && source.conditional.codex ? source.conditional.codex.status : 'common' })),
    permissions: REPORT_PERMISSIONS,
  };
}
// Shape recognition shared by ownership and freshness. Only two shapes are a
// Forge-generated report: the exact legacy key set, or schema 2 carrying its
// source and generator identity. runtime codex + generated true is necessary,
// never sufficient, and nothing above REPORT_MAX_BYTES is parsed at all.
function classifyReport(text) {
  if (Buffer.byteLength(String(text), 'utf8') > REPORT_MAX_BYTES) return { shape: null, reason: FRESHNESS_REASON.OVERSIZE };
  const value = parseObject(text);
  if (!value) return { shape: null, reason: FRESHNESS_REASON.UNREADABLE_JSON };
  if (value.runtime !== RUNTIME) return { shape: null, reason: FRESHNESS_REASON.WRONG_RUNTIME, value };
  if (value.generated !== true) return { shape: null, reason: FRESHNESS_REASON.NOT_GENERATED, value };
  const keys = Object.keys(value).sort();
  const exactKeys = (item, expected) => item && typeof item === 'object' && !Array.isArray(item)
    && isDeepStrictEqual(Object.keys(item).sort(), expected.slice().sort());
  const version = (item) => typeof item === 'string' && /^\d+\.\d+\.\d+$/.test(item);
  const digest = (item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  const id = (item) => typeof item === 'string' && /^[a-z][a-z0-9-]*$/.test(item);
  const capabilityContract = require('./forge-capabilities');
  const surfaces = Array.isArray(value.surfaces) && value.surfaces.every((surface) => exactKeys(surface, ['source_id', 'status'])
    && id(surface.source_id) && capabilityContract.AVAILABILITY.includes(surface.status));
  if (keys.length === LEGACY_REPORT_KEYS.length && keys.every((key, index) => key === LEGACY_REPORT_KEYS[index])
    && version(value.version) && surfaces) {
    return { shape: 'legacy', reason: null, value };
  }
  const source = value.source;
  const sourceShape = exactKeys(source, ['catalog', 'catalog_sha256', 'catalog_schema_version', 'source_manifest_sha256'])
    && digest(source.source_manifest_sha256)
    && ((source.catalog === 'available' && digest(source.catalog_sha256) && version(source.catalog_schema_version))
      || (source.catalog === 'unavailable' && source.catalog_sha256 === null && source.catalog_schema_version === null));
  const rows = value.capabilities;
  const rowShape = sourceShape && (source.catalog === 'unavailable' ? rows === null
    : Array.isArray(rows) && rows.length > 0 && new Set(rows.map((row) => row && row.capability_id)).size === rows.length
      && rows.every((row) => exactKeys(row, ['capability_id', 'kind', 'required', 'codex']) && id(row.capability_id)
        && capabilityContract.KINDS.includes(row.kind) && typeof row.required === 'boolean' && capabilityContract.AVAILABILITY.includes(row.codex)));
  if (exactKeys(value, CURRENT_REPORT_KEYS) && value.report_schema_version === REPORT_SCHEMA_VERSION
    && value.forge_source === REPORT_SOURCE && value.generator === REPORT_GENERATOR
    && version(value.core_version) && value.version === value.core_version && sourceShape && rowShape && surfaces
    && isDeepStrictEqual(value.permissions, REPORT_PERMISSIONS)) {
    return { shape: 'current', reason: null, value };
  }
  return { shape: null, reason: FRESHNESS_REASON.UNRECOGNIZED_SHAPE, value };
}
function isGeneratedReport(text) { return classifyReport(text).shape !== null; }
function installedVersionOf(forgeHome, version) {
  if (typeof version === 'string' && version.trim()) return version.trim();
  const read = readBounded(path.join(forgeHome, 'VERSION'), 64);
  const value = read.state === 'read' ? read.text.trim() : '';
  return /^\d+\.\d+\.\d+$/.test(value) ? value : VERSION;
}
/**
 * Read-only freshness of the installed Codex capabilities report.
 * current: schema 2, core_version equals the installed VERSION and catalog_sha256
 * equals the digest of the installed forge-capabilities.json. A catalog that is
 * unavailable on either side cannot prove freshness, so it is stale and named.
 * The result carries relative paths only.
 */
function inspectCapabilitiesReport(options = {}) {
  const forgeHome = path.resolve(options.forgeHome || require('./forge-home').resolveForgeHome({ env: options.env, userHome: options.userHome }));
  const installedVersion = installedVersionOf(forgeHome, options.version);
  const result = (state, reasons, extra = {}) => ({ report: REPORT_RELATIVE, state, reasons, installed_version: installedVersion, ...extra });
  const read = readBounded(path.join(forgeHome, ...REPORT_RELATIVE.split('/')));
  if (read.state === 'absent') return result(FRESHNESS.absent, [FRESHNESS_REASON.REPORT_ABSENT]);
  if (read.state === 'oversize') return result(FRESHNESS.invalid, [FRESHNESS_REASON.OVERSIZE]);
  if (read.state !== 'read') return result(FRESHNESS.invalid, [FRESHNESS_REASON.UNREADABLE_JSON]);
  const classified = classifyReport(read.text);
  if (!classified.shape) return result(FRESHNESS.invalid, [classified.reason]);
  const report = classified.value;
  const coreVersion = classified.shape === 'legacy' ? report.version : report.core_version;
  const reasons = [];
  if (classified.shape === 'legacy') reasons.push(FRESHNESS_REASON.LEGACY_SHAPE);
  if (coreVersion !== installedVersion) reasons.push(FRESHNESS_REASON.CORE_VERSION_MISMATCH);
  const installedCatalog = readBounded(path.join(forgeHome, 'forge-capabilities.json'));
  const installedCatalogSha = installedCatalog.state === 'read' && catalogEligible(parseObject(installedCatalog.text)) ? ownership.digest(installedCatalog.text) : null;
  const reportCatalogSha = classified.shape === 'current' && report.source.catalog === 'available' && typeof report.source.catalog_sha256 === 'string'
    ? report.source.catalog_sha256 : null;
  if (classified.shape === 'current') {
    if (!reportCatalogSha) reasons.push(FRESHNESS_REASON.CATALOG_UNAVAILABLE);
    else if (!installedCatalogSha) reasons.push(FRESHNESS_REASON.INSTALLED_CATALOG_UNAVAILABLE);
    else if (reportCatalogSha !== installedCatalogSha) reasons.push(FRESHNESS_REASON.CATALOG_DIGEST_MISMATCH);
  }
  return result(reasons.length ? FRESHNESS.stale : FRESHNESS.current, reasons, {
    shape: classified.shape,
    core_version: typeof coreVersion === 'string' ? coreVersion : null,
    catalog_sha256: reportCatalogSha,
    installed_catalog_sha256: installedCatalogSha,
  });
}
function render(options = {}) {
  const root = roots(options); const manifest = manifestFor(root, options); const sources = codexSources(manifest); const artifacts = [];
  // Legacy inventories without procedures remain valid. A current source cannot
  // silently downgrade itself by removing the mandatory surface declaration.
  const declaresProcedures = manifest.sources.some(source => source.source_id === 'procedures');
  if (!declaresProcedures && fs.existsSync(path.join(root.repo, 'shared/forge-procedures.json'))) {
    throw new Error('procedure-inventory-missing: current source requires the procedures surface');
  }
  const sourceProcedures = declaresProcedures ? loadAllProcedureContexts({ cwd: root.repo, forgeHome: root.repo }) : [];
  const procedureContext = declaresProcedures
    ? loadAllProcedureContexts({ cwd: root.projectRoot, forgeHome: root.repo,
      requiredPhases: sourceProcedures.map(procedure => procedure.phase) }).find(context => context.phase === 'distribution') : null;
  const add = (sourceId, source, destination, content, kind) => artifacts.push({ source_id: sourceId, source, destination, content: norm(content), newline: 'lf', kind });
  // Reuse the canonical trusted-authority contract from forge-interaction; never mint consent here.
  const rewriteMarkdown = (content) => interaction.project(rewriteDispatchDialect(content, {
    agentInvocation: options.agentInvocation,
    hostRuntime: options.hostRuntime,
  }));
  const common = sources.filter((source) => ['agents', 'commands', 'skills', 'dispatch-templates'].includes(source.source_id));
  const agents = sources.find((source) => source.source_id === 'agents');
  const agentFiles = agents ? walk(path.join(root.repo, agents.inputs[0])).filter((file) => file.endsWith('.md')) : [];
  const instructions = [ORIGIN, `# Forge Agent ${VERSION} — Codex host`, '', 'Estas instruções são geradas a partir das fontes canônicas do Forge.', '', '## Superfícies comuns', ...common.map((source) => `- ${source.source_id}: ${source.capability}`), '', '## Agentes customizados', ...agentFiles.map((file) => `- ${path.basename(file, '.md')}: .codex/agents/${path.basename(file, '.md')}.toml`), '', '## Skills e comandos', '- Conteúdo canônico materializado em `$CODEX_HOME/skills`, `$CODEX_HOME/commands` e `$CODEX_HOME/templates/dispatch`.', ''].join('\n');
  // Standing contracts come from the single projector, never a second copy: the
  // managed block owns routing, personal, entry and communication together, so
  // the installer's later sync replaces that same span without duplicate prose.
  const standing = require('./forge-instructions');
  add('codex-instructions', 'AGENTS.md', path.join(root.projectRoot, 'AGENTS.md'), interaction.project(instructions + '\n' + standing.renderBlock() + '\n'), 'instructions');
  for (const file of agentFiles) {
    const name = path.basename(file, '.md');
    const source = rewriteMarkdown(fs.readFileSync(file, 'utf8'));
    const config = [tomlOrigin(`agent-${name}`), `name = "${name}"`, `description = "Forge ${name.replace(/^forge-/, '')} worker"`, AGENT_SANDBOX_COMMENT, 'sandbox_mode = "workspace-write"', 'developer_instructions = """', tomlMultiline(source), '"""', ''].join('\n');
    add('agents', path.relative(root.repo, file).replace(/\\/g, '/'), path.join(root.codexHome, 'agents', `${name}.toml`), config, 'agent');
  }
  const commandSource = sources.find((source) => source.source_id === 'commands');
  if (commandSource) for (const file of walk(path.join(root.repo, commandSource.inputs[0])).filter((item) => item.endsWith('.md'))) {
    add('commands', path.relative(root.repo, file).replace(/\\/g, '/'), path.join(root.codexHome, 'commands', path.basename(file)), withOrigin(rewriteMarkdown(fs.readFileSync(file, 'utf8'))), 'command');
  }
  const skillsSource = sources.find((source) => source.source_id === 'skills');
  if (skillsSource) for (const file of walk(path.join(root.repo, skillsSource.inputs[0])).filter((item) => /SKILL\.md$/i.test(item))) {
    const relative = path.relative(path.join(root.repo, skillsSource.inputs[0]), file);
    add('skills', path.relative(root.repo, file).replace(/\\/g, '/'), path.join(root.codexHome, 'skills', relative), withOrigin(rewriteMarkdown(fs.readFileSync(file, 'utf8'))), 'skill');
  }
  const dispatchSource = sources.find((source) => source.source_id === 'dispatch-templates');
  if (dispatchSource) for (const file of walk(path.join(root.repo, dispatchSource.inputs[0])).filter((item) => item.endsWith('.md'))) {
    add('dispatch-templates', path.relative(root.repo, file).replace(/\\/g, '/'), path.join(root.codexHome, 'templates', 'dispatch', path.basename(file)), `${ORIGIN}\n\n${norm(rewriteMarkdown(fs.readFileSync(file, 'utf8')))}`, 'dispatch');
  }
  const config = `${tomlOrigin('config')}\n[forge]\nversion = "${VERSION}"\nhost_runtime = "codex"\nsource_manifest = "forge-source-manifest.json"\n\n[tui]\nstatus_line = ${JSON.stringify(DEFAULT_STATUS_LINE)}\n`;
  add('codex-config', 'config.toml', path.join(root.codexHome, 'config.toml'), config, 'config');
  const capabilities = buildCapabilitiesReport(root.repo, manifest);
  add('codex-capabilities', 'forge-codex-capabilities.json', path.join(root.forgeHome, ...REPORT_RELATIVE.split('/')), `${JSON.stringify(capabilities, null, 2)}\n`, 'capabilities');
  artifacts.sort((a, b) => a.destination.localeCompare(b.destination));
  return { runtime: RUNTIME, version: VERSION, repo: root.repo, forge_home: root.forgeHome, codex_home: root.codexHome, project_root: root.projectRoot, procedure_context: procedureContext, artifacts };
}
function write(options = {}) {
  const report = render(options);
  const questionCapability = questions.probe(options);
  report.question_capability = questionCapability;
  const written = []; const preserved = []; const conflicts = []; const selfSourced = [];
  // Same ownership rule as the Claude renderer, from the same module. This host
  // projects `capabilities.json`, a format that can never carry a marker — so
  // without the digest rung that file froze on first divergence exactly like the
  // Claude-side JSON did, and each run reported success over it.
  // The digest rung alone did not close it: a report that was already divergent
  // has no record, and its synthetic `source` has no release history. For that
  // one kind the recognized generated shape plays the marker's role (issue 280);
  // any other bytes at that path, and every other kind, keep the existing rungs.
  const recorded = (options.ownership && typeof options.ownership === 'object') ? options.ownership : {};
  // Same release rung as the Claude host. Most Codex artifacts are SYNTHESIZED
  // (the TOML wrappers, the instructions, `capabilities.json`), so their `source`
  // is not a repo file and provenance answers `no-source` — named, not silent.
  // The file-derived surfaces (commands, skills) get the real check.
  const provenance = options.provenance === null
    ? null
    : (options.provenance || PROVENANCE.createResolver({ repo: report.repo }));
  for (const artifact of report.artifacts) {
    // Same guard, same module as the Claude host, ahead of every ownership rung
    // for the same reason (§ forge-projection-self). No Codex artifact is
    // self-sourced TODAY — the instructions and the TOML wrappers are
    // synthesized, so their `source` names no file — but `projectRoot` defaults
    // to the repo here too, so the shape is one manifest edit away.
    if (selfProjection.isSelfProjection({ repo: report.repo, source: artifact.source, destination: artifact.destination })) {
      selfSourced.push({ ...artifact, reason: selfProjection.REASON });
      continue;
    }
    const current = exists(artifact.destination) ? fs.readFileSync(artifact.destination, 'utf8') : null;
    // config.toml is shared with the operator, even if an older Forge renderer
    // put an ownership marker on it. Only add an absent status-line default;
    // never replace their models, providers, MCPs, or later /statusline choices.
    if (artifact.kind === 'config' && current !== null) {
      const statusLine = addDefaultStatusLine(current);
      const questionDefault = questions.addDefaultQuestions(statusLine.content, questionCapability);
      const merged = { ...statusLine, content: questionDefault.content };
      artifact.question_reason = questionDefault.reason;
      for (const change of [statusLine, questionDefault]) {
        if (change.conflict) conflicts.push({ destination: artifact.destination, reason: change.reason });
      }
      artifact.content = merged.content;
      artifact.newline = current.includes('\r\n') ? 'crlf' : 'lf';
      if (merged.content === current) {
        preserved.push({ ...artifact, reason: merged.reason });

      } else {
        if (!options.dryRun) fs.writeFileSync(artifact.destination, merged.content, 'utf8');
        written.push({ ...artifact, reason: merged.reason, ...(options.dryRun ? { dry_run: true } : {}) });
      }
      continue;
    }
    if (artifact.kind === 'config') {
      const questionDefault = questions.addDefaultQuestions(artifact.content, questionCapability);
      artifact.content = questionDefault.content;
      artifact.question_reason = questionDefault.reason;
    }
    if (current !== null && norm(current) === artifact.content) { preserved.push({ ...artifact, reason: 'already-current' }); continue; }
    const verdict = ownership.decide({
      current,
      recordedDigest: recorded[ownership.keyFor(artifact.destination)],
      markerPresent: current !== null && (artifact.kind === 'capabilities' ? isGeneratedReport(current) : hasOrigin(current)),
      migrateLegacy: Boolean(options.update && options.migrateLegacy),
      releaseDigests: provenance ? () => provenance.digestsFor(artifact.source) : undefined,
    });
    if (!verdict.ours) {
      const checked = provenance
        ? provenance.verdictFor(artifact.source, current)
        : { reason: PROVENANCE.REASONS.NOT_CONSULTED, revisions: 0, truncated: false };
      preserved.push({ ...artifact, reason: REASON.user_owned });
      conflicts.push({
        destination: artifact.destination,
        reason: REASON.user_owned,
        digest: ownership.digest(current),
        provenance: checked.reason,
        revisions_checked: checked.revisions,
        ...(checked.truncated ? { provenance_truncated: true } : {}),
      });
      continue;
    }
    if (options.dryRun) { written.push({ ...artifact, dry_run: true }); continue; }
    fs.mkdirSync(path.dirname(artifact.destination), { recursive: true }); fs.writeFileSync(artifact.destination, artifact.content, 'utf8');
    if (verdict.basis === 'release') written.push({ ...artifact, reason: 'release-adopted' });
    else if (artifact.kind === 'capabilities' && verdict.basis === 'marker') written.push({ ...artifact, reason: 'generated-report-adopted' });
    else written.push(artifact);
  }
  const ownedNow = [...written, ...preserved.filter((item) => item.reason === 'already-current')];
  const nextOwnership = { ...recorded, ...ownership.recordOf(ownedNow) };
  return { ...report, written, preserved, conflicts, self_sourced: selfSourced, ownership: options.dryRun ? recorded : nextOwnership, changed: written.some((item) => !item.dry_run), dry_run: Boolean(options.dryRun) };
}
function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    repo: path.resolve(__dirname, '..'),
    ...PRODUCTION_DISPATCH_DIALECT,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--codex-home') out.codexHome = argv[++i];
    else if (arg === '--forge-home') out.forgeHome = argv[++i];
    else if (arg === '--project-root') out.projectRoot = argv[++i];
    else if (arg === '--manifest') out.manifestFile = argv[++i];
    else if (arg === '--agent-invocation') out.agentInvocation = argv[++i];
    else if (arg === '--host-runtime') out.hostRuntime = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--inspect-report') out.inspectReport = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw Object.assign(new Error(`opção desconhecida: ${arg}`), { code: REASON.invalid_options });
  }
  // The CLI defaults are production values, but explicit overrides remain a
  // useful black-box test seam. Refuse missing/empty overrides before rendering,
  // even when a particular repository happens not to contain dispatch markers.
  if (typeof out.agentInvocation !== 'string' || out.agentInvocation.length === 0) {
    failDispatch(DISPATCH_REASON.AGENT_FORM_REQUIRED, 'agentInvocation não vazio é obrigatório');
  }
  if (typeof out.hostRuntime !== 'string' || out.hostRuntime.length === 0) {
    failDispatch(DISPATCH_REASON.HOST_RUNTIME_INVALID, 'hostRuntime precisa ser string não vazia');
  }
  return out;
}
function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), error = process.stderr.write.bind(process.stderr)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      output('Usage: forge-codex-renderer.js [--repo DIR] [--codex-home DIR] [--forge-home DIR] [--project-root DIR] [--agent-invocation PREFIX] [--host-runtime HOST] [--dry-run] [--json]\n'
        + '       forge-codex-renderer.js --inspect-report [--forge-home DIR] [--json]\n');
      return 0;
    }
    // Read-only branch: never renders, never writes. Exit 0 only for current.
    if (options.inspectReport) {
      const inspection = inspectCapabilitiesReport({ forgeHome: options.forgeHome });
      output(options.json ? `${JSON.stringify(inspection)}\n`
        : `Codex capabilities report: ${inspection.state}${inspection.reasons.length ? ` (${inspection.reasons.join(', ')})` : ''}`
          + `${inspection.core_version ? ` core ${inspection.core_version}` : ''}; installed ${inspection.installed_version}\n`);
      return inspection.state === FRESHNESS.current ? 0 : 1;
    }
    const report = write(options);
    output(options.json ? `${JSON.stringify(report)}\n` : `Codex renderer ${VERSION}: ${report.written.length} written, ${report.preserved.length} preserved\n`);
    return 0;
  } catch (e) {
    error(`forge-codex-renderer: ${e.code || 'error'}: ${e.message}\n`);
    return 1;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = {
  VERSION,
  RUNTIME,
  PRODUCTION_DISPATCH_DIALECT,
  REASON,
  ORIGIN,
  DISPATCH_MARKER_START,
  DISPATCH_MARKER_END,
  DISPATCH_REASON,
  scanDispatchMarkers,
  locateDispatchBlock,
  rewriteDispatchDialect,
  REPORT_SCHEMA_VERSION,
  REPORT_RELATIVE,
  REPORT_MAX_BYTES,
  REPORT_PERMISSIONS,
  PERMISSIONS_CONTRACT,
  AGENT_SANDBOX_COMMENT,
  FRESHNESS,
  FRESHNESS_REASON,
  buildCapabilitiesReport,
  classifyReport,
  isGeneratedReport,
  inspectCapabilitiesReport,
  render,
  write,
  parseArgs,
  main,
};
