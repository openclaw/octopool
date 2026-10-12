import { AsyncLocalStorage } from "node:async_hooks";

export const RELAY_PHASES = [
  "auth",
  "rewrite_policy",
  "membership",
  "pool_policy",
  "cache_lookup",
  "identity_eligibility",
  "admission",
  "body_acquire",
  "validator_lookup",
  "anonymous_fetch",
  "public_guard",
  "identity_select",
  "token",
  "pooled_fetch",
  "proof_publish",
  "body_publish",
  "response_encode",
  "github_headers",
  "github_body",
] as const;
type Phase = (typeof RELAY_PHASES)[number];
type Counter = "d1_ops" | "do_calls" | "github_fetches";
type ConfigKind = "caller" | "membership" | "policy" | "identities";
const scope = new AsyncLocalStorage<RelayTiming | undefined>();
const noop = { [Symbol.dispose]() {} };

export class RelayTiming {
  private readonly started = Date.now();
  private readonly phases = Object.fromEntries(RELAY_PHASES.map((key) => [key, 0])) as Record<
    Phase,
    number
  >;
  private readonly calls = { ...this.phases };
  private readonly active = new Map<Phase, { started: number; count: number }>();
  private readonly counts = { d1_ops: 0, do_calls: 0, github_fetches: 0 };
  private readonly configHits = { caller: 0, membership: 0, policy: 0, identities: 0 };
  private readonly configPendingHits = { ...this.configHits };
  private readonly cacheHits = { edge: 0, shared: 0, r2: 0 };
  private readonly readyCallbacks: (() => void)[] = [];
  json: string | undefined;

  phase(name: Phase): Disposable {
    if (this.json !== undefined) return noop;
    this.calls[name]++;
    const active = this.active.get(name);
    if (active === undefined) this.active.set(name, { started: Date.now(), count: 1 });
    else active.count++;
    return {
      [Symbol.dispose]: () => {
        const current = this.active.get(name);
        if (this.json !== undefined || current === undefined) return;
        if (--current.count === 0) {
          this.phases[name] += Math.max(0, Date.now() - current.started);
          this.active.delete(name);
        }
      },
    };
  }

  count(name: Counter): void {
    if (this.json === undefined) this.counts[name]++;
  }

  configHit(key: string, pending = false): void {
    if (this.json !== undefined) return;
    // Never retain the key: it can contain a caller token hash or repository name.
    const kind = key.split(":", 1)[0] as ConfigKind;
    if (Object.hasOwn(this.configHits, kind))
      (pending ? this.configPendingHits : this.configHits)[kind]++;
  }

  cacheHit(source: keyof RelayTiming["cacheHits"]): void {
    if (this.json === undefined) this.cacheHits[source]++;
  }

  onReady(callback: () => void): void {
    if (this.json === undefined) this.readyCallbacks.push(callback);
    else callback();
  }

  responseReady(response: Response): Response {
    const now = Date.now();
    for (const [phase, active] of this.active)
      this.phases[phase] += Math.max(0, now - active.started);
    const total = Math.max(0, now - this.started);
    this.json = JSON.stringify({
      version: 1,
      response_ready_ms: total,
      phases_ms: this.phases,
      phase_calls: this.calls,
      ...this.counts,
      config_cache_hits: this.configHits,
      config_cache_pending_hits: this.configPendingHits,
      cache_hits: this.cacheHits,
    });
    response.headers.set(
      "Server-Timing",
      [
        `response_ready;dur=${total}`,
        ...RELAY_PHASES.map((phase) => `${phase};dur=${this.phases[phase]}`),
      ].join(", "),
    );
    for (const callback of this.readyCallbacks) callback();
    this.readyCallbacks.length = 0;
    return response;
  }
}

export function withRelayTiming<T>(timing: RelayTiming | undefined, run: () => T): T {
  return scope.run(timing, run);
}

export function relayTiming(): RelayTiming | undefined {
  return scope.getStore();
}

export function relayPhase(name: Phase): Disposable {
  return relayTiming()?.phase(name) ?? noop;
}

// Observe the existing promise; do not add an await or replace its result.
export function relayPhasePromise<T extends Promise<unknown>>(name: Phase, run: () => T): T {
  const timing = relayTiming();
  if (timing === undefined || timing.json !== undefined) return run();
  const phase = timing.phase(name);
  try {
    const result = run();
    void result.then(
      () => phase[Symbol.dispose](),
      () => phase[Symbol.dispose](),
    );
    return result;
  } catch (error) {
    phase[Symbol.dispose]();
    throw error;
  }
}
