'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issue-439/distribution.cjs'),data=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),PIN='47547fa4970d9a51e12fa7b633d64c5b6f3cc0ce00780c79900e8c29a2dfd94a';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),read=file=>fs.readFileSync(path.join(ROOT,file));
const normalize=value=>String(value).replace(/version=\d+\.\d+\.\d+/g,'version=<dynamic>');
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'owner independent measured delta');assert.equal(hash(JSON.stringify(previous.issue439Layer)),value.predecessor_layer_sha256,'owner immutable predecessor');return value;}
function before(row){const bytes=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(bytes),row.before,'owner exact predecessor bytes');return bytes;}
function project(value,readRaw){return file=>{const actual=readRaw(file),row=value.files[file];return row&&row.before!==null&&hash(actual)===row.after?before(row):actual;};}
function artifactsBefore(value,artifacts){return artifacts.flatMap(item=>{const row=value.rendered[item.source_id+'::'+item.source];if(!row)return[item];assert.equal(hash(normalize(item.content)),row.after,'owner measured rendered source '+item.source);if(row.before===null)return[];const content=before(row).toString('utf8');return[{...item,content,...(Object.hasOwn(item,'bytes')?{bytes:Buffer.byteLength(content)}:{})}];});}
function census(value,readRaw){for(const[file,row]of Object.entries(value.files))assert.equal(hash(readRaw(file)),row.after,'owner measured current source '+file);}
function validateWith(method,options){const value=check(options.issues442446LayerValue||data),readRaw=options.readRaw||read;const valid=previous[method]({...options,artifacts:artifactsBefore(value,options.artifacts),readRaw:project(value,readRaw)});census(value,readRaw);return valid;}
function validate(options){return validateWith('validate',options);}
function validate414Snapshot(options){return validateWith('validate414Snapshot',options);}
function after(kind,file,prior,attr=false){const value=check(),old=previous.after(kind,file,prior,attr),row=kind==='surfaces'?value.surfaces[file]:kind==='files'?value.files[file]:null;if(!row||row.before===null)return old;assert.equal(old,row[attr?'attributed_before':'before'],'owner exact prior source '+file);return row[attr?'attributed_after':'after'];}
function projectGolden(golden){const value=check(),old=previous.projectGolden(golden);return{...old,surfaces:old.surfaces.map(row=>{const pin=value.surfaces[row.source_id];if(!pin)return row;assert.equal(row.sha256,pin.before);return{...row,sha256:pin.after};})};}
function readme(old){return previous.readme(old)+'\n'+read('scripts/fixtures/issues-442-446/README.md').toString('utf8');}
function sampleAfter(pointer,prior){const value=check(),old=previous.sampleAfter(pointer,prior),row=value.samples.find(r=>r.pointer===pointer||r.pointer+'/source/sha256'===pointer);if(!row)return old;assert.equal(old,row.before,'issue batch exact sample predecessor '+pointer);return row.after;}
function previousSamples(text){const row=check().files['docs/communication-evaluation/samples.json'];if(!row)return previous.previousSamples(text);const projected=previous.previousSamples(before(row).toString('utf8'));assert.equal(hash(text),row.after,'issue batch current samples');return projected;}
module.exports={...previous,validate,validate414Snapshot,after,projectGolden,readme,sampleAfter,previousSamples,files:previous.files,issues442446Layer:data};
