'use strict';
// Explicit verification-only successor. The executed worker receipt, request,
// result, source and original seal remain immutable. No transport is authorized.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const roots=require('./forge-code-roots'),execution=require('./forge-task-execution');
const records=new WeakMap(),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,provider_called:false});};
const readBytes=file=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16777216)fail('verification-successor-file-invalid');const r=require('./forge-autonomy-sources').readBoundedStableFile(file,16777216,{expectedReal:fs.realpathSync.native(file)});if(r.error)fail('verification-successor-file-unstable');return r.buffer;};
function create({request,timeoutMs,reference,assertAuthority,assertBoundary,attestStoppedWriter,attestFailure,lease,ownerVerificationEvents}={}){
  if([assertAuthority,assertBoundary,attestStoppedWriter,attestFailure].some(fn=>typeof fn!=='function')||typeof reference!=='string'||!reference.trim()||reference.length>512)fail('verification-successor-live-authority-required');
  const r=structuredClone(request),side=require('./forge-unit-sidecar'),recovery=require('./forge-attempt-recovery'),verify=require('./forge-verify');
  const standalone=r.scope==='standalone-task';
  if(!['milestone','standalone-task'].includes(r.scope)||r.unitType!=='execute-task'||r.route?.worker_mode!=='sidecar'||r.linked_begin_key)fail('verification-successor-scope-unsupported');
  if(standalone&&(lease!==undefined||require('./forge-linked-task').linkedTaskFor(r.contextRoot,r.taskId)!==null))fail('verification-successor-scope-unsupported');
  side.validateRecoveryRequest(r);
  const parentFile=r.resultFile+'.receipt.json',parentBytes=readBytes(parentFile),parent=JSON.parse(parentBytes),outputBytes=readBytes(r.resultFile),output=JSON.parse(outputBytes);
  const deliveryKey=standalone?'execution':'milestone_delivery',otherKey=standalone?'milestone_delivery':'execution',saved=parent[deliveryKey];
  if(parent.phase!=='executed'||parent.result?.status!=='done'||!saved||typeof saved!=='object'||Array.isArray(saved)||Object.hasOwn(parent,otherKey)
    ||standalone&&roots.digest(saved.execution_contract)!==roots.digest(r.execution_contract)
    ||parent.dispatch_id!==r.dispatchId||parent.fingerprint!==side.artifactFingerprint(r)
    ||parent.recovery_identity_sha256!==roots.digest(recovery.requestIdentity(recovery.canonicalRequest(r)))
    ||output.status!=='adapter-failed'||output.dispatch_id!==r.dispatchId||output.reason_code!=='execution-verification-failed')fail('verification-successor-parent-binding');
  const baseline=parent.recovery_baseline;
  if(!baseline||baseline.schema_version!==1||baseline.dispatch_id!==r.dispatchId||baseline.fingerprint!==parent.fingerprint
    ||roots.digest(baseline.execution_contract)!==roots.digest(r.execution_contract))fail('verification-successor-baseline-binding');
  if(standalone&&(!saved.inputs||typeof saved.inputs!=='object'||Array.isArray(saved.inputs)||!Object.keys(saved.inputs).length
    ||path.resolve(parent.reset_state_file||'')!==path.resolve(baseline.state_file)))fail('verification-successor-baseline-binding');
  recovery.validateStateTarget(baseline.state_file,r,r.execution_contract);
  const stateBytes=readBytes(baseline.state_file),state=require('./forge-surgical-reset').readState(baseline.state_file);
  const {reconciliation,...stateBody}=state;
  if(reconciliation||state.attempt!==r.dispatchId||roots.digest(stateBody)!==baseline.state_sha256
    ||roots.digest(state.execution_contract)!==roots.digest(r.execution_contract)
    ||path.resolve(baseline.input?.path||'')!==path.resolve(r.planFile)||roots.digest(readBytes(r.planFile))!==baseline.input.sha256)fail('verification-successor-baseline-binding');
  const plan=readBytes(r.planFile),identity={dispatch_id:r.dispatchId,fingerprint:parent.fingerprint,recovery_identity_sha256:parent.recovery_identity_sha256};
  const original=verify.normalizeExecutionVerification(r.execution_contract,plan.toString('utf8'),r.verification||{},{},identity);
  if(roots.digest(original)!==roots.digest(parent.verification_seal))fail('verification-successor-original-seal');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=original.command_timeout_ms)fail('verification-successor-timeout-increase-required');
  const {sha256:ignored,...base}=original,policy={...base,command_timeout_ms:timeoutMs,timeout_origin:'owner-verification-successor'};
  const seal={...policy,sha256:roots.digest(policy)};
  const observation=attestFailure({dispatch_id:r.dispatchId,parent_receipt_sha256:hash(parentBytes),original_output_sha256:hash(outputBytes),original_seal_sha256:original.sha256,roots:original.roots.map(row=>({root_id:row.root_id,command_sha256:row.commands.map(hash)}))});
  const observedRoot=original.roots.find(row=>row.root_id===observation?.root_id),command=observedRoot?.commands[observation?.check_index];
  if(observation?.observed!==true||observation.reason_code!=='execution-verification-failed'||observation.exit_code!==124||observation.timed_out!==true
    ||typeof observation.reference!=='string'||!observation.reference.trim()||observation.reference.length>512||!Number.isInteger(observation.check_index)||observation.check_index<0
    ||!command||observation.command_sha256!==hash(command))fail('verification-successor-timeout-observation-required');
  if(parent.delivery_capture){const check=parent.delivery_capture.gate?.roots.find(row=>row.root_id===observation.root_id)?.result.checks[observation.check_index];if(parent.delivery_capture.passed!==false||check?.exitCode!==124)fail('verification-successor-failure-capture-mismatch');}
  const originalOwner=saved.protected_owner,leaseApi=require('./forge-unit-lease'),unit=r.unitType+'/'+r.taskId;
  if(!originalOwner||typeof originalOwner!=='object'||Array.isArray(originalOwner))fail('verification-successor-parent-binding');
  if(standalone&&(!Array.isArray(baseline.protected_roots)||baseline.protected_roots.length!==r.execution_contract.code_roots.length
    ||r.execution_contract.code_roots.some(root=>baseline.protected_roots.filter(row=>row.root_id===root.id&&row.path===root.path).length!==1)))fail('verification-successor-baseline-binding');
  const eventsRelative='.gsd/forge/events.jsonl',eventsFile=path.join(r.contextRoot,eventsRelative),eventsBytes=readBytes(eventsFile);
  let eventEvidence=null;
  if(hash(eventsBytes)!==originalOwner[eventsRelative]){
    const e=ownerVerificationEvents;
    if(!Buffer.isBuffer(e?.originalBytes)||!Buffer.isBuffer(e.appendedBytes)||typeof e.attestAppend!=='function'
      ||hash(e.originalBytes)!==originalOwner[eventsRelative]||e.appendedBytes.length===0||e.appendedBytes.length>65536
      ||!Buffer.concat([e.originalBytes,e.appendedBytes]).equals(eventsBytes))fail('verification-successor-diagnostic-events-proof-required');
    let rows;try{rows=e.appendedBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);}catch{fail('verification-successor-diagnostic-events-invalid');}
    if(rows.length>128||e.appendedBytes.at(-1)!==10||rows.some((row,i)=>Object.keys(row).sort().join(',')!=='kind,reason,ts'
      ||row.kind!=='resource-clamp-skipped'||row.reason!=='intact:not-runner-command'||!Number.isFinite(Date.parse(row.ts))||Date.parse(row.ts)>Date.now()
      ||i>0&&Date.parse(row.ts)<Date.parse(rows[i-1].ts)))fail('verification-successor-diagnostic-events-invalid');
    const challenge={dispatch_id:r.dispatchId,parent_receipt_sha256:hash(parentBytes),original_sha256:hash(e.originalBytes),appended_sha256:hash(e.appendedBytes),current_sha256:hash(eventsBytes),event_count:rows.length};
    const observed=e.attestAppend(Object.freeze(challenge));
    if(observed?.observed!==true||typeof observed.reference!=='string'||!observed.reference.trim()||observed.reference.length>512)fail('verification-successor-diagnostic-events-attestation-required');
    eventEvidence={kind:'owner-diagnostic-verification-events',reference:observed.reference,...challenge};
  }
  let leaseFile=null,relative=null,currentLeaseBytes=null,leaseEvidence=null;
  if(!standalone){
  leaseFile=leaseApi.leaseFile(r.contextRoot,unit);relative=path.relative(r.contextRoot,leaseFile).replace(/\\/g,'/');currentLeaseBytes=readBytes(leaseFile);
  const currentLease=JSON.parse(currentLeaseBytes);
  if(originalOwner[relative]!==hash(currentLeaseBytes)){
    if(!Buffer.isBuffer(lease?.originalBytes)||hash(lease.originalBytes)!==originalOwner[relative])fail('verification-successor-original-lease-required');
    const old=JSON.parse(lease.originalBytes),nonClock=x=>Object.fromEntries(Object.entries(x).filter(([key])=>!['heartbeat_at','expires_at'].includes(key)));
    if(!leaseApi.validRecord(old,unit)||!leaseApi.validRecord(currentLease,unit)||old.owner_token!==lease.ownerToken||currentLease.owner_token!==lease.ownerToken||old.generation!==lease.generation||currentLease.generation!==lease.generation
      ||roots.digest(nonClock(old))!==roots.digest(nonClock(currentLease))||currentLease.heartbeat_at<old.heartbeat_at||currentLease.expires_at<old.expires_at||currentLease.heartbeat_at>Date.now())fail('verification-successor-lease-binding');
    leaseEvidence={kind:'same-owner-lease-clock-reconciliation',path:relative,original_sha256:hash(lease.originalBytes),current_sha256:hash(currentLeaseBytes),allowed_fields:['heartbeat_at','expires_at']};
  }
  }
  const inputs=[r.planFile,r.contextFile,r.securityFile,r.researchFile,r.roadmapFile,r.promptFile].filter(Boolean).map(file=>({file,sha256:hash(readBytes(file))}));
  const check=()=>{
    side.validateRecoveryRequest(r);
    assertAuthority();assertBoundary();if(attestStoppedWriter()!==true)fail('verification-successor-writer-not-stopped');
    if(standalone){
      if(require('./forge-linked-task').linkedTaskFor(r.contextRoot,r.taskId)!==null)fail('verification-successor-scope-unsupported');
      execution.assertReplay(r,parent);
      for(const row of baseline.protected_roots)if(path.resolve(row.path)!==path.resolve(r.contextRoot))execution.assertProtected(row.path,row.snapshot);
    }
    if(hash(readBytes(parentFile))!==hash(parentBytes)||hash(readBytes(r.resultFile))!==hash(outputBytes)||!standalone&&hash(readBytes(leaseFile))!==hash(currentLeaseBytes)
      ||hash(readBytes(baseline.state_file))!==hash(stateBytes)||hash(readBytes(eventsFile))!==hash(eventsBytes)
      ||inputs.some(row=>hash(readBytes(row.file))!==row.sha256)||roots.digest(require('./forge-runs').get(r.contextRoot,r.runId)?.write_claim)!==roots.digest(r.claim)
      ||!standalone&&roots.digest(execution.replayState(r.cwd,r.execution_contract))!==roots.digest(saved.code_state))fail('verification-successor-source-changed');
    roots.validateContract(r.execution_contract,{owner:r.contextRoot,revalidate:true});
  };
  check();
  const info={schema_version:1,kind:'verification-timeout-successor',reference,parent_receipt_sha256:hash(parentBytes),original_output_sha256:hash(outputBytes),original_baseline_state_sha256:hash(stateBytes),original_verification_seal_sha256:original.sha256,verification_seal_sha256:seal.sha256,command_timeout_ms:timeoutMs,provider_called:false,worker_budget_unchanged:true,...(eventEvidence?{owner_event_reconciliation:eventEvidence}:{}),
    failure_observation:{reference:observation.reference,root_id:observation.root_id,check_index:observation.check_index,command_sha256:observation.command_sha256,exit_code:124,timed_out:true,legacy_uncaptured:!parent.delivery_capture}};
  // A successor is single-use. Never import a ready record/capture from disk:
  // persisted JSON cannot attest that this process actually executed the gate.
  const key=crypto.randomBytes(24).toString('hex'),prefix=path.join(path.dirname(r.resultFile),'forge-verification-successor-'+key);
  const receiptFile=prefix+'.receipt.json',resultFile=prefix+'.result.json';
  for(const file of [receiptFile,resultFile])for(const root of [r.contextRoot,...r.execution_contract.code_roots.map(row=>row.path)])require('./forge-xllm').validateResultFileTarget(file,root);
  const seed={...structuredClone(parent),verification_seal:seal,verification_successor:info,...(leaseEvidence?{owner_clock_reconciliation:leaseEvidence}:{})};delete seed.delivery_capture;
  const assertRecord=record=>{
    check();const expected={...parent,verification_successor:info,verification_seal:seal};
    for(const key of ['verification_successor','verification_seal','result','fingerprint','dispatch_id','recovery_identity_sha256','kind','execution','route','before','milestone_delivery']){
      if(roots.digest(record[key]??null)!==roots.digest(expected[key]??null))fail('verification-successor-record-changed-'+key);
    }
  };
  const expectedOwner=(record,expected)=>{
    assertRecord(record);if(expected[eventsRelative]!==originalOwner[eventsRelative]||!standalone&&expected[relative]!==originalOwner[relative])fail('verification-successor-owner-baseline-changed');
    return {...expected,...(!standalone?{[relative]:hash(currentLeaseBytes)}:{}),[eventsRelative]:hash(eventsBytes)};
  };
  const capability=Object.freeze({});records.set(capability,{request_digest:roots.digest(r),check,assertRecord,expectedOwner,seal,info,receiptFile,resultFile,seed,used:false});return capability;
}
function read(capability,request){
  const value=records.get(capability);if(!value||roots.digest(request)!==value.request_digest)fail('verification-successor-capability-required');value.check();
  return {check:value.check,assertRecord:value.assertRecord,expectedOwner:value.expectedOwner,seal:structuredClone(value.seal),info:structuredClone(value.info),receiptFile:value.receiptFile,resultFile:value.resultFile,
    initialize(){value.check();if(value.used||fs.existsSync(value.receiptFile)||fs.existsSync(value.resultFile))fail('verification-successor-already-used');value.used=true;
      fs.writeFileSync(value.receiptFile,JSON.stringify(value.seed,null,2)+'\n',{flag:'wx',mode:0o600});},
  };
}
module.exports={create,read};
