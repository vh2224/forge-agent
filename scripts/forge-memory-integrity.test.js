'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const evidence = require('./forge-memory-evidence');
const memory = require('./forge-memory');
const sidecar = require('./forge-unit-sidecar');
const row = (id, observation = 'obs1') => ({kind:'confirm', evidence_version:2, event_id:'extract2:v2:'+id, extraction_id:'extract2',local_event_id:id,ts:'2026-10-02T00:00:00.000Z',mem_id:'MEM001', evidence_ref:'ev',observation_id:observation,source_unit:'execute-task/T02',source_fingerprint:'sha256:other',observed_kind:'confirm',independent_ref:'verify:T02:check'});
test('accepted timestamps sort by instant, then kind and event identity', () => {
 const early={ts:'2026-10-02T12:00:00Z',kind:'prune',event_id:'z'};
 const late={ts:'2026-10-02T12:00:00.500Z',kind:'confirm',event_id:'a'};
 assert(evidence._private.compareV2(early,late)<0);
 assert.equal(evidence._private.compareV2({...late,ts:'2026-10-02T12:00:00Z'},{...late,ts:'2026-10-02T12:00:00.000Z'}),0);
});
test('default evidence binding ignores only existing memory context', () => {
 const request={sourceUnitType:'execute-task',summaryContent:'Synthetic source',sourceResult:'done',keyDecisions:[]};
 const a=sidecar.memoryEvidenceContract(request,'T01');
 const b=sidecar.memoryEvidenceContract({...request,existingMemory:{facts:[{id:'MEM001'}],stats:[]}},'T01');
 assert.deepEqual(a,b);
 assert.notEqual(a.digest,sidecar.memoryEvidenceContract({...request,summaryContent:'Different source'},'T01').digest);
 const explicit={...request,sourceFingerprint:'sha256:explicit'};
 assert.deepEqual(sidecar.memoryEvidenceContract(explicit,'T01'),sidecar.memoryEvidenceContract({...explicit,existingMemory:{facts:[{}]}},'T01'));
});
test('every distinct delivery identity survives observation dedup and rejects later rebinding', () => {
 const stored=memory._private.mergeStats([], [row('c1'),row('c2')]);
 assert.equal(stored.length,2);
 assert.deepEqual(memory._private.mergeStats(stored,[row('c2')]),stored);
 assert.throws(()=>memory._private.mergeStats(stored,[row('c2','obs2')]),error=>error.code==='MEMORY_EVENT_CONFLICT'&&error.reason===evidence.REASONS.EVENT_ID_CONFLICT);
 assert.throws(()=>memory._private.mergeStats([], [row('c1'),row('c2'),row('c2','obs2')]),error=>error.code==='MEMORY_EVENT_CONFLICT');
});

const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fact = {mem_id:'MEM001',category:'gotcha',text:'Synthetic fact',confidence_base:0.8,created_at:'2026-10-01T00:00:00.000Z',extraction_id:'origin',source_fingerprint:'sha256:origin'};
const now='2026-10-02T12:00:00.500Z';
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/memory-evidence/v2.json')));
const route={host_runtime:'codex',worker_engine:'native',resolved_worker_engine:'native',worker_mode:'native',model:'gpt-6-luna',model_resolved:'gpt-6-luna',effort:'medium'};
const telemetry={model_requested:null,model_resolved:'gpt-6-luna',model_argument:'gpt-6-luna',model_observed:null,model_observed_source:null,effort_requested:'medium',effort_resolved:'medium',effort_argument:'medium',effort_transport:'native-argument',effort_transport_value:'medium',effort_transport_source:'fixture-native-argument',effort_binding_observed:null,effort_binding_observed_source:null,effort_binding_observed_fingerprint:null,effort_applied:null,effort_applied_source:null,capabilities_source:'fixture'};
function request(cwd,id){return {cwd,contextRoot:cwd,unitType:'memory-extract',sourceUnitType:'execute-task',sourceUnitId:'T01',milestoneId:'M001',workflowId:'fixture',dispatchId:id,extractionId:id,extractedAt:now,summaryContent:'Synthetic source',sourceResult:'done',keyDecisions:[],existingMemory:{facts:[],stats:[]},route,hostRuntime:'codex',resultFile:path.join(path.dirname(cwd),id+'.json'),publicationSafe:true,publicationBoundary:{ownerJoined:true,checkedAt:now,protectedSnapshots:[]},invocationTelemetry:telemetry};}
function root(t){const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forge-memory-integrity-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));const code=path.join(cwd,'code');fs.mkdirSync(code);return code;}
test('fractional confirmation after a nonfractional prune cannot reinforce',()=>{
 const folded=evidence.foldMemoryEvidence([{unitId:'T01',facts:[fact],stats:[{kind:'prune',mem_id:'MEM001',ts:'2026-10-02T12:00:00Z',reason:'cap'},{...row('c1'),ts:now}]}]);
 assert.equal(folded.entries[0].v2.independent_confirmation_count,0);
 assert(folded.rejected.some(x=>x.reason===evidence.REASONS.TARGET_PRUNED));
});
test('publication retains repeated delivery IDs across reload and rejects rebound atomically',async t=>{
 const cwd=root(t);memory.writeFragment(cwd,{unit_id:'T01',milestone_id:'M001',facts:[fact],stats:[]});
 const first=request(cwd,'one'); first.memoryEvidence=fixture.memoryEvidence;
 const a=await sidecar.acceptNativeMemoryResult({...first,rawResult:fixture.extraction});assert.equal(a.publication.status,'written');
 const second={...request(cwd,'two'),memoryEvidence:fixture.memoryEvidence,existingMemory:memory.readFragment(cwd,'T01',{milestoneId:'M001'})};
 const b=await sidecar.acceptNativeMemoryResult({...second,rawResult:fixture.extraction});assert.equal(b.publication.status,'written');assert.deepEqual(b.publication.state,a.publication.state);
 const file=memory.fragmentPath(cwd,'T01',{milestoneId:'M001'}),bytes=fs.readFileSync(file);
 const stored=memory.readFragment(cwd,'T01',{milestoneId:'M001'});assert.equal(stored.stats.filter(x=>x.event_id==='two:v2:e2').length,1);
 const replay=await sidecar.runNativeMemory(second,()=>{throw Error('provider must not run');});assert.equal(replay.publication.status,'noop');assert(fs.readFileSync(file).equals(bytes));
 const conflict={...request(cwd,'three'),extractionId:'two',memoryEvidence:{...fixture.memoryEvidence,records:fixture.memoryEvidence.records.map(x=>x.evidence_ref==='confirm'?{...x,observation_id:'different-observation'}:x)}};
 const refused=await sidecar.acceptNativeMemoryResult({...conflict,rawResult:fixture.extraction});assert.equal(refused.publication.status,'conflict');assert(fs.readFileSync(file).equals(bytes));
 const changed=await sidecar.runNativeMemory({...second,summaryContent:'Changed source'},()=>{throw Error('provider');});assert.equal(changed.reason_code,'dispatch-identity-conflict');
});
test('historical v2 default context receipt replays unchanged; changed context refuses',async t=>{
 const cwd=root(t),r=request(cwd,'historical');r.memoryEvidence=fixture.memoryEvidence;
 memory.writeFragment(cwd,{unit_id:'T01',milestone_id:'M001',facts:[fact],stats:[]});
 // Reproduce the pre-fix serialized fingerprint algorithm independently.
 const contextFingerprint=sha(JSON.stringify({summaryContent:r.summaryContent,sourceResult:r.sourceResult,keyDecisions:r.keyDecisions,existingMemory:r.existingMemory}));
 const label='execute-task/T01';const observation=sha(JSON.stringify({unit:label,milestone:'M001',summary:r.summaryContent,result:r.sourceResult,key_decisions:r.keyDecisions})).slice(0,40);
 const records=[{evidence_ref:'source_exposure',observation_id:'source-'+observation+'-exposure',observed_kind:'exposure'},{evidence_ref:'source_reobserve',observation_id:'source-'+observation+'-reobserve',observed_kind:'reobserve'},...fixture.memoryEvidence.records].map(x=>({source_unit:label,source_fingerprint:contextFingerprint,...x}));
 const extraction=require('./forge-memory-extraction');
 const registry=extraction.normalizeEvidenceRegistry({records,outcomes:fixture.memoryEvidence.outcomes},{sourceUnit:label,sourceFingerprint:contextFingerprint});
 const base=sha(JSON.stringify({...r,unitType:'memory-extract',rawResult:undefined,invocationTelemetry:undefined,resultFile:undefined,publicationSafe:undefined,publicationBoundary:undefined,waitForPublicationBoundary:undefined}));
 const fingerprint=sha(JSON.stringify({request:base,memory_contract:{schema_version:2,evidence_digest:registry.digest}}));
 const receipt={phase:'ready',kind:'memory-extraction',fingerprint,dispatch_id:r.dispatchId,extraction_id:r.extractionId,extracted_at:r.extractedAt,source_unit:'T01',model:'gpt-6-luna',effort:'medium',telemetry,extraction:fixture.extraction,artifacts:[],memory_contract:{schema_version:2,evidence:registry}};
 const receiptFile=r.resultFile+'.receipt.json';fs.writeFileSync(receiptFile,JSON.stringify(receipt));const receiptBytes=fs.readFileSync(receiptFile);
 const delivered=await sidecar.runNativeMemory(r,()=>{throw Error('provider');});assert.equal(delivered.status,'done');assert.equal(delivered.publication.status,'written');
 const fragment=memory.fragmentPath(cwd,'T01',{milestoneId:'M001'}),bytes=fs.readFileSync(fragment);
 const replay=await sidecar.runNativeMemory(r,()=>{throw Error('provider');});assert.equal(replay.publication.status,'noop');assert(fs.readFileSync(receiptFile).equals(receiptBytes));assert(fs.readFileSync(fragment).equals(bytes));
 const refused=await sidecar.runNativeMemory({...r,existingMemory:{facts:[fact],stats:[]}},()=>{throw Error('provider');});assert.equal(refused.reason_code,'dispatch-identity-conflict');assert(fs.readFileSync(receiptFile).equals(receiptBytes));
 // An already-started historical request keeps its old digest and context
 // when the saved provider result is accepted; no new provider is involved.
 fs.writeFileSync(receiptFile,JSON.stringify({phase:'started',fingerprint,dispatch_id:r.dispatchId}));
 const accepted=await sidecar.acceptNativeMemoryResult({...r,rawResult:fixture.extraction});
 assert.equal(accepted.publication.status,'noop');
 const completed=JSON.parse(fs.readFileSync(receiptFile));assert.equal(completed.fingerprint,fingerprint);assert.equal(completed.memory_contract.source_binding,undefined);assert.deepEqual(completed.memory_contract.evidence,registry);
 assert(fs.readFileSync(fragment).equals(bytes));
});
