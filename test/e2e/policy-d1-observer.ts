import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { policyCoordinatorStub } from "../../src/policy-coordinator";
import { observePublicationD1 } from "./publication-d1-observer";

// Observe/fault the production object's actual D1 calls, not the caller's binding.
// Setup evicts the fixed object before every test, discarding these injected hooks.
export async function observePolicyD1(hooks: Parameters<typeof observePublicationD1>[1]) {
  await runInDurableObject(policyCoordinatorStub(env), (instance) => {
    const internal = instance as unknown as { env: Env };
    internal.env = { ...internal.env, DB: observePublicationD1(internal.env.DB, hooks) };
  });
}
