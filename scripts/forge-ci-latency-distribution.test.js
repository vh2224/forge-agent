'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const entry=require('./fixtures/ci-latency/distribution.cjs');
const root=path.resolve(__dirname,'..');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(entry.validate({artifacts}),true);
const source='scripts/forge-execution-batch-process.test.js';
assert.throws(()=>entry.validate({artifacts,readRaw:file=>{const bytes=fs.readFileSync(path.join(root,file));return file===source?Buffer.concat([bytes,Buffer.from('\n// undeclared drift')]):bytes;}}));
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(entry.ciLatencyLayer);value.files[source][field]='0'.repeat(64);
 assert.throws(()=>entry.validate({artifacts,ciLatencyLayerValue:value}));
}
const old=structuredClone(entry.parallelismLayer),first=Object.keys(old.files).find(file=>old.files[file].before!==null);old.files[first].before='0'.repeat(64);
assert.throws(()=>entry.validate({artifacts,parallelismLayerValue:old}),'historical negative controls remain enforcing');
console.log('PASS additive CI source layer, undeclared source drift, four independent pin mutations and historical-layer tamper refusal');
