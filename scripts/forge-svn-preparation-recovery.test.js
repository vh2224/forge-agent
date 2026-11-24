'use strict';
// Real local SVN, unchanged default byte limit, no accounts/native provider.
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),{pathToFileURL}=require('url');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-svn-preparation-'))),saved={...process.env};
process.env.HOME=process.env.USERPROFILE=path.join(lab,'home');fs.mkdirSync(process.env.HOME);
const windows=require('./forge-owner-transport-window'),runs=require('./forge-runs'),roots=require('./forge-code-roots'),doctor=require('./forge-doctor'),recovery=require('./forge-owner-window-recovery'),prep=require('./forge-task-preparation'),personal=require('./forge-personal-context'),retirement=require('./forge-task-retirement'),vcs=require('./forge-vcs');
const owners=[],largeFiles=[];let passed=0;
function command(bin,args,cwd){const r=cp.spawnSync(bin,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});assert.equal(r.status,0,r.stderr);return r;}
function actor(host,name){process.env.CODEX_THREAD_ID=name;process.env.FORGE_CLAUDE_OWNER_SESSION_ID=name;process.env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';return runs.observeHostSession(host,name);}
(async()=>{
 const repo=path.join(lab,'repository');command('svnadmin',['create',repo],lab);
 for(const host of ['codex','claude']){
  const owner=path.join(lab,host);command('svn',['checkout','--quiet',pathToFileURL(repo).href,owner],lab);owners.push(owner);
  fs.writeFileSync(path.join(owner,host+'-base.txt'),'fixture baseline\n');command('svn',['add',host+'-base.txt'],owner);command('svn',['commit','--non-interactive','-m','fixture baseline'],owner);command('svn',['update','--quiet'],owner);
  fs.mkdirSync(path.join(owner,'.gsd'));const id='T-20261119190000-svn-'+host,previous=actor(host,'previous-'+host);
  windows.ensureTask(owner,id);runs.add(owner,{id,kind:'task',host_runtime:host,session_id:previous.sessionId,owner_session_source:previous.source,root:owner,cwd:owner});
  const brief=path.join(owner,'.gsd/tasks',id,id+'-BRIEF.md');fs.writeFileSync(brief,'Real local SVN no-invocation fixture');assert.equal(personal.bindWork({project:owner,id,intent:'create'}).status,'ok');
  const huge=path.join(owner,'unrelated-large-file.bin'),fd=fs.openSync(huge,'wx');fs.ftruncateSync(fd,vcs.SVN_STRICT_POLICY.maxFileBytes+1);fs.closeSync(fd);largeFiles.push(huge);
  // This reproduces the unchanged default file-byte bound, not500k entries.
  assert.throws(()=>require('./forge-surgical-reset').captureAttemptSnapshot(owner),error=>error.code==='svn-snapshot-limit');
  const q={schema_version:1,scope:'standalone-task',phase:'brainstorm',taskId:id,cwd:owner,contextRoot:owner,hostRuntime:host,workflowId:'svn442',dispatchId:'svn442-'+host,resultFile:path.join(lab,host+'-result.json'),inputs:{brief:'Local SVN fixture'},constraints:{auto_commit:false,deploy:false}};
  const fingerprint=prep.preparationRequestFingerprint(prep.validateRequest(q)),receiptFile=q.resultFile+'.receipt.json';
  const original=Buffer.from(JSON.stringify({phase:'failed',dispatch_id:q.dispatchId,request_fingerprint:fingerprint,failure:{reason_code:'fixture-not-invoked',provider_called:false}}));fs.writeFileSync(receiptFile,original);
  const binding={kind:'artifact-preparation',coordination:'observed-host-session-v1',task_id:id,dispatch_id:q.dispatchId,request_sha256:fingerprint,host_runtime:host,host_session_sha256:roots.digest(previous.sessionId)},bindingFile=path.join(lab,host+'-binding.json');fs.writeFileSync(bindingFile,JSON.stringify(binding));
  const custody=command(process.execPath,['-e',"require(process.argv[1]).open(process.argv[2],JSON.parse(require('fs').readFileSync(process.argv[3])));",path.join(__dirname,'forge-owner-transport-window.js'),owner,bindingFile],lab);
  assert(windows.observed(owner));actor(host,'current-'+host);
  const observeWriters=ch=>({coverage_complete:true,previous_session_sha256:ch.scope.previous_host_session_sha256,previous_owner_stopped:true,
   writers:[{state:'joined',reference:'actual custody CLI spawnSync close '+custody.pid}],joined:true,possible_writers:0,no_invocation_observed:true,unmeasured_code_contents_acknowledged:true,reference:'actual purpose-built custody CLI closed0 and never invoked a worker'});
  const reconcile=()=>({reconciled:true,reference:'fixture reconciled request/receipt/control files and physical SVN roots, code contents explicitly unmeasured'});
  const adapter=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters,reconcile,observeDecision:ch=>({outcome:ch.intent.outcome,successor_id:ch.intent.successor_id,reference:'explicit synthetic fixture cancellation decision'})});
  let reads=0;const readFile=fs.readFileSync,readdir=fs.readdirSync;
  fs.readFileSync=function(file,...args){if(path.resolve(String(file))===path.resolve(huge)){reads++;throw Error('unrelated large file must not be read by custody measurement');}return readFile.call(this,file,...args);};
  fs.readdirSync=function(file,...args){if(path.resolve(String(file))===path.resolve(owner)){reads++;throw Error('custody measurement must not inventory unrelated SVN tree');}return readdir.call(this,file,...args);};
  try{
   const current=doctor.inspectOwnerWindow({owner,request:q});assert.equal(current.status,'held');assert.equal(current.coverage.code_contents,'unmeasured');
   const missing=recovery.createObservedHostAdapter({hostRuntime:host,observeWriters:ch=>({...observeWriters(ch),no_invocation_observed:false}),reconcile});
   await assert.rejects(doctor.recoverOwnerWindow({owner,request:q,adapter:missing}),/owner-window-no-invocation-unproven/);assert(windows.observed(owner));
   const race=recovery.createObservedHostAdapter({hostRuntime:host,observeWriters,reconcile:()=>{fs.appendFileSync(brief,' changed');return reconcile();}});
   await assert.rejects(doctor.recoverOwnerWindow({owner,request:q,adapter:race}),/owner-window-recovery-conflict/);assert(windows.observed(owner));fs.writeFileSync(brief,'Real local SVN no-invocation fixture');
   const recovered=await doctor.recoverOwnerWindow({owner,request:q,expected:current.observation_sha256,adapter});assert.equal(recovered.recovered,true);assert.equal(windows.observed(owner),null);assert(fs.readFileSync(receiptFile).equals(original));
   runs.update(owner,id,{write_claim:{}});assert.throws(()=>retirement.inspect({owner,request:q,outcome:'cancelled'}),/task-retirement-claim-held/);runs.update(owner,id,{write_claim:null});
   const preview=retirement.inspect({owner,request:q,outcome:'cancelled'});assert.equal(preview.coverage.code_contents,'unmeasured');
   const retired=await doctor.retireTask({owner,request:q,outcome:'cancelled',expected:preview.observation_sha256,adapter});assert.equal(retired.closed,true);assert.equal(runs.get(owner,id).active,false);
   const record=retirement.readPublished(owner,runs.get(owner,id));assert.equal(record.valid,true);assert.equal(record.record.code_completed,false);assert.equal(record.record.artifacts_accepted,false);assert(fs.readFileSync(receiptFile).equals(original));assert.equal(reads,0);
  }finally{fs.readFileSync=readFile;fs.readdirSync=readdir;}
  assert.equal(fs.statSync(huge).size,vcs.SVN_STRICT_POLICY.maxFileBytes+1);assert.throws(()=>require('./forge-surgical-reset').captureAttemptSnapshot(owner),error=>error.code==='svn-snapshot-limit');
  passed++;console.log('ok - '+host+' real large-SVN bounded custody recovery/retirement; strict byte-limit refusal preserved');
 }
 console.log(JSON.stringify({passed,failed:0,provider_calls:0,limit_reproduced:'unchanged default maxFileBytes, not entry-count'}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{
 for(const owner of owners){const seen=windows.observed(owner);if(seen)try{windows.recover(owner,seen,challenge=>({challenge_sha256:roots.digest(challenge),joined:true,possible_writers:0,reference:'fixture cleanup: exact purpose-built custody child closed0, no worker ever invoked'}));}catch{process.exitCode=1;}}
 for(const file of largeFiles)if(path.dirname(file).startsWith(lab+path.sep)&&path.basename(file)==='unrelated-large-file.bin')fs.unlinkSync(file);
 for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
});
