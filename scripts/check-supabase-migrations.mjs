#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_MIGRATIONS = path.join(REPO_ROOT, "supabase", "migrations");
const LANE_BOUNDARY = 20260000000063n;
const MIGRATION_NAME = /^([0-9]{14})_([a-z0-9][a-z0-9_]*)\.sql$/u;
const LEGACY_PUBLIC_MIGRATION_COUNT = 64;
const LEGACY_PUBLIC_MIGRATION_SET_SHA256 =
  "7835727c4a5699afdfb2a193487b41606f7a873cad164941b8d4e4788b56645d";

function migrationVersion(fileName) {
  const match = MIGRATION_NAME.exec(fileName);
  if (!match) {
    throw new Error(`invalid public migration filename: ${fileName}`);
  }
  return BigInt(match[1]);
}

function publicMigrationSetSha256(migrations) {
  const hash = createHash("sha256");
  for (const migration of migrations) {
    hash.update(migration.version.toString());
    hash.update("\t");
    hash.update(migration.fileName);
    hash.update("\t");
    hash.update(
      createHash("sha256")
        .update(readFileSync(migration.source))
        .digest("hex"),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

function validatePublicMigrationTrack(directory = DEFAULT_MIGRATIONS) {
  if (!existsSync(directory)) {
    throw new Error("public migration directory is missing");
  }
  const migrations = [];
  const versions = new Set();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      throw new Error(`public migration track contains a non-file: ${entry.name}`);
    }
    const version = migrationVersion(entry.name);
    if (versions.has(version.toString())) {
      throw new Error(`duplicate public migration version: ${version}`);
    }
    versions.add(version.toString());
    if (readFileSync(path.join(directory, entry.name)).length === 0) {
      throw new Error(`public migration is empty: ${entry.name}`);
    }
    if (version > LANE_BOUNDARY && version % 2n !== 0n) {
      throw new Error(
        `public migration ${entry.name} is outside the reserved even version lane`,
      );
    }
    migrations.push({
      fileName: entry.name,
      source: path.join(directory, entry.name),
      track: "public",
      version,
    });
  }
  const sorted = migrations.sort(
    (left, right) =>
      (left.version < right.version ? -1 : left.version > right.version ? 1 : 0) ||
      left.fileName.localeCompare(right.fileName),
  );
  if (path.resolve(directory) === DEFAULT_MIGRATIONS) {
    const legacy = sorted.filter(
      (migration) => migration.version <= LANE_BOUNDARY,
    );
    if (
      legacy.length !== LEGACY_PUBLIC_MIGRATION_COUNT ||
      publicMigrationSetSha256(legacy) !==
        LEGACY_PUBLIC_MIGRATION_SET_SHA256
    ) {
      throw new Error(
        "legacy public migration history does not match the immutable split baseline",
      );
    }
  }
  return sorted;
}

function main() {
  if (process.argv.length !== 2) {
    throw new Error("check-supabase-migrations.mjs does not accept arguments");
  }
  const migrations = validatePublicMigrationTrack();
  console.log(`Validated ${migrations.length} public Supabase migration(s)`);
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? `Public migration validation failed: ${error.message}`
        : "Public migration validation failed",
    );
    process.exitCode = 1;
  }
}

export {
  LEGACY_PUBLIC_MIGRATION_COUNT,
  LEGACY_PUBLIC_MIGRATION_SET_SHA256,
  LANE_BOUNDARY,
  MIGRATION_NAME,
  migrationVersion,
  publicMigrationSetSha256,
  validatePublicMigrationTrack,
};
