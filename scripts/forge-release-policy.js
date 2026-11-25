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
      blob_oid: 'f622e6dc51f8189457b77e3748be8c1c88f79787',
      blob_sha256: '89e0decdd02654bb09a50f187c61dca83dfbc796f0846a86feb03c3275f5fd78',
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
            {os: "ubuntu-latest",platform: "linux","shard-index":0,"shard-count":6,label: "ubuntu-latest, shard 1/6",workers: 2,"single-worker-jobs":0},
            {os: "ubuntu-latest",platform: "linux","shard-index":1,"shard-count":6,label: "ubuntu-latest, shard 2/6",workers: 2,"single-worker-jobs":0},
            {os: "ubuntu-latest",platform: "linux","shard-index":2,"shard-count":6,label: "ubuntu-latest, shard 3/6",workers: 2,"single-worker-jobs":0},
            {os: "ubuntu-latest",platform: "linux","shard-index":3,"shard-count":6,label: "ubuntu-latest, shard 4/6",workers: 2,"single-worker-jobs":0},
            {os: "ubuntu-latest",platform: "linux","shard-index":4,"shard-count":6,label: "ubuntu-latest, shard 5/6",workers: 2,"single-worker-jobs":0},
            {os: "ubuntu-latest",platform: "linux","shard-index":5,"shard-count":6,label: "ubuntu-latest, shard 6/6",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":0,"shard-count":8,label: "macos-latest, shard 1/8",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":1,"shard-count":8,label: "macos-latest, shard 2/8",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":2,"shard-count":8,label: "macos-latest, shard 3/8",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":3,"shard-count":8,label: "macos-latest, shard 4/8",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":4,"shard-count":8,label: "macos-latest, shard 5/8",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":5,"shard-count":8,label: "macos-latest, shard 6/8",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":6,"shard-count":8,label: "macos-latest, shard 7/8",workers: 2,"single-worker-jobs":0},
            {os: "macos-latest",platform: "darwin","shard-index":7,"shard-count":8,label: "macos-latest, shard 8/8",workers: 2,"single-worker-jobs":0},
            {os: "windows-latest",platform: "win32","shard-index":0,"shard-count":27,label: "windows-latest, shard 1/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":1,"shard-count":27,label: "windows-latest, shard 2/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":2,"shard-count":27,label: "windows-latest, shard 3/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":3,"shard-count":27,label: "windows-latest, shard 4/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":4,"shard-count":27,label: "windows-latest, shard 5/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":5,"shard-count":27,label: "windows-latest, shard 6/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":6,"shard-count":27,label: "windows-latest, shard 7/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":7,"shard-count":27,label: "windows-latest, shard 8/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":8,"shard-count":27,label: "windows-latest, shard 9/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":9,"shard-count":27,label: "windows-latest, shard 10/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":10,"shard-count":27,label: "windows-latest, shard 11/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":11,"shard-count":27,label: "windows-latest, shard 12/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":12,"shard-count":27,label: "windows-latest, shard 13/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":13,"shard-count":27,label: "windows-latest, shard 14/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":14,"shard-count":27,label: "windows-latest, shard 15/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":15,"shard-count":27,label: "windows-latest, shard 16/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":16,"shard-count":27,label: "windows-latest, shard 17/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":17,"shard-count":27,label: "windows-latest, shard 18/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":18,"shard-count":27,label: "windows-latest, shard 19/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":19,"shard-count":27,label: "windows-latest, shard 20/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":20,"shard-count":27,label: "windows-latest, shard 21/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":21,"shard-count":27,label: "windows-latest, shard 22/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":22,"shard-count":27,label: "windows-latest, shard 23/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":23,"shard-count":27,label: "windows-latest, shard 24/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":24,"shard-count":27,label: "windows-latest, shard 25/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":25,"shard-count":27,label: "windows-latest, shard 26/27",workers: 2,"single-worker-jobs":18},
            {os: "windows-latest",platform: "win32","shard-index":26,"shard-count":27,label: "windows-latest, shard 27/27",workers: 2,"single-worker-jobs":18},
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
