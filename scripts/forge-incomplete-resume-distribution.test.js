'use strict';
const issue463SourceConsumer = require('./fixtures/issue-463/distribution.cjs');
issue463SourceConsumer.validateSourceConsumer(() => {

const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),layer=require('./fixtures/issue-463/distribution.cjs');

// Register callbacks only. Every selected group builds its own renderer/setup;
// no validator result is cached and no validator runs while building the roster.
assert.equal(layer.interruptionSources.length, 11, 'actual published375 roster');
assert.equal(layer.supersededSources.length, 7, 'actual published378 roster');
// Only the complete authenticated Native snapshot may enter the old registry
// assertions. Unknown/edited/omitted/duplicated Native rows are refused first.
function nativePredecessorRegistry(rows) {
  const registry = layer.issue463Layer.registry;
  assert.deepStrictEqual(rows, registry.after_rows, 'only the exact authenticated Native registry is accepted');
  return structuredClone(registry.before_rows);
}
function groupContext() {
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
const crypto=require('crypto'),smokePath='scripts/forge-smoke.js',smoke=fs.readFileSync(path.join(root,smokePath),'utf8'),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const historicalSmoke=layer.predecessorSmoke(smoke);
  return { artifacts, smokePath, smoke, hash, historicalSmoke,
    freshRegistration376: layer.ownerRecoveryLayer.retained_spans.fresh_registration,
    nativeEffortFirst: layer.nativeEffortSources[0],
    ownerRecoveryFirst: layer.ownerRecoverySources[0],
    requestRetentionFirst: layer.requestRetentionSources[0],
    fullGuardFirst: layer.fullGuardSources[0] };
}

const CASES = [
  { name: 'core-six-positive-validators-and-all-projections', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke } = groupContext();
    let cases = 0;
assert.equal(layer.validate({artifacts}),true);
assert.equal(hash(layer.previousSmoke(smoke)),layer.layer.sources[smokePath].before);cases++;
assert.throws(()=>layer.previousSmoke(smoke+'\n// foreign outside Section8\n'),/unrecognized smoke changes/);cases++;
const s8=smoke.indexOf('// ── Section 8:'),foreignInside=smoke.slice(0,s8)+smoke.slice(s8).replace('function smokeCliHelpers()', 'function smokeCliHelpersForeign()');assert.notEqual(foreignInside,smoke);assert.throws(()=>layer.previousSmoke(foreignInside),/unrecognized smoke changes/);cases++;
// Preserve the historical independent controls against their exact predecessor.
// Current-source tampering is independently rejected by previousSmoke above.
assert.equal(layer.supersededSources.length,7);assert.strictEqual(layer.validate({artifacts}),true);
assert(layer.nativeEffortSources.length>0,'native-effort source census cannot be empty');
assert.strictEqual(layer.validate({artifacts}),true);
{
 const review=JSON.parse(fs.readFileSync(path.join(root,'scripts/fixtures/review-policy/distribution-delta.json'))),file='skills/forge-next/SKILL.md',historic=review.files[file].after,actual=hash(fs.readFileSync(path.join(root,file)));
 assert.notStrictEqual(historic,actual);assert.strictEqual(layer.after('files',file,historic),actual);assert.strictEqual(layer.after('files',file,historic),actual);
 assert.throws(()=>layer.after('files',file,'0'.repeat(64)),'unknown historical hash remains refused');
 const guard=require(path.join(root,'scripts/forge-dispatch-source-guard.js')),current=nativePredecessorRegistry(guard.SOURCE_REGISTRY),old=layer.previousRegistry(current);assert.equal(current.length,256);assert.equal(layer.projectRegistry(current).length,254);assert.equal(old.length,248);
 assert.deepStrictEqual(layer.previousRegistry(current),old,'repeated projection changes neither source nor history');
 assert.throws(()=>layer.previousRegistry(current.slice(1)),'omitted current registry row');
 assert.throws(()=>layer.previousRegistry([...current,current[0]]),'extra/duplicated current registry row');
 const changed=current.map(row=>({...row}));changed[0].classification=changed[0].classification==='operational'?'excluded':'operational';assert.throws(()=>layer.previousRegistry(changed),'classification cannot self-repin');
 const metadata=structuredClone(layer.nativeEffortLayer);metadata.registry.before_rows[0].reason+=' forged';metadata.registry.before_sha256=hash(JSON.stringify(metadata.registry.before_rows));assert.throws(()=>layer.previousRegistry(current,metadata),'historical row+metadata self-repin');
}
assert(layer.ownerRecoverySources.length>0,'owner-recovery source census cannot be empty');
assert([0,2,4].includes(layer.ownerRecoveryLayer.samples.nodes.length),'only actual existing changed task/next citations');
assert.strictEqual(layer.validate({artifacts}),true);
const freshRegistration376=layer.ownerRecoveryLayer.retained_spans.fresh_registration;
assert.deepStrictEqual(Object.keys(layer.ownerRecoveryLayer.retained_spans),['fresh_registration','new_initialization']);
assert.deepStrictEqual(layer.retainedSpanAfter('fresh_registration',freshRegistration376.before),freshRegistration376.after);
let retained376Cases=0;
for(const call of [
 ()=>layer.retainedSpanAfter('foreign',freshRegistration376.before),
 ()=>layer.retainedSpanAfter('fresh_registration',{...freshRegistration376.before,bytes:freshRegistration376.before.bytes+1}),
 ()=>layer.retainedSpanAfter('fresh_registration',{...freshRegistration376.before,sha256:'0'.repeat(64)}),
 ()=>layer.retainedSpanAfter('fresh_registration',{bytes:1803,sha256:'b0d14d5ba51b0096922338482ad357c77a193e5af4097616fbdc469681ee7874'})
]){assert.throws(call);retained376Cases++;}
for(const mutate of [value=>{value.retained_spans.foreign=structuredClone(value.retained_spans.fresh_registration);},value=>{delete value.retained_spans.fresh_registration;},value=>{value.retained_spans.fresh_registration.after={bytes:7,sha256:hash(Buffer.from('forged!'))};}]){
 const value=structuredClone(layer.ownerRecoveryLayer);mutate(value);assert.throws(()=>layer.retainedSpanAfter('fresh_registration',freshRegistration376.before,value));retained376Cases++;
}
const initialization376=layer.ownerRecoveryLayer.retained_spans.new_initialization;
assert.deepStrictEqual(layer.retainedSpanAfter('new_initialization',initialization376.before),initialization376.after);
let initialization376Cases=0;
for(const prior of [{...initialization376.before,bytes:initialization376.before.bytes+1},{...initialization376.before,sha256:'0'.repeat(64)}]){assert.throws(()=>layer.retainedSpanAfter('new_initialization',prior));initialization376Cases++;}
for(const mutate of [value=>{value.retained_spans.new_initialization.markers.extra=1;},value=>{value.retained_spans.new_initialization.after={bytes:7,sha256:hash(Buffer.from('forged!'))};},value=>{delete value.retained_spans.new_initialization;}]){const value=structuredClone(layer.ownerRecoveryLayer);mutate(value);assert.throws(()=>layer.retainedSpanAfter('new_initialization',initialization376.before,value));initialization376Cases++;}
for(const key of ['brief_template_lf','request_builder_lf']){const prior=Object.freeze({bytes:1,sha256:'identity-sentinel'});assert.strictEqual(layer.retainedSpanAfter(key,prior),prior,'unchanged span expected side is not relaxed or repinned');}
{
 const rows=nativePredecessorRegistry(require(path.join(root,'scripts/forge-dispatch-source-guard.js')).SOURCE_REGISTRY);
 assert.equal(rows.length,256);assert.equal(layer.projectRegistry(rows).length,254);assert.equal(layer.previousRegistry(rows).length,248);
 for(const changed of [rows.slice(1),[...rows,rows[0]],rows.map((r,i)=>i?{...r}:{...r,classification:'foreign'})])assert.throws(()=>layer.previousRegistry(changed));
 for(const mutate of [v=>{v.registry.after_rows[0].classification='foreign';v.registry.after_sha256=hash(JSON.stringify(v.registry.after_rows));},v=>{v.registry.before_rows[0].reason+=' forged';v.registry.before_sha256=hash(JSON.stringify(v.registry.before_rows));},v=>{v.registry.foreign=true;}]){const value=structuredClone(layer.ownerRecoveryLayer);mutate(value);assert.throws(()=>layer.previousRegistry(rows,value));}
}
assert(layer.requestRetentionSources.length>0,'request-retention source census cannot be empty');
let requestRetentionCases=0;
{
 const rows=nativePredecessorRegistry(require(path.join(root,'scripts/forge-dispatch-source-guard.js')).SOURCE_REGISTRY);
 assert.equal(rows.length,256);assert.equal(layer.projectRegistry(rows).length,254);assert.equal(layer.ownerRecoveryLayer.registry.before_count,252);assert.equal(layer.previousRegistry(rows).length,248);
 for(const changed of [rows.slice(1),[...rows,rows[0]],rows.map((row,i)=>i?row:{...row,classification:'foreign'})]){assert.throws(()=>layer.previousRegistry(changed));requestRetentionCases++;}
}
assert.equal(layer.validate({artifacts}),true);
assert(layer.fullGuardSources.length>0,'full-guard source census cannot be empty');
let fullGuardCases=0;
{
 const rows=nativePredecessorRegistry(require(path.join(root,'scripts/forge-dispatch-source-guard.js')).SOURCE_REGISTRY);
 assert.equal(rows.length,256);assert.equal(layer.projectRegistry(rows).length,254);assert.equal(layer.ownerRecoveryLayer.registry.before_count,252);assert.equal(layer.previousRegistry(rows).length,248);
 for(const changed of [rows.slice(1),[...rows,rows[0]],rows.map((row,i)=>i?row:{...row,classification:'foreign'})]){assert.throws(()=>layer.previousRegistry(changed));fullGuardCases++;}
}
assert.equal(layer.validate({artifacts}),true);
  } },
  { name: '367-fields-and-raw-source-negatives', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let cases = 0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.layer);value.surfaces.skills[field]='0'.repeat(64);assert.throws(()=>layer.validate({artifacts,layerValue:value}));cases++;
}
for(const file of ['scripts/forge-unit-controller.js','scripts/fixtures/unit-entry/distribution-delta.json','scripts/fixtures/incomplete-resume/README.md','docs/communication-evaluation/README.md']){
 assert.throws(()=>layer.validate({artifacts,readRaw:rel=>{const b=fs.readFileSync(path.join(root,rel));return rel===file?Buffer.from('stale bytes'):b;}}));cases++;
}
  } },
  { name: '367-metadata-and-rendered-negatives', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let cases = 0;
for(const mutate of [v=>{v.surfaces.extra=v.surfaces.skills;},v=>{delete v.surfaces.skills;},v=>{v.files['skills/foreign/SKILL.md']=v.files[layer.layerFiles[0]];},v=>{delete v.files[layer.layerFiles[0]];},v=>{v.sources.extra=v.sources[layer.layerSources[0]];},v=>{delete v.sources[layer.layerSources[0]];}]){
 const value=structuredClone(layer.layer);mutate(value);assert.throws(()=>layer.validate({artifacts,layerValue:value}));cases++;
}
assert.throws(()=>layer.validate({artifacts:artifacts.map(a=>a.source==='skills/forge-config/SKILL.md'?{...a,content:a.content+'\nforeign edit\n'}:a)}));cases++;
  } },
  { name: '367-independent-smoke-negatives', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let cases = 0;
const foreignOutside=historicalSmoke+'\n// self-repinned foreign outside Section8\n',repinned=structuredClone(layer.layer);repinned.sources[smokePath].after=hash(foreignOutside);repinned.sources[smokePath].attributed_after=hash(foreignOutside);assert.throws(()=>layer.validate({artifacts,layerValue:repinned,readRaw:rel=>rel===smokePath?Buffer.from(foreignOutside):fs.readFileSync(path.join(root,rel))}),/unrecognized smoke changes outside Section8/);cases++;
for(const field of ['before','after','outside']){const value=structuredClone(layer.layer);value.smoke[field]='0'.repeat(64);assert.throws(()=>layer.validate({artifacts,layerValue:value}));cases++;}
const weakenedInside=historicalSmoke.replace("assert(explicit.status === 'refuse' &&","assert(true || explicit.status === 'refuse' &&");assert.notEqual(weakenedInside,historicalSmoke);const repinnedInside=structuredClone(layer.layer);repinnedInside.sources[smokePath].after=hash(weakenedInside);repinnedInside.sources[smokePath].attributed_after=hash(weakenedInside);const historicalS8=historicalSmoke.indexOf('// ── Section 8:');repinnedInside.smoke.after=hash(weakenedInside.slice(historicalS8,weakenedInside.indexOf('// ── Section 9:',historicalS8)));assert.throws(()=>layer.validate({artifacts,layerValue:repinnedInside,readRaw:rel=>rel===smokePath?Buffer.from(weakenedInside):fs.readFileSync(path.join(root,rel))}),/unrecognized smoke changes: independent Section8 after/);cases++;
  } },
  { name: '375-fields-and-immutable-negatives', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let ownerCases = 0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.interruptionLayer),file=layer.interruptionSources[0];
 value.sources[file][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:value}));ownerCases++;
}
for(const file of ['scripts/fixtures/incomplete-resume/distribution.cjs','scripts/fixtures/incomplete-resume/distribution-delta.json','scripts/fixtures/incomplete-resume/README.md']){
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('tampered historical fixture'):fs.readFileSync(path.join(root,relative))}),
  /#375 immutable historical fixture/);ownerCases++;
}
  } },
  { name: '375-metadata-and-first-source', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let ownerCases = 0;
for(const mutate of [value=>{value.sources.extra=value.sources[layer.interruptionSources[0]];},
 value=>{delete value.sources[layer.interruptionSources[0]];},
 value=>{value.provenance.base_revision='0'.repeat(40);},
 value=>{value.sources[layer.interruptionSources[0]].approved=true;},
 value=>{value.sources[layer.interruptionSources[0]].before_gzip_base64=Buffer.from('foreign prior').toString('base64');}]){
 const value=structuredClone(layer.interruptionLayer);mutate(value);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:value}));ownerCases++;
}
for(const file of layer.interruptionSources.slice(0,1)){
 const raw=fs.readFileSync(path.join(root,file)),foreign=Buffer.concat([raw,Buffer.from('\n// foreign edit outside declared375 bytes\n')]);
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));ownerCases++;
 const repinned=structuredClone(layer.interruptionLayer);repinned.sources[file].after=hash(foreign);repinned.sources[file].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:repinned,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}),
  /#375 independent committed\/measured after/);ownerCases++;
}
  } },
  { name: '375-sources-02-through-05', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let ownerCases = 0;
for(const file of layer.interruptionSources.slice(1,5)){
 const raw=fs.readFileSync(path.join(root,file)),foreign=Buffer.concat([raw,Buffer.from('\n// foreign edit outside declared375 bytes\n')]);
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));ownerCases++;
 const repinned=structuredClone(layer.interruptionLayer);repinned.sources[file].after=hash(foreign);repinned.sources[file].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:repinned,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}),
  /#375 independent committed\/measured after/);ownerCases++;
}
  } },
  { name: '375-sources-06-through-09', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let ownerCases = 0;
for(const file of layer.interruptionSources.slice(5,9)){
 const raw=fs.readFileSync(path.join(root,file)),foreign=Buffer.concat([raw,Buffer.from('\n// foreign edit outside declared375 bytes\n')]);
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));ownerCases++;
 const repinned=structuredClone(layer.interruptionLayer);repinned.sources[file].after=hash(foreign);repinned.sources[file].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:repinned,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}),
  /#375 independent committed\/measured after/);ownerCases++;
}
  } },
  { name: '375-sources-10-through-11', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let ownerCases = 0;
for(const file of layer.interruptionSources.slice(9,11)){
 const raw=fs.readFileSync(path.join(root,file)),foreign=Buffer.concat([raw,Buffer.from('\n// foreign edit outside declared375 bytes\n')]);
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));ownerCases++;
 const repinned=structuredClone(layer.interruptionLayer);repinned.sources[file].after=hash(foreign);repinned.sources[file].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,terminalLayerValue:repinned,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}),
  /#375 independent committed\/measured after/);ownerCases++;
}
  } },
  { name: '378-fields-and-immutable-negatives', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let supersededCases = 0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.supersededLayer),file=layer.supersededSources[0];value.sources[file][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,supersededLayerValue:value}));supersededCases++;
}
for(const file of ['scripts/fixtures/interrupted-owner/distribution.cjs','scripts/fixtures/interrupted-owner/distribution-delta.json','scripts/fixtures/interrupted-owner/README.md','scripts/forge-milestone-endpoint.test.js']){
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('tampered preserved375 bytes'):fs.readFileSync(path.join(root,relative))}));supersededCases++;
}
  } },
  { name: '378-metadata-negatives', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let supersededCases = 0;
for(const mutate of [value=>{value.sources.extra=value.sources[layer.supersededSources[0]];},
 value=>{delete value.sources[layer.supersededSources[0]];},value=>{value.provenance.base_revision='0'.repeat(40);},
 value=>{value.sources[layer.supersededSources[0]].approved=true;},
 value=>{value.sources[layer.supersededSources[0]].before_gzip_base64=Buffer.from('not the real Git before').toString('base64');}]){
 const value=structuredClone(layer.supersededLayer);mutate(value);assert.throws(()=>layer.validate({artifacts,supersededLayerValue:value}));supersededCases++;
}
  } },
  { name: '378-sources-01-through-04', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let supersededCases = 0;
for(const file of layer.supersededSources.slice(0,4)){
 const raw=fs.readFileSync(path.join(root,file)),foreign=Buffer.concat([raw,Buffer.from('\n// foreign378 byte edit\n')]);
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));supersededCases++;
 const repinned=structuredClone(layer.supersededLayer);repinned.sources[file].after=hash(foreign);repinned.sources[file].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,supersededLayerValue:repinned,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));supersededCases++;
}
  } },
  { name: '378-sources-05-through-07', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let supersededCases = 0;
for(const file of layer.supersededSources.slice(4,7)){
 const raw=fs.readFileSync(path.join(root,file)),foreign=Buffer.concat([raw,Buffer.from('\n// foreign378 byte edit\n')]);
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));supersededCases++;
 const repinned=structuredClone(layer.supersededLayer);repinned.sources[file].after=hash(foreign);repinned.sources[file].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,supersededLayerValue:repinned,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));supersededCases++;
}
  } },
  { name: '381-fields-and-metadata', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let nativeEffortCases = 0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.nativeEffortLayer);value.files[nativeEffortFirst][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,nativeEffortLayerValue:value}));nativeEffortCases++;
}
for(const mutate of [value=>{delete value.files[nativeEffortFirst];},value=>{value.files.foreign=value.files[nativeEffortFirst];},value=>{value.provenance.base_revision='0'.repeat(40);}]){
 const value=structuredClone(layer.nativeEffortLayer);mutate(value);assert.throws(()=>layer.validate({artifacts,nativeEffortLayerValue:value}));nativeEffortCases++;
}
  } },
  { name: '381-repinned-sample-and-immutable', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let nativeEffortCases = 0;
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
  } },
  { name: 'owner-fields-and-metadata', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let ownerRecoveryCases = 0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.ownerRecoveryLayer);value.files[ownerRecoveryFirst][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,ownerRecoveryLayerValue:value}));ownerRecoveryCases++;
}
for(const mutate of [value=>{delete value.files[ownerRecoveryFirst];},value=>{value.files.foreign=value.files[ownerRecoveryFirst];},value=>{value.provenance.base_revision='0'.repeat(40);},value=>{value.provenance.approved=true;}]){
 const value=structuredClone(layer.ownerRecoveryLayer);mutate(value);assert.throws(()=>layer.validate({artifacts,ownerRecoveryLayerValue:value}));ownerRecoveryCases++;
}
  } },
  { name: 'owner-repinned-and-immutable', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let ownerRecoveryCases = 0;
{
 const raw=fs.readFileSync(path.join(root,ownerRecoveryFirst)),foreign=Buffer.concat([raw,Buffer.from('\nforeign owner-recovery bytes\n')]);
 const value=structuredClone(layer.ownerRecoveryLayer);value.files[ownerRecoveryFirst].after=hash(foreign);value.files[ownerRecoveryFirst].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,ownerRecoveryLayerValue:value,readRaw:file=>file===ownerRecoveryFirst?foreign:fs.readFileSync(path.join(root,file))}));ownerRecoveryCases++;
}
for(const file of ['scripts/fixtures/native-effort/distribution.cjs','scripts/fixtures/native-effort/distribution-delta.json','scripts/fixtures/native-effort/README.md']){
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('foreign preserved native-effort bytes'):fs.readFileSync(path.join(root,relative))}));ownerRecoveryCases++;
}
  } },
  { name: '376-registration-source-edit', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let retained376Cases = 0;
{
 const file=freshRegistration376.file,raw=fs.readFileSync(path.join(root,file)),text=raw.toString('utf8'),a=text.indexOf('**Register in multi-run registry**'),b=text.indexOf('\nThis makes the task visible',a);assert(a>=0&&b>a);
 const foreign=Buffer.from(text.slice(0,a)+text.slice(a,b+1).replace('Register','REGISTER')+text.slice(b+1));
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?foreign:fs.readFileSync(path.join(root,relative))}));retained376Cases++;
}
  } },
  { name: '382-fields-and-immutable', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let requestRetentionCases = 0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.requestRetentionLayer);value.files[requestRetentionFirst][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,requestRetentionLayerValue:value}));requestRetentionCases++;
}
for(const file of ['scripts/fixtures/owner-recovery/distribution.cjs','scripts/fixtures/owner-recovery/distribution-delta.json','scripts/fixtures/owner-recovery/README.md','scripts/forge-dispatch-source-guard.js']){
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('foreign immutable predecessor/scanner'):fs.readFileSync(path.join(root,relative))}));requestRetentionCases++;
}
  } },
  { name: '382-metadata-and-repinned', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let requestRetentionCases = 0;
for(const mutate of [value=>{delete value.files[requestRetentionFirst];},value=>{value.files.foreign=value.files[requestRetentionFirst];},value=>{value.provenance.base_revision='0'.repeat(40);},value=>{value.provenance.approved=true;},value=>{value.registry.after_rows[0].classification='foreign';value.registry.after_sha256=hash(JSON.stringify(value.registry.after_rows));},value=>{value.registry.before_rows[0].reason+=' forged';value.registry.before_sha256=hash(JSON.stringify(value.registry.before_rows));},value=>{value.registry.foreign=true;}]){
 const value=structuredClone(layer.requestRetentionLayer);mutate(value);assert.throws(()=>layer.validate({artifacts,requestRetentionLayerValue:value}));requestRetentionCases++;
}
{
 const raw=fs.readFileSync(path.join(root,requestRetentionFirst)),foreign=Buffer.concat([raw,Buffer.from('\nforeign request-retention bytes\n')]);
 const value=structuredClone(layer.requestRetentionLayer);value.files[requestRetentionFirst].after=hash(foreign);value.files[requestRetentionFirst].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,requestRetentionLayerValue:value,readRaw:file=>file===requestRetentionFirst?foreign:fs.readFileSync(path.join(root,file))}));requestRetentionCases++;
}
  } },
  { name: '385-fields-and-immutable', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let fullGuardCases = 0;
for(const field of ['before','after','attributed_before','attributed_after']){
 const value=structuredClone(layer.fullGuardLayer);value.files[fullGuardFirst][field]='0'.repeat(64);
 assert.throws(()=>layer.validate({artifacts,fullGuardLayerValue:value}));fullGuardCases++;
}
for(const file of ['scripts/fixtures/request-retention/distribution.cjs','scripts/fixtures/request-retention/distribution-delta.json','scripts/fixtures/request-retention/README.md','scripts/forge-dispatch-source-guard.js']){
 assert.throws(()=>layer.validate({artifacts,readRaw:relative=>relative===file?Buffer.from('foreign immutable predecessor/scanner'):fs.readFileSync(path.join(root,relative))}));fullGuardCases++;
}
  } },
  { name: '385-metadata-and-repinned', fn() {
    const { artifacts, smokePath, smoke, hash, historicalSmoke, freshRegistration376, nativeEffortFirst, ownerRecoveryFirst, requestRetentionFirst, fullGuardFirst } = groupContext();
    let fullGuardCases = 0;
for(const mutate of [value=>{delete value.files[fullGuardFirst];},value=>{value.files.foreign=value.files[fullGuardFirst];},value=>{value.provenance.base_revision='0'.repeat(40);},value=>{value.provenance.approved=true;},value=>{value.registry.after_rows[0].classification='foreign';value.registry.after_sha256=hash(JSON.stringify(value.registry.after_rows));},value=>{value.registry.before_rows[0].reason+=' forged';value.registry.before_sha256=hash(JSON.stringify(value.registry.before_rows));},value=>{value.registry.foreign=true;}]){
 const value=structuredClone(layer.fullGuardLayer);mutate(value);assert.throws(()=>layer.validate({artifacts,fullGuardLayerValue:value}));fullGuardCases++;
}
{
 const raw=fs.readFileSync(path.join(root,fullGuardFirst)),foreign=Buffer.concat([raw,Buffer.from('\nforeign full-guard bytes\n')]);
 const value=structuredClone(layer.fullGuardLayer);value.files[fullGuardFirst].after=hash(foreign);value.files[fullGuardFirst].attributed_after=hash(foreign);
 assert.throws(()=>layer.validate({artifacts,fullGuardLayerValue:value,readRaw:file=>file===fullGuardFirst?foreign:fs.readFileSync(path.join(root,file))}));fullGuardCases++;
}
  } },
];
assert.equal(CASES.length, 22);
const selected = require('./forge-ci-units').selectCases(CASES);
for (const { fn } of selected) fn();
console.log(selected.length === CASES.length
  ? 'PASS incomplete-resume: six positives, all138 named negatives and original projection controls'
  : 'PASS incomplete-resume selected cohorts only: ' + selected.map(row => row.name).join(', '));
});
