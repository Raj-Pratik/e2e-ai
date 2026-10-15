import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiE2eError } from './errors.js';
import { listFiles } from './git.js';
import { isTestFile, testCommand } from './playwright.js';
import { runProcess } from './proc.js';
import { redact } from './redact.js';
export const CLI_FILE = fileURLToPath(new URL('./cli.js', import.meta.url));
/** Hashes of the test directories taken before the coding CLI started. */
export const BASELINE_FILE = 'baseline.json';
/** Written by `pushpilot verify` after a passing run; the worker closes the session when it appears. */
export const VERIFIED_FILE = 'verified.json';
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
export function hashFile(abs) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
    catch {
        return null;
    }
}
export async function writeBaseline(root, jobDir, scanDirs) {
    const files = {};
    for (const file of await listFiles(root, scanDirs)) {
        const hash = hashFile(path.join(root, file));
        if (hash)
            files[file] = hash;
    }
    const baseline = { scanDirs, files };
    fs.writeFileSync(path.join(jobDir, BASELINE_FILE), JSON.stringify(baseline));
    return baseline;
}
export function readBaseline(jobDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(jobDir, BASELINE_FILE), 'utf8'));
    }
    catch {
        throw new AiE2eError('This job has no test baseline; `verify` only works for a job that is generating tests.');
    }
}
/** New or edited files in the test directories, with their current hashes. */
export async function changedSinceBaseline(root, baseline, newOnly = false) {
    const changed = new Map();
    for (const file of await listFiles(root, baseline.scanDirs)) {
        // With allowModifyExistingTests=false edits to existing files are restored as patches, so they never count.
        if (newOnly && file in baseline.files)
            continue;
        const hash = hashFile(path.join(root, file));
        if (hash && baseline.files[file] !== hash)
            changed.set(file, hash);
    }
    return changed;
}
function resolveImport(from, specifier, known) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    const stripped = base.replace(/\.[cm]?jsx?$/, '');
    for (const candidate of [...RESOLVE_EXTS.map((ext) => base + ext), ...RESOLVE_EXTS.map((ext) => stripped + ext)]) {
        if (known.has(candidate))
            return candidate;
    }
    return null;
}
/**
 * Specs to run: every new or edited spec, plus existing specs that (transitively) import a new or
 * edited helper. Untouched specs that do not depend on changed code are never run.
 */
export function targetSpecs(root, allFiles, changed) {
    const known = new Set(allFiles);
    const affected = new Set(changed);
    const importers = new Map();
    for (const file of allFiles.filter((f) => SOURCE.test(f) && !f.endsWith('.py'))) {
        let source;
        try {
            source = fs.readFileSync(path.join(root, file), 'utf8');
        }
        catch {
            continue;
        }
        for (const match of source.matchAll(IMPORT)) {
            const target = resolveImport(file, match[1], known);
            if (target)
                importers.set(target, [...(importers.get(target) ?? []), file]);
        }
    }
    const queue = [...affected];
    while (queue.length) {
        for (const importer of importers.get(queue.shift()) ?? []) {
            if (!affected.has(importer)) {
                affected.add(importer);
                queue.push(importer);
            }
        }
    }
    return [...affected].filter(isTestFile).sort();
}
/** A sentinel or exit zero (including an all-skipped suite) is not evidence of execution. */
export function evaluateRun(command, result) {
    const output = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
    const passedCount = /\b([1-9]\d*) passed\b/.test(output);
    const skipped = /\b[1-9]\d* (?:skipped|failed|deselected|flaky|did not run)\b/.test(output);
    const passed = result.exitCode === 0 && !result.timedOut && !result.aborted && passedCount && !skipped;
    const failureOutput = passed
        ? undefined
        : redact(`${output}\n${!passedCount ? 'No positive passed-test count found. Configure a text reporter (Playwright list/line or pytest terminal summary).' : ''}`.trim().slice(-12_000));
    return { command, exitCode: result.exitCode, passed, timedOut: result.timedOut, ...(failureOutput ? { failureOutput } : {}) };
}
/** Runs only the new/edited specs. Records a verification when they pass; clears it when they fail. */
export async function runVerify(options) {
    const { root, jobDir, config, setup, write } = options;
    const verifiedFile = path.join(jobDir, VERIFIED_FILE);
    fs.rmSync(verifiedFile, { force: true });
    const baseline = readBaseline(jobDir);
    const changed = await changedSinceBaseline(root, baseline, !config.generation.allowModifyExistingTests);
    const specs = targetSpecs(root, await listFiles(root, baseline.scanDirs), [...changed.keys()]);
    if (!specs.length)
        throw new AiE2eError('No new or edited spec files found in the test directory. Write the approved specs first.');
    const command = testCommand(root, config, setup, specs);
    if (!command)
        throw new AiE2eError('No runnable Playwright command. Configure playwright.testCommand.');
    write(`PushPilot verify: running only the new/edited specs:\n${specs.map((s) => `  - ${s}`).join('\n')}\n$ ${command.join(' ')}\n`);
    options.log?.(`verify: running ${specs.join(', ')}`);
    const result = await runProcess(command[0], command.slice(1), {
        cwd: root,
        ...(config.playwright.testTimeoutSeconds ? { timeoutMs: config.playwright.testTimeoutSeconds * 1000 } : {}),
        maxOutputBytes: config.generation.maxOutputBytes,
        killProcessGroup: true,
        onOutput: (chunk) => write(chunk),
        ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.error)
        write(`\nTest command could not start: ${result.error.message}\n`);
    const testRun = evaluateRun(command, result);
    if (testRun.passed) {
        const record = { status: 'passed', specs, files: Object.fromEntries(changed), testRun, verifiedAt: new Date().toISOString() };
        fs.writeFileSync(verifiedFile, JSON.stringify(record, null, 2));
        write('\nPushPilot verify: PASSED. PushPilot will now close this session, commit the tests and push them.\n');
    }
    else {
        write(`\nPushPilot verify: FAILED (exit ${result.exitCode ?? result.signal}${result.timedOut ? ', timed out' : ''}). ` +
            'Read the failure above, fix the generated specs/helpers, then run the same verify command again.\n');
    }
    options.log?.(`verify: ${testRun.passed ? 'passed' : 'failed'} (${specs.join(', ')})`);
    return testRun;
}
export function readVerification(jobDir) {
    try {
        const record = JSON.parse(fs.readFileSync(path.join(jobDir, VERIFIED_FILE), 'utf8'));
        return record?.status === 'passed' && record.testRun?.passed && record.files && Array.isArray(record.specs) ? record : null;
    }
    catch {
        return null;
    }
}
/** The recorded passing run still describes exactly the current set of new/edited files. */
export async function currentVerification(root, jobDir, newOnly = false) {
    const record = readVerification(jobDir);
    if (!record)
        return { ok: false, reason: 'no passing `verify` run has been recorded' };
    const changed = await changedSinceBaseline(root, readBaseline(jobDir), newOnly);
    const recorded = Object.keys(record.files);
    const drift = [
        ...[...changed].filter(([file, hash]) => record.files[file] !== hash).map(([file]) => file),
        ...recorded.filter((file) => !changed.has(file)),
    ];
    return drift.length ? { ok: false, reason: `files changed after the last passing verify run: ${[...new Set(drift)].join(', ')}` } : { ok: true, record };
}
const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
/** Shell command the agent runs; uses absolute node and CLI paths so version-manager shims cannot break it. */
export function verifyCommandLine(cliPath, jobId) {
    return [process.execPath, cliPath, 'verify', '--job', jobId].map(quote).join(' ');
}
