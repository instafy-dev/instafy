#!/usr/bin/env node
/**
 * Lightweight static checks for the Capacitor Android project.
 *
 * These checks stay text-based so CI/local runs can catch drift before Gradle sync.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const paths = {
  capacitorConfig: path.join(repoRoot, "packages", "frontend", "capacitor.config.ts"),
  nativeAuth: path.join(repoRoot, "packages", "frontend", "src", "auth", "nativeAuth.ts"),
  manifest: path.join(repoRoot, "packages", "frontend", "android", "app", "src", "main", "AndroidManifest.xml"),
  stringsXml: path.join(repoRoot, "packages", "frontend", "android", "app", "src", "main", "res", "values", "strings.xml"),
  mainActivity: path.join(
    repoRoot,
    "packages",
    "frontend",
    "android",
    "app",
    "src",
    "main",
    "java",
    "dev",
    "instafy",
    "studio",
    "MainActivity.java",
  ),
  mainApplication: path.join(
    repoRoot,
    "packages",
    "frontend",
    "android",
    "app",
    "src",
    "main",
    "java",
    "dev",
    "instafy",
    "studio",
    "MainApplication.java",
  ),
  runtimeConfigPlugin: path.join(
    repoRoot,
    "packages",
    "frontend",
    "android",
    "app",
    "src",
    "main",
    "java",
    "dev",
    "instafy",
    "studio",
    "InstafyRuntimeConfigPlugin.java",
  ),
  debugOtaProof: path.join(repoRoot, "scripts", "android-debug-ota-proof.mjs"),
  authBridgePlugin: path.join(
    repoRoot,
    "packages",
    "frontend",
    "android",
    "app",
    "src",
    "main",
    "java",
    "dev",
    "instafy",
    "studio",
    "InstafyAuthBridgePlugin.java",
  ),
  appBuildGradle: path.join(repoRoot, "packages", "frontend", "android", "app", "build.gradle"),
  variablesGradle: path.join(repoRoot, "packages", "frontend", "android", "variables.gradle"),
  gradlew: path.join(repoRoot, "packages", "frontend", "android", "gradlew"),
};

const failures = [];

const capacitorConfig = read(paths.capacitorConfig);
expectContains(
  capacitorConfig,
  "StatusBar: {",
  `${relative(paths.capacitorConfig)} must configure the native status bar before the WebView renders`,
);
expectContains(
  capacitorConfig,
  'backgroundColor: "#ffffff"',
  `${relative(paths.capacitorConfig)} must use a light initial status-bar background`,
);
expectContains(
  capacitorConfig,
  "overlaysWebView: false",
  `${relative(paths.capacitorConfig)} must keep legacy Android content below the status bar`,
);
expectContains(
  capacitorConfig,
  'style: "LIGHT"',
  `${relative(paths.capacitorConfig)} must use dark initial status-bar icons`,
);

const nativeAuth = read(paths.nativeAuth);
expectContains(
  nativeAuth,
  'export const NATIVE_AUTH_CALLBACK_URL = "instafy://auth";',
  `${relative(paths.nativeAuth)} must keep the native callback URL as instafy://auth`,
);
expectContains(
  nativeAuth,
  'export const NATIVE_AUTH_CALLBACK_SCHEME = "instafy";',
  `${relative(paths.nativeAuth)} must keep the native callback scheme as instafy`,
);
expectContains(
  nativeAuth,
  'export const NATIVE_AUTH_CALLBACK_HOST = "auth";',
  `${relative(paths.nativeAuth)} must keep the native callback host as auth`,
);

const manifest = read(paths.manifest);
expectContains(
  manifest,
  'android:scheme="instafy" android:host="auth"',
  `${relative(paths.manifest)} must keep the instafy://auth deep link intent filter`,
);
expectContains(
  manifest,
  'android:scheme="dev.instafy.studio" android:host="auth"',
  `${relative(paths.manifest)} must keep the legacy Android app-id deep link intent filter`,
);
expectContains(
  manifest,
  'android:scheme="instafy" android:pathPrefix="/auth"',
  `${relative(paths.manifest)} must keep the path-style instafy:///auth deep link intent filter`,
);
expectContains(
  manifest,
  'android:scheme="dev.instafy.studio" android:pathPrefix="/auth"',
  `${relative(paths.manifest)} must keep the legacy path-style deep link intent filter`,
);
expectContains(
  manifest,
  '<data android:scheme="instafy" />',
  `${relative(paths.manifest)} must keep the generic instafy:// deep link filter for studio and invite handoffs`,
);
expectContains(
  manifest,
  '<data android:scheme="dev.instafy.studio" />',
  `${relative(paths.manifest)} must keep the generic legacy deep link filter for studio and invite handoffs`,
);
expectContains(
  manifest,
  'android:exported="true"',
  `${relative(paths.manifest)} must keep MainActivity exported for launcher/deep-link entry`,
);
expectContains(
  manifest,
  '<uses-permission android:name="android.permission.INTERNET" />',
  `${relative(paths.manifest)} must retain INTERNET permission`,
);

const appBuildGradle = read(paths.appBuildGradle);
expectContains(
  appBuildGradle,
  'namespace = "dev.instafy.studio"',
  `${relative(paths.appBuildGradle)} must keep namespace dev.instafy.studio`,
);
expectContains(
  appBuildGradle,
  'applicationId "dev.instafy.studio"',
  `${relative(paths.appBuildGradle)} must keep applicationId dev.instafy.studio`,
);

const stringsXml = read(paths.stringsXml);
expectContains(
  stringsXml,
  '<string name="custom_url_scheme">instafy</string>',
  `${relative(paths.stringsXml)} must keep custom_url_scheme aligned with instafy://auth`,
);

const mainActivity = read(paths.mainActivity);
expectContains(
  mainActivity,
  "registerPlugin(InstafyRuntimeConfigPlugin.class);",
  `${relative(paths.mainActivity)} must register the native runtime policy bridge before loading the WebView`,
);
expectContains(
  mainActivity,
  "registerPlugin(InstafyAuthBridgePlugin.class);",
  `${relative(paths.mainActivity)} must register the native auth bridge plugin`,
);
expectContains(
  mainActivity,
  "setIntent(intent);",
  `${relative(paths.mainActivity)} must update the current activity intent for warm deep links`,
);

const mainApplication = read(paths.mainApplication);
expectContains(
  mainApplication,
  'deleteSharedPreferences("CapawesomeLiveUpdate");',
  `${relative(paths.mainApplication)} must clear retained Live Update preferences in debug builds`,
);
expectContains(
  mainApplication,
  'new File(getFilesDir(), "_capacitor_live_update_bundles")',
  `${relative(paths.mainApplication)} must clear retained Live Update bundles in debug builds`,
);

const runtimeConfigPlugin = read(paths.runtimeConfigPlugin);
expectContains(
  runtimeConfigPlugin,
  '@CapacitorPlugin(name = "InstafyRuntimeConfig")',
  `${relative(paths.runtimeConfigPlugin)} must expose the runtime policy bridge expected by the frontend`,
);
expectContains(
  runtimeConfigPlugin,
  "ApplicationInfo.FLAG_DEBUGGABLE",
  `${relative(paths.runtimeConfigPlugin)} must derive OTA policy from the signed native build flags`,
);
expectContains(
  runtimeConfigPlugin,
  'payload.put("disableNativeOta", isDebuggable);',
  `${relative(paths.runtimeConfigPlugin)} must disable web OTA bootstrap only for debug binaries`,
);

const debugOtaProof = read(paths.debugOtaProof);
expectContains(
  debugOtaProof,
  "InstafyRuntimeConfig?.getRuntimeConfig",
  `${relative(paths.debugOtaProof)} must verify the native debug OTA policy through the WebView`,
);
expectContains(
  debugOtaProof,
  "LiveUpdate?.getCurrentBundle",
  `${relative(paths.debugOtaProof)} must verify that no native Live Update bundle is selected`,
);
expectContains(
  debugOtaProof,
  "files/_capacitor_live_update_bundles",
  `${relative(paths.debugOtaProof)} must verify that no retained Live Update bundle directory exists`,
);
expectContains(
  debugOtaProof,
  '["shell", "am", "force-stop", appId]',
  `${relative(paths.debugOtaProof)} must repeat its proof after a cold process relaunch`,
);
for (const assetName of ["index", "StudioRoute", "StudioProviders"]) {
  expectContains(
    debugOtaProof,
    `"${assetName}"`,
    `${relative(paths.debugOtaProof)} must identify the emitted ${assetName} JavaScript proof asset`,
  );
}

const authBridgePlugin = read(paths.authBridgePlugin);
expectContains(
  authBridgePlugin,
  '@CapacitorPlugin(name = "InstafyAuthBridge")',
  `${relative(paths.authBridgePlugin)} must expose the InstafyAuthBridge Capacitor plugin`,
);
expectContains(
  authBridgePlugin,
  'notifyListeners(EVENT_URL_OPEN, payload, true);',
  `${relative(paths.authBridgePlugin)} must retain native auth deep-link events until JS consumes them`,
);

const variablesGradle = read(paths.variablesGradle);
expectContains(
  variablesGradle,
  'compileSdkVersion = 36',
  `${relative(paths.variablesGradle)} should keep compileSdkVersion at 36`,
);
expectContains(
  variablesGradle,
  'targetSdkVersion = 36',
  `${relative(paths.variablesGradle)} should keep targetSdkVersion at 36`,
);
expectContains(
  variablesGradle,
  'minSdkVersion = 24',
  `${relative(paths.variablesGradle)} should keep minSdkVersion at 24`,
);

if (!fs.existsSync(paths.gradlew)) {
  failures.push(`${relative(paths.gradlew)} is missing; Android builds cannot run.`);
}

const resolvedSdk = resolveAndroidSdkPath();
if (!resolvedSdk) {
  failures.push(
    "Unable to resolve Android SDK path. Set ANDROID_SDK_ROOT or ANDROID_HOME, or install the SDK under ~/Library/Android/sdk.",
  );
} else {
  const platformToolsAdb = path.join(resolvedSdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  if (!fs.existsSync(platformToolsAdb)) {
    failures.push(`Android SDK at ${resolvedSdk} is missing platform-tools/adb.`);
  }
}

if (failures.length > 0) {
  console.error("[check-android-config] failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`[check-android-config] ok (${resolvedSdk})`);

export function resolveAndroidSdkPath() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(os.homedir(), "Library", "Android", "sdk"),
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => path.resolve(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function read(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`Unable to read ${relative(filePath)}: ${message}`);
    return "";
  }
}

function expectContains(content, needle, failureMessage) {
  if (!content.includes(needle)) {
    failures.push(failureMessage);
  }
}

function relative(filePath) {
  return path.relative(repoRoot, filePath) || filePath;
}
