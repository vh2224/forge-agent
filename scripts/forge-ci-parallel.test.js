'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Writable } = require('node:stream');
const { parseArgs, workerLayout, toolPlan, prepareCheckout, logHeader, allocateRoot, run } = require('./forge-ci-parallel');
const fixtureJobName=require('./forge-release-checks').expandJobs(require('./forge-release-checks').POLICY.workflows.ci).find(job=>job.key==='test'&&job.matrix.platform==='win32').name;
const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ci-parallel-fixture-')));
const root = path.join(temp, 'source'); fs.mkdirSync(root);
for (const code of ['EACCES', 'EPERM', 'EROFS']) {
  const calls=[], fallback=path.join(temp,'fallback');
  assert.equal(allocateRoot(root,{fallback,create(prefix){calls.push(prefix);if(calls.length===1)throw Object.assign(Error('fixture'),{code});return prefix+'allocated';}}),path.join(fallback,'ci-allocated'));
  assert.deepEqual(calls,[path.join(root,'ci-'),path.join(fallback,'ci-')]);
}
for (const code of ['ENOSPC', 'ENOENT', 'EIO']) {
  let calls=0;
  assert.throws(()=>allocateRoot(root,{create(){calls++;throw Object.assign(Error('fixture'),{code});}}),error=>error.code===code);
  assert.equal(calls,1,'unrelated filesystem failures must remain visible');
}
assert.throws(()=>allocateRoot(root,{fallback:root,create(){throw Object.assign(Error('same-root'),{code:'EACCES'});}}),/same-root/);
function git(cwd, args) {
  const result = spawnSync('git', args, {cwd, encoding:'utf8', windowsHide:true});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes); }
const channel = path.join(temp,'channels');fs.mkdirSync(channel);
const mock = `
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
assert(args.includes('--partition-suites'));assert(args.includes('--baseline'));assert(args.includes('--shard-profile'));
assert.equal(require('node:os').tmpdir(),process.env.RUNNER_TEMP);
const profile=value('--profile-out'),index=Number(value('--shard-index')),count=Number(value('--shard-count'));
const channel=${JSON.stringify(channel)};
const config=fs.readFileSync(path.join(process.cwd(),'.git/config'),'utf8');
assert(!config.includes('fixture-secret-header'));
assert.equal(cp.execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim(),'https://example.invalid/fixture.git');
assert.equal(cp.execFileSync('git',['rev-parse','refs/remotes/origin/master'],{encoding:'utf8'}).trim(),cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
fs.writeFileSync(path.join(channel,'entered-'+index),process.cwd());
fs.writeFileSync('same-name.txt','owned-'+index);
(async()=>{
 const deadline=Date.now()+30000;
 while(!fs.existsSync(path.join(channel,'entered-'+(index===0?1:0)))){
   if(Date.now()>deadline)throw Error('peer-not-started');await new Promise(r=>setTimeout(r,10));
 }
 assert.equal(fs.readFileSync('same-name.txt','utf8'),'owned-'+index);
 if(fs.existsSync(path.join(channel,'fail'))&&index===0){process.exitCode=1;return;}
 await new Promise(r=>setTimeout(r,80));
 fs.writeFileSync(profile,JSON.stringify({index,count,cwd:process.cwd(),temp:require('node:os').tmpdir(),argv:args}));
 if(fs.existsSync(path.join(channel,'preserve')))fs.writeFileSync(path.join(require('node:os').tmpdir(),'preserved-fixture.txt'),'fixture explicitly left for diagnosis');
 console.log('Running 1 test suite sequentially...');
 // The real runner reprints a passed suite's captured output only under --verbose.
 if(args.includes('--verbose')){console.log('SYNTHETIC-VERBOSE-STDOUT passed suite output '+index);console.error('SYNTHETIC-VERBOSE-STDERR passed suite output '+index);}
 console.log('PASS synthetic.test.js (0.01s)');
 console.log('All 1 suites passed in 0.01s.');
 fs.writeFileSync(path.join(channel,'finished-'+index),'joined');
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
write(path.join(root,'scripts/run-tests.js'),mock);
for(const name of ['known-failures.json','known-unit-failures.json'])write(path.join(root,'scripts/fixtures/ci-baseline',name),JSON.stringify({win32:[],darwin:[],linux:[]}));
git(root,['init','-q']);
git(root,['config','user.name','Fixture']);git(root,['config','user.email','fixture@example.invalid']);
git(root,['config','commit.gpgsign','false']);git(root,['add','.']);git(root,['commit','-qm','fixture']);
git(root,['remote','add','origin','https://example.invalid/fixture.git']);
const sha=git(root,['rev-parse','HEAD']);git(root,['update-ref','refs/remotes/origin/master',sha]);
const remoteOnly=git(root,['commit-tree',git(root,['rev-parse','HEAD^{tree}']),'-p',sha,'-m','divergent remote-only fixture']);
git(root,['update-ref','refs/remotes/origin/divergent',remoteOnly]);
git(root,['config','http.https://example.invalid/.extraheader','fixture-secret-header']);
const argv=['--shard-index','0','--shard-count','1','--jobs','2','--profile-dir',path.join(temp,'profiles')];
assert.deepEqual(parseArgs(argv),{index:0,count:1,jobs:2,singleWorkerJobs:0,profileDir:path.join(temp,'profiles'),toolPlan:false,verbose:false});
assert.equal(parseArgs([...argv,'--tool-plan','true']).toolPlan,true);
for(const value of ['yes','1','TRUE'])assert.throws(()=>parseArgs([...argv,'--tool-plan',value]));
// --verbose true|false: default false, exact values only, never bare, never repeated.
assert.equal(parseArgs(argv).verbose,false,'verbose defaults to false');
assert.deepEqual(parseArgs([...argv,'--verbose','false']),parseArgs(argv),'explicit false equals the default');
assert.deepEqual(parseArgs([...argv,'--verbose','true']),{...parseArgs(argv),verbose:true});
assert.equal(parseArgs(['--verbose','true',...argv]).verbose,true,'pair order is free');
for(const bad of [[...argv,'--verbose'],[...argv,'--verbose',''],...['yes','1','TRUE','False','true ',' true','on'].map(value=>[...argv,'--verbose',value]),
  [...argv,'--verbose','true','--verbose','true'],[...argv,'--verbose','false','--verbose','true']])
  assert.throws(()=>parseArgs(bad),/^Error: ci-parallel-arguments$/,JSON.stringify(bad.slice(argv.length)));
const childArgv=(options,worker,verbose)=>['--baseline','scripts/fixtures/ci-baseline/known-unit-failures.json','--partition-suites',
  '--shard-profile','scripts/ci-profiles/issue-461-d046.json','--shard-index',String(worker),'--shard-count','2',
  '--profile-out',path.join(options.profileDir,`worker-${worker}.json`),...(verbose?['--verbose']:[])];
const toolOptions={index:0,count:21,jobs:2,singleWorkerJobs:2};
assert.equal(toolPlan(toolOptions,{platform:'linux',profileFile:'unread-invalid-path'}).needs_svn,true);
assert.equal(toolPlan({...toolOptions,index:2},{platform:'win32',profileFile:'unread-invalid-path'}).needs_svn,true);
assert.equal(toolPlan(toolOptions,{platform:'win32',profileFile:path.join(temp,'absent-profile')}).needs_svn,true);
const toolProfile=JSON.parse(fs.readFileSync(path.join(__dirname,'ci-profiles/issue-461-d046.json')));
assert.equal(require('./forge-ci-shards').loadShardProfile(path.join(__dirname,'ci-profiles/issue-461-d046.json')).sha256,'c5438665a4bba363efdc617310a612125049a831c9ae079bcdf41712c01b4366','exact current measured default profile');
assert.equal(toolProfile.sources.length,64);for(const p of ['win32','linux','darwin']){assert.equal(toolProfile.platforms[p].observations,601);assert.equal(Object.keys(toolProfile.platforms[p].weights_ms).length,601);}
for(const id of Object.keys(toolProfile.platforms.win32.weights_ms))toolProfile.platforms.win32.weights_ms[id]=1;
const linkedCoreId=require('./forge-ci-units').unitsForSuite('forge-linked-task-start.test.js')[0].id;
toolProfile.platforms.win32.weights_ms[linkedCoreId]=800000;
const toolProfileFile=path.join(temp,'tool-profile.json');fs.writeFileSync(toolProfileFile,JSON.stringify(toolProfile));
assert.equal(require('./forge-ci-shards').loadShardProfile(toolProfileFile).state,'loaded');
const gitOnly=toolPlan(toolOptions,{platform:'win32',profileFile:toolProfileFile});
assert.equal(gitOnly.needs_svn,false,'actual weighted assignment is solely the Git-only linked fixture');
assert(gitOnly.selected_units.every(id=>id.startsWith('forge-linked-task-start.')));
toolProfile.platforms.win32.weights_ms['forge-ci-profile.test.js']=900000;
fs.writeFileSync(toolProfileFile,JSON.stringify(toolProfile));
assert.equal(require('./forge-ci-shards').loadShardProfile(toolProfileFile).state,'loaded');
assert.equal(toolPlan(toolOptions,{platform:'win32',profileFile:toolProfileFile}).needs_svn,true,'a changed heaviest source keeps SVN; skipping is not hard-coded by job index');
const toolOutput=path.join(temp,'github-output'),unusedProfiles=path.join(temp,'metadata-only-profiles');fs.writeFileSync(toolOutput,'');
const toolCli=spawnSync(process.execPath,[path.join(__dirname,'forge-ci-parallel.js'),'--tool-plan','true','--shard-index','0','--shard-count','21','--jobs','2','--single-worker-jobs','2','--profile-dir',unusedProfiles],{env:{...process.env,GITHUB_OUTPUT:toolOutput},encoding:'utf8',windowsHide:true});
assert.equal(toolCli.status,0,toolCli.stderr);assert.equal(fs.readFileSync(toolOutput,'utf8'),`needs_svn=${JSON.parse(toolCli.stdout).needs_svn}\n`);
assert(!fs.existsSync(unusedProfiles),'tool metadata mode never starts tests or creates timing profiles');
for(let count=1;count<=32;count++)for(let jobs=1;jobs<=3;jobs++)for(let singleWorkerJobs=0;singleWorkerJobs<=count;singleWorkerJobs++){
  const total=singleWorkerJobs+(count-singleWorkerJobs)*jobs;
  if(total>64){assert.throws(()=>workerLayout({index:0,count,jobs,singleWorkerJobs}),/arguments/);continue;}
  const indices=Array.from({length:count},(_,index)=>workerLayout({index,count,jobs,singleWorkerJobs}))
    .flatMap(row=>Array.from({length:row.workers},(_,i)=>{assert.equal(row.count,total);return row.start+i;}));
  assert.deepEqual(indices,Array.from({length:total},(_,i)=>i),'single-worker prefixes preserve exact complete global coverage');
}
for(const value of ['-1','2','1.5','NaN'])assert.throws(()=>parseArgs([...argv,'--single-worker-jobs',value]));
assert.throws(()=>logHeader('injected\nComplete job name: foreign'),/job-name/);
for(const bad of [[],['--jobs','4'],[...argv,'--jobs','1'],argv.map(v=>v==='--jobs'?'--unknown':v),argv.map(v=>v==='1'?'0':v)])assert.throws(()=>parseArgs(bad));
const chunks=[];const sink=new Writable({write(chunk,_,done){chunks.push(chunk.toString());done();}});
const streams={stdout:sink,stderr:sink};
(async()=>{
  try{
    const independent=path.join(temp,'independent');prepareCheckout(root,independent,sha);
    assert.notEqual(git(root,['rev-parse','--absolute-git-dir']),git(independent,['rev-parse','--absolute-git-dir']));
    assert.equal(git(independent,['rev-parse','refs/remotes/origin/divergent']),remoteOnly);
    assert.equal(git(independent,['cat-file','-t',remoteOnly]),'commit');
    git(independent,['update-ref','refs/heads/worker-only',sha]);
    const absent=spawnSync('git',['show-ref','--verify','refs/heads/worker-only'],{cwd:root,windowsHide:true});assert.notEqual(absent.status,0);
    assert.equal(await run(parseArgs(argv),{source:root,temp,streams,jobName:fixtureJobName}),0);
    const profiles=[0,1].map(i=>JSON.parse(fs.readFileSync(path.join(temp,'profiles',`worker-${i}.json`))));
    assert.deepEqual(profiles.map(x=>[x.index,x.count]),[[0,2],[1,2]]);
    assert.notEqual(profiles[0].cwd,profiles[1].cwd);
    assert(profiles.every(row=>row.cwd.length<=root.length+15),'independent checkouts retain a bounded path-length overhead');
    assert.notEqual(profiles[0].temp,profiles[1].temp);
    assert(profiles.every(row=>!fs.existsSync(row.cwd)),'successful joined workers are removed');
    assert(!fs.existsSync(path.join(root,'same-name.txt')));
    for(let index=0;index<2;index++){
      const log=fs.readFileSync(path.join(temp,'profiles',`worker-${index}.log`),'utf8');
      const parsed=require('./forge-ci-profile').parseRunTestsLog(log);
      assert.deepEqual(parsed.anomalies,[]);assert.equal(parsed.platform,'win32');assert.equal(parsed.suites_observed,1);
      assert(!log.includes('SYNTHETIC-VERBOSE-'),'default mode never forwards --verbose to the child');
    }
    assert.deepEqual(profiles.map((row,worker)=>row.argv),[0,1].map(worker=>childArgv(parseArgs(argv),worker,false)));
    for(const file of fs.readdirSync(channel))fs.rmSync(path.join(channel,file));
    // Same single execution with --verbose true: exactly one appended child flag, the rest unchanged,
    // and the drained worker-N.log retains the passed suite's extra stdout and stderr.
    const verboseOptions={...parseArgs([...argv,'--verbose','true']),profileDir:path.join(temp,'verbose-profiles')};
    assert.equal(await run(verboseOptions,{source:root,temp,streams,jobName:fixtureJobName}),0);
    const verboseProfiles=[0,1].map(i=>JSON.parse(fs.readFileSync(path.join(verboseOptions.profileDir,`worker-${i}.json`))));
    assert.deepEqual(verboseProfiles.map(row=>row.argv),[0,1].map(worker=>childArgv(verboseOptions,worker,true)));
    assert(verboseProfiles.every(row=>!fs.existsSync(row.cwd)),'verbose workers are joined and cleaned like the default');
    for(let index=0;index<2;index++){
      const log=fs.readFileSync(path.join(verboseOptions.profileDir,`worker-${index}.log`),'utf8');
      const parsed=require('./forge-ci-profile').parseRunTestsLog(log);
      assert.deepEqual(parsed.anomalies,[]);assert.equal(parsed.suites_observed,1);assert.equal(parsed.summary.failed,0);
      for(const stream of ['STDOUT','STDERR'])
        assert.match(log,new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[0-9:.]+Z SYNTHETIC-VERBOSE-${stream} passed suite output ${index}$`,'m'),`worker-${index}.log drained ${stream}`);
      assert(log.indexOf('SYNTHETIC-VERBOSE-STDOUT')<log.indexOf('PASS synthetic.test.js'),'extra output precedes the suite boundary');
    }
    assert.deepEqual(fs.readdirSync(verboseOptions.profileDir).sort(),['worker-0.json','worker-0.log','worker-1.json','worker-1.log'],'no extra artifact or second run');
    for(const file of fs.readdirSync(channel))fs.rmSync(path.join(channel,file));
    const tripleArgs=[...argv];tripleArgs[5]='3';
    const tripleOptions={...parseArgs(tripleArgs),profileDir:path.join(temp,'triple-profiles')};
    assert.equal(await run(tripleOptions,{source:root,temp,streams}),0);
    const triple=[0,1,2].map(i=>JSON.parse(fs.readFileSync(path.join(tripleOptions.profileDir,`worker-${i}.json`))));
    assert.deepEqual(triple.map(p=>[p.index,p.count]),[[0,3],[1,3],[2,3]]);
    assert.equal(new Set(triple.map(p=>p.cwd)).size,3);
    assert(triple.every(p=>!fs.existsSync(p.cwd)),'all three successful workers are joined before cleanup');
    for(const file of fs.readdirSync(channel))fs.rmSync(path.join(channel,file));
    const heterogeneous=[0,1].map(index=>({...parseArgs(argv),index,count:2,singleWorkerJobs:1,profileDir:path.join(temp,'heterogeneous-'+index)}));
    assert.deepEqual(await Promise.all(heterogeneous.map(options=>run(options,{source:root,temp,streams}))),[0,0]);
    const mixed=heterogeneous.flatMap((options,index)=>Array.from({length:index===0?1:2},(_,worker)=>JSON.parse(fs.readFileSync(path.join(options.profileDir,`worker-${worker}.json`)))));
    assert.deepEqual(mixed.map(row=>[row.index,row.count]),[[0,3],[1,3],[2,3]]);
    assert.equal(new Set(mixed.map(row=>row.cwd)).size,3);
    assert(mixed.every(row=>!fs.existsSync(row.cwd)),'exclusive and paired jobs both drain before cleanup');
    for(const file of fs.readdirSync(channel))fs.rmSync(path.join(channel,file));
    fs.writeFileSync(path.join(channel,'fail'),'fail first worker');
    const failedOptions={...parseArgs(argv),profileDir:path.join(temp,'failed-profiles')};
    assert.equal(await run(failedOptions,{source:root,temp,streams}),1);
    assert(fs.existsSync(path.join(channel,'finished-1')),'healthy sibling finished before failure returned');
    assert(fs.existsSync(path.join(failedOptions.profileDir,'worker-1.json')),'healthy timing retained on failure');
    for(const file of fs.readdirSync(channel))fs.rmSync(path.join(channel,file));
    fs.writeFileSync(path.join(channel,'preserve'),'retain completed fixture roots');
    const retainedOptions={...parseArgs(argv),profileDir:path.join(temp,'retained-profiles')};
    assert.equal(await run(retainedOptions,{source:root,temp,streams}),0);
    const retained=JSON.parse(fs.readFileSync(path.join(retainedOptions.profileDir,'worker-0.json')));
    assert(fs.existsSync(path.join(retained.temp,'preserved-fixture.txt')),'a successful suite cannot erase fixtures it deliberately retained');
    write(path.join(root,'untracked.txt'),'dirty');
    await assert.rejects(()=>run(parseArgs(argv),{source:root,temp,streams}),/clean-checkout/);
    console.log('PASS independent Git/index/working trees, exact candidate and history, no copied checkout credentials, complete global shard mapping, sibling drain and fail-closed dirty source');
  }finally{fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
})().catch(error=>{console.error(error);console.error(chunks.join('').slice(-5000));process.exitCode=1;});
