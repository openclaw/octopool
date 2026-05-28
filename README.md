<div align="center">

<img src="docs/assets/octopool-github-app-512.png" alt="octopool" width="128" height="128">

# octopool

**Pool your org's GitHub identities behind a shared Cloudflare cache.**

A self-hosted GitHub read relay. One Cloudflare Worker holds your team's PATs and GitHub App installations, picks the healthiest one per request, and caches the response in D1 so the next caller doesn't burn a single token of rate limit.

[App](https://octopool.openclaw.ai) · [Docs](https://docs.octopool.dev) · [Relay API](https://docs.octopool.dev/relay.html) · [CLI](https://docs.octopool.dev/cli.html) · [Spec](https://docs.octopool.dev/spec.html)

</div>

![Octopool banner](docs/assets/readme-banner.jpg)

---

## Why octopool

A maintainer team plus a few bots can chew through GitHub's primary rate limit fast. Every developer carries their own PAT, every GitHub App installation has its own budget, and they all run the same handful of read shapes (`gh pr view`, `gh pr checks`, `gh run list`, `gh issue list`, `gh api repos/.../pulls/N`) against the same repos, over and over.

Octopool moves that traffic off individual machines and onto Cloudflare:

- **One pool, one cache.** PATs and GitHub App private keys live as Cloudflare Worker secrets, not on laptops or in CI logs. The Worker routes each cache miss to one healthy identity and writes the result into a D1 read-through cache that every other caller hits next.
- **Rate budgets add up.** Each identity keeps its own GitHub rate-limit bucket. Five PATs + one GitHub App ≈ five-plus-one combined headroom. A per-pool Durable Object picks the identity with the most remaining budget for the target resource and holds a short sticky lease so concurrent callers don't stampede the same one.
- **Cache hits cost zero GitHub quota.** Fresh D1 hits return straight from Cloudflare without touching GitHub at all. Repeated maintainer reads stop consuming any pooled identity's budget.
- **Tokens stay server-side.** Callers authenticate to octopool with a short caller token (issued in exchange for their `gh auth token`). The underlying PATs and App private keys never leave the Worker — not into responses, not into audit rows, not into the cache.
- **Org-gated, public-repo only.** Only verified members of one GitHub org can mint a caller token, and every repo route is checked against GitHub's public-visibility endpoint before a pooled identity or cache entry is used. Private-repo callers fall back to their own `gh`.
- **Fails open to real `gh`.** The CLI is a drop-in `gh` shim. Safe read-shaped calls try Octopool first, so the server owns cache, app/PAT routing, and pool policy. Mutations and secret-bearing requests stay local; safe reads run your real `gh` only when Octopool explicitly returns `fallback_local`.

If you're not running a maintainer team and you don't care about GitHub rate limits, you don't need this.

## Architecture

```text
   developers / bots                Cloudflare                          GitHub
   ─────────────────                ──────────                          ──────
   octopool gh ...   ── caller ──▶  Worker (octopool)
                       token        ├── auth + org-membership check
                                    ├── route classify + per-pool policy
                                    ├── public-repo guard ─────────────▶ GET /repos/:o/:r
                                    ├── D1 cache lookup ─── hit ───────▶ return cached
                                    │                       miss
                                    ├── PoolCoordinator (Durable Object)
                                    │     picks one identity ──────────▶ GET /repos/.../pulls/N
                                    │     records rate + cooldowns       with pooled PAT/App token
                                    ├── write D1 cache (public 200s)
                                    └── audit row (no secrets)
```

- **Worker** (`src/index.ts`) — HTTP, auth, policy, response shaping.
- **PoolCoordinator** Durable Object (one per pool) — per-identity rate snapshots, sticky route leases, cooldowns.
- **D1** — pools, callers, identities, audit events, public-repo proofs, read-through cache.
- **Cloudflare Worker secrets** — pooled PATs and GitHub App PKCS#8 private keys. Never in D1, never in logs.

## Use it (CLI)

If your org already runs octopool, install the CLI and log in:

```sh
brew install openclaw/tap/octopool
# or: go install github.com/openclaw/octopool/cmd/octopool@latest

octopool login                                  # default endpoint: https://octopool.dev
octopool login https://octopool.your-org.dev    # self-hosted endpoint
octopool whoami
```

Use it like `gh` for common read shapes:

```sh
octopool gh pr view 85341 -R openclaw/openclaw --json number,title,url
octopool gh pr checks 85341 -R openclaw/openclaw --json name,state,bucket
octopool gh issue list -R openclaw/openclaw --state open --json number,title,url
octopool gh run list -R openclaw/openclaw --branch main --limit 10 --json databaseId,status
octopool gh api repos/openclaw/openclaw/pulls/85341 --jq .number
octopool stats
```

Symlink it as `gh` for a transparent shim — safe reads try Octopool first, while mutations, unusual flags, and explicit server fallback signals pass through to your local `gh`:

```sh
ln -s "$(command -v octopool)" ~/bin/gh
```

Full command surface, fallback rules, and discovery details: [docs.octopool.dev/cli](https://docs.octopool.dev/cli.html).

## Deploy it (Cloudflare)

Octopool is built to be self-deployed per org. You'll need:

- a Cloudflare account on the Workers Paid plan (Durable Objects + D1),
- a domain you can route at a Worker (Cloudflare-managed, or with a CNAME you control),
- a GitHub org you can verify membership against, and
- at least one GitHub identity to pool — a PAT or a GitHub App installation.

### 1. Clone and configure

```sh
git clone https://github.com/openclaw/octopool.git
cd octopool
pnpm install
```

Edit `wrangler.jsonc` for your account:

- `account_id` — your Cloudflare account id.
- `vars.ALLOWED_GITHUB_ORG` — the GitHub org whose members may mint caller tokens.
- `vars.DEFAULT_ALLOWED_OWNERS` — comma-separated GitHub owners (orgs/users) whose repos this pool may read.
- `vars.GITHUB_OAUTH_CLIENT_ID` — the OAuth client id of your GitHub App (for browser sign-in).
- `vars.GITHUB_OAUTH_CALLBACK_ORIGIN` — optional HTTPS origin registered as the GitHub OAuth callback when browser sign-in starts on a different host.
- `routes[]` — the custom domain you want octopool served on.

If you don't need OpenClaw's second-host proxy, you can ignore `wrangler.openclaw-proxy.jsonc` and deploy only the main Worker.

### 2. Create the data plane

```sh
wrangler d1 create octopool
# copy the printed database_id into wrangler.jsonc d1_databases[].database_id

wrangler d1 migrations apply octopool --remote
```

The `PoolCoordinator` Durable Object class is created by the migration tag in `wrangler.jsonc` on first deploy — no separate step.

### 3. Put secrets in Cloudflare

Never in `wrangler.jsonc`, never in D1, never in logs:

```sh
wrangler secret put OCTOPOOL_ADMIN_TOKEN              # used to provision callers/identities
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET        # browser GitHub login (companion to GITHUB_OAUTH_CLIENT_ID)
wrangler secret put OCTOPOOL_GITHUB_ORG_TOKEN         # background org-membership + public-repo proofs
wrangler secret put OCTOPOOL_GITHUB_APP_ID            # only if you use GitHub App identities
# one secret per pooled identity, referenced by name from D1:
wrangler secret put OCTOPOOL_PAT_ALICE                # raw PAT value
wrangler secret put OCTOPOOL_GITHUB_APP_PRIVATE_KEY   # PKCS#8 (BEGIN PRIVATE KEY) PEM
```

Full secret list and rotation notes: [docs.octopool.dev/operations](https://docs.octopool.dev/operations.html).

### 4. Deploy the Worker

```sh
wrangler deploy
```

DNS-managed-by-Cloudflare domains register the custom domain in `routes[]` automatically; otherwise CNAME your domain at the Worker once.

### 5. Provision a caller and at least one identity

```sh
export OCTOPOOL_ADMIN_TOKEN=...                              # the value you put above
export OCTOPOOL_URL=https://octopool.your-org.dev

# Register a teammate (verified against ALLOWED_GITHUB_ORG by GitHub user id):
octopool admin caller --pool maintainers --github-login alice --name "Alice"

# Pooled PAT identity:
octopool admin identity \
  --pool maintainers \
  --id pat_alice --login alice \
  --secret-ref OCTOPOOL_PAT_ALICE \
  --scope your-org

# Or a GitHub App identity (PKCS#8 private key under secret-ref):
octopool admin identity \
  --pool maintainers \
  --kind github_app --installation-id 135990630 \
  --id ghapp_your-org_core --login your-cache-app \
  --secret-ref OCTOPOOL_GITHUB_APP_PRIVATE_KEY \
  --scope your-org/core
```

The first reference to a pool by name (here, `maintainers`) creates it with the default policy (owners = `DEFAULT_ALLOWED_OWNERS`, `allow_search: false`, `allow_logs: true`). Teammates can now `octopool login https://octopool.your-org.dev` and start using the relay; the identities you registered take turns serving cache misses.

### 6. Verify

```sh
curl https://octopool.your-org.dev/.well-known/octopool
# {"service":"octopool","version":1,"api_base":"...","default_pool":"maintainers", ...}

octopool stats     # cache hit rate, top routes, per-caller usage
pnpm e2e           # smoke-test the live deployment
```

A browser-side operator dashboard lives at `/dashboard` — GitHub-OAuth gated, requires `dashboard_role = 'admin'` on the caller row. See [docs.octopool.dev/dashboard](https://docs.octopool.dev/dashboard.html).

## What's in the box

All docs are on [docs.octopool.dev](https://docs.octopool.dev):

- [GitHub read relay](https://docs.octopool.dev/relay.html) — `POST /v1/github/request`, the supported route allowlist, response envelope, and safety caps.
- [Octopool CLI](https://docs.octopool.dev/cli.html) — `octopool login`, the `gh` shim, cache stats, and real-`gh` fallback.
- [Pooled identities & routing](https://docs.octopool.dev/identities.html) — PAT and GitHub App identities, scopes, and the coordinator's selection, leases, and cooldowns.
- [Cache & public-repo guard](https://docs.octopool.dev/cache.html) — the D1 read-through cache and public-only visibility enforcement.
- [Auth & org membership](https://docs.octopool.dev/auth.html) — caller auth, admin auth, website sessions, and the GitHub-CLI login exchange.
- [Admin & provisioning](https://docs.octopool.dev/admin.html) — registering callers and identities.
- [Dashboard](https://docs.octopool.dev/dashboard.html) — browser view for limits, cache, identity, and caller usage stats.
- [Deployment & operations](https://docs.octopool.dev/operations.html) — Cloudflare resources, config, migrations, observability, and the deploy flow.

## Development

The Worker is TypeScript on Cloudflare Workers; the CLI is Go.

```sh
pnpm install
pnpm check        # format + lint + vitest + types + go test + go vet
pnpm test         # vitest only
pnpm run deploy   # wrangler deploy for the backing Worker (and openclaw proxy)
pnpm e2e          # smoke-test the live deployment
pnpm docs:site    # build the docs site into dist/docs-site
pnpm sql:generate # regenerate sqlc-backed query artifacts
go build ./cmd/octopool
```

The docs site is a dependency-free static generator (`scripts/build-docs-site.mjs`) that renders `docs/*.md` into an octopus-themed site, deployed to [docs.octopool.dev](https://docs.octopool.dev) via GitHub Actions on every push to `docs/`.

## License

[MIT](LICENSE) © openclaw
