# Admin & Provisioning

Pools and identities are admin-managed. Verified org members can `octopool login` into
the default login pool automatically; admin caller registration remains available for
manual backfills and token issuance. Admin actions use the admin token (see
[Auth](auth.md#admin-auth)).

Source: `src/provisioning.ts`, `src/router.ts`, `cmd/octopool/main.go`.

## Provision a caller

Registers a GitHub org member as a relay caller and grants them a pool. The Worker
verifies org membership and resolves the immutable GitHub user id, then returns a
one-time caller token.

API: `POST /v1/admin/callers`

```json
{ "pool": "maintainers", "github_login": "steipete", "name": "Peter" }
```

CLI:

```sh
OCTOPOOL_ADMIN_TOKEN=… octopool admin caller \
  --pool maintainers --github-login steipete --name Peter
```

In practice callers usually run `octopool login`, which creates or refreshes this grant
for the default login pool automatically. Use this admin command for manual backfills,
nonstandard pools, or one-time token issuance.

## Register an identity

Creates or updates a pooled GitHub identity and its repo scopes. The secret material is
stored separately as a Cloudflare Worker secret; only the binding name (`secret_ref`) and
metadata live in D1.

API: `POST /v1/admin/pools/:pool/identities`

PAT identity:

```json
{
  "id": "pat_steipete",
  "kind": "pat",
  "login": "steipete",
  "secret_ref": "OCTOPOOL_PAT_STEIPETE",
  "scopes": [{ "owner": "openclaw" }],
  "weight": 100
}
```

GitHub App identity:

```json
{
  "id": "ghapp_openclaw_openclaw",
  "kind": "github_app",
  "login": "octopool-cache",
  "secret_ref": "OCTOPOOL_GITHUB_APP_PRIVATE_KEY",
  "installation_id": 135990630,
  "scopes": [{ "owner": "openclaw", "repo": "openclaw" }]
}
```

CLI:

```sh
# PAT, owner-wide scope
OCTOPOOL_ADMIN_TOKEN=… octopool admin identity \
  --id pat_steipete --login steipete --secret-ref OCTOPOOL_PAT_STEIPETE \
  --scope openclaw

# PAT, broad public-repo cache identity
OCTOPOOL_ADMIN_TOKEN=… octopool admin identity \
  --id pat_public --login steipete --secret-ref OCTOPOOL_PAT_STEIPETE \
  --scope '*'

# GitHub App, single repo scope
OCTOPOOL_ADMIN_TOKEN=… octopool admin identity \
  --kind github_app --installation-id 135990630 \
  --id ghapp_openclaw_openclaw --login octopool-cache \
  --secret-ref OCTOPOOL_GITHUB_APP_PRIVATE_KEY \
  --scope openclaw/openclaw
```

Notes:

- `--scope owner/repo` grants a single repo; `--scope owner` grants the owner; `--scope '*'`
  marks a PAT identity as broad enough for any public repository after the public-repo
  guard passes. A bare `--scope owner` only allows private access when `--private-scopes`
  is set, and a `owner/repo` scope always allows that repo (subject to the public-repo
  guard).
- `kind` must be `pat` or `github_app`. `github_app` requires a positive
  `installation_id`.
- Re-registering an existing id updates login, secret ref, installation id, weight, and
  scopes (scopes are replaced). Changing the pool or kind of an existing id is rejected
  (`409 identity_conflict`).
- Identity selection between equal candidates is biased by `weight` (default 100).

## Pools

Pools are created implicitly the first time they are referenced (caller provisioning,
identity registration, or login). A new pool gets the default policy:
owners = `DEFAULT_ALLOWED_OWNERS` (`openclaw`), `allow_public_repos: true`,
`allow_search: false`, `allow_logs: true`.
There is no pool-creation endpoint; edit `pools.policy_json` in D1 to change a policy.
