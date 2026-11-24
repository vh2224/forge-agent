'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const layer=require('./fixtures/issues-457-458/distribution.cjs'),parent=require('./fixtures/issues-457-458/distribution.cjs').loadHistoricalFixture('scripts/fixtures/issues-442-446/distribution.cjs'),root=path.resolve(__dirname,'..');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);assert.equal(layer.validate414Snapshot({artifacts}),true);
for(const file of ['scripts/forge-unit-sidecar.js','scripts/forge-issue-407-distribution.test.js']){
 const readRaw=relative=>{const bytes=fs.readFileSync(path.join(root,relative));return relative===file?Buffer.concat([bytes,Buffer.from('\n// foreign drift')]):bytes;};
 assert.throws(()=>layer.validate({artifacts,readRaw}),'unmeasured source drift '+file);
}
const changed=structuredClone(layer.issue448Layer);changed.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issue448LayerValue:changed}),/independent measured delta/);
assert.equal(layer.issues442446Layer,parent.issues442446Layer,'published predecessor exported unchanged');
assert.equal(layer.issue448Layer.files['scripts/forge-unit-sidecar.js'].before,parent.issues442446Layer.files['scripts/forge-unit-sidecar.js'].after,'exact runtime predecessor');
const saved=parent.after;let calls=0;
try{parent.after=(...args)=>{calls++;return saved(...args);};assert.equal(layer.after('files','__issue448_projection_counter__',''),'');assert.equal(calls,1,'one parent traversal');}finally{parent.after=saved;}
console.log('PASS #448 measured successor: exact source and consumer projection, immutable predecessor, drift negatives and one parent traversal');
