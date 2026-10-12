import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BLOCK_START, ensureGitignored, installHook, resolveHookTarget, uninstallHook } from '../src/hookInstall.js';
import { CLI, createRepo, git, write } from './helpers.js';

const backups = (root: string): string => path.join(root, '.ai-e2e', 'backups');

describe('hook installation', () => {
  it('creates an executable hook when none exists and removes it on uninstall', async () => {
    const { root } = createRepo();
    const result = await installHook(root, CLI, backups(root));
    assert.equal(result.action, 'created');
    const content = fs.readFileSync(result.file, 'utf8');
    assert.ok(content.startsWith('#!/bin/sh\n'));
    assert.ok(content.includes(BLOCK_START));
    assert.ok(fs.statSync(result.file).mode & 0o100);
    assert.equal((await installHook(root, CLI, backups(root))).action, 'unchanged');
    assert.equal((await uninstallHook(root)).action, 'deleted-file');
    assert.equal(fs.existsSync(result.file), false);
  });

  it('preserves an existing hook, backs it up, and restores it byte-for-byte', async () => {
    const { root } = createRepo();
    const hookFile = path.join(root, '.git', 'hooks', 'pre-push');
    const original = '#!/bin/bash\nset -e\necho "custom checks"\nexit 0\n';
    fs.writeFileSync(hookFile, original, { mode: 0o755 });

    const result = await installHook(root, CLI, backups(root));
    assert.equal(result.action, 'inserted');
    const lines = fs.readFileSync(hookFile, 'utf8').split('\n');
    assert.equal(lines[0], '#!/bin/bash');
    assert.equal(lines[1], BLOCK_START);
    assert.ok(lines.includes('echo "custom checks"'));
    assert.equal(fs.readFileSync(result.backup!, 'utf8'), original);

    assert.equal((await uninstallHook(root)).action, 'removed-block');
    assert.equal(fs.readFileSync(hookFile, 'utf8'), original);
  });

  it('honours core.hooksPath (tracked hooks directory)', async () => {
    const { root } = createRepo();
    write(root, '.githooks/pre-push', '#!/bin/sh\nexit 0\n');
    git(root, 'add', '.githooks');
    git(root, 'commit', '-q', '-m', 'hooks');
    git(root, 'config', 'core.hooksPath', '.githooks');
    const result = await installHook(root, CLI, backups(root));
    assert.equal(result.file, path.join(root, '.githooks', 'pre-push'));
    assert.equal(result.tracked, true);
  });

  it('integrates with husky by editing .husky/pre-push', async () => {
    const { root } = createRepo();
    git(root, 'config', 'core.hooksPath', '.husky/_');
    write(root, '.husky/pre-push', 'npm test\n');
    const target = await resolveHookTarget(root);
    assert.equal(target.manager, 'husky');
    const result = await installHook(root, CLI, backups(root));
    assert.equal(result.action, 'inserted');
    const content = fs.readFileSync(path.join(root, '.husky', 'pre-push'), 'utf8');
    assert.ok(content.startsWith(BLOCK_START));
    assert.ok(content.endsWith('npm test\n'));
  });

  it('does not modify hooks owned by managers that regenerate them', async () => {
    const { root } = createRepo();
    const hookFile = path.join(root, '.git', 'hooks', 'pre-push');
    const lefthook = '#!/bin/sh\n# lefthook generated\ncall_lefthook run "pre-push" "$@"\n';
    fs.writeFileSync(hookFile, lefthook, { mode: 0o755 });
    const result = await installHook(root, CLI, backups(root));
    assert.equal(result.action, 'blocked');
    assert.match(result.reason ?? '', /lefthook/);
    assert.equal(fs.readFileSync(hookFile, 'utf8'), lefthook);
  });

  it('refuses to inject shell into a non-shell hook', async () => {
    const { root } = createRepo();
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-push'), '#!/usr/bin/env python3\nprint("hi")\n', { mode: 0o755 });
    assert.equal((await installHook(root, CLI, backups(root))).action, 'blocked');
  });

  it('adds the state directory to .gitignore without touching existing entries', async () => {
    const { root } = createRepo();
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules');
    assert.equal(await ensureGitignored(root, path.join(root, '.ai-e2e')), 'added');
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules\n# ai-e2e runtime state (jobs, logs)\n/.ai-e2e/\n');
    assert.equal(await ensureGitignored(root, path.join(root, '.ai-e2e')), 'already-ignored');
  });
});
