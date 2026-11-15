'use strict';
const assert=require('assert/strict'), fs=require('fs'), os=require('os'), path=require('path'), cp=require('child_process');
const {pathToFileURL}=require('url');
if(cp.spawnSync('svnadmin',['--version','--quiet'],{windowsHide:true}).status!==0){console.log('SKIP SVN census: svnadmin unavailable');process.exit(0);}
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-leaf-census-')));
const wc=path.join(lab,'wc'), repo=path.join(lab,'repo');
function run(cmd,args,cwd=lab){const r=cp.spawnSync(cmd,args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;}
const put=(rel,text)=>{const p=path.join(wc,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
try{
 run('svnadmin',['create',repo]);run('svn',['checkout',pathToFileURL(repo).href,wc]);
 put('src/base.js','base\n');run('svn',['add','src'],wc);run('svn',['commit','-m','baseline'],wc);run('svn',['update'],wc);
 put('src/existing/old.js','old\n');put('src/existing/deleted.js','delete\n');
 fs.mkdirSync(path.join(wc,'src/empty'),{recursive:true});put('src/last/only.js','last\n');
 const vcs=require('./forge-vcs'), reset=require('./forge-surgical-reset'), roots=require('./forge-code-roots');
 const contract=roots.singleContract(wc,wc), before=reset.captureAttemptSnapshot(wc);
 const declared=['src/new/a.test.js','src/new/b.test.js','src/existing/old.js','src/existing/new.js','src/existing/deleted.js','src/empty/first.js','src/last/only.js'];
 put(declared[0],'a\n');put(declared[1],'b\n');put(declared[2],'changed\n');put(declared[3],'new\n');fs.unlinkSync(path.join(wc,declared[4]));
 put(declared[5],'first\n');fs.unlinkSync(path.join(wc,declared[6]));
 const entries=vcs.captureDirty(wc,{vcs:'svn'});assert.equal(entries.ok,true);
 assert(entries.entries.some(e=>e.path===declared[0]));assert(!entries.entries.some(e=>e.path==='src/new'));
 const prepared={execution_contract:contract,claims:declared.map(p=>({root_id:'primary',path:p})),snapshots:[{...before,root_id:'primary'}]};
 const result={files_changed:declared.map(p=>'primary::'+p)};
 require('./forge-task-execution').verifyResult(wc,prepared,result);
 assert.throws(()=>require('./forge-task-execution').verifyResult(wc,prepared,{files_changed:result.files_changed.slice(1)}),e=>e.code==='execution-result-omitted-delta'&&e.offending_path.path===declared[0]);
 put('src/new/unclaimed.js','unclaimed\n');
 assert.throws(()=>require('./forge-task-execution').verifyResult(wc,prepared,result),e=>e.code==='execution-outside-claim'&&e.offending_path.path==='src/new/unclaimed.js');
 fs.unlinkSync(path.join(wc,'src/new/unclaimed.js'));
 // Cost census includes complete reconstructed nested new-file hunks.
 for(let i=0;i<6;i++)put('src/review/new'+i+'.js',Array.from({length:700},(_,n)=>'line '+n).join('\n')+'\n');
 const cost=require('./forge-cost-policy'), diff=cost.collectDiff(wc);
 assert.equal(diff.ok,true,JSON.stringify(diff));assert.equal(diff.vcs,'svn');
 const newEntries=diff.entries.filter(e=>e.file.startsWith('src/review/'));
 assert.equal(newEntries.length,6);assert.equal(newEntries.reduce((n,e)=>n+e.added,0),4200);
 const shards=cost.planReviewShards(newEntries);assert(shards.length>1);assert(shards.every(s=>s.lines<4000));
 assert.equal(new Set(shards.flatMap(s=>s.files)).size,6);
 put('src/unrelated/huge.js','x'.repeat(2*1024*1024+1));
 const scopeFile=path.join(lab,'scope.txt');fs.writeFileSync(scopeFile,newEntries.map(e=>e.file).join('\n'));
 const selectedCost=cost.collectDiff(wc,null,scopeFile);assert.equal(selectedCost.ok,true);assert.equal(selectedCost.warning,null);assert.equal(selectedCost.entries.length,6);
 put('src/deep/'+Array.from({length:14},(_,i)=>'d'+i).join('/')+'/leaf.js','deep\n');
 assert(cost.collectDiff(wc).entries.some(e=>e.file.endsWith('/d13/leaf.js')),'depth13 must not disappear');
 const dir=path.join(lab,'artifacts');fs.mkdirSync(dir);
 fs.writeFileSync(path.join(dir,'T01-PLAN.md'),'---\nroots_schema: 2\nprimary_root_id: primary\ncode_roots:\n  - id: primary\n    path: '+JSON.stringify(wc.replace(/\\/g,'/'))+'\nexpected_output:\n  - primary::src/new/a.test.js\n---\n');
 const review=require('./forge-review-diff'), manifest=new Set(review.collectUnitDeclaredPaths(dir,wc));
 assert.deepEqual([...manifest],['src/new/a.test.js']);
 const scope=review.computeScope({versioned:['unrelated.js'],untracked:declared,manifest,only:[]});
 assert.equal(scope.reason,'manifest');assert.deepEqual(scope.untracked,['src/new/a.test.js']);
 assert.throws(()=>review.computeScope({versioned:['unrelated.js'],untracked:[],manifest:new Set(['foreign::src/a.js']),only:[]}),/review-root-context-required/);
 console.log('PASS SVN leaf additions/changes/deletions, exact claims, omission/outside negatives, complete costs/shards and bound v2 review scope');
}finally{assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});}
