import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchMatchesGlob,
  gitAuthToken,
  handleGitRequest,
  parseGitRoute,
  parseReceivePackCommands,
  validatePushCommands,
} from "../src/git-proxy";
import { queries } from "../src/generated/sql";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const ZERO = "0".repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("git proxy policy helpers", () => {
  it("challenges unauthenticated git clients with Basic auth", async () => {
    const response = await handleGitRequest(
      new Request(
        "https://octopool.dev/git/openclaw/octopool.git/info/refs?service=git-upload-pack",
      ),
      {} as Env,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="octopool"');
  });

  it("extracts bearer and basic octopool tokens", () => {
    expect(
      gitAuthToken(
        new Request("https://octopool.dev/git/o/r.git/info/refs", {
          headers: { authorization: "Bearer op_token" },
        }),
      ),
    ).toBe("op_token");
    expect(
      gitAuthToken(
        new Request("https://octopool.dev/git/o/r.git/info/refs", {
          headers: { authorization: `Basic ${btoa("agent:op_basic")}` },
        }),
      ),
    ).toBe("op_basic");
  });

  it("classifies supported git smart-http routes", () => {
    expect(
      parseGitRoute(
        new URL("https://octopool.dev/git/openclaw/octopool.git/info/refs?service=git-upload-pack"),
        "GET",
      ),
    ).toMatchObject({ owner: "openclaw", repo: "octopool", operation: "fetch" });
    expect(
      parseGitRoute(
        new URL("https://octopool.dev/git/openclaw/octopool.git/git-receive-pack"),
        "POST",
      ),
    ).toMatchObject({ owner: "openclaw", repo: "octopool", operation: "push" });
    expect(
      parseGitRoute(new URL("https://octopool.dev/openclaw/octopool.git"), "GET"),
    ).toBeUndefined();
  });

  it("matches branch globs as anchored branch-name patterns", () => {
    expect(branchMatchesGlob("agent/task", "agent/*")).toBe(true);
    expect(branchMatchesGlob("nested/agent/task", "agent/*")).toBe(false);
    expect(branchMatchesGlob("main", "main")).toBe(true);
    expect(branchMatchesGlob("main-old", "main")).toBe(false);
  });

  it("parses receive-pack commands before the pack body", () => {
    const bytes = receivePack([
      `${OLD} ${NEW} refs/heads/agent/task\0 report-status side-band-64k\n`,
      `${OLD} ${NEW} refs/heads/agent/other\n`,
    ]);
    const parsed = parseReceivePackCommands(bytes);

    expect(parsed.commands).toEqual([
      { oldOid: OLD, newOid: NEW, ref: "refs/heads/agent/task" },
      { oldOid: OLD, newOid: NEW, ref: "refs/heads/agent/other" },
    ]);
    expect(parsed.prefixLength).toBeLessThan(bytes.byteLength);
  });

  it("denies disallowed push refs", () => {
    const policy = { allowFetch: true, allowPush: true, pushBranchGlobs: ["agent/*"] };
    expect(() =>
      validatePushCommands([{ oldOid: OLD, newOid: NEW, ref: "refs/heads/agent/task" }], policy),
    ).not.toThrow();
    expect(() =>
      validatePushCommands([{ oldOid: OLD, newOid: NEW, ref: "refs/heads/main" }], policy),
    ).toThrow(/not allowed/);
    expect(() =>
      validatePushCommands([{ oldOid: OLD, newOid: NEW, ref: "refs/tags/v1" }], policy),
    ).toThrow(/Only branch/);
    expect(() =>
      validatePushCommands([{ oldOid: OLD, newOid: ZERO, ref: "refs/heads/agent/task" }], policy),
    ).toThrow(/deletes/);
  });

  it("proxies allowed fetches with GitHub App credentials", async () => {
    const secretRef = "APP_KEY_FETCH";
    const env = await gitEnv({
      secretRef,
      fetch: true,
      push: false,
      branches: [],
    });
    const fetchMock = vi.fn(async (input: Request | string, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : input;
      if (request.url.includes("/app/installations/123/access_tokens")) {
        expect(request.headers.get("authorization")).not.toContain("op_agent");
        return Response.json({
          token: "ghs_app_fetch",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      expect(request.url).toBe(
        "https://github.com/openclaw/octopool.git/info/refs?service=git-upload-pack",
      );
      expect(atob(request.headers.get("authorization")?.replace(/^Basic\s+/i, "") ?? "")).toBe(
        "x-access-token:ghs_app_fetch",
      );
      return new Response("refs", {
        status: 200,
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleGitRequest(
      gitRequest(
        "https://octopool.dev/git/openclaw/octopool.git/info/refs?service=git-upload-pack",
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("refs");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects disallowed branch pushes before forwarding to GitHub", async () => {
    const env = await gitEnv({
      secretRef: "APP_KEY_PUSH_DENIED",
      fetch: true,
      push: true,
      branches: ["agent/*"],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      handleGitRequest(
        gitRequest("https://octopool.dev/git/openclaw/octopool.git/git-receive-pack", {
          method: "POST",
          body: receivePack([`${OLD} ${NEW} refs/heads/main\0 report-status\n`]),
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403, code: "git_push_denied" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function receivePack(lines: string[]): Uint8Array {
  const encoded = new TextEncoder();
  const parts = [
    ...lines.map((line) => {
      const payload = encoded.encode(line);
      const length = (payload.byteLength + 4).toString(16).padStart(4, "0");
      const out = new Uint8Array(4 + payload.byteLength);
      out.set(encoded.encode(length), 0);
      out.set(payload, 4);
      return out;
    }),
    encoded.encode("0000PACK"),
  ];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function gitRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Basic ${btoa("agent:op_agent")}`);
  return new Request(url, { ...init, headers });
}

async function gitEnv(input: {
  secretRef: string;
  fetch: boolean;
  push: boolean;
  branches: string[];
}): Promise<Env> {
  const privateKey = await testPrivateKeyPEM();
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => {
        if (sql === queries.authenticateCaller) {
          return {
            id: "caller_1",
            name: "Agent",
            github_login: "agent",
            org_login: "openclaw",
            org_verified_at: new Date(Date.now() + 3_600_000).toISOString(),
          };
        }
        if (sql === queries.getCallerGitPolicy) {
          return {
            allow_fetch: input.fetch ? 1 : 0,
            allow_push: input.push ? 1 : 0,
            push_branch_globs_json: JSON.stringify(input.branches),
            expires_at: null,
          };
        }
        return null;
      }),
      all: vi.fn(async () => {
        if (sql === queries.listActiveIdentitiesForRoute) {
          return {
            results: [
              {
                id: "ghapp_1",
                kind: "github_app",
                login: "octopool-app",
                secret_ref: input.secretRef,
                installation_id: 123,
                weight: 100,
              },
            ],
          };
        }
        return { results: [] };
      }),
      run: vi.fn(async () => undefined),
    };
    return statement;
  });
  return {
    DB: { prepare },
    ALLOWED_GITHUB_ORG: "openclaw",
    DEFAULT_ALLOWED_OWNERS: "openclaw",
    DEFAULT_LOGIN_POOL: "maintainers",
    REQUEST_TIMEOUT_MS: "15000",
    OCTOPOOL_GITHUB_APP_ID: "12345",
    [input.secretRef]: privateKey,
  } as unknown as Env;
}

async function testPrivateKeyPEM(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(exported as ArrayBuffer)));
  return `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)?.join("\n") ?? base64}\n-----END PRIVATE KEY-----`;
}
