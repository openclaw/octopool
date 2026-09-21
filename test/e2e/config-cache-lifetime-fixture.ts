import { cachedConfigLookup, clearConfigCache } from "../../src/config-cache";

export async function configCacheLifetimeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "policy:abandoned-request-fixture";
  if (url.pathname.endsWith("/abandon")) {
    clearConfigCache();
    // Deliberately leave a never-settling lookup behind after this native request
    // ends. No I/O, timer, or test-owned resolver can keep its context alive.
    void cachedConfigLookup(key, () => new Promise<string>(() => {}));
    await Promise.resolve();
    return new Response("abandoned");
  }
  return new Response(await cachedConfigLookup(key, async () => "independent load"));
}
