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
 exports.relayCurrentHostHook=async function(input){fs.writeFileSync(process.env.TEST_CAPTURE,input.capture);if(process.env.TEST_REPLY==='bad')return{exit_code:0,hook_output:[]};return{exit_code:Number(process.env.TEST_REPLY||0),hook_output:{}};};
 exports.collectOriginalHookBootstrap=function(){if(process.env.TEST_BOOTSTRAP==='throw')throw Object.assign(Error('fixture unavailable'),{code:'native-host-os-observation-refused',os_diagnostic:{action:'process',status:2,spawn_code:null,signal:null,typed_error:'native-host-os-observation-refused',exception_type:'System.InvalidOperationException',hresult:-1,stderr_captured_bytes:0,stderr_captured_sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',stderr_may_be_truncated:false,unexpected_field:{unsupported:true}}});return {schema_version:1,kind:'claude-hook-bootstrap',pid:process.pid,started:"fixture-start'quoted",exe:process.execPath,exe_sha256:'a'.repeat(64),hook_source:__filename,hook_sha256:'b'.repeat(64),config_dir:process.env.CLAUDE_CONFIG_DIR};};
 `);
 // Delegate the syntax operation to the actual shared Bridge parser; no copied
 // parser, fake enrollment, capability or lifecycle producer is introduced.
 const actualBridge=fs.realpathSync.native(path.join(__dirname,'forge-native-host-bridge.js'));
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
 console.log('PASS hook-only LIVE bounds, replies, stdin fatal/end, byte custody and optional bootstrap; no live authority assertion');
}finally{assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});}
