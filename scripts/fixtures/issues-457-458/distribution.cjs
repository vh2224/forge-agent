'use strict';
// One additive measured layer; published predecessor fixtures stay immutable.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issue-455/distribution.cjs'),data=require('./distribution-delta.json'),ROOT=path.resolve(__dirname,'../../..'),PIN='effd2c840168e948e5f2a3eca83ddea1f4e244ed36c3ff7e36eb4efb69dba592';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=file=>fs.readFileSync(path.join(ROOT,file));
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
 return Object.freeze(wrapped);
}
const historicalViews=Object.fromEntries(Object.entries(previous).filter(([key,value])=>key.endsWith('View')&&value&&typeof value==='object').map(([key,value])=>[key,historicalView(value)]));
const issue440View=historicalViews.issue440View,issue455View=historicalView(previous);
// Only the exact current smoke source is rewound. Baseline/foreign text is
// delegated unchanged, preserving the predecessor's existing input contract.
function smokeProjection(method,text){check();const row=data.files['scripts/forge-smoke.js'];assert(row&&row.before!==null,'issues457458 measured smoke predecessor required');return previous[method](hash(text)===row.after?preimage(row).toString('utf8'):text);}
function previousSmoke(text){return smokeProjection('previousSmoke',text);}
function predecessorSmoke(text){return smokeProjection('predecessorSmoke',text);}
module.exports={...previous,...historicalViews,projectArtifacts,projectGolden,validate,validate414Snapshot,after,projectRead,verifyCurrent,issue440View,issue455View,previousSmoke,predecessorSmoke,issues457458Layer:data};
