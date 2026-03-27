import fs from 'node:fs/promises';
import { watch as watchFs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { PREVIEW_DATA_VERSION, assertPreviewData } from '@zeropress/preview-data-validator';
import { MAX_REMOTE_DATA_BYTES, REMOTE_TIMEOUT_MS } from './constants.js';
import { getThemeDir, isHttpUrl, isHttpsUrl } from './helpers.js';
import { validateThemeDirectory } from './validate.js';

export async function runDev(argv) {
  const { positional, flags } = parseDevArgs(argv);
  const themeDir = getThemeDir(positional[0]);
  const host = flags.host || '127.0.0.1';
  const port = Number(flags.port || 4321);
  const noJsCheck = flags['no-js-check'] === true;

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port: ${flags.port}`);
  }

  const validation = await validateThemeDirectory(themeDir, { noJsCheck });
  if (validation.errors.length > 0) {
    throw new Error(`Theme validation failed before dev start (${validation.errors.length} errors)`);
  }
  if (validation.warnings.length > 0) {
    console.log(`[dev] warnings: ${validation.warnings.length}`);
  }

  const previewData = await loadPreviewData(flags.data);
  assertPreviewData(previewData);

  const server = http.createServer((req, res) => handleRequest(req, res, themeDir, previewData));
  await listenServer(server, host, port);

  const wss = new WebSocketServer({ server, path: '/__zeropress_ws' });
  const sockets = new Set();
  let shuttingDown = false;

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  const watchers = await createWatchers(themeDir, async () => {
    if (!noJsCheck) {
      const quick = await validateThemeDirectory(themeDir, { noJsCheck: false });
      if (quick.errors.length > 0) {
        console.log(`[dev] validation errors on change: ${quick.errors.length}`);
      }
    }

    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send('reload');
      }
    }
  });

  const url = `http://${host}:${port}`;
  console.log(`[dev] running at ${url}`);
  if (flags.open === true) {
    openBrowser(url);
  }

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[dev] received ${signal}, shutting down...`);

    for (const watcher of watchers) {
      watcher.close();
    }

    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();

    for (const socket of sockets) {
      socket.destroy();
    }

    const forceExit = setTimeout(() => {
      process.exit(0);
    }, 1500);
    forceExit.unref();

    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

function parseDevArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    if (key === 'open' || key === 'no-js-check') {
      flags[key] = true;
      continue;
    }

    if (key === 'port' || key === 'host' || key === 'data') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`--${key} requires a value`);
      }
      flags[key] = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown option for dev: ${token}`);
  }

  return { positional, flags };
}

function listenServer(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(normalizeListenError(error, host, port));
    };

    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export function normalizeListenError(error, host, port) {
  if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
    return new Error(`Dev server could not start: ${host}:${port} is already in use. Try --port with a different value.`);
  }

  return error instanceof Error ? error : new Error(String(error));
}

export async function loadPreviewData(dataArg) {
  if (!dataArg) {
    return defaultPreviewData();
  }

  if (isHttpUrl(dataArg)) {
    if (!isHttpsUrl(dataArg)) {
      throw new Error('--data URL must use https');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);

    try {
      const response = await fetch(dataArg, { redirect: 'follow', signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch preview data (${response.status})`);
      }
      const raw = new Uint8Array(await response.arrayBuffer());
      if (raw.byteLength > MAX_REMOTE_DATA_BYTES) {
        throw new Error('Remote preview JSON exceeds 1MB limit');
      }
      return JSON.parse(new TextDecoder().decode(raw));
    } finally {
      clearTimeout(timeout);
    }
  }

  const localPath = path.resolve(process.cwd(), dataArg);
  const raw = await fs.readFile(localPath, 'utf8');
  return JSON.parse(raw);
}

export function defaultPreviewData() {
  return {
    version: PREVIEW_DATA_VERSION,
    generator: 'zeropress-theme',
    generated_at: '2026-03-26T00:00:00.000Z',
    site: {
      title: 'ZeroPress Preview',
      description: 'Default preview data',
      url: 'https://example.com',
      language: 'en',
    },
    content: {
      posts: [
        {
          id: 'post-1',
          public_id: 101,
          title: 'Hello ZeroPress',
          slug: 'hello-zeropress',
          html: '<p>Preview post content</p>',
          excerpt: 'Preview excerpt',
          published_at: '2026-02-14 09:00',
          updated_at: '2026-02-14 09:00',
          published_at_iso: '2026-02-14T09:00:00.000Z',
          updated_at_iso: '2026-02-14T09:00:00.000Z',
          reading_time: '1 min read',
          author_name: 'Admin',
          categories_html: '<a href="/categories/general/" class="category-link">General</a>',
          tags_html: '<a href="/tags/intro/" class="tag-link">Intro</a>',
          comments_html: '<section id="comments"></section>',
          status: 'published',
        },
      ],
      pages: [
        {
          id: 'page-1',
          title: 'About',
          slug: 'about',
          html: '<p>About page</p>',
          status: 'published',
        },
      ],
      categories: [{ id: 'cat-1', name: 'General', slug: 'general', description: 'General posts', postCount: 1 }],
      tags: [{ id: 'tag-1', name: 'Intro', slug: 'intro', postCount: 1 }],
    },
    routes: {
      index: {
        posts: '<article><h2><a href="/posts/hello-zeropress">Hello ZeroPress</a></h2><div>Preview excerpt</div></article>',
        categories: '<a href="/categories/general/" class="category-link">General (1)</a>',
        tags: '<a href="/tags/intro/" class="tag-link">Intro (1)</a>',
        pagination: '',
      },
      archive: {
        posts: '<article><h2><a href="/posts/hello-zeropress">Hello ZeroPress</a></h2><div>Preview excerpt</div></article>',
        pagination: '',
      },
      categories: [
        {
          slug: 'general',
          posts: '<article><h2><a href="/posts/hello-zeropress">Hello ZeroPress</a></h2><div>Preview excerpt</div></article>',
          pagination: '',
          categories: '<a href="/categories/general/" class="category-link">General (1)</a>',
        },
      ],
      tags: [
        {
          slug: 'intro',
          posts: '<article><h2><a href="/posts/hello-zeropress">Hello ZeroPress</a></h2><div>Preview excerpt</div></article>',
          pagination: '',
          tags: '<a href="/tags/intro/" class="tag-link">Intro (1)</a>',
        },
      ],
    },
  };
}

async function handleRequest(req, res, themeDir, data) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/assets/')) {
      const assetPath = path.join(themeDir, pathname);
      const content = await fs.readFile(assetPath);
      const type = pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      send(res, 200, type, content);
      return;
    }

    const rendered = await renderRoute(pathname, themeDir, data);
    if (rendered.notFound) {
      send(res, 404, 'text/html; charset=utf-8', injectLiveReload(rendered.html));
      return;
    }

    send(res, 200, 'text/html; charset=utf-8', injectLiveReload(rendered.html));
  } catch (error) {
    send(res, 500, 'text/plain; charset=utf-8', `Internal error: ${error.message}`);
  }
}

export async function renderRoute(pathname, themeDir, data) {
  const normalized = pathname.replace(/\/+$/, '') || '/';

  if (normalized === '/') {
    return { html: await renderWithLayout(themeDir, 'index.html', { ...data, ...data.routes.index }) };
  }

  const postMatch = normalized.match(/^\/posts\/([^/]+)$/);
  if (postMatch) {
    const post = (data.content.posts || []).find((p) => p.slug === postMatch[1]);
    if (!post) {
      return { html: await render404(themeDir), notFound: true };
    }
    return { html: await renderWithLayout(themeDir, 'post.html', { ...data, post }) };
  }

  const pageMatch = normalized.match(/^\/([^/]+)$/);
  if (pageMatch && pageMatch[1] !== 'archive') {
    const page = (data.content.pages || []).find((p) => p.slug === pageMatch[1]);
    if (!page) {
      return { html: await render404(themeDir), notFound: true };
    }
    return { html: await renderWithLayout(themeDir, 'page.html', { ...data, page }) };
  }

  if (normalized === '/archive') {
    if (!(await fileExists(path.join(themeDir, 'archive.html')))) {
      return { html: await render404(themeDir), notFound: true };
    }
    return { html: await renderWithLayout(themeDir, 'archive.html', { ...data, ...data.routes.archive }) };
  }

  const categoryMatch = normalized.match(/^\/categories\/([^/]+)$/);
  if (categoryMatch) {
    if (!(await fileExists(path.join(themeDir, 'category.html')))) {
      return { html: await render404(themeDir), notFound: true };
    }
    const routeData = (data.routes.categories || []).find((entry) => entry.slug === categoryMatch[1]);
    if (!routeData) {
      return { html: await render404(themeDir), notFound: true };
    }
    return { html: await renderWithLayout(themeDir, 'category.html', { ...data, ...routeData }) };
  }

  const tagMatch = normalized.match(/^\/tags\/([^/]+)$/);
  if (tagMatch) {
    if (!(await fileExists(path.join(themeDir, 'tag.html')))) {
      return { html: await render404(themeDir), notFound: true };
    }
    const routeData = (data.routes.tags || []).find((entry) => entry.slug === tagMatch[1]);
    if (!routeData) {
      return { html: await render404(themeDir), notFound: true };
    }
    return { html: await renderWithLayout(themeDir, 'tag.html', { ...data, ...routeData }) };
  }

  return { html: await render404(themeDir), notFound: true };
}

async function renderWithLayout(themeDir, templateName, data) {
  const [layout, template] = await Promise.all([
    fs.readFile(path.join(themeDir, 'layout.html'), 'utf8'),
    fs.readFile(path.join(themeDir, templateName), 'utf8'),
  ]);

  const header = await readOptional(path.join(themeDir, 'partials', 'header.html'));
  const footer = await readOptional(path.join(themeDir, 'partials', 'footer.html'));
  const body = substitute(template, data);

  const withSlots = layout
    .replace(/\{\{slot:content\}\}/g, body)
    .replace(/\{\{slot:header\}\}/g, header)
    .replace(/\{\{slot:footer\}\}/g, footer)
    .replace(/\{\{slot:meta\}\}/g, '');

  return substitute(withSlots, data);
}

async function render404(themeDir) {
  const custom404 = path.join(themeDir, '404.html');
  if (await fileExists(custom404)) {
    return renderWithLayout(themeDir, '404.html', {
      site: {
        title: '404',
        description: 'Not found',
      },
    });
  }
  return '<!doctype html><html><body><h1>404</h1><p>Not Found</p></body></html>';
}

function substitute(template, data) {
  return template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, key) => {
    if (key.startsWith('slot:')) {
      return `{{${key}}}`;
    }
    const value = getByPath(data, key);
    return value == null ? '' : String(value);
  });
}

function getByPath(obj, key) {
  const parts = key.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function injectLiveReload(html) {
  const script = `\n<script>\n(() => {\n  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__zeropress_ws');\n  ws.onmessage = (event) => { if (event.data === 'reload') location.reload(); };\n})();\n</script>\n`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${script}</body>`);
  }
  return `${html}${script}`;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createWatchers(rootDir, onChange) {
  const watchers = [];

  async function watchDir(dir) {
    const watcher = watchFs(dir, { persistent: true }, () => {
      onChange().catch((error) => {
        console.log(`[dev] reload trigger error: ${error.message}`);
      });
    });
    watchers.push(watcher);

    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await watchDir(path.join(dir, entry.name));
      }
    }
  }

  await watchDir(rootDir);
  return watchers;
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}
