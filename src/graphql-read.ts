import {
  Kind,
  parse,
  print,
  visit,
  type FieldNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import { HttpError } from "./http";
import { isRecord } from "./object";
import type { GitHubRelayResponse } from "./types";

export type GraphQLRead = {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
  owner: string;
  repo: string;
};

const MAX_BYTES = 16_384;
const MAX_DEPTH = 12;

function denied(): HttpError {
  return new HttpError(403, "route_denied", "GraphQL document is not an eligible repository read");
}

// This is defense in depth. Only a verified single-repository, read-only App
// token may execute the result: nested traversals are not confined by this AST.
export function parseGraphQLRead(value: unknown): GraphQLRead {
  if (
    !isRecord(value) ||
    typeof value.query !== "string" ||
    new TextEncoder().encode(value.query).length > MAX_BYTES
  )
    throw denied();
  const variables = value.variables ?? {};
  if (!isRecord(variables)) throw denied();
  validateVariables(variables);
  if (new TextEncoder().encode(JSON.stringify(variables)).length > MAX_BYTES) throw denied();
  let document;
  try {
    document = parse(value.query, { maxTokens: 4_000 });
  } catch {
    throw denied();
  }
  const operations = document.definitions.filter((node) => node.kind === Kind.OPERATION_DEFINITION);
  const operation = operations[0];
  if (operations.length !== 1 || operation?.operation !== "query") throw denied();
  if (
    value.operationName !== undefined &&
    (typeof value.operationName !== "string" || value.operationName !== operation.name?.value)
  )
    throw denied();
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const node of document.definitions) {
    if (node.kind === Kind.FRAGMENT_DEFINITION) {
      if (fragments.has(node.name.value)) throw denied();
      fragments.set(node.name.value, node);
    } else if (node.kind !== Kind.OPERATION_DEFINITION) throw denied();
  }
  visit(document, {
    Field(node) {
      if (
        node.name.value.startsWith("viewer") ||
        node.name.value === "__schema" ||
        node.name.value === "__type"
      )
        throw denied();
    },
    Directive(node) {
      if (node.name.value !== "include" && node.name.value !== "skip") throw denied();
    },
    FragmentSpread(node) {
      if (!fragments.has(node.name.value)) throw denied();
    },
  });
  const roots: FieldNode[] = [];
  let expanded = 0;
  const walk = (
    set: SelectionSetNode,
    depth: number,
    stack: Set<string>,
    collectRoots: boolean,
  ): void => {
    if (depth > MAX_DEPTH) throw denied();
    for (const node of set.selections) {
      if (++expanded > 4_000) throw denied();
      if (node.kind === Kind.FIELD) {
        if (collectRoots) roots.push(node);
        if (node.selectionSet !== undefined) walk(node.selectionSet, depth + 1, stack, false);
      } else if (node.kind === Kind.INLINE_FRAGMENT) {
        walk(node.selectionSet, depth, stack, collectRoots);
      } else {
        const name = node.name.value;
        if (stack.has(name)) throw denied();
        walk(fragments.get(name)!.selectionSet, depth, new Set([...stack, name]), collectRoots);
      }
    }
  };
  walk(operation.selectionSet, 1, new Set(), true);
  // Check unused fragments too, including cycles and expansion/depth limits.
  for (const [name, fragment] of fragments) walk(fragment.selectionSet, 1, new Set([name]), false);
  const repositories = roots.filter((node) => node.name.value !== "__typename");
  if (repositories.length === 0) throw denied();
  const textArgument = (node: FieldNode, name: string): string => {
    const args = node.arguments ?? [];
    if (args.length !== 2 || new Set(args.map((arg) => arg.name.value)).size !== 2) throw denied();
    const arg = args.find((item) => item.name.value === name)?.value;
    const text =
      arg?.kind === Kind.STRING
        ? arg.value
        : arg?.kind === Kind.VARIABLE && Object.hasOwn(variables, arg.name.value)
          ? variables[arg.name.value]
          : undefined;
    if (
      typeof text !== "string" ||
      !/^[A-Za-z0-9_.-]+$/.test(text) ||
      text === "." ||
      text === ".." ||
      text.length > 100
    )
      throw denied();
    return text.toLowerCase();
  };
  const owner = textArgument(repositories[0]!, "owner");
  const repo = textArgument(repositories[0]!, "name");
  // Every alias shares the one public repository verified by the scoped token mint.
  for (const node of repositories) {
    if (
      node.name.value !== "repository" ||
      textArgument(node, "owner") !== owner ||
      textArgument(node, "name") !== repo
    )
      throw denied();
  }
  return {
    query: print(document),
    variables,
    ...(typeof value.operationName === "string" ? { operationName: value.operationName } : {}),
    owner,
    repo,
  };
}

function validateVariables(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw denied();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) validateVariables(item, depth + 1);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) validateVariables(item, depth + 1);
  } else throw denied();
}

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
