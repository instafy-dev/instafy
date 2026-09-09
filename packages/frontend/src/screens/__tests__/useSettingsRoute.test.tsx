// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate, useNavigationType, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsRoute } from "../studio/settingsRoute";

describe("URL-driven settings selection", () => {
  let root: Root;
  let container: HTMLDivElement;
  let select: ReturnType<typeof useSettingsRoute>["selectSection"];
  let setFilter: (value: string) => void;
  let navigate: NavigateFunction;
  function Harness() {
    const route = useSettingsRoute("project");
    const location = useLocation();
    navigate = useNavigate();
    const historyAction = useNavigationType();
    const [filter, updateFilter] = useState("");
    select = route.selectSection; setFilter = updateFilter;
    return <div>{JSON.stringify({ tab: route.tab, category: route.category, itemId: route.itemId, filter, key: location.key, historyAction, search: location.search, state: location.state })}</div>;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const state = () => JSON.parse(container.textContent!);

  it("pushes each distinct category once, leaves filters local, and restores defaults with Back/Forward", async () => {
    await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: "/studio", search: "?panel=settings&settingsTab=profile", state: { instafyVisitKey: "old-visit" } }]}><Harness /></MemoryRouter>));
    expect(state().tab).toBe("profile"); expect(state().category).toBe("account");
    const initialKey = state().key;
    await act(async () => select("preferences"));
    expect(state().historyAction).toBe("PUSH");
    expect(state().state).toBeNull();
    const preferencesKey = state().key;
    await act(async () => select("preferences"));
    await act(async () => setFilter("local filter"));
    expect(state().key).toBe(preferencesKey);
    await act(async () => select("account"));
    expect(state().search).not.toContain("settingsCategory");
    await act(async () => navigate(-1));
    expect(state().category).toBe("preferences"); expect(state().key).toBe(preferencesKey);
    await act(async () => navigate(-1));
    expect(state().category).toBe("account"); expect(state().key).toBe(initialKey);
    await act(async () => navigate(1));
    expect(state().category).toBe("preferences");
  });

  it("restores team categories and audio subsections from historical URLs rather than local state", async () => {
    await act(async () => root.render(<MemoryRouter initialEntries={["/studio?panel=settings&settingsTab=org&settingsCategory=billing"]}><Harness /></MemoryRouter>));
    await act(async () => select("members"));
    await act(async () => navigate("/studio?panel=settings&settingsTab=project&settingsCategory=ai&settingsItem=speech"));
    await act(async () => select("ai", "audio"));
    expect(state().itemId).toBe("audio");
    await act(async () => navigate(-1)); expect(state().itemId).toBe("speech");
    await act(async () => navigate(-1)); expect(state().category).toBe("members");
    await act(async () => navigate(-1)); expect(state().category).toBe("billing");
  });

  it("deduplicates consecutive identical presses and chains distinct presses before React renders", async () => {
    await act(async () => root.render(<MemoryRouter initialEntries={["/studio?panel=settings&settingsTab=profile"]}><Harness /></MemoryRouter>));
    const initialKey = state().key;
    await act(async () => { select("preferences"); select("preferences"); select("account"); });
    expect(state().category).toBe("account");
    await act(async () => navigate(-1)); expect(state().category).toBe("preferences");
    await act(async () => navigate(-1)); expect(state().key).toBe(initialKey);
  });
});
