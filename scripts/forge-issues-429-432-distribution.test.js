'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const layer=require('./fixtures/issues-434-436/distribution.cjs');
const parent=require('./fixtures/issues-420-424/distribution.cjs'),root=path.resolve(__dirname,'..');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);assert.equal(layer.validate414Snapshot({artifacts}),true);
for(const file of ['scripts/forge-protected-owner-activity.js','scripts/forge-prompt.js','shared/templates/dispatch/plan-slice.md']){
 const readRaw=relative=>{const bytes=fs.readFileSync(path.join(root,relative));return relative===file?Buffer.concat([bytes,Buffer.from('\n// fault')]):bytes;};
 assert.throws(()=>layer.validate({artifacts,readRaw}),'changed-source drift: '+file);
}
const changed=structuredClone(layer.issues429432Layer);changed.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issues429432LayerValue:changed}),/owner independent measured delta/);
const real=parent.after;let calls=0;
try{parent.after=(...args)=>{calls++;return real(...args);};assert.equal(layer.after('files','__owner_projection_counter__',''),'');assert.equal(calls,1);}finally{parent.after=real;}
const historical=structuredClone(layer.issue414Layer);historical.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issue414LayerValue:historical}));
assert.throws(()=>layer.validate414Snapshot({artifacts,issue414LayerValue:historical}));
console.log('PASS owner successor: current source/rendered controls, drift/historical negatives, one parent traversal');
