#!/usr/bin/env node
'use strict';
// Private DATA copies exercise real bridge functions, not Native admission.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),Module=require('node:module'),vm=require('node:vm');
const filename=path.join(__dirname,'forge-native-host-bridge.js'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const names=['livePair','liveProcess','liveACL','liveOS','binaryMeasure','binaryPin','observeHostVersion','originalHook','originalHookBootstrap','collectOriginalHookBootstrap','liveBootstrap','canonicalPrepareSessionValues','canonicalPrepareSessionExports','checkedHookCarrier','verifyLiveSender','liveKey','liveKeyDirectory','safeOSDiagnostic','LIVE_OS_SCRIPT'];
function copy({runner,process:observed=process,home,temporary,main}={}){
 const raw=fs.readFileSync(filename),mod={exports:{}},real=Module.createRequire(filename);
 function req(name){if(name==='node:child_process'||name==='child_process')return runner?{spawnSync:runner}:real(name);
if(name==='./forge-home'&&home)return{resolveRuntimeHome:()=>home};
if((name==='node:os'||name==='os')&&temporary)return{...real(name),tmpdir:()=>temporary};
return real(name);
}
 req.main=main||require.main;
 vm.compileFunction(raw.toString('utf8').replace(/^#![^\n]*(?:\n|$)/,'' )+'\nmodule.exports.__data={'+names.join(',')+'};',['require','module','exports','__filename','__dirname','process'],{filename})(req,mod,mod.exports,filename,__dirname,observed);
 assert.equal(hash(fs.readFileSync(filename)),hash(raw));
return mod.exports.__data;
}
function refuse(fn,code){assert.throws(fn,e=>e.code===code);
}
function main(){
 const before=hash(fs.readFileSync(filename)),root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-480471-'))),exe=path.join(root,'claude.exe'),other=path.join(root,'claude-other.exe'),hook=path.join(root,'forge-hook.js'),key=path.join(root,'ingress.key');
 for(const [file,bytes]of [[exe,'dummy-build-A'],[other,'dummy-build-B'],[hook,'// dummy hook'],[key,Buffer.alloc(32,4)]])fs.writeFileSync(file,bytes,{flag:'wx'});
 const p={pid:23,ppid:22,started:'123456789',exe,command_line:'dummy',sid:'fixture-user'},acl={owner:'fixture-user',current_user:'fixture-user',protected:true,rules:[{sid:'fixture-user',kind:'Allow'}]};
 const env={SystemRoot:'C:/Windows',PATH:'fixture-path',NODE_OPTIONS:'secret-not-inherited',ANTHROPIC_API_KEY:'not-a-credential'},observed={platform:'win32',pid:23,ppid:22,env,execPath:exe,execArgv:[],argv:[exe,hook,'session-start']};
 let calls=[],mutate=v=>v,version='3.2.41 (Claude Code)\r\n',versionResult=null;
 const runner=(command,args,options)=>{
  calls.push({command,args,options});
  if(args.length===1&&args[0]==='--version')return versionResult||{status:0,signal:null,stdout:version,stderr:''};
  assert.equal(options.timeout,10000);
assert.equal(options.maxBuffer,16384);
assert.equal(options.windowsHide,true);
assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-EncodedCommand']);
  const packet=JSON.parse(options.input),value=item=>item.action==='process'?{...p,pid:item.pid,ppid:item.pid===23?22:1,command_line:item.pid===23?observed.argv.map(v=>'"'+v+'"').join(' '):'"'+exe+'"'}:structuredClone(acl);
  let result=packet.action==='pair'?{kind:'native-host-os-pair-v1',items:packet.items.map((item,index)=>({index,action:item.action,subject:item.pid||item.file,value:value(item)}))}:value(packet);
  result=mutate(result,packet);
return{status:0,signal:null,stdout:JSON.stringify(result),stderr:''};
 };
 const data=copy({runner,process:observed,home:root,temporary:root,main:{filename:hook}}),items=[{action:'process',pid:23},{action:'acl',file:key}];
 try{
  assert.equal(data.livePair(items).length,2);
assert.equal(calls.length,1);
assert.deepEqual(JSON.parse(calls[0].options.input),{action:'pair',items});
  data.livePair(items);
assert.equal(calls.length,2,'next boundary observes again');
  for(const bad of [[],[items[0]],[...items,items[0]],[{action:'protect',file:root},items[0]],[{action:'process',pid:0},items[1]],[{action:'acl',file:key,directory:'yes'},items[0]],[{...items[0],extra:true},items[1]]]){const n=calls.length;
assert.throws(()=>data.livePair(bad));
assert.equal(calls.length,n);
}
  const getter={};
Object.defineProperty(getter,'action',{enumerable:true,get(){assert.fail('request getter invoked');
}});
refuse(()=>data.livePair([getter,items[1]]),'native-host-os-pair-request');
  for(const change of [v=>({...v,extra:true}),v=>({...v,kind:'foreign'}),v=>({...v,items:[]}),v=>({...v,items:[...v.items,v.items[0]]}),v=>({...v,items:[v.items[1],v.items[0]]}),v=>({...v,items:[v.items[0],{...v.items[1],subject:exe}]}),v=>({...v,items:[{...v.items[0],extra:1},v.items[1]]})]){mutate=change;
refuse(()=>data.livePair(items),'native-host-os-pair-response');
}
  for(const index of [0,1]){mutate=v=>{v.items[index]={index,action:items[index].action,subject:items[index].pid||items[index].file,error:'native-host-os-observation-refused',exception_type:'FixtureException',hresult:-1};
return v;
};
assert.throws(()=>data.livePair(items),e=>e.code==='native-host-os-observation-refused'&&e.os_diagnostic.item_index===index&&e.os_diagnostic.action===items[index].action);
}
  mutate=v=>{v.items[0].value.started='unknown';
return v;
};
refuse(()=>data.livePair(items),'native-host-process-observation');
  mutate=v=>{v.items[1].value.rules.push({sid:'foreign',kind:'Allow'});
return v;
};
refuse(()=>data.livePair(items),'native-host-key-acl');
mutate=v=>v;
  assert.deepEqual(data.livePair(items),[data.liveProcess(23),data.liveACL(key)]);
  for(const result of [{error:Object.assign(Error('timeout'),{code:'ETIMEDOUT'}),status:null,stdout:'',stderr:''},{status:2,stdout:'{"error":"refused"}',stderr:''},{status:0,stdout:'not-json',stderr:''}]){const broken=copy({runner:()=>result,process:observed});
assert.throws(()=>broken.livePair(items),e=>e.code==='native-host-os-observation-refused'&&e.os_diagnostic.item_index===null);
}
  const unsupported=copy({process:{...observed,platform:'linux'},runner:()=>assert.fail('unsupported OS spawned')});
refuse(()=>unsupported.livePair(items),'native-host-live-os-unsupported');
  calls=[];
assert.equal(data.observeHostVersion(exe),'3.2.41');
assert.equal(calls.length,1);
assert.equal(calls[0].command,exe);
assert.deepEqual(calls[0].args,['--version']);
assert.equal(calls[0].options.shell,false);
assert.equal(calls[0].options.timeout,5000);
assert.equal(calls[0].options.maxBuffer,4096);
assert.equal(calls[0].options.env.NODE_OPTIONS,undefined);
assert.equal(calls[0].options.env.ANTHROPIC_API_KEY,undefined);
const canonicalEnv=require('./forge-claude-sidecar').buildClaudeProbeEnv(env,'win32');
assert(Object.keys(calls[0].options.env).every(k=>Object.hasOwn(canonicalEnv,k)),'version probe env is canonical subset');
  for(const bad of ['3.2.41 (Claude Code)\nextra','03.2.41 (Claude Code)','3.2.41','\ufeff3.2.41 (Claude Code)','3.2.41 (Claude Code)\n\n']){version=bad;
assert.throws(()=>data.observeHostVersion(exe));
}version='3.2.41 (Claude Code)\r\n';
  for(const result of [{error:Object.assign(Error('timeout'),{code:'ETIMEDOUT'}),status:null},{status:1},{status:0,signal:'SIGTERM'}]){versionResult=result;
refuse(()=>data.observeHostVersion(exe),'native-host-binary-version-unobserved');
}versionResult=null;
  assert.notEqual(data.binaryMeasure(exe).sha256,data.binaryMeasure(other).sha256);
data.binaryPin(exe,hash(fs.readFileSync(exe)));
refuse(()=>data.binaryPin(exe,hash(fs.readFileSync(other))),'native-host-binary-changed');
  refuse(()=>data.collectOriginalHookBootstrap({hookSource:hook}),'native-host-original-hook-required');
observed.env={SystemRoot:'C:/Windows',PATH:'fixture-path'};
calls=[];
const boot=data.collectOriginalHookBootstrap({hookSource:hook});
assert.equal(boot.exe_version,'3.2.41');
assert.equal(boot.exe_sha256,hash(fs.readFileSync(exe)));
assert.equal(calls.filter(c=>c.args.length===1).length,1);
assert.equal(calls.filter(c=>c.options.input).length,2,'SessionStart pair plus fresh parent after version');
  p.exe=other;
version='3.2.42 (Claude Code)';
const otherBoot=data.collectOriginalHookBootstrap({hookSource:hook});
assert.equal(otherBoot.exe_sha256,hash(fs.readFileSync(other)));
assert.equal(otherBoot.exe_version,'3.2.42');
p.exe=exe;
version='3.2.41 (Claude Code)';
  const carrier={pid:22,started:p.started,exe,exe_sha256:boot.exe_sha256,exe_version:boot.exe_version,hook,hook_sha256:boot.hook_sha256,config:root},actor={hostRuntime:'claude',sessionId:'fixture-session'};
  const values=data.canonicalPrepareSessionValues(actor,carrier);
assert.equal(values.length,11);
assert.deepEqual(values[6],['FORGE_NATIVE_HOST_EXE_VERSION','3.2.41']);
const supplied=Object.fromEntries(values);
assert.equal(data.checkedHookCarrier(actor.sessionId,carrier,supplied).source_kind,'sessionstart-env-current-os');
  for(const change of [v=>delete v.FORGE_NATIVE_HOST_EXE_VERSION,v=>v.FORGE_NATIVE_HOST_EXE_VERSION='9.0.0']){const bad={...supplied};
change(bad);
refuse(()=>data.checkedHookCarrier(actor.sessionId,carrier,bad),'native-host-live-hook-binding');
}
  observed.env={...supplied,SystemRoot:'C:/Windows'};
calls=[];
const current=data.liveBootstrap({actor});
assert.equal(current.exe_version,'3.2.41');
assert.equal(calls.length,1);
assert.equal(calls[0].args[2],'-EncodedCommand');
  observed.argv=[exe,hook,'native-live','post'];
calls=[];
data.originalHook('post',hook);
assert.equal(calls.length,1,'native hook pairs without repeated version probe');
  calls=[];
const sender={pid:23,started:p.started,exe_sha256:hash(fs.readFileSync(exe)),hook_sha256:hash(fs.readFileSync(hook)),bridge_sha256:hash(fs.readFileSync(filename)),argv_sha256:require('./forge-code-roots').digest(observed.argv)};
data.verifyLiveSender({enrollment:{bootstrap:{...carrier,sid_sha256:hash(p.sid)}}},sender,'post');
assert.equal(calls.length,1,'sender plus host pair');
  const keyDir=data.liveKeyDirectory('fixture-key-pair');
fs.mkdirSync(keyDir);
fs.writeFileSync(path.join(keyDir,'ingress.key'),Buffer.alloc(32,9));
calls=[];
data.liveKey({attempt:'fixture-key-pair',keySha:hash(Buffer.alloc(32,9))}).fill(0);
assert.equal(calls.length,1,'directory and key ACL pair');
  observed.argv=[exe,hook,'session-start'];
  fs.appendFileSync(exe,'-drift');
refuse(()=>data.liveBootstrap({actor}),'native-host-binary-changed');
fs.writeFileSync(exe,'dummy-build-A');
  const drift=copy({runner:(...args)=>{const r=runner(...args);
if(args[1][0]==='--version')fs.appendFileSync(exe,'-raced');
return r;
},process:{...observed,env:{},argv:[exe,hook,'session-start']},home:root,main:{filename:hook}});
refuse(()=>drift.collectOriginalHookBootstrap({hookSource:hook}),'native-host-binary-version-unbound');
  assert(!fs.readFileSync(filename,'utf8').includes('CLAUDE_BINARY_SHA'));
  console.log('PASS Native480/471 DATA: fresh paired observations, closed failures, original SessionStart measured pin/version, drift and carrier controls; no LIVE authority/provider');
 }finally{assert.equal(hash(fs.readFileSync(filename)),before);
fs.rmSync(root,{recursive:true,force:true});
}
}
async function realOSParity(){
 const cp=require('node:child_process');
let launches=0;
 const data=copy({runner:(...args)=>{if(args[2]?.input)launches++;
return cp.spawnSync(...args);
}});
 if(process.platform!=='win32'){refuse(()=>data.livePair([{action:'process',pid:process.pid},{action:'process',pid:process.pid}]),'native-host-live-os-unsupported');
console.log('PASS unsupported live OS is refused');
return;
}
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-480471-parity-'))),file=path.join(root,'dummy');
 const child=cp.spawn(process.execPath,['-e',"const timer=setTimeout(()=>process.exit(0),90000);process.on('message',()=>{clearTimeout(timer);process.disconnect();});process.on('disconnect',()=>clearTimeout(timer));process.send('ready');"],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,env:Object.fromEntries(['SystemRoot','SYSTEMROOT','PATH','Path','TEMP','TMP'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]))});
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);
child.once('close',(code,signal)=>resolve({code,signal}));
});
let joined=false;
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned child readiness timeout')),5000);
child.once('message',v=>{clearTimeout(timer);
assert.equal(v,'ready');
resolve();
});
child.once('error',e=>{clearTimeout(timer);
reject(e);
});
});
  let count=launches;
const processes=data.livePair([{action:'process',pid:process.pid},{action:'process',pid:child.pid}]);
assert.equal(launches-count,1);
assert.deepEqual(processes,[data.liveProcess(process.pid),data.liveProcess(child.pid)]);
  data.liveOS({action:'protect',file:root});
fs.writeFileSync(file,'owned dummy',{flag:'wx'});
count=launches;
  const acl=data.livePair([{action:'acl',file:root,directory:true},{action:'acl',file}]);
assert.equal(launches-count,1);
assert.deepEqual(acl,[data.liveACL(root,true),data.liveACL(file)]);
  refuse(()=>data.observeHostVersion(process.execPath),'native-host-binary-version-unsupported');
  console.log('PASS real Windows self/owned-child process pair and protected dummy ACL pair equal singles, one launch per pair; Node is not Claude');
 }finally{
  if(child.connected)child.send('close');
let timer;
  try{const result=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned child join unknown')),5000);
})]);
assert.equal(result.code,0);
assert.equal(result.signal,null);
joined=true;
}finally{clearTimeout(timer);
if(joined)fs.rmSync(root,{recursive:true,force:true});
else console.error('RETAIN owned parity lab; original child join unknown');
}
 }
}
async function relayTimeoutData(){const file=path.join(__dirname,'forge-native-host-bridge.test.js'),raw=fs.readFileSync(file,'utf8'),copy=new Module(file+'#relay-timeout',module);
copy.filename=file;
copy.paths=Module._nodeModulePaths(__dirname);
copy._compile(raw+'\nmodule.exports.__relayTimeout=assertLiveIPCTimeoutDiagnostics;\n',file);
await copy.exports.__relayTimeout();
assert.equal(hash(fs.readFileSync(file)),hash(raw));
}
if(require.main===module){const args=process.argv.slice(2);
assert(args.length===0||args.length===1&&['--real-os-parity','--relay-timeout-data'].includes(args[0]),'unknown test selector');
Promise.resolve(args[0]==='--real-os-parity'?realOSParity():args[0]==='--relay-timeout-data'?relayTimeoutData():main()).catch(error=>{console.error(error);
process.exitCode=1;
});
}
module.exports={main,realOSParity};
