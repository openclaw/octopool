import { errorResponse, logExpectedWorkerError, logUnexpectedWorkerError } from "./http";
import { runScheduledMaintenance } from "./maintenance";
import { PoolCoordinator } from "./pool-coordinator";
import { routeRequest } from "./router";
import { httpsRedirect, secureResponse } from "./security";
import { shouldUseWebError, webErrorResponse } from "./web-error";
import { withConfigCacheScope } from "./config-cache";

export { PoolCoordinator };
export { PolicyCoordinator } from "./policy-coordinator";
export { BackendAdmission } from "./backend-admission";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const redirect = httpsRedirect(request);
    if (redirect !== undefined) {
      return redirect;
    }
    try {
      return secureResponse(
        request,
        await withConfigCacheScope(() => routeRequest(request, env, ctx, requestId)),
      );
    } catch (error) {
      logExpectedWorkerError(request, requestId, error, started);
      logUnexpectedWorkerError(request, requestId, error);
      if (shouldUseWebError(request)) {
        return secureResponse(request, webErrorResponse(error, requestId));
      }
      return secureResponse(request, errorResponse(error, requestId));
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runScheduledMaintenance(env);
  },
};
