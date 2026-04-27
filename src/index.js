import { createRequire } from 'node:module';
import { runValidate } from './validate.js';
import { runPack } from './pack.js';
import { runDev } from './dev.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json');

export async function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(PACKAGE_VERSION);
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
  console.log(`zeropress-theme - ZeroPress theme development toolkit

Usage:
  zeropress-theme dev <themeDir> [--data <path>] [--host <ip>] [--port <n>] [--open]
  zeropress-theme validate <themeDir|theme.zip> [--strict] [--json]
  zeropress-theme pack <themeDir> [--out <dir>] [--name <zipFile>] [--dry-run]

Arguments:
  <themeDir>            Theme directory
  <theme.zip>           Packaged theme zip file

Options:
  --help, -h            Show help
  --version, -v         Show version

Notes:
  - dev expects canonical preview-data v0.5 JSON
  - validate checks the ZeroPress Theme Runtime v0.5 contract
  - pack validates before packaging and re-validates the generated zip`);
}
