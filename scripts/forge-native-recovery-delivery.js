'use strict';
// Explicit lifecycle primitives. Import is inert. No provider invocation or route override.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const api = name => require('./' + name);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=c=>{throw Object.assign(new Error(c),{code:c});};
const nonEmpty=value=>typeof value==='string'&&value.trim().length>0;
// Diagnostics identify bounded positional checks, never copy root names,
// commands, output, paths or worker-controlled error text into the exception.
function verificationFailure(capture) {
  const rows=[], limit=32;
  const add=row=>{if(rows.length<limit)rows.push(row);};
  const gates=Array.isArray(capture?.gate?.roots)?capture.gate.roots:[];
  const artifacts=Array.isArray(capture?.artifacts)?capture.artifacts:[];
  let truncated=gates.length>16||artifacts.length>16;
  gates.slice(0,16).forEach((envelope,root_index)=>{
    const result=envelope?.result,checks=Array.isArray(result?.checks)?result.checks:[];
    if(result?.skipped||!checks.length)add({category:'root-unverified',root_index});
    else {
      truncated ||= checks.length>32;
      checks.slice(0,32).forEach((check,check_index)=>{
        if(check?.exitCode!==0)add({category:'command-failed',root_index,check_index,
          exit_code:Number.isSafeInteger(check?.exitCode)?check.exitCode:null});
      });
      if(result?.passed!==true&&!checks.slice(0,32).some(check=>check?.exitCode!==0))add({category:'root-failed',root_index});
    }
  });
  artifacts.slice(0,16).forEach((envelope,root_index)=>{
    const result=envelope?.result;
    if(result?.passed!==true)add({category:Array.isArray(result?.missing)&&result.missing.length?'expected-output-missing':'artifact-failed',root_index});
  });
  // The list is a bounded sample, not a claim of complete failure enumeration.
  if(rows.length===limit)truncated=true;
  const error=Object.assign(new Error('verification-failed'),{code:'verification-failed',
    diagnostic:{schema_version:1,stage:'verification',failures:rows.length?rows:[{category:'capture-failed'}],truncated}});
  throw error;
}
// Match sidecar validation defaults without rewriting durable request/manifest bytes.
const requestIdentity=request=>{
  const recovery=api('forge-attempt-recovery');
  return recovery.requestIdentity(recovery.canonicalRequest(request));
};
const leaseRenewals=new WeakMap();
const documentaryContinuations=new WeakMap();
// Creates authority, never deserializes it. The new preparation owns its claim
// and protected metadata; the old manifest and executed partial remain evidence.
function createDocumentaryContinuation({originalManifestFile,originalResultFile,originalReceiptFile,
  request,documents,attestReview,attestStoppedWriter,assertAuthority,continuationManifestFile}={}) {
  if(typeof attestReview!=='function'||typeof attestStoppedWriter!=='function'||typeof assertAuthority!=='function')fail('documentary-live-authority-required');
  const roots=api('forge-code-roots'), reset=api('forge-surgical-reset');
  const files=[originalManifestFile,originalResultFile,originalReceiptFile];
  const bytes=files.map(file=>fs.readFileSync(file)), original=JSON.parse(bytes[0]), result=JSON.parse(bytes[1]), receipt=JSON.parse(bytes[2]);
  if(!resultContract.validate(result).ok||result.status!=='partial'||receipt.phase!=='executed'
    ||receipt.manifest_sha256!==hash(bytes[0])||roots.digest(receipt.result)!==roots.digest(result)
    ||receipt.dispatch_id!==original.request.dispatchId)fail('documentary-original-binding');
  if(request.dispatchId===original.request.dispatchId||request.resultFile===original.request.resultFile
    ||roots.digest(request.execution_contract)!==roots.digest(original.request.execution_contract)
    ||hash(fs.readFileSync(request.planFile))!==original.plan_sha256
    ||request.milestoneId!==original.request.milestoneId||request.sliceId!==original.request.sliceId
    ||request.taskId!==original.request.taskId)fail('documentary-continuation-identity');
  const plan=fs.readFileSync(request.planFile,'utf8'), loc=api('forge-unit-sidecar').locations(request);
  const inventory=api('forge-delivery').inventoryPlan(plan,request.planFile,loc.rules[loc.delivery.input].unit);
  const writes=roots.validatePlan(plan,request.execution_contract).writes;
  if(!Array.isArray(documents)||documents.length!==writes.length)fail('documentary-documents-required');
  const preserved=documents.map(doc=>{
    const qualified=roots.resolvePath(request.execution_contract,doc.path,{legacy:request.execution_contract.code_roots.length===1});
    if(!writes.some(row=>row.root_id===qualified.root_id&&row.path===qualified.path))fail('documentary-document-unclaimed');
    const content=fs.readFileSync(doc.file);
    if(hash(content)!==doc.sha256)fail('documentary-document-hash');
    const state=receipt.code_state?.find(row=>row.root_id===qualified.root_id);
    const dirty=state?.pre_dirty?.find(row=>row.path===qualified.path);
    const vcsHash=state?.vcs==='svn'?hash(content):crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+content.length+'\0'),content])).digest('hex');
    if(!dirty||dirty.hash!==vcsHash)fail('documentary-returned-bytes-mismatch');
    return {...qualified,path:roots.qualified(qualified),file:doc.file,sha256:doc.sha256,content};
  });
  if(new Set(preserved.map(row=>row.path)).size!==writes.length)fail('documentary-documents-duplicate');
  const review=attestReview({plan,inventory:structuredClone(inventory),documents:preserved.map(({content,...row})=>row)});
  if(!review||!review.reviewer||!review.producer||review.reviewer===review.producer||!review.reference
    ||!Array.isArray(review.criteria)||review.pending_questions?.length)fail('documentary-independent-review-required');
  const required=inventory.criteria.filter(row=>row.origin!=='artifact');
  if(new Set(review.criteria.map(row=>row.criterion_id)).size!==required.length
    ||new Set(review.criteria.map(row=>row.criterion_id+'::'+row.root_id)).size!==review.criteria.length
    ||required.some(c=>!review.criteria.some(row=>row.criterion_id===c.id)))fail('documentary-review-coverage');
  for(const row of review.criteria){
    const criterion=required.find(c=>c.id===row.criterion_id);
    if(!criterion||row.text!==criterion.text||row.eligibility!=='documentary'||row.status!=='met'
      ||!nonEmpty(row.rationale)||!nonEmpty(row.evidence)||!Array.isArray(row.documents)||!row.documents.length
      ||row.documents.some(doc=>!preserved.some(p=>p.path===doc.path&&p.sha256===doc.sha256&&p.root_id===row.root_id)))fail('documentary-review-criterion');
  }
  // Reconciliation proof is the actual restored pre-write tree, not an imported
  // reset-success flag. Metadata may legitimately change between attempts.
  const assertReconciled=()=>{for(const snapshot of original.prepared.snapshots){
    const root=request.execution_contract.code_roots.find(row=>row.id===snapshot.root_id);
    const live=reset.captureAttemptSnapshot(root.path);
    if(live.start_sha!==snapshot.start_sha||roots.digest(live.pre_dirty)!==roots.digest(snapshot.pre_dirty))fail('documentary-original-not-reconciled');
  }};
  const evidence={schema_version:1,original_manifest_sha256:hash(bytes[0]),original_result_sha256:hash(bytes[1]),
    original_receipt_sha256:hash(bytes[2]),review_reference:review.reference,reviewer:review.reviewer,
    producer:review.producer,criteria:structuredClone(review.criteria)};
  evidence.fingerprint=api('forge-delivery').fingerprint(evidence);
  const resumedBytes=continuationManifestFile?fs.readFileSync(continuationManifestFile):null;
  const resumed=resumedBytes?JSON.parse(resumedBytes):null;
  if(resumed&&(path.resolve(continuationManifestFile)!==path.resolve(request.resultFile+'.manifest.json')
    ||roots.digest(resumed.request)!==roots.digest(request)
    ||roots.digest(resumed.documentary_continuation)!==roots.digest(evidence)
    ||roots.digest(resumed.prepared.snapshots)!==roots.digest(original.prepared.snapshots)))fail('documentary-resume-binding');
  const assertRestored=()=>{
    for(const snapshot of original.prepared.snapshots){
      const root=request.execution_contract.code_roots.find(row=>row.id===snapshot.root_id);
      const live=reset.captureAttemptSnapshot(root.path);
      const expected=new Map(snapshot.pre_dirty.map(row=>[row.path,row.hash]));
      for(const doc of preserved.filter(row=>row.root_id===root.id)){
        const q=roots.resolvePath(request.execution_contract,doc.path);
        if(hash(fs.readFileSync(q.absolute))!==doc.sha256)fail('documentary-reviewed-bytes-changed');
        const state=receipt.code_state.find(row=>row.root_id===root.id);
        expected.set(q.path,state.pre_dirty.find(row=>row.path===q.path).hash);
      }
      if(live.start_sha!==snapshot.start_sha||roots.digest([...expected].sort())!==roots.digest(live.pre_dirty.map(row=>[row.path,row.hash]).sort()))fail('documentary-restored-tree-changed');
    }
  };
  if(resumed)assertRestored();else assertReconciled();
  const derived=structuredClone(result);derived.status='done';
  for(const item of derived.must_haves_status){
    if(item.kind==='artifact'){if(item.status!=='met')fail('documentary-artifact-not-met');continue;}
    const row=review.criteria.find(row=>row.criterion_id===api('forge-delivery').unitKey(loc.rules[loc.delivery.input].unit)+':'+item.kind+':'+item.index);
    if(!row||item.status==='unmet')fail('documentary-negative-result');
    item.status='met';item.note=row.evidence;item.evidence=[];
  }
  const check=()=>{
    assertAuthority();if(attestStoppedWriter()!==true)fail('documentary-writer-not-stopped');
    if(files.some((file,index)=>hash(fs.readFileSync(file))!==hash(bytes[index]))
      ||preserved.some(doc=>hash(fs.readFileSync(doc.file))!==doc.sha256)
      ||resumedBytes&&hash(fs.readFileSync(continuationManifestFile))!==hash(resumedBytes))fail('documentary-original-changed');
  };
  check();const handle=Object.freeze({});
  documentaryContinuations.set(handle,{request_digest:roots.digest(request),evidence,derived,preserved,check,assertReconciled,assertRestored,
    resumed_manifest_digest:resumed?roots.digest(resumed):null});return handle;
}
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
function packagePrompt(request, prompt, options = {}) {
  const roots = api('forge-code-roots');
  const contract = roots.validateContract(request.execution_contract, { owner: request.contextRoot, revalidate: true });
  for (const root of [contract.owner, ...contract.code_roots.map(row => row.path)])
    api('forge-xllm').validateResultFileTarget(request.resultFile, root);
  const standalone = request.scope === 'standalone-task';
  const execution = standalone ? api('forge-task-execution').prepare({ ...request, nativeInvocation: options.nativeInvocation }, request.contextRoot || request.cwd, request.cwd) : null;
  const sections = standalone ? [] : inputSections(request);
  const inputs = sections.map(([label, file]) => {
    if (!file) fail('milestone-payload-input-required');
    return '\n## ' + label + '\n' + fs.readFileSync(file, 'utf8');
  }).join('\n');
  const plan = fs.readFileSync(request.planFile, 'utf8');
  const checked = roots.validatePlan(plan, contract);
  requireExplicitVerify(plan,request);
  if (execution) {
    const procedure = api('forge-procedure-context').loadProcedureContext({ cwd: request.cwd,
      phase: 'execute-loose-task', forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
    prompt = api('forge-xllm').buildExecutePrompt(plan, { capability: api('forge-must-haves').resolveCapability(plan).capability,
      constraints: request.constraints, securityText: execution.securityText, contextText: execution.contextText,
      procedure, outputChannel: 'json-only' });
    const recovery = api('forge-procedure-context').loadProcedureContext({ cwd: request.cwd,
      phase: 'recovery', forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
    const present = new Set(procedure.modules.map(row => row.id));
    prompt += '\n\n' + recovery.content.split(/(?=<!-- forge-procedure:)/)
      .filter(segment => segment.trim() && !present.has(/^<!-- forge-procedure:([^>]+) -->/.exec(segment)?.[1])).join('');
  }
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

function requireExplicitVerify(text,request){
  const commands=api('forge-verify').parsePlanVerify(text);
  if(!commands?.length){
    const declared=request?.verification;
    if(declared&&(declared.preferenceCommands?.length||Object.values(declared.commandsByRoot||{}).some(list=>list?.length))){verificationPolicy(request,text);return declared;}
    fail('milestone-explicit-verify-required');
  }
  return typeof commands==='string'?[commands]:commands;
}
function criterionBindings(result,capture,unitKey,{inventory,contract,documentary,coveragePolicy}={}){
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
    const policy=coveragePolicy?.criteria.find(row=>row.criterion_id===criterion_id);
    const reviewed=documentary?.criteria.filter(row=>row.criterion_id===criterion_id);
    if(reviewed?.length){for(const row of reviewed)bindings.push({criterion_id,root_id:row.root_id,coverage:'documentary',source:{kind:'artifact',property:'documentary'}});
      if(!policy||!policy.requirements.some(row=>row.coverage==='behavioral'))continue;}
    if(!item.evidence?.length)fail('criterion-observed-evidence-required');
    for(const evidence of item.evidence){
      const envelope=capture.gate.roots.find(root=>root.root_id===evidence.root_id);
      const index=envelope?.result.checks.findIndex(check=>check.command===evidence.check)??-1;
      if(index<0||!evidence.stdout_line||!envelope.result.checks[index].stdout.split(/\r?\n/).includes(evidence.stdout_line))fail('criterion-unobserved-evidence');
      bindings.push({criterion_id,root_id:evidence.root_id,coverage:'behavioral',source:{kind:'verification',check_index:index},observed_test_lines:[evidence.stdout_line],evidence_limit:'Named assertion observed in actual local verification output; no remote CI or UAT claim.'});
    }
  }
  if(seen.size!==expected.size||[...expected.keys()].some(id=>!seen.has(id)))fail('criterion-coverage-incomplete');
  for(const policy of coveragePolicy?.criteria||[]){
    const rows=bindings.filter(row=>row.criterion_id===policy.criterion_id);
    for(const requirement of policy.requirements){
      if(!rows.some(row=>row.root_id===requirement.root_id&&row.coverage===requirement.coverage))fail('criterion-required-coverage-missing');
    }
    for(const row of rows)row.required_coverages=structuredClone(policy.requirements);
  }
  return bindings;
}
function readDocumentarySource(source,contract,budget){
  const file=source.external===true?source.path:api('forge-code-roots').resolvePath(contract,source.path,{legacy:contract.code_roots.length===1}).absolute;
  const checked=api('forge-empirical-sources').checkedPath(file);
  const read=api('forge-autonomy-sources').readBoundedStableFile(checked,1048576,{expectedReal:checked});
  if(read.error)fail('documentary-source-'+read.error);
  if(!budget.paths.has(checked)){budget.paths.add(checked);budget.bytes+=read.buffer.length;}
  if(budget.bytes>8388608)fail('documentary-sources-total-bytes');
  const sha256=hash(read.buffer);
  if(source.external===true&&source.sha256!==sha256)fail('documentary-source-hash-changed');
  return {...source,sha256};
}
function validateCoveragePolicy(policy,inventory,contract){
  if(policy===undefined)return null;
  const roots=api('forge-code-roots');
  if(!policy||policy.schema_version!==1||!Array.isArray(policy.criteria)||!policy.criteria.length
    ||policy.criteria.length>inventory.criteria.length)fail('documentary-policy-invalid');
  const seen=new Set();
  const budget={paths:new Set(),bytes:0};
  for(const row of policy.criteria){
    const criterion=inventory.criteria.find(c=>c.id===row.criterion_id&&c.origin!=='artifact');
    if(!criterion||criterion.aspects.length!==1||!['default','declared-link'].includes(criterion.aspects[0])||seen.has(row.criterion_id)||row.text!==criterion.text||!Array.isArray(row.requirements)
      ||!row.requirements.length||row.requirements.length>64||!Array.isArray(row.sources)||!row.sources.length||row.sources.length>64)fail('documentary-policy-invalid');
    seen.add(row.criterion_id);
    const keys=new Set();
    for(const req of row.requirements){
      const key=JSON.stringify([req.aspect,req.root_id,req.coverage]);
      if(Object.keys(req).sort().join(',')!=='aspect,coverage,root_id'||!criterion.aspects.includes(req.aspect)
        ||!contract.code_roots.some(r=>r.id===req.root_id)||!['behavioral','documentary'].includes(req.coverage)||keys.has(key))fail('documentary-policy-invalid');
      keys.add(key);
    }
    if(!row.requirements.some(req=>req.coverage==='documentary'))fail('documentary-policy-invalid');
    for(const source of row.sources){
      if(!contract.code_roots.some(r=>r.id===source.root_id)||typeof source.path!=='string')fail('documentary-policy-source-invalid');
      // Explicit external read-only sources are sealed as paths, never added to writes.
      if(source.external===true){
        if(!path.isAbsolute(source.path)||!/^[a-f0-9]{64}$/.test(source.sha256||''))fail('documentary-policy-source-invalid');
        readDocumentarySource(source,contract,budget);
      }
      else if(roots.resolvePath(contract,source.path,{legacy:contract.code_roots.length===1}).root_id!==source.root_id)fail('documentary-policy-source-invalid');
    }
  }
  return structuredClone(policy);
}
// Caller supplies the exact saved output of its single canonical resolver call,
// already-held claim/gates, and real native binding. Never resolves or changes route.
function prepare({request,nativeInvocation,assertBoundary,assertAuthority,linkedEntryOptions,savedManifest,persistDeliveryReceipt,leaseRenewal,documentaryContinuation,coveragePolicy}={}){
  if(typeof assertBoundary!=='function'||typeof assertAuthority!=='function')fail('live-controller-boundary-required');
  const r=structuredClone(request);
  delete r.linkedEntryBinding;
  const effectiveIdentity=api('forge-attempt-recovery').canonicalRequest(r);
  if(r.unitType!=='execute-task'||!['milestone','standalone-task'].includes(effectiveIdentity.scope)||effectiveIdentity.phase!=='execute'||r.route?.worker_mode!=='native'||r.route.dispatch_allowed!==true||!r.execution_contract||!r.claim||!r.runId)fail('milestone-native-request-required');
  if(!nativeInvocation?.ok)fail('native-binding-required');
  assertBoundary();
  const side=api('forge-unit-sidecar'),execution=api('forge-task-execution'),roots=api('forge-code-roots'),verify=api('forge-verify');
  const documentary=documentaryContinuation===undefined?null:documentaryContinuations.get(documentaryContinuation);
  if(documentaryContinuation!==undefined&&(!documentary||documentary.request_digest!==roots.digest(request)
    ||(savedManifest?documentary.resumed_manifest_digest!==roots.digest(savedManifest):documentary.resumed_manifest_digest!==null)))fail('documentary-capability-required');
  if(documentary){if(savedManifest)documentary.assertRestored();else documentary.assertReconciled();}
  const renewal=leaseRenewal===undefined?null:leaseRenewals.get(leaseRenewal);
  if(leaseRenewal!==undefined&&(!renewal||!savedManifest||renewal.manifest_digest!==roots.digest(savedManifest)))fail('lease-renewal-capability-required');
  side.validateRecoveryRequest(r,{nativeInvocation,linkedEntryOptions});
  requestIdentity(r);
  const plan=fs.readFileSync(r.planFile,'utf8'),context=fs.readFileSync(r.contextFile);
  requireExplicitVerify(plan,r);
  const checked=roots.validatePlan(plan,r.execution_contract);
  const standalone=r.scope==='standalone-task';
  const taskPreparation=standalone?execution.prepare({...r,nativeInvocation},r.contextRoot || r.cwd,r.cwd):null;
  const prepared=savedManifest?.prepared || {execution_contract:r.execution_contract,claims:checked.writes,
    snapshots:taskPreparation?.snapshots || r.execution_contract.code_roots.map(root=>({...api('forge-surgical-reset').captureAttemptSnapshot(root.path),root_id:root.id})),
    protected_owner:execution.protectedSnapshot(r.contextRoot),
    protected_roots:r.execution_contract.code_roots.map(root=>({root_id:root.id,path:root.path,snapshot:execution.protectedSnapshot(root.path)}))};
  const planHash=hash(plan),contextHash=hash(context);
  const inputs = savedManifest?.inputs || (taskPreparation ? Object.keys(taskPreparation.inputs).map(file=>['Task input',file]) : inputSections(r)).map(([label,file]) => ({label,file,sha256:hash(fs.readFileSync(file))}));
  const {identity:verificationIdentity,seal}=verificationPolicy(r,plan);
  const loc=side.locations(r),inventory=api('forge-delivery').inventoryPlan(plan,r.planFile,loc.rules[loc.delivery.input].unit);
  const policy=validateCoveragePolicy(coveragePolicy===undefined?savedManifest?.coverage_policy:coveragePolicy,inventory,r.execution_contract);
  if(policy&&documentary)fail('documentary-policy-continuation-conflict');
  let initialReview=null;
  function guard(publishing=false){
    if(policy&&fs.existsSync(manifestFile)&&roots.digest(JSON.parse(fs.readFileSync(manifestFile,'utf8')))!==roots.digest(manifest))fail('documentary-manifest-changed');
    if(documentary)documentary.check();
    if(initialReview)initialReview.check();
    assertAuthority();assertBoundary();side.validateRecoveryRequest(r,{nativeInvocation,linkedEntryOptions});
    if(hash(fs.readFileSync(r.planFile))!==planHash||hash(fs.readFileSync(r.contextFile))!==contextHash)fail('milestone-input-changed');
    if(inputs.some(row=>hash(fs.readFileSync(row.file))!==row.sha256))fail('milestone-input-changed');
    if(renewal)renewal.check(publishing);
    else if (!publishing) execution.assertProtected(r.contextRoot,prepared.protected_owner);
    for(const root of prepared.protected_roots)execution.assertProtected(root.path,root.snapshot);
  }
  let verified=null;
  const manifest={request:r,prepared,plan_sha256:planHash,context_sha256:contextHash,inputs,verification_seal:seal};
  if(documentary)manifest.documentary_continuation=documentary.evidence;
  if(policy)manifest.coverage_policy=policy;
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
    reviewDocumentary({returnedReceiptFile,attestReview,attestStoppedWriter}={}){
      guard(true);
      if(!policy||typeof attestReview!=='function'||typeof attestStoppedWriter!=='function')fail('documentary-live-authority-required');
      const originalBytes=fs.readFileSync(returnedReceiptFile),record=JSON.parse(originalBytes);
      if(path.resolve(returnedReceiptFile)!==path.resolve(receiptFile+'.'+hash(originalBytes)+'.json')
        ||record.kind!==(standalone?'standalone-native-continuation':'milestone-native-continuation')||record.phase!=='executed'||record.dispatch_id!==r.dispatchId||record.manifest_sha256!==hash(fs.readFileSync(manifestFile))
        ||record.fingerprint!==side.artifactFingerprint(r)||record.recovery_identity_sha256!==roots.digest(requestIdentity(r))
        ||!resultContract.validate(record.result).ok||!['done','partial'].includes(record.result.status))fail('documentary-returned-binding');
      const readSources=()=>{const budget={paths:new Set(),bytes:0};return policy.criteria.flatMap(row=>row.sources.map(source=>readDocumentarySource(source,r.execution_contract,budget)));};
      const sources=readSources();
      const check=()=>{
        assertAuthority();if(attestStoppedWriter()!==true)fail('documentary-writer-not-stopped');
        if(hash(fs.readFileSync(returnedReceiptFile))!==hash(originalBytes)
          ||roots.digest(execution.replayState(r.cwd,r.execution_contract))!==roots.digest(record.code_state)
          ||roots.digest(readSources())!==roots.digest(sources))fail('documentary-returned-state-changed');
      };
      check();
      const review=attestReview({manifest:structuredClone(manifest),result:structuredClone(record.result),policy:structuredClone(policy),sources:structuredClone(sources)});
      if(!review?.reference||!review.reviewer||!review.producer||review.reviewer===review.producer||review.pending_questions?.length
        ||!Array.isArray(review.criteria))fail('documentary-independent-review-required');
      const expected=policy.criteria.flatMap(row=>row.requirements.filter(req=>req.coverage==='documentary').map(req=>({row,req})));
      if(review.criteria.length!==expected.length)fail('documentary-review-coverage');
      for(const {row,req} of expected){
        const matches=review.criteria.filter(c=>c.criterion_id===row.criterion_id&&c.root_id===req.root_id);
        if(matches.length!==1)fail('documentary-review-coverage');
        const c=matches[0];
        if(c.text!==row.text||c.status!=='met'||c.eligibility!=='documentary'||!nonEmpty(c.rationale)||!nonEmpty(c.evidence)
          ||!Array.isArray(c.documents)||!c.documents.length||c.documents.some(doc=>!row.sources.some(s=>s.path===doc.path&&s.root_id===req.root_id)
            ||!sources.some(s=>s.path===doc.path&&s.root_id===req.root_id&&s.sha256===doc.sha256)))fail('documentary-review-criterion');
      }
      const derived=structuredClone(record.result);
      for(const item of derived.must_haves_status){
        if(item.status==='unmet')fail('documentary-negative-result');
        const id=api('forge-delivery').unitKey(loc.rules[loc.delivery.input].unit)+':'+item.kind+':'+item.index;
        if(item.status!=='met'){if(!policy.criteria.some(row=>row.criterion_id===id))fail('documentary-unreviewed-result');item.status='met';}
      }
      derived.status='done';
      const evidence={schema_version:1,original_manifest_sha256:record.manifest_sha256,original_result_sha256:hash(JSON.stringify(record.result)),
        original_receipt_sha256:hash(originalBytes),review_reference:review.reference,reviewer:review.reviewer,producer:review.producer,criteria:structuredClone(review.criteria)};
      evidence.fingerprint=api('forge-delivery').fingerprint(evidence);
      check();initialReview={check,evidence,derived};
      const reviewFile=r.resultFile+'.documentary-review.'+evidence.fingerprint+'.json',bytes=JSON.stringify({evidence,derived,returned_receipt:returnedReceiptFile});
      for(const root of [r.contextRoot,...r.execution_contract.code_roots.map(row=>row.path)])api('forge-xllm').validateResultFileTarget(reviewFile,root);
      try{fs.writeFileSync(reviewFile,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||fs.readFileSync(reviewFile,'utf8')!==bytes)throw error;}
      return {result:structuredClone(derived),review_file:reviewFile,provider_called:false};
    },
    restoreDocumentary(){
      if(!documentary)fail('documentary-capability-required');guard();
      if(!fs.existsSync(manifestFile))fail('documentary-manifest-required');
      if(savedManifest){documentary.assertRestored();return structuredClone(documentary.derived);}
      documentary.assertReconciled();
      for(const doc of documentary.preserved){
        const resolved=roots.resolvePath(r.execution_contract,doc.path);
        const root=r.execution_contract.code_roots.find(row=>row.id===resolved.root_id);
        const target=path.join(root.path,resolved.path);
        fs.mkdirSync(path.dirname(target),{recursive:true});
        roots.resolvePath(r.execution_contract,doc.path);
        fs.writeFileSync(target,doc.content);
      }
      guard();return structuredClone(documentary.derived);
    },
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
      persist({kind:standalone?'standalone-native-continuation':'milestone-native-continuation',phase:'executed',dispatch_id:r.dispatchId,
        ...(renewal?{lease_reconciliation:renewal.evidence}:{}),
        fingerprint:side.artifactFingerprint(r),recovery_identity_sha256:roots.digest(requestIdentity(r)),
        route:r.route,manifest_sha256:hash(fs.readFileSync(manifestFile)),result,
        code_state:execution.replayState(r.cwd,r.execution_contract)});
    },
    verify(result){
      guard();if(!resultContract.validate(result).ok||result.status!=='done')fail('native-result-not-done');
      if(policy&&(!initialReview||roots.digest(result)!==roots.digest(initialReview.derived)))fail('documentary-review-required');
      if(documentary&&roots.digest(result)!==roots.digest(documentary.derived))fail('documentary-result-changed');
      const delta=execution.verifyResult(r.cwd,prepared,result),loc=side.locations(r),resourceEvents=[];
      const capture=verify.captureRootDelivery(r.execution_contract,plan,{...r.verification,unit:loc.rules[loc.delivery.input].unit,
        verificationSeal:seal,verificationIdentity,resourceEventSink:line=>resourceEvents.push(line)});
      guard();if(!capture.passed)verificationFailure(capture);
      if(documentary||initialReview){
        if(documentary){
        for(const doc of documentary.preserved){const q=roots.resolvePath(r.execution_contract,doc.path);const root=r.execution_contract.code_roots.find(row=>row.id===q.root_id);
          if(hash(fs.readFileSync(path.join(root.path,q.path)))!==doc.sha256)fail('documentary-reviewed-bytes-changed');}
        }
        for(const envelope of capture.artifacts)envelope.documentary=structuredClone((documentary||initialReview).evidence);
      }
      const unit=loc.rules[loc.delivery.input].unit;
      const inventory=api('forge-delivery').inventoryPlan(plan,r.planFile,unit);
      const bindings=criterionBindings(result,capture,api('forge-delivery').unitKey(unit),{inventory,contract:r.execution_contract,documentary:(documentary||initialReview)?.evidence,coveragePolicy:policy});
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
        // Legacy carrier name retained; task identity remains explicitly standalone.
        milestone_delivery:{...(standalone?{scope:'standalone-task'}:{}),plan_sha256:planHash,protected_owner:prepared.protected_owner,protected_roots:prepared.protected_roots,code_state:execution.replayState(r.cwd,r.execution_contract)}};
      persist(record);
      side.materialize(verified.publicationRequest,record,()=>guard(true),undefined,renewal?{leaseRenewal}:undefined);
      for(const artifact of artifacts)if(fs.readFileSync(path.join(r.contextRoot,artifact.path),'utf8')!==artifact.content)fail('publication-readback-mismatch');
      return record;
    },
    replayReady(record){
      guard(true);
      const loc=side.locations(r);
      if(policy&&!initialReview)fail('documentary-review-required');
      if(documentary||initialReview){
        if(documentary)documentary.assertRestored();
        const reviewed=documentary||initialReview;
        if(roots.digest(record.result)!==roots.digest(reviewed.derived)
          ||record.manifest_sha256!==hash(fs.readFileSync(manifestFile)))fail('documentary-ready-binding');
        // Recompose the canonical saved captures without running commands again.
        // A ready record is historical evidence, not a new live capability.
        const envelopes=loc.delivery.rootSources.map(source=>{
          const matches=record.artifacts?.filter(row=>row.path===source.path);
          if(matches?.length!==1)fail('documentary-ready-capture-missing');
          const envelope=JSON.parse(matches[0].content);
          if(envelope.kind!==source.kind||envelope.root_id!==source.root_id
            ||source.kind==='artifact'&&roots.digest(envelope.documentary)!==roots.digest(reviewed.evidence))fail('documentary-ready-capture-changed');
          return envelope;
        });
        const captured={passed:true,gate:{roots:envelopes.filter(row=>row.kind==='verification')},artifacts:envelopes.filter(row=>row.kind==='artifact')};
        const unit=loc.rules[loc.delivery.input].unit;
        const inventory=api('forge-delivery').inventoryPlan(plan,r.planFile,unit);
        const bindings=criterionBindings(record.result,captured,api('forge-delivery').unitKey(unit),{inventory,contract:r.execution_contract,documentary:reviewed.evidence,coveragePolicy:policy});
        const recomposed=side.executeDeliveryArtifacts({...r,verification:{...r.verification,bindings}},loc,record.result,r.contextRoot,r.cwd,captured);
        if(roots.digest(record.artifacts.map(({path,content})=>({path,content})))!==roots.digest(recomposed))fail('documentary-ready-artifacts-changed');
      }
      if(record.kind!=='native-execute-task'||record.phase!=='ready'||!record.milestone_delivery
          ||standalone&&record.milestone_delivery.scope!=='standalone-task'
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
    dispatchId:api('forge-recovery-dispatch-id').recoveryDispatchId(request.dispatchId,recovery.resumeReservation.sha256),resultFile:expected};
  if(roots.digest(r)!==roots.digest(expectedRequest)||record.manifest_sha256!==binding.manifest_sha256
      || record.dispatch_id!==r.dispatchId||record.fingerprint!==api('forge-unit-sidecar').artifactFingerprint(r)
      || record.recovery_identity_sha256!==roots.digest(requestIdentity(r))
      || !resultContract.validate(record.result).ok||!['executed','ready'].includes(record.phase))fail('milestone-replay-receipt-binding');
  const replayOptions=nativeOptions(r.route,{fileBacked:state.continuation.packaging_reason==='uninvoked-native-file-repackage'});
  replayOptions.assertReplay?.();
  const invocation=api('forge-native-invocation').buildNativeInvocation(replayOptions);
  if(!invocation.ok||roots.digest(invocation)!==state.continuation.invocation_sha256)fail('milestone-replay-invocation-binding');
  const assertAuthority=()=>{
    replayOptions.assertReplay?.();
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
module.exports={prepare,replay,requireExplicitVerify,criterionBindings,resultContract,packagePrompt,createLeaseRenewalReconciliation,reconcileLeaseRenewalSurface,createDocumentaryContinuation};
