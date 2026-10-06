# Releasing Octopool

Source of truth stays in this repo: tags, GitHub Releases, and `CHANGELOG.md`.
The shared [openclaw/releases](https://github.com/openclaw/releases) repo holds
durable release evidence; signing uses the OpenClaw Foundation Developer ID.

## Pipeline

1. Land everything; `CHANGELOG.md` has a dated section for the version
   (retitle the `Unreleased` heading). Commit `chore(release): X.Y.Z`, push.
   Dispatch the existing CI workflow on the release-preparation branch and require
   its exact commit to pass, including `CLI to Worker release smoke`. Manual
   dispatch adds the networked `pnpm test:e2e:cli-worker` release gate to the
   deterministic checks used for pushes and pull requests.
2. Confirm the version has no release, or its existing release is still a draft,
   before starting GoReleaser. Tag and push:
   `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
   `.github/workflows/release.yml` runs GoReleaser and stages a draft GitHub
   Release with `checksums.txt`; release notes are extracted from the
   changelog section and verified by the workflow. The pinned GoReleaser keeps
   an existing published release published even with `release.draft: true`.
   Never rerun it for a published version.
3. Sign + notarize the darwin binaries (currently a maintainer-Mac step; see
   below): download both darwin tarballs and `checksums.txt` from the draft with
   authenticated `ghx release download vX.Y.Z --repo openclaw/octopool` and verify
   their checksums. Sign each `octopool` binary with
   `Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)` using
   `codesign --force --options runtime --timestamp`, notarize a zip of each
   binary with `xcrun notarytool submit --wait` using the canonical release
   App Store Connect key from the approved private credential workflow, verify
   `spctl -a -t install` reports `Notarized Developer ID`, repackage the
   tarballs, rewrite the two darwin lines in `checksums.txt`, and use
   `ghx release upload vX.Y.Z --repo openclaw/octopool --clobber` for the two
   tarballs and checksum file. Once signing starts, resume this existing draft;
   do not rerun GoReleaser and replace the staged binaries.
4. Download the uploaded final assets and `checksums.txt` into a separate clean
   directory with authenticated
   `ghx release download vX.Y.Z --repo openclaw/octopool --dir <fresh-directory>`.
   Verify every archive's checksum and both downloaded darwin binaries'
   signatures and notarization.
   Confirm the draft's release notes exactly match the dated changelog section,
   then publish:
   `ghx release edit vX.Y.Z --repo openclaw/octopool --draft=false --latest`.
   After publication, never rebuild or replace this version's assets; fixes need
   a new version.
5. Bump `openclaw/homebrew-tap` `Formula/octopool.rb`: version plus all four
   platform sha256 values from the FINAL (post-signing) `checksums.txt`.
6. Fleet rollout: `brew update && brew upgrade octopool` on every Mac;
   verify `octopool version` matches and the shim still relays
   (`OCTOPOOL_NO_FALLBACK=1 gh api repos/openclaw/octopool --jq .full_name`).
7. Worker changes additionally need `pnpm run deploy` from the release commit. Load
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
8. Record evidence in openclaw/releases after publication: dispatch
   `openclaw-release-evidence.yml` with `release_id=octopool-X.Y.Z` and
   the Octopool CI/release workflow runs in `runs`. Leave `package_spec` and
   `release_ref` empty: the shared resolvers support only the `openclaw` npm package
   and refs in `openclaw/openclaw`, not this Go CLI. Put the verified Octopool tag,
   commit and release URLs plus final signing/checksum proof in `notes` instead.
   If the workflow cannot publish its evidence, generate locally with
   `node scripts/openclaw-release-evidence.mjs` and commit the evidence
   directory directly (precedent: `evidence/octopool-0.5.0`).
9. Verify the published release body exactly matches the finalized dated changelog section,
   the final assets/checksums match the Homebrew formula, and the working tree is clean.
   Resume an `Unreleased` section when the next user-visible changes land; keep their notes
   current as work lands rather than deferring changelog maintenance to release time.

## Future: CI-hosted signing

The manual step 3 should move into a macOS job gated like the shared repo's
`mac-release` environment (release-manager approval, dispatch from
openclaw/releases main, secrets held in the environment): a CI transport
`.p12` of the Foundation identity plus the shared App Store Connect API key,
with GoReleaser handing darwin archives to a sign/notarize/re-checksum step
before release publication. Until that exists, releases are signed on an
authorized maintainer Mac with the local Foundation release keychain
(passwordless, never-locking; proof commands in the private release notes).
