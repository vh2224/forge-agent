'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const lab=require('./forge-code-roots.test'),roots=require('./forge-code-roots'),claims=require('./forge-write-claim');
const controller=require('./forge-unit-controller'),orchestrate=require('./forge-orchestrate'),delivery=require('./forge-delivery');
const runs=require('./forge-runs'),verify=require('./forge-verify'),legacy=require('./fixtures/completion-delivery.cjs');
const f=lab.fixture(),saved={...process.env},milestone='M001',slice='S01',host='codex';let checks=0,now=Date.now();
const put=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
const options={now:()=>now,prefsReader:()=>({ok:true,prefs:{workflow:{skip_discuss:true,skip_research:true}}})};
const unitFor=task=>({type:'task',id:task,milestone,slice});
const baseFor=task=>`.gsd/milestones/${milestone}/slices/${slice}/tasks/${task}`;
const planFor=task=>`${baseFor(task)}/${task}-PLAN.md`;
const claimFor=(task,contract,paths)=>claims.normalizeClaim({schema_version:2,source:'manual',unit:'execute-task/'+task,execution_contract:contract,paths});
function begin(task,claim){
 runs.update(f.owner,milestone,{write_claim:claim});now=Date.now();
 const key='root-bindings:'+task,owner=runs.get(f.owner,milestone).session_id;
 const result=controller.begin(f.owner,{milestone,slice,unit:'execute-task/'+task,host_runtime:host,owner_token:owner,idempotency_key:key,state_patch:{active_slice:slice}},options);
 assert.equal(result.ok,true);return{key,owner};
}
function complete(task,begun){
 now=Date.now()+1;
 const result=orchestrate.run('complete',{cwd:f.owner,milestone,unit:'execute-task/'+task,host_runtime:host,owner_token:begun.owner,begin_key:begun.key,result:{status:'done'}},options);
 assert.equal(result.outcome,'completed',JSON.stringify({reason:result.reason_code,details:result.details}));
 return begun.key+':complete';
}
function publishModern(task,contract,plan,command){
 const unit=unitFor(task),base=baseFor(task);
 const capture=verify.captureRootDelivery(contract,plan,{unit,resourceEventSink(){},commandsByRoot:Object.fromEntries(contract.code_roots.map(root=>[root.id,[command]]))});
 assert.equal(capture.passed,true);const key=delivery.unitKey(unit),bindings=[],files=[];
 for(const [index,root] of contract.code_roots.entries()){
  const verification=base+'/'+task+'-'+root.id+'-VERIFY.json',artifact=base+'/'+task+'-'+root.id+'-ARTIFACT.json';
  const observed=capture.gate.roots.find(row=>row.root_id===root.id),structural=capture.artifacts.find(row=>row.root_id===root.id);
  assert.equal(observed.schema_version,1);assert.equal(structural.schema_version,1);
  assert.equal(observed.execution_contract_sha256,roots.digest(contract));assert.equal(observed.root_identity_sha256,root.identity_sha256);
  put(path.join(f.owner,verification),observed);put(path.join(f.owner,artifact),structural);files.push(verification,artifact);
  bindings.push({criterion_id:key+':truth:0',root_id:root.id,coverage:'behavioral',source:{kind:'verification',path:verification,check_index:0}},
   {criterion_id:key+':artifact:'+index,root_id:root.id,coverage:'structural',source:{kind:'artifact',path:artifact,row_index:0,property:'exists'}});
 }
 const input={schema_version:2,unit,execution_contract:contract,plan:planFor(task),plan_fingerprint:roots.digest(plan),bindings};
 const value=delivery.buildDelivery(input,{ownerRoot:f.owner,codeDir:f.a});assert(value.criteria.every(row=>row.status==='verificado'));
 put(path.join(f.owner,base,task+'-DELIVERY-INPUT.json'),input);put(path.join(f.owner,base,task+'-DELIVERY.json'),value);
 return files;
}
function modern(){
 const task='T01',plan=lab.plan(f.contract).replace('id: T-roots','id: T01');put(path.join(f.owner,planFor(task)),plan);
 const paths=f.contract.code_roots.map(root=>({root_id:root.id,path:'./same.txt'}));
 const claim=claimFor(task,f.contract,[...paths.reverse(),paths[0]]),begun=begin(task,claim);
 const command='node -e "require(\'assert\').equal(require(\'fs\').readFileSync(\'same.txt\',\'utf8\'),\'before\\n\');console.log(\'PASS exact root content\')"';
 const files=publishModern(task,f.contract,plan,command);
 const completion=complete(task,begun);assert.equal(controller.verifyCommittedCompletionBoundary(f.owner,completion,claim).unit,'execute-task/'+task);checks++;
 const wrongScope={...claim,paths:claim.paths.map((row,index)=>index===0?{...row,path:'different.txt'}:row)};
 assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,completion,wrongScope),/boundary-not-transferable/);checks++;
 const completionAt=Date.parse(controller.lookupRecord(f.owner,'transaction',completion).event.ts);
 assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,completion,{...claim,at:completionAt}),/boundary-not-transferable/);checks++;
 for(const changed of [roots.validateContract({...f.contract,code_roots:[f.contract.code_roots[0]]}),
   roots.validateContract({...f.contract,code_roots:f.contract.code_roots.map(root=>({...root,id:root.id==='alpha'?'other':root.id})),primary_root_id:'other'})]){
  const foreign=claimFor(task,changed,changed.code_roots.map(root=>({root_id:root.id,path:'same.txt'})));
  assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,completion,foreign),/boundary-not-transferable/);checks++;
 }
 const file=path.join(f.owner,files[0]),bytes=fs.readFileSync(file);
 for(const mutate of [row=>{delete row.root_identity_sha256;},row=>{row.root_id='foreign';},row=>{row.root_identity_sha256='0'.repeat(64);},
   row=>{row.execution_contract_sha256='0'.repeat(64);},row=>{row.code_dir=f.b;},row=>{row.code_dir=null;}]){
  const row=JSON.parse(bytes);mutate(row);put(file,row);
  assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,completion,claim),/boundary-not-transferable|record-conflict/);checks++;
  fs.writeFileSync(file,bytes);assert.equal(controller.verifyCommittedCompletionBoundary(f.owner,completion,claim).unit,'execute-task/'+task);
 }
 const originalClaim=JSON.stringify(runs.get(f.owner,milestone).write_claim),originalSession=process.env.CODEX_THREAD_ID;
 for(const alternate of [claim.paths.map((row,index)=>index===0?{...row,path:'different.txt'}:row),claim.paths]){
  const changed=claims.recordClaim(f.owner,milestone,{schema_version:2,source:'manual',unit:'execute-task/'+task,execution_contract:f.contract,paths:alternate});
  assert(changed.at>completionAt,'a genuinely re-recorded claim is newer than its completed predecessor');
  process.env.CODEX_THREAD_ID='re-recorded-claim-owner';const snapshot=runs.inspectOwnerResume(f.owner,milestone,{hostRuntime:host,expectedSession:process.env.CODEX_THREAD_ID});
  assert.throws(()=>runs.resumeOwner(f.owner,milestone,{hostRuntime:host,expectedSession:process.env.CODEX_THREAD_ID,expectedRecordSha256:snapshot.record_sha256,confirmOwnerStopped:true,confirmWorkspaceQuiescent:true}),/owner-resume-claim-held/);
  assert.equal(runs.get(f.owner,milestone).session_id,originalSession);assert.equal(JSON.stringify(runs.get(f.owner,milestone).write_claim),JSON.stringify(changed));checks++;
  process.env.CODEX_THREAD_ID=originalSession;runs.update(f.owner,milestone,{write_claim:JSON.parse(originalClaim)});
 }
 // A later artifact unit must not make the retained task claim use the new
 // active slice's plan. Its authentic source scope remains S01/T01.
 put(path.join(f.owner,`.gsd/milestones/${milestone}/slices/S02/S02-PLAN.md`),'# Planned next slice\n- [ ] **T02** — Repeated local ID with an explicit future plan\n');
 put(path.join(f.owner,`.gsd/milestones/${milestone}/slices/S02/tasks/T02/T02-PLAN.md`),legacy.plan('T02'));now=Date.now();
 const artifact=controller.begin(f.owner,{milestone,unit:'plan-slice/S02',slice:'S02',host_runtime:host,owner_token:originalSession,idempotency_key:'root-bindings:artifact-after-task',state_patch:{active_slice:'S02'}},options);assert.equal(artifact.ok,true);
 now=Date.now()+1;controller.complete(f.owner,{milestone,unit:'plan-slice/S02',host_runtime:host,owner_token:originalSession,generation:artifact.generation,idempotency_key:'root-bindings:artifact-after-task:complete',result:{status:'succeeded'}},options);
 assert.equal(controller.verifyCommittedCompletionBoundary(f.owner,completion,claim).unit,'execute-task/'+task);checks++;
 process.env.CODEX_THREAD_ID='root-binding-successor';
 const observation=runs.inspectOwnerResume(f.owner,milestone,{hostRuntime:host,expectedSession:process.env.CODEX_THREAD_ID});
 const moved=runs.resumeOwner(f.owner,milestone,{hostRuntime:host,expectedSession:process.env.CODEX_THREAD_ID,expectedRecordSha256:observation.record_sha256,confirmOwnerStopped:true,confirmWorkspaceQuiescent:true});
 assert.equal(moved.status,'transferred');assert.equal(JSON.stringify(moved.record.write_claim),originalClaim);checks++;
 console.log('PASS genuine modern multiroot schema1 envelopes: exact normalized writes, stale re-record refusal and artifact-after-task retained-claim owner handoff');
}
function legacyCase(task,partial){
 const contract=roots.validateContract({...f.contract,code_roots:[f.contract.code_roots[0]]}),unit=unitFor(task),files=legacy.prepare(f.owner,{...unit,task,codeDir:f.a});
 const claim=claimFor(task,contract,[{root_id:contract.primary_root_id,path:files.source}]),begun=begin(task,claim);
 const published=legacy.publish(f.owner,{milestone,slice,task,codeDir:f.a});
 if(partial){
  for(const suffix of ['VERIFY-ENVELOPE','ARTIFACT-ENVELOPE']){
   const file=path.join(f.owner,files.base,task+'-'+suffix+'.json'),row=JSON.parse(fs.readFileSync(file,'utf8'));Object.assign(row,partial);put(file,row);
  }
  const value=delivery.buildDelivery(published.input,{ownerRoot:f.owner,codeDir:f.a});assert(value.criteria.every(row=>row.status==='verificado'),'the genuine v1 observation is completed before the stricter retained-claim admission');
  put(path.join(f.owner,files.base,task+'-DELIVERY.json'),value);
 }
 const completion=complete(task,begun);
 if(partial)assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,completion,claim),/boundary-not-transferable/);
 else assert.equal(controller.verifyCommittedCompletionBoundary(f.owner,completion,claim).unit,'execute-task/'+task);
 checks++;
 return{completion,claim,files};
}
function globCase(){
 const task='T06',contract=roots.validateContract({...f.contract,code_roots:[f.contract.code_roots[0]]});
 put(path.join(f.a,'.gitignore'),'node_modules/\n.gsd/\n*.tsbuildinfo\ncoverage/\n');
 const files=legacy.prepare(f.owner,{milestone,slice,task,codeDir:f.a}),plan=fs.readFileSync(files.planFile,'utf8').replace('writes: [src/T06.js]','writes: [src/**, node_modules/**]');put(files.planFile,plan);
 const claim=claimFor(task,contract,[{root_id:contract.primary_root_id,path:'./src/**'},{root_id:contract.primary_root_id,path:'node_modules/**'}]),begun=begin(task,claim);
 publishModern(task,contract,plan,'node -e "require(\'assert\').equal(require(\'./src/T06.js\'),1);console.log(\'PASS glob task\')"');
 assert.equal(controller.verifyCommittedCompletionBoundary(f.owner,complete(task,begun),claim).unit,'execute-task/'+task);checks++;
 console.log('PASS declared source/install globs retain their canonical scope after actual captured completion');
}
function repeatedLegacy(previous){
 const task='T02',otherSlice='S02',files=legacy.prepare(f.owner,{milestone,slice:otherSlice,task,codeDir:f.a});
 const claim=claims.recordClaim(f.owner,milestone,{source:'manual',unit:'execute-task/'+task,code_dir:f.a,paths:[files.source]});
 assert(claim.at>Date.parse(controller.lookupRecord(f.owner,'transaction',previous.completion).event.ts));
 assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,previous.completion,claim),/boundary-not-transferable/);checks++;
 now=Date.now();const owner=runs.get(f.owner,milestone).session_id,key='root-bindings:'+otherSlice+':'+task;
 const begun=controller.begin(f.owner,{milestone,slice:otherSlice,unit:'execute-task/'+task,host_runtime:host,owner_token:owner,idempotency_key:key,state_patch:{active_slice:otherSlice}},options);assert.equal(begun.ok,true);
 legacy.publish(f.owner,{milestone,slice:otherSlice,task,codeDir:f.a});now=Date.now()+1;
 assert.equal(orchestrate.run('complete',{cwd:f.owner,milestone,unit:'execute-task/'+task,host_runtime:host,owner_token:owner,begin_key:key,result:{status:'done'}},options).outcome,'completed');
 assert.equal(controller.verifyCommittedCompletionBoundary(f.owner,key+':complete',claim).unit,'execute-task/'+task);checks++;
 assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,key+':complete',previous.claim),/boundary-not-transferable/);checks++;
 const retained=JSON.stringify(runs.get(f.owner,milestone).write_claim);process.env.CODEX_THREAD_ID='legacy-repeat-successor';
 const observation=runs.inspectOwnerResume(f.owner,milestone,{hostRuntime:host,expectedSession:process.env.CODEX_THREAD_ID});
 const moved=runs.resumeOwner(f.owner,milestone,{hostRuntime:host,expectedSession:process.env.CODEX_THREAD_ID,expectedRecordSha256:observation.record_sha256,confirmOwnerStopped:true,confirmWorkspaceQuiescent:true});
 assert.equal(moved.status,'transferred');assert.equal(JSON.stringify(moved.record.write_claim),retained);checks++;
 console.log('PASS repeated legacy local ID: new slice claim cannot reuse old completion, old claim cannot adopt new slice, unique newer claim remains attributable');
}
function historicalDeclaration(task,omitted,allowed){
 const files=legacy.prepare(f.owner,{milestone,slice,task,codeDir:f.a});
 const plan=fs.readFileSync(files.planFile,'utf8').replace(new RegExp('^'+omitted+':.*\\n','m'),'');put(files.planFile,plan);
 const claim=claims.recordClaim(f.owner,milestone,{source:'manual',unit:'execute-task/'+task,code_dir:f.a,paths:[files.source]}),begun=begin(task,claim);
 legacy.publish(f.owner,{milestone,slice,task,codeDir:f.a});const completion=complete(task,begun);
 if(allowed)assert.equal(controller.verifyCommittedCompletionBoundary(f.owner,completion,claim).unit,'execute-task/'+task);
 else assert.throws(()=>controller.verifyCommittedCompletionBoundary(f.owner,completion,claim),/boundary-not-transferable/);
 checks++;
}
try{
 const home=path.join(f.dir,'home');fs.mkdirSync(home);Object.assign(process.env,{HOME:home,USERPROFILE:home,CODEX_THREAD_ID:'root-binding-owner'});delete process.env.FORGE_HOME;
 put(path.join(f.owner,'.gsd/forge-prefs.jsonc'),'{}');
 fs.mkdirSync(path.join(f.owner,'.gsd/milestones',milestone),{recursive:true});
 require('./forge-state').write(f.owner,{milestone,phase:'idle',active_slice:slice,active_task:'—',auto_mode:'off'});
 runs.add(f.owner,{id:milestone,kind:'milestone',session_id:process.env.CODEX_THREAD_ID,owner_session_source:'CODEX_THREAD_ID',host_runtime:host,active:true,root:f.owner,cwd:f.owner});
 modern();const previous=legacyCase('T02',null);legacyCase('T03',{root_id:'alpha'});legacyCase('T04',{root_identity_sha256:f.contract.code_roots[0].identity_sha256});legacyCase('T05',{execution_contract_sha256:roots.digest(f.contract)});globCase();repeatedLegacy(previous);
 historicalDeclaration('T07','depends',true);historicalDeclaration('T08','writes',false);
 console.log('PASS historical known writes survive unrelated missing depends; absent writes stay unproven without a writer-admission fallback');
 console.log('PASS pure legacy sole physical root; any partial modern field refuses without legacy fallback');
 console.log('PASS '+checks+' completion root-binding controls');
}finally{process.env=saved;f.cleanup();}
