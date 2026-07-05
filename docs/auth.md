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
  default 24h), using the org verifier token. A member who leaves the org loses access at
  the next check.

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
2. Body carries `github_token` (the user's `gh auth token`), a hostname-derived
   `client_name`, and an optional `pool`.
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

The query paginates organization memberships and confirms the configured org by login. A
completed query without the org denies (`403 org_member_denied`); transport, credential,
rate-limit, or malformed-response failures surface as `502 org_verification_failed`. Using
the GraphQL budget keeps org verification independent from REST core quota consumed by
release and repository workflows. If the verifier token is unset, verification returns
`503 org_verification_unavailable`.
