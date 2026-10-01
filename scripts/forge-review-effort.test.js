#!/usr/bin/env node
'use strict';

// Acceptance for the opt-in review-leg effort helper. Prefs are injected, the
// agent definitions are temporary files and nothing is launched: the helper
// only plans, so `effort_sent` must stay null in every case.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveReviewEffort } = require('./forge-review-effort.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error.message}\n`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-effort-'));
function agent(name, lines) {
  const file = path.join(TMP, `${name}.md`);
  const source = ['---', `name: ${name}`, ...lines, '---', '', 'body', ''].join('\n');
  fs.writeFileSync(file, source);
  return { agentType: name, agentPath: file, sourceFingerprint: `sha256:${crypto.createHash('sha256').update(source).digest('hex')}` };
}
const CLAUDE_CAPS = { available: true, tool: 'Agent', source: 'fixture-observed',
  model_aliases: ['haiku', 'sonnet', 'opus', 'fable'], effort_transports: ['agent-frontmatter'] };
const CODEX_CAPS = { available: true, tool: 'spawn_agent', source: 'fixture-observed',
  models: ['gpt-6.1-sol'], reasoning_efforts: ['low', 'medium', 'high'], fork_turns: ['none'] };
const prefs = review => ({ review });

test('absent keys: legacy call, no argv, nothing planned or sent', () => {
  for (const leg of ['challenge', 'defense', 'rebuttal']) {
    const out = resolveReviewEffort({ leg, engine: 'codex', transport: 'app-server', model: 'gpt-6.1-sol', prefs: prefs({ trigger: 'adaptive' }) });
    assert.deepStrictEqual([out.configured, out.argv, out.effort_planned, out.effort_sent, out.refusal], [false, [], null, null, null], leg);
  }
});

test('external legs: --effort after the policy; applied and sent stay null', () => {
  const codex = resolveReviewEffort({ leg: 'challenge', engine: 'codex', transport: 'app-server', model: 'gpt-6.1-sol',
    prefs: prefs({ challenge_effort: 'high' }) });
  assert.deepStrictEqual(codex.argv, ['--effort', 'high']);
  assert.deepStrictEqual([codex.effort_planned, codex.effort_sent, codex.effort_applied], ['high', null, null]);
  const sonnet5 = resolveReviewEffort({ leg: 'defense', engine: 'claude', transport: 'claude-cli', model: 'claude-sonnet-5',
    prefs: prefs({ defense_effort: 'max' }) });
  assert.deepStrictEqual(sonnet5.argv, ['--effort', 'max'], 'documented sonnet 5 is not clamped');
  const sonnet55 = resolveReviewEffort({ leg: 'defense', engine: 'claude', transport: 'claude-cli', model: 'claude-sonnet-5-5',
    prefs: prefs({ defense_effort: 'xhigh' }) });
  assert.deepStrictEqual(sonnet55.argv, ['--effort', 'xhigh']);
  const haiku = resolveReviewEffort({ leg: 'rebuttal', engine: 'claude', transport: 'claude-cli', model: 'claude-haiku-4-5-20251001',
    prefs: prefs({ rebuttal_effort: 'high' }) });
  assert.deepStrictEqual(haiku.argv, ['--effort', 'medium'], 'legacy clamp');
  assert.ok(haiku.diagnostics.some(d => d.code === 'effort-clamped-by-policy'));
  const s46 = resolveReviewEffort({ leg: 'challenge', engine: 'claude', transport: 'claude-cli', model: 'claude-sonnet-4-6',
    prefs: prefs({ challenge_effort: 'xhigh' }) });
  assert.strictEqual(s46.refusal.code, 'effort-unsupported-by-model');
  assert.deepStrictEqual(s46.argv, []);
});

test('agy: explicit effort refused as not deliverable; invalid values refused visibly', () => {
  const agy = resolveReviewEffort({ leg: 'challenge', engine: 'agy', transport: 'agy-cli', prefs: prefs({ challenge_effort: 'high' }) });
  assert.strictEqual(agy.refusal.code, 'effort-transport-unsupported');
  assert.strictEqual(agy.effort_sent, null);
  const invalid = resolveReviewEffort({ leg: 'challenge', engine: 'codex', transport: 'app-server', prefs: prefs({ challenge_effort: 'ultra' }) });
  assert.strictEqual(invalid.refusal.code, 'review-effort-invalid');
});

test('native Claude legs: binding equal plans agent-frontmatter; different refuses; no default capabilities', () => {
  const advocate = agent('forge-advocate', ['model: sonnet', 'effort: medium']);
  const equal = resolveReviewEffort({ leg: 'defense', engine: 'claude', transport: 'claude-native', model: 'claude-sonnet-5',
    binding: advocate, capabilities: CLAUDE_CAPS, prefs: prefs({ defense_effort: 'medium' }) });
  assert.strictEqual(equal.refusal, null, JSON.stringify(equal));
  assert.strictEqual(equal.effort_planned, 'agent-frontmatter:medium');
  assert.strictEqual(equal.effort_sent, null, 'planned is never reported as sent');
  const mismatch = resolveReviewEffort({ leg: 'rebuttal', engine: 'claude', transport: 'claude-native', model: 'claude-sonnet-5',
    binding: advocate, capabilities: CLAUDE_CAPS, prefs: prefs({ rebuttal_effort: 'high' }) });
  assert.strictEqual(mismatch.refusal.code, 'native-effort-binding-mismatch', 'resumed rebuttal uses the same binding');
  assert.match(mismatch.refusal.hint, /forge-advocate/);
  assert.match(mismatch.refusal.hint, /effort medium/);
  const noCaps = resolveReviewEffort({ leg: 'defense', engine: 'claude', transport: 'claude-native', model: 'claude-sonnet-5',
    binding: advocate, prefs: prefs({ defense_effort: 'medium' }) });
  assert.strictEqual(noCaps.refusal.code, 'native-capabilities-missing', 'no fictitious tool is assumed');
});

test('native Claude leg: an inert frontmatter thinking declaration is a diagnostic, not a refusal', () => {
  const reviewer = agent('forge-reviewer', ['model: claude-sonnet-5', 'thinking: disabled', 'effort: medium']);
  const planned = resolveReviewEffort({ leg: 'challenge', engine: 'claude', transport: 'claude-native', model: 'claude-sonnet-5-5',
    binding: reviewer, capabilities: CLAUDE_CAPS, prefs: prefs({ challenge_effort: 'medium' }) });
  assert.strictEqual(planned.refusal, null, JSON.stringify(planned));
  assert.strictEqual(planned.effort_planned, 'agent-frontmatter:medium');
  assert.strictEqual(planned.model_version_proof, 'alias-only');
  assert(planned.diagnostics.some(d => d.code === 'native-thinking-declaration-inert'), JSON.stringify(planned.diagnostics));
});

test('native Codex host: reasoning_effort checked against observed capabilities', () => {
  const ok = resolveReviewEffort({ leg: 'challenge', engine: 'codex', transport: 'codex-native', model: 'gpt-6.1-sol',
    agentType: 'forge-reviewer', capabilities: CODEX_CAPS, prefs: prefs({ challenge_effort: 'high' }) });
  assert.deepStrictEqual(ok.native_args, { reasoning_effort: 'high' });
  const unsupported = resolveReviewEffort({ leg: 'challenge', engine: 'codex', transport: 'codex-native', model: 'gpt-6.1-sol',
    agentType: 'forge-reviewer', capabilities: CODEX_CAPS, prefs: prefs({ challenge_effort: 'max' }) });
  assert.strictEqual(unsupported.refusal.code, 'native-effort-unsupported');
});

test('native Claude review legs validate operator thinking with and without opt-in effort', () => {
  const reviewer = agent('forge-reviewer-thinking', ['model: sonnet', 'thinking: disabled', 'effort: high']);
  const original = fs.readFileSync(reviewer.agentPath);
  for (const leg of ['challenge', 'defense', 'rebuttal']) {
    for (const configured of [true, false]) {
      const review = configured ? { [`${leg}_effort`]: 'high' } : {};
      for (const [mode, code] of [['disabled', 'thinking-disabled-incompatible'],
        ['enabled', 'thinking-enabled-incompatible'], ['between_tools', 'thinking-transport-unsupported'],
        ['adaptive', null], [undefined, null]]) {
        const out = resolveReviewEffort({ leg, engine: 'claude', transport: 'claude-native',
          model: 'claude-sonnet-5-5', binding: reviewer, capabilities: CLAUDE_CAPS,
          prefs: { review, ...(mode === undefined ? {} : { thinking: { sonnet_phases: mode } }) } });
        assert.strictEqual(out.refusal && out.refusal.code, code, `${leg}/${configured}/${mode}`);
        assert.deepStrictEqual(out.argv, []);
        assert.strictEqual(out.effort_sent, null);
        assert.strictEqual(out.effort_planned, !code && configured ? 'agent-frontmatter:high' : null);
        if (code) assert(out.diagnostics.some(d => d.code === code && d.layer === 'model-policy'));
        if (!configured) assert.strictEqual(out.configured, false, 'thinking never opts in to effort delivery');
      }
    }
  }
  assert.deepStrictEqual(fs.readFileSync(reviewer.agentPath), original, 'the agent binding is never rewritten');
  const legacy = resolveReviewEffort({ leg: 'challenge', engine: 'claude', transport: 'claude-native',
    model: 'claude-sonnet-5-5', prefs: { review: {}, thinking: { sonnet_phases: 'adaptive' } } });
  assert.strictEqual(legacy.refusal, null, 'absent effort does not introduce a binding/capability preflight');
  assert.deepStrictEqual([legacy.argv, legacy.effort_planned], [[], null]);
});

test('adaptive review decision, rounds, ask_in_auto and fix_conceded are identical with and without the keys', () => {
  const costPolicy = require('./forge-cost-policy.js');
  const entries = costPolicy.parseNumstat('12\t3\tsrc/a.js\n480\t20\tsrc/b.js\n');
  const keys = { challenge_effort: 'high', defense_effort: 'xhigh', rebuttal_effort: 'max' };
  for (const review of [{ trigger: 'adaptive' }, { trigger: 'always', rounds: 2, ask_in_auto: 'gate', fix_conceded: false },
    { mode: 'disabled' }, {}]) {
    for (const risk of ['normal', 'high']) {
      const without = costPolicy.decideReview({ review, entries, risk });
      const withKeys = costPolicy.decideReview({ review: { ...review, ...keys }, entries, risk });
      assert.deepStrictEqual(withKeys, without, JSON.stringify(review));
    }
    assert.deepStrictEqual(costPolicy.normalizeReviewConfig({ ...review, ...keys }), costPolicy.normalizeReviewConfig(review));
  }
});

test('invalid present value is never silently dropped by the helper (refusal, no argv)', () => {
  for (const value of ['ultra', 'HIGHEST', '', 7]) {
    const out = resolveReviewEffort({ leg: 'rebuttal', engine: 'claude', transport: 'claude-cli', model: 'claude-sonnet-5',
      prefs: prefs({ rebuttal_effort: value }) });
    assert.strictEqual(out.refusal.code, 'review-effort-invalid', JSON.stringify(value));
    assert.deepStrictEqual(out.argv, []);
    assert.strictEqual(out.configured, true);
  }
});

// Exercise the real public callers and capture the transport's turn/start parameters.
async function testCallers() {
  const { spawnSync } = require('child_process');
  const client = require('./forge-appserver-client');
  const original = client.startAppServerTurn;
  const previousHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(TMP, 'isolated-home');
  let payload;
  const captures = [];
  client.startAppServerTurn = async options => {
    captures.push({ thread: options.threadParams, turn: options.turnParams('fixture-thread') });
    return { items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(payload) }], notifications: [] };
  };
  const xllm = require('./forge-xllm');
  const legs = [['challenge', 'runChallenge', { objections: [] }, 'high'],
    ['defense', 'runDefend', { verdicts: [] }, 'xhigh'], ['rebuttal', 'runRebuttal', { verdicts: [] }, 'max']];
  let sequence = 0;
  function fixture(review, extra = {}) {
    const cwd = path.join(TMP, `caller-${++sequence}`);
    fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.gsd/forge-prefs.jsonc'), JSON.stringify({ review, ...extra }));
    const init = spawnSync('git', ['init', '-q'], { cwd, windowsHide: true });
    assert.strictEqual(init.status, 0);
    const inputFile = path.join(cwd, 'input.json');
    fs.writeFileSync(inputFile, '{"objections":[],"defenses":[]}');
    return { cwd, inputFile, diffCmd: 'git diff', engine: 'codex', model: 'gpt-6.1-sol',
      hostRuntime: 'claude', sidecarDeclared: true };
  }
  try {
    for (const [leg, method, output, preference] of legs) {
      payload = output;
      const key = `${leg}_effort`;
      for (const [label, review, explicit, expected] of [
        ['preference', { [key]: preference }, undefined, preference],
        ['absent', {}, undefined, undefined],
        ['override', { [key]: 'invalid' }, 'medium', 'medium'],
      ]) {
        const options = fixture(review);
        if (explicit !== undefined) options.effort = explicit;
        await xllm[method](options);
        const capture = captures.at(-1);
        assert.strictEqual(capture.turn.model, options.model);
        assert.strictEqual(capture.turn.effort, expected, `${leg}/${label}`);
      }
      // Worktree execution reads review preferences from the artifact owner.
      const owner = fixture({ [key]: preference });
      const worktree = fixture({ [key]: 'ultra' });
      const ownerAnnouncements = [];
      await xllm[method]({ ...worktree, contextRoot: owner.cwd,
        announce: (stage, fields) => ownerAnnouncements.push({ stage, ...fields }) });
      assert.strictEqual(captures.at(-1).turn.effort, preference, `${leg}/owner prefs`);
      const requested = ownerAnnouncements.find(item => item.stage === 'solicitado');
      assert.strictEqual(requested.effort_planned, preference);
      assert.strictEqual(requested.effort_sent, null, 'planned effort is not sent before launch');
      const legacyAnnouncements = [];
      await xllm[method]({ ...fixture({}), announce: (stage, fields) => legacyAnnouncements.push({ stage, ...fields }) });
      assert(!legacyAnnouncements.some(item => Object.hasOwn(item, 'effort_planned')), 'absence retains legacy announcement shape');
      async function refused(options, code, layer, effortRequested) {
        const announcements = [];
        await assert.rejects(() => xllm[method]({ ...options,
          announce: (stage, fields) => announcements.push({ stage, ...fields }) }), error => {
          assert.strictEqual(error.code, code);
          assert.strictEqual(error.provider_called, false);
          return true;
        });
        assert.strictEqual(announcements.length, 1);
        assert.strictEqual(announcements[0].stage, 'recusado');
        assert.strictEqual(announcements[0].reason_code, code);
        assert.strictEqual(announcements[0].layer, layer);
        assert.strictEqual(announcements[0].provider_called, false);
        assert.strictEqual(announcements[0].model_sent, '-');
        assert.strictEqual(announcements[0].model_route, options.model);
        if (effortRequested !== undefined) assert.strictEqual(announcements[0].effort_requested, effortRequested);
      }
      const before = captures.length;
      await refused(fixture({ [key]: 'ultra' }), 'review-effort-invalid', 'review-effort', 'ultra');
      const invalidOwner = fixture({ [key]: 'ultra' });
      const cliWorktree = fixture({});
      const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-xllm.js'),
        '--mode', leg === 'defense' ? 'defend' : leg, '--engine', 'codex', '--host-runtime', 'claude',
        '--sidecar-declared', '--cwd', cliWorktree.cwd, '--context-root', invalidOwner.cwd,
        '--model', 'gpt-6.1-sol', '--diff-cmd', 'git diff', '--input', cliWorktree.inputFile],
      { encoding: 'utf8', windowsHide: true });
      assert.strictEqual(cli.status, 2);
      assert.match(cli.stderr, /review-effort-invalid/);
      assert.match(cli.stderr, /recusado/);

      await assert.rejects(() => xllm[method]({ ...fixture({}), effort: 'ultra' }), { code: 'review-effort-invalid' });
      await assert.rejects(() => xllm[method]({ ...fixture({ [key]: 'high' }), engine: 'agy' }), { code: 'effort-transport-unsupported' });
      const badPrefs = fixture({});
      fs.writeFileSync(path.join(badPrefs.cwd, '.gsd/forge-prefs.jsonc'), '{broken');
      await refused(badPrefs, 'review-prefs-invalid', 'review-prefs');
      for (const thinking of ['disabled', 'between_tools']) {
        await refused({ ...fixture({ [key]: 'high' }, { thinking: { sonnet_phases: thinking } }),
          engine: 'claude', model: 'claude-sonnet-5-5', hostRuntime: 'codex' },
          thinking === 'disabled' ? 'thinking-disabled-incompatible' : 'thinking-transport-unsupported', 'model-policy', 'high');
      }
      assert.strictEqual(captures.length, before, 'all refusals happen before transport');
    }
    passed += 1;
    process.stdout.write('  PASS real challenge/defend/rebuttal consumers: turn params, absent, override and pre-transport refusals\n');
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL real public callers\n${error.stack}\n`);
  } finally {
    client.startAppServerTurn = original;
    if (previousHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = previousHome;
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  process.stdout.write(`\nforge-review-effort: ${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}
testCallers();
