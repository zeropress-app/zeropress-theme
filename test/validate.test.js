import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { runPack } from '../src/pack.js';
import { runValidate, validateThemeDirectory } from '../src/validate.js';

async function createThemeDir(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-'));

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return root;
}

async function createZipFile(files, zipName = 'theme.zip') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-zip-'));
  const zipPath = path.join(root, zipName);
  const zip = new JSZip();

  for (const [relativePath, content] of Object.entries(files)) {
    zip.file(relativePath, content);
  }

  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'uint8array' }));
  return { root, zipPath };
}

function validThemeFiles() {
  return {
    'theme.json': JSON.stringify({
      name: 'Test Theme',
      namespace: 'test-studio',
      slug: 'test-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.2',
      description: 'A test theme',
    }),
    'layout.html': '<main>{{slot:content}}</main>',
    'index.html': '<h1>{{site.title}}</h1>',
    'post.html': '<article>{{post.title}}{{post.comments_html}}</article>',
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

test('runValidate returns 1 and emits json for invalid theme in strict json mode', async () => {
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
    const code = await runValidate([themeDir, '--json', '--strict']);
    assert.equal(code, 1);
    const payload = JSON.parse(chunks.join(''));
    assert.equal(payload.ok, false);
    assert.equal(Array.isArray(payload.errors), true);
    assert.equal(payload.errors.some((issue) => issue.path === 'layout.html'), true);
  } finally {
    process.stdout.write = originalWrite;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
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

test('runValidate rejects a legacy v0.1 manifest', async () => {
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    'theme.json': JSON.stringify({
      name: 'Legacy Theme',
      version: '1.0.0',
      author: 'ZeroPress',
      description: 'legacy',
    }),
  });

  try {
    const code = await runValidate([themeDir]);
    assert.equal(code, 1);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runPack aborts when shared validation finds errors', async () => {
  const files = validThemeFiles();
  delete files['page.html'];
  const themeDir = await createThemeDir(files);

  await assert.rejects(() => runPack([themeDir]), /Pack aborted: validate failed/);
  await fs.rm(themeDir, { recursive: true, force: true });
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
  const expectedZipPath = path.join(outDir, 'test-theme-1.0.0.zip');
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    await runPack([themeDir, '--out', outDir, '--dry-run']);
    await assert.rejects(() => fs.access(expectedZipPath));
    assert.equal(logs.some((line) => line.includes(`Dry run: would pack theme to ${expectedZipPath}`)), true);
    assert.equal(logs.some((line) => line.includes('Included files:')), true);
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});
