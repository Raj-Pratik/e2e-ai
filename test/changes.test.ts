import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeOutgoing } from '../src/changes.js';
import { defaultConfig } from '../src/config.js';
import { parsePrePushInput } from '../src/refs.js';
import { commit, createRepo, git } from './helpers.js';

const ZERO = '0'.repeat(40);
const limits = () => defaultConfig().context;

describe('outgoing change analysis', () => {
  it('analyzes a fast-forward update as remote..local', async () => {
    const repo = createRepo();
    const remoteSha = git(repo.root, 'rev-parse', 'origin/main').trim();
    commit(repo.root, { 'src/cart.ts': 'export const cart = 1;\n' }, 'add cart');
    const head = commit(repo.root, { 'src/app.ts': 'export const app = () => "changed";\n' }, 'change app');
    const refs = parsePrePushInput(`refs/heads/main ${head} refs/heads/main ${remoteSha}`);

    const cs = await analyzeOutgoing(repo.root, 'origin', refs, limits(), { withDiffs: true });
    assert.equal(cs.ranges.length, 1);
    assert.equal(cs.ranges[0]!.base, remoteSha);
    assert.equal(cs.commitCount, 2);
    assert.deepEqual(cs.files.map((f) => `${f.status}:${f.path}`), ['M:src/app.ts', 'A:src/cart.ts']);
    assert.match(cs.files[0]!.diff ?? '', /\+export const app = \(\) => "changed";/);
    assert.equal(cs.ranges[0]!.forced, false);
  });

  it('only includes commits not on the remote for a new branch', async () => {
    const repo = createRepo();
    git(repo.root, 'checkout', '-q', '-b', 'feature');
    const head = commit(repo.root, { 'src/feature.ts': 'export const f = 1;\n' }, 'feature work');
    const cs = await analyzeOutgoing(repo.root, 'origin', parsePrePushInput(`refs/heads/feature ${head} refs/heads/feature ${ZERO}`), limits(), {
      withDiffs: false,
    });
    assert.equal(cs.commitCount, 1);
    assert.deepEqual(cs.files.map((f) => f.path), ['src/feature.ts']);
    assert.ok(cs.notes.some((n) => /New remote ref/.test(n)));
  });

  it('uses the merge base for force pushes', async () => {
    const repo = createRepo();
    const baseSha = git(repo.root, 'rev-parse', 'HEAD').trim();
    const pushed = commit(repo.root, { 'src/old.ts': 'old\n' }, 'old work');
    git(repo.root, 'push', '-q', 'origin', 'main');
    git(repo.root, 'reset', '-q', '--hard', baseSha);
    const rewritten = commit(repo.root, { 'src/new.ts': 'new\n' }, 'rewritten');
    const cs = await analyzeOutgoing(repo.root, 'origin', parsePrePushInput(`refs/heads/main ${rewritten} refs/heads/main ${pushed}`), limits(), {
      withDiffs: false,
    });
    assert.equal(cs.ranges[0]!.forced, true);
    assert.equal(cs.ranges[0]!.base, baseSha);
    assert.deepEqual(cs.files.map((f) => f.path), ['src/new.ts']);
  });

  it('skips deletions and de-duplicates identical ranges across refs', async () => {
    const repo = createRepo();
    const remoteSha = git(repo.root, 'rev-parse', 'origin/main').trim();
    const head = commit(repo.root, { 'src/x.ts': 'x\n' }, 'x');
    const input = [
      `refs/heads/main ${head} refs/heads/main ${remoteSha}`,
      `refs/heads/main ${head} refs/heads/release ${remoteSha}`,
      `(delete) ${ZERO} refs/heads/gone ${remoteSha}`,
    ].join('\n');
    const cs = await analyzeOutgoing(repo.root, 'origin', parsePrePushInput(input), limits(), { withDiffs: false });
    assert.equal(cs.ranges.length, 2);
    assert.deepEqual(cs.files.map((f) => f.path), ['src/x.ts']);
    const single = await analyzeOutgoing(repo.root, 'origin', parsePrePushInput(input.split('\n')[0]!), limits(), { withDiffs: false });
    assert.equal(cs.fingerprint, single.fingerprint);
  });

  it('never includes sensitive files or their contents, and redacts secrets in diffs', async () => {
    const repo = createRepo();
    const remoteSha = git(repo.root, 'rev-parse', 'origin/main').trim();
    const head = commit(
      repo.root,
      {
        '.env': 'API_KEY=supersecretvalue\n',
        'config/server.pem': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
        'src/client.ts': `export const token = "ghp_${'z'.repeat(36)}";\n`,
        'package-lock.json': '{}\n',
      },
      'secrets',
    );
    const cs = await analyzeOutgoing(repo.root, 'origin', parsePrePushInput(`refs/heads/main ${head} refs/heads/main ${remoteSha}`), limits(), {
      withDiffs: true,
    });
    assert.deepEqual(cs.files.map((f) => f.path), ['src/client.ts']);
    assert.deepEqual(
      cs.excluded.map((e) => `${e.path}:${e.reason}`).sort(),
      ['.env:sensitive', 'config/server.pem:sensitive', 'package-lock.json:generated'],
    );
    const serialized = JSON.stringify(cs);
    assert.ok(!serialized.includes('supersecretvalue'));
    assert.ok(!serialized.includes('z'.repeat(36)));
  });

  it('applies file and diff size limits', async () => {
    const repo = createRepo();
    const remoteSha = git(repo.root, 'rev-parse', 'origin/main').trim();
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`src/f${i}.ts`] = `${'const x = 1;\n'.repeat(200)}`;
    const head = commit(repo.root, files, 'many');
    const cs = await analyzeOutgoing(
      repo.root,
      'origin',
      parsePrePushInput(`refs/heads/main ${head} refs/heads/main ${remoteSha}`),
      { ...limits(), maxFiles: 3, maxDiffBytesPerFile: 500, maxTotalDiffBytes: 1200 },
      { withDiffs: true },
    );
    assert.equal(cs.files.length, 3);
    assert.equal(cs.excluded.filter((e) => e.reason === 'limit').length, 2);
    assert.ok(cs.files.every((f) => f.diffTruncated));
    assert.ok(cs.totalDiffBytes <= 1200 + 3 * 40);
  });
});
