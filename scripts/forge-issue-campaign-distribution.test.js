'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issue-448/distribution.cjs');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);
const bad=structuredClone(layer.campaignLayer);bad.provenance.base_revision='0'.repeat(40);assert.throws(()=>layer.validate({artifacts,campaignLayerValue:bad}));
for(const file of ['scripts/forge-execution-continuation.js','skills/forge-next/SKILL.md','scripts/forge-hook.js'])assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
assert.throws(()=>layer.validate({artifacts:artifacts.map(a=>a.source==='skills/forge-next/SKILL.md'?{...a,content:a.content+'\nforeign drift\n'}:a)}));
console.log('PASS grouped campaign distribution: measured successor, unchanged historical validators, stale/foreign source and rendered negative controls');
