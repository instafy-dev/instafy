// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStudioHistory } from "../../../../navigation/useStudioHistory";
import { MobileStudioHistoryControls } from "../MobileStudioHistoryControls";

describe("mobile history across global destinations", () => {
  let root: Root;
  let container: HTMLDivElement;
  let navigate: NavigateFunction;
  function Harness() {
    navigate = useNavigate();
    const location = useLocation();
    const history = useStudioHistory();
    // The history owner survives while route-specific headers are replaced.
    return <header key={location.key}>
      <MobileStudioHistoryControls history={history} />
      <h1>{new URLSearchParams(location.search).get("panel")}</h1>
    </header>;
  }
  const button = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="mobile-header-${id}"]`);
  async function travel(id: "back" | "forward") {
    await act(async () => {
      const popped = new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
      button(id)!.click();
      await popped;
    });
  }
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({ idx: 0, key: "home" }, "", "/studio?panel=home");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it("returns from Home through team and account settings without a menu, then disables Forward on a new destination", async () => {
    expect(button("back")).toBeNull();
    expect(button("open-chats")).toBeNull();
    expect(button("forward")).toBeNull();
    await act(async () => navigate("/studio?panel=team"));
    await act(async () => navigate("/studio?panel=settings&settingsTab=profile"));
    await travel("back");
    expect(container.querySelector("h1")?.textContent).toBe("team");
    expect(button("back")?.nextElementSibling).toBe(button("forward"));
    await travel("back");
    expect(container.querySelector("h1")?.textContent).toBe("home");
    expect(button("back")?.disabled).toBe(true);
    expect(button("forward")?.disabled).toBe(false);
    await travel("forward"); await travel("forward");
    expect(container.querySelector("h1")?.textContent).toBe("settings");
    expect(button("forward")?.disabled).toBe(true);
    await travel("back");
    await act(async () => navigate("/studio?panel=machines"));
    expect(button("forward")?.disabled).toBe(true);
    expect(button("back")?.disabled).toBe(false);
  });
});
