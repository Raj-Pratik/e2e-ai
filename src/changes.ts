import { createHash } from 'node:crypto';
import type { ContextSettings } from './config.js';
import { AiE2eError } from './errors.js';
import { PathFilter, type ExclusionReason } from './exclusions.js';
import { git, tryGit } from './git.js';
import { redactSecrets } from './redact.js';
import { refKind, type PushRef, type RefKind } from './refs.js';

export interface CommitInfo {
  sha: string;
  subject: string;
}

export interface RangeInfo {
  localRef: string;
  remoteRef: string;
  kind: RefKind;
  base: string;
  head: string;
  forced: boolean;
  commitCount: number;
  commits: CommitInfo[];
  note?: string;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  base: string;
  head: string;
  diff?: string;
  binary?: boolean;
  diffTruncated?: boolean;
  redactions?: number;
}

export interface ExcludedFile {
  path: string;
  reason: ExclusionReason | 'limit';
}

export interface ChangeSet {
  ranges: RangeInfo[];
  files: ChangedFile[];
  excluded: ExcludedFile[];
  commitCount: number;
  fingerprint: string;
  notes: string[];
  totalDiffBytes: number;
}

export interface AnalyzeOptions {
  withDiffs: boolean;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

async function emptyTree(root: string): Promise<string> {
  return (await git(root, ['hash-object', '-t', 'tree', '--stdin'], '')).trim();
}

async function commitExists(root: string, sha: string): Promise<boolean> {
  return (await tryGit(root, ['cat-file', '-e', `${sha}^{commit}`])) !== null;
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await tryGit(root, ['merge-base', '--is-ancestor', ancestor, descendant])) !== null;
}

async function remoteRefsArg(root: string, remote: string | null): Promise<string> {
  if (remote && REMOTE_NAME.test(remote)) {
    const remotes = (await git(root, ['remote'])).split('\n').map((r) => r.trim());
    if (remotes.includes(remote)) return `--remotes=${remote}`;
  }
  return '--remotes';
}

async function commitsFor(root: string, revArgs: string[], max: number): Promise<{ count: number; commits: CommitInfo[] }> {
  const count = Number((await git(root, ['rev-list', '--count', ...revArgs])).trim());
  const log = await git(root, ['log', '--no-show-signature', '--topo-order', `--max-count=${max}`, '--format=%H%x1f%s', ...revArgs]);
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\x1f');
      return { sha, subject };
    });
  return { count, commits };
}

async function resolveRange(
  root: string,
  ref: PushRef,
  remoteArg: string,
  empty: string,
  maxCommits: number,
): Promise<RangeInfo | null> {
  const kind = refKind(ref);
  if (kind === 'delete') return null;
  if (!(await commitExists(root, ref.localSha))) {
    throw new AiE2eError(`Local commit ${ref.localSha.slice(0, 12)} for ${ref.localRef} is not available.`);
  }
  const common = { localRef: ref.localRef, remoteRef: ref.remoteRef, kind, head: ref.localSha };

  if (kind === 'update' && (await commitExists(root, ref.remoteSha))) {
    const fastForward = await isAncestor(root, ref.remoteSha, ref.localSha);
    const mergeBase = fastForward ? ref.remoteSha : (await tryGit(root, ['merge-base', ref.remoteSha, ref.localSha]))?.trim();
    const { count, commits } = await commitsFor(root, [ref.localSha, '--not', ref.remoteSha], maxCommits);
    if (count === 0) return null;
    return {
      ...common,
      base: mergeBase || empty,
      forced: !fastForward,
      commitCount: count,
      commits,
      ...(fastForward ? {} : { note: 'Force push: compared against the merge base with the remote commit.' }),
    };
  }

  const revArgs = [ref.localSha, '--not', remoteArg];
  const oldest = (await git(root, ['rev-list', '--topo-order', '--reverse', ...revArgs])).split('\n').find(Boolean);
  if (!oldest) return null;
  const parent = (await tryGit(root, ['rev-parse', '--verify', '--quiet', `${oldest}^1`]))?.trim();
  const { count, commits } = await commitsFor(root, revArgs, maxCommits);
  return {
    ...common,
    base: parent || empty,
    forced: false,
    commitCount: count,
    commits,
    note:
      kind === 'new'
        ? 'New remote ref: includes commits not present on any remote-tracking branch.'
        : 'Remote commit is not available locally: compared against remote-tracking branches.',
  };
}

async function nameStatus(root: string, base: string, head: string): Promise<Array<Pick<ChangedFile, 'path' | 'oldPath' | 'status'>>> {
  const out = await git(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-color', base, head, '--']);
  const parts = out.split('\0');
  const files: Array<Pick<ChangedFile, 'path' | 'oldPath' | 'status'>> = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const status = code[0] as FileStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[++i] ?? '';
      const newPath = parts[++i] ?? '';
      files.push({ path: newPath, oldPath, status });
    } else {
      files.push({ path: parts[++i] ?? '', status });
    }
  }
  return files.filter((f) => f.path);
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false };
  return { text: `${Buffer.from(text).subarray(0, max).toString('utf8')}\n... [diff truncated]`, truncated: true };
}

export function fingerprintRanges(ranges: Array<{ base: string; head: string }>): string {
  const key = [...new Set(ranges.map((r) => `${r.base}..${r.head}`))].sort().join('\n');
  return createHash('sha256').update(key).digest('hex').slice(0, 20);
}

export async function analyzeOutgoing(
  root: string,
  remote: string | null,
  refs: PushRef[],
  limits: ContextSettings,
  options: AnalyzeOptions,
): Promise<ChangeSet> {
  const empty = await emptyTree(root);
  const remoteArg = await remoteRefsArg(root, remote);
  const filter = new PathFilter(limits.exclude, limits.excludeGenerated);
  const notes: string[] = [];
  const ranges: RangeInfo[] = [];

  for (const ref of refs) {
    const range = await resolveRange(root, ref, remoteArg, empty, limits.maxCommits);
    if (!range) continue;
    ranges.push(range);
    if (range.note) notes.push(`${ref.localRef}: ${range.note}`);
  }

  const byPath = new Map<string, ChangedFile>();
  for (const range of ranges) {
    for (const file of await nameStatus(root, range.base, range.head)) {
      byPath.set(file.path, { ...file, base: range.base, head: range.head });
    }
  }

  const files: ChangedFile[] = [];
  const excluded: ExcludedFile[] = [];
  for (const file of [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const reason = filter.classify(file.path) ?? (file.oldPath ? filter.classify(file.oldPath) : null);
    if (reason) excluded.push({ path: file.path, reason });
    else if (files.length >= limits.maxFiles) excluded.push({ path: file.path, reason: 'limit' });
    else files.push(file);
  }
  if (excluded.some((f) => f.reason === 'limit')) notes.push(`Only the first ${limits.maxFiles} changed files were analyzed.`);

  let totalDiffBytes = 0;
  if (options.withDiffs) {
    let budgetExhausted = false;
    for (const file of files) {
      if (budgetExhausted) {
        file.diffTruncated = true;
        continue;
      }
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      const raw = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', '-M', file.base, file.head, '--', ...paths]);
      if (/^Binary files .* differ$/m.test(raw) || raw.includes('GIT binary patch')) {
        file.binary = true;
        continue;
      }
      const redacted = redactSecrets(raw);
      const perFile = truncate(redacted.text, limits.maxDiffBytesPerFile);
      const remaining = limits.maxTotalDiffBytes - totalDiffBytes;
      const fitted = truncate(perFile.text, Math.max(remaining, 0));
      file.diff = fitted.text;
      file.diffTruncated = perFile.truncated || fitted.truncated;
      file.redactions = redacted.count;
      totalDiffBytes += Buffer.byteLength(fitted.text);
      if (totalDiffBytes >= limits.maxTotalDiffBytes) budgetExhausted = true;
    }
    if (budgetExhausted) notes.push(`Diff context was capped at ${limits.maxTotalDiffBytes} bytes.`);
    const redactions = files.reduce((sum, f) => sum + (f.redactions ?? 0), 0);
    if (redactions) notes.push(`${redactions} potential secret(s) were redacted from diffs.`);
  }

  const uniqueCommits = new Set(ranges.flatMap((r) => r.commits.map((c) => c.sha)));
  const commitCount = Math.max(uniqueCommits.size, ranges.reduce((max, r) => Math.max(max, r.commitCount), 0));

  return { ranges, files, excluded, commitCount, fingerprint: fingerprintRanges(ranges), notes, totalDiffBytes };
}
