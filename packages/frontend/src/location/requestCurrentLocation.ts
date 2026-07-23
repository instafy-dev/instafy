import { Capacitor } from "@capacitor/core";

export type LocationSharePrecision = "approximate" | "precise";

export type SharedLocationContext = {
  precision: LocationSharePrecision;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  timestampIso: string;
  source: "browser" | "native";
};

type RawCoordinates = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  timestampMs: number;
  source: "browser" | "native";
};

function clampCoordinate(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundCoordinate(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function coarsenCoordinates(
  latitude: number,
  longitude: number,
  precision: LocationSharePrecision,
): { latitude: number; longitude: number } {
  if (precision === "precise") {
    return {
      latitude: roundCoordinate(clampCoordinate(latitude, -90, 90), 6),
      longitude: roundCoordinate(clampCoordinate(longitude, -180, 180), 6),
    };
  }

  return {
    latitude: roundCoordinate(clampCoordinate(latitude, -90, 90), 3),
    longitude: roundCoordinate(clampCoordinate(longitude, -180, 180), 3),
  };
}

function formatAccuracy(accuracyMeters: number | null): string {
  if (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0) {
    return "unknown";
  }
  if (accuracyMeters >= 1000) {
    return `${(accuracyMeters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(accuracyMeters)} m`;
}

function toLocationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  if (normalized.includes("denied") || normalized.includes("not allowed") || normalized.includes("permission")) {
    return new Error("Location permission was denied.");
  }
  if (normalized.includes("timeout")) {
    return new Error("Timed out while requesting your location.");
  }
  if (normalized.includes("unavailable") || normalized.includes("disabled")) {
    return new Error("Location is currently unavailable on this device.");
  }
  return new Error(message.trim() || "Unable to determine your location right now.");
}

async function requestBrowserCoordinates(precision: LocationSharePrecision): Promise<RawCoordinates> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw new Error("Location is not available in this browser.");
  }

  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: precision === "precise",
      timeout: precision === "precise" ? 15_000 : 10_000,
      maximumAge: precision === "approximate" ? 120_000 : 0,
    });
  }).catch((error) => {
    throw toLocationError(error);
  });

  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    timestampMs: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
    source: "browser",
  };
}

async function requestNativeCoordinates(precision: LocationSharePrecision): Promise<RawCoordinates> {
  const { Geolocation } = await import("@capacitor/geolocation");
  const permissions = await Geolocation.checkPermissions().catch(() => null);
  const locationPermission =
    permissions && typeof permissions === "object" && "location" in permissions
      ? String((permissions as { location?: unknown }).location ?? "")
      : "";

  if (locationPermission !== "granted") {
    const requested = await Geolocation.requestPermissions().catch((error) => {
      throw toLocationError(error);
    });
    const requestedPermission =
      requested && typeof requested === "object" && "location" in requested
        ? String((requested as { location?: unknown }).location ?? "")
        : "";
    if (requestedPermission !== "granted") {
      throw new Error("Location permission was denied.");
    }
  }

  const position = await Geolocation.getCurrentPosition({
    enableHighAccuracy: precision === "precise",
    timeout: precision === "precise" ? 15_000 : 10_000,
    maximumAge: precision === "approximate" ? 120_000 : 0,
  }).catch((error) => {
    throw toLocationError(error);
  });

  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    timestampMs: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
    source: "native",
  };
}

export async function requestCurrentLocation(
  precision: LocationSharePrecision,
): Promise<SharedLocationContext> {
  const raw = Capacitor.isNativePlatform()
    ? await requestNativeCoordinates(precision)
    : await requestBrowserCoordinates(precision);

  const rounded = coarsenCoordinates(raw.latitude, raw.longitude, precision);
  return {
    precision,
    latitude: rounded.latitude,
    longitude: rounded.longitude,
    accuracyMeters: raw.accuracyMeters,
    timestampIso: new Date(raw.timestampMs).toISOString(),
    source: raw.source,
  };
}

export function buildSharedLocationVisibleMessage(precision: LocationSharePrecision): string {
  return precision === "precise" ? "Shared my precise location." : "Shared my approximate location.";
}

export function buildSharedLocationDispatchInput(location: SharedLocationContext): string {
  const visibleMessage = buildSharedLocationVisibleMessage(location.precision);
  const sourceLabel = location.source === "native" ? "native app" : "browser";
  return [
    visibleMessage,
    "",
    "Approved location context for the current request:",
    `- Precision: ${location.precision}`,
    `- Latitude: ${location.latitude}`,
    `- Longitude: ${location.longitude}`,
    `- Accuracy: about ${formatAccuracy(location.accuracyMeters)}`,
    `- Captured at: ${location.timestampIso}`,
    `- Source: ${sourceLabel}`,
    "Continue the current request using this location. Do not ask for location again unless you truly need a different precision.",
  ].join("\n");
}
