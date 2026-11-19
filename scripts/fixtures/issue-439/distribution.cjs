'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issues-434-436/distribution.cjs'),data=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),PIN='a5e966fbf66b0df621a27f01001254405c40a489b8a8cd7db62acc79bb137bca';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),read=file=>fs.readFileSync(path.join(ROOT,file));
const normalize=value=>String(value).replace(/version=\d+\.\d+\.\d+/g,'version=<dynamic>');
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'owner independent measured delta');assert.equal(hash(JSON.stringify(previous.issues434436Layer)),value.predecessor_layer_sha256,'owner immutable predecessor');return value;}
function before(row){const bytes=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(bytes),row.before,'owner exact predecessor bytes');return bytes;}
function project(value,readRaw){return file=>{const actual=readRaw(file),row=value.files[file];return row&&row.before!==null&&hash(actual)===row.after?before(row):actual;};}
function artifactsBefore(value,artifacts){return artifacts.flatMap(item=>{const row=value.rendered[item.source_id+'::'+item.source];if(!row)return[item];assert.equal(hash(normalize(item.content)),row.after,'owner measured rendered source '+item.source);if(row.before===null)return[];const content=before(row).toString('utf8');return[{...item,content,...(Object.hasOwn(item,'bytes')?{bytes:Buffer.byteLength(content)}:{})}];});}
function census(value,readRaw){for(const[file,row]of Object.entries(value.files))assert.equal(hash(readRaw(file)),row.after,'owner measured current source '+file);}
function validateWith(method,options){const value=check(options.issue439LayerValue||data),readRaw=options.readRaw||read;const valid=previous[method]({...options,artifacts:artifactsBefore(value,options.artifacts),readRaw:project(value,readRaw)});census(value,readRaw);return valid;}
function validate(options){return validateWith('validate',options);}
function validate414Snapshot(options){return validateWith('validate414Snapshot',options);}
function after(kind,file,prior,attr=false){const value=check(),old=previous.after(kind,file,prior,attr),row=kind==='surfaces'?value.surfaces[file]:kind==='files'?value.files[file]:null;if(!row||row.before===null)return old;assert.equal(old,row[attr?'attributed_before':'before'],'owner exact prior source '+file);return row[attr?'attributed_after':'after'];}
function projectGolden(golden){const value=check(),old=previous.projectGolden(golden);return{...old,surfaces:old.surfaces.map(row=>{const pin=value.surfaces[row.source_id];if(!pin)return row;assert.equal(row.sha256,pin.before);return{...row,sha256:pin.after};})};}
function readme(old){return previous.readme(old)+'\n'+read('scripts/fixtures/issue-439/README.md').toString('utf8');}
module.exports={...previous,validate,validate414Snapshot,after,projectGolden,readme,files:[...new Set([...previous.files,...Object.keys(data.rendered).map(key=>key.slice(key.indexOf('::')+2))])],issue439Layer:data};
