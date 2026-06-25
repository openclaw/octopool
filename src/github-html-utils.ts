export function plainHTML(value: string): string {
  return decodeHTML(value.replace(/<[^>]+>/g, "")).trim();
}

export function htmlAttribute(attributes: string, name: string): string | undefined {
  const value = new RegExp(`(?:^|\\s)${escapeRegex(name)}="([^"]*)"`).exec(attributes)?.[1];
  return value === undefined || value === "" ? undefined : decodeHTML(value);
}

export function textMatch(input: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(input)?.[1];
  return value === undefined ? undefined : decodeHTML(value.replace(/<[^>]+>/g, "")).trim();
}

export function decodeHTML(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
