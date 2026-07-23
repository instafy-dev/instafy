#!/usr/bin/env node

/**
 * Stripe CLI helpers (local dev).
 *
 * Goals:
 * - Keep Stripe -> controller webhook forwarding simple via `stripe listen`.
 * - Make `.env.stripe` self-consistent (plans -> price IDs + Stripe CLI webhook secret).
 *
 * Commands:
 *   pnpm stripe:sync-env   # updates STRIPE_PRICE_ID_* + STRIPE_WEBHOOK_SECRET in .env.stripe
 *   pnpm stripe:listen     # forwards Stripe events to the local controller
 *
 * Required `.env.stripe` inputs for `sync-env`:
 *   STRIPE_PRODUCT_ID_PRO=prod_...
 *   STRIPE_PRODUCT_ID_SCALE=prod_...
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePrivateEnvPath,
  writePrivateEnvFileSync,
} from "./lib/privateEnvPaths.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const envPath = resolvePrivateEnvPath({
  repoRoot,
  relativePath: ".env.stripe",
});
const envExamplePath = path.join(repoRoot, ".env.stripe.example");

function isTruthy(value) {
  return (value ?? "").toString().trim().length > 0;
}

function fail(message) {
  console.error(`[stripe-cli] ${message}`);
  process.exit(1);
}

function readFileIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function parseEnv(text) {
  const map = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    map[key] = value;
  }
  return map;
}

function setEnvValue(text, key, value) {
  const lines = text.split(/\r?\n/);
  const normalized = `${key}=${value}`;
  let replaced = false;
  const next = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) return line;
    const idx = line.indexOf("=");
    if (idx === -1) return line;
    const currentKey = line.slice(0, idx).trim();
    if (currentKey !== key) return line;
    replaced = true;
    return normalized;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1].trim() !== "") {
      next.push("");
    }
    next.push(normalized);
  }
  return next.join("\n");
}

function runStripe(args, options = {}) {
  const result = spawnSync("stripe", ["--color", "off", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  const code = result.status ?? result["code"] ?? 1;
  if (code !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    fail(
      `stripe ${args.join(" ")} failed${stderr ? `: ${stderr}` : ` (exit ${code})`}`,
    );
  }
  return (result.stdout ?? "").toString();
}

function stripeJson(args) {
  const raw = runStripe(args);
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(
      `Expected JSON output from stripe ${args.join(" ")} but parse failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function ensureEnvFile() {
  if (fs.existsSync(envPath)) return;
  const example = readFileIfExists(envExamplePath);
  if (!example) {
    fail("Missing both .env.stripe and .env.stripe.example");
  }
  const writtenPath = writePrivateEnvFileSync({
    repoRoot,
    relativePath: ".env.stripe",
    data: example,
  });
  if (writtenPath !== envPath) {
    fail("Private Stripe env path changed between resolution and write");
  }
}

function normalizeForwardTo(raw) {
  const trimmed = (raw ?? "").toString().trim();
  if (!trimmed) return "http://127.0.0.1:8788/billing/webhooks/stripe";
  return trimmed;
}

function commandSyncEnv() {
  ensureEnvFile();
  const current = readFileIfExists(envPath) ?? "";
  const env = parseEnv(current);

  const productPro = env.STRIPE_PRODUCT_ID_PRO?.trim();
  const productScale = env.STRIPE_PRODUCT_ID_SCALE?.trim();
  if (!isTruthy(productPro) || !isTruthy(productScale)) {
    fail(
      "Set STRIPE_PRODUCT_ID_PRO and STRIPE_PRODUCT_ID_SCALE in .env.stripe before running stripe:sync-env.",
    );
  }

  const proProduct = stripeJson(["products", "retrieve", productPro]);
  const scaleProduct = stripeJson(["products", "retrieve", productScale]);

  const proPrice = (proProduct?.default_price ?? "").toString().trim();
  const scalePrice = (scaleProduct?.default_price ?? "").toString().trim();
  if (!isTruthy(proPrice) || !isTruthy(scalePrice)) {
    fail("Stripe product is missing default_price; create a recurring monthly price first.");
  }

  const proPriceDetails = stripeJson(["prices", "retrieve", proPrice]);
  const scalePriceDetails = stripeJson(["prices", "retrieve", scalePrice]);

  const proAmount = Number(proPriceDetails?.unit_amount ?? NaN);
  const scaleAmount = Number(scalePriceDetails?.unit_amount ?? NaN);
  if (Number.isFinite(proAmount) && proAmount !== 1000) {
    console.warn(
      `[stripe-cli] Warning: Pro default price amount is ${proAmount} cents (expected 1000).`,
    );
  }
  if (Number.isFinite(scaleAmount) && scaleAmount !== 10000) {
    console.warn(
      `[stripe-cli] Warning: Scale default price amount is ${scaleAmount} cents (expected 10000).`,
    );
  }

  const webhookSecret = runStripe(["listen", "--print-secret"]).trim();
  if (!isTruthy(webhookSecret)) {
    fail("stripe listen --print-secret returned an empty webhook secret");
  }

  let next = current;
  next = setEnvValue(next, "STRIPE_PRICE_ID_PRO", proPrice);
  next = setEnvValue(next, "STRIPE_PRICE_ID_SCALE", scalePrice);
  next = setEnvValue(next, "STRIPE_WEBHOOK_SECRET", webhookSecret);
  const writtenPath = writePrivateEnvFileSync({
    repoRoot,
    relativePath: ".env.stripe",
    data: next,
  });
  if (writtenPath !== envPath) {
    fail("Private Stripe env path changed between resolution and write");
  }

  console.log("[stripe-cli] Updated .env.stripe:");
  console.log("- STRIPE_PRICE_ID_PRO (from product default_price)");
  console.log("- STRIPE_PRICE_ID_SCALE (from product default_price)");
  console.log("- STRIPE_WEBHOOK_SECRET (from stripe listen --print-secret)");
}

function commandListen() {
  const forwardTo = normalizeForwardTo(process.env.STRIPE_FORWARD_TO);
  const events = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "invoice.payment_succeeded",
    "invoice.payment_failed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ];

  console.log("[stripe-cli] Forwarding Stripe webhooks →", forwardTo);
  console.log("[stripe-cli] Events:", events.join(", "));
  const result = spawnSync(
    "stripe",
    [
      "--color",
      "off",
      "listen",
      "--skip-update",
      "--forward-to",
      forwardTo,
      "--events",
      events.join(","),
    ],
    { stdio: "inherit", cwd: repoRoot, env: process.env },
  );
  process.exit(result.status ?? result["code"] ?? 1);
}

function usage() {
  console.log("Usage: node scripts/stripe-cli.mjs <command>");
  console.log("");
  console.log("Commands:");
  console.log("  sync-env   Update .env.stripe with price IDs + webhook secret");
  console.log("  listen     Forward Stripe webhooks to local controller");
  console.log("");
  console.log("Env:");
  console.log("  STRIPE_FORWARD_TO=http://127.0.0.1:8788/billing/webhooks/stripe");
}

function main() {
  const [command] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  switch (command) {
    case "sync-env":
      commandSyncEnv();
      return;
    case "listen":
      commandListen();
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

main();
