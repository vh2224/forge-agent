'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issue-418/distribution.cjs');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);
assert.equal(layer.issue418Layer.provenance.base_revision,'63fc4ebcbd0c33e0bc9f91873bfd4d5ab8b56dc8');
for(const file of ['scripts/forge-sidecar-identity.js','shared/forge-bidirectional-sidecar.md']) {
 assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
}
const bad=structuredClone(layer.issue418Layer);bad.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issue418LayerValue:bad}));
console.log('PASS418 predecessor history preserved; changed source and measured layer drift rejected');
