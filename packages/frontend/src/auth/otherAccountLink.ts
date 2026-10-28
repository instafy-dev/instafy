import { useSyncExternalStore } from "react";
import type { OtherAccountLink, OwnAccountLink } from "./sessionUrlParameters";

// A link that would sign this browser in as another account, taken out of the
// address before the Supabase client saw it (see decideWebSessionAddress).
// Kept in memory only, so its tokens never reach storage, and gone on reload.
let heldLink: OtherAccountLink | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

export function holdOtherAccountLink(link: OtherAccountLink | null): void {
  heldLink = link;
  notify();
}

export function readOtherAccountLink(): OtherAccountLink | null {
  return heldLink;
}

export function dropOtherAccountLink(): void {
  if (heldLink) {
    heldLink = null;
    notify();
  }
}

// Set while switchToOtherAccountLink runs: it signs the current account out on
// purpose, and the link it is using must survive that.
let switching = false;

/** Called when the session ends: the held link goes, unless a switch to it is under way. */
export function dropOtherAccountLinkAfterSignOut(): void {
  if (!switching) {
    dropOtherAccountLink();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOtherAccountLink(): OtherAccountLink | null {
  return useSyncExternalStore(subscribe, readOtherAccountLink, readOtherAccountLink);
}

type SessionClient = {
  auth: {
    signOut(options: { scope: "local" }): Promise<unknown>;
    setSession(tokens: { access_token: string; refresh_token: string }): Promise<{ error: unknown }>;
  };
};

type LinkServer = {
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
};

type LinkTokenCheck = { kind: "accepted"; userId: string | null } | { kind: "rejected" } | { kind: "unreachable" };

/** Asks the auth server whose a link's access token is, without touching the session. */
async function checkLinkToken(accessToken: string, { supabaseUrl, anonKey, fetchImpl = fetch }: LinkServer): Promise<LinkTokenCheck> {
  try {
    // Resolved like supabase-js does, so a project URL with a path keeps it.
    const base = supabaseUrl.endsWith("/") ? supabaseUrl : `${supabaseUrl}/`;
    const response = await fetchImpl(new URL("auth/v1/user", base).toString(), {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401 || response.status === 403) {
      return { kind: "rejected" };
    }
    if (!response.ok) {
      return { kind: "unreachable" };
    }
    let userId: string | null = null;
    try {
      const body: unknown = await response.json();
      const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
      userId = typeof id === "string" ? id : null;
    } catch {
      userId = null;
    }
    return { kind: "accepted", userId };
  } catch {
    return { kind: "unreachable" };
  }
}

export type OtherAccountSwitch =
  /** Signed in as the link's account. */
  | "switched"
  /** The server refused the link: it expired or was already used. Nothing changed. */
  | "expired"
  /** The server could not be asked. Nothing changed; trying again may work. */
  | "unavailable"
  /** The current account was signed out here, but the link's session could not be set. */
  | "signedOut"
  /** Nobody was signed in, and the link's session could not be set. */
  | "failed";

/**
 * Signs this browser in as the link's account, leaving the current one only
 * once the server has accepted the link: an expired or spent link must not
 * sign anyone out. The current account is signed out on this browser only.
 */
export async function switchToOtherAccountLink(
  link: OtherAccountLink,
  { client, signedIn, ...server }: LinkServer & { client: SessionClient; signedIn: boolean },
): Promise<OtherAccountSwitch> {
  const check = await checkLinkToken(link.accessToken, server);
  if (check.kind === "rejected") {
    return "expired";
  }
  if (check.kind === "unreachable") {
    return "unavailable";
  }
  switching = true;
  try {
    if (signedIn) {
      await client.auth.signOut({ scope: "local" });
    }
    const { error } = await client.auth.setSession({
      access_token: link.accessToken,
      refresh_token: link.refreshToken,
    });
    if (error) {
      if (signedIn) {
        // The session this page started with has ended, so the link goes too.
        dropOtherAccountLink();
        return "signedOut";
      }
      return "failed";
    }
    return "switched";
  } finally {
    switching = false;
  }
}

/**
 * Puts the signed-in account's own link in place of its stored session, once
 * the server confirms the link is that account's. Nothing changes otherwise,
 * so a forged token naming the account cannot sign it out.
 */
export async function adoptOwnAccountLink(
  link: OwnAccountLink,
  { client, ...server }: LinkServer & { client: Pick<SessionClient, "auth"> },
): Promise<boolean> {
  const check = await checkLinkToken(link.accessToken, server);
  if (check.kind !== "accepted" || !check.userId || check.userId.toLowerCase() !== link.userId.toLowerCase()) {
    return false;
  }
  const { error } = await client.auth.setSession({
    access_token: link.accessToken,
    refresh_token: link.refreshToken,
  });
  return !error;
}
