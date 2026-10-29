#Requires -Version 5.1
# Installs mendcode.exe from a release of MendCode/MendCode.
#   $env:MENDCODE_CHANNEL = 'nightly'   # stable (default), beta or nightly
#   $env:MENDCODE_VERSION = 'v0.0.1-nightly.20261005.12'   # one exact release instead of a channel
#   $env:MENDCODE_TIER = 'minimalist'   # minimalist, balanced (default) or full: the first launch's starting configuration only;
#                                       # it never overwrites a tier or settings that already exist, and /tier changes it later (docs/release.md)
# While the repository is private the GitHub CLI reads it: `gh auth login` (or GH_TOKEN) is all it needs. Every install checks
# the SHA256 of the binary and the cosign signature of the release workflow; see docs/release.md.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'MendCode/MendCode'
$Base = if ($env:MENDCODE_DOWNLOAD_BASE) { $env:MENDCODE_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/$Repo/releases" }
$Api = if ($env:MENDCODE_API_BASE) { $env:MENDCODE_API_BASE.TrimEnd('/') } else { "https://api.github.com/repos/$Repo" }
$Channel = $env:MENDCODE_CHANNEL
if ($Channel -and @('stable', 'beta', 'nightly') -cnotcontains $Channel) { throw 'channel must be stable, beta or nightly' }
$Tier = if ($env:MENDCODE_TIER) { $env:MENDCODE_TIER } else { 'balanced' }
if (@('minimalist', 'balanced', 'full') -cnotcontains $Tier) { throw 'tier must be minimalist, balanced or full' }
if ($env:OS -ne 'Windows_NT') { throw 'unsupported OS' }
$Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($Arch -ne 'AMD64') { throw 'unsupported architecture' }
if ($Base -notmatch '^(https://|file://|http://(127\.0\.0\.1|localhost):)') { throw 'download base must be HTTPS, file:// or loopback HTTP' }
if ($Api -notmatch '^(https://|http://(127\.0\.0\.1|localhost):)') { throw 'API base must be HTTPS or loopback HTTP' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# With no mirror configured and an authenticated GitHub CLI, releases are read through it: the only way to read a private repository.
$UseGh = $false
if (-not $env:MENDCODE_DOWNLOAD_BASE -and (Get-Command gh -ErrorAction SilentlyContinue)) {
  & gh auth status *> $null
  $UseGh = ($LASTEXITCODE -eq 0)
}
# With cosign the release workflow's signature is checked too; without it the SHA256 alone, and the output says so.
# MENDCODE_REQUIRE_SIGNATURE=1 makes the signature mandatory. (MENDCODE_ALLOW_UNSIGNED=1, the old opt-in, is now the default.)
$HaveCosign = [bool](Get-Command cosign -ErrorAction SilentlyContinue)
if (-not $HaveCosign -and $env:MENDCODE_REQUIRE_SIGNATURE -eq '1') {
  throw 'cosign is required by MENDCODE_REQUIRE_SIGNATURE=1 to verify the release signature (install cosign 2.6.1 or newer)'
}

# Picks the newest tag of the channel from objects with Tag and Prerelease, ordered by version, then date and run for nightlies.
function Select-NewestTag([object[]] $Releases, [string] $Name) {
  $Best = $null
  $BestKey = $null
  foreach ($Release in $Releases) {
    $Tag = [string] $Release.Tag
    $Key = $null
    if ($Name -eq 'stable' -and -not $Release.Prerelease -and $Tag -cmatch '^v(\d+)\.(\d+)\.(\d+)$') { $Key = @([long] $Matches[1], [long] $Matches[2], [long] $Matches[3], 0L, 0L) }
    elseif ($Name -eq 'beta' -and $Release.Prerelease -and $Tag -cmatch '^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$') { $Key = @([long] $Matches[1], [long] $Matches[2], [long] $Matches[3], [long] $Matches[4], 0L) }
    elseif ($Name -eq 'nightly' -and $Release.Prerelease -and $Tag -cmatch '^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$') { $Key = @([long] $Matches[1], [long] $Matches[2], [long] $Matches[3], [long] $Matches[4], [long] $Matches[5]) }
    if (-not $Key) { continue }
    $Newer = -not $BestKey
    for ($Index = 0; -not $Newer -and $Index -lt 5; $Index++) {
      if ($Key[$Index] -gt $BestKey[$Index]) { $Newer = $true; break }
      if ($Key[$Index] -lt $BestKey[$Index]) { break }
    }
    if ($Newer) { $Best = $Tag; $BestKey = $Key }
  }
  if (-not $Best) { throw "no $Name release found in $Repo" }
  $Best
}

$Tag = $env:MENDCODE_VERSION
if ($Tag -and $Channel) { throw 'MENDCODE_VERSION names one release; it cannot be combined with a channel' }
if (-not $Tag) {
  if (-not $Channel) { $Channel = 'stable' }
  if ($UseGh) {
    $Listing = & gh release list --repo $Repo --limit 100 --json 'tagName,isPrerelease,isDraft' | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "cannot list the releases of $Repo with gh" }
    $Releases = @($Listing | Where-Object { -not $_.isDraft } | ForEach-Object { [pscustomobject] @{ Tag = $_.tagName; Prerelease = [bool] $_.isPrerelease } })
    $Tag = Select-NewestTag $Releases $Channel
  } elseif ($Channel -eq 'stable') {
    $Response = Invoke-WebRequest -UseBasicParsing -Uri "$Base/latest"
    $FinalUri = if ($Response.BaseResponse.PSObject.Properties['ResponseUri']) { $Response.BaseResponse.ResponseUri } else { $Response.BaseResponse.RequestMessage.RequestUri }
    $Tag = $FinalUri.Segments[-1]
  } else {
    $Listing = Invoke-RestMethod -UseBasicParsing -Uri "$Api/releases?per_page=100" -Headers @{ Accept = 'application/vnd.github+json' }
    $Releases = @($Listing | Where-Object { -not $_.draft } | ForEach-Object { [pscustomobject] @{ Tag = $_.tag_name; Prerelease = [bool] $_.prerelease } })
    $Tag = Select-NewestTag $Releases $Channel
  }
}
if ($Tag -notmatch '^(v|dev-)') { $Tag = "v$Tag" }
if ($Tag -cnotmatch '^(v[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-beta\.[0-9]{1,9}|-nightly\.[0-9]{8}\.[1-9][0-9]{0,8})?|dev-[0-9a-f]{7,40})$') { throw 'unsupported release version' }
$Version = $Tag -creplace '^v', ''
$Asset = "mendcode-$Version-windows-x64.exe"
$Url = "$Base/download/$Tag"
$InstallDir = if ($env:MENDCODE_INSTALL_DIR) { $env:MENDCODE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\mendcode' }
$null = New-Item -ItemType Directory -Force -Path $InstallDir
$Stage = Join-Path $InstallDir ('.mendcode-install.' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $Stage
function Download([string] $Name) {
  if ($UseGh) {
    & gh release download $Tag --repo $Repo --pattern $Name --dir $Stage *> $null
    if ($LASTEXITCODE -ne 0) { throw "cannot download $Name of $Tag" }
    return
  }
  $Uri = [Uri] "$Url/$Name"
  $Destination = Join-Path $Stage $Name
  if ($Uri.IsFile) { Copy-Item -LiteralPath $Uri.LocalPath -Destination $Destination }
  else { Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination }
}
$PreviousTufRoot = $env:TUF_ROOT
$PreviousCache = $env:XDG_CACHE_HOME
try {
  Download 'SHA256SUMS'
  $MatchesForAsset = @(Get-Content -LiteralPath (Join-Path $Stage 'SHA256SUMS') | Where-Object { $_ -cmatch ('^([0-9a-fA-F]{64}) [ *]?' + [Regex]::Escape($Asset) + '$') })
  if ($MatchesForAsset.Count -ne 1) { throw "missing or duplicate checksum for $Asset" }
  $Expected = $MatchesForAsset[0].Substring(0, 64).ToLowerInvariant()
  Download $Asset
  $Binary = Join-Path $Stage $Asset
  if ((Get-FileHash -LiteralPath $Binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "$Asset does not match SHA256SUMS" }
  if ($HaveCosign) {
    $env:TUF_ROOT = Join-Path $Stage 'tuf'
    $env:XDG_CACHE_HOME = Join-Path $Stage 'cache'
    $Identity = "https://github.com/$Repo/.github/workflows/release.yml@refs/tags/$Tag"
    foreach ($File in @('SHA256SUMS', $Asset)) {
      try { Download "$File.sigstore.json" } catch { throw "$Tag has no signature bundle $File.sigstore.json" }
      & cosign verify-blob --bundle (Join-Path $Stage "$File.sigstore.json") --certificate-identity $Identity --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' (Join-Path $Stage $File)
      if ($LASTEXITCODE -ne 0) { throw "invalid cosign signature for $File" }
    }
    Write-Host "Verified SHA256 and the cosign signature of $Tag"
  } else {
    Write-Host "Verified the SHA256 of $Tag; cosign is not installed, so its signature was not checked (install cosign to check it)"
  }
  $Destination = Join-Path $InstallDir 'mendcode.exe'
  if (Test-Path -LiteralPath $Destination) { [IO.File]::Replace($Binary, $Destination, $null) }
  else { [IO.File]::Move($Binary, $Destination) }
  $Receipt = "schema=mendcode-v2.install.v1`nbinary=mendcode.exe`nsha256=$Expected`ntier=$Tier`n"
  [IO.File]::WriteAllText((Join-Path $InstallDir '.mendcode-v2-install'), $Receipt, (New-Object Text.UTF8Encoding($false)))
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $Entries = @($UserPath -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') })
  if ($Entries -notcontains $InstallDir.TrimEnd('\')) {
    $NewPath = (@($UserPath, $InstallDir) | Where-Object { $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
  }
  Write-Host "Installed mendcode $Version to $Destination (starting tier: $Tier). Open a new terminal to refresh PATH."
  if ($env:MENDCODE_INSTALL_SERVICE -eq '1') {
    throw 'Windows daemon services need a supported local socket transport; the binary was installed without a service.'
  }
} finally {
  $env:TUF_ROOT = $PreviousTufRoot
  $env:XDG_CACHE_HOME = $PreviousCache
  Remove-Item -LiteralPath $Stage -Recurse -Force
}
