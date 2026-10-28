'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { runPartitions } = require('./fixtures/forge-test-partitions');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-partition-test-'));
  const child = path.join(root, 'child.js');
  fs.writeFileSync(child, `const fs=require('fs'),path=require('path');const name=process.argv[2];fs.writeFileSync(path.join(__dirname,name+'.ran'),'yes');if(name==='signal')process.kill(process.pid,'SIGTERM');else if(name==='failure')process.exitCode=7;`);
  try {
    assert.equal(await runPartitions(child, ['success-a', 'success-b'], { stdio: 'ignore' }), 0);
    assert.equal(await runPartitions(child, ['success-c', 'failure', 'after-failure'], { stdio: 'ignore' }), 1);
    for (const name of ['success-a', 'success-b', 'success-c', 'failure', 'after-failure']) {
      assert.equal(fs.readFileSync(path.join(root, name + '.ran'), 'utf8'), 'yes');
    }
    assert.equal(await runPartitions(child, ['signal'], { stdio: 'ignore' }), 1);
    await assert.rejects(runPartitions(child, []), /invalid-test-partitions/);
    for (const concurrency of [0, 3, 1.5]) {
      await assert.rejects(runPartitions(child, ['must-not-run'], { concurrency }), /invalid-test-partitions/);
    }
    assert(!fs.existsSync(path.join(root, 'must-not-run.ran')));
    console.log('PASS test partitions: success, failed child, drained queue, signal and invalid bounds');
  } finally {
    assert(!fs.lstatSync(root).isSymbolicLink());
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
