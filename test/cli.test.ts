import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../src/commands.js';
import { runPrePushHook } from '../src/hook.js';
import type { PromptIO } from '../src/prompt.js';
import { PassThrough } from 'node:stream';
import { captureIO, commit, createRepo, fakeProviderConfig, git, testEnv, tmpDir, writeConfig } from './helpers.js';

describe('CLI parsing', () => {
  it('prints help and version', async () => {
    const io = captureIO(tmpDir());
    assert.equal(await run(['help'], io), 0);
    assert.match(io.stdout(), /Usage: pushpilot <command>/);
    const v = captureIO(tmpDir());
    assert.equal(await run(['--version'], v), 0);
    assert.match(v.stdout(), /^\d+\.\d+\.\d+/);
  });

  it('provides command-specific help without entering a repository', async () => {
    const io = captureIO(tmpDir());
    assert.equal(await run(['generate', '--help'], io), 0);
    assert.match(io.stdout(), /--base: upstream/);
    assert.doesNotMatch(io.stdout(), /Commands:/);
    const init = captureIO(tmpDir());
    assert.equal(await run(['help', 'init'], init), 0);
    assert.match(init.stdout(), /--no-hook/);
    assert.equal(await run(['help', 'unknown'], captureIO(tmpDir())), 2);
  });

  it('rejects unknown commands and options with exit code 2', async () => {
    const io = captureIO(tmpDir());
    assert.equal(await run(['frobnicate'], io), 2);
    assert.match(io.stderr(), /Unknown command "frobnicate"/);
    const { root } = createRepo();
    const bad = captureIO(root);
    assert.equal(await run(['status', '--bogus'], bad), 2);
    assert.match(bad.stderr(), /bogus/);
    const badLimit = captureIO(root);
    assert.equal(await run(['status', '--limit', 'abc'], badLimit), 2);
  });

  it('fails outside a git repository with a clear message', async () => {
    const io = captureIO(tmpDir());
    assert.equal(await run(['status'], io), 1);
    assert.match(io.stderr(), /Not inside a Git working tree/);
  });

  it('init creates config, ignores state and installs the hook; config set/get round-trips', async () => {
    const { root } = createRepo();
    const io = captureIO(root);
    assert.equal(await run(['init'], io), 0, io.stderr());
    assert.ok(fs.existsSync(path.join(root, '.ai-e2e.json')));
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /\/\.ai-e2e\//);
    assert.ok(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-push')));
    assert.match(io.stdout(), /Playwright: config playwright\.config\.ts/);

    assert.equal(await run(['config', 'set', 'provider', 'claude'], captureIO(root)), 0);
    const get = captureIO(root);
    await run(['config', 'get', 'provider'], get);
    assert.equal(get.stdout().trim(), '"claude"');
    const bad = captureIO(root);
    assert.equal(await run(['config', 'set', 'context.maxFiles', '"lots"'], bad), 1);
    assert.match(bad.stderr(), /integer/);

    const un = captureIO(root);
    assert.equal(await run(['uninstall'], un), 0);
    assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-push')), false);
  });

  it('providers lists availability without failing when CLIs are missing', async () => {
    const { root } = createRepo();
    writeConfig(root, { providers: { copilot: { command: 'missing-copilot' }, claude: { command: 'missing-claude' } } });
    const io = captureIO(root);
    assert.equal(await run(['providers'], io), 0);
    assert.match(io.stdout(), /copilot .*unavailable/);
    assert.match(io.stdout(), /claude .*unavailable/);
  });

  it('generate --foreground runs a job end to end and status/logs report it', async () => {
    const { root } = createRepo();
    writeConfig(root, fakeProviderConfig());
    commit(root, { 'src/search.ts': 'export const search = () => [];\n' }, 'search');
    const io = captureIO(root);
    assert.equal(await run(['generate', '--foreground', '--base', 'origin/main'], io), 0, io.stderr());
    assert.match(io.stdout(), /status: +succeeded/);

    const status = captureIO(root);
    await run(['status', '--json'], status);
    const [job] = JSON.parse(status.stdout()) as Array<{ status: string; generatedFiles: string[] }>;
    assert.equal(job?.status, 'succeeded');

    const dup = captureIO(root);
    await run(['generate', '--base', 'origin/main'], dup);
    assert.match(dup.stdout(), /already exists/);

    const logs = captureIO(root);
    assert.equal(await run(['logs', '--tail', '5'], logs), 0);
    assert.match(logs.stdout(), /finished with status succeeded/);
  });
});

function fakeTty(answer: string): () => PromptIO {
  return () => {
    const input = new PassThrough();
    const output = new PassThrough();
    setImmediate(() => input.write(answer));
    return { input, output, close: () => input.destroy() };
  };
}

describe('pre-push hook handler', () => {
  async function pushInput() {
    const repo = createRepo();
    writeConfig(repo.root, fakeProviderConfig());
    const remoteSha = git(repo.root, 'rev-parse', 'origin/main').trim();
    const head = commit(repo.root, { 'src/profile.ts': 'export const p = 1;\n' }, 'profile');
    return { root: repo.root, stdin: `refs/heads/main ${head} refs/heads/main ${remoteSha}\n` };
  }

  it('declines on Enter and starts nothing', async () => {
    const { root, stdin } = await pushInput();
    let launched = false;
    let out = '';
    const outcome = await runPrePushHook({
      cwd: root,
      remote: 'origin',
      stdin,
      env: testEnv(),
      write: (t) => (out += t),
      openTty: fakeTty('\n'),
      launch: async () => {
        launched = true;
        return { ok: true, pid: 1 };
      },
    });
    assert.equal(outcome, 'declined');
    assert.equal(launched, false);
    assert.match(out, /PushPilot: skipped\./);
  });

  it('declines when no terminal is available', async () => {
    const { root, stdin } = await pushInput();
    const outcome = await runPrePushHook({ cwd: root, remote: 'origin', stdin, env: testEnv(), write: () => undefined, openTty: () => null });
    assert.equal(outcome, 'no-terminal');
  });

  it('prompts before deciding that there are no relevant changes', async () => {
    const { root, stdin } = await pushInput();
    writeConfig(root, { context: { exclude: ['**/*'] } });
    let prompted = false;
    const outcome = await runPrePushHook({
      cwd: root,
      remote: 'origin',
      stdin,
      env: testEnv(),
      write: () => undefined,
      openTty: () => {
        prompted = true;
        return fakeTty('y\n')();
      },
    });
    assert.equal(outcome, 'no-relevant-changes');
    assert.equal(prompted, true);
  });

  it('launches a worker on y without waiting for it', async () => {
    const { root, stdin } = await pushInput();
    let launchedJob = '';
    const outcome = await runPrePushHook({
      cwd: root,
      remote: 'origin',
      stdin,
      env: testEnv(),
      write: () => undefined,
      openTty: fakeTty('y\n'),
      launch: async ({ job }) => {
        launchedJob = job.id;
        return { ok: true, pid: 1 };
      },
    });
    assert.equal(outcome, 'started');
    assert.ok(launchedJob);
  });

  it('never throws: malformed input, bad config and launch failures all resolve', async () => {
    const { root, stdin } = await pushInput();
    const quiet = { cwd: root, remote: 'origin', env: testEnv(), write: () => undefined };
    assert.equal(await runPrePushHook({ ...quiet, stdin: 'garbage line' }), 'error');
    assert.equal(
      await runPrePushHook({ ...quiet, stdin, env: testEnv({ AI_E2E_ASSUME: 'yes' }), launch: async () => ({ ok: false, error: 'spawn EACCES' }) }),
      'launch-failed',
    );
    fs.writeFileSync(path.join(root, '.ai-e2e.json'), '{ broken');
    assert.equal(await runPrePushHook({ ...quiet, stdin }), 'error');
    assert.equal(await runPrePushHook({ ...quiet, cwd: tmpDir(), stdin }), 'error');
  });

  it('ignores branch deletions', async () => {
    const { root } = await pushInput();
    const outcome = await runPrePushHook({ cwd: root, remote: 'origin', stdin: `(delete) ${'0'.repeat(40)} refs/heads/x ${'a'.repeat(40)}\n`, env: testEnv(), write: () => undefined });
    assert.equal(outcome, 'nothing-to-push');
  });

  it('does not trust a generated-commit trailer without a local verified receipt', async () => {
    const repo = createRepo();
    writeConfig(repo.root, fakeProviderConfig());
    const remoteSha = git(repo.root, 'rev-parse', 'origin/main').trim();
    fs.mkdirSync(path.join(repo.root, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, 'e2e', 'gen.spec.ts'), 'export {};\n');
    git(repo.root, 'add', 'e2e/gen.spec.ts');
    git(repo.root, 'commit', '-q', '-m', 'test: add generated Playwright coverage', '-m', 'AI-E2E-Job: 20260101-000000-abcdef');
    const head = git(repo.root, 'rev-parse', 'HEAD').trim();
    let prompted = false;
    const outcome = await runPrePushHook({
      cwd: repo.root,
      remote: 'origin',
      stdin: `refs/heads/main ${head} refs/heads/main ${remoteSha}\n`,
      env: testEnv(),
      write: () => undefined,
      openTty: () => {
        prompted = true;
        return fakeTty('n\n')();
      },
    });
    assert.equal(outcome, 'declined');
    assert.equal(prompted, true);
  });

  it('hook command blocks on malformed input', async () => {
    const io = captureIO(tmpDir(), testEnv(), 'not valid input');
    assert.equal(await run(['hook', 'pre-push', 'origin', 'url'], io), 1);
  });
});
