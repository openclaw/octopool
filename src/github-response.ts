const RESPONSE_HEADERS = [
  "etag",
  "last-modified",
  "link",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "x-ratelimit-used",
  "retry-after",
  "x-github-request-id",
];

export function githubResponseHeaders(
  headers: Headers,
  options: { contentType?: string; includeCacheControl?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const contentType = options.contentType ?? headers.get("content-type");
  if (contentType !== null && contentType !== undefined) {
    out["content-type"] = contentType;
  }
  for (const key of [
    ...RESPONSE_HEADERS,
    ...(options.includeCacheControl === true ? ["cache-control"] : []),
  ]) {
    const value = headers.get(key);
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
}

export function defaultGitHubJSONAccept(value: string | undefined, allowBlank = true): boolean {
  if (value === undefined) {
    return true;
  }
  if (value.trim() === "") {
    return allowBlank;
  }
  const normalized = value.toLowerCase();
  return (
    normalized === "application/vnd.github+json" ||
    normalized === "application/json" ||
    normalized === "application/vnd.github.v3+json"
  );
}
