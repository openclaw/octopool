import { AsyncLocalStorage } from "node:async_hooks";
import { HttpError, parsePositiveInt } from "./http";

export const BACKEND_LEASE_MS = 30_000;
export const BACKEND_DEADLINE_MS = 60_000;
export const BACKEND_RENEW_MS = 10_000;

type Admission = {
  acquire(id: string, client: string, limit: number): Promise<boolean>;
  renew(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
};

// Pending work belongs only to this relay invocation, never another request.
const scope = new AsyncLocalStorage<BackendWork>();

export async function admitBackendWork(): Promise<void> {
  await scope.getStore()?.enter();
}

export function assertBackendWorkActive(): void {
  scope.getStore()?.check();
}

export function backendWorkSignal(): AbortSignal | undefined {
  return scope.getStore()?.signal;
}

export function rethrowBackendWorkError(error: unknown): void {
  if (error instanceof HttpError && error.code === "relay_overloaded") throw error;
  assertBackendWorkActive();
}

export class BackendWork {
  private readonly id = crypto.randomUUID();
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private pending: Promise<void> | undefined;
  private renewalTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private until = Infinity;
  private deadline = Infinity;
  private closed = false;

  constructor(
    private readonly admission: Admission,
    private readonly client: string,
    private readonly limit: number,
  ) {}

  static limit(env: Env): number {
    return parsePositiveInt(env.CLIENT_BACKEND_CONCURRENCY, 8);
  }

  check(): void {
    if (Date.now() >= Math.min(this.until, this.deadline)) this.stop();
    if (this.signal.aborted) throw this.signal.reason;
  }

  private stop(): void {
    this.controller.abort(
      new HttpError(503, "relay_overloaded", "Client backend work limit or lease exhausted"),
    );
    clearTimeout(this.renewalTimer);
    clearTimeout(this.expiryTimer);
  }

  async enter(): Promise<void> {
    this.check();
    this.pending ??= this.acquire();
    await this.pending;
    this.check();
  }

  private async acquire(): Promise<void> {
    const started = Date.now();
    this.deadline = started + BACKEND_DEADLINE_MS;
    this.setExpiry(started + BACKEND_LEASE_MS);
    try {
      if (!(await this.admission.acquire(this.id, this.client, this.limit))) this.stop();
      this.check();
      this.scheduleRenewal();
    } catch {
      // Unknown grant acknowledgements must never authorize backend work.
      this.stop();
      this.check();
    } finally {
      // A caller can abort before the acquisition acknowledgement arrives.
      if (this.closed) await this.release();
    }
  }

  private setExpiry(until: number): void {
    this.until = Math.min(until, this.deadline);
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.stop(), Math.max(0, this.until - Date.now()));
  }

  private scheduleRenewal(): void {
    this.renewalTimer = setTimeout(() => void this.renew(), BACKEND_RENEW_MS);
  }

  private async renew(): Promise<void> {
    const started = Date.now();
    try {
      this.check();
      if (!(await this.admission.renew(this.id))) this.stop();
      this.check();
      // Use the start of the RPC, so transport delay never extends authority.
      this.setExpiry(started + BACKEND_LEASE_MS);
      this.scheduleRenewal();
    } catch {
      this.stop();
    }
  }

  private async release(): Promise<void> {
    try {
      await this.admission.release(this.id);
    } catch {
      // Durable expiry is the cleanup guarantee, including lost acknowledgements.
    }
  }

  async run<T>(signal: AbortSignal, ctx: ExecutionContext, handler: () => Promise<T>): Promise<T> {
    const cancel = () => this.stop();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) this.stop();
    let reject!: (error: unknown) => void;
    const aborted = new Promise<never>((_, fail) => {
      reject = fail;
    });
    const fail = () => reject(this.signal.reason);
    this.signal.addEventListener("abort", fail, { once: true });
    const work = scope.run(this, async () => {
      this.check();
      const result = await handler();
      this.check();
      return result;
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      this.closed = true;
      this.signal.removeEventListener("abort", fail);
      signal.removeEventListener("abort", cancel);
      this.stop();
      // Own late non-abortable storage completions; guards prevent new backend
      // operations when they resume. Do not keep the response waiting on cleanup.
      ctx.waitUntil(
        work.then(
          () => undefined,
          () => undefined,
        ),
      );
      if (this.pending !== undefined) ctx.waitUntil(this.release());
    }
  }
}
