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
 * Arrow-key list picker (↑/↓ or j/k, Enter selects, Esc/q/Ctrl-C cancels). Only the listed values can be
 * returned. Without a raw-mode terminal it falls back to a numbered list that re-asks on invalid input.
 */
export function selectOption(question, options, io, initial = 0) {
    const input = io.input;
    if (!input.isTTY || typeof input.setRawMode !== 'function')
        return numberedSelect(question, options, io, initial);
    return new Promise((resolve) => {
        let index = Math.min(Math.max(initial, 0), options.length - 1);
        let drawn = 0;
        const render = () => {
            if (drawn)
                io.output.write(`\x1b[${drawn}A`);
            const lines = options.map((o, i) => `\x1b[2K${i === index ? '\x1b[36m❯ ' : '  '}${o.label}${o.hint ? `\x1b[2m  ${o.hint}\x1b[22m` : ''}${i === index ? '\x1b[39m' : ''}`);
            io.output.write(`${lines.join('\n')}\n`);
            drawn = lines.length;
        };
        const finish = (value) => {
            input.off('data', onData);
            input.setRawMode(false);
            input.pause();
            io.output.write('\x1b[?25h');
            resolve(value);
        };
        const onData = (chunk) => {
            const key = chunk.toString();
            if (key === '\x1b[A' || key === 'k')
                index = (index - 1 + options.length) % options.length;
            else if (key === '\x1b[B' || key === 'j')
                index = (index + 1) % options.length;
            else if (key === '\r' || key === '\n')
                return finish(options[index].value);
            else if (key === '\x03' || key === '\x1b' || key === 'q')
                return finish(null);
            else if (/^[1-9]$/.test(key) && Number(key) <= options.length)
                index = Number(key) - 1;
            else
                return;
            render();
        };
        io.output.write(`${question} \x1b[2m(↑/↓ to move, Enter to select)\x1b[22m\n\x1b[?25l`);
        render();
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
    });
}
function numberedSelect(question, options, io, initial) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
        let done = false;
        const finish = (value) => {
            if (done)
                return;
            done = true;
            rl.close();
            resolve(value);
        };
        const ask = () => { io.output.write(`Choose 1-${options.length} [${initial + 1}]: `); };
        rl.on('line', (line) => {
            const text = line.trim();
            if (!text)
                return finish(options[initial].value);
            const n = Number(text);
            if (Number.isInteger(n) && n >= 1 && n <= options.length)
                return finish(options[n - 1].value);
            io.output.write(`Please pick one of the listed numbers.\n`);
            ask();
        });
        rl.once('close', () => finish(null));
        io.output.write(`${question}\n${options.map((o, i) => `  ${i + 1}) ${o.label}${o.hint ? `  (${o.hint})` : ''}`).join('\n')}\n`);
        ask();
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
