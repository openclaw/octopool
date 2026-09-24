import { HttpError } from "./http";
import {
  policyCoordinatorStub,
  stringRewritePolicyUnavailable,
  type StringRewritePolicy,
} from "./policy-coordinator";
import { compileStringRewriteRules, invalidStringRewritePolicy } from "./string-rewrites";

export async function loadStringRewritePolicy(env: Env) {
  try {
    const policy = await (await getStringRewritePolicy(env)).json<StringRewritePolicy>();
    // RE2 instances cannot cross the DO boundary. Compile only this request's
    // authoritative snapshot; never retain policy in an isolate or edge cache.
    return { policy, compiled: compileStringRewriteRules(policy.rules) };
  } catch {
    throw stringRewritePolicyUnavailable();
  }
}

export function getStringRewritePolicy(env: Env): Promise<Response> {
  return policyRequest(new Request("https://policy/", { method: "GET" }), env);
}

export function putStringRewritePolicy(request: Request, env: Env): Promise<Response> {
  return policyRequest(request, env);
}

async function policyRequest(request: Request, env: Env): Promise<Response> {
  let response: Response;
  try {
    response = await policyCoordinatorStub(env).fetch(request);
    if (response.status === 200) {
      // Finish the bounded internal response in this request's lifetime. External
      // callers must not keep a DO invocation alive by leaving their body unread.
      return new Response(await response.arrayBuffer(), response);
    }
    await response.body?.cancel();
  } catch {
    // DO overload, eviction and transport failures must never authorize fallback.
    throw stringRewritePolicyUnavailable();
  }
  if (request.method === "PUT") {
    if (response.status === 400) throw invalidStringRewritePolicy();
    if (response.status === 409)
      throw new HttpError(
        409,
        "string_rewrite_revision_conflict",
        "String protection policy revision conflict",
      );
  }
  throw stringRewritePolicyUnavailable();
}
