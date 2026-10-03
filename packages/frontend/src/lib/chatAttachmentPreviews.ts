import { downloadChatAttachment, type ChatAttachmentDownloadResult } from "./chatAttachments";
import { hasSupabaseConfig, supabase } from "./supabaseClient";

// Chat images are downloaded with the person's own session (never a signed
// URL) and shown from object URLs that each image revokes when it goes away.
// This keeps the downloaded bytes for a while, so a message that scrolls back
// into view, a chat opened again or the sender's own new message shows its
// image without fetching it again. Only bytes are kept, never object URLs, and
// everything is dropped when the signed-in person changes, so nobody is shown
// an image their own session was not allowed to read.

/** At most this many downloads run at once; the rest wait their turn. */
export const CHAT_ATTACHMENT_PREVIEW_CONCURRENCY = 4;
const MAX_KEPT_PREVIEWS = 40;
const MAX_KEPT_BYTES = 64 * 1024 * 1024;

// Insertion order is recency: a hit moves its entry to the end.
const kept = new Map<string, Blob>();
let keptBytes = 0;
const inFlight = new Map<string, Promise<ChatAttachmentDownloadResult>>();
// Bumped when the cache is dropped, so a download that started for the
// previous person is never kept for the next one.
let generation = 0;

let activeDownloads = 0;
const waitingDownloads: Array<() => void> = [];

function acquireDownloadSlot(): Promise<void> {
  if (activeDownloads < CHAT_ATTACHMENT_PREVIEW_CONCURRENCY) {
    activeDownloads += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitingDownloads.push(resolve));
}

function releaseDownloadSlot() {
  const next = waitingDownloads.shift();
  if (next) {
    // The slot passes straight to the next download.
    next();
    return;
  }
  activeDownloads = Math.max(0, activeDownloads - 1);
}

function forget(storagePath: string) {
  const blob = kept.get(storagePath);
  if (blob) {
    kept.delete(storagePath);
    keptBytes -= blob.size;
  }
}

function keep(storagePath: string, blob: Blob) {
  forget(storagePath);
  if (blob.size > MAX_KEPT_BYTES) {
    return;
  }
  kept.set(storagePath, blob);
  keptBytes += blob.size;
  for (const oldest of kept.keys()) {
    if (kept.size <= MAX_KEPT_PREVIEWS && keptBytes <= MAX_KEPT_BYTES) {
      break;
    }
    forget(oldest);
  }
}

let watchingAuth = false;
let lastUserId: string | null | undefined;

function watchSignedInPerson() {
  if (watchingAuth || !hasSupabaseConfig) {
    return;
  }
  watchingAuth = true;
  try {
    supabase.auth.onAuthStateChange((_event, session) => {
      const userId = session?.user?.id ?? null;
      if (lastUserId !== undefined && userId !== lastUserId) {
        clearChatAttachmentPreviews();
      }
      lastUserId = userId;
    });
  } catch {
    // A client without auth keeps no per-person state to protect.
  }
}

/** Drops every kept download, and stops in-flight ones from being kept. */
export function clearChatAttachmentPreviews() {
  kept.clear();
  keptBytes = 0;
  inFlight.clear();
  generation += 1;
}

/**
 * Keeps a file this person just uploaded under its Storage name, so their own
 * message shows it from the local copy instead of downloading it again.
 */
export function seedChatAttachmentPreview(storagePath: string, blob: Blob) {
  watchSignedInPerson();
  keep(storagePath, blob);
}

/**
 * The bytes of a chat attachment: a kept copy, the download already running
 * for it, or a new download with the session. A failure is never kept, so the
 * next request tries again.
 */
export function loadChatAttachmentPreview(storagePath: string): Promise<ChatAttachmentDownloadResult> {
  watchSignedInPerson();
  const blob = kept.get(storagePath);
  if (blob) {
    kept.delete(storagePath);
    kept.set(storagePath, blob);
    return Promise.resolve({ ok: true, blob });
  }
  const running = inFlight.get(storagePath);
  if (running) {
    return running;
  }
  const startedIn = generation;
  const download = (async () => {
    await acquireDownloadSlot();
    try {
      return await downloadChatAttachment(storagePath);
    } finally {
      releaseDownloadSlot();
    }
  })().then((result) => {
    if (inFlight.get(storagePath) === download) {
      inFlight.delete(storagePath);
    }
    if (result.ok && startedIn === generation) {
      keep(storagePath, result.blob);
    }
    return result;
  });
  inFlight.set(storagePath, download);
  return download;
}
