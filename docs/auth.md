# Auth & Org Membership

Octopool has four auth surfaces: caller auth for relay traffic, admin auth for
provisioning, the GitHub-CLI login exchange that mints caller tokens, and website
sessions for `/dashboard`. All of them are pinned to a single allowed GitHub org
(`ALLOWED_GITHUB_ORG`, `openclaw`).

Source: `src/auth.ts`, `src/callers.ts`, `src/web-session.ts`, `src/provisioning.ts`,
`src/router.ts`.

## Caller auth

Relay and health requests send `Authorization: Bearer <octopool_caller_token>`.

- The token is hashed (SHA-256, base64url) and matched against `caller_tokens.token_hash`.
  Raw tokens are never stored. Each caller can hold one rotating token per named client,
  capped at 16 active clients; a new name retires the least recently updated stale session.
- The caller must be `active` and granted the requested pool (`caller_pools`).
- The caller's `org_login` must equal `ALLOWED_GITHUB_ORG`, else `403 org_denied`.
- Org membership is re-verified on use once it goes stale (`ORG_VERIFY_TTL_SECONDS`,
  default 24h), using the org verifier token. Every verification page must resolve the
  enrolled immutable `github_user_id`; a matching organization on a replacement account
  cannot refresh the caller. A member who leaves the org loses access at the next check.

A missing/invalid token returns `401`; a valid token without the pool grant returns
`401 invalid_auth`.

## Admin auth

Admin endpoints (`/v1/admin/...`) require `Authorization: Bearer <OCTOPOOL_ADMIN_TOKEN>`.
The comparison is constant-time. If no admin token is configured, admin endpoints return
`503 admin_unconfigured`. Admin auth is entirely separate from caller auth — ordinary
callers can never reach admin routes.

## Website session auth

The browser dashboard uses GitHub OAuth and an opaque cookie session:

1. `/login/github` redirects to GitHub with `read:org`, `allow_signup=false`, and a
   short-lived signed state mirrored in an `HttpOnly` state cookie. The state payload
   only carries issue time, nonce, and the sanitized dashboard return path.
2. `/login/github/callback` exchanges the code with GitHub, resolves the user, verifies
   OpenClaw membership with the configured org verifier token, and creates or refreshes
   the caller grant for the default login pool by immutable GitHub user id.
3. A random `octopool_session` cookie is set (`HttpOnly`, `Secure`, `SameSite=Lax`).
   Only its SHA-256 hash is stored in `web_sessions`; the raw session token is never
   stored.
4. `/dashboard` and `/v1/dashboard` require a valid session, a pool grant, and
   `dashboard_role = 'admin'`.

Non-admin org members may be valid Octopool callers, but they cannot see pool-wide
operator data.

## GitHub-CLI login exchange

`POST /v1/login/github-cli` turns a local GitHub token into an Octopool caller token.
This is what `octopool login` calls.

Flow:

1. The CLI discovers the server with `GET /.well-known/octopool`, then chooses the
   discovered `api_base` and `default_pool` unless flags override them.
2. Body carries `github_token` (the user's GitHub.com token from `GH_TOKEN`,
   `GITHUB_TOKEN`, or `gh auth token --hostname github.com`, in that order), a
   hostname-derived `client_name`, and an optional `pool`. Enterprise credentials
   are never a fallback for this GitHub.com-only exchange.
3. The Worker resolves the GitHub user (`GET /user`) and verifies that user is a member
   of `ALLOWED_GITHUB_ORG` using the supplied token.
4. The caller row and requested default-pool grant are created or refreshed by immutable
   GitHub **user id**, org, active status, and pool.
5. A new caller token (`op_…`) is generated and hashed. It replaces only the token for
   the same caller and client name; sessions for the caller's other machines remain valid.
   Callers retain at most 16 named sessions, with least-recently-updated sessions retired
   as new client names are added.
   The caller row is refreshed with the current login, user id, and verification time.
6. The plaintext token is returned once, for the CLI to store locally.

The CLI follows login and authenticated JSON request redirects only within the
request's original origin: the same scheme, hostname, and effective port (80 for HTTP,
443 for HTTPS when omitted). Cross-origin redirects, including HTTPS downgrades, fail
before sending a request to the redirect target. `--trust-discovery-redirect` trusts
only the discovered `api_base`; neither it nor `OCTOPOOL_ALLOW_INSECURE_LOGIN=1` allows
later credential-bearing requests to redirect to another origin. Credential-free
discovery keeps its existing redirect behavior.

Clients are 1-80 hostname-safe characters. New CLI versions send the local hostname and
can override it with `--client`; older clients use `legacy`. Audit rows retain the matched
caller-token id so stats can separate machines without storing caller token values.

### Pool restriction

`octopool login` cannot self-grant an arbitrary pool. The requested pool must equal
`DEFAULT_LOGIN_POOL` (default `maintainers`); anything else is `403 pool_denied`. Binding
by user id, not the mutable login, keeps later username changes attached to the same
caller row.

## Org verification tokens

Two helpers query the user's visible organizations through GitHub GraphQL:

- During login, with the user's own token.
- During background freshness checks, with the configured `OCTOPOOL_GITHUB_ORG_TOKEN`.

The query requests GitHub's [User.databaseId](https://docs.github.com/en/graphql/reference/users#user)
and organization memberships together. Every fetched page must contain a positive integer
database ID equal to the enrolled account (refresh) or the account just resolved by `/user`
or `/users/{login}` (login/provisioning), before any membership is accepted. Admin provisioning
resolves the account before checking membership. No opaque node IDs are synthesized.

A completed query for the expected account without the org denies (`403 org_member_denied`).
A different account or an absent user returns `403 github_identity_mismatch`; missing or
malformed upstream IDs, organization nodes, or pagination, invalid JSON, transport, credential,
and rate-limit failures return `502 org_verification_failed`. Failed verification never refreshes
the timestamp. Responses omit upstream bodies and exception text. Requests retain timeouts,
response-size caps, and relay egress protection; protection denials remain `403 string_rewrite_denied`.
Membership checks use GraphQL, without adding a REST core-quota dependency. An unset verifier
token still returns `503 org_verification_unavailable` when a refresh is required.

### Immutable membership upgrade

The 0.5.18 migration `0017_org_identity_verification.sql` adds nullable
`callers.org_identity_verified_at` without backfilling it. Only successful identity-bound
verification writes this column, including CLI/OAuth login, admin provisioning, and caller/session
refresh. New auth TTL decisions use only this proof. A verified login stores it immediately, so the
next authenticated request does not need a redundant membership check.

Apply the additive schema migration before rolling out the new Worker. The old `org_verified_at`
database column and its existing values remain intact for mixed-version deployment compatibility.
Old Workers can continue writing their column, but those writes cannot create or extend a proof
trusted by new Workers, even if an old timestamp is fresh or future-dated. No authentication shutdown
or access-policy change is required. Complete the normal rollout and drain old requests before
claiming the fix is fully deployed; requests still served by old code retain its old behavior.

The public `Caller.org_verified_at` field keeps its name and nullable timestamp shape through explicit
SQL aliases of `org_identity_verified_at` in bearer and web-session reads. This is the public API
compatibility contract, not a fallback to the legacy database column. New code neither reads nor
dual-writes the old proof. Existing accounts without a new proof require an identity-bound GraphQL
check on their first request to new code; normal membership TTL and the 30-second caller config
cache apply after success. This causes a one-time increase in verification requests during rollout.

Legacy rows with null/missing or invalid `github_user_id` fail closed as
`403 github_identity_required`, even with a fresh timestamp. Run `octopool login` again, sign in
again on the website, or ask an admin to reprovision. A fresh proven login creates a separate
enrollment when no matching immutable ID exists; it never binds the legacy row by username or
revives its old caller tokens or web sessions. Old pool grants and dashboard roles do not transfer;
an admin must explicitly regrant any additional access to the new enrollment.

For an enrolled account that has renamed, sign in again with that GitHub account. Verified login
updates the username on the same immutable-ID enrollment. Merely owning the old username is
insufficient: GitHub permits [another account to claim it](https://docs.github.com/en/account-and-profile/concepts/username-changes).
