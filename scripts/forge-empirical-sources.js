#!/usr/bin/env node
'use strict';

// Explicit sources only. A manifest is data; the caller supplies authority separately.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { readBoundedStableFile, fingerprint } = require('./forge-autonomy-sources.js');
const { sha256, MAX_FILE_BYTES } = require('./forge-delivery.js');
const { resolveOwner } = require('./forge-workspace.js');
const { normalizeTarget } = require('./forge-autonomy-sources.js');
const LIMITS = Object.freeze({ files: 100, fileBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
  commands: 64, entries: 100, commandMs: 15000, totalMs: 180000, discoveryNames: 200,
  references: 100, records: 10000 });
const SESSIONS = new WeakMap();

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) fail('unknown_fields');
}
function relativePath(value) {
  if (typeof value !== 'string' || value.length > 500 || !value || /[\\:%?#<>"|*\x00-\x1f\x7f]/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.startsWith('-'))) fail('path_invalid');
  return value;
}
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
// Inspect all existing ancestors, including those above the trusted root.
function checkedPath(file, missingLeaf = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file) ||
      file.startsWith('\\\\') || file.startsWith('//')) fail('root_invalid');
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let cursor = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part.includes(':') || /[. ]$/.test(part)) fail('path_invalid');
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT' && missingLeaf && index === parts.length - 1) return absolute;
      fail('path_unreadable');
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && index < parts.length - 1)) fail('path_link_or_special');
    if (!stat.isDirectory() && !stat.isFile()) fail('path_link_or_special');
    const real = fs.realpathSync.native(cursor);
    if (path.relative(cursor, real) !== '') fail('path_identity_changed');
  }
  return absolute;
}
function privateRoot(trusted) {
  const owner = checkedPath(trusted.owner);
  checkedPath(path.join(owner, '.gsd'));
  if (resolveOwner(owner, { stopAt: owner }) !== owner) fail('owner_invalid');
  if (normalizeTarget({ type: 'milestone', id: trusted.milestone }).error) fail('milestone_invalid');
  const unit = checkedPath(path.join(owner, '.gsd', 'milestones', trusted.milestone));
  const evidence = checkedPath(path.join(unit, 'evidence'));
  if (!fs.statSync(evidence).isDirectory()) fail('evidence_not_directory');
  for (const marker of [path.join(unit, 'freeze.json'), path.join(evidence, 'freeze.json')]) {
    try { fs.lstatSync(marker); fail('evidence_frozen'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return evidence;
}
function validatePrivateDestination(trusted, name) {
  relativePath(name);
  if (name.length > 160) fail('snapshot_name_long');
  const root = privateRoot(trusted);
  const destination = path.join(root, ...name.split('/'));
  if (!inside(root, destination) || destination === root) fail('destination_outside_owner');
  checkedPath(destination, true);
  try { fs.lstatSync(destination); fail('snapshot_exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return destination;
}
function validateSourceManifest(manifest, trusted) {
  try {
    closed(manifest, ['schema_version', 'sources']);
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.sources)) fail('manifest_invalid');
    const evidence = privateRoot(trusted);
    const limits = { ...LIMITS };
    for (const [key, value] of Object.entries(trusted.limits || {})) {
      if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) fail('limit_invalid');
      limits[key] = value;
    }
    if (manifest.sources.length > limits.files || !Array.isArray(trusted.roots) || !trusted.roots.length) fail('source_count_or_roots');
    const roots = new Map();
    for (const root of trusted.roots) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(root.id) || roots.has(root.id)) fail('root_id_invalid');
      const real = checkedPath(root.path);
      if (!fs.statSync(real).isDirectory()) fail('root_not_directory');
      const stat = fs.statSync(real);
      roots.set(root.id, { ...root, path: real, device: stat.dev, inode: stat.ino, identity: null });
    }
    const sources = new Map();
    for (const source of manifest.sources) {
      closed(source, ['id', 'root', 'path', 'type', 'format']);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(source.id) || sources.has(source.id) || !roots.has(source.root) ||
          !['local', 'svn'].includes(source.type) || !['raw', 'json', 'jsonl'].includes(source.format)) fail('source_invalid');
      relativePath(source.path);
      sources.set(source.id, { ...source });
    }
    const handle = Object.freeze({ schema_version: 1 });
    const clock = trusted.clock || (() => performance.now());
    SESSIONS.set(handle, { trusted: { ...trusted, roots: undefined, limits: undefined }, roots, sources, limits,
      evidenceStat: fs.statSync(evidence), clock, started: clock(), files: 0, bytes: 0, commands: 0, references: 0, records: 0 });
    return { valid: true, diagnostics: [], session: handle };
  } catch (error) { return { valid: false, diagnostics: [{ code: error.code || 'manifest_invalid' }] }; }
}
function sourceContext(handle, id, type) {
  const context = SESSIONS.get(handle);
  if (!context || !context.sources.has(id)) fail('session_or_source_invalid');
  const source = context.sources.get(id);
  if (source.type !== type) fail('source_type_invalid');
  const root = context.roots.get(source.root);
  checkedPath(root.path);
  const rootStat = fs.statSync(root.path);
  const evidenceStat = fs.statSync(privateRoot(context.trusted));
  if (rootStat.dev !== root.device || rootStat.ino !== root.inode ||
      evidenceStat.dev !== context.evidenceStat.dev || evidenceStat.ino !== context.evidenceStat.ino) fail('root_identity_changed');
  return { context, source, root };
}
function budget(context, command = false) {
  const remaining = context.limits.totalMs - (context.clock() - context.started);
  if (remaining <= 0 || context.files >= context.limits.files || context.bytes >= context.limits.totalBytes ||
      (command && context.commands >= context.limits.commands)) fail('budget_exhausted');
  return remaining;
}
function charge(context, bytes) {
  context.bytes += bytes;
  if (context.bytes > context.limits.totalBytes) fail('total_bytes_exceeded');
  if (context.clock() - context.started >= context.limits.totalMs) fail('duration_exceeded');
}
function suspicious(buffer) {
  // Conservative omission, not a universal secret detector. Nothing raw enters diagnostics.
  const text = buffer.toString('utf8');
  return /(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)\s*["']?\s*[:=]\s*["']?[^\s"'}]+/i.test(text) ||
    /\b[a-z]{2,12}:\/\/[^\s/]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|ghp_)[a-zA-Z0-9_-]{16,}/i.test(text) ||
    /<\|(?:system|user|assistant)|BEGIN (?:SYSTEM |FULL )?PROMPT/i.test(text);
}
function autonomyParts(buffer, format, sourceHash, context) {
  const limitation = (reason) => ({ compatible: false, reason, parts: [] });
  if (format === 'raw') return limitation('documentary_only');
  if (format === 'json' && buffer.length > MAX_FILE_BYTES) return limitation('indivisible_over_autonomy_cap');
  if (context.references >= context.limits.references) return limitation('autonomy_reference_limit');
  if (format === 'json') {
    try { JSON.parse(buffer.toString('utf8')); } catch (_) { return limitation('json_malformed'); }
    context.references++;
    return { compatible: true, parts: [{ buffer, source_sha256: sourceHash, start_record: 0, records: 1 }] };
  }
  if (!Buffer.from(buffer.toString('utf8')).equals(buffer)) return limitation('jsonl_encoding_invalid');
  const parts = []; let start = 0; let offset = 0; let count = 0; let partRecords = 0; let firstRecord = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(10, offset);
    const end = newline < 0 ? buffer.length : newline + 1;
    const line = buffer.subarray(offset, end);
    try { JSON.parse(line.toString('utf8')); } catch (_) { return limitation('jsonl_malformed'); }
    if (line.length > MAX_FILE_BYTES) return limitation('indivisible_over_autonomy_cap');
    if (++count + context.records > context.limits.records) return limitation('autonomy_record_limit');
    if (end - start > MAX_FILE_BYTES) {
      parts.push({ buffer: buffer.subarray(start, offset), source_sha256: sourceHash, start_record: firstRecord, records: partRecords });
      start = offset; firstRecord = count - 1; partRecords = 0;
    }
    partRecords++; offset = end;
  }
  if (offset > start) parts.push({ buffer: buffer.subarray(start), source_sha256: sourceHash, start_record: firstRecord, records: partRecords });
  if (context.references + parts.length > context.limits.references) return limitation('autonomy_reference_limit');
  context.records += count; context.references += parts.length;
  return { compatible: true, parts };
}
function publishSnapshot(context, name, buffer, revalidate) {
  const destination = validatePrivateDestination(context.trusted, name);
  const temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let created = false;
  try {
    revalidate();
    fs.writeFileSync(temporary, buffer, { flag: 'wx', mode: 0o600 }); created = true;
    revalidate();
    validatePrivateDestination(context.trusted, name);
    // Hard-link installation is atomic and refuses collisions; rename would overwrite.
    fs.linkSync(temporary, destination);
    return destination;
  } finally { if (created) fs.unlinkSync(temporary); }
}
function capture(context, source, buffer, metadata, name, revalidate) {
  if (suspicious(buffer)) fail('sensitive_source_omitted');
  const hash = sha256(buffer);
  const compatibility = autonomyParts(buffer, source.format, hash, context);
  const semantic = source.format === 'json' && compatibility.compatible ? fingerprint(JSON.parse(buffer.toString('utf8'))) : null;
  const snapshot = publishSnapshot(context, name, buffer, revalidate);
  return { status: 'observed', complete: true, private: true, metadata: { ...metadata,
    bytes: buffer.length, sha256: hash, snapshot, captured_at: new Date().toISOString(),
    limitations: [...(metadata.limitations || []), 'hash_is_integrity_not_authenticity',
      'ancestor_checks_are_not_an_os_sandbox', 'secret_scan_is_not_exhaustive'],
    semantic_fingerprint: semantic },
  autonomy: compatibility };
}
function readLocalSource(handle, id, name) {
  let context;
  try {
    const resolved = sourceContext(handle, id, 'local'); context = resolved.context;
    const { source, root } = resolved;
    budget(context); validatePrivateDestination(context.trusted, name); context.files++;
    const file = path.join(root.path, ...source.path.split('/'));
    const revalidate = () => { sourceContext(handle, id, 'local'); checkedPath(file); };
    revalidate();
    const result = readBoundedStableFile(file, Math.min(context.limits.fileBytes, context.limits.totalBytes - context.bytes),
      { expectedReal: file, io: context.trusted.io || fs });
    if (result.error) fail(result.error);
    charge(context, result.buffer.length);
    const hash = sha256(result.buffer);
    return capture(context, source, result.buffer, { origin: root.id, path: source.path, revision: null, peg: null,
      temporal_source: 'filesystem_observation', source_mtime: result.stat.mtime.toISOString(), argv: [], result: { exit: 0 } }, name, () => {
      revalidate();
      const current = readBoundedStableFile(file, context.limits.fileBytes, { expectedReal: file });
      if (current.error || sha256(current.buffer) !== hash) fail('source_changed_before_publication');
      if (context.clock() - context.started >= context.limits.totalMs) fail('duration_exceeded');
    });
  } catch (error) { return { status: 'insufficient', complete: false, reason: error.code || 'source_failed' }; }
}

module.exports = { LIMITS, validateSourceManifest, validatePrivateDestination, readLocalSource,
  relativePath, checkedPath, closed, fail, sourceContext, budget, charge, suspicious, capture };
