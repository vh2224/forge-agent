#!/usr/bin/env node
'use strict';

// Codex-native projection. It consumes the same source manifest as Claude but
// never resolves, reads, or writes a Claude home.
const fs = require('fs');
const path = require('path');
const { resolveForgePaths } = require('./forge-home');
const sourceManifest = require('./forge-source-manifest');
const ownership = require('./forge-projection-ownership');
const { VERSION } = require('./forge-version');

const RUNTIME = 'codex';
const ORIGIN = '<!-- forge-source:codex -->';
const TOML_ORIGIN = '# forge-source:codex';
const REASON = Object.freeze({ unavailable: 'unavailable', user_owned: 'user_owned', invalid_options: 'invalid_options', missing_source: 'missing_source' });

function norm(value) { return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }
function tomlOrigin(kind) { return `${TOML_ORIGIN}-${kind} version=${VERSION}`; }
// YAML frontmatter must remain on line 1, so the marker sits below the closing
// fence when there is one. Ownership therefore probes the accepted positions
// rather than requiring the marker to be the very first byte.
const FRONTMATTER = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;
// The three positions a managed projection can carry its marker in — markdown at
// the top (no frontmatter), markdown right below the closing fence, and TOML on
// line 1. Anchored on purpose: a USER file that merely quotes the marker in a
// fenced block is not a projection, and classifying it as one overwrites it.
const MD_MARKER_AT_TOP = /^<!-- forge-source:[^\n]* -->[ \t]*\n\n?/;
const MD_MARKER_AFTER_FRONTMATTER = /^(---[ \t]*\n[\s\S]*?\n---[ \t]*\n)\n?<!-- forge-source:[^\n]* -->[ \t]*\n/;
const TOML_MARKER_AT_TOP = /^# forge-source:[^\n]*\n/;
function withOrigin(value) {
  const body = norm(value);
  const fence = FRONTMATTER.exec(body);
  if (fence) return `${body.slice(0, fence[0].length)}\n${ORIGIN}\n${body.slice(fence[0].length)}`;
  return `${ORIGIN}\n\n${body}`;
}
function hasOrigin(value) {
  const text = norm(String(value));
  return MD_MARKER_AT_TOP.test(text) || MD_MARKER_AFTER_FRONTMATTER.test(text) || TOML_MARKER_AT_TOP.test(text);
}
function exists(file) { try { return fs.existsSync(file); } catch (_) { return false; } }
function walk(root) {
  if (!exists(root)) return [];
  if (fs.statSync(root).isFile()) return [root];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(full)); else if (entry.isFile()) result.push(full);
  }
  return result;
}
function safe(root, relative) {
  const clean = String(relative).split(/[\\/]/).filter(Boolean).join(path.sep);
  const resolvedRoot = path.resolve(root); const target = path.resolve(resolvedRoot, clean);
  if (!clean || clean.split(path.sep).includes('..') || (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`))) throw Object.assign(new Error(`unsafe destination ${relative}`), { code: REASON.invalid_options });
  return target;
}
function roots(options) {
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const paths = resolveForgePaths({ cwd: repo, forgeHome: options.forgeHome, codexHome: options.codexHome, env: options.env, userHome: options.userHome, platform: options.platform });
  const projectRoot = path.resolve(options.projectRoot || repo);
  const codexHome = paths.runtimeHomes.codex;
  if (/(?:^|[\\/])\.claude(?:[\\/]|$)/i.test(codexHome)) throw Object.assign(new Error('Codex home não pode apontar para o host Claude'), { code: REASON.invalid_options });
  return { repo, forgeHome: paths.forgeHome, codexHome, projectRoot };
}
function manifestFor(root, options) {
  const manifest = options.manifest || JSON.parse(fs.readFileSync(options.manifestFile || path.join(root.repo, 'forge-source-manifest.json'), 'utf8'));
  sourceManifest.audit(manifest); return manifest;
}
function codexSources(manifest) {
  return manifest.sources.filter((source) => {
    const state = source.conditional && source.conditional.codex;
    return !state || !['unavailable', 'planned'].includes(state.status);
  });
}
function tomlMultiline(value) {
  return norm(value).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}
function render(options = {}) {
  const root = roots(options); const manifest = manifestFor(root, options); const sources = codexSources(manifest); const artifacts = [];
  const add = (sourceId, source, destination, content, kind) => artifacts.push({ source_id: sourceId, source, destination, content: norm(content), newline: 'lf', kind });
  const common = sources.filter((source) => ['agents', 'commands', 'skills', 'dispatch-templates'].includes(source.source_id));
  const agents = sources.find((source) => source.source_id === 'agents');
  const agentFiles = agents ? walk(path.join(root.repo, agents.inputs[0])).filter((file) => file.endsWith('.md')) : [];
  const instructions = [ORIGIN, `# Forge Agent ${VERSION} — Codex host`, '', 'Estas instruções são geradas a partir das fontes canônicas do Forge.', '', '## Superfícies comuns', ...common.map((source) => `- ${source.source_id}: ${source.capability}`), '', '## Agentes customizados', ...agentFiles.map((file) => `- ${path.basename(file, '.md')}: .codex/agents/${path.basename(file, '.md')}.toml`), '', '## Skills e comandos', '- Conteúdo canônico materializado em `$CODEX_HOME/skills`, `$CODEX_HOME/commands` e `$CODEX_HOME/templates/dispatch`.', ''].join('\n');
  add('codex-instructions', 'AGENTS.md', path.join(root.projectRoot, 'AGENTS.md'), instructions, 'instructions');
  for (const file of agentFiles) {
    const name = path.basename(file, '.md');
    const source = fs.readFileSync(file, 'utf8');
    const config = [tomlOrigin(`agent-${name}`), `name = "${name}"`, `description = "Forge ${name.replace(/^forge-/, '')} worker"`, 'sandbox_mode = "workspace-write"', 'developer_instructions = """', tomlMultiline(source), '"""', ''].join('\n');
    add('agents', path.relative(root.repo, file).replace(/\\/g, '/'), path.join(root.codexHome, 'agents', `${name}.toml`), config, 'agent');
  }
  const commandSource = sources.find((source) => source.source_id === 'commands');
  if (commandSource) for (const file of walk(path.join(root.repo, commandSource.inputs[0])).filter((item) => item.endsWith('.md'))) {
    add('commands', path.relative(root.repo, file).replace(/\\/g, '/'), path.join(root.codexHome, 'commands', path.basename(file)), withOrigin(fs.readFileSync(file, 'utf8')), 'command');
  }
  const skillsSource = sources.find((source) => source.source_id === 'skills');
  if (skillsSource) for (const file of walk(path.join(root.repo, skillsSource.inputs[0])).filter((item) => /SKILL\.md$/i.test(item))) {
    const relative = path.relative(path.join(root.repo, skillsSource.inputs[0]), file);
    add('skills', path.relative(root.repo, file).replace(/\\/g, '/'), path.join(root.codexHome, 'skills', relative), withOrigin(fs.readFileSync(file, 'utf8')), 'skill');
  }
  const dispatchSource = sources.find((source) => source.source_id === 'dispatch-templates');
  if (dispatchSource) for (const file of walk(path.join(root.repo, dispatchSource.inputs[0])).filter((item) => item.endsWith('.md'))) {
    add('dispatch-templates', path.relative(root.repo, file).replace(/\\/g, '/'), path.join(root.codexHome, 'templates', 'dispatch', path.basename(file)), `${ORIGIN}\n\n${norm(fs.readFileSync(file, 'utf8'))}`, 'dispatch');
  }
  const config = `${tomlOrigin('config')}\n[forge]\nversion = "${VERSION}"\nhost_runtime = "codex"\nsource_manifest = "forge-source-manifest.json"\n`;
  add('codex-config', 'config.toml', path.join(root.codexHome, 'config.toml'), config, 'config');
  const capabilities = { version: VERSION, runtime: RUNTIME, generated: true, surfaces: manifest.sources.map((source) => ({ source_id: source.source_id, status: source.conditional && source.conditional.codex ? source.conditional.codex.status : 'common' })) };
  add('codex-capabilities', 'forge-codex-capabilities.json', path.join(root.forgeHome, 'adapters', 'codex', 'capabilities.json'), `${JSON.stringify(capabilities, null, 2)}\n`, 'capabilities');
  artifacts.sort((a, b) => a.destination.localeCompare(b.destination));
  return { runtime: RUNTIME, version: VERSION, repo: root.repo, forge_home: root.forgeHome, codex_home: root.codexHome, project_root: root.projectRoot, artifacts };
}
function write(options = {}) {
  const report = render(options); const written = []; const preserved = []; const conflicts = [];
  // Same ownership rule as the Claude renderer, from the same module. This host
  // projects `capabilities.json`, a format that can never carry a marker — so
  // without the digest rung that file froze on first divergence exactly like the
  // Claude-side JSON did, and each run reported success over it.
  const recorded = (options.ownership && typeof options.ownership === 'object') ? options.ownership : {};
  for (const artifact of report.artifacts) {
    const current = exists(artifact.destination) ? fs.readFileSync(artifact.destination, 'utf8') : null;
    if (current !== null && norm(current) === artifact.content) { preserved.push({ ...artifact, reason: 'already-current' }); continue; }
    const verdict = ownership.decide({
      current,
      recordedDigest: recorded[ownership.keyFor(artifact.destination)],
      markerPresent: current !== null && hasOrigin(current),
      migrateLegacy: Boolean(options.update && options.migrateLegacy),
    });
    if (!verdict.ours) { preserved.push({ ...artifact, reason: REASON.user_owned }); conflicts.push({ destination: artifact.destination, reason: REASON.user_owned }); continue; }
    if (options.dryRun) { written.push({ ...artifact, dry_run: true }); continue; }
    fs.mkdirSync(path.dirname(artifact.destination), { recursive: true }); fs.writeFileSync(artifact.destination, artifact.content, 'utf8'); written.push(artifact);
  }
  const ownedNow = [...written, ...preserved.filter((item) => item.reason === 'already-current')];
  const nextOwnership = { ...recorded, ...ownership.recordOf(ownedNow) };
  return { ...report, written, preserved, conflicts, ownership: options.dryRun ? recorded : nextOwnership, changed: written.some((item) => !item.dry_run), dry_run: Boolean(options.dryRun) };
}
function parseArgs(argv = process.argv.slice(2)) { const out = { repo: path.resolve(__dirname, '..') }; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--repo') out.repo = argv[++i]; else if (arg === '--codex-home') out.codexHome = argv[++i]; else if (arg === '--forge-home') out.forgeHome = argv[++i]; else if (arg === '--project-root') out.projectRoot = argv[++i]; else if (arg === '--manifest') out.manifestFile = argv[++i]; else if (arg === '--dry-run') out.dryRun = true; else if (arg === '--json') out.json = true; else if (arg === '--help' || arg === '-h') out.help = true; else throw Object.assign(new Error(`opção desconhecida: ${arg}`), { code: REASON.invalid_options }); } return out; }
function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), error = process.stderr.write.bind(process.stderr)) { try { const options = parseArgs(argv); if (options.help) { output('Usage: forge-codex-renderer.js [--repo DIR] [--codex-home DIR] [--forge-home DIR] [--project-root DIR] [--dry-run] [--json]\n'); return 0; } const report = write(options); output(options.json ? `${JSON.stringify(report)}\n` : `Codex renderer ${VERSION}: ${report.written.length} written, ${report.preserved.length} preserved\n`); return 0; } catch (e) { error(`forge-codex-renderer: ${e.code || 'error'}: ${e.message}\n`); return 1; } }
if (require.main === module) process.exitCode = main();
module.exports = { VERSION, RUNTIME, REASON, render, write, parseArgs, main };
