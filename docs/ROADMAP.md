# Implementation and release gates

This is a gate checklist, not a claim that all listed scenarios have passed.

| Stage | Implemented | Remaining gate |
|---|---|---|
| P0 | Fixed SDK/driver adapter, native embedding host, disposable desktop fixture and probe | Real App TCC attribution, screenshots, Chinese input, background focus and foreground gesture evidence |
| P1 | Shared schemas, grants, sessions, queue, journal, CLI, snapshots, stop/restart handling | Desktop end-to-end execution and held-input cleanup on interruption |
| P2 | stdio/HTTP MCP, image results, CLI Skill, pairing/config generation; Codex fixture-only model/tool run | Claude Code model/tool run and broader agent workflows; protocol tests alone do not satisfy this |
| P3 | Isolated browser backend and real browser tests | Blender and Final Cut Pro workflow repetitions; real model task scoring |
| P4 | Reproducible packaging scripts, notices, Chinese/English documentation | Developer ID signing, notarization, clean-user installation/uninstallation and verified support matrix |

Release thresholds remain: each deterministic driver scenario succeeds 10 consecutive times; each fixed-agent workflow is tested 10 times with at least 80% success. Wrong-window input, unapproved foreground activity, input after emergency stop and unsubstantiated success are blockers. Correct refusal of an unsupported action is recorded separately from completion.

Later work: arbitrary trajectory gestures, per-client isolated browser contexts, dialog interaction, richer observable conditions, additional macOS versions and Intel packages, Windows/Linux backends, explicitly authorized remote access. These are not advertised as existing features.
