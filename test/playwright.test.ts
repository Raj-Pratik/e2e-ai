import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig } from '../src/config.js';
import { detectPlaywright, isTestFile, testCommand } from '../src/playwright.js';
import { commit, createRepo } from './helpers.js';

describe('runner selection', () => {
  it('recognizes Python pytest Playwright and its filenames', async () => {
    const { root } = createRepo({ playwright: false });
    commit(root, {
      'pyproject.toml': '[project]\ndependencies = ["pytest-playwright"]\n',
      'tests/test_home.py': 'def test_home(page):\n    assert page is not None\n',
    }, 'Python setup');
    const config = defaultConfig();
    const setup = await detectPlaywright(root, config);
    assert.equal(setup.runner, 'pytest');
    assert.equal(setup.found, true);
    assert.deepEqual(setup.testFiles, ['tests/test_home.py']);
    assert.deepEqual(testCommand(root, config, setup, setup.testFiles)?.slice(1), ['-m', 'pytest', 'tests/test_home.py']);
    assert.equal(isTestFile('tests/home_test.py'), true);
    assert.equal(isTestFile('tests/conftest.py'), false);
  });

  it('preserves explicit environment commands and dedicated directories', async () => {
    const { root } = createRepo();
    const config = defaultConfig();
    config.playwright.testDir = 'tests/browser';
    config.playwright.testCommand = ['uv', 'run', 'pytest'];
    const setup = await detectPlaywright(root, config);
    assert.equal(setup.testDir, 'tests/browser');
    assert.deepEqual(testCommand(root, config, setup, ['tests/browser/test_home.py']), ['uv', 'run', 'pytest', 'tests/browser/test_home.py']);
  });
});
