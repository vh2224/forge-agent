'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issues-442-446/distribution.cjs');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);
assert.equal(layer.issue418Layer.provenance.base_revision,'63fc4ebcbd0c33e0bc9f91873bfd4d5ab8b56dc8');
for(const file of ['scripts/forge-sidecar-identity.js','shared/forge-bidirectional-sidecar.md']) {
 assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
}
const bad=structuredClone(layer.issue418Layer);bad.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issue418LayerValue:bad}));
// A successor must not add another complete ancestral traversal per projection.
const previous=require('./fixtures/issue-416/distribution.cjs'),originalAfter=previous.after;
let traversals=0;
try {
 previous.after=(...args)=>{traversals++;return originalAfter(...args);};
 assert.equal(layer.after('files','__projection_sentinel__',''), '');
 assert.equal(traversals,1,'each projection traverses predecessor history once');
} finally { previous.after=originalAfter; }
// Removing the duplicate audit does not bypass the historical layer guards.
const ancestor=layer.issues410413Layer,schema=ancestor.schema_version;
const samples=fs.readFileSync(path.join(root,'docs/communication-evaluation/samples.json'),'utf8');
const smoke=fs.readFileSync(path.join(root,'scripts/forge-smoke.js'),'utf8');
const projections=[()=>layer.after('files','__projection_sentinel__',''),
 ()=>layer.validate({artifacts}),()=>layer.projectGolden({surfaces:[]}),
 ()=>layer.sampleAfter('/synthetic',''),()=>layer.previousSamples(samples),
 ()=>layer.previousSmoke(smoke),()=>layer.predecessorSmoke(smoke)];
for(const project of projections)assert.doesNotThrow(project,'valid current inputs must reach the projection');
try {
 ancestor.schema_version=99;
 for(const project of projections)assert.throws(project,/campaign independent measured delta predecessor/);
} finally { ancestor.schema_version=schema; }
console.log('PASS418 predecessor history preserved; changed source and measured layer drift rejected');
