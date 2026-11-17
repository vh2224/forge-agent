'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issue-418/distribution.cjs'),artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);const bad=structuredClone(layer.issues403404Layer);bad.provenance.base_revision='0'.repeat(40);assert.throws(()=>layer.validate({artifacts,issues403404LayerValue:bad}));
for(const file of ['scripts/forge-time-decision-errors.js','scripts/forge-artifact-routing-diagnostic.js','scripts/forge-xllm.js','forge-prefs.schema.json','skills/forge-doctor/SKILL.md'])assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
assert.throws(()=>layer.validate({artifacts:artifacts.map(a=>a.source==='skills/forge-doctor/SKILL.md'?{...a,content:a.content+'foreign drift'}:a)}));
console.log('PASS issues403/404 exact47555 predecessor, immutable401/history, root schema/runtime/rendered drift rejected');
const smoke=fs.readFileSync(path.join(root,'scripts/forge-smoke.js'),'utf8'),altered=smoke+'\n// malicious in-process re-pin\n',row=layer.issues403404Layer.files['scripts/forge-smoke.js'],saved=row.after;
try{
 row.after=require('crypto').createHash('sha256').update(altered).digest('hex');
 for(const call of [()=>layer.previousSmoke(altered),()=>layer.predecessorSmoke(altered),()=>layer.after('files','scripts/forge-smoke.js','0'.repeat(64)),()=>layer.projectGolden({surfaces:[]}),()=>layer.sampleAfter('/foreign','0'),()=>layer.previousSamples('{}')])assert.throws(call,/campaign independent measured delta/);
}finally{row.after=saved;}
assert.equal(layer.validate({artifacts}),true);
console.log('PASS R1 all direct projections reject mutation of exported data through the independent PIN');
