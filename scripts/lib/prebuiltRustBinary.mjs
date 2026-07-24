import fs from "node:fs";
import path from "node:path";

export function resolveRustBinaryLaunch({
  env = process.env,
  envKey,
  repoRoot,
  cargoArgs,
  label,
}) {
  const configured = typeof env?.[envKey] === "string" ? env[envKey].trim() : "";
  if (!configured) {
    return { command: "cargo", args: [...cargoArgs], source: "cargo" };
  }

  const binaryPath = path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(repoRoot, configured);
  let stat;
  try {
    stat = fs.statSync(binaryPath);
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch (error) {
    throw new Error(
      `${label} prebuilt binary from ${envKey} is not executable: ${binaryPath} (${error.message})`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `${label} prebuilt binary from ${envKey} is not a regular file: ${binaryPath}`,
    );
  }

  return { command: binaryPath, args: [], source: "prebuilt" };
}
