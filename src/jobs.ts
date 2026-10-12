import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AiE2eError } from './errors.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'crashed';

export interface TestRunResult {
  command: string[];
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
}

export interface JobRecord {
  id: string;
  fingerprint: string;
  status: JobStatus;
  source: 'pre-push' | 'manual';
  remote: string | null;
  provider: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  error?: string;
  summary?: string;
  generatedFiles: string[];
  proposedPatches: string[];
  warnings: string[];
  testRun?: TestRunResult;
}

const JOB_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const ACTIVE: ReadonlySet<JobStatus> = new Set(['queued', 'running']);
/** A queued job whose worker never reported in within this window is treated as dead. */
const QUEUED_GRACE_MS = 2 * 60 * 1000;

export function isValidJobId(id: string): boolean {
  return JOB_ID.test(id);
}

export function isActive(status: JobStatus): boolean {
  return ACTIVE.has(status);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function newJobId(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomBytes(3).toString('hex')}`;
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export class JobStore {
  readonly jobsDir: string;
  readonly locksDir: string;

  constructor(readonly stateDir: string) {
    this.jobsDir = path.join(stateDir, 'jobs');
    this.locksDir = path.join(stateDir, 'locks');
  }

  ensure(): void {
    fs.mkdirSync(this.jobsDir, { recursive: true });
    fs.mkdirSync(this.locksDir, { recursive: true });
  }

  jobDir(id: string): string {
    if (!isValidJobId(id)) throw new AiE2eError(`Invalid job id "${id}".`);
    return path.join(this.jobsDir, id);
  }

  logFile(id: string): string {
    return path.join(this.jobDir(id), 'worker.log');
  }

  create(fields: Pick<JobRecord, 'fingerprint' | 'source' | 'remote' | 'provider'>): JobRecord {
    this.ensure();
    const id = newJobId();
    fs.mkdirSync(this.jobDir(id));
    const job: JobRecord = {
      id,
      ...fields,
      status: 'queued',
      createdAt: new Date().toISOString(),
      generatedFiles: [],
      proposedPatches: [],
      warnings: [],
    };
    writeJsonAtomic(this.recordPath(id), job);
    return job;
  }

  read(id: string): JobRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.recordPath(id), 'utf8')) as JobRecord;
    } catch {
      return null;
    }
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord {
    const current = this.read(id);
    if (!current) throw new AiE2eError(`Job ${id} not found.`);
    const next = { ...current, ...patch, id };
    writeJsonAtomic(this.recordPath(id), next);
    return next;
  }

  /** Reconciles records whose worker died without reporting (crash, reboot, kill -9). */
  refresh(job: JobRecord, now = Date.now()): JobRecord {
    if (!isActive(job.status)) return job;
    const dead = job.pid !== undefined ? !isProcessAlive(job.pid) : now - Date.parse(job.createdAt) > QUEUED_GRACE_MS;
    if (!dead) return job;
    return this.update(job.id, {
      status: 'crashed',
      finishedAt: new Date(now).toISOString(),
      error: job.error ?? 'Worker exited without recording a result.',
    });
  }

  list(): JobRecord[] {
    if (!fs.existsSync(this.jobsDir)) return [];
    return fs
      .readdirSync(this.jobsDir)
      .filter(isValidJobId)
      .map((id) => this.read(id))
      .filter((job): job is JobRecord => job !== null)
      .map((job) => this.refresh(job))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  latest(): JobRecord | null {
    return this.list()[0] ?? null;
  }

  findDuplicate(fingerprint: string, includeSucceeded: boolean): JobRecord | null {
    return (
      this.list().find(
        (job) => job.fingerprint === fingerprint && (isActive(job.status) || (includeSucceeded && job.status === 'succeeded')),
      ) ?? null
    );
  }

  /** Atomically claims a change-set fingerprint; returns false if a live job holds it. */
  acquireLock(fingerprint: string, jobId: string): boolean {
    this.ensure();
    const file = this.lockPath(fingerprint);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, jobId, { flag: 'wx' });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = fs.readFileSync(file, 'utf8').trim();
        const holderJob = isValidJobId(holder) ? this.read(holder) : null;
        if (holderJob && isActive(this.refresh(holderJob).status)) return false;
        fs.rmSync(file, { force: true });
      }
    }
    return false;
  }

  releaseLock(fingerprint: string, jobId: string): void {
    const file = this.lockPath(fingerprint);
    try {
      if (fs.readFileSync(file, 'utf8').trim() === jobId) fs.rmSync(file, { force: true });
    } catch {
      // lock already gone
    }
  }

  prune(keep: number): void {
    for (const job of this.list().slice(keep)) {
      if (!isActive(job.status)) fs.rmSync(this.jobDir(job.id), { recursive: true, force: true });
    }
  }

  private recordPath(id: string): string {
    return path.join(this.jobDir(id), 'job.json');
  }

  private lockPath(fingerprint: string): string {
    if (!/^[0-9a-f]{8,64}$/.test(fingerprint)) throw new AiE2eError('Invalid change-set fingerprint.');
    return path.join(this.locksDir, `${fingerprint}.lock`);
  }
}
