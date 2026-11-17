'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { expandSuites, unitsForSuite, unitWeights, validateBaselinePair, selectCases, DEFINITIONS } = require('./forge-ci-units');
const { planShards, verifyPartition } = require('./forge-ci-shards');
const { discoverTests } = require('./run-tests');
const suites = discoverTests([]), units = expandSuites(suites);
assert.equal(new Set(units.map(row => row.id)).size, units.length);
assert.deepEqual([...new Set(units.map(row => row.source))].sort(), [...suites].sort());
assert(units.every(row => fs.statSync(path.join(__dirname, row.source)).isFile()));
assert.deepEqual(unitsForSuite('ordinary.test.js'), [{id:'ordinary.test.js',source:'ordinary.test.js',args:[],divisor:1}]);
assert.throws(() => expandSuites(['ordinary.test.js','ordinary.test.js']), /collision/);
for (const [source, definition] of Object.entries(DEFINITIONS)) {
  const inventory = unitsForSuite(source);
  assert.equal(inventory.length, definition.parts || definition.args.length);
  assert(inventory.every(row => row.source === source && row.id.endsWith('.test.js')));
  if (definition.kind === 'cases') {
    const cases = Array.from({length:37}, (_, i) => ({name:`case-${i}`,fn:()=>i}));
    const selected = inventory.flatMap(unit => selectCases(cases, unit.args));
    assert.equal(selected.length, cases.length);
    assert.equal(new Set(selected).size, cases.length);
    assert.deepEqual(new Set(selected), new Set(cases));
  }
}
for (const arg of ['--ci-cases=1/1','--ci-cases=-1/3','--ci-cases=0/0','--ci-cases=0/65','--ci-cases=01/2','--ci-cases=1.5/2']) assert.throws(()=>selectCases([{name:'one'}],[arg]));
assert.throws(()=>selectCases([{name:'same'},{name:'same'}],['--ci-cases=0/2']),/roster/);
assert.throws(()=>selectCases([{name:'one'}],['--ci-cases=1/2']),/empty/);
assert.throws(()=>selectCases([{name:'one'}],['--ci-cases=0/1','--ci-cases=0/1']),/duplicate/);
const coupled=[{name:'producer',group:'shared'}, {name:'independent'}, {name:'consumer',group:'shared'}, {name:'independent-two'}];
const grouped=[0,1].map(index=>selectCases(coupled,[`--ci-cases=${index}/2`]));
assert(grouped.some(part=>part.map(row=>row.name).join(',')==='producer,consumer,independent-two'));
assert.equal(new Set(grouped.flat()).size,coupled.length);
assert.throws(()=>selectCases([{name:'one',group:1}],['--ci-cases=0/1']),/group/);
const sample = unitsForSuite('forge-native-repackage.test.js');
const profile = {state:'loaded',doc:{platforms:{win32:{status:'observed',weights_ms:{'forge-native-repackage.test.js':6000}}}}};
assert.deepEqual(Object.values(unitWeights(sample,profile,'win32')),Array(6).fill(1000));
assert.deepEqual(unitWeights(sample,profile,'darwin'),{});
const baselineText = entries => JSON.stringify({win32:entries,linux:entries,darwin:entries});
const sourceEntry={suite:'forge-native-repackage.test.js',item:'fixture-known',reason:'known source failure'};
const unitEntry={suite:sample[0].id,item:'fixture-known',reason:'known first scenario'};
const pair=(sourceEntries,unitEntries)=>validateBaselinePair({sourceSuites:['forge-native-repackage.test.js','ordinary.test.js'],platform:'win32',sourceText:baselineText(sourceEntries),unitText:baselineText(unitEntries),resolveBaseline:require('./run-tests').resolveBaseline});
assert(pair([],[]).ok);assert(pair([sourceEntry],[unitEntry]).ok);
assert(!pair([sourceEntry],[]).ok);assert(!pair([],[unitEntry]).ok);
assert(!pair([sourceEntry],[{...unitEntry,item:'different-issue'}]).ok);
assert(!pair([sourceEntry],[sourceEntry]).ok);
assert(require('./run-tests').resolveBaseline({text:baselineText([sourceEntry]),platform:'win32',availableSuites:['forge-native-repackage.test.js','ordinary.test.js']}).ok,'ordinary whole-suite baseline remains independently usable');
for (const count of [1,2,8,24,32,64]) {
  const plans=Array.from({length:count},(_,index)=>planShards({suites:units.map(row=>row.id),index,count,platform:'win32'}));
  assert(verifyPartition(units.map(row=>row.id),plans.map(row=>row.selected)).ok);
}
// Exercise the real opt-in runner, baseline and structured profiles, rather
// than proving only that the pure inventory function agrees with itself.
const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ci-units-fixture-')));
try {
  const scripts=path.join(temp,'scripts');fs.mkdirSync(scripts);
  for(const file of ['run-tests.js','forge-ci-units.js','forge-ci-shards.js','forge-suite-profile.js'])fs.copyFileSync(path.join(__dirname,file),path.join(scripts,file));
  const markers=path.join(temp,'markers');fs.mkdirSync(markers);
  const source=`const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const arg=process.argv.find(x=>x.startsWith('--ci-cases='));assert(arg);const index=arg.match(/^--ci-cases=(\\d+)\\/6$/)[1];fs.writeFileSync(path.join(${JSON.stringify(markers)},index),'ran');if(fs.existsSync(path.join(${JSON.stringify(temp)},'fail'))&&index==='0')process.exitCode=1;`;
  fs.writeFileSync(path.join(scripts,'forge-native-repackage.test.js'),source);
  fs.writeFileSync(path.join(scripts,'ordinary.test.js'),`require('node:fs').writeFileSync(${JSON.stringify(path.join(markers,'ordinary'))},'ran');`);
  const baseline=path.join(temp,'baseline.json');fs.writeFileSync(baseline,JSON.stringify({win32:[],linux:[],darwin:[]}));
  const profiles=[];
  for(let index=0;index<3;index++){
    const profileOut=path.join(temp,`profile-${index}.json`);
    const result=spawnSync(process.execPath,[path.join(scripts,'run-tests.js'),'--partition-suites','--shard-index',String(index),'--shard-count','3','--baseline',baseline,'--profile-out',profileOut],{cwd:temp,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
    const parsed=JSON.parse(fs.readFileSync(profileOut));assert.equal(parsed.totals.failed,0);assert.equal(parsed.selection.discovered,7);profiles.push(parsed);
  }
  assert.deepEqual(fs.readdirSync(markers).sort(),['0','1','2','3','4','5','ordinary']);
  const executed=profiles.flatMap(row=>row.suites.map(suite=>suite.id));assert.equal(executed.length,7);assert.equal(new Set(executed).size,7);
  fs.writeFileSync(path.join(temp,'fail'),'fail one actual partition');
  const failed=spawnSync(process.execPath,[path.join(scripts,'run-tests.js'),'--partition-suites','--baseline',baseline],{cwd:temp,encoding:'utf8',windowsHide:true});
  assert.equal(failed.status,1);assert(failed.stderr.includes('forge-native-repackage.ci-01-of-6.test.js'));
  fs.writeFileSync(baseline,JSON.stringify(Object.fromEntries(['win32','linux','darwin'].map(platform=>[platform,[{suite:'forge-native-repackage.test.js',item:'fixture',reason:'source-wide failure cannot authorize partial units'}]]))));
  const incompatible=spawnSync(process.execPath,[path.join(scripts,'run-tests.js'),'--partition-suites','--baseline',baseline],{cwd:temp,encoding:'utf8',windowsHide:true});
  assert.equal(incompatible.status,2,'source-wide baseline entries cannot silently hide per-part failures');
}finally{fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
console.log(`PASS complete CI unit inventory: ${suites.length} source suites, ${units.length} independent units; every source and case appears exactly once`);
