# PushPilot

**Get Playwright tests for your changes every time you `git push`.**

When you push, PushPilot asks: *"Generate tests for these changes?"*
If you say yes, your AI coding assistant (GitHub Copilot CLI or Claude Code) reads what
changed, shows you a test plan, writes the tests, and fixes them until they pass.
PushPilot then commits the tests and pushes them for you.

## Install

**macOS / Linux** (Homebrew)

```sh
brew tap raj-pratik/pushpilot https://github.com/Raj-Pratik/e2e-ai
brew trust raj-pratik/pushpilot
brew install pushpilot
```

`brew trust` is a one-time step. Homebrew asks for it for any tap that isn't one of its official ones.

**Windows** (Scoop)

```powershell
scoop bucket add pushpilot https://github.com/Raj-Pratik/e2e-ai
scoop install pushpilot
```

You don't need to install Node. It comes bundled.

To update, run `brew upgrade pushpilot` or `scoop update pushpilot`.

**Installed the old npm version before?** Remove it first, or it will keep running instead
of the new one:

```sh
npm uninstall -g pushpilot
```

If you use asdf or nvm, run that with the same Node version you installed it under, then
run `asdf reshim nodejs` (asdf only). Check with `which pushpilot`: it should not point
into a Node folder.

**You also need:**
- Git (on Windows, use Git for Windows)
- [GitHub Copilot CLI](https://github.com/features/copilot/cli) or [Claude Code](https://claude.com/claude-code), installed and signed in

## Quick start

In your app's repo:

```sh
pushpilot init                   # pick your AI assistant and add the git push hook
pushpilot playwright-init --yes  # one-time: let the AI set up Playwright in your repo
git push                         # answer "y" when asked to generate tests
```

## What happens when you push

1. **You choose.** PushPilot asks whether to generate tests. Press Enter (or wait) to skip, and the push goes through as usual.
2. **You approve a plan.** The AI looks at your changes and the tests you already have, then proposes which tests to add or update. Nothing changes until you approve.
3. **It writes and fixes tests.** The AI runs only the tests it touched and keeps fixing them until they pass. Skipped or flaky tests don't count as passing.
4. **It commits and pushes.** Your original push finishes, then PushPilot commits the passing tests and pushes them. You get a desktop notification when it's done.

If the AI decides your change doesn't need tests, it says why and changes nothing.
Press Ctrl-C at any point to cancel.

## Commands

| Command | What it does |
| --- | --- |
| `pushpilot init` | Set up PushPilot in this repo: choose your AI assistant and add the push hook. |
| `pushpilot playwright-init --yes` | Have the AI install and set up Playwright for your project. |
| `pushpilot generate` | Generate tests for your latest changes without pushing. |
| `pushpilot provider` | Switch between Copilot and Claude. |
| `pushpilot status` | List recent test-generation runs. |
| `pushpilot logs` | Show the log of the last run. Use this when something fails. |
| `pushpilot config show` | Show your current settings. |
| `pushpilot uninstall` | Remove the push hook. Your tests and settings stay. |
| `pushpilot help <command>` | Show help for one command. |

## Common settings

Settings live in `.ai-e2e.json` in your repo.

```sh
pushpilot config set playwright.testDir tests/e2e           # where your tests live
pushpilot config set generation.commitGeneratedTests false  # don't auto-commit tests
pushpilot config set generation.timeoutSeconds 3600         # stop after 1 hour (default: no limit)
```

**Python projects** (pytest-playwright): point PushPilot at your virtualenv.

```sh
pushpilot config set playwright.testCommand '[".venv/bin/python","-m","pytest"]'
# On Windows, use .venv/Scripts/python.exe
```

PushPilot supports JavaScript/TypeScript (Playwright Test) and Python (pytest-playwright).

## Privacy

Your code changes go to your chosen AI provider **only after you say yes**.
PushPilot leaves out known secret files and redacts its logs. The AI assistant runs with its
own permissions in your repo, so review the plan before you approve it.

## More

- [How it works inside](docs/architecture.md)
- [Releasing](docs/releasing.md)
- Report a problem: [GitHub Issues](https://github.com/Raj-Pratik/e2e-ai/issues)
