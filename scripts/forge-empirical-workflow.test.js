#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { initCollection, collectCorpus } = require('./forge-empirical-collect');
const { caseIdentity } = require('./forge-empirical-corpus');
const { freezeCorpus, verifyFreeze, prepareFreeze, cli: freezeCli } = require('./forge-empirical-freeze');
const { auditPublication, cli: auditCli } = require('./forge-empirical-audit');
const { fingerprint, sha256 } = require('./forge-delivery');
const fixture = require('./fixtures/empirical-corpus/workflow/cases.json');
const base = require('./fixtures/empirical-corpus/contract/cases.json').cases[0].corpus;
let assertions = 0;
const check = (v, label) => { assert.ok(v, label); assertions++; console.log(`ok ${assertions} - ${label}`); };
const rejects = (fn, code) => { assert.throws(fn, (e) => e.code === code, code); assertions++; console.log(`ok ${assertions} - refuses ${code}`); };
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'empirical-workflow-'));
const owner = path.join(root, 'owner'); const source = path.join(root, 'source'); const publicCode = path.join(root, 'public');
const milestone = 'M-20260101120000-workflow';
const evidence = path.join(owner, '.gsd', 'milestones', milestone, 'evidence');
const codeDir = path.resolve(__dirname, '..');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
try {
  fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(source); fs.mkdirSync(publicCode);
  fs.writeFileSync(path.join(owner, '.gsd', 'PROJECT.md'), '# Fictional project');
  const catalog = structuredClone(base); catalog.candidates = []; catalog.references = [];
  catalog.exposure_registry = []; catalog.split_policy = { unit: 'family', seed: fixture.seed, reserved_families: [] };
  const captures = []; const observationRefs = [];
  for (const [index, row] of fixture.cases.entries()) {
    const candidate = structuredClone(base.candidates[0]);
    candidate.unit.id = `T-2026010112000${index}-fictional-workflow`;
    candidate.delivery_key = row.id; candidate.family_key = row.id; Object.assign(candidate, caseIdentity(candidate));
    candidate.refs = []; candidate.claims = [];
    for (const metric of Object.values(candidate.metrics)) Object.assign(metric, { state: 'unknown', value: null, refs: [] });
    for (const [r, role] of ['prework', 'grader/criteria', 'grader/expected', 'grader/final-code'].entries()) {
      const id = `r${index}-${r}`;
      const bytes = r === 2 ? JSON.stringify({ schema_version: 1, case_id: candidate.case_id, observations: [
        { kind: 'functional', id: 'function', value: true, check_id: 'f1' },
        { kind: 'tests', id: 'tests', passed: true, checks: [{ id: 't1', exit_code: 0 }] },
        { kind: 'uat', id: 'uat', value: true, check_id: 'u1' }
      ] }) : `Fictional ${row.id} ${role} content for owned synthetic workflow.\n`;
      fs.writeFileSync(path.join(source, `${id}.txt`), bytes);
      catalog.references.push({ id, role, region: r === 0 ? 'prework' : 'grader', origin: 'fictional', lineage: ['synthetic-fixture'], state: 'missing' });
      captures.push({ id, root: 'fixture', path: `${id}.txt`, type: 'local', format: 'raw', ref_id: id }); candidate.refs.push(id);
      if (r === 2 && row.exposed) observationRefs.push(id);
    }
    candidate.stratum = { value: row.stratum, refs: row.stratum === 'unknown' ? [] : [candidate.refs[2]] };
    candidate.type = { value: 'synthetic', refs: [candidate.refs[0]] };
    catalog.candidates.push(candidate);
    if (row.exposed) catalog.exposure_registry.push({ family_id: candidate.family_id, refs: [candidate.refs[0]], purpose: 'synthetic adjustment', captured_at: catalog.captured_at });
  }
  const trusted = { owner, milestone, capability: 'offline', roots: [{ id: 'fixture', path: source }] };
  const manifest = initCollection({ catalog, captures, freeze_id: 'workflow-v1', reserved_count: 2 }, trusted);
  const collection = collectCorpus(manifest, trusted);
  const collectionFile = path.join(collection.private_root, 'collection.json');
  const observed = json(path.join(collection.private_root, 'catalog.json'));
  const selected = json(path.join(collection.private_root, 'selection.json'));
  const protocol = path.join(evidence, 'protocol.md'); fs.writeFileSync(protocol, 'Synthetic prospective protocol registered before new enrollments; no empirical acceptance.');
  const inputs = observed.candidates.filter((c) => selected.split.adjustment.includes(c.family_id)).map((c) => {
    const ref = observed.references.find((r) => r.id === c.refs[0]);
    return { graph: { schema_version: 1, case_id: c.case_id, version: c.version, entries: ['entry'],
      nodes: [{ id: 'entry', ref_id: ref.id, kind: 'prework', dependencies: [] }] },
    provenance: { before: '2026-02-01T00:00:00Z', prework: [{ ref_id: ref.id, sha256: ref.sha256,
      available_at: '2026-01-01T00:00:00Z', evidence: 'synthetic assertion bound to exact digest' }] } };
  });
  const options = { owner, milestone, codeDir, collection: collectionFile, protocol, revision: 'diagnostic-v1', mode: 'diagnostic', synthetic: true };
  const diagnostic = freezeCorpus(options);
  check(diagnostic.passed && !diagnostic.comparative_ready && diagnostic.gaps.includes('agent_input_unverified'), 'diagnostic preserves missing inputs and metrics');
  const freezeFile = path.join(evidence, 'freeze-diagnostic-v1', 'freeze.json');
  const before = fs.readFileSync(freezeFile);
  check(verifyFreeze({ ...options, freezeFile }).baseline_digest === diagnostic.baseline_digest, 'readonly regeneration keeps semantic baseline digest');
  check(before.equals(fs.readFileSync(freezeFile)), 'verify leaves exact frozen bytes unchanged');
  rejects(() => freezeCorpus(options), 'snapshot_exists');
  rejects(() => freezeCorpus({ ...options, mode: 'comparative', revision: 'missing' }), 'comparative_readiness_failed');
  check(!fs.existsSync(path.join(evidence, 'freeze-missing')), 'failed readiness publishes nothing');
  const complete = { ...options, mode: 'comparative', revision: 'comparative-v1', inputs, observationRefs };
  check(freezeCorpus(complete).comparative_ready, 'full synthetic pipeline init collect view baseline freeze');
  check(verifyFreeze({ ...options, freezeFile: path.join(evidence, 'freeze-comparative-v1', 'freeze.json') }).passed, 'comparative replay revalidates graphs and metrics');
  check(freezeCorpus({ ...options, revision: 'diagnostic-v2' }).baseline_digest === diagnostic.baseline_digest, 'second generation retains semantic digest');
  const multi = structuredClone(manifest);
  const version2 = structuredClone(multi.catalog.candidates[0]); version2.version = 'v2'; version2.reopened = true;
  const ref2 = { ...multi.catalog.references.find((r) => r.id === version2.refs[3]), id: 'revision-two' };
  multi.catalog.references.push(ref2); version2.refs[3] = ref2.id; multi.catalog.candidates.push(version2);
  fs.writeFileSync(path.join(source, 'revision-two.txt'), 'Synthetic version two final code.');
  multi.captures.push({ ...captures[3], id: ref2.id, ref_id: ref2.id, path: 'revision-two.txt' });
  const multiCollection = collectCorpus(multi, trusted);
  const multiOptions = { ...options, collection: path.join(multiCollection.private_root, 'collection.json'), revision: 'multiversion' };
  const multiFreeze = freezeCorpus(multiOptions);
  const multiBaseline = json(path.join(evidence, 'freeze-multiversion/baseline/BASELINE.json'));
  const multiCoverage = json(path.join(evidence, 'freeze-multiversion/coverage-map.json'));
  check(multiBaseline.cases.length === selected.split.adjustment.length + 1 && new Set(multiBaseline.cases.map((r) => r.id)).size === multiBaseline.cases.length, 'multiversion freeze preserves distinct baseline rows');
  check(multiBaseline.coverage.tests.denominator === selected.split.adjustment.length, 'multiversion denominator remains deliveries');
  check(multiCoverage.cases.filter((r) => r.case_id === version2.case_id).map((r) => r.version).sort().join() === 'v1,v2', 'coverage retains both versions');
  check(verifyFreeze({ ...multiOptions, freezeFile: path.join(evidence, 'freeze-multiversion/freeze.json') }).baseline_digest === multiFreeze.baseline_digest, 'multiversion freeze regenerates');
  const runtimeCopy = path.join(root, 'runtime-copy'); fs.mkdirSync(runtimeCopy);
  for (const row of json(freezeFile).inventory.filter((r) => r.region === 'code')) {
    const target = path.join(runtimeCopy, row.path); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(codeDir, row.path), target);
  }
  const childFreeze = (op, opts) => {
    const child = spawnSync(process.execPath, ['-e', `try { console.log(JSON.stringify(require('./scripts/forge-empirical-freeze')[${JSON.stringify(op)}](${JSON.stringify(opts)}))); } catch (e) { console.log(JSON.stringify({ error: e.code })); }`],
      { cwd: runtimeCopy, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  };
  const copiedOptions = { ...options, codeDir: runtimeCopy, revision: 'runtime-copy' };
  check(childFreeze('freezeCorpus', copiedOptions).passed, 'valid independent runtime/worktree freezes with its own code root');
  const copiedVerify = { ...copiedOptions, freezeFile: path.join(evidence, 'freeze-runtime-copy/freeze.json') };
  check(childFreeze('verifyFreeze', copiedVerify).passed, 'valid worktree runtime verifies');
  rejects(() => verifyFreeze(copiedVerify), 'freeze_code_root_mismatch');
  for (const dependency of ['forge-empirical-corpus.js', 'forge-delivery.js', 'forge-autonomy-sources.js']) {
    const file = path.join(runtimeCopy, 'scripts', dependency); const originalCode = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// Synthetic dependency drift without output changes.\n');
    check(childFreeze('verifyFreeze', copiedVerify).error === 'freeze_drift', `${dependency} drift refused by default inventory`);
    fs.writeFileSync(file, originalCode);
  }
  const leak = structuredClone(inputs); leak[0].graph.nodes[0].dependencies = ['leak'];
  leak[0].graph.nodes.push({ id: 'leak', ref_id: observed.candidates[0].refs[2], kind: 'memory', dependencies: [] });
  rejects(() => freezeCorpus({ ...complete, revision: 'leak', inputs: leak }), 'reference_not_prework');
  const reserved = observed.candidates.find((c) => selected.split.reserved.includes(c.family_id));
  const reused = structuredClone(inputs); reused[0].graph.case_id = reserved.case_id;
  rejects(() => freezeCorpus({ ...complete, revision: 'reserved', inputs: reused }), 'reserved_case');
  const observationPath = path.join(evidence, observed.references.find((r) => r.id === observationRefs[0]).path);
  const observationBytes = fs.readFileSync(observationPath);
  // Recollect modified fixture bytes so integrity passes and missing UAT is the discriminator.
  const sourceObservation = path.join(source, `${observationRefs[0]}.txt`);
  const sourceBytes = fs.readFileSync(sourceObservation); const missingUat = JSON.parse(sourceBytes);
  missingUat.observations = missingUat.observations.filter((o) => o.kind !== 'uat'); write(sourceObservation, missingUat);
  const missingCollection = collectCorpus(manifest, trusted);
  rejects(() => freezeCorpus({ ...complete, revision: 'missing-uat', collection: path.join(missingCollection.private_root, 'collection.json') }), 'comparative_readiness_failed');
  fs.writeFileSync(sourceObservation, sourceBytes);
  check(observationBytes.equals(fs.readFileSync(observationPath)), 'new capture does not overwrite prior source snapshot');
  const snapshot = path.join(evidence, observed.references[0].path); const original = fs.readFileSync(snapshot);
  fs.appendFileSync(snapshot, 'changed'); rejects(() => verifyFreeze({ ...options, freezeFile }), 'snapshot_changed'); fs.writeFileSync(snapshot, original);
  const collectionBytes = fs.readFileSync(collectionFile); const changed = json(collectionFile); changed.captures[0].metadata.snapshot = changed.captures[1].metadata.snapshot;
  write(collectionFile, changed); rejects(() => prepareFreeze(options), 'capture_reference_changed'); fs.writeFileSync(collectionFile, collectionBytes);
  const catalogFile = path.join(collection.private_root, 'catalog.json'); const catalogBytes = fs.readFileSync(catalogFile);
  const mutateCatalog = (mutate, code) => {
    const copy = json(catalogFile); mutate(copy); write(catalogFile, copy);
    const record = json(collectionFile); record.documents.catalog = fingerprint(copy); write(collectionFile, record);
    rejects(() => freezeCorpus({ ...complete, revision: 'invalid' }), code);
    fs.writeFileSync(catalogFile, catalogBytes); fs.writeFileSync(collectionFile, collectionBytes);
  };
  mutateCatalog((c) => { c.candidates[0].result.passed = false; }, 'corpus_invalid');
  mutateCatalog((c) => { c.references[1].state = 'missing'; }, 'comparative_readiness_failed');
  mutateCatalog((c) => { c.candidates = c.candidates.slice(1); c.exposure_registry = c.exposure_registry.slice(1); }, 'split_frozen');
  const baselinePath = path.join(evidence, 'freeze-diagnostic-v1', 'baseline', 'BASELINE.json'); const baselineBytes = fs.readFileSync(baselinePath);
  fs.appendFileSync(baselinePath, ' '); rejects(() => verifyFreeze({ ...options, freezeFile }), 'freeze_output_changed'); fs.writeFileSync(baselinePath, baselineBytes);
  check(freezeCli(['--verify', '--owner', owner, '--milestone', milestone, '--code-dir', codeDir, '--freeze-file', freezeFile, '--json']).passed, 'owner verify CLI');
  for (const repo of [owner, publicCode]) {
    git(repo, ['init', '-q']); fs.writeFileSync(path.join(repo, '.gitignore'), '.gsd/\n');
    git(repo, ['add', '.gitignore']); git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic baseline']);
  }
  fs.writeFileSync(path.join(publicCode, 'public.js'), "'use strict';\nmodule.exports = 1;\n");
  const privateName = path.relative(owner, snapshot).split(path.sep).join('/');
  const auditManifest = { schema_version: 1, public_paths: ['public.js'], private_paths: [privateName], sentinels: [], fragments: [] };
  const auditTrusted = { owner, milestone, codeDir: publicCode };
  check(auditPublication(auditManifest, auditTrusted).passed, 'audit checks explicit untracked code and owner ignored evidence across roots');
  git(publicCode, ['add', 'public.js']);
  check(auditPublication(auditManifest, auditTrusted).public[0].tracked, 'audit includes staged tracked public files');
  const cleanPublic = fs.readFileSync(path.join(publicCode, 'public.js'));
  fs.writeFileSync(path.join(publicCode, 'public.js'), original); git(publicCode, ['add', 'public.js']);
  fs.writeFileSync(path.join(publicCode, 'public.js'), cleanPublic);
  check(auditPublication(auditManifest, auditTrusted).findings.some((f) => f.surface === 'staged_diff'), 'staged-only leak remains visible behind clean working copy');
  for (const binary of ['nul', 'attributes']) {
    fs.writeFileSync(path.join(publicCode, '.gitattributes'), binary === 'attributes' ? 'public.js binary\n' : '');
    const stagedBytes = Buffer.concat([Buffer.from(binary === 'nul' ? '\0' : ''), original]);
    fs.writeFileSync(path.join(publicCode, 'public.js'), stagedBytes); git(publicCode, ['add', 'public.js']);
    fs.writeFileSync(path.join(publicCode, 'public.js'), cleanPublic);
    const result = auditPublication(auditManifest, auditTrusted);
    check(!result.passed && result.findings.some((f) => f.surface === 'index_blob' && f.code === 'private_content_exposed'), `${binary} index blob scanned behind clean worktree`);
    check(result.public[0].staged.sha256 === sha256(stagedBytes), 'exact staged bytes retain identity');
  }
  rejects(() => auditPublication(auditManifest, { ...auditTrusted, runner: (bin, args, opts) => {
    const result = spawnSync(bin, args, opts);
    if (args.includes('cat-file') && args.includes('-s')) result.stdout = String(2 * 1024 * 1024 + 1);
    return result;
  } }), 'audit_index_blob_too_large');
  let indexQueries = 0;
  rejects(() => auditPublication(auditManifest, { ...auditTrusted, runner: (bin, args, opts) => {
    const result = spawnSync(bin, args, opts);
    if (args.includes('--stage') && ++indexQueries === 2) result.stdout = '';
    return result;
  } }), 'audit_index_changed');
  fs.writeFileSync(path.join(publicCode, '.gitattributes'), '');
  git(publicCode, ['add', 'public.js']);
  fs.writeFileSync(path.join(publicCode, 'public.js'), ['api', '_key', ' = ', 'fictional-sensitive-value-12345'].join(''));
  check(auditPublication(auditManifest, auditTrusted).findings.some((f) => f.code === 'sensitive_public_content'), 'credential marker refused without echo');
  const reviewedBytes = fs.readFileSync(path.join(publicCode, 'public.js'));
  const reviewedManifest = { ...auditManifest, reviewed_synthetic: [{ public_index: 0, sha256: sha256(reviewedBytes), reason: 'reviewed_synthetic_negative_fixture' }] };
  // Commit only this synthetic fixture so the reviewed file has no diff surface.
  git(publicCode, ['add', 'public.js']);
  git(publicCode, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'reviewed synthetic marker']);
  const reviewed = auditPublication(reviewedManifest, auditTrusted);
  check(reviewed.passed && reviewed.reviewed_findings.length === 2 &&
    reviewed.reviewed_findings.some((f) => f.surface === 'index_blob'), 'exact caller-reviewed synthetic bytes retain visible reviewed finding');
  fs.appendFileSync(path.join(publicCode, 'public.js'), '\nchanged');
  rejects(() => auditPublication(reviewedManifest, auditTrusted), 'audit_review_changed');
  fs.writeFileSync(path.join(publicCode, 'public.js'), reviewedBytes);
  fs.appendFileSync(path.join(publicCode, 'public.js'), '\n' + original); git(publicCode, ['add', 'public.js']);
  fs.writeFileSync(path.join(publicCode, 'public.js'), reviewedBytes);
  check(!auditPublication(reviewedManifest, auditTrusted).passed, 'review cannot hide staged or working diff contents');
  git(publicCode, ['add', 'public.js']);
  const privateReview = { ...reviewedManifest, fragments: [reviewedBytes.toString()] };
  check(auditPublication(privateReview, auditTrusted).findings.some((f) => f.code === 'private_content_exposed'), 'review never suppresses private content exposure');
  // Return the synthetic repository to a clean harmless baseline.
  fs.writeFileSync(path.join(publicCode, 'public.js'), cleanPublic); git(publicCode, ['add', 'public.js']);
  git(publicCode, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'clean synthetic baseline']);
  fs.writeFileSync(path.join(publicCode, 'public.js'), cleanPublic);
  fs.writeFileSync(path.join(publicCode, 'public.js'), original);
  const leaking = auditPublication(auditManifest, auditTrusted);
  check(!leaking.passed && leaking.findings.some((f) => f.code === 'private_content_exposed'), 'bounded publication leak refuses acceptance');
  check(!JSON.stringify(leaking).includes(original.toString().trim()) && !JSON.stringify(leaking).includes(owner), 'audit findings never echo private bytes or paths');
  fs.writeFileSync(path.join(publicCode, 'public.js'), "'use strict';\nmodule.exports = 1;\n");
  git(owner, ['add', '-f', '--', privateName]);
  check(auditPublication(auditManifest, auditTrusted).findings.some((f) => f.code === 'private_file_tracked'), 'private tracked evidence refuses audit even when ignored');
  git(owner, ['rm', '--cached', '--', privateName]);
  rejects(() => auditPublication(auditManifest, { ...auditTrusted, runner: () => ({ status: 2, stdout: 'sensitive diagnostic' }) }), 'audit_command_failed');
  rejects(() => auditPublication({ ...auditManifest, private_paths: ['public.js'] }, auditTrusted), 'audit_private_path_outside_evidence');
  rejects(() => auditPublication({ ...auditManifest, public_paths: [privateName] }, auditTrusted), 'audit_private_path_public');
  const auditFile = path.join(evidence, 'audit-manifest.json'); write(auditFile, auditManifest);
  check(auditCli(['--owner', owner, '--milestone', milestone, '--code-dir', publicCode, '--manifest', auditFile, '--json']).passed, 'owner audit CLI sanitized result');
  check(fs.readFileSync(path.join(owner, '.gitignore'), 'utf8') === '.gsd/\n' && original.equals(fs.readFileSync(snapshot)), 'audit does not alter ignores or private evidence');
  check(sha256(before) === sha256(fs.readFileSync(freezeFile)), 'negative probes preserve original successful freeze');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`empirical-workflow: ${assertions} assertions passed; synthetic only, no provider execution or human UAT`);
