#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const schemaPin = require('./forge-schema-pin');

let assertions = 0;
function check(condition, message) {
  assertions += 1;
  assert(condition, message);
}
function equal(actual, expected, message) {
  assertions += 1;
  assert.deepStrictEqual(actual, expected, message);
}
function tempDir(label) {
  // os.tmpdir(), never process.cwd(): fixtures must not be able to strand files in
  // the repo, where S07's `forge-touch --record` unions them into the run's touches.
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-schema-pin-test-${label}-`));
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function miniSchemaDir() {
  const directory = tempDir('fixture');
  writeJson(path.join(directory, 'codex_app_server_protocol.v2.schemas.json'), {
    definitions: {
      ThreadItem: { oneOf: [
        { type: 'object', required: ['type', 'id'], properties: { type: { enum: ['one'] }, id: { type: 'string' } } },
        { type: 'object', required: ['type', 'id'], properties: { type: { enum: ['two'] }, id: { type: 'string' } } },
        { type: 'object', required: ['type', 'id'], properties: { type: { enum: ['three'] }, id: { type: 'string' } } },
      ] },
    },
  });
  const types = {
    TurnStartParams: { sandboxPolicy: { type: 'string' }, model: { type: 'string' }, outputSchema: true },
    ItemCompletedNotification: { item: { type: 'object' } },
    TurnCompletedNotification: { turn: { type: 'object' } },
  };
  for (const [name, properties] of Object.entries(types)) {
    writeJson(path.join(directory, 'v2', `${name}.json`), { title: name, type: 'object', required: Object.keys(properties), properties });
  }
  writeJson(path.join(directory, 'JSONRPCError.json'), { title: 'JSONRPCError', type: 'object', required: ['error'], properties: { error: { type: 'object' } } });
  return directory;
}

function testCanonicalization() {
  const first = { required: ['z', 'a'], properties: { z: { type: 'string' }, a: { type: 'integer' } } };
  const reordered = { properties: { a: { type: 'integer' }, z: { type: 'string' } }, required: ['a', 'z'] };
  equal(schemaPin.canonicalize(first), schemaPin.canonicalize(reordered), 'object and required ordering must not drift');
  const renamed = schemaPin.canonicalize({
    definitions: { ThreadItem: { oneOf: [{ properties: { exitStatus: { type: 'integer' } } }] } },
  });
  const original = schemaPin.canonicalize({
    definitions: { ThreadItem: { oneOf: [{ properties: { exitCode: { type: 'integer' } } }] } },
  });
  const fields = schemaPin.diffValues(original, renamed);
  equal(fields[0], { path: 'definitions.ThreadItem.oneOf[0].properties.exitCode', kind: 'removed' }, 'renamed fields must name the removed path');
  equal(fields[1], { path: 'definitions.ThreadItem.oneOf[0].properties.exitStatus', kind: 'added' }, 'renamed fields must name the added path');
}

function testProjectionFixture() {
  const directory = miniSchemaDir();
  try {
    const projection = schemaPin.projectSchema(directory, { codexVersion: 'fixture', projectedAt: '2026-08-05T00:00:00.000Z' });
    equal(projection.meta.variant_count, 3, 'fixture variant count is measured from oneOf');
    check(projection.definitions.TurnStartParams.properties.sandboxPolicy, 'TurnStartParams keeps sandboxPolicy');
    check(projection.definitions.TurnStartParams.properties.model, 'TurnStartParams keeps model');
    check(Object.prototype.hasOwnProperty.call(projection.definitions.TurnStartParams.properties, 'outputSchema'), 'TurnStartParams keeps outputSchema');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testPinnedCount() {
  const pin = JSON.parse(fs.readFileSync(schemaPin.pinPath(), 'utf8'));
  equal(pin.meta.variant_count, 18, 'real pin declares 18 ThreadItem variants');
  equal(pin.definitions.ThreadItem.oneOf.length, 18, 'real pin contains 18 ThreadItem variants');
  // The roots are all-`$ref`; a pin that carries only them pins pointers, not types.
  check(pin.referenced && Object.keys(pin.referenced).length > 0, 'real pin resolves the referenced closure');
  equal(pin.meta.referenced_count, Object.keys(pin.referenced).length, 'meta.referenced_count matches the closure it describes');
  for (const name of ['SandboxPolicy', 'CommandExecutionStatus', 'AskForApproval', 'Turn', 'UserInput', 'PatchApplyStatus']) {
    check(Object.prototype.hasOwnProperty.call(pin.referenced, name), `closure pins ${name}`);
  }
  equal(pin.meta.unresolved_refs, [], 'every reachable ref resolves at this codex version');
  // B2 stays alive: the pin is a projection, not the 3.4 MB / 267-file raw generation.
  const bytes = fs.statSync(schemaPin.pinPath()).size;
  check(bytes < 512 * 1024, `pin stays a projection (${(bytes / 1024).toFixed(1)} KB, cap 512 KB)`);
}

// The stopping rule is reachability, and an unreachable pointer is NAMED, not dropped.
function testReferenceClosure() {
  const directory = tempDir('closure');
  try {
    const roots = {
      Root: { title: 'Root', type: 'object', required: [], properties: { a: { $ref: '#/definitions/Alpha' } } },
    };
    const scopes = {
      __aggregate__: {
        Alpha: { type: 'object', properties: { b: { $ref: '#/definitions/Beta' } } },
        Beta: { type: 'object', properties: { back: { $ref: '#/definitions/Alpha' }, gone: { $ref: '#/definitions/Nowhere' } } },
        Unreached: { type: 'string' },
      },
      Root: {},
    };
    const resolved = schemaPin.resolveReferences(roots, scopes);
    equal(Object.keys(resolved.referenced).sort(), ['Alpha', 'Beta'], 'closure is transitive and terminates on a cycle');
    check(!Object.prototype.hasOwnProperty.call(resolved.referenced, 'Unreached'), 'unreachable types stay out of the projection');
    equal(resolved.unresolved, ['#/definitions/Nowhere'], 'a pointer that does not resolve is named, never dropped');

    // Two documents defining the same name differently is a named shape change, not a
    // silent overwrite of one by the other.
    let threw = null;
    try {
      schemaPin.resolveReferences(
        { A: { properties: { x: { $ref: '#/definitions/Shared' } } }, B: { properties: { y: { $ref: '#/definitions/Shared' } } } },
        { __aggregate__: {}, A: { Shared: { type: 'string' } }, B: { Shared: { type: 'integer' } } },
      );
    } catch (error) { threw = error; }
    check(threw && threw.code === 'SCHEMA_SHAPE_CHANGED', 'conflicting definitions across documents is a named failure');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// D8 on the guard's own input: an unreadable pin is inside the closed enum.
function testPinUnreadable() {
  const directory = miniSchemaDir();
  try {
    // checkDrift falls back to the pin on disk when no pin is supplied, so the failure
    // is forced through the documented override — the same path the CLI takes.
    const previous = process.env.FORGE_SCHEMA_PIN_FILE;
    process.env.FORGE_SCHEMA_PIN_FILE = path.join(directory, 'not-a-pin.json');
    try {
      const result = schemaPin.checkDrift({ schemaDir: directory });
      equal(result.outcome, 'pin-unreadable', 'an absent pin is a named outcome');
      check(schemaPin.OUTCOMES.has(result.outcome), 'pin-unreadable belongs to the closed enum');
      equal(result.counts.definitions_compared, 0, 'pin-unreadable compares nothing and says so');
    } finally {
      if (previous === undefined) delete process.env.FORGE_SCHEMA_PIN_FILE;
      else process.env.FORGE_SCHEMA_PIN_FILE = previous;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testGeneratorDegradations() {
  const missing = childProcess.spawnSync(process.execPath, [__filename, '--generator-missing-child'], {
    encoding: 'utf8', env: { ...process.env, FORGE_SCHEMA_PIN_CODEX_BIN: path.join(process.cwd(), 'definitely no schema binary') },
  });
  equal(JSON.parse(missing.stdout).outcome, 'generator-missing', 'missing generator must be named');
  const mock = path.join(tempDir('failed'), 'failed-generator.js');
  fs.writeFileSync(mock, 'process.stderr.write("fixture generator failure\\n"); process.exit(1);\n');
  try {
    const failed = childProcess.spawnSync(process.execPath, [__filename, '--generator-failed-child'], {
      encoding: 'utf8', env: { ...process.env, FORGE_SCHEMA_PIN_CODEX_BIN: mock },
    });
    const result = JSON.parse(failed.stdout);
    equal(result.outcome, 'generator-failed', 'failed generator must be named');
    check(result.reason.includes('fixture generator failure'), 'generator failure preserves stderr detail');
  } finally {
    fs.rmSync(path.dirname(mock), { recursive: true, force: true });
  }
}

function testInconclusiveFloor() {
  const directory = miniSchemaDir();
  try {
    const result = schemaPin.checkDrift({ schemaDir: directory, pin: { meta: {}, definitions: {} } });
    equal(result.outcome, 'inconclusive', 'zero definitions must never become match');
    equal(result.counts.definitions_compared, 0, 'inconclusive records zero comparisons');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testMalformedGeneratorOutput() {
  const directory = miniSchemaDir();
  try {
    fs.writeFileSync(path.join(directory, 'codex_app_server_protocol.v2.schemas.json'), '{ not JSON');
    const result = schemaPin.checkDrift({ schemaDir: directory });
    equal(result.outcome, 'generator-output-shape-changed', 'malformed external JSON must be a named outcome');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--generator-missing-child') {
  const directory = tempDir('missing');
  try {
    process.stdout.write(`${JSON.stringify(schemaPin.generateSchema(directory))}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else if (process.argv[2] === '--generator-failed-child') {
  const directory = tempDir('failed-child');
  try {
    process.stdout.write(`${JSON.stringify(schemaPin.generateSchema(directory))}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  testCanonicalization();
  testProjectionFixture();
  testPinnedCount();
  testReferenceClosure();
  testPinUnreadable();
  testGeneratorDegradations();
  testInconclusiveFloor();
  testMalformedGeneratorOutput();
  process.stdout.write(`forge-schema-pin.test.js: ${assertions} assertions passed\n`);
}
