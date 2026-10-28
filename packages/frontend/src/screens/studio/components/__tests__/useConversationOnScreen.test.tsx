// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isConversationOpen, resetOpenConversationsForTests } from "../../../../notifications/openConversations";
import { useConversationOnScreen } from "../useConversationOnScreen";

const CONVERSATION = "3f0c8a7e-1d2b-4c5d-8e9f-0a1b2c3d4e5f";

describe("useConversationOnScreen", () => {
  let root: Root;
  let container: HTMLDivElement;

  function Harness(view: { chatVisible: boolean; browserVisible: boolean; jobThread: boolean }) {
    useConversationOnScreen(CONVERSATION, view);
    return null;
  }

  const show = (view: { chatVisible: boolean; browserVisible: boolean; jobThread?: boolean }) =>
    act(async () => {
      root.render(<Harness jobThread={false} {...view} />);
    });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetOpenConversationsForTests();
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resetOpenConversationsForTests();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // A local test: "There is a new reply in your conversation. [View]" showed
  // while the person watched that chat's own Browser view.
  it("counts the conversation as open while its Browser view is in front", async () => {
    await show({ chatVisible: false, browserVisible: true });
    expect(isConversationOpen(CONVERSATION)).toBe(true);
  });

  it("counts it while Chat shows, and not while a file or a preview is in front", async () => {
    await show({ chatVisible: true, browserVisible: false });
    expect(isConversationOpen(CONVERSATION)).toBe(true);
    await show({ chatVisible: false, browserVisible: false });
    expect(isConversationOpen(CONVERSATION)).toBe(false);
  });

  it("never counts a job thread's tab as the conversation", async () => {
    await show({ chatVisible: true, browserVisible: true, jobThread: true });
    expect(isConversationOpen(CONVERSATION)).toBe(false);
  });
});
