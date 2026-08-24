#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TERM = Buffer.from([87, 68, 77, 65]);

function asciiLower(byte) {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

function containsInsensitive(haystack, needle = TERM) {
  if (!Buffer.isBuffer(haystack)) haystack = Buffer.from(haystack);
  for (let at = 0; at <= haystack.length - needle.length; at++) {
    let equal = true;
    for (let i = 0; i < needle.length; i++) {
      if (asciiLower(haystack[at + i]) !== asciiLower(needle[i])) { equal = false; break; }
    }
    if (equal) return true;
  }
  return false;
}

function trackedFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: null, shell: false });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = result.error ? result.error.message : Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new Error(`git ls-files failed: ${detail || `exit ${result.status}`}`);
  }
  if (result.stdout.length && result.stdout[result.stdout.length - 1] !== 0) {
    throw new Error('git ls-files failed: incomplete NUL-delimited listing');
  }
  return result.stdout.subarray(0, Math.max(0, result.stdout.length - 1)).toString('utf8').split('\0').filter(Boolean);
}

function scanTracked(root = process.cwd()) {
  const files = trackedFiles(root);
  const matches = [];
  for (const relative of files) {
    if (containsInsensitive(Buffer.from(relative, 'utf8'))) matches.push({ kind: 'path', path: relative });
    let bytes;
    try { bytes = fs.readFileSync(path.join(root, relative)); }
    catch (error) { throw new Error(`cannot read tracked file ${relative}: ${error.message}`); }
    if (containsInsensitive(bytes)) matches.push({ kind: 'content', path: relative });
  }
  return { files: files.length, matches };
}

function assertClean(root = process.cwd()) {
  const result = scanTracked(root);
  if (result.matches.length) {
    const first = result.matches[0];
    throw new Error(`forbidden bytes in tracked ${first.kind}: ${first.path}`);
  }
  return result;
}

if (require.main === module) {
  try {
    const result = assertClean(process.argv[2] ? path.resolve(process.argv[2]) : process.cwd());
    process.stdout.write(`sensitive-term guard passed: ${result.files} tracked files\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { TERM, containsInsensitive, trackedFiles, scanTracked, assertClean };
