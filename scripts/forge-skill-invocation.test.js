'use strict';

// Source/distribution contract only: this never invokes a host Skill tool or a model.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const renderer = require('./forge-claude-renderer');

const repo = path.resolve(__dirname, '..');
const expectedRestricted = [
  'forge-config', 'forge-curate', 'forge-doctor', 'forge-mcps',
  'forge-pause', 'forge-prefs', 'forge-probe',
].sort();
function frontmatter(content) {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  assert(match, 'Skill frontmatter must remain first');
  return match[1];
}
function restricted(content) {
  const declarations = [...frontmatter(content).matchAll(/^disable-model-invocation:\s*(.*?)\s*$/gm)];
  assert(declarations.length <= 1, 'Duplicate invocation key');
  if (!declarations.length) return false;
  assert(['true', 'false'].includes(declarations[0][1]), 'Invocation key must be a boolean');
  return declarations[0][1] === 'true';
}
const skills = fs.readdirSync(path.join(repo, 'skills')).filter(name =>
  fs.existsSync(path.join(repo, 'skills', name, 'SKILL.md'))).sort();
const source = new Map(skills.map(name => [name,
  fs.readFileSync(path.join(repo, 'skills', name, 'SKILL.md'), 'utf8')]));
assert.deepEqual(skills.filter(name => restricted(source.get(name))), expectedRestricted,
  'Change the documented invocation inventory deliberately; keep read/preparation/step entries callable');

const rendered = renderer.render({ repo, projectRoot: repo,
  claudeHome: path.join(os.tmpdir(), 'forge-skill-invocation-claude'),
  forgeHome: path.join(os.tmpdir(), 'forge-skill-invocation-core') });
const projected = new Map();
for (const artifact of rendered.artifacts) {
  const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(artifact.source);
  if (match) { assert(!projected.has(match[1]), 'Duplicate rendered skill'); projected.set(match[1], artifact.content); }
}
assert.deepEqual([...projected.keys()].sort(), skills, 'Every canonical skill must be distributed');
for (const name of skills) assert.equal(frontmatter(projected.get(name)), frontmatter(source.get(name)),
  'Claude projection changed invocation metadata: ' + name);
assert.deepEqual(skills.filter(name => restricted(projected.get(name))), expectedRestricted);

const next = projected.get('forge-next');
assert(next.includes('## Invocation policy'));
assert(next.includes('Execute exatamente uma unidade e pare'));
assert(next.includes('não encadeie chamadas, não abra auto-loop'));
assert(next.includes('plan/security gates, isolamento, claims, routing, revisão e checkpoints'));
console.log('PASS skill invocation: exact seven-entry restriction inventory and all Claude frontmatters preserved; forge-next distributes one-unit policy (no host UI or execution claim)');
