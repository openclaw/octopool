import { hashToken } from "../../src/auth";
import type { RelayRequest, RouteInfo } from "../../src/types";

// Synthetic public/privileged views of GitHub's documented issue-event shapes:
// https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#cross-referenced
// https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#closed
// Visibility contract (private commits can close public issues without exposing details):
// https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-an-issues-only-repository
const actor = { login: "octocat", id: 1, html_url: "https://github.com/octocat" };
const created_at = "2026-08-01T12:00:00Z";
const publicIssue = {
  id: 42,
  number: 42,
  title: "Public issue",
  body: "Public **Markdown**.\r\n",
  state: "closed",
  url: "https://api.github.com/repos/openclaw/octopool/issues/42",
  html_url: "https://github.com/openclaw/octopool/issues/42",
  repository_url: "https://api.github.com/repos/openclaw/octopool",
};
const publicClosed = {
  id: 100,
  node_id: "synthetic-event-100",
  url: "https://api.github.com/repos/openclaw/octopool/issues/events/100",
  actor,
  event: "closed",
  commit_id: null,
  commit_url: null,
  created_at,
};
const privateClosed = {
  ...publicClosed,
  commit_id: "a".repeat(40),
  commit_url: `https://api.github.com/repos/acme/private-source/commits/${"a".repeat(40)}`,
};
const publicCrossReference = {
  actor,
  event: "cross-referenced",
  created_at,
  updated_at: created_at,
  source: {
    type: "issue",
    issue: {
      ...publicIssue,
      id: 43,
      number: 43,
      title: "Public follow-up",
      url: "https://api.github.com/repos/openclaw/octopool/issues/43",
      html_url: "https://github.com/openclaw/octopool/issues/43",
      repository: {
        full_name: "openclaw/octopool",
        html_url: "https://github.com/openclaw/octopool",
        private: false,
      },
    },
  },
};
const privateCrossReference = {
  ...publicCrossReference,
  source: {
    type: "issue",
    issue: {
      id: 7,
      number: 7,
      title: "PRIVATE cross-reference title",
      body: "PRIVATE incident details",
      state: "open",
      url: "https://api.github.com/repos/acme/private-source/issues/7",
      html_url: "https://github.com/acme/private-source/issues/7",
      repository_url: "https://api.github.com/repos/acme/private-source",
      repository: {
        full_name: "acme/private-source",
        html_url: "https://github.com/acme/private-source",
        private: true,
      },
    },
  },
};

// Cross-referenced source.issue belongs to timelines, not the issue-event REST schema.
export const issueEventCases = [
  {
    kind: "issue_timeline",
    path: "/repos/openclaw/octopool/issues/42/timeline",
    publicBody: [publicClosed, publicCrossReference],
    privilegedBody: [privateClosed, publicCrossReference, privateCrossReference],
  },
  {
    kind: "issue_events",
    path: "/repos/openclaw/octopool/issues/42/events",
    publicBody: [publicClosed],
    privilegedBody: [privateClosed],
  },
  {
    kind: "issue_event_list",
    path: "/repos/openclaw/octopool/issues/events",
    publicBody: [{ ...publicClosed, issue: publicIssue }],
    privilegedBody: [{ ...privateClosed, issue: publicIssue }],
  },
  {
    kind: "issue_event_view",
    path: "/repos/openclaw/octopool/issues/events/100",
    publicBody: { ...publicClosed, issue: publicIssue },
    privilegedBody: { ...privateClosed, issue: publicIssue },
  },
] as const;

// Frozen pre-fix key layout for default-query/default-JSON requests. Do not derive
// it from the current key function: old identity and anonymously revalidated rows matter.
export function legacyIssueEventKey(
  request: RelayRequest,
  route: RouteInfo,
  identity?: { kind: string; id: string },
  protocolEpoch?: string,
) {
  return hashToken(
    JSON.stringify({
      ...(protocolEpoch === undefined ? {} : { protocol_epoch: protocolEpoch }),
      pool: request.pool,
      method: request.method,
      path: request.path,
      query: {},
      headers: {},
      route_key: route.routeKey,
      ...(identity === undefined ? {} : { identity: `${identity.kind}:${identity.id}` }),
    }),
  );
}
