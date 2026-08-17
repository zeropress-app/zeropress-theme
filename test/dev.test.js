import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  buildDevSnapshot,
  assertPublicPathDoesNotOverlap,
  createLiveReloadWebSocketServer,
  DEFAULT_DEV_PORT,
  DEV_WEBSOCKET_MAX_PAYLOAD_BYTES,
  defaultPreviewData,
  formatDevRunningMessage,
  formatDevServerUrl,
  handleRequest,
  listenServerWithFallback,
  normalizeListenError,
  rebuildDevSnapshot,
  runDev,
  resolveDevResponse,
  resolveExistingPublicDir,
  resolvePublicDir,
  resolvePublicFileResponse,
  resolveSnapshotResponse,
} from '../src/dev.js';

function withColorEnv(env, fn) {
  const previousForceColor = process.env.FORCE_COLOR;
  const previousNoColor = process.env.NO_COLOR;

  if ('FORCE_COLOR' in env) {
    process.env.FORCE_COLOR = env.FORCE_COLOR;
  } else {
    delete process.env.FORCE_COLOR;
  }

  if ('NO_COLOR' in env) {
    process.env.NO_COLOR = env.NO_COLOR;
  } else {
    delete process.env.NO_COLOR;
  }

  try {
    return fn();
  } finally {
    if (previousForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = previousForceColor;
    }

    if (previousNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = previousNoColor;
    }
  }
}

function withPublicDirEnv(value, fn) {
  const previousValue = process.env.ZEROPRESS_PUBLIC_DIR;
  if (value === undefined) {
    delete process.env.ZEROPRESS_PUBLIC_DIR;
  } else {
    process.env.ZEROPRESS_PUBLIC_DIR = value;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousValue === undefined) {
        delete process.env.ZEROPRESS_PUBLIC_DIR;
      } else {
        process.env.ZEROPRESS_PUBLIC_DIR = previousValue;
      }
    });
}

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
      runtime: '0.7',
      description: 'A test theme',
    }),
    'layout.html': '<html><head><title>{{meta.title}}</title>{{meta.head_tags}}</head><body>{{slot:header}}<main>{{slot:content}}</main>{{slot:footer}}</body></html>',
    'index.html': '<h1>{{site.title}}</h1><div id="posts">{{#for post in posts.items}}<article>{{post.title}}{{#if post.summary}} {{post.summary}}{{/if}}</article>{{/for}}</div>',
    'post.html': '<article><h1>{{post.title}}</h1>{{#if post.author.avatar}}<img class="author-avatar" src="{{post.author.avatar}}" alt="">{{/if}}{{#if post.featured_image}}<img class="post-featured-image" src="{{post.featured_image}}" alt="">{{/if}}<div>{{post.author.display_name}}</div><div>{{post.html}}</div></article>',
    'page.html': '<section><h1>{{page.title}}</h1>{{#if page.featured_image}}<img class="page-featured-image" src="{{page.featured_image}}" alt="">{{/if}}<div>{{page.html}}</div></section>',
    'archive.html': '<section><h1>Archive</h1>{{#for group in archive.groups}}<h2>{{group.label}}</h2>{{#for post in group.items}}<article>{{post.title}}</article>{{/for}}{{/for}}</section>',
    'category.html': '<section><h1>Category</h1><div>{{taxonomy.name}} ({{taxonomy.count}})</div>{{#for post in posts.items}}<article>{{post.title}}</article>{{/for}}</section>',
    'tag.html': '<section><h1>Tag</h1><div>{{taxonomy.name}} ({{taxonomy.count}})</div>{{#for post in posts.items}}<article>{{post.title}}</article>{{/for}}</section>',
    '404.html': '<section><h1>Custom 404</h1><p>Missing route</p></section>',
    'partials/header.html': '<header>Header</header>',
    'partials/footer.html': '<footer>Footer</footer>',
    'assets/style.css': 'body { color: black; }',
    'assets/app.mjs': 'export default true;',
  };
}

function responseText(response) {
  return typeof response.body === 'string'
    ? response.body
    : Buffer.from(response.body).toString('utf8');
}

async function publicResponseText(response) {
  try {
    return (await response.fileHandle.readFile()).toString('utf8');
  } finally {
    await response.fileHandle.close();
  }
}

class FakeServer extends EventEmitter {
  constructor({ busyPorts = [] } = {}) {
    super();
    this.busyPorts = new Set(busyPorts);
    this.boundPort = null;
    this.listening = false;
  }

  listen(port) {
    queueMicrotask(() => {
      if (this.busyPorts.has(port)) {
        this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
        return;
      }

      this.boundPort = port;
      this.listening = true;
      this.emit('listening');
    });
  }

  address() {
    if (!this.listening) {
      return null;
    }

    return {
      address: '127.0.0.1',
      family: 'IPv4',
      port: this.boundPort,
    };
  }
}

class FakeWebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.clients = new Set();
  }
}

class FakeWebSocketClient extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.closeCalls = [];
    this.terminateCalls = 0;
  }

  close(code, reason) {
    this.closeCalls.push([code, reason]);
    this.readyState = 2;
  }

  terminate() {
    this.terminateCalls += 1;
    this.readyState = 3;
  }
}

class FakeResponse extends Writable {
  constructor() {
    super();
    this.status = null;
    this.headers = null;
    this.headersSent = false;
    this.body = null;
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  _final(callback) {
    this.body = Buffer.concat(this.chunks);
    callback();
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }
}

function createFakeResponse() {
  return new FakeResponse();
}

function waitForWebSocketClose(client) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket close')), 2000);
    client.once('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

test('formatDevRunningMessage uses success color when color is enabled', () => {
  const message = withColorEnv({ FORCE_COLOR: '1' }, () => (
    formatDevRunningMessage('http://127.0.0.1:4000', { isTTY: false })
  ));

  assert.equal(message, '\x1b[32m[dev] running at http://127.0.0.1:4000\x1b[0m');
});

test('formatDevServerUrl produces valid IPv4, hostname, and IPv6 URLs', () => {
  assert.equal(formatDevServerUrl('127.0.0.1', 4000), 'http://127.0.0.1:4000');
  assert.equal(formatDevServerUrl('localhost', 4000), 'http://localhost:4000');
  assert.equal(formatDevServerUrl('::1', 4000), 'http://[::1]:4000');
  assert.equal(formatDevServerUrl('fe80::1%lo0', 4000), 'http://[fe80::1%25lo0]:4000');
});

test('live reload WebSocket configures bounded inbound handling and contains errors', () => {
  const server = {};
  const logs = [];
  const wss = createLiveReloadWebSocketServer(server, {
    WebSocketServerClass: FakeWebSocketServer,
    log: (message) => logs.push(message),
  });

  assert.equal(wss.options.server, server);
  assert.equal(wss.options.path, '/__zeropress_ws');
  assert.equal(wss.options.maxPayload, DEV_WEBSOCKET_MAX_PAYLOAD_BYTES);

  wss.emit('error', new Error('unsafe\u001bserver'));
  assert.deepEqual(logs, ['[dev] websocket server error: unsafe\\u001Bserver']);

  const client = new FakeWebSocketClient();
  wss.emit('connection', client);
  client.emit('message', Buffer.from('unexpected'));
  assert.deepEqual(client.closeCalls, [[1008, 'Client messages are not supported']]);

  const failedClient = new FakeWebSocketClient();
  wss.emit('connection', failedClient);
  failedClient.emit('error', new Error('malformed frame'));
  assert.equal(failedClient.terminateCalls, 1);
});

test('malformed and oversized WebSocket input closes only the offending connection', async (t) => {
  const server = http.createServer();
  const wss = createLiveReloadWebSocketServer(server, { log: () => {} });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await new Promise((resolve) => wss.close(resolve));
    if (error?.code === 'EPERM') {
      t.skip('sandbox does not permit binding a local test server');
      return;
    }
    throw error;
  }

  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/__zeropress_ws`;
  try {
    const malformedClient = new WebSocket(url);
    malformedClient.on('error', () => {});
    await new Promise((resolve, reject) => {
      malformedClient.once('open', resolve);
      malformedClient.once('error', reject);
    });
    const malformedClose = waitForWebSocketClose(malformedClient);
    malformedClient._socket.write(Buffer.from([0xa1, 0x80, 0, 0, 0, 0]));
    await malformedClose;
    assert.equal(server.listening, true);

    const oversizedClient = new WebSocket(url);
    oversizedClient.on('error', () => {});
    await new Promise((resolve, reject) => {
      oversizedClient.once('open', resolve);
      oversizedClient.once('error', reject);
    });
    const oversizedClose = waitForWebSocketClose(oversizedClient);
    oversizedClient.send(Buffer.alloc(DEV_WEBSOCKET_MAX_PAYLOAD_BYTES + 1));
    await oversizedClose;
    assert.equal(server.listening, true);

    const messageClient = new WebSocket(url);
    messageClient.on('error', () => {});
    await new Promise((resolve, reject) => {
      messageClient.once('open', resolve);
      messageClient.once('error', reject);
    });
    const messageClose = waitForWebSocketClose(messageClient);
    messageClient.send('unexpected');
    assert.deepEqual(await messageClose, {
      code: 1008,
      reason: 'Client messages are not supported',
    });
    assert.equal(server.listening, true);
  } finally {
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test('defaultPreviewData builds a valid v0.7 dev snapshot', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const previewData = defaultPreviewData();

  try {
    assert.equal(previewData.site.media_origin, '');
    assert.equal(Object.hasOwn(previewData.site, 'media_base_url'), false);
    assert.equal(
      previewData.content.authors.every((author) => !Object.hasOwn(author, 'avatar')),
      true,
    );
    assert.equal(
      previewData.content.posts.every((post) => !Object.hasOwn(post, 'featured_image')),
      true,
    );
    assert.equal(
      previewData.content.posts.every((post) => !Object.hasOwn(post, 'allow_comments')),
      true,
    );
    assert.equal(
      previewData.content.pages.every((page) => !Object.hasOwn(page, 'featured_image')),
      true,
    );
    assert.equal(previewData.content.posts.every((post) => !Object.hasOwn(post, 'id')), true);
    assert.equal(previewData.widgets.sidebar.name, 'Sidebar Widgets');
    assert.deepEqual(
      previewData.widgets.sidebar.items.map((widget) => widget.type),
      ['profile', 'search', 'recent-posts', 'categories', 'tags', 'archives', 'link-list'],
    );
    assert.deepEqual(previewData.widgets.sidebar.items[0].settings, {
      display_name: 'Admin',
      affiliation: 'ZeroPress Theme Author',
      bio_short: 'A short profile widget for theme development and layout testing.',
    });
    assert.deepEqual(previewData.widgets.sidebar.items.at(-1).settings.links, [
      { label: 'About', url: '/about/', target: '_self' },
      { label: 'Archive', url: '/archive/', target: '_self' },
      { label: 'ZeroPress Documentation', url: 'https://zeropress.dev/', target: '_blank' },
      { label: 'ZeroPress on GitHub', url: 'https://github.com/zeropress-app/', target: '_blank' },
    ]);
    await assert.doesNotReject(
      () => buildDevSnapshot({ themeDir, previewData }),
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('buildDevSnapshot serves canonical v0.7 routes, assets, and special files', async () => {
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
    const moduleAsset = resolveSnapshotResponse('/assets/app.mjs', snapshot);
    const robots = resolveSnapshotResponse('/robots.txt', snapshot);

    assert.equal(home.status, 200);
    assert.match(responseText(home), /ZeroPress Preview/);
    assert.match(responseText(home), /Preview excerpt/);
    assert.match(responseText(home), /<title>ZeroPress Preview - Default preview data<\/title>/);
    assert.match(responseText(home), /property="og:title" content="ZeroPress Preview - Default preview data"/);
    assert.match(responseText(home), /property="og:type" content="website"/);
    assert.match(responseText(homePage2), /Archive Patterns/);
    assert.match(responseText(post), /Hello ZeroPress/);
    assert.match(responseText(post), /Preview post content/);
    assert.match(responseText(post), /<title>Hello ZeroPress - ZeroPress Preview<\/title>/);
    assert.match(responseText(post), /property="og:type" content="article"/);
    assert.match(responseText(post), /property="article:published_time" content="2026-02-14T09:00:00Z"/);
    assert.doesNotMatch(responseText(post), /class="author-avatar"/);
    assert.doesNotMatch(responseText(post), /class="post-featured-image"/);
    assert.match(responseText(page), /About/);
    assert.match(responseText(page), /<title>About - ZeroPress Preview<\/title>/);
    assert.match(responseText(page), /property="og:type" content="website"/);
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
    assert.match(responseText(asset), /body \{ color: black; \}/);
    assert.equal(moduleAsset.contentType, 'application/javascript');
    assert.equal(robots.status, 200);
    assert.match(responseText(robots), /User-agent:/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('resolveSnapshotResponse serves only generated search artifacts under _zeropress', async () => {
  const files = validThemeFiles();
  const themeJson = JSON.parse(files['theme.json']);
  themeJson.features = { search: true };
  files['theme.json'] = JSON.stringify(themeJson);
  const themeDir = await createThemeDir(files);

  try {
    const previewData = defaultPreviewData();
    previewData.site.search = { enabled: true };

    const snapshot = await buildDevSnapshot({ themeDir, previewData });
    const searchJson = resolveSnapshotResponse('/_zeropress/search.json', snapshot);
    const searchJs = resolveSnapshotResponse('/_zeropress/search.js', snapshot);
    const searchPagefindJs = resolveSnapshotResponse('/_zeropress/search_pagefind.js', snapshot);
    const blockedZeropressFile = resolveSnapshotResponse('/_zeropress/not-allowed.json', snapshot);
    const unknownZeropressFile = resolveSnapshotResponse('/_zeropress/unknown.json', snapshot);

    assert.equal(searchJson.status, 200);
    assert.equal(searchJson.contentType, 'application/json');
    assert.match(responseText(searchJson), /Hello ZeroPress/);
    assert.equal(searchJs.status, 200);
    assert.equal(searchJs.contentType, 'application/javascript');
    assert.match(responseText(searchJs), /export async function search/);
    assert.equal(searchPagefindJs.status, 200);
    assert.equal(searchPagefindJs.contentType, 'application/javascript');
    assert.match(responseText(searchPagefindJs), /pagefind\.js/);
    assert.equal(blockedZeropressFile.status, 404);
    assert.equal(unknownZeropressFile.status, 404);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('buildDevSnapshot renders fallback robots.txt from site.robots policy', async () => {
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    const previewData = defaultPreviewData();
    previewData.site.robots = {allow_indexing: false};

    const snapshot = await buildDevSnapshot({ themeDir, previewData });
    const robots = resolveSnapshotResponse('/robots.txt', snapshot);

    assert.equal(robots.status, 200);
    assert.equal(responseText(robots).trim(), 'User-agent: *\nDisallow: /');
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('decoded C0, DEL, and C1 request characters are rejected before generated or public lookup', async () => {
  const c1Characters = ['\u0080', '\u0085', '\u009f'];
  const unsafeCharacters = ['\u0000', '\u007f', ...c1Characters];
  const printableCharacter = '\u00a0';
  const snapshot = {
    files: new Map([
      ...unsafeCharacters.map((character) => [
        `assets/${character}.txt`,
        { content: 'unsafe generated entry', contentType: 'text/plain; charset=utf-8' },
      ]),
      [
        `assets/${printableCharacter}.txt`,
        { content: 'printable generated entry', contentType: 'text/plain; charset=utf-8' },
      ],
    ]),
    fallbackNotFoundHtml: 'not found',
    outputStyle: 'directory',
  };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-controls-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    await fs.mkdir(publicDir);
    for (const character of [...c1Characters, printableCharacter]) {
      await fs.writeFile(path.join(publicDir, `${character}.txt`), 'public entry', 'utf8');
    }

    for (const character of unsafeCharacters) {
      const requestPath = `/assets/${encodeURIComponent(character)}.txt`;
      assert.equal(resolveSnapshotResponse(requestPath, snapshot).status, 404);
    }
    for (const character of c1Characters) {
      const requestPath = `/${encodeURIComponent(character)}.txt`;
      assert.equal(await resolvePublicFileResponse(requestPath, publicDir), null);
    }

    const printableRequestPath = `/assets/${encodeURIComponent(printableCharacter)}.txt`;
    assert.equal(resolveSnapshotResponse(printableRequestPath, snapshot).status, 200);
    const printablePublicResponse = await resolvePublicFileResponse(
      `/${encodeURIComponent(printableCharacter)}.txt`,
      publicDir,
    );
    assert.equal(await publicResponseText(printablePublicResponse), 'public entry');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
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

test('runDev rejects unsupported preview-data versions', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const dataPath = path.join(themeDir, 'unsupported-preview.json');

  await fs.writeFile(
    dataPath,
    JSON.stringify({ ...defaultPreviewData(), version: 'unsupported' }),
  );

  try {
    await assert.rejects(
      () => runDev([themeDir, '--data', dataPath]),
      /Invalid preview-data:/,
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

test('runDev rejects extra positional arguments and the removed --open option', async () => {
  await assert.rejects(
    () => runDev(['theme-one', 'theme-two']),
    /dev accepts exactly one themeDir argument/,
  );
  await assert.rejects(
    () => runDev(['theme-one', '--open']),
    /Unknown option for dev: --open/,
  );
});

for (const option of ['port', 'host', 'data', 'public-dir']) {
  test(`runDev requires a value for --${option}`, async () => {
    const expected = new RegExp(`--${option} requires a value`);

    await assert.rejects(
      () => runDev(['theme', `--${option}`]),
      expected,
    );
    await assert.rejects(
      () => runDev(['theme', `--${option}`, '--no-js']),
      expected,
    );
  });
}

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

test('resolveSnapshotResponse honors html-extension output style for clean URLs', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const previewData = defaultPreviewData();
  previewData.site.permalinks = {
    output_style: 'html-extension',
  };
  previewData.content.pages.push({
    title: 'Deployment',
    slug: 'deployment',
    path: 'deployment/index',
    content: '<p>Deployment page</p>',
    document_type: 'html',
    status: 'published',
  });

  try {
    const snapshot = await buildDevSnapshot({ themeDir, previewData });
    const cleanUrl = resolveSnapshotResponse('/about', snapshot);
    const extensionUrl = resolveSnapshotResponse('/about.html', snapshot);
    const deploymentSlash = resolveSnapshotResponse('/deployment/', snapshot);
    const deploymentClean = resolveSnapshotResponse('/deployment', snapshot);
    const deploymentIndex = resolveSnapshotResponse('/deployment/index', snapshot);
    const deploymentIndexHtml = resolveSnapshotResponse('/deployment/index.html', snapshot);

    assert.equal(cleanUrl.status, 200);
    assert.match(responseText(cleanUrl), /About page/);
    assert.equal(extensionUrl.status, 200);
    assert.match(responseText(extensionUrl), /About page/);
    assert.equal(deploymentSlash.status, 200);
    assert.match(responseText(deploymentSlash), /Deployment page/);
    assert.equal(deploymentClean.status, 404);
    assert.equal(deploymentIndex.status, 200);
    assert.match(responseText(deploymentIndex), /Deployment page/);
    assert.equal(deploymentIndexHtml.status, 200);
    assert.match(responseText(deploymentIndexHtml), /Deployment page/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('resolveSnapshotResponse serves .html content slugs at canonical URLs for both output styles', async () => {
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    for (const [outputStyle, canonicalUrl] of [
      ['directory', '/guide.html/'],
      ['html-extension', '/guide.html'],
    ]) {
      const previewData = defaultPreviewData();
      previewData.site.permalinks = { output_style: outputStyle };
      previewData.content.pages[0].slug = 'guide.html';
      previewData.content.pages[0].title = `${outputStyle} HTML slug`;

      const snapshot = await buildDevSnapshot({ themeDir, previewData });
      const response = resolveSnapshotResponse(canonicalUrl, snapshot);

      assert.equal(response.status, 200);
      assert.match(responseText(response), new RegExp(`${outputStyle} HTML slug`));
    }
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('resolveSnapshotResponse serves directory index requests for directory output style', async () => {
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    const cleanUrl = resolveSnapshotResponse('/about', snapshot);
    const slashUrl = resolveSnapshotResponse('/about/', snapshot);
    const indexHtmlUrl = resolveSnapshotResponse('/about/index.html', snapshot);

    assert.equal(cleanUrl.status, 200);
    assert.match(responseText(cleanUrl), /About page/);
    assert.equal(slashUrl.status, 200);
    assert.match(responseText(slashUrl), /About page/);
    assert.equal(indexHtmlUrl.status, 200);
    assert.match(responseText(indexHtmlUrl), /About page/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('resolveDevResponse serves generated output before public files', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    await fs.mkdir(path.join(publicDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(publicDir, 'assets', 'style.css'), 'body { color: red; }', 'utf8');

    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    const response = await resolveDevResponse('/assets/style.css', snapshot, publicDir);

    assert.equal(response.status, 200);
    assert.match(responseText(response), /body \{ color: black; \}/);
    assert.doesNotMatch(responseText(response), /color: red/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolveDevResponse serves exact public files as fallback', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    await fs.mkdir(path.join(publicDir, 'vendor'), { recursive: true });
    await fs.mkdir(path.join(publicDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(publicDir, 'favicon.ico'), 'icon', 'utf8');
    await fs.writeFile(path.join(publicDir, 'favicon.dark.ico'), 'dark icon', 'utf8');
    await fs.writeFile(path.join(publicDir, 'vendor', 'app.js'), 'console.log("public")', 'utf8');
    await fs.writeFile(path.join(publicDir, 'docs', 'foo.md'), '# Foo', 'utf8');
    await fs.writeFile(path.join(publicDir, 'docs', 'index.html'), '<h1>Docs index</h1>', 'utf8');

    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    const favicon = await resolveDevResponse('/favicon.ico', snapshot, publicDir);
    const darkFavicon = await resolveDevResponse('/favicon.dark.ico', snapshot, publicDir);
    const script = await resolveDevResponse('/vendor/app.js', snapshot, publicDir);
    const markdown = await resolveDevResponse('/docs/foo.md', snapshot, publicDir);
    const directoryIndex = await resolveDevResponse('/docs/', snapshot, publicDir);
    const missing = await resolveDevResponse('/missing.txt', snapshot, publicDir);

    assert.equal(favicon.status, 200);
    assert.equal(favicon.contentType, 'image/x-icon');
    assert.equal(await publicResponseText(favicon), 'icon');
    assert.equal(darkFavicon.status, 200);
    assert.equal(darkFavicon.contentType, 'image/x-icon');
    assert.equal(await publicResponseText(darkFavicon), 'dark icon');
    assert.equal(script.contentType, 'text/javascript; charset=utf-8');
    assert.equal(await publicResponseText(script), 'console.log("public")');
    assert.equal(markdown.contentType, 'text/markdown; charset=utf-8');
    assert.equal(await publicResponseText(markdown), '# Foo');
    assert.equal(directoryIndex.status, 200);
    assert.equal(directoryIndex.contentType, 'text/html; charset=utf-8');
    assert.equal(await publicResponseText(directoryIndex), '<h1>Docs index</h1>');
    assert.equal(missing.status, 404);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('buildDevSnapshot injects discovered public favicon links', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, 'favicon.ico'), 'icon', 'utf8');
    await fs.writeFile(path.join(publicDir, 'favicon.dark.ico'), 'dark icon', 'utf8');
    await fs.writeFile(path.join(publicDir, 'favicon.svg'), '<svg></svg>', 'utf8');
    await fs.writeFile(path.join(publicDir, 'favicon.png'), 'png', 'utf8');
    await fs.writeFile(path.join(publicDir, 'apple-touch-icon.png'), 'apple', 'utf8');

    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData(), publicDir });
    const response = await resolveSnapshotResponse('/index.html', snapshot);
    const html = responseText(response);

    assert.match(html, /<link rel="icon" href="\/favicon\.ico" media="\(prefers-color-scheme: light\)">/);
    assert.match(html, /<link rel="icon" href="\/favicon\.dark\.ico" media="\(prefers-color-scheme: dark\)">/);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" media="\(prefers-color-scheme: light\)">/);
    assert.match(html, /<link rel="icon" href="\/favicon\.png" type="image\/png" media="\(prefers-color-scheme: light\)">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('buildDevSnapshot links root public sitemap.xsl from generated sitemap', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, 'sitemap.xsl'), '<xsl:stylesheet version="1.0"></xsl:stylesheet>', 'utf8');

    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData(), publicDir });
    const sitemap = resolveSnapshotResponse('/sitemap.xml', snapshot);
    const stylesheet = await resolveDevResponse('/sitemap.xsl', snapshot, publicDir);

    assert.match(
      responseText(sitemap),
      /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<\?xml-stylesheet type="text\/xsl" href="\/sitemap\.xsl"\?>\n<urlset/,
    );
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.contentType, 'application/xslt+xml; charset=utf-8');
    assert.equal(await publicResponseText(stylesheet), '<xsl:stylesheet version="1.0"></xsl:stylesheet>');
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolveDevResponse serves public robots.txt before generated fallback robots', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(
      path.join(publicDir, 'robots.txt'),
      'User-agent: *\nDisallow: /\n\nUser-agent: Cloudflare-AI-Search\nAllow: /\n',
      'utf8',
    );

    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData(), publicDir });
    const robots = await resolveDevResponse('/robots.txt', snapshot, publicDir);

    assert.equal(robots.status, 200);
    assert.equal(await publicResponseText(robots), 'User-agent: *\nDisallow: /\n\nUser-agent: Cloudflare-AI-Search\nAllow: /\n');
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('public fallback streams large files without attaching an in-memory body', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-large-'));
  const publicDir = path.join(tempDir, 'public');
  const largeBody = Buffer.alloc((8 * 1024 * 1024) + 17, 0x61);
  try {
    await fs.mkdir(publicDir);
    await fs.writeFile(path.join(publicDir, 'large.bin'), largeBody);
    const response = await resolvePublicFileResponse('/large.bin', publicDir);
    assert.equal(response.body, undefined);
    assert.equal(response.contentLength, largeBody.length);
    assert.equal((await response.fileHandle.read(Buffer.alloc(4), 0, 4, 0)).bytesRead, 4);
    await response.fileHandle.close();

    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    const res = createFakeResponse();
    await handleRequest({ url: '/large.bin' }, res, snapshot, publicDir);
    assert.equal(res.body.length, largeBody.length);
    assert.equal(res.headers['content-length'], String(largeBody.length));
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('public HTML live reload injection appends without matching body-like script content', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-html-boundary-'));
  const publicDir = path.join(tempDir, 'public');
  try {
    await fs.mkdir(publicDir);
    const prefix = '<!doctype html><body><script>const example = "</body>";</script>'
      + 'x'.repeat(65533 - '<!doctype html><body><script>const example = "</body>";</script>'.length);
    const originalHtml = `${prefix}</body>`;
    await fs.writeFile(path.join(publicDir, 'boundary.html'), originalHtml);
    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    const res = createFakeResponse();
    await handleRequest({ url: '/boundary.html' }, res, snapshot, publicDir);
    const renderedHtml = res.body.toString('utf8');
    assert.equal(renderedHtml.startsWith(originalHtml), true);
    assert.match(renderedHtml.slice(originalHtml.length), /__zeropress_ws/);
    assert.equal(res.headers['content-length'], undefined);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolvePublicDir uses ZEROPRESS_PUBLIC_DIR when provided', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));

  try {
    assert.equal(resolvePublicDir(cwd), path.join(cwd, 'public'));
    await withPublicDirEnv('docs', () => {
      assert.equal(resolvePublicDir(cwd), path.join(cwd, 'docs'));
      assert.equal(resolvePublicDir(cwd, 'assets'), path.join(cwd, 'assets'));
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resolvePublicFileResponse ignores private public entries', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    await fs.mkdir(path.join(publicDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(publicDir, '.vscode'), { recursive: true });
    await fs.mkdir(path.join(publicDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(publicDir, '.env'), 'secret', 'utf8');
    await fs.writeFile(path.join(publicDir, '.DS_Store'), 'metadata', 'utf8');
    await fs.writeFile(path.join(publicDir, '.git', 'config'), 'git config', 'utf8');
    await fs.writeFile(path.join(publicDir, '.vscode', 'settings.json'), '{}', 'utf8');
    await fs.writeFile(path.join(publicDir, 'node_modules', 'x.js'), 'module', 'utf8');
    await fs.writeFile(path.join(publicDir, 'Thumbs.db'), 'thumbs', 'utf8');
    await fs.writeFile(path.join(publicDir, 'private.key'), 'key', 'utf8');
    await fs.writeFile(path.join(publicDir, 'cert.PEM'), 'pem', 'utf8');

    for (const requestPath of [
      '/.env',
      '/.DS_Store',
      '/.git/config',
      '/.vscode/settings.json',
      '/node_modules/x.js',
      '/Thumbs.db',
      '/private.key',
      '/cert.PEM',
      '/node_modules%5Cx.js',
    ]) {
      assert.equal(await resolvePublicFileResponse(requestPath, publicDir), null);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolvePublicFileResponse does not serve files outside public', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'secret.txt'), 'secret', 'utf8');

    const response = await resolvePublicFileResponse('/%2e%2e/secret.txt', publicDir);

    assert.equal(response, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolvePublicFileResponse does not follow symlinked directories outside public', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');
  const outsideDir = path.join(tempDir, 'outside');

  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret', 'utf8');
    await fs.symlink(outsideDir, path.join(publicDir, 'linked'));

    const response = await resolvePublicFileResponse('/linked/secret.txt', publicDir);

    assert.equal(response, null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runDev rejects theme directories that overlap the public directory', async () => {
  const cwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dev-'));

  try {
    process.chdir(tempDir);
    await fs.mkdir(path.join(tempDir, 'public', 'theme'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'public', 'theme', 'theme.json'), '{}', 'utf8');

    await assert.rejects(
      () => runDev(['public']),
      /Theme directory must not overlap the public directory:/,
    );
    await assert.rejects(
      () => runDev(['public/theme']),
      /Theme directory must not overlap the public directory:/,
    );
  } finally {
    process.chdir(cwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('public overlap detection treats a child named ..theme as inside the public directory', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dotdot-name-'));
  const publicDir = path.join(tempDir, 'public');
  const childDir = path.join(publicDir, '..theme');
  try {
    await fs.mkdir(childDir, { recursive: true });
    await assert.rejects(
      () => assertPublicPathDoesNotOverlap('Theme directory', childDir, tempDir, publicDir),
      /must not overlap the public directory/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runDev rolls back watchers and websocket state when strict-port startup fails', async (t) => {
  const themeDir = await createThemeDir(validThemeFiles());
  const blocker = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await fs.rm(themeDir, { recursive: true, force: true });
    if (error?.code === 'EPERM') {
      t.skip('sandbox does not permit binding a local test server');
      return;
    }
    throw error;
  }
  const address = blocker.address();
  try {
    await assert.rejects(
      () => runDev([themeDir, '--port', String(address.port), '--strict-port']),
      /already in use/,
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runDev rejects a direct symlink theme root even when its target is inside public', {
  skip: process.platform === 'win32',
}, async () => {
  const cwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dev-'));
  const publicDir = path.join(tempDir, 'public');
  const themeDir = path.join(publicDir, 'theme');
  const themeAlias = path.join(tempDir, 'theme-alias');

  try {
    process.chdir(tempDir);
    await fs.mkdir(themeDir, { recursive: true });
    await fs.writeFile(path.join(themeDir, 'theme.json'), '{}', 'utf8');
    await fs.symlink(themeDir, themeAlias);

    await assert.rejects(
      () => runDev(['theme-alias']),
      /Theme directory must be a real directory and must not be a symbolic link:/,
    );
  } finally {
    process.chdir(cwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runDev rejects a symbolic-link theme root outside public', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const aliasPath = `${themeDir}-alias`;
  await fs.symlink(themeDir, aliasPath, 'dir');

  try {
    await assert.rejects(
      () => runDev([aliasPath]),
      /Theme directory must be a real directory and must not be a symbolic link/,
    );
  } finally {
    await fs.unlink(aliasPath).catch(() => {});
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runDev rejects theme directories that overlap ZEROPRESS_PUBLIC_DIR', async () => {
  const cwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dev-'));

  try {
    process.chdir(tempDir);
    await fs.mkdir(path.join(tempDir, 'docs', 'theme'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'docs', 'theme', 'theme.json'), '{}', 'utf8');

    await assert.rejects(
      () => withPublicDirEnv('docs', () => runDev(['docs'])),
      /Theme directory must not overlap the public directory:/,
    );
    await assert.rejects(
      () => withPublicDirEnv('docs', () => runDev(['docs/theme'])),
      /Theme directory must not overlap the public directory:/,
    );
  } finally {
    process.chdir(cwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runDev rejects theme directories that overlap --public-dir', async () => {
  const cwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dev-'));

  try {
    process.chdir(tempDir);
    await fs.mkdir(path.join(tempDir, 'docs', 'theme'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'docs', 'theme', 'theme.json'), '{}', 'utf8');

    await assert.rejects(
      () => runDev(['docs', '--public-dir', 'docs']),
      /Theme directory must not overlap the public directory:/,
    );
    await assert.rejects(
      () => runDev(['docs/theme', '--public-dir', 'docs']),
      /Theme directory must not overlap the public directory:/,
    );
  } finally {
    process.chdir(cwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runDev rejects a ZEROPRESS_PUBLIC_DIR path that is not a directory', async () => {
  const cwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dev-'));
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    process.chdir(tempDir);
    await fs.writeFile(path.join(tempDir, 'docs'), 'not a directory', 'utf8');

    await assert.rejects(
      () => withPublicDirEnv('docs', () => runDev([themeDir])),
      /Public path is not a directory:/,
    );
  } finally {
    process.chdir(cwd);
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runDev rejects a --public-dir path that is not a directory', async () => {
  const cwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-dev-'));
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    process.chdir(tempDir);
    await fs.writeFile(path.join(tempDir, 'docs'), 'not a directory', 'utf8');

    await assert.rejects(
      () => runDev([themeDir, '--public-dir', 'docs']),
      /Public path is not a directory:/,
    );
  } finally {
    process.chdir(cwd);
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('handleRequest injects live reload into public HTML fallback', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');
  const res = createFakeResponse();

  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, 'snippet.html'), '<!doctype html><html><body>Public</body></html>', 'utf8');

    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    await handleRequest({ url: '/snippet.html' }, res, snapshot, publicDir);

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(responseText({ body: res.body }), /__zeropress_ws/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('handleRequest no-js mode adds CSP to HTML and skips live reload injection', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const res = createFakeResponse();

  try {
    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    await handleRequest({ url: '/' }, res, snapshot, null, { noJs: true });

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html');
    assert.equal(res.headers['content-security-policy'], "script-src 'none'");
    assert.doesNotMatch(responseText({ body: res.body }), /__zeropress_ws/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('handleRequest no-js mode does not add CSP to non-HTML responses', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const res = createFakeResponse();

  try {
    const snapshot = await buildDevSnapshot({ themeDir, previewData: defaultPreviewData() });
    await handleRequest({ url: '/assets/style.css' }, res, snapshot, null, { noJs: true });

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/css');
    assert.equal(res.headers['content-security-policy'], undefined);
    assert.match(responseText({ body: res.body }), /body \{ color: black; \}/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('handleRequest keeps internal errors out of 500 responses and logs safe details', async () => {
  const sensitiveMessage = 'cannot read /private/theme.json\u001B]8;;https://example.test\u0007';
  const snapshot = {
    files: {
      get() {
        throw new Error(sensitiveMessage);
      },
    },
    outputStyle: 'directory',
  };
  const res = createFakeResponse();
  const errors = [];
  const originalError = console.error;
  console.error = (message) => {
    errors.push(String(message));
  };

  try {
    await handleRequest({ url: '/' }, res, snapshot);
  } finally {
    console.error = originalError;
  }

  assert.equal(res.status, 500);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(responseText({ body: res.body }), 'Internal Server Error');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot read \/private\/theme\.json/);
  assert.match(errors[0], /\\u001B]8;;https:\/\/example\.test\\u0007/);
  assert.equal(errors[0].includes('\u001B'), false);
  assert.equal(errors[0].includes('\u0007'), false);
});

test('resolveExistingPublicDir returns a public directory only when it exists as a directory', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-public-'));
  const publicDir = path.join(tempDir, 'public');

  try {
    assert.equal(await resolveExistingPublicDir(publicDir), null);

    await fs.mkdir(publicDir);
    assert.equal(await resolveExistingPublicDir(publicDir), await fs.realpath(publicDir));

    await fs.rm(publicDir, { recursive: true, force: true });
    await fs.writeFile(publicDir, 'not a directory', 'utf8');
    await assert.rejects(
      () => resolveExistingPublicDir(publicDir),
      /Public path is not a directory:/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('resolveExistingPublicDir accepts ancestor aliases and pins the canonical public root', {
  skip: process.platform === 'win32',
}, async () => {
  const canonicalTmpDir = await fs.realpath(os.tmpdir());
  const parent = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-public-alias-'));
  const firstRoot = path.join(parent, 'first');
  const secondRoot = path.join(parent, 'second');
  const aliasRoot = path.join(parent, 'alias');
  await fs.mkdir(path.join(firstRoot, 'public'), { recursive: true });
  await fs.mkdir(path.join(secondRoot, 'public'), { recursive: true });
  await fs.writeFile(path.join(firstRoot, 'public', 'identity.txt'), 'first');
  await fs.writeFile(path.join(secondRoot, 'public', 'identity.txt'), 'second');
  await fs.symlink(firstRoot, aliasRoot, 'dir');

  try {
    const publicDir = await resolveExistingPublicDir(path.join(aliasRoot, 'public'));
    await fs.unlink(aliasRoot);
    await fs.symlink(secondRoot, aliasRoot, 'dir');

    assert.equal(publicDir, await fs.realpath(path.join(firstRoot, 'public')));
    const response = await resolvePublicFileResponse('/identity.txt', publicDir);
    assert.equal(await publicResponseText(response), 'first');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('resolveExistingPublicDir rejects a direct symbolic-link root', {
  skip: process.platform === 'win32',
}, async () => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'zeropress-theme-public-root-link-'));
  const publicDir = path.join(parent, 'public');
  const aliasPath = path.join(parent, 'public-alias');
  await fs.mkdir(publicDir);
  await fs.symlink(publicDir, aliasPath, 'dir');

  try {
    await assert.rejects(
      () => resolveExistingPublicDir(aliasPath),
      /Public path must be a real directory and must not be a symbolic link/,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
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
    DEFAULT_DEV_PORT,
  );

  assert.match(normalized.message, /127\.0\.0\.1:4000 is already in use/);
});

test('listenServerWithFallback uses the next available port when the requested port is busy', async () => {
  const server = new FakeServer({ busyPorts: [DEFAULT_DEV_PORT, DEFAULT_DEV_PORT + 1] });

  const selectedPort = await listenServerWithFallback(server, '127.0.0.1', DEFAULT_DEV_PORT);
  const address = server.address();

  assert.equal(selectedPort, DEFAULT_DEV_PORT + 2);
  assert.ok(address && typeof address === 'object');
  assert.equal(address.port, selectedPort);
});

test('listenServerWithFallback rejects the requested port when strictPort is true', async () => {
  const server = new FakeServer({ busyPorts: [DEFAULT_DEV_PORT] });

  await assert.rejects(
    () => listenServerWithFallback(server, '127.0.0.1', DEFAULT_DEV_PORT, { strictPort: true }),
    /already in use.*--strict-port/,
  );

  assert.equal(server.listening, false);
});
