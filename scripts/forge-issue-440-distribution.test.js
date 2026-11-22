'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),cp=require('node:child_process');
const layer=require('./fixtures/issue-440/distribution.cjs'),parent=require('./fixtures/issue-448/distribution.cjs');
const root=path.resolve(__dirname,'..'),data=layer.issue440Layer;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=file=>fs.readFileSync(path.join(root,file));
const normalize=text=>String(text).replace(/version=\d+\.\d+\.\d+/g,'version=<dynamic>');
const linked=/^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm;
const attributed=bytes=>hash(bytes.toString('utf8').replace(linked,''));
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
function oneParentCall(method,run){const target=parent;const saved=target[method];let calls=0;try{target[method]=(...args)=>{calls++;return saved(...args);};run();assert.equal(calls,1,'one parent traversal '+method);}finally{target[method]=saved;}}
for(const method of ['validate','validate414Snapshot'])oneParentCall(method,()=>assert.equal(layer[method]({artifacts}),true));
console.log('PASS #440 validate and validate414Snapshot real Claude renderer; one parent traversal each');
assert.equal(data.provenance.base_revision,'4606de1ecac3ddee7bc957d9a8dea3207023d5b5');
assert.equal(data.provenance.previous,'issue-448/distribution.cjs');
assert.deepEqual(data.provenance.issues,[440]);
assert.equal(data.provenance.historical_revision,'fa33d14ead04ce8829a855a771713cac71e58b34');
assert.equal(data.predecessor_layer_sha256,hash(JSON.stringify(parent.issue448Layer)));
assert.equal(layer.issue448Layer,parent.issue448Layer,'published predecessor exported unchanged');
assert.equal(data.files['scripts/forge-unit-sidecar.js'].before,parent.issue448Layer.files['scripts/forge-unit-sidecar.js'].after,'exact runtime predecessor');
for(const name of ['distribution.cjs','distribution-delta.json'])assert(!Object.hasOwn(data.files,'scripts/fixtures/issue-440/'+name),'own layer excluded');
assert(!Object.hasOwn(data.files,'scripts/forge-issue-440-distribution.test.js'),'own test excluded');
assert(Object.hasOwn(data.files,'scripts/fixtures/issue-440/DISTRIBUTION.md'),'README measured');
for(const[file,row]of Object.entries(data.files)){
 assert.equal(hash(read(file)),row.after,'measured current source '+file);
 assert.equal(attributed(read(file)),row.attributed_after,'measured attributed source '+file);
 if(file.startsWith('scripts/fixtures/'))assert.equal(row.before,null,'only new fixtures in files');
 if(row.before===null){assert.equal(row.attributed_before,null);assert.equal(row.before_gzip_base64,null);continue;}
 const before=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});
 assert.equal(hash(before),row.before,'exact preimage '+file);assert.equal(attributed(before),row.attributed_before,'attributed preimage '+file);
}
for(const[key,row]of Object.entries(data.rendered)){
 const a=artifacts.find(x=>x.source_id+'::'+x.source===key);assert(a,'rendered source exists '+key);
 assert.equal(hash(normalize(a.content)),row.after,'current rendered '+key);
 const before=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});
 assert.equal(hash(before),row.before,'rendered exact preimage '+key);
}
console.log('PASS #440 measured files and rendered preimages; base4606; immutable issue448 export and exact unit-sidecar predecessor');
for(const file of ['scripts/forge-managed-surfaces.js','shared/forge-bidirectional-sidecar.md','scripts/forge-attempt-abandon.js','scripts/forge-unit-sidecar.js','.github/workflows/ci.yml','scripts/forge-e2e-evidence.js']){
 assert(Object.hasOwn(data.files,file),'measured S01/S02/S03 source '+file);
 const readRaw=relative=>{const bytes=read(relative);return relative===file?Buffer.concat([bytes,Buffer.from('\n// foreign drift')]):bytes;};
 assert.throws(()=>layer.validate({artifacts,readRaw}),'unmeasured source drift '+file);
 console.log('PASS #440 negative measured source drift '+file);
}
const renderedSource=Object.keys(data.rendered)[0];assert(renderedSource,'milestone rendered delta');
assert.throws(()=>layer.validate({artifacts:artifacts.map(x=>x.source_id+'::'+x.source===renderedSource?{...x,content:x.content+'\nforeign drift'}:x)}),/issue440 measured rendered source/);
const changed=structuredClone(data);changed.provenance.issues=[];
assert.throws(()=>layer.validate({artifacts,issue440LayerValue:changed}),/issue440 independent measured delta/);
console.log('PASS #440 negative rendered drift and tampered provenance');
assert.equal(Object.keys(data.historical_fixtures).length,205,'full anchored historical census');
const historicalList=Object.keys(data.historical_fixtures).join('\n')+'\n';
assert.equal(hash(historicalList),data.provenance.historical_list_sha256,'historical tree list digest');
for(const[file,row]of Object.entries(data.historical_fixtures)){assert.equal(hash(read(file)),row.sha256,'historical fixture byte equality '+file);assert.equal(read(file).length,row.bytes);}
const historicalFile='scripts/fixtures/issue-448/distribution.cjs';assert(data.historical_fixtures[historicalFile]);
assert.throws(()=>layer.validate({artifacts,readRaw:file=>file===historicalFile?Buffer.concat([read(file),Buffer.from('\nforeign')]):read(file)}),/historical fixture/);
console.log('PASS #440 historical205 census and negative altered historical fixture');
const consumers=Object.entries(data.files).filter(([file,row])=>file.endsWith('.test.js')&&row.before!==null&&zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64')).includes(Buffer.from('./fixtures/issue-448/distribution.cjs')));
assert.equal(consumers.length,24,'exact require migration inventory');
for(const[file,row]of consumers){const before=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64')).toString('utf8'),after=read(file).toString('utf8');assert.equal(before.split('./fixtures/issue-448/distribution.cjs').length,2,'one old require '+file);assert.equal(after,layer.consumerProjection(file,before.replace('./fixtures/issue-448/distribution.cjs','./fixtures/issue-440/distribution.cjs')),'only declared consumer projection changed '+file);}
console.log('PASS #440 exactly24 migrations:21 require-only and3 explicit adapters; every assertion preserved');
oneParentCall('after',()=>assert.equal(layer.after('files','__issue440_projection_counter__',''),''));
oneParentCall('projectGolden',()=>{const golden=require('./fixtures/claude-renderer/claude-memory-v2.golden.json');assert(layer.projectGolden(golden));});
assert(layer.readme('').includes('# Distribuição medida — issue #440'),'readme chains own measured README');
console.log('PASS #440 after and projectGolden traverse parent once; readme chain preserved');
const matrix=read('docs/issue-440/route-matrix.md').toString('utf8'),section=matrix.split('## Rotas\n')[1].split('\n## ')[0];
assert(section.includes('| Rota | Host | Worker | Transporte | Suítes ligadas | Limites | Execução final |'));
const rows=section.split('\n').filter(x=>x.startsWith('| host '));assert.equal(rows.length,4);
for(const label of ['host Claude → worker Codex app-server (prioritária)','host Codex → worker Claude CLI','host Codex → nativo','host Claude → nativo'])assert.equal(rows.filter(x=>x.startsWith('| '+label+' |')).length,1,'route '+label);
for(const row of rows){assert(row.endsWith('| PENDENTE |'));assert(row.split('|')[6].trim(),'route limits');for(const suite of row.matchAll(/forge-[\w-]+\.test\.js/g))assert(fs.existsSync(path.join(__dirname,suite[0])),'route suite exists '+suite[0]);}
for(const suite of ['forge-issue-440-e2e','forge-issue-440-recovery','forge-issue-440-result','forge-process-tree','forge-codex-renderer','forge-claude-renderer'])assert(section.includes(suite+'.test.js'));
assert(matrix.includes('Nenhum arquivo do host Codex mudou na S03'));
const list=cp.spawnSync(process.execPath,[path.join(__dirname,'run-tests.js'),'--list','--match','xllm','--match','native','--match','codex','--match','claude','--match','sidecar'],{cwd:root,maxBuffer:1024*1024});
assert.equal(list.status,0,list.stderr.toString());const listHash=hash(list.stdout);assert(matrix.includes(listHash),'real route listing digest');
console.log('PASS #440 four route rows, existing suites, limits and final PENDENTE; listing sha256 '+listHash);

const repairSample=read(data.sample_projection.file).toString('utf8'),projectedSample=layer.currentSamples(repairSample);assert.equal(hash(projectedSample),data.sample_projection.after);assert.equal(layer.previousSamples(projectedSample),parent.previousSamples(repairSample));assert.throws(()=>layer.currentSamples(repairSample+'foreign'));const realGuard=require('./forge-dispatch-source-guard.js');assert.deepEqual(realGuard.SOURCE_REGISTRY,data.registry.after_rows);assert.deepEqual(layer.previousRegistry(realGuard.SOURCE_REGISTRY),parent.previousRegistry(data.registry.before_rows));assert.throws(()=>layer.previousRegistry(realGuard.SOURCE_REGISTRY.slice(1)));console.log('PASS #440 exact samples and registry projections; real predecessor and historical registry preserved');
const traceBase=JSON.parse(zlib.gunzipSync(Buffer.from(data.parity.base_trace_gzip_base64,'base64'))),traceCurrent=JSON.parse(zlib.gunzipSync(Buffer.from(data.parity.current_trace_gzip_base64,'base64'))),oldParity=require('./fixtures/issues-403-407-integration/parity.cjs'),adapter=layer.parityAdapter(oldParity);assert.deepEqual(adapter.beforeTrace(traceCurrent),oldParity.beforeTrace(traceBase));assert.deepEqual(adapter.afterTrace(oldParity.beforeTrace(traceBase)),traceCurrent);for(const row of data.parity.rows){const changed=structuredClone(traceCurrent),keys=row.path.slice(),key=keys.pop(),obj=keys.reduce((o,k)=>o[k],changed);obj[key]='foreign';assert.throws(()=>adapter.beforeTrace(changed),/issue440 exact trace/);}console.log('PASS #440 thirty-nine measured trace leaves and every drift refused; old parity assertions preserved');

for(const row of data.registry.aliases){const actual={path:row.path,kind:row.kind,fingerprint:row.after},historical={...actual,fingerprint:row.before};assert.equal(realGuard.identity(actual),realGuard.identity(historical));for(const foreign of [{...actual,path:'shared/foreign.md'},{...actual,kind:'native'},{...actual,fingerprint:'sha256:'+ '0'.repeat(64)}])assert.notEqual(realGuard.identity(foreign),realGuard.identity(historical),'only exact measured tuple aliases');assert(realGuard.discover(root).candidates.some(c=>c.path===row.path&&c.kind===row.kind&&c.fingerprint===row.after),'actual discovery fingerprint remains visible');}console.log('PASS #440 exactly two measured prose identities; foreign fingerprint/path/kind refused and actual evidence preserved');

assert.equal(layer.previousSamples(repairSample),parent.previousSamples(repairSample),'exact historical samples remain accepted');assert.equal(layer.previousSamples(projectedSample),layer.previousSamples(repairSample),'historical and prospective samples have identical predecessor projection');assert.throws(()=>layer.previousSamples(repairSample+'foreign'),/issue440 exact historical or prospective samples/);assert.throws(()=>layer.previousSamples(projectedSample+'foreign'),/issue440 exact historical or prospective samples/);console.log('PASS #440 exact historical and prospective sample states compose; foreign bytes in either state refused');

assert.equal(Object.keys(data.consumers).length,3,'exact three consumer adapters');assert.equal(consumers.filter(([file])=>!Object.hasOwn(data.consumers,file)).length,21,'exact21 require-only migrations');assert(read('scripts/forge-dispatch-source-guard.test.js').toString('utf8').includes("const sampleText = unitEntry.currentSamples(fs.readFileSync(path.join(ROOT, before.samples.file), 'utf8'));"),'source guard directly consumes exact current sample projection');console.log('PASS #440 third source-guard adapter preserves all assertions and historical samples');
