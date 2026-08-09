#!/usr/bin/env node
'use strict';

// Static contracts for Claude Code native-runtime integration. These checks
// intentionally avoid a YAML dependency so they also run in a clean install.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const capabilities = require('./forge-capabilities.js');

const root = path.resolve(__dirname, '..');
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function frontmatter(content, fileName) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert(match, `${fileName} must start with YAML frontmatter`);

  const fields = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
}

function csvField(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const agentDir = path.join(root, 'agents');
const agentFiles = fs.readdirSync(agentDir)
  .filter((name) => /^forge-.*\.md$/.test(name))
  .sort();

test('every Forge agent has a bounded positive integer maxTurns', () => {
  assert(agentFiles.length > 0, 'expected at least one agents/forge-*.md file');

  for (const fileName of agentFiles) {
    const fields = frontmatter(read(path.join('agents', fileName)), fileName);
    assert.match(
      fields.maxTurns || '',
      /^[1-9]\d*$/,
      `${fileName} maxTurns must be a positive integer`,
    );

    const maxTurns = Number(fields.maxTurns);
    assert(
      maxTurns >= 4 && maxTurns <= 100,
      `${fileName} maxTurns=${maxTurns} is outside the reasonable 4..100 bound`,
    );
  }
});

test('forge-memory uses low effort and a short turn budget', () => {
  const fields = frontmatter(read(path.join('agents', 'forge-memory.md')), 'forge-memory.md');
  assert.strictEqual(fields.effort, 'low');
  assert(Number(fields.maxTurns) <= 24, 'forge-memory should stay cheaper than implementation agents');
});

// M018 measured six lost advocate defenses. Two independent defects produced
// them and each gets its own assert, because fixing one without the other
// still loses work:
//   (a) the turn budget (16) could not cover a per-objection investigation —
//       3N+2 turns for N objections, and N reached 13 in that milestone;
//   (b) the SubagentStop repair message told a cut-off agent to emit "only"
//       the structured block, so the per-objection verdicts were stripped and
//       the orchestrator received a bare scoreboard.
test('forge-advocate can survive a truncated final message', () => {
  const fields = frontmatter(read(path.join('agents', 'forge-advocate.md')), 'forge-advocate.md');

  const maxTurns = Number(fields.maxTurns);
  assert(
    maxTurns >= 41,
    `forge-advocate maxTurns=${maxTurns} cannot cover the largest measured load ` +
    '(13 objections x 3 turns + 2 = 41); its cost scales with the objection count',
  );

  assert(
    csvField(fields.tools).includes('Write'),
    'forge-advocate needs Write to persist verdicts to DEFENSE_FILE as it forms them',
  );

  const advocate = read(path.join('agents', 'forge-advocate.md'));
  assert.match(advocate, /DEFENSE_FILE/, 'forge-advocate must document the DEFENSE_FILE crash rail');
  assert.match(
    advocate,
    /only permitted write target|only write target|other than `DEFENSE_FILE`/i,
    'Write must be scoped to DEFENSE_FILE in prose — the advocate never edits code',
  );
});

test('the SubagentStop repair asks for the complete answer, not only the result block', () => {
  const hook = read(path.join('scripts', 'forge-hook.js'));
  const reason = hook.match(/Forge contract missing for \$\{agentType\}\.`,([\s\S]*?)\]\.join\(' '\)/);
  assert(reason, 'forge-hook.js must build the repair reason as a literal array');

  assert.match(
    reason[1],
    /COMPLETE final answer/,
    'the repair must ask for the complete answer, including inline deliverables',
  );
  assert(
    !/only inspect your current result and emit the missing structured block/.test(reason[1]),
    'the "only ... the missing structured block" wording strips inline deliverables (M018: six lost defenses)',
  );
});

test('the review spec and its mirrors all carry the DEFENSE_FILE contract', () => {
  const review = read(path.join('shared', 'forge-review.md'));
  assert.match(review, /DEFENSE_FILE: \{DEFENSE_FILE\}/, 'Step 3 must pass DEFENSE_FILE in the advocate prompt');
  assert.match(review, /Salvage before declaring unavailability/i, 'Step 3 must define the salvage order');

  // The consumers enumerate the gate rather than inheriting it (measured in
  // M018/S06), so each one has to carry the rule itself or it drifts.
  for (const skill of ['forge-auto', 'forge-next', 'forge-task']) {
    const fileName = path.join('skills', skill, 'SKILL.md');
    assert.match(read(fileName), /DEFENSE_FILE/, `${fileName} must mirror the DEFENSE_FILE contract`);
  }
});

test('orchestrator skills allow native SendMessage continuation', () => {
  for (const skill of ['forge-auto', 'forge-next', 'forge-task']) {
    const fileName = path.join('skills', skill, 'SKILL.md');
    const fields = frontmatter(read(fileName), fileName);
    assert(
      csvField(fields['allowed-tools']).includes('SendMessage'),
      `${fileName} allowed-tools must include SendMessage`,
    );
  }
});

test('dialectic review reuses the reviewer and keeps a compatibility fallback', () => {
  const review = read(path.join('shared', 'forge-review.md'));
  assert.match(review, /REVIEWER_AGENT_ID/);
  assert.match(review, /SendMessage\s*\(\s*\{[\s\S]*?to:\s*REVIEWER_AGENT_ID/);
  assert.match(review, /Compatibility fallback/i);
  assert.match(review, /review-resume-fallback/);
  assert.match(review, /legacy fresh dispatch/i);
  assert.match(review, /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1/);
  assert.match(review, /Forge never enables that experimental\s+flag itself/i);
});

test('SubagentStop repairs result-producing agents but excludes forge-memory', () => {
  const hook = read(path.join('scripts', 'forge-hook.js'));
  const setMatch = hook.match(/const RESULT_BLOCK_AGENTS\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  assert(setMatch, 'forge-hook.js must declare RESULT_BLOCK_AGENTS as a literal Set');

  const members = new Set(
    Array.from(setMatch[1].matchAll(/['"](forge-[a-z-]+)['"]/g), (match) => match[1]),
  );

  assert(!members.has('forge-memory'), 'command-only forge-memory must not be blocked');
  assert(members.has('forge-executor'), 'forge-executor must be protected by the result contract');
  assert(members.has('forge-worker'), 'forge-worker must be protected by the result contract');
  assert(members.has('forge-completer'), 'forge-completer must be protected by the result contract');
});

test('native Claude contracts remain represented in the capability catalog', () => {
  const result = capabilities.audit(root);
  assert.deepStrictEqual(result.issues, [], 'capability catalog must audit cleanly');
  const byId = new Map(result.catalog.capabilities.map((entry) => [entry.capability_id, entry]));
  for (const id of ['operational-hooks', 'operational-headless', 'operational-mcp']) {
    const entry = byId.get(id);
    assert(entry, `${id} must remain cataloged`);
    assert.strictEqual(entry.hosts.claude, 'implemented', `${id} must retain current Claude availability`);
    assert.strictEqual(entry.hosts.codex, 'planned', `${id} must not claim a Codex implementation early`);
  }
  for (const agent of agentFiles) {
    const id = `agent-${path.basename(agent, '.md')}`;
    assert(byId.has(id), `${agent} must remain represented by the catalog`);
  }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
