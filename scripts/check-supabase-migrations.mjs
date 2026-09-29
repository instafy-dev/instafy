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

// The first words of the statements that end or open a transaction. Each
// migration runs in the one transaction its runner opens and commits, and the
// empty-database test reads the locks a migration holds before that commit.
const TRANSACTION_CONTROL = new Set([
  "abort",
  "begin",
  "commit",
  "end",
  "rollback",
  "start",
]);
const ROUTINE_KINDS = new Set(["function", "procedure"]);
const IDENTIFIER = /[A-Za-z_\u{80}-\u{10FFFF}][A-Za-z0-9_$\u{80}-\u{10FFFF}]*/uy;
const DOLLAR_QUOTE = /\$(?:[A-Za-z_\u{80}-\u{10FFFF}][A-Za-z0-9_\u{80}-\u{10FFFF}]*)?\$/uy;

function matchAt(pattern, text, index) {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0] ?? null;
}

// The end of the quoted string or identifier that opens at `index`. A doubled
// quote stands for itself, and an E'...' string also escapes with a backslash.
function quotedEnd(sql, index, backslashEscapes) {
  const quote = sql[index];
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (backslashEscapes && sql[cursor] === "\\") {
      cursor += 2;
    } else if (sql[cursor] === quote) {
      if (sql[cursor + 1] !== quote) {
        return cursor + 1;
      }
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return sql.length;
}

// The first word of every top-level statement in `sql`, lowercased. Comments,
// quoted strings and identifiers, and dollar-quoted bodies such as a DO block
// or a function body are skipped, so the BEGIN and END inside them do not
// count. Statements split the way psql splits them: a semicolon inside
// parentheses, or inside the BEGIN ATOMIC body of a CREATE FUNCTION or
// PROCEDURE, does not end one.
function topLevelStatementKeywords(sql) {
  const keywords = [];
  let words = [];
  let parenDepth = 0;
  let beginDepth = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const identifier = matchAt(IDENTIFIER, sql, index);
    const dollarQuote = identifier ? null : matchAt(DOLLAR_QUOTE, sql, index);
    if (sql.startsWith("--", index)) {
      const lineEnd = sql.indexOf("\n", index);
      index = lineEnd === -1 ? sql.length : lineEnd + 1;
    } else if (sql.startsWith("/*", index)) {
      let depth = 0;
      do {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      } while (depth > 0 && index < sql.length);
    } else if (dollarQuote) {
      const close = sql.indexOf(dollarQuote, index + dollarQuote.length);
      index = close === -1 ? sql.length : close + dollarQuote.length;
    } else if (identifier) {
      const word = identifier.toLowerCase();
      index += identifier.length;
      if (sql[index] === "'" && word === "e") {
        index = quotedEnd(sql, index, true);
        continue;
      }
      if (words.length === 0) {
        keywords.push(word);
      }
      words.push(word);
      const [create, second, third, fourth] = words;
      const routine =
        create === "create" &&
        (ROUTINE_KINDS.has(second) ||
          (second === "or" && third === "replace" && ROUTINE_KINDS.has(fourth)));
      if (routine && parenDepth === 0) {
        if (word === "begin" || (word === "case" && beginDepth > 0)) {
          beginDepth += 1;
        } else if (word === "end" && beginDepth > 0) {
          beginDepth -= 1;
        }
      }
    } else if (char === "'" || char === '"') {
      index = quotedEnd(sql, index, false);
      words.push(char);
    } else {
      if (char === "(") {
        parenDepth += 1;
      } else if (char === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (char === ";" && parenDepth === 0 && beginDepth === 0) {
        words = [];
      }
      index += 1;
    }
  }
  return keywords;
}

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
    const source = readFileSync(path.join(directory, entry.name));
    if (source.length === 0) {
      throw new Error(`public migration is empty: ${entry.name}`);
    }
    const control = topLevelStatementKeywords(source.toString("utf8")).find(
      (keyword) => TRANSACTION_CONTROL.has(keyword),
    );
    if (control) {
      throw new Error(
        `public migration ${entry.name} has a top-level ${control.toUpperCase()}; it must run in the one transaction its runner opens and commits`,
      );
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
  topLevelStatementKeywords,
  validatePublicMigrationTrack,
};
