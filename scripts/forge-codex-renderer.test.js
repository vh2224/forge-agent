#!/usr/bin/env node
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const renderer = require('./forge-codex-renderer');
const claudeRenderer = require('./forge-claude-renderer');
const root = path.resolve(__dirname, '..'); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-Ω-')); const versionPattern = renderer.VERSION.replace(/\./g, '\\.');

const {
  DISPATCH_MARKER_START,
  DISPATCH_MARKER_END,
  DISPATCH_REASON,
  scanDispatchMarkers,
  locateDispatchBlock,
  rewriteDispatchDialect,
} = renderer;

function sourceDefinition(sourceId, input, planned = false) {
  const source = {
    source_id: sourceId,
    owner: 'fixture',
    inputs: [input],
    render_targets: [{ path: input, recursive: true }],
    capability: `fixture-${sourceId}`,
    security_role: 'internal',
    newline: 'lf',
    origin_header: 'fixture',
    common: { format: 'markdown' },
  };
  if (planned) source.conditional = { claude: { status: 'planned' }, codex: { status: 'planned' } };
  return source;
}

function fixtureManifest() {
  return {
    schema_version: '1.0.0',
    sources: [
      sourceDefinition('agents', 'agents', true),
      sourceDefinition('commands', 'commands', true),
      sourceDefinition('skills', 'skills', true),
      sourceDefinition('dispatch-templates', 'shared/templates/dispatch'),
    ],
  };
}

function fixtureRepository(label, content) {
  const repo = path.join(temp, label);
  const file = path.join(repo, 'shared', 'templates', 'dispatch', 'dispatch-fence.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return { repo, file };
}

function markdownFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(full);
  }
  return found;
}

function hashCensus(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.sourceId)) groups.set(record.sourceId, []);
    groups.get(record.sourceId).push(record);
  }
  const hashes = {};
  for (const [sourceId, entries] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const hash = crypto.createHash('sha256');
    for (const entry of entries.sort((left, right) => left.source.localeCompare(right.source))) {
      hash.update(entry.source);
      hash.update(Buffer.from([0]));
      hash.update(entry.content);
    }
    hashes[sourceId] = hash.digest('hex');
  }
  return hashes;
}

function assertBytesEqual(actual, expected, message) {
  assert.strictEqual(Buffer.compare(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8')), 0, message);
}

function hasAgentOutsideFence(text) {
  let fenceChar = null;
  let fenceLength = 0;
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (fenceChar !== null) {
      let runLength = 0;
      while (line[runLength] === fenceChar) runLength++;
      if (runLength >= fenceLength && /^[ \t]*$/.test(line.slice(runLength))) {
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence) { fenceChar = fence[1][0]; fenceLength = fence[1].length; continue; }
    if (line.includes('Agent(')) return true;
  }
  return false;
}
try {
  const project = path.join(temp, 'project Ω'); const codex = path.join(temp, 'Codex Home Ω'); const forge = path.join(temp, 'Forge Home Ω'); fs.mkdirSync(project, { recursive: true });
  const report = renderer.render({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge });
  assert.strictEqual(report.runtime, 'codex'); assert(report.artifacts.some((item) => item.destination.endsWith(path.join('project Ω', 'AGENTS.md')))); assert(report.artifacts.some((item) => item.destination.endsWith(path.join('Codex Home Ω', 'agents', 'forge-executor.toml')))); assert(report.artifacts.every((item) => !item.destination.includes('.claude'))); assert(report.artifacts.every((item) => !item.content.includes('\r')));
  const agent = report.artifacts.find((item) => item.destination.endsWith(path.join('agents', 'forge-executor.toml')));
  assert.match(agent.content, new RegExp(`^# forge-source:codex-agent-forge-executor version=${versionPattern}$`, 'm'));
  assert.match(agent.content, /^name = "forge-executor"$/m);
  assert.match(agent.content, /^sandbox_mode = "workspace-write"$/m);
  assert.match(agent.content, /developer_instructions = """[\s\S]+"""/);
  // Parse the generated TOML subset: every scalar is quoted and the multiline
  // instruction value is terminated, so Codex receives a valid agent document.
  const scalarLines = agent.content.split('\n').filter((line) => line && !line.startsWith('#') && !line.startsWith('developer_instructions =') && line !== '"""');
  assert(scalarLines.slice(0, 3).every((line) => /^(name|description|sandbox_mode) = "[^"\n]+"$/.test(line)));
  const first = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge }); assert(first.written.length > 0); assert(fs.existsSync(path.join(project, 'AGENTS.md'))); assert(fs.existsSync(path.join(codex, 'config.toml'))); assert(!fs.existsSync(path.join(temp, 'Claude Home Ω')));
  assert(fs.existsSync(path.join(codex, 'skills', 'forge-help', 'SKILL.md')));
  assert(fs.existsSync(path.join(codex, 'commands', 'forge.md')));
  assert(fs.existsSync(path.join(codex, 'templates', 'dispatch', 'execute-task.md')));
  // Frontmatter has to open the projected document — Codex reads `name` and
  // `description` from it — so the origin marker sits below the closing fence.
  for (const relative of [['skills', 'forge-help', 'SKILL.md'], ['commands', 'forge.md']]) {
    const source = fs.readFileSync(path.join(root, ...relative), 'utf8').replace(/\r\n/g, '\n');
    const projected = fs.readFileSync(path.join(codex, ...relative), 'utf8');
    assert(source.startsWith('---'), `fonte sem frontmatter: ${relative.join('/')}`);
    assert(projected.startsWith('---'), `frontmatter deslocado: ${relative.join('/')}`);
    assert.strictEqual((projected.match(/^<!-- forge-source:/gm) || []).length, 1, `marcador duplicado: ${relative.join('/')}`);
  }
  assert(!fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').startsWith('<!--'));
  assert.match(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), new RegExp(`^# forge-source:codex-config version=${versionPattern}$`, 'm'));
  const reportCapabilities = JSON.parse(fs.readFileSync(path.join(forge, 'adapters', 'codex', 'capabilities.json'), 'utf8'));
  assert(reportCapabilities.surfaces.some((surface) => surface.source_id === 'hooks' && surface.status === 'planned'));
  const second = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge }); assert.strictEqual(second.written.length, 0); assert(second.preserved.every((item) => item.reason === 'already-current'));
  // A projection left by the pre-fix renderer (marker above the fence) is still
  // recognized as generated, so the next write relocates the marker. Reading
  // ownership as "starts with the marker" would flip it to user-owned and stop
  // updates on every file the older renderer had produced.
  const legacySkill = path.join(codex, 'skills', 'forge-help', 'SKILL.md');
  fs.writeFileSync(legacySkill, `<!-- forge-source:codex -->\n\n${fs.readFileSync(path.join(root, 'skills', 'forge-help', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')}`);
  const relocated = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge });
  assert(relocated.written.some((item) => item.destination === legacySkill), 'layout antigo tratado como user-owned');
  assert(fs.readFileSync(legacySkill, 'utf8').startsWith('---'));
  fs.writeFileSync(path.join(codex, 'config.toml'), 'operator = true\n'); const preserved = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge }); assert(preserved.conflicts.some((item) => item.destination.endsWith(path.join('Codex Home Ω', 'config.toml')))); assert.match(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), /operator/);

  // The ownership probe is anchored to the accepted positions, so a user-owned
  // document that merely QUOTES the marker stays theirs. Behavioural on purpose:
  // hasOrigin is internal, and what has to hold is that write() refuses to touch
  // the file — an unanchored probe classifies it as a projection and overwrites it.
  const operatorDoc = path.join(codex, 'skills', 'forge-help', 'SKILL.md');
  const operatorText = '# Notas do operador\n\nO marcador tem esta forma:\n\n```md\n<!-- forge-source:codex -->\n```\n';
  fs.writeFileSync(operatorDoc, operatorText);
  const quoted = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge });
  assert(quoted.conflicts.some((item) => item.destination === operatorDoc), 'documento que apenas cita o marcador foi tratado como projeção');
  assert.strictEqual(fs.readFileSync(operatorDoc, 'utf8'), operatorText, 'arquivo do operador foi sobrescrito');
  fs.rmSync(operatorDoc, { force: true });
  const dry = renderer.write({ repo: root, projectRoot: project, codexHome: path.join(temp, 'dry codex'), forgeHome: path.join(temp, 'dry forge'), dryRun: true }); assert.strictEqual(dry.dry_run, true); assert(!fs.existsSync(path.join(temp, 'dry codex')));
  assert.throws(() => renderer.render({ repo: root, codexHome: path.join(temp, '.claude') }), error => error.code === 'invalid_options' || error.code === 'host-isolation');

  // A repo root without the source manifest is not a clone. Same rule as the
  // Claude renderer: name `--repo`, never surface a raw ENOENT for a file that
  // was never supposed to live at that path (the Forge home is the real case).
  const notAClone = path.join(temp, 'not a clone');
  fs.mkdirSync(path.join(notAClone, 'scripts'), { recursive: true });
  assert.throws(
    () => renderer.render({ repo: notAClone, projectRoot: notAClone, codexHome: path.join(notAClone, '.codex'), forgeHome: path.join(notAClone, '.forge-agent') }),
    (error) => error.code === 'missing_manifest' && /--repo/.test(error.message) && error.message.includes(notAClone) && !/ENOENT/.test(error.message),
  );

  // The shared fixture carries three textual marker pairs: two quoted by code
  // fences and exactly one real pair at column zero. A global regex sees all
  // three; the managed-block scanner must expose only the real pair.
  const fixturePath = path.join(__dirname, 'fixtures', 'codex-renderer', 'dispatch-fence.md');
  const fixtureText = fs.readFileSync(fixturePath, 'utf8');
  assert(Object.isFrozen(DISPATCH_REASON), 'DISPATCH_REASON precisa ser imutável');
  const naiveStarts = fixtureText.match(/^<!-- forge:dispatch:start -->$/gm) || [];
  const scannedFixture = scanDispatchMarkers(fixtureText);
  assert(naiveStarts.length > 1, 'fixture não morde um detector global ingênuo');
  assert.strictEqual(scannedFixture.starts.length, 1, 'start citado foi tratado como marker real');
  assert.strictEqual(scannedFixture.ends.length, 1, 'end citado foi tratado como marker real');

  const locatedFixture = locateDispatchBlock(fixtureText);
  const fixturePrefix = fixtureText.slice(0, locatedFixture.start);
  const fixtureInterior = fixtureText.slice(locatedFixture.start, locatedFixture.end);
  const fixtureSuffix = fixtureText.slice(locatedFixture.end);
  const agentInvocation = 'CodexAgent(';
  const codexFixture = rewriteDispatchDialect(fixtureText, { agentInvocation });
  const expectedInterior = fixtureInterior
    .split('Agent(').join(agentInvocation)
    .split('--host-runtime claude').join(`--host-runtime ${renderer.RUNTIME}`);
  assertBytesEqual(codexFixture.slice(0, fixturePrefix.length), fixturePrefix, 'prefixo externo ao splice mudou');
  assert.strictEqual(codexFixture.slice(fixturePrefix.length, fixturePrefix.length + expectedInterior.length), expectedInterior);
  assertBytesEqual(codexFixture.slice(-fixtureSuffix.length), fixtureSuffix, 'sufixo externo ao splice mudou');
  assert(fixturePrefix.includes('Agent(') && fixturePrefix.includes('--host-runtime claude'));
  assert(fixtureSuffix.includes('Agent(') && fixtureSuffix.includes('--host-runtime claude'));
  assert(expectedInterior.includes(agentInvocation) && expectedInterior.includes('--host-runtime codex'));
  assert(!expectedInterior.includes('--host-runtime claude'));

  // No marker means byte identity and no option access. This is what keeps the
  // seam inert before canonical fenced sources are introduced in the next slice.
  const markerless = 'Agent({ outside: true })\r\n--host-runtime claude\r\n';
  const optionsThatMustStayUnread = {};
  Object.defineProperty(optionsThatMustStayUnread, 'agentInvocation', { get() { throw new Error('option was read'); } });
  assert.strictEqual(rewriteDispatchDialect(markerless, optionsThatMustStayUnread), markerless);

  const indentedMarkers = `  ${DISPATCH_MARKER_START}\nAgent({ indented: true })\n  ${DISPATCH_MARKER_END}\n`;
  assert.strictEqual(locateDispatchBlock(indentedMarkers), null);
  assert.strictEqual(rewriteDispatchDialect(indentedMarkers), indentedMarkers);
  for (const fence of ['```md', '~~~~text']) {
    const close = fence[0].repeat(fence.match(/^[`~]+/)[0].length);
    const quotedMarkers = `${fence}\n${DISPATCH_MARKER_START}\nAgent({ quoted: true })\n${DISPATCH_MARKER_END}\n${close}\n`;
    assert.strictEqual(locateDispatchBlock(quotedMarkers), null, `${fence[0]} fence não foi ignorado`);
    assert.strictEqual(rewriteDispatchDialect(quotedMarkers), quotedMarkers);
  }

  const malformedCases = [
    [DISPATCH_REASON.START_WITHOUT_END, `${DISPATCH_MARKER_START}\ncorpo\n`],
    [DISPATCH_REASON.END_WITHOUT_START, `corpo\n${DISPATCH_MARKER_END}\n`],
    [DISPATCH_REASON.DUPLICATE_START, `${DISPATCH_MARKER_START}\n${DISPATCH_MARKER_START}\n${DISPATCH_MARKER_END}\n`],
    [DISPATCH_REASON.DUPLICATE_END, `${DISPATCH_MARKER_START}\n${DISPATCH_MARKER_END}\n${DISPATCH_MARKER_END}\n`],
    [DISPATCH_REASON.END_BEFORE_START, `${DISPATCH_MARKER_END}\ncorpo\n${DISPATCH_MARKER_START}\n`],
    // Fence aberto DENTRO do interior real e nunca fechado: por CommonMark ele se
    // estende até o EOF e engole o end marker real, então o par bem-formado passa a
    // ler como incompleto. Veredito correto — fixado aqui para que uma mudança
    // futura no scanner não possa invertê-lo em silêncio.
    [DISPATCH_REASON.START_WITHOUT_END, `${DISPATCH_MARKER_START}\n\`\`\`md\ncorpo\n${DISPATCH_MARKER_END}\n`],
  ];
  for (const [reason, malformed] of malformedCases) {
    assert.throws(
      () => locateDispatchBlock(malformed),
      (error) => error.code === reason && error.start === undefined && error.end === undefined,
      `malformação não recusada por ${reason}`,
    );
  }

  const agentRequired = `${DISPATCH_MARKER_START}\nAgent({ required: true })\n${DISPATCH_MARKER_END}\n`;
  for (const missing of [undefined, '', null, 0, false, {}]) {
    assert.throws(
      () => rewriteDispatchDialect(agentRequired, { agentInvocation: missing }),
      (error) => error.code === DISPATCH_REASON.AGENT_FORM_REQUIRED,
    );
  }
  const runtimeOnly = `${DISPATCH_MARKER_START}\n--host-runtime claude\n${DISPATCH_MARKER_END}\n`;
  assert(rewriteDispatchDialect(runtimeOnly).includes('--host-runtime codex'));
  assert(rewriteDispatchDialect(runtimeOnly, { hostRuntime: 'custom-worker' }).includes('--host-runtime custom-worker'));
  // Simétrico ao loop de agentInvocation: só `undefined` significa "use o default".
  // Qualquer outro valor inutilizável é recusado por código nomeado, em vez de ser
  // stringificado em `--host-runtime null` / `--host-runtime [object Object]`.
  for (const invalid of ['', null, 0, false, {}]) {
    assert.throws(
      () => rewriteDispatchDialect(runtimeOnly, { hostRuntime: invalid }),
      (error) => error.code === DISPATCH_REASON.HOST_RUNTIME_INVALID,
      `hostRuntime inválido aceito: ${String(invalid)}`,
    );
  }
  assert.strictEqual(rewriteDispatchDialect(runtimeOnly, { hostRuntime: undefined }), rewriteDispatchDialect(runtimeOnly));
  const approximateTokens = `${DISPATCH_MARKER_START}\nAgent ({ approximate: true })\nagent({ lower: true })\n--host-runtime  claude\n${DISPATCH_MARKER_END}\n`;
  assert.strictEqual(rewriteDispatchDialect(approximateTokens), approximateTokens, 'variantes aproximadas foram reescritas');

  // The injected Agent form may itself contain line breaks. They follow the
  // document's CRLF convention, while every byte outside the interior remains
  // identical and no isolated LF is introduced.
  const crlfSource = `prefixo\r\n${DISPATCH_MARKER_START}\r\nAgent({ crlf: true })\r\n--host-runtime claude\r\n${DISPATCH_MARKER_END}\r\nsufixo\r\n`;
  const crlfBlock = locateDispatchBlock(crlfSource);
  const crlfPrefix = crlfSource.slice(0, crlfBlock.start);
  const crlfSuffix = crlfSource.slice(crlfBlock.end);
  const crlfOutput = rewriteDispatchDialect(crlfSource, { agentInvocation: 'CodexAgent(\ncontinued(' });
  assertBytesEqual(crlfOutput.slice(0, crlfPrefix.length), crlfPrefix, 'prefixo CRLF mudou');
  assertBytesEqual(crlfOutput.slice(-crlfSuffix.length), crlfSuffix, 'sufixo CRLF mudou');
  assert(crlfOutput.includes('CodexAgent(\r\ncontinued('));
  assert.strictEqual(crlfOutput.replace(/\r\n/g, '').includes('\n'), false, 'LF solto introduzido em arquivo CRLF');

  // Exercise both real renderers against the same repository fixture. Codex
  // rewrites before its dispatch origin wrapper; Claude remains exactly the
  // historical addOriginHeader(source, ...) projection, including frontmatter.
  const validFixture = fixtureRepository('valid dispatch repo', fixtureText);
  const manifest = fixtureManifest();
  const codexFixtureReport = renderer.render({
    repo: validFixture.repo,
    manifest,
    projectRoot: path.join(validFixture.repo, 'project'),
    codexHome: path.join(validFixture.repo, 'codex-home'),
    forgeHome: path.join(validFixture.repo, 'forge-home'),
    agentInvocation,
  });
  const codexArtifact = codexFixtureReport.artifacts.find((item) => item.source === 'shared/templates/dispatch/dispatch-fence.md');
  assert(codexArtifact, 'fixture não atravessou o renderer Codex real');
  assert.strictEqual(codexArtifact.content, `${renderer.ORIGIN}\n\n${codexFixture.replace(/\r\n/g, '\n').replace(/\r/g, '\n')}`);

  const claudeFixtureReport = claudeRenderer.render({
    repo: validFixture.repo,
    manifest,
    projectRoot: path.join(validFixture.repo, 'project'),
    claudeHome: path.join(validFixture.repo, 'claude-home'),
    forgeHome: path.join(validFixture.repo, 'forge-home'),
  });
  const claudeArtifact = claudeFixtureReport.artifacts.find((item) => item.source === 'shared/templates/dispatch/dispatch-fence.md');
  const dispatchDefinition = manifest.sources.find((source) => source.source_id === 'dispatch-templates');
  const historicalClaude = claudeRenderer.addOriginHeader(fixtureText, dispatchDefinition, 'shared/templates/dispatch/dispatch-fence.md');
  assert(claudeArtifact, 'fixture não atravessou o renderer Claude real');
  assertBytesEqual(claudeArtifact.content, historicalClaude, 'projeção Claude histórica mudou');
  assert(claudeArtifact.content.includes('Agent({ subagent_type'));
  assert(claudeArtifact.content.includes('--host-runtime claude'));

  // write() renders every artifact first. A late malformed dispatch source must
  // throw before even the synthesized AGENTS.md artifact can reach the disk.
  const atomicFixture = fixtureRepository('atomic malformed repo', `${DISPATCH_MARKER_START}\nAgent({ broken: true })\n`);
  const atomicProject = path.join(atomicFixture.repo, 'output-project');
  const atomicCodex = path.join(atomicFixture.repo, 'output-codex');
  const atomicForge = path.join(atomicFixture.repo, 'output-forge');
  assert.throws(
    () => renderer.write({
      repo: atomicFixture.repo,
      manifest: fixtureManifest(),
      projectRoot: atomicProject,
      codexHome: atomicCodex,
      forgeHome: atomicForge,
      agentInvocation,
      provenance: null,
    }),
    (error) => error.code === DISPATCH_REASON.START_WITHOUT_END,
  );
  assert.strictEqual(fs.existsSync(atomicProject), false, 'write parcial materializou projectRoot');
  assert.strictEqual(fs.existsSync(atomicCodex), false, 'write parcial materializou codexHome');
  assert.strictEqual(fs.existsSync(atomicForge), false, 'write parcial materializou forgeHome');

  // Enumerate exactly the four Markdown surfaces from the real manifest. The
  // census is non-empty per surface, excludes shared/forge-dispatch.md, includes
  // an Agent( outside Markdown fences, and hashes identically before/after the
  // dialect seam while canonical sources still have no real dispatch marker.
  const realManifest = JSON.parse(fs.readFileSync(path.join(root, 'forge-source-manifest.json'), 'utf8'));
  const markdownSourceIds = new Set(['agents', 'commands', 'skills', 'dispatch-templates']);
  const census = [];
  for (const source of realManifest.sources.filter((entry) => markdownSourceIds.has(entry.source_id))) {
    let count = 0;
    for (const input of source.inputs) {
      const inputPath = path.join(root, input);
      const files = fs.statSync(inputPath).isDirectory() ? markdownFiles(inputPath) : [inputPath];
      for (const file of files) {
        const relative = path.relative(root, file).replace(/\\/g, '/');
        const content = fs.readFileSync(file, 'utf8');
        census.push({ sourceId: source.source_id, source: relative, content });
        count++;
      }
    }
    assert(count > 0, `censo vazio para ${source.source_id}`);
  }
  assert(census.length > 0, 'censo Markdown real vazio');
  assert(census.some((entry) => hasAgentOutsideFence(entry.content)), 'controle Agent( fora de fence ausente');
  assert(census.every((entry) => entry.source !== 'shared/forge-dispatch.md'));
  assert(census.every((entry) => {
    const markers = scanDispatchMarkers(entry.content);
    return markers.starts.length === 0 && markers.ends.length === 0;
  }), 'fonte canônica já contém marker forge:dispatch real');
  const rewrittenCensus = census.map((entry) => ({
    ...entry,
    content: rewriteDispatchDialect(entry.content, { agentInvocation, hostRuntime: renderer.RUNTIME }),
  }));
  for (let index = 0; index < census.length; index++) {
    assert.strictEqual(rewrittenCensus[index].content, census[index].content, `drift em ${census[index].source}`);
  }
  assert.deepStrictEqual(hashCensus(rewrittenCensus), hashCensus(census), 'SHA-256 por source_id mudou');

  const realCodex = renderer.render({ repo: root, agentInvocation });
  const realClaude = claudeRenderer.render({ repo: root });
  assert(realCodex.artifacts.every((artifact) => artifact.source !== 'shared/forge-dispatch.md'));
  assert(realClaude.artifacts.every((artifact) => artifact.source !== 'shared/forge-dispatch.md'));
  for (const artifact of realClaude.artifacts.filter((item) => markdownSourceIds.has(item.source_id))) {
    const definition = realManifest.sources.find((source) => source.source_id === artifact.source_id);
    const raw = fs.readFileSync(path.join(root, artifact.source), 'utf8');
    assert.strictEqual(
      artifact.content,
      claudeRenderer.addOriginHeader(raw, definition, artifact.source),
      `renderer Claude alterou projeção histórica de ${artifact.source}`,
    );
  }

  console.log('forge-codex-renderer tests passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
