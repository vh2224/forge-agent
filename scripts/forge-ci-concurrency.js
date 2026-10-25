'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Reviewed scalar bytes and explicit models; never evaluate Actions expressions.
const PR_CANCEL = "${{ github.event_name == 'pull_request' }}";
const groupForm = prefix => `${prefix}-\${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}`;
const SUPPORTED_FORMS = Object.freeze({
  groups: Object.freeze({ ci: groupForm('ci'), app: groupForm('app'), release: 'release' }),
  cancellations: Object.freeze({ pull_request: PR_CANCEL, never: 'false' }),
});
const WORKFLOWS = Object.freeze(['ci', 'app', 'release']);
const INVARIANTS = Object.freeze(['push-never-cancelled', 'pr-superseded-only',
  'last-pr-run-completes', 'groups-disjoint', 'no-pr-controlled-group-input', 'release-active-never-cancelled']);

function fail(code) {
  const error = new Error(`${code}: forma de concorrencia nao suportada.`);
  error.code = code;
  throw error;
}

function readConcurrency(text) {
  if (typeof text !== 'string') fail('concurrency-form-unsupported');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let inJobs = false;
  let block = false;
  let present = false;
  const values = {};
  for (const line of lines) {
    if (/^(?:\s*#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) {
      inJobs = /^jobs:/.test(line);
      block = false;
      if (/^concurrency\s*:/.test(line)) {
        if (present || !/^concurrency:$/.test(line)) fail('concurrency-form-unsupported');
        present = true;
        block = true;
      }
      continue;
    }
    if (inJobs && /^\s+concurrency\s*:/.test(line)) fail('job-concurrency-unsupported');
    if (!block) continue;
    const match = /^  ([a-z-]+): (.+)$/.exec(line);
    if (!match || !['group', 'cancel-in-progress'].includes(match[1]) || Object.hasOwn(values, match[1])) {
      fail('concurrency-key-unsupported');
    }
    values[match[1]] = match[2];
  }
  if (!present) return { present: false };
  if (!Object.values(SUPPORTED_FORMS.groups).includes(values.group)
    || !Object.values(SUPPORTED_FORMS.cancellations).includes(values['cancel-in-progress'])) fail('expression-unsupported');
  return { present: true, ...values };
}

function modelFor(concurrency, workflowId) {
  if (!WORKFLOWS.includes(workflowId) || !concurrency.present) fail('expression-unsupported');
  const form = Object.keys(SUPPORTED_FORMS.groups).find(key => SUPPORTED_FORMS.groups[key] === concurrency.group);
  if (!form || !Object.values(SUPPORTED_FORMS.cancellations).includes(concurrency['cancel-in-progress'])) fail('expression-unsupported');
  return {
    workflowId, form,
    inputs: Object.freeze(form === 'release' ? [] : ['event_name', 'pull_request.number', 'run_id']),
    group: form === 'release' ? () => 'release'
      : event => event.event_name === 'pull_request' ? `${form}-pr-${event.pr}` : `${form}-run-${event.run_id}`,
    cancel: concurrency['cancel-in-progress'] === PR_CANCEL ? event => event.event_name === 'pull_request' : () => false,
  };
}

function groupsDisjoint(runs) {
  return runs.every((a, index) => runs.slice(index + 1).every(b => {
    const mayShare = a.workflow === b.workflow && (a.workflow === 'release'
      || (a.event_name === 'pull_request' && b.event_name === 'pull_request' && a.pr === b.pr));
    return mayShare || a.group !== b.group;
  }));
}

// Fresh arrivals only. Cancellation latency is a model assumption, not a measured
// GitHub scheduler property. At an equal timestamp termination precedes arrival.
function simulate({ models, events, cancelLatency = 1 }) {
  if (!Number.isFinite(cancelLatency) || cancelLatency < 0 || !Array.isArray(events)) fail('simulation-input-invalid');
  const groups = new Map();
  const runs = [];
  const timeline = [];
  const ids = new Set();
  const ordered = events.map((event, ordinal) => ({ ...event, ordinal })).sort((a, b) => a.at - b.at || a.ordinal - b.ordinal);
  function record(run, action, at) { timeline.push({ at, run_id: run.run_id, workflow: run.workflow, group: run.group, action }); }
  function start(slot, run, at) {
    slot.active = run;
    run.started_at = at;
    run.finish_at = at + run.duration;
    record(run, 'started', at);
  }
  function advance(until) {
    while (true) {
      let next = Infinity;
      for (const slot of groups.values()) if (slot.active) next = Math.min(next, slot.active.finish_at);
      if (next === Infinity || next > until) return;
      for (const slot of groups.values()) {
        if (!slot.active || slot.active.finish_at !== next) continue;
        const run = slot.active;
        run.result = run.cancelling ? 'cancelled-in-progress' : 'completed';
        run.ended_at = next;
        record(run, run.result, next);
        slot.active = null;
        if (slot.pending) {
          const pending = slot.pending;
          slot.pending = null;
          start(slot, pending, next);
        }
      }
    }
  }
  for (const event of ordered) {
    const model = models[event.workflow];
    const id = `${event.workflow}:${event.run_id}`;
    if (!model || ids.has(id) || !Number.isFinite(event.at) || event.at < 0
      || !Number.isFinite(event.duration) || event.duration <= 0) fail('simulation-input-invalid');
    ids.add(id);
    advance(event.at);
    const run = { ...event, group: model.group(event), result: null, started_at: null, affected_by: null };
    runs.push(run);
    record(run, 'arrived', event.at);
    if (!groups.has(run.group)) groups.set(run.group, { active: null, pending: null });
    const slot = groups.get(run.group);
    if (!slot.active) { start(slot, run, event.at); continue; }
    if (model.cancel(event) && !slot.active.cancelling) {
      slot.active.cancelling = true;
      slot.active.affected_by = id;
      slot.active.finish_at = Math.min(slot.active.finish_at, event.at + cancelLatency);
      record(slot.active, 'cancelling', event.at);
    }
    if (slot.pending) {
      slot.pending.result = 'replaced-while-pending';
      slot.pending.affected_by = id;
      slot.pending.ended_at = event.at;
      record(slot.pending, slot.pending.result, event.at);
    }
    slot.pending = run;
    record(run, 'pending', event.at);
    advance(event.at);
  }
  advance(Infinity);
  const byId = new Map(runs.map(run => [`${run.workflow}:${run.run_id}`, run]));
  const superseded = runs.filter(run => run.result !== 'completed' && run.workflow !== 'release');
  const prSets = new Map();
  for (const run of runs) if (run.event_name === 'pull_request' && run.workflow !== 'release') prSets.set(`${run.workflow}:${run.pr}`, run);
  const invariants = {
    'push-never-cancelled': runs.filter(run => run.event_name !== 'pull_request' && run.workflow !== 'release').every(run => run.result === 'completed'),
    'pr-superseded-only': superseded.every(run => {
      const by = byId.get(run.affected_by);
      return run.event_name === 'pull_request' && by && by.event_name === 'pull_request'
        && by.workflow === run.workflow && by.pr === run.pr
        && (by.at > run.at || (by.at === run.at && by.ordinal > run.ordinal));
    }),
    'last-pr-run-completes': [...prSets.values()].every(run => run.result === 'completed'),
    'groups-disjoint': groupsDisjoint(runs),
    'no-pr-controlled-group-input': Object.values(models).every(model => Array.isArray(model.inputs)
      && model.inputs.every(input => ['event_name', 'pull_request.number', 'run_id'].includes(input))),
    'release-active-never-cancelled': runs.filter(run => run.workflow === 'release' && run.started_at !== null).every(run => run.result === 'completed'),
  };
  return { runs, timeline, invariants, passed: INVARIANTS.every(key => invariants[key]),
    limitations: runs.some(run => run.workflow === 'release' && run.result === 'replaced-while-pending') ? ['release-pending-may-be-replaced'] : [] };
}

function burst(workflow, event_name, pr, count = 5, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({ workflow, event_name, pr,
    run_id: offset + index + 1, at: index, duration: 20, ref: 'refs/heads/master' }));
}
const REHEARSALS = Object.freeze([
  { name: 'same-pr-burst', events: burst('ci', 'pull_request', 7) },
  { name: 'interleaved-prs', events: [...burst('ci', 'pull_request', 7), ...burst('ci', 'pull_request', 8, 5, 10)] },
  { name: 'master-burst', events: burst('ci', 'push', null) },
  { name: 'master-and-pr', events: [...burst('ci', 'push', null), ...burst('ci', 'pull_request', 7, 5, 10)] },
  { name: 'app-pr-burst', events: burst('app', 'pull_request', 7) },
  { name: 'simultaneous-workflows', events: [...burst('ci', 'pull_request', 7), ...burst('app', 'pull_request', 7)] },
  { name: 'release-burst', events: burst('release', 'push', null, 3) },
].map(row => Object.freeze({ name: row.name, events: Object.freeze(row.events.map(Object.freeze)) })));

function rehearse(texts) {
  const forms = {};
  const hashes = {};
  const models = {};
  for (const workflow of WORKFLOWS) {
    const bytes = texts[workflow];
    if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes)) fail('concurrency-form-unsupported');
    hashes[workflow] = crypto.createHash('sha256').update(bytes).digest('hex');
    forms[workflow] = readConcurrency(bytes.toString());
    models[workflow] = modelFor(forms[workflow], workflow);
  }
  // No conclusion depends on one cancellation-latency choice.
  const scenarios = REHEARSALS.flatMap(row => [0, 1, 10, 100].map(cancelLatency => ({
    name: row.name, cancel_latency: cancelLatency, ...simulate({ models, events: row.events, cancelLatency }),
  })));
  const invariants = Object.fromEntries(INVARIANTS.map(key => [key, scenarios.every(row => row.invariants[key])]));
  // Cross-workflow contexts also include app push and non-push/non-PR events;
  // identical PR/run numbers must never collide with a different workflow.
  const groupContexts = WORKFLOWS.flatMap(workflow => [
    { event_name: 'pull_request', pr: 7, run_id: 1 },
    { event_name: 'pull_request', pr: 7, run_id: 2 },
    { event_name: 'pull_request', pr: 8, run_id: 3 },
    { event_name: 'push', pr: null, run_id: 7 },
    { event_name: 'push', pr: null, run_id: 8 },
    { event_name: 'workflow_dispatch', pr: null, run_id: 9 },
  ].map(event => ({ ...event, workflow, group: models[workflow].group(event) })));
  invariants['groups-disjoint'] = invariants['groups-disjoint'] && groupsDisjoint(groupContexts);
  return { schema: 'forge-ci-concurrency-rehearsal/v1', forms, workflow_sha256: hashes, scenarios, group_contexts: groupContexts, invariants,
    passed: Object.values(invariants).every(Boolean),
    assumptions: ['fresh-arrivals-only', 'pending-until-cancellation-ends-is-model-assumption'],
    limitations: ['release-pending-may-be-replaced', 'old-manual-pr-reruns-newest-head-unverified', 'hosted-validation-pending', 'remote-check-consumers-unknown'],
    queue_note: 'Nenhuma opcao queue foi usada ou verificada.' };
}

function main(argv) {
  let root = path.resolve(__dirname, '..');
  let out = null;
  let json = false;
  let requested = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--rehearse' && !requested) requested = true;
    else if (arg === '--json' && !json) json = true;
    else if ((arg === '--root' || arg === '--out') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      const value = path.resolve(argv[++index]);
      if (arg === '--root') root = value; else out = value;
    } else fail('cli-argument-invalid');
  }
  if (!requested) fail('cli-argument-invalid');
  const physicalRoot = fs.realpathSync(root);
  const texts = Object.fromEntries(WORKFLOWS.map(id => {
    const file = path.join(root, '.github', 'workflows', `${id}.yml`);
    const relative = path.relative(physicalRoot, fs.realpathSync(file));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('workflow-path-outside-root');
    return [id, fs.readFileSync(file)];
  }));
  const result = rehearse(texts);
  const output = json ? JSON.stringify(result, null, 2) + '\n'
    : `Ensaio local: ${result.passed ? 'PASS' : 'FAIL'} (${result.scenarios.length} cenarios).\n`
      + Object.entries(result.invariants).map(([key, value]) => `${value ? 'PASS' : 'FAIL'} ${key}`).join('\n')
      + `\nLimitacoes: ${result.limitations.join(', ')}\nPremissas: ${result.assumptions.join(', ')}\n${result.queue_note}\n`;
  if (out) fs.writeFileSync(out, output);
  process.stdout.write(output);
  return result.passed ? 0 : 1;
}

module.exports = { SUPPORTED_FORMS, readConcurrency, modelFor, simulate, REHEARSALS, rehearse, main };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.code || 'rehearsal-error'}: ${error.message}\n`); process.exitCode = 2; }
}
