'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const side=require('./forge-unit-sidecar'),successor=require('./forge-sidecar-verification-successor');
const roots=require('./forge-code-roots'),xllm=require('./forge-xllm');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
  const f=await require('./forge-native-recovery-delivery.test').fixture();
  const original=xllm.runExecute;
  try{
    const r=f.request;fs.unlinkSync(f.receiptFile);
    r.verification.commandTimeoutMs=1000;
    for(const row of f.contract.code_roots)fs.writeFileSync(path.join(row.path,'check.cjs'),
      "setTimeout(()=>{require('assert').equal(require('fs').readFileSync('same.txt','utf8'),'after\\n');console.log('PASS claimed root content')},2000)");
    let calls=0;xllm.runExecute=async()=>{calls++;for(const row of f.contract.code_roots)fs.writeFileSync(path.join(row.path,'same.txt'),'after\n');return f.result();};
    const observations=[];
    await assert.rejects(side.runUnitSidecar(r,{onVerificationCheck:row=>observations.push(row)}),{code:'execution-verification-failed'});
    const parentBytes=fs.readFileSync(f.receiptFile),outputBytes=fs.readFileSync(r.resultFile),parent=JSON.parse(parentBytes);
    assert.equal(calls,1);assert.equal(parent.phase,'executed');assert.equal(parent.result.status,'done');
    assert.equal(parent.delivery_capture.passed,false);
    const check=parent.delivery_capture.gate.roots[0].result.checks[0];
    assert.equal(check.exitCode,124);assert(check.cleanup,'actual process cleanup retained');
    if(process.platform==='win32'){assert.equal(check.cleanup.status,'joined');assert.equal(check.cleanup.active_processes,0);}
    assert(observations.some(row=>row.state==='finished'&&row.exit_code===124&&row.index===1));
    console.log('PASS failed sidecar verification retains actual capture, stdout and process cleanup before publication refusal');
    // Reproduce an owner diagnostic caller that omitted its external sink.
    // Keep its real append; only a closed, live-attested surface may reconcile.
    const eventsFile=path.join(f.owner,'.gsd/forge/events.jsonl'),beforeEvents=fs.readFileSync(eventsFile);
    const diagnostic=require('./forge-verify').runRootVerification(f.contract,{commandsByRoot:r.verification.commandsByRoot,commandTimeoutMs:10000});
    assert.equal(diagnostic.passed,true);
    const appendedEvents=fs.readFileSync(eventsFile).subarray(beforeEvents.length);
    const eventProof={originalBytes:beforeEvents,appendedBytes:appendedEvents,attestAppend:challenge=>{
      assert.equal(challenge.appended_sha256,hash(appendedEvents));assert.equal(challenge.event_count,2);
      return {observed:diagnostic.passed,reference:'fixture:actual-owner-diagnostic'};
    }};
    const create=overrides=>successor.create({request:r,timeoutMs:10000,reference:'conversation:fixture-verification-timeout',
      assertAuthority:f.assertBoundary,assertBoundary:f.assertBoundary,attestStoppedWriter:()=>true,
      ownerVerificationEvents:eventProof,
      attestFailure:challenge=>({observed:true,reason_code:'execution-verification-failed',exit_code:124,timed_out:true,
        reference:'fixture:actual-gate',root_id:'alpha',check_index:0,command_sha256:challenge.roots[0].command_sha256[0]}),...overrides});
    assert.throws(()=>create({assertAuthority:undefined}),/live-authority-required/);
    assert.throws(()=>create({attestStoppedWriter:()=>false}),/writer-not-stopped/);
    assert.throws(()=>create({timeoutMs:1000}),/increase-required/);
    assert.throws(()=>create({attestFailure:()=>({observed:true})}),/observation-required/);
    assert.throws(()=>create({ownerVerificationEvents:undefined}),/events-proof-required/);
    assert.throws(()=>create({ownerVerificationEvents:{...eventProof,attestAppend:()=>({observed:false})}}),/events-attestation-required/);
    assert.throws(()=>create({ownerVerificationEvents:{...eventProof,appendedBytes:Buffer.from('{}\n')}}),/events-proof-required/);
    assert.throws(()=>create({request:{...r,linked_begin_key:'unsupported'}}),/scope-unsupported/);
    await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:{}}),/capability-required/);
    const cap=create(),view=successor.read(cap,r);
    const stateFile=parent.recovery_baseline.state_file,stateBytes=fs.readFileSync(stateFile);
    fs.writeFileSync(stateFile,JSON.stringify({...JSON.parse(stateBytes),attempt:'foreign'}));
    assert.throws(()=>create(),/baseline-binding/);assert.throws(()=>successor.read(cap,r),/source-changed/);
    fs.writeFileSync(stateFile,stateBytes);
    await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:cap,verification:{}}),/policy-mixing/);
    assert.throws(()=>successor.read(cap,{...r,route:{...r.route,effort:'low'}}),/capability-required/);
    const old=fs.readFileSync(path.join(f.a,'same.txt'));fs.appendFileSync(path.join(f.a,'same.txt'),'drift');
    assert.throws(()=>successor.read(cap,r),/source-changed/);fs.writeFileSync(path.join(f.a,'same.txt'),old);
    const claim=require('./forge-runs').get(f.owner,r.runId).write_claim;
    require('./forge-runs').update(f.owner,r.runId,{write_claim:{...claim,generation:'foreign'}});
    assert.throws(()=>successor.read(cap,r),/claim|source-changed/);
    require('./forge-runs').update(f.owner,r.runId,{write_claim:claim});
    for(const [file,bytes] of [[f.receiptFile,parentBytes],[r.resultFile,outputBytes]]){
      fs.writeFileSync(file,JSON.stringify({...JSON.parse(bytes),summary:'tampered'}));
      assert.throws(()=>successor.read(cap,r),/source-changed/);fs.writeFileSync(file,bytes);
    }
    for(const field of ['kind','result','verification_seal','milestone_delivery']){
      assert.throws(()=>view.assertRecord({...parent,verification_successor:view.info,verification_seal:view.seal,[field]:{forged:true}}),/record-changed/);
    }
    const leaseApi=require('./forge-unit-lease'),leaseFile=leaseApi.leaseFile(f.owner,'execute-task/T01');
    const originalLease=fs.readFileSync(leaseFile),savedLease=JSON.parse(originalLease);
    fs.writeFileSync(leaseFile,JSON.stringify({...savedLease,heartbeat_at:Date.now(),expires_at:savedLease.expires_at+60000}));
    assert.throws(()=>successor.read(cap,r),/source-changed/);
    assert.throws(()=>create(),/original-lease-required/);
    assert.throws(()=>create({lease:{originalBytes:originalLease,ownerToken:'foreign',generation:savedLease.generation}}),/lease-binding/);
    const clockCap=create({lease:{originalBytes:originalLease,ownerToken:savedLease.owner_token,generation:savedLease.generation}});
    const clock=successor.read(clockCap,r);
    const clockParent={...parent,verification_successor:clock.info,verification_seal:clock.seal};
    assert.notDeepEqual(clock.expectedOwner(clockParent,parent.milestone_delivery.protected_owner),parent.milestone_delivery.protected_owner);
    fs.writeFileSync(leaseFile,originalLease);
    console.log('PASS successor refuses JSON authority, active writers, unchanged budget, wrong observation, changed request, source and claim');
    // An imported ready record cannot make a successor skip its actual gate.
    const imported=create(),importView=successor.read(imported,r);
    fs.writeFileSync(importView.receiptFile,JSON.stringify({...parent,phase:'ready',kind:'review-fix'}));
    await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:imported}),/already-used/);
    const published=await side.runUnitSidecar(r,{verificationSuccessor:cap});
    assert.equal(published.status,'done');assert.equal(calls,1,'no second provider inference');
    const next=JSON.parse(fs.readFileSync(view.receiptFile));
    await assert.rejects(side.publishReadyRecord(r,next),/capability-required/);
    assert.throws(()=>side.materialize(r,next),/capability-required/);
    await assert.rejects(side.publishReadyRecord(r,next,undefined,undefined,{verificationSuccessor:cap}),/live-ready-required/);
    assert.equal(next.phase,'ready');assert.equal(next.delivery_capture.passed,true);
    assert.equal(next.verification_successor.provider_called,false);
    assert.equal(next.verification_successor.owner_event_reconciliation.event_count,2);
    assert.deepEqual(fs.readFileSync(eventsFile),Buffer.concat([beforeEvents,appendedEvents]));
    assert.equal(next.verification_seal.command_timeout_ms,10000);
    assert.deepEqual(next.verification_seal.roots,parent.verification_seal.roots);
    assert.deepEqual(next.result,parent.result);assert.deepEqual(fs.readFileSync(f.receiptFile),parentBytes);
    assert.deepEqual(fs.readFileSync(r.resultFile),outputBytes);
    assert(fs.readFileSync(path.join(f.owner,'.gsd/milestones/M901/slices/S01/S01-PLAN.md'),'utf8').includes('[x]'));
    await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:cap}),/already-used|protected|source-changed/);
    console.log('PASS actual verification-only successor publishes identical worker result after fresh checks without changing original receipt, result, seal or command order');
    assert.equal(hash(parentBytes),next.verification_successor.parent_receipt_sha256);
    assert.equal(roots.digest(r.verification),roots.digest({commandTimeoutMs:1000,commandsByRoot:{alpha:['node check.cjs'],beta:['node check.cjs']}}));
  }finally{xllm.runExecute=original;f.cleanup();}
}
module.exports={main};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
