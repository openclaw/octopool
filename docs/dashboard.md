# Dashboard

`/dashboard` is the browser view for Octopool operators.

Source: `src/dashboard.ts`, `src/index.ts` (`dashboardData`), `src/web-session.ts`.

## Login model

The dashboard uses the website GitHub login, not a pasted admin token.

- `/dashboard` redirects anonymous browsers to `/login/github?next=/dashboard`.
- `/login/github/callback` verifies GitHub identity and OpenClaw membership.
- The caller must already be provisioned for the default login pool.
- The caller must have `dashboard_role = 'admin'`.
- A successful login stores an opaque `octopool_session` cookie (`HttpOnly`, `Secure`,
  `SameSite=Lax`) and a hashed session row in D1.

`/v1/dashboard` uses the same web session and role gate. Ordinary relay caller tokens and
non-admin org members cannot load dashboard data.

## Data shown

- caller and pool identity
- active/total pooled identities
- Durable Object rate-limit snapshots, active cooldowns, and live leases
- D1 cache totals, fresh/expired entries, body byte size, hit rate, and route-kind
  breakdown
- top route kinds for the last 24 hours, with cache hit rate, bypasses, and errors
- public-repo proof count
- per-caller usage for the last seven days
- recent audit traffic with route kind, status, identity, and duration

Secrets, raw caller tokens, PAT values, and GitHub App private keys are never returned.
