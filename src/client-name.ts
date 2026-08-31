import { HttpError } from "./http";

export function normalizeClientName(value: string): string {
  const trimmed = value.trim();
  let end = trimmed.length;
  // Inspect each suffix once; never lowercase or copy the shrinking prefix.
  while (end > 6 && trimmed.slice(end - 6, end).toLowerCase() === ".local") {
    end -= 6;
  }
  return trimmed.slice(0, end);
}

export function parseClientName(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "client_name_invalid", "client_name must be a string");
  }
  const clientName = normalizeClientName(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(clientName)) {
    throw new HttpError(
      400,
      "client_name_invalid",
      "client_name must be 1-80 hostname-safe characters",
    );
  }
  return clientName;
}
