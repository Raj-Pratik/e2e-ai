# Release and version policy

The initial PushPilot release is **1.0.0**. For each subsequent repository commit,
increment the minor version and reset patch to zero: 1.1.0, 1.2.0, etc. This is this
repository's requested policy, not conventional semantic-versioning compatibility
guidance. Update package.json and package-lock.json together. Do not bump for every
uncommitted edit or generated build file. Release tags are `v<package version>`.
Human review approval is required before committing or pushing.

```sh
npm version minor --no-git-tag-version
npm test
npm run release:check
```

Review tracked `dist/src` changes and version files in the same commit. The metadata
check rejects package/lock disagreement and tag/version mismatch. Enforcement of one
minor per future commit is a maintainer review responsibility.

## Artifacts

The release workflow has read-only permissions; it uploads CI artifacts but **does not
create a GitHub Release, tap, bucket, package submission, or other remote resource**.
It pins Node 22.20.0 and builds macOS arm64/x64, Linux arm64/x64, and Windows x64
runtime-bundled archives. Windows performs build/startup checks, not the POSIX-oriented
integration suite. Archive generation uses sorted entries and fixed metadata, and is
byte-reproducible given the exact same compiled sources and Node runtime/license.
Each archive has its own real SHA-256 sidecar. No fake release checksums are committed.

Local packaging:

```sh
mkdir -p release
# Download the official LICENSE matching `node --version` to release/NODE-LICENSE.
npm run build
NODE_LICENSE=release/NODE-LICENSE npm run release:bundle
```

The archive includes Node's license. It is unsigned and not notarized; macOS Gatekeeper
or Windows SmartScreen may warn. Verify checksums and retain the extracted layout.

## Publication checklist (human-owned)

1. Review changes and tests; perform real interactive Copilot/Claude sessions with JS
   and Python browsers. Check cancellation, plan/commit approval and ordinary/follow-up
   pushes, especially Windows native CLIs and Git Bash hooks.
2. Confirm supported hosted runner labels and run the release workflow. Download and
   extract each archive, run its launcher without a system Node, verify checksums,
   compare two same-input builds, and scan/sign artifacts as your policy requires.
3. Approve commit/tag/push. Publish reviewed artifacts and checksums in GitHub Releases.
4. In `packaging/pushpilot.rb.in`, substitute VERSION, BASE_URL and the four actual
   platform SHA-256 values. BASE_URL is the published release download directory.
   Publish `Formula/pushpilot.rb` in an approved Homebrew tap; run `brew audit --strict`
   and `brew install --build-from-source`/formula tests as appropriate. Announce the
   concrete `brew tap OWNER/TAP` and `brew install OWNER/TAP/pushpilot` commands only then.
5. Fill `packaging/pushpilot.scoop.json.in` with the actual Windows checksum/URL and
   publish it in an approved Scoop bucket. Test install, startup, update and uninstall.
6. `packaging/PushPilot.winget.yaml.in` is a **draft**, not a validated/published manifest.
   Reserve/confirm the package identifier and validate with current `winget validate`.
   In particular, verify multi-file ZIP portable installation preserves the bundled
   runtime and `.cmd` launcher; if unsupported, use an installer package instead of
   submitting this draft. Never claim WinGet availability before acceptance.

No tap/bucket/WinGet publication, remote release, Windows interactive validation, signing,
or notarization was performed by this implementation.
