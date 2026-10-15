import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { analyzeOutgoing } from './changes.js';
import { loadConfig, stateDirPath } from './config.js';
import { AiE2eError, errorMessage } from './errors.js';
import { git, listFiles, statusSnapshot } from './git.js';
import { JobStore } from './jobs.js';
import { createLogger } from './log.js';
import { detectPlaywright, isWithin, isTestFile } from './playwright.js';
import { hasInteractiveTerminal, runProcess } from './proc.js';
import { resolveHookTarget } from './hookInstall.js';
import { notifyUser } from './notify.js';
import { assertSafeExtraArgs, detectProvider, getProvider, secretEnvNames } from './providers/index.js';
import { redact } from './redact.js';
import { parsePrePushInput } from './refs.js';
import { buildTask, DONE_FILE } from './taskPrompt.js';
import { CLI_FILE, currentVerification, readVerification, verifyCommandLine, VERIFIED_FILE, writeBaseline } from './verify.js';
export const REFS_FILE = 'refs.txt';
export const TASK_FILE = 'task.md';
/** Commit trailer marking ai-e2e generated test commits; pushes containing only these skip the prompt. */
export const GENERATED_TRAILER = 'AI-E2E-Job';
const SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Non-interactive sessions that stop before a passing verify run are resumed this many times. */
const MAX_CONTINUATIONS = 5;
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
// Files PushPilot's own setup writes (config, ignore rule, hook, Playwright config). They may be uncommitted without blocking generation.
async function setupOwnedFiles(root, setup) {
    const owned = ['.ai-e2e.json', '.gitignore'];
    if (setup.configPath)
        owned.push(path.relative(root, path.resolve(root, setup.configPath)));
    const hook = await resolveHookTarget(root).catch(() => null);
    if (hook)
        owned.push(path.relative(root, hook.file));
    return new Set(owned.map((file) => file.split(path.sep).join('/')));
}
function restoreSetupFiles(root, before) {
    const warnings = [];
    for (const [file, original] of before.files) {
        if (original === null)
            continue;
        const abs = path.join(root, file);
        const current = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
        if (current && current.equals(original))
            continue;
        fs.writeFileSync(abs, original);
        warnings.push(`The coding CLI changed PushPilot setup file ${file}; original restored.`);
    }
    return warnings;
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
function summarize(job, setup) {
    if (!job.generatedFiles.length)
        return 'No new test files were generated.';
    const lines = [`Generated ${job.generatedFiles.length} file(s):`, ...job.generatedFiles.map((f) => `  - ${f}`)];
    const specs = job.generatedFiles.filter(isTestFile);
    if (specs.length)
        lines.push(`Run them with: ${job.testRun?.command.join(' ') ?? specs.join(' ')}`);
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
/** PID of the `git push` that ran the hook: the hook shell is our parent, git is its parent. */
function gitPushPid() {
    if (process.platform === 'win32')
        return null;
    const out = spawnSync('ps', ['-o', 'ppid=', '-p', String(process.ppid)], { encoding: 'utf8' }).stdout?.trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
}
function scheduleFollowUpPush(root, remote, refs, logFile, commit) {
    const ref = refs.find((candidate) => candidate.localRef.startsWith('refs/heads/') && candidate.remoteRef.startsWith('refs/heads/'));
    const cli = CLI_FILE;
    if (!ref)
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
        '--commit',
        commit,
    ], {
        cwd: root,
        detached: true,
        stdio: ['ignore', output, output],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', AI_E2E_PUSH_PID: String(gitPushPid() ?? '') },
    });
    child.once('error', (error) => {
        fs.appendFileSync(logFile, `PushPilot: follow-up publisher could not start: ${error.message}. Review the local commit and run git push.\n`);
    });
    child.unref();
    fs.closeSync(output);
}
export async function runJob(options) {
    const { repoRoot: root, jobId } = options;
    const controller = new AbortController();
    const signal = options.signal ?? controller.signal;
    const abort = () => controller.abort();
    const log = options.log ?? createLogger();
    const { config } = loadConfig(root);
    const store = new JobStore(stateDirPath(root, config));
    const initial = store.read(jobId);
    if (!initial)
        throw new AiE2eError(`Job ${jobId} not found.`);
    const jobDir = store.jobDir(jobId);
    let job = store.update(jobId, { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
    if (!options.signal) {
        process.once('SIGINT', abort);
        process.once('SIGTERM', abort);
    }
    log(`Job ${jobId} started (pid ${process.pid}, provider ${job.provider}, repo ${root}).`);
    try {
        const deadline = config.generation.timeoutSeconds ? Date.now() + config.generation.timeoutSeconds * 1000 : null;
        const headBefore = (await git(root, ['rev-parse', 'HEAD'])).trim();
        const interactive = config.generation.interactive && hasInteractiveTerminal();
        const setup = await detectPlaywright(root, config);
        if (!setup.found) {
            throw new AiE2eError('No Playwright setup detected (no playwright.config.* and no @playwright/test dependency). ' +
                'Run `pushpilot playwright-init --yes` so the coding CLI can initialise Playwright, then re-run `pushpilot generate`.');
        }
        log(`Playwright: config=${setup.configPath ?? 'none'}, testDir=${setup.testDir}, outputDir=${setup.outputDir}, ${setup.testFiles.length} existing test(s).`);
        const refs = parsePrePushInput(fs.readFileSync(path.join(jobDir, REFS_FILE), 'utf8'));
        if (config.generation.commitGeneratedTests && job.source === 'pre-push' &&
            (refs.length !== 1 || refs[0]?.localSha !== headBefore ||
                !refs[0].localRef.startsWith('refs/heads/') || !refs[0].remoteRef.startsWith('refs/heads/'))) {
            throw new AiE2eError('Automatic test commits require a single current-HEAD branch push. Push branches separately or disable generation.commitGeneratedTests.');
        }
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
        const scanDirs = [...new Set([setup.testDir, setup.outputDir])];
        if (scanDirs.some((dir) => dir === '.' || dir.startsWith('..') || path.isAbsolute(dir))) {
            throw new AiE2eError('Configure a dedicated repository-relative playwright.testDir; the repository root is not a safe test allowlist.');
        }
        const listedBefore = await listFiles(root, scanDirs);
        const before = snapshotFiles(root, listedBefore);
        const statusBefore = await statusSnapshot(root);
        const stateRelative = path.relative(root, store.stateDir).split(path.sep).join('/');
        const owned = await setupOwnedFiles(root, setup);
        const isIgnoredDirty = (file) => file.startsWith(`${stateRelative}/`) || owned.has(file);
        const relevantDirty = [...statusBefore.keys()].filter((file) => !isIgnoredDirty(file));
        if (relevantDirty.length)
            throw new AiE2eError(`Working tree must be clean before generation; preserve and review these changes first: ${relevantDirty.join(', ')}`);
        const setupBefore = snapshotFiles(root, [...owned]);
        const indexBefore = [...statusBefore].filter(([, code]) => code[0] !== ' ' && code[0] !== '?').map(([p, c]) => `${c}${p}`).sort().join('\n');
        await writeBaseline(root, jobDir, scanDirs);
        fs.rmSync(path.join(jobDir, VERIFIED_FILE), { force: true });
        const verifyCommand = verifyCommandLine(CLI_FILE, jobId);
        const taskFile = path.join(jobDir, TASK_FILE);
        fs.writeFileSync(taskFile, buildTask({ repoRoot: root, jobDir, changeSet, setup, config, mcp: null, mcpNote: 'not used', verifyCommand }));
        const taskRel = path.relative(root, taskFile).split(path.sep).join('/');
        const instruction = `Read the task specification in \`${taskRel}\` and complete it exactly. Follow every rule in that file.`;
        const providerOut = lineWriter(log, `[${provider.id}] `);
        const doneFile = path.join(jobDir, DONE_FILE);
        const readDone = () => {
            try {
                const done = JSON.parse(fs.readFileSync(doneFile, 'utf8'));
                return done && ['not-needed', 'blocked'].includes(done.status ?? '') && typeof done.reason === 'string' && done.reason.trim().length > 0 ? done : null;
            }
            catch {
                return null;
            }
        };
        const runProvider = async (model, prompt) => {
            if (signal?.aborted)
                throw new AiE2eError('Generation interrupted.');
            if (deadline !== null && Date.now() >= deadline)
                throw new AiE2eError('Generation deadline reached; inspect the job log and resolve the blocker before retrying.');
            fs.rmSync(doneFile, { force: true });
            const invocation = provider.buildInvocation({
                repoRoot: root,
                instruction: prompt,
                settings: { ...settings, model },
                mcp: null,
                secretEnvNames: secretEnvNames(process.env),
                interactive,
                verifyCommand,
            });
            log(`Invoking ${invocation.command}${model ? ` with model ${model}` : ''} (${deadline === null ? 'no time limit' : `timeout ${config.generation.timeoutSeconds}s`}).`);
            return runProcess(availability.resolvedPath ?? invocation.command, invocation.args, {
                cwd: root,
                ...(deadline !== null ? { timeoutMs: deadline - Date.now() } : {}),
                maxOutputBytes: config.generation.maxOutputBytes,
                killProcessGroup: !interactive,
                onOutput: (chunk) => providerOut.write(chunk),
                interactive,
                // A passing verify run (or a not-needed/blocked decision) ends the session; nothing else does.
                stopWhen: () => readVerification(jobDir) !== null || readDone() !== null,
                ...(signal ? { signal } : {}),
            });
        };
        const failure = (attempt) => {
            if (attempt.aborted)
                return 'interrupted';
            if (attempt.timedOut)
                return `timed out after ${config.generation.timeoutSeconds}s`;
            if (attempt.error)
                return attempt.error.message;
            if (!attempt.completed && attempt.exitCode !== 0)
                return `exit code ${attempt.exitCode ?? attempt.signal}`;
            return null;
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
        // Print-mode CLIs can stop on their own (turn limits); resume them until verify passes.
        for (let continuation = 1; !interactive && continuation <= MAX_CONTINUATIONS; continuation += 1) {
            if (failure(result) || readVerification(jobDir) || readDone())
                break;
            log(`Coding CLI stopped before a passing verify run; resuming (${continuation}/${MAX_CONTINUATIONS}).`);
            result = await runWithFallbacks(`Read the task specification in \`${taskRel}\`. The plan in the job directory is approved. ` +
                `Continue from the current files: run \`${verifyCommand}\`, fix the generated specs/helpers on failure and rerun until it reports PASSED.`);
        }
        providerOut.flush();
        if (result.completed)
            log('Agent reported completion; the coding CLI session was closed automatically.');
        const reason = failure(result);
        if (reason)
            throw new AiE2eError(`${provider.displayName} failed: ${reason}. ${redact(result.stderr.trim().split('\n').slice(-5).join(' | '))}`.trim());
        const done = readDone();
        if (done?.status === 'not-needed') {
            const dirty = [...(await statusSnapshot(root)).keys()].filter((file) => !isIgnoredDirty(file));
            if (dirty.length || (await git(root, ['rev-parse', 'HEAD'])).trim() !== headBefore) {
                throw new AiE2eError('Agent reported not-needed but changed the repository. Review changes; push blocked.');
            }
            throw new SkipJob(`agent decided no E2E test is needed: ${redact(done.reason ?? 'non-product change')}`);
        }
        if (done?.status === 'blocked')
            throw new AiE2eError(`The agent reported a blocker: ${redact(done.reason ?? 'no reason given')}`);
        const restored = await restoreExistingTests(root, jobDir, before, config.generation.allowModifyExistingTests, log);
        const warnings = [...restored.warnings];
        const statusAfter = await statusSnapshot(root);
        const outside = [...statusAfter.keys()].filter((p) => statusAfter.get(p) !== statusBefore.get(p) && !scanDirs.some((d) => isWithin(d, p)) && !p.startsWith(`${stateRelative}/`));
        if (outside.length)
            warnings.push(`Files outside the test directories changed during generation (review manually): ${outside.join(', ')}`);
        const indexAfter = [...statusAfter].filter(([, code]) => code[0] !== ' ' && code[0] !== '?').map(([p, c]) => `${c}${p}`).sort().join('\n');
        if (indexAfter !== indexBefore)
            warnings.push('The Git index changed during generation; review `git status` before committing.');
        for (const warning of warnings)
            log(`WARNING: ${warning}`);
        job = store.update(jobId, { proposedPatches: restored.patches, warnings });
        const planFile = path.join(jobDir, 'plan.md');
        if (!fs.existsSync(planFile) || fs.statSync(planFile).size === 0) {
            throw new AiE2eError('The agent did not write an approved plan (plan.md); no tests may be generated.');
        }
        // The coding CLI ran the tests itself through `pushpilot verify`; trust that run only if nothing changed since.
        const newOnly = !config.generation.allowModifyExistingTests;
        const verification = await currentVerification(root, jobDir, newOnly);
        if (!verification.ok) {
            throw new AiE2eError(`The coding CLI session ended without a passing verify run (${verification.reason}). Test files are preserved, uncommitted; the push is blocked.`);
        }
        const testRun = verification.record.testRun;
        const generatedFiles = Object.keys(verification.record.files).sort();
        job = store.update(jobId, { generatedFiles, testRun });
        log(`Verified passing run of ${verification.record.specs.join(', ')} at ${verification.record.verifiedAt}.`);
        for (const warning of restoreSetupFiles(root, setupBefore))
            log(warning);
        const allowed = new Set(generatedFiles.filter((file) => scanDirs.some((dir) => isWithin(dir, file)) && /\.(?:[cm]?[jt]sx?|py)$/.test(file) &&
            fs.lstatSync(path.join(root, file)).isFile() &&
            fs.realpathSync(path.join(root, file)).startsWith(`${fs.realpathSync(root)}${path.sep}`)));
        const assertCommittable = async () => {
            const unsafe = [...(await statusSnapshot(root)).keys()].filter((file) => !isIgnoredDirty(file) && !allowed.has(file));
            if (unsafe.length || generatedFiles.some((file) => !allowed.has(file))) {
                throw new AiE2eError(`Changes outside allowed test source files detected; nothing committed. Review: ${unsafe.join(', ') || generatedFiles.join(', ')}`);
            }
            if (signal.aborted || (await git(root, ['rev-parse', 'HEAD'])).trim() !== headBefore ||
                (await git(root, ['diff', '--cached', '--name-only'])).trim()) {
                throw new AiE2eError('HEAD or Git index changed during generation, or it was cancelled; nothing committed. Review manually.');
            }
            if (!(await currentVerification(root, jobDir, newOnly)).ok)
                throw new AiE2eError('Test files changed after the passing verify run; nothing committed.');
        };
        await assertCommittable();
        if (config.generation.commitGeneratedTests) {
            log(`Committing verified test files:\n${generatedFiles.join('\n')}`);
            await git(root, ['add', '--', ...generatedFiles]);
            await git(root, [
                'commit',
                '--only',
                '-m',
                'test: add generated Playwright coverage',
                '-m',
                `${GENERATED_TRAILER}: ${jobId}\n${provider.id === 'claude' ? 'Co-authored-by: Claude <noreply@anthropic.com>' : 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'}`,
                '--',
                ...generatedFiles,
            ]);
            log('Committed generated Playwright tests after a passing run.');
            const generatedCommit = (await git(root, ['rev-parse', 'HEAD'])).trim();
            job = store.update(jobId, { generatedCommit });
            if (job.source === 'pre-push') {
                if (!job.remote)
                    throw new AiE2eError('Generated tests were committed, but the pre-push remote is unavailable for publishing.');
                scheduleFollowUpPush(root, job.remote, refs, store.logFile(jobId), generatedCommit);
                log('Your push continues now; the generated-test commit is pushed automatically right after it, and you will be notified when it is done.');
            }
            else {
                notifyUser('PushPilot', `Verified E2E tests committed locally (${generatedCommit.slice(0, 12)}).`);
            }
        }
        else {
            notifyUser('PushPilot', 'Verified E2E tests are ready (uncommitted).');
        }
        const summary = summarize({ generatedFiles, proposedPatches: restored.patches, testRun }, setup);
        log(summary);
        job = store.update(jobId, {
            status: 'succeeded',
            exitCode: 0,
            finishedAt: new Date().toISOString(),
            summary,
            testRun,
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
        if (!skipped)
            notifyUser('PushPilot: generation failed', message);
    }
    finally {
        if (!options.signal) {
            process.off('SIGINT', abort);
            process.off('SIGTERM', abort);
        }
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
