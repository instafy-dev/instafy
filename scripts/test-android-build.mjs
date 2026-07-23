#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendDir = path.join(repoRoot, "packages", "frontend");
const androidDir = path.join(frontendDir, "android");
const gradlew = path.join(androidDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");

const sdkPath = resolveAndroidSdkPath();
if (!sdkPath) {
  console.error("[test-android-build] failed: Unable to resolve Android SDK path. Set ANDROID_SDK_ROOT or ANDROID_HOME, or install the SDK under ~/Library/Android/sdk.");
  process.exit(1);
}

const javaVersion = resolveJavaMajorVersion();
if (javaVersion && javaVersion > 21) {
  console.error(
    `[test-android-build] failed: JAVA_HOME/java points to Java ${javaVersion}. Gradle in this repo currently needs Java 17 or 21. Switch JAVA_HOME (or Android Studio Gradle JDK) and retry.`,
  );
  process.exit(1);
}

run("node", [path.join(repoRoot, "scripts", "check-android-config.mjs")], repoRoot, process.env);
run("pnpm", ["-C", frontendDir, "cap:sync"], repoRoot, {
  ...process.env,
  ANDROID_SDK_ROOT: sdkPath,
  ANDROID_HOME: sdkPath,
});
run(gradlew, [":app:assembleDebug"], androidDir, {
  ...process.env,
  ANDROID_SDK_ROOT: sdkPath,
  ANDROID_HOME: sdkPath,
});

console.log(`[test-android-build] ok (${sdkPath})`);

function resolveAndroidSdkPath() {
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

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

function resolveJavaMajorVersion() {
  const result = spawnSync("java", ["-version"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) {
    return null;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = output.match(/version \"(\d+)(?:[._]\d+)?/i);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
