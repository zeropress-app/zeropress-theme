import { runValidate } from './validate.js';
import { runPack } from './pack.js';
import { runDev } from './dev.js';

export async function run(argv) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'validate') {
    const code = await runValidate(rest);
    process.exit(code);
    return;
  }

  if (command === 'pack') {
    await runPack(rest);
    return;
  }

  if (command === 'dev') {
    await runDev(rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`zeropress-theme - ZeroPress theme developer toolkit

Usage:
  zeropress-theme dev [themeDir] [--port <n>] [--host <ip>] [--data <path-or-url>] [--open] [--no-js-check]
  zeropress-theme validate [themeDir|theme.zip] [--strict] [--json]
  zeropress-theme pack [themeDir] [--out <dir>] [--name <zipFile>] [--dry-run]`);
}
