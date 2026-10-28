'use strict';
const { spawn } = require('child_process');

// Each partition owns its fixture process and cleanup. Drain all partitions even
// after a failure, so a failed group cannot silently remove later coverage.
async function runPartitions(file, partitions, { concurrency = 2, stdio = 'inherit' } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2
      || !Array.isArray(partitions) || partitions.length === 0
      || partitions.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new Error('invalid-test-partitions');
  }
  let next = 0;
  let failed = false;
  async function worker() {
    while (next < partitions.length) {
      const partition = partitions[next++];
      const passed = await new Promise(resolve => {
        const child = spawn(process.execPath, [file, partition], { stdio, windowsHide: true });
        child.once('error', error => {
          console.error(`Test partition ${partition}: ${error.code || 'spawn-error'}`);
          resolve(false);
        });
        child.once('close', (code, signal) => {
          if (code !== 0 || signal) console.error(`Test partition ${partition}: exit ${code}, signal ${signal || 'none'}`);
          resolve(code === 0 && signal === null);
        });
      });
      if (!passed) failed = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, partitions.length) }, worker));
  return failed ? 1 : 0;
}

module.exports = { runPartitions };
