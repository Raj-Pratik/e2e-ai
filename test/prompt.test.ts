import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { askYesNo, isAffirmative, selectOption } from '../src/prompt.js';

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

  const options = [{ value: 'copilot', label: 'copilot' }, { value: 'claude', label: 'claude' }];

  it('select list returns only listed values and re-asks on anything else', async () => {
    const stream = io('nonsense\n2\n');
    assert.equal(await selectOption('Provider?', options, stream), 'claude');
    assert.match(stream.written(), /Please pick one of the listed numbers/);
    assert.equal(await selectOption('Provider?', options, io('\n')), 'copilot');
    assert.equal(await selectOption('Provider?', options, io(undefined, true)), null);
  });

  it('select list moves with arrow keys in a raw terminal', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const output = new PassThrough();
    setImmediate(() => { input.write('\x1b[B'); setImmediate(() => input.write('\r')); });
    assert.equal(await selectOption('Provider?', options, { input, output }), 'claude');
  });
});
