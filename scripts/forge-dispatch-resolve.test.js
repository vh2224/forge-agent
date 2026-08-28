#!/usr/bin/env node
'use strict';

// Standalone parity matrix for forge-dispatch-resolve.  This deliberately has
// no test-framework dependency: it is useful before the installer runs too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  resolveDispatch,
  degradedContract,
  runtimeFields,
  composeRuntimePosture,
  TIER_DEFAULTS,
} = require('./forge-dispatch-resolve.js');
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
    assertEqual(r.worker_engine, 'claude', 'omitted worker target projects the effective Claude route');
    assertEqual(r.worker_mode, 'native', 'legacy omission keeps native worker mode');
    assertEqual(r.resolved_worker_engine, 'claude', 'legacy native worker resolves to Claude host');
    assertEqual(r.dispatch_allowed, true, 'legacy contract remains dispatchable');
    assertEqual(r.dispatch_reason_code, 'runtime-posture-observed', 'default leg reports the guard diagnostic');
    assertEqual(r.dispatch_posture, 'observe', 'default leg uses the observed posture');
    assertEqual(r.dispatch_decision, 'advisory', 'default leg is an advisory decision');
    assert(typeof r.dispatch_hint === 'string' && r.dispatch_hint.trim() !== '', 'default leg includes the guard hint', r.dispatch_hint);
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

  runCase('inline YAML comments on tier/effort/tag do not defeat the override', () => {
    // Regression: `tier: heavy  # refactor` used to resolve to an unknown tier,
    // empty the model chain, and silently fall back to the agent frontmatter
    // model. The comment must be stripped before enum comparison.
    const clean = mkFixture({ plan: '---\ntier: heavy\neffort: high\n---\n# task\n' });
    const expected = dispatch(clean, { unitType: 'execute-task' });
    cleanup(clean);
    const commented = mkFixture({ plan: '---\ntier: heavy  # cross-cutting refactor\neffort: high # deep pass\n---\n# task\n' });
    const r = dispatch(commented, { unitType: 'execute-task' });
    assertEqual(r.tier, 'heavy', 'commented tier still resolves heavy');
    assertEqual(r.reason, 'frontmatter-override:heavy', 'commented tier keeps override reason');
    assertEqual(r.effort, 'high', 'commented effort still resolves high');
    assertEqual(r.model, expected.model, 'commented plan resolves the same model as the clean plan');
    assert(r.model !== '', 'commented tier never empties the model chain', r.model);
    cleanup(commented);
    const taggedClean = mkFixture({ plan: '---\ntag: docs\n---\n# task\n' });
    const expectedTag = dispatch(taggedClean, { unitType: 'execute-task' });
    cleanup(taggedClean);
    const tagged = mkFixture({ plan: '---\ntag: docs  # prose only\n---\n# task\n' });
    const rt = dispatch(tagged, { unitType: 'execute-task' });
    assertEqual(rt.tier, 'light', 'commented docs tag still selects light tier');
    assertEqual(rt.model, expectedTag.model, 'commented tag resolves the same model as the clean tag');
    cleanup(tagged);
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

  runCase('non-routable GPT tier resolves to the Claude model that can actually run', () => {
    const f = mkFixture({ prefsJsonc: '{"tier_models":{"max":"gpt-5.6-sol"}}' });
    const r = dispatch(f, { unitType: 'plan-milestone' });
    assertEqual(r.model, 'claude-fable-5', 'non-routable max phase uses canonical Claude model');
    assertEqual(r.alias, 'fable', 'the selected model is applicable by Agent()');
    assertEqual(r.engine, 'claude', 'engine names the runtime that actually executes');
    assertEqual(r.dispatch_engine, 'claude', 'non-routable phase never advertises a missing sidecar');
    assertEqual(r.engine_reason, 'non-routable-family-substituted:claude', 'reason names the substitution');
    cleanup(f);
  });

  runCase('non-routable mixed tier keeps configured Claude members and removes external ones', () => {
    const f = mkFixture({ prefsJsonc: '{"tier_models":{"max":["gpt-5.6-sol","claude-opus-5"]}}' });
    const r = dispatch(f, { unitType: 'plan-milestone' });
    assertEqual(r.model, 'claude-opus-5', 'configured Claude fallback becomes the applied primary');
    assertEqual(r.chain_len, 1, 'unexecutable GPT member is absent from the phase chain');
    assertEqual(r.dispatch_engine, 'claude', 'mixed tier remains an in-process dispatch');
    cleanup(f);
  });

  runCase('explicit workers.execute-task claude is not overridden by a GPT tier model', () => {
    const f = mkFixture({ prefsJsonc: '{"workers":{"execute-task":"claude"},"tier_models":{"standard":"gpt-5.6-sol"}}' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.engine, 'claude', 'explicit worker engine wins');
    assertEqual(r.dispatch_engine, 'claude', 'explicit Claude worker never enters the sidecar');
    assertEqual(r.model, 'claude-sonnet-5', 'model is applicable to the explicit Claude worker');
    assertEqual(r.alias, 'sonnet', 'Agent receives the actual selected model alias');
    assertEqual(r.engine_reason, 'workers.execute-task:claude|model-family-substituted', 'reason names both the pin and substitution');
    cleanup(f);
  });

  runCase('tier-only frontmatter does not bypass explicit workers.execute-task claude', () => {
    const f = mkFixture({
      prefsJsonc: '{"workers":{"execute-task":"claude"},"tier_models":{"standard":"gpt-5.6-sol"}}',
      plan: '---\ntier: standard\n---\n# task\n',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'frontmatter', 'tier remains a frontmatter selection for reporting');
    assertEqual(r.model, 'claude-sonnet-5', 'tier-only metadata cannot make the Claude worker consume GPT');
    assertEqual(r.engine, 'claude', 'explicit worker engine still wins');
    assertEqual(r.dispatch_engine, 'claude', 'no external writer is activated behind the isolation pin');
    cleanup(f);
  });

  runCase('frontmatter Codex overrides an explicit Claude worker pin', () => {
    const f = mkFixture({
      prefsJsonc: '{"workers":{"execute-task":"claude"},"tier_models":{"standard":"gpt-5.6-sol"}}',
      plan: '---\nworker: codex\ntier: standard\n---\n# task\n',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'frontmatter', 'frontmatter remains the highest-precedence source');
    assertEqual(r.engine, 'gpt', 'frontmatter selects the external model family');
    assertEqual(r.dispatch_engine, 'codex', 'the write-capable sidecar is activated');
    cleanup(f);
  });

  runCase('Codex route on the default Claude host derives a declared sidecar', () => {
    const f = mkFixture({ prefsJsonc: '{"tier_models":{"standard":"gpt-5.6-sol"}}' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.engine, 'gpt', 'routable tier derives GPT family');
    assertEqual(r.dispatch_engine, 'codex', 'execute-task has a Codex adapter');
    assertEqual(r.host_runtime, 'claude', 'omitted host keeps the Claude default');
    assertEqual(r.worker_engine, 'codex', 'omitted worker target projects the Codex route');
    assertEqual(r.worker_mode, 'sidecar', 'cross-host identity derives sidecar mode');
    assertEqual(r.resolved_worker_engine, 'codex', 'resolved worker is the effective Codex route');
    assertEqual(r.sidecar_declared, true, 'the resolved route is declared by the adapter');
    assertEqual(r.dispatch_allowed, true, 'the derived sidecar is dispatchable');
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

  runCase('--shell-exports emits every loop variable as one eval-safe pass', () => {
    const f = mkFixture({ plan: '---\ntier: heavy\n---\n# task\n' });
    const contract = dispatch(f, { unitType: 'execute-task' });
    const cli = spawnSync('node', [SCRIPT, '--shell-exports'], {
      encoding: 'utf8', env: cliEnv, input: JSON.stringify(contract),
    });
    assertEqual(cli.status, 0, '--shell-exports exits 0 on a valid payload');
    const lines = cli.stdout.trim().split('\n');
    const byName = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const preexistingLines = [
      `MODEL_ID='${contract.model}'`,
      `MODEL_ALIAS='${contract.alias || ''}'`,
      `TIER='${contract.tier}'`,
      `REASON='${contract.reason}'`,
      `DOMAIN_USED='${contract.domain}'`,
      `ROUTE_SOURCE='${contract.route_source}'`,
      `CHAIN_LEN='${contract.chain_len}'`,
      `ENGINE='${contract.engine}'`,
      `DISPATCH_ENGINE='${contract.dispatch_engine || ''}'`,
      `ENGINE_REASON='${contract.engine_reason}'`,
      `EFFORT='${contract.effort}'`,
      `EFFORT_REASON='${contract.effort_reason}'`,
      `WORKERS_TIMEOUT='${contract.workers_timeout}'`,
      `CODEX_MODEL='${contract.codex_model || ''}'`,
      `SIDECAR_MODEL='${contract.sidecar_model || ''}'`,
      `THINKING_HEADER='${contract.thinking_header || ''}'`,
      `DOMAIN='${contract.domain_input || ''}'`,
      `PLAN_TIER='${contract.frontmatter_tier || ''}'`,
      `PLAN_WORKER='${contract.plan_worker || ''}'`,
      `ROUTING_PRESENT='${contract.routing_present ? 'true' : 'false'}'`,
      `MODEL_APPLIED_JSON='${contract.alias ? JSON.stringify(contract.alias) : 'null'}'`,
      `unit_effort='${contract.effort}'`,
    ];
    assertEqual(lines.slice(0, preexistingLines.length).join('\n'), preexistingLines.join('\n'),
      'preexisting export lines remain byte-identical for the same contract');
    assertEqual(lines.slice(-10).map((line) => line.slice(0, line.indexOf('='))).join(','),
      'HOST_RUNTIME,WORKER_ENGINE,WORKER_MODE,DISPATCH_ALLOWED,DISPATCH_REASON_CODE,DISPATCH_HINT,DISPATCH_POSTURE,DISPATCH_DECISION,RESOLVED_WORKER_ENGINE,SIDECAR_DECLARED',
      'runtime exports are appended without disturbing the legacy prefix');
    assertEqual(byName.MODEL_ID, `'${contract.model}'`, 'MODEL_ID mirrors the contract');
    assertEqual(byName.TIER, "'heavy'", 'TIER mirrors the frontmatter override');
    assertEqual(byName.unit_effort, `'${contract.effort}'`, 'unit_effort rides along');
    assertEqual(byName.ROUTING_PRESENT, "'false'", 'no routing block in the fixture');
    assertEqual(byName.HOST_RUNTIME, `'${contract.host_runtime}'`, 'HOST_RUNTIME mirrors the contract');
    assertEqual(byName.WORKER_ENGINE, `'${contract.worker_engine}'`, 'WORKER_ENGINE mirrors the contract');
    assertEqual(byName.WORKER_MODE, `'${contract.worker_mode}'`, 'WORKER_MODE mirrors the contract');
    assertEqual(byName.DISPATCH_ALLOWED, `'${String(contract.dispatch_allowed)}'`, 'DISPATCH_ALLOWED is textual boolean');
    assertEqual(byName.DISPATCH_REASON_CODE, `'${contract.dispatch_reason_code}'`, 'DISPATCH_REASON_CODE mirrors the contract');
    assertEqual(byName.DISPATCH_HINT, `'${contract.dispatch_hint}'`, 'DISPATCH_HINT mirrors the contract');
    assertEqual(byName.DISPATCH_POSTURE, `'${contract.dispatch_posture}'`, 'DISPATCH_POSTURE mirrors the contract');
    assertEqual(byName.DISPATCH_DECISION, `'${contract.dispatch_decision}'`, 'DISPATCH_DECISION mirrors the contract');
    assertEqual(byName.RESOLVED_WORKER_ENGINE, `'${contract.resolved_worker_engine}'`, 'RESOLVED_WORKER_ENGINE mirrors the contract');
    assertEqual(byName.SIDECAR_DECLARED, `'${String(contract.sidecar_declared)}'`, 'SIDECAR_DECLARED is a textual boolean');
    assert(byName.MODEL_APPLIED_JSON === `'${JSON.stringify(contract.alias)}'` || byName.MODEL_APPLIED_JSON === "'null'",
      'MODEL_APPLIED_JSON is a JSON literal (string or null)', byName.MODEL_APPLIED_JSON);
    // Every assignment must survive a real shell eval — including quotes.
    const evil = {
      ...contract,
      reason: "o'reilly | x:y",
      dispatch_hint: "Use Codex now; don't launch Claude (host: codex)!",
    };
    const evilOut = spawnSync('node', [SCRIPT, '--shell-exports'], { encoding: 'utf8', env: cliEnv, input: JSON.stringify(evil) });
    const probe = spawnSync('bash', ['-c', `eval "$(cat)"; printf '%s\n%s' "$REASON" "$DISPATCH_HINT"`], { encoding: 'utf8', input: evilOut.stdout });
    if (probe.error) { /* bash unavailable (Windows CI) — quoting already asserted above */ }
    else assertEqual(probe.stdout, "o'reilly | x:y\nUse Codex now; don't launch Claude (host: codex)!",
      'eval round-trips quotes, spaces, and punctuation in diagnostic exports');
    const garbage = spawnSync('node', [SCRIPT, '--shell-exports'], { encoding: 'utf8', env: cliEnv, input: '{nope' });
    assertEqual(garbage.status, 2, 'unparseable stdin is a loud exit 2 — never an eval of garbage');
    cleanup(f);
  });

  runCase('contract exposes routing_present so the shadowing warning needs no second spawn', () => {
    const absent = mkFixture({});
    assertEqual(dispatch(absent, { unitType: 'execute-task' }).routing_present, false, 'no routing block → false');
    cleanup(absent);
    const present = mkFixture({ prefsJsonc: '{"routing":{"default":{"executor":{"standard":["claude-sonnet-5"]}}}}' });
    assertEqual(dispatch(present, { unitType: 'execute-task' }).routing_present, true, 'parseable routing block → true');
    cleanup(present);
  });

  runCase('degraded contract keeps the additive sidecar_model key', () => {
    const r = degradedContract(['--unit-type', 'execute-task']);
    assert('sidecar_model' in r, 'degraded contract exposes sidecar_model');
    assertEqual(r.sidecar_model, '', 'degraded contract sidecar model is empty');
  });

  runCase('degraded contract names its own cause instead of blaming the unit type', () => {
    const r = degradedContract(['--unit-type', 'execute-task']);
    assertEqual(r.degraded, true, 'degraded contracts are marked as such');
    assertEqual(r.effort_reason, 'degraded:routing-runtime-error',
      'effort_reason names the crash, not unit-type:<x> — the unit type did not decide this effort');
  });

  runCase('degraded contracts remain parseable and cannot restore the forbidden Codex-to-Claude leg', () => {
    const degraded = degradedContract([
      '--unit-type', 'execute-task',
      '--host-runtime', 'codex',
    ], {});
    const roundTrip = JSON.parse(JSON.stringify(degraded));
    assertEqual(roundTrip.degraded, true, 'degraded verdict survives a JSON round trip');
    assertEqual(roundTrip.host_runtime, 'codex', 'degraded verdict keeps the requested Codex host');
    assertEqual(roundTrip.resolved_worker_engine, 'claude', 'degraded route still resolves the effective Claude worker');
    assertEqual(roundTrip.dispatch_allowed, false, 'degradation does not fail open over the enforcing leg');
    assertEqual(roundTrip.dispatch_reason_code, 'codex-claude-unroutable', 'degradation uses the guard reason');
    assertEqual(roundTrip.dispatch_posture, 'enforce', 'degradation keeps the frozen enforcing posture');
    assertEqual(roundTrip.dispatch_decision, 'refuse', 'degradation exposes the refusal decision');
    assert(typeof roundTrip.dispatch_hint === 'string' && roundTrip.dispatch_hint.trim() !== '',
      'degradation includes an actionable refusal hint', roundTrip.dispatch_hint);
  });

  runCase('degraded contracts publish runtime exports for allowed and refused payloads', () => {
    const allowed = degradedContract(['--unit-type', 'execute-task']);
    const refused = degradedContract(['--unit-type', 'execute-task', '--host-runtime', 'unknown-host']);
    for (const [label, contract] of [['allowed', allowed], ['refused', refused]]) {
      const cli = spawnSync('node', [SCRIPT, '--shell-exports'], {
        encoding: 'utf8', env: cliEnv, input: JSON.stringify(contract),
      });
      assertEqual(cli.status, 0, `${label} degraded payload emits shell exports`);
      const values = Object.fromEntries(cli.stdout.trim().split('\n').map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
      }));
      assertEqual(values.HOST_RUNTIME, `'${contract.host_runtime}'`, `${label} export carries host runtime`);
      assertEqual(values.WORKER_ENGINE, `'${contract.worker_engine}'`, `${label} export carries worker engine`);
      assertEqual(values.WORKER_MODE, `'${contract.worker_mode}'`, `${label} export carries worker mode`);
      assertEqual(values.DISPATCH_ALLOWED, `'${String(contract.dispatch_allowed)}'`, `${label} export carries textual allowance`);
      assertEqual(values.DISPATCH_REASON_CODE, `'${contract.dispatch_reason_code}'`, `${label} export carries refusal code`);
      assertEqual(values.DISPATCH_HINT, `'${contract.dispatch_hint}'`, `${label} export carries the diagnostic hint`);
      assertEqual(values.DISPATCH_POSTURE, `'${contract.dispatch_posture || ''}'`, `${label} export carries posture`);
      assertEqual(values.DISPATCH_DECISION, `'${contract.dispatch_decision}'`, `${label} export carries the decision`);
      assertEqual(values.RESOLVED_WORKER_ENGINE, `'${contract.resolved_worker_engine}'`, `${label} export carries resolved worker`);
      assertEqual(values.SIDECAR_DECLARED, `'${String(contract.sidecar_declared)}'`, `${label} export carries sidecar declaration`);
    }
  });

  runCase('invalid frontmatter effort is annotated, not silently defaulted', () => {
    const f = mkFixture({ plan: '---\neffort: turbo\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.effort, 'medium', 'invalid effort still defaults to medium');
    assert(/invalid-effort-defaulted:turbo/.test(r.effort_reason),
      'effort_reason records that the frontmatter value was rejected', r.effort_reason);
    cleanup(f);
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

  runCase('legacy loop projection stays frozen when the host axis is omitted', () => {
    const f = mkFixture({});
    const contract = dispatch(f, { unitType: 'execute-task' });
    const legacyKeys = [
      'engine', 'model', 'alias', 'tier', 'domain', 'route_source', 'chain', 'chain_len', 'reason', 'effort', 'effort_reason',
      'model_applied', 'engine_reason', 'workers_engine', 'workers_timeout', 'codex_model', 'plan_worker', 'domain_input',
      'frontmatter_tier', 'thinking_header', 'routing_present', 'dispatch_engine', 'sidecar_model', 'prefs_ok', 'prefs_errors',
    ];
    const projection = Object.fromEntries(legacyKeys.map((key) => [key, contract[key]]));
    const frozen = {
      engine: 'claude', model: 'claude-sonnet-5', alias: 'sonnet', tier: 'standard', domain: 'default',
      route_source: 'tier_models',
      chain: [{ id: 'claude-sonnet-5', alias: 'sonnet', mapped: true, engine: 'claude' }],
      chain_len: 1, reason: 'unit-type:execute-task', effort: 'low', effort_reason: 'unit-type:execute-task',
      model_applied: 'sonnet', engine_reason: 'default:claude', workers_engine: 'claude', workers_timeout: 1800,
      codex_model: '', plan_worker: '', domain_input: 'default', frontmatter_tier: '', thinking_header: '',
      routing_present: false, dispatch_engine: 'claude', sidecar_model: '', prefs_ok: true, prefs_errors: [],
    };
    assertEqual(JSON.stringify(projection), JSON.stringify(frozen),
      'all preexisting loop fields retain their deterministic serialization');
    cleanup(f);
  });

  runCase('library composition applies the frozen guard posture to all four Claude/Codex quadrants', () => {
    const quadrants = [
      { host: 'claude', dispatch: 'claude', mode: 'native', posture: 'observe', allowed: true, reason: 'runtime-posture-observed', decision: 'advisory' },
      { host: 'claude', dispatch: 'codex', mode: 'sidecar', posture: 'observe', allowed: true, reason: 'runtime-posture-observed', decision: 'advisory' },
      { host: 'codex', dispatch: 'claude', mode: 'sidecar', posture: 'enforce', allowed: false, reason: 'codex-claude-unroutable', decision: 'refuse' },
      { host: 'codex', dispatch: 'codex', mode: 'native', posture: 'observe', allowed: true, reason: 'runtime-posture-observed', decision: 'advisory' },
    ];
    for (const quadrant of quadrants) {
      const validated = runtimeFields({ hostRuntime: quadrant.host }, quadrant.dispatch);
      const r = composeRuntimePosture(validated, {});
      const label = `${quadrant.host}->${quadrant.dispatch}`;
      assertEqual(r.host_runtime, quadrant.host, `${label} keeps the concrete host`);
      assertEqual(r.worker_engine, quadrant.dispatch, `${label} projects the effective route`);
      assertEqual(r.resolved_worker_engine, quadrant.dispatch, `${label} resolves the projected worker`);
      assertEqual(r.worker_mode, quadrant.mode, `${label} derives ${quadrant.mode}`);
      assertEqual(r.sidecar_declared, quadrant.mode === 'sidecar', `${label} declares only adapter-derived sidecars`);
      assertEqual(r.dispatch_posture, quadrant.posture, `${label} projects the frozen posture`);
      assertEqual(r.dispatch_allowed, quadrant.allowed, `${label} projects the allowance`);
      assertEqual(r.dispatch_reason_code, quadrant.reason, `${label} projects the stable guard reason`);
      assertEqual(r.dispatch_decision, quadrant.decision, `${label} projects the guard decision`);
      assert(typeof r.dispatch_hint === 'string' && r.dispatch_hint.trim() !== '', `${label} projects a non-empty hint`, r.dispatch_hint);
    }
  });

  runCase('host_runtime is an additive input and does not reinterpret legacy routing fields', () => {
    const f = mkFixture({ prefsJsonc: '{"tier_models":{"standard":"claude-opus-4-8"}}' });
    const legacy = dispatch(f, { unitType: 'execute-task' });
    const codexHost = dispatch(f, { unitType: 'execute-task', host_runtime: 'codex' });
    for (const key of ['engine', 'model', 'alias', 'tier', 'domain', 'route_source', 'chain', 'chain_len', 'reason', 'effort', 'effort_reason', 'dispatch_engine']) {
      assertEqual(JSON.stringify(codexHost[key]), JSON.stringify(legacy[key]), `host input preserves legacy ${key}`);
    }
    assertEqual(codexHost.host_runtime, 'codex', 'explicit snake_case host is emitted');
    assertEqual(codexHost.worker_engine, 'claude', 'omitted worker engine projects the effective Claude route');
    assertEqual(codexHost.worker_mode, 'sidecar', 'different host and route derive sidecar mode');
    assertEqual(codexHost.resolved_worker_engine, 'claude', 'projected route resolves to Claude');
    assertEqual(codexHost.sidecar_declared, true, 'adapter declares the projected cross-host route');
    cleanup(f);
  });

  runCase('CLI accepts --host-runtime and retains the ordered legacy prefix', () => {
    const f = mkFixture({});
    const environment = { ...cliEnv };
    delete environment.FORGE_RUNTIME_ENFORCE;
    const cli = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--host-runtime', 'codex', '--cwd', f.dir], { encoding: 'utf8', env: environment });
    let parsed = null;
    try { parsed = JSON.parse(cli.stdout); } catch (error) { fail('host-runtime CLI stdout is valid JSON', error.message); }
    assertEqual(cli.status, 0, 'host-runtime CLI exits zero');
    assert(parsed && parsed.host_runtime === 'codex', 'host-runtime CLI exposes Codex host', cli.stdout);
    assert(parsed && parsed.worker_engine === 'claude', 'host-runtime CLI projects the Claude route', cli.stdout);
    assert(parsed && parsed.worker_mode === 'sidecar', 'host-runtime CLI derives cross-host sidecar mode', cli.stdout);
    assert(parsed && parsed.resolved_worker_engine === 'claude', 'host-runtime CLI resolves the projected route', cli.stdout);
    assert(parsed && parsed.dispatch_allowed === false, 'host-runtime CLI refuses the enforcing Codex-to-Claude leg', cli.stdout);
    assert(parsed && parsed.dispatch_reason_code === 'codex-claude-unroutable', 'host-runtime CLI carries the stable guard reason', cli.stdout);
    assertEqual(Object.keys(parsed || {}).slice(0, 11).join(','), 'engine,model,alias,tier,domain,route_source,chain,chain_len,reason,effort,effort_reason', 'host-runtime preserves ordered legacy prefix');
    cleanup(f);
  });

  runCase('real resolver CLI honors only the exact textual zero escape on the enforcing leg', () => {
    const f = mkFixture({});
    const args = ['--json', '--unit-type', 'execute-task', '--host-runtime', 'codex', '--cwd', f.dir];
    const enforcingEnv = { ...cliEnv };
    delete enforcingEnv.FORGE_RUNTIME_ENFORCE;
    const refusedChild = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: enforcingEnv });
    const refused = JSON.parse(refusedChild.stdout);
    assertEqual(refusedChild.status, 0, 'dispatch refusal remains a parseable resolver verdict, not a resolver crash');
    assertEqual(refused.dispatch_allowed, false, 'default CLI environment enforces Codex-to-Claude refusal');
    assertEqual(refused.dispatch_reason_code, 'codex-claude-unroutable', 'default CLI verdict uses the exact stable reason');
    assertEqual(refused.dispatch_posture, 'enforce', 'default CLI verdict exposes enforcing posture');
    assertEqual(refused.dispatch_decision, 'refuse', 'default CLI verdict exposes refusal decision');
    assert(typeof refused.dispatch_hint === 'string' && refused.dispatch_hint.trim() !== '',
      'default CLI verdict includes an actionable hint', refused.dispatch_hint);

    const escapedChild = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...enforcingEnv, FORGE_RUNTIME_ENFORCE: '0' },
    });
    const escaped = JSON.parse(escapedChild.stdout);
    assertEqual(escapedChild.status, 0, 'escaped resolver CLI exits normally');
    assertEqual(escaped.dispatch_allowed, true, 'exact textual zero suppresses only the active refusal');
    assertEqual(escaped.dispatch_reason_code, 'codex-claude-unroutable', 'escape preserves the enforcing leg diagnostic');
    assertEqual(escaped.dispatch_posture, 'enforce', 'escape does not rewrite frozen posture');
    assertEqual(escaped.dispatch_decision, 'advisory', 'escape changes the enforcing decision to advisory');
    assertEqual(escaped.host_runtime, refused.host_runtime, 'escape does not alter the host identity');
    assertEqual(escaped.resolved_worker_engine, refused.resolved_worker_engine, 'escape does not alter the worker identity');
    const changedKeys = Object.keys(refused).filter((key) =>
      JSON.stringify(refused[key]) !== JSON.stringify(escaped[key])).sort();
    assertEqual(changedKeys.join(','), 'dispatch_allowed,dispatch_decision',
      'escape changes only allowance and decision in the public resolver contract');
    cleanup(f);
  });

  runCase('native target never falls back to a routed model family', () => {
    const f = mkFixture({ prefsJsonc: '{"routing":{"default":{"executor":{"standard":"claude-opus-4-8"}}}}' });
    const r = dispatch(f, { unitType: 'execute-task', hostRuntime: 'codex', workerEngine: 'native' });
    assertEqual(r.engine, 'claude', 'route still classifies the Claude model family');
    assertEqual(r.resolved_worker_engine, 'codex', 'native target remains the Codex host');
    assertEqual(r.dispatch_allowed, true, 'native host target is allowed');
    assertEqual(r.dispatch_posture, 'observe', 'native Codex target uses observe posture');
    assertEqual(r.dispatch_decision, 'advisory', 'native Codex target remains advisory');
    cleanup(f);
  });

  runCase('host Codex plus dispatch Codex with both worker axes omitted is native and allowed', () => {
    const f = mkFixture({ prefsJsonc: '{"routing":{"default":{"executor":{"standard":["gpt-5-codex"]}}}}' });
    const options = { unitType: 'execute-task', hostRuntime: 'codex' };
    assert(!Object.prototype.hasOwnProperty.call(options, 'workerEngine') && !Object.prototype.hasOwnProperty.call(options, 'workerMode'),
      'fixture genuinely omits both worker axes');
    const r = dispatch(f, options);
    assertEqual(r.dispatch_engine, 'codex', 'routing exposes the Codex dispatch trigger');
    assertEqual(r.worker_engine, 'codex', 'omitted worker target projects Codex');
    assertEqual(r.worker_mode, 'native', 'equal concrete identities derive native');
    assertEqual(r.dispatch_allowed, true, 'same-host native dispatch is allowed');
    assert(r.dispatch_reason_code !== 'implicit-recursion-refused', 'omitted axes never enter recursion refusal', r.dispatch_reason_code);
    assertEqual(r.dispatch_reason_code, 'runtime-posture-observed', 'Codex-native reports the posture observation');
    assertEqual(r.dispatch_posture, 'observe', 'Codex-native is observed');
    assertEqual(r.dispatch_decision, 'advisory', 'Codex-native stays advisory');

    const cli = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--host-runtime', 'codex', '--cwd', f.dir], {
      encoding: 'utf8', env: cliEnv,
    });
    let parsed = null;
    try { parsed = JSON.parse(cli.stdout); } catch (error) { fail('omitted-axes CLI stdout is valid JSON', error.message); }
    assertEqual(cli.status, 0, 'omitted-axes CLI exits zero');
    assert(parsed && parsed.worker_engine === 'codex' && parsed.worker_mode === 'native',
      'CLI derives the same Codex-native decision', cli.stdout);
    assert(parsed && parsed.dispatch_allowed === true && parsed.dispatch_reason_code !== 'implicit-recursion-refused',
      'CLI allows Codex-native without recursion refusal', cli.stdout);
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
    assertEqual(crossHost.worker_reason_code, 'sidecar-declared', 'runtime validation accepts the declared sidecar');
    assertEqual(crossHost.dispatch_allowed, false, 'guard posture refuses the otherwise representable Codex-to-Claude leg');
    assertEqual(crossHost.dispatch_reason_code, 'codex-claude-unroutable', 'guard refusal owns the public dispatch reason');
    assertEqual(crossHost.dispatch_posture, 'enforce', 'cross-host guard result carries enforcing posture');
    assertEqual(crossHost.dispatch_decision, 'refuse', 'cross-host guard result carries refusal decision');

    const modeOnly = dispatch(f, {
      unitType: 'execute-task', hostRuntime: 'codex', workerMode: 'native',
    });
    assertEqual(modeOnly.worker_engine, 'native', 'explicit mode prevents route projection of an omitted worker engine');
    assertEqual(modeOnly.worker_mode, 'native', 'explicit native mode is never rewritten');
    assertEqual(modeOnly.resolved_worker_engine, 'codex', 'explicit native worker resolves only through the host seam');
    assertEqual(modeOnly.dispatch_allowed, true, 'explicit native host worker remains allowed');

    const mismatch = dispatch(f, {
      unitType: 'execute-task', hostRuntime: 'codex', workerEngine: 'claude', workerMode: 'native',
    });
    assertEqual(mismatch.worker_engine, 'claude', 'native mismatch preserves requested worker');
    assertEqual(mismatch.dispatch_allowed, false, 'native cross-host mismatch is refused');
    assertEqual(mismatch.dispatch_reason_code, 'native-engine-host-mismatch', 'native mismatch reason is stable');
    assertEqual(mismatch.dispatch_posture, null, 'native mismatch never reaches posture selection');
    assertEqual(mismatch.dispatch_decision, 'error', 'native mismatch remains a validation error');
    assert(typeof mismatch.dispatch_hint === 'string' && mismatch.dispatch_hint.includes('native-engine-host-mismatch'),
      'native mismatch receives an actionable canonical-code hint', mismatch.dispatch_hint);

    const invalidMode = dispatch(f, {
      unitType: 'execute-task', hostRuntime: 'codex', workerMode: 'turbo',
    });
    assertEqual(invalidMode.dispatch_allowed, false, 'explicit invalid mode is validated instead of derived');
    assertEqual(invalidMode.dispatch_reason_code, 'invalid-worker-mode', 'explicit invalid mode keeps the canonical reason code');
    assertEqual(invalidMode.worker_reason_code, 'invalid-worker-mode', 'worker and dispatch diagnostics retain the runtime code');
    assertEqual(invalidMode.dispatch_posture, null, 'invalid mode cannot be hidden by posture composition');
    assertEqual(invalidMode.dispatch_decision, 'error', 'invalid mode remains a validation error');
    assert(typeof invalidMode.dispatch_hint === 'string' && invalidMode.dispatch_hint.includes('invalid-worker-mode'),
      'invalid mode receives an actionable canonical-code hint', invalidMode.dispatch_hint);
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
    assertEqual(r.dispatch_posture, null, 'undeclared sidecar is refused before posture selection');
    assertEqual(r.dispatch_decision, 'error', 'undeclared sidecar remains a runtime validation error');
    assert(typeof r.dispatch_hint === 'string' && r.dispatch_hint.includes('sidecar-declaration-required'),
      'undeclared sidecar gets an actionable canonical-code hint', r.dispatch_hint);
    cleanup(f);
  });

  runCase('unknown host is a deterministic resolver refusal, never a Claude fallback', () => {
    const f = mkFixture({});
    const r = dispatch(f, { unitType: 'execute-task', hostRuntime: 'unknown-host' });
    assertEqual(r.dispatch_allowed, false, 'unknown host is refused');
    assertEqual(r.dispatch_reason_code, 'invalid-host-runtime', 'unknown host reason is stable');
    assertEqual(r.host_runtime, 'unknown-host', 'refusal echoes the requested host for diagnosis');
    assertEqual(r.resolved_worker_engine, '', 'unknown host does not fall back to Claude');
    assertEqual(r.dispatch_posture, null, 'unknown host cannot select posture');
    assertEqual(r.dispatch_decision, 'error', 'unknown host remains a runtime validation error');
    assert(typeof r.dispatch_hint === 'string' && r.dispatch_hint.includes('invalid-host-runtime'),
      'unknown host gets an actionable canonical-code hint', r.dispatch_hint);
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
