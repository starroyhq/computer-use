param([string]$Hint = '')
# Standalone bootstrap v1. Discovery/installation only; never starts the Host.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'
$work = $null
$mutex = $null
$locked = $false

function Get-NativeArchitecture {
    if (-not ('ComputerUseBootstrapNativeV1' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ComputerUseBootstrapNativeV1 {
    [DllImport("kernel32.dll")]
    public static extern void GetNativeSystemInfo(IntPtr information);
}
'@
    }
    $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal(64)
    try {
        [ComputerUseBootstrapNativeV1]::GetNativeSystemInfo($pointer)
        switch ([Runtime.InteropServices.Marshal]::ReadInt16($pointer)) {
            12 { return 'arm64' }
            9 { return 'x64' }
            default { throw 'Only native Windows ARM64 and x64 are supported.' }
        }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
}

function Read-BoundedJson([string]$Path) {
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -gt 65536) { throw 'Package JSON exceeds the size limit.' }
    return [IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

function Test-Package([string]$Path, [string]$Architecture) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    if ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    foreach ($file in @('ComputerUse.WindowsHost.exe', 'bin\node.exe', 'bin\cua-driver.exe',
        'runtime\cli.js', 'runtime\host.js', 'package.json', 'build-receipt.json', 'skills\computer-use\SKILL.md')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $file) -PathType Leaf)) { return $false }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Path 'node_modules') -PathType Container)) { return $false }
    try {
        $receipt = Read-BoundedJson (Join-Path $Path 'build-receipt.json')
        return $receipt.owner -ceq "computer-use-windows-$Architecture-package-v1" -and $receipt.arch -ceq "win-$Architecture"
    } catch { return $false }
}

function Get-Installations([string]$PackageHint, [string]$Architecture) {
    if ($PackageHint) {
        $candidate = [IO.Path]::GetFullPath($PackageHint)
        if ($candidate.EndsWith('\runtime\cli.js', [StringComparison]::OrdinalIgnoreCase)) {
            $candidate = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($candidate))
        } elseif ($candidate.EndsWith('\bin\node.exe', [StringComparison]::OrdinalIgnoreCase)) {
            $candidate = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($candidate))
        }
        if (-not (Test-Package $candidate $Architecture)) {
            throw 'The hinted package is missing, incomplete or for another architecture. Review the binding; omit Hint to discover standard locations.'
        }
        return $candidate
    }
    $candidates = @((Join-Path $env:LOCALAPPDATA 'Programs\Computer Use'))
    $key = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6C2B9F4E-4B7A-4E0F-9C59-3B1D2F8A7E41}_is1'
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        $entry = $null
        try {
            $entry = $hive.OpenSubKey($key)
            if ($entry) {
                $location = $entry.GetValue('InstallLocation', $null)
                if ($location) { $candidates += [string]$location }
            }
        } finally { if ($entry) { $entry.Dispose() }; $hive.Dispose() }
    }
    $found = @()
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        $candidate = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
        if (Test-Path -LiteralPath $candidate) {
            if (-not (Test-Package $candidate $Architecture)) {
                throw "An incomplete, unknown or different-architecture installation exists at $candidate. Review it before installing."
            }
            if ($found -notcontains $candidate) { $found += $candidate }
        }
    }
    if ($found.Count -gt 1) { throw 'Multiple installations exist. Run again with the intended package path as Hint.' }
    if ($found.Count -eq 1) { return $found[0] }
    return $null
}

function Assert-TrustedUri([Uri]$Uri) {
    if (-not $Uri.IsAbsoluteUri -or $Uri.Scheme -cne 'https' -or $Uri.UserInfo -or -not $Uri.IsDefaultPort -or
        $Uri.Fragment -or ($Uri.Host -cne 'github.com' -and $Uri.Host -cne 'api.github.com' -and
        -not $Uri.Host.EndsWith('.githubusercontent.com', [StringComparison]::Ordinal))) {
        throw 'Download redirected to an untrusted address.'
    }
}

function Open-Response([Uri]$Uri, [int]$TimeoutMilliseconds) {
    Assert-TrustedUri $Uri
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.UserAgent = 'computer-use-bootstrap/1'
    try { return $request.GetResponse() }
    catch [Net.WebException] {
        if ($_.Exception.Response) { $_.Exception.Response.Dispose() }
        throw 'Release download failed or was blocked. Check network/system policy and retry without changing the trusted source.'
    }
}

function Get-OfficialFile([Uri]$Uri, [string]$Output, [long]$MaximumBytes, [int]$Seconds) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    for ($hop = 0; $hop -le 5; $hop++) {
        $remaining = $Seconds * 1000 - [int]$watch.ElapsedMilliseconds
        if ($remaining -le 0) { throw 'Download timed out.' }
        $response = Open-Response $Uri $remaining
        try {
            $status = [int]$response.StatusCode
            if (@(301, 302, 303, 307, 308) -contains $status) {
                $location = $response.Headers['Location']
                if (-not $location) { throw 'Download redirect has no destination.' }
                $Uri = [Uri]::new($Uri, $location)
                continue
            }
            if ($status -ne 200) { throw "Download server returned HTTP $status." }
            if ($response.ContentLength -gt $MaximumBytes) { throw 'Download exceeds the expected size.' }
            $downloadStream = $response.GetResponseStream()
            $file = $null
            try {
                $file = [IO.File]::Open($Output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $buffer = New-Object byte[] 65536
                [long]$total = 0
                while ($true) {
                    $remaining = $Seconds * 1000 - [int]$watch.ElapsedMilliseconds
                    if ($remaining -le 0) { throw 'Download timed out.' }
                    $downloadStream.ReadTimeout = $remaining
                    $count = $downloadStream.Read($buffer, 0, $buffer.Length)
                    if ($count -eq 0) { break }
                    $total += $count
                    if ($total -gt $MaximumBytes) { throw 'Download exceeds the expected size.' }
                    $file.Write($buffer, 0, $count)
                }
                $file.Flush()
            } finally { if ($file) { $file.Dispose() }; $downloadStream.Dispose() }
            return
        } finally { $response.Dispose() }
    }
    throw 'Too many download redirects.'
}

function Get-LatestVersion {
    # GitHub's stable-release redirect works without the API's anonymous rate-limit quota.
    $response = Open-Response ([Uri]'https://github.com/starroyhq/computer-use/releases/latest') 30000
    try {
        if (@(301, 302, 303, 307, 308) -notcontains [int]$response.StatusCode) { throw 'Latest release did not return a stable tag.' }
        $location = [string]$response.Headers['Location']
        if ($location -cnotmatch '^https://github\.com/starroyhq/computer-use/releases/tag/v((0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8}))$') {
            throw 'Latest release is not an official stable version.'
        }
        return $Matches[1]
    } finally { $response.Dispose() }
}

function Get-InstallerMetadata([string]$Path, [string]$Version, [string]$Platform, [string]$Name) {
    $metadata = Read-BoundedJson $Path
    if ($metadata.version -cne $Version -or $metadata.platform -cne $Platform -or
        $metadata.sourceDirty -isnot [bool] -or $metadata.sourceDirty -ne $false -or
        $metadata.commit -cnotmatch '^[a-f0-9]{40}$' -or $metadata.archive -cne "computer-use-$Version-$Platform.zip" -or
        $metadata.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $metadata.bytes -isnot [ValueType] -or $metadata.bytes -is [bool] -or
        $metadata.bytes -le 0 -or [math]::Truncate($metadata.bytes) -ne $metadata.bytes -or
        $metadata.signing -cne 'unsigned' -or $metadata.installer.name -cne $Name -or
        $metadata.installer.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $metadata.installer.bytes -isnot [ValueType] -or $metadata.installer.bytes -is [bool] -or
        $metadata.installer.bytes -le 0 -or $metadata.installer.bytes -gt 2147483648 -or
        [math]::Truncate($metadata.installer.bytes) -ne $metadata.installer.bytes) {
        throw 'Release metadata does not match the installer.'
    }
    return $metadata.installer
}

function Write-Result([string]$Package, [string]$Architecture, [bool]$Installed) {
    [ordered]@{ platform = "windows-$Architecture"; packageRoot = $Package;
        node = (Join-Path $Package 'bin\node.exe'); cli = (Join-Path $Package 'runtime\cli.js');
        installed = $Installed } | ConvertTo-Json -Compress
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
        [Environment]::OSVersion.Version -lt [version]'10.0.17763') { throw 'Windows 10 build 17763 or newer is required.' }
    $architecture = Get-NativeArchitecture
    $package = Get-Installations $Hint $architecture
    if ($package) { Write-Result $package $architecture $false; return }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = [Threading.Mutex]::new($false, "Local\ComputerUseBootstrapInstall-$sid")
    try { $locked = $mutex.WaitOne(35000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another installation is in progress. Retry after it finishes.' }
    $package = Get-Installations '' $architecture
    if ($package) { Write-Result $package $architecture $false; return }
    $work = Join-Path ([IO.Path]::GetTempPath()) ('computer-use-bootstrap-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($work)
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([Security.Principal.SecurityIdentifier]::new($sid))
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $work -AclObject $security
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $version = Get-LatestVersion
    $platform = "windows-$architecture"
    $prefix = "computer-use-$version-$platform"
    $name = "$prefix-setup.exe"
    $base = "https://github.com/starroyhq/computer-use/releases/download/v$version"
    $metadataPath = Join-Path $work 'metadata.json'
    Get-OfficialFile ([Uri]"$base/$prefix.json") $metadataPath 65536 30
    $metadata = Get-InstallerMetadata $metadataPath $version $platform $name
    $checksumPath = Join-Path $work 'checksum'
    Get-OfficialFile ([Uri]"$base/$name.sha256") $checksumPath 65536 30
    $checksum = [IO.File]::ReadAllText($checksumPath)
    if ($checksum -cne "$($metadata.sha256)  $name`n") { throw 'Installer checksum and metadata disagree.' }
    $installer = Join-Path $work $name
    Get-OfficialFile ([Uri]"$base/$name") $installer $metadata.bytes 1200
    if ((Get-Item -LiteralPath $installer).Length -ne $metadata.bytes -or
        (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $metadata.sha256) {
        throw 'Installer size or SHA-256 verification failed.'
    }
    $destination = Join-Path $env:LOCALAPPDATA 'Programs\Computer Use'
    if (Test-Path -LiteralPath $destination) { throw 'Destination appeared during installation; review it instead of overwriting.' }
    # Fixed arguments; the official installer selects its standard current-user destination.
    $process = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER') -PassThru
    if (-not $process.WaitForExit(180000)) {
        # Do not kill a partly committed installer. Keep its files until it exits for safe cleanup.
        $retainedFiles = $work
        $work = $null
        throw "Installer has not finished after three minutes. Review the running installer; do not launch a second installation. Temporary files remain at $retainedFiles until you can confirm it has exited."
    }
    if ($process.ExitCode -ne 0) { throw "Installer returned exit code $($process.ExitCode). Review Windows protection or installer diagnostics without bypassing them." }
    $package = Get-Installations '' $architecture
    if (-not $package) { throw 'Installer exited without a complete package.' }
    $manifest = Read-BoundedJson (Join-Path $package 'package.json')
    if ($manifest.version -cne $version) { throw 'Installed version does not match release metadata.' }
    Write-Result $package $architecture $true
} catch {
    [Console]::Error.WriteLine('Computer Use: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
