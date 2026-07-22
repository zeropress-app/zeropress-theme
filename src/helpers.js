import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizeSlashes(value) {
  return value.replace(/\\/g, '/');
}

export async function resolveCanonicalDirectoryRoot(rootDir, { label = 'Directory' } = {}) {
  const rootStat = await fs.lstat(rootDir);
  if (rootStat.isSymbolicLink()) {
    const error = new Error(`${label} must be a real directory and must not be a symbolic link: ${rootDir}`);
    error.code = 'SYMLINK_NOT_ALLOWED';
    throw error;
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${rootDir}`);
  }

  const canonicalRoot = await fs.realpath(rootDir);
  const confirmedRootStat = await fs.lstat(rootDir);
  if (confirmedRootStat.isSymbolicLink()) {
    const error = new Error(`${label} must be a real directory and must not be a symbolic link: ${rootDir}`);
    error.code = 'SYMLINK_NOT_ALLOWED';
    throw error;
  }
  if (!confirmedRootStat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${rootDir}`);
  }

  return canonicalRoot;
}

export async function walkDirectory(rootDir, { shouldInclude, maxEntries } = {}) {
  const output = [];
  let includedEntryCount = 0;

  async function walk(currentDir) {
    const entries = [];
    const directory = await fs.opendir(currentDir);
    for await (const entry of directory) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = normalizeSlashes(path.relative(rootDir, fullPath));
      const hasLiteralBackslash = entry.name.includes('\\');
      if (shouldInclude && !hasLiteralBackslash && !shouldInclude(relativePath, entry)) {
        continue;
      }
      includedEntryCount += 1;
      if (maxEntries !== undefined && includedEntryCount > maxEntries) {
        const error = new Error(`Theme package contains more than ${maxEntries} entries`);
        error.code = 'THEME_PACKAGE_TOO_MANY_ENTRIES';
        error.entryCount = includedEntryCount;
        throw error;
      }
      entries.push({
        fullPath,
        hasLiteralBackslash,
        rawRelativePath: path.relative(rootDir, fullPath),
        relativePath,
        entry,
      });
    }

    entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
    for (const item of entries) {
      output.push(item);
      if (item.entry.isDirectory()) {
        await walk(item.fullPath);
      }
    }
  }

  await walk(rootDir);
  return output;
}

export function getThemeDir(inputDir) {
  return path.resolve(process.cwd(), inputDir || '.');
}
