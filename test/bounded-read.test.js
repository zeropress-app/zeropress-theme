import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BOUNDED_READ_LIMIT_EXCEEDED,
  readFileHandleBounded,
} from '../src/bounded-read.js';

test('readFileHandleBounded accepts the exact limit and reads at most limit + 1', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-bounded-read-'));
  const exactPath = path.join(root, 'exact.bin');
  const oversizedPath = path.join(root, 'oversized.bin');
  const limit = 64 * 1024;
  await fs.writeFile(exactPath, Buffer.alloc(limit, 0x41));
  await fs.writeFile(oversizedPath, Buffer.alloc(limit * 4, 0x42));

  try {
    const exactHandle = await fs.open(exactPath, 'r');
    try {
      const exact = await readFileHandleBounded(exactHandle, limit);
      assert.equal(exact.byteLength, limit);
    } finally {
      await exactHandle.close();
    }

    const oversizedHandle = await fs.open(oversizedPath, 'r');
    try {
      await assert.rejects(
        () => readFileHandleBounded(oversizedHandle, limit),
        (error) => {
          assert.equal(error.code, BOUNDED_READ_LIMIT_EXCEEDED);
          assert.equal(error.maxBytes, limit);
          assert.equal(error.bytesRead, limit + 1);
          return true;
        },
      );
      const nextByte = Buffer.alloc(1);
      const { bytesRead } = await oversizedHandle.read(nextByte, 0, 1, null);
      assert.equal(bytesRead, 1);
      assert.equal(nextByte[0], 0x42);
    } finally {
      await oversizedHandle.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('readFileHandleBounded rejects a file that grows after its descriptor is statted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-bounded-read-growth-'));
  const filePath = path.join(root, 'growing.bin');
  const limit = 1024;
  await fs.writeFile(filePath, Buffer.alloc(limit, 0x31));

  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const beforeGrowth = await handle.stat();
      assert.equal(beforeGrowth.size, limit);
      await fs.appendFile(filePath, Buffer.alloc(limit * 1024, 0x32));

      await assert.rejects(
        () => readFileHandleBounded(handle, limit),
        (error) => {
          assert.equal(error.code, BOUNDED_READ_LIMIT_EXCEEDED);
          assert.equal(error.bytesRead, limit + 1);
          return true;
        },
      );
    } finally {
      await handle.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
