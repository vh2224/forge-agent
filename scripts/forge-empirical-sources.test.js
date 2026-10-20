#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha256, MAX_FILE_BYTES } = require('./forge-delivery.js');
const { fingerprint } = require('./forge-autonomy-sources.js');
const { validateCorpus } = require('./forge-empirical-corpus.js');
const { LIMITS, validateSourceManifest, validatePrivateDestination, readLocalSource } = require('./forge-empirical-sources.js');
const cases = require('./fixtures/empirical-corpus/sources/cases.json');
const contract = require('./fixtures/empirical-corpus/contract/cases.json');
const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'empirical-sources-'));
const milestone = 'M-20260101120000-fixture';
const owner = path.join(temp, 'owner');
const evidence = path.join(owner, '.gsd', 'milestones', milestone, 'evidence');
const origin = path.join(temp, 'source');
fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(origin);
const trusted = { owner, milestone, roots: [{ id: 'fixture', path: origin }] };
const manifest = { schema_version: 1, sources: [{ id: 'before', root: 'fixture', path: 'before.json', type: 'local', format: 'json' }] };
let serial = 0; let assertions = 0; let linkResult = 'not-run';
function equal(actual, expected) { assertions++; assert.deepStrictEqual(actual, expected); }
function session(options = {}, input = manifest) {
  const result = validateSourceManifest(input, { ...trusted, ...options });
  equal(result.valid, true); return result.session;
}
function read(handle = session(), id = 'before') { return readLocalSource(handle, id, `snapshot-${serial++}.json`); }
function source(content) { fs.writeFileSync(path.join(origin, 'before.json'), content); }
try {
  source('{"value":1}\n');
  const result = read();
  equal(result.status, 'observed'); equal(result.metadata.bytes, 12);
  equal(result.metadata.sha256, sha256(Buffer.from('{"value":1}\n')));
  equal(result.metadata.semantic_fingerprint, fingerprint({ value: 1 }));
  equal(fs.readFileSync(result.metadata.snapshot, 'utf8'), '{"value":1}\n');
  equal(result.autonomy.compatible, true);
  for (const literal of cases.literal_paths) {
    fs.mkdirSync(path.dirname(path.join(origin, literal)), { recursive: true });
    const bytes = Buffer.from(`literal source: ${literal}\n`);
    fs.writeFileSync(path.join(origin, literal), bytes);
    const input = structuredClone(manifest); input.sources[0].path = literal; input.sources[0].format = 'raw';
    const captured = read(session({}, input));
    equal(captured.status, 'observed'); equal(captured.metadata.path, literal);
    equal(captured.metadata.sha256, sha256(bytes));
    equal(fs.readFileSync(captured.metadata.snapshot), bytes);
    equal(fs.readFileSync(path.join(origin, literal)), bytes);
  }
  equal(readLocalSource(session(), 'before', path.basename(result.metadata.snapshot)).reason, 'snapshot_exists');
  const corpus = structuredClone(contract.cases[0].corpus);
  Object.assign(corpus.references[0], { path: result.metadata.snapshot, bytes: result.metadata.bytes,
    sha256: result.metadata.sha256, captured_at: result.metadata.captured_at,
    temporal_source: result.metadata.temporal_source });
  corpus.captured_at = result.metadata.captured_at;
  equal(validateCorpus(corpus).valid, true);
  corpus.references[0].sha256 = 'wrong'; equal(validateCorpus(corpus).valid, false);
  for (const bad of cases.bad_paths) {
    const input = structuredClone(manifest); input.sources[0].path = bad;
    equal(validateSourceManifest(input, trusted).valid, false);
    assertions++; assert.throws(() => validatePrivateDestination(trusted, bad));
  }
  for (const authority of [{ capability: 'networked' }, { limits: { fileBytes: 99999999 } }, { owner }, { roots: trusted.roots }]) {
    equal(validateSourceManifest({ ...manifest, ...authority }, trusted).valid, false);
  }
  equal(validateSourceManifest(manifest, { ...trusted, limits: { fileBytes: LIMITS.fileBytes + 1 } }).valid, false);
  const foreign = structuredClone(manifest); foreign.sources[0].root = 'foreign';
  equal(validateSourceManifest(foreign, trusted).valid, false);
  equal(readLocalSource(JSON.parse(JSON.stringify(session())), 'before', 'forged.json').reason, 'session_or_source_invalid');
  equal(validateSourceManifest(manifest, { ...trusted, owner: origin }).valid, false);
  for (const verb of cases.mutations) equal(validateSourceManifest({ ...manifest, operation: verb }, trusted).valid, false);
  equal(read(session({ limits: { fileBytes: 11 } })).reason, 'source_too_large');
  const limited = session({ limits: { files: 1 } }); equal(read(limited).status, 'observed'); equal(read(limited).reason, 'budget_exhausted');
  const total = session({ limits: { totalBytes: 12 } }); equal(read(total).status, 'observed'); equal(read(total).reason, 'budget_exhausted');
  let clock = 0; const timed = session({ clock: () => clock, limits: { totalMs: 10 } }); clock = 10;
  equal(read(timed).reason, 'budget_exhausted');
  let changed = false;
  const io = Object.create(fs);
  io.readSync = (...args) => { const count = fs.readSync(...args); if (!changed) { changed = true; source('changed-content'); } return count; };
  equal(read(session({ io })).reason, 'source_changed_during_read');
  source('x'.repeat(LIMITS.fileBytes + 1)); equal(read().reason, 'source_too_large');
  // Exact caps and indivisible JSON: preserve original, never raise autonomy's cap.
  source(JSON.stringify('x'.repeat(MAX_FILE_BYTES - 2))); equal(read().autonomy.compatible, true);
  source(JSON.stringify('x'.repeat(MAX_FILE_BYTES - 1))); equal(read().autonomy.reason, 'indivisible_over_autonomy_cap');
  source(JSON.stringify('x'.repeat(LIMITS.fileBytes - 2)));
  const twoMiB = read(); equal(twoMiB.metadata.bytes, LIMITS.fileBytes); equal(twoMiB.autonomy.compatible, false);
  const jsonl = structuredClone(manifest); jsonl.sources[0].format = 'jsonl';
  const line = `${JSON.stringify({ payload: 'x'.repeat(600000) })}\n`;
  source(line.repeat(3)); const partitioned = read(session({}, jsonl));
  equal(partitioned.autonomy.parts.length, 3);
  equal(Buffer.concat(partitioned.autonomy.parts.map((part) => part.buffer)), fs.readFileSync(partitioned.metadata.snapshot));
  for (const [index, part] of partitioned.autonomy.parts.entries()) {
    equal(part.source_sha256, partitioned.metadata.sha256); equal(part.start_record, index);
    assertions++; assert(part.buffer.length <= MAX_FILE_BYTES);
  }
  equal(read(session({ limits: { references: 2 } }, jsonl)).autonomy.reason, 'autonomy_reference_limit');
  equal(read(session({ limits: { records: 2 } }, jsonl)).autonomy.reason, 'autonomy_record_limit');
  source('{"a":1}');
  const oneJson = session({ limits: { records: 1 } });
  equal(read(oneJson).autonomy.compatible, true);
  equal(read(oneJson).autonomy.reason, 'autonomy_record_limit');
  const mixedManifest = structuredClone(manifest); mixedManifest.sources.push({ ...mixedManifest.sources[0], id: 'lines', format: 'jsonl' });
  const mixed = session({ limits: { records: 1 } }, mixedManifest);
  equal(read(mixed).autonomy.compatible, true);
  equal(readLocalSource(mixed, 'lines', 'mixed-lines.jsonl').autonomy.reason, 'autonomy_record_limit');
  const reverse = session({ limits: { records: 1 } }, mixedManifest);
  equal(readLocalSource(reverse, 'lines', 'reverse-lines.jsonl').autonomy.compatible, true);
  equal(read(reverse).autonomy.reason, 'autonomy_record_limit');
  source(`${JSON.stringify('x'.repeat(MAX_FILE_BYTES))}\n`);
  equal(read(session({}, jsonl)).autonomy.reason, 'indivisible_over_autonomy_cap');
  source('{"a":1}\ninvalid\n'); equal(read(session({}, jsonl)).autonomy.reason, 'jsonl_malformed');
  for (const sensitive of ['password=synthetic-secret', 'https://user:pass@example.invalid', 'BEGIN SYSTEM PROMPT private']) {
    source(sensitive); const omitted = read(); equal(omitted.reason, 'sensitive_source_omitted');
    equal(JSON.stringify(omitted).includes(sensitive), false);
  }
  source('{"value":1}');
  const freeze = path.join(evidence, 'freeze.json'); fs.writeFileSync(freeze, '{}');
  equal(validateSourceManifest(manifest, trusted).valid, false); fs.unlinkSync(freeze);
  const link = path.join(temp, 'linked-source');
  try {
    fs.symlinkSync(origin, link, process.platform === 'win32' ? 'junction' : 'dir'); linkResult = 'passed';
    equal(validateSourceManifest(manifest, { ...trusted, roots: [{ id: 'fixture', path: link }] }).valid, false);
    const out = path.join(evidence, 'linked'); fs.symlinkSync(origin, out, process.platform === 'win32' ? 'junction' : 'dir');
    assertions++; assert.throws(() => validatePrivateDestination(trusted, 'linked/new.json'));
    fs.unlinkSync(out);
    const swapped = session(); fs.renameSync(origin, `${origin}-old`);
    fs.symlinkSync(`${origin}-old`, origin, process.platform === 'win32' ? 'junction' : 'dir');
    equal(read(swapped).reason, 'path_link_or_special'); fs.unlinkSync(origin); fs.renameSync(`${origin}-old`, origin);
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; linkResult = `skipped:${error.code}`; }
  // A byte sentinel proves every successful/failed capture left source contents untouched.
  equal(fs.readFileSync(path.join(origin, 'before.json'), 'utf8'), '{"value":1}');
  console.log(`empirical-sources: ${assertions} assertions passed; ancestry links ${linkResult}; synthetic fixtures only`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
