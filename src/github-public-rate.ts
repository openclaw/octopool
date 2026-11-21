import { parseRateHeaderInt } from "./github-rate";
import { timingD1Identity } from "./relay-timing-bindings";
import { withRelayTiming } from "./relay-timing";
import { queries } from "./generated/sql";

const PUBLIC_API_RATE_WRITE_INTERVAL_MS = 15_000;
type RateSnapshot = { writtenAt: number; remaining: number; resetAt: number };
let rateSnapshots = new WeakMap<D1Database, Map<string, RateSnapshot>>();

// The e2e harness resets D1 between tests in the same isolate.
export function clearPublicAPIRateSnapshots(): void {
  rateSnapshots = new WeakMap();
}

export async function storePublicAPIRate(
  env: Pick<Env, "DB">,
  resource: string,
  headers: Headers,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const limit = parseRateHeaderInt(headers.get("x-ratelimit-limit") ?? undefined);
  const remaining = parseRateHeaderInt(headers.get("x-ratelimit-remaining") ?? undefined);
  const resetAt = parseRateHeaderInt(headers.get("x-ratelimit-reset") ?? undefined);
  if (limit === undefined || remaining === undefined || resetAt === undefined || limit <= 0) {
    return;
  }
  const database = timingD1Identity(env.DB);
  let snapshots = rateSnapshots.get(database);
  if (snapshots === undefined) {
    snapshots = new Map();
    rateSnapshots.set(database, snapshots);
  }
  const now = Date.now();
  const previous = snapshots.get(resource);
  if (
    previous !== undefined &&
    now - previous.writtenAt < PUBLIC_API_RATE_WRITE_INTERVAL_MS &&
    previous.resetAt === resetAt &&
    !(remaining === 0 && previous.remaining !== 0)
  )
    return;
  // Reserve before I/O; never share a pending promise across request lifetimes.
  snapshots.set(resource, { writtenAt: now, remaining, resetAt });
  const write = async () => {
    try {
      await env.DB.prepare(queries.upsertPublicApiRate)
        .bind(resource, limit, remaining, resetAt)
        .run();
    } catch {
      // Keep the interval on failure too: advisory writes must not amplify a D1 outage.
    }
  };
  if (ctx !== undefined) ctx.waitUntil(withRelayTiming(undefined, write));
  else await write();
}
