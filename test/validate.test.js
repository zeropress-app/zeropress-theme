import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { runPack } from '../src/pack.js';
import { runValidate, validateThemeDirectory } from '../src/validate.js';

const packageJsonPath = new URL('../package.json', import.meta.url);
const canonicalTmpDir = await fs.realpath(os.tmpdir());

async function createThemeDir(files) {
  const root = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-'));

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return root;
}

async function createZipFile(files, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-zip-'));
  const zipPath = path.join(root, options.zipName || 'theme.zip');
  const zip = new JSZip();
  const prefix = options.prefix || '';

  for (const [relativePath, content] of Object.entries(files)) {
    zip.file(`${prefix}${relativePath}`, content);
  }

  for (const [relativePath, content] of Object.entries(options.extraFiles || {})) {
    zip.file(relativePath, content);
  }

  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'uint8array' }));
  return { root, zipPath };
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function validThemeFiles() {
  return {
    'theme.json': JSON.stringify({
      name: 'Test Theme',
      namespace: 'test-studio',
      slug: 'test-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.7',
      description: 'A test theme',
      features: {
        search: true,
      },
    }),
    'layout.html': '<main>{{slot:content}}</main>',
    'index.html': '<h1>{{site.title}}</h1>',
    'post.html': '<article>{{post.title}}{{post.html}}</article>',
    'page.html': '<section>{{page.title}}</section>',
    'assets/style.css': 'body { color: black; }',
  };
}

test('validateThemeDirectory returns zero errors for a valid theme', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const result = await validateThemeDirectory(themeDir);

  assert.equal(result.errors.length, 0);
  assert.equal(result.ok, true);

  await fs.rm(themeDir, { recursive: true, force: true });
});

test('runValidate returns 1 and emits json for invalid theme', async () => {
  const files = validThemeFiles();
  delete files['layout.html'];
  const themeDir = await createThemeDir(files);

  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') {
      encoding();
    }
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  });

  try {
    const code = await runValidate([themeDir, '--json']);
    assert.equal(code, 1);
    const payload = JSON.parse(chunks.join(''));
    assert.equal(payload.ok, false);
    assert.equal(Array.isArray(payload.errors), true);
    assert.equal(Array.isArray(payload.infos), true);
    assert.equal(payload.errors.some((issue) => issue.path === 'layout.html'), true);
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    assert.equal(payload.meta.schemaVersion, '1');
    assert.equal(payload.meta.tool, 'zeropress-theme');
    assert.equal(payload.meta.toolVersion, packageJson.version);
  } finally {
    process.stdout.write = originalWrite;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate prints theme validation location and hint in human output', async () => {
  const files = validThemeFiles();
  files['layout.html'] = [
    '<html>',
    '<head><script src="/theme.js"></script></head>',
    '<body>{{slot:content}}</body>',
    '</html>',
  ].join('\n');
  const themeDir = await createThemeDir(files);
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => {
    logs.push(String(message));
  };

  try {
    const code = await runValidate([themeDir]);
    assert.equal(code, 1);
    const output = stripAnsi(logs.join('\n'));
    assert.match(output, /ERROR LAYOUT_SCRIPT_NOT_ALLOWED/);
    assert.match(output, /File: layout\.html/);
    assert.match(output, /Line: 2, Column: 7/);
    assert.match(output, /Category: theme_validation/);
    assert.match(output, /Hint:/);
    assert.match(output, /\{\{partial:content-enhancements\}\}/);
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate escapes terminal controls in human paths and snippets while preserving layout', async () => {
  const files = validThemeFiles();
  const unsafeName = 'assets/evil\u001B]8;;example\u0007\n\u202E.css';
  files[unsafeName] = 'body {}';
  files['index.html'] = '<h1>{{site.\u0085\u202Ebad}}</h1>';
  const themeDir = await createThemeDir(files);
  const logs = [];
  const originalLog = console.log;
  const originalNoColor = process.env.NO_COLOR;
  console.log = (message) => logs.push(String(message));
  process.env.NO_COLOR = '1';

  try {
    const code = await runValidate([themeDir]);
    assert.equal(code, 1);
    const output = logs.join('\n');
    assert.equal(output.includes('\u001B'), false);
    assert.equal(output.includes('\u0007'), false);
    assert.equal(output.includes('\u0085'), false);
    assert.equal(output.includes('\u202E'), false);
    assert.match(output, /evil\\u001B]8;;example\\u0007\\u000A\\u202E\.css/);
    assert.match(output, /\\u0085\\u202Ebad/);
    assert.match(output, /\nErrors: /);
  } finally {
    console.log = originalLog;
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validate --json preserves raw issue data and remains parseable', async () => {
  const unsafeName = 'assets/json\u001B\u202E.css';
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    [unsafeName]: 'body {}',
  });
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    assert.equal(await runValidate([themeDir, '--json']), 1);
    const payload = JSON.parse(chunks.join(''));
    assert.equal(payload.errors.some((issue) => issue.path === unsafeName), true);
  } finally {
    process.stdout.write = originalWrite;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate keeps forced-color human output searchable after ANSI stripping', async () => {
  const files = validThemeFiles();
  files['layout.html'] = [
    '<html>',
    '<head><script src="/theme.js"></script></head>',
    '<body>{{slot:content}}</body>',
    '</html>',
  ].join('\n');
  const themeDir = await createThemeDir(files);
  const logs = [];
  const originalLog = console.log;
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  console.log = (message) => {
    logs.push(String(message));
  };
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';

  try {
    const code = await runValidate([themeDir]);
    assert.equal(code, 1);
    const output = logs.join('\n');
    assert.match(output, /\x1B\[/);
    assert.match(stripAnsi(output), /ERROR LAYOUT_SCRIPT_NOT_ALLOWED/);
    assert.match(stripAnsi(output), /INFO  MISSING_OPTIONAL_TEMPLATES/);
  } finally {
    console.log = originalLog;
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate requires a themeDir or theme.zip argument', async () => {
  await assert.rejects(
    () => runValidate([]),
    /validate requires a themeDir or theme\.zip argument/,
  );
});

test('runValidate accepts a valid zip file path', async () => {
  const files = {
    ...validThemeFiles(),
    'archive.html': '<section>archive</section>',
    'category.html': '<section>category</section>',
    'tag.html': '<section>tag</section>',
  };
  const { root, zipPath } = await createZipFile(files);

  try {
    const code = await runValidate([zipPath]);
    assert.equal(code, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runValidate accepts a valid single-folder zip file path', async () => {
  const files = {
    ...validThemeFiles(),
    'archive.html': '<section>archive</section>',
    'category.html': '<section>category</section>',
    'tag.html': '<section>tag</section>',
  };
  const { root, zipPath } = await createZipFile(files, { prefix: 'my-theme/' });

  try {
    const code = await runValidate([zipPath]);
    assert.equal(code, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runValidate accepts a zip file with macOS metadata', async () => {
  const files = {
    ...validThemeFiles(),
    'archive.html': '<section>archive</section>',
    'category.html': '<section>category</section>',
    'tag.html': '<section>tag</section>',
  };
  const { root, zipPath } = await createZipFile(files, {
    prefix: 'my-theme/',
    extraFiles: {
      '__MACOSX/my-theme/._theme.json': 'metadata',
      '__MACOSX/._my-theme': 'metadata',
    },
  });

  try {
    const code = await runValidate([zipPath]);
    assert.equal(code, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runValidate ignores info notes for exit code and rejects removed strict option', async () => {
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    assert.equal(await runValidate([themeDir]), 0);
    await assert.rejects(
      () => runValidate([themeDir, '--strict']),
      /Unknown option for validate: --strict/,
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate rejects a mixed multi-root zip file path', async () => {
  const files = {
    ...validThemeFiles(),
    'archive.html': '<section>archive</section>',
    'category.html': '<section>category</section>',
    'tag.html': '<section>tag</section>',
  };
  const { root, zipPath } = await createZipFile(files, {
    prefix: 'theme-a/',
    extraFiles: {
      'theme-b/other.txt': 'other',
    },
  });

  try {
    const code = await runValidate([zipPath]);
    assert.equal(code, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runPack aborts when shared validation finds errors', async () => {
  const files = validThemeFiles();
  delete files['page.html'];
  const themeDir = await createThemeDir(files);

  await assert.rejects(() => runPack([themeDir]), /Pack aborted: validate failed/);
  await fs.rm(themeDir, { recursive: true, force: true });
});

test('runPack requires a themeDir argument', async () => {
  await assert.rejects(
    () => runPack([]),
    /pack requires a themeDir argument/,
  );
});

test('runPack rejects extra positional arguments', async () => {
  await assert.rejects(
    () => runPack(['theme-one', 'theme-two']),
    /pack accepts exactly one themeDir argument/,
  );
});

test('runPack --dry-run prints output plan without writing zip', async () => {
  const files = {
    ...validThemeFiles(),
    'archive.html': '<section>archive</section>',
    'category.html': '<section>category</section>',
    'tag.html': '<section>tag</section>',
  };
  const themeDir = await createThemeDir(files);
  const outDir = path.join(themeDir, 'artifacts');
  const expectedZipPath = path.join(outDir, 'test-studio.test-theme@1.0.0.zip');
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    await runPack([themeDir, '--out', outDir, '--dry-run']);
    await assert.rejects(() => fs.access(expectedZipPath));
    await assert.rejects(() => fs.access(outDir));
    assert.equal(logs.some((line) => line.includes(`Dry run: would pack theme to ${expectedZipPath}`)), true);
    assert.equal(logs.some((line) => line.includes('Included files:')), true);
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runPack rejects names that escape the output directory', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const outDir = path.join(themeDir, 'artifacts');
  const importantPath = path.join(themeDir, 'important.txt');
  await fs.writeFile(importantPath, 'do not overwrite', 'utf8');

  try {
    for (const invalidName of ['../important.txt', '..\\important.txt']) {
      await assert.rejects(
        () => runPack([themeDir, '--out', outDir, '--name', invalidName]),
        /--name must be a filename without directory components/,
      );
    }
    assert.equal(await fs.readFile(importantPath, 'utf8'), 'do not overwrite');
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runPack canonicalizes direct symlink output directories and rejects symlink files', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-output-'));
  const realOutDir = path.join(outputRoot, 'real-artifacts');
  const linkedOutDir = path.join(outputRoot, 'linked-artifacts');
  const danglingTargetDir = path.join(outputRoot, 'missing-target');
  const danglingParentDir = path.join(outputRoot, 'dangling-parent');
  const zipName = 'test-studio.test-theme@1.0.0.zip';
  const importantPath = path.join(outputRoot, 'important.txt');
  await fs.mkdir(realOutDir, { recursive: true });
  await fs.writeFile(importantPath, 'do not overwrite', 'utf8');
  await fs.symlink(realOutDir, linkedOutDir);
  await fs.symlink(danglingTargetDir, danglingParentDir, 'dir');

  try {
    for (const extraArgs of [[], ['--dry-run']]) {
      await assert.doesNotReject(
        () => runPack([themeDir, '--out', linkedOutDir, ...extraArgs]),
      );
    }
    const zipPath = path.join(realOutDir, zipName);
    assert.equal((await fs.lstat(zipPath)).isFile(), true);

    for (const extraArgs of [[], ['--dry-run']]) {
      await assert.rejects(
        () => runPack([
          themeDir,
          '--out',
          path.join(danglingParentDir, 'artifacts'),
          ...extraArgs,
        ]),
      );
    }
    await assert.rejects(fs.access(danglingTargetDir), { code: 'ENOENT' });

    await fs.unlink(zipPath);
    await fs.symlink(importantPath, zipPath);
    for (const extraArgs of [[], ['--dry-run']]) {
      await assert.rejects(
        () => runPack([themeDir, '--out', realOutDir, ...extraArgs]),
        /Pack output path must not be a symbolic link/,
      );
    }

    assert.equal(await fs.readFile(importantPath, 'utf8'), 'do not overwrite');
    assert.equal((await fs.lstat(zipPath)).isSymbolicLink(), true);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack excludes a custom output directory reached through an ancestor alias on repeated packs', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const aliasThemeDir = path.join(
    canonicalTmpDir,
    `zeropress-theme-pack-output-alias-${path.basename(themeDir)}`,
  );
  const outDir = path.join(aliasThemeDir, 'artifacts');
  const canonicalOutDir = path.join(themeDir, 'artifacts');
  const zipName = 'test-studio.test-theme@1.0.0.zip';
  const zipPath = path.join(canonicalOutDir, zipName);
  const originalLog = console.log;
  console.log = () => {};
  await fs.symlink(themeDir, aliasThemeDir, 'dir');

  try {
    await runPack([themeDir, '--out', outDir]);
    await runPack([themeDir, '--out', outDir]);

    const zip = await JSZip.loadAsync(await fs.readFile(zipPath));
    assert.equal(zip.file(`artifacts/${zipName}`), null);
    assert.equal(Object.keys(zip.files).some((filePath) => filePath.startsWith('artifacts/')), false);
    assert.equal(
      (await fs.readdir(canonicalOutDir)).some((name) => name.startsWith('.zeropress-theme-pack-')),
      false,
    );
  } finally {
    console.log = originalLog;
    await fs.unlink(aliasThemeDir).catch(() => {});
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});
