#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const renderer = require('./forge-claude-renderer');

const repo = path.resolve(__dirname, '..');
const dirs = [];
function temp(label) { const value = fs.mkdtempSync(path.join(os.tmpdir(), `forge-claude-${label}-`)); dirs.push(value); return value; }
function fixtureRepo() {
  const root = temp('repo');
  for (const file of ['CLAUDE.md', 'scripts/forge-hook.js', 'shared/forge-mcps.md', 'shared/templates/claude/settings.jsonc', 'forge-capabilities.json', 'forge-prefs.schema.json']) {
    const source = path.join(repo, file);
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  for (const directory of ['agents', 'commands', 'skills', 'shared/templates/dispatch']) {
    fs.cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
  }
  fs.copyFileSync(path.join(repo, 'forge-source-manifest.json'), path.join(root, 'forge-source-manifest.json'));
  return root;
}
function manifestFor(root) { return JSON.parse(fs.readFileSync(path.join(root, 'forge-source-manifest.json'), 'utf8')); }
// Sources are checked out with native newlines; the renderer emits LF, so the
// comparison has to normalize before asking whether a fence opens the file.
function normalize(value) { return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }
function markers(value) { return (String(value).match(/^<!-- forge-source:/gm) || []).length; }
function cleanup() { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); }

try {
  // Render twice and compare bytes: output is LF-only and independent of host separators.
  const root = fixtureRepo();
  const first = renderer.render({ repo: root, projectRoot: root, claudeHome: path.join(root, 'Claude Home Ω'), forgeHome: path.join(root, 'Forge Home Ω') });
  const second = renderer.render({ repo: root, projectRoot: root, claudeHome: path.join(root, 'Claude Home Ω'), forgeHome: path.join(root, 'Forge Home Ω') });
  assert.deepStrictEqual(first.artifacts, second.artifacts);
  assert(first.artifacts.some((item) => item.destination.endsWith(path.join('Claude Home Ω', 'agents', 'forge-executor.md'))));
  assert(first.artifacts.some((item) => item.destination.endsWith(path.join('CLAUDE.md'))));
  assert(first.artifacts.every((item) => !item.content.includes('\r')));
  assert(first.artifacts.find((item) => item.source === 'CLAUDE.md').content.startsWith('<!-- forge-source:claude-instructions'));

  // Frontmatter has to open the projected document. Claude Code reads `name`,
  // `description`, `model` and `allowed-tools` only when the fence is on line 1,
  // so the origin marker goes below the closing fence — a marker above it costs
  // every agent its model and tools, and every skill and command its description.
  const fenced = first.artifacts.filter((item) => /\.md$/i.test(item.source)
    && normalize(fs.readFileSync(path.join(root, item.source), 'utf8')).startsWith('---'));
  assert(fenced.length > 0, 'nenhuma fonte com frontmatter no inventário');
  for (const artifact of fenced) {
    assert(artifact.content.startsWith('---'), `frontmatter deslocado: ${artifact.source}`);
    assert.match(artifact.content, /^<!-- forge-source:[^\n]* -->$/m, `marcador ausente: ${artifact.source}`);
    assert.strictEqual(markers(artifact.content), 1, `marcador duplicado: ${artifact.source}`);
    assert(renderer.hasOriginMarker(artifact.content), `projeção não reconhecida como gerada: ${artifact.source}`);
  }

  // A projection written by the pre-fix renderer (marker above the fence) is
  // still recognized as generated — otherwise every installed file would flip to
  // user-owned and updates would silently stop — and re-rendering relocates the
  // marker instead of stacking a second one.
  const sample = fenced[0];
  const sourceText = normalize(fs.readFileSync(path.join(root, sample.source), 'utf8'));
  const aboveFence = `<!-- forge-source:${sample.source_id} source=${sample.source} version=0.0.0 -->\n\n${sourceText}`;
  assert(renderer.hasOriginMarker(aboveFence));
  const relocated = renderer.addOriginHeader(aboveFence, { source_id: sample.source_id }, sample.source);
  assert(relocated.startsWith('---'), 'layout antigo não foi realocado');
  assert.strictEqual(markers(relocated), 1, 'marcador empilhado ao realocar');
  assert.strictEqual(renderer.addOriginHeader(relocated, { source_id: sample.source_id }, sample.source), relocated);
  assert.strictEqual(relocated, sample.content);

  // Ownership stays conservative: a file with no marker is the operator's.
  assert.strictEqual(renderer.hasOriginMarker('{\n  "operator": true\n}\n'), false);
  assert.strictEqual(renderer.hasOriginMarker(`${'x\n'.repeat(4096)}<!-- forge-source:agents -->`), false);

  // The probe is ANCHORED to the two accepted positions, not "a marker line
  // somewhere near the top". A user-owned document that merely QUOTES the marker —
  // documentation of this very mechanism is the obvious case — must stay theirs;
  // classifying it as generated overwrites a file the ownership check exists to
  // protect. An unanchored /m over the first 4096 chars gets both of these wrong.
  assert.strictEqual(renderer.hasOriginMarker(
    '# Como as projeções são marcadas\n\n```md\n<!-- forge-source:agents source=x -->\n```\n'), false,
  'marcador citado em bloco de código não torna o arquivo uma projeção');
  assert.strictEqual(renderer.hasOriginMarker(
    `# Doc do operador\n${'texto\n'.repeat(38)}<!-- forge-source:agents source=x -->\n`), false,
  'marcador no meio do corpo não torna o arquivo uma projeção');

  // ...and it survives CRLF, because unlike stripOriginHeader this probe runs on
  // raw bytes read off disk. Reading a CRLF projection as user-owned would stop
  // updates silently — the same failure mode the marker move had to avoid.
  for (const [label, text] of [
    ['topo', '<!-- forge-source:agents source=x -->\r\n\r\n---\r\nname: x\r\n---\r\n'],
    ['abaixo da cerca', '---\r\nname: x\r\n---\r\n<!-- forge-source:agents source=x -->\r\nCorpo\r\n'],
  ]) {
    assert.strictEqual(renderer.hasOriginMarker(text), true, `projeção CRLF (${label}) lida como user-owned`);
  }

  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-renderer', 'claude-4.8.0.golden.json'), 'utf8'));
  assert.strictEqual(golden.runtime, first.runtime);
  assert.strictEqual(golden.version, renderer.VERSION);
  for (const surface of golden.surfaces) {
    const matching = first.artifacts.filter((item) => item.source_id === surface.source_id);
    assert(matching.length > 0, `golden surface missing: ${surface.source_id}`);
    const target = surface.target.split(';')[0].replace(/^(?:project|forge)\//, '');
    const suffix = target.replace(/\//g, path.sep);
    const targetFound = matching.some((item) => item.destination.endsWith(suffix)
      || item.destination.includes(`${path.sep}${suffix}${path.sep}`));
    assert(targetFound, `golden target missing: ${surface.target}`);
    const payload = matching.sort((a, b) => a.source.localeCompare(b.source)).map((item) => `${item.source}\0${item.content}`).join('\0');
    assert.strictEqual(crypto.createHash('sha256').update(payload, 'utf8').digest('hex'), surface.sha256, `golden bytes drifted: ${surface.source_id}`);
  }

  // Markdown receives a safe origin marker; JSONC and CommonJS stay parseable/textual.
  const settings = first.artifacts.find((item) => item.source.endsWith('settings.jsonc'));
  const hook = first.artifacts.find((item) => item.source === 'scripts/forge-hook.js');
  assert(!settings.content.startsWith('<!--'));
  assert(!hook.content.startsWith('<!--'));
  assert.match(settings.content, /CLAUDE_PROJECT_DIR/);

  // Claude-only rendering does not resolve, read or create a Codex home.
  const codexHome = path.join(root, 'Codex Home Ω');
  const report = renderer.write({ repo: root, projectRoot: root, claudeHome: path.join(root, 'Claude Home Ω'), forgeHome: path.join(root, 'Forge Home Ω'), dryRun: true });
  assert.strictEqual(report.runtime, 'claude');
  assert(report.artifacts.every((item) => !item.destination.startsWith(codexHome)));
  assert.strictEqual(fs.existsSync(codexHome), false);

  // First write materializes managed Claude surfaces; second write is a no-op.
  const claudeHome = path.join(root, 'Claude Write Ω');
  const forgeHome = path.join(root, 'Forge Write Ω');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const options = { repo: root, projectRoot, claudeHome, forgeHome };
  const written = renderer.write(options);
  assert(written.written.length > 0);
  assert(fs.existsSync(path.join(claudeHome, 'agents', 'forge-executor.md')));
  assert(fs.existsSync(path.join(claudeHome, 'settings.json')));
  const repeat = renderer.write(options);
  assert.strictEqual(repeat.written.length, 0);
  assert(repeat.preserved.every((item) => item.reason === 'already-current'));

  // Backup paths remain safe when repository and user homes live on different
  // roots (a common Windows/macOS setup), and never escape backupDir.
  const externalProject = path.join(os.tmpdir(), `forge-external-project-${process.pid}`);
  const externalBackup = path.join(os.tmpdir(), `forge-external-backup-${process.pid}`);
  fs.mkdirSync(externalProject, { recursive: true });
  const externalOptions = { repo: root, projectRoot: externalProject, claudeHome: path.join(os.tmpdir(), `forge-external-claude-${process.pid}`), forgeHome: path.join(os.tmpdir(), `forge-external-forge-${process.pid}`) };
  renderer.write(externalOptions);
  fs.writeFileSync(path.join(externalProject, 'CLAUDE.md'), '<!-- forge-source:operator -->\nold\n');
  const externalUpdate = renderer.write({ ...externalOptions, backupDir: externalBackup });
  assert(externalUpdate.written.length > 0);
  assert(fs.readdirSync(externalBackup).length > 0);
  fs.rmSync(externalProject, { recursive: true, force: true });
  fs.rmSync(externalBackup, { recursive: true, force: true });

  // A user-owned settings file and project .gsd remain byte-identical.
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{\n  "operator": true\n}\n');
  const userOwned = renderer.write(options);
  assert(userOwned.conflicts.some((item) => item.destination.endsWith(path.join('Claude Write Ω', 'settings.json'))));
  assert.match(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'), /operator/);
  const gsd = path.join(projectRoot, '.gsd');
  fs.mkdirSync(gsd, { recursive: true });
  fs.writeFileSync(path.join(gsd, 'STATE.md'), 'user state\r\n');
  assert.strictEqual(fs.readFileSync(path.join(gsd, 'STATE.md'), 'utf8'), 'user state\r\n');

  // Unsafe custom destinations are rejected before writing.
  const unsafe = manifestFor(root);
  unsafe.sources[0].render_targets[0].path = '../outside';
  assert.throws(() => renderer.render({ repo: root, manifest: unsafe }), /destino|path inseguro/);

  // settings.json is the operator's Claude Code config, not a Forge projection. This is
  // the ONLY assertion standing between a `--migrate-legacy` and an unrecoverable wipe of
  // the operator's statusLine/hooks/permissions — measured on a real run, 2026-08-11, with
  // no backup taken. The `--migrate-legacy` flag is what makes this a separate guard from
  // the user-owned check beside it: that check alone is bypassed by exactly this flag.
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-settings-owned-'));
    const claudeHome = path.join(home, 'Claude Home Ω');
    const operatorSettings = path.join(claudeHome, 'settings.json');
    const operatorText = JSON.stringify({
      statusLine: { type: 'command', command: 'node ~/.claude/forge-statusline.js' },
      permissions: { allow: ['Bash(node:*)'] },
      hooks: { PostToolUse: [{ matcher: 'Agent', hooks: [] }] },
    }, null, 2);
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(operatorSettings, operatorText, 'utf8');

    const opts = { repo: root, projectRoot: path.join(home, 'proj'), claudeHome, forgeHome: path.join(home, 'Forge Home Ω') };
    for (const [label, extra] of [['update', { update: true }], ['migrate-legacy', { update: true, migrateLegacy: true }]]) {
      const report = renderer.write({ ...opts, ...extra });
      assert.strictEqual(fs.readFileSync(operatorSettings, 'utf8'), operatorText,
        `${label} sobrescreveu settings.json do operador`);
      assert(report.conflicts.some((item) => item.destination === operatorSettings),
        `${label} não reportou settings.json como conflito preservado`);
    }

    // The other half of the contract: a FRESH install (nothing on disk) still projects it,
    // so the guard protects an existing operator file without disabling the surface.
    fs.rmSync(operatorSettings, { force: true });
    renderer.write({ ...opts, update: true, migrateLegacy: true });
    assert(fs.existsSync(operatorSettings), 'instalação limpa deixou de projetar settings.json');
    JSON.parse(fs.readFileSync(operatorSettings, 'utf8')); // strict JSON — a `//` comment here is a defect
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── Script projections must be able to prove they are ours ────────────────
  // The ownership probe is the marker, and `addOriginHeader` used to add one
  // only to Markdown. A managed `.js` therefore never satisfied `hasOriginMarker`,
  // so the write path read every existing script destination as user-owned and
  // preserved it — forever. Measured on a live install: ~/.claude/hooks/forge-hook.js
  // frozen releases behind while each --update reported success. A projection
  // writable exactly once is not managed, so the asserts below are about the
  // SECOND write, never the first.
  {
    const root = fixtureRepo();
    const home = temp('script-marker-home');
    const opts = { repo: root, projectRoot: root, claudeHome: home, forgeHome: path.join(home, 'forge') };

    renderer.write(opts);
    const flat = path.join(home, 'forge-hook.js');
    const nested = path.join(home, 'hooks', 'forge-hook.js');

    // Both destinations are projected: settings.json runs the flat path (see
    // scripts/merge-settings.js), while the renderer historically maintained only
    // the nested one — so the copy that actually executes had no owner.
    assert(fs.existsSync(flat), 'o hook plano (~/.claude/forge-hook.js) não é projetado — é o caminho que settings.json executa');
    assert(fs.existsSync(nested), 'o hook aninhado (~/.claude/hooks/forge-hook.js) deixou de ser projetado');
    assert.strictEqual(fs.readFileSync(flat, 'utf8'), fs.readFileSync(nested, 'utf8'),
      'as duas projeções do hook divergiram — uma delas vai congelar');

    const installed = fs.readFileSync(flat, 'utf8');
    assert(renderer.hasOriginMarker(installed), 'projeção de script não carrega prova de propriedade');
    assert.strictEqual(installed.split('\n')[0], '#!/usr/bin/env node',
      'o marcador foi posto ACIMA do shebang — o arquivo deixa de executar direto');
    assert.match(installed.split('\n')[1], /^\/\/ forge-source:hooks /,
      'o marcador de script não está na linha imediatamente abaixo do shebang');
    assert(!installed.startsWith('<!--'), 'CommonJS recebeu marcador HTML e deixou de ser parseável');
    assert.strictEqual(
      renderer.stripOriginHeader(installed),
      normalize(fs.readFileSync(path.join(root, 'scripts/forge-hook.js'), 'utf8')),
      'strip(add(x)) !== x para script — o marcador não é reversível',
    );

    // THE consequence: a second write updates the script instead of preserving it.
    // Positive control first (the destination really is ours), then the update.
    fs.writeFileSync(path.join(root, 'scripts/forge-hook.js'), '#!/usr/bin/env node\n// v2 do hook\n');
    const second = renderer.write({ ...opts, update: true });
    assert(!second.conflicts.some((item) => path.resolve(item.destination) === path.resolve(flat)),
      'a projeção de script marcada foi tratada como user_owned — o congelamento silencioso voltou');
    assert.match(fs.readFileSync(flat, 'utf8'), /v2 do hook/,
      'segunda escrita não atualizou o hook: a projeção continua write-once');

    // ...and the guard still bites: an UNMARKED script on disk is a real conflict.
    fs.writeFileSync(flat, '#!/usr/bin/env node\n// editado pelo operador\n');
    const third = renderer.write({ ...opts, update: true });
    assert(third.conflicts.some((item) => path.resolve(item.destination) === path.resolve(flat)),
      'script sem marcador deixou de ser conflito — o guard de arquivo do operador morreu');
    assert.match(fs.readFileSync(flat, 'utf8'), /editado pelo operador/,
      'arquivo sem marcador foi sobrescrito');

    // JSON genuinely cannot carry a comment, so it stays a conflict. Asserted so
    // the limitation is a decision on record rather than a surprise later.
    const schema = path.join(home, 'forge-prefs.schema.json');
    fs.writeFileSync(path.join(root, 'forge-prefs.schema.json'), '{"v":2}\n');
    const fourth = renderer.write({ ...opts, update: true });
    assert(fourth.conflicts.some((item) => path.resolve(item.destination) === path.resolve(schema)),
      'projeção JSON deixou de ser reportada como conflito — sem marcador possível, ela PRECISA aparecer no relatório');

    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── The JSON freeze, reproduced and then removed ──────────────────────────
  // JSON has no comment syntax, so a JSON projection can never carry the marker.
  // Step (b) below reproduces the defect on purpose — without the ownership
  // record the destination IS a conflict — so step (c) proves the fix against a
  // demonstrated failure instead of asserting into a vacuum.
  {
    const root = fixtureRepo();
    const home = temp('ownership-home');
    const opts = { repo: root, projectRoot: root, claudeHome: home, forgeHome: path.join(home, 'forge') };
    const schemaSource = path.join(root, 'forge-prefs.schema.json');
    const schemaDest = path.join(home, 'forge-prefs.schema.json');
    const isConflict = (report) => report.conflicts.some((item) => path.resolve(item.destination) === path.resolve(schemaDest));

    // (a) fresh install writes it and hands back a record.
    const first = renderer.write(opts);
    assert(fs.existsSync(schemaDest), 'instalação limpa não projetou o schema JSON');
    assert(first.ownership && first.ownership[path.resolve(schemaDest)],
      '(a) write() não devolveu registro de propriedade para o destino JSON');
    assert(!renderer.hasOriginMarker(fs.readFileSync(schemaDest, 'utf8')),
      '(a) JSON ganhou marcador — se isso passar a existir, este bloco testa outra coisa');

    // (b) the release changes the schema. WITHOUT the record this is the freeze.
    fs.writeFileSync(schemaSource, '{"version":"segunda release"}\n', 'utf8');
    assert(isConflict(renderer.write({ ...opts, update: true })),
      '(b controle) sem registro o JSON deveria ser conflito — a reprodução do defeito falhou, então (c) não prova nada');
    assert(!/segunda release/.test(fs.readFileSync(schemaDest, 'utf8')),
      '(b controle) o destino foi atualizado sem registro — o defeito não existe como descrito');

    // (c) THE FIX: with the record carried forward, the same update lands.
    const second = renderer.write({ ...opts, update: true, ownership: first.ownership });
    assert(!isConflict(second), '(c) JSON continua congelado mesmo com registro de propriedade');
    assert.match(fs.readFileSync(schemaDest, 'utf8'), /segunda release/,
      '(c) o destino JSON não foi atualizado — a projeção segue write-once');

    // (d) the record follows the new bytes, so a third release also lands.
    fs.writeFileSync(schemaSource, '{"version":"terceira release"}\n', 'utf8');
    const third = renderer.write({ ...opts, update: true, ownership: second.ownership });
    assert.match(fs.readFileSync(schemaDest, 'utf8'), /terceira release/,
      '(d) o registro não acompanhou a escrita — só a primeira atualização funcionaria');
    assert(!isConflict(third), '(d) terceira release virou conflito');

    // (e) the guard still bites: an operator edit diverges from the record.
    fs.writeFileSync(schemaDest, '{"version":"editado pelo operador"}\n', 'utf8');
    fs.writeFileSync(schemaSource, '{"version":"quarta release"}\n', 'utf8');
    assert(isConflict(renderer.write({ ...opts, update: true, ownership: third.ownership })),
      '(e) arquivo divergente do registro deixou de ser conflito — o guard do operador morreu');
    assert.match(fs.readFileSync(schemaDest, 'utf8'), /editado pelo operador/,
      '(e) a edição do operador foi sobrescrita');

    // (f) `already-current` must ENTER the record, not merely survive in it.
    //     The case that matters is a destination that is byte-identical to what
    //     we would write but has NO prior record — a reinstall over an existing
    //     tree. Asserting with a record already in hand proves nothing: the
    //     carry-forward spread would keep the entry even if already-current
    //     files were dropped (verified — that version of this assert did not
    //     bite). So: fresh home, file pre-created, EMPTY record.
    const home2 = temp('ownership-already-current');
    const opts2 = { repo: root, projectRoot: root, claudeHome: home2, forgeHome: path.join(home2, 'forge') };
    const planned = renderer.render(opts2).artifacts.find((a) => a.destination.endsWith('forge-prefs.schema.json'));
    fs.mkdirSync(path.dirname(planned.destination), { recursive: true });
    fs.writeFileSync(planned.destination, planned.content, 'utf8');
    const reinstall = renderer.write({ ...opts2, update: true, ownership: {} });
    assert(reinstall.preserved.some((item) => item.destination === planned.destination && item.reason === 'already-current'),
      '(f controle) o destino não foi classificado como already-current — o cenário não é o que este assert testa');
    assert(reinstall.ownership[path.resolve(planned.destination)],
      '(f) already-current não entrou no registro — na próxima release esse JSON não tem marcador nem digest e congela');
    fs.rmSync(home2, { recursive: true, force: true });

    // (g) a dry run must not record bytes it never wrote.
    const dry = renderer.write({ ...opts, update: true, dryRun: true, ownership: {} });
    assert.deepStrictEqual(dry.ownership, {},
      '(g) dry-run registrou propriedade — a próxima execução acreditaria ser dona de algo que não escreveu');

    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log('forge-claude-renderer tests passed');
} finally {
  cleanup();
}
