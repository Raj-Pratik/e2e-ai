import fs from 'node:fs';
import readline from 'node:readline';
import tty from 'node:tty';
export function isAffirmative(answer) {
    return /^\s*y(es)?\s*$/i.test(answer);
}
/** Resolves on the first line; Enter, EOF, anything but y/yes, or timeout count as "no". */
export function askYesNo(question, io, timeoutMs) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
        let done = false;
        const finish = (answer) => {
            if (done)
                return;
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
export async function askChoice(question, choices, io, timeoutMs) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
        let done = false;
        const finish = (choice) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            rl.close();
            resolve(choice);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        rl.once('line', (line) => {
            const index = Number.parseInt(line.trim(), 10) - 1;
            finish(Number.isInteger(index) && index >= 0 && index < choices.length ? choices[index] : null);
        });
        rl.once('close', () => finish(null));
        io.output.write(`${question}\n${choices.map((choice, index) => `  ${index + 1}) ${choice}`).join('\n')}\n> `);
    });
}
/**
 * Opens the controlling terminal directly: in a pre-push hook stdin carries the
 * ref list. Returns null when no interactive terminal is attached.
 */
export function openTerminal() {
    const [inPath, outPath] = process.platform === 'win32' ? ['CONIN$', 'CONOUT$'] : ['/dev/tty', '/dev/tty'];
    let inFd;
    let outFd;
    try {
        inFd = fs.openSync(inPath, 'r');
        outFd = fs.openSync(outPath, 'w');
        if (!tty.isatty(inFd))
            throw new Error('not a terminal');
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
    }
    catch {
        for (const fd of [inFd, outFd]) {
            if (fd !== undefined) {
                try {
                    fs.closeSync(fd);
                }
                catch {
                    // already closed
                }
            }
        }
        return null;
    }
}
