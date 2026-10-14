# COS fallback acceptance — 2026-10-14

This record covers the local implementation and the cloud configuration observed during acceptance. Local packages include pre-existing work in the checkout and are validation artifacts, not replacements for published v0.7.1 assets. The initial evidence below was collected before Git rollout; it does not claim a new App release.

## Verified implementation

- `pnpm check`: passed. TypeScript and Biome passed; 359 application tests passed; the script group passed 90 tests with 36 Windows-only tests skipped on macOS; all 37 npm tests passed.
- The six CI-selection tests subsequently added to `pnpm check` passed separately. Release preparation, mirror publication and CI selection passed 38 tests in total. After the Windows process-handle fix, the maintained Skill sync check and 54 macOS-bootstrap/npm-package tests passed again; App, DMG and npm packages were rebuilt from the final scripts.
- `pnpm native:test`: 31 passed, two skipped, no failures.
- `pnpm package:app` and `pnpm package:dmg`: passed. The ARM64 bundle, six signed native components, bundled Node/driver, CLI, native SDK import and mounted DMG contents/signature were verified.
- `pnpm package:npm`: passed; both maintained bootstrap scripts are bundled. No cloud credentials or publishing SDK are in the launcher.
- Windows 11 ARM64 VM: 38 bootstrap tests (including real child-process exit 0/23 regressions), 26 updater tests, 11 package/authentication tests (one macOS-only skip), and 16 Host/UI test groups passed. The UI harness saved 24 screenshots. ARM64 and x64 portable bundles passed build and `--verify-only`; x64 runtime/native imports ran under emulation. Both final Setup EXEs also compiled and passed `--verify-only` after the process-handle fix. The generated installers were not executed.
- Website: final type/lint/format checks, 43 tests and 13-page build passed. Independent review reran all 12 synchronization tests. The final live, verified dual-source snapshot passed 29 behavioral smoke checks and 72 screenshots covering four languages, two themes and three viewports. No console, overflow or axe A/AA issues were reported. A real no-argument local synchronization fetched the COS latest index, retained `cosReady: true`, and emitted `changed=false`. Moving website synchronization from scheduled Actions to the local workflow does not alter the UI.

Evidence is retained locally under `artifacts/cos/`, `.cache/cos-windows-validation-20261014-5e5b52dd/` and `/tmp/cu-cos-website-live-qa/`. The generated Chinese distribution preview is `artifacts/skillhub/cos-preview/computer-use-skillhub-cos-preview-zh-CN.zip`; its two embedded scripts exactly match the maintained English source scripts. It has not been uploaded to SkillHub.

## Commit isolation validation

Before committing, the COS-only index was exported to a separate directory. Existing authorization-upgrade changes were excluded, including their additions to shared Skill files; SKILL.md was regenerated from the staged template, bootstrap scripts and unchanged HEAD instructions. `pnpm check` passed on that exact snapshot: 338 application tests, 96 script tests (38 Windows-only skips), and 37 npm tests. Skill synchronization, actionlint, staged diff checks and the staged secret-pattern scan passed. The original working-tree changes were preserved.

## Live cloud observations

Bucket: `computer-use-download-1308799022`, Guangzhou, single AZ. The following were applied and read back in the console:

- Bucket ACL remains private. Anonymous policy permits only `GetObject` under `computer-use/*`.
- Versioning is enabled; default encryption is SSE-COS.
- Lifecycle `computer-use-release-retention`: current objects retained, noncurrent versions expire after 30 days, incomplete multipart uploads expire after seven days.
- Custom policy `ComputerUseReleasePublisher` permits only `GetObject` and `PutObject` for this prefix; no list/delete permissions.
- Enabled alarm policy `cos-computer-use-download-release-alarm` (`policy-qg2zl08a`) is bound only to this bucket and reuses the existing system notification template (one recipient). It triggers for standard-storage reads over 10,000 per minute for three consecutive points (hourly reminders), or internet download traffic over 5,000 MiB in one minute (daily reminders). The latter matches the existing download buckets. These are static starting thresholds; notification delivery was not forced during acceptance.

Anonymous probes: a published platform metadata GET returned 200; bucket listing, reading outside the public prefix, uploading a unique nonexistent probe key, and deleting that never-created key each returned 403. HEAD is also denied by the GetObject-only policy; acceptance uses GET.

The initial v0.7.1 upload uses the original 15 GitHub release assets plus three documents from commit `aceabc6409b3b75d42c8e4156e578daeca803e09`. The manifest records GitHub release creation time `2026-10-12T09:41:59Z`. Versioned objects use standard storage, SSE-COS and immutable cache headers. All 19 objects passed anonymous full byte/hash verification. `latest.json` was then uploaded and read back byte-for-byte identical to the manifest (3,294 bytes, SHA-256 `5b5854ca2f4b6f43a09ddbbe1c23ad06710018e02c21d85ed91cf56f90cefa0c`), with `no-cache, max-age=0, must-revalidate` and SSE-COS. The website independently validated the complete mirror and generated its `cosReady: true` snapshot. All three platforms also passed live update checks with GitHub deliberately blocked.

A real updater download with all GitHub requests deliberately rejected succeeded from COS for the pinned macOS v0.7.1 installer: 93,329,587 bytes, SHA-256 `dbc6a888287bcc4eb1994aafa9512553ecb56cf9d42b7f2311f0c8f3e54c8161`. The release commit and metadata matched. This test downloaded without installing; it did not rely on an unpublished latest index. Requests/results are in `artifacts/cos/live-updater-fallback.json`.

## Remote rollout results

- The dedicated CAM identity's `COS_SECRET_ID` / `COS_SECRET_KEY` were saved in GitHub Secrets without reading their values. [Mirror published Release run 38554217058](https://github.com/starroyhq/computer-use/actions/runs/38554217058) completed successfully, verifying the real Actions credential and mirror publication path.
- EdgeOne deployment `dppglx4duvkk` deployed website commit `1cb7b4b`; the live site passed 29 behavioral acceptance checks.
- The user selected local website synchronization and builds for the private repository. The maintained flow is `pnpm release:sync` → `pnpm check` (including the local build) → review and push the snapshot commit → the existing EdgeOne Git deployment. There is no scheduled website Action, cross-repository token or Billing change. App CI and tag-triggered release publication to COS remain automatic in the public App repository.
- [CI run 38554504621](https://github.com/starroyhq/computer-use/actions/runs/38554504621) passed at implementation commit `f0edd4a`: macOS ARM64, Windows ARM64 and Windows x64 checks and development-package jobs all succeeded. [Workflow Lint run 38554504577](https://github.com/starroyhq/computer-use/actions/runs/38554504577) also passed. These development packages are not a new App release.

## Remaining rollout gates

- Validate the new-version tag-triggered publish flow when the next App release is authorized. The successful existing-version mirror run does not replace that release acceptance.
- Live no-App installation with GitHub blocked and end-to-end npm/Skill launch remains to be validated in an isolated environment. The available Windows user already has another task's running portable Host and existing app/credential data; the installer shares its AppId and would stop that Host. We did not stop it, hide the installation, delete credentials, or claim a clean first-install pass. The read-only isolation evidence is `first-install-isolation.json` in the Windows validation directory. Fixtures test the exact embedded scripts but are not a production installation.
- The immutable v0.7.1 `SKILL.md` still contains its original GitHub-only bootstrap. New SkillHub/npm artifacts carry fallback support, but the setup prompt's versioned Skill fallback is fully usable only after a new official release containing the updated Skill is mirrored. Do not rewrite v0.7.1 to hide this boundary.

Real desktop pairing/actions were not repeated for this download-only change. A clean-machine first installation and the next new-version App publication remain unverified; local packaging, the successful existing-version mirror workflow and the live website deployment do not substitute for those checks.
