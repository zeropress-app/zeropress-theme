import test from 'node:test';
import assert from 'node:assert/strict';
import { toTerminalSafeText } from '../src/terminal.js';

test('toTerminalSafeText preserves printable Unicode and escapes terminal control characters', () => {
  const input = '한글 A\u0000\u001B\u007F\u0085\u061C\u200E\u2028\u202E\u2069 Z';

  assert.equal(
    toTerminalSafeText(input),
    '한글 A\\u0000\\u001B\\u007F\\u0085\\u061C\\u200E\\u2028\\u202E\\u2069 Z',
  );
});

test('toTerminalSafeText escapes attacker-owned line breaks without adding layout', () => {
  assert.equal(toTerminalSafeText('first\r\nsecond'), 'first\\u000D\\u000Asecond');
});
