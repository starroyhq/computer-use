# Validation

## Automated checks

```sh
pnpm check
pnpm native:test
pnpm native:build
node --test scripts/package.test.mjs
node scripts/package-app.mjs --verify-only
```

Runtime/storage tests use a fake backend to exercise authorization, races, deduplication and failures. Cua adapter tests check mapping against a fake native client. Neither proves desktop input works. Browser tests use the matching Playwright Chromium and a temporary local fixture server. Missing Chromium is reported as a skipped integration suite, not as desktop or browser success.

For Codex MCP integration, use `computer-use config codex --profile probe` with an already paired fixture-only profile. Parse its output as TOML, verify the absolute launcher and profile without exposing the credential, and use a temporary agent configuration for `targets → session_open → observe → act → observe → session_close`. Confirm the screenshot is delivered as MCP image content and the fixture output independently records the expected Chinese input. A protocol client run and a real model tool run are separate results. Do not replace the signed App solely to test a configuration change.

## Disposable desktop probe

Never use private documents as test fixtures. Build the included app and create a private evidence directory:

```sh
node scripts/build-fixture.mjs
mkdir -p .cache/probe
chmod 700 .cache/probe
open -n 'artifacts/Computer Use Fixture.app' --args --output "$PWD/.cache/probe/fixture-state.json"
computer-use pair --profile probe --name 'Desktop probe' --app com.starroy.computeruse.fixture
node dist/probe.js --fixture-output "$PWD/.cache/probe/fixture-state.json" --report "$PWD/.cache/probe/result.json"
```

Approve pairing in Computer Use.app. The probe selects the window titled `Computer Use Fixture` (AppKit also exposes untitled helper windows), opens a background session, resets the fixture, types Chinese through its AX field, clicks Record and checks the independent fixture output. The fixture also holds a secure text field with a fixed dummy value; the probe fails if any observation contains it. It repeats ten times by default. Each round requires a new reset-file write, exact Chinese text and a counter increment of one. Completed-but-unconfirmed driver dispatches are recorded as `executed` with `effect: "unconfirmed"` in the action journal and probe report; the probe does not replay them and only counts the round as passed when the separate fixture file confirms its effects. Other uncertain or failed actions stop the probe. Images are used in memory and not persisted by this probe. Close the fixture and revoke the probe client when done.

This probe does not validate arbitrary application compatibility, human/agent focus coexistence, signed-upgrade behavior or drag cancellation. Check those separately with a controlled frontmost typing fixture and explicit foreground authorization. Developer builds can change macOS permission identity after re-signing; never reset TCC globally.

## Creative application acceptance

Use a new, disposable Blender project: select/transform an object through the UI, orbit the viewport with modifiers, save to the task directory, reopen and inspect the object. Track failures separately for semantic controls and viewport gestures. Application scripting must not substitute for the GUI path being tested.

Use generated test media and a new Final Cut Pro library: import, split and move clips in the timeline, export to the task directory, then check readability and duration. Do not alter existing libraries. A tool return code or visible click alone is not export verification.

For agent evaluation record the exact agent/model configuration, task inputs, execution mode, attempts, manual interventions, tool errors, duration and independent output check. Do not turn correct refusals into successful completion. Run ten repetitions per published scenario.

## Distribution and external access

Verify resource completeness, native architectures and code signatures. Test the App from a clean macOS user account, including permissions, pairing, CLI installation, revocation, exit and restart. Confirm loopback-only HTTP and rejected foreign Origin/Host values. Public notarization requires the project's Developer ID credentials and an explicitly authorized upload; development packaging does not perform it.

See `docs/validation-results.md` for this workspace's actual run results and blockers.
