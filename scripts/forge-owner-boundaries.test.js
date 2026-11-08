'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const runs = require('./forge-runs'), controller = require('./forge-unit-controller'), state = require('./forge-state'), lease = require('./forge-unit-lease');
const root = path.resolve(__dirname, '..'), base = fs.realpathSync.native(os.tmpdir());
const lab = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'forge-owner-boundary-336-')));
const marker = 'owned-336-boundary-fixture'; fs.writeFileSync(path.join(lab, '.owner'), marker);
const id = 'M-20260801000000-controller-test', session = 'fixture-codex-thread-336';
const savedEnv = { thread: process.env.CODEX_THREAD_ID, session: process.env.CODEX_SESSION_ID };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
let serial = 0;
function identity(mode = 'matching') {
  delete process.env.CODEX_THREAD_ID; delete process.env.CODEX_SESSION_ID;
  if (mode !== 'none') { process.env.CODEX_THREAD_ID = mode === 'foreign' ? 'foreign-thread' : session; process.env.CODEX_SESSION_ID = 'secondary-session'; }
}
function setup(recordSession = session, duplicate = false) {
  const cwd = path.join(lab, 'owner-' + (++serial)); fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, '.gsd', 'milestones', id), { recursive: true });
  state.write(cwd, { milestone: id, kind: 'milestone', phase: 'execute-task', active_slice: 'S01', active_task: 'T01', next_action: 'execute', auto_mode: 'on' });
  runs.add(cwd, { id, kind: 'milestone', session_id: recordSession, host_runtime: 'codex', started_at: 1000, last_heartbeat: 1000 });
  if (duplicate) runs.add(cwd, { id: 'M002', kind: 'milestone', session_id: recordSession, host_runtime: 'codex', started_at: 1000, last_heartbeat: 1000 });
  return cwd;
}
const options = { prefsReader: () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } }) };
const request = (extra = {}) => ({ milestone: id, unit: 'execute-task/T01', host_runtime: 'codex', owner_token: 'boundary-owner', session: 'not-used-to-authorize-heartbeat', ...extra });
function complete(cwd, begin, extra = {}) {
  return controller.complete(cwd, request({ owner_token: begin.owner_token, generation: begin.generation, result: { status: 'succeeded', output: { files: [] } }, ...extra }), options);
}
function recordHash(cwd) { return sha(fs.readFileSync(runs.runFile(cwd, id))); }
function withoutIdentity() { const env = { ...process.env }; delete env.CODEX_THREAD_ID; delete env.CODEX_SESSION_ID; return env; }
function sourceDefinition(sourceId, input, planned = false) {
  return { source_id: sourceId, owner: 'fixture', inputs: [input], render_targets: [{ path: input, recursive: true }], capability: 'fixture-' + sourceId,
    security_role: 'internal', newline: 'lf', origin_header: 'fixture', common: { format: 'markdown' },
    ...(planned ? { conditional: { claude: { status: 'planned' }, codex: { status: 'planned' } } } : {}) };
}

async function main() {
  identity();
  const cwd = setup(), begun = controller.begin(cwd, request(), options);
  assert.equal(begun.ok, true);
  assert(runs.get(cwd, id).last_heartbeat > 1000, 'the REAL controller begin must observe the matching Codex owner before its lease/first prepare');
  const begunHeartbeat = runs.get(cwd, id).last_heartbeat;
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.gsd/forge/auto-mode.json'))).last_heartbeat, begunHeartbeat);

  // With a genuine protected lease window present, a second canonical boundary
  // is allowed to perform its own controller work but MUST NOT heartbeat the run.
  const window = lease.openProtectedWindow(cwd, 'execute-task/T01', begun.owner_token, begun.generation, { durationMs: 300000 });
  assert.equal(window.ok, true);
  const protectedRun = recordHash(cwd), aliasBytes = fs.readFileSync(path.join(cwd, '.gsd/forge/auto-mode.json'));
  const secondRequest = request({ unit: 'execute-task/T02', owner_token: 'second-owner', idempotency_key: 'second-begin' });
  const second = controller.begin(cwd, secondRequest, options); assert.equal(second.ok, true);
  assert.equal(recordHash(cwd), protectedRun);
  controller.complete(cwd, { ...secondRequest, owner_token: second.owner_token, generation: second.generation, idempotency_key: 'second-complete', result: { status: 'succeeded' } }, options);
  assert.equal(recordHash(cwd), protectedRun); assert(fs.readFileSync(path.join(cwd, '.gsd/forge/auto-mode.json')).equals(aliasBytes));
  assert.equal(window.check().ok, true); window.close();
  // Advance the measurement clock without sleeping; no worker was invoked.
  const originalNow = Date.now;
  let terminal;
  try { Date.now = () => originalNow() + 1000; terminal = complete(cwd, begun); }
  finally { Date.now = originalNow; }
  assert.equal(terminal.transaction.phase, 'committed'); assert.equal(lease.observe(cwd, 'execute-task/T01').lease, null);
  assert(runs.get(cwd, id).last_heartbeat > begunHeartbeat, 'terminal publication records owner activity only after lease release');
  console.log('PASS #336 real controller begin and terminal publication record matching owner activity; genuine active protected windows suppress all heartbeat writes');

  for (const scenario of [{ mode: 'none' }, { mode: 'foreign' }, { mode: 'matching', recorded: 'legacy-random-seed' }, { mode: 'matching', duplicate: true }]) {
    identity(scenario.mode); const target = setup(scenario.recorded || session, scenario.duplicate), before = recordHash(target);
    const begin = controller.begin(target, request(), options); assert.equal(begin.ok, true); complete(target, begin);
    assert.equal(recordHash(target), before, 'missing/mismatched/legacy/ambiguous identity remains unknown; request.session cannot authorize itself');
  }
  identity('none'); process.env.CODEX_SESSION_ID = 'fallback-session';
  assert.equal(runs.observeHostSession('codex').sessionId, 'fallback-session');
  identity(); assert.equal(runs.observeHostSession('codex').sessionId, session, 'thread identity has deterministic precedence, never selected to match a run');
  assert.equal(runs.observeHostSession('claude'), null);
  console.log('PASS #336 no-env, mismatched, legacy seed and ambiguous registry never heartbeat or adopt; thread/session precedence is independent of the run');

  // Actual installed Claude layouts contain the projected hook, never a
  // ~/.claude/scripts runtime. The shared core is resolved through forge-home.
  const installedHome = path.join(lab, 'installed-home');
  fs.mkdirSync(path.join(installedHome, '.claude/hooks'), { recursive: true });
  const projectedHooks = ['.claude/forge-hook.js', '.claude/hooks/forge-hook.js'].map(relative => {
    const file = path.join(installedHome, relative); fs.copyFileSync(path.join(__dirname, 'forge-hook.js'), file); return file;
  });
  const hookTemp = path.join(lab, 'installed-hook-temp'); fs.mkdirSync(hookTemp);
  for (const configured of [true, false]) {
    if (!configured) {
      const installedCore = path.join(installedHome, '.forge-agent');
      fs.mkdirSync(installedCore); fs.cpSync(path.join(root, 'scripts'), path.join(installedCore, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(installedCore, 'VERSION'), '4.49.7\n');
    }
    for (const projectedHook of projectedHooks) {
      const target = setup('installed-claude-owner'); runs.update(target, id, { host_runtime: 'claude' });
      const env = { ...process.env, USERPROFILE: installedHome, HOME: installedHome, TEMP: hookTemp, TMP: hookTemp, TMPDIR: hookTemp };
      delete env.FORGE_HOME; if (configured) env.FORGE_HOME = root;
      const observed = spawnSync(process.execPath, [projectedHook, 'subagent-start'], { input: JSON.stringify({ session_id: 'installed-claude-owner', cwd: target, agent_type: 'fixture', agent_id: 'fixture' }),
        env, encoding: 'utf8', timeout: 30000, windowsHide: true });
      assert.ifError(observed.error); assert.equal(observed.status, 0, observed.stderr);
      assert(runs.get(target, id).last_heartbeat > 1000, 'the installed hook must resolve the real core for ' + projectedHook);
      assert(!fs.existsSync(path.join(installedHome, '.claude/scripts')), 'no retired runtime path was manufactured');
    }
  }
  console.log('PASS #336 both real installed Claude hook layouts load runs/filelock from explicit or default canonical core without a retired runtime tree');

  // Exercise ACTUAL rendered activation commands from the current canonical
  // skills, not a hand-written replacement or a standalone regex assertion.
  const fixtureRepo = path.join(lab, 'renderer-source');
  for (const relative of ['agents', 'commands', 'skills', 'shared/templates/dispatch']) fs.mkdirSync(path.join(fixtureRepo, relative), { recursive: true });
  for (const skill of ['forge-auto', 'forge-task']) {
    fs.mkdirSync(path.join(fixtureRepo, 'skills', skill));
    fs.copyFileSync(path.join(root, 'skills', skill, 'SKILL.md'), path.join(fixtureRepo, 'skills', skill, 'SKILL.md'));
  }
  const renderer = require('./forge-codex-renderer');
  const manifest = { schema_version: '1.0.0', sources: [sourceDefinition('agents', 'agents', true), sourceDefinition('commands', 'commands', true), sourceDefinition('skills', 'skills'), sourceDefinition('dispatch-templates', 'shared/templates/dispatch', true)] };
  const rendered = renderer.render({ repo: fixtureRepo, manifest, projectRoot: path.join(lab, 'project'), userHome: path.join(lab, 'home'), codexHome: path.join(lab, 'home/.codex'), forgeHome: path.join(lab, 'home/.forge-agent'), ...renderer.PRODUCTION_DISPATCH_DIALECT });
  const auto = rendered.artifacts.find(item => item.kind === 'skill' && item.source.endsWith('forge-auto/SKILL.md')).content;
  const task = rendered.artifacts.find(item => item.kind === 'skill' && item.source.endsWith('forge-task/SKILL.md')).content;
  assert(!auto.includes('SESSION_ID="${CLAUDE_SESSION_ID:-') && !task.includes('SESSION_ID="${CLAUDE_SESSION_ID:-'));
  const sessionLine = auto.split('\n').find(line => /^\s*SESSION_ID=/.test(line));
  const addLine = auto.split('\n').find(line => line.includes('forge-runs.js" --add '));
  const updateLine = auto.split('\n').find(line => line.includes('forge-runs.js" --update '));
  for (const line of [addLine, updateLine]) assert(line.includes('--observed-owner --host-runtime codex'));
  const bash = process.env.FORGE_TEST_BASH || (process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe') : 'bash');
  if (process.platform === 'win32') assert(fs.existsSync(bash), 'actual projected shell caller requires the installed Git Bash');
  function activate(env, label) {
    const target = path.join(lab, label); fs.mkdirSync(target); fs.mkdirSync(path.join(target, '.gsd'));
    const child = spawnSync(bash, ['-c', 'set -e\n' + sessionLine + '\n' + addLine], { cwd: target, encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...env, FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'), WORKING_DIR: target.replace(/\\/g, '/'), RUN_ID: id, RUN_KIND: 'milestone', ISOLATION_MODE: 'shared', WORKTREES_JSON: '[]', RUN_BRANCH: '', FORGE_ACCOUNT: '' } });
    assert.ifError(child.error); return { child, target };
  }
  identity(); const activation = activate(process.env, 'actual-activation');
  assert.equal(activation.child.status, 0, activation.child.stderr);
  assert.equal(runs.get(activation.target, id).session_id, session); assert.equal(runs.get(activation.target, id).host_runtime, 'codex');
  assert.equal(runs.get(activation.target, id).owner_session_source, 'CODEX_THREAD_ID');
  const absent = activate(withoutIdentity(), 'missing-activation'); assert.notEqual(absent.child.status, 0);
  assert(!fs.existsSync(runs.runsDir(absent.target)), 'no host session means no run registration and no random identity');
  // R1: execute the actual projected resume command as well as activation.
  // This positive would otherwise silently become a legacy-negative test when
  // --update is separated from its value and the parser targets true.json.
  const sameOwnerResume = spawnSync(bash, ['-c', 'set -e\n' + sessionLine + '\n' + updateLine], { cwd: activation.target, encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'), WORKING_DIR: activation.target.replace(/\\/g, '/'), RUN_ID: id, ISOLATION_MODE: 'shared', WORKTREES_JSON: '[]', RUN_BRANCH: '' } });
  assert.ifError(sameOwnerResume.error); assert.equal(sameOwnerResume.status, 0, sameOwnerResume.stderr);
  assert.equal(runs.get(activation.target, id).session_id, session);
  assert(!fs.existsSync(runs.runFile(activation.target, 'true')), 'resume must address selected RUN_ID');
  runs.update(activation.target, id, { session_id: 'legacy-random-seed' }); const oldLegacy = recordHash(activation.target);
  const resume = spawnSync(bash, ['-c', 'set -e\n' + sessionLine + '\n' + updateLine], { cwd: activation.target, encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'), WORKING_DIR: activation.target.replace(/\\/g, '/'), RUN_ID: id, ISOLATION_MODE: 'shared', WORKTREES_JSON: '[]', RUN_BRANCH: '' } });
  assert.notEqual(resume.status, 0); assert.equal(recordHash(activation.target), oldLegacy, 'explicit resume does not silently adopt an unbound legacy seed');
  console.log('PASS #336 current Codex renderer activation executes the real observed-session CLI through Git Bash; no-env and legacy mismatch refuse before registration or adoption');

  // Execute the installed SessionStart bridge, then the ACTUAL Claude-rendered
  // skill shell after the documented native session substitution. The bridge
  // alone cannot authorize a stale parent session inherited by a nested host.
  const claudeRenderer = require('./forge-claude-renderer');
  const claudeRendered = claudeRenderer.render({ repo: fixtureRepo, manifest, projectRoot: path.join(lab, 'claude-project'), userHome: installedHome, forgeHome: root });
  const claudeAuto = claudeRendered.artifacts.find(item => item.source.endsWith('forge-auto/SKILL.md')).content;
  const claudeSessionLine = claudeAuto.split('\n').find(line => /^\s*SESSION_ID=/.test(line));
  const claudeAddLine = claudeAuto.split('\n').find(line => line.includes('forge-runs.js" --add '));
  assert(claudeSessionLine.includes("--expected-owner-session '${CLAUDE_SESSION_ID}'"));
  const settingsFile = path.join(installedHome, '.claude/settings.json');
  const merge = spawnSync(process.execPath, [path.join(__dirname, 'merge-settings.js'), settingsFile], { encoding: 'utf8', env: { ...process.env, HOME: installedHome, USERPROFILE: installedHome, FORGE_HOME: root }, windowsHide: true });
  assert.equal(merge.status, 0, merge.stderr);
  const settings = JSON.parse(fs.readFileSync(settingsFile));
  assert(JSON.stringify(settings.hooks.SessionStart).includes('forge-hook.js session-start'), 'the actual installer settings wire SessionStart');
  function claudeActivate({ label, native = 'claude-current-336', payload = native, event = 'SessionStart', bridge = true, source = true }) {
    const target = path.join(lab, label); fs.mkdirSync(target); fs.mkdirSync(path.join(target, '.gsd'));
    const envFile = path.join(lab, label + '.env'); fs.writeFileSync(envFile, "export KEEP_OTHER_HOOK='preserved'\n");
    const env = { ...withoutIdentity(), FORGE_HOME: root, HOME: installedHome, USERPROFILE: installedHome, TEMP: hookTemp, TMP: hookTemp };
    delete env.CLAUDE_SESSION_ID; delete env.FORGE_CLAUDE_OWNER_SESSION_ID; delete env.FORGE_CLAUDE_OWNER_SOURCE;
    if (bridge) env.CLAUDE_ENV_FILE = envFile; else delete env.CLAUDE_ENV_FILE;
    const invoked = spawnSync(process.execPath, [projectedHooks[0], 'session-start'], { encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: event, session_id: payload, cwd: target }), timeout: 30000, windowsHide: true });
    assert.ifError(invoked.error); assert.equal(invoked.status, 0, invoked.stderr);
    const contents = fs.readFileSync(envFile, 'utf8'); assert(contents.startsWith("export KEEP_OTHER_HOOK='preserved'\n"));
    const lines = (claudeSessionLine + '\n' + claudeAddLine).replaceAll('${CLAUDE_SESSION_ID}', native);
    const child = spawnSync(bash, ['-c', 'set -e\n' + (source ? 'source "$FIXTURE_ENV_FILE"\n' : '') + lines], { cwd: target, encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...env, FIXTURE_ENV_FILE: envFile.replace(/\\/g, '/'), FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'), WORKING_DIR: target.replace(/\\/g, '/'), RUN_ID: id, RUN_KIND: 'milestone', ISOLATION_MODE: 'shared', WORKTREES_JSON: '[]', RUN_BRANCH: '', FORGE_ACCOUNT: '' } });
    assert.ifError(child.error); return { target, child, contents };
  }
  const currentClaude = claudeActivate({ label: 'claude-actual-activation' });
  assert.equal(currentClaude.child.status, 0, currentClaude.child.stderr);
  assert.equal(runs.get(currentClaude.target, id).session_id, 'claude-current-336');
  assert.equal(runs.get(currentClaude.target, id).host_runtime, 'claude');
  assert.equal(runs.get(currentClaude.target, id).owner_session_source, 'claude-sessionstart-env-v1');
  const claudeUpdateLine = claudeAuto.split('\n').find(line => line.includes('forge-runs.js" --update '));
  const claudeResumeScript = (claudeSessionLine + '\n' + claudeUpdateLine).replaceAll('${CLAUDE_SESSION_ID}', 'claude-current-336');
  const claudeResume = spawnSync(bash, ['-c', 'set -e\nsource "$FIXTURE_ENV_FILE"\n' + claudeResumeScript], { cwd: currentClaude.target, encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...withoutIdentity(), FORGE_HOME: root, HOME: installedHome, USERPROFILE: installedHome,
      FIXTURE_ENV_FILE: path.join(lab, 'claude-actual-activation.env').replace(/\\/g, '/'),
      FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'), WORKING_DIR: currentClaude.target.replace(/\\/g, '/'), RUN_ID: id,
      ISOLATION_MODE: 'shared', WORKTREES_JSON: '[]', RUN_BRANCH: '' } });
  assert.ifError(claudeResume.error); assert.equal(claudeResume.status, 0, claudeResume.stderr);
  assert.equal(runs.get(currentClaude.target, id).session_id, 'claude-current-336');
  assert(!fs.existsSync(runs.runFile(currentClaude.target, 'true')), 'Claude resume must address selected RUN_ID');
  console.log('PASS #336 R1 actual rendered resume commands succeed for the same owner in both hosts and address the selected run');

  // The explicit-target updater does not perform the implicit hook lookup.
  runs.add(activation.target, { id:'M002', kind:'milestone', session_id:session, host_runtime:'codex' });
  // activation.target was intentionally changed to a legacy seed earlier;
  // restore the original observed owner only as explicit fixture setup.
  runs.update(activation.target,id,{session_id:session,host_runtime:'codex',owner_session_source:'CODEX_THREAD_ID',active:true});
  const multiOwnerActual = spawnSync(bash,['-c','set -e\n'+sessionLine+'\n'+updateLine],{cwd:activation.target,encoding:'utf8',windowsHide:true,
    env:{...process.env,FORGE_SCRIPTS_DIR:__dirname.replace(/\\/g,'/'),WORKING_DIR:activation.target.replace(/\\/g,'/'),RUN_ID:id,ISOLATION_MODE:'shared',WORKTREES_JSON:'[]',RUN_BRANCH:''}});
  assert.equal(multiOwnerActual.status,0,multiOwnerActual.stderr);
  assert.equal(runs.resolveBySessionOwner(activation.target,runs.observeHostSession('codex')),null,'implicit hooks still refuse two active bindings');

  function ownerFixture(runtime,label) {
    const target=setup(runtime==='codex'?session:'claude-current-336');
    runs.update(target,id,{host_runtime:runtime,owner_session_source:runtime==='codex'?'CODEX_THREAD_ID':'claude-sessionstart-env-v1'});
    const begin=controller.begin(target,request({host_runtime:runtime,idempotency_key:label+'-begin'}),options);
    assert.equal(begin.ok,true); complete(target,begin,{host_runtime:runtime,idempotency_key:label+'-complete'});
    return target;
  }
  function resumeEnv(runtime,target) {
    return {...(runtime==='codex'?process.env:withoutIdentity()),FORGE_HOME:root,HOME:installedHome,USERPROFILE:installedHome,
      FIXTURE_ENV_FILE:path.join(lab,'claude-actual-activation.env').replace(/\\/g,'/'),FORGE_SCRIPTS_DIR:__dirname.replace(/\\/g,'/'),
      WORKING_DIR:target.replace(/\\/g,'/'),RUN_ID:id};
  }
  function actualOwnerResume(runtime,target,kind) {
    const projected=runtime==='codex'?auto:claudeAuto;
    const inspectLine=projected.split('\n').find(line=>line.trim().startsWith('OWNER_RESUME=$(node'));
    const shaLine=projected.split('\n').find(line=>line.trim().startsWith('OWNER_RESUME_SHA='));
    const op=projected.split('\n').find(line=>line.includes('forge-runs.js" --resume-owner ') && line.includes('--confirm-owner-stopped')===(kind==='transfer'));
    assert(inspectLine&&shaLine&&op,'actual projected owner-resume caller exists');
    let script=[inspectLine,shaLine,op].join('\n');
    if(runtime==='claude')script='source "$FIXTURE_ENV_FILE"\n'+script.replaceAll('${CLAUDE_SESSION_ID}','claude-current-336');
    return spawnSync(bash,['-c','set -e\n'+script],{cwd:target,encoding:'utf8',timeout:30000,windowsHide:true,env:resumeEnv(runtime,target)});
  }
  for(const runtime of ['codex','claude']) {
    const same=ownerFixture(runtime,'reactivate-'+runtime);runs.update(same,id,{active:false});
    const before=recordHash(same);const reactivated=actualOwnerResume(runtime,same,'reactivate');
    assert.equal(reactivated.status,0,reactivated.stderr);assert.notEqual(recordHash(same),before);
    const sameRecord=runs.get(same,id);assert.equal(sameRecord.active,true);assert.equal(sameRecord.owner_resume_history.at(-1).kind,'same-owner-reactivation');
    assert.equal(sameRecord.owner_resume_history.at(-1).previous_owner_stopped_attested,false,'same owner never attests its own death');
    const foreign=ownerFixture(runtime,'transfer-'+runtime);
    runs.update(foreign,id,{session_id:'prior-owner-with-ended-tenure',active:false});
    const saved=recordHash(foreign), env=resumeEnv(runtime,foreign), expected=runtime==='claude'?['--expected-owner-session','claude-current-336']:[];
    if(runtime==='claude'){env.FORGE_CLAUDE_OWNER_SESSION_ID='claude-current-336';env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';}
    const cli=(args)=>spawnSync(process.execPath,[path.join(__dirname,'forge-runs.js'),...args,'--observed-owner','--host-runtime',runtime,...expected,'--cwd',foreign],{encoding:'utf8',env,windowsHide:true});
    const inspection=cli(['--inspect-owner-resume',id]);assert.equal(inspection.status,0,inspection.stderr);const snapshot=JSON.parse(inspection.stdout).record_sha256;
    const denied=cli(['--resume-owner',id,'--expected-record-sha256',snapshot,'--confirm-workspace-quiescent']);
    assert.notEqual(denied.status,0);assert(denied.stderr.includes('owner-resume-owner-stop-attestation-required'));assert.equal(recordHash(foreign),saved,'inactive is not prior-owner termination');
    const imported=cli(['--resume-owner',id,'--expected-record-sha256',snapshot,'--json','{"approved":true,"confirmOwnerStopped":true,"confirmWorkspaceQuiescent":true}']);
    assert.notEqual(imported.status,0);assert.equal(recordHash(foreign),saved);
    // Trusted fixture host explicitly attests an ended prior tenure and no
    // process/receipt/root writer. These are fixture attestations, not OS proof.
    const transferred=actualOwnerResume(runtime,foreign,'transfer');assert.equal(transferred.status,0,transferred.stderr);
    const record=runs.get(foreign,id);assert.equal(record.session_id,runtime==='codex'?session:'claude-current-336');
    assert.equal(record.owner_resume_history.at(-1).kind,'stopped-owner-transfer');assert.equal(record.owner_resume_history.at(-1).os_process_death_proven,false);
    const stale=cli(['--resume-owner',id,'--expected-record-sha256',snapshot,'--confirm-owner-stopped','--confirm-workspace-quiescent']);
    assert.notEqual(stale.status,0);assert(stale.stderr.includes('owner-resume-snapshot-changed'));
  }
  identity();
  const negativeFixture=(label,patch={})=>{const target=ownerFixture('codex','negative-'+label);runs.update(target,id,{session_id:'prior-ended-'+label,active:false,...patch});return target;};
  const resumeOptions=target=>({hostRuntime:'codex',expectedRecordSha256:runs.inspectOwnerResume(target,id,{hostRuntime:'codex'}).record_sha256,confirmOwnerStopped:true,confirmWorkspaceQuiescent:true});
  const untouched=(target,options,reason)=>{const before=recordHash(target);assert.throws(()=>runs.resumeOwner(target,id,options),e=>e.code===reason,reason);assert.equal(recordHash(target),before,reason+' preserves registry');};
  const held=negativeFixture('lease'), heldOptions=resumeOptions(held);
  const acquired=lease.acquire(held,'execute-task/T88',{ownerToken:'active-writer-owner',hostRuntime:'codex',session:'active-worker',requestId:'active-worker-request'});
  assert.equal(acquired.ok,true);
  untouched(held,heldOptions,'owner-resume-lease-present');
  const leaseFile=lease.leaseFile(held,'execute-task/T88'),leaseBytes=fs.readFileSync(leaseFile);
  assert.equal(lease.release(held,'execute-task/T88','active-writer-owner',acquired.generation).ok,true);
  assert.equal(leaseBytes.length>0,true,'actual active lease was preserved until its owner released it');
  const staleLease=negativeFixture('expired-lease');const expired=lease.acquire(staleLease,'execute-task/T89',{ownerToken:'expired-owner',hostRuntime:'codex',now:()=>1,ttlMs:2,graceMs:1});assert.equal(expired.ok,true);
  assert.equal(lease.readLease(lease.leaseFile(staleLease,'execute-task/T89')).record.expires_at,3,'the negative uses a genuinely expired retained lease');
  untouched(staleLease,resumeOptions(staleLease),'owner-resume-lease-present');
  for(const[patch,reason]of [[{write_claim:{at:1,unit:'execute-task/T01',paths:['src/a.js'],released:null}},'owner-resume-claim-held'],[{write_claim:false},'owner-resume-claim-held'],[{worker:'execute-task/T88',worker_started:1},'owner-resume-worker-unreconciled']]){
    const target=negativeFixture(reason,patch);untouched(target,resumeOptions(target),reason);
  }
  const legacy=negativeFixture('legacy',{owner_session_source:null}), legacyHash=recordHash(legacy);
  assert.throws(()=>runs.inspectOwnerResume(legacy,id,{hostRuntime:'codex'}),/owner-resume-binding-unknown/);assert.equal(recordHash(legacy),legacyHash);
  const livePrior=negativeFixture('active-prior',{active:true}), liveOpts=resumeOptions(livePrior);delete liveOpts.confirmOwnerStopped;
  untouched(livePrior,liveOpts,'owner-resume-owner-stop-attestation-required');
  const sameInactive=ownerFixture('codex','workspace-attestation');runs.update(sameInactive,id,{active:false});
  untouched(sameInactive,{hostRuntime:'codex',expectedRecordSha256:runs.inspectOwnerResume(sameInactive,id,{hostRuntime:'codex'}).record_sha256},'owner-resume-workspace-quiescent-attestation-required');
  const lockTarget=negativeFixture('file-lock');fs.mkdirSync(path.join(lockTarget,'.gsd/forge/file-locks'),{recursive:true});fs.writeFileSync(path.join(lockTarget,'.gsd/forge/file-locks/unknown.json'),'{}');
  untouched(lockTarget,resumeOptions(lockTarget),'owner-resume-file-lock-present');
  const debris=negativeFixture('transaction-debris');fs.writeFileSync(path.join(controller.transactionDir(debris),'unknown.tmp'),'unknown');
  untouched(debris,resumeOptions(debris),'owner-resume-transactions-unknown');
  const noBoundary=setup('prior-legacy-with-binding');runs.update(noBoundary,id,{owner_session_source:'CODEX_THREAD_ID',active:false});
  untouched(noBoundary,resumeOptions(noBoundary),'owner-resume-boundary-required');
  const pendingTarget=negativeFixture('pending');
  const pending=controller.begin(pendingTarget,request({unit:'execute-task/T03',idempotency_key:'pending-begin'}),options);assert.equal(pending.ok,true);
  assert.throws(()=>controller.pause(pendingTarget,request({unit:'execute-task/T03',owner_token:pending.owner_token,generation:pending.generation,idempotency_key:'pending-pause'}),{...options,failpoint:point=>point==='after-intent'}),e=>e.code==='CONTROLLER_FAILPOINT');
  assert.equal(lease.release(pendingTarget,'execute-task/T03',pending.owner_token,pending.generation).ok,true,'fixture owner releases its own lease after controlled interruption');
  untouched(pendingTarget,resumeOptions(pendingTarget),'owner-resume-transaction-pending');
  const raced=negativeFixture('snapshot-race'), staleOptions=resumeOptions(raced);runs.update(raced,id,{last_heartbeat:Date.now()+1});
  untouched(raced,staleOptions,'owner-resume-snapshot-changed');
  const mutexTarget=negativeFixture('mutex-race'),mutexOptions=resumeOptions(mutexTarget), lock=require('./forge-lock');
  const controllerMutex=lock.acquireProcessSync(mutexTarget,'unit-controller-transactions',{retries:1});
  try {
    const prior=recordHash(mutexTarget), blocked=spawnSync(process.execPath,[path.join(__dirname,'forge-runs.js'),'--resume-owner',id,'--observed-owner','--host-runtime','codex','--expected-record-sha256',mutexOptions.expectedRecordSha256,'--confirm-owner-stopped','--confirm-workspace-quiescent','--cwd',mutexTarget],{encoding:'utf8',env:process.env,timeout:5000,windowsHide:true});
    assert.notEqual(blocked.status,0);assert.equal(recordHash(mutexTarget),prior,'controller-held publication fence excludes concurrent resume');
  } finally {controllerMutex.release();}
  const preserved=negativeFixture('questions',{pending_questions:[{id:'decision-live',status:'pending',question:'existing decision'}]});
  const receipt=path.join(preserved,'.gsd','retained.receipt.json');fs.writeFileSync(receipt,'{"phase":"published","fixture":"already-reconciled"}\n');const receiptHash=sha(fs.readFileSync(receipt));
  const transferred=runs.resumeOwner(preserved,id,resumeOptions(preserved));assert.equal(transferred.status,'transferred');
  assert.deepEqual(transferred.record.pending_questions,[{id:'decision-live',status:'pending',question:'existing decision'}]);assert.equal(sha(fs.readFileSync(receipt)),receiptHash);
  process.env.CODEX_THREAD_ID='prior-ended-questions';
  const former=runs.observeHostSession('codex'), afterTransfer=recordHash(preserved);assert.equal(runs.bumpOwnedHeartbeat(preserved,id,former).updated,false);
  const oldUpdate=spawnSync(process.execPath,[path.join(__dirname,'forge-runs.js'),'--update',id,'--observed-owner','--host-runtime','codex','--json','{"active":true}','--cwd',preserved],{encoding:'utf8',env:process.env,windowsHide:true});
  assert.notEqual(oldUpdate.status,0);assert.equal(recordHash(preserved),afterTransfer,'former owner cannot use ordinary update or heartbeat');identity();
  console.log('PASS #336 R2 real active/expired leases, controller mutex and snapshot races, retained worker/claim, unknown legacy binding and preserved pending questions/receipt all retain their gates');
  console.log('PASS #336 R2 actual rendered reactivation/transfer in both hosts, inactive foreign refusal, imported JSON refusal, stale snapshot and explicit multi-run target');

  for (const scenario of [
    { label: 'claude-no-channel', bridge: false }, { label: 'claude-no-source', source: false },
    { label: 'claude-stale-parent', native: 'current-child', payload: 'stale-parent' },
    { label: 'claude-unexpanded', native: '${CLAUDE_SESSION_ID}', payload: 'claude-current-336' },
    { label: 'claude-foreign-event', event: 'SubagentStart' },
    { label: 'claude-unsafe-id', native: 'unsafe;session', payload: 'unsafe;session' },
  ]) {
    const result = claudeActivate(scenario); assert.notEqual(result.child.status, 0, scenario.label);
    assert(!fs.existsSync(runs.runsDir(result.target)), 'no imported or missing identity creates a run: ' + scenario.label);
  }
  // An imported JSON value/approval and legacy CLAUDE_SESSION_ID alone are not
  // the host bridge. The observed mode remains closed before any registration.
  const importedEnv = { ...withoutIdentity(), CLAUDE_SESSION_ID: 'imported-owner' };
  delete importedEnv.FORGE_CLAUDE_OWNER_SESSION_ID; delete importedEnv.FORGE_CLAUDE_OWNER_SOURCE;
  const importedTarget = path.join(lab, 'imported-claude'); fs.mkdirSync(importedTarget);
  const imported = spawnSync(process.execPath, [path.join(__dirname, 'forge-runs.js'), '--add', '--id', id, '--kind', 'milestone', '--observed-owner', '--host-runtime', 'claude', '--expected-owner-session', 'imported-owner', '--session', 'imported-owner', '--json', JSON.stringify({ approved: true, owner_session_source: 'claude-sessionstart-env-v1', session_id: 'imported-owner' }), '--cwd', importedTarget], { encoding: 'utf8', env: importedEnv, windowsHide: true });
  assert.notEqual(imported.status, 0); assert(!fs.existsSync(runs.runsDir(importedTarget)));
  // The standalone skill has its own actual activation surface. Exercise both
  // renderer projections so its registration cannot regress independently.
  for (const runtime of ['codex', 'claude']) {
    const text = runtime === 'codex' ? task : claudeRendered.artifacts.find(item => item.source.endsWith('forge-task/SKILL.md')).content;
    let lines = text.split('\n').filter(line => /^\s*SESSION_ID=/.test(line) || line.includes('forge-runs.js" --add ')).join('\n');
    if (runtime === 'claude') lines = lines.replaceAll('${CLAUDE_SESSION_ID}', 'claude-task-336');
    const target = path.join(lab, 'actual-task-' + runtime); fs.mkdirSync(target); fs.mkdirSync(path.join(target, '.gsd'));
    const env = { ...process.env, FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'), TASK_ID: 'T-20261108000000-owner-test', TASK_DESCRIPTION: 'owner fixture', ISOLATION_MODE: 'shared', WORKTREES_JSON: '[]', FORGE_ACCOUNT: '', RUN_BRANCH: '' };
    if (runtime === 'claude') { env.FORGE_CLAUDE_OWNER_SESSION_ID = 'claude-task-336'; env.FORGE_CLAUDE_OWNER_SOURCE = 'claude-sessionstart-env-v1'; }
    const started = spawnSync(bash, ['-c', 'set -e\n' + lines], { cwd: target, env, encoding: 'utf8', windowsHide: true });
    assert.equal(started.status, 0, started.stderr);
    const registered = runs.get(target, 'T-20261108000000-owner-test'); assert.equal(registered.host_runtime, runtime);
    assert.equal(registered.session_id, runtime === 'codex' ? session : 'claude-task-336');
  }
  console.log('PASS #336 real installed SessionStart plus Claude-rendered activation bind current native identity; absent, stale, unexpanded, unsafe and imported evidence never registers');

  // The real native prepare/start captures the heartbeat already written by
  // controller.begin. Preparing and opening a manifest perform no new pulse.
  identity();
  const fixtures = require('./forge-native-recovery-delivery.test');
  const f = await fixtures.fixture({ runId: 'M901', beforeBegin: selected => runs.update(selected.owner, 'M901', { session_id: session, host_runtime: 'codex', last_heartbeat: 1000 }) });
  try {
    assert(runs.get(f.owner, 'M901').last_heartbeat > 1000);
    const side = require('./forge-unit-sidecar'), handoff = await side.recoverUnitSidecar(f.request, f.recovery, f.runtime), current = handoff.result.request;
    const caps = require('./forge-recovery-transition.test').capabilities;
    const binding = require('./forge-native-invocation').buildNativeInvocation({ hostRuntime: 'codex', resolvedDispatch: current.route, activeCapabilities: caps, prompt: 'Owner boundary consistency fixture; no worker.', forkTurns: 'none', taskName: 'owner_boundary', agentType: 'forge-executor' });
    const leaseRecord = lease.observe(f.owner, 'execute-task/T01').lease;
    const protectedWindow = lease.openProtectedWindow(f.owner, 'execute-task/T01', 'fixture-owner', leaseRecord.generation, { durationMs: 300000 }); assert.equal(protectedWindow.ok, true);
    const beforeRun = fs.readFileSync(runs.runFile(f.owner, 'M901'));
    const sessionApi = require('./forge-native-recovery-delivery').prepare({ request: current, nativeInvocation: binding, assertBoundary: f.assertBoundary, assertAuthority: f.assertBoundary, persistDeliveryReceipt: () => {} });
    const prepared = sessionApi.manifest();
    assert.equal(prepared.prepared.protected_owner['.gsd/forge/runs/M901.json'], sha(beforeRun));
    sessionApi.start();
    assert(fs.existsSync(current.resultFile + '.manifest.json')); assert(fs.readFileSync(runs.runFile(f.owner, 'M901')).equals(beforeRun));
    assert.equal(protectedWindow.check().ok, true); protectedWindow.close();
    console.log('PASS #336 real native prepare/manifest preserves the earlier boundary heartbeat and all protected owner bytes without worker inference');
  } finally { f.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of [['CODEX_THREAD_ID', savedEnv.thread], ['CODEX_SESSION_ID', savedEnv.session]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(fs.realpathSync.native(lab), lab); assert.equal(path.dirname(lab), base); assert.equal(fs.readFileSync(path.join(lab, '.owner'), 'utf8'), marker);
  fs.rmSync(lab, { recursive: true });
});
