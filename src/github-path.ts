export function encodedPathSegments(segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split("/"))
    .map(encodeURIComponent)
    .join("/");
}

export function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function appendRelayQuery(
  url: URL,
  query: Record<string, string | string[]> | undefined,
): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else {
      url.searchParams.set(key, value);
    }
  }
}

export function safeRelativePath(value: string, maxLength: number): boolean {
  return (
    value.length <= maxLength &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
