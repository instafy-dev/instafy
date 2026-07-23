#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ENV_FILE = ".env.deepseek";
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 20_000;
const SMOKE_PROMPT = "Respond with exactly: OK";
const SMOKE_MAX_TOKENS = 256;

function parseEnvFile(content) {
  const map = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    const value = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (key) map[key] = value;
  }
  return map;
}

function readEnvFile(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return parseEnvFile(fs.readFileSync(resolved, "utf-8"));
  } catch {
    return {};
  }
}

function readFlag(args, name) {
  return args.includes(name);
}

function readOption(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function normalizeBaseUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}

function extractOutputTextFromResponses(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.role !== "assistant") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type !== "output_text") continue;
      if (typeof part.text === "string" && part.text.trim()) {
        parts.push(part.text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function extractOutputTextFromChatCompletions(payload) {
  if (!payload || typeof payload !== "object") return "";
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0];
  const content = first?.message?.content ?? first?.delta?.content ?? first?.text ?? "";
  return typeof content === "string" ? content.trim() : "";
}

async function postJson(url, apiKey, body, timeoutMs) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available; update Node or provide a polyfill.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const snippet = text.trim().slice(0, 800);
      throw new Error(
        `${response.status} ${response.statusText}${snippet ? `: ${snippet}` : ""}`
      );
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        if (parsed.success === false && typeof parsed.msg === "string") {
          throw new Error(parsed.msg.trim() || "upstream reported success=false");
        }
        if (
          parsed.error &&
          typeof parsed.error === "object" &&
          typeof parsed.error.message === "string"
        ) {
          throw new Error(parsed.error.message.trim() || "upstream error");
        }
      }
      return parsed;
    } catch {
      throw new Error(`Expected JSON but got non-JSON response: ${text.trim().slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function tryResponses({ baseUrl, apiKey, model, timeoutMs }) {
  const urls = [`${baseUrl}/v1/responses`, `${baseUrl}/responses`];
  const bodies = [
    {
      label: "responses:string-input",
      body: { model, input: SMOKE_PROMPT, max_output_tokens: SMOKE_MAX_TOKENS, stream: false },
    },
    {
      label: "responses:message-input",
      body: {
        model,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: SMOKE_PROMPT }],
          },
        ],
        max_output_tokens: SMOKE_MAX_TOKENS,
        stream: false,
      },
    },
  ];

  let lastError = null;
  for (const url of urls) {
    for (const attempt of bodies) {
      try {
        const json = await postJson(url, apiKey, attempt.body, timeoutMs);
        const outputText = extractOutputTextFromResponses(json);
        if (!outputText) {
          throw new Error("Response JSON did not contain any output_text content.");
        }
        return { url, mode: attempt.label, json, outputText };
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError ?? new Error("responses probe failed");
}

async function tryChatCompletions({ baseUrl, apiKey, model, timeoutMs }) {
  const urls = [`${baseUrl}/v1/chat/completions`, `${baseUrl}/chat/completions`];
  const body = {
    model,
    messages: [{ role: "user", content: SMOKE_PROMPT }],
    max_tokens: SMOKE_MAX_TOKENS,
    stream: false,
  };

  let lastError = null;
  for (const url of urls) {
    try {
      const json = await postJson(url, apiKey, body, timeoutMs);
      const outputText = extractOutputTextFromChatCompletions(json);
      if (!outputText) {
        throw new Error("Chat Completions JSON did not contain any assistant text.");
      }
      return { url, mode: "chat-completions", json, outputText };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("chat completions probe failed");
}

function printUsage() {
  console.log(`DeepSeek smoke test (safe, no local file scanning)

Usage:
  node scripts/deepseek-smoke.mjs [--env-file .env.deepseek] [--base-url <url>] [--model <model>]
                                [--endpoint auto|responses|chat] [--timeout-ms 20000] [--debug]

Env (preferred):
  DEEPSEEK_API_KEY      Required (or set in --env-file)
  DEEPSEEK_BASE_URL     Optional (default: ${DEFAULT_BASE_URL})
  DEEPSEEK_MODEL        Optional (default: ${DEFAULT_MODEL})
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (readFlag(args, "-h") || readFlag(args, "--help")) {
    printUsage();
    return;
  }

  const envFile = readOption(args, "--env-file") || DEFAULT_ENV_FILE;
  const useEnvFile = !readFlag(args, "--no-env-file");
  const fileEnv = useEnvFile ? readEnvFile(envFile) : {};

  const apiKey = String(process.env.DEEPSEEK_API_KEY || fileEnv.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY. Set it in the environment or add it to .env.deepseek.");
  }

  const baseUrl = normalizeBaseUrl(
    readOption(args, "--base-url") ||
      process.env.DEEPSEEK_BASE_URL ||
      fileEnv.DEEPSEEK_BASE_URL ||
      DEFAULT_BASE_URL
  );

  const model = String(
    readOption(args, "--model") ||
      process.env.DEEPSEEK_MODEL ||
      fileEnv.DEEPSEEK_MODEL ||
      DEFAULT_MODEL
  ).trim();
  if (!model) {
    throw new Error("Missing model. Set --model or DEEPSEEK_MODEL.");
  }

  const endpointMode = String(
    readOption(args, "--endpoint") || process.env.DEEPSEEK_ENDPOINT || "auto"
  )
    .trim()
    .toLowerCase();

  const timeoutMsRaw = readOption(args, "--timeout-ms") || process.env.DEEPSEEK_TIMEOUT_MS;
  const timeoutMs = Number(timeoutMsRaw || DEFAULT_TIMEOUT_MS);
  const debug = readFlag(args, "--debug");

  if (!baseUrl) {
    throw new Error("Missing base URL. Set --base-url or DEEPSEEK_BASE_URL.");
  }

  const startedAt = Date.now();
  let result = null;

  if (endpointMode === "responses" || endpointMode === "auto") {
    try {
      result = await tryResponses({ baseUrl, apiKey, model, timeoutMs });
    } catch (error) {
      if (endpointMode === "responses") {
        throw error;
      }
      result = null;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[deepseek-smoke] /v1/responses failed; falling back to /v1/chat/completions (${message})`
      );
    }
  }

  if (!result && (endpointMode === "chat" || endpointMode === "auto")) {
    result = await tryChatCompletions({ baseUrl, apiKey, model, timeoutMs });
  }

  if (!result) {
    throw new Error("No endpoint probe succeeded.");
  }

  const elapsedMs = Date.now() - startedAt;
  const trimmed = result.outputText.trim();
  const ok = trimmed === "OK";

  console.log(`[deepseek-smoke] endpoint: ${result.url}`);
  console.log(`[deepseek-smoke] mode: ${result.mode}`);
  console.log(`[deepseek-smoke] model: ${model}`);
  console.log(`[deepseek-smoke] output: ${JSON.stringify(trimmed)}`);
  console.log(`[deepseek-smoke] status: ${ok ? "PASS" : "WARN"} (${elapsedMs}ms)`);
  if (!ok) {
    console.log(`[deepseek-smoke] expected: "OK" (exact).`);
  }

  if (debug) {
    console.log("[deepseek-smoke] raw response JSON:");
    console.log(JSON.stringify(result.json, null, 2));
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[deepseek-smoke] FAIL: ${message}`);
  process.exit(1);
});
