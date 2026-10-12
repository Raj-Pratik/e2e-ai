import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { JobStore, type JobRecord } from '../src/jobs.js';
import { CLI, commit, createRepo, fakeProviderConfig, git, runDetached, testEnv, tmpDir, waitFor, write, writeConfig } from './helpers.js';

/** End-to-end: real `git push` through the installed hook into a bare remote. */
async function setup(options: { existingHook?: string } = {}) {
  const repo = createRepo();
  if (options.existingHook !== undefined) {
    fs.writeFileSync(path.join(repo.root, '.git', 'hooks', 'pre-push'), options.existingHook, { mode: 0o755 });
  }
  writeConfig(repo.root, fakeProviderConfig());
  const init = await runDetached(process.execPath, [CLI, 'init'], repo.root, testEnv());
  assert.equal(init.code, 0, init.stderr);
  git(repo.root, 'add', '.ai-e2e.json', '.gitignore');
  git(repo.root, 'commit', '-q', '-m', 'ai-e2e config');
  git(repo.root, 'push', '-q', '--no-verify', 'origin', 'main');
  commit(repo.root, { 'src/orders.ts': 'export const orders = () => [];\n' }, 'orders page');
  write(repo.root, 'src/wip.ts', 'developer work in progress\n');
  return repo;
}

const jobs = (root: string): JobRecord[] => new JobStore(path.join(root, '.ai-e2e')).list();
const remoteHead = (remote: string): string => git(remote, 'rev-parse', 'main').trim();

describe('git push integration', () => {
  it('declining (no terminal) lets the push succeed and starts nothing', async () => {
    const repo = await setup();
    const result = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /no interactive terminal; skipping/);
    assert.equal(remoteHead(repo.remote), git(repo.root, 'rev-parse', 'HEAD').trim());
    assert.equal(jobs(repo.root).length, 0);
  });

  it('explicit "no" answer lets the push succeed', async () => {
    const repo = await setup();
    const result = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv({ AI_E2E_ASSUME: 'no' }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /ai-e2e: skipped\./);
    assert.equal(jobs(repo.root).length, 0);
  });

  it('accepting starts a background worker and the push does not wait for it', async () => {
    const repo = await setup();
    const release = path.join(tmpDir(), 'release');
    const env = testEnv({ AI_E2E_ASSUME: 'yes', FAKE_MODE: 'block', FAKE_RELEASE: release });
    const result = await runDetached('git', ['push', 'origin', 'main'], repo.root, env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /started background job/);
    assert.equal(remoteHead(repo.remote), git(repo.root, 'rev-parse', 'HEAD').trim());

    // The provider is still blocked, so the push provably returned before generation finished.
    const running = await waitFor(() => jobs(repo.root).find((j) => j.status === 'running'), 20_000, 'running job');
    assert.ok(running.pid);
    fs.writeFileSync(release, '');
    const done = await waitFor(() => jobs(repo.root).find((j) => j.status === 'succeeded'), 30_000, 'job completion');
    assert.deepEqual(done.generatedFiles, ['e2e/generated-feature.spec.ts']);

    assert.equal(fs.readFileSync(path.join(repo.root, 'src/wip.ts'), 'utf8'), 'developer work in progress\n');
    assert.equal(git(repo.root, 'diff', '--cached', '--name-only').trim(), '');
    assert.equal(git(repo.root, 'log', '-1', '--format=%s').trim(), 'orders page');
    assert.match(fs.readFileSync(new JobStore(path.join(repo.root, '.ai-e2e')).logFile(done.id), 'utf8'), /\[copilot\] leaked token \[REDACTED\]/);
  });

  it('a failing worker does not reject the push', async () => {
    const repo = await setup();
    const result = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv({ AI_E2E_ASSUME: 'yes', FAKE_MODE: 'fail' }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(remoteHead(repo.remote), git(repo.root, 'rev-parse', 'HEAD').trim());
    const failed = await waitFor(() => jobs(repo.root).find((j) => j.status === 'failed'), 30_000, 'failed job');
    assert.match(failed.error ?? '', /exit code 3/);
  });

  it('a missing provider CLI or broken config does not reject the push', async () => {
    const repo = await setup();
    writeConfig(repo.root, { providers: { copilot: { command: 'no-such-copilot' } } });
    const first = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv({ AI_E2E_ASSUME: 'yes' }));
    assert.equal(first.code, 0, first.stderr);
    await waitFor(() => jobs(repo.root).find((j) => j.status === 'failed'), 30_000, 'failed job');

    commit(repo.root, { 'src/more.ts': 'export {};\n' }, 'more');
    fs.writeFileSync(path.join(repo.root, '.ai-e2e.json'), '{ not json');
    const second = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv({ AI_E2E_ASSUME: 'yes' }));
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stderr, /skipped \(.*not valid JSON/);
  });

  it('a missing CLI build does not reject the push', async () => {
    const repo = await setup();
    const hook = path.join(repo.root, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, fs.readFileSync(hook, 'utf8').replace(/ai_e2e_cli=.*/, "ai_e2e_cli='/nonexistent/cli.js'"));
    const result = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv({ AI_E2E_ASSUME: 'yes' }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /CLI not found/);
  });

  it('preserves an existing hook: it still receives the refs on stdin and can still block', async () => {
    const marker = path.join(tmpDir(), 'refs-seen');
    const existing = `#!/bin/sh\ncat > '${marker}'\nif [ -n "$BLOCK_PUSH" ]; then echo "policy says no" >&2; exit 1; fi\nexit 0\n`;
    const repo = await setup({ existingHook: existing });
    const hookFile = path.join(repo.root, '.git', 'hooks', 'pre-push');
    assert.ok(fs.readFileSync(hookFile, 'utf8').includes("cat > '"));

    const ok = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv({ AI_E2E_ASSUME: 'no' }));
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(fs.readFileSync(marker, 'utf8'), /^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main [0-9a-f]{40}$/m);

    commit(repo.root, { 'src/blocked.ts': 'export {};\n' }, 'blocked');
    const blocked = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv({ AI_E2E_ASSUME: 'no', BLOCK_PUSH: '1' }));
    assert.notEqual(blocked.code, 0, 'the developer\'s own hook semantics must be kept');
    assert.match(blocked.stderr, /policy says no/);

    const un = await runDetached(process.execPath, [CLI, 'uninstall'], repo.root, testEnv());
    assert.equal(un.code, 0);
    assert.equal(fs.readFileSync(hookFile, 'utf8'), existing);
  });

  it('AI_E2E_SKIP bypasses the tool entirely', async () => {
    const repo = await setup();
    const result = await runDetached('git', ['push', 'origin', 'main'], repo.root, testEnv({ AI_E2E_SKIP: '1', AI_E2E_ASSUME: 'yes' }));
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /ai-e2e:/);
    assert.equal(jobs(repo.root).length, 0);
  });
});
