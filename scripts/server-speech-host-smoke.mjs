#!/usr/bin/env node

import process from "node:process";
import { launchServerVoicePublisher } from "./shared/server-voice-publisher.mjs";

async function waitForJson(
  url,
  predicate = () => true,
  timeoutMs = 90_000,
  requestInit = { method: "GET" },
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, requestInit);
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (predicate(payload)) {
          return payload;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const publisher = await launchServerVoicePublisher();

  try {
    const speechHealth = await waitForJson(publisher.speechServiceHealthUrl, (payload) => payload?.ok === true);
    const providerHealth = await waitForJson(
      publisher.providerHostHealthUrl,
      (payload) => payload?.ok === true && payload?.providers?.[0]?.id === "speech",
    );
    const discovery = await waitForJson(
      `${publisher.providerHostHealthUrl.replace(/\/health$/, "")}/provider/discover`,
      (payload) => payload?.ok === true && payload?.provider?.id === "speech",
    );
    const dependencyResource = await waitForJson(
      `${publisher.providerHostHealthUrl.replace(/\/health$/, "")}/provider/resources/read`,
      (payload) => payload?.ok === true && payload?.exists === true,
      90_000,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uri: "instafy://speech/dependencies" }),
      },
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          speechHealth,
          providerHealth,
          discovery,
          dependencyResource,
          publicUrl: publisher.publicUrl,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await publisher.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(
    `[server-speech-host-smoke] FAIL ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
