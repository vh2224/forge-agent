#!/usr/bin/env node
'use strict';

// A job has a small fixed number of independent repositories, not concurrent
// suites sharing one checkout/index. Each child retains the canonical runner,
// isolated per-suite HOME, baseline comparison and structured timing profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { validateBaselinePair } = require('./forge-ci-units');
function integer(value, max) { return /^\d+$/.test(value || '') && Number.isSafeInteger(+value) && +value <= max; }
function workerLayout({index,count,jobs,singleWorkerJobs=0}) {
  if (![index,count,jobs,singleWorkerJobs].every(Number.isSafeInteger) || index<0 || count<1 || jobs<1 || jobs>3
      || index>=count || singleWorkerJobs<0 || singleWorkerJobs>count) throw Error('ci-parallel-arguments');
  const total=singleWorkerJobs+(count-singleWorkerJobs)*jobs;
  if(total>64)throw Error('ci-parallel-arguments');
  return {start:index<singleWorkerJobs?index:singleWorkerJobs+(index-singleWorkerJobs)*jobs,
    workers:index<singleWorkerJobs?1:jobs,count:total};
}
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--shard-index', '--shard-count', '--jobs', '--single-worker-jobs', '--profile-dir'].includes(key) || !value || Object.hasOwn(options, key)) throw Error('ci-parallel-arguments');
    options[key] = value;
  }
  if (!integer(options['--shard-index'], 63) || !integer(options['--shard-count'], 64)
      || !integer(options['--jobs'], 3) || +options['--jobs'] < 1 || +options['--shard-count'] < 1
      || +options['--shard-index'] >= +options['--shard-count']
      || (Object.hasOwn(options,'--single-worker-jobs') && !integer(options['--single-worker-jobs'],64))
      || !options['--profile-dir']) throw Error('ci-parallel-arguments');
  const result={ index: +options['--shard-index'], count: +options['--shard-count'], jobs: +options['--jobs'],singleWorkerJobs:+(options['--single-worker-jobs']||0), profileDir: path.resolve(options['--profile-dir']) };
  workerLayout(result);return result;
}
function git(cwd, args, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw Error(`ci-checkout-git-failed:${args[0]}`);
  return result.stdout.trim();
}
function prepareCheckout(source, destination, sha) {
  // --no-local avoids object hardlinks/alternates and writable shared Git state.
  git(source, ['clone', '--quiet', '--no-local', '--no-checkout', '--', source, destination]);
  git(destination, ['checkout', '--quiet', '--detach', sha]);
  const origin = git(source, ['remote', 'get-url', 'origin']);
  git(destination, ['remote', 'set-url', 'origin', origin]);
  const refs = git(source, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/']);
  const updates = refs.split('\n').filter(Boolean).filter(line => !line.startsWith('refs/remotes/origin/HEAD '))
    .map(line => { const [ref, oid] = line.split(' '); if (!/^[a-f0-9]{40,64}$/.test(oid)) throw Error('ci-checkout-ref-invalid'); return `update ${ref} ${oid}`; });
  if (updates.length) {
    // Remote-only branch tips need not be reachable from local heads or tags.
    git(destination, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', source,
      '+refs/remotes/origin/*:refs/remotes/origin/*']);
    git(destination, ['update-ref', '--stdin'], updates.join('\n') + '\n');
  }
  if (git(destination, ['rev-parse', 'HEAD']) !== sha || git(destination, ['status', '--porcelain', '--untracked-files=no'])) throw Error('ci-checkout-mismatch');
  if (fs.realpathSync(git(destination, ['rev-parse', '--absolute-git-dir'])) === fs.realpathSync(git(source, ['rev-parse', '--absolute-git-dir']))) throw Error('ci-checkout-not-independent');
}
function logHeader(jobName, env = process.env) {
  const lines = [];
  if (jobName) {
    if (!/^Tests \((?:ubuntu|macos|windows)-latest, shard [1-9]\d?\/[1-9]\d?\)$/.test(jobName)) throw Error('ci-job-name-invalid');
    lines.push(`Complete job name: ${jobName}`);
  }
  lines.push(`node: ${process.version}`);
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
  if (safe(env.ImageOS) || safe(env.ImageVersion)) {
    lines.push('##[group]Runner Image');
    if (safe(env.ImageOS)) lines.push(`Image: ${env.ImageOS}`);
    if (safe(env.ImageVersion)) lines.push(`Version: ${env.ImageVersion}`);
    lines.push('##[endgroup]');
  }
  return lines.map(line => `${new Date().toISOString()} ${line}\n`).join('');
}
function runChild(checkout, args, streams = process, tempDir = null, logFile = null, jobName = null) {
  return new Promise(resolve => {
    let log = null, logError = null;
    if (logFile) {
      fs.writeFileSync(logFile, logHeader(jobName), { flag: 'wx' });
      log = fs.createWriteStream(logFile, {flags:'a'});
      log.once('error', error => { logError = error.code || 'log-write-error'; });
    }
    const child = spawn(process.execPath, [path.join(checkout, 'scripts/run-tests.js'), ...args], {
      cwd: checkout, env: { ...process.env, ...(tempDir ? { TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir, RUNNER_TEMP: tempDir } : {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(streams.stdout, { end: false });
    child.stderr.pipe(streams.stderr, { end: false });
    const buffers = new Map();
    if (log) for (const stream of [child.stdout, child.stderr]) {
      buffers.set(stream, ''); stream.setEncoding('utf8');
      stream.on('data', chunk => {
        const lines = (buffers.get(stream) + chunk).split(/\r?\n/); buffers.set(stream, lines.pop());
        for (const line of lines) log.write(`${new Date().toISOString()} ${line}\n`);
      });
    }
    let spawnError = null;
    child.once('error', error => { spawnError = error.code || 'spawn-error'; });
    // close, not exit: both output streams have drained before cleanup/publication.
    child.once('close', (code, signal) => {
      if (log) {
        for (const remaining of buffers.values()) if (remaining) log.write(`${new Date().toISOString()} ${remaining}\n`);
        log.end(() => resolve({ code, signal, spawnError, logError }));
      } else resolve({ code, signal, spawnError, logError });
    });
  });
}
function allocateRoot(preferred, { create = fs.mkdtempSync, fallback = os.tmpdir() } = {}) {
  try { return create(path.join(preferred, 'ci-')); }
  catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code) || path.resolve(preferred) === path.resolve(fallback)) throw error;
    return create(path.join(fallback, 'ci-'));
  }
}
async function run(options, { source = path.resolve(__dirname, '..'), temp = path.dirname(source), streams = process, jobName = process.env.FORGE_CI_JOB_NAME || null } = {}) {
  const layout=workerLayout(options);
  if (git(source, ['status', '--porcelain', '--untracked-files=normal'])) throw Error('ci-parallel-requires-clean-checkout');
  const sourceSuites = fs.readdirSync(path.join(source,'scripts')).filter(name => name.endsWith('.test.js'));
  const baselinePair = validateBaselinePair({ sourceSuites, platform: process.platform,
    sourceText: fs.readFileSync(path.join(source,'scripts/fixtures/ci-baseline/known-failures.json'),'utf8'),
    unitText: fs.readFileSync(path.join(source,'scripts/fixtures/ci-baseline/known-unit-failures.json'),'utf8'),
    resolveBaseline: require('./run-tests').resolveBaseline });
  if (!baselinePair.ok) throw Error('ci-baseline-pair-invalid:' + baselinePair.errors.join(';'));
  const sha = git(source, ['rev-parse', 'HEAD']);
  // Keep checkout paths near the original length: long temp paths can inflate
  // path-bearing prompt fixtures and hit Windows path limits.
  const own = fs.realpathSync.native(allocateRoot(temp));
  fs.mkdirSync(options.profileDir, { recursive: true });
  const checkouts = [];
  let outcomes = null;
  try {
    for (let worker = 0; worker < layout.workers; worker++) {
      const checkout = path.join(own, `w${worker}`);
      prepareCheckout(source, checkout, sha);
      checkouts.push(checkout);
    }
    // The effective shard count covers ALL workers of ALL jobs exactly once.
    outcomes = await Promise.allSettled(checkouts.map((checkout, worker) => {
      const index = layout.start + worker, count = layout.count;
      const workerTemp = path.join(own, `t${worker}`);
      fs.mkdirSync(workerTemp);
      streams.stdout.write(`CI isolated worker ${worker + 1}/${layout.workers}; global shard ${index + 1}/${count}; candidate ${sha}\n`);
      return runChild(checkout, ['--baseline', 'scripts/fixtures/ci-baseline/known-unit-failures.json',
        '--partition-suites', '--shard-profile', 'scripts/fixtures/ci-latency/shard-profile.json',
        '--shard-index', String(index), '--shard-count', String(count),
        '--profile-out', path.join(options.profileDir, `worker-${worker}.json`)], streams, workerTemp,
      path.join(options.profileDir, `worker-${worker}.log`), jobName);
    }));
    const ok = outcomes.every(row => row.status === 'fulfilled' && row.value.code === 0 && row.value.signal === null && !row.value.spawnError && !row.value.logError);
    if (!ok) streams.stderr.write('CI worker failed; every sibling was joined. Timing artifacts are diagnostic, never a passing gate.\n');
    return ok ? 0 : 1;
  } finally {
    // No operator path or caller-selected checkout is ever removed.
    const retainedTemp = checkouts.some((_, worker) => {
      const directory = path.join(own, `t${worker}`);
      return fs.existsSync(directory) && fs.readdirSync(directory).length > 0;
    });
    if (outcomes && !retainedTemp && outcomes.every(row => row.status === 'fulfilled' && row.value.code === 0 && row.value.signal === null && !row.value.spawnError)) {
      const stat = fs.lstatSync(own);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(own) !== own) throw Error('ci-cleanup-root-changed');
      fs.rmSync(own, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else streams.stderr.write(`CI worker checkout retained after failure, incomplete join or preserved temp fixtures: ${own}\n`);
  }
}
async function main(argv = process.argv.slice(2)) {
  try { return await run(parseArgs(argv)); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
}
module.exports = { parseArgs, workerLayout, prepareCheckout, logHeader, runChild, allocateRoot, run, main };
if (require.main === module) main().then(code => { process.exitCode = code; });
