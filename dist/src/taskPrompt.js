import fs from 'node:fs';
import path from 'node:path';
import { rankRelated } from './playwright.js';
import { redactSecrets } from './redact.js';
const MAX_SUPPORT_LISTED = 150;
const MAX_INCLUDED_FILE_BYTES = 30_000;
/** Completion signal written by the agent; ai-e2e closes the coding CLI session when it appears. */
export const DONE_FILE = 'done.json';
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
    const jobRel = path.relative(repoRoot, input.jobDir).split(path.sep).join('/');
    budget.add(`# Task: plan, generate and run Playwright E2E tests for outgoing changes

You are generating end-to-end tests for code that a developer is pushing. Work only inside this repository.

## Workflow (you do every step yourself in this session)
Do NOT delegate to sub-agents. Do NOT use \`playwright-test-planner\`, \`playwright-test-generator\`,
\`playwright-test-healer\` or Playwright MCP. You have the repository, the shell and this task file; that is enough.

1. **Analyze.** Read the outgoing commits and diffs below. Decide whether the change affects user-visible product
   behaviour. Documentation, Docker/Kubernetes, CI/CD, package metadata, unit-test-only, generated output and
   config-only changes need no E2E test: write the completion file with \`"not-needed"\` (see below) and stop.
2. **Plan.** Read the changed source, related components and existing E2E tests/helpers. Write the test plan to
   \`${jobRel}/plan.md\` as a readable spec: files to create, each scenario with its user steps and assertions,
   fixtures/auth/data used, and the command you will run. Show the same plan in this terminal.
   Ask questions only when the answer changes the plan (critical path, expected assertion, test data/role,
   environment). Use short multiple-choice questions with an "Other" option. Never ask "why" questions.
3. **Approval gate (never skip).** Ask the user to approve or revise the plan. Do not write any spec or helper until
   the user explicitly approves. If they ask for changes, update \`plan.md\` and ask again.
4. **Generate.** Write the approved tests yourself, following the plan exactly.
5. **Run and fix loop.** Run only the new specs with the repository's Playwright command (for example
   \`npx playwright test <spec paths>\` or the matching package script). The Playwright config starts the web
   server and runs auth/setup projects automatically. Read the failure output, error context, traces and reports;
   fix the generated specs/helpers; rerun. Repeat until every new spec passes. Ask the user only when you genuinely
   need input (credentials, environment, a product question). Never stop while tests are failing.
6. **Finish.** When the new specs pass, write the completion file. ai-e2e then closes this session, re-runs the
   specs, commits them and pushes.

## Rules
- Create NEW Playwright test files only, under \`${out}/\`. Use the \`${setup.testSuffix}\` suffix and follow existing naming and folder conventions.
- Do NOT modify, rename or delete existing files: application source, existing tests, fixtures, configuration, package manifests, lockfiles, CI files.
  If an existing test or helper must change, describe the proposed patch in your final answer instead of editing it.
  The only non-test files you may create are \`plan.md\` and the completion file in the job directory.
- Do NOT run git commands that change state (commit, push, add, reset, checkout, stash). Do NOT install packages.
- Do NOT read or reference secrets, credentials, \`.env\` files, auth storage-state files or private keys.
- Do NOT contact production systems or perform destructive actions. Let the Playwright config start any local server.
- Test user-visible behaviour introduced or changed by the diff below. Prefer accessible locators
  (\`getByRole\`, \`getByLabel\`, \`getByText\`, \`getByTestId\`) over CSS/XPath; never use fixed sleeps (\`waitForTimeout\`) —
  rely on web-first assertions and auto-waiting. Cover loading, error and important edge cases where relevant.
- Reuse existing fixtures, page objects, auth setup and helpers listed below; do not duplicate existing coverage.
- Keep tests deterministic and independent. Mark tests that need unavailable data or environments with \`test.skip\` and a reason.
- Split independent scenarios into separate test files where practical, and put reusable setup/actions/assertions in
  existing common helpers or a new shared helper under the E2E test directory.

## Completion signal (mandatory)
Never stop after writing tests. Keep the loop going — run the new specs, read the Playwright report, fix the generated
tests/helpers, rerun — until every new spec passes locally. Ask the user in this terminal only when you genuinely need
their input (for example authentication or environment details), then continue the loop.
When the new specs pass, write \`${jobRel}/${DONE_FILE}\` with
\`{"status":"passed","specs":["<spec paths>"],"command":"<command you ran>"}\`. ai-e2e then closes this session
automatically, re-verifies the specs, commits them and pushes. Do not ask the user to exit or type /exit.
If the change clearly needs no E2E test (non-product change), write \`{"status":"not-needed","reason":"<why>"}\`.
If a blocker cannot be resolved even with the user's help, write \`{"status":"blocked","reason":"<concrete reason>"}\`.
Never write \`"passed"\` before the tests actually pass.

## Final answer
Reply briefly with: the files you created, what each test covers, the exact Playwright command you ran and its
result, and any proposed patches to existing files.
`);
    budget.add(`## Repository Playwright setup
- Repository root: \`${repoRoot}\`
- Task specification: \`${path.join(repoRoot, path.relative(repoRoot, input.jobDir), 'task.md')}\`
- Playwright config: ${setup.configPath ? `\`${setup.configPath}\`` : 'none found'}
- Test directory: \`${setup.testDir}\` (${setup.testDirSource}); write new tests under \`${out}/\`
- Existing test files: ${setup.testFiles.length}
- Playwright-related package scripts: ${Object.keys(setup.scripts).length ? Object.entries(setup.scripts).map(([k, v]) => `\`${k}\` → \`${v}\``).join('; ') : 'none'}
`);
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
