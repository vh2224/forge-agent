'use strict';
// One measured successor over the official CI parent. Parent bytes and mutable
// historical negative controls remain intact; each projection delegates once.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../ci-latency/distribution.cjs'),data=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),PIN='d162c8aa79fb99371b8b1f95596667add8ffa5de8df2b9ffd13ed1030ea512b2';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const read=file=>fs.readFileSync(path.join(ROOT,file));
function check(value=data){
 assert.equal(hash(JSON.stringify(value)),PIN,'repair independent measured delta');
 assert.equal(hash(JSON.stringify(previous.ciLatencyLayer)),value.predecessor_layer_sha256,'repair immutable official CI predecessor');
 return value;
}
function before(row){const bytes=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(bytes),row.before,'repair exact predecessor bytes');return bytes;}
function project(value,readRaw){return file=>{const actual=readRaw(file),row=value.files[file];return row&&row.before!==null&&hash(actual)===row.after?before(row):actual;};}
function census(value,readRaw){for(const[file,row]of Object.entries(value.files))assert.equal(hash(readRaw(file)),row.after,'repair measured current source '+file);}
function validate(options){const value=check(options.issues420424LayerValue||data),readRaw=options.readRaw||read;const valid=previous.validate({...options,readRaw:project(value,readRaw)});census(value,readRaw);return valid;}
function validate414Snapshot(options){const value=check(options.issues420424LayerValue||data),readRaw=options.readRaw||read;const valid=previous.validate414Snapshot({...options,readRaw:project(value,readRaw)});census(value,readRaw);return valid;}
function after(kind,file,prior,attr=false){const value=check(),old=previous.after(kind,file,prior,attr),row=kind==='files'?value.files[file]:null;if(!row||row.before===null)return old;assert.equal(old,row[attr?'attributed_before':'before'],'repair exact prior source '+file);return row[attr?'attributed_after':'after'];}
module.exports={...previous,validate,validate414Snapshot,after,issues420424Layer:data};
