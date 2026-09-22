'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('./forge-yaml-safe');
const filelock = require('./forge-filelock');

for (const failure of ['release-only', 'write-and-release', 'mkdir', 'file-release']) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-yaml-release-'));
  fs.mkdirSync(path.join(cwd, '.gsd'));
  const dir = path.join(cwd, 'output'), target = path.join(dir, 'state.md');
  const original = { unlink: fs.unlinkSync, write: fs.writeFileSync, mkdir: fs.mkdirSync };
  const primary = Object.assign(new Error(`injected-${failure}`), { code: 'EACCES' });
  try {
    fs.unlinkSync = (file, ...args) => {
      const parent = path.basename(path.dirname(String(file)));
      if (failure === 'file-release' && file === filelock.lockPathFor(cwd, target)) {
        throw Object.assign(new Error('injected file-lock removal failure'), { code: 'EACCES' });
      }
      if (['release-only', 'write-and-release'].includes(failure) && path.basename(String(file)) === 'metadata.json'
          && parent.startsWith('filelock-') && !parent.endsWith('-v2')) {
        throw Object.assign(new Error('injected guard cleanup failure'), { code: 'EACCES' });
      }
      return original.unlink.call(fs, file, ...args);
    };
    fs.writeFileSync = (file, ...args) => {
      if (failure === 'write-and-release' && path.dirname(String(file)) === dir) throw primary;
      return original.write.call(fs, file, ...args);
    };
    fs.mkdirSync = (file, ...args) => {
      if (failure === 'mkdir' && file === dir) throw primary;
      return original.mkdir.call(fs, file, ...args);
    };
    let thrown;
    try { yaml.writeAtomic(target, 'committed', { cwd, maxAttempts: 1 }); } catch (error) { thrown = error; }
    assert(thrown, `${failure} must be observable`);
    if (failure === 'release-only' || failure === 'file-release') {
      assert.strictEqual(thrown.code, failure === 'file-release' ? 'FILE_LOCK_RELEASE_FAILED' : 'GUARD_RELEASE_FAILED');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'committed', 'rename already completed');
    } else {
      assert.strictEqual(thrown, primary, 'retain the primary write/mkdir error');
      assert.strictEqual(fs.existsSync(target), false);
      if (failure === 'write-and-release') assert(thrown.guard_release_failure, 'report simultaneous release failure');
    }
    fs.unlinkSync = original.unlink; fs.writeFileSync = original.write; fs.mkdirSync = original.mkdir;
    if (failure === 'file-release') {
      const owner = JSON.parse(fs.readFileSync(filelock.lockPathFor(cwd, target)));
      assert.strictEqual(filelock.releaseFileLock(cwd, target, owner.run_id, owner.owner_token, owner.generation), true);
    } else if (failure !== 'mkdir') {
      const recovered = filelock.recoverFileLock(cwd, target, { confirmStopped: true });
      assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
      assert(fs.existsSync(recovered.guard_evidence), 'retain interrupted-release evidence');
    } else {
      assert.strictEqual(filelock.checkFileLock(cwd, target).held, false, 'mkdir failure releases acquired lock');
    }
    yaml.writeAtomic(target, 'retry', { cwd, maxAttempts: 1 });
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'retry');
    assert.strictEqual(filelock.checkFileLock(cwd, target).held, false);
  } finally {
    fs.unlinkSync = original.unlink; fs.writeFileSync = original.write; fs.mkdirSync = original.mkdir;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
console.log('forge-yaml-safe release integration tests passed');
