#!/usr/bin/env node
// Stand-in for an AI CLI in tests. Behaviour is selected with FAKE_* environment variables.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('fake-provider 1.2.3');
  process.exit(0);
}
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));

const instruction = args.includes('-p') ? args[args.indexOf('-p') + 1] : (args[args.indexOf('-i') + 1] ?? '');
const taskRel = /`([^`]+task\.md)`/.exec(instruction)?.[1];
if (!taskRel || !fs.existsSync(taskRel)) {
  console.error('task file missing');
  process.exit(9);
}
const task = fs.readFileSync(taskRel, 'utf8');
if (process.env.FAKE_TASK_COPY) fs.writeFileSync(process.env.FAKE_TASK_COPY, task);
fs.writeFileSync(path.join(path.dirname(taskRel), 'plan.md'), '# Approved test plan\n\n- Generated test scenario\n');

const outDir = /under `([^`]+)\/`/.exec(task)?.[1] ?? 'e2e';
const target = path.join(outDir, process.env.FAKE_TARGET ?? 'generated-feature.spec.ts');
const writeTest = () => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    "import { test, expect } from '@playwright/test';\n\ntest('generated', async ({ page }) => {\n  await expect(page).toBeDefined();\n});\n",
  );
};

// Like a real agent: run the task's verify command, and retry it (as if after a fix) until it passes.
const verifyCommand = /Run exactly this command[^\n]*\n\s*`([^`]+)`/.exec(task)?.[1];
const verify = () => {
  if (!verifyCommand || process.env.FAKE_NO_VERIFY) return false;
  for (let i = 0; i < Number(process.env.FAKE_VERIFY_TRIES ?? 3); i++) {
    const run = spawnSync(verifyCommand, { shell: true, stdio: 'inherit' });
    if (run.status === 0) return true;
  }
  return false;
};

console.log(`leaked token ghp_${'a'.repeat(36)}`);
switch (process.env.FAKE_MODE ?? 'write') {
  case 'write':
    writeTest();
    console.log(`Created ${target}`);
    verify();
    break;
  case 'fail':
    console.error('provider exploded');
    process.exit(3);
    break;
  case 'hang':
    setInterval(() => undefined, 1000);
    break;
  case 'modify':
    writeTest();
    fs.appendFileSync(process.env.FAKE_MODIFY, '\n// changed by agent\n');
    verify();
    break;
  case 'outside':
    writeTest();
    fs.writeFileSync('src/agent-touched.ts', 'export {};\n');
    verify();
    break;
  case 'block': {
    writeTest();
    const release = process.env.FAKE_RELEASE;
    const wait = () => (fs.existsSync(release) ? process.exit(0) : setTimeout(wait, 50));
    wait();
    break;
  }
  case 'done-and-hang':
    // Simulates an interactive CLI that never exits on its own after signalling completion.
    writeTest();
    verify();
    setInterval(() => undefined, 1000);
    break;
  case 'edit-after-verify':
    writeTest();
    verify();
    fs.appendFileSync(target, '// edited after the passing run\n');
    break;
  case 'not-needed':
    fs.writeFileSync(path.join(path.dirname(taskRel), 'done.json'), JSON.stringify({ status: 'not-needed', reason: 'docs only' }));
    setInterval(() => undefined, 1000);
    break;
  default:
    console.error('unknown FAKE_MODE');
    process.exit(8);
}
