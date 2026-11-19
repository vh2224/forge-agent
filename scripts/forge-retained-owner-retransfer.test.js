#!/usr/bin/env node
'use strict';
// Synthetic historical attempts only; real controller, lease and registry APIs.
const assert=require('assert/strict'),fs=require('fs');
const support=require('./forge-issues-434-436.test'),requestSupport=require('./forge-issues-429-432.test');
const activity=require('./forge-protected-owner-activity'),runs=require('./forge-runs'),roots=require('./forge-code-roots'),lease=require('./forge-unit-lease'),controller=require('./forge-unit-controller');
const questions=require('./forge-pending-questions');
function actor(host,id){if(host==='codex')process.env.CODEX_THREAD_ID=id;else Object.assign(process.env,{FORGE_CLAUDE_OWNER_SESSION_ID:id,FORGE_CLAUDE_OWNER_SOURCE:'claude-sessionstart-env-v1'});}
async function fixture(host,fn){return support.fixture(async f=>{
 const original=requestSupport.activityRequest;let h;
 try{requestSupport.activityRequest=(lab)=>original(lab,host);h=support.historical(f,{expired:true});}finally{requestSupport.activityRequest=original;}
 return fn(f,h);
});}
function transfer(f,h,host,id,extra={}){
 actor(host,id);const inspection=runs.inspectOwnerResume(f.owner,'M001',{hostRuntime:host,expectedSession:id});
 return activity.resumeAttemptOwner({request:h.request,hostRuntime:host,expectedSession:id,expectedRecordSha256:inspection.record_sha256,
  confirmOwnerStopped:true,confirmWorkspaceQuiescent:true,assertAuthority:()=>true,attestStoppedWriter:()=>true,readPendingQuestions:()=>[],...extra});
}
function frozen(f,h){return{receipt:fs.readFileSync(h.parentFile),state:fs.readFileSync(h.parent.recovery_baseline.state_file),lease:fs.readFileSync(lease.leaseFile(f.owner,'execute-task/T01')),begin:fs.readFileSync(controller.transactionFile(f.owner,'fixture-begin')),claim:roots.digest(runs.get(f.owner,'M001').write_claim)};}
function unchanged(f,h,b){support.unchanged(f,h);assert(fs.readFileSync(h.parentFile).equals(b.receipt));assert(fs.readFileSync(h.parent.recovery_baseline.state_file).equals(b.state));assert(fs.readFileSync(lease.leaseFile(f.owner,'execute-task/T01')).equals(b.lease));assert(fs.readFileSync(controller.transactionFile(f.owner,'fixture-begin')).equals(b.begin));assert.equal(roots.digest(runs.get(f.owner,'M001').write_claim),b.claim);}
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}
async function main(){for(const host of ['codex','claude']){
 await test(host+' repeated stopped-owner transfers preserve original open attempt',()=>fixture(host,(f,h)=>{
  runs.update(f.owner,'M001',{active:false});const before=frozen(f,h);
  for(const id of ['second-owner','third-owner','fourth-owner']){
   assert.equal(transfer(f,h,host,id).status,'transferred');const record=runs.get(f.owner,'M001');
   assert.equal(record.active,true);assert.equal(record.session_id,id);assert.equal(record.owner_resume_history.at(-1).kind,'stopped-owner-transfer');unchanged(f,h,before);
  }
  assert.equal(runs.get(f.owner,'M001').owner_resume_history.length,3);
 }));
 await test(host+' prior exact delta approval composes with latest transfer through verified replay/completion',()=>fixture(host,async(f,h)=>{
  runs.update(f.owner,'M001',{active:false});transfer(f,h,host,'second-owner');
  const decision=activity.reconciliationDecision(h.request),opened=questions.openQuestions(decision);
  questions.answer({cwd:f.owner,identity:opened.identity_sha256,answers:[{id:'owner-delta-approval',answer:'aprovar',source:'user-text'}]});
  const approved=activity.reconciliationDecision(h.request,opened.identity_sha256);
  assert.equal(approved.delta_sha256,decision.delta_sha256,'approval must match its own exact unchanged pre-transfer delta');
  const priorCarriers=new Map(['.gsd/forge/runs/M001.json','.gsd/forge/auto-mode.json'].map(p=>[p,fs.readFileSync(require('path').join(f.owner,p))]));
  const resumed=transfer(f,h,host,'third-owner'),before=frozen(f,h);
  const currentView=activity.reconciliationDecision(h.request,opened.identity_sha256);
  const projected=currentView.changes.map(row=>priorCarriers.has(row.path)?{...row,after:require('crypto').createHash('sha256').update(priorCarriers.get(row.path)).digest('hex')}:row).filter(row=>row.before!==row.after);
  assert.deepEqual(projected,approved.changes,'only the new canonical run transfer may change the approved delta');
  const options={request:h.request,hostRuntime:host,operatorDecision:opened.identity_sha256,ownerTransfer:resumed.ownerTransfer,
   assertAuthority:()=>true,attestStoppedWriter:()=>true,readPendingQuestions:()=>[],originalBytes:h.originalBytes,
   attestChanges:challenge=>({challenge_sha256:roots.digest(challenge),changes:challenge.changes.map(row=>({...row,
    kind:row.path.includes('/questions')?'decision-record':row.path.includes('/runs/')?'canonical-owner-transfer':row.path.includes('/leases/')?'same-unit-lease-clock':'canonical-stop',reference:'synthetic actual API observation'}))})};
  assert(activity.createOwnerReconciliation(options),'approved previous delta plus actual new handle reconciles');
  assert.throws(()=>activity.createOwnerReconciliation({...options,ownerTransfer:{}}),/operator-decision-required|transfer-proof-required/);
  const note=require('path').join(f.owner,'.gsd/HANDOFF-new.md');fs.writeFileSync(note,'new unapproved metadata\n');
  assert.throws(()=>activity.createOwnerReconciliation(options),/operator-decision-required/);fs.unlinkSync(note);
  unchanged(f,h,before);
  const reconciliation=activity.createOwnerReconciliation(options),repair=require('./forge-sidecar-verification-repair');
  const cap=repair.create(support.repairOptions(h,{ownerReconciliation:reconciliation})),xllm=require('./forge-xllm'),original=xllm.runExecute;
  let calls=0;xllm.runExecute=async()=>{calls++;throw Error('unexpected provider');};
  try{
   const result=await require('./forge-unit-sidecar').runUnitSidecar(h.request,{verificationSuccessor:cap,ownerReconciliation:reconciliation});
   assert.equal(result.status,'done');assert.equal(calls,0);support.unchanged(f,h);
   const delivery=require('./forge-milestone-time-clock').readCurrentTaskDelivery({cwd:f.owner,milestone:'M001',slice:'S01',task:'T01',begunAt:0,completedAt:Date.now()+1000});
   assert.equal(delivery.status,'proven',JSON.stringify(delivery));
   const begin=controller.lookupRecord(f.owner,'transaction','fixture-begin');
   const completed=require('./forge-orchestrate').run('complete',{cwd:f.owner,milestone:'M001',unit:'execute-task/T01',begin_key:'fixture-begin',host_runtime:host,owner_token:'fixture-loop',generation:begin.generation,result:{status:'done',summary:'synthetic repeated-transfer recovery'}});
   assert.equal(completed.outcome,'completed',JSON.stringify(completed));
  }finally{xllm.runExecute=original;}
 }));
 await test(host+' history never substitutes for live authority or exact original scope',()=>fixture(host,(f,h)=>{
  assert.throws(()=>transfer(f,h,host,'unrelated-active'),/resume-scope-invalid/,'first active owner is not a repeated transfer');
  runs.update(f.owner,'M001',{active:false});transfer(f,h,host,'second-owner');const before=frozen(f,h),file=runs.runFile(f.owner,'M001'),saved=fs.readFileSync(file);
  const mutations=[r=>{delete r.owner_resume_history;},r=>{r.owner_resume_history.at(-1).kind='same-owner-reactivation';},
   r=>{r.owner_resume_history.at(-1).current_session_sha256='f'.repeat(64);},r=>{delete r.owner_resume_history.at(-1).boundary;},
   r=>{r.owner_resume_history.at(-1).boundary.attempt_recovery=[];},r=>{r.owner_resume_history.at(-1).boundary.attempt_recovery.unit='execute-task/T99';},
   r=>{r.owner_resume_history.at(-1).boundary.attempt_recovery.request_sha256='a'.repeat(64);},
   r=>{r.owner_resume_history.at(-1).boundary.attempt_recovery.parent_receipt_sha256='b'.repeat(64);},
   r=>{r.owner_resume_history.at(-1).boundary.attempt_recovery.repair_generation='foreign';},r=>{r.worker='still-running';}];
  for(const mutate of mutations){const value=JSON.parse(saved);mutate(value);fs.writeFileSync(file,JSON.stringify(value));assert.throws(()=>transfer(f,h,host,'third-owner'),/resume-scope-invalid/);fs.writeFileSync(file,saved);}
  for(const extra of [{assertAuthority:()=>false},{attestStoppedWriter:()=>false},{readPendingQuestions:()=>[{id:'pending',status:'pending'}]},
   {confirmOwnerStopped:false},{confirmWorkspaceQuiescent:false},{expectedRecordSha256:'c'.repeat(64)}]){
   assert.throws(()=>transfer(f,h,host,'third-owner',extra),/authority-required|pending-questions|attestation-required|snapshot-changed/);assert(fs.readFileSync(file).equals(saved));
  }
  assert.throws(()=>transfer(f,h,host,'second-owner'),/resume-scope-invalid/,'same active session uses ordinary reconciliation');
  unchanged(f,h,before);
 }));
 }console.log(passed+' passed, '+failed+' failed; no providers or real operator project');if(failed)process.exitCode=1;}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
