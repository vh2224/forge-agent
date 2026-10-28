'use strict';
const assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const api = require('./forge-native-prompt-file');
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prompt-file-')));
try {
  const owner = path.join(dir, 'owner'), code = path.join(dir, 'code');
  fs.mkdirSync(owner); fs.mkdirSync(code);
  const contract = { owner, code_roots: [{ id: 'primary', path: code }] };
  const file = path.join(dir, 'prompt.txt'), prompt = '\uFEFFMandatory é\r\n' + '完整 payload\n'.repeat(10000);
  const mapped = api.prepare({ file, prompt, contract });
  assert.equal(fs.readFileSync(mapped.file, 'utf8'), prompt);
  assert(mapped.message.length < 1000); mapped.assertUnchanged();
  assert.equal(api.prepare({ file, prompt, contract }).message, mapped.message);
  assert.throws(() => api.prepare({ file, prompt: 'different', contract }), /native-prompt-file-conflict/);
  fs.appendFileSync(file, 'changed');
  assert.throws(() => mapped.assertUnchanged(), /native-prompt-file-conflict/);
  fs.writeFileSync(file, prompt); mapped.assertUnchanged();
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, prompt);
  assert.throws(() => mapped.assertUnchanged(), /native-prompt-file-identity-changed/);
  assert.throws(() => api.prepare({ file: path.join(code, 'prompt'), prompt, contract }), /outside the workspace/);
  assert.throws(() => api.prepare({ file: path.join(owner, 'prompt'), prompt, contract }), /outside the workspace/);
  console.log('PASS native file transport: exact UTF8 bytes, bounded pointer, conflicts, replacement identity and workspace exclusion');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
