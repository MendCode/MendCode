param(
  [string]$Version = $env:VERSION,
  [switch]$NoModifyPath,
  [switch]$Setup,
  [switch]$SkipSetup,
  [int]$WaitForExitPid = 0,
  [long]$WaitForExitStartedAt = 0,
  [switch]$RecoverLock,
  [string]$ActivateOperation,
  [string]$OperationToken
)

$ErrorActionPreference = "Stop"

$App = "mendcode"
if ($env:MENDCODE_NO_MODIFY_PATH -eq "1") { $NoModifyPath = $true }
$SetupMode = if ($SkipSetup) { "skip" } elseif ($Setup) { "run" } else { "ask" }
$Repo = if ($env:MENDCODE_GITHUB_REPO) { $env:MENDCODE_GITHUB_REPO } else { "MendCode/MendCode" }
$BaseUrl = if ($env:MENDCODE_GITHUB_BASE_URL) { $env:MENDCODE_GITHUB_BASE_URL } else { "https://github.com/$Repo" }
$ApiUrl = if ($env:MENDCODE_GITHUB_API_URL) { $env:MENDCODE_GITHUB_API_URL } else { "https://api.github.com/repos/$Repo" }
$InstallHome = if ($env:OPENCODE_TEST_HOME) { $env:OPENCODE_TEST_HOME } else { $HOME }
$InstallDir = [IO.Path]::GetFullPath((Join-Path $InstallHome ".mendcode\bin"))
$LockDir = Join-Path $InstallDir ".update-lock"
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:HaveLock = $false
$script:Operation = $null
$script:Phase = "checking"
$script:BinaryDigest = ""
$script:PreviousDigest = ""
$script:Token = [Guid]::NewGuid().ToString("N")

function Assert-RegularPath([string]$Path) {
  if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing a redirected update path: $Path"
  }
}

function Write-AtomicText([string]$Path, [string]$Text) {
  Assert-RegularPath $Path
  $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = $Utf8.GetBytes($Text)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, $null) }
  else { [IO.File]::Move($temporary, $Path) }
}

function Write-UpdateStatus([int]$ExitCode = 0) {
  if (-not $script:Operation) { return }
  # LF and BOM-free UTF-8 are shared with the startup receipt reader.
  Write-AtomicText (Join-Path $script:Operation "status") (
    "version=$Version`nphase=$script:Phase`nowner_pid=$PID`nexit_code=$ExitCode`nbinary_sha256=$script:BinaryDigest`nprevious_sha256=$script:PreviousDigest`n"
  )
  Write-Host "MENDCODE_UPDATE_PHASE=$script:Phase"
}

function Read-LockOwner {
  Assert-RegularPath $LockDir
  $file = Join-Path $LockDir "owner.json"
  Assert-RegularPath $file
  if (-not [IO.File]::Exists($file) -or (Get-Item -LiteralPath $file).Length -gt 4096) { throw "Update lock owner cannot be verified." }
  $owner = [IO.File]::ReadAllText($file) | ConvertFrom-Json
  if (-not $owner.pid -or [long]$owner.pid -le 0 -or -not $owner.token) { throw "Update lock owner is invalid." }
  return $owner
}

function Write-LockOwner {
  Write-AtomicText (Join-Path $LockDir "owner.json") ((@{
    pid = $PID; startedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
    token = $script:Token; operation = $script:Operation
  } | ConvertTo-Json -Compress) + "`n")
}

function Acquire-UpdateLock {
  if (Test-Path -LiteralPath $LockDir) {
    $owner = Read-LockOwner
    if (-not $RecoverLock -or (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)) {
      throw "Another updater owns the lock (PID $($owner.pid)). Recover only a dead owner with -RecoverLock."
    }
    # Election prevents concurrent recoverers from moving a newly acquired lock.
    $election = [IO.File]::Open((Join-Path $LockDir "recovering"), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $current = Read-LockOwner
      if ($current.token -ne $owner.token -or $current.pid -ne $owner.pid -or (Get-Process -Id $current.pid -ErrorAction SilentlyContinue)) {
        throw "Update lock ownership changed; recovery stopped."
      }
    } finally { $election.Dispose() }
    [IO.Directory]::Move($LockDir, (Join-Path $script:Operation "recovered-lock"))
  }
  New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
  $script:HaveLock = $true
  Write-LockOwner
}

function Release-UpdateLock {
  if (-not $script:HaveLock) { return }
  $owner = Read-LockOwner
  if ($owner.token -ne $script:Token -or [long]$owner.pid -ne $PID) { throw "Updater no longer owns its lock." }
  [IO.Directory]::Move($LockDir, (Join-Path $script:Operation "lock"))
  $script:HaveLock = $false
}

function Receive-UpdateFile([string]$Url, [string]$Destination, [long]$MaxBytes = 2147483648) {
  $uri = [Uri]$Url
  if ($uri.Scheme -ne "https" -and -not ($uri.Scheme -eq "http" -and $uri.IsLoopback)) { throw "Downloads require HTTPS." }
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  $client.DefaultRequestHeaders.UserAgent.ParseAdd("MendCode-Updater")
  $cancel = New-Object Threading.CancellationTokenSource
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $response = $null; $source = $null; $output = $null
  try {
    # Works on Windows PowerShell 5.1: the header deadline includes connection setup.
    $headers = $client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token)
    if (-not $headers.Wait(15000)) { throw "Connection/response headers timed out after 15 seconds." }
    $response = $headers.GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $buffer = New-Object byte[] 65536
    [long]$received = 0
    $lastReport = -1000
    while ($true) {
      $remaining = 900000 - $watch.ElapsedMilliseconds
      if ($remaining -le 0) { throw "Download exceeded 15 minutes." }
      $read = $source.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)
      if (-not $read.Wait([int][Math]::Min(60000, $remaining))) { throw "Download stalled for 60 seconds or exceeded its total deadline." }
      $count = $read.GetAwaiter().GetResult()
      if ($count -eq 0) { break }
      $received += $count
      if ($received -gt $MaxBytes) { throw "Download exceeds the size limit." }
      $output.Write($buffer, 0, $count)
      if ($watch.ElapsedMilliseconds - $lastReport -ge 1000) {
        Write-Host "MENDCODE_UPDATE_BYTES=$received/$($response.Content.Headers.ContentLength)"
        $lastReport = $watch.ElapsedMilliseconds
      }
    }
    if ($null -ne $response.Content.Headers.ContentLength -and $received -ne $response.Content.Headers.ContentLength) { throw "Downloaded file was truncated." }
    $output.Flush($true)
    Write-Host "MENDCODE_UPDATE_BYTES=$received/$received"
  } finally {
    $cancel.Cancel()
    if ($output) { $output.Dispose() }
    if ($source) { $source.Dispose() }
    if ($response) { $response.Dispose() }
    $client.Dispose(); $cancel.Dispose()
  }
}

function Write-MendCodeBanner {
  param(
    [string]$VersionLabel,
    [string]$Target
  )

  Write-Host ""
  Write-Host ' MendCode install deck · terminal-first coding' -ForegroundColor DarkGreen
  Write-Host '█▄ ▄█  █▀▀▀  █▄  █  █▀▀▄  █▀▀▀  █▀▀█  █▀▀▄  █▀▀▀ ' -ForegroundColor Yellow
  Write-Host '█ ▀ █  █▀▀▀  █ ▀ █  █  █  █     █  █  █  █  █▀▀▀ ' -ForegroundColor Yellow
  Write-Host '▀   ▀  ▀▀▀▀  ▀   ▀  ▀▀▀   ▀▀▀▀  ▀▀▀▀  ▀▀▀   ▀▀▀▀ ' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '      .-.' -ForegroundColor DarkGreen
  Write-Host '     (o o)' -ForegroundColor DarkGreen
  Write-Host '    /|[+]|\' -ForegroundColor DarkGreen
  Write-Host '   /_|___|_\' -ForegroundColor DarkGreen
  Write-Host '      \_/' -ForegroundColor DarkGreen
  Write-Host ""
  Write-Host "MendCode installer"
  Write-Host "Version: $VersionLabel  Target: $Target"
  Write-Host "Install dir: $InstallDir"
}

function Write-Step {
  param(
    [int]$Current,
    [int]$Total,
    [string]$Message
  )
  Write-Host "◆ $Current/$Total $Message" -ForegroundColor Yellow
}

function Write-Ok {
  param([string]$Message)
  # Windows PowerShell 5.1 reads BOM-less scripts using the system code page.
  Write-Host "$([char]0x2713) $Message" -ForegroundColor Green
}

function Invoke-MendCodeSetup {
  $binary = Join-Path $InstallDir "mendcode.exe"
  if (-not (Test-Path $binary)) {
    Write-Host "Setup is available after the binary is installed: $binary" -ForegroundColor Yellow
    return
  }

  Write-Host ""
  Write-Host "Opening MendCode setup..." -ForegroundColor DarkGreen
  $previousRoute = $env:OPENCODE_ROUTE
  $env:OPENCODE_ROUTE = '{"type":"setup"}'
  try {
    & $binary
  } finally {
    if ($null -eq $previousRoute) { Remove-Item Env:OPENCODE_ROUTE -ErrorAction SilentlyContinue }
    else { $env:OPENCODE_ROUTE = $previousRoute }
  }
}

function Write-SetupCommand {
  $binary = Join-Path $InstallDir "mendcode.exe"
  Write-Host ('Setup later: $env:OPENCODE_ROUTE=''{"type":"setup"}''; & "' + $binary + '"') -ForegroundColor DarkGray
}

function Wait-MendCodeProcessExit {
  param([int]$ProcessId, [long]$StartedAt)
  if ($ProcessId -le 0) { return }
  if ($StartedAt -le 0) { throw "Cannot verify the process identity to wait for." }
  $script:Phase = "waiting-for-restart"
  Write-UpdateStatus
  $deadline = [DateTime]::UtcNow.AddHours(24)
  Write-AtomicText (Join-Path $script:Operation "waiting.json") ((@{ pid = $ProcessId; startedAt = $StartedAt; deadline = $deadline.ToString("o") } | ConvertTo-Json) + "`n")
  while ($true) {
    $parent = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $parent) { return }
    # PID reuse must never wait on or stop an unrelated process.
    if ($parent.StartTime.ToUniversalTime().Ticks -ne $StartedAt) { return }
    if ([DateTime]::UtcNow -ge $deadline) { throw "Still waiting for MendCode to close after 24 hours. Current binary preserved; run upgrade again after closing it." }
    Start-Sleep -Milliseconds 500
  }
}

function Start-DeferredUpdate {
  if (-not $env:MENDCODE_UPDATE_PARENT_PID) { return $false }

  [int]$parentPid = 0
  if (-not [int]::TryParse($env:MENDCODE_UPDATE_PARENT_PID, [ref]$parentPid) -or $parentPid -le 0) {
    throw "MendCode could not schedule the Windows updater: invalid parent process id."
  }
  $parent = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
  if (-not $parent) { return $false }
  $parentStartedAt = $parent.StartTime.ToUniversalTime().Ticks

  $shell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if (-not $shell) { $shell = Get-Command pwsh.exe -ErrorAction SilentlyContinue }
  if (-not $shell) {
    throw "MendCode could not schedule the Windows updater because PowerShell is unavailable."
  }

  $workerArguments = [System.Collections.Generic.List[string]]::new()
  $workerArguments.Add("-NoProfile")
  $workerArguments.Add("-NonInteractive")
  $workerArguments.Add("-ExecutionPolicy")
  $workerArguments.Add("Bypass")
  $workerArguments.Add("-File")
  # Retain the exact verified installer with this operation, rather than a shared TEMP script.
  $workerScript = Join-Path $script:Operation "installer.ps1"
  [IO.File]::Copy($PSCommandPath, $workerScript)
  $workerArguments.Add('"' + $workerScript + '"')
  if ($Version) {
    $workerArguments.Add("-Version")
    $workerArguments.Add($Version)
  }
  if ($NoModifyPath) { $workerArguments.Add("-NoModifyPath") }
  $workerArguments.Add("-SkipSetup")
  $workerArguments.Add("-WaitForExitPid")
  $workerArguments.Add($parentPid.ToString())
  $workerArguments.Add("-WaitForExitStartedAt")
  $workerArguments.Add($parentStartedAt.ToString())
  $workerArguments.Add("-ActivateOperation")
  $workerArguments.Add('"' + $script:Operation + '"')
  $workerArguments.Add("-OperationToken")
  $workerArguments.Add($script:Token)
  $script:Phase = "waiting-for-restart"
  Write-UpdateStatus
  $worker = Start-Process -FilePath $shell.Source -ArgumentList $workerArguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $script:Operation "worker.stdout.log") `
    -RedirectStandardError (Join-Path $script:Operation "worker.stderr.log")
  # Child takes ownership using the operation token. Parent cannot release its lock afterwards.
  $script:HaveLock = $false
  $accepted = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    $owner = Read-LockOwner
    if ([long]$owner.pid -eq $worker.Id -and $owner.token -eq $script:Token) { $accepted = $true; break }
    $worker.Refresh()
    if ($worker.HasExited) { break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $accepted) { throw "Deferred updater did not confirm ownership. Recovery files: $script:Operation" }
  Write-Host "Update scheduled; it will finish after MendCode closes." -ForegroundColor DarkGreen
  return $true
}

function Maybe-LaunchSetup {
  if ($SetupMode -eq "skip") {
    Write-SetupCommand
    return
  }

  if ($SetupMode -eq "run") {
    Invoke-MendCodeSetup
    return
  }

  Write-Host ""
  Write-Host "Finish setup now? Providers, models, packages, memory, and permissions." -ForegroundColor Yellow
  try {
    $answer = (Read-Host "Open setup now? [Y/n]").Trim().ToLowerInvariant()
  } catch {
    Write-SetupCommand
    return
  }
  if ($answer -eq "" -or $answer -eq "y" -or $answer -eq "yes" -or $answer -eq "s" -or $answer -eq "si" -or $answer -eq "sí" -or $answer -eq "setup" -or $answer -eq "open") {
    Invoke-MendCodeSetup
    return
  }
  Write-SetupCommand
}

function Get-MendCodeTarget {
  # PROCESSOR_ARCHITEW6432 exposes the host architecture when a 32-bit
  # PowerShell process runs on 64-bit Windows. Prefer it so x64/ARM64 hosts do
  # not get misidentified as x86.
  $rawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
  } elseif ($env:PROCESSOR_ARCHITECTURE) {
    $env:PROCESSOR_ARCHITECTURE
  } else {
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  }
  $architecture = $rawArchitecture.ToUpperInvariant()

  if ($architecture -eq "ARM64") {
    return "windows-arm64"
  }

  if ($architecture -eq "X64" -or ($architecture -eq "X86" -and [Environment]::Is64BitOperatingSystem)) {
    $architecture = "AMD64"
  }

  if ($architecture -ne "AMD64") {
    throw "Unsupported Windows architecture: $rawArchitecture"
  }

  try {
    $kernel32 = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);' -Name MendCodeKernel32 -Namespace MendCode -PassThru
    if (-not $kernel32::IsProcessorFeaturePresent(40)) {
      return "windows-x64-baseline"
    }
  } catch {
    # A restricted PowerShell/.NET host may reject the probe. The baseline
    # binary is the compatible fallback and does not require AVX2.
    return "windows-x64-baseline"
  }

  return "windows-x64"
}

function Add-MendCodeToPath {
  if ($NoModifyPath) {
    Write-Host "Skipping PATH update because -NoModifyPath was set."
    return
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = if ($userPath) { $userPath -split ";" } else { @() }
  if ($entries -notcontains $InstallDir) {
    $nextPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
  }

  if (($env:Path -split ";") -notcontains $InstallDir) {
    $env:Path = "$env:Path;$InstallDir"
  }
}

function Expand-VerifiedExecutable([string]$Archive, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $entries = @($zip.Entries | Where-Object { $_.FullName -ceq "mendcode.exe" })
    if ($entries.Count -ne 1 -or $entries[0].Length -le 0 -or $entries[0].Length -gt 2147483648) {
      throw "Archive must contain exactly one root mendcode.exe of valid size."
    }
    $source = $entries[0].Open()
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $source.CopyTo($output); $output.Flush($true) }
    finally { $output.Dispose(); $source.Dispose() }
  } finally { $zip.Dispose() }
}

function Assert-Candidate([string]$Candidate, [string]$Target) {
  Assert-RegularPath $Candidate
  $stream = [IO.File]::OpenRead($Candidate)
  $reader = New-Object IO.BinaryReader($stream)
  try {
    if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { throw "Candidate is not a Windows executable." }
    $stream.Position = 60
    $offset = $reader.ReadUInt32()
    if ($offset -gt ($stream.Length - 6)) { throw "Candidate PE header is truncated." }
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "Candidate PE signature is invalid." }
    $machine = $reader.ReadUInt16()
    $expectedMachine = if ($Target -eq "windows-arm64") { 0xaa64 } else { 0x8664 }
    if ($machine -ne $expectedMachine) { throw "Candidate architecture does not match $Target." }
  } finally { $reader.Dispose() }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Candidate; $info.Arguments = "--version"
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw "Could not verify candidate version." }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
      $process.Kill()
      throw "Candidate --version exceeded 30 seconds. Current binary preserved."
    }
    if ($process.ExitCode -ne 0 -or $stdout.GetAwaiter().GetResult().Trim() -ne $Version) {
      throw "Candidate version check failed. Expected $Version."
    }
  } finally { $process.Dispose() }
}

function Activate-Candidate {
  $candidate = Join-Path $script:Operation "candidate.exe"
  Assert-RegularPath $candidate
  if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant() -ne $script:BinaryDigest) {
    throw "Staged executable changed before activation."
  }
  $destination = Join-Path $InstallDir "mendcode.exe"
  Assert-RegularPath $destination
  $previous = Join-Path $script:Operation "previous"
  if (Test-Path -LiteralPath $previous) { throw "Previous executable is already retained; inspect this operation before retrying." }
  if ([IO.File]::Exists($destination)) {
    $script:PreviousDigest = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $script:Phase = "activating"
  Write-UpdateStatus
  # File.Replace is one same-volume operation and preserves the original as its backup.
  if ([IO.File]::Exists($destination)) { [IO.File]::Replace($candidate, $destination, $previous) }
  else { [IO.File]::Move($candidate, $destination) }
  $script:Phase = "activated"
  Write-UpdateStatus
  Write-Ok "Installed $destination"
  Write-Host "Restart required to verify backend and TUI readiness. Recovery files: $script:Operation"
  Write-Host "Existing loop services were left running. Restart them when their work finishes."
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "install.ps1 requires Windows." }
$failure = $null
$deferred = $false
try {
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  Assert-RegularPath (Split-Path $InstallDir -Parent)
  Assert-RegularPath $InstallDir
  if ($ActivateOperation) {
    $script:Operation = [IO.Path]::GetFullPath($ActivateOperation)
    if ((Split-Path $script:Operation -Parent) -ne $InstallDir -or (Split-Path $script:Operation -Leaf) -notmatch '^\.update\.[a-f0-9]{32}$') {
      throw "Invalid deferred operation path."
    }
    Assert-RegularPath $script:Operation
    $owner = Read-LockOwner
    if ($OperationToken -notmatch '^[a-f0-9]{32}$' -or $owner.token -ne $OperationToken -or $owner.operation -ne $script:Operation) { throw "Deferred updater ownership changed." }
    $script:Token = $OperationToken
    $statusFile = Join-Path $script:Operation "status"
    Assert-RegularPath $statusFile
    if ((Get-Item -LiteralPath $statusFile).Length -gt 4096) { throw "Invalid operation status." }
    $fields = @{}
    foreach ($line in [IO.File]::ReadAllLines($statusFile)) {
      $entry = $line.Split(@('='), 2)
      if ($entry.Length -eq 2) { $fields[$entry[0]] = $entry[1] }
    }
    if ($fields.version -ne $Version -or $fields.phase -ne "waiting-for-restart" -or $fields.binary_sha256 -notmatch '^[a-f0-9]{64}$') { throw "Deferred operation was not verified." }
    $script:BinaryDigest = $fields.binary_sha256
    Write-LockOwner
    $script:HaveLock = $true
    Wait-MendCodeProcessExit -ProcessId $WaitForExitPid -StartedAt $WaitForExitStartedAt
    Activate-Candidate
  } else {
    $script:Operation = Join-Path $InstallDir (".update." + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $script:Operation | Out-Null
    Acquire-UpdateLock
    Write-UpdateStatus
    $target = Get-MendCodeTarget
    if (-not $Version) {
      $releaseFile = Join-Path $script:Operation "release.json"
      Receive-UpdateFile "$ApiUrl/releases/latest" $releaseFile 524288
      $Version = ([IO.File]::ReadAllText($releaseFile) | ConvertFrom-Json).tag_name
    }
    $Version = $Version.TrimStart('v')
    if ($Version -notmatch '^\d+\.\d+\.\d+([-+][a-zA-Z0-9.+-]+)?$') { throw "Invalid release version." }
    Write-MendCodeBanner -VersionLabel $Version -Target $target
    $filename = "$App-$target.zip"
    $url = "$BaseUrl/releases/download/v$Version/$filename"
    $archive = Join-Path $script:Operation $filename
    $script:Phase = "downloading"
    Write-UpdateStatus
    Receive-UpdateFile $url $archive
    $script:Phase = "verifying"
    Write-UpdateStatus
    $sums = Join-Path $script:Operation "SHA256SUMS"
    if ($env:MENDCODE_VERIFIED_SUMS_FILE) {
      Assert-RegularPath $env:MENDCODE_VERIFIED_SUMS_FILE
      [IO.File]::Copy($env:MENDCODE_VERIFIED_SUMS_FILE, $sums)
    } else { Receive-UpdateFile "$BaseUrl/releases/download/v$Version/SHA256SUMS" $sums 524288 }
    if ((Get-Item -LiteralPath $sums).Length -gt 524288) { throw "Checksums exceed the size limit." }
    $digests = @([IO.File]::ReadAllLines($sums) | ForEach-Object {
      if ($_ -match ('^([a-fA-F0-9]{64})\s+\*?(?:\./)?' + [Regex]::Escape($filename) + '$')) { $Matches[1].ToLowerInvariant() }
    })
    if ($digests.Count -ne 1) { throw "Missing, duplicate, or invalid release checksum." }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digests[0]) { throw "Release checksum mismatch. Current binary preserved." }
    $candidate = Join-Path $script:Operation "candidate.exe"
    Expand-VerifiedExecutable $archive $candidate
    Assert-Candidate $candidate $target
    $script:BinaryDigest = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-UpdateStatus
    $deferred = Start-DeferredUpdate
    if (-not $deferred) {
      if ($WaitForExitPid -gt 0) { Wait-MendCodeProcessExit -ProcessId $WaitForExitPid -StartedAt $WaitForExitStartedAt }
      Activate-Candidate
      Add-MendCodeToPath
    }
  }
} catch {
  $failure = $_
  if ($script:HaveLock) {
    try {
      Write-AtomicText (Join-Path $script:Operation "failure.txt") ("$script:Phase`: $($_.Exception.Message)`n")
      $script:Phase = "failed"
      Write-UpdateStatus 1
    } catch { Write-Warning "Could not record update failure: $($_.Exception.Message)" }
  }
} finally {
  if ($script:HaveLock) {
    try { Release-UpdateLock } catch { if (-not $failure) { $failure = $_ } }
  }
}
if ($failure) { Write-Error $failure; exit 1 }
if (-not $deferred -and -not $ActivateOperation) { Maybe-LaunchSetup }
