# Windows input fixture

`ComputerUse.WindowsFixture` is a disposable desktop input app. Its default mode uses a WinForms `TextBox`; `--win32` creates a raw Win32 `EDIT` child HWND; `--wpf` hosts a WPF `TextBox` through `ElementHost`. The three modes use the same executable identity and separate result files. It does not open user documents or store credentials or screenshots.

Build on Windows ARM64 with .NET 10:

```powershell
dotnet publish .\ComputerUse.WindowsFixture\ComputerUse.WindowsFixture.csproj -c Release -r win-arm64 --self-contained true -o .\publish
```

Run `ComputerUse.WindowsFixture.exe` in the **interactive login session**. Add `--win32` or `--wpf` to select those controls. Each window contains an Edit element, `Record` and `Reset` buttons, and a status label. The default result file is `%LOCALAPPDATA%\Computer Use Fixture\result.json`; the other modes write `win32-result.json` and `wpf-result.json` in that directory. At startup each mode writes `ready` with count 0, `Record` writes the full current text and increments `recordCount`, and `Reset` clears both. The JSON includes `updatedAtUtc` and `textChanges`, an in-memory trace of UTC time, monotonic elapsed milliseconds and UTF-16 text length for each change since Reset. Read the file after Record to verify the result independently of the automation tool's response; no file writes occur per keystroke. The raw Win32 Edit has no accessibility name; select it by its Edit role within the fixture window.
