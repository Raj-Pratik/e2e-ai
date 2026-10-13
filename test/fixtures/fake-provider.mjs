#!/usr/bin/env node
// Stand-in for an AI CLI in tests. Behaviour is selected with FAKE_* environment variables.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('fake-provider 1.2.3');
  process.exit(0);
}
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));

const instruction = args[args.indexOf('-p') + 1] ?? '';
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

console.log(`leaked token ghp_${'a'.repeat(36)}`);
switch (process.env.FAKE_MODE ?? 'write') {
  case 'write':
    writeTest();
    console.log(`Created ${target}`);
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
    break;
  case 'outside':
    writeTest();
    fs.writeFileSync('src/agent-touched.ts', 'export {};\n');
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
    fs.writeFileSync(path.join(path.dirname(taskRel), 'done.json'), JSON.stringify({ status: 'passed' }));
    setInterval(() => undefined, 1000);
    break;
  case 'not-needed':
    fs.writeFileSync(path.join(path.dirname(taskRel), 'done.json'), JSON.stringify({ status: 'not-needed', reason: 'docs only' }));
    setInterval(() => undefined, 1000);
    break;
  default:
    console.error('unknown FAKE_MODE');
    process.exit(8);
}
