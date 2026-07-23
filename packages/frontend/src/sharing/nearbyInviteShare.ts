import { Capacitor } from "@capacitor/core";

export type NearbyInviteShareRole = "viewer" | "builder";

export type NearbyInviteSharePayload = {
  title: string;
  text: string;
  url: string;
  dialogTitle: string;
};

function buildShareText(role: NearbyInviteShareRole): string {
  return role === "builder"
    ? "Open this invite on a nearby device to join my Instafy space with edit access."
    : "Open this invite on a nearby device to join my Instafy space with view access.";
}

export function canUseNearbyInviteShare(): boolean {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.isPluginAvailable("Share");
  }
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export function nearbyInviteShareRequiresPreparedUrl(): boolean {
  return !Capacitor.isNativePlatform();
}

export function buildNearbyInviteSharePayload(params: {
  role: NearbyInviteShareRole;
  url: string;
}): NearbyInviteSharePayload {
  const { role, url } = params;
  return {
    title: role === "builder" ? "Edit this Instafy space" : "View this Instafy space",
    text: buildShareText(role),
    url,
    dialogTitle: "Share invite",
  };
}

function buildWebShareFallbackText(payload: NearbyInviteSharePayload): string {
  return `${payload.text}\n${payload.url}`;
}

export async function shareNearbyInvite(payload: NearbyInviteSharePayload): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Share } = await import("@capacitor/share");
    const availability = await Share.canShare();
    if (!availability.value) {
      throw new Error("Sharing isn't available on this device.");
    }
    await Share.share({
      title: payload.title,
      text: payload.text,
      url: payload.url,
      dialogTitle: payload.dialogTitle,
    });
    return;
  }

  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    throw new Error("Sharing isn't available in this browser.");
  }

  const primaryPayload = {
    title: payload.title,
    text: payload.text,
    url: payload.url,
  };
  const fallbackPayload = {
    title: payload.title,
    text: buildWebShareFallbackText(payload),
  };

  if (typeof navigator.canShare === "function") {
    if (navigator.canShare(primaryPayload)) {
      await navigator.share(primaryPayload);
      return;
    }
    if (navigator.canShare(fallbackPayload)) {
      await navigator.share(fallbackPayload);
      return;
    }
  }

  await navigator.share(primaryPayload);
}

export function isNearbyInviteShareDismissalError(error: unknown): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "").trim()
      : "";
  if (name === "AbortError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("abort") ||
    normalized.includes("cancel") ||
    normalized.includes("dismiss")
  );
}
