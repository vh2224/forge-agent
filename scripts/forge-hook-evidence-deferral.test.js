'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-hook-window-'))),owner=path.join(lab,'owner');
fs.mkdirSync(path.join(owner,'.gsd','tasks'),{recursive:true});
// Set private homes before the first Forge module import in this fixture.
for(const [key,value] of Object.entries({HOME:lab,USERPROFILE:lab,CODEX_HOME:path.join(lab,'codex'),CLAUDE_CONFIG_DIR:path.join(lab,'claude'),FORGE_HOME:path.join(lab,'home')}))process.env[key]=value;
const windows=require('./forge-owner-transport-window'),execution=require('./forge-task-execution'),runs=require('./forge-runs');
const session='hook-window-fixture-'+process.pid;
runs.add(owner,{id:'T-20261115000000-hook',kind:'task',host_runtime:'claude',session_id:session});
const before=execution.protectedSnapshot(owner),cap=windows.open(owner,{kind:'artifact-preparation',task_id:'T-20261115000000-hook',dispatch_id:'hook-fixture',request_sha256:'a'.repeat(64)});
try{
 const seen=windows.observed(owner);
 const fired=cp.spawnSync(process.execPath,[path.join(__dirname,'forge-hook.js'),'post'],{cwd:owner,input:JSON.stringify({cwd:owner,session_id:session,tool_name:'Bash',tool_input:{command:'echo synthetic'},tool_response:{success:true}}),encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,HOME:lab,USERPROFILE:lab,APPDATA:path.join(lab,'appdata'),FORGE_HOME:path.join(lab,'home')}});
 assert.equal(fired.status,0,fired.stderr);
 assert.deepEqual(execution.protectedSnapshot(owner),before);
 const dir=path.join(windows.controlRoot(owner),'hook-evidence',seen.sha256),names=fs.readdirSync(dir);
 assert.equal(names.length,1);const row=JSON.parse(fs.readFileSync(path.join(dir,names[0]),'utf8').trim());assert.equal(row.tool,'Bash');
 assert.equal(windows.observed(owner).sha256,seen.sha256,'hook cannot release or change window');
 assert.throws(()=>windows.appendHookEvidence(owner,'../escape.jsonl','{}'),/hook-evidence-path-invalid/);
 assert.throws(()=>windows.appendHookEvidence(owner,names[0],'{}\n{}'),/hook-evidence-record-invalid/);
 const rogue=path.join(owner,'.gsd','rogue.txt');fs.writeFileSync(rogue,'unauthorized');
 assert.throws(()=>execution.assertProtected(owner,before),/execution-protected-metadata/);fs.unlinkSync(rogue);
 windows.close(cap,c=>({challenge_sha256:crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex'),joined:true,possible_writers:0,reference:'actual hook process closed; synchronous fixture has no remaining writers'}));
 assert.equal(windows.observed(owner),null);assert(fs.existsSync(path.join(dir,names[0])),'private observation survives settlement without owner replay');
 console.log('PASS actual PostToolUse hook defers private telemetry, preserves protected owner/join, rejects unrelated writes and invalid paths');

 // Routing-only transport controls. The copied Core doubles return no live
 // capability: these cases prove no real host/HMAC admission, join or publication.
 const installed=path.join(lab,'hook-transport','scripts'),captureFile=path.join(lab,'retained-transport-input');
 fs.mkdirSync(installed,{recursive:true});
 const installedHook=path.join(installed,'forge-hook.js');fs.copyFileSync(path.join(__dirname,'forge-hook.js'),installedHook);
 fs.writeFileSync(path.join(installed,'forge-workspace.js'),"exports.resolveOwner=()=>process.env.TEST_TRANSPORT_OWNER||null;exports.isProject=()=>true;");
 fs.writeFileSync(path.join(installed,'forge-owner-transport-window.js'),"exports.observed=()=>process.env.TEST_TRANSPORT_WINDOW==='live'?{binding:{native_host_relay:{protocol_version:1}}}:null;");
 fs.writeFileSync(path.join(installed,'forge-native-host-bridge.js'),String.raw`
 const fs=require('fs');
 exports.relayCurrentHostHook=async function(input){
  fs.writeFileSync(process.env.TEST_CAPTURE,input.capture);
  const mode=process.env.TEST_IPC_DIAGNOSTIC;
  if(mode){
   const marker='PRIVATE_DIAGNOSTIC_MUST_NOT_ESCAPE',error=Object.assign(Error(marker),{code:mode==='other-code'?'native-host-test-other':'native-host-live-ipc-cap'}),touch=()=>{fs.writeFileSync(process.env.TEST_GETTER_CAPTURE,'getter-read');throw Error(marker);};
   let diagnostic={schema_version:1,stage:mode==='queued'?'envelope-queued':'envelope-not-queued'};
   if(mode==='extra')diagnostic.raw=marker;
   if(mode==='unknown-stage')diagnostic.stage=marker;
   if(mode==='bad-schema')diagnostic.schema_version=2;
   if(mode==='array')diagnostic=[];
   if(mode==='symbol')diagnostic[Symbol('private')]=marker;
   if(mode==='stage-getter')Object.defineProperty(diagnostic,'stage',{enumerable:true,get:touch});
   if(mode==='schema-getter')Object.defineProperty(diagnostic,'schema_version',{enumerable:true,get:touch});
   if(mode==='inherited-stage')diagnostic=Object.create({stage:'envelope-queued'},{schema_version:{value:1,enumerable:true}});
   if(mode==='projection-throw')diagnostic=new Proxy(diagnostic,{ownKeys:touch});
   if(mode==='property-getter')Object.defineProperty(error,'ipc_diagnostic',{get:touch});
   else if(mode==='inherited-property')Object.setPrototypeOf(error,{ipc_diagnostic:diagnostic});
   else error.ipc_diagnostic=diagnostic;
   if(mode==='write-throw'){const write=process.stderr.write;process.stderr.write=function(value,...args){if(String(value).startsWith('{"schema_version":1,"kind":"forge-native-live-ipc-timeout"'))throw Object.assign(Error(marker),{code:'EPIPE'});return write.call(this,value,...args);};}
   throw error;
  }
  if(process.env.TEST_REPLY==='bad')return{exit_code:0,hook_output:[]};return{exit_code:Number(process.env.TEST_REPLY||0),hook_output:{}};
 };
 exports.collectOriginalHookBootstrap=function(){
  const mode=process.env.TEST_BOOTSTRAP;
  if(mode==='throw'||mode==='pair-item')throw Object.assign(Error('fixture unavailable'),{code:'native-host-os-observation-refused',os_diagnostic:{action:'process',status:2,spawn_code:null,signal:null,typed_error:'native-host-os-observation-refused',exception_type:'System.InvalidOperationException',hresult:-1,stderr_captured_bytes:0,stderr_captured_sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',stderr_may_be_truncated:false,...(mode==='pair-item'?{item_index:1}:{}),unexpected_field:{unsupported:true}}});
  const value={schema_version:1,kind:'claude-hook-bootstrap',pid:mode==='ok'?process.pid:321,started:mode==='ok'?"fixture-start'quoted":'123456789012345678',exe:process.execPath,exe_sha256:'a'.repeat(64),exe_version:'3.2.41',hook_source:__filename,hook_sha256:'b'.repeat(64),config_dir:process.env.CLAUDE_CONFIG_DIR};
  if(mode==='other-pid')value.pid=322;
  if(mode==='other-started')value.started='123456789012345679';
  if(mode==='other-sha')value.exe_sha256='c'.repeat(64);
  if(mode==='other-hook-sha')value.hook_sha256='d'.repeat(64);
  if(mode==='other-version')value.exe_version='3.2.42';
  if(mode==='other-exe')value.exe=require('path').join(require('path').dirname(process.execPath),'fixture-other.exe');
  if(mode==='other-config')value.config_dir=require('path').join(process.env.CLAUDE_CONFIG_DIR,'other');
  if(mode==='bad-version')value.exe_version='03.2.41';
  if(mode==='extra-field')value.raw='PRIVATE_BOOTSTRAP_MUST_NOT_ESCAPE';
  if(mode==='missing-version')delete value.exe_version;
  if(mode==='digest-object')value.exe_sha256={get toString(){fs.writeFileSync(process.env.TEST_GETTER_CAPTURE,'getter-read');return()=> 'a'.repeat(64);}};
  return value;
 };
 `);
 // Delegate the syntax operation to the actual shared Bridge parser; no copied
 // parser, fake enrollment, capability or lifecycle producer is introduced.
 const actualBridge=fs.realpathSync.native(path.join(__dirname,'forge-native-host-bridge.js'));
 fs.writeFileSync(path.join(installed,'forge-native-host-profile.js'), "if(process.env.TEST_PROFILE_UNAVAILABLE==='1')throw Error('fixture unavailable');module.exports=require("+JSON.stringify(path.join(__dirname,'forge-native-host-profile.js'))+");\n");
 fs.appendFileSync(path.join(installed,'forge-native-host-bridge.js'), '\nexports.validateInitialPrepareCommand=require('+JSON.stringify(actualBridge)+').validateInitialPrepareCommand;\n');
 const transportEnv={...process.env,TEST_TRANSPORT_OWNER:owner,TEST_TRANSPORT_WINDOW:'live',TEST_CAPTURE:captureFile};
 const payload={hook_event_name:'PreToolUse',cwd:owner,session_id:session,tool_name:'Read',tool_input:{file_path:'seed'}};
 const exact=Buffer.from(JSON.stringify(payload,null,2)+'\n');
 function transport(input=exact,extra={},args=['native-live','pre']){
   if(fs.existsSync(captureFile))fs.unlinkSync(captureFile);
   return cp.spawnSync(process.execPath,[installedHook,...args],{cwd:owner,input,encoding:'utf8',timeout:20000,windowsHide:true,maxBuffer:128*1024,env:{...transportEnv,...extra}});
 }
 for(const exit of [0,2]){const r=transport(exact,{TEST_REPLY:String(exit)});assert.equal(r.status,exit,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{});assert(fs.readFileSync(captureFile).equals(exact),'original capture forwarded byte-exact');}
 for(const [input,code] of [[Buffer.from('null'),'native-host-hook-routing'],[Buffer.from('{'),'native-host-hook-json'],[Buffer.from([0xff]),'native-host-hook-utf8'],[Buffer.alloc(2*1024*1024+1,32),'native-host-hook-input-limit']]){
   const r=transport(input);assert.equal(r.status,2);assert(r.stderr.includes(code));assert(!fs.existsSync(captureFile),'invalid capture never invokes relay');assert.deepEqual(JSON.parse(r.stdout),{});
 }
 const inert=transport(exact,{TEST_TRANSPORT_WINDOW:'none'});assert.equal(inert.status,0);assert(!fs.existsSync(captureFile));
 const literal=value=>'"'+value.split(path.sep).join('/')+'"';
 const inputFile=path.join(lab,'initial-owner-input.json');fs.writeFileSync(inputFile,'{}');
 const prepareCommand=literal(fs.realpathSync.native(process.execPath))+' '+literal(actualBridge)+' prepare --input '+literal(inputFile);
 function noWindowPre(command){return transport(Buffer.from(JSON.stringify({...payload,tool_name:'Bash',tool_input:{command}})),{TEST_TRANSPORT_OWNER:'',TEST_TRANSPORT_WINDOW:'none'});}
 const validPrepare=noWindowPre(prepareCommand);assert.equal(validPrepare.status,0,validPrepare.stderr);assert(!fs.existsSync(captureFile),'syntax acceptance never calls live relay');
 const ordinary=noWindowPre('echo ordinary-non-native');assert.equal(ordinary.status,0,ordinary.stderr);assert(!fs.existsSync(captureFile));
 for(const command of [prepareCommand.replace(/"/g,"'"),'env X=1 '+prepareCommand,prepareCommand+'; echo suffix',prepareCommand+' && echo suffix',prepareCommand+' | cat',prepareCommand+' > redirected',prepareCommand+' --extra yes',prepareCommand.replace(literal(inputFile),'"relative-input.json"')]){
   const denied=noWindowPre(command);assert.equal(denied.status,2,command);assert.match(denied.stderr,/native-host-initial-prepare-command/);assert(!fs.existsSync(captureFile));assert.deepEqual(JSON.parse(denied.stdout),{});
 }
 // Typed client-local stage propagation; no LIVE/SDK capability is supplied.
 const getterCapture=path.join(lab,'diagnostic-getter-read');
 for(const [mode,stage]of [['before','envelope-not-queued'],['queued','envelope-queued']]){
   const r=transport(exact,{TEST_IPC_DIAGNOSTIC:mode,TEST_GETTER_CAPTURE:getterCapture});assert.equal(r.status,2);assert.equal(r.stdout,'{}\n');const lines=r.stderr.trimEnd().split('\n');assert.equal(lines[0],'native-host-live-ipc-cap');assert.equal(lines.length,2);assert.deepEqual(JSON.parse(lines[1]),{schema_version:1,kind:'forge-native-live-ipc-timeout',stage});assert(fs.readFileSync(captureFile).equals(exact));assert(!r.stderr.includes('PRIVATE_DIAGNOSTIC_MUST_NOT_ESCAPE'));
 }
 for(const mode of ['extra','unknown-stage','bad-schema','array','symbol','stage-getter','schema-getter','inherited-stage','property-getter','inherited-property','other-code','write-throw']){
   const r=transport(exact,{TEST_IPC_DIAGNOSTIC:mode,TEST_GETTER_CAPTURE:getterCapture});assert.equal(r.status,2);assert.equal(r.stdout,'{}\n');assert.equal(r.stderr,(mode==='other-code'?'native-host-test-other':'native-host-live-ipc-cap')+'\n');assert(!fs.existsSync(getterCapture),'Diagnostic accessors are never invoked');assert(!r.stderr.includes('PRIVATE_DIAGNOSTIC_MUST_NOT_ESCAPE'));
 }
 // Projection may throw through a Proxy trap; it still cannot replace the refusal.
 const projection=transport(exact,{TEST_IPC_DIAGNOSTIC:'projection-throw',TEST_GETTER_CAPTURE:getterCapture});assert.equal(projection.status,2);assert.equal(projection.stdout,'{}\n');assert.equal(projection.stderr,'native-host-live-ipc-cap\n');assert(fs.existsSync(getterCapture));fs.unlinkSync(getterCapture);
 console.log('PASS native-live IPC diagnostics: original refusal, closed stages/schema, no getters/raw and ignored projection/write errors');

 const badReply=transport(exact,{TEST_REPLY:'bad'});assert.equal(badReply.status,2);assert.match(badReply.stderr,/native-host-live-relay-response/);
 // Real private child; only its stdin error/end interleaving is instrumented.
 // No Source module or retained hook bytes are patched by this test.
 if(fs.existsSync(captureFile))fs.unlinkSync(captureFile);
 const runner="process.argv=[process.execPath,process.argv[1],'native-live','pre'];require('module')._load(process.argv[1],null,true);process.stdin.emit('data',Buffer.from(process.env.TEST_INPUT));process.stdin.emit('error',Object.assign(Error('fixture'),{code:'native-host-test-stdin'}));process.stdin.emit('end');";
 const interrupted=cp.spawnSync(process.execPath,['-e',runner,installedHook],{cwd:owner,encoding:'utf8',timeout:20000,windowsHide:true,env:{...transportEnv,TEST_INPUT:exact.toString()}});
 assert.equal(interrupted.status,2);assert.match(interrupted.stderr,/native-host-test-stdin/);assert.deepEqual(JSON.parse(interrupted.stdout),{});assert(!fs.existsSync(captureFile),'stdin fatal forbids later end dispatch');
 for(const unavailable of [false,true]){
   const envFile=path.join(lab,'session-env-'+unavailable);fs.writeFileSync(envFile,'# preexisting\n');
   const r=transport(Buffer.from(JSON.stringify({hook_event_name:'SessionStart',cwd:lab,session_id:session})),{CLAUDE_ENV_FILE:envFile,TEST_BOOTSTRAP:unavailable?'throw':'ok'},['session-start']);
   assert.equal(r.status,0,r.stderr);const env=fs.readFileSync(envFile,'utf8');assert(env.startsWith('# preexisting\n'));assert(env.includes("export FORGE_CLAUDE_OWNER_SESSION_ID='"+session+"'"));
   assert.equal(env.includes('FORGE_NATIVE_HOST_PID='),!unavailable,'bootstrap failure leaves ordinary identity');
   if(unavailable){
     assert(Buffer.byteLength(r.stderr)<=2048);const diagnostic=JSON.parse(r.stderr.trim());
     assert.equal(diagnostic.kind,'forge-native-bootstrap-refused');assert.equal(diagnostic.code,'native-host-os-observation-refused');assert.equal(diagnostic.provider_called,'unknown');
     assert.equal(diagnostic.os_diagnostic.action,'process');assert.equal(diagnostic.os_diagnostic.status,2);assert.equal(diagnostic.os_diagnostic.exception_type,'System.InvalidOperationException');
     assert(!Object.hasOwn(diagnostic,'message'));assert(!Object.hasOwn(diagnostic.os_diagnostic,'unexpected_field'));
     assert.deepEqual(Object.keys(diagnostic.os_diagnostic).sort(),['action','exception_type','hresult','signal','spawn_code','stderr_captured_bytes','stderr_captured_sha256','stderr_may_be_truncated','status','typed_error'].sort());
   }
   if(!unavailable){assert(env.includes("'fixture-start'\"'\"'quoted'"),'bootstrap shell data is quoted');assert(env.includes("FORGE_NATIVE_HOST_BOOTSTRAP_SOURCE='claude-sessionstart-process-v1'"));}
 }
 // Actual installed hook/canonical bridge DATA coherence; no LIVE capability.
 const Module=require('module'),bridgeRaw=fs.readFileSync(actualBridge),bridgeCopy=new Module(actualBridge+'#carrier-data',module);
 bridgeCopy.filename=actualBridge;bridgeCopy.paths=Module._nodeModulePaths(path.dirname(actualBridge));
 bridgeCopy._compile(bridgeRaw.toString('utf8')+'\nmodule.exports.__carrier={canonicalPrepareSessionExports,parseObservedPrepareBody};\n',actualBridge);
 const carrierData=bridgeCopy.exports.__carrier,canonicalBootstrap={pid:321,started:'123456789012345678',exe:process.execPath,exe_sha256:'a'.repeat(64),exe_version:'3.2.41',hook:path.join(installed,'forge-native-host-bridge.js'),hook_sha256:'b'.repeat(64),config:process.env.CLAUDE_CONFIG_DIR};
 const canonicalExports=carrierData.canonicalPrepareSessionExports({hostRuntime:'claude',sessionId:session},canonicalBootstrap),nativeBlock='\n'+canonicalExports.replace(/\n:$/,'\n');
 function startSession(file,mode='canonical',id=session,extra={}){
  return transport(Buffer.from(JSON.stringify({hook_event_name:'SessionStart',cwd:lab,session_id:id})),{CLAUDE_ENV_FILE:file,TEST_BOOTSTRAP:mode,...extra},['session-start']);
 }
 function freshEnv(name,contents=''){const file=path.join(lab,name);fs.writeFileSync(file,contents,{flag:'wx'});return file;}
 const coherent=freshEnv('carrier-coherence'),first=startSession(coherent);assert.equal(first.status,0,first.stderr);assert.equal(fs.readFileSync(coherent,'utf8'),nativeBlock);assert.equal(first.stderr,'');
 const repeated=startSession(coherent);assert.equal(repeated.status,0,repeated.stderr);assert.equal(repeated.stderr,'');assert.equal(fs.readFileSync(coherent,'utf8'),nativeBlock,'identical SessionStart appends nothing');
 if(process.platform==='win32'){
  const body="source /c/fixture/shell-snapshots/snapshot-bash-1234567890123-Abc123.sh 2>/dev/null || true && export TEMP='C:/fixture/tmp' TMP='C:/fixture/tmp' && "+canonicalExports+" && shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '"+prepareCommand+"' < /dev/null && pwd -P >| /c/fixture/tmp/claude-ab12-cwd";
  assert.equal(carrierData.parseObservedPrepareBody(body,{input:inputFile,node_exe:fs.realpathSync.native(process.execPath),session_exports:canonicalExports}).session_exports_sha256,crypto.createHash('sha256').update(canonicalExports).digest('hex'));
 }
 for(const mode of ['other-pid','other-started','other-sha','other-hook-sha','other-version','other-exe','other-config','other-session']){
  const file=freshEnv('conflict-'+mode);assert.equal(startSession(file).status,0);const original=fs.readFileSync(file,'utf8');
  const result=startSession(file,mode==='other-session'?'canonical':mode,mode==='other-session'?session+'-other':session);assert.equal(result.status,0,result.stderr);
  const after=fs.readFileSync(file,'utf8');assert(after.startsWith(original));assert.equal((after.match(/export FORGE_NATIVE_HOST_PID=/g)||[]).length,1);
  const diagnostic=JSON.parse(result.stderr.trim());assert.equal(diagnostic.code,'native-host-session-pin-conflict');assert(!result.stderr.includes(file));assert(!result.stderr.includes(process.execPath));
 }
 for(const contents of ["export FORGE_NATIVE_HOST_UNKNOWN='private'\n","export FORGE_NATIVE_HOST_UNKNOWN='private'\n"+nativeBlock]){
  const file=freshEnv('foreign-native-'+crypto.randomBytes(4).toString('hex'),contents),result=startSession(file);assert.equal(result.status,0);assert.equal(JSON.parse(result.stderr.trim()).code,'native-host-session-pin-conflict');assert.equal((fs.readFileSync(file,'utf8').match(/export FORGE_NATIVE_HOST_PID=/g)||[]).length,contents.includes('FORGE_NATIVE_HOST_PID=')?1:0);
 }
 const newSession=freshEnv('new-session-own-pin'),own=startSession(newSession,'other-version',session+'-new');assert.equal(own.status,0,own.stderr);assert(fs.readFileSync(newSession,'utf8').includes("FORGE_NATIVE_HOST_EXE_VERSION='3.2.42'"));
 for(const mode of ['bad-version','extra-field','missing-version','digest-object']){
  const file=freshEnv('shape-'+mode),result=startSession(file,mode,session,{TEST_GETTER_CAPTURE:getterCapture});assert.equal(result.status,0);assert(!fs.readFileSync(file,'utf8').includes('FORGE_NATIVE_HOST_PID='));assert(fs.readFileSync(file,'utf8').includes('FORGE_CLAUDE_OWNER_SESSION_ID='));assert.equal(JSON.parse(result.stderr.trim()).kind,'forge-native-bootstrap-refused');assert(!fs.existsSync(getterCapture),'non-string digest never coerces a getter');assert(!result.stderr.includes('PRIVATE_BOOTSTRAP_MUST_NOT_ESCAPE'));
 }
 const unavailableFile=freshEnv('profile-unavailable'),unavailable=startSession(unavailableFile,'canonical',session,{TEST_PROFILE_UNAVAILABLE:'1'});assert.equal(unavailable.status,0);assert(!fs.readFileSync(unavailableFile,'utf8').includes('FORGE_NATIVE_HOST_PID='));assert.equal(JSON.parse(unavailable.stderr.trim()).kind,'forge-native-bootstrap-refused');
 const pairFile=freshEnv('pair-diagnostic'),pairResult=startSession(pairFile,'pair-item');assert.equal(pairResult.status,0);const pairDiagnostic=JSON.parse(pairResult.stderr.trim());assert.equal(pairDiagnostic.os_diagnostic.action,'process');assert.equal(pairDiagnostic.os_diagnostic.item_index,1);assert(!Object.hasOwn(pairDiagnostic.os_diagnostic,'unexpected_field'));
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(actualBridge)).digest('hex'),crypto.createHash('sha256').update(bridgeRaw).digest('hex'));
 console.log('PASS original installed SessionStart: version shape/profile, canonical carrier/parser, identical repetition, pin conflicts, fresh session, getter refusal and closed pair diagnostic; DATA only');
 console.log('PASS hook-only LIVE bounds, replies, stdin fatal/end, byte custody and optional bootstrap; no live authority assertion');
}finally{assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});}
