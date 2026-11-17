'use strict';
// Measured CI successor; historical validators and their data remain immutable.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issue-414/distribution.cjs'),data=require('./distribution-delta.json');
require('./immutable-pin-cache.cjs').installImmutablePinCache(require.cache[require.resolve('../issue-414/distribution.cjs')]);
const ROOT=path.resolve(__dirname,'../../..'),PIN='a3e176ea943c8d9abcabe404ecb582494bd58dd4c3e03a831b8c5994b30a1101';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=file=>fs.readFileSync(path.join(ROOT,file));
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'CI independent measured source delta');assert.equal(hash(JSON.stringify(previous.issue414Layer)),value.predecessor_layer_sha256,'CI immutable predecessor');return value;}
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
function projectSmoke(text){const row=check().files['scripts/forge-smoke.js'];return row&&row.before!==null&&hash(text)===row.after?before(row).toString('utf8'):text;}
function previousSmoke(text){return previous.previousSmoke(projectSmoke(text));}
function predecessorSmoke(text){return previous.predecessorSmoke(projectSmoke(text));}
module.exports={...previous,validate,after,previousSmoke,predecessorSmoke,ciLatencyLayer:data};
