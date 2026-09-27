# Implementation and release gates

This is a gate checklist, not a claim that all listed scenarios have passed.

| Stage | Implemented | Remaining gate |
|---|---|---|
| P0 | Fixed SDK/driver adapter, macOS and Windows hosts, disposable fixtures; current ARM64 build passed 66 input cases and one Mac Codex model regression | Repeat macOS desktop acceptance after the identifier change; native Windows x64 validation and broader focus/gesture coverage |
| P1 | Shared schemas, grants, sessions, queue, journal, CLI, snapshots, stop/restart handling; fixture input and independent output checks | Held-input cleanup on interruption, lock/sleep and multi-monitor scenarios, ordinary second-user Windows pipe isolation |
| P2 | stdio/HTTP MCP, image results, CLI Skill, pairing/config generation; Mac Codex fixture runs locally and over SSH to Windows | Windows-local Codex and other agents, including Claude Code; broader model workflows. Protocol tests alone do not satisfy this |
| P3 | Isolated browser backend and real browser tests | Blender and Final Cut Pro workflow repetitions; real model task scoring |
| P4 | macOS packaging and Windows ARM64/x64 portable build scripts, notices, Chinese/English onboarding; current ARM64 portable package passed limited desktop acceptance | x64 repackaging and native acceptance; signed installers, macOS notarization, clean-user installation/uninstallation and broader support matrix |

Release thresholds remain: each deterministic driver scenario succeeds 10 consecutive times; each fixed-agent workflow is tested 10 times with at least 80% success. Wrong-window input, unapproved foreground activity, input after emergency stop and unsubstantiated success are blockers. Correct refusal of an unsupported action is recorded separately from completion.

Windows hosts and manual SSH access already exist; their validation limits are recorded in [validation results](validation-results.md). Current ARM64 fixture acceptance does not replace the ten-run model workflow release gate. Earlier macOS and x64 evidence must not be presented as current-build acceptance. Windows authorization dialog expiry and runtime-confirmed status have dedicated regression coverage; the prior acceptance ZIP predates that fix.

Later work: arbitrary trajectory gestures, per-client isolated browser contexts, dialog interaction, richer observable conditions, additional macOS versions and Intel packages, a Linux host, automatic tunnels and direct LAN HTTPS access. These are not advertised as existing features.
