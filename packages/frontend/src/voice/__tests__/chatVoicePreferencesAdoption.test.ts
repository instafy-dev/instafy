import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSourceFile(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("chat voice preferences adoption", () => {
  it("routes chat voice preference persistence through the dedicated hook", () => {
    const chatVoiceControllerSource = readSourceFile(
      "../../screens/studio/components/useChatVoiceComposerController.ts",
    );

    expect(chatVoiceControllerSource).toContain("useChatVoicePreferencesState");
    expect(chatVoiceControllerSource).not.toContain("readChatVoiceRepliesEnabledPreference");
    expect(chatVoiceControllerSource).not.toContain("writeChatVoiceRepliesEnabledPreference");
    expect(chatVoiceControllerSource).not.toContain("readChatVoiceInteractionModePreference");
    expect(chatVoiceControllerSource).not.toContain("writeChatVoiceInteractionModePreference");
    expect(chatVoiceControllerSource).not.toContain("readChatWakeWordArmedPreference");
    expect(chatVoiceControllerSource).not.toContain("writeChatWakeWordArmedPreference");
  });
});
