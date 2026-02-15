export const REQUIRED_TEMPLATES = ['layout.html', 'index.html', 'post.html', 'page.html'];
export const OPTIONAL_TEMPLATES = ['archive.html', 'category.html', 'tag.html'];
export const REQUIRED_FILES = ['theme.json', 'assets/style.css'];

export const ALLOWED_SLOTS = new Set(['content', 'header', 'footer', 'meta']);

export const EXCLUDE_DEFAULTS = new Set([
  '.git',
  'node_modules',
  'dist',
  '__MACOSX',
  '.DS_Store',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

export const MAX_REMOTE_DATA_BYTES = 1024 * 1024;
export const REMOTE_TIMEOUT_MS = 5000;
