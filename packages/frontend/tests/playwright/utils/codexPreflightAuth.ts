import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TemporaryCodexPreflightAuth = {
  directory: string;
  authPath: string;
};

export function createTemporaryCodexPreflightAuth(
  sourceAuthPath: string,
  parentDirectory = os.tmpdir(),
): TemporaryCodexPreflightAuth {
  fs.mkdirSync(parentDirectory, { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(parentDirectory, "instafy-codex-preflight-auth-"),
  );

  try {
    fs.chmodSync(directory, 0o700);
    const authPath = path.join(directory, "auth.json");
    fs.copyFileSync(sourceAuthPath, authPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(authPath, 0o600);
    return { directory, authPath };
  } catch (error) {
    fs.rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

export function removeTemporaryCodexPreflightAuth(
  temporaryAuth: TemporaryCodexPreflightAuth | null,
): void {
  if (!temporaryAuth) return;
  fs.rmSync(temporaryAuth.directory, { force: true, recursive: true });
}
