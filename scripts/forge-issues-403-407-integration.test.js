'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issues-420-424/distribution.cjs');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);
const saved=layer.issues403404Layer.provenance.base_revision;
try{layer.issues403404Layer.provenance.base_revision='0'.repeat(40);assert.throws(()=>layer.previousSmoke('foreign current smoke'),/independent measured delta/);}finally{layer.issues403404Layer.provenance.base_revision=saved;}
for(const file of ['scripts/forge-execution-resume.test.js','scripts/forge-milestone-time-chain.test.js','scripts/forge-milestone-options-flow.test.js','scripts/forge-milestone-time-reentry.test.js','scripts/forge-linked-task-parity.test.js'])assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
const parity=require('./fixtures/issues-403-407-integration/parity.cjs'),data=require('./fixtures/issues-403-407-integration/parity-delta.json');
async function main(){const trace=await require('./forge-linked-task-parity.test.js').computeTrace(),before=parity.beforeTrace(trace);assert.deepEqual(parity.afterTrace(before),trace);
 for(const row of data.rows){const changed=structuredClone(trace),keys=row.path.slice(),key=keys.pop(),parent=keys.reduce((v,k)=>v[k],changed);parent[key]='foreign';assert.throws(()=>parity.beforeTrace(changed));}
 for(const order of data.orders){const changed=structuredClone(trace),keys=order.path.slice(),key=keys.pop(),parent=keys.reduce((v,k)=>v[k],changed),entries=Object.entries(parent[key]);[entries[0],entries[1]]=[entries[1],entries[0]];parent[key]=Object.fromEntries(entries);assert.throws(()=>parity.beforeTrace(changed),/exact route key order/);}
 const bad=structuredClone(data);bad.rows.pop();assert.throws(()=>parity.afterTrace(before,bad),/independent measured artifact route parity/);
 const original=data.after_revision;try{data.after_revision='0'.repeat(40);assert.throws(()=>parity.beforeTrace(trace),/independent measured artifact route parity/);}finally{data.after_revision=original;}
 assert.equal(layer.validate({artifacts}),true);console.log('PASS current and ancestor independent PINs, exact17-field routing parity projection and every field drift refused; historical captures unchanged');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
