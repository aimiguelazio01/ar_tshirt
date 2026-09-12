/**
 * Returns true only when a response has an uncompressed, reliable byte total.
 * Progress based on a compressed Content-Length is misleading because browsers
 * transparently decode the response body before exposing stream chunks.
 */
export function canStreamWithProgress(response) {
  const totalBytes = Number(response.headers.get('content-length'));
  const contentEncoding = (response.headers.get('content-encoding') || '').trim().toLowerCase();

  return Boolean(
    response.body &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0 &&
    (!contentEncoding || contentEncoding === 'identity')
  );
}

/**
 * Reads a response once. The stream reader is created only for responses that
 * can report honest download progress, so the arrayBuffer fallback never sees
 * a locked body.
 */
export async function readResponseArrayBuffer(response, onProgress) {
  if (!canStreamWithProgress(response)) {
    return response.arrayBuffer();
  }

  const totalBytes = Number(response.headers.get('content-length'));
  const reader = response.body.getReader();
  const chunks = [];
  let loadedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loadedBytes += value.byteLength;
      onProgress?.({ loadedBytes, totalBytes });
    }
  } finally {
    reader.releaseLock();
  }

  const allChunks = new Uint8Array(loadedBytes);
  let position = 0;
  for (const chunk of chunks) {
    allChunks.set(chunk, position);
    position += chunk.byteLength;
  }
  return allChunks.buffer;
}
