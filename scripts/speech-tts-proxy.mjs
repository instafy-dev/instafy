#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const proxyManifestPath = path.join(repoRoot, "packages", "openai-proxy-server", "Cargo.toml");
const repoOpenAiEnvPath = path.join(repoRoot, ".env.openai");
const defaultBindHost = process.env.SPEECH_TTS_PROXY_HOST?.trim() || "127.0.0.1";
const defaultPort = Number(process.env.SPEECH_TTS_PROXY_PORT || 8799);
const defaultAuthCandidates = [
  process.env.CODEX_AUTH_PATH?.trim(),
  path.join(repoRoot, "tmp", "proxy-codex", "auth.json"),
  path.join(os.homedir(), ".codex", "auth.json"),
].filter(Boolean);

function printHelp() {
  console.log(`Usage: node scripts/speech-tts-proxy.mjs [--port 8799] [--host 127.0.0.1] [--auth-path /abs/path/auth.json]

Starts the local OpenAI-compatible proxy with the speech synthesis route enabled and prints the
LOCAL_SPEECH_TTS_BACKEND_URL and LOCAL_SPEECH_TRANSCRIPTION_BACKEND_URL you can export for speech bootstrap / fixture checks.

Credential resolution:
- OPENAI_API_KEY from the current environment, or
- OPENAI_API_KEY from ${repoOpenAiEnvPath}, or
- --auth-path / CODEX_AUTH_PATH, or
- tmp/proxy-codex/auth.json, or
- ~/.codex/auth.json
`);
}

function parseArgs(argv) {
  const result = {
    host: defaultBindHost,
    port: Number.isFinite(defaultPort) && defaultPort > 0 ? defaultPort : 8799,
    authPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--port") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --port value: ${argv[index + 1] ?? "<missing>"}`);
      }
      result.port = value;
      index += 1;
      continue;
    }
    if (arg === "--host") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --host.");
      }
      result.host = value;
      index += 1;
      continue;
    }
    if (arg === "--auth-path") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --auth-path.");
      }
      result.authPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function readEnvFileValue(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (!line.startsWith(`${key}=`)) {
      continue;
    }
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

function resolveCredentialSource(explicitAuthPath) {
  const envApiKey = process.env.OPENAI_API_KEY?.trim();
  if (envApiKey) {
    return {
      openAiApiKey: envApiKey,
      openAiApiKeySource: "OPENAI_API_KEY",
      authPath: null,
    };
  }
  const envFileApiKey = readEnvFileValue(repoOpenAiEnvPath, "OPENAI_API_KEY");
  if (envFileApiKey) {
    return {
      openAiApiKey: envFileApiKey,
      openAiApiKeySource: repoOpenAiEnvPath,
      authPath: null,
    };
  }
  if (explicitAuthPath) {
    if (!fs.existsSync(explicitAuthPath)) {
      throw new Error(`Auth file not found: ${explicitAuthPath}`);
    }
    return {
      openAiApiKey: null,
      openAiApiKeySource: null,
      authPath: explicitAuthPath,
    };
  }
  for (const candidate of defaultAuthCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return {
        openAiApiKey: null,
        openAiApiKeySource: null,
        authPath: candidate,
      };
    }
  }
  throw new Error(
    `No speech proxy credentials found. Set OPENAI_API_KEY, add it to ${repoOpenAiEnvPath}, pass --auth-path, or provide tmp/proxy-codex/auth.json / ~/.codex/auth.json.`,
  );
}

function printExports(host, port, credentialSource) {
  const ttsUrl = `http://${host}:${port}/v1/audio/speech`;
  const transcriptionUrl = `http://${host}:${port}/v1/audio/transcriptions`;
  console.log(`[speech-tts-proxy] starting local speech TTS proxy on ${host}:${port}`);
  console.log(`[speech-tts-proxy] export LOCAL_SPEECH_TTS_BACKEND_URL=${ttsUrl}`);
  console.log(
    `[speech-tts-proxy] export LOCAL_SPEECH_TRANSCRIPTION_BACKEND_URL=${transcriptionUrl}`,
  );
  if (credentialSource.openAiApiKey) {
    console.log(
      `[speech-tts-proxy] using OPENAI_API_KEY from ${credentialSource.openAiApiKeySource}`,
    );
  } else if (credentialSource.authPath) {
    console.log(`[speech-tts-proxy] using CODEX_AUTH_PATH=${credentialSource.authPath}`);
  } else {
    console.log("[speech-tts-proxy] using OPENAI_API_KEY from the current environment");
  }
}

function forwardSignal(child, signal) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const credentialSource = resolveCredentialSource(args.authPath);
  printExports(args.host, args.port, credentialSource);

  const child = spawn(
    "cargo",
    [
      "run",
      "--manifest-path",
      proxyManifestPath,
      "--bin",
      "proxy",
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        ...(credentialSource.openAiApiKey
          ? { OPENAI_API_KEY: credentialSource.openAiApiKey }
          : {}),
        CODEX_PROXY_ADDR: `${args.host}:${args.port}`,
        ...(credentialSource.authPath ? { CODEX_AUTH_PATH: credentialSource.authPath } : {}),
      },
    },
  );

  forwardSignal(child, "SIGINT");
  forwardSignal(child, "SIGTERM");

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve();
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`speech TTS proxy exited with code ${code ?? "unknown"}`));
    });
  });
}

main().catch((error) => {
  console.error(`[speech-tts-proxy] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
