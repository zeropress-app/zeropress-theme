import fs from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { buildSiteFromThemeDir, MemoryWriter } from '@zeropress/build-core';
import { createColor } from './color.js';
import { getThemeDir, resolveCanonicalDirectoryRoot } from './helpers.js';
import { toTerminalSafeText } from './terminal.js';
import { createWatcherManager } from './watchers.js';

const DEV_BUILD_OPTIONS = {
  assetHashing: false,
};

export const DEFAULT_DEV_PORT = 4000;
export const DEV_WEBSOCKET_MAX_PAYLOAD_BYTES = 1024;
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
const INTERNAL_SERVER_ERROR_BODY = 'Internal Server Error';

const CONTENT_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.eot', 'application/vnd.ms-fontobject'],
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
  ['.ttf', 'font/ttf'],
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
  if (positional.length !== 1) {
    throw new Error('dev accepts exactly one themeDir argument');
  }
  const requestedThemeDir = getThemeDir(positional[0]);
  const themeDir = await resolveCanonicalDirectoryRoot(requestedThemeDir, { label: 'Theme directory' });
  const effectivePublicDir = resolvePublicDir(process.cwd(), flags.publicDir);
  const host = flags.host || '127.0.0.1';
  const port = Number(flags.port || DEFAULT_DEV_PORT);
  const strictPort = flags.strictPort === true;
  const noJs = flags.noJs === true;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${flags.port}`);
  }

  const publicDir = await resolveExistingPublicDir(effectivePublicDir);
  await assertPublicPathDoesNotOverlap(
    'Theme directory',
    themeDir,
    process.cwd(),
    publicDir || effectivePublicDir,
  );
  const buildSnapshot = async () => buildDevSnapshot({
    themeDir,
    previewData: await loadPreviewData(flags.data),
    publicDir,
  });

  let snapshot = await buildSnapshot();
  const server = http.createServer((req, res) => {
    handleRequest(req, res, snapshot, publicDir, { noJs }).catch((error) => {
      handleRequestFailure(res, error);
    });
  });
  let wss;
  let watchers;
  let actualPort;
  const sockets = new Set();
  let cleanupPromise;
  let sigintHandler;
  let sigtermHandler;
  let rebuilding = false;
  let queued = false;
  let watcherFailureHandled = false;

  const cleanup = () => {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      if (sigintHandler) {
        process.off('SIGINT', sigintHandler);
      }
      if (sigtermHandler) {
        process.off('SIGTERM', sigtermHandler);
      }
      await watchers?.close();
      for (const client of wss?.clients || []) {
        client.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeWebSocketServer(wss);
      await closeHttpServer(server);
    })();
    return cleanupPromise;
  };

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
    try {
      do {
        queued = false;
        const result = await rebuildDevSnapshot(snapshot, buildSnapshot);
        if (result.changed) {
          snapshot = result.snapshot;
          for (const client of wss?.clients || []) {
            if (client.readyState === 1) {
              client.send('reload');
            }
          }
        } else {
          console.log(`[dev] rebuild failed: ${toTerminalSafeText(result.error.message)}`);
        }
      } while (queued);
    } finally {
      rebuilding = false;
    }
  };

  const extraWatchPaths = [];
  const dataFilePath = resolveLocalDataPath(flags.data);
  if (dataFilePath) {
    extraWatchPaths.push(dataFilePath);
  }

  const extraWatchDirs = publicDir ? [publicDir] : [];
  const handleWatcherFailure = async (error) => {
    if (watcherFailureHandled) {
      return;
    }
    watcherFailureHandled = true;
    process.exitCode = 1;
    console.error(`[dev] file watcher failed: ${toTerminalSafeText(error?.message || error)}`);
    console.error('[dev] Resolve the filesystem problem and restart zeropress-theme dev.');
    await cleanup();
  };

  try {
    watchers = await createWatchers(
      themeDir,
      extraWatchPaths,
      extraWatchDirs,
      triggerRebuild,
      handleWatcherFailure,
    );
    actualPort = await listenServerWithFallback(server, host, port, { strictPort });
    wss = createLiveReloadWebSocketServer(server);
  } catch (error) {
    await cleanup();
    throw error;
  }

  const url = formatDevServerUrl(host, actualPort);
  console.log(formatDevRunningMessage(url));
  if (noJs) {
    console.log('[dev] No-JS preview mode enabled');
  }

  const shutdown = async (signal) => {
    console.log(`[dev] received ${signal}, shutting down...`);
    const forceExit = setTimeout(() => {
      process.exit(0);
    }, 1500);
    forceExit.unref();
    try {
      await cleanup();
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };

  sigintHandler = () => { shutdown('SIGINT'); };
  sigtermHandler = () => { shutdown('SIGTERM'); };
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);
}

export function createLiveReloadWebSocketServer(server, {
  WebSocketServerClass = WebSocketServer,
  log = console.log,
} = {}) {
  const wss = new WebSocketServerClass({
    server,
    path: '/__zeropress_ws',
    maxPayload: DEV_WEBSOCKET_MAX_PAYLOAD_BYTES,
  });

  wss.on('error', (error) => {
    log(`[dev] websocket server error: ${toTerminalSafeText(error?.message || error)}`);
  });
  wss.on('connection', (client) => {
    client.on('error', () => {
      client.terminate();
    });
    client.on('message', () => {
      if (client.readyState === 1) {
        client.close(1008, 'Client messages are not supported');
      }
    });
  });

  return wss;
}

async function closeWebSocketServer(wss) {
  if (!wss) {
    return;
  }
  await new Promise((resolve) => {
    try {
      wss.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function closeHttpServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export function formatDevRunningMessage(url, stream = process.stdout) {
  return createColor(stream).green(`[dev] running at ${toTerminalSafeText(url)}`);
}

export function formatDevServerUrl(host, port) {
  const normalizedHost = String(host);
  const urlHost = normalizedHost.includes(':')
    ? `[${normalizedHost.replaceAll('%', '%25')}]`
    : normalizedHost;
  return `http://${urlHost}:${port}`;
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
      if (!value || value.startsWith('--')) {
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

    const stat = await lstatPublicFileWithoutSymlinks(publicDir, outputPath);

    if (!stat?.isFile()) {
      continue;
    }

    const canonicalPublicDir = await fs.realpath(publicDir);
    const canonicalFilePath = await fs.realpath(fullPath);
    if (!isPathInside(canonicalPublicDir, canonicalFilePath)) {
      continue;
    }

    let fileHandle;
    try {
      fileHandle = await fs.open(
        canonicalFilePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
      );
      const openedStat = await fileHandle.stat();
      if (!openedStat.isFile()) {
        await fileHandle.close();
        continue;
      }

      return {
        status: 200,
        contentType: getContentType(canonicalFilePath),
        contentLength: openedStat.size,
        fileHandle,
      };
    } catch (error) {
      await fileHandle?.close().catch(() => {});
      if (error && ['ELOOP', 'ENOENT', 'ENOTDIR'].includes(error.code)) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

async function lstatPublicFileWithoutSymlinks(publicDir, outputPath) {
  const rootPath = path.resolve(publicDir);
  const pathSegments = outputPath.split('/').filter(Boolean);
  let currentPath = rootPath;

  for (let index = -1; index < pathSegments.length; index += 1) {
    if (index >= 0) {
      currentPath = path.join(currentPath, pathSegments[index]);
    }

    let stat;
    try {
      stat = await fs.lstat(currentPath);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return null;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      return null;
    }

    const isFinalPath = index === pathSegments.length - 1;
    if (!isFinalPath && !stat.isDirectory()) {
      return null;
    }

    if (isFinalPath) {
      return stat;
    }
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

function resolveOutputPathCandidates(pathname, outputStyle = DEFAULT_PERMALINK_OUTPUT_STYLE) {
  const normalized = normalizeRequestPath(pathname);

  if (isUnsafeRequestPath(normalized)) {
    return [];
  }

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

  if (normalized.endsWith('/')) {
    return [`${normalized.slice(1)}index.html`];
  }

  const routeOutputPath = outputStyle === 'html-extension'
    ? `${normalized.slice(1)}.html`
    : `${normalized.slice(1)}/index.html`;
  if (normalized.endsWith('.html')) {
    return [routeOutputPath, normalized.slice(1)];
  }

  return [routeOutputPath];
}

export async function handleRequest(req, res, snapshot, publicDir = null, { noJs = false } = {}) {
  let response;
  try {
    const url = new URL(req.url, 'http://localhost');
    response = await resolveDevResponse(url.pathname, snapshot, publicDir);
    if (response.fileHandle) {
      await sendPublicFile(res, response, { noJs });
      return;
    }
    const body = shouldInjectLiveReload(response.contentType, { noJs })
      ? injectLiveReload(response.body)
      : response.body;
    send(res, response.status, response.contentType, body, noJsHeaders(response.contentType, { noJs }));
  } catch (error) {
    await response?.fileHandle?.close().catch(() => {});
    handleRequestFailure(res, error);
  }
}

function handleRequestFailure(res, error) {
  const details = error instanceof Error
    ? error.stack || error.message
    : String(error);
  console.error(`[dev] request failed: ${toTerminalSafeText(details)}`);

  if (!res.headersSent && !res.destroyed) {
    send(res, 500, 'text/plain; charset=utf-8', INTERNAL_SERVER_ERROR_BODY);
  }
}

async function sendPublicFile(res, response, { noJs = false } = {}) {
  const inject = shouldInjectLiveReload(response.contentType, { noJs });
  const headers = {
    'content-type': response.contentType,
    ...noJsHeaders(response.contentType, { noJs }),
    ...(!inject ? { 'content-length': String(response.contentLength) } : {}),
  };
  res.writeHead(response.status, headers);

  const input = createReadStream(null, {
    fd: response.fileHandle.fd,
    autoClose: false,
  });
  try {
    if (inject) {
      await pipeline(input, createLiveReloadTransform(), res);
    } else {
      await pipeline(input, res);
    }
  } finally {
    input.destroy();
    await response.fileHandle.close().catch(() => {});
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
  return `${markup}${liveReloadScript()}`;
}

function createLiveReloadTransform() {
  const script = Buffer.from(liveReloadScript());

  return new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
    flush(callback) {
      callback(null, script);
    },
  });
}

function liveReloadScript() {
  return `\n<script>\n(() => {\n  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__zeropress_ws');\n  ws.onmessage = (event) => { if (event.data === 'reload') location.reload(); };\n})();\n</script>\n`;
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

function resolvePublicOutputPathCandidates(pathname) {
  const normalized = normalizeRequestPath(pathname);
  if (normalized === '/' || isUnsafeRequestPath(normalized)) {
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
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
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

  if (stat.isSymbolicLink()) {
    throw new Error(`Public path must be a real directory and must not be a symbolic link: ${publicDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Public path is not a directory: ${publicDir}`);
  }

  return resolveCanonicalDirectoryRoot(publicDir, { label: 'Public path' });
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

export async function assertPublicPathDoesNotOverlap(label, candidatePath, cwd = process.cwd(), publicDir = resolvePublicDir(cwd)) {
  const resolvedCandidate = path.resolve(cwd, candidatePath);
  const [canonicalPublicDir, canonicalCandidate] = await Promise.all([
    resolvePathIdentity(publicDir),
    resolvePathIdentity(resolvedCandidate),
  ]);

  if (!pathsOverlap(canonicalPublicDir, canonicalCandidate)) {
    return;
  }

  throw new Error(`${label} must not overlap the public directory: ${resolvedCandidate}`);
}

async function resolvePathIdentity(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  const missingSegments = [];
  let existingPath = resolvedPath;

  while (true) {
    try {
      const realPath = await fs.realpath(existingPath);
      return path.join(realPath, ...missingSegments.reverse());
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }

      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        throw error;
      }

      missingSegments.push(path.basename(existingPath));
      existingPath = parentPath;
    }
  }
}

function pathsOverlap(firstPath, secondPath) {
  const first = path.resolve(firstPath);
  const second = path.resolve(secondPath);
  return first === second || isPathInside(first, second) || isPathInside(second, first);
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return Boolean(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function safeDecodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isUnsafeRequestPath(value) {
  return value.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

async function createWatchers(rootDir, extraFilePaths, extraDirPaths, onChange, onFatalError) {
  return createWatcherManager({
    roots: [
      { path: rootDir },
      ...extraDirPaths.map((dirPath) => ({
        path: dirPath,
        shouldIgnoreEntry: shouldIgnorePublicEntry,
      })),
    ],
    extraFilePaths,
    onChange,
    onChangeError: (error) => {
      console.log(`[dev] reload trigger error: ${toTerminalSafeText(error.message)}`);
    },
    onFatalError,
  });
}
