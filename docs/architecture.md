# PushPilot implementation

`commands.ts` dispatches the CLI. Configuration remains `.ai-e2e.json`; `JobStore`
persists jobs in `.ai-e2e/` for compatibility. Provider adapters launch the main Copilot
or Claude CLI; no Playwright agent definitions, skills plugins, or MCP are installed.

## Push lifecycle

The shell pre-push block captures ref stdin beneath repository state, forwards it to
PushPilot, restores it for subsequent hook commands, and removes its capture. Existing
hook content and backups are preserved. The hook locates `pushpilot`/legacy `ai-e2e` or
uses the recorded CLI and Node runtime paths (including a bundled runtime).

The hook question precedes analysis. A yes creates a foreground job. No terminal, a
decline, or timeout continues the normal push. Accepted generation failures block it.
An active/failed duplicate cannot turn a failed accepted workflow into success.

The worker requires a dedicated test directory and a clean starting tree. It snapshots
existing files, builds outgoing context, and launches the main provider. The task asks
for explicit plan approval before edits. **This in-session plan gate is enforced by
the coding CLI's instructions, not an independently authenticated approval protocol.**
Do not treat an agent-authored plan or sentinel as proof of user approval.

The worker hashes the test directories into `baseline.json` before launching the provider.
The task tells the agent to loop on `pushpilot verify --job <id>`, which runs only files that
differ from the baseline (plus specs that transitively import a changed helper) and, on a pass,
writes `verified.json` with the hashes it ran against. The worker's `stopWhen` closes the session
when `verified.json` (or a not-needed/blocked `done.json`) appears; nothing else ends it, and there
is no default deadline. After the session PushPilot runs no tests: it requires the current changed
set to match `verified.json` exactly. `verify` requires exit zero and a positive passed count with
no skipped/failed/flaky/deselected count. Print-mode providers that stop early are resumed up to
five times. This cannot establish that AI-authored tests are honest; configured commands are
trusted repository code.

Before committing, changed paths must be test-directory source files, regular files,
and resolve inside the repository; deletions/unrelated files/changed HEAD or index block.
Only those paths are staged/committed, automatically, without a review prompt. Legacy
read-only-test mode restores modified existing files and saves proposals.

After committing, a separate publisher observes the original remote SHA and pushes the
**pinned generated SHA**, never a later HEAD. It uses normal Git hooks with no bypass.
A generated trailer alone cannot suppress the prompt: a matching successful local job
receipt and passing test run are also required. Receipts are local operational state,
not a cryptographic security boundary. It waits while the original `git push` process is alive
(then 2 more minutes). Remote updates, authentication failure, or the original push never
landing leave the local commit for manual publication. Success or failure sends a desktop
notification (`osascript`/`notify-send`; `AI_E2E_NO_NOTIFY=1` disables it).

## Runners and processes

JavaScript detection uses config/package metadata and local CLI paths. Python detection
uses pytest-playwright declarations; setup records the explicit environment command and
test directory. Regex extraction does not execute configuration just to inspect it.
Nonstandard layouts need explicit settings; the supported runner families are Playwright
Test and pytest-playwright, not arbitrary languages.

POSIX processes receive TERM then KILL; noninteractive groups are used for descendants.
Interactive POSIX sessions keep their controlling terminal and reset terminal state after
forced completion. Descendants started by an interactive provider can outlive its parent:
the provider must clean up local servers. Windows uses console devices and PID-scoped
`taskkill /T /F`. Native Windows interactive provider use remains unverified. `.cmd`/`.bat`
provider commands are rejected rather than passed through an unsafe shell.

## Validation

Tests use local Git repositories and fake coding providers/runners. They verify hook
control flow, snapshots, approval-required commits, and subprocess outcomes; they are
not live browser/provider end-to-end certification. Test workspaces stay under `.test-work`
and are removed after each test. Release CI runs the POSIX suite, builds on Windows, and
smoke-tests packaged CLI startup. Live provider/auth/browser workflows require manual
acceptance on each platform before claiming full support.
