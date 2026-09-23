import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/index.js';

const packageJsonPath = new URL('../package.json', import.meta.url);
const cliPath = fileURLToPath(new URL('../bin/zeropress-theme.js', import.meta.url));
// Keep Node's color-conflict warning out of CLI output assertions.
const cliEnv = { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' };

test('run prints help when --help appears anywhere in argv', async () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (message) => {
    messages.push(String(message));
  };

  try {
    await assert.doesNotReject(() => run(['dev', './my-theme', '--help']));
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0], /zeropress-theme - ZeroPress theme development toolkit/);
  assert.match(messages[0], /zeropress-theme dev <themeDir>/);
  assert.match(messages[0], /--public-dir <dir>/);
  assert.match(messages[0], /--host <host>/);
  assert.match(messages[0], /--no-js/);
  assert.match(messages[0], /Arguments:/);
  assert.match(messages[0], /Options:/);
  assert.match(messages[0], /--version, -v/);
});

test('run prints help and throws an error for unknown commands', async () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (message) => {
    messages.push(String(message));
  };

  try {
    await assert.rejects(
      () => run(['hello', '--world']),
      /Unknown command: hello/,
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0], /zeropress-theme - ZeroPress theme development toolkit/);
  assert.match(messages[0], /zeropress-theme validate <themeDir>/);
  assert.doesNotMatch(messages[0], /\bpack\b|\.zip/);
});

test('run treats the removed pack command as unknown', async () => {
  const originalLog = console.log;
  console.log = () => {};

  try {
    await assert.rejects(
      () => run(['pack', './theme']),
      /Unknown command: pack/,
    );
  } finally {
    console.log = originalLog;
  }
});

test('the CLI error boundary makes attacker-controlled terminal characters visible', () => {
  const command = 'bad\u001B]8;;example\u0007\n\u202Ecommand';
  const child = spawnSync(process.execPath, [cliPath, command], {
    encoding: 'utf8',
    env: cliEnv,
  });

  assert.equal(child.status, 1);
  assert.equal(child.stderr.includes('\u001B'), false);
  assert.equal(child.stderr.includes('\u0007'), false);
  assert.equal(child.stderr.includes('\u202E'), false);
  assert.match(child.stderr, /bad\\u001B]8;;example\\u0007\\u000A\\u202Ecommand/);
});

for (const unsafeInput of [false, true]) {
  test(`dev startup preserves validation report layout${unsafeInput ? ' while escaping diagnostic input' : ''}`, async () => {
    const themeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-diagnostics-'));
    const files = {
      'theme.json': JSON.stringify({
        name: 'Test Theme',
        namespace: 'test-studio',
        slug: 'test-theme',
        version: '1.0.0',
        license: 'MIT',
        runtime: '0.5',
      }),
      'layout.html': '<!doctype html><html><body>{{slot:content}}</body></html>',
      'index.html': '<h1>{{site.title}}</h1>',
      'post.html': '<article>{{post.html}}</article>',
      'page.html': '<article>{{page.html}}</article>',
      'assets/style.css': 'body {}',
    };
    if (unsafeInput) {
      files['assets/evil\u001B]8;;example\u0007\n\u202E.css'] = 'body {}';
      files['index.html'] = '<h1>{{site.\u0085\u202Ebad}}</h1>';
    }

    try {
      for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(themeDir, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
      }
      const child = spawnSync(process.execPath, [cliPath, 'dev', themeDir], {
        encoding: 'utf8',
        env: cliEnv,
        timeout: 10_000,
      });

      assert.equal(child.status, 1);
      assert.equal(child.signal, null);
      assert.match(child.stderr, /^\[zeropress-theme\] Theme validation failed\nErrors: \d+\nChecked files: \d+\n\nERROR /);
      assert.match(child.stderr, /\n\nHint:\nUpdate theme\.json:\n\n"runtime": "0\.7"/);
      assert.doesNotMatch(child.stderr, /[\u001B\u0007\u0085\u202E]/);
      if (unsafeInput) {
        assert.match(child.stderr, /evil\\u001B]8;;example\\u0007\\u000A\\u202E\.css/);
        assert.match(child.stderr, /\\u0085\\u202Ebad/);
      } else {
        assert.equal(child.stderr.includes('\\u000A'), false);
      }
    } finally {
      await fs.rm(themeDir, { recursive: true, force: true });
    }
  });
}

for (const flag of ['--version', '-v']) {
  test(`run prints version with ${flag}`, async () => {
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => {
      messages.push(String(message));
    };

    try {
      await run([flag]);
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      assert.deepEqual(messages, [pkg.version]);
    } finally {
      console.log = originalLog;
    }
  });
}

test('validate --json flushes large output before exiting with failure', async () => {
  const themeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-theme-json-'));

  try {
    await fs.mkdir(path.join(themeDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(themeDir, 'theme.json'), JSON.stringify({
      name: 'Test Theme',
      namespace: 'test-studio',
      slug: 'test-theme',
      version: '1.0.0',
      license: 'MIT',
      runtime: '0.7',
    }));
    await fs.writeFile(
      path.join(themeDir, 'layout.html'),
      `<!doctype html><html><body>{{slot:content}}<script>${'x'.repeat(100_000)}</script></body></html>`,
    );
    await fs.writeFile(path.join(themeDir, 'index.html'), '<h1>Index</h1>');
    await fs.writeFile(path.join(themeDir, 'post.html'), '<h1>Post</h1>');
    await fs.writeFile(path.join(themeDir, 'page.html'), '<h1>Page</h1>');
    await fs.writeFile(path.join(themeDir, 'assets/style.css'), 'body {}');

    const child = spawnSync(
      process.execPath,
      [cliPath, 'validate', themeDir, '--json'],
      { encoding: 'utf8', env: cliEnv, maxBuffer: 1024 * 1024 },
    );

    assert.equal(child.status, 1);
    assert.equal(child.signal, null);
    assert.equal(child.stderr, '');
    assert.ok(Buffer.byteLength(child.stdout) > 65_536);
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((issue) => issue.code === 'LAYOUT_SCRIPT_NOT_ALLOWED'), true);
  } finally {
    await fs.rm(themeDir, { recursive: true, force: true });
  }
});

for (const testCase of [
  {
    name: 'missing required target',
    args: ['validate', '--json'],
    message: 'validate requires a themeDir argument',
  },
  {
    name: 'unknown option before the json flag',
    args: ['validate', '--strict', '--json'],
    message: 'Unknown option for validate: --strict',
  },
]) {
  test(`validate --json serializes ${testCase.name} as JSON`, () => {
    const child = spawnSync(process.execPath, [cliPath, ...testCase.args], {
      encoding: 'utf8',
      env: cliEnv,
    });

    assert.equal(child.status, 1);
    assert.equal(child.signal, null);
    assert.equal(child.stderr, '');

    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, false);
    assert.deepEqual(result.summary, {
      errors: 1,
      warnings: 0,
      infos: 0,
      checkedFiles: 0,
    });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'CLI_ARGUMENT_ERROR');
    assert.equal(result.errors[0].path, 'command line');
    assert.equal(result.errors[0].message, testCase.message);
    assert.equal(result.errors[0].severity, 'error');
    assert.equal(result.errors[0].category, 'cli_arguments');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.infos, []);
    assert.equal(result.meta.schemaVersion, '1');
    assert.equal(result.meta.tool, 'zeropress-theme');
  });
}
