#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256, fingerprint } = require('./forge-delivery');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const { checkedPath, relativePath, closed, validatePrivateDestination, suspicious, fail, LIMITS } = require('./forge-empirical-sources');

function auditPublication(manifest, trusted) {
  closed(manifest, ['schema_version', 'public_paths', 'private_paths', 'sentinels', 'fragments', 'reviewed_synthetic']);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.public_paths) || !manifest.public_paths.length ||
      !Array.isArray(manifest.private_paths) || !manifest.private_paths.length || manifest.public_paths.length > 100 ||
      manifest.private_paths.length > 200 || new Set(manifest.public_paths).size !== manifest.public_paths.length ||
      new Set(manifest.private_paths).size !== manifest.private_paths.length) fail('audit_manifest_invalid');
  const owner = checkedPath(trusted.owner); const code = checkedPath(trusted.codeDir);
  // Reuse the private destination guard to validate the owner evidence boundary.
  // This only computes a nonexistent destination; no report or ignore rule is written.
  validatePrivateDestination(trusted, 'publication-audit-boundary-probe');
  const evidence = checkedPath(path.join(owner, '.gsd', 'milestones', trusted.milestone, 'evidence'));
  const evidencePrefix = path.relative(owner, evidence).split(path.sep).join('/') + '/';
  const sentinels = [...(manifest.sentinels || []), ...(manifest.fragments || [])];
  if (sentinels.length > 500 || sentinels.some((s) => typeof s !== 'string' || s.length < 12 || s.length > 4096)) fail('audit_fragments_invalid');
  let total = 0;
  const read = (root, name) => {
    relativePath(name);
    const file = checkedPath(path.join(root, ...name.split('/')));
    const result = readBoundedStableFile(file, LIMITS.fileBytes, { expectedReal: file });
    if (result.error || result.stat.nlink !== 1) fail('audit_file_unreadable');
    total += result.buffer.length;
    if (total > LIMITS.totalBytes) fail('audit_budget_exceeded');
    return result.buffer;
  };
  const git = (cwd, args, allowed = [0], binary = false) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG.*|.*PATHSPECS)$/i.test(key)) delete env[key];
    // check-ignore accepts concrete names and rejects literal pathspec magic.
    const run = (trusted.runner || spawnSync)('git', [...(args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']), ...args], { cwd, shell: false, windowsHide: true,
      encoding: binary ? null : 'utf8', timeout: LIMITS.commandMs, maxBuffer: LIMITS.fileBytes,
      env });
    if (run.error || run.signal || !allowed.includes(run.status) || (binary ? !Buffer.isBuffer(run.stdout) : typeof run.stdout !== 'string')) fail('audit_command_failed');
    total += Buffer.byteLength(run.stdout);
    if (total > LIMITS.totalBytes) fail('audit_budget_exceeded');
    return run;
  };
  const indexEntry = (name) => {
    const listing = git(code, ['ls-files', '--stage', '-z', '--', name]).stdout;
    const rows = listing.split('\0').filter(Boolean);
    if (rows.length > 1) fail('audit_index_unmerged');
    if (!rows.length) return null;
    const match = /^(\d{6}) ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(rows[0]);
    if (!match || match[3] !== name) fail('audit_index_invalid');
    return { mode: match[1], oid: match[2] };
  };
  const reviews = manifest.reviewed_synthetic || [];
  if (!Array.isArray(reviews) || reviews.length > manifest.public_paths.length) fail('audit_review_invalid');
  const reviewedIndices = new Set();
  for (const review of reviews) {
    closed(review, ['public_index', 'sha256', 'reason']);
    if (!Number.isInteger(review.public_index) || review.public_index < 0 || review.public_index >= manifest.public_paths.length ||
        reviewedIndices.has(review.public_index) || !/^[a-f0-9]{64}$/.test(review.sha256) ||
        review.reason !== 'reviewed_synthetic_negative_fixture') fail('audit_review_invalid');
    reviewedIndices.add(review.public_index);
  }
  const findings = []; const reviewedFindings = []; const privateRows = []; const publicRows = [];
  for (const cwd of new Set([owner, code])) if (checkedPath(git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim()) !== cwd) fail('audit_checkout_root_mismatch');
  const privateContents = [];
  for (const [index, name] of manifest.private_paths.entries()) {
    relativePath(name);
    if (!name.startsWith(evidencePrefix)) fail('audit_private_path_outside_evidence');
    const bytes = read(owner, name);
    const tracked = git(owner, ['ls-files', '-z', '--', name]).stdout.length > 0;
    const ignored = git(owner, ['check-ignore', '--no-index', '-q', '--', name], [0, 1]).status === 0;
    if (tracked) findings.push({ code: 'private_file_tracked', private_index: index });
    if (!ignored) findings.push({ code: 'private_file_not_ignored', private_index: index });
    privateRows.push({ index, sha256: sha256(bytes), bytes: bytes.length, tracked, ignored });
    privateContents.push(bytes.toString('utf8'));
    // Long lines detect bounded excerpts, while avoiding generic one-word JSON fields.
    for (const line of bytes.toString('utf8').split(/\r?\n/)) if (line.length >= 64 && line.length <= 4096) sentinels.push(line);
    sentinels.push(path.join(owner, ...name.split('/')), name);
  }
  if (sentinels.length > 100000) fail('audit_fragment_budget_exceeded');
  const normalizedSentinels = [...new Set(sentinels.map((s) => s.replace(/\\/g, '/')))];
  const inspect = (text, index, surface, reviewed = false) => {
    const normalized = text.replace(/\\/g, '/');
    if (suspicious(Buffer.from(text))) (reviewed ? reviewedFindings : findings).push({ code: 'sensitive_public_content', public_index: index, surface });
    if (normalizedSentinels.some((s) => normalized.includes(s)) || privateContents.some((s) => s.length >= 12 && text.includes(s)))
      findings.push({ code: 'private_content_exposed', public_index: index, surface });
  };
  for (const [index, name] of manifest.public_paths.entries()) {
    relativePath(name);
    if (name.split('/').some((part) => ['.gsd', '.forge-personal'].includes(part)) || manifest.private_paths.includes(name)) fail('audit_private_path_public');
    const bytes = read(code, name);
    const review = reviews.find((r) => r.public_index === index);
    if (review && review.sha256 !== sha256(bytes)) fail('audit_review_changed');
    const tracked = git(code, ['ls-files', '-z', '--', name]).stdout.length > 0;
    // Scan staged and unstaged separately: a clean working file can conceal a
    // sensitive staged version when only the combined HEAD diff is inspected.
    const diffs = [[], ['--cached', 'HEAD']].map((args) => git(code,
      ['-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv', ...args, '--', name]).stdout);
    inspect(bytes.toString('utf8'), index, tracked ? 'tracked' : 'declared_untracked', Boolean(review));
    diffs.forEach((diff, i) => inspect(diff, index, i ? 'staged_diff' : 'working_diff'));
    const staged = indexEntry(name);
    if (staged) {
      const sizeText = git(code, ['cat-file', '-s', staged.oid]).stdout.trim();
      if (!/^(?:0|[1-9]\d*)$/.test(sizeText) || Number(sizeText) > LIMITS.fileBytes) fail('audit_index_blob_too_large');
      const blob = git(code, ['cat-file', 'blob', staged.oid], [0], true).stdout;
      if (blob.length !== Number(sizeText)) fail('audit_index_changed');
      staged.sha256 = sha256(blob); staged.bytes = blob.length;
      inspect(blob.toString('utf8'), index, 'index_blob', Boolean(review && review.sha256 === staged.sha256));
    }
    publicRows.push({ index, staged, sha256: sha256(bytes), bytes: bytes.length, tracked, diff_sha256: fingerprint(diffs) });
  }
  // Detect changes while scanning, without modifying the audited workspace.
  for (const [index, name] of manifest.private_paths.entries()) if (sha256(read(owner, name)) !== privateRows[index].sha256) fail('audit_source_changed');
  for (const [index, name] of manifest.public_paths.entries()) if (sha256(read(code, name)) !== publicRows[index].sha256) fail('audit_source_changed');
  for (const [index, name] of manifest.public_paths.entries()) {
    const current = indexEntry(name); const staged = publicRows[index].staged;
    if (fingerprint(current) !== fingerprint(staged && { mode: staged.mode, oid: staged.oid })) fail('audit_index_changed');
    if (staged && sha256(git(code, ['cat-file', 'blob', staged.oid], [0], true).stdout) !== staged.sha256) fail('audit_index_changed');
  }
  const body = { schema_version: 1, passed: !findings.length, scope: 'explicit-manifest-only',
    manifest_digest: fingerprint(manifest), public: publicRows, private: privateRows, findings, reviewed_findings: reviewedFindings,
    limitations: ['bounded_scan_not_universal_secret_detection', 'undeclared_paths_not_audited',
      'fragments_do_not_prove_all_paraphrases_absent', 'no_provider_uat_or_installation_claim', 'readonly_git_queries',
      'synthetic_reviews_are_owner_assertions_bound_to_exact_file_bytes_not_automatic_classification'] };
  return { ...body, digest: fingerprint(body), captured_at: new Date().toISOString() };
}

function cli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--json') args[key] = true;
    else if (['--owner', '--milestone', '--code-dir', '--manifest'].includes(key) && argv[i + 1] && !args[key]) args[key] = argv[++i];
    else fail('cli_invalid');
  }
  const trusted = { owner: args['--owner'], milestone: args['--milestone'], codeDir: args['--code-dir'] };
  const root = checkedPath(path.join(trusted.owner, '.gsd', 'milestones', trusted.milestone, 'evidence'));
  const name = path.relative(root, path.resolve(args['--manifest'])).split(path.sep).join('/'); relativePath(name);
  const file = checkedPath(path.join(root, name));
  const read = readBoundedStableFile(file, LIMITS.fileBytes, { expectedReal: file });
  if (read.error) fail('audit_manifest_unreadable');
  return auditPublication(JSON.parse(read.buffer), trusted);
}

module.exports = { auditPublication, cli };
if (require.main === module) {
  try { const result = cli(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(result)}\n`); process.exitCode = result.passed ? 0 : 1; }
  catch (error) { process.stderr.write(`${JSON.stringify({ reason_code: /^[a-z0-9_]+$/.test(error.code || '') ? error.code : 'audit_failed' })}\n`); process.exitCode = 1; }
}
