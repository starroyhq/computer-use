#!/usr/bin/env bash
set -euo pipefail

for name in APPLE_API_ISSUER APPLE_API_KEY APPLE_API_PRIVATE_KEY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_TEAM_ID; do
  [[ -n "${!name:-}" ]] || { echo "Required release secret is missing: $name" >&2; exit 1; }
done
[[ "$APPLE_SIGNING_IDENTITY" == 'Developer ID Application: '* ]] || { echo 'A Developer ID Application identity is required.' >&2; exit 1; }
[[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo 'Invalid Apple team ID.' >&2; exit 1; }

umask 077
temporary=$(mktemp -d "$RUNNER_TEMP/computer-use-notary.XXXXXX")
keychain="$temporary/signing.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT

certificate="$temporary/signing.p12"
api_key="$temporary/AuthKey_${APPLE_API_KEY}.p8"
printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$certificate"
printf '%s' "$APPLE_API_PRIVATE_KEY" > "$api_key"
test -s "$certificate" && test -s "$api_key"

keychain_password=$(openssl rand -hex 24)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$certificate" -P "$APPLE_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"
security list-keychains -d user -s "$keychain"
security default-keychain -d user -s "$keychain"
security find-identity -v -p codesigning "$keychain" | grep -F '"'"$APPLE_SIGNING_IDENTITY"'"' >/dev/null

api_issuer=$APPLE_API_ISSUER
api_key_id=$APPLE_API_KEY
identity=$APPLE_SIGNING_IDENTITY
team=$APPLE_TEAM_ID
# Build tools and bundled dependencies must not inherit the certificate or API private key.
unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_PRIVATE_KEY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_TEAM_ID

node scripts/package-app.mjs --identity "$identity"

app='artifacts/Computer Use.app'
submission="$temporary/submission.zip"
result="$temporary/notary-result.json"
ditto -c -k --sequesterRsrc --keepParent "$app" "$submission"
xcrun notarytool submit "$submission" \
  --key "$api_key" --key-id "$api_key_id" --issuer "$api_issuer" \
  --wait --timeout 30m --output-format json > "$result"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const response = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (response.status !== "Accepted") {
    console.error(`Notarization status: ${response.status ?? "unknown"}; submission: ${response.id ?? "unknown"}`);
    process.exit(1);
  }
  console.log(`Notarization accepted: ${response.id}`);
' "$result"
xcrun stapler staple "$app"
APPLE_SIGNING_IDENTITY="$identity" APPLE_TEAM_ID="$team" node .github/scripts/archive-package.mjs macos-arm64 --notarized
