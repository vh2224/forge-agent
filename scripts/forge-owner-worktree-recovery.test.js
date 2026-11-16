'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const api=require('./forge-owner-window-recovery'),doctor=require('./forge-doctor'),windows=require('./forge-owner-transport-window'),runs=require('./forge-runs'),roots=require('./forge-code-roots'),personal=require('./forge-personal-context'),prep=require('./forge-task-preparation');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-worktree-recovery-'))),saved={...process.env},children=[],owners=[];
const put=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
const command=(bin,args,cwd)=>{const r=cp.spawnSync(bin,args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
const git=(cwd,args)=>command('git',args,cwd),actor=(host,name)=>{process.env.CODEX_THREAD_ID=name;process.env.FORGE_CLAUDE_OWNER_SESSION_ID=name;process.env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';};
(async()=>{
 Object.assign(process.env,{HOME:path.join(lab,'profile'),USERPROFILE:path.join(lab,'profile'),FORGE_HOME:path.join(lab,'forge')});fs.mkdirSync(process.env.HOME);
 for(const host of ['codex','claude'])for(const explicit of [false,true]){
  const owner=path.join(lab,host+'-'+explicit),id='T-20261116150000-worktree-'+host+'-'+explicit,branch='forge/'+id,wt=path.join(owner,'.forge-worktrees',id,'code');owners.push(owner);fs.mkdirSync(owner);
  git(owner,['init','-q']);put(path.join(owner,'.gitignore'),'.gsd/\n.forge-worktrees/\n');put(path.join(owner,'source.txt'),'base\n');git(owner,['add','.']);git(owner,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base']);
  git(owner,['worktree','add','-q','-b',branch,wt,'HEAD']);put(path.join(owner,'source.txt'),'retained owner change\n');put(path.join(wt,'source.txt'),'retained worktree change\n');
  fs.mkdirSync(path.join(owner,'.gsd'));actor(host,'old-'+host+'-'+explicit);const old=runs.observeHostSession(host,process.env.FORGE_CLAUDE_OWNER_SESSION_ID);windows.ensureTask(owner,id);
  runs.add(owner,{id,kind:'task',session_id:old.sessionId,host_runtime:host,owner_session_source:old.source,cwd:owner,root:owner,branch,worktrees:[{repo:owner,path:wt}]});assert.equal(personal.bindWork({project:owner,id,intent:'create'}).status,'ok');
  const milestone='M-20261116150000-successor',brief=path.join(owner,'.gsd/tasks',id,id+'-BRIEF.md');put(brief,'Preparation failed; unaccepted retained artifacts\n');
  put(path.join(owner,'.gsd/milestones',milestone,milestone+'-STATE.md'),'---\nmilestone: '+milestone+'\nstatus: ACTIVE\n---\n');
  assert.equal(personal.saveCheckpoint({project:owner,id,intent:'checkpoint',checkpoint:{pending:[{text:'Unanswered old functional question',source:brief}]}}).status,'ok');
  const q={schema_version:1,scope:'standalone-task',phase:'brainstorm',taskId:id,cwd:explicit?wt:owner,contextRoot:owner,hostRuntime:host,workflowId:'worktree401',dispatchId:'dispatch-'+host+'-'+explicit,resultFile:path.join(lab,'scratch',host+'-'+explicit+'.json'),inputs:{brief:'Worktree fixture'},...(explicit?{execution_contract:roots.singleContract(owner,wt)}:{})};
  const originalRequest=JSON.stringify(q),fingerprint=prep.preparationRequestFingerprint(prep.validateRequest(q)),receipt=q.resultFile+'.receipt.json',receiptBytes=Buffer.from(JSON.stringify({phase:'failed',dispatch_id:q.dispatchId,request_fingerprint:fingerprint}));put(receipt,receiptBytes);
  const copy=path.join(owner,'.gsd/tasks',id,'evidence/retained.receipt.json');put(copy,receiptBytes);
  const measured=api.measureTask({owner,request:q});assert.equal(measured.scope.code_states.length,2,'both original repository and isolated worktree must be reconciled');
  assert.deepEqual(new Set(measured.scope.code_states.map(r=>roots.key(r.path))),new Set([roots.key(fs.realpathSync.native(owner)),roots.key(fs.realpathSync.native(wt))]));
  for(const patch of [{branch:'wrong-branch'},{worktrees:[{repo:owner,path:wt},{repo:owner,path:wt+path.sep+'.'}]},{worktrees:[null]},{worktrees:{}},{worktrees:Array(15).fill({repo:owner,path:wt})},{worktrees:[{repo:owner,path:owner}]}]){
   const original=runs.get(owner,id);runs.update(owner,id,patch);assert.throws(()=>api.measureTask({owner,request:q}),/owner-window-code-roots-unmeasured/);runs.update(owner,id,{branch:original.branch,worktrees:original.worktrees});
  }
  const invalidCopy={owner,request:q,receiptCopy:path.join(lab,'outside.receipt.json')};assert.throws(()=>api.measureTask(invalidCopy),/owner-window-receipt-copy-invalid/);
  put(copy,Buffer.concat([receiptBytes,Buffer.from('\n')]));assert.throws(()=>api.measureTask({owner,request:q,receiptCopy:copy}),/owner-window-receipt-copy-mismatch/);put(copy,receiptBytes);
  if(host==='codex'&&!explicit){
   const foreign=path.join(lab,'foreign'),foreignWt=path.join(lab,'foreign-worktree');fs.mkdirSync(foreign);git(foreign,['init','-q']);git(foreign,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','foreign']);git(foreign,['worktree','add','-qb',branch,foreignWt]);
   const original=runs.get(owner,id);runs.update(owner,id,{worktrees:[{repo:foreign,path:foreignWt}]});assert.throws(()=>api.measureTask({owner,request:q}),/owner-window-code-roots-unmeasured/,'valid foreign repository worktree is not declared by this request');runs.update(owner,id,{worktrees:original.worktrees});
   const link=path.join(path.dirname(copy),'linked');fs.symlinkSync(foreign,link,'junction');
   try{assert.throws(()=>api.measureTask({owner,request:q,receiptCopy:path.join(link,'receipt.json')}),/owner-window-evidence-link/);}
   finally{assert(fs.lstatSync(link).isSymbolicLink());if(process.platform==='win32')fs.rmdirSync(link);else fs.unlinkSync(link);}
  }
  if(explicit){
   const collision=roots.singleContract(owner,wt),ambiguous='repository-'+roots.digest(owner).slice(0,16);collision.code_roots[0].id=ambiguous;collision.primary_root_id=ambiguous;
   assert.throws(()=>require('./forge-owner-recovery-roots').measure({owner:fs.realpathSync.native(owner),contract:collision,run:runs.get(owner,id)}),/owner-window-code-roots-unmeasured/,'reconciliation IDs must not alias declared root IDs');
  }
  const binding={kind:'artifact-preparation',coordination:'observed-host-session-v1',task_id:id,dispatch_id:q.dispatchId,request_sha256:fingerprint,host_runtime:host,host_session_sha256:roots.digest(old.sessionId)},bindingFile=path.join(lab,'binding.json');put(bindingFile,JSON.stringify(binding));
  command(process.execPath,['-e',"require(process.argv[1]).open(process.argv[2],JSON.parse(require('fs').readFileSync(process.argv[3])));",path.join(__dirname,'forge-owner-transport-window.js'),owner,bindingFile],owner);
  let closed=false;const child=cp.spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore'],windowsHide:true}),joined=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));children.push({child,joined});
  actor(host,'current-'+host+'-'+explicit);let evidence={owner,request:q};
  if(explicit){fs.unlinkSync(receipt);assert.equal(api.inspect(evidence).receipt_phase,'missing');put(copy,JSON.stringify({phase:'failed',dispatch_id:'foreign',request_fingerprint:fingerprint}));assert.throws(()=>api.inspect({...evidence,receiptCopy:copy}),/owner-window-receipt-mismatch/);put(copy,receiptBytes);evidence={...evidence,receiptCopy:copy};}
  let observed=api.inspect(evidence);assert.equal(observed.status,'held');const requestFile=path.join(lab,'request.json');put(requestFile,JSON.stringify(q));
  assert.throws(()=>doctor.inspectTaskRetirement({...evidence,outcome:'superseded',successorId:milestone}),/owner-window-busy/,'retirement cannot bypass the held owner window');
  const cli=JSON.parse(command(process.execPath,[path.join(__dirname,'forge-doctor.js'),'--owner-window','--cwd',owner,'--request',requestFile,...(explicit?['--receipt-copy',copy]:[]),'--json'],owner));assert.equal(cli.status,'held');
  const adapter=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:ch=>({coverage_complete:true,previous_session_sha256:ch.scope.previous_host_session_sha256,previous_owner_stopped:true,writers:[{state:closed?'joined':'active',reference:'actual ChildProcess close event'}],joined:closed,possible_writers:closed?0:1,reference:'old custody process exit and tracked writer close'}),reconcile:()=>({reconciled:true,reference:'both dirty roots and exact original request/retained receipt measured'}),observeDecision:ch=>({outcome:ch.intent.outcome,successor_id:ch.intent.successor_id,reference:'explicit simulated user superseding decision'})});
  await assert.rejects(doctor.recoverOwnerWindow({...evidence,adapter}),/owner-window-writer-unproven/);assert(windows.observed(owner));child.stdin.end();await joined;
  const receiptRace=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:api.assertAdapter(adapter).observeWriters,reconcile:()=>{if(explicit)put(copy,Buffer.concat([receiptBytes,Buffer.from('\n')]));else fs.unlinkSync(receipt);return{reconciled:true,reference:'intentional receipt lifecycle race'};}});
  await assert.rejects(doctor.recoverOwnerWindow({...evidence,receiptCopy:copy,adapter:receiptRace}),/owner-window-recovery-conflict/);put(copy,receiptBytes);if(!explicit)put(receipt,receiptBytes);
  for(const root of [owner,wt]){
   const race=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:api.assertAdapter(adapter).observeWriters,reconcile:()=>{put(path.join(root,'race.txt'),'changed during reconciliation');return{reconciled:true,reference:'intentional real-root race'};}});
   await assert.rejects(doctor.recoverOwnerWindow({...evidence,adapter:race}),/owner-window-recovery-conflict/);assert(windows.observed(owner));fs.unlinkSync(path.join(root,'race.txt'));
  }
  const changedBranch=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:api.assertAdapter(adapter).observeWriters,reconcile:()=>{git(wt,['switch','-qc','changed-'+host+'-'+explicit]);return{reconciled:true,reference:'intentional branch race'};}});
  await assert.rejects(doctor.recoverOwnerWindow({...evidence,adapter:changedBranch}),/owner-window-code-roots-unmeasured/);git(wt,['switch','-q',branch]);
  const result=await doctor.recoverOwnerWindow({...evidence,adapter});assert.equal(result.recovered,true);assert.equal(windows.observed(owner),null);
  const retirementPreview=JSON.parse(command(process.execPath,[path.join(__dirname,'forge-doctor.js'),'--retire-task',id,'--cwd',owner,'--request',requestFile,'--outcome','superseded','--successor',milestone,...(explicit?['--receipt-copy',copy]:[]),'--json'],owner));assert.equal(retirementPreview.status,'open');
  if(explicit){assert.throws(()=>doctor.inspectTaskRetirement({owner,request:q,outcome:'superseded',successorId:milestone}),/task-retirement-receipt-required/);}
  const retired=await doctor.retireTask({...evidence,adapter,outcome:'superseded',successorId:milestone});assert.equal(retired.closed,true);assert.equal(personal.readPersonalSnapshot({project:owner,id}).works[0].workStatus,'superseded');
  assert.equal(fs.readFileSync(path.join(owner,'source.txt'),'utf8'),'retained owner change\n');assert.equal(fs.readFileSync(path.join(wt,'source.txt'),'utf8'),'retained worktree change\n');assert(fs.readFileSync(copy).equals(receiptBytes));assert.equal(JSON.stringify(q),originalRequest);assert.equal(runs.get(owner,id).session_id,old.sessionId);
  assert.equal(personal.readPersonalSnapshot({project:owner,id}).works[0].checkpoint.pending[0].resolved,false,'retirement preserves unanswered history');
  assert.equal(personal.bindWork({project:owner,id:milestone,intent:'create'}).status,'ok');const state=path.join(owner,'.gsd/milestones',milestone,milestone+'-STATE.md');
  assert.equal(personal.saveCheckpoint({project:owner,id:milestone,intent:'checkpoint',checkpoint:{acceptances:[{text:'Previously explicit discuss acceptance',source:state,resolved:true}],lastResult:[{text:'Retained acceptance observed; safe continuation after task superseding',source:state}]}}).status,'ok');
  fs.appendFileSync(state,'Recorded safe continuation\n');assert.equal(personal.readPersonalSnapshot({project:owner,id:milestone}).works[0].reliability,'needs-reconciliation');
  assert.equal(personal.saveCheckpoint({project:owner,id:milestone,intent:'checkpoint',checkpoint:{acceptances:[{text:'Previously explicit discuss acceptance',source:state,resolved:true}],lastResult:[{text:'Same explicit acceptance recaptured against current state',source:state}]}}).status,'ok');
  const resumed=personal.readPersonalSnapshot({project:owner,id:milestone}).works[0];assert.equal(resumed.reliability,'current');assert.equal(resumed.checkpoint.acceptances.at(-1).resolved,true);
 }
 console.log('PASS actual registered worktree legacy/explicit contracts on both hosts; alive-writer and both-root/branch races refuse; joined recovery, retained superseding and personal milestone continuation');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 for(const row of children)row.child.stdin.end();await Promise.all(children.map(row=>row.joined));
 for(const owner of owners){const held=windows.observed(owner);if(held)windows.recover(owner,held,ch=>({challenge_sha256:roots.digest(ch),joined:true,possible_writers:0,reference:'fixture cleanup after actual writer joins'}));const control=windows.controlRoot(owner);assert.equal(fs.realpathSync.native(path.dirname(control)),fs.realpathSync.native(os.tmpdir()));if(fs.existsSync(control)){assert(!fs.lstatSync(control).isSymbolicLink());fs.rmSync(control,{recursive:true,force:true});}}
 process.env=saved;assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});
});
