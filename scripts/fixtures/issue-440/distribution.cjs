'use strict';
// Additive measurement only; published predecessors remain byte-identical.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issue-448/distribution.cjs'),data=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),PIN='911f6ba41572da7a28a1c914d8db12ee0861c2bc2a6a4aea6fcdf8112191f7d7';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),read=file=>fs.readFileSync(path.join(ROOT,file));
const normalize=value=>String(value).replace(/version=\d+\.\d+\.\d+/g,'version=<dynamic>');
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'issue440 independent measured delta');assert.equal(hash(JSON.stringify(previous.issue448Layer)),value.predecessor_layer_sha256,'issue440 immutable predecessor');return value;}
function before(row){const bytes=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(bytes),row.before,'issue440 exact predecessor bytes');return bytes;}
function project(value,readRaw){return file=>{const actual=readRaw(file),row=value.files[file];return row&&row.before!==null&&hash(actual)===row.after?before(row):actual;};}
function artifactsBefore(value,artifacts){return artifacts.flatMap(item=>{const row=value.rendered[item.source_id+'::'+item.source];if(!row)return[item];assert.equal(hash(normalize(item.content)),row.after,'issue440 measured rendered source '+item.source);if(row.before===null)return[];const content=before(row).toString('utf8');return[{...item,content,...(Object.hasOwn(item,'bytes')?{bytes:Buffer.byteLength(content)}:{})}];});}
function census(value,readRaw){
 for(const[file,row]of Object.entries(value.files))assert.equal(hash(readRaw(file)),row.after,'issue440 measured current source '+file);
 const readProjected=project(value,readRaw);
 for(const[file,row]of Object.entries(value.historical_fixtures)){const bytes=readProjected(file);assert.equal(hash(bytes),row.sha256,'issue440 immutable historical fixture '+file);assert.equal(bytes.length,row.bytes,'issue440 historical fixture size '+file);}
}
function validateWith(method,options){const value=check(options.issue440LayerValue||data),readRaw=options.readRaw||read;const valid=previous[method]({...options,artifacts:artifactsBefore(value,options.artifacts),readRaw:project(value,readRaw)});census(value,readRaw);return valid;}
function validate(options){return validateWith('validate',options);}
function validate414Snapshot(options){return validateWith('validate414Snapshot',options);}
function after(kind,file,prior,attr=false){const value=check(),old=previous.after(kind,file,prior,attr),row=kind==='surfaces'?value.surfaces[file]:kind==='files'?value.files[file]:null;if(!row||row.before===null)return old;assert.equal(old,row[attr?'attributed_before':'before'],'issue440 exact prior source '+file);return row[attr?'attributed_after':'after'];}
function projectGolden(golden){const value=check(),old=previous.projectGolden(golden);return{...old,surfaces:old.surfaces.map(row=>{const pin=value.surfaces[row.source_id];if(!pin)return row;assert.equal(row.sha256,pin.before,'issue440 exact golden predecessor '+row.source_id);return{...row,sha256:pin.after};})};}
function readme(old){return previous.readme(old)+'\n'+read('scripts/fixtures/issue-440/DISTRIBUTION.md').toString('utf8');}

function previousRegistry(rows,...rest){const node=check().registry;assert.deepEqual(rows,node.before_rows,'issue440 preserved historical registry rows');return previous.previousRegistry(rows,...rest);}
function currentSamples(text){const value=check(),node=value.sample_projection;assert.equal(hash(text),node.before,'issue440 historical sample bytes');let result=text;const groups=new Map();for(const row of value.samples){const key=row.before+'::'+row.after;groups.set(key,{...row,count:(groups.get(key)?.count||0)+1});}for(const row of groups.values()){assert.equal(result.split(row.before).length,row.count+1,'issue440 exact sample spans');result=result.split(row.before).join(row.after);}assert.equal(hash(result),node.after,'issue440 prospective sample bytes');return result;}
function previousSamples(text,...rest){const node=check().sample_projection,original=before(node).toString('utf8'),projected=previous.previousSamples(original,...rest),digest=hash(text);assert(digest===node.before||digest===node.after,'issue440 exact historical or prospective samples');return projected;}
function sampleAfter(pointer,prior){const old=previous.sampleAfter(pointer,prior),row=check().samples.find(r=>r.pointer===pointer||r.pointer+'/source/sha256'===pointer);if(!row)return old;assert.equal(old,row.before,'issue440 exact prior sample');return row.after;}
function projectTrace(trace,reverse){const value=check(),result=structuredClone(trace),from=reverse?'after':'before',to=reverse?'before':'after';assert.equal(value.parity.rows.length,39);for(const row of value.parity.rows){const keys=row.path.slice(),key=keys.pop(),parent=keys.reduce((o,k)=>o[k],result);assert.deepEqual(parent[key],row[from],'issue440 exact trace '+row.path.join('.'));parent[key]=structuredClone(row[to]);}return result;}
function parityAdapter(parity){return Object.freeze({...parity,beforeTrace:(trace,value)=>parity.beforeTrace(projectTrace(trace,true),value),afterTrace:(trace,value)=>projectTrace(parity.afterTrace(trace,value),false)});}

function smokeProjection(method,text,...rest){const row=check().files['scripts/forge-smoke.js'];assert(row&&row.before!==null,'issue440 exact smoke predecessor');const original=before(row).toString('utf8'),digest=hash(text),projected=previous[method](digest===row.before||digest===row.after?original:text,...rest);assert(digest===row.before||digest===row.after,'unrecognized smoke changes: issue440 measured source');return projected;}
function previousSmoke(text,...rest){return smokeProjection('previousSmoke',text,...rest);}
function predecessorSmoke(text,...rest){return smokeProjection('predecessorSmoke',text,...rest);}
function consumerProjection(file,text){const row=check().consumers[file];if(!row)return text;assert.equal(hash(text),row.before,'issue440 exact consumer before '+file);const bytes=zlib.gunzipSync(Buffer.from(row.after_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(bytes),row.after,'issue440 exact consumer adapter '+file);return bytes.toString('utf8');}
module.exports={...previous,previousSmoke,predecessorSmoke,consumerProjection,previousRegistry,currentSamples,previousSamples,sampleAfter,parityAdapter,validate,validate414Snapshot,after,projectGolden,readme,files:previous.files,issue440Layer:data};
