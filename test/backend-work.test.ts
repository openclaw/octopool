import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BackendWork,
  admitBackendWork,
  assertBackendWorkActive,
  backendWorkSignal,
} from "../src/backend-work";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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

it.each(["denied", "lost acknowledgement"])("does no work after %s acquisition", async (mode) => {
  const f = fixture();
  if (mode === "denied") f.admission.acquire.mockResolvedValue(false);
  else f.admission.acquire.mockRejectedValue(new Error("synthetic lost grant acknowledgement"));
  const upstream = vi.fn();
  const result = await f.run(async () => {
    await admitBackendWork();
    upstream();
  });
  await Promise.all(f.background);
  expect(result).toMatchObject({ error: { status: 503, code: "relay_overloaded" } });
  expect(upstream).not.toHaveBeenCalled();
  expect(f.admission.release).toHaveBeenCalledTimes(1);
});

it.each(["rejected", "lost", "hung"])(
  "stops work on a %s renewal without a leaked timer",
  async (mode) => {
    const f = fixture();
    const pending = Promise.withResolvers<boolean>();
    if (mode === "rejected") f.admission.renew.mockResolvedValue(false);
    if (mode === "lost")
      f.admission.renew.mockRejectedValue(new Error("synthetic renewal failure"));
    if (mode === "hung") f.admission.renew.mockReturnValue(pending.promise);
    const result = f.run(async () => {
      await admitBackendWork();
      await f.untilAbort();
      assertBackendWorkActive();
    });
    await vi.advanceTimersByTimeAsync(mode === "hung" ? 30_000 : 10_000);
    expect(await result).toMatchObject({ error: { code: "relay_overloaded" } });
    pending.resolve(true);
    await Promise.all(f.background);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.admission.renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

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

it("releases a late grant after caller cancellation without authorizing its continuation", async () => {
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
  grant.resolve(true);
  await Promise.all(f.background);
  expect(upstream).not.toHaveBeenCalled();
  expect(f.admission.release).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not acquire a permit for a fresh cache-only request", async () => {
  const f = fixture();
  expect(await f.run(async () => "cached")).toEqual({ value: "cached" });
  await Promise.all(f.background);
  expect(f.admission.acquire).not.toHaveBeenCalled();
  expect(f.admission.release).not.toHaveBeenCalled();
});
