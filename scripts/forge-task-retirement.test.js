'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const retirement=require('./forge-task-retirement'),recovery=require('./forge-owner-window-recovery'),personal=require('./forge-personal-context'),runs=require('./forge-runs'),windows=require('./forge-owner-transport-window'),roots=require('./forge-code-roots');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-task-retirement-'))),saved={...process.env};
const put=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
const git=(cwd,args)=>{const r=cp.spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);};
try{
 Object.assign(process.env,{HOME:path.join(lab,'home'),USERPROFILE:path.join(lab,'home'),FORGE_HOME:path.join(lab,'forge')});fs.mkdirSync(process.env.HOME);
 (async()=>{
  for(const host of ['codex','claude']){
   const owner=path.join(lab,host),code=path.join(lab,host+'-code'),id='T-20261115223000-retire-'+host,milestone='M-20261115223000-successor';
   fs.mkdirSync(path.join(owner,'.gsd'),{recursive:true});fs.mkdirSync(code);git(code,['init','-q']);git(code,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']);
   process.env.CODEX_THREAD_ID='previous-'+host;process.env.FORGE_CLAUDE_OWNER_SESSION_ID='previous-'+host;process.env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';
   const actor=runs.observeHostSession(host,process.env.FORGE_CLAUDE_OWNER_SESSION_ID);windows.ensureTask(owner,id);runs.add(owner,{id,kind:'task',session_id:actor.sessionId,host_runtime:host,owner_session_source:actor.source,root:owner,cwd:owner});
   put(path.join(owner,'.gsd/milestones',milestone,milestone+'-STATE.md'),'---\nmilestone: '+milestone+'\n---\n');
   const brief=path.join(owner,'.gsd/tasks',id,id+'-BRIEF.md');put(brief,'Preparation only; no PLAN or successful implementation.\n');
   assert.equal(personal.bindWork({project:owner,id,intent:'create'}).status,'ok');
   assert.equal(personal.saveCheckpoint({project:owner,id,intent:'checkpoint',checkpoint:{pending:[{text:'Unanswered historical question',source:brief}],nextAction:[{text:'Prepare task',source:brief}]}}).status,'ok');
   const q={schema_version:1,scope:'standalone-task',phase:'brainstorm',taskId:id,cwd:code,contextRoot:owner,hostRuntime:host,workflowId:'retirement399',dispatchId:'retire-'+host,resultFile:path.join(lab,'channels',host+'.json'),inputs:{brief:'Fixture'},constraints:{auto_commit:false,deploy:false}};
   const fingerprint=require('./forge-task-preparation').preparationRequestFingerprint(require('./forge-task-preparation').validateRequest(q));
   const receiptFile=q.resultFile+'.receipt.json';put(receiptFile,JSON.stringify({phase:'failed',dispatch_id:q.dispatchId,request_fingerprint:fingerprint,input_pending_questions:[{id:'Q-1',question:'Old question',status:'pending'}],failure:{reason_code:'artifact-direct-write-detected'}}));
   const originalReceipt=fs.readFileSync(receiptFile);put(path.join(code,'retained.txt'),'Uncommitted content must remain\n');
   process.env.CODEX_THREAD_ID='current-'+host;process.env.FORGE_CLAUDE_OWNER_SESSION_ID='current-'+host;
   let decisions=0;const adapter=recovery.createHostAdapter({hostRuntime:host,
    observeWriters:ch=>({challenge_sha256:roots.digest(ch),scope_sha256:ch.scope_sha256,observation_kind:'live-host-writer-census',coverage_complete:true,
     previous_session_sha256:ch.scope.previous_host_session_sha256,writers:[],previous_owner_stopped:true,joined:true,possible_writers:0,reference:'controlled fixture has no writer processes'}),
    reconcile:ch=>({scope_sha256:ch.scope_sha256,reconciled:true,reference:'measured retained code and failed receipt'}),
    observeDecision:ch=>{decisions++;return{challenge_sha256:roots.digest(ch),outcome:ch.intent.outcome,successor_id:ch.intent.successor_id,reference:'explicit simulated operator decision'};}});
   const options={owner,request:q,outcome:'superseded',successorId:milestone,adapter};
   let before=retirement.inspect(options);assert.equal(before.status,'open');
   const originalHome=process.env.HOME,originalProfile=process.env.USERPROFILE,foreignHome=path.join(lab,'foreign-'+host);fs.mkdirSync(foreignHome);
   try{
    process.env.HOME=foreignHome;process.env.USERPROFILE=foreignHome;
    assert.throws(()=>retirement.inspect(options),/task-retirement-personal-binding-required/,'another personal profile cannot retire this task');
   }finally{process.env.HOME=originalHome;process.env.USERPROFILE=originalProfile;}
   runs.update(owner,id,{write_claim:{}});
   assert.throws(()=>retirement.inspect(options),/task-retirement-claim-held/,'an unmeasured claim cannot be treated as released');
   runs.update(owner,id,{write_claim:null});before=retirement.inspect(options);
   await assert.rejects(retirement.closeTask({...options,expected:before.observation_sha256,adapter:{}}),/owner-window-live-host-required/);
   const noDecision=recovery.createHostAdapter({hostRuntime:host,observeWriters:()=>({}),reconcile:()=>({})});
   await assert.rejects(retirement.closeTask({...options,expected:before.observation_sha256,adapter:noDecision}),/task-retirement-decision-required/);
   const baseObservation=recovery.assertAdapter(adapter),indexRace=require('./forge-doctor').createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:baseObservation.observeWriters,observeDecision:baseObservation.observeDecision,
    reconcile:ch=>{git(code,['add','retained.txt']);return baseObservation.reconcile(ch);}});
   await assert.rejects(retirement.closeTask({...options,expected:before.observation_sha256,adapter:indexRace}),/task-retirement-state-changed/,'index-only change must refuse task retirement');
   git(code,['restore','--staged','--','retained.txt']);decisions=0;before=retirement.inspect(options);
   const result=await require('./forge-doctor').retireTask({...options,expected:before.observation_sha256});assert.equal(result.closed,true);assert.equal(result.outcome,'superseded');
   assert.equal(runs.get(owner,id).active,false);assert(fs.readFileSync(receiptFile).equals(originalReceipt));assert.equal(fs.readFileSync(path.join(code,'retained.txt'),'utf8'),'Uncommitted content must remain\n');
   const snapshot=personal.readPersonalSnapshot({project:owner,id}),work=snapshot.works[0];assert.equal(work.workStatus,'superseded');assert.equal(work.reliability,'current');assert.equal(work.checkpoint.pending[0].resolved,false,'retirement must not answer old functional questions');
   assert.equal(work.nextAction,null);assert.equal(personal.selectPersonalWork({project:owner}).selected,null);
   const summary=require('./forge-personal-summary').buildPersonalSummary({project:owner});assert.equal(summary.status,'ok');assert(!summary.works.some(w=>w.id===id),'retired task is historical, not active personal queue');
   assert.throws(()=>runs.update(owner,id,{active:true}),/run-retired/);
   assert.throws(()=>runs.updateWith(owner,id,current=>{current.active=true;return{};}),/run-retired/);
   assert.throws(()=>runs.ensureStepRun(owner,id,host),/run-retired/);
   assert.equal(require('./forge-cli-helpers').resolveRunFromArgs(owner,id).reason,'run-retired');
   assert.throws(()=>windows.coordinatePreparation(q,fingerprint),/run-retired/);assert.equal(windows.observed(owner),null);
   const repeated=await retirement.closeTask(options);assert.equal(repeated.status,'already-retired');assert.equal(decisions,1,'same published decision is not requested twice');
   assert.equal(retirement.readPublished(owner,runs.get(owner,id)).record.worktree_disposition,'retained');
   const file=result.retirement_file,bytes=fs.readFileSync(file);fs.appendFileSync(file,' ');
   assert.equal(personal.readPersonalSnapshot({project:owner,id}).works[0].workStatus,'unknown','changed terminal evidence must not silently hide the task');fs.writeFileSync(file,bytes);
   const seed=suffix=>{
    const taskId='T-20261115223001-'+suffix+'-'+host;windows.ensureTask(owner,taskId);
    const live=runs.observeHostSession(host,process.env.FORGE_CLAUDE_OWNER_SESSION_ID);runs.add(owner,{id:taskId,kind:'task',session_id:live.sessionId,host_runtime:host,owner_session_source:live.source,root:owner,cwd:owner});
    put(path.join(owner,'.gsd/tasks',taskId,taskId+'-BRIEF.md'),'Unstarted task\n');assert.equal(personal.bindWork({project:owner,id:taskId,intent:'create'}).status,'ok');
    const request={...q,taskId,dispatchId:suffix+'-'+host,resultFile:path.join(lab,'channels',suffix+'-'+host+'.json')};
    put(request.resultFile+'.receipt.json',JSON.stringify({phase:'failed',dispatch_id:request.dispatchId,request_fingerprint:require('./forge-task-preparation').preparationRequestFingerprint(require('./forge-task-preparation').validateRequest(request))}));
    const base=recovery.assertAdapter(adapter),ownAdapter=require('./forge-doctor').createOwnerRecoveryAdapter({hostRuntime:host,
     observeWriters:async ch=>({...await base.observeWriters(ch),previous_owner_stopped:false}),reconcile:base.reconcile,observeDecision:base.observeDecision});
    return{owner,request,outcome:'cancelled',adapter:ownAdapter};
   };
   const pending=seed('cancel');const updateWith=runs.updateWith;
   runs.updateWith=function(cwd,taskId,mutator,...rest){return updateWith(cwd,taskId,current=>{const patch=mutator(current);if(taskId===pending.request.taskId)throw Object.assign(new Error('fixture pre-publication I/O'),{code:'EIO'});return patch;},...rest);};
   let partial;try{partial=await require('./forge-doctor').retireTask(pending);}finally{runs.updateWith=updateWith;}
   assert.equal(partial.closed,false);assert.equal(partial.publication_diagnostic.cause_code,'EIO');assert.equal(runs.get(owner,pending.request.taskId).active,true);
   assert.notEqual(personal.readPersonalSnapshot({project:owner,id:pending.request.taskId}).works[0].workStatus,'cancelled','orphan retirement file is not authority');
   const orphanBytes=fs.readFileSync(partial.retirement_file),cancelled=await require('./forge-doctor').retireTask(pending);assert.equal(cancelled.closed,true);assert.equal(cancelled.outcome,'cancelled');assert(fs.readFileSync(partial.retirement_file).equals(orphanBytes));
   const post=seed('postpublish');runs.updateWith=function(...args){const value=updateWith(...args);if(args[1]===post.request.taskId)throw Object.assign(new Error('fixture post-publication I/O'),{code:'EIO'});return value;};
   let committed;try{committed=await require('./forge-doctor').retireTask(post);}finally{runs.updateWith=updateWith;}
   assert.equal(committed.closed,true,'an actual committed retirement survives a later projection error');assert.equal(committed.publication_diagnostic.cause_code,'EIO');
   assert.equal(personal.readPersonalSnapshot({project:owner,id:post.request.taskId}).works[0].workStatus,'cancelled');
   assert.equal(require('./forge-personal-summary').buildPersonalSummary({project:owner}).reason,'all-closed');
  }
  console.log('PASS explicit superseding on both hosts; missing-plan task, live decision/proof gates, retained code/receipt/questions, terminal personal projection and idempotence');
 })().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{process.env=saved;assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});});
}catch(error){process.env=saved;throw error;}
