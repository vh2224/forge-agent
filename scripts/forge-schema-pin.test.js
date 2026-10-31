#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const schemaPin = require('./forge-schema-pin');
const { sha256 } = require('./forge-delivery');

const HISTORICAL_PIN = path.join(__dirname, 'fixtures', 'schema-pin', 'codex-appserver-pin-0.163.0.json');
const HISTORICAL_SHA256 = '1060034061a031cc64af06ed68666b9945af8e26c72c330fec77202728f4813f';

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

// The CLI contract lives here; smoke retains only the installed-generator probe.
function testCliDrift() {
  const directory = tempDir('cli');
  const pin = JSON.parse(fs.readFileSync(schemaPin.pinPath(), 'utf8'));
  const fixture = (mutate = () => {}) => {
    const { definitions, referenced } = JSON.parse(JSON.stringify(pin));
    mutate(definitions, referenced);
    writeJson(path.join(directory, 'codex_app_server_protocol.v2.schemas.json'), {
      definitions: { ThreadItem: definitions.ThreadItem, ...referenced },
    });
    for (const name of Object.keys(definitions).filter(name => name !== 'ThreadItem')) {
      writeJson(path.join(directory, name === 'JSONRPCError' ? `${name}.json` : `v2/${name}.json`), definitions[name]);
    }
  };
  const run = (env = {}, args = ['--check', '--schema-dir', directory]) => {
    const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'forge-schema-pin.js'), ...args, '--json'], {
      encoding: 'utf8', env: { ...process.env, ...env },
    });
    const payload = JSON.parse(result.stdout);
    equal(result.status, payload.outcome === 'match' ? 0 : 1, 'CLI exit agrees with the named outcome');
    return payload;
  };
  try {
    fixture((definitions) => {
      definitions.ThreadItem.oneOf.forEach(item => {
        item.required.reverse();
        item.properties = Object.fromEntries(Object.entries(item.properties).reverse());
      });
    });
    equal(run().outcome, 'match', 'object keys and required ordering do not drift');
    equal(run().fields_total, 0, 'matching schema reports zero differences');
    equal(run().fields_truncated, false, 'matching schema is not truncated');
    for (const size of [1, 20, 21, 35]) {
      fixture(definitions => {
        for (let index = 0; index < size; index += 1) {
          definitions.TurnStartParams.properties[`fixtureField${String(index).padStart(2, '0')}`] = { type: 'string' };
        }
      });
      const bounded = run();
      equal(bounded.fields_total, size, 'total measures all differences once');
      equal(bounded.fields.length, Math.min(size, 20), 'default output stays bounded');
      equal(bounded.fields_truncated, size > 20, 'truncation is true iff total exceeds 20');
      const full = run({}, ['--check', '--schema-dir', directory, '--full']);
      equal(full.fields.length, size, '--full names every path');
      equal(full.fields_total, size, '--full keeps the exact total');
      equal(full.fields_truncated, size > 20, '--full reports whether the default would truncate');
      equal(bounded.fields, full.fields.slice(0, 20), 'default is the same ordered prefix');
      equal(schemaPin.checkDrift({ schemaDir: directory }).fields_total, size, 'module API counts full drift too');
      const text = childProcess.spawnSync(process.execPath,
        [path.join(__dirname, 'forge-schema-pin.js'), '--check', '--schema-dir', directory, '--full'], { encoding: 'utf8' });
      equal(text.status, 1, 'plain full drift exits 1');
      for (const field of full.fields) check(text.stdout.includes(`${field.kind}: ${field.path}\n`), 'plain --full also names every path');
    }
    equal(schemaPin.diffValues(Array(25).fill(0), Array(25).fill(1)).length, 20, 'diffValues defaults to 20');
    equal(schemaPin.diffValues(Array(25).fill(0), Array(25).fill(1), '', [], 3).length, 3, 'diffValues accepts a custom limit');
    equal(schemaPin.diffValues(Array(25).fill(0), Array(25).fill(1), '', [], Infinity).length, 25, 'Infinity is unlimited');
    for (const args of [['--full'], ['--generate-pin', '--full'], ['--full', '--generate-pin']]) {
      const bad = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'forge-schema-pin.js'), ...args], { encoding: 'utf8' });
      equal(bad.status, 2, '--full outside check is a usage error before generation');
      check(bad.stderr.includes('--full only valid with --check'), 'usage names the restriction');
    }
    console.log('PASS C02 full drift: 0/1/20/21/35 totals, bounded prefix, full JSON/text and invalid mode exit 2');

    fixture();
    equal(sha256(fs.readFileSync(HISTORICAL_PIN)), HISTORICAL_SHA256, 'historical fixture retains exact original bytes');
    const historical = JSON.parse(fs.readFileSync(HISTORICAL_PIN, 'utf8'));
    equal(historical.meta.codex_version, '0.163.0', 'fixture records historical version');
    const old = run({ FORGE_SCHEMA_PIN_FILE: HISTORICAL_PIN }, ['--check', '--schema-dir', directory, '--full']);
    equal(old.outcome, 'drift', 'new schema against historical pin must drift');
    equal(old.fields_total, 18, 'historical negative names the reviewed 18 differences');
    equal(old.fields_truncated, false, '18 differences are not truncated');
    check(old.fields.some(field => field.path === 'referenced.CodexErrorInfo.anyOf[0].enum[6]'), 'drift names the modelNotFound insertion index');
    check(old.fields.some(field => field.path === 'referenced.ImageGenerationInputImage'), 'drift names new referenced type');
    const enumValues = pin.referenced.CodexErrorInfo.anyOf[0].enum;
    equal(enumValues[6], 'modelNotFound', 'new pin has the inserted value');
    fixture((definitions, referenced) => {
      const values = referenced.CodexErrorInfo.anyOf[0].enum;
      [values[0], values[1]] = [values[1], values[0]];
    });
    const reordered = run();
    equal(reordered.fields.map(field => field.path), [
      'referenced.CodexErrorInfo.anyOf[0].enum[0]', 'referenced.CodexErrorInfo.anyOf[0].enum[1]',
    ], 'reordered enum preserves positional drift at both indices');
    console.log('PASS C02 historical pin: SHA256 immutable, FORGE_SCHEMA_PIN_FILE names enum insertion and ImageGenerationInputImage; reordered enum names both indices');

    fixture(definitions => definitions.ThreadItem.oneOf.reverse());
    equal(run().outcome, 'drift', 'oneOf ordering is not normalized away');
    const commandIndex = pin.definitions.ThreadItem.oneOf.findIndex(item => item.properties.type.enum[0] === 'commandExecution');
    fixture(definitions => {
      const props = definitions.ThreadItem.oneOf[commandIndex].properties;
      props.exit_code = props.exitCode;
      delete props.exitCode;
    });
    check(run().fields.some(field => field.path === `definitions.ThreadItem.oneOf[${commandIndex}].properties.exitCode`), 'renamed runtime field is named');
    fixture((definitions, referenced) => {
      referenced.SandboxPolicy = JSON.parse(JSON.stringify(referenced.SandboxPolicy).replace(/networkAccess/g, 'network_access'));
      referenced.CommandExecutionStatus.enum = ['different'];
    });
    const inner = run();
    equal(inner.outcome, 'drift', 'referenced types participate in drift');
    for (const prefix of ['referenced.SandboxPolicy', 'referenced.CommandExecutionStatus.enum']) {
      check(inner.fields.some(field => field.path.startsWith(prefix)), `drift names ${prefix}`);
    }
    fixture(definitions => definitions.ThreadItem.oneOf.push({ properties: { type: { enum: ['futureThreadItem'] } } }));
    check(run().fields.some(field => field.path === `definitions.ThreadItem.oneOf[${pin.meta.variant_count}]`), 'added variant is named');
    fixture();
    const truncated = path.join(directory, 'truncated.json');
    fs.writeFileSync(truncated, '{');
    for (const file of [truncated, path.join(directory, 'missing.json')]) {
      equal(run({ FORGE_SCHEMA_PIN_FILE: file }).outcome, 'pin-unreadable', 'unreadable pin is a named CLI failure');
    }
    equal(run({ FORGE_SCHEMA_PIN_CODEX_BIN: path.join(directory, 'missing-codex') }, ['--check']).outcome,
      'generator-missing', 'missing CLI generator fails explicitly');

    // Count alone cannot authorize a replacement variant; failed repins preserve the file.
    const generator = path.join(directory, 'generator.js');
    fs.writeFileSync(generator, `const fs=require('fs');const args=process.argv; if(args.includes('--version')) console.log('codex-cli fixture'); else fs.cpSync(${JSON.stringify(directory)},args[args.indexOf('--out')+1],{recursive:true});`);
    const outputPin = path.join(directory, 'output-pin.json');
    fs.writeFileSync(outputPin, 'preserve me');
    fixture(definitions => { definitions.ThreadItem.oneOf[0].properties.type.enum = ['futureThreadItem']; });
    const refused = run({ FORGE_SCHEMA_PIN_FILE: outputPin, FORGE_SCHEMA_PIN_CODEX_BIN: generator }, ['--generate-pin']);
    equal(refused.outcome, 'generator-output-shape-changed', 'unreviewed same-count replacement cannot be pinned');
    check(refused.reason.includes('futureThreadItem'), 'repin refusal names the unreviewed variant');
    equal(fs.readFileSync(outputPin, 'utf8'), 'preserve me', 'refused repin leaves destination untouched');
    fixture();
    equal(run({ FORGE_SCHEMA_PIN_FILE: outputPin, FORGE_SCHEMA_PIN_CODEX_BIN: generator }, ['--generate-pin']).outcome,
      'match', 'reviewed variants can be pinned through the same CLI');
    equal(JSON.parse(fs.readFileSync(outputPin, 'utf8')).definitions, pin.definitions, 'successful repin preserves projected definitions');
    console.log('PASS C02 existing negatives: renamed field, referenced drift, unreadable pin, missing generator and replacement variant refusal preserve destination');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
  equal(pin.meta.variant_count, 19, 'real pin declares 19 ThreadItem variants');
  equal(pin.definitions.ThreadItem.oneOf.length, 19, 'real pin contains 19 ThreadItem variants');
  // The roots are all-`$ref`; a pin that carries only them pins pointers, not types.
  check(pin.referenced && Object.keys(pin.referenced).length > 0, 'real pin resolves the referenced closure');
  equal(pin.meta.referenced_count, Object.keys(pin.referenced).length, 'meta.referenced_count matches the closure it describes');
  for (const name of ['SandboxPolicy', 'CommandExecutionStatus', 'AskForApproval', 'Turn', 'UserInput', 'PatchApplyStatus']) {
    check(Object.prototype.hasOwnProperty.call(pin.referenced, name), `closure pins ${name}`);
  }
  equal(pin.meta.unresolved_refs, [], 'every reachable ref resolves at this codex version');
  equal(pin.meta.codex_version, '0.165.0', 'real pin records the reviewed generator version');
  equal(pin.meta.referenced_count, 54, 'reviewed projection has 54 referenced types');
  // B2 stays alive: the pin is a projection, not the 3.4 MB / 267-file raw generation.
  const bytes = fs.statSync(schemaPin.pinPath()).size;
  check(bytes < 512 * 1024, `pin stays a projection (${(bytes / 1024).toFixed(1)} KB, cap 512 KB)`);
  console.log('PASS C02 pin metadata: Codex 0.165.0, 5 roots, 19 variants, 54 referenced types, zero unresolved refs');
}

function testSchemaDocument() {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'codex-schema-0.165.0.md'), 'utf8');
  const pin = JSON.parse(fs.readFileSync(schemaPin.pinPath(), 'utf8'));
  const previous = JSON.parse(fs.readFileSync(HISTORICAL_PIN, 'utf8'));
  const fields = schemaPin.diffValues(
    { definitions: previous.definitions, referenced: previous.referenced },
    { definitions: pin.definitions, referenced: pin.referenced }, '', [], Infinity);
  const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'host-compatibility-2026-10-28.evidence.json'), 'utf8'));
  equal(fields.length, evidence.schema.unlimited_diff_paths, 'current full diff confronts original analysis total');
  for (const field of fields) check(doc.includes(`\`${field.path}\``), 'document inventories each exact full helper path');
  for (const phrase of ['fields_total: 18', 'fields_truncated: false', 'ThreadStartParams', 'modelNotFound', 'S01/T04', 'ServerRequest.json', '-32601', '500', 'Limites da verificação', 'issues/279']) {
    check(doc.includes(phrase), `document records ${phrase}`);
  }
  check(doc.split('\n').length >= 90, 'schema review is substantive');
  check(!/TODO|TBD/.test(doc), 'schema review has no stub markers');
  const readme = fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-pin', 'README.md'), 'utf8');
  check(readme.includes(HISTORICAL_SHA256) && readme.includes(previous.meta.projected_at), 'README records exact hash and original timestamp');
  check(readme.split('\n').length >= 10, 'historical provenance is substantive');
  console.log('PASS C02 document: every full helper path grouped, 18 matches dated evidence, truncation explicit, policy/params/inbound/limits and historical provenance recorded');
}

function testLive165() {
  // Local generation only, no inference. CI does not install Codex; absence or a
  // different CLI version is explicitly unverified rather than a matching schema.
  const version = childProcess.spawnSync('codex', ['--version'], { encoding: 'utf8', shell: false });
  if (version.status !== 0 || !/^codex-cli 0\.165\.0\s*$/.test(version.stdout)) {
    console.log('SKIP C02 live Codex 0.165.0: reviewed CLI not installed; offline fixtures do not prove live compatibility');
    return;
  }
  const live = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'forge-schema-pin.js'), '--check', '--json'], { encoding: 'utf8', shell: false });
  equal(live.status, 0, 'installed 0.165.0 guard matches the regenerated pin');
  const result = JSON.parse(live.stdout);
  equal(result.outcome, 'match', 'live result is a real match');
  equal(result.counts, { definitions_compared: 5, referenced_compared: 54 }, 'live compares five roots and the whole closure');
  equal(result.fields_total, 0, 'no live drift');
  equal(result.fields_truncated, false, 'matching live result not truncated');
  const directory = tempDir('live-inspect');
  try {
    equal(schemaPin.generateSchema(directory).codexVersion, '0.165.0', 'inspect files generated by the real CLI with argv');
    const thread = JSON.parse(fs.readFileSync(path.join(directory, 'v2', 'ThreadStartParams.json'), 'utf8'));
    equal(thread.required || [], [], 'thread start has no required fields');
    equal(thread.properties.model.type, ['string', 'null'], 'explicit model remains supported');
    equal(thread.properties.ephemeral.type, ['boolean', 'null'], 'ephemeral remains supported');
    check(thread.properties.approvalPolicy.anyOf.some(branch => branch.$ref === '#/definitions/AskForApproval'), 'approval policy type remains supported');
    const turn = JSON.parse(fs.readFileSync(path.join(directory, 'v2', 'TurnStartParams.json'), 'utf8'));
    equal(turn.required, ['input', 'threadId'], 'turn still requires input and threadId');
    const requests = JSON.parse(fs.readFileSync(path.join(directory, 'ServerRequest.json'), 'utf8'));
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'codex-schema-0.165.0.md'), 'utf8');
    equal(requests.oneOf.length, 10, 'server request inventory has ten methods');
    for (const request of requests.oneOf) {
      const method = request.properties.method.enum[0];
      const params = request.properties.params.$ref.slice('#/definitions/'.length);
      check(doc.includes(`\`${method}\``) && doc.includes(`\`${params}\``), 'document names actual generated method and params type');
      equal(/EXPERIMENTAL/.test(request.description || ''), method === 'item/tool/requestUserInput', 'experimental marking is read from schema');
    }
  } finally {
    const actual = fs.realpathSync(directory);
    check(path.dirname(actual) === fs.realpathSync(os.tmpdir()) && path.basename(actual).startsWith('forge-schema-pin-test-live-inspect-'), 'cleanup contains only owned OS temp directory');
    fs.rmSync(actual, { recursive: true, force: true });
  }
  console.log('PASS C02 live Codex 0.165.0: match 5/54, ThreadStartParams model/approval/ephemeral and all 10 inbound request types/experimental markers revalidated; temp removed');
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
  testCliDrift();
  testProjectionFixture();
  testPinnedCount();
  testSchemaDocument();
  testLive165();
  testReferenceClosure();
  testPinUnreadable();
  testGeneratorDegradations();
  testInconclusiveFloor();
  testMalformedGeneratorOutput();
  process.stdout.write(`forge-schema-pin.test.js: ${assertions} assertions passed\n`);
}
