import fs from 'node:fs';
import readline from 'node:readline';
import tty from 'node:tty';
import type { Readable, Writable } from 'node:stream';

export type Answer = 'yes' | 'no' | 'timeout';

export interface PromptIO {
  input: Readable;
  output: Writable;
  close(): void;
}

export function isAffirmative(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}

/** Resolves on the first line; Enter, EOF, anything but y/yes, or timeout count as "no". */
export function askYesNo(question: string, io: Pick<PromptIO, 'input' | 'output'>, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
    let done = false;
    const finish = (answer: Answer): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      resolve(answer);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    rl.once('line', (line) => finish(isAffirmative(line) ? 'yes' : 'no'));
    rl.once('close', () => finish('no'));
    io.output.write(question);
  });
}

export async function askChoice(
  question: string,
  choices: readonly string[],
  io: Pick<PromptIO, 'input' | 'output'>,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
    let done = false;
    const finish = (choice: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      resolve(choice);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    rl.once('line', (line) => {
      const index = Number.parseInt(line.trim(), 10) - 1;
      finish(Number.isInteger(index) && index >= 0 && index < choices.length ? choices[index]! : null);
    });
    rl.once('close', () => finish(null));
    io.output.write(`${question}\n${choices.map((choice, index) => `  ${index + 1}) ${choice}`).join('\n')}\n> `);
  });
}

/**
 * Opens the controlling terminal directly: in a pre-push hook stdin carries the
 * ref list. Returns null when no interactive terminal is attached.
 */
export function openTerminal(): PromptIO | null {
  const [inPath, outPath] = process.platform === 'win32' ? ['CONIN$', 'CONOUT$'] : ['/dev/tty', '/dev/tty'];
  let inFd: number | undefined;
  let outFd: number | undefined;
  try {
    inFd = fs.openSync(inPath, 'r');
    outFd = fs.openSync(outPath, 'w');
    if (!tty.isatty(inFd)) throw new Error('not a terminal');
    const input = new tty.ReadStream(inFd);
    const output = fs.createWriteStream('', { fd: outFd, autoClose: true });
    return {
      input,
      output,
      close() {
        input.destroy();
        output.end();
      },
    };
  } catch {
    for (const fd of [inFd, outFd]) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
    return null;
  }
}
