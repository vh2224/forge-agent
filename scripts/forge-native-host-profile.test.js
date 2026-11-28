'use strict';
// Pure wire checks and capability non-forgeability; no injected host callbacks.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');
const saved={...process.env},root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-native463-profile-'))),marker=crypto.randomBytes(16).toString('hex');fs.writeFileSync(path.join(root,'OWNED'),marker);
for(const key of ['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR','FORGE_HOME']){process.env[key]=path.join(root,key.toLowerCase());fs.mkdirSync(process.env[key],{recursive:true});}
const profile=require('./forge-native-host-profile');
function digest(x){const order=v=>Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v;return crypto.createHash('sha256').update(JSON.stringify(order(x))).digest('hex');}
const schema={type:'object',properties:{prompt:{type:'string'},subagent_type:{type:'string'},model:{enum:['sonnet']}},required:['prompt','subagent_type','model']};
const value={schema_version:1,profile_id:profile.FIXTURE_PROFILE_ID,host_session:'fixture-session',host_binary:{physical_path:path.join(root,'host.cjs'),sha256:'1'.repeat(64),observed_version:'fixture-only'},active_tool:{name:'Agent',schema_sha256:digest(schema),schema,observation_reference:path.join(root,'schema.json')},mode_support:{requested_mode:'foreground',effective_configuration_sha256:'2'.repeat(64),observation_reference:path.join(root,'configuration.json')},effort_observation:{transport:'agent-frontmatter',value:'high',source_fingerprint:'3'.repeat(64),observation_reference:path.join(root,'agent.md')},agent_definition:{agent_type:'forge-executor',physical_path:path.join(root,'agent.md'),sha256:'3'.repeat(64)},provenance:'fixture-origin'};
try{
 // version-grammar: exact primitive version data, without granting support.
 for(const version of ['0.0.0','2.1.322','2.1.400','10.20.300','9999.9999.999999'])assert.equal(profile.normalizeObservedHostVersion(version),version);
 for(const version of ['', 'v2.1.322','2.1','2.1.322.1','2.1.322-beta',' 2.1.322','2.1.322 ','2.1.322\n','2.1.322\r','2.1.322\u2028','02.1.3','2.01.3','2.1.0322','10000.0.0','0.10000.0','0.0.1000000',1,null,{},new String('2.1.322')])assert.throws(()=>profile.normalizeObservedHostVersion(version),e=>e.code==='native-host-observed-version-invalid');
 let versionGetterCalls=0;const getterVersion=Object.defineProperty({},'version',{get(){versionGetterCalls++;throw Error('not data');}});assert.throws(()=>profile.normalizeObservedHostVersion(getterVersion),e=>e.code==='native-host-observed-version-invalid');assert.equal(versionGetterCalls,0);
 // version-output: only the canonical single-line CLI response is data.
 for(const end of ['','\n','\r\n'])for(const output of ['2.1.322 (Claude Code)'+end,Buffer.from('2.1.322 (Claude Code)'+end)])assert.equal(profile.parseHostVersionOutput(output),'2.1.322');
 for(const output of ['v22.12.0\n','2.1.322\n','2.1.322 (claude code)','2.1.322  (Claude Code)','prefix 2.1.322 (Claude Code)','2.1.322 (Claude Code) suffix','2.1.322 (Claude Code)\nsecond','2.1.322 (Claude Code)\n\n','\uFEFF2.1.322 (Claude Code)',Buffer.from([0xff]),'x'.repeat(257),Buffer.alloc(257),{},null])assert.throws(()=>profile.parseHostVersionOutput(output),e=>e.code==='native-host-binary-version-unsupported');
 assert.deepEqual(profile.normalizeHostObservation(value),value);
 for(const change of [v=>{v.joined=true;},v=>{v.provider_called=true;},v=>{v.mode_support.requested_mode='background';},v=>{v.profile_id='unknown';},v=>{v.active_tool.schema_sha256='0'.repeat(64);},v=>{v.host_binary.physical_path='relative';}]){const candidate=structuredClone(value);change(candidate);assert.throws(()=>profile.normalizeHostObservation(candidate));}
 const accessor=Object.defineProperty({...value},'host_session',{enumerable:true,get(){throw Error('must not invoke getter');}});assert.throws(()=>profile.normalizeHostObservation(accessor),e=>e.code==='native-host-observation-schema');
 assert.throws(()=>profile.enrollForegroundProfile({},value));
 for(const call of [()=>profile.assertProtectedOwner({},{},{}),()=>profile.assertCapabilityAdmission({}),()=>profile.assertActivityAdmission({},{}),()=>profile.invocationOptions({},{}),()=>profile.bindSealedInvocation({},{},{},{args:{},invocation:{}}),()=>profile.assertLaunchAdmission({}),()=>profile.admitObservation({},value),()=>profile.admitCandidate({},value),()=>profile.subscribe({},()=>{}),()=>profile.assertJoined({}),()=>profile.assertPublicationAttemptCurrent({},{}),()=>profile.assertPublicationCurrent({},{}),()=>profile.terminalResult({},{status:'done'})])assert.throws(call);
 assert.throws(()=>profile.awaitJoinedReturn({}));
 // DATA-only access to the original private synchronous frame helpers. This
 // does not expose profiles/WeakMap factories or mint an enrolled profile.
 const Module=require('node:module'),filename=require.resolve('./forge-native-host-profile'),sourceBytes=fs.readFileSync(filename),copy=new Module(filename+'#frame-data',module);copy.filename=filename;copy.paths=Module._nodeModulePaths(path.dirname(filename));
 // Private DATA dependency observations exercise actual call ordering only.
 // They neither create a real owner context nor a production profile capability.
 let dataBindingCalls=0;const dataBindings=[],dataFacts={actor:{hostRuntime:'claude',sessionId:'DATA-only-session'},route:{effort:'high',model:'DATA-only-model'}},originalCopyRequire=copy.require.bind(copy);
 copy.require=name=>name==='./forge-native-host-request'?{assertOwnerContext(){return dataFacts;}}:name==='./forge-native-invocation'?{observeClaudeAgentBinding(binding){dataBindingCalls++;dataBindings.push(binding);return{ok:true};}}:originalCopyRequire(name);
 copy._compile(sourceBytes.toString('utf8')+'\nmodule.exports.__frameData={withIntentFrame,canBorrowIntent,assertLiveHostBinary,liveHostState,seedPreludeProfile:(h,row)=>profiles.set(h,row)};\n',filename);const frameData=copy.exports.__frameData;
 // live-host-binary is private DATA validation, never enrollment authority.
 const binary={physical_path:path.join(root,'host.cjs'),sha256:'1'.repeat(64),observed_version:'2.1.322'};
 const dataObservation={schema_version:1,profile_id:profile.LIVE_PROFILE_ID,host_session:dataFacts.actor.sessionId,provenance:'observed-host',host_binary:binary,agent_definition:{agent_type:'forge-native-files',physical_path:path.join(root,'agent.md'),sha256:'3'.repeat(64)},effort_requested:dataFacts.route.effort,model_requested:dataFacts.route.model},dataSource={provenance:'observed-host',host_session:dataFacts.actor.sessionId};
 assert.throws(()=>frameData.liveHostState({}, {}, {observation:{...dataObservation,host_binary:{...binary,observed_version:'fixture-only'}},provenance:'observed-host',currentBinding:{}},dataSource),e=>e.code==='native-host-observed-version-invalid');assert.equal(dataBindingCalls,0,'invalid binary data never reaches the Agent-binding dependency');
 frameData.liveHostState({}, {}, {observation:dataObservation,provenance:'observed-host',currentBinding:{}},dataSource);assert.equal(dataBindingCalls,1);assert.deepEqual(dataBindings[0],{agentType:'forge-native-files',agentPath:dataObservation.agent_definition.physical_path,sourceFingerprint:dataObservation.agent_definition.sha256});

 for(const version of ['2.1.322','2.1.400'])assert.equal(frameData.assertLiveHostBinary({...binary,observed_version:version}),undefined);
 for(const change of [v=>{v.supported=true;},v=>{delete v.sha256;},v=>{v.physical_path='relative';},v=>{v.physical_path+='\0';},v=>{v.physical_path+= 'x'.repeat(4097);},v=>{v.sha256='A'.repeat(64);},v=>{v.sha256='1'.repeat(63);}]){const candidate={...binary};change(candidate);assert.throws(()=>frameData.assertLiveHostBinary(candidate),e=>e.code==='native-host-live-binary-schema');}
 assert.throws(()=>frameData.assertLiveHostBinary({...binary,observed_version:'fixture-only'}),e=>e.code==='native-host-observed-version-invalid');
 for(const key of Object.keys(binary)){let calls=0;const candidate=Object.defineProperty({...binary},key,{enumerable:true,get(){calls++;throw Error('getter must remain uncalled');}});assert.throws(()=>frameData.assertLiveHostBinary(candidate),e=>e.code==='native-host-live-binary-schema');assert.equal(calls,0);}
 assert.equal(profile.PROFILE_ID,'claude-agent-foreground-v1');assert.equal(profile.FIXTURE_PROFILE_ID,'forge-native463-fixture-foreground-v1');
 assert(!/['"][0-9]+[.][0-9]+[.][0-9]+['"]/.test(sourceBytes.toString('utf8')),'observed version is never a catalog literal');
 assert(!/['"][a-fA-F0-9]{64}['"]/.test(sourceBytes.toString('utf8')),'no catalog executable hash is introduced');

 const scratch={},handle=Object.freeze({}),otherHandle=Object.freeze({}),request=Object.freeze({kind:'synthetic-DATA-only'}),otherRequest=Object.freeze({kind:'synthetic-DATA-only'});
 assert.equal(frameData.canBorrowIntent(scratch,handle,request),false);
 assert.equal(frameData.withIntentFrame(scratch,handle,request,()=>{assert.equal(frameData.canBorrowIntent(scratch,handle,request),true);assert.equal(frameData.canBorrowIntent(scratch,otherHandle,request),false);assert.equal(frameData.canBorrowIntent(scratch,handle,otherRequest),false);assert.throws(()=>copy.exports.assertInvocationIntent(handle,{request}),e=>e.code==='native-host-profile-required','a scratch frame cannot forge the real profile WeakMap');return 7;}),7);assert.equal(scratch.intentFrame,undefined);
 const sentinel=new Error('DATA-only-sentinel');assert.throws(()=>frameData.withIntentFrame(scratch,handle,request,()=>{throw sentinel;}),e=>e===sentinel);assert.equal(scratch.intentFrame,undefined);
 frameData.withIntentFrame(scratch,handle,request,()=>{const outer=scratch.intentFrame;frameData.withIntentFrame(scratch,otherHandle,otherRequest,()=>{assert.equal(frameData.canBorrowIntent(scratch,handle,request),false);assert.equal(frameData.canBorrowIntent(scratch,otherHandle,otherRequest),true);});assert.strictEqual(scratch.intentFrame,outer);assert.equal(frameData.canBorrowIntent(scratch,handle,request),true);});assert.equal(scratch.intentFrame,undefined);
 const escaped=frameData.withIntentFrame(scratch,handle,request,()=>()=>frameData.canBorrowIntent(scratch,handle,request));assert.equal(escaped(),false);
 assert.throws(()=>frameData.withIntentFrame(scratch,handle,request,()=>({then(){}})),e=>e.code==='native-host-intent-sync-required');assert.equal(scratch.intentFrame,undefined);
 let getterCalls=0;const getter=Object.defineProperty({},'then',{get(){getterCalls++;throw sentinel;}});assert.throws(()=>frameData.withIntentFrame(scratch,handle,request,()=>getter),e=>e===sentinel);assert.equal(getterCalls,1);assert.equal(scratch.intentFrame,undefined);
 frameData.withIntentFrame(scratch,handle,request,()=>{scratch.invalid=sentinel;assert.equal(frameData.canBorrowIntent(scratch,handle,request),false);delete scratch.invalid;});assert.equal(scratch.intentFrame,undefined);

 const pc={},ph={},rh={},differentRequest={},prow={context:pc,preparedRequestHandle:rh};frameData.seedPreludeProfile(ph,prow);
 assert.equal(copy.exports.assertSynchronousReadBinding(ph,pc,rh),true);
 for(const args of [[{},pc,rh],[ph,{},rh],[ph,pc,differentRequest]])assert.throws(()=>copy.exports.assertSynchronousReadBinding(...args),e=>e.code==='native-host-read-prelude-profile-binding');
 let delegated=0;const previousRequire=copy.require;copy.require=name=>name==='./forge-native-host-request'?{synchronousReadPreludeActive(h,p){assert.equal(h,rh);assert.equal(p,ph);return false;},runSynchronousReadPrelude(h,p,kind,r){delegated++;assert.equal(h,rh);assert.equal(p,ph);assert.equal(kind,'activity-admission');assert.equal(r,differentRequest);return{test_only:true};}}:previousRequire(name);
 assert.deepEqual(copy.exports.assertActivityAdmission(ph,differentRequest),{test_only:true});assert.equal(delegated,1);
 const invalidPrelude=new Error('TEST_INVALID_PROFILE');prow.invalid=invalidPrelude;assert.throws(()=>copy.exports.assertActivityAdmission(ph,differentRequest),e=>e===invalidPrelude);assert.throws(()=>copy.exports.assertSynchronousReadBinding(ph,pc,rh),e=>e===invalidPrelude);assert.equal(delegated,1);copy.require=previousRequire;

 // Only a genuine private test-row can delegate the new closed operation; JSON/public handles still fail.
 const ownerProfile={},ownerRequestHandle={},ownerContext={},ownerRequest={TEST_ONLY:true},ownerBaseline={'.gsd/':'directory'},ownerRow={context:ownerContext,preparedRequestHandle:ownerRequestHandle};frameData.seedPreludeProfile(ownerProfile,ownerRow);
 let ownerDelegated=0,ownerActive=false;const ownerPreviousRequire=copy.require;copy.require=name=>name==='./forge-native-host-request'?{synchronousReadPreludeActive(h,p){assert.equal(h,ownerRequestHandle);assert.equal(p,ownerProfile);return ownerActive;},runSynchronousReadPrelude(h,p,kind,payload){ownerDelegated++;assert.equal(h,ownerRequestHandle);assert.equal(p,ownerProfile);assert.equal(kind,'activity-owner-check');assert.strictEqual(payload.request,ownerRequest);assert.strictEqual(payload.baseline,ownerBaseline);return true;}}:ownerPreviousRequire(name);
 assert.equal(copy.exports.assertProtectedOwner(ownerProfile,ownerRequest,ownerBaseline),true);assert.equal(ownerDelegated,1);ownerActive=true;assert.equal(copy.exports.assertProtectedOwner(ownerProfile,ownerRequest,ownerBaseline),false,'nested frame selects original fallback');assert.equal(ownerDelegated,1);ownerActive=false;
 const ownerInvalid=new Error('TEST_OWNER_PROFILE_INVALID');ownerRow.invalid=ownerInvalid;assert.throws(()=>copy.exports.assertProtectedOwner(ownerProfile,ownerRequest,ownerBaseline),e=>e===ownerInvalid);assert.equal(ownerDelegated,1);copy.require=ownerPreviousRequire;

 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),crypto.createHash('sha256').update(sourceBytes).digest('hex'),'private DATA inspection leaves actual Source untouched');
 assert.equal(profile.prepareTimeoutCapMs(),1800000,'prepare protocol remains bounded; resolved unit and effective Bash limits remain required');
 assert.equal(profile.LIVE_PROFILE_ID,'claude-agent-files-foreground-v1');
 assert.throws(()=>profile.assertInvocationIntent(Object.freeze({}),{request:{}}),e=>e.code==='native-host-profile-required');
 assert.throws(()=>profile.assertSealedIntent(Object.freeze({})),e=>e.code==='native-host-profile-required');
 assert.throws(()=>profile.admitLiveObservation(Object.freeze({}),Object.freeze({})),e=>e.code==='native-host-profile-required');
 const claimedLive={...value,profile_id:profile.LIVE_PROFILE_ID,provenance:'observed-host'};assert.throws(()=>profile.normalizeHostObservation(claimedLive),e=>e.code==='native-host-profile-unsupported','LIVE source/OS brand cannot be minted by schema JSON');
 console.log('forge-native-host-profile schema/non-forgeability tests passed; full ingress/join matrix belongs to real CLI tests');
}finally{process.env=saved;assert.equal(fs.readFileSync(path.join(root,'OWNED'),'utf8'),marker);assert(!fs.lstatSync(root).isSymbolicLink());assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
