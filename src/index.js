import { runValidate } from './validate.js';
import { runPack } from './pack.js';
import { runDev } from './dev.js';

export async function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const [command, ...rest] = argv;

  if (!command) {
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

  printHelp();
  throw new Error(`[zeropress-theme] Unknown command: ${command}`);
}

function printHelp() {
  console.log(`zeropress-theme - ZeroPress theme developer toolkit

Usage:
  zeropress-theme dev <themeDir> [--port <n>] [--host <ip>] [--data <path>] [--open]
  zeropress-theme validate <themeDir|theme.zip> [--strict] [--json]
  zeropress-theme pack <themeDir> [--out <dir>] [--name <zipFile>] [--dry-run]

Notes:
  dev expects canonical preview-data v0.4 JSON.`);
}
