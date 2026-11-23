'use strict';
// Additive measured successor; all published fixtures and their contracts remain unchanged.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issue-440/distribution.cjs'),data=require('./distribution-delta.json'),ROOT=path.resolve(__dirname,'../../..'),PIN='117327e7be4e9e8650bf5768d4c690307e4433b5650ce2361d72f30e89300ed3';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),read=file=>fs.readFileSync(path.join(ROOT,file));
const linked=/^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm,attributed=b=>hash(b.toString('utf8').replace(linked,''));
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'issues451452 independent measured delta');assert.equal(hash(JSON.stringify(previous.issue440Layer)),value.predecessor_layer_sha256,'issues451452 immutable issue440 predecessor');return value;}
function before(row){const b=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(b),row.before,'issues451452 exact preimage');assert.equal(attributed(b),row.attributed_before,'issues451452 attributed preimage');return b;}
function projectRead(readRaw=read,value=check()){return file=>{const b=readRaw(file),r=value.files[file];return r&&r.before!==null&&hash(b)===r.after?before(r):b;};}
function verifyCurrent(options={}){const value=check(options.issues451452LayerValue||data),readRaw=options.readRaw||read;for(const[file,r]of Object.entries(value.files)){const b=readRaw(file);assert.equal(hash(b),r.after,'issues451452 measured current source '+file);assert.equal(attributed(b),r.attributed_after,'issues451452 measured attributed source '+file);}for(const[file,r]of Object.entries(value.historical_fixtures)){const b=readRaw(file);assert.equal(hash(b),r.sha256,'issues451452 immutable published fixture '+file);assert.equal(b.length,r.bytes,'issues451452 published fixture size '+file);}return true;}
function validateWith(method,options){const value=check(options.issues451452LayerValue||data),readRaw=options.readRaw||read,result=previous[method]({...options,readRaw:projectRead(readRaw,value)});verifyCurrent({...options,readRaw});return result;}
function validate(options){return validateWith('validate',options);}
function validate414Snapshot(options){return validateWith('validate414Snapshot',options);}
function after(kind,file,prior,attr=false){const value=check(),old=previous.after(kind,file,prior,attr),r=kind==='files'?value.files[file]:null;if(!r||r.before===null)return old;assert.equal(old,r[attr?'attributed_before':'before'],'issues451452 exact prior source '+file);return r[attr?'attributed_after':'after'];}
// The published440 suite tests its own exact world, including its own negatives.
// This view adds no current-census failure that could mask their intended target.
function publishedValidate(method,options){check();return previous[method]({...options,readRaw:projectRead(options.readRaw||read)});}
const issue440View=Object.freeze({...previous,validate:options=>publishedValidate('validate',options),validate414Snapshot:options=>publishedValidate('validate414Snapshot',options)});
function smokeProjection(method,text){check();const row=data.files['scripts/forge-smoke.js'];return previous[method](hash(text)===row.after?before(row).toString('utf8'):text);}
function previousSmoke(text){return smokeProjection('previousSmoke',text);}
function predecessorSmoke(text){return smokeProjection('predecessorSmoke',text);}
module.exports={...previous,validate,validate414Snapshot,after,projectRead,verifyCurrent,issue440View,previousSmoke,predecessorSmoke,issues451452Layer:data};
