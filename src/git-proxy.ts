import { authenticateCallerToken, envSecret } from "./auth";
import { loadIdentities } from "./db";
import { githubToken } from "./github";
import { HttpError, isObject, jsonResponse, requireString } from "./http";
import { queries } from "./generated/sql";
import type { Caller, Identity, RouteInfo } from "./types";

type GitOperation = "fetch" | "push";

type GitRoute = {
  owner: string;
  repo: string;
  upstreamPath: string;
  operation: GitOperation;
};

type GitPolicy = {
  allowFetch: boolean;
  allowPush: boolean;
  pushBranchGlobs: string[];
};

type ReceivePackCommand = {
  oldOid: string;
  newOid: string;
  ref: string;
};

const ZERO_OID = "0000000000000000000000000000000000000000";
const MAX_RECEIVE_PACK_COMMAND_BYTES = 65_536;

export async function handleGitRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = parseGitRoute(url, request.method);
  if (route === undefined) {
    throw new HttpError(404, "not_found", "Route not found");
  }
  const token = gitAuthToken(request);
  if (token === undefined) {
    return gitAuthChallenge();
  }
  const pool = gitPool(env);
  const caller = await authenticateCallerToken(token, env, pool);
  const policy = await loadGitPolicy(env, caller, pool, route.owner, route.repo);
  authorizeGitOperation(policy, route.operation);

  const identity = await selectGitHubAppIdentity(env, pool, route);
  const upstreamRequest = await buildUpstreamGitRequest(request, env, identity, route, policy);
  const response = await fetch(upstreamRequest);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: gitResponseHeaders(response.headers),
  });
}

export async function upsertGitPolicy(request: Request, env: Env, pool: string): Promise<Response> {
  const body = await request.json().catch(() => undefined);
  if (!isObject(body)) {
    throw new HttpError(400, "invalid_json", "Expected a JSON object");
  }
  const githubLogin = requireString(body.github_login, "github_login");
  const repo = parseRepoName(requireString(body.repo, "repo"));
  const caller = await env.DB.prepare(queries.findCallerForGitPolicy)
    .bind(githubLogin, env.ALLOWED_GITHUB_ORG, pool)
    .first<{ id: string; github_login: string }>();
  if (caller === null) {
    throw new HttpError(404, "caller_not_found", "Caller is not provisioned for this pool");
  }
  const allowFetch = body.fetch === true ? 1 : 0;
  const allowPush = body.push === true ? 1 : 0;
  const pushBranches = parseBranchGlobs(body.push_branches);
  const expiresAt =
    typeof body.expires_at === "string" && body.expires_at.trim() !== ""
      ? body.expires_at.trim()
      : null;
  if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) {
    throw new HttpError(400, "expires_at_invalid", "expires_at must be an ISO timestamp");
  }
  await env.DB.prepare(queries.upsertCallerGitPolicy)
    .bind(
      caller.id,
      pool,
      repo.owner,
      repo.repo,
      allowFetch,
      allowPush,
      JSON.stringify(pushBranches),
      expiresAt,
    )
    .run();
  return jsonResponse(
    {
      git_policy: {
        github_login: caller.github_login,
        pool,
        repo: `${repo.owner}/${repo.repo}`,
        fetch: allowFetch === 1,
        push: allowPush === 1,
        push_branches: pushBranches,
        expires_at: expiresAt,
      },
    },
    201,
  );
}

export async function deleteGitPolicy(request: Request, env: Env, pool: string): Promise<Response> {
  const url = new URL(request.url);
  const githubLogin = url.searchParams.get("github_login")?.trim();
  const repoParam = url.searchParams.get("repo")?.trim();
  if (githubLogin === undefined || githubLogin === "") {
    throw new HttpError(400, "invalid_request", "github_login query parameter is required");
  }
  if (repoParam === undefined || repoParam === "") {
    throw new HttpError(400, "invalid_request", "repo query parameter is required");
  }
  const repo = parseRepoName(repoParam);
  const caller = await env.DB.prepare(queries.findCallerForGitPolicy)
    .bind(githubLogin, env.ALLOWED_GITHUB_ORG, pool)
    .first<{ id: string }>();
  if (caller === null) {
    throw new HttpError(404, "caller_not_found", "Caller is not provisioned for this pool");
  }
  await env.DB.prepare(queries.deleteCallerGitPolicy)
    .bind(caller.id, pool, repo.owner, repo.repo)
    .run();
  return jsonResponse({ deleted: true });
}

export function parseGitRoute(url: URL, method: string): GitRoute | undefined {
  const match =
    /^\/git\/(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)\.git\/(?<tail>.+)$/.exec(
      url.pathname,
    );
  if (match?.groups === undefined) {
    return undefined;
  }
  const { owner, repo, tail } = match.groups;
  if (owner === undefined || repo === undefined || tail === undefined) {
    return undefined;
  }
  if (method === "GET" && tail === "info/refs") {
    const service = url.searchParams.get("service");
    if (service === "git-upload-pack") {
      return { owner, repo, upstreamPath: `${owner}/${repo}.git/info/refs`, operation: "fetch" };
    }
    if (service === "git-receive-pack") {
      return { owner, repo, upstreamPath: `${owner}/${repo}.git/info/refs`, operation: "push" };
    }
    return undefined;
  }
  if (method === "POST" && tail === "git-upload-pack") {
    return {
      owner,
      repo,
      upstreamPath: `${owner}/${repo}.git/git-upload-pack`,
      operation: "fetch",
    };
  }
  if (method === "POST" && tail === "git-receive-pack") {
    return {
      owner,
      repo,
      upstreamPath: `${owner}/${repo}.git/git-receive-pack`,
      operation: "push",
    };
  }
  return undefined;
}

export function gitAuthToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer?.[1] !== undefined && bearer[1].trim() !== "") {
    return bearer[1].trim();
  }
  const basic = /^Basic\s+(.+)$/i.exec(authorization);
  if (basic?.[1] === undefined) {
    return undefined;
  }
  let decoded = "";
  try {
    decoded = atob(basic[1]);
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return undefined;
  }
  const password = decoded.slice(separator + 1).trim();
  return password === "" ? undefined : password;
}

export function branchMatchesGlob(branch: string, glob: string): boolean {
  if (glob === "") {
    return false;
  }
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(branch);
}

export function parseReceivePackCommands(input: Uint8Array): {
  commands: ReceivePackCommand[];
  prefixLength: number;
} {
  const commands: ReceivePackCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > input.length) {
      throw new HttpError(
        400,
        "git_receive_pack_invalid",
        "Receive-pack command list is incomplete",
      );
    }
    const lengthText = ascii(input.subarray(offset, offset + 4));
    if (lengthText === "0000") {
      return { commands, prefixLength: offset + 4 };
    }
    const length = Number.parseInt(lengthText, 16);
    if (!Number.isFinite(length) || length < 4) {
      throw new HttpError(
        400,
        "git_receive_pack_invalid",
        "Receive-pack pkt-line length is invalid",
      );
    }
    if (offset + length > input.length) {
      throw new HttpError(
        400,
        "git_receive_pack_invalid",
        "Receive-pack command pkt-line is incomplete",
      );
    }
    const payload = ascii(input.subarray(offset + 4, offset + length));
    const commandText = commands.length === 0 ? (payload.split("\0", 1)[0] ?? "") : payload;
    const fields = commandText.trimEnd().split(" ");
    if (fields.length < 3) {
      throw new HttpError(400, "git_receive_pack_invalid", "Receive-pack command is invalid");
    }
    const [oldOid, newOid, ref] = fields;
    if (!validOid(oldOid) || !validOid(newOid) || ref === undefined || ref === "") {
      throw new HttpError(400, "git_receive_pack_invalid", "Receive-pack command is invalid");
    }
    commands.push({ oldOid, newOid, ref });
    offset += length;
  }
}

export function validatePushCommands(commands: ReceivePackCommand[], policy: GitPolicy): void {
  for (const command of commands) {
    if (command.newOid === ZERO_OID) {
      throw new HttpError(403, "git_push_denied", "Branch deletes are not enabled");
    }
    if (!command.ref.startsWith("refs/heads/")) {
      throw new HttpError(403, "git_push_denied", "Only branch pushes are enabled");
    }
    const branch = command.ref.slice("refs/heads/".length);
    if (!policy.pushBranchGlobs.some((glob) => branchMatchesGlob(branch, glob))) {
      throw new HttpError(403, "git_push_denied", `Branch ${branch} is not allowed`);
    }
  }
}

async function buildUpstreamGitRequest(
  request: Request,
  env: Env,
  identity: Identity,
  route: GitRoute,
  policy: GitPolicy,
): Promise<Request> {
  const upstreamUrl = new URL(`https://github.com/${route.upstreamPath}`);
  const inputUrl = new URL(request.url);
  if (route.upstreamPath.endsWith("/info/refs")) {
    upstreamUrl.search = inputUrl.search;
  }
  const headers = new Headers();
  for (const key of ["accept", "content-type", "git-protocol", "user-agent"]) {
    const value = request.headers.get(key);
    if (value !== null) {
      headers.set(key, value);
    }
  }
  const body =
    route.operation === "push" && request.method === "POST"
      ? await validatedReceivePackBody(request, policy)
      : request.body;
  const appToken = await githubToken(env, identity);
  headers.set("authorization", `Basic ${btoa(`x-access-token:${appToken}`)}`);
  return new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
}

async function validatedReceivePackBody(
  request: Request,
  policy: GitPolicy,
): Promise<ReadableStream<Uint8Array> | null> {
  if (request.body === null) {
    throw new HttpError(400, "git_receive_pack_invalid", "Receive-pack body is required");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      throw new HttpError(
        400,
        "git_receive_pack_invalid",
        "Receive-pack command list is incomplete",
      );
    }
    if (value !== undefined) {
      total += value.byteLength;
      chunks.push(value);
      const buffered = concat(chunks, total);
      try {
        const parsed = parseReceivePackCommands(buffered);
        validatePushCommands(parsed.commands, policy);
        return streamBufferedThenReader(chunks, reader);
      } catch (error) {
        if (
          error instanceof HttpError &&
          error.code === "git_receive_pack_invalid" &&
          error.message.includes("incomplete")
        ) {
          if (total > MAX_RECEIVE_PACK_COMMAND_BYTES) {
            await reader.cancel();
            throw new HttpError(
              400,
              "git_receive_pack_invalid",
              "Receive-pack command list is too large",
            );
          }
          continue;
        }
        await reader.cancel();
        throw error;
      }
    }
  }
}

function streamBufferedThenReader(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value !== undefined) {
            controller.enqueue(value);
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

async function loadGitPolicy(
  env: Env,
  caller: Caller,
  pool: string,
  owner: string,
  repo: string,
): Promise<GitPolicy> {
  const row = await env.DB.prepare(queries.getCallerGitPolicy)
    .bind(caller.id, pool, owner, repo)
    .first<{
      allow_fetch: number;
      allow_push: number;
      push_branch_globs_json: string;
      expires_at: string | null;
    }>();
  if (row === null) {
    throw new HttpError(403, "git_policy_denied", "Git access is not enabled for this caller");
  }
  return {
    allowFetch: row.allow_fetch === 1,
    allowPush: row.allow_push === 1,
    pushBranchGlobs: parseStoredBranchGlobs(row.push_branch_globs_json),
  };
}

function authorizeGitOperation(policy: GitPolicy, operation: GitOperation): void {
  if (operation === "fetch" && !policy.allowFetch) {
    throw new HttpError(403, "git_fetch_denied", "Git fetch is not enabled for this caller");
  }
  if (operation === "push" && !policy.allowPush) {
    throw new HttpError(403, "git_push_denied", "Git push is not enabled for this caller");
  }
}

async function selectGitHubAppIdentity(env: Env, pool: string, route: GitRoute): Promise<Identity> {
  const candidates = await loadIdentities(env, pool, {
    kind: "git",
    owner: route.owner.toLowerCase(),
    repo: route.repo,
    resource: "core",
    routeKey: `GIT ${route.owner}/${route.repo}`,
    cacheable: false,
    largePayload: true,
    logs: false,
  } satisfies RouteInfo);
  const app = candidates
    .filter((identity) => identity.kind === "github_app")
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))[0];
  if (app === undefined) {
    throw new HttpError(
      503,
      "no_git_identity",
      "No active GitHub App identity can serve this repo",
    );
  }
  return app;
}

function gitResponseHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of input) {
    const lower = key.toLowerCase();
    if (lower === "set-cookie" || lower === "www-authenticate") {
      continue;
    }
    headers.set(key, value);
  }
  headers.set("cache-control", "no-store");
  return headers;
}

function gitAuthChallenge(): Response {
  return new Response("Git authentication required\n", {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="octopool"',
    },
  });
}

function gitPool(env: Env): string {
  const configured = envSecret(env, "DEFAULT_LOGIN_POOL");
  return configured === undefined || configured.trim() === "" ? "maintainers" : configured.trim();
}

function parseRepoName(value: string): { owner: string; repo: string } {
  const match = /^(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)$/.exec(value);
  if (match?.groups?.owner === undefined || match.groups.repo === undefined) {
    throw new HttpError(400, "repo_invalid", "repo must be owner/repo");
  }
  return { owner: match.groups.owner.toLowerCase(), repo: match.groups.repo };
}

function parseBranchGlobs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "" && !item.startsWith("/") && !item.includes(".."));
}

function parseStoredBranchGlobs(value: string): string[] {
  try {
    return parseBranchGlobs(JSON.parse(value));
  } catch {
    return [];
  }
}

function validOid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{40,64}$/.test(value);
}

function ascii(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
