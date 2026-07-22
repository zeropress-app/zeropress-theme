import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizeSlashes(value) {
  return value.replace(/\\/g, '/');
}

export function sanitizeFileName(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'theme';
}

export async function walkDirectory(rootDir) {
  const output = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = normalizeSlashes(path.relative(rootDir, fullPath));
      output.push({
        fullPath,
        relativePath,
        entry,
      });
      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(rootDir);
  return output;
}

export function getThemeDir(inputDir) {
  return path.resolve(process.cwd(), inputDir || '.');
}
