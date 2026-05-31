# Changelog

## 0.2.6 - Unreleased

### Changes

- Pool safe reads for public repositories from any GitHub owner by default, using explicitly broad `--scope '*'` PAT identities after the public-repo guard while keeping scoped PAT/App identities on their configured owners.
- Fetch public PR diffs, commit/compare diff and patch media, and explicit-ref content files through token-free GitHub web/raw endpoints before spending pooled GitHub API budget, while still writing the shared D1 cache.
- Serve bounded stale cache entries when pooled identities are depleted, cooling down, or rate-limited, and count those responses as saved GitHub requests in stats and dashboard aggregates.
- Route GitHub release list/view reads through Octopool for REST paths and top-level `gh release` JSON commands.
- Raise `gh` shim cache coverage with repo-scoped cached `gh search issues|prs`, hydrated PR detail fields (`files`, `commits`, `comments`, `reviews`), cacheable default `gh pr checks`, and extra PR/issue subresource routes.

### Fixes

- Fall back to the real GitHub CLI when a safe `gh` shim read finds a stale or invalid Octopool caller token.

## 0.2.5 - 2026-05-29

### Fixes

- Add validated PR state discriminators for PR subresource cache keys and richer stats that show saved GitHub calls plus backend request counts.
- Raise cache hit rates with response-aware TTLs for closed PRs/issues, immutable commits, and normalized default GitHub query/header variants while keeping mutable CI reads short-lived.
- Skip Octopool-backed `gh` wrapper scripts when falling back to the real GitHub CLI, avoiding duplicate fallback attempts and warnings.

## 0.2.4 - 2026-05-29

### Fixes

- Add pnpm build-script approvals for esbuild, sharp, and workerd so `pnpm test` and `pnpm check` run without generating placeholder approval config.
- Retry public-repository proof without the verifier token when the verifier is rate-limited, so safe `gh pr`, `gh issue`, and `gh run` reads can still route through Octopool.

## 0.2.3 - 2026-05-28

### Fixes

- Route safe read-shaped `gh` calls through Octopool before local fallback, with an explicit server fallback signal when a route is unsupported, denied by pool policy, private, or the identity pool is depleted.
- Route browser GitHub OAuth through the registered `octopool.dev` callback, then forward back to `octopool.openclaw.ai` so the authoritative website can log in without GitHub rejecting the redirect URI.

## 0.2.2 - 2026-05-28

### Fixes

- Soften the public Homebrew install CTA colors and add a dedicated copy button.
- Fit the install CTA pill to its command so the prompt, text, and copy button sit flush instead of stretching across a fixed 560px box.

### Documentation

- Rewrite the README around the actual pitch: pool an org's GitHub identities and a D1 cache behind one Cloudflare Worker to take read traffic off individual PATs and Apps, with a step-by-step Cloudflare self-deploy section (Worker, D1, Durable Object, secrets, custom domain, caller/identity provisioning, smoke test).
- Lead `docs/index.md` with the same pitch and a self-deploy entry point.
- Add a self-host Cloudflare quickstart to `docs/operations.md` and note that `git push` does not auto-deploy the Worker — only the docs site has a Pages workflow.
- Add `/.well-known/octopool` server discovery, self-host login UX (`octopool login [server]` / `--server`), and `octopool whoami`.
- Split browser hosts so `octopool.openclaw.ai` owns website login through an OpenClaw proxy while `octopool.dev` stays a Homebrew-install landing page.

## 0.2.1 - 2026-05-28

### Fixes

- Explain `octopool login` GitHub token verification failures without dumping raw JSON.
- Harden relay public-repo checks, response normalization, cache-key query ordering, stateless OAuth login state, and GitHub Actions pinning after a DeepSec scan.
- Include GitHub rate-limit reset details when login token verification is rate-limited.

## 0.2.0 - 2026-05-28

### Documentation

- Document Homebrew installation from `openclaw/tap`.
- Reposition README and primary docs around Octopool as a standalone GitHub relay.
- Explain in the README how pooled PAT/App rate budgets stack and how cache hits avoid GitHub quota entirely.
- Document top-level `gh pr`, `gh issue`, `gh run`, and `gh repo` shim coverage.
- Remove the Gitcrawl migration page from Octopool docs; the migration notice belongs in Gitcrawl.

### Features

- Move Worker and Durable Object SQL into a sqlc-validated query catalog with generated D1 query constants.
- Expand the relay allowlist to public repo metadata, PR and issue lists, commits, and workflow metadata.
- Add cached top-level CLI translations for common read-only `gh pr`, `gh issue`, `gh run`, and `gh repo` commands, including conservative `--json` and `--jq` support.
- Add persisted cache hit/miss/bypass metrics, `GET /v1/pools/:pool/stats`, `octopool stats`, and dashboard top-route hit-rate views.

### Fixes

- Redirect public HTTP requests to HTTPS and add HSTS to public HTTPS responses.
- Use the configured GitHub verifier token for public-repository checks while still rejecting token-visible private repositories.
- Serve the landing page by default at `/` and render browser login failures as HTML instead of raw JSON.

## 0.1.0 - 2026-05-27

### Features

- Add the initial Cloudflare-hosted GitHub read relay with D1 schema, Durable Object pool coordination, strict route policy checks, and a Go CLI.
- Add org-gated caller login via `octopool login`, backed by the local GitHub CLI token and hashed Octopool caller tokens stored on disk.
- Add the `octopool gh api` read shim for supported `gh api` routes, with real-`gh` fallback for unsupported routes, mutations, sensitive headers, and unsafe query keys.
- Add a D1 read-through cache for public GitHub reads, including normalized cache keys, response envelopes, audit events, and cache hit/miss metadata.
- Add GitHub App installation identities, Worker-minted installation tokens, selected-repository OpenClaw App setup, and public-repository visibility guards before cache or pooled identity use.
- Add admin provisioning commands for callers and pooled identities, including GitHub App installation IDs and owner/repository scopes.
- Add a GitHub-login-gated operator dashboard for request volume, caller usage, cache totals, recent traffic, pooled identities, and live rate-limit snapshots.
- Add D1-backed website OAuth state, hashed `octopool_session` cookies, `dashboard_role` authorization, logout, `/v1/me`, and org-membership freshness checks for dashboard sessions.
- Add the public `octopool.dev` landing page with the animated octopus app artwork, GitHub sign-in, Dashboard link, and Docs link while preserving JSON health responses for API clients.
- Add the dependency-free docs site at `docs.octopool.dev`, with generated pages for relay, CLI, cache, auth, admin, identities, dashboard, landing, operations, and the Gitcrawl migration.
- Add custom angry-octopus favicons, Apple touch icon, Open Graph/Twitter metadata, and a 1200x630 social card for the docs site and landing page.
- Add GoReleaser packaging for macOS, Linux, and Windows on amd64/arm64, with linker-injected version metadata.
- Add GitHub Actions CI for TypeScript, Go, docs, and snapshot release builds, plus a tag-driven release workflow that publishes changelog-backed GitHub release notes.

### Fixes

- Fix docs-site rendering for wrapped Markdown list items.
- Fix dashboard action label centering across button and link controls.
