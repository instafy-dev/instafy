#!/usr/bin/env bash
# Export the signed archive with app-store-connect / export / manual signing
# (testFlightInternalTestingOnly). The team id and SHA-1 were validated upstream.
# env: RUNNER_TEMP, ARCHIVE, APP_BUNDLE_ID, IOS_DEVELOPMENT_TEAM,
#      IOS_DIST_CERT_SHA1, IOS_APP_STORE_PROFILE_UUID, DEVELOPER_DIR
set -euo pipefail
: "${RUNNER_TEMP:?}" "${ARCHIVE:?}" "${APP_BUNDLE_ID:?}" "${IOS_DEVELOPMENT_TEAM:?}"
: "${IOS_DIST_CERT_SHA1:?}" "${IOS_APP_STORE_PROFILE_UUID:?}" "${DEVELOPER_DIR:?}"
printf '%s' "$IOS_DEVELOPMENT_TEAM" | grep -Eq '^[A-Z0-9]{10}$'
printf '%s' "$IOS_DIST_CERT_SHA1" | grep -Eq '^[0-9a-f]{40}$'
printf '%s' "$IOS_APP_STORE_PROFILE_UUID" | grep -Eq '^[0-9A-Fa-f-]{36}$'

options="$RUNNER_TEMP/ExportOptions.plist"
cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>${IOS_DIST_CERT_SHA1}</string>
  <key>provisioningProfiles</key>
  <dict><key>${APP_BUNDLE_ID}</key><string>${IOS_APP_STORE_PROFILE_UUID}</string></dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>stripSwiftSymbols</key><true/>
  <key>teamID</key><string>${IOS_DEVELOPMENT_TEAM}</string>
  <key>testFlightInternalTestingOnly</key><true/>
</dict>
</plist>
PLIST
plutil -lint "$options" >/dev/null
# destination=export: no App Store Connect credential, no provisioning updates.
xcodebuild -exportArchive -archivePath "$RUNNER_TEMP/$ARCHIVE" \
  -exportPath "$RUNNER_TEMP/ios-export" -exportOptionsPlist "$options"
