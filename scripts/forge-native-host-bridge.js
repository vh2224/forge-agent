#!/usr/bin/env node
'use strict';
// Owner-side cooperative host bridge. A locator/nonce never conveys authority.
// The retained owner is this exact module, not a caller-selected JS adapter.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), net = require('node:net'), child = require('node:child_process');
const LIMIT = Object.freeze({ header: 2048, input: 2097152, body: 1048576,
  aggregate: 16777216, terminal: 65536, candidates: 8, returns: 2, evidence: 1024, checkpoints: 32 });
const channels = new WeakMap(), admissions = new WeakMap(), reservations = new WeakMap();
const hostWitnesses = new WeakMap(), capabilities = new WeakMap(), observations = new WeakMap(), candidates = new WeakMap();
const own = value => Object.freeze(value);
function fail(code) { throw Object.assign(new Error(code), { code, stage: 'native-host-bridge' }); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function stable(v) { if (Array.isArray(v)) return v.map(stable); if (v && typeof v === 'object')
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])); return v; }
function digest(v) { return hash(Buffer.from(JSON.stringify(stable(v)))); }
function json(v) { return Buffer.from(JSON.stringify(v) + '\n'); }
function plain(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype; }
function closed(v, keys, code) { if (!plain(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) fail(code); }
function id(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v)) fail('native-host-protocol-id'); return v; }
function sha(v) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('native-host-protocol-sha256'); return v; }
function inside(root, file) { const r = path.relative(root, file); return r === '' || (!path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep)); }
function physical(file, directory = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || Buffer.byteLength(file) > 4096) fail('native-host-physical-path');
  const absolute = path.resolve(file), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let cursor = path.parse(absolute).root;
  for (let i = 0; i < parts.length; i++) { cursor = path.join(cursor, parts[i]); const st = fs.lstatSync(cursor);
    if (st.isSymbolicLink() || (i < parts.length - 1 || directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) fail('native-host-physical-type'); }
  if (path.resolve(fs.realpathSync.native(absolute)) !== absolute) fail('native-host-physical-alias');
  return absolute;
}
function read(file, max = LIMIT.input) {
  physical(file); const fd = fs.openSync(file, 'r');
  try { const before = fs.fstatSync(fd); if (!before.isFile() || before.nlink !== 1 || before.size > max) fail('native-host-read-bound');
    const bytes = Buffer.alloc(before.size + 1); let n = 0, count;
    while ((count = fs.readSync(fd, bytes, n, bytes.length - n, null)) > 0) { n += count; if (n > before.size) fail('native-host-read-growth'); }
    const after = fs.fstatSync(fd), link = fs.lstatSync(file);
    if (n !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(k => before[k] !== after[k] || after[k] !== link[k])) fail('native-host-read-raced');
    physical(file); return Buffer.from(bytes.subarray(0, n));
  } finally { fs.closeSync(fd); }
}
function parse(bytes, max = LIMIT.input) {
  if (!Buffer.isBuffer(bytes) || bytes.length > max || bytes.subarray(0, 3).equals(Buffer.from([239,187,191]))) fail('native-host-json-bound');
  const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) fail('native-host-json-utf8');
  let value; try { value = JSON.parse(text); } catch { fail('native-host-json-invalid'); }
  if (!plain(value)) fail('native-host-json-object'); return value;
}
function binaryPin(file, expected) {
  physical(file); const fd = fs.openSync(file, 'r'), h = crypto.createHash('sha256');
  try { const a = fs.fstatSync(fd); if (a.size > 512 * 1024 * 1024) fail('native-host-binary-bound');
    const chunk = Buffer.alloc(65536); let count, bytes = 0;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) { bytes += count; if (bytes > a.size) fail('native-host-binary-raced'); h.update(chunk.subarray(0, count)); }
    const b = fs.fstatSync(fd), c = fs.lstatSync(file);
    if (bytes !== a.size || ['dev','ino','size','mtimeMs','ctimeMs'].some(k => a[k] !== b[k] || b[k] !== c[k])) fail('native-host-binary-raced');
    if (h.digest('hex') !== sha(expected)) fail('native-host-binary-changed'); physical(file);
  } finally { fs.closeSync(fd); }
}
function api(name) { return require('./forge-' + name); }
function contextFacts(context) { return api('native-host-request').assertOwnerContext(context); }
// Native identities preserve producer insertion order. Sorted digest remains wire-only.
function nativeDigest(value) { return api('code-roots').digest(value); }
function publicationCurrent(row, actualResult, request) {
  const native=api('native-execution'),profile=api('native-host-profile');
  if(typeof native.getPublicationWitness!=='function'||typeof native.assertOriginalPublicationWitness!=='function'
    ||typeof profile.assertPublicationCurrent!=='function')fail('native-host-publication-witness-unavailable');
  const witness=native.getPublicationWitness(actualResult,{request});
  native.assertOriginalPublicationWitness(witness,{request});
  // Context owns the exact BEFORE/AFTER transition; no generic stamp bypass.
  api('native-host-request').assertOwnerContext(row.context,{publicationWitness:witness});
  profile.assertPublicationCurrent(row.profile,witness);
  row.publicationWitness=witness;return witness;
}
function rootList(facts) { return [facts.owner, ...facts.execution_contract.code_roots.map(r => r.path)]; }
function copyBuffer(bytes) { const copy = Buffer.alloc(bytes.length); bytes.copy(copy); return copy; }
function inspectFixture(observation, configuration, facts, directory) {
  if (observation.provenance !== 'fixture-origin') return null;
  const root = physical(configuration.fixture_root, true);
  if (path.dirname(root) !== physical(os.tmpdir(), true) || !/^forge-native463-fixture-[A-Za-z0-9_-]+$/.test(path.basename(root))) fail('native-host-fixture-root');
  const markerFile = path.join(root, 'FIXTURE-ORIGIN.json'), bytes = read(markerFile, LIMIT.header), marker = parse(bytes, LIMIT.header);
  closed(marker, ['schema_version','kind','root'], 'native-host-fixture-marker');
  if (marker.schema_version !== 1 || marker.kind !== 'forge-native463-isolated-fixture' || marker.root !== root || hash(bytes) !== configuration.fixture_marker_sha256) fail('native-host-fixture-marker');
  const homes = ['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR'].map(k => process.env[k]);
  const roots = [...rootList(facts), ...(directory ? [directory] : [])];
  if (homes.some(p => !p || !inside(root, physical(p, true))) || roots.some(p => !inside(root, physical(p, true)))) fail('native-host-fixture-containment');
  return { root, marker_file: markerFile, marker_sha256: hash(bytes), contained_roots: roots, private_homes: homes };
}
function enrollHost(context, file) {
  const raw = read(file), observation = api('native-host-profile').normalizeHostObservation(parse(raw));
  const facts = contextFacts(context);
  if (facts.actor.sessionId !== observation.host_session) fail('native-host-enrollment-session');
  const sources = [
    { role: 'schema', file: observation.active_tool.observation_reference },
    { role: 'configuration', file: observation.mode_support.observation_reference },
    { role: 'effort', file: observation.effort_observation.observation_reference },
    { role: 'agent', file: observation.agent_definition.physical_path },
    { role: 'relay', file: path.join(__dirname, 'forge-hook.js') },
    { role: 'bridge', file: __filename },
  ].map(s => ({ ...s, file: physical(s.file), raw: read(s.file) }));
  const schemaSource = sources.find(s => s.role === 'schema'), configuration = sources.find(s => s.role === 'configuration');
  if (digest(parse(schemaSource.raw)) !== observation.active_tool.schema_sha256 || hash(configuration.raw) !== observation.mode_support.effective_configuration_sha256
      || hash(sources.find(s => s.role === 'agent').raw) !== observation.agent_definition.sha256
      || hash(sources.find(s => s.role === 'effort').raw) !== observation.effort_observation.source_fingerprint) fail('native-host-enrollment-source');
  binaryPin(observation.host_binary.physical_path, observation.host_binary.sha256);
  const fixture = inspectFixture(observation, parse(configuration.raw), facts);
  const capability = own({}), witness = own({});
  const row = { context, file: physical(file), sha256: hash(raw), observation, sources, fixture, capability };
  hostWitnesses.set(witness, row); capabilities.set(capability, row); return witness;
}
function currentHost(row) {
  if(row.live)return currentLiveHost(row);
  const facts = contextFacts(row.context); if (hash(read(row.file)) !== row.sha256) fail('native-host-enrollment-changed');
  for (const s of row.sources) if (hash(read(s.file)) !== hash(s.raw)) fail('native-host-enrollment-source-changed');
  binaryPin(row.observation.host_binary.physical_path, row.observation.host_binary.sha256);
  row.fixture=inspectFixture(row.observation, parse(row.sources.find(s => s.role === 'configuration').raw), facts, row.channelDirectory);
}
function hostObservationForRow(row,context) {
  return { observation: structuredClone(row.observation), provenance: row.observation.provenance,
    source: { file: row.file||null, sha256: row.sha256||nativeDigest(row.liveSources) }, ingressCapability: row.capability,
    currentBinding: { owner_actor_sha256: digest(contextFacts(context).actor), channel_identity_sha256: row.channelIdentity || null,
      observation_sha256: digest(row.observation), source_pins: row.live?row.liveSources.pins:row.sources.map(s => ({file:s.file,sha256:hash(s.raw)})) },
    joinState: { phase: 'not-invoked', tool_use_id:null, agent_id:null, agent_run_id:null, provider_called:'unknown' } };
}
function assertHostObservation(witness, context) {
  const row = hostWitnesses.get(witness); if (!row || row.context !== context) fail('native-host-host-witness-required'); currentHost(row);
  return hostObservationForRow(row,context);
}
function ingressCapabilityForRow(row) {
  if(row.live)return{schema_version:1,provenance:'observed-host',host_session:row.observation.host_session,agent_source:{file:row.liveSources.agent,sha256:row.liveSources.agent_sha256},source_pins:structuredClone(row.liveSources.pins)};
  const source = role => { const s = row.sources.find(s => s.role === role); return { file:s.file, sha256:hash(s.raw), raw:copyBuffer(s.raw) }; };
  return {schema_version:1,provenance:row.observation.provenance,host_session:row.observation.host_session,
    relay_source:source('relay'),schema_source:source('schema'),configuration_source:source('configuration'),
    host_binary:{file:row.observation.host_binary.physical_path,sha256:row.observation.host_binary.sha256},agent_source:source('agent'),fixtureProof:structuredClone(row.fixture)};
}
function assertIngressCapability(handle, context) {
  const row = capabilities.get(handle); if (!row || row.context !== context) fail('native-host-ingress-capability-required'); currentHost(row);
  return ingressCapabilityForRow(row);
}
function assertHostObservationAndIngress(witness,context){
 const row=hostWitnesses.get(witness);if(!row||row.context!==context)fail('native-host-host-witness-required');
 if(capabilities.get(row.capability)!==row)fail('native-host-ingress-capability-required');
 currentHost(row);
 // Both projections come from this same original witness/capability row.
 return{host:hostObservationForRow(row,context),source:ingressCapabilityForRow(row)};
}
function createOwnedChannel(context, hostWitness) {
  const facts = contextFacts(context), enrollment = hostWitnesses.get(hostWitness); if (!enrollment || enrollment.context !== context) fail('native-host-host-witness-required');
  currentHost(enrollment);
  const base = enrollment.fixture ? path.join(enrollment.fixture.root, 'channels') : physical(fs.realpathSync.native(os.tmpdir()), true);
  if (!fs.existsSync(base)) fs.mkdirSync(base, {mode:0o700}); physical(base, true);
  const directory = fs.mkdtempSync(path.join(base, 'forge-native-')), attempt = crypto.randomUUID(), dispatch = 'native-' + crypto.randomUUID();
  if (rootList(facts).some(root => inside(root, directory))) fail('native-host-channel-inside-root');
  const identity = fs.statSync(directory), channel = own({}), admission = own({});
  const row = {context,channel,admission,directory,identity,attempt,dispatch,sequence:0,checkpointCount:0,
    reservations:new Set(),counts:{candidate:0,return:0,evidence:0},dedup:new Map(),phase:'preparing',lastCheckpoint:null,
    profile:null,requestHandle:null,sealed:null,accepted:null,joined:null,ready:null,activity:null,receipt:null};
  channels.set(channel,row); admissions.set(admission,row);
  enrollment.channelDirectory = directory; enrollment.channelIdentity = channelDigest(row); currentHost(enrollment);
  row.enrollment = enrollment; row.hostWitness = hostWitness;if(enrollment.live){enrollment.liveChannel=row;createLiveKey(row);} row.admissionAPI = own({
    reserve:(...args)=>reserve(row,...args),commit:reservation=>commit(row,reservation),reconcile:reservation=>reconcile(row,reservation),
    writeImmutable:(...args)=>writeImmutable(row,...args),assertCurrent:()=>currentChannel(row),
  }); return channel;
}
function channelDigest(row) { return digest({directory:row.directory,dev:row.identity.dev,ino:row.identity.ino,attempt_id:row.attempt}); }
function currentChannel(row) {
  if(row.liveFatal)throw row.liveFatal;if(row.enrollment?.live)for(const pin of row.enrollment.liveSources.pins)if(hash(read(pin.file))!==pin.sha256)fail('native-host-agent-source-changed');
  contextFacts(row.context); physical(row.directory,true); const st=fs.statSync(row.directory);
  if (st.dev!==row.identity.dev || st.ino!==row.identity.ino) fail('native-host-channel-replaced');
}
function ownedTarget(row,target) {
  if (!path.isAbsolute(target) || !inside(row.directory,target) || target===row.directory) fail('native-host-spool-target');
  physical(path.dirname(target),true);
  try { physical(target); } catch(error) { if(error.code!=='ENOENT') throw error; }
  return target;
}
function spoolBytes(row) {
  let total=0; for (const name of fs.readdirSync(row.directory)) { const file=path.join(row.directory,name);
    if(process.platform!=='win32'&&file===endpoint(row.directory)){const stat=fs.lstatSync(file);if(!stat.isSocket()||stat.isSymbolicLink())fail('native-host-channel-socket');continue;}
    physical(file);total+=fs.statSync(file).size; }
  return total;
}
function reserve(row,role,bytes,target,stagingTargets=[]) {
  currentChannel(row); ownedTarget(row,target);
  const bound = ['candidate','return'].includes(role)?LIMIT.body:role==='checkpoint'?LIMIT.terminal:LIMIT.input;
  if (!Number.isSafeInteger(bytes)||bytes<0||bytes>bound||!Array.isArray(stagingTargets)||stagingTargets.length>4) fail('native-host-spool-bound');
  for(const p of stagingTargets) ownedTarget(row,p);
  if([...row.reservations].some(h=>{const r=reservations.get(h);return [r.target,...r.staging].some(p=>[target,...stagingTargets].includes(p));})) fail('native-host-spool-reservation-conflict');
  const reserved=[...row.reservations].reduce((n,h)=>n+reservations.get(h).peak,0),peak=bytes*(1+stagingTargets.length);
  const allowance=role==='checkpoint-terminal'?LIMIT.aggregate:LIMIT.aggregate-LIMIT.terminal;
  if(spoolBytes(row)+reserved+peak>allowance) fail('native-host-spool-aggregate');
  const handle=own({}); reservations.set(handle,{row,role,bytes,target,staging:[...stagingTargets],peak});row.reservations.add(handle);return handle;
}
function reservationOf(row,handle) {const r=reservations.get(handle);if(!r||r.row!==row||!row.reservations.has(handle))fail('native-host-reservation-required');return r;}
function commit(row,handle) { currentChannel(row);const r=reservationOf(row,handle);if(read(r.target,r.bytes).length!==r.bytes)fail('native-host-spool-write-size');
  for(const p of r.staging)if(fs.existsSync(p))fail('native-host-staging-not-settled');row.reservations.delete(handle);reservations.delete(handle);return true; }
function reconcile(row,handle) { currentChannel(row);const r=reservationOf(row,handle);for(const p of [r.target,...r.staging])if(fs.existsSync(p))read(p,LIMIT.input);
  row.reservations.delete(handle);reservations.delete(handle);if(spoolBytes(row)>LIMIT.aggregate)fail('native-host-spool-aggregate');return true; }
function writeImmutable(row,role,target,bytes) {
  if(!Buffer.isBuffer(bytes))fail('native-host-spool-buffer');ownedTarget(row,target);
  if(fs.existsSync(target)){if(!read(target,Math.max(bytes.length,1)).equals(bytes))fail('native-host-immutable-conflict');return {file:target,sha256:hash(bytes)};}
  const h=reserve(row,role,bytes.length,target);try{fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});commit(row,h);}catch(error){if(row.reservations.has(h))reconcile(row,h);throw error;}
  return {file:target,sha256:hash(bytes)};
}
function assertOwnedChannel(channel,context) {const row=channels.get(channel);if(!row||row.context!==context)fail('native-host-owned-channel-required');currentChannel(row);
  return own({attempt_id:row.attempt,dispatch_id:row.dispatch,directory:row.directory,result_file:path.join(row.directory,'native-result'),
    context_file:path.join(row.directory,'owner-context.md'),lifecycle_file:path.join(row.directory,'native-lifecycle.json'),admission:row.admissionAPI});}
function checkpoint(row,phase,details={}) {
  currentChannel(row);if(row.checkpointCount>=LIMIT.checkpoints)fail('native-host-checkpoint-count');
  const value={schema_version:1,attempt_id:row.attempt,sequence:++row.sequence,phase,previous_sha256:row.lastCheckpoint?.sha256||null,
    owner_sha256:digest(contextFacts(row.context)),details};const bytes=json(value);if(bytes.length>LIMIT.terminal)fail('native-host-checkpoint-bound');
  const result=writeImmutable(row,phase==='failed'?'checkpoint-terminal':'checkpoint',path.join(row.directory,'checkpoint-'+String(row.checkpointCount).padStart(2,'0')+'.json'),bytes);
  row.checkpointCount++;row.lastCheckpoint=result;row.phase=phase;return result;
}
function assertNativeAdmission(handle,request) {const row=admissions.get(handle);if(!row||!row.requestHandle)fail('native-host-native-admission-required');
  const actual=api('native-host-request').assertExecutionRequest(row.requestHandle,{context:row.context,channel:row.channel});
  if(digest(actual)!==digest(request))fail('native-host-native-admission-foreign');currentChannel(row);
  return own({...row.admissionAPI,assertTerminalAdmission:()=>terminalAdmission(row),providerObservation:()=>row.joined?.provider_called??'unknown'});
}
function terminalAdmission(row) { currentChannel(row);const joined=api('native-host-profile').assertJoined(row.profile);
  if(!row.accepted||!row.joined||row.accepted.sha256!==row.joined.candidate_sha256)fail('native-host-candidate-capture-pending');
  if(joined.joined!==true)fail('native-host-writer-unproven');return true; }
function witnessOf(map,handle,context,code) {const row=map.get(handle);if(!row||row.context!==context)fail(code);currentChannel(row.owner);
  const raw=read(row.file,LIMIT.body);if(hash(raw)!==row.sha256)fail('native-host-retained-evidence-changed');
  return {...structuredClone(row.value),raw:copyBuffer(raw),sha256:row.sha256,capture_reference:row.file};}
function assertObservation(handle,context) {return witnessOf(observations,handle,context,'native-host-observation-witness-required');}
function assertCandidate(handle,context) {return witnessOf(candidates,handle,context,'native-host-candidate-witness-required');}
function retainMessage(row,kind,issuer,messageId,bytes,metadata) {
  currentChannel(row);id(messageId);id(issuer);if(bytes.length>LIMIT.body)fail('native-host-message-bound');
  const key=issuer+':'+messageId,sha256=hash(bytes),previous=row.dedup.get(key);
  if(previous){if(previous.sha256!==sha256)fail('native-host-message-conflict');return {...previous,duplicate:true};}
  if(row.counts.evidence>=LIMIT.evidence)fail('native-host-evidence-count');
  const role=kind==='candidate'?'candidate':'evidence';
  const already=[...row.dedup.values()].some(v=>v.kind===kind&&v.sha256===sha256);
  if(role==='candidate'&&!already&&row.counts.candidate>=LIMIT.candidates)fail('native-host-body-count');
  const body=writeImmutable(row,role,path.join(row.directory,kind+'-'+sha256+'.capture'),bytes);
  const seq=++row.sequence,record={schema_version:1,sequence:seq,kind,issuer,message_id:messageId,sha256,file:body.file,metadata};
  const admitted=writeImmutable(row,'evidence',path.join(row.directory,'admission-'+String(seq).padStart(4,'0')+'.json'),json(record));
  row.counts.evidence++;if(!already&&role==='candidate')row.counts.candidate++;const ack={kind,sha256,file:body.file,admission:admitted};row.dedup.set(key,ack);return ack;
}
function acceptCandidate(row,messageId,bytes) {
  if(row.enrollment.live&&(!row.genuineReturn||!row.genuineReturn.equals(bytes)))fail('native-host-live-candidate-not-captured');
  const retained=retainMessage(row,'candidate','candidate',messageId,bytes,null);if(retained.duplicate)return retained;
  // Candidate has no host/terminal authority. Preserve original bytes before parsing.
  const parsed=api('worker-result').parseJsonEnvelope(bytes.toString('utf8'));
  if(!parsed.ok||parsed.status!==parsed.payload?.status||!api('native-recovery-delivery').resultContract.validate(parsed.payload).ok)fail('native-host-candidate-contract');
  const handle=own({});candidates.set(handle,{owner:row,context:row.context,file:retained.file,sha256:retained.sha256,
    value:{parsed:{status:parsed.status,payload:parsed.payload},dispatch_id:row.dispatch,invocation_sha256:row.sealed?.invocation_sha256||null,
      tool_use_id:null,event_type:'candidate',host_session:row.enrollment.observation.host_session,provenance:row.enrollment.observation.provenance,...(row.enrollment.live?{live_authenticated:true}:{})}});
  api('native-host-profile').admitCandidate(row.profile,handle);row.accepted={sha256:retained.sha256,handle};row.wake?.();return retained;
}
function relayObservation(row,messageId,bytes) {
  const retained=retainMessage(row,'observation','relay',messageId,bytes,null);if(retained.duplicate)return retained;
  const envelope=parse(bytes,LIMIT.body);closed(envelope,['message','capture'],'native-host-relay-envelope');
  const message=api('native-host-profile').normalizeRelayMessage(envelope.message);
  if(message.attempt_id!==row.attempt||message.issuer_message_id!==messageId||message.dispatch_id!==row.dispatch||!row.sealed
    ||message.invocation_sha256!==row.sealed.invocation_sha256||message.host_session!==row.enrollment.observation.host_session)fail('native-host-relay-binding');
  if(envelope.capture!==null&&typeof envelope.capture!=='string')fail('native-host-relay-capture');
  const capture=envelope.capture===null?Buffer.alloc(0):Buffer.from(envelope.capture);
  if(message.capture_sha256!==(envelope.capture===null?null:hash(capture)))fail('native-host-relay-capture-hash');
  const captureFile=path.join(row.directory,'host-'+hash(capture)+'.capture');
  if(envelope.capture===null)fail('native-host-observation-capture-required');
  // Every event capture is evidence. Only bound terminal returns consume the two-return cap.
  const rawEvent=parse(capture,LIMIT.body),terminal=rawEvent.event==='foreground-return';
  if(terminal&&!fs.existsSync(captureFile)&&row.counts.return>=LIMIT.returns)fail('native-host-return-count');
  const existed=fs.existsSync(captureFile);writeImmutable(row,terminal?'return':'evidence',captureFile,capture);if(terminal&&!existed)row.counts.return++;
  const handle=own({});observations.set(handle,{owner:row,context:row.context,file:captureFile,sha256:hash(capture),
    value:{parsed:message,dispatch_id:row.dispatch,invocation_sha256:message.invocation_sha256,tool_use_id:message.tool_use_id,
      event_type:message.event_type,host_session:message.host_session,provenance:row.enrollment.observation.provenance,
      capture:envelope.capture===null?null:{file:captureFile,sha256:hash(capture),raw:copyBuffer(capture)}}});
  api('native-host-profile').admitObservation(row.profile,handle);
  if(row.toolWorkers){
    if(rawEvent.event==='launch'||rawEvent.event==='worker-start')row.toolWorkers.add(rawEvent.worker_id);
    else if(rawEvent.event==='worker-stop')row.toolWorkers.delete(rawEvent.worker_id);
    if(['launch','worker-start','worker-stop'].includes(rawEvent.event))row.progress?.({open:row.toolWorkers.size>0});
  }
  row.wake?.();return retained;
}
function lifecycleAdapter(row) {
  const profile=api('native-host-profile'),handle='pending-'+row.attempt;
  row.pendingHandle=handle;row.toolWorkers=new Set();
  return own({capabilities:own({result:true,remote_events:false,open_tools:true,cancel:false,resume:false,stop_proof:false}),
    acknowledge(value){currentChannel(row);if(value!==handle||!row.sealed)fail('native-host-acknowledgment-foreign');return handle;},
    subscribe(value,emit,{identity}){
      currentChannel(row);if(value!==handle||typeof emit!=='function')fail('native-host-subscription-foreign');let sequence=0,disposed=false;
      row.progress=event=>{if(disposed)return;emit({identity,sequence:++sequence,kind:'tool',open:event.open});};
      const unsubscribe=profile.subscribe(row.profile,captured=>queueMicrotask(async()=>{
        if(disposed)return;
        try{row.joined=captured;terminalAdmission(row);
          if(typeof row.activity?.observeJoined!=='function'||typeof row.activity?.reconcile!=='function')fail('native-host-activity-join-unavailable');
          await row.activity.observeJoined(row.profile);await row.activity.reconcile();
          if(disposed)return;terminalAdmission(row);
          const parsed=api('worker-result').parseJsonEnvelope(captured.raw.toString('utf8'));
          if(!parsed.ok||parsed.status!==parsed.payload?.status)fail('native-host-capture-contract');
          emit({identity,sequence:++sequence,kind:'terminal',result:parsed.payload});
        }catch(error){row.lastError=safeError(error);row.subscriptionError=error;
          try{checkpoint(row,'failed',{...row.lastError,writer_join:'unknown'});}catch(checkpointError){row.checkpointError=safeError(checkpointError);}}
      }));
      return()=>{disposed=true;row.progress=null;unsubscribe();};
    }});
}
function endpoint(directory) {return process.platform==='win32'?'\\\\.\\pipe\\forge-native-'+hash(directory):path.join(directory,'owner.sock');}
function reference(row) {const facts=contextFacts(row.context);return {schema_version:1,attempt_id:row.attempt,directory:row.directory,
  endpoint:endpoint(row.directory),owner_identity_sha256:digest(facts.actor),execution_contract_sha256:digest(facts.execution_contract),
  run_id:facts.run_id,claim_generation:facts.claim_generation,begin_checksum:facts.begin_checksum,lease_generation:facts.lease_generation,
  host_session_sha256:row.enrollment.live?nativeDigest(row.enrollment.observation.host_session):hash(row.enrollment.observation.host_session),dispatch_id:row.dispatch,invocation_sha256:row.sealed?.invocation_sha256||null,
  channel_identity_sha256:channelDigest(row),...(row.enrollment.live?{request_sha256:nativeDigest(api('native-host-request').readExecutionRequest(row.requestHandle))}:{})};}
function writeReference(row) {if(!row.referenceFile)row.referenceFile=path.join(row.directory,'attempt.json');
  // Written once only after the real native callback sealed the invocation.
  const bytes=json(reference(row));if(bytes.length>LIMIT.header)fail('native-host-reference-bound');
  return writeImmutable(row,'reference',row.referenceFile,bytes);}
// Diagnostic data only. No message, raw stack, absolute path, environment or payload.
const SOURCE_ERROR_CLASSES=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','AssertionError','UnknownError']);
const SOURCE_ERROR_FILES=new Set(['forge-native-host-bridge.js','forge-native-host-request.js','forge-native-host-profile.js','forge-prompt.js','forge-procedure-context.js','forge-delivery.js','forge-unit-sidecar.js','forge-code-roots.js','forge-plan-validation.js','forge-prefs.js','forge-task-execution.js','forge-surgical-reset.js','forge-vcs.js']);
function sourceErrorDataObject(value,keys){if(!plain(value))return false;const descriptors=Object.getOwnPropertyDescriptors(value);return Reflect.ownKeys(descriptors).every(key=>typeof key==='string')&&Object.keys(descriptors).sort().join(',')===[...keys].sort().join(',')&&Object.values(descriptors).every(row=>Object.hasOwn(row,'value')&&row.enumerable);}
function checkedSourceError(value){
  if(!sourceErrorDataObject(value,['kind','error_class','frames'])||value.kind!=='native-host-source-error-v1'||!SOURCE_ERROR_CLASSES.has(value.error_class)||!Array.isArray(value.frames)||value.frames.length>4)return null;
  const frames=[];for(const row of value.frames){if(!sourceErrorDataObject(row,['file','line','column'])||!SOURCE_ERROR_FILES.has(row.file)||!Number.isSafeInteger(row.line)||row.line<1||row.line>9999999||!Number.isSafeInteger(row.column)||row.column<1||row.column>999999)return null;frames.push({file:row.file,line:row.line,column:row.column});}
  return{kind:value.kind,error_class:value.error_class,frames};
}
function sourceErrorDiagnostic(error){
  if(!error||(typeof error!=='object'&&typeof error!=='function'))return null;
  // IPC wraps the same sanitized error in a new Error. Revalidate and retain
  // the original bounded diagnostic instead of replacing it with client frames.
  const retained=checkedSourceError(Object.getOwnPropertyDescriptor(error,'source_error')?.value);if(retained)return retained;
  let errorClass='UnknownError';for(const[Type,name]of [[TypeError,'TypeError'],[RangeError,'RangeError'],[ReferenceError,'ReferenceError'],[SyntaxError,'SyntaxError'],[URIError,'URIError'],[EvalError,'EvalError'],[Error,'Error']])if(error instanceof Type){errorClass=name;break;}
  const ownName=Object.getOwnPropertyDescriptor(error,'name')?.value;if(ownName==='AssertionError')errorClass=ownName;
  // Current Node exposes Error.stack as an own native accessor. Read it only
  // in memory; failure of this optional observation must not replace the error.
  let stack=null;try{stack=error.stack;}catch{}const frames=[];
  if(typeof stack==='string'&&Buffer.byteLength(stack)<=65536){const prefix=__dirname.replaceAll('\\','/')+'/';const needle=process.platform==='win32'?prefix.toLowerCase():prefix;for(const raw of stack.split(/\r?\n/).slice(1,33)){const line=raw.replaceAll('\\','/'),at=(process.platform==='win32'?line.toLowerCase():line).lastIndexOf(needle);if(at<0)continue;const match=/^(forge-[a-z0-9-]+\.js):([1-9]\d{0,6}):([1-9]\d{0,5})(?:\)|$)/.exec(line.slice(at+prefix.length));if(!match||!SOURCE_ERROR_FILES.has(match[1]))continue;frames.push({file:match[1],line:Number(match[2]),column:Number(match[3])});if(frames.length===4)break;}}
  return{kind:'native-host-source-error-v1',error_class:errorClass,frames};
}
// Observe only typed child-process metadata already attached to this Error.
// A generic snapshot Error has none: do not invent process status or payload.
function childProcessErrorDiagnostic(error){
  if(!error||(typeof error!=='object'&&typeof error!=='function'))return null;
  const fields={};for(const key of ['status','signal','stdout','stderr']){const row=Object.getOwnPropertyDescriptor(error,key);if(!row||!Object.hasOwn(row,'value'))return null;fields[key]=row.value;}
  if(!(fields.status===null||Number.isSafeInteger(fields.status))||!(fields.signal===null||typeof fields.signal==='string'&&/^[A-Z][A-Z0-9]{1,31}$/.test(fields.signal)))return null;
  const bytes=value=>{if(Buffer.isBuffer(value))return value.length<=LIMIT.aggregate?value:null;if(typeof value==='string'&&Buffer.byteLength(value)<=LIMIT.aggregate)return Buffer.from(value);return null;};
  const stdout=bytes(fields.stdout),stderr=bytes(fields.stderr);if(!stdout||!stderr)return null;
  const rawCode=Object.getOwnPropertyDescriptor(error,'code')?.value,spawnCode=typeof rawCode==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(rawCode)?rawCode:null;
  return safeOSDiagnostic({action:'child-process',status:fields.status,signal:fields.signal,spawn_code:spawnCode,stdout_captured_bytes:stdout.length,stdout_captured_sha256:hash(stdout),stderr_captured_bytes:stderr.length,stderr_captured_sha256:hash(stderr),...(['ENOBUFS','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(spawnCode)?{stderr_may_be_truncated:true}:{})});
}
function safeError(error) {let sourceError=null,osDiagnostic=null,unverifiedRefusal=null;try{unverifiedRefusal=checkedUnverifiedRefusal(Object.getOwnPropertyDescriptor(error,'unverified_refusal')?.value);}catch{}try{sourceError=sourceErrorDiagnostic(error);}catch{}try{osDiagnostic=safeOSDiagnostic(error.os_diagnostic)||childProcessErrorDiagnostic(error);}catch{}return {code:String(error.code||'native-host-owner-failed').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,160),
  stage:typeof error.stage==='string'?error.stage:'native-host-bridge',provider_called:unverifiedRefusal?'unknown':[true,false].includes(error.provider_called)?error.provider_called:'unknown',...(osDiagnostic?{os_diagnostic:osDiagnostic}:{}),...(sourceError?{source_error:sourceError}:{}),...(unverifiedRefusal?{unverified_refusal:unverifiedRefusal}:{})};}
function tellParent(message) {if(process.connected&&typeof process.send==='function')process.send(message,()=>{});}
function reply(socket,value) {const bytes=json(value);if(bytes.length>LIMIT.header)fail('native-host-ack-bound');socket.write(bytes);}
function startServer(row) {
  let active=null,connections=0;
  const server=net.createServer(socket=>{
    if(++connections>16){connections--;socket.destroy();return;}socket.once('close',()=>connections--);
    let headerBytes=Buffer.alloc(0),header=null,body=null,n=0,reservation=null,finished=false;
    function releaseAdmission(){if(active===socket)active=null;}
    function reject(error){if(finished)return;finished=true;try{if(reservation&&row.reservations.has(reservation))reconcile(row,reservation);}finally{releaseAdmission();}
      try{reply(socket,{protocol_version:1,ack:'refused',error:safeError(error)});}finally{socket.end();}}
    socket.on('error',()=>{});
    socket.on('close',()=>{if(!finished&&active===socket){try{if(reservation&&row.reservations.has(reservation))reconcile(row,reservation);}finally{releaseAdmission();}}});
    socket.on('data',chunk=>{try{
      if(finished)return;
      if(!header){headerBytes=Buffer.concat([headerBytes,chunk]);const end=headerBytes.indexOf(10);
        if(headerBytes.length>LIMIT.header||end<0&&headerBytes.length>=LIMIT.header)fail('native-host-header-bound');if(end<0)return;
        // Client must wait for admission; pre-admission body is not accepted.
        if(end!==headerBytes.length-1)fail('native-host-body-before-admission');header=parse(headerBytes.subarray(0,end),LIMIT.header);
        if(header.kind==='live-control'){closed(header,['protocol_version','kind','command'],'native-host-live-control-header');if(!row.enrollment.live||header.protocol_version!==1||!['accept','status','replay'].includes(header.command))fail('native-host-live-control-header');currentChannel(row);if(active)fail('native-host-ingress-busy');active=socket;socket.once('close',releaseAdmission);socket.setTimeout(20000,()=>socket.destroy());serveLiveControl(row,socket,header);finished=true;return;}
        if(header.kind==='live-hook'){closed(header,['protocol_version','kind','phase'],'native-host-live-header');if(!row.enrollment.live||header.protocol_version!==1||!LIVE_PHASES.includes(header.phase))fail('native-host-live-header');currentChannel(row);if(active)fail('native-host-ingress-busy');active=socket;socket.once('close',releaseAdmission);socket.setTimeout(20000,()=>socket.destroy());serveLiveHook(row,socket,header);finished=true;return;}
        closed(header,['protocol_version','kind','attempt_id','issuer_message_id','body_bytes','body_sha256'],'native-host-header-schema');
        if(header.protocol_version!==1||header.attempt_id!==row.attempt||!['candidate','captured-candidate','relay','status','replay'].includes(header.kind))fail('native-host-header-binding');
        if(row.enrollment.live&&['candidate','captured-candidate','relay','status','replay'].includes(header.kind))fail('native-host-authenticated-control-required');
        id(header.issuer_message_id);sha(header.body_sha256);if(!Number.isSafeInteger(header.body_bytes)||header.body_bytes<0||header.body_bytes>LIMIT.body)fail('native-host-body-bound');
        currentChannel(row);if(active)fail('native-host-ingress-busy');active=socket;
        // A single admitted body bounds memory and disk peaks independently of idle sockets.
        reservation=reserve(row,'ingress',header.body_bytes,path.join(row.directory,'pending-'+header.issuer_message_id));
        body=Buffer.alloc(header.body_bytes);reply(socket,{protocol_version:1,ack:'admitted',bytes:header.body_bytes});
        if(header.body_bytes===0)finish();return;
      }
      if(n+chunk.length>body.length)fail('native-host-body-overflow');chunk.copy(body,n);n+=chunk.length;if(n===body.length)finish();
    }catch(error){reject(error);}});
    function finish(){try{if(hash(body)!==header.body_sha256)fail('native-host-body-hash');
      // Transfer admission to durable immutable writes under the same synchronous owner turn.
      row.reservations.delete(reservation);reservations.delete(reservation);reservation=null;
      let result;if(header.kind==='candidate')result=acceptCandidate(row,header.issuer_message_id,body);
      else if(header.kind==='captured-candidate'){if(body.length||!row.enrollment.live||!row.genuineReturn)fail('native-host-live-capture-not-ready');result=acceptCandidate(row,header.issuer_message_id,copyBuffer(row.genuineReturn));}
      else if(header.kind==='relay')result=relayObservation(row,header.issuer_message_id,body);
      else {if(body.length)fail('native-host-control-body');result=header.kind==='status'?{phase:row.phase,ready:!!row.ready}:queueReplay(row);}
      if(row.enrollment.fixture&&(header.kind==='relay'&&api('native-host-profile').describeProfile(row.profile).joined||header.kind==='status'&&row.ready)){finished=true;socket.once('close',releaseAdmission);fixtureCompletionReply(row,socket,result,releaseAdmission);return;}
      finished=true;releaseAdmission();reply(socket,{protocol_version:1,ack:'retained',phase:row.phase,sha256:result?.sha256||null,ready:!!row.ready,...(row.lastError?{error:row.lastError}:{}),...(row.replayDiagnostic?{replay_diagnostic:row.replayDiagnostic}:{})});socket.end();
    }catch(error){reject(error);}}
  });
  server.on('error',error=>{row.serverError=error;row.wake?.();});server.listen(endpoint(row.directory));row.server=server;return server;
}
function readback(row,record) {
  currentChannel(row);terminalAdmission(row);
  const request=api('native-host-request').assertExecutionRequest(row.requestHandle);
  const files=api('unit-sidecar').locations(request);
  // Publication identity is checked by native delivery; additionally verify every reported artifact byte.
  if(!record||record.phase!=='ready'||record.dispatch_id!==row.dispatch||!Array.isArray(record.artifacts))fail('native-host-publication-record');
  for(const artifact of record.artifacts){if(typeof artifact.path!=='string'||typeof artifact.content!=='string')fail('native-host-artifact-shape');
    const target=path.resolve(request.contextRoot,artifact.path);if(!inside(request.contextRoot,target)||target===request.contextRoot)fail('native-host-artifact-path');
    if(!read(target,LIMIT.input).equals(Buffer.from(artifact.content)))fail('native-host-artifact-readback');}
  return {locations_sha256:nativeDigest(files),receipt_sha256:nativeDigest(record)};
}
function persistReceipt(row,pointer) {
  closed(pointer,['file','sha256'],'native-host-receipt-pointer');ownedTarget(row,pointer.file);const bytes=read(pointer.file,LIMIT.body);
  if(hash(bytes)!==pointer.sha256)fail('native-host-receipt-pointer-hash');const record=parse(bytes,LIMIT.body);
  const request=api('native-host-request').assertExecutionRequest(row.requestHandle),manifestBytes=read(request.resultFile+'.manifest.json'),manifest=parse(manifestBytes);
  const recovery=api('attempt-recovery');
  if(pointer.file!==request.resultFile+'.receipt.json.'+pointer.sha256+'.json'||record.dispatch_id!==row.dispatch
    ||record.fingerprint!==api('unit-sidecar').artifactFingerprint(request)||nativeDigest(record.route)!==nativeDigest(request.route)
    ||record.manifest_sha256!==hash(manifestBytes)||nativeDigest(manifest.request)!==nativeDigest(request)
    ||record.recovery_identity_sha256!==nativeDigest(recovery.requestIdentity(recovery.canonicalRequest(request))))fail('native-host-receipt-binding');
  if(record.phase==='ready'){
    const native=api('native-execution'),profile=api('native-host-profile');
    if(typeof native.getPublicationAttemptWitness!=='function'||typeof profile.assertPublicationAttemptCurrent!=='function')fail('native-host-publication-attempt-unavailable');
    // ORIGINAL pointer identity is consumed before any copy; JSON cannot restore it.
    const witness=native.getPublicationAttemptWitness(pointer,{request});
    profile.assertPublicationAttemptCurrent(row.profile,witness);
    row.publicationAttemptWitness=witness;row.receipt={pointer:{...pointer},record};
    if(typeof row.activity?.observePublicationAttempt!=='function')fail('native-host-publication-attempt-activity-unavailable');
    const admitted=row.activity.observePublicationAttempt(witness);
    if(admitted&&typeof admitted.then==='function')fail('native-host-publication-attempt-sync-required');
    checkpoint(row,'publication_pending',{receipt:pointer});
  }
}
function assertActivitySettled(runtime){if(!runtime||typeof runtime.assertSettled!=='function')fail('native-host-activity-settlement-unavailable');return runtime.assertSettled();}
async function awaitReturn(row) {
  const profile=api('native-host-profile');
  const captured=await profile.awaitJoinedReturn(row.profile);
  if(!captured||!Buffer.isBuffer(captured.raw)||captured.joined!==true)fail('native-host-writer-unproven');
  row.joined=captured;
  if(!row.accepted){await new Promise((resolve,reject)=>{row.wake=()=>{try{currentChannel(row);if(row.accepted){row.wake=null;resolve();}}catch(error){row.wake=null;reject(error);}};});}
  terminalAdmission(row);const parsed=api('worker-result').parseJsonEnvelope(captured.raw.toString('utf8'));
  if(!parsed.ok||parsed.status!==parsed.payload?.status||!api('native-recovery-delivery').resultContract.validate(parsed.payload).ok)fail('native-host-capture-contract');
  return parsed.payload;
}
async function executeOwner(row) {
  const requestApi=api('native-host-request'),profile=api('native-host-profile'),native=api('native-execution');
  const request=requestApi.readExecutionRequest(row.requestHandle),options=profile.invocationOptions(row.profile,row.requestHandle);
  const lifecycleFile=path.join(row.directory,'native-lifecycle.json');
  options.lifecycle={journal:{root:row.directory,file:lifecycleFile,authorize:probe=>{
    currentChannel(row);return probe.root===row.directory&&probe.file===lifecycleFile;
  }},adapter:lifecycleAdapter(row)};
  options.terminalResult=result=>profile.terminalResult(row.profile,result)&&terminalAdmission(row);
  const preflight=api('native-invocation').buildNativeInvocation(options);requestApi.validateExecutionRequest(row.requestHandle,preflight);profile.assertCapabilityAdmission(row.profile);
  const activity=api('protected-owner-activity');if(typeof activity.withNativeExecutionActivity!=='function')fail('native-host-activity-unavailable');
  let runtime;
  const result=await activity.withNativeExecutionActivity(request,row.profile,async actual=>{
    runtime=actual;row.activity=actual;
    const actualResult=await native.run({request,invocationOptions:options,nativeHostAdmission:row.admission,...requestApi.ownerAdapters(row.context),
      persistDeliveryReceipt:pointer=>persistReceipt(row,pointer),
      invokeNative:async(args,invocation,observer,witness)=>{
        const binding=native.assertOriginalCallbackWitness(witness,{request});
        profile.bindSealedInvocation(row.profile,row.requestHandle,witness,{args,invocation});if(row.enrollment.live)profile.assertSealedIntent(row.profile);else profile.assertLaunchAdmission(row.profile);
        row.sealed={schema_version:1,dispatch_id:row.dispatch,tool:'Agent',arguments:args,invocation_sha256:sha(binding.invocation_sha256),binding};
        writeImmutable(row,'sealed',path.join(row.directory,'sealed-invocation.json'),json(row.sealed));
        row.originalInvocation=invocation;writeReference(row);
        emitOriginalPrepared(row,{kind:'prepared',reference_file:row.referenceFile,reference:reference(row),arguments_file:path.join(row.directory,'sealed-invocation.json'),...(row.enrollment.live?{status:'pending-host',arguments:structuredClone(args),control_commands:liveControlCommands(row)}:{})});
        // The callback acknowledges an actual retained invocation. Its subscription
        // emits the captured result only after candidate equality and all known joins.
        return row.pendingHandle;
      }});
    if(actualResult.published===true){
      const witness=publicationCurrent(row,actualResult,request);
      row.publicationReadback=readback(row,actualResult.delivery);
      if(typeof actual.observePublication!=='function')fail('native-host-publication-settlement-unavailable');
      await actual.observePublication(witness);
    }
    return actualResult;
  });
  assertActivitySettled(runtime);
  if(row.subscriptionError){row.subscriptionError.provider_called=result.outcome?.provider_called??'unknown';throw row.subscriptionError;}
  if(result.published!==true){checkpoint(row,'returned_not_ready',{status:result.status,provider_called:result.outcome?.provider_called??'unknown'});const refusal=Object.assign(new Error('native-host-result-not-ready'),{code:'native-host-result-not-ready',provider_called:row.joined?.provider_called??'unknown'});row.lastError=safeError(refusal);signalCompletion(row,refusal);return result;}
  const proof=readback(row,result.delivery);if(!row.publicationWitness||!row.publicationReadback)fail('native-host-publication-witness-required');row.ready={kind:'execution-ready',...proof};checkpoint(row,'ready',row.ready);signalCompletion(row);return result;
}
// Only queueReplay mints this ephemeral operation; it carries no serialized authority.
const replayPublications=new WeakMap();
function runOriginalReplayPublication(operation,runtime,request){
  const entry=operation&&replayPublications.get(operation);
  if(!entry||entry.row.activity!==runtime||api('protected-owner-activity').currentScope()!==runtime
      ||!entry.row.replaying||entry.row.phase!=='publication_pending'||entry.row.receipt?.record!==entry.receipt
      ||nativeDigest(request)!==entry.request_sha256)fail('native-host-replay-operation-required');
  replayPublications.delete(operation); // one use, including a throwing publication
  const row=entry.row;currentChannel(row);terminalAdmission(row);
  const current=api('native-host-request').readExecutionRequest(row.requestHandle);
  if(nativeDigest(current)!==entry.request_sha256)fail('native-host-replay-request-changed');
  const manifest=parse(read(current.resultFile+'.manifest.json'));
  const session=api('native-recovery-delivery').prepare({request:current,nativeInvocation:row.originalInvocation,savedManifest:manifest,
    ...api('native-host-request').ownerAdapters(row.context),persistDeliveryReceipt:pointer=>persistReceipt(row,pointer),nativeHostAdmission:row.admission});
  const actual=session.replayReady(entry.receipt),witness=publicationCurrent(row,actual,current),proof=readback(row,actual);
  return {witness,proof};
}
function queueReplay(row) {
  if(row.replaying||row.phase!=='publication_pending'||!row.receipt||!row.originalInvocation||!row.joined)fail('native-host-replay-not-ready');
  row.replaying=true;
  Promise.resolve().then(async()=>{
    currentChannel(row);terminalAdmission(row);
    if(typeof row.activity?.replayPublication!=='function')fail('native-host-replay-admission-unavailable');
    const request=api('native-host-request').readExecutionRequest(row.requestHandle),operation=Object.freeze(Object.create(null));
    replayPublications.set(operation,{row,request_sha256:nativeDigest(request),receipt:row.receipt.record});
    let publication;try{publication=row.activity.replayPublication(operation);}finally{replayPublications.delete(operation);}
    const {witness,proof}=publication;
    if(typeof row.activity.observePublication!=='function'||typeof row.activity.retrySettlement!=='function')fail('native-host-publication-settlement-unavailable');
    await row.activity.observePublication(witness);await row.activity.retrySettlement();assertActivitySettled(row.activity);
    row.ready={kind:'replay-ready',...proof};checkpoint(row,'ready',row.ready);signalCompletion(row);
  }).catch(error=>{
    row.replayError=safeError(error);row.lastError=row.replayError;
    // Diagnostic only: no replay failure is promoted to readiness or new authority.
    try{const record=checkpoint(row,'publication_pending',{receipt:row.receipt.pointer,replay_error:row.replayError});
      row.replayDiagnostic={error:row.replayError,checkpoint:record};
    }catch(diagnosticError){row.replayDiagnostic={error:row.replayError,persistence_error:safeError(diagnosticError)};}
    signalCompletion(row,error);
  }).finally(()=>{row.replaying=false;});
  return {queued:true};
}
async function ownerMain(inputFile,observationFile) {
  let row;
  try {
    const context=api('native-host-request').buildOwnerContext(parse(read(inputFile))),host=observationFile?enrollHost(context,observationFile):enrollLiveHost(context),channel=originalOwnerChannel(context,host,inputFile);
    row=channels.get(channel);row.profile=api('native-host-profile').enrollForegroundProfile(context,host);
    row.requestHandle=api('native-host-request').buildExecutionRequest(context,channel);
    api('native-host-profile').assertCapabilityAdmission(row.profile); // Unsupported host opens no writer window.
    await new Promise((resolve,reject)=>{startServer(row).once('listening',resolve).once('error',reject);});
    checkpoint(row,'prepared');await executeOwner(row);
  }catch(error){
    const original=safeError(error);
    if(row){row.lastError=original;try{checkpoint(row,row.receipt?'publication_pending':'failed',original);}catch(checkpointError){row.checkpointError=safeError(checkpointError);}}
    // Preflight errors use the same bounded IPC refusal, even before a channel exists.
    if(row)signalCompletion(row,error);
    tellParent({kind:'refused',error:original,...(row?{directory:row.directory}:{})});
    // Retain uncertain process/window state; never delete a channel or mint a new BEGIN.
  }
  if(row?.ready)signalCompletion(row); // Original owner remains warm until a genuine ready receipt.
  return row;
}
function normalizeReference(value) {
  closed(value,['schema_version','attempt_id','directory','endpoint','owner_identity_sha256','execution_contract_sha256','run_id','claim_generation','begin_checksum','lease_generation','host_session_sha256','dispatch_id','invocation_sha256','channel_identity_sha256',...(Object.hasOwn(value,'request_sha256')?['request_sha256']:[])],'native-host-reference-schema');
  if(value.schema_version!==1)fail('native-host-reference-version');for(const k of ['attempt_id','run_id','dispatch_id'])id(value[k]);
  for(const k of ['owner_identity_sha256','execution_contract_sha256','begin_checksum','host_session_sha256','invocation_sha256','channel_identity_sha256'])sha(value[k]);
  if(Object.hasOwn(value,'request_sha256'))sha(value.request_sha256);
  physical(value.directory,true);if(value.endpoint!==endpoint(value.directory))fail('native-host-reference-endpoint');return value;
}
function client(reference,kind,body,messageId=crypto.randomUUID()) {
  const ref=normalizeReference(reference);if(!Buffer.isBuffer(body)||body.length>LIMIT.body)fail('native-host-client-bound');
  return new Promise((resolve,reject)=>{const socket=net.connect(ref.endpoint);let buffer=Buffer.alloc(0),admitted=false,completed=false;
    socket.once('connect',()=>socket.write(json({protocol_version:1,kind,attempt_id:ref.attempt_id,issuer_message_id:id(messageId),body_bytes:body.length,body_sha256:hash(body)})));
    socket.on('data',chunk=>{try{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>LIMIT.header*2)fail('native-host-ack-bound');let n;
      while((n=buffer.indexOf(10))>=0){const ack=parse(buffer.subarray(0,n),LIMIT.header);buffer=buffer.subarray(n+1);
        if(ack.ack==='refused'){reject(Object.assign(new Error(ack.error.code),ack.error));socket.destroy();return;}
        if(!admitted&&ack.ack==='admitted'){admitted=true;if(body.length)socket.write(body);}
        else if(admitted&&ack.ack==='completion-pending'){/* real completion unproven, not a worker-progress assertion */}
        else if(admitted&&ack.ack==='retained'){completed=true;resolve(ack);if(ack.completion_receipt)socket.write(json({kind:'fixture-ready-received',ready_sha256:nativeDigest(ack.completion_receipt)}));socket.end();}else fail('native-host-ack-order');}
    }catch(error){reject(error);socket.destroy();}});
    socket.once('error',reject);socket.once('close',()=>{if(!completed)reject(Object.assign(new Error('native-host-owner-unavailable'),{code:'native-host-owner-unavailable'}));});
  });
}
function relayClient(ref,raw){
  const envelope=parse(raw,LIMIT.body);closed(envelope,['message','capture'],'native-host-relay-envelope');
  const message=api('native-host-profile').normalizeRelayMessage(envelope.message);
  if(message.attempt_id!==ref.attempt_id||message.dispatch_id!==ref.dispatch_id||message.invocation_sha256!==ref.invocation_sha256)fail('native-host-relay-binding');
  // Metadata correlation is not producer authority; the retained owner still
  // validates sealed IDs, current enrollment, exact capture and known join state.
  return client(ref,'relay',raw,message.issuer_message_id);
}
async function relayHookObservation({attempt,observation,hookSource}={}){
  const expected=physical(path.join(__dirname,'forge-hook.js'));
  if(typeof hookSource!=='string'||physical(hookSource)!==expected)fail('native-host-hook-source-unexpected');
  const before=hash(read(expected));
  const ref=normalizeReference(parse(read(attempt,LIMIT.header))),raw=read(observation,LIMIT.body);
  const ack=await relayClient(ref,raw);
  if(hash(read(expected))!==before)fail('native-host-hook-source-changed');
  return ack; // source bytes/locator do not authenticate who executed this call.
}
function historicalStatus(reference) {
  const ref=normalizeReference(reference),names=fs.readdirSync(ref.directory).filter(n=>/^checkpoint-\d{2}\.json$/.test(n)).sort();
  if(names.length>LIMIT.checkpoints)fail('native-host-checkpoint-count');let previous=null,last=null;
  for(const name of names){const bytes=read(path.join(ref.directory,name),LIMIT.terminal),record=parse(bytes,LIMIT.terminal);
    if(record.attempt_id!==ref.attempt_id||record.previous_sha256!==previous)fail('native-host-checkpoint-chain');previous=hash(bytes);last=record;}
  return {phase:last?.phase||'unknown',historical:true,owner_live:'unknown',writer_join:'unknown',authority:'not-reconstructed',last_checkpoint_sha256:previous};
}
function flags(args) {const out={};for(let i=0;i<args.length;i+=2){if(!/^--[a-z-]+$/.test(args[i])||!args[i+1]||args[i+1].startsWith('--')||out[args[i].slice(2)]!==undefined)fail('native-host-cli-arguments');out[args[i].slice(2)]=args[i+1];}return out;}
async function main(argv=process.argv.slice(2)) {
  const command=argv[0],options=flags(argv.slice(1));
  if(command==='owner'){closed(options,Object.hasOwn(options,'host-observation')?['input','host-observation']:['input'],'native-host-cli-owner');if(!process.send)fail('native-host-retained-owner-required');return ownerMain(options.input,options['host-observation']);}
  if(command==='prepare-budget'){closed(options,['input'],'native-host-cli-prepare-budget');const value=prepareTransportBudget(parse(read(options.input)));process.stdout.write(json(value));return value;}
  if(command==='prepare'){
    closed(options,Object.hasOwn(options,'host-observation')?['input','host-observation']:['input'],'native-host-cli-prepare');physical(options.input);if(options['host-observation'])physical(options['host-observation']);
    // fork's fixed module and closed arguments are the only owner producer.
    return new Promise((resolve,reject)=>{const proc=child.fork(__filename,['owner','--input',options.input,...(options['host-observation']?['--host-observation',options['host-observation']]:[])],{detached:true,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
      let stderrBytes=0,settled=false;proc.stderr.on('data',bytes=>{stderrBytes+=bytes.length;});
      proc.on('message',message=>{if(settled)return;if(message?.kind==='prepared'){settled=true;process.stdout.write(JSON.stringify(message)+'\n');proc.stderr.unref();proc.disconnect();proc.unref();resolve(message);}
        else if(message?.kind==='refused'){settled=true;proc.stderr.unref();proc.disconnect();proc.unref();reject(Object.assign(new Error(message.error.code),message.error));}});
      proc.once('error',reject);proc.once('close',(code,signal)=>{if(!settled)reject(Object.assign(new Error('native-host-owner-closed-before-prepare'),{code:'native-host-owner-closed-before-prepare',exit_code:code,signal,stderr_bytes:stderrBytes}));});
    });
  }
  if(!['accept','relay','status','replay'].includes(command))fail('native-host-cli-command');
  const keys=command==='accept'?(Object.hasOwn(options,'candidate')?['attempt','candidate']:['attempt']):command==='relay'?['attempt','observation']:['attempt'];closed(options,keys,'native-host-cli-shape');
  const ref=normalizeReference(parse(read(options.attempt,LIMIT.header)));
  if(fs.existsSync(liveKeyDirectory(ref.attempt_id))){if(command==='relay'||Object.hasOwn(options,'candidate'))fail('native-host-live-original-hook-required');let result;try{result=await liveControlClient(ref,command);}catch(error){if(!liveHistoricalStatusAllowed(command,error))throw error;result=historicalStatus(ref);}process.stdout.write(JSON.stringify(result)+'\n');return result;}
  let result;
  if(command==='status'){try{result=await client(ref,'status',Buffer.alloc(0));}catch(error){if(!['ENOENT','ECONNREFUSED','native-host-owner-unavailable'].includes(error.code))throw error;result=historicalStatus(ref);}}
  else if(command==='replay')result=await client(ref,'replay',Buffer.alloc(0));
  else if(command==='relay')result=await relayClient(ref,read(options.observation,LIMIT.body));
  else result=await client(ref,options.candidate?'candidate':'captured-candidate',options.candidate?read(options.candidate,LIMIT.body):Buffer.alloc(0));
  process.stdout.write(JSON.stringify(result)+'\n');return result;
}
// LIVE cooperative same-account boundary. HMAC authenticates the fixed enrolled
// hook producer under this threat; it is neither kernel peer auth nor a sandbox.
const LIVE_ID='claude-agent-files-foreground-v1',LIVE_DOMAIN='forge-native463-original-hook/v1';
const CLAUDE_BINARY_SHA='345996b4bdbae21d817f750fae2f34cbf8d81224a5444c78136091d121beb298';
const LIVE_PHASES=['pre','post','post-failure','permission-denied','subagent-start','subagent-stop','stop','session-end','config-change','pre-model-switch','post-model-switch'];
const LIVE_OS_SCRIPT=String.raw`
$ErrorActionPreference='Stop'
try {
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 if($p.action -eq 'process'){
  $v=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$p.pid)
  if(-not $v){throw 'process-missing'}
  $s=Invoke-CimMethod -InputObject $v -MethodName GetOwnerSid
  if($s.ReturnValue -ne 0){throw 'process-owner'}
  @{pid=[int]$v.ProcessId;ppid=[int]$v.ParentProcessId;started=$v.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();exe=[string]$v.ExecutablePath;command_line=[string]$v.CommandLine;sid=[string]$s.Sid}|ConvertTo-Json -Compress
 }else{
  if($p.action -eq 'protect'){
   if(-not [IO.Directory]::Exists($p.file) -or [IO.Directory]::GetFileSystemEntries($p.file).Length -ne 0){throw 'empty-directory-required'}
   $a=[Security.AccessControl.DirectorySecurity]::new();$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false)
   [void]$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
   Set-Acl -LiteralPath $p.file -AclObject $a
  }elseif($p.action -ne 'acl'){throw 'action-invalid'}
  $a=Get-Acl -LiteralPath $p.file
  @{owner=[string]$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;current_user=[string]$sid.Value;protected=[bool]$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=[string]$_.IdentityReference.Value;kind=[string]$_.AccessControlType}})}|ConvertTo-Json -Depth 4 -Compress
 }
}catch{@{error='native-host-os-observation-refused';exception_type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;action=[string]$p.action}|ConvertTo-Json -Compress;exit 2}
`;
function liveOS(packet){
 if(process.platform!=='win32')fail('native-host-live-os-unsupported');
 let result;try{result=child.spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(LIVE_OS_SCRIPT,'utf16le').toString('base64')],{input:JSON.stringify(packet),encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:16384,timeout:10000,windowsHide:true});}catch(error){throw Object.assign(new Error('native-host-os-observation-refused'),{code:'native-host-os-observation-refused',os_diagnostic:osFailureFacts(packet,{error,stderr:'',status:null,signal:null})});}
 if(result.error||result.status!==0)throw Object.assign(new Error('native-host-os-observation-refused'),{code:'native-host-os-observation-refused',os_diagnostic:osFailureFacts(packet,result)});return parse(Buffer.from(result.stdout.replace(/^\uFEFF/,'')),16384);
}
function liveArgv(command){const out=[];let i=0;while(i<command.length){while(/\s/.test(command[i]||''))i++;if(i===command.length)break;let value='',q=false;while(i<command.length&&(q||!/\s/.test(command[i]))){let n=0;while(command[i]==='\\'){n++;i++;}if(command[i]==='"'){value+='\\'.repeat(n>>1);if(n%2)value+='"';else q=!q;i++;}else{value+='\\'.repeat(n);if(i<command.length)value+=command[i++];}}if(q)fail('native-host-live-argv');out.push(value);}return out;}
function liveProcess(pid){if(!Number.isSafeInteger(pid)||pid<=0)fail('native-host-process-id');const p=liveOS({action:'process',pid});if(p.pid!==pid||!Number.isSafeInteger(p.ppid)||typeof p.started!=='string'||!/^\d+$/.test(p.started)||typeof p.sid!=='string'||typeof p.command_line!=='string')fail('native-host-process-observation');physical(p.exe);return p;}
function liveACL(file,directory=false){physical(file,directory);const a=liveOS({action:'acl',file});if(a.owner!==a.current_user||directory&&!a.protected||!Array.isArray(a.rules)||!a.rules.length||a.rules.some(r=>r.sid!==a.current_user||r.kind!=='Allow'))fail('native-host-key-acl');return a;}
function originalHook(phase,hookSource){
 const hook=path.join(liveRuntimeHome(),'forge-hook.js'),main=require.main?.filename;
 const expected=phase==='session-start'?[process.execPath,hook,'session-start']:[process.execPath,hook,'native-live',phase];
 if(hookSource!==hook||!main||path.resolve(main)!==hook||process.execArgv.length||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.argv.length!==expected.length||process.argv.some((v,i)=>v!==expected[i])||phase!=='session-start'&&!LIVE_PHASES.includes(phase))fail('native-host-original-hook-required');
 physical(hook);physical(main);
 const p=liveProcess(process.pid),parent=liveProcess(process.ppid),args=liveArgv(p.command_line);
 if(p.ppid!==parent.pid||p.sid!==parent.sid||args.length!==expected.length||args.some((v,i)=>i<2?path.resolve(v).toLowerCase()!==path.resolve(expected[i]).toLowerCase():v!==expected[i]))fail('native-host-hook-process-unproved');
 binaryPin(parent.exe,CLAUDE_BINARY_SHA);
 // In-memory argv is used only to refuse ambiguous source/mode overrides.
 if(liveArgv(parent.command_line).some(v=>/^--(?:agents|plugin-dir|agent|settings|setting-sources)(?:=|$)/.test(v)))fail('native-host-agent-source-override-unsupported');
 return{p,parent,hook,hook_sha256:hash(read(hook)),bridge_sha256:hash(read(__filename))};
}
// Shared LOWLEVEL packaging only. The caller supplies the lexical result of
// originalHook for the ACTUAL event; this does not mint a SessionStart or actor.
function originalHookBootstrap(who){
 const {parent,hook,hook_sha256}=who,config=liveRuntimeHome();
 return{schema_version:1,kind:'claude-hook-bootstrap',pid:parent.pid,started:parent.started,exe:parent.exe,exe_sha256:CLAUDE_BINARY_SHA,hook_source:hook,hook_sha256,config_dir:config};
}
function collectOriginalHookBootstrap({hookSource}={}){
 return originalHookBootstrap(originalHook('session-start',hookSource));
}
// DATA comparisons only. Neither this helper nor its output is a capability.
function checkedHookCarrier(sessionId,bootstrap,env){
 if(typeof sessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(sessionId))fail('native-host-live-hook-binding');
 const expected=canonicalPrepareSessionValues({hostRuntime:'claude',sessionId},bootstrap),present=expected.filter(([key])=>Object.hasOwn(env,key));
 if(present.length!==0&&present.length!==expected.length)fail('native-host-live-hook-binding');
 if(present.length)for(const[key,value]of expected){const descriptor=Object.getOwnPropertyDescriptor(env,key);if(!descriptor||!Object.hasOwn(descriptor,'value')||descriptor.value!==value)fail('native-host-live-hook-binding');}
 return{sessionId,pid:bootstrap.pid,started:bootstrap.started,source_kind:present.length?'sessionstart-env-current-os':'original-hook-current-os'};
}
function assertOriginalHookSession(sessionId,argv){
 const selected=[];for(let i=1;i<argv.length;i++){if(argv[i]==='--session-id'){if(i+1===argv.length)fail('native-host-live-hook-binding');selected.push(argv[++i]);}else if(argv[i].startsWith('--session-id='))selected.push(argv[i].slice('--session-id='.length));}
 if(selected.length>1||selected.length===1&&selected[0]!==sessionId)fail('native-host-live-hook-binding');
 // Auto-generated interactive session IDs have no CLI selector. The original
 // SDK session still binds the active reference and the original server below.
}
function originalHookBinding(who,raw){
 const measured=originalHookBootstrap(who),bootstrap={pid:measured.pid,started:measured.started,exe:measured.exe,exe_sha256:measured.exe_sha256,hook:measured.hook_source,hook_sha256:measured.hook_sha256,config:measured.config_dir};
 assertOriginalHookSession(raw.session_id,liveArgv(who.parent.command_line));
 return checkedHookCarrier(raw.session_id,bootstrap,process.env);
}
function liveBootstrap(facts){
 if(process.env.FORGE_NATIVE_HOST_BOOTSTRAP_SOURCE!=='claude-sessionstart-process-v1'||process.env.FORGE_CLAUDE_OWNER_SOURCE!=='claude-sessionstart-env-v1'||process.env.FORGE_CLAUDE_OWNER_SESSION_ID!==facts.actor.sessionId)fail('native-host-original-bootstrap-required');
 const pid=Number(process.env.FORGE_NATIVE_HOST_PID),p=liveProcess(pid),exe=physical(process.env.FORGE_NATIVE_HOST_EXE),hook=physical(process.env.FORGE_NATIVE_HOST_HOOK);
 if(p.started!==process.env.FORGE_NATIVE_HOST_STARTED||p.exe.toLowerCase()!==exe.toLowerCase()||process.env.FORGE_NATIVE_HOST_EXE_SHA256!==CLAUDE_BINARY_SHA||hook!==physical(path.join(liveRuntimeHome(),'forge-hook.js'))||hash(read(hook))!==process.env.FORGE_NATIVE_HOST_HOOK_SHA256)fail('native-host-bootstrap-changed');
 binaryPin(exe,CLAUDE_BINARY_SHA);if(liveArgv(p.command_line).some(v=>/^--(?:agents|plugin-dir|agent|settings|setting-sources)(?:=|$)/.test(v)))fail('native-host-agent-source-override-unsupported');
 const ownProcess=liveProcess(process.pid);if(p.sid!==ownProcess.sid)fail('native-host-bootstrap-os-identity');
 const config=liveRuntimeHome();if(process.env.FORGE_NATIVE_HOST_CONFIG_DIR&&physical(path.resolve(process.env.FORGE_NATIVE_HOST_CONFIG_DIR),true)!==config)fail('native-host-bootstrap-config-changed');
 return{pid:p.pid,started:p.started,exe,exe_sha256:CLAUDE_BINARY_SHA,hook,hook_sha256:hash(read(hook)),sid_sha256:hash(p.sid),config};
}
function liveSources(facts,bootstrap){
 const candidates=[path.join(bootstrap.config,'agents','forge-native-files.md'),...[facts.owner,...facts.execution_contract.code_roots.map(r=>r.path)].map(p=>path.join(p,'.claude','agents','forge-native-files.md'))];
 const unique=[...new Set(candidates.map(p=>path.resolve(p)))].filter(p=>fs.existsSync(p));if(unique.length!==1)fail('native-host-agent-source-ambiguous');
 const agent=physical(unique[0]),raw=read(agent),text=raw.toString('utf8');
 if(!/^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(text)||!/^name:\s*forge-native-files\s*$/m.test(text)||!/^tools:\s*Read,\s*Write\s*$/m.test(text)||!/^background:\s*false\s*$/m.test(text)||!/^maxTurns:\s*100\s*$/m.test(text))fail('native-host-files-profile-definition');
 const settings=[path.join(bootstrap.config,'settings.json'),path.join(bootstrap.config,'settings.local.json'),...[facts.owner,...facts.execution_contract.code_roots.map(r=>r.path)].flatMap(p=>[path.join(p,'.claude','settings.json'),path.join(p,'.claude','settings.local.json')])];
 const files=[bootstrap.hook,__filename,agent,...[...new Set(settings)].filter(p=>fs.existsSync(p))];
 assertNativePreSettings([...new Set(settings)],bootstrap);
 return{agent,agent_sha256:hash(raw),pins:files.map(file=>({file:physical(file),sha256:hash(read(file))}))};
}
function enrollLiveHost(context){const facts=contextFacts(context);if(facts.actor.hostRuntime!=='claude')fail('native-host-live-actor');const bootstrap=liveBootstrap(facts),sources=liveSources(facts,bootstrap),witness=own({}),capability=own({});
 const observation={schema_version:1,profile_id:LIVE_ID,host_session:facts.actor.sessionId,provenance:'observed-host',host_binary:{physical_path:bootstrap.exe,sha256:bootstrap.exe_sha256,observed_version:'2.1.322'},agent_definition:{agent_type:'forge-native-files',physical_path:sources.agent,sha256:sources.agent_sha256},effort_requested:facts.route.effort,model_requested:facts.route.model_resolved||facts.route.model};
 const row={live:true,context,bootstrap,liveSources:sources,observation,capability,fixture:null,sources:[]};hostWitnesses.set(witness,row);capabilities.set(capability,row);return witness;}
function currentLiveHost(row){const fresh=liveBootstrap(contextFacts(row.context));if(nativeDigest(fresh)!==nativeDigest(row.bootstrap))fail('native-host-bootstrap-changed');const sources=liveSources(contextFacts(row.context),fresh);if(nativeDigest(sources)!==nativeDigest(row.liveSources))fail('native-host-agent-source-changed');}
function liveKeyDirectory(attempt){return path.join(fs.realpathSync.native(os.tmpdir()),'forge-native463-auth-'+id(attempt));}
function liveKey(row){const dir=liveKeyDirectory(row.attempt),file=path.join(dir,'ingress.key');liveACL(dir,true);liveACL(file);const bytes=read(file,32);if(bytes.length!==32||hash(bytes)!==row.keySha)fail('native-host-key-changed');return copyBuffer(bytes);}
function createLiveKey(row){const dir=liveKeyDirectory(row.attempt);if(rootList(contextFacts(row.context)).some(p=>inside(p,dir))||fs.existsSync(dir))fail('native-host-key-location');fs.mkdirSync(dir,{mode:0o700});liveOS({action:'protect',file:dir});liveACL(dir,true);const key=Buffer.alloc(32);crypto.randomFillSync(key);try{fs.writeFileSync(path.join(dir,'ingress.key'),key,{flag:'wx',mode:0o600});row.keySha=hash(key);liveKey(row).fill(0);}finally{key.fill(0);}}
function liveWindow(row){const value=api('owner-transport-window').observed(contextFacts(row.context).owner),b=value?.binding;if(!b||b.dispatch_id!==row.dispatch||b.request_sha256!==nativeDigest(api('native-host-request').readExecutionRequest(row.requestHandle))||b.host_session_sha256!==nativeDigest(row.enrollment.observation.host_session)||nativeDigest(b.native_host_relay)!==nativeDigest(liveRelayReference(row)))fail('native-host-live-window-required');return value;}
function liveRelayReference(row){return{protocol_version:1,kind:'native-host-live-relay',directory:row.directory,endpoint:endpoint(row.directory),attempt_id:row.attempt,dispatch_id:row.dispatch,request_sha256:nativeDigest(api('native-host-request').readExecutionRequest(row.requestHandle)),host_session_sha256:nativeDigest(row.enrollment.observation.host_session),profile_id:LIVE_ID};}
function assertLiveRelayReference(witness,context,request){const enrollment=hostWitnesses.get(witness);if(!enrollment?.live||enrollment.context!==context||!enrollment.liveChannel)fail('native-host-live-channel-required');currentLiveHost(enrollment);const row=enrollment.liveChannel;if(nativeDigest(api('native-host-request').readExecutionRequest(row.requestHandle))!==nativeDigest(request))fail('native-host-live-request');return liveRelayReference(row);}
function liveShellAtom(value){if(typeof value!=='string'||/[\x00-\x1f]/.test(value))fail('native-host-live-command');return "'"+value.replace(/\\/g,'/').replace(/'/g,"'\\''")+"'";}
function liveControlCommands(row){if(!row.referenceFile)fail('native-host-live-reference-required');const prefix=liveShellAtom(process.execPath)+' '+liveShellAtom(__filename);return Object.fromEntries(['accept','status','replay'].map(command=>[command,prefix+' '+command+' --attempt '+liveShellAtom(row.referenceFile)]));}
function assertLiveControlCommand(witness,context,command){const enrollment=hostWitnesses.get(witness);if(!enrollment?.live||enrollment.context!==context||!enrollment.liveChannel)fail('native-host-live-channel-required');currentLiveHost(enrollment);return Object.values(liveControlCommands(enrollment.liveChannel)).includes(command);}
// Prechallenge transport diagnostics are explicitly UNAUTHENTICATED data.
// They stop this client attempt; they never grant admission, fallback or provider truth.
function checkedReportedSourceError(value){
 if(!sourceErrorDataObject(value,['kind','error_class','frames'])||!Array.isArray(value.frames)||value.frames.length>4)return null;
 const descriptors=Object.getOwnPropertyDescriptors(value.frames);if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||key!=='length'&&(!Object.hasOwn(descriptors[key],'value')||!descriptors[key].enumerable)))return null;
 return checkedSourceError(value);
}
function checkedUnverifiedRefusal(value){
 if(!sourceErrorDataObject(value,['kind','trust','reported_code','reported_stage','reported_source_error'])||value.kind!=='native-host-unverified-prechallenge-refusal-v1'||value.trust!=='UNAUTHENTICATED'||typeof value.reported_code!=='string'||!/^[A-Za-z0-9_.-]{1,160}$/.test(value.reported_code)||!(value.reported_stage===null||typeof value.reported_stage==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(value.reported_stage)))return null;
 const source=value.reported_source_error===null?null:checkedReportedSourceError(value.reported_source_error);if(value.reported_source_error!==null&&!source)return null;
 return{kind:value.kind,trust:'UNAUTHENTICATED',reported_code:value.reported_code,reported_stage:value.reported_stage,reported_source_error:source};
}
function unverifiedPrechallengeRefusal(value){
 if(!sourceErrorDataObject(value,['protocol_version','ack','error'])||value.protocol_version!==1||value.ack!=='refused'||!plain(value.error))return null;
 const error=value.error,descriptors=Object.getOwnPropertyDescriptors(error),keys=Reflect.ownKeys(descriptors),allowed=new Set(['code','stage','provider_called','source_error','os_diagnostic']);
 if(keys.some(key=>typeof key!=='string'||!allowed.has(key)||!Object.hasOwn(descriptors[key],'value')||!descriptors[key].enumerable)||!['code','stage','provider_called'].every(key=>Object.hasOwn(descriptors,key))||typeof error.code!=='string'||!/^[A-Za-z0-9_.-]{1,160}$/.test(error.code)||![true,false,'unknown'].includes(error.provider_called))return null;
 const metadata=checkedUnverifiedRefusal({kind:'native-host-unverified-prechallenge-refusal-v1',trust:'UNAUTHENTICATED',reported_code:error.code,reported_stage:typeof error.stage==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(error.stage)?error.stage:null,reported_source_error:Object.hasOwn(descriptors,'source_error')?checkedReportedSourceError(error.source_error):null});
 if(!metadata)return null;const code='native-host-live-unverified-prechallenge-refusal';return Object.assign(new Error(code),{code,stage:'native-host-live-prechallenge',provider_called:'unknown',unverified_refusal:metadata});
}
function macLive(key,authentication){return crypto.createHmac('sha256',key).update(Buffer.from(LIVE_DOMAIN+'\n'+JSON.stringify(stable(authentication)))).digest();}
function checkLiveMac(key,a,mac){if(typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac))fail('native-host-live-mac');const actual=Buffer.from(mac,'hex'),expected=macLive(key,a);if(!crypto.timingSafeEqual(actual,expected))fail('native-host-live-mac');}
function verifyLiveSender(row,sender,phase){closed(sender,['pid','started','exe_sha256','hook_sha256','bridge_sha256','argv_sha256'],'native-host-live-sender');const p=liveProcess(sender.pid),host=liveProcess(row.enrollment.bootstrap.pid),expected=[process.execPath,row.enrollment.bootstrap.hook,'native-live',phase],argv=liveArgv(p.command_line);
 if(p.ppid!==host.pid||p.started!==sender.started||host.started!==row.enrollment.bootstrap.started||hash(p.sid)!==row.enrollment.bootstrap.sid_sha256||hash(host.sid)!==row.enrollment.bootstrap.sid_sha256||sender.hook_sha256!==row.enrollment.bootstrap.hook_sha256||hash(read(__filename))!==sender.bridge_sha256||hash(read(expected[1]))!==sender.hook_sha256||nativeDigest(expected)!==sender.argv_sha256||argv.length!==expected.length||argv.some((v,i)=>i<2?path.resolve(v).toLowerCase()!==path.resolve(expected[i]).toLowerCase():v!==expected[i]))fail('native-host-live-signer-unproved');binaryPin(p.exe,sender.exe_sha256);binaryPin(host.exe,row.enrollment.bootstrap.exe_sha256);}
function liveBinding(row,window){const facts=contextFacts(row.context);return{attempt_id:row.attempt,actor_sha256:nativeDigest(facts.actor),session_sha256:nativeDigest(facts.actor.sessionId),window_sha256:window.sha256,request_sha256:nativeDigest(api('native-host-request').readExecutionRequest(row.requestHandle)),dispatch_id:row.dispatch};}
function liveHookOutput(phase,allowed){return phase==='pre'?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:allowed?'allow':'deny',permissionDecisionReason:allowed?'Native files profile admitted':'Native files profile refused'}}:{};}
function retainLiveObservation(row,phase,raw,authentication){
 const retained=retainMessage(row,'live-observation','original-hook',crypto.randomUUID(),raw,{phase,sequence:authentication.sequence});
 const handle=own({});observations.set(handle,{owner:row,context:row.context,file:retained.file,sha256:retained.sha256,value:{dispatch_id:row.dispatch,invocation_sha256:row.sealed.invocation_sha256,host_session:row.enrollment.observation.host_session,event_type:phase,provenance:'observed-host',live_authenticated:true}});
 const decision=api('native-host-profile').admitLiveObservation(row.profile,handle);
 if(decision?.control){const previous=row.liveControl;row.liveControl=decision.control.phase==='pre'?decision.control:null;if(decision.control.phase==='post'&&previous&&row.deferredLiveReplay?.tool_use_id===decision.control.tool_use_id&&previous.command===decision.control.command){row.deferredLiveReplay=null;queueReplay(row);}}
 if(decision?.capture){row.genuineReturn=copyBuffer(decision.capture);row.wake?.();}
 return liveHookOutput(phase,true);
}
function serveLiveHook(row,socket,first){
 let handled=false,buffer=Buffer.alloc(0),completionAccepted=false;const challenge={protocol_version:1,kind:'native-host-live-challenge',nonce:crypto.randomBytes(32).toString('hex'),sequence:(row.liveSequence||0)+1,binding:liveBinding(row,liveWindow(row))};reply(socket,liveChallenge(row,challenge));
 socket.on('data',chunk=>{if(handled)return;buffer=Buffer.concat([buffer,chunk]);const at=buffer.indexOf(10);if(buffer.length>LIMIT.body*2){handled=true;socket.end();return;}if(at<0)return;handled=true;
  Promise.resolve().then(async()=>{currentChannel(row);const packet=parse(buffer.subarray(0,at),LIMIT.body*2);closed(packet,['authentication','capture','mac'],'native-host-live-envelope');const a=packet.authentication;closed(a,['domain','binding','sequence','nonce','phase','raw_sha256','raw_bytes','sender'],'native-host-live-authentication');if(a.domain!==LIVE_DOMAIN||!LIVE_PHASES.includes(a.phase)||a.nonce!==challenge.nonce||a.sequence!==challenge.sequence||a.sequence!==(row.liveSequence||0)+1||nativeDigest(a.binding)!==nativeDigest(challenge.binding))fail('native-host-live-replay');
   const key=liveKey(row);try{checkLiveMac(key,a,packet.mac);}finally{key.fill(0);}if(typeof packet.capture!=='string'||Buffer.byteLength(packet.capture)!==a.raw_bytes||a.raw_bytes>LIMIT.body||hash(Buffer.from(packet.capture))!==a.raw_sha256)fail('native-host-live-capture-bound');
   verifyLiveSender(row,a.sender,a.phase);if(nativeDigest(liveBinding(row,liveWindow(row)))!==nativeDigest(challenge.binding))fail('native-host-live-window-changed');if(typeof row.activity?.assertIngressCurrent!=='function')fail('native-host-live-activity-required');row.activity.assertIngressCurrent();row.liveSequence=a.sequence;
   const before=row.liveControl&&{...row.liveControl},output=retainLiveObservation(row,a.phase,Buffer.from(packet.capture),a),commands=liveControlCommands(row);row.activity.assertIngressCurrent();
   if(a.phase==='post'&&before&&!row.liveControl&&[commands.accept,commands.replay].includes(before.command)&&row.accepted){
    completionAccepted=true;row.originalCompletionBinding={...challenge.binding};socket.setTimeout(0);replyLive(row,socket,challenge,{protocol_version:1,ack:'live-completion-pending',ready:false});
    const facts=await waitForCompletion(row,socket);return{ready:facts,sender:a.sender,phase:a.phase};
   }
   return{exit_code:0,hook_output:output};
  }).then(result=>{try{if(result.ready){sendLiveReady(row,socket,challenge,result.ready,()=>verifyLiveSender(row,result.sender,result.phase));return;}replyLive(row,socket,challenge,{protocol_version:1,ack:'live-retained',...result});socket.end();}catch(error){row.lastAcknowledgmentError=safeError(error);socket.destroy();}},error=>{
   if(completionAccepted){row.lastAcknowledgmentError=safeError(Object.assign(error,{provider_called:row.joined?.provider_called??'unknown'}));if(error.code==='native-host-ready-observer-lost')return;try{replyLive(row,socket,challenge,{protocol_version:1,ack:'refused',error:row.lastAcknowledgmentError,exit_code:2,hook_output:completionFailureOutput(row,error)});}catch{socket.destroy();}finally{socket.end();}return;}
   row.lastError=safeError(error);try{checkpoint(row,'failed',row.lastError);}catch{}row.liveFatal=error;try{replyLive(row,socket,challenge,{protocol_version:1,ack:'refused',error:safeError(error),exit_code:2,hook_output:liveHookOutput(first.phase,false)});}catch{socket.destroy();}finally{socket.end();}
  });
 });
}

async function relayCurrentHostHook({owner,phase,capture,hookSource}={}){
 const observed=api('owner-transport-window').observed(owner),ref=observed?.binding?.native_host_relay;if(!ref)return{exit_code:0,hook_output:{}};
 if(typeof capture!=='string'||Buffer.byteLength(capture)>LIMIT.body||!LIVE_PHASES.includes(phase))fail('native-host-live-capture-bound');
 const who=originalHook(phase,hookSource),raw=parse(Buffer.from(capture),LIMIT.body),carrier=originalHookBinding(who,raw);if(raw.session_id!==carrier.sessionId||nativeDigest(raw.session_id)!==ref.host_session_sha256||who.parent.pid!==carrier.pid||who.parent.started!==carrier.started||ref.profile_id!==LIVE_ID||ref.endpoint!==endpoint(physical(ref.directory,true)))fail('native-host-live-hook-binding');
 const keyDir=liveKeyDirectory(ref.attempt_id);liveACL(keyDir,true);liveACL(path.join(keyDir,'ingress.key'));const key=copyBuffer(read(path.join(keyDir,'ingress.key'),32));if(key.length!==32)fail('native-host-key-length');
 try{return await new Promise((resolve,reject)=>{const socket=net.connect(ref.endpoint);let buffer=Buffer.alloc(0),sent=false,done=false;socket.setTimeout(20000,()=>socket.destroy(Object.assign(Error('native-host-live-ipc-cap'),{code:'native-host-live-ipc-cap'})));socket.once('connect',()=>socket.write(json({protocol_version:1,kind:'live-hook',phase})));
  let issued;const readyState={};socket.on('data',chunk=>{try{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>LIMIT.header*2)fail('native-host-live-ack-bound');let at;while((at=buffer.indexOf(10))>=0){const value=parse(buffer.subarray(0,at),LIMIT.header);buffer=buffer.subarray(at+1);if(!sent){const early=unverifiedPrechallengeRefusal(value);if(early)throw early;const {server_mac,...unsigned}=value;checkLiveMac(key,{domain:LIVE_DOMAIN+'/challenge',...unsigned},server_mac);if(value.kind!=='native-host-live-challenge'||value.binding.attempt_id!==ref.attempt_id||value.binding.dispatch_id!==ref.dispatch_id||value.binding.request_sha256!==ref.request_sha256||value.binding.session_sha256!==ref.host_session_sha256||value.binding.window_sha256!==observed.sha256)fail('native-host-live-challenge');issued=value;const a={domain:LIVE_DOMAIN,binding:value.binding,sequence:value.sequence,nonce:value.nonce,phase,raw_sha256:hash(Buffer.from(capture)),raw_bytes:Buffer.byteLength(capture),sender:{pid:who.p.pid,started:who.p.started,exe_sha256:hash(read(process.execPath,128*1024*1024)),hook_sha256:who.hook_sha256,bridge_sha256:who.bridge_sha256,argv_sha256:nativeDigest(process.argv)}};socket.write(json({authentication:a,capture,mac:macLive(key,a).toString('hex')}));sent=true;}else{const {server_mac,...response}=value;checkLiveMac(key,{domain:LIVE_DOMAIN+'/ack',nonce:issued.nonce,sequence:issued.sequence,response},server_mac);if(value.ack==='live-completion-pending'){if(phase!=='post'||readyState.pending)fail('native-host-live-ack-order');readyState.pending=true;socket.setTimeout(0);continue;}if(['live-ready','live-ready-confirmed'].includes(value.ack)){if(!readyState.pending||phase!=='post')fail('native-host-live-ack-order');if(!receiveReadyFrame(socket,key,issued,value,readyState))continue;done=true;resolve({exit_code:0,hook_output:value.hook_output});socket.end();continue;}if(!['live-retained','refused'].includes(value.ack))fail('native-host-live-ack');done=true;resolve({exit_code:value.ack==='live-retained'?0:2,hook_output:value.hook_output||liveHookOutput(phase,false)});socket.end();}}}catch(error){socket.destroy(error);}});socket.once('error',reject);socket.once('close',()=>{if(!done)reject(Object.assign(Error('native-host-live-owner-unavailable'),{code:'native-host-live-owner-unavailable'}));});});}finally{key.fill(0);}
}
function liveChallenge(row,value){const key=liveKey(row);try{return{...value,server_mac:macLive(key,{domain:LIVE_DOMAIN+'/challenge',...value}).toString('hex')};}finally{key.fill(0);}}
function replyLive(row,socket,challenge,response){const key=liveKey(row);try{reply(socket,{...response,server_mac:macLive(key,{domain:LIVE_DOMAIN+'/ack',nonce:challenge.nonce,sequence:challenge.sequence,response}).toString('hex')});}finally{key.fill(0);}}
function verifyControlSender(row,sender,command){
 closed(sender,['pid','started','exe_sha256','bridge_sha256','argv_sha256','host_session_sha256'],'native-host-live-control-sender');const p=liveProcess(sender.pid),expected=[process.execPath,__filename,command,'--attempt',row.referenceFile],args=liveArgv(p.command_line);if(sender.host_session_sha256!==nativeDigest(row.enrollment.observation.host_session)||p.started!==sender.started||hash(read(__filename))!==sender.bridge_sha256||nativeDigest(expected)!==sender.argv_sha256||args.length!==expected.length||args.some((v,i)=>i<2||i===4?path.resolve(v).toLowerCase()!==path.resolve(expected[i]).toLowerCase():v!==expected[i])||hash(p.sid)!==row.enrollment.bootstrap.sid_sha256)fail('native-host-live-control-source');binaryPin(p.exe,sender.exe_sha256);
 let cursor=p,found=false;for(let i=0;i<8;i++){if(cursor.ppid===row.enrollment.bootstrap.pid){const host=liveProcess(cursor.ppid);if(host.started!==row.enrollment.bootstrap.started)fail('native-host-live-control-ancestry');binaryPin(host.exe,row.enrollment.bootstrap.exe_sha256);found=true;break;}cursor=liveProcess(cursor.ppid);if(hash(cursor.sid)!==row.enrollment.bootstrap.sid_sha256||!['bash.exe','sh.exe','cmd.exe','powershell.exe','pwsh.exe'].includes(path.basename(cursor.exe).toLowerCase()))fail('native-host-live-control-ancestry');}if(!found)fail('native-host-live-control-ancestry');
}
function serveLiveControl(row,socket,first){
 const settledStatus=first.command==='status'&&!!row.ready;let control=null;
 if(settledStatus)currentReadyFacts(row);else{if(!row.liveControl||row.liveControl.command!==liveControlCommands(row)[first.command])fail('native-host-live-original-prebash-required');control={...row.liveControl};}
 const challenge={protocol_version:1,kind:'native-host-live-control-challenge',nonce:crypto.randomBytes(32).toString('hex'),sequence:(row.liveSequence||0)+1,binding:completionBinding(row),tool_use_id:control?.tool_use_id??null,command:first.command};reply(socket,liveChallenge(row,challenge));let buffer=Buffer.alloc(0),done=false;
 socket.on('data',chunk=>{if(done)return;buffer=Buffer.concat([buffer,chunk]);if(buffer.length>LIMIT.header*2){done=true;socket.destroy();return;}const at=buffer.indexOf(10);if(at<0)return;done=true;try{
  const packet=parse(buffer.subarray(0,at),LIMIT.header*2);closed(packet,['authentication','mac'],'native-host-live-control-envelope');const a=packet.authentication;closed(a,['domain','binding','nonce','sequence','command','tool_use_id','sender'],'native-host-live-control-authentication');const key=liveKey(row);try{checkLiveMac(key,a,packet.mac);}finally{key.fill(0);}
  if(a.domain!==LIVE_DOMAIN+'/control'||a.nonce!==challenge.nonce||a.sequence!==challenge.sequence||a.sequence!==(row.liveSequence||0)+1||a.command!==first.command||a.tool_use_id!==challenge.tool_use_id||nativeDigest(a.binding)!==nativeDigest(challenge.binding)||nativeDigest(completionBinding(row))!==nativeDigest(challenge.binding)||!settledStatus&&row.liveControl?.tool_use_id!==control.tool_use_id)fail('native-host-live-control-replay');verifyControlSender(row,a.sender,a.command);row.liveSequence=a.sequence;
  if(settledStatus){sendLiveReady(row,socket,challenge,currentReadyFacts(row),()=>verifyControlSender(row,a.sender,a.command));return;}
  let result;if(a.command==='accept'){if(!row.genuineReturn)fail('native-host-live-capture-not-ready');result=acceptCandidate(row,crypto.randomUUID(),copyBuffer(row.genuineReturn));}else result=a.command==='status'?{phase:row.phase,ready:false}:deferLiveReplay(row,control);
  replyLive(row,socket,challenge,{protocol_version:1,ack:'live-control-retained',phase:row.phase,ready:false,...(result||{})});socket.end();
 }catch(error){try{replyLive(row,socket,challenge,{protocol_version:1,ack:'refused',error:safeError(error)});}catch{socket.destroy();}finally{socket.end();}}});
}

function liveControlClient(ref,command){
 if(require.main!==module||process.execArgv.length||process.env.NODE_OPTIONS||process.env.NODE_PATH)fail('native-host-original-control-main-required');const expected=[process.execPath,__filename,command,'--attempt',process.argv[4]];if(process.argv.length!==5||process.argv.some((v,i)=>v!==expected[i]))fail('native-host-original-control-argv');const self=liveProcess(process.pid),keyDir=liveKeyDirectory(ref.attempt_id);liveACL(keyDir,true);liveACL(path.join(keyDir,'ingress.key'));const key=copyBuffer(read(path.join(keyDir,'ingress.key'),32));if(key.length!==32)fail('native-host-key-length');
 return new Promise((resolve,reject)=>{const socket=net.connect(ref.endpoint);let buffer=Buffer.alloc(0),issued=null,done=false;const readyState={};socket.setTimeout(20000,()=>socket.destroy(Object.assign(Error('native-host-live-ipc-cap'),{code:'native-host-live-ipc-cap'})));socket.once('connect',()=>socket.write(json({protocol_version:1,kind:'live-control',command})));socket.on('data',chunk=>{try{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>LIMIT.header*2)fail('native-host-live-ack-bound');let at;while((at=buffer.indexOf(10))>=0){const value=parse(buffer.subarray(0,at),LIMIT.header);buffer=buffer.subarray(at+1);const {server_mac,...unsigned}=value;if(!issued){const early=unverifiedPrechallengeRefusal(value);if(early)throw early;checkLiveMac(key,{domain:LIVE_DOMAIN+'/challenge',...unsigned},server_mac);if(value.kind!=='native-host-live-control-challenge'||value.command!==command||value.binding.attempt_id!==ref.attempt_id||value.binding.dispatch_id!==ref.dispatch_id||value.binding.request_sha256!==ref.request_sha256||value.binding.session_sha256!==ref.host_session_sha256)fail('native-host-live-control-challenge');issued=value;const a={domain:LIVE_DOMAIN+'/control',binding:value.binding,nonce:value.nonce,sequence:value.sequence,command,tool_use_id:value.tool_use_id,sender:{pid:self.pid,started:self.started,exe_sha256:hash(read(process.execPath,128*1024*1024)),bridge_sha256:hash(read(__filename)),argv_sha256:nativeDigest(process.argv),host_session_sha256:nativeDigest(process.env.FORGE_CLAUDE_OWNER_SESSION_ID||'')}};socket.write(json({authentication:a,mac:macLive(key,a).toString('hex')}));}else{checkLiveMac(key,{domain:LIVE_DOMAIN+'/ack',nonce:issued.nonce,sequence:issued.sequence,response:unsigned},server_mac);if(value.ack==='refused')throw Object.assign(new Error(value.error.code),value.error);if(['live-ready','live-ready-confirmed'].includes(value.ack)){if(command!=='status')fail('native-host-live-control-ack');if(!receiveReadyFrame(socket,key,issued,value,readyState))continue;done=true;resolve({...unsigned,phase:'ready',ready:true});socket.end();continue;}if(value.ack!=='live-control-retained')fail('native-host-live-control-ack');done=true;resolve(unsigned);socket.end();}}}catch(error){socket.destroy(error);}});socket.once('error',reject);socket.once('close',()=>{key.fill(0);if(!done)reject(Object.assign(Error('native-host-owner-unavailable'),{code:'native-host-owner-unavailable'}));});});
}


function liveRuntimeHome(){const options=typeof process.env.CLAUDE_CONFIG_DIR==='string'&&process.env.CLAUDE_CONFIG_DIR.trim()?{claudeHome:process.env.CLAUDE_CONFIG_DIR}:{};return physical(api('home').resolveRuntimeHome('claude',options),true);}
function liveHistoricalStatusAllowed(command,error){return command==='status'&&['ENOENT','ECONNREFUSED','native-host-owner-unavailable'].includes(error?.code);}
function safeOSDiagnostic(v){if(!plain(v))return null;const result={};for(const key of ['action','spawn_code','signal','typed_error','exception_type'])if(v[key]===null)result[key]=null;else if(typeof v[key]==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(v[key]))result[key]=v[key];for(const key of ['status','hresult','stderr_captured_bytes','stdout_captured_bytes'])if(v[key]===null)result[key]=null;else if(Number.isSafeInteger(v[key]))result[key]=v[key];for(const key of ['stderr_captured_sha256','stdout_captured_sha256'])if(typeof v[key]==='string'&&/^[a-f0-9]{64}$/.test(v[key]))result[key]=v[key];if(typeof v.stderr_may_be_truncated==='boolean')result.stderr_may_be_truncated=v.stderr_may_be_truncated;return Object.keys(result).length?result:null;}
function osFailureFacts(packet,result){let observed=null;try{if(typeof result.stdout==='string'&&Buffer.byteLength(result.stdout)<=16384)observed=JSON.parse(result.stdout);}catch{}const stderr=typeof result.stderr==='string'?Buffer.from(result.stderr):Buffer.isBuffer(result.stderr)?result.stderr:Buffer.alloc(0);return safeOSDiagnostic({action:['process','acl','protect'].includes(packet.action)?packet.action:'unknown',status:Number.isSafeInteger(result.status)?result.status:null,signal:result.signal||null,spawn_code:result.error?.code||null,typed_error:observed?.error,exception_type:observed?.exception_type,hresult:observed?.hresult,stderr_captured_bytes:stderr.length,stderr_captured_sha256:hash(stderr),stderr_may_be_truncated:result.error?.code==='ENOBUFS'});}

// Pure command classification is DATA, not an admission/capability producer.
function initialPathKey(file){const p=path.resolve(file);return process.platform==='win32'?p.toLowerCase():p;}
function initialShellTokens(command){
 if(typeof command!=='string'||Buffer.byteLength(command)>8192||/[\x00-\x1f\x7f$`;&|<>]/.test(command))fail('native-host-initial-prepare-command');
 const tokens=[];let at=0;while(at<command.length){while(command[at]===' ')at++;if(at===command.length)break;let token='',quote=null;if(command[at]==="'"||command[at]==='"')quote=command[at++];while(at<command.length&&(quote?command[at]!==quote:command[at]!==' ')){if(!quote&&(command[at]==="'"||command[at]==='"'))fail('native-host-initial-prepare-command');token+=command[at++];}if(quote){if(command[at]!==quote)fail('native-host-initial-prepare-command');at++;if(at<command.length&&command[at]!==' ')fail('native-host-initial-prepare-command');}if(!token)fail('native-host-initial-prepare-command');tokens.push(token);}return tokens;
}
function validateInitialPrepareCommand(command){
 if(typeof command!=='string'||!/(?:^|[ \/\\'"])forge-native-host-bridge\.js['"]? +prepare(?: |$)/i.test(command))return null;
 const t=initialShellTokens(command);if(t.length!==5||t[2]!=='prepare'||t[3]!=='--input'||![t[0],t[1],t[4]].every(path.isAbsolute)||initialPathKey(t[0])!==initialPathKey(process.execPath)||initialPathKey(t[1])!==initialPathKey(__filename))fail('native-host-initial-prepare-command');
 if(t.some(value=>value.includes("'"))||command!=='"'+t[0]+'" "'+t[1]+'" prepare --input "'+t[4]+'"')fail('native-host-initial-prepare-command');
 return Object.freeze({nodeToken:path.resolve(t[0]),script:path.resolve(t[1]),input:path.resolve(t[4])});
}
function originalPrepareBinding(facts){return nativeDigest({owner:facts.owner,actor:facts.actor,run_id:facts.run_id,workflow_id:facts.workflow_id,unit:facts.unit,begin_checksum:facts.begin_checksum,lease_generation:facts.lease_generation,claim_generation:facts.claim_generation,execution_contract:facts.execution_contract});}
function assertClosedPrepareShell(commandLine,proof){
 const tokens=liveArgv(commandLine);let index=-1;for(let i=1;i<tokens.length;i++){if(['-c','-lc','-cl'].includes(tokens[i])){index=i;break;}if(!['--noprofile','--norc','--login','-l'].includes(tokens[i]))fail('native-host-prepare-shell-wrapper-unsupported');}
 if(index<0||tokens.length!==index+2)fail('native-host-prepare-shell-wrapper-unsupported');const selected=validateInitialPrepareCommand(tokens[index+1]);if(!selected||initialPathKey(selected.input)!==initialPathKey(proof.input)||initialPathKey(selected.script)!==initialPathKey(__filename)||initialPathKey(selected.nodeToken)!==initialPathKey(proof.node_exe))fail('native-host-prepare-shell-wrapper-unsupported');
}
// Exact observed Claude2.1.322/Windows Git-Bash subset; no shell execution here.
function observedMSYSPath(value){
 if(typeof value!=='string'||value.length>4096||!/^\/[A-Za-z]\/[A-Za-z0-9_.@/+-]+$/.test(value)||value.split('/').some(v=>v==='.'||v==='..'))fail('native-host-prepare-wrapper-path');
 return path.resolve(value[1].toUpperCase()+':/'+value.slice(3));
}
// Same literal quoting as canonical forge-hook.js SessionStart. This is data
// serialization, not enrollment: only measureOriginalPrepare supplies live facts.
function canonicalPrepareSessionValues(actor,bootstrap){
 if(actor?.hostRuntime!=='claude'||!Number.isSafeInteger(bootstrap?.pid)||bootstrap.pid<1||typeof bootstrap.started!=='string'||!/^\d{1,128}$/.test(bootstrap.started)||![bootstrap.exe_sha256,bootstrap.hook_sha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||![bootstrap.exe,bootstrap.hook,bootstrap.config].every(v=>typeof v==='string'&&path.isAbsolute(v)))fail('native-host-prepare-session-exports');
 const values=[
  ['FORGE_CLAUDE_OWNER_SESSION_ID',actor.sessionId],
  ['FORGE_CLAUDE_OWNER_SOURCE','claude-sessionstart-env-v1'],
  ['FORGE_NATIVE_HOST_PID',String(bootstrap.pid)],
  ['FORGE_NATIVE_HOST_STARTED',bootstrap.started],
  ['FORGE_NATIVE_HOST_EXE',bootstrap.exe],
  ['FORGE_NATIVE_HOST_EXE_SHA256',bootstrap.exe_sha256],
  ['FORGE_NATIVE_HOST_HOOK',bootstrap.hook],
  ['FORGE_NATIVE_HOST_HOOK_SHA256',bootstrap.hook_sha256],
  ['FORGE_NATIVE_HOST_CONFIG_DIR',bootstrap.config],
  ['FORGE_NATIVE_HOST_BOOTSTRAP_SOURCE','claude-sessionstart-process-v1'],
 ];
 return values;
}
function canonicalPrepareSessionExports(actor,bootstrap){
 const values=canonicalPrepareSessionValues(actor,bootstrap);
 const quote=value=>{if(typeof value!=='string'||!value||Buffer.byteLength(value)>4096||/[\r\n\0]/.test(value))fail('native-host-prepare-session-exports');return "'"+value.replace(/'/g,"'\"'\"'")+"'";};
 return values.map(([key,value])=>'export '+key+'='+quote(value)).join('\n')+'\n:';
}
function parseObservedPrepareBody(body,proof){
 if(typeof body!=='string'||Buffer.byteLength(body)>16384)fail('native-host-prepare-shell-wrapper-unsupported');
 // Only the exact observed canonical SessionStart block at this one position.
 // Expected bytes are private original-factory data, not caller environment.
 let sessionExports=false;
 if(proof.session_exports!==undefined){
  if(typeof proof.session_exports!=='string'||Buffer.byteLength(proof.session_exports)>16384)fail('native-host-prepare-shell-wrapper-unsupported');
  const tail=' && shopt -u extglob',marker=' && '+proof.session_exports+tail;
  const head=/^source \S+ 2>\/dev\/null \|\| true && export TEMP='[^']*' TMP='[^']*'/.exec(body),position=body.indexOf(marker);
  if(position!==-1){if(!head||position!==head[0].length||body.lastIndexOf(marker)!==position)fail('native-host-prepare-shell-wrapper-unsupported');body=body.slice(0,position)+tail+body.slice(position+marker.length);sessionExports=true;}
 }
 const m=/^source (\S+) 2>\/dev\/null \|\| true && export TEMP='([^']*)' TMP='([^']*)' && shopt -u extglob 2>\/dev\/null \|\| true && \{ \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; \} >\/dev\/null 2>&1 \|\| true && \{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; \} >\/dev\/null 2>&1 \|\| true && eval '([^']*)' < \/dev\/null && pwd -P >\| (\S+)$/.exec(body);
 if(!m||m[2]!==m[3]||/[\x00-\x1f\x7f]/.test(m[2]))fail('native-host-prepare-shell-wrapper-unsupported');
 const selected=validateInitialPrepareCommand(m[4]);if(!selected||initialPathKey(selected.input)!==initialPathKey(proof.input)||initialPathKey(selected.nodeToken)!==initialPathKey(proof.node_exe))fail('native-host-prepare-shell-wrapper-unsupported');
 const snapshot=observedMSYSPath(m[1]),cwdFile=observedMSYSPath(m[5]);
 if(!/^snapshot-bash-\d{13}-[A-Za-z0-9]{6}\.sh$/.test(path.basename(snapshot))||!/^claude-[a-f0-9]{4}-cwd$/.test(path.basename(cwdFile))||!path.isAbsolute(m[2])||initialPathKey(path.dirname(cwdFile))!==initialPathKey(m[2]))fail('native-host-prepare-wrapper-path');
 return Object.freeze({snapshot,temp:path.resolve(m[2]),cwd_file:cwdFile,command_sha256:hash(Buffer.from(m[4])),...(sessionExports?{session_exports_sha256:hash(Buffer.from(proof.session_exports))}:{})});
}
function validateObservedPrepareSnapshot(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>65536||bytes.length===0)fail('native-host-prepare-snapshot-unsupported');
 const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes)||text.includes('\r'))fail('native-host-prepare-snapshot-unsupported');
 const lines=text.split('\n');if(lines.length!==45||lines[44]!==''||!/^export PATH='[^'\r\n\x00-\x1f\x7f`$]*'$/.test(lines[43]))fail('native-host-prepare-snapshot-unsupported');
 const code=lines.slice(0,43).join('\n')+'\n',matches=[...code.matchAll(/(?<==)\/[A-Za-z0-9_./@-]+/g)];
 // This digest pins reviewed shell CODE after its one rg fallback path is
 // parameterized. It does not pin an arbitrary per-session snapshot or PATH.
 if(matches.length!==1||hash(Buffer.from(code.replace(/(?<==)\/[A-Za-z0-9_./@-]+/g,'<RG_FALLBACK_PATH>')))!=='8f3aa35288b505e984510369e0faee96807d53862495ece5618829fc246c76c7')fail('native-host-prepare-snapshot-unsupported');
 observedMSYSPath(matches[0][0]);
 return Object.freeze({sha256:hash(bytes),bytes:bytes.length,code_profile:'claude-2.1.322-bash-rg-pkill-path-v1'});
}
function measureObservedPrepareFiles(selected,enrollment){
 const snapshots=physical(path.join(liveRuntimeHome(),'shell-snapshots'),true),temp=physical(os.tmpdir(),true);
 if(initialPathKey(path.dirname(selected.snapshot))!==initialPathKey(snapshots)||initialPathKey(selected.temp)!==initialPathKey(temp)||rootList(contextFacts(enrollment.context)).some(root=>inside(root,selected.snapshot)||inside(root,selected.cwd_file)))fail('native-host-prepare-wrapper-path');
 physical(selected.snapshot);physical(path.dirname(selected.cwd_file),true);
 if(fs.existsSync(selected.cwd_file)){physical(selected.cwd_file);if(fs.statSync(selected.cwd_file).size>4096)fail('native-host-prepare-wrapper-path');}
 const before=fs.statSync(selected.snapshot),facts=validateObservedPrepareSnapshot(read(selected.snapshot,65536));
 return {file:selected.snapshot,dev:String(before.dev),ino:String(before.ino),...facts};
}
function assertObservedPrepareFilesCurrent(proof){
 physical(proof.file);const current=fs.statSync(proof.file),bytes=read(proof.file,65536);
 if(String(current.dev)!==proof.dev||String(current.ino)!==proof.ino||hash(bytes)!==proof.sha256)fail('native-host-prepare-snapshot-changed');
 validateObservedPrepareSnapshot(bytes);
}

// Read-only transport data. No run/claim/BEGIN, channel, window or spool writer.
function bashTimeoutNumber(raw,fallback){
 if(raw===undefined||raw==='')return{value:fallback,source:'documented-default'};
 if(typeof raw!=='string'||raw.length>128||!/^\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:e[+-]?\d+(?:_\d+)*)?$/i.test(raw.trim()))fail('native-host-prepare-bash-timeout-invalid');
 const value=Number(raw.trim().replace(/_/g,''));if(!Number.isSafeInteger(value)||value<1)fail('native-host-prepare-bash-timeout-invalid');return{value,source:'applied-environment'};
}
function calculatePrepareBudget(unitCeilingMs,env){
 const profile=api('native-host-profile');if(typeof profile.prepareTimeoutCapMs!=='function')fail('native-host-prepare-timeout-profile-unavailable');
 const cap=profile.prepareTimeoutCapMs();if(!Number.isSafeInteger(unitCeilingMs)||unitCeilingMs<1||!Number.isSafeInteger(cap)||cap<1)fail('native-host-prepare-unit-budget');
 const ordinary=bashTimeoutNumber(env.BASH_DEFAULT_TIMEOUT_MS,120000),maximum=bashTimeoutNumber(env.BASH_MAX_TIMEOUT_MS,600000),effective=Math.max(ordinary.value,maximum.value);
 return Object.freeze({schema_version:1,kind:'native-host-prepare-budget',prepare_timeout_ms:Math.min(cap,unitCeilingMs,effective),profile_cap_ms:cap,unit_ceiling_ms:unitCeilingMs,bash_default_timeout_ms:ordinary.value,bash_max_timeout_ms:maximum.value,effective_bash_cap_ms:effective,bash_default_source:ordinary.source,bash_max_source:maximum.source,admission:false});
}
function prepareBudgetForFacts(facts){return calculatePrepareBudget(api('worker-timeout').ceilingFromRoute(facts.route).ms,process.env);}
function prepareTransportBudget(input){
 const request=api('native-host-request'),context=request.buildOwnerContext(input),facts=request.assertOwnerContext(context);
 return Object.freeze({...prepareBudgetForFacts(facts),owner_binding_sha256:originalPrepareBinding(facts),route_sha256:nativeDigest(facts.route)});
}
function assertInitialPrepareTimeout(value,expected){
 if(!Number.isSafeInteger(value)||value<1||!Number.isSafeInteger(expected)||value!==expected)fail('native-host-original-prepare-timeout-mismatch');
}

function measureOriginalPrepare(enrollment,inputFile){
 const expectedOwner=[process.execPath,__filename,'owner','--input',inputFile];if(require.main!==module||!process.send||process.execArgv.length||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.argv.length!==expectedOwner.length||process.argv.some((v,i)=>v!==expectedOwner[i]))fail('native-host-original-prepare-factory-required');
 currentLiveHost(enrollment);
 physical(inputFile);const owner=liveProcess(process.pid),parent=liveProcess(process.ppid),expected=[process.execPath,__filename,'prepare','--input',inputFile],actual=liveArgv(parent.command_line),facts=contextFacts(enrollment.context);
 if(parent.pid!==owner.ppid||hash(parent.sid)!==enrollment.bootstrap.sid_sha256||owner.sid!==parent.sid||actual.length!==expected.length||actual.some((v,i)=>i<2||i===4?initialPathKey(v)!==initialPathKey(expected[i]):v!==expected[i]))fail('native-host-original-prepare-process');binaryPin(parent.exe,hash(read(process.execPath,128*1024*1024)));
 const proof={context:enrollment.context,input:physical(inputFile),input_sha256:hash(read(inputFile)),node_exe:physical(parent.exe),node_pid:parent.pid,node_started:parent.started,argv_sha256:nativeDigest(expected),source_sha256:hash(read(__filename)),binding_sha256:originalPrepareBinding(facts),prepare_timeout_ms:prepareBudgetForFacts(facts).prepare_timeout_ms,session_exports:canonicalPrepareSessionExports(facts.actor,enrollment.bootstrap),consumed:false};
 // Measure every still-live shell between the original prepare and Claude.
 // Only the original direct literal, or exactly the observed three-shell
 // Claude2.1.322 Git-Bash wrapper, is supported. Unknown wrappers still refuse.
 const shells=[];let cursor=parent.ppid;while(cursor!==enrollment.bootstrap.pid&&shells.length<4){const shell=liveProcess(cursor);if(!['bash.exe','sh.exe'].includes(path.basename(shell.exe).toLowerCase())||hash(shell.sid)!==enrollment.bootstrap.sid_sha256)fail('native-host-prepare-shell-wrapper-unsupported');shells.push(shell);cursor=shell.ppid;}
 if(cursor!==enrollment.bootstrap.pid||![1,3].includes(shells.length))fail('native-host-prepare-shell-wrapper-unsupported');
 let snapshot=null;if(shells.length===1){assertClosedPrepareShell(shells[0].command_line,proof);}else{
  if(process.platform!=='win32')fail('native-host-prepare-shell-wrapper-unsupported');const gitRoot=path.resolve(path.dirname(shells[2].exe),'..'),outer=path.join(gitRoot,'bin','bash.exe'),inner=path.join(gitRoot,'usr','bin','bash.exe');
  let selected=null;for(let i=0;i<shells.length;i++){const shell=shells[i],args=liveArgv(shell.command_line);if(initialPathKey(shell.exe)!==initialPathKey(i===2?outer:inner)||args.length!==3||initialPathKey(args[0])!==initialPathKey(shell.exe)||args[1]!=='-c')fail('native-host-prepare-shell-wrapper-unsupported');const current=parseObservedPrepareBody(args[2],proof);if(selected&&nativeDigest(current)!==nativeDigest(selected))fail('native-host-prepare-shell-wrapper-unsupported');selected=current;}
  snapshot=measureObservedPrepareFiles(selected,enrollment);proof.wrapper={profile:'claude-2.1.322-git-bash-three-shell-v1',snapshot_sha256:snapshot.sha256,snapshot_bytes:snapshot.bytes};
 }
 const host=liveProcess(cursor);if(host.started!==enrollment.bootstrap.started||hash(host.sid)!==enrollment.bootstrap.sid_sha256)fail('native-host-original-prepare-ancestry');binaryPin(host.exe,enrollment.bootstrap.exe_sha256);
 for(const shell of shells){const now=liveProcess(shell.pid);if(now.started!==shell.started||now.ppid!==shell.ppid||now.sid!==shell.sid||now.exe!==shell.exe||now.command_line!==shell.command_line)fail('native-host-original-prepare-ancestry');}
 if(snapshot)assertObservedPrepareFilesCurrent(snapshot);return proof;
}
function originalOwnerChannel(context,host,inputFile){const enrollment=hostWitnesses.get(host);if(!enrollment||enrollment.context!==context)fail('native-host-host-witness-required');if(enrollment.live)enrollment.originalPrepare=measureOriginalPrepare(enrollment,inputFile);return createOwnedChannel(context,host);}
function assertOriginalPreparePost(witness,context,post){
 const command=post?.tool_input?.command;
 const enrollment=hostWitnesses.get(witness),proof=enrollment?.originalPrepare,row=enrollment?.liveChannel;if(!enrollment?.live||enrollment.context!==context||!proof||proof.context!==context||proof.consumed||!row?.sealed||!row.originalInvocation||!row.activity)fail('native-host-original-prepare-handoff-required');
 currentLiveHost(enrollment);const parsed=validateInitialPrepareCommand(command);if(!parsed||initialPathKey(parsed.nodeToken)!==initialPathKey(proof.node_exe)||initialPathKey(parsed.script)!==initialPathKey(__filename)||initialPathKey(parsed.input)!==initialPathKey(proof.input)||hash(read(proof.input))!==proof.input_sha256||hash(read(__filename))!==proof.source_sha256||originalPrepareBinding(contextFacts(context))!==proof.binding_sha256)fail('native-host-original-prepare-handoff-changed');
 // Original parent was measured WHILE ALIVE before window opening. This consumes
 // an authenticated matching PostBash, not PID absence, a fabricated Pre, or join.
 assertInitialPrepareTimeout(post?.tool_input?.timeout,proof.prepare_timeout_ms);
 const toolUseId=validateInitialPreparePost(post,row.originalPreparedBytes,row.originalPreparedSHA);proof.consumed=true;proof.tool_use_id=toolUseId;return Object.freeze({kind:'original-prepare-handoff',tool_use_id:toolUseId,prepared_stdout_sha256:row.originalPreparedSHA,input_sha256:proof.input_sha256,source_sha256:proof.source_sha256});
}
function assertNativePreSettings(settings,bootstrap){
 const definitions=[];for(const file of settings.filter(p=>fs.existsSync(p))){const config=parse(read(file));if(Object.hasOwn(config,'disableAllHooks')&&typeof config.disableAllHooks!=='boolean')fail('native-host-native-hook-config');if(config.disableAllHooks===true)fail('native-host-native-hook-disabled');if(config.hooks?.PreToolUse!==undefined){if(!Array.isArray(config.hooks.PreToolUse))fail('native-host-native-hook-config');definitions.push({file,groups:config.hooks.PreToolUse});}}
 if(definitions.length!==1)fail('native-host-native-hook-settings-ambiguous');let found=0;for(const group of definitions[0].groups){if(!plain(group)||!Array.isArray(group.hooks))fail('native-host-native-hook-config');for(const hook of group.hooks){if(!plain(hook))fail('native-host-native-hook-config');if(hook.type!=='command'||!Array.isArray(hook.args)||hook.args.length!==3||hook.args[1]!=='native-live'||hook.args[2]!=='pre')continue;
  if(group.matcher!=='*'||hook.onFailure!=='block'||hook.async===true||typeof hook.command!=='string'||!path.isAbsolute(hook.command)||initialPathKey(hook.command)!==initialPathKey(process.execPath)||typeof hook.args[0]!=='string'||!path.isAbsolute(hook.args[0])||initialPathKey(hook.args[0])!==initialPathKey(bootstrap.hook)||Object.keys(hook).some(k=>!['type','command','args','onFailure','timeout'].includes(k))||hook.timeout!==undefined&&(!Number.isFinite(hook.timeout)||hook.timeout<=0))fail('native-host-native-hook-config');physical(hook.command);physical(hook.args[0]);found++;}}
 if(found!==1)fail('native-host-native-prehook-required');
}


function emitOriginalPrepared(row,payload){const bytes=json(payload);if(bytes.length>LIMIT.body)fail('native-host-initial-prepare-output-bound');if(row.originalPreparedBytes)fail('native-host-initial-prepare-output-conflict');row.originalPreparedBytes=copyBuffer(bytes);row.originalPreparedSHA=hash(bytes);checkpoint(row,'awaiting_host',{invocation_sha256:row.sealed.invocation_sha256,prepared_stdout_bytes:bytes.length,prepared_stdout_sha256:row.originalPreparedSHA});tellParent(payload);}
function validateInitialPreparePost(post,expected,expectedSHA){
 if(!plain(post)||post.hook_event_name!=='PostToolUse'||post.tool_name!=='Bash'||post.agent_id!==undefined)fail('native-host-original-prepare-post-schema');const toolUseId=id(post.tool_use_id),v=post.tool_response;closed(v,['stdout','stderr','interrupted','isImage',...(plain(v)&&Object.hasOwn(v,'noOutputExpected')?['noOutputExpected']:[])],'native-host-original-prepare-post-schema');if(Object.hasOwn(v,'noOutputExpected')&&typeof v.noOutputExpected!=='boolean')fail('native-host-original-prepare-post-schema');
 if(v.interrupted!==false||v.isImage!==false||typeof v.stdout!=='string'||typeof v.stderr!=='string'||Buffer.byteLength(v.stdout)>LIMIT.body||Buffer.byteLength(v.stderr)>16384)fail('native-host-original-prepare-post-incomplete');
 if(!Buffer.isBuffer(expected)||expected.length>LIMIT.body||hash(expected)!==expectedSHA)fail('native-host-original-prepare-output-changed');const original=expected.toString('utf8');if(!original.endsWith('\n')||!Buffer.from(original).equals(expected))fail('native-host-original-prepare-output-changed');
 // Probe545f observed omission of the terminal LF only. No generic trim.
 // No truncation recovery, prompt reconstruction, or dropped context is allowed.
 if(v.stdout!==original&&v.stdout!==original.slice(0,-1))fail('native-host-original-prepare-output-mismatch');return toolUseId;
}

// A readiness observer consumes the ORIGINAL live owner/witness/settlement.
// No saved JSON, locator or receipt is rehydrated into authority.
function currentReadyFacts(row){
 if(!row.ready||!row.publicationWitness||!row.receipt||row.phase!=='ready')fail('native-host-ready-unproven');
 const request=api('native-host-request').readExecutionRequest(row.requestHandle),proof=api('native-execution').assertOriginalPublicationWitness(row.publicationWitness,{request});
 assertActivitySettled(row.activity);readback(row,row.receipt.record);
 return Object.freeze({schema_version:1,kind:'native-host-ready',attempt_id:row.attempt,dispatch_id:row.dispatch,request_sha256:nativeDigest(request),manifest_sha256:proof.manifest.sha256,receipt_sha256:proof.receipt.sha256,artifacts_sha256:nativeDigest(proof.artifacts),activity:'settled',readback:'verified',origin:row.enrollment.live?'observed-host':'fixture-origin',provider_called:row.joined?.provider_called??'unknown'});
}
function signalCompletion(row,error){
 if(!row.completionWaiters)return;for(const waiter of [...row.completionWaiters]){row.completionWaiters.delete(waiter);if(error)waiter.reject(error);else try{waiter.resolve(currentReadyFacts(row));}catch(failure){waiter.reject(failure);}}
}
function waitForCompletion(row,socket){
 if(row.ready)return Promise.resolve(currentReadyFacts(row));
 if(!row.replaying&&row.lastError&&['publication_pending','failed','returned_not_ready'].includes(row.phase))return Promise.reject(Object.assign(new Error(row.lastError.code),row.lastError));
 return new Promise((resolve,reject)=>{const waiter={resolve:value=>{socket.off('close',closed);resolve(value);},reject:error=>{socket.off('close',closed);reject(error);}};function closed(){row.completionWaiters?.delete(waiter);reject(Object.assign(new Error('native-host-ready-observer-lost'),{code:'native-host-ready-observer-lost'}));}(row.completionWaiters||=new Set()).add(waiter);socket.once('close',closed);});
}
function completionHookOutput(facts){return{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'Forge native ready: '+JSON.stringify(facts)}};}
function completionFailureOutput(row,error){return{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'Forge native NOT_READY: '+JSON.stringify({attempt_id:row.attempt,dispatch_id:row.dispatch,phase:row.phase,error:safeError(error)})}};}
function closeAfterReadyReceipt(row){if(row.ready&&row.readyReceiptObserved&&!row.serverClosing){row.serverClosing=true;row.server.close(error=>{if(error)row.closeError=safeError(error);});}}
function deferLiveReplay(row,control){
 if(row.deferredLiveReplay||row.replaying||row.phase!=='publication_pending'||!row.receipt||!row.originalInvocation||!row.joined)fail('native-host-replay-not-ready');row.deferredLiveReplay={tool_use_id:control.tool_use_id,command:control.command};return{queued:true,ready:false};
}
function completionBinding(row){
 if(row.ready){currentReadyFacts(row);if(!row.originalCompletionBinding)fail('native-host-ready-original-binding-required');const current=liveBinding(row,{sha256:row.originalCompletionBinding.window_sha256});if(nativeDigest(current)!==nativeDigest(row.originalCompletionBinding))fail('native-host-ready-authority-changed');return current;}
 return liveBinding(row,liveWindow(row));
}
function sendLiveReady(row,socket,challenge,facts,verifySender){
 const readySHA=nativeDigest(facts);let input=Buffer.alloc(0),done=false;socket.setTimeout(0);
 socket.on('data',chunk=>{if(done)return;input=Buffer.concat([input,chunk]);if(input.length>LIMIT.header*2){done=true;socket.destroy();return;}const at=input.indexOf(10);if(at<0)return;done=true;try{
  const ack=parse(input.subarray(0,at),LIMIT.header);closed(ack,['kind','ready_sha256','mac'],'native-host-ready-receipt-schema');if(ack.kind!=='native-host-ready-received'||ack.ready_sha256!==readySHA)fail('native-host-ready-receipt-binding');const key=liveKey(row);try{checkLiveMac(key,{domain:LIVE_DOMAIN+'/ready-received',nonce:challenge.nonce,sequence:challenge.sequence,binding:challenge.binding,ready_sha256:readySHA},ack.mac);}finally{key.fill(0);}verifySender();if(nativeDigest(currentReadyFacts(row))!==readySHA)fail('native-host-ready-readback-changed');
  row.readyReceiptObserved=true;replyLive(row,socket,challenge,{protocol_version:1,ack:'live-ready-confirmed',exit_code:0,hook_output:completionHookOutput(facts),completion_receipt:facts});socket.end();closeAfterReadyReceipt(row);
 }catch(error){row.lastAcknowledgmentError=safeError(error);try{replyLive(row,socket,challenge,{protocol_version:1,ack:'refused',error:safeError(error),exit_code:2,hook_output:completionFailureOutput(row,error)});}catch{socket.destroy();}finally{socket.end();}}});
 replyLive(row,socket,challenge,{protocol_version:1,ack:'live-ready',exit_code:0,hook_output:completionHookOutput(facts),completion_receipt:facts});
}
function receiveReadyFrame(socket,key,issued,value,readyState){
 if(!plain(value.completion_receipt)||value.completion_receipt.kind!=='native-host-ready'||value.completion_receipt.attempt_id!==issued.binding.attempt_id||value.completion_receipt.dispatch_id!==issued.binding.dispatch_id||value.completion_receipt.request_sha256!==issued.binding.request_sha256||value.completion_receipt.activity!=='settled'||value.completion_receipt.readback!=='verified')fail('native-host-ready-receipt-binding');
 const readySHA=nativeDigest(value.completion_receipt);if(value.ack==='live-ready'){if(readyState.sha)fail('native-host-ready-receipt-order');readyState.sha=readySHA;socket.setTimeout(0);socket.write(json({kind:'native-host-ready-received',ready_sha256:readySHA,mac:macLive(key,{domain:LIVE_DOMAIN+'/ready-received',nonce:issued.nonce,sequence:issued.sequence,binding:issued.binding,ready_sha256:readySHA}).toString('hex')}));return false;}
 if(value.ack!=='live-ready-confirmed'||readyState.sha!==readySHA)fail('native-host-ready-receipt-order');return true;
}
// Fixture compatibility exercises the SAME original-witness completion check,
// explicitly without authenticating a real Claude producer or claiming provider.
function fixtureCompletionReply(row,socket,result,releaseAdmission){
 socket.setTimeout(0);reply(socket,{protocol_version:1,ack:'completion-pending',ready:false});
 waitForCompletion(row,socket).then(facts=>{let bytes=Buffer.alloc(0),done=false;socket.on('data',chunk=>{if(done)return;bytes=Buffer.concat([bytes,chunk]);if(bytes.length>LIMIT.header){done=true;socket.destroy();return;}const at=bytes.indexOf(10);if(at<0)return;done=true;try{const ack=parse(bytes.subarray(0,at),LIMIT.header);closed(ack,['kind','ready_sha256'],'native-host-fixture-ready-receipt');if(ack.kind!=='fixture-ready-received'||ack.ready_sha256!==nativeDigest(currentReadyFacts(row)))fail('native-host-fixture-ready-receipt');row.readyReceiptObserved=true;socket.end();releaseAdmission();closeAfterReadyReceipt(row);}catch{socket.destroy();}});reply(socket,{protocol_version:1,ack:'retained',phase:row.phase,ready:true,completion_receipt:facts,sha256:result?.sha256||null});},error=>{if(error.code==='native-host-ready-observer-lost')return;reply(socket,{protocol_version:1,ack:'retained',phase:row.phase,ready:false,error:safeError(error),sha256:result?.sha256||null});releaseAdmission();socket.end();});
}

module.exports={runOriginalReplayPublication,prepareTransportBudget,validateInitialPrepareCommand,assertOriginalPreparePost,collectOriginalHookBootstrap,relayCurrentHostHook,assertLiveRelayReference,assertLiveControlCommand,main,LIMIT,relayHookObservation,assertOwnedChannel,assertNativeAdmission,assertHostObservation,assertIngressCapability,assertHostObservationAndIngress,assertObservation,assertCandidate};
if(require.main===module)main().catch(error=>{process.stderr.write(JSON.stringify(safeError(error))+'\n');process.exitCode=1;});
