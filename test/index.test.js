import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { run } from '../src/index.js';

const packageJsonPath = new URL('../package.json', import.meta.url);

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
  assert.match(messages[0], /zeropress-theme - ZeroPress theme development toolkit/);
  assert.match(messages[0], /zeropress-theme dev <themeDir>/);
  assert.match(messages[0], /Arguments:/);
  assert.match(messages[0], /Options:/);
  assert.match(messages[0], /--version, -v/);
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
  assert.match(messages[0], /zeropress-theme - ZeroPress theme development toolkit/);
  assert.match(messages[0], /zeropress-theme validate <themeDir\|theme\.zip>/);
});

for (const flag of ['--version', '-v']) {
  test(`run prints version with ${flag}`, async () => {
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => {
      messages.push(String(message));
    };

    try {
      await run([flag]);
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      assert.deepEqual(messages, [pkg.version]);
    } finally {
      console.log = originalLog;
    }
  });
}
