'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {spawnSync}=require('child_process'),{pathToFileURL}=require('url');
const vcs=require('./forge-vcs'),reset=require('./forge-surgical-reset'),roots=require('./forge-code-roots');
function main(){
 if(['svn','svnadmin'].some(cmd=>spawnSync(cmd,['--version','--quiet'],{encoding:'utf8',shell:false}).status!==0)){
  console.log('SKIP snapshot diagnostics: SVN toolchain unavailable; no adapter pass claimed');return;
 }
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-snapshot-diagnostic-'))),wc=path.join(dir,'wc'),owner=path.join(dir,'owner');
 const original=vcs.captureDirty;
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',shell:false,windowsHide:true,timeout:15000});assert.equal(r.status,0,r.stderr);};
 const svn=(...args)=>run('svn',[...args,'--non-interactive','--config-dir',path.join(dir,'config')]);
 try{
  fs.mkdirSync(owner);run('svnadmin',['create',path.join(dir,'repo')]);
  svn('checkout',pathToFileURL(path.join(dir,'repo')).href,wc);
  fs.writeFileSync(path.join(wc,'tracked.txt'),'baseline\n');svn('add',path.join(wc,'tracked.txt'));
  svn('propset','svn:ignore','deps',wc);svn('commit',wc,'-m','synthetic diagnostic fixture');
  fs.mkdirSync(path.join(wc,'deps'));const dependency=path.join(wc,'deps','opaque.dat');fs.writeFileSync(dependency,Buffer.alloc(64,7));
  const baseline=original(wc,{vcs:'svn',strict:true});assert.equal(baseline.ok,true,'normal bounded checkout remains supported');
  const failed=original(wc,{vcs:'svn',strict:true,strictLimits:{maxTotalBytes:32}});
  assert.equal(failed.ok,false);assert.equal(failed.error,'svn-snapshot-limit');
  assert.equal(failed.diagnostic.stage,'inventory');assert.equal(failed.diagnostic.content_bytes_read,0);
  assert.equal(failed.diagnostic.limits.maxTotalBytes,32);assert(failed.diagnostic.inventory_bytes>=64);
  vcs.captureDirty=(cwd,opts)=>original(cwd,opts.strict?{...opts,strictLimits:{maxTotalBytes:32}}:opts);
  const inspect=action=>{
   let caught;try{action();}catch(error){caught=error;}assert(caught,'real snapshot adapter refuses');
   assert.equal(caught.code,'svn-snapshot-limit');assert.equal(caught.diagnostic.stage,'inventory');
   assert.equal(caught.diagnostic.reconciliation,'blocked');assert.equal(caught.diagnostic.limits.maxTotalBytes,32);
   assert.equal(caught.diagnostic.content_bytes_read,0);assert(caught.diagnostic.inventory_entries>0);
   assert(caught.hint.includes('reconciliation is incomplete'));
   assert(!JSON.stringify(caught.diagnostic).includes(dir),'diagnostic does not copy physical paths');
  };
  inspect(()=>reset.captureAttemptSnapshot(wc,{vcsName:'svn'}));
  const contract=roots.singleContract(owner,wc);
  inspect(()=>require('./forge-recovery-transition').rootObservations(contract));
  console.log('PASS measured SVN refusal: real ignored-file inventory limit, zero content bytes, effective policy and recovery/reset adapter propagation');
  vcs.captureDirty=(cwd,opts)=>opts.strict?{vcs:'svn',ok:false,error:'svn-snapshot-limit',diagnostic:{
   stage:'secret/path',budget_ms:-1,inventory_entries:Infinity,inventory_bytes:64,content_bytes_read:0,
   credentials:'never-copy',path:dir,limits:{maxTotalBytes:32,maxFileBytes:'secret',unknown:'never-copy'}}}:original(cwd,opts);
  let error;try{reset.captureAttemptSnapshot(wc,{vcsName:'svn'});}catch(e){error=e;}
  assert(error);assert.equal(error.diagnostic.stage,undefined);assert.equal(error.diagnostic.budget_ms,undefined);
  assert.equal(error.diagnostic.inventory_entries,undefined);assert.deepEqual(error.diagnostic.limits,{maxTotalBytes:32});
  assert(!JSON.stringify(error.diagnostic).includes('never-copy'));assert(!JSON.stringify(error.diagnostic).includes('secret'));
  assert.deepEqual(fs.readFileSync(dependency),Buffer.alloc(64,7),'no checkout cleanup or reset performed');
  console.log('PASS diagnostic sanitization: unknown stages/keys, paths and invalid numbers omitted; writer data and snapshot limits unchanged');
 }finally{
  vcs.captureDirty=original;
  const real=fs.realpathSync.native(dir),tmp=fs.realpathSync.native(os.tmpdir());
  assert.equal(path.dirname(real),tmp);assert(path.basename(real).startsWith('forge-snapshot-diagnostic-'));
  fs.rmSync(real,{recursive:true,force:true});
 }
}
if(require.main===module)main();module.exports={main};
