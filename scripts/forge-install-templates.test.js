#!/usr/bin/env node
'use strict';

// Offline wrapper/dispatch inventory tests. Homes are always temporary; no
// real Claude, Codex, network, login or model probe is used.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TEMPLATE_FILES } = require('./forge-prompt.js');
const installer = require('./forge-installer.js');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_SH = path.join(ROOT, 'install.sh');
const INSTALL_PS1 = path.join(ROOT, 'install.ps1');
const TEMPLATE_SRC = path.join(ROOT, 'shared', 'templates', 'dispatch');
const roots = [];
let passed = 0;
let skipped = 0;
function tempRoot(label) { const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-install-${label}-`)); roots.push(root); return root; }
function test(name, fn) { try { fn(); passed++; process.stdout.write(`ok - ${name}\n`); } catch (error) { process.stderr.write(`not ok - ${name}\n${error.stack}\n`); process.exitCode = 1; } }
function skip(name, reason) { skipped++; process.stdout.write(`ok - ${name} # SKIP ${reason}\n`); }
function templateNames(dir) { return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); }
function allFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function treeContains(root, pattern) {
  return allFiles(root).some((file) => {
    try { return pattern.test(fs.readFileSync(file, 'utf8')); } catch (_) { return false; }
  });
}
function nativePowerShell() {
  for (const command of process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh', 'powershell']) {
    const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

test('template inventory matches forge-prompt dispatch units', () => {
  assert.deepStrictEqual(templateNames(TEMPLATE_SRC), Object.values(TEMPLATE_FILES).sort());
  assert.ok(templateNames(TEMPLATE_SRC).length >= 10);
});

test('both wrappers delegate runtime/update/dry-run to the shared Node core', () => {
  const shell = fs.readFileSync(INSTALL_SH, 'utf8');
  assert.match(shell, /forge-installer\.js/);
  assert.match(shell, /forge-update\.js/);
  assert.match(shell, /"\$\{FORWARDED\[@\]\}"/);
  const powershell = fs.readFileSync(INSTALL_PS1, 'utf8');
  assert.match(powershell, /ValidateSet\('claude', 'codex', 'both'\)/);
  assert.match(powershell, /-DryRun/);
  assert.match(powershell, /forge-installer\.js/);
  assert.match(powershell, /forge-update\.js/);
  assert.match(powershell, /PSBoundParameters\.ContainsKey\('Runtime'\)/);
  assert.match(powershell, /ProjectRoot/);
});

test('core dry-run is deterministic and reports only selected adapter', () => {
  const root = tempRoot('dry-run');
  const options = { repo: ROOT, runtime: 'codex', dryRun: true, forgeHome: path.join(root, 'forge home Ω'), claudeHome: path.join(root, 'claude'), codexHome: path.join(root, 'codex') };
  const left = JSON.stringify(installer.install(options));
  const right = JSON.stringify(installer.install(options));
  // Backup names are intentionally absent on a first dry run; the plan is byte deterministic.
  assert.strictEqual(left, right);
  assert.strictEqual(fs.existsSync(options.forgeHome), false);
  assert(!JSON.parse(left).plan.some((entry) => entry.destination.startsWith(options.claudeHome)));
});

test('temporary Claude and Codex installs carry delivery helper, contract and operational consumers', () => {
  const root = tempRoot('delivery-projections');
  const options = {
    repo: ROOT, runtime: 'both', noModelProbe: true, skipCapabilityCheck: true,
    forgeHome: path.join(root, 'forge'), claudeHome: path.join(root, 'claude'),
    codexHome: path.join(root, 'codex'), projectRoot: path.join(root, 'project'),
    userHome: root, env: { ...process.env, HOME: root, USERPROFILE: root },
  };
  fs.mkdirSync(options.projectRoot, { recursive: true });
  const result = installer.install(options);
  assert.strictEqual(result.ok, true);
  assert(fs.existsSync(path.join(options.forgeHome, 'scripts', 'forge-delivery.js')));
  assert(fs.existsSync(path.join(options.forgeHome, 'scripts', 'forge-task-preparation.js')));
  const nativeInvocationPath = path.join(options.forgeHome, 'scripts', 'forge-native-invocation.js');
  assert(fs.existsSync(nativeInvocationPath));
  assert(fs.existsSync(path.join(options.forgeHome, 'shared', 'forge-delivery.md')));
  assert(fs.existsSync(path.join(options.forgeHome, 'shared', 'forge-task-preparation.md')));
  const contract = fs.readFileSync(path.join(options.forgeHome, 'shared', 'forge-delivery.md'), 'utf8');
  assert.match(contract, /três|verificado/);
  for (const [host, home] of [['Claude', options.claudeHome], ['Codex', options.codexHome]]) {
    assert(treeContains(home, /forge-delivery\.js[\s\S]*DELIVERY\.json/), `${host} projection lacks operational delivery invocation`);
    const completion = require(path.join(options.forgeHome, 'scripts/forge-prompt.js')).renderPrompt({ cwd: options.projectRoot, forgeHome: options.forgeHome, unitType: 'complete-slice', milestoneId: 'M001', sliceId: 'S01' });
    assert.strictEqual(completion.procedure_context.root, fs.realpathSync(options.forgeHome));
    assert.match(completion.prompt, /every expected child delivery/, `${host} installed composition lacks complete child aggregation`);
    assert(treeContains(home, /After review handling[\s\S]*DELIVERY-INPUT/), `${host} projection lacks post-review rematerialization`);
    const task = fs.readFileSync(path.join(home, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
    const preparation = task.slice(task.indexOf('### Canonical preparation caller'), task.indexOf('### Step 4.5'));
    assert.match(preparation, /forge-task-preparation\.js[\s\S]*--start/, `${host} projection lacks the preparation caller`);
    assert.match(preparation, new RegExp(`hostRuntime: ["']${host.toLowerCase()}["']`), `${host} projection has the wrong runtime`);
    assert.doesNotMatch(preparation, /worker_mode:native|workerMode:\s*["']native["']/,
      `${host} projection forces preparation native`);
  }
  for (const skill of ['forge-task', 'forge-auto', 'forge-next']) {
    const projected = fs.readFileSync(path.join(options.codexHome, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(projected, /buildNativeInvocation/, `${skill} lacks the installed native adapter contract`);
    assert.match(projected, /observeClaudeAgentBinding/, `${skill} lacks real Claude agent binding observation`);
    assert.match(projected, /SHA-256/, `${skill} lacks stable Claude binding provenance`);
    assert.match(projected, /Prompt text is not an effort API|prompt header is descriptive text,\s*not an effort API/i,
      `${skill} incorrectly permits prompt text as Claude effort transport`);
    assert.match(projected, /`reasoning_effort`/, `${skill} lacks the installed Codex effort argument`);
    assert.match(projected, /(?:forkTurns|fork_turns):?'none'/, `${skill} lacks the installed bounded fork`);
    assert.match(projected, /Never omit[\s\S]{0,80}model[\s\S]{0,80}inherit agent frontmatter/i,
      `${skill} permits default model inheritance after install`);
    assert.doesNotMatch(projected, /model:\s*\$MODEL_ALIAS|using frontmatter/i,
      `${skill} retained the legacy native alias/default path after install`);
  }

  // Review-fix sidecar, model policy and review effort: the new helpers are part
  // of the installed inventory, their tests are not, and every host projection
  // carries the same executable review-fix sidecar branch.
  for (const helper of ['forge-model-policy.js', 'forge-review-fix.js', 'forge-review-effort.js', 'forge-review-policy.js']) {
    assert(fs.existsSync(path.join(options.forgeHome, 'scripts', helper)), `${helper} missing from the installed inventory`);
    assert(!fs.existsSync(path.join(options.forgeHome, 'scripts', helper.replace(/\.js$/, '.test.js'))),
      `${helper} test leaked into the installed inventory`);
  }
  const installedCapabilities = require(path.join(options.forgeHome, 'scripts', 'forge-transport-capabilities.js'));
  assert.strictEqual(installedCapabilities.UNIT_MODES['review-fix'], 'fix');
  for (const [host, home] of [['Claude', options.claudeHome], ['Codex', options.codexHome]]) {
    for (const skill of ['forge-task', 'forge-auto', 'forge-next']) {
      const projected = fs.readFileSync(path.join(home, 'skills', skill, 'SKILL.md'), 'utf8');
      assert.match(projected, /review-fix sidecar/i, `${host}/${skill} lacks the review-fix sidecar branch`);
      assert.match(projected, /RF_ROUTE_JSON_SAVED/, `${host}/${skill} review-fix branch does not reuse the saved route`);
    }
    const review = fs.readFileSync(path.join(options.forgeHome, 'shared', 'forge-review.md'), 'utf8');
    assert.match(review, /forge-unit-sidecar\.js" --request/, `${host} install lacks the review-fix sidecar delivery`);
    assert.match(review, /forge-review-fix\.js" --accept-native/, `${host} install lacks native review-fix acceptance`);
  }

  // #341 review-fix-policy-v1: the installed spec documents the admission, and both host
  // projections of the three orchestration skills classify, defer, group one cycle with a
  // dispatchId, relay the ⚖ status line and collect the new marker. Distribution only: this
  // does not show a host or model following the text.
  assert(!fs.existsSync(path.join(options.forgeHome, 'scripts', 'forge-review-policy-distribution.test.js')),
    'policy distribution suite leaked into the installed inventory');
  const installedReview = fs.readFileSync(path.join(options.forgeHome, 'shared', 'forge-review.md'), 'utf8');
  for (const token of ['## Política executável de review-fix', '### Admissão no último portão', 'forge-review-policy.js --admit --request',
    '`review-fix-cycle-limit`', '`review-fix-budget-exhausted`', '`review-fix-not-fix-now`', '`review-fix-policy-invalid`', '`review-fix-admission`']) {
    assert(installedReview.includes(token), `installed forge-review.md lacks the admission contract: ${token}`);
  }
  const MARKER = 'não aplicada — deferida para triagem final';
  for (const [host, home] of [['Claude', options.claudeHome], ['Codex', options.codexHome]]) {
    for (const skill of ['forge-task', 'forge-auto', 'forge-next']) {
      const projected = fs.readFileSync(path.join(home, 'skills', skill, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
      const label = `${host}/${skill}`;
      assert.match(projected, /forge-review-policy\.js" --classify --input "\$RF_VERDICTS_FILE"/, `${label} lacks --classify before the cycle`);
      assert.match(projected, /forge-review-policy\.js" --status --cwd "\$WORKING_DIR"/, `${label} lacks the ⚖ status line`);
      assert.match(projected, /forge-review-fix\.js" --defer "\$RF_DEFER_REQUEST"/, `${label} lacks the deferral of non fix-now items`);
      for (const token of [MARKER, 'Um ciclo é um único request agrupado', '`dispatchId`', '`--prepare-native`', '`Refatorar agora`',
        'basis: operator-decision', 'repasse verbatim a linha `⚖`', 'verificação dirigida', 'sem nova revisão',
        '`review-fix-cycle-limit`', 'sem retry, sem bypass, sem correção inline e sem outro worker', '`review-per-task-in-milestone`']) {
        assert(projected.includes(token), `${label} lacks: ${token}`);
      }
      assert.doesNotMatch(projected, /review-fix` unit for (?:that|this|each) item|Refatorar agora` — dispatches a `review-fix` unit|Despacha um review-fix para este item/,
        `${label} still dispatches review-fix per item in the gate`);
    }
    for (const skill of ['forge-auto', 'forge-next']) {
      const projected = fs.readFileSync(path.join(home, 'skills', skill, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
      const triage = projected.slice(projected.indexOf('**Review triage gate (before complete-milestone):**'), projected.indexOf('**Plan-check gate'));
      assert(triage.includes(`Correção: ${MARKER} (<motivo>)`), `${host}/${skill} Step 9 does not collect the new marker`);
      assert(triage.includes('`counted:false`'), `${host}/${skill} triage is not recorded outside the cycle cap`);
      assert(projected.includes('--milestone "$RF_MILESTONE_ID" --slice "$RF_UNIT_ID"'), `${host}/${skill} status is not scoped to the slice`);
      assert(projected.includes('`review.milestone_task_review: true`'), `${host}/${skill} lacks the milestone review boundary`);
    }
    const task = fs.readFileSync(path.join(home, 'skills', 'forge-task', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    assert(task.includes('--task "$RF_UNIT_ID"') && task.includes('`source: review/{TASK_ID}/{R#}`') && task.includes('§ Item capture'),
      `${host}/forge-task deferred items do not become items`);
  }

  const installedSidecar = require(path.join(options.forgeHome, 'scripts', 'forge-unit-sidecar.js'));
  const savedForgeHome = process.env.FORGE_HOME;
  let installedMemoryPrompt;
  try {
    process.env.FORGE_HOME = options.forgeHome;
    installedMemoryPrompt = installedSidecar.memoryPrompt({ cwd: options.projectRoot,
      sourceUnitType: 'execute-task', summaryContent: 'installed memory fixture',
    }, 'T01');
    const installedLoader = require(path.join(options.forgeHome, 'scripts/forge-procedure-context.js'));
    const installedRenderer = require(path.join(options.forgeHome, 'scripts/forge-prompt.js'));
    for (const unitType of ['execute-task', 'complete-slice', 'complete-milestone']) {
      const rendered = installedRenderer.renderPrompt({ cwd: options.projectRoot, forgeHome: options.forgeHome, unitType, milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' });
      assert.strictEqual(rendered.procedure_context.root, fs.realpathSync(options.forgeHome));
      for (const token of ['forge-delivery.js', '--owner-root', '--code-dir']) assert(rendered.prompt.includes(token), token);
    }
    assert.strictEqual(installedLoader.loadProcedureContext({ cwd: options.projectRoot, forgeHome: options.forgeHome, phase: 'memory-extract' }).root, fs.realpathSync(options.forgeHome));
    for (const [relative, code] of [['shared/forge-procedures.json', 'procedure-manifest-missing'], ['shared/forge-procedure-memory.md', 'procedure-file-unreadable']]) {
      const file = path.join(options.forgeHome, relative), bytes = fs.readFileSync(file);
      fs.unlinkSync(file);
      try {
        assert.throws(() => installedSidecar.memoryPrompt({ cwd: options.projectRoot }, 'T01'), error => error.code === code);
        assert.throws(() => installedLoader.loadProcedureContext({ cwd: options.projectRoot, forgeHome: options.forgeHome, phase: 'memory-extract' }), error => error.code === code);
      } finally { fs.writeFileSync(file, bytes); }
    }
  } finally {
    if (savedForgeHome === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = savedForgeHome;
  }
  assert.match(installedMemoryPrompt, /Read-only memory extraction/);
  assert.match(installedMemoryPrompt, /installed memory fixture/);
  assert.match(installedMemoryPrompt, /project-specific, non-obvious, durable facts/);
  const { buildNativeInvocation } = require(nativeInvocationPath);
  const resolvedDispatch = {
    host_runtime: 'codex', resolved_worker_engine: 'codex', dispatch_engine: 'codex',
    worker_mode: 'native', dispatch_allowed: true, config_ok: true,
    model_requested: 'gpt-6-luna', model_resolved: 'gpt-6-luna',
    model: 'gpt-6-luna', effort: 'medium',
  };
  const rejected = buildNativeInvocation({
    hostRuntime: 'codex', resolvedDispatch,
    activeCapabilities: {
      available: true, tool: 'spawn_agent', source: 'install-test-active-tool',
      models: ['gpt-6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'],
    },
    agentType: 'forge-memory', prompt: installedMemoryPrompt, forkTurns: 'none',
  });
  assert.strictEqual(rejected.reason_code, 'native-model-unsupported');
  const accepted = buildNativeInvocation({
    hostRuntime: 'codex', resolvedDispatch,
    activeCapabilities: {
      available: true, tool: 'spawn_agent', source: 'install-test-active-tool',
      models: ['gpt-6-luna'], reasoning_efforts: ['medium'], fork_turns: ['none'],
    },
    agentType: 'forge-memory', prompt: installedMemoryPrompt, forkTurns: 'none',
  });
  assert.strictEqual(accepted.ok, true, JSON.stringify(accepted));
  assert.strictEqual(accepted.args.message, installedMemoryPrompt);
  assert.deepStrictEqual(
    {
      model: accepted.args.model,
      reasoning_effort: accepted.args.reasoning_effort,
      fork_turns: accepted.args.fork_turns,
    },
    { model: 'gpt-6-luna', reasoning_effort: 'medium', fork_turns: 'none' },
  );
});

test('delivery references cover native, sidecar and headless task/slice/milestone sources', () => {
  const taskSkill = fs.readFileSync(path.join(ROOT, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
  assert.match(taskSkill, /orchestrator, as artifact owner[\s\S]*forge-delivery\.js/);
  assert.match(taskSkill, /## Entrega por critério/);
  assert.doesNotMatch(taskSkill, /## Must-Haves Verified\s*\n\s*- \[x\] item 1/);
  assert.match(taskSkill, /After review handling[\s\S]*re-run the two `forge-delivery\.js` materializations/);
  const executor = fs.readFileSync(path.join(ROOT, 'agents', 'forge-executor.md'), 'utf8');
  assert.match(executor, /Capture delivery sources contemporaneously/);
  assert.match(executor, /Materialize delivery/);
  for (const file of ['shared/forge-completer-slice.md', 'shared/forge-completer-milestone.md']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /complete sibling[\s\S]*DELIVERY\.json/i);
    assert.match(source, /forge-delivery\.js/);
  }
  for (const unitType of ['execute-task', 'complete-slice', 'complete-milestone']) {
    const source = require('./forge-prompt').renderPrompt({ cwd: ROOT, unitType, milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' }).prompt;
    assert.match(source, /forge-delivery\.js/);
    assert.match(source, /--owner-root/);
    assert.match(source, /--code-dir/);
  }
});

if (process.platform === 'win32') {
  const ps = nativePowerShell();
  if (!ps) skip('PowerShell native dry-run', 'PowerShell unavailable');
  else test('PowerShell native dry-run accepts Codex and Unicode homes', () => {
    const root = tempRoot('ps');
    const env = { ...process.env, USERPROFILE: root, HOME: root };
    const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_PS1, '-Runtime', 'codex', '-DryRun', '-NoModelProbe', '-ForgeHome', path.join(root, 'forge Ω')], { encoding: 'utf8', env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /runtime: codex/);
    assert.strictEqual(fs.existsSync(path.join(root, 'forge Ω')), false);
  });
} else {
  test('POSIX wrapper dry-run accepts Codex and leaves homes absent', () => {
    const root = tempRoot('posix');
    const forgeHome = path.join(root, 'forge home Ω');
    const result = spawnSync('bash', [INSTALL_SH, '--runtime', 'codex', '--dry-run', '--no-model-probe'], { encoding: 'utf8', env: { ...process.env, HOME: root, FORGE_HOME: forgeHome }, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /runtime: codex/);
    assert.strictEqual(fs.existsSync(forgeHome), false);
  });
}

for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
process.stdout.write(`\n${passed} passed, ${skipped} skipped\n`);
