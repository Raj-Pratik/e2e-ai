#!/usr/bin/env node
import fs from 'node:fs';
import { run } from './commands.js';

const argv = process.argv.slice(2);
const isHook = argv[0] === 'hook';

if (isHook) {
  // The push must never depend on this process: swallow anything unexpected and exit 0.
  process.on('uncaughtException', (error) => {
    process.stderr.write(`ai-e2e: skipped (${error.message}). Push continues.\n`);
    process.exit(0);
  });
  process.on('unhandledRejection', () => process.exit(0));
}

const readStdin = (): string => (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));

run(argv, { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), cwd: process.cwd(), env: process.env, readStdin }).then(
  (code) => {
    process.exitCode = isHook ? 0 : code;
    // Guard against a stray handle keeping git waiting; unref'd so it never delays a clean exit.
    if (isHook) setTimeout(() => process.exit(0), 2000).unref();
  },
  (error: unknown) => {
    process.stderr.write(`ai-e2e: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = isHook ? 0 : 1;
  },
);
