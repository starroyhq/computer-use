# Official release mirror

GitHub remains the primary App/CLI source. The fallback is the project's exact COS endpoint:

```text
https://computer-use-download-1308799022.cos.ap-guangzhou.myqcloud.com/computer-use
```

The website defaults Simplified Chinese pages to the verified mirror and other languages to GitHub, without showing provider labels. Existing clients and copied Skills do not acquire fallback behavior automatically. Chromium's separate download is outside this mirror.

## Storage and credentials

Use bucket `computer-use-download-1308799022`, Guangzhou (`ap-guangzhou`), single AZ, standard storage. Keep the bucket private; apply `public-read-policy.json` to allow anonymous `GetObject` only under `computer-use/*`. Anonymous listing, writing and deleting remain denied. Enable versioning and SSE-COS (`AES256`), not SSE-KMS, for public download objects. Apply `lifecycle.xml`: keep current release objects, expire noncurrent versions after 30 days and abort incomplete multipart uploads after 7 days. CDN, global acceleration, CORS and Data Intelligence are unnecessary for this flow.

Create a dedicated CAM publisher with `publisher-policy.json`, limited to this bucket/prefix. Do not grant anonymous write, account-wide COS administration, or access to user media. Configure the existing notification channel for traffic/request-volume alarms; the alarm thresholds and contact routing are account configuration, not embedded in the App.

Repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `COS_SECRET_ID` | Dedicated publisher identity |
| `COS_SECRET_KEY` | Publisher secret; never committed or included in downloaded files |

The publisher also accepts `COS_SECURITY_TOKEN` for temporary credentials in operator runs. The bucket, region and trusted download endpoint are fixed in code. The official COS SDK is isolated in `.github/cos`, pinned by its lockfile and used only by release automation. Install it with `pnpm --dir .github/cos install --ignore-workspace --frozen-lockfile --ignore-scripts` so it does not install root/App dependencies.

## Release contents and order

Each `computer-use/releases/vVERSION/` contains the existing 15 verified release files, plus `SKILL.md`, `LICENSE.md`, `release-notes.md` and `manifest.json`. The three documents come from `git show RELEASE_COMMIT:PATH`, never the current checkout. The manifest records version, tag, commit, exact file sizes and SHA-256; its `publishedAt` field is the immutable GitHub **release `created_at`**, including while a release is a draft. This keeps the manifest identical across publish retries and later backfills. For v0.7.1 the snapshot timestamp is `2026-10-12T09:41:59Z`.

Versioned objects use immutable cache headers. `computer-use/latest.json` is byte-for-byte identical to the selected version's manifest and uses revalidation/no-cache headers. Version directories cannot overwrite different content, even if the caller owns the bucket. A changed release must use a new version.

The `Publish verified Release` workflow:

1. Validates the tag, exact successful CI commit and monotonic release version.
2. For a new release, prepares the same notarized macOS and two Windows packages, then saves all 15 bytes-exact files in a `verified-release-assets-TAG-COMMIT` Actions artifact **before** creating a draft.
3. Creates a draft, prepares the manifest, uploads only missing GitHub assets and verifies their names, sizes and SHA-256. Existing releases reuse their original bytes; no rebuilding or `--clobber`.
4. Checks COS latest, uploads the immutable version directory and reads every object back.
5. Publishes a new GitHub draft only after mirror staging succeeds. A retry of an already published version does not change GitHub's latest selection.
6. Revalidates the published GitHub release and all 18 anonymous mirror assets, then atomically replaces COS latest.

The main repository's release workflow finishes after the verified COS index is promoted. The website repository independently checks the public `latest.json` every 15 minutes, validates the complete release, generates its same-origin snapshot and deploys it only after those checks pass. A manual website sync is also available. No cross-repository token or dispatch is required. Scheduled Actions can run late; a successful App release does not mean the website has deployed immediately. If website validation or deployment fails, it keeps the previous verified snapshot until a later successful sync.

Both publishing and backfill workflows use the same `official-release-publish` concurrency group. They reject a version older than any published stable GitHub release or COS latest, preventing late retries from moving either source backward. GitHub workflow concurrency does not serialize manual writes or other systems; do not publish outside these workflows while one is running.

## Running and recovering

Run workflows from `main`, which contains maintained orchestration scripts. Build inputs and source documents remain pinned to the requested tag.

Pushing a stable `vMAJOR.MINOR.PATCH` tag automatically starts **Publish verified Release**. The tagged commit must contain this updated workflow and must have a matching `CI` run from a push to this repository's `main` branch. The workflow locates that exact commit's CI, waits at most three minutes for it to appear and at most 45 minutes for it to succeed, then uses that run's build artifacts. Failed or cancelled CI stops publication; a tag never bypasses CI or uses a pull-request/fork/manual run. Prerelease and malformed tags are rejected. If a GitHub workflow creates the tag, use an appropriately scoped GitHub App token or PAT when a downstream tag-push workflow must trigger; tag pushes produced by the default `GITHUB_TOKEN` do not trigger another workflow. See [GitHub workflow trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

The manual **Publish verified Release** entry remains available with `tag` and its successful `ci_run_id`. If the draft already has all 15 assets, retry normally: download and verify the existing files, then resume mirror publication.

A re-run of failed jobs first rechecks live release state and can reuse the current run’s preserved artifact automatically. If a new workflow run recovers a partial draft, set `recovery_run_id` to the original publishing run. The workflow downloads that run's exact `verified-release-assets-TAG-COMMIT` artifact, validates all package metadata, compares every existing GitHub asset, and uploads missing names only. It never replaces an existing asset or generates a newly signed package. A GitHub `starter` upload placeholder is explicitly rejected: inspect and remove only that unfinished placeholder in GitHub before retrying; completed `uploaded` assets are never replaced. Recovery artifacts are retained for 90 days. If they have expired or existing bytes conflict, stop and recover the original verified bytes; do not delete or silently rebuild the draft as part of a retry.

For an existing published release such as v0.7.1, run **Mirror published Release** with `tag=v0.7.1`. It uses current tools, downloads the published 15 assets, verifies the release, reads documents from the tag commit, uploads the mirror and promotes latest. The website discovers that index through its independent sync. Backfill does not edit GitHub's release or latest marker. Backfilling a version older than current latest is intentionally rejected; this workflow is for establishing or repairing the current official release mirror.

Before promotion, any integrity, upload or public-read verification failure leaves the old index in place. Promotion is a final single-object PUT. If that PUT or its following readback fails, the result may be uncertain: the new index may already exist. Retry the **same** release to read and verify it. Do not automatically restore an old index or downgrade. Versioning provides a manual recovery trail for operator-reviewed incidents; it is not an automatic rollback mechanism. Website sync failures do not change the verified published mirror and can be retried independently.

## Verification

```sh
node --test .github/scripts/prepare-release.test.mjs .github/scripts/publish-mirror.test.mjs .github/scripts/select-release-ci.test.mjs
```

Tests cover all 18 assets, metadata/commit/hash mismatches, immutable conflicts, partial draft recovery, upload/readback failure, idempotent retry, old-version rejection and uncertain promotion. Live acceptance additionally requires anonymous asset GET success, anonymous list/write/delete denial, and installation/update with GitHub deliberately unavailable. An empty or privately readable bucket is not a working download mirror.
