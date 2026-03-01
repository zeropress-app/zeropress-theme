import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { ALLOWED_SLOTS, OPTIONAL_TEMPLATES, REQUIRED_FILES, REQUIRED_TEMPLATES } from './constants.js';
import { getThemeDir, normalizeSlashes, walkDirectory } from './helpers.js';

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
  const noJsCheck = options.noJsCheck === true;
  const errors = [];
  const warnings = [];
  let checkedFiles = 0;

  const allEntries = await walkDirectory(themeDir);
  checkedFiles = allEntries.filter((it) => it.entry.isFile()).length;

  await validatePathSafety(themeDir, allEntries, errors);

  const files = new Map();
  for (const item of allEntries) {
    if (item.entry.isFile()) {
      files.set(item.relativePath, item.fullPath);
    }
  }

  await validateFromFileMap(files, {
    readFile: (relativePath) => fs.readFile(files.get(relativePath), 'utf8'),
    exists: (relativePath) => files.has(relativePath),
    errors,
    warnings,
    noJsCheck,
  });

  return { ok: errors.length === 0, errors, warnings, checkedFiles };
}

export async function validateZipFile(zipPath, options = {}) {
  const noJsCheck = options.noJsCheck === true;
  const errors = [];
  const warnings = [];

  const raw = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(raw);

  const filePaths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const basePrefix = detectBasePrefix(filePaths);

  const files = new Set(filePaths.map((p) => normalizeSlashes(p)));

  await validateFromFileMap(
    new Proxy(
      {},
      {
        get: (_, key) => files.has(`${basePrefix}${key}`),
      }
    ),
    {
      readFile: async (relativePath) => {
        const file = zip.file(`${basePrefix}${relativePath}`);
        if (!file) {
          throw new Error(`Missing file: ${relativePath}`);
        }
        return file.async('string');
      },
      exists: (relativePath) => files.has(`${basePrefix}${relativePath}`),
      errors,
      warnings,
      noJsCheck,
    }
  );

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checkedFiles: filePaths.length,
  };
}

function detectBasePrefix(filePaths) {
  if (filePaths.includes('theme.json')) {
    return '';
  }
  const topLevel = new Set(filePaths.map((p) => p.split('/')[0]).filter(Boolean));
  if (topLevel.size === 1) {
    const folder = Array.from(topLevel)[0];
    if (filePaths.includes(`${folder}/theme.json`)) {
      return `${folder}/`;
    }
  }
  return '';
}

async function validateFromFileMap(fileMap, context) {
  const { exists, readFile, errors, warnings, noJsCheck } = context;

  for (const requiredPath of REQUIRED_FILES) {
    if (!exists(requiredPath)) {
      errors.push({
        code: 'MISSING_REQUIRED_FILE',
        path: requiredPath,
        message: `Required file '${requiredPath}' is missing`,
      });
    }
  }

  for (const template of REQUIRED_TEMPLATES) {
    if (!exists(template)) {
      errors.push({
        code: 'MISSING_REQUIRED_TEMPLATE',
        path: template,
        message: `Required template '${template}' is missing`,
      });
    }
  }

  for (const template of OPTIONAL_TEMPLATES) {
    if (!exists(template)) {
      warnings.push({
        code: 'MISSING_OPTIONAL_TEMPLATE',
        path: template,
        message: `Optional template '${template}' is missing`,
      });
    }
  }

  if (exists('theme.json')) {
    try {
      const raw = await readFile('theme.json');
      const data = JSON.parse(raw);
      validateThemeJson(data, errors);
    } catch (error) {
      errors.push({
        code: 'INVALID_THEME_JSON',
        path: 'theme.json',
        message: `Invalid theme.json: ${error.message}`,
      });
    }
  }

  const templatesToCheck = [...REQUIRED_TEMPLATES, ...OPTIONAL_TEMPLATES, 'layout.html', '404.html'];
  const templateContents = new Map();
  for (const template of new Set(templatesToCheck)) {
    if (!exists(template)) {
      continue;
    }
    const content = await readFile(template);
    templateContents.set(template, content);
    validateTemplateSyntax(template, content, errors, noJsCheck);
  }

  validateCommentsPlaceholderGuidance(templateContents, warnings);

  if (exists('partials')) {
    // no-op for virtual sources
  }
}

function validateCommentsPlaceholderGuidance(templateContents, warnings) {
  const commentsPlaceholder = '{{post.comments_html}}';
  const postTemplate = templateContents.get('post.html');

  if (typeof postTemplate === 'string' && !postTemplate.includes(commentsPlaceholder)) {
    warnings.push({
      code: 'MISSING_POST_COMMENTS_PLACEHOLDER',
      path: 'post.html',
      message: "Consider adding '{{post.comments_html}}' to post.html to render post comments",
    });
  }

  for (const [templatePath, content] of templateContents.entries()) {
    if (templatePath === 'post.html') {
      continue;
    }
    if (!content.includes(commentsPlaceholder)) {
      continue;
    }
    warnings.push({
      code: 'COMMENTS_PLACEHOLDER_OUTSIDE_POST_TEMPLATE',
      path: templatePath,
      message: "'{{post.comments_html}}' should be used in post.html, not in this template",
    });
  }
}

function validateThemeJson(themeJson, errors) {
  if (!themeJson || typeof themeJson !== 'object') {
    errors.push({
      code: 'INVALID_THEME_JSON',
      path: 'theme.json',
      message: 'theme.json must be an object',
    });
    return;
  }

  for (const key of ['name', 'version', 'author']) {
    if (typeof themeJson[key] !== 'string' || themeJson[key].trim() === '') {
      errors.push({
        code: 'INVALID_THEME_METADATA',
        path: 'theme.json',
        message: `theme.json field '${key}' must be a non-empty string`,
      });
    }
  }

  if (typeof themeJson.version === 'string') {
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    if (!semver.test(themeJson.version)) {
      errors.push({
        code: 'INVALID_SEMVER',
        path: 'theme.json',
        message: "Theme version must follow semantic versioning (e.g. 1.0.0)",
      });
    }
  }
}

function validateTemplateSyntax(templatePath, content, errors, noJsCheck) {
  const slotRegex = /\{\{slot:([a-zA-Z0-9_-]+)\}\}/g;
  const contentSlotMatches = content.match(/\{\{slot:content\}\}/g) || [];

  if (templatePath === 'layout.html') {
    if (contentSlotMatches.length !== 1) {
      errors.push({
        code: 'INVALID_LAYOUT_SLOT',
        path: 'layout.html',
        message: 'layout.html must contain exactly one {{slot:content}}',
      });
    }
    if (!noJsCheck && /<script\b/i.test(content)) {
      errors.push({
        code: 'LAYOUT_SCRIPT_NOT_ALLOWED',
        path: 'layout.html',
        message: 'layout.html must not contain <script> tags',
      });
    }
  }

  let match;
  while ((match = slotRegex.exec(content)) !== null) {
    const slotName = match[1];
    if (!ALLOWED_SLOTS.has(slotName)) {
      errors.push({
        code: 'UNKNOWN_SLOT',
        path: templatePath,
        message: `Unknown slot '${slotName}' in ${templatePath}`,
      });
    }
  }

  if (/\{\{slot:[^}]*\{\{slot:/.test(content)) {
    errors.push({
      code: 'NESTED_SLOT',
      path: templatePath,
      message: `Nested slots are not allowed in ${templatePath}`,
    });
  }

  if (/\{\{[#/][^}]+\}\}/.test(content)) {
    errors.push({
      code: 'MUSTACHE_BLOCK_NOT_ALLOWED',
      path: templatePath,
      message: `Mustache block syntax is not allowed in ${templatePath}`,
    });
  }
}

async function validatePathSafety(themeDir, entries, errors) {
  const rootRealPath = await fs.realpath(themeDir);
  for (const item of entries) {
    const rel = item.relativePath;
    if (rel.includes('..') || path.isAbsolute(rel)) {
      errors.push({
        code: 'PATH_ESCAPE',
        path: rel,
        message: `Invalid path outside theme root: ${rel}`,
      });
      continue;
    }

    const full = item.fullPath;
    const stat = await fs.lstat(full);
    if (!stat.isSymbolicLink()) {
      continue;
    }
    const resolved = await fs.realpath(full);
    if (!resolved.startsWith(rootRealPath)) {
      errors.push({
        code: 'SYMLINK_ESCAPE',
        path: rel,
        message: `Symlink escapes theme root: ${rel}`,
      });
    }
  }
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
