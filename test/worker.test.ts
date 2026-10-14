import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { analyzeOutgoing } from '../src/changes.js';
import { loadConfig, stateDirPath } from '../src/config.js';
import { JobStore } from '../src/jobs.js';
import { startJob } from '../src/launcher.js';
import { parsePrePushInput } from '../src/refs.js';
import { runJob } from '../src/worker.js';
import { run } from '../src/commands.js';
import { installHook } from '../src/hookInstall.js';
import { captureIO, CLI, commit, createRepo, fakeProviderConfig, git, tmpDir, writeConfig } from './helpers.js';

const logs: string[] = [];
const log = (line: string): void => {
  logs.push(line);
};

async function prepare(options: { config?: Record<string, unknown>; playwright?: boolean } = {}) {
  const repo = createRepo({ playwright: options.playwright ?? true });
  writeConfig(repo.root, options.config ?? fakeProviderConfig());
  git(repo.root, 'add', '.ai-e2e.json');
  git(repo.root, 'commit', '-q', '-m', 'config');
  git(repo.root, 'push', '-q', 'origin', 'main');
  const remoteSha = git(repo.root, 'rev-parse', 'origin/main').trim();
  const head = commit(repo.root, { 'src/checkout.ts': 'export const checkout = () => "pay";\n' }, 'add checkout');
  const refs = parsePrePushInput(`refs/heads/main ${head} refs/heads/main ${remoteSha}`);
  const { config } = loadConfig(repo.root);
  const store = new JobStore(stateDirPath(repo.root, config));
  const changes = await analyzeOutgoing(repo.root, 'origin', refs, config.context, { withDiffs: false });
  const started = await startJob({ repoRoot: repo.root, config, store, refs, remote: 'origin', fingerprint: changes.fingerprint, source: 'pre-push', background: false });
  assert.equal(started.kind, 'created');
  return { root: repo.root, store, jobId: started.kind === 'created' ? started.job.id : '' };
}

describe('background worker job execution', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('FAKE_')) delete process.env[key];
    logs.length = 0;
  });

  it('generates a new test, keeps it uncommitted and records the result', async () => {
    const { root, store, jobId } = await prepare();
    const taskCopy = path.join(tmpDir(), 'task.md');
    process.env.FAKE_TASK_COPY = taskCopy;
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'succeeded', job.error);
    assert.deepEqual(job.generatedFiles, ['e2e/generated-feature.spec.ts']);
    assert.match(job.summary ?? '', /Run them with: .*e2e\/generated-feature.spec.ts/);
    assert.equal(git(root, 'status', '--porcelain', '--', 'e2e').trim(), '?? e2e/generated-feature.spec.ts');
    assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), '');
    assert.ok(store.read(jobId)?.finishedAt);

    const task = fs.readFileSync(taskCopy, 'utf8');
    assert.match(task, /src\/checkout\.ts/);
    assert.match(task, /under `e2e\/`/);
    assert.match(task, /e2e\/fixtures\/auth\.ts/);
    assert.match(task, /Approval gate/);
    assert.ok(!logs.join('\n').includes('a'.repeat(36)), 'provider output must be redacted in logs');
  });

  it('marks the job failed when the provider exits non-zero', async () => {
    const { root, jobId } = await prepare();
    process.env.FAKE_MODE = 'fail';
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /exit code 3/);
  });

  it('stops the provider when the worker is interrupted', async () => {
    const { root, jobId } = await prepare({ config: fakeProviderConfig({ generation: { timeoutSeconds: 10 } }) });
    process.env.FAKE_MODE = 'hang';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const job = await runJob({ repoRoot: root, jobId, log, signal: controller.signal });
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /interrupted/);
  });

  it('fails cleanly when the provider CLI is not installed', async () => {
    const { root, jobId } = await prepare({ config: { provider: 'claude', providers: { claude: { command: 'no-such-claude-binary' } } } });
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /Claude Code CLI is unavailable/);
  });

  it('restores existing tests changed by the agent and saves a patch instead', async () => {
    const { root, jobId } = await prepare();
    const existing = path.join(root, 'e2e', 'home.spec.ts');
    const before = fs.readFileSync(existing, 'utf8');
    process.env.FAKE_MODE = 'modify';
    process.env.FAKE_MODIFY = existing;
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'succeeded', job.error);
    assert.equal(fs.readFileSync(existing, 'utf8'), before);
    assert.equal(job.proposedPatches.length, 1);
    assert.match(fs.readFileSync(path.join(root, job.proposedPatches[0]!), 'utf8'), /changed by agent/);
    assert.ok(job.warnings.some((w) => /original restored/.test(w)));
  });

  it('warns about files changed outside the test directory', async () => {
    const { root, jobId } = await prepare();
    process.env.FAKE_MODE = 'outside';
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.ok(job.warnings.some((w) => /src\/agent-touched\.ts/.test(w)));
  });

  it('blocks with guidance when the repository has no Playwright setup', async () => {
    const { root, jobId } = await prepare({ playwright: false });
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /pushpilot playwright-init --yes/);
  });

  it('does not use Playwright MCP during generation', async () => {
    const config = fakeProviderConfig({ mcp: { playwright: { enabled: true, command: 'no-such-mcp-command' } } });
    const { root, jobId } = await prepare({ config });
    const argsFile = path.join(tmpDir(), 'args.json');
    process.env.FAKE_ARGS_FILE = argsFile;
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'succeeded', job.error);
    assert.ok(!JSON.parse(fs.readFileSync(argsFile, 'utf8')).includes('--additional-mcp-config'));
    assert.ok(logs.some((l) => /no Playwright sub-agents or MCP/.test(l)));
  });

  it('does all work in the coding CLI without Playwright MCP or sub-agents', async () => {
    const config = fakeProviderConfig({ mcp: { playwright: { enabled: true, command: process.execPath, args: ['mcp.js'], baseUrl: 'http://localhost:4000' } } });
    const { root, jobId } = await prepare({ config });
    const argsFile = path.join(tmpDir(), 'args.json');
    const taskCopy = path.join(tmpDir(), 'task.md');
    process.env.FAKE_ARGS_FILE = argsFile;
    process.env.FAKE_TASK_COPY = taskCopy;
    await runJob({ repoRoot: root, jobId, log });
    assert.ok(!JSON.parse(fs.readFileSync(argsFile, 'utf8')).includes('--additional-mcp-config'));
    const task = fs.readFileSync(taskCopy, 'utf8');
    assert.match(task, /Do NOT delegate to sub-agents/);
    assert.match(task, /Approval gate/);
    assert.doesNotMatch(task, /init-agents/);
  });

  it('blocks the job when generated tests fail', async () => {
    const config = fakeProviderConfig({ playwright: { runGeneratedTests: true, testCommand: [process.execPath, '-e', 'process.exit(1)'] } });
    const { root, jobId } = await prepare({ config });
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.equal(job.testRun?.passed, false);
    assert.match(job.error ?? '', /did not pass/);
  });

  it('invokes a repair agent and reruns tests until they pass', async () => {
    const marker = path.join(tmpDir(), 'healed');
    const command = [
      process.execPath,
      '-e',
      `const fs=require('node:fs'); const marker=${JSON.stringify(marker)}; if (fs.existsSync(marker)) { console.log('1 passed'); process.exit(0); } fs.writeFileSync(marker, 'failed once'); process.exit(1);`,
    ];
    const config = fakeProviderConfig({ playwright: { runGeneratedTests: true, testCommand: command } });
    const { root, jobId } = await prepare({ config });
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'succeeded', job.error);
    assert.equal(job.testRun?.passed, true);
    assert.ok(logs.some((line) => /coding CLI repair phase \(attempt 1\/3\)/.test(line)));
  });

  it('closes the coding CLI session when the agent signals completion', async () => {
    const { root, jobId } = await prepare({ config: fakeProviderConfig({ generation: { timeoutSeconds: 60 } }) });
    process.env.FAKE_MODE = 'done-and-hang';
    const started = Date.now();
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'succeeded', job.error);
    assert.ok(Date.now() - started < 30_000, 'session must be closed long before the timeout');
    assert.ok(logs.some((line) => /session was closed automatically/.test(line)));
  });

  it('skips without blocking when the agent decides no E2E test is needed', async () => {
    const { root, jobId } = await prepare();
    process.env.FAKE_MODE = 'not-needed';
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'skipped');
    assert.match(job.summary ?? '', /docs only/);
  });

  it('patches existing coverage without requiring a new spec', async () => {
    const { root, jobId } = await prepare({ config: fakeProviderConfig({ generation: { allowModifyExistingTests: true } }) });
    process.env.FAKE_TARGET = 'home.spec.ts';
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'succeeded', job.error);
    assert.deepEqual(job.generatedFiles, ['e2e/home.spec.ts']);
    assert.equal(job.testRun?.passed, true);
    assert.match(git(root, 'diff', '--', 'e2e/home.spec.ts'), /generated/);
  });

  it('rejects a zero exit with no executed tests', async () => {
    const { root, jobId } = await prepare({ config: fakeProviderConfig({ playwright: { testCommand: [process.execPath, '-e', 'process.exit(0)'] } }) });
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.equal(job.testRun?.passed, false);
    assert.match(job.testRun?.failureOutput ?? '', /No positive passed-test count/);
  });

  it('fails when no runner is installed even if the provider writes tests', async () => {
    const { root, jobId } = await prepare({ config: fakeProviderConfig({ playwright: { testCommand: null } }) });
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /No runnable Playwright command/);
  });

  it('refuses mixed passed and skipped coverage', async () => {
    const { root, jobId } = await prepare({ config: fakeProviderConfig({ playwright: { testCommand: [process.execPath, '-e', 'console.log("1 passed, 1 skipped")'] } }) });
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.equal(job.testRun?.passed, false);
  });

  it('blocks on unrelated agent edits without overwriting them', async () => {
    const { root, jobId } = await prepare();
    process.env.FAKE_MODE = 'outside';
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /outside allowed test source files/);
    assert.equal(fs.readFileSync(path.join(root, 'src/agent-touched.ts'), 'utf8'), 'export {};\n');
    assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), '');
  });

  it('requires human review before committing a verified run', async () => {
    const { root, jobId } = await prepare({ config: fakeProviderConfig({ generation: { commitGeneratedTests: true } }) });
    const head = git(root, 'rev-parse', 'HEAD');
    const job = await runJob({ repoRoot: root, jobId, log });
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /human review/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    assert.ok(fs.existsSync(path.join(root, 'e2e/generated-feature.spec.ts')));
  });

  it('commits only reviewed tests and publishes the pinned commit through the normal hook', async () => {
    const { root, store, jobId } = await prepare({ config: fakeProviderConfig({ generation: { commitGeneratedTests: true } }) });
    store.update(jobId, { source: 'manual' });
    const expected = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'push', '-q', 'origin', 'main');
    const job = await runJob({
      repoRoot: root, jobId, log,
      openReviewTerminal: () => {
        const input = new PassThrough(), output = new PassThrough();
        output.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('approved committing')) setImmediate(() => input.write('yes\n'));
        });
        return { input, output, close: () => input.destroy() };
      },
    });
    assert.equal(job.status, 'succeeded', job.error);
    assert.ok(job.generatedCommit);
    assert.equal(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', job.generatedCommit!).trim(), 'e2e/generated-feature.spec.ts');
    await installHook(root, CLI, path.join(store.stateDir, 'backups'), false);
    fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.ai-e2e/\n');
    // New unrelated HEAD must never be published by the follow-up command.
    commit(root, { 'src/later.ts': 'export const later = true;\n' }, 'later unrelated work');
    const io = captureIO(root);
    assert.equal(await run(['publish-after-push', '--remote', 'origin', '--branch', 'main', '--expected', expected, '--commit', job.generatedCommit!], io), 0, io.stderr());
    const remote = git(root, 'remote', 'get-url', 'origin').trim();
    assert.equal(git(remote, 'rev-parse', 'main').trim(), job.generatedCommit);
    assert.notEqual(git(root, 'rev-parse', 'HEAD').trim(), job.generatedCommit);
  });
});
