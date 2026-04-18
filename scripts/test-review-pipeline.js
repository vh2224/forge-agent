#!/usr/bin/env node
/**
 * Validates the review-scan changes in forge-completer and forge-task.
 *
 * Covers deterministic pieces that don't require live agent dispatch:
 * - review.mode pref cascade (user-global → repo → local)
 * - Pattern scan semantics against synthetic code samples
 * - Review Flags section builder (4 merge scenarios)
 * - DIFF_CMD composition for forge-task
 * - forge-reviewer.md frontmatter integrity
 * - Migration cleanup (no stale "Security Flags" references)
 * - Installer coverage (glob match)
 *
 * Usage:  node scripts/test-review-pipeline.js [--rounds=N]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROUNDS = Number((process.argv.find(a => a.startsWith('--rounds=')) || '--rounds=3').split('=')[1]);

let totalPass = 0, totalFail = 0;
const roundStats = [];

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-test-'));
}
function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ───────────────────────────────────────────────────────────────
// Logic extracted from agent files. Changes here should track
// forge-completer.md § step 4 and forge-task SKILL.md § step 5.5.
// ───────────────────────────────────────────────────────────────

function readReviewMode(workingDir, userGlobal) {
  const files = [
    userGlobal,
    path.join(workingDir, '.gsd', 'claude-agent-prefs.md'),
    path.join(workingDir, '.gsd', 'prefs.local.md'),
  ].filter(Boolean);
  let mode = 'enabled';
  for (const f of files) {
    try {
      const r = fs.readFileSync(f, 'utf8');
      const m = r.match(/^review:[ \t]*\n[ \t]+mode:[ \t]*(\w+)/m);
      if (m) mode = m[1].toLowerCase();
    } catch {}
  }
  return mode;
}

const RISKY_PATTERNS = [
  { name: 'eval', re: /\beval\s*\(/ },
  { name: 'exec-call', re: /(?:^|[^a-zA-Z_])exec\s*\(/ },
  { name: 'innerHTML', re: /\binnerHTML\s*=/ },
  { name: 'dangerouslySetInnerHTML', re: /\bdangerouslySetInnerHTML\b/ },
  { name: 'sql-concat', re: /\.query\s*\(\s*["'][^"']*["']\s*\+/ },
  { name: 'log-secret', re: /console\.log[^;]*(?:token|password|secret)/i },
  { name: 'shell-true', re: /shell\s*=\s*True/ },
  { name: 'os-system', re: /\bos\.system\s*\(/ },
];

function patternScan(files) {
  const hits = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      for (const { name, re } of RISKY_PATTERNS) {
        if (re.test(line)) {
          hits.push({ file: path.basename(file), line: idx + 1, pattern: name, snippet: line.trim() });
        }
      }
    });
  }
  return hits;
}

function buildReviewFlagsSection(patternHits, llmFindings) {
  const hasPatterns = patternHits.length > 0;
  const hasLlm = llmFindings && llmFindings.trim().length > 0;
  if (!hasPatterns && !hasLlm) return '';

  let out = '## ⚠ Review Flags\n\n';
  out += '_Advisory — pattern scan + adversarial reviewer on slice diff. No action taken; recorded for auditing._\n\n';

  if (hasLlm) out += llmFindings.trim() + '\n\n';

  if (hasPatterns) {
    out += '### Pattern Hits\n';
    for (const h of patternHits) {
      out += `- \`${h.file}:${h.line}\` — pattern \`${h.pattern}\` — ${h.snippet}\n`;
    }
  }
  return out.trimEnd() + '\n';
}

function computeDiffCmd(startSha, currentHead) {
  if (startSha && startSha !== currentHead) return `git diff ${startSha}..HEAD`;
  return 'git diff HEAD';
}

// ───────────────────────────────────────────────────────────────
// Test harness
// ───────────────────────────────────────────────────────────────

function runRound(roundNum) {
  let pass = 0, fail = 0;
  const failures = [];

  const test = (name, fn) => {
    try {
      fn();
      pass++;
    } catch (e) {
      fail++;
      failures.push({ name, error: e.message.split('\n')[0].slice(0, 200) });
    }
  };

  // T1 — pref cascade
  test('T1.1 default = enabled when no prefs', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, '.gsd'));
    assert.strictEqual(readReviewMode(dir, null), 'enabled');
    rmTmp(dir);
  });

  test('T1.2 repo prefs mode: disabled', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'claude-agent-prefs.md'), 'review:\n  mode: disabled\n');
    assert.strictEqual(readReviewMode(dir, null), 'disabled');
    rmTmp(dir);
  });

  test('T1.3 local overrides repo', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'claude-agent-prefs.md'), 'review:\n  mode: enabled\n');
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'), 'review:\n  mode: disabled\n');
    assert.strictEqual(readReviewMode(dir, null), 'disabled');
    rmTmp(dir);
  });

  test('T1.4 user-global applies when repo empty', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, '.gsd'));
    const userGlobal = path.join(dir, 'user-prefs.md');
    fs.writeFileSync(userGlobal, 'review:\n  mode: disabled\n');
    assert.strictEqual(readReviewMode(dir, userGlobal), 'disabled');
    rmTmp(dir);
  });

  test('T1.5 case-insensitive mode value', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'claude-agent-prefs.md'), 'review:\n  mode: DISABLED\n');
    assert.strictEqual(readReviewMode(dir, null), 'disabled');
    rmTmp(dir);
  });

  test('T1.6 malformed section falls back to default', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'claude-agent-prefs.md'), 'review: disabled\n');
    assert.strictEqual(readReviewMode(dir, null), 'enabled');
    rmTmp(dir);
  });

  test('T1.7 coexists with other prefs blocks', () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'claude-agent-prefs.md'),
      'evidence:\n  mode: strict\n\nreview:\n  mode: disabled\n\nauto_commit: true\n');
    assert.strictEqual(readReviewMode(dir, null), 'disabled');
    rmTmp(dir);
  });

  // T2 — pattern scan
  test('T2.1 detects eval()', () => {
    const dir = mkTmp();
    const f = path.join(dir, 'bad.js');
    fs.writeFileSync(f, 'const x = eval("1+1");\n');
    assert.strictEqual(patternScan([f]).length, 1);
    rmTmp(dir);
  });

  test('T2.2 detects innerHTML assignment', () => {
    const dir = mkTmp();
    const f = path.join(dir, 'dom.js');
    fs.writeFileSync(f, 'el.innerHTML = userInput;\n');
    const hits = patternScan([f]);
    assert.ok(hits.some(h => h.pattern === 'innerHTML'));
    rmTmp(dir);
  });

  test('T2.3 detects shell=True', () => {
    const dir = mkTmp();
    const f = path.join(dir, 'run.py');
    fs.writeFileSync(f, 'subprocess.run(cmd, shell=True)\n');
    assert.strictEqual(patternScan([f]).length, 1);
    rmTmp(dir);
  });

  test('T2.4 detects SQL concat', () => {
    const dir = mkTmp();
    const f = path.join(dir, 'db.js');
    fs.writeFileSync(f, 'db.query("SELECT * FROM u WHERE id=" + uid);\n');
    const hits = patternScan([f]);
    assert.ok(hits.some(h => h.pattern === 'sql-concat'));
    rmTmp(dir);
  });

  test('T2.5 detects console.log secret', () => {
    const dir = mkTmp();
    const f = path.join(dir, 'auth.js');
    fs.writeFileSync(f, 'console.log("token is " + token);\n');
    const hits = patternScan([f]);
    assert.ok(hits.some(h => h.pattern === 'log-secret'));
    rmTmp(dir);
  });

  test('T2.6 detects os.system', () => {
    const dir = mkTmp();
    const f = path.join(dir, 'sys.py');
    fs.writeFileSync(f, 'os.system("ls")\n');
    assert.strictEqual(patternScan([f]).length, 1);
    rmTmp(dir);
  });

  test('T2.7 ignores clean code', () => {
    const dir = mkTmp();
    const f = path.join(dir, 'safe.js');
    fs.writeFileSync(f, 'const x = JSON.parse(input);\nconsole.log("hello world");\n');
    assert.strictEqual(patternScan([f]).length, 0);
    rmTmp(dir);
  });

  test('T2.8 does NOT false-positive on the word "execute" in comments', () => {
    const dir = mkTmp();
    const f = path.join(dir, 'comment.js');
    fs.writeFileSync(f, '// execute the plan\nconst y = 1;\n');
    assert.strictEqual(patternScan([f]).length, 0);
    rmTmp(dir);
  });

  // T3 — section builder
  test('T3.1 empty + empty = no section', () => {
    assert.strictEqual(buildReviewFlagsSection([], ''), '');
  });

  test('T3.2 only pattern hits → no Critical heading', () => {
    const out = buildReviewFlagsSection(
      [{ file: 'a.js', line: 5, pattern: 'eval', snippet: 'eval(x)' }],
      ''
    );
    assert.ok(out.includes('## ⚠ Review Flags'));
    assert.ok(out.includes('### Pattern Hits'));
    assert.ok(!out.includes('### Critical'));
    assert.ok(out.includes('a.js:5'));
  });

  test('T3.3 only LLM findings → no Pattern Hits heading', () => {
    const llm = '### High\n- `a.js:10` — missing null check — add guard\n';
    const out = buildReviewFlagsSection([], llm);
    assert.ok(out.includes('## ⚠ Review Flags'));
    assert.ok(out.includes('### High'));
    assert.ok(!out.includes('### Pattern Hits'));
  });

  test('T3.4 both combined preserves both', () => {
    const llm = '### Critical\n- `b.js:1` — race condition — add lock\n';
    const out = buildReviewFlagsSection(
      [{ file: 'a.js', line: 5, pattern: 'eval', snippet: 'eval(x)' }],
      llm
    );
    assert.ok(out.includes('### Critical'));
    assert.ok(out.includes('### Pattern Hits'));
    assert.ok(out.includes('a.js:5'));
    assert.ok(out.includes('b.js:1'));
  });

  test('T3.5 NO_FLAGS sentinel treated as empty', () => {
    const out = buildReviewFlagsSection([], 'NO_FLAGS');
    assert.ok(out.includes('## ⚠ Review Flags'));
    // "NO_FLAGS" is non-empty text — builder echoes it. In real flow orchestrator
    // must strip NO_FLAGS before calling builder. Document that contract:
    assert.ok(out.includes('NO_FLAGS'));
  });

  // T4 — DIFF_CMD composition
  test('T4.1 no start SHA → working tree diff', () => {
    assert.strictEqual(computeDiffCmd('', 'abc'), 'git diff HEAD');
  });

  test('T4.2 same SHA → working tree diff', () => {
    assert.strictEqual(computeDiffCmd('abc', 'abc'), 'git diff HEAD');
  });

  test('T4.3 different SHA → range diff', () => {
    assert.strictEqual(computeDiffCmd('abc', 'def'), 'git diff abc..HEAD');
  });

  // T5 — forge-reviewer.md integrity
  test('T5.1 forge-reviewer.md exists', () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'agents', 'forge-reviewer.md')));
  });

  test('T5.2 has valid frontmatter with name/model/tools', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'forge-reviewer.md'), 'utf8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm);
    assert.ok(/^name:\s*forge-reviewer\s*$/m.test(fm[1]));
    assert.ok(/^model:\s*claude-sonnet/m.test(fm[1]));
    assert.ok(/^tools:/m.test(fm[1]));
  });

  test('T5.3 reviewer is read-only (no Write/Edit)', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'forge-reviewer.md'), 'utf8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/)[1];
    const tools = fm.match(/^tools:\s*(.+)$/m)[1];
    assert.ok(!/\bWrite\b/.test(tools), `Write leaked into tools: ${tools}`);
    assert.ok(!/\bEdit\b/.test(tools), `Edit leaked into tools: ${tools}`);
  });

  test('T5.4 reviewer describes NO_FLAGS sentinel', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'forge-reviewer.md'), 'utf8');
    assert.ok(content.includes('NO_FLAGS'));
  });

  // T6 — migration cleanup
  test('T6.1 forge-completer uses "Review Flags" (new name)', () => {
    const c = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'forge-completer.md'), 'utf8');
    assert.ok(c.includes('## ⚠ Review Flags'));
  });

  test('T6.2 forge-completer has no stale "Security Flags" heading', () => {
    const c = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'forge-completer.md'), 'utf8');
    assert.ok(!c.includes('## ⚠ Security Flags'), 'stale heading still present');
  });

  test('T6.3 forge-task SKILL has Step 5.5 Review', () => {
    const s = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
    assert.ok(s.includes('### Step 5.5 — Review'));
    assert.ok(s.includes('.start-sha'));
  });

  test('T6.4 forge-task SKILL dispatches forge-reviewer', () => {
    const s = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
    assert.ok(s.includes('forge-reviewer'));
  });

  // T7 — installer glob coverage
  test('T7.1 forge-reviewer.md matches install glob "forge*.md"', () => {
    const files = fs.readdirSync(path.join(REPO_ROOT, 'agents'))
      .filter(f => f.startsWith('forge') && f.endsWith('.md'));
    assert.ok(files.includes('forge-reviewer.md'));
  });

  roundStats.push({ round: roundNum, pass, fail, failures });
  totalPass += pass;
  totalFail += fail;
}

// ───────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────

console.log(`\nRunning review-pipeline validation — ${ROUNDS} round(s)\n`);
const t0 = Date.now();

for (let i = 1; i <= ROUNDS; i++) {
  const r0 = Date.now();
  runRound(i);
  const stats = roundStats[i - 1];
  const ms = Date.now() - r0;
  console.log(`Round ${i}:  ${stats.pass} pass  ${stats.fail} fail  (${ms}ms)`);
  if (stats.fail) {
    for (const f of stats.failures) console.log(`   ✗ ${f.name} — ${f.error}`);
  }
}

const dur = Date.now() - t0;
console.log(`\n${'─'.repeat(52)}`);
console.log(`Total: ${totalPass} pass  ${totalFail} fail  over ${ROUNDS} round(s)  ${dur}ms`);

// Stability check — same pass/fail count per round
const firstRound = roundStats[0];
const stable = roundStats.every(r => r.pass === firstRound.pass && r.fail === firstRound.fail);
console.log(`Stability: ${stable ? 'DETERMINISTIC ✓' : 'NON-DETERMINISTIC ✗'}`);

process.exit(totalFail === 0 ? 0 : 1);
