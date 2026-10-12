export function buildPlaywrightSetupTask(providerId = 'copilot') {
    return `Set up this repository for AI-assisted Playwright end-to-end testing.

Inspect the repository first and make only the setup changes required:

1. If Playwright is not configured, choose the repository-appropriate package manager and install
   the required Playwright test package, then create a working playwright.config file and test
   directory. Preserve the project's existing conventions.
2. Install the Playwright agent definitions with:
   npx playwright init-agents --loop=vscode
3. Configure the planner, generator, and healer agents so they are available to the coding CLI.
   Set the model metadata for all three agents to a model that exists in the current CLI catalog:
   - Copilot: primary \`gpt-6-luna\`, fallback \`gpt-5.6-terra\`.
   - Claude: primary \`claude-haiku-5.5\`, fallback \`claude-sonnet-5.5\`.
   Remove obsolete model values such as \`claude-sonnet-4.6\`; never leave an unavailable model in an agent file.
4. ${providerId === 'copilot' ? 'If the Copilot skills plugin is not already installed, run:' : 'If the repository has coding-agent skills configured, load them; do not install a Copilot plugin when Copilot is not the selected provider.'}
${providerId === 'copilot' ? `   copilot plugin marketplace add mattpocock/skills
   copilot plugin install mattpocock-skills@mattpocock` : ''}
   Use the available skills when deciding how to plan, generate, and heal E2E tests.
5. Verify the resulting Playwright configuration and agent files. Do not generate feature tests
   during this setup task.

You may install or update development dependencies required for this setup. Do not modify
application behaviour, production dependencies, or unrelated files. Report every file and
dependency change when finished.`;
}
