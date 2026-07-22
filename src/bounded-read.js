const MAX_READ_CHUNK_BYTES = 64 * 1024;

export const BOUNDED_READ_LIMIT_EXCEEDED = 'BOUNDED_READ_LIMIT_EXCEEDED';

export async function readFileHandleBounded(handle, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }

  const probeLimit = maxBytes + 1;
  const chunks = [];
  let totalBytes = 0;

  while (totalBytes < probeLimit) {
    const chunkLength = Math.min(MAX_READ_CHUNK_BYTES, probeLimit - totalBytes);
    const chunk = Buffer.allocUnsafe(chunkLength);
    const { bytesRead } = await handle.read(chunk, 0, chunkLength, null);
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
  }

  if (totalBytes > maxBytes) {
    const error = new Error(`File exceeds the bounded-read maximum of ${maxBytes} bytes`);
    error.code = BOUNDED_READ_LIMIT_EXCEEDED;
    error.maxBytes = maxBytes;
    error.bytesRead = totalBytes;
    throw error;
  }

  return Buffer.concat(chunks, totalBytes);
}
