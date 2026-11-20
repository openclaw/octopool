export async function cancelResponseBody(response: Response): Promise<void> {
  // Cancel this branch now; tee cleanup can wait for a different consumer.
  void response.body?.cancel().catch(() => undefined);
}

export async function readBodyCapped(
  response: Response,
  capBytes: number,
  tooLarge: () => Error,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      size += value.byteLength;
      if (size > capBytes) {
        // Tee cancellation can wait for another consumer; report the cap immediately.
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
