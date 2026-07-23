function decodeJwtPayload(token: string) {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(decoded);
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function supportsSpeechTunnelStatusUpdates(token: string, projectId: string) {
  const trimmedToken = token.trim();
  const trimmedProjectId = projectId.trim();
  if (!trimmedToken || !trimmedProjectId) {
    return false;
  }

  const payload = decodeJwtPayload(trimmedToken);
  if (!payload) {
    // Opaque tokens may still be controller internal or service-role credentials.
    return true;
  }

  const role = typeof payload.role === "string" ? payload.role.trim() : "";
  if (role === "service_role" || role === "supabase_admin") {
    return true;
  }

  const tokenProjectId =
    typeof payload.project_id === "string" ? payload.project_id.trim() : "";
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((value): value is string => typeof value === "string")
    : [];

  return tokenProjectId === trimmedProjectId && scopes.length > 0;
}
