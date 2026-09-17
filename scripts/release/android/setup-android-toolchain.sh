#!/usr/bin/env bash
# Selects the runner image's Java 21 JDK and provisions the pinned Android SDK
# components. No marketplace setup action: the toolchain is proven at run time.
#
# env: ANDROID_COMPILE_SDK ANDROID_BUILD_TOOLS_VERSION GITHUB_ENV GITHUB_PATH
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

java_home="${JAVA_HOME_21_X64:-}"
if [[ -z "$java_home" || ! -x "$java_home/bin/java" ]]; then
  java_home=/usr/lib/jvm/temurin-21-jdk-amd64
fi
[[ -x "$java_home/bin/java" ]] || fail "No Java 21 JDK is available on this runner."
# No pipe into head: java -version writes to stderr and an early reader exits 141.
version_output="$("$java_home/bin/java" -version 2>&1)"
[[ "${version_output%%$'\n'*}" == *'"21'* ]] || fail "Java 21 is required; the Android build refuses newer JDKs."
for tool in jarsigner keytool; do
  [[ -x "$java_home/bin/$tool" ]] || fail "The Java 21 installation has no $tool (a JDK is required)."
done
printf 'JAVA_HOME=%s\n' "$java_home" >> "$GITHUB_ENV"
printf '%s/bin\n' "$java_home" >> "$GITHUB_PATH"

sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
[[ -n "$sdk_root" && -d "$sdk_root" ]] || fail "No Android SDK is present on this runner."
sdkmanager="$sdk_root/cmdline-tools/latest/bin/sdkmanager"
[[ -x "$sdkmanager" ]] || fail "The Android SDK has no cmdline-tools/latest sdkmanager."
export JAVA_HOME="$java_home"
# yes is killed by SIGPIPE once sdkmanager stops reading; do not let pipefail
# turn an accepted license prompt into a failure.
set +o pipefail
yes | "$sdkmanager" --sdk_root="$sdk_root" --licenses > /dev/null || true
set -o pipefail
"$sdkmanager" --sdk_root="$sdk_root" --install platform-tools \
  "platforms;android-${ANDROID_COMPILE_SDK}" "build-tools;${ANDROID_BUILD_TOOLS_VERSION}"
[[ -d "$sdk_root/platforms/android-${ANDROID_COMPILE_SDK}" ]] || fail "platforms;android-${ANDROID_COMPILE_SDK} is missing."
[[ -d "$sdk_root/build-tools/${ANDROID_BUILD_TOOLS_VERSION}" ]] || fail "build-tools;${ANDROID_BUILD_TOOLS_VERSION} is missing."
printf 'ANDROID_SDK_ROOT=%s\nANDROID_HOME=%s\n' "$sdk_root" "$sdk_root" >> "$GITHUB_ENV"
echo "[android-release] ${version_output%%$'\n'*} at ${java_home}; SDK at ${sdk_root}."
