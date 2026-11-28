'use strict';
// Explicit verification-only successor. The executed worker receipt, request,
// result, source and original seal remain immutable. No transport is authorized.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const roots=require('./forge-code-roots'),execution=require('./forge-task-execution');
const records=new WeakMap(),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,provider_called:false});};
const readBytes=file=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16777216)fail('verification-successor-file-invalid');const r=require('./forge-autonomy-sources').readBoundedStableFile(file,16777216,{expectedReal:fs.realpathSync.native(file)});if(r.error)fail('verification-successor-file-unstable');return r.buffer;};
// Issue 498: the frontmatter `verify:` block is the only plan region a policy
// correction may change. Everything else (other frontmatter keys, must_haves,
// writes and the whole body) must stay byte-identical to the original attempt.
function withoutVerifyBlock(text){
  const lines=text.split(/(?<=\n)/);
  if(!/^---\r?\n$/.test(lines[0]||''))fail('verification-successor-correction-plan-invalid');
  const end=lines.findIndex((line,i)=>i>0&&/^---\r?\n?$/.test(line));
  if(end<0)fail('verification-successor-correction-plan-invalid');
  const out=[];let skipping=false,seen=0;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(i>0&&i<end&&/^verify:/.test(line)){skipping=true;seen++;out.push('verify:\n');continue;}
    if(skipping&&i<end&&(/^\s/.test(line)||/^\r?\n$/.test(line)))continue;
    skipping=false;out.push(line);
  }
  if(seen!==1)fail('verification-successor-correction-plan-invalid');
  return out.join('');
}
function create({request,timeoutMs,reference,assertAuthority,assertBoundary,attestStoppedWriter,attestFailure,lease,ownerVerificationEvents,policyCorrection,scratchReconciliation}={}){
  const scratch=scratchReconciliation!==undefined;
  // Issue 510: the scratch mode has no verification failure to attest; the parent's
  // own failed receipt is the observation (execution-outside-claim).
  if([assertAuthority,assertBoundary,attestStoppedWriter,...(scratch?[]:[attestFailure])].some(fn=>typeof fn!=='function')||typeof reference!=='string'||!reference.trim()||reference.length>512)fail('verification-successor-live-authority-required');
  // A linked begin binding is an opaque in-process handle: keep it, clone the rest.
  const {linkedEntryBinding:linkedHandle,...plainRequest}=request||{};
  const r={...structuredClone(plainRequest),...(scratch&&linkedHandle?{linkedEntryBinding:linkedHandle}:{})},side=require('./forge-unit-sidecar'),recovery=require('./forge-attempt-recovery'),verify=require('./forge-verify');
  const standalone=r.scope==='standalone-task',correction=policyCorrection!==undefined;
  if(correction&&(standalone||timeoutMs!==undefined))fail('verification-successor-policy-mixing');
  if(scratch&&(correction||timeoutMs!==undefined||attestFailure!==undefined))fail('verification-successor-policy-mixing');
  if(scratch&&(standalone||typeof scratchReconciliation?.prefix!=='string'||typeof scratchReconciliation.approveScratch!=='function'))fail('verification-successor-scratch-proof-required');
  if(correction&&(!Buffer.isBuffer(policyCorrection?.originalPlanBytes)||typeof policyCorrection.approveCorrection!=='function'))fail('verification-successor-correction-proof-required');
  if(!['milestone','standalone-task'].includes(r.scope)||r.unitType!=='execute-task'||r.route?.worker_mode!=='sidecar'||r.linked_begin_key&&!scratch)fail('verification-successor-scope-unsupported');
  if(standalone&&(lease!==undefined||require('./forge-linked-task').linkedTaskFor(r.contextRoot,r.taskId)!==null))fail('verification-successor-scope-unsupported');
  side.validateRecoveryRequest(r);
  const parentFile=r.resultFile+'.receipt.json',parentBytes=readBytes(parentFile),parent=JSON.parse(parentBytes),outputBytes=readBytes(r.resultFile),output=JSON.parse(outputBytes);
  const deliveryKey=standalone?'execution':'milestone_delivery',otherKey=standalone?'milestone_delivery':'execution';
  let saved=parent[deliveryKey],returnedBytes=null,returned=null;
  if(scratch){
    // Issue 510: the retained normalized response, bound to the failed receipt by hash.
    const retainedRef=parent.failure?.returned_response;
    if(parent.phase!=='failed'||parent.failure?.reason_code!=='execution-outside-claim'||Object.hasOwn(parent,'milestone_delivery')||Object.hasOwn(parent,'execution')
      ||!retainedRef||retainedRef.channel!=='resultFile.returned.json'||!/^[a-f0-9]{64}$/.test(retainedRef.sha256||'')
      ||parent.dispatch_id!==r.dispatchId||parent.fingerprint!==side.artifactFingerprint(r)
      ||parent.recovery_identity_sha256!==roots.digest(recovery.requestIdentity(recovery.canonicalRequest(r)))
      ||output.status!=='adapter-failed'||output.dispatch_id!==r.dispatchId||output.reason_code!=='execution-outside-claim')fail('verification-successor-parent-binding');
    returnedBytes=readBytes(r.resultFile+'.returned.json');
    if(hash(returnedBytes)!==retainedRef.sha256)fail('verification-successor-returned-response-changed');
    returned=JSON.parse(returnedBytes);
    if(returned.version!==1||returned.dispatch_id!==r.dispatchId||returned.request_fingerprint!==parent.fingerprint
      ||returned.result?.status!=='done'||!Array.isArray(returned.result.files_changed))fail('verification-successor-returned-response-invalid');
    saved={};
  }
  if(scratch);
  else if(parent.phase!=='executed'||parent.result?.status!=='done'||!saved||typeof saved!=='object'||Array.isArray(saved)||Object.hasOwn(parent,otherKey)
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
    ||path.resolve(baseline.input?.path||'')!==path.resolve(r.planFile)
    ||roots.digest(correction?policyCorrection.originalPlanBytes:readBytes(r.planFile))!==baseline.input.sha256)fail('verification-successor-baseline-binding');
  const plan=readBytes(r.planFile),identity={dispatch_id:r.dispatchId,fingerprint:parent.fingerprint,recovery_identity_sha256:parent.recovery_identity_sha256};
  const originalPlan=correction?policyCorrection.originalPlanBytes:plan;
  const original=verify.normalizeExecutionVerification(r.execution_contract,originalPlan.toString('utf8'),r.verification||{},{},identity);
  if(roots.digest(original)!==roots.digest(parent.verification_seal))fail('verification-successor-original-seal');
  let seal,correctionEvidence=null,scratchEvidence=null,scratchSeed=null;
  if(scratch){
    seal=original;
    const contract=r.execution_contract,primary=contract.code_roots.find(row=>row.id===contract.primary_root_id);
    const raw=scratchReconciliation.prefix.replace(/\\/g,'/');
    const prefix=raw.endsWith('/')?raw:raw+'/';
    if(!primary||primary.vcs!=='git'||prefix==='/'||path.isAbsolute(raw)||/(^|\/)\.\.?(\/|$)/.test(prefix)||/[\x00-\x1f:]/.test(prefix)
      ||prefix.split('/').filter(Boolean)[0]==='.gsd'||prefix.startsWith('.git/'))fail('verification-successor-scratch-prefix-invalid');
    const checked=roots.validatePlan(plan.toString('utf8'),contract),claims=checked.writes;
    const prefixResolved=roots.resolvePath(contract,{root_id:primary.id,path:prefix.slice(0,-1)});
    if(claims.some(claim=>roots.covers(claim,prefixResolved)||(claim.root_id||primary.id)===primary.id&&String(claim.path||'').replace(/\\/g,'/').startsWith(prefix)))fail('verification-successor-scratch-prefix-claimed');
    const qualified=entry=>typeof entry==='string'&&entry.includes('::');
    const entryPath=entry=>(typeof entry==='string'?(qualified(entry)?entry.slice(entry.indexOf('::')+2):entry):entry?.path||'').replace(/\\/g,'/');
    const entryRoot=entry=>typeof entry==='string'?(qualified(entry)?entry.slice(0,entry.indexOf('::')):primary.id):entry?.root_id||primary.id;
    const inScratch=entry=>entryRoot(entry)===primary.id&&entryPath(entry).startsWith(prefix);
    const removed=returned.result.files_changed.filter(inScratch),kept=returned.result.files_changed.filter(entry=>!inScratch(entry));
    if(!removed.length)fail('verification-successor-scratch-unchanged');
    if(removed.some(entry=>typeof entry!=='string'&&entry.status!==undefined&&entry.status!=='A'))fail('verification-successor-scratch-not-added');
    for(const entry of kept){
      const resolved=roots.resolvePath(contract,typeof entry==='string'?entry:{root_id:entryRoot(entry),path:entryPath(entry)},{legacy:contract.code_roots.length===1});
      if(!claims.some(claim=>roots.covers(claim,resolved)))fail('verification-successor-scratch-outside-prefix');
    }
    // Attempt-attributable: absent from the start revision and from the pre-attempt dirt.
    const repo=state.repos.find(row=>row.root_id===primary.id);
    if(!repo||repo.vcs!=='git'||(repo.pre_dirty||[]).some(row=>String(row.path).replace(/\\/g,'/').startsWith(prefix)))fail('verification-successor-scratch-preexisting');
    const tracked=require('child_process').execFileSync('git',['-C',primary.path,'ls-tree','-r','--name-only',repo.start_sha,'--',prefix],{encoding:'utf8'});
    if(tracked.trim())fail('verification-successor-scratch-tracked');
    // The owner removed it before the successor; the live census below proves the rest.
    if(fs.existsSync(path.join(primary.path,...prefix.split('/').filter(Boolean))))fail('verification-successor-scratch-present');
    // Only the measured delta is projected; the worker's own declarations stay as returned.
    const projected={...returned.result,files_changed:kept};
    const codeState=execution.replayState(r.cwd,contract);
    const verifiedFiles=execution.verifyResult(r.cwd,{execution_contract:contract,claims,snapshots:state.repos},projected);
    if(roots.digest(execution.replayState(r.cwd,contract))!==roots.digest(codeState))fail('verification-successor-source-changed');
    const removedPaths=removed.map(entryPath).sort();
    const challenge=Object.freeze({dispatch_id:r.dispatchId,parent_receipt_sha256:hash(parentBytes),returned_response_sha256:hash(returnedBytes),
      scratch_prefix:prefix,removed_entries:removedPaths.length,removed_entries_sha256:hash(JSON.stringify(removedPaths)),
      claim_paths:Object.freeze(claims.map(claim=>String(claim.root_id||primary.id)+'::'+String(claim.path))),verified_files_sha256:roots.digest(verifiedFiles)});
    const approval=scratchReconciliation.approveScratch(challenge);
    if(approval?.approved!==true||typeof approval.reference!=='string'||!approval.reference.trim()||approval.reference.length>512)fail('verification-successor-scratch-approval-required');
    if(roots.digest(execution.replayState(r.cwd,contract))!==roots.digest(codeState))fail('verification-successor-source-changed');
    scratchEvidence={kind:'operator-scratch-outside-claim-reconciliation',reference:approval.reference,parent_failure_reason_code:'execution-outside-claim',
      returned_response_sha256:challenge.returned_response_sha256,scratch_prefix:prefix,removed_entries:challenge.removed_entries,
      removed_entries_sha256:challenge.removed_entries_sha256,verified_files_sha256:challenge.verified_files_sha256};
    const {failure,...base}=structuredClone(parent);
    saved={plan_sha256:hash(plan),verified_files:verifiedFiles,protected_owner:structuredClone(baseline.protected_owner),
      protected_roots:structuredClone(baseline.protected_roots),code_state:codeState};
    scratchSeed={...base,phase:'executed',provider_called:true,
      final_evidence:failure.final_evidence?{...failure.final_evidence,stage:'returned',provider_called:true}:base.final_evidence||null,
      milestone_delivery:saved,
      result:{...projected,dispatch_id:r.dispatchId,workflow_id:r.workflowId,host_runtime:parent.route?.host_runtime,worker_engine:parent.route?.resolved_worker_engine}};
  }
  else if(correction){
    // Issue 498: a caller/plan defect in `verify:` is corrected by an explicit,
    // live operator decision. Only that block may differ; the new seal is derived
    // from the corrected plan with the same request, identity and bindings.
    if(withoutVerifyBlock(originalPlan.toString('utf8'))!==withoutVerifyBlock(plan.toString('utf8')))fail('verification-successor-correction-scope');
    seal=verify.normalizeExecutionVerification(r.execution_contract,plan.toString('utf8'),r.verification||{},{},identity);
    if(seal.sha256===original.sha256)fail('verification-successor-correction-unchanged');
    const loc=side.locations(r);
    require('./forge-delivery').validateExecutionBindings(plan.toString('utf8'),r.execution_contract,loc.rules[loc.delivery.input].unit,r.verification?.bindings,seal);
  }else{
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=original.command_timeout_ms)fail('verification-successor-timeout-increase-required');
    const {sha256:ignored,...base}=original,policy={...base,command_timeout_ms:timeoutMs,timeout_origin:'owner-verification-successor'};
    seal={...policy,sha256:roots.digest(policy)};
  }
  const observation=scratch?null:attestFailure({dispatch_id:r.dispatchId,parent_receipt_sha256:hash(parentBytes),original_output_sha256:hash(outputBytes),original_seal_sha256:original.sha256,roots:original.roots.map(row=>({root_id:row.root_id,command_sha256:row.commands.map(hash)}))});
  if(!scratch){
  const observedRoot=original.roots.find(row=>row.root_id===observation?.root_id),command=observedRoot?.commands[observation?.check_index];
  const observedExit=correction?Number.isInteger(observation?.exit_code)&&observation.exit_code!==0:observation?.exit_code===124&&observation.timed_out===true;
  if(observation?.observed!==true||observation.reason_code!=='execution-verification-failed'||!observedExit
    ||typeof observation.reference!=='string'||!observation.reference.trim()||observation.reference.length>512||!Number.isInteger(observation.check_index)||observation.check_index<0
    ||!command||observation.command_sha256!==hash(command))fail(correction?'verification-successor-failure-observation-required':'verification-successor-timeout-observation-required');
  if(parent.delivery_capture){const check=parent.delivery_capture.gate?.roots.find(row=>row.root_id===observation.root_id)?.result.checks[observation.check_index];
    if(parent.delivery_capture.passed!==false||check?.exitCode!==(correction?observation.exit_code:124))fail('verification-successor-failure-capture-mismatch');}
  else if(correction)fail('verification-successor-failure-capture-mismatch');
  }
  if(correction){
    const challenge=Object.freeze({dispatch_id:r.dispatchId,parent_receipt_sha256:hash(parentBytes),original_plan_sha256:hash(originalPlan),corrected_plan_sha256:hash(plan),
      original_seal_sha256:original.sha256,corrected_seal_sha256:seal.sha256,
      corrected_commands:Object.freeze(seal.roots.map(row=>Object.freeze({root_id:row.root_id,commands:Object.freeze([...row.commands])})))});
    const approval=policyCorrection.approveCorrection(challenge);
    if(approval?.approved!==true||typeof approval.reference!=='string'||!approval.reference.trim()||approval.reference.length>512)fail('verification-successor-correction-approval-required');
    correctionEvidence={kind:'operator-verification-policy-correction',reference:approval.reference,original_plan_sha256:challenge.original_plan_sha256,
      corrected_plan_sha256:challenge.corrected_plan_sha256,original_seal_sha256:challenge.original_seal_sha256,corrected_seal_sha256:challenge.corrected_seal_sha256};
  }
  const originalOwner=saved.protected_owner,leaseApi=require('./forge-unit-lease'),unit=r.unitType+'/'+r.taskId;
  if(!originalOwner||typeof originalOwner!=='object'||Array.isArray(originalOwner))fail('verification-successor-parent-binding');
  if(standalone&&(!Array.isArray(baseline.protected_roots)||baseline.protected_roots.length!==r.execution_contract.code_roots.length
    ||r.execution_contract.code_roots.some(root=>baseline.protected_roots.filter(row=>row.root_id===root.id&&row.path===root.path).length!==1)))fail('verification-successor-baseline-binding');
  const eventsRelative='.gsd/forge/events.jsonl',eventsFile=path.join(r.contextRoot,eventsRelative),eventsBytes=readBytes(eventsFile);
  let eventEvidence=null;const deferred={lease:false,events:false};
  if(hash(eventsBytes)!==originalOwner[eventsRelative]&&!(scratch&&ownerVerificationEvents===undefined&&(deferred.events=true))){
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
  if(originalOwner[relative]!==hash(currentLeaseBytes)&&!(scratch&&lease===undefined&&(deferred.lease=true))){
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
  const info={schema_version:1,kind:scratch?'scratch-reconciliation-successor':correction?'verification-policy-correction-successor':'verification-timeout-successor',reference,parent_receipt_sha256:hash(parentBytes),original_output_sha256:hash(outputBytes),original_baseline_state_sha256:hash(stateBytes),original_verification_seal_sha256:original.sha256,verification_seal_sha256:seal.sha256,command_timeout_ms:seal.command_timeout_ms,provider_called:false,worker_budget_unchanged:true,...(eventEvidence?{owner_event_reconciliation:eventEvidence}:{}),
    ...(correctionEvidence?{policy_correction:correctionEvidence}:{}),
    ...(scratchEvidence?{scratch_reconciliation:scratchEvidence,owner_deferred:{...deferred}}:{}),
    failure_observation:scratch?{reference:'receipt:failure.reason_code',reason_code:'execution-outside-claim',legacy_uncaptured:false}:{reference:observation.reference,root_id:observation.root_id,check_index:observation.check_index,command_sha256:observation.command_sha256,exit_code:correction?observation.exit_code:124,timed_out:correction?observation.timed_out===true:true,legacy_uncaptured:!parent.delivery_capture}};
  // A successor is single-use. Never import a ready record/capture from disk:
  // persisted JSON cannot attest that this process actually executed the gate.
  const key=crypto.randomBytes(24).toString('hex'),prefix=path.join(path.dirname(r.resultFile),'forge-verification-successor-'+key);
  const receiptFile=prefix+'.receipt.json',resultFile=prefix+'.result.json';
  for(const file of [receiptFile,resultFile])for(const root of [r.contextRoot,...r.execution_contract.code_roots.map(row=>row.path)])require('./forge-xllm').validateResultFileTarget(file,root);
  const seed={...structuredClone(scratchSeed||parent),verification_seal:seal,verification_successor:info,...(leaseEvidence?{owner_clock_reconciliation:leaseEvidence}:{})};delete seed.delivery_capture;
  const assertRecord=record=>{
    check();const expected=scratchSeed?{...scratchSeed,verification_successor:info,verification_seal:seal}:{...parent,verification_successor:info,verification_seal:seal};
    for(const key of ['verification_successor','verification_seal','result','fingerprint','dispatch_id','recovery_identity_sha256','kind','execution','route','before','milestone_delivery']){
      if(roots.digest(record[key]??null)!==roots.digest(expected[key]??null))fail('verification-successor-record-changed-'+key);
    }
  };
  // Issue 498: the corrected plan is an owner surface; only its exact approved
  // transition (original attempt bytes -> corrected bytes) is admitted.
  const planRelative=path.relative(r.contextRoot,r.planFile).replace(/\\/g,'/');
  if(correction&&Object.hasOwn(originalOwner,planRelative)&&originalOwner[planRelative]!==hash(originalPlan))fail('verification-successor-correction-owner-baseline');
  const expectedOwner=(record,expected)=>{
    assertRecord(record);if(expected[eventsRelative]!==originalOwner[eventsRelative]||!standalone&&expected[relative]!==originalOwner[relative])fail('verification-successor-owner-baseline-changed');
    if(correction&&Object.hasOwn(expected,planRelative)&&expected[planRelative]!==originalOwner[planRelative])fail('verification-successor-owner-baseline-changed');
    return {...expected,...(!standalone?{[relative]:hash(currentLeaseBytes)}:{}),[eventsRelative]:hash(eventsBytes),
      ...(correction&&Object.hasOwn(expected,planRelative)?{[planRelative]:hash(plan)}:{})};
  };
  const capability=Object.freeze({});records.set(capability,{request_digest:roots.digest(r),check,assertRecord,expectedOwner,seal,info,receiptFile,resultFile,seed,used:false,
    ownerDeferred:deferred.lease||deferred.events});return capability;
}
function readUnscoped(capability,request){
  const value=records.get(capability);if(!value)return require('./forge-sidecar-verification-repair').read(capability,request);
  if(roots.digest(request)!==value.request_digest)fail('verification-successor-capability-required');value.check();
  return {check:value.check,assertRecord:value.assertRecord,expectedOwner:value.expectedOwner,seal:structuredClone(value.seal),info:structuredClone(value.info),receiptFile:value.receiptFile,resultFile:value.resultFile,
    initialize(){value.check();if(value.used||fs.existsSync(value.receiptFile)||fs.existsSync(value.resultFile))fail('verification-successor-already-used');value.used=true;
      fs.writeFileSync(value.receiptFile,JSON.stringify(value.seed,null,2)+'\n',{flag:'wx',mode:0o600});},
  };
}
const ownerReconciliations = new WeakMap();
function bindOwnerReconciliation(capability, request, ownerReconciliation) {
  const activity = require('./forge-protected-owner-activity');
  if (ownerReconciliations.has(capability)) {
    if (ownerReconciliations.get(capability) !== ownerReconciliation) fail('verification-successor-reconciliation-mismatch');
    return read(capability, request), capability;
  }
  activity.withOwnerReconciliationRead(ownerReconciliation, request, () => readUnscoped(capability, request));
  ownerReconciliations.set(capability, ownerReconciliation);
  return capability;
}
function read(capability, request) {
  const ownerReconciliation = ownerReconciliations.get(capability);
  if (!ownerReconciliation) {
    if (records.get(capability)?.ownerDeferred) fail('verification-successor-owner-reconciliation-required');
    return readUnscoped(capability, request);
  }
  const activity = require('./forge-protected-owner-activity');
  const scoped = action => activity.withOwnerReconciliationRead(ownerReconciliation, request, action);
  const value = scoped(() => readUnscoped(capability, request));
  return { ...value, check: () => scoped(value.check), assertRecord: record => scoped(() => value.assertRecord(record)),
    // Issue 498: the owner comparison happens after this scope ends, so return
    // the expectation already projected by the live reconciliation's approved delta.
    expectedOwner: (record, expected) => scoped(() => activity.expectedProtectedOwner(request.contextRoot, value.expectedOwner(record, expected))),
    initialize: () => scoped(value.initialize) };
}

module.exports={create,read,bindOwnerReconciliation,withoutVerifyBlock};
