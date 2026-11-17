'use strict';
// Hermetic regression support: actual Git workspace, child check, public delivery builder.
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),delivery=require(path.join(root,'forge-delivery'));
function put(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
function command(bin,args,cwd){const out=cp.spawnSync(bin,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});if(out.status!==0)throw Error('fixture-command:'+bin+':'+out.status);return out.stdout.trim();}
function plan(task='T01'){return `---\nid: ${task}\ndepends: []\nwrites: [src/${task}.js]\nexpected_output: [src/${task}.js]\nmust_haves:\n  truths: [Fixture exports one]\n  artifacts:\n    - path: src/${task}.js\n      provides: Fixture module\n      min_lines: 1\n  key_links: []\n---\n# ${task}\n`;}
function prepare(cwd,{milestone,slice='S01',task='T01',codeDir=cwd}={}){
 if(!fs.realpathSync.native(cwd).toLowerCase().startsWith(fs.realpathSync.native(os.tmpdir()).toLowerCase()+path.sep))throw Error('fixture-root-required');
 if(!fs.existsSync(path.join(codeDir,'.git'))){command('git',['init','-q'],codeDir);command('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture'],codeDir);}
 const base=`.gsd/milestones/${milestone}/slices/${slice}/tasks/${task}`,planFile=path.join(cwd,base,task+'-PLAN.md');
 if(!fs.existsSync(planFile))put(planFile,plan(task));
 const source=`src/${task}.js`;if(!fs.existsSync(path.join(codeDir,source)))put(path.join(codeDir,source),'module.exports = 1;\n');
 return{base,planFile,source,codeDir,unit:{type:'task',id:task,slice,milestone},task};
}
function publish(cwd,options){const f=prepare(cwd,options),text=fs.readFileSync(f.planFile,'utf8'),fingerprint=delivery.sha256(text),key=delivery.unitKey(f.unit);
 const script=`const assert=require('node:assert/strict');assert.equal(require('./${f.source}'),1);console.log('verified fixture output one');`,stdout=command(process.execPath,['-e',script],f.codeDir);
 const blob=command('git',['hash-object','-w',f.source],f.codeDir),revision=command('git',['rev-parse','HEAD'],f.codeDir),at=options.at||new Date().toISOString();
 const context={schema_version:1,unit:f.unit,plan_fingerprint:fingerprint,code_dir:f.codeDir,revision,workspace:[{path:f.source,hash:blob}],environment:'owned-real-git-node-fixture',captured_at:at};
 const verify=`${f.base}/${f.task}-VERIFY-ENVELOPE.json`,artifact=`${f.base}/${f.task}-ARTIFACT-ENVELOPE.json`;
 put(path.join(cwd,verify),JSON.stringify({...context,kind:'verification',result:{passed:true,checks:[{command:'fixture node assertion',exitCode:0,stdout}]}}));
 put(path.join(cwd,artifact),JSON.stringify({...context,kind:'artifact',result:{passed:true,rows:[{path:f.source,exists:true,lines:1}]}}));
 const input={schema_version:1,unit:f.unit,plan:path.relative(cwd,f.planFile).replace(/\\/g,'/'),plan_fingerprint:fingerprint,bindings:[
  {criterion_id:key+':truth:0',coverage:'behavioral',source:{kind:'verification',path:verify,check_index:0}},
  {criterion_id:key+':artifact:0',coverage:'structural',source:{kind:'artifact',path:artifact,row_index:0,property:'exists'}}]};
 put(path.join(cwd,f.base,f.task+'-DELIVERY-INPUT.json'),JSON.stringify(input));
 const value=delivery.buildDelivery(input,{ownerRoot:cwd,codeDir:f.codeDir});if(value.criteria.length!==2||value.criteria.some(c=>c.status!=='verificado'))throw Error('fixture-delivery-unproven');
 put(path.join(cwd,f.base,f.task+'-DELIVERY.json'),JSON.stringify(value));return{...f,input,value};
}
module.exports={prepare,publish,plan};
