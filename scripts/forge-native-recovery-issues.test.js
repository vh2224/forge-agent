'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const delivery=require('./forge-native-recovery-delivery'),side=require('./forge-unit-sidecar');
const recovery=require('./forge-attempt-recovery'),roots=require('./forge-code-roots');
const fixtures=require('./forge-native-recovery-delivery.test');
const {capabilities}=require('./forge-recovery-transition.test');
const controller=require('./forge-unit-controller');
const invocation=request=>require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,
 activeCapabilities:capabilities,prompt:'Isolated recovery issue regression',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'});
async function linkedLifecycle(){
 const f=await fixtures.fixture();
 try{
  const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime);
  const request={...handoff.result.request};
  const physical=[{root_id:'owner',path:f.owner},...f.contract.code_roots.map(r=>({root_id:r.id,path:r.path}))];
  const begin=controller.lookupRecord(f.owner,'transaction','fixture-begin');
  const options={prefsReader:()=>({ok:true,prefs:{workflow:{skip_discuss:true,skip_research:true}}}),ownerToken:'fixture-owner',
   processProbe:()=> 'stopped',inspectAttempt:()=>({receipt_path:f.receiptFile,request:f.request,roots:physical,pending_questions:[]}),
   reconcileRoots:({root})=>({root_id:root.root_id,process_stopped:true,reconciled:true}),
   captureEntryBaseline:()=>({sha256:'a'.repeat(64),roots:physical}),
   questionStateAdapter:()=>({answers:[]}),
   entryAuthority:recovery.createAuthority(reference=>({reference,status:'resolved',answer:'authorize',resolved_at:new Date().toISOString()}))};
  const consumed=controller.consumeFailure(f.owner,{milestone:'M901',unit:begin.unit,begin_key:begin.idempotency_key,
   owner_token:'fixture-owner',host_runtime:'codex',slice:'S01'},options);
  const entered=controller.reenter(f.owner,{milestone:'M901',unit:begin.unit,owner_token:'fixture-owner',host_runtime:'codex',
   entry:{entry_id:'native-linked-regression',failure_key:consumed.failure_key,failure_checksum:consumed.failure_checksum,
    authorization_ref:'conversation:fixture-linked'}},options);
  request.linked_begin_key=entered.transaction.idempotency_key;
  request.resultFile=path.join(f.dir,'linked-native.json');
  request.dispatchId='linked-native-regression';
  const receipts=[],input={request,nativeInvocation:invocation(request),assertBoundary:()=>{},assertAuthority:()=>{},
   linkedEntryOptions:options,persistDeliveryReceipt:r=>receipts.push(r)};
  assert.throws(()=>delivery.prepare({...input,linkedEntryOptions:undefined,assertBoundary:()=>{},assertAuthority:()=>{}}),/authority|required/);
  assert.throws(()=>delivery.prepare({...input,request:{...request,linkedEntryBinding:{}},linkedEntryOptions:undefined,
   assertBoundary:()=>{},assertAuthority:()=>{}}),/authority|required/,'serialized binding cannot replace live adapters');
  const session=delivery.prepare(input);
  function refusesLateQuestion(action,label){
   // Independent negative fixture branch: restore only this fixture's private
   // question-store bytes afterward; this is not a production answer/rollback.
   const dirs=['entry-questions','entry-question-inventories'].map(n=>path.join(f.owner,'.gsd/forge',n));
   const before=dirs.map(d=>({dir:d,files:new Map(fs.existsSync(d)?fs.readdirSync(d).map(n=>[n,fs.readFileSync(path.join(d,n))]):[])}));
   const old=options.questionStateAdapter;
   options.questionStateAdapter=()=>({answers:[],questions:[{id:'late-'+label,question:'Required late choice?'}]});
   try{assert.throws(action,/pending|question/,'live question must stop '+label);}
   finally{
    options.questionStateAdapter=old;
    for(const row of before){
     if(fs.existsSync(row.dir))for(const name of fs.readdirSync(row.dir))if(!row.files.has(name))fs.unlinkSync(path.join(row.dir,name));
     for(const [name,bytes]of row.files)fs.writeFileSync(path.join(row.dir,name),bytes);
    }
   }
  }
  refusesLateQuestion(()=>session.start(),'start');session.start();
  for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
  const result=f.result();result.must_haves_status[0].item='Both claimed files now contain the expected content';
  const raw=JSON.stringify(result);
  refusesLateQuestion(()=>session.returned(result),'returned');session.returned(result);
  refusesLateQuestion(()=>session.verify(result),'verify');session.verify(result);
  refusesLateQuestion(()=>session.publish(result),'publish');const ready=session.publish(result);
  assert.equal(JSON.stringify(result),raw,'worker prose and provenance are retained');
  assert.equal(ready.phase,'ready');
  assert(!Object.hasOwn(session.manifest().request,'linkedEntryBinding'),'manifest carries no opaque handle');
  const serialized=JSON.parse(JSON.stringify(session.manifest()));
  const restarted=delivery.prepare({...input,request:serialized.request,savedManifest:serialized});
  refusesLateQuestion(()=>restarted.replayReady(ready),'replay');restarted.replayReady(ready);
  const pending={...options,questionStateAdapter:()=>({answers:[],questions:[{id:'required-live',question:'Required choice?'}]})};
  assert.throws(()=>delivery.prepare({...input,linkedEntryOptions:pending}),/pending|question/);
  console.log('PASS linked native lifecycle: live rebind, wire restart, exact evidence, paraphrased labels, publication/replay and authority negatives');
 }finally{f.cleanup();}
}
async function retainedCapture(){
 const f=await fixtures.fixture({standalone:true,resultBasename:'execute-task-result.json'});
 try{
  const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
  const receipts=[],session=delivery.prepare({request,nativeInvocation:invocation(request),assertBoundary:f.assertBoundary,
   assertAuthority:f.assertBoundary,persistDeliveryReceipt:r=>receipts.push(r)});
  session.start();for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
  const invalid=f.result();invalid.must_haves_status[0].evidence[0].stdout_line='PASS fabricated assertion';
  session.returned(invalid);assert.throws(()=>session.verify(invalid),/criterion-unobserved-evidence/);
  assert.throws(()=>session.publish(invalid),/verified-result-required/);
  assert(path.basename(request.resultFile).length>=103,'realistic recovery basename exercises the former256-character capture name');
  const prefix='forge-verification-';
  const files=fs.readdirSync(path.dirname(request.resultFile)).filter(n=>n.startsWith(prefix));assert.equal(files.length,1);
  assert.equal(files[0].length,88,'content-addressed capture component is bounded independently of result basename');
  const retained=JSON.parse(fs.readFileSync(path.join(path.dirname(request.resultFile),files[0])));
  assert.equal(retained.kind,'native-verification-capture');assert.equal(retained.capture.passed,true);
  assert.equal(retained.result_sha256,roots.digest(invalid));
  assert.equal(retained.manifest_sha256,roots.digest(fs.readFileSync(request.resultFile+'.manifest.json')));
  assert(retained.capture.gate.roots.every(r=>r.result.checks.length>0&&r.result.checks.every(c=>c.exitCode===0)));
  assert(!receipts.some(r=>r.phase==='ready'),'capture does not grant publication');
  const unit=side.locations(request).rules[side.locations(request).delivery.input].unit;
  const inventory=require('./forge-delivery').inventoryPlan(fs.readFileSync(request.planFile,'utf8'),request.planFile,unit);
  const bind=result=>delivery.criterionBindings(result,retained.capture,require('./forge-delivery').unitKey(unit),{inventory,contract:f.contract});
  for(const change of [r=>r.must_haves_status.pop(),r=>r.must_haves_status.push(r.must_haves_status[0]),
   r=>{r.must_haves_status[0].index=999;},r=>{r.must_haves_status[0].item='';}]){
   const r=f.result();change(r);assert.throws(()=>bind(r));
  }
  console.log('PASS verification retention: actual successful commands survive binding refusal; raw result hashes, incomplete/duplicate/foreign/empty labels and no-publication guards preserved');
 }finally{f.cleanup();}
}
async function persistedAnsweredContinuation(){
 const f=await fixtures.fixture({linked:true});
 try{
  const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
  const options=f.linkedEntryOptions,receipts=[];
  const input={request,nativeInvocation:invocation(request),assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,
   linkedEntryOptions:options,persistDeliveryReceipt:r=>receipts.push(r)};
  const original=delivery.prepare(input),saved=original.manifest();
  options.questionStateAdapter=()=>({answers:[],questions:[{id:'late-persisted',question:'Continue this unchanged plan?'}]});
  assert.throws(()=>original.start(),/pending|question/);
  assert(!fs.existsSync(request.resultFile+'.manifest.json'),'no writer/invocation started before the required question');
  const store=path.join(f.owner,'.gsd/forge/entry-questions');
  const questionFiles=fs.readdirSync(store).map(n=>path.join(store,n));
  assert(questionFiles.some(file=>fs.readFileSync(file,'utf8').includes('late-persisted')),'pending ID remains persisted');
  options.questionStateAdapter=()=>({answers:[{id:'late-persisted',answer:'Continue the unchanged plan.'}]});
  controller.validateLinkedEntry(f.owner,request.linked_begin_key,options);
  const answered=questionFiles.map(file=>fs.readFileSync(file));
  const old=delivery.prepare({...input,savedManifest:saved});
  assert.throws(()=>old.start(),/execution-protected-metadata/,'old manifest is not silently rebased after an answer');
  // The interaction contract requires a NEW dispatch of the same unit after
  // explicit answers. This pre-start fixture has no writer to reconcile.
  const next={...request,dispatchId:'answered-continuation',resultFile:path.join(f.dir,'answered-continuation.json')};
  assert.equal(next.taskId,request.taskId);assert.equal(next.linked_begin_key,request.linked_begin_key);
  const session=delivery.prepare({...input,request:next,nativeInvocation:invocation(next)});session.start();
  for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
  const result=f.result();session.returned(result);session.verify(result);session.publish(result);
  for(let index=0;index<questionFiles.length;index++)assert.deepEqual(fs.readFileSync(questionFiles[index]),answered[index],
   'answered continuation preserves the real persisted question/answer bytes');
  console.log('PASS persisted answers: late required ID retained, explicit answer reattested, old manifest refused, fresh same-unit dispatch publishes without restoring question files');
 }finally{f.cleanup();}
}
async function main(){await linkedLifecycle();await retainedCapture();await persistedAnsweredContinuation();}
if(require.main===module)(process.argv.includes('--answered')?persistedAnsweredContinuation():main()).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
