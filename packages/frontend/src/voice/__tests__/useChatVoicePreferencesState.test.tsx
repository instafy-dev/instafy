// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChatVoicePreferencesState } from "../useChatVoicePreferencesState";

type HarnessValue = ReturnType<typeof useChatVoicePreferencesState>;

function Harness(props: {
  projectId?: string | null;
  onValue: (value: HarnessValue) => void;
}) {
  const value = useChatVoicePreferencesState(props.projectId ?? null);
  props.onValue(value);
  return null;
}

describe("useChatVoicePreferencesState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestValue: HarnessValue | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
    window.localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    window.localStorage.clear();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("loads project-scoped chat voice preferences from storage", async () => {
    window.localStorage.setItem("instafy:chat:voice-replies-enabled:project-123", "true");
    window.localStorage.setItem("instafy:chat:voice-interaction-mode:project-123", "continuous");
    window.localStorage.setItem("instafy:chat:wake-word-armed:project-123", "true");

    await act(async () => {
      root.render(
        <Harness
          projectId="project-123"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    expect(latestValue?.voiceRepliesEnabled).toBe(true);
    expect(latestValue?.chatVoiceInteractionMode).toBe("continuous");
    expect(latestValue?.chatWakeWordArmed).toBe(true);
  });

  it("persists project-scoped chat voice preference updates", async () => {
    await act(async () => {
      root.render(
        <Harness
          projectId="project-123"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      latestValue?.setVoiceRepliesEnabled(true);
      latestValue?.setChatVoiceInteractionMode("tap");
      latestValue?.setChatWakeWordArmed(true);
      await Promise.resolve();
    });

    expect(window.localStorage.getItem("instafy:chat:voice-replies-enabled:project-123")).toBe(
      "true",
    );
    expect(window.localStorage.getItem("instafy:chat:voice-interaction-mode:project-123")).toBe(
      "tap",
    );
    expect(window.localStorage.getItem("instafy:chat:wake-word-armed:project-123")).toBe("true");
  });

  it("auto-enables voice replies only when no explicit preference exists", async () => {
    await act(async () => {
      root.render(
        <Harness
          projectId="project-123"
          onValue={(value) => {
            latestValue = value;
          }}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      latestValue?.enableVoiceRepliesIfUnconfigured();
      await Promise.resolve();
    });

    expect(latestValue?.voiceRepliesEnabled).toBe(true);
    expect(window.localStorage.getItem("instafy:chat:voice-replies-enabled:project-123")).toBe(
      "true",
    );

    await act(async () => {
      latestValue?.setVoiceRepliesEnabled(false);
      await Promise.resolve();
    });

    await act(async () => {
      latestValue?.enableVoiceRepliesIfUnconfigured();
      await Promise.resolve();
    });

    expect(latestValue?.voiceRepliesEnabled).toBe(false);
    expect(window.localStorage.getItem("instafy:chat:voice-replies-enabled:project-123")).toBe(
      "false",
    );
  });
});
