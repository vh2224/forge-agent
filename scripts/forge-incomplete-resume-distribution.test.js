'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/interrupted-owner/distribution.cjs');
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
