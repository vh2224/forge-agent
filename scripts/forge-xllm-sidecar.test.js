#!/usr/bin/env node
'use strict';

// The master branch replaced the legacy `codex exec` subprocess with the
// long-lived app-server transport. Keep this PR-owned suite as a merge guard:
// resolving a future conflict must not accidentally resurrect the removed API.
const assert = require('assert');
const xllm = require('./forge-xllm.js');

assert.strictEqual(xllm.invokeCodexDetached, undefined);
assert.strictEqual(xllm.codexSandboxArgs, undefined);
assert.strictEqual(typeof xllm.invokeCodexAppServer, 'function');
assert.strictEqual(typeof xllm.buildAppServerSandboxPolicy, 'function');

assert.deepStrictEqual(xllm.buildAppServerSandboxPolicy('read-only', 'win32'), {
  type: 'readOnly',
  networkAccess: false,
});
assert.deepStrictEqual(xllm.buildAppServerSandboxPolicy('workspace-write', 'win32'), {
  type: 'dangerFullAccess',
});
assert.deepStrictEqual(xllm.buildAppServerSandboxPolicy('workspace-write', 'darwin'), {
  type: 'workspaceWrite',
  networkAccess: false,
});

console.log('forge-xllm sidecar merge guard passed (app-server only; legacy exec absent)');
