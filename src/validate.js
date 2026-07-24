import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import {
  THEME_PACKAGE_LIMITS,
  validateThemeFiles,
  validateThemePackageLimits,
} from '@zeropress/theme-validator';
import {
  BOUNDED_READ_LIMIT_EXCEEDED,
  readFileHandleBounded,
} from './bounded-read.js';
import { createColor } from './color.js';
import { getThemeDir, resolveCanonicalDirectoryRoot, walkDirectory } from './helpers.js';
import { toTerminalSafeMultilineText, toTerminalSafeText } from './terminal.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json');

export async function runValidate(argv) {
  const jsonRequested = argv.includes('--json');
  let positional;
  let flags;

  try {
    ({ positional, flags } = parseValidateArgs(argv));
    if (!positional[0]) {
      throw new Error('validate requires a themeDir argument');
    }
    if (positional.length !== 1) {
      throw new Error('validate accepts exactly one themeDir argument');
    }
  } catch (error) {
    if (!jsonRequested) {
      throw error;
    }
    const result = createValidationErrorResult('command line', error, {
      code: 'CLI_ARGUMENT_ERROR',
      category: 'cli_arguments',
    });
    writeJsonOutput(result);
    return 1;
  }

  const targetPath = getThemeDir(positional[0]);
  const json = flags.json === true;
  let target;
  let result;

  try {
    target = await resolveValidationTarget(targetPath);
    result = await validateThemeDirectory(target.path);
  } catch (error) {
    if (!json) {
      throw error;
    }
    result = createValidationErrorResult(targetPath, error, error?.code === 'SYMLINK_NOT_ALLOWED'
      ? { code: error.code, category: 'theme_package_paths' }
      : undefined);
  }

  if (json) {
    writeJsonOutput(result);
  } else {
    printHuman(result, target);
  }

  if (result.errors.length > 0) {
    return 1;
  }
  return 0;
}

function parseValidateArgs(argv) {
  const positional = [];
  const flags = { json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
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

export async function validateThemeDirectory(themeDir, { shouldInclude } = {}) {
  const loaded = await loadThemeDirectorySnapshot(themeDir, { shouldInclude });
  if (loaded.validation) {
    return loaded.validation;
  }
  return validateThemeDirectorySnapshot(loaded.snapshot);
}

export async function loadThemeDirectorySnapshot(themeDir, { shouldInclude } = {}) {
  let canonicalThemeDir;
  try {
    canonicalThemeDir = await resolveCanonicalDirectoryRoot(themeDir, { label: 'Theme directory' });
  } catch (error) {
    if (error?.code !== 'SYMLINK_NOT_ALLOWED') {
      throw error;
    }
    return {
      snapshot: null,
      validation: createValidationIssues([
        createIssue(
          'SYMLINK_NOT_ALLOWED',
          'theme directory',
          error.message,
          'error',
          { category: 'theme_package_paths' },
        ),
      ], 0),
    };
  }

  let allEntries;
  try {
    allEntries = await walkDirectory(canonicalThemeDir, {
      shouldInclude,
      maxEntries: THEME_PACKAGE_LIMITS.maxEntries,
    });
  } catch (error) {
    if (error?.code === 'THEME_PACKAGE_TOO_MANY_ENTRIES') {
      return {
        snapshot: null,
        validation: createThemePackageLimitResult([
          createIssue(
            error.code,
            'theme package',
            `Theme package contains more than ${THEME_PACKAGE_LIMITS.maxEntries} entries; the maximum is ${THEME_PACKAGE_LIMITS.maxEntries}`,
            'error',
            { category: 'theme_package_limits' },
          ),
        ], 0),
      };
    }
    throw error;
  }
  const files = new Map();
  const fileSizes = new Map();
  const pathEntries = [];
  const pathEntriesByPath = new Map();
  let totalBytesRead = 0;

  const unsafeBackslashEntry = allEntries.find((item) => item.hasLiteralBackslash);
  if (unsafeBackslashEntry) {
    return {
      snapshot: null,
      validation: createValidationIssues([
        createIssue(
          'PATH_ESCAPE',
          unsafeBackslashEntry.rawRelativePath,
          `Backslashes are not allowed in theme package paths: ${unsafeBackslashEntry.rawRelativePath}`,
          'error',
          { category: 'theme_package_paths' },
        ),
      ], 0),
    };
  }

  const pathCollision = findThemeDirectoryPathCollision(allEntries);
  if (pathCollision) {
    return {
      snapshot: null,
      validation: createValidationIssues([
        createIssue(
          'THEME_PATH_COLLISION',
          pathCollision.path,
          `Theme package path collision: '${pathCollision.path}' conflicts with '${pathCollision.existingPath}' after NFC and case normalization`,
          'error',
          { category: 'theme_package_paths' },
        ),
      ], 0),
    };
  }

  for (const item of allEntries) {
    const stat = await fs.lstat(item.fullPath);
    const pathEntry = {
      path: item.relativePath,
      isSymlink: stat.isSymbolicLink(),
    };
    pathEntries.push(pathEntry);
    pathEntriesByPath.set(item.relativePath, pathEntry);

    if (item.entry.isFile()) {
      fileSizes.set(item.relativePath, stat.size);
    }
  }

  const limitErrors = validateThemePackageLimits(fileSizes, { entryCount: allEntries.length });
  if (limitErrors.length > 0) {
    return {
      snapshot: null,
      validation: createThemePackageLimitResult(limitErrors, fileSizes.size),
    };
  }

  for (const item of allEntries) {
    const pathEntry = pathEntriesByPath.get(item.relativePath);
    if (!item.entry.isFile() || pathEntry?.isSymlink) {
      continue;
    }

    let handle;
    try {
      handle = await fs.open(
        item.fullPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
      );
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        continue;
      }
      fileSizes.set(item.relativePath, openedStat.size);
      const openedLimitErrors = validateThemePackageLimits(fileSizes, { entryCount: allEntries.length });
      if (openedLimitErrors.length > 0) {
        return {
          snapshot: null,
          validation: createThemePackageLimitResult(openedLimitErrors, fileSizes.size),
        };
      }
      const remainingPackageBytes = THEME_PACKAGE_LIMITS.maxUncompressedBytes - totalBytesRead;
      const maxReadBytes = Math.min(
        THEME_PACKAGE_LIMITS.maxFileBytes,
        remainingPackageBytes,
      );
      let content;
      try {
        content = await readFileHandleBounded(handle, maxReadBytes);
      } catch (error) {
        if (error?.code !== BOUNDED_READ_LIMIT_EXCEEDED) {
          throw error;
        }
        const packageLimitReached = remainingPackageBytes < THEME_PACKAGE_LIMITS.maxFileBytes;
        const limitError = packageLimitReached
          ? createIssue(
            'THEME_PACKAGE_TOO_LARGE',
            'theme package',
            `Theme package exceeds the expanded maximum of ${THEME_PACKAGE_LIMITS.maxUncompressedBytes} bytes`,
            'error',
            { category: 'theme_package_limits' },
          )
          : createIssue(
            'THEME_FILE_TOO_LARGE',
            item.relativePath,
            `Theme file '${item.relativePath}' exceeds the per-file maximum of ${THEME_PACKAGE_LIMITS.maxFileBytes} bytes`,
            'error',
            { category: 'theme_package_limits' },
          );
        return {
          snapshot: null,
          validation: createThemePackageLimitResult([limitError], files.size),
        };
      }
      totalBytesRead += content.byteLength;
      fileSizes.set(item.relativePath, content.byteLength);
      files.set(item.relativePath, content);
    } catch (error) {
      if (error?.code === 'ELOOP') {
        pathEntry.isSymlink = true;
        fileSizes.delete(item.relativePath);
        continue;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  return {
    snapshot: {
      canonicalThemeDir,
      files,
      pathEntries,
      checkedFiles: fileSizes.size,
      entryCount: allEntries.length,
    },
    validation: null,
  };
}

export async function validateThemeDirectorySnapshot(snapshot) {
  return validateThemeFiles(snapshot.files, {
    pathEntries: snapshot.pathEntries,
    checkedFiles: snapshot.checkedFiles,
    entryCount: snapshot.entryCount,
  });
}

function findThemeDirectoryPathCollision(entries) {
  const seenPaths = new Map();
  for (const entry of entries) {
    const collisionKey = themePathCollisionKey(entry.relativePath);
    const existingPath = seenPaths.get(collisionKey);
    if (existingPath !== undefined) {
      return {
        path: entry.relativePath,
        existingPath,
      };
    }
    seenPaths.set(collisionKey, entry.relativePath);
  }
  return null;
}

function themePathCollisionKey(filePath) {
  return filePath.normalize('NFC').toLowerCase();
}

function createValidationIssues(errors, checkedFiles) {
  return {
    ok: false,
    errors,
    warnings: [],
    infos: [],
    manifest: undefined,
    checkedFiles,
  };
}

function createThemePackageLimitResult(errors, checkedFiles) {
  return createValidationIssues(errors, checkedFiles);
}

async function resolveValidationTarget(inputPath) {
  const stat = await fs.lstat(inputPath);
  if (stat.isSymbolicLink()) {
    const error = new Error(`Validate target must not be a symbolic link: ${inputPath}`);
    error.code = 'SYMLINK_NOT_ALLOWED';
    throw error;
  }
  if (stat.isDirectory()) {
    return { type: 'directory', path: inputPath };
  }
  throw new Error(`Validate expects a theme directory: ${inputPath}`);
}

function printHuman(result, target) {
  const color = createColor(process.stdout);
  const warnings = result.warnings || [];
  const infos = groupHumanInfos(result.infos || []);
  const blocks = [];
  const status = validationStatus(result);
  blocks.push([
    colorStatus(status.title, status.level, color),
    `Target: ${toTerminalSafeText(target.path)} (theme directory)`,
    `Errors: ${result.errors.length}`,
    `Warnings: ${result.warnings.length}`,
    `Info: ${(result.infos || []).length}`,
    `Checked files: ${result.checkedFiles}`,
  ].join('\n'));

  for (const error of result.errors) {
    blocks.push(formatHumanIssue('error', error, { color }));
  }
  for (const warning of warnings) {
    blocks.push(formatHumanIssue('warning', warning, { color }));
  }
  for (const info of infos) {
    blocks.push(formatHumanIssue('info', info, { color }));
  }

  console.log(blocks.join('\n\n'));
}

function validationStatus(result) {
  if (result.errors.length > 0) {
    return {
      level: 'error',
      title: 'Theme validation failed',
    };
  }

  if (result.warnings.length > 0) {
    return {
      level: 'warning',
      title: 'Theme validation passed with warnings',
    };
  }

  return {
    level: 'success',
    title: 'Theme validation passed',
  };
}

function groupHumanInfos(infos) {
  const optionalTemplateInfos = infos.filter((info) => info.code === 'MISSING_OPTIONAL_TEMPLATE');
  const otherInfos = infos.filter((info) => info.code !== 'MISSING_OPTIONAL_TEMPLATE');

  if (optionalTemplateInfos.length === 0) {
    return otherInfos;
  }

  return [
    ...otherInfos,
    {
      code: 'MISSING_OPTIONAL_TEMPLATES',
      severity: 'info',
      paths: optionalTemplateInfos.map((info) => info.path),
      message: 'Optional route templates are missing.',
      hint: 'This does not block validation. Add these files only if the theme wants archive, category, or tag pages.',
    },
  ];
}

function formatHumanIssue(level, issue, options = {}) {
  const color = options.color || createColor(process.stdout);
  const lines = [formatIssueHeading(level, issue.code, color)];
  if (Array.isArray(issue.paths) && issue.paths.length > 0) {
    lines.push(`Files: ${issue.paths.map(toTerminalSafeText).join(', ')}`);
  } else {
    const location = splitIssuePath(issue.path);
    if (location.file) {
      lines.push(`File: ${toTerminalSafeText(location.file)}`);
    }
    if (location.path) {
      lines.push(`Path: ${toTerminalSafeText(location.path)}`);
    }
  }
  if (issue.line) {
    const location = issue.column ? `Line: ${issue.line}, Column: ${issue.column}` : `Line: ${issue.line}`;
    lines.push(location);
  }
  if (issue.category) {
    lines.push(`Category: ${toTerminalSafeText(issue.category)}`);
  }
  lines.push(`Reason: ${toTerminalSafeText(issue.message)}`);
  if (issue.snippet) {
    const lineLabel = issue.line ? String(issue.line) : '';
    lines.push(
      '',
      `${lineLabel} | ${toTerminalSafeText(issue.snippet.line)}`,
      `${' '.repeat(lineLabel.length)} | ${toTerminalSafeText(issue.snippet.pointer)}`,
    );
  }
  if (issue.hint) {
    lines.push('', 'Hint:', toTerminalSafeMultilineText(issue.hint));
  }
  return lines.join('\n');
}

function splitIssuePath(issuePath) {
  const normalizedPath = String(issuePath || '');
  if (normalizedPath.startsWith('theme.json.')) {
    return {
      file: 'theme.json',
      path: normalizedPath.slice('theme.json.'.length),
    };
  }

  return { file: normalizedPath, path: '' };
}

function colorStatus(value, level, color) {
  if (level === 'error') {
    return color.red(value);
  }
  if (level === 'warning') {
    return color.yellow(value);
  }
  if (level === 'info') {
    return color.blue(value);
  }
  return color.green(value);
}

function formatIssueHeading(level, code, color) {
  const safeCode = toTerminalSafeText(code);
  if (level === 'error') {
    return color.red(`ERROR ${safeCode}`);
  }
  if (level === 'info') {
    return color.blue(`INFO  ${safeCode}`);
  }
  return color.yellow(`WARN  ${safeCode}`);
}

function createValidationErrorResult(targetPath, error, {
  code = 'VALIDATION_ERROR',
  category,
} = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    errors: [createIssue(code, targetPath, message, 'error', category ? { category } : {})],
    warnings: [],
    infos: [],
    manifest: undefined,
    checkedFiles: 0,
  };
}

function writeJsonOutput(result) {
  process.stdout.write(`${JSON.stringify(toJsonOutput(result), null, 2)}\n`);
}

function toJsonOutput(result) {
  return {
    ok: result.errors.length === 0,
    summary: {
      errors: result.errors.length,
      warnings: result.warnings.length,
      infos: (result.infos || []).length,
      checkedFiles: result.checkedFiles,
    },
    errors: result.errors,
    warnings: result.warnings,
    infos: result.infos || [],
    meta: {
      schemaVersion: '1',
      tool: 'zeropress-theme',
      toolVersion: PACKAGE_VERSION,
      timestamp: new Date().toISOString(),
    },
  };
}


function createIssue(code, issuePath, message, severity, details = {}) {
  return { code, path: issuePath, message, severity, ...details };
}
