import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index.js';

test('run prints help when --help appears anywhere in argv', async () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (message) => {
    messages.push(String(message));
  };

  try {
    await assert.doesNotReject(() => run(['dev', './my-theme', '--help']));
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0], /zeropress-theme - ZeroPress theme developer toolkit/);
  assert.match(messages[0], /zeropress-theme dev <themeDir>/);
});

test('run prints help and throws a prefixed error for unknown commands', async () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (message) => {
    messages.push(String(message));
  };

  try {
    await assert.rejects(
      () => run(['hello', '--world']),
      /\[zeropress-theme\] Unknown command: hello/,
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0], /zeropress-theme - ZeroPress theme developer toolkit/);
  assert.match(messages[0], /zeropress-theme validate <themeDir\|theme\.zip>/);
});
