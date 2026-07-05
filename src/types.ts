import type { RouteKind } from "./route-manifest";

export type JsonObject = Record<string, unknown>;

export type RelayRequest = {
  pool: string;
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  route_hint?: {
    pr_head_sha?: string;
    pr_state?: string;
  };
};

export type PoolPolicy = {
  allowed_owners: string[];
  allow_public_repos: boolean;
  allow_search: boolean;
  allow_logs: boolean;
};

export type Caller = {
  id: string;
  name: string;
  github_login: string;
  org_login: string;
  org_verified_at: string | null;
  caller_token_id: string;
  client_name: string;
};

export type WebSession = Caller & {
  dashboard_role: "none" | "admin";
  expires_at: string;
};

export type Identity = {
  id: string;
  kind: "pat" | "github_app";
  login: string;
  secret_ref: string;
  installation_id: number | null;
  weight: number;
};

export type RouteInfo = {
  kind: RouteKind;
  owner?: string;
  repo?: string;
  publicOnly: boolean;
  resource: string;
  routeKey: string;
  state_hint?: string;
  state_hint_source?: "cached" | "live";
  cacheable: boolean;
  largePayload: boolean;
  fullResponseCap: boolean;
  logs: boolean;
};

export type GitHubRelayResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_encoding?: "json" | "text" | "base64";
  backend?: "github" | "web";
};

export type SelectionCandidate = {
  id: string;
  weight: number;
};

export type SelectionRequest = {
  pool: string;
  routeKey: string;
  resource: string;
  candidates: SelectionCandidate[];
};

export type SelectionResult = {
  identityId: string;
  reason: "highest_remaining" | "sticky" | "fallback";
  leaseTtlSeconds: number;
};

export type RecordResult = {
  identityId: string;
  routeKey: string;
  resource: string;
  status: number;
  rate?: {
    limit?: number;
    remaining?: number;
    resetAt?: number;
    retryAfter?: number;
  };
};

export type CoordinatorSnapshot = {
  rates: {
    identity_id: string;
    resource: string;
    limit_count: number;
    remaining: number;
    reset_at: number;
  }[];
  cooldowns: {
    identity_id: string;
    route_key: string;
    status: number;
    reason: string;
    expires_at: number;
  }[];
  leases: {
    route_key: string;
    identity_id: string;
    expires_at: number;
  }[];
};
