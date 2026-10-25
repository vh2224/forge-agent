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
      blob_oid: '1e445bfaa5ba6ddb43fe8b368bd13718f2de74a9',
      blob_sha256: '4710b62fa4dd556a907b9b54d216decece284ba2de9caee2420a4d02388e9efe',
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
            { os: 'ubuntu-latest', platform: 'linux', 'shard-index': 0, 'shard-count': 1, label: 'ubuntu-latest' },
            { os: 'macos-latest', platform: 'darwin', 'shard-index': 0, 'shard-count': 1, label: 'macos-latest' },
            { os: 'windows-latest', platform: 'win32', 'shard-index': 0, 'shard-count': 2, label: 'windows-latest, shard 1/2' },
            { os: 'windows-latest', platform: 'win32', 'shard-index': 1, 'shard-count': 2, label: 'windows-latest, shard 2/2' },
          ] } },
        { key: 'required-offline-windows', kind: 'alias', needs: ['operational-offline'],
          name: 'Offline ${{ matrix.host }} / ${{ matrix.platform }}', runner: 'ubuntu-latest',
          matrix: { host: ['claude', 'codex'], platform: ['linux', 'darwin', 'win32'] } },
        { key: 'required-tests-windows', kind: 'alias', needs: ['test'],
          name: 'Tests (windows-latest)', runner: 'ubuntu-latest', matrix: null },
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
      blob_oid: '315d89bad9b4ef2965d3a2f3e969fd83005e61d2',
      blob_sha256: 'c19b795426f6d0cec090630f90f1c3aa45d3bc83d573aab92cac332e0f3017a3',
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
