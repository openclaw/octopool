# Releasing Octopool

The CLI publishes through [release.yml](https://github.com/openclaw/octopool/blob/main/.github/workflows/release.yml), calling the shared [Go CLI archetype at `@v1`](https://github.com/openclaw/release-workflows/blob/v1/README.md). Publication no longer stops at an unsigned GoReleaser draft. The workflow builds the six existing platform archives, signs and notarizes both Darwin binaries with the OpenClaw Foundation identity, verifies frozen assets independently, publishes the GitHub Release, and verifies the Homebrew handoff.

The archive filenames, `checksums.txt`, and `openclaw/homebrew-tap` formula remain unchanged. GoReleaser runs without publication credentials; the shared publisher is the only promotion path. The Worker remains a separate service operation.

## One-time owner setup

Before enabling this caller, provision the repository's `MACOS_SIGNING_P12`, `MACOS_SIGNING_P12_PASSWORD`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_P8`, and `TAP_TOKEN` secrets through the approved credential workflow. `TAP_TOKEN` needs the existing tap's release handoff permissions. Never put values in the repository. Until those credentials are available, neither the signing rehearsal nor live publication can succeed.

The stable code-signing identifier is `org.openclaw.octopool`, with OpenClaw Foundation Team ID `FWJYW4S8P8`. Live tags must be annotated and reachable from protected main; preserve the existing annotated-tag convention.

## Prepare and rehearse

1. Land the release preparation with a dated changelog section and an empty `## Unreleased` above it. Do not drop contributor credit.
2. Require green independent push CI on that exact main commit. Also dispatch the existing CI workflow for the release-preparation commit and require its `CLI to Worker release smoke` gate to pass, preserving the networked release preflight.
3. Run the publishing rehearsal on merged main with the prepared version:

   ```sh
   gh workflow run release.yml --ref main -f version=X.Y.Z -F dry_run=true
   ```

The rehearsal freezes current protected main, builds, signs, notarizes, and verifies the assets. It creates no tag, draft, GitHub Release, Homebrew change, or Worker deployment. A historical version tag does not redirect a rehearsal away from current main.

## Publish and verify

Only after explicit release authorization, all preflights, and a successful rehearsal, create and push the annotated `vX.Y.Z` tag on the prepared commit. The tag starts publication. Never rebuild a published version or replace its tag or assets. Follow the shared workflow's immutable-byte recovery rules after a partial failure.

After the exact release run succeeds, download every asset, verify `checksums.txt` and the asset inventory, and check both Darwin signatures and online notarization constraints. Run the native CLI version command and verify all four Homebrew platform URLs and digests. Compare the published notes with the dated changelog, then record the release/run evidence in `openclaw/releases`. Finish on clean, synchronized main.

## Worker operations

Worker changes additionally need `pnpm run deploy` from the release commit. Load
`CLOUDFLARE_API_TOKEN` through the approved 1Password workflow from the Molty item
`OpenClaw Services Cloudflare API Token`; both `wrangler.jsonc` (`octopool`) and
`wrangler.public-proxy.jsonc` (`octopool-public-proxy`) are pinned to the OpenClaw
Services account. Use `pnpm run deploy:public-proxy` for a proxy-only proof. Never
substitute a personal-account Cloudflare token. R2/D1 bindings must be provisioned
first (see docs/cache.md for the actions-logs bucket and its lifecycle rule), and
`OCTOPOOL_PROXY_SECRET` must already exist on both Workers.
Preserve Durable Object migrations `v1` (`PoolCoordinator`) and `v2` (`PolicyCoordinator`),
and include `v3` (`BackendAdmission`) for admission control; follow
the [policy upgrade and rollback notes](operations.md#policy-coordinator-upgrade)
and [backend admission notes](operations.md#backend-work-admission).
Admin API writes through the coordinator are immediately visible; writes by older
Workers or direct D1 edits become visible within 60 seconds, with fail-closed reloads.
