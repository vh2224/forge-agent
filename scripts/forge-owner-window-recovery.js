'use strict';

// Owner-side recovery only. Files are evidence, never writer/decision authority.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const roots=require('./forge-code-roots'),windows=require('./forge-owner-transport-window'),runs=require('./forge-runs');
const adapters=new WeakMap(),digest=roots.digest;
function fail(code){throw Object.assign(new Error(code),{code});}
function read(file,limit=65536,optional=false){
 try{
  let cursor=path.parse(path.resolve(file)).root;
  for(const part of path.resolve(file).slice(cursor.length).split(path.sep)){cursor=path.join(cursor,part);if(fs.lstatSync(cursor).isSymbolicLink())fail('owner-window-evidence-link');}
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>limit)fail('owner-window-evidence-unmeasured');
  const result=require('./forge-autonomy-sources').readBoundedStableFile(file,limit,{expectedReal:fs.realpathSync.native(file)});
  if(result.error)fail('owner-window-evidence-changed');return result.buffer;
 }catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
}
function identity(directory){const stat=fs.statSync(directory,{bigint:true});return digest({path:roots.key(directory),dev:String(stat.dev),ino:String(stat.ino),birth:String(stat.birthtimeNs)});}
function gitIndexState(directory){
 const ownership=require('./forge-isolation').batchIndexIdentity(directory);if(!ownership)fail('owner-window-index-unmeasured');
 const git=require('./forge-git-process').git,options={encoding:'buffer',maxBuffer:32*1024*1024,env:{GIT_OPTIONAL_LOCKS:'0'}};
 const main=read(ownership.path,32*1024*1024,true),shared=git(directory,['-c','core.fsmonitor=false','rev-parse','--shared-index-path'],options).toString('utf8').trim();
 const sharedFile=shared?path.resolve(directory,shared):null,sharedBytes=sharedFile?read(sharedFile,32*1024*1024):null;
 const entries=git(directory,['-c','core.fsmonitor=false','ls-files','--stage','-z'],options);
 return{ownership,index_sha256:main?digest(main):'absent',shared_index_sha256:sharedBytes?digest(sharedBytes):'absent',entries_sha256:digest(entries)};
}
function pathMetadata(directory,relative){
 const absolute=path.resolve(directory,relative);if(!roots.within(directory,absolute))fail('owner-window-path-unmeasured');
 const parts=path.relative(directory,absolute).split(path.sep);let cursor=directory;
 for(let i=0;i<parts.length;i++){
  cursor=path.join(cursor,parts[i]);let stat;
  try{stat=fs.lstatSync(cursor);}catch(error){if(error.code==='ENOENT')return{path:relative,kind:'absent'};throw error;}
  const last=i===parts.length-1,kind=stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'other';
  const row={path:relative,kind,mode:stat.mode&0o777,...(kind==='symlink'?{link_sha256:digest(fs.readlinkSync(cursor))}:{})};
  if(last)return row;
  if(kind!=='directory')return{...row,kind:'blocked-'+kind,ancestor:path.relative(directory,cursor)};
 }
 fail('owner-window-path-unmeasured');
}
function stableSnapshot(root){
 const snapshot=require('./forge-surgical-reset').captureAttemptSnapshot(root.path);
 let index=null;if(snapshot.vcs==='git'){
  index=gitIndexState(root.path);if(digest(index)!==digest(gitIndexState(root.path)))fail('owner-window-index-unstable');
 }
 return{root_id:root.id,path:root.path,identity_sha256:root.identity_sha256,vcs:snapshot.vcs,start_sha:snapshot.start_sha,
  pre_dirty:[...snapshot.pre_dirty].sort((a,b)=>a.path.localeCompare(b.path)),
  worktree_metadata:snapshot.pre_dirty.map(entry=>pathMetadata(root.path,entry.path)).sort((a,b)=>a.path.localeCompare(b.path)),
  ...(index?{git_index:index}:{}),...(snapshot.svn_state?{svn_state_sha256:digest(snapshot.svn_state)}:{})};
}
// DATA measurement only; never enrollment, ownership transfer or a writer proof.
function measurePreparationCodeState({owner,request}){
 owner=roots.realDirectory(owner);const q=require('./forge-task-preparation').validateRequest(request);
 if(roots.key(roots.realDirectory(q.contextRoot||q.cwd))!==roots.key(owner))fail('owner-window-request-mismatch');
 const run=JSON.parse(read(runs.runFile(owner,q.taskId)));
 if(run.id!==q.taskId||run.kind!=='task'||!['claude','codex'].includes(run.host_runtime)||typeof run.session_id!=='string')fail('owner-window-run-binding-mismatch');
 const contract=q.execution_contract||roots.singleContract(owner,q.cwd);roots.validateContract(contract,{revalidate:true});
 const census=require('./forge-owner-recovery-roots').measure({owner,contract,run});
 return{execution_contract_sha256:digest(contract),worktree_bindings:census.bindings,
  code_states:census.roots.map(stableSnapshot).sort((a,b)=>a.root_id.localeCompare(b.root_id))};
}

function measureTask({owner,request,receiptCopy}){
 owner=roots.realDirectory(owner);const prep=require('./forge-task-preparation'),q=prep.validateRequest(request),fingerprint=prep.preparationRequestFingerprint(q);
 if(roots.key(roots.realDirectory(q.contextRoot||q.cwd))!==roots.key(owner))fail('owner-window-request-mismatch');
 const runBytes=read(runs.runFile(owner,q.taskId)),run=JSON.parse(runBytes);
 if(run.id!==q.taskId||run.kind!=='task'||!['claude','codex'].includes(run.host_runtime)||typeof run.session_id!=='string')fail('owner-window-run-binding-mismatch');
 const contract=q.execution_contract||roots.singleContract(owner,q.cwd);roots.validateContract(contract,{revalidate:true});
 const census=require('./forge-owner-recovery-roots').measure({owner,contract,run});
 const evidence=require('./forge-owner-recovery-receipt').measure({owner,request:q,fingerprint,receiptCopy,read}),receipt=evidence.receipt;
 const custody=require('./forge-preparation-custody-profile');
 const channels=custody.eligible(receipt)?custody.inspectChannels({request:q,read}):null,limited=channels!==null&&!channels.candidate;
 const surface=limited?custody.measure({owner,request:q,receipt,census,read}):{
  owner_surface_sha256:digest(require('./forge-task-execution').protectedSnapshot(owner)),code_states:census.roots.map(stableSnapshot).sort((a,b)=>a.root_id.localeCompare(b.root_id))};
 const scope={schema_version:limited?2:1,owner,task_id:q.taskId,dispatch_id:q.dispatchId,previous_host_runtime:run.host_runtime,previous_host_session_sha256:digest(run.session_id),owner_identity_sha256:identity(owner),run_sha256:digest(runBytes),request_sha256:fingerprint,
  receipt:evidence.reference,worktree_bindings:census.bindings,
  ...surface,...(channels?.candidate?{retained_candidate_channels:channels}:{})};
 return{owner,run,request:q,receipt,scope};
}
// Execution recovery is a separate measurement, not a preparation waiver. It
// can release only the external coordination fence; all execution evidence,
// lease/claim authority and pending questions remain exactly as observed.
function measureExecution({owner,request,receiptCopy,binding}){
 if(receiptCopy!==undefined)fail('owner-window-execution-receipt-copy-unsupported');
 const attempt=require('./forge-attempt-recovery'),side=require('./forge-unit-sidecar'),controller=require('./forge-unit-controller'),lease=require('./forge-unit-lease');
 const q=attempt.canonicalRequest(request),unit=`execute-task/${q.taskId}`;
 if(request.scope!=='milestone'||request.phase!=='execute'||q.unitType!=='execute-task'||!/^T\d+(?:\.\d+)?$/.test(q.taskId||'')
   ||!/^S\d{2,}$/.test(q.sliceId||'')||!require('./forge-ids').isValid(q.milestoneId)||q.runId!==q.milestoneId
   ||q.ownerBroker||q.memberHandle!==undefined||q.batch_id!==undefined||q.route?.worker_mode!=='sidecar'
   ||roots.key(roots.realDirectory(q.contextRoot))!==roots.key(owner)||!q.execution_contract)fail('owner-window-execution-scope-mismatch');
 const exactRead=(file,limit=65536,optional=false)=>{const bytes=read(file,limit,optional);if(bytes&&fs.lstatSync(file).nlink!==1)fail('owner-window-evidence-link');return bytes;};
 const runBytes=exactRead(runs.runFile(owner,q.runId)),run=JSON.parse(runBytes),contract=roots.validateContract(q.execution_contract,{owner,revalidate:true});
 if(run.id!==binding.task_id||run.id!==q.runId||run.kind!=='milestone'||run.active!==true
   ||run.host_runtime!==binding.host_runtime||q.route?.host_runtime!==binding.host_runtime
   ||digest(run.session_id||'')!==binding.host_session_sha256||run.batch_locator)fail('owner-window-run-binding-mismatch');
 if(digest(run.write_claim)!==digest(q.claim))fail('owner-window-execution-claim-mismatch');
 require('./forge-write-claim').validateHeldClaim(run.write_claim);
 if(q.claim?.schema_version!==2||!q.claim.generation||!q.claim.paths.length||q.claim.unit!==unit
   ||digest(q.claim.execution_contract)!==digest(contract))fail('owner-window-execution-claim-mismatch');
 side.validateRecoveryRequest(q);
 const plan=exactRead(q.planFile,2*1024*1024),planHash=digest(plan);
 const leaseFile=lease.leaseFile(owner,unit),leaseBytes=exactRead(leaseFile),held=JSON.parse(leaseBytes);
 const begin=controller.lookupRecord(owner,'transaction',binding.begin_key);
 if(!lease.validRecord(held,unit)||held.generation!==binding.lease_generation||digest(held.owner_token)!==binding.owner_token_sha256
   ||held.request_id!==binding.begin_key||held.host_runtime!==binding.host_runtime
   ||!begin||begin.action!=='begin'||begin.phase!=='committed'||begin.unit?.key!==unit||begin.milestone!==q.milestoneId
   ||begin.after?.state?.active_slice!==q.sliceId||begin.host_runtime!==held.host_runtime||begin.lease_generation!==held.generation
   ||begin.owner_digest!=='sha256:'+digest(held.owner_token)||controller.recordChecksum(begin)!==binding.begin_sha256
   ||!controller.incompleteUnits(owner,q.milestoneId).some(row=>row.idempotency_key===begin.idempotency_key))fail('owner-window-execution-lineage-mismatch');
 const published=controller.readEvents(controller.eventsFile(owner,q.milestoneId)).filter(row=>row.idempotency_key===begin.idempotency_key);
 const event=published.length===1?{...published[0]}:null;if(event)delete event.sequence;
 if(!event||!Number.isSafeInteger(published[0].sequence)||published[0].sequence<1||digest(event)!==digest(begin.event)
   ||controller.pendingTransactions(owner).length)fail('owner-window-execution-lineage-mismatch');
 const fingerprint=side.artifactFingerprint(q),recoveryIdentity=digest(attempt.requestIdentity(q));
 const requestHash=digest({owner,run:q.runId,unit,generation:held.generation,dispatch:q.dispatchId,workflow:q.workflowId,contract:q.execution_contract,plan:planHash,claim:digest(run.write_claim)});
 if(binding.unit_key!==unit||binding.dispatch_id!==q.dispatchId||binding.request_sha256!==requestHash||binding.request_fingerprint!==fingerprint
   ||binding.recovery_identity_sha256!==recoveryIdentity||binding.result_file_sha256!==digest(path.resolve(q.resultFile)))fail('owner-window-request-mismatch');
 const census=require('./forge-owner-recovery-roots').measure({owner,contract,run});
 const suffixes=['','.receipt.json','.returned.json','.manifest.json','.request.json','.receipt.json.response-anchor.json','.process-tree.jsonl','.process-tree.custody.jsonl'];
 const channels=suffixes.map(suffix=>{
  const file=path.resolve(q.resultFile+suffix);for(const root of [owner,...census.roots.map(row=>row.path)])require('./forge-xllm').validateResultFileTarget(file,root);
  const bytes=exactRead(file,8*1024*1024,true);return{file,present:bytes!==null,sha256:bytes?digest(bytes):null,bytes:bytes?.length||0};
 });
 const receiptChannel=channels.find(row=>row.file===path.resolve(q.resultFile+'.receipt.json'));
 let receipt=null;if(receiptChannel.present){
  const bytes=exactRead(receiptChannel.file,8*1024*1024);if(digest(bytes)!==receiptChannel.sha256)fail('owner-window-evidence-changed');
  try{receipt=JSON.parse(bytes);}catch{fail('owner-window-receipt-mismatch');}
  if(receipt.dispatch_id!==q.dispatchId||receipt.fingerprint!==fingerprint
    ||receipt.recovery_identity_sha256!==recoveryIdentity)fail('owner-window-receipt-mismatch');
  if(receipt.retained_request)require('./forge-request-retention').assertForReceipt(q,receipt);
 }
 for(const suffix of ['', '.returned.json','.manifest.json']){
  const channel=channels.find(row=>row.file===path.resolve(q.resultFile+suffix));if(!channel.present)continue;
  const bytes=exactRead(channel.file,8*1024*1024);if(digest(bytes)!==channel.sha256)fail('owner-window-evidence-changed');
  // Malformed output remains retained data, not a result we accept. Any present
  // identity header, however, must describe this exact attempt.
  let value;try{value=JSON.parse(bytes);}catch{continue;}
  for(const[key,wanted]of [['dispatch_id',q.dispatchId],['fingerprint',fingerprint],['request_fingerprint',fingerprint],['recovery_identity_sha256',recoveryIdentity]]){
   if(value?.[key]!==undefined&&value[key]!==null&&value[key]!==wanted)fail('owner-window-execution-channel-mismatch');
  }
  if(suffix==='.manifest.json'&&value?.request){
   if(side.artifactFingerprint(attempt.canonicalRequest(value.request))!==fingerprint
     ||digest(path.resolve(value.request.resultFile||''))!==binding.result_file_sha256)fail('owner-window-execution-channel-mismatch');
  }
 }
 for(const[key,suffix]of [['manifest_sha256','.manifest.json'],['returned_response','.returned.json']]){
  const wanted=key==='returned_response'?receipt?.returned_response?.sha256:receipt?.[key];
  if(wanted!==undefined&&wanted!==null&&wanted!==channels.find(row=>row.file===path.resolve(q.resultFile+suffix)).sha256)fail('owner-window-execution-channel-mismatch');
 }
 const scope={schema_version:3,measurement_profile:'milestone-execution-coordination-v1',owner,task_id:q.runId,milestone_id:q.milestoneId,
  slice_id:q.sliceId,unit,dispatch_id:q.dispatchId,previous_host_runtime:run.host_runtime,previous_host_session_sha256:digest(run.session_id),
  owner_identity_sha256:identity(owner),run_sha256:digest(runBytes),request_sha256:requestHash,request_fingerprint:fingerprint,recovery_identity_sha256:recoveryIdentity,
  plan_sha256:planHash,claim_sha256:digest(run.write_claim),claim_generation:q.claim.generation,begin_key:begin.idempotency_key,
  begin_sha256:controller.recordChecksum(begin),lease_sha256:digest(leaseBytes),lease_generation:held.generation,execution_contract_sha256:digest(contract),
  receipt:{file:receiptChannel.file,sha256:receiptChannel.sha256,phase:receipt?.phase||'missing'},retained_channels:channels,worktree_bindings:census.bindings,
  coverage:{authority:'coordination-only',artifacts_accepted:false,code_completed:false,writer_proof:'live-host-joins-required'},
  owner_surface_sha256:digest(require('./forge-task-execution').protectedSnapshot(owner)),code_states:census.roots.map(stableSnapshot).sort((a,b)=>a.root_id.localeCompare(b.root_id))};
 return{owner,run,request:q,receipt,scope};
}
function capture({owner,request,receiptCopy}){
 if(receiptCopy!==undefined&&!request)fail('owner-window-request-required');
 owner=roots.realDirectory(owner);const seen=windows.observed(owner);if(!seen)return{owner,seen:null};
 const binding=seen.binding;
 if(!['artifact-preparation','unit-execution'].includes(binding.kind)||binding.coordination!=='observed-host-session-v1'
   ||!['codex','claude'].includes(binding.host_runtime)||!/^[a-f0-9]{64}$/.test(binding.host_session_sha256||''))fail('owner-window-binding-unsupported');
 const metadata=require('./forge-lock').status(windows.controlRoot(owner),'owner-transport-window').metadata;
 if(!metadata?.owner_token||!metadata.generation)fail('owner-window-unmeasured');
 const runFile=runs.runFile(owner,binding.task_id),runBytes=read(runFile),run=JSON.parse(runBytes);
 if(run.id!==binding.task_id||run.kind!==(binding.kind==='unit-execution'?'milestone':'task')||run.host_runtime!==binding.host_runtime||digest(run.session_id||'')!==binding.host_session_sha256)fail('owner-window-run-binding-mismatch');
 if(!request)return{owner,seen,run,metadata};
 const measured=binding.kind==='unit-execution'?measureExecution({owner,request,receiptCopy,binding}):measureTask({owner,request,receiptCopy}),q=measured.request;
 if((binding.kind==='unit-execution'?q.runId:q.taskId)!==binding.task_id||q.dispatchId!==binding.dispatch_id||(binding.kind==='unit-execution'?q.route?.host_runtime:q.hostRuntime)!==binding.host_runtime
   ||measured.scope.request_sha256!==binding.request_sha256||measured.scope.run_sha256!==digest(runBytes))fail('owner-window-request-mismatch');
 const scope={...measured.scope,binding_sha256:seen.sha256,binding,custody:{owner_token:metadata.owner_token,generation:metadata.generation}};
 return{...measured,seen,metadata,scope,observation_sha256:digest(scope)};
}
function inspect(options){
 const current=capture(options);if(!current.seen)return{status:'absent',recovered:false};
 let holder='unknown';try{const pid=current.metadata.holder_pid;if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);holder='present';}catch(error){if(error.code==='ESRCH')holder='absent';}}}catch{}
 return{status:'held',task_id:current.seen.binding.task_id,dispatch_id:current.seen.binding.dispatch_id,host_runtime:current.seen.binding.host_runtime,
  binding_sha256:current.seen.sha256,holder_state:holder,process_observation_is_join_proof:false,
  observation_sha256:current.observation_sha256||null,receipt_phase:current.scope?.receipt.phase||'unmeasured',
  ...(current.scope?.measurement_profile?{measurement_profile:current.scope.measurement_profile,coverage:current.scope.coverage}:{}),
  recovery:'conditional',reason_code:current.scope?'owner-window-live-host-required':'owner-window-request-required',
  required_evidence:['sessão atual observada do host','join do owner anterior e de todos os escritores possíveis','reconciliação exata do owner, código e recibo']};
}
function observe(hostRuntime){const actor=runs.observeHostSession(hostRuntime,process.env.FORGE_CLAUDE_OWNER_SESSION_ID);if(!actor)fail('owner-window-host-session-required');return actor;}
function actorWire(actor){return{host_runtime:actor.hostRuntime,session_sha256:digest(actor.sessionId),source:actor.source};}
function createHostAdapter({hostRuntime,observeWriters,reconcile,observeDecision}={}){
 if(!['codex','claude'].includes(hostRuntime)||typeof observeWriters!=='function'||typeof reconcile!=='function')fail('owner-window-live-host-required');
 const adapter=Object.freeze({});adapters.set(adapter,Object.freeze({actor:Object.freeze({...observe(hostRuntime)}),observeWriters,reconcile,observeDecision}));return adapter;
}
function createObservedHostAdapter({hostRuntime,observeWriters,reconcile,observeDecision}={}){
 if(typeof observeWriters!=='function'||typeof reconcile!=='function')fail('owner-window-live-host-required');
 // The trusted host supplies live functions, never an imported observation
 // file. Bind their observations here so an operator need not implement the
 // low-level challenge/nonce protocol. External tool semantics remain the
 // host's obligation, not something these object fields can establish.
 return createHostAdapter({hostRuntime,
  observeWriters:async challenge=>{const facts=await observeWriters(challenge);return{...facts,challenge_sha256:digest(challenge),scope_sha256:challenge.scope_sha256,observation_kind:'live-host-writer-census'};},
  reconcile:async challenge=>{const facts=await reconcile(challenge);return{...facts,scope_sha256:challenge.scope_sha256};},
  ...(typeof observeDecision==='function'?{observeDecision:async challenge=>{const answer=await observeDecision(challenge);return{...answer,challenge_sha256:digest(challenge)};}}:{})});
}
function assertAdapter(adapter){
 const entry=adapter&&adapters.get(adapter);if(!entry)fail('owner-window-live-host-required');
 const actor=observe(entry.actor.hostRuntime);if(digest(actorWire(actor))!==digest(actorWire(entry.actor)))fail('owner-window-host-session-changed');return entry;
}
function freeze(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
async function observeStopped(adapter,challenge,{requirePreviousOwnerStopped=true}={}){
 const entry=assertAdapter(adapter),proof=await entry.observeWriters(freeze(challenge));assertAdapter(adapter);
 if(!proof||proof.challenge_sha256!==digest(challenge)||proof.scope_sha256!==challenge.scope_sha256||proof.observation_kind!=='live-host-writer-census'
   ||proof.coverage_complete!==true||proof.previous_session_sha256!==challenge.scope.previous_host_session_sha256
   ||!Array.isArray(proof.writers)||proof.writers.length>1024||proof.writers.some(row=>!row||row.state!=='joined'||typeof row.reference!=='string'||!row.reference.trim()||row.reference.length>2048)
   ||(requirePreviousOwnerStopped&&proof.previous_owner_stopped!==true)||proof.joined!==true||proof.possible_writers!==0
   ||typeof proof.reference!=='string'||!proof.reference.trim()||proof.reference.length>2048)fail('owner-window-writer-unproven');
 require('./forge-preparation-custody-profile').assertLiveProof(challenge.scope,proof);
 const reconciliation=await entry.reconcile(challenge);assertAdapter(adapter);
 if(reconciliation?.scope_sha256!==challenge.scope_sha256||reconciliation.reconciled!==true||typeof reconciliation.reference!=='string'
   ||!reconciliation.reference.trim()||reconciliation.reference.length>2048)fail('owner-window-reconciliation-required');
 return{writer_reference:proof.reference,reconciliation_reference:reconciliation.reference};
}
function auditFile(owner,scopeSha,nonce){
 const base=windows.controlRoot(owner),directory=path.join(base,'owner-window-recovery');
 if(fs.existsSync(directory)){if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())fail('owner-window-audit-path');}
 else fs.mkdirSync(directory,{mode:0o700});
 if(!roots.within(fs.realpathSync.native(base),fs.realpathSync.native(directory)))fail('owner-window-audit-path');
 return path.join(directory,scopeSha+'.'+nonce+'.json');
}
async function recover({owner,request,receiptCopy,expected,adapter}={}){
 const entry=assertAdapter(adapter),current=capture({owner,request,receiptCopy});
 if(!current.seen)return{status:'already-absent',recovered:false};
 if(!current.scope||typeof expected!=='string'||current.observation_sha256!==expected)fail('owner-window-recovery-conflict');
 if(entry.actor.hostRuntime!==current.seen.binding.host_runtime)fail('owner-window-cross-host-unsupported');
 if(digest(entry.actor.sessionId)===current.seen.binding.host_session_sha256)fail('owner-window-current-session-use-settle');
 const nonce=crypto.randomBytes(16).toString('hex'),challenge={operation:'recover-orphan-owner-window',nonce,actor:actorWire(entry.actor),scope_sha256:expected,scope:current.scope};
 const proof=await observeStopped(adapter,challenge);
 if(capture({owner,request,receiptCopy}).observation_sha256!==expected)fail('owner-window-recovery-conflict');
 const file=auditFile(current.owner,expected,nonce),audit={schema_version:1,outcome:'authorized',actor:actorWire(entry.actor),scope:current.scope,...proof,at:new Date().toISOString()};
 try{fs.writeFileSync(file,JSON.stringify(audit,null,2)+'\n',{flag:'wx',mode:0o600});}
 catch(error){throw Object.assign(new Error('owner-window-audit-write-failed'),{code:'owner-window-audit-write-failed',layer:'owner-window-audit',cause_code:error.code||'unknown'});}
 const result=windows.recover(current.owner,current.seen,low=>{
  assertAdapter(adapter);
  if(low.binding_sha256!==current.scope.binding_sha256||capture({owner,request,receiptCopy}).observation_sha256!==expected)fail('owner-window-recovery-conflict');
  return{challenge_sha256:digest(low),joined:true,possible_writers:0,reference:proof.writer_reference};
 });
 audit.outcome='recovered';let auditSaved=true;try{fs.writeFileSync(file,JSON.stringify(audit,null,2)+'\n',{mode:0o600});}catch{auditSaved=false;}
 return{status:'recovered',recovered:result.recovered,audit_file:file,audit_saved:auditSaved,binding_sha256:current.seen.sha256};
}
module.exports={inspect,recover,createHostAdapter,createObservedHostAdapter,capture,measureTask,measurePreparationCodeState,assertAdapter,observeStopped,actorWire,readEvidence:read,freezeChallenge:freeze};
