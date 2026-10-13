import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { analyzeOutgoing } from './changes.js';
import { loadConfig, stateDirPath } from './config.js';
import { AiE2eError, errorMessage } from './errors.js';
import { git, listFiles, statusSnapshot } from './git.js';
import { JobStore } from './jobs.js';
import { createLogger } from './log.js';
import { detectPlaywright, isWithin } from './playwright.js';
import { hasInteractiveTerminal, runProcess } from './proc.js';
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
class SkipJob extends Error {
}
function snapshotFiles(root, files) {
    const map = new Map();
    for (const file of files) {
        try {
            const abs = path.join(root, file);
            map.set(file, fs.statSync(abs).size <= SNAPSHOT_MAX_FILE_BYTES ? fs.readFileSync(abs) : null);
        }
        catch {
            // vanished between listing and reading
        }
    }
    return { files: map };
}
function lineWriter(log, prefix) {
    let pending = '';
    return {
        write(chunk) {
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines)
                log(`${prefix}${redact(line)}`);
        },
        flush() {
            if (pending)
                log(`${prefix}${redact(pending)}`);
            pending = '';
        },
    };
}
async function restoreExistingTests(root, jobDir, before, allowModify, log) {
    const patches = [];
    const warnings = [];
    for (const [file, original] of before.files) {
        const abs = path.join(root, file);
        const current = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
        if (original === null || (current && current.equals(original)))
            continue;
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
async function runGeneratedTests(root, config, setup, specs, log, signal) {
    const command = config.playwright.testCommand
        ? [...config.playwright.testCommand, ...specs]
        : setup.cliPath
            ? [process.execPath, setup.cliPath, 'test', ...specs]
            : null;
    if (!command) {
        log('Skipping test run: Playwright CLI not found in node_modules and no playwright.testCommand configured.');
        return null;
    }
    log(`Running generated tests: ${command.join(' ')}`);
    const out = lineWriter(log, '[playwright] ');
    const result = await runProcess(command[0], command.slice(1), {
        cwd: root,
        timeoutMs: config.playwright.testTimeoutSeconds * 1000,
        maxOutputBytes: config.generation.maxOutputBytes,
        killProcessGroup: true,
        onOutput: (chunk) => out.write(chunk),
        ...(signal ? { signal } : {}),
    });
    out.flush();
    if (result.error)
        log(`Test command could not start: ${result.error.message}`);
    const passed = result.exitCode === 0;
    log(passed ? 'Generated tests passed.' : `Generated tests failed (exit ${result.exitCode ?? result.signal}${result.timedOut ? ', timed out' : ''}).`);
    const failureOutput = passed ? undefined : redact(`${result.stdout}\n${result.stderr}`.trim().slice(-12_000));
    return { command, exitCode: result.exitCode, passed, timedOut: result.timedOut, ...(failureOutput ? { failureOutput } : {}) };
}
function summarize(job, setup) {
    if (!job.generatedFiles.length)
        return 'No new test files were generated.';
    const lines = [`Generated ${job.generatedFiles.length} file(s):`, ...job.generatedFiles.map((f) => `  - ${f}`)];
    const specs = job.generatedFiles.filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f));
    if (specs.length)
        lines.push(`Run them with: npx playwright test ${specs.join(' ')}`);
    if (job.proposedPatches.length)
        lines.push(`Proposed changes to existing files: ${job.proposedPatches.join(', ')}`);
    if (job.testRun)
        lines.push(`Test run: ${job.testRun.passed ? 'passed' : 'failed'}`);
    if (!setup.configPath)
        lines.push('Note: no Playwright config file was found.');
    return lines.join('\n');
}
/** Opens the user's terminal device by path so a detached process can still report back to it. */
function openUserTerminal() {
    if (process.platform === 'win32')
        return null;
    let ttyFd;
    try {
        ttyFd = fs.openSync('/dev/tty', 'r');
        const device = spawnSync('tty', [], { stdio: [ttyFd, 'pipe', 'ignore'], encoding: 'utf8' }).stdout?.trim();
        return device && device.startsWith('/dev/') ? fs.openSync(device, 'a') : null;
    }
    catch {
        return null;
    }
    finally {
        if (ttyFd !== undefined)
            fs.closeSync(ttyFd);
    }
}
function scheduleFollowUpPush(root, remote, refs, logFile) {
    const ref = refs.find((candidate) => candidate.localRef.startsWith('refs/heads/') && candidate.remoteRef.startsWith('refs/heads/'));
    const cli = process.argv[1];
    if (!ref || !cli)
        throw new AiE2eError('Could not schedule the follow-up push: branch ref or CLI path is unavailable.');
    const output = openUserTerminal() ?? fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [
        cli,
        'publish-after-push',
        '--remote',
        remote,
        '--branch',
        ref.remoteRef.slice('refs/heads/'.length),
        '--expected',
        ref.localSha,
    ], {
        cwd: root,
        detached: true,
        stdio: ['ignore', output, output],
        env: { ...process.env, AI_E2E_SKIP: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    child.unref();
    fs.closeSync(output);
}
export async function runJob(options) {
    const { repoRoot: root, jobId, signal } = options;
    const log = options.log ?? createLogger();
    const { config } = loadConfig(root);
    const store = new JobStore(stateDirPath(root, config));
    const initial = store.read(jobId);
    if (!initial)
        throw new AiE2eError(`Job ${jobId} not found.`);
    const jobDir = store.jobDir(jobId);
    let job = store.update(jobId, { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
    log(`Job ${jobId} started (pid ${process.pid}, provider ${job.provider}, repo ${root}).`);
    try {
        const interactive = config.generation.interactive && hasInteractiveTerminal();
        const setup = await detectPlaywright(root, config);
        if (!setup.found) {
            throw new SkipJob('No Playwright setup detected (no playwright.config.* and no @playwright/test dependency). ' +
                'Run `ai-e2e playwright-init --yes` so the coding CLI can initialise Playwright, then re-run `ai-e2e generate`.');
        }
        log(`Playwright: config=${setup.configPath ?? 'none'}, testDir=${setup.testDir}, outputDir=${setup.outputDir}, ${setup.testFiles.length} existing test(s).`);
        const refs = parsePrePushInput(fs.readFileSync(path.join(jobDir, REFS_FILE), 'utf8'));
        const changeSet = await analyzeOutgoing(root, job.remote, refs, config.context, { withDiffs: true });
        for (const note of changeSet.notes)
            log(`Note: ${note}`);
        for (const ex of changeSet.excluded)
            log(`Excluded ${ex.path} (${ex.reason}).`);
        if (!changeSet.files.length)
            throw new SkipJob('No analyzable changes (all changed files were excluded or nothing is outgoing).');
        log(`Analyzing ${changeSet.commitCount} commit(s), ${changeSet.files.length} file(s), ${changeSet.totalDiffBytes} diff bytes.`);
        const provider = getProvider(job.provider);
        const settings = config.providers[provider.id] ?? config.providers.copilot;
        assertSafeExtraArgs(provider, settings);
        const availability = await detectProvider(provider, settings, root);
        if (!availability.available)
            throw new AiE2eError(`${provider.displayName} is unavailable: ${availability.reason}`);
        log(`Provider ${provider.displayName}: ${availability.resolvedPath} (${availability.version ?? 'unknown version'}).`);
        log('The coding CLI plans, writes and runs the tests itself (no Playwright sub-agents or MCP).');
        const taskFile = path.join(jobDir, TASK_FILE);
        fs.writeFileSync(taskFile, buildTask({ repoRoot: root, jobDir, changeSet, setup, config, mcp: null, mcpNote: 'not used' }));
        const taskRel = path.relative(root, taskFile).split(path.sep).join('/');
        const instruction = `Read the task specification in \`${taskRel}\` and complete it exactly. Follow every rule in that file.`;
        const scanDirs = [...new Set([setup.testDir, setup.outputDir])];
        const listedBefore = await listFiles(root, scanDirs);
        const before = snapshotFiles(root, listedBefore);
        const statusBefore = await statusSnapshot(root);
        const indexBefore = [...statusBefore].filter(([, code]) => code[0] !== ' ' && code[0] !== '?').map(([p, c]) => `${c}${p}`).sort().join('\n');
        const providerOut = lineWriter(log, `[${provider.id}] `);
        const doneFile = path.join(jobDir, DONE_FILE);
        const readDone = () => {
            try {
                return JSON.parse(fs.readFileSync(doneFile, 'utf8'));
            }
            catch {
                return null;
            }
        };
        const runProvider = async (model, prompt) => {
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
                timeoutMs: config.generation.timeoutSeconds * 1000,
                maxOutputBytes: config.generation.maxOutputBytes,
                killProcessGroup: !interactive,
                onOutput: (chunk) => providerOut.write(chunk),
                interactive,
                // The agent writes done.json when its tests pass (or it is blocked); then the session is closed for it.
                stopWhen: () => readDone() !== null,
                ...(signal ? { signal } : {}),
            });
        };
        const finishPhase = (attempt) => {
            providerOut.flush();
            if (!attempt.completed)
                return;
            log('Agent reported completion; the coding CLI session was closed automatically.');
            const done = readDone();
            if (done?.status === 'not-needed')
                throw new SkipJob(`agent decided no E2E test is needed: ${redact(done.reason ?? 'non-product change')}`);
            if (done?.status === 'blocked') {
                throw new AiE2eError(`The agent reported a blocker: ${redact(done.reason ?? 'no reason given')}`);
            }
        };
        const runWithFallbacks = async (prompt) => {
            let attempt = await runProvider(settings.model, prompt);
            for (const fallbackModel of settings.fallbackModels) {
                if (attempt.completed || attempt.exitCode === 0 || attempt.error || attempt.aborted || attempt.timedOut)
                    break;
                log(`Provider exited unsuccessfully; retrying with fallback model ${fallbackModel}.`);
                attempt = await runProvider(fallbackModel, prompt);
            }
            return attempt;
        };
        let result = await runWithFallbacks(instruction);
        finishPhase(result);
        const restored = await restoreExistingTests(root, jobDir, before, config.generation.allowModifyExistingTests, log);
        const listedAfter = await listFiles(root, scanDirs);
        const known = new Set(listedBefore);
        let generatedFiles = listedAfter.filter((f) => !known.has(f) && fs.existsSync(path.join(root, f))).sort();
        const warnings = [...restored.warnings];
        const statusAfter = await statusSnapshot(root);
        const outside = [...statusAfter.keys()].filter((p) => statusAfter.get(p) !== statusBefore.get(p) && !scanDirs.some((d) => isWithin(d, p)) && !p.startsWith(`${path.relative(root, store.stateDir)}/`));
        if (outside.length)
            warnings.push(`Files outside the test directories changed during generation (review manually): ${outside.join(', ')}`);
        const indexAfter = [...statusAfter].filter(([, code]) => code[0] !== ' ' && code[0] !== '?').map(([p, c]) => `${c}${p}`).sort().join('\n');
        if (indexAfter !== indexBefore)
            warnings.push('The Git index changed during generation; review `git status` before committing.');
        for (const warning of warnings)
            log(`WARNING: ${warning}`);
        job = store.update(jobId, { generatedFiles, proposedPatches: restored.patches, warnings });
        if (!result.completed && (result.error || result.exitCode !== 0)) {
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
        const specs = generatedFiles.filter((f) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f));
        if (!specs.length) {
            throw new AiE2eError('The coding CLI finished without creating a new Playwright spec. The push is blocked; no test result can be assumed.');
        }
        let testRun;
        let currentSpecs = specs;
        for (let healingAttempt = 0; healingAttempt <= MAX_HEALING_ATTEMPTS; healingAttempt += 1) {
            testRun = (await runGeneratedTests(root, config, setup, currentSpecs, log, signal)) ?? undefined;
            if (testRun)
                job = store.update(jobId, { testRun });
            if (testRun?.passed)
                break;
            if (!testRun)
                break;
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
\`{"status":"passed"}\`; ai-e2e then closes this session automatically. Only if a blocker cannot be resolved even with
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
            finishPhase(healingResult);
            if (!healingResult.completed && (healingResult.error || healingResult.exitCode !== 0)) {
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
            currentSpecs = afterHealing
                .filter((file) => !known.has(file) && fs.existsSync(path.join(root, file)))
                .filter((file) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(file))
                .sort();
            if (!currentSpecs.length)
                throw new AiE2eError('The repair agent removed every generated Playwright spec; the push is blocked.');
            generatedFiles = afterHealing.filter((file) => !known.has(file) && fs.existsSync(path.join(root, file))).sort();
        }
        if (config.generation.commitGeneratedTests) {
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
            if (job.source === 'pre-push') {
                if (!job.remote)
                    throw new AiE2eError('Generated tests were committed, but the pre-push remote is unavailable for publishing.');
                scheduleFollowUpPush(root, job.remote, refs, store.logFile(jobId));
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
    }
    catch (error) {
        const skipped = error instanceof SkipJob;
        const message = errorMessage(error);
        log(skipped ? `Skipped: ${message}` : `Failed: ${message}`);
        job = store.update(jobId, {
            status: skipped ? 'skipped' : 'failed',
            exitCode: skipped ? 0 : 1,
            finishedAt: new Date().toISOString(),
            ...(skipped ? { summary: message } : { error: message }),
        });
    }
    finally {
        store.releaseLock(job.fingerprint, jobId);
        try {
            store.prune(config.jobs.keep);
        }
        catch (error) {
            log(`Could not prune old jobs: ${errorMessage(error)}`);
        }
    }
    log(`Job ${jobId} finished with status ${job.status}.`);
    return job;
}
