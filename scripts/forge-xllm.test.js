#!/usr/bin/env node
'use strict';

// Sidecar boundary tests are pure and do not invoke either provider CLI. They
// exercise the argv/env/isolation decisions with Windows, macOS and Linux
// vectors so quoting or the test host cannot change the security result.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildSidecarEnv,
  buildAppServerSandboxPolicy,
  authorizeSidecar,
  assertUntrustedOutputBarrier,
  terminateOwnedProcessTree,
} = require('./forge-xllm.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-boundary-Ω space-'));
const workspace = path.join(root, 'workspace – code');
fs.mkdirSync(workspace, { recursive: true });

try {
  const source = {
    PATH: 'path with spaces', HOME: 'home', USERPROFILE: 'profile',
    SystemRoot: 'windows', TEMP: 'temp', TMP: 'tmp',
    DBUS_SESSION_BUS_ADDRESS: 'dbus', XDG_RUNTIME_DIR: 'runtime',
    OPENAI_API_KEY: 'openai-secret', GEMINI_API_KEY: 'gemini-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret', CODEX_HOME: 'provider-home',
    AWS_SECRET_ACCESS_KEY: 'aws-secret', DATABASE_URL: 'database-secret',
    FORGE_ACCOUNT: 'account-secret', FORGE_SESSION_ID: 'session-secret',
    FORGE_XLLM_CODEX_BIN: path.join(workspace, 'mock codex.js'),
    FORGE_SAFE_VALUE: 'forwarded',
  };
  for (const platform of ['win32', 'darwin', 'linux']) {
    const env = buildSidecarEnv('minimal', source, platform);
    assert.strictEqual(env.PATH, source.PATH);
    assert.strictEqual(env.FORGE_XLLM_CODEX_BIN, source.FORGE_XLLM_CODEX_BIN);
    for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_HOME', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL', 'FORGE_ACCOUNT', 'FORGE_SESSION_ID']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(env, key), false, `${platform} strips ${key}`);
    }
    assert.strictEqual(env.FORGE_SAFE_VALUE, source.FORGE_SAFE_VALUE, `${platform} forwards non-sensitive FORGE_* controls`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env, 'SystemRoot'), platform === 'win32');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env, 'DBUS_SESSION_BUS_ADDRESS'), platform === 'linux');
  }
  // Explicit inherit remains an environment policy input, but the same
  // credential denylist applies; a caller cannot smuggle secrets through it.
  const inherited = buildSidecarEnv('inherit', source, 'darwin');
  assert.strictEqual(inherited.FORGE_XLLM_CODEX_BIN, source.FORGE_XLLM_CODEX_BIN);
  assert.strictEqual(inherited.OPENAI_API_KEY, undefined);
  assert.strictEqual(inherited.CODEX_HOME, undefined);

  assert.deepStrictEqual(buildAppServerSandboxPolicy('read-only', 'win32'), {
    type: 'readOnly', networkAccess: false,
  });
  assert.deepStrictEqual(buildAppServerSandboxPolicy('workspace-write', 'darwin'), {
    type: 'workspaceWrite', networkAccess: false,
  });
  assert.deepStrictEqual(buildAppServerSandboxPolicy('workspace-write', 'linux'), {
    type: 'workspaceWrite', networkAccess: false,
  });
  assert.deepStrictEqual(buildAppServerSandboxPolicy('workspace-write', 'win32'), {
    type: 'dangerFullAccess',
  });

  const execute = authorizeSidecar('execute', {
    cwd: workspace, workspaceRoot: workspace, hostRuntime: 'codex', engine: 'codex',
  });
  assert.strictEqual(execute.decision, 'allow');
  assert.strictEqual(execute.sandbox_mode, 'workspace-write');
  assert.strictEqual(execute.permissions.workspace_write, true);
  assert.deepStrictEqual(execute.grants, []);

  const plan = authorizeSidecar('plan', {
    cwd: workspace, workspaceRoot: workspace, hostRuntime: 'codex', engine: 'codex',
  });
  assert.strictEqual(plan.decision, 'allow');
  assert.strictEqual(plan.sandbox_mode, 'read-only');
  assert.strictEqual(plan.permissions.workspace_write, false);
  assert.strictEqual(plan.permissions.spawn, true);

  assert.throws(() => authorizeSidecar('execute', {
    cwd: path.join(root, 'outside'), workspaceRoot: workspace, hostRuntime: 'codex', engine: 'codex',
  }), (error) => error.code === 'target-outside-workspace');

  assert.strictEqual(assertUntrustedOutputBarrier({ status: 'done', summary: 'safe' }).summary, 'safe');
  assert.throws(() => assertUntrustedOutputBarrier({ status: 'done', permissions: { workspace_write: true } }),
    (error) => error.code === 'untrusted-output-barrier');

  const invalidOwner = terminateOwnedProcessTree({ pid: 0, kill() {} }, 'win32', () => ({ status: 0 }));
  assert.deepStrictEqual(invalidOwner, { ok: false, reason_code: 'process-termination-invalid-owner' });
  let killed = false;
  const winKill = terminateOwnedProcessTree({ pid: 4242, kill() { killed = true; } }, 'win32', (cmd, args, opts) => {
    assert.strictEqual(cmd, 'taskkill');
    assert.deepStrictEqual(args, ['/PID', '4242', '/T', '/F']);
    assert.strictEqual(opts.shell, false);
    return { status: 0 };
  });
  assert.strictEqual(winKill.ok, true);
  assert.strictEqual(killed, true);

  console.log('forge-xllm boundary tests passed (3 platform vectors; no provider spawn)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
