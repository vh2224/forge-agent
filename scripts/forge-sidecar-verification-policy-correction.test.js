'use strict';
// Issue 498: an executed milestone sidecar attempt whose plan `verify:` can never
// pass (caller/plan defect, not worker output) is re-verified against an explicitly
// approved, corrected `verify:` block without a second provider inference.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const side=require('./forge-unit-sidecar'),successor=require('./forge-sidecar-verification-successor');
const xllm=require('./forge-xllm');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
  const f=await require('./forge-native-recovery-delivery.test').fixture();
  const original=xllm.runExecute,previousThread=process.env.CODEX_THREAD_ID;
  try{
    process.env.CODEX_THREAD_ID='fixture-sidecar-policy-correction-owner';
    require('./forge-runs').update(f.owner,f.request.runId,{session_id:process.env.CODEX_THREAD_ID,host_runtime:'codex',owner_session_source:'CODEX_THREAD_ID'});
    const r=f.request;fs.unlinkSync(f.receiptFile);
    // The plan declares the only verify command; the request carries no runtime commands.
    delete r.verification.commandsByRoot;
    const planFile=r.planFile,goodPlan=fs.readFileSync(planFile,'utf8');
    assert.match(goodPlan,/verify:\n  - "node check\.cjs"\n/);
    const badPlan=goodPlan.replace('verify:\n  - "node check.cjs"\n','verify:\n  - "node never-passes.cjs"\n');
    fs.writeFileSync(planFile,badPlan);
    r.route=require('./forge-dispatch-resolve').resolveDispatch({...f.originalOptions,scope:undefined,phase:undefined});
    for(const row of f.contract.code_roots)fs.writeFileSync(path.join(row.path,'never-passes.cjs'),"process.exit(1)");
    let calls=0;xllm.runExecute=async()=>{calls++;for(const row of f.contract.code_roots)fs.writeFileSync(path.join(row.path,'same.txt'),'after\n');return f.result();};
    await assert.rejects(side.runUnitSidecar(r),{code:'execution-verification-failed'});
    const parentBytes=fs.readFileSync(f.receiptFile),outputBytes=fs.readFileSync(r.resultFile),parent=JSON.parse(parentBytes);
    assert.equal(calls,1);assert.equal(parent.phase,'executed');assert.equal(parent.delivery_capture.passed,false);
    const failed=parent.delivery_capture.gate.roots[0].result.checks[0];assert.equal(failed.exitCode,1);
    assert.deepEqual(parent.verification_seal.roots.map(row=>row.commands),f.contract.code_roots.map(()=>['node never-passes.cjs']));
    console.log('PASS impossible plan verify retains the executed worker result with its original seal');
    // Operator corrects only the verify block of the plan.
    fs.writeFileSync(planFile,goodPlan);
    const originalPlanBytes=Buffer.from(badPlan);
    const leaseApi=require('./forge-unit-lease'),leaseFile=leaseApi.leaseFile(f.owner,'execute-task/T01');
    const savedLeaseBytes=fs.readFileSync(leaseFile),savedLease=JSON.parse(savedLeaseBytes);
    const leaseProof=parent.milestone_delivery.protected_owner[path.relative(f.owner,leaseFile).replace(/\\/g,'/')]===hash(savedLeaseBytes)?undefined
      :{originalBytes:savedLeaseBytes,ownerToken:savedLease.owner_token,generation:savedLease.generation};
    let approvals=0;
    const approve=challenge=>{approvals++;
      assert.equal(challenge.original_plan_sha256,hash(originalPlanBytes));assert.equal(challenge.corrected_plan_sha256,hash(goodPlan));
      assert.deepEqual(challenge.corrected_commands.map(row=>row.commands),f.contract.code_roots.map(()=>['node check.cjs']));
      return {approved:true,reference:'conversation:fixture-operator-approved-verify-correction'};};
    const observe=challenge=>({observed:true,reason_code:'execution-verification-failed',exit_code:1,timed_out:false,
      reference:'fixture:actual-gate',root_id:parent.delivery_capture.gate.roots[0].root_id,check_index:0,command_sha256:challenge.roots[0].command_sha256[0]});
    const create=overrides=>successor.create({request:r,reference:'conversation:fixture-verify-correction',
      assertAuthority:f.assertBoundary,assertBoundary:f.assertBoundary,attestStoppedWriter:()=>true,attestFailure:observe,
      ...(leaseProof?{lease:leaseProof}:{}),
      policyCorrection:{originalPlanBytes,approveCorrection:approve},...overrides});
    assert.throws(()=>create({policyCorrection:{originalPlanBytes}}),/correction-proof-required/);
    assert.throws(()=>create({timeoutMs:600000}),/policy-mixing/);
    assert.throws(()=>create({policyCorrection:{originalPlanBytes:Buffer.from(goodPlan),approveCorrection:approve}}),/baseline-binding/);
    assert.throws(()=>create({policyCorrection:{originalPlanBytes,approveCorrection:()=>({approved:false})}}),/approval-required/);
    assert.throws(()=>create({attestFailure:challenge=>({...observe(challenge),exit_code:0})}),/failure-observation-required/);
    assert.throws(()=>create({attestFailure:challenge=>({...observe(challenge),exit_code:2})}),/failure-capture-mismatch/);
    // Any change outside the verify block (here: the body) is refused.
    fs.writeFileSync(planFile,goodPlan+'\nScope creep.\n');
    assert.throws(()=>create(),/correction-scope/);
    // An unchanged policy (verify block identical to the original) is refused.
    fs.writeFileSync(planFile,badPlan);
    assert.throws(()=>create(),/correction-unchanged/);
    fs.writeFileSync(planFile,goodPlan);
    console.log('PASS policy correction refuses missing approval/proof, mixing with timeout, foreign original, wrong observation, scope creep and no-op');
    const before=approvals;const cap=create();assert.equal(approvals,before+1);
    const view=successor.read(cap,r);
    assert.equal(view.info.kind,'verification-policy-correction-successor');
    assert.equal(view.info.policy_correction.reference,'conversation:fixture-operator-approved-verify-correction');
    // The capability is bound to the corrected plan bytes.
    fs.writeFileSync(planFile,goodPlan.replace('node check.cjs','node other.cjs'));
    assert.throws(()=>successor.read(cap,r),/source-changed/);
    fs.writeFileSync(planFile,goodPlan);
    const published=await side.runUnitSidecar(r,{verificationSuccessor:cap});
    assert.equal(published.status,'done');assert.equal(calls,1,'no second provider inference');
    const next=JSON.parse(fs.readFileSync(view.receiptFile));
    assert.equal(next.phase,'ready');assert.equal(next.delivery_capture.passed,true);
    assert.equal(next.verification_successor.provider_called,false);
    assert.equal(next.verification_seal.sha256,view.seal.sha256);
    assert.notEqual(next.verification_seal.sha256,parent.verification_seal.sha256);
    assert.deepEqual(next.result,parent.result);assert.deepEqual(fs.readFileSync(f.receiptFile),parentBytes);
    assert.deepEqual(fs.readFileSync(r.resultFile),outputBytes);
    assert(fs.readFileSync(path.join(f.owner,'.gsd/milestones/M901/slices/S01/S01-PLAN.md'),'utf8').includes('[x]'));
    await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:cap}),/already-used|protected|source-changed/);
    console.log('PASS approved verify-policy correction publishes the retained worker result with a fresh seal and no new inference');
  }finally{if(previousThread===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=previousThread;xllm.runExecute=original;f.cleanup();}
}
// Issue 498 + #455: the operator also edited other owner surfaces after the
// attempt (a note). The owner reconciliation accepts the same corrected plan and
// composes with the correction successor; the plan delta is part of the approval.
async function withOwnerDelta(){
  const f=await require('./forge-native-recovery-delivery.test').fixture();
  const original=xllm.runExecute,previousThread=process.env.CODEX_THREAD_ID;
  const activity=require('./forge-protected-owner-activity'),questions=require('./forge-pending-questions'),roots=require('./forge-code-roots');
  try{
    process.env.CODEX_THREAD_ID='fixture-sidecar-policy-correction-owner-delta';
    require('./forge-runs').update(f.owner,f.request.runId,{session_id:process.env.CODEX_THREAD_ID,host_runtime:'codex',owner_session_source:'CODEX_THREAD_ID',active:true});
    const r=f.request;fs.unlinkSync(f.receiptFile);delete r.verification.commandsByRoot;
    const planFile=r.planFile,goodPlan=fs.readFileSync(planFile,'utf8');
    const badPlan=goodPlan.replace('verify:\n  - "node check.cjs"\n','verify:\n  - "node never-passes.cjs"\n');
    fs.writeFileSync(planFile,badPlan);
    r.route=require('./forge-dispatch-resolve').resolveDispatch({...f.originalOptions,scope:undefined,phase:undefined});
    for(const row of f.contract.code_roots)fs.writeFileSync(path.join(row.path,'never-passes.cjs'),"process.exit(1)");
    let calls=0;xllm.runExecute=async()=>{calls++;for(const row of f.contract.code_roots)fs.writeFileSync(path.join(row.path,'same.txt'),'after\n');return f.result();};
    await assert.rejects(side.runUnitSidecar(r),{code:'execution-verification-failed'});
    const parent=JSON.parse(fs.readFileSync(f.receiptFile));
    fs.writeFileSync(planFile,goodPlan);
    // The operator re-approves the corrected task plan (exact corrected hash).
    fs.writeFileSync(planFile.replace(/-PLAN\.md$/,'-PLAN-GATE.md'),`---\nstatus: approved\nplan_sha256: ${hash(goodPlan)}\n---\nreapproved\n`);
    const note='.gsd/HANDOFF-fixture.md';fs.mkdirSync(path.join(f.owner,'.gsd'),{recursive:true});fs.writeFileSync(path.join(f.owner,note),'operator note after the attempt\n');
    const originalPlanBytes=Buffer.from(badPlan),policyCorrection={originalPlanBytes};
    // Without the correction binding the reconciliation keeps refusing the changed plan.
    assert.throws(()=>activity.reconciliationDecision(r),/baseline-invalid/);
    assert.throws(()=>activity.reconciliationDecision(r,undefined,{policyCorrection:{originalPlanBytes:Buffer.from(goodPlan)}}),/policy-correction-invalid/);
    // The exported reconciliation API itself must reject non-verify changes,
    // before presenting an approval or admitting a broader owner projection.
    fs.writeFileSync(planFile,goodPlan+'\nScope creep.\n');
    assert.throws(()=>activity.reconciliationDecision(r,undefined,{policyCorrection}),{code:'owner-reconciliation-policy-correction-scope'});
    fs.writeFileSync(planFile,goodPlan);
    const description=activity.reconciliationDecision(r,undefined,{policyCorrection});
    assert.match(description.questions[0].question,/correção do bloco verify:/);
    const changedPaths=description.changes.map(row=>row.path);
    assert(changedPaths.includes(note),JSON.stringify(changedPaths));assert(changedPaths.some(p=>p.endsWith('T01-PLAN.md')),JSON.stringify(changedPaths));
    const opened=questions.openQuestions(description);
    questions.answer({cwd:f.owner,identity:opened.identity_sha256,answers:[{id:'owner-delta-approval',answer:'aprovado',source:'user-text'}]});
    const reconciliation=activity.createOwnerReconciliation({request:r,hostRuntime:r.route.host_runtime,assertAuthority:()=>true,
      attestStoppedWriter:()=>true,readPendingQuestions:()=>[],operatorDecision:opened.identity_sha256,policyCorrection,
      attestChanges:challenge=>({challenge_sha256:roots.digest(challenge),changes:challenge.changes.map(row=>({...row,
        kind:row.path.includes('/questions')?'decision-record':/-PLAN(-GATE)?.md$/.test(row.path)?'policy-correction':'operator-reviewed',reference:'fixture explicit bounded decision'}))})});
    const observe=challenge=>({observed:true,reason_code:'execution-verification-failed',exit_code:1,timed_out:false,
      reference:'fixture:actual-gate',root_id:parent.delivery_capture.gate.roots[0].root_id,check_index:0,command_sha256:challenge.roots[0].command_sha256[0]});
    const leaseApi=require('./forge-unit-lease'),leaseFile=leaseApi.leaseFile(f.owner,'execute-task/T01'),savedLeaseBytes=fs.readFileSync(leaseFile),savedLease=JSON.parse(savedLeaseBytes);
    const leaseProof=parent.milestone_delivery.protected_owner[path.relative(f.owner,leaseFile).replace(/\\/g,'/')]===hash(savedLeaseBytes)?undefined
      :{originalBytes:savedLeaseBytes,ownerToken:savedLease.owner_token,generation:savedLease.generation};
    const make=()=>successor.create({request:r,reference:'conversation:fixture-verify-correction',assertAuthority:f.assertBoundary,assertBoundary:f.assertBoundary,
      attestStoppedWriter:()=>true,attestFailure:observe,...(leaseProof?{lease:leaseProof}:{}),
      policyCorrection:{originalPlanBytes,approveCorrection:()=>({approved:true,reference:'conversation:fixture-operator-approved'})}});
    const cap=activity.withOwnerReconciliationRead(reconciliation,r,make);
    successor.bindOwnerReconciliation(cap,r,reconciliation);
    const published=await side.runUnitSidecar(r,{verificationSuccessor:cap});
    assert.equal(published.status,'done');assert.equal(calls,1,'no second provider inference');
    assert.equal(fs.readFileSync(path.join(f.owner,note),'utf8'),'operator note after the attempt\n');
    console.log('PASS owner reconciliation accepts the approved corrected plan and composes with the correction successor');
  }finally{if(previousThread===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=previousThread;xllm.runExecute=original;f.cleanup();}
}
// Issue 510: the worker finished (`done`) but left attempt-attributable scratch
// (its own TEMP caches) inside CODE_DIR, so verifyResult refused the retained
// response with execution-outside-claim. After the owner removes the scratch, an
// approved scratch-reconciliation successor publishes that same response through
// the normal sealed verification and publication, without a second inference.
async function scratchOutsideClaim(){
  const f=await require('./forge-native-recovery-delivery.test').fixture();
  const original=xllm.runExecute,previousThread=process.env.CODEX_THREAD_ID;
  const activity=require('./forge-protected-owner-activity'),questions=require('./forge-pending-questions'),roots=require('./forge-code-roots');
  try{
    process.env.CODEX_THREAD_ID='fixture-sidecar-scratch-outside-claim';
    require('./forge-runs').update(f.owner,f.request.runId,{session_id:process.env.CODEX_THREAD_ID,host_runtime:'codex',owner_session_source:'CODEX_THREAD_ID',active:true});
    const r=f.request;fs.unlinkSync(f.receiptFile);delete r.verification.commandsByRoot;
    const primary=f.contract.code_roots.find(row=>row.id===f.contract.primary_root_id);
    const scratchDir=path.join(primary.path,'.worker-temp'),scratchFiles=['.worker-temp/node-compile-cache/a1','.worker-temp/tsx-user/b2'];
    let calls=0;
    xllm.runExecute=async()=>{calls++;
      for(const row of f.contract.code_roots)fs.writeFileSync(path.join(row.path,'same.txt'),'after\n');
      for(const rel of scratchFiles){fs.mkdirSync(path.dirname(path.join(primary.path,rel)),{recursive:true});fs.writeFileSync(path.join(primary.path,rel),'cache\n');}
      const base=f.result();
      return {...base,files_changed:[...base.files_changed,...scratchFiles.map(rel=>({status:'A',path:rel,root_id:primary.id}))]};};
    await assert.rejects(side.runUnitSidecar(r),{code:'execution-outside-claim'});
    const parentBytes=fs.readFileSync(f.receiptFile),parent=JSON.parse(parentBytes),outputBytes=fs.readFileSync(r.resultFile);
    const returnedFile=r.resultFile+'.returned.json',returnedBytes=fs.readFileSync(returnedFile);
    assert.equal(calls,1);assert.equal(parent.phase,'failed');assert.equal(parent.failure.reason_code,'execution-outside-claim');
    assert.equal(parent.failure.returned_response.sha256,hash(returnedBytes));
    // The failed receipt neither replays nor relaunches the provider.
    await assert.rejects(side.runUnitSidecar(r),{code:'execution-outside-claim'});assert.equal(calls,1);
    console.log('PASS worker scratch outside the claim retains a valid done response behind a failed receipt');
    let approvals=0;const approve=challenge=>{approvals++;
      assert.equal(challenge.scratch_prefix,'.worker-temp/');assert.equal(challenge.removed_entries,scratchFiles.length);
      assert.equal(challenge.returned_response_sha256,hash(returnedBytes));
      assert.deepEqual(challenge.claim_paths,f.contract.code_roots.map(row=>row.id+'::same.txt'));
      return {approved:true,reference:'conversation:fixture-operator-approved-scratch'};};
    const create=overrides=>successor.create({request:r,reference:'conversation:fixture-scratch-reconciliation',
      assertAuthority:f.assertBoundary,assertBoundary:f.assertBoundary,attestStoppedWriter:()=>true,
      scratchReconciliation:{prefix:'.worker-temp/',approveScratch:approve},...overrides});
    // Still present: the owner has not removed the scratch yet.
    assert.throws(()=>create(),/scratch-present/);
    fs.rmSync(scratchDir,{recursive:true,force:true});
    assert.throws(()=>create({scratchReconciliation:{prefix:'.worker-temp/'}}),/scratch-proof-required/);
    assert.throws(()=>create({timeoutMs:600000}),/policy-mixing/);
    assert.throws(()=>create({attestFailure:()=>({observed:true})}),/policy-mixing/);
    assert.throws(()=>create({scratchReconciliation:{prefix:'../outside/',approveScratch:approve}}),/scratch-prefix-invalid/);
    assert.throws(()=>create({scratchReconciliation:{prefix:'.gsd/',approveScratch:approve}}),/scratch-prefix-invalid/);
    assert.throws(()=>create({scratchReconciliation:{prefix:'same.txt/',approveScratch:approve}}),/scratch-prefix-claimed/);
    assert.throws(()=>create({scratchReconciliation:{prefix:'.other-temp/',approveScratch:approve}}),/scratch-unchanged/);
    assert.throws(()=>create({scratchReconciliation:{prefix:'.worker-temp/node-compile-cache/',approveScratch:approve}}),/scratch-outside-prefix/);
    assert.throws(()=>create({scratchReconciliation:{prefix:'.worker-temp/',approveScratch:()=>({approved:false})}}),/scratch-approval-required/);
    // An unrelated new file outside the claim is still caught by the live census.
    fs.writeFileSync(path.join(primary.path,'stray.txt'),'stray\n');
    assert.throws(()=>create(),/execution-outside-claim/);
    fs.unlinkSync(path.join(primary.path,'stray.txt'));
    // A changed retained response is refused.
    fs.writeFileSync(returnedFile,Buffer.concat([returnedBytes,Buffer.from(' ')]));
    assert.throws(()=>create(),/returned-response-changed/);
    fs.writeFileSync(returnedFile,returnedBytes);
    // The approval must bind the exact tree already censused and displayed.
    // A callback cannot promote its own Source writes into a fresh baseline.
    const duringApprovalStray=path.join(primary.path,'stray-during-scratch-approval.txt');
    try{
      assert.throws(()=>create({scratchReconciliation:{prefix:'.worker-temp/',approveScratch:challenge=>{
        const accepted=approve(challenge);
        fs.writeFileSync(duringApprovalStray,'outside claim during approval\n');
        return accepted;
      }}}),{code:'verification-successor-source-changed'});
    }finally{if(fs.existsSync(duringApprovalStray))fs.unlinkSync(duringApprovalStray);}
    const duringApprovalClaimed=path.join(primary.path,'same.txt'),beforeClaimed=fs.readFileSync(duringApprovalClaimed);
    try{
      assert.throws(()=>create({scratchReconciliation:{prefix:'.worker-temp/',approveScratch:challenge=>{
        const accepted=approve(challenge);
        fs.writeFileSync(duringApprovalClaimed,'claimed bytes changed during approval\n');
        return accepted;
      }}}),{code:'verification-successor-source-changed'});
    }finally{fs.writeFileSync(duringApprovalClaimed,beforeClaimed);}
    console.log('PASS scratch reconciliation refuses present/foreign/claimed scratch, mixing, missing approval, stray deltas and a changed response');
    // The host hook kept appending to an evidence journal and the operator wrote a note.
    const note='.gsd/HANDOFF-scratch.md';fs.writeFileSync(path.join(f.owner,note),'scratch removed by the owner\n');
    const scratchOptions={};
    let cap;
    const before=approvals;
    try{cap=create();}catch(error){throw error;}
    assert.equal(approvals,before+1);
    let view;
    try{view=successor.read(cap,r);}catch(error){
      // Owner surfaces changed since the attempt: only a bound owner reconciliation may admit them.
      assert.match(String(error.code),/owner-reconciliation-required/);
      const description=activity.reconciliationDecision(r);
      const opened=questions.openQuestions(description);
      questions.answer({cwd:f.owner,identity:opened.identity_sha256,answers:[{id:'owner-delta-approval',answer:'Autorizar (Recomendado)',source:'tool-answer'}]});
      const reconciliation=activity.createOwnerReconciliation({request:r,hostRuntime:r.route.host_runtime,assertAuthority:()=>true,
        attestStoppedWriter:()=>true,readPendingQuestions:()=>[],operatorDecision:opened.identity_sha256,
        attestChanges:challenge=>({challenge_sha256:roots.digest(challenge),changes:challenge.changes.map(row=>({...row,
          kind:row.path.includes('/questions')?'decision-record':'operator-reviewed',reference:'fixture explicit bounded decision'}))})});
      cap=activity.withOwnerReconciliationRead(reconciliation,r,()=>create());
      successor.bindOwnerReconciliation(cap,r,reconciliation);
      scratchOptions.reconciled=true;
      view=successor.read(cap,r);
    }
    assert.equal(view.info.kind,'scratch-reconciliation-successor');
    assert.equal(view.info.scratch_reconciliation.reference,'conversation:fixture-operator-approved-scratch');
    const published=await side.runUnitSidecar(r,{verificationSuccessor:cap});
    assert.equal(published.status,'done');assert.equal(calls,1,'no second provider inference');
    const next=JSON.parse(fs.readFileSync(view.receiptFile));
    assert.equal(next.phase,'ready');assert.equal(next.delivery_capture.passed,true);
    assert.equal(next.verification_seal.sha256,parent.verification_seal.sha256,'the sealed verification is unchanged');
    assert.deepEqual(next.result.files_changed.map(row=>typeof row==='string'?row:row.root_id+'::'+row.path).sort(),f.contract.code_roots.map(row=>row.id+'::same.txt').sort());
    assert.deepEqual(fs.readFileSync(f.receiptFile),parentBytes);assert.deepEqual(fs.readFileSync(r.resultFile),outputBytes);
    assert.deepEqual(fs.readFileSync(returnedFile),returnedBytes);
    assert(fs.readFileSync(path.join(f.owner,'.gsd/milestones/M901/slices/S01/S01-PLAN.md'),'utf8').includes('[x]'));
    assert.equal(fs.readFileSync(path.join(f.owner,note),'utf8'),'scratch removed by the owner\n');
    await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:cap}),/already-used|protected|source-changed/);
    console.log('PASS approved scratch reconciliation publishes the retained response with its original seal and no new inference'
      +(scratchOptions.reconciled?' (owner delta through a bound reconciliation)':''));
  }finally{if(previousThread===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=previousThread;xllm.runExecute=original;f.cleanup();}
}
async function all(){await main();await withOwnerDelta();await scratchOutsideClaim();}
module.exports={main:all};if(require.main===module)all().catch(e=>{console.error(e);process.exitCode=1;});
