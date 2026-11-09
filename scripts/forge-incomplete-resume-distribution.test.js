'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/native-effort/distribution.cjs');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);
let cases=0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.layer);value.surfaces.skills[field]='0'.repeat(64);assert.throws(()=>layer.validate({artifacts,layerValue:value}));cases++;
}
for(const mutate of [v=>{v.surfaces.extra=v.surfaces.skills;},v=>{delete v.surfaces.skills;},v=>{v.files['skills/foreign/SKILL.md']=v.files[layer.layerFiles[0]];},v=>{delete v.files[layer.layerFiles[0]];},v=>{v.sources.extra=v.sources[layer.layerSources[0]];},v=>{delete v.sources[layer.layerSources[0]];}]){
 const value=structuredClone(layer.layer);mutate(value);assert.throws(()=>layer.validate({artifacts,layerValue:value}));cases++;
}
assert.throws(()=>layer.validate({artifacts:artifacts.map(a=>a.source==='skills/forge-config/SKILL.md'?{...a,content:a.content+'\nforeign edit\n'}:a)}));cases++;
for(const file of ['scripts/forge-unit-controller.js','scripts/fixtures/unit-entry/distribution-delta.json','scripts/fixtures/incomplete-resume/README.md','docs/communication-evaluation/README.md']){
 assert.throws(()=>layer.validate({artifacts,readRaw:rel=>{const b=fs.readFileSync(path.join(root,rel));return rel===file?Buffer.from('stale bytes'):b;}}));cases++;
}
const crypto=require('crypto'),smokePath='scripts/forge-smoke.js',smoke=fs.readFileSync(path.join(root,smokePath),'utf8'),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
assert.equal(hash(layer.previousSmoke(smoke)),layer.layer.sources[smokePath].before);cases++;
assert.throws(()=>layer.previousSmoke(smoke+'\n// foreign outside Section8\n'),/unrecognized smoke changes/);cases++;
const s8=smoke.indexOf('// ── Section 8:'),foreignInside=smoke.slice(0,s8)+smoke.slice(s8).replace('function smokeCliHelpers()', 'function smokeCliHelpersForeign()');assert.notEqual(foreignInside,smoke);assert.throws(()=>layer.previousSmoke(foreignInside),/unrecognized smoke changes/);cases++;
const foreignOutside=smoke+'\n// self-repinned foreign outside Section8\n',repinned=structuredClone(layer.layer);repinned.sources[smokePath].after=hash(foreignOutside);repinned.sources[smokePath].attributed_after=hash(foreignOutside);assert.throws(()=>layer.validate({artifacts,layerValue:repinned,readRaw:rel=>rel===smokePath?Buffer.from(foreignOutside):fs.readFileSync(path.join(root,rel))}),/unrecognized smoke changes outside Section8/);cases++;
for(const field of ['before','after','outside']){const value=structuredClone(layer.layer);value.smoke[field]='0'.repeat(64);assert.throws(()=>layer.validate({artifacts,layerValue:value}));cases++;}
const weakenedInside=smoke.replace("assert(explicit.status === 'refuse' &&","assert(true || explicit.status === 'refuse' &&");assert.notEqual(weakenedInside,smoke);const repinnedInside=structuredClone(layer.layer);repinnedInside.sources[smokePath].after=hash(weakenedInside);repinnedInside.sources[smokePath].attributed_after=hash(weakenedInside);repinnedInside.smoke.after=hash(weakenedInside.slice(s8,weakenedInside.indexOf('// ── Section 9:',s8)));assert.throws(()=>layer.validate({artifacts,layerValue:repinnedInside,readRaw:rel=>rel===smokePath?Buffer.from(weakenedInside):fs.readFileSync(path.join(root,rel))}),/unrecognized smoke changes: independent Section8 after/);cases++;
console.log('PASS #367 additive distribution: exact8856 chain, full prior validators and '+cases+' bounded negative cases');

// #375 is a separate next terminal. Every #367 assertion above still executes.
let ownerCases=0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.interruptionLayer),file=layer.interruptionSources[0];
 value.sources[file][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:value}));ownerCases++;
}
for(const mutate of [value=>{value.sources.extra=value.sources[layer.interruptionSources[0]];},
 value=>{delete value.sources[layer.interruptionSources[0]];},
 value=>{value.provenance.base_revision='0'.repeat(40);},
 value=>{value.sources[layer.interruptionSources[0]].approved=true;},
 value=>{value.sources[layer.interruptionSources[0]].before_gzip_base64=Buffer.from('foreign prior').toString('base64');}]){
 const value=structuredClone(layer.interruptionLayer);mutate(value);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:value}));ownerCases++;
}
for(const file of layer.interruptionSources){
 const raw=fs.readFileSync(path.join(root,file)),foreign=Buffer.concat([raw,Buffer.from('\n// foreign edit outside declared375 bytes\n')]);
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));ownerCases++;
 const repinned=structuredClone(layer.interruptionLayer);repinned.sources[file].after=hash(foreign);repinned.sources[file].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:repinned,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}),
  /#375 independent committed\/measured after/);ownerCases++;
}
for(const file of ['scripts/fixtures/incomplete-resume/distribution.cjs','scripts/fixtures/incomplete-resume/distribution-delta.json','scripts/fixtures/incomplete-resume/README.md']){
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('tampered historical fixture'):fs.readFileSync(path.join(root,relative))}),
  /#375 immutable historical fixture/);ownerCases++;
}
console.log('PASS #375 next distribution terminal: exact source/API delta, historical validators retained and '+ownerCases+' additional bounded negatives');

// #378 wraps #375; every preceding assertion remains byte-identical above.
let supersededCases=0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.supersededLayer),file=layer.supersededSources[0];value.sources[file][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,supersededLayerValue:value}));supersededCases++;
}
for(const mutate of [value=>{value.sources.extra=value.sources[layer.supersededSources[0]];},
 value=>{delete value.sources[layer.supersededSources[0]];},value=>{value.provenance.base_revision='0'.repeat(40);},
 value=>{value.sources[layer.supersededSources[0]].approved=true;},
 value=>{value.sources[layer.supersededSources[0]].before_gzip_base64=Buffer.from('not the real Git before').toString('base64');}]){
 const value=structuredClone(layer.supersededLayer);mutate(value);assert.throws(()=>layer.validate({artifacts,supersededLayerValue:value}));supersededCases++;
}
for(const file of layer.supersededSources){
 const raw=fs.readFileSync(path.join(root,file)),foreign=Buffer.concat([raw,Buffer.from('\n// foreign378 byte edit\n')]);
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));supersededCases++;
 const repinned=structuredClone(layer.supersededLayer);repinned.sources[file].after=hash(foreign);repinned.sources[file].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,supersededLayerValue:repinned,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));supersededCases++;
}
for(const file of ['scripts/fixtures/interrupted-owner/distribution.cjs','scripts/fixtures/interrupted-owner/distribution-delta.json','scripts/fixtures/interrupted-owner/README.md','scripts/forge-milestone-endpoint.test.js']){
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('tampered preserved375 bytes'):fs.readFileSync(path.join(root,relative))}));supersededCases++;
}
assert.equal(layer.supersededSources.length,7);assert.strictEqual(layer.validate({artifacts}),true);
console.log('PASS #378 superseded-owner terminal: seven exact sources, all previous validators and '+supersededCases+' additional bounded negatives');

// #381/#346 additive terminal; every preceding57+27 control remains above.
let nativeEffortCases=0;
assert(layer.nativeEffortSources.length>0,'native-effort source census cannot be empty');
const nativeEffortFirst=layer.nativeEffortSources[0];
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.nativeEffortLayer);value.files[nativeEffortFirst][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,nativeEffortLayerValue:value}));nativeEffortCases++;
}
for(const mutate of [value=>{delete value.files[nativeEffortFirst];},value=>{value.files.foreign=value.files[nativeEffortFirst];},value=>{value.provenance.base_revision='0'.repeat(40);}]){
 const value=structuredClone(layer.nativeEffortLayer);mutate(value);assert.throws(()=>layer.validate({artifacts,nativeEffortLayerValue:value}));nativeEffortCases++;
}
{
 const raw=fs.readFileSync(path.join(root,nativeEffortFirst)),foreign=Buffer.concat([raw,Buffer.from('\nforeign native-effort bytes\n')]);
 const value=structuredClone(layer.nativeEffortLayer);value.files[nativeEffortFirst].after=hash(foreign);value.files[nativeEffortFirst].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,nativeEffortLayerValue:value,readRaw:relative=>relative===nativeEffortFirst?foreign:fs.readFileSync(path.join(root,relative))}));nativeEffortCases++;
}
{
 const value=structuredClone(layer.nativeEffortLayer);assert.equal(value.samples.nodes.length,4);value.samples.nodes[0].after='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,nativeEffortLayerValue:value}));nativeEffortCases++;
}
for(const file of ['scripts/fixtures/superseded-owner/distribution.cjs','scripts/fixtures/superseded-owner/distribution-delta.json','scripts/fixtures/superseded-owner/README.md']){
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('foreign preserved378 bytes'):fs.readFileSync(path.join(root,relative))}));nativeEffortCases++;
}
assert.strictEqual(layer.validate({artifacts}),true);
console.log('PASS #381/#346 native-effort terminal: independent pins, four citation spans, inherited57+27 controls and '+nativeEffortCases+' additive negatives');

// Revision2: multi-hop projection is the expected side of the historical raw-source equality.
{
 const review=JSON.parse(fs.readFileSync(path.join(root,'scripts/fixtures/review-policy/distribution-delta.json'))),file='skills/forge-next/SKILL.md',historic=review.files[file].after,actual=hash(fs.readFileSync(path.join(root,file)));
 assert.notStrictEqual(historic,actual);assert.strictEqual(layer.after('files',file,historic),actual);assert.strictEqual(layer.after('files',file,historic),actual);
 assert.throws(()=>layer.after('files',file,'0'.repeat(64)),'unknown historical hash remains refused');
 const guard=require(path.join(root,'scripts/forge-dispatch-source-guard.js')),current=guard.SOURCE_REGISTRY,old=layer.previousRegistry(current);assert.equal(current.length,252);assert.equal(old.length,248);
 assert.deepStrictEqual(layer.previousRegistry(current),old,'repeated projection changes neither source nor history');
 assert.throws(()=>layer.previousRegistry(current.slice(1)),'omitted current registry row');
 assert.throws(()=>layer.previousRegistry([...current,current[0]]),'extra/duplicated current registry row');
 const changed=current.map(row=>({...row}));changed[0].classification=changed[0].classification==='operational'?'excluded':'operational';assert.throws(()=>layer.previousRegistry(changed),'classification cannot self-repin');
 const metadata=structuredClone(layer.nativeEffortLayer);metadata.registry.before_rows[0].reason+=' forged';metadata.registry.before_sha256=hash(JSON.stringify(metadata.registry.before_rows));assert.throws(()=>layer.previousRegistry(current,metadata),'historical row+metadata self-repin');
}
