'use strict';
// Explicit lifecycle primitives. Import is inert. No provider invocation or route override.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const api = name => require('./' + name);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=c=>{throw Object.assign(new Error(c),{code:c});};
// Match sidecar validation defaults without rewriting durable request/manifest bytes.
const requestIdentity=request=>{
  const recovery=api('forge-attempt-recovery');
  return recovery.requestIdentity(recovery.canonicalRequest(request));
};
const leaseRenewals=new WeakMap();
// Trusted host capability: imported receipts never authorize metadata changes.
// The original lease preimage must match the immutable prewrite snapshot.
function createLeaseRenewalReconciliation({savedManifestFile,originalLeaseBytes,ownerToken,generation,
  attestStoppedWriter,assertAuthority}={}) {
  if(!Buffer.isBuffer(originalLeaseBytes)||typeof attestStoppedWriter!=='function'||typeof assertAuthority!=='function')fail('lease-renewal-live-authority-required');
  const bytes=fs.readFileSync(savedManifestFile),manifest=JSON.parse(bytes),r=manifest.request;
  if(path.resolve(savedManifestFile)!==path.resolve(r.resultFile+'.manifest.json'))fail('lease-renewal-manifest-path');
  const lease=api('forge-unit-lease'),roots=api('forge-code-roots'),execution=api('forge-task-execution');
  const unit=r.unitType+'/'+r.taskId,file=lease.leaseFile(r.contextRoot,unit),relative=path.relative(r.contextRoot,file).replace(/\\/g,'/');
  if(hash(originalLeaseBytes)!==manifest.prepared.protected_owner[relative])fail('lease-renewal-original-hash');
  const original=JSON.parse(originalLeaseBytes),currentBytes=fs.readFileSync(file),current=JSON.parse(currentBytes);
  if(!lease.validRecord(original,unit)||!lease.validRecord(current,unit)
    ||!ownerToken||!generation||original.owner_token!==ownerToken||current.owner_token!==ownerToken
    ||original.generation!==generation||current.generation!==generation)fail('lease-renewal-owner-mismatch');
  const nonClock=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['heartbeat_at','expires_at'].includes(key)));
  if(roots.digest(nonClock(original))!==roots.digest(nonClock(current))
    ||current.heartbeat_at<original.heartbeat_at||current.expires_at<original.expires_at
    ||current.heartbeat_at>Date.now())fail('lease-renewal-fields-invalid');
  const expected={...manifest.prepared.protected_owner,[relative]:hash(currentBytes)};
  const check=publishing=>{
    assertAuthority();if(attestStoppedWriter()!==true)fail('lease-renewal-writer-not-stopped');
    if(hash(fs.readFileSync(savedManifestFile))!==hash(bytes)||hash(fs.readFileSync(file))!==hash(currentBytes))fail('lease-renewal-evidence-changed');
    if(lease.observe(r.contextRoot,unit).reason!=='lease-active')fail('lease-renewal-not-active');
    if(!publishing&&roots.digest(Object.entries(execution.protectedSnapshot(r.contextRoot)).sort())!==roots.digest(Object.entries(expected).sort()))fail('lease-renewal-unproved-metadata');
  };
  check(false);
  const handle=Object.freeze({}),evidence={kind:'trusted-parent-lease-renewal',manifest_sha256:hash(bytes),
    path:relative,original_sha256:hash(originalLeaseBytes),renewed_sha256:hash(currentBytes),
    allowed_fields:['heartbeat_at','expires_at'],writer_stopped:true};
  leaseRenewals.set(handle,{manifest_digest:roots.digest(manifest),check,evidence,manifest,relative,renewed_hash:hash(currentBytes)});return handle;
}
function reconcileLeaseRenewalSurface(handle,record,expected) {
  const renewal=leaseRenewals.get(handle),roots=api('forge-code-roots');
  if(!renewal||record.kind!=='native-execute-task'||record.manifest_sha256!==renewal.evidence.manifest_sha256
    ||record.dispatch_id!==renewal.manifest.request.dispatchId
    ||roots.digest(record.lease_reconciliation)!==roots.digest(renewal.evidence)
    ||roots.digest(record.milestone_delivery?.protected_owner)!==roots.digest(renewal.manifest.prepared.protected_owner)
    ||expected[renewal.relative]!==renewal.evidence.original_sha256)fail('lease-renewal-publication-binding');
  renewal.check(true);return {...expected,[renewal.relative]:renewal.renewed_hash};
}

const string = { type: 'string' };
const object = properties => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const array = items => ({ type: 'array', items });
const resultContract = api('forge-worker-result-contract').contract('milestone-recovery', object({
  status: { ...string, enum: ['done', 'partial', 'blocked'] }, summary: { ...string, minLength: 1 },
  files_changed: array(string), must_haves_status: array(object({
    item: string, status: { ...string, enum: ['met', 'unmet', 'unknown'] }, note: string,
    kind: { ...string, enum: ['truth', 'artifact', 'key_link'] }, index: { type: 'integer', minimum: 0 },
    root_id: string, evidence: array(object({ root_id: string, check: string, stdout_line: { ...string, minLength: 1 } })),
  })),
}));
function packagePrompt(request, prompt) {
  const roots = api('forge-code-roots');
  const contract = roots.validateContract(request.execution_contract, { owner: request.contextRoot, revalidate: true });
  for (const root of [contract.owner, ...contract.code_roots.map(row => row.path)])
    api('forge-xllm').validateResultFileTarget(request.resultFile, root);
  const sections = inputSections(request);
  const inputs = sections.map(([label, file]) => {
    if (!file) fail('milestone-payload-input-required');
    return '\n## ' + label + '\n' + fs.readFileSync(file, 'utf8');
  }).join('\n');
  const plan = fs.readFileSync(request.planFile, 'utf8');
  const checked = roots.validatePlan(plan, contract);
  requireExplicitVerify(plan);
  return prompt + '\n## Execution boundaries\nPhysical CODE_DIR: ' + request.cwd
    + '\nOwner (parent publication only): ' + contract.owner + '\nDeclared writes: ' + JSON.stringify(checked.writes)
    + '\nDo not edit owner metadata. Write the response only to this validated TEMP result path: ' + request.resultFile
    + '\nVerification policy: ' + JSON.stringify(verificationPolicy(request, plan).seal) + inputs + '\n' + resultContract.instruction();
}
function inputSections(request) {
  const sections = [['Plan', request.planFile], ['Context', request.contextFile], ['Security', request.securityFile]];
  const research = request.researchFile || path.join(request.contextRoot, '.gsd', 'milestones', request.milestoneId,
    'slices', request.sliceId, request.sliceId + '-RESEARCH.md');
  if (fs.existsSync(research)) sections.push(['Research', research]);
  return sections;
}
function verificationPolicy(request, plan) {
  const identity = {dispatch_id:request.dispatchId,unit_type:request.unitType,milestone_id:request.milestoneId,
    slice_id:request.sliceId,task_id:request.taskId,request_sha256:api('forge-code-roots').digest(request)};
  const seal = api('forge-verify').normalizeExecutionVerification(request.execution_contract,plan,request.verification||{},{},identity);
  return {identity,seal};
}

function requireExplicitVerify(text){
  const commands=api('forge-verify').parsePlanVerify(text);
  if(!commands?.length)fail('milestone-explicit-verify-required');
  return typeof commands==='string'?[commands]:commands;
}
function criterionBindings(result,capture,unitKey,{inventory,contract}={}){
  const bindings=[];
  if(!capture?.passed||!result.must_haves_status?.length)fail('criterion-evidence-required');
  if(!inventory?.structured||inventory.diagnostics.length||!inventory.criteria.length)fail('criterion-inventory-required');
  const expected=new Map(inventory.criteria.map(c=>[c.id,c]));
  const seen=new Set();
  for(const item of result.must_haves_status){
    if(item.status!=='met'||!['truth','artifact','key_link'].includes(item.kind)||!Number.isInteger(item.index)||item.index<0)fail('criterion-unmet-or-invalid');
    const criterion_id=unitKey+':'+item.kind+':'+item.index;
    if(!expected.has(criterion_id)||item.item!==expected.get(criterion_id).text||typeof item.note!=='string')fail('criterion-foreign-or-schema-invalid');
    if(seen.has(criterion_id))fail('criterion-duplicate');seen.add(criterion_id);
    if(item.kind==='artifact'){
      if(!item.root_id)fail('artifact-root-required');
      const qualified=api('forge-code-roots').resolvePath(contract,expected.get(criterion_id).artifact_path,{legacy:contract.code_roots.length===1});
      if(qualified.root_id!==item.root_id)fail('artifact-root-mismatch');
      const envelope=capture.artifacts.find(root=>root.root_id===item.root_id);
      const rowPath=api('forge-code-roots').qualified(qualified);
      const matches=(envelope?.result.rows||[]).map((row,index)=>({row,index})).filter(x=>x.row.path===rowPath);
      if(matches.length!==1)fail('artifact-row-missing-or-ambiguous');
      bindings.push({criterion_id,root_id:item.root_id,coverage:'structural',source:{kind:'artifact',row_index:matches[0].index,property:'substantive'}});continue;
    }
    if(!item.evidence?.length)fail('criterion-observed-evidence-required');
    for(const evidence of item.evidence){
      const envelope=capture.gate.roots.find(root=>root.root_id===evidence.root_id);
      const index=envelope?.result.checks.findIndex(check=>check.command===evidence.check)??-1;
      if(index<0||!evidence.stdout_line||!envelope.result.checks[index].stdout.split(/\r?\n/).includes(evidence.stdout_line))fail('criterion-unobserved-evidence');
      bindings.push({criterion_id,root_id:evidence.root_id,coverage:'behavioral',source:{kind:'verification',check_index:index},observed_test_lines:[evidence.stdout_line],evidence_limit:'Named assertion observed in actual local verification output; no remote CI or UAT claim.'});
    }
  }
  if(seen.size!==expected.size||[...expected.keys()].some(id=>!seen.has(id)))fail('criterion-coverage-incomplete');
  return bindings;
}
// Caller supplies the exact saved output of its single canonical resolver call,
// already-held claim/gates, and real native binding. Never resolves or changes route.
function prepare({request,nativeInvocation,assertBoundary,assertAuthority,linkedEntryOptions,savedManifest,persistDeliveryReceipt,leaseRenewal}={}){
  if(typeof assertBoundary!=='function'||typeof assertAuthority!=='function')fail('live-controller-boundary-required');
  const r=structuredClone(request);
  delete r.linkedEntryBinding;
  if(r.unitType!=='execute-task'||r.scope==='standalone-task'||r.route?.worker_mode!=='native'||r.route.dispatch_allowed!==true||!r.execution_contract||!r.claim||!r.runId)fail('milestone-native-request-required');
  if(!nativeInvocation?.ok)fail('native-binding-required');
  assertBoundary();
  const side=api('forge-unit-sidecar'),execution=api('forge-task-execution'),roots=api('forge-code-roots'),verify=api('forge-verify');
  const renewal=leaseRenewal===undefined?null:leaseRenewals.get(leaseRenewal);
  if(leaseRenewal!==undefined&&(!renewal||!savedManifest||renewal.manifest_digest!==roots.digest(savedManifest)))fail('lease-renewal-capability-required');
  side.validateRecoveryRequest(r,{nativeInvocation,linkedEntryOptions});
  requestIdentity(r);
  const plan=fs.readFileSync(r.planFile,'utf8'),context=fs.readFileSync(r.contextFile);
  requireExplicitVerify(plan);
  const checked=roots.validatePlan(plan,r.execution_contract);
  const prepared=savedManifest?.prepared || {execution_contract:r.execution_contract,claims:checked.writes,
    snapshots:r.execution_contract.code_roots.map(root=>({...api('forge-surgical-reset').captureAttemptSnapshot(root.path),root_id:root.id})),
    protected_owner:execution.protectedSnapshot(r.contextRoot),
    protected_roots:r.execution_contract.code_roots.map(root=>({root_id:root.id,path:root.path,snapshot:execution.protectedSnapshot(root.path)}))};
  const planHash=hash(plan),contextHash=hash(context);
  const inputs = savedManifest?.inputs || inputSections(r).map(([label,file]) => ({label,file,sha256:hash(fs.readFileSync(file))}));
  const {identity:verificationIdentity,seal}=verificationPolicy(r,plan);
  function guard(publishing=false){
    assertAuthority();assertBoundary();side.validateRecoveryRequest(r,{nativeInvocation,linkedEntryOptions});
    if(hash(fs.readFileSync(r.planFile))!==planHash||hash(fs.readFileSync(r.contextFile))!==contextHash)fail('milestone-input-changed');
    if(inputs.some(row=>hash(fs.readFileSync(row.file))!==row.sha256))fail('milestone-input-changed');
    if(renewal)renewal.check(publishing);
    else if (!publishing) execution.assertProtected(r.contextRoot,prepared.protected_owner);
    for(const root of prepared.protected_roots)execution.assertProtected(root.path,root.snapshot);
  }
  let verified=null;
  const manifest={request:r,prepared,plan_sha256:planHash,context_sha256:contextHash,inputs,verification_seal:seal};
  if(savedManifest && roots.digest(manifest)!==roots.digest(savedManifest))fail('milestone-manifest-changed');
  const manifestFile=r.resultFile+'.manifest.json', receiptFile=r.resultFile+'.receipt.json';
  for(const file of [manifestFile,receiptFile])for(const root of [r.contextRoot,...r.execution_contract.code_roots.map(row=>row.path)])
    api('forge-xllm').validateResultFileTarget(file,root);
  const persist=record=>{
    if(typeof persistDeliveryReceipt!=='function')fail('milestone-receipt-persistence-required');
    const bytes=JSON.stringify(record), sha256=hash(bytes), file=receiptFile+'.'+sha256+'.json';
    for(const root of [r.contextRoot,...r.execution_contract.code_roots.map(row=>row.path)])api('forge-xllm').validateResultFileTarget(file,root);
    try {fs.writeFileSync(file,bytes,{flag:'wx'});}catch(error){
      if(error.code!=='EEXIST'||fs.readFileSync(file,'utf8')!==bytes)throw error;
    }
    persistDeliveryReceipt({file,sha256});
  };
  return {
    manifest(){return structuredClone(manifest);},
    start(){
      guard();
      const bytes=JSON.stringify(manifest);
      try {fs.writeFileSync(manifestFile,bytes,{flag:'wx'});}catch(error){
        if(error.code!=='EEXIST'||fs.readFileSync(manifestFile,'utf8')!==bytes)throw error;
      }
      return {manifest_file:manifestFile,manifest_sha256:hash(bytes),receipt_file:receiptFile};
    },
    returned(result){
      guard();
      if(!resultContract.validate(result).ok)fail('native-result-invalid');
      persist({kind:'milestone-native-continuation',phase:'executed',dispatch_id:r.dispatchId,
        ...(renewal?{lease_reconciliation:renewal.evidence}:{}),
        fingerprint:side.artifactFingerprint(r),recovery_identity_sha256:roots.digest(requestIdentity(r)),
        route:r.route,manifest_sha256:hash(fs.readFileSync(manifestFile)),result,
        code_state:execution.replayState(r.cwd,r.execution_contract)});
    },
    verify(result){
      guard();if(!resultContract.validate(result).ok||result.status!=='done')fail('native-result-not-done');
      const delta=execution.verifyResult(r.cwd,prepared,result),loc=side.locations(r),resourceEvents=[];
      const capture=verify.captureRootDelivery(r.execution_contract,plan,{...r.verification,unit:loc.rules[loc.delivery.input].unit,
        verificationSeal:seal,verificationIdentity,resourceEventSink:line=>resourceEvents.push(line)});
      guard();if(!capture.passed)fail('verification-failed');
      const unit=loc.rules[loc.delivery.input].unit;
      const inventory=api('forge-delivery').inventoryPlan(plan,r.planFile,unit);
      const bindings=criterionBindings(result,capture,api('forge-delivery').unitKey(unit),{inventory,contract:r.execution_contract});
      // Canonical delivery validates coverage, criterion identity and actual captures.
      const publicationRequest={...r,verification:{...(r.verification||{}),bindings}};
      const artifacts=side.executeDeliveryArtifacts(publicationRequest,loc,result,r.contextRoot,r.cwd,capture);
      const generated=artifacts.map(a=>{try{return JSON.parse(a.content);}catch{return null;}}).filter(value=>value?.generated_by==='forge-delivery');
      if(generated.length!==1||generated[0].diagnostics.length||generated[0].criteria.length!==inventory.criteria.length
          ||generated[0].criteria.some(criterion=>criterion.status!=='verificado'||criterion.pending.length))fail('canonical-delivery-not-fully-verified');
      verified={result:structuredClone(result),resultHash:roots.digest(result),capture,delta,resourceEvents,publicationRequest,artifacts};
      return structuredClone({capture,delta,resourceEvents,bindings});
    },
    publish(result){
      if(!verified||verified.resultHash!==roots.digest(result))fail('verified-result-required');
      guard();execution.verifyResult(r.cwd,prepared,result);
      for(const envelope of verified.capture.artifacts){
        const root=r.execution_contract.code_roots.find(root=>root.id===envelope.root_id);
        const live=api('forge-surgical-reset').captureAttemptSnapshot(root.path);
        if(live.start_sha!==envelope.revision||roots.digest(live.pre_dirty)!==roots.digest(envelope.workspace))fail('verified-code-changed');
      }
      const artifacts=verified.artifacts.map(a=>({...a,before:fs.existsSync(path.join(r.contextRoot,a.path))?hash(fs.readFileSync(path.join(r.contextRoot,a.path))):null}));
      const record={kind:'native-execute-task',phase:'ready',dispatch_id:r.dispatchId,result,artifacts,route:r.route,response_sha256:hash(JSON.stringify(result)),
        ...(renewal?{lease_reconciliation:renewal.evidence}:{}),
        fingerprint:side.artifactFingerprint(r),recovery_identity_sha256:roots.digest(requestIdentity(r)),
        manifest_sha256:hash(fs.readFileSync(manifestFile)),
        milestone_delivery:{plan_sha256:planHash,protected_owner:prepared.protected_owner,protected_roots:prepared.protected_roots,code_state:execution.replayState(r.cwd,r.execution_contract)}};
      persist(record);
      side.materialize(verified.publicationRequest,record,()=>guard(true),undefined,renewal?{leaseRenewal}:undefined);
      for(const artifact of artifacts)if(fs.readFileSync(path.join(r.contextRoot,artifact.path),'utf8')!==artifact.content)fail('publication-readback-mismatch');
      return record;
    },
    replayReady(record){
      guard(true);
      const loc=side.locations(r);
      if(record.kind!=='native-execute-task'||record.phase!=='ready'||!record.milestone_delivery
          ||record.response_sha256!==hash(JSON.stringify(record.result))
          ||roots.digest(record.milestone_delivery.protected_owner)!==roots.digest(prepared.protected_owner)
          ||roots.digest(record.milestone_delivery.protected_roots)!==roots.digest(prepared.protected_roots)
          ||!Array.isArray(record.artifacts)||record.artifacts.some(row=>
            Object.keys(row).sort().join(',')!=='before,content,path'||row.before!==null&&!/^[a-f0-9]{64}$/.test(row.before||''))
          ||!side.validateArtifacts({status:'done',summary:record.result.summary,questions:[],artifacts:record.artifacts.map(({path,content})=>({path,content}))},
            loc.allowed,loc.required,Infinity,loc.rules))fail('milestone-ready-receipt-invalid');
      execution.verifyResult(r.cwd,prepared,record.result);
      side.materialize(r,record,()=>guard(true),undefined,renewal?{leaseRenewal}:undefined);
      return record;
    },
  };
}
// A returned continuation may only replay under fresh host authority and a live
// stopped-writer census. It never reserves or invokes another model.
async function replay({request,recovery,runtime,nativeOptions}) {
  const roots=api('forge-code-roots'), recoveryApi=api('forge-attempt-recovery');
  let stateBytes=fs.readFileSync(recovery.stateFile);
  const state=JSON.parse(stateBytes);
  const binding=state.continuation?.delivery;
  if(!binding || !['dispatch-possible','returned'].includes(state.continuation.status))return null;
  recoveryApi.validateStateTarget(recovery.stateFile,request,request.execution_contract);
  const originalReceiptHash=hash(fs.readFileSync(recovery.receiptFile));
  if(originalReceiptHash!==binding.original_receipt_sha256)fail('milestone-replay-original-receipt-changed');
  const reservation=state.reservations.at(-1);
  if(roots.digest(reservation)!==recovery.resumeReservation?.sha256
      || state.continuation.reservation_sha256!==recovery.resumeReservation.sha256
      || state.request_identity_sha256!==roots.digest(requestIdentity(request))
      || state.pending_questions.some(q=>q.status==='pending'))fail('milestone-replay-state-binding');
  const expected=request.resultFile+'.recovery-'+recovery.resumeReservation.sha256+'.json';
  if(binding.manifest_file!==expected+'.manifest.json'||binding.receipt_file!==expected+'.receipt.json')fail('milestone-replay-path-binding');
  if(!binding.receipt)return null;
  if(!/^[a-f0-9]{64}$/.test(binding.receipt.sha256||'')
      || binding.receipt.file!==binding.receipt_file+'.'+binding.receipt.sha256+'.json')fail('milestone-replay-receipt-path');
  const savedReceiptFile=binding.receipt.file;
  for(const file of [binding.manifest_file,savedReceiptFile])recoveryApi.validateStateTarget(file,request,request.execution_contract);
  const manifestBytes=fs.readFileSync(binding.manifest_file), receiptBytes=fs.readFileSync(savedReceiptFile);
  if(hash(receiptBytes)!==binding.receipt.sha256)fail('milestone-replay-receipt-hash');
  if(hash(manifestBytes)!==binding.manifest_sha256)fail('milestone-replay-manifest-binding');
  const manifest=JSON.parse(manifestBytes), record=JSON.parse(receiptBytes), r=manifest.request;
  const expectedRequest={...request,route:r.route,recoveryStateFile:recovery.stateFile,
    dispatchId:request.dispatchId+'-recovery-'+recovery.resumeReservation.sha256,resultFile:expected};
  if(roots.digest(r)!==roots.digest(expectedRequest)||record.manifest_sha256!==binding.manifest_sha256
      || record.dispatch_id!==r.dispatchId||record.fingerprint!==api('forge-unit-sidecar').artifactFingerprint(r)
      || record.recovery_identity_sha256!==roots.digest(requestIdentity(r))
      || !resultContract.validate(record.result).ok||!['executed','ready'].includes(record.phase))fail('milestone-replay-receipt-binding');
  const invocation=api('forge-native-invocation').buildNativeInvocation(nativeOptions(r.route));
  if(!invocation.ok||roots.digest(invocation)!==state.continuation.invocation_sha256)fail('milestone-replay-invocation-binding');
  const assertAuthority=()=>{
    if(hash(fs.readFileSync(recovery.stateFile))!==hash(stateBytes)
        ||hash(fs.readFileSync(recovery.receiptFile))!==originalReceiptHash
        ||hash(fs.readFileSync(binding.manifest_file))!==binding.manifest_sha256)fail('milestone-replay-authority-changed');
    if(!runtime.recoveryAuthorization||runtime.recoveryAuthorization.reference!==state.authorization_reference)fail('milestone-replay-authorization-required');
    runtime.recoveryAuthorization.adapter.readStandingAuthorization(state.authorization_reference);
    runtime.assertBoundary();
  };
  const inspect=()=>{assertAuthority();if(hash(fs.readFileSync(savedReceiptFile))!==hash(receiptBytes))fail('milestone-replay-receipt-changed');};
  const writer=await api('forge-recovery-transition').observeStoppedWriter(runtime.writerObservationAdapter,
    {receiptFile:savedReceiptFile,request:r,contract:r.execution_contract,processProbe:runtime.processProbe,assertUnchanged:inspect});
  api('forge-recovery-transition').assertWriterObservation(writer);
  const session=prepare({request:r,nativeInvocation:invocation,assertBoundary:runtime.assertBoundary,assertAuthority,
    linkedEntryOptions:runtime.linkedEntryOptions,savedManifest:manifest,persistDeliveryReceipt:receipt=>{
      inspect();
      const lock=api('forge-lock'),lockRoot=path.join(require('os').tmpdir(),'forge-recovery-'+roots.digest(path.resolve(recovery.stateFile)));
      fs.mkdirSync(path.join(lockRoot,'.gsd'),{recursive:true});
      const held=lock.tryAcquireSync(lockRoot,'state',{allowStaleRecovery:false});
      if(!held)fail('recovery-state-busy');
      try {
        inspect();
        if(!lock.assertOwned(held))fail('recovery-state-lock-lost');
        state.continuation.delivery.receipt=receipt;
        api('forge-xllm-state').saveRecovery(recovery.stateFile,state);
        stateBytes=fs.readFileSync(recovery.stateFile);
      }finally{held.release();}
    }});
  if(record.result.status!=='done')return {action:'replay',provider_called:false,result:record.result};
  if(record.phase==='ready')return {action:'replay',provider_called:false,result:{published:session.replayReady(record)}};
  if(roots.digest(record.code_state)!==roots.digest(api('forge-task-execution').replayState(r.cwd,r.execution_contract)))fail('milestone-replay-code-changed');
  const verified=session.verify(record.result),published=session.publish(record.result);
  return {action:'replay',provider_called:false,result:{verified,published}};
}
module.exports={prepare,replay,requireExplicitVerify,criterionBindings,resultContract,packagePrompt,createLeaseRenewalReconciliation,reconcileLeaseRenewalSurface};
