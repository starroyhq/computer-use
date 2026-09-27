# Implementation and release gates

This is a gate checklist, not a claim that all listed scenarios have passed.

| Stage | Implemented | Remaining gate |
|---|---|---|
| P0 | Fixed SDK/driver adapter, macOS and Windows hosts, disposable fixtures; earlier builds tested on macOS and Windows ARM64 | Repeat desktop acceptance after the identifier change; native Windows x64 validation, background focus and foreground gesture coverage |
| P1 | Shared schemas, grants, sessions, queue, journal, CLI, snapshots, stop/restart handling; fixture input and independent output checks | Held-input cleanup on interruption, lock/sleep and multi-monitor scenarios, ordinary second-user Windows pipe isolation |
| P2 | stdio/HTTP MCP, image results, CLI Skill, pairing/config generation; Mac Codex fixture runs locally and over SSH to Windows | Windows-local Codex and other agents, including Claude Code; broader model workflows. Protocol tests alone do not satisfy this |
| P3 | Isolated browser backend and real browser tests | Blender and Final Cut Pro workflow repetitions; real model task scoring |
| P4 | macOS packaging and Windows ARM64/x64 portable build scripts, notices, Chinese/English onboarding | Repackage and regress current Windows source; signed installers, macOS notarization, clean-user installation/uninstallation and verified support matrix |

Release thresholds remain: each deterministic driver scenario succeeds 10 consecutive times; each fixed-agent workflow is tested 10 times with at least 80% success. Wrong-window input, unapproved foreground activity, input after emergency stop and unsubstantiated success are blockers. Correct refusal of an unsupported action is recorded separately from completion.

Windows hosts and manual SSH access already exist; their validation limits are recorded in [validation results](validation-results.md). Earlier desktop evidence predates the current application identifier and must not be presented as current-build acceptance.

Later work: arbitrary trajectory gestures, per-client isolated browser contexts, dialog interaction, richer observable conditions, additional macOS versions and Intel packages, a Linux host, automatic tunnels and direct LAN HTTPS access. These are not advertised as existing features.
