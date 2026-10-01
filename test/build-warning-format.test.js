import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBuildWarning } from '../src/dev.js';

test('build warnings escape terminal controls and respect color settings on stderr', () => {
  const previous = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  const warning = { code: 'MENU_MAX_DEPTH_EXCEEDED', message: 'Primary\n\u001b[31m\u202E menu' };
  const plain = '[MENU_MAX_DEPTH_EXCEEDED] Primary\\u000A\\u001B[31m\\u202E menu';
  try {
    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    assert.equal(formatBuildWarning(warning, { isTTY: false }), plain);
    process.env.FORCE_COLOR = '1';
    assert.equal(formatBuildWarning(warning, { isTTY: false }), '\u001b[33m' + plain + '\u001b[0m');
    process.env.NO_COLOR = '1';
    assert.equal(formatBuildWarning(warning, { isTTY: true }), plain);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
