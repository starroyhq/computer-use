#!/bin/bash
# Standalone bootstrap v1. Discovery/installation only; never starts the Host.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
fail() { printf 'Computer Use: %s\n' "$*" >&2; exit 1; }
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'This script requires macOS.'
[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || fail 'Only Apple Silicon macOS is supported.'
[ "$#" -le 1 ] || fail 'Usage: bootstrap-macos.sh [APP_OR_CLI_HINT]'
work=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/computer-use-bootstrap.XXXXXX")
lock="$HOME/.computer-use-bootstrap.lock"
locked=0
mounted=0
stage=''
cleanup() {
  if [ "$mounted" = 1 ]; then timed 30 /usr/bin/hdiutil detach "$work/mount" -quiet >/dev/null 2>&1 || true; fi
  if [ -n "$stage" ]; then /bin/rm -rf "$stage"; fi
  /bin/rm -rf "$work"
  if [ "$locked" = 1 ]; then /bin/rmdir "$lock" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
cat > "$work/json.js" <<'JXA'
ObjC.import('Foundation');
function read(path) {
  var data = $.NSData.dataWithContentsOfFile(path);
  if (!data || Number(data.length) > 1048576) throw Error('Missing or oversized JSON.');
  var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return JSON.parse(ObjC.unwrap(text));
}
function run(a) {
  if (a[0] === 'receipt') {
    var r = read(a[1]);
    if (r.owner !== 'computer-use-package-v1' || r.arch !== 'arm64') throw Error('Invalid package receipt.');
    return 'ok';
  }
  if (a[0] === 'metadata') {
    var m = read(a[1]), version = a[2], name = a[3];
    if (m.version !== version || m.platform !== 'macos-arm64' || m.sourceDirty !== false ||
        !/^[a-f0-9]{40}$/.test(m.commit) || m.archive !== 'computer-use-' + version + '-macos-arm64.zip' ||
        !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes <= 0 ||
        m.signing !== 'developer-id-notarized' || m.notarization !== 'stapled' ||
        !m.installer || m.installer.name !== name || !/^[a-f0-9]{64}$/.test(m.installer.sha256) ||
        !Number.isSafeInteger(m.installer.bytes) || m.installer.bytes <= 0 || m.installer.bytes > 2147483648)
      throw Error('Release metadata does not match the installer.');
    return m.installer.bytes + '\t' + m.installer.sha256;
  }
  if (a[0] === 'result') return JSON.stringify({platform:'macos-arm64', app:a[1],
    cli:a[1] + '/Contents/Resources/bin/computer-use', installed:a[2] === 'true'});
  throw Error('Unknown JSON operation.');
}
JXA
json() { /usr/bin/osascript -l JavaScript "$work/json.js" "$@"; }
timed() {
  local seconds=$1; shift
  "$@" & local child=$!
  (
    /bin/sleep "$seconds" & sleeper=$!
    trap '/bin/kill "$sleeper" 2>/dev/null || true; exit 0' TERM INT HUP
    wait "$sleeper" || exit 0
    /bin/kill -TERM "$child" 2>/dev/null || true
  ) & local timer=$!
  local result=0
  wait "$child" || result=$?
  /bin/kill "$timer" 2>/dev/null || true
  wait "$timer" 2>/dev/null || true
  return "$result"
}
validate_app() {
  local app=$1 resources="$1/Contents/Resources"
  [ -d "$app" ] && [ ! -L "$app" ] || return 1
  [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist" 2>/dev/null)" = com.starroy.computeruse ] || return 1
  for file in "$app/Contents/MacOS/ComputerUseHost" "$resources/bin/node" "$resources/bin/computer-use" "$resources/bin/cua-driver"; do
    [ -x "$file" ] || return 1
  done
  for file in runtime/cli.js runtime/host.js package.json build-receipt.json skills/computer-use/SKILL.md; do
    [ -f "$resources/$file" ] || return 1
  done
  [ -d "$resources/node_modules" ] || return 1
  json receipt "$resources/build-receipt.json" >/dev/null 2>&1
}
resolve_hint() {
  local value=$1
  case "$value" in
    */Contents/Resources/bin/computer-use) value=${value%/Contents/Resources/bin/computer-use} ;;
    */Contents/Resources/bin/node) value=${value%/Contents/Resources/bin/node} ;;
    */Contents/Resources/runtime/cli.js) value=${value%/Contents/Resources/runtime/cli.js} ;;
  esac
  [ -d "$value" ] || fail 'The hinted App is missing. Review the local binding; omit the hint to discover standard locations.'
  (CDPATH= cd -- "$value" && /bin/pwd -P)
}
discover() {
  local candidate canonical found=''
  if [ -n "${1:-}" ]; then
    candidate=$(resolve_hint "$1")
    validate_app "$candidate" || fail 'The hinted App is incomplete or is not a Computer Use package.'
    printf '%s\n' "$candidate"
    return
  fi
  for candidate in '/Applications/Computer Use.app' "$HOME/Applications/Computer Use.app"; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      validate_app "$candidate" || fail "An incomplete or unknown App exists at $candidate; review it before installing."
      canonical=$(CDPATH= cd -- "$candidate" && /bin/pwd -P)
      if [ -n "$found" ] && [ "$found" != "$canonical" ]; then fail 'Multiple installations exist. Run again with the intended App path.'; fi
      found=$canonical
    fi
  done
  printf '%s' "$found"
}
trusted_url() {
  local url=$1 authority
  case "$url" in https://*) ;; *) return 1 ;; esac
  case "$url" in *$'\r'*|*$'\n'*|*'\'*) return 1 ;; esac
  authority=${url#https://}; authority=${authority%%/*}
  [[ "$authority" =~ ^(github\.com|api\.github\.com|[a-zA-Z0-9.-]+\.githubusercontent\.com)$ ]]
}
# No curl -L: validate each redirect before making the next request.
request() {
  local url=$1 output=$2 limit=$3 timeout=$4 hop status location
  for hop in 0 1 2 3 4 5; do
    trusted_url "$url" || fail 'Download redirected to an untrusted address.'
    status=$(/usr/bin/curl --silent --show-error --proto '=https' --connect-timeout 15 --max-time "$timeout" \
      --max-filesize "$limit" --user-agent 'computer-use-bootstrap/1' --dump-header "$work/headers" \
      --output "$output" --write-out '%{http_code}' "$url") || fail 'Download failed or timed out; check the connection and retry later.'
    [ "$(/usr/bin/stat -f %z "$output")" -le "$limit" ] || fail 'Download exceeds the expected size.'
    case "$status" in
      200) return ;;
      301|302|303|307|308)
        location=$(/usr/bin/awk 'tolower($1)=="location:" {sub(/^[^:]*:[ \t]*/, ""); sub(/\r$/, ""); value=$0} END {print value}' "$work/headers")
        [ -n "$location" ] || fail 'Download redirect has no destination.'
        # GitHub sends absolute asset redirects; root-relative redirects keep the same origin.
        if [[ "$location" == /* ]]; then
          local authority=${url#https://}; authority=${authority%%/*}
          url="https://$authority$location"
        else url=$location; fi ;;
      *) fail "Download server returned HTTP $status; retry later without changing the trusted source." ;;
    esac
  done
  fail 'Too many download redirects.'
}
# Entry point. Existing installations are returned without network access or Host execution.
app=$(discover "${1:-}")
if [ -n "$app" ]; then json result "$app" false; exit 0; fi
for attempt in {1..35}; do
  if /bin/mkdir -m 700 "$lock" 2>/dev/null; then locked=1; break; fi
  [ ! -L "$lock" ] && [ -d "$lock" ] && [ "$(/usr/bin/stat -f %u "$lock")" = "$(/usr/bin/id -u)" ] || fail 'Unsafe bootstrap lock path.'
  /bin/sleep 1
done
[ "$locked" = 1 ] || fail 'Another installation holds the lock. Wait for it, or review a stale lock after confirming no installer is running.'
app=$(discover '')
if [ -n "$app" ]; then json result "$app" false; exit 0; fi
# /releases/latest is GitHub's stable-release redirect and avoids unauthenticated API rate limits.
latest='https://github.com/starroyhq/computer-use/releases/latest'
status=$(/usr/bin/curl --silent --show-error --proto '=https' --connect-timeout 15 --max-time 30 --max-filesize 1048576 \
  --dump-header "$work/latest-headers" --output "$work/latest" --write-out '%{http_code}' "$latest") || fail 'Cannot resolve the latest stable release.'
[[ "$status" =~ ^30[12378]$ ]] || fail "Latest release returned HTTP $status; retry later."
location=$(/usr/bin/awk 'tolower($1)=="location:" {sub(/^[^:]*:[ \t]*/, ""); sub(/\r$/, ""); value=$0} END {print value}' "$work/latest-headers")
[[ "$location" =~ ^https://github\.com/starroyhq/computer-use/releases/tag/v((0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8}))$ ]] || fail 'Latest release is not an official stable version.'
version=${BASH_REMATCH[1]}
prefix="computer-use-$version-macos-arm64"
name="$prefix.dmg"
base="https://github.com/starroyhq/computer-use/releases/download/v$version"
request "$base/$prefix.json" "$work/metadata.json" 65536 30
metadata_fields=$(json metadata "$work/metadata.json" "$version" "$name") || fail 'Invalid release metadata.'
IFS=$'\t' read -r bytes digest <<< "$metadata_fields"
[[ "${bytes:-}" =~ ^[0-9]+$ ]] && [[ "${digest:-}" =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid release metadata.'
request "$base/$name.sha256" "$work/checksum" 65536 30
[ "$(cat "$work/checksum")" = "$digest  $name" ] || fail 'Installer checksum and metadata disagree.'
request "$base/$name" "$work/installer.dmg" "$bytes" 1200
[ "$(/usr/bin/stat -f %z "$work/installer.dmg")" = "$bytes" ] || fail 'Installer download is incomplete.'
[ "$(/usr/bin/shasum -a 256 "$work/installer.dmg" | /usr/bin/awk '{print $1}')" = "$digest" ] || fail 'Installer SHA-256 verification failed.'
/bin/mkdir "$work/mount"
mounted=1
timed 60 /usr/bin/hdiutil attach "$work/installer.dmg" -nobrowse -readonly -mountpoint "$work/mount" -quiet || fail 'Cannot mount the verified installer.'
source_app="$work/mount/Computer Use.app"
validate_app "$source_app" || fail 'Installer does not contain a complete Computer Use App.'
requirement='anchor apple generic and identifier "com.starroy.computeruse" and certificate leaf[subject.OU] = "A7C3K354YP" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
timed 60 /usr/bin/codesign --verify --deep --strict -R "$requirement" "$source_app" || fail 'App signature or publisher verification failed.'
timed 60 /usr/sbin/spctl --assess --type execute "$source_app" || fail 'App notarization assessment failed; review macOS security settings without bypassing them.'
[ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$source_app/Contents/Info.plist")" = "$version" ] || fail 'App version does not match release metadata.'
destination='/Applications'
if [ ! -w "$destination" ]; then destination="$HOME/Applications"; /bin/mkdir -p "$destination"; fi
[ -d "$destination" ] && [ ! -L "$destination" ] && [ -w "$destination" ] || fail 'No safe writable Applications directory.'
app="$destination/Computer Use.app"
[ ! -e "$app" ] && [ ! -L "$app" ] || fail 'Destination appeared during installation; review it instead of overwriting.'
stage=$(/usr/bin/mktemp -d "$destination/.computer-use-install.XXXXXX")
timed 180 /usr/bin/ditto "$source_app" "$stage/Computer Use.app" || fail 'App copy failed.'
# Keep copy/rename within one filesystem; -n preserves a destination created concurrently.
/bin/mv -n "$stage/Computer Use.app" "$destination/"
[ ! -e "$stage/Computer Use.app" ] || fail 'Destination appeared during installation; no existing App was overwritten.'
json result "$app" true
