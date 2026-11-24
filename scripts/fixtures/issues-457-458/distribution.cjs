'use strict';
// One additive measured layer; published predecessor fixtures stay immutable.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const data=require('./distribution-delta.json'),ROOT=path.resolve(__dirname,'../../..'),PIN='2b3e492783316059aac6946ef69d0324badf90cffce123febb64891227b5467a';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=file=>fs.readFileSync(path.join(ROOT,file));
// Private authenticated historical graph. No writes to Node require.cache or
// Module._cache; the real current guard and its audit closure stay unchanged.
function createHistoricalLoader(){
 const Module=require('module'),vm=require('vm');
 const stable=require(path.join(ROOT,'scripts/forge-autonomy-sources.js')).readBoundedStableFile;
 const actualGuard=require(path.join(ROOT,'scripts/forge-dispatch-source-guard.js'));
 const modules=Object.create(null),guardFile=path.join(ROOT,'scripts/forge-dispatch-source-guard.js');
 const physicalKey=file=>path.resolve(file).replace(/\\/g,'/').toLowerCase();
 const builtins=new Set(['fs','path','crypto','zlib','assert/strict','node:assert/strict','vm','os','child_process']);
 function metadata(){assert.equal(hash(JSON.stringify(data)),PIN,'issues457458 independent measured delta');return data;}
 function historicalGuard(){
  const record=metadata().registry;
  assert.equal(hash(JSON.stringify(record.before_rows)),record.before_sha256,'issues457458 exact loader BASE registry');
  assert.equal(hash(JSON.stringify(record.after_rows)),record.after_sha256,'issues457458 exact loader current registry');
  const rows=hash(JSON.stringify(actualGuard.SOURCE_REGISTRY))===record.after_sha256?structuredClone(record.before_rows):structuredClone(actualGuard.SOURCE_REGISTRY);
  return Object.freeze({...actualGuard,SOURCE_REGISTRY:actualGuard.deepFreeze(rows)});
 }
 function source(file){
  const relative=path.relative(ROOT,file).replace(/\\/g,'/');
  assert(relative.startsWith('scripts/fixtures/')&&!relative.split('/').some(part=>!part||part==='.'||part==='..'),'historical fixture path only');
  const row=metadata().historical_fixtures[relative];assert(row&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=4*1024*1024,'independently pinned historical fixture');
  const real=fs.realpathSync.native(file),stat=fs.lstatSync(file);assert.equal(physicalKey(real),physicalKey(file),'physical historical fixture');
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size===row.bytes,'regular exact historical fixture');
  const result=stable(file,row.bytes,{expectedReal:real});assert(!result.error&&result.stat.nlink===1,'bounded stable historical fixture');
  assert.equal(hash(result.buffer),row.sha256,'immutable historical fixture bytes');assert.equal(result.buffer.length,row.bytes);
  return result.buffer;
 }
 function requiredFrom(file,parent){
  source(file);const native=Module.createRequire(file);
  function scoped(id){
   assert(typeof id==='string','literal historical module request');metadata();
   if(id==='module'||id==='node:module')return Object.freeze({createRequire:filename=>{
    assert(typeof filename==='string'&&path.isAbsolute(filename)&&filename.endsWith('.cjs'),'historical createRequire context');source(filename);return requiredFrom(filename,modules[filename]||parent);
   }});
   if(builtins.has(id))return require(id);
   const resolved=native.resolve(id);
   if(physicalKey(resolved)===physicalKey(guardFile))return historicalGuard();
   assert(resolved.endsWith('.cjs')||resolved.endsWith('.json'),'historical module extension');
   return load(resolved,parent);
  }
  scoped.resolve=id=>{const resolved=native.resolve(id);if(physicalKey(resolved)!==physicalKey(guardFile))source(resolved);return resolved;};
  scoped.cache=modules;return scoped;
 }
 function load(file,parent){
  assert(path.isAbsolute(file));const bytes=source(file);
  if(modules[file]){if(parent&&!parent.children.includes(modules[file]))parent.children.push(modules[file]);return modules[file].exports;}
  const item=new Module(file,parent);item.filename=file;item.paths=Module._nodeModulePaths(path.dirname(file));modules[file]=item;
  try{
   if(file.endsWith('.json'))item.exports=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
   else{assert(file.endsWith('.cjs'),'historical CJS only');const text=bytes.toString('utf8').replace(/^\uFEFF/,'').replace(/^#![^\r\n]*/,'');
    const execute=vm.runInThisContext(Module.wrap(text),{filename:file});execute.call(item.exports,item.exports,requiredFrom(file,item),item,file,path.dirname(file));
   }
   item.loaded=true;return item.exports;
  }catch(error){delete modules[file];throw error;}
 }
 return file=>{assert(typeof file==='string'&&/^scripts\/fixtures\/[a-z0-9/-]+\.cjs$/.test(file),'closed historical CJS API');return load(path.join(ROOT,file));};
}
const loadHistoricalFixture=createHistoricalLoader();
const previous=loadHistoricalFixture('scripts/fixtures/issue-455/distribution.cjs');

const linked=/^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm,attributed=b=>hash(b.toString('utf8').replace(linked,''));
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'issues457458 independent measured delta');assert.equal(hash(JSON.stringify(previous.issue455Layer)),value.predecessor_layer_sha256,'issues457458 immutable predecessor');return value;}
function preimage(row){const b=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(b),row.before,'issues457458 exact preimage');assert.equal(attributed(b),row.attributed_before,'issues457458 attributed preimage');return b;}
function projectRead(readRaw=read,value=check()){return file=>{const b=readRaw(file),r=value.files[file];return r&&r.before!==null&&hash(b)===r.after?preimage(r):b;};}
// Both-host preimages use published dynamic-version normalization.
// Unknown/baseline artifact content passes unchanged to the predecessor.
const normalizeRendered=value=>String(value).replace(/version=\d+\.\d+\.\d+/g,'version=<dynamic>');
function renderedHost(item){return typeof item.kind==='string'?'codex':Object.hasOwn(item,'bytes')&&Object.hasOwn(item,'origin')?'claude':null;}
function projectArtifacts(artifacts,value=data){
 value=check(value);
 if(!Array.isArray(artifacts))return artifacts;
 return artifacts.flatMap(item=>{if(!item||typeof item!=='object'||typeof item.source_id!=='string'||typeof item.source!=='string'||typeof item.content!=='string')return[item];
  const host=renderedHost(item),r=value.rendered[host+'::'+item.source_id+'::'+item.source];
  if(!r||(item.kind??null)!==r.kind||item.newline!==r.newline||hash(normalizeRendered(item.content))!==r.after)return[item];
  if(r.before===null)return[];
  const bytes=preimage(r),content=bytes.toString('utf8');assert.equal(bytes.length,r.before_bytes,'issues457458 exact rendered predecessor size');
  return[{...item,content,...(Object.hasOwn(item,'bytes')?{bytes:bytes.length}:{})}];
 });
}
function projectGolden(golden){const value=check(),old=previous.projectGolden(golden);return{...old,surfaces:old.surfaces.map(row=>{
 const pin=value.surfaces.claude[row.source_id];if(!pin)return row;assert.equal(row.sha256,pin.before,'issues457458 exact Claude golden predecessor '+row.source_id);return{...row,sha256:pin.after};
})};}
function readme(old){
 const value=check(),file='scripts/fixtures/issues-457-458/README.md',row=value.files[file],bytes=read(file);
 assert(row&&row.before===null,'issues457458 own measured README');assert.equal(hash(bytes),row.after,'issues457458 exact current README');assert.equal(attributed(bytes),row.attributed_after,'issues457458 attributed README');
 return previous.readme(old)+'\n'+bytes.toString('utf8');
}
function measuredFiles(){
 const value=check(),added=[...new Set(Object.values(value.rendered).filter(row=>row.host==='claude'&&!previous.files.includes(row.source)).map(row=>row.source))];
 assert.deepEqual([...added].sort(),['agents/forge-executor.md','shared/templates/dispatch/complete-slice.md','shared/templates/dispatch/execute-task.md'],'issues457458 exact additional measured Claude members');
 return [...previous.files,...added];
}
// Only the whole measured current array rewinds. Unknown/baseline inputs are
// delegated untouched; no candidate filter, identity alias or synthetic audit.
function projectRegistry(rows,value=data){
 const record=check(value).registry;
 assert.equal(hash(JSON.stringify(record.before_rows)),record.before_sha256,'issues457458 exact registry predecessor');
 assert.equal(hash(JSON.stringify(record.after_rows)),record.after_sha256,'issues457458 exact registry current');
 return hash(JSON.stringify(rows))===record.after_sha256?structuredClone(record.before_rows):rows;
}
function previousRegistry(rows,...rest){return previous.previousRegistry(projectRegistry(rows),...rest);}
function verifyCurrent(options={}){const value=check(options.issues457458LayerValue||data),readRaw=options.readRaw||read;for(const[file,r]of Object.entries(value.files)){const b=readRaw(file);assert.equal(hash(b),r.after,'issues457458 measured current source '+file);assert.equal(attributed(b),r.attributed_after,'issues457458 attributed current source '+file);}for(const[file,r]of Object.entries(value.historical_fixtures)){const b=readRaw(file);assert.equal(hash(b),r.sha256,'issues457458 immutable published fixture '+file);assert.equal(b.length,r.bytes);}return true;}
function validateWith(method,options={}){const value=check(options.issues457458LayerValue||data),readRaw=options.readRaw||read,result=previous[method]({...options,artifacts:projectArtifacts(options.artifacts,value),readRaw:projectRead(readRaw,value)});verifyCurrent({...options,readRaw});return result;}
function validate(options){return validateWith('validate',options);}
function validate414Snapshot(options){return validateWith('validate414Snapshot',options);}
function after(kind,file,prior,attr=false){const value=check(),old=previous.after(kind,file,prior,attr),r=kind==='surfaces'?value.surfaces.claude[file]:kind==='files'?value.files[file]:null;if(!r||r.before===null)return old;assert.equal(old,r[attr?'attributed_before':'before'],'issues457458 exact predecessor source '+file);return r[attr?'attributed_after':'after'];}
// Historical views project this layer once, including every nested old view.
function viewMethod(object,method,options={}){check();return object[method]({...options,artifacts:projectArtifacts(options.artifacts),readRaw:projectRead(options.readRaw||read)});}
function historicalView(object){
 const wrapped={...object};
 for(const[key,value]of Object.entries(object))if(key.endsWith('View')&&value&&typeof value==='object')wrapped[key]=historicalView(value);
 for(const method of ['validate','validate414Snapshot','verifyCurrent'])if(typeof object[method]==='function')wrapped[method]=options=>viewMethod(object,method,options);
 if(typeof object.projectRead==='function')wrapped.projectRead=(readRaw=read)=>object.projectRead(projectRead(readRaw));
 if(typeof object.previousRegistry==='function')wrapped.previousRegistry=(rows,...rest)=>object.previousRegistry(projectRegistry(rows),...rest);
 return Object.freeze(wrapped);
}
const historicalViews=Object.fromEntries(Object.entries(previous).filter(([key,value])=>key.endsWith('View')&&value&&typeof value==='object').map(([key,value])=>[key,historicalView(value)]));
const issue440View=historicalViews.issue440View,issue455View=historicalView(previous);
// Only the exact current smoke source is rewound. Baseline/foreign text is
// delegated unchanged, preserving the predecessor's existing input contract.
function smokeProjection(method,text){check();const row=data.files['scripts/forge-smoke.js'];assert(row&&row.before!==null,'issues457458 measured smoke predecessor required');return previous[method](hash(text)===row.after?preimage(row).toString('utf8'):text);}
function previousSmoke(text){return smokeProjection('previousSmoke',text);}
function predecessorSmoke(text){return smokeProjection('predecessorSmoke',text);}
module.exports={...previous,...historicalViews,projectArtifacts,projectGolden,projectRegistry,previousRegistry,loadHistoricalFixture,readme,files:measuredFiles(),validate,validate414Snapshot,after,projectRead,verifyCurrent,issue440View,issue455View,previousSmoke,predecessorSmoke,issues457458Layer:data};
