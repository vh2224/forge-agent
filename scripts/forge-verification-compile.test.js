'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function childProbe() {
  const cp = require('node:child_process');
  const calls = [];
  const runner = require(process.argv[1]).createWindowsRunner({ spawnSyncImpl(file, args, options) {
    const result = cp.spawnSync(file, args, options);
    calls.push({ mode: args.at(-1), status: result.status });
    return result;
  } });
  const outcome = runner(process.argv[3], { cwd: process.argv[2], env: process.env, timeoutMs: 10000 });
  process.stdout.write(JSON.stringify({ status: outcome.status, error: outcome.error?.code,
    stop: outcome.stop, cleanup: outcome.cleanup, version: /^v\d+\./.test(outcome.stdout || ''), calls }));
}
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, 'fault injection must match exactly one private fixture site');
  return text.replace(before, after);
}
function runProbe(moduleFile, cwd, command) {
  const run = spawnSync(process.execPath, ['-e', '(' + childProbe.toString() + ')()', moduleFile, cwd, command], {
    env: { ...process.env, TEMP: cwd, TMP: cwd, TMPDIR: cwd }, cwd, encoding: 'utf8', windowsHide: true,
    timeout: 30000, maxBuffer: 1048576 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.equal(run.signal, null);
  return JSON.parse(run.stdout);
}
function noBuildFiles(cwd) {
  assert.deepEqual(fs.readdirSync(cwd).filter(name => name.startsWith('forge-verifier-build-')), [], 'private compilation staging is removed only after compiler join');
}

if (process.platform !== 'win32') {
  console.log('SKIP Windows Unicode TEMP compiler integration: requires Windows PowerShell and its CLR compiler');
} else {
  const lab = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-verification-compile-'));
  try {
    const moduleFile = path.join(__dirname, 'forge-verification-process.js');
    for (const name of ['temporary space', 'temporary-\u00e1', 'temporary-\u03a9']) {
      const dir = path.join(lab, name); fs.mkdirSync(dir);
      const result = runProbe(moduleFile, dir, 'node --version');
      assert.equal(result.status, 0, JSON.stringify(result));
      assert.equal(result.error, undefined);
      assert.equal(result.stop, false);
      assert.equal(result.version, true);
      assert.equal(result.cleanup.status, 'joined');
      assert.equal(result.cleanup.started, true);
      assert.equal(result.cleanup.active_processes, 0);
      assert.deepEqual(result.calls.map(row => [row.mode, row.status]), [['Compile', 0], ['Run', 0]], 'every fresh process performs its own real compile before the owned command');
      noBuildFiles(dir);
    }
    console.log('PASS real fresh Windows runners compile and join with ASCII space, Latin and Omega TEMP unchanged');

    const jobFile = path.join(__dirname, 'forge-verification-job.ps1');
    const job = fs.readFileSync(jobFile, 'utf8');
    const faults = [
      ['missing-compiler', text => replaceOnce(text, "Join-Path $runtime 'csc.exe'", "Join-Path $runtime 'fixture-missing-csc.exe'")],
      ['compile-error', text => replaceOnce(text, 'public static class ForgeVerificationJob {', 'public static class ForgeVerificationJob @ {')],
      ['compiler-timeout', text => replaceOnce(text, 'if($watch.ElapsedMilliseconds -ge 10000)', 'if($watch.ElapsedMilliseconds -ge 0)')],
      ['compiler-output-limit', text => replaceOnce(replaceOnce(text, 'public static class ForgeVerificationJob {', 'public static class ForgeVerificationJob { public static void FixtureWarning() { int neverUsed; }'), 'if($reader.bytes -gt 1048576)', 'if($reader.bytes -gt 0)')],
    ];
    for (const [name, mutate] of faults) {
      const dir = path.join(lab, name + '-\u03a9'), runtime = path.join(dir, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
      let faultJob = mutate(job);
      faultJob = replaceOnce(faultJob, '   # Unproved compiler termination never authorizes cleanup of its live files.',
        "   [IO.File]::WriteAllText((Join-Path ([Environment]::GetEnvironmentVariable('TEMP')) 'compiler-joined.txt'),[string]$compileJoined)\n   # Unproved compiler termination never authorizes cleanup of its live files.");
      fs.writeFileSync(path.join(runtime, 'forge-verification-job.ps1'), faultJob);
      fs.copyFileSync(moduleFile, path.join(runtime, 'forge-verification-process.js'));
      const result = runProbe(path.join(runtime, 'forge-verification-process.js'), dir,
        'node -e "require(\'fs\').writeFileSync(\'requested-command-ran.txt\',\'unexpected\')"');
      assert.equal(result.status, null, name);
      assert.equal(result.error, 'EVERIFYCLEANUP', name);
      assert.equal(result.stop, true, name);
      assert.equal(result.cleanup.reason, 'supervisor-compile-failed', name);
      assert.equal(result.cleanup.started, false, name);
      assert.deepEqual(result.calls.map(row => [row.mode, row.status]), [['Compile', 1]], 'compile failure never enters requested command Run: ' + name);
      assert.equal(fs.existsSync(path.join(dir, 'requested-command-ran.txt')), false, name);
      if (name !== 'missing-compiler') assert.equal(fs.readFileSync(path.join(dir, 'compiler-joined.txt'), 'utf8'), 'True', 'the actual compiler handle joined before cleanup: ' + name);
      noBuildFiles(dir);
    }
    console.log('PASS private missing compiler, syntax error, compiler timeout and output overflow fail closed before requested command and retain joined cleanup');
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
}
