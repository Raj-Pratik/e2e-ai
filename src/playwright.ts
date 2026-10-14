import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { PathFilter } from './exclusions.js';
import { listFiles } from './git.js';

export const CONFIG_CANDIDATES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mts',
  'playwright.config.mjs',
  'playwright.config.cts',
  'playwright.config.cjs',
];

const TEST_FILE = /(?:\.(spec|test)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.py$)/;
const SOURCE_FILE = /(?:\.[cm]?[jt]sx?|\.py)$/;
export const isTestFile = (file: string): boolean => TEST_FILE.test(file);

export interface PlaywrightSetup {
  found: boolean;
  configPath: string | null;
  testDir: string;
  testDirSource: 'settings' | 'config' | 'default';
  outputDir: string;
  dependency: string | null;
  cliPath: string | null;
  scripts: Record<string, string>;
  testFiles: string[];
  supportFiles: string[];
  testSuffix: string;
  runner?: 'javascript' | 'pytest';
}

export function testCommand(root: string, config: Config, setup: PlaywrightSetup, specs: string[]): string[] | null {
  if (config.playwright.testCommand) return [...config.playwright.testCommand, ...specs];
  if (setup.runner === 'pytest') {
    const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    return [fs.existsSync(python) ? python : process.platform === 'win32' ? 'python' : 'python3', '-m', 'pytest', ...specs];
  }
  return setup.cliPath ? [process.execPath, setup.cliPath, 'test', '--reporter=line', ...(config.playwright.configPath ? ['--config', config.playwright.configPath] : []), ...specs] : null;
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

function readPackageJson(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** Reads testDir without executing the config (configs may run arbitrary code). */
export function extractTestDir(configSource: string): string | null {
  const literal = /\btestDir\s*:\s*(['"`])([^'"`]+)\1/.exec(configSource);
  if (literal) return literal[2]!;
  const joined = /\btestDir\s*:\s*path\.(?:join|resolve)\(\s*__dirname\s*,\s*(['"`])([^'"`]+)\1\s*\)/.exec(configSource);
  return joined ? joined[2]! : null;
}

function normalizeRelative(root: string, base: string, p: string): string {
  const rel = toPosix(path.relative(root, path.resolve(base, p)));
  return rel === '' ? '.' : rel;
}

function inferSuffix(testFiles: string[]): string {
  const counts = new Map<string, number>();
  for (const file of testFiles) {
    const match = /(\.(?:spec|test)\.[cm]?[jt]sx?)$/.exec(file);
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '.spec.ts';
}

export async function detectPlaywright(root: string, config: Config): Promise<PlaywrightSetup> {
  const configured = config.playwright.configPath;
  const configPath = configured
    ? fs.existsSync(path.resolve(root, configured))
      ? configured
      : null
    : (CONFIG_CANDIDATES.find((c) => fs.existsSync(path.join(root, c))) ?? null);

  const pkg = readPackageJson(root);
  const pythonPlaywright = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'Pipfile', 'uv.lock']
    .some((file) => {
      try { return /pytest-playwright|pytest_playwright/.test(fs.readFileSync(path.join(root, file), 'utf8')); } catch { return false; }
    });
  const deps = { ...stringRecord(pkg?.dependencies), ...stringRecord(pkg?.devDependencies) };
  const dependency = ['@playwright/test', 'playwright'].find((d) => d in deps) ?? (pythonPlaywright ? 'pytest-playwright' : null);
  const runner = !configPath && dependency === 'pytest-playwright' ? 'pytest' : 'javascript';
  const scripts = Object.fromEntries(Object.entries(stringRecord(pkg?.scripts)).filter(([, cmd]) => /playwright/.test(cmd)));

  let testDir = runner === 'pytest' ? 'tests' : '.';
  let testDirSource: PlaywrightSetup['testDirSource'] = 'default';
  if (config.playwright.testDir) {
    testDir = normalizeRelative(root, root, config.playwright.testDir);
    testDirSource = 'settings';
  } else if (configPath) {
    const configDir = path.dirname(path.resolve(root, configPath));
    const fromConfig = extractTestDir(fs.readFileSync(path.resolve(root, configPath), 'utf8'));
    testDir = normalizeRelative(root, configDir, fromConfig ?? '.');
    if (fromConfig) testDirSource = 'config';
  }
  const outputDir = config.generation.outputDir
    ? normalizeRelative(root, root, config.generation.outputDir)
    : testDir === '.'
      ? 'e2e'
      : testDir;

  const cliPath =
    ['@playwright/test/cli.js', 'playwright/cli.js'].map((p) => path.join(root, 'node_modules', p)).find((p) => fs.existsSync(p)) ?? null;

  const filter = new PathFilter(config.context.exclude, true);
  const scanDirs = [...new Set([testDir, outputDir])].filter((d) => !d.startsWith('..'));
  const files = configPath || dependency ? (await listFiles(root, scanDirs)).filter((f) => !filter.classify(f)) : [];
  const testFiles = files.filter((f) => TEST_FILE.test(f)).sort();
  const supportFiles = files.filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f) && !CONFIG_CANDIDATES.includes(path.basename(f))).sort();

  return {
    found: Boolean(configPath || dependency),
    configPath: configPath ? toPosix(configPath) : null,
    testDir,
    testDirSource,
    outputDir,
    dependency,
    cliPath,
    scripts,
    testFiles,
    supportFiles,
    testSuffix: runner === 'pytest' ? '.py (test_*.py or *_test.py)' : inferSuffix(testFiles),
    runner,
  };
}

const STOP_WORDS = new Set(['src', 'lib', 'app', 'index', 'main', 'test', 'tests', 'spec', 'e2e', 'components', 'component', 'utils', 'util', 'helpers', 'local', 'modules', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'html', 'json']);

export function pathTokens(filePath: string): Set<string> {
  return new Set(
    filePath
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

/** Ranks files by how many path tokens they share with the changed files. */
export function rankRelated(candidates: string[], changedPaths: string[], limit: number): string[] {
  const changed = new Set(changedPaths.flatMap((p) => [...pathTokens(p)]));
  return candidates
    .map((file) => ({ file, score: [...pathTokens(file)].filter((t) => changed.has(t)).length }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((c) => c.file);
}

export function isWithin(dir: string, file: string): boolean {
  return dir === '.' || file === dir || file.startsWith(`${dir}/`);
}
