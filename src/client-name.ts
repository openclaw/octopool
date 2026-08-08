export function normalizeClientName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > ".local".length && trimmed.toLowerCase().endsWith(".local")
    ? trimmed.slice(0, -".local".length)
    : trimmed;
}
