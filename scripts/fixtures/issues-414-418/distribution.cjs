'use strict';
// Linear current-source projection plus an integrity-checked sibling snapshot.
// Published414/418 fixtures stay byte-identical; shared ancestry is not audited
// twice for every normal projection.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issue-418/distribution.cjs'),archived=require('../issue-414/distribution.cjs'),data=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),PIN='ab75369a9a1202c68d3a81b85eb2572fc52c9d97930ed2bf619ce1f6a7d19781';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=file=>fs.readFileSync(path.join(ROOT,file));
const normalize=text=>String(text).replace(/version=\d+\.\d+\.\d+/g,'version=<dynamic>');
const key=item=>item.source_id+'::'+item.source;
function check(value=data,archiveValue=archived.issue414Layer){
 assert.equal(hash(JSON.stringify(value)),PIN,'integration measured delta');
 assert.equal(hash(JSON.stringify(previous.issue418Layer)),value.predecessor_layer_sha256,'integration418 predecessor');
 assert.equal(hash(JSON.stringify(archiveValue)),value.secondary414.layer_sha256,'integration414 archived layer');
 return value;
}
function before(row){const bytes=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(bytes),row.before,'integration exact predecessor bytes');return bytes;}
function artifactsBefore(rows,artifacts){return artifacts.flatMap(item=>{const row=rows[key(item)];if(!row)return[item];assert.equal(hash(normalize(item.content)),row.after,'integration current rendered source '+item.source);if(row.before===null)return[];const content=before(row).toString('utf8');return[{...item,content,...(Object.hasOwn(item,'bytes')?{bytes:Buffer.byteLength(content)}:{})}];});}
function sourceBefore(rows,readRaw,strict=false){return file=>{const row=rows[file],actual=readRaw(file);if(!row||row.before===null)return actual;if(strict)assert.equal(hash(actual),row.after,'integration snapshot current source '+file);return hash(actual)===row.after?before(row):actual;};}
function validate(options){
 const value=check(options.issue414418LayerValue||data,options.issue414LayerValue||archived.issue414Layer),readRaw=options.readRaw||read;
 const valid=previous.validate({...options,artifacts:artifactsBefore(value.rendered,options.artifacts),readRaw:sourceBefore(value.files,readRaw)});
 for(const[file,row]of Object.entries(value.files))assert.equal(hash(readRaw(file)),row.after,'integration measured current source '+file);
 return valid;
}
// Explicit historical proof only. Normal projections delegate once to418;
// this sibling validation is exercised separately against exact414 bytes.
function validate414Snapshot(options){const value=check(options.issue414418LayerValue||data,options.issue414LayerValue||archived.issue414Layer),snapshot=value.secondary414;
 return archived.validate({...options,artifacts:artifactsBefore(snapshot.rendered,options.artifacts),readRaw:sourceBefore(snapshot.files,options.readRaw||read,true)});
}
function after(kind,file,prior,attr=false){check();const old=previous.after(kind,file,prior,attr),row=kind==='surfaces'?data.surfaces[file]:data.files[file];if(!row||row.before===null)return old;assert.equal(old,row[attr?'attributed_before':'before'],'integration predecessor '+file);return row[attr?'attributed_after':'after'];}
function projectGolden(golden){check();const old=previous.projectGolden(golden);return{...old,surfaces:old.surfaces.map(row=>{const pin=data.surfaces[row.source_id];if(!pin)return row;assert.equal(row.sha256,pin.before);return{...row,sha256:pin.after};})};}
function sampleAfter(pointer,prior){check();const old=previous.sampleAfter(pointer,prior),row=data.samples?.find(r=>r.pointer===pointer||r.pointer+'/source/sha256'===pointer);if(!row)return old;assert.equal(old,row.before,'integration exact sample predecessor');return row.after;}
function previousSamples(text){check();const row=data.files['docs/communication-evaluation/samples.json'];if(!row)return previous.previousSamples(text);assert.equal(hash(text),row.after,'integration exact samples');return previous.previousSamples(before(row).toString('utf8'));}
function currentSmoke(text){check();const row=data.files['scripts/forge-smoke.js'];if(!row)return text;assert.equal(hash(text),row.after,'integration exact smoke');return before(row).toString('utf8');}
function predecessorSmoke(text){return previous.predecessorSmoke(currentSmoke(text));}
function previousSmoke(text){return previous.previousSmoke(currentSmoke(text));}
function readme(old){return previous.readme(old)+'\n'+read('scripts/fixtures/issue-414/README.md').toString('utf8')+'\n'+read('scripts/fixtures/issues-414-418/README.md').toString('utf8');}
module.exports={...previous,validate,validate414Snapshot,after,projectGolden,readme,sampleAfter,previousSamples,previousSmoke,predecessorSmoke,
 files:[...new Set([...previous.files,...Object.keys(data.rendered).map(key=>key.slice(key.indexOf('::')+2))])],issue414Layer:archived.issue414Layer,issue414418Layer:data};
