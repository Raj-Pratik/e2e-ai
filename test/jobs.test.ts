import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { defaultConfig } from '../src/config.js';
import { isValidJobId, JobStore } from '../src/jobs.js';
import { launchWorker, startJob, workerEnv } from '../src/launcher.js';
import { parsePrePushInput } from '../src/refs.js';
import { tmpDir } from './helpers.js';

const FP = 'abcdef0123456789abcd';
const refs = parsePrePushInput(`refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}`);
const DEAD_PID = 2 ** 22 + 12345;

function store(): JobStore {
  return new JobStore(path.join(tmpDir(), '.ai-e2e'));
}

describe('job store', () => {
  it('creates, updates and lists jobs newest first', () => {
    const s = store();
    const a = s.create({ fingerprint: FP, source: 'manual', remote: null, provider: 'copilot' });
    const b = s.create({ fingerprint: 'ffff0000ffff0000ffff', source: 'pre-push', remote: 'origin', provider: 'claude' });
    assert.ok(isValidJobId(a.id));
    s.update(a.id, { status: 'succeeded', pid: process.pid });
    const list = s.list();
    assert.equal(list.length, 2);
    assert.equal(s.read(a.id)?.status, 'succeeded');
    assert.ok(list.some((j) => j.id === b.id));
  });

  it('marks running jobs whose worker died as crashed', () => {
    const s = store();
    const job = s.create({ fingerprint: FP, source: 'manual', remote: null, provider: 'copilot' });
    s.update(job.id, { status: 'running', pid: DEAD_PID });
    assert.equal(s.list()[0]?.status, 'crashed');
  });

  it('marks queued jobs that never started as crashed after a grace period', () => {
    const s = store();
    const job = s.create({ fingerprint: FP, source: 'manual', remote: null, provider: 'copilot' });
    assert.equal(s.refresh(job).status, 'queued');
    assert.equal(s.refresh(job, Date.now() + 10 * 60 * 1000).status, 'crashed');
  });

  it('locks a fingerprint while a live job holds it and recovers stale locks', () => {
    const s = store();
    const live = s.create({ fingerprint: FP, source: 'manual', remote: null, provider: 'copilot' });
    s.update(live.id, { status: 'running', pid: process.pid });
    assert.equal(s.acquireLock(FP, live.id), true);
    const other = s.create({ fingerprint: FP, source: 'manual', remote: null, provider: 'copilot' });
    assert.equal(s.acquireLock(FP, other.id), false);
    s.update(live.id, { pid: DEAD_PID });
    assert.equal(s.acquireLock(FP, other.id), true);
    s.releaseLock(FP, other.id);
    assert.equal(fs.readdirSync(s.locksDir).length, 0);
  });

  it('rejects path-traversal job ids', () => {
    assert.throws(() => store().jobDir('../../etc'), /Invalid job id/);
  });
});

describe('duplicate detection and launching', () => {
  it('skips a second job for the same change set while the first is active or succeeded', async () => {
    const s = store();
    const config = defaultConfig();
    const launch = async () => ({ ok: true as const, pid: process.pid });
    const first = await startJob({ repoRoot: tmpDir(), config, store: s, refs, remote: null, fingerprint: FP, source: 'manual', background: true, launch });
    assert.equal(first.kind, 'started');
    if (first.kind === 'started') s.update(first.job.id, { status: 'running', pid: process.pid });
    const second = await startJob({ repoRoot: tmpDir(), config, store: s, refs, remote: null, fingerprint: FP, source: 'manual', background: true, launch });
    assert.equal(second.kind, 'duplicate');
    const forced = await startJob({ repoRoot: tmpDir(), config, store: s, refs, remote: null, fingerprint: FP, source: 'manual', background: true, launch, force: true });
    assert.equal(forced.kind, 'started');
  });

  it('allows duplicates when configured', async () => {
    const s = store();
    const config = { ...defaultConfig(), jobs: { ...defaultConfig().jobs, duplicate: 'allow' as const } };
    const launch = async () => ({ ok: true as const, pid: process.pid });
    for (let i = 0; i < 2; i++) {
      const r = await startJob({ repoRoot: tmpDir(), config, store: s, refs, remote: null, fingerprint: FP, source: 'manual', background: true, launch });
      assert.equal(r.kind, 'started');
      if (r.kind === 'started') s.update(r.job.id, { status: 'running', pid: process.pid });
    }
  });

  it('records launch failures without throwing', async () => {
    const s = store();
    const job = s.create({ fingerprint: FP, source: 'pre-push', remote: null, provider: 'copilot' });
    s.acquireLock(FP, job.id);
    const result = await launchWorker({ repoRoot: tmpDir(), store: s, job, nodePath: '/nonexistent/node' });
    assert.equal(result.ok, false);
    assert.equal(s.read(job.id)?.status, 'failed');
    assert.match(s.read(job.id)?.error ?? '', /Could not start background worker/);
    assert.equal(fs.readdirSync(s.locksDir).length, 0);
  });

  it('strips hook-specific Git variables from the worker environment', () => {
    const env = workerEnv({ GIT_DIR: '.git', GIT_INDEX_FILE: 'x', PATH: '/bin' });
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_INDEX_FILE, undefined);
    assert.equal(env.PATH, '/bin');
    assert.equal(env.AI_E2E_WORKER, '1');
  });
});
