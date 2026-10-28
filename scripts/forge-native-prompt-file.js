'use strict';
const fs = require('fs');
const path = require('path');
const { digest, key } = require('./forge-code-roots');
const fail = code => { throw Object.assign(new Error(code), { code, provider_called: false }); };

// Transport packaging is data, never authority. The invocation adapter still
// binds the actual short message; the file retains every mandatory section.
function prepare({ file, prompt, contract, deferWrite = false }) {
  const xllm = require('./forge-xllm');
  const validate = () => {
    let physical = xllm.validateResultFileTarget(file, contract.owner);
    for (const root of contract.code_roots) physical = xllm.validateResultFileTarget(physical, root.path);
    return physical;
  };
  file = validate();
  const bytes = Buffer.from(prompt, 'utf8'), sha256 = digest(bytes);
  const chainIdentity = start => {
    const chain = [];
    for (let cursor = start;; cursor = path.dirname(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) fail('native-prompt-file-target');
      chain.push([cursor, stat.dev, stat.ino, stat.birthtimeMs]);
      if (path.dirname(cursor) === cursor) break;
    }
    return digest(chain);
  };
  const parentIdentity = chainIdentity(path.dirname(file));
  const identity = () => {
    if (key(validate()) !== key(file) || key(fs.realpathSync.native(file)) !== key(file)) fail('native-prompt-file-target');
    const chain = chainIdentity(file);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size !== bytes.length
        || digest(fs.readFileSync(file)) !== sha256) fail('native-prompt-file-conflict');
    return chain;
  };
  let pinned = null;
  const materialize = () => {
    if (pinned === null) {
      if (key(validate()) !== key(file) || chainIdentity(path.dirname(file)) !== parentIdentity) fail('native-prompt-file-target');
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      pinned = identity();
    } else if (identity() !== pinned) fail('native-prompt-file-identity-changed');
  };
  if (!deferWrite) materialize();
  const message = `Read the complete authorized execution prompt from file: ${JSON.stringify(file)}. Verify SHA-256 ${sha256}, then follow its full contents. Do not omit any section. Return the required execution JSON.`;
  return Object.freeze({ file, message, sha256, bytes: bytes.length,
    materialize,
    assertExisting() {
      if (!fs.existsSync(file)) fail('native-prompt-file-missing');
      if (pinned === null) pinned = identity();
      else if (identity() !== pinned) fail('native-prompt-file-identity-changed');
    },
    assertUnchanged() { if (pinned === null || identity() !== pinned) fail('native-prompt-file-identity-changed'); },
    context: prompt, transport_sha256: digest(message) });
}
module.exports = { prepare };
