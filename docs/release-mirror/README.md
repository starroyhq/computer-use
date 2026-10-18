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
3. Creates a draft, uploads only missing GitHub assets and verifies their names, sizes and SHA-256. Existing releases reuse their original bytes; no rebuilding or `--clobber`.
4. Publishes the verified GitHub release directly. A retry of an already published version does not change GitHub's latest selection.
5. Queues **Mirror published Release** on `main` with that exact published tag. Only this dispatch job receives `actions: write`; it does not receive COS credentials or wait for the mirror to finish.

COS synchronization runs automatically in the separate **Mirror published Release** workflow after successful GitHub publication. Explicit `workflow_dispatch` works with the repository's `GITHUB_TOKEN`; a `release: published` listener alone would not run for releases created by that token. Manual dispatch remains available for retrying an already published tag. The mirror prepares the manifest, checks COS latest, uploads and reads back the immutable version directory, verifies all 18 public mirror assets, then atomically promotes COS latest. A mirror failure does not prevent or undo a GitHub release, and its status is reported by the separate mirror run.

The public App repository's CI and tag-triggered GitHub release automation remain enabled. Website synchronization remains a separate local operation in the private website repository; it does not use scheduled GitHub Actions or require a Billing change, cross-repository token or dispatch. Run `pnpm release:sync` to read the public `latest.json`, validate the complete release and generate the same-origin snapshot, then run `pnpm check` (including the local build). Review and commit the verified snapshot and push it through the normal Git workflow. The existing EdgeOne Git integration then builds and deploys that commit. A successful App release does not update the website by itself. If local validation or deployment fails, the public site continues serving its previous verified snapshot until a successful update.

Both publishing and mirror workflows use the same `official-release-publish` concurrency group with `queue: max`. This retains up to 100 pending runs instead of allowing a new mirror to cancel an already queued release; see [GitHub concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency). Dispatch must return immediately so the publishing run can release this lock; waiting for the mirror inside that run would deadlock. GitHub publication rejects a version older than a published stable release; mirror backfills additionally check COS latest. This prevents late retries from moving either source backward. GitHub workflow concurrency does not serialize manual writes or other systems; do not publish outside these workflows while one is running.

## Running and recovering

Run workflows from `main`, which contains maintained orchestration scripts. Build inputs and source documents remain pinned to the requested tag.

Pushing a stable `vMAJOR.MINOR.PATCH` tag automatically starts **Publish verified Release**. The tagged commit must contain this updated workflow and must have a matching `CI` run from a push to this repository's `main` branch. The workflow locates that exact commit's CI, waits at most three minutes for it to appear and at most 45 minutes for it to succeed, then uses that run's build artifacts. Failed or cancelled CI stops publication; a tag never bypasses CI or uses a pull-request/fork/manual run. Prerelease and malformed tags are rejected. If a GitHub workflow creates the tag, use an appropriately scoped GitHub App token or PAT when a downstream tag-push workflow must trigger; tag pushes produced by the default `GITHUB_TOKEN` do not trigger another workflow. See [GitHub workflow trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

The manual **Publish verified Release** entry remains available with `tag` and its successful `ci_run_id`. If the draft already has all 15 assets, retry normally: download and verify the existing files, then publish the GitHub release.

If the final dispatch job fails, the GitHub release remains published. Re-run that failed job or manually dispatch **Mirror published Release** with the same tag. If dispatch succeeds but uploading or verification fails later, retry the mirror run itself. Repeated dispatches are safe because each mirror validates the immutable version bytes and refuses to move the index backward. Do not wait for the mirror while the publishing run is active, and do not interpret the publishing run's successful queue operation as completed COS verification.

A re-run of failed jobs first rechecks live release state and can reuse the current run’s preserved artifact automatically. If a new workflow run recovers a partial draft, set `recovery_run_id` to the original publishing run. The workflow downloads that run's exact `verified-release-assets-TAG-COMMIT` artifact, validates all package metadata, compares every existing GitHub asset, and uploads missing names only. It never replaces an existing asset or generates a newly signed package. A GitHub `starter` upload placeholder is explicitly rejected: inspect and remove only that unfinished placeholder in GitHub before retrying; completed `uploaded` assets are never replaced. Recovery artifacts are retained for 90 days. If they have expired or existing bytes conflict, stop and recover the original verified bytes; do not delete or silently rebuild the draft as part of a retry.

Mirror logs include public object keys, attempt numbers, request durations, upload byte progress and a 15-second heartbeat, without signed requests or credentials. Each PUT uses a new 64 KiB byte stream with the verified ContentLength and SSE-COS. The SDK's 60-second socket idle timeout is supplemented by a 10-minute total deadline that cancels the actual request, including when the body was sent but no response arrived. SIGINT/SIGTERM cancels the active upload and stops the process.

Immutable files have at most three explicit attempts for transient connection errors, throttling and selected server failures. Before another PUT, an authenticated GET must confirm the object is absent; identical committed bytes count as success, different bytes or an inconclusive read stop immediately. Authorization errors, integrity failures and cancellation do not retry. The index PUT is never retried inside the transport: rerun the same release so the latest-version and content checks run again. This uses the existing GetObject/PutObject permissions and does not require multipart access or delete permissions.

For an existing published release such as v0.7.1, run **Mirror published Release** with `tag=v0.7.1`. It uses current tools, downloads the published 15 assets, verifies the release, reads documents from the tag commit, uploads the mirror and promotes latest. The website discovers that index during its next local `pnpm release:sync` run. Backfill does not edit GitHub's release or latest marker. Backfilling a version older than current latest is intentionally rejected; this workflow is for establishing or repairing the current official release mirror.

For a real upload acceptance check when all version files already exist, manually enable `verify_upload` on **Mirror published Release**. To exercise automatic dispatch and a real upload together, run **Publish verified Release** for the already-published tag and its original successful `ci_run_id`, with `verify_mirror_upload=true`; it reuses the original release bytes and forwards that flag to the mirror. The mirror uploads the largest verified public release file under the isolated `computer-use/verification/uploads/RUN_ID-ATTEMPT/` prefix, then verifies its bytes. This does not replace any formal release object or change the index before normal verification completes. The probe contains only already-public release bytes and remains in storage; the publisher has no delete permission. Leave these options off for normal publication, where new release files already exercise real uploads.

Before promotion, any integrity, upload or public-read verification failure leaves the old index in place. Promotion is a final single-object PUT. If that PUT or its following readback fails, the result may be uncertain: the new index may already exist. Retry the **same** release to read and verify it. Do not automatically restore an old index or downgrade. Versioning provides a manual recovery trail for operator-reviewed incidents; it is not an automatic rollback mechanism. Website sync failures do not change the verified published mirror and can be retried independently.

## Verification

```sh
node --test .github/scripts/prepare-release.test.mjs .github/scripts/publish-mirror.test.mjs .github/scripts/cos-upload.test.mjs .github/scripts/select-release-ci.test.mjs .github/scripts/release-mirror-trigger.test.mjs
```

Tests cover all 18 assets, metadata/commit/hash mismatches, immutable conflicts, partial draft recovery, upload/readback failure, idempotent retry, old-version rejection and uncertain promotion. Live acceptance additionally requires anonymous asset GET success, anonymous list/write/delete denial, and installation/update with GitHub deliberately unavailable. An empty or privately readable bucket is not a working download mirror.
