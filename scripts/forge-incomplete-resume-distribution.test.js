'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/incomplete-resume/distribution.cjs');
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
