'use strict';

const { MATRIX } = require('./forge-offline-ci.js');

// Reviewed Git blob bytes, not checkout bytes or GitHub workflow metadata.
// Updating a workflow requires reviewing its semantic mappings and these pins.
const POLICY = {
  schema_version: 1,
  branch: 'master',
  ref: 'refs/heads/master',
  origin_event: 'push',
  release_workflow: '.github/workflows/release.yml',
  workflows: {
    ci: {
      filename: 'ci.yml', path: '.github/workflows/ci.yml',
      blob_oid: 'ba9c6634c7d9a67313d51588af00ae20de8bb0ef',
      blob_sha256: '9a9ccc6f3f7b9bf5cd69830edf93ec89f1715004c9065648dc0148dfc5d4b2ff',
      jobs: [
        { key: 'operational-offline', kind: 'native', needs: [],
          name: 'Offline ${{ matrix.host }} / ${{ matrix.platform }}',
          runner: '${{ matrix.os }}', matrix: { include: [
            { host: 'both', os: 'ubuntu-latest', platform: 'linux' },
            { host: 'both', os: 'macos-latest', platform: 'darwin' },
            { host: 'both', os: 'windows-latest', platform: 'win32' },
          ] } },
        { key: 'test', kind: 'native', needs: [], name: 'Tests (${{ matrix.label }})',
          runner: '${{ matrix.os }}', matrix: { include: [
            {os: "ubuntu-latest",platform: "linux","shard-index":0,"shard-count":3,label: "ubuntu-latest, shard 1/3",workers: 2,"single-worker-jobs":0},
            {os: "ubuntu-latest",platform: "linux","shard-index":1,"shard-count":3,label: "ubuntu-latest, shard 2/3",workers: 2,"single-worker-jobs":0},
            {os: "ubuntu-latest",platform: "linux","shard-index":2,"shard-count":3,label: "ubuntu-latest, shard 3/3",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":0,"shard-count":5,label: "macos-latest, shard 1/5",workers: 3,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":1,"shard-count":5,label: "macos-latest, shard 2/5",workers: 3,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":2,"shard-count":5,label: "macos-latest, shard 3/5",workers: 3,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":3,"shard-count":5,label: "macos-latest, shard 4/5",workers: 3,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":4,"shard-count":5,label: "macos-latest, shard 5/5",workers: 3,"single-worker-jobs":0},
            {os: "windows-latest",platform: "win32","shard-index":0,"shard-count":21,label: "windows-latest, shard 1/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":1,"shard-count":21,label: "windows-latest, shard 2/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":2,"shard-count":21,label: "windows-latest, shard 3/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":3,"shard-count":21,label: "windows-latest, shard 4/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":4,"shard-count":21,label: "windows-latest, shard 5/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":5,"shard-count":21,label: "windows-latest, shard 6/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":6,"shard-count":21,label: "windows-latest, shard 7/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":7,"shard-count":21,label: "windows-latest, shard 8/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":8,"shard-count":21,label: "windows-latest, shard 9/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":9,"shard-count":21,label: "windows-latest, shard 10/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":10,"shard-count":21,label: "windows-latest, shard 11/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":11,"shard-count":21,label: "windows-latest, shard 12/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":12,"shard-count":21,label: "windows-latest, shard 13/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":13,"shard-count":21,label: "windows-latest, shard 14/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":14,"shard-count":21,label: "windows-latest, shard 15/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":15,"shard-count":21,label: "windows-latest, shard 16/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":16,"shard-count":21,label: "windows-latest, shard 17/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":17,"shard-count":21,label: "windows-latest, shard 18/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":18,"shard-count":21,label: "windows-latest, shard 19/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":19,"shard-count":21,label: "windows-latest, shard 20/21",workers: 2,"single-worker-jobs":2},
            {os: "windows-latest",platform: "win32","shard-index":20,"shard-count":21,label: "windows-latest, shard 21/21",workers: 2,"single-worker-jobs":2},
          ] } },
        { key: 'required-offline-windows', kind: 'alias', needs: ['operational-offline'],
          name: 'Offline ${{ matrix.host }} / ${{ matrix.platform }}', runner: 'ubuntu-latest',
          matrix: { host: ['claude', 'codex'], platform: ['linux', 'darwin', 'win32'] } },
        { key: 'required-tests-windows', kind: 'alias', needs: ['test'],
          name: 'Tests (windows-latest)', runner: 'ubuntu-latest', matrix: null },
        { key: 'required-tests-macos', kind: 'alias', needs: ['test'],
          name: 'Tests (macos-latest)', runner: 'ubuntu-latest', matrix: null },
        { key: 'required-tests-linux', kind: 'alias', needs: ['test'],
          name: 'Tests (ubuntu-latest)', runner: 'ubuntu-latest', matrix: null },
      ],
    },
    app: {
      filename: 'app.yml', path: '.github/workflows/app.yml',
      blob_oid: '2b8b405ca5e30d2213cad659d1f26d084df95938',
      blob_sha256: 'aa82f5187c6872e6cb8f9b468f5812b4f1e118fba0997b4351ea7c2f4f07296f',
      jobs: [{ key: 'app', kind: 'native', needs: [], name: 'Swift app and PTY regressions', runner: 'macos-26', matrix: null }],
    },
    release: {
      filename: 'release.yml', path: '.github/workflows/release.yml',
      blob_oid: '5744ef2dab6a61eb506a44fb55bc6334238be275',
      blob_sha256: 'fed157d55bd63ea53dd9d52b3c5efff28f9ca521013fe4f9943deb4f6edf1d09',
      // Release is source-pinned but never waits for itself; job identity binds receipts.
      jobs: [
        { key: 'coordinator', kind: 'coordinator', name: 'Release coordinator', needs: [], runner: 'ubuntu-latest', matrix: null, permissions: { contents: 'read', actions: 'read' } },
        { key: 'publisher', kind: 'publisher', name: 'Release publisher', needs: ['coordinator'], runner: 'ubuntu-latest', matrix: null, permissions: { contents: 'write', actions: 'read' } },
      ],
    },
  },
  local: {
    version: 'forge-release-version --check; preserve no-publication/semver semantics',
    tree: 'clean before and after; stable HEAD and status',
    hosts: MATRIX.hosts, platforms: MATRIX.platforms, suites: MATRIX.suites,
    offline_kind: 'simulation',
    regeneration_platforms: MATRIX.platforms,
    regeneration: 'three unique platforms; matching tree/package digests; idempotent',
    package: 'forge-package build/checksum', security: 'forge-release-gate securityAudit',
    real_provider_smoke: 'manual-opt-in',
    ci_baseline: 'no new failures and no stale known-failure entries; discover suites dynamically',
  },
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

module.exports = deepFreeze(POLICY);
