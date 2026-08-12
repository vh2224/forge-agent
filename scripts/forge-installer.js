#!/usr/bin/env node
'use strict';

// Cross-platform Forge installer core. Shell wrappers only translate flags;
// every path, copy, backup and migration operation lives here so Bash and
// PowerShell have identical semantics.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveForgePaths } = require('./forge-home');
const { detect: detectCapabilities } = require('./forge-capabilities');
const { generate: generateProjections } = require('./forge-generate');
const { VERSION } = require('./forge-version');

const RUNTIMES = Object.freeze(['claude', 'codex', 'both']);
const MANAGED_CORE = Object.freeze([
  'scripts', 'schemas', 'shared', 'bin', 'forge-capabilities.json', 'forge-prefs.schema.json',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const result = { runtime: 'claude', update: false, dryRun: false, noModelProbe: false, withApp: false, repo: path.resolve(__dirname, '..') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') result.runtime = argv[++i] || '';
    else if (arg === '--update') result.update = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--no-model-probe') result.noModelProbe = true;
    else if (arg === '--capability-timeout') result.capabilityTimeout = Number(argv[++i] || '');
    else if (arg === '--migrate-legacy') result.migrateLegacy = true;
    else if (arg === '--with-app') result.withApp = true;
    else if (arg === '--repo') result.repo = path.resolve(argv[++i] || '');
    else if (arg === '--forge-home') result.forgeHome = path.resolve(argv[++i] || '');
    else if (arg === '--claude-home') result.claudeHome = path.resolve(argv[++i] || '');
    else if (arg === '--codex-home') result.codexHome = path.resolve(argv[++i] || '');
    else if (arg === '--project-root') result.projectRoot = path.resolve(argv[++i] || '');
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  if (result.capabilityTimeout !== undefined && (!Number.isFinite(result.capabilityTimeout) || result.capabilityTimeout <= 0)) throw new Error(`capability timeout inválido: ${JSON.stringify(result.capabilityTimeout)}`);
  if (!RUNTIMES.includes(result.runtime)) throw new Error(`runtime inválido: ${JSON.stringify(result.runtime)} (use claude, codex ou both)`);
  return result;
}

function exists(file) { try { return fs.existsSync(file); } catch (_) { return false; } }

function walk(root) {
  if (!exists(root)) return [];
  if (fs.statSync(root).isFile()) return [root];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function relativeFiles(root) { return walk(root).map((file) => path.relative(root, file)); }

function copyFile(source, destination, plan, options) {
  const record = { op: 'copy', source, destination };
  plan.push(record);
  if (options.dryRun) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyTree(sourceRoot, destinationRoot, plan, options) {
  for (const relative of relativeFiles(sourceRoot)) copyFile(path.join(sourceRoot, relative), path.join(destinationRoot, relative), plan, options);
}

function backupTree(sourceRoot, destinationRoot, plan, options) {
  for (const relative of relativeFiles(sourceRoot)) copyFile(path.join(sourceRoot, relative), path.join(destinationRoot, relative), plan, options);
}

function selectedRuntimes(runtime) { return runtime === 'both' ? ['claude', 'codex'] : [runtime]; }

function adapterSources(repo) {
  const agents = path.join(repo, 'agents');
  const commands = path.join(repo, 'commands');
  const skills = path.join(repo, 'skills');
  const dispatch = path.join(repo, 'shared', 'templates', 'dispatch');
  return {
    agents: relativeFiles(agents).filter((name) => /^forge.*\.md$/i.test(name)).map((name) => path.join(agents, name)),
    commands: relativeFiles(commands).filter((name) => /^forge.*\.md$/i.test(name)).map((name) => path.join(commands, name)),
    skills: relativeFiles(skills).filter((name) => /^forge-[^\\/]+[\\/]SKILL\.md$/i.test(name)).map((name) => path.join(skills, name)),
    dispatch: relativeFiles(dispatch).filter((name) => /\.md$/i.test(name)).map((name) => path.join(dispatch, name)),
  };
}

function writeText(file, text, plan, options) {
  plan.push({ op: 'write', destination: file, bytes: Buffer.byteLength(text) });
  if (options.dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function copyIfMissing(source, destination, plan, options) {
  if (exists(destination)) return false;
  copyFile(source, destination, plan, options);
  return true;
}

function readJsonIfPresent(file) {
  if (!exists(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function projectionComplete(paths, host, projectRoot) {
  const manifestFile = path.join(paths.adapters[host], 'manifest.json');
  const manifest = readJsonIfPresent(manifestFile);
  if (!manifest || manifest.runtime !== host || !Array.isArray(manifest.files)) return false;
  if (Array.isArray(manifest.conflicts) && manifest.conflicts.length > 0) return false;
  const homeComplete = manifest.files.every((relative) => exists(path.join(paths.runtimeHomes[host], relative)));
  const projectComplete = !Array.isArray(manifest.project_files)
    || manifest.project_files.every((relative) => exists(path.join(projectRoot, relative)));
  return homeComplete && projectComplete;
}

function capabilityReport(repo, runtime, options) {
  if (options.skipCapabilityCheck || options.noModelProbe) return null;
  return detectCapabilities(repo, {
    runtime,
    binaries: options.binaries,
    env: options.env,
    timeout: options.capabilityTimeout,
  });
}

function backupId(options) {
  if (options.dryRun) return `backup-${VERSION}-dry-run`;
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  return `backup-${VERSION}-${suffix}`;
}

function backupExisting(paths, backupRoot, plan, options) {
  const files = [];
  for (const root of paths) {
    const rootIsFile = exists(root) && fs.statSync(root).isFile();
    for (const file of walk(root)) {
      const relative = rootIsFile ? path.basename(file) : path.relative(root, file);
      const destination = path.join(backupRoot, path.basename(root), relative);
      files.push({ file, destination });
      copyFile(file, destination, plan, options);
    }
  }
  return files;
}

// Retiring is intentionally a rename, not a backup copy: the old directory is
// no longer a runtime source and copying it would leave the fossil executable.
function retireLegacyScripts(source, backupRoot, plan, options) {
  const tombstone = path.join(source, 'README.md');
  const destination = path.join(backupRoot, 'legacy', 'claude-scripts');
  const onlyTombstone = exists(source) && fs.statSync(source).isDirectory()
    && fs.readdirSync(source).every((name) => name === 'README.md');
  if (!exists(source) || onlyTombstone) {
    plan.push({ op: 'skip', reason: 'already-retired', source, destination });
    return;
  }
  plan.push({ op: 'retire', source, destination });
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
  }
  writeText(tombstone, 'Este diretório foi aposentado pelo forge-update. Para reverter, mova backups/legacy/claude-scripts de volta para ~/.claude/scripts.\n', plan, options);
}

function installApp(repo, plan, options, platform) {
  if (!options.withApp) return null;
  const script = path.join(repo, 'app', 'build.sh');
  if (platform !== 'darwin') {
    const report = { requested: true, status: 'skipped', reason: 'macos-only', script };
    plan.push({ op: 'skip', reason: report.reason, destination: script });
    return report;
  }
  if (!exists(script)) throw new Error(`app build ausente: ${script}`);
  plan.push({ op: 'app-build', command: 'bash', args: [script, '--install'], destination: '/Applications/Forge.app' });
  if (options.dryRun) return { requested: true, status: 'planned', script };
  const runner = options.spawnSync || spawnSync;
  const result = runner('bash', [script, '--install'], { cwd: repo, shell: false, stdio: 'inherit' });
  if (result && result.error) throw new Error(`app build falhou: ${result.error.message}`);
  if (!result || result.status !== 0) throw new Error(`app build falhou com exit ${result && result.status}`);
  return { requested: true, status: 'installed', script, destination: '/Applications/Forge.app' };
}

function install(input = {}) {
  const options = { ...input };
  const runtime = options.runtime || 'claude';
  if (!RUNTIMES.includes(runtime)) throw new Error(`runtime inválido: ${JSON.stringify(runtime)} (use claude, codex ou both)`);
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const paths = resolveForgePaths({
    cwd: repo,
    forgeHome: options.forgeHome,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    env: options.env,
    userHome: options.userHome,
    platform: options.platform,
  });
  const plan = [];
  const selected = selectedRuntimes(runtime);
  const capabilities = capabilityReport(repo, runtime, options);
  if (capabilities && !capabilities.ok && !options.dryRun) {
    const failures = capabilities.required_failures.join(', ');
    throw new Error(`capability obrigatória ausente para ${runtime}: ${failures || 'diagnóstico inconclusivo'}`);
  }
  const backupName = backupId(options);
  const backupRoot = path.join(paths.forgeHome, 'backups', backupName);
  const projectRoot = path.resolve(options.projectRoot || options.cwd || process.cwd());
  const coreFiles = [];
  for (const item of MANAGED_CORE) {
    const source = path.join(repo, item);
    if (exists(source)) coreFiles.push(item);
  }
  const coreAlready = exists(paths.forgeHome) && coreFiles.length > 0 && coreFiles.every((item) => exists(path.join(paths.forgeHome, item)));
  const installComplete = coreAlready && exists(paths.shared.version) && exists(paths.shared.prefs)
    && selected.every((host) => projectionComplete(paths, host, projectRoot));
  if (installComplete && !options.update && !options.dryRun && !options.withApp) {
    return { ok: true, changed: false, already_installed: true, runtime, forge_home: paths.forgeHome, selected, backup: null, capabilities, plan: [{ op: 'skip', reason: 'already-installed', destination: paths.forgeHome }] };
  }
  if (options.update) {
    if (coreAlready) backupExisting(coreFiles.map((item) => path.join(paths.forgeHome, item)), backupRoot, plan, options);
    for (const host of selected) {
      const home = paths.runtimeHomes[host];
      for (const directory of ['agents', 'commands', 'skills', path.join('templates', 'dispatch')]) {
        backupExisting([path.join(home, directory)], path.join(backupRoot, 'adapters', host), plan, options);
      }
      backupExisting([path.join(home, 'config.toml')], path.join(backupRoot, 'adapters', host), plan, options);
    }
    if (selected.includes('claude')) {
      backupExisting([
        path.join(paths.claudeHome, 'forge-agent-prefs.jsonc'),
        path.join(paths.claudeHome, 'forge-agent-prefs.md'),
      ], path.join(backupRoot, 'legacy', 'claude'), plan, options);
    }
    retireLegacyScripts(path.join(paths.userHome, '.claude', 'scripts'), backupRoot, plan, options);
    const projectFiles = [];
    if (selected.includes('claude')) projectFiles.push(path.join(projectRoot, 'CLAUDE.md'));
    if (selected.includes('codex')) projectFiles.push(path.join(projectRoot, 'AGENTS.md'));
    backupExisting(projectFiles, path.join(backupRoot, 'project'), plan, options);
  }

  // Shared core is copied exactly once into Forge home. Existing prefs are
  // deliberately outside this managed list and are never overwritten.
  for (const item of coreFiles) {
    const source = path.join(repo, item);
    const destination = path.join(paths.forgeHome, item);
    if (fs.statSync(source).isDirectory()) copyTree(source, destination, plan, options);
    else copyFile(source, destination, plan, options);
  }
  // Review schemas historically lived under shared/schemas in the repository,
  // while installed scripts resolve the canonical Forge-home schemas directory.
  copyTree(path.join(repo, 'shared', 'schemas'), paths.shared.schemas, plan, options);
  // Preserve the historical CLI surface without duplicating installer logic in
  // Bash/PowerShell. The canonical copy lives in Forge home; launchers are also
  // mirrored to the cross-platform user bin used by existing installations.
  const sourceBin = path.join(repo, 'bin');
  const userBin = path.join(paths.userHome, '.local', 'bin');
  for (const relative of relativeFiles(sourceBin)) {
    copyFile(path.join(sourceBin, relative), path.join(userBin, relative), plan, options);
  }
  const versionFile = path.join(paths.forgeHome, 'VERSION');
  if (!exists(versionFile) || options.update) writeText(versionFile, `${VERSION}\n`, plan, options);
  const prefs = path.join(paths.forgeHome, 'forge-agent-prefs.jsonc');
  const legacyPrefs = path.join(paths.claudeHome, 'forge-agent-prefs.jsonc');
  // Claude legacy state is an input only when Claude is selected. Codex-only
  // must not even read the unselected Claude home.
  if (selected.includes('claude') && !exists(prefs) && exists(legacyPrefs)) copyFile(legacyPrefs, prefs, plan, options);
  if (!exists(prefs)) {
    const schema = JSON.parse(fs.readFileSync(path.join(repo, 'forge-prefs.schema.json'), 'utf8'));
    const { generateScaffold } = require('./forge-prefs-scaffold');
    copyIfMissing(path.join(repo, 'forge-prefs.schema.json'), path.join(paths.forgeHome, 'schemas', 'forge-prefs.schema.json'), plan, options);
    writeText(prefs, generateScaffold(schema, { schemaRef: 'schemas/forge-prefs.schema.json' }), plan, options);
  }

  // All host projections are rendered from the canonical source manifest.
  // The installer does not keep a second, host-specific copy strategy.
  const generated = generateProjections({
    repo,
    runtime,
    projectRoot,
    claudeHome: paths.runtimeHomes.claude,
    codexHome: paths.runtimeHomes.codex,
    forgeHome: paths.forgeHome,
    dryRun: options.dryRun,
    update: options.update,
    migrateLegacy: options.migrateLegacy,
  });
  const existingManifest = readJsonIfPresent(paths.shared.manifest) || {};
  const adapterManifest = { ...(existingManifest.adapters || {}) };
  for (const host of selected) {
    const home = paths.runtimeHomes[host];
    const root = path.join(paths.adapters[host]);
    const report = generated.reports[host];
    const artifacts = report ? [...report.written, ...report.preserved] : [];
    const inside = (base, destination) => {
      const relative = path.relative(base, destination);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const conflicts = report ? report.conflicts || [] : [];
    const conflictDestinations = new Set(conflicts.map((item) => path.resolve(item.destination)));
    const managed = artifacts.filter((item) => !conflictDestinations.has(path.resolve(item.destination)));
    const files = [...new Set(managed.filter((item) => inside(home, item.destination)).map((item) => path.relative(home, item.destination).replace(/\\/g, '/')))].sort();
    const projectFiles = [...new Set(managed.filter((item) => inside(projectRoot, item.destination)).map((item) => path.relative(projectRoot, item.destination).replace(/\\/g, '/')))].sort();
    adapterManifest[host] = { home, project_root: projectRoot, files, project_files: projectFiles, conflicts };
    writeText(path.join(root, 'manifest.json'), JSON.stringify({ runtime: host, version: VERSION, files, project_files: projectFiles, conflicts }, null, 2) + '\n', plan, options);
  }
  const installedHosts = Object.keys(adapterManifest).sort();
  const manifest = { version: VERSION, runtime: installedHosts.length === 2 ? 'both' : (installedHosts[0] || runtime), project_root: projectRoot, core: coreFiles.concat(['VERSION', 'forge-agent-prefs.jsonc']).sort(), adapters: adapterManifest };
  writeText(paths.shared.manifest, JSON.stringify(manifest, null, 2) + '\n', plan, options);
  const app = installApp(repo, plan, options, paths.platform);
  const backupPath = path.resolve(backupRoot);
  const hasBackup = options.update && plan.some((entry) => entry.destination && (path.resolve(entry.destination) === backupPath || path.resolve(entry.destination).startsWith(`${backupPath}${path.sep}`)));
  return { ok: true, changed: plan.some((entry) => entry.op === 'copy' || entry.op === 'write' || entry.op === 'app-build'), dry_run: Boolean(options.dryRun), runtime, selected, forge_home: paths.forgeHome, runtime_homes: Object.fromEntries(selected.map((host) => [host, paths.runtimeHomes[host]])), backup: hasBackup ? backupRoot : null, capabilities, plan, manifest, app };
}

function render(report) {
  const lines = [`Forge Agent Installer ${VERSION}`, `runtime: ${report.runtime}`, `Forge home: ${report.forge_home}`];
  if (report.capabilities) {
    const state = report.capabilities.ok ? 'ok' : `failed (${report.capabilities.required_failures.join(', ') || 'inconclusive'})`;
    lines.push(`Capabilities: ${state}`);
  }
  if (report.already_installed) lines.push('Already installed; use --update to replace managed files.');
  if (report.dry_run) {
    lines.push(`Dry-run: ${report.plan.length} operation(s), no files written.`);
    for (const entry of report.plan) lines.push(`  [${entry.op}] ${entry.destination || [entry.command, ...(entry.args || [])].filter(Boolean).join(' ')}`);
  }
  else lines.push(`${report.changed ? 'Installed' : 'No changes'}; ${report.plan.length} operation(s).`);
  if (report.app) lines.push(`App: ${report.app.status}${report.app.reason ? ` (${report.app.reason})` : ''}`);
  if (report.backup) lines.push(`Backup: ${report.backup}`);
  // Two kinds of preserved conflict, and only ONE of them has `--migrate-legacy` as its
  // remedy. An operator-owned destination (settings.json) is preserved even WITH that flag,
  // so pointing the operator at it there would promise a fix that cannot work — and would
  // invite exactly the re-run that destroys the file the guard just saved.
  const allConflicts = report.manifest && report.manifest.adapters
    ? Object.values(report.manifest.adapters).flatMap((adapter) => (Array.isArray(adapter.conflicts) ? adapter.conflicts : []))
    : [];
  const operatorOwned = allConflicts.filter((item) => path.basename(String(item && item.destination || '')) === 'settings.json');
  const legacy = allConflicts.length - operatorOwned.length;
  if (legacy) lines.push(`Conflicts preserved: ${legacy}; use --migrate-legacy to replace unmarked legacy projections.`);
  if (operatorOwned.length) lines.push(`Operator-owned preserved: ${operatorOwned.length} (settings.json) — Forge never replaces it; use scripts/merge-settings.js to add Forge's hooks/statusLine keys.`);
  return lines.join('\n') + '\n';
}

function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout), errorWrite = process.stderr.write.bind(process.stderr)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { errorWrite(`forge-installer: ${error.message}\n`); return 2; }
  if (options.help) { write('Usage: install.{sh,ps1} --runtime claude|codex|both [--project-root DIR] [--update] [--dry-run] [--no-model-probe] [--capability-timeout MS] [--migrate-legacy] [--with-app]\n'); return 0; }
  try { const report = install(options); if (options.dryRun || report.ok) write(render(report)); return report.ok ? 0 : 1; }
  catch (error) { errorWrite(`forge-installer: ${error.message}\n`); return 1; }
}

module.exports = { RUNTIMES, VERSION, MANAGED_CORE, parseArgs, walk, adapterSources, installApp, retireLegacyScripts, install, render, run };
if (require.main === module) process.exitCode = run();
