'use strict';
// Test-only successor. Published fixtures and production modules stay unchanged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../../..'),OWN='scripts/fixtures/docs-cleanup',data=require('./distribution-delta.json');
const PIN='a48eedd1eb9f8b7de9df5835c932f0e0eba23f7bc10ae87c6cf48d2bda320932',hash=b=>crypto.createHash('sha256').update(b).digest('hex');
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
// Legacy read callbacks may intentionally expose an exact earlier measured world.
// This is not current-state authority: verifyCleanup independently checks real bytes first.
const knownHistorical=new Map();
for(const value of Object.values(previous))if(value&&typeof value==='object'&&value.files)for(const[f,row]of Object.entries(value.files)){
 if(!row||typeof row!=='object')continue;const set=knownHistorical.get(f)||new Set();for(const h of [row.before,row.after])if(typeof h==='string')set.add(h);knownHistorical.set(f,set);
}
function checkReader(readRaw){
 if(!readRaw)return;
 for(const[file,row]of Object.entries(data.files)){
  let b;try{b=readRaw(file);}catch(e){if(row.after===null&&e.code==='ENOENT'&&target(file,true)===null)continue;throw e;}
  const h=hash(b);assert(h===row.after||h===row.before||knownHistorical.get(file)?.has(h),'docs cleanup foreign source reader '+file);
 }
 for(const[file,row]of Object.entries(data.historical_fixtures))assert.equal(hash(readRaw(file)),row.sha256,'docs cleanup immutable published fixture '+file);
}
function delegate(object,method,options={}){
 verifyCleanup(options);checkReader(options.readRaw);
 return object[method]({...options,readRaw:projectCleanupRead(options.readRaw||read)});
}
const views=new WeakMap();
function view(object){
 if(!object||typeof object!=='object')return object;if(views.has(object))return views.get(object);
 const result={...object};views.set(object,result);
 for(const[key,value]of Object.entries(object))if(key.endsWith('View')&&value&&typeof value==='object')result[key]=view(value);
 for(const method of ['validate','validate414Snapshot','verifyCurrent'])if(typeof object[method]==='function')result[method]=options=>delegate(object,method,options);
 if(typeof object.projectRead==='function')result.projectRead=(readRaw=read)=>object.projectRead(projectCleanupRead(readRaw));
 if(typeof object.loadHistoricalFixture==='function')result.loadHistoricalFixture=file=>view(object.loadHistoricalFixture(file));
 // Preserve existing readme call-count observations through the same private predecessor.
 if(typeof object.readme==='function')Object.defineProperty(result,'readme',{enumerable:true,configurable:true,get:()=>object.readme,set:fn=>{object.readme=fn;}});
 return result;
}
const api=view(previous);
Object.assign(api,{docsCleanupLayer:data,verifyCleanup,projectCleanupRead});
module.exports=api;
