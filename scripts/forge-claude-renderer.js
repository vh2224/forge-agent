#!/usr/bin/env node
'use strict';

// Pure Claude adapter renderer. The source manifest is the only inventory
// consulted here; Codex homes are intentionally not accepted or resolved.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveForgePaths } = require('./forge-home');
const sourceManifest = require('./forge-source-manifest');
const ownership = require('./forge-projection-ownership');
const selfProjection = require('./forge-projection-self');
const PROVENANCE = require('./forge-projection-provenance');
const { VERSION } = require('./forge-version');

const RUNTIME = 'claude';
const ORIGIN_PREFIX = '<!-- forge-source:';
const ORIGIN_SUFFIX = ' -->';
const REASON = Object.freeze({
  INVALID_OPTIONS: 'invalid_options',
  MISSING_SOURCE: 'missing_source',
  MISSING_MANIFEST: 'missing_manifest',
  PROTECTED_PATH: 'protected_path',
  USER_OWNED: 'user_owned',
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function relativeParts(value) {
  return String(value).split(/[\\/]/).filter(Boolean);
}

function isProtectedPath(value) {
  return relativeParts(value).some((part) => part === '.gsd');
}

// Destinations Forge AUGMENTS but does not own, keyed by basename so a manifest rename
// cannot silently retire the guard.
//
// `--migrate-legacy` exists to adopt an unmarked file that IS ours — a projection
// installed before markers existed. It must never adopt a file that was never a
// projection. `settings.json` is the operator's own Claude Code config: Forge contributes
// its `hooks`/`statusLine` keys through `scripts/merge-settings.js`, which is idempotent
// and preserves every other key by design.
//
// Measured 2026-08-11, on a real `install.sh --update --migrate-legacy`: rendering this
// destination wholesale replaced a 60-line operator config with the 16-line template,
// destroying `statusLine`, seven of the eight hook events, `permissions` and
// `skipDangerousModePermissionPrompt`. The file was NOT in either backup the same run
// created — it was overwritten without ever being copied, so the loss was unrecoverable.
// The template's own comment claimed "Operator settings remain user-owned" while this
// happened, which is why the guard lives in code and not in prose.
const OPERATOR_OWNED_BASENAMES = new Set(['settings.json']);

function isOperatorOwned(destination) {
  return OPERATOR_OWNED_BASENAMES.has(path.basename(String(destination)));
}

function isMarkdown(file) {
  return /\.(?:md|markdown)$/i.test(file);
}

function originHeader(sourceId, sourcePath) {
  return `${ORIGIN_PREFIX}${sourceId} source=${sourcePath} version=${VERSION}${ORIGIN_SUFFIX}`;
}

// A leading YAML frontmatter block must stay on line 1: Claude Code only parses
// `name`, `description`, `model` and `allowed-tools` when the fence opens the
// file. The marker therefore goes immediately after the closing fence, and is
// only prepended when the document has no frontmatter at all.
const FRONTMATTER = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;
const MARKER_AT_TOP = /^<!-- forge-source:[^\n]* -->[ \t]*\n\n?/;
const MARKER_AFTER_FRONTMATTER = /^(---[ \t]*\n[\s\S]*?\n---[ \t]*\n)\n?<!-- forge-source:[^\n]* -->[ \t]*\n/;

// Script projections carry the SAME ownership fact in the only syntax their
// format accepts. Without this, `addOriginHeader` returned script content
// untouched, so a managed `.js` destination could never satisfy `hasOriginMarker`
// — and the write path reads an unmarked existing destination as user-owned.
// Consequence, measured on a live install: `~/.claude/hooks/forge-hook.js` was a
// permanent `user_owned` conflict, frozen at the bytes of whatever release first
// created it, and every subsequent `--update` preserved it while reporting
// success. A projection that can only ever be written once is not managed.
//
// The shebang must stay on line 1 — a comment above it stops the file from
// executing directly — so this mirrors the frontmatter rule exactly: marker
// immediately after the line that must come first, or at the top when absent.
const SHEBANG = /^#![^\n]*(?:\n|$)/;
const SCRIPT_MARKER_AT_TOP = /^\/\/ forge-source:[^\n]*\n\n?/;
const SCRIPT_MARKER_AFTER_SHEBANG = /^(#![^\n]*\n)\n?\/\/ forge-source:[^\n]*\n/;

function isScript(file) {
  return /\.(?:js|cjs|mjs)$/i.test(file);
}

function scriptOriginHeader(sourceId, sourcePath) {
  return `// forge-source:${sourceId} source=${sourcePath} version=${VERSION}`;
}

function addOriginHeader(content, source, sourcePath) {
  const normalized = normalizeNewlines(content);
  const body = stripOriginHeader(normalized);

  if (isMarkdown(sourcePath)) {
    const marker = originHeader(source.source_id, sourcePath);
    const fence = FRONTMATTER.exec(body);
    if (fence) return `${body.slice(0, fence[0].length)}\n${marker}\n${body.slice(fence[0].length)}`;
    return `${marker}\n\n${body}`;
  }

  if (isScript(sourcePath)) {
    const marker = scriptOriginHeader(source.source_id, sourcePath);
    const shebang = SHEBANG.exec(body);
    if (shebang) return `${body.slice(0, shebang[0].length)}${marker}\n${body.slice(shebang[0].length)}`;
    return `${marker}\n\n${body}`;
  }

  // JSON has no comment syntax, so a JSON projection genuinely cannot carry the
  // proof and stays a conflict until `--migrate-legacy`. That is a real limit,
  // not an oversight — and it is reported by name in the installer summary
  // rather than folded into an anonymous count.
  return normalized;
}

// Strips the marker from either accepted position — the top (pre-4.8.1 layout,
// and documents without frontmatter) or right below the frontmatter fence — so
// re-rendering never stacks a second marker. Deliberately anchored: a mention of
// the marker elsewhere in the body is left untouched.
function stripOriginHeader(content) {
  const text = String(content);
  if (MARKER_AT_TOP.test(text)) return text.replace(MARKER_AT_TOP, '');
  if (MARKER_AFTER_FRONTMATTER.test(text)) return text.replace(MARKER_AFTER_FRONTMATTER, '$1');
  if (SCRIPT_MARKER_AFTER_SHEBANG.test(text)) return text.replace(SCRIPT_MARKER_AFTER_SHEBANG, '$1');
  if (SCRIPT_MARKER_AT_TOP.test(text)) return text.replace(SCRIPT_MARKER_AT_TOP, '');
  return text;
}

// Ownership probe: a managed projection carries the marker in one of the two
// accepted positions, and nowhere else. Using startsWith here would classify every
// frontmatter-first projection as user-owned and silently stop updates; using a
// bare /m would do the opposite damage, classifying a USER file that merely quotes
// the marker (a doc with it in a fenced block) as generated, and overwriting it.
// So this reuses the same two anchors stripOriginHeader uses — one rule, one pair
// of regexes, no second copy to drift.
//
// The content is normalized first because this probe, unlike stripOriginHeader,
// runs against raw bytes read off disk: a CRLF file would fail `[ \t]*\n` and be
// misread as user-owned, which is the exact silent-stop this fix exists to avoid.
function hasOriginMarker(content) {
  const text = normalizeNewlines(String(content));
  return MARKER_AT_TOP.test(text)
    || MARKER_AFTER_FRONTMATTER.test(text)
    || SCRIPT_MARKER_AFTER_SHEBANG.test(text)
    || SCRIPT_MARKER_AT_TOP.test(text);
}

function walk(root) {
  if (!exists(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function safeJoin(root, relative) {
  const clean = relativeParts(relative).join(path.sep);
  if (!clean || isProtectedPath(clean)) fail(REASON.PROTECTED_PATH, `destino protegido: ${relative}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, clean);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(REASON.INVALID_OPTIONS, `destino fora da raiz: ${relative}`);
  }
  return resolved;
}

function isWithin(root, target) {
  const base = path.resolve(root);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function backupRelative(root, destination) {
  const scopes = [
    ['project', root.projectRoot],
    ['claude', root.claudeHome],
    ['forge', root.forgeHome],
  ];
  for (const [name, base] of scopes) {
    if (isWithin(base, destination)) {
      const relative = path.relative(path.resolve(base), path.resolve(destination)).replace(/\\/g, '/');
      return `${name}/${relative || path.basename(destination)}`;
    }
  }
  // A caller may deliberately project into an external absolute directory.
  // Keep the backup inside backupDir without interpreting repo-relative `..`.
  const digest = Buffer.from(path.resolve(destination), 'utf8').toString('hex');
  return `external/${digest}${path.extname(destination)}`;
}

function roots(options) {
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const paths = resolveForgePaths({
    cwd: repo,
    forgeHome: options.forgeHome,
    claudeHome: options.claudeHome,
    env: options.env,
    userHome: options.userHome,
    platform: options.platform,
  });
  return {
    repo,
    forgeHome: paths.forgeHome,
    claudeHome: paths.runtimeHomes.claude,
    projectRoot: path.resolve(options.projectRoot || repo),
  };
}

function destinationRoot(target, root) {
  const parts = relativeParts(target);
  const scope = parts[0];
  if (scope === 'project' || scope === 'forge') return { root: scope === 'project' ? root.projectRoot : root.forgeHome, relative: parts.slice(1).join('/') };
  return { root: root.claudeHome, relative: parts.join('/') };
}

function inputFiles(repo, input) {
  const absolute = safeJoin(repo, input);
  if (!exists(absolute)) fail(REASON.MISSING_SOURCE, `fonte ausente: ${input}`);
  return walk(absolute);
}

function targetFor(source, input, file, target, repo) {
  const inputRoot = safeJoin(repo.repo, input);
  const targetRoot = destinationRoot(target.path, repo);
  if (fs.statSync(inputRoot).isFile()) return safeJoin(targetRoot.root, targetRoot.relative);
  const relative = path.relative(inputRoot, file).replace(/\\/g, '/');
  return safeJoin(targetRoot.root, targetRoot.relative ? `${targetRoot.relative}/${relative}` : relative);
}

function selected(source) {
  const state = source.conditional && source.conditional[RUNTIME];
  return !state || !state.status || !['unavailable', 'planned'].includes(state.status);
}

// A bare ENOENT here names a path that should NOT hold this file: the caller
// pointed the renderer at something that is not a forge-agent clone (typically
// the Forge home, whose `scripts/` copy is managed core while the source
// manifest never is). The path is not the problem, so the message must name the
// flag that fixes it instead of the file that is legitimately absent.
function readManifest(root, manifestFile) {
  const file = path.resolve(manifestFile || path.join(root.repo, 'forge-source-manifest.json'));
  if (!exists(file)) fail(REASON.MISSING_MANIFEST, `manifesto de origem ausente: ${file} — ${root.repo} não é um clone do forge-agent; informe \`--repo <dir>\``);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  sourceManifest.audit(manifest);
  return manifest;
}

function render(options = {}) {
  const root = roots(options);
  const manifest = options.manifest || readManifest(root, options.manifestFile);
  sourceManifest.audit(manifest);
  const artifacts = [];
  for (const source of manifest.sources) {
    if (!selected(source)) continue;
    const targets = source.render_targets || [];
    source.inputs.forEach((input, index) => {
      const files = inputFiles(root.repo, input);
      const target = targets[index] || targets[0];
      if (!target) fail(REASON.INVALID_OPTIONS, `render target ausente: ${source.source_id}`);
      for (const file of files) {
        const relativeInput = path.relative(root.repo, file).replace(/\\/g, '/');
        const destination = targetFor(source, input, file, target, root);
        const content = addOriginHeader(fs.readFileSync(file, 'utf8'), source, relativeInput);
        artifacts.push({
          source_id: source.source_id,
          source: relativeInput,
          destination,
          relative: path.relative(root.repo, destination).replace(/\\/g, '/'),
          backup_relative: backupRelative(root, destination),
          content,
          bytes: Buffer.byteLength(content),
          newline: 'lf',
          origin: isMarkdown(relativeInput) ? originHeader(source.source_id, relativeInput) : null,
        });
      }
    });
  }
  artifacts.sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));
  return { runtime: RUNTIME, version: VERSION, repo: root.repo, forge_home: root.forgeHome, claude_home: root.claudeHome, project_root: root.projectRoot, artifacts };
}

function write(options = {}) {
  const report = render(options);
  const written = [];
  const preserved = [];
  const conflicts = [];
  // Destinations refused because they ARE their own source (§ forge-projection-self).
  // Kept in their own bucket: this is neither a conflict (nothing of the
  // operator's is being protected) nor a preservation (there is no projection
  // here to preserve) — it is a target that should never have resolved.
  const selfSourced = [];
  const recorded = (options.ownership && typeof options.ownership === 'object') ? options.ownership : {};
  // `provenance: null` disables the rung explicitly; absent means build one from
  // the repo we are rendering out of.
  const provenance = options.provenance === null
    ? null
    : (options.provenance || PROVENANCE.createResolver({ repo: report.repo }));
  const backupRoot = options.backupDir ? path.resolve(options.backupDir) : null;
  for (const artifact of report.artifacts) {
    const destination = artifact.destination;
    // FIRST, ahead of every ownership rung: those rungs answer "is this file
    // ours to rewrite", and for the canonical source the answer is yes — which
    // is exactly why they cannot protect it. The marker rung, the digest rung
    // and the release rung all GRANT ownership of a file whose bytes came from
    // this repo, and the source's bytes trivially did. Ordering this after them
    // would leave the guard unreachable.
    if (selfProjection.isSelfProjection({ repo: report.repo, source: artifact.source, destination })) {
      selfSourced.push({ ...artifact, reason: selfProjection.REASON });
      continue;
    }
    const current = exists(destination) ? fs.readFileSync(destination, 'utf8') : null;
    const generated = artifact.content;
    if (current !== null && current === generated) { preserved.push({ ...artifact, reason: 'already-current' }); continue; }
    // Checked BEFORE the user-owned branch, and deliberately NOT subject to the
    // `--migrate-legacy` escape below: migrate-legacy adopts unmarked files that are ours,
    // and this destination is never ours to adopt. Only an existing file is protected —
    // a fresh install with nothing on disk still gets the projection.
    if (current !== null && isOperatorOwned(destination)) {
      preserved.push({ ...artifact, reason: REASON.USER_OWNED });
      conflicts.push({ destination, source_id: artifact.source_id, reason: REASON.USER_OWNED });
      continue;
    }
    // Ownership is decided in one place for both renderers (§ forge-projection-ownership).
    // The digest rung is what a marker-less format (JSON) can reach; the marker
    // rung is unchanged, so nothing that was ours stops being ours. The release
    // rung is a thunk on purpose — repo history is only read for destinations that
    // actually get that far, so a clean update spawns no git at all.
    const verdict = ownership.decide({
      current,
      recordedDigest: recorded[ownership.keyFor(destination)],
      markerPresent: hasOriginMarker(current),
      migrateLegacy: Boolean(options.update && options.migrateLegacy),
      releaseDigests: provenance ? () => provenance.digestsFor(artifact.source) : undefined,
    });
    if (!verdict.ours) {
      // A preserved destination always says whether we could even check: "proved
      // to be yours" and "could not look" are different facts.
      const checked = provenance
        ? provenance.verdictFor(artifact.source, current)
        : { reason: PROVENANCE.REASONS.NOT_CONSULTED, revisions: 0, truncated: false };
      preserved.push({ ...artifact, reason: REASON.USER_OWNED });
      conflicts.push({
        destination,
        source_id: artifact.source_id,
        reason: REASON.USER_OWNED,
        digest: ownership.digest(current),
        provenance: checked.reason,
        revisions_checked: checked.revisions,
        ...(checked.truncated ? { provenance_truncated: true } : {}),
      });
      continue;
    }
    if (options.dryRun) { written.push({ ...artifact, dry_run: true }); continue; }
    if (current !== null && backupRoot) {
      const backup = safeJoin(backupRoot, artifact.backup_relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, current, 'utf8');
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, generated, 'utf8');
    // The basis is carried on the written entry so the summary can say WHY a
    // destination that used to be a permanent conflict is being replaced.
    if (verdict.basis === 'release') written.push({ ...artifact, reason: 'release-adopted', revisions_checked: provenance ? provenance.verdictFor(artifact.source, current).revisions : 0 });
    else written.push(options.migrateLegacy && current !== null && !hasOriginMarker(current)
      ? { ...artifact, reason: 'legacy-migrated' }
      : artifact);
  }
  // The record carries forward: destinations we own but did NOT rewrite this run
  // (`already-current`) must keep their digest, or the next run finds no record,
  // no marker on a JSON file, and re-freezes it. Conflicts are excluded — we did
  // not write them, so we have no claim to record.
  const ownedNow = [
    ...written,
    ...preserved.filter((item) => item.reason === 'already-current'),
  ];
  const nextOwnership = { ...recorded, ...ownership.recordOf(ownedNow) };
  return {
    ...report,
    changed: written.some((item) => !item.dry_run),
    written,
    preserved,
    conflicts,
    self_sourced: selfSourced,
    ownership: options.dryRun ? recorded : nextOwnership,
    dry_run: Boolean(options.dryRun),
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { repo: path.resolve(__dirname, '..') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--manifest') out.manifestFile = argv[++i];
    else if (arg === '--claude-home') out.claudeHome = argv[++i];
    else if (arg === '--forge-home') out.forgeHome = argv[++i];
    else if (arg === '--project-root') out.projectRoot = argv[++i];
    else if (arg === '--backup-dir') out.backupDir = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--update') out.update = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else fail(REASON.INVALID_OPTIONS, `opção desconhecida: ${arg}`);
  }
  return out;
}

function main(argv = process.argv.slice(2), writeOutput = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { writeOutput('Usage: forge-claude-renderer.js [--repo DIR] [--claude-home DIR] [--forge-home DIR] [--project-root DIR] [--dry-run] [--update] [--json]\n'); return 0; }
    const report = write(options);
    writeOutput(options.json ? `${JSON.stringify(report)}\n` : `Claude renderer ${VERSION}: ${report.written.length} written, ${report.preserved.length} preserved\n`);
    return 0;
  } catch (error) {
    errorOutput(`forge-claude-renderer: ${error.code || 'error'}: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { VERSION, RUNTIME, REASON, ORIGIN_PREFIX, normalizeNewlines, isProtectedPath, originHeader, addOriginHeader, stripOriginHeader, hasOriginMarker, roots, render, write, parseArgs, main };
