'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const layer=require('./fixtures/docs-cleanup/distribution.cjs');
// Intentional parent import: do not migrate this counter to its own layer.
const parent=require('./fixtures/docs-cleanup/distribution.cjs').loadHistoricalFixture('scripts/fixtures/ci-latency/distribution.cjs'),root=path.resolve(__dirname,'..');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);assert.equal(layer.validate414Snapshot({artifacts}),true);
for(const file of ['scripts/forge-completion-delivery-recovery.js','scripts/forge-delivery-source-policy.js','scripts/forge-xllm.js','scripts/forge-issue-427.test.js']){
 const readRaw=relative=>{const bytes=fs.readFileSync(path.join(root,relative));return relative===file?Buffer.concat([bytes,Buffer.from('\n// fault')]):bytes;};
 assert.throws(()=>layer.validate({artifacts,readRaw}),'actual changed-source drift must be rejected: '+file);
}
const changed=structuredClone(layer.issues420424Layer);changed.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issues420424LayerValue:changed}),/repair independent measured delta/);
const real=parent.after;let calls=0;
try{parent.after=(...args)=>{calls++;return real(...args);};assert.equal(layer.after('files','__repair_projection_counter__',''),'');assert.equal(calls,1,'one parent traversal per projection');}finally{parent.after=real;}
const historical=structuredClone(layer.issue414Layer);historical.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issue414LayerValue:historical}));
assert.throws(()=>layer.validate414Snapshot({artifacts,issue414LayerValue:historical}));
console.log('PASS repair successor: real source/rendered positive controls, drift and historical tamper negatives, one parent traversal');
