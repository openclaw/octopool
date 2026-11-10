// Large-input chunks contain whole three-byte groups so only the final chunk has padding.
const BASE64_CHUNK_BYTES = 3 * 8192;

export function bytesToBase64(bytes: Uint8Array): string {
  // Keep smaller payloads on the original path; chunking pays off for larger buffers.
  if (bytes.length <= 262_144) return encodeBase64Chunk(bytes);
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    encoded += encodeBase64Chunk(bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return encoded;
}

function encodeBase64Chunk(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function encodeOpaqueBytes(bytes: Uint8Array): {
  body: string;
  encoding: "text" | "base64";
} {
  if (!bytes.subarray(0, 1024).includes(0)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      const encoded = new TextEncoder().encode(text);
      // Default decoding strips a leading BOM even when UTF-8 is valid.
      if (
        encoded.length === bytes.length &&
        encoded.every((byte, index) => byte === bytes[index])
      ) {
        return { body: text, encoding: "text" };
      }
    } catch {
      // Invalid UTF-8 must remain reversible in the wire envelope.
    }
  }
  return { body: bytesToBase64(bytes), encoding: "base64" };
}

export function bytesToBase64URL(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64ToBytes(value: string): Uint8Array {
  return binaryToBytes(atob(value));
}

export function base64ToBytesSafe(value: string): Uint8Array | undefined {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  } catch {
    return undefined;
  }
}

function binaryToBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}
