import { controllerJsonRequest } from "./client";

/** What `POST /me/sign-out-everywhere` ended. */
export interface SignOutEverywhereSummary {
  /** Every sign-in of yours made at or before this moment's second has ended. */
  signedOutAt: string | null;
  /** Browser, app and CLI logins ended: none of them can refresh again. */
  sessionsEnded: number;
  /** Your machines whose tokens were ended, as Revoke all ends them. */
  machinesRevoked: string[];
  /** Tokens made for new machines that can no longer connect. */
  pendingMintsEnded: string[];
  deviceGrantsRevoked: number;
  previewSessionsRevoked: number;
  /** Browsers and phones that no longer get your notifications. */
  pushRegistrationsRemoved: number;
}

export type SignOutEverywhereResult =
  | { success: true; summary: SignOutEverywhereSummary }
  | { success: false; error: string };

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/**
 * `POST /me/sign-out-everywhere`: end every sign-in of yours, this one too,
 * and revoke your machines, device grants and preview sessions. Once it
 * succeeds, the access token it was called with is refused by the controller.
 */
export async function signOutEverywhere(params?: { accessToken?: string | null }): Promise<SignOutEverywhereResult> {
  const response = await controllerJsonRequest<Record<string, unknown>>({
    path: "/me/sign-out-everywhere",
    method: "POST",
    accessToken: params?.accessToken ?? null,
    body: {},
    fallbackError: "Unable to sign out everywhere",
  });
  if (!response.success) {
    return { success: false, error: response.error };
  }
  const value = response.value ?? {};
  return {
    success: true,
    summary: {
      signedOutAt: typeof value.signedOutAt === "string" ? value.signedOutAt : null,
      sessionsEnded: readCount(value.sessionsEnded),
      machinesRevoked: readIds(value.machinesRevoked),
      pendingMintsEnded: readIds(value.pendingMintsEnded),
      deviceGrantsRevoked: readCount(value.deviceGrantsRevoked),
      previewSessionsRevoked: readCount(value.previewSessionsRevoked),
      pushRegistrationsRemoved: readCount(value.pushRegistrationsRemoved),
    },
  };
}
