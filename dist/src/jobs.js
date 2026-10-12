import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AiE2eError } from './errors.js';
const JOB_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const ACTIVE = new Set(['queued', 'running']);
/** A queued job whose worker never reported in within this window is treated as dead. */
const QUEUED_GRACE_MS = 2 * 60 * 1000;
export function isValidJobId(id) {
    return JOB_ID.test(id);
}
export function isActive(status) {
    return ACTIVE.has(status);
}
export function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
function newJobId(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${date}-${time}-${randomBytes(3).toString('hex')}`;
}
function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
}
export class JobStore {
    stateDir;
    jobsDir;
    locksDir;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.jobsDir = path.join(stateDir, 'jobs');
        this.locksDir = path.join(stateDir, 'locks');
    }
    ensure() {
        fs.mkdirSync(this.jobsDir, { recursive: true });
        fs.mkdirSync(this.locksDir, { recursive: true });
    }
    jobDir(id) {
        if (!isValidJobId(id))
            throw new AiE2eError(`Invalid job id "${id}".`);
        return path.join(this.jobsDir, id);
    }
    logFile(id) {
        return path.join(this.jobDir(id), 'worker.log');
    }
    create(fields) {
        this.ensure();
        const id = newJobId();
        fs.mkdirSync(this.jobDir(id));
        const job = {
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
    read(id) {
        try {
            return JSON.parse(fs.readFileSync(this.recordPath(id), 'utf8'));
        }
        catch {
            return null;
        }
    }
    update(id, patch) {
        const current = this.read(id);
        if (!current)
            throw new AiE2eError(`Job ${id} not found.`);
        const next = { ...current, ...patch, id };
        writeJsonAtomic(this.recordPath(id), next);
        return next;
    }
    /** Reconciles records whose worker died without reporting (crash, reboot, kill -9). */
    refresh(job, now = Date.now()) {
        if (!isActive(job.status))
            return job;
        const dead = job.pid !== undefined ? !isProcessAlive(job.pid) : now - Date.parse(job.createdAt) > QUEUED_GRACE_MS;
        if (!dead)
            return job;
        return this.update(job.id, {
            status: 'crashed',
            finishedAt: new Date(now).toISOString(),
            error: job.error ?? 'Worker exited without recording a result.',
        });
    }
    list() {
        if (!fs.existsSync(this.jobsDir))
            return [];
        return fs
            .readdirSync(this.jobsDir)
            .filter(isValidJobId)
            .map((id) => this.read(id))
            .filter((job) => job !== null)
            .map((job) => this.refresh(job))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    }
    latest() {
        return this.list()[0] ?? null;
    }
    findDuplicate(fingerprint, includeSucceeded) {
        return (this.list().find((job) => job.fingerprint === fingerprint && (isActive(job.status) || (includeSucceeded && job.status === 'succeeded'))) ?? null);
    }
    /** Atomically claims a change-set fingerprint; returns false if a live job holds it. */
    acquireLock(fingerprint, jobId) {
        this.ensure();
        const file = this.lockPath(fingerprint);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                fs.writeFileSync(file, jobId, { flag: 'wx' });
                return true;
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
                const holder = fs.readFileSync(file, 'utf8').trim();
                const holderJob = isValidJobId(holder) ? this.read(holder) : null;
                if (holderJob && isActive(this.refresh(holderJob).status))
                    return false;
                fs.rmSync(file, { force: true });
            }
        }
        return false;
    }
    releaseLock(fingerprint, jobId) {
        const file = this.lockPath(fingerprint);
        try {
            if (fs.readFileSync(file, 'utf8').trim() === jobId)
                fs.rmSync(file, { force: true });
        }
        catch {
            // lock already gone
        }
    }
    prune(keep) {
        for (const job of this.list().slice(keep)) {
            if (!isActive(job.status))
                fs.rmSync(this.jobDir(job.id), { recursive: true, force: true });
        }
    }
    recordPath(id) {
        return path.join(this.jobDir(id), 'job.json');
    }
    lockPath(fingerprint) {
        if (!/^[0-9a-f]{8,64}$/.test(fingerprint))
            throw new AiE2eError('Invalid change-set fingerprint.');
        return path.join(this.locksDir, `${fingerprint}.lock`);
    }
}
