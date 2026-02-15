import fs from 'node:fs/promises';
import { watch as watchFs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
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
  ensurePreviewDataMinimum(previewData);

  const server = http.createServer((req, res) => handleRequest(req, res, themeDir, previewData));
  const wss = new WebSocketServer({ server, path: '/__zeropress_ws' });

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

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`[dev] running at ${url}`);
    if (flags.open === true) {
      openBrowser(url);
    }
  });

  const shutdown = () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    wss.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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

async function loadPreviewData(dataArg) {
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

function ensurePreviewDataMinimum(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Preview data must be an object');
  }
  if (!data.site || typeof data.site !== 'object') {
    throw new Error('Preview data must include site object');
  }
  for (const key of ['title', 'description', 'url', 'language']) {
    if (typeof data.site[key] !== 'string' || data.site[key].trim() === '') {
      throw new Error(`Preview data site.${key} is required`);
    }
  }
}

function defaultPreviewData() {
  return {
    site: {
      title: 'ZeroPress Preview',
      description: 'Default preview data',
      url: 'https://example.com',
      language: 'en',
    },
    posts: [
      {
        title: 'Hello ZeroPress',
        slug: 'hello-zeropress',
        html: '<p>Preview post content</p>',
        excerpt: 'Preview excerpt',
        published_at: '2026-02-14',
        updated_at: '2026-02-14',
        author_name: 'Admin',
      },
    ],
    pages: [
      {
        title: 'About',
        slug: 'about',
        html: '<p>About page</p>',
      },
    ],
    categories: [{ name: 'General', slug: 'general', postCount: 1 }],
    tags: [{ name: 'Intro', slug: 'intro', postCount: 1 }],
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

async function renderRoute(pathname, themeDir, data) {
  const normalized = pathname.replace(/\/+$/, '') || '/';

  if (normalized === '/') {
    return { html: await renderWithLayout(themeDir, 'index.html', { ...data, posts: renderPostList(data.posts) }) };
  }

  const postMatch = normalized.match(/^\/posts\/([^/]+)$/);
  if (postMatch) {
    const post = (data.posts || []).find((p) => p.slug === postMatch[1]);
    if (!post) {
      return { html: await render404(themeDir), notFound: true };
    }
    return { html: await renderWithLayout(themeDir, 'post.html', { ...data, post }) };
  }

  const pageMatch = normalized.match(/^\/([^/]+)$/);
  if (pageMatch && pageMatch[1] !== 'archive') {
    const page = (data.pages || []).find((p) => p.slug === pageMatch[1]);
    if (!page) {
      return { html: await render404(themeDir), notFound: true };
    }
    return { html: await renderWithLayout(themeDir, 'page.html', { ...data, page }) };
  }

  if (normalized === '/archive') {
    if (!(await fileExists(path.join(themeDir, 'archive.html')))) {
      return { html: await render404(themeDir), notFound: true };
    }
    return { html: await renderWithLayout(themeDir, 'archive.html', { ...data, posts: renderPostList(data.posts) }) };
  }

  const categoryMatch = normalized.match(/^\/categories\/([^/]+)$/);
  if (categoryMatch) {
    if (!(await fileExists(path.join(themeDir, 'category.html')))) {
      return { html: await render404(themeDir), notFound: true };
    }
    const posts = (data.posts || []).filter((post) => {
      const list = post.categories || [];
      return list.includes(categoryMatch[1]) || list.includes(capitalize(categoryMatch[1]));
    });
    return { html: await renderWithLayout(themeDir, 'category.html', { ...data, posts: renderPostList(posts) }) };
  }

  const tagMatch = normalized.match(/^\/tags\/([^/]+)$/);
  if (tagMatch) {
    if (!(await fileExists(path.join(themeDir, 'tag.html')))) {
      return { html: await render404(themeDir), notFound: true };
    }
    const posts = (data.posts || []).filter((post) => {
      const list = post.tags || [];
      return list.includes(tagMatch[1]) || list.includes(capitalize(tagMatch[1]));
    });
    return { html: await renderWithLayout(themeDir, 'tag.html', { ...data, posts: renderPostList(posts) }) };
  }

  return { html: await render404(themeDir), notFound: true };
}

function renderPostList(posts = []) {
  if (!posts.length) {
    return '<p>No posts</p>';
  }
  return posts
    .map((post) => `<article><h2><a href="/posts/${post.slug}">${escapeHtml(post.title || '')}</a></h2><div>${post.excerpt || ''}</div></article>`)
    .join('\n');
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

function capitalize(value) {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
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
