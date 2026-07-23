import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMacosBluetoothElectronBinary } from "./ensure-macos-bluetooth-usage.mjs";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const forwardedArgs = process.argv.slice(2);
const electronArgs =
  forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
const require = createRequire(import.meta.url);
const appDir = fileURLToPath(new URL("..", import.meta.url));
let command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let args = ["exec", "electron", ".", ...electronArgs];

function resolveAppBundlePath(executablePath) {
  return path.resolve(executablePath, "..", "..", "..");
}

try {
  const electronBinary = require("electron");
  const preparedElectronBinary = prepareMacosBluetoothElectronBinary(electronBinary);
  if (preparedElectronBinary && preparedElectronBinary !== electronBinary) {
    const preparedAppBundle = resolveAppBundlePath(preparedElectronBinary);
    if (process.platform === "darwin") {
      command = "open";
      args = ["-W", "-n", "-a", preparedAppBundle, "--args", appDir, ...electronArgs];
      const explicitUrl = process.env.INSTAFY_APP_URL?.trim();
      if (explicitUrl) {
        args.push(`--instafy-app-url=${explicitUrl}`);
      }
      const explicitUserDataDir = process.env.INSTAFY_DESKTOP_USER_DATA_DIR?.trim();
      if (explicitUserDataDir) {
        args.push(`--instafy-user-data-dir=${explicitUserDataDir}`);
      }
      if (process.env.INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES?.trim()) {
        args.push("--allow-multiple-instances");
      }
    } else {
      command = preparedElectronBinary;
      args = [appDir, ...electronArgs];
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[desktop-launch] unable to patch macOS Bluetooth usage description: ${message}`);
}

const child = spawn(command, args, { stdio: "inherit", env });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
