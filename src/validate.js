import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { validateThemeFiles } from '@zeropress/theme-validator';
import { getThemeDir, walkDirectory } from './helpers.js';

export async function runValidate(argv) {
  const { positional, flags } = parseValidateArgs(argv);
  if (!positional[0]) {
    throw new Error('validate requires a themeDir or theme.zip argument');
  }
  const targetPath = getThemeDir(positional[0]);
  const strict = flags.strict === true;
  const json = flags.json === true;
  const target = await resolveValidationTarget(targetPath);
  const result = target.type === 'zip'
    ? await validateZipFile(target.path)
    : await validateThemeDirectory(target.path);

  if (json) {
    process.stdout.write(`${JSON.stringify(toJsonOutput(result), null, 2)}\n`);
  } else {
    printHuman(result, target);
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

export async function validateThemeDirectory(themeDir) {
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
    pathEntries,
    checkedFiles: allEntries.filter((item) => item.entry.isFile()).length,
  });
}

export async function validateZipFile(zipPath) {
  const raw = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(raw);
  const analysis = analyzeZipLayout(Object.keys(zip.files).filter((filePath) => !zip.files[filePath].dir));
  if (analysis.error) {
    return {
      ok: false,
      errors: [createIssue('INVALID_ZIP_ROOT', 'theme.zip', analysis.error, 'error')],
      warnings: [],
      manifest: undefined,
      checkedFiles: analysis.checkedFiles,
    };
  }

  const files = new Map();
  await Promise.all(
    analysis.normalizedFilePaths.map(async (normalizedPath) => {
      const file = zip.file(normalizedPath);
      if (!file || file.dir) {
        return;
      }
      const relativePath = analysis.relativePathByZipPath.get(normalizedPath) || normalizedPath;
      files.set(relativePath, await file.async('uint8array'));
    }),
  );

  const result = await validateThemeFiles(files, {
    checkedFiles: analysis.checkedFiles,
  });
  return {
    ...result,
    warnings: analysis.ignoredMacOsMetadata
      ? [createIssue('MACOS_METADATA_IGNORED', 'theme.zip', 'macOS metadata files (__MACOSX, ._*) were ignored', 'warning'), ...result.warnings]
      : result.warnings,
  };
}

async function resolveValidationTarget(inputPath) {
  const stat = await fs.stat(inputPath);
  if (stat.isDirectory()) {
    return { type: 'directory', path: inputPath };
  }
  if (stat.isFile() && path.extname(inputPath).toLowerCase() === '.zip') {
    return { type: 'zip', path: inputPath };
  }
  throw new Error(`Validate expects a theme directory or .zip file: ${inputPath}`);
}

function printHuman(result, target) {
  const label = target.type === 'zip' ? 'theme zip' : 'theme directory';
  console.log(`Validating ${label}: ${target.path}`);
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

function analyzeZipLayout(filePaths) {
  const normalizedFilePaths = filePaths
    .map((filePath) => normalizeZipPath(String(filePath)))
    .filter(Boolean);
  const filteredFilePaths = normalizedFilePaths.filter((filePath) => !isIgnorableMacOsMetadata(filePath));
  const ignoredMacOsMetadata = filteredFilePaths.length !== normalizedFilePaths.length;

  if (filteredFilePaths.includes('theme.json')) {
    return createZipLayoutAnalysis(filteredFilePaths, '', ignoredMacOsMetadata);
  }

  const rootLevelEntries = filteredFilePaths.filter((filePath) => !filePath.includes('/'));
  if (rootLevelEntries.length > 0) {
    return createZipLayoutAnalysis(filteredFilePaths, '', ignoredMacOsMetadata);
  }

  const topLevels = new Set(filteredFilePaths.map((filePath) => filePath.split('/')[0]).filter(Boolean));
  if (topLevels.size === 1) {
    const folder = [...topLevels][0];
    if (filteredFilePaths.includes(`${folder}/theme.json`)) {
      return createZipLayoutAnalysis(filteredFilePaths, `${folder}/`, ignoredMacOsMetadata);
    }
  }

  if (filteredFilePaths.some((filePath) => filePath.endsWith('/theme.json'))) {
    return {
      error: 'Theme package must be root-flat or wrapped in a single top-level folder',
      ignoredMacOsMetadata,
      checkedFiles: filteredFilePaths.length,
      normalizedFilePaths: filteredFilePaths,
      relativePathByZipPath: new Map(),
    };
  }

  return createZipLayoutAnalysis(filteredFilePaths, '', ignoredMacOsMetadata);
}

function createZipLayoutAnalysis(normalizedFilePaths, basePrefix, ignoredMacOsMetadata) {
  const relativePathByZipPath = new Map();

  for (const normalizedPath of normalizedFilePaths) {
    const relativePath = basePrefix && normalizedPath.startsWith(basePrefix)
      ? normalizedPath.slice(basePrefix.length)
      : normalizedPath;
    relativePathByZipPath.set(normalizedPath, relativePath);
  }

  return {
    error: null,
    ignoredMacOsMetadata,
    checkedFiles: normalizedFilePaths.length,
    normalizedFilePaths,
    relativePathByZipPath,
  };
}

function isIgnorableMacOsMetadata(filePath) {
  if (filePath.startsWith('__MACOSX/')) {
    return true;
  }

  return filePath.split('/').some((segment) => segment.startsWith('._'));
}

function normalizeZipPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function createIssue(code, issuePath, message, severity) {
  return { code, path: issuePath, message, severity };
}
