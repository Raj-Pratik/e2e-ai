#!/usr/bin/env node
import fs from 'node:fs';
import { run } from './commands.js';

const argv = process.argv.slice(2);
const isHook = argv[0] === 'hook';

if (isHook) {
  // Hook failures are surfaced so a failed accepted test workflow can block the push.
  process.on('uncaughtException', (error) => {
    process.stderr.write(`PushPilot: failed (${error.message}). Push is blocked.\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', () => process.exit(1));
}

const readStdin = (): string => (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));

run(argv, { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), cwd: process.cwd(), env: process.env, readStdin }).then(
  (code) => {
  process.exitCode = code;
    // Guard against a stray handle keeping git waiting; unref'd so it never delays a clean exit.
    if (isHook) setTimeout(() => process.exit(0), 2000).unref();
  },
  (error: unknown) => {
    process.stderr.write(`PushPilot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = isHook ? 0 : 1;
  },
);
