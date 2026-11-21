import { isRecord } from "./object";
import type { GitHubRelayResponse } from "./types";

export type GraphQLRead = {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
  owner: string;
  repo: string;
};

export function graphQLReadBody(read: GraphQLRead): Record<string, unknown> {
  return {
    query: read.query,
    variables: read.variables,
    ...(read.operationName === undefined ? {} : { operationName: read.operationName }),
  };
}

export function graphQLReadCacheable(response: GitHubRelayResponse): boolean {
  if (
    response.status !== 200 ||
    response.body_encoding !== "text" ||
    typeof response.body !== "string"
  )
    return false;
  try {
    const body: unknown = JSON.parse(response.body);
    return isRecord(body) && !Object.hasOwn(body, "errors") && isRecord(body.data);
  } catch {
    return false;
  }
}

export function stableGraphQLVariables(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableGraphQLVariables);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableGraphQLVariables(value[key])]),
    );
  return value;
}
