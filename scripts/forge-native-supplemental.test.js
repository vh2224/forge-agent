'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {fixture}=require('./forge-native-recovery-delivery.test');
const side=require('./forge-unit-sidecar'),delivery=require('./forge-native-recovery-delivery'),roots=require('./forge-code-roots');
const {capabilities}=require('./forge-recovery-transition.test');
async function run(){
 const f=await fixture({standalone:true});
 try{
  const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
  const nativeInvocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,activeCapabilities:capabilities,prompt:'Supplemental fixture',forkTurns:'none',taskName:'fixture',agentType:'forge-executor'});
  const receipts=[],options={request,nativeInvocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,persistDeliveryReceipt:r=>receipts.push(r)};
  const session=delivery.prepare(options);session.start();const manifest=session.manifest(),manifestBytes=fs.readFileSync(request.resultFile+'.manifest.json');
  for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
  const result=f.result();result.status='partial';for(const c of result.must_haves_status)if(c.kind!=='artifact')c.status='unknown';session.returned(result);
  const original=receipts.at(-1).file,originalBytes=fs.readFileSync(original);
  const inventory=require('./forge-delivery').inventoryPlan(fs.readFileSync(request.planFile,'utf8'),request.planFile,side.locations(request).rules[side.locations(request).delivery.input].unit);
  const criteria=inventory.criteria.filter(c=>c.origin!=='artifact');
  const policy={schema_version:1,criteria:criteria.map(c=>({criterion_id:c.id,text:c.text,requirements:f.contract.code_roots.flatMap(root=>['behavioral','documentary'].map(coverage=>({aspect:c.aspects[0],root_id:root.id,coverage}))),sources:f.contract.code_roots.map(root=>({root_id:root.id,path:root.id+'::same.txt'}))}))};
  const eligibility=challenge=>({reference:'review:supplement',reviewer:'independent-reviewer',producer:'worker',...challenge,policy_sha256:roots.digest(challenge.policy),rationale:'Fixture requires independently inspected documentary coverage alongside actual behavior.'});
  const supplementalCoverage={policy,returnedReceiptFile:original,attestEligibility:eligibility,attestStoppedWriter:()=>true};
  const reopen=(extra={})=>delivery.prepare({...options,savedManifest:manifest,supplementalCoverage:{...supplementalCoverage,...extra}});
  assert.throws(()=>reopen({attestEligibility:{}}),/live-authority/);
  assert.throws(()=>reopen({attestStoppedWriter:()=>false}),/writer-not-stopped/);
  assert.throws(()=>reopen({attestEligibility:c=>({...eligibility(c),reviewer:'worker'})}),/independent-eligibility/);
  assert.throws(()=>reopen({attestEligibility:c=>({...eligibility(c),policy_sha256:'wrong'})}),/independent-eligibility/);
  const dropped=structuredClone(policy);dropped.criteria[0].requirements=dropped.criteria[0].requirements.filter(r=>r.coverage!=='behavioral');
  assert.throws(()=>reopen({policy:dropped}),/behavior-required/);
  const resumed=reopen();assert.throws(()=>resumed.returned(result),/replay-only/);
  const reviewOptions={returnedReceiptFile:original,attestStoppedWriter:()=>true,attestReview:({sources})=>({reference:'review:content',reviewer:'independent-reviewer',producer:'worker',criteria:criteria.flatMap(c=>f.contract.code_roots.map(root=>({criterion_id:c.id,text:c.text,root_id:root.id,status:'met',eligibility:'documentary',rationale:'Inspected returned fixture bytes.',evidence:'Both root outputs are after and real commands independently check them.',documents:sources.filter(s=>s.root_id===root.id).map(({path,sha256})=>({path,sha256}))})))})};
  const reviewed=resumed.reviewDocumentary(reviewOptions);assert.equal(reviewed.result.status,'done');
  fs.appendFileSync(request.resultFile+'.manifest.json',' ');
  assert.throws(()=>resumed.verify(reviewed.result),/supplemental-returned-state-changed/);
  fs.writeFileSync(request.resultFile+'.manifest.json',manifestBytes);
  resumed.verify(reviewed.result);const ready=resumed.publish(reviewed.result);
  const restart=reopen();restart.reviewDocumentary(reviewOptions);restart.replayReady(ready);restart.replayReady(ready);
  const ordinary=delivery.prepare({...options,savedManifest:manifest});
  assert.throws(()=>ordinary.replayReady(ready),/supplemental-replay-authority/);
  const stripped=structuredClone(ready);delete stripped.supplemental_coverage;
  assert.throws(()=>ordinary.replayReady(stripped),/supplemental-replay-authority/);
  assert.deepEqual(fs.readFileSync(original),originalBytes);assert.deepEqual(fs.readFileSync(request.resultFile+'.manifest.json'),manifestBytes);
  assert.equal(JSON.parse(fs.readFileSync(reviewed.review_file)).evidence.supplemental_coverage.receipt_sha256,receipts[0].sha256);
  console.log('PASS supplemental coverage: immutable partial/manifest, live independent eligibility, behavioral preservation, strict verification, restart and ready replay');
 }finally{f.cleanup();}
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={run};
