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

export function decodePathStrict(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function scalarQuery(
  query: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const value = query?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function validScalarQuery(
  query: Record<string, string | string[]> | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  return !Object.entries(query ?? {}).some(
    ([key, value]) => !allowed.has(key) || Array.isArray(value) || value === "",
  );
}

export function firstPageQuery(query: Record<string, string | string[]> | undefined): boolean {
  const page = scalarQuery(query, "page");
  return page === undefined || page === "1";
}

export function boundedPageSize(
  value: string | string[] | undefined,
  options: { defaultValue?: number; max?: number; strict?: boolean } = {},
): number | undefined {
  if (value === undefined) {
    return options.defaultValue;
  }
  if (Array.isArray(value) || (options.strict === true && !/^[1-9][0-9]*$/.test(value))) {
    return undefined;
  }
  const parsed = Number(value);
  const max = options.max ?? 100;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : undefined;
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
