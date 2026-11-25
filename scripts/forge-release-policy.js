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
      blob_oid: 'b7582cecb76cbc073315e5c60db23fb9d16c2bcc',
      blob_sha256: 'a267dad84ec8462b6aa3024985fad7c4133f20dea9ffcf5a8f2339b9993cae99',
      jobs: [
        { key: 'operational-offline', kind: 'native', needs: [],
          name: 'Offline ${{ matrix.host }} / ${{ matrix.platform }}',
          runner: '${{ matrix.os }}', matrix: { include: [
            { host: 'both', os: 'ubuntu-latest', platform: 'linux' },
            { host: 'both', os: 'macos-latest', platform: 'darwin' },
            { host: 'both', os: 'windows-latest', platform: 'win32' },
          ] } },
        { key: 'test', kind: 'native', needs: [], name: 'Tests (${{ matrix.label }})', max_parallel: 32,
          runner: '${{ matrix.os }}', matrix: { include: [
            {"os":"ubuntu-latest","platform":"linux","shard-index":0,"shard-count":13,"label":"ubuntu-latest, shard 1/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":1,"shard-count":13,"label":"ubuntu-latest, shard 2/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":2,"shard-count":13,"label":"ubuntu-latest, shard 3/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":3,"shard-count":13,"label":"ubuntu-latest, shard 4/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":4,"shard-count":13,"label":"ubuntu-latest, shard 5/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":5,"shard-count":13,"label":"ubuntu-latest, shard 6/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":6,"shard-count":13,"label":"ubuntu-latest, shard 7/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":7,"shard-count":13,"label":"ubuntu-latest, shard 8/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":8,"shard-count":13,"label":"ubuntu-latest, shard 9/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":9,"shard-count":13,"label":"ubuntu-latest, shard 10/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":10,"shard-count":13,"label":"ubuntu-latest, shard 11/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":11,"shard-count":13,"label":"ubuntu-latest, shard 12/13","workers":2,"single-worker-jobs":2},
            {"os":"ubuntu-latest","platform":"linux","shard-index":12,"shard-count":13,"label":"ubuntu-latest, shard 13/13","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":0,"shard-count":15,"label":"macos-latest, shard 1/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":1,"shard-count":15,"label":"macos-latest, shard 2/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":2,"shard-count":15,"label":"macos-latest, shard 3/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":3,"shard-count":15,"label":"macos-latest, shard 4/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":4,"shard-count":15,"label":"macos-latest, shard 5/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":5,"shard-count":15,"label":"macos-latest, shard 6/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":6,"shard-count":15,"label":"macos-latest, shard 7/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":7,"shard-count":15,"label":"macos-latest, shard 8/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":8,"shard-count":15,"label":"macos-latest, shard 9/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":9,"shard-count":15,"label":"macos-latest, shard 10/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":10,"shard-count":15,"label":"macos-latest, shard 11/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":11,"shard-count":15,"label":"macos-latest, shard 12/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":12,"shard-count":15,"label":"macos-latest, shard 13/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":13,"shard-count":15,"label":"macos-latest, shard 14/15","workers":2,"single-worker-jobs":2},
            {"os":"macos-latest","platform":"darwin","shard-index":14,"shard-count":15,"label":"macos-latest, shard 15/15","workers":2,"single-worker-jobs":2},
            {"os":"windows-latest","platform":"win32","shard-index":0,"shard-count":34,"label":"windows-latest, shard 1/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":1,"shard-count":34,"label":"windows-latest, shard 2/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":2,"shard-count":34,"label":"windows-latest, shard 3/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":3,"shard-count":34,"label":"windows-latest, shard 4/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":4,"shard-count":34,"label":"windows-latest, shard 5/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":5,"shard-count":34,"label":"windows-latest, shard 6/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":6,"shard-count":34,"label":"windows-latest, shard 7/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":7,"shard-count":34,"label":"windows-latest, shard 8/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":8,"shard-count":34,"label":"windows-latest, shard 9/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":9,"shard-count":34,"label":"windows-latest, shard 10/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":10,"shard-count":34,"label":"windows-latest, shard 11/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":11,"shard-count":34,"label":"windows-latest, shard 12/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":12,"shard-count":34,"label":"windows-latest, shard 13/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":13,"shard-count":34,"label":"windows-latest, shard 14/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":14,"shard-count":34,"label":"windows-latest, shard 15/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":15,"shard-count":34,"label":"windows-latest, shard 16/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":16,"shard-count":34,"label":"windows-latest, shard 17/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":17,"shard-count":34,"label":"windows-latest, shard 18/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":18,"shard-count":34,"label":"windows-latest, shard 19/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":19,"shard-count":34,"label":"windows-latest, shard 20/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":20,"shard-count":34,"label":"windows-latest, shard 21/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":21,"shard-count":34,"label":"windows-latest, shard 22/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":22,"shard-count":34,"label":"windows-latest, shard 23/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":23,"shard-count":34,"label":"windows-latest, shard 24/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":24,"shard-count":34,"label":"windows-latest, shard 25/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":25,"shard-count":34,"label":"windows-latest, shard 26/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":26,"shard-count":34,"label":"windows-latest, shard 27/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":27,"shard-count":34,"label":"windows-latest, shard 28/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":28,"shard-count":34,"label":"windows-latest, shard 29/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":29,"shard-count":34,"label":"windows-latest, shard 30/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":30,"shard-count":34,"label":"windows-latest, shard 31/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":31,"shard-count":34,"label":"windows-latest, shard 32/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":32,"shard-count":34,"label":"windows-latest, shard 33/34","workers":2,"single-worker-jobs":16},
            {"os":"windows-latest","platform":"win32","shard-index":33,"shard-count":34,"label":"windows-latest, shard 34/34","workers":2,"single-worker-jobs":16},
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
