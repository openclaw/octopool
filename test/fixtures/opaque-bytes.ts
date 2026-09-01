import { Buffer } from "node:buffer";

// Literal wire bytes and classifications, never the production decoder as an oracle.
export const opaqueBytes = [
  { name: "invalid UTF-8", bytes: [0xff, 0xfe, 0x41], encoding: "base64" },
  {
    name: "late invalid UTF-8",
    bytes: [...Array<number>(1024).fill(0x61), 0xff],
    encoding: "base64",
  },
  { name: "leading BOM", bytes: [0xef, 0xbb, 0xbf, 0x61], encoding: "base64" },
  { name: "Unicode", bytes: [0xc3, 0xa9, 0xf0, 0x9f, 0xa6, 0x9e], encoding: "text" },
  { name: "literal replacement character", bytes: [0xef, 0xbf, 0xbd], encoding: "text" },
  { name: "CRLF", bytes: [0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a], encoding: "text" },
  { name: "NUL at 1023", bytes: [...Array<number>(1023).fill(0x61), 0], encoding: "base64" },
  { name: "NUL at 1024", bytes: [...Array<number>(1024).fill(0x61), 0], encoding: "text" },
  { name: "empty", bytes: [], encoding: "text" },
  { name: "JSON-looking text", bytes: [0x7b, 0x7d], encoding: "text" },
] as const;

export function envelopeBytes(response: { body: unknown; body_encoding?: string }): number[] {
  if (response.body === null && response.body_encoding === "text") return [];
  if (typeof response.body !== "string") throw new Error("Expected opaque wire body");
  if (response.body_encoding !== "text" && response.body_encoding !== "base64")
    throw new Error("Expected text or base64 envelope");
  return [...Buffer.from(response.body, response.body_encoding === "base64" ? "base64" : "utf8")];
}
