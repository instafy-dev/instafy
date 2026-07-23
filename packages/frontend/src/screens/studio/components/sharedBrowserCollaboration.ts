export type SharedBrowserCollaborationCursor = {
  x: number;
  y: number;
};

export type SharedBrowserCollaborationParticipant = {
  id: string;
  displayName: string;
  color: string;
  pageId: string | null;
  cursor: SharedBrowserCollaborationCursor | null;
  canControl: boolean;
};

export type SharedBrowserCollaborationControlOwner =
  | { kind: "human"; participantId: string }
  | { kind: "agent"; displayName: string };

export type SharedBrowserCollaborationState = {
  revision: number;
  participants: SharedBrowserCollaborationParticipant[];
  controlOwner: SharedBrowserCollaborationControlOwner | null;
  requests: string[];
};

export type SharedBrowserCollaborationServerMessage =
  | { type: "welcome"; participantId: string }
  | ({ type: "state" } & SharedBrowserCollaborationState);

export type SharedBrowserCollaborationClientMessage =
  | { type: "join"; sessionId: string; pageId: string | null }
  | { type: "heartbeat"; pageId: string | null }
  | ({ type: "cursor"; pageId: string } & SharedBrowserCollaborationCursor)
  | { type: "requestControl" }
  | { type: "takeControl" }
  | { type: "releaseControl" }
  | { type: "grantControl"; participantId: string }
  | { type: "leave" };

export type SharedBrowserCollaborationConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export type SharedBrowserCollaborationClientState = {
  connectionStatus: SharedBrowserCollaborationConnectionStatus;
  participantId: string | null;
  state: SharedBrowserCollaborationState | null;
  error: string | null;
};

export type SharedBrowserCollaborationClientAction =
  | { type: "reset"; status: "idle" | "connecting" }
  | { type: "socket-open" }
  | { type: "server-message"; message: SharedBrowserCollaborationServerMessage }
  | { type: "socket-error"; message: string };

export const INITIAL_SHARED_BROWSER_COLLABORATION_CLIENT_STATE: SharedBrowserCollaborationClientState = {
  connectionStatus: "idle",
  participantId: null,
  state: null,
  error: null,
};

const MAX_SERVER_MESSAGE_BYTES = 64 * 1024;
const MAX_PARTICIPANTS = 32;
const MAX_REQUESTS = 32;
const MAX_PARTICIPANT_ID_BYTES = 64;
const MAX_PAGE_ID_BYTES = 256;
const MAX_DISPLAY_NAME_BYTES = 80;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && utf8ByteLength(normalized) <= maxBytes ? normalized : null;
}

function nullablePageId(value: unknown): string | null | undefined {
  if (value === null || typeof value === "undefined") {
    return null;
  }
  return boundedString(value, MAX_PAGE_ID_BYTES) ?? undefined;
}

function participantColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const color = value.trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

export function normalizeSharedBrowserCollaborationCursor(
  value: unknown,
): SharedBrowserCollaborationCursor | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const x = record.x;
  const y = record.y;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  const bounded = (coordinate: number) =>
    Math.round(Math.min(Math.max(coordinate, 0), 1) * 10_000) / 10_000;
  return { x: bounded(x), y: bounded(y) };
}

function parseServerCursor(value: unknown): SharedBrowserCollaborationCursor | null {
  const record = recordValue(value);
  if (!record || !hasExactKeys(record, ["x", "y"])) {
    return null;
  }
  const { x, y } = record;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    x < 0 ||
    x > 1 ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    y < 0 ||
    y > 1
  ) {
    return null;
  }
  return { x, y };
}

function parseParticipant(value: unknown): SharedBrowserCollaborationParticipant | null {
  const record = recordValue(value);
  if (
    !record ||
    !hasExactKeys(record, ["id", "displayName", "color", "pageId", "cursor", "canControl"])
  ) {
    return null;
  }
  const id = boundedString(record.id, MAX_PARTICIPANT_ID_BYTES);
  const displayName = boundedString(record.displayName, MAX_DISPLAY_NAME_BYTES);
  const color = participantColor(record.color);
  const pageId = nullablePageId(record.pageId);
  if (
    !id ||
    !displayName ||
    !color ||
    typeof pageId === "undefined" ||
    typeof record.canControl !== "boolean"
  ) {
    return null;
  }
  const cursor = record.cursor === null ? null : parseServerCursor(record.cursor);
  if (record.cursor !== null && cursor === null) {
    return null;
  }
  return {
    id,
    displayName,
    color,
    pageId,
    cursor,
    canControl: record.canControl,
  };
}

function parseControlOwner(value: unknown): SharedBrowserCollaborationControlOwner | null | undefined {
  if (value === null) {
    return null;
  }
  const record = recordValue(value);
  if (!record) {
    return undefined;
  }
  if (record.kind === "human") {
    if (!hasExactKeys(record, ["kind", "participantId"])) {
      return undefined;
    }
    const participantId = boundedString(record.participantId, MAX_PARTICIPANT_ID_BYTES);
    return participantId ? { kind: "human", participantId } : undefined;
  }
  if (record.kind === "agent") {
    if (!hasExactKeys(record, ["kind", "displayName"])) {
      return undefined;
    }
    const displayName = boundedString(record.displayName, MAX_DISPLAY_NAME_BYTES);
    return displayName ? { kind: "agent", displayName } : undefined;
  }
  return undefined;
}

export function parseSharedBrowserCollaborationServerMessage(
  raw: unknown,
): SharedBrowserCollaborationServerMessage | null {
  let serialized: string;
  try {
    serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return null;
  }
  if (!serialized || utf8ByteLength(serialized) > MAX_SERVER_MESSAGE_BYTES) {
    return null;
  }
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  if (record.type === "welcome") {
    if (!hasExactKeys(record, ["type", "participantId"])) {
      return null;
    }
    const participantId = boundedString(record.participantId, MAX_PARTICIPANT_ID_BYTES);
    return participantId ? { type: "welcome", participantId } : null;
  }
  if (
    record.type !== "state" ||
    !hasExactKeys(record, ["type", "revision", "participants", "controlOwner", "requests"])
  ) {
    return null;
  }
  const revision = record.revision;
  const controlOwner = parseControlOwner(record.controlOwner);
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Array.isArray(record.participants) ||
    record.participants.length > MAX_PARTICIPANTS ||
    !Array.isArray(record.requests) ||
    record.requests.length > MAX_REQUESTS ||
    typeof controlOwner === "undefined"
  ) {
    return null;
  }
  const participants = record.participants.map(parseParticipant);
  if (participants.some((participant) => participant === null)) {
    return null;
  }
  const parsedParticipants = participants as SharedBrowserCollaborationParticipant[];
  const participantIds = new Set(parsedParticipants.map((participant) => participant.id));
  if (participantIds.size !== parsedParticipants.length) {
    return null;
  }
  const requests: string[] = [];
  const seenRequests = new Set<string>();
  for (const value of record.requests) {
    const participantId = boundedString(value, MAX_PARTICIPANT_ID_BYTES);
    if (!participantId || seenRequests.has(participantId) || !participantIds.has(participantId)) {
      return null;
    }
    seenRequests.add(participantId);
    requests.push(participantId);
  }
  if (
    controlOwner?.kind === "human" &&
    !participantIds.has(controlOwner.participantId)
  ) {
    return null;
  }
  return {
    type: "state",
    revision,
    participants: parsedParticipants,
    controlOwner,
    requests,
  };
}

export function reduceSharedBrowserCollaborationClientState(
  current: SharedBrowserCollaborationClientState,
  action: SharedBrowserCollaborationClientAction,
): SharedBrowserCollaborationClientState {
  if (action.type === "reset") {
    return {
      connectionStatus: action.status,
      participantId: null,
      state: null,
      error: null,
    };
  }
  if (action.type === "socket-open") {
    return { ...current, connectionStatus: "connected", error: null };
  }
  if (action.type === "socket-error") {
    return {
      connectionStatus: "error",
      participantId: null,
      state: null,
      error: action.message,
    };
  }
  if (action.message.type === "welcome") {
    return { ...current, participantId: action.message.participantId, error: null };
  }
  if (current.state && action.message.revision <= current.state.revision) {
    return current;
  }
  return {
    ...current,
    state: {
      revision: action.message.revision,
      participants: action.message.participants,
      controlOwner: action.message.controlOwner,
      requests: action.message.requests,
    },
    error: null,
  };
}

export function collaborationSelfParticipant(
  client: SharedBrowserCollaborationClientState,
): SharedBrowserCollaborationParticipant | null {
  if (!client.participantId || !client.state) {
    return null;
  }
  return client.state.participants.find((participant) => participant.id === client.participantId) ?? null;
}

export function collaborationSelfOwnsControl(
  client: SharedBrowserCollaborationClientState,
): boolean {
  return Boolean(
    client.participantId &&
      client.state?.controlOwner?.kind === "human" &&
      client.state.controlOwner.participantId === client.participantId,
  );
}

export function createSharedBrowserCollaborationJoinMessage(
  sessionId: string,
  pageId: string | null,
): SharedBrowserCollaborationClientMessage {
  return { type: "join", sessionId: sessionId.trim(), pageId };
}

export function createSharedBrowserCollaborationHeartbeatMessage(
  pageId: string | null,
): SharedBrowserCollaborationClientMessage {
  return { type: "heartbeat", pageId };
}

export function createSharedBrowserCollaborationCursorMessage(
  pageId: string,
  cursor: SharedBrowserCollaborationCursor,
): SharedBrowserCollaborationClientMessage {
  return { type: "cursor", pageId, ...cursor };
}
