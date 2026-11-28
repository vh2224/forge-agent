'use strict';
// CLI integration, not a live Claude/provider test. Nothing runs on require.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),cp=require('node:child_process'),net=require('node:net');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=v=>hash(JSON.stringify(stable(v)));
function put(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.isBuffer(bytes)||typeof bytes==='string'?bytes:JSON.stringify(bytes));}
function start(file,args,options={}){
  const proc=cp.spawn(process.execPath,[file,...args],{stdio:['ignore','pipe','pipe'],windowsHide:true,...options});
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0);proc.stdout.on('data',b=>{stdout=Buffer.concat([stdout,b]);assert(stdout.length<=2*1024*1024,'bounded fixture stdout');});
  proc.stderr.on('data',b=>{stderr=Buffer.concat([stderr,b]);assert(stderr.length<=2*1024*1024,'bounded fixture stderr');});
  const closed=new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',(code,signal)=>resolve({code,signal,stdout,stderr,pid:proc.pid,closed:true}));});
  return{proc,closed};
}
const SOURCE_ERROR_CLASSES=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','AssertionError','UnknownError']);
const SOURCE_ERROR_FILES=new Set(['forge-native-host-bridge.js','forge-native-host-request.js','forge-native-host-profile.js','forge-prompt.js','forge-procedure-context.js','forge-delivery.js','forge-unit-sidecar.js','forge-code-roots.js','forge-plan-validation.js','forge-prefs.js','forge-task-execution.js','forge-surgical-reset.js','forge-vcs.js']);
function fixtureSourceError(value){
 const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
 if(!exact(value,['kind','error_class','frames'])||value.kind!=='native-host-source-error-v1'||!SOURCE_ERROR_CLASSES.has(value.error_class)||!Array.isArray(value.frames)||value.frames.length>4)return null;
 const frames=[];for(const row of value.frames){if(!exact(row,['file','line','column'])||!SOURCE_ERROR_FILES.has(row.file)||!Number.isSafeInteger(row.line)||row.line<1||row.line>9999999||!Number.isSafeInteger(row.column)||row.column<1||row.column>999999)return null;frames.push({file:row.file,line:row.line,column:row.column});}
 return{kind:value.kind,error_class:value.error_class,frames};
}
async function cli(command,args,{expect=0,env=process.env}={}){
  const r=await start(path.join(__dirname,'forge-native-host-bridge.js'),[command,...args],{env}).closed;
  try{assert.equal(r.code,expect,'CLI exit; stderr SHA '+hash(r.stderr));}catch(error){
    let reason=null;try{const value=JSON.parse(r.stderr.toString('utf8').trim());
      const token=v=>typeof v==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(v)?v:null;
      if(value&&typeof value==='object'&&!Array.isArray(value)){reason={code:token(value.code),stage:token(value.stage),provider_called:[true,false].includes(value.provider_called)?value.provider_called:'unknown'};const sourceError=fixtureSourceError(value.source_error);if(sourceError)reason.source_error=sourceError;}
    }catch{}
    error.native463_diagnostic={command,expected_exit:expect,exit_code:r.code,signal:r.signal,closed:r.closed,stderr_bytes:r.stderr.length,stderr_sha256:hash(r.stderr),reason};throw error;
  }assert.equal(r.signal,null);assert.equal(r.closed,true);
  const line=r.stdout.toString('utf8').trim();return{...r,value:line?JSON.parse(line.split('\n').at(-1)):null};
}
function holdAdmission(ref){
  const socket=net.connect(ref.endpoint);let bytes=Buffer.alloc(0);
  const closed=new Promise(resolve=>socket.once('close',resolve));
  const admitted=new Promise((resolve,reject)=>{
    socket.once('error',reject);socket.once('connect',()=>socket.write(JSON.stringify({protocol_version:1,kind:'candidate',
      attempt_id:ref.attempt_id,issuer_message_id:crypto.randomUUID(),body_bytes:1,body_sha256:hash('x')})+'\n'));
    socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);assert(bytes.length<=2048);const n=bytes.indexOf(10);
      if(n>=0){const ack=JSON.parse(bytes.subarray(0,n));if(ack.ack==='admitted')resolve();else reject(Error(ack.error?.code||'fixture-admission-refused'));}});
  });return{socket,closed,admitted};
}
// Executed in a separate process. This is the fixture Agent's only product writer.
function fixtureWorker(job){
  for(const root of job.code_roots){assert(path.isAbsolute(root.path));put(path.join(root.path,'same.txt'),'after\n');}
}
async function relay(job,event){
  const raw=JSON.stringify(event),messageId=crypto.randomUUID(),metadata={protocol_version:1,kind:'host-observation',
    attempt_id:job.reference.attempt_id,issuer_message_id:messageId,host_session:event.host_session,dispatch_id:event.dispatch_id,
    invocation_sha256:event.invocation_sha256,event_type:({launch:'PreToolUse','worker-start':'SubagentStart','worker-stop':'SubagentStop','foreground-return':'Handback'})[event.event],
    tool_use_id:event.tool_use_id,agent_id:event.worker_id,agent_run_id:event.worker_id,capture_reference:null,capture_sha256:hash(raw)};
  const envelope=path.join(job.root,'relay-'+messageId+'.json');put(envelope,{message:metadata,capture:raw});
  // Calls the actual measured hook allowlist, which delegates to the same bridge CLI.
  const r=await start(path.join(__dirname,'forge-hook.js'),['--native-host-relay','--attempt',job.attempt_file,'--observation',envelope]).closed;
  assert.equal(r.code,0,'real hook retention; stderr SHA '+hash(r.stderr));assert(r.closed);
}

// Private fixture transport cut, not a real Claude Hook/OS provenance proof.
// It sends the actual final worker-stop record, then drops only its ACK observer.
async function cutFinalRelayAfterPending(job,event){const raw=JSON.stringify(event),messageId=crypto.randomUUID(),metadata={protocol_version:1,kind:'host-observation',attempt_id:job.reference.attempt_id,issuer_message_id:messageId,host_session:event.host_session,dispatch_id:event.dispatch_id,invocation_sha256:event.invocation_sha256,event_type:'SubagentStop',tool_use_id:event.tool_use_id,agent_id:event.worker_id,agent_run_id:event.worker_id,capture_reference:null,capture_sha256:hash(raw)},body=Buffer.from(JSON.stringify({message:metadata,capture:raw}));const socket=net.connect(job.reference.endpoint);let bytes=Buffer.alloc(0),pending=false,ready=false;const closed=new Promise((resolve,reject)=>{socket.once('error',reject);socket.once('close',resolve);});socket.once('connect',()=>socket.write(JSON.stringify({protocol_version:1,kind:'relay',attempt_id:job.reference.attempt_id,issuer_message_id:messageId,body_bytes:body.length,body_sha256:hash(body)})+'\n'));socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);assert(bytes.length<=8192);let at;while((at=bytes.indexOf(10))>=0){const value=JSON.parse(bytes.subarray(0,at));bytes=bytes.subarray(at+1);if(value.ack==='admitted')socket.write(body);else if(value.ack==='completion-pending'){pending=true;socket.destroy();return;}else if(value.ready){ready=true;assert.fail('cut observer unexpectedly consumed ready');}else if(value.ack==='refused')assert.fail('fixture relay refused before pending');}});await closed;assert(pending);assert.equal(ready,false);put(path.join(job.root,'ack-observer-cut.json'),{stage:'completion-pending-received',ready_received:false,socket_close_observed:true,worker_activity_at_cutoff:'unknown',fixture_only:true});}

async function fixtureHost(job){
  const common={schema_version:1,kind:'forge-native463-fixture-observation',host_session:'fixture-native463',
    dispatch_id:job.reference.dispatch_id,invocation_sha256:job.reference.invocation_sha256,tool_use_id:'fixture-agent-tool',result:null};
  const event=(kind,worker,parent,result=null)=>({...common,event:kind,worker_id:worker,parent_worker_id:parent,result});
  await relay(job,event('launch','root',null));
  await relay(job,event('worker-start','writer','root'));
  const writer=await start(__filename,['--fixture-worker',job.job_file]).closed;
  assert.equal(writer.code,0);assert(writer.closed,'actual product writer close precedes worker-stop observation');
  const candidate=path.join(job.root,'candidate.txt');put(candidate,job.raw_result);
  // Valid candidate alone cannot mint a host return or complete the join barrier.
  await cli('accept',['--attempt',job.attempt_file,'--candidate',candidate]);
  const pending=await cli('status',['--attempt',job.attempt_file]);assert.equal(pending.value.ready,false);
  // Handback can precede Stop. A valid captured result still cannot finish a known live descendant.
  await relay(job,event('foreground-return','root',null,job.raw_result));
  const unjoined=await cli('status',['--attempt',job.attempt_file]);assert.equal(unjoined.value.ready,false);
  await relay(job,event('worker-stop','writer','root'));
  if(job.partial_publication)await relay(job,event('worker-stop','root',null));else await cutFinalRelayAfterPending(job,event('worker-stop','root',null));
  put(path.join(job.root,'host-process-closed-writer.json'),{writer_pid:writer.pid,writer_closed:writer.closed,writer_exit:writer.code,provider_called:'unknown'});
}
async function waitReady(attempt){
  // This observes canonical status without creating a checkpoint or refreshing a lifecycle clock.
  for(let i=0;i<200;i++){
    const r=await cli('status',['--attempt',attempt]);if(r.value.ready===true&&r.value.completion_receipt&&!r.value.historical)return r.value;
    if(r.value.phase==='failed')assert.fail('owner refused; inspect retained private channel');
    if(r.value.replay_diagnostic?.error){const reported=r.value.replay_diagnostic.error.code,code=typeof reported==='string'&&/^[a-z0-9_-]{1,96}$/.test(reported)?reported:'unrecognized';assert.fail('recorded replay refusal: '+code);}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail('fixture status did not observe readiness; not a worker-timeout attribution');
}

// Data-only access to ORIGINAL private normalizers/policy. No channel, profile,
// witness factory, mock producer or approved handle is exposed or used here.
function readonlyBridgeData(){const Module=require('node:module'),filename=require.resolve('./forge-native-host-bridge'),raw=fs.readFileSync(filename);assert(raw.length<2*1024*1024);const copy=new Module(filename+'#readonly-data',module);copy.filename=filename;copy.paths=Module._nodeModulePaths(path.dirname(filename));copy._compile(raw.toString('utf8').replace(/^\uFEFF/,'').replace(/^#![^\n]*(?:\n|$)/,'')+'\nmodule.exports.__readonlyData={normalizeReference,liveRuntimeHome,liveHistoricalStatusAllowed,safeError,validateInitialPrepareCommand,assertClosedPrepareShell,assertNativePreSettings,validateInitialPreparePost,parseObservedPrepareBody,canonicalPrepareSessionExports,canonicalPrepareSessionValues,checkedHookCarrier,assertOriginalHookSession,validateObservedPrepareSnapshot,calculatePrepareBudget,assertInitialPrepareTimeout,unverifiedPrechallengeRefusal,macLive,checkLiveMac};\n',filename);assert.equal(hash(fs.readFileSync(filename)),hash(raw));return copy.exports.__readonlyData;}
function assertLiveDataRegressions(ref,request){const data=readonlyBridgeData();
 // Pure DATA controls exercise the actual comparison helpers, not originalHook,
 // an OS producer, enrollment, admission, HMAC, Agent or a genuine SDK session.
 const carrierSession='fixture-carrier-session',carrierBootstrap={pid:321,started:'123456789012345678',exe:path.resolve('fixture-claude.exe'),exe_sha256:'a'.repeat(64),exe_version:'3.2.41',hook:path.resolve('fixture-forge-hook.js'),hook_sha256:'b'.repeat(64),config:path.resolve('fixture-claude-home')};
 const carrierValues=data.canonicalPrepareSessionValues({hostRuntime:'claude',sessionId:carrierSession},carrierBootstrap),carrierEnv=Object.fromEntries(carrierValues);assert.equal(carrierValues.length,11);
 assert.deepEqual(data.checkedHookCarrier(carrierSession,carrierBootstrap,{}),{sessionId:carrierSession,pid:321,started:carrierBootstrap.started,source_kind:'original-hook-current-os'});
 assert.equal(data.checkedHookCarrier(carrierSession,carrierBootstrap,carrierEnv).source_kind,'sessionstart-env-current-os');
 for(const[key]of carrierValues){const missing={...carrierEnv};delete missing[key];assert.throws(()=>data.checkedHookCarrier(carrierSession,carrierBootstrap,missing),e=>e.code==='native-host-live-hook-binding');const wrong={...carrierEnv,[key]:'foreign'};assert.throws(()=>data.checkedHookCarrier(carrierSession,carrierBootstrap,wrong),e=>e.code==='native-host-live-hook-binding');assert.throws(()=>data.checkedHookCarrier(carrierSession,carrierBootstrap,{[key]:''}),e=>e.code==='native-host-live-hook-binding');}
 let carrierGetterReads=0;const carrierGetter={...carrierEnv};Object.defineProperty(carrierGetter,carrierValues[0][0],{enumerable:true,get(){carrierGetterReads++;return carrierSession;}});assert.throws(()=>data.checkedHookCarrier(carrierSession,carrierBootstrap,carrierGetter),e=>e.code==='native-host-live-hook-binding');assert.equal(carrierGetterReads,0);
 for(const bad of [undefined,'',carrierSession+'\n','x'.repeat(257)])assert.throws(()=>data.checkedHookCarrier(bad,carrierBootstrap,{}),e=>e.code==='native-host-live-hook-binding');
 for(const argv of [['claude.exe'],['claude.exe','--session-id',carrierSession],['claude.exe','--session-id='+carrierSession]])assert.doesNotThrow(()=>data.assertOriginalHookSession(carrierSession,argv));
 for(const argv of [['claude.exe','--session-id'],['claude.exe','--session-id','foreign'],['claude.exe','--session-id=foreign'],['claude.exe','--session-id',carrierSession,'--session-id='+carrierSession]])assert.throws(()=>data.assertOriginalHookSession(carrierSession,argv),e=>e.code==='native-host-live-hook-binding');
 const cap=require('./forge-native-host-profile').prepareTimeoutCapMs();assert.equal(cap,600000);
 const combined=require('./forge-native-host-bridge').assertHostObservationAndIngress;assert.equal(typeof combined,'function');assert.throws(()=>combined(Object.freeze({}),Object.freeze({})),e=>e.code==='native-host-host-witness-required');
 assert.equal(data.calculatePrepareBudget(1800000,{}).prepare_timeout_ms,cap);
 assert.equal(data.calculatePrepareBudget(90000,{}).prepare_timeout_ms,90000);
 assert.equal(data.calculatePrepareBudget(1800000,{BASH_DEFAULT_TIMEOUT_MS:'120000',BASH_MAX_TIMEOUT_MS:'180000'}).prepare_timeout_ms,180000,'applied lower Bash cap is preserved');
 assert.equal(data.calculatePrepareBudget(1800000,{BASH_DEFAULT_TIMEOUT_MS:'60000',BASH_MAX_TIMEOUT_MS:'90000'}).prepare_timeout_ms,90000,'both applied lower limits are preserved');
 assert.equal(data.calculatePrepareBudget(1800000,{BASH_MAX_TIMEOUT_MS:'900000'}).prepare_timeout_ms,cap,'larger host allowance cannot exceed the profile cap');
 assert.equal(data.calculatePrepareBudget(1800000,{BASH_MAX_TIMEOUT_MS:'1.2e5',BASH_DEFAULT_TIMEOUT_MS:'240_000'}).prepare_timeout_ms,240000);
 for(const raw of ['0','-1','Infinity','2;writer','1__2'])assert.throws(()=>data.calculatePrepareBudget(1800000,{BASH_MAX_TIMEOUT_MS:raw}),e=>e.code==='native-host-prepare-bash-timeout-invalid');
 for(const value of [90000,180000,240000,cap])assert.doesNotThrow(()=>data.assertInitialPrepareTimeout(value,value));for(const raw of [undefined,'600000','300000',0,300000,599999,600001])assert.throws(()=>data.assertInitialPrepareTimeout(raw,cap),e=>e.code==='native-host-original-prepare-timeout-mismatch');
 const quoted=value=>'"'+value.replace(/\\/g,'/')+'"',command=quoted(process.execPath)+' '+quoted(require.resolve('./forge-native-host-bridge'))+' prepare --input '+quoted(request.contextFile);const selected=data.validateInitialPrepareCommand(command);assert.equal(path.resolve(selected.nodeToken),path.resolve(process.execPath));assert.equal(path.resolve(selected.script),require.resolve('./forge-native-host-bridge'));assert.equal(path.resolve(selected.input),path.resolve(request.contextFile));assert.equal(data.validateInitialPrepareCommand('git status'),null);
 for(const bad of [command+'; echo writer',command+' | cat',command+' > out','ENV=value '+command,'node '+quoted(require.resolve('./forge-native-host-bridge'))+' prepare --input '+quoted(request.contextFile),command.replace(quoted(request.contextFile),'relative.json')])assert.throws(()=>data.validateInitialPrepareCommand(bad),e=>e.code==='native-host-initial-prepare-command');
 const shell='"C:/fixture/bash.exe" -lc "'+command.replace(/"/g,'\\"')+'"',proof={input:request.contextFile,node_exe:process.execPath};assert.doesNotThrow(()=>data.assertClosedPrepareShell(shell,proof));for(const bad of ['"C:/fixture/bash.exe" -lc "'+command.replace(/"/g,'\\"')+'; echo writer"','"C:/fixture/bash.exe" /tmp/unknown-script.sh'])assert.throws(()=>data.assertClosedPrepareShell(bad,proof));
 // Pure Windows DATA controls: no snapshot bytes, environment values, factory
 // or observation capability is embedded here. Actual snapshot positive is the
 // separately pinned private observation, not a fabricated canonical host.
 if(process.platform==='win32'){
  const body="source /c/fixture/shell-snapshots/snapshot-bash-1234567890123-Abc123.sh 2>/dev/null || true && export TEMP='C:/fixture/tmp' TMP='C:/fixture/tmp' && shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '"+command+"' < /dev/null && pwd -P >| /c/fixture/tmp/claude-ab12-cwd";
  const parsed=data.parseObservedPrepareBody(body,proof);assert.equal(parsed.command_sha256,hash(Buffer.from(command)));assert.equal(path.basename(parsed.snapshot),'snapshot-bash-1234567890123-Abc123.sh');
  // Pure DATA controls; the real factory alone derives its private expected
  // block from current branded enrollment/actor, never these fixture objects.
  const actor={hostRuntime:'claude',sessionId:'00000000-0000-4000-8000-000000000001'},bootstrap={pid:321,started:'123456789012345678',exe:path.resolve('fixture-claude.exe'),exe_sha256:'a'.repeat(64),exe_version:'3.2.41',hook:path.resolve('fixture-forge-hook.js'),hook_sha256:'b'.repeat(64),config:path.resolve('fixture-claude-home')};
  const exported=data.canonicalPrepareSessionExports(actor,bootstrap),lines=exported.split('\n');assert.equal(lines.length,12);assert.equal(lines[11],':');assert.equal(lines[0],"export FORGE_CLAUDE_OWNER_SESSION_ID='"+actor.sessionId+"'");assert.equal(lines[2],"export FORGE_NATIVE_HOST_PID='321'");
  const names=['FORGE_CLAUDE_OWNER_SESSION_ID','FORGE_CLAUDE_OWNER_SOURCE','FORGE_NATIVE_HOST_PID','FORGE_NATIVE_HOST_STARTED','FORGE_NATIVE_HOST_EXE','FORGE_NATIVE_HOST_EXE_SHA256','FORGE_NATIVE_HOST_EXE_VERSION','FORGE_NATIVE_HOST_HOOK','FORGE_NATIVE_HOST_HOOK_SHA256','FORGE_NATIVE_HOST_CONFIG_DIR','FORGE_NATIVE_HOST_BOOTSTRAP_SOURCE'];assert.deepEqual(lines.slice(0,11).map(line=>/^export ([A-Z0-9_]+)=/.exec(line)[1]),names);
  const at=' && shopt -u extglob',withBlock=block=>body.replace(at,' && '+block+at),canonical=withBlock(exported),bound={...proof,session_exports:exported},result=data.parseObservedPrepareBody(canonical,bound);assert.equal(result.command_sha256,parsed.command_sha256);assert.equal(result.session_exports_sha256,hash(Buffer.from(exported)));assert.deepEqual(data.parseObservedPrepareBody(body,bound),parsed,'legacy R7 is byte-equivalent data');
  assert.throws(()=>data.parseObservedPrepareBody(canonical,proof),e=>e.code==='native-host-prepare-shell-wrapper-unsupported');
  for(let i=0;i<11;i++){const bad=[...lines];bad[i]+='foreign';assert.throws(()=>data.parseObservedPrepareBody(withBlock(bad.join('\n')),bound),e=>e.code==='native-host-prepare-shell-wrapper-unsupported');}
  const swapped=[...lines];[swapped[0],swapped[1]]=[swapped[1],swapped[0]];
  for(const block of [lines.slice(1).join('\n'),[lines[0],...lines].join('\n'),swapped.join('\n'),exported+'\nexport EXTRA=1',exported.replace(/\n:$/,'\ntrue'),exported+'; echo writer',exported.replace(/\n/g,'\r\n'),exported.replace("'321'","'322'"),exported.replace("'"+actor.sessionId+"'","'foreign-session'")])assert.throws(()=>data.parseObservedPrepareBody(withBlock(block),bound),e=>e.code==='native-host-prepare-shell-wrapper-unsupported');
  for(const bad of [canonical.replace(' && { \\builtin unalias', ' && '+exported+' && { \\builtin unalias'),body.replace(' && { \\builtin unalias',' && '+exported+' && { \\builtin unalias'),canonical+'; echo writer',canonical.replace(command,command+'; echo writer')])assert.throws(()=>data.parseObservedPrepareBody(bad,bound),e=>/^native-host-(prepare-|initial-prepare-)/.test(e.code));
  const insideEval=body.replace(command,command+' && '+exported+at);assert.throws(()=>data.parseObservedPrepareBody(insideEval,bound),e=>e.code==='native-host-prepare-shell-wrapper-unsupported');
  const wrongHead=body.replace(' && eval ', ' && '+exported+' && eval ');assert.throws(()=>data.parseObservedPrepareBody(wrongHead,bound),e=>e.code==='native-host-prepare-shell-wrapper-unsupported');
  const foreignSession=data.canonicalPrepareSessionExports({...actor,sessionId:'00000000-0000-4000-8000-000000000002'},bootstrap);assert.throws(()=>data.parseObservedPrepareBody(canonical,{...proof,session_exports:foreignSession}),e=>e.code==='native-host-prepare-shell-wrapper-unsupported');
  for(const stale of [{...bootstrap,pid:322},{...bootstrap,started:'123456789012345679'},{...bootstrap,hook_sha256:'c'.repeat(64)}])assert.throws(()=>data.parseObservedPrepareBody(canonical,{...proof,session_exports:data.canonicalPrepareSessionExports(actor,stale)}),e=>e.code==='native-host-prepare-shell-wrapper-unsupported');
  for(const bad of [{...bootstrap,pid:0},{...bootstrap,started:'not-time'},{...bootstrap,hook:'relative-hook.js'},{...bootstrap,exe_sha256:'unknown'},{...bootstrap,exe_version:'03.2.41'},{...bootstrap,exe_version:undefined}])assert.throws(()=>data.canonicalPrepareSessionExports(actor,bad),e=>e.code==='native-host-prepare-session-exports');

  for(const bad of [body+'; echo writer',body.replace('source ','source evil; '),body.replace("TMP='C:/fixture/tmp'","TMP='C:/different'"),body.replace('claude-ab12-cwd','unbound-output'),body.replace('1234567890123-Abc123','unknown'),body.replace(command,command+'; echo writer')])assert.throws(()=>data.parseObservedPrepareBody(bad,proof),e=>/^native-host-(prepare-|initial-prepare-)/.test(e.code));
 }
 for(const bad of [Buffer.alloc(65537),Buffer.from('export PATH=bad\n'),Buffer.from([0xff]),Buffer.from('function node { echo writer; }\n')])assert.throws(()=>data.validateObservedPrepareSnapshot(bad),e=>e.code==='native-host-prepare-snapshot-unsupported');
 const directory=process.env.CLAUDE_CONFIG_DIR,hook=path.join(directory,'fixture-live-hook.js'),settings=path.join(directory,'fixture-live-settings.json');fs.writeFileSync(hook,'// data-only physical config test\n',{flag:'wx'});try{const good={hooks:{PreToolUse:[{matcher:'*',hooks:[{type:'command',command:fs.realpathSync.native(process.execPath),args:[hook,'native-live','pre'],onFailure:'block'}]}]}};put(settings,good);assert.doesNotThrow(()=>data.assertNativePreSettings([settings],{hook}));for(const mutate of [v=>v.disableAllHooks=true,v=>v.hooks.PreToolUse[0].matcher='Agent',v=>delete v.hooks.PreToolUse[0].hooks[0].onFailure,v=>v.hooks.PreToolUse[0].hooks[0].async=true,v=>v.hooks.PreToolUse[0].hooks[0].args[0]=path.join(directory,'foreign-hook.js')]){const bad=structuredClone(good);mutate(bad);put(settings,bad);assert.throws(()=>data.assertNativePreSettings([settings],{hook}));}put(settings,good);assert.throws(()=>data.assertNativePreSettings([settings,settings],{hook}),e=>e.code==='native-host-native-hook-settings-ambiguous');}finally{fs.unlinkSync(settings);fs.unlinkSync(hook);}
assert.equal(data.liveRuntimeHome(),fs.realpathSync.native(process.env.CLAUDE_CONFIG_DIR));assert.deepEqual(data.normalizeReference({...ref}),ref);const requestSHA=require('./forge-code-roots').digest(request),live={...ref,request_sha256:requestSHA};assert.deepEqual(data.normalizeReference(live),live);assert.equal(live.request_sha256,requestSHA);assert.throws(()=>data.normalizeReference({...live,request_sha256:'invalid'}),e=>e.code==='native-host-protocol-sha256');assert.throws(()=>data.normalizeReference({...live,extra:true}),e=>e.code==='native-host-reference-schema');
 for(const code of ['ENOENT','ECONNREFUSED','native-host-owner-unavailable']){assert.equal(data.liveHistoricalStatusAllowed('status',{code}),true);for(const command of ['accept','replay','relay'])assert.equal(data.liveHistoricalStatusAllowed(command,{code}),false);}for(const code of ['native-host-live-mac','native-host-live-unverified-prechallenge-refusal','native-host-live-control-source','native-host-header-binding','native-host-reference-schema','native-host-live-ipc-cap','EACCES'])assert.equal(data.liveHistoricalStatusAllowed('status',{code}),false);
 // DUMMY-key protocol DATA only: no socket, real key, host/profile or enrollment.
 {const key=Buffer.alloc(32,91),domain='forge-native463-original-hook/v1',reported={code:'native-host-live-original-prebash-required',stage:'native-host-bridge',provider_called:true,source_error:{kind:'native-host-source-error-v1',error_class:'TypeError',frames:[{file:'forge-native-host-bridge.js',line:28,column:3}]}};
 const early={protocol_version:1,ack:'refused',error:reported},first=value=>{const error=data.unverifiedPrechallengeRefusal(value);if(error)throw error;const{server_mac,...unsigned}=value;data.checkLiveMac(key,{domain:domain+'/challenge',...unsigned},server_mac);return value;};
 const error=data.unverifiedPrechallengeRefusal(early);assert.equal(error.code,'native-host-live-unverified-prechallenge-refusal');assert.equal(error.provider_called,'unknown');assert.throws(()=>first(early),e=>e===error||e.code===error.code);
 const retained=data.safeError(error);assert.equal(retained.provider_called,'unknown');assert.equal(retained.unverified_refusal.trust,'UNAUTHENTICATED');assert.equal(retained.unverified_refusal.reported_code,reported.code);assert.deepEqual(retained.unverified_refusal.reported_source_error,reported.source_error);
 assert.deepEqual(data.safeError(Object.assign(new Error(error.code),retained)).unverified_refusal,retained.unverified_refusal,'wrapped diagnostic preserves explicit unverified trust');
 const invalid={...retained.unverified_refusal,trust:'AUTHENTICATED'};assert(!Object.hasOwn(data.safeError({code:error.code,unverified_refusal:invalid}),'unverified_refusal'));
 for(const value of [{...early,extra:'foreign'}, {...early,protocol_version:2}, {...early,error:{...reported,message:'PRIVATE_MUST_NOT_ESCAPE'}}, {...early,server_mac:'0'.repeat(64)}])assert.equal(data.unverifiedPrechallengeRefusal(value),null);
 let accessed=0;const getter={protocol_version:1,ack:'refused'};Object.defineProperty(getter,'error',{enumerable:true,get(){accessed++;return reported;}});assert.equal(data.unverifiedPrechallengeRefusal(getter),null);assert.equal(accessed,0);
 const challenge={protocol_version:1,kind:'native-host-live-control-challenge',nonce:'a'.repeat(64),sequence:1,binding:{attempt_id:'dummy-attempt'},tool_use_id:null,command:'status'},signed={...challenge,server_mac:data.macLive(key,{domain:domain+'/challenge',...challenge}).toString('hex')};assert.equal(first(signed),signed);assert.throws(()=>first({...signed,sequence:2}),e=>e.code==='native-host-live-mac');
 const response={protocol_version:1,ack:'refused',error:reported},signedAck={...response,server_mac:data.macLive(key,{domain:domain+'/ack',nonce:challenge.nonce,sequence:challenge.sequence,response}).toString('hex')},ack=value=>{const{server_mac,...unsigned}=value;data.checkLiveMac(key,{domain:domain+'/ack',nonce:challenge.nonce,sequence:challenge.sequence,response:unsigned},server_mac);};assert.doesNotThrow(()=>ack(signedAck));assert.throws(()=>ack(response),e=>e.code==='native-host-live-mac');assert.throws(()=>ack({...signedAck,error:{...reported,code:'native-host-foreign'}}),e=>e.code==='native-host-live-mac');key.fill(0);}
 const marker='PRIVATE_MESSAGE_MUST_NOT_ESCAPE',sanitized=data.safeError({code:'native-host-os-observation-refused',message:marker,os_diagnostic:{action:'acl',status:2,signal:null,spawn_code:null,typed_error:'native-host-os-observation-refused',exception_type:'System.Security.AccessControl.PrivilegeNotHeldException',hresult:-2147024891,stderr_captured_bytes:630,stderr_captured_sha256:'a'.repeat(64),stderr_may_be_truncated:false,raw:marker,command_line:marker,message:marker}});assert.equal(sanitized.os_diagnostic.hresult,-2147024891);assert.equal(sanitized.os_diagnostic.status,2);assert.equal(sanitized.os_diagnostic.exception_type,'System.Security.AccessControl.PrivilegeNotHeldException');assert.equal(sanitized.os_diagnostic.signal,null);assert.equal(sanitized.provider_called,'unknown');assert(!JSON.stringify(sanitized).includes(marker));assert(!Object.hasOwn(sanitized.os_diagnostic,'raw'));
}

// Serialized into this fixture's private Node preload before any Accounts/VCS import.
// Only failed original Git status results are observed; no command or env is changed.
function fixtureGitFailureObserver(fixtureRoot,sourceRoot,privateParent){
  const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),child=require('node:child_process'),original=child.spawnSync;
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),key=value=>process.platform==='win32'?value.toLowerCase():value;
  // The shared preload also runs in the parent/fixture host. Observe only the
  // original positive bridge OWNER, not their expected negative test commands.
  const expectedScript=path.join(sourceRoot,'scripts/forge-native-host-bridge.js'),expectedInput=path.join(fixtureRoot,'owner-input.json'),expectedObservation=path.join(fixtureRoot,'host-observation.json'),argv=process.argv;
  if(argv.length!==7||argv[2]!=='owner'||argv[3]!=='--input'||argv[5]!=='--host-observation'||key(path.resolve(argv[1]||''))!==key(expectedScript)||key(path.resolve(argv[4]||''))!==key(expectedInput)||key(path.resolve(argv[6]||''))!==key(expectedObservation))return;
  try{for(const file of [expectedScript,expectedInput,expectedObservation])if(key(fs.realpathSync.native(file))!==key(file)||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())return;}catch{return;}
  const directory=path.join(fixtureRoot,'git-failure-observations'),lockFile=path.join(directory,'.observer.lock');
  const MAX_FILES=16,MAX_TOTAL=262144,MAX_RECORD=16384,MAX_STDERR=8192,MAX_HASH=67108864;let sequence=0;
  function own(value,name){const row=value&&(typeof value==='object'||typeof value==='function')?Object.getOwnPropertyDescriptor(value,name):null;return row&&Object.hasOwn(row,'value')?row.value:undefined;}
  function token(value){return typeof value==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(value)?value:null;}
  function byteFacts(value){if(!Buffer.isBuffer(value)&&typeof value!=='string')return{bytes:null,sha256:null};const size=Buffer.isBuffer(value)?value.length:Buffer.byteLength(value);return{bytes:size,sha256:size<=MAX_HASH?hash(value):null};}
  function redactPrefix(text,prefix){if(typeof prefix!=='string'||!prefix)return text;const needle=prefix.toLowerCase(),haystack=text.toLowerCase();let start=0,result='';for(;;){const at=haystack.indexOf(needle,start);if(at<0)return result+text.slice(start);result+=text.slice(start,at)+'[PRIVATE_PREFIX]';start=at+prefix.length;}}
  function sanitizedStderr(value,effectiveEnv){
    if(!Buffer.isBuffer(value)&&typeof value!=='string')return null;
    let text=(Buffer.isBuffer(value)?value.subarray(0,MAX_STDERR):Buffer.from(value).subarray(0,MAX_STDERR)).toString('utf8');
    const prefixes=[fixtureRoot,privateParent,sourceRoot,...['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR','APPDATA','LOCALAPPDATA','TEMP','TMP'].map(name=>process.env[name])].filter(value=>typeof value==='string'&&value.length>=4).sort((a,b)=>b.length-a.length);
    for(const prefix of prefixes){const slash=prefix.replaceAll('\\','/');for(const variant of [prefix,slash,slash.replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase()),prefix.replaceAll('\\','\\\\')])text=redactPrefix(text,variant);}
    // Redact exact known secret values in memory, without persisting the values.
    for(const env of [process.env,effectiveEnv])if(env&&typeof env==='object')for(const name of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL|AUTHORIZATION|COOKIE/i.test(name)){const value=own(env,name);if(typeof value==='string'&&value.length>=6)text=text.split(value).join('[REDACTED_SECRET]');}
    text=text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,'[REDACTED_SECRET]')
      .replace(/\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+\/=\-]{8,}/gi,'[REDACTED_AUTHORIZATION]')
      .replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)[ \t]*:[^\r\n]*/gi,'[REDACTED_AUTHORIZATION_HEADER]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED_SECRET]')
      .replace(/\b((?:https?|ssh|git):\/\/)[^\/\s:@]+:[^\/\s@]+@/gi,'$1[REDACTED_SECRET]@')
      .replace(/\b(authorization|[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*)[ \t]*[=:][ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,'$1=[REDACTED_SECRET]')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r\n/g,'\n').replace(/[\x00-\x09\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ');
    return Buffer.from(text).subarray(0,MAX_STDERR).toString('utf8');
  }
  function observe(args,result,thrown){
    let lock=null,lockIdentity=null;try{
      const[command,argv,options]=args;if(typeof command!=='string'||!['git','git.exe'].includes(path.basename(command).toLowerCase())||!Array.isArray(argv)||argv.length!==6||argv[0]!=='-C'||typeof argv[1]!=='string'||argv[2]!=='status'||argv[3]!=='--porcelain'||argv[4]!=='-uall'||argv[5]!=='-z')return;
      const cwd=fs.realpathSync.native(argv[1]);if(key(path.resolve(argv[1]))!==key(cwd)||key(fs.realpathSync.native(fixtureRoot))!==key(fixtureRoot)||key(fs.realpathSync.native(privateParent))!==key(privateParent)||key(path.dirname(fixtureRoot))!==key(privateParent))return;
      const relative=path.relative(fixtureRoot,cwd).replaceAll('\\','/');if(!/^owner-fixture-[A-Za-z0-9_-]+\/(?:alpha|beta)$/.test(relative))return;
      const effectiveEnv=options&&typeof options==='object'&&options.env!==undefined?options.env:process.env;if(!effectiveEnv||typeof effectiveEnv!=='object')return;
      const selectedGitEnv=['GIT_OPTIONAL_LOCKS','GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_CEILING_DIRECTORIES','GIT_CONFIG','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS','GIT_NO_REPLACE_OBJECTS'].map(name=>{const present=Object.hasOwn(effectiveEnv,name),value=own(effectiveEnv,name),facts=typeof value==='string'?byteFacts(value):{bytes:null,sha256:null};return{name,present,...facts};});
      const failure=thrown||own(result,'error'),stdout=own(result,'stdout')??own(failure,'stdout'),stderr=own(result,'stderr')??own(failure,'stderr'),status=own(result,'status')??own(failure,'status'),signal=own(result,'signal')??own(failure,'signal'),stdoutFacts=byteFacts(stdout),stderrFacts=byteFacts(stderr),message=own(failure,'message');
      const record={schema_version:1,operation:'git-status-porcelain-uall-z',process_scope:'fixed-positive-bridge-owner',observation:thrown?'original-throw':'original-failed-result',at:new Date().toISOString(),observer_pid:process.pid,root_relative:relative,physical_root_sha256:hash(key(cwd)),fixture_root_sha256:hash(key(fixtureRoot)),environment_scope:effectiveEnv===process.env?'inherited-process':'explicit-options',selected_git_env:selectedGitEnv,status:Number.isSafeInteger(status)?status:null,signal:signal===null?null:token(signal),error_code:token(own(failure,'code')),error_message_facts:byteFacts(message),stdout_captured:stdoutFacts,stderr_captured:stderrFacts,stderr_sanitized_prefix:sanitizedStderr(stderr,effectiveEnv),stderr_prefix_truncated:typeof stderrFacts.bytes==='number'?stderrFacts.bytes>MAX_STDERR:null,privacy:'private bounded sanitized stderr only; no stdout content, raw command, raw env, raw stack or credential values'};
      const bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>MAX_RECORD)return;
      try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')return;}
      const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||key(fs.realpathSync.native(directory))!==key(directory))return;
      try{lock=fs.openSync(lockFile,'wx',0o600);lockIdentity=fs.fstatSync(lock);}catch{return;}
      let total=0,count=0;for(const name of fs.readdirSync(directory)){if(name==='.observer.lock')continue;if(!/^failure-[0-9]+-[0-9]+-[a-f0-9]{16}\.json$/.test(name))return;const item=fs.lstatSync(path.join(directory,name));if(!item.isFile()||item.isSymbolicLink()||item.nlink!==1||item.size>MAX_RECORD)return;total+=item.size;count++;}
      if(count>=MAX_FILES||total+bytes.length>MAX_TOTAL)return;
      fs.writeFileSync(path.join(directory,'failure-'+process.pid+'-'+(++sequence)+'-'+crypto.randomBytes(8).toString('hex')+'.json'),bytes,{flag:'wx',mode:0o600});
    }catch{}finally{if(lock!==null){try{fs.closeSync(lock);}catch{}try{const current=fs.lstatSync(lockFile);if(!current.isSymbolicLink()&&current.dev===lockIdentity.dev&&current.ino===lockIdentity.ino)fs.unlinkSync(lockFile);}catch{}}}
  }
  child.spawnSync=function(...args){let result;try{result=Reflect.apply(original,this,args);}catch(error){observe(args,null,error);throw error;}if(result&&(own(result,'error')||own(result,'status')!==0))observe(args,result,null);return result;};
}

const { get: fixtureNativeStackGet, set: fixtureNativeStackSet } =
  Object.getOwnPropertyDescriptor(new Error(),'stack') || {};
function fixtureTestSourceError(error) {
  if (!error || !['object','function'].includes(typeof error)) return null;
  let descriptor;try { descriptor=Object.getOwnPropertyDescriptor(error,'stack'); } catch { return null; }
  let stack=descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:null;
  if (descriptor && typeof fixtureNativeStackGet==='function'
      && descriptor.get===fixtureNativeStackGet && descriptor.set===fixtureNativeStackSet) {
    try { stack=Reflect.apply(fixtureNativeStackGet,error,[]); } catch { return null; }
  }
  if (typeof stack!=='string'||stack.length>32768) return null;
  const prefix=__filename+':',frames=[];
  for (const line of stack.split('\n').slice(1,65)) {
    if (!/^\s*at\s/.test(line)) continue;
    const index=line.lastIndexOf(prefix);if(index<0||index>0&&!/[\s(]/.test(line[index-1]))continue;
    const location=/^([1-9]\d{0,6}):([1-9]\d{0,6})\)?$/.exec(line.slice(index+prefix.length));if(!location)continue;
    frames.push({file:path.basename(__filename),line:Number(location[1]),column:Number(location[2])});
    if(frames.length===4)break;
  }
  return frames.length?{kind:'native463-fixture-test-source-error-v1',frames}:null;
}
async function assertLiveIPCTimeoutDiagnostics(){
 // Exercise the ORIGINAL relay and its actual timeout callback with a synthetic
 // socket/clock. These doubles grant no LIVE, OS, HMAC, provider or SDK authority.
 const vm=require('node:vm'),{EventEmitter}=require('node:events'),file=path.join(__dirname,'forge-native-host-bridge.js'),raw=fs.readFileSync(file,'utf8');
 const begin='async function relayCurrentHostHook(',end='\nfunction liveChallenge(';
 assert.equal(raw.split(begin).length,2);const start=raw.indexOf(begin),finish=raw.indexOf(end,start);assert(finish>start);
 const original=raw.slice(start,finish),sourceHash=hash(raw),capture=JSON.stringify({session_id:'fixture-session'});
 for(const queued of [false,true]){
  const calls=[],writes=[];let callback=null,keyCopy=null,timeoutError=null;
  class Socket extends EventEmitter{
   setTimeout(ms,fn){calls.push(['timeout',ms]);assert.equal(ms,20000);assert.equal(typeof fn,'function');callback=fn;return this;}
   write(bytes){writes.push(JSON.parse(Buffer.from(bytes).toString('utf8')));return true;}
   destroy(error){timeoutError=error;this.emit('error',error);this.emit('close');return this;}
   end(){assert.fail('A timeout cannot complete the relay successfully');}
  }
  const socket=new Socket(),ref={attempt_id:'fixture-attempt',dispatch_id:'fixture-dispatch',request_sha256:'fixture-request',host_session_sha256:'digest-session',profile_id:'fixture-profile',endpoint:'fixture-pipe',directory:'fixture-directory'},observed={sha256:'fixture-window',binding:{native_host_relay:ref}},who={parent:{pid:7,started:'parent-start'},p:{pid:8,started:'hook-start'},hook_sha256:'hook-hash',bridge_sha256:'bridge-hash'};
  const context={Buffer,process:{execPath:'fixture-node',argv:['node','hook','native-live','post']},LIVE_ID:'fixture-profile',LIVE_DOMAIN:'fixture-domain',LIVE_PHASES:['post'],LIMIT:{body:2048,header:4096},
   api:name=>{assert.equal(name,'owner-transport-window');return{observed:()=>observed};},
   originalHook:()=>{calls.push('original-hook');return who;},originalHookBinding:()=>({sessionId:'fixture-session',pid:7,started:'parent-start'}),nativeDigest:value=>value==='fixture-session'?'digest-session':'fixture-argv',physical:value=>value,endpoint:()=>ref.endpoint,
   liveKeyDirectory:()=>'/fixture-key',livePair:items=>{assert.deepEqual(JSON.parse(JSON.stringify(items)),[{action:'acl',file:'/fixture-key',directory:true},{action:'acl',file:path.join('/fixture-key','ingress.key')}]);calls.push('ACL-pair');return[{},{}];},path,read:(name,size)=>name.endsWith('ingress.key')?Buffer.alloc(32,9):Buffer.from('fixture-node'),copyBuffer:bytes=>(keyCopy=Buffer.from(bytes)),
   net:{connect:name=>{assert.equal(name,ref.endpoint);calls.push('connect');return socket;}},parse:bytes=>JSON.parse(bytes.toString('utf8')),json:value=>Buffer.from(JSON.stringify(value)+'\n'),hash,
   unverifiedPrechallengeRefusal:()=>{calls.push('prechallenge-check');return null;},checkLiveMac:(key,value,mac)=>{assert.equal(key,keyCopy);assert.equal(value.domain,'fixture-domain/challenge');assert.equal(mac,'fixture-mac');calls.push('challenge-authenticated');},macLive:()=>{calls.push('envelope-mac');return Buffer.from('fixture-envelope-mac');},
   fail:code=>{throw Object.assign(Error(code),{code});},liveHookOutput:()=>{assert.fail('No success/refusal frame was supplied');},receiveReadyFrame:()=>{assert.fail('No ready frame was supplied');}};
  const relay=vm.runInNewContext('('+original+')',context,{filename:file}),pending=relay({owner:'fixture-owner',phase:'post',capture,hookSource:'fixture-hook'}).then(()=>{assert.fail('Timeout must reject');},error=>error);
  assert.equal(typeof callback,'function');socket.emit('connect');assert.equal(writes.length,1);assert.equal(writes[0].kind,'live-hook');
  if(queued){socket.emit('data',Buffer.from(JSON.stringify({protocol_version:1,kind:'native-host-live-challenge',binding:{attempt_id:ref.attempt_id,dispatch_id:ref.dispatch_id,request_sha256:ref.request_sha256,session_sha256:ref.host_session_sha256,window_sha256:observed.sha256},sequence:1,nonce:'fixture-nonce',server_mac:'fixture-mac'})+'\n'));assert.equal(writes.length,2);assert.equal(writes[1].capture,capture);assert(calls.includes('challenge-authenticated'));assert(calls.includes('envelope-mac'));}
  callback();const error=await pending;assert.equal(error,timeoutError);assert.equal(error.code,'native-host-live-ipc-cap');assert.equal(error.message,'native-host-live-ipc-cap');assert.deepEqual(JSON.parse(JSON.stringify(error.ipc_diagnostic)),{schema_version:1,stage:queued?'envelope-queued':'envelope-not-queued'});assert.deepEqual(calls.filter(Array.isArray),[['timeout',20000]]);assert.equal(writes.length,queued?2:1);assert(keyCopy.every(byte=>byte===0),'Original finally clears the key after rejection');
 }
 assert.equal(hash(fs.readFileSync(file,'utf8')),sourceHash);console.log('PASS actual relay timeout callback: both client-local queue stages, unchanged code/20s/rejection/key clearing; synthetic only');
}

async function assertSynchronousPreludeWiring(){
 const Module=require('node:module'),filename=require.resolve('./forge-native-host-bridge'),raw=fs.readFileSync(filename,'utf8'),copy=new Module(filename+'#closed-prelude-data',module);copy.filename=filename;copy.paths=Module._nodeModulePaths(path.dirname(filename));
 const requestHandle={},profileHandle={},request={test_only:true},options={},calls=[],sentinel=Object.assign(new Error('TEST_STOP_BEFORE_NATIVE_RUN'),{code:'TEST_STOP_BEFORE_NATIVE_RUN'}),actualRequire=copy.require.bind(copy);
 copy.require=name=>name==='./forge-native-host-request'?{runSynchronousReadPrelude(h,p,kind){assert.equal(h,requestHandle);assert.equal(p,profileHandle);assert.equal(kind,'execute-owner-preflight');calls.push(kind);return{request,options};}}:name==='./forge-native-host-profile'?{}:name==='./forge-native-execution'?{}:name==='./forge-protected-owner-activity'?{async withNativeExecutionActivity(r,p){assert.equal(r,request);assert.equal(p,profileHandle);assert(options.lifecycle?.journal);assert.equal(typeof options.lifecycle.adapter.subscribe,'function');calls.push('activity');throw sentinel;}}:actualRequire(name);
 copy._compile(raw.replace(/^#![^\n]*(?:\n|$)/,'')+'\nmodule.exports.__preludeExecuteOwner=executeOwner;\n',filename);
 await assert.rejects(copy.exports.__preludeExecuteOwner({requestHandle,profile:profileHandle,directory:path.dirname(filename),attempt:'TEST-ONLY'}),e=>e===sentinel);
 assert.deepEqual(calls,['execute-owner-preflight','activity']);
 assert.equal(hash(fs.readFileSync(filename)),hash(raw));
 console.log('PASS bridge closed synchronous preflight wiring before activity/native.run; TEST DATA only');
}

// Private Module DATA exercises the original spool functions. These rows are
// never exported by production or admitted as a host/profile/Agent capability.
async function assertManifestSpoolBounds(){
 const Module=require('node:module'),filename=require.resolve('./forge-native-host-bridge'),raw=fs.readFileSync(filename,'utf8'),copy=new Module(filename+'#manifest-spool-data',module);
 copy.filename=filename;copy.paths=Module._nodeModulePaths(path.dirname(filename));
 const context={},request={resultFile:null,route:{fixture:true}},realRequire=copy.require.bind(copy);
 copy.require=name=>name==='./forge-native-host-request'?{assertOwnerContext(value){assert.equal(value,context);return{};},assertExecutionRequest(){return request;}}:name==='./forge-unit-sidecar'?{artifactFingerprint(){return'fixture';}}:name==='./forge-attempt-recovery'?{canonicalRequest:r=>r,requestIdentity:()=>({fixture:true})}:realRequire(name);
 copy._compile(raw.replace(/^#![^\n]*(?:\n|$)/,'')+'\nmodule.exports.__spoolData={writeImmutable,reserve,reconcile,read,parse,persistReceipt,spoolBound};\n',filename);
 const d=copy.exports.__spoolData,limit=copy.exports.LIMIT,root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-manifest-bound-'))),st=fs.statSync(root),row={context,directory:root,identity:{dev:st.dev,ino:st.ino},reservations:new Set(),dispatch:'fixture'};
 const target=path.join(root,'native-result.manifest.json'),clear=()=>{for(const name of fs.readdirSync(root))fs.unlinkSync(path.join(root,name));};request.resultFile=path.join(root,'native-result');
 try{
  assert.equal(limit.manifest,8*1024*1024);assert.equal(limit.input,2*1024*1024);assert.equal(limit.aggregate,16*1024*1024);assert.equal(limit.body,1024*1024);
  // Representative 19,940-entry owner metadata map: no source/provider contents.
  const map={};for(let i=0;i<19940;i++)map[('.gsd/fixture/'+String(i).padStart(5,'0')+'/').padEnd(100,'x')+(i<1547?'/':'')]=i<1547?'directory':'a'.repeat(64);
  const manifest=Buffer.from(JSON.stringify({request,prepared:{protected_owner:map}}));assert(manifest.length>3247653&&manifest.length<limit.manifest);
  const written=d.writeImmutable(row,'native-manifest',target,manifest);assert.equal(written.sha256,hash(manifest));assert.equal(row.reservations.size,0);assert.equal(Object.keys(d.parse(d.read(target,limit.manifest),limit.manifest).prepared.protected_owner).length,19940);
  assert.throws(()=>d.read(target),e=>e.code==='native-host-read-bound');assert.throws(()=>d.parse(manifest),e=>e.code==='native-host-json-bound');
  assert.deepEqual(d.writeImmutable(row,'native-manifest',target,manifest),written);
  const tampered=Buffer.from(manifest);tampered[tampered.length-2]^=1;fs.writeFileSync(target,tampered);assert.throws(()=>d.writeImmutable(row,'native-manifest',target,manifest),e=>e.code==='native-host-immutable-conflict');clear();
  for(const size of [limit.manifest-1,limit.manifest]){const bytes=Buffer.from('{"padding":"'+'x'.repeat(size-14)+'"}');assert.equal(bytes.length,size);d.writeImmutable(row,'native-manifest',target,bytes);assert.equal(d.parse(d.read(target,limit.manifest),limit.manifest).padding.length,size-14);clear();}
  assert.throws(()=>d.writeImmutable(row,'native-manifest',target,Buffer.alloc(limit.manifest+1)),e=>e.code==='native-host-spool-bound');assert(!fs.existsSync(target));
  for(const role of ['context','sealed','native-evidence','native-receipt','native-review','native-verification','unknown'])assert.throws(()=>d.reserve(row,role,limit.input+1,target),e=>e.code==='native-host-spool-bound');
  for(const role of ['candidate','return'])assert.throws(()=>d.reserve(row,role,limit.body+1,target),e=>e.code==='native-host-spool-bound');assert.throws(()=>d.reserve(row,'checkpoint',limit.terminal+1,target),e=>e.code==='native-host-spool-bound');
  for(const size of [-1,NaN,Infinity,1.5])assert.throws(()=>d.reserve(row,'native-manifest',size,target),e=>e.code==='native-host-spool-bound');assert.throws(()=>d.reserve(row,'native-manifest',0,target,Array(5).fill(path.join(root,'stage'))),e=>e.code==='native-host-spool-bound');
  const reservation=d.reserve(row,'native-manifest',manifest.length,target);fs.writeFileSync(target,manifest);assert.equal(d.reconcile(row,reservation),true,'failed-write reconciliation uses the manifest role bound');assert.equal(row.reservations.size,0);clear();
  fs.writeFileSync(path.join(root,'occupied'),Buffer.alloc(9*1024*1024));assert.throws(()=>d.reserve(row,'native-manifest',limit.manifest,target),e=>e.code==='native-host-spool-aggregate');clear();
  fs.writeFileSync(target,'{');assert.throws(()=>d.parse(d.read(target,limit.manifest),limit.manifest),e=>e.code==='native-host-json-invalid');clear();
  d.writeImmutable(row,'native-manifest',target,manifest);
  const record={phase:'failed',dispatch_id:row.dispatch,fingerprint:'fixture',route:request.route,manifest_sha256:hash(manifest),recovery_identity_sha256:require('./forge-code-roots').digest({fixture:true})};
  const receipt=Buffer.from(JSON.stringify(record)),receiptSHA=hash(receipt),receiptFile=request.resultFile+'.receipt.json.'+receiptSHA+'.json';fs.writeFileSync(receiptFile,receipt);const pointer={file:receiptFile,sha256:receiptSHA};
  assert.doesNotThrow(()=>d.persistReceipt(row,pointer),'actual receipt consumer reads and parses the larger manifest');
  fs.writeFileSync(target,tampered);assert.throws(()=>d.persistReceipt(row,pointer),e=>e.code==='native-host-json-invalid'||e.code==='native-host-receipt-binding');fs.writeFileSync(target,manifest);
  fs.writeFileSync(receiptFile,Buffer.from(receipt.toString().replace('failed','FAILED')));assert.throws(()=>d.persistReceipt(row,pointer),e=>e.code==='native-host-receipt-pointer-hash');
  assert(raw.includes("parse(read(current.resultFile+'.manifest.json',LIMIT.manifest),LIMIT.manifest)"),'replay uses the same explicit manifest read/parse budget');
  console.log('PASS manifest spool DATA: metadata19940,8MiBboundary,otherroles,aggregate,reconcile,receipt,malformed/hash/tamper; not LIVE');
 }finally{clear();fs.rmdirSync(root);}
}

async function assertAutoManifestStart(f,observationFile){
 const Module=require('node:module'),filename=require.resolve('./forge-native-host-bridge'),raw=fs.readFileSync(filename,'utf8'),cached=require.cache[filename],copy=new Module(filename+'#private-auto-manifest',module);
 copy.filename=filename;copy.paths=Module._nodeModulePaths(path.dirname(filename));
 copy._compile(raw.replace(/^#![^\n]*(?:\n|$)/,'')+'\nmodule.exports.__manifestFixture={enrollHost,originalOwnerChannel,row:c=>channels.get(c),executeOwner};\n',filename);
 const execution=require('./forge-task-execution'),delivery=require('./forge-native-recovery-delivery'),originalSnapshot=execution.protectedSnapshot,originalAssert=execution.assertProtected,originalPrepare=delivery.prepare;
 const stop=Object.assign(new Error('TEST_ONLY_STOP_AFTER_REAL_MANIFEST_START'),{code:'TEST_ONLY_STOP_AFTER_REAL_MANIFEST_START'}),extraPrefix='.gsd/fixture-spool-metadata/',metrics={snapshots:0,guards:0,start:0,Agent:0};
 require.cache[filename]=copy;
 try{
  const requestApi=require('./forge-native-host-request'),profileApi=require('./forge-native-host-profile'),context=requestApi.buildOwnerContext(f.input),facts=requestApi.assertOwnerContext(context);
  assert.equal(facts.gates.plan,'skipped');assert.equal(facts.gates.planSkipReason,'auto-defer');
  const host=copy.exports.__manifestFixture.enrollHost(context,observationFile),channel=copy.exports.__manifestFixture.originalOwnerChannel(context,host,'fixture-only-input'),row=copy.exports.__manifestFixture.row(channel);
  row.profile=profileApi.enrollForegroundProfile(context,host);row.requestHandle=requestApi.buildExecutionRequest(context,channel);profileApi.assertCapabilityAdmission(row.profile);
  // The private fixture keeps the ORIGINAL snapshot producer and all its real
  // rechecks. Synthetic hash-only metadata pads that snapshot to the real-world
  // shape; it never mints owner authority or claims filesystem entries exist.
  execution.protectedSnapshot=root=>{const map=originalSnapshot(root);metrics.snapshots++;if(path.resolve(root)===path.resolve(f.owner))for(let i=0;i<19940;i++)map[(extraPrefix+String(i).padStart(5,'0')).padEnd(100,'x')]='a'.repeat(64);return map;};
  execution.assertProtected=(root,expected)=>{metrics.guards++;const real=Object.fromEntries(Object.entries(expected).filter(([key])=>!key.startsWith(extraPrefix)));return originalAssert(root,real);};
  delivery.prepare=options=>{const session=originalPrepare(options);return{...session,start(){const result=session.start(),bytes=fs.readFileSync(result.manifest_file),manifest=JSON.parse(bytes);metrics.start++;assert(bytes.length>3247653&&bytes.length<=copy.exports.LIMIT.manifest);assert.equal(manifest.request.gates.planSkipReason,'auto-defer');assert.equal(result.manifest_sha256,hash(bytes));assert(Object.keys(manifest.prepared.protected_owner).length>=19940);throw stop;}};};
  await assert.rejects(copy.exports.__manifestFixture.executeOwner(row),error=>error===stop);
  assert(metrics.snapshots>0&&metrics.guards>0);assert.equal(metrics.start,1);assert.equal(row.sealed,null,'stop is BEFORE original Agent callback');
  console.log('PASS private combined auto-defer + synchronous prelude + ORIGINAL snapshot/guards + native.run/prepare/start with padded owner metadata; stop before Agent, not LIVE');
 }finally{execution.protectedSnapshot=originalSnapshot;execution.assertProtected=originalAssert;delivery.prepare=originalPrepare;if(cached)require.cache[filename]=cached;else delete require.cache[filename];}
}

async function main({partialPublication=false,manifestOnly=false}={}){
  await assertSynchronousPreludeWiring();
  await assertLiveIPCTimeoutDiagnostics();
  assertBridgeCohortSelectors();
  // Unix socket paths have a small OS byte limit. Keep the entirely owned
  // fixture parent short even when the CI worker's TMPDIR is deeply nested.
  const old={...process.env},tempParent=process.platform==='win32'?os.tmpdir():fs.realpathSync.native('/tmp');
  const privateTmp=fs.realpathSync.native(fs.mkdtempSync(path.join(tempParent,process.platform==='win32'?'forge-native463-test-':'fn-')));
  let f=null,ownerReference=null,hostClose=null;
  try{
    // Stabilize the private temporary parent BEFORE creating the fixture root.
    process.env.TMP=privateTmp;process.env.TEMP=privateTmp;if(process.platform!=='win32')process.env.TMPDIR=privateTmp;
    const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-native463-fixture-')));
    assert.equal(fs.realpathSync.native(path.dirname(root)),fs.realpathSync.native(os.tmpdir()),'fixture parent equals the current private temporary directory');
    if(process.platform!=='win32')assert(Buffer.byteLength(path.join(root,'channels','forge-native-XXXXXX','owner.sock'))<=103,'fixture Unix socket endpoint must fit the macOS/Linux pathname limit');
    // All homes, account stub and Forge source material are private BEFORE any Forge import.
    for(const [k,rel]of Object.entries({HOME:'home',USERPROFILE:'home',CODEX_HOME:'home/codex',CLAUDE_CONFIG_DIR:'home/claude',FORGE_HOME:'forge',APPDATA:'home/appdata'})){
      process.env[k]=path.join(root,rel);fs.mkdirSync(process.env[k],{recursive:true});}
    for(const key of Object.keys(process.env))if(key.startsWith('FORGE_NATIVE_HOST_'))delete process.env[key];
    process.env.FORGE_CLAUDE_OWNER_SESSION_ID='fixture-native463';process.env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';
    const source=path.resolve(__dirname,'..');for(const dir of ['shared','schemas'])fs.cpSync(path.join(source,dir),path.join(process.env.FORGE_HOME,dir),{recursive:true});
    put(path.join(process.env.FORGE_HOME,'forge-agent-prefs.jsonc'),'{}');
    const preload=path.join(root,'private-account-preload.cjs');
    const gitObserverSource='('+fixtureGitFailureObserver.toString()+')('+[root,source,privateTmp].map(value=>JSON.stringify(value)).join(',')+');\n';
    put(preload,"'use strict';\n"+gitObserverSource+"const a=require("+JSON.stringify(path.join(__dirname,'forge-accounts.js'))+");\na.resolveLaunch=()=>({name:'native463-isolated-fixture',token:'fixture-token-not-a-real-credential'});\n");
    if(partialPublication){
      // Fault the ORIGINAL publisher only after its actual full materialization.
      // No native callback/result/approval is injected, and the fixture retains
      // the genuine ready pointer from before publication acknowledgement.
      fs.appendFileSync(preload,"\nconst side=require("+JSON.stringify(path.join(__dirname,'forge-unit-sidecar.js'))+");\nconst originalMaterialize=side.materialize;let faultOnce=true;side.materialize=(...args)=>{const result=originalMaterialize(...args);if(faultOnce){faultOnce=false;throw Object.assign(new Error('fixture-publication-ack-lost'),{code:'fixture-publication-ack-lost'});}return result;};\n");
      fs.appendFileSync(preload,"const replayAssert=require('node:assert/strict'),replayFs=require('node:fs'),replayWindows=require(REPLAY_WINDOWS),replayActivity=require(REPLAY_ACTIVITY);\nconst replayOutside=new (require('node:async_hooks').AsyncResource)('fixture-replay-outside-native-scope');\nconst originalNativeActivity=replayActivity.withNativeExecutionActivity;\nreplayActivity.withNativeExecutionActivity=(request,profile,action)=>originalNativeActivity(request,profile,runtime=>{\n  const replayBridge=require(REPLAY_BRIDGE),originalReplay=replayBridge.runOriginalReplayPublication;\n  replayBridge.runOriginalReplayPublication=(operation,actualRuntime,actualRequest)=>{\n    const refused=error=>error.code==='native-host-replay-operation-required';\n    replayAssert.throws(()=>replayOutside.runInAsyncScope(()=>originalReplay(operation,actualRuntime,actualRequest)),refused,'outside scope cannot consume genuine operation');\n    replayAssert.throws(()=>originalReplay({},actualRuntime,actualRequest),refused,'foreign operation refused');\n    replayAssert.equal(actualRuntime,runtime);replayAssert.equal(replayActivity.currentScope(),runtime);\n    replayAssert.equal(replayWindows.assertMutationAllowed(runtime.owner),true,'genuine replay runs in original held owner window');\n    const result=originalReplay(operation,actualRuntime,actualRequest);replayAssert(result&&!result.then);\n    replayAssert.throws(()=>originalReplay(operation,actualRuntime,actualRequest),refused,'operation is one-use');\n    replayFs.writeFileSync(REPLAY_LEDGER,JSON.stringify({checks:5,original_runtime:true,synchronous:true}));return result;\n  };return action(runtime);\n});".replaceAll('REPLAY_WINDOWS',JSON.stringify(path.join(__dirname,'forge-owner-transport-window.js'))).replaceAll('REPLAY_ACTIVITY',JSON.stringify(path.join(__dirname,'forge-protected-owner-activity.js'))).replaceAll('REPLAY_BRIDGE',JSON.stringify(path.join(__dirname,'forge-native-host-bridge.js'))).replaceAll('REPLAY_LEDGER',JSON.stringify(path.join(root,'replay-window-checks.json')))+'\n');
    }
    process.env.NODE_OPTIONS='--require '+JSON.stringify(preload);
    // Parent and every CLI/retained owner child observe failed Git status before the same account stub.
    require(preload);
    const bridge=require('./forge-native-host-bridge');
    assert.throws(()=>bridge.collectOriginalHookBootstrap({hookSource:path.join(__dirname,'forge-hook.js')}),e=>e.code==='native-host-original-hook-required','a test/import is not original SessionStart Hook main');
    assert.throws(()=>bridge.assertLiveRelayReference({}, {}, {}),e=>e.code==='native-host-live-channel-required');
    assert.throws(()=>bridge.assertLiveControlCommand({}, {}, 'node arbitrary.js'),e=>e.code==='native-host-live-channel-required');
    for(const [name,args]of [['assertOwnedChannel',[{},{}]],['assertNativeAdmission',[{},{}]],
      ['assertHostObservation',[{},{}]],['assertIngressCapability',[{},{}]],['assertObservation',[{},{}]],['assertCandidate',[{},{}]],['assertOriginalPreparePost',[{}, {}, 'not an authority']]])
      assert.throws(()=>bridge[name](...args),e=>/^native-host-/.test(e.code),'plain JSON cannot forge '+name);
    const marker={schema_version:1,kind:'forge-native463-isolated-fixture',root};put(path.join(root,'FIXTURE-ORIGIN.json'),marker);
    f=require('./forge-native-host-request.test').createOwnerFixture({root,mode:partialPublication?'step':'auto'});
    if(!partialPublication)fs.unlinkSync(f.planFile.replace('-PLAN.md','-PLAN-GATE.md')); // Full tests real auto producer; partial retains approved step path.
    const requestApi=require('./forge-native-host-request'),isolationApi=require('./forge-isolation'),primary=f.contract.code_roots.find(row=>row.id===f.contract.primary_root_id),primaryBranch=isolationApi.gitCurrentBranch(primary.path);
    assert.equal(typeof primaryBranch,'string');assert(primaryBranch);
    const branchContext=requestApi.buildOwnerContext(f.input),renderIsolation=requestApi.assertOwnerContext(branchContext).render_isolation;
    assert.deepEqual(renderIsolation,{mode:'worktree',primary_root_id:primary.id,code_dir:primary.path,branch:primaryBranch},'render binding comes from actual primary checkout, not a fabricated run branch');
    const renamed='native463-observed-branch-'+crypto.randomUUID();
    const renameBranch=branch=>{const child=cp.spawnSync('git',['-C',primary.path,'branch','-m',branch],{encoding:'utf8',windowsHide:true});assert.equal(child.status,0,'private fixture branch rename must complete');};
    let branchMoved=false;try{renameBranch(renamed);branchMoved=true;assert.equal(isolationApi.gitCurrentBranch(primary.path),renamed);assert.throws(()=>requestApi.assertOwnerContext(branchContext),error=>error.code==='native-host-owner-authority-changed','a moved physical branch cannot alias the captured request context');}
    finally{if(branchMoved)renameBranch(primaryBranch);}
    assert.equal(isolationApi.gitCurrentBranch(primary.path),primaryBranch);assert.deepEqual(requestApi.assertOwnerContext(branchContext).render_isolation,renderIsolation,'restoration is actual fixture Git state, not a renewed authority flag');
    const input=path.join(root,'owner-input.json');put(input,f.input);
    const agentFile=path.join(root,'forge-executor.md');put(agentFile,'---\nname: forge-executor\nmodel: claude-sonnet-5-5\neffort: high\n---\nFixture executor only.\n');
    const schema={type:'object',properties:{prompt:{type:'string'},subagent_type:{type:'string'},model:{enum:['sonnet']},effort:{enum:['high']},run_in_background:{type:'boolean',default:false}},required:['prompt','subagent_type','model']};
    const schemaFile=path.join(root,'agent-tool-schema.json');put(schemaFile,schema);
    const config={schema_version:1,profile_id:'forge-native463-fixture-foreground-v1',fixture_root:root,
      fixture_marker_sha256:hash(fs.readFileSync(path.join(root,'FIXTURE-ORIGIN.json'))),relay_protocol:'forge-native463-fixture-foreground-v1'};
    const configFile=path.join(root,'host-configuration.json');put(configFile,config);
    const effortFile=path.join(root,'effort.json');put(effortFile,{transport:'agent-argument',value:'high'});
    const observation={schema_version:1,profile_id:config.profile_id,host_session:'fixture-native463',
      host_binary:{physical_path:fs.realpathSync.native(process.execPath),sha256:hash(fs.readFileSync(process.execPath)),observed_version:process.version},
      active_tool:{name:'Agent',schema_sha256:digest(schema),schema,observation_reference:schemaFile},
      mode_support:{requested_mode:'foreground',effective_configuration_sha256:hash(fs.readFileSync(configFile)),observation_reference:configFile},
      effort_observation:{transport:'agent-argument',value:'high',source_fingerprint:hash(fs.readFileSync(effortFile)),observation_reference:effortFile},
      agent_definition:{agent_type:'forge-executor',physical_path:agentFile,sha256:hash(fs.readFileSync(agentFile))},provenance:'fixture-origin'};
    const observationFile=path.join(root,'host-observation.json');put(observationFile,observation);
    if(manifestOnly){await assertAutoManifestStart(f,observationFile);return;}
    const ownerDigest=()=>{const rows=[];function walk(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),st=fs.lstatSync(file);assert(!st.isSymbolicLink());if(st.isDirectory())walk(file);else rows.push([path.relative(f.owner,file),hash(fs.readFileSync(file))]);}}walk(f.owner);return digest(rows);};
    const beforeBudget=ownerDigest(),budget=await cli('prepare-budget',['--input',input],{env:{...process.env,BASH_DEFAULT_TIMEOUT_MS:'240_000',BASH_MAX_TIMEOUT_MS:'120000'}});
    assert.equal(budget.value.kind,'native-host-prepare-budget');assert.equal(budget.value.prepare_timeout_ms,240000);assert.equal(budget.value.profile_cap_ms,600000);assert.equal(budget.value.admission,false);assert.equal(ownerDigest(),beforeBudget,'budget lookup creates no run/claim/BEGIN/publication/spool or owner metadata');
    const malformedBudget=await cli('prepare-budget',['--input',input],{expect:1,env:{...process.env,BASH_MAX_TIMEOUT_MS:'unknown'}});assert.equal(JSON.parse(malformedBudget.stderr.toString().trim()).code,'native-host-prepare-bash-timeout-invalid');assert.equal(ownerDigest(),beforeBudget);
    // No genuine SessionStart OS bootstrap exists in this isolated fixture.
    const noBootstrap=await cli('prepare',['--input',input],{expect:1});
    assert.equal(JSON.parse(noBootstrap.stderr.toString().trim()).code,'native-host-original-bootstrap-required');
    // Brand forgery and legacy BEGIN refusal are exercised through production CLI, not injected callbacks.
    const legacy=require('./forge-native-host-request.test').createOwnerFixture({root,legacy:true});
    const legacyInput=path.join(root,'legacy-input.json');put(legacyInput,legacy.input);
    const refused=await cli('prepare',['--input',legacyInput,'--host-observation',observationFile],{expect:1});
    assert.match(refused.stderr.toString(),/native-host-workflow-binding-unavailable/);legacy.cleanup();
    const realUnknown=path.join(root,'unknown-real-host.json');put(realUnknown,{...observation,profile_id:'claude-agent-foreground-v1',provenance:'observed-host'});
    const unsupported=await cli('prepare',['--input',input,'--host-observation',realUnknown],{expect:1});
    assert.match(unsupported.stderr.toString(),/native-host-foreground-join-schema-unknown/,'version/schema JSON cannot assert real Claude join support');
    const prepared=await cli('prepare',['--input',input,'--host-observation',observationFile]);ownerReference=prepared.value;
    assert.equal(prepared.value.kind,'prepared');assert.equal(prepared.value.reference.invocation_sha256.length,64);
    const ref=prepared.value.reference,sealed=JSON.parse(fs.readFileSync(prepared.value.arguments_file,'utf8'));
    assert(sealed.arguments.prompt.includes('\nISOLATION: worktree\nBRANCH: '+primaryBranch+'\nCODE_DIR: '+primary.path+'\n'),'actual sealed prompt carries the observed primary worktree branch');

    // Actual providerless CLI stdout is checked against the ORIGINAL owner
    // callback's immutable checkpoint before starting the fixture Agent.
    const initialCheckpoints=fs.readdirSync(ref.directory).filter(n=>/^checkpoint-\d{2}\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(ref.directory,n),'utf8'))),originalPrepared=initialCheckpoints.find(r=>r.phase==='awaiting_host');assert(originalPrepared);assert.equal(prepared.stdout.length,originalPrepared.details.prepared_stdout_bytes);assert.equal(hash(prepared.stdout),originalPrepared.details.prepared_stdout_sha256);
    const postData={hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'fixture-data-original-prepare',tool_response:{stdout:prepared.stdout.toString('utf8'),stderr:'',interrupted:false,isImage:false}},normalizers=readonlyBridgeData();assert.equal(normalizers.validateInitialPreparePost(postData,prepared.stdout,originalPrepared.details.prepared_stdout_sha256),'fixture-data-original-prepare');
    // Synthetic Bash DATA negatives, never a forged genuine factory witness.

    const observedOptional=structuredClone(postData);observedOptional.tool_response.stdout=observedOptional.tool_response.stdout.slice(0,-1);observedOptional.tool_response.noOutputExpected=false;assert.equal(normalizers.validateInitialPreparePost(observedOptional,prepared.stdout,originalPrepared.details.prepared_stdout_sha256),'fixture-data-original-prepare');const wrongOptional=structuredClone(observedOptional);wrongOptional.tool_response.noOutputExpected='false';assert.throws(()=>normalizers.validateInitialPreparePost(wrongOptional,prepared.stdout,originalPrepared.details.prepared_stdout_sha256),e=>e.code==='native-host-original-prepare-post-schema');const unknownResponse=structuredClone(observedOptional);unknownResponse.tool_response.unobserved=true;assert.throws(()=>normalizers.validateInitialPreparePost(unknownResponse,prepared.stdout,originalPrepared.details.prepared_stdout_sha256),e=>e.code==='native-host-original-prepare-post-schema');

    const failedSecond=structuredClone(postData);failedSecond.tool_response.stdout='';failedSecond.tool_response.stderr='native-host-owner-refused';assert.throws(()=>normalizers.validateInitialPreparePost(failedSecond,prepared.stdout,originalPrepared.details.prepared_stdout_sha256),e=>e.code==='native-host-original-prepare-output-mismatch');
    const interrupted=structuredClone(postData);interrupted.tool_response.interrupted=true;assert.throws(()=>normalizers.validateInitialPreparePost(interrupted,prepared.stdout,originalPrepared.details.prepared_stdout_sha256),e=>e.code==='native-host-original-prepare-post-incomplete');
    const truncated=structuredClone(postData);truncated.tool_response.stdout=truncated.tool_response.stdout.slice(0,-64);assert.throws(()=>normalizers.validateInitialPreparePost(truncated,prepared.stdout,originalPrepared.details.prepared_stdout_sha256),e=>e.code==='native-host-original-prepare-output-mismatch');
    const foreign=structuredClone(postData),foreignPayload=structuredClone(prepared.value);foreignPayload.reference.attempt_id='different-prepare';foreign.tool_response.stdout=JSON.stringify(foreignPayload)+'\n';assert.throws(()=>normalizers.validateInitialPreparePost(foreign,prepared.stdout,originalPrepared.details.prepared_stdout_sha256),e=>e.code==='native-host-original-prepare-output-mismatch');

    const initialMarker=fs.readFileSync(path.join(f.base,'S01-PLAN.md'));
    const noCapturedReturn=await cli('accept',['--attempt',prepared.value.reference_file],{expect:1});
    assert.equal(JSON.parse(noCapturedReturn.stderr.toString().trim()).code,'native-host-live-capture-not-ready','data-only accept cannot manufacture a retained live return');
    assert.equal((await cli('status',['--attempt',prepared.value.reference_file])).value.ready,false);
    assert.equal(sealed.invocation_sha256,sealed.binding.invocation_sha256,'original callback witness owns native invocation digest');
    // The endpoint is live and still awaiting a host; this reaches real binding validation.
    const foreignFile=path.join(root,'foreign-attempt.json');put(foreignFile,{...ref,attempt_id:'foreign'});
    const hold=holdAdmission(ref);await hold.admitted;
    try{
      const bad=await cli('status',['--attempt',foreignFile],{expect:1});
      assert.equal(JSON.parse(bad.stderr.toString().trim()).code,'native-host-header-binding');
      const busy=await cli('status',['--attempt',prepared.value.reference_file],{expect:1});
      assert.equal(JSON.parse(busy.stderr.toString().trim()).code,'native-host-ingress-busy','rejected socket cannot release another socket admission');
    }finally{hold.socket.end();await hold.closed;}
    assert.equal((await cli('status',['--attempt',prepared.value.reference_file])).value.ready,false);
    const unframed=path.join(root,'unframed-candidate.json');put(unframed,{status:'done',joined:true,provider_called:true});
    const invalidCandidate=await cli('accept',['--attempt',prepared.value.reference_file,'--candidate',unframed],{expect:1});
    assert.match(invalidCandidate.stderr.toString(),/native-host-candidate-contract/);
    assert.equal((await cli('status',['--attempt',prepared.value.reference_file])).value.ready,false);
    const capturedPrompt=sealed.arguments.prompt;assert(capturedPrompt.includes('File-only captured-original-tool-return:')&&capturedPrompt.includes('ORIGINAL Agent tool response')&&capturedPrompt.includes('the owner runs plan checks after the original tool return.'),'genuine original CLI sealed prompt uses captured return and owner checks');
    assert(!capturedPrompt.includes('Write the response only to this validated TEMP result path:'),'genuine captured worker is never ordered to Write the external spool');
    assert.equal(sealed.tool,'Agent');assert.equal(sealed.arguments.model,'sonnet');assert.equal(sealed.arguments.effort,'high');
    assert.notEqual(sealed.arguments.run_in_background,true);assert.equal(sealed.arguments.subagent_type,'forge-executor');
    const saved=JSON.parse(fs.readFileSync(path.join(ref.directory,'native-result.manifest.json'),'utf8')),request=saved.request;
    assertLiveDataRegressions(ref,request);
    assert.equal(request.scope,'milestone');assert.equal(request.unitType,'execute-task');assert.equal(request.workflowId,f.workflow);
    assert.equal(request.route.worker_mode,'native');assert.equal(request.route.host_runtime,'claude');assert.equal(request.route.model_resolved,'claude-sonnet-5-5');
    assert.equal(request.route.effort,'high');assert.equal(request.gates.security,'not-applicable');assert(!Object.hasOwn(request,'securityFile'));
    assert.equal(request.execution_contract.code_roots.length,2);assert(saved.inputs.some(r=>r.file===f.planFile));
    assert(saved.inputs.some(r=>r.file===request.contextFile));assert(saved.inputs.every(r=>r.file!==undefined));
    const side=require('./forge-unit-sidecar'),locations=side.locations(request),inventory=require('./forge-delivery').inventoryPlan(fs.readFileSync(f.planFile,'utf8'),f.planFile,locations.rules[locations.delivery.input].unit);
    const result={status:'done',summary:'Private CLI fixture completed both roots.',files_changed:f.contract.code_roots.map(r=>r.id+'::same.txt'),
      must_haves_status:inventory.criteria.map(c=>({kind:c.origin,index:c.index,item:c.text,note:'Observed by real verification.',status:'met',
        root_id:c.origin==='artifact'?require('./forge-code-roots').resolvePath(f.contract,c.artifact_path).root_id:'',
        evidence:c.origin==='artifact'?[]:f.contract.code_roots.map(r=>({root_id:r.id,check:'node check.cjs',stdout_line:'PASS native463 claimed root content'}))}))};
    const raw='---GSD-WORKER-RESULT---\nstatus: done\nresult_json: '+JSON.stringify(result)+'\n---END-RESULT---\n';
    assert(require('./forge-worker-result').parseJsonEnvelope(raw).ok);
    const jobFile=path.join(root,'fixture-job.json'),job={root,partial_publication:partialPublication,job_file:jobFile,attempt_file:prepared.value.reference_file,reference:ref,code_roots:f.contract.code_roots,raw_result:raw};put(jobFile,job);
    const host=await start(__filename,['--fixture-host',jobFile]).closed;hostClose=host;assert.equal(host.code,0,'fixture host CLI chain; stderr SHA '+hash(host.stderr));assert(host.closed);
    if(partialPublication){
      let pending;
      for(let i=0;i<200;i++){
        pending=(await cli('status',['--attempt',prepared.value.reference_file])).value;
        if(pending.phase==='publication_pending'&&pending.error?.code==='fixture-publication-ack-lost')break;
        assert.notEqual(pending.phase,'failed');await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.equal(pending.phase,'publication_pending');assert.equal(pending.error?.code,'fixture-publication-ack-lost');assert.equal(pending.ready,false);
      const markerFile=path.join(f.base,'S01-PLAN.md'),after=fs.readFileSync(markerFile);
      assert(after.toString('utf8').includes('[x]'),'real publisher wrote PLAN before acknowledgement failed');
      const checkpoints=fs.readdirSync(ref.directory).filter(n=>/^checkpoint-\d{2}\.json$/.test(n)).sort().map(n=>JSON.parse(fs.readFileSync(path.join(ref.directory,n),'utf8')));
      const readyPointer=checkpoints.findLast(row=>row.phase==='publication_pending'&&row.details?.receipt).details.receipt;
      const record=JSON.parse(fs.readFileSync(readyPointer.file)),marker=record.artifacts.find(a=>path.resolve(f.owner,a.path)===markerFile);
      assert(marker);const before=initialMarker;
      assert.equal(hash(before),marker.before,'fixture exact original marker preimage');
      const foreign=path.join(f.owner,'.gsd','native-pending-foreign.txt');let createdForeign=false;
      try{
        fs.writeFileSync(foreign,'foreign',{flag:'wx'});createdForeign=true;
        const refusal=await cli('status',['--attempt',prepared.value.reference_file],{expect:1});
        assert.equal(JSON.parse(refusal.stderr.toString().trim()).code,'native-host-publication-owner-changed');
      }finally{if(createdForeign)fs.unlinkSync(foreign);}
      try{
        assert.equal(after.length,before.length,'genuine checkbox publication preserves the retained byte bound');
        const sameSizeForeign=Buffer.from(before);sameSizeForeign[0]^=1;
        assert.equal(sameSizeForeign.length,Math.max(before.length,after.length));
        assert.notEqual(hash(sameSizeForeign),hash(before));assert.notEqual(hash(sameSizeForeign),hash(after));
        fs.writeFileSync(markerFile,sameSizeForeign);
        const changed=await cli('status',['--attempt',prepared.value.reference_file],{expect:1});
        assert.equal(JSON.parse(changed.stderr.toString().trim()).code,'native-publication-artifact-changed','in-bound third-state bytes reach the artifact guard');
        fs.writeFileSync(markerFile,after);
        fs.appendFileSync(markerFile,'third state');
        assert(fs.statSync(markerFile).size>Math.max(before.length,after.length),'original appended state exceeds the exact retained read bound');
        const refusal=await cli('status',['--attempt',prepared.value.reference_file],{expect:1});
        assert.equal(JSON.parse(refusal.stderr.toString().trim()).code,'native-publication-read-source_too_large');
        fs.writeFileSync(markerFile,before);
        assert.equal((await cli('status',['--attempt',prepared.value.reference_file])).value.ready,false,'exact BEFORE with other artifacts AFTER remains only pending');
      }finally{fs.writeFileSync(markerFile,after);}
      await cli('replay',['--attempt',prepared.value.reference_file]);
    }
    const ready=await waitReady(prepared.value.reference_file);
    if(partialPublication)assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'replay-window-checks.json'),'utf8')),{checks:5,original_runtime:true,synchronous:true});
    assert.equal(ready.ready,true);assert.notEqual(ready.historical,true);assert.equal(ready.completion_receipt.kind,'native-host-ready');assert.equal(ready.completion_receipt.origin,'fixture-origin');assert.equal(ready.completion_receipt.request_sha256,require('./forge-code-roots').digest(request));assert.equal(ready.completion_receipt.activity,'settled');assert.equal(ready.completion_receipt.readback,'verified');if(!partialPublication){const cut=JSON.parse(fs.readFileSync(path.join(root,'ack-observer-cut.json'),'utf8'));assert.equal(cut.ready_received,false);assert.equal(cut.socket_close_observed,true);}
    for(const r of f.contract.code_roots)assert.equal(fs.readFileSync(path.join(r.path,'same.txt'),'utf8'),'after\n');
    const checkpoints=fs.readdirSync(ref.directory).filter(n=>/^checkpoint-\d{2}\.json$/.test(n)).sort().map(n=>JSON.parse(fs.readFileSync(path.join(ref.directory,n),'utf8')));
    const final=checkpoints.at(-1);assert.equal(final.phase,'ready');assert.equal(final.details.kind,partialPublication?'replay-ready':'execution-ready');
    const retainedReady=checkpoints.findLast(r=>r.phase==='publication_pending'&&r.details?.receipt);assert(retainedReady);
    const receiptBytes=fs.readFileSync(retainedReady.details.receipt.file);assert.equal(hash(receiptBytes),retainedReady.details.receipt.sha256);
    const receipt=JSON.parse(receiptBytes);
    assert.equal(receipt.phase,'ready');assert.equal(receipt.dispatch_id,ref.dispatch_id);assert.equal(ready.completion_receipt.receipt_sha256,retainedReady.details.receipt.sha256);assert.equal(ready.completion_receipt.manifest_sha256,hash(fs.readFileSync(path.join(ref.directory,'native-result.manifest.json'))));
    const recovery=require('./forge-attempt-recovery'),roots=require('./forge-code-roots');
    assert.equal(receipt.recovery_identity_sha256,roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request))),'native producer insertion order, not sorted protocol hash');
    assert(receipt.artifacts.length>0);for(const a of receipt.artifacts)assert.equal(fs.readFileSync(path.join(f.owner,a.path),'utf8'),a.content);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'host-process-closed-writer.json'))).provider_called,'unknown');
    console.log('PASS native bridge CLI fixture: genuine BEGIN/request, captured return, all known fixture writers closed, actual verification and publication; provider unknown');
  }finally{
    // The prepare CLI relinquishes its child handle. Endpoint disappearance is not
    // that child's close event. Retain the lab rather than infer OS join or delete it.
    console.log('RETAIN private bridge evidence; owner OS process close not observed by this test; host child close '+String(hostClose?.closed===true));
    for(const k of Object.keys(process.env))if(!Object.hasOwn(old,k))delete process.env[k];Object.assign(process.env,old);
  }
}
function selectBridgeCohort(argv){
  if(argv.length===0)return null;
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  if(argv.filter(arg=>typeof arg==='string'&&arg.startsWith('--bridge-cohort')).length>1)fail('native463-fixture-cohort-duplicate');
  if(argv.length!==2||argv[0]!=='--bridge-cohort'||!['full','partial'].includes(argv[1]))fail('native463-fixture-cohort-invalid');
  return argv[1];
}
function assertBridgeCohortSelectors(){
  assert.equal(selectBridgeCohort([]),null);
  assert.equal(selectBridgeCohort(['--bridge-cohort','full']),'full');
  assert.equal(selectBridgeCohort(['--bridge-cohort','partial']),'partial');
  for(const argv of [['--bridge-cohort'],['--bridge-cohort','unknown'],['--bridge-cohort=full'],['--bridge-cohort','full','extra'],['--unknown'],['--bridge-cohort','full','--bridge-cohort','partial']])assert.throws(()=>selectBridgeCohort(argv),e=>/^native463-fixture-cohort-(invalid|duplicate)$/.test(e.code));
  assert.throws(()=>selectBridgeCohort(['--bridge-cohort','full','--bridge-cohort','partial']),e=>e.code==='native463-fixture-cohort-duplicate');
  const units=require('./forge-ci-units').unitsForSuite('forge-native-host-bridge.test.js');
  assert.deepEqual(units.map(row=>row.args),[['--bridge-cohort','full'],['--bridge-cohort','partial']]);
  assert.equal(new Set(units.map(row=>row.id)).size,2);assert(units.every(row=>row.divisor===1));
}
async function runBridgeCohort(argv){
  const cohort=selectBridgeCohort(argv);
  if(cohort===null)return main().then(()=>main({partialPublication:true}));
  return main({partialPublication:cohort==='partial'});
}
module.exports={main};
if(require.main===module){
  const kind=process.argv[2],file=process.argv[3];
  if(kind==='--fixture-worker')fixtureWorker(JSON.parse(fs.readFileSync(file,'utf8')));
  else if(kind==='--manifest-spool-only')assertManifestSpoolBounds().then(()=>main({manifestOnly:true})).catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
  else if(kind==='--synchronous-prelude-only')assertSynchronousPreludeWiring().catch(e=>{console.error(e.code||'prelude-data-failed');process.exitCode=1;});
  else if(kind==='--fixture-host')fixtureHost(JSON.parse(fs.readFileSync(file,'utf8'))).catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
  else runBridgeCohort(process.argv.slice(2)).catch(e=>{const code=typeof e.code==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(e.code)?e.code:'native463-fixture-failed';const testSourceError=fixtureTestSourceError(e);console.error(JSON.stringify({code,...(testSourceError?{test_source_error:testSourceError}:{}),...(e.native463_diagnostic?{diagnostic:e.native463_diagnostic}:{})}));process.exitCode=1;});
}
