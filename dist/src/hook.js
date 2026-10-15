import fs from 'node:fs';
import { analyzeOutgoing } from './changes.js';
import { loadConfig, stateDirPath } from './config.js';
import { errorMessage } from './errors.js';
import { findRepoRoot, tryGit } from './git.js';
import { JobStore } from './jobs.js';
import { startJob } from './launcher.js';
import { askYesNo, openTerminal } from './prompt.js';
import { parsePrePushInput, refKind } from './refs.js';
import { createLogger } from './log.js';
import { GENERATED_TRAILER, runJob } from './worker.js';
export const QUESTION = 'Would you like to generate E2E tests for these changes using AI? [y/N] ';
/** True when every outgoing commit was created by ai-e2e itself (identified by its commit trailer). */
async function onlyGeneratedTestCommits(root, refs) {
    const { config } = loadConfig(root);
    const verified = new Set(new JobStore(stateDirPath(root, config)).list()
        .filter((job) => job.status === 'succeeded' && job.testRun?.passed && job.generatedCommit)
        .map((job) => job.generatedCommit));
    for (const ref of refs) {
        if (refKind(ref) !== 'update')
            return false;
        const out = await tryGit(root, ['log', '--format=%B%x00', `${ref.remoteSha}..${ref.localSha}`]);
        const bodies = out?.split('\0').map((b) => b.trim()).filter(Boolean);
        if (!bodies?.length || !bodies.every((body) => new RegExp(`^${GENERATED_TRAILER}: `, 'm').test(body)))
            return false;
        const commits = (await tryGit(root, ['rev-list', `${ref.remoteSha}..${ref.localSha}`]))?.trim().split('\n');
        if (!commits?.every((sha) => verified.has(sha)))
            return false;
    }
    return true;
}
/** pre-push entry point. Accepted generation failures block the push. */
export async function runPrePushHook(params) {
    const say = (msg) => params.write(`PushPilot: ${msg}\n`);
    try {
        if (params.env.AI_E2E_WORKER)
            return 'disabled';
        const root = await findRepoRoot(params.cwd);
        const { config } = loadConfig(root);
        if (!config.enabled)
            return 'disabled';
        const refs = parsePrePushInput(params.stdin).filter((r) => refKind(r) !== 'delete');
        if (!refs.length)
            return 'nothing-to-push';
        if (await onlyGeneratedTestCommits(root, refs)) {
            say('only verified PushPilot test commits are outgoing; no prompt needed.');
            return 'no-relevant-changes';
        }
        const assumed = params.env.AI_E2E_ASSUME?.trim().toLowerCase();
        let accepted;
        if (assumed === 'yes' || assumed === 'no') {
            accepted = assumed === 'yes';
        }
        else {
            const tty = (params.openTty ?? openTerminal)();
            if (!tty) {
                say('no interactive terminal; skipping test generation (run `pushpilot generate` later if needed).');
                return 'no-terminal';
            }
            try {
                const answer = await askYesNo(QUESTION, tty, config.prompt.timeoutSeconds * 1000);
                if (answer === 'timeout')
                    tty.output.write('\n');
                accepted = answer === 'yes';
            }
            finally {
                tty.close();
            }
        }
        if (!accepted) {
            say('skipped.');
            return 'declined';
        }
        const changes = await analyzeOutgoing(root, params.remote, refs, config.context, { withDiffs: false });
        if (!changes.files.length) {
            say('no relevant changes found; nothing to generate.');
            return 'no-relevant-changes';
        }
        say(`${changes.commitCount} outgoing commit(s), ${changes.files.length} changed file(s).`);
        const store = new JobStore(stateDirPath(root, config));
        const result = await startJob({
            repoRoot: root,
            config,
            store,
            refs,
            remote: params.remote,
            fingerprint: changes.fingerprint,
            source: 'pre-push',
            background: false,
            ...(params.launch ? { launch: params.launch } : {}),
        });
        switch (result.kind) {
            case 'duplicate':
                say(`a job for these changes already exists (${result.existing.id}, ${result.existing.status}); not starting another.`);
                return result.existing.status === 'succeeded' || result.existing.status === 'skipped' ? 'duplicate' : 'generation-failed';
            case 'launch-failed':
                say(`${result.error} Push is blocked.`);
                return 'launch-failed';
            case 'created': {
                if (params.launch) {
                    const launched = await params.launch({ repoRoot: root, store, job: result.job });
                    if (!launched.ok) {
                        say(`${launched.error} Push is blocked.`);
                        return 'launch-failed';
                    }
                    say(`started job ${result.job.id}.`);
                    return 'started';
                }
                const log = createLogger((text) => {
                    params.write(text);
                    fs.appendFileSync(new JobStore(stateDirPath(root, config)).logFile(result.job.id), text);
                });
                const job = await runJob({ repoRoot: root, jobId: result.job.id, log });
                if (job.status === 'succeeded') {
                    say(`tests passed locally and were committed (job ${job.id}). Push continues; the test commit is pushed right after it and you will be notified when all is done.`);
                    return 'started';
                }
                if (job.status === 'skipped') {
                    say(`no E2E test added (${job.summary ?? 'skipped'}). Push continues.`);
                    return 'no-relevant-changes';
                }
                say(`generation did not pass for job ${job.id}; push is blocked.`);
                return 'generation-failed';
            }
            default:
                return 'error';
        }
    }
    catch (error) {
        say(`failed (${errorMessage(error)}). Push is blocked.`);
        return 'error';
    }
}
