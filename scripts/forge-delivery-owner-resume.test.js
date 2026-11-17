'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');const lab=require('./forge-code-roots.test'),fixture=require('./fixtures/completion-delivery.cjs');
const runs=require('./forge-runs'),claims=require('./forge-write-claim'),controller=require('./forge-unit-controller'),api=require('./forge-completion-delivery-recovery');let count=0;
for(const host of ['claude','codex'])for(const active of [true,false]){const f=lab.fixture(),env={...process.env};try{
 const home=path.join(f.dir,'home');fs.mkdirSync(home);Object.assign(process.env,{HOME:home,USERPROFILE:home,FORGE_HOME:path.join(home,'core')});
 const milestone='M001',slice='S01',task='T01',old='old-'+host,actor='new-'+host;fs.mkdirSync(path.join(f.owner,'.gsd'),{recursive:true});fs.writeFileSync(path.join(f.owner,'.gsd/forge-prefs.jsonc'),'{}');
 if(host==='codex')Object.assign(process.env,{CODEX_THREAD_ID:actor});else Object.assign(process.env,{FORGE_CLAUDE_OWNER_SESSION_ID:actor,FORGE_CLAUDE_OWNER_SOURCE:'claude-sessionstart-env-v1'});
 runs.add(f.owner,{id:milestone,kind:'milestone',session_id:old,host_runtime:host,owner_session_source:host==='codex'?'CODEX_THREAD_ID':'claude-sessionstart-env-v1',root:f.owner,project:f.owner});
 fs.mkdirSync(path.join(f.owner,'.gsd/milestones',milestone),{recursive:true});require('./forge-state').write(f.owner,{milestone,phase:'idle',active_slice:slice,active_task:'—',auto_mode:'off'});
 const files=fixture.prepare(f.owner,{milestone,slice,task,codeDir:f.a});claims.recordClaim(f.owner,milestone,{unit:'execute-task/T01',source:'manual',code_dir:f.a,paths:[files.source]});const claim=JSON.stringify(runs.get(f.owner,milestone).write_claim);
 const base=Date.now()-10000;let now=base;const controllerOptions={now:()=>now,prefsReader:()=>({ok:true,prefs:{workflow:{skip_discuss:true,skip_research:true}}})};
 const beginKey='fixture-original',begin=controller.begin(f.owner,{milestone,slice,unit:'execute-task/T01',host_runtime:host,owner_token:old,idempotency_key:beginKey,state_patch:{active_slice:slice}},controllerOptions);assert.equal(begin.ok,true);now+=100;
 controller.complete(f.owner,{milestone,unit:'execute-task/T01',host_runtime:host,owner_token:old,generation:begin.generation,idempotency_key:beginKey+':complete',result:{status:'succeeded'}},controllerOptions);
 const original=JSON.stringify(controller.lookupRecord(f.owner,'transaction',beginKey+':complete'));
 let authority=true,stopped=true,questions=[];const contract=require('./forge-code-roots').validateContract({...f.contract,code_roots:[f.contract.code_roots[0]]});
 const options={cwd:f.owner,milestone,slice,task,runId:milestone,ownerToken:actor,hostRuntime:host,expectedSession:actor,beginKey,completionKey:beginKey+':complete',executionContract:contract,controllerOptions,
 confirmOwnerStopped:true,confirmWorkspaceQuiescent:true,assertAuthority:()=>authority,attestStoppedWriter:()=>stopped,readPendingQuestions:()=>questions};
 runs.update(f.owner,milestone,{active});
 const observed=()=>runs.inspectOwnerResume(f.owner,milestone,{hostRuntime:host,expectedSession:actor});const refresh=()=>({...options,expectedRecordSha256:observed().record_sha256});
 assert.throws(()=>runs.resumeOwner(f.owner,milestone,{hostRuntime:host,expectedSession:actor,expectedRecordSha256:observed().record_sha256,confirmOwnerStopped:true,confirmWorkspaceQuiescent:true}),/claim-held/);count++;
 assert.throws(()=>api.resumeAndCreateRepair({...refresh(),attestStoppedWriter:undefined}),/live-adapter-required/);count++;
 stopped=false;assert.throws(()=>api.resumeAndCreateRepair(refresh()),/writer-not-stopped/);stopped=true;
 questions=[{id:'functional',status:'pending'}];assert.throws(()=>api.resumeAndCreateRepair(refresh()),/pending-questions/);questions=[];authority=false;assert.throws(()=>api.resumeAndCreateRepair(refresh()),/authority-required/);authority=true;count+=3;
 assert.equal(runs.get(f.owner,milestone).session_id,old);assert.equal(JSON.stringify(runs.get(f.owner,milestone).write_claim),claim);
 const nullRoot={...runs.get(f.owner,milestone).write_claim,code_dir:null};runs.update(f.owner,milestone,{write_claim:nullRoot});assert.throws(()=>api.resumeAndCreateRepair(refresh()),/claim-roots-mismatch/);runs.update(f.owner,milestone,{write_claim:JSON.parse(claim)});count++;
 runs.update(f.owner,milestone,{worker:'active-fixture',worker_started:Date.now()});assert.throws(()=>api.resumeAndCreateRepair(refresh()),/worker-unreconciled/);runs.update(f.owner,milestone,{worker:null,worker_started:null});count++;
 now=base+1000;const repair=api.resumeAndCreateRepair(refresh());assert.equal(repair.owner_resume_status,'transferred');assert.equal(JSON.stringify(runs.get(f.owner,milestone).write_claim),claim);const started=repair.start();assert.equal(started.action,'verify-only');count++;
 now=base+3000;fixture.publish(f.owner,{milestone,slice,task,codeDir:f.a,at:new Date(base+2000).toISOString()});assert.equal(repair.complete().outcome,'completed');assert.equal(JSON.stringify(controller.lookupRecord(f.owner,'transaction',beginKey+':complete')),original);count++;
 runs.update(f.owner,milestone,{session_id:'foreign-owner'});assert.throws(()=>repair.start(),/authority-required/);count++;
}finally{process.env=env;f.cleanup();}}
console.log('PASS '+count+' retained completed claim transfer/repair controls, both observed hosts; original claim and completion unchanged');
