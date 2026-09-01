#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const generation = require('./forge-generate');
const claudeRenderer = require('./forge-claude-renderer');
const root = path.resolve(__dirname, '..'); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-generation-Ω-'));

function dispatchSourceDefinition(sourceId, input, planned = false) {
  const source = {
    source_id: sourceId,
    owner: 'fixture',
    inputs: [input],
    render_targets: [{ path: input, recursive: true }],
    capability: `fixture-${sourceId}`,
    security_role: 'internal',
    newline: 'lf',
    origin_header: 'fixture',
    common: { format: 'markdown' },
  };
  if (planned) source.conditional = { claude: { status: 'planned' }, codex: { status: 'planned' } };
  return source;
}

function dispatchRepository(directory) {
  const source = [
    '---',
    'name: forge-auto',
    'description: fixture dispatch skill',
    '---',
    '',
    'Outside Agent({ untouched: true }) and --host-runtime claude.',
    '<!-- forge:dispatch:start -->',
    "Agent({ subagent_type: 'forge-executor', prompt: 'fixture' })",
    'node forge-worker.js --host-runtime claude --mode execute',
    '<!-- forge:dispatch:end -->',
    'After Agent({ untouched: true }) and --host-runtime claude.',
    '',
  ].join('\n');
  const skill = path.join(directory, 'skills', 'forge-auto', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, source, 'utf8');
  const manifest = {
    schema_version: '1.0.0',
    sources: [
      dispatchSourceDefinition('agents', 'agents', true),
      dispatchSourceDefinition('commands', 'commands', true),
      dispatchSourceDefinition('skills', 'skills'),
      dispatchSourceDefinition('dispatch-templates', 'shared/templates/dispatch', true),
    ],
  };
  fs.writeFileSync(path.join(directory, 'forge-source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { source, manifest };
}

function runCli(script, args) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}
try {
  const project = path.join(temp, 'project Ω'); const claudeHome = path.join(temp, 'Claude Home Ω'); const codexHome = path.join(temp, 'Codex Home Ω'); const forgeHome = path.join(temp, 'Forge Home Ω'); fs.mkdirSync(project, { recursive: true });
  const dry = generation.generate({ repo: root, runtime: 'both', projectRoot: project, claudeHome, codexHome, forgeHome, dryRun: true }); assert.deepStrictEqual(dry.selected, ['claude', 'codex']); assert.strictEqual(fs.existsSync(claudeHome), false); assert.strictEqual(fs.existsSync(codexHome), false); assert.strictEqual(fs.existsSync(forgeHome), false);
  const first = generation.generate({ repo: root, runtime: 'both', projectRoot: project, claudeHome, codexHome, forgeHome }); assert.strictEqual(first.changed, true); assert(fs.existsSync(path.join(project, 'CLAUDE.md'))); assert(fs.existsSync(path.join(project, 'AGENTS.md'))); assert(fs.existsSync(path.join(claudeHome, 'agents', 'forge-executor.md'))); assert(fs.existsSync(path.join(codexHome, 'agents', 'forge-executor.toml')));
  const second = generation.generate({ repo: root, runtime: 'both', projectRoot: project, claudeHome, codexHome, forgeHome }); assert.strictEqual(second.changed, false); assert(second.reports.claude.preserved.length > 0); assert(second.reports.codex.preserved.length > 0);
  const sentinel = path.join(claudeHome, 'operator.txt'); fs.writeFileSync(sentinel, 'keep\r\n'); generation.generate({ repo: root, runtime: 'codex', projectRoot: project, claudeHome, codexHome, forgeHome }); assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep\r\n');
  assert.strictEqual(fs.existsSync(path.join(temp, '.claude')), false); assert.strictEqual(fs.existsSync(path.join(temp, '.codex')), false);
  // Exercise path/home resolution for all supported hosts even when the
  // release gate itself runs on only one operating system.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const matrixRoot = path.join(temp, `matrix-${platform}`);
    const matrixProject = path.join(matrixRoot, 'project with spaces Ω');
    const matrixClaude = path.join(matrixRoot, 'Claude Home');
    const matrixCodex = path.join(matrixRoot, 'Codex Home');
    const matrixForge = path.join(matrixRoot, 'Forge Home');
    fs.mkdirSync(matrixProject, { recursive: true });
    const matrix = generation.generate({ repo: root, runtime: 'both', platform, projectRoot: matrixProject, claudeHome: matrixClaude, codexHome: matrixCodex, forgeHome: matrixForge });
    assert.strictEqual(matrix.changed, true, `${platform} first run changed`);
    assert(fs.existsSync(path.join(matrixProject, 'CLAUDE.md')));
    assert(fs.existsSync(path.join(matrixProject, 'AGENTS.md')));
    assert(fs.existsSync(path.join(matrixClaude, 'agents', 'forge-executor.md')));
    assert(fs.existsSync(path.join(matrixCodex, 'agents', 'forge-executor.toml')));
    const repeatMatrix = generation.generate({ repo: root, runtime: 'both', platform, projectRoot: matrixProject, claudeHome: matrixClaude, codexHome: matrixCodex, forgeHome: matrixForge });
    assert.strictEqual(repeatMatrix.changed, false, `${platform} second run idempotent`);
    const inferredHome = path.join(matrixRoot, 'inferred user home');
    const inferred = generation.generate({ repo: root, runtime: 'both', platform, userHome: inferredHome, env: {}, projectRoot: path.join(matrixRoot, 'inferred project') });
    assert(inferred.reports.claude.claude_home.endsWith(`${path.sep}.claude`));
    assert(inferred.reports.codex.codex_home.endsWith(`${path.sep}.codex`));
    assert.strictEqual(fs.existsSync(path.join(matrixRoot, '.claude')), false);
    assert.strictEqual(fs.existsSync(path.join(matrixRoot, '.codex')), false);
  }

  // Both public production callers must understand a real canonical dispatch
  // fence without reconstructing the Agent form at the call site. The fixture
  // uses the real skills/forge-auto/SKILL.md projection path so this is also the
  // end-to-end link between source inventory and the Codex renderer transform.
  const fixtureRepo = path.join(temp, 'dispatch repository');
  const dispatchFixture = dispatchRepository(fixtureRepo);
  const generatedProject = path.join(temp, 'generated project');
  const generatedClaude = path.join(temp, 'generated Claude');
  const generatedCodex = path.join(temp, 'generated Codex');
  const generatedForge = path.join(temp, 'generated Forge');
  const generated = runCli('forge-generate.js', [
    '--runtime', 'both',
    '--repo', fixtureRepo,
    '--project-root', generatedProject,
    '--claude-home', generatedClaude,
    '--codex-home', generatedCodex,
    '--forge-home', generatedForge,
    '--json',
  ]);
  assert.strictEqual(generated.status, 0, generated.stderr);
  const generatedReport = JSON.parse(generated.stdout);
  assert.deepStrictEqual(generatedReport.selected, ['claude', 'codex']);
  const generatedCodexSkill = fs.readFileSync(path.join(generatedCodex, 'skills', 'forge-auto', 'SKILL.md'), 'utf8');
  assert(generatedCodexSkill.includes("spawn_agent({ subagent_type: 'forge-executor'"));
  assert(generatedCodexSkill.includes('node forge-worker.js --host-runtime codex --mode execute'));
  assert(generatedCodexSkill.includes('Outside Agent({ untouched: true }) and --host-runtime claude.'));
  assert(generatedCodexSkill.includes('After Agent({ untouched: true }) and --host-runtime claude.'));

  // Claude gets the historical origin wrapper and otherwise the canonical bytes,
  // including both dispatch marker comments and all Claude spellings.
  const generatedClaudeSkill = fs.readFileSync(path.join(generatedClaude, 'skills', 'forge-auto', 'SKILL.md'), 'utf8');
  const skillDefinition = dispatchFixture.manifest.sources.find((source) => source.source_id === 'skills');
  const expectedClaudeSkill = claudeRenderer.addOriginHeader(
    dispatchFixture.source,
    skillDefinition,
    'skills/forge-auto/SKILL.md',
  );
  assert.strictEqual(generatedClaudeSkill, expectedClaudeSkill);
  assert(generatedClaudeSkill.includes('<!-- forge:dispatch:start -->'));
  assert(generatedClaudeSkill.includes('<!-- forge:dispatch:end -->'));

  const standaloneProject = path.join(temp, 'standalone project');
  const standaloneCodex = path.join(temp, 'standalone Codex');
  const standaloneForge = path.join(temp, 'standalone Forge');
  const standalone = runCli('forge-codex-renderer.js', [
    '--repo', fixtureRepo,
    '--project-root', standaloneProject,
    '--codex-home', standaloneCodex,
    '--forge-home', standaloneForge,
    '--json',
  ]);
  assert.strictEqual(standalone.status, 0, standalone.stderr);
  const standaloneReport = JSON.parse(standalone.stdout);
  assert.strictEqual(standaloneReport.runtime, 'codex');
  const standaloneSkill = fs.readFileSync(path.join(standaloneCodex, 'skills', 'forge-auto', 'SKILL.md'), 'utf8');
  assert(standaloneSkill.includes("spawn_agent({ subagent_type: 'forge-executor'"));
  assert(standaloneSkill.includes('node forge-worker.js --host-runtime codex --mode execute'));
  console.log('forge-generation tests passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
