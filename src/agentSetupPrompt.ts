export function buildPlaywrightSetupTask(providerId = 'copilot'): string {
  return `Set up this repository for AI-assisted Playwright end-to-end testing.

Inspect the repository first and make only the setup changes required:

1. Inspect the language and frameworks (including Python, JavaScript, TypeScript and mixed repositories).
   For Python use pytest-playwright in the project's virtual environment; preserve pytest fixtures and configuration.
   Record the actual argv command (for example [".venv/bin/python","-m","pytest"]) and testDir in
   .ai-e2e.json under playwright.testCommand and playwright.testDir, preserving other settings.
   For JavaScript/TypeScript, if Playwright is not configured, choose the repository-appropriate package manager and install
   the required Playwright test package, then create a working playwright.config file and test
   directory. Preserve the project's existing conventions.
2. Make sure \`npx playwright test\` can run locally: install the browsers needed by the config
   (\`npx playwright install\`), and configure \`webServer\` and any auth/setup project if the app needs them.
   Do not install Playwright agent definitions or Playwright MCP; the coding CLI writes and runs tests itself.
3. Use the main ${providerId} coding CLI only; do not install plugins, agents or MCP.
4. Run an actual browser smoke test against the local application, not merely --list or --collect-only.
   Add a minimal smoke test if none exists, and fix setup until it passes. Never use skipped tests as proof.
   For Python install browsers with the environment's python -m playwright install and run python -m pytest.
   Ask for approval before dependencies or server startup. Report missing credentials or environment as blockers.
   Never claim success unless at least one real test passed. Exit the coding CLI after reporting the exact command and result.

You may install or update development dependencies required for this setup. Do not modify
application behaviour, production dependencies, or unrelated files. Report every file and
dependency change when finished.`;
}
