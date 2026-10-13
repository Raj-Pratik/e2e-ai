export function buildPlaywrightSetupTask(providerId = 'copilot'): string {
  return `Set up this repository for AI-assisted Playwright end-to-end testing.

Inspect the repository first and make only the setup changes required:

1. If Playwright is not configured, choose the repository-appropriate package manager and install
   the required Playwright test package, then create a working playwright.config file and test
   directory. Preserve the project's existing conventions.
2. Make sure \`npx playwright test\` can run locally: install the browsers needed by the config
   (\`npx playwright install\`), and configure \`webServer\` and any auth/setup project if the app needs them.
   Do not install Playwright agent definitions or Playwright MCP; the coding CLI writes and runs tests itself.
3. ${providerId === 'copilot' ? 'If the Copilot skills plugin is not already installed, run:' : 'If the repository has coding-agent skills configured, load them; do not install a Copilot plugin when Copilot is not the selected provider.'}
${providerId === 'copilot' ? `   copilot plugin marketplace add mattpocock/skills
   copilot plugin install mattpocock-skills@mattpocock` : ''}
   Use the available skills when deciding how to plan, generate, diagnose, and repair E2E tests.
4. Verify the resulting Playwright configuration by listing tests (\`npx playwright test --list\`). Do not generate feature tests
   during this setup task.

You may install or update development dependencies required for this setup. Do not modify
application behaviour, production dependencies, or unrelated files. Report every file and
dependency change when finished.`;
}
