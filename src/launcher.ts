import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { errorMessage } from './errors.js';
import { JobStore, type JobRecord } from './jobs.js';
import { formatPrePushInput, type PushRef } from './refs.js';
import { REFS_FILE } from './worker.js';

export const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

/** Variables Git exports to hooks that would point a long-lived worker at the wrong repository state. */
const HOOK_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH'];

export function workerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of HOOK_GIT_ENV) delete next[key];
  next.AI_E2E_WORKER = '1';
  return next;
}

export interface LaunchOptions {
  repoRoot: string;
  store: JobStore;
  job: JobRecord;
  nodePath?: string;
  cliPath?: string;
}

export type LaunchResult = { ok: true; pid: number } | { ok: false; error: string };

/** Starts a detached worker whose output goes to the job log; never waits for completion. */
export async function launchWorker(options: LaunchOptions): Promise<LaunchResult> {
  const { store, job } = options;
  let logFd: number | undefined;
  try {
    logFd = fs.openSync(store.logFile(job.id), 'a');
    const child = spawn(options.nodePath ?? process.execPath, [options.cliPath ?? CLI_PATH, 'worker', '--job', job.id], {
      cwd: options.repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: workerEnv(),
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { ok: true, pid: child.pid ?? -1 };
  } catch (error) {
    const message = `Could not start background worker: ${errorMessage(error)}`;
    try {
      store.update(job.id, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
      store.releaseLock(job.fingerprint, job.id);
      if (logFd !== undefined) fs.writeSync(logFd, `${message}\n`);
    } catch {
      // best effort: the push must not depend on bookkeeping
    }
    return { ok: false, error: message };
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd);
  }
}

export type StartResult =
  | { kind: 'started'; job: JobRecord; pid: number }
  | { kind: 'duplicate'; existing: JobRecord }
  | { kind: 'launch-failed'; job: JobRecord; error: string }
  | { kind: 'created'; job: JobRecord };

export interface StartOptions {
  repoRoot: string;
  config: Config;
  store: JobStore;
  refs: PushRef[];
  remote: string | null;
  fingerprint: string;
  source: JobRecord['source'];
  provider?: string;
  force?: boolean;
  /** When false the job is only created, for the caller to run in the foreground. */
  background: boolean;
  launch?: (options: LaunchOptions) => Promise<LaunchResult>;
}

export async function startJob(options: StartOptions): Promise<StartResult> {
  const { store, config } = options;
  const dedupe = config.jobs.duplicate === 'skip' && !options.force;
  if (dedupe) {
    const existing = store.findDuplicate(options.fingerprint, true);
    if (existing) return { kind: 'duplicate', existing };
  }
  const job = store.create({
    fingerprint: options.fingerprint,
    source: options.source,
    remote: options.remote,
    provider: options.provider ?? config.provider,
  });
  fs.writeFileSync(path.join(store.jobDir(job.id), REFS_FILE), formatPrePushInput(options.refs));
  if (dedupe && !store.acquireLock(options.fingerprint, job.id)) {
    store.update(job.id, { status: 'skipped', summary: 'Duplicate of an active job.', finishedAt: new Date().toISOString() });
    const existing = store.findDuplicate(options.fingerprint, false);
    return { kind: 'duplicate', existing: existing ?? job };
  }
  if (!options.background) return { kind: 'created', job };
  const launched = await (options.launch ?? launchWorker)({ repoRoot: options.repoRoot, store, job });
  if (!launched.ok) return { kind: 'launch-failed', job, error: launched.error };
  return { kind: 'started', job, pid: launched.pid };
}
