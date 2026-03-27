import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertPreviewData } from '@zeropress/preview-data-validator';
import { defaultPreviewData, normalizeListenError, renderRoute, runDev } from '../src/dev.js';

async function createThemeDir(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dev-'));

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return root;
}

function validThemeFiles() {
  return {
    'theme.json': JSON.stringify({
      name: 'Dev Theme',
      namespace: 'test-studio',
      slug: 'dev-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.2',
      description: 'A test theme',
    }),
    'layout.html': '<html><body>{{slot:header}}<main>{{slot:content}}</main>{{slot:footer}}</body></html>',
    'index.html': '<h1>{{site.title}}</h1><div id="posts">{{posts}}</div><div id="categories">{{categories}}</div><div id="tags">{{tags}}</div><div id="pagination">{{pagination}}</div>',
    'post.html': '<article><h1>{{post.title}}</h1><div>{{post.author_name}}</div><div>{{post.html}}</div><div>{{post.comments_html}}</div></article>',
    'page.html': '<section><h1>{{page.title}}</h1><div>{{page.html}}</div></section>',
    'archive.html': '<section><h1>Archive</h1><div>{{posts}}</div><div>{{pagination}}</div></section>',
    'category.html': '<section><h1>Category</h1><div>{{posts}}</div><div>{{categories}}</div><div>{{pagination}}</div></section>',
    'tag.html': '<section><h1>Tag</h1><div>{{posts}}</div><div>{{tags}}</div><div>{{pagination}}</div></section>',
    'partials/header.html': '<header>Header</header>',
    'partials/footer.html': '<footer>Footer</footer>',
    'assets/style.css': 'body { color: black; }',
  };
}

test('defaultPreviewData returns a valid v0.2 payload', () => {
  assert.doesNotThrow(() => assertPreviewData(defaultPreviewData()));
});

test('renderRoute resolves canonical v0.2 routes and entities', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const data = defaultPreviewData();

  try {
    const home = await renderRoute('/', themeDir, data);
    const post = await renderRoute('/posts/hello-zeropress', themeDir, data);
    const page = await renderRoute('/about', themeDir, data);
    const archive = await renderRoute('/archive', themeDir, data);
    const category = await renderRoute('/categories/general', themeDir, data);
    const tag = await renderRoute('/tags/intro', themeDir, data);

    assert.equal(home.notFound, undefined);
    assert.match(home.html, /ZeroPress Preview/);
    assert.match(home.html, /Preview excerpt/);
    assert.match(post.html, /Hello ZeroPress/);
    assert.match(post.html, /Preview post content/);
    assert.match(page.html, /About/);
    assert.match(archive.html, /Archive/);
    assert.match(category.html, /Category/);
    assert.match(category.html, /General/);
    assert.match(tag.html, /Tag/);
    assert.match(tag.html, /Intro/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runDev rejects legacy preview data payloads', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const dataPath = path.join(themeDir, 'legacy-preview.json');

  await fs.writeFile(
    dataPath,
    JSON.stringify({
      site: {
        title: 'Legacy',
        description: 'Legacy payload',
        url: 'https://example.com',
        language: 'en',
      },
      posts: [],
      pages: [],
      categories: [],
      tags: [],
    }),
  );

  try {
    await assert.rejects(
      () => runDev([themeDir, '--data', dataPath]),
      /INVALID_(VERSION|GENERATED_AT)|UNKNOWN_PROPERTY/,
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('normalizeListenError returns a friendly message for port conflicts', () => {
  const normalized = normalizeListenError(
    Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }),
    '127.0.0.1',
    4321,
  );

  assert.match(normalized.message, /127\.0\.0\.1:4321 is already in use/);
});
