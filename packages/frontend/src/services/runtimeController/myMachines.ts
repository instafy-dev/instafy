import { controllerJsonRequest } from "./client";

/**
 * One of the signed-in person's own private machines, in any space: a
 * runtime the controller attested as theirs, or a runtime token they minted
 * for a new machine that has not connected yet (`status` "pending").
 */
export interface MyMachine {
  runtimeId: string;
  projectId: string;
  /** Whether you can still open the space. */
  projectReadable: boolean;
  /** The space's name, while you can still open it and it has one. */
  projectName: string | null;
  displayName: string | null;
  /** Null for a token that has not connected yet. */
  provider: string | null;
  /** The runtime's status, or "pending" for a token that has not connected yet. */
  status: string;
  lastSeenAt: string | null;
  /** When a token that has not connected yet was made. */
  mintedAt: string | null;
  personalBrowser: boolean;
  /**
   * Whether you revoked it and it has not been started again since: its
   * tokens no longer work in its space. A pending token is never revoked;
   * revoking one deletes it.
   */
  revoked: boolean;
  /** When you revoked it, while it is revoked. */
  revokedAt: string | null;
}

export const MY_MACHINE_PENDING_STATUS = "pending";

export type ListMyMachinesResult =
  | { success: true; machines: MyMachine[] }
  | { success: false; machines: []; error: string };

export type RevokeMyMachinesSelection = { runtimeIds: string[] } | { all: true };

export type RevokeMyMachinesResult =
  | { success: true; revoked: string[]; pendingEnded: string[] }
  | { success: false; error: string };

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function mapMyMachine(payload: Record<string, unknown>): MyMachine | null {
  const runtimeId = readString(payload.runtimeId);
  const projectId = readString(payload.projectId);
  const status = readString(payload.status);
  if (!runtimeId || !projectId || !status) {
    return null;
  }
  const projectReadable = payload.projectReadable === true;
  // Only an explicit `true` reads as revoked, so a controller that does not
  // say lists every machine as one that may still work.
  const revoked = payload.revoked === true;
  return {
    runtimeId,
    projectId,
    projectReadable,
    projectName: projectReadable ? readString(payload.projectName) : null,
    displayName: readString(payload.displayName),
    provider: readString(payload.provider),
    status,
    lastSeenAt: readString(payload.lastSeenAt),
    mintedAt: readString(payload.mintedAt),
    personalBrowser: payload.personalBrowser === true,
    revoked,
    revokedAt: revoked ? readString(payload.revokedAt) : null,
  };
}

/** `GET /me/runtimes`: your own machines in every space. */
export async function listMyMachines(params?: { accessToken?: string | null }): Promise<ListMyMachinesResult> {
  const response = await controllerJsonRequest<Record<string, unknown>>({
    path: "/me/runtimes",
    accessToken: params?.accessToken ?? null,
    fallbackError: "Unable to load your machines",
  });
  if (!response.success) {
    return { success: false, machines: [], error: response.error };
  }
  const entries = response.value?.runtimes;
  if (!Array.isArray(entries)) {
    return { success: false, machines: [], error: "Controller response missing machines list." };
  }
  const machines = entries
    .map((entry) => (entry && typeof entry === "object" ? mapMyMachine(entry as Record<string, unknown>) : null))
    .filter((entry): entry is MyMachine => Boolean(entry));
  return { success: true, machines };
}

/**
 * `POST /me/runtimes/revoke`: end the tokens of the machines named, or of all
 * your machines. A machine that was running is stopped. `revoked` and
 * `pendingEnded` list only what this call ended: a machine already revoked is
 * skipped, so both are empty when there was nothing left to revoke.
 */
export async function revokeMyMachines(
  selection: RevokeMyMachinesSelection,
  params?: { accessToken?: string | null },
): Promise<RevokeMyMachinesResult> {
  let body: { all: true } | { runtimeIds: string[] };
  if ("all" in selection) {
    body = { all: true };
  } else {
    const runtimeIds = selection.runtimeIds.map((id) => id.trim()).filter(Boolean);
    if (runtimeIds.length === 0) {
      return { success: false, error: "Choose a machine to revoke." };
    }
    body = { runtimeIds };
  }
  const response = await controllerJsonRequest<Record<string, unknown>>({
    path: "/me/runtimes/revoke",
    method: "POST",
    accessToken: params?.accessToken ?? null,
    body,
    fallbackError: "Unable to revoke the machine",
  });
  if (!response.success) {
    return { success: false, error: response.error };
  }
  return {
    success: true,
    revoked: readIds(response.value?.revoked),
    pendingEnded: readIds(response.value?.pendingEnded),
  };
}
