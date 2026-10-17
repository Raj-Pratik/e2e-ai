import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  /** Polled while the child runs; when it returns true the child is stopped and the run counts as completed. */
  stopWhen?: () => boolean;
  stopPollMs?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** True when `stopWhen` signalled completion and the child was closed by us. */
  completed: boolean;
  truncated: boolean;
  error?: Error;
}

const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

/**
 * Path of the user's terminal for an interactive child. On POSIX this resolves `/dev/tty` to the
 * real device (e.g. `/dev/ttys003`): Bun-based CLIs such as Claude Code cannot watch a `/dev/tty`
 * descriptor on macOS (kqueue returns EINVAL) and crash at startup.
 */
export function interactiveTerminalPath(): string {
  if (process.platform === 'win32') return 'CONIN$';
  // `tty` with a /dev/tty descriptor just echoes "/dev/tty" on macOS; ps reports the real device.
  const name = spawnSync('ps', ['-o', 'tty=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout?.trim();
  if (!name || !/^[\w/]+$/.test(name) || name.startsWith('?')) return '/dev/tty';
  const device = `/dev/${name}`;
  try {
    fs.closeSync(fs.openSync(device, 'r'));
    return device;
  } catch {
    return '/dev/tty';
  }
}

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
    let completed = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let poller: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let interactiveFd: number | undefined;
    let interactiveOutputFd: number | undefined;

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (interactiveFd !== undefined && (completed || timedOut || aborted) && process.platform !== 'win32') {
        // A full-screen CLI stopped by a signal may leave the terminal in raw mode.
        spawnSync('stty', ['sane'], { stdio: [interactiveFd, 'ignore', 'ignore'] });
      }
      if (interactiveFd !== undefined) {
        try {
          if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
            throw new Error('Windows .cmd/.bat provider shims are unsupported. Configure a native .exe coding CLI or an explicit interpreter executable.');
          }
          fs.closeSync(interactiveFd);
        } catch {
          // The child may already have closed the descriptor.
        }
      }
      if (interactiveOutputFd !== undefined) {
        try {
          fs.closeSync(interactiveOutputFd);
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
        completed,
        truncated: stdout.truncated || stderr.truncated,
      };
      if (error) result.error = error;
      resolve(result);
    };

    const sendSignal = (sig: NodeJS.Signals): void => {
      if (!child) return;
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      }
      try {
        if (useGroup && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    };

    function terminate(): void {
      if (killTimer) return;
      sendSignal('SIGTERM');
      killTimer = setTimeout(() => sendSignal('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }

    try {
      if (options.interactive) {
        const terminal = interactiveTerminalPath();
        interactiveFd = fs.openSync(terminal, 'r');
        interactiveOutputFd = fs.openSync(process.platform === 'win32' ? 'CONOUT$' : terminal, 'w');
      }
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: useGroup,
        stdio: [
          options.interactive ? interactiveFd! : options.input === undefined ? 'ignore' : 'pipe',
          options.interactive ? interactiveOutputFd! : 'pipe',
          options.interactive ? interactiveOutputFd! : 'pipe',
        ],
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
    if (options.stopWhen) {
      const stopWhen = options.stopWhen;
      poller = setInterval(() => {
        if (completed || timedOut || aborted) return;
        let done = false;
        try {
          done = stopWhen();
        } catch {
          done = false;
        }
        if (done) {
          completed = true;
          terminate();
        }
      }, options.stopPollMs ?? 1000);
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
