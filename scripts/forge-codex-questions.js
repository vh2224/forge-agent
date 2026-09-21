'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveExecutable } = require('./forge-capabilities');
const { addDefaultSetting } = require('./forge-codex-statusline');
const FEATURE = 'default_mode_request_user_input';

function probe(options = {}) {
  if (options.dryRun) return { supported: false, reason: 'questions-probe-dry-run' };
  const runner = options.questionSpawnSync || spawnSync;
  let command = options.codexQuestionBinary || resolveExecutable('codex', options) || 'codex';
  let args = ['features', 'list'];
  // npm's Windows shim is a batch file. Execute its known JS entry using Node,
  // never interpolate the shim path into a shell command.
  if (/\.(cmd|bat)$/i.test(command)) {
    const entry = path.join(path.dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!fs.existsSync(entry)) return { supported: false, reason: 'questions-probe-shim-unsupported' };
    command = process.execPath;
    args = [entry, ...args];
  }
  let result;
  try {
    result = runner(command, args, { shell: false, encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true, env: options.env || process.env });
  } catch (_) { return { supported: false, reason: 'questions-probe-failed' }; }
  if (result.error || result.status !== 0) return { supported: false, reason: result.error && result.error.code === 'ETIMEDOUT' ? 'questions-probe-timeout' : 'questions-probe-failed' };
  const supported = new RegExp(`^${FEATURE}\\s+(?:stable|beta|experimental|under development)\\s+(?:true|false)\\s*$`, 'm').test(String(result.stdout || '').replace(/\r/g, ''));
  return { supported, reason: supported ? 'questions-probe-supported' : 'questions-probe-unsupported' };
}

function addDefaultQuestions(current, capability) {
  if (!capability.supported) return { content: current, reason: capability.reason };
  return addDefaultSetting(current, 'features', FEATURE, `${FEATURE} = true`, 'questions');
}

module.exports = { FEATURE, probe, addDefaultQuestions };
