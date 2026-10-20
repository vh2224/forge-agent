#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { spawnSync } = require('child_process');
const { sha256 } = require('./forge-delivery.js');
const { parseSvnLogXml, parseSvnEvidenceXml } = require('./forge-vcs.js');
const { sourceContext, closed, fail, checkedPath, budget, charge, suspicious,
  capture, validatePrivateDestination } = require('./forge-empirical-sources.js');

function canonicalUrl(raw) {
  if (typeof raw !== 'string' || /[\\\x00-\x20\x7f?#]/.test(raw)) fail('svn_url_invalid');
  let url; let decoded;
  try { url = new URL(raw); decoded = decodeURIComponent(raw); } catch (_) { fail('svn_url_invalid'); }
  if (!['https:', 'file:'].includes(url.protocol) || url.username || url.password ||
      (url.protocol === 'file:' && url.hostname) || /[\\?#%\x00-\x1f\x7f]/.test(decoded) ||
      /%2f|%5c|%3a/i.test(raw) || decoded.split('/').some((part) => part === '..' || part === '.') ||
      url.href !== raw || url.pathname.includes('//')) fail('svn_url_invalid');
  return raw.replace(/\/$/, '');
}
function withinUrl(parent, child) { return child === parent || child.startsWith(`${parent}/`); }
function numericRevision(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('svn_revision_invalid');
  return value;
}
function buildReadRequest(handle, id, request) {
  closed(request, ['operation', 'revision', 'peg', 'endRevision']);
  const { context, source, root } = sourceContext(handle, id, 'svn');
  if (!['info', 'log', 'list', 'cat'].includes(request.operation)) fail('svn_operation_refused');
  const repository = canonicalUrl(root.repository);
  const subtree = canonicalUrl(root.subtree);
  if (!withinUrl(repository, subtree)) fail('svn_subtree_foreign');
  if (repository.startsWith('file:')) checkedPath(fileURLToPath(repository));
  const argv = [request.operation, '--non-interactive', '--no-auth-cache'];
  const remaining = budget(context, true);
  if (request.operation === 'info') {
    if (Object.keys(request).length !== 1) fail('svn_info_options');
    argv.push('--xml', '--', '.');
  } else {
    numericRevision(request.revision); numericRevision(request.peg);
    if (!root.identity || root.identity.repository !== repository || root.identity.subtree !== subtree) fail('svn_identity_required');
    if (!repository.startsWith('file:') && context.trusted.capability !== 'networked') fail('network_capability_required');
    if (request.endRevision !== undefined && request.operation !== 'log') fail('svn_range_refused');
    const revision = request.endRevision === undefined ? request.revision : `${request.revision}:${numericRevision(request.endRevision)}`;
    argv.push('-r', revision);
    if (request.operation === 'log') argv.push('--xml', '--verbose', '--limit', String(context.limits.entries));
    if (request.operation === 'list') argv.push('--xml', '--depth', 'immediates');
    // Source paths are literal data: encode every @ before appending the separately validated peg.
    const target = canonicalUrl(`${subtree}/${source.path.split('/').map(encodeURIComponent).join('/')}`);
    if (!withinUrl(subtree, target)) fail('svn_target_foreign');
    argv.push('--', `${target}@${request.peg}`);
  }
  return { executable: 'svn', argv, options: { cwd: root.path, shell: false, windowsHide: true, encoding: null,
    timeout: Math.max(1, Math.floor(Math.min(context.limits.commandMs, remaining))),
    maxBuffer: Math.min(context.limits.fileBytes, context.limits.totalBytes - context.bytes) },
  repository, subtree };
}
function child(node, name) {
  const found = node.children.filter((entry) => entry.name === name);
  if (found.length !== 1) fail('svn_xml_fields');
  return found[0];
}
function inspectOutput(buffer, request, built, context) {
  if (request.operation === 'cat') return {};
  const document = parseSvnEvidenceXml(buffer, request.operation === 'list' ? 'lists' : request.operation);
  if (request.operation === 'info') {
    const entry = child(document, 'entry');
    const repository = canonicalUrl(child(child(entry, 'repository'), 'root').text.trim());
    const subtree = canonicalUrl(child(entry, 'url').text.trim());
    if (repository !== built.repository || subtree !== built.subtree) fail('svn_identity_mismatch');
    return { identity: { repository, subtree }, revision: numericRevision(entry.attrs.revision) };
  }
  if (request.operation === 'log') {
    const parsed = parseSvnLogXml(buffer);
    if (!parsed.ok) fail('svn_log_malformed');
    const entries = document.children.filter((entry) => entry.name === 'logentry');
    if (entries.length >= context.limits.entries) fail('svn_log_possibly_truncated');
    const lower = Math.min(Number(request.revision), Number(request.endRevision || request.revision));
    const upper = Math.max(Number(request.revision), Number(request.endRevision || request.revision));
    if (parsed.revisions.some((entry) => entry.rev < lower || entry.rev > upper)) fail('svn_revision_foreign');
    // SVN verbose logs contain all changed paths of each matching commit.
    // Reject mixed commits before any snapshot captures sibling metadata.
    const repositoryPath = decodeURIComponent(new URL(built.repository).pathname).replace(/\/$/, '');
    const subtreePath = decodeURIComponent(new URL(built.subtree).pathname);
    const scope = subtreePath.slice(repositoryPath.length).replace(/\/$/, '') || '/';
    const within = (value) => typeof value === 'string' && value.startsWith('/') &&
      !/[\\\x00-\x1f]/.test(value) && !value.split('/').some((p) => p === '.' || p === '..') &&
      (scope === '/' || value === scope || value.startsWith(scope + '/'));
    for (const entry of entries) {
      for (const row of child(entry, 'paths').children) {
        if (row.name !== 'path' || !within(row.text) ||
            (row.attrs['copyfrom-path'] !== undefined && !within(row.attrs['copyfrom-path']))) fail('svn_log_path_foreign');
      }
    }
    return { entries: entries.length, removal_cause: 'unknown' };
  }
  const entries = child(document, 'list').children.filter((entry) => entry.name === 'entry');
  if (entries.length > Math.min(context.limits.entries, context.limits.discoveryNames)) fail('svn_list_truncated');
  return { entries: entries.length };
}
function readHistoricalSource(handle, id, request, name) {
  let context; let observed;
  try {
    const resolved = sourceContext(handle, id, 'svn'); context = resolved.context;
    const { source, root } = resolved;
    validatePrivateDestination(context.trusted, name);
    const built = buildReadRequest(handle, id, request);
    context.commands++; context.files++;
    const started = context.clock();
    let result;
    try { result = (context.trusted.runner || spawnSync)(built.executable, built.argv, built.options); }
    catch (_) { fail('svn_spawn_failed'); }
    // Preserve Buffer until the byte budget and physical hashes have been measured.
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
    observed = { duration_ms: Math.max(0, context.clock() - started), exit: Number.isInteger(result.status) ? result.status : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(result.signal) ? result.signal : result.signal ? 'other' : null,
      stdout_bytes: stdout.length, stdout_sha256: sha256(stdout), stderr_bytes: stderr.length, stderr_sha256: sha256(stderr),
      remaining_ms: Math.max(0, context.limits.totalMs - (context.clock() - context.started)) };
    charge(context, stdout.length + stderr.length);
    if (result.error?.code === 'ETIMEDOUT' || observed.duration_ms >= built.options.timeout) fail('svn_timeout');
    if (result.error?.code === 'ENOBUFS' || stdout.length + stderr.length > built.options.maxBuffer) fail('svn_output_truncated');
    if (result.error || result.signal || result.status !== 0) fail('svn_command_failed');
    if (suspicious(stdout) || suspicious(stderr)) fail('sensitive_source_omitted');
    const parsed = inspectOutput(stdout, request, built, context);
    const sanitizedArgv = built.argv.map((arg, index) => index === built.argv.length - 1 ? '<SOURCE>' : arg);
    const captured = capture(context, source, stdout, { origin: root.id, path: source.path,
      repository: built.repository, subtree: built.subtree, revision: request.revision || parsed.revision,
      peg: request.peg || null, temporal_source: 'svn_revision_observation', argv: sanitizedArgv,
      result: observed, ...parsed, limitations: ['configured_sync_timeout_is_not_a_process_tree_or_hard_wall_clock_guarantee'] }, name,
    () => { sourceContext(handle, id, 'svn'); checkedPath(root.path);
      if (context.clock() - context.started >= context.limits.totalMs) fail('duration_exceeded'); });
    if (parsed.identity) root.identity = parsed.identity;
    return captured;
  } catch (error) { return { status: 'insufficient', complete: false,
    reason: error.code || 'svn_output_invalid', ...(observed ? { result: observed } : {}) }; }
}

module.exports = { canonicalUrl, buildReadRequest, readHistoricalSource };
