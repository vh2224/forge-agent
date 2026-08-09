#!/usr/bin/env node
// forge-capability.test.js — focused contract tests for plan capability metadata

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseMustHaves, resolveCapability } = require('./forge-must-haves');

const parserPath = path.join(__dirname, 'forge-must-haves.js');

function plan(capabilityLine) {
  return `---
id: T99
slice: S01
title: capability fixture
${capabilityLine ? `${capabilityLine}\n` : ''}must_haves:
  truths: []
  artifacts: []
  key_links: []
expected_output: []
---

# Fixture
`;
}

function parsesAs(value, expected) {
  assert.strictEqual(parseMustHaves(plan(`capability: ${value}`)).capability, expected);
}

// The gate accepts precisely the three shared literals.
parsesAs('readonly', 'readonly');
parsesAs('workspace', 'workspace');
parsesAs('networked', 'networked');

assert.throws(
  () => parseMustHaves(plan('capability: banana')),
  err => err.message === 'malformed must_haves schema: capability — must be one of readonly|workspace|networked (got "banana")',
  'unknown capability must produce the exact structured schema error'
);
assert.throws(
  () => parseMustHaves(plan('capability: full')),
  err => err.message === 'malformed must_haves schema: capability — must be one of readonly|workspace|networked (got "full")',
  'values outside the closed enum must be rejected uniformly'
);
assert.throws(
  () => parseMustHaves(plan('capability: [readonly, workspace]')),
  err => err.message === 'malformed must_haves schema: capability — must be a string when present',
  'array values must not be accepted as scalar capabilities'
);

assert.strictEqual(parseMustHaves(plan(null)).capability, null, 'absence is legacy-compatible');
assert.strictEqual(parseMustHaves(plan('capability:')).capability, null, 'empty declaration is tolerated');
assert.strictEqual(parseMustHaves(plan('capability: null')).capability, null, 'YAML null is tolerated');

// The tolerant adapter route always returns a value, including malformed input.
assert.deepStrictEqual(resolveCapability(plan('capability: readonly')), {
  capability: 'readonly', declared: 'readonly', event: null,
});
assert.deepStrictEqual(resolveCapability(plan(null)), {
  capability: 'workspace', declared: null, event: null,
});
assert.deepStrictEqual(resolveCapability(plan('capability: banana')), {
  capability: 'workspace', declared: 'banana', event: 'capability-unrecognized',
});
// No frontmatter → a legacy plan, resolved to workspace with NO event: the event
// names a declaration that was not understood, and firing it on every plan that
// never declared anything dilutes exactly that signal (S03 review R17).
assert.deepStrictEqual(resolveCapability('not a plan at all'), {
  capability: 'workspace', declared: null, event: null,
});
// A non-string input is a caller bug, not a legacy plan — that keeps the event.
assert.deepStrictEqual(resolveCapability({}), {
  capability: 'workspace', declared: null, event: 'capability-unrecognized',
});

// An inline YAML comment must not reach the closed-set compare on either route
// (S03 review R14): the gate rejected the plan and the adapter downgraded a
// genuinely networked task to workspace, whose install failure then read as
// "environment".
assert.deepStrictEqual(resolveCapability(plan('capability: networked  # needs npm install')), {
  capability: 'networked', declared: 'networked', event: null,
});
assert.strictEqual(parseMustHaves(plan('capability: readonly # audit only')).capability, 'readonly');
// The strip must not swallow a real value: a `#` with no leading whitespace is
// part of the scalar, and an unrecognized declaration is still unrecognized.
assert.strictEqual(resolveCapability(plan('capability: banana # comment')).declared, 'banana');

// Prove the CLI exposes capability and preserves the valid legacy shape.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capability-'));
const fixturePath = path.join(fixtureDir, 'plan.md');
try {
  fs.writeFileSync(fixturePath, plan(null));
  const cli = spawnSync(process.execPath, [parserPath, '--check', fixturePath], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const output = JSON.parse(cli.stdout);
  assert.strictEqual(output.valid, true);
  assert.strictEqual(output.capability, null);

  fs.writeFileSync(fixturePath, plan('capability: banana'));
  const invalidCli = spawnSync(process.execPath, [parserPath, '--check', fixturePath], { encoding: 'utf8' });
  assert.notStrictEqual(invalidCli.status, 0, 'invalid capability must fail the enforcing CLI gate');
  assert.match(invalidCli.stdout, /malformed must_haves schema: capability/);
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log('forge-capability.test.js: all tests passed');
