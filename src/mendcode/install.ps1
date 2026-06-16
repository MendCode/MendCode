$ErrorActionPreference = "Stop"

$App = "mendcode"
$Version = $env:VERSION
$NoModifyPath = $env:MENDCODE_NO_MODIFY_PATH -eq "1"
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
  Write-Host ' __  __                _  ____          _      ' -ForegroundColor Yellow
  Write-Host '|  \/  | ___ _ __   __| |/ ___|___   __| | ___ ' -ForegroundColor Yellow
  Write-Host "| |\/| |/ _ \ '_ \ / _`` | |   / _ \ / _`` |/ _ \" -ForegroundColor Yellow
  Write-Host '| |  | |  __/ | | | (_| | |__| (_) | (_| |  __/' -ForegroundColor Yellow
  Write-Host '|_|  |_|\___|_| |_|\__,_|\____\___/ \__,_|\___|' -ForegroundColor Yellow
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
  Write-Host "[$Current/$Total] $Message" -ForegroundColor Yellow
}

function Write-Ok {
  param([string]$Message)
  Write-Host "OK $Message" -ForegroundColor Green
}

function Get-MendCodeTarget {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

  if ($arch -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
    return "windows-arm64"
  }

  if ($arch -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw "Unsupported Windows architecture: $arch"
  }

  $kernel32 = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);' -Name Kernel32 -Namespace Win32 -PassThru
  if (-not $kernel32::IsProcessorFeaturePresent(40)) {
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

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) {
  throw "install.ps1 is for Windows. On macOS or Linux, run: curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash"
}

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
