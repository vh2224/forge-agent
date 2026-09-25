'use strict';

// Tests for the grouped-member refusal in writeFragment and the recoverable
// quarantine that holds the refused fact.
//
// Every test is isolated in test(name, fn) with its own try/catch: this suite
// must never abort on the first failed assert, because a single revert control
// run has to show WHICH assertions the refusal owns, not just the first one.
//
// The store used here is a synthetic tmp fixture with a hand-built container
// (serializeGroup, the mould from forge-memory-grouped.test.js). It is
// synthetic on purpose: this repo's live store has zero containers, so the
// damage class cannot be exercised against it.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { serializeGroup } = require('./forge-grouped-file');
const memory = require('./forge-memory');
const quarantine = require('./forge-memory-quarantine');

let passed = 0;
let failed = 0;
const failures = [];
const MILESTONE = 'M-20260818225600-defeitos-forge-achados';

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
  }
}

function fact(memId, text) {
  return { mem_id: memId, category: 'test', text, source: 'quarantine-test' };
}

function storageKey(unitId, milestoneId) {
  return memory.qualifiedStorageKey(unitId, milestoneId);
}

// Builds a store where S01 lives ONLY inside a container (loose file removed).
function fixtureGrouped() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-quarantine-'));
  fs.mkdirSync(memory.memoryDir(cwd), { recursive: true });
  memory.writeFragment(
    cwd,
    { unit_id: 'S01', facts: [fact('MEM001', 'sealed fact')], stats: [] },
    { milestoneId: MILESTONE }
  );
  const loose = memory.fragmentPath(cwd, 'S01', { milestoneId: MILESTONE });
  const units = [{ id: storageKey('S01', MILESTONE), content: fs.readFileSync(loose) }];
  const container = path.join(memory.memoryDir(cwd), 'sweep-project-01.md');
  fs.writeFileSync(container, serializeGroup({ epoch: 'sweep-project-01', units }).buffer);
  fs.unlinkSync(loose);
  return { cwd, container };
}

function captureStderr(fn) {
  let output = '';
  const original = process.stderr.write;
  process.stderr.write = value => {
    output += String(value);
    return true;
  };
  try {
    return { result: fn(), output };
  } finally {
    process.stderr.write = original;
  }
}

function mdSnapshot(cwd) {
  const dir = memory.memoryDir(cwd);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => `${entry.name}:${fs.readFileSync(path.join(dir, entry.name)).toString('base64')}`)
    .sort();
}

console.log('\nforge-memory-quarantine tests\n');

// ── IN-12: the refusal itself ────────────────────────────────────────────────

test('refusal: no loose file is born beside the container', () => {
  const { cwd } = fixtureGrouped();
  const before = fs.readdirSync(memory.memoryDir(cwd)).filter(n => n.endsWith('.md')).sort();
  captureStderr(() => memory.writeFragment(
    cwd,
    { unit_id: 'S01', facts: [fact('MEM002', 'late write')], stats: [] },
    { milestoneId: MILESTONE }
  ));
  const after = fs.readdirSync(memory.memoryDir(cwd)).filter(n => n.endsWith('.md')).sort();
  assert.deepStrictEqual(after, before, 'no .md file may appear on a refused write');
  assert.ok(
    !fs.existsSync(memory.fragmentPath(cwd, 'S01', { milestoneId: MILESTONE })),
    'the loose fragment must not exist'
  );
});

test('refusal: returns quarantined/reason/created and points at container + remedy', () => {
  const { cwd, container } = fixtureGrouped();
  const { result } = captureStderr(() => memory.writeFragment(
    cwd,
    { unit_id: 'S01', facts: [fact('MEM002', 'late write')], stats: [] },
    { milestoneId: MILESTONE }
  ));
  assert.strictEqual(result.quarantined, true);
  assert.strictEqual(result.reason, 'grouped-member');
  assert.strictEqual(result.created, false);
  assert.strictEqual(
    fs.realpathSync(result.container),
    fs.realpathSync(container),
    'container must name the physical container file'
  );
  assert.ok(/--undo/.test(result.remedy), 'remedy must name the undo step');
  assert.ok(/reagrupar/.test(result.remedy), 'remedy must name the re-group step');
});

test('refusal: emits a loud named warning on stderr', () => {
  const { cwd } = fixtureGrouped();
  const { output } = captureStderr(() => memory.writeFragment(
    cwd,
    { unit_id: 'S01', facts: [fact('MEM002', 'late write')], stats: [] },
    { milestoneId: MILESTONE }
  ));
  assert.ok(/\[forge-memory\] recusa:/.test(output), `expected refusal warning, got: ${output}`);
  assert.ok(output.includes(storageKey('S01', MILESTONE)), 'warning must name the storage key');
  assert.ok(/quarentena:/.test(output), 'warning must point at the quarantine file');
});

// ── D3 / IN-14: the fact survives intact and is re-injectable ────────────────

test('quarantine: fragment field deep-equals the exact payload handed in', () => {
  const { cwd } = fixtureGrouped();
  const payload = {
    unit_id: 'S01',
    facts: [fact('MEM002', 'late write')],
    stats: [{ kind: 'x', mem_id: 'MEM002', ts: '2026-08-18T00:00:00Z' }],
    body: 'corpo livre',
  };
  const { result } = captureStderr(() => memory.writeFragment(cwd, payload, { milestoneId: MILESTONE }));
  const record = JSON.parse(fs.readFileSync(result.path, 'utf8'));
  assert.deepStrictEqual(record.fragment, payload, 'quarantined payload must be byte-equal in value');
  assert.strictEqual(record.storage_key, storageKey('S01', MILESTONE));
  assert.strictEqual(record.reason, 'grouped-member');
  assert.ok(record.refused_at, 'refused_at must be recorded');
});

test('quarantine: payload round-trips back through --write once ungrouped', () => {
  const { cwd } = fixtureGrouped();
  const payload = { unit_id: 'S01', facts: [fact('MEM002', 'late write')], stats: [] };
  const { result } = captureStderr(() => memory.writeFragment(cwd, payload, { milestoneId: MILESTONE }));
  const record = JSON.parse(fs.readFileSync(result.path, 'utf8'));

  // Simulate the remedy: the container is undone (here: removed), so the unit's
  // canonical envelope is loose again and the parked payload is re-injectable
  // mechanically — no hand editing of the JSON.
  fs.unlinkSync(path.join(memory.memoryDir(cwd), 'sweep-project-01.md'));
  const run = spawnSync(
    process.execPath,
    [path.join(__dirname, 'forge-memory.js'), '--write', '--milestone', MILESTONE, '--cwd', cwd],
    { input: JSON.stringify(record.fragment), encoding: 'utf8' }
  );
  assert.strictEqual(run.status, 0, `--write should succeed: ${run.stderr}`);
  const written = JSON.parse(run.stdout);
  assert.strictEqual(written.created, true, 'the re-injected fact must land as a real write');
  const back = memory.readFragment(cwd, 'S01', { milestoneId: MILESTONE });
  assert.ok(
    back.facts.some(item => item.mem_id === 'MEM002'),
    'the re-injected fact must be readable from the store'
  );
});

test('quarantine: listQuarantine reports entries and an unreadable one by name', () => {
  const { cwd } = fixtureGrouped();
  captureStderr(() => memory.writeFragment(
    cwd,
    { unit_id: 'S01', facts: [fact('MEM002', 'late write')], stats: [] },
    { milestoneId: MILESTONE }
  ));
  fs.writeFileSync(path.join(quarantine.quarantineDir(cwd), 'broken~20260818T000000Z.json'), '{not json');
  const listed = quarantine.listQuarantine(cwd);
  assert.strictEqual(listed.length, 2, 'both the good and the broken entry must be reported');
  assert.strictEqual(listed.filter(e => e.unreadable === true).length, 1, 'never drop unreadable silently');
  assert.strictEqual(listed.filter(e => e.reason === 'grouped-member').length, 1);
});

test('quarantine: two refusals in the same stamp do not overwrite each other', () => {
  const { cwd } = fixtureGrouped();
  const first = captureStderr(() => memory.writeFragment(
    cwd, { unit_id: 'S01', facts: [fact('MEM002', 'a')], stats: [] }, { milestoneId: MILESTONE }
  )).result;
  const second = captureStderr(() => memory.writeFragment(
    cwd, { unit_id: 'S01', facts: [fact('MEM003', 'b')], stats: [] }, { milestoneId: MILESTONE }
  )).result;
  assert.notStrictEqual(first.path, second.path, 'a collision must be suffixed, never clobbered');
  assert.strictEqual(quarantine.listQuarantine(cwd).length, 2);
});

// ── IN-14: the hot caller never breaks ───────────────────────────────────────

test('CLI --write exits 0 with quarantined:true JSON on stdout', () => {
  const { cwd, container } = fixtureGrouped();
  const run = spawnSync(
    process.execPath,
    [path.join(__dirname, 'forge-memory.js'), '--write', '--milestone', MILESTONE, '--cwd', cwd],
    { input: JSON.stringify({ unit_id: 'S01', facts: [fact('MEM002', 'late')], stats: [] }), encoding: 'utf8' }
  );
  assert.strictEqual(run.status, 0, `hot path must not break: ${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.strictEqual(out.quarantined, true);
  assert.strictEqual(out.reason, 'grouped-member');
  assert.strictEqual(fs.realpathSync(out.container), fs.realpathSync(container));
  assert.ok(out.remedy, 'remedy must reach the CLI consumer');
  assert.ok(/recusa:/.test(run.stderr), 'the warning must reach stderr of the subprocess');
});

// ── loose-wins is untouched, and no broad catch was introduced ───────────────

test('loose file wins: a same-keyed container does not trigger the refusal', () => {
  const { cwd } = fixtureGrouped();
  // Re-create the loose fragment for the very unit that is inside the container.
  const { result: seeded } = captureStderr(() => {
    fs.writeFileSync(
      memory.fragmentPath(cwd, 'S01', { milestoneId: MILESTONE }),
      `---\nunit_id: S01\nmilestone_id: ${MILESTONE}\nfacts: []\nstats: []\n---\n`
    );
    return memory.writeFragment(
      cwd,
      { unit_id: 'S01', facts: [fact('MEM002', 'ordinary merge')], stats: [] },
      { milestoneId: MILESTONE }
    );
  });
  assert.strictEqual(seeded.quarantined, undefined, 'the loose path must stay exactly as it was');
  assert.strictEqual(seeded.created, true);
  assert.strictEqual(
    fs.realpathSync(seeded.path),
    fs.realpathSync(memory.fragmentPath(cwd, 'S01', { milestoneId: MILESTONE })),
    'path must point at the loose fragment'
  );
});

test('happy path untouched: a unit with no container writes normally', () => {
  const { cwd } = fixtureGrouped();
  const result = memory.writeFragment(
    cwd,
    { unit_id: 'T09', facts: [fact('MEM004', 'fresh unit')], stats: [] },
    { milestoneId: MILESTONE }
  );
  assert.strictEqual(result.quarantined, undefined);
  assert.strictEqual(result.created, true);
  assert.ok(fs.existsSync(result.path));
  // Idempotent second write still reports created:false, not quarantined.
  const again = memory.writeFragment(
    cwd,
    { unit_id: 'T09', facts: [fact('MEM004', 'fresh unit')], stats: [] },
    { milestoneId: MILESTONE }
  );
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.quarantined, undefined);
});

test('no broad catch: an invalid unit_id still throws', () => {
  const { cwd } = fixtureGrouped();
  assert.throws(
    () => memory.writeFragment(cwd, { unit_id: 'not a valid id!!', facts: [] }, {}),
    /Invalid memory unit ID/
  );
  assert.throws(
    () => memory.writeFragment(cwd, { facts: [] }, {}),
    /unit_id is required/
  );
});

test('bare key does not match a qualified member (mirrors readFragment lookup)', () => {
  const { cwd } = fixtureGrouped();
  // `S01` without --milestone resolves to a different storage key than
  // `<MILESTONE>__S01`, so the container member must NOT be found.
  const member = memory._private.detectGroupedMember(cwd, storageKey('S01', null), {});
  assert.strictEqual(member, null, 'a bare key must never match a qualified member');
  const qualified = memory._private.detectGroupedMember(cwd, storageKey('S01', MILESTONE), { milestoneId: MILESTONE });
  assert.ok(qualified && qualified.grouped === true, 'the qualified key must match');
});

// ── nothing reaches the store; the quarantine is invisible to it ─────────────

test('refused write leaves every .md in .gsd/memory byte-identical', () => {
  const { cwd } = fixtureGrouped();
  const before = mdSnapshot(cwd);
  captureStderr(() => memory.writeFragment(
    cwd,
    { unit_id: 'S01', facts: [fact('MEM002', 'late write')], stats: [] },
    { milestoneId: MILESTONE }
  ));
  assert.deepStrictEqual(mdSnapshot(cwd), before, 'no .md may be born or changed by a refusal');
});

test('quarantine is invisible to listFragments (subdir is never a fragment)', () => {
  const { cwd } = fixtureGrouped();
  const before = memory.listFragments(cwd).map(e => e.storageKey).sort();
  captureStderr(() => memory.writeFragment(
    cwd,
    { unit_id: 'S01', facts: [fact('MEM002', 'late write')], stats: [] },
    { milestoneId: MILESTONE }
  ));
  const after = memory.listFragments(cwd);
  assert.deepStrictEqual(after.map(e => e.storageKey).sort(), before, 'the store view must not change');
  assert.ok(
    // Compare the parent directory, not a substring: the tmp fixture root is
    // itself named `forge-memory-quarantine-…`, so a substring test passes for
    // the wrong reason (measured — it failed here first).
    after.every(entry => path.basename(path.dirname(entry.path)) !== quarantine.QUARANTINE_DIRNAME),
    'no listed fragment may live under quarantine/'
  );
  assert.ok(
    fs.existsSync(quarantine.quarantineDir(cwd)),
    'the quarantine directory does exist — invisibility is by filter, not by absence'
  );
});

test('refused write takes no lock and creates no store directory when absent', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-quarantine-nolock-'));
  fs.mkdirSync(memory.memoryDir(cwd), { recursive: true });
  memory.writeFragment(cwd, { unit_id: 'S01', facts: [fact('MEM001', 'x')], stats: [] }, { milestoneId: MILESTONE });
  const loose = memory.fragmentPath(cwd, 'S01', { milestoneId: MILESTONE });
  const units = [{ id: storageKey('S01', MILESTONE), content: fs.readFileSync(loose) }];
  fs.writeFileSync(
    path.join(memory.memoryDir(cwd), 'sweep-project-01.md'),
    serializeGroup({ epoch: 'sweep-project-01', units }).buffer
  );
  fs.unlinkSync(loose);
  const lockDir = path.join(memory.memoryDir(cwd), '.locks');
  if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });

  captureStderr(() => memory.writeFragment(
    cwd,
    { unit_id: 'S01', facts: [fact('MEM002', 'late')], stats: [] },
    { milestoneId: MILESTONE }
  ));
  assert.ok(!fs.existsSync(lockDir), 'a refused write must not acquire a fragment lock');
});


// ── R1/R2/R3: itens concedidos do review de S03 ──────────────────────────────

test('R1: um interloper que nasce ENTRE a checagem e a escrita não é sobrescrito', () => {
  // O defeito é a janela TOCTOU: existsSync observa ausência, e o arquivo nasce
  // antes do writeFileSync. Aqui a janela é forçada de forma determinística —
  // o interloper é criado de dentro do próprio writeFileSync interceptado.
  // Com `wx` o FS arbitra (EEXIST -> sufixo); sem flag, o fato é perdido.
  const { cwd } = fixtureGrouped();
  const original = fs.writeFileSync;
  let armed = true;
  const seen = [];
  fs.writeFileSync = function patched(target, data, options) {
    if (armed && typeof target === 'string' && target.endsWith('.json')) {
      armed = false;
      original(target, 'PRIMEIRO FATO', 'utf8'); // o outro processo chegou antes
      seen.push(target);
    }
    return original(target, data, options);
  };
  let result;
  try {
    result = captureStderr(() => memory.writeFragment(
      cwd, { unit_id: 'S01', facts: [fact('MEM002', 'segundo')], stats: [] }, { milestoneId: MILESTONE }
    )).result;
  } finally {
    fs.writeFileSync = original;
  }
  assert.strictEqual(seen.length, 1, 'a janela precisa ter sido de fato forçada uma vez');
  assert.strictEqual(
    fs.readFileSync(seen[0], 'utf8'), 'PRIMEIRO FATO',
    'o fato do outro processo não pode ser sobrescrito'
  );
  assert.notStrictEqual(result.path, seen[0], 'o perdedor da corrida tem que receber outro nome');
  assert.strictEqual(
    JSON.parse(fs.readFileSync(result.path, 'utf8')).fragment.facts[0].mem_id, 'MEM002',
    'e o próprio fato tem que estar parqueado inteiro'
  );
  assert.strictEqual(quarantine.listQuarantine(cwd).length, 2, 'os dois fatos sobrevivem');
});

test('R1: estourar o teto de colisões falha de forma nomeada — nunca sobrescreve nem devolve sucesso', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-quarantine-cap-'));
  const dir = quarantine.quarantineDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = '20260818T000001Z';
  const cap = quarantine._private.MAX_COLLISION_SUFFIX;
  assert.ok(Number.isInteger(cap) && cap > 0, 'o teto precisa ser nomeado e numérico');
  for (let n = 1; n <= cap; n += 1) {
    fs.writeFileSync(path.join(dir, n === 1 ? `K~${stamp}.json` : `K~${stamp}~${n}.json`), `ocupado ${n}`);
  }
  assert.throws(
    () => quarantine._private.writeExclusive(dir, 'K', stamp, 'novo'),
    /colis/,
    'o estouro do teto tem que falhar por nome'
  );
  assert.strictEqual(fs.readFileSync(path.join(dir, `K~${stamp}.json`), 'utf8'), 'ocupado 1');
});

test('R2: conteúdo do arquivo não pode forjar path/unreadable', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-quarantine-forge-'));
  const dir = quarantine.quarantineDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const evil = path.join(dir, 'evil~20260818T000000Z.json');
  fs.writeFileSync(evil, JSON.stringify({ path: null, unreadable: true, reason: 'x' }));
  const [entry] = quarantine.listQuarantine(cwd);
  assert.strictEqual(entry.path, evil, 'path é campo confiável — o arquivo não o define');
  assert.strictEqual(entry.unreadable, false, 'unreadable é campo confiável — o arquivo não o define');
});

test('R2: registro de forma inesperada vira unreadable em vez de ser propagado', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-quarantine-shape-'));
  const dir = quarantine.quarantineDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a~20260818T000000Z.json'), '[1,2,3]');
  fs.writeFileSync(path.join(dir, 'b~20260818T000000Z.json'), '"texto"');
  fs.writeFileSync(path.join(dir, 'c~20260818T000000Z.json'), 'null');
  const listed = quarantine.listQuarantine(cwd);
  assert.strictEqual(listed.length, 3);
  assert.strictEqual(listed.filter(e => e.unreadable === true).length, 3, 'forma inesperada é ilegível, não registro válido');
  assert.ok(listed.every(e => typeof e.path === 'string'), 'todo registro precisa de path utilizável');
});

test('R3: falha de leitura do diretório relança — só ENOENT vira lista vazia', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-quarantine-enoent-'));
  assert.deepStrictEqual(quarantine.listQuarantine(missing), [], 'diretório ausente é o vazio ordinário');

  // ENOTDIR: o caminho da quarentena é um arquivo comum — não é vazio, é
  // "não consegui ler"; um falso limpo aqui é exatamente o defeito.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-quarantine-enotdir-'));
  const dir = quarantine.quarantineDir(cwd);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, 'não sou um diretório');
  assert.throws(
    () => quarantine.listQuarantine(cwd),
    error => error && error.code !== 'ENOENT',
    'erro de leitura tem que subir, nunca virar lista vazia'
  );
});

test('extraction identity makes grouped quarantine replay idempotent and conflict-visible', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-quarantine-replay-'));
  const fragment = { unit_id: 'T01', facts: [fact('MEM001', 'stable')], stats: [] };
  const info = {
    storageKey: 'M001__T01',
    unitId: 'T01',
    milestoneId: 'M001',
    container: path.join(cwd, 'container.md'),
    reason: 'grouped-member',
    remedy: 'undo and regroup',
    extractionId: 'extract-stable',
    extractedAt: '2026-09-24T22:30:00.000Z',
  };
  const first = quarantine.quarantineFragment(cwd, fragment, info);
  const replay = quarantine.quarantineFragment(cwd, fragment, info);
  assert.strictEqual(first.replayed, false);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.path, first.path);
  assert.strictEqual(quarantine.listQuarantine(cwd).length, 1);
  assert.throws(
    () => quarantine.quarantineFragment(cwd, {
      ...fragment,
      facts: [fact('MEM001', 'changed')],
    }, info),
    error => error && error.code === 'MEMORY_QUARANTINE_CONFLICT',
  );
  assert.strictEqual(quarantine.listQuarantine(cwd).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failures.length) {
  for (const { name, error } of failures) {
    console.log(`✗ ${name}\n  ${error && error.message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
