#!/usr/bin/env node
'use strict';

// Composition boundary, not a host sandbox. The caller supplies roots and reviewed
// prework provenance; imported catalogs/manifests never grant filesystem authority.
const fs = require('fs');
const path = require('path');
const { validateCorpus } = require('./forge-empirical-corpus');
const { sha256, fingerprint } = require('./forge-delivery');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const { checkedPath, relativePath, closed, fail } = require('./forge-empirical-sources');
const KINDS = Object.freeze(['prework', 'memory', 'procedure', 'ledger']);
const MAX_NODES = 100;
const MAX_BYTES = 1024 * 1024;
const PRIVATE_PATH = /(?:^|\/)(?:grader|reserved|final-code)(?:\/|$)/i;

function corpusOrThrow(corpus) {
  const result = validateCorpus(corpus);
  if (!result.valid) fail('corpus_invalid');
  return result;
}

// Pure validation of a closed graph. Availability is a reviewed caller assertion
// tied to exact reference digests, not a claim inferred from a file's mtime.
function validateInputGraph(corpus, manifest, trusted) {
  corpusOrThrow(corpus);
  closed(manifest, ['schema_version', 'case_id', 'version', 'entries', 'nodes']);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.entries) || !manifest.entries.length ||
      !Array.isArray(manifest.nodes) || manifest.nodes.length > MAX_NODES) fail('graph_invalid');
  const candidate = corpus.candidates.find((c) => c.case_id === manifest.case_id && c.version === manifest.version);
  if (!candidate || candidate.selection !== 'included') fail('case_ineligible');
  if (!trusted || !Array.isArray(trusted.prework) || !Number.isFinite(Date.parse(trusted.before))) fail('provenance_required');
  if (!trusted.split) fail('split_required');
  const split = createSplit(corpus, { freezeId: trusted.split.freeze_id,
    reservedCount: trusted.split.reserved.length, previous: trusted.split });
  if (!split.adjustment.includes(candidate.family_id)) fail('reserved_case');
  const reservedRefs = new Set(corpus.candidates.filter((c) => split.reserved.includes(c.family_id)).flatMap((c) => c.refs));
  const allowed = new Map();
  for (const row of trusted.prework) {
    closed(row, ['ref_id', 'sha256', 'available_at', 'evidence']);
    if (allowed.has(row.ref_id) || !/^[a-f0-9]{64}$/.test(row.sha256) ||
        !Number.isFinite(Date.parse(row.available_at)) || typeof row.evidence !== 'string' || !row.evidence.trim()) fail('provenance_invalid');
    allowed.set(row.ref_id, row);
  }
  const references = new Map(corpus.references.map((r) => [r.id, r]));
  const nodes = new Map(); const paths = new Set(); const refIds = new Set();
  for (const node of manifest.nodes) {
    closed(node, ['id', 'ref_id', 'kind', 'dependencies']);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(node.id) || nodes.has(node.id) ||
        !KINDS.includes(node.kind) || !Array.isArray(node.dependencies) ||
        node.dependencies.length > MAX_NODES || new Set(node.dependencies).size !== node.dependencies.length) fail('node_invalid');
    const ref = references.get(node.ref_id);
    if (!ref) fail('reference_unknown');
    const availability = allowed.get(ref.id);
    // captured_at is collection time (T02 may collect old SVN bytes today).
    // Only the trusted caller's digest-bound historical availability is relevant.
    if (reservedRefs.has(ref.id) || ref.role !== 'prework' || ref.region !== 'prework' || ref.state !== 'observed' ||
        availability?.sha256 !== ref.sha256 || !ref.lineage.length ||
        Date.parse(availability.available_at) > Date.parse(trusted.before)) fail('reference_not_prework');
    relativePath(ref.path);
    if (PRIVATE_PATH.test(ref.path)) fail('private_path');
    const alias = ref.path.toLowerCase();
    if (paths.has(alias) || refIds.has(ref.id)) fail('reference_alias');
    paths.add(alias); refIds.add(ref.id); nodes.set(node.id, { ...node, ref });
  }
  if (!manifest.entries.some((id) => nodes.get(id)?.kind === 'prework' &&
      candidate.refs.includes(nodes.get(id).ref.id))) fail('case_prework_missing');
  const active = new Set(); const seen = new Set(); const ordered = [];
  function visit(id) {
    if (active.has(id)) fail('reference_cycle');
    if (seen.has(id)) return;
    const node = nodes.get(id);
    if (!node) fail('reference_unknown');
    active.add(id);
    for (const dep of node.dependencies) visit(dep);
    active.delete(id); seen.add(id); ordered.push(node);
  }
  for (const id of manifest.entries) visit(id);
  if (seen.size !== nodes.size) fail('graph_unreachable');
  return { nodes: ordered, digest: fingerprint({ manifest, references: ordered.map((n) => n.ref),
    before: trusted.before, prework: trusted.prework }) };
}

function readReference(root, ref) {
  relativePath(ref.path);
  const file = checkedPath(path.join(root, ...ref.path.split('/')));
  const result = readBoundedStableFile(file, MAX_BYTES, { expectedReal: file });
  if (result.error) fail(result.error);
  // Hard links are aliases too; the graph cannot prove their other names safe.
  if (result.stat.nlink !== 1) fail('reference_alias');
  if (result.buffer.length !== ref.bytes || sha256(result.buffer) !== ref.sha256) fail('reference_changed');
  if (!Buffer.from(result.buffer.toString('utf8')).equals(result.buffer)) fail('encoding_invalid');
  return result.buffer;
}

function buildAgentView(corpus, manifest, trusted) {
  const graph = validateInputGraph(corpus, manifest, trusted);
  const sourceRoot = checkedPath(trusted.sourceRoot);
  const forbidden = corpus.references.filter((r) => r.role !== 'prework').map((r) => r.path).filter(Boolean);
  let total = 0;
  const files = graph.nodes.map((node, index) => {
    const bytes = readReference(sourceRoot, node.ref);
    total += bytes.length;
    if (total > MAX_BYTES) fail('input_too_large');
    const text = bytes.toString('utf8');
    // Reject known private references even if only a path, without reading their bodies.
    const normalized = text.replace(/\\/g, '/').toLowerCase();
    if (forbidden.some((p) => normalized.includes(p.replace(/\\/g, '/').toLowerCase()))) fail('private_reference_in_content');
    return { name: `input-${index + 1}.txt`, kind: node.kind, text, sha256: sha256(bytes) };
  });
  // Re-read every permitted file immediately before publishing the final bytes.
  for (const node of graph.nodes) readReference(sourceRoot, node.ref);
  const text = files.map((file) => file.text).join('\n');
  return { schema_version: 1, files, text, sha256: sha256(Buffer.from(text)),
    digest: fingerprint(files), references: files.map((file) => file.name) };
}

// Freeze identity excludes outcomes/metrics and includes family membership and
// exposure. Supplying the persisted previous freeze is mandatory on replay.
function createSplit(corpus, options) {
  corpusOrThrow(corpus);
  if (!options || !/^[a-zA-Z0-9_-]{1,64}$/.test(options.freezeId) ||
      !Number.isSafeInteger(options.reservedCount) || options.reservedCount < 0) fail('split_options_invalid');
  const families = [...new Set(corpus.candidates.map((c) => c.family_id))].sort();
  const exposure = [...new Set(corpus.exposure_registry.map((e) => e.family_id))].sort();
  const previous = options.previous;
  if (previous) {
    const { digest, ...body } = previous;
    if (digest !== fingerprint(body) || previous.schema_version !== 1 || previous.frozen !== true) fail('freeze_invalid');
    if (previous.freeze_id !== options.freezeId && previous.reserved.some((id) => !exposure.includes(id))) fail('new_freeze_requires_exposure');
  }
  const priorAdjustment = previous && previous.freeze_id !== options.freezeId ? previous.adjustment : [];
  const eligible = families.filter((id) => !exposure.includes(id) && !priorAdjustment.includes(id));
  eligible.sort((a, b) => fingerprint({ seed: corpus.split_policy.seed, family: a }).localeCompare(
    fingerprint({ seed: corpus.split_policy.seed, family: b })));
  if (options.reservedCount > eligible.length) fail('reserved_insufficient');
  const reserved = eligible.slice(0, options.reservedCount).sort();
  const split = { schema_version: 1, freeze_id: options.freezeId, frozen: true,
    policy: 'family-hash-v1', seed: corpus.split_policy.seed,
    membership: corpus.candidates.map((c) => ({ case_id: c.case_id, version: c.version, family_id: c.family_id }))
      .sort((a, b) => `${a.case_id}/${a.version}`.localeCompare(`${b.case_id}/${b.version}`)),
    exposure_registry: structuredClone(corpus.exposure_registry).sort((a, b) => fingerprint(a).localeCompare(fingerprint(b))),
    reserved, adjustment: families.filter((id) => !reserved.includes(id)) };
  split.digest = fingerprint(split);
  if (previous?.freeze_id === options.freezeId && previous.digest !== split.digest) fail('split_frozen');
  return split;
}

// Physical separation and an explicit consumption profile. S05 must still verify
// host tools/mounts; passing the whole result to an executor would violate this API.
function materializeViews(corpus, manifest, trusted) {
  const view = buildAgentView(corpus, manifest, trusted);
  const roots = [trusted.sourceRoot, trusted.agentRoot, trusted.graderRoot].map((root) => checkedPath(root));
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    const rel = path.relative(roots[i], roots[j]);
    const inverse = path.relative(roots[j], roots[i]);
    if (!rel || !inverse || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) ||
        (!inverse.startsWith(`..${path.sep}`) && inverse !== '..' && !path.isAbsolute(inverse))) fail('regions_overlap');
  }
  if (roots.some((root) => !fs.statSync(root).isDirectory()) || roots.slice(1).some((root) => fs.readdirSync(root).length)) fail('destination_not_empty');
  if (!Array.isArray(trusted.graderRefs) || new Set(trusted.graderRefs).size !== trusted.graderRefs.length) fail('grader_refs_required');
  const grader = trusted.graderRefs.map((id, index) => {
    const ref = corpus.references.find((r) => r.id === id);
    if (!ref || !ref.role.startsWith('grader/') || ref.state !== 'observed') fail('grader_reference_invalid');
    return { name: `private-${index + 1}.txt`, bytes: readReference(roots[0], ref) };
  });
  const write = (root, file, bytes) => {
    checkedPath(root);
    const destination = checkedPath(path.join(root, file), true);
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  };
  for (const file of view.files) write(roots[1], file.name, file.text);
  for (const file of grader) write(roots[2], file.name, file.bytes);
  return { agent: { ...view, root: roots[1], profile: { cwd: roots[1], allowed_roots: [roots[1]],
    enrichment: 'explicit-graph-only', host_isolation: 'unverified' } },
  grader: { root: roots[2], files: grader.map((file) => file.name) } };
}

module.exports = { validateInputGraph, buildAgentView, createSplit, materializeViews };
if (require.main === module) {
  process.stderr.write('Use the API with explicit caller provenance and roots; imported JSON is not authority.\n');
  process.exitCode = 2;
}
