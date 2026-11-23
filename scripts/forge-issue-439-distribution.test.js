'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const layer=require('./fixtures/issue-455/distribution.cjs');
const parent=require('./fixtures/project-context/distribution.cjs'),root=path.resolve(__dirname,'..');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);assert.equal(layer.validate414Snapshot({artifacts}),true);
for(const file of ['scripts/forge-xllm.js','scripts/forge-sidecar-verification-repair.js','scripts/forge-issue-439.test.js']){
 const readRaw=relative=>{const bytes=fs.readFileSync(path.join(root,relative));return relative===file?Buffer.concat([bytes,Buffer.from('\n// fault')]):bytes;};
 assert.throws(()=>layer.validate({artifacts,readRaw}),'changed-source drift: '+file);
}
const changed=structuredClone(layer.issue439Layer);changed.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issue439LayerValue:changed}),/owner independent measured delta/);
assert.equal(layer.projectContextLayer,parent.projectContextLayer,'published context layer exported unchanged');
assert.equal(layer.issues434436Layer,parent.issues434436Layer,'predecessor layer exported unchanged');
const real=parent.after;let calls=0;
try{parent.after=(...args)=>{calls++;return real(...args);};assert.equal(layer.after('files','__owner_projection_counter__',''),'');assert.equal(calls,1);}finally{parent.after=real;}
console.log('PASS owner successor #439: current source controls, drift negatives, one parent traversal');
