#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, inlineValue] = arg.split("=", 2);
    if (inlineValue !== undefined) {
      options.set(key, inlineValue);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      options.set(key, "true");
      continue;
    }
    options.set(key, value);
    index += 1;
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(process.cwd(), args.get("--out") || "tmp/ota-signing");
const prefix = args.get("--prefix") || "instafy-ota";

fs.mkdirSync(outDir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" });
const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });

const privateKeyPath = path.join(outDir, `${prefix}.private.pem`);
const publicKeyPath = path.join(outDir, `${prefix}.public.pem`);

fs.writeFileSync(privateKeyPath, privateKeyPem, { encoding: "utf8", mode: 0o600 });
fs.writeFileSync(publicKeyPath, publicKeyPem, { encoding: "utf8", mode: 0o644 });

console.log(`[ota:keygen] private=${privateKeyPath}`);
console.log(`[ota:keygen] public=${publicKeyPath}`);
console.log("[ota:keygen] configure:");
console.log("- GitHub secret: OTA_SIGNING_PRIVATE_KEY");
console.log("- Native build env: CAPACITOR_LIVE_UPDATE_PUBLIC_KEY");
