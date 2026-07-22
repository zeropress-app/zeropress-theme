import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import {
  THEME_PACKAGE_LIMITS,
  validateThemeManifest,
} from '@zeropress/theme-validator';
import {
  BOUNDED_READ_LIMIT_EXCEEDED,
  readFileHandleBounded,
} from './bounded-read.js';
import { EXCLUDE_DEFAULTS } from './constants.js';
import {
  getThemeDir,
  normalizeSlashes,
  resolveCanonicalDirectoryRoot,
} from './helpers.js';
import { toTerminalSafeText } from './terminal.js';
import {
  loadThemeDirectorySnapshot,
  validateThemeDirectorySnapshot,
  validateZipBuffer,
} from './validate.js';

const CANONICAL_ZIP_ENTRY_DATE_MS = Date.UTC(1980, 0, 1, 0, 0, 0, 0);

export async function runPack(argv) {
  const { positional, flags } = parsePackArgs(argv);
  if (!positional[0]) {
    throw new Error('pack requires a themeDir argument');
  }
  if (positional.length !== 1) {
    throw new Error('pack accepts exactly one themeDir argument');
  }
  const requestedThemeDir = getThemeDir(positional[0]);
  const themeDir = await resolveCanonicalDirectoryRoot(requestedThemeDir, { label: 'Theme directory' });
  const requestedOutDir = path.resolve(process.cwd(), flags.out || 'dist');
  const requestedFileName = flags.name ? validatePackFileName(flags.name) : null;
  const dryRun = flags['dry-run'] === true;
  const outDir = await resolveCanonicalPackOutputDirectory(requestedOutDir);
  const outputDirRelativePath = relativePathInside(themeDir, outDir);
  const excludedOutputDirRelativePath = outputDirRelativePath === ''
    ? null
    : outputDirRelativePath;
  const fileName = requestedFileName || await readDefaultPackFileName(themeDir);
  const zipPath = path.resolve(outDir, fileName);
  const outputFileRelativePath = relativePathInside(themeDir, zipPath);

  const loadedTheme = await loadThemeDirectorySnapshot(themeDir, {
    shouldInclude: createPackShouldInclude({
      outputDirRelativePath: excludedOutputDirRelativePath,
      outputFileRelativePath,
    }),
  });
  const preValidation = loadedTheme.validation
    || await validateThemeDirectorySnapshot(loadedTheme.snapshot);
  if (preValidation.errors.length > 0) {
    const firstErrorMessage = preValidation.errors[0]?.message;
    throw new Error(
      `Pack aborted: validate failed with ${preValidation.errors.length} error(s)`
      + (firstErrorMessage ? `: ${firstErrorMessage}` : ''),
    );
  }
  if (!loadedTheme.snapshot || !preValidation.manifest) {
    throw new Error('Pack aborted: normalized theme manifest is unavailable after validation');
  }

  const defaultName = defaultPackFileName(preValidation.manifest);
  if (!requestedFileName && defaultName !== fileName) {
    throw new Error('Pack aborted: theme.json changed during packaging; retry');
  }

  const includedFiles = [...loadedTheme.snapshot.files].map(([zipPath, content]) => ({
    zipPath,
    content,
  }));

  await inspectPackOutput(outDir, fileName);
  const zip = new JSZip();

  for (const file of includedFiles) {
    zip.file(file.zipPath, file.content, {
      createFolders: false,
      date: new Date(CANONICAL_ZIP_ENTRY_DATE_MS),
    });
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    platform: 'DOS',
  });
  if (buffer.byteLength > THEME_PACKAGE_LIMITS.maxArchiveBytes) {
    throw new Error(
      `Pack aborted: generated zip is ${buffer.byteLength} bytes; the maximum is ${THEME_PACKAGE_LIMITS.maxArchiveBytes} bytes`,
    );
  }
  const bufferValidation = await validateZipBuffer(buffer);
  if (bufferValidation.errors.length > 0) {
    throw new Error(`Pack aborted: generated zip re-validation failed with ${bufferValidation.errors.length} error(s)`);
  }
  if (
    !requestedFileName
    && (
      !bufferValidation.manifest
      || defaultPackFileName(bufferValidation.manifest) !== fileName
    )
  ) {
    throw new Error('Pack aborted: theme.json changed during packaging; retry');
  }

  if (dryRun) {
    console.log(`Dry run: would pack theme to ${toTerminalSafeText(zipPath)}`);
    console.log(`Included files: ${includedFiles.length}`);
    for (const file of includedFiles) {
      console.log(` - ${toTerminalSafeText(file.zipPath)}`);
    }
    if (bufferValidation.warnings.length > 0) {
      console.log(`Validation warnings: ${bufferValidation.warnings.length}`);
    }
    return;
  }

  const output = await preparePackOutput(outDir, fileName);
  await writeZipAtomically(output, buffer);

  console.log(`Packed theme: ${toTerminalSafeText(output.zipPath)}`);
  if (bufferValidation.warnings.length > 0) {
    console.log(`Pack warnings: ${bufferValidation.warnings.length}`);
  }
}

async function readDefaultPackFileName(themeDir) {
  const manifestPath = path.join(themeDir, 'theme.json');
  let handle;
  try {
    handle = await fs.open(
      manifestPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('theme.json must be a regular file');
    }
    if (stat.size > THEME_PACKAGE_LIMITS.maxFileBytes) {
      throw new Error(`theme.json exceeds the maximum of ${THEME_PACKAGE_LIMITS.maxFileBytes} bytes`);
    }
    const content = await readFileHandleBounded(handle, THEME_PACKAGE_LIMITS.maxFileBytes);
    const result = validateThemeManifest(JSON.parse(content.toString('utf8')));
    if (!result.ok || !result.manifest) {
      throw new Error(
        `theme.json manifest validation failed`
        + (result.errors?.[0]?.message ? `: ${result.errors[0].message}` : ''),
      );
    }
    return defaultPackFileName(result.manifest);
  } catch (error) {
    let reason = error?.message || String(error);
    if (error?.code === 'ENOENT') {
      reason = 'theme.json was not found';
    } else if (error?.code === 'ELOOP') {
      reason = 'theme.json must not be a symbolic link';
    } else if (error?.code === BOUNDED_READ_LIMIT_EXCEEDED) {
      reason = `theme.json exceeds the maximum of ${THEME_PACKAGE_LIMITS.maxFileBytes} bytes`;
    } else if (error instanceof SyntaxError) {
      reason = `theme.json contains invalid JSON: ${error.message}`;
    }
    throw new Error(`Pack aborted: cannot determine the default archive name: ${reason}`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

function defaultPackFileName(manifest) {
  return `${manifest.namespace}.${manifest.slug}@${manifest.version}.zip`;
}

function parsePackArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    if (token === '--out' || token === '--name') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${token} requires a value`);
      }
      flags[token.slice(2)] = value;
      i += 1;
      continue;
    }

    if (token === '--dry-run') {
      flags['dry-run'] = true;
      continue;
    }

    throw new Error(`Unknown option for pack: ${token}`);
  }

  return { positional, flags };
}

function validatePackFileName(value) {
  const fileName = String(value);
  if (
    !fileName
    || fileName === '.'
    || fileName === '..'
    || /[\\/:]/.test(fileName)
    || path.posix.basename(fileName) !== fileName
    || path.win32.basename(fileName) !== fileName
  ) {
    throw new Error('--name must be a filename without directory components');
  }
  if (path.extname(fileName).toLowerCase() !== '.zip') {
    throw new Error('--name must end with .zip');
  }

  return fileName;
}

async function preparePackOutput(outDir, fileName) {
  await inspectPackOutput(outDir, fileName);
  await fs.mkdir(outDir, { recursive: true });
  return inspectPackOutput(outDir, fileName);
}

async function inspectPackOutput(outDir, fileName) {
  const canonicalOutDir = path.resolve(outDir);
  await assertCanonicalPackOutputDirectory(canonicalOutDir, { allowMissing: true });

  const zipPath = path.join(canonicalOutDir, fileName);
  const relativeZipPath = path.relative(canonicalOutDir, zipPath);
  if (
    !relativeZipPath
    || relativeZipPath === '..'
    || relativeZipPath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeZipPath)
  ) {
    throw new Error(`Pack output path must stay inside the output directory: ${zipPath}`);
  }

  await assertReplaceablePackTarget(zipPath);
  return { outDir: canonicalOutDir, zipPath };
}

async function resolveCanonicalPackOutputDirectory(outDir) {
  const resolvedOutDir = path.resolve(outDir);
  const missingSegments = [];
  let currentPath = resolvedOutDir;

  while (true) {
    try {
      await fs.lstat(currentPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
          throw error;
        }
        missingSegments.push(path.basename(currentPath));
        currentPath = parentPath;
        continue;
      }
      throw error;
    }

    const canonicalExistingPath = await fs.realpath(currentPath);
    const canonicalStat = await fs.lstat(canonicalExistingPath);
    if (!canonicalStat.isDirectory()) {
      throw new Error(`Pack output directory must resolve through real directories: ${resolvedOutDir}`);
    }

    return path.join(canonicalExistingPath, ...missingSegments.reverse());
  }
}

function normalizePathForComparison(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function assertCanonicalPackOutputDirectory(outDir, { allowMissing = false } = {}) {
  let stat;
  try {
    stat = await fs.lstat(outDir);
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') {
      const currentCanonicalOutDir = await resolveCanonicalPackOutputDirectory(outDir);
      if (
        normalizePathForComparison(currentCanonicalOutDir)
        !== normalizePathForComparison(path.resolve(outDir))
      ) {
        throw new Error(`Pack output directory changed during packaging: ${outDir}`);
      }
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Pack output directory must be a real directory: ${outDir}`);
  }

  const currentCanonicalOutDir = await fs.realpath(outDir);
  if (
    normalizePathForComparison(currentCanonicalOutDir)
    !== normalizePathForComparison(path.resolve(outDir))
  ) {
    throw new Error(`Pack output directory changed during packaging: ${outDir}`);
  }
}

async function assertReplaceablePackTarget(zipPath) {
  let stat;
  try {
    stat = await fs.lstat(zipPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Pack output path must not be a symbolic link: ${zipPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Pack output path must be a regular file when it already exists: ${zipPath}`);
  }
}

async function writeZipAtomically(output, buffer) {
  const tempPath = path.join(output.outDir, `.zeropress-theme-pack-${randomUUID()}.tmp`);
  let tempHandle;
  let tempExists = false;

  try {
    await assertPreparedPackOutputIsSafe(output);
    tempHandle = await fs.open(tempPath, 'wx', 0o600);
    tempExists = true;
    await tempHandle.writeFile(buffer);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    await assertPreparedPackOutputIsSafe(output);
    await replacePackTarget(tempPath, output.zipPath);
    tempExists = false;
  } finally {
    await tempHandle?.close().catch(() => {});
    if (tempExists) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }
}

async function assertPreparedPackOutputIsSafe(output) {
  await assertCanonicalPackOutputDirectory(output.outDir);
  if (path.dirname(output.zipPath) !== output.outDir) {
    throw new Error(`Pack output path must stay inside the output directory: ${output.zipPath}`);
  }
  await assertReplaceablePackTarget(output.zipPath);
}

async function replacePackTarget(tempPath, zipPath) {
  try {
    await fs.rename(tempPath, zipPath);
    return;
  } catch (error) {
    if (
      process.platform !== 'win32'
      || !error
      || !['EEXIST', 'EPERM'].includes(error.code)
    ) {
      throw error;
    }
  }

  await assertReplaceablePackTarget(zipPath);
  await fs.unlink(zipPath);
  await fs.rename(tempPath, zipPath);
}

function relativePathInside(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return normalizeSlashes(relativePath);
}

function createPackShouldInclude(options) {
  return (relativePath, entry) => !shouldExclude(normalizeSlashes(relativePath), {
    ...options,
    isDirectory: entry.isDirectory(),
  });
}

function shouldExclude(relativePath, {
  outputDirRelativePath,
  outputFileRelativePath,
  isDirectory = false,
} = {}) {
  const comparisonPath = normalizePathForComparison(relativePath);
  const comparisonOutputDir = outputDirRelativePath
    ? normalizePathForComparison(outputDirRelativePath)
    : null;
  const comparisonOutputFile = outputFileRelativePath
    ? normalizePathForComparison(outputFileRelativePath)
    : null;

  if (
    comparisonOutputDir
    && (
      comparisonPath === comparisonOutputDir
      || comparisonPath.startsWith(`${comparisonOutputDir}/`)
    )
  ) {
    return true;
  }
  if (comparisonOutputFile && comparisonPath === comparisonOutputFile) {
    return true;
  }

  const parts = relativePath.split('/');
  for (const part of parts) {
    if (EXCLUDE_DEFAULTS.has(part)) {
      return true;
    }
  }
  if (!isDirectory && relativePath.endsWith('.log')) {
    return true;
  }
  return false;
}
