'use strict';
// Run the actual list-mode parser/planner, without running any selected suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toolPlan, workerLayout } = require('./forge-ci-parallel');
const root = path.resolve(__dirname, '..');
const official = path.join(__dirname, 'fixtures/ci-latency/shard-profile.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tool-parity-'));
function selections(profile, layouts) {
  // A child confines the platform simulation to list mode on non-Windows CI.
  // main(argv) is the same entry point used by the real executable.
  const program = `Object.defineProperty(process,'platform',{value:'win32'});
    const runner=require('./scripts/run-tests');
    const layouts=JSON.parse(process.argv[1]),profile=process.argv[2],rows=[];
    for(const o of layouts){let output='';const write=process.stdout.write;
      process.stdout.write=value=>{output+=String(value);return true;};
      try{const code=runner.main(['--list','--partition-suites','--shard-profile',profile,
        '--shard-index',String(o.start),'--shard-count',String(o.count)]);
        if(code!==0)throw Error('runner-list-refused:'+code);
      }finally{process.stdout.write=write;}
      rows.push(output.trim().split(/\\r?\\n/).filter(Boolean));
    }process.stdout.write(JSON.stringify(rows));`;
  const result = spawnSync(process.execPath, ['-e', program, JSON.stringify(layouts), profile], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function parity(metadata, actual) {
  assert.deepEqual(metadata, actual, 'tool metadata must select the exact runner --list units in the same order');
}
try {
  const options = [];
  for (const layout of [{count:21,jobs:2,singleWorkerJobs:2}, {count:7,jobs:1,singleWorkerJobs:0}]) {
    for (let index=0;index<layout.count;index++) {
      const o={...layout,index};
      if(workerLayout(o).workers===1) options.push(o);
      else assert.equal(toolPlan(o,{platform:'win32'}).needs_svn,true,'parallel assignments remain conservative');
    }
  }
  const actual = selections(official, options.map(workerLayout));
  options.forEach((o,i)=>parity(toolPlan(o,{platform:'win32',profileFile:official}).selected_units,actual[i]));
  // Input drift is observable: both consumers agree on a different real
  // profile; comparing metadata for that profile with the old runner fails.
  const changed = JSON.parse(fs.readFileSync(official,'utf8'));
  for(const id of Object.keys(changed.platforms.win32.weights_ms)) changed.platforms.win32.weights_ms[id]=1;
  const first=Object.keys(changed.platforms.win32.weights_ms)[0];changed.platforms.win32.weights_ms[first]=900000;
  const alternate=path.join(temp,'changed-profile.json');fs.writeFileSync(alternate,JSON.stringify(changed));
  const shifted=selections(alternate,options.map(workerLayout));let mismatches=0;
  options.forEach((o,i)=>{
    const metadata=toolPlan(o,{platform:'win32',profileFile:alternate}).selected_units;
    parity(metadata,shifted[i]);
    if(JSON.stringify(metadata)!==JSON.stringify(actual[i])) {assert.throws(()=>parity(metadata,actual[i]));mismatches++;}
  });
  assert(mismatches>0,'profile-input fault injection must actually change a selection');
  assert.throws(()=>parity([...actual[0],'foreign.test.js'],actual[0]));
  console.log('PASS issue427 actual runner/tool-plan parity for official and changed profiles/layouts; input-drift negatives');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
