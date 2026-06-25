export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
