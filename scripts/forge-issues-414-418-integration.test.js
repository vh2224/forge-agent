'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issue-440/distribution.cjs'),parent=require('./fixtures/issue-418/distribution.cjs');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.issue414418Layer.provenance.base_revision,'08bed46b12b062139ac842f7a6e79017ec02af9c');
assert.equal(layer.issue414418Layer.secondary414.revision,'d0fd612313f3b3b5dceec24ea477e83b12d4e004');
assert.equal(layer.validate({artifacts}),true);
assert.equal(layer.validate414Snapshot({artifacts}),true);
for(const file of ['scripts/forge-task-preparation.js','scripts/forge-sidecar-identity.js'])assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
assert.throws(()=>layer.validate414Snapshot({artifacts,readRaw:rel=>rel==='scripts/forge-task-preparation.js'?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
const altered=structuredClone(layer.issue414418Layer);altered.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issue414418LayerValue:altered}),/integration measured delta/);
const original=parent.after;let calls=0;
try{parent.after=(...args)=>{calls++;return original(...args);};assert.equal(layer.after('files','__integration_sentinel__',''),'');assert.equal(calls,1,'normal projection delegates to418 once');}finally{parent.after=original;}
const archive=layer.issue414Layer,schema=archive.schema_version;
const samples=fs.readFileSync(path.join(root,'docs/communication-evaluation/samples.json'),'utf8'),smoke=fs.readFileSync(path.join(root,'scripts/forge-smoke.js'),'utf8');
const entries=[()=>layer.validate({artifacts}),()=>layer.validate414Snapshot({artifacts}),()=>layer.after('files','__integration_sentinel__',''),()=>layer.projectGolden({surfaces:[]}),()=>layer.sampleAfter('/synthetic',''),()=>layer.previousSamples(samples),()=>layer.previousSmoke(smoke),()=>layer.predecessorSmoke(smoke)];
for(const run of entries)assert.doesNotThrow(run);
try{archive.schema_version=99;for(const run of entries)assert.throws(run,/integration414 archived layer/);}finally{archive.schema_version=schema;}
console.log('PASS414/418 current combined source and exact414snapshot validated; both feature drift, metadata tamper and archived-layer drift rejected; normal projection has one predecessor traversal');
