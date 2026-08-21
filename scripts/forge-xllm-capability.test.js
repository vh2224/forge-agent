#!/usr/bin/env node
'use strict';

/**
 * Standalone unit coverage for execute capability resolution and the app-server
 * SandboxPolicy boundary. No process, repository, or network fixture is needed.
 */
const assert = require('assert');
const path = require('path');
const {
  buildAppServerSandboxPolicy,
  capabilityToSandboxMode,
  buildExecutePrompt,
  buildPlanPrompt,
} = require('./forge-xllm');
const { resolveCapability, parseMustHaves } = require('./forge-must-haves');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    process.stderr.write(`  ✗ ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

// `expected_output` is a TOP-LEVEL frontmatter key, sibling of must_haves — it was
// nested inside must_haves here, a shape parseMustHaves would not survive. The
// fixture passed anyway because resolveCapability only reads `capability`, so the
// wrong shape was invisible AND was the form the next test would copy (S03 review
// R22). The assertion below runs the real parser over it so the shape cannot rot.
function planWithCapability(capability) {
  return [
    '---',
    `capability: ${capability}`,
    'must_haves:',
    '  truths: []',
    '  artifacts: []',
    '  key_links: []',
    'expected_output: []',
    '---',
    '# Capability fixture',
  ].join('\n');
}

test('the capability fixture is a shape the enforcing parser accepts', () => {
  const parsed = parseMustHaves(planWithCapability('readonly'));
  assert.strictEqual(parsed.capability, 'readonly');
  assert.deepStrictEqual(parsed.expected_output, []);
});

test('darwin maps readonly, workspace, and networked to explicit policies', () => {
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy('read-only', 'darwin'),
    { type: 'readOnly', networkAccess: false },
  );
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy('workspace-write', 'darwin'),
    { type: 'workspaceWrite', networkAccess: false },
  );
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy('networked', 'darwin'),
    { type: 'workspaceWrite', networkAccess: true },
  );
});

// R15: the mapping that runExecute actually uses. Every expectation below is keyed
// by the DECLARED capability and reached through capabilityToSandboxMode, so a
// one-character drift in the mode string ('readonly' → 'read-only') changes the
// observed policy and fails here. The previous coverage asserted
// buildAppServerSandboxPolicy('workspace-write', ...) — a hardcoded literal that
// passed no matter what the capability axis did, which is how a task declared
// read-only could be granted write with nothing failing.
test('declared capability reaches the sandbox policy runExecute would send', () => {
  const expectedByCapability = {
    readonly: { type: 'readOnly', networkAccess: false },
    workspace: { type: 'workspaceWrite', networkAccess: false },
    networked: { type: 'workspaceWrite', networkAccess: true },
  };
  for (const [capability, expected] of Object.entries(expectedByCapability)) {
    const cap = resolveCapability(planWithCapability(capability));
    assert.strictEqual(cap.capability, capability, `resolveCapability lost ${capability}`);
    assert.deepStrictEqual(
      buildAppServerSandboxPolicy(capabilityToSandboxMode(cap.capability), 'darwin'),
      expected,
      `${capability} did not reach its policy`,
    );
  }
  // The discriminant is real: the three capabilities do not collapse onto one policy.
  const policies = Object.keys(expectedByCapability)
    .map((c) => JSON.stringify(buildAppServerSandboxPolicy(capabilityToSandboxMode(c), 'darwin')));
  assert.strictEqual(new Set(policies).size, 3, 'capabilities must not share a policy');
  // S04 review R7. This used to assert the OPPOSITE — that anything outside the
  // closed set "falls to workspace-write, the safe default". It is not a safe
  // default: falling through GRANTS FILESYSTEM WRITE, so the least recognisable
  // input received the widest capability, in silence. Both functions are
  // exported, so "the only production call site passes a validated enum member"
  // never bound test or future callers. An unknown mode must now be impossible
  // to mistake for workspaceWrite.
  // NOTE the two vocabularies: capabilities are readonly|workspace|networked,
  // MODES are read-only|workspace-write|networked. Feeding a mode name to the
  // capability mapper is itself one of the confusions R7 is about, so
  // 'read-only' appears here as a BAD capability and below as a good mode.
  for (const bad of ['banana', 'read-only', 'workspace-write', undefined, null, '', 0]) {
    assert.throws(() => capabilityToSandboxMode(bad), /unknown capability/,
      `capabilityToSandboxMode(${JSON.stringify(bad)}) must refuse, not default to write`);
  }
  for (const bad of ['banana', 'readonly', 'read_only', 'workspace', null, '']) {
    assert.throws(() => buildAppServerSandboxPolicy(bad, 'darwin'), /unknown sandbox mode/,
      `buildAppServerSandboxPolicy(${JSON.stringify(bad)}) must refuse, not default to write`);
    // Validation precedes the platform branch: otherwise a typo on win32 returns
    // dangerFullAccess — the widest policy of all — and never reaches the guard.
    assert.throws(() => buildAppServerSandboxPolicy(bad, 'win32'), /unknown sandbox mode/,
      `buildAppServerSandboxPolicy(${JSON.stringify(bad)}, win32) must refuse before the platform branch`);
  }
  // Control in the other direction: the three real modes still resolve, so the
  // guard above is a finding about bad input, not a function that refuses all.
  for (const good of ['read-only', 'workspace-write', 'networked']) {
    assert.ok(buildAppServerSandboxPolicy(good, 'darwin').type, `${good} must still resolve`);
  }
});

test('the W3 workspace default remains the exact measured literal', () => {
  const noCapabilityPlan = [
    '---',
    'must_haves:',
    '  truths: []',
    '  artifacts: []',
    '  key_links: []',
    '  expected_output: []',
    '---',
  ].join('\n');
  const cap = resolveCapability(noCapabilityPlan);
  assert.deepStrictEqual(cap, { capability: 'workspace', declared: null, event: null });
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy(capabilityToSandboxMode(cap.capability), 'darwin'),
    { type: 'workspaceWrite', networkAccess: false },
  );
  // `undefined` no longer renders the workspace default (S04 R7): the DEFAULT
  // belongs at the call site that means it (invokeCodexAppServer passes
  // `sandbox || 'workspace-write'`), not inside the policy builder, where it was
  // indistinguishable from a typo.
  assert.throws(() => buildAppServerSandboxPolicy(undefined, 'darwin'), /unknown sandbox mode/);

  const extraRoot = path.resolve('repo-b');
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy('workspace-write', 'linux', [extraRoot]),
    { type: 'workspaceWrite', networkAccess: false, writableRoots: [extraRoot] },
    'POSIX multi-root policy carries the measured additional root');
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy('workspace-write', 'win32', [extraRoot]),
    { type: 'workspaceWrite', networkAccess: false, writableRoots: [extraRoot] },
    'Windows multi-root narrows dangerFullAccess to the measured workspaceWrite policy');
  assert.throws(() => buildAppServerSandboxPolicy('read-only', 'linux', [extraRoot]), /read-only cannot/,
    'read-only must never be widened by additional roots');
  assert.throws(() => buildAppServerSandboxPolicy('workspace-write', 'linux', ['relative']), /absolute paths/,
    'relative roots are refused before reaching the protocol');
});

test('Windows dangerFullAccess is platform-only and readonly stays sandboxed', () => {
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy('workspace-write', 'win32'),
    { type: 'dangerFullAccess' },
  );
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy('networked', 'win32'),
    { type: 'dangerFullAccess' },
  );
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy('read-only', 'win32'),
    { type: 'readOnly', networkAccess: false },
  );
});

test('execute prompt permits named git reads and prohibits named writes', () => {
  const prompt = buildExecutePrompt('# task', { capability: 'workspace' });
  assert.match(prompt, /Git reads are allowed: `git status`, `git diff`, `git log`, `git show`, and `git rev-parse`/);
  assert.match(prompt, /NEVER write with git: no commit, add, checkout, switch, reset, clean, stash, push, merge, rebase, or tag/);
});

test('workspace and omitted capability retain the disabled network instruction', () => {
  const workspace = buildExecutePrompt('# task', { capability: 'workspace' });
  const omitted = buildExecutePrompt('# task');
  assert.match(workspace, /The network is DISABLED/);
  assert.match(omitted, /The network is DISABLED/);
  assert.doesNotMatch(workspace, /Network access is ENABLED/);
});

test('networked execute prompt enables network and removes disabled wording', () => {
  const prompt = buildExecutePrompt('# task', { capability: 'networked' });
  assert.doesNotMatch(prompt, /The network is DISABLED/);
  assert.match(prompt, /Network access is ENABLED for this task — installs\/fetches are allowed; write only inside the working directory/);
});

// R16: the readOnly sandbox and the prompt must agree. A readonly turn that is told
// to write produces an attempted write, a sandbox denial, and an "environment"
// classification for work the task never should have attempted.
test('readonly execute prompt forbids writing and keeps the network disabled', () => {
  const readonly = buildExecutePrompt('# task', { capability: 'readonly' });
  assert.match(readonly, /This task is READ-ONLY: NEVER create, modify, or delete ANY file/);
  assert.match(readonly, /The network is DISABLED/);
  assert.doesNotMatch(readonly, /Network access is ENABLED/);
  // The other two postures must NOT inherit the read-only clause — it would forbid
  // exactly the writes they exist to perform.
  assert.doesNotMatch(buildExecutePrompt('# task', { capability: 'workspace' }), /This task is READ-ONLY/);
  assert.doesNotMatch(buildExecutePrompt('# task', { capability: 'networked' }), /This task is READ-ONLY/);
  assert.doesNotMatch(buildExecutePrompt('# task'), /This task is READ-ONLY/);
});

test('plan prompt retains the route-specific total git prohibition', () => {
  assert.match(buildPlanPrompt('# context'), /NEVER run any `git` command/);
});

test('unknown declared capability resolves end-to-end to workspace policy', () => {
  const cap = resolveCapability(planWithCapability('banana'));
  assert.deepStrictEqual(cap, {
    capability: 'workspace',
    declared: 'banana',
    event: 'capability-unrecognized',
  });
  // Derived from the downgraded capability, not from a literal: the downgrade is
  // only safe if the resolved capability is what reaches the policy.
  assert.deepStrictEqual(
    buildAppServerSandboxPolicy(capabilityToSandboxMode(cap.capability), 'darwin'),
    { type: 'workspaceWrite', networkAccess: false },
  );
});

process.stdout.write(`forge-xllm capability tests: ${passed} passed\n`);
if (process.exitCode) process.exit(process.exitCode);
