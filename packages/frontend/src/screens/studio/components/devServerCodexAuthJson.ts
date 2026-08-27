import { controllerClient } from "../../../sdk/instafy";
import {
  canUseDesktopCodexAuthJson,
  type DesktopCodexCredentialConnectResult,
} from "./desktopCodexAuthJson";

/**
 * Dev-server twin of the desktop "use this machine's Codex login" bridge. The
 * vite dev server exposes the sanitized ~/.codex/auth.json at a loopback-only
 * endpoint (see devCodexAuthJsonPlugin in vite.config.ts) that only exists
 * when INSTAFY_DEV_CODEX_SEED=1 is set — the build-time flag below mirrors that
 * so the button never renders when the endpoint cannot answer. This module
 * only READS the file; the credential is onboarded through the controller SDK
 * (createCodex), so the fixed-token/custom-base pairing, error surfacing, and
 * token refresh all match every other connect path. To avoid piling up a new
 * credential row on every refresh-and-reseed, prior dev-seed credentials are
 * revoked after the fresh one becomes the default.
 */

const DEV_ENDPOINT = "/__instafy-dev/codex-auth-json";
export const DEV_SEED_CREDENTIAL_LABEL = "Local Codex login (dev)";

const { createCodex, list: listCredentials, revoke: revokeCredential } =
  controllerClient.credentials;

export function canUseDevServerCodexAuthJson(): boolean {
  return (
    import.meta.env.DEV === true &&
    import.meta.env.INSTAFY_DEV_CODEX_SEED_ENABLED === true &&
    typeof window !== "undefined" &&
    !canUseDesktopCodexAuthJson()
  );
}

async function fetchDevServerAuthJson(): Promise<
  { ok: true; authJson: Record<string, unknown> } | { ok: false; error: string }
> {
  let response: Response;
  try {
    response = await fetch(DEV_ENDPOINT, { headers: { accept: "application/json" } });
  } catch {
    return { ok: false, error: "The dev-server Codex login endpoint is unavailable." };
  }
  if (!response.ok) {
    return {
      ok: false,
      error:
        response.status === 404
          ? "No usable ~/.codex/auth.json, or dev seeding is off (set INSTAFY_DEV_CODEX_SEED=1)."
          : `The dev server refused the local Codex login (${response.status}).`,
    };
  }
  let payload: { authJson?: unknown } | null;
  try {
    payload = (await response.json()) as { authJson?: unknown } | null;
  } catch {
    return { ok: false, error: "The dev server returned an unreadable response." };
  }
  const authJson = payload?.authJson;
  if (!authJson || typeof authJson !== "object") {
    return { ok: false, error: "The dev server returned no usable Codex login." };
  }
  return { ok: true, authJson: authJson as Record<string, unknown> };
}

export async function connectDevServerCodexAuthJson(): Promise<DesktopCodexCredentialConnectResult> {
  const fetched = await fetchDevServerAuthJson();
  if (!fetched.ok) {
    return { success: false, error: fetched.error };
  }

  // Record which existing dev-seed credentials to retire once the fresh login
  // is in place — captured BEFORE create so we never revoke the new one.
  let stale: string[] = [];
  const existing = await listCredentials().catch(() => null);
  if (existing?.success) {
    stale = existing.credentials
      .filter(
        (credential) =>
          !credential.revokedAt &&
          credential.kind === "codex_auth_json" &&
          credential.label === DEV_SEED_CREDENTIAL_LABEL &&
          typeof credential.id === "string" &&
          credential.id.trim().length > 0,
      )
      .map((credential) => credential.id);
  }

  const created = await createCodex({
    authJson: fetched.authJson,
    label: DEV_SEED_CREDENTIAL_LABEL,
    makeDefault: true,
  });
  if (!created.success) {
    return { success: false, error: created.error ?? "Unable to save credentials." };
  }
  const credentialId =
    typeof created.credentialId === "string" && created.credentialId.trim().length > 0
      ? created.credentialId
      : null;
  if (!credentialId) {
    return { success: false, error: "The controller did not confirm the credential." };
  }

  // The fresh credential is now default; retire the superseded ones so a
  // reseed-after-refresh does not accumulate rows.
  await Promise.all(
    stale
      .filter((id) => id !== credentialId)
      .map((id) => revokeCredential(id).catch(() => null)),
  );

  return {
    success: true,
    credentialId,
    kind: "codex_auth_json",
    isDefault: created.isDefault === true,
  };
}
