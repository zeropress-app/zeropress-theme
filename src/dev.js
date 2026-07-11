import fs from 'node:fs/promises';
import { watch as watchFs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { buildSiteFromThemeDir, MemoryWriter } from '@zeropress/build-core';
import { createColor } from './color.js';
import { getThemeDir } from './helpers.js';

const DEV_BUILD_OPTIONS = {
  assetHashing: false,
};

export const DEFAULT_DEV_PORT = 4000;
const PREVIEW_DATA_VERSION = '0.7';
const DEFAULT_PUBLIC_DIR_NAME = 'public';
const PUBLIC_DIR_ENV_NAME = 'ZEROPRESS_PUBLIC_DIR';
const PUBLIC_FAVICON_FILES = Object.freeze({
  icon: 'favicon.ico',
  icon_dark: 'favicon.dark.ico',
  svg: 'favicon.svg',
  png: 'favicon.png',
  apple_touch_icon: 'apple-touch-icon.png',
});
const PUBLIC_SITEMAP_STYLESHEET_FILE = 'sitemap.xsl';
const DEFAULT_PERMALINK_OUTPUT_STYLE = 'directory';
const PERMALINK_OUTPUT_STYLES = new Set(['directory', 'html-extension']);

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.xsl', 'application/xslt+xml; charset=utf-8'],
]);

const SPECIAL_FILE_PATHS = new Set([
  '/404.html',
  '/feed.xml',
  '/robots.txt',
  '/sitemap.xml',
]);
const SEARCH_ARTIFACT_PATHS = new Set([
  '/_zeropress/search.json',
  '/_zeropress/search.js',
  '/_zeropress/search_pagefind.js',
]);

const BUILTIN_404_HTML = '<!doctype html><html><body><h1>404</h1><p>Not Found</p></body></html>';

export async function runDev(argv) {
  const { positional, flags } = parseDevArgs(argv);
  if (!positional[0]) {
    throw new Error('dev requires a themeDir argument');
  }
  const themeDir = getThemeDir(positional[0]);
  const effectivePublicDir = resolvePublicDir(process.cwd(), flags.publicDir);
  assertPublicPathDoesNotOverlap('Theme directory', themeDir, process.cwd(), effectivePublicDir);
  const host = flags.host || '127.0.0.1';
  const port = Number(flags.port || DEFAULT_DEV_PORT);
  const strictPort = flags.strictPort === true;
  const noJs = flags.noJs === true;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${flags.port}`);
  }

  const publicDir = await resolveExistingPublicDir(effectivePublicDir);
  const buildSnapshot = async () => buildDevSnapshot({
    themeDir,
    previewData: await loadPreviewData(flags.data),
    publicDir,
  });

  let snapshot = await buildSnapshot();
  const server = http.createServer((req, res) => {
    handleRequest(req, res, snapshot, publicDir, { noJs }).catch((error) => {
      send(res, 500, 'text/plain; charset=utf-8', `Internal error: ${error.message}`);
    });
  });
  const actualPort = await listenServerWithFallback(server, host, port, { strictPort });

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

  const extraWatchDirs = publicDir ? [publicDir] : [];
  const watchers = await createWatchers(themeDir, extraWatchPaths, extraWatchDirs, triggerRebuild);

  const url = `http://${host}:${actualPort}`;
  console.log(formatDevRunningMessage(url));
  if (noJs) {
    console.log('[dev] No-JS preview mode enabled');
  }
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

export function formatDevRunningMessage(url, stream = process.stdout) {
  return createColor(stream).green(`[dev] running at ${url}`);
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
      flags.open = true;
      continue;
    }

    if (key === 'strict-port') {
      flags.strictPort = true;
      continue;
    }

    if (key === 'no-js') {
      flags.noJs = true;
      continue;
    }

    if (key === 'port' || key === 'host' || key === 'data' || key === 'public-dir') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`--${key} requires a value`);
      }
      flags[key === 'public-dir' ? 'publicDir' : key] = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown option for dev: ${token}`);
  }

  return { positional, flags };
}

export async function listenServerWithFallback(server, host, port, { strictPort = false } = {}) {
  let candidatePort = port;

  while (candidatePort <= 65535) {
    try {
      await listenServer(server, host, candidatePort);
      return getListeningPort(server, candidatePort);
    } catch (error) {
      if (!isAddressInUseError(error) || strictPort || candidatePort === 65535) {
        throw normalizeListenError(error, host, candidatePort, { strictPort });
      }

      console.log(`[dev] port ${candidatePort} is already in use, trying ${candidatePort + 1}`);
      candidatePort += 1;
    }
  }

  throw new Error(`Dev server could not start: no available ports from ${port} to 65535.`);
}

function listenServer(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
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

function isAddressInUseError(error) {
  return error && typeof error === 'object' && error.code === 'EADDRINUSE';
}

function getListeningPort(server, fallbackPort) {
  const address = server.address();
  if (address && typeof address === 'object') {
    return address.port;
  }

  return fallbackPort;
}

export function normalizeListenError(error, host, port, { strictPort = false } = {}) {
  if (isAddressInUseError(error)) {
    const strictHint = strictPort ? ' Port fallback is disabled by --strict-port.' : '';
    return new Error(`Dev server could not start: ${host}:${port} is already in use.${strictHint}`);
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
    generated_at: '2026-03-26T00:00:00Z',
    site: {
      title: 'ZeroPress Preview',
      description: 'Default preview data',
      url: 'https://example.com',
      media_origin: 'https://media.example.com',
      locale: 'en-US',
      posts_per_page: 2,
      date_style: 'medium',
      time_style: 'none',
      timezone: 'UTC',
    },
    content: {
      authors: [
        {
          id: 'author-1',
          display_name: 'Admin',
          avatar: '/images/author-avatar.png?size=96',
        },
      ],
      posts: [
        {
          public_id: 101,
          title: 'Hello ZeroPress',
          slug: 'hello-zeropress',
          content: '<p>Preview post content</p>',
          document_type: 'html',
          excerpt: 'Preview excerpt',
          published_at_iso: '2026-02-14T09:00:00Z',
          updated_at_iso: '2026-02-14T09:00:00Z',
          author_id: 'author-1',
          featured_image: '/images/post-share.png?fit=cover',
          status: 'published',
          allow_comments: true,
          category_slugs: ['general'],
          tag_slugs: ['intro'],
        },
        {
          public_id: 102,
          title: 'Theme Blocks Deep Dive',
          slug: 'theme-blocks-deep-dive',
          content: '<p>Second preview post content</p>',
          document_type: 'html',
          excerpt: 'Second preview excerpt',
          published_at_iso: '2026-02-13T09:00:00Z',
          updated_at_iso: '2026-02-13T09:00:00Z',
          author_id: 'author-1',
          status: 'published',
          allow_comments: true,
          category_slugs: ['general'],
          tag_slugs: ['intro'],
        },
        {
          public_id: 103,
          title: 'Archive Patterns',
          slug: 'archive-patterns',
          content: '<p>Third preview post content</p>',
          document_type: 'html',
          excerpt: 'Third preview excerpt',
          published_at_iso: '2026-02-12T09:00:00Z',
          updated_at_iso: '2026-02-12T09:00:00Z',
          author_id: 'author-1',
          status: 'published',
          allow_comments: true,
          category_slugs: ['general'],
          tag_slugs: ['intro'],
        },
      ],
      pages: [
        {
          title: 'About',
          slug: 'about',
          content: '<p>About page</p>',
          document_type: 'html',
          excerpt: 'About ZeroPress preview page',
          featured_image: '/images/about-share.png?format=webp',
          status: 'published',
        },
      ],
      categories: [{ name: 'General', slug: 'general', description: 'General posts' }],
      tags: [{ name: 'Intro', slug: 'intro' }],
    },
    menus: {
      primary: {
        name: 'Primary Menu',
        items: [
          {
            title: 'Home',
            url: '/',
            target: '_self',
            children: [],
          },
          {
            title: 'Archive',
            url: '/archive/',
            target: '_self',
            children: [],
          },
        ],
      },
      footer: {
        name: 'Footer Menu',
        items: [
          {
            title: 'Archive',
            url: '/archive/',
            target: '_self',
            children: [],
          },
          {
            title: 'RSS',
            url: '/feed.xml',
            target: '_self',
            children: [],
          },
          {
            title: 'Sitemap',
            url: '/sitemap.xml',
            target: '_self',
            children: [],
          },
        ],
      },
    },
    widgets: {},
  };
}

export async function buildDevSnapshot({ themeDir, previewData, publicDir = null }) {
  const writer = new MemoryWriter();
  const hasPublicRobotsTxt = await publicRobotsTxtExists(publicDir);
  const publicFavicon = await discoverPublicFavicon(publicDir);
  const sitemapStylesheetHref = await discoverPublicSitemapStylesheet(publicDir);
  await buildSiteFromThemeDir({
    previewData,
    themeDir,
    writer,
    options: {
      ...DEV_BUILD_OPTIONS,
      favicon: publicFavicon,
      sitemapStylesheetHref,
      generateRobotsTxt: !hasPublicRobotsTxt,
    },
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
    outputStyle: getPreviewOutputStyle(previewData),
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
  const file = resolveSnapshotFileResponse(pathname, snapshot);
  if (file) {
    return file;
  }

  return resolveNotFoundResponse(snapshot);
}

export async function resolveDevResponse(pathname, snapshot, publicDir = null) {
  const file = resolveSnapshotFileResponse(pathname, snapshot);
  if (file) {
    return file;
  }

  const publicFile = await resolvePublicFileResponse(pathname, publicDir);
  if (publicFile) {
    return publicFile;
  }

  return resolveNotFoundResponse(snapshot);
}

function resolveSnapshotFileResponse(pathname, snapshot) {
  const outputPaths = resolveOutputPathCandidates(pathname, snapshot.outputStyle);
  for (const outputPath of outputPaths) {
    const file = snapshot.files.get(outputPath);
    if (file) {
      return {
        status: 200,
        contentType: file.contentType,
        body: file.content,
      };
    }
  }

  return null;
}

function resolveNotFoundResponse(snapshot) {
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

export async function resolvePublicFileResponse(pathname, publicDir = null) {
  if (!publicDir) {
    return null;
  }

  const outputPaths = resolvePublicOutputPathCandidates(pathname);

  for (const outputPath of outputPaths) {
    if (outputPath.split('/').some((segment) => shouldIgnorePublicEntry(segment))) {
      continue;
    }

    const fullPath = resolvePublicFilePath(publicDir, outputPath);
    if (!fullPath) {
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(fullPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    if (!stat.isFile()) {
      continue;
    }

    return {
      status: 200,
      contentType: getContentType(fullPath),
      body: await fs.readFile(fullPath),
    };
  }

  return null;
}

async function publicRobotsTxtExists(publicDir) {
  if (!publicDir) {
    return false;
  }

  let stat;
  try {
    stat = await fs.lstat(path.join(publicDir, 'robots.txt'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  return stat.isFile();
}

export async function discoverPublicFavicon(publicDir) {
  if (!publicDir) {
    return undefined;
  }

  const favicon = {};
  for (const [key, filename] of Object.entries(PUBLIC_FAVICON_FILES)) {
    let stat;
    try {
      stat = await fs.lstat(path.join(publicDir, filename));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    if (stat.isFile()) {
      favicon[key] = `/${filename}`;
    }
  }

  return Object.keys(favicon).length ? favicon : undefined;
}

export async function discoverPublicSitemapStylesheet(publicDir) {
  if (!publicDir) {
    return undefined;
  }

  let stat;
  try {
    stat = await fs.lstat(path.join(publicDir, PUBLIC_SITEMAP_STYLESHEET_FILE));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  return stat.isFile() ? `/${PUBLIC_SITEMAP_STYLESHEET_FILE}` : undefined;
}

export function resolveOutputPath(pathname, outputStyle = DEFAULT_PERMALINK_OUTPUT_STYLE) {
  return resolveOutputPathCandidates(pathname, outputStyle)[0] || '';
}

function resolveOutputPathCandidates(pathname, outputStyle = DEFAULT_PERMALINK_OUTPUT_STYLE) {
  const normalized = normalizeRequestPath(pathname);

  if (normalized === '/') {
    return ['index.html'];
  }

  if (
    normalized.startsWith('/assets/')
    || SPECIAL_FILE_PATHS.has(normalized)
    || SEARCH_ARTIFACT_PATHS.has(normalized)
  ) {
    return [normalized.slice(1)];
  }

  if (normalized.endsWith('.html')) {
    return [normalized.slice(1)];
  }

  if (normalized.endsWith('/')) {
    return [`${normalized.slice(1)}index.html`];
  }

  if (outputStyle === 'html-extension') {
    return [`${normalized.slice(1)}.html`];
  }

  return [`${normalized.slice(1)}/index.html`];
}

export async function handleRequest(req, res, snapshot, publicDir = null, { noJs = false } = {}) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const response = await resolveDevResponse(url.pathname, snapshot, publicDir);
    const body = shouldInjectLiveReload(response.contentType, { noJs })
      ? injectLiveReload(response.body)
      : response.body;
    send(res, response.status, response.contentType, body, noJsHeaders(response.contentType, { noJs }));
  } catch (error) {
    send(res, 500, 'text/plain; charset=utf-8', `Internal error: ${error.message}`);
  }
}

function shouldInjectLiveReload(contentType, { noJs = false } = {}) {
  return !noJs && isHtmlContentType(contentType);
}

function noJsHeaders(contentType, { noJs = false } = {}) {
  if (!noJs || !isHtmlContentType(contentType)) {
    return {};
  }

  return {
    'content-security-policy': "script-src 'none'",
  };
}

function isHtmlContentType(contentType) {
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

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(body);
}

function normalizeRequestPath(value) {
  const stringValue = safeDecodePath(String(value || '/'));
  const withLeadingSlash = stringValue.startsWith('/') ? stringValue : `/${stringValue}`;
  return withLeadingSlash || '/';
}

function getPreviewOutputStyle(previewData) {
  const outputStyle = previewData?.site?.permalinks?.output_style;
  return PERMALINK_OUTPUT_STYLES.has(outputStyle) ? outputStyle : DEFAULT_PERMALINK_OUTPUT_STYLE;
}

function normalizeOutputPath(filePath) {
  return String(filePath || '').replace(/^\/+/, '');
}

function resolvePublicOutputPath(pathname) {
  return resolvePublicOutputPathCandidates(pathname)[0] || null;
}

function resolvePublicOutputPathCandidates(pathname) {
  const normalized = normalizeRequestPath(pathname);
  if (normalized === '/') {
    return [];
  }

  if (normalized.endsWith('/')) {
    return [normalizeOutputPath(`${normalized}index.html`)];
  }

  return [normalizeOutputPath(normalized)];
}

function resolvePublicFilePath(publicDir, outputPath) {
  const fullPath = path.resolve(publicDir, outputPath);
  const relativePath = path.relative(publicDir, fullPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return fullPath;
}

function getContentType(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

export function resolvePublicDir(cwd = process.cwd(), publicDir) {
  if (publicDir) {
    return path.resolve(cwd, publicDir);
  }
  const envValue = process.env[PUBLIC_DIR_ENV_NAME]?.trim();
  return path.resolve(cwd, envValue || DEFAULT_PUBLIC_DIR_NAME);
}

export async function resolveExistingPublicDir(publicDir = resolvePublicDir()) {
  let stat;
  try {
    stat = await fs.lstat(publicDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    throw new Error(`Public path is not a directory: ${publicDir}`);
  }

  return publicDir;
}

export function shouldIgnorePublicEntry(name) {
  const basename = String(name || '');
  const lowerName = basename.toLowerCase();
  return (
    basename.startsWith('.')
    || lowerName === 'node_modules'
    || lowerName === 'thumbs.db'
    || lowerName.endsWith('.key')
    || lowerName.endsWith('.pem')
  );
}

export function assertPublicPathDoesNotOverlap(label, candidatePath, cwd = process.cwd(), publicDir = resolvePublicDir(cwd)) {
  const resolvedCandidate = path.resolve(cwd, candidatePath);
  if (!pathsOverlap(publicDir, resolvedCandidate)) {
    return;
  }

  throw new Error(`${label} must not overlap the public directory: ${resolvedCandidate}`);
}

function pathsOverlap(firstPath, secondPath) {
  const first = path.resolve(firstPath);
  const second = path.resolve(secondPath);
  return first === second || isPathInside(first, second) || isPathInside(second, first);
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function safeDecodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function createWatchers(rootDir, extraFilePaths, extraDirPaths, onChange) {
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
      if (!entry.isSymbolicLink() && !shouldIgnorePublicEntry(entry.name) && entry.isDirectory()) {
        await watchDir(path.join(dir, entry.name));
      }
    }
  }

  await watchDir(rootDir);

  for (const dirPath of extraDirPaths) {
    await watchDir(dirPath);
  }

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
