#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolvePreferencePaths } = require('./forge-home.js');

// Markdown catalogs are intentionally not parsed by this engine. Their exact
// descriptor filenames remain below for cache invalidation and structured
// migration diagnostics. The migration utility alone owns the isolated
// Markdown reader, keeping normal preference resolution read-only and JSONC-only.

/**
 * JSONC preference-file tokenizer.
 *
 * This module intentionally has zero dependencies: future additions may use only
 * Node's fs, path, and os built-ins.  Comment handling is a hand-written state
 * machine, never a regular expression, so URLs and escape sequences in strings
 * are safe.  The eventual CLI exits non-zero for parse errors (unlike the
 * exit-zero forge-routing and forge-review-pairing sibling CLIs); that CLI lands
 * in T04, while this module is deliberately parser-only.
 */

const NORMAL = 'normal';
const IN_STRING = 'in-string';
const ESCAPE = 'escape';
const LINE_COMMENT = 'line-comment';
const BLOCK_COMMENT = 'block-comment';

function lineAt(text, end) {
  let line = 1;
  for (let index = 0; index < end; index++) {
    if (text[index] === '\n') {
      line++;
    } else if (text[index] === '\r' && text[index + 1] !== '\n') {
      line++;
    }
  }
  return line;
}

/**
 * First pass: replace comments, rather than deleting them, to retain offsets.
 * The returned error is private to parseJsonc; the public stripJsonc API stays
 * string-shaped for callers that only need the normalized JSON text.
 */
function scanJsonc(text) {
  let state = NORMAL;
  let output = '';
  let line = 1;
  let startLine = 1;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];

    if (index === 0 && character === '\uFEFF') {
      output += ' ';
      continue;
    }

    if (state === NORMAL) {
      if (character === '"') {
        output += character;
        state = IN_STRING;
        startLine = line;
      } else if (character === '/' && next === '/') {
        output += ' ';
        state = LINE_COMMENT;
      } else if (character === '/' && next === '*') {
        output += ' ';
        state = BLOCK_COMMENT;
        startLine = line;
      } else {
        output += character;
      }
    } else if (state === IN_STRING) {
      output += character;
      if (character === '\\') {
        // ESCAPE consumes exactly the next code unit, including a quote.
        state = ESCAPE;
      } else if (character === '"') {
        state = NORMAL;
      }
    } else if (state === ESCAPE) {
      output += character;
      state = IN_STRING;
    } else if (state === LINE_COMMENT) {
      if (character === '\n' || character === '\r') {
        // Keep the line ending and resume normal JSON scanning.
        output += character;
        state = NORMAL;
      } else {
        output += ' ';
      }
    } else {
      // BLOCK_COMMENT: retain line breaks, blank every other character.
      if (character === '*' && next === '/') {
        // Consume both delimiter characters while preserving their two offsets.
        output += '  ';
        index++;
        state = NORMAL;
      } else if (character === '\n' || character === '\r') {
        output += character;
      } else {
        output += ' ';
      }
    }

    if (character === '\n') line++;
    else if (character === '\r' && next !== '\n') line++;
  }

  if (state === IN_STRING || state === ESCAPE) {
    return { text: output, error: { line: startLine, message: 'Unterminated string' } };
  }
  if (state === BLOCK_COMMENT) {
    return { text: output, error: { line: startLine, message: 'Unterminated block comment' } };
  }
  return { text: output, error: null };
}

function isJsonWhitespace(character) {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

/**
 * Second pass removes commas only when the next JSON token closes a container.
 * It is separately string-aware so literal commas inside quoted values survive.
 */
function removeTrailingCommas(text) {
  const characters = text.split('');
  let state = NORMAL;

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (state === IN_STRING) {
      if (character === '\\') state = ESCAPE;
      else if (character === '"') state = NORMAL;
      continue;
    }
    if (state === ESCAPE) {
      state = IN_STRING;
      continue;
    }
    if (character === '"') {
      state = IN_STRING;
      continue;
    }
    if (character !== ',') continue;

    let lookahead = index + 1;
    while (lookahead < characters.length && isJsonWhitespace(characters[lookahead])) lookahead++;
    if (characters[lookahead] === '}' || characters[lookahead] === ']') characters[index] = ' ';
  }
  return characters.join('');
}

function stripJsonc(text) {
  if (typeof text !== 'string') throw new TypeError('JSONC input must be a string');
  return removeTrailingCommas(scanJsonc(text).text);
}

function parseJsonc(text, opts) { // opts is reserved for future parser policy.
  if (typeof text !== 'string') {
    return { ok: false, value: undefined, error: { line: null, message: 'JSONC input must be a string' } };
  }
  const scanned = scanJsonc(text);
  if (scanned.error) return { ok: false, value: undefined, error: scanned.error };

  const stripped = removeTrailingCommas(scanned.text);
  if (stripped.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const positionMatch = /position\s+(\d+)/i.exec(message);
    const messageLineMatch = /line\s+(\d+)\s+column\s+\d+/i.exec(message);
    const position = positionMatch ? Number(positionMatch[1]) : null;
    // Newer V8 releases sometimes provide line/column instead of an offset.
    // Both derive from the shape-preserved string and therefore match source.
    const line = position !== null
      ? lineAt(text, position)
      : (messageLineMatch ? Number(messageLineMatch[1]) : null);
    return {
      ok: false,
      value: undefined,
      error: { line, message },
    };
  }
}

// ── Two-layer preference resolution ───────────────────────────────────────
// A layer chooses exactly one format.  JSONC shadows every Markdown file in
// that same layer; this prevents a partially migrated layer from being mixed.
const ATOMIC_KEYS = ['routing'];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Merge user preferences without mutating either input.
 *
 * Normal objects merge recursively.  Arrays, null, and type changes are
 * replacements.  routing is intentionally different: forge-routing.js uses
 * last-wins per whole domain, so a newer routing.backend replaces the older
 * routing.backend rather than inheriting omitted phases from it.
 */
function deepMerge(base, over, depth) {
  const currentDepth = depth || 0;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;

  const merged = Object.assign({}, base);
  for (const key of Object.keys(over)) {
    const next = over[key];
    const previous = base[key];
    if (ATOMIC_KEYS.includes(key) && currentDepth === 0 &&
      isPlainObject(previous) && isPlainObject(next)) {
      const routing = Object.assign({}, previous);
      for (const domain of Object.keys(next)) routing[domain] = next[domain];
      merged[key] = routing;
    } else if (isPlainObject(previous) && isPlainObject(next)) {
      merged[key] = deepMerge(previous, next, currentDepth + 1);
    } else {
      // Includes arrays and explicit null: both replace rather than merge.
      merged[key] = next;
    }
  }
  return merged;
}

function existingFiles(files) {
  return files.filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function resolveLayer(jsoncFile, markdownFiles, errors, cwd, descriptor) {
  const candidates = descriptor && Array.isArray(descriptor.jsoncCandidates)
    ? descriptor.jsoncCandidates
    : [jsoncFile];
  const presentJsonc = existingFiles(candidates);
  if (presentJsonc.length > 0) {
    const resolvedJsonc = presentJsonc[0];
    let raw;
    try {
      raw = fs.readFileSync(resolvedJsonc, 'utf8');
    } catch (error) {
      errors.push({ file: resolvedJsonc, line: null, message: error.message });
      return { prefs: {}, source: 'jsonc', files: [resolvedJsonc] };
    }
    const parsed = parseJsonc(raw);
    if (!parsed.ok) {
      errors.push({ file: resolvedJsonc, line: parsed.error.line, message: parsed.error.message });
      // A broken JSONC layer contributes nothing.  In particular, do not fall
      // back to its Markdown files: JSONC's shadow remains in force.
      return { prefs: {}, source: 'jsonc', files: [resolvedJsonc] };
    }
    return { prefs: parsed.value, source: 'jsonc', files: [resolvedJsonc] };
  }

  const files = existingFiles(markdownFiles);
  if (files.length === 0) {
    return { prefs: {}, source: 'absent', files };
  }
  const migrate = path.join(__dirname, 'forge-prefs-migrate.js');
  errors.push({
    file: files[0],
    line: null,
    code: 'legacy-md-without-jsonc',
    message: `Preferências Markdown legadas encontradas: ${files.join(', ')}. Rode: node "${migrate}" --cwd "${cwd}"`,
  });
  return {
    prefs: {},
    source: 'md-blocked',
    files,
  };
}

/**
 * Canonical per-layer file lists — the ONLY production declaration of the
 * legacy preference filenames (guarded by smoke Section 39e). Consumers such
 * as forge-prefs-migrate.js import this instead of re-declaring paths.
 * `opts.globalDir` / `opts.localDir` exist for test isolation (never touch the
 * operator's real runtime home from a test).
 */
function preferenceLayerDescriptors(cwd, opts) {
  const options = opts || {};
  const paths = resolvePreferencePaths(cwd || process.cwd(), options);
  return [
    {
      name: 'global',
      jsoncPath: paths.canonical.jsoncPath,
      jsoncCandidates: paths.jsoncCandidates,
      mdFiles: paths.mdCandidates,
      legacyMdFiles: paths.legacyMdFiles,
      legacyJsoncPath: paths.legacy && paths.legacy.jsoncPath,
    },
    {
      name: 'local',
      jsoncPath: paths.local.jsoncPath,
      jsoncCandidates: [paths.local.jsoncPath],
      mdFiles: paths.local.mdFiles,
      legacyMdFiles: [],
    },
  ];
}

/**
 * Resolve global preferences then project-local preferences.  No cache is
 * created: callers always receive an in-memory result for the current files.
 */
function readPrefs(cwd, opts) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const errors = [];
  const [globalDescriptor, localDescriptor] = preferenceLayerDescriptors(targetCwd, opts);
  const globalLayer = resolveLayer(globalDescriptor.jsoncPath, globalDescriptor.mdFiles, errors, targetCwd, globalDescriptor);
  // R3 fix (S04 review): `--global-only` skips the local layer entirely, so
  // callers that must resolve a per-operator setting (e.g. `app.*` in the
  // desktop app) never let a project-local .gsd/ override it, regardless of
  // which directory the host process happens to be running from.
  if (opts && opts.globalOnly) {
    return {
      ok: errors.length === 0,
      prefs: globalLayer.prefs,
      errors,
      layers: {
        global: { source: globalLayer.source, files: globalLayer.files },
        local: { source: 'absent', files: [] },
      },
    };
  }
  const localLayer = resolveLayer(localDescriptor.jsoncPath, localDescriptor.mdFiles, errors, targetCwd, localDescriptor);
  const merged = deepMerge(globalLayer.prefs, localLayer.prefs);
  return {
    ok: errors.length === 0,
    prefs: merged,
    errors,
    layers: {
      global: { source: globalLayer.source, files: globalLayer.files },
      local: { source: localLayer.source, files: localLayer.files },
    },
  };
}

// Process-local hot-path memo. The preference files remain the source of
// truth; this cache never writes a resolved snapshot to disk.
const prefsCache = new Map();

function preferenceLayerFiles(cwd) {
  const targetCwd = cwd || process.cwd();
  return preferenceLayerDescriptors(targetCwd).flatMap((layer) =>
    (layer.jsoncCandidates || [layer.jsoncPath]).concat(layer.mdFiles || []));
}

function preferenceFileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeNs || stat.mtimeMs}:${stat.size}:${stat.ino || ''}`;
  } catch {
    return 'absent';
  }
}

function readPrefsCached(cwd) {
  const targetCwd = cwd || process.cwd();
  const signature = preferenceLayerFiles(targetCwd).map(preferenceFileSignature).join('|');
  const cached = prefsCache.get(targetCwd);
  if (cached && cached.signature === signature) return cached.result;
  const result = readPrefs(targetCwd);
  prefsCache.set(targetCwd, { signature, result });
  return result;
}

// ── Generic advisory validator and CLI ────────────────────────────────────
// Validation is schema-driven and advisory: consumers retain their own
// defaults for invalid knobs. This engine never mutates or defaults prefs.
function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'object') return isPlainObject(value);
    if (type === 'null') return value === null;
    return jsonType(value) === type;
  });
}

function validationEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => validationEqual(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) && validationEqual(left[key], right[key]));
  }
  return false;
}

function validatePrefs(resolved, schema) {
  const warnings = [];
  if (!schema || typeof schema !== 'object') return warnings;
  function walk(value, node, parts) {
    if (!node || typeof node !== 'object') return;
    const key = parts.join('.') || '<root>';
    if (node.type !== undefined && !typeMatches(value, node.type)) {
      const expected = Array.isArray(node.type) ? node.type.join(' or ') : node.type;
      warnings.push({ key, message: `${key}: expected ${expected}, got ${jsonType(value)}` });
      return;
    }
    if (Array.isArray(node.enum) && !node.enum.some((item) => validationEqual(value, item))) {
      warnings.push({ key, message: `${key}: expected one of ${node.enum.map((item) => JSON.stringify(item)).join(', ')}` });
    }
    // `minimum` is ENFORCED here, not decorative. A schema keyword the
    // validator ignores makes the validated document lie: the three claim-gate
    // timings (`parallelism.block_{wait,poll}_ms`, `parallelism.defer_cap`) are
    // rejected at runtime when `<= 0` (forge-claim-gate.js positiveIntPref) and
    // silently fall back — so a prefs file that "validates" with `0` behaves as
    // the default (S04 review R8).
    if (typeof node.minimum === 'number' && typeof value === 'number' && value < node.minimum) {
      warnings.push({ key, message: `${key}: expected >= ${node.minimum}, got ${value}` });
    }
    if (!isPlainObject(value) || !isPlainObject(node.properties)) return;
    for (const childKey of Object.keys(value)) {
      const child = node.properties[childKey];
      const childPath = parts.concat(childKey).join('.');
      if (!child && node.additionalProperties !== true) {
        warnings.push({ key: childPath, message: `${childPath}: unknown preference key` });
      } else if (child) {
        walk(value[childKey], child, parts.concat(childKey));
      }
    }
  }
  walk(resolved, schema, []);
  // Domain names are open; the values still need the shape consumed by
  // forge-routing.resolveCell. A misplaced tier_models subtree is otherwise
  // silently accepted as a domain that can never select its intended model.
  if (schema.properties?.routing && isPlainObject(resolved?.routing)) {
    const tiers = new Set(['light', 'standard', 'heavy', 'max']);
    const warn = (key, expected) => warnings.push({ key, message: `${key}: ${expected}` });
    for (const [domain, phases] of Object.entries(resolved.routing)) {
      const prefix = `routing.${domain}`;
      if (!isPlainObject(phases)) { warn(prefix, 'expected a routing domain object'); continue; }
      for (const [phase, cells] of Object.entries(phases)) {
        const phaseKey = `${prefix}.${phase}`;
        if (phase !== 'executor' && phase !== 'planner') {
          warn(phaseKey, 'expected a routing phase (executor or planner), then tier arrays');
          continue;
        }
        if (!isPlainObject(cells)) { warn(phaseKey, 'expected a routing phase object'); continue; }
        for (const [tier, ids] of Object.entries(cells)) {
          const key = `${phaseKey}.${tier}`;
          if (tier === 'fallback') {
            if (ids !== null && (typeof ids !== 'string' || !ids.trim())) warn(key, 'expected a nonempty fallback model string or null');
          } else if (!tiers.has(tier)) warn(key, 'expected a routing tier (light, standard, heavy or max) or fallback');
          else if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) warn(key, 'expected an array of nonempty model strings');
        }
      }
    }
  }
  return warnings;
}

function loadSchema() {
  const schemaFile = path.join(__dirname, '..', 'forge-prefs.schema.json');
  try {
    return JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  } catch (error) {
    // The schema belongs to the installation. Missing or broken schema data
    // cannot turn into a user-facing parse error and is intentionally ignored.
    return null;
  }
}

function schemaLoadWarning() {
  const schemaFile = path.join(__dirname, '..', 'forge-prefs.schema.json');
  try {
    fs.accessSync(schemaFile, fs.constants.F_OK);
    JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    return null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { key: '<schema>', message: `forge-prefs.schema.json: ${error.message}` };
  }
}

// R3 fix: walk the leaf set of the MERGED result, not the raw global/local
// trees independently. deepMerge does whole-domain atomic replace for
// `routing` (and whole-subtree replace on any type conflict), so unioning the
// raw trees reports phantom leaves for paths absent from the merged result
// (e.g. a global-only routing.<domain>.<phase> under a locally-redefined
// domain). A leaf is attributed 'local' only when the identical dotted path
// resolves to the SAME value in the raw local tree; otherwise 'global'.
function buildProvenance(globalPrefs, localPrefs) {
  const merged = deepMerge(globalPrefs || {}, localPrefs || {});
  const result = {};
  function walk(value, parts) {
    if (!isPlainObject(value)) {
      if (parts.length > 0) {
        const key = parts.join('.');
        const local = getDottedValue(localPrefs || {}, key);
        result[key] = local.found && validationEqual(local.value, value) ? 'local' : 'global';
      }
      return;
    }
    for (const key of Object.keys(value)) walk(value[key], parts.concat(key));
  }
  walk(merged, []);
  return result;
}

function parseCliArgs(argv) {
  const args = { resolved: false, scaffold: false, setupScaffold: false, schemaRef: null, setActive: [], rescaffold: null, write: false, out: null, key: null, explain: false, cwd: process.cwd(), globalDir: null, localDir: null, globalOnly: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--resolved') args.resolved = true;
    else if (argv[index] === '--global-only') args.globalOnly = true;
    else if (argv[index] === '--scaffold') args.scaffold = true;
    else if (argv[index] === '--setup-scaffold') args.setupScaffold = true;
    else if (argv[index] === '--schema-ref') args.schemaRef = argv[++index] || '';
    else if (argv[index] === '--set-active') {
      const assignment = argv[++index] || '';
      const separator = assignment.indexOf('=');
      if (separator > 0) {
        const key = assignment.slice(0, separator);
        const rawValue = assignment.slice(separator + 1);
        let value;
        try { value = JSON.parse(rawValue); } catch { value = rawValue; }
        args.setActive.push([key, value]);
      }
    }
    else if (argv[index] === '--rescaffold') args.rescaffold = path.resolve(argv[++index] || '');
    else if (argv[index] === '--write') args.write = true;
    else if (argv[index] === '--out') args.out = path.resolve(argv[++index] || '');
    else if (argv[index] === '--explain') args.explain = true;
    else if (argv[index] === '--key') args.key = argv[++index] || '';
    else if (argv[index] === '--cwd') args.cwd = path.resolve(argv[++index] || process.cwd());
    // Test/round-trip isolation: point either layer at a scratch dir so the
    // migration proof can resolve the freshly-written file instead of the
    // operator's real runtime home. Mirrors preferenceLayerDescriptors' opts.
    else if (argv[index] === '--global-dir') args.globalDir = path.resolve(argv[++index] || '');
    else if (argv[index] === '--local-dir') args.localDir = path.resolve(argv[++index] || '');
  }
  return args;
}

function readProvenanceLayer(cwd, source, files) {
  if (source === 'jsonc') {
    try {
      const file = existingFiles(files)[0];
      if (!file) return {};
      const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
      return parsed.ok ? parsed.value : {};
    } catch { return {}; }
  }
  return {};
}

function getDottedValue(value, key) {
  if (!key) return { found: true, value };
  let current = value;
  for (const part of key.split('.')) {
    if (current === null || current === undefined ||
      !Object.prototype.hasOwnProperty.call(Object(current), part)) return { found: false, value: null };
    current = current[part];
  }
  return { found: true, value: current };
}

// Keep the cold scaffold dependency lazy: normal preference resolution remains
// independent from its renderer, while both scaffold actions share one import.
function loadScaffoldModule() {
  return require('./forge-prefs-scaffold.js');
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  if (args.rescaffold) {
    let existing;
    try {
      existing = fs.readFileSync(args.rescaffold, 'utf8');
    } catch (error) {
      process.stderr.write(`✗ prefs rescaffold error: ${args.rescaffold}: ${error.message}\n`);
      return 1;
    }
    const schema = loadSchema();
    if (!schema) return 1;
    const { rescaffoldCatalog } = loadScaffoldModule();
    let result;
    try {
      const schemaRef = path.relative(path.dirname(args.rescaffold), path.join(__dirname, '..', 'forge-prefs.schema.json')) || 'forge-prefs.schema.json';
      result = rescaffoldCatalog(existing, schema, { schemaRef: schemaRef.split(path.sep).join('/') });
    } catch (error) {
      process.stderr.write(`✗ prefs rescaffold error: ${error.message}\n`);
      return 1;
    }
    if (args.write) fs.writeFileSync(args.rescaffold, result.text, 'utf8');
    process.stdout.write(result.text);
    for (const warning of result.warnings) process.stderr.write(`⚠ ${warning.message}\n`);
    return 0;
  }
  if (args.scaffold) {
    const { generateScaffold } = loadScaffoldModule();
    const schema = loadSchema();
    if (!schema) return 1;
    const schemaRef = args.schemaRef || (args.out
      ? path.relative(path.dirname(args.out), path.join(__dirname, '..', 'forge-prefs.schema.json')) || path.basename(path.join(__dirname, '..', 'forge-prefs.schema.json'))
      : 'forge-prefs.schema.json');
    const output = generateScaffold(schema, { schemaRef: schemaRef.split(path.sep).join('/') });
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, output, 'utf8');
    }
    else process.stdout.write(output);
    return 0;
  }
  if (args.setupScaffold) {
    const schema = loadSchema();
    if (!schema) return 1;
    const schemaRef = args.schemaRef || (args.out
      ? path.relative(path.dirname(args.out), path.join(__dirname, '..', 'forge-prefs.schema.json')) || path.basename(path.join(__dirname, '..', 'forge-prefs.schema.json'))
      : 'forge-prefs.schema.json');
    const { generateSetupScaffold } = loadScaffoldModule();
    const activeValues = Object.fromEntries(args.setActive);
    const output = generateSetupScaffold(schema, { activeValues, schemaRef: schemaRef.split(path.sep).join('/') });
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, output, 'utf8');
    } else process.stdout.write(output);
    return 0;
  }
  if (!args.resolved) {
    const output = {
      ok: false,
      prefs: {},
      errors: [{ file: '<cli>', line: null, message: '--resolved is required' }],
      warnings: [],
      layers: { global: { source: 'absent', files: [] }, local: { source: 'absent', files: [] } },
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.stderr.write('✗ prefs CLI error: use --resolved para resolver as preferências\n');
    return 1;
  }
  const dirOpts = {};
  if (args.globalDir) dirOpts.globalDir = args.globalDir;
  if (args.localDir) dirOpts.localDir = args.localDir;
  if (args.globalOnly) dirOpts.globalOnly = true;
  const result = readPrefs(args.cwd, dirOpts);
  const warnings = validatePrefs(result.prefs, loadSchema());
  const schemaWarning = schemaLoadWarning();
  if (schemaWarning) warnings.push(schemaWarning);
  const output = { ok: result.errors.length === 0, prefs: result.prefs, errors: result.errors, warnings, layers: result.layers };
  if (args.explain) {
    const descriptors = preferenceLayerDescriptors(args.cwd, dirOpts);
    const globalDescriptor = descriptors.find((entry) => entry.name === 'global');
    const localDescriptor = descriptors.find((entry) => entry.name === 'local');
    output.provenance = buildProvenance(
      readProvenanceLayer(args.cwd, result.layers.global.source, globalDescriptor.jsoncCandidates.concat(globalDescriptor.mdFiles)),
      readProvenanceLayer(args.cwd, result.layers.local.source, [localDescriptor.jsoncPath].concat(localDescriptor.mdFiles)),
    );
  }
  if (args.key !== null) {
    const selected = getDottedValue(result.prefs, args.key);
    delete output.prefs;
    output.value = selected.value;
    if (!selected.found) output.warnings.push({ key: args.key, message: `${args.key}: key not found` });
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  for (const warning of output.warnings) process.stderr.write(`⚠ ${warning.message}\n`);
  for (const error of result.errors) {
    process.stderr.write(`✗ prefs parse error: ${error.file}:${error.line === null ? '?' : error.line} — ${error.message}\n`);
    process.stderr.write('corrija o JSONC\n');
  }
  return result.errors.length > 0 ? 1 : 0;
}

module.exports = {
  parseJsonc,
  stripJsonc,
  preferenceLayerDescriptors,
  readPrefs,
  readPrefsCached,
  deepMerge,
  validatePrefs,
  loadSchema,
  buildProvenance,
  runCli,
};

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
