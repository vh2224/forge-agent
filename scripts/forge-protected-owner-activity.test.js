'use strict';
// Synthetic consent adapter; real questions, roots, controller and reconciliation.
// No operator-project data or provider inference is used by this fixture.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const activity=require('./forge-protected-owner-activity'),questions=require('./forge-pending-questions');
const roots=require('./forge-code-roots'),runs=require('./forge-runs'),execution=require('./forge-task-execution');
const support=require('./forge-issues-434-436.test'),successor=require('./forge-sidecar-verification-successor');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const put=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
async function fixture(action,answers={}){return support.fixture(async f=>{
  const file=path.join(f.a,'.gsd/forge/events.jsonl'),prefix=Buffer.from('{"retained":true}\n');put(file,prefix);
  const h=support.historical(f),decision=activity.reconciliationDecision(h.request),owner=questions.openQuestions(decision);
  questions.answer({cwd:f.owner,identity:owner.identity_sha256,answers:[{id:'owner-delta-approval',answer:answers.ownerAnswer??'aprovar',source:'tool-answer'}]});
  const ts=new Date().toISOString(),triple=[{ts,kind:'resource-admission',reason:'platform-unsupported:win32',source:'platform-degraded',workers:2,pressureLevel:null},
    {ts,kind:'resource-pool-granted',granted:2,ceiling:2,reason:'pool-granted'},
    {ts,kind:'resource-pool-released',granted:2,reason:'pool-released'}];
  const appended=Buffer.from([...triple,...triple].map(JSON.stringify).join('\n')+'\n');fs.appendFileSync(file,appended);
  const originalOwnerAnswer=fs.readFileSync(path.join(f.owner,'.gsd/forge/questions',owner.identity_sha256+'.json'));
  const rootOptions={ownerDecision:owner.identity_sha256,rootId:'alpha',originalBytes:prefix,appendedBytes:appended};
  const proposal=activity.codeRootAppendDecision(h.request,rootOptions),opened=questions.openQuestions(proposal);
  const answerFile=path.join(f.owner,'.gsd/forge/questions',opened.identity_sha256+'.json');
  const originFile=path.join(f.owner,'.gsd/forge/questions',opened.identity_sha256+'.origin.json');
  const answer=()=>questions.answer({cwd:f.owner,identity:opened.identity_sha256,answers:[{id:'code-root-append-approval',answer:answers.rootAnswer??'aprovar',source:'tool-answer'}]});
  const options=()=>({request:h.request,hostRuntime:'codex',operatorDecision:owner.identity_sha256,
    assertAuthority:()=>true,attestStoppedWriter:()=>true,readPendingQuestions:()=>[],originalBytes:h.originalBytes,
    attestChanges:challenge=>({challenge_sha256:roots.digest(challenge),changes:challenge.changes.map(row=>({...row,
      kind:row.path.includes('/questions')?'decision-record':'operator-reviewed',reference:'synthetic exact fixture observation'}))}),
    codeRootAppendApproval:{...rootOptions,operatorDecision:opened.identity_sha256,
      attestOperatorAnswer:challenge=>({observed:true,challenge_sha256:roots.digest(challenge),reference:'synthetic host actually handled this canonical answer'})}});
  await action({f,h,file,prefix,appended,rootOptions,proposal,opened,answerFile,originFile,answer,options});
  assert(fs.readFileSync(path.join(f.owner,'.gsd/forge/questions',owner.identity_sha256+'.json')).equals(originalOwnerAnswer));
  support.unchanged(f,h);
});}

// Issue455: old resolved answers are reviewed DATA; only the fresh answer authorizes.
function historyPaths(x,id){return['.json','.origin.json'].map(s=>path.join(x.f.owner,'.gsd/forge/questions',id+s));}
function removeFixtureQuestions(x,ids){for(const id of ids)for(const file of historyPaths(x,id))if(fs.existsSync(file))fs.unlinkSync(file);}
function oldHistory(x){
  x.answer();
  const owner=questions.openQuestions(activity.reconciliationDecision(x.h.request));
  questions.answer({cwd:x.f.owner,identity:owner.identity_sha256,answers:[{id:'owner-delta-approval',answer:'nao',source:'tool-answer'}]});
  const root=questions.openQuestions(activity.codeRootAppendDecision(x.h.request,{...x.rootOptions,ownerDecision:owner.identity_sha256}));
  questions.answer({cwd:x.f.owner,identity:root.identity_sha256,answers:[{id:'code-root-append-approval',answer:'nao',source:'tool-answer'}]});
  const ids=[x.rootOptions.ownerDecision,x.opened.identity_sha256,owner.identity_sha256,root.identity_sha256];
  const pins=new Map(ids.flatMap(id=>historyPaths(x,id).map(file=>[file,fs.readFileSync(file)])));
  for(const id of ids){const answer=questions.continuation({cwd:x.f.owner,identity:id});assert(answer.ok);
    assert.equal(answer.identity.unit,'execute-task/T01');assert.equal(answer.identity.milestone,'M001');assert.equal(answer.identity.slice,'S01');assert.equal(answer.identity.task,'T01');assert.equal(answer.identity.workflow_id,'M001');
    for(const field of ['dispatch_id','request_fingerprint','receipt_phase'])assert.equal(answer.identity[field],null,'owner-origin history cannot prove an exact old request');}
  return{ids,pins,owner:owner.identity_sha256,root:root.identity_sha256};
}
function freshHistoryApproval(x,history,created=[],checkCoverage=true){
  const decision=activity.reconciliationDecision(x.h.request);
  if(checkCoverage){for(const[file,bytes]of history.pins){const relative=path.relative(x.f.owner,file).replace(/\\/g,'/');assert.equal(decision.changes.filter(row=>row.path===relative&&row.after===sha(bytes)).length,1,'both exact historical carrier hashes remain in reviewed');}
    const digest=roots.digest({owner:fs.realpathSync.native(x.f.owner),unit:'execute-task/T01',dispatch_id:x.h.request.dispatchId,changes:decision.changes});
    assert.equal(decision.delta_sha256,digest,'history must not be omitted from reviewed digest');assert.equal(decision.decision_set,'owner-delta/'+digest);}
  const owner=questions.openQuestions(decision);created.push(owner.identity_sha256);
  questions.answer({cwd:x.f.owner,identity:owner.identity_sha256,answers:[{id:'owner-delta-approval',answer:'aprovar',source:'tool-answer'}]});
  const rootOptions={...x.rootOptions,ownerDecision:owner.identity_sha256};
  const append=questions.openQuestions(activity.codeRootAppendDecision(x.h.request,rootOptions));created.push(append.identity_sha256);
  questions.answer({cwd:x.f.owner,identity:append.identity_sha256,answers:[{id:'code-root-append-approval',answer:'aprovar',source:'tool-answer'}]});
  const original=x.options();return{...original,operatorDecision:owner.identity_sha256,
    attestChanges:challenge=>{const classified=original.attestChanges(challenge);return{...classified,changes:classified.changes.map(row=>history.ids.slice(0,2).some(id=>row.path.endsWith('/'+id+'.json')||row.path.endsWith('/'+id+'.origin.json'))?{...row,kind:'operator-reviewed'}:row)};},
    codeRootAppendApproval:{...original.codeRootAppendApproval,...rootOptions,operatorDecision:append.identity_sha256}};
}
function refusedHistory(error){return typeof error?.code==='string'&&(/^(owner-reconciliation-|pending-question-|root-append-)/.test(error.code)||error.code==='ENOENT');}
async function historicalCarrierNegatives(){return fixture(async x=>{
  const history=oldHistory(x),stateFile=historyPaths(x,history.owner)[0],originFile=historyPaths(x,history.owner)[1];
  assert.throws(()=>activity.createOwnerReconciliation(x.options()),refusedHistory,'an old positive answer is not current authority');
  const extra=(name,patch={},resolved=true)=>{const d=activity.reconciliationDecision(x.h.request),q=questions.openQuestions({...d,...patch});
    if(resolved)questions.answer({cwd:x.f.owner,identity:q.identity_sha256,answers:[{id:d.questions[0].id,answer:'nao',source:'tool-answer'}]});
    return()=>removeFixtureQuestions(x,[q.identity_sha256]);};
  const mutate=(file,change)=>{const bytes=fs.readFileSync(file);change(bytes);return()=>fs.writeFileSync(file,bytes);};
  const cases=[
    {name:'unresolved historical pair',prepare:()=>extra('pending',{},false)},
    {name:'missing origin pair',prepare:()=>mutate(originFile,()=>fs.unlinkSync(originFile))},
    {name:'corrupt canonical origin',prepare:()=>mutate(originFile,b=>{const v=JSON.parse(b);v.identity_sha256='f'.repeat(64);fs.writeFileSync(originFile,JSON.stringify(v));})},
    {name:'canonical cross-unit history',prepare:()=>extra('unit',{unit:'execute-task/T02',task:'T02'})},
    {name:'canonical cross-workflow history',prepare:()=>extra('workflow',{workflow_id:'M002'})},
    {name:'canonical unknown decision purpose',prepare:()=>extra('purpose',{decision_set:'unrelated/'+sha('synthetic unknown purpose')})}
  ];
  for(const row of cases){const restore=row.prepare(),created=[];try{
    assert.throws(()=>{const options=freshHistoryApproval(x,history,created,false);activity.createOwnerReconciliation(options);},refusedHistory,row.name);
  }finally{removeFixtureQuestions(x,created);restore();}}
  const created=[],options=freshHistoryApproval(x,history,created);
  try{
    const old=fs.readFileSync(stateFile);fs.appendFileSync(stateFile,' ');
    assert.throws(()=>activity.createOwnerReconciliation(options),refusedHistory,'new current carrier hash was not approved');fs.writeFileSync(stateFile,old);
    assert.throws(()=>activity.createOwnerReconciliation({...options,operatorDecision:undefined}),refusedHistory,'fresh current approval is mandatory');
    const cap=activity.createOwnerReconciliation(options);activity.withOwnerReconciliationRead(cap,x.h.request,()=>{});
    fs.appendFileSync(stateFile,' ');assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),'historical state mutation after capability must refuse');fs.writeFileSync(stateFile,old);
    const origin=fs.readFileSync(originFile);fs.unlinkSync(originFile);assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),'historical origin deletion after capability must refuse');fs.writeFileSync(originFile,origin);
    activity.withOwnerReconciliationRead(cap,x.h.request,()=>{});
    for(const[file,bytes]of history.pins)assert(fs.readFileSync(file).equals(bytes),'all old answers/origins retained byte-exact');
    console.log('PASS issue455 historical carrier negatives: unresolved/missing/corrupt/cross-unit/cross-workflow/purpose, fresh hashes, post-cap mutation/deletion; no old answer grants authority');
  }finally{removeFixtureQuestions(x,created);}
});}

// These are real module calls with invalid handles, not an injected profile.
// They prove refusal precedes the action and all owner-window/lease writes.
async function nativeProfileForgeryNegatives(x){
  const windows=require('./forge-owner-transport-window');
  assert.equal(windows.observed(x.f.owner),null);
  const before=execution.protectedSnapshot(x.f.owner),request={...structuredClone(x.h.request),
    scope:'milestone',unitType:'execute-task',phase:'execute',route:{...x.h.request.route,worker_mode:'native'}};
  let calls=0;
  const forged=[{},Object.freeze({joined:true,provider_called:false}),
    JSON.parse(JSON.stringify({profile_id:'forge-native463-fixture-foreground-v1',joined:true,possible_writers:0})),
    Object.freeze({assertJoined:()=>({joined:true}),assertActivityAdmission:()=>true})];
  for(const handle of forged){
    await assert.rejects(activity.withNativeExecutionActivity(request,handle,async()=>{calls++;}),
      error=>error.code==='native-host-profile-required');
    assert.equal(calls,0);assert.equal(windows.observed(x.f.owner),null);
    assert.deepEqual(execution.protectedSnapshot(x.f.owner),before,'forged profile cannot open or extend a lease/window');
  }
  console.log('PASS native activity refuses JSON/facts/function-shaped profiles before action or owner writes');
}

// Independent observation for the actual isolated Bridge CLI integration.
// This helper never mints profile/join/publication/settlement authority. In
// particular an absent external window alone does not prove native settlement.
function assertFixtureNativeCoordination({fixtureRoot,owner,dispatchId,unit,generation,phase}){
  const os=require('node:os'),lease=require('./forge-unit-lease'),windows=require('./forge-owner-transport-window');
  const root=fs.realpathSync.native(fixtureRoot),tmp=fs.realpathSync.native(os.tmpdir());
  assert.equal(path.dirname(root),tmp);assert.match(path.basename(root),/^forge-native463-fixture-[A-Za-z0-9_-]+$/);
  assert(!fs.lstatSync(root).isSymbolicLink());
  const marker=path.join(root,'FIXTURE-ORIGIN.json'),stat=fs.lstatSync(marker);
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=4096);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)),{schema_version:1,kind:'forge-native463-isolated-fixture',root});
  const physicalOwner=fs.realpathSync.native(owner),rel=path.relative(root,physicalOwner);
  assert(rel&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));
  assert.equal(path.resolve(owner),physicalOwner);assert.match(unit,/^execute-task\/T\d+(?:\.\d+)?$/);
  assert.equal(typeof dispatchId,'string');assert(dispatchId);assert.equal(typeof generation,'string');assert(generation);
  assert(['held','absent','held-with-lease-drift','held-live-relay'].includes(phase));
  const observed=windows.observed(physicalOwner),held=lease.readLease(lease.leaseFile(physicalOwner,unit));
  // The negative phase deliberately leaves lease corruption to the REAL runtime
  // guard below, while still proving exact fixture/window identity here.
  if(phase!=='held-with-lease-drift'){assert(lease.validRecord(held.record,unit));assert.equal(held.record.generation,generation);}
  if(phase!=='absent'){
    assert(observed);assert.equal(observed.binding.kind,'unit-execution');
    assert.equal(observed.binding.coordination,'native-host-profile-v1');
    assert.equal(observed.binding.dispatch_id,dispatchId);assert.equal(observed.binding.unit_key,unit);
    assert.equal(observed.binding.lease_generation,generation);
    if(phase==='held-live-relay')assert.equal(observed.binding.native_host_relay?.profile_id,'claude-agent-files-foreground-v1');
  }else assert.equal(observed,null);
  return Object.freeze({phase,lease_generation:generation,authority:false});
}

// Assertion bodies for the REAL Bridge owner fixture, not a producer or driver.
// The genuine opaque profile and live runtime must already exist in that owner
// process; no JSON object, injected invoke callback or test factory is accepted.
// These interop phases are drafts until exercised by the canonical CLI fixture.
async function assertGenuineNativeActivityPhase(runtime,profileHandle,expected){
  const {phase,request,publicationAttemptWitness,publicationWitness,...fixture}=expected;
  assert(['before-terminal','joined-before-publication','ready-before-or-after','pending-unrelated-drift','published-upgrade','settled','owner-drift','lease-drift','live-relay-bound'].includes(phase));
  assertFixtureNativeCoordination({...fixture,phase:phase==='settled'?'absent':phase==='lease-drift'?'held-with-lease-drift':phase==='live-relay-bound'?'held-live-relay':'held'});
  const profile=require('./forge-native-host-profile');
  if(phase==='pending-unrelated-drift'){
    const refuses=error=>['native-host-publication-owner-changed','execution-protected-metadata'].includes(error.code);
    assert.throws(()=>runtime.assertReplayAdmission(),refuses);await assert.rejects(runtime.reconcile(),refuses);return;
  }
  if(phase==='lease-drift'){
    await assert.rejects(runtime.reconcile(),error=>error.code==='protected-owner-lease-changed');
    // Use a separate real fixture/profile for this destructive negative. The
    // profile's live lease refusal also discriminates a forged profile handle.
    assert.throws(()=>profile.assertJoined(profileHandle),error=>error.code==='native-host-lease-required');
    return;
  }
  const capability=profile.assertCapabilityAdmission(profileHandle); // genuine intent/current sources, not execution/join
  if(capability.profile_id===profile.FIXTURE_PROFILE_ID&&phase!=='settled'){
    const window=require('./forge-owner-transport-window').observed(fixture.owner);
    assert(!Object.hasOwn(window.binding,'native_host_relay'),'fixture binding remains unchanged');
  }
  if(phase==='live-relay-bound'){
    const admission=profile.assertActivityAdmission(profileHandle,request),ref=admission.live_relay_reference;
    assert.equal(admission.profile_id,'claude-agent-files-foreground-v1');assert(ref);
    const observed=require('./forge-owner-transport-window').observed(fixture.owner);
    assert.deepEqual(observed.binding.native_host_relay,ref,'same genuine current profile/request relay is the locator in the actual window');
    assert.equal(ref.request_sha256,roots.digest(request));assert.equal(ref.dispatch_id,fixture.dispatchId);
    assert.equal(ref.host_session_sha256,observed.binding.host_session_sha256);
    assert.deepEqual(Object.keys(ref).sort(),['protocol_version','kind','directory','endpoint','attempt_id','dispatch_id','request_sha256','host_session_sha256','profile_id'].sort());
    assert.throws(()=>runtime.assertSettled(),error=>error.code==='native-owner-activity-not-settled','relay metadata alone never settles the activity');
  }else if(phase==='before-terminal'){
    assert.throws(()=>profile.assertJoined(profileHandle),error=>error.code==='native-host-writer-unproven');
    await assert.rejects(runtime.observeJoined({joined:true}),error=>error.code==='native-owner-profile-foreign');
    assert.throws(()=>runtime.assertReplayAdmission({joined:true}),error=>error.code==='native-owner-replay-arguments');
    await assert.rejects(runtime.reconcile({joined:true}),error=>error.code==='native-owner-reconcile-arguments');
    assert.throws(()=>runtime.assertReplayAdmission(),error=>error.code==='native-host-writer-unproven');
    assert.throws(()=>runtime.assertSettled(),error=>error.code==='native-owner-activity-not-settled');
    assert.throws(()=>runtime.spawn(),error=>error.code==='native-owner-process-spawn-forbidden');
  }else if(phase==='joined-before-publication'){
    assert.equal(profile.assertJoined(profileHandle).joined,true);
    await runtime.observeJoined(profileHandle);
    runtime.assertReplayAdmission();await runtime.reconcile();
    assert.throws(()=>runtime.assertSettled(),error=>error.code==='native-owner-activity-not-settled');
  }else if(phase==='ready-before-or-after'){
    assert.equal(profile.assertJoined(profileHandle).joined,true);
    assert.throws(()=>runtime.observePublicationAttempt({}),error=>error.code==='native-original-publication-attempt-required');
    const pending=runtime.observePublicationAttempt(publicationAttemptWitness);
    assert(!pending?.then,'original ready callback must remain synchronous');assert.equal(pending.pending,true);
    assert.equal(profile.assertPublicationAttemptCurrent(profileHandle,publicationAttemptWitness).joined,true);
    runtime.assertReplayAdmission();await runtime.reconcile();
    await assert.rejects(runtime.retrySettlement(),error=>error.code==='native-owner-publication-pending');
    assert.throws(()=>runtime.assertSettled(),error=>error.code==='native-owner-activity-not-settled');
    assertFixtureNativeCoordination({...fixture,phase:'held'});
  }else if(phase==='published-upgrade'){
    await runtime.observePublication(publicationWitness);await runtime.reconcile();
    assert.equal(profile.assertPublicationCurrent(profileHandle,publicationWitness).joined,true);
    assert.throws(()=>runtime.assertSettled(),error=>error.code==='native-owner-activity-not-settled');
  }else if(phase==='owner-drift'){
    assert.equal(profile.assertJoined(profileHandle).joined,true);
    assert.throws(()=>runtime.assertReplayAdmission(),error=>error.code==='execution-protected-metadata');
    await assert.rejects(runtime.reconcile(),error=>error.code==='execution-protected-metadata');
  }else{
    assert.equal(runtime.assertSettled(),true);
    assert.throws(()=>runtime.assertReplayAdmission(),error=>error.code==='native-owner-replay-window-required');
  }
}


// Issues 501/502: canonical immutable answers and both real hook consumers.
async function approvalLabelCases() {
  const positive=['aprovar','aprovado','sim','autorizar','Autorizar (Recomendado)','Aprovar (Recommended)'];
  for(const answer of positive)await fixture(async x=>{
    x.answer();const pins=[x.answerFile,x.originFile].map(file=>[file,fs.readFileSync(file)]);
    const cap=activity.createOwnerReconciliation(x.options());activity.withOwnerReconciliationRead(cap,x.h.request,()=>{});
    for(const[file,bytes]of pins)assert(fs.readFileSync(file).equals(bytes),'saved answer/origin stays byte-exact');
  },{ownerAnswer:answer,rootAnswer:answer});
  for(const answer of ['nao','Autorizar somente estes arquivos','Autorizar (Recommended) extra','Autorizar (Recomendado) (Recommended)','Autorizar\n(Recomendado)']){
    await fixture(async x=>{x.answer();assert.throws(()=>activity.createOwnerReconciliation(x.options()),/owner-reconciliation-operator-decision-required/);},{ownerAnswer:answer});
    await fixture(async x=>{x.answer();assert.throws(()=>activity.createOwnerReconciliation(x.options()),/root-append-answer-required/);},{rootAnswer:answer});
  }
  console.log('PASS approval labels: exact enum/one PT or EN suffix; negatives and immutable canonical answers');
}
async function hookAppendBudgetCases() {await support.fixture(async f=>{
  const relative='.gsd/forge/evidence-budget.jsonl',file=path.join(f.owner,relative),prefix=Buffer.from('{"retained":true}\n');let calls=0,last;
  const attestAppend=challenge=>{calls++;last=challenge;return{observed:true,reference:'synthetic bounded hook observation'};};
  function proof(suffix,{original=prefix,before=original,bytes=Buffer.concat([before,suffix]),attest=attestAppend}={}){
    put(file,bytes);return activity.hookAppendProof(f.owner,{path:relative,before:sha(original),after:sha(bytes)},
      {originalBytes:{[relative]:original},attestAppend:attest},'execute-task/T01','fixture-dispatch');
  }
  const medium=Buffer.from(Array.from({length:193},(_,i)=>JSON.stringify({i,pad:'x'.repeat(230)})+'\n').join(''));
  proof(medium);assert.equal(last.rows,193);assert.equal(last.appended_sha256,sha(medium));assert(fs.readFileSync(file).subarray(0,prefix.length).equals(prefix));
  proof(Buffer.from('{}\n'.repeat(4096)));assert.equal(last.rows,4096);
  const base=Buffer.from(JSON.stringify({payload:''})+'\n'),max=1024*1024;
  const sized=n=>Buffer.from(JSON.stringify({payload:'x'.repeat(n-base.length)})+'\n');
  const exact=Buffer.from(sized(2048).toString().repeat(512));assert.equal(exact.length,max);proof(exact);assert.equal(last.rows,512);assert.equal(last.appended_sha256,sha(exact));
  const largerPrefix=Buffer.from(sized(2048).toString().repeat(768)),remaining=Buffer.from(sized(2048).toString().repeat(256));
  proof(remaining,{original:largerPrefix});assert.equal(fs.statSync(file).size,2*max);assert.equal(last.original_sha256,sha(largerPrefix));
  assert.throws(()=>proof(Buffer.concat([remaining,Buffer.from('{}\n')]),{original:largerPrefix}),/protected-owner-source-invalid/);
  for(const suffix of [Buffer.from('{}\n'.repeat(4097)),sized(max+1),Buffer.from('{invalid}\n'),Buffer.from('{}')]){
    const priorCalls=calls;assert.throws(()=>proof(suffix),/owner-reconciliation-(?:delta-limit|append-invalid)|protected-owner-source-invalid/);assert.equal(calls,priorCalls,'invalid append never reaches attestation');
  }
  assert.throws(()=>proof(Buffer.from('{}\n'),{before:Buffer.from('wrong-prefix\n')}),/append-invalid/);
  assert.throws(()=>proof(Buffer.from('{}\n'),{attest:()=>({observed:false})}),/hook-proof-required/);
  console.log('PASS hook budget:193/4096 lines, exact1MiB suffix/2MiB total with1.5MiB prefix, over-limit/JSON/LF/prefix/attestation negatives');
});}
async function classifiedHookBudgetCase(){await support.fixture(async f=>{
  const journal='.gsd/forge/evidence-budget.jsonl',file=path.join(f.owner,journal),prefix=Buffer.from('{"retained":true}\n');put(file,prefix);
  const h=support.historical(f),suffix=Buffer.from('{}\n'.repeat(193));fs.appendFileSync(file,suffix);
  const decision=activity.reconciliationDecision(h.request),opened=questions.openQuestions(decision);
  questions.answer({cwd:f.owner,identity:opened.identity_sha256,answers:[{id:'owner-delta-approval',answer:'Autorizar (Recomendado)',source:'tool-answer'}]});
  const answerFile=path.join(f.owner,'.gsd/forge/questions',opened.identity_sha256+'.json'),answerBytes=fs.readFileSync(answerFile);
  const options={request:h.request,hostRuntime:'codex',operatorDecision:opened.identity_sha256,assertAuthority:()=>true,attestStoppedWriter:()=>true,readPendingQuestions:()=>[],originalBytes:h.originalBytes,
    attestChanges:challenge=>({challenge_sha256:roots.digest(challenge),changes:challenge.changes.map(row=>({...row,
      kind:row.path.includes('/questions')?'decision-record':row.path.includes('/runs/')?'canonical-stop':row.path===journal?'hook-append':row.path.includes('/leases/')?'same-unit-lease-clock':row.path==='.gsd/forge/auto-mode.json'?'canonical-stop':'operator-reviewed',reference:'synthetic exact classified hook observation'}))})};
  const cap=activity.createOwnerReconciliation(options);activity.withOwnerReconciliationRead(cap,h.request,()=>{});
  assert(fs.readFileSync(file).equals(Buffer.concat([prefix,suffix])));assert(fs.readFileSync(answerFile).equals(answerBytes));support.unchanged(f,h);
  console.log('PASS classified hook-append consumer admits193 exact retained rows with fresh scoped answer');
});}

async function main(){
  await approvalLabelCases();await hookAppendBudgetCases();await classifiedHookBudgetCase();
  await fixture(async x=>{
    await nativeProfileForgeryNegatives(x);
    assert.throws(()=>activity.createOwnerReconciliation(x.options()),/root-append-answer-required/,'unanswered cannot authorize');
    const pending=fs.readFileSync(x.answerFile);
    questions.answer({cwd:x.f.owner,identity:x.opened.identity_sha256,answers:[{id:'code-root-append-approval',answer:'nao',source:'tool-answer'}]});
    assert.throws(()=>activity.createOwnerReconciliation(x.options()),/root-append-answer-required/,'negative answer');
    fs.writeFileSync(x.answerFile,pending);x.answer();
    const options=x.options();
    for(const attestOperatorAnswer of [undefined,()=>({observed:false}),()=>({observed:true,challenge_sha256:'f'.repeat(64),reference:'wrong'})])
      assert.throws(()=>activity.createOwnerReconciliation({...options,codeRootAppendApproval:{...options.codeRootAppendApproval,attestOperatorAnswer}}),/root-append-live-answer-required/);
    assert.throws(()=>activity.createOwnerReconciliation({...options,codeRootAppendApproval:{...options.codeRootAppendApproval,rootId:'beta'}}),/root-append/);
    assert.throws(()=>activity.createOwnerReconciliation({...options,codeRootAppendApproval:{...options.codeRootAppendApproval,originalBytes:Buffer.from('foreign')}}),/root-append/);
    const events=fs.readFileSync(x.file);
    const invalid=Buffer.from(x.appended);invalid[invalid.indexOf(Buffer.from('platform-unsupported'))]=0x80;
    fs.writeFileSync(x.file,Buffer.concat([x.prefix,invalid]));
    assert.throws(()=>activity.createOwnerReconciliation({...options,codeRootAppendApproval:{...options.codeRootAppendApproval,appendedBytes:invalid}}),/root-append-events-invalid/,'invalid UTF-8 is not silently replaced');fs.writeFileSync(x.file,events);
    fs.appendFileSync(x.file,'{"seventh":true}\n');
    assert.throws(()=>activity.createOwnerReconciliation(options),/root-append-bytes-invalid/);fs.writeFileSync(x.file,events);
    const other=path.join(x.f.a,'.gsd/unapproved.md');put(other,'foreign');
    assert.throws(()=>activity.createOwnerReconciliation(options),/root-append-protected-delta-invalid/);fs.unlinkSync(other);
    assert.throws(()=>activity.createOwnerReconciliation({...options,attestStoppedWriter:()=>false}),/authority-required/);
    const cap=activity.createOwnerReconciliation(options),snapshot=x.h.parent.recovery_baseline.protected_roots.find(row=>row.root_id==='alpha').snapshot;
    activity.withOwnerReconciliationRead(cap,x.h.request,()=>execution.assertProtected(x.f.a,snapshot));
    assert.throws(()=>activity.withOwnerReconciliationRead({},x.h.request,()=>{}),/capability-required/);
    const original=fs.readFileSync(x.originFile);fs.appendFileSync(x.originFile,' ');
    assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),/root-append-answer-changed/);fs.writeFileSync(x.originFile,original);
    fs.appendFileSync(x.file,'{"later":true}\n');
    assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),/root-append-root-changed/);fs.writeFileSync(x.file,events);
    const source=path.join(x.f.a,'same.txt'),sourceBytes=fs.readFileSync(source);fs.appendFileSync(source,'foreign');
    assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),/root-changed/);fs.writeFileSync(source,sourceBytes);
    const held=runs.get(x.f.owner,'M001').write_claim;runs.update(x.f.owner,'M001',{write_claim:{...held,generation:'foreign'}});
    assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),/authority-changed/);runs.update(x.f.owner,'M001',{write_claim:held});
    assert.throws(()=>activity.reconciliationDecision(x.h.request,options.operatorDecision,{validatedRootAppend:{carriers:[{relative:'.gsd/anything'}]}}),/root-append-capability-required/);
    assert(fs.readFileSync(x.file).equals(events));
    console.log('PASS root append: explicit live consent, exact bytes and all retained-root/CAS negatives');
  });
  await fixture(async x=>{
    const history=oldHistory(x),current=freshHistoryApproval(x,history);
    const cap=activity.createOwnerReconciliation(current);
    const repaired=require('./forge-sidecar-verification-repair').create(support.repairOptions(x.h,{ownerReconciliation:cap}));
    const bound=successor.bindOwnerReconciliation(repaired,x.h.request,cap);assert.equal(bound,repaired,'same genuine successor');
    assert.throws(()=>successor.bindOwnerReconciliation(repaired,x.h.request,{}),/reconciliation-mismatch/);
    const view=successor.read(bound,x.h.request);view.check();
    const retained=fs.readFileSync(x.file);fs.appendFileSync(x.file,'{"racing":true}\n');
    assert.throws(()=>view.check(),/root-append-root-changed/);fs.writeFileSync(x.file,retained);
    const xllm=require('./forge-xllm'),original=xllm.runExecute;let calls=0;
    xllm.runExecute=async()=>{calls++;throw Error('unexpected provider');};
    try{
      const result=await require('./forge-unit-sidecar').runUnitSidecar(x.h.request,{verificationSuccessor:bound,ownerReconciliation:cap});
      assert.equal(result.status,'done');assert.equal(calls,0);assert(fs.readFileSync(x.file).equals(retained));
      assert.equal(JSON.parse(fs.readFileSync(view.receiptFile)).verification_successor.provider_called,false);
      for(const[file,bytes]of history.pins)assert(fs.readFileSync(file).equals(bytes),'publication preserves both positive and negative historical answers and origins');
      assert(fs.readFileSync(x.h.parentFile).equals(x.h.parentBytes));assert(fs.readFileSync(x.h.parent.recovery_baseline.state_file).equals(x.h.stateBytes));
      console.log('PASS issue455 fresh current approval publishes retained result with exact historical positive/negative pairs as data, zero providers and original receipt/S0/event bytes');
      assert.throws(()=>view.check(),/capability-required/,'consumed reconciliation cannot be reused');
    }finally{xllm.runExecute=original;}
    console.log('PASS root append: same opaque approval reaches outside-context successor and actual zero-provider publication');
  });
  await historicalCarrierNegatives();
}
module.exports={main,assertFixtureNativeCoordination,assertGenuineNativeActivityPhase};if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
