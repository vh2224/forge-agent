#!/usr/bin/env node
'use strict';

// Fixture-backed acceptance proof for the public Claude execute CLI.
//
// This suite substitutes only the external `claude` executable. It deliberately
// does not stub forge-xllm, forge-claude-sidecar, forge-accounts, token storage,
// worker-result parsing, VCS derivation, the protected-change fence, or result
// writing. A green run proves those local boundaries; it does NOT prove that a
// real Claude credential authenticates or that a real provider request succeeds.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(__dirname, 'forge-xllm.js');
const FIXTURE_TOKEN = 'fixture-oauth-dummy-t03-credential-boundary';
const CLI_STDIN = 'fixture CLI stdin is intentionally token-free\n';
const PLAN_SENTINEL = 'T03_COMPLETE_PLAN_BODY_SENTINEL_7d8b1e';
const RESULT_SUMMARY = 'fixture-backed Claude CLI acceptance completed';
const RESULT_MUST_HAVE = Object.freeze({
  item: 'isolated account-backed Claude CLI contract',
  status: 'met',
  note: 'the local Node fixture observed the production boundary',
  scope: 'task',
  reason: '',
});
const MOCK_OUTPUT = 'fixture-output.txt';
const PROTECTED_OUTPUT = path.join('.gsd', 'poison.txt');
const AUTH_KEYS = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_API_KEY',
  'FORGE_ACCOUNT',
]);

assert.ok(!/^sk-ant-/i.test(FIXTURE_TOKEN), 'the fixture token must never resemble a real Claude token');

function assertPathInside(owner, candidate, label) {
  const ownerPath = path.resolve(owner);
  const candidatePath = path.resolve(candidate);
  const ownerKey = process.platform === 'win32' ? ownerPath.toLowerCase() : ownerPath;
  const candidateKey = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
  assert.ok(candidateKey.startsWith(ownerKey + path.sep), `${label} must stay inside its owned fixture directory`);
}

function removeOwnedFixture(owner, target) {
  assertPathInside(owner, target, 'cleanup target');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  assert.ok(!fs.existsSync(target), 'owned fixture cleanup must remove every token-bearing file');
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode });
  try { fs.chmodSync(file, mode); } catch { /* Windows does not expose POSIX modes */ }
}

function writeLooseGitObject(gitDir, type, body) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const object = Buffer.concat([Buffer.from(`${type} ${content.length}\0`, 'utf8'), content]);
  const oid = crypto.createHash('sha1').update(object).digest('hex');
  const objectDir = path.join(gitDir, 'objects', oid.slice(0, 2));
  fs.mkdirSync(objectDir, { recursive: true });
  fs.writeFileSync(path.join(objectDir, oid.slice(2)), zlib.deflateSync(object));
  return oid;
}

// The task forbids git write commands. Build the disposable empty baseline with
// loose-object bytes so the production CLI can exercise only its normal read-only
// status/diff/rev-parse/hash probes against a real repository contract.
function createReadOnlyGitFixture(workspace) {
  const gitDir = path.join(workspace, '.git');
  const refsDir = path.join(gitDir, 'refs', 'heads');
  const infoDir = path.join(gitDir, 'info');
  fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true });
  fs.mkdirSync(refsDir, { recursive: true });
  fs.mkdirSync(infoDir, { recursive: true });

  const excludesFile = path.join(infoDir, 'fixture-global-excludes');
  fs.writeFileSync(excludesFile, '', 'utf8');
  fs.writeFileSync(path.join(infoDir, 'exclude'), '', 'utf8');
  const configPath = excludesFile.replace(/\\/g, '/').replace(/"/g, '\\"');
  fs.writeFileSync(path.join(gitDir, 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = false',
    '\tbare = false',
    '\tlogallrefupdates = false',
    '\tautocrlf = false',
    `\texcludesfile = "${configPath}"`,
    '',
  ].join('\n'), 'utf8');

  const tree = writeLooseGitObject(gitDir, 'tree', Buffer.alloc(0));
  const commit = writeLooseGitObject(gitDir, 'commit', [
    `tree ${tree}`,
    'author Forge Fixture <fixture@example.invalid> 0 +0000',
    'committer Forge Fixture <fixture@example.invalid> 0 +0000',
    '',
    'fixture baseline',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(refsDir, 'main'), commit + '\n', 'utf8');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return commit;
}

function buildPlanText() {
  const body = Array.from({ length: 96 }, (_, index) =>
    `Fixture narrative ${String(index + 1).padStart(3, '0')}: local transport remains deterministic and provider-free.`);
  return [
    '---',
    'must_haves:',
    '  truths:',
    '    - "the isolated fixture reaches the public Claude execute boundary"',
    '  artifacts:',
    '    - path: "fixture-output.txt"',
    '      provides: "ordinary fixture output"',
    '      min_lines: 1',
    '  key_links:',
    '    - from: "fixture plan"',
    '      to: "fixture-output.txt"',
    '      via: "the mock child writes an ordinary workspace file"',
    'expected_output:',
    '  - "fixture-output.txt"',
    'depends: []',
    'writes:',
    '  - "fixture-output.txt"',
    'domain: infra',
    'capability: workspace',
    'tier: standard',
    'effort: small',
    '---',
    '',
    '# Local Claude CLI fixture plan',
    '',
    PLAN_SENTINEL,
    '',
    ...body,
    '',
  ].join('\n');
}

// Serialized into each scenario's mock file. Keeping the implementation as a
// plain function makes the fixture a portable JavaScript program launched with
// process.execPath, never a POSIX shell script or Windows batch file.
function mockClaudeMain(config) {
  'use strict';
  const mockFs = require('fs');
  const mockPath = require('path');
  const args = process.argv.slice(2);
  const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
  let stdin = '';
  let promptFile = null;
  let prompt = '';
  let fixtureError = null;

  mockFs.appendFileSync(config.invocationsFile, String(process.pid) + '\n', 'utf8');

  const payload = {
    status: 'done',
    summary: config.resultSummary,
    must_haves_status: [config.resultMustHave],
    files_changed: ['model-declared-output.txt'],
  };

  try {
    stdin = mockFs.readFileSync(0, 'utf8');
    const promptIndex = args.indexOf('-p');
    if (promptIndex < 0 || typeof args[promptIndex + 1] !== 'string') {
      throw new Error('missing bounded prompt-file instruction');
    }
    const instruction = args[promptIndex + 1];
    const prefix = 'Read the complete task prompt from this UTF-8 file: ';
    const suffix = '. Follow it exactly and finish with its required worker-result block.';
    if (!instruction.startsWith(prefix) || !instruction.endsWith(suffix)) {
      throw new Error('unexpected prompt-file instruction');
    }
    promptFile = JSON.parse(instruction.slice(prefix.length, instruction.length - suffix.length));
    prompt = mockFs.readFileSync(promptFile, 'utf8');
  } catch (error) {
    fixtureError = error && error.message ? error.message : 'fixture input failure';
  }

  const selectedEnv = {};
  for (const key of config.selectedEnvKeys) {
    selectedEnv[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
  }
  const tokenInArgv = !!token && args.some((arg) => String(arg).includes(token));
  const planPassedInline = args.some((arg) => String(arg).includes(config.planSentinel));
  const capture = {
    behavior: config.behavior,
    pid: process.pid,
    adapter_pid: process.ppid,
    exec_path: process.execPath,
    script_path: process.argv[1],
    argv: args,
    stdin: { bytes: Buffer.byteLength(stdin, 'utf8'), content: stdin },
    selected_env: selectedEnv,
    token_in_argv: tokenInArgv,
    plan_passed_inline: planPassedInline,
    prompt_file: promptFile,
    prompt_contents: prompt,
    fixture_error: fixtureError,
    planned_payload: payload,
  };
  mockFs.writeFileSync(config.captureFile, JSON.stringify(capture, null, 2) + '\n', 'utf8');

  const boundaryFailures = [
    fixtureError,
    !token && 'fixture token missing from child env',
    tokenInArgv && 'fixture token reached child argv',
    (!!token && stdin.includes(token)) && 'fixture token reached child stdin',
    planPassedInline && 'complete plan was passed inline',
    !prompt.includes(config.planSentinel) && 'complete plan was absent from prompt file',
    Buffer.byteLength(args.join('\0'), 'utf8') >= Buffer.byteLength(prompt, 'utf8')
      && 'bounded instruction was not smaller than the prompt file',
  ].filter(Boolean);
  if (boundaryFailures.length) {
    process.stderr.write('fixture boundary assertion failed\n');
    process.exit(91);
  }

  if (config.behavior === 'empty') {
    process.stdout.write('  \n\t');
    return;
  }
  if (config.behavior === 'protected') {
    const protectedFile = mockPath.join(process.cwd(), '.gsd', 'poison.txt');
    mockFs.mkdirSync(mockPath.dirname(protectedFile), { recursive: true });
    mockFs.writeFileSync(protectedFile, 'temporary fixture poison\n', 'utf8');
  } else if (config.behavior === 'happy') {
    mockFs.writeFileSync(mockPath.join(process.cwd(), config.mockOutput), 'fixture output\n', 'utf8');
  } else {
    process.stderr.write('unknown fixture behavior\n');
    process.exit(92);
  }

  process.stdout.write([
    '---GSD-WORKER-RESULT---',
    'status: done',
    'result_json: ' + JSON.stringify(payload),
    '---END-RESULT---',
    '',
  ].join('\n'));
}

function writeMock(mockFile, fixture) {
  const config = {
    behavior: fixture.behavior,
    captureFile: fixture.captureFile,
    invocationsFile: fixture.invocationsFile,
    planSentinel: PLAN_SENTINEL,
    resultSummary: RESULT_SUMMARY,
    resultMustHave: RESULT_MUST_HAVE,
    mockOutput: MOCK_OUTPUT,
    selectedEnvKeys: [
      ...AUTH_KEYS,
      'FORGE_ACCOUNTS_REGISTRY',
      'FORGE_KEYCHAIN_DISABLED',
      'FORGE_XLLM_CLAUDE_BIN',
      'HOME',
      'USERPROFILE',
      'HTTP_PROXY',
      'HTTPS_PROXY',
    ],
  };
  const source = [
    "'use strict';",
    `(${mockClaudeMain.toString()})(${JSON.stringify(config)});`,
    '',
  ].join('\n');
  assert.ok(!source.includes(FIXTURE_TOKEN), 'the mock source must not know the token value');
  fs.writeFileSync(mockFile, source, { encoding: 'utf8', mode: 0o700 });
  try { fs.chmodSync(mockFile, 0o700); } catch { /* process.execPath reads it directly */ }
}

function findSafeGitPath() {
  const raw = process.env.PATH || process.env.Path || '';
  const gitNames = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];
  const claudeNames = ['claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1'];
  for (const entry of raw.split(path.delimiter).filter(Boolean)) {
    const hasGit = gitNames.some((name) => fs.existsSync(path.join(entry, name)));
    const hasClaude = claudeNames.some((name) => fs.existsSync(path.join(entry, name)));
    if (hasGit && !hasClaude) return entry;
  }
  throw new Error('fixture could not isolate a Git PATH that excludes every real claude executable');
}

function makeCliEnv(fixture) {
  const env = {};
  const platformKeys = [
    'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  ];
  for (const key of platformKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  const safeGitPath = findSafeGitPath();
  env.PATH = safeGitPath;
  if (process.platform === 'win32') env.Path = safeGitPath;
  env.HOME = fixture.home;
  env.USERPROFILE = fixture.home;
  env.APPDATA = fixture.appData;
  env.LOCALAPPDATA = fixture.localAppData;
  env.XDG_CONFIG_HOME = fixture.xdgConfig;
  env.TEMP = fixture.temp;
  env.TMP = fixture.temp;
  env.TMPDIR = fixture.temp;

  for (const key of AUTH_KEYS) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env, key), false,
      `${key} must be cleared before the CLI is spawned`);
  }
  assert.ok(Object.keys(env).every((key) =>
    !/(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)(?:_|$)/i.test(key)),
  'the base CLI environment must not inherit any generic credential variable');

  env.FORGE_KEYCHAIN_DISABLED = '1';
  env.FORGE_ACCOUNTS_REGISTRY = fixture.registryFile;
  env.FORGE_XLLM_CLAUDE_BIN = fixture.mockFile;
  return env;
}

function createFixture(scenarioDir, label, behavior, accountMode) {
  const home = path.join(scenarioDir, 'isolated-home');
  const claudeDir = path.join(home, '.claude');
  const workspace = path.join(scenarioDir, 'workspace with spaces');
  const registryFile = path.join(scenarioDir, 'forge-accounts-registry.json');
  const tokenFile = path.join(claudeDir, 'forge-accounts-tokens.json');
  const mockFile = path.join(scenarioDir, 'mock-claude.js');
  const captureFile = path.join(scenarioDir, 'mock-child-capture.json');
  const invocationsFile = path.join(scenarioDir, 'mock-invocations.txt');
  const planFile = path.join(scenarioDir, 'T03-FIXTURE-PLAN.md');
  const resultFile = path.join(scenarioDir, 'terminal-result.json');
  const temp = path.join(home, 'tmp');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const xdgConfig = path.join(home, '.config');
  const accountName = `fixture-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

  for (const ownedPath of [home, workspace, registryFile, tokenFile, mockFile,
    captureFile, invocationsFile, planFile, resultFile, temp, appData, localAppData, xdgConfig]) {
    assertPathInside(scenarioDir, ownedPath, `${label} fixture path`);
  }
  assert.notStrictEqual(path.resolve(home), path.resolve(os.homedir()), 'fixture HOME must differ from the host HOME');
  if (process.env.FORGE_ACCOUNTS_REGISTRY) {
    assert.notStrictEqual(path.resolve(registryFile), path.resolve(process.env.FORGE_ACCOUNTS_REGISTRY),
      'fixture registry must differ from the ambient registry');
  }
  assert.ok(!path.resolve(resultFile).startsWith(path.resolve(workspace) + path.sep),
    'result file must be external to the fixture repository');

  fs.mkdirSync(claudeDir, { recursive: true });
  for (const directory of [temp, appData, localAppData, xdgConfig, workspace]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const baseline = createReadOnlyGitFixture(workspace);
  const registry = accountMode === 'configured'
    ? {
      version: 1,
      active: accountName,
      accounts: {
        [accountName]: {
          added_at: '2026-08-27T00:00:00.000Z',
          last_used: null,
          note: 'isolated acceptance fixture',
          store: 'file',
        },
      },
    }
    : { version: 1, active: null, accounts: {} };
  const tokens = accountMode === 'configured' ? { [accountName]: FIXTURE_TOKEN } : {};
  writeJson(registryFile, registry);
  writeJson(tokenFile, tokens);
  const planText = buildPlanText();
  assert.ok(Buffer.byteLength(planText, 'utf8') > 4096, 'fixture plan must exercise file transport');
  fs.writeFileSync(planFile, planText, 'utf8');

  const fixture = {
    label, behavior, accountMode, scenarioDir, home, claudeDir, workspace,
    registryFile, tokenFile, mockFile, captureFile, invocationsFile, planFile,
    resultFile, temp, appData, localAppData, xdgConfig, accountName, baseline,
    planText,
  };
  writeMock(mockFile, fixture);
  fixture.env = makeCliEnv(fixture);

  assert.strictEqual(fixture.env.HOME, home);
  assert.strictEqual(fixture.env.USERPROFILE, home);
  assert.strictEqual(fixture.env.FORGE_KEYCHAIN_DISABLED, '1');
  assert.strictEqual(fixture.env.FORGE_ACCOUNTS_REGISTRY, registryFile);
  assert.strictEqual(fixture.env.FORGE_XLLM_CLAUDE_BIN, mockFile);
  for (const key of AUTH_KEYS) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(fixture.env, key), false,
      `isolated CLI env unexpectedly selected ${key}`);
  }
  assert.ok(!fs.readFileSync(registryFile, 'utf8').includes(FIXTURE_TOKEN),
    'the non-secret registry must not contain the fixture token');
  const storedTokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (accountMode === 'configured') {
    assert.ok(storedTokens[accountName] === FIXTURE_TOKEN,
      'the isolated file token store must contain the exact dummy token');
  } else {
    assert.deepStrictEqual(storedTokens, {});
  }
  return fixture;
}

function cliArgs(fixture) {
  return [
    '--mode', 'execute',
    '--engine', 'claude',
    '--host-runtime', 'codex',
    '--sidecar-declared',
    '--plan', fixture.planFile,
    '--cwd', fixture.workspace,
    '--result-file', fixture.resultFile,
    '--dispatch-id', `fixture-${fixture.label}`,
    '--timeout', '12',
    '--env-policy', 'minimal',
  ];
}

function runCli(fixture) {
  const args = cliArgs(fixture);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: fixture.scenarioDir,
      env: fixture.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const adapterPid = child.pid;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      reject(new Error(`fixture CLI timed out in scenario ${fixture.label}`));
    }, 25000);

    function capture(chunks, chunk, stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stream === 'stdout') stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (stdoutBytes > 1024 * 1024 || stderrBytes > 1024 * 1024) {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        return;
      }
      chunks.push(buffer);
    }

    child.stdout.on('data', (chunk) => capture(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => capture(stderr, chunk, 'stderr'));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        adapterPid,
        argv: [process.execPath, CLI_PATH, ...args],
        stdin: CLI_STDIN,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.on('error', (error) => {
      if (error && error.code !== 'EPIPE' && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.stdin.end(CLI_STDIN);
  });
}

function readTerminalResult(fixture) {
  assert.ok(fs.existsSync(fixture.resultFile), `${fixture.label} must write its external result file`);
  return {
    text: fs.readFileSync(fixture.resultFile, 'utf8'),
    value: JSON.parse(fs.readFileSync(fixture.resultFile, 'utf8')),
  };
}

function readCapture(fixture) {
  assert.ok(fs.existsSync(fixture.captureFile), `${fixture.label} must produce mock child evidence`);
  return JSON.parse(fs.readFileSync(fixture.captureFile, 'utf8'));
}

function invocationPids(fixture) {
  if (!fs.existsSync(fixture.invocationsFile)) return [];
  return fs.readFileSync(fixture.invocationsFile, 'utf8').split(/\r?\n/).filter(Boolean).map(Number);
}

function assertTokenAbsent(channelName, value) {
  assert.ok(!String(value).includes(FIXTURE_TOKEN), `fixture token leaked through ${channelName}`);
}

function assertCliContract(fixture, run) {
  const args = run.argv.slice(2);
  assert.deepStrictEqual(args, cliArgs(fixture), 'the suite must invoke the public CLI with real execute arguments');
  assert.ok(!args.some((arg) => String(arg).includes(PLAN_SENTINEL)), 'the complete plan body must not enter CLI argv');
  assert.ok(path.resolve(fixture.resultFile) !== path.resolve(fixture.workspace));
  assert.strictEqual(run.signal, null);
}

function assertFivePublicTokenChannels(run, terminalText) {
  // Five intentionally separate assertions lock every public transport surface.
  assertTokenAbsent('CLI argv', run.argv.join('\0'));
  assertTokenAbsent('CLI stdin', run.stdin);
  assertTokenAbsent('CLI stdout', run.stdout);
  assertTokenAbsent('CLI stderr', run.stderr);
  assertTokenAbsent('terminal result-file JSON', terminalText);
}

function assertMockEvidence(fixture, run, capture) {
  assert.strictEqual(capture.behavior, fixture.behavior);
  assert.ok(Number.isInteger(capture.pid) && capture.pid > 0, 'mock PID must be recorded');
  assert.strictEqual(capture.adapter_pid, run.adapterPid, 'mock parent must be the actual adapter CLI PID');
  assert.notStrictEqual(capture.pid, capture.adapter_pid, 'mock child PID must differ from adapter_pid');
  assert.strictEqual(capture.exec_path, process.execPath, 'JS mock must launch through process.execPath');
  assert.strictEqual(path.resolve(capture.script_path), path.resolve(fixture.mockFile));
  assert.strictEqual(capture.stdin.bytes, 0, 'the sidecar must spawn mock Claude with ignored stdin');
  assert.strictEqual(capture.stdin.content, '');
  assert.ok(capture.selected_env.ANTHROPIC_AUTH_TOKEN === FIXTURE_TOKEN,
    'real registry/token-store resolution must inject the exact fixture token into child env');
  assert.strictEqual(capture.selected_env.FORGE_ACCOUNT, fixture.accountName,
    'the child account selection must come from the isolated registry default');
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_API_KEY',
    'FORGE_ACCOUNTS_REGISTRY', 'FORGE_KEYCHAIN_DISABLED', 'FORGE_XLLM_CLAUDE_BIN',
    'HTTP_PROXY', 'HTTPS_PROXY']) {
    assert.strictEqual(capture.selected_env[key], null, `${key} must not reach the mock child`);
  }
  assert.strictEqual(capture.selected_env.HOME, fixture.home);
  if (process.platform === 'win32') assert.strictEqual(capture.selected_env.USERPROFILE, fixture.home);
  assert.strictEqual(capture.token_in_argv, false);
  assert.strictEqual(capture.plan_passed_inline, false);
  assert.strictEqual(capture.fixture_error, null);
  assert.ok(capture.prompt_contents.includes(fixture.planText), 'prompt file must contain the complete plan verbatim');
  assert.ok(capture.prompt_contents.includes(PLAN_SENTINEL));
  assert.ok(Buffer.byteLength(capture.argv.join('\0'), 'utf8') < Buffer.byteLength(capture.prompt_contents, 'utf8'),
    'mock argv must carry only a bounded file instruction');
  assertTokenAbsent('mock child argv', capture.argv.join('\0'));
  assertTokenAbsent('mock child stdin', capture.stdin.content);
  assertTokenAbsent('prompt-file contents', capture.prompt_contents);
  assert.ok(capture.prompt_file && !fs.existsSync(capture.prompt_file),
    'the adapter prompt directory must be removed before the CLI returns');
  assert.deepStrictEqual(invocationPids(fixture), [capture.pid], 'the mock must be invoked exactly once');
  assert.deepStrictEqual(capture.planned_payload, {
    status: 'done',
    summary: RESULT_SUMMARY,
    must_haves_status: [RESULT_MUST_HAVE],
    files_changed: ['model-declared-output.txt'],
  });
}

async function happyPath(root) {
  const scenarioDir = fs.mkdtempSync(path.join(root, 'happy-'));
  try {
    const fixture = createFixture(scenarioDir, 'happy', 'happy', 'configured');
    const run = await runCli(fixture);
    const terminal = readTerminalResult(fixture);
    const capture = readCapture(fixture);

    assertCliContract(fixture, run);
    assert.strictEqual(run.code, 0);
    assert.strictEqual(run.stdout, '', 'top-level success stdout must remain byte-empty');
    assertFivePublicTokenChannels(run, terminal.text);
    assertMockEvidence(fixture, run, capture);

    assert.strictEqual(terminal.value.status, 'done');
    assert.strictEqual(terminal.value.summary, RESULT_SUMMARY);
    assert.deepStrictEqual(terminal.value.must_haves_status, [RESULT_MUST_HAVE]);
    assert.deepStrictEqual(terminal.value.files_changed, [{ status: 'A', path: MOCK_OUTPUT }],
      'changed files must be VCS-derived rather than trusted from the worker payload');
    assert.deepStrictEqual(terminal.value.files_changed_declared, ['model-declared-output.txt']);
    assert.deepStrictEqual(terminal.value.pre_dirty, []);
    assert.strictEqual(terminal.value.start_sha, fixture.baseline);
    assert.strictEqual(terminal.value.head_sha, fixture.baseline);
    assert.strictEqual(terminal.value.parse_path, 'worker-result-block');
    assert.strictEqual(terminal.value.capability, 'workspace');
    assert.strictEqual(terminal.value.appserver.transport, 'claude-cli');
    assert.ok(fs.existsSync(path.join(fixture.workspace, MOCK_OUTPUT)));
    assert.ok(!fs.readdirSync(fixture.workspace).some((name) => name.startsWith('.forge-claude-sidecar-')),
      'prompt transport directories must not survive success');
  } finally {
    removeOwnedFixture(root, scenarioDir);
  }
}

async function missingAccountPath(root) {
  const scenarioDir = fs.mkdtempSync(path.join(root, 'missing-account-'));
  try {
    const fixture = createFixture(scenarioDir, 'missing-account', 'happy', 'empty');
    const run = await runCli(fixture);
    const terminal = readTerminalResult(fixture);

    assertCliContract(fixture, run);
    assert.strictEqual(run.code, 2);
    assertFivePublicTokenChannels(run, terminal.text);
    assert.strictEqual(terminal.value.status, 'adapter-failed');
    assert.strictEqual(terminal.value.reason_code, 'claude-account-unavailable');
    assert.deepStrictEqual(invocationPids(fixture), [], 'empty registry must refuse before mock spawn');
    assert.ok(!fs.existsSync(fixture.captureFile), 'empty registry must never produce child capture evidence');
    assert.ok(!fs.existsSync(path.join(fixture.workspace, MOCK_OUTPUT)), 'no fallback worker may write output');
    assert.ok(!fs.readdirSync(fixture.workspace).some((name) => name.startsWith('.forge-claude-sidecar-')),
      'account refusal must not leave a prompt transport directory');
  } finally {
    removeOwnedFixture(root, scenarioDir);
  }
}

async function emptyOutputPath(root) {
  const scenarioDir = fs.mkdtempSync(path.join(root, 'empty-output-'));
  try {
    const fixture = createFixture(scenarioDir, 'empty-output', 'empty', 'configured');
    const run = await runCli(fixture);
    const terminal = readTerminalResult(fixture);
    const capture = readCapture(fixture);

    assertCliContract(fixture, run);
    assert.strictEqual(run.code, 2);
    assertFivePublicTokenChannels(run, terminal.text);
    assertMockEvidence(fixture, run, capture);
    assert.strictEqual(terminal.value.status, 'adapter-failed');
    assert.strictEqual(terminal.value.reason_code, 'claude-empty-output');
    assert.ok(!fs.existsSync(path.join(fixture.workspace, MOCK_OUTPUT)));
  } finally {
    removeOwnedFixture(root, scenarioDir);
  }
}

function assertSharedProtectedFenceSource() {
  const source = fs.readFileSync(CLI_PATH, 'utf8');
  assert.match(source,
    /function assertNoProtectedSidecarChanges\(changes\)[\s\S]*?codex touched protected \.gsd\/\*\*/,
    'the established protected-change implementation must remain present');
  assert.strictEqual((source.match(/assertNoProtectedSidecarChanges\(derived\);/g) || []).length, 1,
    'execute must use the one shared post-transport protected-change fence');
}

async function protectedWritePath(root) {
  const scenarioDir = fs.mkdtempSync(path.join(root, 'protected-write-'));
  try {
    const fixture = createFixture(scenarioDir, 'protected-write', 'protected', 'configured');
    const run = await runCli(fixture);
    const terminal = readTerminalResult(fixture);
    const capture = readCapture(fixture);

    assertCliContract(fixture, run);
    assert.strictEqual(run.code, 2);
    assertFivePublicTokenChannels(run, terminal.text);
    assertMockEvidence(fixture, run, capture);
    assert.strictEqual(terminal.value.status, 'adapter-failed');
    assert.strictEqual(terminal.value.reason, 'codex touched protected .gsd/**: .gsd/poison.txt');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(terminal.value, 'reason_code'), false,
      'the existing shared fence must remain the source of this failure');
    const poison = path.join(fixture.workspace, PROTECTED_OUTPUT);
    assert.ok(fs.existsSync(poison), 'the temporary poison write must be observed before fixture cleanup');
    assert.strictEqual(fs.readFileSync(poison, 'utf8'), 'temporary fixture poison\n');
    assert.ok(!fs.existsSync(path.join(fixture.workspace, MOCK_OUTPUT)),
      'the protected scenario must not use the ordinary-output branch');
    assertSharedProtectedFenceSource();
  } finally {
    // This removes only the scenario-owned repository, including its temporary
    // .gsd/poison.txt. The project's real .gsd tree is never a target.
    removeOwnedFixture(root, scenarioDir);
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(PROJECT_ROOT, '.forge-xllm-claude-test-'));
  assertPathInside(PROJECT_ROOT, root, 'suite fixture root');
  const tests = [
    ['fixture-backed account success reaches a separate mock PID', happyPath],
    ['empty isolated registry refuses before provider spawn', missingAccountPath],
    ['exit zero with empty stdout has the frozen empty-output code', emptyOutputPath],
    ['valid worker output still crosses the shared protected-change fence', protectedWritePath],
  ];
  let passed = 0;
  const failures = [];

  try {
    for (const [name, fn] of tests) {
      try {
        await fn(root);
        passed += 1;
        process.stdout.write(`  \u2713 ${name}\n`);
      } catch (error) {
        failures.push({ name, error });
        process.stdout.write(`  \u2717 ${name}: ${error.message}\n`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    if (fs.existsSync(root)) throw new Error('suite fixture root survived cleanup');
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  process.stdout.write('Local fixture-backed acceptance only: no network or real provider was used; real Claude authentication and execution remain unproven.\n');
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`forge-xllm-claude.test.js: ${error.message}\n`);
  process.exitCode = 1;
});
