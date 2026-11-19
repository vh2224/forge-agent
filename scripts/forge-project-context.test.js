#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const instructions = require('./forge-instructions');
const claude = require('./forge-claude-renderer');
const codex = require('./forge-codex-renderer');
const manifest = require('./forge-source-manifest');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const map = JSON.parse(read('.agents/instructions-map.json'));
function reconstruct(get) {
  const bodies = map.parts.map(part => {
    const raw = get('.agents/' + part.path);
    assert(raw.startsWith(part.prefix), 'historical prefix changed: ' + part.path);
    assert(raw.endsWith(part.suffix));
    const body = raw.slice(part.prefix.length, -part.suffix.length);
    assert.equal(Buffer.byteLength(body), part.body_bytes);
    assert.equal(sha(body), part.body_sha256);
    return body;
  });
  const full = bodies.join('');
  assert.equal(Buffer.byteLength(full), map.source.bytes);
  assert.equal(sha(full), map.source.sha256);
  return full;
}
assert.equal(map.source.sha256, 'c29d739155bb8c660e97d6556e08bbe0a2c4024641a41f0b1cd320e6fbf680db');
assert.equal(map.source.git_commit, '63fc4ebcbd0c33e0bc9f91873bfd4d5ab8b56dc8');
reconstruct(read);
assert.throws(() => reconstruct(file => read(file) + (file === '.agents/' + map.parts[0].path ? 'tamper' : '')));
assert.throws(() => reconstruct(file => file === '.agents/' + map.parts[0].path ? '' : read(file)));
for (const file of ['CLAUDE.md', '.agents/project-policy.md', '.agents/reference/README.md', ...map.parts.map(part => '.agents/' + part.path)]) {
  assert(Buffer.byteLength(read(file)) < 8192, 'context file over 8 KiB: ' + file);
}
assert(read('.agents/project-policy.md').includes('somente ao próprio forge-agent'));
assert(read('.agents/project-policy.md').includes('Esta proibição de .gsd/ não se estende aos consumidores'));
assert(read('.agents/reference/README.md').includes('não substituem contratos atuais'));
const sync = instructions.syncInstructions(repo, { create: false, dryRun: true });
assert.equal(sync.changed, 0, 'canonical sync must be idempotent');
assert(sync.files.every(row => !row.instructionBudgetExceeded));
manifest.audit(manifest.readManifest(repo));
const stage = path.join(repo, 'Temp', 'context-test-virtual');
const options = { repo, projectRoot: path.join(stage, 'project'), forgeHome: path.join(stage, 'forge'), claudeHome: path.join(stage, 'claude'), codexHome: path.join(stage, 'codex') };
const rendered = claude.render(options);
const renderedAgain = claude.render(options);
assert.deepEqual(rendered.artifacts, renderedAgain.artifacts);
const projection = new Map(rendered.artifacts.map(row => [path.resolve(row.destination), row.content]));
function checkLinks(file, get, exists) {
  const text = get(file);
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^(?:https?:|#)/.test(link)) continue;
    const destination = path.resolve(path.dirname(file), link.split('#')[0]);
    assert(exists(destination), 'broken link ' + file + ' -> ' + link);
  }
}
const active = ['CLAUDE.md', '.agents/project-policy.md', '.agents/reference/README.md'];
for (const relative of active) {
  checkLinks(path.join(repo, relative), file => fs.readFileSync(file, 'utf8'), fs.existsSync);
  checkLinks(path.join(options.projectRoot, relative), file => projection.get(path.resolve(file)), file => projection.has(path.resolve(file)));
}
reconstruct(file => claude.stripOriginHeader(projection.get(path.resolve(options.projectRoot, file))));
const successor = require('./fixtures/project-context/distribution.cjs');
successor.validate({ artifacts: rendered.artifacts });
assert.throws(() => successor.validate({ artifacts: rendered.artifacts.filter(row => row.source !== '.agents/project-policy.md') }));
assert.throws(() => successor.validate({ artifacts: [...rendered.artifacts, rendered.artifacts.find(row => row.source === '.agents/project-policy.md')] }));
assert.throws(() => successor.validate({ artifacts: rendered.artifacts.map(row => row.source === '.agents/project-policy.md' ? { ...row, content: row.content + 'tamper' } : row) }));
assert.throws(() => successor.validate({ artifacts: rendered.artifacts, readRaw: file => file === 'scripts/forge-instructions.js' ? Buffer.from('tamper') : fs.readFileSync(path.join(repo, file)) }));
const codexResult = codex.render({ ...options, agentInvocation: 'spawn_agent(', hostRuntime: 'codex' });
const generated = codexResult.artifacts.find(row => path.resolve(row.destination) === path.resolve(options.projectRoot, 'AGENTS.md'));
assert(generated.content.includes('Se existir .agents/project-policy.md'));
assert(Buffer.byteLength(generated.content) < 8192);
assert(!codexResult.artifacts.some(row => row.source.startsWith('.agents/reference/')), 'history is not automatic host context');
console.log('PASS project context: exact preservation, corruption/missing negatives, budgets, idempotence, source/Claude links, portable historical reconstruction and Codex conditional policy');
