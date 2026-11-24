'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),layer=require('./fixtures/docs-cleanup/distribution.cjs'),parent=require('./fixtures/issues-457-458/distribution.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(path.join(ROOT,f)),data=layer.docsCleanupLayer;
assert.equal(data.base_revision,'b8f1df6d0020d0a8fb0d7d2ecdcdd7027459445e');
assert.equal(data.provenance.consumer_paths.length,34);
assert.equal(Object.keys(data.historical_fixtures).length,224,'all published ancestors, including unchanged457, retained');
assert.equal(layer.verifyCleanup(),true);
const proposal=read('scripts/fixtures/docs-cleanup/proposal.md');
assert.equal(proposal.length,13754);
assert.equal(hash(proposal),'fc0b24c8eac217b8e8a263a44ed10f5bad2b1ac942447160237bbee37b487d51');
assert.equal(hash(proposal.subarray(0,12496)),'aa2d8a09f8d129ba1370506a6fda375627ed145225cb64280358315b6abbbb48');
const retired=Object.keys(data.files).filter(f=>data.files[f].after===null);
assert.deepEqual(retired,['docs/PENDENCIA-CONTEXTO-DE-ENTRADA.md','docs/milestone-time-options.md']);
const projected=layer.projectCleanupRead(read);
for(const file of retired){assert(!fs.existsSync(path.join(ROOT,file)));assert.equal(hash(projected(file)),data.files[file].before);}
for(const[file,row]of Object.entries(data.files))if(row.before!==null&&row.after!==null)assert.equal(hash(projected(file)),row.before,'exact B8 source view '+file);
const foreign=Buffer.from('unrecognized future documentation bytes\n');
assert(projected('forge-source-manifest.json').equals(read('forge-source-manifest.json')),'unknown sources pass unchanged');
assert(layer.projectCleanupRead(()=>foreign)('docs/instructions-context/README.md').equals(foreign),'unknown bytes never self-project');
let calls=0;const saved=parent.validate;
try{
 parent.validate=()=>{calls++;return 'one-ancestor-result';};
 assert.equal(layer.validate({}), 'one-ancestor-result');assert.equal(calls,1);
 const negative=options=>{const before=calls;assert.throws(()=>layer.validate(options));assert.equal(calls,before,'current refusal precedes ancestor call');};
 const metadata=structuredClone(data);metadata.files[retired[0]].after='0'.repeat(64);negative({docsCleanupLayerValue:metadata});
 const future=structuredClone(data);future.files['docs/foreign.md']=future.files[retired[0]];negative({docsCleanupLayerValue:future});
 // Physical inventory controls are synchronous and restore their exact owned file.
 // This test is a temporary source writer; endpoint equality is not a no-write claim.
 for(const dir of ['scripts/fixtures/docs-cleanup','scripts/fixtures']){
  const file=path.resolve(ROOT,dir,'docs-cleanup-future-'+crypto.randomUUID()+'.md');
  assert(file.startsWith(path.resolve(ROOT,'scripts/fixtures')+path.sep));
  const bytes=Buffer.from('owned future fixture probe\n');
  fs.writeFileSync(file,bytes,{flag:'wx'});const created=fs.lstatSync(file);
  try{negative({});}
  finally{const current=fs.lstatSync(file);assert.equal(current.dev,created.dev);assert.equal(current.ino,created.ino);assert.equal(hash(fs.readFileSync(file)),hash(bytes));fs.unlinkSync(file);}
 }
 assert.equal(layer.verifyCleanup(),true,'complete inventory restored after both physical negatives');
}finally{parent.validate=saved;}
const artifacts=require('./forge-claude-renderer').render({repo:ROOT,projectRoot:ROOT,claudeHome:path.join(ROOT,'unused-claude'),forgeHome:path.join(ROOT,'unused-core')}).artifacts;
let realCalls=0;
try{parent.validate=options=>{realCalls++;return saved(options);};assert.equal(layer.validate({artifacts}),true);assert.equal(realCalls,1,'one real complete ancestor validation');}
finally{parent.validate=saved;}
// Virtual negative callbacks reach the unchanged ancestor, preserving its refusal.
for(const file of ['docs/instructions-context/README.md','scripts/forge-claude-renderer.test.js','scripts/fixtures/issue-455/distribution.cjs']){
 let n=0;try{parent.validate=options=>{n++;return saved(options);};assert.throws(()=>layer.validate({artifacts,readRaw:f=>f===file?foreign:read(f)}));assert.equal(n,1,'one authoritative ancestor virtual refusal');}finally{parent.validate=saved;}
}
for(const name of ['scripts/fixtures/issues-442-446/distribution.cjs','scripts/fixtures/issues-429-432/distribution.cjs']){
 const ancestor=layer.loadHistoricalFixture(name),original=ancestor.after;let n=0;
 try{ancestor.after=(...args)=>{n++;return original(...args);};assert.equal(layer.after('files','__docs_counter__',''),'');assert.equal(n,1,'live private predecessor setter');}
 finally{ancestor.after=original;}
}
const changed='scripts/forge-claude-renderer.test.js',row=data.files[changed],prior=JSON.parse(read('scripts/fixtures/milestone-options/distribution-before.json')).sources.find(x=>x.path===changed).sha256;
assert.equal(layer.after('files',changed,prior),row.after);
assert.equal(layer.baselineView.after('files',changed,prior),row.before);
assert.throws(()=>layer.after('files',changed,'0'.repeat(64)),'unknown prior is refused by original chain');
assert.equal(hash(layer.projectRead(read)(changed)),layer.issues457458Layer.files[changed].before,'exported read projection composes exact new to B8 to C285');
assert(layer.projectRead(()=>foreign)(changed).equals(foreign),'composed read never adopts unknown bytes');
const readmeOriginal=parent.readme;let readmeCalls=0;
try{parent.readme=text=>{readmeCalls++;assert.equal(text,'foreign caller text');return text;};assert(layer.readme('foreign caller text').startsWith('foreign caller text\n'));assert.equal(readmeCalls,1,'one live README predecessor call');}finally{parent.readme=readmeOriginal;}
for(const [method,args]of [['after',['files',changed,prior]],['readme',['foreign caller text']]]){
 const original=layer[method],expected=original(...args);let n=0;
 try{layer[method]=(...input)=>{n++;return original(...input);};assert.equal(layer[method](...args),expected);assert.equal(n,1,'current export spy calls saved wrapper once');}
 finally{layer[method]=original;}
 assert.strictEqual(layer[method],original,'current export restore preserves function identity');assert.equal(layer[method](...args),expected,'current export restore composes exactly once');
}
const ownReadme=path.join(ROOT,'scripts/fixtures/docs-cleanup/README.md'),originalReadme=fs.readFileSync(ownReadme),originalStat=fs.lstatSync(ownReadme),probe=Buffer.concat([originalReadme,Buffer.from('\nowned README negative '+crypto.randomUUID()+'\n')]);
let rejectedReadmeCalls=0;
try{parent.readme=()=>{rejectedReadmeCalls++;return 'ancestor should not run';};fs.writeFileSync(ownReadme,probe);assert.throws(()=>layer.readme('caller text'),/docs cleanup exact current README/);assert.equal(rejectedReadmeCalls,0);}
finally{parent.readme=readmeOriginal;const now=fs.lstatSync(ownReadme);assert.equal(now.dev,originalStat.dev);assert.equal(now.ino,originalStat.ino);assert.equal(hash(fs.readFileSync(ownReadme)),hash(probe));fs.writeFileSync(ownReadme,originalReadme);}
assert.equal(layer.verifyCleanup(),true,'README exact bytes restored after isolated negative');
for(const digest of [row.before,row.after,row.attributed_before,row.attributed_after])assert(layer.readme('foreign text').includes(digest),'measured source hashes documented');
assert.strictEqual(layer.loadHistoricalFixture('scripts/fixtures/issue-455/distribution.cjs'),layer.loadHistoricalFixture('scripts/fixtures/issue-455/distribution.cjs'),'cached private historical identity');
console.log('PASS docs cleanup: exact archive,224 immutable ancestors, complete fixture census, one delegation, current/foreign/future refusal controls');
