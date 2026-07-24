import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runValidate, validateThemeDirectory } from '../src/validate.js';

const packageJsonPath = new URL('../package.json', import.meta.url);
const canonicalTmpDir = await fs.realpath(os.tmpdir());

async function createThemeDir(files) {
  const root = await fs.mkdtemp(path.join(canonicalTmpDir, 'zeropress-theme-'));

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  return root;
}


function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function validThemeFiles() {
  return {
    'theme.json': JSON.stringify({
      name: 'Test Theme',
      namespace: 'test-studio',
      slug: 'test-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.7',
      description: 'A test theme',
      features: {
        search: true,
      },
    }),
    'layout.html': '<main>{{slot:content}}</main>',
    'index.html': '<h1>{{site.title}}</h1>',
    'post.html': '<article>{{post.title}}{{post.html}}</article>',
    'page.html': '<section>{{page.title}}</section>',
    'assets/style.css': 'body { color: black; }',
  };
}

test('validateThemeDirectory returns zero errors for a valid theme', async () => {
  const themeDir = await createThemeDir(validThemeFiles());
  const result = await validateThemeDirectory(themeDir);

  assert.equal(result.errors.length, 0);
  assert.equal(result.ok, true);

  await fs.rm(themeDir, { recursive: true, force: true });
});

test('runValidate returns 1 and emits json for invalid theme', async () => {
  const files = validThemeFiles();
  delete files['layout.html'];
  const themeDir = await createThemeDir(files);

  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') {
      encoding();
    }
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  });

  try {
    const code = await runValidate([themeDir, '--json']);
    assert.equal(code, 1);
    const payload = JSON.parse(chunks.join(''));
    assert.equal(payload.ok, false);
    assert.equal(Array.isArray(payload.errors), true);
    assert.equal(Array.isArray(payload.infos), true);
    assert.equal(payload.errors.some((issue) => issue.path === 'layout.html'), true);
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    assert.equal(payload.meta.schemaVersion, '1');
    assert.equal(payload.meta.tool, 'zeropress-theme');
    assert.equal(payload.meta.toolVersion, packageJson.version);
  } finally {
    process.stdout.write = originalWrite;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate prints theme validation location and hint in human output', async () => {
  const files = validThemeFiles();
  files['layout.html'] = [
    '<html>',
    '<head><script src="/theme.js"></script></head>',
    '<body>{{slot:content}}</body>',
    '</html>',
  ].join('\n');
  const themeDir = await createThemeDir(files);
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => {
    logs.push(String(message));
  };

  try {
    const code = await runValidate([themeDir]);
    assert.equal(code, 1);
    const output = stripAnsi(logs.join('\n'));
    assert.equal(
      output.startsWith(`Theme validation failed\nTarget: ${themeDir} (theme directory)`),
      true,
    );
    assert.match(output, /ERROR LAYOUT_SCRIPT_NOT_ALLOWED/);
    assert.match(output, /File: layout\.html/);
    assert.match(output, /Line: 2, Column: 7/);
    assert.match(output, /Category: theme_validation/);
    assert.match(output, /Hint:/);
    assert.match(output, /\{\{partial:content-enhancements\}\}/);
    assert.doesNotMatch(output, /(?:^|\n)Result:/);
  } finally {
    console.log = originalLog;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate preserves intended line breaks in human hints', async () => {
  const files = validThemeFiles();
  const manifest = JSON.parse(files['theme.json']);
  files['theme.json'] = JSON.stringify({ ...manifest, runtime: '0.6' });
  const themeDir = await createThemeDir(files);
  const logs = [];
  const originalLog = console.log;
  const originalNoColor = process.env.NO_COLOR;
  console.log = (message) => logs.push(String(message));
  process.env.NO_COLOR = '1';

  try {
    const code = await runValidate([themeDir]);
    assert.equal(code, 1);
    const output = logs.join('\n');
    assert.match(output, /Hint:\nUpdate theme\.json:\n\n"runtime": "0\.7"/);
    assert.equal(output.includes('\\u000A'), false);
  } finally {
    console.log = originalLog;
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate escapes terminal controls in human paths and snippets while preserving layout', async () => {
  const files = validThemeFiles();
  const unsafeName = 'assets/evil\u001B]8;;example\u0007\n\u202E.css';
  files[unsafeName] = 'body {}';
  files['index.html'] = '<h1>{{site.\u0085\u202Ebad}}</h1>';
  const themeDir = await createThemeDir(files);
  const logs = [];
  const originalLog = console.log;
  const originalNoColor = process.env.NO_COLOR;
  console.log = (message) => logs.push(String(message));
  process.env.NO_COLOR = '1';

  try {
    const code = await runValidate([themeDir]);
    assert.equal(code, 1);
    const output = logs.join('\n');
    assert.equal(output.includes('\u001B'), false);
    assert.equal(output.includes('\u0007'), false);
    assert.equal(output.includes('\u0085'), false);
    assert.equal(output.includes('\u202E'), false);
    assert.match(output, /evil\\u001B]8;;example\\u0007\\u000A\\u202E\.css/);
    assert.match(output, /\\u0085\\u202Ebad/);
    assert.match(output, /\nErrors: /);
  } finally {
    console.log = originalLog;
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('validate --json preserves raw issue data and remains parseable', async () => {
  const unsafeName = 'assets/json\u001B\u202E.css';
  const themeDir = await createThemeDir({
    ...validThemeFiles(),
    [unsafeName]: 'body {}',
  });
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    assert.equal(await runValidate([themeDir, '--json']), 1);
    const payload = JSON.parse(chunks.join(''));
    assert.equal(payload.errors.some((issue) => issue.path === unsafeName), true);
  } finally {
    process.stdout.write = originalWrite;
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate keeps forced-color human output searchable after ANSI stripping', async () => {
  const files = validThemeFiles();
  files['layout.html'] = [
    '<html>',
    '<head><script src="/theme.js"></script></head>',
    '<body>{{slot:content}}</body>',
    '</html>',
  ].join('\n');
  const themeDir = await createThemeDir(files);
  const logs = [];
  const originalLog = console.log;
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  console.log = (message) => {
    logs.push(String(message));
  };
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';

  try {
    const code = await runValidate([themeDir]);
    assert.equal(code, 1);
    const output = logs.join('\n');
    assert.match(output, /\x1B\[/);
    assert.match(stripAnsi(output), /ERROR LAYOUT_SCRIPT_NOT_ALLOWED/);
    assert.match(stripAnsi(output), /INFO  MISSING_OPTIONAL_TEMPLATES/);
  } finally {
    console.log = originalLog;
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

test('runValidate requires a themeDir argument', async () => {
  await assert.rejects(
    () => runValidate([]),
    /validate requires a themeDir argument/,
  );
});


test('runValidate ignores info notes for exit code and rejects removed strict option', async () => {
  const themeDir = await createThemeDir(validThemeFiles());

  try {
    assert.equal(await runValidate([themeDir]), 0);
    await assert.rejects(
      () => runValidate([themeDir, '--strict']),
      /Unknown option for validate: --strict/,
    );
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});
