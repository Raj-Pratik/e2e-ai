import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultProviderSettings } from '../src/config.js';
import { runProcess } from '../src/proc.js';
import { assertSafeExtraArgs, detectProvider, getProvider, listProviders, secretEnvNames } from '../src/providers/index.js';
import type { ProviderRequest } from '../src/providers/index.js';
import { FAKE_PROVIDER, tmpDir } from './helpers.js';

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  repoRoot: '/repo',
  instruction: 'Read the task specification in `.ai-e2e/jobs/x/task.md`.',
  settings: defaultProviderSettings(),
  mcp: null,
  secretEnvNames: [],
  ...overrides,
});

describe('provider registry', () => {
  it('lists copilot and claude and rejects unknown providers', () => {
    assert.deepEqual(listProviders().map((p) => p.id), ['copilot', 'claude']);
    assert.throws(() => getProvider('gpt-cli'), /Unknown provider "gpt-cli"/);
  });

  it('reports a missing CLI as unavailable instead of throwing', async () => {
    const result = await detectProvider(getProvider('claude'), { ...defaultProviderSettings(), command: 'definitely-not-installed-ai-cli' }, tmpDir());
    assert.equal(result.available, false);
    assert.match(result.reason ?? '', /not found on PATH/);
  });

  it('detects an installed CLI and its version', async () => {
    const result = await detectProvider(getProvider('copilot'), { ...defaultProviderSettings(), command: FAKE_PROVIDER }, tmpDir());
    assert.equal(result.available, true);
    assert.equal(result.version, 'fake-provider 1.2.3');
  });
});

describe('copilot invocation', () => {
  const copilot = getProvider('copilot');

  it('runs non-interactively with shell access denied by default', () => {
    const { command, args } = copilot.buildInvocation(request({ secretEnvNames: ['GH_TOKEN'] }));
    assert.equal(command, 'copilot');
    assert.deepEqual(args.slice(0, 2), ['-p', request().instruction]);
    for (const flag of ['--silent', '--no-ask-user', '--allow-all-tools', '--deny-tool=shell', '--secret-env-vars=GH_TOKEN']) assert.ok(args.includes(flag), flag);
    assert.ok(!args.some((a) => a.includes('mcp')));
  });

  it('uses Copilot interactive mode so the agent can wait for user approval', () => {
    const { args } = copilot.buildInvocation(request({ interactive: true }));
    assert.deepEqual(args.slice(0, 2), ['-i', request().instruction]);
    assert.ok(args.includes('--allow-all-tools'));
    assert.ok(!args.includes('--no-ask-user'));
    assert.ok(!args.includes('--silent'));
  });

  it('denies dangerous shell commands when limited shell access is allowed', () => {
    const { args } = copilot.buildInvocation(request({ settings: { ...defaultProviderSettings(), allowedShellCommands: ['git log'] } }));
    assert.ok(!args.includes('--deny-tool=shell'));
    assert.ok(args.includes('--deny-tool=shell(git push)'));
    assert.ok(!args.includes('--deny-tool=shell(git log)'));
  });

  it('passes Playwright MCP config as JSON only when provided', () => {
    const { args } = copilot.buildInvocation(request({ mcp: { name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'] } }));
    const json = args[args.indexOf('--additional-mcp-config') + 1]!;
    assert.deepEqual(JSON.parse(json), { mcpServers: { playwright: { type: 'local', command: 'npx', args: ['@playwright/mcp@latest'], tools: ['*'] } } });
  });

  it('rejects permission-bypassing extra args unless explicitly allowed', () => {
    const settings = { ...defaultProviderSettings(), extraArgs: ['--yolo'] };
    assert.throws(() => assertSafeExtraArgs(copilot, settings), /permission-bypassing/);
    assert.doesNotThrow(() => assertSafeExtraArgs(copilot, { ...settings, allowUnsafeArgs: true }));
    assert.doesNotThrow(() => assertSafeExtraArgs(copilot, { ...settings, extraArgs: ['--model', 'gpt-5'] }));
  });
});

describe('claude invocation', () => {
  const claude = getProvider('claude');

  it('keeps the prompt positional right after -p and restricts tools', () => {
    const { command, args } = claude.buildInvocation(request({ settings: { ...defaultProviderSettings(), model: 'sonnet' } }));
    assert.equal(command, 'claude');
    assert.deepEqual(args.slice(0, 2), ['-p', request().instruction]);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.ok(args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Bash');
  });

  it('adds strict MCP config when Playwright MCP is enabled', () => {
    const { args } = claude.buildInvocation(request({ mcp: { name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'] } }));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__playwright');
  });

  it('rejects --dangerously-skip-permissions in extraArgs', () => {
    assert.throws(() => assertSafeExtraArgs(claude, { ...defaultProviderSettings(), extraArgs: ['--dangerously-skip-permissions'] }));
    assert.throws(() => assertSafeExtraArgs(claude, { ...defaultProviderSettings(), extraArgs: ['--permission-mode', 'bypassPermissions'] }));
  });
});

describe('process execution', () => {
  it('kills processes that exceed the timeout', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpDir(), timeoutMs: 200, killProcessGroup: true });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });

  it('caps captured output and keeps the tail', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("a".repeat(5000) + "END")'], { cwd: tmpDir(), maxOutputBytes: 100 });
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 100);
    assert.ok(result.stdout.endsWith('END'));
  });

  it('reports spawn failures without throwing', async () => {
    const result = await runProcess('/nonexistent/binary', [], { cwd: tmpDir() });
    assert.ok(result.error);
  });

  it('passes arguments without shell interpolation', async () => {
    const payload = '$(touch pwned); `id`; "quoted" && echo hi';
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload], { cwd: tmpDir() });
    assert.equal(result.stdout, payload);
  });

  it('lists names of secret-looking env vars, never values', () => {
    assert.deepEqual(secretEnvNames({ GH_TOKEN: 'x', PATH: '/bin', MY_API_KEY: 'y', HOME: '/h' }), ['GH_TOKEN', 'MY_API_KEY']);
  });
});
