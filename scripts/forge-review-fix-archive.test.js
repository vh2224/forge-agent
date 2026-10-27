'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const fixtures=require('./forge-code-roots.test'),reset=require('./forge-surgical-reset');
const archive=require('./forge-review-fix-archive');
const lab=fixtures.fixture();let count=0;
function run(name,fn){fn();console.log('PASS '+name);count++;}
const stateFile=path.join(lab.dir,'state.json');
const request={cwd:lab.a,contextRoot:lab.owner,dispatchId:'archive-fixture',resultFile:path.join(lab.dir,'result.json')};
const state={cwd:lab.a,stateFile,repoRoots:[lab.a],brief:{claim_paths:['same.txt','new.bin']}};
const input={request,state,fingerprint:'a'.repeat(64),assertStopped:()=>true};
const capture=()=>archive.preservePartialPatch(input);
try{
  fs.writeFileSync(path.join(lab.a,'prior.txt'),'prior\n');
  reset.initState(stateFile,{cwd:lab.a,attempt:request.dispatchId,repoRoots:[lab.a]});
  fs.writeFileSync(path.join(lab.a,'same.txt'),'authored bytes\n');
  fs.writeFileSync(path.join(lab.a,'new.bin'),Buffer.from([0,255,1,128]));
  let saved;
  run('exact claimed binary postimages survive canonical reset, without publication authority',()=>{
    saved=capture();saved.assertCurrent();
    const bytes=fs.readFileSync(request.resultFile+'.partial-patch.json'),data=JSON.parse(bytes);
    assert.equal(saved.reference.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(data.files.length,2);assert(!data.files.some(row=>row.path==='prior.txt'));
    assert.equal(Buffer.from(data.files.find(row=>row.path==='same.txt').content_base64,'base64').toString(),'authored bytes\n');
    assert.deepEqual(Buffer.from(data.files.find(row=>row.path==='new.bin').content_base64,'base64'),Buffer.from([0,255,1,128]));
    assert(!JSON.stringify(saved.reference).includes('authored'));
    assert.throws(capture,/EEXIST/,'exclusive evidence cannot be replaced');
    const result=reset.resetFailedAttempt(stateFile,{mode:'execute',failed:true,repoRoots:[lab.a],codeDir:lab.a});
    assert.equal(result.ok,true);assert.equal(fs.readFileSync(path.join(lab.a,'same.txt'),'utf8'),'before\n');
    assert(!fs.existsSync(path.join(lab.a,'new.bin')));assert.equal(fs.readFileSync(path.join(lab.a,'prior.txt'),'utf8'),'prior\n');
    assert.deepEqual(fs.readFileSync(request.resultFile+'.partial-patch.json'),bytes);
    assert.throws(saved.assertCurrent,/archive-unavailable/,'archive is not a capability for a different tree');
  });
  function negative(name,change,restore){run(name,()=>{change();try{assert.throws(capture);assert(fs.existsSync(path.join(lab.a,'same.txt')));}finally{restore();}});}
  request.resultFile=path.join(lab.dir,'negative.json');
  negative('outside-claim change blocks reset eligibility',()=>fs.writeFileSync(path.join(lab.a,'outside.txt'),'outside'),()=>fs.unlinkSync(path.join(lab.a,'outside.txt')));
  negative('preexisting overlap blocks archive/reset',()=>fs.writeFileSync(path.join(lab.a,'prior.txt'),'changed'),()=>fs.writeFileSync(path.join(lab.a,'prior.txt'),'prior\n'));
  negative('oversized changed claim refuses without partial archive',()=>fs.writeFileSync(path.join(lab.a,'new.bin'),Buffer.alloc(archive.MAX_FILE+1)),()=>fs.unlinkSync(path.join(lab.a,'new.bin')));
  negative('possible writer refuses',()=>{input.assertStopped=()=>false;},()=>{input.assertStopped=()=>true;});
  negative('multiroot refuses without claiming preservation',()=>state.repoRoots.push(lab.b),()=>state.repoRoots.pop());
  negative('junction claims refuse without reading linked content',()=>fs.symlinkSync(lab.b,path.join(lab.a,'new.bin'),process.platform==='win32'?'junction':'dir'),()=>fs.unlinkSync(path.join(lab.a,'new.bin')));
  negative('claim count is bounded before capture',()=>{state.brief.claim_paths=Array.from({length:65},(_,i)=>'file'+i);},()=>{state.brief.claim_paths=['same.txt','new.bin'];});
  run('deletions retained explicitly and late file drift refuses reset',()=>{
    fs.unlinkSync(path.join(lab.a,'same.txt'));const deletion=capture();
    const data=JSON.parse(fs.readFileSync(request.resultFile+'.partial-patch.json'));
    assert.deepEqual(data.files,[{path:'same.txt',deleted:true}]);
    fs.writeFileSync(path.join(lab.a,'same.txt'),'late writer\n');
    assert.throws(deletion.assertCurrent,/archive-unavailable/);
  });
  run('physical CRLF bytes are preserved and normalization cannot hide later drift',()=>{
    fixtures.command('git',['config','core.autocrlf','true'],lab.a);
    request.resultFile=path.join(lab.dir,'crlf.json');
    fs.writeFileSync(path.join(lab.a,'same.txt'),'authored\r\n');
    const saved=capture(),data=JSON.parse(fs.readFileSync(request.resultFile+'.partial-patch.json'));
    assert.equal(Buffer.from(data.files[0].content_base64,'base64').toString(),'authored\r\n');
    fs.writeFileSync(path.join(lab.a,'same.txt'),'authored\n');
    assert.throws(saved.assertCurrent,/archive-unavailable/);
  });
  run('changed caller junction cannot redirect the retained physical destination',()=>{
    const destination=path.join(lab.dir,'evidence'),alias=path.join(lab.dir,'alias');
    fs.mkdirSync(destination);fs.symlinkSync(destination,alias,process.platform==='win32'?'junction':'dir');
    request.resultFile=path.join(alias,'alias.json');let calls=0;
    input.assertStopped=()=>{if(++calls===2){fs.unlinkSync(alias);fs.symlinkSync(lab.a,alias,process.platform==='win32'?'junction':'dir');}return true;};
    try{const saved=capture();assert.equal(saved.reference.complete,true);
      assert(fs.existsSync(path.join(destination,'alias.json.partial-patch.json')));
      assert(!fs.existsSync(path.join(lab.a,'alias.json.partial-patch.json')));
    }finally{input.assertStopped=()=>true;fs.unlinkSync(alias);}
  });
  run('replacement of the physical destination parent refuses before writing',()=>{
    const destination=path.join(lab.dir,'replace'),moved=path.join(lab.dir,'replaced');
    fs.mkdirSync(destination);request.resultFile=path.join(destination,'replace.json');let calls=0;
    input.assertStopped=()=>{if(++calls===2){fs.renameSync(destination,moved);fs.symlinkSync(lab.a,destination,process.platform==='win32'?'junction':'dir');}return true;};
    try{assert.throws(capture,/archive-unavailable/);
      assert(!fs.existsSync(path.join(lab.a,'replace.json.partial-patch.json')));
      assert(!fs.existsSync(path.join(moved,'replace.json.partial-patch.json')));
    }finally{input.assertStopped=()=>true;fs.unlinkSync(destination);}
  });
  console.log(count+' archive checks passed; no auto-apply/provider/network');
}finally{lab.cleanup();}
