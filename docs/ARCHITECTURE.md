# Architecture decisions

## One execution owner

The Swift AppKit host owns system permissions and directly spawns Cua Driver in embedded mode. A dedicated parent-liveness pipe ensures host death closes the daemon. The host also launches the Node runtime; it connects to the driver through the native SDK's private socket interface. No MCP server is needed for CLI actions.

The desktop adapter replaces its SDK client before the driver's five-minute implicit idle-session limit and reconnects once after a read-only transport failure. It never replays a dispatched input action after uncertainty.

Only the host's stdin pipe can approve pairing and listener changes. A pairing approval persists a grant that includes foreground control; sessions do not prompt again, and revocation removes the whole grant. Agent-facing RPC has no control-plane method or raw-driver escape hatch. Native launch configuration disables Cua telemetry/update checks and removes inherited Node/DYLD/Cua overrides. Local configuration does not provide a sandbox against the same OS user.

## Stable interface, replaceable adapters

`src/contracts.ts` defines backend observations and execution operations. `src/schema.ts` is the shared validation and tool-schema source. `src/runtime.ts` performs authorization, session ownership, leases, stale-snapshot rejection, deduplication and result recording. Cua 0.28.2 and Playwright 1.63.0 are behind independent adapters.

Capabilities describe the implemented subset. The Cua driver supports straight drags and line/page scrolling, so the public interface exposes those units instead of pretending it supports arbitrary paths or pixel-precise scrolling. Driver `action.effect` uncertainty is not converted into success.

## Observations

Adapters return backend element references, geometry and, where the platform exposes them, values and enabled/selected/range state. Password values are dropped inside the adapters: the Cua adapter discards values of secure or password roles and mask-only values (macOS reports a secure field as `AXTextField` whose value is U+F79A placeholders of the same length), and the browser adapter does not read password inputs. Dropped values never reach results or conditions. Windows UI Automation does not expose password text, but WinForms returns a localized access-denied placeholder that is passed through because the driver does not report the password flag. The desktop drivers omit empty values, so an empty field has no `value`.

The runtime assigns public element IDs and maps them back to backend references per snapshot, so driver tokens stay internal. Within a session an element keeps its ID while its role, label, tree depth and rounded bounds are unchanged; a new label or position produces a new ID, so a remembered ID cannot silently address different content. Results truncate values after 2,000 UTF-16 units and report `valueLength`; conditions compare the full value.

`observe` can omit the screenshot or the element list without changing snapshot rules. `since` returns only added or changed elements plus removed IDs, and only when it names the session's latest published element list; otherwise, or when no element carried over, the list is complete. `act` can attach the next observation. It is taken in the action's queue slot, reuses the observation that satisfied `verify`, is omitted after an `unknown` outcome, and is skipped with `observationError` when less than one second of the 60-second response budget remains. Observation failures never change the action record.

## Lifecycle and outcomes

The runtime keeps a private metadata-only action journal. An ID with different arguments is rejected; a repeated identical ID returns its known state. The `observe` option shapes only the response and is not part of an action's arguments. `queued` or `running` records found at restart become `unknown`, never replayed. Persisting action state must succeed before input dispatch; failures stop execution.

An action consumes its snapshot before being queued. Cancellation and authorization are checked again after async validation and journal writes. Both adapters report the moment input is dispatched; a timeout or cancellation before that point fails or cancels the action without sending input and does not stop the runtime. Aborting dispatched input cannot stop it, so when `timeoutMs` expires after dispatch the runtime waits up to 5 more seconds for the driver call to finish before treating the outcome as unknown. Interruption or transport uncertainty after desktop dispatch stops the runtime because aborting a client future cannot prove a native drag has stopped. The controlled browser declares its input contained: an interrupted browser action closes its page, and an uncertain browser outcome is recorded as `unknown` without stopping desktop work. Completed dispatch with an unconfirmed effect is `executed` with `effect: "unconfirmed"`, never `unknown`: delivery is certain, only its effect is unproven. It can be checked by a supplied read-only condition and does not require terminating a healthy driver. Journals written before this distinction are migrated on load by matching the former message exactly. The host terminates interrupted input as the final boundary; held-input cleanup still requires desktop validation.

`executed` is distinct from `verified`. Explicit element/title checks can verify an observable condition; they are not a substitute for inspecting saved project files, exported media or creative quality. Incomplete element trees cannot verify absence. Read-only waits honor their deadline, retry only stale observations and return the exact observation that satisfied the condition.

## Browser and data

The browser is a new headless Chromium context with a fixed CSS viewport and no normal user profile. Authorization covers the shared controlled-browser space, not a website allowlist. The adapter returns semantic elements from the main document and a screenshot, validates DOM/geometry state, dismisses JavaScript dialogs and stores downloads in unique directories. Existing user browser sessions, file URLs and arbitrary JavaScript execution are not exposed.

IPC and CLI image files are private to the current OS user. MCP returns images as image content rather than duplicating base64 into text. Default journals exclude screenshot contents, text, URLs and window titles. Diagnostic output contains fixed messages and status metadata.

## Packaging

The App includes a fixed Node runtime, a fixed embedded driver and production dependencies. It does not require globally installed Node/Rust. Debug builds use ad-hoc signing; Developer ID signing, notarization and a clean-user test are separate release gates. HTTP is disabled on each App launch and binds only loopback when explicitly enabled.
