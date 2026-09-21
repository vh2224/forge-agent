#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const bash = process.env.FORGE_TEST_BASH || (process.platform === 'win32' ? null : 'bash');
const env = { ...process.env };
delete env.R;
const cases = [
  { legacy: true, valid: true, errors: [] },
  { legacy: false, valid: true, errors: [] },
  { legacy: false, valid: false, errors: ['quoted "path", slash \\ and\nsecond line'] },
];

// Execute the Node expressions and their actual argument placement from the
// distributed prompts. A trailing R=... argument does not populate process.env.R.
for (const file of ['shared/forge-plan-gate.md', 'skills/forge-next/SKILL.md']) {
  const source = read(file).replace(/\r\n/g, '\n');
  const calls = [...source.matchAll(/node -e\s+"([^"]+)"\s+(R=)?"\$REVALIDATION"/g)];
  assert.strictEqual(calls.length, 4, `${file}: parser and three field readers must be exercised`);
  for (const payload of cases) {
    const expected = ['', String(payload.legacy), String(payload.valid), JSON.stringify(payload.errors)];
    calls.forEach((call, index) => {
      const result = spawnSync(process.execPath, ['-e', call[1], `${call[2] || ''}${JSON.stringify(payload)}`], { env, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `${file}: valid JSON rejected\n${result.stderr}`);
      assert.strictEqual(result.stdout, expected[index], `${file}: field ${index} changed in transport`);
    });
  }
  for (const payload of ['', '{broken']) {
    const result = spawnSync(process.execPath, ['-e', calls[0][1], `${calls[0][2] || ''}${payload}`], { env, encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, `${file}: malformed output must not pass`);
  }

  // On POSIX, run the whole published guard, including exit-code handling and
  // stderr fallback. Windows still exercises every Node command above.
  if (bash) {
    const guard = source.match(/^[ \t]*if \[ \$REVALIDATION_EXIT[\s\S]*?^[ \t]*rm -f "\$REVALIDATION_STDERR"/m);
    assert(guard, `${file}: missing IO guard`);
    for (const [exit, payload, legacy, valid, stderr] of [
      [0, JSON.stringify(cases[0]), 'true', 'true', ''],
      [0, JSON.stringify(cases[1]), 'false', 'true', ''],
      [2, JSON.stringify(cases[2]), 'false', 'false', ''],
      [0, '{broken', 'false', 'false', 'invalid JSON'],
      [2, '', 'false', 'false', 'missing plan file'],
      [1, '', 'false', 'false', 'unexpected failure'],
    ]) {
      const script = 'REVALIDATION_STDERR=$(mktemp)\nprintf "%s" "$TEST_STDERR" > "$REVALIDATION_STDERR"\n'
        + guard[0] + '\nprintf "%s\\n" "$LEGACY" "$VALID" "$ERRORS"\n';
      const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', env: {
        ...env, REVALIDATION: payload, REVALIDATION_EXIT: String(exit), TEST_STDERR: stderr,
      } });
      assert.strictEqual(result.status, 0, `${file}: guard failed: ${result.stderr}`);
      const [gotLegacy, gotValid, ...errors] = result.stdout.trimEnd().split('\n');
      assert.deepStrictEqual([gotLegacy, gotValid], [legacy, valid], `${file}: guard verdict`);
      if (stderr) assert(errors.join('\n').includes(stderr), `${file}: lost IO diagnostic`);
      else assert.deepStrictEqual(JSON.parse(errors.join('\n')), JSON.parse(payload).errors);
    }
  }
}
process.stdout.write('plan gate JSON transport passed; ' + (bash ? 'POSIX shell guard passed' : 'POSIX shell guard skipped on Windows') + '\n');
