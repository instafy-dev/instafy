import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { combineRequiredBrowserParts } from "./required-browser-reporter.mjs";

const RECEIPT = "required-browser-result.json";

/**
 * Every part's receipt under `directory`, where each downloaded part artifact
 * keeps its own folder. Symbolic links are not followed.
 */
export function readPartReceipts(directory) {
  const receipts = [];
  const visit = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const location = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(location);
      else if (entry.isFile() && entry.name === RECEIPT) receipts.push(JSON.parse(fs.readFileSync(location, "utf8")));
    }
  };
  visit(directory);
  return receipts;
}

/** Checks a lane run in parts from its parts' receipts; returns the exit code. */
export function checkRequiredBrowserParts(args = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.length !== 2) {
    throw new Error("Usage: node packages/frontend/scripts/required-browser-parts.mjs <lane> <folder with the parts' results>");
  }
  const [lane, directory] = args;
  const result = combineRequiredBrowserParts(lane, readPartReceipts(directory));
  stdout.write(`[required-browser] ${result.lane}: ${result.selected} tests passed in ${result.parts} parts; ${result.status}\n`);
  for (const failure of result.failures) stderr.write(`[required-browser] ${failure}\n`);
  return result.status === "passed" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = checkRequiredBrowserParts();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
