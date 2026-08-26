param(
  [string]$Version = $env:VERSION,
  [switch]$NoModifyPath,
  [switch]$Setup,
  [switch]$SkipSetup,
  [int]$WaitForExitPid = 0
)

$ErrorActionPreference = "Stop"

$App = "mendcode"
if ($env:MENDCODE_NO_MODIFY_PATH -eq "1") { $NoModifyPath = $true }
$SetupMode = if ($SkipSetup) { "skip" } elseif ($Setup) { "run" } else { "ask" }
$Repo = if ($env:MENDCODE_GITHUB_REPO) { $env:MENDCODE_GITHUB_REPO } else { "MendCode/MendCode" }
$BaseUrl = if ($env:MENDCODE_GITHUB_BASE_URL) { $env:MENDCODE_GITHUB_BASE_URL } else { "https://github.com/$Repo" }
$ApiUrl = if ($env:MENDCODE_GITHUB_API_URL) { $env:MENDCODE_GITHUB_API_URL } else { "https://api.github.com/repos/$Repo" }
$InstallDir = Join-Path $HOME ".mendcode\bin"

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
  Write-Host "✓ $Message" -ForegroundColor Green
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
  param([int]$ProcessId)

  if ($ProcessId -le 0) { return }
  while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 250
  }
}

function Start-DeferredUpdate {
  if ($env:MENDCODE_UPDATE_WORKER -eq "1") { return $false }
  if (-not $env:MENDCODE_UPDATE_PARENT_PID) { return $false }

  [int]$parentPid = 0
  if (-not [int]::TryParse($env:MENDCODE_UPDATE_PARENT_PID, [ref]$parentPid) -or $parentPid -le 0) {
    throw "MendCode could not schedule the Windows updater: invalid parent process id."
  }

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
  $workerArguments.Add('"' + $PSCommandPath + '"')
  if ($Version) {
    $workerArguments.Add("-Version")
    $workerArguments.Add($Version)
  }
  if ($NoModifyPath) { $workerArguments.Add("-NoModifyPath") }
  $workerArguments.Add("-SkipSetup")
  $workerArguments.Add("-WaitForExitPid")
  $workerArguments.Add($parentPid.ToString())

  $env:MENDCODE_UPDATE_WORKER = "1"
  Start-Process -FilePath $shell.Source -ArgumentList $workerArguments -WindowStyle Hidden | Out-Null
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

function Restart-MendCodeLoopServices {
  if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    return
  }

  $tasks = @(Get-ScheduledTask -TaskPath "\MendCode\Loops\" -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -like "com.mendcode.loops.*" })
  foreach ($task in $tasks) {
    Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue
  }

  if ($tasks.Count -gt 0) {
    Write-Ok "Refreshed $($tasks.Count) MendCode loop task(s)"
  }
}

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
  throw "install.ps1 is for Windows. On macOS or Linux, run: curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash"
}

if (Start-DeferredUpdate) { exit 0 }
Wait-MendCodeProcessExit -ProcessId $WaitForExitPid

New-Item -ItemType Directory -Force $InstallDir | Out-Null

$target = Get-MendCodeTarget
$versionLabel = "latest"

if ($Version) {
  $Version = $Version.TrimStart("v")
  $versionLabel = "v$Version"
  $url = "$BaseUrl/releases/download/v$Version/$App-$target.zip"
} else {
  $release = Invoke-RestMethod "$ApiUrl/releases/latest"
  $versionLabel = $release.tag_name
  $url = "$BaseUrl/releases/latest/download/$App-$target.zip"
}

$zip = Join-Path $env:TEMP "$App-$target.zip"
$extractDir = Join-Path $env:TEMP "$App-install-$PID"

Write-MendCodeBanner -VersionLabel $versionLabel -Target $target
Write-Step 1 4 "Preparing download"
Write-Step 2 4 "Downloading release asset"
Invoke-WebRequest $url -OutFile $zip
Write-Ok "Downloaded $App-$target.zip"

Write-Step 3 4 "Installing binary"
if (Test-Path $extractDir) {
  Remove-Item -Recurse -Force $extractDir
}
New-Item -ItemType Directory -Force $extractDir | Out-Null
Expand-Archive -Force $zip $extractDir

$binary = Get-ChildItem -Path $extractDir -Recurse -Filter "mendcode.exe" | Select-Object -First 1
if (-not $binary) {
  throw "Release asset did not contain mendcode.exe"
}

Copy-Item -Force $binary.FullName (Join-Path $InstallDir "mendcode.exe")
Remove-Item -Recurse -Force $extractDir
Remove-Item -Force $zip
Write-Ok "Installed $(Join-Path $InstallDir "mendcode.exe")"
Restart-MendCodeLoopServices

Write-Step 4 4 "Updating PATH"
Add-MendCodeToPath

Write-Host ""
Write-Host "MendCode is ready." -ForegroundColor Green
& (Join-Path $InstallDir "mendcode.exe") --version
Write-Host ""
Write-Host "  cd <project>                         # open your repo"
Write-Host "  $(Join-Path $InstallDir "mendcode.exe")  # run now in this terminal"
Write-Host ""
Write-Host "Open a new terminal to use: mendcode"
Maybe-LaunchSetup

if ($env:MENDCODE_UPDATE_SCRIPT_PATH -and (Test-Path $env:MENDCODE_UPDATE_SCRIPT_PATH)) {
  Remove-Item -Force $env:MENDCODE_UPDATE_SCRIPT_PATH -ErrorAction SilentlyContinue
}
