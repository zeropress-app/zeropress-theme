#!/usr/bin/env node
import { run } from '../src/index.js';

run(process.argv.slice(2)).catch((error) => {
  console.error(`[zeropress-theme] ${error.message}`);
  process.exit(1);
});
