import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { EXCLUDE_DEFAULTS } from './constants.js';
import { getThemeDir, normalizeSlashes, sanitizeFileName, walkDirectory } from './helpers.js';
import { validateThemeDirectory, validateZipFile } from './validate.js';

export async function runPack(argv) {
  const { positional, flags } = parsePackArgs(argv);
  if (!positional[0]) {
    throw new Error('pack requires a themeDir argument');
  }
  const themeDir = getThemeDir(positional[0]);
  const outDir = path.resolve(process.cwd(), flags.out || 'dist');
  const dryRun = flags['dry-run'] === true;

  const preValidation = await validateThemeDirectory(themeDir);
  if (preValidation.errors.length > 0) {
    throw new Error(`Pack aborted: validate failed with ${preValidation.errors.length} error(s)`);
  }

  const themeJsonRaw = await fs.readFile(path.join(themeDir, 'theme.json'), 'utf8');
  const themeJson = JSON.parse(themeJsonRaw);
  const defaultName = `${sanitizeFileName(themeJson.name)}-${sanitizeFileName(themeJson.version)}.zip`;
  const fileName = flags.name || defaultName;
  const zipPath = path.join(outDir, fileName);

  const entries = await walkDirectory(themeDir);
  const seenPaths = new Map();
  const includedFiles = [];

  for (const item of entries) {
    if (!item.entry.isFile()) {
      continue;
    }

    const rel = normalizeSlashes(item.relativePath);
    if (shouldExclude(rel)) {
      continue;
    }

    const zipRel = rel;
    const key = zipRel.toLowerCase();
    if (seenPaths.has(key)) {
      throw new Error(`Pack aborted: flatten path collision detected (${zipRel} conflicts with ${seenPaths.get(key)})`);
    }
    seenPaths.set(key, zipRel);
    includedFiles.push({
      zipPath: zipRel,
      fullPath: item.fullPath,
    });
  }

  if (dryRun) {
    console.log(`Dry run: would pack theme to ${zipPath}`);
    console.log(`Included files: ${includedFiles.length}`);
    for (const file of includedFiles) {
      console.log(` - ${file.zipPath}`);
    }
    if (preValidation.warnings.length > 0) {
      console.log(`Validation warnings: ${preValidation.warnings.length}`);
    }
    return;
  }

  await fs.mkdir(outDir, { recursive: true });
  const zip = new JSZip();

  for (const file of includedFiles) {
    const content = await fs.readFile(file.fullPath);
    zip.file(file.zipPath, content);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(zipPath, buffer);

  const postValidation = await validateZipFile(zipPath);
  if (postValidation.errors.length > 0) {
    await fs.unlink(zipPath).catch(() => {});
    throw new Error(`Pack aborted: generated zip re-validation failed with ${postValidation.errors.length} error(s)`);
  }

  console.log(`Packed theme: ${zipPath}`);
  if (postValidation.warnings.length > 0) {
    console.log(`Pack warnings: ${postValidation.warnings.length}`);
  }
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
      if (!value) {
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

function shouldExclude(relativePath) {
  const parts = relativePath.split('/');
  for (const part of parts) {
    if (EXCLUDE_DEFAULTS.has(part)) {
      return true;
    }
  }
  if (relativePath.endsWith('.log')) {
    return true;
  }
  return false;
}
