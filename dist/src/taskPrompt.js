import fs from 'node:fs';
import path from 'node:path';
import { rankRelated } from './playwright.js';
import { redactSecrets } from './redact.js';
const MAX_SUPPORT_LISTED = 150;
const MAX_INCLUDED_FILE_BYTES = 30_000;
function readSafe(root, rel) {
    try {
        const abs = path.resolve(root, rel);
        if (fs.statSync(abs).size > MAX_INCLUDED_FILE_BYTES)
            return null;
        return redactSecrets(fs.readFileSync(abs, 'utf8')).text;
    }
    catch {
        return null;
    }
}
function fence(content, lang = '') {
    const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
    const ticks = '`'.repeat(longest + 1);
    return `${ticks}${lang}\n${content}\n${ticks}`;
}
class Budget {
    max;
    parts = [];
    used = 0;
    omitted = [];
    constructor(max) {
        this.max = max;
    }
    /** Required sections are always kept. */
    add(text) {
        this.parts.push(text);
        this.used += Buffer.byteLength(text);
    }
    tryAdd(label, text) {
        const size = Buffer.byteLength(text);
        if (this.used + size > this.max) {
            this.omitted.push(label);
            return false;
        }
        this.add(text);
        return true;
    }
    toString() {
        return this.parts.join('\n');
    }
}
export function buildTask(input) {
    const { changeSet, setup, config, repoRoot } = input;
    const budget = new Budget(config.context.maxPromptBytes);
    const out = setup.outputDir;
    const changedPaths = changeSet.files.map((f) => f.path);
    budget.add(`# Task: plan, generate, validate and heal Playwright E2E tests for outgoing changes

You are generating end-to-end tests for code that a developer is pushing. Work only inside this repository.

## Rules (mandatory)
- First act as a planner. Inspect the outgoing commits and classify the change as product behaviour, test-only,
  documentation, Docker/Kubernetes, CI/CD, package metadata, generated output, or another non-product change.
- If no meaningful product behaviour needs browser coverage, explain why E2E coverage is unnecessary and ask the user
  to confirm skipping. Do not create tests until the user confirms the decision.
- For product changes, explain the user-visible flow, risks, required scenarios, fixtures and shared helpers. Ask the
  user focused questions about the feature's motivation, expected behaviour, roles/data, edge cases and environment
  before finalising the plan. Do not invent answers.
- Present the plan and wait for explicit user approval. Revise it when the user gives feedback.
- When repository planner/generator/healer agent definitions exist (for example under \`.github/agents/\`), follow
  those definitions and use the planner before the generator and the healer after any failed Playwright run.
- Only after approval, use the Playwright MCP agent to explore the application and implement the plan.
- Create NEW Playwright test files only, under \`${out}/\`. Use the \`${setup.testSuffix}\` suffix and follow existing naming and folder conventions.
- Do NOT modify, rename or delete existing files: application source, existing tests, fixtures, configuration, package manifests, lockfiles, CI files.
  If an existing test or helper must change, describe the proposed patch in your final answer instead of editing it.
- Do NOT run git commands that change state (commit, push, add, reset, checkout, stash). Do NOT install packages.
- Do NOT read or reference secrets, credentials, \`.env\` files, auth storage-state files or private keys.
- Do NOT start servers, contact production systems, or perform destructive actions.
- Test user-visible behaviour introduced or changed by the diff below. Prefer accessible locators
  (\`getByRole\`, \`getByLabel\`, \`getByText\`, \`getByTestId\`) over CSS/XPath; never use fixed sleeps (\`waitForTimeout\`) —
  rely on web-first assertions and auto-waiting. Cover loading, error and important edge cases where relevant.
- Reuse existing fixtures, page objects, auth setup and helpers listed below; do not duplicate existing coverage.
- Keep tests deterministic and independent. Mark tests that need unavailable data or environments with \`test.skip\` and a reason.
- Split independent scenarios into separate test files where practical, and put reusable setup/actions/assertions in
  existing common helpers or a new shared helper under the E2E test directory.
- Run every newly generated test with the repository's Playwright command. Read the Playwright output, traces and
  reporter metrics. If a test fails, diagnose the failure and patch only the generated tests/helpers, then rerun it.
  Repeat the generate/run/heal cycle until the new tests pass or a concrete environment blocker is reported.

## Final answer
Reply with: (1) the list of files you created, (2) what each test covers, (3) any proposed patches to existing files,
(4) assumptions or gaps. Keep it concise.
`);
    budget.add(`## Repository Playwright setup
- Playwright config: ${setup.configPath ? `\`${setup.configPath}\`` : 'none found'}
- Test directory: \`${setup.testDir}\` (${setup.testDirSource}); write new tests under \`${out}/\`
- Existing test files: ${setup.testFiles.length}
- Playwright-related package scripts: ${Object.keys(setup.scripts).length ? Object.entries(setup.scripts).map(([k, v]) => `\`${k}\` → \`${v}\``).join('; ') : 'none'}
`);
    if (input.mcp) {
        const url = config.mcp.playwright.baseUrl;
        budget.add(`## Playwright MCP
A Playwright MCP server named \`${input.mcp.name}\` is available for exploring the UI.
${url ? `Only navigate to ${url} (and paths under it). ` : 'No base URL is authorised: do not navigate anywhere unless the app is already reachable locally. '}
Do not submit forms that create, modify or delete real data. If the app is unreachable, fall back to source analysis.
`);
    }
    else {
        budget.add(`## Playwright MCP
Not available${input.mcpNote ? ` (${input.mcpNote})` : ''}. Infer UI structure from source code and existing tests.
`);
    }
    const commitLines = changeSet.ranges.flatMap((r) => [
        `- \`${r.localRef}\` → \`${r.remoteRef}\` (${r.commitCount} commit(s)${r.forced ? ', force push' : ''})`,
        ...r.commits.map((c) => `  - ${c.sha.slice(0, 10)} ${c.subject}`),
    ]);
    budget.add(`## Outgoing commits
${commitLines.join('\n')}
`);
    const fileLines = changeSet.files.map((f) => `- [${f.status}] \`${f.path}\`${f.oldPath ? ` (from \`${f.oldPath}\`)` : ''}`);
    const excludedNote = changeSet.excluded.length
        ? `\n${changeSet.excluded.length} file(s) were excluded from context (sensitive, generated or over limits).`
        : '';
    budget.add(`## Changed files
${fileLines.join('\n')}${excludedNote}
`);
    if (changeSet.notes.length)
        budget.add(`## Analysis notes\n${changeSet.notes.map((n) => `- ${n}`).join('\n')}\n`);
    budget.add('## Diffs');
    for (const file of changeSet.files) {
        if (file.binary)
            continue;
        if (!file.diff)
            continue;
        budget.tryAdd(`diff of ${file.path}`, `### ${file.path}\n${fence(file.diff, 'diff')}\n`);
    }
    if (setup.configPath) {
        const content = readSafe(repoRoot, setup.configPath);
        if (content)
            budget.tryAdd('Playwright config', `## Playwright config (\`${setup.configPath}\`)\n${fence(content, 'ts')}\n`);
    }
    const related = rankRelated(setup.testFiles, changedPaths, config.context.maxRelatedTests);
    const examples = related.length ? related : setup.testFiles.slice(0, Math.min(1, config.context.maxRelatedTests));
    if (examples.length) {
        budget.add('## Related existing tests (style reference — do not edit)');
        for (const file of examples) {
            const content = readSafe(repoRoot, file);
            if (content)
                budget.tryAdd(`test ${file}`, `### ${file}\n${fence(content, 'ts')}\n`);
        }
    }
    if (setup.supportFiles.length) {
        const listed = setup.supportFiles.slice(0, MAX_SUPPORT_LISTED);
        budget.add(`## Existing fixtures, helpers and page objects (reuse these)
${listed.map((f) => `- \`${f}\``).join('\n')}${setup.supportFiles.length > listed.length ? `\n- … ${setup.supportFiles.length - listed.length} more` : ''}
`);
        const fixtureLike = setup.supportFiles.filter((f) => /fixture|auth|setup|page/i.test(path.basename(f)));
        for (const file of [...new Set([...rankRelated(setup.supportFiles, changedPaths, 2), ...fixtureLike.slice(0, 2)])]) {
            const content = readSafe(repoRoot, file);
            if (content)
                budget.tryAdd(`helper ${file}`, `### ${file}\n${fence(content, 'ts')}\n`);
        }
    }
    if (budget.omitted.length) {
        budget.add(`## Omitted context\nThe following were omitted to respect size limits; read them from the repository if needed: ${budget.omitted.join(', ')}.\n`);
    }
    return budget.toString();
}
