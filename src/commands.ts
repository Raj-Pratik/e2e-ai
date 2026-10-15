import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { analyzeOutgoing } from './changes.js';
import { buildPlaywrightSetupTask } from './agentSetupPrompt.js';
import {
  CONFIG_FILE,
  defaultConfig,
  getConfigValue,
  loadConfig,
  parseConfigValue,
  setConfigValue,
  starterConfig,
  stateDirPath,
  writeConfig,
} from './config.js';
import { AiE2eError, errorMessage } from './errors.js';
import { findRepoRoot, tryGit } from './git.js';
import { runPrePushHook } from './hook.js';
import { ensureGitignored, installHook, uninstallHook } from './hookInstall.js';
import { isValidJobId, JobStore, type JobRecord } from './jobs.js';
import { CLI_PATH, startJob } from './launcher.js';
import { createLogger } from './log.js';
import { detectPlaywright } from './playwright.js';
import { openTerminal, selectOption, type SelectOption } from './prompt.js';
import { hasInteractiveTerminal, runProcess } from './proc.js';
import { detectProvider, getProvider, listProviders } from './providers/index.js';
import type { PushRef } from './refs.js';
import { notifyUser } from './notify.js';
import { runVerify } from './verify.js';
import { runJob } from './worker.js';

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  readStdin: () => string;
}

export class UsageError extends AiE2eError {}

export const HELP = `PushPilot — approved, verified Playwright coverage for outgoing Git changes

Usage: pushpilot <command> [options]

Commands:
  init [--no-hook] [--force]          Create .ai-e2e.json, ignore runtime state, install the pre-push hook
  generate [--base <rev>] [--head <rev>] [--provider <id>] [--foreground] [--force]
                                      Generate tests for base..head (default: upstream..HEAD)
  push [git push options and refs]           Normal git push, using the installed pre-push hook
  verify --job <id>                   Run only the job's new/edited specs (used by the coding CLI loop)
  publish-after-push --remote <name> --branch <name> --expected <sha> --commit <sha>
                                      Internal guarded follow-up push for generated tests
  status [<job-id>] [--json] [--limit <n>]
                                      Show recent or specific generation jobs
  logs [<job-id>] [--tail <n>]        Print a job log (default: latest job)
  config [show|get <key>|set <key> <value>|validate|path]
                                      Display or update configuration
  provider [<id>]                     Pick the AI provider from a list (or set it directly)
  providers [--json]                  List AI providers and whether they are available
  playwright-init [--yes]             Explain (or, with --yes, let the coding CLI set up Playwright)
  uninstall                           Remove the PushPilot block from the pre-push hook
  help                                Show this help

Environment:
  AI_E2E_ASSUME=yes|no  Answer the push prompt non-interactively (explicit opt-in; default: ask)

  --help, -h           Help (also supported after every command)
  --version, -v        Print version
`;

const COMMAND_HELP: Record<string, string> = {
  init: 'pushpilot init [--no-hook] [--force]\nSelect provider (default Copilot), preserve config, install hook, and run verified Playwright setup.\n--no-hook: skip hook installation. --force: insert into a managed hook with backup; never overwrite config.',
  generate: 'pushpilot generate [--base REV] [--head REV] [--provider ID] [--foreground] [--force]\n--base: upstream or origin merge-base by default. --head: HEAD by default.\n--provider: copilot or claude. --force: retry duplicate changes.\n--foreground: compatibility flag; jobs always run in this terminal.\nRequires a clean tree and runnable Playwright; plan approval and a passing verify run of the new/edited specs are mandatory.',
  push: 'pushpilot push [git push arguments]\nRuns normal git push. Install the hook with pushpilot init first.\nAll remaining arguments (remote, refs, --force-with-lease, etc.) go to Git.',
  status: 'pushpilot status [JOB] [--json] [--limit N]\nShow one job or recent jobs. --limit defaults to 10; --json emits machine-readable results.',
  logs: 'pushpilot logs [JOB] [--tail N]\nPrint the latest or selected job log. --tail defaults to 200 lines.',
  config: 'pushpilot config [show|get KEY|set KEY VALUE|validate|path]\nDotted keys address settings; VALUE is JSON or a string. Existing .ai-e2e.json is preserved.\nExample: pushpilot config set generation.timeoutSeconds 7200',
  provider: 'pushpilot provider [copilot|claude]\nWithout an argument, pick the provider from a list with the arrow keys and Enter.\nWith an argument, only a listed provider id is accepted.',
  providers: 'pushpilot providers [--json]\nCheck installed Copilot and Claude CLIs, versions, and selected provider.',
  'playwright-init': 'pushpilot playwright-init [--yes]\nWithout --yes, show guidance. --yes launches the main coding CLI to inspect JS/Python,\nconfigure Playwright, and run smoke tests; PushPilot independently reruns actual tests.',
  uninstall: 'pushpilot uninstall\nRemove only the legacy-compatible hook block. Keep configuration, tests, state and unrelated hooks.',
  worker: 'pushpilot worker --job ID\nInternal foreground worker. Requires an existing job; not a normal user command.',
  hook: 'pushpilot hook pre-push REMOTE [URL]\nInternal Git hook entry point. Reads the standard pre-push ref list from stdin.',
  verify: 'pushpilot verify --job ID\nRun only the spec files the coding CLI added or edited for this job (plus specs importing an added/edited helper).\nA passing run is recorded and ends the coding CLI session; PushPilot then commits and pushes the verified files.',
  'publish-after-push': 'pushpilot publish-after-push --remote NAME --branch NAME --expected SHA --commit SHA\nInternal bounded publisher. Waits for the original SHA, then pushes the pinned test commit through normal hooks.',
};

type Options = NonNullable<ParseArgsConfig['options']>;

function parse(args: string[], options: Options): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
    return { values: parsed.values as Record<string, string | boolean | undefined>, positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

function positiveInt(value: string | boolean | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer.`);
  return n;
}

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function context(io: CliIO): Promise<{ root: string; store: JobStore; loaded: ReturnType<typeof loadConfig> }> {
  const root = await findRepoRoot(io.cwd);
  const loaded = loadConfig(root);
  return { root, loaded, store: new JobStore(stateDirPath(root, loaded.config)) };
}

async function cmdInit(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { 'no-hook': { type: 'boolean' }, force: { type: 'boolean' } });
  const root = await findRepoRoot(io.cwd);
  const configFile = path.join(root, CONFIG_FILE);
  if (fs.existsSync(configFile)) {
    io.out(`Config: ${CONFIG_FILE} exists, keeping it.\n`);
  } else {
    const initial = starterConfig();
    const tty = openTerminal();
    if (tty) {
      try {
        const selected = await selectOption('Which AI provider should PushPilot use by default?', await providerOptions(root), tty);
        if (selected) initial.provider = selected;
      } finally {
        tty.close();
      }
    } else {
      io.out('No interactive terminal; defaulting to GitHub Copilot CLI. Run `pushpilot provider` to pick another.\n');
    }
    writeConfig(configFile, initial);
    io.out(`Config: created ${CONFIG_FILE} (commit it to share settings).\n`);
  }
  const { config } = loadConfig(root);
  const stateDir = stateDirPath(root, config);

  const ignored = await ensureGitignored(root, stateDir);
  io.out(
    {
      added: `Ignore: added ${path.relative(root, stateDir)}/ to .gitignore.\n`,
      'already-ignored': `Ignore: ${path.relative(root, stateDir)}/ is already ignored.\n`,
      'outside-repo': `Ignore: state directory ${stateDir} is outside the repository.\n`,
    }[ignored],
  );
  if (values['no-hook']) {
    io.out('Hook: skipped (--no-hook).\n');
  } else {
    const hook = await installHook(root, CLI_PATH, path.join(stateDir, 'backups'), Boolean(values.force));
    const rel = path.relative(root, hook.file);
    if (hook.action === 'blocked') {
      io.out(
        `Hook: not modified — ${hook.reason}.\n` +
          `  Add this to your hook manager's pre-push command (stdin must be forwarded):\n` +
          `    node ${JSON.stringify(path.relative(root, CLI_PATH) || CLI_PATH)} hook pre-push "$1" "$2"\n` +
          `  Or re-run with --force to insert the block into ${rel} anyway.\n`,
      );
    } else {
      const verb = { created: 'created', inserted: 'added block to existing', updated: 'updated block in', unchanged: 'already installed in' }[hook.action];
      io.out(`Hook: ${verb} ${rel}${hook.manager === 'husky' ? ' (husky)' : ''}.\n`);
      if (hook.backup) io.out(`  Backup of the previous hook: ${path.relative(root, hook.backup)}\n`);
      if (hook.tracked && hook.action !== 'unchanged') io.out(`  Note: ${rel} is tracked by Git; review and commit the change deliberately.\n`);
    }
  }

  const setup = await detectPlaywright(root, config);
  io.out(
    setup.found
      ? `Playwright: config ${setup.configPath ?? '(none)'}, tests in ${setup.testDir}, new tests go to ${setup.outputDir}.\n`
      : 'Playwright: not detected. Run `pushpilot playwright-init --yes` to set it up with your coding CLI.\n',
  );
  const provider = getProvider(config.provider);
  const availability = await detectProvider(provider, config.providers[provider.id] ?? config.providers.copilot!, root);
  io.out(`Provider: ${provider.displayName} — ${availability.available ? `available (${availability.version ?? 'unknown version'})` : availability.reason}\n`);
  io.out('Privacy: when you accept the prompt, outgoing diffs and related test files are sent to the selected AI provider.\n');
  io.out('Init complete. Next: run `pushpilot playwright-init --yes` to set up Playwright (optional, separate step).\n');
  return 0;
}

async function resolveCommit(root: string, rev: string): Promise<string> {
  const sha = await tryGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  if (!sha?.trim()) throw new UsageError(`Unknown revision "${rev}".`);
  return sha.trim();
}

async function defaultBase(root: string, head: string): Promise<string> {
  const upstream = await tryGit(root, ['rev-parse', '--verify', '--quiet', '@{upstream}']);
  if (upstream?.trim()) return upstream.trim();
  for (const candidate of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const base = await tryGit(root, ['merge-base', head, candidate]);
    if (base?.trim()) return base.trim();
  }
  throw new UsageError('Could not determine a base revision (no upstream or origin/HEAD). Pass --base <rev>.');
}

function describeJob(job: JobRecord): string {
  const lines = [
    `Job ${job.id}`,
    `  status:    ${job.status}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ''}`,
    `  source:    ${job.source}${job.remote ? ` → ${job.remote}` : ''}`,
    `  provider:  ${job.provider}`,
    `  created:   ${job.createdAt}`,
  ];
  if (job.startedAt) lines.push(`  started:   ${job.startedAt}`);
  if (job.finishedAt) lines.push(`  finished:  ${job.finishedAt}`);
  if (job.pid) lines.push(`  pid:       ${job.pid}`);
  if (job.error) lines.push(`  error:     ${job.error}`);
  if (job.generatedFiles.length) lines.push('  generated:', ...job.generatedFiles.map((f) => `    - ${f}`));
  if (job.proposedPatches.length) lines.push('  proposed patches:', ...job.proposedPatches.map((f) => `    - ${f}`));
  if (job.warnings.length) lines.push('  warnings:', ...job.warnings.map((w) => `    - ${w}`));
  if (job.testRun) lines.push(`  test run:  ${job.testRun.passed ? 'passed' : 'failed'}${job.testRun.timedOut ? ' (timed out)' : ''}`);
  if (job.summary) lines.push('  summary:', ...job.summary.split('\n').map((l) => `    ${l}`));
  return `${lines.join('\n')}\n`;
}

async function cmdGenerate(args: string[], io: CliIO): Promise<number> {
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
  const refs: PushRef[] = [{ localRef: `refs/heads/${branch}`, localSha: head, remoteRef: `refs/heads/${branch}`, remoteSha: base }];
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
    background: false,
  });
  switch (result.kind) {
    case 'duplicate':
      io.out(`A job for these changes already exists (${result.existing.id}, ${result.existing.status}). Use --force to run again.\n`);
      return 0;
    case 'launch-failed':
      io.err(`${result.error}\n`);
      return 1;
    case 'started':
      io.out(`Started background job ${result.job.id} (pid ${result.pid}).\nFollow with: pushpilot logs ${result.job.id}\n`);
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

async function cmdPush(args: string[], io: CliIO): Promise<number> {
  if (!hasInteractiveTerminal()) throw new AiE2eError('pushpilot push requires an interactive terminal for Git authentication and provider interaction.');
  const pushArgs = ['push', ...args];
  io.out(`Running: git ${pushArgs.join(' ')}\n`);
  const result = await runProcess('git', pushArgs, {
    cwd: io.cwd,
    env: io.env,
    interactive: true,
    onOutput: (chunk) => io.out(chunk),
  });
  if (result.error) throw new AiE2eError(`git push could not be executed: ${result.error.message}`);
  if (result.exitCode !== 0) {
    io.err(`git push failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ` (exit code ${result.exitCode})`}.\n`);
    return 1;
  }
  io.out('PushPilot: git push completed through the normal pre-push hook.\n');
  return 0;
}

async function cmdPublishAfterPush(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, {
    remote: { type: 'string' },
    branch: { type: 'string' },
    expected: { type: 'string' },
    commit: { type: 'string' },
    log: { type: 'string' },
  });
  const remote = values.remote;
  const branch = values.branch;
  const expected = values.expected;
  const commit = values.commit;
  if (typeof remote !== 'string' || typeof branch !== 'string' || typeof expected !== 'string' || typeof commit !== 'string' ||
      remote.startsWith('-') || branch.startsWith('-') || !/^[a-f0-9]{40,64}$/.test(expected) || !/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new UsageError('publish-after-push requires --remote, --branch, --expected <sha> and --commit <sha>.');
  }
  const logFile = typeof values.log === 'string' ? values.log : null;
  const root = await findRepoRoot(io.cwd);
  const say = (text: string): void => {
    io.out(text);
    if (logFile) {
      try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${text.trim()}\n`); } catch { /* log is best effort */ }
    }
  };
  const done = (ok: boolean, message: string): number => {
    say(`\nPushPilot: ${message}\n`);
    notifyUser(ok ? 'PushPilot: all done' : 'PushPilot: push needs attention', message, io.env);
    return ok ? 0 : 1;
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  // AI_E2E_SKIP keeps PushPilot's own hook block from prompting again; other pre-push policies still run.
  const env = { ...io.env, GIT_TERMINAL_PROMPT: '0', AI_E2E_SKIP: '1' };
  /** Remote branch SHA, '' when the branch does not exist, null when the remote is unreachable. */
  const remoteHead = async (): Promise<string | null> => {
    const r = await runProcess('git', ['ls-remote', remote, `refs/heads/${branch}`], { cwd: root, timeoutMs: 30_000, env });
    return r.exitCode === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? '') : null;
  };

  // 1. Let the original `git push` finish first. It may succeed, fail (e.g. its connection idled out
  //    during generation) or be cancelled; the pinned commit contains its commits either way.
  const parent = Number(io.env.AI_E2E_PUSH_PID);
  const pushAlive = (): boolean => {
    if (!Number.isInteger(parent) || parent <= 1) return false;
    try { process.kill(parent, 0); return true; } catch { return false; }
  };
  if (Number.isInteger(parent) && parent > 1) {
    while (pushAlive()) await sleep(500);
  } else {
    for (let i = 0; i < 60; i++) {
      const head = await remoteHead();
      if (head === expected || head === commit) break;
      await sleep(2000);
    }
  }

  // 2. Push the pinned commit as a fast-forward from whatever the remote now holds.
  let lastError = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const current = await remoteHead();
    if (current === commit) return done(true, `All done. Verified E2E tests are committed and pushed to ${remote}/${branch} (${commit.slice(0, 12)}).`);
    if (current === null) {
      lastError = `could not reach ${remote}`;
      await sleep(5000);
      continue;
    }
    if (current && !(await tryGit(root, ['merge-base', '--is-ancestor', current, commit]) !== null)) {
      return done(false, `${remote}/${branch} moved to ${current.slice(0, 12)}, which is not part of the test commit ${commit.slice(0, 12)}. ` +
        'Run `git pull --rebase` and `git push` to publish the tests.');
    }
    say(`\nPushPilot: pushing the verified E2E test commit ${commit.slice(0, 12)} to ${remote}/${branch}...\n`);
    const result = await runProcess('git', ['push', `--force-with-lease=refs/heads/${branch}:${current}`, remote, `${commit}:refs/heads/${branch}`], {
      cwd: root,
      env,
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.exitCode === 0) return done(true, `All done. Verified E2E tests are committed and pushed to ${remote}/${branch} (${commit.slice(0, 12)}).`);
    lastError = result.stderr.trim() || `exit code ${result.exitCode}`;
    await sleep(5000);
  }
  return done(false, `could not push the verified test commit ${commit.slice(0, 12)} (${lastError}). It is committed locally; run \`git push\` to publish it.`);
}

async function cmdVerify(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { job: { type: 'string' } });
  const jobId = values.job;
  if (typeof jobId !== 'string' || !isValidJobId(jobId)) throw new UsageError('verify requires --job <id>.');
  const { root, loaded: { config }, store } = await context(io);
  if (!store.read(jobId)) throw new AiE2eError(`Job ${jobId} not found.`);
  const setup = await detectPlaywright(root, config);
  const log = createLogger((text) => fs.appendFileSync(store.logFile(jobId), text));
  const testRun = await runVerify({ root, jobDir: store.jobDir(jobId), config, setup, write: io.out, log });
  return testRun.passed ? 0 : 1;
}

async function cmdStatus(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' }, limit: { type: 'string' } });
  const { store } = await context(io);
  const id = positionals[0];
  if (id) {
    if (!isValidJobId(id)) throw new UsageError(`Invalid job id "${id}".`);
    const job = store.read(id);
    if (!job) throw new AiE2eError(`Job ${id} not found.`);
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
    io.out(
      `${job.id.padEnd(24)}${job.status.padEnd(11)}${job.source.padEnd(10)}${job.provider.padEnd(10)}${String(job.generatedFiles.length).padEnd(7)}${job.createdAt}\n`,
    );
  }
  return 0;
}

async function cmdLogs(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parse(args, { tail: { type: 'string' } });
  const { store } = await context(io);
  const id = positionals[0];
  if (id && !isValidJobId(id)) throw new UsageError(`Invalid job id "${id}".`);
  const job = id ? store.read(id) : store.latest();
  if (!job) throw new AiE2eError(id ? `Job ${id} not found.` : 'No jobs yet.');
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

async function cmdConfig(args: string[], io: CliIO): Promise<number> {
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
      if (!key) throw new UsageError('Usage: pushpilot config get <key>');
      io.out(`${JSON.stringify(getConfigValue(loaded.config, key), null, 2)}\n`);
      return 0;
    case 'set': {
      if (!key || value === undefined) throw new UsageError('Usage: pushpilot config set <key> <json-or-string-value>');
      if (key === 'provider' && !listProviders().some((p) => p.id === value)) {
        throw new UsageError(`Unknown provider "${value}". Choose one of: ${listProviders().map((p) => p.id).join(', ')} (or run \`pushpilot provider\` to pick from a list).`);
      }
      const next = setConfigValue(loaded.raw, key, parseConfigValue(value));
      writeConfig(loaded.path, next);
      io.out(`Set ${key} in ${CONFIG_FILE}.\n`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown config action "${action}". Use show, get, set, validate or path.`);
  }
}

async function providerOptions(root: string, config = defaultConfig()): Promise<SelectOption[]> {
  return Promise.all(listProviders().map(async (p) => {
    const availability = await detectProvider(p, config.providers[p.id] ?? config.providers.copilot!, root);
    return {
      value: p.id,
      label: `${p.id.padEnd(8)} ${p.displayName}`,
      hint: availability.available ? (availability.version ?? 'installed') : 'not installed',
    };
  }));
}

async function cmdProvider(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parse(args, {});
  const root = await findRepoRoot(io.cwd);
  const loaded = loadConfig(root);
  const ids = listProviders().map((p) => p.id);
  let chosen = positionals[0];
  if (chosen === undefined) {
    const tty = openTerminal();
    if (!tty) throw new UsageError(`No interactive terminal. Run: pushpilot provider <${ids.join('|')}>`);
    try {
      const options = await providerOptions(root, loaded.config);
      const current = Math.max(0, ids.indexOf(loaded.config.provider));
      chosen = (await selectOption('Select the AI provider PushPilot should use', options, tty, current)) ?? undefined;
    } finally {
      tty.close();
    }
    if (!chosen) {
      io.out(`Cancelled; provider stays ${loaded.config.provider}.\n`);
      return 0;
    }
  }
  if (!ids.includes(chosen)) throw new UsageError(`Unknown provider "${chosen}". Choose one of: ${ids.join(', ')}.`);
  writeConfig(loaded.path, setConfigValue(loaded.raw, 'provider', chosen));
  io.out(`Provider set to ${chosen} (${getProvider(chosen).displayName}).\n`);
  return 0;
}

async function cmdProviders(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean' } });
  const root = await findRepoRoot(io.cwd).catch(() => io.cwd);
  let config;
  try {
    config = loadConfig(root).config;
  } catch (error) {
    io.err(`Warning: ${errorMessage(error)} Using defaults.\n`);
    config = defaultConfig();
  }
  const rows = await Promise.all(
    listProviders().map(async (p) => {
      const settings = config.providers[p.id] ?? config.providers.copilot!;
      const availability = await detectProvider(p, settings, root);
      return { id: p.id, name: p.displayName, selected: p.id === config.provider, supportsMcp: p.supportsMcp, verification: p.verification, ...availability };
    }),
  );
  if (values.json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  for (const row of rows) {
    const state = row.available ? `available — ${row.version ?? 'unknown version'}` : `unavailable — ${row.reason}`;
    io.out(`${row.selected ? '*' : ' '} ${row.id.padEnd(9)} ${row.name}: ${state}\n    ${row.verification}\n`);
  }
  io.out(`\nSelected provider: ${config.provider}. Change it with: pushpilot provider\n`);
  return 0;
}

async function cmdPlaywrightInit(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { yes: { type: 'boolean' } });
  const root = await findRepoRoot(io.cwd);
  const loaded = loadConfig(root);
  const { config } = loaded;
  const setup = await detectPlaywright(root, config);
  if (setup.found) {
    io.out(`Playwright is already set up (${setup.configPath ?? setup.dependency}).\n`);
    if (!values.yes) {
      io.out('Re-run with --yes to let the selected coding CLI verify and set up Playwright.\n');
      return 0;
    }
  } else {
    if (!values.yes) {
      io.out(
        'No Playwright setup found. Run `pushpilot playwright-init --yes` to inspect the language, configure Playwright, and verify actual tests.\n',
      );
      return 0;
    }
  }

  if (!hasInteractiveTerminal()) throw new AiE2eError('Playwright setup requires an interactive terminal for the selected coding CLI.');
  const provider = getProvider(config.provider);
  const settings = {
    ...(config.providers[provider.id] ?? config.providers.copilot!),
    allowedShellCommands: ['git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'pytest', 'uv'],
  };
  const availability = await detectProvider(provider, settings, root);
  if (!availability.available) throw new AiE2eError(`${provider.displayName} is unavailable: ${availability.reason}`);
  const invocation = provider.buildInvocation({
    repoRoot: root,
    instruction: buildPlaywrightSetupTask(provider.id),
    settings,
    mcp: null,
    secretEnvNames: [],
    interactive: true,
  });
  io.out(`Starting ${provider.displayName} to set up Playwright.\n`);
  const result = await runProcess(availability.resolvedPath ?? invocation.command, invocation.args, {
    cwd: root,
    interactive: true,
    ...(config.generation.timeoutSeconds ? { timeoutMs: config.generation.timeoutSeconds * 1000 } : {}),
    onOutput: (chunk) => io.out(chunk),
  });
  if (result.exitCode !== 0) return 1;
  const afterConfig = loadConfig(root).config;
  const after = await detectPlaywright(root, afterConfig);
  if (!after.found) throw new AiE2eError('The coding CLI completed without creating a detectable Playwright setup.');
  io.out(`Playwright setup detected (${after.configPath ?? after.dependency}). No tests were run by PushPilot; the coding CLI reported its own verification.\n`);
  return 0;
}

async function cmdUninstall(args: string[], io: CliIO): Promise<number> {
  parse(args, {});
  const root = await findRepoRoot(io.cwd);
  const result = await uninstallHook(root);
  const rel = path.relative(root, result.file);
  io.out(
    {
      'removed-block': `Removed the PushPilot block from ${rel}; the rest of the hook is unchanged.\n`,
      'deleted-file': `Deleted ${rel} (it only contained the PushPilot block).\n`,
      'not-installed': `No PushPilot block found in ${rel}.\n`,
    }[result.action],
  );
  io.out(`${CONFIG_FILE} and the state directory were left in place; delete them manually if no longer needed.\n`);
  return 0;
}

async function cmdHook(args: string[], io: CliIO): Promise<number> {
  const [name, remote] = args;
  if (name !== 'pre-push') {
    io.err(`PushPilot: unsupported hook "${name ?? ''}"; ignoring.\n`);
    return 0;
  }
  let stdin = '';
  try {
    stdin = io.readStdin();
  } catch {
    // treated as nothing to push
  }
  const outcome = await runPrePushHook({ cwd: io.cwd, remote: remote ?? null, stdin, env: io.env, write: io.err });
  return outcome === 'generation-failed' || outcome === 'error' || outcome === 'launch-failed' ? 1 : 0;
}

async function cmdWorker(args: string[], io: CliIO): Promise<number> {
  const { values } = parse(args, { job: { type: 'string' } });
  const jobId = values.job;
  if (typeof jobId !== 'string' || !isValidJobId(jobId)) throw new UsageError('worker requires --job <id>.');
  const root = await findRepoRoot(io.cwd);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const job = await runJob({ repoRoot: root, jobId, signal: controller.signal });
    return job.status === 'failed' ? 1 : 0;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

const COMMANDS: Record<string, (args: string[], io: CliIO) => Promise<number>> = {
  init: cmdInit,
  generate: cmdGenerate,
  push: cmdPush,
  'publish-after-push': cmdPublishAfterPush,
  verify: cmdVerify,
  status: cmdStatus,
  logs: cmdLogs,
  config: cmdConfig,
  provider: cmdProvider,
  providers: cmdProviders,
  'playwright-init': cmdPlaywrightInit,
  uninstall: cmdUninstall,
  hook: cmdHook,
  worker: cmdWorker,
};

export async function run(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'help' && rest[0]) {
    const text = COMMAND_HELP[rest[0]];
    if (!text) { io.err(`Unknown command "${rest[0]}".\n`); return 2; }
    io.out(`${text}\n\n--help, -h: show this help.\n`);
    return 0;
  }
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
    io.out(`${COMMAND_HELP[command] ?? HELP}\n\n--help, -h: show this help.\n`);
    return 0;
  }
  try {
    return await handler(rest, io);
  } catch (error) {
    if (command === 'hook') {
      io.err(`PushPilot: failed (${errorMessage(error)}). Push is blocked.\n`);
      return 1;
    }
    io.err(`PushPilot: ${errorMessage(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
