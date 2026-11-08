#!/usr/bin/env node
'use strict';

// forge-communication-surfaces.test.js — proves the orchestration and status
// skills follow shared/forge-communication.md by POINTER, not by a second copy;
// that their message templates follow the five moments without the old
// "Must-haves: todos verificados" claim or fixed model labels; that the
// repository CLAUDE.md is exactly what the projector renders; and that the
// Codex projection of the same skills carries the same pointer and relay line.
//
// Distribution proof only: nothing here shows that a host renders these
// messages or that a human understands them (that is the final UAT round).
//
// Reads repository sources; renders into memory. The only filesystem writes are
// the Codex render's own temporary homes and the temp owners of the milestone
// time admission block, all under os.tmpdir() and removed.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const instructions = require('./forge-instructions');
const interaction = require('./forge-interaction');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');

const ORCHESTRATION = ['forge-auto', 'forge-next', 'forge-task'];
const ALL = [...ORCHESTRATION, 'forge-status'];
const skills = Object.fromEntries(ALL.map(name => [name, read(`skills/${name}/SKILL.md`)]));
const contract = instructions.renderCommunicationContract();
const POINTER = '`shared/forge-communication.md`';
const RELAY = 'siga `shared/forge-bidirectional-sidecar.md § Identidade do sidecar exibida na conversa`: anuncie a solicitação pré-disparo e repasse literalmente as linhas `[forge-agente]` do stderr; as linhas `[forge-sidecar]` ficam no registro técnico e só são repassadas nos casos daquele contrato.';
const FACTS = 'Fatos separados: implementação {estado}; revisão {estado}; CI {estado}; merge {estado}; instalação {estado}; aceite humano {estado}';
const PARTIAL = 'Trabalho parcial salvo em continue.md: {o que ficou feito}. Continua executável: {o que segue}. Decisão pendente: {ID ou nenhuma}. Para retomar: ';
const FIXED_MODEL_LABEL = /\((?:opus|sonnet|haiku|fable|resolved model)\)/i;

let passed = 0;
let failed = 0;
const failures = [];
const temps = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error.message });
    console.log(`FAIL ${name}`);
    console.log(`      ${error.message}`);
  }
}

function count(text, needle) { return text.split(needle).length - 1; }
function between(text, start, end) {
  const from = text.indexOf(start);
  assert(from >= 0, `missing section start: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert(to > from, `missing section end: ${end}`);
  return text.slice(from, to);
}
function taskCreateLines(text) { return text.split('\n').filter(line => line.includes('TaskCreate({')); }

// S02/T07. These are source/distribution contracts, never observations of client
// comprehension, live provider execution or human acceptance. Immutable values
// below came from the owner's pre-T07 capture, independently of the current render.
const crypto = require('crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const baselineBytes = fs.readFileSync(path.join(root, 'scripts/fixtures/milestone-options/distribution-before.json'));
const before = JSON.parse(baselineBytes);
const goldenPath = 'scripts/fixtures/claude-renderer/claude-memory-v2.golden.json';
const golden = JSON.parse(read(goldenPath));
const planner = read('agents/forge-planner.md');
const newMilestone = read('skills/forge-new-milestone/SKILL.md');
const pinReadme = read('scripts/fixtures/claude-renderer/README.md');
const sampleReadme = read('docs/communication-evaluation/README.md');
const sampleBytes = fs.readFileSync(path.join(root, before.samples.file), 'utf8');
const samples = JSON.parse(sampleBytes);
const sourceGuard = require('./forge-dispatch-source-guard');
const smoke = read('scripts/forge-smoke.js');
const smokeStart = smoke.indexOf('// ── Section 61:');
const smokeEnd = smoke.indexOf('// ── Section 62:', smokeStart);
const section61 = smoke.slice(smokeStart, smokeEnd);
// T07 originally changed only Section61. Later explicitly scoped CI fixes to
// the smoke harness are a separate exact postimage, not a regenerated owner
// baseline. Preserve the historical fingerprint and reject any other drift.
const POST_CLOSURE_CI_SMOKE = Object.freeze({
  source_revision: '15820b3626b52d311ed4d014ea8a97abc672e15a',
  outside_section61_sha256: '11144be92ecb59e0be7a298238971578aa061a5c7ae48b7095833991eb91797e',
  reference: 'https://github.com/vh2224/forge-agent/issues/339#issuecomment-6674714308',
});
const t07Labels = [];
// S03/T06 attribution. T06 adds its linked-task text to the ten declared paths only inside
// whole-line `<!-- forge:linked-task:<id>:start -->` … `:end -->` blocks. The S02 pins,
// samples and frozen sources below are NOT re-pinned here (T07 owns that): they are
// compared after removing exactly those blocks from the declared files, which proves that
// every other distributed byte still equals the owner baseline. The raw drift itself is
// measured and named by the T06 group further down, never hidden.
const T06_DECLARED = Object.freeze(['skills/forge-task/SKILL.md', 'skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md',
  'skills/forge-status/SKILL.md', 'shared/forge-milestone-time.md', 'shared/forge-task-preparation.md', 'shared/forge-personal-context.md',
  'shared/forge-review.md', 'shared/forge-dispatch.md', 'scripts/forge-communication-surfaces.test.js']);
const LINKED_BLOCK_RE = /^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm;
function withoutLinked(text) { return String(text).replace(LINKED_BLOCK_RE, ''); }
function attributed(relative, content) { return T06_DECLARED.includes(relative) ? withoutLinked(content) : content; }
function attributedBytes(relative, readRaw = rel => fs.readFileSync(path.join(root, rel))) {
  const bytes = readRaw(relative);
  return T06_DECLARED.includes(relative) ? Buffer.from(withoutLinked(bytes.toString('utf8')), 'utf8') : bytes;
}
// S03/T06-R1. Two genuine pin states are accepted, never a third value:
// - attributed (before T07): each pin equals the measurement WITHOUT the linked blocks;
// - raw re-pinned (T07): a pin equals the actual raw measurement of the current bytes.
// In both states the attributed measurement must still equal the frozen pre-T06 values
// below (the S02 pins measured at T06 start), so a raw re-pin can never hide a byte
// changed outside the linked blocks. T07 owns the real pins; this suite writes none.
const T06_ATTRIBUTED_PINS = Object.freeze({
  agents: '64bbdc40320fe629f19c9e0ceb50256f03544d9d9b0385d416f1563b2abbd41a',
  commands: 'e207fc1bebd540fc28426b6889a3336bd1c334566ead9212817a9be9affd37b6',
  skills: '1309f02bb58b79d61ba0bb1e897cdee4d37c232f488e1548106d4a999e57d061',
  'dispatch-templates': 'a304207c44a93bf68aa9fd220a888533d223c33a2ceea7e283154ef316f2a58e',
  hooks: 'c149db9dd45bed13f05931987217d224a6f23d805dc6e8900e46b32893a41c48',
  mcp: '462d2e1b8ad869aae1ec64cbd198dd176c0e648b4ff51199c8a120c272bed33a',
  'claude-instructions': '90e7c3511e37a7ec6cd972c59572b4aeda2294621c0a7bce8d34aa3b935f6dbb',
  'claude-settings': 'e0fcf0cb5eb91d88ed3363bdba5b41d231330b20289b98383284965c565d56e5',
  configuration: 'c76a23d540a2602293ba45f8821419aa00d738eb08c538b85627596bcc560c3d',
});
// skills/forge-next/SKILL.md at T06 start (= its bytes without the linked blocks), the
// source.sha256 the communication samples cite until T07 re-pins them to the raw bytes.
const T06_ATTRIBUTED_NEXT_SHA = 'e8d04241493f4fa7c5a1db28e075487759fea1dd87dfafdbb750aa06aa723d0f';
// skills/forge-task/SKILL.md at T06 start (= its bytes without the linked blocks); it is also
// the owner-baseline source hash the two forge-task sample nodes cite until T07 re-pins them.
const T06_ATTRIBUTED_TASK_SHA = 'd81556180d9bb16d45a8f81ba6b5faa12ece7f6601a510963f29eb50fe10679b';
// T06-R1 (Repair2). The ACTUAL sample nodes citing the two linked skill sources: two forge-task
// nodes and two forge-next nodes (README table of docs/communication-evaluation). T07 re-pins
// the source.sha256 of ALL FOUR together; nothing else in samples.json may change.
const T06_SAMPLE_SOURCES = Object.freeze([
  Object.freeze({ file: 'skills/forge-task/SKILL.md', attributed: T06_ATTRIBUTED_TASK_SHA,
    pointers: Object.freeze(['/entries/1/supporting/timeline/after', '/entries/5/supporting/timeline/after']) }),
  Object.freeze({ file: 'skills/forge-next/SKILL.md', attributed: T06_ATTRIBUTED_NEXT_SHA,
    pointers: Object.freeze(['/entries/2/supporting/partial/after', '/entries/6/supporting/partial/after']) }),
]);
// Exact [start, end) offsets of every JSON scalar by JSON pointer, so a SHA re-pin is
// checked and restored at its own literal span only, never by replacing matching strings.
function jsonValueSpans(text) {
  const spans = new Map();
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
  const expect = char => { assert.strictEqual(text[i], char, `JSON ${char} at ${i}`); i++; };
  const string = () => {
    const start = i; expect('"');
    while (text[i] !== '"') { assert(i < text.length, 'unterminated JSON string'); i += text[i] === '\\' ? 2 : 1; }
    i++;
    return [start, i];
  };
  const key = raw => JSON.parse(raw).replace(/~/g, '~0').replace(/\//g, '~1');
  const value = pointer => {
    ws();
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i] === '{', close = object ? '}' : ']';
      i++; ws();
      if (text[i] === close) { i++; return; }
      for (let index = 0; ; index++) {
        ws();
        if (object) { const [a, b] = string(); ws(); expect(':'); value(`${pointer}/${key(text.slice(a, b))}`); }
        else value(`${pointer}/${index}`);
        ws();
        if (text[i] === ',') { i++; continue; }
        expect(close); return;
      }
    }
    if (text[i] === '"') { spans.set(pointer, string()); return; }
    const start = i;
    while (i < text.length && !',]} \t\r\n'.includes(text[i])) i++;
    assert(i > start, `JSON value at ${start}`);
    spans.set(pointer, [start, i]);
  };
  value(''); ws();
  assert.strictEqual(i, text.length, 'one JSON document');
  return spans;
}
// Every actual node of the parsed samples whose source cites one of the linked skill files.
function linkedSampleNodes(parsed) {
  const files = T06_SAMPLE_SOURCES.map(source => source.file);
  const found = [];
  const walk = (node, pointer) => {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node) && node.source && typeof node.source === 'object' && files.includes(node.source.file)) found.push({ pointer, node });
    for (const [k, child] of Object.entries(node)) walk(child, `${pointer}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`);
  };
  walk(parsed, '');
  return found;
}
// Replace the literal source.sha256 value of the given actual nodes, span by span.
function withSampleShas(text, replacements) {
  const spans = jsonValueSpans(text);
  const edits = replacements.map(([pointer, sha]) => {
    const span = spans.get(`${pointer}/source/sha256`);
    assert(span, `sample node ${pointer} has a source.sha256`);
    return [span, JSON.stringify(sha)];
  }).sort((a, b) => b[0][0] - a[0][0]);
  return edits.reduce((out, [[start, end], literal]) => out.slice(0, start) + literal + out.slice(end), text);
}
// The only surface whose raw measurement the linked blocks change (measured, see T06 drift note).
const T06_RAW_DRIFT = Object.freeze(['skills']);
function surfaceHash(artifacts, sourceId, raw) {
  return hash(artifacts.filter(row => row.source_id === sourceId).sort((a, b) => a.source.localeCompare(b.source))
    .map(row => `${row.source}\0${(raw ? row.content : attributed(row.source, row.content)).replace(/version=\d+\.\d+\.\d+/g, 'version=<dynamic>')}`).join('\0'));
}
// #341 (M-20261106040502-review-fix-limites S01/T05). A measured distribution delta is layered
// over the S02/T07 and S03/T06 proofs: the historical constants and captures above stay as they
// are; a surface or path declared by the delta must carry a `before` equal to that historical
// value and an `after` equal to the current measurement; everything outside the delta keeps its
// historical assertion unchanged. Distribution proof only (no CI, client or human acceptance).
const DELTA_341_PATH = 'scripts/fixtures/review-policy/distribution-delta.json';
const delta341 = JSON.parse(read(DELTA_341_PATH));
const SHA_RE = /^[0-9a-f]{64}$/;
function deltaRow(delta, kind, key) {
  return delta && delta[kind] && Object.prototype.hasOwnProperty.call(delta[kind], key) ? delta[kind][key] : null;
}
// Attributed (linked blocks removed) value expected now: the historical value itself, or the
// delta's measured after once its before is proven to be exactly that historical value.

// #347 is a subsequent measured layer. These before anchors were read from the
// named base commit, not recomputed from current sources or old owner captures.
const ENTRY_347_PATH = path.join(root, 'scripts/fixtures/entry-contracts/distribution-delta.json');
const ENTRY_347 = JSON.parse(fs.readFileSync(ENTRY_347_PATH, 'utf8'));
const ENTRY_347_MEMBERS = Object.freeze({
  "agents": [
    "agents/forge-advocate.md",
    "agents/forge-completer.md",
    "agents/forge-discusser.md",
    "agents/forge-executor.md",
    "agents/forge-plan-checker.md",
    "agents/forge-planner.md",
    "agents/forge-researcher.md",
    "agents/forge-reviewer.md",
    "agents/forge-worker.md"
  ],
  "hooks": [
    "scripts/forge-hook.js"
  ]
});
const ENTRY_347_RENDER_MEMBERS = Object.freeze({
  "agents": [
    "agents/forge-advocate.md",
    "agents/forge-completer.md",
    "agents/forge-discusser.md",
    "agents/forge-executor.md",
    "agents/forge-memory.md",
    "agents/forge-plan-checker.md",
    "agents/forge-planner.md",
    "agents/forge-researcher.md",
    "agents/forge-reviewer.md",
    "agents/forge-worker.md"
  ],
  "hooks": [
    "scripts/forge-hook.js",
    "scripts/forge-hook.js"
  ]
});
const ENTRY_347_FILES = Object.freeze([
  "agents/forge-advocate.md",
  "agents/forge-completer.md",
  "agents/forge-discusser.md",
  "agents/forge-executor.md",
  "agents/forge-plan-checker.md",
  "agents/forge-planner.md",
  "agents/forge-researcher.md",
  "agents/forge-reviewer.md",
  "agents/forge-worker.md",
  "scripts/forge-hook.js",
  "shared/forge-dispatch.md"
]);
const ENTRY_347_BEFORE_FILES = Object.freeze({
  "agents/forge-advocate.md": {
    "before": "3cb47445f6bc4ddbd8a2ade71ce553f2d1eb5b60e59b3166f7251cc2c989471f",
    "attributed_before": "3cb47445f6bc4ddbd8a2ade71ce553f2d1eb5b60e59b3166f7251cc2c989471f"
  },
  "agents/forge-completer.md": {
    "before": "576c9be21fdab8d128302cd72582dec72f2d3560b142736fcecdfd8710c11a4c",
    "attributed_before": "576c9be21fdab8d128302cd72582dec72f2d3560b142736fcecdfd8710c11a4c"
  },
  "agents/forge-discusser.md": {
    "before": "cf015bf24fb5c3472787d01222f9afa7fb52d166d82a1fd337488a70cebd4979",
    "attributed_before": "cf015bf24fb5c3472787d01222f9afa7fb52d166d82a1fd337488a70cebd4979"
  },
  "agents/forge-executor.md": {
    "before": "40cc7485dc0b67815db6ffdbd3a43b14671d85010c647e795863426cc5aba0dc",
    "attributed_before": "40cc7485dc0b67815db6ffdbd3a43b14671d85010c647e795863426cc5aba0dc"
  },
  "agents/forge-plan-checker.md": {
    "before": "d31f7b7025cdd24a7a42c476204a54b684f083417c57df95244782c05802ffcb",
    "attributed_before": "d31f7b7025cdd24a7a42c476204a54b684f083417c57df95244782c05802ffcb"
  },
  "agents/forge-planner.md": {
    "before": "e97cb09294ef4cea8afc79896a8854836a78122bb5c4451b24fa37daf3fbd02e",
    "attributed_before": "e97cb09294ef4cea8afc79896a8854836a78122bb5c4451b24fa37daf3fbd02e"
  },
  "agents/forge-researcher.md": {
    "before": "40cc2294610659f9de44538e00c9f3cc22a52c27bd7768e68c8a767234db8947",
    "attributed_before": "40cc2294610659f9de44538e00c9f3cc22a52c27bd7768e68c8a767234db8947"
  },
  "agents/forge-reviewer.md": {
    "before": "d2d92895ae7b9a5fb6faa56fa4a3c256d337941bbf1c7386bcab555bd9c5ddf9",
    "attributed_before": "d2d92895ae7b9a5fb6faa56fa4a3c256d337941bbf1c7386bcab555bd9c5ddf9"
  },
  "agents/forge-worker.md": {
    "before": "5924147d58486e2bb16bf16811730a80f20b964c89d553ae39b6ca27cb23e29f",
    "attributed_before": "5924147d58486e2bb16bf16811730a80f20b964c89d553ae39b6ca27cb23e29f"
  },
  "scripts/forge-hook.js": {
    "before": "6d95cf27d00e39d7f20487bd30695436a81cbcc8ef6b5bf9340f2fa5178edfd0",
    "attributed_before": "6d95cf27d00e39d7f20487bd30695436a81cbcc8ef6b5bf9340f2fa5178edfd0"
  },
  "shared/forge-dispatch.md": {
    "before": "04c89ff6107ee798a00c7ab52a1ac644356d0c3269a7965e9b4fe73f6b37cafe",
    "attributed_before": "e53e8989da10f313ba3d8183a43341b814c3b57c4d08b7b5395e9626ab307373"
  }
});
const ENTRY_347_BEFORE_SURFACES = Object.freeze({
  "agents": {
    "before": "30d0fb3fecdb88a4d2ac76dbb5a1ee6669aa3455f1fa41461137f89a164921c0",
    "attributed_before": "30d0fb3fecdb88a4d2ac76dbb5a1ee6669aa3455f1fa41461137f89a164921c0"
  },
  "hooks": {
    "before": "c149db9dd45bed13f05931987217d224a6f23d805dc6e8900e46b32893a41c48",
    "attributed_before": "c149db9dd45bed13f05931987217d224a6f23d805dc6e8900e46b32893a41c48"
  }
});
const ENTRY_347_UNCHANGED = Object.freeze(["claude-instructions","claude-settings","commands","configuration","dispatch-templates","mcp","skills"]);
function entry347Row(delta, kind, key) {
  return delta && delta[kind] && Object.hasOwn(delta[kind], key) ? delta[kind][key] : null;
}
function entry347After(kind, key, prior, delta = ENTRY_347, attributed = false) {
  const row = entry347Row(delta, kind, key);
  if (!row) return prior;
  const beforeKey = attributed ? 'attributed_before' : 'before';
  const afterKey = attributed ? 'attributed_after' : 'after';
  assert.strictEqual(row[beforeKey], prior, '#347 ' + kind + ' ' + key + ': before follows the preceding layer');
  assert.match(row[afterKey], /^[0-9a-f]{64}$/, '#347 measured after');
  return row[afterKey];
}
function validateEntry347(delta, earlier, { measure, readRaw, readme, renderMembers }) {
  assert.deepStrictEqual(Object.keys(delta).sort(), ['schema_version', 'issue', 'provenance', 'surfaces', 'files', 'unchanged_surfaces'].sort(), '#347 closed delta shape');
  assert.strictEqual(delta.schema_version, 1); assert.strictEqual(delta.issue, 347);
  assert.strictEqual(delta.provenance.base_revision, 'ad62d774fc37ec6fcf5a85347d69eaf5c8a8c675', '#347 named base revision');
  assert.strictEqual(typeof delta.provenance.method, 'string'); assert(delta.provenance.method.length > 0);
  assert.deepStrictEqual(Object.keys(delta.surfaces).sort(), ['agents', 'hooks'], '#347 exact affected surfaces');
  assert.deepStrictEqual(Object.keys(delta.files).sort(), [...ENTRY_347_FILES].sort(), '#347 exact changed files');
  assert.deepStrictEqual([...delta.unchanged_surfaces].sort(), [...ENTRY_347_UNCHANGED], '#347 exact untouched surfaces');
  assert.deepStrictEqual(Object.keys(renderMembers).sort(), ['agents', 'hooks'], '#347 exact rendered member groups');
  for (const [id, expected] of Object.entries(ENTRY_347_RENDER_MEMBERS)) assert.deepStrictEqual([...renderMembers[id]].sort(), [...expected].sort(), '#347 exact rendered members ' + id);
  for (const [kind, anchors] of [['surfaces', ENTRY_347_BEFORE_SURFACES], ['files', ENTRY_347_BEFORE_FILES]]) {
    for (const [key, anchor] of Object.entries(anchors)) {
      const row = delta[kind][key];
      assert.deepStrictEqual(Object.keys(row).sort(), ['before', 'after', 'attributed_before', 'attributed_after'].sort(), '#347 closed row ' + key);
      for (const field of ['before','after','attributed_before','attributed_after']) assert.match(row[field], /^[0-9a-f]{64}$/, '#347 hash ' + key + '/' + field);
      assert.strictEqual(row.before, anchor.before, '#347 immutable base raw ' + key);
      assert.strictEqual(row.attributed_before, anchor.attributed_before, '#347 immutable base attributed ' + key);
      const previous = earlier[kind] && earlier[kind][key];
      if (previous) {
        assert.strictEqual(row.before, previous.after, '#347 raw chain after #341 ' + key);
        assert.strictEqual(row.attributed_before, previous.attributed_after || previous.after, '#347 attributed chain after #341 ' + key);
      }
      assert.notStrictEqual(row.before, row.after, '#347 actual change ' + key);
      if (kind === 'surfaces') {
        assert.strictEqual(row.after, row.attributed_after, '#347 surfaces have no linked blocks ' + key);
        assert.strictEqual(measure(key), row.after, '#347 measured surface ' + key);
        assert(readme.includes(row.before) && readme.includes(row.after), '#347 README records ' + key + ' before/after');
      } else {
        const raw = readRaw(key);
        assert.strictEqual(hash(raw), row.after, '#347 measured file ' + key);
        assert.strictEqual(hash(Buffer.from(raw.toString('utf8').replace(LINKED_BLOCK_RE, ''), 'utf8')), row.attributed_after, '#347 measured attributed file ' + key);
      }
    }
  }
}

function attributedNow(kind, key, historical, delta = delta341, entryDelta = ENTRY_347) {
  const row = deltaRow(delta, kind, key);
  if (!row) return entry347After(kind, key, historical, entryDelta, true);
  assert.strictEqual(row.attributed_before || row.before, historical, `#341 delta ${kind} ${key}: before is the versioned historical value`);
  const after = row.attributed_after || row.after;
  assert(SHA_RE.test(after), `#341 delta ${kind} ${key}: measured after`);
  return entry347After(kind, key, after, entryDelta, true);
}
test('S02 review R61-R63: interrupted modern enrollment cannot select legacy planning', () => {
  const { spawnSync } = require('child_process');
  const selection = require('./forge-milestone-time-selection');
  const controller = require('./forge-unit-controller');
  const state = require('./forge-state');
  const time = require('./forge-milestone-time');
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const milestone = 'M991';
  const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
  const blocks = [];
  for (const name of ['forge-next', 'forge-auto']) {
    const source = skills[name];
    const start = source.indexOf('if [ "$RUN_KIND" = "milestone" ] && [ "$STATUS" = "activate-new" ]; then');
    const end = source.indexOf('\nif [ -n "$PERSONAL_ARG" ]; then', start);
    assert(start >= 0 && end > start);
    blocks.push([name, source.slice(start, end)]);
    if (name === 'forge-auto') {
      const second = source.indexOf('if [ -n "$RUN_ID" ] && [ "$RUN_KIND" = "milestone" ]; then', end);
      const close = source.indexOf('\n```', second);
      assert(second >= 0 && close > second);
      blocks.push([name + '-load', source.slice(second, close)]);
    }
  }
  for (const [name, block] of blocks) {
    assert(block.indexOf('--enroll') < block.indexOf('--create'), name + ': publication order');
    for (const cut of ['before-enrollment', 'after-enrollment', 'before-state', 'after-state']) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bootstrap-restart-')); temps.push(cwd);
      fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true });
      const dir = path.join(cwd, '.gsd/milestones', milestone); fs.mkdirSync(dir, { recursive: true });
      for (const kind of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) fs.writeFileSync(path.join(dir, `${milestone}-${kind}.md`), '# ' + kind + '\n');
      const run = interruption => spawnSync(bash, ['-c', `
node() {
  case "$1" in
    *forge-milestone-time-selection.js)
      [ "$CUT" != before-enrollment ] || return 75
      command "$REAL_NODE" "$@" || return $?
      [ "$CUT" != after-enrollment ] || return 75 ;;
    *forge-state.js)
      [ "$CUT" != before-state ] || return 75
      command "$REAL_NODE" "$@" || return $?
      [ "$CUT" != after-state ] || return 75 ;;
    *) command "$REAL_NODE" "$@" ;;
  esac
}
${block}`], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, CUT: interruption,
        REAL_NODE: process.execPath.replace(/\\/g, '/'), FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'),
        RUN_ID: milestone, RUN_KIND: 'milestone', STATUS: 'activate-new', WORKING_DIR: cwd.replace(/\\/g, '/') } });
      const stopped = run(cut);
      assert.strictEqual(stopped.status, 1, `${name}/${cut}: ${stopped.stderr}`);
      const stateFile = path.join(dir, `${milestone}-STATE.md`);
      assert.strictEqual(fs.existsSync(stateFile), cut === 'after-state');
      const enrolled = time.readEnrollment({ cwd, milestone });
      assert.strictEqual(enrolled.status, cut === 'before-enrollment' ? 'absent' : 'valid');
      const enrollmentBytes = enrolled.status === 'valid' ? fs.readFileSync(time.timePaths({ cwd, milestone }).enrollment) : null;
      const resumed = run(''); assert.strictEqual(resumed.status, 0, `${name}/${cut}: ${resumed.stderr}`);
      assert.strictEqual(selection.readSelectionState(cwd, milestone).status, 'estimate-required');
      assert.strictEqual(controller.select(cwd, { milestone }, { prefsReader }).unit.key, `estimate-milestone/${milestone}`);
      assert.throws(() => controller.begin(cwd, { milestone, unit: `plan-milestone/${milestone}`, host_runtime: 'codex', owner_token: 'bootstrap', idempotency_key: 'early-plan' }, { prefsReader }), e => e.code === 'time-option-pending');
      if (enrollmentBytes) assert.deepStrictEqual(fs.readFileSync(time.timePaths({ cwd, milestone }).enrollment), enrollmentBytes, 'idempotent replay');
      assert.strictEqual(time.readSelection({ cwd, milestone }).status, 'absent', 'restart never answers a question');
      assert.strictEqual(state.read(cwd, milestone).phase, 'estimate-milestone');
    }
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bootstrap-legacy-')); temps.push(legacy);
    fs.mkdirSync(path.join(legacy, '.gsd/forge'), { recursive: true });
    fs.mkdirSync(path.join(legacy, '.gsd/milestones', milestone), { recursive: true });
    state.write(legacy, { milestone, kind: 'milestone', phase: 'plan-milestone', active_slice: '—', active_task: '—', auto_mode: 'on', next_action: 'plan-milestone' });
    const old = state.read(legacy, milestone);
    // Existing genuine legacy STATE keeps selection on its legacy path.
    assert.strictEqual(selection.readSelectionState(legacy, milestone), null);
    assert.strictEqual(controller.select(legacy, { milestone }, { prefsReader }).unit.key, `plan-milestone/${milestone}`);
    assert.deepStrictEqual(state.read(legacy, milestone), old);
  }
  console.log('ok - S02 review R61-R63: interrupted modern enrollment cannot select legacy planning');
});
function t07(name, fn) {
  test(`T07 distribution: ${name}`, () => {
    fn();
    const line = `ok - T07 distribution: ${name}`;
    t07Labels.push(line);
    console.log(line);
  });
}
function atPointer(value, pointer) {
  return pointer.split('/').slice(1).reduce((current, key) => current[key], value);
}
// Fixture seams (T06-R1): the defaults are the real checked-in pins, README, render and
// sources; the T06 group passes in-memory variants only, never writing any pin.
function checkPins(fixture = {}) {
  const entryDelta = fixture.entryDelta === undefined ? ENTRY_347 : fixture.entryDelta;
  const pins = fixture.golden || golden;
  const readme = fixture.pinReadme === undefined ? pinReadme : fixture.pinReadme;
  const delta = fixture.delta === undefined ? delta341 : fixture.delta;
  let artifacts = fixture.artifacts;
  if (!artifacts) {
    const renderer = require('./forge-claude-renderer');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-t07-pins-')); temps.push(temp);
    artifacts = renderer.render({ repo: root, projectRoot: temp, claudeHome: path.join(temp, 'host'), forgeHome: path.join(temp, 'forge') }).artifacts;
  }
  validateEntry347(entryDelta, delta, { measure: id => surfaceHash(artifacts, id, true),
    renderMembers: Object.fromEntries(['agents', 'hooks'].map(id => [id, artifacts.filter(item => item.source_id === id).map(item => item.source)])),
    readRaw: fixture.readSource || (rel => fs.readFileSync(path.join(root, rel))), readme });
  assert.strictEqual(pins.surfaces.length, 9);
  assert.deepStrictEqual(pins.surfaces.map(({ sha256, ...identity }) => identity),
    before.active_golden_before.surfaces.map(({ sha256, ...identity }) => identity));
  const old = new Map(before.active_golden_before.surfaces.map(row => [row.source_id, row.sha256]));
  const changed = [];
  const repinned = [];
  for (const surface of pins.surfaces) {
    const attributedHash = surfaceHash(artifacts, surface.source_id, false);
    const rawHash = surfaceHash(artifacts, surface.source_id, true);
    // Strict historical attribution in BOTH pin states: outside the linked blocks every byte is the pre-T06 one
    // (#341: a declared surface instead equals its measured delta after, whose before is that pre-T06 value).
    assert.strictEqual(attributedHash, attributedNow('surfaces', surface.source_id, T06_ATTRIBUTED_PINS[surface.source_id], delta, entryDelta), `attributed pre-T06 bytes ${surface.source_id}`);
    assert(surface.sha256 === attributedHash || surface.sha256 === rawHash,
      `final measured ${surface.source_id}: pin ${surface.sha256} is neither the attributed ${attributedHash} nor the raw ${rawHash}`);
    if (surface.sha256 !== attributedHash) {
      assert(T06_RAW_DRIFT.includes(surface.source_id), `raw re-pin only of the measured T06 drift: ${surface.source_id}`);
      repinned.push(surface.source_id);
    }
    const row341 = deltaRow(delta, 'surfaces', surface.source_id);
    if (row341) {
      assert(surface.sha256 === entry347After('surfaces', surface.source_id, row341.after, entryDelta) || surface.sha256 === entry347After('surfaces', surface.source_id, row341.attributed_after || row341.after, entryDelta, true), `#341 pin ${surface.source_id} is a measured delta after`);
      assert(readme.includes(row341.before) && readme.includes(surface.sha256), `#341 documented before/after ${surface.source_id}`);
    }
    if (old.get(surface.source_id) !== surface.sha256) {
      changed.push(surface.source_id);
      assert(readme.includes(old.get(surface.source_id)) && readme.includes(surface.sha256), `documented actual ${surface.source_id}`);
    }
  }
  assert.deepStrictEqual(changed.sort(), [...new Set([...before.allowed_active_changes, ...Object.keys(entryDelta.surfaces)])].sort(), 'historical changes plus exactly the #347 surfaces');
  for (const historical of before.historical_goldens) assert.strictEqual(hash(fs.readFileSync(path.join(root, historical.path))), historical.sha256, historical.path);
  // Every unrelated input captured by the owner still has its exact original bytes.
  const allowed = new Set([goldenPath, 'agents/forge-planner.md', 'agents/forge-worker.md', 'skills/forge-auto/SKILL.md',
    'skills/forge-next/SKILL.md', 'skills/forge-help/SKILL.md', 'skills/forge-new-milestone/SKILL.md',
    'shared/templates/dispatch/plan-slice.md', before.samples.file, 'scripts/forge-dispatch-source-guard.js', 'scripts/forge-smoke.js']);
  for (const source of before.sources) if (!allowed.has(source.path)) {
    assert.strictEqual(hash(attributedBytes(source.path, fixture.readSource)), attributedNow('files', source.path, source.sha256, delta, entryDelta), `unchanged source ${source.path}`);
  }
  assert(readme.includes(before.provenance.source_revision));
  assert(readme.includes('T05') && readme.includes('configuration') && readme.includes('forge-claude-renderer.render'));
  return { repinned };
}
function checkSamples(fixture = {}) {
  const bytes = fixture.sampleBytes === undefined ? sampleBytes : fixture.sampleBytes;
  const readme = fixture.sampleReadme === undefined ? sampleReadme : fixture.sampleReadme;
  const sourceBytes = fixture.sourceBytes || {};
  const delta = fixture.delta === undefined ? delta341 : fixture.delta;
  const parsed = JSON.parse(bytes);
  const nodes = linkedSampleNodes(parsed);
  const oldNext = new Map(before.samples.next_samples.map(row => [row.pointer, row]));
  const baselineTask = before.sources.filter(row => row.path === 'skills/forge-task/SKILL.md').map(row => row.sha256);
  assert.deepStrictEqual([...new Set(baselineTask)], [T06_ATTRIBUTED_TASK_SHA], 'owner baseline forge-task hash is the attributed pre-T06 one');
  assert.deepStrictEqual(nodes.map(node => node.pointer).sort(), T06_SAMPLE_SOURCES.flatMap(source => source.pointers).sort(),
    'exactly the two actual forge-task and two actual forge-next sample nodes cite the linked sources');
  const restorations = [];
  const result = { repinnedNodes: {} };
  for (const source of T06_SAMPLE_SOURCES) {
    const raw = sourceBytes[source.file] || fs.readFileSync(path.join(root, source.file));
    const attributedHash = hash(attributedBytes(source.file, () => raw));
    const rawHash = hash(raw);
    const text = raw.toString('utf8').replace(/\r\n/g, '\n');
    // Strict historical attribution in BOTH sample states: outside its linked blocks the source is the pre-T06 file
    // (#341: or the measured delta after of that declared file, whose before is the pre-T06 value).
    assert.strictEqual(attributedHash, attributedNow('files', source.file, source.attributed, delta), `${source.file} outside the linked blocks keeps its pre-T06 bytes`);
    assert.notStrictEqual(rawHash, attributedHash, `${source.file}: the linked blocks really change the raw bytes`);
    const cited = new Set();
    for (const pointer of source.pointers) {
      const current = atPointer(parsed, pointer);
      assert.strictEqual(current.source.file, source.file, `${pointer} cites ${source.file}`);
      // The owner-baseline value of this exact node (pre-S02 for forge-next, unchanged since for forge-task).
      const old = oldNext.get(pointer);
      const baselineHash = source.file === 'skills/forge-next/SKILL.md' ? old.source.sha256 : T06_ATTRIBUTED_TASK_SHA;
      if (old) {
        assert.deepStrictEqual({ ...current.source, sha256: old.source.sha256 }, old.source, `${pointer} metadata`);
        assert.strictEqual(current.text, old.text, 'quoted text is unchanged');
      }
      assert.strictEqual(typeof current.text, 'string', `${pointer} quotes text`);
      assert(text.includes(current.text), `${pointer}: quotation remains literal in ${source.file}`);
      assert(current.source.sha256 === attributedHash || current.source.sha256 === rawHash,
        `${pointer}: source.sha256 ${current.source.sha256} is neither the attributed ${attributedHash} nor the raw ${rawHash}`);
      if (current.source.sha256 !== baselineHash) {
        assert(readme.includes(baselineHash) && readme.includes(current.source.sha256), `document actual ${source.file} source hashes`);
      }
      const node341 = delta && delta.samples ? delta.samples.nodes.find(row => row.pointer === pointer) : null;
      if (node341 && current.source.sha256 === rawHash) {
        assert.strictEqual(node341.file, source.file, `#341 sample ${pointer} cites ${source.file}`);
        assert.strictEqual(current.source.sha256, node341.after, `#341 sample ${pointer} cites the measured after`);
        assert(readme.includes(node341.before) && readme.includes(node341.after), `#341 documented sample ${pointer}`);
      }
      cited.add(current.source.sha256);
      restorations.push([pointer, baselineHash]);
    }
    assert.strictEqual(cited.size, 1, `every cited ${source.file} sample carries the same source hash`);
    const [citedHash] = cited;
    const state = citedHash === attributedHash ? 'attributed' : 'raw-repinned';
    assert(result.state === undefined || result.state === state,
      'forge-task and forge-next sample nodes are re-pinned together (T07 re-pins both), never one source alone');
    result.state = state;
    result.repinnedNodes[source.file] = state === 'raw-repinned' ? source.pointers.length : 0;
    if (source.file === 'skills/forge-next/SKILL.md') result.nextHash = citedHash; else result.taskHash = citedHash;
  }
  // Restore exactly the four actual source.sha256 spans to their owner-baseline values and
  // prove equality of ALL other sample bytes (texts, labels, references, layout).
  const restored = withSampleShas(bytes, restorations);
  assert.strictEqual(hash(restored), before.samples.sha256, 'only literal source.sha256 fields changed');
  return result;
}
function checkRegistry(fixture = {}) {
  const delta = fixture.delta === undefined ? delta341 : fixture.delta;
  const audit = sourceGuard.audit({ root });
  assert.strictEqual(audit.ok, true, JSON.stringify(audit));
  const old = new Map(before.dispatch_registry.rows.map(row => [row.id, row]));
  const current = sourceGuard.SOURCE_REGISTRY;
  assert.strictEqual(current.length, 248, 'actual registry count (inline planner was outside registry scope)');
  assert.strictEqual(current.length, before.dispatch_registry.rows.length, 'measured count delta zero');
  const changed = [];
  for (const row of current) {
    const prior = old.get(row.id); assert(prior, `no silent new/removed call ${row.id}`);
    assert.deepStrictEqual({ ...row, fingerprint: prior.fingerprint }, prior, `retained classification/reason ${row.id}`);
    if (row.fingerprint !== prior.fingerprint) changed.push(row.id);
  }
  assert.deepStrictEqual(changed, [], 'actual measurement found no fingerprint drift; no artificial registry edit');
  for (const id of changed) assert(pinReadme.includes(id), `document changed registry row ${id}`);
  if (delta) {
    // #341: the delta declares exactly the measured registry change (count kept, none added, removed or drifted).
    assert.strictEqual(current.length, delta.registry.count, '#341 delta keeps the registry count');
    assert.deepStrictEqual([delta.registry.added, delta.registry.removed], [[], []], '#341 adds or removes no registered call');
    assert.deepStrictEqual(delta.registry.drifted_rows.map(row => row.after_id), changed, '#341 declares exactly the measured fingerprint drift');
  }
}
function assertSmokeScope(text) {
  const start = text.indexOf('// ── Section 61:'), end = text.indexOf('// ── Section 62:', start);
  assert(start >= 0 && end > start, 'smoke scope markers remain present');
  const actual = hash(text.slice(0, start) + '<allowed-section61>\n' + text.slice(end));
  assert(actual === before.smoke.outside_section61_sha256 || actual === POST_CLOSURE_CI_SMOKE.outside_section61_sha256,
    'unrecognized smoke changes outside Section61 and the exact post-closure CI scope');
}
function checkSmoke() {
  assert(smokeStart >= 0 && smokeEnd > smokeStart);
  assertSmokeScope(smoke);
  assert.throws(() => assertSmokeScope(smoke + '\n// unexpected out-of-scope change\n'), /unrecognized smoke changes/,
    'an unenumerated change still fails the real smoke scope guard');
  assert.notStrictEqual(hash(section61), before.smoke.section61_sha256);
  assert.strictEqual(count(planner, 'ROUTING_DOMAINS'), 2);
  assert.strictEqual(count(newMilestone, 'ROUTING_DOMAINS'), 0);
  assert(/open-set/.test(planner) && /No keyword auto-detection/.test(planner));
  // Execute JUST the exact shipping Section61 with its actual final sources. This
  // is a distribution contract check, not a claim that the full smoke ran.
  const passes = [];
  require('vm').runInNewContext(`${section61}\nsmokeRoutingDomains();`, {
    fs, path, SCRIPTS: path.join(root, 'scripts'), assert: (condition, message) => assert(condition, message),
    process: { stdout: { write() {} } }, pass: message => passes.push(message), __filename: path.join(root, 'scripts/forge-smoke.js'),
  });
  assert.strictEqual(passes.length, 1);
  assert(section61.includes("'skills/forge-new-milestone/SKILL.md': 0"));
}
function checkTimeSkill(name, text) {
  assert(text.includes('--phase estimate-milestone'), `${name} STATE phase`);
  const enrollment = `--enroll --source ${name}`;
  assert(text.includes(enrollment), `${name} enrollment`);
  assert(text.indexOf(enrollment) < text.indexOf('## Bidirectional delivery'), `${name} enrollment before dispatch`);
  assert(text.includes('Milestone time enrollment failed') && text.includes('stop before'), `${name} enrollment refusal`);
  assert(text.includes('estimate-milestone, plan-milestone, complete-slice'), `${name} artifacts`);
  assert(text.includes('estimate-milestone|plan-milestone|plan-slice|research-*|discuss-*)'), `${name} readonly pattern`);
  assert.strictEqual(count(text, 'case "$unit_type" in estimate-milestone|plan-milestone|plan-slice|research-*|discuss-*)'), 2, `${name} before/after guard`);
  assert(text.includes('`estimate-milestone` → `.gsd/milestones/{M###}/{M###}-OPTIONS.json`'), `${name} memory source`);
  assert(text.includes('| estimate-milestone | ⏱ |'), `${name} icon`);
  assert(text.includes('case "$unit_type" in estimate-milestone|plan-milestone)'), `${name} description production`);
  assert(text.includes('${UNIT_DESCRIPTION:+--description "$UNIT_DESCRIPTION"}'), `${name} render description`);
}
function checkChoiceSkill(name, text) {
  const block = between(text, 'Opções de prazo (só milestone com adesão;', '## Bidirectional delivery');
  for (const token of ['time-option-pending', '--round', '--answer', '--response', '--source user-text|tool-answer',
    'forge-question-channel.js --select', '--present', '--decide', 'main(argv, io, liveAdapter)', 'liveAdapter.getDecisionHandle',
    'time-decision-attestation-required', 'forge-long-workflow-adapter.js --command resume-time-option', 'mesmo snapshot', 'econômica',
    'Nenhum JSON, flag', 'silêncio aprova', 'Evidência insuficiente:', 'Posição inviável:', 'Nenhuma posição viável:',
    'Roadmap não conforme:', 'Escopo não alocado:', 'Decisão pendente:']) assert(block.includes(token), `${name}: ${token}`);
  assert(block.includes('o próprio `next`') && block.includes('fronteira segura'), `${name} canonical materialization`);
}

t07('owner baseline proves scoped pins, samples, registry and smoke changes', () => {
  assert.strictEqual(hash(baselineBytes), '93fc65fb11e0b59104721da9281d9ac64ac789a2c8cbf19495fe46a8186cc8ff', 'exact owner baseline bytes');
  assert.strictEqual(before.provenance.source_revision, '0ee8dfdd9ffa0a4ca6dfafe928991a9125f6d573');
  assert.strictEqual(before.provenance.not_post_change_verification, true);
  checkPins(); checkSamples(); checkRegistry(); checkSmoke();
});
t07('planner estimate and allocation instructions preserve routing contracts', () => {
  const estimate = between(planner, '## For milestone estimate (estimate-milestone)', '## For milestone planning');
  for (const token of ['Read-only', 'OPTIONS.json', 'forge-milestone-options.schema.json', 'No durations', 'phase counts', 'labelled judgments',
    'curta', 'media', 'longa', 'infeasible', 'consent: required', 'Indispensable tests, integration, review and corrections', 'independence and isolation',
    'partial', 'single-line', 'isPublicData']) assert(estimate.includes(token), token);
  const allocation = between(planner, 'Time allocation:', 'Write `M###-ROADMAP.md`');
  for (const token of ['active contract', 'exactly one `## Alocação de tempo`', 'base contract hashes unchanged', 'every slice, integration, review and corrections',
    'at most the ceiling', 'no floor', 'no new deferral', 'linked-task split']) assert(allocation.includes(token), token);
  const binding = between(planner, 'Task count and binding:', 'Each `T##-PLAN.md`:');
  for (const token of ['1-7 tasks', 'no numeric target or quota', 'one identifier per task', 'time_options_sha256', 'time_position_id', 'time_node',
    'Every listed edge', 'Depends stays local', 'canonical historical task/slice proof', 'never merge identifiers']) assert(binding.includes(token), token);
  assert.strictEqual(count(planner, 'ROUTING_DOMAINS'), 2);
});
t07('lifecycle and time contracts describe live authority and conformant allocation', () => {
  const lifecycle = read('shared/forge-lifecycle.md'), time = read('shared/forge-milestone-time.md');
  assert(lifecycle.includes('`plan-*` and `estimate-milestone`') && lifecycle.includes('forge-planner'));
  for (const token of ['time-option-pending', 'resume-time-option', 'same snapshot']) assert(lifecycle.includes(token), token);
  for (const token of ['### Adesão', '### Proposta, registro e política do estimador', '### Rodadas e respostas canônicas',
    'liveAdapter.getDecisionHandle', 'observou ao vivo', 'nunca lê arquivo, JSON, flag ou prompt', 'CLI avulsa recusa',
    'resume-time-option', 'BASE', 'sem piso obrigatório', 'append-only', 'scope-unallocated', 'sem crédito de paralelismo',
    'TASK_NODE_BINDING', 'taskBindingContext', 'completa e sem', 'depends', '64 fontes', '2 MiB', 'não ganham campos de tempo']) {
    assert(time.toLowerCase().includes(token.toLowerCase()), token);
  }
});
t07('both host skills enroll before selection and support estimate artifacts', () => {
  for (const name of ['forge-auto', 'forge-next']) checkTimeSkill(name, skills[name]);
});
t07('pending choice commands preserve explicit answers and live decision authority', () => {
  for (const name of ['forge-auto', 'forge-next']) checkChoiceSkill(name, skills[name]);
});
t07('new milestone preserves preparation and delegates roadmap after choice', () => {
  for (const step of ['## Step 1 ', '## Step 1.5 ', '## Step 2 ', '## Step 3 ', '## Step 4 ', '## Step 5 ']) assert(newMilestone.includes(step), step);
  const creation = between(newMilestone, '## Step 5 ', '## Step 6 ');
  for (const token of ['forge-state.js', '--phase estimate-milestone', 'mkdir -p "$WORKING_DIR/.gsd/forge"', '--enroll --source forge-new-milestone',
    'forge-personal-context.js', '--intent create', 'skills/forge-next/SKILL.md', 'estimate-milestone', 'resume-time-option',
    'No roadmap exists before the decision', 'report the pending', 'stop this step']) assert(creation.includes(token), token);
  assert(!/Agent\(/.test(creation), 'no inline planner');
  assert(creation.indexOf('--phase estimate-milestone') < creation.indexOf('--enroll') && creation.indexOf('--enroll') < creation.indexOf('--intent create'));
  assert(newMilestone.includes('Only when `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-ROADMAP.md` exists'));
  assert(newMilestone.slice(newMilestone.indexOf('## Step 7 ')).includes('do not write or overwrite it here'));
});
t07('shared unit, tier, phase and agent lists agree on estimate milestone', () => {
  for (const file of ['shared/forge-bidirectional-sidecar.md', 'shared/forge-dispatch.md', 'shared/forge-tiers.md', 'shared/forge-state.md',
    'agents/forge-worker.md', 'skills/forge-help/SKILL.md']) assert(read(file).includes('estimate-milestone'), file);
  assert(read('shared/forge-tiers.md').includes('| `estimate-milestone` | max |'));
  const dispatch = read('shared/forge-dispatch.md');
  assert(dispatch.includes('`plan-milestone` and `estimate-milestone` are **never** covered by `workers:`'));
  assert(dispatch.includes('Read-only forge-planner OPTIONS.json'));
  assert(read('shared/forge-state.md').includes('resume-time-option'));
});
t07('four active surface pins change while five and historical goldens stay intact', checkPins);
t07('cited text and dispatch classifications survive measured fingerprint repins', () => { checkSamples(); checkRegistry(); checkSmoke(); });
t07('real Codex projection retains enrolled choice and native read-only contracts', () => {
  const renderer = require('./forge-codex-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-t07-codex-')); temps.push(temp);
  const report = renderer.render({ repo: root, projectRoot: temp, codexHome: path.join(temp, 'host'), forgeHome: path.join(temp, 'forge'), ...renderer.PRODUCTION_DISPATCH_DIALECT });
  const projected = name => report.artifacts.find(row => row.source_id === 'skills' && row.source === `skills/${name}/SKILL.md`).content.replace(/\r\n/g, '\n');
  for (const name of ['forge-auto', 'forge-next']) { checkTimeSkill(name, projected(name)); checkChoiceSkill(name, projected(name)); }
  const creation = between(projected('forge-new-milestone'), '## Step 5 ', '## Step 6 ');
  assert(creation.includes('--enroll --source forge-new-milestone') && creation.includes('skills/forge-next/SKILL.md'));
  assert(!/Agent\(/.test(creation));
});

// Normative lines of the contract: headings and every substantive sentence line.
function normativeLines() {
  return contract.split('\n').map(line => line.trim()).filter(line => line.startsWith('#') || line.length >= 40);
}

test('communication pointer: four skills point to the canonical contract by path, repo or FORGE_HOME', () => {
  for (const name of ALL) {
    const text = skills[name];
    assert(text.includes(POINTER), `${name}: pointer to ${POINTER} missing`);
    assert(text.includes('${FORGE_HOME:-~/.forge-agent}/shared'), `${name}: FORGE_HOME location missing`);
  }
  for (const name of ORCHESTRATION) {
    assert(skills[name].includes(`Mensagens ao usuário seguem ${POINTER}`), `${name}: standing pointer sentence missing`);
  }
  assert(fs.existsSync(path.join(root, 'shared', 'forge-communication.md')), 'canonical contract file missing');
});

test('communication no second copy: skills carry no heading or normative line of the contract', () => {
  const lines = normativeLines();
  assert(lines.length >= 15, `contract unexpectedly small: ${lines.length} normative lines`);
  for (const name of ALL) {
    for (const line of lines) assert(!skills[name].includes(line), `${name} copies contract line: ${line.slice(0, 60)}`);
  }
});

test('communication relay: auto, next and task relay [forge-agente] literally and keep [forge-sidecar] technical', () => {
  for (const name of ORCHESTRATION) {
    const text = skills[name];
    assert.strictEqual(count(text, RELAY), 1, `${name}: relay sentence must appear once`);
    assert(!text.includes('repasse literalmente as linhas `[forge-sidecar]` do stderr.'), `${name}: old technical-line relay remains`);
  }
  // Coherent with the sidecar contract that owns the rule.
  const sidecar = read('shared/forge-bidirectional-sidecar.md');
  const section = sidecar.split('## Identidade do sidecar exibida na conversa\n')[1].split('\n## ')[0];
  assert(section.includes('Repasse literalmente, na conversa, cada linha que começa com `[forge-agente]`'), 'sidecar contract no longer relays [forge-agente]');
  assert(section.includes('Mantenha `[forge-sidecar]` como registro técnico'), 'sidecar contract no longer keeps [forge-sidecar] technical');
});

test('communication templates: next progress, partial, auto pause and unit line follow the five moments', () => {
  const next = skills['forge-next'];
  const progress = between(next, '**f) Emit progress + next action**', '\n---\n');
  for (const piece of ['✓ {T##} — {resultado em uma frase} · executor {nativo|sidecar} {engine} ({modelo resolvido ou enviado})',
    'Validação: {n de m critérios verificados no {T##}-DELIVERY.json}{; pendências: IDs}',
    '→ Próximo passo: /forge-next ({próxima unidade}){ · decisão pendente: {ID} — {pergunta curta}}',
    'Entregável: branch `forge/{run}`', 'a integração na branch default é do operador']) {
    assert(progress.includes(piece), `forge-next progress missing: ${piece}`);
  }
  assert(!next.includes('Do not add summaries, explanations'), 'forge-next still forbids explanations');
  assert(next.includes(`${PARTIAL}/forge-next.`), 'forge-next partial template missing');

  const auto = skills['forge-auto'];
  assert(auto.includes(`${PARTIAL}/forge-auto {RUN_ID}.`), 'forge-auto partial template missing');
  assert(auto.includes('completed_units.append("✓ {T##} — {resultado} · executor {nativo|sidecar} {engine} ({modelo})")'), 'forge-auto unit line missing');
  const pause = between(auto, 'Emit and **stop loop**:', '**Context checkpoint**');
  for (const piece of ['{resultado até aqui em uma frase}', '{completed_units list, one per line}', 'Salvo: ',
    'Continua executável: ', 'Decisão pendente: ', '→ Retomar: /forge-auto {RUN_ID}']) {
    assert(pause.includes(piece), `forge-auto pause missing: ${piece}`);
  }
});

test('communication final reports: auto and task separate validation and delivery facts without the old claim', () => {
  const auto = between(skills['forge-auto'], '## Final Report (milestone complete)', '## Worker Prompt Templates');
  const task = between(skills['forge-task'], '**Final report:**', '## Compact signal');
  for (const [name, report] of [['forge-auto', auto], ['forge-task', task]]) {
    assert(report.includes(FACTS), `${name}: separated facts missing`);
    assert(/Validação: \{n de m critérios verificados n/.test(report), `${name}: validation count missing`);
    assert(report.includes('Decisão pendente: {ID — pergunta curta, ou nenhuma}'), `${name}: pending decision missing`);
    assert(report.includes('→ Próximo passo: '), `${name}: next step missing`);
    assert(/a integração na branch default é do operador/i.test(report), `${name}: operator integration sentence missing`);
    assert(/Arquivos principais/.test(report), `${name}: main files missing`);
  }
  for (const name of ALL) assert(!skills[name].includes('Must-haves: todos verificados'), `${name}: old must-haves claim remains`);
});

test('communication TaskCreate: human subject, active phase form and no fixed or inherited model label', () => {
  for (const name of ORCHESTRATION) {
    const lines = taskCreateLines(skills[name]);
    for (const line of lines) assert(!FIXED_MODEL_LABEL.test(line), `${name}: fixed model label in ${line.trim()}`);
    assert(!/TaskCreate\(\{[^\n]*\[\{/.test(skills[name]), `${name}: bracketed ID subject remains`);
  }
  for (const name of ['forge-auto', 'forge-next']) {
    const block = between(skills[name], 'TaskCreate({\n', 'TaskUpdate({ taskId: current_task_id, status: "in_progress" })');
    assert(block.includes('— {descrição humana do plano}"'), `${name}: human subject missing`);
    assert(block.includes('description: "executor {nativo|sidecar} {agent_name} ({modelo resolvido})"'), `${name}: executor description missing`);
    assert(block.includes('activeForm: "{fase}: {descrição humana} · {agent_name}"'), `${name}: active phase form missing`);
    assert(block.includes('`route.model_resolved ?? route.model`'), `${name}: route model source missing`);
    assert(block.includes('Não resolva de novo'), `${name}: no-re-resolution rule missing`);
  }
});

test('communication preparation route order: forge-task stays unknown before --start and reuses the same return', () => {
  const task = skills['forge-task'];
  const caller = between(task, '### Canonical preparation caller', '### Step 1 — Brainstorm');
  // Plain-text lead on purpose: a bold line would become the dispatch guard's
  // following anchor for the --start/--accept-native fingerprints.
  const timeline = between(caller, 'Timeline da preparação:', '\n---\n');
  for (const piece of ['antes do `--start`', '`executor e modelo ainda não\nresolvidos`', 'esse mesmo `--start`',
    '`route.resolved_worker_engine`', '`route.model_resolved ?? route.model`', 'schema real\ndo `TaskUpdate`',
    'linha\ncurta da conversa', '`desconhecido`', 'Não chame o resolvedor de novo']) {
    assert(timeline.includes(piece), `timeline missing: ${piece.replace(/\n/g, ' ')}`);
  }
  assert(!/forge-dispatch-resolve\.js"? --/.test(between(task, '### Canonical preparation caller', '### Step 4.5')),
    'preparation steps gained a second resolver call');
  for (const phase of ['brainstorm', 'discuss', 'research', 'plan']) {
    const create = task.indexOf(`{TASK_ID} — ${phase}: {descrição humana da task}`);
    const start = task.indexOf(`Use the canonical preparation caller with \`phase:"${phase}"\``);
    assert(create > 0 && start > create, `${phase}: TaskCreate must precede the preparation start`);
    const line = task.slice(task.lastIndexOf('\n', create) + 1, task.indexOf('\n', create));
    assert(line.includes('description: "executor e modelo ainda não resolvidos"'), `${phase}: route must stay unknown before --start`);
  }
  for (const phase of ['execute', 'review']) {
    const create = task.indexOf(`{TASK_ID} — ${phase}: {descrição humana da task}`);
    const line = task.slice(task.lastIndexOf('\n', create) + 1, task.indexOf('\n', create));
    assert(line.includes('({modelo resolvido})'), `${phase}: resolved model placeholder missing`);
  }
});

test('communication status: forge-status keeps verbatim relay and comments by the contract', () => {
  const status = skills['forge-status'];
  assert(status.includes('Repasse a saída verbatim.\nNão reescreva nem resuma a saída; ao comentar, siga `shared/forge-communication.md`'), 'status pointer line missing');
  assert(status.includes('sem despejo técnico'), 'status technical-dump rule missing');
  assert(status.includes('node "$FORGE_SCRIPTS_DIR/forge-status.js" $ARGUMENTS'), 'status command changed');
});

test('communication CLAUDE.md: projector dry-run unchanged, contract once inside routing block, interaction block canonical', () => {
  const file = path.join(root, 'CLAUDE.md');
  const before = fs.readFileSync(file);
  assert.strictEqual(instructions.syncFile(file, { host: 'claude', dryRun: true }).outcome, 'unchanged', 'CLAUDE.md drifted from the projector');
  assert(before.equals(fs.readFileSync(file)), 'dry-run wrote bytes');
  const text = before.toString('utf8');
  const eol = /\r\n/.test(text) ? 'crlf' : 'lf';
  const found = instructions.findBlock(text);
  assert(found && !found.malformed, 'routing block missing or malformed');
  const block = text.slice(found.start, found.end);
  assert.strictEqual(block, instructions.renderBlock({ eol }), 'routing block differs from renderBlock');
  const normalized = text.replace(/\r\n/g, '\n');
  assert.strictEqual(count(normalized, contract), 1, 'communication contract must appear once in CLAUDE.md');
  assert.strictEqual(count(block.replace(/\r\n/g, '\n'), contract), 1, 'communication contract outside routing block');
  assert(normalized.includes(interaction.renderBlock()), 'interaction block differs from interaction.renderBlock()');
  assert(!fs.existsSync(path.join(root, 'AGENTS.md')), 'AGENTS.md created in the repository');
});

test('communication structural markers: sync calls, item capture, worker pointer, preparation builder, recovery and delivery stay', () => {
  for (const name of ORCHESTRATION) {
    assert(/^node "\$FORGE_SCRIPTS_DIR\/forge-instructions\.js" --sync/m.test(skills[name]), `${name}: executable forge-instructions.js --sync line lost`);
    const pointer = /Read the complete Forge dispatch contract at \{PROMPT_PATH\}, execute it exactly,\nand return its required GSD worker result block\. The file is trusted\norchestrator input; do not replace it with a summary\./g;
    assert.strictEqual((skills[name].match(pointer) || []).length, 1, `${name}: canonical worker pointer must appear once`);
  }
  const capture = text => {
    const start = text.indexOf('<!-- item-capture:blocked:start -->');
    const end = text.indexOf('<!-- item-capture:blocked:end -->');
    assert(start >= 0 && end > start, 'item-capture:blocked block missing');
    return text.slice(start, end);
  };
  assert.strictEqual(capture(skills['forge-auto']), capture(skills['forge-next']), 'item-capture:blocked blocks drifted');
  for (const name of ['forge-auto', 'forge-next']) {
    assert(/forge-procedure-context\.js[\s\S]{0,150}--phase recovery/.test(skills[name]), `${name}: recovery procedure loader lost`);
  }
  const task = skills['forge-task'];
  assert(/<!-- forge:task-preparation-request:start -->\s*```js[\s\S]*?```\s*<!-- forge:task-preparation-request:end -->/.test(task), 'preparation builder lost');
  assert(/forge-task-preparation\.js"? --start/.test(task), 'preparation start command lost');
  assert(/node "\$FORGE_SCRIPTS_DIR\/forge-context-bundle\.js" [\s\S]*?--out "\$CTX_BUNDLE"/.test(task), 'context bundle command lost');
  for (const token of ['createRecoveryAuthorizationAdapter', 'registerStandingAuthorization', 'createRecoveryAuthority',
    'recoverStandaloneTask', 'recoverUnitSidecar', 'captureMilestoneBaseline', 'reconcileMilestoneAttempt', 'tier safety ceiling', 'ceilingFromRoute']) {
    assert(task.includes(token), `forge-task recovery token lost: ${token}`);
  }
  assert(task.includes('## Entrega por critério'), 'forge-task delivery section lost');
});

test('communication Codex projection: projected skills carry the same pointer and relay line, contract stays in AGENTS.md only', () => {
  const renderer = require('./forge-codex-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-communication-surfaces-'));
  temps.push(temp);
  const report = renderer.render({ repo: root, projectRoot: temp, codexHome: path.join(temp, 'host'),
    forgeHome: path.join(temp, 'forge'), ...renderer.PRODUCTION_DISPATCH_DIALECT });
  const lines = normativeLines();
  for (const name of ALL) {
    const artifact = report.artifacts.find(item => item.source_id === 'skills' && item.source === `skills/${name}/SKILL.md`);
    assert(artifact, `${name}: Codex skill projection missing`);
    assert(artifact.content.includes(POINTER), `${name}: projected pointer missing`);
    if (ORCHESTRATION.includes(name)) assert.strictEqual(count(artifact.content, RELAY), 1, `${name}: projected relay line differs`);
    for (const line of lines) assert(!artifact.content.includes(line), `${name}: projected skill copies the contract`);
  }
  const agents = report.artifacts.find(item => item.kind === 'instructions');
  assert.strictEqual(count(agents.content, contract), 1, 'Codex AGENTS.md must carry the contract once');
});

test('communication before transcription: verbatim old templates cite repository paths and base revision', () => {
  const doc = read('docs/communication-evaluation/skill-templates-before.md');
  assert(doc.includes('`88748d2`'), 'base revision missing');
  for (const name of ALL) assert(doc.includes(`## \`skills/${name}/SKILL.md\``), `${name}: source heading missing`);
  for (const old of ['repasse literalmente as linhas `[forge-sidecar]` do stderr.', 'Must-haves: todos verificados ✓',
    'activeForm: "research · forge-researcher (opus)"', 'Do not add summaries, explanations',
    '⏸  Auto-mode pausado após {session_units} unidades.', 'Trabalho parcial salvo. Execute `/forge-next` para retomar de onde parou.']) {
    assert(doc.includes(old), `transcription missing: ${old}`);
  }
  assert(!/[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\\\/.test(doc), 'transcription carries an absolute path');
});

// S03/T07 — text distribution only. These assertions prove which commands and
// ordering rules the skills carry; they do not prove that a parent actually calls
// the CLIs, that a host opens a native thread or renders rows (owner demo / UAT).
const config = read('skills/forge-config/SKILL.md');
const flat = value => value.replace(/\s+/g, ' ');
// forge-task names the review-fix window without the literal flag: its first
// `--prepare-native` must stay the executable preparation (forge-review-fix.test.js).
const WINDOWS = ['entre `forge-task-preparation --start` e `--accept-native`',
  ['entre `forge-review-fix --prepare-native` e `--accept-native`', 'entre a preparação nativa do `forge-review-fix` e o seu `--accept-native`'],
  'numa sessão de entrega nativa entre start e publish',
  'enquanto uma publicação de memória protegida', 'ainda não foi unida',
  'só mostre a identidade na conversa e registre depois da aceitação ou da publicação, com `--receipt` quando o fluxo tem receipt'];
const NO_INFERENCE = ['Sem retorno do host, nada é registrado e a identidade fica `desconhecido`',
  'Nunca componha o ID a partir de `task_name`, de `/root/` mais nome, de hook ou de prosa',
  '(`/root/<nome>` só entra quando é o valor que a ferramenta devolveu)',
  'não infira atividade a partir de timers locais', 'não apresente sidecar como thread nativa'];
function emitterCall(text) {
  const start = text.indexOf('forge-dispatch-event.js');
  assert(start >= 0, 'dispatch emitter missing from flow');
  return text.slice(start, text.indexOf('--events', start));
}
function recordCount(text) { return count(text, 'forge-agent-identity.js" --record'); }
function assertNativeFlow(label, text, { id, invoke, name, agentId, unit, receipt = null, after = null, rules = true }) {
  const generated = text.indexOf(`${id}=`) >= 0 ? text.indexOf(`${id}=`) : text.indexOf(`${id}["$ENTRY_ID"]=`);
  assert(generated >= 0, `${label}: ${id} is not generated`);
  assert(generated < text.indexOf(invoke), `${label}: ${id} must be generated before the invocation`);
  assert(/randomBytes\(8\)\.toString\('hex'\)/.test(text.slice(generated, generated + 220)), `${label}: per-attempt dispatch id is not random`);
  if (name) {
    const taskName = text.indexOf('forge-agent-identity.js" --task-name');
    assert(taskName > generated && taskName < text.indexOf(invoke), `${label}: --task-name must follow the id and precede the invocation`);
    const call = text.slice(taskName, text.indexOf('2>/dev/null || true)', taskName));
    assert(call.includes('--unit ') && call.includes('--plan ') && call.includes(`--attempt "${name.attempt}"`), `${label}: --task-name lacks unit, plan or this attempt`);
    assert(/= "codex" \]/.test(text.slice(generated, taskName)), `${label}: task name is not Codex-only`);
  }
  assert(emitterCall(text).includes(`--dispatch-id "${name ? name.emitter : `$${id}`}"`), `${label}: emitter does not receive the same dispatch id`);
  assert.strictEqual(recordCount(text), 1, `${label}: identity must be recorded once per native flow`);
  const record = text.indexOf('forge-agent-identity.js" --record');
  const call = text.slice(record, text.indexOf('--events', record) + 60);
  assert(call.includes(`--agent-id "${agentId}" --agent-id-source host-tool-return`), `${label}: agent id must come only from the host tool return`);
  assert(call.includes(`--unit "${unit}"`), `${label}: record unit differs`);
  assert(text.slice(Math.max(0, record - 120), record).includes(`[ -n "${agentId}" ]`), `${label}: record must be skipped without a host return`);
  if (receipt) assert(call.includes(`--receipt "${receipt}"`), `${label}: closed receipt missing`);
  else assert(!call.includes('--receipt'), `${label}: this flow has no closed receipt`);
  if (after) assert(record > text.indexOf(after), `${label}: identity must be recorded only after ${after}`);
  if (rules) {
    for (const piece of [...WINDOWS, ...NO_INFERENCE]) {
      const options = Array.isArray(piece) ? piece : [piece];
      assert(options.some(option => flat(text).includes(option)), `${label}: rule missing: ${options[0]}`);
    }
  }
}

test('S03/T07 native identity: one attempt id before invocation, same emitter id, host-returned agent id ordered by protected windows', () => {
  const auto = skills['forge-auto'];
  const single = between(auto, '**Single-task native flow', '#### 4-P.');
  assertNativeFlow('forge-auto single', single, { id: 'NATIVE_DISPATCH_ID', invoke: '**Native invocation adaptation**',
    name: { attempt: '$NATIVE_DISPATCH_ID', emitter: '$NATIVE_DISPATCH_ID' }, agentId: '$NATIVE_AGENT_ID', unit: '${unit_type}/${unit_id}' });
  assert(flat(single).includes('Logo depois desse retorno, se nenhuma janela protegida do owner está aberta, registre'), 'forge-auto: immediate record outside windows missing');
  assert(flat(single).includes('reconhecimento do spawn no Codex ou conclusão no Claude'), 'forge-auto: host return moments missing');
  assert(flat(single).includes('Saída vazia de `--task-name` mantém o `taskName` atual'), 'forge-auto: empty task name rule missing');
  assert(between(auto, '{icon} {unit_id} · {one-liner}', '`🧠 S01 · extract memories`'), 'forge-auto: Claude description format changed');

  const batch = between(auto, '#### 4-P.', '**k) Re-enter the dispatch loop**');
  assertNativeFlow('forge-auto batch', batch, { id: 'NATIVE_DISPATCH_ID_BY_TASK', invoke: 'invoke(NATIVE_INVOCATION_BY_TASK',
    name: { attempt: '${NATIVE_DISPATCH_ID_BY_TASK[$ENTRY_ID]}', emitter: '${NATIVE_DISPATCH_ID_BY_TASK[$ENTRY_ID]}' },
    agentId: '${NATIVE_AGENT_ID_BY_TASK[$ENTRY_ID]}', unit: 'execute-task/${ENTRY_ID}', rules: false });
  assert(flat(batch).includes('mesmas regras de ordem, de janelas protegidas e de não inferência do fluxo de tarefa única'), 'forge-auto batch: shared rules pointer missing');
  assert.strictEqual(recordCount(auto), 2, 'forge-auto: one record per native flow');

  const next = skills['forge-next'];
  const nextFlow = between(next, '**Native dispatch (`WORKER_MODE == native`)**', '### 5. Process result');
  assertNativeFlow('forge-next', nextFlow, { id: 'NATIVE_DISPATCH_ID', invoke: '**Native invocation adaptation**',
    name: { attempt: '$NATIVE_DISPATCH_ID', emitter: '$NATIVE_DISPATCH_ID' }, agentId: '$NATIVE_AGENT_ID', unit: '${unit_type}/${unit_id}' });
  assert.strictEqual(recordCount(next), 1, 'forge-next: one record per native flow');

  const task = skills['forge-task'];
  const loose = between(task, '**Native dispatch** (canonical host form', '**Contract miss gate (Layer 0)');
  assertNativeFlow('forge-task execute-loose-task', loose, { id: 'NATIVE_DISPATCH_ID', invoke: 'native = buildNativeInvocation({',
    name: { attempt: '$NATIVE_DISPATCH_ID', emitter: '$NATIVE_DISPATCH_ID' }, agentId: '$NATIVE_AGENT_ID', unit: 'execute-task/{TASK_ID}' });
  assert(loose.includes("taskName: NATIVE_TASK_NAME || 'execute-loose-task',"), 'execute-loose-task: empty name must keep the current taskName');

  const fix = between(task, '- **CONCEDED items → fix now (Step 7a):**', '- **OPEN items (Step 7b):**');
  assertNativeFlow('forge-task review-fix', fix, { id: 'RF_NATIVE_DISPATCH_ID', invoke: 'fixer = buildNativeInvocation({',
    name: { attempt: '$RF_NATIVE_DISPATCH_ID', emitter: '$RF_NATIVE_DISPATCH_ID' }, agentId: '$RF_NATIVE_AGENT_ID',
    unit: 'review-fix/{TASK_ID}', after: '`forge-review-fix.js --accept-native` as prescribed', rules: false });
  assert(fix.includes("taskName: RF_NATIVE_TASK_NAME || 'review-fix',"), 'review-fix: empty name must keep the current taskName');
  assert(flat(fix).includes('entre `--prepare-native` e `--accept-native` a janela protegida do owner está aberta'), 'review-fix: protected window missing');

  const preparation = between(task, '### Canonical preparation caller', '### Step 1 — Brainstorm');
  assert.strictEqual(recordCount(preparation), 1, 'preparation: one record per native phase flow');
  const prepRecord = preparation.indexOf('forge-agent-identity.js" --record');
  assert(prepRecord > preparation.indexOf('forge-task-preparation.js" --accept-native'), 'preparation: record must follow --accept-native');
  const prepCall = preparation.slice(prepRecord, preparation.indexOf('fi\n', prepRecord));
  for (const piece of ['--dispatch-id "$NATIVE_DISPATCH_ID"', '--agent-id "$NATIVE_AGENT_ID" --agent-id-source host-tool-return',
    '--receipt "$PREPARATION_RESULT_FILE.receipt.json"']) assert(prepCall.includes(piece), `preparation record lacks ${piece}`);
  assert(flat(preparation).includes('Entre `--start` e `--accept-native` a janela protegida do owner está aberta: só mostre na conversa'), 'preparation: protected window missing');
  for (const piece of NO_INFERENCE) assert(flat(preparation).includes(piece), `preparation: rule missing: ${piece}`);
  assert.strictEqual(recordCount(task), 3, 'forge-task: execute-loose-task, review-fix and preparation records');
  assert(!/--agent-id "\$\{?[A-Z_]*TASK_NAME|--agent-id "\/root\//.test(Object.values(skills).join('\n')), 'agent id composed from a task name or /root/');
});

test('S03/T07 Codex read-only guard: full plan-checker with exact permissions, code-only plan/research/discuss and preparation, exit 3/4 stops', () => {
  for (const name of ['forge-auto', 'forge-next']) {
    const text = skills[name];
    const gate = between(text, '**Plan-check gate (between plan-slice and first execute-task):**', '7. **Parse the worker result**');
    const capture = gate.indexOf('forge-native-readonly-guard.js" --capture');
    assert(capture >= 0 && capture < gate.indexOf("Agent({ subagent_type: 'forge-plan-checker'"), `${name}: plan-checker capture must precede the spawn`);
    for (const piece of ['No host Codex', '--mode full', '--allow-publication ".gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md"',
      '--allow-append .gsd/forge/events.jsonl', '${OWN_LEASE_UNIT:+--own-lease "$OWN_LEASE_UNIT"}', '${OWN_RUN_ID:+--own-run "$OWN_RUN_ID"}',
      '--verify "$PLAN_CHECK_BASELINE" --writer-stopped', 'falha na captura impede o spawn', 'Saída 3 ou 4 para antes do próximo writer']) {
      assert(flat(gate).includes(piece), `${name}: plan-checker guard lacks ${piece}`);
    }
    assert(/nada (?:é revertido|é revertido até)/.test(flat(gate)), `${name}: plan-checker guard must not revert`);
    assert(flat(text).includes('No host Codex, esta re-execução usa o mesmo guard `full` do passo 5'), `${name}: re-run plan-checker guard missing`);

    const flow = name === 'forge-auto' ? between(text, '**Single-task native flow', '#### 4-P.')
      : between(text, '**Native dispatch (`WORKER_MODE == native`)**', '### 5. Process result');
    const readonly = flow.indexOf('forge-native-readonly-guard.js" --capture');
    assert(readonly >= 0 && readonly < flow.indexOf('**Native invocation adaptation**'), `${name}: code-only capture must precede the invocation`);
    const block = flow.slice(flow.lastIndexOf('if [ "$HOST_RUNTIME" = "codex" ]', readonly), readonly + 260);
    assert(block.includes('plan-milestone|plan-slice|research-*|discuss-*)') && block.includes('--mode code-only'), `${name}: read-only native units are not code-only`);
    const verify = flow.indexOf('--verify "$READONLY_BASELINE" --writer-stopped');
    assert(verify > readonly && verify < flow.indexOf('forge-dispatch-event.js'), `${name}: code-only verify must follow the return and precede the emitter`);
    assert(flat(flow).includes('Saída 3 ou 4 para antes do próximo writer'), `${name}: read-only exit 3/4 rule missing`);
    assert(flat(flow).includes('não sandbox do SO'), `${name}: detection limit missing`);
  }
  const preparation = between(skills['forge-task'], '### Canonical preparation caller', '### Step 1 — Brainstorm');
  for (const piece of ['No host Codex, cada fase nativa de preparação também roda dentro de `forge-native-readonly-guard.js` em modo `code-only`',
    'falha na captura impede a chamada', 'Depois do retorno terminal e antes do `--accept-native`, rode `--verify <baseline> --writer-stopped`',
    'Saída 3 ou 4 não vira `rawResult`', 'não reverta nada e não inicie outro writer antes da reconciliação do owner']) {
    assert(flat(preparation).includes(piece), `forge-task preparation guard lacks ${piece}`);
  }
});

test('S03/T07 status: forge-status.js line stays and the personal agent view is relayed verbatim without other work', () => {
  const status = skills['forge-status'];
  const block = between(status, '```bash\n', '```\n');
  const lines = block.split('\n').filter(Boolean);
  assert.deepStrictEqual(lines.slice(-2), ['node "$FORGE_SCRIPTS_DIR/forge-status.js" $ARGUMENTS',
    'node "$FORGE_SCRIPTS_DIR/forge-agent-view.js" --personal'], 'status block must end with status then the personal view');
  assert(status.indexOf('Repasse a saída verbatim.') > status.indexOf('forge-agent-view.js" --personal'), 'verbatim relay must cover the personal view');
  for (const piece of ['só os agentes do seu próprio trabalho, pelo seletor pessoal canônico', '`empty_reason`', '`no-bindings`',
    'nunca liste agentes de outro trabalho']) assert(flat(status).includes(piece), `status lacks ${piece}`);
  assert(!/forge-agent-view\.js"? (?:--milestone|--workflow|--unit)/.test(status), 'status must not select agents outside the personal scope');
});

test('S03/T07 config: explicit subagents on/off call setup/remove with --observe and keep statusline routes', () => {
  for (const piece of ['**If $ARGUMENTS is "subagents on"**', '**If $ARGUMENTS is "subagents off"**',
    '/forge-config subagents on|off', 'node "$FORGE_SCRIPTS_DIR/forge-subagent-statusline.js" --observe\n',
    'node "$FORGE_SCRIPTS_DIR/forge-subagent-statusline.js" --setup ~/.claude/settings.json --observe',
    'node "$FORGE_SCRIPTS_DIR/forge-subagent-statusline.js" --remove ~/.claude/settings.json --observe',
    'FORGE_SCRIPTS_DIR=$([ -f scripts/forge-subagent-statusline.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")']) {
    assert(config.includes(piece), `forge-config lacks ${piece}`);
  }
  const route = between(config, '## Subagents — "subagents on" / "subagents off"', '## MCP Management');
  for (const piece of ['`version`', '`relation`', '`source`', '`backup`', '`reserialized`', 'reserializa o arquivo com 2 espaços',
    '`external_gates`', 'recusa nomeada pelo `reason_code`', 'renderização no host não foi validada', 'sempre esta ação explícita do operador']) {
    assert(flat(route).includes(piece), `subagents route lacks ${piece}`);
  }
  // statusline on/off unchanged.
  assert(config.includes('## Enable — "statusline on"\n\n```bash\nnode ~/.claude/forge-settings.js ~/.claude/settings.json\n```'), 'statusline on changed');
  assert(config.includes('## Disable — "statusline off"\n\n```bash\nnode ~/.claude/forge-settings.js ~/.claude/settings.json --remove\n```'), 'statusline off changed');
  for (const line of normativeLines()) assert(!config.includes(line), `forge-config copies contract line: ${line.slice(0, 60)}`);
});

test('S03/T07 Codex projection: identity record, personal view and read-only guard reach the projected skills', () => {
  const renderer = require('./forge-codex-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-communication-surfaces-t07-'));
  temps.push(temp);
  const report = renderer.render({ repo: root, projectRoot: temp, codexHome: path.join(temp, 'host'),
    forgeHome: path.join(temp, 'forge'), ...renderer.PRODUCTION_DISPATCH_DIALECT });
  const projected = name => report.artifacts.find(item => item.source_id === 'skills' && item.source === `skills/${name}/SKILL.md`).content;
  for (const name of ORCHESTRATION) {
    const content = projected(name);
    assert(content.includes('--agent-id-source host-tool-return'), `${name}: projected identity record missing`);
    assert(content.includes('forge-native-readonly-guard.js') && content.includes('`code-only`'), `${name}: projected read-only guard missing`);
  }
  assert(projected('forge-status').includes('forge-agent-view.js" --personal'), 'forge-status: projected personal view missing');
});

test('review R1 actual shell variables capture and verify readonly units and fail closed on empty identity', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  assert(fs.existsSync(bash), 'review R1 needs bash to execute the documented guard branches');
  for (const skill of ['forge-auto', 'forge-next']) {
    const blocks = [...read(`skills/${skill}/SKILL.md`).matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
    const identity = blocks.find(block => block.includes('NATIVE_DISPATCH_ID=') && !block.includes('BY_TASK'));
    const capture = blocks.find(block => block.includes('forge-native-readonly-guard.js') && block.includes('--capture') && block.includes('case'));
    const verify = blocks.find(block => block.includes('forge-native-readonly-guard.js') && block.includes('--verify') && block.includes('case'));
    assert(identity && capture && verify, `${skill}: documented branches missing`);
    for (const [unit_type, unit_id, expected, status] of [['plan-slice', 'S01', 'capture\nverify\n', 0],
      ['execute-task', 'T01', '', 0], ['', 'S01', '', 9], ['plan-slice', '', '', 9]]) {
      const script = 'stop() { exit 9; }; node() { case "$*" in *--capture*) echo capture ;; *--verify*) echo verify ;; esac; };\n'
        + identity + '\n' + capture + '\n' + verify;
      const result = require('child_process').spawnSync(bash, ['-c', script], { encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HOST_RUNTIME: 'codex', unit_type, unit_id, PLAN_PATH: '', READONLY_BASELINE: '/fixture/baseline', WORKING_DIR: '/fixture', FORGE_SCRIPTS_DIR: '/fixture/scripts' } });
      assert.strictEqual(result.status, status, `${skill}: ${result.stderr}`);
      assert.strictEqual(result.stdout, expected);
    }
  }
});

test('S04 decision lifecycle: canonical old and new safeguards remain distributed', () => {
  const text = read('shared/forge-interaction.md');
  for (const phrase of [
    '# Forge interaction contract', '## Decision handling', '## Native adapters',
    '## Standing recovery authorization', '## Pending decision persistence',
    'A required live decision remains pending', 'optional-only tool', 'Plan-only tool',
    'approval-prohibited tool', 'returned pending handle is not an answer', 'multiSelect',
    'questions per batch', 'separate, concise text message', 'auto/headless deferment',
    'createRecoveryAuthorizationAdapter', 'registerStandingAuthorization',
    'readStandingAuthorization(reference)', 'tier safety ceiling',
    'Standing permission never answers a functional question',
    'one required decision per round', 'two or three options (up to four in Claude)',
    'each with its consequence', 'nothing preselected', 'forge-question-channel.js',
    '## Economic wait', 'Never sleep, poll or resume the model', 'single native call',
    'closed, cancelled, empty or timeout', 'close the round', 'neither an answer nor cancellation',
    'forge-question-channel.js --preference', 'never edit it', 'prefer request_user_input_async',
    'Owner only', '<FORGE_SCRIPTS_DIR>/forge-pending-questions.js',
    '--open', '--handoff', '--round', '--answer', '--continuation', '--list',
    'receipt is closed', 'protected writer window', 'never from workers', 'personal checkpoint',
    'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'appserver-input-required',
    'inbound-', 'approvalPolicy', 'Never retry an input-required attempt',
    'new dispatch of the same unit', 'answered-continuation-required',
  ]) assert(text.includes(phrase), `interaction contract lost: ${phrase}`);
  assert(!/proceed regardless|orchestrator always has the tool/i.test(text));
  assert.strictEqual(count(read('CLAUDE.md'), interaction.renderBlock()), 1);
});

test('S04 Codex lifecycle: skill, agent TOML and dispatch template contain canonical block exactly once', () => {
  const renderer = require('./forge-codex-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-question-distribution-'));
  temps.push(temp);
  const report = renderer.render({ repo: root, projectRoot: temp,
    codexHome: path.join(temp, 'codex'), forgeHome: path.join(temp, 'forge'),
    ...renderer.PRODUCTION_DISPATCH_DIALECT });
  for (const id of ['skills', 'agents', 'dispatch-templates']) {
    const artifact = report.artifacts.find(item => item.source_id === id);
    assert(artifact, `missing projection: ${id}`);
    // TOML multiline prompt bodies retain the same literal Markdown contract.
    assert.strictEqual(count(artifact.content, interaction.renderBlock()), 1, id);
    assert(artifact.content.includes('## Economic wait'), id);
  }
});

test('S04 discuss: one required decision per round retains stable pending IDs and explicit answers', () => {
  const text = read('skills/forge-discuss/SKILL.md');
  assert(text.includes('Ask one required decision per round through the interaction contract'));
  assert(text.includes('keep other areas pending by stable ID'));
  assert(text.includes('Require an explicit answer for each ID before dependent work'));
  assert(text.includes('persist and close unanswered rounds under Economic wait'));
  assert(!text.includes('Ask ALL questions at once'));
});

// S01/T07 milestone time — distribution of the canonical pointer, the native
// admission precheck and the time message templates. The precheck block is also
// executed against real temp owners; the projection proves text distribution,
// not that a host calls the guarded transport.
const TIME_POINTER = '`shared/forge-milestone-time.md`';
const TIME_SKILLS = ['forge-auto', 'forge-next'];
const TIME_TEMPLATES = {
  aviso: 'Prazo da milestone {M} {em risco|excede o saldo}: {consumido} de {teto}, saldo {saldo}, previsão {faixa}. Recomendo {alternativa} porque {motivo}. Opções, sem pré-seleção: estender o teto ({efeito}), reduzir escopo ({efeito}) ou seguir até o teto ({efeito}). Decisão pendente: {ID}. Sem resposta, o contrato atual continua valendo.',
  teto: 'Teto de tempo da milestone {M} atingido: {consumido} de {teto}. Parou: {o que parou}. Writers em voo: {N}, terminando pela própria vigilância. Decisão pendente: {ID estável}.',
  drain: 'Drain incompleto em {M}: {writers ou claim ainda em reconciliação}. Nenhum checkpoint foi salvo; a reconciliação segue o fluxo existente. Decisão pendente: {ID ou nenhuma}.',
  checkpoint: 'Checkpoint de tempo salvo em {M}: estouro de {estouro} sobre o teto de {teto}. Decisão pendente: {time-cap-ID}: estender por emenda explícita ou encerrar como parcial. Para retomar depois da extensão: ',
};
const ADMIT = 'forge-milestone-time-admission.js" --admit-transport';
function timeSection(text) { return between(text, '## Tempo da milestone\n', '## Bidirectional delivery'); }
function assertTimeSkill(name, text) {
  assert(text.includes(TIME_POINTER) && text.includes('${FORGE_HOME:-~/.forge-agent}/shared'), `${name}: time contract pointer missing`);
  const section = timeSection(text);
  const flatSection = flat(section);
  for (const piece of ['`time_session`', 'forge-milestone-time.js" --presence session-start', 'session-end', ADMIT,
    '[ "$TIME_ADMIT_EXIT" -eq 3 ] && stop', 'Saída 3 para antes de qualquer provider', 'O precheck só antecipa a recusa; a garantia fica no transporte',
    '`milestoneTimeContext: { cwd: WORKING_DIR, milestone: RUN_ID, unit: TIME_UNIT }`', 'nunca `CODE_DIR`',
    'Recusa de tempo não tem retry nem fallback', 'Task avulsa não recebe contexto de milestone',
    '`refuseNotInvoked`', '`consume-failure`', 'Nunca fabrique resultado de worker', '`workerObservationReader`', '`createObservationReader`',
    'uma decisão por rodada', 'Aviso dentro do teto e do escopo já autorizados é informativo',
    '`forge-pending-questions.js --open`', '`--answer`', '`forge-milestone-time.js --extend --ceiling-ms <n>`', '`--decide continue-to-cap|reduce-scope`',
    '`liveAdapter.getDecisionHandle`', '`time-decision-attestation-required`', 'Silêncio, timeout ou JSON importado nunca aprovam',
    '--wait-start <wait_id> --class human --source-kind pending-question', '`--wait-end`',
    '`--command resume-budget`', '`budget-resume-ready`', '`linked-reentry-required`', '(`reenter`)']) {
    assert(flatSection.includes(flat(piece)), `${name}: time section lacks ${piece}`);
  }
  for (const [label, template] of Object.entries(TIME_TEMPLATES)) assert(section.includes(template), `${name}: ${label} template missing`);
  const warning = section.indexOf(TIME_TEMPLATES.aviso);
  assert(section.indexOf('Recomendo', warning) < section.indexOf('Opções, sem pré-seleção', warning), `${name}: recommendation must precede the options`);
  // The precheck step precedes every native builder and invocation in the skill.
  assert(text.indexOf(ADMIT) < text.indexOf('buildNativeInvocation'), `${name}: --admit-transport must precede the native invocation`);
  const pointers = text.split('`milestoneTimeContext`').length - 1;
  assert(pointers >= 2, `${name}: native callsites lack the milestone time context pointer`);
  const adaptation = text.indexOf('**Native invocation adaptation**');
  const supervised = text.indexOf('Para unidade de milestone, essa chamada passa pela invocação nativa supervisionada', adaptation);
  assert(adaptation >= 0 && supervised > adaptation && supervised < text.indexOf('Wait for the result.', adaptation), `${name}: native adaptation lacks the supervised context`);
  for (const line of normativeLines()) assert(!section.includes(line), `${name}: time section copies contract line ${line.slice(0, 50)}`);
}

test('S01/T07 time pointer: auto, next and status point to the canonical milestone time contract', () => {
  assert(fs.existsSync(path.join(root, 'shared', 'forge-milestone-time.md')), 'canonical time contract missing');
  for (const name of TIME_SKILLS) assertTimeSkill(name, skills[name]);
  assert(skills['forge-auto'].includes(`${TIME_TEMPLATES.checkpoint}/forge-auto {RUN_ID}.`), 'forge-auto checkpoint resume target');
  assert(skills['forge-next'].includes(`${TIME_TEMPLATES.checkpoint}/forge-next.`), 'forge-next checkpoint resume target');
  const batch = between(skills['forge-auto'], '#### 4-P.', '**k) Re-enter the dispatch loop**');
  assert(flat(batch).includes('passa pelo precheck `--admit-transport` de § Tempo da milestone com a unidade `execute-task/${ENTRY_ID}`'), 'batch entries lack the per-entry precheck');
  const status = skills['forge-status'];
  assert(status.includes(TIME_POINTER), 'forge-status: time contract pointer missing');
  assert(flat(status).includes('O bloco de tempo da milestone vem do `forge-status.js`'), 'forge-status: time block source missing');
  assert(flat(status).includes('é repassado verbatim e nenhuma decisão de extensão, redução ou continuação é inferida dele'), 'forge-status: no inferred decision');
  const review = read('shared/forge-review.md');
  assert.strictEqual(count(review, '"${BUDGET_ARGS[@]}"'), 7, 'review: definition plus six external legs carry the budget context');
  assert(flat(review).includes('não há retry, não há fallback para outro revisor ou família'), 'review: time refusal must not fall back');
  assert(flat(read('shared/forge-dispatch.md')).includes('O precheck `forge-milestone-time-admission.js --admit-transport` só antecipa a recusa; ele não é a garantia'), 'dispatch: precheck limitation missing');
});

test('S01/T07 time admission block: the documented precheck admits a contract-free owner and stops an exhausted one before any provider', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  assert(fs.existsSync(bash), 'the admission block needs bash to execute');
  const time = require('./forge-milestone-time');
  const questions = require('./forge-pending-questions');
  const { digest } = require('./forge-code-roots');
  const owner = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-time-admission-block-'));
    temps.push(dir); fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true }); return dir;
  };
  const free = owner(), exhausted = owner(), M = 'M001', now = Date.now();
  const contract = { schema_version: 1, milestone: M, clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
    option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Entrega verificada' },
    activated_at: new Date(now - 3600000).toISOString(), preselection_started_at: new Date(now - 3660000).toISOString(), ceiling_ms: 1000,
    endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(key => [key, 'pending'])) },
    allocation: null, linked_task: null, chain_forecast: null };
  const opened = questions.openQuestions({ cwd: exhausted, milestone: M, unit: 'milestone-time/q1', decision_set: 'milestone-time-activation',
    questions: [{ id: 'q1', question: 'Escolha?' }] });
  questions.answer({ cwd: exhausted, identity: opened.identity_sha256, answers: [{ id: 'q1', answer: 'option:balanced', source: 'user-text' }] });
  const live = { reference: 'live-1', status: 'resolved', answer: 'option:balanced', resolved_at: new Date(now - 1000).toISOString(),
    source: 'user-text', question: { identity_sha256: opened.identity_sha256, id: 'q1' } };
  time.activateContract({ cwd: exhausted, milestone: M, contract, handle: time.createDecisionAuthority(() => live)
    .issue(live.reference, { milestone: M, kind: 'activation', request_sha256: digest(contract), expires_at: now + 60000 }, () => now) });
  for (const name of TIME_SKILLS) {
    const block = [...skills[name].matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]).find(text => text.includes(ADMIT));
    assert(block, `${name}: admission block missing`);
    const run = cwd => require('child_process').spawnSync(bash, ['-c', `stop() { exit 9; }; node() { "$NODE_BIN" "$@"; };\n${block}\necho continued`], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_BIN: process.execPath.replace(/\\/g, '/'),
        FORGE_SCRIPTS_DIR: path.join(root, 'scripts').replace(/\\/g, '/'), WORKING_DIR: cwd.replace(/\\/g, '/'), RUN_ID: M,
        unit_type: 'execute-task', unit_id: 'T01' } });
    const admitted = run(free);
    assert.strictEqual(admitted.status, 0, `${name}: ${admitted.stderr}`);
    assert.deepStrictEqual(JSON.parse(admitted.stdout.split('\n')[0]), { allowed: true, decision: 'no-contract' }, `${name}: contract-free admission`);
    assert(admitted.stdout.includes('continued'), `${name}: contract-free work continues`);
    const refused = run(exhausted);
    assert.strictEqual(refused.status, 9, `${name}: exit 3 must stop: ${refused.stdout}${refused.stderr}`);
    const result = JSON.parse(refused.stdout.split('\n')[0]);
    assert.deepStrictEqual([result.allowed, result.reason_code, result.provider_called], [false, 'milestone-budget-exhausted', false], `${name}: refusal`);
    assert(!refused.stdout.includes('continued'), `${name}: refused work must not continue`);
  }
});

test('S01/T07 Codex projection: projected auto/next carry the time pointer, admission step and templates; status the pointer', () => {
  const renderer = require('./forge-codex-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-communication-surfaces-time-'));
  temps.push(temp);
  const report = renderer.render({ repo: root, projectRoot: temp, codexHome: path.join(temp, 'host'),
    forgeHome: path.join(temp, 'forge'), ...renderer.PRODUCTION_DISPATCH_DIALECT });
  const projected = name => report.artifacts.find(item => item.source_id === 'skills' && item.source === `skills/${name}/SKILL.md`).content.replace(/\r\n/g, '\n');
  for (const name of TIME_SKILLS) assertTimeSkill(`${name} (Codex)`, projected(name));
  const status = projected('forge-status');
  assert(status.includes(TIME_POINTER) && flat(status).includes('nenhuma decisão de extensão, redução ou continuação é inferida dele'), 'forge-status (Codex): time sentence missing');
});

// ── S03/T06: linked task distribution ───────────────────────────────────────
// Reads the actual Claude skill sources, the actual Claude and Codex renders and
// the shared contracts; runs the documented shell blocks and the inert public
// CLI entries of T01..T05 against temporary owners only. Distribution proof only:
// no host, provider or client executes here, so client execution, comprehension,
// installation and human acceptance stay unknown.
const T06_SPANS = Object.freeze({
  new_initialization: { bytes: 2367, sha256: '59fc7952aa70c103e4811b95b1c4de2f89f4124970a8544d525c3dd764dd672d' },
  fresh_registration: { bytes: 1803, sha256: 'b0d14d5ba51b0096922338482ad357c77a193e5af4097616fbdc469681ee7874' },
  brief_template_lf: { bytes: 1477, sha256: 'e37de53f5cd7513ca13c196a6081eb4d53a167156f739de2bb1bd8c6d4dc3310' },
  request_builder_lf: { bytes: 1662, sha256: '473366130d2e9d1b67e4bf3154ea0021a305a3c2359f1aada02ac0a65eea80bb' },
});
const T06_BLOCKS = Object.freeze({ 'forge-task': ['resume', 'phase-admission', 'review-legs', 'close'], 'forge-auto': ['closure', 'cleanup-order'],
  'forge-next': ['closure', 'cleanup-order'], 'forge-status': ['status'] });
const T06_BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const T06_TASK = 'T-20261105120000-linked-fixture';
const linkedStart = require('./forge-linked-task-start');
const linkedHorizon = require('./forge-linked-task-horizon');
const timeAdmission = require('./forge-milestone-time-admission');
let t06Rendered = null;
function t06(label, fn) { test(`T06 linked distribution: ${label}`, fn); }
function t06Projections() {
  if (t06Rendered) return t06Rendered;
  const claudeRenderer = require('./forge-claude-renderer');
  const codexRenderer = require('./forge-codex-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-t06-linked-'));
  try {
    const claude = claudeRenderer.render({ repo: root, projectRoot: temp, claudeHome: path.join(temp, 'claude'), forgeHome: path.join(temp, 'forge-claude') });
    const codex = codexRenderer.render({ repo: root, projectRoot: temp, codexHome: path.join(temp, 'codex'), forgeHome: path.join(temp, 'forge-codex'),
      ...codexRenderer.PRODUCTION_DISPATCH_DIALECT });
    const pick = (report, host, name) => {
      const row = report.artifacts.find(item => item.source_id === 'skills' && item.source === `skills/${name}/SKILL.md`);
      assert(row, `${host}: ${name} projection missing`);
      return row.content.replace(/\r\n/g, '\n');
    };
    t06Rendered = {
      claude: Object.fromEntries(ALL.map(name => [name, pick(claude, 'Claude', name)])),
      codex: Object.fromEntries(ALL.map(name => [name, pick(codex, 'Codex', name)])),
      claudeSurfaces: claude.artifacts.map(row => ({ source_id: row.source_id, source: row.source, content: row.content })),
    };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return t06Rendered;
}
function t06Views(name) {
  const rendered = t06Projections();
  return [['Claude source', skills[name]], ['Claude projection', rendered.claude[name]], ['Codex projection', rendered.codex[name]]];
}
function linkedBlock(text, id, label = '') {
  const start = `<!-- forge:linked-task:${id}:start -->\n`, end = `<!-- forge:linked-task:${id}:end -->\n`;
  assert.strictEqual(count(text, start), 1, `${label} linked block ${id}: one start marker`);
  assert.strictEqual(count(text, end), 1, `${label} linked block ${id}: one end marker`);
  const from = text.indexOf(start), to = text.indexOf(end);
  assert(to > from, `${label} linked block ${id}: end follows start`);
  return text.slice(from, to + end.length);
}
function includesAll(label, text, pieces) {
  const flatText = flat(text);
  for (const piece of pieces) assert(flatText.includes(flat(piece)), `${label}: missing ${piece}`);
}
function inOrder(label, text, pieces) {
  let cursor = -1;
  for (const piece of pieces) {
    const at = text.indexOf(piece, cursor + 1);
    assert(at > cursor, `${label}: ${piece} out of order or missing`);
    cursor = at;
  }
}
function stateBullet(block, state) {
  const from = block.indexOf(`\n- \`${state}\``);
  assert(from >= 0, `state ${state} missing`);
  const to = block.indexOf('\n- `', from + 1);
  return block.slice(from, to < 0 ? block.length : to);
}
function contractSection(text, heading) {
  const from = text.indexOf(`\n${heading}\n`);
  assert(from >= 0, `missing ${heading}`);
  const to = text.indexOf('\n## ', from + heading.length + 2);
  return text.slice(from, to < 0 ? text.length : to);
}
function bashBlocks(text) { return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1].replace(/^ {2}/gm, '')); }
function runBash(script, env) {
  assert(fs.existsSync(T06_BASH), 'the documented shell blocks need bash to execute');
  return require('child_process').spawnSync(T06_BASH, ['-c', `stop() { exit 9; }; node() { "$NODE_BIN" "$@"; };\n${script}`], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_BIN: process.execPath.replace(/\\/g, '/'),
      FORGE_SCRIPTS_DIR: path.join(root, 'scripts').replace(/\\/g, '/'), ...env } });
}
function t06Owner(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-t06-${prefix}-`));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, '.gsd', 'tasks', T06_TASK), { recursive: true });
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  return dir;
}
function inertMain(main, argv) {
  const out = [];
  const status = main(argv, { stdout: { write: chunk => { out.push(String(chunk)); } }, stderr: { write() {} } });
  return { status, json: JSON.parse(out.join('').trim()) };
}

t06('resume-cycle-and-embedded-authority', () => {
  for (const [label, text] of t06Views('forge-task')) {
    const block = linkedBlock(text, 'resume', label);
    const statusAt = text.indexOf('forge-linked-task-start.js" --status');
    assert(statusAt > 0 && block.includes('forge-linked-task-start.js" --status --cwd "$WORKING_DIR" --task "$TASK_ID" --json'), `${label}: read-only status call`);
    for (const later of ['--intent explicit-resume --json', '**Isolation setup (branch/worktree)**', '**Register in multi-run registry**', '## Dispatch loop']) {
      const at = text.indexOf(later);
      assert(at > statusAt, `${label}: the read-only lifecycle must precede ${later}`);
    }
    includesAll(label, block, ['Antes de qualquer vínculo pessoal, isolamento, registro ou despacho', '`.gsd/forge/time-links/{TASK_ID}.json`',
      '`linked_milestone`', 'nunca vira task sem vínculo', 'O resultado `null`', 'a retomada segue exatamente como abaixo',
      'permissão permanente de routing ou de recovery não é resposta de início, de encerramento da cadeia nem de extensão',
      'não muda a criação nova, o template do BRIEF, o construtor de pedido, o registro do run, o borrower (`attached_to`) nem `worktree_cleanup_on_complete`']);
    includesAll(`${label} invalid`, stateBullet(block, 'invalid'), ['pare sem bind, isolamento nem despacho', 'Task ligada {TASK_ID} inválida ({reason})', 'Alternativas']);
    includesAll(`${label} blocked`, stateBullet(block, 'blocked'), ['pare sem bind, isolamento nem despacho', 'Task ligada {TASK_ID} bloqueada: {reason}',
      'Alternativas, sem pré-seleção', 'estender a milestone por decisão explícita', 'encerrar a cadeia por decisão explícita (linked-task:close-chain)']);
    const ready = stateBullet(block, 'handoff-ready');
    includesAll(`${label} handoff-ready`, ready, ['Base `milestone-branch`', 'ATTACH_RUN="$LINKED_MILESTONE"', 'Base `integrated`', 'sem attach, o setup normal',
      'nunca adivinhado', '`linked-task-base-unproven`', 'main(argv, io, liveAdapter)', '`liveAdapter.getDecisionHandle`', 'sem pergunta redundante',
      'forge-linked-task-start.js" --start --cwd "$WORKING_DIR" --task "$TASK_ID"', '--base-kind "$LINKED_BASE_KIND"', '--code-dir "$CODE_DIR"',
      'recusa com `linked-task-authorization-required` antes de qualquer leitura', 'pare, a decisão continua pendente',
      'não é repetida com outros argumentos, outro engine ou outro host']);
    inOrder(`${label} handoff-ready`, ready, ['ATTACH_RUN="$LINKED_MILESTONE"', 'Depois do isolamento e antes do Dispatch loop', '--start']);
    includesAll(`${label} open`, stateBullet(block, 'open'), ['nada começa sozinho', 'pedido explícito do operador registrado em `forge-pending-questions`',
      '`linked-task:start`', '`prepareLinkedDecision`', '`answerLinkedDecision`', 'Sem resposta', 'e pare']);
    includesAll(`${label} started`, stateBullet(block, 'started'), ['`--continue`', 'adaptador vivo', '`linked-task-authorization-required`', 'pare sem repetir']);
    includesAll(`${label} closed`, stateBullet(block, 'closed'), ['`chain-closed`', 'pare sem bind']);
  }
  // The documented status block, executed against real temporary owners through the T03 public CLI.
  const script = bashBlocks(linkedBlock(skills['forge-task'], 'resume'))[0];
  const probe = owner => runBash(`${script}\nprintf 'JSON=%s\\nSTATE=%s|%s\\n' "$LINKED_STATUS_JSON" "$LINKED_STATE" "$LINKED_MILESTONE"`,
    { WORKING_DIR: owner.replace(/\\/g, '/'), TASK_ID: T06_TASK, RESUME_MODE: '1' });
  const unlinked = t06Owner('unlinked');
  fs.writeFileSync(path.join(unlinked, '.gsd', 'tasks', T06_TASK, `${T06_TASK}-BRIEF.md`), `---\nid: ${T06_TASK}\ndescription: fixture\n---\n\n# fixture\n`);
  const plain = probe(unlinked);
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert(plain.stdout.includes('JSON=null\n') && plain.stdout.includes('STATE=|\n'), `unlinked task stays unlinked: ${plain.stdout}`);
  const marker = t06Owner('marker');
  fs.writeFileSync(path.join(marker, '.gsd', 'tasks', T06_TASK, `${T06_TASK}-BRIEF.md`), `---\nid: ${T06_TASK}\nlinked_milestone: M001\n---\n\n# fixture\n`);
  const missing = probe(marker);
  assert(missing.stdout.includes('STATE=invalid|') && missing.stdout.includes('linked-task-link-missing'), `BRIEF marker without index fails closed: ${missing.stdout}`);
  const malformed = t06Owner('index');
  fs.mkdirSync(path.join(malformed, '.gsd', 'forge', 'time-links'), { recursive: true });
  fs.writeFileSync(path.join(malformed, '.gsd', 'forge', 'time-links', `${T06_TASK}.json`), '{');
  assert(probe(malformed).stdout.includes('STATE=invalid|'), 'malformed index fails closed, never unlinked');
  for (const owner of [unlinked, marker, malformed]) assert(!fs.existsSync(path.join(owner, '.gsd', 'forge', 'time')), 'status is a pure read');
});

t06('endpoint-handoff-start-before-cleanup', () => {
  for (const name of ['forge-auto', 'forge-next']) {
    for (const [view, text] of t06Views(name)) {
      const label = `${name} ${view}`;
      const block = linkedBlock(text, 'closure', label);
      assert(block === linkedBlock(skills[name], 'closure'), `${label}: closure block differs from the Claude source`);
      includesAll(label, block, ['o mesmo `--decide` embutido do passo 4 também cria a task', '`create-and-start-after-proven-completion`', '`create-without-auto-start`',
        '`linked_task {status, task_id, reason}`', '`creation-pending` (saída 3) se resolve repetindo `--decide`', 'não é consentimento novo nem pergunta nova',
        '`forge-linked-task.js --create` recusa com `linked-task-authorization-required`',
        '`milestone_cleanup` igual a `archive` ou `delete`', 'endpoint-sources-missing', 'A preferência não foi alterada',
        'adiada com motivo nomeado', '`cadeia bloqueada: {código}`', '`aguardando início explícito da task ligada {T}`',
        '`worktree_cleanup_on_complete` e `milestone_cleanup` não mudam e nenhum borrower falso é criado',
        'SUMMARY, DELIVERY, ledger, checkbox, run inativo, claim liberado, seleção da task ou texto nunca são ACK nem endpoint']);
      inOrder(`${label} closure order`, block, ['1. ACK real de `complete-milestone`', 'forge-milestone-endpoint.js" --verify', 'forge-milestone-endpoint.js" --record',
        'forge-linked-task-start.js" --handoff', '`/forge-task --resume {T}` ANTES da limpeza de isolamento', '6. Só depois do início real']);
      for (const template of ['Endpoint de {M} comprovado:', 'Endpoint de {M} não comprovado ({código}):', 'Relógio de {M} congelado em', 'Handoff de {M} para a task ligada {T} produzido',
        'Início encadeado da task ligada {T}', 'Cadeia {M} → {T} bloqueada:']) assert(block.includes(template), `${label}: message ${template}`);
      const blocked = block.slice(block.indexOf('Cadeia {M} → {T} bloqueada:'));
      inOrder(`${label} blocked chain message`, blocked, ['Recomendo', 'Opções, sem pré-seleção', 'Decisão pendente']);
      includesAll(label, block, ['`linked-task:start`', '`linked-task:close-chain`', '`linked-task:extend:<ms>`', '`verifyDecision`',
        'Permissão permanente de routing ou de recovery, JSON importado, flag, SUMMARY, checkpoint, texto deste skill ou silêncio nunca respondem']);
      const order = linkedBlock(text, 'cleanup-order', label);
      const cleanupCommand = text.indexOf('forge-isolation.js" --cleanup --run');
      assert(text.indexOf(block) < text.indexOf(order) && text.indexOf(order) < cleanupCommand, `${label}: deferral precedes the milestone isolation cleanup`);
      includesAll(`${label} cleanup order`, order, ['não rode a limpeza abaixo', 'Limpeza de isolamento de {M} adiada:', 'aguardando início explícito da task ligada {T}',
        'encerramento explícito da cadeia', 'A política (`worktree_cleanup_on_complete`, `milestone_cleanup`) não muda']);
      inOrder(`${label} cleanup order`, order, ['ACK real de `complete-milestone`', '`--verify`', '`--record`', '`--handoff`', '`/forge-task --resume {T}`']);
    }
  }
});

t06('status-verbatim-no-decision', () => {
  const summary = linkedHorizon.summarizeLinkedStatus({ status: 'ok', task_id: T06_TASK, milestone: 'M001', predecessor: { lifecycle: 'started' },
    task_horizon: { state: 'active', ceiling_ms: 10, consumed_ms: 1, unknown_ms: 0, remaining_ms: 9, extensions: 0 }, milestone_horizon: { state: 'endpoint-proven' },
    chain: { cap_ms: 20 }, decision_pending: false, unknowns: [] });
  assert.strictEqual(linkedHorizon.summarizeLinkedStatus(null), null, 'unlinked work gains no linked field');
  for (const [label, text] of t06Views('forge-status')) {
    const block = linkedBlock(text, 'status', label);
    for (const field of ['lifecycle', 'task', 'milestone', 'chain', 'decision_pending', 'unknown']) {
      assert(Object.hasOwn(summary, field), `real summary lacks ${field}`);
      assert(block.includes(`\`${field}\``), `${label}: relayed field ${field}`);
    }
    assert.strictEqual(summary.chain.governs, false);
    includesAll(label, block, ['são repassados verbatim', 'o teto da cadeia é soma derivada que não governa nada (`governs: false`)', 'previsão nunca vira teto',
      'Valor sem fonte continua desconhecido, nunca zero', 'Nenhuma decisão de início, de encerramento da cadeia ou de extensão do horizonte é inferida desse bloco',
      'task sem vínculo não ganha campo novo', '`shared/forge-milestone-time.md § Task ligada e endpoint (S03)`']);
    assert(text.includes('node "$FORGE_SCRIPTS_DIR/forge-status.js" $ARGUMENTS'), `${label}: status command unchanged`);
  }
});

t06('canonical-storage-and-availability', () => {
  const time = read('shared/forge-milestone-time.md');
  const section = contractSection(time, '## Task ligada e endpoint (S03)');
  inOrder('contract subsections', section, ['### Armazenamento e índice', '### Schemas', '### Criação na gravação da seleção', '### Endpoint comprovado e congelamento',
    '### Prova da predecessora', '### Handoff, início, continuação e tipos de base', '### Consumo no BRIEF e nos prompts', '### Horizontes e tetos',
    '### Códigos de admissão e transporte', '### Drain, checkpoint e extensão', '### Encerramento da task e da cadeia', '### Superfícies', '### CLIs',
    '### Limites da S03', '### Disponibilidade da S03']);
  for (const schema of ['forge-linked-task', 'forge-milestone-endpoint', 'forge-linked-task-handoff', 'forge-linked-task-horizon']) {
    assert(section.includes(`shared/schemas/${schema}.schema.json`) && fs.existsSync(path.join(root, 'shared', 'schemas', `${schema}.schema.json`)), schema);
  }
  for (const code of timeAdmission.TRANSPORT_REFUSAL_CODES) assert(section.includes(`\`${code}\``), `contract lacks transport code ${code}`);
  for (const state of linkedStart.LIFECYCLE_STATES) assert(section.includes(`\`${state}\``), `contract lacks lifecycle ${state}`);
  for (const kind of linkedStart.BASE_KINDS) assert(section.includes(`\`${kind}\``), `contract lacks base kind ${kind}`);
  includesAll('contract', section, ['`.gsd/forge/time-links/<T>.json`', 'nunca viram task sem vínculo', 'logo depois de `decide` e com o mesmo adaptador vivo',
    'ACK real de `complete-milestone` → `forge-milestone-endpoint.js --verify`', '→ `--record`', 'o consumo da milestone congela no endpoint',
    '`endpoint-unproven`', '`consumedHandoffBlock`', 'exatamente uma vez em cada uma das quatro fases', '`cap_basis: derived-sum`, `governs: false`',
    'Teto da milestone governa as operações da milestone', 'teto da task (horizonte do vínculo', 'Nenhum saldo vira timeout de worker',
    '`linked-task:extend:<ms>`', '`--close`', '`--close-chain`', '`forge-status`', '`forge-personal-summary`',
    'node scripts/forge-linked-task-start.js --status|--handoff|--close', 'node scripts/forge-linked-task-horizon.js --status|--admit']);
  const limits = section.slice(section.indexOf('### Limites da S03'), section.indexOf('### Disponibilidade da S03'));
  includesAll('limits', limits, ['Adaptador vivo embutido obrigatório para decisões e início', 'A guarda de transporte não reatesta autoridade ao vivo',
    'Pernas de revisão sem contexto real de task ligada não têm a garantia', '`milestone_cleanup` `archive` ou `delete` antes do endpoint',
    'impede a prova (`endpoint-sources-missing`)', 'Filhos de lote nativo não são observáveis pelo drain e ficam desconhecidos']);
  const availability = section.slice(section.indexOf('### Disponibilidade da S03'));
  inOrder('availability', availability, ['Implementado e testado offline', 'Distribuído:', 'Condicional:', 'Desconhecido:']);
  includesAll('availability', availability, ['dependem do adaptador vivo embutido pelo host', 'depende do contexto real', 'depende das sondas vivas',
    'execução e compreensão pelo cliente instalado, instalação e aceite humano', 'Projeção e distribuição não demonstram execução no cliente']);
  includesAll('old boundary', time, ['Só milestones, exceto os registros da task ligada (§ Task ligada e endpoint (S03))',
    '`time-work-kind-unsupported` para task avulsa, que continua sem orçamento de tempo próprio']);
  assert(!time.includes('- Só milestones; `time-work-kind-unsupported`'), 'the old only-milestones line gained the linked exception');
});

t06('preparation-personal-authority-boundaries', () => {
  const prep = contractSection(read('shared/forge-task-preparation.md'), '## Task ligada (S03)');
  includesAll('preparation', prep, ['Sem vínculo, nada muda', 'prompt, pedido, fingerprint, recibo e resultado de task sem vínculo', 'Admissão ligada antes da rota',
    'reaproveita o recibo `ready`', 'Admissão de novo nas entradas reais', '`recoverStandaloneTask`', 'Segundo invoke nativo continua `native-handoff-already-invoked`',
    'Bloco consumido exatamente uma vez', '(brainstorm, discuss, research e plan)', 'sem duplicar', '`forge-linked-task-horizon.js --admit`',
    'Ele só antecipa a mensagem; a garantia é a admissão acima', 'Nem este contrato nem o texto do skill concedem autoridade',
    'permissão permanente de routing ou de recovery continua sendo só autorização de rota, nunca consentimento funcional']);
  inOrder('preparation order', prep, ['Admissão ligada antes da rota', 'resolve a rota', 'Admissão de novo nas entradas reais']);
  const prepSource = read('scripts/forge-task-preparation.js');
  for (const api of ['startStandaloneTaskPreparationCore', 'decideLinkedTaskEntry', 'consumedHandoffBlock', 'recoverStandaloneTask', 'buildPreparationPrompt']) {
    assert(prepSource.includes(api), `preparation contract cites a real seam: ${api}`);
  }
  assert.strictEqual(typeof linkedStart.consumedHandoffBlock, 'function');
  assert.strictEqual(typeof linkedHorizon.decideLinkedTaskEntry, 'function');
  const personal = contractSection(read('shared/forge-personal-context.md'), '## Task ligada (S03)');
  includesAll('personal', personal, ['Pendência da task ligada', 'vínculo pessoal `create`', '`pending` com fonte no `link.json`', 'Não seleção antes da prova',
    'a task nunca é selecionada como trabalho aberto', 'pendência não é permissão de despacho', 'Transições reais do ciclo, aplicadas só pela API do owner',
    '`linked-task:start`', '`start.json`', 'nunca `open` por inferência', '`closure.json`', '`chain-closure.json`', 'trabalho protegido',
    'Checkpoint, SUMMARY, handoff, resumo, texto de skill ou de contrato e JSON importado são evidência, nunca consentimento',
    'resposta explícita persistida em `forge-pending-questions` e handle vivo conferido por `verifyDecision`',
    'permissão permanente de routing ou de recovery não responde a essas perguntas', 'consulta o ciclo somente leitura antes do `--bind --intent explicit-resume`']);
  for (const [name, api] of [['prepareLinkedDecision', linkedStart.prepareLinkedDecision], ['answerLinkedDecision', linkedStart.answerLinkedDecision],
    ['prepareTaskExtension', linkedHorizon.prepareTaskExtension], ['answerTaskExtension', linkedHorizon.answerTaskExtension]]) assert.strictEqual(typeof api, 'function', name);
});

t06('two-host-literals-main-exports-and-old-retention', () => {
  const rendered = t06Projections();
  const scripts = new Set();
  for (const [name, ids] of Object.entries(T06_BLOCKS)) {
    for (const id of ids) {
      const source = linkedBlock(skills[name], id, name);
      assert.strictEqual(linkedBlock(rendered.claude[name], id, `${name} Claude`), source, `${name}/${id}: Claude projection carries the source block`);
      assert.strictEqual(linkedBlock(rendered.codex[name], id, `${name} Codex`), source, `${name}/${id}: Codex projection carries the source block`);
      for (const match of source.matchAll(/(forge-[a-z0-9-]+\.js)"? --[a-z]/g)) scripts.add(match[1]);
    }
  }
  for (const [file, id] of [['shared/forge-review.md', 'review-budget'], ['shared/forge-dispatch.md', 'dispatch-budget']]) {
    for (const match of linkedBlock(read(file), id, file).matchAll(/(forge-[a-z0-9-]+\.js)"? --[a-z]/g)) scripts.add(match[1]);
  }
  for (const match of contractSection(read('shared/forge-milestone-time.md'), '## Task ligada e endpoint (S03)').matchAll(/(forge-[a-z0-9-]+\.js)"? --[a-z]/g)) scripts.add(match[1]);
  assert.deepStrictEqual([...scripts].sort(), ['forge-linked-task-horizon.js', 'forge-linked-task-start.js', 'forge-linked-task.js', 'forge-milestone-endpoint.js'],
    'actual CLI references of the linked sections');
  for (const script of scripts) {
    assert(fs.existsSync(path.join(root, 'scripts', script)), `${script} exists`);
    assert.strictEqual(typeof require(`./${script}`).main, 'function', `${script} exports main`);
  }
  // Frozen unlinked spans: raw bytes of fresh creation, LF parity shapes of the BRIEF and the request builder.
  const raw = fs.readFileSync(path.join(root, 'skills/forge-task/SKILL.md'), 'utf8');
  const span = (from, to, extra = 0) => { const a = raw.indexOf(from), b = raw.indexOf(to, a); assert(a >= 0 && b > a, `span ${from}`); return Buffer.from(raw.slice(a, b + extra), 'utf8'); };
  const fresh = span('**Register in multi-run registry**', '\nThis makes the task visible', 1);
  const init = span('## Initialize task (skip if resume mode)', '## Cleanup orphaned tasks');
  const lf = raw.replace(/\r\n/g, '\n');
  const briefStart = lf.indexOf('```markdown\n', lf.indexOf('\n## Initialize task')), briefEnd = lf.indexOf('\n```\n', briefStart + 12);
  const brief = Buffer.from(lf.slice(briefStart, briefEnd + 4), 'utf8');
  const open = '<!-- forge:task-preparation-request:start -->', close = '<!-- forge:task-preparation-request:end -->';
  const builder = Buffer.from(lf.slice(lf.indexOf(open), lf.indexOf(close) + close.length), 'utf8');
  assert.strictEqual(count(lf, open), 1, 'one request builder');
  for (const [key, bytes] of [['fresh_registration', fresh], ['new_initialization', init], ['brief_template_lf', brief], ['request_builder_lf', builder]]) {
    assert.deepStrictEqual({ bytes: bytes.length, sha256: hash(bytes) }, T06_SPANS[key], `frozen ${key}`);
    assert(!bytes.toString('utf8').includes('forge:linked-task:'), `${key} carries no linked text`);
  }
  // Old literals: outside the linked blocks every declared skill/shared byte still equals the owner baseline.
  const pinState = checkPins(); const sampleState = checkSamples(); checkRegistry(); checkSmoke();
  // Measured transient drift for T07 (recorded, not re-pinned): the raw skills surface differs only by the linked blocks.
  // Once T07 re-pins that surface to its genuine raw measurement, no drift remains (checkPins proved the value).
  const drift = [];
  for (const surface of golden.surfaces) {
    const rawHash = surfaceHash(rendered.claudeSurfaces, surface.source_id, true);
    if (rawHash !== surface.sha256) drift.push(`${surface.source_id} ${surface.sha256} -> ${rawHash}`);
  }
  assert.deepStrictEqual(drift.map(row => row.split(' ')[0]), T06_RAW_DRIFT.filter(id => !pinState.repinned.includes(id)),
    'only the skills surface drifts before T07');
  for (const row of drift) console.log(`note - T06 measured transient drift for T07 (not re-pinned): ${row}`);
  for (const id of pinState.repinned) console.log(`note - T06 attributed surface ${id} carries its genuine raw re-pin`);
  if (sampleState.state === 'raw-repinned') {
    console.log(`note - T06 samples cite the genuine raw forge-task hash ${sampleState.taskHash} and forge-next hash ${sampleState.nextHash}`);
  }

  // T06-R1 offline fixture, in memory only: the actual pre-repin state and a genuine
  // future raw-repinned state both pass; wrong or unrelated pins, undocumented re-pins,
  // source edits outside the linked blocks and sample text edits are all refused.
  const surfaces = rendered.claudeSurfaces;
  const refused = (label, fn) => assert.throws(fn, error => error instanceof assert.AssertionError, `${label} must be refused`);
  // #341: the "current attributed" pin of a delta surface is its measured attributed after (before = T06 value).
  const pinsWith = values => ({ ...golden, surfaces: golden.surfaces.map(row => ({ ...row,
    sha256: values[row.source_id] || attributedNow('surfaces', row.source_id, T06_ATTRIBUTED_PINS[row.source_id]) })) });
  const rawSkills = surfaceHash(surfaces, 'skills', true);
  assert.notStrictEqual(rawSkills, T06_ATTRIBUTED_PINS.skills, 'the linked blocks really change the raw skills surface');
  const repinnedReadme = `${pinReadme}\n${rawSkills}\n`;
  assert.deepStrictEqual(checkPins({ golden: pinsWith({}), artifacts: surfaces }).repinned, [], 'current attributed pins pass');
  assert.deepStrictEqual(checkPins({ golden: pinsWith({ skills: rawSkills }), artifacts: surfaces, pinReadme: repinnedReadme }).repinned, ['skills'],
    'genuine raw skills re-pin passes');
  const wrong = hash('not a measured surface');
  refused('wrong skills pin', () => checkPins({ golden: pinsWith({ skills: wrong }), artifacts: surfaces, pinReadme: `${repinnedReadme}${wrong}\n` }));
  refused('unrelated surface re-pin', () => checkPins({ golden: pinsWith({ skills: rawSkills, hooks: wrong }), artifacts: surfaces,
    pinReadme: `${repinnedReadme}${wrong}\n` }));
  const undocumentedSkillsReadme = pinReadme.split(rawSkills).join('');
  assert(!undocumentedSkillsReadme.includes(rawSkills), 'negative fixture does not document the current raw hash');
  refused('undocumented raw re-pin', () => checkPins({ golden: pinsWith({ skills: rawSkills }), artifacts: surfaces,
    pinReadme: undocumentedSkillsReadme }));
  const editedSurfaces = surfaces.map(row => row.source === 'skills/forge-next/SKILL.md' ? { ...row, content: `${row.content}\nunrelated edit\n` } : row);
  const editedRaw = surfaceHash(editedSurfaces, 'skills', true);
  refused('source edit hidden by its own raw re-pin', () => checkPins({ golden: pinsWith({ skills: editedRaw }), artifacts: editedSurfaces,
    pinReadme: `${repinnedReadme}${editedRaw}\n` }));
  const readRaw = rel => fs.readFileSync(path.join(root, rel));
  refused('frozen source edit outside the linked blocks', () => checkPins({ golden: pinsWith({ skills: rawSkills }), artifacts: surfaces, pinReadme: repinnedReadme,
    readSource: rel => rel === 'skills/forge-task/SKILL.md' ? Buffer.concat([readRaw(rel), Buffer.from('\nunrelated edit\n')]) : readRaw(rel) }));
  // Samples (Repair2): walk the ACTUAL four nodes (two forge-task, two forge-next) and set
  // their source.sha256 spans only; every other byte of the real samples stays as checked in.
  const [taskSource, nextSource] = T06_SAMPLE_SOURCES;
  assert.deepStrictEqual(linkedSampleNodes(samples).map(node => node.pointer).sort(), [...taskSource.pointers, ...nextSource.pointers].sort(),
    'fixture walks the actual cited sample nodes');
  const sourceBytes = { [taskSource.file]: readRaw(taskSource.file), [nextSource.file]: readRaw(nextSource.file) };
  const rawTask = hash(sourceBytes[taskSource.file]), rawNext = hash(sourceBytes[nextSource.file]);
  assert.notStrictEqual(rawTask, T06_ATTRIBUTED_TASK_SHA, 'the linked blocks really change the raw forge-task bytes');
  assert.notStrictEqual(rawNext, T06_ATTRIBUTED_NEXT_SHA, 'the linked blocks really change the raw forge-next bytes');
  const setShas = (text, values) => withSampleShas(text, T06_SAMPLE_SOURCES.flatMap(source =>
    source.file in values ? source.pointers.map(pointer => [pointer, values[source.file]]) : []));
  const attributedOf = { [taskSource.file]: attributedNow('files', taskSource.file, T06_ATTRIBUTED_TASK_SHA),
    [nextSource.file]: attributedNow('files', nextSource.file, T06_ATTRIBUTED_NEXT_SHA) };
  const raws = { [taskSource.file]: rawTask, [nextSource.file]: rawNext };
  const attributedSamples = setShas(sampleBytes, attributedOf);
  const rawSamples = setShas(attributedSamples, raws);
  // Prove the future state changes exactly TWO forge-task and TWO forge-next hashes and nothing else.
  const shaPaths = T06_SAMPLE_SOURCES.flatMap(source => source.pointers.map(pointer => `${pointer}/source/sha256`));
  const rawSpans = jsonValueSpans(rawSamples), attributedSpans = jsonValueSpans(attributedSamples);
  assert.deepStrictEqual([...rawSpans.keys()], [...attributedSpans.keys()], 'same JSON structure');
  const changedScalars = [...attributedSpans].filter(([pointer, [a, b]]) => {
    const [c, d] = rawSpans.get(pointer); return attributedSamples.slice(a, b) !== rawSamples.slice(c, d);
  }).map(([pointer]) => pointer);
  assert.deepStrictEqual(changedScalars.sort(), [...shaPaths].sort(), 'future re-pin changes exactly the four actual source.sha256 values');
  const parsedRaw = JSON.parse(rawSamples);
  for (const source of T06_SAMPLE_SOURCES) {
    assert.strictEqual(source.pointers.filter(pointer => atPointer(parsedRaw, pointer).source.sha256 === raws[source.file]).length, 2,
      `future re-pin carries the raw hash on both ${source.file} nodes`);
  }
  const normalize = text => JSON.parse(withSampleShas(text, [...taskSource.pointers, ...nextSource.pointers].map(pointer => [pointer, 'x'])));
  assert.deepStrictEqual(normalize(rawSamples), normalize(sampleBytes), 'every other parsed field and text is preserved');
  const rawReadme = `${sampleReadme}\n${rawTask}\n${rawNext}\n`;
  const ok = (label, fixture, state) => { const got = checkSamples({ sourceBytes, ...fixture }); assert.strictEqual(got.state, state, label); return got; };
  ok('current attributed samples pass', { sampleBytes: attributedSamples }, 'attributed');
  ok('actual checked-in samples pass', {}, sampleState.state);
  const future = ok('genuine raw re-pin of all four task and next nodes passes', { sampleBytes: rawSamples, sampleReadme: rawReadme }, 'raw-repinned');
  assert.deepStrictEqual(future.repinnedNodes, { [taskSource.file]: 2, [nextSource.file]: 2 }, 'two forge-task and two forge-next nodes re-pinned');
  assert.deepStrictEqual([future.taskHash, future.nextHash], [rawTask, rawNext]);
  const stale = { [taskSource.file]: hash('stale forge-task revision'), [nextSource.file]: before.samples.next_samples[0].source.sha256 };
  const editAt = (text, pointer, fn) => { const [a, b] = jsonValueSpans(text).get(pointer); return text.slice(0, a) + fn(text.slice(a, b)) + text.slice(b); };
  for (const source of T06_SAMPLE_SOURCES) {
    const other = source === taskSource ? nextSource : taskSource;
    const name = source.file.split('/')[1];
    const both = value => setShas(rawSamples, { [source.file]: value });
    refused(`${name} wrong sample hash`, () => checkSamples({ sourceBytes, sampleBytes: both(wrong), sampleReadme: `${rawReadme}${wrong}\n` }));
    refused(`${name} stale sample hash`, () => checkSamples({ sourceBytes, sampleBytes: both(stale[source.file]), sampleReadme: `${rawReadme}${stale[source.file]}\n` }));
    refused(`${name} cites the other source hash`, () => checkSamples({ sourceBytes, sampleBytes: both(raws[other.file]), sampleReadme: rawReadme }));
    refused(`${name} only re-pinned (mixed sources)`, () => checkSamples({ sourceBytes, sampleBytes: setShas(attributedSamples, { [source.file]: raws[source.file] }),
      sampleReadme: rawReadme }));
    refused(`${name} inconsistent nodes`, () => checkSamples({ sourceBytes, sampleReadme: rawReadme,
      sampleBytes: withSampleShas(rawSamples, [[source.pointers[0], attributedOf[source.file]]]) }));
    const undocumentedSampleReadme = `${sampleReadme.split(raws[source.file]).join('')}\n${raws[other.file]}\n`;
    assert(!undocumentedSampleReadme.includes(raws[source.file]), `${name} negative fixture does not document its raw hash`);
    refused(`${name} undocumented re-pin`, () => checkSamples({ sourceBytes, sampleBytes: rawSamples,
      sampleReadme: undocumentedSampleReadme }));
    refused(`${name} cited text edit`, () => checkSamples({ sourceBytes, sampleReadme: rawReadme,
      sampleBytes: editAt(rawSamples, `${source.pointers[1]}/text`, literal => literal.replace(' ', '  ')) }));
    refused(`${name} source metadata edit`, () => checkSamples({ sourceBytes, sampleReadme: rawReadme,
      sampleBytes: editAt(rawSamples, `${source.pointers[0]}/source/reference`, literal => literal.replace('#', '#outra-')) }));
    refused(`${name} label edit`, () => checkSamples({ sourceBytes, sampleReadme: rawReadme,
      sampleBytes: editAt(rawSamples, `${source.pointers[0]}/label`, literal => `${literal.slice(0, -1)}-x"`) }));
    const edited = Buffer.concat([sourceBytes[source.file], Buffer.from('\nunrelated edit\n')]);
    const editedSources = { ...sourceBytes, [source.file]: edited };
    refused(`${name} edit outside the linked blocks with current pins`, () => checkSamples({ sourceBytes: editedSources, sampleBytes: rawSamples, sampleReadme: rawReadme }));
    refused(`${name} edit hidden by its own raw sample re-pin`, () => checkSamples({ sourceBytes: editedSources,
      sampleBytes: setShas(rawSamples, { [source.file]: hash(edited) }), sampleReadme: `${rawReadme}${hash(edited)}\n` }));
  }
  refused('unrelated sample byte edit', () => checkSamples({ sourceBytes, sampleBytes: rawSamples.replace('"entries"', '"entries" '), sampleReadme: rawReadme }));
  refused('unrelated node sha edit', () => checkSamples({ sourceBytes, sampleReadme: `${rawReadme}${wrong}\n`,
    sampleBytes: withSampleShas(rawSamples, [['/entries/1/supporting/timeline/before', wrong]]) }));
});

t06('review-budget-trio-and-transport-refusal', () => {
  const review = read('shared/forge-review.md'), dispatch = read('shared/forge-dispatch.md');
  const reviewBlock = linkedBlock(review, 'review-budget', 'review'), dispatchBlock = linkedBlock(dispatch, 'dispatch-budget', 'dispatch');
  for (const [label, block] of [['review', reviewBlock], ['dispatch', dispatchBlock]]) {
    includesAll(label, block, ['`--budget-owner`', '`--budget-task`', '`--budget-unit`', '`{cwd, task, unit}`', 'execute-task/{TASK_ID}', '`--budget-milestone`',
      'contexto inválido', '`milestone-time-invalid`', '`provider_called:false`', 'antes do provider', 'indisponibilidade de revisor', 'retry', 'fallback',
      '`worker-engine-fallback`', 'ask sem vínculo', 'contexto vazio', 'não tem a garantia do horizonte']);
    for (const code of timeAdmission.TRANSPORT_REFUSAL_CODES) assert(block.includes(`\`${code}\``), `${label}: refusal ${code}`);
  }
  includesAll('review', reviewBlock, ['nunca `{TASK_ID}-REVIEW.md` limpo nem', 'mínimo']);
  includesAll('dispatch', dispatchBlock, ['REVIEW limpo', 'bloco ligado de `BUDGET_ARGS` em `shared/forge-review.md`', 'não há segundo modelo de autorização']);
  assert.strictEqual(count(review, '"${BUDGET_ARGS[@]}"'), 7, 'the external legs still carry one shared context');
  assert(read('scripts/forge-xllm.js').includes("const budgetFlags = ['budget-owner', 'budget-milestone', 'budget-task', 'budget-unit'];"), 'adapter flag vocabulary');
  // The documented blocks, executed: milestone-only unchanged, unlinked empty, linked trio exact, mixed refused before any leg.
  const base = bashBlocks(review.slice(review.indexOf('Na revisão de task avulsa ele fica vazio'), review.indexOf('<!-- forge:linked-task:review-budget:start -->')))[0];
  const linked = bashBlocks(reviewBlock)[0];
  assert(base.includes('BUDGET_ARGS=()') && !base.includes('LINKED_TASK_ID'), 'milestone block stays the pre-T06 block');
  const args = env => runBash(`${base}\n${linked}\nprintf '%s\\n' "\${BUDGET_ARGS[@]}"`, { WORKING_DIR: '/owner', MILESTONE_ID: '', BUDGET_UNIT: '', LINKED_TASK_ID: '', ...env });
  const lines = result => result.stdout.split('\n').filter(Boolean);
  const unlinked = args({});
  assert.strictEqual(unlinked.status, 0); assert.deepStrictEqual(lines(unlinked), [], 'unlinked review keeps the empty context');
  const milestone = args({ MILESTONE_ID: 'M001', BUDGET_UNIT: 'complete-slice/S01' });
  assert.deepStrictEqual(lines(milestone), ['--budget-owner', '/owner', '--budget-milestone', 'M001', '--budget-unit', 'complete-slice/S01']);
  const task = args({ LINKED_TASK_ID: T06_TASK, BUDGET_UNIT: `execute-task/${T06_TASK}` });
  assert.deepStrictEqual(lines(task), ['--budget-owner', '/owner', '--budget-task', T06_TASK, '--budget-unit', `execute-task/${T06_TASK}`]);
  const mixed = args({ LINKED_TASK_ID: T06_TASK, MILESTONE_ID: 'M001', BUDGET_UNIT: `execute-task/${T06_TASK}` });
  assert.strictEqual(mixed.status, 2, 'mixed milestone and linked task context stops before any leg');
  assert.deepStrictEqual(lines(mixed), []);
});

t06('task-start-cli-boundary', () => {
  for (const [label, text] of t06Views('forge-task')) {
    const resume = linkedBlock(text, 'resume', label), close = linkedBlock(text, 'close', label);
    includesAll(label, resume, ['--status', '--start', '`--continue`', 'main(argv, io, liveAdapter)']);
    includesAll(`${label} close`, close, ['forge-linked-task-start.js" --close --cwd "$WORKING_DIR" --task "$TASK_ID" --code-dir "$CODE_DIR" --json',
      '`--close` roda por último', 'da extração de memória e de toda outra limpeza que usa provider', 'antes de arquivar ou apagar os artefatos da task',
      '`linked-task-delivery-unproven`', 'SUMMARY sozinho não encerra', 'não chama provider', 'nunca é removido pela task', '`worktree_cleanup_on_complete` não muda']);
    inOrder(`${label} close order`, text, ['<!-- forge:linked-task:review-legs:start -->', '**Memory extraction:**', '<!-- forge:linked-task:close:start -->',
      '**Cleanup task artifacts**', 'forge-isolation.js" --cleanup --run "$TASK_ID"']);
  }
  // The real T03 CLI entry without a live adapter refuses before any read or write, for every live action.
  const owner = t06Owner('start-cli');
  for (const action of ['--start', '--continue', '--close-chain']) {
    const result = inertMain(linkedStart.main, [action, '--cwd', owner, '--task', T06_TASK, '--json']);
    assert.deepStrictEqual([result.status, result.json.reason], [3, 'linked-task-authorization-required'], action);
  }
  const status = inertMain(linkedStart.main, ['--status', '--cwd', owner, '--task', T06_TASK, '--json']);
  assert.deepStrictEqual([status.status, status.json], [0, null], 'unlinked status reads no time state');
  assert(!fs.existsSync(path.join(owner, '.gsd', 'forge', 'time')), 'refusals wrote nothing');
});

t06('task-horizon-admission', () => {
  const units = ['`plan-slice/{TASK_ID}` no brainstorm', '`discuss-milestone/{TASK_ID}` no discuss', '`research-milestone/{TASK_ID}` no research',
    '`plan-milestone/{TASK_ID}` no plan', '`execute-task/{TASK_ID}` na execução'];
  for (const [label, text] of t06Views('forge-task')) {
    const block = linkedBlock(text, 'phase-admission', label);
    const caller = between(text, '### Canonical preparation caller', '### Step 1 — Brainstorm');
    assert(caller.includes(block), `${label}: admission rule lives in the caller used by every phase`);
    includesAll(label, block, [...units, 'antes de cada fase de preparação', 'antes da execução do Step 5',
      'forge-linked-task-horizon.js" --admit --cwd "$WORKING_DIR" --task "$TASK_ID" --unit "$LINKED_UNIT" --json', '[ "$LINKED_ADMIT_EXIT" -ne 0 ] && stop',
      'saída 3 para antes de qualquer provider', 'sem retry, fallback, outro candidato nem execução inline', 'O precheck só antecipa a mensagem',
      '`linked-task-budget-exhausted`', 'Teto de tempo da task ligada {TASK_ID} atingido', '`linked-task-budget-draining`', '`--inspect-drain`', '`--checkpoint`',
      'Checkpoint de tempo da task ligada {TASK_ID}', 'estender o horizonte da task ou encerrar a cadeia', '`linked-task:extend:<ms>`', '`prepareTaskExtension`',
      '`answerTaskExtension`', '`--extend --ceiling-ms <ms>`', '`liveAdapter.getDecisionHandle`', 'recusa com `linked-task-authorization-required`',
      'permissão permanente de routing nunca estendem', 'Nenhum saldo vira timeout de worker', 'Task sem vínculo não roda este bloco']);
    for (const unit of linkedHorizon.TASK_UNIT_TYPES) assert(block.includes(`\`${unit}/{TASK_ID}\``), `${label}: unit ${unit}`);
  }
  // The documented precheck, executed through the T04 CLI: an unlinked owner is admitted, a broken link stops before any provider.
  const script = bashBlocks(linkedBlock(skills['forge-task'], 'phase-admission'))[0];
  const run = (owner, env) => runBash(`${script}\necho continued`, { WORKING_DIR: owner.replace(/\\/g, '/'), TASK_ID: T06_TASK, LINKED_UNIT: `plan-slice/${T06_TASK}`, ...env });
  const free = t06Owner('admit');
  const skipped = run(free, { LINKED_MILESTONE: '' });
  assert.deepStrictEqual([skipped.status, skipped.stdout], [0, 'continued\n'], 'unlinked tasks skip the precheck');
  const admitted = run(free, { LINKED_MILESTONE: 'M001' });
  assert.strictEqual(admitted.status, 0, admitted.stderr);
  assert.deepStrictEqual(JSON.parse(admitted.stdout.split('\n')[0]), { allowed: true, decision: 'unlinked' });
  const broken = t06Owner('admit-broken');
  fs.mkdirSync(path.join(broken, '.gsd', 'forge', 'time-links'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.gsd', 'forge', 'time-links', `${T06_TASK}.json`), '{');
  const refused = run(broken, { LINKED_MILESTONE: 'M001' });
  assert.strictEqual(refused.status, 9, `exit 3 must stop: ${refused.stdout}`);
  const verdict = JSON.parse(refused.stdout.split('\n')[0]);
  assert.strictEqual(verdict.allowed, false);
  assert(linkedHorizon.LINKED_TASK_TRANSPORT_CODES.includes(verdict.reason_code), `typed refusal: ${verdict.reason_code}`);
  assert(!refused.stdout.includes('continued'), 'refused work must not continue');
  const extend = inertMain(linkedHorizon.main, ['--extend', '--ceiling-ms', '60000', '--cwd', free, '--task', T06_TASK, '--json']);
  assert.deepStrictEqual([extend.status, extend.json.reason], [3, 'linked-task-authorization-required'], 'standalone extension refuses');
});

t06('auto-positive-endpoint', () => {
  for (const [label, text] of t06Views('forge-auto')) {
    const block = linkedBlock(text, 'closure', label);
    inOrder(label, block, ['ACK real de `complete-milestone` pelo adaptador de loop', 'nunca são ACK nem endpoint',
      'node "$FORGE_SCRIPTS_DIR/forge-milestone-endpoint.js" --verify --cwd "$WORKING_DIR" --milestone "$RUN_ID" --json',
      'node "$FORGE_SCRIPTS_DIR/forge-milestone-endpoint.js" --record --cwd "$WORKING_DIR" --milestone "$RUN_ID" --json']);
    includesAll(label, block, ['verificação nova do código integrado', 'prova positiva', 'Recusa em 2, 3 ou 4 para a cadeia sem descongelar nada nem inventar prova']);
  }
  const usage = { stdout: { write() {} }, stderr: { write() {} } };
  assert.strictEqual(require('./forge-milestone-endpoint').main(['--record', '--json'], usage), 2, 'endpoint CLI refuses an incomplete call');
});

t06('auto-handoff-start-cleanup-order', () => {
  for (const [label, text] of t06Views('forge-auto')) {
    const block = linkedBlock(text, 'closure', label), order = linkedBlock(text, 'cleanup-order', label);
    inOrder(label, block, ['--record', 'node "$FORGE_SCRIPTS_DIR/forge-linked-task-start.js" --handoff --cwd "$WORKING_DIR" --milestone "$RUN_ID" --json',
      '`/forge-task --resume {T}` ANTES da limpeza de isolamento da milestone', 'roda a limpeza de isolamento da milestone']);
    includesAll(label, block, ['encerrar a cadeia (linked-task:close-chain)', 'adiada com motivo nomeado']);
    const finalReport = text.slice(text.indexOf('## Final Report (milestone complete)'));
    inOrder(`${label} final report`, finalReport, ['<!-- forge:linked-task:cleanup-order:start -->', '**Isolation cleanup**', 'forge-isolation.js" --cleanup --run']);
    includesAll(label, order, ['ou depois do encerramento explícito da cadeia', 'volta a ser elegível no início real']);
  }
});

t06('review-linked-budget-contract', () => {
  const block = linkedBlock(read('shared/forge-review.md'), 'review-budget', 'review');
  inOrder('review', block, ['`LINKED_TASK_ID`', 'BUDGET_UNIT=execute-task/{TASK_ID}', '`--budget-owner`, `--budget-task` e `--budget-unit`',
    'Rode este bloco\nlogo depois do bloco acima', 'BUDGET_ARGS=(--budget-owner "$WORKING_DIR" --budget-task "$LINKED_TASK_ID" --budget-unit "$BUDGET_UNIT")']);
  for (const [label, text] of t06Views('forge-task')) {
    includesAll(label, linkedBlock(text, 'review-legs', label), ['`LINKED_TASK_ID="$TASK_ID"`', '`BUDGET_UNIT="execute-task/$TASK_ID"`', '`MILESTONE_ID` vazio',
      'bloco ligado de `BUDGET_ARGS` de `shared/forge-review.md`', 'nunca `--budget-milestone`', 'não emite `review-agent-unavailable`',
      'não tem retry nem fallback para outro revisor ou família', 'não produz `{TASK_ID}-REVIEW.md` limpo nem mínimo', 'o contexto continua vazio']);
  }
  assert.strictEqual(timeAdmission.TRANSPORT_REFUSAL_CODES.length, 13, 'actual exported refusal vocabulary after T05');
});

t06('dispatch-linked-budget-contract', () => {
  const dispatch = read('shared/forge-dispatch.md');
  const block = linkedBlock(dispatch, 'dispatch-budget', 'dispatch');
  assert(dispatch.indexOf(block) > dispatch.indexOf('O sidecar de unidade (`forge-unit-sidecar --request`) rechecha'), 'linked rule extends the time guard paragraph');
  inOrder('dispatch', block, ['`standalone-task`', 'delegam ao horizonte da task', '`--budget-owner`, `--budget-task` e `--budget-unit`', 'não há segundo modelo de autorização',
    '`milestone-time-invalid` antes de qualquer transporte', 'Task sem vínculo continua com', 'é parada antes do provider com `provider_called:false`']);
  includesAll('dispatch', block, ['nunca retry, fallback de engine ou de revisor', 'nem REVIEW limpo', 'não demonstra execução nem compreensão no cliente instalado']);
});

t06('real-two-host-projection-tests', () => {
  const rendered = t06Projections();
  for (const name of ALL) {
    const source = skills[name];
    for (const [host, projected] of [['Claude', rendered.claude[name]], ['Codex', rendered.codex[name]]]) {
      const blocks = [...projected.matchAll(LINKED_BLOCK_RE)].map(match => match[0]);
      assert.deepStrictEqual(blocks, [...source.matchAll(LINKED_BLOCK_RE)].map(match => match[0]), `${name} ${host}: the rendered projection carries exactly the source linked blocks`);
      assert.deepStrictEqual(blocks.map(block => /forge:linked-task:([a-z0-9-]+):start/.exec(block)[1]), [...(T06_BLOCKS[name] || [])], `${name} ${host}: block inventory`);
    }
    assert(rendered.codex[name].startsWith('---') || rendered.codex[name].startsWith('<!-- forge-source:codex -->'), `${name}: Codex render, not a copy`);
    assert(rendered.codex[name].includes('<!-- forge-source:codex -->'), `${name}: Codex origin marker`);
  }
  // The retained T01 phase literal checks of this suite still run against the real projections.
  for (const name of TIME_SKILLS) assertTimeSkill(`${name} (Codex, T06)`, rendered.codex[name]);
  console.log('note - T06 distribution only: Claude and Codex renders carry the linked text; client execution, comprehension, installation and human acceptance remain unknown.');
});

// ── #341 (M-20261106040502-review-fix-limites S01/T05): measured distribution delta ──
// The delta's before values must be the versioned historical ones and its after values the
// current measurement; the six other surfaces, the historical goldens and every captured byte
// outside the delta stay as they were. In-memory variants only: no pin or fixture is written.
test('#341 distribution delta: versioned before, measured after, untouched surfaces byte-identical, out-of-delta edits refused', () => {
  const delta = delta341;
  assert.strictEqual(delta.kind, 'issue-341-measured-distribution-delta');
  assert.strictEqual(delta.provenance.base_revision, '563ac2752722ac7c29848f62520c8446185bc15c');
  assert.strictEqual(delta.provenance.not_post_change_ci, true);
  for (const key of ['before_policy', 'after_policy', 'render_method', 'attributed_method']) assert(delta.provenance[key], `provenance ${key}`);
  const renderer = require('./forge-claude-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-341-pins-')); temps.push(temp);
  const artifacts = renderer.render({ repo: root, projectRoot: temp, claudeHome: path.join(temp, 'host'), forgeHome: path.join(temp, 'forge') }).artifacts;

  // Surfaces: exactly agents, skills and configuration move; the other six keep the pre-#341 pin and render.
  assert.deepStrictEqual(Object.keys(delta.surfaces).sort(), ['agents', 'configuration', 'skills']);
  assert.deepStrictEqual([...Object.keys(delta.surfaces), ...delta.unchanged_surfaces].sort(), golden.surfaces.map(row => row.source_id).sort());
  for (const row of golden.surfaces) {
    const raw = surfaceHash(artifacts, row.source_id, true);
    assert.strictEqual(row.sha256, raw, `active pin ${row.source_id} is the measured render`);
    const declared = deltaRow(delta, 'surfaces', row.source_id);
    if (!declared) {
      assert.strictEqual(row.sha256, entry347After('surfaces', row.source_id, T06_ATTRIBUTED_PINS[row.source_id]), `${row.source_id}: pre-#341 pin followed by the measured #347 layer`);
      continue;
    }
    assert.strictEqual(entry347After('surfaces', row.source_id, declared.after), raw, `${row.source_id}: #341 intermediate after followed by the measured #347 layer`);
    assert.strictEqual(surfaceHash(artifacts, row.source_id, false), attributedNow('surfaces', row.source_id, T06_ATTRIBUTED_PINS[row.source_id]),
      `${row.source_id}: measured attributed after, before is the T06 value`);
    assert.notStrictEqual(declared.before, declared.after, `${row.source_id} really moved`);
    assert(pinReadme.includes(declared.before) && pinReadme.includes(declared.after), `${row.source_id} before/after documented`);
    for (const member of declared.members) {
      assert(delta.declared_paths.includes(member), `${member} is a declared #341 path`);
      assert(artifacts.some(item => item.source_id === row.source_id && item.source === member), `${member} renders into ${row.source_id}`);
    }
  }
  for (const historical of before.historical_goldens) assert.strictEqual(hash(fs.readFileSync(path.join(root, historical.path))), historical.sha256, historical.path);

  // Files: before is the capture (attributed for the T06 skills), after is the measured current bytes.
  const captured = new Map(before.sources.map(row => [row.path, row.sha256]));
  const s02Allowed = ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md'];
  assert.deepStrictEqual(Object.keys(delta.files).sort(), [...delta.declared_paths].sort());
  for (const [file, row] of Object.entries(delta.files)) {
    assert.strictEqual(hash(fs.readFileSync(path.join(root, file))), entry347After('files', file, row.after), `${file}: #341 intermediate after followed by the measured #347 layer`);
    if (captured.has(file) && !s02Allowed.includes(file)) assert.strictEqual(captured.get(file), row.attributed_before || row.before, `${file}: before is the capture`);
    if (row.attributed_after) assert.strictEqual(hash(attributedBytes(file)), entry347After('files', file, row.attributed_after, ENTRY_347, true), `${file}: #341 attributed intermediate followed by #347`);
  }
  assert.strictEqual(delta.files['skills/forge-task/SKILL.md'].attributed_before, T06_ATTRIBUTED_TASK_SHA);
  assert.strictEqual(delta.files['skills/forge-next/SKILL.md'].attributed_before, T06_ATTRIBUTED_NEXT_SHA);

  // Samples: exactly the four actual nodes, citing the measured raw bytes, documented before/after.
  assert.strictEqual(delta.samples.file, before.samples.file);
  assert.deepStrictEqual(delta.samples.nodes.map(node => node.pointer).sort(), T06_SAMPLE_SOURCES.flatMap(source => source.pointers).sort());
  for (const node of delta.samples.nodes) {
    assert.strictEqual(atPointer(samples, node.pointer).source.sha256, node.after, `${node.pointer} cites the measured after`);
    assert.strictEqual(node.after, delta.files[node.file].after, `${node.pointer}: after is the raw ${node.file}`);
    assert.strictEqual(node.before, delta.files[node.file].before, `${node.pointer}: before is the base raw ${node.file}`);
    assert(sampleReadme.includes(node.before) && sampleReadme.includes(node.after), `${node.pointer} documented`);
  }

  // The real state passes every layered historical check.
  checkPins({ artifacts }); checkSamples(); checkRegistry();

  // Negative fixtures: edits outside the delta, wrong or undeclared pins and undocumented re-pins are refused.
  const refused = (label, fn) => assert.throws(fn, error => error instanceof assert.AssertionError, `${label} must be refused`);
  const variant = mutate => { const copy = JSON.parse(JSON.stringify(delta)); mutate(copy); return copy; };
  const readRaw = rel => fs.readFileSync(path.join(root, rel));
  const edited = target => rel => (rel === target ? Buffer.concat([readRaw(rel), Buffer.from('\nedit outside the measured delta\n')]) : readRaw(rel));
  const wrong = hash('not a measured #341 value');
  refused('captured source edit outside the delta', () => checkPins({ artifacts, readSource: edited('commands/forge.md') }));
  refused('declared path edited after its measurement', () => checkPins({ artifacts, readSource: edited('agents/forge-reviewer.md') }));
  refused('untouched surface edit', () => checkPins({ artifacts: artifacts.map(item => item.source_id === 'hooks' ? { ...item, content: `${item.content}\n// edit\n` } : item) }));
  refused('wrong active pin', () => checkPins({ artifacts, golden: { ...golden, surfaces: golden.surfaces.map(row => row.source_id === 'agents' ? { ...row, sha256: wrong } : row) },
    pinReadme: `${pinReadme}\n${wrong}\n` }));
  refused('bad delta before pin', () => checkPins({ artifacts, delta: variant(copy => { copy.surfaces.configuration.before = wrong; }) }));
  refused('bad delta file before', () => checkPins({ artifacts, delta: variant(copy => { copy.files['forge-prefs.schema.json'].before = wrong; }) }));
  refused('undeclared re-pin (surface missing from the delta)', () => checkPins({ artifacts, delta: variant(copy => { delete copy.surfaces.configuration; }) }));
  refused('extra surface claimed by the delta', () => checkPins({ artifacts, delta: variant(copy => { copy.surfaces.hooks = { before: T06_ATTRIBUTED_PINS.hooks, after: wrong }; }) }));
  refused('undocumented re-pin', () => checkPins({ artifacts, pinReadme: pinReadme.split(delta.surfaces.configuration.after).join('') }));
  refused('wrong sample after', () => checkSamples({ delta: variant(copy => { copy.samples.nodes[0].after = wrong; }) }));
  refused('undocumented sample re-pin', () => checkSamples({ sampleReadme: sampleReadme.split(delta.files['skills/forge-task/SKILL.md'].after).join('') }));
  refused('registry count changed', () => checkRegistry({ delta: variant(copy => { copy.registry.count = 249; }) }));
  refused('fabricated registry drift', () => checkRegistry({ delta: variant(copy => { copy.registry.drifted_rows = [{ after_id: before.dispatch_registry.rows[0].id }]; }) }));
  console.log('note - #341 distribution only: agents, skills and configuration re-pinned to measured values; client execution, CI, installation and human acceptance remain unknown.');
});


test('#347 distribution delta: exact chain, members and tamper refusals', () => {
  const renderer = require('./forge-claude-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-347-pins-')); temps.push(temp);
  const artifacts = renderer.render({ repo: root, projectRoot: temp, claudeHome: path.join(temp, 'host'), forgeHome: path.join(temp, 'forge') }).artifacts;
  checkPins({ artifacts });
  for (const [id, members] of Object.entries(ENTRY_347_MEMBERS)) {
    for (const member of members) assert(artifacts.some(item => item.source_id === id && item.source === member), '#347 member rendered: ' + member);
    if (id === 'agents') assert(!members.includes('agents/forge-memory.md'), '#347 memory remains outside the change');
  }
  const wrong = hash('not a measured #347 value');
  const variant = mutate => { const copy = JSON.parse(JSON.stringify(ENTRY_347)); mutate(copy); return copy; };
  const refused = (label, fixture) => assert.throws(() => checkPins({ artifacts, ...fixture }), error => error instanceof assert.AssertionError, '#347 ' + label + ' must be refused');
  refused('foreign before', { entryDelta: variant(d => { d.surfaces.agents.before = wrong; }) });
  refused('coherent invented after', { entryDelta: variant(d => { d.surfaces.agents.after = wrong; d.surfaces.agents.attributed_after = wrong; }) });
  refused('extra surface', { entryDelta: variant(d => { d.surfaces.commands = { ...d.surfaces.agents }; }) });
  refused('omitted surface', { entryDelta: variant(d => { delete d.surfaces.hooks; }) });
  refused('extra file', { entryDelta: variant(d => { d.files['commands/forge.md'] = { ...d.files[ENTRY_347_FILES[0]] }; }) });
  refused('omitted file', { entryDelta: variant(d => { delete d.files[ENTRY_347_FILES[0]]; }) });
  refused('extra rendered member', { artifacts: [...artifacts, { ...artifacts.find(item => item.source_id === 'agents'), source: 'agents/foreign.md' }] });
  refused('omitted rendered member', { artifacts: artifacts.filter(item => item.source !== ENTRY_347_MEMBERS.agents[0]) });
  refused('wrong file before', { entryDelta: variant(d => { d.files[ENTRY_347_FILES[0]].before = wrong; }) });
  refused('invented file after', { entryDelta: variant(d => { d.files[ENTRY_347_FILES[0]].after = wrong; d.files[ENTRY_347_FILES[0]].attributed_after = wrong; }) });
  refused('file edited after measurement', { readSource: rel => { const raw = fs.readFileSync(path.join(root, rel)); return rel === ENTRY_347_FILES[0] ? Buffer.concat([raw, Buffer.from('\nforeign edit\n')]) : raw; } });
  refused('wrong active pin', { golden: { ...golden, surfaces: golden.surfaces.map(row => row.source_id === 'agents' ? { ...row, sha256: wrong } : row) } });
  refused('undocumented current pin', { pinReadme: pinReadme.split(ENTRY_347.surfaces.agents.after).join('') });
  refused('undocumented intermediate pin', { pinReadme: pinReadme.split(ENTRY_347.surfaces.agents.before).join('') });
});

for (const temp of temps) fs.rmSync(temp, { recursive: true, force: true });

console.log('');
console.log(`forge-communication-surfaces: ${passed} passed, ${failed} failed`);
console.log('Distribution proof only: host rendering, comprehension and human acceptance remain pending for the final round.');
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.error}`);
  process.exit(1);
}
