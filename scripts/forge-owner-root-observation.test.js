'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),{pathToFileURL}=require('url');
const api=require('./forge-owner-window-recovery'),runs=require('./forge-runs'),windows=require('./forge-owner-transport-window');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-root-observation-'))),owner=path.join(lab,'owner');
const run=(bin,args,cwd=lab)=>{const r=cp.spawnSync(bin,args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
const put=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
function request(code,id){windows.ensureTask(owner,id);runs.add(owner,{id,kind:'task',session_id:'previous-fixture',host_runtime:'codex',owner_session_source:'CODEX_THREAD_ID',cwd:owner,root:owner});
 return{schema_version:1,scope:'standalone-task',phase:'brainstorm',taskId:id,cwd:code,contextRoot:owner,hostRuntime:'codex',workflowId:'root399',dispatchId:'dispatch-'+id,resultFile:path.join(lab,id+'.json'),inputs:{brief:'Synthetic root measurement'}};}
try{
 fs.mkdirSync(path.join(owner,'.gsd'),{recursive:true});const code=path.join(lab,'git');fs.mkdirSync(code);run('git',['init','-q'],code);put(path.join(code,'file.txt'),'base\n');run('git',['add','file.txt'],code);run('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base'],code);put(path.join(code,'file.txt'),'working\n');
 const q=request(code,'TASK-001'),measure=()=>api.measureTask({owner,request:q}).scope.code_states[0];
 const before=measure();run('git',['add','file.txt'],code);const after=measure();
 assert.deepEqual(before.pre_dirty,after.pre_dirty);assert.equal(before.start_sha,after.start_sha);assert.notDeepEqual(before.git_index,after.git_index,'staging must change the measured root even with identical working bytes');
 const originalMode=fs.statSync(path.join(code,'file.txt')).mode&0o777,modeBefore=measure();
 try{fs.chmodSync(path.join(code,'file.txt'),0o444);const modeAfter=measure();assert.deepEqual(modeBefore.pre_dirty,modeAfter.pre_dirty);assert.notDeepEqual(modeBefore.worktree_metadata,modeAfter.worktree_metadata,'same-byte mode changes remain part of the measured root');}
 finally{fs.chmodSync(path.join(code,'file.txt'),originalMode);}
 run('git',['update-index','--split-index'],code);const split=measure();assert.notEqual(split.git_index.shared_index_sha256,'absent','split index dependency is measured');
 if(cp.spawnSync('svnadmin',['--version','--quiet'],{windowsHide:true}).status===0){
  const repo=path.join(lab,'repo'),wc=path.join(lab,'svn');run('svnadmin',['create',repo]);run('svn',['checkout',pathToFileURL(repo).href,wc]);put(path.join(wc,'file.txt'),'base\n');run('svn',['add','file.txt'],wc);run('svn',['commit','-m','base'],wc);run('svn',['update'],wc);
  run('svn',['propset','forge:observation','first','file.txt'],wc);const svn=request(wc,'TASK-002'),read=()=>api.measureTask({owner,request:svn}).scope.code_states[0],first=read();
  run('svn',['propset','forge:observation','second','file.txt'],wc);const second=read();assert.deepEqual(first.pre_dirty,second.pre_dirty);assert.equal(first.start_sha,second.start_sha);assert.notEqual(first.svn_state_sha256,second.svn_state_sha256,'property-only changes remain part of reconciliation');
 }else console.log('SKIP SVN property observation: svnadmin unavailable');
 console.log('PASS root observation includes staged-only Git changes, same-byte modes, split-index dependency and strict SVN property-only state');
}finally{
 const control=windows.controlRoot(owner);assert.equal(fs.realpathSync.native(path.dirname(control)),fs.realpathSync.native(os.tmpdir()));if(fs.existsSync(control)){assert(!fs.lstatSync(control).isSymbolicLink());fs.rmSync(control,{recursive:true,force:true});}
 assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});
}
