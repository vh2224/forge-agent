'use strict';
const assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { fixture } = require('./forge-native-recovery-delivery.test');
const side = require('./forge-unit-sidecar');
async function main() {
  const f = await fixture({ standalone: true, corrected: true, nativePromptFile: true });
  try {
    // The retained route and freshly resolved candidate may carry different
    // request seals even though model/tier/effort are identical.
    const pending = await side.recoverUnitSidecar(f.request, f.recovery, f.runtime);
    const live = pending.result, file = live.request.resultFile + '.native-prompt.txt';
    assert(!fs.existsSync(file), 'preflight must not write a final payload');
    let calls = 0;
    const result = await live.invoke(async (request, binding) => {
      calls++;
      assert(binding.args.message.includes(file.replace(/\\/g, '\\\\')));
      const full = fs.readFileSync(file, 'utf8');
      assert(full.includes('Standalone alternatives and risks.'));
      assert(binding.args.message.includes(require('./forge-code-roots').digest(full)));
      assert(!fs.existsSync(f.request.nativePromptFile), 'original requested path stays untouched');
      for (const root of f.contract.code_roots) fs.writeFileSync(path.join(root.path, 'same.txt'), 'after\n');
      return f.result();
    });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(calls, 1);
    live.delivery.verify(result.result); live.delivery.publish(result.result);
    console.log('PASS ordinary file continuation: preflight is read-only, final full payload matches actual pointer and verified publication');
  } finally { f.cleanup(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
