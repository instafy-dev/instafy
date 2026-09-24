export type LocalExploreViewport = {
  width: number;
  height: number;
  dpr: number;
};
export type LocalExploreRequest = {
  connectionId: string;
  userId: string;
  viewport: LocalExploreViewport;
};
export type LocalExploreView = LocalExploreRequest & { viewId: string };
export type LocalExploreState = {
  type: "exploreState";
  available: boolean;
  requested: boolean;
  view: LocalExploreView | null;
  requests?: LocalExploreRequest[];
  views?: LocalExploreView[];
};
export type LocalExploreControl = {
  approve(request: LocalExploreRequest): Promise<void>;
  deny(connectionId: string): void;
  close(viewId: string): Promise<void>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function request(value: unknown): value is LocalExploreRequest {
  const v = value as LocalExploreRequest | null;
  return Boolean(
    v &&
      typeof v.connectionId === "string" &&
      typeof v.userId === "string" &&
      v.viewport &&
      Number.isInteger(v.viewport.width) &&
      v.viewport.width >= 240 &&
      v.viewport.width <= 1920 &&
      Number.isInteger(v.viewport.height) &&
      v.viewport.height >= 160 &&
      v.viewport.height <= 1440 &&
      Number.isFinite(v.viewport.dpr) &&
      v.viewport.dpr >= 1 &&
      v.viewport.dpr <= 3,
  );
}
function view(value: unknown): value is LocalExploreView {
  return (
    request(value) &&
    typeof (value as LocalExploreView).viewId === "string" &&
    uuid.test((value as LocalExploreView).viewId)
  );
}
export function readLocalExploreState(
  value: unknown,
): LocalExploreState | null {
  const s = value as LocalExploreState | null;
  return s?.type === "exploreState" &&
    typeof s.available === "boolean" &&
    typeof s.requested === "boolean" &&
    (s.view === null || view(s.view)) &&
    (s.requests === undefined ||
      (Array.isArray(s.requests) &&
        s.requests.length <= 8 &&
        s.requests.every(request))) &&
    (s.views === undefined ||
      (Array.isArray(s.views) && s.views.length <= 4 && s.views.every(view)))
    ? s
    : null;
}
export function localExploreFrame(
  viewId: string,
  jpeg: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (!uuid.test(viewId)) throw new Error("Invalid Explore view.");
  const bytes = new Uint8Array(40 + jpeg.byteLength);
  bytes.set(new TextEncoder().encode("IEX1" + viewId));
  bytes.set(jpeg, 40);
  return bytes;
}
/** Ignore stale mode/generation pixels after Return to follow or a new grant. */
export function readLocalTabFrame(
  bytes: ArrayBuffer,
  viewId: string | null,
): Uint8Array<ArrayBuffer> | null {
  const data = new Uint8Array(bytes);
  if (data[0] === 255 && data[1] === 216) return viewId ? null : data;
  if (
    data.length < 44 ||
    new TextDecoder().decode(data.subarray(0, 4)) !== "IEX1"
  )
    return null;
  if (!viewId || new TextDecoder().decode(data.subarray(4, 40)) !== viewId)
    return null;
  return data.subarray(40);
}
