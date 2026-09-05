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

const TOMBSTONE = 'README.md';

// Ours by name, or ours by inventory. The prefix rule alone is not enough:
// `merge-settings.js` and `codebase-collect.sh` are Forge files without it, and
// classifying them as strangers would leave two fossils executable. The second
// leg answers with the Forge scripts inventory (repo `scripts/` plus the Forge
// home copy), which is where both of them live.
function isForgeScriptName(relative) {
  return /^forge/i.test(path.basename(String(relative)));
}

function classifyLegacyScripts(source, inventory) {
  const known = inventory instanceof Set ? inventory : new Set();
  const managed = [];
  const retained = [];
  for (const relative of relativeFiles(source)) {
    const posix = relative.split(path.sep).join('/');
    if (posix === TOMBSTONE) continue; // our own tombstone: never moved, never counted
    (isForgeScriptName(posix) || known.has(posix) ? managed : retained).push(posix);
  }
  return { managed: managed.sort(), retained: retained.sort() };
}

// The guard that lost it now sees it. A `settings.json` hook pointing INTO the
// directory being retired is exactly how the loss stayed silent: the file is
// preserved as `user_owned`, so it stays intact and pointing at nothing, and the
// hook fails without a word on every session start. Same discipline as #92/#93
// on the statusline.
//
// One needle covers every form the path can take because JSON escapes a Windows
// separator as `\\`: normalizing all separators to `/` makes
// `~/.claude/scripts/x.py`, `C:\\Users\\…\\scripts\\x.py` and
// `$HOME/.claude/scripts/x.py` the same string. A directory named `scripts`
// elsewhere can produce a false hit — and that errs toward keeping the operator's
// file, which is the safe direction.
function legacyScriptReferences(settingsFiles, relatives) {
  const hits = [];
  for (const file of settingsFiles || []) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const haystack = text.replace(/\\{1,2}/g, '/').toLowerCase();
    for (const relative of relatives) {
      if (haystack.includes(`scripts/${String(relative).toLowerCase()}`)) hits.push({ settings: file, script: relative });
    }
  }
  return hits;
}

// A relocated FORGE_HOME can put the backup on another volume, where rename
// fails with EXDEV. The whole-directory rename had the same exposure and no
// fallback; per-file moves make the recovery trivial.
function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); }
  catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function pruneEmptyDirectories(root) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
    if (path.resolve(directory) !== path.resolve(root) && fs.readdirSync(directory).length === 0) {
      try { fs.rmdirSync(directory); } catch (_) { /* best effort */ }
    }
  };
  visit(root);
}

function tombstoneText(retained) {
  const lines = ['Este diretório foi aposentado pelo forge-update. Para reverter, mova backups/legacy/claude-scripts de volta para ~/.claude/scripts.'];
  if (retained.length) lines.push('', `Preservados aqui porque não são do Forge (${retained.length}):`, ...retained.map((relative) => `- ${relative}`));
  return `${lines.join('\n')}\n`;
}

// Retiring is intentionally a move, not a backup copy: the old directory is no
// longer a runtime source and copying it would leave the fossil executable.
//
// It is NOT, however, ours wholesale. Measured on a real 4.15.0 update: 93 files
// moved, 91 of them `forge-*`. One of the other two was the operator's
// `svn-session-reconcile.py`, invoked by a `SessionStart` hook in
// `settings.json`. The whole-directory rename took it along, and from then on
// that hook failed silently at every session start — noticed only because the
// operator happened to know the hook existed. The tombstone explains how to
// revert, which is good, but nobody reads the README of a directory they do not
// know lost content.
//
// So: classify, move only what is ours, leave the rest exactly where the
// operator left it, and name both halves in the plan.
function retireLegacyScripts(source, backupRoot, plan, options, context = {}) {
  const tombstone = path.join(source, TOMBSTONE);
  const destination = path.join(backupRoot, 'legacy', 'claude-scripts');
  if (!exists(source) || !fs.statSync(source).isDirectory()) {
    plan.push({ op: 'skip', reason: 'already-retired', source, destination, moved: [], retained: [], settings_references: [] });
    return;
  }
  // A symlinked legacy dir is NEVER a legacy copy — it is a live alias to a
  // directory someone else owns (the classic case: ~/.claude/scripts pointing
  // into a dev checkout's scripts/, so edits show up without reinstalling).
  // `classifyLegacyScripts`/`moveFile` walk through the link and rename by
  // real path, so "retiring" it moves the LINK TARGET's files into the backup,
  // deleting them out of whatever tree owns them — measured three times: two
  // `--update` runs each renamed ~446 of a dev repo's own `scripts/*` files
  // out from under it in one pass.
  //
  // The first version of this guard compared the link target against
  // `context.repo` — and was inert in exactly the flow that bit: a REMOTE
  // update runs from a temporary release checkout, so `context.repo` is the
  // tmpdir, the dev repo is "outside", and the retire proceeded. The rule that
  // actually holds is symlink ⇒ skip, unconditionally: retiring means
  // archiving OUR copy, and a symlink is by definition not a copy. The link
  // target is still resolved (realpath — an indirection resolves to the same
  // on-disk identity) and recorded, and the source-repo case keeps its more
  // specific reason for the report.
  if (fs.lstatSync(source).isSymbolicLink()) {
    const real = fs.realpathSync(source);
    let reason = 'symlinked-not-a-copy';
    if (context.repo) {
      const repoReal = fs.realpathSync(context.repo);
      const relativeToRepo = path.relative(repoReal, real);
      const insideRepo = relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo));
      if (insideRepo) reason = 'symlinked-to-source-repo';
    }
    plan.push({ op: 'skip', reason, link_target: real, source, destination, moved: [], retained: [], settings_references: [] });
    return;
  }
  const { managed, retained } = classifyLegacyScripts(source, context.inventory);
  const references = legacyScriptReferences(context.settingsFiles, [...managed, ...retained])
    .map((hit) => ({ ...hit, action: managed.includes(hit.script) ? 'retired' : 'retained' }));
  // `already-retired` is a statement about OUR content, not about the folder:
  // the directory can legitimately survive holding only the operator's files.
  // Without this branch a retained orphan would make every future update try to
  // retire the same directory again, forever.
  if (managed.length === 0) {
    plan.push({ op: 'skip', reason: 'already-retired', source, destination, moved: [], retained, settings_references: references });
    return;
  }
  plan.push({ op: 'retire', source, destination, moved: managed, retained, settings_references: references });
  if (!options.dryRun) {
    for (const relative of managed) moveFile(path.join(source, relative), path.join(destination, relative.split('/').join(path.sep)));
    pruneEmptyDirectories(source);
  }
  writeText(tombstone, tombstoneText(retained), plan, options);
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
    // The inventory that answers "is this file ours?" — the repo's own scripts
    // plus the copy already installed in the Forge home, so a script deleted from
    // the repo is still recognized as a Forge fossil. The settings files are the
    // ones Claude Code actually reads, in both the standard and relocated layout.
    const legacyScripts = path.join(paths.userHome, '.claude', 'scripts');
    const scriptInventory = new Set([
      ...relativeFiles(path.join(repo, 'scripts')),
      ...relativeFiles(paths.shared.scripts),
    ].map((relative) => relative.split(path.sep).join('/')));
    const settingsFiles = [...new Set([
      path.join(paths.userHome, '.claude', 'settings.json'),
      path.join(paths.userHome, '.claude', 'settings.local.json'),
      path.join(paths.claudeHome, 'settings.json'),
      path.join(paths.claudeHome, 'settings.local.json'),
    ].map((file) => path.resolve(file)))];
    retireLegacyScripts(legacyScripts, backupRoot, plan, options, { inventory: scriptInventory, settingsFiles, repo });
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
  // The ownership record is read BEFORE rendering and written back after: it is
  // the only proof of ownership a format without comment syntax can have, so a
  // run that forgets to carry it forward re-freezes every JSON projection.
  const priorManifest = readJsonIfPresent(paths.shared.manifest) || {};
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
    ownership: priorManifest.ownership && typeof priorManifest.ownership === 'object' ? priorManifest.ownership : {},
    // Undefined lets each renderer build its own resolver from `repo`; an explicit
    // null disables the release rung; an object is an injected resolver (tests).
    provenance: options.provenance,
  });
  const existingManifest = priorManifest;
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
    // Destinations that were a permanent `user_owned` conflict until repo history
    // proved the bytes were ours. Recorded so the transition is visible in the
    // manifest and not only in one run's stdout.
    const adopted = report ? (report.written || []).filter((item) => item.reason === 'release-adopted').map((item) => item.destination) : [];
    const selfSourced = report ? (report.self_sourced || []).map((item) => item.destination) : [];
    adapterManifest[host] = { home, project_root: projectRoot, files, project_files: projectFiles, conflicts, adopted, self_sourced: selfSourced };
    writeText(path.join(root, 'manifest.json'), JSON.stringify({ runtime: host, version: VERSION, files, project_files: projectFiles, conflicts, adopted, self_sourced: selfSourced }, null, 2) + '\n', plan, options);
  }
  const installedHosts = Object.keys(adapterManifest).sort();
  // Merge, never replace: a `--runtime claude` run must not drop the digests of
  // the Codex host's destinations, or the next Codex install treats every one of
  // them as an unmarked stranger.
  const ownershipRecord = { ...(existingManifest.ownership || {}) };
  for (const host of installedHosts) {
    const report = generated.reports[host];
    if (report && report.ownership && typeof report.ownership === 'object') Object.assign(ownershipRecord, report.ownership);
  }
  // Provenance: WHICH clone rendered this installation. Without it an update run
  // from the installed copy has nothing to resolve the source repo from — the
  // Forge home holds `scripts/` (managed core) but never
  // `forge-source-manifest.json`, so the renderer died on a raw ENOENT. Recorded
  // additively; readers that predate it simply do not see the key.
  // A remote update renders from an ephemeral checkout which is deleted after
  // installation. Persist the pinned server provenance, never that temporary
  // path. Local/development installs retain source_repo for compatibility.
  const sourceProvenance = options.sourceProvenance && typeof options.sourceProvenance === 'object'
    ? { ...options.sourceProvenance }
    : null;
  const manifest = {
    version: VERSION,
    runtime: installedHosts.length === 2 ? 'both' : (installedHosts[0] || runtime),
    project_root: projectRoot,
    ...(sourceProvenance ? { source_remote: sourceProvenance } : { source_repo: repo }),
    core: coreFiles.concat(['VERSION', 'forge-agent-prefs.jsonc']).sort(),
    adapters: adapterManifest,
    ownership: ownershipRecord,
  };
  writeText(paths.shared.manifest, JSON.stringify(manifest, null, 2) + '\n', plan, options);
  const app = installApp(repo, plan, options, paths.platform);
  const backupPath = path.resolve(backupRoot);
  const hasBackup = options.update && plan.some((entry) => entry.destination && (path.resolve(entry.destination) === backupPath || path.resolve(entry.destination).startsWith(`${backupPath}${path.sep}`)));
  return { ok: true, changed: plan.some((entry) => entry.op === 'copy' || entry.op === 'write' || entry.op === 'app-build'), dry_run: Boolean(options.dryRun), runtime, selected, forge_home: paths.forgeHome, runtime_homes: Object.fromEntries(selected.map((host) => [host, paths.runtimeHomes[host]])), backup: hasBackup ? backupRoot : null, capabilities, plan, manifest, app };
}

/**
 * The file-by-file preview, in ONE place.
 *
 * `forge-update` renders it too — `install.sh --update --dry-run` used to reach
 * the installer directly and print this list, and routing that wrapper through
 * the updater silently replaced 1000+ named operations with a four-line summary.
 * Two copies of this formatting is how the two previews drift apart, so the
 * updater borrows this function instead of reimplementing it.
 */
function planLines(report) {
  return [
    `Dry-run: ${report.plan.length} operation(s), no files written.`,
    ...report.plan.map((entry) => `  [${entry.op}] ${entry.destination || [entry.command, ...(entry.args || [])].filter(Boolean).join(' ')}`),
  ];
}

function render(report) {
  const lines = [`Forge Agent Installer ${VERSION}`, `runtime: ${report.runtime}`, `Forge home: ${report.forge_home}`];
  if (report.capabilities) {
    const state = report.capabilities.ok ? 'ok' : `failed (${report.capabilities.required_failures.join(', ') || 'inconclusive'})`;
    lines.push(`Capabilities: ${state}`);
  }
  if (report.already_installed) lines.push('Already installed; use --update to replace managed files.');
  if (report.dry_run) lines.push(...planLines(report));
  else lines.push(`${report.changed ? 'Installed' : 'No changes'}; ${report.plan.length} operation(s).`);
  if (report.app) lines.push(`App: ${report.app.status}${report.app.reason ? ` (${report.app.reason})` : ''}`);
  if (report.backup) lines.push(`Backup: ${report.backup}`);
  // Retirement is not wholesale, so the summary says what stayed — and a hook
  // pointing into the retired directory is loud rather than absent. A count with
  // no names is what made the previous loss invisible.
  for (const entry of (report.plan || []).filter((item) => item.op === 'retire' || (item.op === 'skip' && item.reason === 'already-retired'))) {
    if (Array.isArray(entry.retained) && entry.retained.length) {
      lines.push(`Retired ${(entry.moved || []).length} managed file(s) from ${entry.source}; retained ${entry.retained.length} not ours:`);
      for (const relative of entry.retained) lines.push(`  [retained] ${relative}`);
    }
    for (const reference of entry.settings_references || []) {
      lines.push(reference.action === 'retired'
        ? `  ⚠ ${reference.settings} chama ${reference.script} em ${entry.source} — esse arquivo FOI aposentado; ajuste o comando (o alvo mantido vive em ~/.forge-agent/scripts/)`
        : `  ⚠ ${reference.settings} chama ${reference.script} em ${entry.source} — preservado no lugar para o hook continuar funcionando`);
    }
  }
  // Two kinds of preserved conflict, and only ONE of them has `--migrate-legacy` as its
  // remedy. An operator-owned destination (settings.json) is preserved even WITH that flag,
  // so pointing the operator at it there would promise a fix that cannot work — and would
  // invite exactly the re-run that destroys the file the guard just saved.
  const allConflicts = report.manifest && report.manifest.adapters
    ? Object.values(report.manifest.adapters).flatMap((adapter) => (Array.isArray(adapter.conflicts) ? adapter.conflicts : []))
    : [];
  const operatorOwned = allConflicts.filter((item) => path.basename(String(item && item.destination || '')) === 'settings.json');
  const statusLineConflicts = allConflicts.filter((item) => item.reason === 'status-line-manual-merge');
  for (const item of statusLineConflicts) lines.push(`Status line preserved: ${item.destination}; use Codex /statusline to configure the desired indicators manually.`);
  const legacyConflicts = allConflicts.filter((item) => !operatorOwned.includes(item) && !statusLineConflicts.includes(item));
  // Name them. A bare count is the reason this drift stays invisible: the
  // operator is told that N files were left behind but not WHICH, so a stale
  // destination on the execution path reads exactly like a stale destination
  // nobody loads. Measured cost of the anonymous form: an `--update` that
  // reported success left `~/.claude/forge-hook.js` — the file `settings.json`
  // actually runs — frozen several releases back, and finding that took a
  // byte-compare against repo history rather than reading the summary.
  // The transition out of a freeze is visible, not implicit: a destination that
  // was a permanent `user_owned` conflict and is now replaced says so, and says on
  // what grounds.
  const adopted = report.manifest && report.manifest.adapters
    ? Object.values(report.manifest.adapters).flatMap((adapter) => (Array.isArray(adapter.adopted) ? adapter.adopted : []))
    : [];
  if (adopted.length) {
    lines.push(`Adopted from release history: ${adopted.length} (bytes matched a past revision of their source — previously frozen as user_owned).`);
    for (const destination of adopted) lines.push(`  [adopted] ${destination}`);
  }
  // Named, never a bare count and never silent: this fires on exactly one
  // machine profile — an install whose project root IS the forge-agent clone —
  // and an operator who sees no line has no way to tell the guard from its
  // absence. Not an error: the rest of the install is valid, and this target
  // was never installable in the first place.
  const selfSourced = report.manifest && report.manifest.adapters
    ? Object.values(report.manifest.adapters).flatMap((adapter) => (Array.isArray(adapter.self_sourced) ? adapter.self_sourced : []))
    : [];
  if (selfSourced.length) {
    lines.push(`Self-sourced targets skipped: ${selfSourced.length} — o destino É a própria fonte declarada no manifesto; projetar sobreescreveria o canônico.`);
    for (const destination of selfSourced) lines.push(`  [self-source] ${destination}`);
  }
  if (legacyConflicts.length) {
    lines.push(`Conflicts preserved: ${legacyConflicts.length}; use --migrate-legacy to replace unmarked legacy projections.`);
    // Each preserved destination carries WHY it was not adopted. "we proved these
    // bytes are yours" and "we could not look" are different facts and must not
    // read alike — a count with no grounds is how the freeze stayed invisible.
    for (const item of legacyConflicts) lines.push(`  [preserved] ${item.destination}${item.provenance ? ` (proveniência: ${item.provenance})` : ''}`);
  }
  if (operatorOwned.length) {
    lines.push(`Operator-owned preserved: ${operatorOwned.length} (settings.json) — Forge never replaces it; use scripts/merge-settings.js to add Forge's hooks/statusLine keys.`);
    for (const item of operatorOwned) lines.push(`  [operator-owned] ${item.destination}`);
  }
  return lines.join('\n') + '\n';
}

function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout), errorWrite = process.stderr.write.bind(process.stderr)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { errorWrite(`forge-installer: ${error.message}\n`); return 2; }
  if (options.help) { write('Usage: install.{sh,ps1} --runtime claude|codex|both [--project-root DIR] [--update] [--dry-run] [--no-model-probe] [--capability-timeout MS] [--migrate-legacy] [--with-app]\n'); return 0; }
  try { const report = install(options); if (options.dryRun || report.ok) write(render(report)); return report.ok ? 0 : 1; }
  catch (error) { errorWrite(`forge-installer: ${error.message}\n`); return 1; }
}

module.exports = { RUNTIMES, VERSION, MANAGED_CORE, TOMBSTONE, parseArgs, walk, adapterSources, installApp, classifyLegacyScripts, legacyScriptReferences, retireLegacyScripts, install, planLines, render, run };
if (require.main === module) process.exitCode = run();
