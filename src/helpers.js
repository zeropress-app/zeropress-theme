import fs from 'node:fs/promises';
import path from 'node:path';

export function parseCliArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.split('=');
    const key = rawKey.slice(2);

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { positional, flags };
}

export function toBoolean(value) {
  return value === true || value === 'true' || value === '1';
}

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function isHttpsUrl(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value);
}

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
