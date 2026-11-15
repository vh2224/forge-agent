'use strict';
// A terminal administrative outcome, never implementation success or acceptance.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const roots=require('./forge-code-roots'),runs=require('./forge-runs'),windows=require('./forge-owner-transport-window'),recovery=require('./forge-owner-window-recovery'),ids=require('./forge-ids');
const digest=roots.digest,OUTCOMES=new Set(['cancelled','superseded']);
function fail(code){throw Object.assign(new Error(code),{code});}
function intent(outcome,successorId){
 if(!OUTCOMES.has(outcome)||outcome==='cancelled'&&successorId!==undefined)fail('task-retirement-intent-invalid');
 if(outcome==='superseded'&&(!ids.isValid(successorId)||ids.entityKind(successorId)!=='milestone'))fail('task-retirement-successor-required');
 return{outcome,successor_id:outcome==='superseded'?successorId:null};
}
function readPublished(owner,run){
 if(!run?.task_retirement)return null;
 try{
  owner=roots.realDirectory(owner);if(run.kind!=='task'||!ids.isValid(run.id)||run.active!==false||run.worker||run.worker_started)fail('task-retirement-record-invalid');
  const ref=run.task_retirement;
  if(!/^[a-f0-9]{32}$/.test(ref.nonce||'')||ref.file!==`.gsd/tasks/${run.id}/${run.id}-RETIREMENT-${ref.nonce}.json`)fail('task-retirement-record-invalid');
  const file=path.join(owner,ref.file),bytes=recovery.readEvidence(file,4*1024*1024),record=JSON.parse(bytes);
  if(digest(bytes)!==ref.sha256||record.schema_version!==1||record.kind!=='standalone-task-retirement'||record.task_id!==run.id
   ||roots.key(record.owner)!==roots.key(owner)||record.nonce!==ref.nonce||record.intent.outcome!==ref.outcome||!OUTCOMES.has(record.intent.outcome)
   ||record.worktree_disposition!=='retained'||record.artifacts_accepted!==false||record.code_completed!==false)fail('task-retirement-record-invalid');
  for(const key of ['decision_reference','writer_reference','reconciliation_reference'])if(typeof record[key]!=='string'||!record[key].trim()||record[key].length>2048)fail('task-retirement-record-invalid');
  if(record.actor?.host_runtime!==run.host_runtime||!/^[a-f0-9]{64}$/.test(record.actor?.session_sha256||'')
    ||record.scope?.task_id!==run.id||!/^[a-f0-9]{64}$/.test(record.scope?.request_sha256||'')
    ||!/^[a-f0-9]{64}$/.test(record.scope?.receipt?.sha256||''))fail('task-retirement-record-invalid');
  intent(record.intent.outcome,record.intent.successor_id===null?undefined:record.intent.successor_id);
  return{valid:true,record,file,sha256:ref.sha256};
 }catch{return{valid:false,reason:'task-retirement-evidence-invalid'};}
}
function ownWork(owner,taskId){
 const snapshot=require('./forge-personal-context').readPersonalSnapshot({project:owner,id:taskId});
 if(snapshot.status!=='ok'||snapshot.works.length!==1||snapshot.works[0].id!==taskId)fail('task-retirement-personal-binding-required');return snapshot.works[0];
}
function measure(options){
 windows.assertMutationAllowed(options.owner);
 const measured=recovery.measureTask(options),work=ownWork(measured.owner,measured.request.taskId),published=readPublished(measured.owner,measured.run);
 if(published){if(!published.valid)fail(published.reason);return{...measured,work,published};}
 if(work.workStatus==='completed')fail('task-retirement-already-completed');
 if(require('./forge-write-claim').isHeld(measured.run.write_claim))fail('task-retirement-claim-held');
 if(!measured.receipt)fail('task-retirement-receipt-required');
 const desired=intent(options.outcome,options.successorId);
 if(desired.successor_id)recovery.readEvidence(path.join(measured.owner,'.gsd/milestones',desired.successor_id,desired.successor_id+'-STATE.md'));
 const scope={...measured.scope,intent:desired,personal_checkpoint_sha256:digest(work.checkpoint)};
 return{...measured,work,scope,observation_sha256:digest(scope)};
}
function inspect(options){
 const measured=measure(options);if(measured.published)return{status:measured.published.record.intent.outcome,closed:true,retirement_file:measured.published.file};
 return{status:'open',closed:false,task_id:measured.request.taskId,observation_sha256:measured.observation_sha256,intent:measured.scope.intent,
  worktree_disposition:'retained',artifacts_accepted:false,required_evidence:['decisão explícita observada do operador','join dos escritores','reconciliação exata dos roots e recibo preservados']};
}
async function closeTask(options){
 const adapter=recovery.assertAdapter(options.adapter),measured=measure(options),desired=intent(options.outcome,options.successorId);
 if(measured.published){
  if(digest(measured.published.record.intent)!==digest(desired))fail('task-retirement-intent-conflict');
  return{status:'already-retired',closed:true,outcome:desired.outcome,retirement_file:measured.published.file};
 }
 if(typeof adapter.observeDecision!=='function')fail('task-retirement-decision-required');
 if(options.expected!==measured.observation_sha256)fail('task-retirement-state-changed');
 if(adapter.actor.hostRuntime!==measured.run.host_runtime)fail('owner-window-cross-host-unsupported');
 const nonce=crypto.randomBytes(16).toString('hex'),challenge={operation:'retire-standalone-task',nonce,actor:recovery.actorWire(adapter.actor),intent:desired,scope_sha256:measured.observation_sha256,scope:measured.scope};
 const decision=await adapter.observeDecision(recovery.freezeChallenge(challenge));recovery.assertAdapter(options.adapter);
 if(decision?.challenge_sha256!==digest(challenge)||decision.outcome!==desired.outcome||(decision.successor_id??null)!==desired.successor_id
  ||typeof decision.reference!=='string'||!decision.reference.trim()||decision.reference.length>2048)fail('task-retirement-decision-required');
 const proof=await recovery.observeStopped(options.adapter,challenge,{requirePreviousOwnerStopped:digest(measured.run.session_id)!==digest(adapter.actor.sessionId)});
 if(measure(options).observation_sha256!==measured.observation_sha256)fail('task-retirement-state-changed');
 let file,record,publicationDiagnostic=null;
 const closed=windows.withMutation(measured.owner,()=>{
  if(measure(options).observation_sha256!==measured.observation_sha256)fail('task-retirement-state-changed');
  record={schema_version:1,kind:'standalone-task-retirement',owner:measured.owner,task_id:measured.request.taskId,nonce,intent:desired,at:new Date().toISOString(),
   actor:recovery.actorWire(adapter.actor),decision_reference:decision.reference,...proof,scope:measured.scope,
   worktree_disposition:'retained',artifacts_accepted:false,code_completed:false,questions_disposition:'retained-unanswered-history',previous_worker:measured.run.worker||null};
  const relative=`.gsd/tasks/${record.task_id}/${record.task_id}-RETIREMENT-${nonce}.json`;file=path.join(measured.owner,relative);
  let receiptWritten=false;
  try{
   const updated=runs.updateWith(measured.owner,record.task_id,current=>{
    if(digest(recovery.readEvidence(runs.runFile(measured.owner,record.task_id)))!==measured.scope.run_sha256||current.task_retirement)fail('task-retirement-state-changed');
    windows.ensureTask(measured.owner,record.task_id);const bytes=Buffer.from(JSON.stringify(record,null,2)+'\n');
    fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});receiptWritten=true;
    return{active:false,worker:null,worker_started:null,worker_slice:null,task_retirement:{file:relative,nonce,sha256:digest(bytes),outcome:desired.outcome}};
   });
   if(!updated||!readPublished(measured.owner,runs.get(measured.owner,record.task_id))?.valid)fail('task-retirement-publication-unmeasured');
   return true;
  }catch(error){
   if(!receiptWritten)throw error;
   publicationDiagnostic={reason_code:'task-retirement-publication-error',layer:'owner-publication',cause_code:/^[A-Za-z0-9_-]{1,120}$/.test(error.code||'')?error.code:'unknown'};
   // A post-write projection error cannot turn a committed retirement back
   // into "not closed". Read the actual publication before reporting partial.
   try{
    const actual=JSON.parse(recovery.readEvidence(runs.runFile(measured.owner,record.task_id))),published=readPublished(measured.owner,actual);
    if(published?.valid&&published.record.nonce===nonce)return true;
    return actual.task_retirement?'unknown':false;
   }catch{return'unknown';}
  }
 });
 return{status:closed===true?'retired':'partial',closed,outcome:desired.outcome,retirement_file:file,worktree_disposition:'retained',artifacts_accepted:false,
  ...(publicationDiagnostic?{publication_diagnostic:publicationDiagnostic}:{}),
  ...(closed===true?{}:{reason_code:'task-retirement-run-publication-failed'})};
}
function isClosedWork(owner,work){
 if(work.kind!=='task'||!OUTCOMES.has(work.workStatus))return false;
 const published=readPublished(owner,runs.get(owner,work.id));return published?.valid===true&&published.record.intent.outcome===work.workStatus;
}
module.exports={inspect,closeTask,readPublished,isClosedWork};
