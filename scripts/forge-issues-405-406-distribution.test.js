'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issue-448/distribution.cjs'),artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);const wrong=structuredClone(layer.issues405406Layer);wrong.provenance.base_revision='0'.repeat(40);assert.throws(()=>layer.validate({artifacts,issues405406LayerValue:wrong}));
for(const file of ['agents/forge-researcher.md','agents/forge-planner.md','scripts/forge-completion-delivery-recovery.js','scripts/forge-orchestrate.js','scripts/forge-unit-controller.js','scripts/forge-milestone-time-clock.js','shared/forge-sidecar-auto.md','shared/forge-delivery.md'])assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
assert.throws(()=>layer.validate({artifacts:artifacts.map(a=>a.source==='agents/forge-researcher.md'?{...a,content:a.content+'foreign draft promotion'}:a)}));
const saved=layer.issues405406Layer.provenance.base_revision;try{layer.issues405406Layer.provenance.base_revision='0'.repeat(40);assert.throws(()=>layer.projectGolden({surfaces:[]}),/independent measured delta/);}finally{layer.issues405406Layer.provenance.base_revision=saved;}
console.log('PASS405/406 exact05df successor, immutable403/404/history, recovery/clock/agents/raw/rendered and mutable-export drift rejected');
