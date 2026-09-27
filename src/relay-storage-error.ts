import { HttpError } from "./http";

// Cloudflare D1 debug errors and Durable Object error-handling/troubleshooting
// signals. Keep SQL/configuration bugs and typed upstream/policy errors visible.
export function isTransientRelayStorageError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof HttpError) return false;
  if (
    ("retryable" in error && error.retryable === true) ||
    ("overloaded" in error && error.overloaded === true)
  ) {
    return true;
  }
  const message = error.message.replace(/^D1_ERROR:\s*/i, "");
  if (/^Network connection lost\.?$/i.test(message)) return true;
  if (
    /^D1_ERROR:/i.test(error.message) &&
    /^(?:internal error\.?$|overloaded(?:\.|$))/i.test(message)
  )
    return true;
  if (/^Durable Object reset\.?$/i.test(message)) return true;
  return (
    /^(?:D1 DB|Durable Object) (?:is overloaded(?:\.|$)|reset because its code was updated\.?$|storage operation exceeded timeout which caused object to be reset\.?$)/i.test(
      message,
    ) ||
    /^Internal error (?:while starting up|in) D1 DB storage caused object to be reset\.?$/i.test(
      message,
    ) ||
    /^Cannot resolve D1 DB due to transient issue on remote node\.?$/i.test(message) ||
    (/^D1_ERROR:/i.test(error.message) && /^Replica disconnected from primary\.?$/i.test(message))
  );
}
