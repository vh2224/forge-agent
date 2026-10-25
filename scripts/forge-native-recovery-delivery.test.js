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
async function fixture() {
  const f = fixtures.setup();
  const base = path.join(f.owner, '.gsd/milestones/M901/slices/S01');
  const planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
  const command = 'node check.cjs';
  for (const root of f.contract.code_roots) write(path.join(root.path,'check.cjs'),
    "require('assert').equal(require('fs').readFileSync('same.txt','utf8'),'after\\n');console.log('PASS claimed root content');");
  const plan = require('./forge-code-roots.test').plan(f.contract).replace('id: T-roots','id: T01')
    .replace('must_haves:', 'verify:\n  - ' + JSON.stringify(command) + '\nmust_haves:')
    .replace('  key_links: []', "  key_links:\n    - from: 'alpha::same.txt'\n      to: 'beta::same.txt'\n      via: 'Both roots change together.'");
  write(planFile, plan);
  write(path.join(base,'S01-PLAN.md'),'# Slice\n- [ ] **T01** — fixture\n');
  write(f.roadmap,'# Roadmap\n- [ ] **S01: Recovery** `depends:[]`\n');
  const claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: f.contract,
    paths: f.contract.code_roots.map(row => ({root_id:row.id,path:'same.txt'})) };
  require('./forge-runs').add(f.owner,{id:'fixture-run',kind:'milestone',session_id:'fixture',write_claim:claim});
  const r = {unitType:'execute-task',scope:'milestone',phase:'execute',milestoneId:'M901',sliceId:'S01',taskId:'T01',
    cwd:f.a,contextRoot:f.owner,planFile,roadmapFile:f.roadmap,execution_contract:f.contract,claim,runId:'fixture-run',
    gates:{plan:'skipped',planSkipReason:'interactive-off',claim:'proceed',security:'passed'},
    contextFile:path.join(base,'S01-CONTEXT.md'),securityFile:planFile.replace('-PLAN.md','-SECURITY.md'),
    researchFile:path.join(base,'S01-RESEARCH.md'),workflowId:'fixture',dispatchId:'ordinary-execute',
    resultFile:path.join(f.dir,'execute.json'),prompt:'Implement the claimed fixture only.',
    verification:{commandTimeoutMs:300000,commandsByRoot:{alpha:[command],beta:[command]}}};
  write(r.contextFile,'# Context\nChange both roots.');write(r.securityFile,'# Security\nPreserve claims and history.');
  write(r.researchFile,'# Research\nBoth files currently contain before.');
  f.originalOptions={cwd:f.owner,unitType:r.unitType,scope:r.scope,phase:r.phase,hostRuntime:'codex',milestoneId:'M901',unitId:'T01',planPath:planFile,roadmapPath:f.roadmap};
  r.route=require('./forge-dispatch-resolve').resolveDispatch({...f.originalOptions,scope:undefined,phase:undefined});
  f.request=r;f.stateFile=r.resultFile+'.recovery.json';f.receiptFile=r.resultFile+'.receipt.json';
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
  const session=recovery.createRecovery({unit:'execute-task/T01',roots_sha256:roots.digest(f.contract),request:r,clock:()=>10,persist:value=>stateApi.saveRecovery(f.stateFile,value)});
  session.record({...f.initial.attempts[0],route:r.route,caller_request_sha256:recovery.callerRequestHash(r)});
  write(f.receiptFile,JSON.stringify({phase:'failed',dispatch_id:r.dispatchId,fingerprint:side.artifactFingerprint(r),route:r.route,
    recovery_identity_sha256:roots.digest(recovery.requestIdentity(r)),failure:{reason_code:'sidecar-timeout',provider_called:'unknown'}}));
  await recovery.recoverAttempt({request:r,stateFile:f.stateFile,receiptFile:f.receiptFile,executionContract:f.contract,
    clock:()=>f.now,processProbe:()=> 'stopped',recoveryAuthorization:f.binding,resolverOptions:f.originalOptions,
    reconcile:()=>({ok:true,roots:f.contract.code_roots.map(row=>({root_id:row.id,reconciled:true}))}),
    validateInvocation:route=>require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:route,activeCapabilities:capabilities,prompt:'Original lost closure',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'})});
  f.initial=stateApi.loadRecovery(f.stateFile);
  f.history=transitions.observeHistory({request:r,state:f.initial,receiptFile:f.receiptFile,contract:f.contract,claim,resolverOptions:f.originalOptions});
  f.recovery={stateFile:f.stateFile,receiptFile:f.receiptFile,clock:()=>f.now,
    transitions:[{type:'uninvoked-native-reservation',reference:'fixture:retained-census'}],resumeReservation:{sha256:roots.digest(f.initial.reservations.at(-1))}};
  f.runtime={processProbe:()=> 'stopped',recoveryAuthorization:f.binding,activeCapabilities:capabilities,assertBoundary:f.assertBoundary,
    transitionAdapter:fixtures.adapter(f,{attestUninvoked:challenge=>({...challenge,binding_sha256:roots.digest(challenge),status:'uninvoked',native_calls:0,evidence_reference:'fixture:retained-native-census'})})};
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
async function main(){
  await implicitOrdinaryIdentity();
  await durableReplay();
  await guardedHandoff();
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
    const result=await side.recoverUnitSidecar(JSON.parse(JSON.stringify(f.request)),f.recovery,f.runtime);
    assert.equal(calls,1);assert.equal(result.result.published.result.status,'done');
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
      ['foreign item',r=>{r.must_haves_status[0].item='foreign';}],
      ['foreign root',r=>{r.must_haves_status[1].root_id='beta';}],
      ['fabricated assertion',r=>{r.must_haves_status[0].evidence[0].stdout_line='PASS invented';}],
      ['unmet',r=>{r.must_haves_status[0].status='unmet';}],
    ]) {const changed=f.result();change(changed);assert.throws(()=>bind(changed),undefined,name);}
    const extra=f.result();extra.must_haves_status[0].approved=true;
    assert.equal(delivery.resultContract.validate(extra).ok,false);
    console.log('PASS public ordinary restart: exact payload, two claimed roots, one callback, canonical verified publication and immutable history');
    console.log('PASS milestone evidence: missing, duplicate, foreign, wrong-root, fabricated and unmet criteria refuse; standalone schema unchanged');
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
async function durableReplay() {
  for(const stage of ['returned','publication']) {
    const f=await fixture();
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
      const again=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime);
      assert.equal(again.action,'replay');assert.equal(calls,1);
      assert.deepEqual(stateApi.loadRecovery(f.stateFile).reservations,f.initial.reservations);
      console.log('PASS durable milestone replay after '+stage+': fresh live writer census, no second callback, idempotent canonical publication');
    }finally{side.materialize=materialize;f.cleanup();}
  }
}
async function guardedHandoff() {
  const f=await fixture();
  try {
    await assert.rejects(()=>side.recoverUnitSidecar({...f.request,scope:'standalone-task'},f.recovery,f.runtime),
      /ordinary-native-delivery-unsupported/);
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
    const outcome=await live.invoke(async()=>{calls++;return {...f.result(),status:'partial'};});
    assert.equal(outcome.ok,true,JSON.stringify(outcome));assert.equal(calls,1);
    assert.throws(()=>live.delivery.verify(outcome.result),/not-done/);
    assert(!fs.existsSync(path.join(f.owner,side.locations(f.request).required[0])));
    const repeated=await live.invoke(callback);assert.equal(repeated.ok,false);assert.equal(calls,1);
    console.log('PASS retained handoff: final request, research and unclaimed drift refuse before callback; partial and duplicate invocation never publish');
  } finally { f.cleanup(); }
}
module.exports={fixture,main};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
