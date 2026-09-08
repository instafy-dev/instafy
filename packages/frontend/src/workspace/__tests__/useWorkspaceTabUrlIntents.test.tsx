// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useWorkspaceTabUrlIntents } from "../useWorkspaceTabUrlIntents";

describe("entry-scoped legacy tab intents", () => {
  it("consumes once and discards intents superseded by a different history entry", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const node = document.createElement("div"); const root = createRoot(node);
    let actions!: ReturnType<typeof useWorkspaceTabUrlIntents>;
    function Fixture() {
      actions = useWorkspaceTabUrlIntents({ urlNavigationModeRef: useRef<"push" | "replace" | null>(null) });
      return null;
    }
    try {
      window.history.replaceState({ key: "A", idx: 0 }, "", "/studio");
      await act(async () => root.render(<Fixture />));
      actions.requestUrlPush(); expect(actions.peekUrlNavigation()).toBe("push");
      expect(actions.consumeUrlNavigation()).toBe("push"); expect(actions.consumeUrlNavigation()).toBeNull();
      for (const mode of ["push", "replace"] as const) {
        window.history.replaceState({ key: "A", idx: 0 }, "", "/studio");
        actions.requestUrlNavigation(mode);
        // Same URL, different visit: URL equality must not let an old request survive.
        window.history.pushState({ key: "B", idx: 1 }, "", "/studio");
        expect(actions.peekUrlNavigation()).toBeNull();
        expect(actions.consumeUrlPush()).toBe(false);
      }
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
