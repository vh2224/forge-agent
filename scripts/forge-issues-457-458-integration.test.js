'use strict';

// Real Git worktree + real owner/controller/delivery APIs. Provider inference is
// replaced only by a local protocol process/native callback in this fixture.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const os = require('os');
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });

async function main() {
  const saved = { ...process.env }, home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-checkup-home-')));
  const homeMarker = crypto.randomBytes(16).toString('hex'); put(path.join(home, '.fixture-home-owner'), homeMarker);
  let passed = false, f = null, accounts = null, launch = null, fixtureLaunches = 0;
  try {
    // Account storage paths and the adapter's destructured resolver are fixed
    // at module load. Bootstrap both isolation and the stub BEFORE any Forge
    // imports, not merely before calling the transport.
    Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: path.join(home, 'core'), CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_THREAD_ID: 'session-one', FORGE_KEYCHAIN_DISABLED: '1' });
    fs.mkdirSync(process.env.CODEX_HOME); fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
    assert.equal(require.cache[require.resolve('./forge-accounts')], undefined, 'run this fixture in a fresh isolated process');
    assert.equal(require.cache[require.resolve('./forge-claude-sidecar')], undefined, 'mock accounts before adapter import');
    accounts = require('./forge-accounts'); launch = accounts.resolveLaunch;
    accounts.resolveLaunch = () => { fixtureLaunches++; return { name: 'fixture', token: 'fixture-only' }; };
    const install = path.resolve(__dirname, '..'), manifest = JSON.parse(fs.readFileSync(path.join(install, 'shared/forge-procedures.json'), 'utf8'));
    put(path.join(process.env.FORGE_HOME, 'shared/forge-procedures.json'), JSON.stringify(manifest));
    for (const module of manifest.modules.filter(row => row.status === 'ready')) put(path.join(process.env.FORGE_HOME, module.path), fs.readFileSync(path.join(install, module.path), 'utf8'));
    const lab = require('./forge-code-roots.test'), roots = require('./forge-code-roots'), runs = require('./forge-runs'), claims = require('./forge-write-claim');
    const controller = require('./forge-unit-controller'), orchestrate = require('./forge-orchestrate'), clock = require('./forge-milestone-time-clock');
    const delivery = require('./forge-delivery'), side = require('./forge-unit-sidecar'), repairApi = require('./forge-completion-delivery-recovery'), fixtureDelivery = require('./fixtures/completion-delivery.cjs');
    f = lab.laboratory('issues-457-458');
    const owner = lab.checkout(path.join(f.dir, 'owner'));
    put(path.join(owner, '.gitignore'), '.gsd/\nnode_modules/\n*.tsbuildinfo\ncoverage/\n');
    lab.command('git', ['add', '.gitignore'], owner);
    lab.command('git', ['commit', '-qm', 'fixture ignore policy'], owner);
    const code = path.join(f.dir, 'worktree');
    lab.command('git', ['worktree', 'add', '-qb', 'fixture-worktree', code], owner);
    const originalHead = lab.command('git', ['rev-parse', 'HEAD'], code);
    const milestone = 'M001', slice = 'S01', ownerToken = 'fixture-owner', tasks = ['T01', 'T02', 'T03', 'T04', 'T05'];
    const base = `.gsd/milestones/${milestone}`, sliceBase = `${base}/slices/${slice}`;
    const prefs = { auto_commit: false, workflow: { skip_discuss: true, skip_research: true }, tier_models: { standard: ['gpt-6.1-sol', 'claude-sonnet-5'] }, effort: { 'execute-task': 'medium' } };
    put(path.join(owner, '.gsd/forge-prefs.jsonc'), prefs);
    put(path.join(owner, base, milestone + '-ROADMAP.md'), '# Roadmap\n- [ ] **S01: Uncommitted worktree** `depends:[]`\n');
    put(path.join(owner, base, milestone + '-CONTEXT.md'), '# Context\nNo time contract; preserve the uncommitted worktree.\n');
    put(path.join(owner, sliceBase, slice + '-PLAN.md'), '# Slice\n' + tasks.map(task => `- [ ] **${task}** — fixture`).join('\n') + '\n');
    put(path.join(owner, sliceBase, slice + '-CONTEXT.md'), '# Context\nExercise historical deliveries and physical roots.\n');
    put(path.join(owner, sliceBase, slice + '-RESEARCH.md'), '# Research\nOnly private fixture paths are used.\n');
    const contract = roots.singleContract(owner, code);
    runs.add(owner, { id: milestone, kind: 'milestone', session_id: process.env.CODEX_THREAD_ID, host_runtime: 'codex', owner_session_source: 'CODEX_THREAD_ID', root: owner, cwd: owner, branch: 'fixture-worktree', isolation_mode: 'worktree', worktrees: [{ repo: owner, path: code }], code_dir: code, execution_contract: contract });
    require('./forge-state').write(owner, { milestone, kind: 'milestone', phase: 'idle', active_slice: slice, active_task: '—', auto_mode: 'on' });
    const commandFor = task => 'node check.cjs ' + task;
    put(path.join(code, 'check.cjs'), "const a=require('assert');a.equal(require('./src/'+process.argv[2]+'.js'),1);console.log('PASS milestone fixture');\n");
    for (const task of tasks) {
      const writes = task === 'T04' ? ['src/**', 'node_modules/**', 'package-lock.json'] : [`src/${task}.js`];
      const plan = `---\nid: ${task}\ntier: standard\neffort: medium\ncapability: workspace\n${task === 'T03' ? 'worker: claude\n' : ''}depends: []\nwrites: [${writes.join(', ')}]\nexpected_output: [src/${task}.js]\nverify: '${commandFor(task)}'\nmust_haves:\n  truths: [Fixture exports one]\n  artifacts:\n    - path: src/${task}.js\n      provides: Fixture module\n      min_lines: 1\n  key_links: []\n---\n# ${task}\nExercise the claimed private worktree.\n`;
      put(path.join(owner, sliceBase, 'tasks', task, task + '-PLAN.md'), plan);
      put(path.join(owner, sliceBase, 'tasks', task, task + '-SECURITY.md'), '# Security\nPrivate fixture only; preserve owner and claims.\n');
    }
    const input = { cwd: owner, milestone, host_runtime: 'codex', owner_token: ownerToken, prefsReader };
    const options = { prefsReader };
    function recordClaim(task) {
      const paths = task === 'T04' ? ['src/**', 'node_modules/**', 'package-lock.json'] : [`src/${task}.js`];
      return claims.recordClaim(owner, milestone, { schema_version: 2, source: 'plan-writes', unit: 'execute-task/' + task, execution_contract: contract, paths: paths.map(file => ({ root_id: contract.primary_root_id, path: file })) });
    }
    function next(expected) {
      const out = orchestrate.next(input, options);
      assert.equal(out.outcome, 'completed', JSON.stringify(out));
      assert.equal(out.unit.key, expected, JSON.stringify(out));
      return out;
    }
    function complete(selected) {
      const out = orchestrate.run('complete', { ...input, unit: selected.unit, begin_key: selected.details.transaction.idempotency_key, result: { status: 'done' } }, options);
      assert.equal(out.outcome, 'completed', JSON.stringify(out));
      return out;
    }
    function transfer(name) {
      const before = JSON.stringify(runs.get(owner, milestone).write_claim);
      process.env.CODEX_THREAD_ID = name;
      const observed = runs.inspectOwnerResume(owner, milestone, { hostRuntime: 'codex', expectedSession: name });
      const changed = runs.resumeOwner(owner, milestone, { hostRuntime: 'codex', expectedSession: name, expectedRecordSha256: observed.record_sha256, confirmOwnerStopped: true, confirmWorkspaceQuiescent: true });
      assert.equal(changed.status, 'transferred');
      assert.equal(JSON.stringify(runs.get(owner, milestone).write_claim), before, 'transfer preserves the retained dirty claim bytes');
    }

    // Preserve the historical buggy completion and verify-only successor.
    recordClaim('T01');
    put(path.join(code, 'src/T01.js'), 'module.exports = 1;\n');
    const first = next('execute-task/T01'), firstKey = first.details.transaction.idempotency_key;
    const begun = controller.lookupRecord(owner, 'transaction', firstKey);
    controller.complete(owner, { milestone, unit: first.unit, host_runtime: 'codex', owner_token: ownerToken, generation: begun.lease_generation, idempotency_key: firstKey + ':complete', result: { status: 'succeeded' } }, options);
    const original = fs.readFileSync(controller.transactionFile(owner, firstKey + ':complete'));
    process.env.CODEX_THREAD_ID = 'session-repair';
    const repairObservation = runs.inspectOwnerResume(owner, milestone, { hostRuntime: 'codex', expectedSession: process.env.CODEX_THREAD_ID });
    const repairActor = runs.observeHostSession('codex', process.env.CODEX_THREAD_ID);
    assert.equal(repairActor.sessionId, process.env.CODEX_THREAD_ID);
    const repair = repairApi.resumeAndCreateRepair({ cwd: owner, milestone, slice, task: 'T01', runId: milestone, ownerToken: repairActor.sessionId, hostRuntime: 'codex', expectedSession: repairActor.sessionId, expectedRecordSha256: repairObservation.record_sha256, confirmOwnerStopped: true, confirmWorkspaceQuiescent: true, beginKey: firstKey, completionKey: firstKey + ':complete', executionContract: contract, controllerOptions: options, assertAuthority: () => true, attestStoppedWriter: () => true, readPendingQuestions: () => [] });
    repair.start();
    fixtureDelivery.publish(owner, { milestone, slice, task: 'T01', codeDir: code });
    assert.equal(repair.complete().outcome, 'completed');
    assert(fs.readFileSync(controller.transactionFile(owner, firstKey + ':complete')).equals(original));
    transfer('session-two');
    console.log('PASS repaired completion and first retained-claim owner transfer');

    // Actual native owner bridge: one simulated host callback, real verification
    // and owner publication, then the ordinary controller completion.
    recordClaim('T02');
    const second = next('execute-task/T02');
    const requestFor = task => {
      const planFile = path.join(owner, sliceBase, 'tasks', task, task + '-PLAN.md');
      const route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: owner, unitType: 'execute-task', planPath: planFile, hostRuntime: 'codex', milestoneId: milestone, unitId: task,
        ...(task === 'T05' ? { workerEngine: 'codex', workerMode: 'sidecar', sidecarDeclared: true } : {}) });
      const request = { scope: 'milestone', phase: 'execute', unitType: 'execute-task', milestoneId: milestone, sliceId: slice, taskId: task, runId: milestone, cwd: code, contextRoot: owner, execution_contract: contract, claim: runs.get(owner, milestone).write_claim, planFile, roadmapFile: path.join(owner, base, milestone + '-ROADMAP.md'), contextFile: path.join(owner, sliceBase, slice + '-CONTEXT.md'), researchFile: path.join(owner, sliceBase, slice + '-RESEARCH.md'), securityFile: planFile.replace('-PLAN.md', '-SECURITY.md'), route, workflowId: 'checkup-fixture', dispatchId: 'checkup-' + task, resultFile: path.join(f.dir, 'channel', task + '.json'), gates: { plan: 'skipped', planSkipReason: 'interactive-off', security: 'passed', claim: 'proceed' }, constraints: { auto_commit: false, deploy: false }, verification: { commandTimeoutMs: 300000, commandsByRoot: { [contract.primary_root_id]: [commandFor(task)] } } };
      require('./fixtures/issues-434-436/execution-fixtures.cjs').declareBindings(request);
      fs.mkdirSync(path.dirname(request.resultFile), { recursive: true });
      return request;
    };
    const resultFor = request => {
      const unit = side.locations(request).rules[side.locations(request).delivery.input].unit;
      const inventory = delivery.inventoryPlan(fs.readFileSync(request.planFile, 'utf8'), request.planFile, unit);
      return { status: 'done', summary: 'Private milestone fixture.', files_changed: request.taskId === 'T04' ? ['src/T01.js', 'src/T04.js', 'package-lock.json'] : [`src/${request.taskId}.js`], must_haves_status: inventory.criteria.map(row => ({ kind: row.origin, index: row.index, item: row.text, status: 'met', note: 'Actual private Node check.', root_id: row.origin === 'artifact' ? contract.primary_root_id : '', evidence: row.origin === 'artifact' ? [] : [{ root_id: contract.primary_root_id, check: commandFor(request.taskId), stdout_line: 'PASS milestone fixture' }] })) };
    };
    const boundary = selected => () => {
      const pending = orchestrate.validatePending(input, selected);
      assert.equal(pending.ok, true, JSON.stringify(pending));
    };
    const native = requestFor('T02');
    assert.equal(native.route.worker_mode, 'native');
    const capabilities = { available: true, tool: 'spawn_agent', source: 'hermetic-protocol-fixture', models: [native.route.model], reasoning_efforts: ['medium'], fork_turns: ['none'] };
    async function executeNative(request, selected, write) {
      const invocationOptions = { hostRuntime: 'codex', resolvedDispatch: request.route, activeCapabilities: capabilities, agentType: 'forge-executor', taskName: 'checkup_' + request.taskId, forkTurns: 'none', prompt: 'Claimed fixture task.' };
      let calls = 0;
      const actual = await require('./forge-native-execution').run({ request, invocationOptions, assertBoundary: boundary(selected), assertAuthority: () => { assert.equal(runs.get(owner, milestone).session_id, process.env.CODEX_THREAD_ID); }, persistDeliveryReceipt: record => { const file = request.resultFile + '.receipt.json'; put(file, record); return { file, sha256: sha(fs.readFileSync(file)) }; }, invokeNative: async () => { calls++; write(); return resultFor(request); } });
      assert.equal(calls, 1); assert.equal(actual.published, true, JSON.stringify({ status: actual.status, reason: actual.outcome?.reason_code, diagnostic: actual.outcome?.diagnostic }));
      return actual;
    }
    await executeNative(native, second, () => put(path.join(code, 'src/T02.js'), 'module.exports = 1;\n'));
    complete(second);
    transfer('session-three');
    console.log('PASS native owner publication and second retained-claim owner transfer');

    // Simulated sidecar is a genuine child protocol process; no model service
    // or real credentials are accessed. Owner verification/publication is real.
    recordClaim('T03');
    const third = next('execute-task/T03'), remote = requestFor('T03');
    assert.equal(remote.route.worker_mode, 'sidecar');
    const provider = path.join(f.dir, 'provider.js'), controlFile = path.join(f.dir, 'control.json');
    const wire = { status: 'done', summary: 'Private sidecar fixture.', files_changed: ['src/T03.js'], must_haves_status: [{ item: 'Fixture exports one', status: 'met', note: 'Owner runs the declared private Node check.', scope: 'task', reason: '' }] };
    assert.equal(require('./forge-worker-result-contract').contract('execute').validate(wire).ok, true, 'preflight the actual execute transport schema, separately from native delivery evidence');
    put(controlFile, { source: path.join(code, 'src/T03.js'), result: wire, tokenEnv: accounts.TOKEN_ENV });
    put(provider, `const fs=require('fs');const c=JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}));if(process.env[c.tokenEnv]!=='fixture-only'){process.stderr.write('fixture account isolation failed');process.exit(73);}fs.writeFileSync(c.source,'module.exports = 1;\\n');const a=process.argv;const m=a[a.indexOf('--model')+1];const i=a.indexOf('--session-id');if(i>=0)process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:a[i+1]})+'\\n');process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:c.result,result:['---GSD-WORKER-RESULT---','status: done','result_json: '+JSON.stringify(c.result),'---END-RESULT---'].join('\\n'),modelUsage:{[m]:{inputTokens:1}}})+'\\n');`);
    assert(/\.js$/.test(provider), 'the actual Claude test adapter recognizes only a .js Node override');
    const syntax = cp.spawnSync(process.execPath, ['--check', provider], { encoding: 'utf8', windowsHide: true });
    assert.equal(syntax.status, 0, syntax.stderr);
    process.env.FORGE_XLLM_CLAUDE_BIN = provider;
    const remoteResult = await side.runUnitSidecar(remote, { assertBoundary: boundary(third) });
    assert(fixtureLaunches > 0, 'the fake sidecar uses only the fixture account adapter');
    assert.equal(remoteResult.status, 'done', JSON.stringify({ reason: remoteResult.reason_code, status: remoteResult.status, action: remoteResult.action }));
    const thirdBegin = controller.lookupRecord(owner, 'transaction', third.details.transaction.idempotency_key);
    assert.equal(clock.readCurrentTaskDelivery({ cwd: owner, milestone, slice, task: 'T03', begunAt: thirdBegin.created_at, completedAt: Date.now() }).status, 'proven', 'the normalized worker result has an actual published owner delivery bound to this begin');
    complete(third);
    console.log('PASS simulated Claude sidecar protocol child and owner publication');

    // A later task rewrites an earlier source and uses ignored installation and
    // source globs. Its current capture is new; T01 must remain historical.
    recordClaim('T04');
    const fourth = next('execute-task/T04');
    const fourthRequest = requestFor('T04');
    await executeNative(fourthRequest, fourth, () => {
      put(path.join(code, 'src/T01.js'), 'module.exports = 2;\n');
      put(path.join(code, 'src/T04.js'), 'module.exports = 1;\n');
      put(path.join(code, 'package-lock.json'), '{"fixture":true}\n');
    });
    complete(fourth);
    console.log('PASS later source rewrite and common-ignore source/install globs');

    // Explicit same-host Codex sidecar, through the canonical resolver and real
    // JSONL child transport. Protocol metadata contains no prompts or credentials.
    recordClaim('T05');
    const fifth = next('execute-task/T05'), codex = requestFor('T05');
    assert.equal(codex.route.dispatch_allowed, true, JSON.stringify(codex.route));
    assert.deepEqual([codex.route.host_runtime, codex.route.resolved_worker_engine, codex.route.worker_mode, codex.route.sidecar_declared], ['codex', 'codex', 'sidecar', true]);
    assert.equal(codex.route.model, prefs.tier_models.standard[0]);
    assert.equal(codex.route.effort, prefs.effort['execute-task']);
    const codexProvider = path.join(f.dir, 'codex-provider.js'), codexControl = path.join(f.dir, 'codex-control.json'), codexMetadata = path.join(f.dir, 'codex-protocol.json');
    const codexWire = { status: 'done', summary: 'Private Codex sidecar fixture.', files_changed: ['src/T05.js'], must_haves_status: [{ item: 'Fixture exports one', status: 'met', note: 'Owner runs the declared private Node check.', scope: 'task', reason: '' }] };
    const executeContract = require('./forge-worker-result-contract').contract('execute');
    assert.equal(executeContract.validate(codexWire).ok, true, 'prevalidate the actual standard execute wire');
    put(codexControl, { cwd: code, source: path.join(code, 'src/T05.js'), codex_home: process.env.CODEX_HOME, metadata: codexMetadata, result: codexWire });
    put(codexProvider, `const c=JSON.parse(require('fs').readFileSync(${JSON.stringify(codexControl)},'utf8'));\n` + String.raw`
'use strict';
const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto');
assert.equal(process.cwd(),c.cwd);assert.equal(process.env.CODEX_HOME,c.codex_home);
let pending='',initialized=false,threadModel=null,turns=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 pending+=chunk;assert(pending.length<=2*1024*1024,'bounded fixture protocol input');let end;
 while((end=pending.indexOf('\n'))>=0){
  const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;
  const message=JSON.parse(line);assert(!Object.hasOwn(message,'jsonrpc'));
  if(message.method==='initialize')send({id:message.id,result:{serverInfo:{name:'checkup-codex-fixture'}}});
  else if(message.method==='initialized')initialized=true;
  else if(message.method==='thread/start'){
   assert(initialized);threadModel=message.params.model;assert.equal(message.params.approvalPolicy,'never');assert.equal(message.params.ephemeral,true);
   send({id:message.id,result:{thread:{id:'checkup-T05'}}});
  }else if(message.method==='turn/start'){
   assert(initialized&&threadModel);assert.equal(++turns,1);const p=message.params;
   assert.equal(p.threadId,'checkup-T05');assert.equal(typeof p.model,'string');assert(p.model.length<=128);assert.equal(typeof p.effort,'string');assert(p.effort.length<=32);
   const schema=JSON.stringify(p.outputSchema);assert(schema.length<=32768);
   const metadata={pid:process.pid,cwd:process.cwd(),thread_model:threadModel,turn_model:p.model,effort:p.effort,sandbox:p.sandboxPolicy,schema_sha256:crypto.createHash('sha256').update(schema).digest('hex'),turns};
   const serialized=JSON.stringify(metadata);assert(serialized.length<=8192);fs.writeFileSync(c.metadata,serialized,{flag:'wx'});
   fs.writeFileSync(c.source,'module.exports = 1;\n',{flag:'wx'});
   send({id:message.id,result:{turn:{id:'turn-T05'}}});
   send({method:'item/completed',params:{item:{id:'answer-T05',type:'agentMessage',phase:'final_answer',text:JSON.stringify(c.result)}}});
   send({method:'turn/completed',params:{turn:{id:'turn-T05',status:'completed'}}});
  }
 }
});
setInterval(()=>{},1000);
`);
    const codexSyntax = cp.spawnSync(process.execPath, ['--check', codexProvider], { encoding: 'utf8', windowsHide: true });
    assert.equal(codexSyntax.status, 0, codexSyntax.stderr);
    process.env.FORGE_XLLM_CODEX_BIN = codexProvider;
    assert.deepEqual(require('./forge-xllm').resolveCodexCommand(), { cmd: process.execPath, prefixArgs: [codexProvider] }, 'only the private Node protocol child can launch');
    const verificationProgress = [], ownerJoins = [];
    const codexResult = await side.runUnitSidecar(codex, { assertBoundary: boundary(fifth), onVerificationCheck: record => {
      verificationProgress.push(record);
      // Observe the canonical scope's join result after the core joined the
      // actual spawned ChildProcess. PID census alone cannot establish a join.
      const scope = require('./forge-protected-owner-activity').currentScope();
      ownerJoins.push(scope ? scope.joinWriter() : Promise.resolve(null));
    } });
    assert.equal(codexResult.status, 'done', JSON.stringify({ reason: codexResult.reason_code, status: codexResult.status, action: codexResult.action }));
    assert(fs.statSync(codexMetadata).size <= 8192);
    const protocol = JSON.parse(fs.readFileSync(codexMetadata, 'utf8'));
    assert.deepEqual([protocol.cwd, protocol.thread_model, protocol.turn_model, protocol.effort, protocol.turns], [code, codex.route.model, codex.route.model, codex.route.effort, 1]);
    assert.equal(protocol.schema_sha256, sha(JSON.stringify(executeContract.schema)));
    const sandboxPolicy = require('./forge-xllm').buildAppServerSandboxPolicy('workspace-write', process.platform, []);
    assert.deepEqual(protocol.sandbox, sandboxPolicy, 'assert actual platform wire policy; a simulated child does not prove an OS sandbox');
    assert.equal(protocol.sandbox.type, process.platform === 'win32' ? 'dangerFullAccess' : 'workspaceWrite');
    assert(verificationProgress.some(record => record.root_id === contract.primary_root_id && record.index === 1 && record.state === 'finished' && record.exit_code === 0), 'the declared root verification actually finished; progress labels may be masked');
    const codexReceipt = JSON.parse(fs.readFileSync(codex.resultFile + '.receipt.json', 'utf8'));
    const verificationRoot = codexReceipt.delivery_capture.gate.roots.find(root => root.root_id === contract.primary_root_id);
    assert(verificationRoot.result.checks.some(check => check.command === commandFor('T05') && check.exitCode === 0 && check.stdout.includes('PASS milestone fixture')), 'retained canonical capture binds the named private Node check and actual passing output');
    assert(ownerJoins.length > 0, 'actual owner scope join is observed during verification');
    for (const joined of await Promise.all(ownerJoins)) {
      assert.equal(joined?.joined, true); assert.equal(joined.possible_writers, 0);
      assert(Number.isInteger(joined.pid) && joined.pid > 0, 'join must bind the actual spawned child');
      assert.equal(joined.reason, undefined, 'a before-spawn or failed-spawn observation is not the executed child join');
    }
    const fifthBegin = controller.lookupRecord(owner, 'transaction', fifth.details.transaction.idempotency_key);
    assert.equal(clock.readCurrentTaskDelivery({ cwd: owner, milestone, slice, task: 'T05', begunAt: fifthBegin.created_at, completedAt: Date.now() }).status, 'proven', 'Codex sidecar response has an actual verified owner delivery');
    complete(fifth);
    console.log('PASS simulated Codex app-server child, explicit model/effort/schema/platform sandbox, named verification and owner publication');

    assert.equal(clock.readHistoricalTaskDelivery({ cwd: owner, milestone, slice, task: 'T01', completedAt: Date.now() }).status, 'proven');
    assert.equal(lab.command('git', ['rev-parse', 'HEAD'], code), originalHead, 'auto_commit:false preserves fixture HEAD');
    assert(lab.command('git', ['ls-files', '--others', '--exclude-standard'], code).includes('src/T04.js'));
    const closing = next('complete-slice/S01');
    const aggregate = (unit, plan, children, prefix) => {
      const aggregateInput = { schema_version: 1, unit, plan, plan_fingerprint: sha(fs.readFileSync(path.join(owner, plan))), bindings: [], expected_children: children };
      const value = delivery.buildDelivery(aggregateInput, { ownerRoot: owner, codeDir: code });
      assert(value.criteria.length >= 10, JSON.stringify(value.diagnostics));
      assert(value.criteria.every(row => row.status === 'verificado'));
      put(path.join(owner, prefix + '-DELIVERY-INPUT.json'), aggregateInput);
      put(path.join(owner, prefix + '-DELIVERY.json'), value);
      return value;
    };
    put(path.join(owner, sliceBase, slice + '-SUMMARY.md'), '# Summary\nFive tasks delivered through real owner captures; native, Claude and Codex provider calls were simulated.\n');
    const slicePlan = path.join(owner, sliceBase, slice + '-PLAN.md');
    put(slicePlan, fs.readFileSync(slicePlan, 'utf8').replace(/\[ \]/g, '[x]'));
    aggregate({ type: 'slice', id: slice, milestone }, sliceBase + '/' + slice + '-PLAN.md', tasks.map(task => ({ unit: { type: 'task', id: task, milestone, slice }, delivery: `${sliceBase}/tasks/${task}/${task}-DELIVERY.json` })), sliceBase + '/' + slice);
    complete(closing);
    const roadmap = path.join(owner, base, milestone + '-ROADMAP.md');
    put(roadmap, fs.readFileSync(roadmap, 'utf8').replace('[ ]', '[x]'));
    const finalUnit = next('complete-milestone/' + milestone);
    aggregate({ type: 'milestone', id: milestone }, base + '/' + milestone + '-ROADMAP.md', [{ unit: { type: 'slice', id: slice, milestone }, delivery: sliceBase + '/' + slice + '-DELIVERY.json' }], base + '/' + milestone);
    complete(finalUnit);
    const idle = orchestrate.next(input, options);
    assert.equal(idle.reason_code, 'no-next-unit', JSON.stringify(idle));
    assert.equal(idle.unit, null);
    const ownerHistory = runs.get(owner, milestone).owner_resume_history;
    assert.equal(ownerHistory.filter(row => !row.boundary?.delivery_repair).length, 2);
    assert.equal(ownerHistory.filter(row => row.boundary?.delivery_repair).length, 1, 'exercise the actual durable repair actor binding that previously invalidated selection');
    assert.equal(lab.command('git', ['rev-parse', 'HEAD'], code), originalHead);
    assert.equal(lab.command('git', ['diff', '--cached', '--name-only'], code), '', 'no simulated worker or publication stages product files');
    const untracked = lab.command('git', ['ls-files', '--others', '--exclude-standard'], code).split(/\r?\n/);
    for (const task of tasks) assert(untracked.includes(`src/${task}.js`), 'each delivered source remains an untracked worktree change');
    assert.equal(fs.existsSync(path.join(owner, 'src')), false, 'verification and source writes never use artifact owner');
    console.log('PASS integrated real uncommitted worktree: five tasks, repaired history, two owner transfers, native plus simulated Claude and Codex sidecars, rewritten source, ignored globs, ten aggregate criteria and milestone closure');
    passed = true;
  } finally {
    if (accounts && launch) accounts.resolveLaunch = launch; process.env = saved;
    if (passed) {
      f.cleanup();
      const physical = fs.realpathSync.native(home);
      assert.equal(path.dirname(physical), fs.realpathSync.native(os.tmpdir()));
      assert.equal(fs.readFileSync(path.join(physical, '.fixture-home-owner'), 'utf8'), homeMarker);
      fs.rmSync(physical, { recursive: true });
    } else {
      if (f) console.error('Preserved checkup fixture: ' + f.dir);
      console.error('Preserved private fixture home: ' + home);
    }
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
