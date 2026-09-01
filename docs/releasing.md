# Releasing Octopool

Source of truth stays in this repo: tags, GitHub Releases, and `CHANGELOG.md`.
The shared [openclaw/releases](https://github.com/openclaw/releases) repo holds
durable release evidence; signing uses the OpenClaw Foundation Developer ID.

## Pipeline

1. Land everything; `CHANGELOG.md` has a dated section for the version
   (retitle the `Unreleased` heading). Commit `chore(release): X.Y.Z`, push.
2. Tag and push: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
   `.github/workflows/release.yml` runs GoReleaser and publishes the GitHub
   Release with `checksums.txt`; release notes are extracted from the
   changelog section and verified by the workflow.
3. Sign + notarize the darwin binaries (currently a maintainer-Mac step; see
   below): download both darwin tarballs, sign the `octopool` binary with
   `Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)` using
   `codesign --force --options runtime --timestamp`, notarize a zip of each
   binary with `xcrun notarytool submit --wait` using the canonical release
   App Store Connect key from the approved private credential workflow, verify
   `spctl -a -t install` reports `Notarized Developer ID`, repackage the
   tarballs, rewrite the two darwin lines in `checksums.txt`, and
   `gh release upload vX.Y.Z --clobber` the three files.
4. Bump `openclaw/homebrew-tap` `Formula/octopool.rb`: version plus all four
   platform sha256 values from the FINAL (post-signing) `checksums.txt`.
5. Fleet rollout: `brew update && brew upgrade octopool` on every Mac;
   verify `octopool version` matches and the shim still relays
   (`OCTOPOOL_NO_FALLBACK=1 gh api repos/openclaw/octopool --jq .full_name`).
6. Worker changes additionally need `pnpm run deploy` from the release commit. Load
   `CLOUDFLARE_API_TOKEN` through the approved 1Password workflow from the Molty item
   `OpenClaw Services Cloudflare API Token`; both `wrangler.jsonc` (`octopool`) and
   `wrangler.public-proxy.jsonc` (`octopool-public-proxy`) are pinned to the OpenClaw
   Services account. Use `pnpm run deploy:public-proxy` for a proxy-only proof. Never
   substitute a personal-account Cloudflare token. R2/D1 bindings must be provisioned
   first (see docs/cache.md for the actions-logs bucket and its lifecycle rule), and
   `OCTOPOOL_PROXY_SECRET` must already exist on both Workers.
7. Record evidence in openclaw/releases: dispatch
   `openclaw-release-evidence.yml` with `release_id=octopool-X.Y.Z`,
   `package_spec=octopool@X.Y.Z`, and the release workflow run in `runs`.
   The `release_ref` provenance resolves against `openclaw/openclaw` and
   reports `not-found` for octopool tags; that is expected. If the workflow's
   push token is unavailable, generate locally with
   `node scripts/openclaw-release-evidence.mjs` and commit the evidence
   directory directly (precedent: `evidence/octopool-0.5.0`).
8. Verify the published release body exactly matches the finalized dated changelog section,
   the final assets/checksums match the Homebrew formula, and the working tree is clean.
   Do not prefill another `Unreleased` section; write the next version's notes at release time.

## Future: CI-hosted signing

The manual step 3 should move into a macOS job gated like the shared repo's
`mac-release` environment (release-manager approval, dispatch from
openclaw/releases main, secrets held in the environment): a CI transport
`.p12` of the Foundation identity plus the shared App Store Connect API key,
with GoReleaser handing darwin archives to a sign/notarize/re-checksum step
before release publication. Until that exists, releases are signed on an
authorized maintainer Mac with the local Foundation release keychain
(passwordless, never-locking; proof commands in the private release notes).
