import path from 'node:path';
import { AiE2eError } from './errors.js';
import { runProcess } from './proc.js';

export class GitError extends AiE2eError {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const GIT_MAX_OUTPUT = 64 * 1024 * 1024;

export async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await runProcess('git', args, { cwd, input, maxOutputBytes: GIT_MAX_OUTPUT });
  if (result.error) throw new AiE2eError(`git could not be executed: ${result.error.message}`);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    throw new GitError(`git ${args[0] ?? ''} failed: ${detail}`, result.exitCode);
  }
  return result.stdout;
}

export async function tryGit(cwd: string, args: string[], input?: string): Promise<string | null> {
  try {
    return await git(cwd, args, input);
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

export async function findRepoRoot(cwd: string): Promise<string> {
  const out = await tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!out?.trim()) throw new AiE2eError('Not inside a Git working tree.');
  return path.resolve(out.trim());
}

export async function listFiles(root: string, dirs: string[]): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...dirs]);
  return [...new Set(out.split('\0').filter(Boolean))];
}

/** Paths reported by `git status`, keyed by path with the two-letter status code. */
export async function statusSnapshot(root: string): Promise<Map<string, string>> {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = new Map<string, string>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    entries.set(entry.slice(3), code);
    if (code.includes('R') || code.includes('C')) i++;
  }
  return entries;
}
