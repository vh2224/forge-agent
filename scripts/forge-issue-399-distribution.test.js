'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/ci-latency/distribution.cjs');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);
const bad=structuredClone(layer.issue399Layer);bad.provenance.base_revision='0'.repeat(40);assert.throws(()=>layer.validate({artifacts,issue399LayerValue:bad}));
for(const file of ['scripts/forge-owner-window-recovery.js','scripts/forge-task-retirement.js','skills/forge-doctor/SKILL.md'])assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
assert.throws(()=>layer.validate({artifacts:artifacts.map(a=>a.source==='skills/forge-doctor/SKILL.md'?{...a,content:a.content+'\nforeign drift\n'}:a)}));
console.log('PASS owner recovery distribution: exact9ff predecessor, original campaign pins/negative controls retained, new raw/rendered drift refused');
