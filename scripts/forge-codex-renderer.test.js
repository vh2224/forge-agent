#!/usr/bin/env node
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const renderer = require('./forge-codex-renderer');
const originalWrite = renderer.write;
renderer.write = (options = {}) => originalWrite({ questionSpawnSync: () => ({ status: 0, stdout: '' }), codexQuestionBinary: 'fixture-codex', ...options });
const interaction = require('./forge-interaction');
const claudeRenderer = require('./forge-claude-renderer');
const root = path.resolve(__dirname, '..'); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-Ω-')); const versionPattern = renderer.VERSION.replace(/\./g, '\\.');

const {
  PRODUCTION_DISPATCH_DIALECT,
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
  const report = renderer.render({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge, ...PRODUCTION_DISPATCH_DIALECT });
  const standing = require('./forge-instructions');
  const canonicalCommunication = standing.renderCommunicationContract();
  const instructionsArtifact = report.artifacts.find(item => item.kind === 'instructions');
  assert.strictEqual(instructionsArtifact.content.split(canonicalCommunication).length - 1, 1);
  assert.strictEqual(instructionsArtifact.content.split(standing.renderBlock()).length - 1, 1);
  for (const contract of [standing.renderPersonalContract(), standing.renderEntryContract()]) {
    assert.strictEqual(instructionsArtifact.content.split(contract).length - 1, 1);
  }
  const communicationManifest = JSON.parse(fs.readFileSync(path.join(root, 'forge-source-manifest.json'), 'utf8'));
  const communicationSource = communicationManifest.sources.find(source => source.source_id === 'communication');
  assert(communicationSource, 'communication source missing');
  assert.deepStrictEqual(communicationSource.inputs, ['shared/forge-communication.md']);
  assert.deepStrictEqual(communicationSource.render_targets, [{ path: 'shared/forge-communication.md', recursive: false }]);
  assert.strictEqual(communicationSource.owner, 'orchestration');
  assert.strictEqual(communicationSource.capability, 'integration-communication-contract');
  assert.strictEqual(communicationSource.security_role, 'public');
  assert.strictEqual(communicationSource.newline, 'lf');
  assert.deepStrictEqual(communicationSource.common, { format: 'markdown', delivery: 'managed-instruction-block' });
  assert.deepStrictEqual(communicationSource.conditional, { claude: { status: 'distributed' }, codex: { status: 'distributed' } });
  const communicationReport = JSON.parse(report.artifacts.find(item => item.kind === 'capabilities').content);
  assert.deepStrictEqual(communicationReport.surfaces.filter(source => source.source_id === 'communication'), [{ source_id: 'communication', status: 'distributed' }]);
  assert(!report.artifacts.some(item => item.source_id === 'communication'), 'communication emitted as separate Codex artifact');
  assert(fs.readFileSync(path.join(root, 'shared/forge-codex-renderer.md'), 'utf8').includes('standing.renderBlock'));
  console.log('PASS communication Codex: single managed block retains routing personal entry and communication contracts, manifest exact and capabilities distributed without a separate artifact');
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
  const first = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge, ...PRODUCTION_DISPATCH_DIALECT }); assert(first.written.length > 0); assert(fs.existsSync(path.join(project, 'AGENTS.md'))); assert(fs.existsSync(path.join(codex, 'config.toml'))); assert(!fs.existsSync(path.join(temp, 'Claude Home Ω')));
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
  const second = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge, ...PRODUCTION_DISPATCH_DIALECT }); assert.strictEqual(second.written.length, 0); assert(second.preserved.every((item) => item.reason === 'already-current' || item.reason === 'status-line-preserved'));
  // A projection left by the pre-fix renderer (marker above the fence) is still
  // recognized as generated, so the next write relocates the marker. Reading
  // ownership as "starts with the marker" would flip it to user-owned and stop
  // updates on every file the older renderer had produced.
  const legacySkill = path.join(codex, 'skills', 'forge-help', 'SKILL.md');
  fs.writeFileSync(legacySkill, `<!-- forge-source:codex -->\n\n${fs.readFileSync(path.join(root, 'skills', 'forge-help', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')}`);
  const relocated = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge, ...PRODUCTION_DISPATCH_DIALECT });
  assert(relocated.written.some((item) => item.destination === legacySkill), 'layout antigo tratado como user-owned');
  assert(fs.readFileSync(legacySkill, 'utf8').startsWith('---'));
  fs.writeFileSync(path.join(codex, 'config.toml'), 'operator = true\n'); const preserved = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge, ...PRODUCTION_DISPATCH_DIALECT }); assert(!preserved.conflicts.some((item) => item.destination === path.join(codex, 'config.toml'))); assert.match(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), /operator = true/); assert.match(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), /context-used/);

  // The ownership probe is anchored to the accepted positions, so a user-owned
  // document that merely QUOTES the marker stays theirs. Behavioural on purpose:
  // hasOrigin is internal, and what has to hold is that write() refuses to touch
  // the file — an unanchored probe classifies it as a projection and overwrites it.
  const operatorDoc = path.join(codex, 'skills', 'forge-help', 'SKILL.md');
  const operatorText = '# Notas do operador\n\nO marcador tem esta forma:\n\n```md\n<!-- forge-source:codex -->\n```\n';
  fs.writeFileSync(operatorDoc, operatorText);
  const quoted = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge, ...PRODUCTION_DISPATCH_DIALECT });
  assert(quoted.conflicts.some((item) => item.destination === operatorDoc), 'documento que apenas cita o marcador foi tratado como projeção');
  assert.strictEqual(fs.readFileSync(operatorDoc, 'utf8'), operatorText, 'arquivo do operador foi sobrescrito');
  fs.rmSync(operatorDoc, { force: true });
  const dry = renderer.write({ repo: root, projectRoot: project, codexHome: path.join(temp, 'dry codex'), forgeHome: path.join(temp, 'dry forge'), dryRun: true, ...PRODUCTION_DISPATCH_DIALECT }); assert.strictEqual(dry.dry_run, true); assert(!fs.existsSync(path.join(temp, 'dry codex')));
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
  assert(Object.isFrozen(PRODUCTION_DISPATCH_DIALECT), 'dialeto de produção precisa ser imutável');
  assert.deepStrictEqual(PRODUCTION_DISPATCH_DIALECT, {
    agentInvocation: 'spawn_agent(',
    hostRuntime: 'codex',
  });
  assert.deepStrictEqual(
    {
      agentInvocation: renderer.parseArgs([]).agentInvocation,
      hostRuntime: renderer.parseArgs([]).hostRuntime,
    },
    PRODUCTION_DISPATCH_DIALECT,
    'CLI standalone não semeou o dialeto de produção',
  );
  assert.deepStrictEqual(
    {
      agentInvocation: renderer.parseArgs(['--agent-invocation', 'test_agent(', '--host-runtime', 'test-host']).agentInvocation,
      hostRuntime: renderer.parseArgs(['--agent-invocation', 'test_agent(', '--host-runtime', 'test-host']).hostRuntime,
    },
    { agentInvocation: 'test_agent(', hostRuntime: 'test-host' },
    'overrides CLI válidos não foram preservados',
  );
  assert.throws(
    () => renderer.parseArgs(['--agent-invocation', '']),
    (error) => error.code === DISPATCH_REASON.AGENT_FORM_REQUIRED,
  );
  assert.throws(
    () => renderer.parseArgs(['--host-runtime', '']),
    (error) => error.code === DISPATCH_REASON.HOST_RUNTIME_INVALID,
  );
  const naiveStarts = fixtureText.match(/^<!-- forge:dispatch:start -->$/gm) || [];
  const scannedFixture = scanDispatchMarkers(fixtureText);
  assert(naiveStarts.length > 1, 'fixture não morde um detector global ingênuo');
  assert.strictEqual(scannedFixture.starts.length, 1, 'start citado foi tratado como marker real');
  assert.strictEqual(scannedFixture.ends.length, 1, 'end citado foi tratado como marker real');

  const locatedFixture = locateDispatchBlock(fixtureText);
  const fixturePrefix = fixtureText.slice(0, locatedFixture.start);
  const fixtureInterior = fixtureText.slice(locatedFixture.start, locatedFixture.end);
  const fixtureSuffix = fixtureText.slice(locatedFixture.end);
  const agentInvocation = PRODUCTION_DISPATCH_DIALECT.agentInvocation;
  const codexFixture = rewriteDispatchDialect(fixtureText, PRODUCTION_DISPATCH_DIALECT);
  const expectedInterior = fixtureInterior
    .split('Agent(').join(agentInvocation)
    .split('--host-runtime claude').join(`--host-runtime ${PRODUCTION_DISPATCH_DIALECT.hostRuntime}`);
  assertBytesEqual(codexFixture.slice(0, fixturePrefix.length), fixturePrefix, 'prefixo externo ao splice mudou');
  assert.strictEqual(codexFixture.slice(fixturePrefix.length, fixturePrefix.length + expectedInterior.length), expectedInterior);
  assertBytesEqual(codexFixture.slice(-fixtureSuffix.length), fixtureSuffix, 'sufixo externo ao splice mudou');
  assert(fixturePrefix.includes('Agent(') && fixturePrefix.includes('--host-runtime claude'));
  assert(fixtureSuffix.includes('Agent(') && fixtureSuffix.includes('--host-runtime claude'));
  assert(expectedInterior.includes(agentInvocation) && expectedInterior.includes('--host-runtime codex'));
  assert(!expectedInterior.includes('--host-runtime claude'));

  // R2: both substitutions must be selected from disjoint spans in the original
  // interior. The Agent replacement deliberately contains both exact host forms;
  // only independently matched tokens from the canonical source may change.
  const opaqueAgentInvocation = "spawn_agent({ hostRuntime:'claude', note:'--host-runtime claude' },";
  const disjointSource = [
    DISPATCH_MARKER_START,
    'Agent({ disjoint: true })',
    'node forge-worker.js --host-runtime claude --mode execute',
    "const request = { hostRuntime: 'claude' };",
    DISPATCH_MARKER_END,
    '',
  ].join('\n');
  const disjointOutput = rewriteDispatchDialect(disjointSource, {
    agentInvocation: opaqueAgentInvocation,
    hostRuntime: PRODUCTION_DISPATCH_DIALECT.hostRuntime,
  });
  assert(disjointOutput.includes(`${opaqueAgentInvocation}{ disjoint: true })`));
  assert(disjointOutput.includes('node forge-worker.js --host-runtime codex --mode execute'));
  assert(disjointOutput.includes("const request = { hostRuntime: 'codex' };"));
  assert.strictEqual((disjointOutput.match(/--host-runtime claude/g) || []).length, 1, 'texto inserido foi rescaneado');
  assert.strictEqual((disjointOutput.match(/hostRuntime:'claude'/g) || []).length, 1, 'host estruturado inserido foi rescaneado');
  assert.strictEqual((disjointOutput.match(/--host-runtime codex/g) || []).length, 1, 'token de origem não foi retargeted uma vez');
  assert.strictEqual((disjointOutput.match(/hostRuntime: 'codex'/g) || []).length, 1, 'host estruturado de origem não foi retargeted uma vez');

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
    ...PRODUCTION_DISPATCH_DIALECT,
  });
  const codexArtifact = codexFixtureReport.artifacts.find((item) => item.source === 'shared/templates/dispatch/dispatch-fence.md');
  assert(codexArtifact, 'fixture não atravessou o renderer Codex real');
  assert.strictEqual(codexArtifact.content, `${renderer.ORIGIN}\n\n${interaction.project(codexFixture).replace(/\r\n/g, '\n').replace(/\r/g, '\n')}`);

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
      ...PRODUCTION_DISPATCH_DIALECT,
      provenance: null,
    }),
    (error) => error.code === DISPATCH_REASON.START_WITHOUT_END,
  );
  assert.strictEqual(fs.existsSync(atomicProject), false, 'write parcial materializou projectRoot');
  assert.strictEqual(fs.existsSync(atomicCodex), false, 'write parcial materializou codexHome');
  assert.strictEqual(fs.existsSync(atomicForge), false, 'write parcial materializou forgeHome');

  // Enumerate exactly the four Markdown surfaces from the real manifest. The
  // census is non-empty per surface, excludes shared/forge-dispatch.md, includes
  // an Agent( outside Markdown fences, and limits the live dialect seam to the
  // three canonical orchestrator skills that now own one real marker pair.
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
  const managedSources = census.filter((entry) => {
    const markers = scanDispatchMarkers(entry.content);
    return markers.starts.length > 0 || markers.ends.length > 0;
  });
  assert.deepStrictEqual(managedSources.map((entry) => entry.source).sort(), [
    'skills/forge-auto/SKILL.md',
    'skills/forge-next/SKILL.md',
    'skills/forge-task/SKILL.md',
  ]);
  for (const entry of managedSources) {
    const markers = scanDispatchMarkers(entry.content);
    assert.strictEqual(markers.starts.length, 1, `${entry.source}: start marker inválido`);
    assert.strictEqual(markers.ends.length, 1, `${entry.source}: end marker inválido`);
  }
  const rewrittenCensus = census.map((entry) => ({
    ...entry,
    content: rewriteDispatchDialect(entry.content, PRODUCTION_DISPATCH_DIALECT),
  }));
  for (let index = 0; index < census.length; index++) {
    const managed = managedSources.some((entry) => entry.source === census[index].source);
    if (managed) {
      assert.notStrictEqual(rewrittenCensus[index].content, census[index].content, `dialeto inerte em ${census[index].source}`);
      assert(!locateDispatchBlock(rewrittenCensus[index].content)
        || !rewrittenCensus[index].content.slice(
          locateDispatchBlock(rewrittenCensus[index].content).start,
          locateDispatchBlock(rewrittenCensus[index].content).end,
        ).includes('Agent('), `Agent operacional sobreviveu em ${census[index].source}`);
    } else {
      assert.strictEqual(rewrittenCensus[index].content, census[index].content, `drift fora do seam em ${census[index].source}`);
    }
  }
  const originalHashes = hashCensus(census);
  const rewrittenHashes = hashCensus(rewrittenCensus);
  assert.deepStrictEqual(
    Object.keys(originalHashes).filter((sourceId) => originalHashes[sourceId] !== rewrittenHashes[sourceId]),
    ['skills'],
    'o seam Codex alterou uma superfície diferente de skills',
  );

  const realCodex = renderer.render({ repo: root, ...PRODUCTION_DISPATCH_DIALECT });
  const realClaude = claudeRenderer.render({ repo: root });
  for (const projection of [realCodex, realClaude]) {
    const task = projection.artifacts.find(item => item.source === 'skills/forge-task/SKILL.md');
    for (const token of ['Standalone physical roots and recovery', 'execution_contract v2', 'recoveryStateFile', 'Persist necessary questions by ID']) {
      assert(task.content.includes(token), 'projected task contract missing ' + token);
    }
  }
  assert(realCodex.artifacts.every((artifact) => artifact.source !== 'shared/forge-dispatch.md'));
  assert(realClaude.artifacts.every((artifact) => artifact.source !== 'shared/forge-dispatch.md'));
  const codexTask = realCodex.artifacts.find((item) => item.source === 'skills/forge-task/SKILL.md');
  const claudeTask = realClaude.artifacts.find((item) => item.source === 'skills/forge-task/SKILL.md');
  for (const [runtime, artifact] of [['codex', codexTask], ['claude', claudeTask]]) {
    assert(artifact, `${runtime} projection missing forge-task`);
    const preparation = artifact.content.slice(
      artifact.content.indexOf('### Canonical preparation caller'),
      artifact.content.indexOf('### Step 4.5'),
    );
    assert.match(preparation, /forge-task-preparation\.js/, `${runtime} projection lost the executable preparation caller`);
    assert.match(preparation, new RegExp(`hostRuntime: ["']${runtime}["']`), `${runtime} preparation request carries the wrong host`);
    for (const phase of ['brainstorm', 'discuss', 'research', 'plan']) {
      assert(preparation.includes(`phase:\"${phase}\"`), `${runtime} projection missing ${phase} caller`);
    }
    assert.doesNotMatch(preparation, /worker_mode:native|workerMode:\s*["']native["']/, `${runtime} projection forces native preparation`);
    assert.match(preparation, /nativeFailure:\{reason_code,provider_called:false\}/,
      `${runtime} projection lacks durable pre-provider native failure acceptance`);
    assert.doesNotMatch(preparation, /effort:\s*\{RESOLVED_EFFORT\}|thinking:\s*adaptive/,
      `${runtime} preparation prompt invents pre-resolution effort metadata`);
    assert.match(preparation, /task complexity: light\|standard\|heavy\|max/,
      `${runtime} preparation prompt omits the max task tier`);
  }
  for (const skill of ['forge-task', 'forge-auto', 'forge-next']) {
    const source = `skills/${skill}/SKILL.md`;
    const artifact = realCodex.artifacts.find((item) => item.source === source);
    assert(artifact, `Codex projection missing ${source}`);
    const block = locateDispatchBlock(artifact.content);
    assert(block, `Codex projection missing managed dispatch block in ${source}`);
    const native = artifact.content.slice(block.start, block.end);
    assert.match(native, /buildNativeInvocation/, `${source} must use the authoritative native adapter`);
    assert.match(native, /active (?:host |tool )?capabilit/i, `${source} must receive active capabilities from its caller`);
    assert.match(native, /full (?:model ID|`model`)/, `${source} must retain the full Codex model ID`);
    assert.match(native, /`reasoning_effort`/, `${source} must retain the Codex effort argument`);
    assert.match(native, /(?:forkTurns|fork_turns):?'none'/, `${source} must force a bounded Codex fork`);
    assert.match(native, /Never omit[\s\S]{0,80}model[\s\S]{0,80}inherit agent frontmatter/i,
      `${source} must forbid implicit model inheritance`);
    assert.doesNotMatch(native, /Agent\s*\(/, `${source} retained a Claude invocation in the Codex seam`);
    assert.doesNotMatch(native, /model:\s*\$MODEL_ALIAS|using frontmatter/i,
      `${source} retained the legacy alias/default inheritance path`);
  }
  for (const artifact of realClaude.artifacts.filter((item) => markdownSourceIds.has(item.source_id))) {
    const definition = realManifest.sources.find((source) => source.source_id === artifact.source_id);
    const raw = fs.readFileSync(path.join(root, artifact.source), 'utf8');
    assert.strictEqual(
      artifact.content,
      claudeRenderer.addOriginHeader(raw, definition, artifact.source),
      `renderer Claude alterou projeção histórica de ${artifact.source}`,
    );
  }

  // Inspect actual prompt consumers, not a simulated question state machine.
  for (const kind of ['instructions', 'agent', 'command', 'skill', 'dispatch']) {
    const consumers = realCodex.artifacts.filter(item => item.kind === kind);
    assert(consumers.length > 0);
    for (const item of consumers) {
      for (const rule of ['A required live decision remains pending', 'optional-only tool', 'Plan-only tool', 'approval-prohibited tool', 'returned pending handle is not an answer', 'multiSelect', 'questions per batch', 'separate, concise text message', 'auto/headless deferment']) assert(item.content.includes(rule), `${item.source}: ${rule}`);
    }
  }
  const discussion = realCodex.artifacts.find(item => item.destination.endsWith('forge-discusser.toml')).content;
  assert(!discussion.includes('proceed regardless'));
  assert(!discussion.includes('orchestrator always has the tool'));
  for (const name of ['forge-plan-gate.md', 'forge-review.md']) {
    assert(fs.readFileSync(path.join(root, 'shared', name), 'utf8').includes('shared/forge-interaction.md'));
  }
  const conflictHome = path.join(temp, 'questions-conflict');
  fs.mkdirSync(conflictHome);
  const conflictConfig = path.join(conflictHome, 'config.toml');
  fs.writeFileSync(conflictConfig, 'features = {}\n');
  const conflictReport = renderer.write({ repo: root, ...PRODUCTION_DISPATCH_DIALECT, codexHome: conflictHome, projectRoot: path.join(temp, 'questions-project'), forgeHome: path.join(temp, 'questions-forge'), questionSpawnSync: () => ({ status: 0, stdout: 'default_mode_request_user_input stable false\n' }) });
  assert(conflictReport.conflicts.some(item => item.destination === conflictConfig && item.reason === 'questions-manual-merge'));
  assert(fs.readFileSync(conflictConfig, 'utf8').includes('features = {}'));
  assert(!fs.readFileSync(conflictConfig, 'utf8').includes('default_mode_request_user_input'));

  // The actual generated consumers must distribute the host authority seam.
  for (const kind of ['instructions', 'agent', 'command', 'skill', 'dispatch']) {
    for (const item of realCodex.artifacts.filter(row => row.kind === kind)) {
      for (const rule of ['createRecoveryAuthorizationAdapter', 'registerStandingAuthorization',
        'readStandingAuthorization(reference)', 'tier safety ceiling', 'Standing permission never answers a functional question']) {
        assert(item.content.includes(rule), `${item.source}: missing recovery rule ${rule}`);
      }
      assert(!item.content.includes('60000ms'), `${item.source}: stale cumulative 60000ms clock`);
    }
  }
  const repeat = renderer.render({ repo: root, ...PRODUCTION_DISPATCH_DIALECT,
    codexHome: codex, projectRoot: project, forgeHome: forge });
  const again = renderer.render({ repo: root, ...PRODUCTION_DISPATCH_DIALECT,
    codexHome: codex, projectRoot: project, forgeHome: forge });
  assert.deepStrictEqual(repeat.artifacts, again.artifacts, 'recovery projection is deterministic');
  assert(repeat.procedure_context.content.includes('<!-- forge-procedure:distribution -->'));
  assert(repeat.procedure_context.content.includes('<!-- forge-procedure:core -->'));
  const procedureRepo = fixtureRepository('procedure-closure', 'Fixture dispatch\n').repo;
  const procedures = JSON.parse(fs.readFileSync(path.join(root, 'shared/forge-procedures.json'), 'utf8'));
  for (const file of ['shared/forge-procedures.json', 'shared/schemas/procedures.schema.json', ...procedures.modules.map(module => module.path)]) {
    fs.mkdirSync(path.dirname(path.join(procedureRepo, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(procedureRepo, file));
  }
  const procedureManifest = fixtureManifest();
  procedureManifest.sources.push(realManifest.sources.find(source => source.source_id === 'procedures'));
  const procedureProject = path.join(temp, 'partial-procedure-project');
  const procedureOptions = { repo: procedureRepo, manifest: procedureManifest, ...PRODUCTION_DISPATCH_DIALECT,
    projectRoot: procedureProject, codexHome: path.join(temp, 'invalid-procedure-host'), forgeHome: path.join(temp, 'invalid-procedure-forge') };
  const procedureFile = path.join(procedureRepo, 'shared/forge-procedures.json');
  const procedureBytes = fs.readFileSync(procedureFile);
  fs.unlinkSync(procedureFile);
  assert.throws(() => renderer.write(procedureOptions), /procedure-manifest-missing/);
  fs.writeFileSync(procedureFile, procedureBytes);
  const distributionFile = path.join(procedureRepo, 'shared/forge-procedure-distribution.md');
  const distributionBytes = fs.readFileSync(distributionFile);
  fs.unlinkSync(distributionFile);
  assert.throws(() => renderer.write(procedureOptions), /procedure-file-unreadable/);
  fs.writeFileSync(distributionFile, distributionBytes);
  assert.throws(() => renderer.write({ ...procedureOptions, manifest: fixtureManifest() }), /procedure-inventory-missing/);
  fs.mkdirSync(path.join(procedureProject, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(procedureProject, 'shared/forge-procedures.json'), procedureBytes);
  assert.throws(() => renderer.write(procedureOptions), /procedure-file-unreadable/);
  assert(!fs.existsSync(procedureOptions.codexHome), 'invalid closure wrote host artifacts');
  assert(!fs.existsSync(path.join(procedureProject, 'AGENTS.md')));

  // ── Relatório Codex parado em 4.8.0 (issue 280): causa reproduzida ─────────
  // Forma medida na instalação: chaves generated/runtime/surfaces/version, sem
  // marker possível e sem digest no registro de ownership. Antes da correção,
  // write() preservava esse arquivo como user_owned em toda execução.
  const legacyLabel = (label) => path.join(temp, `legacy report ${label} Ω`);
  const legacyReportBytes = `${JSON.stringify({ version: '4.8.0', runtime: 'codex', generated: true,
    surfaces: realManifest.sources.map((source) => ({ source_id: source.source_id,
      status: source.conditional && source.conditional.codex ? source.conditional.codex.status : 'common' })) }, null, 2)}\n`;
  const seedReport = (label, bytes) => {
    const forgeHome = legacyLabel(`${label} forge`);
    const file = path.join(forgeHome, 'adapters', 'codex', 'capabilities.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.mkdirSync(legacyLabel(`${label} project`), { recursive: true });
    return { file, options: { repo: root, ...PRODUCTION_DISPATCH_DIALECT, forgeHome, ownership: {}, provenance: null,
      codexHome: legacyLabel(`${label} codex`), projectRoot: legacyLabel(`${label} project`) } };
  };
  const legacySeed = seedReport('adopt', legacyReportBytes);
  const legacyRun = renderer.write(legacySeed.options);
  assert(!legacyRun.conflicts.some((item) => item.destination === legacySeed.file),
    'relatório legado gerado pelo Forge continuou user_owned sem marker nem digest');
  const ownershipModule = require('./forge-projection-ownership');
  const adoptedEntry = legacyRun.written.find((item) => item.destination === legacySeed.file);
  assert(adoptedEntry && adoptedEntry.reason === 'generated-report-adopted', 'adoção do relatório não foi nomeada');
  const adoptedBytes = fs.readFileSync(legacySeed.file, 'utf8');
  assert.strictEqual(JSON.parse(adoptedBytes).report_schema_version, 2);
  assert.strictEqual(legacyRun.ownership[ownershipModule.keyFor(legacySeed.file)], ownershipModule.digest(adoptedBytes),
    'o relatório adotado ficou fora do registro de ownership');
  const legacyDry = seedReport('adopt dry', legacyReportBytes);
  const legacyDryRun = renderer.write({ ...legacyDry.options, dryRun: true });
  assert.strictEqual(fs.readFileSync(legacyDry.file, 'utf8'), legacyReportBytes, 'dry-run reescreveu o relatório legado');
  assert(!Object.hasOwn(legacyDryRun.ownership, ownershipModule.keyFor(legacyDry.file)));

  // ── Relatório schema 2: campos, fonte, determinismo e coerência ─────────────
  const reportFile = path.join(forge, 'adapters', 'codex', 'capabilities.json');
  const reportBytes = fs.readFileSync(reportFile, 'utf8');
  const schema2 = JSON.parse(reportBytes);
  for (const [key, value] of Object.entries({ report_schema_version: 2, forge_source: 'codex-capabilities', generated: true,
    runtime: 'codex', core_version: renderer.VERSION, version: renderer.VERSION, generator: 'forge-codex-renderer' })) {
    assert.strictEqual(schema2[key], value, `campo de identidade ${key}`);
  }
  const catalogText = fs.readFileSync(path.join(root, 'forge-capabilities.json'), 'utf8');
  const catalogJson = JSON.parse(catalogText);
  assert.deepStrictEqual(schema2.source, {
    catalog: 'available',
    catalog_sha256: ownershipModule.digest(catalogText),
    catalog_schema_version: catalogJson.schema_version,
    source_manifest_sha256: ownershipModule.digest(require('./forge-source-manifest').normalize(realManifest)),
  });
  assert.deepStrictEqual(schema2.permissions, {
    native_custom_agents: { sandbox: 'inherited-from-parent-session', toml_sandbox_mode: 'declared-not-isolation-proof' },
    app_server_sidecar: { sandbox: 'per-turn-sandbox-policy' },
    headless_exec: { sandbox: 'explicit-cli-flags' },
    contract: 'docs/codex-agent-permissions.md',
  });
  // Raw, JSON-escaped and POSIX spellings: a Windows path inside JSON is escaped.
  const mentions = (text, location) => [location, JSON.stringify(location).slice(1, -1), location.replace(/\\/g, '/')].some((form) => text.includes(form));
  for (const forbidden of [temp, root, os.homedir(), forge]) assert(!mentions(reportBytes, forbidden), 'caminho absoluto no relatório');
  assert.doesNotMatch(reportBytes, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|"(?:generated_at|timestamp|captured_at)"/, 'timestamp no relatório');
  // The report's codex column must be the catalog CLI's codex column, row for row.
  const { spawnSync } = require('child_process');
  const matrixRun = spawnSync(process.execPath, [path.join(root, 'scripts', 'forge-capabilities.js'), '--matrix', '--json', '--cwd', root], { encoding: 'utf8', shell: false });
  assert.strictEqual(matrixRun.status, 0, matrixRun.stderr);
  const cliRows = JSON.parse(matrixRun.stdout).capabilities;
  assert.deepStrictEqual(schema2.capabilities, cliRows.map((row) => ({ capability_id: row.capability_id, kind: row.kind, required: row.required, codex: row.codex })),
    'classificação Codex do relatório diverge de --matrix --json');
  assert(schema2.capabilities.some((row) => row.codex === 'distributed') && schema2.capabilities.some((row) => row.codex === 'planned'));
  const rewrite = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge, ...PRODUCTION_DISPATCH_DIALECT });
  assert(!rewrite.written.some((item) => item.destination === reportFile), 'segunda escrita reescreveu o relatório');
  assertBytesEqual(fs.readFileSync(reportFile, 'utf8'), reportBytes, 'duas escritas seguidas divergiram');
  const renderedTwice = [0, 1].map(() => renderer.render({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge, ...PRODUCTION_DISPATCH_DIALECT })
    .artifacts.find((item) => item.kind === 'capabilities').content);
  assertBytesEqual(renderedTwice[0], renderedTwice[1], 'render do relatório não é determinístico');
  const catalogVariant = (edit) => { const value = structuredClone(catalogJson); edit(value); return JSON.stringify(value); };
  const invalidCatalogCases = [
    ['minimal empty catalog', JSON.stringify({ capabilities: [] })],
    ['empty capability list', catalogVariant(value => { value.capabilities = []; })],
    ['missing catalog schema', catalogVariant(value => { delete value.$schema; })],
    ['missing catalog version', catalogVariant(value => { delete value.schema_version; })],
    ['missing release identity', catalogVariant(value => { delete value.release; })],
    ['invalid host state', catalogVariant(value => { value.capabilities[0].hosts.codex = 'invented'; })],
    ['duplicate capability', catalogVariant(value => { value.capabilities.push(structuredClone(value.capabilities[0])); })],
    ['null capability', catalogVariant(value => { value.capabilities[0] = null; })],
  ];
  // Semantic catalog validation is shared by generation and inspection.
  for (const [label, catalogBytes] of [['catalog absent', null], ['catalog malformed', '{"capabilities": ['], ...invalidCatalogCases]) {
    const unavailableRepo = fixtureRepository(label, 'Fixture dispatch\n').repo;
    if (catalogBytes !== null) fs.writeFileSync(path.join(unavailableRepo, 'forge-capabilities.json'), catalogBytes);
    const unavailable = JSON.parse(renderer.render({ repo: unavailableRepo, manifest: fixtureManifest(), ...PRODUCTION_DISPATCH_DIALECT,
      projectRoot: path.join(unavailableRepo, 'project'), codexHome: path.join(unavailableRepo, 'codex'), forgeHome: path.join(unavailableRepo, 'forge') })
      .artifacts.find((item) => item.kind === 'capabilities').content);
    assert.deepStrictEqual({ ...unavailable.source, source_manifest_sha256: undefined },
      { catalog: 'unavailable', catalog_sha256: null, catalog_schema_version: null, source_manifest_sha256: undefined }, label);
    assert.strictEqual(unavailable.capabilities, null, label);
  }
  console.log('PASS C03 invalid catalogs: generation refuses missing malformed empty foreign and inconsistent semantic structures');

  // ── Freshness: current, stale, absent e invalid, somente leitura ────────────
  const treeBytes = (directory) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? treeBytes(full) : [[full, fs.readFileSync(full).toString('base64')]];
    });
  };
  const freshHome = legacyLabel('fresh forge');
  const freshReport = path.join(freshHome, 'adapters', 'codex', 'capabilities.json');
  const inspect = (extra = {}) => {
    const before = treeBytes(freshHome);
    const inspection = renderer.inspectCapabilitiesReport({ forgeHome: freshHome, ...extra });
    assert.deepStrictEqual(treeBytes(freshHome), before, 'inspectCapabilitiesReport alterou o Forge home');
    assert(!mentions(JSON.stringify(inspection), freshHome) && !mentions(JSON.stringify(inspection), temp), 'caminho absoluto no diagnóstico');
    return inspection;
  };
  const expectState = (inspection, state, reasons, label) => {
    assert.strictEqual(inspection.state, state, `${label}: ${JSON.stringify(inspection)}`);
    assert.deepStrictEqual(inspection.reasons, reasons, label);
  };
  fs.mkdirSync(freshHome, { recursive: true });
  expectState(inspect(), 'absent', ['report-absent'], 'absent');
  const freshProject = legacyLabel('fresh project'); fs.mkdirSync(freshProject, { recursive: true });
  renderer.write({ repo: root, ...PRODUCTION_DISPATCH_DIALECT, forgeHome: freshHome, codexHome: legacyLabel('fresh codex'), projectRoot: freshProject, provenance: null });
  fs.writeFileSync(path.join(freshHome, 'VERSION'), `${renderer.VERSION}\n`);
  fs.copyFileSync(path.join(root, 'forge-capabilities.json'), path.join(freshHome, 'forge-capabilities.json'));
  const current = inspect();
  expectState(current, 'current', [], 'current');
  assert.strictEqual(current.core_version, renderer.VERSION);
  assert.strictEqual(current.catalog_sha256, ownershipModule.digest(catalogText));
  expectState(inspect({ version: '0.0.1' }), 'stale', ['core-version-mismatch'], 'core mismatch');
  fs.writeFileSync(path.join(freshHome, 'VERSION'), '0.0.2\n');
  expectState(inspect(), 'stale', ['core-version-mismatch'], 'installed VERSION file is the comparison');
  fs.writeFileSync(path.join(freshHome, 'VERSION'), `${renderer.VERSION}\n`);
  const installedCatalog = path.join(freshHome, 'forge-capabilities.json');
  fs.writeFileSync(installedCatalog, catalogVariant(value => { value.capabilities[0].hosts.codex = 'planned'; }));
  expectState(inspect(), 'stale', ['catalog-digest-mismatch'], 'catalog mismatch');
  for (const [label, bytes] of invalidCatalogCases) {
    fs.writeFileSync(installedCatalog, bytes);
    expectState(inspect(), 'stale', ['installed-catalog-unavailable'], label);
  }
  console.log('PASS C03 invalid catalogs: installed semantic failures cannot establish current freshness');
  fs.writeFileSync(installedCatalog, '{ malformed');
  expectState(inspect(), 'stale', ['installed-catalog-unavailable'], 'installed catalog malformed');
  fs.rmSync(installedCatalog);
  expectState(inspect(), 'stale', ['installed-catalog-unavailable'], 'installed catalog absent');
  fs.copyFileSync(path.join(root, 'forge-capabilities.json'), installedCatalog);
  const schema2Bytes = fs.readFileSync(freshReport, 'utf8');
  const withSource = (source) => `${JSON.stringify({ ...JSON.parse(schema2Bytes), source: { ...JSON.parse(schema2Bytes).source, ...source } }, null, 2)}\n`;
  fs.writeFileSync(freshReport, `${JSON.stringify({ ...JSON.parse(withSource({ catalog: 'unavailable', catalog_sha256: null, catalog_schema_version: null })), capabilities: null })}\n`);
  expectState(inspect(), 'stale', ['catalog-unavailable'], 'report without catalog cannot prove freshness');
  fs.writeFileSync(freshReport, legacyReportBytes);
  expectState(inspect({ version: '4.8.0' }), 'stale', ['legacy-shape'], 'legacy shape');
  expectState(inspect(), 'stale', ['legacy-shape', 'core-version-mismatch'], 'legacy 4.8.0');
  const reportVariant = (edit) => { const value = JSON.parse(schema2Bytes); edit(value); return `${JSON.stringify(value, null, 2)}\n`; };
  const unknownReports = [
    ['future report schema', reportVariant(value => { value.report_schema_version = 99; })],
    ['operator schema2 extension', reportVariant(value => { value.operator_note = 'keep'; })],
    ['incomplete report identity', reportVariant(value => { delete value.permissions; })],
    ['unknown source extension', reportVariant(value => { value.source.operator_note = 'keep'; })],
    ['invalid catalog digest', reportVariant(value => { value.source.catalog_sha256 = 'not-a-digest'; })],
    ['missing capability rows', reportVariant(value => { value.capabilities = []; })],
    ['invalid capability row', reportVariant(value => { value.capabilities[0].required = 'yes'; })],
    ['invalid permissions', reportVariant(value => { value.permissions = {}; })],
    ['version mirror mismatch', reportVariant(value => { value.version = '0.0.1'; })],
    ['invalid surface row', reportVariant(value => { value.surfaces[0].operator_note = 'keep'; })],
  ];
  const invalidCases = [
    ['unreadable-json', '{ "runtime": "codex", '],
    ['unreadable-json', '[1, 2]\n'],
    ['wrong-runtime', legacyReportBytes.replace('"runtime": "codex"', '"runtime": "claude"')],
    ['not-generated', legacyReportBytes.replace('"generated": true', '"generated": false')],
    ['unrecognized-shape', `${JSON.stringify({ runtime: 'codex', generated: true, operator: 'notes' })}\n`],
    ['oversize', `${JSON.stringify({ runtime: 'codex', generated: true, version: '4.8.0', surfaces: [{ source_id: 'x'.repeat(renderer.REPORT_MAX_BYTES) }] })}\n`],
    ...unknownReports.map(([, bytes]) => ['unrecognized-shape', bytes]),
  ];
  for (const [reason, bytes] of invalidCases) {
    fs.writeFileSync(freshReport, bytes);
    expectState(inspect(), 'invalid', [reason], reason);
  }
  // CLI: read-only, exit 0 only for current.
  fs.writeFileSync(freshReport, schema2Bytes);
  const cli = (argv) => { let out = ''; let err = ''; const before = treeBytes(freshHome); const code = renderer.main(argv, (text) => { out += text; }, (text) => { err += text; }); assert.deepStrictEqual(treeBytes(freshHome), before, 'CLI --inspect-report escreveu'); return { code, out, err }; };
  const cliCurrent = cli(['--inspect-report', '--forge-home', freshHome, '--json']);
  assert.strictEqual(cliCurrent.code, 0, cliCurrent.err);
  assert.strictEqual(JSON.parse(cliCurrent.out).state, 'current');
  assert(!mentions(cliCurrent.out, freshHome));
  fs.writeFileSync(freshReport, legacyReportBytes);
  const cliStale = cli(['--inspect-report', '--forge-home', freshHome]);
  assert.strictEqual(cliStale.code, 1);
  assert.match(cliStale.out, /^Codex capabilities report: stale \(legacy-shape, core-version-mismatch\) core 4\.8\.0;/);
  fs.rmSync(freshReport);
  assert.strictEqual(cli(['--inspect-report', '--forge-home', freshHome, '--json']).code, 1);

  // ── Ownership nas duas direções: só o relatório reconhecido é adotado ───────
  const olderSchema2 = `${JSON.stringify({ ...JSON.parse(schema2Bytes), core_version: '4.40.0', version: '4.40.0' }, null, 2)}\n`;
  for (const [label, bytes] of [['legacy crlf', legacyReportBytes.replace(/\n/g, '\r\n')], ['older schema 2', olderSchema2]]) {
    const seed = seedReport(label, bytes);
    const run = renderer.write(seed.options);
    assert(!run.conflicts.some((item) => item.destination === seed.file), `${label}: relatório gerado não foi adotado`);
    assert.strictEqual(JSON.parse(fs.readFileSync(seed.file, 'utf8')).core_version, renderer.VERSION, label);
  }
  const foreignCases = [
    ['operator json', '{"operator":true}\n'],
    ['operator text', 'anotações do operador\n'],
    ['claude runtime', legacyReportBytes.replace('"runtime": "codex"', '"runtime": "claude"')],
    ['not generated', legacyReportBytes.replace('"generated": true', '"generated": false')],
    ['extra key', `${JSON.stringify({ ...JSON.parse(legacyReportBytes), operator_note: 'keep' }, null, 2)}\n`],
    ['wrong source', `${JSON.stringify({ ...JSON.parse(schema2Bytes), forge_source: 'operator' }, null, 2)}\n`],
    ['oversize legacy shape', invalidCases.find(([reason]) => reason === 'oversize')[1]],
    ...unknownReports,
  ];
  for (const [label, bytes] of foreignCases) {
    for (const mismatchingRecord of [false, true]) {
    const seed = seedReport(`${label} ${mismatchingRecord}`, bytes);
    const run = renderer.write({ ...seed.options, ...(mismatchingRecord ? { ownership: { [ownershipModule.keyFor(seed.file)]: ownershipModule.digest('previous generated bytes') } } : {}) });
    const conflict = run.conflicts.find((item) => item.destination === seed.file);
    assert(conflict && conflict.reason === 'user_owned', `${label}: conteúdo não gerado perdeu o conflict user_owned`);
    assert.strictEqual(fs.readFileSync(seed.file, 'utf8'), bytes, `${label}: bytes do operador sobrescritos`);
    if (mismatchingRecord) assert.strictEqual(run.ownership[ownershipModule.keyFor(seed.file)], ownershipModule.digest('previous generated bytes'), `${label}: histórico de ownership alterado`);
    else assert(!Object.hasOwn(run.ownership, ownershipModule.keyFor(seed.file)), `${label}: conteúdo alheio entrou no registro`);
    }
  }
  console.log('PASS C03 report recognition: future incomplete operator-extended and invalid schema2 bytes stay user-owned with absent or mismatching digest');
  // The recognized-report rung is scoped to kind capabilities: the same bytes in
  // any other managed destination keep the marker rule and stay the operator's.
  const otherKind = seedReport('other kind', legacyReportBytes);
  const otherSkill = path.join(otherKind.options.codexHome, 'skills', 'forge-help', 'SKILL.md');
  fs.mkdirSync(path.dirname(otherSkill), { recursive: true });
  fs.writeFileSync(otherSkill, legacyReportBytes);
  const otherRun = renderer.write(otherKind.options);
  assert(otherRun.conflicts.some((item) => item.destination === otherSkill && item.reason === 'user_owned'), 'regra de ownership de outro artefato mudou');
  assert.strictEqual(fs.readFileSync(otherSkill, 'utf8'), legacyReportBytes);
  // The existing digest rung still grants: operator-looking bytes we recorded are ours.
  const recordedSeed = seedReport('recorded digest', '{"operator":true}\n');
  const recordedRun = renderer.write({ ...recordedSeed.options, ownership: { [ownershipModule.keyFor(recordedSeed.file)]: ownershipModule.digest('{"operator":true}\n') } });
  assert(!recordedRun.conflicts.some((item) => item.destination === recordedSeed.file), 'rung de digest deixou de conceder');

  // ── Permissões: TOML nunca acima de workspace-write e args nativos exatos ───
  const agentTomls = realCodex.artifacts.filter((item) => item.kind === 'agent');
  assert(agentTomls.length >= 10, 'censo de TOMLs de agente vazio');
  for (const toml of agentTomls) {
    const sandboxLines = toml.content.split('\n').filter((line) => /^\s*sandbox_mode\s*=/.test(line));
    assert.deepStrictEqual(sandboxLines, ['sandbox_mode = "workspace-write"'], `${toml.source}: sandbox_mode diferente de workspace-write`);
    assert(!/danger-full-access|dangerFullAccess/.test(toml.content.split('developer_instructions =')[0]), `${toml.source}: sandbox amplo declarado`);
    const lines = toml.content.split('\n');
    assert.strictEqual(lines[lines.indexOf('sandbox_mode = "workspace-write"') - 1], renderer.AGENT_SANDBOX_COMMENT, `${toml.source}: comentário de herança ausente`);
    assert(lines[0].startsWith('# forge-source:codex-agent-'), `${toml.source}: marker deixou a linha 1`);
  }
  assert.match(renderer.AGENT_SANDBOX_COMMENT, /^# .*sessão pai.*não prova isolamento por agente.*docs\/codex-agent-permissions\.md/);
  const { buildNativeInvocation } = require('./forge-native-invocation');
  const nativeCall = buildNativeInvocation({
    hostRuntime: 'codex',
    resolvedDispatch: { host_runtime: 'codex', resolved_worker_engine: 'codex', dispatch_engine: 'codex', worker_mode: 'native',
      dispatch_allowed: true, config_ok: true, model_requested: 'gpt-6-sol', model_resolved: 'gpt-6-sol', model: 'gpt-6-sol', effort: 'high' },
    activeCapabilities: { available: true, tool: 'spawn_agent', source: 'renderer-test-active-tool', models: ['gpt-6-sol'], reasoning_efforts: ['high'], fork_turns: ['none'] },
    agentType: 'forge-reviewer', taskName: 'review-T05', prompt: 'review fixture', forkTurns: 'none',
  });
  assert.strictEqual(nativeCall.ok, true, JSON.stringify(nativeCall));
  assert.deepStrictEqual(Object.keys(nativeCall.args).sort(), ['agent_type', 'fork_turns', 'message', 'model', 'reasoning_effort', 'task_name'],
    'args nativos Codex ganharam ou perderam campos');
  assert.deepStrictEqual({ model: nativeCall.args.model, reasoning_effort: nativeCall.args.reasoning_effort }, { model: 'gpt-6-sol', reasoning_effort: 'high' },
    'modelo e esforço resolvidos não chegaram intactos');
  const permissionsDoc = fs.readFileSync(path.join(root, 'docs', 'codex-agent-permissions.md'), 'utf8');
  for (const anchor of ['forge-native-invocation.js', 'forge-xllm.js', 'forge-headless.js', 'forge-dispatch-policy.js', 'G2', 'Nenhum escape de sandbox foi demonstrado']) {
    assert(permissionsDoc.includes(anchor), `contrato de permissões sem ${anchor}`);
  }
  assert(fs.readFileSync(path.join(root, 'shared', 'forge-codex-renderer.md'), 'utf8').includes('docs/codex-agent-permissions.md'), 'contrato do renderer não liga o contrato de permissões');
  assert.doesNotMatch(permissionsDoc, /vira sandbox do SO apenas[^\n]*sidecar Claude/, 'allowlist Claude apresentada como sandbox do SO');
  assert.match(permissionsDoc, /allowlists e permission mode do Claude são controles do host, não prova de sandbox independente do SO/);
  console.log('PASS C04 Claude permissions: tool and permission controls do not claim an independent OS sandbox');
  console.log('forge-codex-renderer tests passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
