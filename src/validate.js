import fs from 'node:fs/promises';
import { validateThemeFiles, validateThemeZip } from '@zeropress/theme-validator';
import { getThemeDir, walkDirectory } from './helpers.js';

export async function runValidate(argv) {
  const { positional, flags } = parseValidateArgs(argv);
  const themeDir = getThemeDir(positional[0]);
  const strict = flags.strict === true;
  const json = flags.json === true;

  const result = await validateThemeDirectory(themeDir, { noJsCheck: false });

  if (json) {
    process.stdout.write(`${JSON.stringify(toJsonOutput(result), null, 2)}\n`);
  } else {
    printHuman(result, themeDir);
  }

  if (result.errors.length > 0) {
    return 1;
  }
  if (result.warnings.length > 0) {
    return strict ? 1 : 2;
  }
  return 0;
}

function parseValidateArgs(argv) {
  const positional = [];
  const flags = { strict: false, json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    if (token === '--strict') {
      flags.strict = true;
      continue;
    }
    if (token === '--json') {
      flags.json = true;
      continue;
    }
    throw new Error(`Unknown option for validate: ${token}`);
  }

  return { positional, flags };
}

export async function validateThemeDirectory(themeDir, options = {}) {
  const allEntries = await walkDirectory(themeDir);
  const rootRealPath = await fs.realpath(themeDir);
  const files = new Map();
  const pathEntries = [];

  for (const item of allEntries) {
    const stat = await fs.lstat(item.fullPath);
    pathEntries.push({
      path: item.relativePath,
      isSymlink: stat.isSymbolicLink(),
      resolvedPath: stat.isSymbolicLink() ? await fs.realpath(item.fullPath) : undefined,
      rootRealPath,
    });

    if (item.entry.isFile()) {
      files.set(item.relativePath, await fs.readFile(item.fullPath));
    }
  }

  return validateThemeFiles(files, {
    noJsCheck: options.noJsCheck === true,
    pathEntries,
    checkedFiles: allEntries.filter((item) => item.entry.isFile()).length,
  });
}

export async function validateZipFile(zipPath, options = {}) {
  const raw = await fs.readFile(zipPath);
  return validateThemeZip(raw, {
    noJsCheck: options.noJsCheck === true,
  });
}

function printHuman(result, themeDir) {
  console.log(`Validating theme: ${themeDir}`);
  for (const error of result.errors) {
    console.log(`ERROR ${error.code} ${error.path}: ${error.message}`);
  }
  for (const warning of result.warnings) {
    console.log(`WARN  ${warning.code} ${warning.path}: ${warning.message}`);
  }
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('OK Theme is valid');
  }
}

function toJsonOutput(result) {
  return {
    ok: result.errors.length === 0,
    summary: {
      errors: result.errors.length,
      warnings: result.warnings.length,
      checkedFiles: result.checkedFiles,
    },
    errors: result.errors,
    warnings: result.warnings,
    meta: {
      schemaVersion: '1',
      tool: 'zeropress-theme',
      toolVersion: '0.1.0',
      timestamp: new Date().toISOString(),
    },
  };
}
