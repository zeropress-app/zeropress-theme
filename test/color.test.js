import test from 'node:test';
import assert from 'node:assert/strict';
import { createColor } from '../src/color.js';

function withColorEnv(env, fn) {
  const previousForceColor = process.env.FORCE_COLOR;
  const previousNoColor = process.env.NO_COLOR;

  if (env.FORCE_COLOR === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = env.FORCE_COLOR;
  }
  if (env.NO_COLOR === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = env.NO_COLOR;
  }

  try {
    return fn();
  } finally {
    if (previousForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = previousForceColor;
    }
    if (previousNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColor;
    }
  }
}

test('createColor provides shared color and bold formatting', () => {
  const formatted = withColorEnv({ FORCE_COLOR: '1' }, () => {
    const color = createColor({ isTTY: false });
    return [
      color.red('error'),
      color.yellow('warning'),
      color.blue('info'),
      color.green('success'),
      color.bold('Hint:'),
    ];
  });

  assert.deepEqual(formatted, [
    '\x1b[31merror\x1b[0m',
    '\x1b[33mwarning\x1b[0m',
    '\x1b[34minfo\x1b[0m',
    '\x1b[32msuccess\x1b[0m',
    '\x1b[1mHint:\x1b[0m',
  ]);
});

test('createColor keeps NO_COLOR precedence over FORCE_COLOR', () => {
  const formatted = withColorEnv({ FORCE_COLOR: '1', NO_COLOR: '1' }, () => {
    const color = createColor({ isTTY: true });
    return [color.red('error'), color.bold('Hint:')];
  });

  assert.deepEqual(formatted, ['error', 'Hint:']);
});
