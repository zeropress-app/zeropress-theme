import fs from 'node:fs/promises';
import { watch as watchFs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { PREVIEW_DATA_VERSION, assertPreviewData } from '@zeropress/preview-data-validator';
import { buildSiteFromThemeDir, MemoryWriter } from '@zeropress/build-core';
import { getThemeDir } from './helpers.js';

const DEV_BUILD_OPTIONS = {
  assetHashing: false,
  generateSpecialFiles: true,
  injectHtmx: false,
  writeManifest: false,
};

const SPECIAL_FILE_PATHS = new Set([
  '/404.html',
  '/feed.xml',
  '/meta.json',
  '/robots.txt',
  '/sitemap.xml',
]);

const BUILTIN_404_HTML = '<!doctype html><html><body><h1>404</h1><p>Not Found</p></body></html>';

export async function runDev(argv) {
  const { positional, flags } = parseDevArgs(argv);
  const themeDir = getThemeDir(positional[0]);
  const host = flags.host || '127.0.0.1';
  const port = Number(flags.port || 4321);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port: ${flags.port}`);
  }

  const buildSnapshot = async () => buildDevSnapshot({
    themeDir,
    previewData: await loadPreviewData(flags.data),
  });

  let snapshot = await buildSnapshot();
  const server = http.createServer((req, res) => handleRequest(req, res, snapshot));
  await listenServer(server, host, port);

  const wss = new WebSocketServer({ server, path: '/__zeropress_ws' });
  const sockets = new Set();
  let shuttingDown = false;
  let rebuilding = false;
  let queued = false;

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  const triggerRebuild = async () => {
    if (rebuilding) {
      queued = true;
      return;
    }

    rebuilding = true;
    do {
      queued = false;
      const result = await rebuildDevSnapshot(snapshot, buildSnapshot);
      if (result.changed) {
        snapshot = result.snapshot;
        for (const client of wss.clients) {
          if (client.readyState === 1) {
            client.send('reload');
          }
        }
      } else {
        console.log(`[dev] rebuild failed: ${result.error.message}`);
      }
    } while (queued);
    rebuilding = false;
  };

  const extraWatchPaths = [];
  const dataFilePath = resolveLocalDataPath(flags.data);
  if (dataFilePath) {
    extraWatchPaths.push(dataFilePath);
  }

  const watchers = await createWatchers(themeDir, extraWatchPaths, triggerRebuild);

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
    if (key === 'open') {
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

  const localPath = resolveLocalDataPath(dataArg);
  const raw = await fs.readFile(localPath, 'utf8');
  return JSON.parse(raw);
}

export function resolveLocalDataPath(dataArg) {
  if (!dataArg) {
    return null;
  }

  if (/^https?:\/\//i.test(dataArg)) {
    throw new Error('--data must be a local JSON file path');
  }

  return path.resolve(process.cwd(), dataArg);
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
      locale: 'en-US',
      postsPerPage: 2,
      dateFormat: 'YYYY-MM-DD',
      timeFormat: 'HH:mm',
      timezone: 'UTC',
      disallowComments: false,
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
          published_at_iso: '2026-02-14T09:00:00.000Z',
          updated_at_iso: '2026-02-14T09:00:00.000Z',
          author_name: 'Admin',
          status: 'published',
          allow_comments: true,
          category_slugs: ['general'],
          tag_slugs: ['intro'],
        },
        {
          id: 'post-2',
          public_id: 102,
          title: 'Theme Blocks Deep Dive',
          slug: 'theme-blocks-deep-dive',
          html: '<p>Second preview post content</p>',
          excerpt: 'Second preview excerpt',
          published_at_iso: '2026-02-13T09:00:00.000Z',
          updated_at_iso: '2026-02-13T09:00:00.000Z',
          author_name: 'Admin',
          status: 'published',
          allow_comments: true,
          category_slugs: ['general'],
          tag_slugs: ['intro'],
        },
        {
          id: 'post-3',
          public_id: 103,
          title: 'Archive Patterns',
          slug: 'archive-patterns',
          html: '<p>Third preview post content</p>',
          excerpt: 'Third preview excerpt',
          published_at_iso: '2026-02-12T09:00:00.000Z',
          updated_at_iso: '2026-02-12T09:00:00.000Z',
          author_name: 'Admin',
          status: 'published',
          allow_comments: true,
          category_slugs: ['general'],
          tag_slugs: ['intro'],
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
      categories: [{ id: 'cat-1', name: 'General', slug: 'general', description: 'General posts' }],
      tags: [{ id: 'tag-1', name: 'Intro', slug: 'intro' }],
    },
  };
}

export async function buildDevSnapshot({ themeDir, previewData }) {
  assertPreviewData(previewData);

  const writer = new MemoryWriter();
  await buildSiteFromThemeDir({
    previewData,
    themeDir,
    writer,
    options: DEV_BUILD_OPTIONS,
  });

  const files = new Map(
    writer.getFiles().map((file) => [
      normalizeOutputPath(file.path),
      {
        content: file.content,
        contentType: file.contentType,
      },
    ]),
  );

  return {
    files,
    fallbackNotFoundHtml: BUILTIN_404_HTML,
  };
}

export async function rebuildDevSnapshot(currentSnapshot, buildSnapshot) {
  try {
    return {
      snapshot: await buildSnapshot(),
      changed: true,
      error: null,
    };
  } catch (error) {
    return {
      snapshot: currentSnapshot,
      changed: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function resolveSnapshotResponse(pathname, snapshot) {
  const outputPath = resolveOutputPath(pathname);
  const file = snapshot.files.get(outputPath);
  if (file) {
    return {
      status: 200,
      contentType: file.contentType,
      body: file.content,
    };
  }

  const notFound = snapshot.files.get('404.html');
  if (notFound) {
    return {
      status: 404,
      contentType: notFound.contentType,
      body: notFound.content,
    };
  }

  return {
    status: 404,
    contentType: 'text/html; charset=utf-8',
    body: snapshot.fallbackNotFoundHtml,
  };
}

export function resolveOutputPath(pathname) {
  const normalized = normalizeRequestPath(pathname);

  if (normalized === '/') {
    return 'index.html';
  }

  if (normalized.startsWith('/assets/') || SPECIAL_FILE_PATHS.has(normalized)) {
    return normalized.slice(1);
  }

  return `${normalized.slice(1)}/index.html`;
}

function handleRequest(req, res, snapshot) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const response = resolveSnapshotResponse(url.pathname, snapshot);
    const body = shouldInjectLiveReload(response.contentType)
      ? injectLiveReload(response.body)
      : response.body;
    send(res, response.status, response.contentType, body);
  } catch (error) {
    send(res, 500, 'text/plain; charset=utf-8', `Internal error: ${error.message}`);
  }
}

function shouldInjectLiveReload(contentType) {
  return typeof contentType === 'string' && contentType.startsWith('text/html');
}

function injectLiveReload(html) {
  const markup = typeof html === 'string' ? html : Buffer.from(html).toString('utf8');
  const script = `\n<script>\n(() => {\n  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__zeropress_ws');\n  ws.onmessage = (event) => { if (event.data === 'reload') location.reload(); };\n})();\n</script>\n`;
  if (markup.includes('</body>')) {
    return markup.replace('</body>', `${script}</body>`);
  }
  return `${markup}${script}`;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

function normalizeRequestPath(value) {
  const stringValue = safeDecodePath(String(value || '/'));
  const withoutTrailingSlash = stringValue.replace(/\/+$/, '');
  return withoutTrailingSlash || '/';
}

function normalizeOutputPath(filePath) {
  return String(filePath || '').replace(/^\/+/, '');
}

function safeDecodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function createWatchers(rootDir, extraFilePaths, onChange) {
  const watchers = [];
  const watchedDirs = new Set();

  async function watchDir(dir) {
    if (watchedDirs.has(dir)) {
      return;
    }

    watchedDirs.add(dir);
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

  for (const filePath of extraFilePaths) {
    const parentDir = path.dirname(filePath);
    if (watchedDirs.has(parentDir)) {
      continue;
    }

    const targetName = path.basename(filePath);
    const watcher = watchFs(parentDir, { persistent: true }, (_, changedName) => {
      if (!changedName || String(changedName) === targetName) {
        onChange().catch((error) => {
          console.log(`[dev] reload trigger error: ${error.message}`);
        });
      }
    });
    watchers.push(watcher);
  }

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
