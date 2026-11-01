'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const native=require('./forge-native-recovery-delivery'),advisory=require('./forge-native-artifact-advisory'),side=require('./forge-unit-sidecar');
const {fixture}=require('./forge-native-recovery-delivery.test'),{capabilities}=require('./forge-recovery-transition.test');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function setup(mode='initializer'){
  const f=await fixture();
  try{
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
    const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,activeCapabilities:capabilities,prompt:'Helper advisory fixture; no provider invocation.',forkTurns:'none',taskName:'advisory',agentType:'forge-executor'});
    const observedLine=mode==='global'?'1..5':'PASS helper observer returns increment';
    for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'check.cjs'),(mode==='no-import'?"require('assert').ok(require('fs').readFileSync('same.txt','utf8').includes('notify'));":"require('assert').equal(require('./same.txt').notify(1),2);")+'console.log('+JSON.stringify(observedLine)+');');
    const pointers=[],options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,persistDeliveryReceipt:p=>pointers.push(p)};
    const first=native.prepare(options);first.start();
    for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),mode==='ordinary-empty'?"function absent() {}\nmodule.exports={notify:value=>value+1};\n":"let notify = () => {};\nnotify = (value) => { return value+1; };\nmodule.exports={notify};\n");
    const result=f.result();for(const item of result.must_haves_status){if(item.kind==='artifact')item.evidence=[{root_id:item.root_id,check:'node check.cjs',stdout_line:observedLine}];else for(const e of item.evidence)e.stdout_line=observedLine;}
    first.returned(result);assert.throws(()=>first.verify(result),/artifact-evidence-not-executed/);
    const captureFile=fs.readdirSync(path.dirname(request.resultFile)).filter(n=>/^forge-verification-[a-f0-9]{64}\.json$/.test(n)).map(n=>path.join(path.dirname(request.resultFile),n)).find(file=>JSON.parse(fs.readFileSync(file)).dispatch_id===request.dispatchId);
    assert(captureFile);const returnedReceiptFile=pointers.at(-1).file,savedManifest=JSON.parse(fs.readFileSync(request.resultFile+'.manifest.json'));
    return {...f,request,result,options,captureFile,returnedReceiptFile,savedManifest};
  }catch(error){f.cleanup();throw error;}
}
const review=dossier=>({reference:'fixture:independent-semantic-review',reviewer:'fixture-reviewer',producer:'fixture-writer',pending_questions:[],...Object.fromEntries(['manifest_sha256','receipt_sha256','result_sha256','capture_sha256'].map(k=>[k,dossier[k]])),criteria:dossier.criteria.map(c=>({criterion_id:c.criterion_id,artifact_sha256:c.artifact_sha256,flags_sha256:c.flags_sha256,classification:'intentional-callback-initializer',rationale:'Read the exact helper and direct-import test: real replacement returns increment; empty initializer is not missing implementation.',checks:c.candidate_checks}))});
async function main(){
  const f=await setup();
  try{
    const args={request:f.request,returnedReceiptFile:f.returnedReceiptFile,captureFile:f.captureFile,assertAuthority:f.assertBoundary,attestStoppedWriter:()=>true,attestCapture:x=>x.sha256===hash(fs.readFileSync(f.captureFile)),attestReview:review};
    const dossier=advisory.inspect(args);assert.equal(dossier.criteria.length,2);assert.throws(()=>advisory.read(dossier),/capability-required/);
    assert.throws(()=>advisory.create({...args,attestStoppedWriter:()=>false}),/writer-not-stopped/);
    assert.throws(()=>advisory.create({...args,attestCapture:()=>false}),/capture-authority-required/);
    assert.throws(()=>advisory.create({...args,assertAuthority:undefined}),/live-authority-required/);
    assert.throws(()=>advisory.create({...args,attestReview:d=>({...review(d),reviewer:'fixture-writer'})}),/independent-review-required/);
    assert.throws(()=>advisory.create({...args,attestReview:d=>{const r=review(d);r.criteria[0].checks[0]={...r.criteria[0].checks[0],stdout_line:'invented'};return r;}}),/review-binding/);
    assert.throws(()=>advisory.create({...args,attestReview:d=>({...review(d),capture_sha256:'0'.repeat(64)})}),/independent-review-required/);
    console.log('PASS helper advisory requires live capture, stopped writer, independent source-bound review and actually observed named checks');
    const capability=advisory.create(args);assert.throws(()=>advisory.read(JSON.parse(JSON.stringify(capability))),/capability-required/);
    const forged=structuredClone(f.savedManifest);forged.prepared.protected_owner={};
    assert.throws(()=>native.prepare({...f.options,savedManifest:forged,artifactAdvisoryReview:capability}),/capability-required/);
    const resumed=native.prepare({...f.options,savedManifest:f.savedManifest,artifactAdvisoryReview:capability});
    assert.throws(()=>resumed.returned(f.result),/replay-only/);
    assert.throws(()=>resumed.verify({...f.result,summary:'changed'}),/result-changed/);
    const testFile=path.join(f.a,'check.cjs'),testBytes=fs.readFileSync(testFile);
    fs.appendFileSync(testFile,'\n// source drift');assert.throws(()=>resumed.verify(f.result),/source-changed/);fs.writeFileSync(testFile,testBytes);
    const bytes=fs.readFileSync(f.request.resultFile+'.manifest.json'),receipt=fs.readFileSync(f.returnedReceiptFile);
    const verified=resumed.verify(f.result),ready=resumed.publish(f.result);
    assert(verified.capture.passed);assert(ready.artifact_advisory_review);assert.deepEqual(ready.result,f.result);
    assert.deepEqual(fs.readFileSync(f.request.resultFile+'.manifest.json'),bytes);assert.deepEqual(fs.readFileSync(f.returnedReceiptFile),receipt);
    const behavioral=verified.bindings.filter(b=>b.advisory_disposition?.scope==='independently-reviewed-helper-api-tests');assert(behavioral.length>=4);
    assert(behavioral.every(b=>b.advisory_disposition.flags.every(flag=>flag.regex_name==='empty_function_body')));
    assert.throws(()=>native.prepare({...f.options,savedManifest:f.savedManifest}).replayReady(ready),/replay-authority-required/);
    const altered=structuredClone(ready);altered.artifacts[0].content+=' ';
    assert.throws(()=>resumed.replayReady(altered),/ready-receipt-required/);
    console.log('PASS intentional helper initializer publishes through real API tests with original flags, source, worker result, manifest and receipt retained');
    console.log('PASS helper advisory rejects serialized capability, baseline replacement, source drift, changed result and tampered or unauthorized replay');
  }finally{f.cleanup();}
  for(const mode of ['ordinary-empty','no-import','global']){
    const f=await setup(mode);
    try{assert.throws(()=>advisory.create({request:f.request,returnedReceiptFile:f.returnedReceiptFile,captureFile:f.captureFile,assertAuthority:f.assertBoundary,attestStoppedWriter:()=>true,attestCapture:()=>true,attestReview:review}),mode==='ordinary-empty'?/initializer-required/:/direct-api-evidence-required/);}finally{f.cleanup();}
  }
  console.log('PASS ordinary empty implementation, unrelated green test and generic TAP summary cannot receive helper initializer disposition');
}
module.exports={main};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
