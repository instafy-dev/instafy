import { supabase } from "../../../lib/supabaseClient";
import { controllerBaseUrl } from "../../../sdk/instafy";
import {
  canUseDesktopCodexAuthJson,
  type DesktopCodexCredentialConnectResult,
} from "./desktopCodexAuthJson";

/**
 * Dev-server twin of the desktop "use this machine's Codex login" bridge.
 * The vite dev server exposes the sanitized ~/.codex/auth.json at a
 * same-origin-only endpoint (see devCodexAuthJsonPlugin in vite.config.ts);
 * this module onboards it into the controller for the signed-in user, exactly
 * like the Playwright harness does. Local development only: the endpoint does
 * not exist in builds, so the affordance disappears outside `pnpm dev`.
 */

const DEV_ENDPOINT = "/__instafy-dev/codex-auth-json";
export const DEV_SEED_CREDENTIAL_LABEL = "Local Codex login (dev seed)";

export function canUseDevServerCodexAuthJson(): boolean {
  return (
    import.meta.env.DEV === true &&
    typeof window !== "undefined" &&
    !canUseDesktopCodexAuthJson()
  );
}

export async function connectDevServerCodexAuthJson(
  options: { label?: string; makeDefault?: boolean } = {},
): Promise<DesktopCodexCredentialConnectResult> {
  let accessToken: string | null = null;
  try {
    const result = await supabase.auth.getSession();
    accessToken = result.data.session?.access_token ?? null;
  } catch {
    accessToken = null;
  }
  if (!accessToken || !controllerBaseUrl) {
    return { success: false, error: "Sign in to connect your local Codex login." };
  }

  let authJson: unknown = null;
  try {
    const response = await fetch(DEV_ENDPOINT, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        success: false,
        error:
          response.status === 404
            ? "No usable ~/.codex/auth.json on this machine. Run `codex login` first."
            : `The dev server refused the local Codex login (${response.status}).`,
      };
    }
    const payload = (await response.json()) as { authJson?: unknown } | null;
    authJson = payload?.authJson ?? null;
  } catch {
    return {
      success: false,
      error: "The dev-server Codex login endpoint is unavailable.",
    };
  }
  if (!authJson || typeof authJson !== "object") {
    return { success: false, error: "The dev server returned no usable Codex login." };
  }

  let created: Response;
  try {
    created = await fetch(`${controllerBaseUrl}/me/credentials/codex`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        authJson,
        label: options.label ?? DEV_SEED_CREDENTIAL_LABEL,
        makeDefault: options.makeDefault ?? true,
      }),
    });
  } catch {
    return { success: false, error: "Unable to reach the controller." };
  }
  if (!created.ok) {
    return {
      success: false,
      error: `Controller rejected the credential (${created.status}).`,
    };
  }
  const payload = (await created.json().catch(() => null)) as {
    credentialId?: unknown;
    isDefault?: unknown;
  } | null;
  const credentialId =
    typeof payload?.credentialId === "string" && payload.credentialId.trim().length > 0
      ? payload.credentialId.trim()
      : null;
  if (!credentialId) {
    return { success: false, error: "Controller did not confirm the credential." };
  }
  return {
    success: true,
    credentialId,
    kind: "codex_auth_json",
    isDefault: payload?.isDefault === true,
  };
}
