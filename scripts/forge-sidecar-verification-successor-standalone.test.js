'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const side=require('./forge-unit-sidecar'),successor=require('./forge-sidecar-verification-successor');
const roots=require('./forge-code-roots'),xllm=require('./forge-xllm');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function main(){
 const f=await require('./forge-native-recovery-delivery.test').fixture({standalone:true});
 const original=xllm.runExecute;
 try{
  const r=f.request;fs.unlinkSync(f.receiptFile);r.verification.commandTimeoutMs=1000;
  for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'check.cjs'),
   "setTimeout(()=>{require('assert').equal(require('fs').readFileSync('same.txt','utf8'),'after\\n');console.log('PASS claimed root content')},1600)");
  let calls=0;xllm.runExecute=async()=>{calls++;assert.equal(calls,1,'a successor must never infer a second response');for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');return f.result();};
  const observations=[];
  await assert.rejects(side.runUnitSidecar(r,{onVerificationCheck:row=>observations.push(row)}),{code:'execution-verification-failed'});
  const parentBytes=fs.readFileSync(f.receiptFile),outputBytes=fs.readFileSync(r.resultFile),parent=JSON.parse(parentBytes),requestBytes=JSON.stringify(r);
  assert.equal(parent.phase,'executed');assert.equal(parent.result.status,'done');assert(parent.execution);assert(!Object.hasOwn(parent,'milestone_delivery'));
  assert.equal(parent.delivery_capture.passed,false);assert.equal(parent.delivery_capture.gate.roots[0].result.checks[0].exitCode,124);
  assert(observations.some(row=>row.state==='finished'&&row.exit_code===124));
  const retained=parent.delivery_capture.gate.roots[0].result.checks[0];
  if(process.platform==='win32'){assert.equal(retained.cleanup.status,'joined');assert.equal(retained.cleanup.active_processes,0);}
  const leaseDir=path.join(f.owner,'.gsd/forge/leases'),leasesBefore=fs.existsSync(leaseDir)?fs.readdirSync(leaseDir):null;
  const eventsFile=path.join(f.owner,'.gsd/forge/events.jsonl'),beforeEvents=fs.readFileSync(eventsFile);
  const diagnostic=require('./forge-verify').runRootVerification(f.contract,{commandsByRoot:r.verification.commandsByRoot,commandTimeoutMs:5000});
  assert.equal(diagnostic.passed,true);
  const appended=fs.readFileSync(eventsFile).subarray(beforeEvents.length);
  const eventProof={originalBytes:beforeEvents,appendedBytes:appended,attestAppend:challenge=>{
   assert.equal(challenge.appended_sha256,hash(appended));assert.equal(challenge.event_count,2);
   return {observed:true,reference:'fixture:standalone-owned-diagnostic'};
  }};
  const create=overrides=>successor.create({request:r,timeoutMs:5000,reference:'fixture:standalone-verification-only-authorization',
   assertAuthority:f.assertBoundary,assertBoundary:f.assertBoundary,attestStoppedWriter:()=>true,ownerVerificationEvents:eventProof,
   attestFailure:challenge=>({observed:true,reason_code:'execution-verification-failed',exit_code:124,timed_out:true,
    reference:'fixture:actual-standalone-timeout',root_id:'alpha',check_index:0,command_sha256:challenge.roots[0].command_sha256[0]}),...overrides});
  assert.throws(()=>create({assertAuthority:undefined}),/live-authority-required/);
  assert.throws(()=>create({attestStoppedWriter:()=>false}),/writer-not-stopped/);
  assert.throws(()=>create({timeoutMs:1000}),/increase-required/);
  assert.throws(()=>create({attestFailure:()=>({observed:true,exit_code:0,timed_out:false})}),/observation-required/);
  assert.throws(()=>create({ownerVerificationEvents:undefined}),/events-proof-required/);
  assert.throws(()=>create({lease:{originalBytes:Buffer.from('{}')}}),/scope-unsupported/);
  assert.throws(()=>create({request:{...r,linked_begin_key:'not-supported'}}),/scope-unsupported/);
  for(const mutate of [record=>{record.milestone_delivery=record.execution;delete record.execution;},record=>{record.milestone_delivery=null;},
   record=>{record.execution.execution_contract={...record.execution.execution_contract,primary_root_id:'foreign'};}]){
   const changed=JSON.parse(parentBytes);mutate(changed);fs.writeFileSync(f.receiptFile,JSON.stringify(changed));
   try{assert.throws(()=>create(),/parent-binding/);}finally{fs.writeFileSync(f.receiptFile,parentBytes);}
  }
  for(const [mutate,reason] of [[record=>{record.recovery_baseline.protected_roots.pop();},/baseline-binding/],
   [record=>{record.verification_seal.command_timeout_ms=2000;},/original-seal/]]){
   const changed=JSON.parse(parentBytes);mutate(changed);fs.writeFileSync(f.receiptFile,JSON.stringify(changed));
   try{assert.throws(()=>create(),reason);}finally{fs.writeFileSync(f.receiptFile,parentBytes);}
  }
  const cap=create(),view=successor.read(cap,r);
  f.boundaryRejected=true;
  try{assert.throws(()=>successor.read(cap,r),/fixture-boundary-lost/);}finally{f.boundaryRejected=false;}
  assert.throws(()=>successor.read(JSON.parse(JSON.stringify(cap)),r),/capability-required/);
  assert.throws(()=>successor.read(cap,{...r,route:{...r.route,effort:'low'}}),/capability-required/);
  const planGate=path.join(path.dirname(r.planFile),r.taskId+'-PLAN-GATE.md'),gateBytes=fs.readFileSync(planGate);
  fs.appendFileSync(planGate,'\nchanged gate\n');
  try{assert.throws(()=>successor.read(cap,r),/input-changed/);}finally{fs.writeFileSync(planGate,gateBytes);}
  const extra=path.join(f.owner,'.gsd/CODING-STANDARDS.md'),extraBytes=fs.readFileSync(extra);
  fs.appendFileSync(extra,'changed standard\n');
  try{assert.throws(()=>successor.read(cap,r),/input-changed/);}finally{fs.writeFileSync(extra,extraBytes);}
  const stateFile=parent.recovery_baseline.state_file,stateBytes=fs.readFileSync(stateFile);
  fs.writeFileSync(stateFile,JSON.stringify({...JSON.parse(stateBytes),attempt:'foreign'}));
  try{assert.throws(()=>successor.read(cap,r),/source-changed/);}finally{fs.writeFileSync(stateFile,stateBytes);}
  const code=path.join(f.b,'same.txt'),codeBytes=fs.readFileSync(code);fs.appendFileSync(code,'drift');
  try{assert.throws(()=>successor.read(cap,r),/replay-code-changed|replay-baseline-changed|source-changed/);}finally{fs.writeFileSync(code,codeBytes);}
  const codeControl=path.join(f.b,'.gsd'),hadControl=fs.existsSync(codeControl);fs.mkdirSync(codeControl,{recursive:true});
  const foreignControl=path.join(codeControl,'foreign-owner-control.txt');fs.writeFileSync(foreignControl,'foreign control\n');
  try{assert.throws(()=>successor.read(cap,r),/execution-protected-metadata/);}finally{fs.unlinkSync(foreignControl);if(!hadControl)fs.rmdirSync(codeControl);}
  const held=require('./forge-runs').get(f.owner,r.runId).write_claim;
  require('./forge-runs').update(f.owner,r.runId,{write_claim:{...held,generation:'foreign'}});
  try{assert.throws(()=>successor.read(cap,r),/claim|source-changed/);}finally{require('./forge-runs').update(f.owner,r.runId,{write_claim:held});}
  const linkDir=path.join(f.owner,'.gsd/forge/time-links'),hadLinkDir=fs.existsSync(linkDir);fs.mkdirSync(linkDir,{recursive:true});
  const linkFile=path.join(linkDir,r.taskId+'.json');fs.writeFileSync(linkFile,'{}');
  try{assert.throws(()=>successor.read(cap,r),/scope-unsupported|linked/);}finally{fs.unlinkSync(linkFile);if(!hadLinkDir)fs.rmdirSync(linkDir);}
  const ownerExpected=view.expectedOwner({...parent,verification_successor:view.info,verification_seal:view.seal},parent.execution.protected_owner);
  assert.equal(ownerExpected['.gsd/forge/events.jsonl'],hash(fs.readFileSync(eventsFile)));
  assert(!Object.hasOwn(ownerExpected,'null'),'standalone never synthesizes a lease path');
  await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:{}}),/capability-required/);
  await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:cap,verification:{}}),/policy-mixing/);
  const imported=create(),importedView=successor.read(imported,r);
  fs.writeFileSync(importedView.receiptFile,JSON.stringify({...parent,phase:'ready',delivery_capture:{passed:true}}));
  await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:imported}),/already-used/);
  console.log('PASS standalone successor requires live authority and exact execution envelope; rejects foreign inputs, roots, claims, link, state, lease and imported capabilities');
  const published=await side.runUnitSidecar(r,{verificationSuccessor:cap});
  assert.equal(published.status,'done');assert.equal(calls,1);
  const next=JSON.parse(fs.readFileSync(view.receiptFile));
  assert.equal(next.phase,'ready');assert.equal(next.delivery_capture.passed,true);assert.equal(next.verification_successor.provider_called,false);
  assert.equal(next.verification_successor.worker_budget_unchanged,true);assert.equal(next.verification_successor.owner_event_reconciliation.event_count,2);
  assert.equal(next.verification_seal.command_timeout_ms,5000);assert.deepEqual(next.verification_seal.roots,parent.verification_seal.roots);
  assert.deepEqual(next.result,parent.result);assert.deepEqual(next.execution,parent.execution);assert(!Object.hasOwn(next,'milestone_delivery'));
  assert.deepEqual(fs.readFileSync(f.receiptFile),parentBytes);assert.deepEqual(fs.readFileSync(r.resultFile),outputBytes);assert.equal(JSON.stringify(r),requestBytes);
  assert.deepEqual(fs.existsSync(leaseDir)?fs.readdirSync(leaseDir):null,leasesBefore,'standalone successor never creates a milestone lease');
  assert(fs.existsSync(path.join(f.owner,'.gsd/tasks',r.taskId,r.taskId+'-DELIVERY.json')));
  assert(!next.artifacts.some(row=>row.path.endsWith('-PLAN.md')),'no fabricated slice marker');
  await assert.rejects(side.publishReadyRecord(r,next),/capability-required/);
  await assert.rejects(side.publishReadyRecord(r,next,undefined,undefined,{verificationSuccessor:cap}),/live-ready-required/);
  await assert.rejects(side.runUnitSidecar(r,{verificationSuccessor:cap}),/already-used|protected|source-changed/);
  console.log('PASS real standalone timeout124 continuation rechecks two physical roots and publishes the original done result once without inference, lease or rewriting originals');
 }finally{xllm.runExecute=original;f.cleanup();}
}
module.exports={main};if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
