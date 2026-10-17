# Releasing

Releases are automatic. Every push to `main` publishes a new version. The version rule and
the push steps are in [AGENTS.md](../AGENTS.md): bump the minor version on every commit and
let the workflow create the tag.

## What the workflow publishes

`.github/workflows/release.yml` builds archives with Node 22.20.0 bundled in, for macOS
arm64/x64, Linux arm64/x64 and Windows x64. Each archive gets a `.sha256` file. The
workflow then:

- creates the tag `v<version>` and a GitHub Release with notes taken from the commits
  since the previous tag
- renders `packaging/pushpilot.rb.in` into `Formula/pushpilot.rb` (this repo works as a
  Homebrew tap). The formula downloads `pushpilot-<version>.tar.gz`, a small archive without
  Node (built with `PUSHPILOT_NO_RUNTIME=1`), and depends on Homebrew's `node`
- renders `packaging/pushpilot.scoop.json.in` into `bucket/pushpilot.json` (this repo works
  as a Scoop bucket)

To render the manifests locally from downloaded archives:

```sh
npm run release:manifests -- <dir-with-.sha256-files> <out-dir>
```

## Known limits

- The archives are unsigned and not notarized. macOS Gatekeeper or Windows SmartScreen may warn.
- Windows CI checks that the build works and the CLI starts. It does not test interactive sessions.
- `packaging/PushPilot.winget.yaml.in` is still a draft. WinGet needs a manual
  submission to `microsoft/winget-pkgs`, so it isn't automated.
