import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BackendWork,
  BACKEND_DEADLINE_MS,
  BACKEND_LEASE_MS,
  admitBackendWork,
  assertBackendWorkActive,
  backendWorkSignal,
  withBackendWorkSignal,
} from "../src/backend-work";
import { HttpError } from "../src/http";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const admission = {
    acquire: vi.fn(async () => true),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
  const background: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  } as unknown as ExecutionContext;
  const input = new AbortController();
  const work = new BackendWork(admission, '["caller","client"]', BackendWork.limit({} as Env));
  const run = (handler: () => Promise<unknown>) =>
    work.run(input.signal, ctx, handler).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  const untilAbort = () =>
    new Promise<void>((resolve) => {
      backendWorkSignal()!.addEventListener("abort", () => resolve(), { once: true });
    });
  return { admission, background, input, run, untilAbort };
}

it("defaults to eight CLI slots and honors a configured server limit", () => {
  for (const value of [undefined, "", "invalid"])
    expect(BackendWork.limit({ CLIENT_BACKEND_CONCURRENCY: value } as Env)).toBe(8);
  expect(BackendWork.limit({ CLIENT_BACKEND_CONCURRENCY: "3" } as unknown as Env)).toBe(3);
});

it("coalesces acquisition only inside one request and releases on success", async () => {
  const f = fixture();
  const other = fixture();
  await Promise.all(
    [f, other].map((item) =>
      item.run(async () => {
        await Promise.all([admitBackendWork(), admitBackendWork()]);
        return "finished";
      }),
    ),
  );
  await Promise.all([...f.background, ...other.background]);
  expect(f.admission.acquire).toHaveBeenCalledTimes(1);
  expect(other.admission.acquire).toHaveBeenCalledTimes(1);
  expect(f.admission.release).toHaveBeenCalledTimes(1);
  expect(other.admission.release).toHaveBeenCalledTimes(1);
});

it("does no work or retry after a denied acquisition", async () => {
  const f = fixture();
  f.admission.acquire.mockResolvedValue(false);
  const upstream = vi.fn();
  const result = await f.run(async () => {
    await admitBackendWork();
    upstream();
  });
  await Promise.all(f.background);
  expect(result).toMatchObject({ error: { status: 503, code: "relay_overloaded" } });
  expect(upstream).not.toHaveBeenCalled();
  expect(f.admission.acquire).toHaveBeenCalledTimes(1);
  expect(f.admission.release).toHaveBeenCalledTimes(1);
});

it.each([0, 0.999])("retries a lost acknowledgement with bounded jitter (%s)", async (random) => {
  const f = fixture();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(Math, "random").mockReturnValue(random);
  f.admission.acquire.mockRejectedValueOnce(new Error("synthetic secret"));
  const upstream = vi.fn(() => "served");
  const result = f.run(async () => {
    await Promise.all([admitBackendWork(), admitBackendWork()]);
    return upstream();
  });
  const delay = random === 0 ? 50 : 150;
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(f.admission.acquire).toHaveBeenCalledTimes(1);
  expect(upstream).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ value: "served" });
  await Promise.all(f.background);
  expect(f.admission.acquire).toHaveBeenCalledTimes(2);
  expect(f.admission.acquire.mock.calls[1]).toEqual(f.admission.acquire.mock.calls[0]);
  expect(warning.mock.calls).toEqual([
    [
      {
        event: "octopool.worker.admission_unavailable",
        operation: "acquire",
        attempts: 2,
        retry_succeeded: true,
      },
    ],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  new Error("synthetic secret"),
  new Error("Durable Object reset."),
  Object.assign(new Error("synthetic retryable error"), { retryable: true }),
  "synthetic non-Error rejection",
  undefined,
])("fails closed with a storage fallback after two RPC rejections (%s)", async (failure) => {
  const f = fixture();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  f.admission.acquire.mockRejectedValue(failure);
  const upstream = vi.fn();
  const result = f.run(async () => {
    await admitBackendWork();
    upstream();
  });
  await vi.advanceTimersByTimeAsync(150);
  const outcome = await result;
  expect(outcome).toMatchObject({
    error: {
      status: 424,
      code: "fallback_local",
      details: { reason: "relay_storage_unavailable" },
    },
  });
  await Promise.all(f.background);
  expect(upstream).not.toHaveBeenCalled();
  expect(f.admission.acquire).toHaveBeenCalledTimes(2);
  expect(f.admission.release).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls).toEqual([
    [
      {
        event: "octopool.worker.admission_unavailable",
        operation: "acquire",
        attempts: 2,
        retry_succeeded: false,
      },
    ],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves a limit refusal after a transport retry", async () => {
  const f = fixture();
  f.admission.acquire.mockRejectedValueOnce(new Error("reset")).mockResolvedValue(false);
  const upstream = vi.fn();
  const result = f.run(async () => {
    await admitBackendWork();
    upstream();
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(await result).toMatchObject({ error: { code: "relay_overloaded" } });
  await Promise.all(f.background);
  expect(upstream).not.toHaveBeenCalled();
  expect(f.admission.acquire).toHaveBeenCalledTimes(2);
});

it("preserves typed admission errors without retry or reclassification", async () => {
  const f = fixture();
  const failure = new HttpError(403, "owner_denied", "Synthetic typed refusal");
  f.admission.acquire.mockRejectedValue(failure);
  expect(await f.run(admitBackendWork)).toEqual({ error: failure });
  await Promise.all(f.background);
  expect(f.admission.acquire).toHaveBeenCalledTimes(1);
});

it.each(["cancellation", "lease", "deadline"])("does not retry after %s", async (mode) => {
  const f = fixture();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  f.admission.acquire.mockRejectedValue(new Error("synthetic failure"));
  const upstream = vi.fn();
  const result = f.run(async () => {
    await admitBackendWork();
    upstream();
  });
  await vi.advanceTimersByTimeAsync(0);
  if (mode === "cancellation") f.input.abort();
  else vi.setSystemTime(Date.now() + (mode === "lease" ? BACKEND_LEASE_MS : BACKEND_DEADLINE_MS));
  await vi.advanceTimersByTimeAsync(150);
  expect(await result).toMatchObject({ error: { code: "relay_overloaded" } });
  await Promise.all(f.background);
  expect(upstream).not.toHaveBeenCalled();
  expect(f.admission.acquire).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledExactlyOnceWith({
    event: "octopool.worker.admission_unavailable",
    operation: "acquire",
    attempts: 1,
    retry_succeeded: false,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["rejected", "lost", "hung"])(
  "stops work on a %s renewal without a leaked timer",
  async (mode) => {
    const f = fixture();
    const pending = Promise.withResolvers<boolean>();
    const failure = new Error("synthetic renewal failure");
    if (mode === "rejected") f.admission.renew.mockResolvedValue(false);
    if (mode === "lost") f.admission.renew.mockRejectedValue(failure);
    if (mode === "hung") f.admission.renew.mockReturnValue(pending.promise);
    const result = f.run(async () => {
      await admitBackendWork();
      await f.untilAbort();
      assertBackendWorkActive();
    });
    await vi.advanceTimersByTimeAsync(mode === "hung" ? 30_000 : 10_000);
    if (mode === "lost")
      expect(await result).toMatchObject({
        error: {
          status: 424,
          code: "fallback_local",
          details: { reason: "relay_storage_unavailable" },
        },
      });
    else expect(await result).toMatchObject({ error: { code: "relay_overloaded" } });
    pending.resolve(true);
    await Promise.all(f.background);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.admission.renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("swallows release failures after successful work", async () => {
  const f = fixture();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  f.admission.release.mockRejectedValue(new Error("synthetic secret"));
  expect(
    await f.run(async () => {
      await admitBackendWork();
      return "served";
    }),
  ).toEqual({ value: "served" });
  await expect(Promise.all(f.background)).resolves.toBeDefined();
  expect(f.admission.release).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledExactlyOnceWith({
    event: "octopool.worker.admission_unavailable",
    operation: "release",
    attempts: 1,
    retry_succeeded: false,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds continuously renewed work at 60 seconds and prevents a resumed continuation", async () => {
  const f = fixture();
  const result = f.run(async () => {
    await admitBackendWork();
    await f.untilAbort();
    await admitBackendWork();
    throw new Error("expired continuation resumed");
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await result).toMatchObject({ error: { code: "relay_overloaded" } });
  await Promise.all(f.background);
  expect(f.admission.renew).toHaveBeenCalledTimes(5);
  expect(f.admission.acquire).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["grant", "RPC rejection"])(
  "cleans up a late %s after caller cancellation without resuming work",
  async (outcome) => {
    const f = fixture();
    const grant = Promise.withResolvers<boolean>();
    f.admission.acquire.mockReturnValue(grant.promise);
    const upstream = vi.fn();
    const result = f.run(async () => {
      await admitBackendWork();
      upstream();
    });
    f.input.abort();
    expect(await result).toMatchObject({ error: { code: "relay_overloaded" } });
    if (outcome === "grant") grant.resolve(true);
    else grant.reject(new Error("synthetic late RPC rejection"));
    await Promise.all(f.background);
    expect(upstream).not.toHaveBeenCalled();
    expect(f.admission.acquire).toHaveBeenCalledTimes(1);
    expect(f.admission.release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not acquire a permit for a fresh cache-only request", async () => {
  const f = fixture();
  expect(await f.run(async () => "cached")).toEqual({ value: "cached" });
  await Promise.all(f.background);
  expect(f.admission.acquire).not.toHaveBeenCalled();
  expect(f.admission.release).not.toHaveBeenCalled();
});

it("keeps background cancellation independent of caller admission and restores the foreground scope", async () => {
  const f = fixture();
  const background = new AbortController();
  const expired = new Error("background deadline");
  expect(
    await f.run(async () => {
      const foregroundSignal = backendWorkSignal();
      await withBackendWorkSignal(background.signal, async () => {
        await admitBackendWork();
        expect(backendWorkSignal()).toBe(background.signal);
        expect(f.admission.acquire).not.toHaveBeenCalled();
        background.abort(expired);
        expect(assertBackendWorkActive).toThrow(expired);
        await expect(admitBackendWork()).rejects.toBe(expired);
      });
      expect(backendWorkSignal()).toBe(foregroundSignal);
      expect(foregroundSignal!.aborted).toBe(false);
      await admitBackendWork();
      return "finished";
    }),
  ).toEqual({ value: "finished" });
  await Promise.all(f.background);
  expect(f.admission.acquire).toHaveBeenCalledTimes(1);
  expect(f.admission.release).toHaveBeenCalledTimes(1);
});

it("does not start background work with an expired signal", async () => {
  const handler = vi.fn();
  const expired = new Error("background deadline");
  await expect(withBackendWorkSignal(AbortSignal.abort(expired), handler)).rejects.toBe(expired);
  expect(handler).not.toHaveBeenCalled();
});
