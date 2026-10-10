# Windows input fixture

`ComputerUse.WindowsFixture` is a disposable desktop input app. Its default mode uses a WinForms `TextBox`; `--win32` creates a raw Win32 `EDIT` child HWND; `--wpf` hosts a WPF `TextBox` through `ElementHost`. The three modes use the same executable identity and separate result files. It does not open user documents or store credentials or screenshots.

Build on Windows ARM64 with .NET 10:

```powershell
dotnet publish .\ComputerUse.WindowsFixture\ComputerUse.WindowsFixture.csproj -c Release -r win-arm64 --self-contained true -o .\publish
```

Run `ComputerUse.WindowsFixture.exe` in the **interactive login session**. Add `--win32` or `--wpf` to select those controls. Each window contains an Edit element, `Record` and `Reset` buttons, a WinForms password box (`Probe secret`) holding a fixed dummy value that observations must never expose, and a status label. The default result file is `%LOCALAPPDATA%\Computer Use Fixture\result.json`; the other modes write `win32-result.json` and `wpf-result.json` in that directory. At startup each mode writes `ready` with count 0, `Record` writes the full current text and increments `recordCount`, and `Reset` clears both. The JSON includes `updatedAtUtc` and `textChanges`, an in-memory trace of UTC time, monotonic elapsed milliseconds and UTF-16 text length for each change since Reset. Read the file after Record to verify the result independently of the automation tool's response; no file writes occur per keystroke. The raw Win32 Edit has no accessibility name; select it by its Edit role within the fixture window.

For all-application and same-process multi-window acceptance, launch separate copies of the published fixture from **different local Windows paths** (not UNC paths). Give each process a fresh, disposable absolute result directory:

```powershell
& 'C:\Acceptance\alpha\ComputerUse.WindowsFixture.exe' --result-dir 'C:\Acceptance\results-alpha' --window-label 'AllApps Alpha' --multi-window
```

`--multi-window` requires `--result-dir` and adds a `New Window` button. It creates another real top-level window in the same process, without requesting foreground activation; closing the final window exits the process. Each window writes `<mode>-window-<number>-result.json` and includes `processId`, `windowTitle` and `windowNumber`. Reset and Record affect only that window. Create the second application and additional window after pairing, then independently check their result files and unchanged guard files while monitoring foreground focus. Reusing a result directory overwrites the corresponding startup evidence; choose a fresh directory for each run. Without these options, the original titles, single-window behavior and result paths remain unchanged.

## Host UI regression harness

From the repository root, run on an interactive Windows desktop with .NET 10:

```powershell
dotnet run --project validation/windows/ComputerUse.WindowsHostTests
dotnet run --project validation/windows/ComputerUse.WindowsHostTests -- --screenshots .\artifacts\windows-host-ui
```

These modes use a fake backend and temporary settings data. They open the real WinForms settings and authorization windows with simulated clients and events; they do not start the Node/Cua runtime, grant real permissions or automate another application. Tests cover approval expiry and withdrawal, queued requests, runtime confirmation, default denial, all-application versus scoped pairing, revocation control state, Pause/Resume, Emergency Stop, restart, settings persistence and installed/portable update states.

The settings window has six sidebar sections: Status, Clients, Connect, General, Updates and About. Tests check English and Simplified Chinese at normal and minimum window sizes, keep Emergency Stop reachable on every page, and check pairing dialog layout with long identities and application lists. Status links to pairing setup; Connect offers the pairing command and stdio configuration for copying. Authorization displays identity, desktop scope, browser access, foreground permission, duration and execution behavior separately, with denial as the default.

`--screenshots` saves both languages: all six normal settings pages, the installed update state, narrow Clients/Connect/Updates windows, and all-application and multiple-path scoped pairing dialogs. Filenames start with `en-` or `zh-`; narrow windows end in `-narrow.png`, and pairing files contain `pairing-all-apps` or `pairing-scoped-paths`. The screenshot data is simulated. The separate `--live-update <old-package-folder>` mode runs that package's CLI to check and download a real release and requires network access.

The current installer targets Windows 10 1809 (build 17763) and later, matching the host's WinForms target. Windows 10 acceptance on a real system remains pending; UI tests and screenshots do not establish desktop screenshot/input correctness. Existing acceptance remains limited to the Windows 11 ARM64 VM described in the [validation record](../../docs/validation-results.md), with native x64 desktop acceptance also pending. On Windows 10 ARM64, build and verify native ARM64 packages; x64 package checks on an ARM64 host require Windows 11 x64 emulation. All-desktop-application authorization does not include the isolated browser: its current Playwright backend [requires Windows 11 or later upstream](https://playwright.dev/docs/intro#system-requirements), and its x64 Chromium cannot run on Windows 10 ARM64.
