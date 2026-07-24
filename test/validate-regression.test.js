import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { THEME_PACKAGE_LIMITS } from '@zeropress/theme-validator';
import {
  runValidate,
  validateThemeDirectory,
} from '../src/validate.js';
import { resolveCanonicalDirectoryRoot } from '../src/helpers.js';

function validThemeFiles() {
  return {
    'theme.json': JSON.stringify({
      name: 'Regression Theme',
      namespace: 'test-studio',
      slug: 'regression-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.7',
    }),
    'layout.html': '<!doctype html><main>{{slot:content}}</main>',
    'index.html': '<h1>Index</h1>',
    'post.html': '<article>{{post.title}}</article>',
    'page.html': '<section>{{page.title}}</section>',
    'assets/style.css': 'body {}',
  };
}

async function createThemeDir(files = validThemeFiles()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-regression-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
  return root;
}


async function captureJsonOutput(callback) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk, encoding, done) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') {
      encoding();
    }
    if (typeof done === 'function') {
      done();
    }
    return true;
  });

  try {
    const code = await callback();
    return { code, payload: JSON.parse(chunks.join('')) };
  } finally {
    process.stdout.write = originalWrite;
  }
}


test('validateThemeDirectory rejects oversized files before reading their contents', async () => {
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    'assets/oversized.bin': Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1),
  });

  try {
    const result = await validateThemeDirectory(themeDir);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.code === 'THEME_FILE_TOO_LARGE'), true);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validateThemeDirectory bounded-reads a file that grows after descriptor stat', async () => {
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    'assets/growing.bin': Buffer.alloc(1024, 0x31),
  });
  const growingPath = await fs.realpath(path.join(themeDir, 'assets', 'growing.bin'));
  const originalOpen = fs.open;
  let growingFileOpenCount = 0;

  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== growingPath || growingFileOpenCount > 0) {
      return handle;
    }
    growingFileOpenCount += 1;
    const originalStat = handle.stat.bind(handle);
    handle.stat = async (...statArgs) => {
      const stat = await originalStat(...statArgs);
      await fs.appendFile(
        growingPath,
        Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1, 0x32),
      );
      return stat;
    };
    return handle;
  };

  try {
    const result = await validateThemeDirectory(themeDir);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.code === 'THEME_FILE_TOO_LARGE'), true);
  } finally {
    fs.open = originalOpen;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});



test('runValidate serializes target I/O failures as JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-missing-'));
  const missingPath = path.join(root, 'missing-theme');

  try {
    const { code, payload } = await captureJsonOutput(() => runValidate([missingPath, '--json']));
    assert.equal(code, 1);
    assert.equal(payload.ok, false);
    assert.equal(payload.errors[0].code, 'VALIDATION_ERROR');
    assert.equal(payload.summary.checkedFiles, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runValidate serializes dangling symlink failures as JSON', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir();
  await fs.symlink('missing-target.txt', path.join(themeDir, 'dangling.txt'));

  try {
    const { code, payload } = await captureJsonOutput(() => runValidate([themeDir, '--json']));
    assert.equal(code, 1);
    assert.equal(payload.ok, false);
    assert.equal(payload.errors[0].code, 'SYMLINK_NOT_ALLOWED');
    assert.equal(payload.summary.checkedFiles > 0, true);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validateThemeDirectory rejects internal file and directory symbolic links', {
  skip: process.platform === 'win32',
}, async () => {
  for (const kind of ['file', 'directory']) {
    const themeDir = await createThemeDir();
    try {
      const target = kind === 'file'
        ? path.join(themeDir, 'assets', 'style.css')
        : path.join(themeDir, 'assets');
      await fs.symlink(target, path.join(themeDir, `internal-${kind}`));
      const result = await validateThemeDirectory(themeDir);
      assert.equal(result.ok, false);
      assert.equal(result.errors.some((issue) => issue.code === 'SYMLINK_NOT_ALLOWED'), true);
    } finally {
      await fs.rm(themeDir, { recursive: true, force: true });
    }
  }
});

test('validateThemeDirectory rejects literal backslashes in POSIX filenames', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir();
  const unsafePath = path.join(themeDir, 'assets', 'name\\variant.css');
  await fs.writeFile(unsafePath, 'unsafe');

  try {
    const result = await validateThemeDirectory(themeDir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'PATH_ESCAPE');
    assert.match(result.errors[0].message, /Backslashes are not allowed/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validateThemeDirectory rejects paths that collide after case and NFC normalization', async (t) => {
  const themeDir = await createThemeDir();
  await fs.writeFile(path.join(themeDir, 'assets', 'Icon.svg'), 'first');
  await fs.writeFile(path.join(themeDir, 'assets', 'icon.svg'), 'second');

  try {
    const names = await fs.readdir(path.join(themeDir, 'assets'));
    if (!names.includes('Icon.svg') || !names.includes('icon.svg')) {
      t.skip('filesystem does not preserve case-distinct filenames');
      return;
    }

    const result = await validateThemeDirectory(themeDir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'THEME_PATH_COLLISION');
    assert.match(result.errors[0].message, /after NFC and case normalization/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validate rejects a symbolic-link theme root without following it', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir();
  const aliasPath = `${themeDir}-alias`;
  await fs.symlink(themeDir, aliasPath, 'dir');

  try {
    const directResult = await validateThemeDirectory(aliasPath);
    assert.equal(directResult.ok, false);
    assert.equal(directResult.errors[0].code, 'SYMLINK_NOT_ALLOWED');

    const { code, payload } = await captureJsonOutput(() => runValidate([aliasPath, '--json']));
    assert.equal(code, 1);
    assert.equal(payload.errors[0].code, 'SYMLINK_NOT_ALLOWED');
    assert.equal(payload.errors[0].category, 'theme_package_paths');
  } finally {
    await fs.unlink(aliasPath).catch(() => {});
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validate accepts a theme beneath a symlinked ancestor', {
  skip: process.platform === 'win32',
}, async () => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'zeropress-theme-ancestor-alias-'));
  const realRoot = path.join(parent, 'real-root');
  const aliasRoot = path.join(parent, 'alias-root');
  const themeDir = path.join(realRoot, 'theme');
  await fs.mkdir(themeDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(validThemeFiles())) {
    const fullPath = path.join(themeDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
  await fs.symlink(realRoot, aliasRoot, 'dir');

  try {
    const result = await validateThemeDirectory(path.join(aliasRoot, 'theme'));
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('canonical directory roots remain pinned after an ancestor alias is retargeted', {
  skip: process.platform === 'win32',
}, async () => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'zeropress-theme-pinned-root-'));
  const firstRoot = path.join(parent, 'first');
  const secondRoot = path.join(parent, 'second');
  const aliasRoot = path.join(parent, 'alias');
  await fs.mkdir(path.join(firstRoot, 'theme'), { recursive: true });
  await fs.mkdir(path.join(secondRoot, 'theme'), { recursive: true });
  await fs.writeFile(path.join(firstRoot, 'theme', 'identity.txt'), 'first');
  await fs.writeFile(path.join(secondRoot, 'theme', 'identity.txt'), 'second');
  await fs.symlink(firstRoot, aliasRoot, 'dir');

  try {
    const canonicalRoot = await resolveCanonicalDirectoryRoot(path.join(aliasRoot, 'theme'), {
      label: 'Theme directory',
    });
    await fs.unlink(aliasRoot);
    await fs.symlink(secondRoot, aliasRoot, 'dir');

    assert.equal(canonicalRoot, await fs.realpath(path.join(firstRoot, 'theme')));
    assert.equal(await fs.readFile(path.join(canonicalRoot, 'identity.txt'), 'utf8'), 'first');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('runValidate serializes extra positional arguments as a CLI JSON error', async () => {
  const { code, payload } = await captureJsonOutput(() => runValidate([
    'theme-one',
    'theme-two',
    '--json',
  ]));
  assert.equal(code, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors[0].code, 'CLI_ARGUMENT_ERROR');
  assert.match(payload.errors[0].message, /exactly one/);
});

test('validateThemeDirectory forwards shouldInclude and skips excluded directory recursion', async () => {
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    'excluded/name..txt': 'not part of the theme package',
  });
  const visited = [];

  try {
    const result = await validateThemeDirectory(themeDir, {
      shouldInclude(relativePath, entry) {
        visited.push({ relativePath, isDirectory: entry.isDirectory() });
        return relativePath !== 'excluded';
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.checkedFiles, Object.keys(validThemeFiles()).length);
    assert.equal(visited.some(({ relativePath }) => relativePath === 'excluded'), true);
    assert.equal(visited.find(({ relativePath }) => relativePath === 'excluded').isDirectory, true);
    assert.equal(visited.some(({ relativePath }) => relativePath.startsWith('excluded/')), false);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});
