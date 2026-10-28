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
    researchFile:path.join(base,'S01-RESEARCH.md'),workflowId:'fixture',dispatchId:options.dispatchId || 'ordinary-execute',
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
  await initialMixedDocumentary();
  await initialMixedDocumentary(true);
  await documentaryContinuation();
  await protectedLeaseRenewal();
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
    const materialize=side.materialize;
    try {
      side.materialize=(request,record)=>{write(path.join(f.owner,record.artifacts[0].path),record.artifacts[0].content);throw new Error('fixture partial publication');};
      assert.throws(()=>restarted.publish(result),/fixture partial publication/);
    }finally{side.materialize=materialize;}
    const published=JSON.parse(fs.readFileSync(receipts.at(-1).file));
    assert.equal(published.result.status,'done');
    const afterReady=reopen();afterReady.replayReady(published);afterReady.replayReady(published);
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
async function durableReplay() {
  for(const stage of ['returned','publication']) {
    const f=await fixture({dispatchId:'r'.repeat(128)});
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
    let nativeEvent, nativeIdentity, subscribed;
    const watching=new Promise(resolve=>{subscribed=resolve;});
    f.runtime.nativeLifecycle={adapter:{capabilities:{result:true},acknowledge:value=>value?.agent_id,
      subscribe(handle,listener,context){assert.equal(handle,'fixture-ack');nativeEvent=listener;
        nativeIdentity=context.identity;subscribed();return()=>{};}}};
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
module.exports={fixture,main,protectedLeaseRenewal,documentaryContinuation,initialMixedDocumentary,guardedHandoff};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
