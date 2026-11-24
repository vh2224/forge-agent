'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const personal = require('./forge-personal-context');

// Shared sanitized fixture builder for the public integration suite.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-personal-'));
  const project = path.join(root, 'wc');
  const home = path.join(root, 'alice');
  const otherHome = path.join(root, 'bob');
  for (const dir of [project, home, otherHome]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(project, '.svn'));
  fs.writeFileSync(path.join(root, 'LAB-MANIFEST.json'), JSON.stringify({ purpose: 'isolated personal-context fixtures', root }));
  const options = { project, cwd: project, userHome: home, env: { FORGE_HOME: path.join(root, 'shared-forge') } };
  function work(id, kind = 'task', active = false) {
    const dir = path.join(project, '.gsd', kind === 'task' ? 'tasks' : 'milestones', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(project, '.gsd', 'forge', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(project, '.gsd', 'forge', 'runs', `${id}.json`), JSON.stringify({ id, kind, project, cwd: project, active }));
    const source = path.join(dir, `${id}-${kind === 'task' ? 'PLAN' : 'STATE'}.md`);
    fs.writeFileSync(source, kind === 'task' ? '---\nstatus: RUNNING\n---\nPlan\n' : `---\nmilestone: ${id}\nkind: milestone\n---\n**Phase:** idle\n**Next Action:** Plan slice\n`);
    return { dir, source };
  }
  function bind(id, extra = {}) {
    const result = personal.bindWork({ ...options, id, intent: 'create', ...extra });
    assert.strictEqual(result.status, 'ok', JSON.stringify(result));
    return result;
  }
  function env(userHome = home) {
    return { ...process.env, HOME: userHome, USERPROFILE: userHome, FORGE_HOME: options.env.FORGE_HOME,
      CODEX_HOME: path.join(userHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(userHome, '.claude') };
  }
  return { root, project, home, otherHome, options, work, bind, env,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}
function testMutexLeafNamespaceObservation() {
  const script = String.raw`
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const scripts=process.argv[1],temporary=fs.realpathSync.native(os.tmpdir());
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(temporary,'forge-personal-mutex-'))),marker=crypto.randomUUID();
fs.writeFileSync(path.join(root,'.fixture-owner'),marker,{flag:'wx'});
const savedEnv={...process.env},native={exists:fs.existsSync,lstat:fs.lstatSync};let held=null,lock=null,restoreMode=null;
try {
 const bootHome=path.join(root,'boot-home');fs.mkdirSync(bootHome);
 Object.assign(process.env,{HOME:bootHome,USERPROFILE:bootHome,CODEX_HOME:path.join(bootHome,'.codex'),CLAUDE_CONFIG_DIR:path.join(bootHome,'.claude'),FORGE_HOME:path.join(root,'forge'),FORGE_KEYCHAIN_DISABLED:'1'});
 for(const file of ['forge-personal-context.js','forge-lock.js','forge-home.js'])assert.equal(require.cache[require.resolve(path.join(scripts,file))],undefined,'isolated child imports only');
 const personal=require(path.join(scripts,'forge-personal-context.js'));lock=require(path.join(scripts,'forge-lock.js'));
 let permissionObserved=false;const verified=[];
 for(const scenario of ['parents-born','locks-born']) {
  const home=path.join(root,scenario),project=path.join(home,'project');fs.mkdirSync(project,{recursive:true});
  const namespace=path.join(home,'.forge-personal'),gsd=path.join(namespace,'.gsd'),parent=path.join(gsd,'.locks');
  const options={project,cwd:project,userHome:home,env:{HOME:home,USERPROFILE:home,FORGE_HOME:process.env.FORGE_HOME}},read=()=>personal.readPersonalSnapshot(options);
  assert.equal(read().reason,'no-bindings','before namespace exists');
  assert.equal(native.exists(namespace),false);
  if(scenario==='locks-born')fs.mkdirSync(gsd,{recursive:true});
  let born=false;
  fs.existsSync=function(file){
   const actual=native.exists.call(fs,file);
   if(!born&&!actual&&typeof file==='string'&&path.resolve(file)===path.resolve(parent)){
    born=true;fs.mkdirSync(gsd,{recursive:true});held=lock.acquireSync(namespace,'context');assert(lock.assertOwned(held));
   }
   return actual;
  };
  let observed;
  try{observed=read();}finally{fs.existsSync=native.exists;}
  assert(born,'real acquisition follows the last actual parent absence');
  assert.equal(observed.status,'ok');assert.equal(observed.reason,'no-bindings');assert(lock.assertOwned(held));
  assert.equal(native.exists(path.join(namespace,'context.json')),false);
  assert.equal(lock.releaseHandle(held).ok,true);held=null;verified.push(scenario);
 }
 for(const scenario of ['disappear','contained-parent-alias','reacquired-leaf','second-release','dangling-leaf','escaped-leaf','changed-parent','non-directory-parent','permission-parent']) {
  const home=path.join(root,scenario),project=path.join(home,'project');fs.mkdirSync(project,{recursive:true});
  const namespace=path.join(home,'.forge-personal'),gsd=path.join(namespace,'.gsd'),parent=path.join(gsd,'.locks'),leaf=path.join(parent,'context');
  const options={project,cwd:project,userHome:home,env:{HOME:home,USERPROFILE:home,FORGE_HOME:process.env.FORGE_HOME}},read=()=>personal.readPersonalSnapshot(options);
  assert.equal(read().reason,'no-bindings');fs.mkdirSync(gsd,{recursive:true});
  if(scenario==='contained-parent-alias'){const target=path.join(namespace,'private-locks');fs.mkdirSync(target);fs.symlinkSync(target,parent,process.platform==='win32'?'junction':'dir');}
  held=lock.acquireSync(namespace,'context');assert(lock.assertOwned(held));assert.equal(read().reason,'no-bindings');
  let released=false,changed=false,permission=false,secondReleased=false;
  function atObservation(file){
   if(released||typeof file!=='string'||path.resolve(file)!==path.resolve(leaf))return;
   released=true;const result=lock.releaseHandle(held);assert.equal(result.ok,true);assert.equal(result.reason,'released');held=null;
   if(scenario==='dangling-leaf'||scenario==='escaped-leaf'){
    const target=path.join(root,scenario==='dangling-leaf'?'absent-target':'outside-namespace');
    if(scenario==='escaped-leaf')fs.mkdirSync(target);
    fs.symlinkSync(target,leaf,process.platform==='win32'?'junction':'dir');changed=true;
   }else if(scenario==='changed-parent'){
    fs.renameSync(parent,parent+'.old');fs.mkdirSync(parent);changed=true;
   }else if(scenario==='non-directory-parent'){
    fs.rmdirSync(parent);fs.writeFileSync(parent,'not a directory\n');changed=true;
   }else if(scenario==='permission-parent'&&process.platform!=='win32'&&typeof process.getuid==='function'&&process.getuid()!==0){
    const mode=fs.statSync(parent).mode&0o777;fs.chmodSync(parent,0);restoreMode={parent,mode};
    try{native.lstat(leaf);}catch(error){permission=error.code==='EACCES';}
    if(!permission){fs.chmodSync(parent,mode);restoreMode=null;}
    permissionObserved=permission;
   }
  }
  fs.existsSync=function(file){const value=native.exists.call(fs,file);if(value)atObservation(file);return value;};
  fs.lstatSync=function(file,...args){
   // A real new holder arrives before the fresh physical leaf observation.
   if(released&&!changed&&['reacquired-leaf','second-release'].includes(scenario)&&typeof file==='string'&&path.resolve(file)===path.resolve(leaf)){
    changed=true;held=lock.acquireSync(namespace,'context');assert(lock.assertOwned(held));
   }
   const value=native.lstat.call(fs,file,...args);
   if(released&&changed&&held&&scenario==='second-release'&&!secondReleased&&typeof file==='string'&&path.resolve(file)===path.resolve(leaf)){
    assert(value.isDirectory()&&!value.isSymbolicLink(),'fresh real directory was actually observed');
    secondReleased=true;const release=lock.releaseHandle(held);assert.equal(release.ok,true);assert.equal(release.reason,'released');held=null;
   }
   atObservation(file);return value;
  };
  let observed;
  try{observed=read();}finally{fs.existsSync=native.exists;fs.lstatSync=native.lstat;if(restoreMode){fs.chmodSync(restoreMode.parent,restoreMode.mode);restoreMode=null;}}
  assert(released,'real release seam exercised '+scenario);
  const harmless=['disappear','contained-parent-alias','reacquired-leaf','second-release'].includes(scenario)||scenario==='permission-parent'&&!permission;
  if(harmless){assert.equal(observed.status,'ok');assert.equal(observed.reason,'no-bindings');}
  else{assert.equal(observed.status,'error',scenario);assert.equal(observed.reason,'namespace-invalid',scenario);}
  if(['reacquired-leaf','second-release','dangling-leaf','escaped-leaf','changed-parent','non-directory-parent'].includes(scenario))assert(changed,'real interleaving state exercised '+scenario);
  if(scenario==='second-release')assert(secondReleased,'real second release follows fresh lstat');
  if(held){assert.equal(lock.releaseHandle(held).ok,true);held=null;}
  assert.equal(native.exists(path.join(namespace,'context.json')),false,'no personal bindings or payload created');
  verified.push(scenario);
 }
 console.log(JSON.stringify({verified,permission_denial_observed:permissionObserved,unobserved:permissionObserved?[]:['effective EACCES control unavailable on this platform/identity'],real_lock_release:true,personal_bindings_created:0}));
}finally{
 fs.existsSync=native.exists;fs.lstatSync=native.lstat;if(restoreMode)fs.chmodSync(restoreMode.parent,restoreMode.mode);
 if(held&&lock)assert.equal(lock.releaseHandle(held).ok,true);
 process.env=savedEnv;const physical=fs.realpathSync.native(root);assert.equal(physical,root);assert.equal(path.dirname(physical),temporary);assert.equal(fs.readFileSync(path.join(root,'.fixture-owner'),'utf8'),marker);fs.rmSync(physical,{recursive:true});
}
`;
  const result = require('child_process').spawnSync(process.execPath, ['-e', script, __dirname], {
    env: { ...process.env }, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const proof = JSON.parse(result.stdout.trim());
  assert.strictEqual(proof.real_lock_release, true);
  assert.strictEqual(proof.personal_bindings_created, 0);
  assert.strictEqual(proof.verified.length, 11);
  console.log('PASS personal mutex disappearance, contained parent alias and real-state refusal controls; effective EACCES observed: ' + proof.permission_denial_observed);
}


async function main() {
  testMutexLeafNamespaceObservation();
  const f = fixture();
  try {
    const a = f.work('TASK-001'); f.work('TASK-002');
    const storeFile = path.join(f.home, '.forge-personal', 'context.json');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'no-bindings');
    assert(!fs.existsSync(path.dirname(storeFile)), 'read must not mkdir');
    f.bind('TASK-001'); f.bind('TASK-002', { userHome: f.otherHome });
    assert.strictEqual(f.bind('TASK-001', { intent: 'explicit-resume' }).reason, 'already-bound');
    assert.deepStrictEqual(personal.readPersonalSnapshot(f.options).works.map(w => w.id), ['TASK-001']);
    assert.strictEqual(personal.readPersonalSnapshot({ userHome: f.home, cwd: f.root }).reason, 'project-unresolved');
    assert.deepStrictEqual(personal.readPersonalSnapshot({ ...f.options, userHome: f.otherHome }).works.map(w => w.id), ['TASK-002']);
    // A valid project this profile never bound is `no-bindings`, not a broken
    // namespace — with the store absent AND with the store holding another
    // project. Neither case may mutate or create anything.
    const second = path.join(f.root, 'wc2');
    fs.mkdirSync(path.join(second, '.gsd', 'tasks'), { recursive: true });
    const storeBytes = fs.readFileSync(storeFile);
    assert.strictEqual(personal.readPersonalSnapshot({ userHome: f.home, cwd: second }).reason, 'no-bindings');
    assert.deepStrictEqual(personal.readPersonalSnapshot({ userHome: f.home, cwd: second }).works, []);
    const unusedHome = path.join(f.root, 'carol');
    assert.strictEqual(personal.readPersonalSnapshot({ userHome: unusedHome, cwd: second }).reason, 'no-bindings');
    assert(!fs.existsSync(unusedHome), 'a no-bindings read created the personal namespace');
    assert.deepStrictEqual(fs.readFileSync(storeFile), storeBytes, 'a no-bindings read mutated the store');
    // The ambient directory may arrive relative; resolving it is the caller's
    // contract, not the operator's.
    const relative = path.relative(process.cwd(), f.project) || '.';
    assert.deepStrictEqual(personal.readPersonalSnapshot({ userHome: f.home, cwd: relative }).works.map(w => w.id), ['TASK-001']);
    assert.strictEqual(personal.bindWork({ ...f.options, id: '../../escape', intent: 'create' }).reason, 'invalid-id');
    assert.strictEqual(personal.bindWork({ ...f.options, id: 'TASK-001', intent: 'inspect' }).reason, 'intent-required');
    assert.strictEqual(personal.bindWork({ ...f.options, project: './wc', id: 'TASK-001', intent: 'create' }).status, 'error');
    const checkpoint = {
      pending: [{ text: 'UAT waiting for environment', source: a.source }],
      nextAction: [{ text: 'Wait for environment', source: a.source }],
      acceptances: [{ text: 'Plan approved', source: a.source, resolved: true }],
      lastResult: [{ text: 'Implementation verified', source: a.source }],
    };
    assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint }).status, 'ok');
    // Conditional saves compare the actual targeted captures under the same mutex.
    {
      const raw = () => Object.values(JSON.parse(fs.readFileSync(storeFile)).projects)[0].bindings['TASK-001'].checkpoint;
      const save = extra => personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: { pending: checkpoint.pending }, ...extra });
      const expected = { pending: raw().pending }, unrelated = raw().acceptances;
      assert.strictEqual(save({ expectedCheckpoint: expected }).status, 'ok');
      assert.deepStrictEqual(raw().acceptances, unrelated);
      const bytes = fs.readFileSync(storeFile), mtime = fs.statSync(storeFile).mtimeMs;
      for (const expectedCheckpoint of [{ pending: [] }, {}, { pending: [null] }]) {
        assert.strictEqual(save({ expectedCheckpoint }).status, 'error');
        assert.deepStrictEqual(fs.readFileSync(storeFile), bytes);
        assert.strictEqual(fs.statSync(storeFile).mtimeMs, mtime);
      }
      assert.strictEqual(save().status, 'ok', 'the default API still replaces slots without a precondition');
    }
    let work = personal.readPersonalSnapshot(f.options).works[0];
    assert.strictEqual(work.activity, 'inactive');
    assert.strictEqual(work.workStatus, 'pending');
    assert.strictEqual(work.nextAction.text, 'Wait for environment');
    assert.strictEqual(personal.selectPersonalWork(f.options).reason, 'attention-required');
    const before = fs.readFileSync(storeFile);
    for (let i = 0; i < 3; i++) personal.readPersonalSnapshot(f.options);
    assert.deepStrictEqual(fs.readFileSync(storeFile), before);
    fs.appendFileSync(a.source, 'Changed by authoritative workflow\n');
    work = personal.readPersonalSnapshot(f.options).works[0];
    assert.strictEqual(work.reliability, 'needs-reconciliation');
    assert.strictEqual(work.checkpoint.acceptances[0].text, 'Plan approved');
    assert.strictEqual(work.checkpoint.acceptances[0].validity, 'stale');
    assert.strictEqual(work.lastResult, null);
    fs.unlinkSync(a.source);
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].checkpoint.pending[0].validity, 'missing');
    assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: { nextAction: [{ text: 'escape', source: path.join(f.root, 'LAB-MANIFEST.json') }] } }).status, 'error');
    assert.deepStrictEqual(fs.readFileSync(storeFile), before);
    fs.writeFileSync(a.source, '---\nstatus: RUNNING\n---\nPlan\n');
    // A failed rename must preserve the previous store byte for byte.
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) { if (to === storeFile) throw Object.assign(new Error('publish denied'), { code: 'EACCES' }); return rename.apply(this, arguments); };
    try {
      assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: { pending: [] } }).reason, 'write-failed');
    } finally { fs.renameSync = rename; }
    assert.deepStrictEqual(fs.readFileSync(storeFile), before);
    const lock = require('./forge-lock');
    const release = lock.releaseHandle;
    lock.releaseHandle = handle => { release(handle); return { ok: false, reason: 'injected-cleanup-failure' }; };
    try {
      const partial = personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {} });
      assert.strictEqual(partial.status, 'partial');
      assert.strictEqual(partial.cleanup[0].reason, 'lock-release-failed');
    } finally { lock.releaseHandle = release; }
    assert.deepStrictEqual(fs.readFileSync(storeFile), before);
    fs.writeFileSync(storeFile, '{broken');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'corrupt');
    assert.strictEqual(personal.bindWork({ ...f.options, id: 'TASK-001', intent: 'create' }).reason, 'corrupt');
    assert.strictEqual(fs.readFileSync(storeFile, 'utf8'), '{broken');
    fs.writeFileSync(storeFile, '{"schemaVersion":99,"projects":{}}');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'schema-unsupported');
    fs.writeFileSync(storeFile, '{"schemaVersion":1,"projects":{"invalid":{}}}');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'schema-invalid');
    const malformedTypes = JSON.parse(before);
    Object.values(malformedTypes.projects)[0].aliases = [{ path: true, repo: f.project, branch: 'invalid' }];
    fs.writeFileSync(storeFile, JSON.stringify(malformedTypes));
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'schema-invalid');
    assert.strictEqual(personal.readPersonalSnapshot({ ...f.options, project: true }).reason, 'project-unanchored');
    fs.writeFileSync(storeFile, before);
    const malformedAlias = JSON.parse(before);
    Object.values(malformedAlias.projects)[0].aliases = [{ repo: f.otherHome, path: f.otherHome, branch: 'foreign' }];
    fs.writeFileSync(storeFile, JSON.stringify(malformedAlias));
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'schema-invalid');
    fs.writeFileSync(storeFile, before);
    const read = fs.readFileSync;
    fs.readFileSync = function (file) { if (file === storeFile) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return read.apply(this, arguments); };
    try { assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'unreadable'); } finally { fs.readFileSync = read; }
    // Atomic concurrent writers from independent processes retain both updates.
    f.work('TASK-003'); f.work('TASK-004');
    const results = await Promise.all(['TASK-003', 'TASK-004'].map(id => new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(__dirname, 'forge-personal-context.js'), '--bind', '--project', f.project, '--id', id, '--intent', 'create'], { env: f.env(), windowsHide: true });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; });
      child.on('close', code => resolve({ code, output }));
    })));
    for (const result of results) assert.strictEqual(result.code, 0, result.output);
    assert.deepStrictEqual(personal.readPersonalSnapshot(f.options).works.map(w => w.id).sort(), ['TASK-001', 'TASK-003', 'TASK-004']);
    assert.strictEqual(personal.selectPersonalWork(f.options).reason, 'selection-required');
    // Summary by itself does not complete a loose task; explicit final capture does.
    const summary = path.join(a.dir, 'TASK-001-SUMMARY.md');
    fs.writeFileSync(summary, '---\nstatus: DONE\n---\nVerified\n');
    assert.notStrictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'completed');
    assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {
      pending: [], nextAction: [], lastResult: [{ text: 'Task complete, UAT reconciled', source: summary, resolved: true }],
    } }).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'completed');
    // The latest acceptance supersedes history even when source/hash are unchanged.
    const accept = resolved => personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {
      acceptances: [{ text: 'Final UAT approval', source: summary, resolved }],
    } });
    assert.strictEqual(accept(false).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'pending');
    assert.strictEqual(accept(true).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'completed');
    assert.strictEqual(accept(false).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'pending');
    assert.strictEqual(accept(true).status, 'ok');
    const history = personal.readPersonalSnapshot(f.options).works[0].checkpoint.acceptances.filter(c => c.text === 'Final UAT approval');
    assert.deepStrictEqual(history.map(c => c.resolved), [false, true, false, true]);
    assert.strictEqual(new Set(history.map(c => c.hash)).size, 1);
    accept(true);
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].checkpoint.acceptances.length, 5);
    const run = path.join(f.project, '.gsd', 'forge', 'runs', 'TASK-003.json');
    fs.writeFileSync(run, '{broken');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works.find(w => w.id === 'TASK-003').reliability, 'run-corrupt');
    assert.strictEqual(personal.selectPersonalWork(f.options).selected.id, 'TASK-004');
    // Symlink/junction source escapes are rejected before opening target contents.
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret'), 'must not read');
    fs.symlinkSync(outside, path.join(f.project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: { nextAction: [{ text: 'unsafe', source: 'escape/secret' }] } }).status, 'error');
    const redirectedHome = path.join(f.root, 'redirected-home'); fs.mkdirSync(redirectedHome);
    fs.symlinkSync(path.join(f.otherHome, '.forge-personal'), path.join(redirectedHome, '.forge-personal'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(personal.readPersonalSnapshot({ ...f.options, userHome: redirectedHome }).reason, 'namespace-invalid');
    // Expose only validated, coherent milestone state to status consumers.
    const milestone = f.work('M005', 'milestone'); f.bind('M005');
    const validState = fs.readFileSync(milestone.source, 'utf8');
    const snapshotWork = () => personal.readPersonalSnapshot(f.options).works.find(w => w.id === 'M005');
    assert.strictEqual(snapshotWork().state.milestone, 'M005');
    fs.writeFileSync(milestone.source, validState.replace('milestone: M005', 'milestone: M006'));
    assert.strictEqual(snapshotWork().state, null);
    assert.strictEqual(snapshotWork().reliability, 'state-invalid');
    fs.writeFileSync(milestone.source, 'Unstructured state');
    assert.strictEqual(snapshotWork().state, null);
    assert.strictEqual(snapshotWork().reliability, 'state-invalid');
    fs.writeFileSync(milestone.source, validState);
    const stateReader = require('./forge-state');
    const readState = stateReader.read;
    try {
      stateReader.read = function (project, id) {
        if (id === 'M005') fs.appendFileSync(milestone.source, 'changed between reads');
        return readState.apply(this, arguments);
      };
      assert.strictEqual(snapshotWork().reliability, 'state-changed');
      assert.strictEqual(snapshotWork().state, null);
      stateReader.read = function (project, id) {
        if (id === 'M005') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        return readState.apply(this, arguments);
      };
      assert.strictEqual(snapshotWork().reliability, 'state-unreadable');
      assert.strictEqual(snapshotWork().state, null);
    } finally { stateReader.read = readState; }
    fs.writeFileSync(milestone.source, validState);
    personal.saveCheckpoint({ ...f.options, id: 'M005', intent: 'checkpoint', checkpoint: {
      nextAction: [{ text: 'Current personal action', source: milestone.source }],
    } });
    assert.strictEqual(snapshotWork().state.next_action, 'Current personal action');
    fs.appendFileSync(milestone.source, 'changed checkpoint source');
    assert.strictEqual(snapshotWork().state, null);
    assert.strictEqual(snapshotWork().reliability, 'needs-reconciliation');
    assert.strictEqual(snapshotWork().nextAction.validity, 'reconciliation-required');
    fs.unlinkSync(milestone.source);
    assert.strictEqual(snapshotWork().state, null);
    console.log('PASS personal context: isolation, evidence, corruption, atomic failure, concurrency and terminal reconciliation');
  } finally { f.cleanup(); }
}
module.exports = { fixture };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
