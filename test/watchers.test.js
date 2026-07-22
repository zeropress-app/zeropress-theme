import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWatcherManager } from '../src/watchers.js';

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for watcher event');
}

function createFakeWatchFactory(createdWatchers) {
  return (watchedPath, options, listener) => {
    const watcher = new EventEmitter();
    watcher.watchedPath = watchedPath;
    watcher.options = options;
    watcher.listener = listener;
    watcher.closed = false;
    watcher.close = () => {
      watcher.closed = true;
    };
    createdWatchers.push(watcher);
    return watcher;
  };
}

test('watcher manager uses one recursive watcher for nested changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-watch-'));
  const createdWatchers = [];
  let changes = 0;
  const manager = await createWatcherManager({
    roots: [{ path: root }],
    onChange: async () => {
      changes += 1;
    },
    watchFactory: createFakeWatchFactory(createdWatchers),
  });

  try {
    assert.equal(createdWatchers.length, 1);
    assert.equal(createdWatchers[0].options.recursive, true);
    createdWatchers[0].listener('change', 'created-later/watched.txt');
    await waitFor(() => changes === 1);
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('watcher manager closes already-created watchers when startup fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-watch-startup-'));
  const missingRoot = path.join(root, 'missing');
  const createdWatchers = [];

  try {
    await assert.rejects(
      createWatcherManager({
        roots: [{ path: root }, { path: missingRoot }],
        onChange: async () => {},
        watchFactory: createFakeWatchFactory(createdWatchers),
      }),
      { code: 'ENOENT' },
    );
    assert.equal(createdWatchers.length, 1);
    assert.equal(createdWatchers[0].closed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('watcher manager applies ignore rules per root', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-watch-roots-'));
  const themeRoot = path.join(parent, 'theme');
  const publicRoot = path.join(parent, 'public');
  const createdWatchers = [];
  let changes = 0;
  await fs.mkdir(themeRoot);
  await fs.mkdir(publicRoot);

  const manager = await createWatcherManager({
    roots: [
      { path: themeRoot },
      { path: publicRoot, shouldIgnoreEntry: (name) => name.startsWith('.') },
    ],
    onChange: async () => {
      changes += 1;
    },
    watchFactory: createFakeWatchFactory(createdWatchers),
  });

  try {
    assert.equal(createdWatchers.length, 2);
    assert.equal(createdWatchers.every((watcher) => watcher.options.recursive === true), true);

    const themeWatcher = createdWatchers.find((watcher) => watcher.watchedPath === themeRoot);
    const publicWatcher = createdWatchers.find((watcher) => watcher.watchedPath === publicRoot);
    themeWatcher.listener('change', 'assets/.icons/icon.svg');
    await waitFor(() => changes === 1);

    publicWatcher.listener('change', '.private/secret.txt');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(changes, 1);

    publicWatcher.listener('change', 'visible.txt');
    await waitFor(() => changes === 2);
  } finally {
    await manager.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('watcher errors close every watcher and report one fatal error', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-watch-fatal-'));
  const themeRoot = path.join(parent, 'theme');
  const publicRoot = path.join(parent, 'public');
  const createdWatchers = [];
  const fatalErrors = [];
  let changes = 0;
  await fs.mkdir(themeRoot);
  await fs.mkdir(publicRoot);

  const manager = await createWatcherManager({
    roots: [{ path: themeRoot }, { path: publicRoot }],
    onChange: async () => {
      changes += 1;
    },
    onFatalError: async (error) => {
      fatalErrors.push(error);
    },
    watchFactory: createFakeWatchFactory(createdWatchers),
  });

  try {
    const firstError = Object.assign(new Error('watch failed'), { code: 'EMFILE' });
    createdWatchers[0].emit('error', firstError);
    createdWatchers[1].emit('error', new Error('second failure'));
    await waitFor(() => fatalErrors.length === 1);

    assert.equal(fatalErrors[0], firstError);
    assert.equal(createdWatchers.every((watcher) => watcher.closed), true);

    createdWatchers[0].listener('change', 'after-failure.txt');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(changes, 0);
  } finally {
    await manager.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a watched root replaced by a symbolic link fails instead of recovering', {
  skip: process.platform === 'win32',
}, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-watch-root-swap-'));
  const themeRoot = path.join(parent, 'theme');
  const outsideRoot = path.join(parent, 'outside');
  const createdWatchers = [];
  const fatalErrors = [];
  await fs.mkdir(themeRoot);
  await fs.mkdir(outsideRoot);

  const manager = await createWatcherManager({
    roots: [{ path: themeRoot }],
    onChange: async () => {},
    onFatalError: async (error) => {
      fatalErrors.push(error);
    },
    watchFactory: createFakeWatchFactory(createdWatchers),
  });

  try {
    await fs.rm(themeRoot, { recursive: true, force: true });
    await fs.symlink(outsideRoot, themeRoot, 'dir');
    createdWatchers[0].listener('rename', 'theme');
    await waitFor(() => fatalErrors.length === 1);

    assert.equal(fatalErrors[0].code, 'SYMLINK_NOT_ALLOWED');
    assert.equal(createdWatchers[0].closed, true);
  } finally {
    await manager.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a missing preview-data parent directory is a fatal watcher failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-watch-extra-root-'));
  const dataContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-watch-extra-data-'));
  const dataParent = path.join(dataContainer, 'data');
  const dataFile = path.join(dataParent, 'preview-data.json');
  const createdWatchers = [];
  const fatalErrors = [];
  let changes = 0;
  await fs.mkdir(dataParent);
  await fs.writeFile(dataFile, '{}');

  const manager = await createWatcherManager({
    roots: [{ path: root }],
    extraFilePaths: [dataFile],
    onChange: async () => {
      changes += 1;
    },
    onFatalError: async (error) => {
      fatalErrors.push(error);
    },
    watchFactory: createFakeWatchFactory(createdWatchers),
  });

  try {
    const dataWatcher = createdWatchers.find((watcher) => watcher.watchedPath === dataParent);
    dataWatcher.listener('change', 'unrelated.json');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(changes, 0);

    dataWatcher.listener('change', path.basename(dataFile));
    await waitFor(() => changes === 1);

    await fs.rm(dataParent, { recursive: true, force: true });
    dataWatcher.listener('rename', path.basename(dataFile));
    await waitFor(() => fatalErrors.length === 1);
    assert.equal(fatalErrors[0].code, 'ENOENT');
    assert.equal(createdWatchers.every((watcher) => watcher.closed), true);
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataContainer, { recursive: true, force: true });
  }
});

test('rebuild errors are reported without stopping watchers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-watch-rebuild-'));
  const createdWatchers = [];
  const changeErrors = [];
  const fatalErrors = [];

  const manager = await createWatcherManager({
    roots: [{ path: root }],
    onChange: async () => {
      throw new Error('invalid theme while editing');
    },
    onChangeError: (error) => {
      changeErrors.push(error);
    },
    onFatalError: async (error) => {
      fatalErrors.push(error);
    },
    watchFactory: createFakeWatchFactory(createdWatchers),
  });

  try {
    createdWatchers[0].listener('change', 'layout.html');
    await waitFor(() => changeErrors.length === 1);
    createdWatchers[0].listener('change', 'layout.html');
    await waitFor(() => changeErrors.length === 2);

    assert.equal(fatalErrors.length, 0);
    assert.equal(createdWatchers[0].closed, false);
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
