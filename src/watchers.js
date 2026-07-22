import fs from 'node:fs/promises';
import { watch as watchFs } from 'node:fs';
import path from 'node:path';

const CHANGE_DELAY_MS = 25;

export async function createWatcherManager({
  roots,
  extraFilePaths = [],
  onChange,
  onChangeError = () => {},
  onFatalError = () => {},
  watchFactory = watchFs,
}) {
  const rootConfigs = normalizeRootConfigs(roots);
  const watchedExtraFiles = [...new Set(extraFilePaths.map((filePath) => path.resolve(filePath)))];
  const watchedExtraParents = [...new Set(watchedExtraFiles
    .map((filePath) => path.dirname(filePath))
    .filter((parentPath) => !rootConfigs.some((rootConfig) => pathContains(rootConfig.path, parentPath))))];
  const watchers = [];
  let stopped = false;
  let failed = false;
  let eventTimer = null;
  let pending = Promise.resolve();
  let closePromise;

  const close = () => {
    if (closePromise) {
      return closePromise;
    }

    stopped = true;
    clearTimeout(eventTimer);
    eventTimer = null;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Continue closing the remaining watchers.
      }
    }
    watchers.length = 0;
    closePromise = Promise.resolve();
    return closePromise;
  };

  const fail = (error) => {
    if (failed || stopped) {
      return;
    }
    failed = true;
    void close()
      .then(() => onFatalError(error))
      .catch(() => {});
  };

  const runChange = async () => {
    try {
      await assertWatchedDirectories(rootConfigs, watchedExtraParents);
    } catch (error) {
      fail(error);
      return;
    }

    if (stopped) {
      return;
    }

    try {
      await onChange();
    } catch (error) {
      try {
        onChangeError(error);
      } catch {
        // A diagnostic callback must not terminate file watching.
      }
    }
  };

  const scheduleChange = () => {
    if (stopped) {
      return;
    }
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => {
      eventTimer = null;
      pending = pending.then(runChange);
    }, CHANGE_DELAY_MS);
  };

  const addWatcher = (watchedPath, options, listener) => {
    const watcher = watchFactory(watchedPath, options, listener);
    watcher.on('error', fail);
    watchers.push(watcher);
  };

  try {
    for (const rootConfig of rootConfigs) {
      await assertRealDirectory(rootConfig.path, 'Watcher root');
      addWatcher(
        rootConfig.path,
        { persistent: true, recursive: true },
        (_event, changedName) => {
          if (changedName && shouldIgnoreChangedPath(changedName, rootConfig.shouldIgnoreEntry)) {
            return;
          }
          scheduleChange();
        },
      );
    }

    for (const filePath of watchedExtraFiles) {
      const parentPath = path.dirname(filePath);
      if (rootConfigs.some((rootConfig) => pathContains(rootConfig.path, parentPath))) {
        continue;
      }
      await assertRealDirectory(parentPath, 'Preview-data parent');
      const targetName = path.basename(filePath);
      addWatcher(parentPath, { persistent: true }, (_event, changedName) => {
        if (!changedName || String(changedName) === targetName) {
          scheduleChange();
        }
      });
    }
  } catch (error) {
    await close();
    throw error;
  }

  return { close };
}

function normalizeRootConfigs(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('Watcher manager requires at least one root directory');
  }
  return roots.map((root) => ({
    path: path.resolve(root.path),
    shouldIgnoreEntry: typeof root.shouldIgnoreEntry === 'function'
      ? root.shouldIgnoreEntry
      : () => false,
  }));
}

async function assertWatchedDirectories(rootConfigs, extraParentPaths) {
  await Promise.all([
    ...rootConfigs.map((rootConfig) => assertRealDirectory(rootConfig.path, 'Watcher root')),
    ...extraParentPaths.map((parentPath) => assertRealDirectory(parentPath, 'Preview-data parent')),
  ]);
}

async function assertRealDirectory(directoryPath, label) {
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    const error = new Error(`${label} must be a real directory: ${directoryPath}`);
    error.code = stat.isSymbolicLink() ? 'SYMLINK_NOT_ALLOWED' : 'ENOTDIR';
    throw error;
  }
}

function pathContains(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
  );
}

function shouldIgnoreChangedPath(changedName, shouldIgnoreEntry) {
  return String(changedName)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some((segment) => shouldIgnoreEntry(segment));
}
