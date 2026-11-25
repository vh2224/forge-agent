'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
// Storage paths and destructured account resolvers are fixed at import time.
// Isolate them before any Forge import, including the laboratory helper.
const originalEnv={...process.env},testHome=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-owner-resume-home-')));
const homeMarker=crypto.randomBytes(16).toString('hex');fs.writeFileSync(path.join(testHome,'.fixture-owner'),homeMarker);
let accounts,originalLaunch;
try{
Object.assign(process.env,{HOME:testHome,USERPROFILE:testHome,FORGE_HOME:path.join(testHome,'core'),CODEX_HOME:path.join(testHome,'.codex'),CLAUDE_CONFIG_DIR:path.join(testHome,'.claude'),FORGE_KEYCHAIN_DISABLED:'1',FORGE_ACCOUNTS_REGISTRY:path.join(testHome,'.claude','accounts.json')});
fs.mkdirSync(process.env.CODEX_HOME);fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
assert.equal(require.cache[require.resolve('./forge-accounts')],undefined,'run this fixture in a fresh process');
accounts=require('./forge-accounts');originalLaunch=accounts.resolveLaunch;
accounts.resolveLaunch=()=>{throw Error('owner-resume fixture must not launch a provider');};
const lab=require('./forge-code-roots.test'),fixture=require('./fixtures/completion-delivery.cjs');
const runs=require('./forge-runs'),claims=require('./forge-write-claim'),controller=require('./forge-unit-controller'),api=require('./forge-completion-delivery-recovery');let count=0;
const eventOnly=process.argv.includes('--event-sequence-only'),schemaOnly=process.argv.includes('--claim-schema-only');
for(const host of eventOnly||schemaOnly?['codex']:['claude','codex'])for(const active of schemaOnly?[true]:eventOnly?[false]:[true,false]){const f=lab.fixture(),env={...process.env},RealDate=Date;try{
 const base=RealDate.now()-10000;let now=base;global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 const home=path.join(f.dir,'home');fs.mkdirSync(home);Object.assign(process.env,{HOME:home,USERPROFILE:home,FORGE_HOME:path.join(home,'core')});
 const milestone='M001',slice='S01',task='T01',old='old-'+host,actor='new-'+host;fs.mkdirSync(path.join(f.owner,'.gsd'),{recursive:true});fs.writeFileSync(path.join(f.owner,'.gsd/forge-prefs.jsonc'),'{}');
 if(host==='codex')Object.assign(process.env,{CODEX_THREAD_ID:actor});else Object.assign(process.env,{FORGE_CLAUDE_OWNER_SESSION_ID:actor,FORGE_CLAUDE_OWNER_SOURCE:'claude-sessionstart-env-v1'});
 runs.add(f.owner,{id:milestone,kind:'milestone',session_id:old,host_runtime:host,owner_session_source:host==='codex'?'CODEX_THREAD_ID':'claude-sessionstart-env-v1',root:f.owner,project:f.owner});
 fs.mkdirSync(path.join(f.owner,'.gsd/milestones',milestone),{recursive:true});require('./forge-state').write(f.owner,{milestone,phase:'idle',active_slice:slice,active_task:'—',auto_mode:'off'});
 const contract=require('./forge-code-roots').validateContract({...f.contract,code_roots:[f.contract.code_roots[0]]});
 const files=fixture.prepare(f.owner,{milestone,slice,task,codeDir:f.a});claims.recordClaim(f.owner,milestone,active
  ?{schema_version:2,unit:'execute-task/T01',source:'manual',execution_contract:contract,paths:[{root_id:contract.primary_root_id,path:files.source}]}
  :{unit:'execute-task/T01',source:'manual',code_dir:f.a,paths:[files.source]});const claim=JSON.stringify(runs.get(f.owner,milestone).write_claim);
 const controllerOptions={now:()=>now,prefsReader:()=>({ok:true,prefs:{workflow:{skip_discuss:true,skip_research:true}}})};
 const beginKey=`forge-orchestrate-next:${milestone}:execute-task/T01:${slice}`,begin=controller.begin(f.owner,{milestone,slice,unit:'execute-task/T01',host_runtime:host,owner_token:old,idempotency_key:beginKey,state_patch:{active_slice:slice}},controllerOptions);assert.equal(begin.ok,true);now+=100;
 controller.complete(f.owner,{milestone,unit:'execute-task/T01',host_runtime:host,owner_token:old,generation:begin.generation,idempotency_key:beginKey+':complete',result:{status:'succeeded'}},controllerOptions);
 const original=JSON.stringify(controller.lookupRecord(f.owner,'transaction',beginKey+':complete'));
 let authority=true,stopped=true,questions=[];
 const options={cwd:f.owner,milestone,slice,task,runId:milestone,ownerToken:actor,hostRuntime:host,expectedSession:actor,beginKey,completionKey:beginKey+':complete',executionContract:contract,controllerOptions,
 confirmOwnerStopped:true,confirmWorkspaceQuiescent:true,assertAuthority:()=>authority,attestStoppedWriter:()=>stopped,readPendingQuestions:()=>questions};
 runs.update(f.owner,milestone,{active});
 const observed=()=>runs.inspectOwnerResume(f.owner,milestone,{hostRuntime:host,expectedSession:actor});const refresh=()=>({...options,expectedRecordSha256:observed().record_sha256});
 assert.throws(()=>runs.resumeOwner(f.owner,milestone,{hostRuntime:host,expectedSession:actor,expectedRecordSha256:observed().record_sha256,confirmOwnerStopped:true,confirmWorkspaceQuiescent:true}),/claim-held/);count++;
 assert.throws(()=>api.resumeAndCreateRepair({...refresh(),attestStoppedWriter:undefined}),/live-adapter-required/);count++;
 stopped=false;assert.throws(()=>api.resumeAndCreateRepair(refresh()),/writer-not-stopped/);stopped=true;
 questions=[{id:'functional',status:'pending'}];assert.throws(()=>api.resumeAndCreateRepair(refresh()),/pending-questions/);questions=[];authority=false;assert.throws(()=>api.resumeAndCreateRepair(refresh()),/authority-required/);authority=true;count+=3;
 assert.equal(runs.get(f.owner,milestone).session_id,old);assert.equal(JSON.stringify(runs.get(f.owner,milestone).write_claim),claim);
 const nullRoot=active?{...runs.get(f.owner,milestone).write_claim,execution_contract:null}:{...runs.get(f.owner,milestone).write_claim,code_dir:null};runs.update(f.owner,milestone,{write_claim:nullRoot});assert.throws(()=>api.resumeAndCreateRepair(refresh()),active?/execution-contract-schema/:/claim-roots-mismatch/);runs.update(f.owner,milestone,{write_claim:JSON.parse(claim)});count++;
 runs.update(f.owner,milestone,{worker:'active-fixture',worker_started:Date.now()});assert.throws(()=>api.resumeAndCreateRepair(refresh()),/worker-unreconciled/);runs.update(f.owner,milestone,{worker:null,worker_started:null});count++;
 now=base+1000;const repair=api.resumeAndCreateRepair(refresh());assert.equal(repair.owner_resume_status,'transferred');assert.equal(JSON.stringify(runs.get(f.owner,milestone).write_claim),claim);const started=repair.start();assert.equal(started.action,'verify-only');count++;
 now=base+3000;fixture.publish(f.owner,{milestone,slice,task,codeDir:f.a,at:new Date(base+2000).toISOString()});assert.equal(repair.complete().outcome,'completed');assert.equal(JSON.stringify(controller.lookupRecord(f.owner,'transaction',beginKey+':complete')),original);count++;
 // A completed owner verification is historical. Later claims, sessions and
 // legitimate later changes to its files do not revoke that published fact.
 const inventory={roadmap_exists:true,context_exists:true,research_exists:true,slices:[{id:slice,checked:false,plan_exists:true,research_exists:true,tasks:[{id:task,checked:false},{id:'T02',checked:false}]}],milestone_complete:false};
 const choose=()=>controller.select(f.owner,{milestone},{...controllerOptions,inventoryReader:()=>inventory,
   deliveryRepairActor:{hostRuntime:host,ownerToken:runs.get(f.owner,milestone).session_id}});
 const readOnlyChoose=()=>controller.select(f.owner,{milestone},{...controllerOptions,inventoryReader:()=>inventory});
 assert.equal(choose().unit.id,'T02');assert.deepEqual(readOnlyChoose(),choose(),'historical selection does not require a current writer token');count++;
 // A current root-qualified claim can retain an authentic older single-root
 // capture. Multiroot and foreign-root reinterpretation remain forbidden.
 const validClaim=JSON.stringify(runs.get(f.owner,milestone).write_claim);
 const multi=claims.recordClaim(f.owner,milestone,{schema_version:2,unit:'execute-task/T01',source:'manual',execution_contract:f.contract,paths:f.contract.code_roots.map(root=>({root_id:root.id,path:'src/T01.js'}))});
 assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,started.completion_key,multi),/boundary-not-transferable/);count++;
 runs.update(f.owner,milestone,{write_claim:JSON.parse(validClaim)});
 const foreignClaim={...JSON.parse(claim),code_dir:f.b};
 assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,started.completion_key,foreignClaim),/boundary-not-transferable/);count++;
 function move(session){
  if(host==='codex')process.env.CODEX_THREAD_ID=session;else process.env.FORGE_CLAUDE_OWNER_SESSION_ID=session;
  const bytes=JSON.stringify(runs.get(f.owner,milestone).write_claim),snapshot=runs.inspectOwnerResume(f.owner,milestone,{hostRuntime:host,expectedSession:session});
  const moved=runs.resumeOwner(f.owner,milestone,{hostRuntime:host,expectedSession:session,expectedRecordSha256:snapshot.record_sha256,confirmOwnerStopped:true,confirmWorkspaceQuiescent:true});
  assert.equal(moved.status,'transferred');assert.equal(JSON.stringify(moved.record.write_claim),bytes);assert.equal(choose().unit.id,'T02');count++;
 }
 move('later-one-'+host);
 const later=fixture.prepare(f.owner,{milestone,slice,task:'T02',codeDir:f.a});
 claims.recordClaim(f.owner,milestone,{unit:'execute-task/T02',source:'manual',code_dir:f.a,paths:[later.source]});
 assert.equal(choose().unit.id,'T02');count++;
 // Still-live mutation admission continues to reject the replaced claim.
 assert.throws(()=>repair.start(),/authority-required|claim-required|original-changed/);count++;
 now=base+3500;const laterBegin=controller.begin(f.owner,{milestone,slice,unit:'execute-task/T02',host_runtime:host,owner_token:'later-one-'+host,idempotency_key:'later-two',state_patch:{active_slice:slice}},controllerOptions);assert.equal(laterBegin.ok,true);
 fixture.publish(f.owner,{milestone,slice,task:'T02',codeDir:f.a,at:new Date(base+4000).toISOString()});now=base+4500;
 assert.equal(require('./forge-orchestrate').run('complete',{cwd:f.owner,milestone,unit:'execute-task/T02',host_runtime:host,owner_token:'later-one-'+host,begin_key:'later-two',result:{status:'done'}},controllerOptions).outcome,'completed');
 fs.appendFileSync(path.join(f.a,files.source),'// rewritten by later task\n');
 assert.equal(require('./forge-milestone-time-clock').readCurrentTaskDelivery({cwd:f.owner,milestone,slice,task,begunAt:base,completedAt:base+3000}).status,'unproven');
 assert.equal(choose().unit.id,'T02');count++;
 move('later-two-'+host);
 const runBytes=JSON.stringify(runs.get(f.owner,milestone));
 const broken=JSON.parse(runBytes);broken.owner_resume_history.at(-1).previous_session_sha256='0'.repeat(64);runs.update(f.owner,milestone,{owner_resume_history:broken.owner_resume_history});
 const failed=choose();assert.equal(failed.unit.id,'T01');assert(failed.delivery_repair_diagnostics.some(row=>row.reason_code==='delivery-recovery-unproven'));count++;
 assert.deepEqual(readOnlyChoose(),failed,'direct read-only selection refuses the same foreign chain');
 const next=require('./forge-orchestrate').run('next',{cwd:f.owner,milestone,host_runtime:host,owner_token:'later-two-'+host},{...controllerOptions,inventoryReader:()=>inventory});
 assert.equal(next.reason_code,'execution-delivery-recovery-required');assert(next.details.delivery.cause.some(row=>row.reason_code==='delivery-recovery-unproven'));count++;
 runs.update(f.owner,milestone,{owner_resume_history:JSON.parse(runBytes).owner_resume_history});
 assert.equal(choose().unit.id,'T02');
 const eventsFile=controller.eventsFile(f.owner,milestone),eventsBytes=fs.readFileSync(eventsFile),events=eventsBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
 events.find(event=>event.idempotency_key===started.completion_key).sequence=events[0].sequence;
 fs.writeFileSync(eventsFile,events.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const eventFailure=choose();assert.equal(eventFailure.unit.id,'T01');assert(eventFailure.delivery_repair_diagnostics.some(row=>row.reason_code==='delivery-recovery-event-unproven'));count++;
 fs.writeFileSync(eventsFile,eventsBytes);assert.equal(choose().unit.id,'T02');
 // Pair-local order alone is insufficient: the global canonical stream is
 // unique/ordered and the original completion precedes its repair begin.
 function rejectStream(mutate,label='invalid recovery stream'){
  const changed=eventsBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);mutate(changed);
  try{
   fs.writeFileSync(eventsFile,changed.map(row=>JSON.stringify(row)).join('\n')+'\n');
   const refused=readOnlyChoose();assert.equal(refused.unit.id,'T01',label);assert(refused.delivery_repair_diagnostics.some(row=>row.reason_code==='delivery-recovery-event-unproven'),label);count++;
  }finally{fs.writeFileSync(eventsFile,eventsBytes);}
  assert.equal(readOnlyChoose().unit.id,'T02','restored canonical stream');
 }
 rejectStream(rows=>{const oldBegin=rows.find(row=>row.idempotency_key===beginKey),oldComplete=rows.find(row=>row.idempotency_key===beginKey+':complete');rows.find(row=>row.idempotency_key===started.begin_key).sequence=oldBegin.sequence;rows.find(row=>row.idempotency_key===started.completion_key).sequence=oldComplete.sequence;});
 rejectStream(rows=>{[rows[0],rows[1]]=[rows[1],rows[0]];});
 rejectStream(rows=>{const original=rows.findIndex(row=>row.idempotency_key===beginKey+':complete'),repairBegin=rows.findIndex(row=>row.idempotency_key===started.begin_key);[rows[original],rows[repairBegin]]=[rows[repairBegin],rows[original]];rows.forEach((row,index)=>{row.sequence=index+1;});});
 rejectStream(rows=>{rows.push({...rows.at(-1),sequence:rows.length+1});});
 // #461: actual forge-auto writer shapes share the milestone stream. They are
 // descriptive only; no metadata field can replace any of the four keyed proofs.
 const record=(unit='execute-task/T01',status='done')=>({ts:new Date(base).toISOString(),unit,agent:'forge-executor',milestone,status,summary:'orchestrator record'});
 const repairRecord=strategy=>({ts:new Date(base).toISOString(),event:'repair',unit:'execute-task/T01',milestone,slice,task,strategy,repair_count:1,reason:'verification drift'});
 const descriptive=[record('estimate-milestone/'+milestone),record('review/T01','blocked'),record('execute-task/T01','partial'),
  {...record('checkpoint','checkpoint'),agent:'orchestrator'},{...record('account-handoff','handoff'),agent:'orchestrator'},
  ...['retry','decompose','prune','blocked'].map(repairRecord),record('future-unit/future-id')];
 const renumber=rows=>rows.forEach((row,index)=>{if(row&&Object.hasOwn(row,'idempotency_key'))row.sequence=index+1;});
 function interleave(rows){
  const logs=descriptive.map(row=>({...row})),out=[logs[0]];
  rows.forEach((row,index)=>{out.push(row);if(index===Math.floor(rows.length/2))out.push(...logs.slice(1,6));});
  out.push(...logs.slice(6));renumber(out);
  return out;
 }
 {const mixed=interleave(eventsBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse));
  try{
   fs.writeFileSync(eventsFile,mixed.map(row=>JSON.stringify(row)).join('\n')+'\n');
   assert.equal(readOnlyChoose().unit.id,'T02','documented records before/between/after controller events do not reselect repaired T01');
   assert.deepEqual(readOnlyChoose(),choose(),'descriptive records do not require a current actor to prove history');count++;
  }finally{fs.writeFileSync(eventsFile,eventsBytes);}}
 rejectStream(rows=>{const mixed=interleave(rows);rows.splice(0,rows.length,...mixed);rows[0].sequence=1;});
 rejectStream(rows=>{const mixed=interleave(rows);rows.splice(0,rows.length,...mixed);rows[0].idempotency_key='orchestrator-without-sequence';});
 rejectStream(rows=>{const mixed=interleave(rows);const keyed=mixed.findIndex(row=>row.idempotency_key===started.begin_key);mixed[keyed].sequence+=1;rows.splice(0,rows.length,...mixed);});
 rejectStream(rows=>{const mixed=interleave(rows);let sequence=0;mixed.forEach(row=>{if(Object.hasOwn(row,'idempotency_key'))row.sequence=++sequence;});rows.splice(0,rows.length,...mixed);},'controller numbering must include descriptive positions');
 for(const value of [null,false,7,'text',[],{},['array'],{event:'unit-transition',action:'complete',unit:'execute-task/T01'}]){
  rejectStream(rows=>rows.push(value),'unknown/non-record metadata is not a documented writer');
 }
 for(const extra of ['event','action','protocol_version','owner_digest','lease_generation','unknown']){
  rejectStream(rows=>rows.push({...record(),[extra]:'unproved'}),'unknown/controller extra field: '+extra);
 }
 for(const patch of [{milestone:'M999'},{ts:'not-a-time'},{agent:''},{status:'succeeded'},{unit:'execute-task'},{summary:null},
  {unit:'checkpoint',status:'checkpoint'},{unit:'account-handoff',agent:'orchestrator',status:'done'}]){
  rejectStream(rows=>rows.push({...record(),...patch}),'malformed or foreign descriptive record');
 }
 for(const patch of [{event:'unit-began'},{task:'T02'},{slice:'foreign'},{strategy:'unknown'},{repair_count:0},{repair_count:-1},
  {repair_count:1.5},{repair_count:Number.MAX_SAFE_INTEGER+1},{reason:null},{task:{toString:null}}]){
  rejectStream(rows=>rows.push({...repairRecord('retry'),...patch}),'malformed repair record');
 }
 rejectStream(rows=>rows.push({...rows[0],idempotency_key:0,sequence:rows.length+1}),'non-string controller identity');
 for(const key of [beginKey,beginKey+':complete',started.begin_key,started.completion_key]){
  rejectStream(rows=>{rows.splice(rows.findIndex(row=>row.idempotency_key===key),1);renumber(rows);},'missing required event: '+key);
  rejectStream(rows=>{const row=rows.find(row=>row.idempotency_key===key);delete row.sequence;delete row.idempotency_key;renumber(rows);},'controller event cannot be relabeled as descriptive');
 }
 rejectStream(rows=>{rows.find(row=>row.idempotency_key===started.completion_key).reason_code='tampered';},'required event digest must match committed transaction');
 const baselineFile=path.join(f.owner,files.base,'.delivery-verification-'+repair.scope.original_sha256+'.json'),baselineBytes=fs.readFileSync(baselineFile);
 fs.unlinkSync(baselineFile);const absent=readOnlyChoose();assert.equal(absent.unit.id,'T01');assert(absent.delivery_repair_diagnostics.some(row=>row.reason_code==='delivery-recovery-baseline-unproven'));count++;
 fs.writeFileSync(baselineFile,baselineBytes,{flag:'wx'});assert.equal(choose().unit.id,'T02');
 runs.update(f.owner,milestone,{session_id:'foreign-owner'});assert.throws(()=>repair.start(),/authority-required/);count++;
}finally{global.Date=RealDate;process.env=env;f.cleanup();}}
console.log('PASS '+count+' retained completed claim transfer/repair controls, '+(schemaOnly?'selected Codex/original-schema2 fixture':eventOnly?'selected Codex/inactive fixture':'both observed hosts')+'; original claim and completion unchanged');
}finally{
 if(accounts)accounts.resolveLaunch=originalLaunch;
 process.env=originalEnv;
 assert.equal(fs.realpathSync.native(testHome),testHome);
 assert.equal(fs.lstatSync(testHome).isSymbolicLink(),false);
 assert.equal(fs.readFileSync(path.join(testHome,'.fixture-owner'),'utf8'),homeMarker);
 fs.rmSync(testHome,{recursive:true});
}
