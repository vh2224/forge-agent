'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-hook-window-'))),owner=path.join(lab,'owner');
fs.mkdirSync(path.join(owner,'.gsd','tasks'),{recursive:true});
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
}finally{assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});}
