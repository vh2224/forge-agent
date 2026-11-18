'use strict';
// Measured CI successor; historical validators and their data remain immutable.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issues-414-418/distribution.cjs'),data=require('./distribution-delta.json');
require('./immutable-pin-cache.cjs').installImmutablePinCache(require.cache[require.resolve('../issues-414-418/distribution.cjs')]);
const ROOT=path.resolve(__dirname,'../../..'),PIN='7e54353bf09ab9971011bdf0a39adbd9bb5853d1f86f7b00e11661d07ce49aaa';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=file=>fs.readFileSync(path.join(ROOT,file));
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'CI independent measured source delta');assert.equal(hash(JSON.stringify(previous.issue414418Layer)),value.predecessor_layer_sha256,'CI immutable predecessor');return value;}
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
function validate414Snapshot(options){const value=check(options.ciLatencyLayerValue||data),readRaw=options.readRaw||read;return previous.validate414Snapshot({...options,readRaw:file=>{const actual=readRaw(file),row=value.files[file];return row&&row.before!==null&&hash(actual)===row.after?before(row):actual;}});}
module.exports={...previous,validate,validate414Snapshot,after,previousSmoke,predecessorSmoke,ciLatencyLayer:data};
