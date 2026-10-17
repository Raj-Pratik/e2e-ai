import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { defaultConfig, getConfigValue, loadConfig, parseConfigValue, setConfigValue, validateConfig } from '../src/config.js';
import { tmpDir } from './helpers.js';

describe('config', () => {
  it('uses safe defaults when no config file exists', () => {
    const loaded = loadConfig(tmpDir());
    assert.equal(loaded.exists, false);
    assert.equal(loaded.config.provider, 'copilot');
    assert.equal(loaded.config.mcp.playwright.enabled, false);
    assert.equal(loaded.config.playwright.runGeneratedTests, true);
    assert.equal(loaded.config.generation.allowModifyExistingTests, true);
    assert.equal(loaded.config.jobs.duplicate, 'skip');
  });

  it('deep-merges partial config over defaults', () => {
    const config = validateConfig({ provider: 'claude', providers: { claude: { model: 'sonnet' } }, context: { maxFiles: 5 } });
    assert.equal(config.provider, 'claude');
    assert.equal(config.providers.claude?.model, 'sonnet');
    assert.deepEqual(config.providers.claude?.extraArgs, []);
    assert.equal(config.context.maxFiles, 5);
    assert.equal(config.context.maxCommits, defaultConfig().context.maxCommits);
    assert.ok(config.providers.copilot);
  });

  it('defaults both providers to Haiku 5.5, with Sonnet 5.5 for large changes', () => {
    const config = validateConfig({ providers: { claude: { maxTurns: 10 } } });
    assert.equal(config.providers.claude?.model, 'claude-haiku-5-5');
    assert.equal(config.providers.claude?.complexModel, 'claude-sonnet-5-5');
    assert.equal(config.providers.copilot?.model, 'claude-haiku-5.5');
    assert.equal(config.providers.copilot?.complexModel, 'claude-sonnet-5.5');
    assert.deepEqual(config.generation.complexChange, { minFiles: 6, minDiffBytes: 25_000 });
  });

  it('rejects unknown keys, wrong types and bad values with the offending path', () => {
    assert.throws(() => validateConfig({ provder: 'x' }), /unknown key "config.provder"/);
    assert.throws(() => validateConfig({ enabled: 'yes' }), /"config.enabled" must be a boolean/);
    assert.throws(() => validateConfig({ context: { maxFiles: 0 } }), /config.context.maxFiles/);
    assert.throws(() => validateConfig({ mcp: { playwright: { baseUrl: 'file:///etc/passwd' } } }), /http\(s\) URL/);
    assert.throws(() => validateConfig({ jobs: { duplicate: 'replace' } }), /one of "skip", "allow"/);
    assert.throws(() => validateConfig({ playwright: { testCommand: [] } }), /non-empty array/);
    assert.throws(() => validateConfig([]), /must be an object/);
  });

  it('reports malformed JSON clearly', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, '.ai-e2e.json'), '{ nope');
    assert.throws(() => loadConfig(dir), /not valid JSON/);
  });

  it('gets and sets values with validation and without prototype pollution', () => {
    const raw = setConfigValue({}, 'mcp.playwright.enabled', true);
    assert.deepEqual(raw, { mcp: { playwright: { enabled: true } } });
    assert.equal(getConfigValue(validateConfig(raw), 'mcp.playwright.enabled'), true);
    assert.throws(() => setConfigValue({}, 'context.maxFiles', 'many'), /integer/);
    assert.throws(() => setConfigValue({}, '__proto__.polluted', true), /Invalid configuration key/);
    assert.throws(() => getConfigValue(defaultConfig(), 'nope.key'), /Unknown configuration key/);
    assert.equal(parseConfigValue('42'), 42);
    assert.equal(parseConfigValue('claude'), 'claude');
  });
});
