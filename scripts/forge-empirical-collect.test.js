#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { initCollection, collectCorpus, publicResult, validateCollectionInput, cli } = require('./forge-empirical-collect');
const { caseIdentity, validateCorpus } = require('./forge-empirical-corpus');
const { createSplit } = require('./forge-empirical-input');
const { sha256 } = require('./forge-delivery');
const fixture = require('./fixtures/empirical-corpus/collection/cases.json');
const base = require('./fixtures/empirical-corpus/contract/cases.json').cases[0].corpus;
let assertions = 0;
function check(value, message) { assertions++; assert.ok(value, message); }
function rejects(fn, code) { assertions++; assert.throws(fn, (e) => e.code === code, code); }
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'empirical-collect-'));
const owner = path.join(root, 'owner'); const source = path.join(root, 'source');
const milestone = 'M-20261019120000-synthetic-collection';
const evidence = path.join(owner, '.gsd', 'milestones', milestone, 'evidence');
fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(source);
fs.writeFileSync(path.join(owner, '.gsd', 'PROJECT.md'), '# Synthetic project\n');
try {
  const catalog = structuredClone(base);
  catalog.catalog_id = 'synthetic-collection'; catalog.candidates = []; catalog.references = [];
  catalog.exposure_registry = []; catalog.split_policy.seed = fixture.seed; catalog.split_policy.reserved_families = [];
  const captures = [];
  for (const [index, row] of [...fixture.seeds, ...fixture.reserved].entries()) {
    const c = structuredClone(base.candidates[0]);
    c.unit = { type: 'task', id: `T-2026010112000${index}-fictional-case` };
    c.delivery_key = row.id; c.family_key = row.family; Object.assign(c, caseIdentity(c));
    c.claims = [{ kind: 'declared_version', state: 'observed', value: 'fictional-1',
      refs: [`r${index}-0`], contemporaneous: true, limitations: [] },
    { kind: 'installation_complete', state: 'unknown', value: null, refs: [], contemporaneous: false, limitations: [] }];
    c.refs = [];
    for (const [j, role] of ['prework', 'grader/criteria', 'grader/expected', 'grader/final-code'].entries()) {
      const id = `r${index}-${j}`; const content = `fictional ${row.id} ${role}\n`;
      fs.writeFileSync(path.join(source, `${id}.txt`), content);
      catalog.references.push({ id, role, region: role === 'prework' ? 'prework' : 'grader', origin: 'fictional',
        lineage: ['synthetic-owned-fixture'], state: 'missing' });
      captures.push({ id, root: 'fixture', path: `${id}.txt`, type: 'local', format: 'raw', ref_id: id });
      c.refs.push(id);
    }
    c.stratum = { value: row.outcome || 'unknown', refs: row.outcome ? [c.refs[0]] : [] };
    c.type = { value: 'synthetic', refs: [c.refs[0]] };
    for (const m of Object.values(c.metrics)) Object.assign(m, { state: 'unknown', value: null, refs: [], limitations: [] });
    catalog.candidates.push(c);
    if (row.exposed) catalog.exposure_registry.push({ family_id: c.family_id, refs: [c.refs[0]],
      purpose: 'synthetic exposure before selection', captured_at: catalog.captured_at });
  }
  const input = { catalog, captures, freeze_id: 'synthetic-v1', reserved_count: 2 };
  let spawns = 0;
  const trusted = { owner, milestone, roots: [{ id: 'fixture', path: source }], capability: 'offline', runner: () => { spawns++; throw Error('unexpected'); } };
  check(validateCorpus(catalog).valid, 'synthetic catalog conforms before collection');
  const manifest = initCollection(input, trusted);
  const first = collectCorpus(manifest, trusted);
  check(first.ready && first.counts.candidates === 8 && first.counts.deliveries === 8, 'six seeds plus two new families captured');
  check(fs.readdirSync(source).length === captures.length && captures.every((c) => sha256(fs.readFileSync(path.join(source, c.path))) === first.captures.find((r) => r.id === c.id).metadata.sha256), 'source checkout bytes and inventory unchanged by collection');
  const selected = JSON.parse(fs.readFileSync(path.join(first.private_root, 'selection.json')));
  check(selected.candidates.slice(0, 6).every((r) => r.selection === 'included'), 'every seed accounted for');
  check(selected.split.reserved.length === 2 && selected.split.adjustment.length === 6, 'exposed seeds never reserved');
  check(first.captures.filter((r) => r.id.startsWith('r6-') || r.id.startsWith('r7-')).every((r) => r.metadata.snapshot.includes('/reserved/')), 'reserved families physically separated before outcomes read');
  const observed = JSON.parse(fs.readFileSync(path.join(first.private_root, 'catalog.json')));
  const graph = { schema_version: 1, case_id: observed.candidates[0].case_id, version: observed.candidates[0].version,
    entries: ['request'], nodes: [{ id: 'request', ref_id: 'r0-0', kind: 'prework', dependencies: [] }] };
  check(validateCollectionInput(observed, graph, { split: selected.split, before: '2027-01-01T00:00:00Z',
    prework: [{ ref_id: 'r0-0', sha256: observed.references[0].sha256, available_at: '2026-01-01T00:00:00Z', evidence: 'synthetic revision observation' }] }).nodes.length === 1, 'T03 graph validation composes');
  const provenance = JSON.parse(fs.readFileSync(path.join(first.private_root, 'provenance.json')));
  check(provenance[0].claims.declared_version.state === 'observed' && provenance[0].claims.installation_complete.state === 'unknown', 'contemporaneous declaration does not imply installation');
  const again = collectCorpus(manifest, trusted);
  check(again.replay && again.identity === first.identity, 'identical replay reuses immutable published snapshots');
  fs.appendFileSync(path.join(source, 'r0-0.txt'), 'changed');
  const changed = collectCorpus(manifest, trusted);
  check(changed.identity !== first.identity && !changed.replay, 'source change creates new capture');
  check(sha256(fs.readFileSync(path.join(evidence, first.captures[0].metadata.snapshot))) === first.captures[0].metadata.sha256, 'original snapshot unchanged');
  fs.unlinkSync(path.join(source, 'r1-0.txt'));
  const partial = collectCorpus(manifest, trusted);
  const partialCatalog = JSON.parse(fs.readFileSync(path.join(partial.private_root, 'catalog.json')));
  check(!partial.ready && partialCatalog.candidates[1].selection === 'insufficient' && partialCatalog.candidates[0].selection === 'included', 'missing source preserves others and makes gap explicit');
  check(partialCatalog.candidates[1].claims[0].state === 'unknown', 'failed source cannot leave imported observed declaration');
  const duplicate = structuredClone(manifest); duplicate.catalog.candidates.push({ ...duplicate.catalog.candidates[0], version: 'reopened-v2', reopened: true });
  const deduped = collectCorpus(duplicate, trusted);
  check(deduped.counts.candidates === 9 && deduped.counts.deliveries === 8, 'reopening does not inflate delivery count');
  rejects(() => initCollection({ ...manifest, command: 'svn update' }, trusted), 'unknown_fields');
  const injection = structuredClone(manifest); injection.captures[0].path = '../escape';
  rejects(() => initCollection(injection, trusted), 'path_invalid');
  rejects(() => initCollection(manifest, { ...trusted, roots: [{ id: 'other', path: source }] }), 'source_invalid');
  rejects(() => initCollection(manifest, { ...trusted, limits: { commands: 1000 } }), 'limit_invalid');
  const svn = structuredClone(manifest); svn.captures = [
    { id: 'info', root: 'fixture', path: 'history.txt', type: 'svn', format: 'raw', request: { operation: 'info' } },
    { id: 'historic', root: 'fixture', path: 'history.txt', type: 'svn', format: 'raw', ref_id: 'r0-0', request: { operation: 'cat', revision: '101', peg: '101' } }];
  const svnTrusted = { ...trusted, roots: [{ id: 'fixture', path: source, repository: 'https://example.invalid/repository', subtree: 'https://example.invalid/repository/subtree' }], runner: (_exe, args) => {
    spawns++;
    return { status: 0, stdout: Buffer.from(args[0] === 'info' ? '<info><entry revision="102"><url>https://example.invalid/repository/subtree</url><repository><root>https://example.invalid/repository</root></repository></entry></info>' : 'historical before removal\n'), stderr: Buffer.alloc(0) };
  } };
  const offline = collectCorpus(svn, svnTrusted);
  check(spawns === 1 && offline.captures[1].reason === 'network_capability_required', 'offline starts only local info, no historical network spawn');
  const online = collectCorpus(svn, { ...svnTrusted, capability: 'networked' });
  check(online.captures[1].metadata.revision === '101' && online.captures[1].metadata.peg === '101', 'numeric historical source before synthetic removal');
  const removal = structuredClone(svn);
  removal.captures[1].request = { operation: 'log', revision: '102', peg: '101', endRevision: '101' };
  const removalResult = collectCorpus(removal, { ...svnTrusted, capability: 'networked', runner: (exe, args, opts) => args[0] === 'info' ? svnTrusted.runner(exe, args, opts) :
    { status: 0, stdout: Buffer.from('<log><logentry revision="102"><author>fixture</author><date>2026-01-02T12:00:00Z</date><paths><path action="D">/subtree/history.txt</path></paths><msg>synthetic removal</msg></logentry></log>'), stderr: Buffer.alloc(0) } });
  check(removalResult.captures[1].metadata.entries === 1 && removalResult.captures[1].metadata.removal_cause === 'unknown', 'numeric log documents removal without attributing cause');
  const bad = structuredClone(svn); bad.captures[1].request.flags = ['--username', 'x'];
  rejects(() => initCollection(bad, svnTrusted), 'unknown_fields');
  bad.captures[1].request = { operation: 'cat', revision: '--config-dir', peg: '101' };
  rejects(() => initCollection(bad, svnTrusted), 'svn_revision_invalid');
  const truncated = collectCorpus(svn, { ...svnTrusted, capability: 'networked', runner: () => ({ status: 0, error: { code: 'ENOBUFS' }, stdout: Buffer.from('partial') }) });
  check(truncated.captures.every((r) => r.status === 'insufficient'), 'partial process output never becomes evidence');
  const summary = JSON.stringify(publicResult(online));
  check(!summary.includes(owner) && !summary.includes('historical before') && !summary.includes('repository'), 'public diagnostics omit private data');
  const config = path.join(evidence, 'config.json'); fs.writeFileSync(config, JSON.stringify(input));
  const manifestPath = path.join(evidence, 'manifest.json');
  const args = ['--owner', owner, '--milestone', milestone, '--root', `fixture=${source}`, '--capability', 'offline'];
  check(cli(['--init', '--input', config, '--manifest', manifestPath, ...args]).initialized, 'CLI init private manifest');
  check(cli(['--collect', '--manifest', manifestPath, ...args]).counts.candidates === 8, 'CLI collect pipeline');
  rejects(() => cli(['--init', '--input', config, '--manifest', path.join(root, 'public.json'), ...args]), 'manifest_destination_invalid');
  const proc = spawnSync(process.execPath, [__filename.replace('.test.js', '.js'), '--collect', '--manifest', path.join(root, 'secret-content')], { encoding: 'utf8' });
  check(proc.status === 1 && !proc.stderr.includes(root), 'CLI errors sanitized');
  fs.writeFileSync(path.join(source, 'r0-0.txt'), 'fictional seed-1 prework\n');
  fs.writeFileSync(path.join(source, 'r1-0.txt'), 'fictional seed-2 prework\n');
  const originalSnapshot = path.join(evidence, first.captures[0].metadata.snapshot);
  const originalBytes = fs.readFileSync(originalSnapshot);
  fs.appendFileSync(originalSnapshot, 'tampered');
  rejects(() => collectCorpus(manifest, trusted), 'replay_snapshot_changed');
  fs.writeFileSync(originalSnapshot, originalBytes);
  fs.writeFileSync(path.join(first.private_root, 'catalog.json'), '{}');
  rejects(() => collectCorpus(manifest, trusted), 'replay_document_changed');
  fs.writeFileSync(path.join(evidence, 'freeze.json'), '{}');
  rejects(() => collectCorpus(manifest, trusted), 'evidence_frozen');
  check(createSplit(observed, { freezeId: 'synthetic-v1', reservedCount: 2 }).digest === selected.split.digest, 'split independent of outcomes');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`empirical-collect: ${assertions} assertions passed; synthetic only, owner collection unverified`);
