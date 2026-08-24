#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TASK_ID = 'T-20260824120158-auditar-validar';
const PHASE = 'phase-02-remote-ownership';
const LEAF = 'FORGE_SVN_PARITY_TEST_T20260824120158';
const AUTHORITY = 'cvs.cma.local';
const REPOSITORY_PATH = Object.freeze(['cma_series_2']);
const PARENT_SEGMENTS = Object.freeze([...REPOSITORY_PATH, 'CMA']);
const EXACT_SEGMENTS = Object.freeze([...PARENT_SEGMENTS, LEAF]);
const EXACT_URL = `https://${AUTHORITY}/${EXACT_SEGMENTS.join('/')}`;
const OWNER_FILE = '.forge-svn-owner.json';
const MANIFEST_FILE = '.forge-svn-manifest.json';
const NOT_FOUND_CODES = Object.freeze(['E160013', 'E170000', 'E200009']);

function canonicalUrl(input, expected = {}) {
  if (typeof input !== 'string' || !input) throw new Error('remote-url-required');
  if (/[?#]/.test(input)) throw new Error('remote-url-query-fragment-refused');
  if (/%2f|%5c|%2e/i.test(input)) throw new Error('remote-url-encoded-separator-or-dot-refused');
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('remote-url-invalid'); }
  if (parsed.username || parsed.password) throw new Error('remote-url-userinfo-refused');
  const scheme = expected.scheme || 'https:';
  const authority = expected.authority || AUTHORITY;
  const segments = expected.segments || EXACT_SEGMENTS;
  if (parsed.protocol !== scheme) throw new Error('remote-url-scheme-refused');
  if (parsed.host.toLowerCase() !== authority.toLowerCase()) throw new Error('remote-url-authority-refused');
  let decoded;
  try { decoded = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new Error('remote-url-encoding-invalid'); }
  if (decoded.some((segment) => !segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment))) {
    throw new Error('remote-url-segment-refused');
  }
  if (decoded.length !== segments.length || decoded.some((segment, index) => segment !== segments[index])) {
    throw new Error('remote-url-not-exact-leaf');
  }
  return `${scheme}//${authority}/${segments.map(encodeURIComponent).join('/')}`;
}

function parseInfoXml(xml) {
  const pick = (tag) => {
    const match = String(xml).match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
    return match ? match[1].trim() : null;
  };
  const url = pick('url');
  const root = pick('root');
  const uuid = pick('uuid');
  const revision = String(xml).match(/<entry\s+kind="dir"\s+path="[^"]*"\s+revision="(\d+)"/);
  if (!url || !root || !uuid || !revision) throw new Error('remote-info-xml-incomplete');
  return { url, repository_root: root, repository_uuid: uuid, revision: Number(revision[1]) };
}

function classifyMissing(result) {
  if (result.status === 0) return { absent: false, exists: true, code: null };
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const codes = [...text.matchAll(/E\d{6}/g)].map((match) => match[0]);
  const code = codes.find((item) => NOT_FOUND_CODES.includes(item));
  if (!code) throw new Error(`remote-leaf-probe-not-specific:${codes.join(',') || 'no-svn-code'}`);
  if (/authorization failed|authentication failed|could not resolve|connection|certificate|redirect/i.test(text)) {
    throw new Error('remote-leaf-probe-ambiguous-auth-network');
  }
  return { absent: true, exists: false, code };
}

function runSvn(args, options = {}) {
  if (!Array.isArray(args)) throw new Error('remote-svn-argv-required');
  const result = spawnSync('svn', ['--non-interactive', ...args], { cwd: options.cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', argv: ['svn', '--non-interactive', ...args] };
}

function ownershipDocument({ nonce, repositoryRoot, repositoryUuid, createdRevision = null }) {
  if (!/^[a-f0-9]{32,}$/i.test(nonce || '')) throw new Error('remote-nonce-invalid');
  canonicalUrl(EXACT_URL);
  if (!repositoryRoot || !repositoryUuid) throw new Error('remote-repository-identity-required');
  return {
    schema_version: 1,
    task_id: TASK_ID,
    phase: PHASE,
    nonce,
    canonical_url: EXACT_URL,
    repository_root: repositoryRoot,
    repository_uuid: repositoryUuid,
    created_revision: createdRevision,
  };
}

function validateOwnership(owner, manifest, observed, options = {}) {
  const expectedRevision = options.expectedRevision === undefined ? owner.created_revision : options.expectedRevision;
  canonicalUrl(owner.canonical_url);
  canonicalUrl(manifest.canonical_url);
  canonicalUrl(observed.url);
  for (const field of ['task_id', 'phase', 'nonce', 'canonical_url', 'repository_root', 'repository_uuid', 'created_revision']) {
    if (owner[field] !== manifest[field]) throw new Error(`remote-owner-manifest-mismatch:${field}`);
  }
  if (owner.task_id !== TASK_ID || owner.phase !== PHASE) throw new Error('remote-ownership-identity-mismatch');
  if (owner.repository_root !== observed.repository_root || owner.repository_uuid !== observed.repository_uuid) {
    throw new Error('remote-repository-identity-mismatch');
  }
  if (expectedRevision !== owner.created_revision) throw new Error('remote-created-revision-mismatch');
  if (options.expectedHead !== undefined && observed.revision !== options.expectedHead) throw new Error('remote-head-diverged');
  if (options.externals && options.externals.trim()) throw new Error('remote-externals-refused');
  return true;
}

function writeDocuments(dir, document) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [OWNER_FILE, MANIFEST_FILE]) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  }
}

module.exports = {
  TASK_ID, PHASE, LEAF, AUTHORITY, PARENT_SEGMENTS, EXACT_SEGMENTS, EXACT_URL,
  OWNER_FILE, MANIFEST_FILE, NOT_FOUND_CODES, canonicalUrl, parseInfoXml,
  classifyMissing, runSvn, ownershipDocument, validateOwnership, writeDocuments,
};

if (require.main === module) {
  const candidate = process.argv[2] || EXACT_URL;
  try { process.stdout.write(JSON.stringify({ ok: true, canonical_url: canonicalUrl(candidate) }) + '\n'); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
