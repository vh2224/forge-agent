'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const {pathToFileURL}=require('url'),vcs=require('./forge-vcs'),reset=require('./forge-surgical-reset');
if(cp.spawnSync('svnadmin',['--version','--quiet'],{windowsHide:true}).status!==0){console.log('SKIP SVN reset leaves: svnadmin unavailable');process.exit(0);}
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-reset-leaves-'))),wc=path.join(lab,'wc');
const run=(cmd,args,cwd=lab)=>{const r=cp.spawnSync(cmd,args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
const put=(p,s)=>{fs.mkdirSync(path.dirname(path.join(wc,p)),{recursive:true});fs.writeFileSync(path.join(wc,p),s);};
try{
 const repo=path.join(lab,'repo');run('svnadmin',['create',repo]);run('svn',['checkout',pathToFileURL(repo).href,wc]);
 put('base.txt','base\n');put('operator.txt','operator\n');run('svn',['add','base.txt','operator.txt'],wc);run('svn',['commit','-m','baseline'],wc);
 put('operator.txt','operator local\n');put('loose/keep.txt','preserved unversioned\n');
 const opts={vcs:'svn'},pre=vcs.captureDirty(wc,opts);assert.equal(pre.ok,true);
 put('base.txt','worker\n');put('newtree/inner/a.txt','new a\n');put('loose/new/b.txt','new b\n');put('draft@name.txt','new at\n');
 fs.mkdirSync(path.join(wc,'empty-new'));put('scheduled.txt','scheduled\n');run('svn',['add','scheduled.txt'],wc);
 if(process.platform!=='win32')put('new\nline.txt','newline\n');
 const post=vcs.postChanges(wc,null,opts);assert.equal(post.ok,true);
 const target=reset.computeResetTarget(post.entries,pre.entries,p=>vcs.hashPath(wc,p,opts).hash);
 assert.equal(target.overlap.length,0);assert(target.preserved.includes('operator.txt'));assert(target.preserved.includes('loose/keep.txt'));
 const unversioned=target.remove.filter(p=>p!=='scheduled.txt'),reverted=[];
 const runner=(cmd,args,options)=>{
  if(args.includes('revert')){
   const at=args.indexOf('--targets');
   const paths=at>=0?fs.readFileSync(args[at+1],'utf8').trimEnd().split('\n'):args.slice(args.indexOf('--')+1).map(p=>p.replace(/@$/,''));
   reverted.push(...paths);
   // Model the strict POSIX SVN error even on Windows: an unversioned leaf
   // below an unversioned parent is not a valid metadata-revert target.
   if(paths.some(p=>unversioned.includes(p)))return {status:1,stdout:Buffer.alloc(0),stderr:Buffer.from('svn: E155010: unversioned leaf has no versioned parent')};
  }
  return cp.spawnSync(cmd,args,options);
 };
 const result=vcs.restoreAndRemove(wc,null,target,{...opts,runner});assert.equal(result.ok,true,JSON.stringify(result));
 assert(reverted.includes('base.txt'));assert(reverted.includes('scheduled.txt'),'scheduled additions still require metadata revert');
 assert.equal(fs.readFileSync(path.join(wc,'base.txt'),'utf8'),'base\n');
 assert.equal(fs.readFileSync(path.join(wc,'operator.txt'),'utf8'),'operator local\n');
 assert.equal(fs.readFileSync(path.join(wc,'loose/keep.txt'),'utf8'),'preserved unversioned\n');
 for(const p of target.remove)assert.equal(fs.existsSync(path.join(wc,p)),false,p);
 assert.equal(fs.existsSync(path.join(wc,'newtree')),false);assert.equal(fs.existsSync(path.join(wc,'loose/new')),false);
 const after=vcs.captureDirty(wc,opts);assert.deepEqual(after.entries,pre.entries);
 // A status read failure must stop before any destructive call or deletion.
 put('left.txt','must survive\n');let writes=0;
 const refused=vcs.restoreAndRemove(wc,null,{restore:[],remove:['left.txt'],overlap:[],preserved:[]},{...opts,runner:(cmd,args,options)=>{
  if(args.includes('status'))return {status:1,stdout:Buffer.alloc(0),stderr:Buffer.from('fixture status refused')};
  if(args.includes('revert'))writes++;
  return cp.spawnSync(cmd,args,options);
 }});
 assert.equal(refused.ok,false);assert.equal(refused.error,'svn-status-failed');assert.equal(writes,0);assert.equal(fs.readFileSync(path.join(wc,'left.txt'),'utf8'),'must survive\n');
 console.log('PASS strict SVN reset of nested/empty/unversioned leaves, scheduled addition revert, preserved operator siblings and failed-status no-write guard');
}finally{assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});}
