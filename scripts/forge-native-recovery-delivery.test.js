'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fixtures = require('./forge-recovery-transition.test');
const roots = require('./forge-code-roots');
const recovery = require('./forge-attempt-recovery');
const transitions = require('./forge-recovery-transition');
const stateApi = require('./forge-xllm-state');
const side = require('./forge-unit-sidecar');
const delivery = require('./forge-native-recovery-delivery');
const { write, capabilities } = fixtures;
async function fixture(options = {}) {
  const f = fixtures.setup();
  const standalone = options.standalone === true;
  const taskId = standalone ? 'T-20261028000000-reservation' : 'T01';
  const base = path.join(f.owner, standalone ? '.gsd/tasks/' + taskId : '.gsd/milestones/M901/slices/S01');
  const planFile = path.join(base, standalone ? taskId + '-PLAN.md' : 'tasks/T01/T01-PLAN.md');
  const command = 'node check.cjs';
  for (const root of f.contract.code_roots) write(path.join(root.path,'check.cjs'),
    options.existenceOnly ? "require('assert').ok(require('fs').existsSync('same.txt'));console.log('PASS claimed root content');" :
      "require('assert').equal(require('fs').readFileSync('same.txt','utf8'),'after\\n');console.log('PASS claimed root content');");
  const plan = require('./forge-code-roots.test').plan(f.contract).replace('id: T-roots','id: ' + taskId)
    .replace('must_haves:', 'verify:\n  - ' + JSON.stringify(command) + '\nmust_haves:')
    .replace('  key_links: []', "  key_links:\n    - from: 'alpha::same.txt'\n      to: 'beta::same.txt'\n      via: 'Both roots change together.'")
    .replaceAll('min_lines: 1',options.existenceOnly?'min_lines: 10':'min_lines: 1');
  write(planFile, plan);
  if (!standalone) {
    write(path.join(base,'S01-PLAN.md'),'# Slice\n- [ ] **T01** — fixture\n');
    write(f.roadmap,'# Roadmap\n- [ ] **S01: Recovery** `depends:[]`\n');
  }
  const claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: f.contract,
    paths: f.contract.code_roots.map(row => ({root_id:row.id,path:'same.txt'})) };
  require('./forge-runs').add(f.owner,{id:'fixture-run',kind:standalone?'task':'milestone',session_id:'fixture',write_claim:claim});
  let r = {unitType:'execute-task',scope:'milestone',phase:'execute',milestoneId:'M901',sliceId:'S01',taskId:'T01',
    cwd:f.a,contextRoot:f.owner,planFile,roadmapFile:f.roadmap,execution_contract:f.contract,claim,runId:'fixture-run',
    gates:{plan:'skipped',planSkipReason:'interactive-off',claim:'proceed',security:'passed'},
    contextFile:path.join(base,'S01-CONTEXT.md'),securityFile:planFile.replace('-PLAN.md','-SECURITY.md'),
    researchFile:path.join(base,'S01-RESEARCH.md'),workflowId:'fixture',dispatchId:options.dispatchId || 'ordinary-execute',
    resultFile:path.join(f.dir,options.resultBasename || 'execute.json'),prompt:'Implement the claimed fixture only.',
    verification:{commandTimeoutMs:300000,commandsByRoot:{alpha:[command],beta:[command]}}};
  if (standalone) {
    if (options.nativePromptFile) r.nativePromptFile = path.join(f.dir, 'requested-prompt.txt');
    Object.assign(r,{scope:'standalone-task',taskId, constraints:{auto_commit:false,deploy:false},
      gates:{plan:'approved',claim:'proceed',security:'passed'},
      contextFile:path.join(base,taskId+'-CONTEXT.md'),researchFile:path.join(base,taskId+'-RESEARCH.md')});
    delete r.milestoneId; delete r.sliceId; delete r.roadmapFile;
    write(planFile.replace('-PLAN.md','-PLAN-GATE.md'),'---\nstatus: approved\n---\n');
    write(path.join(base,taskId+'-BRAINSTORM.md'),'Standalone alternatives and risks.');
    const prefs=JSON.parse(fs.readFileSync(f.prefsFile));prefs.token_budget={coding_standards:32};
    write(f.prefsFile,JSON.stringify(prefs));
    write(path.join(f.owner,'.gsd/CODING-STANDARDS.md'),'OPTIONAL_STANDARD '.repeat(1000)+'STANDARDS_END');
  }
  // Issue 288 fixtures need the actual gate decision before the recovery state binds the request.
  if (options.gates) r.gates = {...r.gates,...options.gates};
  write(r.contextFile,'# Context\nChange both roots.');write(r.securityFile,'# Security\nPreserve claims and history.');
  write(r.researchFile,'# Research\nBoth files currently contain before.');
  f.originalOptions={cwd:f.owner,unitType:r.unitType,scope:r.scope,phase:r.phase,hostRuntime:'codex',milestoneId:'M901',unitId:'T01',planPath:planFile,roadmapPath:f.roadmap};
  if (standalone) {delete f.originalOptions.milestoneId;delete f.originalOptions.roadmapPath;f.originalOptions.unitId=taskId;}
  r.route=require('./forge-dispatch-resolve').resolveDispatch(standalone?f.originalOptions:{...f.originalOptions,scope:undefined,phase:undefined});
  f.request=r;f.stateFile=r.resultFile+'.recovery.json';f.receiptFile=r.resultFile+'.receipt.json';
  if (standalone) {
    f.assertBoundary=()=>{
      if(f.boundaryRejected)throw new Error('fixture-boundary-lost');
      const held=require('./forge-runs').get(f.owner,'fixture-run');
      assert.equal(held.active,true);assert.equal(roots.digest(held.write_claim),roots.digest(claim));
    };
  } else {
  const controller=require('./forge-unit-controller');
  require('./forge-state').write(f.owner,{milestone:'M901',kind:'milestone',phase:'idle',active_slice:'S01',active_task:'—',auto_mode:'on'});
  const begin=controller.begin(f.owner,{milestone:'M901',unit:{type:'execute-task',id:'T01',key:'execute-task/T01'},slice:'S01',owner_token:'fixture-owner',host_runtime:'codex',idempotency_key:'fixture-begin',ttl_ms:300000});
  const beginRecord=controller.lookupRecord(f.owner,'transaction','fixture-begin');
  f.assertBoundary=()=>{
    if(f.boundaryRejected)throw new Error('fixture-boundary-lost');
    assert.equal(roots.digest(controller.lookupRecord(f.owner,'transaction','fixture-begin')),roots.digest(beginRecord));
    const pending=require('./forge-orchestrate').validatePending({cwd:f.owner,milestone:'M901',host_runtime:'codex',owner_token:'fixture-owner'},
      {unit:beginRecord.unit,details:{transaction:{idempotency_key:'fixture-begin',begin_checksum:require('./forge-orchestrate').checksum(beginRecord)}}});
    assert.equal(pending.ok,true,JSON.stringify(pending));
    const lease=require('./forge-unit-lease').observe(f.owner,'execute-task/T01');
    assert.equal(lease.lease?.generation,begin.generation);assert.equal(lease.reason,'lease-active');
  };
  }
  if(options.linked){
    assert(!standalone,'linked controller fixture has milestone scope');
    const controller=require('./forge-unit-controller'),oldReceipt=path.join(f.dir,'linked-prior.receipt.json');
    write(oldReceipt,JSON.stringify({phase:'failed',recovery_identity_sha256:roots.digest(recovery.requestIdentity(r)),
      failure:{reason_code:'fixture-linked-terminal',provider_called:false}}));
    const physical=[{root_id:'owner',path:f.owner},...f.contract.code_roots.map(root=>({root_id:root.id,path:root.path}))];
    const originalRequest={...r};
    const live={ownerToken:'fixture-owner',prefsReader:()=>({ok:true,prefs:{workflow:{skip_discuss:true,skip_research:true}}}),
      processProbe:()=> 'stopped',inspectAttempt:()=>({receipt_path:oldReceipt,request:originalRequest,roots:physical,pending_questions:[]}),
      reconcileRoots:({root})=>({root_id:root.root_id,process_stopped:true,reconciled:true}),
      captureEntryBaseline:()=>({sha256:'a'.repeat(64),roots:physical}),questionStateAdapter:()=>({answers:[]}),
      entryAuthority:recovery.createAuthority(reference=>({reference,status:'resolved',answer:'authorize',resolved_at:new Date().toISOString()}))};
    const begin=controller.lookupRecord(f.owner,'transaction','fixture-begin');
    const consumed=controller.consumeFailure(f.owner,{milestone:'M901',unit:begin.unit,begin_key:begin.idempotency_key,
      owner_token:'fixture-owner',host_runtime:'codex',slice:'S01'},live);
    const entered=controller.reenter(f.owner,{milestone:'M901',unit:begin.unit,owner_token:'fixture-owner',host_runtime:'codex',
      entry:{entry_id:'linked-repackage-fixture',failure_key:consumed.failure_key,failure_checksum:consumed.failure_checksum,
        authorization_ref:'conversation:linked-repackage'}},live);
    r.linked_begin_key=entered.transaction.idempotency_key;r=recovery.bindLinkedRequest(r,live);f.request=r;
    f.linkedEntryOptions=live;
    f.assertBoundary=()=>controller.validateLinkedEntry(f.owner,r.linked_begin_key,live);
  }
  const session=recovery.createRecovery({unit:'execute-task/'+taskId,roots_sha256:roots.digest(f.contract),request:r,clock:()=>10,persist:value=>stateApi.saveRecovery(f.stateFile,value)});
  session.record({...f.initial.attempts[0],route:r.route,caller_request_sha256:recovery.callerRequestHash(r)});
  write(f.receiptFile,JSON.stringify({phase:'failed',dispatch_id:r.dispatchId,fingerprint:side.artifactFingerprint(r),route:r.route,
    recovery_identity_sha256:roots.digest(recovery.requestIdentity(r)),failure:{reason_code:'sidecar-timeout',provider_called:'unknown'}}));
  const reserved=await recovery.recoverAttempt({request:r,stateFile:f.stateFile,receiptFile:f.receiptFile,executionContract:f.contract,
    clock:()=>f.now,processProbe:()=> 'stopped',recoveryAuthorization:f.binding,resolverOptions:f.originalOptions,
    reconcile:()=>({ok:true,roots:f.contract.code_roots.map(row=>({root_id:row.id,reconciled:true}))}),
    validateInvocation:route=>require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:route,activeCapabilities:capabilities,prompt:'Original lost closure',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'})});
  if(options.corrected){
    const caller=recovery.createRecovery({unit:'execute-task/'+taskId,roots_sha256:roots.digest(f.contract),request:r,
      state:stateApi.loadRecovery(f.stateFile),clock:()=>f.now,
      persist:value=>stateApi.saveRecovery(f.stateFile,value)});
    r.route=reserved.route;
    caller.record({...f.initial.attempts[0],route:r.route,failure_class:'caller',provider_called:false,
      reason_code:'native-prompt-file-target',layer:'caller',caller_request_sha256:recovery.callerRequestHash(r)});
    const correction={offline_validated:true,evidence_reference:'fixture:validated-packaging',
      request_sha256:crypto.createHash('sha256').update('corrected final native arguments').digest('hex')};
    const decision=await caller.next({inspection:{process_stopped:true,receipt_checked:true,writer_possible:false},correction,
      validateInvocation:route=>require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:route,
        activeCapabilities:capabilities,prompt:'Corrected packaging',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'})});
    caller.reserve(decision,correction.request_sha256);
    write(f.receiptFile,JSON.stringify({phase:'failed',dispatch_id:r.dispatchId,fingerprint:side.artifactFingerprint(r),route:r.route,
      recovery_identity_sha256:roots.digest(recovery.requestIdentity(r)),failure:{reason_code:'native-prompt-file-target',provider_called:false}}));
    assert.equal(stateApi.loadRecovery(f.stateFile).reservations.at(-1).provenance,null);
  }
  f.initial=stateApi.loadRecovery(f.stateFile);
  f.history=transitions.observeHistory({request:r,state:f.initial,receiptFile:f.receiptFile,contract:f.contract,claim,resolverOptions:f.originalOptions});
  f.recovery={stateFile:f.stateFile,receiptFile:f.receiptFile,clock:()=>f.now,
    transitions:[{type:'uninvoked-native-reservation',reference:'fixture:retained-census'}],resumeReservation:{sha256:roots.digest(f.initial.reservations.at(-1))}};
  f.runtime={processProbe:()=> 'stopped',recoveryAuthorization:f.binding,activeCapabilities:capabilities,assertBoundary:f.assertBoundary,
    transitionAdapter:fixtures.adapter(f,{attestUninvoked:challenge=>({...challenge,binding_sha256:roots.digest(challenge),status:'uninvoked',native_calls:0,evidence_reference:'fixture:retained-native-census'})})};
  if(f.linkedEntryOptions)f.runtime.linkedEntryOptions=f.linkedEntryOptions;
  f.result=()=>{
    const unit=side.locations(r).rules[side.locations(r).delivery.input].unit;
    const inventory=require('./forge-delivery').inventoryPlan(plan,planFile,unit);
    return {status:'done',summary:'Both fixture files updated.',files_changed:['alpha::same.txt','beta::same.txt'],
      must_haves_status:inventory.criteria.map(c=>({kind:c.origin,index:c.index,item:c.text,note:'Observed locally.',status:'met',
        root_id:c.origin==='artifact'?roots.resolvePath(f.contract,c.artifact_path).root_id:'',
        evidence:c.origin==='artifact'?[]:f.contract.code_roots.map(row=>({root_id:row.id,check:command,stdout_line:'PASS claimed root content'}))}))};
  };
  return f;
}
async function standaloneReservation(options={}){
  const f=await fixture({standalone:true,dispatchId:'s'.repeat(128),...options});
  try {
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime);
    const live=handoff.result;let calls=0;
    assert.equal(live.request.scope,'standalone-task');
    assert.equal(live.request.milestoneId,undefined);assert.equal(live.request.sliceId,undefined);
    const callback=async(next,binding)=>{
      calls++;
      const prompt=binding.args.message||binding.args.prompt;
      for(const text of ['Standalone alternatives and risks.','Both files currently contain before.',
        'Preserve claims and history.','forge-procedure:','Full coding standards:',f.request.taskId])assert(prompt.includes(text),text);
      assert(!prompt.includes('STANDARDS_END'),'optional standards must be budgeted');
      assert(next.dispatchId.length<=128);
      for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
      return f.result();
    };
    const research=fs.readFileSync(f.request.researchFile);
    fs.appendFileSync(f.request.researchFile,' altered');
    assert.equal((await live.invoke(callback)).ok,false);assert.equal(calls,0);
    fs.writeFileSync(f.request.researchFile,research);
    const gateFile=f.request.planFile.replace('-PLAN.md','-PLAN-GATE.md'),gate=fs.readFileSync(gateFile);
    write(gateFile,'---\nstatus: rejected\n---\n');
    await assert.rejects(()=>live.invoke(callback),/execution-plan-gate-required/);assert.equal(calls,0);
    fs.writeFileSync(gateFile,gate);
    f.boundaryRejected=true;
    assert.equal((await live.invoke(callback)).ok,false);assert.equal(calls,0);
    f.boundaryRejected=false;
    const outcome=await live.invoke(callback);
    assert.equal(outcome.ok,true,JSON.stringify(outcome));assert.equal(calls,1);
    live.delivery.verify(outcome.result);
    const published=live.delivery.publish(outcome.result);
    assert.equal(published.result.status,'done');
    assert(!published.artifacts.some(a=>a.path.endsWith('-PLAN.md')),'standalone publish never creates a slice marker');
    assert(fs.existsSync(path.join(f.owner,side.locations(f.request).required[0])));
    assert.equal((await live.invoke(callback)).ok,false);assert.equal(calls,1);
    assert.deepEqual(stateApi.loadRecovery(f.stateFile).reservations,f.initial.reservations);
    assert.deepEqual(stateApi.loadRecovery(f.stateFile).attempts,f.initial.attempts);
    console.log('PASS standalone unused reservation: canonical inputs, budget, live boundary, exact identity, one callback and publication');
  }finally{f.cleanup();}
}
// One scenario inventory serves the public serial main and every isolated cohort.
// Each fixture owns its roots/profile. Separate processes keep temporary env,
// module state, mock callbacks and publication fault injection independent.
function scenarios(){return [
  ()=>standaloneReservation(),
  ()=>standaloneReservation({corrected:true}),
  ()=>standaloneNegativeEvidence(),
  ()=>initialMixedDocumentary(),
  ()=>initialMixedDocumentary(true),
  ()=>documentaryContinuation(),
  ()=>protectedLeaseRenewal(),
  ()=>implicitOrdinaryIdentity(),
  ()=>durableReplay(),
  ()=>durableReplay(true),
  ()=>durableReplay(true,true),
  ()=>guardedHandoff(),
  ()=>ordinaryPublication(),
  ()=>nativeTaskMarker(),
  ()=>observedPhases(),
];}
async function main(){for(const scenario of scenarios())await scenario();}
const COHORTS=3;
async function runCohort(index){
  assert(Number.isInteger(index)&&index>=0&&index<COHORTS,'invalid recovery test cohort');
  const selected=scenarios().filter((_,i)=>i%COHORTS===index);
  assert(selected.length,'empty recovery test cohort');
  for(const scenario of selected)await scenario();
}
async function isolatedMain(){
  const {spawn}=require('child_process');
  const outcomes=await Promise.allSettled(Array.from({length:COHORTS},(_,index)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[__filename,'--cohort',String(index)],{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',overflow=false;
    const collect=(which,text)=>{if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+Buffer.byteLength(text)>4*1024*1024){overflow=true;return;}if(which==='stdout')stdout+=text;else stderr+=text;};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',text=>collect('stdout',text));child.stderr.on('data',text=>collect('stderr',text));
    child.once('error',reject);child.once('close',(code,signal)=>resolve({index,code,signal,stdout,stderr,overflow}));
  })));
  // Join every child even if one fails. Emit complete streams after joining so
  // named assertion lines from different children cannot interleave mid-line.
  for(const outcome of outcomes){if(outcome.status==='fulfilled'){process.stdout.write(outcome.value.stdout);process.stderr.write(outcome.value.stderr);}}
  for(const outcome of outcomes){
    if(outcome.status==='rejected')throw outcome.reason;
    assert(!outcome.value.overflow,'recovery test cohort output exceeded bound');
    assert.equal(outcome.value.signal,null,'recovery test cohort ended by signal');
    assert.equal(outcome.value.code,0,'recovery test cohort '+outcome.value.index+' failed');
  }
}
async function ordinaryPublication(){
  const f=await fixture();
  try{
    let calls=0;
    f.runtime.invokeNative=async(next,binding,session)=>{
      calls++;
      const prompt=binding.args.message||binding.args.prompt;
      for(const text of [next.cwd,next.resultFile,'## Security','## Research','300000','kind','forge-procedure:'])assert(prompt.includes(text),text);
      assert.equal(session.manifest().verification_seal.command_timeout_ms,300000);
      const publish=session.publish;
      session.publish=result=>{
        assert.throws(()=>publish({...result,summary:'changed after verification'}),/verified-result-required/);
        write(path.join(f.a,'same.txt'),'post-verification drift\n');
        assert.throws(()=>publish(result),/verified-code-changed/);
        write(path.join(f.a,'same.txt'),'after\n');
        return publish(result);
      };
      for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
      return f.result();
    };
    const taskPlan=fs.readFileSync(f.request.planFile);
    assert.equal(nextUnit(f.owner),'execute-task/T01');
    const result=await side.recoverUnitSidecar(JSON.parse(JSON.stringify(f.request)),f.recovery,f.runtime);
    assert.equal(calls,1);assert.equal(result.result.published.result.status,'done');
    assert.equal(result.result.published.artifacts.at(-1).path,SLICE_PLAN);
    assert.equal(fs.readFileSync(path.join(f.owner,SLICE_PLAN),'utf8'),'# Slice\n- [x] **T01** — fixture\n');
    assert.equal(sha256(fs.readFileSync(f.request.planFile)),sha256(taskPlan));
    assert.notEqual(nextUnit(f.owner),'execute-task/T01');
    console.log('PASS ordinary native marker: verify and publish mark T01 in S01-PLAN, keep the T01-PLAN sha256 and the controller no longer selects T01');
    const state=stateApi.loadRecovery(f.stateFile);
    assert.deepEqual(state.reservations,f.initial.reservations);assert.deepEqual(state.attempts,f.initial.attempts);
    assert.equal(state.deadline_at,f.initial.deadline_at);assert.equal(state.continuation.status,'returned');
    assert(!require('./forge-worker-result-contract').contract().validate(f.result()).ok);
    assert(fs.existsSync(path.join(f.owner,side.locations(f.request).required[0])));
    const unit=side.locations(f.request).rules[side.locations(f.request).delivery.input].unit;
    const inventory=require('./forge-delivery').inventoryPlan(fs.readFileSync(f.request.planFile,'utf8'),f.request.planFile,unit);
    const bind=value=>delivery.criterionBindings(value,result.result.verified.capture,require('./forge-delivery').unitKey(unit),{inventory,contract:f.contract});
    for(const [name,change] of [
      ['missing',r=>r.must_haves_status.pop()],['duplicate',r=>r.must_haves_status.push(r.must_haves_status[0])],
      ['foreign index',r=>{r.must_haves_status[0].index=999;}],
      ['foreign root',r=>{r.must_haves_status[1].root_id='beta';}],
      ['fabricated assertion',r=>{r.must_haves_status[0].evidence[0].stdout_line='PASS invented';}],
      ['unmet',r=>{r.must_haves_status[0].status='unmet';}],
    ]) {const changed=f.result();change(changed);assert.throws(()=>bind(changed),undefined,name);}
    const paraphrased=f.result();paraphrased.must_haves_status[0].item='Observed behavior in my own words';
    assert.deepEqual(bind(paraphrased),bind(f.result()),'stable kind/index bind the same canonical criterion');
    const extra=f.result();extra.must_haves_status[0].approved=true;
    assert.equal(delivery.resultContract.validate(extra).ok,false);
    console.log('PASS public ordinary restart: exact payload, two claimed roots, one callback, canonical verified publication and immutable history');
    console.log('PASS milestone evidence: missing, duplicate, foreign, wrong-root, fabricated and unmet criteria refuse; standalone schema unchanged');
  }finally{f.cleanup();}
}
async function standaloneNegativeEvidence(){
  for(const existenceOnly of [true,false]){
    const f=await fixture({standalone:true,existenceOnly});
    try{
      const adapter=f.runtime.transitionAdapter;
      f.runtime.transitionAdapter=transitions.createTransitionAdapter({
        attestHistory:()=>{throw Error('must refuse missing native census first');},attestRoot:()=>({})});
      await assert.rejects(()=>side.recoverUnitSidecar(f.request,f.recovery,f.runtime),/transition-uninvoked-adapter-required/);
      f.runtime.transitionAdapter=adapter;
      let calls=0;
      f.runtime.invokeNative=async()=>{
        calls++;
        for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),existenceOnly?'after\n':'wrong content\n');
        return f.result();
      };
      await assert.rejects(()=>side.recoverUnitSidecar(f.request,f.recovery,f.runtime),
        existenceOnly?/canonical-delivery-not-fully-verified/:/verification/);
      assert.equal(calls,1);
      assert(!fs.existsSync(path.join(f.owner,side.locations(f.request).required[0])));
      assert.deepEqual(stateApi.loadRecovery(f.stateFile).reservations,f.initial.reservations);
      console.log('PASS standalone refuses '+(existenceOnly?'non-substantive artifact despite passing command':'failed actual command')+' without publication');
    }finally{f.cleanup();}
  }
}
async function documentaryContinuation(){
  const f=await fixture();
  try {
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime), live=handoff.result;
    const partial=f.result();partial.status='partial';
    for(const row of partial.must_haves_status)if(row.kind!=='artifact'){row.status='unknown';row.evidence=[];}
    const outcome=await live.invoke(async()=>{
      for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
      return partial;
    });
    assert.equal(outcome.ok,true);
    const originalManifestFile=live.request.resultFile+'.manifest.json';
    const manifestBytes=fs.readFileSync(originalManifestFile);
    const manifest=JSON.parse(manifestBytes);
    const originalResultFile=path.join(f.dir,'preserved-partial.json');write(originalResultFile,JSON.stringify(partial));
    const originalReceiptFile=fs.readdirSync(f.dir).map(name=>path.join(f.dir,name)).find(file=>{
      if(!file.includes('.receipt.json.')||!file.endsWith('.json'))return false;
      const row=JSON.parse(fs.readFileSync(file));return row.phase==='executed'&&row.dispatch_id===live.request.dispatchId;
    });
    assert(originalReceiptFile,'executed immutable receipt');
    const documents=f.contract.code_roots.map(root=>{
      const file=path.join(f.dir,'preserved-'+root.id);write(file,'after\n');
      return {path:root.id+'::same.txt',file,sha256:crypto.createHash('sha256').update('after\n').digest('hex')};
    });
    // Real reset before a new claim. The old protected registry snapshot is
    // intentionally stale after the maintenance/reacquisition boundary.
    for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'before\n');
    const oldClaim=structuredClone(live.request.claim);
    require('./forge-runs').update(f.owner,'fixture-run',{write_claim:null});
    write(path.join(f.owner,'.gsd/maintenance-documentary-proof.md'),'Reviewed isolated runtime maintenance.');
    const claim={...oldClaim,generation:crypto.randomUUID()};
    require('./forge-runs').update(f.owner,'fixture-run',{write_claim:claim});
    const request={...live.request,claim,dispatchId:'documentary-continuation',resultFile:path.join(f.dir,'documentary.json')};
    const unit=side.locations(request).rules[side.locations(request).delivery.input].unit;
    const inventory=require('./forge-delivery').inventoryPlan(fs.readFileSync(request.planFile,'utf8'),request.planFile,unit);
    const review={reviewer:'independent-fixture-reviewer',producer:'original-fixture-worker',reference:'fixture:document-review',
      criteria:inventory.criteria.filter(c=>c.origin!=='artifact').flatMap(c=>f.contract.code_roots.map(root=>({
        criterion_id:c.id,text:c.text,root_id:root.id,eligibility:'documentary',status:'met',
        rationale:'Fixture explicitly delegates normative content review.',evidence:'Reviewer read the exact preserved fixture bytes.',
        documents:documents.filter(doc=>doc.path.startsWith(root.id+'::')).map(({path,sha256})=>({path,sha256}))}))) };
    const options={originalManifestFile,originalResultFile,originalReceiptFile,request,documents,
      attestReview:()=>review,attestStoppedWriter:()=>true,assertAuthority:f.assertBoundary};
    const create=changes=>delivery.createDocumentaryContinuation({...options,...changes});
    const originalFiles=[originalManifestFile,originalResultFile,originalReceiptFile];
    const originalBytes=originalFiles.map(file=>fs.readFileSync(file));
    const beforeShapeChecks=fs.readdirSync(f.dir).sort();
    for(const field of ['rationale','evidence'])for(const value of [[],['text'],{},1,true,'',' \t\r\n',null,undefined]){
      const malformed=structuredClone(review);malformed.criteria[0][field]=value;
      assert.throws(()=>create({attestReview:()=>malformed}),{code:'documentary-review-criterion'},field+':'+JSON.stringify(value));
      assert.deepEqual(fs.readdirSync(f.dir).sort(),beforeShapeChecks,'invalid review creates no capture');
      originalFiles.forEach((file,index)=>assert.deepEqual(fs.readFileSync(file),originalBytes[index]));
    }
    assert.throws(()=>create({attestReview:null}),/live-authority/);
    assert.throws(()=>create({attestStoppedWriter:()=>false}),/writer-not-stopped/);
    assert.throws(()=>create({attestReview:()=>({...review,reviewer:review.producer})}),/independent-review/);
    assert.throws(()=>create({attestReview:()=>({...review,criteria:review.criteria.filter(row=>row.criterion_id!==review.criteria[0].criterion_id)})}),/review-coverage|review-criterion/);
    const cap=create();
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,
      activeCapabilities:capabilities,prompt:'Documentary continuation only; no provider call.',forkTurns:'none',taskName:'documentary',agentType:'forge-executor'});
    const receipts=[];
    const prep={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,
      persistDeliveryReceipt:reference=>receipts.push(reference),documentaryContinuation:cap};
    assert.throws(()=>delivery.prepare({...prep,documentaryContinuation:{}}),/capability-required/);
    write(path.join(f.a,'unclaimed.txt'),'drift');
    assert.throws(()=>delivery.prepare(prep),/not-reconciled/);fs.unlinkSync(path.join(f.a,'unclaimed.txt'));
    const continuation=delivery.prepare(prep);continuation.start();
    assert.notDeepEqual(continuation.manifest().prepared.protected_owner,manifest.prepared.protected_owner);
    write(path.join(f.a,'unclaimed.txt'),'drift');
    assert.throws(()=>continuation.restoreDocumentary(),/not-reconciled/);fs.unlinkSync(path.join(f.a,'unclaimed.txt'));
    const git=(...args)=>require('child_process').execFileSync('git',args,{cwd:f.a,stdio:'pipe'});
    const head=git('rev-parse','HEAD').toString().trim();git('commit','--allow-empty','-m','fixture head drift');
    assert.throws(()=>continuation.restoreDocumentary(),/not-reconciled/);git('reset','--soft',head);
    const result=continuation.restoreDocumentary();assert.equal(result.status,'done');
    assert.equal(JSON.parse(fs.readFileSync(originalResultFile)).status,'partial');
    continuation.returned(result);
    const savedManifest=JSON.parse(fs.readFileSync(request.resultFile+'.manifest.json'));
    const reopen=()=>delivery.prepare({...prep,savedManifest,documentaryContinuation:create({continuationManifestFile:request.resultFile+'.manifest.json'})});
    assert.throws(()=>delivery.prepare({...prep,savedManifest,documentaryContinuation:undefined}),/manifest-changed/);
    const restarted=reopen();restarted.start();
    const beforeRestore=fs.statSync(path.join(f.a,'same.txt')).mtimeMs;
    assert.deepEqual(restarted.restoreDocumentary(),result);
    assert.equal(fs.statSync(path.join(f.a,'same.txt')).mtimeMs,beforeRestore,'restart never rewrites restored output');
    const checked=restarted.verify(result);
    assert(checked.bindings.some(row=>row.coverage==='documentary'));
    assert(!checked.bindings.some(row=>row.coverage==='behavioral'));
    const sliceFile=path.join(f.owner,SLICE_PLAN),slicePreimage=fs.readFileSync(sliceFile);
    const materialize=side.materialize;
    try {
      side.materialize=(request,record)=>{write(path.join(f.owner,record.artifacts[0].path),record.artifacts[0].content);throw new Error('fixture partial publication');};
      assert.throws(()=>restarted.publish(result),/fixture partial publication/);
    }finally{side.materialize=materialize;}
    const published=JSON.parse(fs.readFileSync(receipts.at(-1).file));
    assert.equal(published.result.status,'done');
    assert.equal(published.artifacts.at(-1).path,SLICE_PLAN);
    assert.equal(published.artifacts.at(-1).before,sha256(slicePreimage));
    const afterReady=reopen(),legacy=structuredClone(published);legacy.artifacts.pop();
    const verifier=require('./forge-verify'),capture=verifier.captureRootDelivery;
    const originalInvoke=f.runtime.invokeNative;
    let calls=0;
    try {
      verifier.captureRootDelivery=()=>{calls++;throw Error('unexpected replay verification');};
      f.runtime.invokeNative=()=>{calls++;throw Error('unexpected replay native invocation');};
      afterReady.replayReady(legacy);
      assert.deepEqual(fs.readFileSync(sliceFile),slicePreimage,'legacy documentary ready never acquires a marker');
      const files=published.artifacts.map(a=>path.join(f.owner,a.path));
      const stamp=()=>files.map(file=>[fs.readFileSync(file,'utf8'),fs.statSync(file).mtimeMs]);
      const legacyStamp=stamp();afterReady.replayReady(legacy);assert.deepEqual(stamp(),legacyStamp);
      const foreign=structuredClone(published);foreign.artifacts.at(-1).path=SLICE_PLAN.replaceAll('S01','S02');
      assert.throws(()=>afterReady.replayReady(foreign),{code:'milestone-ready-receipt-invalid'});
      const forgedMarker=structuredClone(published);forgedMarker.artifacts.at(-1).content+='forged\n';
      assert.throws(()=>afterReady.replayReady(forgedMarker),{code:'task-marker-invalid'});
      assert.deepEqual(stamp(),legacyStamp,'invalid documentary markers are refused before writes');
      afterReady.replayReady(published);
      assert.equal(fs.readFileSync(sliceFile,'utf8'),published.artifacts.at(-1).content);
      const settled=stamp();afterReady.replayReady(published);assert.deepEqual(stamp(),settled);
      assert.equal(calls,0,'documentary replay does not call native transport or verification');
    } finally {verifier.captureRootDelivery=capture;f.runtime.invokeNative=originalInvoke;}
    console.log('PASS documentary marker replay: marker separated before recomposition and validation, legacy stays unmarked, repeated bytes and mtimes unchanged, no native callback or checks');
    const changed=structuredClone(published);changed.result.summary='forged';
    assert.throws(()=>afterReady.replayReady(changed),/ready-binding/);
    assert.deepEqual(fs.readFileSync(originalManifestFile),manifestBytes);
    console.log('PASS documentary continuation: preserved partial, actual reset, released/reacquired claim and maintenance metadata, fresh manifest, live review, restore, canonical verification/publication and replay without provider');
  } finally {f.cleanup();}
}
async function initialMixedDocumentary(documentaryOnly=false){
  const f=await fixture();
  try{
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,
      activeCapabilities:capabilities,prompt:'Initial mixed evidence fixture',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'});
    const inventory=require('./forge-delivery').inventoryPlan(fs.readFileSync(request.planFile,'utf8'),request.planFile,side.locations(request).rules[side.locations(request).delivery.input].unit);
    const criteria=inventory.criteria.filter(c=>c.origin!=='artifact');
    const policy={schema_version:1,criteria:criteria.map(c=>({criterion_id:c.id,text:c.text,
      requirements:f.contract.code_roots.flatMap(root=>(documentaryOnly?['documentary']:['behavioral','documentary']).map(coverage=>({aspect:c.aspects[0],root_id:root.id,coverage}))),
      sources:f.contract.code_roots.map(root=>({root_id:root.id,path:root.id+'::same.txt'}))}))};
    const external=path.join(f.dir,'review-source.md');write(external,'Pinned historical evidence, read-only.\n');
    policy.criteria[0].sources.push({root_id:'alpha',path:external,external:true,sha256:crypto.createHash('sha256').update(fs.readFileSync(external)).digest('hex')});
    const receipts=[],options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,
      coveragePolicy:policy,persistDeliveryReceipt:reference=>receipts.push(reference)};
    const invalidAspect=structuredClone(policy);invalidAspect.criteria[0].requirements[0].aspect='unsupported';
    assert.throws(()=>delivery.prepare({...options,coveragePolicy:invalidAspect}),/policy-invalid/);
    const missingPin=structuredClone(policy);delete missingPin.criteria[0].sources.at(-1).sha256;
    assert.throws(()=>delivery.prepare({...options,coveragePolicy:missingPin}),/policy-source-invalid/);
    write(external,Buffer.alloc(1048577));assert.throws(()=>delivery.prepare(options),/source.*large|source.*limit|source.*size/);write(external,'Pinned historical evidence, read-only.\n');
    const linked=path.join(f.dir,'linked-source.md');
    try{fs.symlinkSync(external,linked);const linkPolicy=structuredClone(policy);linkPolicy.criteria[0].sources.at(-1).path=linked;
      assert.throws(()=>delivery.prepare({...options,coveragePolicy:linkPolicy}),/link|identity/);fs.unlinkSync(linked);
    }catch(error){if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;console.log('SKIP documentary source symlink fixture: '+error.code);}
    const session=delivery.prepare(options);session.start();const manifest=session.manifest(),manifestBytes=fs.readFileSync(request.resultFile+'.manifest.json');
    for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
    const result=f.result();if(documentaryOnly)for(const c of result.must_haves_status)if(c.kind!=='artifact')c.evidence=[];
    session.returned(result);
    const originalFile=receipts.at(-1).file,originalBytes=fs.readFileSync(originalFile);
    assert.throws(()=>session.verify(result),/documentary-review-required/);
    const attest=({sources})=>({reference:'review:initial-mixed',reviewer:'independent-reviewer',producer:'fixture-worker',criteria:criteria.flatMap(c=>f.contract.code_roots.map(root=>({
      criterion_id:c.id,text:c.text,root_id:root.id,eligibility:'documentary',status:'met',rationale:'Manual review is required by this fixture policy.',
      evidence:'Reviewed exact returned bytes alongside actual structural or behavioral checks.',documents:sources.filter(s=>s.root_id===root.id&&policy.criteria.find(p=>p.criterion_id===c.id).sources.some(p=>p.path===s.path)).map(({path,sha256})=>({path,sha256}))})))});
    const reviewOptions={returnedReceiptFile:originalFile,attestReview:attest,attestStoppedWriter:()=>true};
    const beforeShapeChecks=fs.readdirSync(f.dir).sort();
    for(const field of ['rationale','evidence'])for(const value of [[],['text'],{},1,true,'',' \t\r\n',null,undefined]){
      const malformed=challenge=>{const review=attest(challenge);review.criteria[0][field]=value;return review;};
      assert.throws(()=>session.reviewDocumentary({...reviewOptions,attestReview:malformed}),{code:'documentary-review-criterion'},field+':'+JSON.stringify(value));
      assert.deepEqual(fs.readdirSync(f.dir).sort(),beforeShapeChecks,'invalid review creates no capture');
      assert.deepEqual(fs.readFileSync(originalFile),originalBytes);
      assert.deepEqual(fs.readFileSync(request.resultFile+'.manifest.json'),manifestBytes);
    }
    assert.throws(()=>session.reviewDocumentary({...reviewOptions,attestStoppedWriter:()=>false}),/writer-not-stopped/);
    assert.throws(()=>session.reviewDocumentary({...reviewOptions,attestReview:{}}),/live-authority/);
    assert.throws(()=>session.reviewDocumentary({...reviewOptions,attestReview:challenge=>{const review=attest(challenge);return {...review,reviewer:review.producer};}}),/independent-review-required/);
    const receiptCopy=path.join(f.dir,'imported-receipt.json');fs.writeFileSync(receiptCopy,originalBytes);
    assert.throws(()=>session.reviewDocumentary({...reviewOptions,returnedReceiptFile:receiptCopy}),/returned-binding/);
    write(external,'Changed after prepare.\n');assert.throws(()=>session.reviewDocumentary(reviewOptions),/source-hash-changed/);write(external,'Pinned historical evidence, read-only.\n');
    assert.throws(()=>session.reviewDocumentary({...reviewOptions,attestReview:challenge=>({...attest(challenge),criteria:[]})}),/review-coverage/);
    const open=()=>delivery.prepare({...options,coveragePolicy:undefined,savedManifest:manifest});
    const changedManifest=structuredClone(manifest);changedManifest.coverage_policy.criteria[0].sources.pop();
    const changedSession=delivery.prepare({...options,coveragePolicy:undefined,savedManifest:changedManifest});
    assert.throws(()=>changedSession.reviewDocumentary(reviewOptions),/documentary-manifest-changed/);
    assert.deepEqual(fs.readFileSync(request.resultFile+'.manifest.json'),manifestBytes);
    const resumed=open();const reviewed=resumed.reviewDocumentary(reviewOptions);assert.equal(reviewed.provider_called,false);
    assert.deepEqual(reviewed.result,result,'done initial return does not need artificial partial');
    write(path.join(f.a,'same.txt'),'drift\n');assert.throws(()=>resumed.verify(result),/returned-state-changed/);write(path.join(f.a,'same.txt'),'after\n');
    // Keep the real gate intact, but retain the failing fixture boundary in CI.
    // These roots and commands are synthetic; never dump provider/host payloads.
    const verifier=require('./forge-verify'),captureRootDelivery=verifier.captureRootDelivery;
    let checked;
    // Exercise the actual adapter failure boundary with adversarial capture
    // fields. No command/output/path is permitted in its public diagnostic.
    if(!documentaryOnly){
      const secret='PRIVATE_COMMAND_AND_PATH';
      const cases=[
        {gate:{roots:[{root_id:secret,result:{passed:false,checks:[{command:secret,stdout:secret,stderr:secret,exitCode:127}]}}]},artifacts:[]},
        {gate:{roots:[{root_id:secret,result:{passed:true,skipped:secret,checks:[]}}]},artifacts:[]},
        {gate:{roots:[]},artifacts:[{root_id:secret,result:{passed:false,missing:[{path:secret}]}}]},
        {gate:{roots:[]},artifacts:[{root_id:secret,result:{passed:false,rows:[{path:secret,exists:false}]}}]},
        {gate:{roots:[]},artifacts:[]},
        {gate:{roots:Array.from({length:100},()=>({result:{passed:false,checks:Array.from({length:100},()=>({exitCode:secret}))}}))},artifacts:[]}
      ];
      const expected=['command-failed','root-unverified','expected-output-missing','artifact-failed','capture-failed','command-failed'];
      try{cases.forEach((capture,index)=>{
        verifier.captureRootDelivery=()=>({...capture,passed:false});
        assert.throws(()=>resumed.verify(result),error=>{
          assert.equal(error.code,'verification-failed');
          assert.equal(error.diagnostic.failures[0].category,expected[index]);
          assert(error.diagnostic.failures.length<=32);
          assert(!JSON.stringify(error).includes(secret));
          if(index===0)assert.equal(error.diagnostic.failures[0].exit_code,127);
          if(index===5){assert.equal(error.diagnostic.truncated,true);assert.equal(error.diagnostic.failures[0].exit_code,null);}
          return true;
        });
        assert.deepEqual(fs.readFileSync(originalFile),originalBytes,'failure never publishes success');
      });}finally{verifier.captureRootDelivery=captureRootDelivery;}
    }
    try {
      verifier.captureRootDelivery=(...args)=>{
        const captured=captureRootDelivery(...args);
        if(!captured.passed)console.error('FAIL mixed documentary capture',JSON.stringify({
          roots:captured.gate.roots.map(row=>({root_id:row.root_id,passed:row.result.passed,
            skipped:row.result.skipped,source:row.result.discoverySource,
            checks:row.result.checks.map(check=>({command:check.command,exitCode:check.exitCode,
              stdout:String(check.stdout||'').slice(0,1500),stderr:String(check.stderr||'').slice(0,1500)}))})),
          artifacts:captured.artifacts.map(row=>({root_id:row.root_id,passed:row.result.passed,
            missing:row.result.missing,rows:row.result.rows.map(item=>({path:item.path,exists:item.exists}))}))
        }));
        return captured;
      };
      checked=resumed.verify(result);
    } finally { verifier.captureRootDelivery=captureRootDelivery; }
    for(const p of policy.criteria){const rows=checked.bindings.filter(b=>b.criterion_id===p.criterion_id);assert.equal(rows.some(b=>b.coverage==='behavioral'),!documentaryOnly);assert(rows.some(b=>b.coverage==='documentary'));assert(rows.every(b=>roots.digest(b.required_coverages)===roots.digest(p.requirements)));}
    const withoutBehavior=structuredClone(result);for(const c of withoutBehavior.must_haves_status)if(c.kind!=='artifact')c.evidence=[];
    const bindOptions={inventory,contract:f.contract,documentary:JSON.parse(fs.readFileSync(reviewed.review_file)).evidence,coveragePolicy:policy};
    if(!documentaryOnly)assert.throws(()=>delivery.criterionBindings(withoutBehavior,checked.capture,require('./forge-delivery').unitKey(inventory.criteria[0].unit),bindOptions),/observed-evidence-required/);
    assert.throws(()=>delivery.criterionBindings(result,checked.capture,require('./forge-delivery').unitKey(inventory.criteria[0].unit),{...bindOptions,documentary:undefined}),/required-coverage-missing|observed-evidence-required/);
    const materialize=side.materialize;
    try{side.materialize=(r,record)=>{write(path.join(f.owner,record.artifacts[0].path),record.artifacts[0].content);throw Error('fixture partial publication');};assert.throws(()=>resumed.publish(result),/fixture partial publication/);}finally{side.materialize=materialize;}
    const ready=JSON.parse(fs.readFileSync(receipts.at(-1).file));
    const restart=open();assert.throws(()=>restart.replayReady(ready),/documentary-review-required/);
    restart.reviewDocumentary(reviewOptions);restart.replayReady(ready);restart.replayReady(ready);
    assert.deepEqual(fs.readFileSync(originalFile),originalBytes);assert.deepEqual(fs.readFileSync(request.resultFile+'.manifest.json'),manifestBytes);
    console.log('PASS initial '+(documentaryOnly?'documentary-only':'mixed')+': real done return, sealed policy, pinned external sources, live independent review, required bindings, drift rejection, restarted review and idempotent partial-publication replay without provider');
  }finally{f.cleanup();}
}
async function protectedLeaseRenewal() {
  const f=await fixture(),lease=require('./forge-unit-lease');
  try {
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,
      activeCapabilities:capabilities,prompt:'Lease renewal fixture',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'});
    const options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,persistDeliveryReceipt:()=>{}};
    const originalSession=delivery.prepare(options);originalSession.start();
    const savedManifest=originalSession.manifest(),savedManifestFile=request.resultFile+'.manifest.json',manifestBytes=fs.readFileSync(savedManifestFile);
    const leaseFile=lease.leaseFile(f.owner,'execute-task/T01'),originalLeaseBytes=fs.readFileSync(leaseFile),record=JSON.parse(originalLeaseBytes);
    for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
    assert(lease.heartbeat(f.owner,record.unit,record.owner_token,record.generation,{ttlMs:600000}).ok);
    const renewed=fs.readFileSync(leaseFile);
    assert.throws(()=>delivery.prepare({...options,savedManifest}).start(),/execution-protected-metadata/);
    const capOptions={savedManifestFile,originalLeaseBytes,ownerToken:record.owner_token,generation:record.generation,
      attestStoppedWriter:()=>true,assertAuthority:f.assertBoundary};
    const create=changes=>delivery.createLeaseRenewalReconciliation({...capOptions,...changes});
    assert.throws(()=>create({originalLeaseBytes:Buffer.from('{}')}),/original-hash/);
    assert.throws(()=>create({ownerToken:'foreign'}),/owner-mismatch/);
    assert.throws(()=>create({generation:'foreign'}),/owner-mismatch/);
    assert.throws(()=>create({attestStoppedWriter:()=>false}),/writer-not-stopped/);
    assert.throws(()=>create({assertAuthority:null}),/live-authority/);
    const bad={...JSON.parse(renewed),session:'foreign'};write(leaseFile,JSON.stringify(bad));
    assert.throws(()=>create({assertAuthority:()=>{}}),/fields-invalid/);fs.writeFileSync(leaseFile,renewed);
    const foreign=path.join(f.owner,'.gsd/foreign-proof.txt');write(foreign,'foreign');
    assert.throws(()=>create(),/unproved-metadata/);fs.unlinkSync(foreign);
    const leaseRenewal=create();
    assert.throws(()=>delivery.prepare({...options,savedManifest,leaseRenewal:JSON.parse(JSON.stringify(leaseRenewal))}),/capability-required/);
    const resumed=delivery.prepare({...options,savedManifest,leaseRenewal});resumed.start();
    const changed={...JSON.parse(renewed),expires_at:Date.now()-1};write(leaseFile,JSON.stringify(changed));
    assert.throws(()=>resumed.returned(f.result()));fs.writeFileSync(leaseFile,renewed);
    resumed.returned(f.result());resumed.verify(f.result());const published=resumed.publish(f.result());
    assert.equal(published.lease_reconciliation.original_sha256,crypto.createHash('sha256').update(originalLeaseBytes).digest('hex'));
    assert.deepEqual(fs.readFileSync(savedManifestFile),manifestBytes);assert.deepEqual(fs.readFileSync(leaseFile),renewed);
    assert(!JSON.stringify(published.lease_reconciliation).includes(record.owner_token));
    console.log('PASS trusted lease renewal: exact original preimage, immutable manifest, stopped writer and live authority; foreign fields/metadata/handles and drift refuse');
  }finally{f.cleanup();}
}
async function implicitOrdinaryIdentity() {
  const f=await fixture();
  try {
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime);
    const request={...handoff.result.request};delete request.scope;delete request.phase;
    const original=JSON.stringify(request),receipts=[];
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',
      resolvedDispatch:request.route,activeCapabilities:capabilities,prompt:'Fixture ordinary execution',
      forkTurns:'none',taskName:'fixture',agentType:'forge-executor'});
    const options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,
      persistDeliveryReceipt:receipt=>receipts.push(receipt)};
    const session=delivery.prepare(options);session.start();
    const manifest=session.manifest(),manifestFile=request.resultFile+'.manifest.json',before=fs.readFileSync(manifestFile);
    for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
    const result=f.result();session.returned(result);
    const resumed=delivery.prepare({...options,savedManifest:manifest});resumed.start();
    resumed.verify(result);const published=resumed.publish(result);
    assert.equal(published.phase,'ready');assert.equal(receipts.length,2);
    assert.equal(published.recovery_identity_sha256,roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request))));
    assert.equal(JSON.stringify(request),original);assert.deepEqual(fs.readFileSync(manifestFile),before);
    assert(!Object.hasOwn(manifest.request,'scope'));assert(!Object.hasOwn(manifest.request,'phase'));
    console.log('PASS implicit ordinary identity: returned and saved-manifest publication retain original request bytes');
  } finally { f.cleanup(); }
  const invalid=await fixture();
  try {
    const handoff=await side.recoverUnitSidecar(invalid.request,invalid.recovery,invalid.runtime);
    const request={...handoff.result.request,scope:'invalid-scope'};
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',
      resolvedDispatch:request.route,activeCapabilities:capabilities,prompt:'Invalid identity fixture',
      forkTurns:'none',taskName:'fixture',agentType:'forge-executor'});
    assert.throws(()=>delivery.prepare({request,nativeInvocation,assertBoundary:invalid.assertBoundary,
      assertAuthority:invalid.assertBoundary,persistDeliveryReceipt:()=>{throw Error('unexpected receipt');}}));
    assert(!fs.existsSync(request.resultFile+'.manifest.json'));
    console.log('PASS invalid explicit identity refuses before manifest or receipt');
  } finally { invalid.cleanup(); }
}
const SLICE_PLAN='.gsd/milestones/M901/slices/S01/S01-PLAN.md';
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
function nextUnit(owner){
  const controller=require('./forge-unit-controller'),state={milestone:'M901'};
  const selection=controller.selectNextUnit({state,inventory:controller.discoverInventory(owner,'M901',state),prefs:{skip_discuss:true,skip_research:true}});
  return selection.unit&&selection.unit.type+'/'+selection.unit.id;
}
// Issue 282 on the native path: the owner marker is created from the prepared
// protected preimage, published last with CAS and split before replay checks.
async function nativeTaskMarker() {
  const f=await fixture();
  try {
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
    const slicePlan=path.join(f.owner,SLICE_PLAN);
    write(slicePlan,'# Slice\n- [ ] **T01** — fixture\n- [ ] **T02** — next\n');
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,
      activeCapabilities:capabilities,prompt:'Native marker fixture',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'});
    const receipts=[],options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,
      persistDeliveryReceipt:receipt=>receipts.push(receipt)};
    const session=delivery.prepare(options);session.start();
    const preimage=fs.readFileSync(slicePlan),taskPlan=fs.readFileSync(request.planFile),manifest=session.manifest();
    assert.equal(manifest.prepared.protected_owner[SLICE_PLAN],sha256(preimage));
    assert.equal(nextUnit(f.owner),'execute-task/T01');
    for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
    const result=f.result();session.returned(result);session.verify(result);
    fs.appendFileSync(slicePlan,'operator note\n');
    const edited=fs.readFileSync(slicePlan),persisted=receipts.length;
    // The live owner guard is the first barrier; the marker CAS backs it up.
    assert.throws(()=>session.publish(result),error=>['execution-protected-metadata','task-marker-preimage-changed'].includes(error.code));
    assert.equal(receipts.length,persisted,'no ready receipt before a valid marker');
    assert.deepEqual(fs.readFileSync(slicePlan),edited,'operator bytes kept, no recapture');
    assert(!fs.existsSync(path.join(f.owner,side.locations(request).required[0])));
    fs.writeFileSync(slicePlan,preimage);
    console.log('PASS native marker CAS: a slice plan edited since prepare fails closed before persist, keeping operator bytes without recapture');

    const published=session.publish(result);
    const marker=published.artifacts.at(-1);
    assert.deepEqual(marker,{path:SLICE_PLAN,content:'# Slice\n- [x] **T01** — fixture\n- [ ] **T02** — next\n',before:sha256(preimage)});
    assert.equal(marker.before,published.milestone_delivery.protected_owner[SLICE_PLAN]);
    assert.equal(published.artifacts.filter(a=>a.path===SLICE_PLAN).length,1);
    assert.deepEqual(JSON.parse(fs.readFileSync(receipts.at(-1).file)),published,'durable ready record holds the marker');
    assert.equal(fs.readFileSync(slicePlan,'utf8'),marker.content);
    assert.deepEqual(fs.readFileSync(request.planFile),taskPlan,'executed T01-PLAN keeps its bytes');
    assert.equal(nextUnit(f.owner),'execute-task/T02');
    console.log('PASS native marker publish: ready record carries the marker last with the prepared before, S01-PLAN marks only T01, T01-PLAN unchanged and the controller selects T02');

    const reopen=()=>delivery.prepare({...options,savedManifest:manifest});
    const files=published.artifacts.map(a=>path.join(f.owner,a.path));
    const stamp=()=>files.map(file=>[fs.readFileSync(file,'utf8'),fs.statSync(file).mtimeMs]);
    const settled=stamp();
    reopen().replayReady(published);reopen().replayReady(published);
    assert.deepEqual(stamp(),settled,'repeated replay writes no bytes');
    console.log('PASS native marker replay: repeated replayReady keeps every published byte and mtime');

    // Crash before the marker write: delivery present, checkbox still open.
    fs.writeFileSync(slicePlan,preimage);
    const deliveryFiles=files.filter(file=>!file.endsWith('S01-PLAN.md'));
    const deliveryStamp=()=>deliveryFiles.map(file=>fs.readFileSync(file,'utf8'));
    const delivered=deliveryStamp();
    const legacy=structuredClone(published);legacy.artifacts.pop();
    reopen().replayReady(legacy);
    assert.deepEqual(fs.readFileSync(slicePlan),preimage,'legacy ready never gains a marker');
    console.log('PASS legacy native ready: a record without marker replays idempotently and never marks the slice plan');
    const forged=change=>{const record=structuredClone(published);change(record);return record;};
    for(const [name,record,code] of [
      ['other slice',forged(r=>{r.artifacts.at(-1).path='.gsd/milestones/M901/slices/S02/S02-PLAN.md';}),'milestone-ready-receipt-invalid'],
      ['other taskId',forged(r=>{r.artifacts.at(-1).content='# Slice\n- [ ] **T01** — fixture\n- [x] **T02** — next\n';}),'task-marker-invalid'],
      ['divergent before',forged(r=>{r.artifacts.at(-1).before=sha256('other preimage');}),'task-marker-invalid'],
      ['altered content',forged(r=>{r.artifacts.at(-1).content+='forged\n';}),'task-marker-invalid'],
      ['not last',forged(r=>{r.artifacts.unshift(r.artifacts.pop());}),'milestone-ready-receipt-invalid'],
      ['duplicate',forged(r=>{r.artifacts.push(structuredClone(r.artifacts.at(-1)));}),'milestone-ready-receipt-invalid'],
    ]) {
      assert.throws(()=>reopen().replayReady(record),{code},name);
      assert.deepEqual(fs.readFileSync(slicePlan),preimage,name+': refused before any write');
      assert.deepEqual(deliveryStamp(),delivered,name);
    }
    console.log('PASS native marker refusals: other slice, other taskId, divergent before, altered content, misplaced and duplicate markers refuse before any write');
    reopen().replayReady(published);
    assert.equal(fs.readFileSync(slicePlan,'utf8'),marker.content);
    const recovered=stamp();reopen().replayReady(published);assert.deepEqual(stamp(),recovered);
    console.log('PASS native marker crash recovery: replayReady marks the slice plan once and the next replay writes nothing');
  } finally { f.cleanup(); }
}
async function durableReplay(standalone=false,corrected=false) {
  for(const stage of ['returned','publication']) {
    const f=await fixture({dispatchId:'r'.repeat(128),standalone,corrected});
    const materialize=side.materialize;
    try {
      let calls=0;
      f.runtime.invokeNative=async(next,binding,session)=>{
        calls++;
        for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
        if(stage==='returned')session.verify=()=>{throw new Error('fixture-interruption');};
        return f.result();
      };
      if(stage==='publication')side.materialize=(request,record)=>{
        write(path.join(request.contextRoot,record.artifacts[0].path),record.artifacts[0].content);
        throw new Error('fixture-interruption');
      };
      await assert.rejects(()=>side.recoverUnitSidecar(f.request,f.recovery,f.runtime),/fixture-interruption/);
      side.materialize=materialize;
      assert.equal(calls,1);
      const receiptFile=stateApi.loadRecovery(f.stateFile).continuation.delivery.receipt.file;
      const original=fs.readFileSync(receiptFile);
      const tampered=JSON.parse(original);
      tampered.phase='ready';delete tampered.milestone_delivery;
      tampered.artifacts=[{path:'.gsd/STATE.md',before:null,content:'forged'}];
      write(receiptFile,JSON.stringify(tampered));
      await assert.rejects(()=>side.recoverUnitSidecar(f.request,f.recovery,f.runtime),/receipt-hash/);
      fs.writeFileSync(receiptFile,original);
      f.runtime.writerObservationAdapter=transitions.createWriterObservationAdapter(challenge=>({...challenge,
        binding_sha256:roots.digest(challenge),status:'stopped',writer_identity:'fixture-native',evidence_reference:'fixture:awaited-return'}));
      const resumed=await side.recoverUnitSidecar(JSON.parse(JSON.stringify(f.request)),f.recovery,f.runtime);
      assert.equal(resumed.action,'replay');assert.equal(resumed.provider_called,false);assert.equal(calls,1);
      assert.equal(resumed.result.published.result.status,'done');
      const record=resumed.result.published;
      const files=record.artifacts.map(a=>path.join(f.owner,a.path));
      const stamp=()=>files.map(file=>[fs.readFileSync(file,'utf8'),fs.statSync(file).mtimeMs]);
      const settled=stamp();
      if(standalone)assert(!record.artifacts.some(a=>a.path.endsWith('-PLAN.md')),'standalone publish has no slice marker');
      else {
        assert.equal(record.artifacts.at(-1).path,SLICE_PLAN);
        assert.equal(fs.readFileSync(path.join(f.owner,SLICE_PLAN),'utf8'),'# Slice\n- [x] **T01** — fixture\n');
      }
      const again=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime);
      assert.equal(again.action,'replay');assert.equal(calls,1);
      assert.deepEqual(stamp(),settled,'repeated ready replay writes no bytes');
      assert.deepEqual(stateApi.loadRecovery(f.stateFile).reservations,f.initial.reservations);
      console.log('PASS durable '+(standalone?'standalone':'milestone')+' replay after '+stage+': fresh live writer census, no second callback, idempotent canonical publication');
    }finally{side.materialize=materialize;f.cleanup();}
  }
}
async function guardedHandoff() {
  const f=await fixture();
  try {
    let nativeEvent, nativeIdentity, subscribed;
    const watching=new Promise(resolve=>{subscribed=resolve;});
    f.runtime.nativeLifecycle={adapter:{capabilities:{result:true},acknowledge:value=>value?.agent_id,
      subscribe(handle,listener,context){assert.equal(handle,'fixture-ack');nativeEvent=listener;
        nativeIdentity=context.identity;subscribed();return()=>{};}}};
    await assert.rejects(()=>side.recoverUnitSidecar({...f.request,scope:'standalone-task'},f.recovery,f.runtime),
      /recovery-request-identity-required/);
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime);
    const live=handoff.result;let calls=0;const originalModel=live.request.route.model;
    const callback=async()=>{calls++;return f.result();};
    for(const [name,mutate,restore] of [
      ['final request',()=>{live.request.cwd=f.b;},()=>{live.request.cwd=f.a;}],
      ['research',()=>fs.appendFileSync(f.request.researchFile,'changed'),()=>write(f.request.researchFile,'# Research\nBoth files currently contain before.')],
      ['unclaimed code',()=>write(path.join(f.a,'foreign.txt'),'foreign'),()=>fs.unlinkSync(path.join(f.a,'foreign.txt'))],
      ['lost boundary',()=>{f.boundaryRejected=true;},()=>{f.boundaryRejected=false;}],
      ['model',()=>{live.request.route.model='foreign';},()=>{live.request.route.model=originalModel;}],
      ['scope',()=>{live.request.scope='standalone-task';},()=>{live.request.scope='milestone';}],
      ['result path',()=>{live.request.resultFile+='foreign';},()=>{live.request.resultFile=live.request.resultFile.slice(0,-7);}],
    ]) {
      mutate();const outcome=await live.invoke(callback);restore();
      assert.equal(outcome.ok,false,name);assert.equal(calls,0,name);
      assert.equal(stateApi.loadRecovery(f.stateFile).continuation.status,'prepared');
    }
    // A partial result is retained for the parent, never published as done.
    const pending=live.invoke(async()=>{calls++;return {agent_id:'fixture-ack'};});
    await Promise.race([watching,pending.then(value=>{throw Error('ack returned early: '+JSON.stringify(value));})]);
    let ackStatus,ackReceipt;
    try {
      ackStatus=stateApi.loadRecovery(f.stateFile).continuation.status;
      ackReceipt=fs.existsSync(live.request.resultFile+'.receipt.json');
    } finally {
      nativeEvent({identity:nativeIdentity,sequence:1,kind:'terminal',result:{...f.result(),status:'partial'}});
    }
    const outcome=await pending;
    assert.equal(ackStatus,'dispatch-possible');
    assert.equal(ackReceipt,false,'ack must not create returned receipt');
    assert.equal(outcome.ok,true,JSON.stringify(outcome));assert.equal(calls,1);
    assert.throws(()=>live.delivery.verify(outcome.result),/not-done/);
    assert(!fs.existsSync(path.join(f.owner,side.locations(f.request).required[0])));
    const repeated=await live.invoke(callback);assert.equal(repeated.ok,false);assert.equal(calls,1);
    console.log('PASS retained handoff: final request, research and unclaimed drift refuse before callback; partial and duplicate invocation never publish');
  } finally { f.cleanup(); }
}
// Time is the only legitimate difference between two otherwise identical runs:
// freeze it, so results and bytes are compared without any other normalization.
function freezeTime(at=Date.parse('2026-10-29T12:00:00.000Z')){
  const RealDate=Date;
  class FrozenDate extends RealDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}}
  global.Date=FrozenDate;
  // These parity fixtures compare full serialized receipts including their
  // hashes. Run the real supervisor, but give its fresh identities deterministic
  // test values BEFORE verification hashes are calculated. Production evidence
  // and the real process-ownership suites remain untouched.
  const supervisor=require('./forge-verification-process'),original=supervisor.runWindowsCommand;
  supervisor.runWindowsCommand=(...args)=>{
    const result=original(...args),cleanup=result.cleanup;
    if(cleanup?.platform==='win32'&&cleanup.status==='joined'){
      assert.equal(cleanup.active_processes,0);
      assert(/^Local\\ForgeVerification-[0-9a-f-]+$/.test(cleanup.job_name));
      for(const key of ['supervisor_pid','root_pid'])assert(cleanup[key]===null||Number.isSafeInteger(cleanup[key])&&cleanup[key]>0);
      return {...result,cleanup:{...cleanup,supervisor_pid:cleanup.supervisor_pid===null?null:1,root_pid:cleanup.root_pid===null?null:2,job_name:'Local\\ForgeVerification-parity-fixture'}};
    }
    return result;
  };
  return()=>{global.Date=RealDate;supervisor.runWindowsCommand=original;};
}
function fileMap(dir){
  const out={};
  const visit=(current,rel)=>{for(const name of fs.readdirSync(current).sort()){
    if(name==='.git')continue;
    const file=path.join(current,name),key=rel?rel+'/'+name:name;
    if(fs.lstatSync(file).isDirectory())visit(file,key);else out[key]=sha256(fs.readFileSync(file));
  }};
  visit(dir,'');return out;
}
// Restore contents in place: existing directories keep their physical identity
// (code roots are bound by dev/ino/birthtime); unchanged files are not rewritten.
function restoreDir(dir,backup){
  const wanted=new Set(fs.readdirSync(backup));
  for(const name of fs.readdirSync(dir))if(!wanted.has(name))fs.rmSync(path.join(dir,name),{recursive:true,force:true});
  for(const name of wanted){
    const from=path.join(backup,name),to=path.join(dir,name),directory=fs.lstatSync(from).isDirectory();
    if(fs.existsSync(to)&&fs.lstatSync(to).isDirectory()!==directory)fs.rmSync(to,{recursive:true,force:true});
    if(directory){if(!fs.existsSync(to))fs.mkdirSync(to);restoreDir(to,from);continue;}
    const source=fs.readFileSync(from);
    if(fs.existsSync(to)&&fs.readFileSync(to).equals(source))continue;
    if(fs.existsSync(to))fs.chmodSync(to,0o666);
    fs.writeFileSync(to,source);
  }
}
// S03/T04: phase and per-check observers at start, verify, publish and replayReady;
// with, without and with throwing observers, results and bytes are identical.
async function observedPhases(){
  const f=await fixture();
  const backup=f.dir+'-phase-backup';
  try{
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,
      activeCapabilities:capabilities,prompt:'Observed phases fixture',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'});
    fs.cpSync(f.dir,backup,{recursive:true});
    // One instant for every run, inside the live lease window of this fixture.
    const instant=Date.now();
    const run=observers=>{
      restoreDir(f.dir,backup);
      const thaw=freezeTime(instant);
      try{
        const receipts=[],options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,
          persistDeliveryReceipt:receipt=>receipts.push(receipt),...observers};
        const session=delivery.prepare(options);
        const started=session.start();
        for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
        const result=f.result();session.returned(result);
        const verified=session.verify(result),published=session.publish(result);
        const ready=JSON.parse(fs.readFileSync(receipts.at(-1).file));
        const verifier=require('./forge-verify'),capture=verifier.captureRootDelivery;let checks=0;
        verifier.captureRootDelivery=(...args)=>{checks++;return capture(...args);};
        let replayed;
        try{replayed=delivery.prepare({...options,savedManifest:session.manifest()}).replayReady(ready);}
        finally{verifier.captureRootDelivery=capture;}
        assert.equal(checks,0,'replayReady runs no verification');
        return {values:JSON.stringify({started,verified,published,replayed,receipts}),files:fileMap(f.dir)};
      }finally{thaw();}
    };
    const plain=run({});
    const phases=[],checks=[];
    const observed=run({onPhase:record=>phases.push(record),onCheck:record=>checks.push(record)});
    let thrown=0;
    const throwing=run({onPhase:()=>{thrown++;throw new Error('observer failure');},onCheck:()=>{thrown++;throw new Error('observer failure');}});
    assert.deepEqual(phases.map(row=>row.phase),['executing','verifying','publishing','completed','publishing','completed']);
    for(const row of phases){
      assert(Object.isFrozen(row));
      assert.deepEqual(Object.keys(row),['schema_version','phase','dispatch_id','unit','worker_mode','at']);
      assert.equal(row.schema_version,1);assert.equal(row.dispatch_id,request.dispatchId);
      assert.equal(row.unit,'execute-task/T01');assert.equal(row.worker_mode,'native');
    }
    console.log('PASS native delivery phases: start executing, verify verifying, publish publishing then completed after readback, replayReady publishing and completed');
    assert.deepEqual(checks.map(row=>[row.root_id,row.index,row.total,row.state,row.label]),[
      ['alpha',1,1,'started','node check.cjs'],['alpha',1,1,'finished','node check.cjs'],
      ['beta',1,1,'started','node check.cjs'],['beta',1,1,'finished','node check.cjs']]);
    assert(checks.filter(row=>row.state==='finished').every(row=>row.exit_code===0&&row.timed_out===false));
    console.log('PASS native delivery onCheck: verify forwards per-root progress records with the safe original command label');
    assert(thrown>=phases.length+checks.length,'throwing observers were called');
    assert.equal(observed.values,plain.values);assert.equal(throwing.values,plain.values);
    assert.deepEqual(observed.files,plain.files);assert.deepEqual(throwing.files,plain.files);
    console.log('PASS native delivery observer parity: manifest, receipts, ready record, published bytes and errors identical with, without and throwing observers (frozen time)');
    restoreDir(f.dir,backup);
    const receipts=[],session=delivery.prepare({request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,
      persistDeliveryReceipt:receipt=>receipts.push(receipt),onPhase:()=>{throw new Error('observer failure');}});
    session.start();
    for(const root of f.contract.code_roots)write(path.join(root.path,'same.txt'),'after\n');
    session.returned(f.result());
    fs.appendFileSync(path.join(f.owner,SLICE_PLAN),'operator note\n');
    assert.throws(()=>session.verify(f.result()),{code:'execution-protected-metadata'},'a throwing observer never hides the guard refusal');
    console.log('PASS native delivery observer refusal: guard errors are unchanged with a throwing observer');
  }finally{fs.rmSync(backup,{recursive:true,force:true});f.cleanup();}
}
module.exports={fixture,main,protectedLeaseRenewal,documentaryContinuation,initialMixedDocumentary,guardedHandoff,freezeTime,fileMap,restoreDir};
async function continuations(){await durableReplay(true);await guardedHandoff();await ordinaryPublication();}
async function correctedContinuations(){await standaloneReservation({corrected:true});await durableReplay(true,true);}
if(require.main===module)(process.argv.includes('--cohort')?runCohort(Number(process.argv[process.argv.indexOf('--cohort')+1])):process.argv.includes('--standalone')?standaloneReservation():process.argv.includes('--standalone-negative')?standaloneNegativeEvidence():process.argv.includes('--continuations')?continuations():process.argv.includes('--corrected')?correctedContinuations():process.argv.includes('--observed-phases')?observedPhases():isolatedMain()).catch(error=>{console.error(error);process.exitCode=1;});
