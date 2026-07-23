import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const RUN_LOCK_VERSION = 1;
const RUN_LOCK_DIRECTORY_NAME = ".run.lock";
const RUN_LOCK_OWNER_NAME = "owner.json";
const MAX_ACQUIRE_ATTEMPTS = 3;

type RunLockOwner = {
  version: typeof RUN_LOCK_VERSION;
  pid: number;
  nonce: string;
  createdAt: string;
};

export type ElectronBrowserLiveRunLock = {
  lockPath: string;
  release: () => void;
};

export class ElectronBrowserLiveRunLockError extends Error {
  constructor(detail: string) {
    super(`Electron Shared Browser production-smoke lock ${detail}.`);
    this.name = "ElectronBrowserLiveRunLockError";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function parseOwner(value: unknown): RunLockOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "createdAt,nonce,pid,version") {
    return null;
  }
  const pid = record.pid;
  const nonce = record.nonce;
  const createdAt = record.createdAt;
  if (
    record.version !== RUN_LOCK_VERSION ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof nonce !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(nonce) ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return null;
  }
  return {
    version: RUN_LOCK_VERSION,
    pid,
    nonce,
    createdAt,
  };
}

function readOwner(lockPath: string): RunLockOwner | null {
  try {
    const lockStat = fs.lstatSync(lockPath);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
      return null;
    }
    const ownerPath = path.join(lockPath, RUN_LOCK_OWNER_NAME);
    const ownerStat = fs.lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
      return null;
    }
    return parseOwner(JSON.parse(fs.readFileSync(ownerPath, "utf8")));
  } catch {
    return null;
  }
}

function writePreparedLock(directory: string, owner: RunLockOwner): string {
  const temporaryPath = path.join(
    directory,
    `${RUN_LOCK_DIRECTORY_NAME}.${owner.nonce}.tmp`,
  );
  fs.mkdirSync(temporaryPath, { mode: 0o700 });
  const ownerPath = path.join(temporaryPath, RUN_LOCK_OWNER_NAME);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      ownerPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(ownerPath, 0o600);
    return temporaryPath;
  } catch {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The safe error below is sufficient.
      }
    }
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    throw new ElectronBrowserLiveRunLockError("could not be prepared");
  }
}

function tryInstallPreparedLock(temporaryPath: string, lockPath: string): boolean {
  try {
    fs.renameSync(temporaryPath, lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST" || code === "ENOTEMPTY") {
      fs.rmSync(temporaryPath, { recursive: true, force: true });
      return false;
    }
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    throw new ElectronBrowserLiveRunLockError("could not be installed");
  }
}

function reclaimDeadOwner(lockPath: string, owner: RunLockOwner): boolean {
  if (isProcessAlive(owner.pid)) {
    return false;
  }
  const stalePath = `${lockPath}.stale.${owner.nonce}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
      return true;
    }
    throw new ElectronBrowserLiveRunLockError("could not reconcile a dead owner");
  }
  fs.rmSync(stalePath, { recursive: true, force: true });
  return true;
}

export function acquireElectronBrowserLiveRunLock(
  recoveryDirectory: string,
): ElectronBrowserLiveRunLock {
  const directory = path.resolve(recoveryDirectory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const lockPath = path.join(directory, RUN_LOCK_DIRECTORY_NAME);
  const owner: RunLockOwner = {
    version: RUN_LOCK_VERSION,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const temporaryPath = writePreparedLock(directory, owner);
    if (tryInstallPreparedLock(temporaryPath, lockPath)) {
      let released = false;
      return {
        lockPath,
        release: () => {
          if (released) {
            return;
          }
          const currentOwner = readOwner(lockPath);
          if (!currentOwner || currentOwner.nonce !== owner.nonce) {
            throw new ElectronBrowserLiveRunLockError("ownership changed before release");
          }
          fs.rmSync(lockPath, { recursive: true, force: true });
          released = true;
        },
      };
    }

    const existingOwner = readOwner(lockPath);
    if (!existingOwner) {
      throw new ElectronBrowserLiveRunLockError(
        "is held by an unreadable owner; refusing unsafe recovery",
      );
    }
    if (!reclaimDeadOwner(lockPath, existingOwner)) {
      throw new ElectronBrowserLiveRunLockError("is already held by a live process");
    }
  }

  throw new ElectronBrowserLiveRunLockError("could not be acquired after reconciliation");
}
