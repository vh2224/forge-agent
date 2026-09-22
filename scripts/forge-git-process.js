'use strict';

const { execFileSync } = require('child_process');
const GIT_TIMEOUT_MS = 15000;

// Git is a native executable on all supported hosts. User package-manager
// commands have a separate wrapper contract and must not pass through here.
function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, timeout: GIT_TIMEOUT_MS, ...options, shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
  });
}

function validateBranch(cwd, branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('Invalid Git branch reference');
  try { git(cwd, ['check-ref-format', `refs/heads/${branch}`]); }
  catch { throw new Error(`Invalid Git branch reference: ${JSON.stringify(branch)}`); }
  return branch;
}

module.exports = { git, validateBranch, GIT_TIMEOUT_MS };
