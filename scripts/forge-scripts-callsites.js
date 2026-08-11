#!/usr/bin/env node
'use strict';

/*
 * In-process canonical-path guard.  It deliberately reads the filesystem
 * rather than grep: ignored files must not turn an incomplete census into a
 * clean verdict.  The seven families are separate because each exists for a
 * different reason: local script preference, installed script fallback,
 * aliases after resolution, the distinct shared suffix, POSIX wrappers,
 * Windows wrappers, and prose that would otherwise teach the retired path.
 */
const fs = require('fs');
const path = require('path');

const CALL_SITE_FAMILIES = Object.freeze(['one-liner', 'bare-assign', 'aliased-var', 'shared-dir', 'bin-bash', 'bin-cmd', 'prose']);
const SKIP_REASONS = Object.freeze({ EXTENSION_NOT_SCANNED: 'extension-not-scanned', UNREADABLE: 'unreadable', SELF_FIXTURE: 'self-fixture', ROOT_NOT_FOUND: 'root-not-found', NOT_A_SCRIPT: 'not-a-script' });
const DEFAULT_ROOTS = Object.freeze(['agents', 'commands', 'skills', 'shared', 'bin']);
const SELF_FIXTURE_BASENAMES = new Set(['forge-scripts-callsites.js', 'forge-scripts-callsites.test.js']);
const EXTENSIONS = new Set(['.md', '.cmd', '.bat', '.sh', '.bash', '.js']);

// Executable call sites: the retired scripts root spelled literally.
const LEGACY_CALL_SITE = /(?:~|\$HOME|%USERPROFILE%)\/.claude\/scripts|(?:~|\$HOME|%USERPROFILE%)\\.claude\\scripts|FORGE_SHARED_DIR="(?:\$HOME|%USERPROFILE%)\/.claude/;
/*
 * Prose that teaches the retired resolution chain.  `~/.claude` occurs ~57
 * times in this tree and MOST of those are legitimate (runtime home of
 * agents/skills/settings/prefs, layout tables, forge-home.md itself), so a bare
 * mention can never be the signal — it would drown the guard in noise, which
 * kills it as surely as blindness does.  Only two narrow shapes are findings:
 * (a) the legacy home named as the location of a SHARED SPEC (`.../shared` or
 * `.../forge-<name>.md`), which now lives under {forgeHome}/shared; and (b) the
 * legacy home named as a step of the resolution chain itself ("into ~/.claude",
 * "~/.claude first, then falls back", "the engine in ~/.claude").
 */
const LEGACY_PROSE = Object.freeze([
  /(?:~|\$HOME|%USERPROFILE%)[\\/]\.claude[\\/](?:shared\b|forge-[\w-]+\.md)/,
  /\binto\s+`?(?:~|\$HOME|%USERPROFILE%)[\\/]\.claude/i,
  /(?:~|\$HOME|%USERPROFILE%)[\\/]\.claude\b.*\bfalls? back\b/i,
  /\bengine in\s+`?(?:~|\$HOME|%USERPROFILE%)[\\/]\.claude/i,
]);
function isLegacyProse(line) { return LEGACY_PROSE.some((pattern) => pattern.test(line)); }
function isLegacyLine(line) { return LEGACY_CALL_SITE.test(line) || isLegacyProse(line); }

function isShellScript(file) {
  if (path.extname(file)) return EXTENSIONS.has(path.extname(file));
  try { return fs.readFileSync(file, 'utf8').startsWith('#!'); } catch { return false; }
}
function walk(root, files, skipped) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { skipped.push({ path: root, reason: fs.existsSync(root) ? SKIP_REASONS.UNREADABLE : SKIP_REASONS.ROOT_NOT_FOUND }); return; }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { walk(file, files, skipped); continue; }
    if (!entry.isFile()) continue;
    if (SELF_FIXTURE_BASENAMES.has(entry.name)) { skipped.push({ path: file, reason: SKIP_REASONS.SELF_FIXTURE }); continue; }
    if (!isShellScript(file)) { skipped.push({ path: file, reason: path.extname(file) ? SKIP_REASONS.EXTENSION_NOT_SCANNED : SKIP_REASONS.NOT_A_SCRIPT }); continue; }
    files.push(file);
  }
}
function familiesFor(file, text, root) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const out = ['prose'];
  if (/\.md$/i.test(file) && /FORGE_SCRIPTS_DIR=\$\(/.test(text)) out.push('one-liner');
  if (/\.md$/i.test(file) && /FORGE_SCRIPTS_DIR=/.test(text)) out.push('bare-assign');
  if (/\.md$/i.test(file) && /\b[A-Z_]+="\$FORGE_SCRIPTS_DIR\//.test(text)) out.push('aliased-var');
  if (/\.md$/i.test(file) && /FORGE_SHARED_DIR=/.test(text)) out.push('shared-dir');
  if (rel.startsWith('bin/') && !/\.(cmd|bat)$/i.test(file)) out.push('bin-bash');
  if (/\.(cmd|bat)$/i.test(file)) out.push('bin-cmd');
  return out;
}
function findingFamily(file, line) {
  // Prose is decided before location: a sentence in bin/ is still prose.
  if (!LEGACY_CALL_SITE.test(line) && isLegacyProse(line)) return 'prose';
  if (/\.(cmd|bat)$/i.test(file)) return 'bin-cmd';
  if (path.dirname(file).endsWith(`${path.sep}bin`)) return 'bin-bash';
  if (/FORGE_SHARED_DIR=.*(?:\.claude|\/shared"?$)/.test(line)) return 'shared-dir';
  if (/^[A-Z_]+="(?:\$FORGE_SCRIPTS_DIR\/|(?:~|\$HOME|%USERPROFILE%)[\\/])/.test(line) && !/^FORGE_SCRIPTS_DIR=/.test(line)) return 'aliased-var';
  if (/FORGE_SCRIPTS_DIR=\$\(/.test(line)) return 'one-liner';
  if (/FORGE_SCRIPTS_DIR=/.test(line)) return 'bare-assign';
  return 'prose';
}
function scan(options = {}) {
  const root = path.resolve(options.root || process.cwd()); const files = []; const skipped = [];
  for (const name of DEFAULT_ROOTS) walk(path.join(root, name), files, skipped);
  const counts_by_family = Object.fromEntries(CALL_SITE_FAMILIES.map((x) => [x, 0]));
  const scanned_by_family = Object.fromEntries(CALL_SITE_FAMILIES.map((x) => [x, 0])); const findings = [];
  for (const file of files) {
    let text; try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { skipped.push({ path: file, reason: SKIP_REASONS.UNREADABLE }); continue; }
    const families = familiesFor(file, text, root); for (const family of families) scanned_by_family[family]++;
    text.split('\n').forEach((line, index) => {
      if (isLegacyLine(line)) {
        const family = findingFamily(file, line); counts_by_family[family]++; findings.push({ path: path.relative(root, file).replace(/\\/g, '/'), line: index + 1, family, text: line.trim() });
      }
    });
  }
  const missing = CALL_SITE_FAMILIES.filter((family) => scanned_by_family[family] === 0);
  const outcome = findings.length ? 'findings' : (files.length === 0 || missing.length ? 'scan-failed' : 'clean');
  return { outcome, scanned: files.length, counts_by_family, scanned_by_family, missing_families: missing, findings, skipped };
}
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--check' || arg === '--json') continue; if (arg === '--root' || arg === '--cwd') out.root = argv[++i]; else throw new Error(`unknown argument: ${arg}`); } return out; }
function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout)) { try { const report = scan(parseArgs(argv)); write(`${JSON.stringify(report)}\n`); return report.outcome === 'clean' ? 0 : 2; } catch (error) { write(`${JSON.stringify({ outcome: 'scan-failed', error: error.message })}\n`); return 2; } }
module.exports = { CALL_SITE_FAMILIES, SKIP_REASONS, scan, parseArgs, run };
if (require.main === module) process.exitCode = run();
