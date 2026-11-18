'use strict';const assert=require('assert/strict'),fs=require('fs'),p=require('path');const root=p.resolve(__dirname,'..'),layer=require('./fixtures/issues-420-424/distribution.cjs'),artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:p.join(root,'unused-host'),forgeHome:p.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);
assert.deepEqual(layer.issue414Layer.provenance.issues,[414]);
assert.equal(layer.issue416Layer.provenance.base_revision,'8bfe466fc619ab810433a80f193fcc870b7f48f1');
for(const file of ['scripts/forge-task-preparation.js','scripts/forge-task-preparation.test.js'])assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(p.join(root,rel))}));
const bad=structuredClone(layer.issue414Layer);bad.provenance.issues=[];assert.throws(()=>layer.validate({artifacts,issue414LayerValue:bad}));
console.log('PASS414 issue-416 predecessor and all prior layers preserved; native telemetry source drift rejected');
