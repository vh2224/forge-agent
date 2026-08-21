#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  TEMPLATE_FILES,
  resolveTemplate,
  extractStandards,
  renderPrompt,
  materializePrompt,
  cleanupPrompt,
  _private,
} = require('./forge-prompt.js');
const { truncateChars, truncateContext, boundStandards, NO_DOMAINS_NOTICE, SINGLE_REPO_NOTICE } = _private;
const { countTokens } = require('./forge-tokens.js');

const SCRIPT = path.join(__dirname, 'forge-prompt.js');
const tempRoots = [];
let passed = 0;

function tempWorkspace(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-prompt-${label}-`));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gsd', 'CODING-STANDARDS.md'), [
    '# Coding Standards',
    '',
    '## Lint & Format Commands',
    'npm run lint',
    '',
    '## Directory Conventions',
    'Source belongs in src/.',
    '',
    '## Asset Map',
    'Reuse src/lib/api.js.',
    '',
    '## Pattern Catalog',
    'Use Result objects.',
    '',
    '## Code Rules',
    'Never swallow errors.',
    '',
  ].join('\n'));
  return root;
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

function baseOptions(cwd, unitType) {
  return {
    cwd,
    unitType,
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    description: 'Ship deterministic dispatch prompts',
    unitEffort: 'medium',
    thinking: 'adaptive',
    autoCommit: false,
    milestoneCleanup: 'keep',
    planCheckMode: 'advisory',
    mustHavesCheckResults: 'pass: 4\nwarn: 0\nfail: 0',
    memories: ['Prefer deterministic inputs', 'Keep prompts bounded'],
  };
}

function withIsolatedHome(home, fn) {
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return fn(); }
  finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  }
}

test('declares every currently dispatched unit type', () => {
  assert.deepStrictEqual(Object.keys(TEMPLATE_FILES).sort(), [
    'complete-milestone',
    'complete-slice',
    'discuss-milestone',
    'discuss-slice',
    'execute-loose-task',
    'execute-task',
    'plan-check',
    'plan-milestone',
    'plan-slice',
    'research-milestone',
    'research-slice',
  ]);
});

test('resolves a project-local template before a global template', () => {
  const cwd = tempWorkspace('precedence');
  const home = path.join(cwd, 'fake-home');
  const scriptDir = path.join(cwd, 'fake-install', 'scripts');
  const localDir = path.join(cwd, 'shared', 'templates', 'dispatch');
  const globalDir = path.join(home, '.claude', 'templates', 'dispatch');
  fs.mkdirSync(localDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'execute-task.md'), 'LOCAL {T##}\n');
  fs.writeFileSync(path.join(globalDir, 'execute-task.md'), 'GLOBAL {T##}\n');
  const found = resolveTemplate('execute-task', { cwd, homeDir: home, scriptDir });
  assert.strictEqual(found.scope, 'project');
  assert.strictEqual(found.content, 'LOCAL {T##}\n');
});

test('falls back to the installed global template when no local copy exists', () => {
  const cwd = tempWorkspace('global');
  const home = path.join(cwd, 'fake-home');
  const scriptDir = path.join(cwd, 'fake-install', 'scripts');
  const globalDir = path.join(home, '.claude', 'templates', 'dispatch');
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(globalDir, 'plan-milestone.md'), 'GLOBAL {M###}: {description}\n');
  const found = resolveTemplate('plan-milestone', { cwd, homeDir: home, scriptDir });
  assert.strictEqual(found.scope, 'global');
  assert.strictEqual(found.content, 'GLOBAL {M###}: {description}\n');
});

test('extracts only the bounded coding-standard sections', () => {
  const standards = extractStandards([
    '## Lint & Format Commands',
    'npm run lint',
    '## Directory Conventions',
    'src/',
    '## Asset Map',
    'src/lib.js',
    '## Pattern Catalog',
    'Result<T>',
    '## Code Rules',
    'No ignored errors.',
    '## Unrelated',
    'large irrelevant context',
  ].join('\n'));
  assert.strictEqual(standards.CS_LINT, 'npm run lint');
  assert.strictEqual(standards.CS_STRUCTURE, 'src/\n\nsrc/lib.js\n\nResult<T>');
  assert.strictEqual(standards.CS_RULES, 'No ignored errors.');
  assert.ok(!JSON.stringify(standards).includes('large irrelevant context'));
});

test('renders all unit templates with no contract placeholder left behind', () => {
  const cwd = tempWorkspace('all-units');
  for (const unitType of Object.keys(TEMPLATE_FILES)) {
    const result = renderPrompt(baseOptions(cwd, unitType));
    assert.ok(result.prompt.includes('WORKING_DIR:'));
    assert.ok(result.prompt.endsWith('\n'));
    assert.ok(!/\{(?:WORKING_DIR|M###|S##|T##|auto_commit|milestone_cleanup|unit_effort|THINKING_OPUS|CS_LINT|CS_STRUCTURE|CS_RULES|TOP_MEMORIES|description|PLAN_CHECK_MODE|MUST_HAVES_CHECK_RESULTS)\}/.test(result.prompt));
    assert.strictEqual(result.input_tokens, countTokens(result.prompt));
    assert.ok(result.input_tokens < 1500, `${unitType} prompt unexpectedly large: ${result.input_tokens}`);
  }
});

test('injects selected memories from the future selective-provider seam', () => {
  const cwd = tempWorkspace('memory-provider');
  let received;
  const options = baseOptions(cwd, 'execute-task');
  delete options.memories;
  options.memoryProvider = query => {
    received = query;
    return { facts: ['Fact one', { fact: 'Fact two' }] };
  };
  const result = renderPrompt(options);
  assert.strictEqual(received.unitType, 'execute-task');
  assert.strictEqual(received.unitId, 'T01');
  assert.ok(result.prompt.includes('- Fact one\n- Fact two'));
});

test('does not execute a project-local JavaScript shadow of the memory API', () => {
  const cwd = tempWorkspace('memory-shadow');
  const scripts = path.join(cwd, 'scripts');
  const marker = path.join(cwd, 'shadow-executed');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, 'forge-memory.js'), [
    "'use strict';",
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    'module.exports.queryRelevant = query => ({',
    "  facts: ['untrusted-' + query.unitType],",
    '});',
    '',
  ].join('\n'));
  const options = baseOptions(cwd, 'plan-milestone');
  delete options.memories;
  options.memoryQuery = 'deterministic renderer';
  const result = renderPrompt(options);
  assert.strictEqual(fs.existsSync(marker), false);
  assert.ok(!result.prompt.includes('untrusted-plan-milestone'));
});

test('bounds direct and provider memory injection by memoryMaxTokens', () => {
  const cwd = tempWorkspace('memory-budget');
  const direct = renderPrompt({
    ...baseOptions(cwd, 'execute-task'),
    memories: 'direct-memory '.repeat(100),
    memoryMaxTokens: 12,
  });
  const directBlock = direct.prompt.match(/AUTO-MEMORY"[^\n]*\n([\s\S]*?)\n\[END DATA FROM "AUTO-MEMORY"\]/)[1];
  assert(directBlock.length <= 48, `direct memory chars=${directBlock.length}`);

  const options = baseOptions(cwd, 'execute-task');
  delete options.memories;
  options.memoryMaxTokens = 10;
  options.memoryProvider = () => ({ markdown: 'provider-memory '.repeat(100) });
  const provided = renderPrompt(options);
  const providerBlock = provided.prompt.match(/AUTO-MEMORY"[^\n]*\n([\s\S]*?)\n\[END DATA FROM "AUTO-MEMORY"\]/)[1];
  assert(providerBlock.length <= 40, `provider memory chars=${providerBlock.length}`);
});

test('shares the standards budget across only the sections used by a template', () => {
  const cwd = tempWorkspace('standards-budget');
  const result = renderPrompt({
    ...baseOptions(cwd, 'plan-slice'),
    standards: {
      CS_LINT: 'unused-lint '.repeat(100),
      CS_STRUCTURE: 'structure '.repeat(100),
      CS_RULES: 'rules '.repeat(100),
    },
    standardsMaxTokens: 20,
  });
  const structure = result.prompt.match(/CODING-STANDARDS\.structure"[^\n]*\n([\s\S]*?)\n\[END DATA FROM "CODING-STANDARDS\.structure"\]/)[1];
  const rules = result.prompt.match(/CODING-STANDARDS\.rules"[^\n]*\n([\s\S]*?)\n\[END DATA FROM "CODING-STANDARDS\.rules"\]/)[1];
  assert(structure.length > 0 && rules.length > 0);
  assert(structure.length + rules.length <= 80, `standards chars=${structure.length + rules.length}`);
  assert(!result.prompt.includes('unused-lint'));
});

test('does not load optional memory or standards for templates that do not reference them', () => {
  const cwd = tempWorkspace('unused-context');
  let memoryCalls = 0;
  const missingStandards = path.join(cwd, 'does-not-exist.md');
  const result = renderPrompt({
    ...baseOptions(cwd, 'complete-milestone'),
    memories: undefined,
    memoryProvider: () => {
      memoryCalls += 1;
      throw new Error('unused provider should not run');
    },
    standardsPath: missingStandards,
  });
  assert.strictEqual(memoryCalls, 0);
  assert.ok(result.prompt.includes('Complete GSD milestone M001'));
});

// ── {LEDGER} slot (S02 T01) ───────────────────────────────────────────────────
// The real plan-slice template does not carry {LEDGER} yet (that lands in T02),
// so these cases render against an explicit template dir — the seam is what is
// under test here, not the shipped template text.
function ledgerTemplateDir(cwd, body) {
  const dir = path.join(cwd, 'ledger-templates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan-slice.md'), body);
  return dir;
}

test('renders a direct ledger override into the {LEDGER} slot', () => {
  const cwd = tempWorkspace('ledger-direct');
  const templateDir = ledgerTemplateDir(cwd, 'WORKING_DIR: {WORKING_DIR}\nLEDGER:\n{LEDGER}\n');
  const result = renderPrompt({
    ...baseOptions(cwd, 'plan-slice'),
    templateDir,
    ledger: '## M001\n**Shipped the thing**',
  });
  assert.ok(result.prompt.includes('## M001'));
  assert.ok(result.prompt.includes('**Shipped the thing**'));
  assert.ok(!result.prompt.includes('{LEDGER}'));
});

test('renders a ledger provider envelope and hands it the resolved query', () => {
  const cwd = tempWorkspace('ledger-provider');
  const templateDir = ledgerTemplateDir(cwd, 'WORKING_DIR: {WORKING_DIR}\n{LEDGER}\n');
  let received;
  const result = renderPrompt({
    ...baseOptions(cwd, 'plan-slice'),
    templateDir,
    ledgerProvider: query => {
      received = query;
      return { markdown: '## M042\n**From the provider**' };
    },
  });
  assert.strictEqual(received.unitType, 'plan-slice');
  assert.strictEqual(received.milestoneId, 'M001');
  assert.strictEqual(received.sliceId, 'S01');
  assert.strictEqual(received.cwd, cwd);
  assert.ok(result.prompt.includes('**From the provider**'));
});

test('resolves the ledger budget to the literal default 1500 with no prefs anywhere', () => {
  // B2: prefs-absent is this repo's real state, so the default has to come from
  // validateRenderOptions, not from a skill line a model interpreted.
  const cwd = tempWorkspace('ledger-default-budget');
  const templateDir = ledgerTemplateDir(cwd, 'WORKING_DIR: {WORKING_DIR}\n{LEDGER}\n');
  const home = path.join(cwd, 'empty-home');
  fs.mkdirSync(home, { recursive: true });
  assert.strictEqual(fs.existsSync(path.join(cwd, '.gsd', 'prefs.local.md')), false);
  let seen;
  const options = { ...baseOptions(cwd, 'plan-slice'), templateDir, ledgerProvider: q => { seen = q.maxTokens; return '(none)'; } };
  assert.strictEqual(options.ledgerMaxTokens, undefined, 'no budget is supplied by the caller');
  withIsolatedHome(home, () => renderPrompt(options));
  assert.strictEqual(seen, 1500);
});

test('never calls the ledger provider for a template without {LEDGER}', () => {
  const cwd = tempWorkspace('ledger-unused');
  let calls = 0;
  const result = renderPrompt({
    ...baseOptions(cwd, 'execute-task'),
    ledgerProvider: () => {
      calls += 1;
      throw new Error('unused ledger provider should not run');
    },
  });
  assert.strictEqual(calls, 0);
  assert.ok(!result.prompt.includes('{LEDGER}'));
});

test('renders (none) for an empty ledger and bounds an oversized direct override', () => {
  const cwd = tempWorkspace('ledger-bounds');
  const templateDir = ledgerTemplateDir(cwd, 'WORKING_DIR: {WORKING_DIR}\nA{LEDGER}B\n');
  const empty = renderPrompt({ ...baseOptions(cwd, 'plan-slice'), templateDir, ledger: '   ' });
  assert.ok(empty.prompt.includes('A(none)B'));

  const oversized = renderPrompt({
    ...baseOptions(cwd, 'plan-slice'),
    templateDir,
    ledger: 'ledger-line '.repeat(400),
    ledgerMaxTokens: 20,
  });
  const block = oversized.prompt.match(/\nA([\s\S]*?)B\n/)[1];
  assert.ok(block.length <= 80, `ledger chars=${block.length}`);
  assert.ok(block.includes('[...truncated '), `shared marker family: ${block.slice(-80)}`);
});

test('renders routing domains and workspace repositories through the plan-slice renderer path', () => {
  const cwd = tempWorkspace('routing-positive');
  const home = path.join(cwd, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'api', '.git'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'web', '.git'), { recursive: true });
  // The routing block MUST come from the jsonc layer. A bare legacy
  // `claude-agent-prefs.md` is a deliberate hard-stop after the prefs cutover
  // (`legacy-md-without-jsonc`), which makes readPrefsCached return ok:false and
  // listDomains() return [] — so a .md fixture silently exercises the DEGRADATION
  // path while claiming to be the positive case. See shared/forge-prefs-cutover.md.
  fs.writeFileSync(
    path.join(cwd, '.gsd', 'forge-prefs.jsonc'),
    JSON.stringify({ routing: { alpha: {}, beta: {} } }, null, 2),
  );
  withIsolatedHome(home, () => {
    const result = renderPrompt({ ...baseOptions(cwd, 'plan-slice'), routingDomains: ' ', workspaceRepos: ' ' });
    assert.match(result.prompt, /^ROUTING_DOMAINS: alpha, beta$/m);
    assert.match(result.prompt, /^WORKSPACE_REPOS: (?:api, web|web, api)$/m);
  });
});

test('degrades routing and repository headers to non-empty exported notices', () => {
  const cwd = tempWorkspace('routing-degrade');
  const home = path.join(cwd, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  withIsolatedHome(home, () => {
    const result = renderPrompt(baseOptions(cwd, 'plan-slice'));
    const domains = result.prompt.match(/^ROUTING_DOMAINS: (.*)$/m)[1];
    const repos = result.prompt.match(/^WORKSPACE_REPOS: (.*)$/m)[1];
    assert.strictEqual(domains, NO_DOMAINS_NOTICE);
    assert.strictEqual(repos, SINGLE_REPO_NOTICE);
    for (const value of [domains, repos]) assert.ok(value !== '' && value != null);
  });
});

test('malformed routing prefs degrade instead of throwing or rendering silence', () => {
  const cwd = tempWorkspace('routing-malformed');
  const home = path.join(cwd, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // Malformed in the layer that is actually READ (jsonc), not the legacy .md one.
  // A .md fixture here would degrade for the wrong reason (cutover hard-stop rather
  // than a parse failure), so the assert would pass without ever exercising the
  // malformed-config path it names.
  fs.writeFileSync(path.join(cwd, '.gsd', 'forge-prefs.jsonc'), '{ "routing": { "alpha": ');
  withIsolatedHome(home, () => {
    const result = renderPrompt(baseOptions(cwd, 'plan-slice'));
    assert.strictEqual(result.prompt.match(/^ROUTING_DOMAINS: (.*)$/m)[1], NO_DOMAINS_NOTICE);
  });
});

test('does not resolve workspace repositories for templates without the placeholder', () => {
  const cwd = tempWorkspace('routing-gate');
  const home = path.join(cwd, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  withIsolatedHome(home, () => {
    const poison = 'POISONED-WORKSPACE-REPOS';
    const result = renderPrompt({ ...baseOptions(cwd, 'plan-milestone'), workspaceRepos: poison });
    assert.ok(!result.prompt.includes(poison));
  });
});

test('renders the same prompt body for identical inputs', () => {
  const cwd = tempWorkspace('determinism');
  const options = baseOptions(cwd, 'plan-slice');
  const first = renderPrompt(options);
  const second = renderPrompt(options);
  assert.strictEqual(first.prompt, second.prompt);
  assert.strictEqual(first.template_sha256, second.template_sha256);
  assert.strictEqual(first.input_tokens, second.input_tokens);
});

test('inserts the established isolation header directly after WORKING_DIR', () => {
  const cwd = tempWorkspace('isolation');
  const codeDir = path.join(cwd, 'worktree');
  fs.mkdirSync(codeDir);
  const result = renderPrompt({
    ...baseOptions(cwd, 'execute-task'),
    isolationMode: 'worktree',
    branch: 'forge/M001/S01',
    codeDir,
  });
  const expected = [
    `WORKING_DIR: ${cwd}`,
    'ISOLATION: worktree',
    'BRANCH: forge/M001/S01',
    `CODE_DIR: ${codeDir}`,
  ].join('\n');
  assert.ok(result.prompt.includes(expected));
  assert.throws(
    () => renderPrompt({ ...baseOptions(cwd, 'execute-task'), isolationMode: 'worktree', branch: '../bad\nbranch', codeDir }),
    /Invalid branch/,
  );
});

test('materializes metadata and prompt atomically below .gsd/forge/prompts', () => {
  const cwd = tempWorkspace('materialize');
  const result = materializePrompt({
    ...baseOptions(cwd, 'execute-task'),
    dispatchId: 'dispatch-S01-T01-001',
  });
  const expectedRoot = path.join(cwd, '.gsd', 'forge', 'prompts');
  assert.strictEqual(path.dirname(result.prompt_path), fs.realpathSync(expectedRoot));
  assert.ok(fs.existsSync(result.prompt_path));
  const artifact = fs.readFileSync(result.prompt_path, 'utf8');
  assert.ok(artifact.includes('prompt_id: "dispatch-S01-T01-001"'));
  assert.ok(artifact.includes('dispatch_group_id: "dispatch-S01-T01-001"'));
  assert.ok(artifact.includes('dispatch_id: "dispatch-S01-T01-001"'));
  assert.strictEqual(result.prompt_id, 'dispatch-S01-T01-001');
  assert.strictEqual(result.dispatch_group_id, 'dispatch-S01-T01-001');
  assert.ok(artifact.includes(`input_tokens: ${result.input_tokens}`));
  assert.ok(artifact.includes('Execute GSD task T01'));
  assert.deepStrictEqual(fs.readdirSync(expectedRoot).filter(name => name.endsWith('.tmp')), []);
});

test('refuses to clobber an existing dispatch artifact', () => {
  const cwd = tempWorkspace('no-clobber');
  const options = { ...baseOptions(cwd, 'execute-task'), dispatchId: 'same-dispatch' };
  const first = materializePrompt(options);
  const before = fs.readFileSync(first.prompt_path, 'utf8');
  assert.throws(() => materializePrompt(options), /already exists/);
  assert.strictEqual(fs.readFileSync(first.prompt_path, 'utf8'), before);
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(first.prompt_path)).filter(name => name.endsWith('.tmp')),
    [],
  );
});

test('cleanup removes only the exact safe dispatch artifact', () => {
  const cwd = tempWorkspace('cleanup');
  const one = materializePrompt({ ...baseOptions(cwd, 'plan-check'), dispatchId: 'one' });
  const two = materializePrompt({ ...baseOptions(cwd, 'plan-check'), dispatchId: 'two' });
  assert.strictEqual(cleanupPrompt(cwd, 'one'), true);
  assert.ok(!fs.existsSync(one.prompt_path));
  assert.ok(fs.existsSync(two.prompt_path));
  assert.strictEqual(cleanupPrompt(cwd, 'one'), false);
  assert.throws(() => cleanupPrompt(cwd, '../two'), /dispatch_id/);
});

test('rejects unknown units, malformed IDs, traversal, and unknown placeholders', () => {
  const cwd = tempWorkspace('validation');
  assert.throws(() => renderPrompt({ ...baseOptions(cwd, 'bogus') }), /Unsupported unit type/);
  assert.throws(() => renderPrompt({ ...baseOptions(cwd, 'execute-task'), taskId: '../T01' }), /Invalid task ID/);
  assert.throws(() => materializePrompt({ ...baseOptions(cwd, 'execute-task'), dispatchId: '../escape' }), /dispatch_id/);
  assert.throws(() => renderPrompt({ ...baseOptions(cwd, 'execute-task'), standardsPath: '../outside.md' }), /must stay inside cwd/);

  const templateDir = path.join(cwd, 'bad-templates');
  fs.mkdirSync(templateDir);
  fs.writeFileSync(path.join(templateDir, 'execute-task.md'), 'Bad {UNKNOWN}\n');
  assert.throws(
    () => renderPrompt({ ...baseOptions(cwd, 'execute-task'), templateDir }),
    /Unknown placeholder.*UNKNOWN/,
  );
});

test('CLI accepts selected memories and options as stdin JSON', () => {
  const cwd = tempWorkspace('cli');
  const input = {
    ...baseOptions(cwd, 'research-slice'),
    dispatch_id: 'cli-dispatch',
    memories: '- stdin-selected-memory',
  };
  const run = spawnSync(process.execPath, [SCRIPT, '--stdin-json'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd: __dirname,
  });
  assert.strictEqual(run.status, 0, run.stderr);
  const metadata = JSON.parse(run.stdout);
  assert.strictEqual(metadata.prompt_id, 'cli-dispatch');
  assert.strictEqual(metadata.dispatch_group_id, 'cli-dispatch');
  assert.strictEqual(metadata.dispatch_id, 'cli-dispatch');
  assert.ok(metadata.input_tokens > 0);
  assert.ok(fs.existsSync(metadata.prompt_path));
  const artifact = fs.readFileSync(metadata.prompt_path, 'utf8');
  assert.ok(artifact.includes('stdin-selected-memory'));
  assert.ok(!Object.prototype.hasOwnProperty.call(metadata, 'prompt'));
});

test('CLI rejects unknown options instead of silently drifting', () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--unit-typo', 'execute-task'], {
    encoding: 'utf8',
    cwd: __dirname,
  });
  assert.notStrictEqual(run.status, 0);
  assert.match(run.stderr, /Unknown option: --unit-typo/);
});

// --- Speaking truncation marker -------------------------------------------

const LONG_RULES = 'never swallow errors\n'.repeat(60);

test('emits the full marker with cut count and file § section when the budget is roomy', () => {
  const out = truncateChars(LONG_RULES, 400, {
    source: '.gsd/CODING-STANDARDS.md',
    section: 'Code Rules',
  });
  assert.ok(out.length <= 400, `length=${out.length}`);
  assert.match(out, /\n\n\[\.\.\.truncated \d+ chars — see \.gsd\/CODING-STANDARDS\.md § Code Rules\]$/);
  const cut = Number(out.match(/truncated (\d+) chars/)[1]);
  const content = out.slice(0, out.indexOf('\n\n[...truncated'));
  assert.strictEqual(cut, LONG_RULES.length - content.length);
  assert.ok(cut > 0 && content.length > 0);
});

test('omits the § section when no section is supplied', () => {
  const out = truncateChars(LONG_RULES, 400, { source: '.gsd/memory/' });
  assert.match(out, /\n\n\[\.\.\.truncated \d+ chars — see \.gsd\/memory\/\]$/);
  assert.ok(!out.includes('§'));
});

test('degrades to the short marker when the full marker does not fit', () => {
  const source = '.gsd/CODING-STANDARDS.md';
  const section = 'Directory Conventions + Asset Map + Pattern Catalog';
  const full = `\n\n[...truncated ${LONG_RULES.length} chars — see ${source} § ${section}]`;
  const short = `\n\n[...truncated — see ${source}]`;
  const budget = full.length; // room for the short marker + content, never the full one
  assert.ok(budget > short.length);
  const out = truncateChars(LONG_RULES, budget, { source, section });
  assert.ok(out.length <= budget, `length=${out.length}`);
  assert.strictEqual(out.endsWith(short), true, `got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('§'));
});

test('degrades to the silent ellipsis when not even the short marker fits', () => {
  const out = truncateChars(LONG_RULES, 12, {
    source: '.gsd/CODING-STANDARDS.md',
    section: 'Code Rules',
  });
  assert.ok(out.length <= 12, `length=${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('truncated'));
});

test('never exceeds maxChars across every regime, including degenerate budgets', () => {
  const opts = { source: '.gsd/CODING-STANDARDS.md', section: 'Code Rules' };
  for (const maxChars of [0, 1, 2, 3, 10, 47, 48, 71, 72, 120, 400, 1200]) {
    const bare = truncateChars(LONG_RULES, maxChars);
    const marked = truncateChars(LONG_RULES, maxChars, opts);
    assert.ok(bare.length <= maxChars, `bare maxChars=${maxChars} length=${bare.length}`);
    assert.ok(marked.length <= maxChars, `marked maxChars=${maxChars} length=${marked.length}`);
  }
  assert.strictEqual(truncateChars(LONG_RULES, 0, opts), '');
});

test('adds no marker at all when the text fits the budget', () => {
  const text = 'fits fine\nsecond line';
  const opts = { source: '.gsd/CODING-STANDARDS.md', section: 'Code Rules' };
  assert.strictEqual(truncateChars(text, text.length, opts), text);
  assert.strictEqual(truncateChars(text, 5000, opts), text);
  assert.strictEqual(truncateContext(text, 1000, opts), text);
  assert.strictEqual(truncateChars(LONG_RULES, 400), truncateChars(LONG_RULES, 400, {}));
});

test('keeps the emitted pointer relative to the workspace, never absolute', () => {
  const cwd = tempWorkspace('marker-pointer');
  const result = renderPrompt({
    ...baseOptions(cwd, 'plan-slice'),
    standards: {
      CS_LINT: 'lint '.repeat(200),
      CS_STRUCTURE: 'structure '.repeat(200),
      CS_RULES: 'rules '.repeat(200),
    },
    standardsMaxTokens: 300,
  });
  const markers = result.prompt.match(/\[\.\.\.truncated [^\]]*\]/g) || [];
  assert.ok(markers.length > 0, 'expected at least one truncation marker');
  for (const marker of markers) {
    assert.ok(marker.includes('.gsd/CODING-STANDARDS.md'), marker);
    assert.ok(!/[A-Za-z]:[\\/]/.test(marker), `absolute pointer: ${marker}`);
    assert.ok(!/see \//.test(marker), `absolute pointer: ${marker}`);
    assert.ok(!marker.includes('\\'), `windows separator leaked: ${marker}`);
  }
  // The marker lives inside the DATA envelope it describes, never outside it.
  const rules = result.prompt.match(/CODING-STANDARDS\.rules"[^\n]*\n([\s\S]*?)\n\[END DATA FROM "CODING-STANDARDS\.rules"\]/)[1];
  assert.ok(rules.includes('[...truncated'), rules.slice(-120));
});

test('boundStandards keeps the sum of injected sections inside the token budget', () => {
  const template = 'Lint: {CS_LINT}\nStructure: {CS_STRUCTURE}\nRules: {CS_RULES}\n';
  for (const maxTokens of [3, 12, 20, 64, 300]) {
    const bound = boundStandards({
      CS_LINT: 'lint '.repeat(200),
      CS_STRUCTURE: 'structure '.repeat(200),
      CS_RULES: 'rules '.repeat(200),
    }, maxTokens, template, { standardsPath: '.gsd/CODING-STANDARDS.md' });
    const total = bound.CS_LINT.length + bound.CS_STRUCTURE.length + bound.CS_RULES.length;
    assert.ok(total <= maxTokens * 4, `maxTokens=${maxTokens} chars=${total}`);
  }
  const roomy = boundStandards({
    CS_LINT: 'lint',
    CS_STRUCTURE: 'structure',
    CS_RULES: 'rules '.repeat(400),
  }, 400, template, { standardsPath: 'docs/STANDARDS.md' });
  assert.strictEqual(roomy.CS_LINT, 'lint');
  assert.strictEqual(roomy.CS_STRUCTURE, 'structure');
  assert.match(roomy.CS_RULES, /see docs\/STANDARDS\.md § Code Rules\]$/);
});

test('appends pending context inside the artifact while rejecting paths outside its durable root', () => {
  const cwd = tempWorkspace('pending-context');
  const pendingDir = path.join(cwd, '.gsd', 'forge', 'context', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const pendingFile = path.join(pendingDir, 'scope.json');
  fs.writeFileSync(pendingFile, JSON.stringify({ additional_context: 'Resume after the safe boundary.' }));
  const rendered = renderPrompt({ ...baseOptions(cwd, 'execute-task'), pendingContextFile: pendingFile });
  assert.match(rendered.prompt, /## Pending Context Boundary\n\nResume after the safe boundary\./);
  const outside = path.join(cwd, 'outside.json'); fs.writeFileSync(outside, JSON.stringify({ additional_context: 'no' }));
  assert.throws(() => renderPrompt({ ...baseOptions(cwd, 'execute-task'), pendingContextFile: outside }), /must stay inside/);
});

process.on('exit', () => {
  for (const root of tempRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  if (!process.exitCode) process.stdout.write(`1..${passed}\n`);
});
