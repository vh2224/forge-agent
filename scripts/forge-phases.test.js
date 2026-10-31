#!/usr/bin/env node
'use strict';

// End-to-end diagnostic surface, isolated from the operator's preferences.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-phases-routing-')));
const home = path.join(root, 'home'), cwd = path.join(root, 'repo'), forgeHome = path.join(home, '.forge-agent');
const cli = path.join(__dirname, 'forge-phases.js');
fs.mkdirSync(forgeHome, { recursive: true });
fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
const globalFile = path.join(forgeHome, 'forge-agent-prefs.jsonc');
const localFile = path.join(cwd, '.gsd', 'forge-prefs.jsonc');
fs.writeFileSync(globalFile, '{}');
function run(json) {
  const result = spawnSync(process.execPath, [cli, '--cwd', cwd, ...(json ? ['--json'] : [])], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, HOME: home, USERPROFILE: home, FORGE_HOME: forgeHome },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  fs.writeFileSync(localFile, JSON.stringify({ routing: { tier_models: { light: ['gpt-6-luna'] } } }));
  const before = fs.readFileSync(localFile), globalBefore = fs.readFileSync(globalFile);
  const invalid = JSON.parse(run(true));
  assert(invalid.warnings.some(row => row.key === 'routing.tier_models.light' && /routing phase/.test(row.message)));
  assert(run(false).includes('Avisos de routing:'));
  assert.deepStrictEqual(fs.readFileSync(localFile), before);
  assert.deepStrictEqual(fs.readFileSync(globalFile), globalBefore);
  console.log('PASS issue277 phases CLI diagnoses malformed routing in JSON and human output without writes');

  fs.writeFileSync(localFile, JSON.stringify({ routing: { tier_models: { executor: { light: ['gpt-6-luna'] } } } }));
  const valid = JSON.parse(run(true));
  assert.deepStrictEqual(valid.warnings, []);
  assert(valid.domains.includes('tier_models'));
  assert(valid.rows.some(row => row.unit_type === 'execute-task' && row.domain_input === 'tier_models'));
  assert(!run(false).includes('Avisos de routing:'));
  console.log('PASS issue277 phases CLI retains a valid custom domain named tier_models');

  fs.writeFileSync(localFile, JSON.stringify({ routing: { customer_operations_backend: { executor: { standard: 'gpt-6-luna' } } } }));
  assert(run(false).includes('routing.customer_operations_backend.executor.standard: expected an array of nonempty model strings'));
  console.log('PASS review R1 ordinary long routing domain retains the complete type explanation');

  fs.writeFileSync(localFile, JSON.stringify({ routing: { 'bad\n\u001b[31m': { light: [] } } }));
  const human = run(false);
  const warningLines = human.slice(human.indexOf('Avisos de routing:')).split('\n').filter(Boolean);
  assert.strictEqual(warningLines.length, 2);
  assert(!warningLines[1].includes('\u001b'));
  assert(warningLines[1].length <= 502);
  console.log('PASS phases diagnostics sanitize control characters and bound warning lines');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
