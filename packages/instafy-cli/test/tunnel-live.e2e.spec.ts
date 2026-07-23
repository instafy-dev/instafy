import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startTunnelSession } from "../dist/tunnel.js";

type RequestCapture = {
  method: string;
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (value && value.trim()) return value.trim();
  throw new Error(`Missing required env ${key} for live tunnel test`);
}

function cleanUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function isLocalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return raw.includes("127.0.0.1") || raw.includes("localhost");
  }
}

async function requestText(params: {
  url: URL;
  method?: string;
  hostHeader?: string;
  insecure?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  body?: string;
}): Promise<string> {
  const isHttps = params.url.protocol === "https:";
  const timeoutMs = params.timeoutMs ?? 4000;

  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(params.headers ?? {}) };
    if (params.hostHeader) {
      headers.host = params.hostHeader;
    }
    if (typeof params.body === "string" && !("content-length" in headers)) {
      headers["content-length"] = Buffer.byteLength(params.body, "utf8").toString();
    }

    const options: http.RequestOptions & https.RequestOptions = {
      protocol: params.url.protocol,
      hostname: params.url.hostname,
      port: params.url.port || (isHttps ? 443 : 80),
      method: params.method ?? "GET",
      path: `${params.url.pathname}${params.url.search}`,
      headers: Object.keys(headers).length ? headers : undefined,
    };

    if (isHttps) {
      options.servername = params.hostHeader ?? undefined;
      if (params.insecure) {
        options.rejectUnauthorized = false;
      }
    }

    const request = (isHttps ? https : http).request(
      options,
      (response) => {
        const chunks: string[] = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(chunks.join("")));
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("request timeout"));
    });
    request.on("error", reject);
    request.setTimeout(timeoutMs);
    if (typeof params.body === "string") {
      request.write(params.body);
    }
    request.end();
  });
}

async function startLocalServer(body: string): Promise<{
  port: number;
  captures: RequestCapture[];
  close: () => Promise<void>;
}> {
  return await new Promise((resolve) => {
    const captures: RequestCapture[] = [];
    const server = http.createServer((req, res) => {
      let requestBody = "";
      req.on("data", (chunk) => (requestBody += chunk.toString("utf8")));
      req.on("end", () => {
        captures.push({
          method: req.method ?? "GET",
          path: req.url ?? "",
          body: requestBody,
          headers: req.headers,
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        throw new Error("failed to bind test server");
      }
      resolve({
        port: addr.port,
        captures,
        close: () =>
          new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

async function loginWithPassword(
  supabaseUrl: string,
  supabaseAnon: string,
  email: string,
  password: string,
): Promise<string> {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: supabaseAnon,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase login failed (${response.status}): ${text}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof body["access_token"] === "string" ? (body["access_token"] as string) : null;
  if (!accessToken) {
    throw new Error("Supabase login response missing access_token");
  }
  return accessToken;
}

async function signupUser(
  supabaseUrl: string,
  supabaseAnon: string,
  email: string,
  password: string,
): Promise<string | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: {
      apikey: supabaseAnon,
      authorization: `Bearer ${supabaseAnon}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = typeof body["access_token"] === "string" ? (body["access_token"] as string) : null;
  return accessToken;
}

async function createUserViaAdmin(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
  password: string,
) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase admin create user failed (${response.status}): ${text}`);
  }
}

async function resolveUserToken(controllerUrl: string): Promise<string> {
  const direct = process.env.CONTROLLER_TOKEN;
  if (direct && direct.trim()) return direct.trim();

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseAnon = process.env.SUPABASE_ANON_KEY?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !supabaseAnon) {
    throw new Error("Missing CONTROLLER_TOKEN; set SUPABASE_URL and SUPABASE_ANON_KEY to login");
  }

  const explicitEmail = process.env.TUNNEL_TEST_EMAIL?.trim();
  const explicitPassword = process.env.TUNNEL_TEST_PASSWORD?.trim();
  if (explicitEmail && explicitPassword) {
    return await loginWithPassword(supabaseUrl, supabaseAnon, explicitEmail, explicitPassword);
  }

  if (!isLocalUrl(controllerUrl)) {
    throw new Error(
      "Missing CONTROLLER_TOKEN and no TUNNEL_TEST_EMAIL/TUNNEL_TEST_PASSWORD provided (refusing to auto-create users against non-local controller)",
    );
  }

  const email = `tunnel-live-${randomUUID()}@instafy.dev`;
  const password = `Instafy!${randomUUID()}`;

  // Try public signup first (no secrets); if that yields no session, fall back to admin create user.
  const signupToken = await signupUser(supabaseUrl, supabaseAnon, email, password);
  if (signupToken) {
    return signupToken;
  }
  if (!serviceRoleKey) {
    throw new Error(
      "Supabase signup did not return a session; set SUPABASE_SERVICE_ROLE_KEY so the test can create a confirmed user in local dev",
    );
  }
  await createUserViaAdmin(supabaseUrl, serviceRoleKey, email, password);
  return await loginWithPassword(supabaseUrl, supabaseAnon, email, password);
}

async function ensureControllerReachable(controllerUrl: string) {
  try {
    const res = await fetch(controllerUrl, { method: "GET" });
    if (res.status >= 500) {
      throw new Error(`controller unhealthy: ${res.status}`);
    }
  } catch (error) {
    throw new Error(`controller not reachable at ${controllerUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function ensureProjectId(controllerUrl: string, userToken: string): Promise<string> {
  const existing =
    process.env.SPACE_ID?.trim() || process.env.CONTROLLER_SPACE_ID?.trim();
  if (existing) return existing;

  const orgResponse = await fetch(`${cleanUrl(controllerUrl)}/orgs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${userToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ orgName: "Tunnel Workspace" }),
  });
  if (!orgResponse.ok) {
    const text = await orgResponse.text().catch(() => "");
    throw new Error(`failed to create org (${orgResponse.status}): ${text}`);
  }
  const orgPayload = (await orgResponse.json()) as Record<string, unknown>;
  const orgId =
    typeof orgPayload["orgId"] === "string"
      ? (orgPayload["orgId"] as string)
      : typeof orgPayload["org_id"] === "string"
        ? (orgPayload["org_id"] as string)
        : null;
  if (!orgId) {
    throw new Error("organization creation response missing orgId");
  }

  const response = await fetch(`${cleanUrl(controllerUrl)}/orgs/${encodeURIComponent(orgId)}/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${userToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ projectType: "customer" }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`failed to create project (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const projectId =
    typeof payload["projectId"] === "string"
      ? (payload["projectId"] as string)
      : typeof payload["project_id"] === "string"
        ? (payload["project_id"] as string)
        : null;
  if (!projectId) {
    throw new Error("project creation response missing projectId");
  }
  return projectId;
}

describe("instafy tunnel live (hetzner)", () => {
  it(
    "creates a live tunnel and forwards webhook payloads",
    async () => {
      if (process.env.TUNNEL_E2E_LIVE !== "1") {
        return;
      }

      const controllerUrl = requiredEnv("CONTROLLER_URL");
      await ensureControllerReachable(controllerUrl);
      const controllerToken = await resolveUserToken(controllerUrl);
      const projectId = await ensureProjectId(controllerUrl, controllerToken);
      const ingressIp = process.env.TUNNEL_INGRESS_IP?.trim();

      const serverBody = `live-ok-${randomUUID()}`;
      const server = await startLocalServer(serverBody);

      const session = await startTunnelSession({
        controllerUrl,
        controllerToken,
        project: projectId,
        port: server.port,
      });

      try {
        const initialUrl = new URL(session.url);
        const hostHeader = initialUrl.hostname;

        const candidates: URL[] = [initialUrl];
        if (initialUrl.protocol === "https:" && initialUrl.port === "8083") {
          const httpUrl = new URL(session.url);
          httpUrl.protocol = "http:";
          candidates.push(httpUrl);
        }

        const deadline = Date.now() + 25_000;
        let body = "";
        let lastError: Error | null = null;

        while (Date.now() < deadline) {
          for (const candidate of candidates) {
            const target = new URL(candidate.toString());
            if (ingressIp) {
              target.hostname = ingressIp;
            }
            try {
              body = await requestText({
                url: target,
                hostHeader,
                insecure: true,
                timeoutMs: 2000,
              });
              if (body.includes(serverBody)) {
                break;
              }
            } catch (error) {
              lastError = error instanceof Error ? error : new Error(String(error));
            }
          }

          if (body.includes(serverBody)) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        if (!body.includes(serverBody)) {
          throw lastError ?? new Error(`Did not receive expected body from ${session.url}`);
        }

        expect(body).toContain(serverBody);

        const webhookBody = JSON.stringify({
          kind: "tunnel.webhook.test",
          id: randomUUID(),
          receivedAt: new Date().toISOString(),
        });

        const webhookPath = "/webhook?source=instafy-cli-live";
        const webhookDeadline = Date.now() + 10_000;
        let webhookResponse = "";
        let webhookError: Error | null = null;
        while (Date.now() < webhookDeadline) {
          for (const candidate of candidates) {
            const target = new URL(candidate.toString());
            target.pathname = "/webhook";
            target.search = "?source=instafy-cli-live";
            if (ingressIp) {
              target.hostname = ingressIp;
            }
            try {
              webhookResponse = await requestText({
                url: target,
                method: "POST",
                hostHeader,
                insecure: true,
                timeoutMs: 2000,
                headers: { "content-type": "application/json" },
                body: webhookBody,
              });
              webhookError = null;
              break;
            } catch (error) {
              webhookError = error instanceof Error ? error : new Error(String(error));
            }
          }
          if (!webhookError) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const webhookCapture = server.captures.find(
          (capture) =>
            capture.method === "POST" &&
            (capture.path ?? "").startsWith(webhookPath) &&
            capture.body === webhookBody,
        );
        if (!webhookCapture) {
          throw (
            webhookError ??
            new Error(
              `webhook POST did not reach local server via ${session.url} (response=${webhookResponse.slice(0, 120)})`,
            )
          );
        }
        expect(String(webhookCapture.headers["content-type"] ?? "")).toContain(
          "application/json",
        );
      } finally {
        await session.close();
        await server.close();
      }
    },
    60_000,
  );
});
