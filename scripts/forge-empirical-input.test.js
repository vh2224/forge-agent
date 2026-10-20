#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateInputGraph, buildAgentView, createSplit, materializeViews } = require('./forge-empirical-input');
const { validateCorpus, caseIdentity } = require('./forge-empirical-corpus');
const { sha256 } = require('./forge-delivery');
const { renderPrompt } = require('./forge-prompt');
const { captureFinal } = require('./forge-attempt-telemetry');
const fixture = require('./fixtures/empirical-corpus/isolation/cases.json');
const tempParent = fs.realpathSync.native(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, 'forge-input-'));
let passed = 0;
let assertions = 0;
function check(value, message) { assertions++; assert.ok(value, message); }
function rejects(fn, code) { assertions++; assert.throws(fn, (error) => error.code === code, code); }
function test(name, fn) { fn(); passed++; process.stdout.write(`ok - ${name}\n`); }

function setup() {
  const area = fs.mkdtempSync(path.join(root, 'case-'));
  const sourceRoot = path.join(area, 'sources');
  const agentRoot = path.join(area, 'agent');
  const graderRoot = path.join(area, 'private');
  for (const dir of [sourceRoot, agentRoot, graderRoot]) fs.mkdirSync(dir);
  const corpus = structuredClone(fixture.corpus);
  corpus.references = fixture.blobs.map((blob) => {
    const file = path.join(sourceRoot, blob.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, blob.text);
    return { id: blob.id, role: blob.role, region: blob.role.startsWith('grader/') ? 'grader' : blob.role,
      origin: 'fictional-project', lineage: ['synthetic-prework-archive'], state: 'observed',
      path: blob.path, bytes: Buffer.byteLength(blob.text), sha256: sha256(Buffer.from(blob.text)),
      captured_at: corpus.captured_at, temporal_source: 'synthetic reviewed archive' };
  });
  const prototype = structuredClone(corpus.candidates[0]);
  corpus.candidates = [...fixture.seed_families, ...fixture.new_families].map((family, index) => {
    const candidate = structuredClone(prototype);
    candidate.family_key = family; candidate.delivery_key = family;
    Object.assign(candidate, caseIdentity(candidate));
    if (index) {
      const ref = { ...corpus.references[0], id: `before-${index}`, path: `prework/request-${index}.txt` };
      corpus.references.push(ref);
      fs.copyFileSync(path.join(sourceRoot, corpus.references[0].path), path.join(sourceRoot, ref.path));
      candidate.refs[0] = ref.id;
    }
    return candidate;
  });
  corpus.exposure_registry = corpus.candidates.slice(0, 6).map((c) => ({ family_id: c.family_id,
    refs: [c.refs[0]], purpose: 'already discussed synthetic seed', captured_at: corpus.captured_at }));
  check(validateCorpus(corpus).valid, 'synthetic catalog validates via T01');
  const manifest = { schema_version: 1, case_id: corpus.candidates[0].case_id, version: 'v1', entries: ['before'],
    nodes: fixture.blobs.filter((b) => b.role === 'prework').map((b) => ({ id: b.id,
      ref_id: b.id, kind: b.kind, dependencies: [...b.dependencies] })) };
  const trusted = { sourceRoot, agentRoot, graderRoot, before: corpus.captured_at,
    prework: corpus.references.filter((r) => r.role === 'prework').map((r) => ({ ref_id: r.id, sha256: r.sha256,
      available_at: corpus.captured_at, evidence: 'synthetic reviewed historical revision 1' })),
    split: createSplit(corpus, { freezeId: 'freeze-one', reservedCount: 2 }), graderRefs: ['criteria', 'expected', 'final'] };
  return { corpus, manifest, trusted };
}
function build(s) { return buildAgentView(s.corpus, s.manifest, s.trusted); }
function graph(s) { return validateInputGraph(s.corpus, s.manifest, s.trusted); }
function changeBytes(s, id, text) {
  const ref = s.corpus.references.find((r) => r.id === id);
  fs.writeFileSync(path.join(s.trusted.sourceRoot, ref.path), text);
  ref.bytes = Buffer.byteLength(text); ref.sha256 = sha256(Buffer.from(text));
  const provenance = s.trusted.prework.find((r) => r.ref_id === id);
  if (provenance) provenance.sha256 = ref.sha256;
}

try {
  test('actual renderPrompt/captureFinal bytes exclude all private sentinels and paths', () => {
    const s = setup();
    const views = materializeViews(s.corpus, s.manifest, s.trusted);
    const agent = views.agent;
    const templateDir = path.join(agent.root, 'templates'); fs.mkdirSync(templateDir);
    fs.writeFileSync(path.join(templateDir, 'execute-task.md'), '{description}\n{TOP_MEMORIES}\n{LEDGER}\n');
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'forge-agent-prefs.jsonc'), '{}');
    const priorForge = process.env.FORGE_HOME;
    process.env.FORGE_HOME = profile;
    const originalRead = fs.readFileSync;
    const reads = []; const forbiddenReads = [];
    fs.readFileSync = function (file, ...args) {
      reads.push(String(file));
      if (path.isAbsolute(String(file)) && (String(file).startsWith(s.trusted.graderRoot) ||
          String(file).startsWith(s.trusted.sourceRoot) || ['.forge-agent', '.claude', '.codex'].some((name) =>
            String(file).startsWith(path.join(os.homedir(), name))))) {
        forbiddenReads.push(String(file)); throw new Error('unexpected private enrichment read');
      }
      return originalRead.call(this, file, ...args);
    };
    try {
      const channel = (kind) => agent.files.filter((f) => f.kind === kind).map((f) => f.text).join('\n');
      const base = { cwd: agent.root, codeDir: path.resolve(__dirname, '..'), templateDir, unitType: 'execute-task', milestoneId: 'M001',
        sliceId: 'S01', taskId: 'T01', autoCommit: false,
        description: `${channel('prework')}\n${channel('procedure')}` };
      let memories = 0; let ledgers = 0;
      const direct = renderPrompt({ ...base, memories: channel('memory'), ledger: channel('ledger') });
      const provided = renderPrompt({ ...base, memoryProvider: () => { memories++; return channel('memory'); },
        ledgerProvider: () => { ledgers++; return channel('ledger'); } });
      check(memories === 1 && ledgers === 1, 'real provider seams called');
      check(direct.prompt === provided.prompt, 'explicit and provider channels agree');
      check(provided.template_source === path.join(templateDir, 'execute-task.md'), 'no template fallback');
      for (const text of ['LEGIT_INPUT', 'LEGIT_MEMORY', 'LEGIT_PROCEDURE', 'LEGIT_LEDGER', 'LEGIT_SOURCE']) {
        check(provided.prompt.includes(text), `permitted ${text} survives`);
      }
      check(provided.prompt.includes('solution configuration'), 'legitimate similar text preserved');
      for (const blob of fixture.blobs.filter((b) => b.role !== 'prework')) {
        for (const value of [blob.text, blob.path, path.basename(blob.path)]) {
          check(!provided.prompt.includes(value), 'private body and reference absent from actual package');
          check(!JSON.stringify(agent).includes(value), 'agent envelope contains no private reference');
        }
      }
      const observed = captureFinal({ context: provided.prompt, request: { input: provided.prompt } });
      check(observed.context.bytes === Buffer.byteLength(provided.prompt), 'exact captured bytes');
      check(observed.context.sha256 === sha256(Buffer.from(provided.prompt)), 'exact captured digest');
      check(observed.provider_called === 'unknown', 'no false provider or token observation');
      check(reads.length > 0, 'read guard exercised');
      check(forbiddenReads.length === 0, 'no swallowed enrichment attempt reaches real profile or private region');
    } finally {
      fs.readFileSync = originalRead;
      if (priorForge === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = priorForge;
    }
    check(agent.profile.host_isolation === 'unverified', 'no filesystem sandbox claim');
    check(agent.profile.allowed_roots.join() === agent.root, 'only agent region in consumption profile');
    check(views.grader.files.length === 3 && fs.readFileSync(path.join(views.grader.root, views.grader.files[2]), 'utf8') === 'PRIVATE_FINAL_SENTINEL', 'grader separately materialized');
    for (const file of agent.files) check(sha256(fs.readFileSync(path.join(agent.root, file.name))) === file.sha256, 'materialized exact bytes');
  });
  test('graph is pure and agent output is deterministic without result blobs', () => {
    const s = setup(); const before = JSON.stringify(s);
    check(graph(s).nodes.length === 5, 'closed graph includes transitive source');
    check(JSON.stringify(s) === before, 'pure graph validation');
    const result = build(s);
    fs.unlinkSync(path.join(s.trusted.sourceRoot, 'grader/EXPECTED_PATH_SENTINEL.txt'));
    check(JSON.stringify(build(s)) === JSON.stringify(result), 'optional grader result not opened for agent');
  });
  for (const attack of fixture.attacks) test(attack.name, () => {
    const s = setup();
    if (attack.text) {
      changeBytes(s, attack.node, attack.text);
      rejects(() => build(s), 'private_reference_in_content');
    } else {
      s.manifest.nodes.find((n) => n.id === attack.node).dependencies.push(attack.dependency);
      s.manifest.nodes.push({ id: 'final', ref_id: 'final', kind: 'memory', dependencies: [] });
      rejects(() => build(s), 'reference_not_prework');
    }
  });
  test('unknown, missing, cyclic, duplicate, and unreachable references fail closed', () => {
    const unknown = setup(); unknown.manifest.nodes[1].dependencies.push('missing');
    rejects(() => build(unknown), 'reference_unknown');
    const missing = setup(); fs.unlinkSync(path.join(missing.trusted.sourceRoot, 'prework/source.txt'));
    rejects(() => build(missing), 'path_unreadable');
    const cyclic = setup(); cyclic.manifest.nodes.find((n) => n.id === 'source').dependencies.push('before');
    rejects(() => build(cyclic), 'reference_cycle');
    const duplicate = setup(); duplicate.manifest.nodes.push({ ...duplicate.manifest.nodes[0] });
    rejects(() => graph(duplicate), 'node_invalid');
    const extra = setup(); extra.manifest.nodes[0].dependencies = ['memory', 'procedure'];
    rejects(() => graph(extra), 'graph_unreachable');
  });
  test('postwork, absent provenance, role relabeling and imported authority are rejected', () => {
    const late = setup(); late.trusted.before = '2025-12-31T12:00:00Z';
    rejects(() => build(late), 'reference_not_prework');
    const absent = setup(); absent.trusted.prework = [];
    rejects(() => build(absent), 'reference_not_prework');
    const forged = setup(); forged.manifest.authorized = true;
    rejects(() => build(forged), 'unknown_fields');
    const relabel = setup(); relabel.manifest.nodes[1].ref_id = 'final';
    const ref = relabel.corpus.references.find((r) => r.id === 'final');
    ref.role = 'prework'; ref.region = 'prework';
    rejects(() => build(relabel), 'reference_not_prework');
  });
  test('historical availability is distinct from later collection time', () => {
    const s = setup();
    s.corpus.captured_at = '2026-02-01T12:00:00Z';
    for (const ref of s.corpus.references) ref.captured_at = s.corpus.captured_at;
    check(build(s).text.includes('LEGIT_MEMORY'), 'old prework collected later remains eligible');
    s.trusted.prework.find((r) => r.ref_id === 'memory').available_at = '2026-01-02T12:00:00Z';
    rejects(() => build(s), 'reference_not_prework');
    s.trusted.prework.find((r) => r.ref_id === 'memory').available_at = s.trusted.before;
    s.trusted.prework.find((r) => r.ref_id === 'memory').evidence = '';
    rejects(() => build(s), 'provenance_invalid');
  });
  test('hash drift after validation and during final revalidation is detected', () => {
    const s = setup(); graph(s);
    fs.writeFileSync(path.join(s.trusted.sourceRoot, 'prework/source.txt'), 'tampered');
    rejects(() => build(s), 'reference_changed');
    const race = setup(); const target = path.join(race.trusted.sourceRoot, 'prework/source.txt');
    const originalOpen = fs.openSync; let reads = 0;
    fs.openSync = function (file, flags, ...args) {
      if (file === target && flags === 'r' && ++reads === 2) fs.writeFileSync(target, 'changed after first read');
      return originalOpen.call(this, file, flags, ...args);
    };
    try { rejects(() => build(race), 'reference_changed'); }
    finally { fs.openSync = originalOpen; }
    check(reads === 2, 'final re-read exercised');
  });
  test('traversal, absolute/URI paths, aliases and private path labels cannot be materialized', () => {
    for (const name of ['../escape', '/escape', 'C:/private.txt', 'https://example.test/x', 'prework/../x', 'prework/x:stream']) {
      const s = setup(); s.corpus.references[0].path = name;
      rejects(() => build(s), 'path_invalid');
    }
    const alias = setup(); alias.corpus.references[1].path = alias.corpus.references[0].path.toUpperCase();
    rejects(() => build(alias), 'reference_alias');
    const named = setup(); named.corpus.references[0].path = 'grader/innocent.txt';
    rejects(() => build(named), 'private_path');
    const directory = setup(); const file = path.join(directory.trusted.sourceRoot, 'prework/source.txt');
    fs.unlinkSync(file); fs.mkdirSync(file);
    rejects(() => build(directory), 'source_not_file');
  });
  test('hard links and junction escapes are rejected', () => {
    const s = setup(); const file = path.join(s.trusted.sourceRoot, 'prework/source.txt');
    fs.linkSync(file, path.join(s.trusted.sourceRoot, 'alias.txt'));
    rejects(() => build(s), 'reference_alias');
    const junction = setup(); const privateDir = path.join(root, 'external'); fs.mkdirSync(privateDir);
    fs.symlinkSync(privateDir, path.join(junction.trusted.sourceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    junction.corpus.references[0].path = 'linked/file.txt';
    rejects(() => build(junction), 'path_link_or_special');
  });
  test('materialization requires distinct empty roots, explicit grader refs and exclusive files', () => {
    const s = setup(); s.trusted.agentRoot = s.trusted.sourceRoot;
    rejects(() => materializeViews(s.corpus, s.manifest, s.trusted), 'regions_overlap');
    const nested = setup(); nested.trusted.graderRoot = path.join(nested.trusted.agentRoot, 'nested'); fs.mkdirSync(nested.trusted.graderRoot);
    rejects(() => materializeViews(nested.corpus, nested.manifest, nested.trusted), 'regions_overlap');
    const existing = setup(); fs.writeFileSync(path.join(existing.trusted.agentRoot, 'existing'), 'user');
    rejects(() => materializeViews(existing.corpus, existing.manifest, existing.trusted), 'destination_not_empty');
    check(fs.readFileSync(path.join(existing.trusted.agentRoot, 'existing'), 'utf8') === 'user', 'preserved existing bytes');
    const bad = setup(); bad.trusted.graderRefs = ['reserved'];
    rejects(() => materializeViews(bad.corpus, bad.manifest, bad.trusted), 'grader_reference_invalid');
    check(fs.readdirSync(bad.trusted.agentRoot).length === 0, 'no publication before all reads validate');
  });
  test('six exposed seeds stay adjustment and family split ignores outcomes and order', () => {
    const s = setup(); const a = s.trusted.split;
    check(a.adjustment.length === 6 && a.reserved.length === 2, 'six seeds and two fresh reserved families');
    check(s.corpus.exposure_registry.every((e) => a.adjustment.includes(e.family_id)), 'all exposure respected');
    s.corpus.candidates.reverse(); s.corpus.references.reverse(); s.corpus.exposure_registry.reverse();
    s.corpus.candidates[0].metrics.functional.value = false;
    check(createSplit(s.corpus, { freezeId: 'freeze-one', reservedCount: 2, previous: a }).digest === a.digest, 'order/outcomes do not choose split');
  });
  test('reopenings share families, duplicate identities and frozen mutations are refused', () => {
    const s = setup(); const reopened = structuredClone(s.corpus.candidates[0]); reopened.version = 'v2'; reopened.reopened = true;
    s.corpus.candidates.push(reopened);
    const a = createSplit(s.corpus, { freezeId: 'with-reopening', reservedCount: 2 });
    check(a.adjustment.length === 6 && a.membership.length === 9, 'reopening cannot become ninth family');
    s.corpus.candidates.push(structuredClone(reopened));
    rejects(() => createSplit(s.corpus, { freezeId: 'duplicate', reservedCount: 2 }), 'corpus_invalid');
    const frozen = setup(); const previous = frozen.trusted.split;
    rejects(() => createSplit(frozen.corpus, { freezeId: 'freeze-one', reservedCount: 1, previous }), 'split_frozen');
    frozen.corpus.split_policy.seed = 'another-seed';
    rejects(() => createSplit(frozen.corpus, { freezeId: 'freeze-one', reservedCount: 2, previous }), 'split_frozen');
    previous.reserved.pop();
    rejects(() => createSplit(frozen.corpus, { freezeId: 'freeze-one', reservedCount: 2, previous }), 'freeze_invalid');
  });
  test('observed reserve requires new set/freeze and cannot be recycled as fresh', () => {
    const s = setup(); const previous = s.trusted.split;
    rejects(() => createSplit(s.corpus, { freezeId: 'freeze-two', reservedCount: 2, previous }), 'new_freeze_requires_exposure');
    for (const id of previous.reserved) s.corpus.exposure_registry.push({ family_id: id, refs: [], purpose: 'evaluated', captured_at: s.corpus.captured_at });
    rejects(() => createSplit(s.corpus, { freezeId: 'freeze-one', reservedCount: 0, previous }), 'split_frozen');
    rejects(() => createSplit(s.corpus, { freezeId: 'freeze-two', reservedCount: 2, previous }), 'reserved_insufficient');
  });
  test('new freeze persists unexposed adjustment exclusions and regenerates itself', () => {
    const s = setup(); s.corpus.candidates = s.corpus.candidates.slice(0, 4); s.corpus.exposure_registry = [];
    const previous = createSplit(s.corpus, { freezeId: 'unexposed-v1', reservedCount: 1 });
    for (const id of previous.reserved) s.corpus.exposure_registry.push({ family_id: id, refs: [], purpose: 'evaluated', captured_at: s.corpus.captured_at });
    const fresh = structuredClone(s.corpus.candidates[0]);
    fresh.unit.id = 'T-20260101120000-new-2'; fresh.delivery_key = 'new-2'; fresh.family_key = 'new-2';
    Object.assign(fresh, require('./forge-empirical-corpus').caseIdentity(fresh));
    fresh.refs = fresh.refs.map((id, i) => {
      const ref = { ...s.corpus.references.find((r) => r.id === id), id: `fresh-${i}`, path: `reserved/fresh-${i}.txt` };
      s.corpus.references.push(ref); return ref.id;
    });
    s.corpus.candidates.push(fresh);
    const next = createSplit(s.corpus, { freezeId: 'unexposed-v2', reservedCount: 1, previous });
    check(next.excluded_families.length === previous.adjustment.length, 'exclusion provenance persisted');
    check(next.reserved[0] === fresh.family_id, 'only fresh enrollment reserved');
    check(createSplit(s.corpus, { freezeId: next.freeze_id, reservedCount: 1, previous: next }).digest === next.digest, 'own freeze replay retains exclusions');
    s.trusted.split = next; build(s);
    check(true, 'input graph accepts regenerated new split');
  });
  test('reserved cases and their prework references never enter tuning package', () => {
    const s = setup(); const reserved = s.corpus.candidates.find((c) => s.trusted.split.reserved.includes(c.family_id));
    s.manifest.case_id = reserved.case_id;
    rejects(() => build(s), 'reserved_case');
    s.manifest.case_id = s.corpus.candidates[0].case_id;
    s.manifest.nodes[1].ref_id = reserved.refs[0];
    rejects(() => build(s), 'reference_not_prework');
  });
  process.stdout.write(`PASS ${passed} scenarios; ${assertions} assertions; synthetic composition only, host isolation unverified\n`);
} finally {
  // Only the absolute mkdtemp root owned by this suite is removed.
  if (path.dirname(root) !== tempParent || !path.basename(root).startsWith('forge-input-')) throw new Error('cleanup root invalid');
  fs.rmSync(root, { recursive: true, force: true });
}
