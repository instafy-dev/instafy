import { Capacitor, registerPlugin } from "@capacitor/core";
import { generateUUID } from "../utils/uuid";
import { createCameraProviderInstanceId } from "./cameraProviderIdentity";
import type {
  CameraCaptureMetadata,
  CameraCaptureResult,
  CameraCaptureSeriesResult,
  CameraLensId,
  CameraPermissionState,
  CameraStatusSnapshot,
} from "./types";

interface NativeCameraExtensionPlugin {
  getStatus(): Promise<CameraStatusSnapshot>;
  requestCameraPermissions(): Promise<CameraStatusSnapshot>;
  openCameraSettings(): Promise<CameraStatusSnapshot>;
  capturePhoto(options?: {
    lens?: CameraLensId;
  }): Promise<CameraCaptureResult>;
}

let nativeCameraExtensionPlugin: NativeCameraExtensionPlugin | null = null;
let nativeCameraExtensionPluginInitialized = false;

const DESKTOP_CAMERA_DEVICE_ID_STORAGE_KEY = "instafy.camera.desktopWebcam.deviceId";

type DesktopWebcamRuntimeState = {
  deviceId: string | null;
  deviceLabel: string | null;
  permission: CameraPermissionState;
  lastCapture: CameraCaptureMetadata | null;
  lastError: string | null;
  lastObjectUrl: string | null;
};

const desktopWebcamRuntimeState: DesktopWebcamRuntimeState = {
  deviceId: null,
  deviceLabel: null,
  permission: "prompt",
  lastCapture: null,
  lastError: null,
  lastObjectUrl: null,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type VirtualCameraCaptureTestOptions = {
  imageDataUrl: string;
  fileName?: string;
  width?: number;
  height?: number;
  lens?: string;
  captureDelayMs?: number;
  /**
   * How long the seam stays armed after configure(). Defaults to
   * VIRTUAL_CAMERA_TEST_DEFAULT_TTL_MS (15 minutes). Once the deadline passes,
   * the seam auto-clears and every capture entry point falls through to the
   * real camera paths, so a smoke run that dies before calling clear() cannot
   * leave the page permanently stuck on the virtual camera.
   */
  ttlMs?: number;
};

type VirtualCameraCaptureTestController = {
  configure: (options: VirtualCameraCaptureTestOptions) => Promise<boolean>;
  clear: () => Promise<boolean>;
};

type VirtualCameraCaptureTestWindow = Window & {
  __INSTAFY_CAMERA_CAPTURE_TEST__?: VirtualCameraCaptureTestController;
};

type VirtualCameraRuntimeState = {
  options: VirtualCameraCaptureTestOptions | null;
  /** Epoch ms after which the armed seam auto-clears (TTL guard). */
  armedUntilMs: number | null;
  lastCapture: CameraCaptureMetadata | null;
  lastObjectUrl: string | null;
};

const VIRTUAL_CAMERA_DEVICE_ID = "virtual-camera-test";
const VIRTUAL_CAMERA_DEVICE_LABEL = "Virtual test camera";
/** Default seam TTL: long enough for any smoke run, short enough to unstick a page. */
export const VIRTUAL_CAMERA_TEST_DEFAULT_TTL_MS = 15 * 60 * 1_000;

const virtualCameraRuntimeState: VirtualCameraRuntimeState = {
  options: null,
  armedUntilMs: null,
  lastCapture: null,
  lastObjectUrl: null,
};

function clearVirtualCameraRuntimeState() {
  virtualCameraRuntimeState.options = null;
  virtualCameraRuntimeState.armedUntilMs = null;
  revokeVirtualCameraObjectUrl(virtualCameraRuntimeState.lastObjectUrl);
  virtualCameraRuntimeState.lastObjectUrl = null;
  virtualCameraRuntimeState.lastCapture = null;
}

function isVirtualCameraCaptureConfigured() {
  if (virtualCameraRuntimeState.options === null) {
    return false;
  }
  if (
    virtualCameraRuntimeState.armedUntilMs !== null &&
    Date.now() > virtualCameraRuntimeState.armedUntilMs
  ) {
    // The TTL expired: auto-clear so a smoke that crashed before clear()
    // cannot leave the seam sticky. Captures past the deadline fall through
    // to the real camera paths.
    clearVirtualCameraRuntimeState();
    return false;
  }
  return true;
}

/**
 * True while the page-global virtual-camera test seam is armed (configured via
 * window.__INSTAFY_CAMERA_CAPTURE_TEST__ and still within its TTL). Exported so
 * higher-level capture entry points (cameraBridgeClient) can short-circuit
 * provider resolution at the lowest level, mirroring the voice seam: the
 * seam's synthetic identity never matches an attached project provider id, so
 * without the short-circuit project-scoped runs would route to remote capture
 * or be denied instead of hitting the armed virtual capture.
 */
export function isVirtualCameraCaptureTestArmed() {
  return isVirtualCameraCaptureConfigured();
}

function revokeVirtualCameraObjectUrl(url: string | null | undefined) {
  if (typeof url !== "string" || url.trim().length === 0) {
    return;
  }
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Ignore stale object-url cleanup failures.
  }
}

function resolveVirtualCameraLens(lens: string | null | undefined): CameraLensId {
  return lens === "rear" || lens === "external" || lens === "front" ? lens : "front";
}

function decodeImageDataUrlToBlob(dataUrl: string): Blob | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const metadata = dataUrl.slice("data:".length, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const metadataParts = metadata
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const mimeType = metadataParts[0] && metadataParts[0] !== "base64" ? metadataParts[0] : "";
  const isBase64 = metadataParts.includes("base64");

  try {
    const raw = isBase64 ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType || "application/octet-stream" });
  } catch {
    return null;
  }
}

async function decodeVirtualCameraImageDimensions(
  blob: Blob,
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dimensions;
  } catch {
    return null;
  }
}

function buildVirtualCameraStatus(error?: string): CameraStatusSnapshot {
  const lens = resolveVirtualCameraLens(virtualCameraRuntimeState.options?.lens);
  return {
    supported: true,
    platform: "virtual",
    backend: "virtual_camera",
    deviceId: VIRTUAL_CAMERA_DEVICE_ID,
    deviceLabel: VIRTUAL_CAMERA_DEVICE_LABEL,
    providerId: createCameraProviderInstanceId(VIRTUAL_CAMERA_DEVICE_ID),
    permission: "granted",
    permissionGranted: true,
    canCapture: true,
    availableLenses: [
      {
        id: lens,
        title: "Virtual test lens",
        available: true,
        selected: true,
      },
    ],
    selectedLens: lens,
    lastCapture: virtualCameraRuntimeState.lastCapture,
    error,
  };
}

async function captureVirtualCameraPhoto(options?: {
  lens?: CameraLensId;
}): Promise<CameraCaptureResult> {
  const testOptions = virtualCameraRuntimeState.options;
  if (!testOptions) {
    return buildUnsupportedCaptureResult("The virtual camera test seam is not configured.");
  }

  const captureDelayMs = Math.max(0, testOptions.captureDelayMs ?? 0);
  if (captureDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, captureDelayMs));
  }

  try {
    const decodedBlob = decodeImageDataUrlToBlob(testOptions.imageDataUrl);
    const blob = decodedBlob
      ? decodedBlob
      : await fetch(testOptions.imageDataUrl).then((response) => response.blob());
    const dimensions = await decodeVirtualCameraImageDimensions(blob);
    const captureId = `virtual-camera-${generateUUID()}`;
    const webPath = URL.createObjectURL(blob);
    const mimeType = blob.type || "image/png";
    const format = mimeType.includes("png") ? "png" : "jpeg";
    const capture: CameraCaptureMetadata = {
      captureId,
      backend: "virtual_camera",
      lens: options?.lens ?? resolveVirtualCameraLens(testOptions.lens),
      capturedAt: new Date().toISOString(),
      fileName: testOptions.fileName ?? `${captureId}.${format === "png" ? "png" : "jpg"}`,
      webPath,
      mimeType,
      format,
      width: testOptions.width ?? dimensions?.width ?? null,
      height: testOptions.height ?? dimensions?.height ?? null,
      sizeBytes: blob.size,
    };
    revokeVirtualCameraObjectUrl(virtualCameraRuntimeState.lastObjectUrl);
    virtualCameraRuntimeState.lastObjectUrl = webPath;
    virtualCameraRuntimeState.lastCapture = capture;
    return {
      ...buildVirtualCameraStatus(),
      capture,
      lastCapture: capture,
      cancelled: false,
    };
  } catch (error) {
    const status = buildVirtualCameraStatus(getErrorMessage(error));
    return {
      ...status,
      capture: null,
      cancelled: false,
    };
  }
}

function installVirtualCameraCaptureTestController() {
  if (typeof window === "undefined") {
    return;
  }
  const runtimeWindow = window as VirtualCameraCaptureTestWindow;
  const controller: VirtualCameraCaptureTestController = {
    configure: async (options) => {
      if (
        !options ||
        typeof options.imageDataUrl !== "string" ||
        options.imageDataUrl.trim().length === 0
      ) {
        return false;
      }
      virtualCameraRuntimeState.options = {
        imageDataUrl: options.imageDataUrl,
        fileName: options.fileName,
        width: options.width,
        height: options.height,
        lens: options.lens,
        captureDelayMs: options.captureDelayMs,
        ttlMs: options.ttlMs,
      };
      const ttlMs =
        typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs > 0
          ? options.ttlMs
          : VIRTUAL_CAMERA_TEST_DEFAULT_TTL_MS;
      virtualCameraRuntimeState.armedUntilMs = Date.now() + ttlMs;
      return true;
    },
    clear: async () => {
      clearVirtualCameraRuntimeState();
      return true;
    },
  };
  runtimeWindow.__INSTAFY_CAMERA_CAPTURE_TEST__ = controller;
}

installVirtualCameraCaptureTestController();

function isNativeMobilePlatform() {
  const platform = Capacitor.getPlatform();
  return platform === "android" || platform === "ios";
}

function isDesktopAppCameraRuntimeAvailable() {
  if (Capacitor.getPlatform() !== "web") {
    return false;
  }
  if (typeof window === "undefined" || !window.instafyDesktop) {
    return false;
  }
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

export function supportsCurrentClientNativeCameraBridge() {
  return (
    isVirtualCameraCaptureConfigured() ||
    isNativeMobilePlatform() ||
    isDesktopAppCameraRuntimeAvailable()
  );
}

function getNativeCameraExtensionPlugin(): NativeCameraExtensionPlugin | null {
  if (!isNativeMobilePlatform()) {
    return null;
  }
  if (!nativeCameraExtensionPluginInitialized) {
    nativeCameraExtensionPlugin =
      registerPlugin<NativeCameraExtensionPlugin>("InstafyCameraExtension");
    nativeCameraExtensionPluginInitialized = true;
  }
  return nativeCameraExtensionPlugin;
}

function getDesktopWebcamDeviceId() {
  if (desktopWebcamRuntimeState.deviceId) {
    return desktopWebcamRuntimeState.deviceId;
  }

  if (typeof window === "undefined") {
    desktopWebcamRuntimeState.deviceId = `desktop-webcam-${generateUUID()}`;
    return desktopWebcamRuntimeState.deviceId;
  }

  try {
    const saved = window.localStorage.getItem(DESKTOP_CAMERA_DEVICE_ID_STORAGE_KEY)?.trim() ?? "";
    if (saved.length > 0) {
      desktopWebcamRuntimeState.deviceId = saved;
      return saved;
    }
  } catch {
    // Ignore localStorage failures and fall back to an in-memory id.
  }

  const generated = `desktop-webcam-${generateUUID()}`;
  desktopWebcamRuntimeState.deviceId = generated;
  try {
    window.localStorage.setItem(DESKTOP_CAMERA_DEVICE_ID_STORAGE_KEY, generated);
  } catch {
    // Ignore persistence failures and keep the in-memory value.
  }
  return generated;
}

function setDesktopWebcamDeviceLabel(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  desktopWebcamRuntimeState.deviceLabel = normalized || "Desktop webcam";
}

function resolveDesktopWebcamDeviceLabel() {
  return desktopWebcamRuntimeState.deviceLabel?.trim() || "Desktop webcam";
}

function revokeDesktopWebcamObjectUrl(url: string | null | undefined) {
  if (typeof url !== "string" || url.trim().length === 0) {
    return;
  }
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Ignore stale object-url cleanup failures.
  }
}

function setDesktopWebcamLastCapture(capture: CameraCaptureMetadata | null) {
  revokeDesktopWebcamObjectUrl(desktopWebcamRuntimeState.lastObjectUrl);
  desktopWebcamRuntimeState.lastObjectUrl = capture?.webPath?.trim() || null;
  desktopWebcamRuntimeState.lastCapture = capture;
}

function buildDesktopWebcamStatus(error?: string): CameraStatusSnapshot {
  const deviceId = getDesktopWebcamDeviceId();
  const providerId = createCameraProviderInstanceId(deviceId);
  const permission = desktopWebcamRuntimeState.permission;
  return {
    supported: true,
    platform: "desktop",
    backend: "usb_webcam",
    deviceId,
    deviceLabel: resolveDesktopWebcamDeviceLabel(),
    providerId,
    permission,
    permissionGranted: permission === "granted",
    canCapture: permission === "granted",
    availableLenses: [
      {
        id: "external",
        title: "Desktop webcam",
        available: true,
        selected: true,
      },
    ],
    selectedLens: "external",
    lastCapture: desktopWebcamRuntimeState.lastCapture,
    error,
  };
}

function buildFallbackStatus(error?: string): CameraStatusSnapshot {
  const platform = Capacitor.getPlatform();
  return {
    supported: false,
    platform,
    backend: "phone_camera",
    deviceId: null,
    deviceLabel: null,
    providerId: null,
    permission: "denied",
    permissionGranted: false,
    canCapture: false,
    availableLenses: [],
    selectedLens: null,
    lastCapture: null,
    error,
  };
}

async function readDesktopWebcamPermission(): Promise<CameraPermissionState | null> {
  if (typeof navigator === "undefined") {
    return null;
  }
  const permissions = navigator.permissions;
  if (!permissions || typeof permissions.query !== "function") {
    return null;
  }

  try {
    const result = await permissions.query({
      name: "camera" as PermissionName,
    });
    if (result.state === "granted") {
      return "granted";
    }
    if (result.state === "denied") {
      return "denied";
    }
    return "prompt";
  } catch {
    return null;
  }
}

async function getDesktopWebcamStatus(): Promise<CameraStatusSnapshot> {
  const permission = await readDesktopWebcamPermission();
  if (permission) {
    desktopWebcamRuntimeState.permission = permission;
  }
  return buildDesktopWebcamStatus(desktopWebcamRuntimeState.lastError ?? undefined);
}

function classifyDesktopWebcamError(error: unknown): {
  permission: CameraPermissionState;
  message: string;
} {
  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("notallowederror") ||
    normalized.includes("permission") ||
    normalized.includes("denied")
  ) {
    return {
      permission: "denied",
      message,
    };
  }
  return {
    permission: desktopWebcamRuntimeState.permission,
    message,
  };
}

function stopDesktopWebcamStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

async function waitForDesktopWebcamVideo(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error("Timed out waiting for the desktop webcam preview."));
    }, 4_000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };

    const onReady = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onError = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error("Unable to start the desktop webcam preview."));
    };

    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function withDesktopWebcamStream<TValue>(
  callback: (stream: MediaStream) => Promise<TValue>,
): Promise<TValue> {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") {
    throw new Error("Desktop webcam capture is unavailable on this client.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false,
  });

  try {
    const track = stream.getVideoTracks()[0] ?? null;
    if (track) {
      setDesktopWebcamDeviceLabel(track.label || resolveDesktopWebcamDeviceLabel());
    }
    desktopWebcamRuntimeState.permission = "granted";
    desktopWebcamRuntimeState.lastError = null;
    return await callback(stream);
  } catch (error) {
    const classified = classifyDesktopWebcamError(error);
    desktopWebcamRuntimeState.permission = classified.permission;
    desktopWebcamRuntimeState.lastError = classified.message;
    throw error;
  } finally {
    stopDesktopWebcamStream(stream);
  }
}

async function requestDesktopWebcamPermissions(): Promise<CameraStatusSnapshot> {
  try {
    await withDesktopWebcamStream(async () => undefined);
    desktopWebcamRuntimeState.lastError = null;
    return buildDesktopWebcamStatus();
  } catch (error) {
    const classified = classifyDesktopWebcamError(error);
    desktopWebcamRuntimeState.permission = classified.permission;
    desktopWebcamRuntimeState.lastError = classified.message;
    return buildDesktopWebcamStatus(classified.message);
  }
}

async function openDesktopWebcamSettings(): Promise<CameraStatusSnapshot> {
  const status = await getDesktopWebcamStatus();
  return {
    ...status,
    error:
      status.error ??
      "Use the operating-system or site camera settings from Instafy Desktop to change webcam access.",
  };
}

async function blobFromCanvas(canvas: HTMLCanvasElement) {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error("Unable to encode the desktop webcam capture."));
      },
      "image/jpeg",
      0.92,
    );
  });
}

async function captureDesktopWebcamPhoto(options?: {
  lens?: CameraLensId;
}): Promise<CameraCaptureResult> {
  const requestedLens = options?.lens ?? "external";

  try {
    const capture = await withDesktopWebcamStream(async (stream) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;

      try {
        await video.play().catch(() => undefined);
        await waitForDesktopWebcamVideo(video);

        const width = Math.max(1, Math.round(video.videoWidth || 1280));
        const height = Math.max(1, Math.round(video.videoHeight || 720));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Unable to create a desktop webcam capture canvas.");
        }
        context.drawImage(video, 0, 0, width, height);

        const blob = await blobFromCanvas(canvas);
        const captureId = `desktop-webcam-${generateUUID()}`;
        const webPath = URL.createObjectURL(blob);
        const captureMetadata: CameraCaptureMetadata = {
          captureId,
          backend: "usb_webcam",
          lens: requestedLens === "front" ? "front" : "external",
          capturedAt: new Date().toISOString(),
          fileName: `${captureId}.jpg`,
          webPath,
          mimeType: "image/jpeg",
          format: "jpeg",
          width,
          height,
          sizeBytes: blob.size,
        };
        setDesktopWebcamLastCapture(captureMetadata);
        desktopWebcamRuntimeState.lastError = null;
        return captureMetadata;
      } finally {
        video.pause();
        video.srcObject = null;
      }
    });

    return {
      ...buildDesktopWebcamStatus(),
      capture,
      lastCapture: capture,
      cancelled: false,
    };
  } catch (error) {
    const classified = classifyDesktopWebcamError(error);
    desktopWebcamRuntimeState.permission = classified.permission;
    desktopWebcamRuntimeState.lastError = classified.message;
    const status = buildDesktopWebcamStatus(classified.message);
    return {
      ...status,
      capture: status.lastCapture ?? null,
      cancelled: false,
    };
  }
}

async function buildCurrentStatusWithError(error: unknown): Promise<CameraStatusSnapshot> {
  const plugin = getNativeCameraExtensionPlugin();
  const message = getErrorMessage(error);
  if (!plugin) {
    return buildFallbackStatus(message);
  }
  try {
    const status = await plugin.getStatus();
    return {
      ...status,
      error: message,
    };
  } catch {
    if (isDesktopAppCameraRuntimeAvailable()) {
      desktopWebcamRuntimeState.lastError = message;
      return getDesktopWebcamStatus();
    }
    return buildFallbackStatus(message);
  }
}

async function buildCurrentCaptureWithError(error: unknown): Promise<CameraCaptureResult> {
  const status = await buildCurrentStatusWithError(error);
  return {
    ...status,
    capture: status.lastCapture ?? null,
    cancelled: false,
  };
}

function buildUnsupportedCaptureResult(error?: string): CameraCaptureResult {
  return {
    ...buildFallbackStatus(error),
    capture: null,
    cancelled: false,
  };
}

function normalizeCaptureSeriesCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(5, Math.round(value)));
}

export async function getNativeCameraStatus(): Promise<CameraStatusSnapshot> {
  if (isVirtualCameraCaptureConfigured()) {
    return buildVirtualCameraStatus();
  }
  const plugin = getNativeCameraExtensionPlugin();
  if (plugin) {
    try {
      return await plugin.getStatus();
    } catch (error) {
      return buildFallbackStatus(getErrorMessage(error));
    }
  }
  if (isDesktopAppCameraRuntimeAvailable()) {
    return getDesktopWebcamStatus();
  }
  return buildFallbackStatus(
    "Real camera capture is available on native mobile builds and in the Instafy desktop app.",
  );
}

export async function requestNativeCameraPermissions(): Promise<CameraStatusSnapshot> {
  if (isVirtualCameraCaptureConfigured()) {
    return buildVirtualCameraStatus();
  }
  const plugin = getNativeCameraExtensionPlugin();
  if (plugin) {
    try {
      return await plugin.requestCameraPermissions();
    } catch (error) {
      return buildCurrentStatusWithError(error);
    }
  }
  if (isDesktopAppCameraRuntimeAvailable()) {
    return requestDesktopWebcamPermissions();
  }
  return buildFallbackStatus(
    "Real camera capture is available on native mobile builds and in the Instafy desktop app.",
  );
}

export async function openNativeCameraSettings(): Promise<CameraStatusSnapshot> {
  if (isVirtualCameraCaptureConfigured()) {
    return buildVirtualCameraStatus();
  }
  const plugin = getNativeCameraExtensionPlugin();
  if (plugin) {
    try {
      return await plugin.openCameraSettings();
    } catch (error) {
      return buildCurrentStatusWithError(error);
    }
  }
  if (isDesktopAppCameraRuntimeAvailable()) {
    return openDesktopWebcamSettings();
  }
  return buildFallbackStatus(
    "Real camera capture is available on native mobile builds and in the Instafy desktop app.",
  );
}

export async function captureNativeCameraPhoto(options?: {
  lens?: CameraLensId;
}): Promise<CameraCaptureResult> {
  if (isVirtualCameraCaptureConfigured()) {
    return captureVirtualCameraPhoto(options);
  }
  const plugin = getNativeCameraExtensionPlugin();
  if (plugin) {
    try {
      return await plugin.capturePhoto(options);
    } catch (error) {
      return buildCurrentCaptureWithError(error);
    }
  }
  if (isDesktopAppCameraRuntimeAvailable()) {
    return captureDesktopWebcamPhoto(options);
  }
  return buildUnsupportedCaptureResult(
    "Real camera capture is available on native mobile builds and in the Instafy desktop app.",
  );
}

export async function captureNativeCameraPhotoSeries(options?: {
  lens?: CameraLensId;
  count?: number;
}): Promise<CameraCaptureSeriesResult> {
  const requestedCount = normalizeCaptureSeriesCount(options?.count);
  const captures: NonNullable<CameraCaptureSeriesResult["captures"]> = [];

  let latestStatus = await getNativeCameraStatus();
  if (!latestStatus.supported) {
    return {
      ...latestStatus,
      requestedCount,
      completedCount: 0,
      cancelled: false,
      captures,
    };
  }

  for (let index = 0; index < requestedCount; index += 1) {
    const result = await captureNativeCameraPhoto({
      lens: options?.lens,
    });
    latestStatus = result;
    if (result.capture) {
      captures.push({
        ...result.capture,
        seriesIndex: index,
      });
    }
    if (result.cancelled || result.error) {
      return {
        ...result,
        requestedCount,
        completedCount: captures.length,
        cancelled: result.cancelled ?? false,
        captures,
      };
    }
  }

  return {
    ...latestStatus,
    requestedCount,
    completedCount: captures.length,
    cancelled: false,
    captures,
  };
}
