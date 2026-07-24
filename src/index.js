import { createRequire } from 'node:module';
import { runValidate } from './validate.js';
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
    return code;
  }

  if (command === 'dev') {
    await runDev(rest);
    return;
  }

  printHelp();
  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`zeropress-theme - ZeroPress theme development toolkit

Usage:
  zeropress-theme dev <themeDir> [--data <path>] [--public-dir <dir>] [--host <host>] [--port <n>] [--strict-port] [--no-js]
  zeropress-theme validate <themeDir> [--json]

Arguments:
  <themeDir>            Theme directory

Options:
  --help, -h            Show help
  --version, -v         Show version

Notes:
  - dev expects canonical preview-data v0.7 JSON
  - validate checks the ZeroPress Theme Runtime v0.7 contract`);
}
