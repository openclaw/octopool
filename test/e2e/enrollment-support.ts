import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { callWarmWorker, jsonResponse, orgMembershipResponse } from "./harness";
import { ownedWork } from "./owned-work";

export type Enrollment = {
  caller: {
    id: string;
    name: string;
    github_login: string;
    org_login: string;
    client_name: string;
  };
  token: string;
};

export function mockEnrollmentAccount(id = 101, login = "enrollment-user"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === "/graphql") return orgMembershipResponse(true, id);
      if (path === "/user" || path === `/users/${login}`) return jsonResponse({ id, login });
      if (path === "/login/oauth/access_token")
        return jsonResponse({ access_token: "synthetic-oauth" });
      throw new Error(`Unexpected synthetic GitHub request: ${path}`);
    }),
  );
}

export function loginClient(clientName: string): Promise<Response> {
  return callWarmWorker("/v1/login/github-cli", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ github_token: "synthetic-github", client_name: clientName }),
  });
}

// Only scheduling is intercepted. Every prepared statement and result belongs
// to real D1, including the old implementation's pre-batch lookup misses.
export async function concurrentEnrollments(
  requests: (() => Promise<Response>)[],
): Promise<Response[]> {
  const batch = env.DB.batch.bind(env.DB);
  const gate = ownedWork.gate();
  let arrived = 0;
  const spy = vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
    if (++arrived === requests.length) gate.release();
    await gate.promise;
    return batch(statements);
  });
  const pending = requests.map((request) => request());
  try {
    return await Promise.all(pending);
  } finally {
    gate.release();
    await Promise.allSettled(pending);
    spy.mockRestore();
  }
}
