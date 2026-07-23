export const CDP_SCREENCAST_MIN_WIDTH = 240;
export const CDP_SCREENCAST_MAX_WIDTH = 3840;
export const CDP_SCREENCAST_MIN_HEIGHT = 160;
export const CDP_SCREENCAST_MAX_HEIGHT = 2160;
export const CDP_SCREENCAST_MIN_DPR = 0.5;
export const CDP_SCREENCAST_MAX_DPR = 3;
export const CDP_SCREENCAST_MAX_DEVICE_PIXELS = 8_294_400;
export const CDP_SCREENCAST_MAX_FRAME_DATA_BYTES = 16 * 1024 * 1024;
export const CDP_SCREENCAST_MAX_TEXT_BYTES = 8 * 1024;

export type CdpScreencastViewport = {
  width: number;
  height: number;
  dpr: number;
  deviceWidth: number;
  deviceHeight: number;
};

export type CdpScreencastFrame = {
  type: "frame";
  frameId: number;
  data: string;
  metadata: Record<string, unknown>;
};

export type CdpScreencastReady = CdpScreencastViewport &
  (
    | { type: "ready"; pageId?: string }
    | { type: "viewport"; pageId?: string }
  );

export type CdpScreencastServerError = {
  type: "error";
  message: string;
  fatal: boolean;
};

export type CdpScreencastServerMessage =
  | CdpScreencastFrame
  | CdpScreencastReady
  | CdpScreencastServerError;

export type CdpScreencastMouseButton =
  | "none"
  | "left"
  | "middle"
  | "right"
  | "back"
  | "forward";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function normalizeCdpScreencastViewport(params: {
  width: number;
  height: number;
  dpr: number;
}): CdpScreencastViewport {
  const width = Math.round(
    clamp(
      Number.isFinite(params.width) ? params.width : 1280,
      CDP_SCREENCAST_MIN_WIDTH,
      CDP_SCREENCAST_MAX_WIDTH,
    ),
  );
  const height = Math.round(
    clamp(
      Number.isFinite(params.height) ? params.height : 720,
      CDP_SCREENCAST_MIN_HEIGHT,
      CDP_SCREENCAST_MAX_HEIGHT,
    ),
  );
  const requestedDpr = clamp(
    Number.isFinite(params.dpr) ? params.dpr : 1,
    CDP_SCREENCAST_MIN_DPR,
    CDP_SCREENCAST_MAX_DPR,
  );
  const pixelCappedDpr = Math.sqrt(
    CDP_SCREENCAST_MAX_DEVICE_PIXELS / (width * height),
  );
  const dpr = Math.round(
    Math.max(CDP_SCREENCAST_MIN_DPR, Math.min(requestedDpr, pixelCappedDpr)) * 1000,
  ) / 1000;
  return {
    width,
    height,
    dpr,
    deviceWidth: Math.round(width * dpr),
    deviceHeight: Math.round(height * dpr),
  };
}

function mapViewportMessage(
  record: Record<string, unknown>,
  type: "ready" | "viewport",
): CdpScreencastReady | null {
  const width = safeInteger(record.width);
  const height = safeInteger(record.height);
  const dpr = finiteNumber(record.dpr);
  const deviceWidth = safeInteger(record.deviceWidth);
  const deviceHeight = safeInteger(record.deviceHeight);
  if (
    width === null ||
    height === null ||
    dpr === null ||
    deviceWidth === null ||
    deviceHeight === null ||
    width < CDP_SCREENCAST_MIN_WIDTH ||
    width > CDP_SCREENCAST_MAX_WIDTH ||
    height < CDP_SCREENCAST_MIN_HEIGHT ||
    height > CDP_SCREENCAST_MAX_HEIGHT ||
    dpr < CDP_SCREENCAST_MIN_DPR ||
    dpr > CDP_SCREENCAST_MAX_DPR ||
    deviceWidth <= 0 ||
    deviceHeight <= 0 ||
    deviceWidth * deviceHeight > CDP_SCREENCAST_MAX_DEVICE_PIXELS + 8192
  ) {
    return null;
  }
  const pageId =
    typeof record.pageId === "string" && record.pageId.length <= 256
      ? record.pageId
      : undefined;
  return {
    type,
    width,
    height,
    dpr,
    deviceWidth,
    deviceHeight,
    ...(pageId ? { pageId } : {}),
  };
}

export function parseCdpScreencastServerMessage(
  raw: unknown,
): CdpScreencastServerMessage | null {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > CDP_SCREENCAST_MAX_FRAME_DATA_BYTES + 64 * 1024) {
      return null;
    }
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.type === "ready" || record.type === "viewport") {
    return mapViewportMessage(record, record.type);
  }
  if (record.type === "frame") {
    const frameId = safeInteger(record.frameId);
    const data = typeof record.data === "string" ? record.data : "";
    if (
      frameId === null ||
      frameId <= 0 ||
      data.length === 0 ||
      data.length > CDP_SCREENCAST_MAX_FRAME_DATA_BYTES
    ) {
      return null;
    }
    return {
      type: "frame",
      frameId,
      data,
      metadata:
        record.metadata && typeof record.metadata === "object"
          ? (record.metadata as Record<string, unknown>)
          : {},
    };
  }
  if (record.type === "error") {
    const message =
      typeof record.message === "string" ? record.message.trim().slice(0, 1024) : "";
    if (!message) {
      return null;
    }
    return {
      type: "error",
      message,
      fatal: record.fatal === true,
    };
  }
  return null;
}

export function cdpScreencastModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

export function cdpScreencastMouseButton(button: number): CdpScreencastMouseButton {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
}

export function mapCdpScreencastPoint(params: {
  clientX: number;
  clientY: number;
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">;
  viewport: Pick<CdpScreencastViewport, "width" | "height">;
}): { x: number; y: number } | null {
  if (
    !Number.isFinite(params.clientX) ||
    !Number.isFinite(params.clientY) ||
    params.rect.width <= 0 ||
    params.rect.height <= 0
  ) {
    return null;
  }
  return {
    x: clamp(
      ((params.clientX - params.rect.left) / params.rect.width) * params.viewport.width,
      0,
      params.viewport.width,
    ),
    y: clamp(
      ((params.clientY - params.rect.top) / params.rect.height) * params.viewport.height,
      0,
      params.viewport.height,
    ),
  };
}

export function boundedCdpScreencastText(text: string): string | null {
  if (!text || new TextEncoder().encode(text).byteLength > CDP_SCREENCAST_MAX_TEXT_BYTES) {
    return null;
  }
  return text;
}
