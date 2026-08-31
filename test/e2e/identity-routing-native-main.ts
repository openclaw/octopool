import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";

export { PoolCoordinator } from "../../src/pool-coordinator";

// This protocol negative needs a native request lifetime around the real relay.
// The ordinary test setup still owns storage reset and graceful DO eviction.
export default {
  ...worker,
  async fetch(request: Request, env: Env, native: ExecutionContext): Promise<Response> {
    if (request.headers.get("x-test-identity-protocol") !== "missing-method") {
      return worker.fetch(request, env, native);
    }
    let calls = 0;
    const namespace = new Proxy(env.POOL_COORDINATOR, {
      get(target, key) {
        if (key === "get")
          return (...args: Parameters<typeof target.get>) => {
            const stub = target.get(...args);
            return new Proxy(stub, {
              get(real, method) {
                if (method === "recordCredentialFailure")
                  return async () => {
                    calls++;
                    await (
                      real as unknown as { absentCredentialFailure(): Promise<void> }
                    ).absentCredentialFailure();
                  };
                const value = Reflect.get(real, method, real);
                return typeof value === "function"
                  ? (...values: unknown[]) => Reflect.apply(value, real, values)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = createExecutionContext();
    const waitUntil = ctx.waitUntil.bind(ctx);
    let registered = 0;
    let settled = 0;
    ctx.waitUntil = (promise) => {
      registered++;
      const observed = promise.finally(() => {
        settled++;
      });
      native.waitUntil(observed);
      waitUntil(observed);
    };
    let response!: Response;
    const errors: unknown[] = [];
    try {
      response = await worker.fetch(
        request,
        { ...env, TEST_PAT_PRIMARY: undefined, POOL_COORDINATOR: namespace } as Env,
        ctx,
      );
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await waitOnExecutionContext(ctx);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Native protocol request drain failed");
    const body = await response.text();
    const headers = new Headers(response.headers);
    headers.set("x-test-feedback-calls", String(calls));
    headers.set("x-test-background-registered", String(registered));
    headers.set("x-test-background-settled", String(settled));
    return new Response(body, { status: response.status, headers });
  },
};
