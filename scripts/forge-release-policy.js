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
      blob_oid: 'e6d109109c8987804f8ecefde24e30aac73779b3',
      blob_sha256: 'dec063b8e069ddc0c1880a3a35e9aa8e9c2955f0fa2ad0d8f8fb87257730c2f2',
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
            {os: "ubuntu-latest",platform: "linux","shard-index":0,"shard-count":3,label: "ubuntu-latest, shard 1/3"},
            {os: "ubuntu-latest",platform: "linux","shard-index":1,"shard-count":3,label: "ubuntu-latest, shard 2/3"},
            {os: "ubuntu-latest",platform: "linux","shard-index":2,"shard-count":3,label: "ubuntu-latest, shard 3/3"},
            {os: "macos-latest",platform: "darwin","shard-index":0,"shard-count":5,label: "macos-latest, shard 1/5"},
            {os: "macos-latest",platform: "darwin","shard-index":1,"shard-count":5,label: "macos-latest, shard 2/5"},
            {os: "macos-latest",platform: "darwin","shard-index":2,"shard-count":5,label: "macos-latest, shard 3/5"},
            {os: "macos-latest",platform: "darwin","shard-index":3,"shard-count":5,label: "macos-latest, shard 4/5"},
            {os: "macos-latest",platform: "darwin","shard-index":4,"shard-count":5,label: "macos-latest, shard 5/5"},
            {os: "windows-latest",platform: "win32","shard-index":0,"shard-count":16,label: "windows-latest, shard 1/16"},
            {os: "windows-latest",platform: "win32","shard-index":1,"shard-count":16,label: "windows-latest, shard 2/16"},
            {os: "windows-latest",platform: "win32","shard-index":2,"shard-count":16,label: "windows-latest, shard 3/16"},
            {os: "windows-latest",platform: "win32","shard-index":3,"shard-count":16,label: "windows-latest, shard 4/16"},
            {os: "windows-latest",platform: "win32","shard-index":4,"shard-count":16,label: "windows-latest, shard 5/16"},
            {os: "windows-latest",platform: "win32","shard-index":5,"shard-count":16,label: "windows-latest, shard 6/16"},
            {os: "windows-latest",platform: "win32","shard-index":6,"shard-count":16,label: "windows-latest, shard 7/16"},
            {os: "windows-latest",platform: "win32","shard-index":7,"shard-count":16,label: "windows-latest, shard 8/16"},
            {os: "windows-latest",platform: "win32","shard-index":8,"shard-count":16,label: "windows-latest, shard 9/16"},
            {os: "windows-latest",platform: "win32","shard-index":9,"shard-count":16,label: "windows-latest, shard 10/16"},
            {os: "windows-latest",platform: "win32","shard-index":10,"shard-count":16,label: "windows-latest, shard 11/16"},
            {os: "windows-latest",platform: "win32","shard-index":11,"shard-count":16,label: "windows-latest, shard 12/16"},
            {os: "windows-latest",platform: "win32","shard-index":12,"shard-count":16,label: "windows-latest, shard 13/16"},
            {os: "windows-latest",platform: "win32","shard-index":13,"shard-count":16,label: "windows-latest, shard 14/16"},
            {os: "windows-latest",platform: "win32","shard-index":14,"shard-count":16,label: "windows-latest, shard 15/16"},
            {os: "windows-latest",platform: "win32","shard-index":15,"shard-count":16,label: "windows-latest, shard 16/16"},
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
      blob_oid: '9ba8dbfcce940f852143171ff6059eb730f0c547',
      blob_sha256: 'cb08cc3e2b98d3aa7d169cfe2bffec31d904a0bf3406d4e07713c23e4801008f',
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
