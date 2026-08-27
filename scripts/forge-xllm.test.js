#!/usr/bin/env node
'use strict';

// Sidecar boundary tests are pure and do not invoke either provider CLI. They
// exercise the argv/env/isolation decisions with Windows, macOS and Linux
// vectors so quoting or the test host cannot change the security result.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const dispatchPolicy = require('./forge-dispatch-policy.js');
const {
  buildSidecarEnv,
  authorizeSidecar,
  assertUntrustedOutputBarrier,
  assertNoProtectedSidecarChanges,
  terminateOwnedProcessTree,
  buildExecutePrompt,
  ENGINE_ENUM,
  normalizeHostRuntime,
  normalizeSidecarDeclared,
  normalizePublicSidecarOptions,
} = require('./forge-xllm.js');

const SCRIPT = path.join(__dirname, 'forge-xllm.js');

function runCli(args, env = process.env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-boundary-Ω space-'));
const workspace = path.join(root, 'workspace – code');
fs.mkdirSync(workspace, { recursive: true });

try {
  const source = {
    PATH: 'path with spaces', HOME: 'home', USERPROFILE: 'profile',
    SystemRoot: 'windows', TEMP: 'temp', TMP: 'tmp',
    DBUS_SESSION_BUS_ADDRESS: 'dbus', XDG_RUNTIME_DIR: 'runtime',
    OPENAI_API_KEY: 'openai-secret', GEMINI_API_KEY: 'gemini-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret', ANTHROPIC_AUTH_TOKEN: 'ambient-auth-token',
    CODEX_HOME: 'provider-home',
    AWS_SECRET_ACCESS_KEY: 'aws-secret', DATABASE_URL: 'database-secret',
    FORGE_ACCOUNT: 'account-secret', FORGE_SESSION_ID: 'session-secret',
    FORGE_XLLM_CODEX_BIN: path.join(workspace, 'mock codex.js'),
    FORGE_SAFE_VALUE: 'forwarded',
  };
  for (const platform of ['win32', 'darwin', 'linux']) {
    const env = buildSidecarEnv('minimal', source, platform);
    assert.strictEqual(env.PATH, source.PATH);
    assert.strictEqual(env.FORGE_XLLM_CODEX_BIN, source.FORGE_XLLM_CODEX_BIN);
    // Auth is by subscription, never by key, so NO provider key is allowlisted — and a
    // stray one must not reach the sidecar, or it bills the metered API instead of the
    // subscription. `CODEX_HOME` is not in this list because it is a config path, not a
    // credential (see the positive control below).
    for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL', 'FORGE_ACCOUNT', 'FORGE_SESSION_ID']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(env, key), false, `${platform} strips ${key}`);
    }
    assert.strictEqual(env.CODEX_HOME, source.CODEX_HOME, `${platform} forwards CODEX_HOME — a config path the sidecar needs to see its own projections`);
    assert.strictEqual(env.FORGE_SAFE_VALUE, source.FORGE_SAFE_VALUE, `${platform} forwards non-sensitive FORGE_* controls`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env, 'SystemRoot'), platform === 'win32');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env, 'DBUS_SESSION_BUS_ADDRESS'), platform === 'linux');
  }
  // Explicit inherit remains an environment policy input, but the same
  // credential denylist applies; a caller cannot smuggle secrets through it.
  const inherited = buildSidecarEnv('inherit', source, 'darwin');
  assert.strictEqual(inherited.FORGE_XLLM_CODEX_BIN, source.FORGE_XLLM_CODEX_BIN);
  // The hole this closes: `inherit` used to be a bare `{...sourceEnv}` with NO denylist,
  // so choosing it handed the third-party process every secret in the ambient env.
  assert.strictEqual(inherited.ANTHROPIC_API_KEY, undefined, 'inherit no longer smuggles foreign credentials');
  assert.strictEqual(inherited.ANTHROPIC_AUTH_TOKEN, undefined, 'inherit strips ambient Claude auth tokens too');
  assert.strictEqual(inherited.AWS_SECRET_ACCESS_KEY, undefined);
  assert.strictEqual(inherited.DATABASE_URL, undefined);
  assert.strictEqual(inherited.FORGE_ACCOUNT, undefined);
  assert.strictEqual(inherited.OPENAI_API_KEY, undefined, 'no provider key passes: auth is by subscription');
  // ...while the allowlisted config path still passes, exactly as under `minimal`.
  assert.strictEqual(inherited.CODEX_HOME, source.CODEX_HOME);

  const execute = authorizeSidecar('execute', {
    cwd: workspace, workspaceRoot: workspace, hostRuntime: 'codex', engine: 'codex', sidecarDeclared: true,
  });
  assert.strictEqual(execute.decision, 'allow');
  assert.strictEqual(execute.sandbox_mode, 'workspace-write');
  assert.strictEqual(execute.permissions.workspace_write, true);
  assert.strictEqual(execute.permissions.credential_env, false);
  assert.deepStrictEqual(execute.grants, []);

  const plan = authorizeSidecar('plan', {
    cwd: workspace, workspaceRoot: workspace, hostRuntime: 'codex', engine: 'codex', sidecarDeclared: true,
  });
  assert.strictEqual(plan.decision, 'allow');
  assert.strictEqual(plan.sandbox_mode, 'read-only');
  assert.strictEqual(plan.permissions.workspace_write, false);
  assert.strictEqual(plan.permissions.spawn, true);
  assert.strictEqual(plan.permissions.credential_env, false);

  let capturedPolicyInput = null;
  const realDecide = dispatchPolicy.decide;
  try {
    dispatchPolicy.decide = (input) => {
      capturedPolicyInput = input;
      return {
        decision: 'allow', reason_code: 'policy-allowed', grants: [],
        permissions: { credential_env: false },
      };
    };
    authorizeSidecar('execute', {
      cwd: workspace,
      workspaceRoot: workspace,
      hostRuntime: 'codex',
      engine: 'codex',
      sidecarDeclared: false,
    });
  } finally {
    dispatchPolicy.decide = realDecide;
  }
  assert.ok(capturedPolicyInput, 'authorization calls dispatch-policy.decide');
  assert.strictEqual(capturedPolicyInput.host_runtime, 'codex', 'the real host axis is projected');
  assert.strictEqual(capturedPolicyInput.worker_engine, 'codex');
  assert.strictEqual(capturedPolicyInput.sidecar_declared, false, 'explicit false survives authorization');
  assert.strictEqual(capturedPolicyInput.worker_mode, 'sidecar');
  assert.throws(() => authorizeSidecar('execute', {
    cwd: workspace,
    workspaceRoot: workspace,
    hostRuntime: 'codex',
    engine: 'codex',
    sidecarDeclared: false,
  }), (error) => error.code === 'invalid-runtime-contract', 'same-host undeclared spawn has the exact policy reason code');

  assert.throws(() => authorizeSidecar('execute', {
    cwd: path.join(root, 'outside'), workspaceRoot: workspace, hostRuntime: 'codex', engine: 'codex', sidecarDeclared: true,
  }), (error) => error.code === 'target-outside-workspace');

  assert.strictEqual(normalizeHostRuntime('CODEX'), 'codex');
  assert.strictEqual(normalizeSidecarDeclared(undefined), true, 'omission retains the public compatibility default');
  assert.strictEqual(normalizeSidecarDeclared(true), true);
  assert.strictEqual(normalizeSidecarDeclared(false), false);
  assert.strictEqual(normalizeSidecarDeclared('false'), false);
  assert.deepStrictEqual(normalizePublicSidecarOptions({ hostRuntime: 'CODEX', sidecarDeclared: false }), {
    hostRuntime: 'codex', sidecarDeclared: false,
  });
  assert.throws(() => normalizeSidecarDeclared('true'), /invalid --sidecar-declared/);

  assert.deepStrictEqual(ENGINE_ENUM, ['codex', 'agy', 'claude']);
  const codexPrompt = buildExecutePrompt('# task');
  assert.strictEqual(buildExecutePrompt('# task', { outputChannel: 'json-only' }), codexPrompt,
    'the explicit Codex output channel is byte-compatible with the legacy prompt');
  const claudePrompt = buildExecutePrompt('# task', { outputChannel: 'worker-result-block' });
  assert.ok(claudePrompt.endsWith([
    '---GSD-WORKER-RESULT---',
    'status: done|partial|blocked',
    'result_json: {compact one-line execute-result JSON}',
    '---END-RESULT---',
  ].join('\n')), 'Claude prompt ends with the exact worker-result block contract');

  const sourceText = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok((sourceText.match(/opts\.hostRuntime/g) || []).length > 1,
    'opts.hostRuntime occurs at multiple executable propagation points');
  assert.match(sourceText, /hostRuntime: normalizeHostRuntime\(opts\.hostRuntime\)/);
  assert.match(sourceText, /host_runtime: opts\.hostRuntime/);

  for (const mode of ['challenge', 'defend', 'rebuttal', 'plan']) {
    const rejected = runCli(['--mode', mode, '--engine', 'claude']);
    assert.strictEqual(rejected.status, 2, `Claude ${mode} is rejected`);
    assert.strictEqual(rejected.stdout, '', `Claude ${mode} keeps stdout silent`);
    assert.match(rejected.stderr, new RegExp(`--engine claude supports only execute \\(not ${mode}\\)`));
  }
  for (const mode of ['execute', 'plan']) {
    const rejected = runCli(['--mode', mode, '--engine', 'agy']);
    assert.strictEqual(rejected.status, 2, `agy ${mode} remains unavailable`);
    assert.strictEqual(rejected.stdout, '');
    assert.match(rejected.stderr, new RegExp(`--engine agy supports only review modes \\(not ${mode}\\)`));
  }
  const claudeExecute = runCli(['--mode', 'execute', '--engine', 'claude']);
  assert.strictEqual(claudeExecute.status, 2);
  assert.strictEqual(claudeExecute.stdout, '');
  assert.match(claudeExecute.stderr, /execute mode requires --plan/, 'Claude passes the engine guard into execute');

  const missingPlan = path.join(root, 'missing-plan.md');
  const declaredResult = path.join(root, 'declared-result.json');
  const declared = runCli([
    '--mode', 'execute', '--engine', 'codex', '--host-runtime', 'codex', '--sidecar-declared',
    '--plan', missingPlan, '--result-file', declaredResult, '--cwd', workspace, '--env-policy', 'minimal',
  ]);
  assert.strictEqual(declared.status, 2);
  assert.strictEqual(declared.stdout, '');
  assert.match(declared.stderr, /failed to read --plan file/, 'bare declaration true reaches the public execute boundary');

  const refusedResult = path.join(root, 'refused-result.json');
  const secretSentinel = 'token-must-never-appear-in-marker';
  const refused = runCli([
    '--mode', 'execute', '--engine', 'codex', '--host-runtime', 'codex', '--sidecar-declared', 'false',
    '--plan', missingPlan, '--result-file', refusedResult, '--cwd', workspace, '--env-policy', 'minimal',
  ], { ...process.env, ANTHROPIC_AUTH_TOKEN: secretSentinel });
  assert.strictEqual(refused.status, 2);
  assert.strictEqual(refused.stdout, '', 'execute failure never publishes to stdout');
  const refusedMarkerText = fs.readFileSync(refusedResult, 'utf8');
  const refusedMarker = JSON.parse(refusedMarkerText);
  assert.strictEqual(refusedMarker.status, 'adapter-failed');
  assert.strictEqual(refusedMarker.reason_code, 'invalid-runtime-contract', 'explicit false survives CLI and public run layers');
  assert.ok(!`${refused.stdout}${refused.stderr}${refusedMarkerText}`.includes(secretSentinel),
    'failure channels contain no ambient token value');

  const scalarTrue = runCli(['--mode', 'execute', '--engine', 'codex', '--sidecar-declared', 'true']);
  assert.strictEqual(scalarTrue.status, 2);
  assert.strictEqual(scalarTrue.stdout, '');
  assert.match(scalarTrue.stderr, /invalid --sidecar-declared/);

  // S03 review R4: `--key=value` used to parse as the flag NAME "key=value", so
  // this exact spelling left sidecar-declared undefined and silently restored the
  // permissive legacy default — the one malformed spelling that failed OPEN on an
  // authorization axis. It must now reach the same refusal as the two-token form.
  const equalsRefusedResult = path.join(root, 'equals-refused-result.json');
  const equalsRefused = runCli([
    '--mode', 'execute', '--engine', 'codex', '--host-runtime=codex', '--sidecar-declared=false',
    '--plan', missingPlan, '--result-file', equalsRefusedResult, '--cwd', workspace, '--env-policy', 'minimal',
  ]);
  assert.strictEqual(equalsRefused.status, 2);
  assert.strictEqual(equalsRefused.stdout, '');
  const equalsMarker = JSON.parse(fs.readFileSync(equalsRefusedResult, 'utf8'));
  assert.strictEqual(equalsMarker.reason_code, 'invalid-runtime-contract',
    '--sidecar-declared=false must not silently become the permissive default');

  const equalsScalarTrue = runCli(['--mode', 'execute', '--engine', 'codex', '--sidecar-declared=true']);
  assert.strictEqual(equalsScalarTrue.status, 2);
  assert.strictEqual(equalsScalarTrue.stdout, '');
  assert.match(equalsScalarTrue.stderr, /invalid --sidecar-declared/,
    'the = form is validated by the same normalizer, not by a second code path');

  const namelessFlag = runCli(['--mode', 'execute', '--engine', 'codex', '--=false']);
  assert.strictEqual(namelessFlag.status, 2);
  assert.strictEqual(namelessFlag.stdout, '');
  assert.match(namelessFlag.stderr, /malformed argument/);

  // The = form must not change the meaning of a flag whose value legitimately
  // contains one; only the first = separates key from value.
  const equalsInValue = runCli(['--mode', 'challenge', '--engine', 'codex', '--diff-cmd=git diff a=b', '--result-file', 'x']);
  assert.strictEqual(equalsInValue.status, 2);
  assert.match(equalsInValue.stderr, /--result-file is not supported in --mode challenge/,
    'a value containing = is still parsed as one value of a correctly named flag');

  assert.strictEqual(assertUntrustedOutputBarrier({ status: 'done', summary: 'safe' }).summary, 'safe');
  assert.throws(() => assertUntrustedOutputBarrier({ status: 'done', permissions: { workspace_write: true } }),
    (error) => error.code === 'untrusted-output-barrier');
  assert.throws(() => assertNoProtectedSidecarChanges([{ status: 'M', path: '.gsd/private.json' }]),
    /touched protected \.gsd/);

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

  console.log('forge-xllm boundary tests passed (authorization axes, engine guards, 3 platform vectors; no provider spawn)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
