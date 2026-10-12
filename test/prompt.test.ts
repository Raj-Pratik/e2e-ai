import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { askYesNo, isAffirmative } from '../src/prompt.js';

function io(answer?: string, end = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (d: Buffer) => (written += d.toString()));
  setImmediate(() => {
    if (answer !== undefined) input.write(answer);
    if (end) input.end();
  });
  return { input, output, written: () => written };
}

describe('interactive prompt', () => {
  it('accepts y and yes (any case)', async () => {
    assert.equal(await askYesNo('Q? ', io('y\n'), 1000), 'yes');
    assert.equal(await askYesNo('Q? ', io('YES\n'), 1000), 'yes');
  });

  it('treats Enter, other text and EOF as decline', async () => {
    assert.equal(await askYesNo('Q? ', io('\n'), 1000), 'no');
    assert.equal(await askYesNo('Q? ', io('n\n'), 1000), 'no');
    assert.equal(await askYesNo('Q? ', io('yep sure\n'), 1000), 'no');
    assert.equal(await askYesNo('Q? ', io(undefined, true), 1000), 'no');
  });

  it('times out to a decline and writes the question', async () => {
    const stream = io();
    assert.equal(await askYesNo('Generate? [y/N] ', stream, 50), 'timeout');
    assert.match(stream.written(), /Generate\? \[y\/N\]/);
  });

  it('isAffirmative is strict', () => {
    assert.ok(isAffirmative(' y '));
    assert.ok(!isAffirmative(''));
    assert.ok(!isAffirmative('no'));
  });
});
