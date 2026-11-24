'use strict';
// Test-only successor. Published fixtures and production modules stay unchanged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../../..'),OWN='scripts/fixtures/docs-cleanup',data=require('./distribution-delta.json');
const PIN='ea37ef4c2c5c319b442a2e3ee3828e3778264d9d5b812dd8bb71c280bd6ee799',hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const previous=require('../issues-457-458/distribution.cjs');
function target(file,absent=false){
 assert(typeof file==='string'&&!path.isAbsolute(file)&&!/[\\:\x00-\x1f]/.test(file));
 const parts=file.split('/');assert(parts.every(p=>p&&p!=='.'&&p!=='..'));
 let at=ROOT;
 for(let i=0;i<parts.length;i++){
  at=path.join(at,parts[i]);let s;
  try{s=fs.lstatSync(at);}catch(e){if(absent&&i===parts.length-1&&e.code==='ENOENT')return null;throw e;}
  assert(!s.isSymbolicLink(),'docs cleanup physical path');
  assert(i===parts.length-1?s.isFile()&&s.nlink===1:s.isDirectory(),'docs cleanup regular source');
 }
 assert.equal(fs.realpathSync.native(at).toLowerCase(),path.resolve(at).toLowerCase(),'docs cleanup literal path');return at;
}
function read(file){
 const name=target(file),fd=fs.openSync(name,'r');
 try{const a=fs.fstatSync(fd);assert(a.size<=8*1024*1024);const b=Buffer.alloc(a.size+1);let n=0;
  while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}
  const end=fs.fstatSync(fd),last=fs.lstatSync(name);assert.equal(n,a.size);
  for(const key of ['dev','ino','size','mtimeMs','ctimeMs']){assert.equal(end[key],a[key]);assert.equal(last[key],a[key]);}
  assert.equal(target(file),name);return b.subarray(0,n);
 }finally{fs.closeSync(fd);}
}
function check(value=data){
 assert.equal(hash(JSON.stringify(value)),PIN,'docs cleanup independently pinned metadata');
 assert.equal(read(OWN+'/distribution-delta.json').toString('utf8'),JSON.stringify(data,null,2)+'\n','docs cleanup exact metadata file');
 return value;
}
function before(row,bytes){
 let old;
 if(row.before_gzip_base64!==null)old=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:8*1024*1024});
 else{let text=bytes.toString('utf8');for(const edit of [...row.edits].reverse()){assert.equal(text.split(edit.after).length-1,edit.count);text=text.split(edit.after).join(edit.before);}old=Buffer.from(text);}
 assert.equal(hash(old),row.before,'docs cleanup exact historical bytes');return old;
}
function projectCleanupRead(readRaw=read,value=data){
 value=check(value);
 return file=>{
  const row=value.files[file];
  if(row&&row.after===null){
   assert.equal(target(file,true),null,'retired document must be absent');
   let b;try{b=readRaw(file);}catch(e){if(e.code!=='ENOENT')throw e;return before(row);}
   // A supplied historical view may already contain the authenticated predecessor.
   assert.equal(hash(b),row.before,'retired document foreign reader');return b;
  }
  const b=readRaw(file);return row&&row.before!==null&&hash(b)===row.after?before(row,b):b;
 };
}
function verifyCleanup(options={}){
 const value=check(options.docsCleanupLayerValue||data);
 for(const[file,row]of Object.entries(value.files)){
  if(row.after===null)assert.equal(target(file,true),null,'docs cleanup retired document reappeared');
  else assert.equal(hash(read(file)),row.after,'docs cleanup current source '+file);
 }
 for(const[file,row]of Object.entries(value.historical_fixtures)){const b=read(file);assert.equal(hash(b),row.sha256,'docs cleanup immutable published fixture '+file);assert.equal(b.length,row.bytes);}
 assert.deepEqual(fs.readdirSync(__dirname).sort(),['README.md','distribution-delta.json','distribution.cjs','proposal.md'],'docs cleanup complete own folder');
 const found=[];
 function walk(dir){for(const e of fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true})){const f=dir+'/'+e.name;if(f===OWN)continue;assert(!e.isSymbolicLink());if(e.isDirectory())walk(f);else{assert(e.isFile());found.push(f);}}}
 walk('scripts/fixtures');assert.deepEqual(found.sort(),Object.keys(value.historical_fixtures).sort(),'docs cleanup complete published inventory');return true;
}
// Current physical inputs are authenticated here. Virtual negative callbacks remain
// authoritative inputs of the unchanged predecessor validator, including its cause.
function delegate(object,method,implementation,options={}){
 verifyCleanup(options);
 return implementation.call(object,{...options,readRaw:projectCleanupRead(options.readRaw||read)});
}
const views=new WeakMap(),implementations=new WeakMap();
function invoke(object,key,implementation,args,current){
 if(['validate','validate414Snapshot','verifyCurrent'].includes(key))return delegate(object,key,implementation,args[0]);
 if(key==='projectRead')return implementation.call(object,projectCleanupRead(args[0]===undefined?read:args[0]),...args.slice(1));
 if(key==='loadHistoricalFixture')return view(implementation.call(object,...args));
 if(current&&key==='after'){
  const value=check(),[kind,file,prior,attr=false]=args,old=implementation.call(object,...args),row=kind==='files'?value.files[file]:null;
  if(!row||row.before===null||row.after===null)return old;
  assert.equal(old,row[attr?'attributed_before':'before'],'docs cleanup exact predecessor source '+file);
  return row[attr?'attributed_after':'after'];
 }
 if(current&&key==='readme'){
  check();const row=data.files[OWN+'/README.md'],bytes=read(OWN+'/README.md');
  assert(row&&row.before===null,'docs cleanup own measured README');assert.equal(hash(bytes),row.after,'docs cleanup exact current README');
  assert.equal(hash(bytes.toString('utf8').replace(/^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm,'')),row.attributed_after,'docs cleanup attributed README');
  const old=implementation.call(object,...args),rows=Object.entries(data.files).map(([file,r])=>[file,r.before,r.after,r.attributed_before,r.attributed_after].filter(x=>x!==null&&x!==undefined).join(' | '));
  return old+'\n'+bytes.toString('utf8')+'\n'+rows.join('\n')+'\n';
 }
 return implementation.apply(object,args);
}
function view(object,current=false){
 if(!object||typeof object!=='object')return object;
 if(!current&&views.has(object))return views.get(object);
 const result={};if(!current)views.set(object,result);
 for(const[key,value]of Object.entries(object)){
  if(key.endsWith('View')&&value&&typeof value==='object'){result[key]=view(value);continue;}
  if(typeof value!=='function'){result[key]=value;continue;}
  const transformed=['validate','validate414Snapshot','verifyCurrent','projectRead','loadHistoricalFixture'].includes(key)||(current&&['after','readme'].includes(key));
  // Current exports have normal local assignment semantics; saved wrappers never
  // become an implementation in the predecessor. Its live functions are read on call.
  if(current&&transformed){result[key]=(...args)=>invoke(object,key,object[key],args,true);continue;}
  let last,wrapped;const descriptor=Object.getOwnPropertyDescriptor(object,key);
  Object.defineProperty(result,key,{enumerable:true,configurable:true,get(){
   const implementation=object[key];if(!transformed)return implementation;
   if(last!==implementation){last=implementation;wrapped=(...args)=>invoke(object,key,implementation,args,false);implementations.set(wrapped,implementation);}
   return wrapped;
  },...(descriptor.writable||descriptor.set?{set:fn=>{object[key]=implementations.get(fn)||fn;}}:{})});
 }
 return result;
}
const api=view(previous,true);
Object.assign(api,{docsCleanupLayer:data,verifyCleanup,projectCleanupRead,baselineView:view(previous)});
module.exports=api;
