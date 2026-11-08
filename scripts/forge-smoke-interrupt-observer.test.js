'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

// Exercise the actual standalone smoke helpers and actual client, without
// loading/running all smoke sections or calling an external model/provider.
const smoke = fs.readFileSync(path.join(__dirname, 'forge-smoke.js'), 'utf8');
const first = smoke.indexOf('function writeMockTurnInterrupt(dir)');
const last = smoke.indexOf('async function smokeTurnInterrupt()', first);
assert(first >= 0 && last > first, 'canonical Section98 helper bounds exist');
const helpers = vm.runInNewContext(smoke.slice(first, last) + '\n({writeMockTurnInterrupt,writeTurnInterruptDriver,t02WaitForFile,t02ObserveScenarioDeath,t02ReadLog,t02Alive})',
  { fs, path, process, require, Buffer, Date, Promise, setTimeout, clearTimeout });

async function main() {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-interrupt-observer-'));
  let mockPid = null, live = null, driver = null, driverClosed = false;
  try {
    const stem = path.join(lab, 'ignored'), pidFile = stem + '-pid.txt', logFile = stem + '-log.jsonl';
    const env = { ...process.env, FORGE_T02_CLIENT_PATH: path.join(__dirname, 'forge-appserver-client.js'),
      FORGE_T02_MOCK_PATH: helpers.writeMockTurnInterrupt(lab), FORGE_T02_PID_FILE: pidFile,
      FORGE_T02_TIMEOUT_MS: '4000', FORGE_T02_GRACE_MS: '6000', FORGE_T02_MODE: 'ignored',
      FORGE_T02_LOG_FILE: logFile };
    // No grandchild is needed for this observer seam; the smoke's original
    // whole-process-tree assertions remain in their existing section.
    delete env.FORGE_T02_GRANDCHILD_PID_FILE;
    driver = spawn(process.execPath, [helpers.writeTurnInterruptDriver(lab)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const driverResult = new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { driver.kill(); reject(Error('observer regression driver watchdog')); }, 25000);
      driver.stdout.on('data', bytes => { stdout += bytes.toString(); });
      driver.stderr.on('data', bytes => { stderr += bytes.toString(); });
      driver.once('error', error => { clearTimeout(timer); reject(error); });
      driver.once('close', (code, signal) => { driverClosed = true; clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    const rawPid = await helpers.t02WaitForFile(pidFile, 3000);
    assert(rawPid, 'the real client published its spawned mock PID');
    mockPid = Number(rawPid);
    const observingAt = Date.now();
    const [result, deathAt] = await Promise.all([driverResult, helpers.t02ObserveScenarioDeath(mockPid, driverResult, 25000)]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    const answer = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(answer.ok, false);
    assert.equal(answer.interrupt, require('./forge-appserver-client').INTERRUPT_OUTCOMES.GRACE_EXPIRED);
    const log = helpers.t02ReadLog(logFile), interrupt = log.find(row => row.method === 'turn/interrupt');
    assert(log.some(row => row.method === 'turn/start'), 'the peer really started a turn; no retry is permitted');
    assert(interrupt, 'the peer really received turn/interrupt');
    assert.notEqual(deathAt, null, 'the observer must outlive the old fixed five-second window');
    assert(deathAt - observingAt > 5000, 'this real scenario exercises a death later than the old observer deadline');
    assert(interrupt.at <= deathAt, 'actual peer interrupt precedes the observed process death');
    assert.equal(helpers.t02Alive(mockPid), false);
    console.log('PASS Section98 real ignored interrupt remains observed beyond five seconds with peer order and joined driver');

    live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { live.once('spawn', resolve); live.once('error', reject); });
    assert.equal(await helpers.t02ObserveScenarioDeath(live.pid, Promise.resolve(), 1500), null, 'a completed driver never fabricates death of a live process');
    assert.equal(helpers.t02Alive(live.pid), true);
    const boundedAt = Date.now();
    assert.equal(await helpers.t02ObserveScenarioDeath(live.pid, new Promise(() => {}), 40), null, 'the scenario watchdog also bounds an unresolved driver');
    assert(Date.now() - boundedAt < 1500, 'the observer respects its finite scenario cap');
    assert.equal(helpers.t02Alive(live.pid), true);
    console.log('PASS Section98 live-process negative and unresolved-driver watchdog never invent a death');
  } finally {
    if (driver && !driverClosed) { const closed = new Promise(resolve => driver.once('close', resolve)); driver.kill(); await closed; }
    if (live && helpers.t02Alive(live.pid)) { const closed = new Promise(resolve => live.once('close', resolve)); live.kill(); await closed; }
    if (mockPid && helpers.t02Alive(mockPid)) {
      process.kill(mockPid, 'SIGKILL');
      const joined = await helpers.t02WatchDeath(mockPid, 4000);
      assert.notEqual(joined, null, 'join the owned mock before deleting its fixture');
    }
    fs.rmSync(lab, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
