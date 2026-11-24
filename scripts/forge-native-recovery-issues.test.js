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
  session.returned(invalid);
  assert.equal(receipts.length,1);assert.equal(JSON.parse(fs.readFileSync(receipts[0].file,'utf8')).phase,'executed');
  assert.equal(fs.readdirSync(path.dirname(request.resultFile)).filter(n=>n.startsWith('forge-returned-')).length,0);
  console.log('PASS issue337 native valid path: an accepted return persists its executed receipt without a retention file');
  assert.throws(()=>session.verify(invalid),/criterion-unobserved-evidence/);
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
// Issue 337: a contract-valid done result refused by the integrity guard is
// retained privately; the refusal, its precedence and every gate are unchanged.
async function retainedReturnedRefusal(){
 const f=await fixtures.fixture();
 try{
  const sha=v=>require('crypto').createHash('sha256').update(v).digest('hex');
  const execution=require('./forge-task-execution');
  const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
  const nativeInvocation=invocation(request),receipts=[];
  const session=delivery.prepare({request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,
   persistDeliveryReceipt:r=>receipts.push(r)});
  session.start();
  for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
  const slicePlan=path.join(f.owner,'.gsd/milestones/M901/slices/S01/S01-PLAN.md');
  fs.appendFileSync(slicePlan,'caller drift line for issue 337\n');
  const dir=path.dirname(request.resultFile),retainedNames=()=>fs.readdirSync(dir).filter(n=>n.startsWith('forge-returned-'));
  const planBytes=fs.readFileSync(slicePlan),stateBytes=fs.existsSync(f.stateFile)?fs.readFileSync(f.stateFile):null;
  const claimDigest=()=>roots.digest(require('./forge-runs').get(f.owner,request.runId).write_claim);
  const claimBefore=claimDigest(),ownerBefore=roots.digest(execution.protectedSnapshot(f.owner));
  const refused={code:'execution-protected-metadata'};
  const extra={...f.result(),unexpected:true},partial={...f.result(),status:'partial'};
  assert.throws(()=>session.returned(extra),refused);assert.throws(()=>session.returned(partial),refused);
  assert.equal(retainedNames().length,0,'invalid or partial results are never retained');
  const result=f.result(),raw=JSON.stringify(result);
  assert.throws(()=>session.returned(result),refused);
  const names=retainedNames();assert.equal(names.length,1);assert.match(names[0],/^forge-returned-[a-f0-9]{64}\.json$/);
  const file=path.join(dir,names[0]),bytes=fs.readFileSync(file),envelope=JSON.parse(bytes);
  assert.equal(names[0],'forge-returned-'+sha(bytes)+'.json');
  assert.deepEqual(Object.keys(envelope),['schema_version','kind','accepted','trust','refusal','dispatch_id','fingerprint',
   'recovery_identity_sha256','route','manifest_sha256','result']);
  assert.equal(envelope.kind,'native-returned-response-retained');assert.equal(envelope.accepted,false);
  assert.deepEqual(envelope.refusal,{reason_code:'execution-protected-metadata'});
  assert.equal(envelope.dispatch_id,request.dispatchId);assert.equal(envelope.fingerprint,side.artifactFingerprint(request));
  assert.equal(envelope.recovery_identity_sha256,roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request))));
  assert.deepEqual(envelope.route,request.route);
  assert.equal(envelope.manifest_sha256,sha(fs.readFileSync(request.resultFile+'.manifest.json')));
  assert.equal(JSON.stringify(envelope.result),raw);
  for(const text of [nativeInvocation.args?.message,nativeInvocation.args?.prompt,'Isolated recovery issue regression',request.prompt].filter(Boolean))
   assert(!bytes.toString('utf8').includes(text),'no prompt text is retained');
  for(const root of [f.owner,...f.contract.code_roots.map(r=>r.path)])
   assert(!roots.within(fs.realpathSync.native(root),fs.realpathSync.native(file)),'retention stays outside '+root);
  console.log('PASS issue337 native refusal retention: execution-protected-metadata retains one unaccepted forge-returned envelope with the exact result, dispatch, fingerprint, recovery identity, route and manifest');

  assert.throws(()=>session.returned(f.result()),refused);
  assert.deepEqual(retainedNames(),names);assert.deepEqual(fs.readFileSync(file),bytes);
  const foreign=Buffer.from('foreign fixture bytes\n');
  fs.writeFileSync(file,foreign);
  assert.throws(()=>session.returned(f.result()),refused);
  assert.deepEqual(fs.readFileSync(file),foreign,'foreign target bytes are never overwritten');
  fs.writeFileSync(file,bytes);
  console.log('PASS issue337 native precedence: invalid or partial results keep the same refusal without retention; repeated refusal is idempotent and foreign target bytes never replace the refusal');

  assert.equal(receipts.length,0);
  const receiptPrefix=path.basename(request.resultFile)+'.receipt.json.';
  assert.equal(fs.readdirSync(dir).filter(n=>n.startsWith(receiptPrefix)).length,0);
  assert(!fs.existsSync(path.join(f.owner,side.locations(request).required[0])),'no DELIVERY');
  assert.deepEqual(fs.readFileSync(slicePlan),planBytes,'caller drift stays, no marker or restore');
  if(stateBytes)assert.deepEqual(fs.readFileSync(f.stateFile),stateBytes);else assert(!fs.existsSync(f.stateFile));
  assert.equal(claimDigest(),claimBefore);
  assert.equal(roots.digest(execution.protectedSnapshot(f.owner)),ownerBefore);
  assert.throws(()=>session.publish(result),/verified-result-required/);
  console.log('PASS issue337 native no acceptance: no receipt, publication, marker, DELIVERY, claim, state or owner metadata change from retention');
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
// Issue 328: the Claude-only transport option of a failed Claude writer never
// reaches a native successor, while the historical original stays exact.
const stateApi=require('./forge-xllm-state'),transitions=require('./forge-recovery-transition'),xllm=require('./forge-xllm');
function sidecarGuard(){
 const saved={runExecute:xllm.runExecute,invokeClaudeTransport:xllm.invokeClaudeTransport},guard={calls:0};
 for(const name of Object.keys(saved))xllm[name]=async()=>{guard.calls++;throw new Error('issue328 Claude sidecar transport must not run');};
 guard.restore=()=>Object.assign(xllm,saved);
 return guard;
}
const withoutOption=request=>{const {claudePermissions:omitted,...rest}=request;return rest;};
const identityOf=request=>roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request)));
const deliveryFile=f=>path.join(f.owner,side.locations(f.request).required[0]);
const SLICE_PLAN='.gsd/milestones/M901/slices/S01/S01-PLAN.md';
async function issue328Delivery(){
 const f=await fixtures.fixture({beforeBegin:f=>{f.request.claudePermissions='verification';}});
 const guard=sidecarGuard();
 try{
  assert.equal(f.request.route.resolved_worker_engine,'claude');assert.equal(f.request.route.worker_mode,'sidecar');
  const receiptBytes=fs.readFileSync(f.receiptFile),receipt=JSON.parse(receiptBytes);
  const input=JSON.parse(JSON.stringify(f.request)),inputJson=JSON.stringify(input);
  assert.equal(receipt.fingerprint,side.artifactFingerprint(f.request));
  assert.notEqual(receipt.fingerprint,side.artifactFingerprint(withoutOption(f.request)));
  assert.equal(f.initial.attempts[0].caller_request_sha256,recovery.callerRequestHash(f.request));
  assert.equal(f.initial.request_identity_sha256,identityOf(f.request));
  let calls=0,observed=null;
  f.runtime.invokeNative=async(next,binding,session)=>{
   calls++;observed=next;
   assert(!Object.hasOwn(next,'claudePermissions'),'native successor carries no Claude-only option');
   for(const key of Object.keys(input).filter(k=>!['claudePermissions','route','dispatchId','resultFile'].includes(k)))
    assert.deepEqual(next[key],input[key],key);
   assert.deepEqual(Object.keys(next).sort(),[...Object.keys(withoutOption(input)),'recoveryStateFile'].sort());
   assert.equal(next.route.resolved_worker_engine,'codex');assert.equal(next.route.worker_mode,'native');
   assert.equal(next.route.tier,f.request.route.tier);assert.equal(next.route.effort,f.request.route.effort);
   const model=next.route.model_resolved||next.route.model;
   assert.equal(binding.args.model,model);assert(capabilities.models.includes(model),model);
   assert.equal(binding.args.reasoning_effort,next.route.effort);
   assert.equal(identityOf(next),identityOf(f.request));
   assert.equal(session.manifest().verification_seal.command_timeout_ms,300000);
   for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
   return f.result();
  };
  const result=await side.recoverUnitSidecar(input,f.recovery,f.runtime);
  assert.equal(calls,1);assert.equal(guard.calls,0);
  assert.equal(result.result.published.result.status,'done');
  assert.equal(fs.readFileSync(path.join(f.owner,SLICE_PLAN),'utf8'),'# Slice\n- [x] **T01** — fixture\n');
  assert(fs.existsSync(deliveryFile(f)),'DELIVERY published');
  const state=stateApi.loadRecovery(f.stateFile);
  const manifest=JSON.parse(fs.readFileSync(state.continuation.delivery.manifest_file));
  assert(!Object.hasOwn(manifest.request,'claudePermissions'),'delivery manifest carries no Claude-only option');
  assert.equal(manifest.request.dispatchId,observed.dispatchId);
  assert.deepEqual(manifest.request.route,JSON.parse(JSON.stringify(observed.route)));
  assert.equal(state.continuation.status,'returned');
  assert.equal(state.continuation.reservation_sha256,f.recovery.resumeReservation.sha256);
  assert.deepEqual(state.attempts,f.initial.attempts);assert.deepEqual(state.reservations,f.initial.reservations);
  assert.deepEqual(fs.readFileSync(f.receiptFile),receiptBytes);assert.equal(JSON.stringify(input),inputJson);
  console.log('PASS issue328 destination projection: native successor and manifest omit only claudePermissions; contract, claim, gates, verification, tier, effort and explicit model unchanged');
  console.log('PASS issue328 native publication: public recoverUnitSidecar reaches one native lab callback, real verify and publish, zero Claude sidecar calls');
  f.runtime.writerObservationAdapter=transitions.createWriterObservationAdapter(challenge=>({...challenge,
   binding_sha256:roots.digest(challenge),status:'stopped',writer_identity:'fixture-native',evidence_reference:'fixture:awaited-return'}));
  const files=result.result.published.artifacts.map(a=>path.join(f.owner,a.path));
  const stamp=()=>files.map(file=>[fs.readFileSync(file,'utf8'),fs.statSync(file).mtimeMs]),settled=stamp();
  const replayed=await side.recoverUnitSidecar(JSON.parse(inputJson),f.recovery,f.runtime);
  assert.equal(replayed.action,'replay');assert.equal(replayed.provider_called,false);
  assert.equal(calls,1);assert.equal(guard.calls,0);
  assert.deepEqual(stamp(),settled,'replay writes no published bytes');
  console.log('PASS issue328 replay: the projected successor manifest replays without a second callback or new published bytes');
  await assert.rejects(()=>side.recoverUnitSidecar({...f.request,route:observed.route},f.recovery,f.runtime),{code:'claude-permission-policy-invalid'});
  assert.equal(calls,1);assert.equal(guard.calls,0);
  const closing=stateApi.loadRecovery(f.stateFile);
  assert.deepEqual(fs.readFileSync(f.receiptFile),receiptBytes);
  assert.deepEqual(closing.attempts,f.initial.attempts);assert.deepEqual(closing.reservations,f.initial.reservations);
  assert.equal(closing.request_identity_sha256,f.initial.request_identity_sha256);
  assert.equal(JSON.stringify(input),inputJson);assert.equal(JSON.stringify(f.request),inputJson);
  console.log('PASS issue328 original preserved: exact Claude request, failed receipt bytes, fingerprint, caller hash, identity, attempts and reservations unchanged through delivery and replay');
 }finally{guard.restore();f.cleanup();}
}
async function issue328Refusal(option,run){
 const f=await fixtures.fixture({beforeBegin:f=>{f.request.claudePermissions=option;}});
 const guard=sidecarGuard();
 try{
  let calls=0;
  f.runtime.invokeNative=async()=>{calls++;throw new Error('issue328 refused destination must not run');};
  const receiptBytes=fs.readFileSync(f.receiptFile);
  await run(f);
  assert.equal(calls,0);assert.equal(guard.calls,0);
  assert.deepEqual(fs.readFileSync(f.receiptFile),receiptBytes);
  const state=stateApi.loadRecovery(f.stateFile);
  assert.deepEqual(state.attempts,f.initial.attempts);assert.deepEqual(state.reservations,f.initial.reservations);
  assert(!state.continuation,'no prepared continuation');
  assert(!fs.existsSync(deliveryFile(f)),'no DELIVERY');
  assert.equal(fs.readFileSync(path.join(f.owner,SLICE_PLAN),'utf8'),'# Slice\n- [ ] **T01** — fixture\n');
 }finally{guard.restore();f.cleanup();}
}
async function issue328Refusals(){
 await issue328Refusal('all',async f=>{
  const stateBytes=fs.readFileSync(f.stateFile);
  for(const request of [f.request,{...f.request,claudePermissions:true},{...f.request,claudePermissions:null}])
   await assert.rejects(()=>side.recoverUnitSidecar(JSON.parse(JSON.stringify(request)),f.recovery,f.runtime),{code:'claude-permission-policy-invalid'});
  assert.deepEqual(fs.readFileSync(f.stateFile),stateBytes);
 });
 console.log('PASS issue328 malformed and foreign options: original-bound invalid values and a non-Claude original refuse with claude-permission-policy-invalid before any callback');
 await issue328Refusal('verification',async f=>{
  recovery.createRecovery({unit:'execute-task/T01',roots_sha256:roots.digest(f.contract),request:f.request,
   state:stateApi.loadRecovery(f.stateFile),clock:()=>f.now,persist:v=>stateApi.saveRecovery(f.stateFile,v)})
   .questions([{id:'issue328-required',question:'Required choice?'}]);
  const outcome=await side.recoverUnitSidecar(JSON.parse(JSON.stringify(f.request)),f.recovery,f.runtime);
  assert.equal(outcome.action,'pending-questions');
  assert(outcome.questions.some(q=>q.id==='issue328-required'&&q.status==='pending'),'pending ID returned');
 });
 console.log('PASS issue328 pending question: a required pending question stops the option-bearing recovery before any callback or continuation');
 await issue328Refusal('verification',async f=>{
  f.runtime.activeCapabilities={...capabilities,models:[]};
  let error=null;
  try{await side.recoverUnitSidecar(JSON.parse(JSON.stringify(f.request)),f.recovery,f.runtime);}catch(e){error=e;}
  assert(error&&typeof error.code==='string'&&error.code,'adapter refusal code');
  assert.notEqual(error.code,'claude-permission-policy-invalid');
 });
 console.log('PASS issue328 incompatible destination: the native adapter refusal keeps history and reservations and fabricates no continuation or publication');
}
function issue328ProjectionTable(){
 const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;};
 const claude={host_runtime:'codex',resolved_worker_engine:'claude',worker_mode:'sidecar',tier:'heavy',effort:'high',model:'claude-sonnet-5'};
 const codex={host_runtime:'codex',resolved_worker_engine:'codex',worker_mode:'native',tier:'heavy',effort:'high',model:'gpt-5.6-sol'};
 const base={unitType:'execute-task',milestoneId:'M1',sliceId:'S01',taskId:'T01',cwd:'/fixture/code',contextRoot:'/fixture/owner',
  dispatchId:'issue328',resultFile:'/fixture/result.json',execution_contract:{schema_version:2,primary_root_id:'primary'},
  claim:{schema_version:2,generation:'g'},gates:{claim:'proceed',security:'passed'},verification:{commandTimeoutMs:300000},
  claudePermissions:'verification',route:claude};
 const fix={...base,unitType:'review-fix',reviewFix:{decision:'proceed',items:[]}};
 const standalone={...base,scope:'standalone-task',phase:'execute',taskId:'T-20261107000000-fixture'};
 delete standalone.milestoneId;delete standalone.sliceId;
 const project=side.projectTransportOptions;
 const omitted=(original,value=freeze({...original,route:codex}))=>{
  const before=JSON.stringify(value),out=project(value,freeze(JSON.parse(JSON.stringify(original))));
  assert.notEqual(out,value);assert(!Object.hasOwn(out,'claudePermissions'));
  assert.deepEqual(Object.keys(out),Object.keys(value).filter(k=>k!=='claudePermissions'));
  for(const key of Object.keys(out))assert.equal(out[key],value[key],key);
  assert.equal(JSON.stringify(value),before);
  const again=project(value,original);assert.deepEqual(again,out);
  assert.equal(recovery.callerRequestHash(again),recovery.callerRequestHash(out));
 };
 const unchanged=(original,value)=>{
  freeze(value);const before=JSON.stringify(value);
  assert.equal(project(value,freeze(JSON.parse(JSON.stringify(original)))),value);assert.equal(JSON.stringify(value),before);
 };
 omitted(base);omitted(fix);omitted(standalone);
 unchanged(base,{...base,route:claude});
 unchanged(base,{...base,route:{...claude,host_runtime:'claude',worker_mode:'native'}});
 unchanged(base,{...base,route:{...codex,resolved_worker_engine:undefined}});
 unchanged(base,{...base,route:{...codex,resolved_worker_engine:''}});
 for(const option of ['all',true,null,'Verification',['verification'],{}]){
  unchanged(base,{...base,route:codex,claudePermissions:option});
  unchanged({...base,claudePermissions:option},{...base,route:codex});
 }
 unchanged({...base,route:codex},{...base,route:codex});
 unchanged({...base,unitType:'plan-slice'},{...base,unitType:'plan-slice',route:codex});
 unchanged({...base,execution_contract:undefined},{...base,route:codex});
 unchanged(base,withoutOption({...base,route:codex}));
 console.log('PASS issue328 projection rule: only an exact verification option of a Claude writer original is omitted for a non-Claude destination; inputs never mutate');
}
async function main(){await linkedLifecycle();await retainedCapture();await retainedReturnedRefusal();await persistedAnsweredContinuation();
 await issue328Delivery();await issue328Refusals();issue328ProjectionTable();}
if(require.main===module)(process.argv.includes('--answered')?persistedAnsweredContinuation():main()).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
