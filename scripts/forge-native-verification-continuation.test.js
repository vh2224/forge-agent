'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const delivery=require('./forge-native-recovery-delivery'),side=require('./forge-unit-sidecar');
const {fixture}=require('./forge-native-recovery-delivery.test');
const {capabilities}=require('./forge-recovery-transition.test');
async function main(){
  const f=await fixture();
  try{
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,
      activeCapabilities:capabilities,prompt:'Verification continuation fixture; no invocation.',forkTurns:'none',taskName:'verification',agentType:'forge-executor'});
    const receipts=[],options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,persistDeliveryReceipt:r=>receipts.push(r)};
    // Extra verifier exists before the execution baseline, so verification never
    // smuggles a source edit into the retained executed attempt.
    for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'extra.cjs'),"console.log('PASS supplemental assertion');");
    const first=delivery.prepare(options);first.start();
    for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
    const result=f.result();
    for(const item of result.must_haves_status)if(item.kind!=='artifact')item.evidence.push({root_id:'alpha',check:'node extra.cjs',stdout_line:'PASS supplemental assertion'});
    first.returned(result);
    assert.throws(()=>first.verify(result),{code:'verification-evidence-request-invalid'});
    const manifestFile=request.resultFile+'.manifest.json',manifestBytes=fs.readFileSync(manifestFile),savedManifest=JSON.parse(manifestBytes);
    const returnedReceiptFile=receipts.at(-1).file,receiptBytes=fs.readFileSync(returnedReceiptFile);
    const verification={commandsByRoot:{alpha:['node check.cjs','node extra.cjs']}};
    const create=overrides=>delivery.createVerificationContinuation({request,returnedReceiptFile,verification,reference:'conversation:fixture',assertAuthority:f.assertBoundary,attestStoppedWriter:()=>true,...overrides});
    assert.throws(()=>create({attestStoppedWriter:()=>false}),/writer-not-stopped/);
    assert.throws(()=>create({assertAuthority:undefined}),/live-authority-required/);
    assert.throws(()=>create({verification:{commandsByRoot:{alpha:['node extra.cjs']}}}),/replacement/);
    assert.throws(()=>create({verification:{commandTimeoutMs:123}}),/timeout-replacement/);
    assert.throws(()=>create({verification:{}}),/append-required/);
    assert.throws(()=>create({returnedReceiptFile:request.resultFile}),/ENOENT|returned-binding/);
    assert.throws(()=>create({request:{...request,linked_begin_key:'foreign'}}),/linked-unsupported/);
    for(const change of [{kind:'native-execute-task'},{recovery_identity_sha256:'0'.repeat(64)}]){
      const invalid=Buffer.from(JSON.stringify({...JSON.parse(receiptBytes),...change}));
      const file=request.resultFile+'.receipt.json.'+require('crypto').createHash('sha256').update(invalid).digest('hex')+'.json';
      fs.writeFileSync(file,invalid);assert.throws(()=>create({returnedReceiptFile:file}),/returned-binding/);
    }
    assert.throws(()=>delivery.prepare({...options,savedManifest,verificationContinuation:{}}),/capability-required/);
    console.log('PASS verification continuation refuses serialized authority, live writers and replacement of commands or timeouts');
    const capability=create();
    const forged=structuredClone(savedManifest);forged.prepared.protected_owner={};
    assert.throws(()=>delivery.prepare({...options,savedManifest:forged,verificationContinuation:capability}),/capability-required/);
    const next=delivery.prepare({...options,savedManifest,verificationContinuation:capability});
    const protectedOwner=savedManifest.prepared.protected_owner;savedManifest.prepared.protected_owner={};
    assert.throws(()=>next.verify(result),/verification-continuation-manifest-changed/);
    savedManifest.prepared.protected_owner=protectedOwner;
    assert.throws(()=>next.returned(result),/replay-only/);
    assert.throws(()=>next.verify({...result,summary:'forged change'}),/result-changed/);
    fs.appendFileSync(path.join(f.a,'same.txt'),'drift');
    assert.throws(()=>next.verify(result),/state-changed/);fs.writeFileSync(path.join(f.a,'same.txt'),'after\n');
    const verified=next.verify(result);assert(verified.capture.passed);
    const ready=next.publish(result);
    assert(ready.verification_continuation);assert.equal(ready.verification_continuation.original_seal_sha256,savedManifest.verification_seal.sha256);
    assert.deepEqual(fs.readFileSync(manifestFile),manifestBytes);assert.deepEqual(fs.readFileSync(returnedReceiptFile),receiptBytes);
    assert.deepEqual(ready.result,result);assert.equal(ready.verification_continuation.result_sha256,require('crypto').createHash('sha256').update(JSON.stringify(result)).digest('hex'));
    const originalReady=structuredClone(ready);
    assert.throws(()=>next.replayReady({...ready,result:{...result,summary:'forged replay'}}),/ready-binding/);
    assert.throws(()=>next.replayReady({...ready,manifest_sha256:'0'.repeat(64)}),/ready-binding/);
    const tampered=structuredClone(ready);tampered.artifacts[0].content+=' ';
    assert.throws(()=>next.replayReady(tampered),/ready-receipt-required/);
    ready.verification_continuation.reference='caller mutation';
    assert.throws(()=>next.replayReady(ready),/replay-authority-required/);
    next.replayReady(originalReady);
    console.log('PASS first executed native result publishes after actual appended checks without changing original manifest, seal, receipt or worker result');
    // Publish changed protected owner metadata, so restore fixture publication
    // bytes only to test that replay never accepts a serialized capability.
    assert.throws(()=>delivery.prepare({...options,savedManifest}).replayReady(originalReady),/protected-metadata|replay-authority/);
    console.log('PASS verification continuation binds current code and exact result and requires fresh authority for replay');
  }finally{f.cleanup();}
  await implicitTimeout();
}
async function implicitTimeout(){
  const f=await fixture();
  try{
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
    delete request.verification.commandTimeoutMs;
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,
      activeCapabilities:capabilities,prompt:'Implicit timeout fixture; no invocation.',forkTurns:'none',taskName:'verification',agentType:'forge-executor'});
    for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'extra.cjs'),"console.log('PASS extra');");
    const receipts=[],options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,persistDeliveryReceipt:r=>receipts.push(r)};
    const session=delivery.prepare(options);session.start();
    for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
    session.returned(f.result());
    const opts={request,returnedReceiptFile:receipts.at(-1).file,reference:'conversation:fixture-implicit-timeout',assertAuthority:f.assertBoundary,attestStoppedWriter:()=>true};
    const verification={commandsByRoot:{alpha:['node check.cjs','node extra.cjs']}};
    assert.throws(()=>delivery.createVerificationContinuation({...opts,verification:{...verification,commandTimeoutMs:123}}),/verification-continuation-timeout-replacement/);
    assert(delivery.createVerificationContinuation({...opts,verification}));
    console.log('PASS verification continuation preserves original implicit default timeout and refuses its replacement');
  }finally{f.cleanup();}
}
module.exports={main};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
