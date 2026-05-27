# Changelog

## 0.1.1 - Unreleased

### Documentation

- Document Homebrew installation from `openclaw/tap`.
- Reposition README and primary docs around Octopool as a standalone GitHub relay.
- Document top-level `gh pr`, `gh issue`, `gh run`, and `gh repo` shim coverage.
- Remove the Gitcrawl migration page from Octopool docs; the migration notice belongs in Gitcrawl.

### Features

- Expand the relay allowlist to public repo metadata, PR and issue lists, commits, and workflow metadata.
- Add cached top-level CLI translations for common read-only `gh pr`, `gh issue`, `gh run`, and `gh repo` commands, including conservative `--json` and `--jq` support.
- Add persisted cache hit/miss/bypass metrics, `GET /v1/pools/:pool/stats`, `octopool stats`, and dashboard top-route hit-rate views.

### Fixes

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
