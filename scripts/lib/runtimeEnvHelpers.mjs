import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SERVICE_RUNTIME_EMAIL = "service-runtime@instafy.dev";
export const DEFAULT_SUPABASE_PROJECT_URL = "http://127.0.0.1:54321";

const WAIT_BETWEEN_REQUESTS_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function setEnvFileValue(filePath, key, value) {
  if (!value) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      content = "";
    }
    const lines = content ? content.split(/\r?\n/) : [];
    const prefix = `${key}=`;
    let replaced = false;
    let changed = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].startsWith(prefix)) {
        const updated = `${prefix}${value}`;
        if (lines[index] !== updated) {
          lines[index] = updated;
          changed = true;
        }
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      lines.push(`${prefix}${value}`);
      changed = true;
    }
    const next = lines.filter((line, idx) => line || idx === lines.length - 1);
    const nextContent = `${next.join("\n").replace(/\n+$/, "\n")}\n`;
    const normalizedOriginal = content
      ? `${content.replace(/\r\n/g, "\n").replace(/\n+$/, "\n")}\n`
      : "";
    if (!changed && nextContent === normalizedOriginal) {
      return;
    }
    fs.writeFileSync(filePath, nextContent, { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
    }
  } catch (error) {
    console.warn(
      `[runtime-dev] Unable to set ${key} in ${filePath}: ${error.message}`
    );
  }
}

export async function ensureServiceRuntimeUserId(supabaseEnv = {}) {
  const supabaseUrlRaw =
    process.env.SUPABASE_PROJECT_URL ||
    process.env.SUPABASE_URL ||
    supabaseEnv.SUPABASE_PROJECT_URL ||
    supabaseEnv.SUPABASE_URL ||
    DEFAULT_SUPABASE_PROJECT_URL;
  const supabaseUrl = supabaseUrlRaw ? supabaseUrlRaw.trim().replace(/\/$/, "") : "";
  if (!supabaseUrl) {
    console.warn(
      "[runtime-dev] Skipping service runtime user setup: SUPABASE_PROJECT_URL is not available."
    );
    return null;
  }

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    supabaseEnv.SERVICE_ROLE_KEY ||
    "";
  if (!serviceRoleKey) {
    console.warn(
      "[runtime-dev] Skipping service runtime user setup: SUPABASE_SERVICE_ROLE_KEY is not configured."
    );
    return null;
  }

  const serviceEmail =
    (process.env.SERVICE_RUNTIME_USER_EMAIL || DEFAULT_SERVICE_RUNTIME_EMAIL)
      .trim()
      .toLowerCase();
  if (!serviceEmail) {
    console.warn(
      "[runtime-dev] Skipping service runtime user setup: SERVICE_RUNTIME_USER_EMAIL is empty."
    );
    return null;
  }

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available; update Node or provide a polyfill.");
  }

  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  };

  const parseUserResponse = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    if (Array.isArray(payload.users) && payload.users.length > 0) {
      return payload.users[0];
    }
    if (Array.isArray(payload) && payload.length > 0) {
      return payload[0];
    }
    if (payload.id) {
      return payload;
    }
    return null;
  };

  const queryUrl = `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(
    serviceEmail
  )}`;

  const fetchExistingUser = async (maxAttempts = 8) => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetch(queryUrl, { headers });
        if (response.ok) {
          const payload = await response.json();
          const record = parseUserResponse(payload);
          if (record) {
            return record;
          }
          // If the query succeeded but no user exists, stop retrying so we can
          // create the service runtime user immediately.
          return null;
        } else {
          const body = await response.text().catch(() => "");
          console.warn(
            `[runtime-dev] Unable to query service runtime user (attempt ${
              attempt + 1
            }): ${response.status} ${response.statusText} ${body}`
          );
        }
      } catch (error) {
        console.warn(
          `[runtime-dev] Error requesting service runtime user (attempt ${
            attempt + 1
          }): ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await sleep(WAIT_BETWEEN_REQUESTS_MS);
    }
    return null;
  };

  let userRecord = await fetchExistingUser();

  let created = false;
  if (!userRecord) {
    const createPayload = {
      email: serviceEmail,
      password: process.env.SERVICE_RUNTIME_USER_PASSWORD || "TempPass123!",
      email_confirm: true,
    };
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers,
        body: JSON.stringify(createPayload),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status === 422 && body.includes("email_exists")) {
          console.log(
            "[runtime-dev] Service runtime user already exists; re-querying."
          );
          userRecord = await fetchExistingUser(6);
          created = false;
        } else {
          console.warn(
            `[runtime-dev] Failed to create service runtime user: ${response.status} ${response.statusText} ${body}`
          );
          return null;
        }
      } else {
        const payload = await response.json();
        userRecord = parseUserResponse(payload);
        created = true;
      }
    } catch (error) {
      console.warn(
        `[runtime-dev] Error creating service runtime user: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  if (!userRecord?.id) {
    console.warn("[runtime-dev] Unable to resolve service runtime user id.");
    return null;
  }

  if (created) {
    console.log(
      `[runtime-dev] Created service runtime user ${serviceEmail} (${userRecord.id}).`
    );
  } else {
    console.log(
      `[runtime-dev] Found service runtime user ${serviceEmail} (${userRecord.id}).`
    );
  }

  return { id: userRecord.id, email: serviceEmail };
}
