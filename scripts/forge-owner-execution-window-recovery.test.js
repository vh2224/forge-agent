'use strict';
// Live local ChildProcess joins, without providers or real consumer state.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),cp=require('child_process');
const lab=require('./forge-code-roots.test'),api=require('./forge-owner-window-recovery'),windows=require('./forge-owner-transport-window'),roots=require('./forge-code-roots');
const runs=require('./forge-runs'),controller=require('./forge-unit-controller'),lease=require('./forge-unit-lease'),execution=require('./forge-task-execution');
const put=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
const actor=(host,name)=>{process.env.CODEX_THREAD_ID=name;process.env.FORGE_CLAUDE_OWNER_SESSION_ID=name;process.env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';};
const git=(args,cwd)=>{const r=cp.spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
async function run(host){
 const f=lab.fixture(),saved={...process.env},children=[];let ownerExited=false,writerClosed=false;
 try{
  const home=path.join(f.dir,'home');fs.mkdirSync(home);Object.assign(process.env,{HOME:home,USERPROFILE:home,FORGE_HOME:path.resolve(__dirname,'..')});
  const q=require('./forge-issues-429-432.test').activityRequest(f,host),previous=runs.get(f.owner,'M001').session_id;
  const requestFile=path.join(f.dir,'request.json'),producer=path.join(f.dir,'producer.cjs');put(requestFile,q);
  put(producer,`const fs=require('fs'),path=require('path'),s=process.argv[2],q=JSON.parse(fs.readFileSync(process.argv[3]));require(path.join(s,'forge-protected-owner-activity')).withExecutionActivity(q,{},async()=>{require(path.join(s,'forge-unit-sidecar')).beginArtifactAttempt(q);process.exit(0);}).catch(e=>{console.error(e.code||e.message);process.exitCode=1;});`);
  const writer=cp.spawn(process.execPath,['-e','process.stdin.resume();'],{stdio:['pipe','ignore','ignore'],windowsHide:true});
  const writerJoin=new Promise(resolve=>writer.once('close',(code,signal)=>{writerClosed=true;resolve({code,signal});}));children.push({child:writer,join:writerJoin});
  const old=cp.spawn(process.execPath,[producer,__dirname,requestFile],{stdio:['ignore','pipe','pipe'],env:{...process.env},windowsHide:true});let stderr='';old.stderr.setEncoding('utf8');old.stderr.on('data',chunk=>{stderr+=chunk;});
  const oldJoin=new Promise(resolve=>old.once('close',(code,signal)=>{ownerExited=true;resolve({code,signal});}));children.push({child:old,join:oldJoin});
  const ended=await oldJoin;assert.equal(ended.code,0,stderr);assert.equal(ended.signal,null);
  const held=windows.observed(f.owner);assert.equal(held.binding.kind,'unit-execution');assert.equal(held.binding.host_runtime,host);assert.equal(held.binding.host_session_sha256,roots.digest(previous));
  actor(host,'current-execution-'+host);
  const capture=()=>api.capture({owner:f.owner,request:q}),current=capture();assert.equal(current.scope.measurement_profile,'milestone-execution-coordination-v1');
  assert.equal(current.scope.retained_channels.length,8);assert(current.scope.retained_channels.some(row=>row.present));assert(current.scope.retained_channels.some(row=>!row.present));
  const observe=challenge=>({coverage_complete:true,previous_session_sha256:challenge.scope.previous_host_session_sha256,previous_owner_stopped:ownerExited,
   writers:[{state:ownerExited?'joined':'active',reference:'actual old producer ChildProcess.close'},{state:writerClosed?'joined':'active',reference:'actual separately tracked writer ChildProcess.close'}],
   joined:ownerExited&&writerClosed,possible_writers:writerClosed?0:1,reference:'actual fixture close events'});
  const reconcile=()=>({reconciled:true,reference:'exact measured owner, roots, index and retained channels'});
  const adapter=api.createObservedHostAdapter({hostRuntime:host,observeWriters:observe,reconcile});
  const recover=(extra={})=>api.recover({owner:f.owner,request:q,expected:capture().observation_sha256,adapter,...extra});
  assert.equal(api.inspect({owner:f.owner,request:q}).holder_state,'absent');
  await assert.rejects(recover({adapter:{}}),/owner-window-live-host-required/);
  await assert.rejects(recover(),/owner-window-writer-unproven/,'dead owner must not release a separate live writer');
  assert.equal(windows.observed(f.owner).sha256,held.sha256);
  writer.stdin.end();const writerEnd=await writerJoin;assert.equal(writerEnd.code,0);assert.equal(writerEnd.signal,null);
  const forged=api.createHostAdapter({hostRuntime:host,observeWriters:()=>({joined:true,possible_writers:0}),reconcile});
  await assert.rejects(recover({adapter:forged}),/owner-window-writer-unproven/);
  const foreign=api.createObservedHostAdapter({hostRuntime:host==='codex'?'claude':'codex',observeWriters:observe,reconcile});
  await assert.rejects(recover({adapter:foreign}),/owner-window-cross-host-unsupported/);
  assert.throws(()=>api.capture({owner:f.owner,request:{...q,workflowId:'foreign-workflow'}}),/owner-window-request-mismatch/);
  assert.throws(()=>api.capture({owner:f.owner,request:{...q,resultFile:path.join(f.dir,'foreign-result.json')}}),/owner-window-request-mismatch/);
  assert.throws(()=>api.capture({owner:f.owner,request:q,receiptCopy:q.resultFile+'.receipt.json'}),/execution-receipt-copy-unsupported/);
  actor(host,'another-current-'+host);await assert.rejects(recover(),/owner-window-host-session-changed/);actor(host,'current-execution-'+host);
  const expected=capture().observation_sha256;
  for(const suffix of ['','.returned.json','.manifest.json']){
   const file=q.resultFile+suffix;put(file,{dispatch_id:'foreign-dispatch'});assert.throws(()=>capture(),/owner-window-execution-channel-mismatch/);fs.unlinkSync(file);
  }
  const forgedReceiptFile=q.resultFile+'.receipt.json',receiptOriginal=fs.readFileSync(forgedReceiptFile),forgedReceipt=JSON.parse(receiptOriginal);
  forgedReceipt.manifest_sha256='0'.repeat(64);put(forgedReceiptFile,forgedReceipt);assert.throws(()=>capture(),/owner-window-execution-channel-mismatch/);fs.writeFileSync(forgedReceiptFile,receiptOriginal);
  const mutate=async(file,change)=>{
   const bytes=fs.existsSync(file)?fs.readFileSync(file):null;
   const raced=api.createObservedHostAdapter({hostRuntime:host,observeWriters:observe,reconcile:()=>{change(bytes);return reconcile();}});
   try{await assert.rejects(api.recover({owner:f.owner,request:q,expected,adapter:raced}),error=>typeof error.code==='string','post-measurement changes refuse');assert.equal(windows.observed(f.owner).sha256,held.sha256);}
   finally{if(bytes)fs.writeFileSync(file,bytes);else if(fs.existsSync(file))fs.unlinkSync(file);}
  };
  const runFile=runs.runFile(f.owner,'M001'),leaseFile=lease.leaseFile(f.owner,'execute-task/T01'),beginFile=controller.transactionFile(f.owner,'fixture-begin');
  await mutate(runFile,b=>{const row=JSON.parse(b);row.write_claim.generation='foreign-generation';put(runFile,row);});
  await mutate(leaseFile,b=>{const row=JSON.parse(b);row.generation='foreign-generation';put(leaseFile,row);});
  await mutate(beginFile,b=>fs.writeFileSync(beginFile,Buffer.concat([b,Buffer.from(' ')])));
  await mutate(q.planFile,b=>fs.writeFileSync(q.planFile,Buffer.concat([b,Buffer.from('\nforeign plan')])));
  await mutate(q.resultFile+'.receipt.json',b=>fs.writeFileSync(q.resultFile+'.receipt.json',Buffer.concat([b,Buffer.from(' ')])));
  await mutate(q.resultFile+'.returned.json',()=>put(q.resultFile+'.returned.json','{"retained":"new candidate"}'));
  await mutate(path.join(f.owner,'.gsd/foreign-control.json'),()=>put(path.join(f.owner,'.gsd/foreign-control.json'),'{}'));
  const lowRecover=windows.recover,fencedFile=q.resultFile+'.manifest.json';
  windows.recover=(owner,observed,attest)=>lowRecover(owner,observed,challenge=>{put(fencedFile,{dispatch_id:q.dispatchId});return attest(challenge);});
  try{await assert.rejects(recover(),/owner-window-writer-unproven/,'low-level attestation preserves its closed refusal when final fenced scope changes');assert(windows.observed(f.owner));}
  finally{windows.recover=lowRecover;fs.unlinkSync(fencedFile);}
  const staged=api.createObservedHostAdapter({hostRuntime:host,observeWriters:observe,reconcile:()=>{git(['add','same.txt'],f.a);return reconcile();}});
  fs.appendFileSync(path.join(f.a,'same.txt'),'index-only change\n');const indexExpected=capture().observation_sha256;
  await assert.rejects(api.recover({owner:f.owner,request:q,expected:indexExpected,adapter:staged}),/owner-window-recovery-conflict/);git(['restore','--staged','--','same.txt'],f.a);
  const before=execution.protectedSnapshot(f.owner),code=execution.replayState(f.a),runBytes=fs.readFileSync(runFile),leaseBytes=fs.readFileSync(leaseFile),receiptBytes=fs.readFileSync(q.resultFile+'.receipt.json');
  const result=await recover();assert.equal(result.recovered,true);assert.equal(windows.observed(f.owner),null);
  assert.deepEqual(execution.protectedSnapshot(f.owner),before);assert.deepEqual(execution.replayState(f.a),code);
  assert(fs.readFileSync(runFile).equals(runBytes));assert(fs.readFileSync(leaseFile).equals(leaseBytes));assert(fs.readFileSync(q.resultFile+'.receipt.json').equals(receiptBytes));
  const audit=JSON.parse(fs.readFileSync(result.audit_file));assert.equal(audit.outcome,'recovered');assert.equal(audit.scope.measurement_profile,'milestone-execution-coordination-v1');
  assert.equal(runs.get(f.owner,'M001').session_id,previous);assert(controller.incompleteUnits(f.owner,'M001').length,'coordination release does not complete the open begin');
  const legacy={...held.binding};delete legacy.coordination;delete legacy.host_runtime;delete legacy.host_session_sha256;
  const legacyFile=path.join(f.dir,'legacy.json');put(legacyFile,legacy);
  const oldLegacy=cp.spawnSync(process.execPath,['-e',"const fs=require('fs'),w=require(process.argv[1]);w.open(process.argv[2],JSON.parse(fs.readFileSync(process.argv[3])));process.exit(0);",path.join(__dirname,'forge-owner-transport-window.js'),f.owner,legacyFile],{encoding:'utf8',windowsHide:true});
  assert.equal(oldLegacy.status,0,oldLegacy.stderr);assert.throws(()=>capture(),/owner-window-binding-unsupported/);
  windows.recover(f.owner,windows.observed(f.owner),challenge=>({challenge_sha256:roots.digest(challenge),joined:true,possible_writers:0,reference:'fixture final cleanup after both actual children closed and synchronous legacy opener joined'}));
  console.log('PASS '+host+' actual execution orphan, retained channels, joined-only coordination release and identity/index/metadata/receipt negatives');
 }finally{
  for(const row of children)if(row.child.stdin&&!row.child.stdin.destroyed)row.child.stdin.end();await Promise.all(children.map(row=>row.join));
  const held=windows.observed(f.owner);if(held)windows.recover(f.owner,held,challenge=>({challenge_sha256:roots.digest(challenge),joined:true,possible_writers:0,reference:'fixture cleanup only after every actual ChildProcess.close'}));
  const control=windows.controlRoot(f.owner);if(fs.existsSync(control)){assert.equal(fs.realpathSync.native(path.dirname(control)),fs.realpathSync.native(require('os').tmpdir()));assert(!fs.lstatSync(control).isSymbolicLink());fs.rmSync(control,{recursive:true,force:true});}
  process.env=saved;f.cleanup();
 }
}
(async()=>{for(const host of ['codex','claude'])await run(host);})().catch(error=>{console.error(error);process.exitCode=1;});
