import { analyzeOutgoing } from './changes.js';
import { loadConfig, stateDirPath } from './config.js';
import { errorMessage } from './errors.js';
import { findRepoRoot } from './git.js';
import { JobStore } from './jobs.js';
import { startJob, type LaunchOptions, type LaunchResult } from './launcher.js';
import { askYesNo, openTerminal, type PromptIO } from './prompt.js';
import { parsePrePushInput, refKind } from './refs.js';

export const QUESTION = 'Would you like to generate E2E tests for these changes using AI? [y/N] ';

export interface HookParams {
  cwd: string;
  remote: string | null;
  stdin: string;
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  openTty?: () => PromptIO | null;
  launch?: (options: LaunchOptions) => Promise<LaunchResult>;
}

export type HookOutcome =
  | 'disabled'
  | 'nothing-to-push'
  | 'no-relevant-changes'
  | 'declined'
  | 'no-terminal'
  | 'duplicate'
  | 'started'
  | 'launch-failed'
  | 'error';

/** pre-push entry point. Every path resolves; callers must still exit 0. */
export async function runPrePushHook(params: HookParams): Promise<HookOutcome> {
  const say = (msg: string): void => params.write(`ai-e2e: ${msg}\n`);
  try {
    if (params.env.AI_E2E_WORKER) return 'disabled';
    const root = await findRepoRoot(params.cwd);
    const { config } = loadConfig(root);
    if (!config.enabled) return 'disabled';

    const refs = parsePrePushInput(params.stdin).filter((r) => refKind(r) !== 'delete');
    if (!refs.length) return 'nothing-to-push';

    const changes = await analyzeOutgoing(root, params.remote, refs, config.context, { withDiffs: false });
    if (!changes.files.length) return 'no-relevant-changes';
    say(`${changes.commitCount} outgoing commit(s), ${changes.files.length} changed file(s).`);

    const assumed = params.env.AI_E2E_ASSUME?.trim().toLowerCase();
    let accepted: boolean;
    if (assumed === 'yes' || assumed === 'no') {
      accepted = assumed === 'yes';
    } else {
      const tty = (params.openTty ?? openTerminal)();
      if (!tty) {
        say('no interactive terminal; skipping test generation (run `ai-e2e generate` later if needed).');
        return 'no-terminal';
      }
      try {
        const answer = await askYesNo(QUESTION, tty, config.prompt.timeoutSeconds * 1000);
        if (answer === 'timeout') tty.output.write('\n');
        accepted = answer === 'yes';
      } finally {
        tty.close();
      }
    }
    if (!accepted) {
      say('skipped.');
      return 'declined';
    }

    const store = new JobStore(stateDirPath(root, config));
    const result = await startJob({
      repoRoot: root,
      config,
      store,
      refs,
      remote: params.remote,
      fingerprint: changes.fingerprint,
      source: 'pre-push',
      background: true,
      ...(params.launch ? { launch: params.launch } : {}),
    });
    switch (result.kind) {
      case 'duplicate':
        say(`a job for these changes already exists (${result.existing.id}, ${result.existing.status}); not starting another.`);
        return 'duplicate';
      case 'launch-failed':
        say(`${result.error} Push continues.`);
        return 'launch-failed';
      default:
        say(`started background job ${result.job.id}. Check progress with \`ai-e2e status\` and \`ai-e2e logs\`.`);
        return 'started';
    }
  } catch (error) {
    say(`skipped (${errorMessage(error)}). Push continues.`);
    return 'error';
  }
}
