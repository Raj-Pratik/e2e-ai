import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliIO } from '../src/commands.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_PROVIDER = path.resolve(here, '../../test/fixtures/fake-provider.mjs');
export const CLI = path.resolve(here, '../src/cli.js');
fs.chmodSync(FAKE_PROVIDER, 0o755);

// Code under test reads process.env directly; keep it away from the developer's Git config.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
for (const key of Object.keys(process.env)) if (key.startsWith('AI_E2E_') || key.startsWith('FAKE_')) delete process.env[key];

export function tmpDir(prefix = 'ai-e2e-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Environment isolated from the developer's global Git config and from hook variables. */
export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_') || key.startsWith('AI_E2E_') || key.startsWith('FAKE_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: testEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function commit(root: string, files: Record<string, string>, message: string): string {
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}

export interface TestRepo {
  root: string;
  remote: string;
  base: string;
}

export function createRepo(options: { playwright?: boolean } = {}): TestRepo {
  const base = tmpDir();
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'Dev');
  git(root, 'config', 'commit.gpgsign', 'false');
  const files: Record<string, string> = {
    'src/app.ts': 'export const app = () => "home";\n',
    'README.md': '# demo\n',
  };
  if (options.playwright !== false) {
    files['package.json'] = JSON.stringify(
      { name: 'demo', private: true, scripts: { 'test:e2e': 'playwright test' }, devDependencies: { '@playwright/test': '^1.48.0' } },
      null,
      2,
    );
    files['playwright.config.ts'] = "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './e2e' });\n";
    files['e2e/home.spec.ts'] = "import { test } from '@playwright/test';\ntest('home', async () => {});\n";
    files['e2e/fixtures/auth.ts'] = 'export const login = async () => {};\n';
  }
  commit(root, files, 'initial');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { root, remote, base };
}

export function writeConfig(root: string, config: Record<string, unknown>): void {
  write(root, '.ai-e2e.json', JSON.stringify(config, null, 2));
}

export function fakeProviderConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'copilot',
    providers: { copilot: { command: FAKE_PROVIDER } },
    prompt: { timeoutSeconds: 2 },
    generation: { interactive: false, commitGeneratedTests: false },
    ...extra,
  };
}

export interface CapturedIO extends CliIO {
  stdout: () => string;
  stderr: () => string;
}

export function captureIO(cwd: string, env: NodeJS.ProcessEnv = testEnv(), stdin = ''): CapturedIO {
  let out = '';
  let err = '';
  return {
    cwd,
    env,
    readStdin: () => stdin,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 20_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Runs detached (no controlling terminal), like a push from an IDE or CI. */
export function runDetached(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ProcResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, durationMs: Date.now() - start }));
  });
}
