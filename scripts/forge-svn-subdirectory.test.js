#!/usr/bin/env node
'use strict';

// #349: exercise the public consumers against one disposable SVN 1.7+ WC.
// Only the WC root has .svn; projects (including literal @ names) live below it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ignore = require('./forge-ignore');
const vcs = require('./forge-vcs');
const svnLab = require('./forge-svn-lab');

if (!svnLab.hasSvnToolchain()) {
  if (process.env.CI) throw new Error('SVN subdirectory regression requires svn and svnadmin');
  process.stdout.write('SKIP SVN subdirectory regression: svn and svnadmin are required\n');
} else {
  const lab = svnLab.createLab('forge-svn-subdirectory-');
  const names = ['plain', 'Chart IQ@1.0.0', 'literal@', 'release@1'];
  const taskId = 'T-20261106000000-svn-subdirectory';
  const reviewFile = `.gsd/tasks/${taskId}/${taskId}-REVIEW.md`;
  const write = (relative, content) => {
    const target = svnLab.guardTarget(lab.root, path.join(lab.wc, relative));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const svn = args => {
    const result = svnLab.run(['svn', '--non-interactive', '--config-dir', lab.config, ...args], { cwd: lab.wc });
    assert.strictEqual(result.exit, 0, result.stderr);
  };
  const cli = (script, args, cwd = lab.wc) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `${script}: ${result.stderr}`);
    return result.stdout;
  };
  try {
    svnLab.initializeSvn(lab);
    for (const name of names) {
      write(`projects/${name}/src/a.js`, 'before\n');
      write(`projects/${name}/src/theirs.js`, 'other owner\n');
    }
    write('outside.txt', 'outside project\n');
    svn(['add', '--', 'projects@', 'outside.txt@']);
    svn(['commit', '-m', 'disposable subdirectory fixture']);
    svn(['update']);
    write('outside.txt', 'outside project dirty\n');

    assert.ok(fs.statSync(path.join(lab.wc, '.svn')).isDirectory());
    assert.strictEqual(ignore.detectVcs(lab.wc), 'svn');
    assert.strictEqual(ignore.detectVcs(lab.evidence), 'none');
    for (const name of names) {
      const relative = `projects/${name}`;
      const cwd = path.join(lab.wc, relative);
      assert.strictEqual(fs.existsSync(path.join(cwd, '.svn')), false);
      assert.strictEqual(ignore.detectVcs(cwd), 'svn', `detectVcs: ${name}`);
      assert.deepStrictEqual(JSON.parse(cli('forge-vcs.js', ['--detect', '--cwd', cwd])), { vcs: 'svn', ok: true });
      // Relative cwd must resolve from the caller, including names ending in @.
      assert.strictEqual(cli('forge-vcs.js', ['--detect', '--cwd', '.', '--field', 'vcs'], cwd).trim(), 'svn');

      write(`${relative}/src/a.js`, 'changed by this unit\n');
      write(`${relative}/src/theirs.js`, 'other owner dirty\n');
      write(`${relative}/src/new.js`, 'new unit file\n');
      write(`${relative}/${reviewFile}`, '# Review\n\n### R1 — fix\n- **Veredito:** CONCEDED\n');
      const unitDir = path.dirname(path.join(cwd, reviewFile));
      write(`${relative}/.gsd/tasks/${taskId}/${taskId}-PLAN.md`,
        '---\nexpected_output:\n  - src/a.js\n  - src/new.js\n---\n');
      const reviewArgs = ['--cwd', cwd, '--unit-dir', unitDir];
      const scope = JSON.parse(cli('forge-review-diff.js', [...reviewArgs, '--scope-report']));
      assert.strictEqual(scope.vcs, 'svn');
      assert.strictEqual(scope.reason, 'manifest');
      assert.deepStrictEqual(scope.scoped, ['src/a.js', 'src/new.js']);
      assert.ok(scope.excluded.includes('src/theirs.js'));
      const diff = cli('forge-review-diff.js', reviewArgs);
      assert.ok(diff.includes('+changed by this unit'));
      assert.ok(diff.includes('+new unit file'));
      assert.ok(!diff.includes('other owner dirty'));
      assert.ok(!diff.includes('outside project dirty'));

      const request = { cwd, contextRoot: cwd, vcs: 'svn', taskId,
        dispatchId: 'svn-subdirectory-fixture', constraints: { auto_commit: false },
        reviewFix: { boundary: 'task', decision: 'proceed', claimPaths: ['src/a.js'],
          items: [{ r: 'R1', path: 'src/a.js', verdict: { resolution: 'conceded', severity: 'high',
            reachable: 'yes', reproduced: 'yes', in_scope: 'yes' } }] } };
      const requestFile = path.join(lab.evidence, 'request.json');
      fs.writeFileSync(requestFile, JSON.stringify(request));
      const preparation = JSON.parse(cli('forge-review-fix.js', ['--prepare-native', requestFile]));
      assert.strictEqual(preparation.vcs, 'svn');
      assert.strictEqual(preparation.code_dir, fs.realpathSync.native(cwd));
      assert.deepStrictEqual(preparation.brief.claim_paths, ['src/a.js']);
      assert.ok(vcs.validateSvnStrictSnapshot(preparation.svnSnapshot));
      assert.strictEqual(preparation.svnSnapshot.coverage.code_dir, fs.realpathSync.native(cwd));
      assert.strictEqual(fs.readFileSync(path.join(cwd, 'src/theirs.js'), 'utf8'), 'other owner dirty\n');
      process.stdout.write(`PASS SVN subdirectory detection, scoped diff and native preparation: ${name}\n`);
    }
    assert.strictEqual(fs.readFileSync(path.join(lab.wc, 'outside.txt'), 'utf8'), 'outside project dirty\n');
  } finally {
    svnLab.cleanupChildren(lab);
  }
}
