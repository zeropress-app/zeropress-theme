import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertPreviewData } from '@zeropress/preview-data-validator';
import {
  buildDevSnapshot,
  defaultPreviewData,
  normalizeListenError,
  rebuildDevSnapshot,
  resolveSnapshotResponse,
  runDev,
} from '../src/dev.js';

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
      runtime: '0.3',
      description: 'A test theme',
    }),
    'layout.html': '<html><head><title>{{meta.title}}</title>{{meta.head_tags}}</head><body>{{slot:header}}<main>{{slot:content}}</main>{{slot:footer}}</body></html>',
    'index.html': '<h1>{{site.title}}</h1><div id="posts">{{posts}}</div><div id="categories">{{categories}}</div><div id="tags">{{tags}}</div><div id="pagination">{{pagination}}</div>',
    'post.html': '<article><h1>{{post.title}}</h1><img class="author-avatar" src="{{post.author_avatar}}" alt=""><img class="post-featured-image" src="{{post.featured_image}}" alt=""><div>{{post.author_name}}</div><div>{{post.html}}</div><div>{{post.comments_html}}</div></article>',
    'page.html': '<section><h1>{{page.title}}</h1><img class="page-featured-image" src="{{page.featured_image}}" alt=""><div>{{page.html}}</div></section>',
    'archive.html': '<section><h1>Archive</h1><div>{{posts}}</div><div>{{pagination}}</div></section>',
    'category.html': '<section><h1>Category</h1><div>{{posts}}</div><div>{{categories}}</div><div>{{pagination}}</div></section>',
    'tag.html': '<section><h1>Tag</h1><div>{{posts}}</div><div>{{tags}}</div><div>{{pagination}}</div></section>',
    '404.html': '<section><h1>Custom 404</h1><p>Missing route</p></section>',
    'partials/header.html': '<header>Header</header>',
    'partials/footer.html': '<footer>Footer</footer>',
    'assets/style.css': 'body { color: black; }',
  };
}

function responseText(response) {
  return typeof response.body === 'string'
    ? response.body
    : Buffer.from(response.body).toString('utf8');
}

test('defaultPreviewData returns a valid v0.5 payload', () => {
  assert.doesNotThrow(() => assertPreviewData(defaultPreviewData()));
});

test('buildDevSnapshot serves canonical v0.5 routes, assets, and special files', async () => {
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });

    const home = resolveSnapshotResponse('/', snapshot);
    const homePage2 = resolveSnapshotResponse('/page/2', snapshot);
    const post = resolveSnapshotResponse('/posts/hello-zeropress', snapshot);
    const page = resolveSnapshotResponse('/about', snapshot);
    const archive = resolveSnapshotResponse('/archive', snapshot);
    const archivePage2 = resolveSnapshotResponse('/archive/page/2', snapshot);
    const category = resolveSnapshotResponse('/categories/general', snapshot);
    const categoryPage2 = resolveSnapshotResponse('/categories/general/page/2', snapshot);
    const tag = resolveSnapshotResponse('/tags/intro', snapshot);
    const tagPage2 = resolveSnapshotResponse('/tags/intro/page/2', snapshot);
    const asset = resolveSnapshotResponse('/assets/style.css', snapshot);
    const robots = resolveSnapshotResponse('/robots.txt', snapshot);

    assert.equal(home.status, 200);
    assert.match(responseText(home), /ZeroPress Preview/);
    assert.match(responseText(home), /Preview excerpt/);
    assert.match(responseText(home), /<title>ZeroPress Preview<\/title>/);
    assert.match(responseText(home), /property="og:type" content="website"/);
    assert.match(responseText(homePage2), /Archive Patterns/);
    assert.match(responseText(post), /Hello ZeroPress/);
    assert.match(responseText(post), /Preview post content/);
    assert.match(responseText(post), /<title>Hello ZeroPress - ZeroPress Preview<\/title>/);
    assert.match(responseText(post), /property="og:type" content="article"/);
    assert.match(responseText(post), /property="article:published_time" content="2026-02-14T09:00:00Z"/);
    assert.match(responseText(post), /class="author-avatar" src="https:\/\/media\.example\.com\/images\/author-avatar\.png\?size=96"/);
    assert.match(responseText(post), /class="post-featured-image" src="https:\/\/media\.example\.com\/images\/post-share\.png\?fit=cover"/);
    assert.match(responseText(page), /About/);
    assert.match(responseText(page), /<title>About - ZeroPress Preview<\/title>/);
    assert.match(responseText(page), /property="og:type" content="website"/);
    assert.match(responseText(page), /class="page-featured-image" src="https:\/\/media\.example\.com\/images\/about-share\.png\?format=webp"/);
    assert.doesNotMatch(responseText(page), /property="article:published_time"/);
    assert.match(responseText(archive), /Archive/);
    assert.match(responseText(archivePage2), /Archive Patterns/);
    assert.match(responseText(category), /Category/);
    assert.match(responseText(category), /General \(3\)/);
    assert.match(responseText(categoryPage2), /Archive Patterns/);
    assert.match(responseText(tag), /Tag/);
    assert.match(responseText(tag), /Intro \(3\)/);
    assert.match(responseText(tagPage2), /Archive Patterns/);
    assert.equal(asset.status, 200);
    assert.match(responseText(asset), /body\{color:black\}/);
    assert.equal(robots.status, 200);
    assert.match(responseText(robots), /User-agent:/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('buildDevSnapshot matches encoded request paths against encoded output paths', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const data = defaultPreviewData();

  data.content.posts[0].slug = '헬로우-월드';
  data.content.posts[0].title = '한글 포스트';
  data.content.posts[0].category_slugs = ['무료-ai'];
  data.content.posts[0].tag_slugs = ['업데이트'];
  data.content.posts[1].category_slugs = ['무료-ai'];
  data.content.posts[1].tag_slugs = ['업데이트'];
  data.content.posts[2].category_slugs = ['무료-ai'];
  data.content.posts[2].tag_slugs = ['업데이트'];
  data.content.pages[0].slug = '회사-소개';
  data.content.pages[0].title = '회사 소개';
  data.content.categories[0].slug = '무료-ai';
  data.content.categories[0].name = '무료 AI';
  data.content.tags[0].slug = '업데이트';
  data.content.tags[0].name = '업데이트';

  try {
    const snapshot = await buildDevSnapshot({ themeDir, previewData: data });

    const post = resolveSnapshotResponse('/posts/%ED%97%AC%EB%A1%9C%EC%9A%B0-%EC%9B%94%EB%93%9C', snapshot);
    const page = resolveSnapshotResponse('/%ED%9A%8C%EC%82%AC-%EC%86%8C%EA%B0%9C', snapshot);
    const category = resolveSnapshotResponse('/categories/%EB%AC%B4%EB%A3%8C-ai', snapshot);
    const tag = resolveSnapshotResponse('/tags/%EC%97%85%EB%8D%B0%EC%9D%B4%ED%8A%B8', snapshot);

    assert.equal(post.status, 200);
    assert.equal(page.status, 200);
    assert.equal(category.status, 200);
    assert.equal(tag.status, 200);
    assert.match(responseText(post), /한글 포스트/);
    assert.match(responseText(page), /회사 소개/);
    assert.match(responseText(category), /무료 AI \(3\)/);
    assert.match(responseText(tag), /업데이트 \(3\)/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runDev rejects v0.3 preview data payloads', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const dataPath = path.join(themeDir, 'legacy-preview.json');

  await fs.writeFile(
    dataPath,
    JSON.stringify({
      version: '0.3',
      generator: 'legacy-tool',
      generated_at: '2026-03-26T00:00:00Z',
      site: {
        title: 'Legacy',
        description: 'Legacy payload',
        url: 'https://example.com',
        language: 'en',
      },
      content: {
        posts: [],
        pages: [],
        categories: [],
        tags: [],
      },
      routes: {
        index: [],
        archive: [],
        categories: [],
        tags: [],
      },
    }),
  );

  try {
    await assert.rejects(
      () => runDev([themeDir, '--data', dataPath]),
      /0\.5|routes|menus|authors|document_type|author_id|mediaBaseUrl|locale|postsPerPage|dateFormat|disallowComments|INVALID_|UNKNOWN_PROPERTY/,
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runDev requires a themeDir argument', async () => {
  await assert.rejects(
    () => runDev([]),
    /dev requires a themeDir argument/,
  );
});

test('runDev rejects remote preview data URLs', async () => {
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    await assert.rejects(
      () => runDev([themeDir, '--data', 'https://signed-url/preview.json']),
      /--data must be a local JSON file path/,
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('resolveSnapshotResponse returns custom 404 or built-in fallback for missing routes', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const filesWithout404 = validThemeFiles();
  delete filesWithout404['404.html'];
  const themeDirWithout404 = await createThemeDir(filesWithout404);

  try {
    const customSnapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    const builtInSnapshot = await buildDevSnapshot({
      themeDir: themeDirWithout404,
      previewData: defaultPreviewData(),
    });

    const customNotFound = resolveSnapshotResponse('/page/99', customSnapshot);
    const builtInNotFound = resolveSnapshotResponse('/page/99', builtInSnapshot);

    assert.equal(customNotFound.status, 404);
    assert.match(responseText(customNotFound), /Custom 404/);
    assert.equal(builtInNotFound.status, 404);
    assert.equal(responseText(builtInNotFound), '<!doctype html><html><body><h1>404</h1><p>Not Found</p></body></html>');
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(themeDirWithout404, { recursive: true, force: true });
  }
});

test('optional route outputs return 404 when their templates are missing', async () => {
  const files = validThemeFiles();
  delete files['archive.html'];
  delete files['category.html'];
  delete files['tag.html'];
  const themeDir = await createThemeDir(files);

  try {
    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });

    assert.equal(resolveSnapshotResponse('/archive', snapshot).status, 404);
    assert.equal(resolveSnapshotResponse('/categories/general', snapshot).status, 404);
    assert.equal(resolveSnapshotResponse('/tags/intro', snapshot).status, 404);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('rebuildDevSnapshot keeps the last successful snapshot when rebuild fails', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const previewData = defaultPreviewData();

  try {
    const initialSnapshot = await buildDevSnapshot({ themeDir, previewData });
    await fs.writeFile(path.join(themeDir, 'theme.json'), '{"version":"1.0.0"}');

    const result = await rebuildDevSnapshot(
      initialSnapshot,
      () => buildDevSnapshot({ themeDir, previewData }),
    );

    assert.equal(result.changed, false);
    assert.equal(result.snapshot, initialSnapshot);
    assert.ok(result.error instanceof Error);
    assert.equal(resolveSnapshotResponse('/', result.snapshot).status, 200);
    assert.match(responseText(resolveSnapshotResponse('/', result.snapshot)), /ZeroPress Preview/);
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
