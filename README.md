<div align="center">

<img src="docs/assets/octopool-github-app-512.png" alt="octopool" width="128" height="128">

# octopool

**A shared, org-authenticated GitHub read relay and cache.**

One angry octopus guarding a pool of GitHub identities, so trusted members and agents can run read-heavy maintainer automation without keeping tokens on their machines.

[Docs](https://docs.octopool.dev) · [Relay API](https://docs.octopool.dev/relay.html) · [CLI](https://docs.octopool.dev/cli.html) · [Spec](https://docs.octopool.dev/spec.html)

</div>

---

## What it is

Octopool runs on Cloudflare Workers. It accepts a normalized, read-only GitHub request, picks a healthy GitHub identity from a pool, performs the call, caches the result, and returns a clean envelope. Callers never see the underlying GitHub tokens.

It exists to make high-volume GitHub reads safe to share across trusted people and agents:

- **Tokens stay server-side.** GitHub PATs and App private keys live in Cloudflare secrets, never in local config, logs, or D1.
- **One pool, many callers.** Requests are routed across identities by remaining rate budget, with short leases and cooldowns to avoid stampedes and abuse flags.
- **Public-repository only.** Every repo route passes a public-visibility check before any pooled identity or cache entry is used.
- **Org-gated.** Only verified members of the allowed GitHub org get a caller token, and membership is re-checked as it goes stale.
- **Fails safe.** The CLI relays only the read shapes Octopool supports and falls through to the real `gh` for everything else.

## Quickstart

Install the CLI (the default endpoint `https://octopool.dev` is compiled in):

```sh
brew install openclaw/tap/octopool
```

Or install from source:

```sh
go install github.com/openclaw/octopool/cmd/octopool@latest
```

Log in with your existing GitHub CLI session — Octopool exchanges your `gh` token for a caller token and stores it locally:

```sh
octopool login
# logged in to https://octopool.dev as you for pool maintainers
```

Use the CLI like `gh` for supported read routes:

```sh
octopool gh api repos/openclaw/openclaw/pulls/85341 --jq .number
# 85341

octopool gh pr view 85341 -R openclaw/openclaw --json number,title,url
octopool gh pr checks 85341 -R openclaw/openclaw --json name,state,bucket
octopool stats
```

Symlink it as `gh` for a transparent shim — supported reads go through the pool, everything else (and any mutation) passes straight to the real GitHub CLI:

```sh
ln -s "$(command -v octopool)" ~/bin/gh
```

## How it works

```text
Octopool caller             Cloudflare Worker            GitHub
───────────────             ──────────────────          ──────
  octopool gh api  ──▶  authenticate caller (org-gated)
                        classify route + policy
                        public-repo visibility guard ──▶  GET /repos/:o/:r
                        D1 cache lookup ──── hit ──▶  return cached envelope
                        PoolCoordinator picks identity
                        mint token (PAT / App JWT) ──▶  GET api.github.com/...
                        record rate + cooldown
                        write D1 cache
                  ◀──   GitHub-shaped response body
```

A Durable Object (`PoolCoordinator`, one per pool) holds per-identity rate snapshots, sticky route leases, and cooldowns so concurrent callers share identities without exhausting or tripping any single one.

## Features

Each links to its page on [docs.octopool.dev](https://docs.octopool.dev):

- **[GitHub read relay](https://docs.octopool.dev/relay.html)** — `POST /v1/github/request`, the supported route allowlist, response envelope, and safety caps.
- **[Octopool CLI](https://docs.octopool.dev/cli.html)** — `octopool login`, the `gh` shim, cache stats, and real-`gh` fallback.
- **[Pooled identities & routing](https://docs.octopool.dev/identities.html)** — PAT and GitHub App identities, scopes, and the coordinator's selection, leases, and cooldowns.
- **[Cache & public-repo guard](https://docs.octopool.dev/cache.html)** — the D1 read-through cache and public-only visibility enforcement.
- **[Auth & org membership](https://docs.octopool.dev/auth.html)** — caller auth, admin auth, website sessions, and the GitHub-CLI login exchange.
- **[Admin & provisioning](https://docs.octopool.dev/admin.html)** — registering callers and identities.
- **[Landing page & GitHub login](https://docs.octopool.dev/landing.html)** — `octopool.dev` and the OAuth entry.
- **[Dashboard](https://docs.octopool.dev/dashboard.html)** — GitHub-login-gated browser view for limits, cache, identity, and caller usage stats.
- **[Deployment & operations](https://docs.octopool.dev/operations.html)** — Cloudflare resources, config, migrations, and the deploy flow.

## Development

The Worker is TypeScript on Cloudflare Workers; the CLI is Go.

```sh
pnpm install
pnpm check        # format + lint + vitest + types + go test + go vet
pnpm test         # vitest only
pnpm deploy       # wrangler deploy
pnpm e2e          # smoke-test the live deployment
pnpm docs:site    # build the docs site into dist/docs-site
pnpm sql:generate # regenerate sqlc-backed query artifacts
go build ./cmd/octopool
```

The docs site is a dependency-free static generator (`scripts/build-docs-site.mjs`) that renders `docs/*.md` into an octopus-themed site, deployed to [docs.octopool.dev](https://docs.octopool.dev) via GitHub Actions on every push to `docs/`.

## License

[MIT](LICENSE) © openclaw
