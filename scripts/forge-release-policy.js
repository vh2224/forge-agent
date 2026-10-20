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
      blob_oid: '54e1b33026e3e5b5dc4da494cb301cdd27e72d7a',
      blob_sha256: '5c37cf20bab5613832e0a5efad3e5fa7b9494a57ddbd67a680e4510228e5ffdc',
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
      blob_oid: 'd7d9b8f929799b9d64aa83a2559146570407e2d5',
      blob_sha256: '1d1493e9a5f0e8925c64eed6d8f039ae48d6a70ac146b39f459f378d0b3ccb97',
      jobs: [{ key: 'app', kind: 'native', needs: [], name: 'Swift app and PTY regressions', runner: 'macos-26', matrix: null }],
    },
    release: {
      filename: 'release.yml', path: '.github/workflows/release.yml',
      blob_oid: '7005516a35662e5b0b30cb33cc63afef5d795fa6',
      blob_sha256: '66400e716b3acf4dd232cef21910b493ea31b612c07c0417966dfe85e84f655d',
      // Release is source-pinned but never waits for itself. S02/T04 changes this topology.
      jobs: [{ key: 'release', kind: 'publisher', needs: [], runner: 'ubuntu-latest', matrix: null }],
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
