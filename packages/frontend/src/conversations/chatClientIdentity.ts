const CHAT_CLIENT_SESSION_STORAGE_KEY = "instafy.chatClientSessionId";

function createChatClientSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getChatClientSessionId(): string {
  if (typeof window === "undefined") {
    return "server";
  }
  try {
    const existing = window.sessionStorage?.getItem(CHAT_CLIENT_SESSION_STORAGE_KEY);
    if (existing && existing.trim().length > 0) {
      return existing.trim();
    }
    const created = createChatClientSessionId();
    window.sessionStorage?.setItem(CHAT_CLIENT_SESSION_STORAGE_KEY, created);
    return created;
  } catch (_error) {
    return createChatClientSessionId();
  }
}

