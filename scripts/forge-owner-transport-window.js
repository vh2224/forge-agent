'use strict';
// Exact owner coordination, separate from consent, native evidence and artifacts.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{AsyncLocalStorage}=require('async_hooks');
const roots=require('./forge-code-roots'),locks=require('./forge-lock'),context=new AsyncLocalStorage(),caps=new WeakMap(),adapters=new WeakMap();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),digest=value=>sha(JSON.stringify(value));
function error(code){return Object.assign(new Error(code),{code});}
function ownerOf(owner){return roots.realDirectory(owner);}
function controlRoot(owner){return path.join(require('os').tmpdir(),'forge-artifact-owner-'+roots.digest(roots.key(ownerOf(owner))));}
function windowFile(owner){return path.join(locks.lockPath(controlRoot(owner),'owner-transport-window'),'binding.json');}
function observed(owner){const dir=locks.lockPath(controlRoot(owner),'owner-transport-window');if(!fs.existsSync(dir))return null;try{const file=windowFile(owner),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw error('owner-window-unmeasured');const bytes=fs.readFileSync(file),binding=JSON.parse(bytes);if(binding.owner!==ownerOf(owner))throw error('owner-window-unmeasured');return{binding,sha256:sha(bytes)};}catch{throw error('owner-window-unmeasured');}}
function held(cap){const entry=cap&&caps.get(cap);if(!entry||!locks.assertOwned(entry.lock))throw error('owner-window-capability-required');const seen=observed(entry.owner);if(!seen||seen.sha256!==entry.binding_sha256)throw error('owner-window-binding-changed');return entry;}
function assertMutationAllowed(owner){owner=ownerOf(owner);const seen=observed(owner);if(!seen)return true;const cap=context.getStore()?.cap,entry=cap&&caps.get(cap);if(!entry||entry.owner!==owner)throw error('owner-window-busy');held(cap);return true;}
function currentPublicationGuard(owner){const live=context.getStore();return live?.owner===ownerOf(owner)?live.guard:undefined;}
function withPublicationContext(owner,guard,action){const live=context.getStore();return context.run({owner:ownerOf(owner),guard,cap:live?.cap},action);}
function withMutation(owner,action){owner=ownerOf(owner);if(typeof action!=='function'||action.constructor?.name==='AsyncFunction')throw error('owner-mutation-sync-required');const recon=require('./forge-artifact-reconciliation'),current=currentPublicationGuard(owner);if(current)return recon.withOwnerLock(owner,()=>action(current),current);const guard=recon.lock({owner});try{return withPublicationContext(owner,guard,()=>recon.withOwnerLock(owner,()=>action(guard),guard));}finally{guard.release();}}
function open(owner,binding){owner=ownerOf(owner);if(!binding||binding.kind!=='artifact-preparation'||typeof binding.task_id!=='string'||typeof binding.dispatch_id!=='string'||!/^[a-f0-9]{64}$/.test(binding.request_sha256))throw error('owner-window-scope-required');return withMutation(owner,()=>{const lock=locks.acquireSync(controlRoot(owner),'owner-transport-window',{allowStaleRecovery:false,retries:1});try{const value={...binding,owner},bytes=Buffer.from(JSON.stringify(value)+'\n');fs.writeFileSync(windowFile(owner),bytes,{flag:'wx',mode:0o600});const cap=Object.freeze({});caps.set(cap,{owner,binding:value,binding_sha256:sha(bytes),lock});return cap;}catch(e){lock.release();throw e;}});}
function withWindow(cap,action){const entry=held(cap),live=context.getStore();return context.run({owner:entry.owner,cap,guard:live?.owner===entry.owner?live.guard:undefined},action);}
function attestJoined(challenge,attest){if(typeof attest!=='function')throw error('owner-window-join-attestation-required');let proof;try{proof=attest(challenge);}catch{throw error('owner-window-writer-unproven');}if(!proof||proof.then||proof.challenge_sha256!==digest(challenge)||proof.joined!==true||proof.possible_writers!==0||typeof proof.reference!=='string'||!proof.reference.trim())throw error('owner-window-writer-unproven');return proof.reference;}
function releaseBinding(owner,release){const file=windowFile(owner),bytes=fs.readFileSync(file);fs.unlinkSync(file);try{if(release()!==true)throw error('owner-window-close-conflict');}catch(e){fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});throw e;}}
function close(cap,attest){const entry=held(cap);return withWindow(cap,()=>withMutation(entry.owner,()=>{const challenge={operation:'close-owner-window',owner:entry.owner,binding:entry.binding,binding_sha256:entry.binding_sha256};const reference=attestJoined(challenge,attest);held(cap);releaseBinding(entry.owner,()=>entry.lock.release().ok);caps.delete(cap);return{closed:true,reference};}));}
function recover(owner,expected,attest){owner=ownerOf(owner);const recon=require('./forge-artifact-reconciliation'),guard=recon.lock({owner});try{const seen=observed(owner);if(!seen||seen.sha256!==expected.sha256)throw error('owner-window-recovery-conflict');const meta=locks.status(controlRoot(owner),'owner-transport-window');const challenge={operation:'recover-owner-window',owner,binding:seen.binding,binding_sha256:seen.sha256,metadata:meta};const reference=attestJoined(challenge,attest);if(observed(owner)?.sha256!==seen.sha256)throw error('owner-window-recovery-conflict');const row=meta.metadata||meta;releaseBinding(owner,()=>locks.releaseSync(controlRoot(owner),'owner-transport-window',row.owner_token,row.generation));return{recovered:true,reference};}finally{guard.release();}}
function metadataOwner(file){let cursor=path.dirname(path.resolve(file));for(;;){if(path.basename(cursor)==='.gsd')return ownerOf(path.dirname(cursor));const parent=path.dirname(cursor);if(parent===cursor)throw error('owner-metadata-path-required');cursor=parent;}}
// Reattachment grants coordination only. All original receipt/input/native
// acceptance validation still runs, and neither accept nor ready releases it.
function coordinatePreparation(request,requestSha,{create=true,operation='accept'}={}){
 const owner=ownerOf(request.contextRoot||request.cwd),active=context.getStore()?.cap;
 if(active){const row=held(active);if(row.owner!==owner||row.binding.task_id!==request.taskId||row.binding.dispatch_id!==request.dispatchId)throw error('owner-window-scope-conflict');return active;}
 const seen=observed(owner),runs=require('./forge-runs'),record=runs.get(owner,request.taskId),actor=runs.observeHostSession(request.hostRuntime,process.env.FORGE_CLAUDE_OWNER_SESSION_ID);
 if(actor&&record?.host_runtime&&record?.session_id&&(record.host_runtime!==actor.hostRuntime||record.session_id!==actor.sessionId))throw error('owner-window-foreign-owner');
 if(!actor||!record||record.kind!=='task'||record.host_runtime!==actor.hostRuntime||record.session_id!==actor.sessionId){assertMutationAllowed(owner);return null;}
 const scope={kind:'artifact-preparation',coordination:'observed-host-session-v1',task_id:request.taskId,dispatch_id:request.dispatchId,request_sha256:requestSha,host_runtime:actor.hostRuntime,host_session_sha256:sha(actor.sessionId),run_owner_sha256:sha(JSON.stringify({id:record.id,kind:record.kind,host_runtime:record.host_runtime,session_sha256:sha(record.session_id)})),run_record_sha256:sha(fs.readFileSync(runs.runFile(owner,request.taskId)))};
 if(!seen){if(!create)return null;return open(owner,scope);}
 // The raw run hash is initial evidence, not the ownership identity. Volatile
 // heartbeat/PID/continuation updates never become request or artifact authority.
 for(const[key,value]of Object.entries(scope))if(key!=='run_record_sha256'&&seen.binding[key]!==value)throw error('owner-window-coordination-mismatch');
 if(operation==='start'){
  let phase;try{phase=JSON.parse(fs.readFileSync(require('./forge-unit-sidecar').artifactAttemptFiles(request).receiptFile,'utf8')).phase;}catch{}
  if(!['ready','failed'].includes(phase))throw error('owner-window-attempt-in-progress');
 }
 const status=locks.status(controlRoot(owner),'owner-transport-window'),meta=status.metadata;
 if(!meta||!meta.owner_token||!meta.generation)throw error('owner-window-unmeasured');
 const lock={lockDir:locks.lockPath(controlRoot(owner),'owner-transport-window'),ownerToken:meta.owner_token,generation:meta.generation,release:()=>({ok:locks.releaseSync(controlRoot(owner),'owner-transport-window',meta.owner_token,meta.generation)})};
 if(!locks.assertOwned(lock))throw error('owner-window-unmeasured');
 const cap=Object.freeze({});caps.set(cap,{owner,binding:seen.binding,binding_sha256:seen.sha256,lock});return cap;
}
function coordinationResult(cap,result){const row=held(cap);return row.binding.coordination==='observed-host-session-v1'?{...result,owner_window:{status:'held',binding_sha256:row.binding_sha256,settlement:'live-host-join-required'}}:result;}
function createTransportAdapter(attestStopped){if(typeof attestStopped!=='function')throw error('owner-window-live-host-required');const handle=Object.freeze({});adapters.set(handle,attestStopped);return handle;}
async function protectPreparation(request,adapter,action){
 const attest=adapters.get(adapter);if(!attest)throw error('owner-window-live-host-required');
 const owner=ownerOf(request.contextRoot||request.cwd),current=context.getStore()?.cap;
 if(current){const existing=held(current);if(existing.owner!==owner||existing.binding.task_id!==request.taskId||existing.binding.dispatch_id!==request.dispatchId)throw error('owner-window-scope-conflict');return action();}
 const binding={kind:'artifact-preparation',task_id:request.taskId,dispatch_id:request.dispatchId,request_sha256:sha(JSON.stringify(request))},cap=open(owner,binding);
 const settle=()=>close(cap,attest);
 const execute=async callback=>{try{const result=await withWindow(cap,callback);settle();return result;}catch(e){if(caps.has(cap)){try{settle();}catch(secondary){e.owner_window={status:'held',reason_code:secondary.code||'owner-window-writer-unproven',binding_sha256:held(cap).binding_sha256};}}throw e;}};
 try{
  const result=await withWindow(cap,action);
  if(result?.ok===true&&['invoke-native','invoke-sidecar'].includes(result.action)){
   const invoke=result.invoke;let consumed=false;
   return{...result,invoke:callback=>{if(consumed)throw error('owner-window-handoff-consumed');consumed=true;return execute(()=>typeof invoke==='function'?invoke(callback):callback(result.delivery_request));}};
  }
  settle();return result;
 }catch(e){if(caps.has(cap)){try{settle();}catch(secondary){e.owner_window={status:'held',reason_code:secondary.code||'owner-window-writer-unproven',binding_sha256:held(cap).binding_sha256};}}throw e;}
}
// CLI custody is observed here; host tools still require a real live bridge.
async function settlePreparationInside(rawRequest,adapter,cliJoins){
 const attest=adapters.get(adapter);if(!attest)throw error('owner-window-live-host-required');
 const prep=require('./forge-task-preparation'),request=prep.validateRequest(rawRequest),fingerprint=prep.preparationRequestFingerprint(request);
 const cap=coordinatePreparation(request,fingerprint,{create:false,operation:'settle'});
 if(!cap)throw error('owner-window-coordination-required');
 const entry=held(cap);if(entry.binding.coordination!=='observed-host-session-v1'||entry.binding.request_sha256!==fingerprint)throw error('owner-window-coordination-mismatch');
 const file=require('./forge-unit-sidecar').artifactAttemptFiles(request).receiptFile;
 const read=()=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw error('owner-window-receipt-untrusted');return fs.readFileSync(file);};
 const bytes=read(),receipt=JSON.parse(bytes);
 if(receipt.phase!=='ready'||receipt.request_fingerprint!==fingerprint||receipt.dispatch_id!==request.dispatchId)throw error('owner-window-terminal-receipt-required');
 // A ready flag cannot authorize release. Reuse canonical replay validation,
 // then obtain a live proof bound to request, exact receipt and CLI closes.
 attestJoined({operation:'join-cli-settlement',owner:entry.owner,binding_sha256:entry.binding_sha256,request_sha256:fingerprint,receipt_sha256:sha(bytes),cli_joins:cliJoins},attest);
 const replay=await withWindow(cap,()=>prep.startStandaloneTaskPreparation(rawRequest));
 if(replay.ok!==true||replay.action!=='complete')throw error(replay.reason_code||'owner-window-replay-refused');
 if(!read().equals(bytes))throw error('owner-window-receipt-changed');
 return close(cap,challenge=>{
  const bound={...challenge,operation:'settle-cli-preparation',request_sha256:fingerprint,receipt:{file,sha256:sha(bytes),phase:receipt.phase},cli_joins:cliJoins};
  const reference=attestJoined(bound,attest);
  if(!read().equals(bytes))throw error('owner-window-receipt-changed');
  return{challenge_sha256:digest(challenge),joined:true,possible_writers:0,reference};
 });
}
async function settlePreparation(rawRequest,adapter){return settlePreparationInside(rawRequest,adapter,[]);}
function freezeTree(value){if(value&&typeof value==='object'){for(const nested of Object.values(value))freezeTree(nested);Object.freeze(value);}return value;}
async function runCliPreparation(requestFile,{acceptanceFile,invokeNative,ownerTransportAdapter}={}){
 const attest=adapters.get(ownerTransportAdapter);
 // Refuse before opening a window if this host cannot supply actual callbacks.
 if(!attest||typeof invokeNative!=='function')throw error('owner-window-live-host-required');
 const prep=require('./forge-task-preparation'),source=fs.readFileSync(requestFile),raw=JSON.parse(source),request=prep.validateRequest(raw),owner=ownerOf(request.contextRoot||request.cwd);
 const codeRoots=request.execution_contract?.code_roots||[{id:'primary',path:request.cwd}],xllm=require('./forge-xllm');
 for(const root of [owner,...codeRoots.map(row=>row.path)])xllm.validateResultFileTarget(acceptanceFile,root);
 if(fs.existsSync(acceptanceFile))throw error('owner-window-acceptance-exists');
 const unchanged=()=>{if(!fs.readFileSync(requestFile).equals(source))throw error('owner-window-request-changed');};
 const cliJoins=[];
 const cli=args=>new Promise((resolve,reject)=>{
  unchanged();const child=require('child_process').spawn(process.execPath,[path.join(__dirname,'forge-task-preparation.js'),...args],{env:{...process.env},stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='',stderr='',spawnError;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',bytes=>{stdout+=bytes;});child.stderr.on('data',bytes=>{stderr+=bytes;});child.once('error',e=>{spawnError=e;});
  child.once('close',(status,signal)=>{try{unchanged();cliJoins.push({mode:args[0],pid:child.pid,status,signal,closed:true,stdout_sha256:sha(stdout),stderr_sha256:sha(stderr)});if(spawnError)throw spawnError;const result=JSON.parse(stdout.trim());resolve({status,result});}catch(e){reject(e);}});
 });
 const first=await cli(['--start',requestFile]),started=first.result;
 if(first.status!==0||started.ok!==true)return started;
 if(started.action==='complete'){
  const settlement=observed(owner)?await settlePreparationInside(raw,ownerTransportAdapter,cliJoins):null;
  return{...started,...(settlement?{owner_window:{status:'closed',reference:settlement.reference}}:{})};
 }
 if(started.action!=='invoke-native')throw error('owner-window-use-canonical-sidecar-continuation');
 const invocation=freezeTree(started.invocation),guard=require('./forge-native-readonly-guard');
 const baseline=request.hostRuntime==='codex'?guard.captureBaseline({owner,codeRoots,mode:'code-only'}):null;
 if(baseline&&baseline.ok!==true)throw error(baseline.reason_code||'owner-window-code-baseline-failed');
 let packet;
 try{const outcome=await invokeNative(invocation);if(outcome?.providerCalled!==true||!Object.prototype.hasOwnProperty.call(outcome,'rawResult'))throw error('native-host-provider-start-unproven');packet={route:started.route,rawResult:outcome.rawResult,invocationTelemetry:invocation.telemetry,providerCalled:true};}
 catch(e){const called=[true,false,'unknown'].includes(e.provider_called)?e.provider_called:'unknown';packet={route:started.route,nativeFailure:{reason_code:/^[a-z0-9-]{1,80}$/.test(e.code||'')?e.code:'native-host-invocation-failed',provider_called:called,...(called===true?{telemetry:invocation.telemetry}:{})}};}
 unchanged();
 // Callback completion and receipt state are insufficient. The opaque adapter
 // must attest all possible writers, including the actual native descendants.
 attestJoined({operation:'join-cli-native-preparation',owner,task_id:request.taskId,dispatch_id:request.dispatchId,request_sha256:prep.preparationRequestFingerprint(request),invocation_sha256:digest(invocation),cli_joins:cliJoins},attest);
 if(baseline){const check=guard.verifyBaseline(baseline.baseline,{writerStopped:true});if(check.ok!==true)packet={route:started.route,nativeFailure:{reason_code:check.reason_code||'native-readonly-surface-changed',provider_called:true,telemetry:invocation.telemetry}};}
 for(const root of [owner,...codeRoots.map(row=>row.path)])xllm.validateResultFileTarget(acceptanceFile,root);
 fs.writeFileSync(acceptanceFile,JSON.stringify(packet)+'\n',{flag:'wx',mode:0o600});
 const second=await cli(['--accept-native',requestFile,acceptanceFile]);
 if(second.status!==0||second.result.ok!==true)return second.result;
 const settlement=observed(owner)?await settlePreparationInside(raw,ownerTransportAdapter,cliJoins):null;
 return{...second.result,...(settlement?{owner_window:{status:'closed',reference:settlement.reference}}:{})};
}

function ensureTask(owner,taskId){const ids=require('./forge-ids');if(!ids.isValid(taskId)||ids.entityKind(taskId)!=='task'||/[\\/\0]/.test(taskId))throw error('owner-task-id-required');return withMutation(owner,()=>{let directory=ownerOf(owner);for(const part of ['.gsd','tasks',taskId]){directory=path.join(directory,part);if(fs.existsSync(directory)){const stat=fs.lstatSync(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw error('owner-task-path-untrusted');}else{if(part==='.gsd')throw error('owner-project-required');fs.mkdirSync(directory);}}return{directory,created:true};});}
function writeBrief(owner,taskId,bytes){return withMutation(owner,()=>{const ensured=ensureTask(owner,taskId),file=path.join(ensured.directory,taskId+'-BRIEF.md');if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile())throw error('owner-task-path-untrusted');if(!fs.readFileSync(file).equals(bytes))throw error('owner-brief-exists');return{file,unchanged:true};}fs.writeFileSync(file,bytes,{flag:'wx'});return{file,created:true};});}
module.exports={open,withWindow,withMutation,assertMutationAllowed,currentPublicationGuard,withPublicationContext,close,recover,observed,controlRoot,metadataOwner,coordinatePreparation,coordinationResult,createTransportAdapter,protectPreparation,settlePreparation,runCliPreparation,ensureTask,writeBrief};
if(require.main===module){try{const[mode,owner,taskId,source]=process.argv.slice(2);const result=mode==='--ensure-task'&&!source?ensureTask(owner,taskId):mode==='--write-brief'&&source?writeBrief(owner,taskId,fs.readFileSync(source)):null;if(!result)throw error('owner-window-usage');process.stdout.write(JSON.stringify(result)+'\n');}catch(e){process.stdout.write(JSON.stringify({ok:false,reason_code:e.code||'owner-window-failed',provider_called:false})+'\n');process.exitCode=1;}}
