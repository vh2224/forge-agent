#!/usr/bin/env node
'use strict';

// S03/T01 parity of UNLINKED standalone tasks. The trace below exercises the
// public preparation, transport, personal-context and status APIs for a task
// without any linked-task record, in temporary roots with a temporary profile,
// staged procedure modules, a real resolver over fixture preferences and no
// Git, network or provider. It is compared byte for byte (canonical JSON of the
// normalized trace) with scripts/fixtures/linked-task/unlinked-baseline.json,
// captured on the base revision before any tracked source was edited.
//
// The normal mode only validates: it never regenerates the fixture. Capture is
// a guarded direct API (captureBaseline) used by the single initializer
// scripts/fixtures/linked-task/capture-unlinked-baseline.js and by the optional
// --capture-baseline CLI mode; both refuse unless every tracked source still has
// the owner-provided base worktree sha256, and an existing fixture is never
// overwritten. Import is inert: no file is read or written until a function runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'linked-task', 'unlinked-baseline.json');
const SCHEMA_VERSION = 1;
const KIND = 'forge-linked-task-unlinked-baseline';
const BASE_REVISION = '49d2df533d477baf42e4d67bf6409d3181cde77e';
const CLOCK = '2026-11-03T12:00:00.000Z';
const PHASES = Object.freeze(['brainstorm', 'discuss', 'research', 'plan']);
const HOSTS = Object.freeze(['claude', 'codex']);
// Owner-provided worktree sha256 of each tracked source at the base revision
// (OWNER-S03-T01-PARITY-PROVENANCE.json). Git LF blob hashes are separate proof.
const OWNER_SOURCES = Object.freeze([
  ['scripts/forge-task-preparation.js', 'c7208e163000e246fb284d20115d2b3b8f9ac286142174a858a97e57af8c0355'],
  ['scripts/forge-unit-sidecar.js', 'de03b19602d16575a305c5bc1c0177be89355caad66f8a313f931f491c285d11'],
  ['scripts/forge-task-execution.js', '4b3461c49fad7a467d1cb80e5fb79d4cf50ed7af4ebf6588d27b946bb817187e'],
  ['scripts/forge-native-invocation.js', '446de92908bdee0a5ab0cf31ba560b96a015751b250bf4349bbf3a5c494802f5'],
  ['scripts/forge-milestone-time-admission.js', '634d6268d04fa52f9f7ae550a508a1a7b2bb23c5c67bb612629aa78e279a8cea'],
  ['scripts/forge-personal-context.js', 'b6d7a439be790cbc77a2064599ee814844fe34a6a9f09bdfd8741eb2ca01ffe8'],
  ['scripts/forge-personal-summary.js', 'e39866046fa427ce7070f79b566b4dbba80884d5f88bd40d1161fcd3c413210c'],
  ['scripts/forge-status.js', 'a571cc1b237747ff52f4648037a2a1689d4a7d35e52dce79a31c485e62a1c74f'],
  ['skills/forge-task/SKILL.md', 'd81556180d9bb16d45a8f81ba6b5faa12ece7f6601a510963f29eb50fe10679b'],
].map(([file, sha256]) => Object.freeze({ path: file, worktree_sha256: sha256 })));
// Pre-change sources of this task: capture is only valid before they are edited.
const CAPTURE_GUARDS = Object.freeze([
  ['scripts/forge-milestone-time.js', '2241e76ff9befefbcc0903882462a435da7e975ccbf52f3152280a07a2f44a8a'],
  ['scripts/forge-milestone-time-selection.js', '2777567a1d3ab32b9fb73737fbe6f70f2401a2167b7f87cfc8e7e8fb11539e80'],
].map(([file, sha256]) => Object.freeze({ path: file, worktree_sha256: sha256 })));
const METHOD = 'Direct API trace in temporary roots: staged procedure modules, fixture preferences, temporary HOME/USERPROFILE profile, '
  + 'real resolver, no Git, network or provider; temporary root and repository paths replaced by placeholders with forward slashes; '
  + 'only volatile capture/bind/generation timestamps replaced; prompts recorded by sha256 and byte length.';
const NORMALIZATION = Object.freeze({ placeholders: ['<root>', '<forge>'], volatile_keys: ['capturedAt', 'boundAt', 'generated_at'],
  omitted_resolution_sources: '<forge>/scripts/' });
const VOLATILE = new Set(NORMALIZATION.volatile_keys);

function fail(code, detail) { throw Object.assign(new Error(detail ? code + ': ' + detail : code), { code }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function sourceHash(relative, root = REPO) { return sha256(fs.readFileSync(path.join(root, ...relative.split('/')))); }
// Names every tracked or guard source whose current bytes differ from the owner value.
function divergentSources(list, hash = sourceHash) {
  return list.filter(row => { try { return hash(row.path) !== row.worktree_sha256; } catch { return true; } }).map(row => row.path);
}

// ---------------------------------------------------------------------------
// Normalization: deterministic, platform-neutral projection of a trace.
// ---------------------------------------------------------------------------
function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizer(pairs) {
  const variants = [];
  for (const [actual, placeholder] of pairs) {
    for (const form of new Set([actual, actual.replace(/\\/g, '/'), actual.replace(/\\/g, '\\\\'), JSON.stringify(actual).slice(1, -1)])) variants.push([form, placeholder]);
  }
  variants.sort((a, b) => b[0].length - a[0].length);
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  const patterns = variants.map(([form, placeholder]) => [new RegExp(escapeRegExp(form), flags), placeholder]);
  const tail = /(<root>|<forge>)((?:(?:\\\\|\\|\/)[^\s"'`\\/<>]+)*)/g;
  const text = value => {
    let out = value;
    for (const [pattern, placeholder] of patterns) out = out.replace(pattern, placeholder);
    return out.replace(tail, (match, head, rest) => head + rest.replace(/\\\\|\\/g, '/'));
  };
  // The resolver fingerprints every runtime module of the Forge scripts directory in
  // route.resolution_sources; that resolver provenance changes with any script edit and is
  // not unlinked-task behavior, so only the preference-layer sources are kept.
  // Preserve the immutable capture's root-before-forge order BEFORE callers
  // derive artifact fingerprints. Absolute-path sorting puts /home before /tmp
  // on POSIX, whereas the Windows capture put its temporary HOME first.
  const sourceKey = row => row.path.replace(/^<root>/, '0').replace(/^<forge>/, '1');
  const sources = rows => rows.filter(row => !(object(row) && typeof row.path === 'string' && row.path.startsWith('<forge>/scripts/')))
    .sort((a, b) => sourceKey(a) < sourceKey(b) ? -1 : sourceKey(a) > sourceKey(b) ? 1 : 0);
  const walk = value => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (object(value)) return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== 'function')
      .map(([k, v]) => [text(k), VOLATILE.has(k) && v !== null ? '<time>' : k === 'resolution_sources' && Array.isArray(v) ? sources(walk(v)) : walk(v)]));
    return value === undefined || typeof value === 'function' ? null : value;
  };
  return walk;
}
function swap(value, from, to) {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) return value.map(v => swap(v, from, to));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v, from, to)]));
  return value;
}
// Platform-independent comparison projection (R39). forge-personal-context canonical() lowercases source
// paths only on win32, so the immutable Windows capture stores the fixture personal task components in
// lowercase while POSIX preserves T-...-BRIEF.md / -PLAN.md. Only this fixture's own task id and its two
// artifact names are folded; arbitrary paths are never lowercased. Applied to stored and current traces alike.
const PERSONAL_FIXTURE_PATH = /t-20261103120000-parity-personal(?:-(?:brief|plan)\.md)?/gi;
function personalCaseProjection(value) {
  if (typeof value === 'string') return value.replace(PERSONAL_FIXTURE_PATH, match => match.toLowerCase());
  if (Array.isArray(value)) return value.map(personalCaseProjection);
  if (object(value)) {
    const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, personalCaseProjection(v)]));
    // The resolver sorts physical paths, whose relative prefix order differs
    // between Windows and POSIX. Provenance is a set keyed by source path:
    // compare its normalized order, retaining every path, physical path/hash.
    if (Array.isArray(out.resolution_sources)) out.resolution_sources.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return out;
  }
  return value;
}
function textDigest(value) { return typeof value === 'string' ? { sha256: sha256(value), bytes: Buffer.byteLength(value) } : null; }

// ---------------------------------------------------------------------------
// Trace of the unlinked flow
// ---------------------------------------------------------------------------
function stageProcedures(destination) {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'shared/forge-procedures.json'), 'utf8'));
  fs.mkdirSync(path.join(destination, 'shared'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'shared/forge-procedures.json'), path.join(destination, 'shared/forge-procedures.json'));
  for (const module of manifest.modules.filter(item => item.status === 'ready')) {
    fs.mkdirSync(path.dirname(path.join(destination, module.path)), { recursive: true });
    fs.copyFileSync(path.join(REPO, module.path), path.join(destination, module.path));
  }
}
function owner(root, name, model) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ tier_models: { light: model, standard: model, heavy: model, max: model },
    effort: { 'plan-slice': 'medium', 'discuss-milestone': 'medium', 'research-milestone': 'medium', 'plan-milestone': 'medium' } }));
  return dir;
}
function phaseContent(phase) {
  if (phase === 'brainstorm') return '# Brainstorm\n\n## Recommended Approach\n\nUm único chamador.\n\n## Alternatives Considered\n\nManter o resolvedor.\n\n## Top Risks\n\nDeriva de rota.\n\n## Out of Scope\n\nProviders reais.\n';
  if (phase === 'discuss') return '# Context\n\n## Decisions\n\nUsar recibos.\n\n## Open Questions\n\nNenhuma.\n\n## Out of Scope\n\nInstalação.\n';
  if (phase === 'research') return "# Research\n\n## Summary\n\nMedido internamente.\n\n## Don't Hand-Roll\n\nReusar o resolvedor.\n\n## Relevant Code\n\nscripts/.\n";
  return '---\ntier: standard\neffort: medium\ndepends: []\nexpected_output: [scripts/x.js]\nmust_haves:\n  truths: [Saída observável]\n  artifacts: []\n  key_links: []\nwrites:\n  - scripts/x.js\n---\n\n# Plan\n\n## Steps\n\n1. Implementar.\n\n## Must-Haves\n\n- O comando passa.\n\n## Standards\n\n- Reusar helpers.\n\n## Files to Change\n\n- scripts/x.js — implementação.\n';
}
function projectStart(started) {
  if (!object(started)) return { value: typeof started };
  const { invoke, delivery_request: delivery, invocation, ...rest } = started;
  const out = { ...rest, invoke: typeof invoke };
  if (delivery) out.delivery_request = { ...delivery, prompt: textDigest(delivery.prompt) };
  if (invocation) {
    const args = { ...invocation.args };
    for (const key of ['message', 'prompt']) if (typeof args[key] === 'string') args[key] = textDigest(args[key]);
    out.invocation = { tool: invocation.tool, args, telemetry: invocation.telemetry };
  }
  return out;
}
function projectComplete(result) {
  if (!object(result)) return { value: typeof result };
  const route = object(result.route) ? { host_runtime: result.route.host_runtime, resolved_worker_engine: result.route.resolved_worker_engine,
    worker_mode: result.route.worker_mode, unit_type: result.route.unit_type, model_resolved: result.route.model_resolved, effort: result.route.effort } : null;
  return { ok: result.ok, action: result.action, transport: result.transport ?? null, status: result.status, reason_code: result.reason_code,
    provider_called: result.provider_called, replayed: result.replayed === true, route, result_status: result.result?.status ?? null };
}
function guarded(callback) {
  try { const value = callback(); return { outcome: 'returned', type: typeof value, value: value === undefined ? null : value }; }
  catch (error) { return { outcome: 'threw', code: error.code ?? null, provider_called: error.provider_called ?? null }; }
}
function skillBlocks(text) {
  const lf = text.replace(/\r\n/g, '\n');
  const init = lf.indexOf('\n## Initialize task'), start = init < 0 ? -1 : lf.indexOf('```markdown\n', init);
  const end = start < 0 ? -1 : lf.indexOf('\n```\n', start + 12);
  const open = '<!-- forge:task-preparation-request:start -->', close = '<!-- forge:task-preparation-request:end -->';
  const rs = lf.indexOf(open), re = lf.indexOf(close);
  if (start < 0 || end < 0 || rs < 0 || re < rs || lf.indexOf(open, rs + 1) >= 0) fail('parity-skill-block-missing');
  const brief = lf.slice(start, end + 4), builder = lf.slice(rs, re + close.length);
  return { brief_template: { sha256: sha256(brief), bytes: Buffer.byteLength(brief) }, request_builder: { sha256: sha256(builder), bytes: Buffer.byteLength(builder) } };
}
function briefText(taskId, description) {
  return `---\nid: ${taskId}\ndescription: ${description}\ncreated: ${CLOCK}\nskip_brainstorm: false\nskip_research: false\n---\n\n# ${description}\n`;
}

async function computeTrace() {
  const prep = require('./forge-task-preparation'), unit = require('./forge-unit-sidecar'), execution = require('./forge-task-execution');
  const admission = require('./forge-milestone-time-admission'), personal = require('./forge-personal-context');
  const summary = require('./forge-personal-summary'), status = require('./forge-status'), runs = require('./forge-runs');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-linked-parity-')));
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME'].map(k => [k, process.env[k]]));
  const home = path.join(root, 'home');
  try {
    fs.mkdirSync(home);
    process.env.HOME = home; process.env.USERPROFILE = home; process.env.FORGE_HOME = REPO;
    const normalize = normalizer([[root, '<root>'], [REPO, '<forge>']]);
    const code = path.join(root, 'code'), results = path.join(root, 'results');
    fs.mkdirSync(code); fs.mkdirSync(results); stageProcedures(code);
    const owners = { claude: owner(root, 'owner-claude', 'claude-sonnet-5'), gpt: owner(root, 'owner-gpt', 'gpt-5.6-sol') };
    const agent = path.join(results, 'agents', 'forge-agent.md');
    const request = (ownerDir, host, phase, label, extra = {}) => ({ schema_version: 1, scope: 'standalone-task', phase,
      taskId: 'T-20261103120000-parity-' + label, cwd: code, contextRoot: ownerDir, hostRuntime: host, workflowId: 'parity-' + label,
      dispatchId: 'parity-' + label + '-dispatch', resultFile: path.join(results, label + '.json'), constraints: { auto_commit: false, deploy: false },
      inputs: { brief: 'Tarefa sem vínculo ' + label }, prompt: '## Task Brief\n\n# Tarefa sem vínculo ' + label + '\n', ...extra });
    const nativeExtra = (host, phase) => {
      if (host === 'codex') return { activeCapabilities: { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema',
        models: ['gpt-5.6-sol'], reasoning_efforts: ['medium', 'high'], fork_turns: ['none'] } };
      const file = agent.replace('forge-agent', prep.PHASE_CONTRACTS[phase].agentType);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '---\nname: ' + prep.PHASE_CONTRACTS[phase].agentType + '\neffort: medium\n---\n');
      return { activeCapabilities: { available: true, tool: 'Agent', source: 'fixture-tool-schema', model_aliases: ['sonnet'], effort_transports: ['agent-frontmatter'] },
        effortBinding: { transport: 'agent-frontmatter', agentPath: file, sourceFingerprint: 'sha256:' + sha256(fs.readFileSync(file)) } };
    };
    const routes = { claude: { sidecar: owners.gpt, native: owners.claude }, codex: { sidecar: owners.claude, native: owners.gpt } };
    const phases = {};
    for (const phase of PHASES) {
      phases[phase] = {};
      for (const host of HOSTS) {
        const entry = {};
        for (const mode of ['sidecar', 'native']) {
          const raw = request(routes[host][mode], host, phase, host + '-' + phase + '-' + mode, mode === 'native' ? nativeExtra(host, phase) : {});
          const validated = prep.validateRequest(raw);
          const prompt = prep.buildPreparationPrompt(validated);
          const started = await prep.startStandaloneTaskPreparation(raw);
          const route = started.route;
          const delivery = route ? prep.deliveryRequest(validated, route, prompt) : null;
          // Fingerprints over absolute paths are re-derived over the normalized request.
          const requestFingerprint = prep.preparationRequestFingerprint(normalize(validated));
          const rebind = value => swap(normalize(value), prep.preparationRequestFingerprint(validated), requestFingerprint);
          const normalizedDelivery = delivery ? rebind(delivery) : null;
          entry[mode] = {
            prompt: textDigest(prompt),
            request_fingerprint: requestFingerprint,
            delivery_request: normalizedDelivery ? { ...normalizedDelivery, prompt: textDigest(delivery.prompt) } : null,
            artifact_fingerprint: normalizedDelivery ? unit.artifactFingerprint(normalizedDelivery) : null,
            start: rebind(projectStart(started)),
            sidecar_locations: delivery ? guarded(() => normalize(unit.locations(delivery))) : null,
            transport_entry: { request: guarded(() => admission.assertOwnerTransportEntry({ request: delivery || validated })),
              telemetry: guarded(() => admission.assertOwnerTransportEntry({ telemetryIdentity: validated })) },
          };
        }
        phases[phase][host] = entry;
      }
    }
    // One simulated sidecar preparation end to end per host (receipt phases and published artifact).
    const endToEnd = {};
    for (const host of HOSTS) {
      const raw = request(routes[host].sidecar, host, 'discuss', host + '-e2e');
      const receipt = () => { try { return JSON.parse(fs.readFileSync(raw.resultFile + '.receipt.json', 'utf8')).phase; } catch { return 'absent'; } };
      const envelope = { status: 'done', summary: 'discuss complete', questions: [],
        artifacts: [{ path: prep.requiredArtifact(raw), content: phaseContent('discuss') }] };
      const receiptPhases = [receipt()];
      const result = await prep.prepareStandaloneTask(raw, { invokeSidecar: async () => { receiptPhases.push(receipt()); return envelope; } });
      receiptPhases.push(receipt());
      const replay = await prep.prepareStandaloneTask(raw, { resolveDispatch() { throw new Error('replay must not resolve'); },
        invokeSidecar() { throw new Error('replay must not invoke'); } });
      receiptPhases.push(receipt());
      const artifact = path.join(raw.contextRoot, ...prep.requiredArtifact(raw).split('/'));
      endToEnd[host] = normalize({ result: projectComplete(result), replay: projectComplete(replay), receipt_phases: receiptPhases,
        artifact: { path: prep.requiredArtifact(raw), sha256: fs.existsSync(artifact) ? sha256(fs.readFileSync(artifact)) : null } });
    }
    // Execution locations of an unlinked standalone task.
    const executeRequest = { scope: 'standalone-task', phase: 'execute', unitType: 'execute-task', taskId: 'T-20261103120000-parity-execute' };
    const locations = normalize({ execution: guarded(() => execution.locations(executeRequest)), sidecar: guarded(() => unit.locations(executeRequest)) });
    // Personal context and status of one bound unlinked standalone task.
    const project = path.join(root, 'personal-owner'), taskId = 'T-20261103120000-parity-personal', description = 'Tarefa sem vínculo pessoal';
    fs.mkdirSync(path.join(project, '.gsd', 'tasks', taskId), { recursive: true });
    const brief = path.join(project, '.gsd', 'tasks', taskId, taskId + '-BRIEF.md');
    fs.writeFileSync(brief, briefText(taskId, description));
    fs.writeFileSync(path.join(project, '.gsd', 'tasks', taskId, taskId + '-PLAN.md'), '---\nid: ' + taskId + '\nstatus: RUNNING\n---\n\n# Plano sem vínculo\n');
    runs.add(project, { id: taskId, kind: 'task', session_id: 'parity-session', active: true, started_at: Date.parse(CLOCK), last_heartbeat: Date.parse(CLOCK),
      cwd: project, project, task_description: description });
    const profile = { project, userHome: home, env: { HOME: home, USERPROFILE: home } };
    const bound = personal.bindWork({ ...profile, id: taskId, kind: 'task', intent: 'create' });
    const checkpoint = personal.saveCheckpoint({ ...profile, id: taskId, intent: 'checkpoint',
      checkpoint: { nextAction: [{ text: 'Executar a fase de brainstorm', source: '.gsd/tasks/' + taskId + '/' + taskId + '-BRIEF.md', resolved: false }] } });
    const personalTrace = normalize({ bind: bound, checkpoint, snapshot: personal.readPersonalSnapshot(profile), select: personal.selectPersonalWork(profile),
      summary: summary.buildPersonalSummary(profile), status: status.collect(project, { userHome: home, env: profile.env }) });
    const skill = skillBlocks(fs.readFileSync(path.join(REPO, 'skills', 'forge-task', 'SKILL.md'), 'utf8'));
    return { schema_version: SCHEMA_VERSION, phases, end_to_end: endToEnd, locations, personal: personalTrace, skill };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Baseline document: provenance, integrity and guarded capture
// ---------------------------------------------------------------------------
function provenance(capturedAt) {
  return { revision: BASE_REVISION, sources: OWNER_SOURCES.map(row => ({ ...row })), capture_source_guards: CAPTURE_GUARDS.map(row => ({ ...row })),
    method: METHOD, clock: CLOCK, normalization: { ...NORMALIZATION }, provider_calls: 0, captured_at: capturedAt };
}
function traceDigest(trace) { return sha256(JSON.stringify(trace)); }
// Named defects of a trace: a broken or provider-calling flow is never accepted as a baseline.
function traceProblems(trace) {
  const problems = [];
  for (const phase of PHASES) for (const host of HOSTS) for (const mode of ['sidecar', 'native']) {
    const entry = trace?.phases?.[phase]?.[host]?.[mode], at = phase + '/' + host + '/' + mode;
    if (!entry) { problems.push(at + ' missing'); continue; }
    if (entry.start.ok !== true || entry.start.action !== (mode === 'sidecar' ? 'invoke-sidecar' : 'invoke-native'))
      problems.push(at + ' start ' + entry.start.action + ':' + entry.start.reason_code);
    if (entry.start.provider_called !== false) problems.push(at + ' provider_called ' + entry.start.provider_called);
    if (!entry.delivery_request || !entry.artifact_fingerprint) problems.push(at + ' delivery missing');
    if (entry.sidecar_locations?.outcome !== 'returned') problems.push(at + ' locations ' + entry.sidecar_locations?.code);
    if (entry.transport_entry.request.outcome !== 'returned' || entry.transport_entry.telemetry.outcome !== 'returned') problems.push(at + ' transport entry refused');
  }
  for (const host of HOSTS) {
    const e2e = trace?.end_to_end?.[host];
    if (!e2e || e2e.result.ok !== true || e2e.result.status !== 'done' || e2e.replay.replayed !== true || !e2e.artifact.sha256)
      problems.push(host + ' end-to-end ' + JSON.stringify(e2e?.result?.reason_code ?? null) + '/' + JSON.stringify(e2e?.replay?.reason_code ?? null));
  }
  if (trace?.locations?.execution?.outcome !== 'returned' || trace?.locations?.sidecar?.outcome !== 'returned') problems.push('execution locations refused');
  const personal = trace?.personal;
  if (personal?.bind?.status !== 'ok' || personal?.checkpoint?.status !== 'ok' || personal?.select?.selected?.id !== 'T-20261103120000-parity-personal'
      || personal?.summary?.status !== 'ok' || personal?.status?.status !== 'ok') problems.push('personal ' + [personal?.bind?.reason, personal?.checkpoint?.reason, personal?.select?.reason, personal?.summary?.reason, personal?.status?.reason].join(','));
  return problems;
}
function baselineDocument(trace, capturedAt) {
  return { schema_version: SCHEMA_VERSION, kind: KIND, provenance: provenance(capturedAt), trace_sha256: traceDigest(trace), trace };
}
// Structural validation of a stored document; the trace itself is only compared, never repaired.
function validateDocument(document) {
  const reason = r => ({ ok: false, reason: r });
  if (!object(document) || Object.keys(document).sort().join() !== 'kind,provenance,schema_version,trace,trace_sha256'
      || document.schema_version !== SCHEMA_VERSION || document.kind !== KIND) return reason('parity-baseline-schema-invalid');
  const p = document.provenance, expected = provenance(p?.captured_at);
  if (!object(p) || typeof p.captured_at !== 'string' || !Number.isFinite(Date.parse(p.captured_at)) || new Date(p.captured_at).toISOString() !== p.captured_at
      || JSON.stringify(p) !== JSON.stringify(expected)) return reason('parity-baseline-provenance-mismatch');
  if (!object(document.trace) || document.trace_sha256 !== traceDigest(document.trace)) return reason('parity-baseline-integrity-invalid');
  return { ok: true };
}
function readDocument(file = FIXTURE) {
  let bytes; try { bytes = fs.readFileSync(file); } catch (error) { return error.code === 'ENOENT' ? { status: 'absent' } : { status: 'invalid', reason: 'parity-baseline-unreadable' }; }
  let document; try { document = JSON.parse(bytes.toString('utf8')); } catch { return { status: 'invalid', reason: 'parity-baseline-json-invalid' }; }
  const valid = validateDocument(document);
  if (!valid.ok) return { status: 'invalid', reason: valid.reason };
  if (bytes.toString('utf8') !== JSON.stringify(document, null, 2) + '\n') return { status: 'invalid', reason: 'parity-baseline-bytes-noncanonical' };
  return { status: 'valid', document };
}
// Single guarded initialization. An existing fixture is validated and never
// rewritten; an absent one is captured only while every tracked and guard source
// still has the owner base hash. Nothing else is accepted.
async function captureBaseline(options = {}) {
  const file = options.file || FIXTURE, hash = options.hashSource || sourceHash, trace = options.computeTrace || computeTrace;
  const existing = readDocument(file);
  if (existing.status === 'valid') return { status: 'validated', file, trace_sha256: existing.document.trace_sha256 };
  if (existing.status === 'invalid') fail(existing.reason);
  const divergent = divergentSources([...OWNER_SOURCES, ...CAPTURE_GUARDS], hash);
  if (divergent.length) fail('parity-source-divergent', divergent.join(', '));
  const captured = await trace();
  if (!options.computeTrace) {
    // The real capture is traced twice in fresh roots and must be deterministic and healthy.
    const second = await computeTrace();
    if (JSON.stringify(second) !== JSON.stringify(captured)) fail('parity-trace-nondeterministic', firstDifference(second, captured));
    const problems = traceProblems(captured);
    if (problems.length) fail('parity-trace-unhealthy', problems.join('; '));
  }
  // A source changing during the capture invalidates it.
  const after = divergentSources([...OWNER_SOURCES, ...CAPTURE_GUARDS], hash);
  if (after.length) fail('parity-source-divergent', after.join(', '));
  const document = baselineDocument(captured, new Date(options.now ?? Date.now()).toISOString());
  if (!validateDocument(document).ok) fail('parity-baseline-schema-invalid');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Exclusive creation: a concurrent or pre-existing file is never overwritten.
  fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  return { status: 'captured', file, trace_sha256: document.trace_sha256 };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
function firstDifference(a, b, at = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (object(a) && object(b) || Array.isArray(a) && Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    if (JSON.stringify(Object.keys(a)) !== JSON.stringify(Object.keys(b))) return at + ' (keys)';
    for (const k of keys) { const found = firstDifference(a[k], b[k], at + '.' + k); if (found) return found; }
  }
  return at;
}
async function captureUtilityChecks() {
  const assert = require('assert');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-linked-parity-capture-'));
  try {
    const base = row => [...OWNER_SOURCES, ...CAPTURE_GUARDS].find(r => r.path === row)?.worktree_sha256;
    const atBase = relative => base(relative);
    let traced = 0;
    const fakeTrace = async () => { traced++; return { schema_version: 1, sample: 'trace' }; };
    // Absent fixture with every source at the owner base: captured once, exclusively.
    const file = path.join(dir, 'nested', 'baseline.json');
    const first = await captureBaseline({ file, hashSource: atBase, computeTrace: fakeTrace, now: Date.parse(CLOCK) });
    assert.deepStrictEqual([first.status, traced], ['captured', 1]);
    const bytes = fs.readFileSync(file), stored = readDocument(file);
    assert.strictEqual(stored.status, 'valid');
    assert.strictEqual(stored.document.provenance.revision, BASE_REVISION);
    assert.deepStrictEqual(stored.document.provenance.sources.map(r => r.path), OWNER_SOURCES.map(r => r.path));
    // Existing valid fixture: validated, never rewritten and never traced again, even with divergent sources.
    const again = await captureBaseline({ file, hashSource: () => '0'.repeat(64), computeTrace: fakeTrace });
    assert.deepStrictEqual([again.status, traced], ['validated', 1]);
    assert.ok(fs.readFileSync(file).equals(bytes), 'existing fixture bytes unchanged');
    // Absent fixture after a tracked or guard source changed: refused, nothing written.
    for (const changed of [OWNER_SOURCES[0].path, OWNER_SOURCES[8].path, CAPTURE_GUARDS[0].path, CAPTURE_GUARDS[1].path]) {
      const target = path.join(dir, 'divergent-' + path.basename(changed) + '.json');
      await assert.rejects(captureBaseline({ file: target, hashSource: r => r === changed ? 'f'.repeat(64) : atBase(r), computeTrace: fakeTrace }),
        e => e.code === 'parity-source-divergent' && e.message.includes(changed));
      assert.ok(!fs.existsSync(target), 'no fixture after refusal');
    }
    assert.strictEqual(traced, 1, 'refused captures never trace');
    // A source changing during the capture is refused as well.
    let calls = 0;
    const racing = path.join(dir, 'racing.json');
    await assert.rejects(captureBaseline({ file: racing, hashSource: r => (calls++ >= OWNER_SOURCES.length + CAPTURE_GUARDS.length && r === OWNER_SOURCES[1].path ? 'e'.repeat(64) : atBase(r)), computeTrace: fakeTrace }),
      e => e.code === 'parity-source-divergent');
    assert.ok(!fs.existsSync(racing));
    assert.strictEqual(traced, 2, 'the racing capture traced once and wrote nothing');
    // Conflicting or damaged existing fixtures are never overwritten or repaired.
    const damaged = [['tampered-trace', d => { d.trace.sample = 'other'; }, 'parity-baseline-integrity-invalid'],
      ['foreign-revision', d => { d.provenance.revision = 'a'.repeat(40); }, 'parity-baseline-provenance-mismatch'],
      ['foreign-source-hash', d => { d.provenance.sources[2].worktree_sha256 = 'b'.repeat(64); }, 'parity-baseline-provenance-mismatch'],
      ['extra-key', d => { d.approved = true; }, 'parity-baseline-schema-invalid']];
    for (const [name, mutate, reason] of damaged) {
      const target = path.join(dir, name + '.json'), document = JSON.parse(bytes.toString('utf8')); mutate(document);
      fs.writeFileSync(target, JSON.stringify(document, null, 2) + '\n');
      const before = fs.readFileSync(target);
      await assert.rejects(captureBaseline({ file: target, hashSource: atBase, computeTrace: fakeTrace }), e => e.code === reason, name);
      assert.ok(fs.readFileSync(target).equals(before), name + ' not rewritten');
    }
    const json = path.join(dir, 'not-json.json'); fs.writeFileSync(json, '{');
    await assert.rejects(captureBaseline({ file: json, hashSource: atBase, computeTrace: fakeTrace }), e => e.code === 'parity-baseline-json-invalid');
    assert.strictEqual(fs.readFileSync(json, 'utf8'), '{');
    assert.strictEqual(traced, 2, 'damaged fixtures are refused before any trace');
    // The real tracked and guard lists are exactly the owner inventory.
    assert.deepStrictEqual(OWNER_SOURCES.map(r => r.path), ['scripts/forge-task-preparation.js', 'scripts/forge-unit-sidecar.js', 'scripts/forge-task-execution.js',
      'scripts/forge-native-invocation.js', 'scripts/forge-milestone-time-admission.js', 'scripts/forge-personal-context.js', 'scripts/forge-personal-summary.js',
      'scripts/forge-status.js', 'skills/forge-task/SKILL.md']);
    assert.deepStrictEqual(CAPTURE_GUARDS.map(r => r.path), ['scripts/forge-milestone-time.js', 'scripts/forge-milestone-time-selection.js']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function parityCheck() {
  const assert = require('assert');
  const trace = await computeTrace();
  // Two independent traces in fresh temporary roots are identical: the projection is deterministic.
  const second = await computeTrace();
  assert.strictEqual(JSON.stringify(second), JSON.stringify(trace), 'unlinked trace is not deterministic at ' + firstDifference(second, trace));
  // Every unlinked phase, both hosts and both routes are present, healthy and never called a provider.
  assert.deepStrictEqual(traceProblems(trace), []);
  assert.deepStrictEqual(Object.keys(trace.phases), [...PHASES]);
  for (const phase of PHASES) assert.deepStrictEqual(Object.keys(trace.phases[phase]), [...HOSTS]);
  // The normal mode only reads the owner baseline; it never captures or rewrites it.
  const stored = readDocument(FIXTURE);
  assert.strictEqual(stored.status, 'valid', 'baseline fixture must exist and be valid: ' + (stored.reason || stored.status));
  const expected = stored.document.trace;
  // The stored bytes and digest stay immutable; only the comparison is projected (see personalCaseProjection).
  const projectedTrace = personalCaseProjection(trace), projectedExpected = personalCaseProjection(expected);
  assert.strictEqual(traceDigest(projectedTrace), traceDigest(projectedExpected), 'unlinked trace differs from the owner baseline at ' + firstDifference(projectedTrace, projectedExpected));
  assert.strictEqual(JSON.stringify(projectedTrace), JSON.stringify(projectedExpected));
  // The raw stored digest still binds the immutable captured bytes.
  assert.strictEqual(traceDigest(expected), stored.document.trace_sha256);
  personalCaseProjectionChecks(assert);
}
function personalCaseProjectionChecks(assert) {
  const id = 'T-20261103120000-parity-personal', low = id.toLowerCase();
  const windows = { source: '<root>/personal-owner/.gsd/tasks/' + low + '/' + low + '-brief.md', plan: low + '-plan.md' };
  const posix = { source: '<root>/personal-owner/.gsd/tasks/' + id + '/' + id + '-BRIEF.md', plan: id + '-PLAN.md' };
  assert.notDeepStrictEqual(windows, posix);
  assert.deepStrictEqual(personalCaseProjection(windows), personalCaseProjection(posix));
  assert.strictEqual(personalCaseProjection(posix).source, windows.source);
  // Arbitrary paths and other task ids keep their case: no broad lowercasing.
  const other = { a: '<root>/Personal-Owner/.gsd/tasks/T-20261103120000-other/T-20261103120000-other-BRIEF.md', b: 'KEEP/Case.md' };
  assert.deepStrictEqual(personalCaseProjection(other), other);
  assert.notDeepStrictEqual(personalCaseProjection({ a: 'T-20261103120000-parity-execute' }), { a: 'T-20261103120000-parity-execute'.toLowerCase() });
  // A real behavioural difference is still a difference after projection.
  assert.notDeepStrictEqual(personalCaseProjection({ source: low + '-brief.md' }), personalCaseProjection({ source: low + '-brief.txt' }));
  const sources = [{ path: '<root>/home/prefs', physical_path: null, sha256: null },
    { path: '<forge>/prefs', physical_path: '<forge>/prefs', sha256: 'one' }];
  assert.deepStrictEqual(personalCaseProjection({ resolution_sources: sources }),
    personalCaseProjection({ resolution_sources: sources.slice().reverse() }));
  assert.notDeepStrictEqual(personalCaseProjection({ resolution_sources: sources }),
    personalCaseProjection({ resolution_sources: [sources[0], { ...sources[1], sha256: 'changed' }] }));
  assert.notDeepStrictEqual(personalCaseProjection({ resolution_sources: sources }),
    personalCaseProjection({ resolution_sources: sources.slice(1) }));
  assert.notDeepStrictEqual(personalCaseProjection({ other: sources }),
    personalCaseProjection({ other: sources.slice().reverse() }));
  const normalize = normalizer([]), fingerprint = require('./forge-unit-sidecar').artifactFingerprint;
  const windowsRequest = { resolution_sources: sources }, posixRequest = { resolution_sources: sources.slice().reverse() };
  assert.notStrictEqual(fingerprint(windowsRequest), fingerprint(posixRequest), 'control: raw provenance order changes the real fingerprint');
  assert.deepStrictEqual(normalize(posixRequest), windowsRequest, 'normalization retains the historical Windows order');
  assert.strictEqual(fingerprint(normalize(windowsRequest)), fingerprint(normalize(posixRequest)),
    'source order must normalize before deriving the real artifact fingerprint');
  assert.notStrictEqual(fingerprint(normalize(windowsRequest)),
    fingerprint(normalize({ resolution_sources: [sources[0], { ...sources[1], sha256: 'changed' }] })));
  assert.notStrictEqual(fingerprint(normalize(windowsRequest)), fingerprint(normalize({ resolution_sources: sources.slice(1) })));
  process.stdout.write('ok - integrated-R39-personal-path-case-projection\n');
}
async function main(argv = process.argv.slice(2), io = process) {
  if (argv.includes('--capture-baseline')) {
    const result = await captureBaseline();
    io.stdout.write(JSON.stringify({ status: result.status, trace_sha256: result.trace_sha256 }) + '\n');
    return 0;
  }
  if (argv.length) { io.stdout.write('Uso: node scripts/forge-linked-task-parity.test.js [--capture-baseline]\n'); return 2; }
  await captureUtilityChecks();
  io.stdout.write('ok - T01 capture: initializer guards base provenance and never overwrites\n');
  await parityCheck();
  io.stdout.write('ok - T01 parity: four phases both hosts and standalone boundaries match the owner baseline\n');
  return 0;
}

module.exports = { FIXTURE, BASE_REVISION, CLOCK, OWNER_SOURCES, CAPTURE_GUARDS, PHASES, HOSTS, METHOD,
  divergentSources, normalizer, computeTrace, baselineDocument, validateDocument, readDocument, captureBaseline, main };
if (require.main === module) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write('not ok - ' + (error.code || 'parity-failed') + ': ' + error.message + '\n');
    process.exitCode = 1;
  });
}
