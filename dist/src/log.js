import { redact } from './redact.js';
export function createLogger(write = (t) => process.stdout.write(t)) {
    return (message) => {
        const stamp = new Date().toISOString();
        for (const line of redact(message).split('\n'))
            write(`[${stamp}] ${line}\n`);
    };
}
