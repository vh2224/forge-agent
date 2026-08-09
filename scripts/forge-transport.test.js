#!/usr/bin/env node
'use strict';

/**
 * Unit suite for scripts/forge-transport.js (TASK-022).
 *
 * The bite is proven in BOTH directions (D10): an extractor that never matches
 * fails the positive cases, and one that always matches fails the negative ones.
 * A suite that only asserted `app-server` could not tell those two apart.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  TRANSPORT_KINDS,
  TRANSPORT_REASONS,
  deriveTransport,
  extractVersion,
  readTransportFromResult,
} = require('./forge-transport.js');

const SCRIPT = path.join(__dirname, 'forge-transport.js');

let passes = 0;
const failures = [];
function test(name, body) {
  try { body(); passes += 1; process.stdout.write(`  ok ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  FAIL ${name}: ${error.message}\n`); }
}

// The shape a real `codex-cli 0.144.4` emits: userAgent, no serverInfo.
const REAL_SESSION = {
  initializeResult: {
    userAgent: 'codex-cli/0.144.4 (Mac OS 26.5.2; arm64)',
    codexHome: '/h',
    platformFamily: 'mac',
    platformOs: 'Mac OS 26.5.2',
  },
  threadStartResult: { thread: { id: 't1', cliVersion: '0.144.4' } },
};

// The shape every pre-existing mock in this repo emits: serverInfo, no userAgent,
// no cliVersion. Tolerated, never depended on.
const MOCK_SESSION = {
  initializeResult: { serverInfo: { name: 'forge-test' } },
  threadStartResult: { thread: { id: 'thread-fixed' } },
};

// ── enums ────────────────────────────────────────────────────────────────────
test('the kind and reason sets are closed and frozen', () => {
  assert.deepStrictEqual([...TRANSPORT_KINDS], ['app-server', 'in-process', 'unknown']);
  assert.deepStrictEqual([...TRANSPORT_REASONS],
    ['no-result-file', 'no-transport-field', 'handshake-not-observed', 'invalid-transport-value']);
  assert(Object.isFrozen(TRANSPORT_KINDS) && Object.isFrozen(TRANSPORT_REASONS));
});

// ── deriveTransport: kind from presence ──────────────────────────────────────
test('real shape yields app-server + the CLI version', () => {
  assert.deepStrictEqual(deriveTransport(REAL_SESSION), { kind: 'app-server', version: '0.144.4' });
});

test('serverInfo shape yields app-server + unknown — tolerance without dependence', () => {
  assert.deepStrictEqual(deriveTransport(MOCK_SESSION), { kind: 'app-server', version: 'unknown' });
});

test('userAgent-only yields the leading token, never the OS version', () => {
  const session = {
    initializeResult: { userAgent: 'codex-cli/0.144.4 (Mac OS 26.5.2; arm64)' },
    threadStartResult: { thread: { id: 't1' } },
  };
  assert.strictEqual(deriveTransport(session).version, '0.144.4');
  // The only x.y.z here lives in the OS parenthetical. Taking it would log the OS
  // version as the CLI version — the exact greedy-match failure this guards.
  const osOnly = {
    initializeResult: { userAgent: 'codex-cli (Mac OS 26.5.2; arm64)' },
    threadStartResult: { thread: {} },
  };
  assert.strictEqual(deriveTransport(osOnly).version, 'unknown');
  assert.notStrictEqual(deriveTransport(osOnly).version, '26.5.2');
});

test('a multi-slash userAgent falls to unknown, never to the trailing segment', () => {
  // `\S+` was greedy and backtracked to the LAST slash of the leading token, so these
  // reported a trailing segment as an OBSERVED CLI version. A format the extractor
  // does not understand must degrade to the named floor.
  for (const userAgent of ['codex-cli/0.144.4/forged', 'a/b/c/9.9']) {
    const session = {
      initializeResult: { userAgent },
      threadStartResult: { thread: {} },
    };
    assert.strictEqual(extractVersion(session), 'unknown', `expected unknown for ${userAgent}`);
  }
  // And the two live forms still extract — the fix costs no real coverage.
  assert.strictEqual(extractVersion({
    initializeResult: { userAgent: 'codex-cli/0.144.4' },
    threadStartResult: { thread: {} },
  }), '0.144.4');
  assert.strictEqual(extractVersion({
    initializeResult: { userAgent: 'codex-cli/0.144.4 (Mac OS 26.5.2; arm64)' },
    threadStartResult: { thread: {} },
  }), '0.144.4');
});

test('empty handshake objects still yield app-server — presence, not content', () => {
  assert.deepStrictEqual(
    deriveTransport({ initializeResult: {}, threadStartResult: {} }),
    { kind: 'app-server', version: 'unknown' },
  );
});

test('either handshake object missing or null yields unknown', () => {
  const cases = [
    { threadStartResult: { thread: { cliVersion: '1.2.3' } } },          // initializeResult missing
    { initializeResult: { userAgent: 'codex-cli/1.2.3' } },              // threadStartResult missing
    {},                                                                   // both missing
    { initializeResult: null, threadStartResult: {} },
    { initializeResult: {}, threadStartResult: null },
    null,
    undefined,
  ];
  for (const session of cases) {
    assert.deepStrictEqual(deriveTransport(session), { kind: 'unknown', version: 'unknown' },
      `expected unknown for ${JSON.stringify(session)}`);
  }
});

test('hostile version values fall to unknown, never to a partial string', () => {
  const hostile = ['1.0"x', 'x'.repeat(200), '', '1.0 2.0', '{"a":1}', '../etc', 0, null, {}];
  for (const value of hostile) {
    const session = { initializeResult: {}, threadStartResult: { thread: { cliVersion: value } } };
    assert.strictEqual(extractVersion(session), 'unknown', `expected unknown for ${JSON.stringify(value)}`);
  }
  // And a userAgent whose version token is hostile does not leak either.
  assert.strictEqual(extractVersion({
    initializeResult: { userAgent: 'codex-cli/1.0"x (Mac OS)' },
    threadStartResult: {},
  }), 'unknown');
});

// ── readTransportFromResult: all three reasons, each by NAME ─────────────────
function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-transport-test-'));
  const file = path.join(dir, 'result.json');
  if (contents !== null) fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('missing result file is named no-result-file', () => {
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(null)),
    { transport: 'unknown', transport_reason: 'no-result-file' },
  );
});

test('unparseable result file is named no-result-file', () => {
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile('{not json')),
    { transport: 'unknown', transport_reason: 'no-result-file' },
  );
});

test('result file without appserver.transport is named no-transport-field', () => {
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(JSON.stringify({ status: 'done', appserver: { discarded_count: 0 } }))),
    { transport: 'unknown', transport_reason: 'no-transport-field' },
  );
  // No `appserver` sub-object at all — same reason, still named.
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(JSON.stringify({ status: 'done' }))),
    { transport: 'unknown', transport_reason: 'no-transport-field' },
  );
});

test("appserver.transport 'unknown' carries handshake-not-observed", () => {
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(JSON.stringify({ appserver: { transport: 'unknown' } }))),
    { transport: 'unknown', transport_reason: 'handshake-not-observed' },
  );
});

test('a transport value outside the closed set is named invalid-transport-value', () => {
  // 'handshake-not-observed' means "envelope present, handshake objects absent" — a
  // specific measurement. Emitting it for a corrupt value would assert something
  // nobody measured, so the corruption gets its own name.
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(JSON.stringify({ appserver: { transport: 'garbage' } }))),
    { transport: 'unknown', transport_reason: 'invalid-transport-value' },
  );
  // 'in-process' is a shell literal on the Claude emitter path, never a result-file
  // value: arriving here it is corruption like any other.
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(JSON.stringify({ appserver: { transport: 'in-process' } }))),
    { transport: 'unknown', transport_reason: 'invalid-transport-value' },
  );
  // A corrupt kind cannot borrow a plausible reason from the same envelope either.
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(JSON.stringify({
      appserver: { transport: 'garbage', transport_reason: 'handshake-not-observed' },
    }))),
    { transport: 'unknown', transport_reason: 'invalid-transport-value' },
  );
});

test('app-server result carries the version and NO transport_reason', () => {
  const payload = readTransportFromResult(
    tmpFile(JSON.stringify({ appserver: { transport: 'app-server', transport_version: '0.144.4' } })),
  );
  assert.deepStrictEqual(payload, { transport: 'app-server', transport_version: '0.144.4' });
  assert(!Object.prototype.hasOwnProperty.call(payload, 'transport_reason'));
});

test("app-server with no version emits 'unknown', never omits the field (D4)", () => {
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(JSON.stringify({ appserver: { transport: 'app-server' } }))),
    { transport: 'app-server', transport_version: 'unknown' },
  );
  // A hostile version in the envelope is also reduced to the named floor.
  assert.deepStrictEqual(
    readTransportFromResult(tmpFile(JSON.stringify({ appserver: { transport: 'app-server', transport_version: '1.0"x' } }))),
    { transport: 'app-server', transport_version: 'unknown' },
  );
});

// ── CLI contract ─────────────────────────────────────────────────────────────
function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('CLI: unknown --field is a named error with a non-zero exit', () => {
  const file = tmpFile(JSON.stringify({ appserver: { transport: 'app-server', transport_version: '0.144.4' } }));
  const run = cli(['--result', file, '--field', 'nope']);
  assert.notStrictEqual(run.status, 0);
  assert.match(run.stderr, /unknown --field "nope"/);
  assert.strictEqual(run.stdout, '');
});

test('CLI: known field prints the value + newline with exit 0', () => {
  const file = tmpFile(JSON.stringify({ appserver: { transport: 'app-server', transport_version: '0.144.4' } }));
  const kind = cli(['--result', file, '--field', 'transport']);
  assert.strictEqual(kind.status, 0);
  assert.strictEqual(kind.stdout, 'app-server\n');
  const version = cli(['--result', file, '--field', 'transport_version']);
  assert.strictEqual(version.status, 0);
  assert.strictEqual(version.stdout, '0.144.4\n');
  // An absent field is not an error: empty line, exit 0 — the fence's [ -n ] test
  // is what turns that into an omitted JSON key.
  const reason = cli(['--result', file, '--field', 'transport_reason']);
  assert.strictEqual(reason.status, 0);
  assert.strictEqual(reason.stdout, '\n');
});

test('CLI: no --field prints the whole object; a missing file still exits 0 with a named reason', () => {
  const whole = cli(['--result', tmpFile(JSON.stringify({ appserver: { transport: 'unknown' } })), '--field']);
  // `--field` with no value parses as boolean true → unknown field, named error.
  assert.notStrictEqual(whole.status, 0);

  const json = cli(['--result', tmpFile(JSON.stringify({ appserver: { transport: 'unknown' } }))]);
  assert.strictEqual(json.status, 0);
  assert.deepStrictEqual(JSON.parse(json.stdout), { transport: 'unknown', transport_reason: 'handshake-not-observed' });

  const missing = cli(['--result', tmpFile(null), '--field', 'transport_reason']);
  assert.strictEqual(missing.status, 0, 'advisory path never throws out of main');
  assert.strictEqual(missing.stdout, 'no-result-file\n');
});

test('CLI: --result is required', () => {
  const run = cli([]);
  assert.notStrictEqual(run.status, 0);
  assert.match(run.stderr, /--result <path> is required/);
});

process.stdout.write(`forge-transport.test.js: ${passes} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) process.stderr.write(`${f.name}: ${f.error.stack || f.error.message}\n`);
  process.exitCode = 1;
}
