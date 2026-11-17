'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issue-416/distribution.cjs'),artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);
const wrong=structuredClone(layer.issue407Layer);wrong.provenance.base_revision='0'.repeat(40);assert.throws(()=>layer.validate({artifacts,issue407LayerValue:wrong}));
for(const file of ['CLAUDE.md','scripts/forge-instructions.js','scripts/forge-interaction.js','scripts/forge-installer.js','scripts/forge-codex-renderer.js','shared/forge-instruction-context.md'])assert.throws(()=>layer.validate({artifacts,readRaw:rel=>rel===file?Buffer.from('foreign drift'):fs.readFileSync(path.join(root,rel))}));
assert.throws(()=>layer.validate({artifacts:artifacts.map(a=>a.source==='CLAUDE.md'?{...a,content:a.content+'foreign drift'}:a)}));
const saved=layer.issue407Layer.provenance.base_revision;try{layer.issue407Layer.provenance.base_revision='0'.repeat(40);for(const call of [()=>layer.projectGolden({surfaces:[]}),()=>layer.after('files','CLAUDE.md',''),()=>layer.previousSamples(''),()=>layer.previousSmoke(''),()=>layer.sampleAfter('','')])assert.throws(call,/independent measured delta/);}finally{layer.issue407Layer.provenance.base_revision=saved;}
assert.equal(layer.issue407Layer.provenance.base_revision,'94b891614e125300c303d42ec7346b1b833667bf');
console.log('PASS407 independent exact94b successor, immutable405406/history, compact entry/raw/rendered and exported-metadata drift rejection');
