# Changelog

## 0.5.3 - Unreleased

### Fixes

- Keep rerunnable base Actions runs and job lists short-lived, cache only completed attempt-qualified job lists long-term, share equivalent bounded `gh run view` job variants, and fail over instead of returning partial job pagination.
- Keep closed-but-unmerged PR summaries mutable, share safe hydrated summary/file shapes, and recheck the PR head after file pagination so moving heads fail over instead of mixing revisions.
- Reject incomplete public-page Actions parses instead of returning partial filtered run lists.

## 0.5.2 - 2026-08-08

### Changes

- Serve common repo- and workflow-scoped Actions run-list variants from shared public-page cache entries, and expose bounded backend and fallback-reason stats so operators can separate free web reads from GitHub API and pooled-identity traffic.

## 0.5.1 - 2026-08-02

### Fixes

- Reject expired public-repository proofs immediately during GitHub outage fallback, keeping runtime and D1 authorization checks fail-closed (thanks @luojiyin1987).

## 0.5.0 - 2026-07-18

### Changes

- Prefer validated public page, raw-content, and Git smart HTTP transports before anonymous GitHub API reads, retaining anonymous API and pooled identities as fallbacks.
- Render common non-interactive human-format `gh pr`, `gh run`, and `gh issue` reads from relay-cached REST responses while preserving real `gh` for terminal and unsupported shapes.
- Revalidate expired cache entries with conditional requests so unchanged GitHub responses cost zero rate limit.
- Cache completed Actions job logs in R2 for seven days and serve shaped repo run-list filters from one cached 100-run superset.

## 0.4.7 - 2026-07-17

### Changes

- Follow authoritative GitHub Link pagination through the relay while retaining shape inference for header-less responses.
- Keep bounded `gh api --paginate` and `--slurp` GET reads on the shared relay cache, falling back to real `gh` after 10 pages.

### Fixes

- Make every Octopool subcommand help flag exit successfully with command-specific usage and flag details instead of reporting `flag: help requested`.
- Keep `gh run watch` and `gh pr checks --watch` on relay-cached polling with a 30-second interval floor and backoff to 120 seconds instead of draining personal GitHub API quota.

## 0.4.6 - 2026-07-13

### Changes

- Keep common repo-scoped `gh search issues|prs` reads on the token-free anonymous API and shared cache even when pooled search is disabled, and key hydrated PR file lists by the verified head SHA for longer cache reuse.

## 0.4.5 - 2026-07-13

### Changes

- Route `octopool.dev` into the OpenClaw data plane, relay cached workflow-run attempts, and extend active CI plus PR-head cache bounds to 60 seconds so fleet polling shares one cache without spending the GitHub App budget unnecessarily.

### Fixes

- Make shim installation fail when login-shell startup ordering shadows Octopool, matching the documented login-shell guarantee.

## 0.4.4 - 2026-07-05

### Changes

- Keep up to 16 caller sessions per named client so logging in on a second machine no longer invalidates the first, retire the least recently updated stale session as new client names appear, and attribute relay usage by client in CLI stats and the operator dashboard.

## 0.4.3 - 2026-07-04

### Changes

- Move the OpenClaw deployment to the OpenClaw Foundation Cloudflare account (new D1 database and Worker); `octopool.openclaw.ai` is now attached directly to the new Worker instead of proxying to the old account, and existing callers must re-run `octopool login` once. The `octopool.dev` zone move is still pending.
- Relay `GET /user` as the caller's public profile served token-free, so `gh api user` identity probes stop bouncing to local tokens as `route_denied`.
- Retry transient pool-exhaustion fallbacks (`identities_cooling_down`, `identity_pool_depleted`, `github_identity_depleted`, `github_rate_limited`) against the relay with short backoff before running real `gh`; tune with `OCTOPOOL_RELAY_RETRIES`.
- Serve bounded stale cache entries for token-free-only routes when their public backend is unavailable (`web_only_unavailable`) instead of forcing a local fallback.
- Extend the active workflow-run-list cache TTL from 30s to 45s so concurrent CI polling sessions share cache entries.
- Relay `commits/{ref}` reads (commit view, check-runs, check-suites, status, statuses) for branch and tag names instead of denying non-SHA refs to the personal-token fallback, with short ref-scoped cache TTLs while SHA-shaped paths keep their long immutable TTLs.

### Fixes

- Stop `gh pr checks` from bypassing the shared cache on its PR head-SHA lookup: the relay now honors a `cache-control: max-age=N` request directive that treats fresh entries older than `N` seconds as coalesced misses whose refills write through to the shared cache, and the checks flow uses `max-age=20` so concurrent CI-polling sessions share one upstream PR read instead of each forcing a live fetch.

## 0.4.2 - 2026-07-04

### Fixes

- Diagnose valid `gh auth login --with-token` credentials blocked by exhausted REST scope-check quota, report the reset time, and avoid unnecessary reauthorization without storing the token.

## 0.4.1 - 2026-07-04

### Fixes

- Stop `gh auth status` from sending users through redundant OAuth logins when GitHub's REST scope probe is rate-limited but the active token still authenticates through GraphQL.

## 0.4.0 - 2026-07-02

### Changes

- Add `octopool install-shim` to idempotently install and verify the `gh` shim for interactive, login, and non-interactive zsh processes without overwriting unrelated shell configuration.
- Redesign the operator dashboard as a responsive relay control room with clearer telemetry hierarchy, latency and cache-size metrics, accessible loading/error states, and scroll-safe data tables.
- Split service errors from expected local fallbacks and policy denials, report successful cache-eligible hit rate and coalesced fills, and add seven-day normalized route-key and outcome diagnostics to the dashboard and stats API.
- Add data-center-local edge caching ahead of D1, parallelize independent relay checks, coalesce public-repository proof refreshes, and let successful direct repository-resource reads establish the live public proof without a duplicate GitHub request.

### Fixes

- Use GitHub GraphQL for org-membership verification so exhausted REST core quota cannot disable the relay.
- Fall back to the real GitHub CLI instead of returning partial results when relay-backed PR checks/details or filtered issue lists exhaust the bounded pagination window.
- Reject non-integer `--limit` and `-L` values instead of silently substituting the default limit.
- Reject malformed relay envelopes with missing or unknown body encodings instead of treating them as JSON.
- Give the dashboard account row balanced spacing and full-width alignment below the pool controls on tablet-sized screens.
- Coalesce concurrent identical cache misses through the pool coordinator and raise active Actions run, job, check, and status cache TTLs from 15 to 30 seconds.
- Give failed CLI logins actionable real-`gh` web reauthentication and retry commands instead of an opaque subprocess exit status.
- Let cacheable Actions run lists use the configured 2 MiB response cap instead of failing above the normal 1 MiB route cap.
- Prune audit rows older than the supported 30-day stats window in bounded hourly batches to prevent unbounded D1 growth.
- Prune expired cache entries at their route-specific stale deadlines instead of retaining every payload for 25 hours.

## 0.3.2 - 2026-06-13

### Fixes

- Cache terminal Actions runs/jobs/checks/statuses for one hour with a 24-hour stale fallback, publish cache misses before responding, and prune entries older than the maximum stale window hourly.
- Serve supported top-level Actions/release summaries from public GitHub pages, add public page/raw fallbacks while preserving exact raw REST semantics, and prove public repository visibility from GitHub HTML when API proof quotas are depleted.
- Serve workflow-filtered run lists and top-level `gh run view --json jobs` job/step metadata from public GitHub pages, with bounded parsing and exact API fallback.
- Serve shaped issue views, issue/PR lists, labels, and active workflow lists from token-free GitHub pages when their requested fields are exactly representable.
- Resolve branch and annotated-tag Git refs exactly through Git smart HTTP, and serve bounded PR summaries and workflow views from token-free GitHub pages.
- Let verified OpenClaw org members self-enroll into the default Octopool login pool instead of requiring an admin-created caller grant first.
- Skip legacy Gitcrawl and Octopool `gh` shims when resolving the real GitHub CLI, including copied Windows binaries and invalid `OCTOPOOL_GH_PATH` overrides.
- Disable Sharp's install script so `pnpm install` uses its prebuilt package instead of failing on machines with a global Homebrew `libvips`.

### Documentation

- Add one canonical endpoint matrix for every token-free anonymous API and public web/raw/Git transport, including source URL shapes, limits, and explicit exclusions.

## 0.3.1 - 2026-06-01

### Fixes

- Add `GET /users/:login` to the safe GitHub relay allowlist, including bot logins, and cache sanitized profiles fetched through unauthenticated public GitHub API reads.
- Expand token-free public GitHub API fallbacks across exact JSON read routes, including repo metadata, contents/README, PR and issue subresources, commits/comments, labels, milestones, checks/statuses, Actions run/workflow metadata, branches, tags, topics, community profiles, forks, stargazers, subscribers, Git object reads, languages, contributors, licenses, release assets, and repo-scoped issue/commit search.
- Add public org repository lists, user/gist reads, reactions, assignees, repository search, and top-level cached `gh workflow list/view`, `gh label list`, `gh gist view`, and `gh search repos` coverage.
- Add more token-free public API fallback routes for user followers/following/events/keys, repo-wide issue and PR comments/events, commit pull/check-suite/branch metadata, network events, and repository stats.
- Add token-free public fallback routes for GitHub metadata/license/gitignore APIs, org public events and members, PR review/requested-reviewer detail reads, issue/PR comment and event detail reads, deployments, and commit status aliases.
- Keep `GET /orgs/:org` on local `gh` because live comparison shows authenticated GitHub responses include extra org fields missing from unauthenticated public API responses.

## 0.3.0 - 2026-05-31

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
