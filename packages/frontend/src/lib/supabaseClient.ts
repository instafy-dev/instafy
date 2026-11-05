import { Capacitor } from "@capacitor/core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  adoptOwnAccountLink,
  dropOtherAccountLinkAfterSignOut,
  holdOtherAccountLink,
} from "../auth/otherAccountLink";
import { resolveSupabaseFlowType } from "../auth/pkce";
import {
  decideWebSessionAddress,
  type OwnAccountLink,
  readStoredSessionUser,
  supabaseAuthStorageKey,
  UNREADABLE_SESSION_STORAGE,
  withoutSessionUrlParameters,
} from "../auth/sessionUrlParameters";
import { isInsideDesktopShell } from "./desktopShell";
import { hasSameOriginAncestor } from "./frameContext";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

if (!hasSupabaseConfig) {
  // eslint-disable-next-line no-console
  console.warn(
    "Supabase environment variables are missing. Local operations will use a no-op client. Add them to your .env file for real calls."
  );
}

const noopFrom = {
  upsert: async () => ({ data: null, error: null }),
  insert: async () => ({ data: null, error: null }),
  select: () => noopFrom,
  eq: () => noopFrom,
  order: () => noopFrom,
  limit: () => noopFrom,
  maybeSingle: async () => ({ data: null, error: null })
};

const noopClient = {
  from: () => noopFrom,
  functions: {
    invoke: async () => ({ data: null, error: { message: "Supabase env not configured" } })
  }
};

function isNativeApp(): boolean {
  try {
    return typeof Capacitor?.isNativePlatform === "function" && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// The storage auth-js keeps the session in, tested the way auth-js tests it,
// or null when the page cannot use it (auth-js then keeps sessions in memory,
// so a token link would reach every tab of this browser).
function usableStorage(): Storage | null {
  try {
    const storage = window.localStorage;
    const probe = "instafy.storage-probe";
    storage.setItem(probe, probe);
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function replaceAddress(cleaned: string | null) {
  if (!cleaned) {
    return;
  }
  try {
    window.history.replaceState(window.history.state, "", cleaned);
  } catch {
    // The client below then reads the address unchanged, as it always did.
  }
}

// No sign-in returns through the page's address in the desktop shell, in the
// mobile apps, or in a frame inside an Instafy page: OAuth comes back through
// instafy://auth there (useNativeGithubAuth, AuthProvider), email links open
// in a browser, and providers refuse to be framed. Yet a link can open the app
// at an address carrying #access_token=... or #error_description=..., or a
// site preview can navigate its own frame to one, and a client reading it
// would replace or end the session. So there the client never reads the
// address, and the session parameters are removed from it before anything
// else sees them.
const addressCarriesNoSignIn =
  typeof window !== "undefined" && (isInsideDesktopShell() || isNativeApp() || hasSameOriginAncestor());

const storage = typeof window === "undefined" ? null : usableStorage();

/** Whether a session set in this page survives a full load: its storage works. */
export const sessionPersistsAcrossLoads = typeof window === "undefined" || storage !== null;

// The web page reads its address only while nobody is signed in, where OAuth
// returns and emailed links land, after deciding what may reach the client
// (decideWebSessionAddress). Signed in, everything the address could carry is
// handled explicitly below, so the client never reads it: not even an address
// that changes while it starts up.
let readsAddress = !addressCarriesNoSignIn;
let deferredExchange: { code: string; verifierKey: string; verifier: string } | null = null;
let ownAccountLink: OwnAccountLink | null = null;
if (typeof window !== "undefined") {
  if (addressCarriesNoSignIn) {
    replaceAddress(withoutSessionUrlParameters(window.location.href));
  } else if (hasSupabaseConfig) {
    const storageKey = supabaseAuthStorageKey(supabaseUrl);
    const verifierKey = storageKey ? `${storageKey}-code-verifier` : null;
    let verifier: string | null = null;
    try {
      verifier = storage && verifierKey ? storage.getItem(verifierKey) : null;
    } catch {
      verifier = null;
    }
    const signedInUser = storage ? readStoredSessionUser(storage, storageKey) : UNREADABLE_SESSION_STORAGE;
    readsAddress = signedInUser === null;
    const decision = decideWebSessionAddress({
      href: window.location.href,
      signedInUser,
      hasCodeVerifier: Boolean(verifier),
    });
    replaceAddress(decision.cleaned);
    if (decision.deferredCode && verifierKey && verifier) {
      deferredExchange = { code: decision.deferredCode, verifierKey, verifier };
    }
    ownAccountLink = decision.ownAccountLink;
    holdOtherAccountLink(decision.otherAccountLink);
  }
}

// PKCE by default; implicit ONLY for a load whose URL already carries a
// legacy hash-token callback. auth-js wipes the stored session when a
// PKCE-configured client meets an implicit-shaped URL, so mid-rollout URLs
// (in-flight sign-ins, recovery emails in inboxes) must be consumed by an
// implicit-mode client for that one load. See src/auth/pkce.ts. A client that
// never reads its address is always PKCE.
const flowType = readsAddress
  ? resolveSupabaseFlowType(typeof window === "undefined" ? null : window.location.hash)
  : "pkce";

export const supabase: SupabaseClient = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        flowType,
        // Always a boolean: auth-js keeps an explicit undefined, which would
        // turn detection off where it is wanted.
        detectSessionInUrl: readsAddress
      }
    })
  : (noopClient as unknown as SupabaseClient);

// An OAuth return that reached a page already signed in: a sign-in this browser
// started, since its verifier is stored. Exchanged explicitly, because a
// failed explicit exchange leaves the current session alone. Starting up can
// remove a dead stored session and the verifier with it, so the verifier read
// before then is put back first.
if (deferredExchange && hasSupabaseConfig) {
  const { code, verifierKey, verifier } = deferredExchange;
  void (async () => {
    await supabase.auth.initialize();
    try {
      if (!window.localStorage.getItem(verifierKey)) {
        window.localStorage.setItem(verifierKey, verifier);
      }
    } catch {
      // The exchange below then reports the missing verifier.
    }
    await supabase.auth.exchangeCodeForSession(code);
  })().catch(() => undefined);
}

// A link for the account signed in here: put in place of the stored session
// once the server confirms it is that account's (adoptOwnAccountLink).
if (ownAccountLink && hasSupabaseConfig) {
  void adoptOwnAccountLink(ownAccountLink, {
    client: supabase,
    supabaseUrl: supabaseUrl!,
    anonKey: supabaseAnonKey!,
  }).catch(() => false);
}

// A link held for another account belongs to the moment it was opened. Once
// the session started with this page ends (signed out here or in another tab,
// or a refresh failed), the link must not greet whoever signs in next, so it
// is dropped; a switch the person started signs out on purpose and keeps it.
// Starting up can also remove a dead session; the link is kept through that,
// since it is then the way back in.
if (typeof window !== "undefined" && hasSupabaseConfig) {
  void supabase.auth
    .initialize()
    .then(() => {
      supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") {
          dropOtherAccountLinkAfterSignOut();
        }
      });
    })
    .catch(() => undefined);
}

if (typeof window !== "undefined" && hasSupabaseConfig) {
  (window as typeof window & { __INSTAFY_SUPABASE__?: SupabaseClient }).__INSTAFY_SUPABASE__ =
    supabase;
}
