#!/usr/bin/env node
import { run } from '../src/index.js';

run(process.argv.slice(2)).catch((error) => {
  console.error(colorizeError(`[zeropress-theme] ${error.message}`));
  process.exit(1);
});

function colorizeError(message) {
  if (!colorsEnabled(process.stderr)) {
    return message;
  }

  return message
    .replace(/^(\[zeropress-theme\].*)/m, '\x1b[31m$1\x1b[0m')
    .replace(/\bERROR\b/g, '\x1b[31mERROR\x1b[0m')
    .replace(/\bWARN\b/g, '\x1b[33mWARN\x1b[0m')
    .replace(/\bINFO\b/g, '\x1b[34mINFO\x1b[0m')
    .replace(/\bHint:/g, '\x1b[1mHint:\x1b[0m');
}

function colorsEnabled(stream) {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(stream?.isTTY);
}
