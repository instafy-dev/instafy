#!/usr/bin/env node

import { createHmac, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import process from "node:process";
import tls from "node:tls";

const DEFAULT_IMAGE =
  "coturn/coturn:4.6.3-r3@sha256:71c3c990283385567f11794ee692e3a47b66fd9b0bb39e42afbe776e331dd888";

export function credentialFor(sharedSecret, username) {
  return createHmac("sha1", sharedSecret).update(username).digest("base64");
}

export function buildTurnutilsArgs({ host, port, username, credential, secure }) {
  return [
    "run",
    "--rm",
    "--entrypoint",
    "turnutils_uclient",
    process.env.TURN_COTURN_IMAGE || DEFAULT_IMAGE,
    ...(secure ? ["-t", "-S"] : []),
    "-y",
    "-c",
    "-n",
    "3",
    "-p",
    String(port),
    "-u",
    username,
    "-w",
    credential,
    host,
  ];
}

function parsePositiveInteger(value, fallback, name) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyTls(host) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({
      host,
      port: 443,
      servername: host,
      rejectUnauthorized: true,
      timeout: 10_000,
    });
    const done = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("secureConnect", () => {
      if (!socket.authorized) done(new Error(socket.authorizationError || "TLS is not authorized"));
      else done();
    });
    socket.once("timeout", () => done(new Error("TLS connection timed out")));
    socket.once("error", done);
  });
}

function runAllocation({ host, port, username, credential, secure, expectSuccess }) {
  const result = spawnSync(
    "docker",
    buildTurnutilsArgs({ host, port, username, credential, secure }),
    { encoding: "utf8", timeout: 45_000 },
  );
  const succeeded = result.status === 0 && !result.error;
  if (succeeded !== expectSuccess) {
    const output = [result.stdout, result.stderr]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(-4_000);
    throw new Error(
      `${secure ? "TLS/TCP" : "UDP"} TURN allocation ${expectSuccess ? "failed" : "accepted invalid credentials"}` +
        (result.error ? `: ${result.error.message}` : output ? `\n${output}` : ""),
    );
  }
}

export async function runTurnRelaySmoke(env = process.env) {
  const host = String(env.TURN_HOST || env.TURN_PUBLIC_HOST || "").trim().toLowerCase();
  const sharedSecret = String(env.TURN_SHARED_SECRET || "").trim();
  if (!host || host.includes("://") || host.includes("/")) {
    throw new Error("TURN_HOST must be a DNS hostname");
  }
  if (sharedSecret.length < 32) {
    throw new Error("TURN_SHARED_SECRET must contain at least 32 bytes");
  }

  const attempts = parsePositiveInteger(env.TURN_RELAY_SMOKE_ATTEMPTS, 60, "TURN_RELAY_SMOKE_ATTEMPTS");
  const retryMs = parsePositiveInteger(env.TURN_RELAY_SMOKE_RETRY_MS, 10_000, "TURN_RELAY_SMOKE_RETRY_MS");
  const mode = String(env.TURN_RELAY_SMOKE_MODE || "both").trim().toLowerCase();
  if (!["both", "udp", "tls"].includes(mode)) throw new Error("TURN_RELAY_SMOKE_MODE must be both, udp, or tls");

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const username = `${expiresAt}:deployment-smoke:${randomUUID()}`;
    const credential = credentialFor(sharedSecret, username);
    try {
      const addresses = await dns.resolve4(host);
      if (addresses.length === 0) throw new Error(`${host} has no public A record`);
      if (mode === "both" || mode === "tls") {
        await verifyTls(host);
        runAllocation({ host, port: 443, username, credential, secure: true, expectSuccess: true });
      }
      if (mode === "both" || mode === "udp") {
        runAllocation({ host, port: 3478, username, credential, secure: false, expectSuccess: true });
      }

      // An auth probe prevents a listener-only false positive. The temporary
      // invalid credential is never printed and must be rejected by coturn.
      runAllocation({
        host,
        port: mode === "tls" ? 443 : 3478,
        username,
        credential: `${credential.slice(0, -2)}xx`,
        secure: mode === "tls",
        expectSuccess: false,
      });

      console.log(
        `[turn-relay-smoke] Authenticated ${mode} relay allocation and invalid-credential rejection passed for ${host}.`,
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      console.log(`[turn-relay-smoke] TURN not ready (attempt ${attempt}/${attempts}); retrying...`);
      await wait(retryMs);
    }
  }
  throw lastError || new Error("TURN relay smoke failed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTurnRelaySmoke().catch((error) => {
    console.error(`[turn-relay-smoke] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
