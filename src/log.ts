import { redact } from './redact.js';

export type Logger = (message: string) => void;

export function createLogger(write: (text: string) => void = (t) => process.stdout.write(t)): Logger {
  return (message: string) => {
    const stamp = new Date().toISOString();
    for (const line of redact(message).split('\n')) write(`[${stamp}] ${line}\n`);
  };
}
