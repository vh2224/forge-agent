'use strict';
// One additive measured layer; published predecessor fixtures stay immutable.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issues-451-452/distribution.cjs'),data=require('./distribution-delta.json'),ROOT=path.resolve(__dirname,'../../..'),PIN='d4c49983f122f7e78778332f399892909020ceb83987c48c2ef69f2f1e3937ea';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=file=>fs.readFileSync(path.join(ROOT,file));
const linked=/^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm,attributed=b=>hash(b.toString('utf8').replace(linked,''));
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'issue455 independent measured delta');assert.equal(hash(JSON.stringify(previous.issues451452Layer)),value.predecessor_layer_sha256,'issue455 immutable predecessor');return value;}
function preimage(row){const b=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(b),row.before,'issue455 exact preimage');assert.equal(attributed(b),row.attributed_before,'issue455 attributed preimage');return b;}
function projectRead(readRaw=read,value=check()){return file=>{const b=readRaw(file),r=value.files[file];return r&&r.before!==null&&hash(b)===r.after?preimage(r):b;};}
function verifyCurrent(options={}){const value=check(options.issue455LayerValue||data),readRaw=options.readRaw||read;for(const[file,r]of Object.entries(value.files)){const b=readRaw(file);assert.equal(hash(b),r.after,'issue455 measured current source '+file);assert.equal(attributed(b),r.attributed_after,'issue455 attributed current source '+file);}for(const[file,r]of Object.entries(value.historical_fixtures)){const b=readRaw(file);assert.equal(hash(b),r.sha256,'issue455 immutable published fixture '+file);assert.equal(b.length,r.bytes);}return true;}
function validateWith(method,options={}){const value=check(options.issue455LayerValue||data),readRaw=options.readRaw||read,result=previous[method]({...options,readRaw:projectRead(readRaw,value)});verifyCurrent({...options,readRaw});return result;}
function validate(options){return validateWith('validate',options);}
function validate414Snapshot(options){return validateWith('validate414Snapshot',options);}
function after(kind,file,prior,attr=false){const value=check(),old=previous.after(kind,file,prior,attr),r=kind==='files'?value.files[file]:null;if(!r||r.before===null)return old;assert.equal(old,r[attr?'attributed_before':'before'],'issue455 exact predecessor source '+file);return r[attr?'attributed_after':'after'];}
// Historical views project this layer once, then preserve the old API/negatives.
function viewMethod(object,method,options={}){check();return object[method]({...options,readRaw:projectRead(options.readRaw||read)});}
const issue440View=Object.freeze({...previous.issue440View,
 validate:options=>viewMethod(previous.issue440View,'validate',options),validate414Snapshot:options=>viewMethod(previous.issue440View,'validate414Snapshot',options)});
const issues451452View=Object.freeze({...previous,issue440View,
 validate:options=>viewMethod(previous,'validate',options),validate414Snapshot:options=>viewMethod(previous,'validate414Snapshot',options),verifyCurrent:options=>viewMethod(previous,'verifyCurrent',options),
 projectRead:(readRaw=read)=>previous.projectRead(projectRead(readRaw))});
// Only the exact current smoke source is rewound. Baseline/foreign text is
// delegated unchanged, preserving the predecessor's existing input contract.
function smokeProjection(method,text){check();const row=data.files['scripts/forge-smoke.js'];assert(row&&row.before!==null,'issue455 measured smoke predecessor required');return previous[method](hash(text)===row.after?preimage(row).toString('utf8'):text);}
function previousSmoke(text){return smokeProjection('previousSmoke',text);}
function predecessorSmoke(text){return smokeProjection('predecessorSmoke',text);}
module.exports={...previous,validate,validate414Snapshot,after,projectRead,verifyCurrent,issue440View,issues451452View,previousSmoke,predecessorSmoke,issue455Layer:data};
