import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesAny } from '../src/glob.js';
import { PathFilter } from '../src/exclusions.js';
import { redactSecrets } from '../src/redact.js';
import { formatPrePushInput, isZeroSha, parsePrePushInput, refKind } from '../src/refs.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

describe('pre-push ref parsing', () => {
  it('parses updates, new refs and deletions', () => {
    const refs = parsePrePushInput(`refs/heads/main ${A} refs/heads/main ${B}\nrefs/heads/feat ${A} refs/heads/feat ${Z}\n(delete) ${Z} refs/heads/old ${B}\n`);
    assert.equal(refs.length, 3);
    assert.deepEqual(refs.map(refKind), ['update', 'new', 'delete']);
    assert.equal(parsePrePushInput(formatPrePushInput(refs)).length, 3);
  });

  it('accepts SHA-256 object ids and empty input', () => {
    assert.equal(parsePrePushInput(`refs/heads/x ${'c'.repeat(64)} refs/heads/x ${'0'.repeat(64)}`).length, 1);
    assert.deepEqual(parsePrePushInput('\n\n'), []);
    assert.ok(isZeroSha('0'.repeat(64)));
  });

  it('rejects malformed lines', () => {
    assert.throws(() => parsePrePushInput('refs/heads/main abc'), /line 1/);
    assert.throws(() => parsePrePushInput(`refs/heads/main ${A} refs/heads/main $(rm${'x'.repeat(30)})`), /Malformed object id/);
  });
});

describe('glob matching', () => {
  it('matches basenames anywhere and anchored paths from the root', () => {
    assert.ok(matchesAny('config/.env', ['.env']));
    assert.ok(matchesAny('a/b/.env.local', ['.env.*']));
    assert.ok(matchesAny('src/node_modules/x/index.js', ['**/node_modules/**']));
    assert.ok(matchesAny('docs/api.md', ['docs/**']));
    assert.equal(matchesAny('other/docs/api.md', ['docs/**']), null);
    assert.equal(matchesAny('src/environment.ts', ['.env']), null);
  });
});

describe('sensitive file exclusion', () => {
  const filter = new PathFilter(['legacy/**'], true);
  for (const file of ['.env', 'apps/web/.env.production', 'certs/server.pem', 'keys/id_rsa', '.npmrc', 'playwright/.auth/user.json', 'e2e/storageState.json', 'infra/prod.tfvars', 'config/secrets.json']) {
    it(`treats ${file} as sensitive`, () => assert.equal(filter.classify(file), 'sensitive'));
  }
  it('excludes generated and configured paths but keeps source', () => {
    assert.equal(filter.classify('package-lock.json'), 'generated');
    assert.equal(filter.classify('dist/app.js'), 'generated');
    assert.equal(filter.classify('legacy/old.ts'), 'configured');
    assert.equal(filter.classify('src/app.ts'), null);
  });
});

describe('secret redaction', () => {
  it('redacts tokens, keys and credential assignments', () => {
    const input = [
      `const token = "ghp_${'x'.repeat(36)}";`,
      'AWS AKIAABCDEFGHIJKLMNOP',
      "password: 'hunter2hunter2'",
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      'url = "https://user:s3cretpass@example.com/repo"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { text, count } = redactSecrets(input);
    assert.ok(count >= 6);
    for (const secret of ['ghp_xxxx', 'AKIAABCDEFGHIJKLMNOP', 'hunter2hunter2', 'abcdefghijklmnopqrstuvwxyz123456', 's3cretpass', 'MIIEow']) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    assert.equal(redactSecrets('const answer = 42;').count, 0);
  });
});
