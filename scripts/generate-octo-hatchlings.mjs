#!/usr/bin/env node
// Generates packages/frontend/src/assets/octo-hatchlings.geometry.json, the
// drawings OctoHatchling renders (docs/Brand.md, "Octo's hatchlings"), from
// the poses in scripts/octo-hatchlings/family.mjs. The output is
// deterministic: the same poses give the same bytes.
//
//   node scripts/generate-octo-hatchlings.mjs                # write the geometry
//   node scripts/generate-octo-hatchlings.mjs --check        # fail if it is stale
//   node scripts/generate-octo-hatchlings.mjs --out <json>   # write (or --check) another file
//
// The geometry is in Octo's mark frame: viewBox 0 0 64 64, drawn at 75% of
// the AI tile like OctoMark, one ink. Each face lists its arms, then its dome
// as one even-odd path (the eyes, or the hollow face's inner dome, cut out of
// it), then its circles: the dot, or the hollow face's eyes.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { HATCHLINGS, UNKNOWN } from "./octo-hatchlings/family.mjs";
import { build, faceGeometry } from "./octo-hatchlings/hatch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GEOMETRY_PATH = "packages/frontend/src/assets/octo-hatchlings.geometry.json";

/** The geometry file's text: seats 1 to 8 by number, then the hollow face. */
export function renderOctoHatchlingsGeometry() {
  const faces = {};
  HATCHLINGS.forEach((face, index) => {
    faces[index + 1] = { name: face.name, ...faceGeometry(build(face.pose())) };
  });
  faces.unknown = { name: UNKNOWN.name, ...faceGeometry(build(UNKNOWN.pose())) };
  const geometry = {
    viewBox: "0 0 64 64",
    frame: "Octo's mark frame: draw at 75% of the AI tile, centred, like OctoMark",
    fill: "currentColor",
    faces,
  };
  return `${JSON.stringify(geometry, null, 2)}\n`;
}

function main(args) {
  let check = false;
  let out = path.join(repoRoot, GEOMETRY_PATH);
  // Only --check and --out <json>: anything else (a typo, --out=...) stops
  // here rather than falling through to overwriting the checked-in file.
  while (args.length) {
    const name = args.shift();
    if (name === "--check") {
      check = true;
    } else if (name === "--out" && args.length && !args[0].startsWith("--")) {
      out = path.resolve(process.cwd(), args.shift());
    } else {
      throw new Error(`usage: [--check] [--out <json>]; got ${name}`);
    }
  }
  const text = renderOctoHatchlingsGeometry();
  const label = out.startsWith(`${repoRoot}${path.sep}`) ? path.relative(repoRoot, out) : out;
  if (check) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
    if (current !== text) {
      throw new Error(`${label} is not what the poses draw; run node scripts/generate-octo-hatchlings.mjs`);
    }
    console.log(`[generate-octo-hatchlings] ${label} is current`);
    return;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`[generate-octo-hatchlings] wrote ${label} (${Buffer.byteLength(text)} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[generate-octo-hatchlings] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
