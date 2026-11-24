'use strict';
// The same complete smoke CLI formerly ran after shard zero. Making it a
// discoverable suite lets the canonical partition place its cost beside tests.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function run(platform = process.platform, invoke = spawnSync) {
  if (platform === 'win32') return 0; // Original workflow: Linux and macOS only.
  if (!['linux', 'darwin'].includes(platform)) return 1;
  const result = invoke(process.execPath, [path.join(__dirname, 'forge-smoke.js')], {
    cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'inherit', windowsHide: true,
  });
  return !result.error && !result.signal && Number.isInteger(result.status) ? result.status : 1;
}
module.exports = { run };
if (require.main === module) process.exitCode = run();
