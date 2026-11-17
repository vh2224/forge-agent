'use strict';
// Measured CI successor; historical validators and their data remain immutable.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issue-416/distribution.cjs'),data=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),PIN='3b5da8aa51ca4177095fa5f59f0fe59b7dd57e6c4d394927f66e1e19ac5f74ee';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=file=>fs.readFileSync(path.join(ROOT,file));
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'CI independent measured source delta');assert.equal(hash(JSON.stringify(previous.issue416Layer)),value.predecessor_layer_sha256,'CI immutable predecessor');return value;}
function before(row){const bytes=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(bytes),row.before,'CI exact predecessor bytes');return bytes;}
function validate(options){
 const value=check(options.ciLatencyLayerValue||data),readRaw=options.readRaw||read;
 // Match the predecessor contract: exercise historical controls before the
 // successor's final current-byte census, so injected historical attacks still
 // reach their original independent refusal rather than being shadowed here.
 const valid=previous.validate({...options,readRaw:file=>{const actual=readRaw(file),row=value.files[file];return row&&row.before!==null&&hash(actual)===row.after?before(row):actual;}});
 for(const[file,row]of Object.entries(value.files))assert.equal(hash(readRaw(file)),row.after,'CI measured current source '+file);
 return valid;
}
function after(kind,file,prior,attr=false){const value=check(),old=previous.after(kind,file,prior,attr),row=kind==='files'?value.files[file]:null;if(!row||row.before===null)return old;assert.equal(old,row[attr?'attributed_before':'before'],'CI exact predecessor '+file);return row[attr?'attributed_after':'after'];}
module.exports={...previous,validate,after,ciLatencyLayer:data};
