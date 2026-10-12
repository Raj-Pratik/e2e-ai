import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Approximate cap, in characters, kept per stream (the tail is preserved). */
  maxOutputBytes?: number;
  input?: string;
  signal?: AbortSignal;
  /** Run in its own process group so timeouts also stop grandchildren (POSIX only). */
  killProcessGroup?: boolean;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  interactive?: boolean;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  error?: Error;
}

const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

export function hasInteractiveTerminal(): boolean {
  try {
    const fd = fs.openSync(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
      this.truncated = true;
    }
    if (this.size > this.limit) {
      const only = this.chunks[0]!;
      this.chunks[0] = only.slice(only.length - this.limit);
      this.size = this.limit;
      this.truncated = true;
    }
  }

  toString(): string {
    return this.chunks.join('');
  }
}

export function runProcess(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const stdout = new TailBuffer(limit);
    const stderr = new TailBuffer(limit);
    const useGroup = Boolean(options.killProcessGroup) && process.platform !== 'win32';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let interactiveFd: number | undefined;

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (interactiveFd !== undefined) {
        try {
          fs.closeSync(interactiveFd);
        } catch {
          // The child may already have closed the descriptor.
        }
      }
      const result: RunResult = {
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        aborted,
        truncated: stdout.truncated || stderr.truncated,
      };
      if (error) result.error = error;
      resolve(result);
    };

    const sendSignal = (sig: NodeJS.Signals): void => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (useGroup && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    };

    function terminate(): void {
      sendSignal('SIGTERM');
      killTimer = setTimeout(() => sendSignal('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }

    try {
      if (options.interactive) {
        interactiveFd = fs.openSync(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r');
      }
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: useGroup,
        stdio: [options.interactive ? interactiveFd! : options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(null, null, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout.push(chunk);
      options.onOutput?.(chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr.push(chunk);
      options.onOutput?.(chunk, 'stderr');
    });
    if (options.interactive) {
      child.stdout?.on('data', (chunk: string) => process.stdout.write(chunk));
      child.stderr?.on('data', (chunk: string) => process.stderr.write(chunk));
    }
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));

    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
  });
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a command name against PATH without invoking a shell. */
export function resolveCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!command) return null;
  const isWin = process.platform === 'win32';
  const exts = isWin ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const candidates = (base: string): string[] => (isWin && path.extname(base) ? [base] : exts.map((ext) => base + ext));

  if (command.includes('/') || command.includes('\\')) {
    return candidates(path.resolve(cwd, command)).find(isExecutableFile) ?? null;
  }
  const searchPath = env.PATH ?? env.Path ?? '';
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const found = candidates(path.join(dir, command)).find(isExecutableFile);
    if (found) return found;
  }
  return null;
}
