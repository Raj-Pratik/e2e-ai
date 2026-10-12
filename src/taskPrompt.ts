import fs from 'node:fs';
import path from 'node:path';
import type { ChangeSet } from './changes.js';
import type { Config } from './config.js';
import { rankRelated, type PlaywrightSetup } from './playwright.js';
import type { McpServerSpec } from './providers/index.js';
import { redactSecrets } from './redact.js';

export interface TaskInput {
  repoRoot: string;
  changeSet: ChangeSet;
  setup: PlaywrightSetup;
  config: Config;
  mcp: McpServerSpec | null;
  mcpNote: string | null;
}

const MAX_SUPPORT_LISTED = 150;
const MAX_INCLUDED_FILE_BYTES = 30_000;

function readSafe(root: string, rel: string): string | null {
  try {
    const abs = path.resolve(root, rel);
    if (fs.statSync(abs).size > MAX_INCLUDED_FILE_BYTES) return null;
    return redactSecrets(fs.readFileSync(abs, 'utf8')).text;
  } catch {
    return null;
  }
}

function fence(content: string, lang = ''): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${content}\n${ticks}`;
}

class Budget {
  private parts: string[] = [];
  private used = 0;
  readonly omitted: string[] = [];

  constructor(private readonly max: number) {}

  /** Required sections are always kept. */
  add(text: string): void {
    this.parts.push(text);
    this.used += Buffer.byteLength(text);
  }

  tryAdd(label: string, text: string): boolean {
    const size = Buffer.byteLength(text);
    if (this.used + size > this.max) {
      this.omitted.push(label);
      return false;
    }
    this.add(text);
    return true;
  }

  toString(): string {
    return this.parts.join('\n');
  }
}

export function buildTask(input: TaskInput): string {
  const { changeSet, setup, config, repoRoot } = input;
  const budget = new Budget(config.context.maxPromptBytes);
  const out = setup.outputDir;
  const changedPaths = changeSet.files.map((f) => f.path);

  budget.add(`# Task: plan, generate, validate and heal Playwright E2E tests for outgoing changes

You are generating end-to-end tests for code that a developer is pushing. Work only inside this repository.

## Rules (mandatory)
- Constitutional gate: never create, edit, or generate a Playwright spec before
  \`playwright-test-planner\` has presented a plan in this terminal and the user has explicitly approved it.
  This rule applies even when the flow appears simple. Never infer approval from silence, a prior answer, or the
  initial request to generate tests.
  - Stay focused on browser coverage. Do not ask open-ended motivation or "why" questions.
  - First inspect the outgoing commits and classify the change. Documentation, Docker/Kubernetes, CI/CD, package
    metadata, generated output and test-only changes normally need no E2E test; state that briefly and continue without
    asking a question when the classification is unambiguous.
  - For a product flow, use the installed Copilot skills from \`mattpocock/skills\` when available and use these
    exact Playwright agent definitions created by \`npx playwright init-agents --loop=vscode\`:
    \`playwright-test-planner\`, \`playwright-test-generator\`, and \`playwright-test-healer\`.
  - Ask questions only when an answer changes the test plan. Use compact multiple-choice questions (A/B/C, with an
    "Other" option), covering only the critical user path, expected assertion, role/data fixture and environment.
    If the flow is clear from the diff, source and existing tests, ask no questions and proceed.
  - The planner step is mandatory for every product change, including simple flows. Invoke
    \`playwright-test-planner\` first and present its proposed files, scenarios, user actions, assertions, fixtures,
    and environment prerequisites in the terminal. Wait for an explicit user approval or requested revision.
    Do not invoke \`playwright-test-generator\`, create a spec, or modify any test helper before approval.
  - After approval, invoke \`playwright-test-generator\` to create the approved tests. Run them with the repository's
    Playwright command. After every failed run, invoke \`playwright-test-healer\`, apply only its generated-test/helper
    fixes, and rerun the tests. Repeat until the tests pass or a concrete environment blocker is reported.
  - If any of the three named agents is unavailable, stop and report the setup problem instead of silently writing
    tests without the required planner/generator/healer workflow.
  - Before finishing, explicitly report whether the user approved the plan, which generator agent ran, which Playwright
    command actually ran, and whether the healer was needed. Missing evidence means the workflow is incomplete.
  - Do not use Playwright MCP. Explore through the Playwright agents and repository source instead.
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
- Never claim that tests passed, were healed, or are complete based on intent or static inspection. The outer ai-e2e
  worker will run the exact generated specs after this session closes; if the app server or auth setup is required,
  rely on the repository Playwright configuration to start it and run its setup dependencies.

## Final answer
Reply with: (1) the list of files you created, (2) what each test covers, (3) the observed Playwright command and
result if you ran it, (4) any proposed patches to existing files, (5) concrete blockers only. Do not list unverified
assumptions as if they were completion criteria.
`);

  budget.add(`## Repository Playwright setup
- Playwright config: ${setup.configPath ? `\`${setup.configPath}\`` : 'none found'}
- Test directory: \`${setup.testDir}\` (${setup.testDirSource}); write new tests under \`${out}/\`
- Existing test files: ${setup.testFiles.length}
- Playwright-related package scripts: ${Object.keys(setup.scripts).length ? Object.entries(setup.scripts).map(([k, v]) => `\`${k}\` → \`${v}\``).join('; ') : 'none'}
`);

  budget.add(`## Playwright agents
Use \`playwright-test-planner\`, \`playwright-test-generator\`, and \`playwright-test-healer\`. They were installed by
\`npx playwright init-agents --loop=vscode\`. Do not use Playwright MCP and do not install MCP packages.
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

  if (changeSet.notes.length) budget.add(`## Analysis notes\n${changeSet.notes.map((n) => `- ${n}`).join('\n')}\n`);

  budget.add('## Diffs');
  for (const file of changeSet.files) {
    if (file.binary) continue;
    if (!file.diff) continue;
    budget.tryAdd(`diff of ${file.path}`, `### ${file.path}\n${fence(file.diff, 'diff')}\n`);
  }

  if (setup.configPath) {
    const content = readSafe(repoRoot, setup.configPath);
    if (content) budget.tryAdd('Playwright config', `## Playwright config (\`${setup.configPath}\`)\n${fence(content, 'ts')}\n`);
  }

  const related = rankRelated(setup.testFiles, changedPaths, config.context.maxRelatedTests);
  const examples = related.length ? related : setup.testFiles.slice(0, Math.min(1, config.context.maxRelatedTests));
  if (examples.length) {
    budget.add('## Related existing tests (style reference — do not edit)');
    for (const file of examples) {
      const content = readSafe(repoRoot, file);
      if (content) budget.tryAdd(`test ${file}`, `### ${file}\n${fence(content, 'ts')}\n`);
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
      if (content) budget.tryAdd(`helper ${file}`, `### ${file}\n${fence(content, 'ts')}\n`);
    }
  }

  if (budget.omitted.length) {
    budget.add(`## Omitted context\nThe following were omitted to respect size limits; read them from the repository if needed: ${budget.omitted.join(', ')}.\n`);
  }
  return budget.toString();
}
