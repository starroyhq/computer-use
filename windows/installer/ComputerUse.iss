; Computer Use 的 Windows 安装程序（Inno Setup 7.0.2 及以上：从这个版本起简体中文是官方语言）。
; 由 scripts/package-windows-installer.mjs 传入：AppVersion、Arch（arm64 / x64）、SourceDir（已校验的便携目录）、
; OutputDir 与 OutputName。按当前用户安装，不需要管理员权限；配对凭据与设置在 %LOCALAPPDATA%\Computer Use，卸载时保留。

#ifndef AppVersion
  #error "Define AppVersion"
#endif
#ifndef Arch
  #error "Define Arch"
#endif
#ifndef SourceDir
  #error "Define SourceDir"
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifndef OutputName
  #define OutputName "computer-use-" + AppVersion + "-windows-" + Arch + "-setup"
#endif
#define HostExe "ComputerUse.WindowsHost.exe"

[Setup]
; 固定不变：托盘程序和打包脚本用它识别安装版；改动后升级会变成另一个程序。
AppId={{6C2B9F4E-4B7A-4E0F-9C59-3B1D2F8A7E41}
AppName=Computer Use
AppVersion={#AppVersion}
AppVerName=Computer Use {#AppVersion}
AppPublisher=Starroy
AppPublisherURL=https://github.com/starroyhq/computer-use
AppSupportURL=https://github.com/starroyhq/computer-use/issues
AppUpdatesURL=https://github.com/starroyhq/computer-use/releases
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName=Computer Use
VersionInfoDescription=Computer Use Setup
; 当前用户模式下 {autopf} 为 %LOCALAPPDATA%\Programs。首次安装可以换目录，升级沿用原目录。
DefaultDirName={autopf}\Computer Use
DisableDirPage=auto
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
SetupIconFile={#SourcePath}..\..\assets\app-icon.ico
SetupMutex=ComputerUseSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no
UninstallDisplayName=Computer Use
UninstallDisplayIcon={app}\{#HostExe}
; 由 [Code] 用 --quit 请托盘程序先停止服务再退出，不交给重启管理器强行关闭。
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[CustomMessages]
english.StillRunning=Computer Use is still running. Quit it from its notification-area icon (Quit Computer Use), then click Retry.
chinesesimplified.StillRunning=Computer Use 仍在运行。请在通知区域的 Computer Use 图标上选择“退出 Computer Use”，然后点“重试”。
english.SetupStopped=Setup stopped because Computer Use is still running.
chinesesimplified.SetupStopped=Computer Use 仍在运行，安装已停止。

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; 升级前删除旧版本的组件目录，避免留下已经不用的依赖；只在目录里确实是本程序时执行。
Type: filesandordirs; Name: "{app}\bin"; Check: IsComputerUseInstallation
Type: filesandordirs; Name: "{app}\runtime"; Check: IsComputerUseInstallation
Type: filesandordirs; Name: "{app}\node_modules"; Check: IsComputerUseInstallation
Type: filesandordirs; Name: "{app}\licenses"; Check: IsComputerUseInstallation
Type: filesandordirs; Name: "{app}\skills"; Check: IsComputerUseInstallation
Type: filesandordirs; Name: "{app}\helpers"; Check: IsComputerUseInstallation

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Computer Use"; Filename: "{app}\{#HostExe}"
Name: "{autodesktop}\Computer Use"; Filename: "{app}\{#HostExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#HostExe}"; Description: "{cm:LaunchProgram,Computer Use}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: dirifempty; Name: "{app}"

[Code]
const
  HostExe = '{#HostExe}';
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  ApprovedKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run';
  StartupValue = 'Computer Use';

function GetCurrentProcessId: DWORD;
  external 'GetCurrentProcessId@kernel32.dll stdcall';
function ProcessIdToSessionId(ProcessId: DWORD; var SessionId: DWORD): BOOL;
  external 'ProcessIdToSessionId@kernel32.dll stdcall';

{ 目标目录里确实是本程序（便携包与安装版都带这个构建记录）。 }
function IsComputerUseInstallation: Boolean;
var
  Receipt: AnsiString;
begin
  Result := False;
  if LoadStringFromFile(ExpandConstant('{app}\build-receipt.json'), Receipt) then
    Result := Pos('computer-use-windows-', Receipt) > 0;
end;

{ 当前会话中正在运行的 Computer Use 托盘程序，不论它从哪个位置启动。 }
function RunningHosts(var Paths: TArrayOfString): Integer;
var
  Locator, Service, Items, Item: Variant;
  Session: DWORD;
  I: Integer;
begin
  Result := 0;
  SetArrayLength(Paths, 0);
  if not ProcessIdToSessionId(GetCurrentProcessId, Session) then
    Exit;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Items := Service.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE Name = ''' + HostExe +
      ''' AND SessionId = ' + IntToStr(Session));
    Result := Items.Count;
    SetArrayLength(Paths, Result);
    for I := 0 to Result - 1 do
    begin
      Item := Items.ItemIndex(I);
      if not VarIsNull(Item.ExecutablePath) then
        Paths[I] := Item.ExecutablePath;
    end;
  except
    Result := 0;
    SetArrayLength(Paths, 0);
  end;
end;

{ --quit 请正在运行的实例先停止服务、释放按键再退出，并等它退出；不支持的旧版本会立即返回。 }
procedure AskHostsToQuit(const Installed: String);
var
  Paths: TArrayOfString;
  Count, I, Code: Integer;
begin
  if FileExists(Installed) then
    Exec(Installed, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Count := RunningHosts(Paths);
  for I := 0 to Count - 1 do
    if (Paths[I] <> '') and FileExists(Paths[I]) then
      Exec(Paths[I], '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ 进程退出后还要等系统释放文件，最多等 5 秒。 }
function HostsStopped: Boolean;
var
  Paths: TArrayOfString;
  Attempt: Integer;
begin
  Result := False;
  for Attempt := 1 to 20 do
  begin
    if RunningHosts(Paths) = 0 then
    begin
      Result := True;
      Exit;
    end;
    Sleep(250);
  end;
end;

function CloseRunningHosts(const Installed: String): Boolean;
begin
  while True do
  begin
    AskHostsToQuit(Installed);
    if HostsStopped then
    begin
      Result := True;
      Exit;
    end;
    { 静默安装时没有人能处理提示：直接按“取消”处理。 }
    if SuppressibleMsgBox(CustomMessage('StillRunning'), mbError, MB_RETRYCANCEL, IDCANCEL) = IDCANCEL then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not CloseRunningHosts(ExpandConstant('{app}\' + HostExe)) then
    Result := CustomMessage('SetupStopped');
end;

{ 删除指向本安装目录的开机启动项（设置窗口“登录时启动”写入的当前用户 Run 项）。 }
procedure RemoveStartupEntry;
var
  Command: String;
begin
  if RegQueryStringValue(HKCU, RunKey, StartupValue, Command) then
    if Pos(Lowercase(AddBackslash(ExpandConstant('{app}'))), Lowercase(Command)) > 0 then
    begin
      RegDeleteValue(HKCU, RunKey, StartupValue);
      RegDeleteValue(HKCU, ApprovedKey, StartupValue);
    end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    { 用户确认卸载后才请托盘程序退出；它仍在运行且用户选择取消时停止卸载，不删除任何文件。 }
    if not CloseRunningHosts(ExpandConstant('{app}\' + HostExe)) then
      Abort;
    RemoveStartupEntry;
  end;
end;
