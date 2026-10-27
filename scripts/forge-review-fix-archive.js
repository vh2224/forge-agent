'use strict';
// Local evidence only: no automatic restoration, delivery or replay authority.
// Unsupported/incomplete capture must prevent the caller's destructive reset.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const reset=require('./forge-surgical-reset'),roots=require('./forge-code-roots');
const review=require('./forge-review-fix');
const MAX_FILE=1024*1024,MAX_TOTAL=4*MAX_FILE,MAX_ENCODED=6*MAX_FILE;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw Object.assign(new Error('review-fix-archive-unavailable'),{code:'review-fix-archive-unavailable'});};
function preservePartialPatch({request,state,fingerprint,assertStopped}={}){
  if(typeof assertStopped!=='function'||assertStopped()!==true)fail();
  if(!state||state.repoRoots?.length!==1||!Array.isArray(state.brief?.claim_paths)
    ||state.brief.claim_paths.length>64||!/^[a-f0-9]{64}$/.test(fingerprint||''))fail();
  const cwd=fs.realpathSync(state.cwd),owner=fs.realpathSync(request.contextRoot||request.cwd);
  const xllm=require('./forge-xllm');
  const target=xllm.validateResultFileTarget(request.resultFile+'.partial-patch.json',cwd);
  xllm.validateResultFileTarget(target,owner);
  // Retain the physical destination, never reuse the caller's junction alias.
  const parents=[];
  for(let dir=path.dirname(target);;dir=path.dirname(dir)){
    const stat=fs.lstatSync(dir,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink())fail();
    parents.push({dir,ino:stat.ino,dev:stat.dev});
    if(path.dirname(dir)===dir)break;
  }
  const assertDestination=()=>{
    for(const parent of parents){
      const stat=fs.lstatSync(parent.dir,{bigint:true});
      if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==parent.ino||stat.dev!==parent.dev)fail();
    }
    if(xllm.validateResultFileTarget(target,cwd)!==target
      ||xllm.validateResultFileTarget(target,owner)!==target)fail();
  };
  const baselineBytes=fs.readFileSync(state.stateFile),baseline=JSON.parse(baselineBytes);
  if(baseline.vcs!=='git'||baseline.repos||baseline.attempt!==request.dispatchId
    ||roots.key(baseline.code_dir)!==roots.key(cwd)||!Array.isArray(baseline.pre_dirty))fail();
  const snapshot=reset.captureAttemptSnapshot(cwd);
  if(snapshot.vcs!=='git'||snapshot.start_sha!==baseline.start_sha)fail();
  const original=new Map(baseline.pre_dirty.map(row=>[row.path,row.hash]));
  const current=new Map(snapshot.pre_dirty.map(row=>[row.path,row.hash]));
  // Preexisting dirt changing or disappearing cannot be attributed to this turn.
  for(const [file,digest] of original)if(!current.has(file)||current.get(file)!==digest)fail();
  const changed=snapshot.pre_dirty.filter(row=>!original.has(row.path));
  if(changed.length>64)fail();
  const claim=new Set(state.brief.claim_paths);
  let total=0;
  const files=changed.map(row=>{
    if(!claim.has(row.path)||review.normalizeRelativePath(row.path)!==row.path)fail();
    review.assertClaimTargetsPhysical(cwd,[row.path]);
    const file=path.join(cwd,row.path);
    let before;
    try{before=fs.lstatSync(file,{bigint:true});}catch(error){
      if(error.code!=='ENOENT'||row.hash!==null)fail();
      return {path:row.path,deleted:true};
    }
    if(!before.isFile()||before.isSymbolicLink()||before.size>MAX_FILE)fail();
    let fd;
    try{
      fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      const opened=fs.fstatSync(fd,{bigint:true});
      if(!opened.isFile()||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeNs!==before.mtimeNs
        ||(opened.dev!==before.dev&&!(process.platform==='win32'&&before.dev===0n&&opened.dev>0n)))fail();
      const bytes=Buffer.alloc(Number(opened.size));let offset=0;
      while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)fail();offset+=n;}
      const after=fs.fstatSync(fd,{bigint:true});
      if(after.size!==opened.size||after.mtimeNs!==opened.mtimeNs)fail();
      // Git may normalize CRLF through attributes; retain physical bytes while
      // checking the same VCS identity convention used by the reset snapshot.
      if(reset.hashObject(cwd,row.path)!==row.hash)fail();
      total+=bytes.length;if(total>MAX_TOTAL)fail();
      return {path:row.path,deleted:false,mode:Number(opened.mode)&0o777,sha256:hash(bytes),bytes:bytes.length,content_base64:bytes.toString('base64')};
    }finally{if(fd!==undefined)fs.closeSync(fd);}
  });
  const envelope={schema_version:1,dispatch_id:request.dispatchId,request_fingerprint:fingerprint,
    baseline_sha256:hash(baselineBytes),start_sha:baseline.start_sha,postimage_sha256:roots.digest(snapshot),
    trust:'local-unverified-postimages; no replay authority',files};
  const bytes=Buffer.from(JSON.stringify(envelope));if(bytes.length>MAX_ENCODED)fail();
  const assertCurrent=()=>{
    if(assertStopped()!==true||hash(fs.readFileSync(state.stateFile))!==envelope.baseline_sha256
      ||roots.digest(reset.captureAttemptSnapshot(cwd))!==envelope.postimage_sha256)fail();
    for(const row of files){
      review.assertClaimTargetsPhysical(cwd,[row.path]);
      const file=path.join(cwd,row.path);
      if(row.deleted){if(fs.existsSync(file))fail();continue;}
      const before=fs.lstatSync(file,{bigint:true});
      if(!before.isFile()||before.isSymbolicLink()||before.size!==BigInt(row.bytes))fail();
      let fd;
      try{
        fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
        const opened=fs.fstatSync(fd,{bigint:true});
        if(!opened.isFile()||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeNs!==before.mtimeNs
          ||(opened.dev!==before.dev&&!(process.platform==='win32'&&before.dev===0n&&opened.dev>0n)))fail();
        const bytes=Buffer.alloc(row.bytes+1);let size=0,n;
        do{n=fs.readSync(fd,bytes,size,bytes.length-size,null);size+=n;}while(n&&size<bytes.length);
        if(size!==row.bytes||hash(bytes.subarray(0,size))!==row.sha256)fail();
      }finally{if(fd!==undefined)fs.closeSync(fd);}
    }
  };
  assertCurrent();
  assertDestination();
  fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  // A capture changing before reset is retained as evidence but never enables it.
  const assertArchived=()=>{assertCurrent();assertDestination();
    const stat=fs.lstatSync(target,{bigint:true});
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==BigInt(bytes.length))fail();
    let fd;
    try{
      fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      const opened=fs.fstatSync(fd,{bigint:true});
      if(!opened.isFile()||opened.ino!==stat.ino||opened.size!==stat.size
        ||(opened.dev!==stat.dev&&!(process.platform==='win32'&&stat.dev===0n&&opened.dev>0n)))fail();
      const read=Buffer.alloc(bytes.length+1);let size=0,n;
      do{n=fs.readSync(fd,read,size,read.length-size,null);size+=n;}while(n&&size<read.length);
      if(size!==bytes.length||hash(read.subarray(0,size))!==hash(bytes))fail();
      assertDestination();
    }finally{if(fd!==undefined)fs.closeSync(fd);}
  };
  assertArchived();
  return {reference:{schema_version:1,channel:'resultFile.partial-patch.json',sha256:hash(bytes),bytes:bytes.length,
    files:files.length,complete:true,status:'preserved'},assertCurrent:assertArchived};
}
module.exports={preservePartialPatch,MAX_FILE,MAX_TOTAL,MAX_ENCODED};
