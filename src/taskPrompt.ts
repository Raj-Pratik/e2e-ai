import fs from 'node:fs';
import path from 'node:path';
import type { ChangeSet } from './changes.js';
import type { Config } from './config.js';
import { rankRelated, type PlaywrightSetup } from './playwright.js';
import type { McpServerSpec } from './providers/index.js';
import { redactSecrets } from './redact.js';

export interface TaskInput {
  repoRoot: string;
  jobDir: string;
  changeSet: ChangeSet;
  setup: PlaywrightSetup;
  config: Config;
  mcp: McpServerSpec | null;
  mcpNote: string | null;
  /** Exact shell command that runs only the new/edited specs and records a passing result. */
  verifyCommand: string;
}

const MAX_SUPPORT_LISTED = 150;
const MAX_INCLUDED_FILE_BYTES = 30_000;
/** Signal written by the agent for not-needed/blocked outcomes; a passing `verify` run is the success signal. */
export const DONE_FILE = 'done.json';

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

  const jobRel = path.relative(repoRoot, input.jobDir).split(path.sep).join('/');
  budget.add(`# Task: plan, generate and verify Playwright E2E tests for outgoing changes

You are generating end-to-end tests for code that a developer is pushing. Work only inside this repository.

## Workflow (you do every step yourself in this session)
Do NOT delegate to sub-agents. Do NOT use \`playwright-test-planner\`, \`playwright-test-generator\`,
\`playwright-test-healer\` or Playwright MCP. You have the repository, the shell and this task file; that is enough.

1. **Analyze.** Read the outgoing commits and diffs below. Decide whether the change affects user-visible product
   behaviour. Do not assume configuration or dependency changes are harmless: evaluate their product impact.
   If no browser coverage is needed, write the completion file with \`"not-needed"\` and a concrete reason.
2. **Plan.** Read the changed source, related components and existing E2E tests/helpers. Write the test plan to
   \`${jobRel}/plan.md\` as a readable spec: files to create OR patch, each scenario with its user steps and assertions,
   fixtures/auth/data used, and the command you will run. Keep exploration short: read only what the plan needs.
   Ask questions only when the answer changes the plan (critical path, expected assertion, test data/role,
   environment). Use short multiple-choice questions with an "Other" option. Never ask "why" questions.
3. **Approval gate (never skip).** First print the complete plan as your own message in this terminal, written out
   in full (scenarios, steps, assertions, files). Do not just say it was saved to \`plan.md\`, and do not ask for
   approval in the same message as a tool call: the user must be able to read the whole plan before answering.
   Then ask the user to approve or revise it. Do not write any spec or helper until the user explicitly approves.
   If they ask for changes, update \`plan.md\`, print the revised plan in full, and ask again.
4. **Generate.** Write the approved tests yourself, following the plan exactly.
5. **Verify loop (only the new/edited specs).** Run exactly this command, and nothing broader:
   \`${input.verifyCommand}\`
   It finds the spec files you added or edited (plus any existing spec that imports a helper you added or edited),
   runs only those with the repository's Playwright command, and prints the full Playwright output.
   A run can take several minutes: give the shell call the longest timeout your tool allows (or run it in the
   background and wait for it to exit). A run that is cut off records nothing; just run it again.
   Do NOT run the whole suite or unrelated specs; that wastes a lot of time. The Playwright config starts the web
   server if configured; otherwise ask permission to start the required local server and clean it up afterwards.
   If verify reports FAILED: read the failure output, error context, traces and reports; fix the generated
   tests/helpers; run the same verify command again. Repeat this loop for as long as it takes — there is no time
   limit — until verify reports PASSED, the user cancels, or a genuine actionable blocker remains.
   Ask for missing inputs; never invent credentials, never skip, \`.only\` or weaken tests to make them pass.
6. **Finish.** A PASSED verify run is the completion signal. PushPilot closes this session automatically, then
   commits the verified test files and pushes them. Do not edit test files after the passing run.

## Rules
- Add or patch Playwright tests and source helpers only under \`${out}/\`.
  ${config.generation.allowModifyExistingTests ? 'Prefer patching existing coverage over duplication.' : 'Compatibility setting allowModifyExistingTests=false: propose existing-file patches instead of editing them.'}
  Use the \`${setup.testSuffix}\` naming convention.
- Do NOT modify application source, configuration, package manifests, lockfiles or CI files; do not rename or delete files.
  The only non-test files you may create are \`plan.md\` and the completion file in the job directory.
- Do NOT run git commands that change state (commit, push, add, reset, checkout, stash); PushPilot commits and pushes
  for you. Do NOT install packages.
- Do NOT read or reference secrets, credentials, \`.env\` files, auth storage-state files or private keys.
- Do NOT contact production systems or perform destructive actions. Ask permission for local server startup if needed.
- Test user-visible behaviour introduced or changed by the diff below. Prefer accessible locators
  (\`getByRole\`, \`getByLabel\`, \`getByText\`, \`getByTestId\`) over CSS/XPath; never use fixed sleeps (\`waitForTimeout\`) —
  rely on web-first assertions and auto-waiting. Cover loading, error and important edge cases where relevant.
- Reuse existing fixtures, page objects, auth setup and helpers listed below; do not duplicate existing coverage.
- Keep tests deterministic and independent. Unavailable data or environments are blockers, never reasons to skip tests.
- Split independent scenarios into separate test files where practical, and put reusable setup/actions/assertions in
  existing common helpers or a new shared helper under the E2E test directory.

## Completion signal (mandatory)
Never stop after writing tests. Keep the verify loop going until it reports PASSED. Ask the user in this terminal only
when you genuinely need their input (for example authentication or environment details), then continue the loop.
Do not write \`"passed"\` yourself and do not ask the user to exit or type /exit: the passing verify run ends the session.
If the change clearly needs no E2E test (non-product change), write \`${jobRel}/${DONE_FILE}\` with
\`{"status":"not-needed","reason":"<why>"}\`.
If a blocker cannot be resolved even with the user's help, write \`{"status":"blocked","reason":"<concrete reason>"}\` there.

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
    budget.add('## Related existing tests (read before deciding whether to patch or add coverage)');
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
