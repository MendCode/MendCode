$ErrorActionPreference = "Stop"

$App = "mendcode"
$Version = $env:VERSION
$NoModifyPath = $env:MENDCODE_NO_MODIFY_PATH -eq "1"
$Repo = if ($env:MENDCODE_GITHUB_REPO) { $env:MENDCODE_GITHUB_REPO } else { "MendCode/MendCode" }
$BaseUrl = if ($env:MENDCODE_GITHUB_BASE_URL) { $env:MENDCODE_GITHUB_BASE_URL } else { "https://github.com/$Repo" }
$ApiUrl = if ($env:MENDCODE_GITHUB_API_URL) { $env:MENDCODE_GITHUB_API_URL } else { "https://api.github.com/repos/$Repo" }
$InstallDir = Join-Path $HOME ".mendcode\bin"

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

Write-Host "Installing MendCode $versionLabel for $target..."
Invoke-WebRequest $url -OutFile $zip

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

Add-MendCodeToPath

Write-Host "Installed MendCode to $InstallDir"
& (Join-Path $InstallDir "mendcode.exe") --version
Write-Host "Run: mendcode"
