import { errorResponse, logExpectedWorkerError, logUnexpectedWorkerError } from "./http";
import { runScheduledMaintenance } from "./maintenance";
import { PoolCoordinator } from "./pool-coordinator";
import { routeRequest } from "./router";
import { httpsRedirect, secureResponse } from "./security";
import { shouldUseWebError, webErrorResponse } from "./web-error";
import { withConfigCacheScope } from "./config-cache";
import { RelayTiming, withRelayTiming } from "./relay-timing";
import { withTimingBindings } from "./relay-timing-bindings";

export { PoolCoordinator };
export { PolicyCoordinator } from "./policy-coordinator";
export { BackendAdmission } from "./backend-admission";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const timing =
      request.method === "POST" && new URL(request.url).pathname === "/v1/github/request"
        ? new RelayTiming()
        : undefined;
    return withRelayTiming(timing, () =>
      fetchRequest(request, timing === undefined ? env : withTimingBindings(env), ctx, timing),
    );
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runScheduledMaintenance(env);
  },
};

async function fetchRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  timing?: RelayTiming,
): Promise<Response> {
  const ready = (response: Response) => timing?.responseReady(response) ?? response;
  const started = Date.now();
  const requestId = crypto.randomUUID();
  const redirect = httpsRedirect(request);
  if (redirect !== undefined) {
    return ready(redirect);
  }
  try {
    return ready(
      secureResponse(
        request,
        await withConfigCacheScope(() => routeRequest(request, env, ctx, requestId)),
      ),
    );
  } catch (error) {
    logExpectedWorkerError(request, requestId, error, started);
    logUnexpectedWorkerError(request, requestId, error);
    if (shouldUseWebError(request)) {
      return ready(secureResponse(request, webErrorResponse(error, requestId)));
    }
    return ready(secureResponse(request, errorResponse(error, requestId)));
  }
}
