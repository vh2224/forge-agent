# Local SVN evidence bundles

This contract preserves reproducible evidence from local, read-only SVN
observations. It is prospective: it does not recreate formal output bytes that
were not retained by an earlier audit.

## Safety boundary

Capture accepts an existing local working-copy directory and a new output
directory outside that target. It refuses a pre-existing output directory. The
closed profile contains only these commands, always with the local `.` target:

- `svn info --xml .`
- `svn status .` (never `-u`)
- `svn diff .`
- `svn proplist --xml --recursive .`
- `svn propget svn:ignore .`
- `svnversion .`

Commands are launched as executable/argv arrays with `shell: false` and byte
buffers. URLs, network options, arbitrary arguments, mutable subcommands,
restore and cleanup are outside the profile. Capture does not write in the
target. Verification launches no process.

## Capture and verification

Keep raw captures private and outside both the target and the repository:

```text
node scripts/forge-svn-evidence-bundle.js capture --cwd <local-wc> --output <private-new-directory>
node scripts/forge-svn-evidence-bundle.js verify --input <private-new-directory>
node scripts/forge-svn-evidence-bundle.js sanitize --input <private-new-directory> --output <safe-new-directory>
node scripts/forge-svn-evidence-bundle.js verify --input <safe-new-directory>
```

Review the sanitized copy before deciding whether it is suitable for version
control. Never commit a raw environment capture. Retain raw bundles only in an
operator-controlled evidence store with the applicable access and retention
policy; delete them through that store's approved process.

## Contract

Schema `forge-svn-local-evidence/v1` and profile `svn-local-readonly/v1` record:

- exact executable and argv for every invocation;
- exit code, signal and spawn error;
- stdout and stderr as separate byte files;
- byte length, SHA-256, and either `utf8` or `binary` encoding declaration;
- capture timestamp, platform, mode and exact raw cwd or sanitized token;
- a byte-sorted POSIX-relative inventory of every command artifact;
- a SHA-256 seal over canonical JSON excluding the seal field itself.

`verify` validates schema, profile, modes, cwd policy, the complete allowlist,
safe relative paths, exact sorted inventory, absence of extra/missing files,
stream lengths/hashes/encoding, command metadata, and the canonical seal. Any
filesystem, schema, allowlist or integrity error fails closed.

Sanitization creates a new directory and never overwrites the raw bundle. It
replaces cwd and protected identity in UTF-8 streams, recalculates affected
bytes and metadata, rebuilds the inventory and seal, and records the raw seal
as a non-reversible derivation pointer. Binary streams remain bytes, so an
operator must inspect them before publication.

## Controlled fixture

`scripts/fixtures/protected-wc-evidence-bundle/` was produced with an injected
runner in a temporary directory. It contains no real working-copy output,
network access, URL, credential, host, or corporate path. The ordinary verify
CLI accepts it; there is no test-only verification path.

The historical Phase 5 manifest remains explicitly incomplete because its raw
stdout/stderr was not retained. Its hashes and verdict remain useful facts, but
only future captures made with this mechanism are independently recomputable.
