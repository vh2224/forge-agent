#!/usr/bin/env node
'use strict';

// Standalone parity matrix for forge-dispatch-resolve.  This deliberately has
// no test-framework dependency: it is useful before the installer runs too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveDispatch, degradedContract, TIER_DEFAULTS } = require('./forge-dispatch-resolve.js');
if (TIER_DEFAULTS['review-fix'] !== 'standard' || 'review-advocate' in TIER_DEFAULTS || 'review-challenger' in TIER_DEFAULTS) throw new Error('review-fix routing defaults invalid');
if (resolveDispatch({ unitType: 'review-fix', cwd: process.cwd() }).effort !== 'medium') throw new Error('review-fix effort invalid');
const { readTierChain } = require('./forge-tier-chain.js');

const SCRIPT = path.join(__dirname, 'forge-dispatch-resolve.js');
const KEEP = process.argv.includes('--keep');
let passes = 0;
let fails = 0;
const fixtures = [];

function pass(name) {
  passes += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function fail(name, detail) {
  fails += 1;
  process.stdout.write(`  ✗ ${name}\n    ${detail || 'assertion failed'}\n`);
}

function assert(condition, name, detail) {
  if (condition) pass(name);
  else fail(name, detail);
}

function assertEqual(actual, expected, name) {
  assert(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function mkFixture(input) {
  const spec = input || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-resolve-'));
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  if (spec.prefs) fs.writeFileSync(path.join(dir, '.gsd', 'claude-agent-prefs.md'), spec.prefs, 'utf8');
  if (spec.prefsJsonc !== undefined) fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), spec.prefsJsonc, 'utf8');
  let planPath = null;
  if (spec.plan) {
    planPath = path.join(dir, 'T01-PLAN.md');
    fs.writeFileSync(planPath, spec.plan, 'utf8');
  }
  let roadmapPath = null;
  if (spec.roadmap) {
    roadmapPath = path.join(dir, 'M001-ROADMAP.md');
    fs.writeFileSync(roadmapPath, spec.roadmap, 'utf8');
  }
  const fixture = { dir, planPath, roadmapPath };
  fixtures.push(fixture);
  return fixture;
}

function cleanup(fixture) {
  if (KEEP) {
    process.stdout.write(`  (kept ${fixture.dir})\n`);
    return;
  }
  try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch {}
}

// Avoid a developer's real global preferences changing the legacy fixtures.
function withHermeticHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-home-'));
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn({ ...process.env, HOME: home, USERPROFILE: home });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
    if (!KEEP) fs.rmSync(home, { recursive: true, force: true });
  }
}

function dispatch(fixture, options) {
  return resolveDispatch({ cwd: fixture.dir, planPath: fixture.planPath, roadmapPath: fixture.roadmapPath, ...options });
}

function runCase(name, fn) {
  process.stdout.write(`\n[case] ${name}\n`);
  try { fn(); } catch (error) { fail(`${name} did not throw`, error.stack || error.message); }
}

withHermeticHome((cliEnv) => {
  runCase('execute-task defaults: legacy standard chain and low effort', () => {
    const f = mkFixture({});
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.tier, 'standard', 'defaults tier standard');
    assertEqual(r.route_source, 'tier_models', 'defaults use legacy tier_models');
    assertEqual(r.model, 'claude-sonnet-5', 'defaults primary is canonical sonnet');
    assertEqual(r.effort, 'low', 'defaults effort low');
    assertEqual(r.effort_reason, 'unit-type:execute-task', 'defaults effort reason');
    assertEqual(r.engine, 'claude', 'defaults engine claude');
    assertEqual(r.sidecar_model, '', 'claude route has empty sidecar model');
    assertEqual(r.host_runtime, 'claude', 'legacy omission keeps Claude host compatibility');
    assertEqual(r.worker_engine, 'native', 'legacy omission keeps native worker target');
    assertEqual(r.worker_mode, 'native', 'legacy omission keeps native worker mode');
    assertEqual(r.resolved_worker_engine, 'claude', 'legacy native worker resolves to Claude host');
    assertEqual(r.dispatch_allowed, true, 'legacy contract remains dispatchable');
    cleanup(f);
  });

  runCase('execute-task frontmatter tier heavy and effort high', () => {
    const f = mkFixture({ plan: '---\ntier: heavy\neffort: high\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.tier, 'heavy', 'frontmatter tier override');
    assertEqual(r.reason, 'frontmatter-override:heavy', 'frontmatter tier reason');
    assertEqual(r.effort, 'high', 'opus allows high effort');
    assertEqual(r.effort_reason, 'frontmatter-effort:high', 'frontmatter effort reason');
    cleanup(f);
  });

  runCase('execute-task xhigh effort is clamped by sonnet', () => {
    const f = mkFixture({ plan: '---\neffort: xhigh\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.model, 'claude-sonnet-5', 'clamp fixture resolves sonnet');
    assertEqual(r.effort, 'medium', 'xhigh effort clamps to medium');
    assert(/frontmatter-effort:xhigh\|clamped:model-cap/.test(r.effort_reason), 'clamp reason is recorded', r.effort_reason);
    cleanup(f);
  });

  runCase('execute-task docs tag selects light tier', () => {
    const f = mkFixture({ plan: '---\ntag: docs\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.tier, 'light', 'docs tier light');
    assertEqual(r.reason, 'frontmatter-tag:docs', 'docs reason');
    cleanup(f);
  });

  runCase('plan-slice high-risk roadmap escalates to max', () => {
    const f = mkFixture({ roadmap: '- id: S01 risk: high domain:backend\n' });
    const r = dispatch(f, { unitType: 'plan-slice', unitId: 'S01' });
    assertEqual(r.tier, 'max', 'risk high tier max');
    assertEqual(r.reason, 'risk-escalation:high', 'risk escalation reason');
    assertEqual(r.effort, 'max', 'risk escalation effort max');
    assertEqual(r.effort_reason, 'risk-escalation:high', 'risk escalation effort reason');
    cleanup(f);
  });

  runCase('plan-slice without high risk retains heavy default', () => {
    const f = mkFixture({ roadmap: '- id: S01 risk: medium domain:backend\n' });
    const r = dispatch(f, { unitType: 'plan-slice', unitId: 'S01' });
    assertEqual(r.tier, 'heavy', 'normal plan-slice tier heavy');
    assert(r.reason !== 'risk-escalation:high', 'normal plan-slice has no escalation', r.reason);
    cleanup(f);
  });

  runCase('exposes raw resolver inputs (domain_input, frontmatter_tier) for retry re-resolution', () => {
    // execute-task with frontmatter domain + tier → raw inputs replayed verbatim.
    const withInputs = mkFixture({ plan: '---\ntier: heavy\ndomain: backend\n---\n# task\n' });
    const r1 = dispatch(withInputs, { unitType: 'execute-task', planPath: withInputs.planPath });
    assertEqual(r1.domain_input, 'backend', 'domain_input reflects raw frontmatter domain');
    assertEqual(r1.frontmatter_tier, 'heavy', 'frontmatter_tier reflects raw frontmatter tier');
    cleanup(withInputs);
    // Absent frontmatter → domain_input falls back to default, frontmatter_tier empty.
    const bare = mkFixture({ plan: '---\n---\n# task\n' });
    const r2 = dispatch(bare, { unitType: 'execute-task', planPath: bare.planPath });
    assertEqual(r2.domain_input, 'default', 'domain_input default when absent');
    assertEqual(r2.frontmatter_tier, '', 'frontmatter_tier empty when absent');
    cleanup(bare);
  });

  runCase('plan-milestone is non-routable max and uses tier_models', () => {
    const f = mkFixture({ prefsJsonc: '{"routing":{"default":{"planner":{"max":"gpt-5-codex"}}}}' });
    const r = dispatch(f, { unitType: 'plan-milestone' });
    assertEqual(r.tier, 'max', 'plan-milestone tier max');
    assertEqual(r.route_source, 'tier_models', 'plan-milestone is never captured by routing');
    cleanup(f);
  });

  runCase('routing backend executor selects capped routing chain', () => {
    const f = mkFixture({
      prefsJsonc: '{"routing":{"backend":{"executor":{"standard":["gpt-5-codex","claude-sonnet-5","claude-opus-4-8","claude-haiku-4-5-20251001"]}}}}',
      plan: '---\ndomain: backend\n---\n# task\n',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'routing', 'routing block is selected');
    assertEqual(r.domain, 'backend', 'routing domain backend');
    assertEqual(r.engine, r.chain[0].engine, 'routing engine comes from primary chain member');
    assertEqual(r.chain_len, 3, 'routing chain respects cap three');
    assertEqual(r.sidecar_model, r.chain[0].id, 'codex routing chain leads sidecar model');
    cleanup(f);
  });

  runCase('degraded contract keeps the additive sidecar_model key', () => {
    const r = degradedContract(['--unit-type', 'execute-task']);
    assert('sidecar_model' in r, 'degraded contract exposes sidecar_model');
    assertEqual(r.sidecar_model, '', 'degraded contract sidecar model is empty');
  });

  runCase('routing falls back to default domain for absent domain cell', () => {
    const f = mkFixture({
      prefsJsonc: '{"routing":{"default":{"executor":{"standard":["claude-opus-4-8"]}}}}',
      plan: '---\ndomain: nonexistent\n---\n# task\n',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'routing', 'default routing remains routing source');
    assertEqual(r.domain, 'default', 'missing domain uses routing.default');
    assertEqual(r.model, 'claude-opus-4-8', 'default cell model selected');
    cleanup(f);
  });

  runCase('legacy workers compatibility retains tier_models model', () => {
    const f = mkFixture({ prefsJsonc: '{"workers":{"execute-task":"codex","codex_model":"gpt-fixture"},"tier_models":{"standard":"claude-opus-4-8"}}' });
    const r = dispatch(f, { unitType: 'execute-task' });
    const canonical = readTierChain('standard', f.dir)[0];
    assertEqual(r.route_source, 'tier_models', 'legacy compatibility source');
    assertEqual(r.engine, 'codex', 'workers execute-task controls legacy engine');
    assertEqual(r.engine_reason, 'workers.execute-task:codex', 'legacy worker reason');
    assertEqual(r.codex_model, 'gpt-fixture', 'legacy codex model is included');
    assertEqual(r.model, canonical.id, 'legacy resolver model equals canonical tier chain');
    assertEqual(r.alias, canonical.alias, 'legacy resolver alias equals canonical tier chain');
    assertEqual(r.effort, 'low', 'legacy resolver effort is expected default');
    cleanup(f);
  });

  runCase('frontmatter worker pins model family over routing (source=frontmatter)', () => {
    // Canonical semantics (skills/forge-auto/SKILL.md § "Engine decision by route_source"
    // + forge-routing.js Precedence 1a): a frontmatter `worker:` PINS a model and wins the
    // SOURCE label (frontmatter > routing), but the ENGINE is the pinned model's FAMILY —
    // engine = chain[0].engine — NOT a literal "codex". `codex` is a gpt-family model, so the
    // canonical engine here is `gpt`. The literal `engine == codex` only arises on the
    // tier_models legacy path via the prefs `workers:` block (covered by the case above).
    const f = mkFixture({
      prefsJsonc: '{"routing":{"backend":{"executor":{"standard":"claude-opus-4-8"}}}}',
      plan: '---\nworker: codex\ndomain: backend\n---\n# task\n',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'frontmatter', 'frontmatter worker wins source over routing');
    assertEqual(r.engine, r.chain[0].engine, 'engine is the pinned model family (chain[0].engine)');
    assertEqual(r.engine, 'gpt', 'codex pin resolves to gpt family, not literal codex');
    assert(/frontmatter-worker|route:frontmatter/.test(r.engine_reason), 'frontmatter worker reason is coherent', r.engine_reason);
    cleanup(f);
  });

  runCase('unknown alias is safely omitted from applied model', () => {
    const f = mkFixture({ prefsJsonc: '{"tier_models":{"standard":"gpt-5-codex"}}' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.alias, null, 'unknown model alias is null');
    assertEqual(r.model_applied, null, 'unknown model has no applied alias');
    cleanup(f);
  });

  runCase('fable model enables adaptive thinking header', () => {
    const f = mkFixture({ prefsJsonc: '{"tier_models":{"standard":"claude-fable-5"}}' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.thinking_header, 'adaptive', 'fable thinking header adaptive');
    cleanup(f);
  });

  runCase('opus-5 at xhigh/max effort forces adaptive thinking header', () => {
    // claude-opus-5 rejects thinking: disabled when effort is xhigh/max (HTTP
    // 400); at high or below the pref is honored (empty header, no override).
    const f = mkFixture({ plan: '---\ntier: heavy\neffort: xhigh\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.model, 'claude-opus-5', 'heavy tier default is opus-5');
    assertEqual(r.effort, 'xhigh', 'opus-5 allows xhigh effort');
    assertEqual(r.thinking_header, 'adaptive', 'opus-5 xhigh thinking header adaptive');
    cleanup(f);
  });

  runCase('opus-5 at high effort or below honors the thinking pref', () => {
    const f = mkFixture({ plan: '---\ntier: heavy\neffort: high\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.model, 'claude-opus-5', 'heavy tier default is opus-5');
    assertEqual(r.thinking_header, '', 'opus-5 high effort emits no override');
    cleanup(f);
  });

  runCase('worker: Codex (capitalized) normalizes identically to lowercase codex', () => {
    // Fix 2 (M012 S01 review-fix): canonical lowercases the frontmatter worker
    // value. Capitalized `Codex` must resolve identically to lowercase `codex`.
    const prefsJsonc = '{"routing":{"backend":{"executor":{"standard":"claude-opus-4-8"}}}}';
    const domain = 'domain: backend\n';
    const lower = mkFixture({ prefsJsonc, plan: `---\nworker: codex\n${domain}---\n# task\n` });
    const upper = mkFixture({ prefsJsonc, plan: `---\nworker: Codex\n${domain}---\n# task\n` });
    const rl = dispatch(lower, { unitType: 'execute-task' });
    const ru = dispatch(upper, { unitType: 'execute-task' });
    assertEqual(ru.plan_worker, 'codex', 'capitalized worker is lowercased');
    assertEqual(ru.route_source, rl.route_source, 'capitalized worker keeps same route source');
    assertEqual(ru.engine, rl.engine, 'capitalized worker resolves same engine as lowercase');
    assertEqual(ru.engine, 'gpt', 'codex pin resolves to gpt family');
    cleanup(lower);
    cleanup(upper);
  });

  runCase('workers: {execute-task: Codex} (capitalized) normalizes to codex engine', () => {
    const f = mkFixture({ prefsJsonc: '{"workers":{"execute-task":"Codex","codex_model":"gpt-fixture"},"tier_models":{"standard":"claude-opus-4-8"}}' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'tier_models', 'capitalized workers pref stays legacy source');
    assertEqual(r.engine, 'codex', 'capitalized workers pref lowercases to codex engine');
    assertEqual(r.engine_reason, 'workers.execute-task:codex', 'capitalized workers reason is lowercased');
    cleanup(f);
  });

  runCase('malformed prefs jsonc surfaces loud-stop (prefs_ok false, CLI exit 1)', () => {
    // Fix 1 (M012 S01 review-fix): a broken prefs layer must not silently
    // degrade — prefs_ok:false and the CLI exits non-zero (M008-CONTEXT #2).
    const f = mkFixture({ prefsJsonc: '{ "workers": { "execute-task": "codex" ' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.prefs_ok, false, 'malformed prefs sets prefs_ok false');
    assert(Array.isArray(r.prefs_errors) && r.prefs_errors.length > 0, 'malformed prefs records errors', JSON.stringify(r.prefs_errors));
    const cli = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--cwd', f.dir], { encoding: 'utf8', env: cliEnv });
    let parsed = null;
    try { parsed = JSON.parse(cli.stdout); } catch (error) { fail('loud-stop CLI stdout is valid JSON', error.message); }
    assertEqual(cli.status, 1, 'CLI exits 1 on prefs loud-stop');
    assert(parsed && parsed.prefs_ok === false, 'CLI still prints the contract with prefs_ok false', cli.stdout);
    cleanup(f);
  });

  runCase('valid prefs keep prefs_ok true and CLI exit 0', () => {
    const f = mkFixture({ prefsJsonc: '{"workers":{"execute-task":"codex"}}' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.prefs_ok, true, 'valid prefs keep prefs_ok true');
    assertEqual(r.prefs_errors.length, 0, 'valid prefs have no errors');
    const cli = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--cwd', f.dir], { encoding: 'utf8', env: cliEnv });
    assertEqual(cli.status, 0, 'CLI exits 0 on valid prefs');
    cleanup(f);
  });

  // Regression: parseArgs always seeds effortMap `{}`, and `{}` is truthy — a
  // ternary made prefs.effort unreachable from the CLI, which is the only path
  // forge-auto/forge-next/forge-task use. The whole `effort` prefs block was inert.
  runCase('prefs.effort is honoured through the CLI, and --effort- overrides it', () => {
    const f = mkFixture({ prefsJsonc: '{"effort":{"execute-task":"medium","plan-slice":"high"}}' });

    // In-process, no effortMap at all: the pref wins over EFFORT_DEFAULTS ('low').
    assertEqual(dispatch(f, { unitType: 'execute-task' }).effort, 'medium', 'pref beats EFFORT_DEFAULTS in-process');

    // The CLI seeds effortMap {} with no --effort- flag; the pref must still win.
    const bare = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--cwd', f.dir], { encoding: 'utf8', env: cliEnv });
    let parsed = null;
    try { parsed = JSON.parse(bare.stdout); } catch (error) { fail('bare CLI stdout is valid JSON', error.message); }
    assertEqual(bare.status, 0, 'bare CLI exits 0');
    assert(parsed && parsed.effort === 'medium', 'bare CLI honours prefs.effort', bare.stdout);

    // An explicit flag still overrides the pref (its documented role).
    const flagged = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--effort-execute-task', 'low', '--cwd', f.dir], { encoding: 'utf8', env: cliEnv });
    let over = null;
    try { over = JSON.parse(flagged.stdout); } catch (error) { fail('flagged CLI stdout is valid JSON', error.message); }
    assert(over && over.effort === 'low', '--effort- flag overrides prefs.effort', flagged.stdout);

    // Merge, not replace: a flag for one unit must not erase the pref for another.
    assertEqual(dispatch(f, { unitType: 'plan-slice', effortMap: { 'execute-task': 'low' } }).effort, 'high', 'unrelated flag leaves other prefs intact');

    // A unit absent from both prefs and flags still falls back to EFFORT_DEFAULTS.
    assertEqual(dispatch(f, { unitType: 'complete-slice' }).effort, 'low', 'unset unit still uses EFFORT_DEFAULTS');
    cleanup(f);
  });

  // ── Family-only `worker:` must NOT leak into the model slot ───────────────
  // Measured (M018/S02/T01): `worker: claude` produced model 'claude' /
  // alias null, so the orchestrator omitted `model:` from Agent() and the
  // worker silently ran on its agent-frontmatter default instead of the
  // tier's model — and the effort clamp (keyed on `claude-(haiku|sonnet)`)
  // never matched the bare token, so a `standard` task could be dispatched
  // at `high` effort (HTTP 400 on Sonnet). A family token pins the ENGINE;
  // the MODEL still comes from the tier.
  runCase('family-only worker: claude keeps tier resolution (heavy → opus)', () => {
    const f = mkFixture({ plan: '---\nworker: claude\ntier: heavy\neffort: high\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.engine, 'claude', 'engine still pinned to claude by the frontmatter worker');
    assertEqual(r.route_source, 'frontmatter', 'frontmatter still wins the source label');
    assertEqual(r.model, 'claude-opus-5', 'model comes from tier heavy, not from the token');
    assertEqual(r.alias, 'opus', 'alias is mapped — Agent() gets a real model:');
    assertEqual(r.model_applied, 'opus', 'model_applied is the mapped alias');
    assertEqual(r.effort, 'high', 'heavy tier keeps high effort');
    assert(r.chain.length === 1 && r.chain[0].id === 'claude-opus-5',
      'chain carries the tier model, not the family token', JSON.stringify(r.chain));
    cleanup(f);
  });

  runCase('family-only worker: claude on a standard task clamps effort (the HTTP-400 hazard)', () => {
    const f = mkFixture({ plan: '---\nworker: claude\neffort: high\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.model, 'claude-sonnet-5', 'standard tier model, not the token');
    assertEqual(r.alias, 'sonnet', 'alias mapped');
    assertEqual(r.effort, 'medium', 'effort clamped down by the sonnet cap');
    assertEqual(r.effort_reason, 'frontmatter-effort:high|clamped:model-cap', 'clamp is recorded, never silent');
    cleanup(f);
  });

  runCase('family worker: codex filters the routed chain to the gpt member', () => {
    const f = mkFixture({
      plan: '---\nworker: codex\nslice: S01\n---\n# task\n',
      prefsJsonc: '{"routing":{"default":{"executor":{"standard":["claude-sonnet-5","gpt-5.6-luna"]}}}}',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.engine, 'gpt', 'engine pinned to the gpt family');
    assertEqual(r.dispatch_engine, 'codex', 'dispatch trigger normalizes to codex');
    assertEqual(r.model, 'gpt-5.6-luna', 'chain filtered to the routed gpt member, not the token');
    assertEqual(r.sidecar_model, 'gpt-5.6-luna', 'sidecar gets the real routed model');
    cleanup(f);
  });

  runCase('family worker: claude filters a mixed routed chain to the claude member', () => {
    const f = mkFixture({
      plan: '---\nworker: claude\nslice: S01\n---\n# task\n',
      prefsJsonc: '{"routing":{"default":{"executor":{"standard":["gpt-5.6-luna","claude-sonnet-5"]}}}}',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.engine, 'claude', 'engine claude');
    assertEqual(r.dispatch_engine, 'claude', 'no sidecar dispatch');
    assertEqual(r.model, 'claude-sonnet-5', 'gpt head skipped, claude member selected');
    assertEqual(r.alias, 'sonnet', 'alias mapped');
    cleanup(f);
  });

  runCase('unmatchable family pin degrades to the literal token, never to an empty chain', () => {
    // No routing block → the legacy tier chain is all-claude, so a codex pin
    // has nothing to select. Behavior is byte-identical to the pre-fix path
    // (literal token chain) and the degradation is named in `reason`.
    const f = mkFixture({ plan: '---\nworker: codex\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.engine, 'gpt', 'engine still gpt');
    assertEqual(r.dispatch_engine, 'codex', 'still routes to the sidecar');
    assertEqual(r.chain_len, 1, 'exactly one member — never an empty chain');
    assertEqual(r.model, 'codex', 'degrades to the literal token as before the fix');
    cleanup(f);
  });

  runCase('a CONCRETE worker id still short-circuits tier resolution (precedence unchanged)', () => {
    const { resolveRoute } = require('./forge-routing.js');
    const f = mkFixture({});
    const r = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'default', frontmatterWorker: 'gpt-5.6-terra', cwd: f.dir });
    assertEqual(r.source, 'frontmatter', 'source frontmatter');
    assertEqual(r.chain.length, 1, 'single pinned member');
    assertEqual(r.chain[0].id, 'gpt-5.6-terra', 'the concrete id IS the chain — tier never consulted');
    assert(/\bfrontmatter-worker\b/.test(r.reason) && !/frontmatter-worker-family/.test(r.reason),
      'concrete id keeps the frontmatter-worker discriminator, not the family one', r.reason);
    cleanup(f);
  });

  // Two modules parse `domain:` out of the same frontmatter: this resolver and
  // scripts/forge-must-haves.js. Neither stripped a YAML inline comment, so they
  // agreed on a value no routing cell can match (`payments  # cross-repo`), and
  // the unit silently fell to `default`. The bite has to be two-sided: the value
  // must be stripped (behaviour), AND the two readers must return the same thing
  // (parity) — fixing one reader alone turns a shared wrong answer into a
  // divergence, which is the failure this pair exists to prevent.
  runCase('domain strips an inline comment, and both readers agree', () => {
    const { parseMustHaves } = require('./forge-must-haves.js');
    const plan = [
      '---',
      'id: T01',
      'domain: payments  # cross-repo, see CONTEXT',
      'must_haves:',
      '  truths:',
      '    - it routes',
      '  artifacts: []',
      '  key_links: []',
      'expected_output: [a.js]',
      '---',
      '',
      '# T01',
      '',
    ].join('\n');
    const f = mkFixture({ plan });
    const resolved = dispatch(f, { unitType: 'execute-task' }).domain_input;
    const gate = parseMustHaves(fs.readFileSync(f.planPath, 'utf8')).domain;
    assertEqual(resolved, 'payments', 'resolver strips the inline comment from domain');
    assertEqual(gate, 'payments', 'the must-haves gate strips the inline comment from domain');
    assertEqual(resolved, gate, 'both readers of `domain:` return the identical value');

    // A `#` with no whitespace before it is part of the value, not a comment —
    // the discriminator the shared helper is built on. Asserted so a future
    // "simplification" to /#.*$/ cannot pass.
    const hashPlan = plan.replace('domain: payments  # cross-repo, see CONTEXT', 'domain: pay#1');
    const g = mkFixture({ plan: hashPlan });
    assertEqual(dispatch(g, { unitType: 'execute-task' }).domain_input, 'pay#1', 'a `#` inside the value survives in the resolver');
    assertEqual(parseMustHaves(fs.readFileSync(g.planPath, 'utf8')).domain, 'pay#1', 'a `#` inside the value survives at the gate');
    cleanup(g);
    cleanup(f);
  });

  runCase('CLI matches in-process resolver and degrades on missing plan', () => {
    const f = mkFixture({});
    const expected = dispatch(f, { unitType: 'execute-task', planPath: path.join(f.dir, 'missing-PLAN.md') });
    const cli = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--plan', path.join(f.dir, 'missing-PLAN.md'), '--cwd', f.dir], { encoding: 'utf8', env: cliEnv });
    let parsed = null;
    try { parsed = JSON.parse(cli.stdout); } catch (error) { fail('CLI stdout is valid JSON', error.message); }
    assertEqual(cli.status, 0, 'CLI exits zero for missing plan');
    assert(parsed !== null, 'CLI emits a JSON contract', cli.stdout);
    if (parsed) {
      assertEqual(parsed.tier, expected.tier, 'CLI and library tier agree');
      assertEqual(parsed.model, expected.model, 'CLI and library model agree');
      assertEqual(parsed.effort, expected.effort, 'CLI and library effort agree');
      assertEqual(parsed.route_source, expected.route_source, 'CLI and library route source agree');
      assertEqual(Object.keys(parsed).slice(0, 11).join(','), 'engine,model,alias,tier,domain,route_source,chain,chain_len,reason,effort,effort_reason', 'CLI contract keys are ordered');
    }
    cleanup(f);
  });

  runCase('host_runtime is an additive input and does not reinterpret legacy routing fields', () => {
    const f = mkFixture({ prefsJsonc: '{"tier_models":{"standard":"claude-opus-4-8"}}' });
    const legacy = dispatch(f, { unitType: 'execute-task' });
    const codexHost = dispatch(f, { unitType: 'execute-task', host_runtime: 'codex' });
    for (const key of ['engine', 'model', 'alias', 'tier', 'domain', 'route_source', 'chain', 'chain_len', 'reason', 'effort', 'effort_reason', 'dispatch_engine']) {
      assertEqual(JSON.stringify(codexHost[key]), JSON.stringify(legacy[key]), `host input preserves legacy ${key}`);
    }
    assertEqual(codexHost.host_runtime, 'codex', 'explicit snake_case host is emitted');
    assertEqual(codexHost.worker_engine, 'native', 'worker engine remains native when omitted');
    assertEqual(codexHost.resolved_worker_engine, 'codex', 'native resolves to explicit Codex host');
    cleanup(f);
  });

  runCase('CLI accepts --host-runtime and retains the ordered legacy prefix', () => {
    const f = mkFixture({});
    const cli = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--host-runtime', 'codex', '--cwd', f.dir], { encoding: 'utf8', env: cliEnv });
    let parsed = null;
    try { parsed = JSON.parse(cli.stdout); } catch (error) { fail('host-runtime CLI stdout is valid JSON', error.message); }
    assertEqual(cli.status, 0, 'host-runtime CLI exits zero');
    assert(parsed && parsed.host_runtime === 'codex', 'host-runtime CLI exposes Codex host', cli.stdout);
    assert(parsed && parsed.resolved_worker_engine === 'codex', 'host-runtime CLI resolves native to Codex', cli.stdout);
    assertEqual(Object.keys(parsed || {}).slice(0, 11).join(','), 'engine,model,alias,tier,domain,route_source,chain,chain_len,reason,effort,effort_reason', 'host-runtime preserves ordered legacy prefix');
    cleanup(f);
  });

  runCase('native target never falls back to a routed model family', () => {
    const f = mkFixture({ prefsJsonc: '{"routing":{"default":{"executor":{"standard":"claude-opus-4-8"}}}}' });
    const r = dispatch(f, { unitType: 'execute-task', hostRuntime: 'codex', workerEngine: 'native' });
    assertEqual(r.engine, 'claude', 'route still classifies the Claude model family');
    assertEqual(r.resolved_worker_engine, 'codex', 'native target remains the Codex host');
    assertEqual(r.dispatch_allowed, true, 'native host target is allowed');
    cleanup(f);
  });

  runCase('routed Codex sidecar is refused on a Codex host until explicitly declared', () => {
    const f = mkFixture({ prefsJsonc: '{"routing":{"default":{"executor":{"standard":["gpt-5-codex"]}}}}' });
    const implicit = dispatch(f, { unitType: 'execute-task', hostRuntime: 'codex' });
    assertEqual(implicit.dispatch_engine, 'codex', 'routing still exposes the legacy Codex dispatch trigger');
    assertEqual(implicit.dispatch_allowed, false, 'effective routed same-host sidecar is refused');
    assertEqual(implicit.dispatch_reason_code, 'implicit-recursion-refused', 'routed recursion uses stable reason code');
    const declared = dispatch(f, { unitType: 'execute-task', hostRuntime: 'codex', sidecarDeclared: true });
    assertEqual(declared.dispatch_allowed, true, 'declared routed same-host sidecar remains allowed');
    assertEqual(declared.worker_mode, 'sidecar', 'routed Codex dispatch projects sidecar mode');
    cleanup(f);
  });

  runCase('explicit worker axes are never rewritten by the routed model family', () => {
    const f = mkFixture({ prefsJsonc: '{"routing":{"default":{"executor":{"standard":["gpt-5-codex"]}}}}' });
    const crossHost = dispatch(f, {
      unitType: 'execute-task', hostRuntime: 'codex', workerEngine: 'claude', workerMode: 'sidecar', sidecarDeclared: true,
    });
    assertEqual(crossHost.worker_engine, 'claude', 'explicit Claude worker survives Codex routing');
    assertEqual(crossHost.worker_mode, 'sidecar', 'explicit sidecar mode survives Codex routing');
    assertEqual(crossHost.resolved_worker_engine, 'claude', 'explicit worker target is resolved without family fallback');
    assertEqual(crossHost.dispatch_allowed, true, 'declared cross-engine sidecar remains representable');

    const mismatch = dispatch(f, {
      unitType: 'execute-task', hostRuntime: 'codex', workerEngine: 'claude', workerMode: 'native',
    });
    assertEqual(mismatch.worker_engine, 'claude', 'native mismatch preserves requested worker');
    assertEqual(mismatch.dispatch_allowed, false, 'native cross-host mismatch is refused');
    assertEqual(mismatch.dispatch_reason_code, 'native-engine-host-mismatch', 'native mismatch reason is stable');
    cleanup(f);
  });

  runCase('runtime decision is stable for CRLF and Unicode/space paths on each supported platform', () => {
    const f = mkFixture({});
    const portableDir = path.join(f.dir, 'unicode espaço – runtime');
    fs.mkdirSync(portableDir, { recursive: true });
    const planPath = path.join(portableDir, 'T01 – PLAN.md');
    fs.writeFileSync(planPath, '---\r\ntier: standard\r\nworker: Codex\r\n---\r\n# task\r\n', 'utf8');
    const results = ['win32', 'darwin', 'linux'].map((platform) => resolveDispatch({
      cwd: portableDir,
      planPath,
      unitType: 'execute-task',
      hostRuntime: 'codex',
      workerEngine: 'native',
      platform,
    }));
    for (const [index, result] of results.entries()) {
      assertEqual(result.host_runtime, 'codex', `platform ${['win32', 'darwin', 'linux'][index]} keeps host`);
      assertEqual(result.resolved_worker_engine, 'codex', `platform ${['win32', 'darwin', 'linux'][index]} resolves native`);
      assertEqual(result.dispatch_allowed, true, `platform ${['win32', 'darwin', 'linux'][index]} allows dispatch`);
    }
    assertEqual(JSON.stringify(results[0]), JSON.stringify(results[1]), 'Windows/macOS decisions are identical');
    assertEqual(JSON.stringify(results[1]), JSON.stringify(results[2]), 'macOS/Linux decisions are identical');
    cleanup(f);
  });

  runCase('implicit Codex-to-Codex sidecar is refused before dispatch', () => {
    const f = mkFixture({});
    const r = dispatch(f, {
      unitType: 'execute-task', hostRuntime: 'codex', workerEngine: 'codex', workerMode: 'sidecar',
    });
    assertEqual(r.dispatch_allowed, false, 'implicit same-host sidecar is refused');
    assertEqual(r.dispatch_reason_code, 'implicit-recursion-refused', 'recursion refusal uses stable reason code');
    assertEqual(r.worker_reason_code, 'implicit-recursion-refused', 'worker diagnostic matches dispatch refusal');
    cleanup(f);
  });

  runCase('explicitly declared same-host sidecar remains representable', () => {
    const f = mkFixture({});
    const r = dispatch(f, {
      unitType: 'execute-task', hostRuntime: 'codex', workerEngine: 'codex', workerMode: 'sidecar', sidecarDeclared: true,
    });
    assertEqual(r.dispatch_allowed, true, 'declared same-host sidecar is allowed by the contract');
    assertEqual(r.sidecar_declared, true, 'declaration is emitted');
    assertEqual(r.resolved_worker_engine, 'codex', 'declared sidecar keeps its Codex target');
    assertEqual(r.worker_reason_code, 'sidecar-declared', 'declared sidecar reason is stable');
    cleanup(f);
  });

  runCase('cross-host sidecar requires an explicit declaration without fallback', () => {
    const f = mkFixture({});
    const r = dispatch(f, {
      unitType: 'execute-task', hostRuntime: 'claude', workerEngine: 'codex', workerMode: 'sidecar',
    });
    assertEqual(r.dispatch_allowed, false, 'undeclared cross-host sidecar is refused');
    assertEqual(r.dispatch_reason_code, 'sidecar-declaration-required', 'cross-host refusal is stable');
    assertEqual(r.resolved_worker_engine, '', 'refusal does not choose a fallback worker');
    cleanup(f);
  });

  runCase('unknown host is a deterministic resolver refusal, never a Claude fallback', () => {
    const f = mkFixture({});
    const r = dispatch(f, { unitType: 'execute-task', hostRuntime: 'unknown-host' });
    assertEqual(r.dispatch_allowed, false, 'unknown host is refused');
    assertEqual(r.dispatch_reason_code, 'invalid-host-runtime', 'unknown host reason is stable');
    assertEqual(r.host_runtime, 'unknown-host', 'refusal echoes the requested host for diagnosis');
    assertEqual(r.resolved_worker_engine, '', 'unknown host does not fall back to Claude');
    cleanup(f);
  });

  runCase('CLI represents an explicitly declared sidecar', () => {
    const f = mkFixture({});
    const cli = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--host-runtime', 'codex', '--worker-engine', 'codex', '--worker-mode', 'sidecar', '--sidecar-declared', '--cwd', f.dir], { encoding: 'utf8', env: cliEnv });
    let parsed = null;
    try { parsed = JSON.parse(cli.stdout); } catch (error) { fail('sidecar CLI stdout is valid JSON', error.message); }
    assertEqual(cli.status, 0, 'declared sidecar CLI exits zero');
    assert(parsed && parsed.dispatch_allowed === true, 'declared sidecar CLI permits dispatch', cli.stdout);
    assert(parsed && parsed.worker_reason_code === 'sidecar-declared', 'declared sidecar CLI reports its reason', cli.stdout);
    cleanup(f);
  });
});

process.stdout.write(`\nResults: ${passes} passed, ${fails} failed\n`);
process.exit(fails > 0 ? 1 : 0);
