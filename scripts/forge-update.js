#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const maintenance = require('./forge-maintenance.js');
const installer = require('./forge-installer.js');
const { resolveForgeHome } = require('./forge-home.js');
const remoteUpdater = require('./forge-update-remote.js');

const SOURCE_MANIFEST = 'forge-source-manifest.json';

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  // `repo` is deliberately NOT defaulted. Normal updates use the server; only
  // the explicit local/recovery mode resolves a source repository.
  const options = { apply: false, json: false, source: 'remote', channel: remoteUpdater.DEFAULT_CHANNEL, remote: remoteUpdater.DEFAULT_REMOTE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') options.runtime = argv[++i] || '';
    else if (arg === '--source') options.source = argv[++i] || '';
    else if (arg === '--channel') options.channel = argv[++i] || '';
    else if (arg === '--remote') options.remote = argv[++i] || '';
    else if (arg === '--repo') options.repo = path.resolve(argv[++i] || '');
    else if (arg === '--forge-home') options.forgeHome = path.resolve(argv[++i] || '');
    else if (arg === '--claude-home') options.claudeHome = path.resolve(argv[++i] || '');
    else if (arg === '--codex-home') options.codexHome = path.resolve(argv[++i] || '');
    else if (arg === '--project-root') options.projectRoot = path.resolve(argv[++i] || '');
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-model-probe') options.noModelProbe = true;
    else if (arg === '--with-app') options.withApp = true;
    else if (arg === '--capability-timeout') options.capabilityTimeout = Number(argv[++i] || '');
    else if (arg === '--migrate-legacy') options.migrateLegacy = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  if (options.runtime) maintenance.selectedRuntimes(options.runtime);
  if (!['remote', 'local'].includes(options.source)) throw new Error(`source inválido: ${JSON.stringify(options.source)} (use remote ou local)`);
  if (!['stable', 'master'].includes(options.channel)) throw new Error(`channel inválido: ${JSON.stringify(options.channel)} (use stable ou master)`);
  if (options.source === 'remote' && options.repo) throw new Error('`--repo` exige `--source local`; o update padrão ignora clones locais e usa o servidor');
  if (options.source === 'local' && (options.remote !== remoteUpdater.DEFAULT_REMOTE || options.channel !== remoteUpdater.DEFAULT_CHANNEL)) {
    throw new Error('`--remote`/`--channel` não podem ser combinados com `--source local`');
  }
  if (options.source === 'local' && env.FORGE_UPDATE_REMOTE_PROVENANCE) {
    try { options.remoteProvenance = JSON.parse(env.FORGE_UPDATE_REMOTE_PROVENANCE); }
    catch (_) { throw new Error('FORGE_UPDATE_REMOTE_PROVENANCE inválido'); }
  }
  return options;
}

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function hasSourceManifest(directory) {
  try { return Boolean(directory) && fs.existsSync(path.join(directory, SOURCE_MANIFEST)); } catch (_) { return false; }
}

/**
 * Where explicit local-mode projections are rendered FROM.
 *
 * `scripts/` is managed core (forge-installer.js § MANAGED_CORE), so the
 * documented invocation `node scripts/forge-update.js --apply --json` is
 * routinely executed from the INSTALLED copy at `~/.forge-agent/scripts/`.
 * Resolving the repo as `__dirname/..` then points it at the Forge home, and
 * `forge-source-manifest.json` has never lived there — it is not managed core,
 * so no install ever copies it. The renderer died on a raw ENOENT naming a file
 * that should not exist at that path, and nothing in the message suggested
 * `--repo`: measured on a real 4.8.0 → 4.15.0 update, reproduced on both
 * versions, so the defect was at the tip of master and not a stale install.
 *
 * This compatibility resolver remains for `--source local`. Server updates do
 * not call it and never consult recorded clone provenance.
 */
function resolveSourceRepo(input = {}) {
  const candidates = [];
  if (input.repo) candidates.push({ path: path.resolve(input.repo), origin: 'flag', label: '--repo' });
  else {
    candidates.push({ path: path.resolve(input.entryRoot || path.join(__dirname, '..')), origin: 'entry', label: 'diretório deste script' });
    const forgeHome = resolveForgeHome(input);
    const manifest = readJsonIfPresent(path.join(forgeHome, 'manifest.json'));
    const recorded = manifest && typeof manifest.source_repo === 'string' ? manifest.source_repo.trim() : '';
    if (recorded) candidates.push({ path: path.resolve(recorded), origin: 'manifest', label: `manifest.json § source_repo (${forgeHome})` });
  }
  const considered = candidates.map((candidate) => ({ path: candidate.path, origin: candidate.origin, has_source_manifest: hasSourceManifest(candidate.path) }));
  const resolved = considered.find((candidate) => candidate.has_source_manifest);
  if (resolved) return { path: resolved.path, origin: resolved.origin, considered };
  // Name the flag. The operator following the documented command has no way to
  // deduce `--repo` from a path that should not have held the file anyway.
  throw new Error([
    `repo-fonte não encontrado: nenhum caminho avaliado contém ${SOURCE_MANIFEST}`,
    ...candidates.map((candidate) => `  - ${candidate.path} (${candidate.label})`),
    'informe `--repo <dir>` apontando para o clone do forge-agent',
  ].join('\n'));
}

function gitText(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024 });
  if (!result || result.status !== 0) return null;
  return typeof result.stdout === 'string' ? result.stdout : null;
}

/**
 * The version the CLONE declares, not the one the running code declares.
 *
 * When the update is resolved from recorded provenance, the code doing the reading
 * lives in the Forge home and can be several releases behind the clone — or ahead
 * of it. That difference is precisely the signal this reports.
 */
function declaredVersion(repo) {
  try {
    const source = fs.readFileSync(path.join(repo, 'scripts', 'forge-version.js'), 'utf8');
    const match = /const\s+VERSION\s*=\s*'([^']+)'/.exec(source);
    return match ? match[1] : null;
  } catch (_) { return null; }
}

/**
 * Provenance of the bytes about to be installed.
 *
 * Explicit local mode reinstalls WHATEVER IS IN THE CLONE and never fetches. Measured:
 * a clone 113 commits behind (4.8.0 against 4.15.0 at the tip) "updated"
 * successfully to the same version, with no signal of it anywhere in the JSON or
 * the summary — the operator had to run `git fetch` by hand to find out.
 *
 * `behind_tracking` is read from the LOCAL remote-tracking ref and nothing else:
 * this function never contacts a server. Calling it "commits behind the remote"
 * would be a confident, unmeasured claim — the ref is exactly as fresh as the last
 * `git fetch`. It is therefore named after the ref it reads, and the summary says
 * out loud that refreshing the clone is a separate step.
 */
function describeSourceRepo(repo) {
  const head = gitText(repo, ['rev-parse', '--short', 'HEAD']);
  if (head === null) return { vcs: 'none', version: declaredVersion(repo), sha: null, branch: null, dirty: null, tracking_ref: null, behind_tracking: null };
  const status = gitText(repo, ['status', '--porcelain']);
  const tracking = gitText(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const trackingRef = tracking ? tracking.trim() || null : null;
  const behind = trackingRef ? gitText(repo, ['rev-list', '--count', `HEAD..${trackingRef}`]) : null;
  const branch = gitText(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    vcs: 'git',
    version: declaredVersion(repo),
    sha: head.trim() || null,
    branch: branch ? branch.trim() || null : null,
    dirty: status === null ? null : status.trim() !== '',
    tracking_ref: trackingRef,
    behind_tracking: behind === null ? null : Number(behind.trim()),
  };
}

function update(input = {}, dependencies = {}) {
  const resolved = resolveSourceRepo(input);
  const sourceRepo = { ...describeSourceRepo(resolved.path), ...resolved };
  const plan = maintenance.planUpdate(input);
  const install = dependencies.install || installer.install;
  // A preview must stay side-effect free: the installer runs only to compute the
  // retire plan, so capability probing (which spawns `claude`/`codex --version`)
  // is suppressed here rather than left to a flag the CLI never sets.
  const preview = !input.apply;
  const installed = install({
    repo: sourceRepo.path,
    runtime: plan.runtime,
    update: true,
    forgeHome: input.forgeHome,
    userHome: input.userHome,
    claudeHome: input.claudeHome,
    codexHome: input.codexHome,
    projectRoot: input.projectRoot,
    platform: input.platform,
    env: input.env,
    binaries: input.binaries,
    capabilityTimeout: input.capabilityTimeout,
    noModelProbe: preview ? true : input.noModelProbe,
    skipCapabilityCheck: preview ? true : input.skipCapabilityCheck,
    migrateLegacy: input.migrateLegacy,
    withApp: input.withApp,
    sourceProvenance: input.remoteProvenance,
    dryRun: preview,
  });
  // Retirement is reported on BOTH paths. It used to be summarized only in the
  // preview, so the run that actually moved files — the `--apply` an operator
  // reads once and never again — said nothing about what it retired or kept.
  const retirements = installed.plan.filter((entry) => entry.op === 'retire' || (entry.op === 'skip' && entry.reason === 'already-retired'));
  if (preview) return { ...plan, source_repo: sourceRepo, remote_source: input.remoteProvenance || null, applied: false, installer: installed, retirements };
  return { ...plan, source_repo: sourceRepo, remote_source: input.remoteProvenance || null, applied: true, changed: installed.changed, backup: installed.backup, installer: installed, retirements };
}

// The clone's own state for explicit local/recovery mode. `behind_tracking` is
// labelled with the ref it came from, because a number derived from a local
// remote-tracking ref is only as fresh as the last fetch and must not be read as
// the distance to the server.
function sourceRepoLines(source) {
  if (!source) return [];
  const lines = [];
  const facts = [];
  if (source.version) facts.push(`version ${source.version}`);
  if (source.sha) facts.push(`sha ${source.sha}${source.branch ? ` (${source.branch})` : ''}`);
  if (source.dirty === true) facts.push('árvore suja');
  if (facts.length) lines.push(`  ${facts.join(' | ')}`);
  if (source.vcs === 'none') lines.push('  sem git no repo-fonte: não há sha nem distância a reportar');
  else if (source.tracking_ref === null) lines.push('  sem upstream configurado: distância desconhecida');
  else if (Number.isFinite(source.behind_tracking) && source.behind_tracking > 0) {
    lines.push(`  ${source.behind_tracking} commit(s) atrás de ${source.tracking_ref} — medido no ref local, do último \`git fetch\``);
  } else if (Number.isFinite(source.behind_tracking)) {
    lines.push(`  em dia com ${source.tracking_ref} — medido no ref local, do último \`git fetch\``);
  }
  lines.push('  este comando instala o que está no clone; atualizar o clone (`git fetch` + `git pull`) é passo separado');
  return lines;
}

function render(report) {
  const remote = report.remote_source;
  const sourceLines = remote
    ? [
      `remote source: ${remote.remote}`,
      `  channel ${remote.channel} | ${remote.ref} | sha ${remote.sha}`,
      `  declared version ${remote.declared_version || 'unknown'}${remote.version_matches_ref === false ? ' (⚠ difere da tag)' : ''}`,
      '  clone local ignorado; checkout remoto temporário removido após o update',
    ]
    : [
      `source repo: ${report.source_repo ? `${report.source_repo.path} (${report.source_repo.origin})` : 'não resolvido'}`,
      ...sourceRepoLines(report.source_repo),
    ];
  const lines = [
    `Forge update ${report.applied ? 'applied' : 'plan'}`,
    `runtime: ${report.runtime}`,
    `installation: ${report.installation_source}`,
    // Named, not implied: an update that reinstalls whatever the clone happens
    // to hold must say WHICH clone it read, and how it found it.
    ...sourceLines,
    `backup: ${report.backup_required ? 'required-before-write' : 'not-required'}`,
  ];
  if (report.legacy_migration) lines.push(`legacy migration: ${report.legacy_migration.release} (${report.legacy_migration.runtime})`);
  if (report.installer && report.installer.backup) lines.push(`backup created: ${report.installer.backup}`);
  // A compatibility bootstrap has no structured plan, so it must SAY so and hand
  // over the remote installer's own output. Printing nothing here would read as
  // "nothing to report", which is the one thing it does not mean.
  if (report.bootstrap && report.bootstrap.mode === 'installer-compat') {
    lines.push(`bootstrap: installer-compat — ${report.bootstrap.reason}`);
    lines.push(`runtime resolvido por: ${report.bootstrap.runtime_source}`);
    lines.push('saída do instalador remoto (plano e retirements vêm dela, não deste resumo):');
    for (const line of String(report.bootstrap.output || '').split(/\r?\n/)) lines.push(`  | ${line}`);
  }
  for (const retirement of report.retirements || []) {
    const state = retirement.op === 'skip' ? 'skipped' : 'retire';
    lines.push(`${state}: ${retirement.source} -> ${retirement.destination}`);
    // Retirement moves only what Forge can prove is its own. What stayed is
    // named, and a settings.json hook aimed inside the retired directory is
    // surfaced here — the operator who follows this output must not have to know
    // the hook existed to learn it was affected.
    if (Array.isArray(retirement.moved)) lines.push(`  moved: ${retirement.moved.length}; retained: ${(retirement.retained || []).length}`);
    for (const relative of retirement.retained || []) lines.push(`  [retained] ${relative}`);
    for (const reference of retirement.settings_references || []) {
      lines.push(`  ⚠ ${reference.settings} chama ${reference.script} (${reference.action === 'retired' ? 'APOSENTADO — ajuste o comando' : 'preservado no lugar'})`);
    }
  }
  const conflicts = report.installer && report.installer.manifest && report.installer.manifest.adapters
    ? Object.values(report.installer.manifest.adapters).reduce((total, adapter) => total + (Array.isArray(adapter.conflicts) ? adapter.conflicts.length : 0), 0)
    : 0;
  if (conflicts) lines.push(`conflicts preserved: ${conflicts}; use --migrate-legacy to replace unmarked legacy projections`);
  if (report.applied) lines.push(report.changed ? 'managed files updated' : 'no managed-file changes');
  else lines.push('no files written; pass --apply to update');
  // The file-by-file preview an operator had before `install.sh --update
  // --dry-run` was routed through this updater. Borrowed from the installer's own
  // formatter so the two previews cannot drift.
  if (!report.applied && report.installer && report.installer.dry_run && Array.isArray(report.installer.plan)) {
    lines.push(...installer.planLines(report.installer));
  }
  return `${lines.join('\n')}\n`;
}

function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout), errorWrite = process.stderr.write.bind(process.stderr)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      write('Usage: forge-update.js [--runtime claude|codex|both] [--apply|--dry-run] [--channel stable|master] [--remote HTTPS_URL] [--json] [--no-model-probe] [--capability-timeout MS] [--migrate-legacy] [--with-app]\n       forge-update.js --source local --repo DIR [demais opções]\n');
      return 0;
    }
    const report = options.source === 'remote' ? remoteUpdater.updateFromRemote(options) : update(options);
    write(options.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    errorWrite(`forge-update: ${error.message}\n`);
    return 1;
  }
}

module.exports = { SOURCE_MANIFEST, parseArgs, resolveSourceRepo, describeSourceRepo, update, render, run };
if (require.main === module) process.exitCode = run();
