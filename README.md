# PushPilot

PushPilot adds an optional, approved Playwright workflow to **normal `git push`**.
It uses your main GitHub Copilot CLI (default) or Claude Code session to inspect outgoing
commits, read existing coverage, propose a plan, and add **or patch** browser tests.
The coding CLI runs and repairs tests; PushPilot independently reruns them before asking
you to review and approve a test-only commit.

## Install

**Version 1.0.0 is prepared in this repository, not published.** There is no published
Homebrew tap, Scoop bucket, or WinGet package to install yet. Do not use invented hashes
or assume the commands below are available until the maintainer publishes them.

For local use now (requires Git and Node 20.10+):

```sh
git clone https://github.com/Raj-Pratik/e2e-ai.git
cd e2e-ai
npm ci
npm run build
node "$PWD/dist/src/cli.js" --help
# In your application repository, use the absolute path:
node /absolute/path/to/e2e-ai/dist/src/cli.js init
```

After release publication, download the matching macOS/Linux `.tar.gz` or Windows
`.zip` and its `.sha256` file from the repository's Releases page. Verify the SHA-256
before extracting. Archives include Node; no separate Node installation or global npm
installation is needed. Keep the whole extracted folder together.

```sh
# macOS (Linux: sha256sum -c instead)
shasum -a 256 -c pushpilot-1.0.0-darwin-arm64.tar.gz.sha256
tar -xzf pushpilot-1.0.0-darwin-arm64.tar.gz
./pushpilot-1.0.0-darwin-arm64/pushpilot --help
```

Windows PowerShell (x64; experimental console support):

```powershell
Get-FileHash .\pushpilot-1.0.0-win32-x64.zip -Algorithm SHA256
# Compare against the downloaded .sha256 file before extracting.
Expand-Archive .\pushpilot-1.0.0-win32-x64.zip -DestinationPath .\PushPilot
.\PushPilot\pushpilot-1.0.0-win32-x64\pushpilot.cmd --help
```

Add that extracted directory to PATH to use `pushpilot` anywhere. Homebrew installation
will use the following form **only after a tap is published**:

```sh
brew tap <published-owner>/<published-tap>
brew install <published-owner>/<published-tap>/pushpilot
```

Install and sign in to your selected coding CLI separately. Its subscription, permissions,
and model availability apply; PushPilot uses its default model unless you configure one.
Git for Windows is required for the shell pre-push hook. Windows console interaction is
implemented using `CONIN$`/`CONOUT$`, but has not been manually verified in this release.
Use native `.exe` coding CLIs; `.cmd`/`.bat` provider shims are not supported. Windows
release CI builds and checks CLI startup, not interactive provider sessions.

## First use

In the application repository:

```sh
pushpilot init
```

Choose Copilot (Enter defaults to Copilot) or Claude Code. Init preserves existing
configuration, installs the **pre-push** hook without replacing unrelated hook commands,
and opens the selected main coding CLI to inspect your language/framework and set up
Playwright. It installs the appropriate development dependencies/browsers with your
permission, configures a local server/fixtures, and runs an actual smoke test.
PushPilot reruns discovered tests: listing tests alone is not successful setup.
Review and commit setup changes yourself before generating outgoing coverage.

JavaScript/TypeScript uses Playwright Test. Python uses `pytest-playwright` and your
virtual environment, configured by the setup session. Mixed or unusual layouts need an
explicit test directory and command. Other language runners are not supported.
`init` installs configuration and the pre-push hook only. It never starts a coding CLI or
runs tests. Run `pushpilot playwright-init --yes` separately to set up Playwright.

## The push experience

1. Run `git push` normally. PushPilot asks whether to generate coverage.
2. **No / Enter / timeout:** generation is not run; normal Git and other hooks continue.
3. **Yes:** the main coding CLI evaluates coverage needs and reads existing tests.
   It shows a plan and waits for your explicit approval before editing coverage.
4. It adds or patches tests/helpers and runs relevant tests, inspecting failures and
   reports/traces until they pass, you cancel, or a genuine prerequisite blocks progress.
5. Its `done.json` signal closes the coding session. PushPilot independently reruns
   changed specs. Exit zero without a positive passed-test count is not enough.
6. You review and explicitly approve a test-only commit. PushPilot refuses dirty
   starting trees, unrelated edits, deleted files, or changes to HEAD/index.
7. The original push completes; a bounded follow-up normal push publishes the exact
   generated commit. Other pre-push policies still run. Publishing failures leave
   tests committed locally and report recovery instructions.

A coverage-not-needed decision includes a reason and must leave the repository unchanged.
Failures after accepting generation block the push and preserve files for review. Ctrl-C
cancels; the default generation deadline is 900 seconds with at most three worker repair
sessions. Inspect `pushpilot logs` for blockers. Do not accept a plan that hides failures
with skipped tests or requires production access.

## Commands and flags

| Command | Purpose / options |
| --- | --- |
| `init` | Configure provider and the pre-push hook only. Never starts a coding CLI or runs tests. `--no-hook` skips hook installation; `--force` allows insertion into a managed hook after backup (does not overwrite config). |
| `playwright-init` | Show setup guidance. `--yes` opens the main coding CLI to set up Playwright; PushPilot does not run tests afterwards. |
| `generate` | Generate coverage without initiating a push. `--base REV`, `--head REV` (default HEAD), `--provider copilot\|claude`, `--force` retry duplicate changes. `--foreground` is retained for compatibility; all generation is foreground. |
| `push` | Alias for normal `git push`; all arguments pass to Git and the installed hook handles coverage. |
| `status [JOB]` | Recent jobs or one job; `--json`, `--limit N` (default 10). |
| `logs [JOB]` | Latest or selected job log; `--tail N` (default 200). |
| `providers` | Provider availability; `--json`. |
| `config show` | Effective settings. |
| `config get KEY` | Read a dotted setting. |
| `config set KEY VALUE` | Set a JSON value or string. |
| `config validate` / `config path` | Validate settings / show config location. |
| `uninstall` | Remove only the PushPilot hook block; retain config, tests and job state. |
| `help [COMMAND]` / `COMMAND --help` | Command-specific help. |
| `--version`, `-v` | Show version. |

Switch providers or configure Python:

```sh
pushpilot config set provider claude
pushpilot config set playwright.testDir tests/e2e
pushpilot config set playwright.testCommand '[".venv/bin/python","-m","pytest"]'
pushpilot config set generation.commitGeneratedTests false
pushpilot config set generation.timeoutSeconds 1800
```

On Windows use `.venv/Scripts/python.exe` in the JSON array. Configure argv, not a shell
pipeline. Custom runners must print a normal Playwright/pytest summary (for example
`3 passed`) and fail on test failures. Do not use quiet/custom reporters that suppress
the summary. Setup and generation need browsers, a reachable local application, and
any approved environment prerequisites.

## Compatibility and privacy

The old `ai-e2e` executable remains an alias. `.ai-e2e.json`, `.ai-e2e/` job state,
existing hook markers and `AI-E2E-Job` trailers intentionally remain unchanged.
Existing `allowModifyExistingTests: false` is respected; set it to `true` to enable patches.
`playwright.runGeneratedTests` remains readable for old configs but verification is now
mandatory. Legacy MCP settings are accepted but no MCP or subagents are launched.

`AI_E2E_ASSUME=yes|no` controls only the initial hook question, not plan/commit approval.
The legacy `AI_E2E_SKIP=1` hook escape hatch remains compatible but is not used by the
normal or follow-up workflow. Prefer answering no when you do not want generation.
Do not use automated approval in untrusted repositories.

Outgoing diffs and related tests go to your selected AI provider after you accept.
Known sensitive paths are excluded and logs are redacted, but this is not a security
sandbox: the coding CLI has repository/shell access and its own permissions apply.
Review prompts, tests, and changes before approving. Runtime state contains task context
and should remain ignored by Git.

Maintainer details: [architecture and safety](docs/architecture.md),
[distribution and versioning](docs/releasing.md).
