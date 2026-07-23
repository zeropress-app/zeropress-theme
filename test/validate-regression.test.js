import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { THEME_PACKAGE_LIMITS } from '@zeropress/theme-validator';
import {
  runValidate,
  validateThemeDirectory,
  validateZipFile,
} from '../src/validate.js';
import { resolveCanonicalDirectoryRoot } from '../src/helpers.js';

const require = createRequire(import.meta.url);
const crc32 = require('jszip/lib/crc32');

function validThemeFiles() {
  return {
    'theme.json': JSON.stringify({
      name: 'Regression Theme',
      namespace: 'test-studio',
      slug: 'regression-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.7',
    }),
    'layout.html': '<!doctype html><main>{{slot:content}}</main>',
    'index.html': '<h1>Index</h1>',
    'post.html': '<article>{{post.title}}</article>',
    'page.html': '<section>{{page.title}}</section>',
    'assets/style.css': 'body {}',
  };
}

async function createThemeDir(files = validThemeFiles()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-regression-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
  return root;
}

async function createZipFile(entries, {
  directories = [],
  fileOptions = {},
  generateOptions = {},
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-zip-regression-'));
  const zipPath = path.join(root, 'theme.zip');
  const zip = new JSZip();
  for (const [entryPath, content] of entries) {
    zip.file(entryPath, content, fileOptions);
  }
  for (const directoryPath of directories) {
    zip.folder(directoryPath);
  }
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', ...generateOptions }));
  return { root, zipPath };
}

async function createThemeZip(extraEntries = [], options = {}) {
  return createZipFile([
    ...Object.entries(validThemeFiles()),
    ...extraEntries,
  ], options);
}

const ZIP_HEADER_LAYOUTS = {
  central: {
    signature: Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    fileNameLengthOffset: 28,
    fileNameOffset: 46,
    uncompressedSizeOffset: 24,
  },
  local: {
    signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    fileNameLengthOffset: 26,
    fileNameOffset: 30,
  },
};

async function replaceZipEntryPathBytes(zipPath, headerType, originalPath, replacement) {
  const raw = await fs.readFile(zipPath);
  const original = Buffer.from(originalPath);
  const replacementBytes = Buffer.from(replacement);
  assert.equal(replacementBytes.length, original.length, 'zip path replacements must preserve byte length');

  const layout = ZIP_HEADER_LAYOUTS[headerType];
  let offset = 0;
  while ((offset = raw.indexOf(layout.signature, offset)) !== -1) {
    const fileNameLength = raw.readUInt16LE(offset + layout.fileNameLengthOffset);
    const fileNameOffset = offset + layout.fileNameOffset;
    const fileName = raw.subarray(fileNameOffset, fileNameOffset + fileNameLength);
    if (fileName.equals(original)) {
      replacementBytes.copy(raw, fileNameOffset);
      await fs.writeFile(zipPath, raw);
      return;
    }
    offset += 1;
  }

  assert.fail(`${headerType} zip entry not found: ${originalPath}`);
}

async function replaceCentralEntryPath(zipPath, originalPath, replacementPath) {
  await replaceZipEntryPathBytes(zipPath, 'central', originalPath, replacementPath);
}

async function replaceCentralUncompressedSize(zipPath, entryPath, size) {
  const raw = await fs.readFile(zipPath);
  const layout = ZIP_HEADER_LAYOUTS.central;
  const fileName = Buffer.from(entryPath);
  let offset = 0;

  while ((offset = raw.indexOf(layout.signature, offset)) !== -1) {
    const fileNameLength = raw.readUInt16LE(offset + layout.fileNameLengthOffset);
    const fileNameOffset = offset + layout.fileNameOffset;
    if (raw.subarray(fileNameOffset, fileNameOffset + fileNameLength).equals(fileName)) {
      raw.writeUInt32LE(size, offset + layout.uncompressedSizeOffset);
      await fs.writeFile(zipPath, raw);
      return;
    }
    offset += 1;
  }

  assert.fail(`central zip entry not found: ${entryPath}`);
}

async function corruptStoredEntryPayload(zipPath, entryPath) {
  const raw = await fs.readFile(zipPath);
  const layout = ZIP_HEADER_LAYOUTS.local;
  const fileName = Buffer.from(entryPath);
  let offset = 0;

  while ((offset = raw.indexOf(layout.signature, offset)) !== -1) {
    const fileNameLength = raw.readUInt16LE(offset + layout.fileNameLengthOffset);
    const fileNameOffset = offset + layout.fileNameOffset;
    if (raw.subarray(fileNameOffset, fileNameOffset + fileNameLength).equals(fileName)) {
      const compressionMethod = raw.readUInt16LE(offset + 8);
      assert.equal(compressionMethod, 0, 'fixture entry must use STORE compression');
      const extraFieldsLength = raw.readUInt16LE(offset + 28);
      const payloadOffset = fileNameOffset + fileNameLength + extraFieldsLength;
      raw[payloadOffset] ^= 0xff;
      await fs.writeFile(zipPath, raw);
      return;
    }
    offset += 1;
  }

  assert.fail(`local zip entry not found: ${entryPath}`);
}

async function addLocalUnicodePath(zipPath, entryPath, unicodePath) {
  const raw = await fs.readFile(zipPath);
  const layout = ZIP_HEADER_LAYOUTS.local;
  const fileName = Buffer.from(entryPath);
  let headerOffset = 0;

  while ((headerOffset = raw.indexOf(layout.signature, headerOffset)) !== -1) {
    const fileNameLength = raw.readUInt16LE(headerOffset + layout.fileNameLengthOffset);
    const fileNameOffset = headerOffset + layout.fileNameOffset;
    if (raw.subarray(fileNameOffset, fileNameOffset + fileNameLength).equals(fileName)) {
      break;
    }
    headerOffset += 1;
  }
  assert.notEqual(headerOffset, -1, `local zip entry not found: ${entryPath}`);
  assert.equal(raw.readUInt16LE(headerOffset + 6) & 0x0800, 0, 'fixture requires a non-UTF-8 entry');

  const extraFieldsLength = raw.readUInt16LE(headerOffset + 28);
  const insertionOffset = headerOffset + 30 + fileName.length + extraFieldsLength;
  const unicodePathBytes = Buffer.from(unicodePath);
  const unicodePathField = Buffer.alloc(4 + 5 + unicodePathBytes.length);
  unicodePathField.writeUInt16LE(0x7075, 0);
  unicodePathField.writeUInt16LE(5 + unicodePathBytes.length, 2);
  unicodePathField[4] = 1;
  unicodePathField.writeUInt32LE(crc32(fileName) >>> 0, 5);
  unicodePathBytes.copy(unicodePathField, 9);

  const updated = Buffer.concat([
    raw.subarray(0, insertionOffset),
    unicodePathField,
    raw.subarray(insertionOffset),
  ]);
  updated.writeUInt16LE(extraFieldsLength + unicodePathField.length, headerOffset + 28);

  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = updated.lastIndexOf(endSignature);
  assert.notEqual(endOffset, -1, 'end of central directory not found');
  const centralDirectoryOffset = updated.readUInt32LE(endOffset + 16);
  updated.writeUInt32LE(centralDirectoryOffset + unicodePathField.length, endOffset + 16);

  await fs.writeFile(zipPath, updated);
}

async function captureJsonOutput(callback) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk, encoding, done) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') {
      encoding();
    }
    if (typeof done === 'function') {
      done();
    }
    return true;
  });

  try {
    const code = await callback();
    return { code, payload: JSON.parse(chunks.join('')) };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('validateZipFile rejects archives above the compressed size limit before parsing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-large-archive-'));
  const zipPath = path.join(root, 'theme.zip');
  await fs.writeFile(zipPath, Buffer.alloc(THEME_PACKAGE_LIMITS.maxArchiveBytes + 1));

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'THEME_ARCHIVE_TOO_LARGE');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile counts every archive entry before ignoring metadata or directories', async () => {
  const entries = Object.entries(validThemeFiles());
  for (let index = entries.length; index < THEME_PACKAGE_LIMITS.maxEntries + 1; index += 1) {
    entries.push([`__MACOSX/ignored-${index}.txt`, '']);
  }
  const { root, zipPath } = await createZipFile(entries, {
    generateOptions: { compression: 'DEFLATE' },
  });

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'THEME_PACKAGE_TOO_MANY_ENTRIES');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects compressed entries with oversized declared expansion', async () => {
  const { root, zipPath } = await createThemeZip([
    ['assets/oversized.bin', Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1)],
  ]);

  try {
    const raw = await fs.readFile(zipPath);
    const zip = await JSZip.loadAsync(raw);
    await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.code === 'THEME_FILE_TOO_LARGE'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile counts actual decompressed bytes instead of trusting declared sizes', async () => {
  const { root, zipPath } = await createZipFile([
    ...Object.entries(validThemeFiles()),
    ['assets/oversized.bin', Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1)],
  ], {
    generateOptions: { compression: 'DEFLATE' },
  });

  try {
    await replaceCentralUncompressedSize(zipPath, 'assets/oversized.bin', 1);
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    const issue = result.errors.find((entry) => entry.code === 'THEME_FILE_TOO_LARGE');
    assert.match(issue?.message || '', /while decompressing/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects a stored entry whose payload CRC32 does not match', async () => {
  const { root, zipPath } = await createThemeZip([], {
    generateOptions: { compression: 'STORE' },
  });
  try {
    await corruptStoredEntryPayload(zipPath, 'assets/style.css');
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ZIP_CRC_MISMATCH');
    assert.equal(result.errors[0].path, 'assets/style.css');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile validates empty entry CRC32 values', async () => {
  const { root, zipPath } = await createThemeZip([['assets/empty.txt', '']]);
  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects UNIX symbolic-link entries before extraction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-zip-symlink-'));
  const zipPath = path.join(root, 'theme.zip');
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(validThemeFiles())) {
    zip.file(entryPath, content);
  }
  zip.file('assets/linked.css', 'style.css', { unixPermissions: 0o120777 });
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'SYMLINK_NOT_ALLOWED');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile accepts double-dot substrings in regular filenames', async () => {
  const { root, zipPath } = await createThemeZip([['assets/name..txt', 'safe']]);
  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateThemeDirectory rejects oversized files before reading their contents', async () => {
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    'assets/oversized.bin': Buffer.alloc(THEME_PACKAGE_LIMITS.maxFileBytes + 1),
  });

  try {
    const result = await validateThemeDirectory(themeDir);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.code === 'THEME_FILE_TOO_LARGE'), true);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validateThemeDirectory bounded-reads a file that grows after descriptor stat', async () => {
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    'assets/growing.bin': Buffer.alloc(1024, 0x31),
  });
  const growingPath = await fs.realpath(path.join(themeDir, 'assets', 'growing.bin'));
  const originalOpen = fs.open;
  let growingFileOpenCount = 0;

  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== growingPath || growingFileOpenCount > 0) {
      return handle;
    }
    growingFileOpenCount += 1;
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
    const result = await validateThemeDirectory(themeDir);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.code === 'THEME_FILE_TOO_LARGE'), true);
  } finally {
    fs.open = originalOpen;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validateZipFile rejects invalid original zip entry paths before normalization', async () => {
  const invalidPaths = [
    '/absolute.txt',
    'C:/drive.txt',
    'assets\\backslash.txt',
    'assets//empty.txt',
    'assets/./dot.txt',
    'assets/../dotdot.txt',
    'assets/\u0001control.txt',
  ];

  for (const invalidPath of invalidPaths) {
    const { root, zipPath } = await createThemeZip([[invalidPath, 'invalid']]);
    try {
      const result = await validateZipFile(zipPath);
      assert.equal(result.ok, false, invalidPath);
      assert.equal(
        result.errors.some((issue) => issue.code === 'INVALID_ZIP_ENTRY_PATH'),
        true,
        invalidPath,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('validateZipFile reads unsafeOriginalName instead of trusting the sanitized JSZip key', async () => {
  const originalPath = '../outside.txt';
  const { root, zipPath } = await createThemeZip([[originalPath, 'invalid']]);

  try {
    const loaded = await JSZip.loadAsync(await fs.readFile(zipPath));
    const entry = Object.values(loaded.files).find((file) => file.unsafeOriginalName === originalPath);
    assert.ok(entry);
    assert.notEqual(entry.name, entry.unsafeOriginalName);

    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'INVALID_ZIP_ENTRY_PATH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects an unsafe entry hidden by a later sanitized-key collision', async () => {
  const unsafePath = '../shadow.txt';
  const { root, zipPath } = await createThemeZip([
    [unsafePath, 'unsafe entry'],
    ['shadow.txt', 'safe entry'],
  ]);

  try {
    const loaded = await JSZip.loadAsync(await fs.readFile(zipPath));
    assert.equal(loaded.files['shadow.txt'].unsafeOriginalName, 'shadow.txt');

    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'INVALID_ZIP_ENTRY_PATH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects an unsafe path present only in the central directory', async () => {
  const { root, zipPath } = await createThemeZip([['aa/x.txt', 'safe local entry']]);
  await replaceCentralEntryPath(zipPath, 'aa/x.txt', '../x.txt');

  try {
    const loaded = await JSZip.loadAsync(await fs.readFile(zipPath));
    assert.notEqual(loaded.file('aa/x.txt'), null);

    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'INVALID_ZIP_ENTRY_PATH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects safe but mismatched central and local paths', async () => {
  const { root, zipPath } = await createThemeZip([['aa/x.txt', 'safe local entry']]);
  await replaceCentralEntryPath(zipPath, 'aa/x.txt', 'bb/x.txt');

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ZIP_ENTRY_NAME_MISMATCH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile compares central and local filename bytes before decoding', async () => {
  const originalPath = 'aa/x.txt';
  const centralPath = Buffer.from(originalPath);
  const localPath = Buffer.from(originalPath);
  centralPath[0] = 0x80;
  localPath[0] = 0x81;
  const { root, zipPath } = await createThemeZip([[originalPath, 'ambiguous entry']]);
  await replaceZipEntryPathBytes(zipPath, 'central', originalPath, centralPath);
  await replaceZipEntryPathBytes(zipPath, 'local', originalPath, localPath);

  try {
    assert.equal('\uFFFD', centralPath.toString('utf8')[0]);
    assert.equal(centralPath.toString('utf8'), localPath.toString('utf8'));

    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ZIP_ENTRY_NAME_MISMATCH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects an unsafe Unicode path present only in the local header', async () => {
  const entryPath = 'safe.txt';
  const { root, zipPath } = await createThemeZip([[entryPath, 'safe entry']]);
  await addLocalUnicodePath(zipPath, entryPath, '../evil.txt');

  try {
    const loaded = await JSZip.loadAsync(await fs.readFile(zipPath));
    assert.notEqual(loaded.file(entryPath), null);

    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'INVALID_ZIP_ENTRY_PATH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects invalid directory-only entry paths', async () => {
  const { root, zipPath } = await createZipFile(Object.entries(validThemeFiles()), {
    directories: ['../outside'],
  });

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'INVALID_ZIP_ENTRY_PATH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects paths that collide after normalization', async () => {
  for (const collidingPaths of [
    ['assets/logo.svg', 'assets/LOGO.svg'],
    ['assets/caf\u00e9.svg', 'assets/cafe\u0301.svg'],
  ]) {
    const { root, zipPath } = await createThemeZip(
      collidingPaths.map((entryPath) => [entryPath, '<svg></svg>']),
    );

    try {
      const result = await validateZipFile(zipPath);
      assert.equal(result.ok, false, collidingPaths.join(', '));
      assert.equal(result.errors[0].code, 'ZIP_PATH_COLLISION');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('validateZipFile rejects files used as parent directories after normalization', async () => {
  for (const extraEntries of [
    [['ASSETS', 'parent file added after its descendant']],
    [['LAYOUT.HTML/child.txt', 'descendant added after its parent file']],
    [
      ['assets/caf\u00e9', 'normalized parent file'],
      ['assets/cafe\u0301/icon.svg', '<svg></svg>'],
    ],
  ]) {
    const { root, zipPath } = await createThemeZip(extraEntries, {
      fileOptions: { createFolders: false },
    });

    try {
      const result = await validateZipFile(zipPath);
      assert.equal(result.ok, false, extraEntries.map(([entryPath]) => entryPath).join(', '));
      assert.equal(result.errors[0].code, 'ZIP_PATH_COLLISION');
      assert.match(result.errors[0].message, /hierarchy collision/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('validateZipFile accepts explicitly declared directory ancestors', async () => {
  const { root, zipPath } = await createThemeZip([], {
    directories: ['assets'],
  });

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects leading dot path segments', async () => {
  const entries = Object.entries(validThemeFiles()).map(([entryPath, content]) => [
    `./${entryPath}`,
    content,
  ]);
  const { root, zipPath } = await createZipFile(entries);

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'INVALID_ZIP_ENTRY_PATH');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile accepts distinct legacy-encoded paths with valid Unicode extras', async () => {
  const cp437 = new Map([
    ['é', 0x82],
    ['á', 0xa0],
  ]);
  const encodeFileName = (value) => Uint8Array.from(
    [...value].map((character) => cp437.get(character) ?? character.codePointAt(0)),
  );
  const { root, zipPath } = await createZipFile([
    ...Object.entries(validThemeFiles()),
    ['assets/café.txt', 'accent one'],
    ['assets/cafá.txt', 'accent two'],
  ], {
    generateOptions: { encodeFileName },
  });

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects raw parent-file collisions hidden by Unicode extras', async () => {
  const encodeFileName = (value) => {
    if (value === 'assets/p\u00e1rent.txt') {
      return Buffer.from('assets/raw-parent');
    }
    if (value === 'assets/ch\u00edld.txt') {
      return Buffer.from('assets/raw-parent/child.txt');
    }
    return Buffer.from(value);
  };
  const { root, zipPath } = await createThemeZip([
    ['assets/p\u00e1rent.txt', 'parent'],
    ['assets/ch\u00edld.txt', 'child'],
  ], {
    fileOptions: { createFolders: false },
    generateOptions: { encodeFileName },
  });

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ZIP_PATH_COLLISION');
    assert.match(result.errors[0].message, /hierarchy collision/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateZipFile rejects ASCII-case raw path collisions hidden by Unicode extras', async () => {
  const encodeFileName = (value) => {
    const rawName = value
      .replace('café.txt', 'CAFE.txt')
      .replace('cafá.txt', 'cafe.txt');
    return Uint8Array.from(Buffer.from(rawName, 'ascii'));
  };
  const { root, zipPath } = await createZipFile([
    ...Object.entries(validThemeFiles()),
    ['assets/café.txt', 'accent one'],
    ['assets/cafá.txt', 'accent two'],
  ], {
    generateOptions: { encodeFileName },
  });

  try {
    const result = await validateZipFile(zipPath);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'ZIP_PATH_COLLISION');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runValidate serializes corrupt zip failures with the standard JSON schema', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-corrupt-'));
  const zipPath = path.join(root, 'corrupt.zip');
  await fs.writeFile(zipPath, 'not a zip archive');

  try {
    const { code, payload } = await captureJsonOutput(() => runValidate([zipPath, '--json']));
    assert.equal(code, 1);
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.summary, {
      errors: 1,
      warnings: 0,
      infos: 0,
      checkedFiles: 0,
    });
    assert.equal(payload.errors[0].code, 'VALIDATION_ERROR');
    assert.equal(payload.meta.schemaVersion, '1');
    assert.equal(payload.meta.tool, 'zeropress-theme');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runValidate serializes target I/O failures as JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-missing-'));
  const missingPath = path.join(root, 'missing.zip');

  try {
    const { code, payload } = await captureJsonOutput(() => runValidate([missingPath, '--json']));
    assert.equal(code, 1);
    assert.equal(payload.ok, false);
    assert.equal(payload.errors[0].code, 'VALIDATION_ERROR');
    assert.equal(payload.summary.checkedFiles, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runValidate serializes dangling symlink failures as JSON', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir();
  await fs.symlink('missing-target.txt', path.join(themeDir, 'dangling.txt'));

  try {
    const { code, payload } = await captureJsonOutput(() => runValidate([themeDir, '--json']));
    assert.equal(code, 1);
    assert.equal(payload.ok, false);
    assert.equal(payload.errors[0].code, 'SYMLINK_NOT_ALLOWED');
    assert.equal(payload.summary.checkedFiles > 0, true);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validateThemeDirectory rejects internal file and directory symbolic links', {
  skip: process.platform === 'win32',
}, async () => {
  for (const kind of ['file', 'directory']) {
    const themeDir = await createThemeDir();
    try {
      const target = kind === 'file'
        ? path.join(themeDir, 'assets', 'style.css')
        : path.join(themeDir, 'assets');
      await fs.symlink(target, path.join(themeDir, `internal-${kind}`));
      const result = await validateThemeDirectory(themeDir);
      assert.equal(result.ok, false);
      assert.equal(result.errors.some((issue) => issue.code === 'SYMLINK_NOT_ALLOWED'), true);
    } finally {
      await fs.rm(themeDir, { recursive: true, force: true });
    }
  }
});

test('validateThemeDirectory rejects literal backslashes in POSIX filenames', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir();
  const unsafePath = path.join(themeDir, 'assets', 'name\\variant.css');
  await fs.writeFile(unsafePath, 'unsafe');

  try {
    const result = await validateThemeDirectory(themeDir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'PATH_ESCAPE');
    assert.match(result.errors[0].message, /Backslashes are not allowed/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validateThemeDirectory rejects paths that collide after case and NFC normalization', async (t) => {
  const themeDir = await createThemeDir();
  await fs.writeFile(path.join(themeDir, 'assets', 'Icon.svg'), 'first');
  await fs.writeFile(path.join(themeDir, 'assets', 'icon.svg'), 'second');

  try {
    const names = await fs.readdir(path.join(themeDir, 'assets'));
    if (!names.includes('Icon.svg') || !names.includes('icon.svg')) {
      t.skip('filesystem does not preserve case-distinct filenames');
      return;
    }

    const result = await validateThemeDirectory(themeDir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'THEME_PATH_COLLISION');
    assert.match(result.errors[0].message, /after NFC and case normalization/);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validate rejects a symbolic-link theme root without following it', {
  skip: process.platform === 'win32',
}, async () => {
  const themeDir = await createThemeDir();
  const aliasPath = `${themeDir}-alias`;
  await fs.symlink(themeDir, aliasPath, 'dir');

  try {
    const directResult = await validateThemeDirectory(aliasPath);
    assert.equal(directResult.ok, false);
    assert.equal(directResult.errors[0].code, 'SYMLINK_NOT_ALLOWED');

    const { code, payload } = await captureJsonOutput(() => runValidate([aliasPath, '--json']));
    assert.equal(code, 1);
    assert.equal(payload.errors[0].code, 'SYMLINK_NOT_ALLOWED');
    assert.equal(payload.errors[0].category, 'theme_package_paths');
  } finally {
    await fs.unlink(aliasPath).catch(() => {});
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validate accepts a theme beneath a symlinked ancestor', {
  skip: process.platform === 'win32',
}, async () => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'zeropress-theme-ancestor-alias-'));
  const realRoot = path.join(parent, 'real-root');
  const aliasRoot = path.join(parent, 'alias-root');
  const themeDir = path.join(realRoot, 'theme');
  await fs.mkdir(themeDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(validThemeFiles())) {
    const fullPath = path.join(themeDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
  await fs.symlink(realRoot, aliasRoot, 'dir');

  try {
    const result = await validateThemeDirectory(path.join(aliasRoot, 'theme'));
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('canonical directory roots remain pinned after an ancestor alias is retargeted', {
  skip: process.platform === 'win32',
}, async () => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'zeropress-theme-pinned-root-'));
  const firstRoot = path.join(parent, 'first');
  const secondRoot = path.join(parent, 'second');
  const aliasRoot = path.join(parent, 'alias');
  await fs.mkdir(path.join(firstRoot, 'theme'), { recursive: true });
  await fs.mkdir(path.join(secondRoot, 'theme'), { recursive: true });
  await fs.writeFile(path.join(firstRoot, 'theme', 'identity.txt'), 'first');
  await fs.writeFile(path.join(secondRoot, 'theme', 'identity.txt'), 'second');
  await fs.symlink(firstRoot, aliasRoot, 'dir');

  try {
    const canonicalRoot = await resolveCanonicalDirectoryRoot(path.join(aliasRoot, 'theme'), {
      label: 'Theme directory',
    });
    await fs.unlink(aliasRoot);
    await fs.symlink(secondRoot, aliasRoot, 'dir');

    assert.equal(canonicalRoot, await fs.realpath(path.join(firstRoot, 'theme')));
    assert.equal(await fs.readFile(path.join(canonicalRoot, 'identity.txt'), 'utf8'), 'first');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('runValidate serializes extra positional arguments as a CLI JSON error', async () => {
  const { code, payload } = await captureJsonOutput(() => runValidate([
    'theme-one',
    'theme-two',
    '--json',
  ]));
  assert.equal(code, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.errors[0].code, 'CLI_ARGUMENT_ERROR');
  assert.match(payload.errors[0].message, /exactly one/);
});

test('validateThemeDirectory forwards shouldInclude and skips excluded directory recursion', async () => {
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    'excluded/name..txt': 'not part of the theme package',
  });
  const visited = [];

  try {
    const result = await validateThemeDirectory(themeDir, {
      shouldInclude(relativePath, entry) {
        visited.push({ relativePath, isDirectory: entry.isDirectory() });
        return relativePath !== 'excluded';
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.checkedFiles, Object.keys(validThemeFiles()).length);
    assert.equal(visited.some(({ relativePath }) => relativePath === 'excluded'), true);
    assert.equal(visited.find(({ relativePath }) => relativePath === 'excluded').isDirectory, true);
    assert.equal(visited.some(({ relativePath }) => relativePath.startsWith('excluded/')), false);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});
