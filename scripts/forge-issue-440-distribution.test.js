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

// fix-s03 R4: the measured document is consistent with the measured delta and with the retained provenance.
const doc=read('scripts/fixtures/issue-440/DISTRIBUTION.md').toString('utf8');
const docSection=(from,to)=>{const a=doc.indexOf(from),b=doc.indexOf(to,a+from.length);assert(a>=0&&b>a,'doc section '+from);return doc.slice(a,b);};
const old18=docSection('## Old18','## Qualificação upstream').split('\n').filter(x=>/^\| `forge-[\w-]+\.test\.js` \|/.test(x));
assert.equal(old18.length,18,'old18 rows');
for(const row of old18){const cells=row.split('|').map(x=>x.trim());assert.equal(cells.length,8,'old18 columns '+row.slice(0,48));assert(cells[6].length>20&&!/PENDENTE/.test(cells[6]),'old18 after is recorded, not pending: '+cells[1]);assert(/sem rótulo individual|54\/54/.test(cells[6]),'old18 after states the retained label limit: '+cells[1]);assert(Object.hasOwn(data.files,'scripts/'+cells[1].replace(/`/g,'')),'old18 suite is a measured consumer '+cells[1]);}
assert.equal(old18.filter(x=>x.includes('b7a8f89965e474c96e47d314bf66775c6ed5acf065fd1037f94d9262087f76a1')).length,16,'old failing digests preserved');
for(const digest of ['474e816338254dbf2e416c3615fca770d7cf9d02e19acc4e0801cb47709e3fac','316cfaa37548aa6e53ddb11efa4ee309a25507b1f8b3c9fb976018d60efe80c1'])assert.equal(old18.filter(x=>x.includes(digest)).length,1,'old failing digest preserved '+digest);
assert(doc.includes('21 migrações')&&doc.includes('3 consumidores com adaptador de projeção explícito'),'21 require-only plus 3 adapters');
assert(!/Cada after difere somente no require/.test(doc)&&!doc.includes('PENDENTE: verify do owner')&&!doc.includes('serão executados'),'no stale all-require or future-tense claim');
assert(doc.includes('28 executadas e 3 falhas')&&doc.includes('agregado inferido')&&doc.includes('qualificação por fonte, não execução nova'),'inferred aggregate vs source qualification');
for(const gate of ['GF1','GF2','GF3','GF4','GF5','GF6','GF7'])assert(new RegExp(gate+':.*requisito vigente').test(doc),'all final gate requirements stay explicit '+gate);assert(doc.includes('Os estados correntes são registrados no relatório autenticado do owner'),'current state is not a source-code checkbox');
assert(doc.includes('UAT manual permanece pendente'));
for(const secret of [layer.PIN,hash(JSON.stringify(data)),hash(fs.readFileSync(path.join(__dirname,'fixtures/issue-440/distribution-delta.json')))])assert(!secret||!doc.includes(secret),'document never embeds the final delta digest');
const appserverRow=data.files['scripts/forge-appserver-client.js'];assert(appserverRow&&appserverRow.before,'appserver client measured with a base preimage');
const appserverBefore=zlib.gunzipSync(Buffer.from(appserverRow.before_gzip_base64,'base64')).toString('utf8');
assert(!appserverBefore.includes('APPSERVER_EXIT_CODES')&&read('scripts/forge-appserver-client.js').toString('utf8').includes('APPSERVER_EXIT_CODES'),'appserver preimage is the base without the typed exit');
const e2eManifest=JSON.parse(read('scripts/fixtures/issue-440/e2e/manifest.json').toString('utf8')),e2eRecording=read('scripts/fixtures/issue-440/e2e/recording.jsonl');
assert.equal(e2eManifest.files[0].sha256,hash(e2eRecording),'e2e manifest binds the measured recording');assert.equal(data.files['scripts/fixtures/issue-440/e2e/recording.jsonl'].after,hash(e2eRecording));
const e2eVerdict=require('./forge-e2e-evidence').verifyEvidence(path.join(root,'scripts/fixtures/issue-440/e2e'),{expect:'recorded'});assert.equal(e2eVerdict.ok,true,e2eVerdict.reason_code);
console.log('PASS #440 DISTRIBUTION.md reconciled: old18 after recorded with limits, 21+3 consumers, gates pending, no embedded delta digest');
assert.equal(Object.keys(data.consumers).length,5,'exact original and additional consumer adapter inventory');assert.deepEqual(Object.keys(data.consumers).sort(),["scripts/forge-communication-evaluation.test.js","scripts/forge-communication-surfaces.test.js","scripts/forge-dispatch-source-guard.test.js","scripts/forge-issues-403-407-integration.test.js","scripts/forge-linked-task-parity.test.js"],'literal exact accepted adapter pathset');assert.deepEqual(consumers.filter(([file])=>Object.hasOwn(data.consumers,file)).map(([file])=>file).sort(),["scripts/forge-communication-surfaces.test.js","scripts/forge-dispatch-source-guard.test.js","scripts/forge-issues-403-407-integration.test.js"],'original24 migration subset retains its same three adapters');assert.equal(consumers.filter(([file])=>!Object.hasOwn(data.consumers,file)).length,21,'exact21 require-only migrations');assert(read('scripts/forge-dispatch-source-guard.test.js').toString('utf8').includes("const sampleText = unitEntry.currentSamples(fs.readFileSync(path.join(ROOT, before.samples.file), 'utf8'));"),'source guard directly consumes exact current sample projection');console.log('PASS #440 third source-guard adapter preserves all assertions and historical samples');


// PR450 compatibility: the new layer preserves inherited refusal provenance and optional metadata.
{
 const source=read(data.sample_projection.file).toString('utf8'),expected=parent.previousSamples(source);
 assert.equal(layer.previousSamples(source),expected,'known historical sample still projects exactly');
 assert.equal(layer.previousSamples(layer.currentSamples(source)),expected,'known prospective sample still projects exactly');
 for(const foreign of ['{}',''])assert.throws(()=>layer.previousSamples(foreign),/issue440 exact historical or prospective samples/,'unknown sample is never replaced with a valid baseline');
 const campaignRow=layer.issues403404Layer.files['scripts/forge-smoke.js'],savedCampaign=campaignRow.after;
 try{campaignRow.after='0'.repeat(64);for(const foreign of ['{}',''])assert.throws(()=>layer.previousSamples(foreign),/campaign independent measured delta/,'predecessor independent PIN must not be masked by unknown input');}finally{campaignRow.after=savedCampaign;}
 const issue407=layer.issue407Layer.provenance,saved407=issue407.base_revision;
 try{issue407.base_revision='0'.repeat(40);assert.throws(()=>layer.previousSamples(''),/independent measured delta/,'issue407 direct projection preserves historical PIN refusal');}finally{issue407.base_revision=saved407;}
 const rows=require('./forge-dispatch-source-guard.js').SOURCE_REGISTRY,validMetadata=parent.parallelismLayer;
 assert.deepEqual(layer.previousRegistry(rows,validMetadata),parent.previousRegistry(rows,validMetadata),'explicit valid inherited metadata remains supported');
 const forged=structuredClone(layer.nativeEffortLayer);forged.registry.before_rows[0].reason+=' forged';forged.registry.before_sha256=hash(JSON.stringify(forged.registry.before_rows));
 assert.throws(()=>layer.previousRegistry(rows,forged),'forwarded historical row+metadata self-repin must remain refused');
 assert.deepEqual(layer.previousRegistry(rows),parent.previousRegistry(rows),'default metadata still projects exactly after negative restoration');
 console.log('PASS #440 PR450 inherited PIN precedence, exact unknown-sample refusal and optional registry metadata forwarding');
}


// CI450: two additional adapters are not two more issue448 require migrations.
for(const file of ['scripts/forge-linked-task-parity.test.js','scripts/forge-communication-evaluation.test.js']){
 const actual=read(file).toString('utf8');let priorText=actual;
 if(file.includes('linked-task-parity')){const a="const routingParity=require('./fixtures/issue-440/distribution.cjs').parityAdapter(require('./fixtures/issues-403-407-integration/parity.cjs'));",b="const routingParity=require('./fixtures/issues-403-407-integration/parity.cjs');";assert.equal(priorText.split(a).length,3,'both parity sites use the existing measured adapter');priorText=priorText.split(a).join(b);const currentGuard="assert.strictEqual(sourceHash('shared/forge-procedures.json'), require('./fixtures/issue-440/distribution.cjs').after('files','shared/forge-procedures.json',manifest.after), 'only the measured manifest is accepted');",originalGuard="assert.strictEqual(sourceHash('shared/forge-procedures.json'), manifest.after, 'only the measured manifest is accepted');";assert.equal(priorText.split(currentGuard).length,2,'one exact measured manifest guard');priorText=priorText.replace(currentGuard,originalGuard);}
 else{const a="const data = JSON.parse(require('./fixtures/issue-440/distribution.cjs').currentSamples(read('docs/communication-evaluation/samples.json')));",b="const data = JSON.parse(read('docs/communication-evaluation/samples.json'));";assert.equal(priorText.split(a).length,2,'only corpus loading is projected');priorText=priorText.replace(a,b);}
 assert.equal(hash(priorText),data.consumers[file].before,'exact original e1a4 consumer before adapter '+file);
 assert.equal(layer.consumerProjection(file,priorText),actual,'new adapter exact roundtrip '+file);
 assert.throws(()=>layer.consumerProjection(file,priorText+'\n// foreign drift\n'),/issue440 exact consumer before/,'new adapter cannot hide foreign source drift '+file);
}
console.log('PASS #440 CI450 two additional consumer adapters: exact e1a4 roundtrip and foreign source refusal; original24 unchanged');

// CI450: smoke accepts exactly its historical/current measured states, never foreign input.
{
 const file='scripts/forge-smoke.js',row=data.files[file],current=read(file).toString('utf8'),baseline=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64')).toString('utf8');
 for(const method of ['previousSmoke','predecessorSmoke']){
  assert.equal(layer[method](baseline),parent[method](baseline),'exact historical smoke remains accepted '+method);
  assert.equal(layer[method](current),parent[method](baseline),'exact current smoke projects through the immutable predecessor '+method);
  for(const foreign of ['',current+'\n// foreign outside Section8\n',current.replace('function smokeCliHelpers()','function smokeCliHelpersForeign()')]){assert.notEqual(foreign,current,'negative smoke fixture differs from the current source');assert.notEqual(foreign,baseline,'negative smoke fixture differs from the historical source');assert.throws(()=>layer[method](foreign),/unrecognized smoke changes/,'foreign smoke is never replaced with the measured baseline '+method);}
 }
 const manifest='shared/forge-procedures.json',pin=data.files[manifest];assert.equal(layer.after('files',manifest,pin.before),hash(read(manifest)),'exact manifest uses existing closed measured after chain');
 assert.throws(()=>layer.after('files',manifest,'0'.repeat(64)),'foreign manifest remains refused by the measured after chain');
 console.log('PASS #440 CI450 exact smoke predecessor projection and measured manifest guard preserve foreign-input refusal');
}
