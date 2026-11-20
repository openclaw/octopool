import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { githubToken } from "../src/github-auth";
import { withGitHubEgress } from "../src/github-egress";
import type { Identity } from "../src/types";

let privateKey: string;
let installationId = 96000;

beforeAll(async () => {
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
  const bytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(new Uint8Array(bytes as ArrayBuffer)).toString("base64")}\n-----END PRIVATE KEY-----`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function appCredentials() {
  const identity: Identity = {
    id: "app",
    kind: "github_app",
    login: "app",
    secret_ref: "TEST_APP_KEY",
    installation_id: ++installationId,
    weight: 100,
  };
  const env = withGitHubEgress(
    { TEST_APP_KEY: privateKey, OCTOPOOL_GITHUB_APP_ID: "7" } as unknown as Env,
    [],
  );
  return { identity, env };
}

function validBody() {
  return {
    token: "installation-token",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe("GitHub App installation token responses", () => {
  it.each([512, 513])(
    "enforces the byte cap for a streamed %i-byte token response",
    async (size) => {
      const { env, identity } = appCredentials();
      const body = { ...validBody(), metadata: "é" };
      const json = JSON.stringify(body);
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          ...body,
          metadata: body.metadata + "x".repeat(size - new TextEncoder().encode(json).byteLength),
        }),
      );
      expect(bytes.byteLength).toBe(size);
      const cancel = vi.fn();
      let sent = false;
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (sent) controller.close();
              else {
                sent = true;
                controller.enqueue(bytes);
              }
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      );
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(Response.json(validBody()));
      vi.stubGlobal("fetch", fetchMock);
      const cappedEnv = { ...env, MAX_RESPONSE_BYTES: "512" } as unknown as typeof env;

      if (size > 512) {
        await expect(githubToken(cappedEnv, identity)).rejects.toMatchObject({
          status: 502,
          code: "github_app_token_failed",
        });
        expect(cancel).toHaveBeenCalledOnce();
      }
      await expect(githubToken(cappedEnv, identity)).resolves.toBe("installation-token");
      await expect(githubToken(cappedEnv, identity)).resolves.toBe("installation-token");
      expect(fetchMock).toHaveBeenCalledTimes(size > 512 ? 2 : 1);
    },
  );

  it.each([
    ["invalid JSON", () => new Response("{")],
    ["null", () => Response.json(null)],
    ["array", () => Response.json([])],
    ["primitive", () => Response.json("token")],
    ["missing token", () => Response.json({ expires_at: validBody().expires_at })],
    ["empty token", () => Response.json({ ...validBody(), token: "" })],
    ["blank token", () => Response.json({ ...validBody(), token: " \t\n" })],
    ["missing expiry", () => Response.json({ token: "installation-token" })],
    ["invalid expiry", () => Response.json({ ...validBody(), expires_at: "invalid" })],
    [
      "expired token",
      () =>
        Response.json({ ...validBody(), expires_at: new Date(Date.now() - 60_000).toISOString() }),
    ],
  ])("rejects %s without caching it", async (_name, response) => {
    const { env, identity } = appCredentials();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(Response.json(validBody()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubToken(env, identity)).rejects.toMatchObject({
      status: 502,
      code: "github_app_token_failed",
    });
    await expect(githubToken(env, identity)).resolves.toBe("installation-token");
    await expect(githubToken(env, identity)).resolves.toBe("installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns and reuses a valid unexpired token", async () => {
    const { env, identity } = appCredentials();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(validBody()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(githubToken(env, identity)).resolves.toBe("installation-token");
    await expect(githubToken(env, identity)).resolves.toBe("installation-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/app/installations/${identity.installation_id}/access_tokens`,
    );
  });
});
