#!/bin/sh
# Installs the `mendcode` binary of a release of MendCode/MendCode.
#   install.sh [--channel stable|beta|nightly] [--tier minimalist|balanced|full]
# MENDCODE_VERSION=<tag> installs one exact release instead (vX.Y.Z, vX.Y.Z-beta.N, vX.Y.Z-nightly.YYYYMMDD.RUN or dev-<sha>).
# --tier (MENDCODE_TIER) is only the first launch's starting configuration, recorded in the install receipt (default balanced):
# it never overwrites a tier or settings that already exist, and `/tier` changes it later; see docs/release.md.
# Every install checks the SHA256 of the binary; with cosign installed it also checks the release workflow's signature, and
# MENDCODE_REQUIRE_SIGNATURE=1 refuses to install without it. A private repository is read through `gh` (gh auth login); see docs/release.md.
#   curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh
set -eu

REPO=MendCode/MendCode
BASE=${MENDCODE_DOWNLOAD_BASE:-https://github.com/$REPO/releases}
API=${MENDCODE_API_BASE:-https://api.github.com/repos/$REPO}
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

channel=${MENDCODE_CHANNEL:-}
tier=${MENDCODE_TIER:-}
while [ $# -gt 0 ]; do
  case $1 in
    --channel) [ $# -ge 2 ] || fail '--channel needs a value'; channel=$2; shift 2 ;;
    --channel=*) channel=${1#--channel=}; shift ;;
    --tier) [ $# -ge 2 ] || fail '--tier needs a value'; tier=$2; shift 2 ;;
    --tier=*) tier=${1#--tier=}; shift ;;
    -h|--help) printf 'usage: install.sh [--channel stable|beta|nightly] [--tier minimalist|balanced|full]\n  MENDCODE_VERSION=<tag> installs one exact release\n  --tier is the first launch'"'"'s starting configuration (default balanced); /tier changes it later\n'; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
case ${channel:-stable} in
  stable|beta|nightly) ;;
  *) fail 'channel must be stable, beta or nightly' ;;
esac
tier=${tier:-balanced}
case $tier in
  minimalist|balanced|full) ;;
  *) fail 'tier must be minimalist, balanced or full' ;;
esac

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail 'unsupported OS' ;;
esac
case $(uname -m) in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail 'unsupported architecture' ;;
esac
# With no mirror configured and an authenticated GitHub CLI, releases are read through it: that is the only way to read a private repository.
use_gh=0
if [ -z "${MENDCODE_DOWNLOAD_BASE:-}" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then use_gh=1; fi
if [ "$use_gh" = 0 ]; then command -v curl >/dev/null 2>&1 || fail 'curl is required'; fi
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{print tolower($1)}'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{print tolower($1)}'; }
else
  fail 'sha256sum or shasum is required'
fi
redirect_protocols='=https'
case $BASE in
  https://*|file://*) ;;
  http://127.0.0.1:*|http://localhost:*) redirect_protocols='=http,https' ;;
  *) fail 'download base must be HTTPS, file:// or loopback HTTP' ;;
esac
case $API in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) fail 'API base must be HTTPS or loopback HTTP' ;;
esac
BASE=${BASE%/}
API=${API%/}
# With cosign the release workflow's signature is checked too; without it the SHA256 alone, and the output says so.
# MENDCODE_REQUIRE_SIGNATURE=1 makes the signature mandatory. (MENDCODE_ALLOW_UNSIGNED=1, the old opt-in, is now the default.)
have_cosign=0
if command -v cosign >/dev/null 2>&1; then
  have_cosign=1
elif [ "${MENDCODE_REQUIRE_SIGNATURE:-0}" = 1 ]; then
  fail 'cosign is required by MENDCODE_REQUIRE_SIGNATURE=1 to verify the release signature (install cosign 2.6.1 or newer)'
fi

# Reads "tag<TAB>prerelease" lines and prints the newest tag the channel takes: its own and every steadier channel's (beta also
# stable, nightly also beta and stable), so a newer stable wins and a channel with no release yet installs the stable one.
# Ordered as semver: version, then a version's betas < its nightlies < the version itself, then beta number or date and run.
newest_tag() {
  awk -F '\t' -v channel="$1" '
    function pad(n) { return sprintf("%09d", n) }
    BEGIN { takes["stable"] = " stable "; takes["beta"] = " stable beta "; takes["nightly"] = " stable beta nightly " }
    {
      tag = $1; pre = $2; key = ""; kind = ""
      split(tag, p, /[v.-]/)
      if (pre == "false" && tag ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/) { kind = "stable"; key = pad(p[2]) pad(p[3]) pad(p[4]) "3" pad(0) pad(0) }
      else if (pre == "true" && tag ~ /^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$/) { kind = "beta"; key = pad(p[2]) pad(p[3]) pad(p[4]) "1" pad(p[6]) pad(0) }
      else if (pre == "true" && tag ~ /^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]\.[0-9]+$/) { kind = "nightly"; key = pad(p[2]) pad(p[3]) pad(p[4]) "2" pad(p[6]) pad(p[7]) }
      if (key != "" && index(takes[channel], " " kind " ") && key > best) { best = key; found = tag }
    }
    END { if (found == "") exit 1; print found }'
}

tag=${MENDCODE_VERSION:-}
if [ -n "$tag" ] && [ -n "$channel" ]; then fail 'MENDCODE_VERSION names one release; it cannot be combined with a channel'; fi
if [ -z "$tag" ]; then
  channel=${channel:-stable}
  if [ "$use_gh" = 1 ]; then
    listing=$(gh release list --repo "$REPO" --limit 100 --json tagName,isPrerelease,isDraft --jq '.[] | select(.isDraft | not) | "\(.tagName)\t\(.isPrerelease)"') || fail "cannot list the releases of $REPO with gh"
    tag=$(printf '%s\n' "$listing" | newest_tag "$channel") || fail "no $channel release found in $REPO"
  elif [ "$channel" = stable ]; then
    latest=$(curl -q -fsSL --proto '=https,file,http' --proto-redir "$redirect_protocols" -o /dev/null -w '%{url_effective}' "$BASE/latest") || fail "cannot resolve the latest release (a private repository needs the GitHub CLI: install gh and run gh auth login)"
    tag=${latest##*/}
  else
    body=$(curl -q -fsSL --proto '=https,http' --proto-redir "$redirect_protocols" -H 'Accept: application/vnd.github+json' "$API/releases?per_page=100") || fail "cannot list the releases of $REPO (a private repository needs the GitHub CLI: install gh and run gh auth login)"
    listing=$(printf '%s\n' "$body" | grep -oE '"(tag_name|prerelease)": *("[^"]*"|true|false)' | sed -E 's/^"([a-z_]+)": *"?([^"]*)"?$/\1 \2/' | awk '$1 == "tag_name" { tag = $2 } $1 == "prerelease" && tag != "" { print tag "\t" $2; tag = "" }') || true
    tag=$(printf '%s\n' "$listing" | newest_tag "$channel") || fail "no $channel release found in $REPO"
  fi
fi
case $tag in v*|dev-*) ;; *) tag=v$tag ;; esac
printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^(v[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-beta\.[0-9]{1,9}|-nightly\.[0-9]{8}\.[1-9][0-9]{0,8})?|dev-[0-9a-f]{7,40})$' || fail 'unsupported release version'
version=${tag#v}
asset=mendcode-$version-$os-$arch
url=$BASE/download/$tag
install_dir=${MENDCODE_INSTALL_DIR:-$HOME/.local/bin}
mkdir -p "$install_dir"
stage=$(mktemp -d "$install_dir/.mendcode-install.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
download() {
  if [ "$use_gh" = 1 ]; then
    gh release download "$tag" --repo "$REPO" --pattern "$1" --dir "$stage" >/dev/null
  else
    curl -q -fsSL --proto '=https,file,http' --proto-redir "$redirect_protocols" "$url/$1" -o "$stage/$1"
  fi
}
fetch() { download "$1" || fail "cannot download $1 of $tag"; }
fetch SHA256SUMS
expected=$(awk -v name="$asset" '
  { sub(/\r$/, ""); file=$2; sub(/^\*/, "", file)
    if (file == name) { count++; sum=tolower($1) } }
  END { if (count != 1 || length(sum) != 64 || sum ~ /[^0-9a-f]/) exit 1; print sum }
' "$stage/SHA256SUMS") || fail "missing or duplicate checksum for $asset"
fetch "$asset"
actual=$(digest "$stage/$asset")
[ "$actual" = "$expected" ] || fail "$asset does not match SHA256SUMS"
if [ "$have_cosign" = 1 ]; then
  identity=https://github.com/$REPO/.github/workflows/release.yml@refs/tags/$tag
  for file in SHA256SUMS "$asset"; do
    download "$file.sigstore.json" || fail "$tag has no signature bundle $file.sigstore.json"
    TUF_ROOT="$stage/tuf" XDG_CACHE_HOME="$stage/cache" cosign verify-blob --bundle "$stage/$file.sigstore.json" \
      --certificate-identity "$identity" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com "$stage/$file" || fail "invalid cosign signature for $file"
  done
  printf 'Verified SHA256 and the cosign signature of %s\n' "$tag"
else
  printf 'Verified the SHA256 of %s; cosign is not installed, so its signature was not checked (install cosign to check it)\n' "$tag"
fi
chmod 755 "$stage/$asset"
mv -f "$stage/$asset" "$install_dir/mendcode"
printf 'schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=%s\ntier=%s\n' "$actual" "$tier" > "$stage/ownership"
mv -f "$stage/ownership" "$install_dir/.mendcode-v2-install"
printf 'Installed mendcode %s to %s/mendcode (starting tier: %s)\n' "$version" "$install_dir" "$tier"
case ":$PATH:" in
  *":$install_dir:"*) printf 'Run mendcode to start. mendcode upgrade updates it; --channel beta or nightly switches channel.\n' ;;
  *) printf '%s is not on PATH. Add it, then run mendcode:\n  export PATH="%s:$PATH"\n' "$install_dir" "$install_dir" ;;
esac
# Service installation is explicit; it does not start the daemon in this shell.
if [ "${MENDCODE_INSTALL_SERVICE:-0}" = 1 ]; then
  if [ -n "${MENDCODE_V2_DIR:-}" ]; then
    "$install_dir/mendcode" daemon service install --dir "$MENDCODE_V2_DIR"
  else
    "$install_dir/mendcode" daemon service install
  fi
fi
