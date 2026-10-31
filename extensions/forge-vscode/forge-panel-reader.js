'use strict';

// Node-only locator and bounded reader. Nothing here depends on vscode, and no
// workspace folder, setting or data value can choose which core is loaded.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const model = require('./forge-panel-model');

const MANIFEST_LIMIT = 1024 * 1024;
const CORE_PARTS = Object.freeze(['scripts', 'forge-panel-source.js']);
const EXTENSION_INPUT = 'extensions/forge-vscode';
const RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 256 });
const PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
const UNAVAILABLE = Object.freeze({ status: 'unavailable', reason: 'core-unavailable' });

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// Mirrors forge-home.resolveForgeHome in a few lines: the core that owns that
// rule has not been located yet. The suite checks parity with forge-home.js.
function resolveForgeHome(env = process.env, platform = process.platform) {
  const configured = nonEmpty(env.FORGE_HOME);
  if (configured) return path.resolve(configured);
  const effective = PLATFORMS.includes(platform) ? platform : process.platform;
  for (const name of effective === 'win32' ? ['USERPROFILE', 'HOME'] : ['HOME', 'USERPROFILE']) {
    const value = nonEmpty(env[name]);
    if (value) return path.join(path.resolve(value), '.forge-agent');
  }
  return path.join(path.resolve(os.homedir()), '.forge-agent');
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Every component from the anchor down is a real directory or regular file,
// never a link or junction, and resolves to itself.
function physical(anchor, parts) {
  let current = anchor;
  const chain = [anchor].concat(parts.map(part => (current = path.join(current, part))));
  try {
    for (const [index, item] of chain.entries()) {
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) return null;
      if (index === chain.length - 1 && parts.length ? !stat.isFile() : !stat.isDirectory()) return null;
      if (!samePath(fs.realpathSync.native(item), item)) return null;
    }
  } catch (_) { return null; }
  return current;
}

function readBounded(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* already closed */ }
  }
}

function declaresPanel(manifestFile) {
  const text = readBounded(manifestFile, MANIFEST_LIMIT);
  if (text === null) return false;
  try {
    const manifest = JSON.parse(text);
    return Array.isArray(manifest.sources) && manifest.sources.some(source => source && source.source_id === 'vscode-panel'
      && Array.isArray(source.inputs) && source.inputs.includes(EXTENSION_INPUT));
  } catch (_) { return false; }
}

function sourceTreeCore(extensionRoot) {
  const root = path.resolve(extensionRoot, '..', '..');
  if (!physical(root, EXTENSION_INPUT.split('/').concat('package.json'))) return null;
  const manifest = physical(root, ['forge-source-manifest.json']);
  if (!manifest || !declaresPanel(manifest)) return null;
  return physical(root, CORE_PARTS);
}

function installationCore(env, platform) {
  const home = resolveForgeHome(env, platform);
  if (!physical(home, ['VERSION']) || !physical(home, ['manifest.json'])) return null;
  return physical(home, CORE_PARTS);
}

function locateCore(options = {}) {
  const extensionRoot = path.resolve(options.extensionRoot || __dirname);
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  try {
    const source = sourceTreeCore(extensionRoot);
    if (source) return Object.freeze({ status: 'ok', corePath: source, origin: 'source-tree' });
    const installed = installationCore(env, platform);
    if (installed) return Object.freeze({ status: 'ok', corePath: installed, origin: 'installation' });
  } catch (_) { /* fall through to the explicit state */ }
  return UNAVAILABLE;
}

// The worker repeats the file check on the path it is about to load.
function loadableCore(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== CORE_PARTS[1]) return false;
  return physical(path.dirname(file), [CORE_PARTS[1]]) === file;
}

function createReader(options = {}) {
  const locate = options.locate || (() => locateCore());
  const timeoutMs = options.timeoutMs === undefined ? 20000 : options.timeoutMs;
  const minIntervalMs = options.minIntervalMs === undefined ? 2000 : options.minIntervalMs;
  const WorkerImpl = options.WorkerImpl || Worker;
  const coreOptions = options.coreOptions;
  let disposed = false;
  let running = null;
  let next = null;
  let lastStart = -Infinity;

  function execute(folders) {
    let located;
    try { located = locate(); } catch (_) { located = UNAVAILABLE; }
    if (!located || located.status !== 'ok' || typeof located.corePath !== 'string') {
      return { promise: Promise.resolve(model.localResult('core-unavailable')), stop() {} };
    }
    let finish = () => {};
    const promise = new Promise(resolve => {
      let settled = false;
      let timer = null;
      let worker = null;
      finish = (result, terminate) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (terminate && worker) try { worker.terminate(); } catch (_) { /* worker already gone */ }
        resolve(result);
      };
      try {
        worker = new WorkerImpl(__filename, {
          workerData: { forgePanelCore: located.corePath, folders: folders.slice(), now: Date.now(), coreOptions },
          resourceLimits: RESOURCE_LIMITS,
        });
      } catch (_) {
        finish(model.localResult('core-failed'), false);
        return;
      }
      timer = setTimeout(() => finish(model.localResult('core-timeout'), true), timeoutMs);
      // Never forward the worker's error text, stack or paths.
      worker.on('message', message => {
        if (!message || message.ok !== true) finish(model.localResult('core-failed'), true);
        else finish(model.isPanelDto(message.dto) ? message.dto : model.localResult('dto-invalid'), true);
      });
      worker.on('error', () => finish(model.localResult('core-failed'), true));
      worker.on('exit', () => finish(model.localResult('core-failed'), false));
    });
    return { promise, stop: () => finish(null, true) };
  }

  function pump() {
    if (disposed || running || !next) return;
    const entry = next;
    const wait = entry.manual ? 0 : lastStart + minIntervalMs - Date.now();
    if (wait > 0) {
      if (!entry.timer) entry.timer = setTimeout(() => { entry.timer = null; pump(); }, wait);
      return;
    }
    next = null;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    lastStart = Date.now();
    running = execute(entry.folders);
    running.promise.then(result => {
      running = null;
      entry.resolve(disposed ? null : result);
      pump();
    });
  }

  function read(folders, request = {}) {
    if (disposed) return Promise.resolve(null);
    const manual = request.trigger === 'manual';
    const list = Array.isArray(folders) ? folders.filter(folder => typeof folder === 'string') : [];
    if (!next) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      next = { folders: list, manual, promise, resolve, timer: null };
    } else {
      next.folders = list;
      next.manual = next.manual || manual;
    }
    const promise = next.promise;
    if (next.manual && next.timer) {
      clearTimeout(next.timer);
      next.timer = null;
    }
    pump();
    return promise;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve(null);
      next = null;
    }
    if (running) running.stop();
  }

  return Object.freeze({ read, dispose });
}

function runWorker() {
  let message = { ok: false };
  try {
    const file = workerData.forgePanelCore;
    if (loadableCore(file)) {
      const core = require(file);
      const dto = core.readPanelSource({ folders: workerData.folders, now: workerData.now, ...(workerData.coreOptions || {}) });
      message = { ok: true, dto };
    }
  } catch (_) {
    message = { ok: false };
  }
  try { parentPort.postMessage(message); } catch (_) { parentPort.postMessage({ ok: false }); }
}

if (!isMainThread && workerData && typeof workerData.forgePanelCore === 'string') runWorker();

module.exports = { MANIFEST_LIMIT, RESOURCE_LIMITS, resolveForgeHome, locateCore, createReader };
