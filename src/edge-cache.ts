type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
};

export async function readEdgeJSON<T>(namespace: string, key: string): Promise<T | undefined> {
  const cache = defaultEdgeCache();
  if (cache === undefined) {
    return undefined;
  }
  const request = edgeRequest(namespace, key);
  try {
    const response = await cache.match(request);
    if (response === undefined) {
      return undefined;
    }
    return (await response.json()) as T;
  } catch {
    await deleteEdgeJSON(namespace, key);
    return undefined;
  }
}

export async function writeEdgeJSON(
  namespace: string,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const cache = defaultEdgeCache();
  if (cache === undefined || ttlSeconds <= 0) {
    return;
  }
  try {
    await cache.put(
      edgeRequest(namespace, key),
      Response.json(value, {
        headers: {
          "cache-control": `public, max-age=${Math.max(1, Math.floor(ttlSeconds))}`,
        },
      }),
    );
  } catch {
    // The D1 cache remains authoritative when an edge cache operation fails.
  }
}

export async function deleteEdgeJSON(namespace: string, key: string): Promise<void> {
  const cache = defaultEdgeCache();
  if (cache === undefined) {
    return;
  }
  try {
    await cache.delete(edgeRequest(namespace, key));
  } catch {
    // Expired entries are harmless and will age out naturally.
  }
}

function defaultEdgeCache(): EdgeCache | undefined {
  return (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;
}

function edgeRequest(namespace: string, key: string): Request {
  return new Request(
    `https://octopool-edge.invalid/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
  );
}
