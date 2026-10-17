# Rules for agents working in this repo

## Versioning: every change ships a new minor version

Every commit pushed to `main` (a fix, a feature, a docs change) is a release.

1. Before committing, bump the minor version (and reset patch to 0):

   ```sh
   npm version minor --no-git-tag-version   # 1.2.0 -> 1.3.0
   ```

   This updates `package.json` and `package-lock.json` together. Commit both with your change.
2. Do **not** create or push git tags yourself. The release workflow creates the tag `v<version>`.
3. Do **not** edit `Formula/` or `bucket/`. The workflow writes them from the files in `packaging/*.in`.
4. Rebuild before committing (`npm run build`). `dist/src` is tracked and gets shipped as-is.
5. Run `npm test` and `npm run release:check`. Both must pass before you push.

## How a push becomes a release

Pushing to `main` runs `.github/workflows/release.yml`, which:

1. Checks the version. If `v<version>` already exists (someone forgot the bump), it bumps
   the minor version itself and commits `chore(release): vX.Y.0`.
2. Builds and tests on macOS (arm64/x64), Linux (arm64/x64) and Windows x64, and bundles
   Node into each archive.
3. Creates the tag and a GitHub Release. The release notes list the commit subjects since
   the previous tag.
4. Updates `Formula/pushpilot.rb` (Homebrew) and `bucket/pushpilot.json` (Scoop) with the
   new URLs and checksums, then commits them to `main`.

## Commit messages become release notes

Write each commit subject as one short line a user can understand, for example
`Fix hook hanging when no terminal is attached`, not `wip` or `fix stuff`.
Do not use `chore(release):` in your own commits. The release notes leave those lines out.

## Docs

- The `README.md` is for users: what each feature does and how to use it. Keep it short
  and plain. Put internals in `docs/architecture.md`.
- When you add or change a command or setting, update the README in the same commit.
