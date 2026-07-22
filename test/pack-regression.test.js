import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { THEME_PACKAGE_LIMITS } from '@zeropress/theme-validator';
import { runPack } from '../src/pack.js';

const canonicalTmpDir = await fs.realpath(os.tmpdir());
const cliPath = fileURLToPath(new URL('../bin/zeropress-theme.js', import.meta.url));

function validThemeFiles() {
  return {
    'theme.json': JSON.stringify({
      name: 'Pack Regression Theme',
      namespace: 'test-studio',
      slug: 'pack-regression',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.7',
      description: 'Pack regression fixture',
    }),
    'layout.html': '<main>{{slot:content}}</main>',
    'index.html': '<h1>{{site.title}}</h1>',
    'post.html': '<article>{{post.title}}{{post.html}}</article>',
    'page.html': '<section>{{page.title}}</section>',
    'assets/style.css': 'body { color: black; }',
  };
}

async function createThemeDir(extraFiles = {}) {
  const root = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-regression-'));
  const files = { ...validThemeFiles(), ...extraFiles };

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return root;
}

test('runPack rejects missing option values without consuming dry-run or writing output', async () => {
  const themeDir = await createThemeDir();
  const workingDir = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-args-'));
  const explicitOutDir = path.join(workingDir, 'artifacts');
  const originalCwd = process.cwd();

  process.chdir(workingDir);
  try {
    for (const option of ['--out', '--name']) {
      for (const nextToken of [undefined, '--dry-run', '--unknown']) {
        const argv = option === '--name'
          ? [themeDir, '--out', explicitOutDir, option]
          : [themeDir, option];
        if (nextToken) {
          argv.push(nextToken);
        }

        await assert.rejects(
          () => runPack(argv),
          new RegExp(`${option} requires a value`),
        );
      }
    }

    assert.deepEqual(await fs.readdir(workingDir), []);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(workingDir, { recursive: true, force: true });
  }
});

test('runPack requires custom archive names to use a zip extension', async () => {
  const themeDir = await createThemeDir();
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-name-extension-'));
  const originalLog = console.log;
  console.log = () => {};

  try {
    await assert.rejects(
      () => runPack([themeDir, '--out', outputRoot, '--name', 'theme.bundle', '--dry-run']),
      /--name must end with \.zip/,
    );
    await assert.doesNotReject(
      () => runPack([themeDir, '--out', outputRoot, '--name', 'theme.ZIP', '--dry-run']),
    );
    assert.deepEqual(await fs.readdir(outputRoot), []);
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack rejects generated archives above the compressed size limit', async () => {
  const themeDir = await createThemeDir({
    'assets/random-a.bin': randomBytes(900 * 1024),
    'assets/random-b.bin': randomBytes(900 * 1024),
    'assets/random-c.bin': randomBytes(900 * 1024),
  });
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-size-'));
  const outDir = path.join(outputRoot, 'artifacts');

  try {
    for (const extraArgs of [[], ['--dry-run']]) {
      await assert.rejects(
        runPack([themeDir, '--out', outDir, ...extraArgs]),
        /Pack aborted: generated zip is \d+ bytes; the maximum is 2097152 bytes/,
      );
    }
    await assert.rejects(fs.access(outDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack excludes package-manager lockfiles from the generated archive', async () => {
  const lockfiles = [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ];
  const themeDir = await createThemeDir(Object.fromEntries(
    lockfiles.map((fileName) => [fileName, `lockfile fixture: ${fileName}`]),
  ));
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-lockfiles-'));
  const zipPath = path.join(outputRoot, 'test-studio.pack-regression@1.0.0.zip');
  const originalLog = console.log;
  console.log = () => {};

  try {
    await runPack([themeDir, '--out', outputRoot]);
    const zip = await JSZip.loadAsync(await fs.readFile(zipPath));

    for (const fileName of lockfiles) {
      assert.equal(zip.file(fileName), null, `${fileName} must not be packed`);
    }
    assert.notEqual(zip.file('theme.json'), null);
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack excludes the current target zip when output is the theme root', async () => {
  const cases = [
    {
      extraArgs: [],
      fileName: 'test-studio.pack-regression@1.0.0.zip',
    },
    {
      extraArgs: ['--name', 'custom-theme.zip'],
      fileName: 'custom-theme.zip',
    },
  ];
  const originalLog = console.log;
  console.log = () => {};

  try {
    for (const { extraArgs, fileName } of cases) {
      const dryRunThemeDir = await createThemeDir();
      const dryRunZipPath = path.join(dryRunThemeDir, fileName);
      const previousArchive = Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1, 0x41);
      await fs.writeFile(dryRunZipPath, previousArchive);
      try {
        await runPack([
          dryRunThemeDir,
          '--out',
          dryRunThemeDir,
          ...extraArgs,
          '--dry-run',
        ]);
        assert.equal((await fs.readFile(dryRunZipPath)).equals(previousArchive), true);
      } finally {
        await fs.rm(dryRunThemeDir, { recursive: true, force: true });
      }

      const realThemeDir = await createThemeDir();
      const realZipPath = path.join(realThemeDir, fileName);
      await fs.writeFile(
        realZipPath,
        Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1, 0x42),
      );
      try {
        await runPack([realThemeDir, '--out', realThemeDir, ...extraArgs]);
        const zip = await JSZip.loadAsync(await fs.readFile(realZipPath));
        assert.equal(zip.file(fileName), null);
        assert.notEqual(zip.file('theme.json'), null);
      } finally {
        await fs.rm(realThemeDir, { recursive: true, force: true });
      }
    }
  } finally {
    console.log = originalLog;
  }
});

test('runPack excludes only the current target zip at the theme root', async () => {
  const themeDir = await createThemeDir({
    'unrelated.zip': Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1),
  });

  try {
    await assert.rejects(
      () => runPack([themeDir, '--out', themeDir, '--dry-run']),
      /Pack aborted: validate failed/,
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runPack keeps files below directories whose names end in .log', async () => {
  const themeDir = await createThemeDir({
    'assets.log/keep.js': 'export default true;',
    'debug.log': 'excluded log file',
  });
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-log-directory-'));
  const zipPath = path.join(outputRoot, 'test-studio.pack-regression@1.0.0.zip');
  const originalLog = console.log;
  console.log = () => {};

  try {
    await runPack([themeDir, '--out', outputRoot]);
    const zip = await JSZip.loadAsync(await fs.readFile(zipPath));

    assert.notEqual(zip.file('assets.log/keep.js'), null);
    assert.equal(zip.file('debug.log'), null);
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack ignores an external symlink below excluded node_modules', async () => {
  const themeDir = await createThemeDir();
  const externalRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-external-'));
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-symlink-'));
  const nodeModulesDir = path.join(themeDir, 'node_modules');
  const linkedPackage = path.join(nodeModulesDir, 'external-package');
  const zipPath = path.join(outputRoot, 'test-studio.pack-regression@1.0.0.zip');
  const originalLog = console.log;
  console.log = () => {};

  await fs.writeFile(path.join(externalRoot, 'index.js'), 'export default true;');
  await fs.mkdir(nodeModulesDir, { recursive: true });
  await fs.symlink(externalRoot, linkedPackage, process.platform === 'win32' ? 'junction' : 'dir');

  try {
    await runPack([themeDir, '--out', outputRoot]);
    const zip = await JSZip.loadAsync(await fs.readFile(zipPath));

    assert.equal(
      Object.keys(zip.files).some((filePath) => filePath.startsWith('node_modules/')),
      false,
    );
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(externalRoot, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack rejects included theme symbolic links in real and dry-run modes', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir();
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-included-link-'));
  await fs.symlink(path.join(themeDir, 'assets', 'style.css'), path.join(themeDir, 'assets', 'linked.css'));

  try {
    for (const extraArgs of [[], ['--dry-run']]) {
      await assert.rejects(
        () => runPack([themeDir, '--out', outputRoot, ...extraArgs]),
        /Pack aborted: validate failed/,
      );
    }
    assert.deepEqual(await fs.readdir(outputRoot), []);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack rejects literal backslashes instead of rewriting archive paths', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir({
    'assets/name\\variant.css': 'unsafe',
    'node_modules\\external.js': 'must not be mistaken for an excluded directory',
  });
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-backslash-'));

  try {
    for (const extraArgs of [[], ['--dry-run']]) {
      await assert.rejects(
        () => runPack([themeDir, '--out', outputRoot, ...extraArgs]),
        /Pack aborted: validate failed/,
      );
    }
    assert.deepEqual(await fs.readdir(outputRoot), []);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack rejects a symbolic-link theme root in real and dry-run modes', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir();
  const aliasPath = `${themeDir}-alias`;
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-root-link-'));
  await fs.symlink(themeDir, aliasPath, 'dir');

  try {
    for (const extraArgs of [[], ['--dry-run']]) {
      await assert.rejects(
        () => runPack([aliasPath, '--out', outputRoot, ...extraArgs]),
        /Theme directory must be a real directory and must not be a symbolic link/,
      );
    }
    assert.deepEqual(await fs.readdir(outputRoot), []);
  } finally {
    await fs.unlink(aliasPath).catch(() => {});
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack accepts a theme beneath a symlinked ancestor', {
  skip: process.platform === 'win32',
}, async () => {
  const realRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-real-input-'));
  const aliasRoot = path.join(canonicalTmpDir, `zeropress-theme-pack-input-alias-${path.basename(realRoot)}`);
  const themeDir = path.join(realRoot, 'theme');
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-alias-output-'));
  await fs.mkdir(themeDir);
  for (const [relativePath, content] of Object.entries(validThemeFiles())) {
    const fullPath = path.join(themeDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
  await fs.symlink(realRoot, aliasRoot, 'dir');

  try {
    await runPack([path.join(aliasRoot, 'theme'), '--out', outputRoot]);
    assert.deepEqual(await fs.readdir(outputRoot), ['test-studio.pack-regression@1.0.0.zip']);
  } finally {
    await fs.unlink(aliasRoot).catch(() => {});
    await fs.rm(realRoot, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack preserves the validated SemVer in distinct default archive names', async () => {
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-semver-'));
  const versions = ['1.0.0+Build.1', '1.0.0-Build.1'];
  const originalLog = console.log;
  console.log = () => {};

  try {
    for (const version of versions) {
      const themeDir = await createThemeDir({
        'theme.json': JSON.stringify({
          ...JSON.parse(validThemeFiles()['theme.json']),
          version,
        }),
      });
      try {
        await runPack([themeDir, '--out', outputRoot]);
      } finally {
        await fs.rm(themeDir, { recursive: true, force: true });
      }
    }

    assert.deepEqual(
      (await fs.readdir(outputRoot)).sort(),
      versions.map((version) => `test-studio.pack-regression@${version}.zip`).sort(),
    );
  } finally {
    console.log = originalLog;
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack aborts if the default archive name changes after manifest preflight', async () => {
  const themeDir = await createThemeDir();
  const manifestPath = path.join(themeDir, 'theme.json');
  const originalManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const changedManifest = JSON.stringify({ ...originalManifest, version: '2.0.0' });
  const originalOpen = fs.open;
  let manifestOpenCount = 0;

  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== manifestPath || manifestOpenCount > 0) {
      return handle;
    }
    manifestOpenCount += 1;
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      const replacementHandle = await originalOpen(manifestPath, 'w');
      try {
        await replacementHandle.writeFile(changedManifest);
      } finally {
        await replacementHandle.close();
      }
    };
    return handle;
  };

  try {
    await assert.rejects(
      () => runPack([themeDir, '--out', themeDir, '--dry-run']),
      /Pack aborted: theme\.json changed during packaging; retry/,
    );
  } finally {
    fs.open = originalOpen;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runPack preserves the cause when the default archive name cannot be read', async () => {
  const themeDir = await createThemeDir({
    'theme.json': '{ invalid json',
  });
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-default-name-'));

  try {
    await assert.rejects(
      () => runPack([themeDir, '--out', outputRoot, '--dry-run']),
      (error) => {
        assert.match(
          error.message,
          /cannot determine the default archive name: theme\.json contains invalid JSON/,
        );
        assert.equal(error.cause instanceof SyntaxError, true);
        return true;
      },
    );

    await fs.unlink(path.join(themeDir, 'theme.json'));
    await assert.rejects(
      () => runPack([themeDir, '--out', outputRoot, '--dry-run']),
      (error) => {
        assert.match(
          error.message,
          /cannot determine the default archive name: theme\.json was not found/,
        );
        assert.equal(error.cause?.code, 'ENOENT');
        return true;
      },
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack reads each included theme file once when a custom name is supplied', async () => {
  const themeDir = await createThemeDir();
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-snapshot-'));
  const originalOpen = fs.open;
  const openCounts = new Map();

  fs.open = async (...args) => {
    const resolvedPath = path.resolve(String(args[0]));
    if (
      resolvedPath === themeDir
      || resolvedPath.startsWith(`${themeDir}${path.sep}`)
    ) {
      openCounts.set(resolvedPath, (openCounts.get(resolvedPath) || 0) + 1);
    }
    return originalOpen(...args);
  };

  try {
    await runPack([
      themeDir,
      '--out',
      outputRoot,
      '--name',
      'snapshot.zip',
      '--dry-run',
    ]);
    for (const relativePath of Object.keys(validThemeFiles())) {
      assert.equal(openCounts.get(path.join(themeDir, relativePath)), 1, relativePath);
    }
  } finally {
    fs.open = originalOpen;
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack bounded-reads a file that grows after descriptor stat', async () => {
  const themeDir = await createThemeDir({
    'assets/growing.bin': Buffer.alloc(1024, 0x31),
  });
  const growingPath = path.join(themeDir, 'assets', 'growing.bin');
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-growth-'));
  const originalOpen = fs.open;
  let growingFileOpenCount = 0;

  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== growingPath) {
      return handle;
    }
    growingFileOpenCount += 1;
    if (growingFileOpenCount !== 1) {
      return handle;
    }
    const originalStat = handle.stat.bind(handle);
    handle.stat = async (...statArgs) => {
      const stat = await originalStat(...statArgs);
      await fs.appendFile(
        growingPath,
        Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1, 0x32),
      );
      return stat;
    };
    return handle;
  };

  try {
    await assert.rejects(
      () => runPack([
        themeDir,
        '--out',
        outputRoot,
        '--name',
        'growth.zip',
        '--dry-run',
      ]),
      /Pack aborted: validate failed.*assets\/growing\.bin.*exceeds/s,
    );
    assert.equal(growingFileOpenCount, 1);
    await assert.rejects(fs.access(path.join(outputRoot, 'growth.zip')), { code: 'ENOENT' });
  } finally {
    fs.open = originalOpen;
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack does not reopen the temporary archive for validation', async () => {
  const themeDir = await createThemeDir();
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-temp-open-'));
  const originalOpen = fs.open;
  const tempOpenFlags = [];
  const originalLog = console.log;
  console.log = () => {};

  fs.open = async (...args) => {
    if (path.basename(String(args[0])).startsWith('.zeropress-theme-pack-')) {
      tempOpenFlags.push(args[1]);
    }
    return originalOpen(...args);
  };

  try {
    await runPack([themeDir, '--out', outputRoot, '--name', 'single-validation.zip']);
    assert.deepEqual(tempOpenFlags, ['wx']);
  } finally {
    fs.open = originalOpen;
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack produces byte-identical archives with the canonical DOS epoch across timezones', async () => {
  const themeDir = await createThemeDir();
  const outputRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-deterministic-'));

  try {
    for (const [timezone, fileName] of [['UTC', 'utc.zip'], ['Asia/Seoul', 'seoul.zip']]) {
      const child = spawnSync(
        process.execPath,
        [cliPath, 'pack', themeDir, '--out', outputRoot, '--name', fileName],
        {
          encoding: 'utf8',
          env: { ...process.env, TZ: timezone, NO_COLOR: '1' },
        },
      );
      assert.equal(child.status, 0, child.stderr);
    }

    const utcBuffer = await fs.readFile(path.join(outputRoot, 'utc.zip'));
    const seoulBuffer = await fs.readFile(path.join(outputRoot, 'seoul.zip'));
    assert.equal(utcBuffer.equals(seoulBuffer), true);

    const zip = await JSZip.loadAsync(utcBuffer);
    for (const entry of Object.values(zip.files)) {
      assert.equal(entry.date.toISOString(), '1980-01-01T00:00:00.000Z');
    }
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
});

test('runPack accepts a shared symlink ancestor without letting dry-run write output', {
  skip: process.platform === 'win32',
}, async () => {
  const realRoot = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-pack-real-root-'));
  const aliasRoot = path.join(canonicalTmpDir, `zeropress-theme-pack-alias-${path.basename(realRoot)}`);
  const themeDir = path.join(realRoot, 'theme');
  const outputDir = path.join(aliasRoot, 'artifacts');
  const canonicalOutputDir = path.join(realRoot, 'artifacts');
  const zipName = 'test-studio.pack-regression@1.0.0.zip';
  const logs = [];
  const originalLog = console.log;

  await fs.mkdir(themeDir);
  for (const [relativePath, content] of Object.entries(validThemeFiles())) {
    const fullPath = path.join(themeDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
  await fs.symlink(realRoot, aliasRoot, 'dir');
  console.log = (message) => logs.push(String(message));

  try {
    await runPack([path.join(aliasRoot, 'theme'), '--out', outputDir, '--dry-run']);
    await assert.rejects(fs.access(canonicalOutputDir), { code: 'ENOENT' });
    assert.equal(
      logs.some((message) => message.includes(path.join(canonicalOutputDir, zipName))),
      true,
    );

    await runPack([path.join(aliasRoot, 'theme'), '--out', outputDir]);
    await runPack([path.join(aliasRoot, 'theme'), '--out', outputDir]);

    const zipPath = path.join(canonicalOutputDir, zipName);
    assert.equal((await fs.lstat(zipPath)).isFile(), true);
    assert.equal(
      (await fs.readdir(canonicalOutputDir)).some((name) => name.startsWith('.zeropress-theme-pack-')),
      false,
    );
  } finally {
    console.log = originalLog;
    await fs.unlink(aliasRoot).catch(() => {});
    await fs.rm(realRoot, { recursive: true, force: true });
  }
});

test('runPack escapes control characters in dry-run output paths', async () => {
  const themeDir = await createThemeDir();
  const outputDir = path.join(canonicalTmpDir, 'zeropress-theme-pack-output\n\u202E');
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(String(message));

  try {
    await runPack([themeDir, '--out', outputDir, '--dry-run']);
    const output = logs.join('\n');
    assert.equal(output.includes('\u202E'), false);
    assert.match(output, /output\\u000A\\u202E/);
    await assert.rejects(fs.access(outputDir), { code: 'ENOENT' });
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
