# Dashboard

`/dashboard` is the browser view for Octopool operators. The authoritative browser host is
`https://octopool.openclaw.ai`; `https://octopool.dev/dashboard` redirects there.

Source: `src/dashboard.ts`, `src/dashboard-data.ts`, `src/web-session.ts`, `src/router.ts`.

## Login model

The dashboard uses the website GitHub login, not a pasted admin token.

- `/dashboard` redirects anonymous browsers to `/login/github?next=/dashboard`.
- `/login/github/callback` verifies GitHub identity and OpenClaw membership.
- The default login-pool caller grant is created or refreshed automatically.
- The caller must have `dashboard_role = 'admin'`.
- A successful login stores an opaque `octopool_session` cookie (`HttpOnly`, `Secure`,
  `SameSite=Lax`) and a hashed session row in D1.

`/v1/dashboard` uses the same web session and role gate. Ordinary relay caller tokens and
non-admin org members cannot load dashboard data.

## Data shown

- caller and pool identity
- active/total pooled identities
- Durable Object rate-limit snapshots, active cooldowns, and live leases
- D1 cache totals, fresh/expired entries, body byte size, raw and successful-eligible hit
  rates, and route-kind breakdown
- top route kinds for the last 24 hours, with eligible hit rate, coalesced fills, local
  fallbacks, and service errors
- seven-day normalized route-key traffic and fallback/failure outcome tables
- public-repo proof count
- per-caller and per-client usage for the last seven days
- recent audit traffic with caller client, route kind, status, fallback reason, identity,
  and duration

Secrets, raw caller tokens, PAT values, and GitHub App private keys are never returned.
