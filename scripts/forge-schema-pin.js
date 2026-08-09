#!/usr/bin/env node
'use strict';

// Exports: canonicalize, projectSchema, generateSchema, checkDrift, diffValues.
// CLI: --generate-pin | --check [--schema-dir DIR] [--json]
//
// The app-server schema generator was marked [experimental] in codex-cli 0.144.4.
// On 2026-08-05 five measurements had distinct file hashes but the same 516
// definition keys.  Canonicalization below makes that ordering noise harmless.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTCOMES = new Set([
  'match', 'drift', 'generator-missing', 'generator-failed',
  'generator-output-shape-changed', 'pin-unreadable', 'inconclusive',
]);
const SCHEMA_FILE = 'codex_app_server_protocol.v2.schemas.json';

function pinPath() {
  // A literal file path, never a shell fragment, and only ever read via readJson —
  // it exists so the closed-enum degradation of an unreadable pin is reachable from
  // the CLI boundary the orchestrator actually invokes, not just from the module API.
  const override = process.env.FORGE_SCHEMA_PIN_FILE;
  if (override) return override;
  const candidates = [
    path.join(__dirname, '..', 'shared', 'schemas', 'codex-appserver-pin.json'),
    path.join(__dirname, '..', 'schemas', 'codex-appserver-pin.json'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function readJson(file) {
  // Do not require a file selected by argv/env: require can execute a .js file.
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function canonicalize(value, parentKey) {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    // JSON Schema required lists are sets; their source ordering is not meaningful.
    return parentKey === 'required' && items.every((item) => typeof item === 'string')
      ? items.sort()
      : items;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], key);
    return result;
  }
  return value;
}

function requiredFile(schemaDir, relative) {
  const file = path.join(schemaDir, relative);
  if (!fs.existsSync(file)) {
    const error = new Error(`expected schema file is absent: ${relative}`);
    error.code = 'SCHEMA_SHAPE_CHANGED';
    throw error;
  }
  return readJson(file);
}

function projectedType(schema) {
  // The adapter consumes the envelope and its fields, not every transitive type in
  // the generator's multi-megabyte schema.
  return {
    title: schema.title,
    type: schema.type,
    required: schema.required || [],
    properties: schema.properties || {},
  };
}

const REF_PREFIX = '#/definitions/';

// Every "$ref" string anywhere below `value`. Local pointers are the only form the
// generator emits today; a foreign one is returned verbatim so it can be NAMED as
// unresolved instead of quietly dropped.
function collectRefs(value, out) {
  const target = out || new Set();
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, target);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key === '$ref' && typeof value[key] === 'string') target.add(value[key]);
      else collectRefs(value[key], target);
    }
  }
  return target;
}

/**
 * Transitive closure of the types reachable from the projected roots.
 *
 * WHY THIS EXISTS, AND WHERE THE BOUNDARY SITS (read before shrinking it):
 * the roots keep `properties` verbatim, and those properties are `$ref` pointers.
 * Pinning a pointer is not pinning its target: renaming SandboxPolicy.networkAccess
 * or replacing CommandExecutionStatus' enum leaves every `$ref` string byte-identical,
 * so a roots-only pin returned `match` through both mutations (measured, S01 review R1).
 *
 * Stopping rule — DECLARED, not incidental: fixed point over reachability. Every
 * `#/definitions/<Name>` reachable from a root is pinned, transitively, with no depth
 * cap; nothing reachable is excluded. The boundary is reachability itself, because a
 * type the adapter cannot observe through these five entry points cannot change what
 * the adapter reads. A pointer that does not resolve is recorded by name in
 * `meta.unresolved_refs` — never dropped (D8).
 *
 * `#/definitions/X` is document-local by JSON Pointer, and the per-type files carry
 * their own `definitions` (JSONRPCError.json defines JSONRPCErrorError locally), so a
 * ref resolves against its defining document first and the aggregate second. The two
 * scopes are flattened into one map only because they do not disagree: 517 names across
 * the five documents, zero conflicting bodies (measured). A future conflict is a named
 * SCHEMA_SHAPE_CHANGED, never a silent overwrite.
 *
 * Measured cost of the closure at codex-cli 0.144.4: 42 referenced types, ~53 KB total
 * pin. B2 (pin a projection, never the 3.4 MB / 267-file raw generation) stays intact.
 */
function resolveReferences(roots, scopes) {
  const referenced = {};
  const unresolved = new Set();
  const resolvedIn = new Map();
  const rootNames = new Set(Object.keys(roots));
  // Pairs, not packed strings: a ref carries the scope that owns it, and no separator
  // character can collide with a document or pointer name.
  let frontier = [];
  for (const [name, root] of Object.entries(roots)) {
    for (const ref of collectRefs(root)) frontier.push({ owner: name, ref });
  }

  while (frontier.length) {
    const next = [];
    for (const { owner, ref } of frontier) {
      if (!ref.startsWith(REF_PREFIX)) { unresolved.add(ref); continue; }
      const name = ref.slice(REF_PREFIX.length);
      // A local scope wins over the aggregate; a root name is already pinned.
      const scope = scopes[owner] && Object.prototype.hasOwnProperty.call(scopes[owner], name)
        ? scopes[owner]
        : (Object.prototype.hasOwnProperty.call(scopes.__aggregate__ || {}, name) ? scopes.__aggregate__ : null);
      if (!scope) { unresolved.add(ref); continue; }
      const body = scope[name];
      if (resolvedIn.has(name)) {
        if (JSON.stringify(canonicalize(resolvedIn.get(name))) !== JSON.stringify(canonicalize(body))) {
          const error = new Error(`conflicting definitions for ${name} across schema documents`);
          error.code = 'SCHEMA_SHAPE_CHANGED';
          throw error;
        }
        continue;
      }
      resolvedIn.set(name, body);
      if (!rootNames.has(name)) referenced[name] = body;
      // A referenced type's own refs resolve in the scope that defined it.
      const scopeKey = scope === scopes.__aggregate__ ? '__aggregate__' : owner;
      for (const child of collectRefs(body)) next.push({ owner: scopeKey, ref: child });
    }
    frontier = next;
  }
  return { referenced, unresolved: Array.from(unresolved).sort() };
}

function projectSchema(schemaDir, options) {
  const opts = options || {};
  const aggregate = requiredFile(schemaDir, SCHEMA_FILE);
  const definitions = aggregate.definitions;
  if (!definitions || !definitions.ThreadItem || !Array.isArray(definitions.ThreadItem.oneOf)) {
    const error = new Error('ThreadItem.oneOf is absent from aggregate schema');
    error.code = 'SCHEMA_SHAPE_CHANGED';
    throw error;
  }
  const turnStart = requiredFile(schemaDir, path.join('v2', 'TurnStartParams.json'));
  const itemCompleted = requiredFile(schemaDir, path.join('v2', 'ItemCompletedNotification.json'));
  const turnCompleted = requiredFile(schemaDir, path.join('v2', 'TurnCompletedNotification.json'));
  const jsonRpcError = requiredFile(schemaDir, 'JSONRPCError.json');
  const variants = definitions.ThreadItem.oneOf.length;

  const roots = {
    ThreadItem: definitions.ThreadItem,
    TurnStartParams: projectedType(turnStart),
    ItemCompletedNotification: projectedType(itemCompleted),
    TurnCompletedNotification: projectedType(turnCompleted),
    JSONRPCError: projectedType(jsonRpcError),
  };
  const { referenced, unresolved } = resolveReferences(roots, {
    __aggregate__: definitions,
    ThreadItem: definitions,
    TurnStartParams: turnStart.definitions || {},
    ItemCompletedNotification: itemCompleted.definitions || {},
    TurnCompletedNotification: turnCompleted.definitions || {},
    JSONRPCError: jsonRpcError.definitions || {},
  });
  // Anti-silence: the roots are all-`$ref` properties, so an empty closure means
  // resolution stopped working, not that there is nothing to pin.
  if (collectRefs(roots).size > 0 && Object.keys(referenced).length === 0) {
    const error = new Error('roots reference other types but the closure resolved to zero definitions');
    error.code = 'SCHEMA_SHAPE_CHANGED';
    throw error;
  }

  return canonicalize({
    meta: {
      codex_version: opts.codexVersion || 'unknown',
      variant_count: variants,
      referenced_count: Object.keys(referenced).length,
      unresolved_refs: unresolved,
      projected_at: opts.projectedAt || new Date().toISOString(),
    },
    definitions: roots,
    referenced,
  });
}

function resolveCodexCommand() {
  const override = process.env.FORGE_SCHEMA_PIN_CODEX_BIN;
  // An override is a literal executable path, never a shell command fragment.
  return override && override.endsWith('.js')
    ? { command: process.execPath, prefixArgs: [override], display: override }
    : { command: override || 'codex', prefixArgs: [], display: override || 'codex' };
}

function generateSchema(outDir) {
  const resolved = resolveCodexCommand();
  // shell:false and an argv array are deliberate: env input must never be parsed.
  const invocation = childProcess.spawnSync(
    resolved.command,
    [...resolved.prefixArgs, 'app-server', 'generate-json-schema', '--out', outDir],
    { encoding: 'utf8', shell: false },
  );
  if (invocation.error && invocation.error.code === 'ENOENT') {
    return { outcome: 'generator-missing', reason: `schema generator binary not found: ${resolved.display}` };
  }
  if (invocation.error) {
    return { outcome: 'generator-failed', reason: invocation.error.message };
  }
  if (invocation.status !== 0) {
    return { outcome: 'generator-failed', reason: (invocation.stderr || '').trim() || `generator exited ${invocation.status}` };
  }
  try {
    requiredFile(outDir, SCHEMA_FILE);
    requiredFile(outDir, path.join('v2', 'TurnStartParams.json'));
    requiredFile(outDir, path.join('v2', 'ItemCompletedNotification.json'));
    requiredFile(outDir, path.join('v2', 'TurnCompletedNotification.json'));
    requiredFile(outDir, 'JSONRPCError.json');
  } catch (error) {
    return { outcome: 'generator-output-shape-changed', reason: error.message };
  }
  const version = childProcess.spawnSync(resolved.command, [...resolved.prefixArgs, '--version'], { encoding: 'utf8', shell: false });
  const match = /(?:codex-cli|codex)\s+(\S+)/.exec(version.stdout || '');
  return { outcome: 'match', codexVersion: match ? match[1] : 'unknown' };
}

function diffValues(expected, actual, currentPath, fields) {
  const target = fields || [];
  const at = currentPath || '';
  if (target.length >= 20) return target;
  if (expected === actual) return target;
  const expectedObject = expected && typeof expected === 'object';
  const actualObject = actual && typeof actual === 'object';
  if (!expectedObject || !actualObject || Array.isArray(expected) !== Array.isArray(actual)) {
    target.push({ path: at || '(root)', kind: expected === undefined ? 'added' : actual === undefined ? 'removed' : 'changed' });
    return target;
  }
  const keys = Array.isArray(expected)
    ? Array.from({ length: Math.max(expected.length, actual.length) }, (_, index) => String(index))
    : Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)])).sort();
  for (const key of keys) {
    const next = Array.isArray(expected) ? `${at}[${key}]` : (at ? `${at}.${key}` : key);
    diffValues(expected[key], actual[key], next, target);
    if (target.length >= 20) break;
  }
  return target;
}

function temporarySchemaDirectory() {
  // The OS temp dir, never process.cwd(): a run generates 267 files, and a SIGKILL
  // between mkdtemp and rmSync would strand them inside the repo, where S07's
  // `forge-touch --record` unions them into the run's touched set.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-schema-pin-'));
}

function checkDrift(options) {
  const opts = options || {};
  let generatedDir = null;
  let generation = null;
  try {
    const schemaDir = opts.schemaDir || (generatedDir = temporarySchemaDirectory());
    if (!opts.schemaDir) {
      generation = generateSchema(schemaDir);
      if (generation.outcome !== 'match') return { ...generation, counts: { definitions_compared: 0 } };
    }
    let observed;
    try {
      observed = projectSchema(schemaDir, { codexVersion: generation && generation.codexVersion });
    } catch (error) {
      return { outcome: 'generator-output-shape-changed', reason: error.message, counts: { definitions_compared: 0 } };
    }
    let pin;
    try {
      pin = canonicalize(opts.pin || readJson(pinPath()));
    } catch (error) {
      // D8 applied to the guard's own input: an absent or truncated pin is a named
      // outcome inside the closed enum. "Could not read the pin" must never leave
      // through an uncaught stack trace, which parses as neither match nor drift.
      return { outcome: 'pin-unreadable', reason: error.message, counts: { definitions_compared: 0, referenced_compared: 0 } };
    }
    const compared = (expected, actual) => Object.keys(expected || {})
      .filter((key) => Object.prototype.hasOwnProperty.call(actual || {}, key)).length;
    const count = compared(pin.definitions, observed.definitions);
    const referencedCount = compared(pin.referenced, observed.referenced);
    const counts = { definitions_compared: count, referenced_compared: referencedCount };
    if (count + referencedCount === 0) return { outcome: 'inconclusive', reason: '0 definitions compared', counts };
    // Both halves are compared: the roots hold `$ref` pointers, and drift inside a
    // pointed-at type only shows up under `referenced` (S01 review R1).
    const fields = diffValues(
      { definitions: pin.definitions, referenced: pin.referenced },
      { definitions: observed.definitions, referenced: observed.referenced },
    );
    return { outcome: fields.length ? 'drift' : 'match', fields: fields.length ? fields : undefined, counts };
  } finally {
    if (generatedDir) fs.rmSync(generatedDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--generate-pin') result.generatePin = true;
    else if (arg === '--check' || arg === '--json') result[arg.slice(2)] = true;
    else if (arg === '--schema-dir') result.schemaDir = argv[++index];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  if ((result.generatePin ? 1 : 0) + (result.check ? 1 : 0) !== 1 || (result.schemaDir !== undefined && !result.schemaDir)) {
    return { error: 'usage: --generate-pin | --check [--schema-dir DIR] [--json]' };
  }
  return result;
}

function printResult(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`forge-schema-pin: ${result.outcome}${result.reason ? `: ${result.reason}` : ''}\n`);
}

module.exports = { OUTCOMES, canonicalize, collectRefs, resolveReferences, projectSchema, generateSchema, checkDrift, diffValues, pinPath };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`forge-schema-pin: ${args.error}\n`);
    process.exitCode = 2;
  } else if (args.generatePin) {
    const directory = temporarySchemaDirectory();
    try {
      const generated = generateSchema(directory);
      if (generated.outcome !== 'match') {
        printResult(generated, args.json);
        process.exitCode = 1;
      } else {
        const projection = projectSchema(directory, { codexVersion: generated.codexVersion });
        if (projection.meta.variant_count !== 18) {
          printResult({ outcome: 'generator-output-shape-changed', reason: `expected 18 ThreadItem variants, got ${projection.meta.variant_count}` }, args.json);
          process.exitCode = 1;
        } else {
          fs.mkdirSync(path.dirname(pinPath()), { recursive: true });
          fs.writeFileSync(pinPath(), `${JSON.stringify(projection, null, 2)}\n`);
          printResult({ outcome: 'match', counts: { definitions_compared: Object.keys(projection.definitions).length, referenced_compared: Object.keys(projection.referenced).length } }, args.json);
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  } else {
    const result = checkDrift({ schemaDir: args.schemaDir });
    printResult(result, args.json);
    if (result.outcome !== 'match') {
      if (result.outcome === 'drift') process.stderr.write('forge-schema-pin: drift detected; run --generate-pin and review the named fields.\n');
      process.exitCode = 1;
    }
  }
}
