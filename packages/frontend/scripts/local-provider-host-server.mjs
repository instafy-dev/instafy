#!/usr/bin/env node

import http from "node:http";
import { normalizeProviderInitializationContext } from "@instafy/provider-client";
import { createProviderSummary } from "@instafy/provider-contract";

export const DEFAULT_LOCAL_PROVIDER_ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "https://prod.instafy.dev",
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function normalizeAllowedOrigins(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("local provider allowedOrigins must be an array");
  }
  return new Set(
    values.map((value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(
          "local provider allowedOrigins entries must be non-empty strings",
        );
      }
      const normalized = value.trim();
      let url;
      try {
        url = new URL(normalized);
      } catch {
        throw new Error(`invalid local provider allowed origin: ${normalized}`);
      }
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.origin !== normalized
      ) {
        throw new Error(
          `local provider allowed origin must be an exact HTTP(S) origin: ${normalized}`,
        );
      }
      return normalized;
    }),
  );
}

function applyApprovedCorsHeaders(request, response, allowedOrigins) {
  const origin =
    typeof request.headers.origin === "string"
      ? request.headers.origin.trim()
      : "";
  if (!origin) {
    return true;
  }
  if (!allowedOrigins.has(origin)) {
    return false;
  }
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-private-network", "true");
  response.setHeader("vary", "Origin");
  return true;
}

function parseRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function parseProviderScopedPath(pathname) {
  if (!pathname.startsWith("/providers/")) {
    return null;
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const providerId = segments[1] ?? "";
  if (!providerId) {
    return null;
  }
  return {
    providerId,
    segments: segments.slice(2),
  };
}

function getProviderRegistration(providers, providerId) {
  return providers.find((provider) => provider.id === providerId) ?? null;
}

function withProviderId(providerId, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    providerId:
      typeof payload.providerId === "string" && payload.providerId.trim().length > 0
        ? payload.providerId
        : providerId,
  };
}

async function resolveProviderSummary(provider) {
  if (typeof provider.getSummary !== "function") {
    return createProviderSummary(provider.summary);
  }

  try {
    return createProviderSummary(await provider.getSummary());
  } catch (error) {
    return createProviderSummary({
      ...provider.summary,
      discoverable: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function listProviderSummaries(providers) {
  const summaries = await Promise.all(providers.map((provider) => resolveProviderSummary(provider)));
  return summaries.filter(Boolean);
}

export function startLocalProviderHost({
  providers,
  defaultProviderId = null,
  host,
  port,
  serviceName = "local-provider-host",
  getHealthDetails,
  allowedOrigins = DEFAULT_LOCAL_PROVIDER_ALLOWED_ORIGINS,
}) {
  const approvedOrigins = normalizeAllowedOrigins(allowedOrigins);
  const server = http.createServer(async (request, response) => {
    if (!request.url) {
      sendJson(response, 400, { ok: false, error: "missing request url" });
      return;
    }

    const url = new URL(request.url, `http://${host}:${port}`);
    if (!applyApprovedCorsHeaders(request, response, approvedOrigins)) {
      sendJson(response, 403, {
        ok: false,
        error: "request origin is not allowed",
      });
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const summaries = await listProviderSummaries(providers);
      const extra = (await getHealthDetails?.()) ?? {};
      sendJson(response, 200, {
        ok: true,
        service: serviceName,
        host,
        port,
        defaultProviderId,
        providers: summaries,
        ...extra,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/providers") {
      const summaries = await listProviderSummaries(providers);
      sendJson(response, 200, {
        ok: true,
        providers: summaries,
      });
      return;
    }

    const providerScopedPath = parseProviderScopedPath(url.pathname);
    if (providerScopedPath) {
      const provider = getProviderRegistration(providers, providerScopedPath.providerId);
      if (!provider) {
        sendJson(response, 404, {
          ok: false,
          error: `unknown provider: ${providerScopedPath.providerId}`,
        });
        return;
      }

      if (
        request.method === "GET" &&
        providerScopedPath.segments.length === 1 &&
        providerScopedPath.segments[0] === "discover"
      ) {
        const result = await provider.discover();
        sendJson(response, result.ok === false ? result.statusCode ?? 502 : result.statusCode ?? 200, withProviderId(provider.id, result));
        return;
      }

      if (
        request.method === "POST" &&
        providerScopedPath.segments.length === 2 &&
        providerScopedPath.segments[0] === "resources" &&
        providerScopedPath.segments[1] === "read"
      ) {
        try {
          const body = await parseRequestBody(request);
          if (typeof body.uri !== "string" || body.uri.trim().length === 0) {
            sendJson(response, 400, { ok: false, error: "uri is required" });
            return;
          }

          const result = await provider.readResource(body.uri, {
            initialization: normalizeProviderInitializationContext(body.initialization),
          });
          sendJson(response, result.ok === false ? result.statusCode ?? 502 : result.statusCode ?? 200, withProviderId(provider.id, result));
        } catch (error) {
          sendJson(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (
        request.method === "POST" &&
        providerScopedPath.segments.length === 2 &&
        providerScopedPath.segments[0] === "tools" &&
        providerScopedPath.segments[1] === "call"
      ) {
        try {
          const body = await parseRequestBody(request);
          if (typeof body.name !== "string" || body.name.trim().length === 0) {
            sendJson(response, 400, { ok: false, error: "name is required" });
            return;
          }

          const result = await provider.callTool(
            body.name,
            body.arguments && typeof body.arguments === "object" ? body.arguments : {},
            {
              initialization: normalizeProviderInitializationContext(body.initialization),
            },
          );
          sendJson(response, result.ok === false ? result.statusCode ?? 502 : result.statusCode ?? 200, withProviderId(provider.id, result));
        } catch (error) {
          sendJson(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (
        request.method === "POST" &&
        providerScopedPath.segments.length === 2 &&
        providerScopedPath.segments[0] === "transport" &&
        providerScopedPath.segments[1] === "probe"
      ) {
        if (typeof provider.transportProbe !== "function") {
          sendJson(response, 404, {
            ok: false,
            error: `provider ${provider.id} does not support transport probing`,
          });
          return;
        }

        try {
          const body = await parseRequestBody(request);
          const result = await provider.transportProbe(body);
          sendJson(response, result.ok === false ? result.statusCode ?? 502 : result.statusCode ?? 200, withProviderId(provider.id, result));
        } catch (error) {
          sendJson(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    }

    const defaultProvider =
      typeof defaultProviderId === "string" && defaultProviderId.trim().length > 0
        ? getProviderRegistration(providers, defaultProviderId)
        : null;
    if (defaultProvider) {
      if (request.method === "GET" && url.pathname === "/provider/discover") {
        const result = await defaultProvider.discover();
        sendJson(response, result.ok === false ? result.statusCode ?? 502 : result.statusCode ?? 200, withProviderId(defaultProvider.id, result));
        return;
      }

      if (request.method === "POST" && url.pathname === "/provider/resources/read") {
        try {
          const body = await parseRequestBody(request);
          if (typeof body.uri !== "string" || body.uri.trim().length === 0) {
            sendJson(response, 400, { ok: false, error: "uri is required" });
            return;
          }

          const result = await defaultProvider.readResource(body.uri, {
            initialization: normalizeProviderInitializationContext(body.initialization),
          });
          sendJson(response, result.ok === false ? result.statusCode ?? 502 : result.statusCode ?? 200, withProviderId(defaultProvider.id, result));
        } catch (error) {
          sendJson(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/provider/tools/call") {
        try {
          const body = await parseRequestBody(request);
          if (typeof body.name !== "string" || body.name.trim().length === 0) {
            sendJson(response, 400, { ok: false, error: "name is required" });
            return;
          }

          const result = await defaultProvider.callTool(
            body.name,
            body.arguments && typeof body.arguments === "object" ? body.arguments : {},
            {
              initialization: normalizeProviderInitializationContext(body.initialization),
            },
          );
          sendJson(response, result.ok === false ? result.statusCode ?? 502 : result.statusCode ?? 200, withProviderId(defaultProvider.id, result));
        } catch (error) {
          sendJson(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    }

    sendJson(response, 404, { ok: false, error: "not found" });
  });

  server.listen(port, host, () => {
    console.log(`${serviceName} listening on http://${host}:${port}`);
  });

  return server;
}
