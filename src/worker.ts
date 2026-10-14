import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { analyzeOutgoing, type ChangeSet } from './changes.js';
import { loadConfig, stateDirPath, type Config } from './config.js';
import { AiE2eError, errorMessage } from './errors.js';
import { git, listFiles, statusSnapshot } from './git.js';
import { JobStore, type JobRecord, type TestRunResult } from './jobs.js';
import { createLogger, type Logger } from './log.js';
import { detectPlaywright, isWithin, isTestFile, testCommand, type PlaywrightSetup } from './playwright.js';
import { hasInteractiveTerminal, runProcess } from './proc.js';
import { resolveHookTarget } from './hookInstall.js';
import { askYesNo, openTerminal, type PromptIO } from './prompt.js';
import { assertSafeExtraArgs, detectProvider, getProvider, secretEnvNames } from './providers/index.js';
import { redact } from './redact.js';
import { parsePrePushInput } from './refs.js';
import { buildTask, DONE_FILE } from './taskPrompt.js';

export const REFS_FILE = 'refs.txt';
export const TASK_FILE = 'task.md';
/** Commit trailer marking ai-e2e generated test commits; pushes containing only these skip the prompt. */
export const GENERATED_TRAILER = 'AI-E2E-Job';

const SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_HEALING_ATTEMPTS = 3;

export interface WorkerOptions {
  repoRoot: string;
  jobId: string;
  signal?: AbortSignal;
  log?: Logger;
  openReviewTerminal?: () => PromptIO | null;
}

class SkipJob extends Error {}

interface Snapshot {
  files: Map<string, Buffer | null>;
}

function snapshotFiles(root: string, files: string[]): Snapshot {
  const map = new Map<string, Buffer | null>();
  for (const file of files) {
    try {
      const abs = path.join(root, file);
      map.set(file, fs.statSync(abs).size <= SNAPSHOT_MAX_FILE_BYTES ? fs.readFileSync(abs) : null);
    } catch {
      // vanished between listing and reading
    }
  }
  return { files: map };
}

// Files PushPilot's own setup writes (config, ignore rule, hook, Playwright config). They may be uncommitted without blocking generation.
async function setupOwnedFiles(root: string, setup: PlaywrightSetup): Promise<Set<string>> {
  const owned = ['.ai-e2e.json', '.gitignore'];
  if (setup.configPath) owned.push(path.relative(root, path.resolve(root, setup.configPath)));
  const hook = await resolveHookTarget(root).catch(() => null);
  if (hook) owned.push(path.relative(root, hook.file));
  return new Set(owned.map((file) => file.split(path.sep).join('/')));
}

function restoreSetupFiles(root: string, before: Snapshot): string[] {
  const warnings: string[] = [];
  for (const [file, original] of before.files) {
    if (original === null) continue;
    const abs = path.join(root, file);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    if (current && current.equals(original)) continue;
    fs.writeFileSync(abs, original);
    warnings.push(`The coding CLI changed PushPilot setup file ${file}; original restored.`);
  }
  return warnings;
}

function lineWriter(log: Logger, prefix: string): { write(chunk: string): void; flush(): void } {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) log(`${prefix}${redact(line)}`);
    },
    flush() {
      if (pending) log(`${prefix}${redact(pending)}`);
      pending = '';
    },
  };
}

async function restoreExistingTests(
  root: string,
  jobDir: string,
  before: Snapshot,
  allowModify: boolean,
  log: Logger,
): Promise<{ patches: string[]; warnings: string[] }> {
  const patches: string[] = [];
  const warnings: string[] = [];
  for (const [file, original] of before.files) {
    const abs = path.join(root, file);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    if (original === null || (current && current.equals(original))) continue;
    if (allowModify) {
      warnings.push(`Existing file was ${current ? 'modified' : 'deleted'} by the agent: ${file}`);
      continue;
    }
    const proposedDir = path.join(jobDir, 'proposed');
    const originalCopy = path.join(proposedDir, 'original', file);
    const proposedCopy = path.join(proposedDir, 'files', file);
    fs.mkdirSync(path.dirname(originalCopy), { recursive: true });
    fs.writeFileSync(originalCopy, original);
    if (current) {
      fs.mkdirSync(path.dirname(proposedCopy), { recursive: true });
      fs.writeFileSync(proposedCopy, current);
    }
    const diff = await runProcess('git', ['diff', '--no-index', '--no-color', '--', originalCopy, current ? proposedCopy : '/dev/null'], {
      cwd: root,
    });
    const patchFile = path.join(proposedDir, `${file.replace(/[\\/]/g, '__')}.patch`);
    fs.writeFileSync(patchFile, diff.stdout);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, original);
    patches.push(path.relative(root, patchFile));
    warnings.push(`Agent changed existing file ${file}; original restored, proposal saved to ${path.relative(root, patchFile)}`);
    log(`Restored ${file}; proposed change saved as a patch.`);
  }
  return { patches, warnings };
}

export async function runGeneratedTests(
  root: string,
  config: Config,
  setup: PlaywrightSetup,
  specs: string[],
  log: Logger,
  signal?: AbortSignal,
): Promise<TestRunResult | null> {
  const command = testCommand(root, config, setup, specs);
  if (!command) {
    throw new AiE2eError('No runnable Playwright command. Run `pushpilot playwright-init --yes` or configure playwright.testCommand.');
  }
  log(`Running generated tests: ${command.join(' ')}`);
  const out = lineWriter(log, '[playwright] ');
  const result = await runProcess(command[0]!, command.slice(1), {
    cwd: root,
    timeoutMs: config.playwright.testTimeoutSeconds * 1000,
    maxOutputBytes: config.generation.maxOutputBytes,
    killProcessGroup: true,
    onOutput: (chunk) => out.write(chunk),
    ...(signal ? { signal } : {}),
  });
  out.flush();
  if (result.error) log(`Test command could not start: ${result.error.message}`);
  // A sentinel or exit zero (including an all-skipped suite) is not evidence of execution.
  const output = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
  const passedCount = /\b([1-9]\d*) passed\b/.test(output);
  const skipped = /\b[1-9]\d* (?:skipped|failed|deselected)\b/.test(output);
  const passed = result.exitCode === 0 && !result.timedOut && !result.aborted && passedCount && !skipped;
  log(passed ? 'Generated tests passed.' : `Generated tests failed (exit ${result.exitCode ?? result.signal}${result.timedOut ? ', timed out' : ''}).`);
  const failureOutput = passed ? undefined : redact(`${output}\n${!passedCount ? 'No positive passed-test count found. Configure a text reporter (Playwright list/line or pytest terminal summary).' : ''}`.trim().slice(-12_000));
  return { command, exitCode: result.exitCode, passed, timedOut: result.timedOut, ...(failureOutput ? { failureOutput } : {}) };
}

function summarize(job: Pick<JobRecord, 'generatedFiles' | 'proposedPatches' | 'testRun'>, setup: PlaywrightSetup): string {
  if (!job.generatedFiles.length) return 'No new test files were generated.';
  const lines = [`Generated ${job.generatedFiles.length} file(s):`, ...job.generatedFiles.map((f) => `  - ${f}`)];
  const specs = job.generatedFiles.filter(isTestFile);
  if (specs.length) lines.push(`Run them with: ${job.testRun?.command.join(' ') ?? specs.join(' ')}`);
  if (job.proposedPatches.length) lines.push(`Proposed changes to existing files: ${job.proposedPatches.join(', ')}`);
  if (job.testRun) lines.push(`Test run: ${job.testRun.passed ? 'passed' : 'failed'}`);
  if (!setup.configPath) lines.push('Note: no Playwright config file was found.');
  return lines.join('\n');
}

/** Opens the user's terminal device by path so a detached process can still report back to it. */
function openUserTerminal(): number | null {
  if (process.platform === 'win32') return null;
  let ttyFd: number | undefined;
  try {
    ttyFd = fs.openSync('/dev/tty', 'r');
    const device = spawnSync('tty', [], { stdio: [ttyFd, 'pipe', 'ignore'], encoding: 'utf8' }).stdout?.trim();
    return device && device.startsWith('/dev/') ? fs.openSync(device, 'a') : null;
  } catch {
    return null;
  } finally {
    if (ttyFd !== undefined) fs.closeSync(ttyFd);
  }
}

function scheduleFollowUpPush(root: string, remote: string, refs: ReturnType<typeof parsePrePushInput>, logFile: string, commit: string): void {
  const ref = refs.find((candidate) => candidate.localRef.startsWith('refs/heads/') && candidate.remoteRef.startsWith('refs/heads/'));
  const cli = process.argv[1];
  if (!ref || !cli) throw new AiE2eError('Could not schedule the follow-up push: branch ref or CLI path is unavailable.');
  const output = openUserTerminal() ?? fs.openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [
      cli,
      'publish-after-push',
      '--remote',
      remote,
      '--branch',
      ref.remoteRef.slice('refs/heads/'.length),
      '--expected',
      ref.localSha,
      '--commit',
      commit,
    ],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', output, output],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  child.once('error', (error) => {
    fs.appendFileSync(logFile, `PushPilot: follow-up publisher could not start: ${error.message}. Review the local commit and run git push.\n`);
  });
  child.unref();
  fs.closeSync(output);
}

export async function runJob(options: WorkerOptions): Promise<JobRecord> {
  const { repoRoot: root, jobId } = options;
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const abort = (): void => controller.abort();
  const log = options.log ?? createLogger();
  const { config } = loadConfig(root);
  const store = new JobStore(stateDirPath(root, config));
  const initial = store.read(jobId);
  if (!initial) throw new AiE2eError(`Job ${jobId} not found.`);
  const jobDir = store.jobDir(jobId);

  let job = store.update(jobId, { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
  if (!options.signal) {
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
  }
  log(`Job ${jobId} started (pid ${process.pid}, provider ${job.provider}, repo ${root}).`);

  try {
    const deadline = Date.now() + config.generation.timeoutSeconds * 1000;
    const headBefore = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const interactive = config.generation.interactive && hasInteractiveTerminal();
    const setup = await detectPlaywright(root, config);
    if (!setup.found) {
      throw new AiE2eError(
        'No Playwright setup detected (no playwright.config.* and no @playwright/test dependency). ' +
          'Run `pushpilot playwright-init --yes` so the coding CLI can initialise Playwright, then re-run `pushpilot generate`.',
      );
    }
    log(`Playwright: config=${setup.configPath ?? 'none'}, testDir=${setup.testDir}, outputDir=${setup.outputDir}, ${setup.testFiles.length} existing test(s).`);

    const refs = parsePrePushInput(fs.readFileSync(path.join(jobDir, REFS_FILE), 'utf8'));
    if (config.generation.commitGeneratedTests && job.source === 'pre-push' &&
        (refs.length !== 1 || refs[0]?.localSha !== headBefore ||
         !refs[0].localRef.startsWith('refs/heads/') || !refs[0].remoteRef.startsWith('refs/heads/'))) {
      throw new AiE2eError('Automatic test commits require a single current-HEAD branch push. Push branches separately or disable generation.commitGeneratedTests.');
    }
    const changeSet: ChangeSet = await analyzeOutgoing(root, job.remote, refs, config.context, { withDiffs: true });
    for (const note of changeSet.notes) log(`Note: ${note}`);
    for (const ex of changeSet.excluded) log(`Excluded ${ex.path} (${ex.reason}).`);
    if (!changeSet.files.length) throw new SkipJob('No analyzable changes (all changed files were excluded or nothing is outgoing).');
    log(`Analyzing ${changeSet.commitCount} commit(s), ${changeSet.files.length} file(s), ${changeSet.totalDiffBytes} diff bytes.`);

    const provider = getProvider(job.provider);
    const settings = config.providers[provider.id] ?? config.providers.copilot!;
    assertSafeExtraArgs(provider, settings);
    const availability = await detectProvider(provider, settings, root);
    if (!availability.available) throw new AiE2eError(`${provider.displayName} is unavailable: ${availability.reason}`);
    log(`Provider ${provider.displayName}: ${availability.resolvedPath} (${availability.version ?? 'unknown version'}).`);

    log('The coding CLI plans, writes and runs the tests itself (no Playwright sub-agents or MCP).');

    const taskFile = path.join(jobDir, TASK_FILE);
    fs.writeFileSync(
      taskFile,
      buildTask({ repoRoot: root, jobDir, changeSet, setup, config, mcp: null, mcpNote: 'not used' }),
    );
    const taskRel = path.relative(root, taskFile).split(path.sep).join('/');
    const instruction = `Read the task specification in \`${taskRel}\` and complete it exactly. Follow every rule in that file.`;

    const scanDirs = [...new Set([setup.testDir, setup.outputDir])];
    if (scanDirs.some((dir) => dir === '.' || dir.startsWith('..') || path.isAbsolute(dir))) {
      throw new AiE2eError('Configure a dedicated repository-relative playwright.testDir; the repository root is not a safe test allowlist.');
    }
    const listedBefore = await listFiles(root, scanDirs);
    const before = snapshotFiles(root, listedBefore);
    const statusBefore = await statusSnapshot(root);
    const stateRelative = path.relative(root, store.stateDir).split(path.sep).join('/');
    const owned = await setupOwnedFiles(root, setup);
    const isIgnoredDirty = (file: string): boolean => file.startsWith(`${stateRelative}/`) || owned.has(file);
    const relevantDirty = [...statusBefore.keys()].filter((file) => !isIgnoredDirty(file));
    if (relevantDirty.length) throw new AiE2eError(`Working tree must be clean before generation; preserve and review these changes first: ${relevantDirty.join(', ')}`);
    const setupBefore = snapshotFiles(root, [...owned]);
    const indexBefore = [...statusBefore].filter(([, code]) => code[0] !== ' ' && code[0] !== '?').map(([p, c]) => `${c}${p}`).sort().join('\n');

    const providerOut = lineWriter(log, `[${provider.id}] `);
    const doneFile = path.join(jobDir, DONE_FILE);
    const readDone = (): { status?: string; reason?: string } | null => {
      try {
        const done = JSON.parse(fs.readFileSync(doneFile, 'utf8')) as { status?: string; reason?: string };
        return done && ['passed', 'not-needed', 'blocked'].includes(done.status ?? '') &&
          (done.status === 'passed' || (typeof done.reason === 'string' && done.reason.trim().length > 0)) ? done : null;
      } catch {
        return null;
      }
    };
    const runProvider = async (model: string | null, prompt: string) => {
      if (signal?.aborted) throw new AiE2eError('Generation interrupted.');
      if (Date.now() >= deadline) throw new AiE2eError('Generation deadline reached; inspect the job log and resolve the blocker before retrying.');
      fs.rmSync(doneFile, { force: true });
      const invocation = provider.buildInvocation({
        repoRoot: root,
        instruction: prompt,
        settings: { ...settings, model },
        mcp: null,
        secretEnvNames: secretEnvNames(process.env),
        interactive,
      });
      log(`Invoking ${invocation.command}${model ? ` with model ${model}` : ''} (timeout ${config.generation.timeoutSeconds}s).`);
      return runProcess(availability.resolvedPath ?? invocation.command, invocation.args, {
        cwd: root,
        timeoutMs: deadline - Date.now(),
        maxOutputBytes: config.generation.maxOutputBytes,
        killProcessGroup: !interactive,
        onOutput: (chunk) => providerOut.write(chunk),
        interactive,
        // The agent writes done.json when its tests pass (or it is blocked); then the session is closed for it.
        stopWhen: () => readDone() !== null,
        ...(signal ? { signal } : {}),
      });
    };
    const finishPhase = async (attempt: Awaited<ReturnType<typeof runProvider>>): Promise<void> => {
      providerOut.flush();
      if (attempt.aborted || attempt.timedOut || attempt.error) return;
      if (attempt.completed) log('Agent reported completion; the coding CLI session was closed automatically.');
      const done = readDone();
      if (done?.status === 'not-needed') {
        const dirty = [...(await statusSnapshot(root)).keys()].filter((file) => !isIgnoredDirty(file));
        if (dirty.length || (await git(root, ['rev-parse', 'HEAD'])).trim() !== headBefore) {
          throw new AiE2eError('Agent reported not-needed but changed the repository. Review changes; push blocked.');
        }
        throw new SkipJob(`agent decided no E2E test is needed: ${redact(done.reason ?? 'non-product change')}`);
      }
      if (done?.status === 'blocked') {
        throw new AiE2eError(`The agent reported a blocker: ${redact(done.reason ?? 'no reason given')}`);
      }
    };
    const runWithFallbacks = async (prompt: string) => {
      let attempt = await runProvider(settings.model, prompt);
      for (const fallbackModel of settings.fallbackModels) {
        if (attempt.completed || attempt.exitCode === 0 || attempt.error || attempt.aborted || attempt.timedOut) break;
        log(`Provider exited unsuccessfully; retrying with fallback model ${fallbackModel}.`);
        attempt = await runProvider(fallbackModel, prompt);
      }
      return attempt;
    };
    let result = await runWithFallbacks(instruction);
    await finishPhase(result);

    const restored = await restoreExistingTests(root, jobDir, before, config.generation.allowModifyExistingTests, log);
    const listedAfter = await listFiles(root, scanDirs);
    const known = new Set(listedBefore);
    const changedTests = (files: string[]): string[] => files.filter((file) => {
      const abs = path.join(root, file);
      if (!fs.existsSync(abs)) return false;
      if (!known.has(file)) return true;
      const original = before.files.get(file);
      return original !== null && original !== undefined && !fs.readFileSync(abs).equals(original);
    }).sort();
    let generatedFiles = changedTests(listedAfter);

    const warnings = [...restored.warnings];
    const statusAfter = await statusSnapshot(root);
    const outside = [...statusAfter.keys()].filter(
      (p) => statusAfter.get(p) !== statusBefore.get(p) && !scanDirs.some((d) => isWithin(d, p)) && !p.startsWith(`${path.relative(root, store.stateDir)}/`),
    );
    if (outside.length) warnings.push(`Files outside the test directories changed during generation (review manually): ${outside.join(', ')}`);
    const indexAfter = [...statusAfter].filter(([, code]) => code[0] !== ' ' && code[0] !== '?').map(([p, c]) => `${c}${p}`).sort().join('\n');
    if (indexAfter !== indexBefore) warnings.push('The Git index changed during generation; review `git status` before committing.');
    for (const warning of warnings) log(`WARNING: ${warning}`);

    job = store.update(jobId, { generatedFiles, proposedPatches: restored.patches, warnings });

    if (result.error || result.aborted || result.timedOut || (!result.completed && result.exitCode !== 0)) {
      const reason = result.aborted
        ? 'interrupted'
        : result.timedOut
          ? `timed out after ${config.generation.timeoutSeconds}s`
          : result.error
            ? result.error.message
            : `exit code ${result.exitCode ?? result.signal}`;
      throw new AiE2eError(`${provider.displayName} failed: ${reason}. ${redact(result.stderr.trim().split('\n').slice(-5).join(' | '))}`.trim());
    }

    const planFile = path.join(jobDir, 'plan.md');
    if (!fs.existsSync(planFile) || fs.statSync(planFile).size === 0) {
      throw new AiE2eError('The agent did not write an approved plan (plan.md); no tests may be generated.');
    }

    const relevantSpecs = (files: string[]): string[] => [...new Set([
      ...files.filter(isTestFile),
      ...(files.some((file) => !isTestFile(file)) ? setup.testFiles : []),
    ])].sort();
    const specs = relevantSpecs(generatedFiles);
    if (!specs.length) {
      throw new AiE2eError('The coding CLI finished without adding or patching a Playwright spec. The push is blocked; no test result can be assumed.');
    }
    let testRun: TestRunResult | undefined;
    let verifiedFiles: Snapshot | undefined;
    let currentSpecs = specs;
    for (let healingAttempt = 0; healingAttempt <= MAX_HEALING_ATTEMPTS; healingAttempt += 1) {
      if (Date.now() >= deadline || signal?.aborted) throw new AiE2eError('Generation deadline reached or cancelled; inspect the job log before retrying.');
      const boundedConfig = { ...config, playwright: { ...config.playwright, testTimeoutSeconds: Math.min(config.playwright.testTimeoutSeconds, (deadline - Date.now()) / 1000) } };
      const testInputs = snapshotFiles(root, [...new Set([...generatedFiles, ...currentSpecs])]);
      testRun = (await runGeneratedTests(root, boundedConfig, setup, currentSpecs, log, signal)) ?? undefined;
      if (testRun) job = store.update(jobId, { testRun });
      if (testRun?.passed) { verifiedFiles = testInputs; break; }
      if (!testRun) throw new AiE2eError('No independent test run was recorded.');
      if (healingAttempt === MAX_HEALING_ATTEMPTS) {
        throw new AiE2eError(`Generated Playwright tests did not pass after ${MAX_HEALING_ATTEMPTS} healing attempt(s); the push is blocked.`);
      }

      const repairPrompt = `Read the task specification at \`${taskRel}\`. The approved Playwright plan is at \`${path.relative(root, planFile).split(path.sep).join('/')}\`.
The newly generated specs are: ${currentSpecs.map((spec) => `\`${spec}\``).join(', ')}.
The last Playwright run failed. Act as the repair engineer: determine the correct commands needed to inspect and rerun
the test, use the repository's Playwright configuration, and patch only these generated specs or their generated helpers.
If the failure is an authentication or environment prerequisite, ask the user for the missing input or permission in
this terminal; do not invent credentials or silently skip the test. If shell execution is denied, report the exact
permission required so the worker can surface it. Do not ask for plan approval again, do not create unrelated files,
and do not claim success without running the exact Playwright command. Keep fixing and rerunning in a loop until the
tests pass. When they pass, write \`${path.relative(root, doneFile).split(path.sep).join('/')}\` containing
\`{"status":"passed"}\`; PushPilot then closes this session automatically. Only if a blocker cannot be resolved even with
the user's help, write \`{"status":"blocked","reason":"<concrete reason>"}\` to that file instead.

## Exact failed command
\`${testRun.command.join(' ')}\`

## Playwright failure report
${testRun.failureOutput ? `\`\`\`\n${testRun.failureOutput}\n\`\`\`` : '(no reporter output was captured; inspect the Playwright artifacts)'}

## Relevant artifacts
- Job directory: \`${path.relative(root, jobDir).split(path.sep).join('/')}\`
- Playwright output directory: \`${setup.outputDir}\`
- Generated specs: ${currentSpecs.join(', ')}`;
      log(`Invoking coding CLI repair phase (attempt ${healingAttempt + 1}/${MAX_HEALING_ATTEMPTS}).`);
      const healingResult = await runWithFallbacks(repairPrompt);
      await finishPhase(healingResult);
      if (healingResult.error || healingResult.aborted || healingResult.timedOut || (!healingResult.completed && healingResult.exitCode !== 0)) {
        const reason = healingResult.aborted
          ? 'interrupted'
          : healingResult.timedOut
            ? `timed out after ${config.generation.timeoutSeconds}s`
            : healingResult.error
              ? healingResult.error.message
              : `exit code ${healingResult.exitCode ?? healingResult.signal}`;
        throw new AiE2eError(`Coding CLI repair phase failed: ${reason}. ${redact(healingResult.stderr.trim().split('\n').slice(-5).join(' | '))}`.trim());
      }
      const healed = await restoreExistingTests(root, jobDir, before, config.generation.allowModifyExistingTests, log);
      restored.patches.push(...healed.patches);
      restored.warnings.push(...healed.warnings);
      const afterHealing = await listFiles(root, scanDirs);
      currentSpecs = relevantSpecs(changedTests(afterHealing));
      if (!currentSpecs.length) throw new AiE2eError('The repair agent removed every generated Playwright spec; the push is blocked.');
      generatedFiles = changedTests(afterHealing);
    }
    const finalStatus = await statusSnapshot(root);
    for (const warning of restoreSetupFiles(root, setupBefore)) log(warning);
    const allowed = new Set(generatedFiles.filter((file) =>
      scanDirs.some((dir) => isWithin(dir, file)) && /\.(?:[cm]?[jt]sx?|py)$/.test(file) &&
      fs.lstatSync(path.join(root, file)).isFile() &&
      fs.realpathSync(path.join(root, file)).startsWith(`${fs.realpathSync(root)}${path.sep}`)));
    const unsafe = [...finalStatus.keys()].filter((file) => !isIgnoredDirty(file) && !allowed.has(file));
    if (unsafe.length || generatedFiles.some((file) => !allowed.has(file))) {
      throw new AiE2eError(`Changes outside allowed test source files detected; nothing committed. Review: ${unsafe.join(', ') || generatedFiles.join(', ')}`);
    }
    if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== headBefore ||
        (await git(root, ['diff', '--cached', '--name-only'])).trim()) {
      throw new AiE2eError('HEAD or Git index changed during generation; nothing committed. Review manually.');
    }
    if (!testRun?.passed) throw new AiE2eError('Independent test verification did not pass.');
    const assertVerifiedUnchanged = async (): Promise<void> => {
      for (const [file, content] of verifiedFiles?.files ?? []) {
        if (!content || !fs.existsSync(path.join(root, file)) || !fs.readFileSync(path.join(root, file)).equals(content)) {
          throw new AiE2eError(`Test input changed during/after verification or exceeded snapshot limit: ${file}. Nothing committed; rerun verification.`);
        }
      }
      if (signal.aborted || (await git(root, ['rev-parse', 'HEAD'])).trim() !== headBefore ||
          (await git(root, ['diff', '--cached', '--name-only'])).trim() ||
          [...(await statusSnapshot(root)).keys()].some((file) => !isIgnoredDirty(file) && !allowed.has(file))) {
        throw new AiE2eError('Repository changed or generation was cancelled after verification. Nothing committed; review and retry.');
      }
    };
    await assertVerifiedUnchanged();
    job = store.update(jobId, { generatedFiles, proposedPatches: restored.patches });
    if (config.generation.commitGeneratedTests) {
      const terminal = (options.openReviewTerminal ?? openTerminal)();
      if (!terminal) throw new AiE2eError('Tests passed but committing requires human review in an interactive terminal. No commit was made.');
      try {
        terminal.output.write(`PushPilot verified these test changes:\n${generatedFiles.join('\n')}\n`);
        terminal.output.write(await git(root, ['diff', '--stat', '--', ...generatedFiles]));
        if (await askYesNo('Have you reviewed and approved committing these test files? [y/N] ', terminal, config.prompt.timeoutSeconds * 1000) !== 'yes') {
          throw new AiE2eError('Commit approval declined or timed out. Test changes are preserved, uncommitted.');
        }
      } finally { terminal.close(); }
      await assertVerifiedUnchanged();
      await git(root, ['add', '--', ...generatedFiles]);
      await git(root, [
        'commit',
        '--only',
        '-m',
        'test: add generated Playwright coverage',
        '-m',
        `${GENERATED_TRAILER}: ${jobId}\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
        '--',
        ...generatedFiles,
      ]);
      log('Committed generated Playwright tests after a passing run.');
      const generatedCommit = (await git(root, ['rev-parse', 'HEAD'])).trim();
      job = store.update(jobId, { generatedCommit });
      if (job.source === 'pre-push') {
        if (!job.remote) throw new AiE2eError('Generated tests were committed, but the pre-push remote is unavailable for publishing.');
        scheduleFollowUpPush(root, job.remote, refs, store.logFile(jobId), generatedCommit);
        log('Your push continues now; the generated-test commit is pushed automatically right after it, and you will be told when it is done.');
      }
    }

    const summary = summarize({ generatedFiles, proposedPatches: restored.patches, ...(testRun ? { testRun } : {}) }, setup);
    log(summary);
    job = store.update(jobId, {
      status: 'succeeded',
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      summary,
      ...(testRun ? { testRun } : {}),
    });
  } catch (error) {
    const skipped = error instanceof SkipJob;
    const message = errorMessage(error);
    log(skipped ? `Skipped: ${message}` : `Failed: ${message}`);
    job = store.update(jobId, {
      status: skipped ? 'skipped' : 'failed',
      exitCode: skipped ? 0 : 1,
      finishedAt: new Date().toISOString(),
      ...(skipped ? { summary: message } : { error: message }),
    });
  } finally {
    if (!options.signal) {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
    store.releaseLock(job.fingerprint, jobId);
    try {
      store.prune(config.jobs.keep);
    } catch (error) {
      log(`Could not prune old jobs: ${errorMessage(error)}`);
    }
  }
  log(`Job ${jobId} finished with status ${job.status}.`);
  return job;
}
