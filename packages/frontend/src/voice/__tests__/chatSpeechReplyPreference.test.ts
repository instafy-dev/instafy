import { describe, expect, it } from "vitest";
import {
  getChatWakeWordArmedStorageKey,
  getChatVoiceInteractionModeStorageKey,
  getChatVoiceRepliesEnabledStorageKey,
  hasChatVoiceRepliesEnabledPreference,
  readChatWakeWordArmedPreference,
  readChatVoiceInteractionModePreference,
  readChatVoiceRepliesEnabledPreference,
  writeChatWakeWordArmedPreference,
  writeChatVoiceInteractionModePreference,
  writeChatVoiceRepliesEnabledPreference,
} from "../chatSpeechReplyPreference";

describe("chatSpeechReplyPreference", () => {
  it("scopes the storage key by project when present", () => {
    expect(getChatVoiceRepliesEnabledStorageKey("project-123")).toBe(
      "instafy:chat:voice-replies-enabled:project-123",
    );
    expect(getChatVoiceRepliesEnabledStorageKey(null)).toBe(
      "instafy:chat:voice-replies-enabled",
    );
  });

  it("reads disabled by default", () => {
    expect(
      readChatVoiceRepliesEnabledPreference(
        {
          getItem: () => null,
        },
        "project-123",
      ),
    ).toBe(false);
  });

  it("writes explicit enabled and disabled values", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };

    writeChatVoiceRepliesEnabledPreference(storage, true, "project-123");
    expect(values.get("instafy:chat:voice-replies-enabled:project-123")).toBe("true");
    expect(readChatVoiceRepliesEnabledPreference(storage, "project-123")).toBe(true);
    expect(hasChatVoiceRepliesEnabledPreference(storage, "project-123")).toBe(true);

    writeChatVoiceRepliesEnabledPreference(storage, false, "project-123");
    expect(values.get("instafy:chat:voice-replies-enabled:project-123")).toBe("false");
    expect(readChatVoiceRepliesEnabledPreference(storage, "project-123")).toBe(false);
    expect(hasChatVoiceRepliesEnabledPreference(storage, "project-123")).toBe(true);
  });

  it("stores chat voice interaction mode per project and defaults to hold", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };

    expect(getChatVoiceInteractionModeStorageKey("project-123")).toBe(
      "instafy:chat:voice-interaction-mode:project-123",
    );
    expect(readChatVoiceInteractionModePreference(storage, "project-123")).toBe("hold");

    writeChatVoiceInteractionModePreference(storage, "tap", "project-123");
    expect(values.get("instafy:chat:voice-interaction-mode:project-123")).toBe("tap");
    expect(readChatVoiceInteractionModePreference(storage, "project-123")).toBe("tap");

    writeChatVoiceInteractionModePreference(storage, "continuous", "project-123");
    expect(values.get("instafy:chat:voice-interaction-mode:project-123")).toBe("continuous");
    expect(readChatVoiceInteractionModePreference(storage, "project-123")).toBe("continuous");

    writeChatVoiceInteractionModePreference(storage, "hold", "project-123");
    expect(values.has("instafy:chat:voice-interaction-mode:project-123")).toBe(false);
    expect(readChatVoiceInteractionModePreference(storage, "project-123")).toBe("hold");
  });

  it("stores wake-word arming per project and defaults to disabled", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };

    expect(getChatWakeWordArmedStorageKey("project-123")).toBe(
      "instafy:chat:wake-word-armed:project-123",
    );
    expect(readChatWakeWordArmedPreference(storage, "project-123")).toBe(false);

    writeChatWakeWordArmedPreference(storage, true, "project-123");
    expect(values.get("instafy:chat:wake-word-armed:project-123")).toBe("true");
    expect(readChatWakeWordArmedPreference(storage, "project-123")).toBe(true);

    writeChatWakeWordArmedPreference(storage, false, "project-123");
    expect(values.has("instafy:chat:wake-word-armed:project-123")).toBe(false);
    expect(readChatWakeWordArmedPreference(storage, "project-123")).toBe(false);
  });
});
