import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
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
const ZipEntries = require('jszip/lib/zipEntries');
const crc32 = require('jszip/lib/crc32');
const {
  CENTRAL_FILE_HEADER: ZIP_CENTRAL_FILE_HEADER,
  LOCAL_FILE_HEADER: ZIP_LOCAL_FILE_HEADER,
} = require('jszip/lib/signature');
const { utf8decode: decodeZipFileName } = require('jszip/lib/utf8');

export async function runValidate(argv) {
  const jsonRequested = argv.includes('--json');
  let positional;
  let flags;

  try {
    ({ positional, flags } = parseValidateArgs(argv));
    if (!positional[0]) {
      throw new Error('validate requires a themeDir or theme.zip argument');
    }
    if (positional.length !== 1) {
      throw new Error('validate accepts exactly one themeDir or theme.zip argument');
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
    result = target.type === 'zip'
      ? await validateZipFile(target.path)
      : await validateThemeDirectory(target.path);
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
      validation: createInvalidZipIssues([
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
      validation: createInvalidZipIssues([
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
      validation: createInvalidZipIssues([
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
    const collisionKey = zipPathCollisionKey(entry.relativePath);
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

export async function validateZipFile(zipPath) {
  const rawResult = await readArchiveBounded(zipPath);
  if (rawResult.error) {
    return createInvalidZipResult(rawResult);
  }
  return validateZipBuffer(rawResult.raw);
}

export async function validateZipBuffer(rawInput) {
  const raw = Buffer.from(rawInput);
  if (raw.byteLength > THEME_PACKAGE_LIMITS.maxArchiveBytes) {
    return createInvalidZipResult(createZipLayoutError(
      'THEME_ARCHIVE_TOO_LARGE',
      `Theme zip is ${raw.byteLength} bytes; the maximum is ${THEME_PACKAGE_LIMITS.maxArchiveBytes} bytes`,
      0,
    ));
  }
  const envelopeAnalysis = analyzeZipEnvelope(raw);
  if (envelopeAnalysis.error) {
    if (envelopeAnalysis.error.code === 'INVALID_ZIP') {
      throw new Error(envelopeAnalysis.error.message);
    }
    return createInvalidZipResult(envelopeAnalysis);
  }

  const rawEntries = readRawZipEntries(raw);

  const declaredSizeErrors = validateThemePackageLimits(
    new Map(rawEntries
      .filter((entry) => !entry.isDirectory)
      .map((entry, index) => [`${entry.centralPath} [zip entry ${index + 1}]`, entry.uncompressedSize])),
    { entryCount: rawEntries.length },
  );
  if (declaredSizeErrors.length > 0) {
    return createInvalidZipIssues(declaredSizeErrors, rawEntries.filter((entry) => !entry.isDirectory).length);
  }

  const entryPathAnalysis = analyzeRawZipEntryPaths(rawEntries);
  if (entryPathAnalysis.error) {
    return createInvalidZipResult(entryPathAnalysis);
  }

  const zip = await JSZip.loadAsync(raw);
  const analysis = analyzeZipLayout(Object.values(zip.files).filter((file) => !file.dir));
  if (analysis.error) {
    return createInvalidZipResult(analysis);
  }

  const files = new Map();
  const expandedState = { totalBytes: 0 };
  const rawEntriesByPath = new Map(rawEntries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => [zipPathCollisionKey(canonicalZipEntryPath(entry.centralPath, false)), entry]));
  try {
    for (const { file, originalPath, relativePath } of analysis.entries) {
      const rawEntry = rawEntriesByPath.get(zipPathCollisionKey(canonicalZipEntryPath(originalPath, false)));
      files.set(relativePath, await readZipEntryBounded(
        file,
        relativePath,
        expandedState,
        rawEntry?.crc32,
      ));
    }
  } catch (error) {
    if (
      error?.code === 'THEME_FILE_TOO_LARGE'
      || error?.code === 'THEME_PACKAGE_TOO_LARGE'
      || error?.code === 'ZIP_CRC_MISMATCH'
    ) {
      return createInvalidZipIssues([
        createIssue(
          error.code,
          error.path,
          error.message,
          'error',
          error.code === 'ZIP_CRC_MISMATCH' ? { category: 'zip_integrity' } : { category: 'theme_package_limits' },
        ),
      ], analysis.checkedFiles);
    }
    throw error;
  }

  const result = await validateThemeFiles(files, {
    checkedFiles: analysis.checkedFiles,
    entryCount: rawEntries.length,
  });
  return {
    ...result,
    warnings: analysis.ignoredMacOsMetadata
      ? [createIssue('MACOS_METADATA_IGNORED', 'theme.zip', 'macOS metadata files (__MACOSX, ._*) were ignored', 'warning'), ...result.warnings]
      : result.warnings,
    infos: result.infos || [],
  };
}

async function readArchiveBounded(zipPath) {
  const handle = await fs.open(zipPath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return createZipLayoutError('INVALID_ZIP_FILE', 'Theme zip must be a regular file', 0);
    }
    if (stat.size > THEME_PACKAGE_LIMITS.maxArchiveBytes) {
      return createZipLayoutError(
        'THEME_ARCHIVE_TOO_LARGE',
        `Theme zip is ${stat.size} bytes; the maximum is ${THEME_PACKAGE_LIMITS.maxArchiveBytes} bytes`,
        0,
      );
    }

    const raw = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < raw.length) {
      const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return { error: null, raw: offset === raw.length ? raw : raw.subarray(0, offset), checkedFiles: 0 };
  } finally {
    await handle.close();
  }
}

function analyzeZipEnvelope(raw) {
  const minimumEocdSize = 22;
  const minimumOffset = Math.max(0, raw.length - minimumEocdSize - 0xffff);
  let eocdOffset = -1;

  for (let offset = raw.length - minimumEocdSize; offset >= minimumOffset; offset -= 1) {
    if (raw.readUInt32LE(offset) !== 0x06054b50) {
      continue;
    }
    const commentLength = raw.readUInt16LE(offset + 20);
    if (offset + minimumEocdSize + commentLength === raw.length) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset < 0) {
    return createZipLayoutError('INVALID_ZIP', 'Theme zip has no valid end-of-central-directory record', 0);
  }

  const diskNumber = raw.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = raw.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = raw.readUInt16LE(eocdOffset + 8);
  const totalEntries = raw.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = raw.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = raw.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber === 0xffff
    || centralDirectoryDisk === 0xffff
    || entriesOnDisk === 0xffff
    || totalEntries === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    return createZipLayoutError('ZIP64_NOT_SUPPORTED', 'ZIP64 theme packages are not supported', 0);
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    return createZipLayoutError('MULTI_DISK_ZIP_NOT_SUPPORTED', 'Multi-disk theme packages are not supported', 0);
  }
  if (totalEntries > THEME_PACKAGE_LIMITS.maxEntries) {
    return createZipLayoutError(
      'THEME_PACKAGE_TOO_MANY_ENTRIES',
      `Theme zip contains ${totalEntries} entries; the maximum is ${THEME_PACKAGE_LIMITS.maxEntries}`,
      0,
    );
  }

  return { error: null, checkedFiles: 0 };
}

async function readZipEntryBounded(file, relativePath, state, expectedCrc) {
  const chunks = [];
  let fileBytes = 0;
  let actualCrc = 0;

  await new Promise((resolve, reject) => {
    const stream = file.nodeStream('nodebuffer');
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      stream.pause?.();
      stream.destroy?.();
      reject(error);
    };

    stream.on('data', (chunk) => {
      fileBytes += chunk.byteLength;
      if (fileBytes > THEME_PACKAGE_LIMITS.maxFileBytes) {
        fail(createResourceLimitError(
          'THEME_FILE_TOO_LARGE',
          relativePath,
          `Theme file exceeds the per-file maximum of ${THEME_PACKAGE_LIMITS.maxFileBytes} bytes while decompressing`,
        ));
        return;
      }
      state.totalBytes += chunk.byteLength;
      if (state.totalBytes > THEME_PACKAGE_LIMITS.maxUncompressedBytes) {
        fail(createResourceLimitError(
          'THEME_PACKAGE_TOO_LARGE',
          'theme package',
          `Theme package exceeds the expanded maximum of ${THEME_PACKAGE_LIMITS.maxUncompressedBytes} bytes while decompressing`,
        ));
        return;
      }
      actualCrc = crc32(chunk, actualCrc);
      chunks.push(chunk);
    });
    stream.once('error', fail);
    stream.once('end', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });

  if (expectedCrc !== undefined && (actualCrc >>> 0) !== (expectedCrc >>> 0)) {
    throw createResourceLimitError(
      'ZIP_CRC_MISMATCH',
      relativePath,
      `Theme zip entry CRC32 does not match its central directory value: ${relativePath}`,
    );
  }

  return Buffer.concat(chunks, fileBytes);
}

function createResourceLimitError(code, resourcePath, message) {
  const error = new Error(message);
  error.code = code;
  error.path = resourcePath;
  return error;
}

function createInvalidZipResult(analysis) {
  return {
    ok: false,
    errors: [createIssue(analysis.error.code, 'theme.zip', analysis.error.message, 'error')],
    warnings: [],
    infos: [],
    manifest: undefined,
    checkedFiles: analysis.checkedFiles,
  };
}

function createInvalidZipIssues(errors, checkedFiles) {
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
  return createInvalidZipIssues(errors, checkedFiles);
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
  if (stat.isFile() && path.extname(inputPath).toLowerCase() === '.zip') {
    return { type: 'zip', path: inputPath };
  }
  throw new Error(`Validate expects a theme directory or .zip file: ${inputPath}`);
}

function printHuman(result, target) {
  const label = target.type === 'zip' ? 'theme zip' : 'theme directory';
  const color = createColor(process.stdout);
  const warnings = result.warnings || [];
  const infos = groupHumanInfos(result.infos || []);
  const blocks = [];
  const status = validationStatus(result);
  blocks.push([
    colorStatus(status.title, status.level, color),
    `Target: ${toTerminalSafeText(target.path)} (${label})`,
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

function analyzeZipLayout(files) {
  const normalizedEntries = [];

  for (const file of files) {
    const originalPath = String(file.unsafeOriginalName ?? file.name ?? '');
    const normalizedPath = normalizeZipPath(originalPath);
    const pathError = validateZipEntryPath(normalizedPath);
    if (pathError) {
      return createZipLayoutError(
        'INVALID_ZIP_ENTRY_PATH',
        `Invalid zip entry path ${JSON.stringify(originalPath)}: ${pathError}`,
        files.length,
      );
    }

    normalizedEntries.push({
      file,
      originalPath,
      normalizedPath,
    });
  }

  const filteredEntries = normalizedEntries.filter(({ normalizedPath }) => !isIgnorableMacOsMetadata(normalizedPath));
  const ignoredMacOsMetadata = filteredEntries.length !== normalizedEntries.length;
  const seenPaths = new Map();

  for (const entry of filteredEntries) {
    const collisionKey = zipPathCollisionKey(entry.normalizedPath);
    if (seenPaths.has(collisionKey)) {
      return createZipLayoutError(
        'ZIP_PATH_COLLISION',
        `Zip entry path collision: '${entry.originalPath}' conflicts with '${seenPaths.get(collisionKey)}'`,
        filteredEntries.length,
        ignoredMacOsMetadata,
      );
    }
    seenPaths.set(collisionKey, entry.originalPath);
  }

  const normalizedFilePaths = filteredEntries.map(({ normalizedPath }) => normalizedPath);

  if (normalizedFilePaths.includes('theme.json')) {
    return createZipLayoutAnalysis(filteredEntries, '', ignoredMacOsMetadata);
  }

  const rootLevelEntries = normalizedFilePaths.filter((filePath) => !filePath.includes('/'));
  if (rootLevelEntries.length > 0) {
    return createZipLayoutAnalysis(filteredEntries, '', ignoredMacOsMetadata);
  }

  const topLevels = new Set(normalizedFilePaths.map((filePath) => filePath.split('/')[0]).filter(Boolean));
  if (topLevels.size === 1) {
    const folder = [...topLevels][0];
    if (normalizedFilePaths.includes(`${folder}/theme.json`)) {
      return createZipLayoutAnalysis(filteredEntries, `${folder}/`, ignoredMacOsMetadata);
    }
  }

  if (normalizedFilePaths.some((filePath) => filePath.endsWith('/theme.json'))) {
    return createZipLayoutError(
      'INVALID_ZIP_ROOT',
      'Theme package must be root-flat or wrapped in a single top-level folder',
      filteredEntries.length,
      ignoredMacOsMetadata,
    );
  }

  return createZipLayoutAnalysis(filteredEntries, '', ignoredMacOsMetadata);
}

function readRawZipEntries(raw) {
  const zipEntries = new ZipEntries({ decodeFileName: decodeZipFileName });
  zipEntries.load(raw);
  if (zipEntries.centralDirRecords !== zipEntries.files.length) {
    throw new Error(
      `Corrupted zip: expected ${zipEntries.centralDirRecords} central directory entries, found ${zipEntries.files.length}`,
    );
  }
  const centralEntries = readCentralZipEntries(zipEntries);

  return zipEntries.files.map((entry, index) => {
    const centralEntry = centralEntries[index];
    const localEntry = readLocalZipEntry(zipEntries.reader, entry.localHeaderOffset);

    return {
      centralPath: centralEntry.path,
      centralRawPath: centralEntry.rawPath,
      centralUnicodePath: centralEntry.unicodePath,
      centralFileName: centralEntry.fileName,
      localPath: localEntry.path,
      localRawPath: localEntry.rawPath,
      localUnicodePath: localEntry.unicodePath,
      localFileName: localEntry.fileName,
      jsZipPath: String(entry.fileNameStr ?? localEntry.path),
      isDirectory: centralEntry.isDirectory || localEntry.isDirectory || entry.dir === true,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      crc32: centralEntry.crc32,
      isSymlink: centralEntry.isSymlink,
    };
  });
}

function readCentralZipEntries(zipEntries) {
  const reader = zipEntries.reader;
  const entries = [];
  reader.setIndex(zipEntries.centralDirOffset);

  for (let index = 0; index < zipEntries.files.length; index += 1) {
    if (!reader.readAndCheckSignature(ZIP_CENTRAL_FILE_HEADER)) {
      throw new Error('Corrupted zip: central directory entry is missing');
    }

    const versionMadeBy = reader.readInt(2);
    reader.skip(2); // version needed to extract
    const bitFlag = reader.readInt(2);
    reader.skip(6); // compression and timestamps
    const expectedCrc = reader.readInt(4) >>> 0;
    reader.skip(8); // compressed and uncompressed sizes
    const fileNameLength = reader.readInt(2);
    const extraFieldsLength = reader.readInt(2);
    const fileCommentLength = reader.readInt(2);
    reader.skip(4); // disk number and internal attributes
    const externalFileAttributes = reader.readInt(4);
    reader.skip(4); // local header offset

    const fileName = Buffer.from(reader.readData(fileNameLength));
    const extraFields = Buffer.from(reader.readData(extraFieldsLength));
    reader.skip(fileCommentLength);

    const {
      path: decodedPath,
      rawPath,
      unicodePath,
    } = decodeRawZipEntryPath(fileName, extraFields, bitFlag);

    entries.push({
      path: decodedPath,
      rawPath,
      unicodePath,
      fileName,
      crc32: expectedCrc,
      isSymlink: (versionMadeBy >>> 8) === 3
        && (((externalFileAttributes >>> 16) & 0xffff) & 0o170000) === 0o120000,
      isDirectory: (externalFileAttributes & 0x0010) !== 0
        || decodedPath.endsWith('/')
        || rawPath.endsWith('/'),
    });
  }

  return entries;
}

function readLocalZipEntry(reader, localHeaderOffset) {
  reader.setIndex(localHeaderOffset);
  if (!reader.readAndCheckSignature(ZIP_LOCAL_FILE_HEADER)) {
    throw new Error('Corrupted zip: local file header is missing');
  }

  reader.skip(2); // version needed to extract
  const bitFlag = reader.readInt(2);
  reader.skip(18); // compression, timestamps, CRC, and sizes
  const fileNameLength = reader.readInt(2);
  const extraFieldsLength = reader.readInt(2);
  const fileName = Buffer.from(reader.readData(fileNameLength));
  const extraFields = Buffer.from(reader.readData(extraFieldsLength));
  const {
    path: decodedPath,
    rawPath,
    unicodePath,
  } = decodeRawZipEntryPath(fileName, extraFields, bitFlag);

  return {
    path: decodedPath,
    rawPath,
    unicodePath,
    fileName,
    isDirectory: decodedPath.endsWith('/') || rawPath.endsWith('/'),
  };
}

function decodeRawZipEntryPath(fileName, extraFields, bitFlag) {
  const rawPath = decodeZipFileName(fileName);
  const unicodePath = readUnicodeZipPath(extraFields, fileName);
  const usesUtf8 = (bitFlag & 0x0800) !== 0;

  return {
    path: usesUtf8 ? rawPath : unicodePath ?? rawPath,
    rawPath,
    unicodePath,
  };
}

function readUnicodeZipPath(extraFields, fileName) {
  let offset = 0;
  let unicodePath = null;

  while (offset + 4 <= extraFields.length) {
    const fieldId = extraFields.readUInt16LE(offset);
    const fieldLength = extraFields.readUInt16LE(offset + 2);
    const valueOffset = offset + 4;
    const nextOffset = valueOffset + fieldLength;
    if (nextOffset > extraFields.length) {
      throw new Error('Corrupted zip: invalid central directory extra field length');
    }

    if (fieldId === 0x7075 && fieldLength >= 5) {
      const version = extraFields[valueOffset];
      const expectedCrc = extraFields.readUInt32LE(valueOffset + 1);
      if (version === 1 && expectedCrc === (crc32(fileName) >>> 0)) {
        const candidatePath = decodeZipFileName(extraFields.subarray(valueOffset + 5, nextOffset));
        if (unicodePath !== null && candidatePath !== unicodePath) {
          throw new Error('Corrupted zip: conflicting Unicode path extra fields');
        }
        unicodePath = candidatePath;
      }
    }

    offset = nextOffset;
  }

  if (offset !== extraFields.length) {
    throw new Error('Corrupted zip: invalid central directory extra field');
  }

  return unicodePath;
}

function analyzeRawZipEntryPaths(entries) {
  const checkedFiles = entries.filter((entry) => !entry.isDirectory).length;
  const seenRawFileNames = new Map();
  const seenPaths = new Map();

  for (const entry of entries) {
    if (entry.isSymlink) {
      return createZipLayoutError(
        'SYMLINK_NOT_ALLOWED',
        `Symbolic links are not allowed in theme packages: ${entry.centralPath}`,
        checkedFiles,
      );
    }

    const pathRepresentations = [
      ['central directory', entry.centralRawPath],
      ['central directory Unicode', entry.centralPath],
      ['local header', entry.localRawPath],
      ['local header Unicode', entry.localPath],
      ['JSZip decoded', entry.jsZipPath],
    ];
    if (entry.centralUnicodePath !== null) {
      pathRepresentations.push(['central directory Unicode extra', entry.centralUnicodePath]);
    }
    if (entry.localUnicodePath !== null) {
      pathRepresentations.push(['local header Unicode extra', entry.localUnicodePath]);
    }

    const comparablePaths = pathRepresentations.map(([source, entryPath]) => [
      source,
      canonicalZipEntryPath(entryPath, entry.isDirectory),
      entryPath,
    ]);
    if (entry.isDirectory && comparablePaths.every(([, comparablePath]) => comparablePath === '')) {
      continue;
    }

    for (const [source, comparablePath, entryPath] of comparablePaths) {
      const pathError = validateZipEntryPath(comparablePath);
      if (pathError) {
        return createZipLayoutError(
          'INVALID_ZIP_ENTRY_PATH',
          `Invalid ${source} zip entry path ${JSON.stringify(entryPath)}: ${pathError}`,
          checkedFiles,
        );
      }
    }

    const centralDeclaredPath = entry.centralUnicodePath ?? entry.centralPath;
    const localDeclaredPath = entry.localUnicodePath ?? entry.localPath;
    if (
      !entry.centralFileName.equals(entry.localFileName)
      || entry.centralPath !== entry.localPath
      || entry.centralPath !== entry.jsZipPath
      || centralDeclaredPath !== entry.centralPath
      || localDeclaredPath !== entry.localPath
      || centralDeclaredPath !== localDeclaredPath
    ) {
      return createZipLayoutError(
        'ZIP_ENTRY_NAME_MISMATCH',
        `Zip central directory path ${JSON.stringify(entry.centralPath)} does not match local header path ${JSON.stringify(entry.localPath)}`,
        checkedFiles,
      );
    }

    const rawPath = canonicalZipEntryPath(entry.centralRawPath, entry.isDirectory);
    const normalizedPath = canonicalZipEntryPath(entry.centralPath, entry.isDirectory);
    if (isIgnorableMacOsMetadata(normalizedPath)) {
      continue;
    }

    const rawFileNameKey = rawZipFileNameCollisionKey(entry.centralFileName);
    if (seenRawFileNames.has(rawFileNameKey)) {
      return createZipLayoutError(
        'ZIP_PATH_COLLISION',
        `Zip entry path collision: ${JSON.stringify(entry.centralRawPath)} conflicts with ${JSON.stringify(seenRawFileNames.get(rawFileNameKey))}`,
        checkedFiles,
      );
    }
    seenRawFileNames.set(rawFileNameKey, entry.centralRawPath);

    const collisionKey = zipPathCollisionKey(normalizedPath);
    if (seenPaths.has(collisionKey)) {
      return createZipLayoutError(
        'ZIP_PATH_COLLISION',
        `Zip entry path collision: ${JSON.stringify(entry.centralPath)} conflicts with ${JSON.stringify(seenPaths.get(collisionKey))}`,
        checkedFiles,
      );
    }
    seenPaths.set(collisionKey, entry.centralPath);
  }

  return { error: null, checkedFiles };
}

function zipPathWithoutDirectoryMarker(filePath, isDirectory) {
  return isDirectory && filePath.endsWith('/') ? filePath.slice(0, -1) : filePath;
}

function canonicalZipEntryPath(filePath, isDirectory) {
  return zipPathWithoutDirectoryMarker(normalizeZipPath(filePath), isDirectory);
}

function rawZipFileNameCollisionKey(fileName) {
  const folded = Buffer.from(fileName);
  for (let index = 0; index < folded.length; index += 1) {
    if (folded[index] >= 0x41 && folded[index] <= 0x5a) {
      folded[index] += 0x20;
    }
  }
  return folded.toString('hex');
}

function createZipLayoutAnalysis(entries, basePrefix, ignoredMacOsMetadata) {
  return {
    error: null,
    ignoredMacOsMetadata,
    checkedFiles: entries.length,
    entries: entries.map((entry) => ({
      ...entry,
      relativePath: basePrefix && entry.normalizedPath.startsWith(basePrefix)
        ? entry.normalizedPath.slice(basePrefix.length)
        : entry.normalizedPath,
    })),
  };
}

function createZipLayoutError(code, message, checkedFiles, ignoredMacOsMetadata = false) {
  return {
    error: { code, message },
    ignoredMacOsMetadata,
    checkedFiles,
    entries: [],
  };
}

function validateZipEntryPath(filePath) {
  if (!filePath) {
    return 'entry path must not be empty';
  }
  if (/[\u0000-\u001f\u007f]/u.test(filePath)) {
    return 'control characters are not allowed';
  }
  if (filePath.includes('\\')) {
    return 'backslash path separators are not allowed';
  }
  if (path.posix.isAbsolute(filePath)) {
    return 'absolute paths are not allowed';
  }
  if (/^[a-zA-Z]:/.test(filePath)) {
    return 'drive paths are not allowed';
  }

  const segments = filePath.split('/');
  if (segments.some((segment) => segment === '')) {
    return 'empty path segments are not allowed';
  }
  if (segments.some((segment) => segment === '.')) {
    return "'.' path segments are not allowed";
  }
  if (segments.some((segment) => segment === '..')) {
    return "'..' path segments are not allowed";
  }

  return null;
}

function isIgnorableMacOsMetadata(filePath) {
  if (filePath === '__MACOSX' || filePath.startsWith('__MACOSX/')) {
    return true;
  }

  return filePath.split('/').some((segment) => segment.startsWith('._'));
}

function normalizeZipPath(filePath) {
  return String(filePath || '');
}

function zipPathCollisionKey(filePath) {
  return filePath.normalize('NFC').toLowerCase();
}

function createIssue(code, issuePath, message, severity, details = {}) {
  return { code, path: issuePath, message, severity, ...details };
}
