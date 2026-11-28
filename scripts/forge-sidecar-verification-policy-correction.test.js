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
    // Issue 502: one host hook row per tool call; a real recovery spans hundreds.
    const journal='.gsd/forge/evidence~fixture~_no-slice_~adhoc.jsonl',journalFile=path.join(f.owner,journal);
    fs.mkdirSync(path.dirname(journalFile),{recursive:true});
    fs.writeFileSync(journalFile,Array.from({length:300},(_,i)=>JSON.stringify({ts:i,tool:'Bash',cmd:'echo '+i,file:null,ok:true,interrupted:false})+'\n').join(''));
    let hookAttests=0;const hookEvidence={originalBytes:{[journal]:Buffer.alloc(0)},attestAppend:challenge=>{hookAttests++;assert.equal(challenge.rows,300);return{observed:true,reference:'fixture:host-hook-rows'};}};
    // Without the correction binding the reconciliation keeps refusing the changed plan.
    assert.throws(()=>activity.reconciliationDecision(r),/baseline-invalid/);
    assert.throws(()=>activity.reconciliationDecision(r,undefined,{policyCorrection:{originalPlanBytes:Buffer.from(goodPlan)}}),/policy-correction-invalid/);
    // The exported reconciliation API itself must reject non-verify changes,
    // before presenting an approval or admitting a broader owner projection.
    fs.writeFileSync(planFile,goodPlan+'\nScope creep.\n');
    assert.throws(()=>activity.reconciliationDecision(r,undefined,{policyCorrection,hookEvidence}),{code:'owner-reconciliation-policy-correction-scope'});
    fs.writeFileSync(planFile,goodPlan);
    const description=activity.reconciliationDecision(r,undefined,{policyCorrection,hookEvidence});
    assert(!description.changes.some(row=>row.path===journal),'hook journal stays out of the reviewed delta');assert(hookAttests>0);
    // A malformed hook row is still refused at the larger bound.
    const goodJournal=fs.readFileSync(journalFile);fs.appendFileSync(journalFile,'not json\n');
    assert.throws(()=>activity.reconciliationDecision(r,undefined,{policyCorrection,hookEvidence}),{code:'owner-reconciliation-append-invalid'});
    fs.writeFileSync(journalFile,goodJournal);
    assert.match(description.questions[0].question,/correção do bloco verify:/);
    const changedPaths=description.changes.map(row=>row.path);
    assert(changedPaths.includes(note),JSON.stringify(changedPaths));assert(changedPaths.some(p=>p.endsWith('T01-PLAN.md')),JSON.stringify(changedPaths));
    const opened=questions.openQuestions(description);
    questions.answer({cwd:f.owner,identity:opened.identity_sha256,answers:[{id:'owner-delta-approval',answer:'Autorizar (Recomendado)',source:'tool-answer'}]});
    const reconciliation=activity.createOwnerReconciliation({request:r,hostRuntime:r.route.host_runtime,assertAuthority:()=>true,
      attestStoppedWriter:()=>true,readPendingQuestions:()=>[],operatorDecision:opened.identity_sha256,policyCorrection,hookEvidence,
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
async function all(){await main();await withOwnerDelta();}
module.exports={main:all};if(require.main===module)all().catch(e=>{console.error(e);process.exitCode=1;});
