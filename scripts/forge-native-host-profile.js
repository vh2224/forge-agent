'use strict';
// TEMP candidate: owner-bound measured fixture profile and private custody.
// Actual Claude foreground/descendant semantics remain unknown and refuse.
const crypto=require('node:crypto'),path=require('node:path');
const profiles=new WeakMap(),PROFILE_ID='claude-agent-foreground-v1',FIXTURE_PROFILE_ID='forge-native463-fixture-foreground-v1',MAX_INPUT=2*1024*1024,METADATA_BYTES=2048;
const INITIAL_PREPARE_TIMEOUT_CAP_MS=600000;
function prepareTimeoutCapMs(){return INITIAL_PREPARE_TIMEOUT_CAP_MS;}
function fail(code){throw Object.assign(new Error(code),{code,stage:'native-host-profile'});}
function plain(value){return value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).every(k=>typeof k==='string')&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>Object.hasOwn(d,'value')&&d.enumerable);}
function closed(value,keys){if(!plain(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail('native-host-observation-schema');}
function text(value,max=256){if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max||/[\x00-\x1f\x7f]/.test(value))fail('native-host-observation-text');
return value;}
function normalizeObservedHostVersion(value){const match=typeof value==='string'&&/^(0|[1-9][0-9]{0,3})[.](0|[1-9][0-9]{0,3})[.](0|[1-9][0-9]{0,5})$/.exec(value);if(!match||match[0]!==value)fail('native-host-observed-version-invalid');return value;}
function parseHostVersionOutput(value){
 if(typeof value!=='string'&&!Buffer.isBuffer(value))fail('native-host-binary-version-unsupported');
 if((typeof value==='string'?Buffer.byteLength(value):value.length)>256)fail('native-host-binary-version-unsupported');
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(value,'utf8');let output=bytes.toString('utf8');
 if(!Buffer.from(output,'utf8').equals(bytes)||output.charCodeAt(0)===65279)fail('native-host-binary-version-unsupported');
 if(output.endsWith('\r\n'))output=output.slice(0,-2);else if(output.endsWith('\n'))output=output.slice(0,-1);
 const suffix=' (Claude Code)';if(!output.endsWith(suffix))fail('native-host-binary-version-unsupported');
 const version=output.slice(0,-suffix.length);try{return normalizeObservedHostVersion(version);}catch{fail('native-host-binary-version-unsupported');}
}
function assertLiveHostBinary(value){
 if(!plain(value)||Object.keys(value).sort().join(',')!=='observed_version,physical_path,sha256')fail('native-host-live-binary-schema');
 if(typeof value.physical_path!=='string'||!path.isAbsolute(value.physical_path)||Buffer.byteLength(value.physical_path)>4096||/[\x00-\x1f\x7f]/.test(value.physical_path)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))fail('native-host-live-binary-schema');
 normalizeObservedHostVersion(value.observed_version);
}
function hash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function canonical(value,depth=0,seen=new Set()){if(depth>32)fail('native-host-observation-depth');
if(value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))return value;
if(typeof value!=='object'||seen.has(value))fail('native-host-observation-json');seen.add(value);
let result;
if(Array.isArray(value)){if(Object.getPrototypeOf(value)!==Array.prototype||value.length>4096)fail('native-host-observation-json');result=value.map(v=>canonical(v,depth+1,seen));}else{if(!plain(value))fail('native-host-observation-json');result=Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k],depth+1,seen)]));}seen.delete(value);
return result;}
function digest(value){const bytes=Buffer.from(JSON.stringify(canonical(value)));
if(bytes.length>MAX_INPUT)fail('native-host-observation-bound');
return hash(bytes);}
function sha(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('native-host-observation-sha256');
return value;}
function normalizeHostObservation(value){closed(value,['schema_version','profile_id','host_session','host_binary','active_tool','mode_support','effort_observation','agent_definition','provenance']);
if(value.schema_version!==1||![PROFILE_ID,FIXTURE_PROFILE_ID].includes(value.profile_id))fail('native-host-profile-unsupported');
if(!['observed-host','fixture-origin'].includes(value.provenance))fail('native-host-observation-provenance');
text(value.host_session);
closed(value.host_binary,['physical_path','sha256','observed_version']);
text(value.host_binary.physical_path,4096);
if(!path.isAbsolute(value.host_binary.physical_path))fail('native-host-observation-path');
sha(value.host_binary.sha256);
text(value.host_binary.observed_version,120);
closed(value.active_tool,['name','schema_sha256','schema','observation_reference']);
if(value.active_tool.name!=='Agent'||!plain(value.active_tool.schema))fail('native-host-tool-schema');
sha(value.active_tool.schema_sha256);
text(value.active_tool.observation_reference,2048);
if(digest(value.active_tool.schema)!==value.active_tool.schema_sha256)fail('native-host-tool-schema-hash');
closed(value.mode_support,['requested_mode','effective_configuration_sha256','observation_reference']);
if(value.mode_support.requested_mode!=='foreground')fail('native-host-mode-unsupported');
sha(value.mode_support.effective_configuration_sha256);
text(value.mode_support.observation_reference,2048);
closed(value.effort_observation,['transport','value','source_fingerprint','observation_reference']);
text(value.effort_observation.transport,120);
text(value.effort_observation.value,120);
sha(value.effort_observation.source_fingerprint);
text(value.effort_observation.observation_reference,2048);
closed(value.agent_definition,['agent_type','physical_path','sha256']);
text(value.agent_definition.agent_type,128);
text(value.agent_definition.physical_path,4096);
if(!path.isAbsolute(value.agent_definition.physical_path))fail('native-host-observation-path');
sha(value.agent_definition.sha256);
digest(value);
return structuredClone(value);}
function normalizeRelayMessage(value){closed(value,['protocol_version','kind','attempt_id','issuer_message_id','host_session','dispatch_id','invocation_sha256','event_type','tool_use_id','agent_id','agent_run_id','capture_reference','capture_sha256']);
if(value.protocol_version!==1||value.kind!=='host-observation')fail('native-host-relay-schema');
for(const k of ['attempt_id','issuer_message_id','host_session','dispatch_id'])text(value[k],128);
sha(value.invocation_sha256);
if(!['PreToolUse','PostToolUse','PostToolUseFailure','SubagentStart','SubagentStop','Handback'].includes(value.event_type))fail('native-host-relay-event');
for(const k of ['tool_use_id','agent_id','agent_run_id','capture_reference'])if(value[k]!==null)text(value[k],k==='capture_reference'?4096:128);
if(value.capture_sha256!==null)sha(value.capture_sha256);
if(Buffer.byteLength(JSON.stringify(canonical(value)))>METADATA_BYTES)fail('native-host-relay-bound');
return structuredClone(value);}
// Native producer IDs hash the ORIGINAL insertion order. canonical() here only
// validates JSON shape; sorted digest() above belongs to this new wire protocol.
function rootsDigest(value){canonical(value);return require('./forge-code-roots').digest(value);}
function privateBytes(value){if(!Buffer.isBuffer(value))fail('native-host-capture-mismatch');const copy=Buffer.alloc(value.length);value.copy(copy);return copy;}
function privateText(value){const bytes=Buffer.alloc(Buffer.byteLength(value));bytes.write(value,'utf8');return bytes;}
function bridge(){return require('./forge-native-host-bridge');}
function requestApi(){return require('./forge-native-host-request');}
function requireFunction(object,key,code){if(typeof object[key]!=='function')fail(code);return object[key];}
function samePath(a,b){return require('./forge-code-roots').key(path.resolve(a))===require('./forge-code-roots').key(path.resolve(b));}
function below(root,target){const r=path.relative(root,target);return r!==''&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);}
function physicalFile(file){const fs=require('node:fs');if(typeof file!=='string'||!path.isAbsolute(file))fail('native-host-profile-source');const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!samePath(fs.realpathSync.native(file),file))fail('native-host-profile-source');if(stat.size>MAX_INPUT)fail('native-host-profile-source-bound');const read=require('./forge-autonomy-sources').readBoundedStableFile(file,MAX_INPUT,{expectedReal:path.resolve(file)});if(read.error||read.stat.nlink!==1)fail('native-host-profile-source-unstable');return Buffer.from(read.buffer);}
function fixtureProtocol(facts,source){
 const proof=source.fixtureProof,fs=require('node:fs');
 if(!proof||typeof proof.root!=='string'||!samePath(path.dirname(proof.root),fs.realpathSync.native(require('node:os').tmpdir()))||!/^forge-native463-fixture-[A-Za-z0-9_-]+$/.test(path.basename(proof.root)))fail('native-host-fixture-origin-unproved');
 const stat=fs.lstatSync(proof.root);if(stat.isSymbolicLink()||!stat.isDirectory()||!samePath(fs.realpathSync.native(proof.root),proof.root))fail('native-host-fixture-origin-unproved');
 const marker=physicalFile(proof.marker_file);if(proof.marker_file!==path.join(proof.root,'FIXTURE-ORIGIN.json')||hash(marker)!==proof.marker_sha256)fail('native-host-fixture-origin-unproved');
 const origin=JSON.parse(marker.toString('utf8'));closed(origin,['schema_version','kind','root']);if(origin.schema_version!==1||origin.kind!=='forge-native463-isolated-fixture'||origin.root!==proof.root)fail('native-host-fixture-origin-unproved');
 for(const file of [facts.owner,...facts.execution_contract.code_roots.map(r=>r.path)])if(!below(proof.root,file)||!proof.contained_roots.some(v=>samePath(v,file)))fail('native-host-fixture-origin-unproved');
 for(const key of ['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR']){const file=process.env[key];if(!file||!below(proof.root,path.resolve(file))||!proof.private_homes.some(v=>samePath(v,file)))fail('native-host-fixture-origin-unproved');}
 const configuration=source.configuration_source;
 if(!Buffer.isBuffer(configuration?.raw)||configuration.raw.length>MAX_INPUT||hash(configuration.raw)!==configuration.sha256)fail('native-host-profile-configuration');
 const config=JSON.parse(configuration.raw.toString('utf8'));
 closed(config,['schema_version','profile_id','fixture_root','fixture_marker_sha256','relay_protocol']);
 if(config.schema_version!==1||config.profile_id!==FIXTURE_PROFILE_ID||config.fixture_root!==proof.root||config.fixture_marker_sha256!==proof.marker_sha256||config.relay_protocol!==FIXTURE_PROFILE_ID)fail('native-host-profile-unsupported');
 return FIXTURE_PROFILE_ID;
}
function capabilities(observation,binding){
 const schema=observation.active_tool.schema,p=schema.properties;
 if(schema.type!=='object'||!plain(p)||p.prompt?.type!=='string'||p.subagent_type?.type!=='string'||!Array.isArray(p.model?.enum)||p.model.enum.some(v=>typeof v!=='string')||!Array.isArray(schema.required)||schema.required.some(k=>!['prompt','subagent_type','model'].includes(k)))fail('native-host-active-tool-schema-unknown');
 if(p.run_in_background&&(p.run_in_background.type!=='boolean'||p.run_in_background.default!==false))fail('native-host-mode-unproved');
 const argumentEffort=Array.isArray(p.effort?.enum)?p.effort.enum:null;
 if(argumentEffort&&argumentEffort.some(v=>typeof v!=='string'))fail('native-host-effort-schema-unknown');
 if(!argumentEffort&&observation.effort_observation.transport!=='agent-frontmatter')fail('native-host-effort-schema-unknown');
 const aliases=p.model.enum.filter(v=>['haiku','sonnet','opus'].includes(v)),ids=p.model.enum.filter(v=>!aliases.includes(v));
 return{available:true,tool:'Agent',source:'native-host-profile-measured-v1',model_aliases:aliases,model_ids:ids,effort_transports:argumentEffort?['agent-argument']:['agent-frontmatter'],...(argumentEffort?{reasoning_efforts:argumentEffort}:{}),...(binding.effort?{}:{})};
}
function hostState(context,witness){
 const b=bridge(),pair=requireFunction(b,'assertHostObservationAndIngress','native-host-observation-producer-unavailable')(witness,context),host=pair.host;
 if(!host||!host.ingressCapability)fail('native-host-ingress-enrollment-required');
 const source=pair.source;
 if(host.observation?.profile_id===LIVE_PROFILE_ID)return liveHostState(context,witness,host,source);
 const observation=normalizeHostObservation(host.observation),facts=requestApi().assertOwnerContext(context);
 if(facts.actor.hostRuntime!=='claude'||facts.actor.sessionId!==observation.host_session||facts.route.effort!==observation.effort_observation.value||source.host_session!==facts.actor.sessionId)fail('native-host-observation-binding');
 const binding=require('./forge-native-invocation').observeClaudeAgentBinding({agentType:observation.agent_definition.agent_type,agentPath:observation.agent_definition.physical_path,sourceFingerprint:observation.agent_definition.sha256});
 if(binding.ok!==true)fail('native-host-agent-definition-unproved');
 if(binding.effort!==facts.route.effort&&observation.effort_observation.transport==='agent-frontmatter')fail('native-host-effort-binding-changed');
 // A JSON Agent schema does not prove actual Claude descendant/join semantics.
 // The only implemented relay derivation here is the physically isolated fixture.
 if(host.provenance!=='fixture-origin'||observation.provenance!=='fixture-origin'||observation.profile_id!==FIXTURE_PROFILE_ID)fail('native-host-foreground-join-schema-unknown');
 const protocol=fixtureProtocol(facts,source),caps=capabilities(observation,binding);
 return{observation,binding,caps,protocol,source,stamp:digest({observation,binding,protocol,currentBinding:host.currentBinding})};
}
function enrollForegroundProfile(context,observationWitness){
 const state=hostState(context,observationWitness),handle=Object.freeze({});
 profiles.set(handle,{context,observationWitness,initial:state,state,sealed:null,requestHandle:null,request:null,toolUseId:null,rootWorker:null,workers:new Map(),capture:null,candidate:null,seen:new Set(),listeners:new Set(),waiters:new Set(),invalid:null});return handle;
}
function current(handle){const row=profiles.get(handle);if(!row)fail('native-host-profile-required');
 if(row.invalid)throw row.invalid;try{const fresh=hostState(row.context,row.observationWitness);if(fresh.stamp!==row.initial.stamp)fail('native-host-profile-changed');row.state=fresh;return row;}catch(error){return invalidate(row,error);}}
// These closures are module-private and receive only an already genuine row.
// No caller callback, option, receipt or JSON field can establish this scope.
function withProfileOperation(handle,operation){
 const row=current(handle);
 try{const value=operation(row);if(value&&typeof value.then==='function')fail('native-host-validation-sync-required');return value;}
 finally{
  // Always re-observe source/process/actor authority, even if the body threw.
  // A stable source preserves the original body error instance.
  try{const fresh=hostState(row.context,row.observationWitness);if(fresh.stamp!==row.initial.stamp)fail('native-host-profile-changed');row.state=fresh;}catch(error){invalidate(row,error);}
 }
}
function canBorrowIntent(row,handle,request){return!!row&&!row.invalid&&!!row.intentFrame&&row.intentFrame.handle===handle&&row.intentFrame.request===request;}
function withIntentFrame(row,handle,request,operation){
 const prior=row.intentFrame;row.intentFrame=Object.freeze({handle,request});
 try{const value=operation();if(value&&typeof value.then==='function')fail('native-host-intent-sync-required');return value;}
 finally{row.intentFrame=prior;}
}
function buildProfileInvocation(handle,row,options){
 // The original canonical builder is synchronous and accepts the literal
 // options built below from assertExecutionRequest's original plain clone.
 const build=()=>require('./forge-native-invocation').buildNativeInvocation(options);
 return row.state.live?withIntentFrame(row,handle,options.nativeHostRequest,build):build();
}
function capabilityAdmissionRow(row){return{profile_id:row.state.protocol,provenance:row.state.live?'observed-host':'fixture-origin',provider_called:row.providerObservation??'unknown',call_instance_ids:row.toolUseId?'observed':'not-yet-observed'};}
function assertCapabilityAdmission(handle){return withProfileOperation(handle,row=>capabilityAdmissionRow(row));}
function invocationOptions(handle,requestHandle){return withProfileOperation(handle,row=>invocationOptionsRow(handle,row,requestHandle));}
function invocationOptionsRow(handle,row,requestHandle){if(row.state.live)return liveInvocationOptionsRow(handle,row,requestHandle);const request=requestApi().assertExecutionRequest(requestHandle,{context:row.context});
 if(row.preparedRequestHandle&&row.preparedRequestHandle!==requestHandle)fail('native-host-profile-request-conflict');
 row.preparedRequestHandle=requestHandle;
 const options={hostRuntime:'claude',resolvedDispatch:request.route,activeCapabilities:structuredClone(row.state.caps),agentType:row.state.observation.agent_definition.agent_type,prompt:request.prompt,promptContext:request.prompt,effortBinding:{transport:row.state.observation.effort_observation.transport,agentPath:row.state.observation.agent_definition.physical_path,sourceFingerprint:row.state.observation.agent_definition.sha256},telemetryIdentity:{dispatchId:request.dispatchId,workflowId:request.workflowId,runId:request.runId,unitType:request.unitType,unitId:request.taskId}};
 const binding=require('./forge-native-invocation').buildNativeInvocation(options);if(binding.ok!==true)fail(binding.reason_code);requestApi().validateExecutionRequest(requestHandle,binding);return options;
}
function assertSynchronousReadBinding(handle,context,requestHandle){
 const row=profiles.get(handle);if(!row||row.context!==context||row.preparedRequestHandle&&row.preparedRequestHandle!==requestHandle)fail('native-host-read-prelude-profile-binding');if(row.invalid)throw row.invalid;return true;
}
function assertActivityAdmission(handle,request){const row=profiles.get(handle);if(!row)fail('native-host-profile-required');if(row.invalid)throw row.invalid;if(!row.preparedRequestHandle)fail('native-host-preflight-required');if(!requestApi().synchronousReadPreludeActive(row.preparedRequestHandle,handle))return requestApi().runSynchronousReadPrelude(row.preparedRequestHandle,handle,'activity-admission',request);return withProfileOperation(handle,row=>{if(!row.preparedRequestHandle)fail('native-host-preflight-required');const original=requestApi().assertExecutionRequest(row.preparedRequestHandle,{context:row.context});if(rootsDigest(original)!==rootsDigest(request))fail('native-host-activity-request-mismatch');invocationOptionsRow(handle,row,row.preparedRequestHandle);return{...capabilityAdmissionRow(row),...(row.state.live?{live_relay_reference:bridge().assertLiveRelayReference(row.observationWitness,row.context,request)}:{})};});}
function bindSealedInvocation(handle,requestHandle,witness,call){return withProfileOperation(handle,row=>{const request=requestApi().assertExecutionRequest(requestHandle,{context:row.context});
 const execution=require('./forge-native-execution'),proof=requireFunction(execution,'assertOriginalCallbackWitness','native-host-original-callback-producer-unavailable')(witness,{request});
 if(!plain(call)||Object.keys(call).sort().join(',')!=='args,invocation'||!plain(call.args)||!plain(call.invocation))fail('native-host-original-callback-data');
 canonical(call.args);canonical(call.invocation);
 const args=structuredClone(call.args),invocation=structuredClone(call.invocation);
 if(proof.dispatch_id!==request.dispatchId||proof.request_sha256!==rootsDigest(request)||proof.arguments_sha256!==rootsDigest(args)||proof.invocation_sha256!==rootsDigest(invocation)||invocation.tool!=='Agent'||rootsDigest(invocation.args)!==rootsDigest(args)||invocation.ok!==true)fail('native-host-original-callback-mismatch');
 if(invocation.host_runtime!=='claude'||invocation.telemetry?.model_resolved!==request.route.model_resolved||invocation.telemetry?.effort_resolved!==request.route.effort)fail('native-host-sealed-route-mismatch');
 // Rebuild from the ACTUAL effective packaged prompt in original callback args.
 const options={...invocationOptionsRow(handle,row,requestHandle),prompt:args.prompt,promptContext:args.prompt},rebuilt=buildProfileInvocation(handle,row,options);
 if(!rebuilt.ok||rootsDigest(rebuilt)!==rootsDigest(invocation))fail('native-host-sealed-arguments-mismatch');
 const sealed={request_sha256:proof.request_sha256,dispatch_id:proof.dispatch_id,arguments_sha256:proof.arguments_sha256,invocation_sha256:proof.invocation_sha256};
 if(row.sealed&&rootsDigest(row.sealed)!==rootsDigest(sealed))fail('native-host-sealed-conflict');
 row.sealed=sealed;row.requestHandle=requestHandle;row.request=request;if(row.state.live)row.liveArgs=structuredClone(args);return describeProfileRow(row);
});}
function assertSealedIntent(handle){const row=current(handle);if(!row.sealed)fail('native-host-sealed-invocation-required');requestApi().assertExecutionRequest(row.requestHandle,{context:row.context});return describeProfile(handle);}
function assertLaunchAdmission(handle){const row=current(handle);assertSealedIntent(handle);if(row.state.live&&!row.executionAdmitted)fail('native-host-original-pretooluse-required');return describeProfile(handle);}
function parsedReturn(raw){const p=require('./forge-worker-result').parseJsonEnvelope(raw.toString('utf8'));if(!p.ok||p.status!==p.payload?.status||require('./forge-native-recovery-delivery').resultContract.validate(p.payload).ok!==true)fail('native-host-return-contract');return p;}
function captured(witness,row,kind){const b=bridge(),read=requireFunction(b,kind==='candidate'?'assertCandidate':'assertObservation','native-host-capture-producer-unavailable'),v=read(witness,row.context);
if(!v||!Buffer.isBuffer(v.raw)||v.raw.length>1024*1024||hash(v.raw)!==v.sha256||v.dispatch_id!==row.sealed?.dispatch_id||v.invocation_sha256!==row.sealed?.invocation_sha256||v.host_session!==row.state.observation.host_session||(row.state.live?v.provenance!=='observed-host'||v.live_authenticated!==true:v.provenance!=='fixture-origin'))fail('native-host-capture-mismatch');
const raw=privateBytes(v.raw);if(hash(raw)!==v.sha256)fail('native-host-capture-mismatch');return{...v,raw};}
function joined(row){
 if(row.state.live&&!row.live?.joinAcknowledged)return false;
 for(const retained of [row.capture,row.candidate])if(retained){if(hash(retained.raw)!==retained.sha256||rootsDigest(parsedReturn(retained.raw).payload)!==rootsDigest(retained.parsed.payload))fail('native-host-retained-capture-changed');}
 return!!row.sealed&&!!row.capture&&!!row.candidate&&!!row.rootWorker&&row.workers.size>0&&[...row.workers.values()].every(w=>w.stopped)&&rootsDigest(row.capture.parsed.payload)===rootsDigest(row.candidate.parsed.payload);}
function snapshot(row){if(!joined(row))fail('native-host-writer-unproven');return{raw:privateBytes(row.capture.raw),candidate_sha256:row.candidate.sha256,joined:true,provider_called:row.providerObservation??'unknown'};}
function notify(row){if(!joined(row))return;for(const listener of row.listeners)listener(snapshot(row));for(const waiter of row.waiters)waiter.resolve(snapshot(row));row.waiters.clear();}
function invalidate(row,error){row.invalid=error;for(const waiter of row.waiters)waiter.reject(error);row.waiters.clear();throw error;}
function admitObservation(handle,witness){const row=current(handle);assertLaunchAdmission(handle);
 try{const capture=captured(witness,row,'observation');if(row.seen.has(capture.sha256))return describeProfile(handle);if(row.seen.size>=1024)fail('native-host-observation-count');
 const event=JSON.parse(capture.raw.toString('utf8'));closed(event,['schema_version','kind','event','host_session','dispatch_id','invocation_sha256','tool_use_id','worker_id','parent_worker_id','result']);
 if(event.schema_version!==1||event.kind!=='forge-native463-fixture-observation'||!['launch','worker-start','worker-stop','foreground-return'].includes(event.event)||event.host_session!==capture.host_session||event.dispatch_id!==capture.dispatch_id||event.invocation_sha256!==capture.invocation_sha256||event.tool_use_id!==capture.tool_use_id)fail('native-host-observed-event-schema');
 for(const key of ['tool_use_id','worker_id'])text(event[key],128);if(event.parent_worker_id!==null)text(event.parent_worker_id,128);
 if(row.toolUseId&&event.tool_use_id!==row.toolUseId)fail('native-host-instance-conflict');
 if(event.event==='launch'){if(row.rootWorker||event.parent_worker_id!==null||event.result!==null)fail('native-host-instance-conflict');row.toolUseId=event.tool_use_id;row.rootWorker=event.worker_id;row.workers.set(event.worker_id,{parent:null,stopped:false});}
 else if(!row.rootWorker)fail('native-host-instance-unbound');
 else if(event.event==='worker-start'){if(row.capture||event.result!==null||row.workers.has(event.worker_id)||!row.workers.has(event.parent_worker_id)||row.workers.get(event.parent_worker_id).stopped)fail('native-host-descendant-conflict');row.workers.set(event.worker_id,{parent:event.parent_worker_id,stopped:false});}
 else if(event.event==='worker-stop'){const worker=row.workers.get(event.worker_id);if(!worker||worker.stopped||worker.parent!==event.parent_worker_id||event.result!==null||[...row.workers.values()].some(w=>w.parent===event.worker_id&&!w.stopped))fail('native-host-descendant-unjoined');worker.stopped=true;}
 else{if(row.capture||event.worker_id!==row.rootWorker||event.parent_worker_id!==null||typeof event.result!=='string')fail('native-host-terminal-conflict');if(Buffer.byteLength(event.result)>1024*1024)fail('native-host-return-bound');const raw=privateText(event.result);row.capture={raw,parsed:parsedReturn(raw),sha256:hash(raw)};}
 row.seen.add(capture.sha256);notify(row);return describeProfile(handle);
 }catch(error){return invalidate(row,error);}
}
function admitCandidate(handle,witness){const row=current(handle);assertLaunchAdmission(handle);try{const v=captured(witness,row,'candidate'),p=parsedReturn(v.raw);if(rootsDigest(v.parsed?.payload)!==rootsDigest(p.payload)||v.parsed?.status!==p.status)fail('native-host-candidate-parser-mismatch');if(row.candidate&&row.candidate.sha256!==v.sha256)fail('native-host-candidate-conflict');if(row.capture&&rootsDigest(row.capture.parsed.payload)!==rootsDigest(p.payload))fail('native-host-candidate-capture-mismatch');row.candidate={raw:privateBytes(v.raw),parsed:p,sha256:v.sha256};notify(row);return describeProfile(handle);}catch(error){return invalidate(row,error);}}
function describeProfileRow(row){return{profile_id:row.state.protocol,provenance:row.state.live?'observed-host':'fixture-origin',stage:joined(row)?'joined':row.capture?'terminal-awaiting-join-or-candidate':row.sealed?'sealed':'capability',tool_use_id:row.toolUseId,known_workers:row.workers.size,joined:joined(row),provider_called:row.providerObservation??'unknown',sealed_sha256:row.sealed?digest(row.sealed):null};}
function describeProfile(handle){return describeProfileRow(current(handle));}
function subscribe(handle,listener){const row=current(handle);if(typeof listener!=='function')fail('native-host-subscription-required');row.listeners.add(listener);if(joined(row))listener(snapshot(row));return()=>row.listeners.delete(listener);}
function awaitJoinedReturn(handle){const row=current(handle);if(joined(row))return Promise.resolve(snapshot(row));return new Promise((resolve,reject)=>row.waiters.add({resolve,reject}));}
function assertJoined(handle){const row=current(handle);return snapshot(row);}
function assertPublicationAttemptCurrent(handle,witness){
 const row=profiles.get(handle);if(!row)fail('native-host-profile-required');if(row.invalid)throw row.invalid;
 if(!row.requestHandle||!row.sealed||!joined(row))fail('native-host-writer-unproven');
 const native=require('./forge-native-execution'),check=requireFunction(native,'assertOriginalPublicationAttemptWitness','native-host-publication-producer-unavailable');
 const proof=check(witness,{request:row.request});
 if(!proof||proof.dispatch_id!==row.sealed.dispatch_id||proof.request_sha256!==row.sealed.request_sha256||proof.result_sha256!==rootsDigest(row.capture.parsed.payload))fail('native-host-publication-binding');
 requestApi().assertExecutionRequest(row.requestHandle,{context:row.context,publicationAttemptWitness:witness});
 return snapshot(current(handle));
}
function assertPublicationCurrent(handle,witness){
 const row=profiles.get(handle);if(!row)fail('native-host-profile-required');if(row.invalid)throw row.invalid;
 if(!row.requestHandle||!row.sealed||!joined(row))fail('native-host-writer-unproven');
 const native=require('./forge-native-execution'),check=requireFunction(native,'assertOriginalPublicationWitness','native-host-publication-producer-unavailable');
 const proof=check(witness,{request:row.request});
 if(!proof||proof.dispatch_id!==row.sealed.dispatch_id||proof.request_sha256!==row.sealed.request_sha256||proof.result_sha256!==rootsDigest(row.capture.parsed.payload))fail('native-host-publication-binding');
 requestApi().assertExecutionRequest(row.requestHandle,{context:row.context,publicationWitness:witness});
 return snapshot(current(handle));
}
function terminalResult(handle,result){const row=current(handle);return joined(row)&&rootsDigest(row.capture.parsed.payload)===rootsDigest(result);}
// Supported observed subset, not an invented full Agent JSON schema.
const LIVE_PROFILE_ID='claude-agent-files-foreground-v1';
function liveKeys(value,allowed,required=allowed){if(!plain(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))fail('native-host-live-schema-unknown');}
function liveCount(v,max=1000000000){if(!Number.isSafeInteger(v)||v<0||v>max)fail('native-host-live-count');}
function liveHostState(context,witness,host,source){
 const facts=requestApi().assertOwnerContext(context),v=host.observation;
 liveKeys(v,['schema_version','profile_id','host_session','provenance','host_binary','agent_definition','effort_requested','model_requested']);
 assertLiveHostBinary(v.host_binary);
 if(v.schema_version!==1||v.profile_id!==LIVE_PROFILE_ID||v.provenance!=='observed-host'||host.provenance!=='observed-host'||source.provenance!=='observed-host'||facts.actor.hostRuntime!=='claude'||facts.actor.sessionId!==v.host_session||source.host_session!==v.host_session||v.effort_requested!==facts.route.effort||v.model_requested!==(facts.route.model_resolved||facts.route.model))fail('native-host-live-binding');
 const binding=require('./forge-native-invocation').observeClaudeAgentBinding({agentType:v.agent_definition.agent_type,agentPath:v.agent_definition.physical_path,sourceFingerprint:v.agent_definition.sha256});
 if(binding.ok!==true||v.agent_definition.agent_type!=='forge-native-files')fail('native-host-agent-definition-unproved');
 return{live:true,observation:structuredClone(v),binding,protocol:LIVE_PROFILE_ID,source,stamp:digest({observation:v,binding,currentBinding:host.currentBinding})};
}
function invocationIntentRow(row,request){if(!row.state.live)fail('native-host-live-intent-required');if(!row.preparedRequestHandle||rootsDigest(requestApi().assertExecutionRequest(row.preparedRequestHandle,{context:row.context}))!==rootsDigest(request))fail('native-host-live-request');return Object.freeze({profile_id:LIVE_PROFILE_ID,tool:'Agent',agent_type:'forge-native-files',model_resolved:request.route.model_resolved||request.route.model,effort:request.route.effort,model_aliases:['haiku','sonnet','opus'],effort_transport:'agent-argument',source_fingerprint:row.state.observation.agent_definition.sha256,execution_admitted:false});}
function assertInvocationIntent(handle,{request}={}){
 const row=profiles.get(handle);if(!row)fail('native-host-profile-required');if(row.invalid)throw row.invalid;
 if(canBorrowIntent(row,handle,request))return invocationIntentRow(row,request);
 return withProfileOperation(handle,validated=>invocationIntentRow(validated,request));
}
function liveInvocationOptionsRow(handle,row,requestHandle){const request=requestApi().assertExecutionRequest(requestHandle,{context:row.context});if(row.preparedRequestHandle&&row.preparedRequestHandle!==requestHandle)fail('native-host-profile-request-conflict');row.preparedRequestHandle=requestHandle;
 const options={hostRuntime:'claude',resolvedDispatch:request.route,nativeHostIntent:handle,nativeHostRequest:request,agentType:'forge-native-files',prompt:request.prompt,promptContext:request.prompt,effortBinding:{transport:'agent-argument',agentPath:row.state.observation.agent_definition.physical_path,sourceFingerprint:row.state.observation.agent_definition.sha256},telemetryIdentity:{dispatchId:request.dispatchId,workflowId:request.workflowId,runId:request.runId,unitType:request.unitType,unitId:request.taskId}};
 const preflight=buildProfileInvocation(handle,row,options);if(!preflight.ok)fail(preflight.reason_code);requestApi().validateExecutionRequest(requestHandle,preflight);return options;
}
function liveReturnSchema(value,row){
 const fields=['status','prompt','agentId','agentType','toolsUsed','harnessNoteCount','harnessTailCount','harnessSectionHash','content','resolvedModel','totalDurationMs','totalTokens','totalToolUseCount','usage','toolStats','canContinueAgent'];liveKeys(value,fields);
 const l=row.live;if(value.status!=='completed'||value.agentId!==l.agentId||value.agentType!=='forge-native-files'||hash(value.prompt)!==hash(row.liveArgs.prompt)||value.canContinueAgent!==false||l.pending.size||!l.started||!l.stopped)fail('native-host-live-agent-return-unjoined');
 liveCount(value.totalToolUseCount);if(value.totalToolUseCount!==l.completed.size)fail('native-host-live-tool-ledger');
 const used=[...new Set([...l.completed.values()].map(v=>v.tool))].sort();if(!Array.isArray(value.toolsUsed)||new Set(value.toolsUsed).size!==value.toolsUsed.length||JSON.stringify([...value.toolsUsed].sort())!==JSON.stringify(used))fail('native-host-live-tool-ledger');
 const counts={Read:0,Write:0};for(const v of l.completed.values())counts[v.tool]++;
 liveKeys(value.toolStats,['readCount','searchCount','bashCount','editFileCount','linesAdded','linesRemoved','otherToolCount']);for(const n of Object.values(value.toolStats))liveCount(n);
 if(value.toolStats.readCount!==counts.Read||value.toolStats.editFileCount!==counts.Write||value.toolStats.searchCount!==0||value.toolStats.bashCount!==0||value.toolStats.otherToolCount!==0)fail('native-host-live-tool-ledger');
 for(const k of ['harnessNoteCount','harnessTailCount'])liveCount(value[k],256);if(typeof value.harnessSectionHash!=='string'||!/^[a-f0-9]{16}$/.test(value.harnessSectionHash))fail('native-host-live-harness');for(const k of ['totalDurationMs','totalTokens'])liveCount(value[k]);text(value.resolvedModel,128);
 if(value.resolvedModel!==(row.request.route.model_resolved||row.request.route.model))fail('native-host-live-model-mismatch');
 liveUsage(value.usage);
 if(!Array.isArray(value.content)||!value.content.length||value.content.length>256)fail('native-host-live-return-content');for(const b of value.content){liveKeys(b,['type','text','citations'],['type','text']);if(b.type!=='text'||typeof b.text!=='string'||Buffer.byteLength(b.text)>32768||b.citations!==undefined&&b.citations!==null&&(!Array.isArray(b.citations)||b.citations.length))fail('native-host-live-return-content');}
 const raw=privateText(value.content.map(b=>b.text).join('\n'));parsedReturn(raw);return{raw,provider_called:value.usage.input_tokens>0||value.usage.output_tokens>0?true:'unknown',observed_model:value.resolvedModel,service_applied_effort:'unknown'};
}
function liveCacheUsage(v){liveKeys(v,['ephemeral_1h_input_tokens','ephemeral_5m_input_tokens']);for(const n of Object.values(v))liveCount(n);}
function liveUsage(v){
 liveKeys(v,['output_tokens_details','input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens','server_tool_use','service_tier','cache_creation','inference_geo','iterations','speed','fallback_credit']);for(const k of ['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'])liveCount(v[k]);liveKeys(v.output_tokens_details,['thinking_tokens']);liveCount(v.output_tokens_details.thinking_tokens);liveKeys(v.server_tool_use,['web_search_requests','web_fetch_requests']);if(v.server_tool_use.web_search_requests!==0||v.server_tool_use.web_fetch_requests!==0)fail('native-host-live-server-tool');
 liveCacheUsage(v.cache_creation);if(v.cache_creation.ephemeral_1h_input_tokens+v.cache_creation.ephemeral_5m_input_tokens!==v.cache_creation_input_tokens)fail('native-host-live-cache-total');for(const k of ['service_tier','inference_geo','speed'])text(v[k],128);if(v.fallback_credit!==null)fail('native-host-live-fallback-credit');
 if(!Array.isArray(v.iterations)||!v.iterations.length||v.iterations.length>256)fail('native-host-live-usage-iterations');const sums={input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};for(const item of v.iterations){liveKeys(item,['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens','cache_creation','type']);if(item.type!=='message')fail('native-host-live-usage-iterations');liveCacheUsage(item.cache_creation);for(const k of Object.keys(sums)){liveCount(item[k]);sums[k]+=item[k];}if(item.cache_creation.ephemeral_1h_input_tokens+item.cache_creation.ephemeral_5m_input_tokens!==item.cache_creation_input_tokens)fail('native-host-live-cache-total');}for(const k of Object.keys(sums))if(sums[k]!==v[k])fail('native-host-live-usage-total');
}
function liveToolPath(row,input,write){
 const r=row.request,roots=require('./forge-code-roots'),facts=requestApi().assertOwnerContext(row.context);text(input.file_path,4096);if(!path.isAbsolute(input.file_path))fail('native-host-live-file-absolute');const owner=facts.owner,file=path.resolve(input.file_path);if(below(owner,file)||samePath(owner,file))fail('native-host-live-owner-file-prohibited');
 const root=r.execution_contract.code_roots.find(v=>below(v.path,file));if(!root)fail('native-host-live-file-outside-code');const relative=path.relative(root.path,file).split(path.sep).join('/');if(relative.split('/').some(p=>['.git','.gsd','.claude','.codex','.agents','.forge-personal'].includes(p)))fail('native-host-live-protected-file');const target=roots.resolvePath(r.execution_contract,{root_id:root.id,path:relative});
 if(write&&!facts.writes.some(v=>roots.covers(v,target)))fail('native-host-live-file-outside-plan');if(require('node:fs').existsSync(target.absolute))physicalFile(target.absolute);return target;
}
function liveCommon(raw,row,phase){
 const common=['session_id','transcript_path','cwd','prompt_id','permission_mode','effort','agent_id','agent_type','hook_event_name'];
 const extra={pre:['tool_name','tool_input','tool_use_id'],post:['tool_name','tool_input','tool_response','tool_use_id','duration_ms'],'subagent-start':[],'subagent-stop':['stop_hook_active','agent_transcript_path','last_assistant_message','background_tasks','session_crons']};
 if(!Object.hasOwn(extra,phase))fail('native-host-live-event-unsupported');liveKeys(raw,[...common,...extra[phase]],['session_id','cwd','hook_event_name',...(['pre','post'].includes(phase)?['tool_name','tool_input','tool_use_id']:['agent_id','agent_type'])]);
 if(raw.session_id!==row.state.observation.host_session||raw.hook_event_name!==({pre:'PreToolUse',post:'PostToolUse','subagent-start':'SubagentStart','subagent-stop':'SubagentStop'})[phase])fail('native-host-live-event-binding');text(raw.cwd,4096);text(raw.transcript_path,4096);if(raw.prompt_id!==undefined)text(raw.prompt_id,128);if(raw.permission_mode!==undefined)text(raw.permission_mode,128);if(raw.duration_ms!==undefined)liveCount(raw.duration_ms);if(raw.effort!==undefined){liveKeys(raw.effort,['level']);if(raw.effort.level!==row.request.route.effort)fail('native-host-live-effort-mismatch');}
}
function admitLiveObservation(handle,witness){const row=current(handle);if(!row.state.live||!row.sealed||!row.liveArgs)fail('native-host-live-seal-required');try{
 const v=captured(witness,row,'observation');if(v.live_authenticated!==true)fail('native-host-live-producer-required');const raw=JSON.parse(v.raw.toString('utf8')),phase=v.event_type;liveCommon(raw,row,phase);
 const l=row.live||(row.live={agentTool:null,agentId:null,started:false,stopped:false,pending:new Map(),completed:new Map(),returned:false});
 if(phase==='subagent-start'){if(l.started||l.returned||!l.agentTool||raw.agent_type!=='forge-native-files')fail('native-host-live-descendant-unsupported');text(raw.agent_id,128);l.agentId=raw.agent_id;l.started=true;row.toolUseId=l.agentTool;row.rootWorker=raw.agent_id;row.workers.set(raw.agent_id,{parent:null,stopped:false});}
 else if(phase==='subagent-stop'){if(!l.started||l.stopped||raw.agent_id!==l.agentId||raw.agent_type!=='forge-native-files'||l.pending.size||!Array.isArray(raw.background_tasks)||raw.background_tasks.length||!Array.isArray(raw.session_crons)||raw.session_crons.length)fail('native-host-live-descendants-pending');l.stopped=true;row.workers.get(l.agentId).stopped=true;/* Stop is not terminal/join authority. */}
 else if(raw.tool_name==='Agent'){
  if(raw.agent_id!==undefined||raw.agent_type!==undefined)fail('native-host-live-nested-agent');text(raw.tool_use_id,128);if(digest(raw.tool_input)!==digest(row.liveArgs))fail('native-host-live-original-args-mismatch');
  if(phase==='pre'){if(!l.prepareAcknowledged)fail('native-host-original-prepare-handoff-required');if(l.agentTool||l.returned)fail('native-host-live-agent-count');l.agentTool=raw.tool_use_id;row.executionAdmitted=true;assertLaunchAdmission(handle);}
  else{if(raw.tool_use_id!==l.agentTool||l.returned)fail('native-host-live-agent-id');const result=liveReturnSchema(raw.tool_response,row);row.capture={raw:privateBytes(result.raw),parsed:parsedReturn(result.raw),sha256:hash(result.raw)};row.providerObservation=result.provider_called;row.observedModel=result.observed_model;l.returned=true;notify(row);return{capture:privateBytes(result.raw),provider_called:result.provider_called};}
 }else if(raw.agent_id===undefined){
  if(raw.tool_name!=='Bash')fail('native-host-live-parent-tool');liveKeys(raw.tool_input,['command','description','timeout'],['command']);
  if(phase==='post'&&!l.prepareAcknowledged&&!l.agentTool&&!l.started&&!l.returned&&!l.control&&!l.pending.size){const selected=bridge().validateInitialPrepareCommand(raw.tool_input.command);if(selected){if(raw.tool_input.timeout!==undefined&&(!Number.isSafeInteger(raw.tool_input.timeout)||raw.tool_input.timeout<1||raw.tool_input.timeout>prepareTimeoutCapMs()))fail('native-host-live-prepare-timeout');const originalPost=bridge().assertOriginalPreparePost(row.observationWitness,row.context,raw);l.initialPrepareToolUseId=originalPost.tool_use_id;l.prepareAcknowledged=true;return{initial_prepare_handoff:true};}}
  if(typeof raw.tool_input.command!=='string'||!bridge().assertLiveControlCommand(row.observationWitness,row.context,raw.tool_input.command))fail('native-host-live-parent-command');if(raw.tool_input.timeout!==undefined&&(!Number.isSafeInteger(raw.tool_input.timeout)||raw.tool_input.timeout<1||raw.tool_input.timeout>20000))fail('native-host-live-parent-command');
  text(raw.tool_use_id,128);if(phase==='pre'){if(l.control)fail('native-host-live-parent-command-pending');l.control={tool_use_id:raw.tool_use_id,command:raw.tool_input.command};}else{if(!l.control||l.control.tool_use_id!==raw.tool_use_id||l.control.command!==raw.tool_input.command)fail('native-host-live-parent-command-binding');l.control=null;if(row.capture&&row.candidate&&!l.pending.size&&l.returned&&l.stopped)l.joinAcknowledged=true;notify(row);}return{control:{phase,tool_use_id:raw.tool_use_id,command:raw.tool_input.command}};
 }else{
  if(!l.started||l.stopped||l.returned||raw.agent_id!==l.agentId||raw.agent_type!=='forge-native-files'||!['Read','Write'].includes(raw.tool_name))fail('native-host-live-worker-tool');text(raw.tool_use_id,128);liveKeys(raw.tool_input,raw.tool_name==='Read'?['file_path']:['file_path','content']);if(raw.tool_name==='Write'&&(typeof raw.tool_input.content!=='string'||Buffer.byteLength(raw.tool_input.content)>MAX_INPUT))fail('native-host-live-write-bound');const target=liveToolPath(row,raw.tool_input,raw.tool_name==='Write');
  if(phase==='pre'){if(l.pending.size||l.pending.has(raw.tool_use_id)||l.completed.has(raw.tool_use_id)||l.pending.size+l.completed.size>=1024)fail('native-host-live-tool-order');l.pending.set(raw.tool_use_id,{tool:raw.tool_name,input_sha256:rootsDigest(raw.tool_input),path:target.absolute});}
  else{const before=l.pending.get(raw.tool_use_id);if(!before||before.tool!==raw.tool_name||before.input_sha256!==rootsDigest(raw.tool_input)||!plain(raw.tool_response))fail('native-host-live-tool-completion');liveFileResponse(raw,row,target);l.pending.delete(raw.tool_use_id);l.completed.set(raw.tool_use_id,before);}
 }
 return{admitted:true};
 }catch(error){return invalidate(row,error);}}
function liveFileResponse(raw,row,target){const v=raw.tool_response;if(raw.tool_name==='Read'){liveKeys(v,['type','file']);liveKeys(v.file,['filePath','content','numLines','startLine','totalLines']);if(v.type!=='text'||!samePath(v.file.filePath,target.absolute)||typeof v.file.content!=='string'||Buffer.byteLength(v.file.content)>MAX_INPUT)fail('native-host-live-read-response');for(const k of ['numLines','startLine','totalLines'])liveCount(v.file[k]);}
 else{liveKeys(v,['type','filePath','content','structuredPatch','originalFile','userModified']);if(!['create','update'].includes(v.type)||!samePath(v.filePath,target.absolute)||v.content!==raw.tool_input.content||!Array.isArray(v.structuredPatch)||v.structuredPatch.length>4096||v.originalFile!==null&&typeof v.originalFile!=='string'||typeof v.userModified!=='boolean'||!physicalFile(target.absolute).equals(Buffer.from(raw.tool_input.content)))fail('native-host-live-write-response');}}

module.exports={assertSynchronousReadBinding,prepareTimeoutCapMs,LIVE_PROFILE_ID,assertInvocationIntent,assertSealedIntent,admitLiveObservation,PROFILE_ID,FIXTURE_PROFILE_ID,normalizeHostObservation,normalizeRelayMessage,enrollForegroundProfile,assertCapabilityAdmission,assertActivityAdmission,invocationOptions,bindSealedInvocation,assertLaunchAdmission,describeProfile,admitObservation,admitCandidate,subscribe,awaitJoinedReturn,assertJoined,assertPublicationAttemptCurrent,assertPublicationCurrent,terminalResult,normalizeObservedHostVersion,parseHostVersionOutput};
