import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeOutgoing } from './changes.js';
import { CONFIG_FILE, defaultConfig, getConfigValue, loadConfig, parseConfigValue, setConfigValue, starterConfig, stateDirPath, writeConfig, } from './config.js';
import { AiE2eError, errorMessage } from './errors.js';
import { findRepoRoot, tryGit } from './git.js';
import { runPrePushHook } from './hook.js';
import { ensureGitignored, installHook, uninstallHook } from './hookInstall.js';
import { isValidJobId, JobStore } from './jobs.js';
import { CLI_PATH, startJob } from './launcher.js';
import { createLogger } from './log.js';
import { detectPlaywright } from './playwright.js';
import { resolveCommand, runProcess } from './proc.js';
import { detectProvider, getProvider, listProviders } from './providers/index.js';
import { runJob } from './worker.js';
export class UsageError extends AiE2eError {
}
export const HELP = `ai-e2e — optional AI-generated Playwright E2E tests for outgoing Git changes

Usage: ai-e2e <command> [options]

Commands:
  init [--no-hook] [--force]          Create .ai-e2e.json, ignore runtime state, install the pre-push hook
  generate [--base <rev>] [--head <rev>] [--provider <id>] [--foreground] [--force]
                                      Generate tests for base..head (default: upstream..HEAD)
  status [<job-id>] [--json] [--limit <n>]
                                      Show recent or specific generation jobs
  logs [<job-id>] [--tail <n>]        Print a job log (default: latest job)
  config [show|get <key>|set <key> <value>|validate|path]
                                      Display or update configuration
  providers [--json]                  List AI providers and whether they are available
  playwright-init [--yes]             Explain (or, with --yes, run) Playwright initialisation
  uninstall                           Remove the ai-e2e block from the pre-push hook
  help                                Show this help

Environment:
  AI_E2E_SKIP=1          Skip the hook entirely for one push
  AI_E2E_ASSUME=yes|no   Answer the push prompt non-interactively (default: ask; no terminal = no)
`;
function parse(args, options) {
    try {
        const parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
        return { values: parsed.values, positionals: parsed.positionals };
    }
    catch (error) {
        throw new UsageError(errorMessage(error));
    }
}
function positiveInt(value, name, fallback) {
    if (value === undefined)
        return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0)
        throw new UsageError(`--${name} must be a positive integer.`);
    return n;
}
function version() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
        return pkg.version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
async function context(io) {
    const root = await findRepoRoot(io.cwd);
    const loaded = loadConfig(root);
    return { root, loaded, store: new JobStore(stateDirPath(root, loaded.config)) };
}
async function cmdInit(args, io) {
    const { values } = parse(args, { 'no-hook': { type: 'boolean' }, force: { type: 'boolean' } });
    const root = await findRepoRoot(io.cwd);
    const configFile = path.join(root, CONFIG_FILE);
    if (fs.existsSync(configFile)) {
        io.out(`Config: ${CONFIG_FILE} exists, keeping it.\n`);
    }
    else {
        writeConfig(configFile, starterConfig());
        io.out(`Config: created ${CONFIG_FILE} (commit it to share settings).\n`);
    }
    const { config } = loadConfig(root);
    const stateDir = stateDirPath(root, config);
    const ignored = await ensureGitignored(root, stateDir);
    io.out({
        added: `Ignore: added ${path.relative(root, stateDir)}/ to .gitignore.\n`,
        'already-ignored': `Ignore: ${path.relative(root, stateDir)}/ is already ignored.\n`,
        'outside-repo': `Ignore: state directory ${stateDir} is outside the repository.\n`,
    }[ignored]);
    if (values['no-hook']) {
        io.out('Hook: skipped (--no-hook).\n');
    }
    else {
        const hook = await installHook(root, CLI_PATH, path.join(stateDir, 'backups'), Boolean(values.force));
        const rel = path.relative(root, hook.file);
        if (hook.action === 'blocked') {
            io.out(`Hook: not modified — ${hook.reason}.\n` +
                `  Add this to your hook manager's pre-push command (stdin must be forwarded):\n` +
                `    node ${JSON.stringify(path.relative(root, CLI_PATH) || CLI_PATH)} hook pre-push "$1" "$2"\n` +
                `  Or re-run with --force to insert the block into ${rel} anyway.\n`);
        }
        else {
            const verb = { created: 'created', inserted: 'added block to existing', updated: 'updated block in', unchanged: 'already installed in' }[hook.action];
            io.out(`Hook: ${verb} ${rel}${hook.manager === 'husky' ? ' (husky)' : ''}.\n`);
            if (hook.backup)
                io.out(`  Backup of the previous hook: ${path.relative(root, hook.backup)}\n`);
            if (hook.tracked && hook.action !== 'unchanged')
                io.out(`  Note: ${rel} is tracked by Git; review and commit the change deliberately.\n`);
        }
    }
    const setup = await detectPlaywright(root, config);
    io.out(setup.found
        ? `Playwright: config ${setup.configPath ?? '(none)'}, tests in ${setup.testDir}, new tests go to ${setup.outputDir}.\n`
        : 'Playwright: not detected. Run `ai-e2e playwright-init` for setup guidance; generation will be skipped until then.\n');
    const provider = getProvider(config.provider);
    const availability = await detectProvider(provider, config.providers[provider.id] ?? config.providers.copilot, root);
    io.out(`Provider: ${provider.displayName} — ${availability.available ? `available (${availability.version ?? 'unknown version'})` : availability.reason}\n`);
    io.out('Privacy: when you accept the prompt, outgoing diffs and related test files are sent to the selected AI provider.\n');
    return 0;
}
async function resolveCommit(root, rev) {
    const sha = await tryGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
    if (!sha?.trim())
        throw new UsageError(`Unknown revision "${rev}".`);
    return sha.trim();
}
async function defaultBase(root, head) {
    const upstream = await tryGit(root, ['rev-parse', '--verify', '--quiet', '@{upstream}']);
    if (upstream?.trim())
        return upstream.trim();
    for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master']) {
        const base = await tryGit(root, ['merge-base', head, candidate]);
        if (base?.trim())
            return base.trim();
    }
    throw new UsageError('Could not determine a base revision (no upstream or origin/HEAD). Pass --base <rev>.');
}
function describeJob(job) {
    const lines = [
        `Job ${job.id}`,
        `  status:    ${job.status}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ''}`,
        `  source:    ${job.source}${job.remote ? ` → ${job.remote}` : ''}`,
        `  provider:  ${job.provider}`,
        `  created:   ${job.createdAt}`,
    ];
    if (job.startedAt)
        lines.push(`  started:   ${job.startedAt}`);
    if (job.finishedAt)
        lines.push(`  finished:  ${job.finishedAt}`);
    if (job.pid)
        lines.push(`  pid:       ${job.pid}`);
    if (job.error)
        lines.push(`  error:     ${job.error}`);
    if (job.generatedFiles.length)
        lines.push('  generated:', ...job.generatedFiles.map((f) => `    - ${f}`));
    if (job.proposedPatches.length)
        lines.push('  proposed patches:', ...job.proposedPatches.map((f) => `    - ${f}`));
    if (job.warnings.length)
        lines.push('  warnings:', ...job.warnings.map((w) => `    - ${w}`));
    if (job.testRun)
        lines.push(`  test run:  ${job.testRun.passed ? 'passed' : 'failed'}${job.testRun.timedOut ? ' (timed out)' : ''}`);
    if (job.summary)
        lines.push('  summary:', ...job.summary.split('\n').map((l) => `    ${l}`));
    return `${lines.join('\n')}\n`;
}
async function cmdGenerate(args, io) {
    const { values } = parse(args, {
        base: { type: 'string' },
        head: { type: 'string' },
        provider: { type: 'string' },
        foreground: { type: 'boolean' },
        force: { type: 'boolean' },
    });
    const { root, store, loaded } = await context(io);
    const { config } = loaded;
    const providerId = typeof values.provider === 'string' ? values.provider : config.provider;
    getProvider(providerId);
    const head = await resolveCommit(root, typeof values.head === 'string' ? values.head : 'HEAD');
    const base = typeof values.base === 'string' ? await resolveCommit(root, values.base) : await defaultBase(root, head);
    if (base === head) {
        io.out('Nothing to generate: base and head are the same commit.\n');
        return 0;
    }
    const branch = (await tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || 'HEAD';
    const refs = [{ localRef: `refs/heads/${branch}`, localSha: head, remoteRef: `refs/heads/${branch}`, remoteSha: base }];
    const changes = await analyzeOutgoing(root, null, refs, config.context, { withDiffs: false });
    if (!changes.files.length) {
        io.out('Nothing to generate: no analyzable changes between base and head.\n');
        return 0;
    }
    const result = await startJob({
        repoRoot: root,
        config,
        store,
        refs,
        remote: null,
        fingerprint: changes.fingerprint,
        source: 'manual',
        provider: providerId,
        force: Boolean(values.force),
        background: !values.foreground,
    });
    switch (result.kind) {
        case 'duplicate':
            io.out(`A job for these changes already exists (${result.existing.id}, ${result.existing.status}). Use --force to run again.\n`);
            return 0;
        case 'launch-failed':
            io.err(`${result.error}\n`);
            return 1;
        case 'started':
            io.out(`Started background job ${result.job.id} (pid ${result.pid}).\nFollow with: ai-e2e logs ${result.job.id}\n`);
            return 0;
        case 'created': {
            const logFile = store.logFile(result.job.id);
            const log = createLogger((text) => {
                io.out(text);
                fs.appendFileSync(logFile, text);
            });
            const job = await runJob({ repoRoot: root, jobId: result.job.id, log });
            io.out(describeJob(job));
            return job.status === 'failed' ? 1 : 0;
        }
    }
}
async function cmdStatus(args, io) {
    const { values, positionals } = parse(args, { json: { type: 'boolean' }, limit: { type: 'string' } });
    const { store } = await context(io);
    const id = positionals[0];
    if (id) {
        if (!isValidJobId(id))
            throw new UsageError(`Invalid job id "${id}".`);
        const job = store.read(id);
        if (!job)
            throw new AiE2eError(`Job ${id} not found.`);
        const fresh = store.refresh(job);
        io.out(values.json ? `${JSON.stringify(fresh, null, 2)}\n` : describeJob(fresh));
        return 0;
    }
    const jobs = store.list().slice(0, positiveInt(values.limit, 'limit', 10));
    if (values.json) {
        io.out(`${JSON.stringify(jobs, null, 2)}\n`);
        return 0;
    }
    if (!jobs.length) {
        io.out('No jobs yet.\n');
        return 0;
    }
    io.out(`${'JOB'.padEnd(24)}${'STATUS'.padEnd(11)}${'SOURCE'.padEnd(10)}${'PROVIDER'.padEnd(10)}FILES  CREATED\n`);
    for (const job of jobs) {
        io.out(`${job.id.padEnd(24)}${job.status.padEnd(11)}${job.source.padEnd(10)}${job.provider.padEnd(10)}${String(job.generatedFiles.length).padEnd(7)}${job.createdAt}\n`);
    }
    return 0;
}
async function cmdLogs(args, io) {
    const { values, positionals } = parse(args, { tail: { type: 'string' } });
    const { store } = await context(io);
    const id = positionals[0];
    if (id && !isValidJobId(id))
        throw new UsageError(`Invalid job id "${id}".`);
    const job = id ? store.read(id) : store.latest();
    if (!job)
        throw new AiE2eError(id ? `Job ${id} not found.` : 'No jobs yet.');
    const file = store.logFile(job.id);
    if (!fs.existsSync(file)) {
        io.out(`No log output for job ${job.id} yet.\n`);
        return 0;
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const tail = positiveInt(values.tail, 'tail', 200);
    io.out(`==> ${path.relative(io.cwd, file)} (${job.status}) <==\n${lines.slice(-tail - 1).join('\n')}`);
    return 0;
}
async function cmdConfig(args, io) {
    const { positionals } = parse(args, {});
    const [action = 'show', key, value] = positionals;
    const root = await findRepoRoot(io.cwd);
    if (action === 'path') {
        io.out(`${path.join(root, CONFIG_FILE)}\n`);
        return 0;
    }
    const loaded = loadConfig(root);
    switch (action) {
        case 'show':
            io.out(`${JSON.stringify(loaded.config, null, 2)}\n`);
            return 0;
        case 'validate':
            io.out(loaded.exists ? `${CONFIG_FILE} is valid.\n` : `No ${CONFIG_FILE}; defaults apply.\n`);
            return 0;
        case 'get':
            if (!key)
                throw new UsageError('Usage: ai-e2e config get <key>');
            io.out(`${JSON.stringify(getConfigValue(loaded.config, key), null, 2)}\n`);
            return 0;
        case 'set': {
            if (!key || value === undefined)
                throw new UsageError('Usage: ai-e2e config set <key> <json-or-string-value>');
            const next = setConfigValue(loaded.raw, key, parseConfigValue(value));
            writeConfig(loaded.path, next);
            io.out(`Set ${key} in ${CONFIG_FILE}.\n`);
            return 0;
        }
        default:
            throw new UsageError(`Unknown config action "${action}". Use show, get, set, validate or path.`);
    }
}
async function cmdProviders(args, io) {
    const { values } = parse(args, { json: { type: 'boolean' } });
    const root = await findRepoRoot(io.cwd).catch(() => io.cwd);
    let config;
    try {
        config = loadConfig(root).config;
    }
    catch (error) {
        io.err(`Warning: ${errorMessage(error)} Using defaults.\n`);
        config = defaultConfig();
    }
    const rows = await Promise.all(listProviders().map(async (p) => {
        const settings = config.providers[p.id] ?? config.providers.copilot;
        const availability = await detectProvider(p, settings, root);
        return { id: p.id, name: p.displayName, selected: p.id === config.provider, supportsMcp: p.supportsMcp, verification: p.verification, ...availability };
    }));
    if (values.json) {
        io.out(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
    }
    for (const row of rows) {
        const state = row.available ? `available — ${row.version ?? 'unknown version'}` : `unavailable — ${row.reason}`;
        io.out(`${row.selected ? '*' : ' '} ${row.id.padEnd(9)} ${row.name}: ${state}\n    ${row.verification}\n`);
    }
    io.out(`\nSelected provider: ${config.provider}. Change with: ai-e2e config set provider <id>\n`);
    return 0;
}
async function cmdPlaywrightInit(args, io) {
    const { values } = parse(args, { yes: { type: 'boolean' } });
    const root = await findRepoRoot(io.cwd);
    const { config } = loadConfig(root);
    const setup = await detectPlaywright(root, config);
    if (setup.found) {
        io.out(`Playwright is already set up (${setup.configPath ?? setup.dependency}). Nothing to do.\n`);
        return 0;
    }
    const command = ['npm', 'init', 'playwright@latest'];
    if (!values.yes) {
        io.out('No Playwright setup found. ai-e2e never installs Playwright implicitly.\n' +
            `To initialise it, run \`${command.join(' ')}\` yourself, or re-run \`ai-e2e playwright-init --yes\` to run it now.\n` +
            'This modifies package.json, adds dependencies and creates a config file.\n');
        return 0;
    }
    const npm = resolveCommand('npm', root);
    if (!npm)
        throw new AiE2eError('npm was not found on PATH.');
    io.out(`Running: ${command.join(' ')}\n`);
    const result = await runProcess(npm, command.slice(1), { cwd: root, onOutput: (chunk) => io.out(chunk) });
    return result.exitCode === 0 ? 0 : 1;
}
async function cmdUninstall(args, io) {
    parse(args, {});
    const root = await findRepoRoot(io.cwd);
    const result = await uninstallHook(root);
    const rel = path.relative(root, result.file);
    io.out({
        'removed-block': `Removed the ai-e2e block from ${rel}; the rest of the hook is unchanged.\n`,
        'deleted-file': `Deleted ${rel} (it only contained the ai-e2e block).\n`,
        'not-installed': `No ai-e2e block found in ${rel}.\n`,
    }[result.action]);
    io.out(`${CONFIG_FILE} and the state directory were left in place; delete them manually if no longer needed.\n`);
    return 0;
}
async function cmdHook(args, io) {
    const [name, remote] = args;
    if (name !== 'pre-push') {
        io.err(`ai-e2e: unsupported hook "${name ?? ''}"; ignoring.\n`);
        return 0;
    }
    let stdin = '';
    try {
        stdin = io.readStdin();
    }
    catch {
        // treated as nothing to push
    }
    await runPrePushHook({ cwd: io.cwd, remote: remote ?? null, stdin, env: io.env, write: io.err });
    return 0;
}
async function cmdWorker(args, io) {
    const { values } = parse(args, { job: { type: 'string' } });
    const jobId = values.job;
    if (typeof jobId !== 'string' || !isValidJobId(jobId))
        throw new UsageError('worker requires --job <id>.');
    const root = await findRepoRoot(io.cwd);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
        const job = await runJob({ repoRoot: root, jobId, signal: controller.signal });
        return job.status === 'failed' ? 1 : 0;
    }
    finally {
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
    }
}
const COMMANDS = {
    init: cmdInit,
    generate: cmdGenerate,
    status: cmdStatus,
    logs: cmdLogs,
    config: cmdConfig,
    providers: cmdProviders,
    'playwright-init': cmdPlaywrightInit,
    uninstall: cmdUninstall,
    hook: cmdHook,
    worker: cmdWorker,
};
export async function run(argv, io) {
    const [command, ...rest] = argv;
    if (!command || command === 'help' || command === '--help' || command === '-h') {
        io.out(HELP);
        return 0;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
        io.out(`${version()}\n`);
        return 0;
    }
    const handler = COMMANDS[command];
    if (!handler) {
        io.err(`Unknown command "${command}".\n\n${HELP}`);
        return 2;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
        io.out(HELP);
        return 0;
    }
    try {
        return await handler(rest, io);
    }
    catch (error) {
        if (command === 'hook') {
            io.err(`ai-e2e: skipped (${errorMessage(error)}). Push continues.\n`);
            return 0;
        }
        io.err(`ai-e2e: ${errorMessage(error)}\n`);
        return error instanceof UsageError ? 2 : 1;
    }
}
