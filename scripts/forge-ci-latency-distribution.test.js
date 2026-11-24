'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const entry=require('./fixtures/docs-cleanup/distribution.cjs');
const root=path.resolve(__dirname,'..');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(entry.validate({artifacts}),true);
assert.equal(entry.validate414Snapshot({artifacts}),true,'the explicit archived414 API sees exact approved predecessor bytes');
assert.throws(()=>entry.validate414Snapshot({artifacts,readRaw:file=>file==='scripts/forge-communication-surfaces.test.js'?Buffer.from('foreign snapshot drift'):fs.readFileSync(path.join(root,file))}));
const integration=structuredClone(entry.issue414418Layer);integration.provenance.issues=[];
assert.throws(()=>entry.validate({artifacts,issue414418LayerValue:integration}));
assert.throws(()=>entry.validate414Snapshot({artifacts,issue414418LayerValue:integration}));
const source='scripts/forge-execution-batch-process.test.js';
assert.throws(()=>entry.validate({artifacts,readRaw:file=>{const bytes=fs.readFileSync(path.join(root,file));return file===source?Buffer.concat([bytes,Buffer.from('\n// undeclared drift')]):bytes;}}));
const added='scripts/forge-ci-smoke.test.js';
assert.equal(entry.ciLatencyLayer.files[added].before,null);
assert.throws(()=>entry.validate({artifacts,readRaw:file=>{const bytes=fs.readFileSync(path.join(root,file));return file===added?Buffer.concat([bytes,Buffer.from('\n// new-file drift')]):bytes;}}),'the final current-byte census still checks files absent from historical validators');
for(const file of ['scripts/fixtures/ci-latency/immutable-pin-cache.cjs','scripts/forge-ci-pin-cache.test.js']){
 assert.equal(entry.ciLatencyLayer.files[file].before,null);
 assert.throws(()=>entry.validate({artifacts,readRaw:relative=>{const bytes=fs.readFileSync(path.join(root,relative));return relative===file?Buffer.concat([bytes,Buffer.from('\n// cache source drift')]):bytes;}}));
}
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(entry.ciLatencyLayer);value.files[source][field]='0'.repeat(64);
 assert.throws(()=>entry.validate({artifacts,ciLatencyLayerValue:value}));
}
assert.throws(()=>entry.validate({artifacts,readRaw:file=>file==='scripts/forge-native-execution.test.js'?Buffer.from('foreign native cohort drift'):fs.readFileSync(path.join(root,file))}));
const old=structuredClone(entry.parallelismLayer),first=Object.keys(old.files).find(file=>old.files[file].before!==null);old.files[first].before='0'.repeat(64);
assert.throws(()=>entry.validate({artifacts,parallelismLayerValue:old}),'historical negative controls remain enforcing');
const upstream=structuredClone(entry.issue414Layer);upstream.provenance.issues=[];
assert.throws(()=>entry.validate({artifacts,issue414LayerValue:upstream}),'the integrated native telemetry predecessor remains independently pinned');
for(const file of ['scripts/forge-task-preparation.js','scripts/forge-task-preparation.test.js']){
 assert.throws(()=>entry.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('foreign telemetry drift'):fs.readFileSync(path.join(root,relative))}),'upstream native telemetry changes remain guarded');
}
console.log('PASS additive CI source layer, undeclared source drift, four independent pin mutations and historical-layer tamper refusal');
