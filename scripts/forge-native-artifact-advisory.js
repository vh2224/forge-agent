'use strict';
// Narrow semantic disposition for a helper's intentional callback initializer.
// Imported reports are evidence, never authority. Only live owner/review adapters
// can issue an opaque capability; the original source and flags stay unchanged.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),Module=require('module');
const roots=require('./forge-code-roots'),execution=require('./forge-task-execution');
const side=require('./forge-unit-sidecar'),delivery=require('./forge-delivery');
const records=new WeakMap(),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const INSPECT=Symbol('read-only-review-input');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=x=>typeof x==='string'&&x.trim().length>0;
// Lazy call avoids a module-initialization cycle and shares the exact legacy
// summary/TAP rejection policy with direct-execution advisory bindings.
const generic=line=>require('./forge-native-recovery-delivery').isGlobalEvidenceLine(line);
function create({request,returnedReceiptFile,captureFile,assertAuthority,attestStoppedWriter,attestCapture,attestReview,attestGeneration}={},mode){
  if([assertAuthority,attestStoppedWriter,attestCapture,attestReview].some(fn=>typeof fn!=='function'))fail('artifact-advisory-live-authority-required');
  request=structuredClone(request);
  if(request.scope!=='milestone'||request.unitType!=='execute-task'||request.linked_begin_key)fail('artifact-advisory-scope-unsupported');
  const manifestFile=request.resultFile+'.manifest.json';
  const read=(file,max)=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)fail('artifact-advisory-file-invalid');const result=require('./forge-autonomy-sources').readBoundedStableFile(file,max,{expectedReal:fs.realpathSync.native(file)});if(result.error)fail('artifact-advisory-file-unstable');return result.buffer;};
  const manifestBytes=read(manifestFile,8388608),manifest=JSON.parse(manifestBytes),receiptBytes=read(returnedReceiptFile,8388608),receipt=JSON.parse(receiptBytes);
  if(roots.digest(manifest.request)!==roots.digest(request)||receipt.kind!=='milestone-native-continuation'||receipt.phase!=='executed'||receipt.result?.status!=='done'
    ||receipt.dispatch_id!==request.dispatchId||receipt.manifest_sha256!==hash(manifestBytes)||receipt.fingerprint!==side.artifactFingerprint(request)
    ||receipt.recovery_identity_sha256!==roots.digest(require('./forge-attempt-recovery').requestIdentity(require('./forge-attempt-recovery').canonicalRequest(request)))
    ||path.resolve(returnedReceiptFile)!==path.resolve(request.resultFile+'.receipt.json.'+hash(receiptBytes)+'.json'))fail('artifact-advisory-returned-binding');
  const captureBytes=read(captureFile,16777216),captured=JSON.parse(captureBytes),capture=captured.capture;
  if(path.resolve(captureFile)!==path.resolve(path.dirname(request.resultFile),'forge-verification-'+hash(captureBytes)+'.json')
    ||captured.kind!=='native-verification-capture'||captured.dispatch_id!==request.dispatchId||captured.manifest_sha256!==hash(manifestBytes)
    ||captured.result_sha256!==hash(JSON.stringify(receipt.result))||capture?.passed!==true)fail('artifact-advisory-capture-binding');
  for(const file of [captureFile,returnedReceiptFile])for(const root of [request.contextRoot,...request.execution_contract.code_roots.map(r=>r.path)])require('./forge-xllm').validateResultFileTarget(file,root);
  const watched=new Map(),sourceCache=new Map(),generationChecks=[];let sourceBytes=0;
  const source=qualified=>{
    const q=roots.resolvePath(request.execution_contract,qualified,{legacy:request.execution_contract.code_roots.length===1}),root=request.execution_contract.code_roots.find(r=>r.id===q.root_id),file=path.resolve(root.path,q.path);
    if(sourceCache.has(file))return sourceCache.get(file);
    if(roots.key(fs.realpathSync.native(file))!==roots.key(file))fail('artifact-advisory-source-link');
    const bytes=read(file,1048576),sha256=hash(bytes);sourceBytes+=bytes.length;if(watched.size>=32||sourceBytes>8388608)fail('artifact-advisory-source-budget');watched.set(file,sha256);const result={q,file,bytes,text:bytes.toString('utf8'),sha256};sourceCache.set(file,result);return result;
  };
  const loc=side.locations(request),unit=loc.rules[loc.delivery.input].unit,plan=read(request.planFile,1048576);
  const inventory=delivery.inventoryPlan(plan.toString('utf8'),request.planFile,unit),unitKey=delivery.unitKey(unit),dossiers=[];
  for(const item of receipt.result.must_haves_status||[]){
    if(item.kind!=='artifact'||item.status!=='met')continue;
    const criterion_id=unitKey+':artifact:'+item.index,criterion=inventory.criteria.find(c=>c.id===criterion_id);
    if(!criterion)fail('artifact-advisory-criterion-foreign');
    const artifact=source(criterion.artifact_path),envelope=capture.artifacts.find(e=>e.root_id===artifact.q.root_id),row=envelope?.result.rows.find(r=>r.path===roots.qualified(artifact.q));
    if(row?.substantive!==false)continue;
    if(row.exists!==true||!row.flags?.length||row.flags.length>16||(item.evidence||[]).length>32||dossiers.length>=16)fail('artifact-advisory-ineligible');
    const generated=row.flags.length===1&&row.flags[0].level==='substantive'&&row.flags[0].reason==='below_min_lines';
    let generation=null,generatorFile=null;
    if(generated){
      const flag=row.flags[0],declared=require('./forge-must-haves').parseMustHaves(plan.toString('utf8')).artifacts[item.index];
      if(typeof attestGeneration!=='function'||!artifact.q.path.endsWith('.md')||!artifact.text.trim()
        ||flag.regex_name!==undefined||flag.actual!==artifact.text.split('\n').length||flag.expected!==declared?.min_lines
        ||!Number.isSafeInteger(flag.expected)||flag.actual>=flag.expected)fail('artifact-advisory-generated-proof-required');
      // This secondary inspection checks other substantive conditions only;
      // the original plan, below-min-lines flag and expected value stay intact.
      const other=require('./forge-verifier').verifyArtifact({truths:[],artifacts:[{...declared,path:artifact.q.path,min_lines:0}],key_links:[]},[],{cwd:request.execution_contract.code_roots.find(r=>r.id===artifact.q.root_id).path});
      if(other.rows?.length!==1||other.rows[0].exists!==true||other.rows[0].substantive!==true)fail('artifact-advisory-generated-other-flags');
      const scope={criterion_id,artifact_path:roots.qualified(artifact.q),artifact_sha256:artifact.sha256};
      const observed=attestGeneration(Object.freeze({...scope}));
      if(!observed||!text(observed.reference)||typeof observed.content!=='string'||Buffer.byteLength(observed.content)>1048576
        ||!Buffer.from(observed.content).equals(artifact.bytes)||!Array.isArray(observed.sources)||observed.sources.length<2||observed.sources.length>8
        ||observed.sources.some(s=>!s||!['generator','input'].includes(s.role)||!s.path)
        ||observed.sources.filter(s=>s.role==='generator').length!==1||!observed.sources.some(s=>s.role==='input'))fail('artifact-advisory-generated-proof-required');
      const observedSources=structuredClone(observed.sources);
      const inputs=observedSources.map(s=>{const actual=source(s.path);if(actual.q.root_id!==artifact.q.root_id)fail('artifact-advisory-generated-root');return{path:roots.qualified(actual.q),role:s.role,sha256:actual.sha256};});
      if(new Set(inputs.map(s=>s.path)).size!==inputs.length||inputs.some(s=>s.path===scope.artifact_path))fail('artifact-advisory-generated-proof-required');
      generatorFile=source(inputs.find(s=>s.role==='generator').path).file;
      if(!/\.[cm]?js$/.test(generatorFile))fail('artifact-advisory-generated-proof-required');
      generation={reference:observed.reference,content_sha256:artifact.sha256,sources:inputs};
      generationChecks.push(()=>{const fresh=attestGeneration(Object.freeze({...scope}));if(!fresh||fresh.reference!==generation.reference
        ||typeof fresh.content!=='string'||!Buffer.from(fresh.content).equals(artifact.bytes)||!Array.isArray(fresh.sources)
        ||roots.digest(fresh.sources)!==roots.digest(observedSources))fail('artifact-advisory-generation-changed');});
    }else if(row.flags.some(f=>f.level!=='substantive'||f.regex_name!=='empty_function_body'||f.reason!==undefined||!Number.isInteger(f.line_number)))fail('artifact-advisory-ineligible');
    const lines=artifact.text.split(/\r?\n/);
    for(const flag of generated?[]:row.flags){
      const initial=/^\s*let\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>\s*\{\s*\};?\s*$/.exec(lines[flag.line_number-1]||'');
      if(!initial||!new RegExp('(?:^|\\n)[ \\t]*'+initial[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[ \\t]*=[ \\t]*\\([^\\n]*\\)[ \\t]*=>[ \\t]*\\{\\s*[A-Za-z_$]').test(lines.slice(flag.line_number).join('\n')))fail('artifact-advisory-initializer-required');
    }
    const gate=capture.gate.roots.find(e=>e.root_id===artifact.q.root_id);
    if(!gate||gate.revision!==envelope.revision||roots.digest(gate.workspace)!==roots.digest(envelope.workspace))fail('artifact-advisory-capture-stale');
    const candidates=[];
    for(const evidence of item.evidence||[]){
      const match=/^node ([A-Za-z0-9_./-]+\.[cm]?js)$/.exec(evidence.check||'');
      if(evidence.root_id!==artifact.q.root_id||!match||!text(evidence.stdout_line)||generic(evidence.stdout_line))continue;
      const check=gate.result.checks.find(c=>c.command===evidence.check);
      if(!check||check.exitCode!==0||check.skipped||!require('./forge-native-recovery-delivery').isObservedTestLine(check,evidence.stdout_line))continue;
      const test=source({root_id:artifact.q.root_id,path:match[1]});let imported=false;
      for(const found of test.text.matchAll(/\brequire\(\s*['"](\.[^'"\r\n]+)['"]\s*\)/g)){
        try{if(roots.key(Module.createRequire(test.file).resolve(found[1]))===roots.key(generatorFile||artifact.file))imported=true;}catch{/* unrelated imports are not evidence */}
      }
      if(imported)candidates.push({root_id:artifact.q.root_id,command:evidence.check,stdout_line:evidence.stdout_line,test_path:roots.qualified(test.q),test_sha256:test.sha256});
    }
    if(!candidates.length)fail('artifact-advisory-direct-api-evidence-required');
    dossiers.push({criterion_id,artifact_path:roots.qualified(artifact.q),artifact_sha256:artifact.sha256,flags:structuredClone(row.flags),flags_sha256:roots.digest(row.flags),candidate_checks:candidates,
      classification:generated?'generated-content-equality':'intentional-callback-initializer',...(generation?{generation}: {})});
  }
  if(!dossiers.length)fail('artifact-advisory-no-eligible-artifact');
  const challenge={manifest_sha256:hash(manifestBytes),receipt_sha256:hash(receiptBytes),result_sha256:hash(JSON.stringify(receipt.result)),capture_sha256:hash(captureBytes),criteria:dossiers};
  const check=()=>{
    assertAuthority();if(attestStoppedWriter()!==true)fail('artifact-advisory-writer-not-stopped');
    for(const generationCheck of generationChecks)generationCheck();
    if(hash(read(manifestFile,8388608))!==challenge.manifest_sha256||hash(read(returnedReceiptFile,8388608))!==challenge.receipt_sha256||hash(read(captureFile,16777216))!==challenge.capture_sha256
      ||hash(read(request.planFile,1048576))!==manifest.plan_sha256||hash(read(request.contextFile,1048576))!==manifest.context_sha256
      ||roots.digest(execution.replayState(request.cwd,request.execution_contract))!==roots.digest(receipt.code_state)
      ||[...watched].some(([file,sha])=>hash(read(file,1048576))!==sha))fail('artifact-advisory-source-changed');
  };
  check();if(attestCapture({file:captureFile,sha256:challenge.capture_sha256,dispatch_id:request.dispatchId})!==true)fail('artifact-advisory-capture-authority-required');
  if(mode===INSPECT)return structuredClone(challenge);
  const review=attestReview(structuredClone(challenge));
  if(!text(review?.reference)||!text(review.reviewer)||!text(review.producer)||review.reviewer===review.producer||review.pending_questions?.length
    ||['manifest_sha256','receipt_sha256','result_sha256','capture_sha256'].some(k=>review[k]!==challenge[k])||!Array.isArray(review.criteria)||review.criteria.length!==dossiers.length)fail('artifact-advisory-independent-review-required');
  for(const dossier of dossiers){
    const matches=review.criteria.filter(c=>c.criterion_id===dossier.criterion_id),row=matches[0];
    if(matches.length!==1||row.artifact_sha256!==dossier.artifact_sha256||row.flags_sha256!==dossier.flags_sha256||row.classification!==dossier.classification||!text(row.rationale)
      ||!Array.isArray(row.checks)||!row.checks.length||row.checks.some(c=>!dossier.candidate_checks.some(x=>roots.digest(x)===roots.digest(c))))fail('artifact-advisory-review-binding');
  }
  check();const evidence={schema_version:1,...challenge,review:structuredClone(review)};
  const capability=Object.freeze({});records.set(capability,{request_digest:roots.digest(request),manifest_digest:roots.digest(manifest),result_digest:roots.digest(receipt.result),check,evidence});return capability;
}
function read(capability,{request,manifest}={}){
  const record=records.get(capability);if(!record||request&&record.request_digest!==roots.digest(request)||manifest&&record.manifest_digest!==roots.digest(manifest))fail('artifact-advisory-capability-required');
  record.check();
  return {manifest_digest:record.manifest_digest,result_digest:record.result_digest,evidence:structuredClone(record.evidence),check:record.check,
    bindings(criterion_id,item,match,qualified,envelope,capture){
      record.check();const reviewed=record.evidence.review.criteria.find(c=>c.criterion_id===criterion_id),dossier=record.evidence.criteria.find(c=>c.criterion_id===criterion_id);
      if(!reviewed)return null;
      if(dossier.artifact_path!==roots.qualified(qualified)||roots.digest(match.row.flags)!==dossier.flags_sha256||match.row.exists!==true)fail('artifact-advisory-current-artifact-changed');
      const gate=capture.gate.roots.find(e=>e.root_id===item.root_id);
      if(!gate||gate.revision!==envelope.revision||roots.digest(gate.workspace)!==roots.digest(envelope.workspace))fail('artifact-advisory-current-capture-stale');
      const generated=dossier.classification==='generated-content-equality';
      const disposition={state:'advisory-retained',scope:generated?'independently-reviewed-generated-content':'independently-reviewed-helper-api-tests',flags:structuredClone(dossier.flags),review_reference:record.evidence.review.reference,reviewer:record.evidence.review.reviewer,artifact_sha256:dossier.artifact_sha256,
        ...(generated?{generation:structuredClone(dossier.generation)}:{}),limit:generated?'Original line-count advisory retained; fresh generated-content equality and named generator API assertions independently reviewed. No remote CI or UAT claim.':'Intentional initializer independently reviewed; named local API assertions only. No remote CI or UAT claim.'};
      const bindings=reviewed.checks.map(evidence=>{
        const index=gate.result.checks.findIndex(c=>c.command===evidence.command),check=gate.result.checks[index];
        if(index<0||check.exitCode!==0||check.skipped||!require('./forge-native-recovery-delivery').isObservedTestLine(check,evidence.stdout_line)||generic(evidence.stdout_line))fail('artifact-advisory-current-check-unobserved');
        return {criterion_id,root_id:item.root_id,coverage:'behavioral',source:{kind:'verification',check_index:index},observed_test_lines:[evidence.stdout_line],evidence_limit:generated?'Named local generator API assertions, fresh-content equality and independent source review; no remote CI or UAT claim.':'Named local assertions plus independent review of their direct-import API relationship; no coverage, remote CI or UAT claim.',advisory_disposition:structuredClone(disposition)};
      });
      bindings.push({criterion_id,root_id:item.root_id,coverage:'structural',source:{kind:'artifact',row_index:match.index,property:'exists'},advisory_disposition:structuredClone(disposition)});return bindings;
    }};
}
const inspect=options=>create({...options,attestReview:()=>{throw new Error('inspection-does-not-mint');}},INSPECT);
module.exports={create,read,inspect};
