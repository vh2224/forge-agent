'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');const lab=require('./forge-code-roots.test'),fixture=require('./fixtures/completion-delivery.cjs');
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
 function rejectStream(mutate){
  const changed=eventsBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);mutate(changed);
  fs.writeFileSync(eventsFile,changed.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const refused=readOnlyChoose();assert.equal(refused.unit.id,'T01');assert(refused.delivery_repair_diagnostics.some(row=>row.reason_code==='delivery-recovery-event-unproven'));count++;
  fs.writeFileSync(eventsFile,eventsBytes);assert.equal(readOnlyChoose().unit.id,'T02');
 }
 rejectStream(rows=>{const oldBegin=rows.find(row=>row.idempotency_key===beginKey),oldComplete=rows.find(row=>row.idempotency_key===beginKey+':complete');rows.find(row=>row.idempotency_key===started.begin_key).sequence=oldBegin.sequence;rows.find(row=>row.idempotency_key===started.completion_key).sequence=oldComplete.sequence;});
 rejectStream(rows=>{[rows[0],rows[1]]=[rows[1],rows[0]];});
 rejectStream(rows=>{const original=rows.findIndex(row=>row.idempotency_key===beginKey+':complete'),repairBegin=rows.findIndex(row=>row.idempotency_key===started.begin_key);[rows[original],rows[repairBegin]]=[rows[repairBegin],rows[original]];rows.forEach((row,index)=>{row.sequence=index+1;});});
 rejectStream(rows=>{rows.push({...rows.at(-1),sequence:rows.length+1});});
 const baselineFile=path.join(f.owner,files.base,'.delivery-verification-'+repair.scope.original_sha256+'.json'),baselineBytes=fs.readFileSync(baselineFile);
 fs.unlinkSync(baselineFile);const absent=readOnlyChoose();assert.equal(absent.unit.id,'T01');assert(absent.delivery_repair_diagnostics.some(row=>row.reason_code==='delivery-recovery-baseline-unproven'));count++;
 fs.writeFileSync(baselineFile,baselineBytes,{flag:'wx'});assert.equal(choose().unit.id,'T02');
 runs.update(f.owner,milestone,{session_id:'foreign-owner'});assert.throws(()=>repair.start(),/authority-required/);count++;
}finally{global.Date=RealDate;process.env=env;f.cleanup();}}
console.log('PASS '+count+' retained completed claim transfer/repair controls, '+(schemaOnly?'selected Codex/original-schema2 fixture':eventOnly?'selected Codex/inactive fixture':'both observed hosts')+'; original claim and completion unchanged');
