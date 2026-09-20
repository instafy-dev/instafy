#!/usr/bin/env node
// Pick the newest /Applications/Xcode_<major>.<minor>[.<patch>].app for the
// required major and export DEVELOPER_DIR (no global Xcode switch, no sudo).
//
// usage: select-xcode.mjs <required-major>   (prints the Developer directory)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APPLICATIONS = "/Applications";

function parseVersion(name, major) {
  const match = /^Xcode_([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?\.app$/u.exec(name);
  if (!match || Number(match[1]) !== major) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function selectXcode(names, major) {
  if (!Number.isSafeInteger(major) || major < 1) throw new Error("required Xcode major is invalid");
  const candidates = names
    .map((name) => ({ name, version: parseVersion(name, major) }))
    .filter((candidate) => candidate.version !== null)
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        if (left.version[index] !== right.version[index]) {
          return right.version[index] - left.version[index];
        }
      }
      return 0;
    });
  if (candidates.length === 0) throw new Error(`no Xcode ${major}.x is installed`);
  return candidates[0].name;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const major = Number(process.argv[2]);
    const names = fs.readdirSync(APPLICATIONS).filter((name) => {
      const info = fs.lstatSync(path.join(APPLICATIONS, name));
      return info.isDirectory() && !info.isSymbolicLink();
    });
    const selected = selectXcode(names, major);
    const developerDir = path.join(APPLICATIONS, selected, "Contents", "Developer");
    const info = fs.lstatSync(developerDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("selected Xcode is incomplete");
    process.stdout.write(`${developerDir}\n`);
  } catch (error) {
    console.error(`::error::[ios-xcode] ${error instanceof Error ? error.message : "selection failed"}`);
    process.exitCode = 1;
  }
}
